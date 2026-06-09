// app.js — Ohana Lending PWA
// Runs via Babel standalone in the browser; no build step required.
// Data is stored in localStorage (persistent, offline-first).

const { useState, useMemo, useEffect, useCallback } = React;

// ─── Helpers ────────────────────────────────────────────────────────────────
const round2 = x => Math.round((x + Number.EPSILON) * 100) / 100;

function edate(date, months) {
  const t = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(date.getDate(), last));
  return t;
}
function addDays(date, days) {
  const r = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  r.setDate(r.getDate() + days);
  return r;
}
function parseDate(str) {
  if (!str) return new Date();
  const [y, m, d] = String(str).split("-").map(Number);
  return new Date(y, m - 1, d);
}
const fmtDate = d => d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
const today = () => new Date().toISOString().slice(0, 10);

// ─── Storage (localStorage) ──────────────────────────────────────────────────
const LS_KEY = "ohana_pwa_db";
function loadDb() {
  try { const v = localStorage.getItem(LS_KEY); return v ? JSON.parse(v) : { loans: [], payments: [] }; }
  catch { return { loans: [], payments: [] }; }
}
function saveDb(db) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch (e) { console.error(e); }
}

// ─── Finance logic ───────────────────────────────────────────────────────────
function computeCalc({ amount, terms, flatRate, frequency, startDate, dropRate }) {
  const pAmt = Number(amount) || 0, n = Math.max(0, Math.floor(Number(terms) || 0));
  const rate = (Number(flatRate) || 0) / 100, drop = (Number(dropRate) || 0) / 100;
  if (pAmt <= 0 || n <= 0) return { rows: [], totalInterest: 0, totalRepay: pAmt };
  const multiplier = frequency === "Monthly" ? 2 : 1;
  const totalInterest = pAmt * rate * n * multiplier;
  const baseP = round2(pAmt / n);
  const remCents = Math.round(round2(pAmt - baseP * n) * 100);
  const avgInterest = totalInterest / n, intDrop = (pAmt * drop) / n;
  const sd = parseDate(startDate);
  const rows = [];
  for (let m = 1; m <= n; m++) {
    const prevRem = m === 1 ? pAmt : rows[m-2].remaining - rows[m-2].principal;
    const pPaid = m <= remCents ? baseP + 0.01 : baseP;
    const intPaid = avgInterest + ((n + 1) / 2 - m) * intDrop;
    const step = m - 1;
    let due;
    if (frequency === "Monthly") due = edate(sd, step);
    else due = step % 2 === 0 ? edate(sd, step / 2) : addDays(edate(sd, (step - 1) / 2), 15);
    rows.push({ period: m, remaining: prevRem, principal: pPaid, interest: intPaid, total: pPaid + intPaid, due });
  }
  return { rows, totalInterest, totalRepay: pAmt + totalInterest };
}

function computeStatus(loan, allPayments) {
  const pAmt = Number(loan.amount), terms = Math.floor(Number(loan.terms));
  const rate = Number(loan.flatRate) / 100;
  const multiplier = loan.frequency === "Monthly" ? 2 : 1;
  const totalInterest = pAmt * rate * terms * multiplier;
  const intDrop = (pAmt * 0.03) / terms;
  const pays = allPayments.filter(p => p.loanId === loan.id).sort((a, b) => a.date < b.date ? -1 : 1);
  const totalLogged = pays.reduce((s, p) => s + Number(p.amount), 0);
  const extCount = pays.filter(p => p.type === "Minimum Due").length;
  const totalRows = terms + extCount;
  const baseP = round2(pAmt / terms);
  const remCents = Math.round(round2(pAmt - baseP * terms) * 100);
  const avgInterest = totalInterest / terms;
  const sd = parseDate(loan.startDate);
  const rows = []; let cumDue = 0;
  for (let step = 1; step <= totalRows; step++) {
    const prevExt = rows.filter(r => r.principal === 0).length;
    const payType = pays[step - 1] ? pays[step - 1].type : "Standard";
    const isExt = prevExt < extCount && payType === "Minimum Due";
    const schedMonth = step - prevExt;
    const prevRem = step === 1 ? pAmt : rows[step-2].remaining - rows[step-2].principal;
    const pPaid = isExt ? 0 : schedMonth <= remCents ? baseP + 0.01 : baseP;
    const ratio = (pAmt - prevRem) / pAmt;
    const tier = Math.min(terms, 1 + Math.round(ratio * terms));
    const intPaid = avgInterest + ((terms + 1) / 2 - tier) * intDrop;
    const totPay = pPaid + intPaid;
    const stepIdx = step - 1;
    let due;
    if (loan.frequency === "Monthly") due = edate(sd, stepIdx);
    else due = stepIdx % 2 === 0 ? edate(sd, stepIdx / 2) : addDays(edate(sd, (stepIdx - 1) / 2), 15);
    cumDue += totPay;
    const status = totalLogged >= cumDue ? "PAID" : totalLogged > cumDue - totPay ? "PARTIAL" : "UNPAID";
    const amtLeft = Math.max(0, totPay - Math.max(0, totalLogged - (cumDue - totPay)));
    rows.push({ period: isExt ? `${schedMonth} (Ext)` : String(schedMonth), remaining: prevRem, principal: pPaid, interest: intPaid, total: totPay, due, status, amtLeft, isExt });
  }
  const summedInterest = rows.reduce((s, r) => s + r.interest, 0);
  const summedTotal = rows.reduce((s, r) => s + r.total, 0);
  const grandLeft = Math.max(0, pAmt + summedInterest - totalLogged);
  return { rows, summedInterest, summedTotal, grandLeft, overallStatus: grandLeft === 0 ? "FULLY PAID" : "ACTIVE BALANCE", totalLogged };
}

// ─── Tiny components ─────────────────────────────────────────────────────────
const inputCls = "w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 outline-none text-slate-800 bg-white text-sm";
const labelCls = "block text-xs font-semibold text-slate-500 mb-1.5 uppercase tracking-wide";

function Stat({ label, value, tone, small }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    amber: "bg-amber-50 text-amber-800",
    emerald: "bg-emerald-50 text-emerald-800",
    teal: "bg-teal-50 text-teal-800"
  };
  return (
    <div className={`rounded-2xl p-3.5 ${tones[tone]}`}>
      <p className="text-xs font-semibold uppercase tracking-wide opacity-60">{label}</p>
      <p className={`font-bold mt-0.5 ${small ? "text-sm" : "text-lg"}`}>{value}</p>
    </div>
  );
}

function Badge({ s }) {
  const map = {
    PAID: "bg-emerald-100 text-emerald-700",
    PARTIAL: "bg-amber-100 text-amber-700",
    UNPAID: "bg-slate-200 text-slate-600",
    "FULLY PAID": "bg-emerald-100 text-emerald-700",
    "ACTIVE BALANCE": "bg-amber-100 text-amber-700"
  };
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${map[s] || "bg-slate-100"}`}>{s}</span>;
}

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2 whitespace-nowrap">
      <span className="text-emerald-400">✓</span> {msg}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function App() {
  const [db, setDb] = useState(() => loadDb());
  const [tab, setTab] = useState("new");
  const [currency, setCurrency] = useState("PHP");
  const [toast, setToast] = useState("");

  // Calc inputs
  const [name, setName] = useState("");
  const [amount, setAmount] = useState(10000);
  const [terms, setTerms] = useState(6);
  const [flatRate, setFlatRate] = useState(3.6);
  const [frequency, setFrequency] = useState("Semi-Monthly");
  const [startDate, setStartDate] = useState(today());
  const [dropRate, setDropRate] = useState(3.6);

  // Status inputs
  const [selBorrower, setSelBorrower] = useState("");
  const [loanIdOvr, setLoanIdOvr] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payType, setPayType] = useState("Standard");
  const [payDate, setPayDate] = useState(today());

  const persist = useCallback(next => { setDb(next); saveDb(next); }, []);
  const flash = msg => { setToast(msg); setTimeout(() => setToast(""), 2500); };

  const sym = currency === "PHP" ? "₱" : "$";
  const fmt = v => sym + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const calc = useMemo(() => computeCalc({ amount, terms, flatRate, frequency, startDate, dropRate }), [amount, terms, flatRate, frequency, startDate, dropRate]);

  const saveLoan = () => {
    if (!(Number(amount) > 0) || !(Number(terms) > 0)) { flash("Enter valid amount and terms."); return; }
    const nums = db.loans.map(l => parseInt(l.id.split("-")[1], 10)).filter(x => !isNaN(x));
    const id = "OL-" + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
    const loan = { id, borrower: name.trim() || "Unnamed", amount: Number(amount), terms: Math.floor(Number(terms)), flatRate: Number(flatRate), frequency, startDate, createdAt: Date.now() };
    persist({ ...db, loans: [...db.loans, loan] });
    flash(`Saved ${id} — ${loan.borrower}`);
    setTab("records");
  };

  const deleteLoan = id => {
    if (!confirm(`Delete loan ${id}? This also removes all its payments.`)) return;
    persist({ loans: db.loans.filter(l => l.id !== id), payments: db.payments.filter(p => p.loanId !== id) });
    flash(`Deleted ${id}`);
  };

  const borrowers = useMemo(() => [...new Set(db.loans.map(l => l.borrower))], [db.loans]);

  const resolved = useMemo(() => {
    if (loanIdOvr.trim()) {
      const loan = db.loans.find(l => l.id.toLowerCase() === loanIdOvr.trim().toLowerCase());
      return loan ? { loan } : { error: "Loan not found." };
    }
    if (selBorrower) {
      const active = db.loans.filter(l => l.borrower === selBorrower).find(l => computeStatus(l, db.payments).overallStatus !== "FULLY PAID");
      return active ? { loan: active } : { error: "No active loan for this borrower." };
    }
    return { prompt: true };
  }, [db, selBorrower, loanIdOvr]);

  const statusData = useMemo(() => resolved.loan ? computeStatus(resolved.loan, db.payments) : null, [resolved, db.payments]);

  const addPayment = () => {
    if (!resolved.loan) return;
    if (!(Number(payAmount) > 0)) { flash("Enter a payment amount."); return; }
    const p = { id: Date.now(), loanId: resolved.loan.id, date: payDate, amount: Number(payAmount), type: payType };
    persist({ ...db, payments: [...db.payments, p] });
    setPayAmount("");
    flash(`Logged ${fmt(p.amount)}`);
  };

  const loanPayments = resolved.loan ? db.payments.filter(p => p.loanId === resolved.loan.id).sort((a, b) => a.date < b.date ? -1 : 1) : [];

  // ── Bottom nav ──
  const navItems = [
    { id: "new",     label: "New Loan",  icon: "calculator" },
    { id: "records", label: "Records",   icon: "file-text" },
    { id: "status",  label: "Payments",  icon: "wallet" },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 font-sans">
      {/* Header */}
      <header className="bg-emerald-700 text-white px-4 py-3 flex items-center justify-between shadow-md sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center font-bold text-sm">OL</div>
          <div>
            <p className="font-bold text-sm leading-tight">Ohana Lending</p>
            <p className="text-emerald-200 text-xs">Offline · {db.loans.length} loans</p>
          </div>
        </div>
        <select className="px-2 py-1 rounded-lg text-slate-800 text-sm bg-white" value={currency} onChange={e => setCurrency(e.target.value)}>
          <option value="PHP">₱ Peso</option>
          <option value="USD">$ Dollar</option>
        </select>
      </header>

      {/* Body */}
      <main className="flex-1 overflow-y-auto scroll-ios px-4 py-4 pb-24 space-y-4">

        {/* ── NEW LOAN ── */}
        {tab === "new" && (<>
          <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3 shadow-sm">
            <p className="font-bold text-slate-700">Loan Details</p>
            <div>
              <label className={labelCls}>Borrower Name</label>
              <input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="Juan Dela Cruz" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Amount</label>
                <input type="number" className={inputCls} value={amount} onChange={e => setAmount(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Terms</label>
                <input type="number" className={inputCls} value={terms} onChange={e => setTerms(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Flat Rate %</label>
                <input type="number" step="0.1" className={inputCls} value={flatRate} onChange={e => setFlatRate(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Decline Rate %</label>
                <input type="number" step="0.1" className={inputCls} value={dropRate} onChange={e => setDropRate(e.target.value)} />
              </div>
            </div>
            <div>
              <label className={labelCls}>Frequency</label>
              <select className={inputCls} value={frequency} onChange={e => setFrequency(e.target.value)}>
                <option>Semi-Monthly</option><option>Monthly</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Start Date</label>
              <input type="date" className={inputCls} value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={saveLoan} className="flex-1 py-3 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white font-semibold text-sm">Save Loan</button>
              <button onClick={() => { setName(""); setAmount(10000); setTerms(6); setFlatRate(3.6); setFrequency("Semi-Monthly"); setStartDate(today()); setDropRate(3.6); }} className="px-4 py-3 rounded-xl border border-slate-300 text-slate-600 text-sm font-medium">Reset</button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Stat label="Loan Amount" value={fmt(amount)} tone="slate" />
            <Stat label="Total Interest" value={fmt(calc.totalInterest)} tone="amber" />
            <Stat label="Total Repayment" value={fmt(calc.totalRepay)} tone="emerald" />
            <Stat label="Periods" value={calc.rows.length} tone="teal" />
          </div>

          {calc.rows.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <p className="px-4 py-3 font-bold text-slate-700 border-b border-slate-100">Projected Schedule</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="bg-slate-100 text-slate-500">
                    {["#","Remaining","Principal","Interest","Total","Due"].map(h => <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {calc.rows.map((r, i) => (
                      <tr key={r.period} className={i % 2 ? "bg-slate-50" : "bg-white"}>
                        <td className="px-3 py-2 font-medium">{r.period}</td>
                        <td className="px-3 py-2">{fmt(r.remaining)}</td>
                        <td className="px-3 py-2 text-teal-700">{fmt(r.principal)}</td>
                        <td className="px-3 py-2 text-amber-600">{fmt(r.interest)}</td>
                        <td className="px-3 py-2 font-semibold">{fmt(r.total)}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-slate-500">{fmtDate(r.due)}</td>
                      </tr>
                    ))}
                    <tr className="bg-emerald-50 border-t-2 border-emerald-200 font-bold text-xs">
                      <td className="px-3 py-2">Total</td><td></td>
                      <td className="px-3 py-2 text-teal-700">{fmt(amount)}</td>
                      <td className="px-3 py-2 text-amber-700">{fmt(calc.totalInterest)}</td>
                      <td className="px-3 py-2 text-emerald-700">{fmt(calc.totalRepay)}</td><td></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>)}

        {/* ── RECORDS ── */}
        {tab === "records" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-bold text-slate-700">{db.loans.length} Loan{db.loans.length !== 1 ? "s" : ""}</p>
              <button onClick={() => setTab("new")} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold">+ New</button>
            </div>
            {db.loans.length === 0 && <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-slate-400">No loans yet.</div>}
            {db.loans.map(l => {
              const s = computeStatus(l, db.payments);
              return (
                <div key={l.id} className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-emerald-600 font-semibold">{l.id}</p>
                      <p className="font-bold">{l.borrower}</p>
                      <p className="text-xs text-slate-500">{l.terms} terms · {l.flatRate}% · {l.frequency} · {fmtDate(parseDate(l.startDate))}</p>
                    </div>
                    <Badge s={s.overallStatus} />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="bg-slate-50 rounded-lg p-2"><p className="text-slate-400">Amount</p><p className="font-bold">{fmt(l.amount)}</p></div>
                    <div className="bg-emerald-50 rounded-lg p-2"><p className="text-slate-400">Paid</p><p className="font-bold text-emerald-700">{fmt(s.totalLogged)}</p></div>
                    <div className="bg-amber-50 rounded-lg p-2"><p className="text-slate-400">Balance</p><p className="font-bold text-amber-700">{fmt(s.grandLeft)}</p></div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => { setLoanIdOvr(l.id); setSelBorrower(""); setTab("status"); }} className="flex-1 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold">View Payments</button>
                    <button onClick={() => deleteLoan(l.id)} className="px-4 py-2 rounded-xl border border-red-200 text-red-500 text-xs font-semibold">Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── STATUS ── */}
        {tab === "status" && (<>
          <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3 shadow-sm">
            <p className="font-bold text-slate-700">Find Loan</p>
            <div>
              <label className={labelCls}>Borrower</label>
              <select className={inputCls} value={selBorrower} onChange={e => { setSelBorrower(e.target.value); setLoanIdOvr(""); }}>
                <option value="">— select —</option>
                {borrowers.map(b => <option key={b}>{b}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Or Loan ID</label>
              <input className={inputCls} value={loanIdOvr} onChange={e => setLoanIdOvr(e.target.value)} placeholder="OL-0001" />
            </div>
          </div>

          {resolved.prompt && <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400 text-sm">Select a borrower or enter a Loan ID.</div>}
          {resolved.error && <div className="bg-white rounded-2xl border border-amber-200 p-6 text-center text-amber-600 font-medium text-sm">{resolved.error}</div>}

          {resolved.loan && statusData && (<>
            <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm flex items-center justify-between gap-2">
              <div>
                <p className="text-xs text-emerald-600 font-semibold">{resolved.loan.id}</p>
                <p className="font-bold">{resolved.loan.borrower}</p>
                <p className="text-xs text-slate-500">{fmt(resolved.loan.amount)} · {resolved.loan.terms} terms · {resolved.loan.flatRate}%</p>
              </div>
              <Badge s={statusData.overallStatus} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Stat label="Total Interest" value={fmt(statusData.summedInterest)} tone="amber" />
              <Stat label="Total Due" value={fmt(resolved.loan.amount + statusData.summedInterest)} tone="slate" />
              <Stat label="Total Paid" value={fmt(statusData.totalLogged)} tone="emerald" />
              <Stat label="Balance Left" value={fmt(statusData.grandLeft)} tone="teal" />
            </div>

            {/* Log Payment */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3 shadow-sm">
              <p className="font-bold text-slate-700">Log a Payment</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Amount</label>
                  <input type="number" className={inputCls} value={payAmount} onChange={e => setPayAmount(e.target.value)} placeholder="0.00" />
                </div>
                <div>
                  <label className={labelCls}>Type</label>
                  <select className={inputCls} value={payType} onChange={e => setPayType(e.target.value)}>
                    <option>Standard</option><option>Minimum Due</option>
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Date</label>
                <input type="date" className={inputCls} value={payDate} onChange={e => setPayDate(e.target.value)} />
              </div>
              <button onClick={addPayment} className="w-full py-3 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white font-semibold text-sm">Add Payment</button>

              {loanPayments.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  {loanPayments.map(p => (
                    <div key={p.id} className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2 text-xs">
                      <span className="font-semibold">{fmt(p.amount)}</span>
                      <span className="text-slate-500">{p.type} · {fmtDate(parseDate(p.date))}</span>
                      <button onClick={() => persist({ ...db, payments: db.payments.filter(x => x.id !== p.id) })} className="text-red-400 pl-2 text-base leading-none">×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Schedule */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <p className="px-4 py-3 font-bold text-slate-700 border-b border-slate-100">Schedule & Status</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="bg-slate-100 text-slate-500">
                    {["#","Principal","Interest","Total","Due","Status","Left"].map(h => <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {statusData.rows.map((r, i) => (
                      <tr key={i} className={r.isExt ? "bg-amber-50" : i % 2 ? "bg-slate-50" : "bg-white"}>
                        <td className="px-3 py-2 font-medium">{r.period}</td>
                        <td className="px-3 py-2 text-teal-700">{fmt(r.principal)}</td>
                        <td className="px-3 py-2 text-amber-600">{fmt(r.interest)}</td>
                        <td className="px-3 py-2 font-semibold">{fmt(r.total)}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-slate-500">{fmtDate(r.due)}</td>
                        <td className="px-3 py-2"><Badge s={r.status} /></td>
                        <td className="px-3 py-2">{fmt(r.amtLeft)}</td>
                      </tr>
                    ))}
                    <tr className="bg-emerald-50 border-t-2 border-emerald-200 font-bold text-xs">
                      <td className="px-3 py-2">Total</td>
                      <td className="px-3 py-2 text-teal-700">{fmt(resolved.loan.amount)}</td>
                      <td className="px-3 py-2 text-amber-700">{fmt(statusData.summedInterest)}</td>
                      <td className="px-3 py-2 text-emerald-700">{fmt(statusData.summedTotal)}</td>
                      <td></td>
                      <td className="px-3 py-2"><Badge s={statusData.overallStatus} /></td>
                      <td className="px-3 py-2">{fmt(statusData.grandLeft)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </>)}
        </>)}
      </main>

      {/* Bottom Tab Bar (iOS-style) */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur border-t border-slate-200 flex z-20" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {navItems.map(({ id, label, icon }) => (
          <button key={id} onClick={() => setTab(id)} className={`flex-1 flex flex-col items-center py-2.5 gap-0.5 text-xs font-medium transition-colors ${tab === id ? "text-emerald-600" : "text-slate-400"}`}>
            <i data-lucide={icon} className="w-5 h-5" style={{ strokeWidth: tab === id ? 2.5 : 1.8 }}></i>
            {label}
          </button>
        ))}
      </nav>

      <Toast msg={toast} />
    </div>
  );
}

// Init Lucide icons after render
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));
setTimeout(() => { if (window.lucide) lucide.createIcons(); }, 300);