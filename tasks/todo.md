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
