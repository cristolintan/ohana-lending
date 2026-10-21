# Remote signing ("Send to sign") — setup & how it works

The loan agreement's Borrower / Guarantor signature can be signed on the person's
own phone from a private link. The lender sends it from their own email app
(mailto), or shares it (Messenger / Viber / SMS) — no email service needed.

## Flow

1. **Agreement → Signatures → "✉ Send to sign by email"** (needs the Borrower /
   Guarantor Email filled in). The app saves the agreement, makes a random 32-byte
   token in the browser and inserts a `signing_requests` row holding only the
   token's **SHA-256**, a snapshot of the agreement, and a fingerprint (`doc_hash`)
   of its text. The link is `…/?sign=<token>`; it expires after 14 days.
2. The signer opens the link → `app.js` mounts `SignPage` (no login) → the
   `agreement-sign` function returns the snapshot → they draw, type their name,
   tick consent → **Sign**.
3. The function records signature, typed name, time, IP and device, marks the
   row `signed` (once), and push-notifies the lender. The app shows the remote
   signature on the agreement and in the printed copy/PDF.

"Send again" cancels the previous link. If the agreement text changes after
sending (or after signing), the app warns and offers to send again.

## Table (applied live via SQL — this repo has no migrations folder)

```sql
create table public.signing_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  loan_id uuid not null references public.loans(id) on delete cascade,
  role text not null check (role in ('borrower', 'guarantor')),
  signer_name text not null check (length(signer_name) between 1 and 200),
  signer_email text not null check (length(signer_email) between 3 and 320),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb not null,
  doc_hash text not null,
  status text not null default 'sent' check (status in ('sent', 'signed', 'cancelled')),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  opened_at timestamptz,
  signed_at timestamptz,
  signature text,
  typed_name text,
  signer_ip text,
  signer_agent text
);
create index signing_requests_loan_id_idx on public.signing_requests (loan_id);
create index signing_requests_user_id_idx on public.signing_requests (user_id);
alter table public.signing_requests enable row level security;

-- Owner (approved, owns the loan) or admin — same shape as the other tables.
create policy signing_select on public.signing_requests for select to authenticated
  using ((select public.is_admin()) or ((select public.is_approved()) and user_id = (select auth.uid())
    and exists (select 1 from public.loans l where l.id = signing_requests.loan_id and l.user_id = (select auth.uid()))));

-- The app may only create a fresh, unsigned request.
create policy signing_insert on public.signing_requests for insert to authenticated
  with check (((select public.is_admin()) or ((select public.is_approved()) and user_id = (select auth.uid())
    and exists (select 1 from public.loans l where l.id = signing_requests.loan_id and l.user_id = (select auth.uid()))))
    and status = 'sent' and signature is null and signed_at is null and typed_name is null
    and opened_at is null and signer_ip is null and signer_agent is null
    and expires_at <= now() + interval '15 days');

-- The app may only cancel a pending request (column grant limits updates to `status`).
create policy signing_cancel on public.signing_requests for update to authenticated
  using (status = 'sent' and ((select public.is_admin()) or ((select public.is_approved()) and user_id = (select auth.uid())
    and exists (select 1 from public.loans l where l.id = signing_requests.loan_id and l.user_id = (select auth.uid())))))
  with check (status = 'cancelled');

revoke all on public.signing_requests from anon;
revoke update, delete, truncate, references, trigger on public.signing_requests from authenticated;
grant update (status) on public.signing_requests to authenticated;
```

Only the `agreement-sign` function (service role) can set `signed` or write the
signature/evidence columns. No client can delete a request; deleting the loan
removes its requests (cascade).

### Update: "Remove" a remote signature (status `revoked`)

The lender can take a remote signature off the agreement. The row — signature,
typed name, time, IP, device — is kept as a record; it just stops being used.
A trigger allows only these status changes, for every role including the
service role: `sent → signed | cancelled`, `signed → revoked`.

```sql
alter table public.signing_requests drop constraint signing_requests_status_check;
alter table public.signing_requests add constraint signing_requests_status_check
  check (status in ('sent', 'signed', 'cancelled', 'revoked'));
alter table public.signing_requests add column revoked_at timestamptz;

create or replace function public.signing_requests_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'sent' and new.status in ('signed', 'cancelled'))
    or (old.status = 'signed' and new.status = 'revoked')) then
    raise exception 'signing request cannot go from % to %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  -- revoked_at is stamped here, never taken from the client
  new.revoked_at := case when new.status = 'revoked' and old.status = 'signed' then now() else old.revoked_at end;
  return new;
end $$;
create trigger signing_requests_guard before update on public.signing_requests
  for each row execute function public.signing_requests_guard();

-- The app may cancel a pending link or remove (revoke) a signed one — nothing else.
drop policy signing_cancel on public.signing_requests;
create policy signing_update on public.signing_requests for update to authenticated
  using (status in ('sent', 'signed') and ((select public.is_admin()) or ((select public.is_approved()) and user_id = (select auth.uid())
    and exists (select 1 from public.loans l where l.id = signing_requests.loan_id and l.user_id = (select auth.uid())))))
  with check (status in ('cancelled', 'revoked'));
```

Opening a link whose signature was removed returns code `revoked`.

## Function

`agreement-sign` — deployed with **verify_jwt = false** (see `config.toml`): the
signer has no account; the token is the credential and is checked inside the
function. It reuses `_shared/cors.ts` and `_shared/push.ts` (needs the same VAPID
secrets as `send-push`; no new secrets).

POST `{ action: "get", token }` · POST `{ action: "sign", token, signature, typedName, consent }`.
Expected outcomes return `200 { ok: false, code, message }` with codes
`invalid | expired | cancelled | revoked | signed | bad_signature | bad_name | no_consent`.

## Notes

- Remote e-signing doesn't replace the notary section — notarization still needs
  personal appearance.
- Anyone holding a link can read that agreement until it expires (it shows
  addresses and ID numbers). Only send it to the person's own email; use
  "Cancel link" if it went to the wrong address.
