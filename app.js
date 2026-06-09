// app.js — Ohana Lending PWA
// Runs via Babel standalone in the browser; no build step required.
// Data is stored in localStorage (persistent, offline-first).

const { useState, useMemo, useEffect, useCallback, useRef } = React;

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

function pesoWords(n) {
  n = Math.floor(Number(n) || 0);
  if (n <= 0) return "ZERO PESOS";
  const ones = ["","ONE","TWO","THREE","FOUR","FIVE","SIX","SEVEN","EIGHT","NINE","TEN","ELEVEN","TWELVE","THIRTEEN","FOURTEEN","FIFTEEN","SIXTEEN","SEVENTEEN","EIGHTEEN","NINETEEN"];
  const tens = ["","","TWENTY","THIRTY","FORTY","FIFTY","SIXTY","SEVENTY","EIGHTY","NINETY"];
  const chunk = x => {
    let s = "";
    if (x >= 100) { s += ones[Math.floor(x / 100)] + " HUNDRED"; x %= 100; if (x) s += " "; }
    if (x >= 20) { s += tens[Math.floor(x / 10)]; x %= 10; if (x) s += "-" + ones[x]; }
    else if (x > 0) s += ones[x];
    return s;
  };
  let words = "";
  for (const [label, val] of [["BILLION", 1e9], ["MILLION", 1e6], ["THOUSAND", 1e3]]) {
    if (n >= val) { words += chunk(Math.floor(n / val)) + " " + label + " "; n %= val; }
  }
  if (n > 0) words += chunk(n);
  return words.trim() + " PESOS";
}

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
    teal: "bg-teal-50 text-teal-800",
    red: "bg-red-50 text-red-700"
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
    OVERDUE: "bg-red-100 text-red-700",
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

// ─── Signature pad (canvas, touch + mouse) ───────────────────────────────────
function SignaturePad({ label, value, onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const c = canvasRef.current, ctx = c.getContext("2d");
    ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.strokeStyle = "#0f172a";
    if (value) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, c.width, c.height); img.src = value; }
  }, []);

  const pos = e => {
    const c = canvasRef.current, r = c.getBoundingClientRect();
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * (c.width / r.width), y: (t.clientY - r.top) * (c.height / r.height) };
  };
  const start = e => { drawing.current = true; last.current = pos(e); };
  const move = e => {
    if (!drawing.current) return;
    const ctx = canvasRef.current.getContext("2d"), p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last.current = p;
  };
  const end = () => { if (!drawing.current) return; drawing.current = false; onChange(canvasRef.current.toDataURL("image/png")); };
  const clear = () => { const c = canvasRef.current; c.getContext("2d").clearRect(0, 0, c.width, c.height); onChange(""); };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className={labelCls}>{label}</label>
        <button type="button" onClick={clear} className="text-xs text-red-400 font-semibold">Clear</button>
      </div>
      <canvas ref={canvasRef} width={500} height={150}
        className="w-full h-28 rounded-xl border border-slate-300 bg-white touch-none cursor-crosshair"
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
    </div>
  );
}

// ─── Loan Agreement (fill-in form + signatures + printable document) ──────────
function AgreementView({ loan, fmt, onBack, onSave }) {
  const [f, setF] = useState(() => ({
    lenderName: "Liezel Anne Davalos",
    lenderAddress: "B19 L13 Ph1 Josenia St. Mayamot, Antipolo City",
    lenderId: "P9245579C",
    borrowerAddress: "", borrowerId: "", purpose: "",
    guarantorName: "", guarantorAddress: "", guarantorId: "",
    witness1: "", witness2: "", agreementDate: today(),
    sigLender: "", sigBorrower: "", sigGuarantor: "", sigWitness1: "", sigWitness2: "",
    ...(loan.agreement || {})
  }));
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const sched = useMemo(() => computeCalc({
    amount: loan.amount, terms: loan.terms, flatRate: loan.flatRate,
    frequency: loan.frequency, startDate: loan.startDate,
    dropRate: loan.dropRate != null ? loan.dropRate : loan.flatRate
  }), [loan]);
  const totalRepay = Number(loan.amount) + sched.totalInterest;
  const aDate = parseDate(f.agreementDate);
  const firstDue = sched.rows.length ? fmtDate(sched.rows[0].due) : "—";
  const lastDue = sched.rows.length ? fmtDate(sched.rows[sched.rows.length - 1].due) : "—";

  const fields = [
    ["Lender Name", "lenderName"], ["Lender Address", "lenderAddress"], ["Lender Gov't ID No.", "lenderId"],
    ["Borrower Address", "borrowerAddress"], ["Borrower Gov't ID No.", "borrowerId"],
    ["Purpose of Loan", "purpose"],
    ["Guarantor Name", "guarantorName"], ["Guarantor Address", "guarantorAddress"], ["Guarantor Gov't ID No.", "guarantorId"],
    ["Witness 1 Name", "witness1"], ["Witness 2 Name", "witness2"]
  ];

  const Sig = ({ src, name, role }) => (
    <div className="text-center">
      <div className="h-16 flex items-end justify-center">{src ? <img src={src} alt="" className="max-h-16" /> : null}</div>
      <div className="border-t border-slate-800 pt-1 font-bold">{name || " "}</div>
      <div className="text-xs italic text-slate-600">{role}</div>
    </div>
  );
  const H = ({ children }) => <h2 className="font-bold pt-3">{children}</h2>;

  return (
    <div className="space-y-4">
      <div className="no-print flex items-center justify-between gap-2">
        <button onClick={onBack} className="px-3 py-2 rounded-xl border border-slate-300 text-slate-600 text-sm font-semibold">← Back</button>
        <div className="flex gap-2">
          <button onClick={() => onSave(f)} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold">Save</button>
          <button onClick={() => window.print()} className="px-4 py-2 rounded-xl bg-slate-800 text-white text-sm font-semibold">Print / PDF</button>
        </div>
      </div>

      <div className="no-print bg-white rounded-2xl border border-slate-200 p-4 space-y-3 shadow-sm">
        <p className="font-bold text-slate-700">Agreement Details · {loan.id}</p>
        <div>
          <label className={labelCls}>Agreement Date</label>
          <input type="date" className={inputCls} value={f.agreementDate} onChange={e => set("agreementDate", e.target.value)} />
        </div>
        {fields.map(([lbl, key]) => (
          <div key={key}>
            <label className={labelCls}>{lbl}</label>
            <input className={inputCls} value={f[key]} onChange={e => set(key, e.target.value)} />
          </div>
        ))}
      </div>

      <div className="no-print bg-white rounded-2xl border border-slate-200 p-4 space-y-3 shadow-sm">
        <p className="font-bold text-slate-700">Signatures</p>
        <p className="text-xs text-slate-400 -mt-2">Sign with finger or mouse — saved with the agreement.</p>
        <SignaturePad label="Lender Signature" value={f.sigLender} onChange={v => set("sigLender", v)} />
        <SignaturePad label="Borrower Signature" value={f.sigBorrower} onChange={v => set("sigBorrower", v)} />
        <SignaturePad label="Guarantor Signature" value={f.sigGuarantor} onChange={v => set("sigGuarantor", v)} />
        <SignaturePad label="Witness 1 Signature" value={f.sigWitness1} onChange={v => set("sigWitness1", v)} />
        <SignaturePad label="Witness 2 Signature" value={f.sigWitness2} onChange={v => set("sigWitness2", v)} />
      </div>

      <div id="agreement-print" className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm text-slate-800 text-sm leading-relaxed space-y-2"
        style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}>
        <h1 className="text-center font-bold text-lg">LOAN AGREEMENT</h1>
        <p>This Loan Agreement is made and entered into this {fmtDate(aDate)}, by and between:</p>
        <p><b>{f.lenderName || "_____"}</b>, of legal age, Filipino, residing at {f.lenderAddress || "_____"}, holding Government ID No. {f.lenderId || "_____"}, hereinafter referred to as the "<i>Lender</i>",</p>
        <p>and</p>
        <p><b>{loan.borrower}</b>, of legal age, Filipino, residing at {f.borrowerAddress || "_____"}, holding Government ID No. {f.borrowerId || "_____"}, hereinafter referred to as the "<i>Borrower</i>".</p>

        <H>LOAN AMOUNT</H>
        <p>The Lender agrees to lend to the Borrower the amount of:</p>
        <p className="font-bold">{pesoWords(loan.amount)} ({fmt(loan.amount)})</p>
        <p>The Borrower acknowledges receipt of the full loan amount upon signing of this Agreement.</p>

        <H>PURPOSE OF LOAN</H>
        <p>The loan shall be used exclusively for {f.purpose || "_____"}. The Borrower agrees not to use the loan for unlawful or unauthorized purposes.</p>

        <H>INTEREST</H>
        <p>The loan shall bear interest as reflected in the amortization/payment schedule below, forming an integral part of this Agreement.</p>
        <p>The total agreed interest is {fmt(sched.totalInterest)}, making the total repayment amount {fmt(totalRepay)}, payable over {loan.terms} {loan.frequency} installments in accordance with the agreed schedule.</p>

        <H>RESPONSIBILITY AND OBLIGATION</H>
        <p>The Borrower acknowledges their responsibility to:</p>
        <ul className="list-disc pl-6">
          <li>Repay the loan according to the agreed terms</li>
          <li>Pay the interest on the loan</li>
          <li>Notify the Lender of any changes or difficulties that may affect their ability to repay the loan</li>
        </ul>

        <H>REPAYMENT TERMS AND SPECIAL CONDITION</H>
        <p>a. The Borrower shall repay the Loan in {loan.terms} installments in the amounts reflected in the payment schedule below, beginning {firstDue}, and ending {lastDue}.</p>
        <p>b. Payments shall be made on or before the due dates indicated in the payment schedule.</p>
        <table className="w-full text-xs border border-slate-400 mt-2">
          <thead><tr className="bg-slate-100">
            <th className="border border-slate-400 px-2 py-1 text-left">#</th>
            <th className="border border-slate-400 px-2 py-1 text-left">Principal</th>
            <th className="border border-slate-400 px-2 py-1 text-left">Interest</th>
            <th className="border border-slate-400 px-2 py-1 text-left">Amount Due</th>
            <th className="border border-slate-400 px-2 py-1 text-left">Due Date</th>
          </tr></thead>
          <tbody>
            {sched.rows.map(r => (
              <tr key={r.period}>
                <td className="border border-slate-400 px-2 py-1">{r.period}</td>
                <td className="border border-slate-400 px-2 py-1">{fmt(r.principal)}</td>
                <td className="border border-slate-400 px-2 py-1">{fmt(r.interest)}</td>
                <td className="border border-slate-400 px-2 py-1">{fmt(r.total)}</td>
                <td className="border border-slate-400 px-2 py-1">{fmtDate(r.due)}</td>
              </tr>
            ))}
            <tr className="font-bold bg-slate-50">
              <td className="border border-slate-400 px-2 py-1">TOTAL</td>
              <td className="border border-slate-400 px-2 py-1">{fmt(loan.amount)}</td>
              <td className="border border-slate-400 px-2 py-1">{fmt(sched.totalInterest)}</td>
              <td className="border border-slate-400 px-2 py-1">{fmt(totalRepay)}</td>
              <td className="border border-slate-400 px-2 py-1"></td>
            </tr>
          </tbody>
        </table>

        <H>PREPAYMENT</H>
        <p>The Borrower may prepay the loan in whole or in part at any time without penalty. Any prepayment shall first be applied to accrued interest before principal.</p>

        <H>DEFAULT</H>
        <p>The Borrower shall be considered in default upon: (a) failure to pay any installment on its due date; (b) violation of any term of this Agreement; or (c) providing false or misleading information.</p>
        <p>Upon default, the entire outstanding balance, including accrued interest and penalties, shall become immediately due and demandable without need of further notice. The Lender may pursue legal remedies to recover the debt, including filing a collection case. All legal costs, attorney's fees, and collection expenses shall be borne by the Borrower.</p>

        <H>GOVERNING LAW</H>
        <p>The laws of the Republic of the Philippines will govern this Agreement, and its provisions will be enforced in accordance with the country's laws, including those related to small claims procedures.</p>

        <H>GUARANTOR (JOINT AND SOLIDARY LIABILITY)</H>
        <p>For value received, the undersigned Guarantor hereby binds himself/herself jointly and severally with the Borrower for the full and prompt payment of all obligations under this Agreement. The liability is direct and immediate; the Lender is not required to exhaust remedies against the Borrower before proceeding against the Guarantor; and this guarantee remains valid until full payment of the loan.</p>
        <p>Guarantor: <b>{f.guarantorName || "_____"}</b> — {f.guarantorAddress || "_____"} — Gov't ID No. {f.guarantorId || "_____"}</p>

        <H>ACKNOWLEDGMENT</H>
        <p>By signing below, the Parties acknowledge that they have read, understood, and voluntarily agreed to all terms and conditions of this Agreement.</p>

        <div className="grid grid-cols-2 gap-6 pt-8">
          <Sig src={f.sigLender} name={f.lenderName} role="Lender" />
          <Sig src={f.sigBorrower} name={loan.borrower} role="Borrower" />
        </div>
        <div className="grid grid-cols-2 gap-6 pt-6">
          <Sig src={f.sigGuarantor} name={f.guarantorName} role="Guarantor" />
          <div></div>
        </div>

        <p className="pt-6">Signed in the presence of:</p>
        <div className="grid grid-cols-2 gap-6 pt-2">
          <Sig src={f.sigWitness1} name={f.witness1} role="Witness 1" />
          <Sig src={f.sigWitness2} name={f.witness2} role="Witness 2" />
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function App() {
  const [db, setDb] = useState(() => loadDb());
  const [tab, setTab] = useState("new");
  const [currency, setCurrency] = useState("PHP");
  const [toast, setToast] = useState("");
  const [agreementLoanId, setAgreementLoanId] = useState(null);

  // Calc inputs
  const [name, setName] = useState("");
  const [amount, setAmount] = useState(10000);
  const [terms, setTerms] = useState(6);
  const [flatRate, setFlatRate] = useState(3.6);
  const [frequency, setFrequency] = useState("Semi-Monthly");
  const [startDate, setStartDate] = useState(today());
  const [dropRate, setDropRate] = useState(3.6);
  const [editId, setEditId] = useState(null);

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

  const resetForm = () => { setEditId(null); setName(""); setAmount(10000); setTerms(6); setFlatRate(3.6); setFrequency("Semi-Monthly"); setStartDate(today()); setDropRate(3.6); };

  const editLoan = l => {
    setEditId(l.id);
    setName(l.borrower);
    setAmount(l.amount);
    setTerms(l.terms);
    setFlatRate(l.flatRate);
    setDropRate(l.dropRate != null ? l.dropRate : l.flatRate);
    setFrequency(l.frequency);
    setStartDate(l.startDate);
    setTab("new");
  };

  const saveLoan = () => {
    const borrower = name.trim();
    const amt = Number(amount), trm = Math.floor(Number(terms)), rate = Number(flatRate), drop = Number(dropRate);
    if (!borrower) { flash("Enter the borrower's name."); return; }
    if (!(amt > 0)) { flash("Amount must be greater than 0."); return; }
    if (!(trm > 0)) { flash("Terms must be greater than 0."); return; }
    if (trm > 120) { flash("Terms looks too high (max 120)."); return; }
    if (rate < 0 || drop < 0) { flash("Rates can't be negative."); return; }
    if (!startDate) { flash("Pick a start date."); return; }
    const hasActive = db.loans.some(l => l.id !== editId && l.borrower.toLowerCase() === borrower.toLowerCase() && computeStatus(l, db.payments).overallStatus !== "FULLY PAID");
    if (hasActive) { flash(`${borrower} already has an active loan.`); return; }
    if (editId) {
      const loans = db.loans.map(l => l.id === editId ? { ...l, borrower, amount: amt, terms: trm, flatRate: rate, dropRate: drop, frequency, startDate } : l);
      persist({ ...db, loans });
      flash(`Updated ${editId} — ${borrower}`);
    } else {
      const nums = db.loans.map(l => parseInt(l.id.split("-")[1], 10)).filter(x => !isNaN(x));
      const id = "OL-" + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
      const loan = { id, borrower, amount: amt, terms: trm, flatRate: rate, dropRate: drop, frequency, startDate, createdAt: Date.now() };
      persist({ ...db, loans: [...db.loans, loan] });
      flash(`Saved ${id} — ${borrower}`);
    }
    resetForm();
    setTab("records");
  };

  const deleteLoan = id => {
    if (!confirm(`Delete loan ${id}? This also removes all its payments.`)) return;
    persist({ loans: db.loans.filter(l => l.id !== id), payments: db.payments.filter(p => p.loanId !== id) });
    flash(`Deleted ${id}`);
  };

  const borrowers = useMemo(() => [...new Set(db.loans.map(l => l.borrower))], [db.loans]);

  const portfolio = useMemo(() => {
    const td = parseDate(today());
    return db.loans.reduce((acc, l) => {
      const s = computeStatus(l, db.payments);
      acc.principal += Number(l.amount);
      acc.outstanding += s.grandLeft;
      acc.collected += s.totalLogged;
      if (s.overallStatus !== "FULLY PAID") acc.active++;
      if (s.rows.some(r => r.status !== "PAID" && r.due < td)) acc.overdue++;
      return acc;
    }, { principal: 0, outstanding: 0, collected: 0, active: 0, overdue: 0 });
  }, [db.loans, db.payments]);

  const agreementLoan = useMemo(() => db.loans.find(l => l.id === agreementLoanId), [db.loans, agreementLoanId]);
  const saveAgreement = data => {
    persist({ ...db, loans: db.loans.map(l => l.id === agreementLoanId ? { ...l, agreement: data } : l) });
    flash("Agreement saved.");
  };

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
    if (!payDate) { flash("Pick a payment date."); return; }
    if (payDate < resolved.loan.startDate) { flash("Payment date is before the loan start."); return; }
    const p = { id: Date.now(), loanId: resolved.loan.id, date: payDate, amount: Number(payAmount), type: payType };
    persist({ ...db, payments: [...db.payments, p] });
    setPayAmount("");
    const over = statusData ? Number(payAmount) - statusData.grandLeft : 0;
    if (over > 0.005) flash(`⚠ Logged ${fmt(p.amount)} — exceeds balance by ${fmt(over)}`);
    else flash(`Logged ${fmt(p.amount)}`);
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
          <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center font-bold text-sm">OLC</div>
          <div>
            <p className="font-bold text-sm leading-tight">JAVILAT LENDING CORPORATION</p>
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
            <p className="font-bold text-slate-700">{editId ? `Edit Loan · ${editId}` : "Loan Details"}</p>
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
              <button onClick={saveLoan} className="flex-1 py-3 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white font-semibold text-sm">{editId ? "Update Loan" : "Save Loan"}</button>
              <button onClick={resetForm} className="px-4 py-3 rounded-xl border border-slate-300 text-slate-600 text-sm font-medium">{editId ? "Cancel" : "Reset"}</button>
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
            {db.loans.length > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Outstanding" value={fmt(portfolio.outstanding)} tone="amber" />
                <Stat label="Collected" value={fmt(portfolio.collected)} tone="emerald" />
                <Stat label="Active Loans" value={portfolio.active} tone="teal" />
                <Stat label="Overdue Loans" value={portfolio.overdue} tone={portfolio.overdue > 0 ? "red" : "slate"} />
              </div>
            )}
            {db.loans.length === 0 && <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-slate-400">No loans yet.</div>}
            {db.loans.map(l => {
              const s = computeStatus(l, db.payments);
              const isOverdue = s.rows.some(r => r.status !== "PAID" && r.due < parseDate(today()));
              return (
                <div key={l.id} className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-emerald-600 font-semibold">{l.id}</p>
                      <p className="font-bold">{l.borrower}</p>
                      <p className="text-xs text-slate-500">{l.terms} terms · {l.flatRate}% · {l.frequency} · {fmtDate(parseDate(l.startDate))}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {isOverdue && <Badge s="OVERDUE" />}
                      <Badge s={s.overallStatus} />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="bg-slate-50 rounded-lg p-2"><p className="text-slate-400">Amount</p><p className="font-bold">{fmt(l.amount)}</p></div>
                    <div className="bg-emerald-50 rounded-lg p-2"><p className="text-slate-400">Paid</p><p className="font-bold text-emerald-700">{fmt(s.totalLogged)}</p></div>
                    <div className="bg-amber-50 rounded-lg p-2"><p className="text-slate-400">Balance</p><p className="font-bold text-amber-700">{fmt(s.grandLeft)}</p></div>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => { setLoanIdOvr(l.id); setSelBorrower(""); setTab("status"); }} className="flex-1 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold">View Payments</button>
                    {s.overallStatus !== "FULLY PAID" && <button onClick={() => editLoan(l)} className="px-4 py-2 rounded-xl border border-slate-300 text-slate-600 text-xs font-semibold">Edit</button>}
                    <button onClick={() => deleteLoan(l.id)} className="px-4 py-2 rounded-xl border border-red-200 text-red-500 text-xs font-semibold">Delete</button>
                  </div>
                  <button onClick={() => { setAgreementLoanId(l.id); setTab("agreement"); }} className="w-full py-2 rounded-xl border border-emerald-300 text-emerald-700 text-xs font-semibold">📄 Loan Agreement</button>
                </div>
              );
            })}
          </div>
        )}

        {/* ── STATUS ── */}
        {tab === "status" && (<>
          <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3 shadow-sm">
            <p className="font-bold text-slate-700">Find Loan</p>
            <div className="grid grid-cols-2 gap-3">
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

           

           

            {/* Schedule */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <p className="px-4 py-3 font-bold text-slate-700 border-b border-slate-100">Schedule & Status</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="bg-slate-100 text-slate-500">
                    {["#","Principal","Interest","Total","Due","Status","Left"].map(h => <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {statusData.rows.map((r, i) => {
                      const overdue = r.status !== "PAID" && r.due < parseDate(today());
                      return (
                      <tr key={i} className={overdue ? "bg-red-100" : r.isExt ? "bg-amber-50" : i % 2 ? "bg-slate-50" : "bg-white"}>
                        <td className="px-3 py-2 font-medium">{r.period}</td>
                        <td className="px-3 py-2 text-teal-700">{fmt(r.principal)}</td>
                        <td className="px-3 py-2 text-amber-600">{fmt(r.interest)}</td>
                        <td className="px-3 py-2 font-semibold">{fmt(r.total)}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-slate-500">{fmtDate(r.due)}</td>
                        <td className="px-3 py-2"><Badge s={r.status} /></td>
                        <td className="px-3 py-2">{fmt(r.amtLeft)}</td>
                      </tr>
                      );
                    })}
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

             <div className="grid grid-cols-2 gap-3">
              <Stat label="Total Interest" value={fmt(statusData.summedInterest)} tone="amber" />
              <Stat label="Total Due" value={fmt(resolved.loan.amount + statusData.summedInterest)} tone="slate" />
              <Stat label="Total Paid" value={fmt(statusData.totalLogged)} tone="emerald" />
              <Stat label="Balance Left" value={fmt(statusData.grandLeft)} tone="teal" />
            </div>
          </>)}
        </>)}

        {/* ── LOAN AGREEMENT ── */}
        {tab === "agreement" && (agreementLoan
          ? <AgreementView loan={agreementLoan} fmt={fmt} onBack={() => setTab("records")} onSave={saveAgreement} />
          : <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400 text-sm">Loan not found. <button onClick={() => setTab("records")} className="text-emerald-600 font-semibold underline">Back to records</button></div>)}
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