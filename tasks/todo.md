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
