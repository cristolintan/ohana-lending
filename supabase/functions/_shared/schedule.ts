// Server-side port of the app's amortization schedule engine (app.js).
// Kept faithful to the client so "overdue" matches what staff see in the UI,
// including the diminishing-interest model, centavo rounding, "Minimum Due" and
// "Pass" deferral rows, "Waived Interest" installments, and mid-stream
// frequency/term changes (freqChange).
//
// Dates are built from Y/M/D components, so a row's calendar date is stable
// regardless of the server timezone; callers compare against a date string in
// the business timezone.

export interface Loan {
  id: string;
  ref: string;
  borrower: string;
  amount: number;
  terms: number;
  flatRate: number;
  dropRate: number | null;
  frequency: string;
  startDate: string;
  freqChange?: { date?: string; frequency?: string; terms?: number } | null;
}

export interface Pay { loanId: string; date: string; amount: number; type: string; createdAt?: string; }

export interface Row {
  remaining: number; principal: number; interest: number; total: number;
  due: Date; status: string; amtLeft: number; isExt: boolean;
  isPass: boolean; passed: number; carried: number; isWaived: boolean; waived: number;
}

export interface Status {
  rows: Row[]; summedInterest: number; summedTotal: number;
  grandLeft: number; overallStatus: string; totalLogged: number;
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

function edate(date: Date, months: number) {
  const t = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(date.getDate(), last));
  return t;
}
function addDays(date: Date, days: number) {
  const r = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  r.setDate(r.getDate() + days);
  return r;
}
function parseDate(str: string) {
  if (!str) return new Date();
  const [y, m, d] = String(str).split("-").map(Number);
  return new Date(y, m - 1, d);
}

// YYYY-MM-DD of a schedule Date (uses its calendar components, TZ-agnostic).
export function isoOf(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// One installment measured in semi-monthly periods — the unit the flat rate is
// quoted in. Monthly spans two periods (2× rate per payment); Weekly counts as
// half a period, so 4 weekly payments cost the same interest as 1 monthly.
const FREQ_MULT: Record<string, number> = { Weekly: 0.5, "Semi-Monthly": 1, Monthly: 2 };
const freqMult = (f: string) => (FREQ_MULT[f] != null ? FREQ_MULT[f] : 1);

// Due date of installment #i (0-based) counted from `from`.
function dueDate(frequency: string, from: Date, i: number) {
  if (frequency === "Weekly") return addDays(from, i * 7);
  if (frequency === "Monthly") return edate(from, i);
  return i % 2 === 0 ? edate(from, i / 2) : addDays(edate(from, (i - 1) / 2), 15);
}

// Payment types that push the principal back one period and add a row.
// Minimum Due pays that row's interest now; a Pass pays nothing and its
// interest is added to the next installment.
const DEFERS: Record<string, boolean> = { "Minimum Due": true, Pass: true };
// Pays the installment's principal only; its interest (incl. any passed onto it) is forgiven.
const WAIVED = "Waived Interest";

// Oldest first; same-day entries in the order they were recorded (a payment's
// type decides which installment it lands on, so ties can't be left to chance).
function byPaidOrder(a: Pay, b: Pay) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const x = a.createdAt || "￿", y = b.createdAt || "￿";
  return x < y ? -1 : x > y ? 1 : 0;
}

type Draft = Omit<Row, "status" | "amtLeft">;

// Settles logged money against the rows oldest-first, in whole centavos.
// A pass row owes nothing of its own, so it reads PASSED, never PAID.
function settleRows(rows: Draft[], totalLogged: number): Row[] {
  const cLogged = Math.round(totalLogged * 100);
  let cDue = 0;
  return rows.map((r) => {
    const cRow = Math.round(r.total * 100);
    cDue += cRow;
    const cLeft = Math.max(0, cRow - Math.max(0, cLogged - (cDue - cRow)));
    const status = r.isPass && cRow === 0 ? "PASSED" : cLeft <= 0 ? "PAID" : cLeft < cRow ? "PARTIAL" : "UNPAID";
    return { ...r, status, amtLeft: cLeft / 100 };
  });
}

function totals(pAmt: number, rows: Row[], totalLogged: number): Status {
  const summedInterest = rows.reduce((s, r) => s + r.interest, 0);
  const summedTotal = rows.reduce((s, r) => s + r.total, 0);
  const grandLeft = Math.max(0, Math.round((pAmt + summedInterest) * 100) - Math.round(totalLogged * 100)) / 100;
  return { rows, summedInterest, summedTotal, grandLeft, overallStatus: grandLeft <= 0 ? "FULLY PAID" : "ACTIVE BALANCE", totalLogged };
}

function computeStatusBase(loan: Loan, allPayments: Pay[]): Status {
  const pAmt = Number(loan.amount), terms = Math.floor(Number(loan.terms));
  const rate = Number(loan.flatRate) / 100;
  const totalInterest = pAmt * rate * terms * freqMult(loan.frequency);
  const drop = (loan.dropRate != null ? Number(loan.dropRate) : Number(loan.flatRate)) / 100;
  const intDrop = (pAmt * drop) / terms;
  const pays = allPayments.filter((p) => p.loanId === loan.id).sort(byPaidOrder);
  const totalLogged = pays.reduce((s, p) => s + Number(p.amount), 0);
  const extCount = pays.filter((p) => DEFERS[p.type]).length;
  const totalRows = terms + extCount;
  const baseP = round2(pAmt / terms);
  const remCents = Math.round(round2(pAmt - baseP * terms) * 100);
  const avgInterest = totalInterest / terms;
  const sd = parseDate(loan.startDate);
  // Interest is rounded to the centavo, the shaved fraction carried forward
  // (intCarry); interest from passed rows waits in passCarry for the next
  // installment that isn't itself a pass.
  const rows: Draft[] = [];
  let intCarry = 0, passCarry = 0;
  for (let step = 1; step <= totalRows; step++) {
    const prevExt = rows.filter((r) => r.principal === 0).length;
    const payType = pays[step - 1] ? pays[step - 1].type : "Standard";
    const isExt = prevExt < extCount && !!DEFERS[payType];
    const isPass = isExt && payType === "Pass";
    const isWaived = !isExt && payType === WAIVED;
    const schedMonth = step - prevExt;
    const prevRem = step === 1 ? pAmt : rows[step - 2].remaining - rows[step - 2].principal;
    // remCents goes negative when pAmt/terms rounds up — shave those centavos
    // instead of adding them, or principal sums above the loan amount.
    const pPaid = isExt ? 0
      : remCents >= 0 ? (schedMonth <= remCents ? baseP + 0.01 : baseP)
      : (schedMonth <= -remCents ? round2(baseP - 0.01) : baseP);
    const ratio = (pAmt - prevRem) / pAmt;
    const tier = Math.min(terms, 1 + Math.round(ratio * terms));
    const intRaw = avgInterest + ((terms + 1) / 2 - tier) * intDrop;
    const intPaid = round2(intRaw + intCarry);
    intCarry += intRaw - intPaid;
    let interest = intPaid, carried = 0, passed = 0, waived = 0;
    if (isPass) { passed = intPaid; passCarry = round2(passCarry + intPaid); interest = 0; }
    else if (passCarry) { carried = passCarry; interest = round2(intPaid + passCarry); passCarry = 0; }
    if (isWaived) { waived = interest; interest = 0; }
    rows.push({ remaining: prevRem, principal: pPaid, interest, total: round2(pPaid + interest),
      due: dueDate(loan.frequency, sd, step - 1), isExt, isPass, passed, carried, isWaived, waived });
  }
  // A pass on the very last row keeps its interest rather than dropping it.
  if (passCarry && rows.length) {
    const last = rows[rows.length - 1];
    last.carried = round2(last.carried + passCarry);
    if (last.isWaived) last.waived = round2(last.waived + passCarry);
    else { last.interest = round2(last.interest + passCarry); last.total = round2(last.total + passCarry); }
  }
  return totals(pAmt, settleRows(rows, totalLogged), totalLogged);
}

export function computeStatus(loan: Loan, allPayments: Pay[]): Status {
  const base = computeStatusBase(loan, allPayments);
  const fc = loan.freqChange;
  if (!fc || !fc.date || (!fc.frequency && !fc.terms)) return base;
  const D = parseDate(fc.date), F1 = fc.frequency || loan.frequency;
  const kept = base.rows.filter((r) => r.due < D);
  const after = base.rows.filter((r) => !(r.due < D));
  if (!after.length) return base;
  const pAmt = Number(loan.amount), totalLogged = base.totalLogged, rate = Number(loan.flatRate) / 100;
  const remP = after.reduce((s, r) => s + r.principal, 0);
  const explicitTerms = !!fc.terms && Number(fc.terms) > 0;
  const n = explicitTerms
    ? Math.min(240, Math.floor(Number(fc.terms)))
    : Math.max(1, Math.round(after.length * freqMult(loan.frequency) / freqMult(F1)));
  const remI = explicitTerms ? remP * rate * n * freqMult(F1) : after.reduce((s, r) => s + r.interest, 0);
  // Passed interest riding on a re-priced installment moves to the first new one.
  const carryIn = explicitTerms ? round2(after.reduce((s, r) => s + (r.isWaived ? 0 : (r.carried || 0)), 0)) : 0;
  const drop = (loan.dropRate != null ? Number(loan.dropRate) : Number(loan.flatRate)) / 100;
  const avgI = remI / n, dropR = (remP * drop) / n;
  const combined: Draft[] = kept.map(({ status: _s, amtLeft: _a, ...r }) => r);
  let remCarry = 0, remPCarry = 0;
  for (let i = 0; i < n; i++) {
    const pRaw = remP / n, iRaw = avgI + ((n + 1) / 2 - (i + 1)) * dropR;
    const p = round2(pRaw + remPCarry); remPCarry += pRaw - p;
    const iv = round2(iRaw + remCarry); remCarry += iRaw - iv;
    const carried = i === 0 ? carryIn : 0;
    combined.push({ remaining: 0, principal: p, interest: round2(iv + carried), total: 0,
      due: dueDate(F1, D, i), isExt: false, isPass: false, passed: 0, carried, isWaived: false, waived: 0 });
  }
  let prevRem = pAmt;
  for (const r of combined) {
    r.remaining = prevRem;
    r.total = round2(r.principal + r.interest);
    prevRem = r.remaining - r.principal;
  }
  return totals(pAmt, settleRows(combined, totalLogged), totalLogged);
}
