# OL-0001 (Christian Bondoc) shows PARTIAL while unpaid + intermittent payment bug

- [x] Pull loan + payments for OL-0001 from Supabase
- [x] Reproduce schedule with committed engine vs working tree
- [x] Fix centavo rounding in schedule status (working-tree change reviewed, dead `baseRemP` removed)
- [x] Fix duplicate-ref loan resolution (admin sees several users' OL-0001)
- [x] Syntax check + fuzz schedules

## Review

- **Summary:** Installment 3 of OL-0001 showed PARTIAL because the committed engine kept interest unrounded
  (3,810.0067 due vs 3,810.01 paid); the 0.0033 overpayment spilled onto row 3. Working-tree change rounds every
  installment to the centavo and compares in integer centavos → row 3 now UNPAID ₱3,576.66.
  Separately, refs are unique only per user (9 refs duplicated in the DB); `resolved` took the first ref match,
  so an admin could open / post a payment to the wrong borrower. Now resolves by id; shared typed refs show a choice list.
- **Files changed:** app.js, sw.js (v24)
- **Tests run:** node replay of OL-0001 (old vs new); fuzz of 3,000 random loans paying the displayed amount each
  installment — old: 45,078 failures, new: 0. esbuild JSX parse: OK.
- **Known risks:** Rounded interest may move a loan's total by ≤ ₱0.01 vs. old printed agreements.
  OL-0001 payments are dated 2026-08-29, one day before the loan start (start-date guard is commented out).
- **Follow-up:** Deploy (commit + push); verify in app as the admin account.

# Separate Release Date from Start Date on loan creation

- [x] DB: `alter table public.loans add column release_date date` (nullable; null = released on start_date)
- [x] Map/insert/update `release_date` ↔ `releaseDate` (fallback to start date for older loans and snapshots)
- [x] New Loan form: Release Date + Start Date (1st payment) side by side; start can't precede release
- [x] Saved schedule image: Release date = releaseDate, plus Start date
- [x] Cash flow "Loan released" entry dated by releaseDate
- [x] sw.js → v25

## Review

- **Summary:** Start Date keeps meaning first payment due (schedule, due dates, overdue-check unchanged).
  Release Date is new and drives the image header and cash-flow disbursement date.
- **Files changed:** app.js, sw.js; DB column `loans.release_date` (applied live via SQL; no migrations folder in repo).
- **Tests run:** esbuild JSX parse OK; schedule fuzz still 0 failures.
- **Known risks:** Not clicked through in a browser. Existing loans show release = start date until edited.
- **Follow-up:** Commit + push; on the phone tap Update, create a test loan, Save image, check Cash Flow.

# Cash flow by Release Date

- [x] Audit: the only loan date in cash flow is the "Disbursement" row (app.js `disb`), already on `releaseDate`;
  period totals, ledger, charts and running balance all derive from it. No other cash-flow code reads `startDate`.
- [x] Backfill (user chose "Same as Start Date"): `update loans set release_date = start_date where release_date is null` → 28/28 filled.
- **Follow-up:** Edit loans whose money actually went out on a different day; cash flow moves the release to that date.

# Cash Flow: co-op Members' share table

- [x] DB: `settings.members jsonb not null default '[]'` + check `jsonb_typeof = 'array'` (existing own_settings RLS covers it)
- [x] api.fetchAll maps `members`; api.setMembers upserts only that column (opening balance untouched)
- [x] `splitCents` / `memberShares` pure helpers: pool = cash on hand + outstanding principal (no future interest),
      split by capital share to the centavo (largest remainder, rows always sum to the total)
- [x] Cash Flow card "Members' share" (full width, as at today): Co-op value / Capital / Gain tiles, cash-vs-principal
      bar, table (Member · Capital · Cash · Principal · Value today · Gain ₱/%), total row, notes
      (interest collected, withdrawn, capital-mismatch warning), share/copy text for group chat
- [x] Members editor sheet (prefilled 8 × ₱30,000 on first setup; name/capital, add/remove, validation)
- [x] sw.js → v26

## Review

- **Tests run:** esbuild JSX parse OK; `memberShares` example 8 × 30k on ₱360k → ₱45,000 each (+₱15,000, +50%);
  20,000 random splits → member rows always sum exactly to totals; equal capital → ≤ 1 centavo apart.
  Real data: c4444d87 book → ₱197,297.67 (= 240k + 18k added + 11,376 interest − 72,078.33 withdrawn), −17.8%.
- **Known risks:** Not clicked through in a browser. Admin's Cash Flow mixes every user's loans/entries with only the
  admin's own opening balance (cash shows −₱132,757), so the members card is only meaningful on the co-op's own book.
  Withdrawals reduce everyone's value; if a withdrawal was a capital return, members' capital should be lowered.
- **Follow-up:** Decide which account is the co-op book; commit + push; set up members on that account.

# Bug: can't type member names

- **Cause:** member row was a flex row; `inputCls` carries `w-full`, which outranks the added `w-28` in Tailwind's
  output, so the `shrink-0` capital box took the full width and the name box collapsed to 30px (its padding).
  No settings writes ever reached the API (edge logs: GETs only).
- **Fix:** editor header + rows use `grid-cols-[minmax(0,1fr)_7rem_2.25rem]`; also tightened mobile table padding.
- **Verified (headless Chrome, 360px):** name box 30px → 156px, capital 320px → 112px; members table 344px → 326px
  (fits a 360px phone; a 320px phone scrolls inside the card). esbuild parse OK. sw.js → v27.

# Payments: "Pass" option

Pass = borrower pays nothing this period. Like Minimum Due, the principal is deferred one period (schedule gains one
row), but the passed period's interest is not collected — it is added to the next installment.

- [x] DB: payments amount check → `amount > 0 or (type = 'Pass' and amount = 0)`
- [x] Engine (app.js): Pass creates a deferral row (principal 0, interest 0, status PASSED); its interest carries
      into the next non-pass row (`carried`); settle statuses in one shared centavo pass (`settleRows`)
- [x] Revision wrapper keeps isPass/carried; explicit-term re-price keeps carried interest
- [x] UI: Type select gets Pass (amount locked to 0, explainer), schedule row "n (Pass)", "incl. ₱x passed",
      PASSED badge, history shows Pass, notification text, cash flow ignores ₱0 passes
- [x] Overdue count uses amtLeft (PASSED must not count as overdue)
- [x] Server port (_shared/schedule.ts): same engine incl. centavo fix + Pass; deploy overdue-check (ask first)
- [x] Tests: engine replay + fuzz; esbuild parse; sw bump
- [x] Also: payments sort by date then created_at (`byPaidOrder`) — same-day order used to be arbitrary, which
      could put a Pass/Minimum Due on the wrong installment; last-payment date and collections ignore ₱0 passes

## Review

- **Summary:** Pass = ₱0 payment row of type "Pass". Engine adds a deferral row (PASSED, owes nothing); that period's
  interest is added to the next installment ("incl. ₱x passed"). Sheet shows a live preview (interest moved, new next
  payment) computed by the engine and blocks a pass on a part-paid or misaligned installment.
- **Files changed:** app.js, sw.js (v28), supabase/functions/_shared/schedule.ts, supabase/functions/overdue-check/index.ts;
  DB constraint `payments_amount_check` (applied live).
- **Tests run:** no-Pass regression vs previous engine: 4,000 loans, 0 differences. App vs server port parity: 6,000 loans
  (3,058 with passes, payments shuffled): 0 differences. Pass fuzz: 3,000 loans / 6,637 passes paid off exactly, every
  pass on the due installment, carried = passed interest, no false PARTIAL; interest drift vs base ≤ ₱0.03.
  Centavo fuzz still 0 failures. esbuild parse (app + edge bundle) OK.
- **Known risks:** Not clicked through in a browser. Placement is by payment order (same as Minimum Due) — the sheet
  refuses a pass it can't place. overdue-check must be redeployed or the server treats a Pass as ₱0 Standard and
  sends an overdue alert for the passed installment. → DEPLOYED (user approved): overdue-check v9, verify_jwt=false (unchanged), same file layout; not invoked manually (would send real pushes).

# Bug: black screen after logging a Pass (Cielo, OL-0002)

- **Cause:** Lucide's `createIcons()` replaced every `<i data-lucide>` React rendered with an `<svg>`. The "Next payment
  due" card renders `{late && <i data-lucide="alert-triangle">}`; clearing the last overdue installment (a Pass *or* a
  normal payment) made React remove that `<i>` → `NotFoundError: removeChild` → React unmounted the app (black in
  dark mode). Reload drew it fresh, so it looked fine. Same class of crash on insertBefore next to any icon.
- **Fix:** `paintIcons()` paints each svg *inside* the React-owned `<i>` (placeholder + `createIcons({nameAttr})`),
  repaints only when name/class/style change; `i[data-lucide]{display:contents}` in index.html. sw.js → v29.
- **Verified (headless Chrome, real app.js + stub Supabase with Cielo's data):**
  before fix — Pass: blank + removeChild error; Standard ₱3,190 on the overdue installment: blank + same error.
  after fix — Pass: alive, next payment ₱3,880.00 (₱3,190 + ₱690 passed) due Sep 30; Standard: alive, next ₱3,090.00.
  All 5 tabs: every icon painted, no stray markers, no errors; icon geometry/colour identical to before in 5 layouts;
  active-tab stroke now updates. esbuild parse OK.

# Payments: Share status with borrower

- [x] Share button in "Schedule & Status" header (icon-only on phones, "Share" on sm+; also on fully paid loans)
- [x] Off-screen `#status-export-doc` (640px): borrower, ref, as-of date, release date; Total to pay / Paid so far /
      Balance; next or overdue payment callout (or "Fully paid — thank you!"); table No./Due date/Amount due/Paid/
      Left/Status (Paid, Part-paid, Unpaid, Overdue, Passed, incl. passed interest); payments received list
- [x] `captureToShare()` shared by schedule + status export; preview sheet title/subtitle come from the capture
- [x] index.html pins #status-export-doc to light paper colours in dark mode; sw.js → v30

## Review

- **Verified (headless Chrome, real app.js + stub Supabase, Cielo OL-0002):** Share → preview sheet "Status image
  ready / Cielo · OL-0002", image 1280×1752, no errors. Visually checked: with Pass (total ₱18,930, passed row,
  next ₱3,880 Sep 30) and without (installment 2 red "Overdue", ₱3,190). Dark and light mode render identical
  paper. Payments header at 360px: no overflow, title not truncated. esbuild parse OK.
- **Known risks:** Not tried on a physical iPhone share sheet (same share path as the existing schedule image).

# Payments: "Waived Interest" option

- [x] Engine: payment type "Waived Interest" settles its installment on principal only; the row's interest (incl.
      any passed onto it) becomes `waived`, total interest drops by that amount. Defers nothing, adds no row.
- [x] Revision wrapper carries isWaived/waived; explicit re-price doesn't resurrect carried interest on a waived row
- [x] Sheet: option + help text, amount prefilled with the principal, preview (principal, interest waived, short /
      extra), same placement guard as Pass (part-paid / misaligned refused); toast + notification mention the waiver
- [x] Schedule table: "~~₱690.00~~ waived"; status image: "₱690.00 interest waived"
- [x] Server port mirrors it; sw.js → v31

## Review

- **Tests run:** no-waiver regression vs previous engine: 4,000 loans (Standard/Minimum Due/Pass), 0 differences.
  App vs server: 6,000 loans (2,732 with waivers), 0 differences. Fuzz: 3,000 loans, 4,598 waivers + 3,446 passes
  paid off exactly; each waiver lands on the due installment, marks it PAID, touches no other row; interest =
  base + passed − waived within ₱0.02. Real-app harness (Cielo): Waived Interest prefilled ₱2,500.00, preview
  "₱690.00 waived" (₱1,380.00 with her existing Pass), saved, screen alive, next due ₱3,090.00. esbuild OK.
- **Known risks:** Not tried on a phone. A waiver placed by payment order (same as Pass/Minimum Due); a later edit to
  earlier payments can move it. overdue-check needs a redeploy for waivers (else the server sees principal-only
  and flags the interest as overdue). → DEPLOYED (user approved): overdue-check v10, verify_jwt=false, same layout.

# Agreement: Guarantor optional

- [x] `hasGuarantor` flag on the agreement (saved with it). Older saved agreements: on if any guarantor field/signature is filled.
- [x] Agreement Details: "Add guarantor (optional)" toggle; guarantor Name / Address / Gov't ID only when on
- [x] Signatures: Guarantor Signature only when on
- [x] Document (print + PDF): GUARANTOR clause and guarantor signature row only when on
- [x] sw.js → v32
- [x] Verify: esbuild parse; headless Chrome (real app.js, stub Supabase) — off/on/toggle, old agreement with guarantor

## Review

- **Summary:** Guarantor is now opt-in on the loan agreement. Off: no guarantor inputs, no Guarantor Signature pad,
  and the printed/PDF agreement drops the GUARANTOR (JOINT AND SOLIDARY LIABILITY) clause and the guarantor signature
  line. Toggle stored as `hasGuarantor` inside the agreement JSON (no DB change).
- **Files changed:** app.js (`AgreementView`), sw.js (v32)
- **Tests run:** esbuild JSX parse OK. Headless Chrome, real index.html + app.js, stubbed Supabase, 360px: 16/16 checks —
  new agreement defaults off with zero "Guarantor" mentions in form or document; toggle on shows 3 inputs + signature
  + clause; typing keeps focus; toggle off removes all; Save sends `hasGuarantor: false`; an older saved agreement with
  guarantor details (no flag) opens with the toggle on and prints them; no overflow; no console errors.
- **Known risks:** Turning the toggle off hides guarantor details but keeps them in the saved data (turning it back on
  restores them). Not tried on a phone. Pre-existing: the schedule table's Due Date column is clipped at 360px on screen.
- **Follow-up:** Commit + push; on the phone tap Update, open an agreement without a guarantor and Print/Download PDF.

# Agreement: Witnesses optional (same pattern as guarantor)

- [x] `hasWitnesses` flag saved with the agreement; older agreements: on if any witness name/signature is filled
- [x] Agreement Details: "Add witnesses (optional)" toggle; Witness 1/2 Name only when on (shared toggle helper with guarantor)
- [x] Signatures: Witness 1/2 Signature only when on
- [x] Document: "Signed in the presence of" block only when on (and, as before, only named witnesses)
- [x] sw.js stays v32 (guarantor change not shipped yet — both go out together)
- [x] Verify: esbuild parse; extend headless Chrome harness

## Review

- **Summary:** Witnesses are opt-in like the guarantor. Off: no Witness 1/2 Name inputs, no witness signature pads, no
  "Signed in the presence of" block in the print/PDF. On: unchanged from before (only named witnesses print).
  Both switches share one `toggle(key, onLabel, offLabel)` helper. `hasWitnesses` saved in the agreement JSON.
- **Files changed:** app.js (`AgreementView`); sw.js already v32 from the guarantor change (both unshipped).
- **Tests run:** esbuild JSX parse OK. Headless Chrome harness, 360px: 27/27 checks (16 guarantor + 11 witness) —
  new agreement: witness switch off, zero witness labels, zero witness text in the document; on: 2 names + 2 pads;
  typing keeps focus; Witness 1 only → document shows Witness 1 only; off removes all; Save sends
  `hasWitnesses: false`; older agreement with a saved witness opens with the switch on and prints it; no errors.
- **Known risks:** Switching off hides but keeps witness data (switching on restores it). Not tried on a phone.
- **Follow-up:** Commit + push; on the phone tap Update and print an agreement with and without witnesses.

# Review: javilat@ohana.com cash on hand "not tally" (read-only, no changes made)

- [x] App figure rebuilt in SQL: 240,000 opening − 275,083 released + 113,216 collected − 72,078.33 withdrawn = ₱6,054.67
- [x] No code fault: the figure is a plain sum of records (user role → own rows only)
- [x] Live edit seen mid-review (13:01–13:03 UTC, iPhone, live app): OL-0006's 6 payments deleted and being re-entered with real dates
- [ ] Awaiting user: real cash count; confirm Withdrawal "Cebu Hatian" ₱72,078.33; confirm 4 pre-opening 0% loans (OL-0008/09/10/11, ₱111,083);
      fix release dates on 7 loans whose release = first due date (OL-0005/06/13/14/15/16/18)
- **Side finding (not javilat):** an admin login's Cash Flow mixes every account's loans/payments/transactions
  (`api.fetchAll` filters only settings by user) against the admin's own opening balance.
- [x] User: real cash Aug 29 = ₱7,042. App at Aug 29 (current data) = ₱123,583.66 → gap ₱116,541.66.
      Forward from ₱7,042 the recorded Aug 30 → Oct 15 entries end at −₱110,486.99 (impossible) → dates/records wrong.
      If OL-0013/14/15 (₱43,000, entered Aug 27–29, dated Sep 15) and the Cebu Hatian (₱72,078.33, dated Sep 17)
      both happened by Aug 29, the gap is ₱1,463.33 and cash today ≈ ₱4,591.34 (app shows ₱6,054.67).
      Logs (from Aug 27): a loan deleted Aug 27 16:45 UTC; a payment posted Aug 29 03:44 UTC, since deleted.
- [x] Discrepancy audit (real app.js engine, stubbed DB, no writes): all 18 payments equal their installment exactly; no
      duplicates, none before release, no overpayment; nothing overdue. App hero ₱6,054.67.
      During review (not by Claude) the withdrawal was re-entered as 2026-03-03, note blank.
      Result: unexplained ₱1,463.33 on/before Aug 29 (app ₱8,505.33 vs real ₱7,042 once OL-0013/14/15 count as released by
      Aug 29); after Aug 29 the records run to ₱4,591.34 vs app ₱6,054.67 — the same ₱1,463.33.
      Also: 7 loans' release date = first due date; OL-0016 rate 10.8 on Monthly = 21.6% (₱4,320) — confirm intended.
- [x] Formula review (app.js:2065-2082): Cash on Hand = Initial capital + payments (>0) + manual in − loan amounts (at release
      date) − manual out, over ALL records. Matches SQL (₱6,054.67). Findings: (1) no date ≤ today filter and no max on the
      release/payment/transaction date inputs → future-dated entries count immediately (none for javilat today);
      (2) admin login sums every account against the admin's own capital; (3) deleting a loan cascades its payments, so it
      rewrites cash history (FK payments_loan_id_fkey ON DELETE CASCADE). No code changed.
- [x] Excel extract (read-only): C:\Users\Aynne\Desktop\Javilat Cash Flow 2026-10-15.xlsx (outside the repo — holds customer data).
      Sheets: Cash Flow (app order, ties to ₱6,054.67), By Actual Release (Aug 29 check → ₱1,463.33), Loans (left ₱189,379 = app
      "Expected back"). Excel recalc: 0 formula errors; insert-row test (+₱18,000 capital) → ₱24,054.67.

# Cash Flow: running balance on each date header (Cash movements)

- [x] Day header shows the end-of-day running balance instead of the day's net / "+expected" sum
- [x] Balance comes from the full chain (not the filtered rows), so filters never change a date's balance
- [x] With "Show projected" on, dates whose balance includes expected dues read "Projected" in grey; negative balance in red
- [x] sw.js → v33
- [x] Verify: esbuild parse; headless Chrome with javilat snapshot — header = closing balance per date (all-time + a month),
      filter "Money in" keeps the same balances, projected on, 360px no overflow, no console errors

## Review

- **Summary:** Cash movements day headers now read "Balance ₱X" — the running balance at the close of that date — instead
  of the day's +/− net and "+expected". Balances come from a `closing` map built over the full chain (`chrono`), so filters
  and the month picker never change a date's balance. With Show projected on, dates whose balance includes expected dues
  read "Projected ₱X" in grey; a negative actual balance is red. Removed the now-unused day.net / expected / hasActual.
- **Files changed:** app.js (cashflow memo + Cash movements header), sw.js (v33)
- **Tests run:** esbuild parse OK. Headless Chrome, real app.js, javilat snapshot, 360px: 12/12 — 23 headers = 23 dates,
  each equal to an independently computed closing balance; newest = Cash on Hand ₱6,054.67; header = top row's bal;
  "Money in" filter shows 13 dates with unchanged balances; September view matches; projected on → 16 grey "Projected"
  dates, past dates unchanged; no overflow; no console errors; no writes.
- **Known risks:** Not tried on a phone. Pre-existing: within a day, releases are listed before payments, so a row's own
  "bal" can dip negative mid-day (e.g. Oct 15) even though the day closes positive.
- **Follow-up:** Commit + push; on the phone tap Update and open Cash Flow.

# Loan agreement: send to sign by email (plan: ~/.claude/plans/cozy-hatching-lighthouse.md — approved)

- [x] DB: `signing_requests` table + RLS (owner/admin; insert only status=sent w/o signature; update only → cancelled); advisors clean
- [x] Edge function `agreement-sign` (verify_jwt=false): get / sign; atomic sent→signed; evidence; push owner; config.toml
- [x] app.js: `AgreementDocument` + shared PDF export; Borrower/Guarantor Email fields; Send-to-sign sheet (mailto / share / copy);
      status lines; remote signatures in document; `SignPage` mounted for `?sign=`
- [x] sw.js → v34; supabase/E_SIGN_SETUP.md (no secrets)
- [x] Verify: esbuild; headless (stub) app + sign page; live end-to-end on a temporary admin test loan, then delete it

## Review

- **Summary:** "✉ Send to sign by email" under the Borrower / Guarantor signature. Saves the agreement, creates a
  private 14-day link (token made in the browser; only its SHA-256 stored), then opens the lender's email app
  pre-filled (also Share / Copy link). `?sign=<token>` mounts `SignPage` (no login): agreement as sent → draw,
  type name, consent → Sign. Status in the app: sent / opened / signed / expired, "changed since sent" warning,
  Cancel link, Send again. Remote signature shown on the agreement + print/PDF ("Signed electronically <date>").
  The printable document is now `AgreementDocument` (shared); PDF export is `exportAgreementPdf` (shared).
  Signature previews keep white "paper" in dark mode (`.sig-paper`).
- **Files changed:** app.js, index.html (.sig-paper), sw.js (v34), supabase/config.toml,
  supabase/functions/agreement-sign/index.ts (new), supabase/E_SIGN_SETUP.md (new)
- **Live Supabase (approved plan):** table `signing_requests` + RLS + column grants; function `agreement-sign` v1
  (verify_jwt=false). Advisors: nothing new beyond the project-wide "anonymous access" note every table has.
- **Tests run:** esbuild parse OK; moved document diffed vs HEAD — identical except the two new signature captions.
  Headless (stubbed DB): e-sign 39/39, agreement 27/27 (updated for Guarantor Email), running balance 12/12.
  Live function: 10/10 (get, consent/PNG/name validation, sign, double-sign refused, signed copy, expired, cancelled);
  evidence row checked; RLS as signed-in user (rolled back): can't insert signed, flip to signed, overwrite signature,
  cancel a signed one, or delete; normal insert OK; anon can't read. Test loan TEST-ESIGN deleted (cascade).
- **Known risks:** Not tried on a phone (mailto/share on iOS). Push on signing not exercised live (admin has no
  subscribed device). Notarization still in person. A link exposes that agreement to whoever holds it until expiry.
  Found a real signed request on OL-0026 (javilat, 21 Oct 10:29 UTC) — left untouched.
- **Follow-up:** Commit + push (GitHub Pages) so links open the new SignPage; rotate the secrets in PUSH_SETUP.md
  (public repo) — needs user OK.

# Agreement: "Remove" for a remote (emailed-link) signature

- [ ] DB (live, after user OK): status 'revoked' + revoked_at; trigger enforces transitions (sent→signed/cancelled,
      signed→revoked only) and stamps revoked_at; app may update status to cancelled|revoked only (RLS)
- [x] agreement-sign: revoked link → "signature was removed" message (v2)
- [x] app.js: Remove button on the signed card (confirm) → revoke → falls back to drawn signature + Send again;
      "Removed signature by X (signed …) on …" line; document stops using it
- [ ] Verify: esbuild; stub tests (remove/confirm/cancel-dialog/doc); live: revoke allowed, revoked→signed and
      signed→cancelled blocked, revoked link message; temp test loan deleted
- Progress: app + function code done; stub tests 45/45 (6 new: confirm-cancel no-op, revoke write, fallback UI, doc
  without signature, signer 'revoked' message). SQL written to supabase/E_SIGN_SETUP.md. **Live DB + function v2 waiting
  for user OK.**
