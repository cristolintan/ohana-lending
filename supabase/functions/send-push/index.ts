// send-push — the single entry point for delivering an internal staff alert.
//
// POST body: { title, body?, url?, target?, exclude?, icon?, tag? }
//   target:  a specific user_id, or "all_staff" (default) → everyone subscribed.
//   exclude: optional user_id to skip (e.g. the staff member who triggered it).
//
// Called by:
//   • the PWA (logged-in staff)            → JWT verified by the platform.
//   • the overdue-check function (cron)    → sends a service-role bearer token.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { sendToSubs, type SubRow } from "../_shared/push.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { title, body, url, target, exclude, icon, tag } = await req.json();
    if (!title) return json({ error: "title is required" }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Read subscriptions with the service role (RLS would otherwise hide other
    // users' rows). Scope to one user when target is a specific user_id.
    let query = admin
      .from("push_subscriptions")
      .select("endpoint,p256dh,auth,user_id");
    if (target && target !== "all_staff") query = query.eq("user_id", target);

    const { data, error } = await query;
    if (error) throw error;

    let subs = (data || []) as SubRow[];
    if (exclude) subs = subs.filter((s) => s.user_id !== exclude);
    if (!subs.length) return json({ sent: 0, removed: 0, note: "no matching subscriptions" });

    const result = await sendToSubs(admin, subs, {
      title,
      body: body || "",
      url: url || "./",
      icon,
      tag,
    });
    return json(result);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
