# Web Push — setup & deploy

Internal staff alerts via Web Push. Works on Supabase **free tier** and GitHub Pages.

## Keys (already wired where they belong)

| Key | Value | Where it lives |
|-----|-------|----------------|
| VAPID **public** | `BFyZTv3Cc5p6EKOG-68__FVzZHzApu09UxQrrrLR6vDB7srZFgUNYSwKHPk-QULfN-TIN22xKLWQ3G2QKdvqqks` | **In client** — `VAPID_PUBLIC_KEY` in `app.js` (safe to expose) |
| VAPID **private** | `iqlbFv6c2wUexAumggMNzNmoXTfmTZriBJNjDQ-YC9E` | **Supabase secret only** — never in client |
| CRON_SECRET | `a36c8fe130cee1b1f8c1f5ee605e6da18d831404c635182c` | Supabase secret + the cron job header |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into Edge Functions automatically — do not set them.

---

## 1. Table (already created)

The `push_subscriptions` table + per-user RLS is already applied. For reference:

```sql
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create policy "push_select_own" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "push_insert_own" on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
create policy "push_update_own" on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "push_delete_own" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());
```

---

## 2. Set the secrets

Dashboard → **Project Settings → Edge Functions → Secrets** (or CLI):

```bash
supabase link --project-ref hjlibhrxyfipsajcywzj

supabase secrets set \
  VAPID_PUBLIC_KEY="BFyZTv3Cc5p6EKOG-68__FVzZHzApu09UxQrrrLR6vDB7srZFgUNYSwKHPk-QULfN-TIN22xKLWQ3G2QKdvqqks" \
  VAPID_PRIVATE_KEY="iqlbFv6c2wUexAumggMNzNmoXTfmTZriBJNjDQ-YC9E" \
  VAPID_SUBJECT="mailto:cristolintan@gmail.com" \
  CRON_SECRET="a36c8fe130cee1b1f8c1f5ee605e6da18d831404c635182c"
```

---

## 3. Deploy the functions ✅ DONE (deployed via MCP)

Both functions are already deployed and ACTIVE:
- `send-push` (verify_jwt = true)
- `overdue-check` (verify_jwt = false)

To redeploy later from your machine:

```bash
supabase functions deploy send-push                  # JWT-verified (called by staff)
supabase functions deploy overdue-check --no-verify-jwt   # cron-only, secret-guarded
```

(`supabase/config.toml` already encodes these verify_jwt settings if you deploy from it.)

Quick test of send-push (replace TOKEN with a logged-in user's access token, or use the
dashboard "Invoke" panel):

```bash
curl -i -X POST "https://hjlibhrxyfipsajcywzj.supabase.co/functions/v1/send-push" \
  -H "Authorization: Bearer <USER_JWT>" -H "Content-Type: application/json" \
  -d '{"title":"Test","body":"Hello staff","url":"./","target":"all_staff"}'
```

---

## 4. Schedule the daily overdue check ✅ DONE (scheduled via MCP)

`pg_cron` + `pg_net` are enabled and the job `daily-overdue-check` is active
(runs 01:00 UTC = 09:00 Asia/Manila). It already carries the CRON_SECRET below.
For reference, this is what was run:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 01:00 UTC = 09:00 Asia/Manila (morning check)
select cron.schedule(
  'daily-overdue-check',
  '0 1 * * *',
  $$
  select net.http_post(
    url     := 'https://hjlibhrxyfipsajcywzj.supabase.co/functions/v1/overdue-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'a36c8fe130cee1b1f8c1f5ee605e6da18d831404c635182c'
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

To change the time, edit the cron expression (UTC). To remove it:
`select cron.unschedule('daily-overdue-check');`

---

## 5. Redeploy the static site

Push to the branch GitHub Pages serves so the new `sw.js` (cache **v14**, with push
handlers) and `app.js` go live. Staff then open the app → **Home → "Enable alerts on this
device"**.

### iOS note
On iPhone, Web Push only works when the app is **installed to the Home Screen**
(Safari → Share → Add to Home Screen, iOS 16.4+). The Home tab detects this and shows a
hint instead of a broken button until it's installed.
