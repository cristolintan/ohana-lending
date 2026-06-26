// Server-side port of the app's amortization schedule engine (app.js).
// Kept faithful to the client so "overdue" matches what staff see in the UI,
// including the diminishing-interest model, "Minimum Due" extension rows, and
// mid-stream frequency/term changes (freqChange).
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

export interface Pay { loanId: string; date: string; amount: number; type: string; }

export interface Row {
  remaining: number; principal: number; interest: number; total: number;
  due: Date; status: string; amtLeft: number; isExt: boolean;
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

function computeStatusBase(loan: Loan, allPayments: Pay[]): Status {
  const pAmt = Number(loan.amount), terms = Math.floor(Number(loan.terms));
  const rate = Number(loan.flatRate) / 100;
  const multiplier = loan.frequency === "Monthly" ? 2 : 1;
  const totalInterest = pAmt * rate * terms * multiplier;
  const drop = (loan.dropRate != null ? Number(loan.dropRate) : Number(loan.flatRate)) / 100;
  const intDrop = (pAmt * drop) / terms;
  const pays = allPayments.filter((p) => p.loanId === loan.id).sort((a, b) => (a.date < b.date ? -1 : 1));
  const totalLogged = pays.reduce((s, p) => s + Number(p.amount), 0);
  const extCount = pays.filter((p) => p.type === "Minimum Due").length;
  const totalRows = terms + extCount;
  const baseP = round2(pAmt / terms);
  const remCents = Math.round(round2(pAmt - baseP * terms) * 100);
  const avgInterest = totalInterest / terms;
  const sd = parseDate(loan.startDate);
  const rows: Row[] = [];
  let cumDue = 0;
  for (let step = 1; step <= totalRows; step++) {
    const prevExt = rows.filter((r) => r.principal === 0).length;
    const payType = pays[step - 1] ? pays[step - 1].type : "Standard";
    const isExt = prevExt < extCount && payType === "Minimum Due";
    const schedMonth = step - prevExt;
    const prevRem = step === 1 ? pAmt : rows[step - 2].remaining - rows[step - 2].principal;
    const pPaid = isExt ? 0 : schedMonth <= remCents ? baseP + 0.01 : baseP;
    const ratio = (pAmt - prevRem) / pAmt;
    const tier = Math.min(terms, 1 + Math.round(ratio * terms));
    const intPaid = avgInterest + ((terms + 1) / 2 - tier) * intDrop;
    const totPay = pPaid + intPaid;
    const stepIdx = step - 1;
    let due: Date;
    if (loan.frequency === "Monthly") due = edate(sd, stepIdx);
    else due = stepIdx % 2 === 0 ? edate(sd, stepIdx / 2) : addDays(edate(sd, (stepIdx - 1) / 2), 15);
    cumDue += totPay;
    const status = totalLogged >= cumDue ? "PAID" : totalLogged > cumDue - totPay ? "PARTIAL" : "UNPAID";
    const amtLeft = Math.max(0, totPay - Math.max(0, totalLogged - (cumDue - totPay)));
    rows.push({ remaining: prevRem, principal: pPaid, interest: intPaid, total: totPay, due, status, amtLeft, isExt });
  }
  const summedInterest = rows.reduce((s, r) => s + r.interest, 0);
  const summedTotal = rows.reduce((s, r) => s + r.total, 0);
  const grandLeft = Math.max(0, pAmt + summedInterest - totalLogged);
  return { rows, summedInterest, summedTotal, grandLeft, overallStatus: grandLeft === 0 ? "FULLY PAID" : "ACTIVE BALANCE", totalLogged };
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
  const mult = (f: string) => (f === "Monthly" ? 2 : 1);
  const explicitTerms = fc.terms && Number(fc.terms) > 0;
  const n = explicitTerms
    ? Math.min(240, Math.floor(Number(fc.terms)))
    : Math.max(1, Math.round(after.length * mult(loan.frequency) / mult(F1)));
  const remI = explicitTerms ? remP * rate * n * mult(F1) : after.reduce((s, r) => s + r.interest, 0);
  const drop = (loan.dropRate != null ? Number(loan.dropRate) : Number(loan.flatRate)) / 100;
  const avgI = remI / n, dropR = (remP * drop) / n;
  const rem: { principal: number; interest: number; due: Date; isExt?: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    let due: Date;
    if (F1 === "Monthly") due = edate(D, i);
    else due = i % 2 === 0 ? edate(D, i / 2) : addDays(edate(D, (i - 1) / 2), 15);
    rem.push({ principal: remP / n, interest: avgI + ((n + 1) / 2 - (i + 1)) * dropR, due });
  }
  const combined = [
    ...kept.map((r) => ({ principal: r.principal, interest: r.interest, due: r.due, isExt: r.isExt })),
    ...rem,
  ];
  let prevRem = pAmt, cumDue = 0;
  const rows: Row[] = [];
  combined.forEach((r) => {
    const remaining = prevRem, total = r.principal + r.interest;
    cumDue += total;
    const status = totalLogged >= cumDue ? "PAID" : totalLogged > cumDue - total ? "PARTIAL" : "UNPAID";
    const amtLeft = Math.max(0, total - Math.max(0, totalLogged - (cumDue - total)));
    rows.push({ remaining, principal: r.principal, interest: r.interest, total, due: r.due, status, amtLeft, isExt: !!r.isExt });
    prevRem = remaining - r.principal;
  });
  const summedInterest = rows.reduce((s, r) => s + r.interest, 0);
  const summedTotal = rows.reduce((s, r) => s + r.total, 0);
  const grandLeft = Math.max(0, pAmt + summedInterest - totalLogged);
  return { rows, summedInterest, summedTotal, grandLeft, overallStatus: grandLeft <= 0.005 ? "FULLY PAID" : "ACTIVE BALANCE", totalLogged };
}
