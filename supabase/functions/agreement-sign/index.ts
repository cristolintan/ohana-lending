// agreement-sign — public endpoint behind the "Send to sign" email link.
//
// POST { action: "get",  token }                                 → what the signer sees
// POST { action: "sign", token, signature, typedName, consent }  → records the signature, once
//
// verify_jwt is off: the signer has no account. The 256-bit link token is the
// credential. Only its SHA-256 is stored, the table is closed to anonymous
// clients, and every check below runs here with the service role. The app can
// create and cancel requests, but only this function can mark one signed.
//
// Expected outcomes (invalid / expired / cancelled / removed / already signed)
// come back as 200 { ok: false, code, message } so the page can show them as-is.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { sendToSubs, type SubRow } from "../_shared/push.ts";

const MAX_SIGNATURE = 400_000; // characters of the PNG data URL
const PNG_PREFIX = "data:image/png;base64,";

const fail = (code: string, message: string) => json({ ok: false, code, message });

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const { action, token } = body ?? {};
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return fail("invalid", "This signing link isn't valid. Please check you opened the full link from the email.");
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: r, error } = await admin
      .from("signing_requests")
      .select("id,user_id,loan_id,role,signer_name,snapshot,status,expires_at,opened_at,signed_at,signature,typed_name")
      .eq("token_hash", await sha256Hex(token))
      .maybeSingle();
    if (error) throw error;
    if (!r) return fail("invalid", "This signing link isn't valid. Please check you opened the full link from the email.");

    const lender = r.snapshot?.agreement?.lenderName || "the lender";
    if (r.status === "cancelled") return fail("cancelled", `This link was cancelled. Please ask ${lender} for a new one.`);
    if (r.status === "revoked") return fail("revoked", `Your signature on this agreement was removed by ${lender}. Please ask them for a new link.`);
    const expired = r.status === "sent" && new Date(r.expires_at).getTime() < Date.now();
    if (expired) return fail("expired", `This link has expired. Please ask ${lender} to send a new one.`);

    if (action === "get") {
      if (r.status === "sent" && !r.opened_at) {
        await admin.from("signing_requests").update({ opened_at: new Date().toISOString() })
          .eq("id", r.id).is("opened_at", null);
      }
      return json({
        ok: true,
        role: r.role,
        signerName: r.signer_name,
        status: r.status,
        expiresAt: r.expires_at,
        snapshot: r.snapshot,
        signedAt: r.signed_at,
        signature: r.status === "signed" ? r.signature : null,
        typedName: r.status === "signed" ? r.typed_name : null,
      });
    }

    if (action === "sign") {
      if (r.status === "signed") return fail("signed", "This agreement has already been signed.");
      const { signature, typedName, consent } = body;
      if (typeof signature !== "string" || !signature.startsWith(PNG_PREFIX) ||
          signature.length > MAX_SIGNATURE || !/^[A-Za-z0-9+/]+=*$/.test(signature.slice(PNG_PREFIX.length))) {
        return fail("bad_signature", "Please draw your signature again.");
      }
      const name = typeof typedName === "string" ? typedName.trim().replace(/\s+/g, " ") : "";
      if (name.length < 2 || name.length > 120) return fail("bad_name", "Please type your full name.");
      if (consent !== true) return fail("no_consent", "Please tick the box to confirm you agree.");

      const now = new Date().toISOString();
      const { data: updated, error: upErr } = await admin
        .from("signing_requests")
        .update({
          status: "signed",
          signed_at: now,
          opened_at: r.opened_at || now,
          signature,
          typed_name: name,
          signer_ip: (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null,
          signer_agent: (req.headers.get("user-agent") || "").slice(0, 400) || null,
        })
        .eq("id", r.id)
        .eq("status", "sent") // a second tap can't overwrite the first signature
        .select("id");
      if (upErr) throw upErr;
      if (!updated?.length) return fail("signed", "This agreement has already been signed.");

      // Tell the lender — best effort; the signature is already safely stored.
      try {
        const { data: subs } = await admin.from("push_subscriptions")
          .select("endpoint,p256dh,auth,user_id").eq("user_id", r.user_id);
        if (subs?.length) {
          const ref = r.snapshot?.loan?.ref || "Loan";
          const roleLabel = r.role === "guarantor" ? "guarantor" : "borrower";
          await sendToSubs(admin, subs as SubRow[], {
            title: `${ref} · agreement signed`,
            body: `${r.signer_name} signed the loan agreement as ${roleLabel}.`,
            url: `./?loan=${encodeURIComponent(ref)}`,
            tag: `sign-${r.id}`,
          });
        }
      } catch (e) {
        console.error("push failed", e);
      }
      return json({ ok: true, signedAt: now });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, code: "server", message: "Something went wrong. Please try again in a moment." }, 500);
  }
});
