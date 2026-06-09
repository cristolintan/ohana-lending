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
  const empty = { loans: [], payments: [], transactions: [], settings: {} };
  try { const v = localStorage.getItem(LS_KEY); return v ? { ...empty, ...JSON.parse(v) } : empty; }
  catch { return empty; }
}
function saveDb(db) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch (e) { console.error(e); }
}

// ─── Supabase data layer ──────────────────────────────────────────────────────
const SUPABASE_URL = "https://hjlibhrxyfipsajcywzj.supabase.co";
const SUPABASE_KEY = "sb_publishable_6mSMEHYq3OrTl-sXlys_IQ_IDtmiFBo"; // publishable — safe with RLS
const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Ensure an (anonymous) session exists so RLS policies (auth.uid()) resolve.
async function ensureSession() {
  if (!sb) throw new Error("Supabase library not loaded.");
  const { data } = await sb.auth.getSession();
  if (!data.session) { const { error } = await sb.auth.signInAnonymously(); if (error) throw error; }
}

// Row → app-shape mappers (snake_case DB ↔ camelCase app)
const rowToLoan = r => ({ id: r.id, ref: r.ref, borrower: r.borrower, amount: +r.amount, terms: r.terms,
  flatRate: +r.flat_rate, dropRate: +r.drop_rate, frequency: r.frequency, startDate: r.start_date, createdAt: r.created_at });
const rowToPay = r => ({ id: r.id, loanId: r.loan_id, date: r.date, amount: +r.amount, type: r.type });
const rowToTx  = r => ({ id: r.id, date: r.date, kind: r.kind, direction: r.direction, amount: +r.amount, note: r.note || "" });

// Async CRUD — the React layer will use these instead of loadDb/saveDb.
const api = {
  async fetchAll() {
    const [L, P, T, A, S] = await Promise.all([
      sb.from("loans").select("*").order("ref"),
      sb.from("payments").select("*"),
      sb.from("transactions").select("*"),
      sb.from("agreements").select("*"),
      sb.from("settings").select("*").limit(1).maybeSingle(),
    ]);
    for (const r of [L, P, T, A, S]) if (r.error) throw r.error;
    const ag = Object.fromEntries((A.data || []).map(a => [a.loan_id, a.data]));
    return {
      loans: (L.data || []).map(r => ({ ...rowToLoan(r), agreement: ag[r.id] })),
      payments: (P.data || []).map(rowToPay),
      transactions: (T.data || []).map(rowToTx),
      settings: { openingBalance: +((S.data && S.data.opening_balance) || 0) },
    };
  },
  async createLoan(l) {
    const { data, error } = await sb.from("loans").insert({ ref: l.ref, borrower: l.borrower, amount: l.amount,
      terms: l.terms, flat_rate: l.flatRate, drop_rate: l.dropRate, frequency: l.frequency, start_date: l.startDate }).select().single();
    if (error) throw error; return rowToLoan(data);
  },
  async updateLoan(id, l) {
    const { error } = await sb.from("loans").update({ borrower: l.borrower, amount: l.amount, terms: l.terms,
      flat_rate: l.flatRate, drop_rate: l.dropRate, frequency: l.frequency, start_date: l.startDate }).eq("id", id);
    if (error) throw error;
  },
  async deleteLoan(id) { const { error } = await sb.from("loans").delete().eq("id", id); if (error) throw error; },
  async addPayment(p) { const { error } = await sb.from("payments").insert({ loan_id: p.loanId, date: p.date, amount: p.amount, type: p.type }); if (error) throw error; },
  async delPayment(id) { const { error } = await sb.from("payments").delete().eq("id", id); if (error) throw error; },
  async addTx(t) { const { error } = await sb.from("transactions").insert({ date: t.date, kind: t.kind, direction: t.direction, amount: t.amount, note: t.note }); if (error) throw error; },
  async delTx(id) { const { error } = await sb.from("transactions").delete().eq("id", id); if (error) throw error; },
  async saveAgreement(loanId, data) { const { error } = await sb.from("agreements").upsert({ loan_id: loanId, data, updated_at: new Date() }, { onConflict: "loan_id" }); if (error) throw error; },
  async setOpening(v) {
    // Singleton shared settings row: update the existing one, else create it.
    const { data: existing } = await sb.from("settings").select("user_id").limit(1).maybeSingle();
    if (existing) {
      const { error } = await sb.from("settings").update({ opening_balance: v }).eq("user_id", existing.user_id);
      if (error) throw error;
    } else {
      const { data: u } = await sb.auth.getUser();
      const { error } = await sb.from("settings").upsert({ user_id: u.user.id, opening_balance: v });
      if (error) throw error;
    }
  },
};

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

// ─── Cash flow helpers ─────────────────────────────────────────────────────────
// Inclusive [start, end] YYYY-MM-DD bounds for a date-range preset (local time).
function rangeBounds(preset) {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const now = new Date(), end = iso(now);
  if (preset === "month") return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), end];
  if (preset === "30d") { const s = new Date(now); s.setDate(s.getDate() - 29); return [iso(s), end]; }
  if (preset === "year") return [iso(new Date(now.getFullYear(), 0, 1)), end];
  return ["0000-01-01", "9999-12-31"]; // all time
}

// Realized interest recognized for a loan from payments up to a cutoff date.
// Allocates payments across the amortization schedule (oldest first) and sums
// the interest share of each covered installment.
function realizedInterestUpTo(loan, allPayments, cutoff, inclusive) {
  const pays = allPayments.filter(p => p.loanId === loan.id && (inclusive ? p.date <= cutoff : p.date < cutoff));
  const st = computeStatus(loan, pays);
  let left = st.totalLogged, interest = 0;
  for (const r of st.rows) {
    if (left <= 1e-9) break;
    const applied = Math.min(left, r.total);
    if (r.total > 0) interest += applied * (r.interest / r.total);
    left -= applied;
  }
  return interest;
}

// Manual cash-entry categories and their natural direction.
const TX_TYPES = [
  ["Capital Injection", "in"],
  ["Penalty / Late Fee", "in"],
  ["Processing Fee", "in"],
  ["Other Income", "in"],
  ["Operating Expense", "out"],
  ["Withdrawal", "out"],
  ["Other Expense", "out"]
];
const txDir = cat => { const f = TX_TYPES.find(t => t[0] === cat); return f ? f[1] : "in"; };

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
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2 whitespace-nowrap animate-slide-up">
      <span className="text-emerald-400">✓</span> {msg}
    </div>
  );
}

// ─── Lightweight inline-SVG charts (no dependency, print- and offline-friendly) ─
function MiniBars({ data, fmt }) {
  if (!data.length) return <div className="p-6 text-center text-slate-400 text-sm">No data to chart.</div>;
  const max = Math.max(1, ...data.map(d => Math.max(d.inflow + (d.projIn || 0), d.outflow)));
  const groupW = 52, barW = 18, gap = 6, h = 130, pad = 6, labelH = 22;
  const W = data.length * groupW;
  return (
    <div className="overflow-x-auto px-4 pb-3">
      <svg width={W} height={h + labelH} className="block">
        {data.map((d, i) => {
          const gx = i * groupW + (groupW - (barW * 2 + gap)) / 2;
          const inH = (d.inflow / max) * h, projH = ((d.projIn || 0) / max) * h, outH = (d.outflow / max) * h;
          return (
            <g key={d.key}>
              {inH > 0 && <rect x={gx} y={pad + h - inH} width={barW} height={inH} rx="2" fill="#10b981"><title>{d.label} · In {fmt(d.inflow)}</title></rect>}
              {projH > 0 && <rect x={gx} y={pad + h - inH - projH} width={barW} height={projH} rx="2" fill="#6ee7b7"><title>{d.label} · Projected {fmt(d.projIn)}</title></rect>}
              {outH > 0 && <rect x={gx + barW + gap} y={pad + h - outH} width={barW} height={outH} rx="2" fill="#fbbf24"><title>{d.label} · Out {fmt(d.outflow)}</title></rect>}
              <text x={i * groupW + groupW / 2} y={h + labelH - 6} textAnchor="middle" fontSize="9" fill={d.projected ? "#cbd5e1" : "#94a3b8"}>{d.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function MiniLine({ data, fmt }) {
  if (!data.length) return <div className="p-6 text-center text-slate-400 text-sm">No data to chart.</div>;
  const W = 320, H = 140, pad = 10;
  const vals = data.map(d => d.netBalance);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals), range = (max - min) || 1;
  const n = data.length;
  const X = i => n === 1 ? W / 2 : pad + (i / (n - 1)) * (W - 2 * pad);
  const Y = v => pad + (1 - (v - min) / range) * (H - 2 * pad);
  const C = data.map((d, i) => ({ x: X(i), y: Y(d.netBalance), projected: d.projected, label: d.label, val: d.netBalance }));
  const fp = C.findIndex(c => c.projected);
  const solidC = fp === -1 ? C : C.slice(0, fp);
  const dashC = fp === -1 ? [] : C.slice(Math.max(0, fp - 1));
  const pts = arr => arr.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = `${C[0].x.toFixed(1)},${(H - pad).toFixed(1)} ${pts(C)} ${C[n - 1].x.toFixed(1)},${(H - pad).toFixed(1)}`;
  const zeroY = Y(0);
  return (
    <div className="px-4 pb-3 pt-2">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" className="block">
        <polygon points={area} fill="#10b98122" />
        {min < 0 && <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 3" />}
        {solidC.length > 1 && <polyline points={pts(solidC)} fill="none" stroke="#059669" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {dashC.length > 1 && <polyline points={pts(dashC)} fill="none" stroke="#059669" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />}
        {C.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r="2.5" fill={c.projected ? "#6ee7b7" : "#059669"}><title>{c.label}: {fmt(c.val)}</title></circle>
        ))}
      </svg>
      <div className="flex justify-between text-[10px] text-slate-400 mt-1">
        <span>{data[0].label}</span>
        <span>{data[n - 1].label}</span>
      </div>
    </div>
  );
}

// ─── Signature capture (draw in a popup or upload an image) ───────────────────
function SignatureModal({ label, initial, onCancel, onSave }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const hasInk = useRef(!!initial);

  useEffect(() => {
    const c = canvasRef.current, ctx = c.getContext("2d");
    ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0f172a";
    if (initial) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, c.width, c.height); img.src = initial; }
  }, []);

  const pos = e => {
    const c = canvasRef.current, r = c.getBoundingClientRect();
    const t = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * (c.width / r.width), y: (t.clientY - r.top) * (c.height / r.height) };
  };
  const start = e => { e.preventDefault(); drawing.current = true; last.current = pos(e); };
  const move = e => {
    if (!drawing.current) return; e.preventDefault();
    const ctx = canvasRef.current.getContext("2d"), p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last.current = p; hasInk.current = true;
  };
  const end = () => { drawing.current = false; };
  const clear = () => { const c = canvasRef.current; c.getContext("2d").clearRect(0, 0, c.width, c.height); hasInk.current = false; };

  return (
    <div className="no-print fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-4 space-y-3 animate-scale-in">
        <p className="font-bold text-slate-700">{label}</p>
        <canvas ref={canvasRef} width={600} height={250}
          className="w-full rounded-xl border border-slate-300 bg-white touch-none cursor-crosshair"
          style={{ height: "40vh" }}
          onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
          onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
        <div className="flex gap-2">
          <button onClick={clear} className="px-4 py-2 rounded-xl border border-slate-300 text-slate-600 text-sm font-semibold">Clear</button>
          <button onClick={onCancel} className="px-4 py-2 rounded-xl border border-slate-300 text-slate-600 text-sm font-semibold ml-auto">Cancel</button>
          <button onClick={() => onSave(hasInk.current ? canvasRef.current.toDataURL("image/png") : "")} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold">Save</button>
        </div>
      </div>
    </div>
  );
}

function SignatureField({ label, value, onChange }) {
  const [open, setOpen] = useState(false);
  const fileRef = useRef(null);

  const onFile = e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 600 / img.width);
        const cw = Math.round(img.width * scale), ch = Math.round(img.height * scale);
        const cnv = document.createElement("canvas");
        cnv.width = cw; cnv.height = ch;
        cnv.getContext("2d").drawImage(img, 0, 0, cw, ch);
        onChange(cnv.toDataURL("image/png"));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className={labelCls}>{label}</label>
        {value && <button type="button" onClick={() => onChange("")} className="text-xs text-red-400 font-semibold">Remove</button>}
      </div>
      <div className="flex items-stretch gap-3">
        <div className="flex-1 h-20 rounded-xl border border-slate-300 bg-white flex items-center justify-center overflow-hidden">
          {value ? <img src={value} alt="" className="max-h-20" /> : <span className="text-xs text-slate-300">No signature</span>}
        </div>
        <div className="flex flex-col gap-2 justify-center">
          <button type="button" onClick={() => setOpen(true)} className="px-3 py-1.5 rounded-lg bg-slate-800 text-white text-xs font-semibold">✍ Draw</button>
          <button type="button" onClick={() => fileRef.current && fileRef.current.click()} className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs font-semibold">⬆ Upload</button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
        </div>
      </div>
      {open && <SignatureModal label={label} initial={value} onCancel={() => setOpen(false)} onSave={d => { onChange(d); setOpen(false); }} />}
    </div>
  );
}

// ─── Loan Agreement (fill-in form + signatures + printable document) ──────────
function AgreementView({ loan, fmt, onBack, onSave }) {
  const [f, setF] = useState(() => ({
    lenderName: "Liezel Anne Davalos",
    lenderAddress: "",
    lenderId: "",
    borrowerAddress: "", borrowerId: "", purpose: "",
    guarantorName: "", guarantorAddress: "", guarantorId: "",
    witness1: "", witness2: "", agreementDate: today(),
    sigLender: "", sigBorrower: "", sigGuarantor: "", sigWitness1: "", sigWitness2: "",
    ...(loan.agreement || {})
  }));
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  const [busy, setBusy] = useState(false);

  const exportPdf = async () => {
    const el = document.getElementById("agreement-print");
    if (!el) return;
    if (!window.html2canvas || !window.jspdf) { alert("PDF tools are still loading — connect to the internet once so they cache, then try again."); return; }
    setBusy(true);
    try {
      const canvas = await window.html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new window.jspdf.jsPDF("p", "mm", "a4");
      const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight();
      const imgW = pageW, imgH = canvas.height * imgW / canvas.width;
      let heightLeft = imgH, position = 0;
      pdf.addImage(imgData, "PNG", 0, position, imgW, imgH);
      heightLeft -= pageH;
      while (heightLeft > 0) {
        position -= pageH;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, position, imgW, imgH);
        heightLeft -= pageH;
      }
      pdf.save(`Loan Agreement - ${loan.borrower} (${loan.ref || loan.id}).pdf`);
    } catch (err) {
      console.error(err);
      alert("Could not generate the PDF. Try the Print button instead.");
    } finally {
      setBusy(false);
    }
  };

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
      <div className="no-print flex flex-wrap items-center gap-2">
        <button onClick={onBack} className="px-3 py-2 rounded-xl border border-slate-300 text-slate-600 text-sm font-semibold">← Back</button>
        <div className="flex gap-2 ml-auto">
          <button onClick={() => onSave(f)} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold">Save</button>
          <button onClick={() => window.print()} className="px-4 py-2 rounded-xl border border-slate-300 text-slate-600 text-sm font-semibold">Print</button>
          <button onClick={exportPdf} disabled={busy} className="px-4 py-2 rounded-xl bg-slate-800 text-white text-sm font-semibold disabled:opacity-50">{busy ? "Generating…" : "Download PDF"}</button>
        </div>
      </div>

      <div className="no-print bg-white rounded-2xl border border-slate-200 p-4 space-y-3 shadow-sm">
        <p className="font-bold text-slate-700">Agreement Details · {loan.ref || loan.id}</p>
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
        <p className="text-xs text-slate-400 -mt-2">Tap Draw to sign in a popup, or Upload an image — saved with the agreement.</p>
        <SignatureField label="Lender Signature" value={f.sigLender} onChange={v => set("sigLender", v)} />
        <SignatureField label="Borrower Signature" value={f.sigBorrower} onChange={v => set("sigBorrower", v)} />
        <SignatureField label="Guarantor Signature" value={f.sigGuarantor} onChange={v => set("sigGuarantor", v)} />
        <SignatureField label="Witness 1 Signature" value={f.sigWitness1} onChange={v => set("sigWitness1", v)} />
        <SignatureField label="Witness 2 Signature" value={f.sigWitness2} onChange={v => set("sigWitness2", v)} />
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
  const [db, setDb] = useState({ loans: [], payments: [], transactions: [], settings: {} });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("new");
  const [currency, setCurrency] = useState("PHP");
  const [toast, setToast] = useState("");
  const [agreementLoanId, setAgreementLoanId] = useState(null);
  const [recordFilter, setRecordFilter] = useState("active");
  const [cfRange, setCfRange] = useState("all");
  const [cfDir, setCfDir] = useState("all");
  const [cfProjected, setCfProjected] = useState(false);
  const [txDate, setTxDate] = useState(today());
  const [txCat, setTxCat] = useState("Capital Injection");
  const [txAmount, setTxAmount] = useState("");
  const [txNote, setTxNote] = useState("");
  const [openingInput, setOpeningInput] = useState(() => String((db.settings && db.settings.openingBalance) || ""));

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

  const flash = msg => { setToast(msg); setTimeout(() => setToast(""), 2500); };
  const refresh = useCallback(async () => { const data = await api.fetchAll(); setDb(data); return data; }, []);

  // Initial load: ensure a (silent anonymous) session for the DB role, then fetch
  // the shared data. Records are visible to every device; user_id is still stamped
  // server-side so per-user accounts can be switched on later.
  useEffect(() => {
    if (!sb) { setLoading(false); flash("Supabase failed to load."); return; }
    (async () => {
      try { await ensureSession(); const data = await refresh(); setOpeningInput(String(data.settings.openingBalance || "")); }
      catch (e) { console.error(e); flash("Could not connect to the database."); }
      finally { setLoading(false); }
    })();
  }, [refresh]);

  const sym = currency === "PHP" ? "₱" : "$";
  const fmt = v => sym + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const calc = useMemo(() => computeCalc({ amount, terms, flatRate, frequency, startDate, dropRate }), [amount, terms, flatRate, frequency, startDate, dropRate]);

  const resetForm = () => { setEditId(null); setName(""); setAmount(10000); setTerms(6); setFlatRate(3.6); setFrequency("Semi-Monthly"); setStartDate(today()); setDropRate(3.6); };

  const exportSchedulePng = async () => {
    const el = document.getElementById("projected-export");
    if (!el || !window.html2canvas) { flash("Image tools not ready — reload once online."); return; }
    try {
      const canvas = await window.html2canvas(el, { scale: 2, backgroundColor: "#ffffff", ignoreElements: n => n.classList && n.classList.contains("no-capture") });
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `Schedule - ${name.trim() || "loan"}.png`;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { console.error(e); flash("Could not export image."); }
  };

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

  const saveLoan = async () => {
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
    try {
      if (editId) {
        await api.updateLoan(editId, { borrower, amount: amt, terms: trm, flatRate: rate, dropRate: drop, frequency, startDate });
        flash(`Updated — ${borrower}`);
      } else {
        const nums = db.loans.map(l => parseInt((l.ref || "").split("-")[1], 10)).filter(x => !isNaN(x));
        const ref = "OL-" + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(4, "0");
        await api.createLoan({ ref, borrower, amount: amt, terms: trm, flatRate: rate, dropRate: drop, frequency, startDate });
        flash(`Saved ${ref} — ${borrower}`);
      }
      await refresh();
      resetForm();
      setTab("records");
    } catch (e) { console.error(e); flash("Save failed — check connection."); }
  };

  const deleteLoan = async (id, ref) => {
    if (!confirm(`Delete loan ${ref || id}? This also removes all its payments.`)) return;
    try { await api.deleteLoan(id); await refresh(); flash(`Deleted ${ref || ""}`.trim()); }
    catch (e) { console.error(e); flash("Delete failed — check connection."); }
  };

  // One-time migration of any pre-Supabase localStorage data into the cloud.
  const localBackup = (() => { try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; } })();
  const canImport = !localStorage.getItem("ohana_pwa_db_migrated") && (localBackup.loans || []).length > 0;
  const importLocal = async () => {
    const loans = localBackup.loans || [];
    if (!confirm(`Import ${loans.length} loan(s) and their payments from this device into the cloud?`)) return;
    try {
      await ensureSession();
      const idMap = {};
      for (const l of loans) {
        const created = await api.createLoan({ ref: l.id, borrower: l.borrower, amount: l.amount, terms: l.terms,
          flatRate: l.flatRate, dropRate: l.dropRate != null ? l.dropRate : l.flatRate, frequency: l.frequency, startDate: l.startDate });
        idMap[l.id] = created.id;
        if (l.agreement) await api.saveAgreement(created.id, l.agreement);
      }
      for (const p of (localBackup.payments || [])) if (idMap[p.loanId]) await api.addPayment({ loanId: idMap[p.loanId], date: p.date, amount: p.amount, type: p.type });
      for (const t of (localBackup.transactions || [])) await api.addTx({ date: t.date, kind: t.kind, direction: t.direction, amount: t.amount, note: t.note });
      if (localBackup.settings && localBackup.settings.openingBalance) await api.setOpening(localBackup.settings.openingBalance);
      localStorage.setItem("ohana_pwa_db_migrated", "1");
      await refresh();
      flash(`Imported ${loans.length} loan(s).`);
    } catch (e) { console.error(e); flash("Import failed — check connection."); }
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

  const filteredLoans = useMemo(() =>
    db.loans
      .map(l => ({ l, s: computeStatus(l, db.payments) }))
      .filter(({ s }) =>
        recordFilter === "all" ? true
        : recordFilter === "paid" ? s.overallStatus === "FULLY PAID"
        : s.overallStatus === "ACTIVE BALANCE"),
  [db.loans, db.payments, recordFilter]);

  const cashflow = useMemo(() => {
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const monthLabel = key => { const [y, m] = key.split("-"); return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-US", { month: "short" }) + " " + y.slice(2); };
    const [start, end] = rangeBounds(cfRange);
    const opening = Number(db.settings && db.settings.openingBalance) || 0;
    const todayStr = iso(new Date()), curMonth = todayStr.slice(0, 7);

    // Actual cash events: disbursements (out), collections (in), manual entries (in/out).
    const disb = db.loans.map(l => ({ id: "D-" + l.id, date: l.startDate, kind: "Disbursement", subtype: "", loanId: l.id, ref: l.ref, borrower: l.borrower, inflow: 0, outflow: Number(l.amount) || 0 }));
    const coll = db.payments.map(p => {
      const loan = db.loans.find(l => l.id === p.loanId);
      return { id: "P-" + p.id, date: p.date, kind: "Collection", subtype: p.type || "", loanId: p.loanId, ref: loan ? loan.ref : "", borrower: loan ? loan.borrower : "—", inflow: Number(p.amount) || 0, outflow: 0 };
    });
    const manual = (db.transactions || []).map(t => ({
      id: "M-" + t.id, date: t.date, kind: t.kind, subtype: "", note: t.note, loanId: null, borrower: "",
      inflow: t.direction === "in" ? Number(t.amount) || 0 : 0, outflow: t.direction === "out" ? Number(t.amount) || 0 : 0
    }));
    const actual = [...disb, ...coll, ...manual].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    let bal = opening;
    actual.forEach(t => { bal += t.inflow - t.outflow; t.balance = bal; });
    const inRange = actual.filter(t => t.date >= start && t.date <= end);

    // Projected upcoming dues (only when toggled on), continuing the running balance.
    const projected = [];
    if (cfProjected) {
      db.loans.forEach(l => {
        computeStatus(l, db.payments).rows.forEach((r, idx) => {
          const dueISO = iso(r.due);
          if (dueISO >= todayStr && r.status !== "PAID" && r.amtLeft > 0.005)
            projected.push({ id: `X-${l.id}-${idx}`, date: dueISO, kind: "Scheduled Due", subtype: "", loanId: l.id, ref: l.ref, borrower: l.borrower, inflow: r.amtLeft, outflow: 0, projected: true });
        });
      });
      projected.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
      let pbal = bal;
      projected.forEach(t => { pbal += t.inflow; t.balance = pbal; });
    }

    // KPIs (actuals in range).
    const collected = inRange.filter(t => t.kind === "Collection").reduce((s, t) => s + t.inflow, 0);
    const disbursed = inRange.filter(t => t.kind === "Disbursement").reduce((s, t) => s + t.outflow, 0);
    const net = inRange.reduce((s, t) => s + t.inflow - t.outflow, 0);
    const interest = db.loans.reduce((sum, l) =>
      sum + realizedInterestUpTo(l, db.payments, end, true) - realizedInterestUpTo(l, db.payments, start, false), 0);
    const expected = projected.reduce((s, t) => s + t.inflow, 0);

    // Ledger (newest first), respecting the direction filter.
    const ledger = [...inRange, ...projected]
      .filter(t => cfDir === "all" ? true : cfDir === "in" ? t.inflow > 0 : t.outflow > 0)
      .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

    // Monthly buckets for the charts.
    const mMap = {};
    [...inRange, ...projected].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0).forEach(t => {
      const key = t.date.slice(0, 7);
      if (!mMap[key]) mMap[key] = { key, label: monthLabel(key), inflow: 0, outflow: 0, projIn: 0, netBalance: t.balance, projected: key > curMonth };
      if (t.projected) mMap[key].projIn += t.inflow;
      else { mMap[key].inflow += t.inflow; mMap[key].outflow += t.outflow; }
      mMap[key].netBalance = t.balance;
    });
    const months = Object.values(mMap).sort((a, b) => a.key < b.key ? -1 : 1);

    // Per-transaction running-balance series for the position line (a "Start"
    // carry-in point keeps the line meaningful even within a single month).
    const hist = [...inRange, ...projected].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const series = [];
    if (hist.length) {
      const f = hist[0];
      series.push({ netBalance: f.balance - (f.inflow - f.outflow), label: "Start", projected: false });
      hist.forEach(t => series.push({ netBalance: t.balance, label: fmtDate(parseDate(t.date)), projected: !!t.projected }));
    }

    return { collected, disbursed, net, interest, expected, expectedCount: projected.length, ledger, months, series, opening, balance: bal };
  }, [db.loans, db.payments, db.transactions, db.settings, cfRange, cfDir, cfProjected]);

  const exportCsv = () => {
    const esc = v => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ["Date", "Type", "Detail", "Loan ID", "Borrower", "Inflow", "Outflow", "Balance"];
    const rows = cashflow.ledger.slice().reverse().map(t =>
      [t.date, t.kind, t.subtype, t.ref || "", t.borrower, t.inflow, t.outflow, t.balance].map(esc).join(","));
    const csv = [header.join(","), ...rows].join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `cash-flow-${cfRange}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    flash("Exported CSV");
  };

  const addTransaction = async () => {
    const amt = Number(txAmount);
    if (!(amt > 0)) { flash("Enter an amount greater than 0."); return; }
    if (!txDate) { flash("Pick a date."); return; }
    try {
      await api.addTx({ date: txDate, kind: txCat, direction: txDir(txCat), amount: amt, note: txNote.trim() });
      await refresh();
      setTxAmount(""); setTxNote("");
      flash("Entry added.");
    } catch (e) { console.error(e); flash("Save failed — check connection."); }
  };
  const deleteTransaction = async id => { try { await api.delTx(id); await refresh(); } catch (e) { console.error(e); flash("Delete failed."); } };
  const commitOpening = async () => { try { await api.setOpening(Number(openingInput) || 0); await refresh(); } catch (e) { console.error(e); flash("Could not save opening balance."); } };

  const agreementLoan = useMemo(() => db.loans.find(l => l.id === agreementLoanId), [db.loans, agreementLoanId]);
  const saveAgreement = async data => {
    try { await api.saveAgreement(agreementLoanId, data); await refresh(); flash("Agreement saved."); }
    catch (e) { console.error(e); flash("Could not save agreement — check connection."); }
  };

  const resolved = useMemo(() => {
    if (loanIdOvr.trim()) {
      const q = loanIdOvr.trim();
      const loan = db.loans.find(l => l.id === q || (l.ref && l.ref.toLowerCase() === q.toLowerCase()));
      return loan ? { loan } : { error: "Loan not found." };
    }
    if (selBorrower) {
      const active = db.loans.filter(l => l.borrower === selBorrower).find(l => computeStatus(l, db.payments).overallStatus !== "FULLY PAID");
      return active ? { loan: active } : { error: "No active loan for this borrower." };
    }
    return { prompt: true };
  }, [db, selBorrower, loanIdOvr]);

  const statusData = useMemo(() => resolved.loan ? computeStatus(resolved.loan, db.payments) : null, [resolved, db.payments]);

  const addPayment = async () => {
    if (!resolved.loan) return;
    const amt = Number(payAmount);
    if (!(amt > 0)) { flash("Enter a payment amount."); return; }
    if (!payDate) { flash("Pick a payment date."); return; }
    if (payDate < resolved.loan.startDate) { flash("Payment date is before the loan start."); return; }
    try {
      await api.addPayment({ loanId: resolved.loan.id, date: payDate, amount: amt, type: payType });
      await refresh();
      setPayAmount("");
      const over = statusData ? amt - statusData.grandLeft : 0;
      if (over > 0.005) flash(`⚠ Logged ${fmt(amt)} — exceeds balance by ${fmt(over)}`);
      else flash(`Logged ${fmt(amt)}`);
    } catch (e) { console.error(e); flash("Save failed — check connection."); }
  };
  const deletePayment = async id => { try { await api.delPayment(id); await refresh(); } catch (e) { console.error(e); flash("Delete failed."); } };

  const loanPayments = resolved.loan ? db.payments.filter(p => p.loanId === resolved.loan.id).sort((a, b) => a.date < b.date ? -1 : 1) : [];

  // Reset scroll to top whenever the tab changes (better mobile flow)
  const mainRef = useRef(null);
  useEffect(() => { if (mainRef.current) mainRef.current.scrollTop = 0; }, [tab]);
  // Keep Lucide icons rendered across tab switches / re-renders
  useEffect(() => { if (window.lucide) lucide.createIcons(); });

  // ── Bottom nav ──
  const navItems = [
    { id: "new",     label: "New Loan",  icon: "calculator" },
    { id: "records", label: "Records",   icon: "file-text" },
    { id: "status",  label: "Payments & Status",  icon: "wallet" },
    { id: "cashflow", label: "Cash Flow", icon: "trending-up" },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 font-sans">
      {/* Header */}
      <header className="bg-emerald-700 text-white px-4 py-3 flex items-center justify-between shadow-md sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center font-bold text-sm">OLC</div>
          <div>
            <p className="font-bold text-sm leading-tight">JAVILAT LENDING CORPORATION</p>
            <p className="text-emerald-200 text-xs">{loading ? "Connecting…" : `☁ ${db.loans.length} loans`}</p>
          </div>
        </div>
        <select className="px-2.5 py-1.5 rounded-lg text-slate-800 text-sm bg-white" value={currency} onChange={e => setCurrency(e.target.value)}>
          <option value="PHP">₱ Peso</option>
          <option value="USD">$ Dollar</option>
        </select>
      </header>

      {/* Body */}
      <main ref={mainRef} className="flex-1 overflow-y-auto scroll-ios px-4 py-4 pb-24 space-y-4">
        <div key={tab} className="space-y-4 animate-fade-in">

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
                <input type="number" inputMode="decimal" className={inputCls} value={amount} onChange={e => setAmount(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Terms</label>
                <input type="number" inputMode="numeric" className={inputCls} value={terms} onChange={e => setTerms(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Flat Rate %</label>
                <input type="number" inputMode="decimal" step="0.1" className={inputCls} value={flatRate} onChange={e => setFlatRate(e.target.value)} />
              </div>
              <div>
              <label className={labelCls}>Frequency</label>
              <select className={inputCls} value={frequency} onChange={e => setFrequency(e.target.value)}>
                <option>Semi-Monthly</option><option>Monthly</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Start Date</label>
              <input type="date" className={inputCls} value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            </div>

            <div>
              <label className={labelCls}>Decline Rate — <span className="text-emerald-600 font-bold">{Number(dropRate || 0).toFixed(1)}%</span></label>
              <input type="range" min="0" max="10" step="0.1" value={dropRate} onChange={e => setDropRate(e.target.value)} className="w-full accent-emerald-600 cursor-pointer" />
              <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>0%</span><span>5%</span><span>10%</span></div>
            </div>

            

            <div className="flex gap-2 pt-1">
              <button onClick={saveLoan} className="flex-1 py-3 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white font-semibold text-sm transition">{editId ? "Update Loan" : "Save Loan"}</button>
              <button onClick={resetForm} className="px-4 py-3 rounded-xl border border-slate-300 active:bg-slate-100 text-slate-600 text-sm font-medium transition">{editId ? "Cancel" : "Reset"}</button>
            </div>
          </div>

          

          {calc.rows.length > 0 && (
            <div id="projected-export" className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
                <div>
                  <p className="font-bold text-slate-700">Projected Schedule</p>
                  <p className="text-xs text-slate-500">{name.trim() || "Unnamed"}</p>
                </div>
                <button onClick={exportSchedulePng} className="no-capture px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs font-semibold active:bg-slate-100 transition">⬇ Export Table</button>
              </div>
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

          <div className="grid grid-cols-2 gap-3">
            <Stat label="Loan Amount" value={fmt(amount)} tone="slate" />
            <Stat label="Total Interest" value={fmt(calc.totalInterest)} tone="amber" />
            <Stat label="Total Repayment" value={fmt(calc.totalRepay)} tone="emerald" />
            <Stat label="Periods" value={calc.rows.length} tone="teal" />
          </div>
          
        </>)}

        {/* ── RECORDS ── */}
        {tab === "records" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-bold text-slate-700">{db.loans.length} Loan{db.loans.length !== 1 ? "s" : ""}</p>
              <button onClick={() => setTab("new")} className="px-3.5 py-2 rounded-lg bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold transition">+ New</button>
            </div>
            {canImport && <button onClick={importLocal} className="w-full py-2 rounded-xl border border-amber-300 bg-amber-50 text-amber-700 text-xs font-semibold active:bg-amber-100 transition">⤓ Import {localBackup.loans.length} loan(s) saved on this device</button>}
            {db.loans.length > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Outstanding" value={fmt(portfolio.outstanding)} tone="amber" />
                <Stat label="Collected" value={fmt(portfolio.collected)} tone="emerald" />
                <Stat label="Active Loans" value={portfolio.active} tone="teal" />
                <Stat label="Overdue Loans" value={portfolio.overdue} tone={portfolio.overdue > 0 ? "red" : "slate"} />
              </div>
            )}
            {db.loans.length > 0 && (
              <div className="flex gap-2">
                {[["active", "Active"], ["all", "All"], ["paid", "Fully Paid"]].map(([k, lbl]) => (
                  <button key={k} onClick={() => setRecordFilter(k)} className={`flex-1 py-2 rounded-xl text-xs font-semibold transition ${recordFilter === k ? "bg-emerald-600 text-white shadow-sm" : "bg-white border border-slate-200 text-slate-500 active:bg-slate-100"}`}>
                    {lbl} ({k === "all" ? db.loans.length : k === "active" ? portfolio.active : db.loans.length - portfolio.active})
                  </button>
                ))}
              </div>
            )}
            {db.loans.length === 0 && (
              <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center space-y-3">
                <p className="text-slate-400 text-sm">No loans yet.</p>
                <button onClick={() => setTab("new")} className="px-4 py-2.5 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold transition">+ Create your first loan</button>
              </div>
            )}
            {db.loans.length > 0 && filteredLoans.length === 0 && (
              <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400 text-sm">No {recordFilter === "paid" ? "fully paid" : recordFilter === "active" ? "active" : ""} loans to show.</div>
            )}
            {filteredLoans.map(({ l, s }, i) => {
              const isOverdue = s.rows.some(r => r.status !== "PAID" && r.due < parseDate(today()));
              return (
                <div key={l.id} style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }} className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm space-y-2 animate-fade-up">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs text-emerald-600 font-semibold">{l.ref || l.id}</p>
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
                    <button onClick={() => { setLoanIdOvr(l.id); setSelBorrower(""); setTab("status"); }} className="flex-1 py-2.5 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold transition">View Payments</button>
                    {s.overallStatus !== "FULLY PAID" && <button onClick={() => editLoan(l)} className="px-4 py-2.5 rounded-xl border border-slate-300 active:bg-slate-100 text-slate-600 text-sm font-semibold transition">Edit</button>}
                    <button onClick={() => deleteLoan(l.id, l.ref)} className="px-4 py-2.5 rounded-xl border border-red-200 active:bg-red-50 text-red-500 text-sm font-semibold transition">Delete</button>
                  </div>
                  <button onClick={() => { setAgreementLoanId(l.id); setTab("agreement"); }} className="w-full py-2.5 rounded-xl border border-emerald-300 active:bg-emerald-50 text-emerald-700 text-sm font-semibold transition">📄 Loan Agreement</button>
                </div>
              );
            })}
          </div>
        )}

        {/* ── STATUS ── */}
        {tab === "status" && (<>
          <div className="bg-white rounded-2xl border border-slate-200 p-4 grid grid-cols-2 gap-3 shadow-sm">
            <p className="col-span-2 font-bold text-slate-700">Find Loan</p>
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
                <p className="text-xs text-emerald-600 font-semibold">{resolved.loan.ref || resolved.loan.id}</p>
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

             {/* Log Payment */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3 shadow-sm">
              <p className="font-bold text-slate-700">Log a Payment</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Amount</label>
                  <input type="number" inputMode="decimal" className={inputCls} value={payAmount} onChange={e => setPayAmount(e.target.value)} placeholder="0.00" />
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
                      <button onClick={() => deletePayment(p.id)} className="text-red-400 pl-2 text-base leading-none">×</button>
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

        {/* ── CASH FLOW ── */}
        {tab === "cashflow" && (<>
          <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3 shadow-sm">
            <p className="font-bold text-slate-700">Cash Flow</p>
            <div className="flex gap-2">
              {[["all", "All"], ["month", "This Month"], ["30d", "30 Days"], ["year", "This Year"]].map(([k, lbl]) => (
                <button key={k} onClick={() => setCfRange(k)} className={`flex-1 py-2 rounded-xl text-xs font-semibold transition ${cfRange === k ? "bg-emerald-600 text-white shadow-sm" : "bg-white border border-slate-200 text-slate-500 active:bg-slate-100"}`}>{lbl}</button>
              ))}
            </div>
            <div className="flex gap-2">
              {[["all", "All"], ["in", "Inflow"], ["out", "Outflow"]].map(([k, lbl]) => (
                <button key={k} onClick={() => setCfDir(k)} className={`flex-1 py-2 rounded-xl text-xs font-semibold transition ${cfDir === k ? "bg-slate-800 text-white shadow-sm" : "bg-white border border-slate-200 text-slate-500 active:bg-slate-100"}`}>{lbl}</button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide flex-1">Opening Balance</label>
              <input type="number" inputMode="decimal" value={openingInput} onChange={e => setOpeningInput(e.target.value)} onBlur={commitOpening} placeholder="0.00" className="w-32 px-3 py-2 rounded-xl border border-slate-300 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 outline-none text-sm text-right text-slate-800 bg-white" />
            </div>
            <button onClick={() => setCfProjected(v => !v)} className={`w-full py-2 rounded-xl text-xs font-semibold transition ${cfProjected ? "bg-emerald-600 text-white shadow-sm" : "bg-white border border-slate-200 text-slate-500 active:bg-slate-100"}`}>{cfProjected ? "✓ Showing projected dues" : "Show projected dues"}</button>
            {cfProjected && <p className="text-xs text-slate-400">Expected upcoming: <span className="font-semibold text-emerald-700">{fmt(cashflow.expected)}</span> across {cashflow.expectedCount} due{cashflow.expectedCount !== 1 ? "s" : ""}.</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Stat label="Total Collected" value={fmt(cashflow.collected)} tone="emerald" />
            <Stat label="Capital Disbursed" value={fmt(cashflow.disbursed)} tone="amber" />
            <Stat label="Net Cash Flow" value={fmt(cashflow.net)} tone={cashflow.net >= 0 ? "teal" : "red"} />
            <Stat label="Interest Earned" value={fmt(cashflow.interest)} tone="emerald" />
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <p className="font-bold text-slate-700">Inflow vs Outflow</p>
              <div className="flex gap-3 text-xs text-slate-500">
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#10b981" }} />In</span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#fbbf24" }} />Out</span>
              </div>
            </div>
            <MiniBars data={cashflow.months} fmt={fmt} />
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <p className="font-bold text-slate-700">Net Cash Position</p>
              <span className={`font-bold text-sm ${cashflow.balance < 0 ? "text-red-600" : "text-emerald-700"}`}>{fmt(cashflow.balance)}</span>
            </div>
            <MiniLine data={cashflow.series} fmt={fmt} />
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3 shadow-sm">
            <p className="font-bold text-slate-700">Other Cash Entries</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Category</label>
                <select className={inputCls} value={txCat} onChange={e => setTxCat(e.target.value)}>
                  {TX_TYPES.map(([k]) => <option key={k}>{k}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Amount</label>
                <input type="number" inputMode="decimal" className={inputCls} value={txAmount} onChange={e => setTxAmount(e.target.value)} placeholder="0.00" />
              </div>
              <div>
                <label className={labelCls}>Date</label>
                <input type="date" className={inputCls} value={txDate} onChange={e => setTxDate(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Note</label>
                <input className={inputCls} value={txNote} onChange={e => setTxNote(e.target.value)} placeholder="Optional" />
              </div>
            </div>
            <p className="text-xs text-slate-400">{txDir(txCat) === "in" ? "↑ Adds to cash (inflow)" : "↓ Reduces cash (outflow)"}</p>
            <button onClick={addTransaction} className="w-full py-2.5 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold transition">Add Entry</button>
            {(db.transactions || []).filter(t => { const [s, e] = rangeBounds(cfRange); return t.date >= s && t.date <= e; }).sort((a, b) => a.date < b.date ? 1 : -1).map(t => (
              <div key={t.id} className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2 text-xs">
                <div className="min-w-0">
                  <span className={`font-semibold ${t.direction === "in" ? "text-emerald-700" : "text-amber-700"}`}>{t.direction === "in" ? "+" : "−"}{fmt(t.amount)}</span>
                  <span className="text-slate-500"> · {t.kind}{t.note ? ` · ${t.note}` : ""}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-slate-400">{fmtDate(parseDate(t.date))}</span>
                  <button onClick={() => deleteTransaction(t.id)} className="text-red-400 text-base leading-none">×</button>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <p className="font-bold text-slate-700">Ledger</p>
              {cashflow.ledger.length > 0 && <button onClick={exportCsv} className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 text-xs font-semibold active:bg-slate-100 transition">⬇ CSV</button>}
            </div>
            {cashflow.ledger.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">No cash flow activity in this range.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="bg-slate-100 text-slate-500">
                    {["Date", "Details", "In", "Out", "Balance"].map(h => <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {cashflow.ledger.map(t => (
                      <tr key={t.id} onClick={() => { if (t.loanId) { setLoanIdOvr(t.loanId); setSelBorrower(""); setTab("status"); } }} className={`border-t border-slate-100 ${t.loanId ? "active:bg-slate-50 cursor-pointer" : ""} ${t.projected ? "opacity-60" : ""}`}>
                        <td className="px-3 py-2 whitespace-nowrap text-slate-500">{fmtDate(parseDate(t.date))}</td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-700 flex items-center gap-1">
                            {t.kind}{t.kind === "Collection" && t.subtype ? ` · ${t.subtype}` : ""}
                            {t.projected && <span className="px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-500 text-[10px] font-semibold">Projected</span>}
                          </div>
                          <div className="text-slate-400">{t.loanId ? `${t.ref || ""} · ${t.borrower}` : (t.note || "Manual entry")}</div>
                        </td>
                        <td className="px-3 py-2 text-emerald-700 whitespace-nowrap">{t.inflow ? fmt(t.inflow) : "—"}</td>
                        <td className="px-3 py-2 text-amber-700 whitespace-nowrap">{t.outflow ? fmt(t.outflow) : "—"}</td>
                        <td className={`px-3 py-2 font-semibold whitespace-nowrap ${t.balance < 0 ? "text-red-600" : "text-slate-700"}`}>{fmt(t.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>)}

        {/* ── LOAN AGREEMENT ── */}
        {tab === "agreement" && (agreementLoan
          ? <AgreementView loan={agreementLoan} fmt={fmt} onBack={() => setTab("records")} onSave={saveAgreement} />
          : <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400 text-sm">Loan not found. <button onClick={() => setTab("records")} className="text-emerald-600 font-semibold underline">Back to records</button></div>)}
        </div>
      </main>

      {/* Bottom Tab Bar (iOS-style) */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur border-t border-slate-200 flex z-20" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {navItems.map(({ id, label, icon }) => (
          <button key={id} onClick={() => setTab(id)} className={`flex-1 flex flex-col items-center py-3 gap-0.5 text-xs font-medium transition-colors active:bg-slate-100 ${tab === id ? "text-emerald-600" : "text-slate-400"}`}>
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