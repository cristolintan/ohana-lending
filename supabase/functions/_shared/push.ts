// Web Push sending helper. This is the ONLY place that uses the VAPID private
// key (web-push). The key never leaves the Edge Function runtime.
import webpush from "npm:web-push@3.6.7";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

let configured = false;
function ensureVapid() {
  if (configured) return;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT") || "mailto:cristolintan@gmail.com";
  if (!pub || !priv) throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set");
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
}

export interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id?: string;
}

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  icon?: string;
  tag?: string;
  requireInteraction?: boolean;
}

// Sends one payload to many subscriptions. Subscriptions that the push service
// reports as gone (404/410) are deleted so the table self-prunes.
export async function sendToSubs(
  admin: SupabaseClient,
  subs: SubRow[],
  payload: PushPayload,
): Promise<{ sent: number; removed: number }> {
  ensureVapid();
  const body = JSON.stringify(payload);
  const expired: string[] = [];

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
      } catch (err) {
        const code = (err as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) {
          expired.push(s.endpoint);
        } else {
          console.error("push send error", code, (err as Error)?.message);
        }
      }
    }),
  );

  if (expired.length) {
    await admin.from("push_subscriptions").delete().in("endpoint", expired);
  }
  return { sent: subs.length - expired.length, removed: expired.length };
}
