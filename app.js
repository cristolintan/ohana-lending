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
// Local-time YYYY-MM-DD. Deliberately not toISOString(), which converts to UTC:
// east of Greenwich that hands back *yesterday* for the whole early morning, so
// an entry recorded at 7am got stamped with the previous day — and on the 1st of
// a month it landed in the previous month and vanished from the current view.
// Every due-date comparison in this app is local, so this must be too.
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => isoDay(new Date());
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
const firstName = email => { const s = (email || "").split("@")[0].split(/[._\-0-9]/)[0]; return s ? s[0].toUpperCase() + s.slice(1) : ""; };
const buzz = (ms = 12) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} };

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

// ─── Offline snapshot ─────────────────────────────────────────────────────────
// Last known-good server state, kept so a cold launch with no signal still shows
// real loans, dues and schedules instead of an empty shell. Heavy blobs (ID
// photos, agreement forms) are stripped: they'd blow past the localStorage quota
// and aren't needed for collections work in the field.
// A signed-out / not-yet-loaded database. Frozen so the shared reference can't
// be mutated into a surprise default for the next user.
const EMPTY_DB = Object.freeze({ loans: [], payments: [], transactions: [], queue: [], settings: {} });

// Keyed per user: a device can be shared, and records belong to one user only,
// so a snapshot must never be readable by whoever signs in next.
const SNAP_PREFIX = "ohana_snapshot_v1";
const LEGACY_SNAP_KEY = SNAP_PREFIX;      // pre-per-user, shared by every account
const snapKey = uid => `${SNAP_PREFIX}_${uid}`;

// The old shared snapshot may hold another user's loans — drop it once, on load.
try { localStorage.removeItem(LEGACY_SNAP_KEY); } catch {}

function loadSnapshot(uid) {
  if (!uid) return null;
  try { const v = localStorage.getItem(snapKey(uid)); return v ? JSON.parse(v) : null; }
  catch { return null; }
}
function clearSnapshot(uid) {
  try { if (uid) localStorage.removeItem(snapKey(uid)); } catch {}
}
function saveSnapshot(uid, db) {
  if (!uid) return;
  try {
    localStorage.setItem(snapKey(uid), JSON.stringify({
      ...db,
      loans: (db.loans || []).map(({ idImage, agreement, ...l }) => l),
      savedAt: new Date().toISOString(),
    }));
  } catch (e) { console.warn("snapshot skipped", e); }   // quota / private mode
}

// ─── Offline outbox (IndexedDB, localStorage fallback) ────────────────────────
// Writes made without a connection are queued here and replayed when the network
// comes back. Every queued row carries a client-generated UUID, so replaying an
// item that actually landed is a primary-key conflict (23505) rather than a
// duplicate payment — retries are safe by construction.
const OUTBOX_DB = "ohana-offline", OUTBOX_STORE = "outbox", OUTBOX_LS = "ohana_outbox_v1";
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    }));

function openOutbox() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error("no indexedDB"));
    const req = indexedDB.open(OUTBOX_DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(OUTBOX_STORE)) d.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const lsOutbox = {
  all() { try { return JSON.parse(localStorage.getItem(OUTBOX_LS) || "[]"); } catch { return []; } },
  write(list) { try { localStorage.setItem(OUTBOX_LS, JSON.stringify(list)); } catch {} },
};
const outbox = {
  async all() {
    try {
      const d = await openOutbox();
      return await new Promise((res, rej) => {
        const r = d.transaction(OUTBOX_STORE, "readonly").objectStore(OUTBOX_STORE).getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      });
    } catch { return lsOutbox.all(); }
  },
  async put(item) {
    try {
      const d = await openOutbox();
      await new Promise((res, rej) => {
        const tx = d.transaction(OUTBOX_STORE, "readwrite");
        tx.objectStore(OUTBOX_STORE).put(item);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch {
      const list = lsOutbox.all().filter(i => i.id !== item.id);
      lsOutbox.write([...list, item]);
    }
    return item;
  },
  async remove(id) {
    try {
      const d = await openOutbox();
      await new Promise((res, rej) => {
        const tx = d.transaction(OUTBOX_STORE, "readwrite");
        tx.objectStore(OUTBOX_STORE).delete(id);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch { lsOutbox.write(lsOutbox.all().filter(i => i.id !== id)); }
  },
};

// Ask the browser to replay the queue in the background (Chromium/Android).
// Safari has no Background Sync — those devices flush on "online" / next launch.
async function requestOutboxSync() {
  try {
    if (!("serviceWorker" in navigator) || !("SyncManager" in window)) return;
    const reg = await navigator.serviceWorker.ready;
    await reg.sync.register("ohana-outbox");
  } catch (e) { console.warn("sync register failed", e); }
}

// "The request never reached the server" — as opposed to a rejection (RLS,
// validation) that replaying would only repeat.
const isNetworkError = e =>
  !navigator.onLine ||
  (e && (e.name === "TypeError" || /failed to fetch|networkerror|network request failed|load failed/i.test(String(e.message || ""))));

// ─── Supabase data layer ──────────────────────────────────────────────────────
const SUPABASE_URL = "https://hjlibhrxyfipsajcywzj.supabase.co";
const SUPABASE_KEY = "sb_publishable_6mSMEHYq3OrTl-sXlys_IQ_IDtmiFBo"; // publishable — safe with RLS
const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Web Push: the VAPID *public* key is safe to ship in client code. The matching
// private key lives ONLY in the Supabase Edge Function secrets.
const VAPID_PUBLIC_KEY = "BFyZTv3Cc5p6EKOG-68__FVzZHzApu09UxQrrrLR6vDB7srZFgUNYSwKHPk-QULfN-TIN22xKLWQ3G2QKdvqqks";
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Ensure an (anonymous) session exists so RLS policies (auth.uid()) resolve.
async function ensureSession() {
  if (!sb) throw new Error("Supabase library not loaded.");
  const { data } = await sb.auth.getSession();
  if (!data.session) { const { error } = await sb.auth.signInAnonymously(); if (error) throw error; }
}

// Row → app-shape mappers (snake_case DB ↔ camelCase app)
const rowToLoan = r => ({ id: r.id, ref: r.ref, borrower: r.borrower, amount: +r.amount, terms: r.terms,
  flatRate: +r.flat_rate, dropRate: +r.drop_rate, frequency: r.frequency, startDate: r.start_date, createdAt: r.created_at, freqChange: r.freq_change || null, idImage: r.id_image || null });
const rowToPay = r => ({ id: r.id, loanId: r.loan_id, date: r.date, amount: +r.amount, type: r.type });
const rowToTx  = r => ({ id: r.id, date: r.date, kind: r.kind, direction: r.direction, amount: +r.amount, note: r.note || "" });
const rowToQueue = r => ({ id: r.id, borrower: r.borrower, amount: +r.amount, date: r.queue_date, note: r.note || "", status: r.status, createdAt: r.created_at });

// Async CRUD — the React layer will use these instead of loadDb/saveDb.
// Our own user id, from the locally cached session — no network round trip.
async function myUid() {
  const { data } = await sb.auth.getSession();
  return data?.session?.user?.id || null;
}

const api = {
  async fetchAll() {
    // settings is per-user config, not a record to oversee: an admin sees every
    // user's row, so this must be pinned to our own or maybeSingle() throws on
    // the second user's row and the admin's app fails to load.
    const uid = await myUid();
    if (!uid) throw new Error("Not signed in.");
    const [L, P, T, A, S, Q] = await Promise.all([
      sb.from("loans").select("*").order("ref"),
      sb.from("payments").select("*"),
      sb.from("transactions").select("*"),
      sb.from("agreements").select("*"),
      sb.from("settings").select("*").eq("user_id", uid).maybeSingle(),
      sb.from("queue").select("*"),
    ]);
    for (const r of [L, P, T, A, S, Q]) if (r.error) throw r.error;
    const ag = Object.fromEntries((A.data || []).map(a => [a.loan_id, a.data]));
    return {
      loans: (L.data || []).map(r => ({ ...rowToLoan(r), agreement: ag[r.id] })),
      payments: (P.data || []).map(rowToPay),
      transactions: (T.data || []).map(rowToTx),
      queue: (Q.data || []).map(rowToQueue),
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
  async setFreqChange(id, fc) { const { error } = await sb.from("loans").update({ freq_change: fc }).eq("id", id); if (error) throw error; },
  async setIdImage(id, dataUrl) { const { error } = await sb.from("loans").update({ id_image: dataUrl }).eq("id", id); if (error) throw error; },
  // Insert with a client-supplied id: a replayed offline payment collides on the
  // primary key (23505) instead of creating a second row.
  async addPayment(p) {
    const { error } = await sb.from("payments").insert({ id: p.id || uuid(), loan_id: p.loanId, date: p.date, amount: p.amount, type: p.type });
    if (error && error.code !== "23505") throw error;
  },
  async delPayment(id) { const { error } = await sb.from("payments").delete().eq("id", id); if (error) throw error; },
  async addTx(t) {
    const { error } = await sb.from("transactions").insert({ id: t.id || uuid(), date: t.date, kind: t.kind, direction: t.direction, amount: t.amount, note: t.note });
    if (error && error.code !== "23505") throw error;
  },
  async delTx(id) { const { error } = await sb.from("transactions").delete().eq("id", id); if (error) throw error; },
  async savePush(sub) {
    const j = sub.toJSON();
    const { error } = await sb.from("push_subscriptions")
      .upsert({ endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
    if (error) throw error;
  },
  async deletePush(endpoint) { const { error } = await sb.from("push_subscriptions").delete().eq("endpoint", endpoint); if (error) throw error; },
  // Fire an internal staff alert via the send-push Edge Function (never blocks the caller).
  async notify(payload) { try { await sb.functions.invoke("send-push", { body: payload }); } catch (e) { console.error("notify failed", e); } },
  async addQueue(q) {
    const { error } = await sb.from("queue").insert({ id: q.id || uuid(), borrower: q.borrower, amount: q.amount, queue_date: q.date, note: q.note });
    if (error && error.code !== "23505") throw error;
  },
  // Replay one queued write. Kinds map 1:1 to the api methods above.
  async applyQueued(item) {
    if (item.kind === "payment") return api.addPayment(item.payload);
    if (item.kind === "tx") return api.addTx(item.payload);
    if (item.kind === "queue") return api.addQueue(item.payload);
    throw new Error(`unknown outbox kind: ${item.kind}`);
  },
  async setQueueStatus(id, status) { const { error } = await sb.from("queue").update({ status }).eq("id", id); if (error) throw error; },
  async delQueue(id) { const { error } = await sb.from("queue").delete().eq("id", id); if (error) throw error; },
  async saveAgreement(loanId, data) { const { error } = await sb.from("agreements").upsert({ loan_id: loanId, data, updated_at: new Date() }, { onConflict: "loan_id" }); if (error) throw error; },
  async setOpening(v) {
    // One settings row per user (user_id is the primary key), so this is a
    // straight upsert on our own row — no lookup, and no chance of writing
    // over someone else's opening balance.
    const uid = await myUid();
    if (!uid) throw new Error("Not signed in.");
    const { error } = await sb.from("settings").upsert({ user_id: uid, opening_balance: v });
    if (error) throw error;
  },
};

// ─── Finance logic ───────────────────────────────────────────────────────────
// One installment measured in semi-monthly periods — the unit the flat rate is
// quoted in. Monthly spans two periods so it charges 2× the rate per payment;
// Weekly counts as half a period, so 2 weekly payments cost the same interest
// as 1 semi-monthly and 4 weekly the same as 1 monthly. Collecting more often
// doesn't change what the borrower pays in total.
const FREQUENCIES = ["Weekly", "Semi-Monthly", "Monthly"];
const FREQ_MULT = { Weekly: 0.5, "Semi-Monthly": 1, Monthly: 2 };
const freqMult = f => (FREQ_MULT[f] != null ? FREQ_MULT[f] : 1);

// Due date of installment #i (0-based) counted from `from`. Weekly lands every
// 7 days; semi-monthly alternates month-anniversary and +15 days.
function dueDate(frequency, from, i) {
  if (frequency === "Weekly") return addDays(from, i * 7);
  if (frequency === "Monthly") return edate(from, i);
  return i % 2 === 0 ? edate(from, i / 2) : addDays(edate(from, (i - 1) / 2), 15);
}

// Projected schedule for a brand-new (unpaid) loan, shown in the New Loan
// preview and the printed Loan Agreement. Delegates to the SAME engine the
// Payments tab uses (computeStatusBase with no payments) so the projection and
// the live status schedule always agree — one interest model, no drift.
function computeCalc({ amount, terms, flatRate, frequency, startDate, dropRate }) {
  const pAmt = Number(amount) || 0, n = Math.max(0, Math.floor(Number(terms) || 0));
  if (pAmt <= 0 || n <= 0) return { rows: [], totalInterest: 0, totalRepay: pAmt };
  const st = computeStatusBase(
    { amount: pAmt, terms: n, flatRate, frequency, startDate, dropRate: dropRate != null ? dropRate : flatRate },
    []
  );
  return { rows: st.rows, totalInterest: st.summedInterest, totalRepay: pAmt + st.summedInterest };
}

function computeStatusBase(loan, allPayments) {
  const pAmt = Number(loan.amount), terms = Math.floor(Number(loan.terms));
  const rate = Number(loan.flatRate) / 100;
  const totalInterest = pAmt * rate * terms * freqMult(loan.frequency);
  const drop = (loan.dropRate != null ? Number(loan.dropRate) : Number(loan.flatRate)) / 100;
  const intDrop = (pAmt * drop) / terms;
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
    // Spread the rounding remainder one centavo at a time. remCents goes
    // NEGATIVE when pAmt/terms rounds up (e.g. 10,000 / 24 → 416.67), and those
    // centavos have to be shaved rather than added — otherwise the principal
    // column sums to more than the loan amount. Weekly terms hit this often.
    const pPaid = isExt ? 0
      : remCents >= 0 ? (schedMonth <= remCents ? baseP + 0.01 : baseP)
      : (schedMonth <= -remCents ? round2(baseP - 0.01) : baseP);
    const ratio = (pAmt - prevRem) / pAmt;
    const tier = Math.min(terms, 1 + Math.round(ratio * terms));
    const intPaid = avgInterest + ((terms + 1) / 2 - tier) * intDrop;
    const totPay = pPaid + intPaid;
    const due = dueDate(loan.frequency, sd, step - 1);
    cumDue += totPay;
    const status = totalLogged >= cumDue ? "PAID" : totalLogged > cumDue - totPay ? "PARTIAL" : "UNPAID";
    const amtLeft = Math.max(0, totPay - Math.max(0, totalLogged - (cumDue - totPay)));
    rows.push({ period: isExt ? `${schedMonth} (Ext)` : String(schedMonth), remaining: prevRem, principal: pPaid, interest: intPaid, total: totPay, due, status, amtLeft, isExt });
  }
  const summedInterest = rows.reduce((s, r) => s + r.interest, 0);
  const summedTotal = rows.reduce((s, r) => s + r.total, 0);
  const grandLeft = Math.max(0, pAmt + summedInterest - totalLogged);
  return { rows, summedInterest, summedTotal, grandLeft, overallStatus: grandLeft <= 0.005 ? "FULLY PAID" : "ACTIVE BALANCE", totalLogged };
}

// Wraps the schedule engine. If the loan has a mid-stream frequency change
// ({date, frequency}), installments before that date are kept as-is and the
// remaining balance is re-spaced under the new frequency to the original end
// date — total principal & interest unchanged, interest still diminishing.
function computeStatus(loan, allPayments) {
  const base = computeStatusBase(loan, allPayments);
  const fc = loan.freqChange;
  if (!fc || !fc.date || (!fc.frequency && !fc.terms)) return base;
  const D = parseDate(fc.date), F1 = fc.frequency || loan.frequency;
  const kept = base.rows.filter(r => r.due < D);
  const after = base.rows.filter(r => !(r.due < D));
  if (!after.length) return base;                 // switch falls after the loan ends → no change
  const pAmt = Number(loan.amount), totalLogged = base.totalLogged, rate = Number(loan.flatRate) / 100;
  const remP = after.reduce((s, r) => s + r.principal, 0);
  const explicitTerms = fc.terms && Number(fc.terms) > 0;
  // New remaining installment count: explicit if given, else derived from the
  // frequency change keeping the original payoff date. (Semi-Monthly → Weekly
  // doubles the count, Monthly → Weekly quadruples it.)
  const n = explicitTerms
    ? Math.min(240, Math.floor(Number(fc.terms)))
    : Math.max(1, Math.round(after.length * freqMult(loan.frequency) / freqMult(F1)));
  // Changing the term re-prices interest on the remaining balance (more terms = more
  // interest). A frequency-only change keeps the original remaining interest.
  const remI = explicitTerms ? remP * rate * n * freqMult(F1) : after.reduce((s, r) => s + r.interest, 0);
  const drop = (loan.dropRate != null ? Number(loan.dropRate) : Number(loan.flatRate)) / 100;
  const avgI = remI / n, dropR = (remP * drop) / n;   // diminishing model, scaled to the remainder
  const rem = [];
  for (let i = 0; i < n; i++) {
    rem.push({
      principal: remP / n,
      interest: avgI + ((n + 1) / 2 - (i + 1)) * dropR,
      due: dueDate(F1, D, i),
      isSwitched: true,
    });
  }
  const combined = [
    ...kept.map(r => ({ principal: r.principal, interest: r.interest, due: r.due, isExt: r.isExt })),
    ...rem
  ];
  let prevRem = pAmt, cumDue = 0; const rows = [];
  combined.forEach((r, i) => {
    const remaining = prevRem, total = r.principal + r.interest;
    cumDue += total;
    const status = totalLogged >= cumDue ? "PAID" : totalLogged > cumDue - total ? "PARTIAL" : "UNPAID";
    const amtLeft = Math.max(0, total - Math.max(0, totalLogged - (cumDue - total)));
    rows.push({ period: r.isExt ? `${i + 1} (Ext)` : String(i + 1), remaining, principal: r.principal, interest: r.interest, total, due: r.due, status, amtLeft, isExt: !!r.isExt, switched: !!r.isSwitched });
    prevRem = remaining - r.principal;
  });
  // Totals are recomputed from the revised rows (a term change moves the interest).
  const summedInterest = rows.reduce((s, r) => s + r.interest, 0);
  const summedTotal = rows.reduce((s, r) => s + r.total, 0);
  const grandLeft = Math.max(0, pAmt + summedInterest - totalLogged);
  return { rows, summedInterest, summedTotal, grandLeft, overallStatus: grandLeft <= 0.005 ? "FULLY PAID" : "ACTIVE BALANCE", totalLogged };
}

// ─── Cash flow helpers ─────────────────────────────────────────────────────────
const monthKeyOf = d => isoDay(d).slice(0, 7);
// Inclusive [start, end] bounds for a calendar month key ("YYYY-MM").
function monthBounds(key) {
  const [y, m] = key.split("-").map(Number);
  return [`${key}-01`, `${key}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`];
}
const ALL_TIME = ["0000-01-01", "9999-12-31"];
const shiftMonth = (key, delta) => { const [y, m] = key.split("-").map(Number); return monthKeyOf(new Date(y, m - 1 + delta, 1)); };
const monthLabelLong = key => { const [y, m] = key.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }); };
const monthLabelShort = key => { const [y, m] = key.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short" }) + " " + String(y).slice(2); };
// "Today" / "Yesterday" / "Mon, Aug 18" — how a ledger day reads in a timeline.
function dayHeading(dateStr) {
  const t = new Date(); const y = new Date(); y.setDate(y.getDate() - 1);
  if (dateStr === isoDay(t)) return "Today";
  if (dateStr === isoDay(y)) return "Yesterday";
  const d = parseDate(dateStr);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    + (d.getFullYear() !== t.getFullYear() ? `, ${d.getFullYear()}` : "");
}

// How urgently a due date needs collecting, and how that reads to a lender.
// Drives both the dashboard's buckets and its row sub-lines, so the two can
// never disagree about what "this week" means.
const DUE_BUCKETS = [
  ["overdue", "Overdue"],
  ["today", "Due today"],
  ["week", "This week"],
  ["later", "Later"],
];
function dueUrgency(dateStr) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const days = Math.round((parseDate(dateStr) - d0) / 86400000);
  if (days < 0) return { bucket: "overdue", days, label: `${-days}d overdue` };
  if (days === 0) return { bucket: "today", days, label: "due today" };
  if (days === 1) return { bucket: "week", days, label: "due tomorrow" };
  if (days <= 7) return { bucket: "week", days, label: `in ${days} days` };
  return { bucket: "later", days, label: `in ${days} days` };
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

// How each cash movement is presented in the timeline. Every entry carries an
// icon and a word for its direction, so the +/− reading never depends on colour
// alone. `group` is what the filter sheet buckets by.
const TXN_META = {
  "Disbursement":       { label: "Loan released",      icon: "arrow-up-right",   group: "releases" },
  "Collection":         { label: "Payment collected",  icon: "arrow-down-left",  group: "collections" },
  "Scheduled Due":      { label: "Scheduled due",      icon: "calendar-clock",   group: "collections" },
  "Capital Injection":  { label: "Capital added",      icon: "piggy-bank",       group: "capital" },
  "Penalty / Late Fee": { label: "Late fee collected", icon: "alert-triangle",   group: "fees" },
  "Processing Fee":     { label: "Processing fee",     icon: "percent",          group: "fees" },
  "Other Income":       { label: "Other income",       icon: "coins",            group: "fees" },
  "Operating Expense":  { label: "Operating expense",  icon: "receipt",          group: "expenses" },
  "Withdrawal":         { label: "Withdrawal",         icon: "banknote",         group: "capital" },
  "Other Expense":      { label: "Other expense",      icon: "wallet",           group: "expenses" },
};
const txnMeta = kind => TXN_META[kind] || { label: kind || "Cash entry", icon: "wallet", group: "other" };

// Cash-flow filter buckets, in the order the sheet lists them.
const CF_GROUPS = [
  ["all", "All movements"],
  ["collections", "Collections"],
  ["releases", "Loan releases"],
  ["fees", "Fees & other income"],
  ["capital", "Capital & withdrawals"],
  ["expenses", "Expenses"],
];

// Principal recovered so far on a loan. Mirrors realizedInterestUpTo: payments
// are applied to the schedule oldest-first and each covered slice is split by
// that installment's principal/interest ratio. Read-only — it never feeds a
// balance the borrower sees, only the "money still tied up in loans" tile.
function principalRecovered(st) {
  let left = st.totalLogged, principal = 0;
  for (const r of st.rows) {
    if (left <= 1e-9) break;
    const applied = Math.min(left, r.total);
    if (r.total > 0) principal += applied * (r.principal / r.total);
    left -= applied;
  }
  return principal;
}

// ─── Tiny components ─────────────────────────────────────────────────────────
// Minimal design tokens — reused across every screen.
const inputCls = "w-full px-3.5 py-2.5 rounded-xl border border-slate-100 bg-white focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 outline-none text-slate-800 text-sm transition";
const labelCls = "block text-xs font-medium text-slate-500 mb-1.5";
const cardCls = "bg-white rounded-2xl border border-slate-100 shadow-sm";

// Clean stat tile: white card, muted label with a small accent dot, bold value.
// `tone` drives only the accent (dot + value color), not a full background fill.
function Stat({ label, value, tone = "slate", small, compact }) {
  const accent = {
    slate: "text-slate-800", amber: "text-amber-600", emerald: "text-emerald-600",
    teal: "text-teal-600", red: "text-red-600"
  };
  const dot = {
    slate: "bg-slate-300", amber: "bg-amber-400", emerald: "bg-emerald-500",
    teal: "bg-teal-500", red: "bg-red-500"
  };
  return (
    <div className={`${cardCls} ${compact ? "px-3.5 py-3" : "p-4"}`}>
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 truncate">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot[tone] || dot.slate}`} />
        {label}
      </p>
      <p className={`mt-1 font-bold tabular-nums leading-tight ${accent[tone] || accent.slate} ${compact || small ? "text-base" : "text-xl"}`}>{value}</p>
    </div>
  );
}

function Badge({ s }) {
  const map = {
    PAID: "bg-emerald-50 text-emerald-600",
    PARTIAL: "bg-amber-50 text-amber-600",
    UNPAID: "bg-slate-100 text-slate-500",
    OVERDUE: "bg-red-50 text-red-600",
    "FULLY PAID": "bg-emerald-50 text-emerald-600",
    "ACTIVE BALANCE": "bg-amber-50 text-amber-600"
  };
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${map[s] || "bg-slate-100 text-slate-500"}`}>{s}</span>;
}

// Colored initials avatar — deterministic color per borrower name.
function Avatar({ name, size = "w-9 h-9" }) {
  const palette = [
    "bg-emerald-100 text-emerald-700", "bg-amber-100 text-amber-700",
    "bg-sky-100 text-sky-700", "bg-rose-100 text-rose-700",
    "bg-violet-100 text-violet-700", "bg-teal-100 text-teal-700",
  ];
  const clean = (name || "?").trim();
  const initials = (clean.split(/\s+/).slice(0, 2).map(w => w[0]).join("") || "?").toUpperCase();
  let h = 0; for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
  return <div className={`${size} shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${palette[h % palette.length]}`}>{initials}</div>;
}

// Thin progress bar (e.g. % of a loan repaid, or queue funding progress).
function ProgressBar({ pct, tone = "emerald" }) {
  const bar = { emerald: "bg-emerald-500", amber: "bg-amber-400", red: "bg-red-500", sky: "bg-sky-500", slate: "bg-slate-300" };
  const w = Math.max(0, Math.min(100, Math.round((pct || 0) * 100)));
  return <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full rounded-full ${bar[tone] || bar.emerald} transition-all`} style={{ width: `${w}%` }} /></div>;
}

// Minimal SVG sparkline from a series of numbers (e.g. cash position over time).
function Sparkline({ values, color = "#10b981", className = "w-full h-5" }) {
  const v = (values || []).filter(n => typeof n === "number");
  if (v.length < 2) return null;
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const pts = v.map((n, i) => `${(i / (v.length - 1)) * 100},${21 - ((n - min) / span) * 19}`).join(" ");
  return (
    <svg viewBox="0 0 100 22" preserveAspectRatio="none" className={className} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2 whitespace-nowrap animate-slide-up">
      <span className="text-emerald-400">✓</span> {msg}
    </div>
  );
}

// ─── Cash-flow UI primitives ─────────────────────────────────────────────────
// Pill segmented control (period aggregation, ledger direction). One row, equal
// widths, 44px-tall targets — thumb-friendly and identical on every breakpoint.
function Segmented({ value, onChange, options, size = "sm" }) {
  return (
    <div className="flex gap-1 p-1 bg-slate-100 rounded-xl" role="tablist">
      {options.map(([k, lbl]) => (
        <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)}
          className={`flex-1 rounded-lg font-semibold transition ${size === "sm" ? "py-1.5 text-xs" : "py-2 text-sm"} ${
            value === k ? "bg-white text-emerald-700 shadow-sm" : "text-slate-500 active:bg-slate-200"}`}>{lbl}</button>
      ))}
    </div>
  );
}

// Section heading used by every cash-flow card, so each block announces what it
// is before the numbers land.
function CardHead({ title, hint, right }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-semibold text-slate-800 text-sm">{title}</p>
        {hint && <p className="text-xs text-slate-400 mt-0.5">{hint}</p>}
      </div>
      {right}
    </div>
  );
}

// One line of a Money In / Money Out breakdown.
function FlowLine({ label, value, muted }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className={`truncate ${muted ? "text-slate-300" : "text-slate-500"}`}>{label}</span>
      <span className={`tabular-nums shrink-0 ${muted ? "text-slate-300" : "text-slate-600 font-medium"}`}>{value}</span>
    </div>
  );
}

// Empty / no-data panel. Never a blank card — always says what would show here.
function EmptyPanel({ icon = "inbox", title, body, action, onAction }) {
  return (
    <div className="px-6 py-10 text-center">
      <div className="w-11 h-11 mx-auto rounded-full bg-slate-100 text-slate-400 flex items-center justify-center">
        <i data-lucide={icon} className="w-5 h-5"></i>
      </div>
      <p className="mt-3 font-semibold text-slate-700 text-sm">{title}</p>
      {body && <p className="mt-1 text-xs text-slate-400 max-w-xs mx-auto leading-relaxed">{body}</p>}
      {action && <button onClick={onAction} className="mt-4 px-4 py-2 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white text-xs font-semibold transition">{action}</button>}
    </div>
  );
}

// First-paint placeholder. Same shapes as the real cards, so nothing jumps when
// the data lands and no card ever flashes a zeroed amount. `tiles` is how many
// small stat cards sit under the hero; `chart` adds the tall plot block.
function ScreenSkeleton({ label, tiles = 2, chart = true }) {
  const bar = "bg-slate-100 rounded animate-pulse";
  return (
    <div className="space-y-4" aria-busy="true" aria-label={label}>
      <div className={`${cardCls} p-4 space-y-3`}>
        <div className={`${bar} h-4 w-28`} /><div className={`${bar} h-10 w-full`} />
      </div>
      <div className={`${cardCls} p-5 space-y-3`}>
        <div className={`${bar} h-3 w-24`} /><div className={`${bar} h-10 w-48`} /><div className={`${bar} h-3 w-36`} />
      </div>
      <div className={`grid gap-3 ${tiles === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
        {Array.from({ length: tiles }, (_, i) => (
          <div key={i} className={`${cardCls} p-4 space-y-2`}><div className={`${bar} h-3 w-16`} /><div className={`${bar} h-6 w-20`} /></div>
        ))}
      </div>
      {chart && (
        <div className={`${cardCls} p-4 space-y-3`}>
          <div className={`${bar} h-4 w-32`} /><div className={`${bar} h-32 w-full`} />
        </div>
      )}
      <div className={`${cardCls} p-4 space-y-3`}>
        <div className={`${bar} h-4 w-24`} />
        {[0, 1, 2, 3].map(i => <div key={i} className="flex items-center gap-3"><div className={`${bar} h-9 w-9 rounded-full`} /><div className="flex-1 space-y-1.5"><div className={`${bar} h-3 w-2/5`} /><div className={`${bar} h-2.5 w-1/4`} /></div><div className={`${bar} h-3 w-16`} /></div>)}
      </div>
    </div>
  );
}

// ─── Lightweight inline-SVG charts (no dependency, print- and offline-friendly) ─
// Cash In vs Cash Out. Money in grows up from a centre axis, money out grows
// down from it, so "am I collecting more than I'm releasing?" is answered by
// which side of the line is taller — no axis reading, no legend hunting.
// `data` is [{ key, label, inflow, outflow, projIn, projected }].
function FlowChart({ data, fmt }) {
  if (!data.length) return <EmptyPanel icon="bar-chart-3" title="Nothing to chart yet" body="Collections and loan releases in this period will plot here." />;
  const max = Math.max(1, ...data.map(d => Math.max(d.inflow + (d.projIn || 0), d.outflow)));
  const barW = data.length > 16 ? 8 : data.length > 8 ? 14 : 20;
  const groupW = barW * 2 + (data.length > 16 ? 8 : 16);
  const half = 62, labelH = 20, W = Math.max(data.length * groupW, 40), H = half * 2 + labelH;
  const h = v => (v <= 0 ? 0 : Math.max(2, (v / max) * (half - 6)));
  return (
    <div className="overflow-x-auto px-4 pb-3 pt-1">
      <svg width={W} height={H} className="block" role="img" aria-label="Cash in versus cash out">
        <line x1="0" y1={half} x2={W} y2={half} stroke="currentColor" className="text-slate-300" strokeWidth="1" />
        {data.map((d, i) => {
          const cx = i * groupW + groupW / 2;
          const inH = h(d.inflow), projH = h(d.projIn || 0), outH = h(d.outflow);
          return (
            <g key={d.key}>
              {inH > 0 && <rect x={cx - barW - 1} y={half - inH} width={barW} height={inH} rx="2" fill="#10b981"><title>{`${d.label} · in ${fmt(d.inflow)}`}</title></rect>}
              {projH > 0 && <rect x={cx - barW - 1} y={half - inH - projH} width={barW} height={projH} rx="2" fill="#6ee7b7" opacity="0.75"><title>{`${d.label} · expected ${fmt(d.projIn)}`}</title></rect>}
              {outH > 0 && <rect x={cx + 1} y={half} width={barW} height={outH} rx="2" fill="#f59e0b"><title>{`${d.label} · out ${fmt(d.outflow)}`}</title></rect>}
              <text x={cx} y={H - 6} textAnchor="middle" fontSize="9" fill={d.projected ? "#6a6a72" : "#94a3b8"}>{d.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Net Cash Position — TradingView Lightweight Charts v5 Baseline series.
// Baseline is the opening balance: cash above it fills green, below it fills red.
// Projected dues simply continue the same baseline line (no separate forecast series).
// Pan + zoom (drag, wheel, pinch) are enabled like a full exchange chart.
// `data` is [{ time:'YYYY-MM-DD', value, projected }] sorted asc.
function PositionChart({ data, fmt, baseline }) {
  const wrapRef = useRef(null);
  const tipRef = useRef(null);
  const chartRef = useRef(null);
  const baseRef = useRef(null);

  // Create the chart + series exactly once.
  useEffect(() => {
    const LWC = window.LightweightCharts;
    if (!LWC || !wrapRef.current) return;
    const chart = LWC.createChart(wrapRef.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#94a3b8", attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: "#26262c" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.18, bottom: 0.12 } },
      timeScale: { borderVisible: false, rightOffset: 4 },
      // handleScale / handleScroll left at their defaults → full pan + zoom.
      crosshair: {
        vertLine: { color: "#94a3b8", width: 1, style: LWC.LineStyle.Dashed, labelVisible: false },
        horzLine: { color: "#94a3b8", width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: "#475569" },
      },
      localization: { priceFormatter: p => fmt(p) },
    });
    const base = chart.addSeries(LWC.BaselineSeries, {
      baseValue: { type: "price", price: baseline || 0 },
      topLineColor: "#059669", topFillColor1: "rgba(16,185,129,0.35)", topFillColor2: "rgba(16,185,129,0.02)",
      bottomLineColor: "#dc2626", bottomFillColor1: "rgba(239,68,68,0.02)", bottomFillColor2: "rgba(239,68,68,0.35)",
      lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
    });
    chartRef.current = chart; baseRef.current = base;

    chart.subscribeCrosshairMove(param => {
      const tip = tipRef.current; if (!tip) return;
      const pt = param.point;
      if (!param.time || !pt || pt.x < 0 || pt.y < 0) { tip.style.opacity = "0"; return; }
      const d = param.seriesData.get(base);
      if (!d || d.value === undefined) { tip.style.opacity = "0"; return; }
      const t = param.time;
      const dt = typeof t === "object" ? new Date(t.year, t.month - 1, t.day) : new Date(t + "T00:00:00");
      tip.querySelector("[data-date]").textContent = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      tip.querySelector("[data-val]").textContent = fmt(d.value);
      const w = wrapRef.current.clientWidth;
      tip.style.opacity = "1";
      tip.style.left = Math.min(Math.max(pt.x, 52), w - 52) + "px";
    });

    return () => { chart.remove(); chartRef.current = baseRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Push data + keep the baseline pinned to the opening balance on every change.
  React.useEffect(() => {
    const base = baseRef.current, chart = chartRef.current;
    if (!base || !chart) return;
    base.applyOptions({ baseValue: { type: "price", price: baseline || 0 } });
    base.setData(data.map(d => ({ time: d.time, value: d.value }))); // actuals + projected, one line
    chart.timeScale().fitContent();
  }, [data, baseline]);

  return (
    <div className="px-4 pb-3 pt-2">
      <div className="relative">
        <div ref={wrapRef} style={{ width: "100%", height: 190 }} />
        <div ref={tipRef} className="absolute top-1 -translate-x-1/2 pointer-events-none bg-white/95 border border-slate-100 shadow-lg rounded-lg px-2.5 py-1.5 whitespace-nowrap transition-opacity" style={{ opacity: 0, left: 0 }}>
          <div data-date className="text-slate-400 text-[10px] leading-tight"></div>
          <div data-val className="font-bold text-emerald-700 text-sm leading-tight"></div>
        </div>
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
        <p className="font-semibold text-slate-800">{label}</p>
        <canvas ref={canvasRef} width={600} height={250}
          className="w-full rounded-xl border border-slate-200 bg-white touch-none cursor-crosshair"
          style={{ height: "40vh" }}
          onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
          onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
        <div className="flex gap-2">
          <button onClick={clear} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold">Clear</button>
          <button onClick={onCancel} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold ml-auto">Cancel</button>
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
        <div className="flex-1 h-20 rounded-xl border border-slate-200 bg-white flex items-center justify-center overflow-hidden">
          {value ? <img src={value} alt="" className="max-h-20" /> : <span className="text-xs text-slate-300">No signature</span>}
        </div>
        <div className="flex flex-col gap-2 justify-center">
          <button type="button" onClick={() => setOpen(true)} className="px-3 py-1.5 rounded-lg bg-slate-800 text-white text-xs font-semibold">✍ Draw</button>
          <button type="button" onClick={() => fileRef.current && fileRef.current.click()} className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold">⬆ Upload</button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
        </div>
      </div>
      {open && <SignatureModal label={label} initial={value} onCancel={() => setOpen(false)} onSave={d => { onChange(d); setOpen(false); }} />}
    </div>
  );
}

// ─── Borrower ID photo (upload / view / replace / remove) ─────────────────────
// Reads a file, downscales it on a canvas (JPEG, like SignatureField does for
// images), and hands back a base64 data URL — same base64-in-DB pattern used by
// the agreement signatures. The image is stored on the loan row (id_image).
function IdPhotoButton({ image, onUpload, onRemove }) {
  const fileRef = useRef(null);
  const [viewing, setViewing] = useState(false);
  const [busy, setBusy] = useState(false);

  // Let the hardware/keyboard Escape close the full-screen viewer too.
  useEffect(() => {
    if (!viewing) return;
    const onKey = e => { if (e.key === "Escape") setViewing(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  const pick = () => fileRef.current && fileRef.current.click();

  const onFile = e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
        const cw = Math.round(img.width * scale), ch = Math.round(img.height * scale);
        const cnv = document.createElement("canvas");
        cnv.width = cw; cnv.height = ch;
        cnv.getContext("2d").drawImage(img, 0, 0, cw, ch);
        Promise.resolve(onUpload(cnv.toDataURL("image/jpeg", 0.82))).finally(() => setBusy(false));
      };
      img.onerror = () => setBusy(false);
      img.src = reader.result;
    };
    reader.onerror = () => setBusy(false);
    reader.readAsDataURL(file);
  };

  return (
    <>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
      {image ? (
        <div className="flex items-center gap-2 pt-1">
          <button type="button" onClick={() => setViewing(true)} className="shrink-0">
            <img src={image} alt="Borrower ID" className="h-12 w-12 rounded-lg object-cover border border-slate-200" />
          </button>
          <button type="button" onClick={() => setViewing(true)} className="flex-1 py-2.5 rounded-xl border border-slate-200 active:bg-slate-100 text-slate-600 text-sm font-semibold transition">🪪 View ID</button>
          <button type="button" onClick={pick} disabled={busy} className="px-4 py-2.5 rounded-xl border border-slate-200 active:bg-slate-100 text-slate-600 text-sm font-semibold transition disabled:opacity-50">{busy ? "…" : "Replace"}</button>
          <button type="button" onClick={onRemove} className="px-4 py-2.5 rounded-xl border border-red-200 active:bg-red-50 text-red-500 text-sm font-semibold transition">Remove</button>
        </div>
      ) : (
        <button type="button" onClick={pick} disabled={busy} className="w-full py-2.5 rounded-xl border border-slate-200 active:bg-slate-100 text-slate-600 text-sm font-semibold transition disabled:opacity-50 flex items-center justify-center gap-2">{busy ? "Uploading…" : <>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4"/>
            <path d="M7 9l5-5 5 5"/>
            <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>
          </svg>
          Upload ID
        </>}</button>
      )}
      {viewing && image && (
        <div onClick={() => setViewing(false)} className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4 animate-fade-in">
          <button type="button" onClick={() => setViewing(false)} aria-label="Close"
            className="fixed right-4 h-11 w-11 rounded-full bg-white/15 text-white text-2xl leading-none flex items-center justify-center active:bg-white/30 backdrop-blur"
            style={{ top: "calc(env(safe-area-inset-top) + 1rem)" }}>✕</button>
          <img src={image} alt="Borrower ID" className="max-h-[80vh] max-w-full rounded-xl shadow-2xl" />
          <p className="mt-4 text-white/70 text-xs">Tap anywhere or ✕ to close</p>
        </div>
      )}
    </>
  );
}

// ─── Bottom-sheet row ─────────────────────────────────────────────────────────
// One tappable action inside a sheet: icon chip, label, optional hint, chevron.
// min-h-[44px] keeps it a comfortable thumb target. Every Tailwind class here is
// a literal string — the CDN build only generates classes it can see in source,
// so an interpolated `bg-${tone}-50` would silently produce no styles.
function SheetRow({ icon, label, hint, danger, disabled, onClick }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`w-full min-h-[44px] flex items-center gap-3 px-2 py-2.5 rounded-xl text-left transition ${disabled ? "opacity-60" : "active:bg-slate-50"}`}>
      <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${danger ? "bg-red-50 text-red-500" : "bg-slate-100 text-slate-500"}`}>
        <i data-lucide={icon} className="w-4 h-4"></i>
      </span>
      <span className="flex-1 min-w-0">
        <span className={`block text-sm font-semibold ${danger ? "text-red-600" : disabled ? "text-slate-400" : "text-slate-700"}`}>{label}</span>
        {hint && <span className="block text-[11px] text-slate-400 leading-tight">{hint}</span>}
      </span>
      {!disabled && !danger && <i data-lucide="chevron-right" className="w-4 h-4 text-slate-300 shrink-0"></i>}
    </button>
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
        <button onClick={onBack} className="px-3 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold">← Back</button>
        <div className="flex gap-2 ml-auto">
          <button onClick={() => onSave(f)} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold">Save</button>
          <button onClick={() => window.print()} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold">Print</button>
          <button onClick={exportPdf} disabled={busy} className="px-4 py-2 rounded-xl bg-slate-800 text-white text-sm font-semibold disabled:opacity-50">{busy ? "Generating…" : "Download PDF"}</button>
        </div>
      </div>

      <div className="no-print bg-white rounded-2xl border border-slate-100 p-4 space-y-3 shadow-sm">
        <p className="font-semibold text-slate-800">Agreement Details · {loan.ref || loan.id}</p>
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

      <div className="no-print bg-white rounded-2xl border border-slate-100 p-4 space-y-3 shadow-sm">
        <p className="font-semibold text-slate-800">Signatures</p>
        <p className="text-xs text-slate-400 -mt-2">Tap Draw to sign in a popup, or Upload an image — saved with the agreement.</p>
        <SignatureField label="Lender Signature" value={f.sigLender} onChange={v => set("sigLender", v)} />
        <SignatureField label="Borrower Signature" value={f.sigBorrower} onChange={v => set("sigBorrower", v)} />
        <SignatureField label="Guarantor Signature" value={f.sigGuarantor} onChange={v => set("sigGuarantor", v)} />
        <SignatureField label="Witness 1 Signature" value={f.sigWitness1} onChange={v => set("sigWitness1", v)} />
        <SignatureField label="Witness 2 Signature" value={f.sigWitness2} onChange={v => set("sigWitness2", v)} />
      </div>

      <div id="agreement-print" className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm text-slate-800 text-sm leading-relaxed space-y-2"
        style={{ WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}>
        <h1 className="text-center font-bold text-lg">LOAN AGREEMENT</h1>
        <div className="h-4"></div>
        <p>This Loan Agreement is made and entered into this {fmtDate(aDate)}, by and between:</p>
        <p><b>{f.lenderName || "_____"}</b>, of legal age, Filipino{f.lenderAddress && <>, residing at {f.lenderAddress}</>}{f.lenderId && <>, holding Government ID No. {f.lenderId}</>}, hereinafter referred to as the "<i>Lender</i>",</p>
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
        <p><b>Guarantor: {f.guarantorName || "_____"} — {f.guarantorAddress || "_____"} — Gov't ID No. {f.guarantorId || "_____"}</b></p>

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

       
        {(f.witness1 || f.witness2) && (
          <>
            <p className="pt-6">Signed in the presence of:</p>
            <div className="grid grid-cols-2 gap-6 pt-2">
              {f.witness1 && <Sig src={f.sigWitness1} name={f.witness1} role="Witness 1" />}
              {f.witness2 && <Sig src={f.sigWitness2} name={f.witness2} role="Witness 2" />}
            </div>
          </>
        )}
        
        <p className="pt-6 font-bold">
          All known to me and to me known to be the same persons who executed the foregoing Loan Agreement consisting of 3 pages, including this page, and they acknowledged to me that the same is their free and voluntary act and deed.
        </p>
        <p className="pt-6 font-bold">
          This instrument refers to a Loan Agreement covering the principal amount of {pesoWords(loan.amount)} ({fmt(loan.amount)}).
        </p>
        <p className="pt-6 font-bold">
          WITNESS MY HAND AND SEAL on the date and place first above written.
        </p>
        <p className="font-bold">Notary Public</p>
        <p className="font-bold">Doc. No. ___</p>
        <p className="font-bold">Page No. ___</p>
        <p className="font-bold">Book No. ___</p>
        <p className="font-bold">Series of 2026</p>
      </div>


    </div>

  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function App() {
  // Starts empty: which snapshot to paint depends on who is signed in, and the
  // session isn't resolved yet. Hydration happens in the auth effect below.
  const [db, setDb] = useState(EMPTY_DB);
  // Which user's snapshot has already been painted. onAuthStateChange also fires
  // on token refresh, and re-hydrating there would flick the screen back to
  // stale data over whatever is already loaded.
  const hydratedFor = useRef(null);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMsg, setAuthMsg] = useState("");
  const [approved, setApproved] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminPending, setAdminPending] = useState([]);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [tab, setTab] = useState("home");
  const [toast, setToast] = useState("");
  const [agreementLoanId, setAgreementLoanId] = useState(null);
  const [recordFilter, setRecordFilter] = useState("active");
  const [recordSearch, setRecordSearch] = useState("");
  // Default is loan-ref order — the order the list has always been in. Nothing
  // moves until this control is touched.
  const [recordSort, setRecordSort] = useState("ref");
  // ── Dashboard view state ──
  // "Later" is the long tail of the collection list — collapsed until asked for.
  const [homeShowLater, setHomeShowLater] = useState(false);
  // Tapping an Overdue / Due today / This week tile jumps to that section.
  const dueSectionRefs = useRef({});
  const scrollToBucket = k => {
    const el = dueSectionRefs.current[k];
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // ── Cash flow view state ──
  // Opens on the whole record — the complete cash position is the honest first
  // answer — and narrows to a single calendar month on request. Aggregation only
  // re-buckets the same rows; it never changes what is in scope.
  const [cfMonth, setCfMonth] = useState(() => isoDay(new Date()).slice(0, 7));
  const [cfAllTime, setCfAllTime] = useState(true);
  const [cfAgg, setCfAgg] = useState("weekly");     // daily | weekly | monthly
  const [cfDir, setCfDir] = useState("all");        // all | in | out
  const [cfGroup, setCfGroup] = useState("all");    // CF_GROUPS key
  const [cfSearch, setCfSearch] = useState("");     // borrower or loan ref
  const [cfProjected, setCfProjected] = useState(false);
  // Which "what does this mean?" bubble is open. Hover alone would be dead on a
  // touch screen, so the icon is a real button and this holds the tapped one.
  const [cfInfo, setCfInfo] = useState(null);
  // A tapped-open bubble should close when you tap anywhere else. Registered on
  // the next tick so the click that opened it doesn't immediately shut it.
  useEffect(() => {
    if (!cfInfo) return;
    const close = () => setCfInfo(null);
    const t = setTimeout(() => document.addEventListener("click", close), 0);
    return () => { clearTimeout(t); document.removeEventListener("click", close); };
  }, [cfInfo]);
  const [cfFilterOpen, setCfFilterOpen] = useState(false);
  const [cfEntryOpen, setCfEntryOpen] = useState(false);
  // Forecast horizon. Defaults to 30 days out, but the lender picks the date —
  // "how much cash will I have by payday / by the 15th" is the real question.
  const [cfForecastDate, setCfForecastDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 30); return isoDay(d); });
  const [loadError, setLoadError] = useState(false);
  const [txDate, setTxDate] = useState(today());
  const [txCat, setTxCat] = useState("Capital Injection");
  const [txAmount, setTxAmount] = useState("");
  const [txNote, setTxNote] = useState("");
  const [openingInput, setOpeningInput] = useState(() => String((db.settings && db.settings.openingBalance) || ""));

  // Borrower queue inputs
  const [qBorrower, setQBorrower] = useState("");
  const [qAmount, setQAmount] = useState("");
  const [qDate, setQDate] = useState(today());
  const [qNote, setQNote] = useState("");
  const [fundingQueueId, setFundingQueueId] = useState(null); // queue entry being turned into a loan

  // Web Push: state machine — loading | unsupported | ios-hint | denied | off | on
  const [pushState, setPushState] = useState("loading");
  const [pushEndpoint, setPushEndpoint] = useState(null); // this device's subscription endpoint
  // Deep link from a notification click (e.g. "?loan=OL-0001")
  const [pendingLoanRef, setPendingLoanRef] = useState(() => {
    try { return new URLSearchParams(location.search).get("loan"); } catch { return null; }
  });

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
  const [freqDate, setFreqDate] = useState(today());
  const [revFreq, setRevFreq] = useState("");
  const [revTerms, setRevTerms] = useState("");
  const [reviseOpen, setReviseOpen] = useState(false); // schedule revision lives in a modal
  // Per-loan action sheet. Holds the id, never the loan object: saving an ID
  // photo calls refresh(), which swaps db.loans for fresh objects — a captured
  // object would keep painting the old idImage.
  const [sheetLoanId, setSheetLoanId] = useState(null);
  const [exportBusy, setExportBusy] = useState(false);   // schedule PNG is being rendered
  // The rendered PNG, held for a preview + share step. iOS needs the share call
  // to happen inside its own tap (see shareScheduleImage), and showing the image
  // first also lets you see what you're about to send.
  const [shareImg, setShareImg] = useState(null);        // { url, blob, filename }

  // ── PWA state: connectivity, offline queue, install, update ──
  const [online, setOnline] = useState(() => navigator.onLine);
  const [queued, setQueued] = useState([]);        // outbox items awaiting sync
  const [syncing, setSyncing] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);   // deferred beforeinstallprompt
  const [installed, setInstalled] = useState(() =>
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true);
  const [installDismissed, setInstallDismissed] = useState(() => {
    const at = Number(localStorage.getItem("ohana_install_snooze") || 0);
    return Date.now() - at < 14 * 24 * 3600 * 1000;            // snooze "Not now" for 2 weeks
  });
  const [updateReady, setUpdateReady] = useState(false);

  const flash = msg => { setToast(msg); setTimeout(() => setToast(""), 2500); };
  const refresh = useCallback(async () => {
    const data = await api.fetchAll();
    setDb(data);
    return data;
  }, []);

  // Auth gate: require a real (non-anonymous) login. Every record belongs to the
  // user who created it — RLS returns only that user's rows. Data loads only
  // once a session exists.
  const loadOwn = useCallback(async uid => {
    try { const d = await refresh(); setOpeningInput(String(d.settings.openingBalance || "")); setLoadError(false); }
    catch (e) {
      console.error(e);
      // The snapshot is already on screen — say what's showing instead of failing blank.
      setLoadError(true);
      flash(loadSnapshot(uid) ? "Offline — showing last synced data." : "Could not load data — check connection.");
    }
    finally { setLoading(false); }
  }, [refresh]);

  useEffect(() => {
    if (!sb) { setAuthReady(true); setLoading(false); flash("Supabase failed to load."); return; }
    let mounted = true;
    const isUser = s => s && !s.user.is_anonymous;
    const apply = async s => {
      if (s && s.user.is_anonymous) { await sb.auth.signOut(); s = null; }   // drop stale anon sessions
      if (!mounted) return;
      setSession(s);
      if (!isUser(s)) { setApproved(false); setIsAdmin(false); setLoading(false); setAuthReady(true); return; }
      let ok = false, admin = false;
      const accessKey = `ohana_access_${s.user.id}`;
      try {
        const [ap, ad] = await Promise.all([sb.rpc("is_approved"), sb.rpc("is_admin")]);
        if (ap.error || ad.error) throw (ap.error || ad.error);
        ok = !!ap.data; admin = !!ad.data;
        try { localStorage.setItem(accessKey, JSON.stringify({ ok, admin })); } catch {}
      } catch (e) {
        // The access check needs the network. Offline, fall back to the last
        // known answer so staff aren't locked out of their own records in the
        // field. This only unlocks the local UI — every read and write is still
        // enforced server-side by RLS, so a revoked account gains nothing.
        console.error(e);
        try {
          const cached = JSON.parse(localStorage.getItem(accessKey) || "null");
          if (cached) { ok = !!cached.ok; admin = !!cached.admin; }
        } catch {}
      }
      if (!mounted) return;
      setApproved(ok); setIsAdmin(admin);
      if (ok) {
        // Paint this user's own last-known data before the network answers —
        // once per user, so a token refresh doesn't undo what's on screen.
        if (hydratedFor.current !== s.user.id) {
          hydratedFor.current = s.user.id;
          const snap = loadSnapshot(s.user.id);
          setDb(snap ? { ...EMPTY_DB, ...snap } : EMPTY_DB);
        }
        await loadOwn(s.user.id);
      } else setLoading(false);
      setAuthReady(true);
    };
    const { data: { subscription } } = sb.auth.onAuthStateChange((_e, s) => { apply(s); });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, [loadOwn]);

  // ─── Offline queue ──────────────────────────────────────────────────────────
  // Writes that can't reach Supabase are parked in the outbox and replayed on
  // reconnect. Replay only runs for an approved session, so a queued row is never
  // fired at the server before RLS can accept it.
  const flushing = useRef(false);
  const approvedRef = useRef(false);
  useEffect(() => { approvedRef.current = approved; }, [approved]);

  const reloadQueue = useCallback(async () => { setQueued(await outbox.all()); }, []);

  const flushOutbox = useCallback(async () => {
    if (flushing.current || !navigator.onLine || !approvedRef.current) return;
    const items = await outbox.all();
    if (!items.length) { setQueued([]); return; }
    flushing.current = true; setSyncing(true);
    let done = 0, rejected = 0;
    // Oldest first — payments should land in the order they were taken.
    for (const item of items.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
      try { await api.applyQueued(item); await outbox.remove(item.id); done++; }
      catch (e) {
        console.error("outbox replay failed", item, e);
        if (isNetworkError(e)) break;                       // signal dropped again — keep the rest
        await outbox.put({ ...item, attempts: (item.attempts || 0) + 1, lastError: String(e.message || e) });
        rejected++;
      }
    }
    flushing.current = false; setSyncing(false);
    await reloadQueue();
    if (done) {
      try { await refresh(); } catch (e) { console.error(e); }
      flash(`Synced ${done} offline ${done === 1 ? "entry" : "entries"}.`);
    }
    if (rejected) flash(`${rejected} queued ${rejected === 1 ? "entry was" : "entries were"} rejected by the server.`);
  }, [refresh, reloadQueue]);

  // Queue a write and reflect it locally right away, so the schedule, balances
  // and dues stay truthful while offline. The optimistic row carries the same id
  // the server row will get, so the post-sync refresh can't duplicate it.
  const enqueue = useCallback(async (kind, payload, optimistic) => {
    await outbox.put({ id: uuid(), kind, payload, createdAt: new Date().toISOString(), attempts: 0 });
    await reloadQueue();
    requestOutboxSync();
    if (optimistic) setDb(prev => optimistic(prev));
  }, [reloadQueue]);

  // Drop a row that never made it to the server (outbox + local copy).
  const discardQueued = useCallback(async (collection, rowId) => {
    const item = (await outbox.all()).find(q => q.payload && q.payload.id === rowId);
    if (item) await outbox.remove(item.id);
    await reloadQueue();
    setDb(prev => ({ ...prev, [collection]: (prev[collection] || []).filter(r => r.id !== rowId) }));
  }, [reloadQueue]);

  // Connectivity: replay on reconnect, and once the session is approved.
  useEffect(() => {
    const goOnline = () => { setOnline(true); flushOutbox(); };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); };
  }, [flushOutbox]);
  useEffect(() => { reloadQueue(); }, [reloadQueue]);
  useEffect(() => { if (approved && online) flushOutbox(); }, [approved, online, flushOutbox]);

  // Keep the offline snapshot in step with whatever is on screen — server
  // refreshes and offline writes alike. Skipped during the initial load so a
  // failed first fetch can't overwrite good data with an empty shell.
  useEffect(() => { if (!loading && session) saveSnapshot(session.user.id, db); }, [db, loading, session]);

  // ─── Install prompt ─────────────────────────────────────────────────────────
  useEffect(() => {
    const onPrompt = e => { e.preventDefault(); setInstallPrompt(e); };
    const onInstalled = () => { setInstalled(true); setInstallPrompt(null); flash("Installed — open Ohana from your home screen."); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    const mq = window.matchMedia("(display-mode: standalone)");
    const onMode = e => setInstalled(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", onMode); else mq.addListener(onMode);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      if (mq.removeEventListener) mq.removeEventListener("change", onMode); else mq.removeListener(onMode);
    };
  }, []);

  const snoozeInstall = () => {
    try { localStorage.setItem("ohana_install_snooze", String(Date.now())); } catch {}
    setInstallDismissed(true);
  };
  const runInstall = async () => {
    if (!installPrompt) return;
    try {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome !== "accepted") snoozeInstall();
    } catch (e) { console.error(e); }
    setInstallPrompt(null);
  };
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const showInstallCard = !installed && !installDismissed && (!!installPrompt || isIos);

  // ─── App update ─────────────────────────────────────────────────────────────
  // index.html registers the worker and fires this event when a new version is
  // downloaded and waiting. Nothing swaps until the user taps Update.
  useEffect(() => {
    const onReady = () => setUpdateReady(true);
    window.addEventListener("sw-update-ready", onReady);
    if (window.__swWaiting) setUpdateReady(true);
    return () => window.removeEventListener("sw-update-ready", onReady);
  }, []);
  const applyUpdate = () => {
    const waiting = window.__swWaiting || (window.__swRegistration && window.__swRegistration.waiting);
    setUpdateReady(false);
    if (!waiting) { window.location.reload(); return; }
    waiting.postMessage({ type: "SKIP_WAITING" });   // controllerchange → index.html reloads
    flash("Updating…");
  };

  const sym = "₱";
  const fmt = v => sym + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const calc = useMemo(() => computeCalc({ amount, terms, flatRate, frequency, startDate, dropRate }), [amount, terms, flatRate, frequency, startDate, dropRate]);

  const resetForm = () => { setEditId(null); setFundingQueueId(null); setName(""); setAmount(10000); setTerms(6); setFlatRate(3.6); setFrequency("Semi-Monthly"); setStartDate(today()); setDropRate(3.6); };

  // A loan card is a link to its Payments screen.
  const openPayments = l => {
    setLoanIdOvr(l.ref || l.id);   // `resolved` matches on either
    setSelBorrower("");
    setSheetLoanId(null);
    setTab("status");
  };

  // Captures the off-screen export document, not the on-screen card. The card is
  // built for a phone — a fixed-width scroller that crops to whatever columns
  // happen to be visible — whereas the document is laid out once at a readable
  // width with the loan terms and totals a bare schedule doesn't convey.
  const exportSchedulePng = async () => {
    const el = document.getElementById("schedule-export-doc");
    if (!el || !window.html2canvas) { flash("Image tools not ready — reload once online."); return; }
    setExportBusy(true);
    try {
      const w = el.offsetWidth, h = el.offsetHeight;
      // iOS caps how many pixels a canvas may hold; a 240-installment schedule
      // at 2× would sail past it and come back blank. Trade sharpness for a
      // picture that actually renders.
      const scale = Math.max(1, Math.min(2, Math.sqrt(12e6 / Math.max(1, w * h))));
      const canvas = await window.html2canvas(el, {
        scale,
        backgroundColor: "#ffffff",
        width: w, height: h, windowWidth: w, windowHeight: h,
      });
      // toBlob, not toDataURL: a Blob can be wrapped in a File for the iOS share
      // sheet, and it doesn't carry the ~33% base64 overhead of a data: URL.
      const blob = await new Promise(res => canvas.toBlob(res, "image/png"));
      if (!blob) throw new Error("canvas produced no image");
      setShareImg(prev => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url: URL.createObjectURL(blob), blob,
                 filename: `Payment Schedule - ${name.trim() || "loan"}.png` };
      });
    } catch (e) { console.error(e); flash("Could not export image."); }
    finally { setExportBusy(false); }
  };

  const closeShareImg = () => setShareImg(prev => { if (prev) URL.revokeObjectURL(prev.url); return null; });

  // Must be called straight from a tap. iOS only honours navigator.share while a
  // user gesture is still "active", and rendering the canvas takes long enough to
  // spend that activation — which is why the image is previewed first and shared
  // from a second, fresh tap rather than automatically after export.
  const shareScheduleImage = async () => {
    if (!shareImg) return;
    const file = new File([shareImg.blob], shareImg.filename, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: shareImg.filename });
        closeShareImg();
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;      // user dismissed the sheet
        console.error(e);
      }
    }
    // No share sheet (desktop, or an older iOS): fall back to a download.
    const a = document.createElement("a");
    a.href = shareImg.url; a.download = shareImg.filename;
    document.body.appendChild(a); a.click(); a.remove();
    flash("Image downloaded.");
  };

  const editLoan = l => {
    setEditId(l.id);
    setFundingQueueId(null);
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
        // Mark the queued borrower funded — only if this loan really is for them.
        if (fundingQueueId) {
          const fq = (db.queue || []).find(q => q.id === fundingQueueId);
          if (fq && fq.borrower.toLowerCase() === borrower.toLowerCase()) {
            try { await api.setQueueStatus(fundingQueueId, "funded"); } catch (e) { console.error(e); }
          }
        }
        flash(`Saved ${ref} — ${borrower}`);
      }
      buzz();
      await refresh();
      resetForm();
      setTab("records");
    } catch (e) {
      console.error(e);
      // Loans aren't queued offline on purpose: the OL-#### ref is derived from
      // the current list, so two disconnected devices would mint the same one.
      flash(isNetworkError(e) ? "Loans need a connection — reconnect and try again." : "Save failed — check connection.");
    }
  };

  const deleteLoan = async (id, ref) => {
    if (!confirm(`Delete loan ${ref || id}? This also removes all its payments.`)) return;
    try { await api.deleteLoan(id); await refresh(); flash(`Deleted ${ref || ""}`.trim()); }
    catch (e) { console.error(e); flash("Delete failed — check connection."); }
  };

  const saveIdImage = async (loan, dataUrl) => {
    try { await api.setIdImage(loan.id, dataUrl); await refresh(); flash(`ID photo saved — ${loan.borrower}`); }
    catch (e) { console.error(e); flash("Upload failed — check connection."); }
  };
  const removeIdImage = async (loan) => {
    if (!confirm(`Remove the ID photo for ${loan.borrower}?`)) return;
    try { await api.setIdImage(loan.id, null); await refresh(); flash("ID photo removed"); }
    catch (e) { console.error(e); flash("Remove failed — check connection."); }
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

  // ── Login (shared team access) ──
  const signIn = async () => {
    setAuthMsg("");
    if (!sb) { setAuthMsg("Database library failed to load — reload the page."); return; }
    if (!authEmail || !authPass) { setAuthMsg("Enter your email and password."); return; }
    setAuthBusy(true);
    try { const { error } = await sb.auth.signInWithPassword({ email: authEmail.trim(), password: authPass }); if (error) throw error; setAuthPass(""); }
    catch (e) { console.error(e); setAuthMsg(e.message || "Sign in failed."); }
    finally { setAuthBusy(false); }
  };
  const createAccount = async () => {
    setAuthMsg("");
    if (!sb) { setAuthMsg("Database library failed to load — reload the page."); return; }
    if (!authEmail || authPass.length < 6) { setAuthMsg("Enter an email and a password of at least 6 characters."); return; }
    setAuthBusy(true);
    try {
      const { data, error } = await sb.auth.signUp({ email: authEmail.trim(), password: authPass });
      if (error) throw error;
      if (data.session) setAuthPass("");                 // signed in → gate hides automatically
      else setAuthMsg("Account created. Confirm via the email link, then Sign in.");
    } catch (e) { console.error(e); setAuthMsg(e.message || "Could not create account."); }
    finally { setAuthBusy(false); }
  };
  const signOut = async () => {
    // Unsynced work would sit invisible until someone signs in again — say so first.
    if (queued.length && !confirm(`${queued.length} entr${queued.length === 1 ? "y hasn't" : "ies haven't"} synced yet. Sign out anyway? They stay on this device and sync at the next sign-in.`)) return;
    try {
      const uid = session?.user?.id;
      await sb.auth.signOut();
      // Don't leave borrower records cached on a signed-out device.
      clearSnapshot(uid);
      hydratedFor.current = null;
      setDb(EMPTY_DB);
      flash("Signed out.");
    } catch (e) { console.error(e); flash("Sign out failed."); }
  };

  // ── Admin: manage who can access (allowlist) ──
  const loadAdmin = async () => {
    try {
      const [a, p] = await Promise.all([
        sb.from("allowed_users").select("email, role, added_at").order("added_at", { ascending: false }),
        sb.rpc("pending_users"),
      ]);
      if (a.error) throw a.error;
      setAdminUsers(a.data || []);
      setAdminPending(p.data || []);
    } catch (e) { console.error(e); flash("Could not load users."); }
  };
  const openAdmin = async () => { setShowAdmin(true); await loadAdmin(); };
  const approveEmail = async em => {
    const e = (em || "").trim().toLowerCase();
    if (!e) { flash("Enter an email."); return; }
    setAdminBusy(true);
    try { const { error } = await sb.from("allowed_users").insert({ email: e, role: "user" }); if (error) throw error; setAdminEmail(""); await loadAdmin(); flash(`Approved ${e}`); }
    catch (err) { console.error(err); flash(err.message || "Could not approve."); }
    finally { setAdminBusy(false); }
  };
  const revokeEmail = async em => {
    if (session && em.toLowerCase() === (session.user.email || "").toLowerCase()) { flash("You can't remove your own access."); return; }
    if (!confirm(`Remove access for ${em}?`)) return;
    try { const { error } = await sb.from("allowed_users").delete().eq("email", em); if (error) throw error; await loadAdmin(); flash(`Removed ${em}`); }
    catch (err) { console.error(err); flash(err.message || "Could not remove."); }
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

  // The Loans directory. Every row carries what actually moves — what's left,
  // when the next installment lands, how far along the loan is — derived here
  // rather than in the JSX, since computeStatus is already being called per loan.
  const loanRows = useMemo(() => {
    const todayStr = today();
    // Last payment per loan, for the settled rows' sub-line.
    const lastPay = {};
    db.payments.forEach(p => { if (!lastPay[p.loanId] || p.date > lastPay[p.loanId]) lastPay[p.loanId] = p.date; });
    return db.loans.map(l => {
      const s = computeStatus(l, db.payments);
      const paid = s.overallStatus === "FULLY PAID";
      const open = s.rows.filter(r => r.amtLeft > 0.005);
      const nextRow = open[0] || null;
      const missed = open.filter(r => isoDay(r.due) < todayStr).length;
      const urgency = nextRow ? dueUrgency(isoDay(nextRow.due)) : null;
      const hint = paid
        ? `Fully paid${lastPay[l.id] ? ` · last payment ${fmtDate(parseDate(lastPay[l.id]))}` : ""}`
        : !urgency ? "Nothing scheduled"
        // Past the first week a countdown stops meaning anything — "in 63 days"
        // is a number you have to convert back into a date. Show the date.
        : urgency.bucket === "later" ? `due ${fmtDate(nextRow.due)}`
        : urgency.bucket === "overdue" ? `${urgency.label}${missed > 1 ? ` · ${missed} missed` : ""}`
        : urgency.label;
      return {
        l, s, paid, missed, hint, nextRow,
        overdue: missed > 0,
        pct: s.totalLogged / ((Number(l.amount) + s.summedInterest) || 1),
      };
    });
  }, [db.loans, db.payments]);

  const filteredLoans = useMemo(() => {
    const q = recordSearch.trim().toLowerCase();
    const rows = loanRows
      .filter(r =>
        recordFilter === "all" ? true
        : recordFilter === "paid" ? r.paid
        : recordFilter === "overdue" ? r.overdue
        : !r.paid)
      .filter(({ l }) => !q || l.borrower.toLowerCase().includes(q) || (l.ref || "").toLowerCase().includes(q));
    // "ref" is db.loans' own order (the API orders by ref) — left untouched so
    // the default view is exactly the list this tab has always shown.
    if (recordSort === "ref") return rows;
    const by = {
      // Earliest unpaid due date first, so the deepest arrears lead. Settled
      // loans have no due date left and sink to the bottom.
      urgent: (a, b) => (a.paid - b.paid) || (!a.nextRow || !b.nextRow ? 0 : a.nextRow.due - b.nextRow.due),
      balance: (a, b) => b.s.grandLeft - a.s.grandLeft,
      name: (a, b) => (a.l.borrower || "").localeCompare(b.l.borrower || ""),
    };
    return by[recordSort] ? rows.slice().sort(by[recordSort]) : rows;
  }, [loanRows, recordFilter, recordSearch, recordSort]);

  const cashflow = useMemo(() => {
    const [start, end] = cfAllTime ? ALL_TIME : monthBounds(cfMonth);
    const opening = Number(db.settings && db.settings.openingBalance) || 0;
    const todayStr = isoDay(new Date()), curMonth = todayStr.slice(0, 7);

    // Actual cash events: disbursements (out), collections (in), manual entries (in/out).
    const disb = db.loans.map(l => ({ id: "D-" + l.id, date: l.startDate, kind: "Disbursement", subtype: "", loanId: l.id, ref: l.ref, borrower: l.borrower, inflow: 0, outflow: Number(l.amount) || 0 }));
    const coll = db.payments.map(p => {
      const loan = db.loans.find(l => l.id === p.loanId);
      return { id: "P-" + p.id, date: p.date, kind: "Collection", subtype: p.type || "", loanId: p.loanId, ref: loan ? loan.ref : "", borrower: loan ? loan.borrower : "—", inflow: Number(p.amount) || 0, outflow: 0 };
    });
    const manual = (db.transactions || []).map(t => ({
      id: "M-" + t.id, txId: t.id, date: t.date, kind: t.kind, subtype: "", note: t.note, loanId: null, borrower: "", pending: !!t.pending,
      inflow: t.direction === "in" ? Number(t.amount) || 0 : 0, outflow: t.direction === "out" ? Number(t.amount) || 0 : 0
    }));
    const actual = [...disb, ...coll, ...manual].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    let bal = opening;
    actual.forEach(t => { bal += t.inflow - t.outflow; t.balance = bal; });
    const inRange = actual.filter(t => t.date >= start && t.date <= end);

    // Cash at the period's open — the comparison point for "is my position improving?".
    const openingForPeriod = actual.filter(t => t.date < start).reduce((v, t) => v + t.inflow - t.outflow, opening);

    // Projected upcoming dues (only when toggled on), continuing the running balance.
    const projected = [];
    if (cfProjected) {
      db.loans.forEach(l => {
        computeStatus(l, db.payments).rows.forEach((r, idx) => {
          if (r.status === "PAID" || r.amtLeft <= 0.005) return;
          // Include every remaining unpaid installment. Overdue ones (due date in the
          // past) are expected "now", so clamp them to today rather than dropping them.
          const dueISO = isoDay(r.due);
          const date = dueISO < todayStr ? todayStr : dueISO;
          projected.push({ id: `X-${l.id}-${idx}`, date, kind: "Scheduled Due", subtype: "", loanId: l.id, ref: l.ref, borrower: l.borrower, inflow: r.amtLeft, outflow: 0, projected: true });
        });
      });
      projected.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    }

    // Display order: strictly by date, real movements ahead of expected dues on
    // the same day. Balances are re-run across the merged chain when dues are
    // shown, so a due dated after a future-dated real entry still reads on from
    // it. `bal` above is untouched — Available Cash stays actual-only.
    const chrono = [...actual, ...projected].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1
      : (!!a.projected === !!b.projected ? 0 : a.projected ? 1 : -1));
    if (cfProjected) {
      let run = opening;
      chrono.forEach(t => { run += t.inflow - t.outflow; t.balance = run; });
    }
    chrono.forEach((t, i) => { t.order = i; });

    // ── Period totals (actuals only) ──
    const collected = inRange.filter(t => t.kind === "Collection").reduce((s, t) => s + t.inflow, 0);
    const collectedCount = inRange.filter(t => t.kind === "Collection").length;
    const disbursed = inRange.filter(t => t.kind === "Disbursement").reduce((s, t) => s + t.outflow, 0);
    const releasedCount = inRange.filter(t => t.kind === "Disbursement").length;
    const manualIn = inRange.filter(t => t.txId && t.inflow > 0);
    const manualOut = inRange.filter(t => t.txId && t.outflow > 0);
    const sumIn = rows => rows.reduce((s, t) => s + t.inflow, 0);
    const sumOut = rows => rows.reduce((s, t) => s + t.outflow, 0);
    const interest = db.loans.reduce((sum, l) =>
      sum + realizedInterestUpTo(l, db.payments, end, true) - realizedInterestUpTo(l, db.payments, start, false), 0);
    const principalIn = Math.max(0, collected - interest);
    const feeIncome = sumIn(manualIn.filter(t => txnMeta(t.kind).group === "fees"));
    const capitalIn = sumIn(manualIn.filter(t => txnMeta(t.kind).group === "capital"));
    const otherIn = sumIn(manualIn) - feeIncome - capitalIn;
    const withdrawals = sumOut(manualOut.filter(t => t.kind === "Withdrawal"));
    const expenses = sumOut(manualOut.filter(t => txnMeta(t.kind).group === "expenses"));
    const otherOut = sumOut(manualOut) - withdrawals - expenses;
    const moneyIn = collected + sumIn(manualIn);
    const moneyOut = disbursed + sumOut(manualOut);
    const net = moneyIn - moneyOut;
    const pctChange = openingForPeriod > 0 ? (net / openingForPeriod) * 100 : null;
    // Dues are scoped to the selected period exactly as actual rows are —
    // "August" must not spill next year's schedule into August's timeline.
    const projectedInRange = projected.filter(t => t.date >= start && t.date <= end);
    const expected = projectedInRange.reduce((s, t) => s + t.inflow, 0);

    // ── Ledger (newest first) after the direction / category / name filters ──
    const q = cfSearch.trim().toLowerCase();
    const ledger = [...inRange, ...projectedInRange]
      .filter(t => cfDir === "all" ? true : cfDir === "in" ? t.inflow > 0 : t.outflow > 0)
      .filter(t => cfGroup === "all" ? true : txnMeta(t.kind).group === cfGroup)
      .filter(t => !q || (t.borrower || "").toLowerCase().includes(q) || (t.ref || "").toLowerCase().includes(q) || (t.note || "").toLowerCase().includes(q))
      .sort((a, b) => b.order - a.order); // newest first → the balance column reads top-to-bottom

    // Group the ledger by day so the timeline reads Today / Yesterday / date.
    // Keyed by date, not by adjacency: one date must only ever produce one
    // section, or React sees two siblings sharing a key.
    const dayMap = new Map();
    ledger.forEach(t => {
      let d = dayMap.get(t.date);
      if (!d) { d = { date: t.date, heading: dayHeading(t.date), rows: [] }; dayMap.set(t.date, d); }
      d.rows.push(t);
    });
    const days = [...dayMap.values()].sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
    // Actual cash and expected dues are totalled apart: a day's net must never
    // fold in money that hasn't arrived.
    days.forEach(d => {
      d.net = d.rows.filter(t => !t.projected).reduce((s, t) => s + t.inflow - t.outflow, 0);
      d.expected = d.rows.filter(t => t.projected).reduce((s, t) => s + t.inflow, 0);
      d.hasActual = d.rows.some(t => !t.projected);
    });

    // ── Chart buckets. Same rows, three groupings — day, week, or month. ──
    const events = [...inRange, ...projectedInRange].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const bucket = t => {
      if (cfAgg === "monthly" || cfAllTime) return { key: t.date.slice(0, 7), label: monthLabelShort(t.date.slice(0, 7)) };
      if (cfAgg === "daily") return { key: t.date, label: String(Number(t.date.slice(8, 10))) };
      const w = Math.min(3, Math.floor((Number(t.date.slice(8, 10)) - 1) / 7));  // a 5th part-week folds into week 4
      return { key: `${t.date.slice(0, 7)}-W${w}`, label: `W${w + 1}` };
    };
    const bMap = {};
    events.forEach(t => {
      const b = bucket(t);
      if (!bMap[b.key]) bMap[b.key] = { key: b.key, label: b.label, inflow: 0, outflow: 0, projIn: 0, projected: t.date.slice(0, 7) > curMonth };
      if (t.projected) bMap[b.key].projIn += t.inflow;
      else { bMap[b.key].inflow += t.inflow; bMap[b.key].outflow += t.outflow; }
    });
    const buckets = Object.values(bMap).sort((a, b) => a.key < b.key ? -1 : 1);

    // Date-keyed running balance for the Net Cash Position baseline chart.
    // Collapse multiple events on the same day to that day's closing balance so
    // each x-axis date carries one value (BaselineSeries needs unique ascending times).
    const hist = [...inRange, ...projectedInRange].sort((a, b) => a.order - b.order);
    const posMap = new Map();
    hist.forEach(t => posMap.set(t.date, { time: t.date, value: t.balance, projected: !!t.projected }));
    const position = [...posMap.values()].sort((a, b) => a.time < b.time ? -1 : 1);

    // ── Where money sits right now (never mixed into available cash) ──
    let loanedOut = 0, outstandingPrincipal = 0, expectedCollections = 0, activeLoans = 0;
    db.loans.forEach(l => {
      const st = computeStatus(l, db.payments);
      if (st.overallStatus === "FULLY PAID") return;
      activeLoans++;
      loanedOut += Number(l.amount) || 0;
      outstandingPrincipal += Math.max(0, (Number(l.amount) || 0) - principalRecovered(st));
      expectedCollections += st.grandLeft;
    });

    // Months that actually carry activity — powers "jump to a month with data".
    const activeMonths = [...new Set(actual.map(t => t.date.slice(0, 7)))].sort();

    return {
      start, end, opening, openingForPeriod, balance: bal,
      collected, collectedCount, disbursed, releasedCount,
      moneyIn, moneyOut, net, pctChange, interest, principalIn,
      feeIncome, capitalIn, otherIn, withdrawals, expenses, otherOut,
      expected, expectedCount: projectedInRange.length,
      ledger, days, buckets, position,
      loanedOut, outstandingPrincipal, expectedCollections, activeLoans,
      hasAnyActivity: actual.length > 0, inRangeCount: inRange.length, activeMonths,
    };
  }, [db.loans, db.payments, db.transactions, db.settings, cfMonth, cfAllTime, cfAgg, cfDir, cfGroup, cfSearch, cfProjected]);

  // Every unpaid installment, earliest first. Overdue keeps its real due date
  // here, unlike the projected ledger rows which clamp to today so the running
  // balance stays chronological.
  const upcoming = useMemo(() => {
    const todayStr = isoDay(new Date());
    const items = [];
    db.loans.forEach(l => {
      const st = computeStatus(l, db.payments);
      if (st.overallStatus === "FULLY PAID") return;
      st.rows.forEach((r, i) => {
        if (r.amtLeft <= 0.005) return;
        items.push({ key: `${l.id}-${i}`, loanId: l.id, ref: l.ref, borrower: l.borrower,
          dueStr: isoDay(r.due), amount: r.amtLeft });
      });
    });
    items.sort((a, b) => a.dueStr < b.dueStr ? -1 : a.dueStr > b.dueStr ? 1 : 0);
    const overdue = items.filter(i => i.dueStr < todayStr);
    return { items, overdue, overdueAmt: overdue.reduce((s, i) => s + i.amount, 0), todayStr };
  }, [db.loans, db.payments]);

  // Cash forecast to a date the lender chooses. Every term is real data — cash
  // on hand, what is already past due, unpaid installments falling due inside
  // the window, and loans already queued for release. Nothing is modelled; the
  // one assumption, stated on the card, is that overdue money does come in.
  const forecast = useMemo(() => {
    const horizon = cfForecastDate > upcoming.todayStr ? cfForecastDate : upcoming.todayStr;
    const due = upcoming.items.filter(i => i.dueStr >= upcoming.todayStr && i.dueStr <= horizon);
    const scheduled = (db.queue || []).filter(q => q.status !== "funded" && q.date <= horizon);
    const collections = due.reduce((s, i) => s + i.amount, 0);
    const releases = scheduled.reduce((s, q) => s + (Number(q.amount) || 0), 0);
    return {
      horizon,
      days: Math.round((parseDate(horizon) - parseDate(upcoming.todayStr)) / 86400000),
      cash: cashflow.balance,
      collections, collectionCount: due.length,
      releases, releaseCount: scheduled.length,
      projected: cashflow.balance + upcoming.overdueAmt + collections - releases,
      overdueAmt: upcoming.overdueAmt, overdueCount: upcoming.overdue.length,
    };
  }, [cashflow.balance, upcoming, db.queue, cfForecastDate]);

  // ── Cash-flow view derivations (cheap, read straight by the markup) ──
  const todayISO = isoDay(new Date());
  const thisMonth = todayISO.slice(0, 7);
  const periodIsPast = !cfAllTime && cashflow.end < todayISO;
  const latestActiveMonth = cashflow.activeMonths.length ? cashflow.activeMonths[cashflow.activeMonths.length - 1] : null;
  // Share of the released/collected bar. 50/50 when nothing moved, so the bar
  // never implies a lopsided period that didn't happen.
  const lendSplit = (cashflow.collected + cashflow.disbursed) > 0
    ? (cashflow.collected / (cashflow.collected + cashflow.disbursed)) * 100 : 50;
  const lendVerdict = (() => {
    const diff = cashflow.collected - cashflow.disbursed;
    const period = cfAllTime ? "so far" : `in ${monthLabelLong(cfMonth)}`;
    if (cashflow.collected === 0 && cashflow.disbursed === 0) return `No loans released or collected ${period}.`;
    if (Math.abs(diff) < 0.01) return `Collections exactly matched releases ${period}.`;
    return diff > 0
      ? `You collected ${fmt(diff)} more than you released ${period}.`
      : `You released ${fmt(-diff)} more than you collected ${period}.`;
  })();
  // A 320px phone fits ~11 digits at 36px. Stepping the hero down by digit count
  // beats clipping or wrapping a peso amount mid-thousands.
  const heroSize = v => { const n = fmt(v).length; return n <= 11 ? "text-[2.25rem]" : n <= 13 ? "text-3xl" : "text-2xl"; };
  const heroCls = heroSize(cashflow.balance);
  const cfFilterCount = (cfDir !== "all" ? 1 : 0) + (cfGroup !== "all" ? 1 : 0) + (cfSearch.trim() ? 1 : 0);
  const cfChips = [
    cfDir !== "all" && [cfDir === "in" ? "Money in" : "Money out", () => setCfDir("all")],
    cfGroup !== "all" && [(CF_GROUPS.find(g => g[0] === cfGroup) || [, cfGroup])[1], () => setCfGroup("all")],
    cfSearch.trim() && [`\u201c${cfSearch.trim()}\u201d`, () => setCfSearch("")],
  ].filter(Boolean);
  const clearCfFilters = () => { setCfDir("all"); setCfGroup("all"); setCfSearch(""); };

  // Borrower queue, ordered earliest-first. Walk the line and mark each entry
  // "ready to fund" while the cumulative requested amount still fits cash on hand.
  const queueView = useMemo(() => {
    const cash = cashflow.balance;
    const all = db.queue || [];
    const waiting = all.filter(q => q.status !== "funded")
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt < b.createdAt ? -1 : 1));
    let cum = 0;
    const rows = waiting.map((q, i) => {
      cum += Number(q.amount) || 0;
      return { ...q, position: i + 1, cumulative: cum, ready: cum <= cash };
    });
    const funded = all.filter(q => q.status === "funded")
      .sort((a, b) => a.date < b.date ? 1 : -1);
    return {
      cash, rows, funded,
      readyCount: rows.filter(r => r.ready).length,
      totalRequested: rows.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    };
  }, [db.queue, cashflow.balance]);

  // Dashboard / landing overview. Portfolio totals, plus the day's collection
  // job: every active borrower placed in exactly one urgency bucket, carrying
  // what they actually owe rather than a single installment.
  const dashboard = useMemo(() => {
    const todayStr = isoDay(new Date());
    let outstanding = 0, collectedAll = 0, activeCount = 0, paidCount = 0;
    db.loans.forEach(l => {
      const st = computeStatus(l, db.payments);
      collectedAll += st.totalLogged;
      if (st.overallStatus === "FULLY PAID") { paidCount++; return; }
      activeCount++;
      outstanding += st.grandLeft;
    });

    // Fold `upcoming.items` (every unpaid installment, already computed for the
    // cash-flow forecast) down to one row per loan.
    const byLoan = new Map();
    upcoming.items.forEach(i => {
      let r = byLoan.get(i.loanId);
      if (!r) {
        r = { loanId: i.loanId, ref: i.ref, borrower: i.borrower,
          overdueAmt: 0, overdueCount: 0, todayAmt: 0, next: null };
        byLoan.set(i.loanId, r);
      }
      if (i.dueStr < todayStr) { r.overdueAmt += i.amount; r.overdueCount++; }
      else if (i.dueStr === todayStr) r.todayAmt += i.amount;
      if (!r.next || i.dueStr < r.next.dueStr) r.next = i;   // items arrive earliest-first
    });

    // A borrower lands in their most urgent bucket only, so nobody is listed twice.
    // Overdue rows show everything collectable right now (missed + due today);
    // the rest show the installment that is coming.
    const groups = Object.fromEntries(DUE_BUCKETS.map(([k]) => [k, { key: k, rows: [], total: 0 }]));
    byLoan.forEach(r => {
      const u = dueUrgency(r.next.dueStr);
      const bucket = r.overdueCount > 0 ? "overdue" : u.bucket;
      const amount = bucket === "overdue" ? r.overdueAmt + r.todayAmt
        : bucket === "today" ? r.todayAmt
        : r.next.amount;
      const hint = bucket === "overdue"
        ? (r.overdueCount > 1 ? `${r.overdueCount} missed · ${dueUrgency(r.next.dueStr).label}` : u.label)
        : u.label;
      const g = groups[bucket];
      g.rows.push({ ...r, bucket, amount, hint, dueStr: r.next.dueStr });
      g.total += amount;
    });
    DUE_BUCKETS.forEach(([k]) => groups[k].rows.sort((a, b) =>
      a.dueStr < b.dueStr ? -1 : a.dueStr > b.dueStr ? 1 : 0));

    const collectedToday = db.payments
      .filter(p => p.date === todayStr)
      .reduce((s, p) => s + (Number(p.amount) || 0), 0);

    return {
      activeCount, paidCount, outstanding, collectedAll, collectedToday,
      groups, dueCount: byLoan.size,
      overdueAmt: groups.overdue.total, overdueCount: groups.overdue.rows.length,
      todayAmt: groups.today.total, todayCount: groups.today.rows.length,
      weekAmt: groups.week.total, weekCount: groups.week.rows.length,
      cash: cashflow.balance,
    };
  }, [db.loans, db.payments, upcoming, cashflow.balance]);

  const addQueueEntry = async () => {
    const borrower = qBorrower.trim();
    const amt = Number(qAmount);
    if (!borrower) { flash("Enter the borrower's name."); return; }
    if (!(amt > 0)) { flash("Amount must be greater than 0."); return; }
    if (!qDate) { flash("Pick a queue date."); return; }
    const row = { id: uuid(), borrower, amount: amt, date: qDate, note: qNote.trim() };
    const clear = () => { setQBorrower(""); setQAmount(""); setQNote(""); setQDate(today()); };
    try {
      await api.addQueue(row);
      await refresh();
      clear();
      flash(`${borrower} added to the queue.`);
    } catch (e) {
      if (!isNetworkError(e)) { console.error(e); flash("Save failed — the server rejected it."); return; }
      await enqueue("queue", row, prev => ({
        ...prev,
        queue: [...(prev.queue || []), { ...row, status: "waiting", createdAt: new Date().toISOString(), pending: true }],
      }));
      clear();
      flash(`${borrower} queued offline — syncs when you're back online.`);
    }
  };

  const deleteQueueEntry = async entry => {
    if (entry && entry.pending) { await discardQueued("queue", entry.id); flash("Queued entry discarded."); return; }
    const id = entry && entry.id ? entry.id : entry;
    try { await api.delQueue(id); await refresh(); } catch (e) { console.error(e); flash("Delete failed."); }
  };

  const markQueueFunded = async entry => {
    // A row that hasn't reached the server yet can't be updated there.
    if (entry && entry.pending) { flash("Wait for this entry to sync first."); return; }
    const id = entry && entry.id ? entry.id : entry;
    try { await api.setQueueStatus(id, "funded"); await refresh(); flash("Marked as funded."); }
    catch (e) { console.error(e); flash("Update failed."); }
  };

  const requeue = async id => {
    try { await api.setQueueStatus(id, "waiting"); await refresh(); flash("Moved back to the queue."); }
    catch (e) { console.error(e); flash("Update failed."); }
  };

  // Prefill the New Loan form from a queue entry; the entry is marked funded
  // once the loan is actually saved (see saveLoan).
  const fundFromQueue = entry => {
    setEditId(null);
    setName(entry.borrower);
    setAmount(entry.amount);
    setTerms(6);
    setFlatRate(3.6);
    setDropRate(3.6);
    setFrequency("Semi-Monthly");
    setStartDate(today());
    setFundingQueueId(entry.id);
    setTab("new");
    flash(`Funding ${entry.borrower} — review and save the loan.`);
  };

  // ── Web Push: detect current capability/permission/subscription state ──
  const pushSupported = typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
  useEffect(() => {
    if (!approved) return;
    let alive = true;
    (async () => {
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
      if (!pushSupported) { if (alive) setPushState(isIOS && !standalone ? "ios-hint" : "unsupported"); return; }
      if (Notification.permission === "denied") { if (alive) setPushState("denied"); return; }
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (alive) {
          setPushEndpoint(sub ? sub.endpoint : null);
          setPushState(sub && Notification.permission === "granted" ? "on" : "off");
        }
      } catch { if (alive) setPushState("off"); }
    })();
    return () => { alive = false; };
  }, [approved, pushSupported]);

  const enableAlerts = async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setPushState(perm === "denied" ? "denied" : "off"); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
      await api.savePush(sub);
      setPushEndpoint(sub.endpoint);
      setPushState("on");
      flash("Alerts enabled on this device.");
    } catch (e) { console.error(e); flash("Could not enable alerts."); }
  };
  const disableAlerts = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await api.deletePush(sub.endpoint).catch(() => {}); await sub.unsubscribe(); }
      setPushEndpoint(null);
      setPushState("off");
      flash("Alerts disabled on this device.");
    } catch (e) { console.error(e); flash("Could not disable alerts."); }
  };

  // ── Deep links: notification → open the relevant loan once data is loaded ──
  useEffect(() => {
    if (!pendingLoanRef || !db.loans.length) return;
    const l = db.loans.find(x => x.ref === pendingLoanRef);
    if (l) { setLoanIdOvr(l.ref); setSelBorrower(""); setTab("status"); }
    setPendingLoanRef(null);
    try { history.replaceState(null, "", location.pathname); } catch {}
  }, [pendingLoanRef, db.loans]);

  // Messages from the service worker: a notification click on an already-open
  // tab, or a background-sync wake-up telling us to drain the outbox.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMsg = e => {
      if (!e.data) return;
      if (e.data.type === "flush-outbox") { flushOutbox(); return; }
      if (e.data.type !== "notification-click") return;
      let ref = null;
      try { ref = new URL(e.data.url).searchParams.get("loan"); } catch {}
      if (ref) setPendingLoanRef(ref); else setTab("home");
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [flushOutbox]);

  // Manifest shortcuts land on "?tab=status|new|cashflow" — honour it once.
  useEffect(() => {
    let want = null;
    try { want = new URLSearchParams(location.search).get("tab"); } catch {}
    if (want && ["home", "records", "status", "cashflow", "new", "queue"].includes(want)) setTab(want);
  }, []);

  const exportCsv = () => {
    const esc = v => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const header = ["Date", "Type", "Detail", "Loan ID", "Borrower", "Inflow", "Outflow", "Balance"];
    const rows = cashflow.ledger.slice().reverse().map(t =>
      [t.date, t.kind, t.subtype, t.ref || "", t.borrower, t.inflow, t.outflow, t.balance].map(esc).join(","));
    const csv = [header.join(","), ...rows].join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `cash-flow-${cfAllTime ? "all-time" : cfMonth}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    flash("Exported CSV");
  };

  // A saved entry that the current view filters out reads as "nothing happened":
  // the toast says it saved, the timeline doesn't move. Move the view to the
  // entry instead — switch to its month and drop any filter that would hide it.
  const revealCashEntry = row => {
    if (!cfAllTime && row.date.slice(0, 7) !== cfMonth) setCfMonth(row.date.slice(0, 7));
    if (cfDir !== "all" && cfDir !== row.direction) setCfDir("all");
    if (cfGroup !== "all" && cfGroup !== txnMeta(row.kind).group) setCfGroup("all");
    const q = cfSearch.trim().toLowerCase();
    if (q && !(row.note || "").toLowerCase().includes(q)) setCfSearch("");
  };

  const addTransaction = async () => {
    const amt = Number(txAmount);
    if (!(amt > 0)) { flash("Enter an amount greater than 0."); return; }
    if (!txDate) { flash("Pick a date."); return; }
    const row = { id: uuid(), date: txDate, kind: txCat, direction: txDir(txCat), amount: amt, note: txNote.trim() };
    try {
      await api.addTx(row);
      await refresh();
      setTxAmount(""); setTxNote("");
      revealCashEntry(row);
      flash(row.date === today() ? "Entry added." : `Entry added on ${fmtDate(parseDate(row.date))}.`);
    } catch (e) {
      if (!isNetworkError(e)) { console.error(e); flash("Save failed — the server rejected it."); return; }
      await enqueue("tx", row, prev => ({ ...prev, transactions: [...prev.transactions, { ...row, pending: true }] }));
      setTxAmount(""); setTxNote("");
      revealCashEntry(row);
      flash("Saved offline — syncs when you're back online.");
    }
  };
  const deleteTransaction = async t => {
    if (t && t.pending) { await discardQueued("transactions", t.id); flash("Queued entry discarded."); return; }
    const id = t && t.id ? t.id : t;
    try { await api.delTx(id); await refresh(); } catch (e) { console.error(e); flash("Delete failed."); }
  };
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

  const nextUnpaidRow = useMemo(() => {
    if (!statusData) return null;
    return statusData.rows.find(r => r.amtLeft > 0) || statusData.rows[statusData.rows.length - 1] || null;
  }, [statusData]);

  useEffect(() => {
    if (!nextUnpaidRow) return;
    if (payType === "Standard") {
      setPayAmount(round2(nextUnpaidRow.amtLeft).toFixed(2));
    } else if (payType === "Minimum Due") {
      setPayAmount(round2(nextUnpaidRow.interest).toFixed(2));
    }
  }, [payType, nextUnpaidRow]);

  const addPayment = async () => {
    if (!resolved.loan) return;
    const amt = Number(payAmount);
    if (!(amt > 0)) { flash("Enter a payment amount."); return; }
    if (!payDate) { flash("Pick a payment date."); return; }
    //if (payDate < resolved.loan.startDate) { flash("Payment date is before the loan start."); return; }
    const row = { id: uuid(), loanId: resolved.loan.id, date: payDate, amount: amt, type: payType };
    try {
      await api.addPayment(row);
      buzz();
      await refresh();
      setPayAmount("");
      const over = statusData ? amt - statusData.grandLeft : 0;
      if (over > 0.005) flash(`⚠ Logged ${fmt(amt)} — exceeds balance by ${fmt(over)}`);
      else flash(`Logged ${fmt(amt)}`);
      // Alert this user's *other* devices that a payment came in — skip only
      // the device that just posted. Records are private to their owner, so
      // this is targeted at the current user rather than broadcast to all
      // staff, which would leak the borrower and amount to other users.
      api.notify({
        title: "Payment received",
        body: `${resolved.loan.borrower} paid ${fmt(amt)} · ${resolved.loan.ref}`,
        url: `?loan=${encodeURIComponent(resolved.loan.ref)}`,
        target: session?.user?.id,
        excludeEndpoint: pushEndpoint,
      });
    } catch (e) {
      if (!isNetworkError(e)) { console.error(e); flash("Save failed — the server rejected it."); return; }
      // No signal: bank it locally. The balance, schedule and dues update now;
      // the row syncs itself the moment the phone reconnects.
      await enqueue("payment", row, prev => ({ ...prev, payments: [...prev.payments, { ...row, pending: true }] }));
      buzz();
      setPayAmount("");
      flash(`Saved offline — ${fmt(amt)} syncs when you're back online.`);
    }
  };
  const deletePayment = async p => {
    if (p.pending) { await discardQueued("payments", p.id); flash("Queued payment discarded."); return; }
    try { await api.delPayment(p.id); await refresh(); } catch (e) { console.error(e); flash("Delete failed."); }
  };

  // Draft revision built from the modal inputs — null until it says something.
  const draftRevision = useMemo(() => {
    if (!freqDate) return null;
    const fc = { date: freqDate };
    if (revFreq) fc.frequency = revFreq;
    if (revTerms && Number(revTerms) > 0) fc.terms = Math.floor(Number(revTerms));
    return fc.frequency || fc.terms ? fc : null;
  }, [freqDate, revFreq, revTerms]);

  // Live "what changes" preview for the modal — runs the same engine the saved
  // revision would, so the numbers shown are the numbers you get.
  const revisionPreview = useMemo(() => {
    if (!draftRevision || !resolved.loan || !statusData || resolved.loan.freqChange) return null;
    const next = computeStatus({ ...resolved.loan, freqChange: draftRevision }, db.payments);
    const last = next.rows[next.rows.length - 1];
    return {
      installments: next.rows.length,
      payoff: last ? last.due : null,
      interest: next.summedInterest,
      delta: next.summedInterest - statusData.summedInterest,
      left: next.grandLeft,
    };
  }, [draftRevision, resolved.loan, statusData, db.payments]);

  const applyRevision = async loan => {
    if (!freqDate) { flash("Pick an effective date."); return; }
    const fc = draftRevision;
    if (!fc) { flash("Choose a new frequency and/or number of installments."); return; }
    const desc = [fc.frequency, fc.terms ? `${fc.terms} installments` : null].filter(Boolean).join(", ");
    const note = fc.terms ? "total interest re-prices for the new term" : "same total owed";
    if (!confirm(`Revise ${loan.ref || loan.id} from ${fmtDate(parseDate(freqDate))} → ${desc}? Paid installments stay; the remaining balance re-amortizes (${note}).`)) return;
    try { await api.setFreqChange(loan.id, fc); await refresh(); setRevFreq(""); setRevTerms(""); setReviseOpen(false); flash("Schedule revised."); }
    catch (e) { console.error(e); flash("Could not revise schedule."); }
  };
  const clearRevision = async loan => {
    try { await api.setFreqChange(loan.id, null); await refresh(); setReviseOpen(false); flash("Revision removed."); }
    catch (e) { console.error(e); flash("Could not update."); }
  };

  // Close the revision sheet on Escape / when the selected loan changes.
  useEffect(() => {
    if (!reviseOpen) return;
    const onKey = e => { if (e.key === "Escape") setReviseOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reviseOpen]);
  useEffect(() => { setReviseOpen(false); }, [resolved.loan && resolved.loan.id]);

  // The action sheet follows the live row, so an ID upload (which refreshes db)
  // repaints it in place rather than closing it.
  const sheetLoan = useMemo(() => db.loans.find(l => l.id === sheetLoanId) || null, [db.loans, sheetLoanId]);
  const sheetStatus = useMemo(() => (sheetLoan ? computeStatus(sheetLoan, db.payments) : null), [sheetLoan, db.payments]);

  // Close only when the loan is really gone (deleted), on tab change, or Escape.
  // Deliberately NOT on every db change — that would eject the user mid-upload.
  useEffect(() => { if (sheetLoanId && !sheetLoan) setSheetLoanId(null); }, [sheetLoanId, sheetLoan]);
  useEffect(() => { setSheetLoanId(null); }, [tab]);

  // The preview holds an object URL, so closing it has to revoke rather than
  // just null the state — on Escape, on leaving the tab, and on unmount.
  useEffect(() => {
    if (!shareImg) return;
    const onKey = e => { if (e.key === "Escape") closeShareImg(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shareImg]);
  useEffect(() => { closeShareImg(); }, [tab]);
  useEffect(() => () => { if (shareImg) URL.revokeObjectURL(shareImg.url); }, []);
  useEffect(() => {
    if (!sheetLoanId) return;
    const onKey = e => { if (e.key === "Escape") setSheetLoanId(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetLoanId]);

  const loanPayments = resolved.loan ? db.payments.filter(p => p.loanId === resolved.loan.id).sort((a, b) => a.date < b.date ? -1 : 1) : [];

  // Reset scroll to top whenever the tab changes (better mobile flow)
  const mainRef = useRef(null);
  useEffect(() => { if (mainRef.current) mainRef.current.scrollTop = 0; }, [tab]);

  // Pull-to-refresh (native pull-to-refresh is disabled via overscroll-behavior).
  const pull = useRef({ y0: 0, active: false, dist: 0 });
  const [pullDist, setPullDist] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const onPullStart = e => { const m = mainRef.current; if (m && m.scrollTop <= 0 && !refreshing) pull.current = { y0: e.touches[0].clientY, active: true, dist: 0 }; };
  const onPullMove = e => {
    if (!pull.current.active) return;
    const d = e.touches[0].clientY - pull.current.y0;
    if (d > 0 && mainRef.current && mainRef.current.scrollTop <= 0) { pull.current.dist = d; setPullDist(Math.min(d, 90)); }
    else if (d <= 0) { pull.current.active = false; if (pullDist) setPullDist(0); }
  };
  const onPullEnd = async () => {
    if (!pull.current.active) return;
    const trigger = pull.current.dist > 60;
    pull.current.active = false; setPullDist(0);
    if (trigger && !refreshing) {
      setRefreshing(true); buzz(8);
      try { await flushOutbox(); await refresh(); } catch (e) { console.error(e); }
      setRefreshing(false);
    }
  };
  // Keep Lucide icons rendered across tab switches / re-renders
  useEffect(() => { if (window.lucide) lucide.createIcons(); });

  // ── Bottom nav ── four primary destinations, split around a center FAB
  // (New Loan). Queue / Agreement / Status detail are reached contextually.
  const navItems = [
    { id: "home",     label: "Home",      icon: "layout-dashboard" },
    { id: "records",  label: "Loans",     icon: "file-text" },
    { id: "status",   label: "Payments",  icon: "wallet" },
    { id: "cashflow", label: "Cash Flow", icon: "trending-up" },
  ];

  return (
    <div className="flex flex-col min-h-screen font-sans">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur border-b border-slate-100 px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-bold text-sm shadow-sm">OLC</div>
          <div>
            <p className="font-bold text-sm leading-tight text-slate-800">JAVILAT LENDING</p>
            <p className="text-slate-400 text-xs flex items-center gap-1.5">
              {loading ? "Connecting…" : <><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {db.loans.length} loan{db.loans.length !== 1 ? "s" : ""} synced</>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && <button onClick={openAdmin} className="px-3 py-1.5 rounded-lg border border-slate-100 text-slate-500 text-xs font-semibold active:bg-slate-100 transition">Admin</button>}
          {session && !session.user.is_anonymous && <button onClick={signOut} title={session.user.email} className="px-3 py-1.5 rounded-lg border border-slate-100 text-slate-500 text-xs font-semibold active:bg-slate-100 transition">Sign out</button>}
        </div>
      </header>

      {/* Connection / sync strip — only present when there's something to say. */}
      {(!online || queued.length > 0 || syncing) && (
        <div className={`px-4 py-2 flex items-center gap-2 text-xs font-medium border-b ${
          !online ? "bg-amber-50 border-amber-100 text-amber-800" : "bg-sky-50 border-sky-100 text-sky-800"}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${!online ? "bg-amber-500" : "bg-sky-500 animate-pulse"}`} />
          <span className="flex-1 min-w-0 truncate">
            {syncing ? "Syncing queued entries…"
              : !online ? (queued.length
                  ? `Offline · ${queued.length} entr${queued.length === 1 ? "y" : "ies"} saved on this device`
                  : "Offline — your work is saved on this device")
              : `${queued.length} entr${queued.length === 1 ? "y" : "ies"} waiting to sync`}
          </span>
          {online && !syncing && queued.length > 0 && (
            <button onClick={() => flushOutbox()} className="px-2.5 py-1 rounded-lg bg-sky-600 text-white text-[11px] font-semibold active:bg-sky-700 transition shrink-0">Sync now</button>
          )}
        </div>
      )}

      {/* Body */}
      <main ref={mainRef} onTouchStart={onPullStart} onTouchMove={onPullMove} onTouchEnd={onPullEnd} className="flex-1 overflow-y-auto scroll-ios px-4 py-4 pb-24 space-y-4">
        {(pullDist > 0 || refreshing) && (
          <div className="flex items-center justify-center text-slate-400 text-xs overflow-hidden" style={{ height: refreshing ? 28 : Math.min(pullDist, 60) }}>
            <span className={refreshing ? "animate-pulse" : ""}>{refreshing ? "Refreshing…" : pullDist > 60 ? "Release to refresh ↑" : "Pull to refresh ↓"}</span>
          </div>
        )}
        <div key={tab} className="space-y-4 animate-fade-in">

        {/* ── HOME / DASHBOARD ── */}
        {tab === "home" && (
          <div className="mx-auto w-full max-w-6xl space-y-4">

            {/* One compact line — the app header directly above already carries
                the business name, so this doesn't repeat it. */}
            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="min-w-0">
                <p className="text-lg font-bold text-slate-800 leading-tight truncate">{greeting()}{firstName(session && session.user && session.user.email) ? `, ${firstName(session.user.email)}` : ""}</p>
                <p className="text-xs text-slate-400">{fmtDate(new Date())}</p>
              </div>
              {pushState === "on" ? (
                <button onClick={disableAlerts} title="Tap to turn off alerts" className="flex items-center gap-1.5 bg-emerald-50 text-emerald-700 text-xs font-semibold px-3 py-1.5 rounded-full active:bg-emerald-100 transition shrink-0">
                  <i data-lucide="bell" className="w-3.5 h-3.5"></i> Alerts on
                </button>
              ) : (
                <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold shrink-0">
                  {(((session && session.user && session.user.email) || "?").trim()[0] || "?").toUpperCase()}
                </div>
              )}
            </div>

            {loading ? <ScreenSkeleton label="Loading dashboard" tiles={3} chart={false} />
            : db.loans.length === 0 ? (
              <div className={cardCls}>
                <EmptyPanel icon="file-text" title="No loans yet"
                  body="Create your first loan and this screen will show your cash, who owes what, and who to collect from today."
                  action="Create your first loan" onAction={() => { resetForm(); setTab("new"); }} />
              </div>
            ) : (

            <div className="space-y-4 md:space-y-0 md:grid md:grid-cols-12 md:gap-4 md:items-start">

              {/* ── CASH ON HAND — the number a lender acts on ── */}
              <div className={`${cardCls} p-5 sm:p-6 md:col-span-5`}>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Cash on Hand</p>
                <p className={`mt-1.5 ${heroSize(dashboard.cash)} leading-none font-bold tabular-nums ${dashboard.cash < 0 ? "text-red-600" : "text-slate-800"}`}>{fmt(dashboard.cash)}</p>
                <p className="mt-2.5 text-xs text-slate-400">
                  {dashboard.collectedToday > 0
                    ? <><span className="font-semibold text-emerald-600 tabular-nums">+{fmt(dashboard.collectedToday)}</span> collected today</>
                    : "Nothing collected yet today"}
                </p>
                <div className="mt-4 pt-3.5 border-t border-slate-100 space-y-1.5">
                  <p className="text-xs text-slate-400 leading-relaxed">Money you can lend today. Cash already with borrowers is <span className="font-semibold text-slate-500">not</span> counted here.</p>
                  {queueView.rows.length > 0 && (
                    <button onClick={() => setTab("queue")} className="text-xs font-semibold text-emerald-600 active:opacity-70 flex items-center gap-1">
                      {queueView.readyCount} of {queueView.rows.length} in the queue ready to fund
                      <i data-lucide="chevron-right" className="w-3.5 h-3.5"></i>
                    </button>
                  )}
                </div>
              </div>

              {/* ── The day's job, in three numbers. Each jumps to its section. ── */}
              <div className={`${cardCls} overflow-hidden md:col-span-7`}>
                <div className="divide-y divide-slate-100 sm:divide-y-0 sm:grid sm:grid-cols-3 sm:divide-x sm:divide-slate-100">
                  {[
                    ["overdue", "Overdue", "alert-triangle", dashboard.overdueAmt, dashboard.overdueCount, "text-red-600", "text-red-700"],
                    ["today", "Due today", "calendar-clock", dashboard.todayAmt, dashboard.todayCount, "text-emerald-600", "text-slate-800"],
                    ["week", "This week", "calendar-days", dashboard.weekAmt, dashboard.weekCount, "text-sky-600", "text-slate-800"],
                  ].map(([k, label, icon, amt, n, iconTone, valTone]) => (
                    <button key={k} onClick={() => scrollToBucket(k)} disabled={n === 0}
                      className="w-full px-4 py-3 flex items-center justify-between gap-2 text-left transition active:bg-slate-50 disabled:active:bg-transparent sm:block">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        <i data-lucide={icon} className={`w-3.5 h-3.5 ${n > 0 ? iconTone : "text-slate-300"}`}></i>{label}
                      </span>
                      <span className="text-right sm:text-left sm:block sm:mt-1">
                        <span className={`block font-bold tabular-nums ${n > 0 ? valTone : "text-slate-400"}`}>{fmt(amt)}</span>
                        <span className="block text-[11px] text-slate-400">{n} borrower{n !== 1 ? "s" : ""}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Collections — every borrower in exactly one urgency bucket ──
                  No overflow-hidden: it would become the scroll container for the
                  sticky section headings and pin them in place. */}
              <div className={`${cardCls} md:col-span-7`}>
                <div className="px-4 py-3 border-b border-slate-100">
                  <CardHead title="Collections"
                    hint={dashboard.dueCount ? `${dashboard.dueCount} borrower${dashboard.dueCount !== 1 ? "s" : ""} with something outstanding` : undefined} />
                </div>
                {dashboard.dueCount === 0 ? (
                  <EmptyPanel icon="check" title="All caught up"
                    body="Nobody owes anything right now. New dues appear here as their dates come round."
                    action="Add a borrower to the queue" onAction={() => setTab("queue")} />
                ) : DUE_BUCKETS.map(([k, label]) => {
                  const g = dashboard.groups[k];
                  if (!g.rows.length) return null;
                  const collapsible = k === "later" && g.rows.length > 5;
                  const rows = collapsible && !homeShowLater ? g.rows.slice(0, 5) : g.rows;
                  return (
                    <section key={k} ref={el => { dueSectionRefs.current[k] = el; }}>
                      <div className="sticky top-0 z-[1] px-4 py-1.5 bg-slate-50 border-y border-slate-100 flex items-center justify-between gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label} · {g.rows.length}</p>
                        <p className={`text-[11px] font-semibold tabular-nums ${k === "overdue" ? "text-red-600" : "text-slate-500"}`}>{fmt(g.total)}</p>
                      </div>
                      <ul className="divide-y divide-slate-50">
                        {rows.map(r => (
                          <li key={r.loanId}>
                            <button onClick={() => { setLoanIdOvr(r.ref); setSelBorrower(""); setTab("status"); }}
                              className="w-full text-left px-4 py-2.5 flex items-center gap-3 active:bg-slate-50 transition">
                              <Avatar name={r.borrower} />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-slate-800 truncate">{r.borrower}</p>
                                <p className={`text-[11px] truncate ${k === "overdue" ? "text-red-600 font-medium" : "text-slate-400"}`}>{r.ref} · {r.hint}</p>
                              </div>
                              <p className={`text-sm font-bold tabular-nums shrink-0 ${k === "overdue" ? "text-red-700" : "text-slate-800"}`}>{fmt(r.amount)}</p>
                              <i data-lucide="chevron-right" className="w-4 h-4 text-slate-300 shrink-0"></i>
                            </button>
                          </li>
                        ))}
                      </ul>
                      {collapsible && (
                        <button onClick={() => setHomeShowLater(v => !v)}
                          className="w-full py-2.5 text-xs font-semibold text-slate-500 border-t border-slate-50 active:bg-slate-50 transition">
                          {homeShowLater ? "Show less" : `Show all ${g.rows.length} later dues`}
                        </button>
                      )}
                    </section>
                  );
                })}
              </div>

              <div className="space-y-4 md:col-span-5">
                {/* Portfolio context — kept, but out of the action zone. */}
                <div className={`${cardCls} p-4`}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Portfolio</p>
                  <div className="mt-1.5 divide-y divide-slate-100">
                    {[
                      ["Outstanding", fmt(dashboard.outstanding), "principal + interest still owed"],
                      ["Active loans", String(dashboard.activeCount), `${dashboard.paidCount} fully paid`],
                      ["Collected all time", fmt(dashboard.collectedAll), null],
                    ].map(([label, value, hint]) => (
                      <div key={label} className="flex items-baseline justify-between gap-3 py-2">
                        <span className="text-xs text-slate-500 min-w-0">
                          {label}
                          {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
                        </span>
                        <span className="text-sm font-bold tabular-nums text-slate-800 shrink-0">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Queue entry (always reachable from Home) */}
                <button onClick={() => setTab("queue")} className={`w-full ${cardCls} px-4 py-3.5 flex items-center justify-between active:bg-slate-50 transition text-left`}>
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center shrink-0"><i data-lucide="users" className="w-4 h-4"></i></div>
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800">Borrower Queue</p>
                      <p className="text-xs text-slate-400 truncate">{queueView.rows.length === 0 ? "No one waiting — tap to add" : `${queueView.rows.length} waiting · ${queueView.readyCount} ready to fund`}</p>
                    </div>
                  </div>
                  <i data-lucide="chevron-right" className="w-5 h-5 text-slate-300 shrink-0"></i>
                </button>
              </div>

            </div>
            )}

            {/* Setup nudges sit below the day's work — they are one-time chores,
                not something to scroll past every morning. */}
            {/* Enable alerts (Web Push) — full card only when not already on */}
            {!loading && pushState !== "loading" && pushState !== "unsupported" && pushState !== "on" && (
            pushState === "ios-hint" ? (
              <div className="bg-amber-50 border border-amber-100 rounded-2xl px-4 py-3">
                <p className="text-sm font-semibold text-amber-800 flex items-center gap-2"><i data-lucide="bell" className="w-4 h-4"></i> Turn on alerts</p>
                <p className="text-xs text-amber-700 mt-0.5">On iPhone, alerts work only when this app is added to your Home Screen. Tap <b>Share → Add to Home Screen</b>, open it from there, then enable alerts.</p>
              </div>
            ) : pushState === "denied" ? (
              <div className="bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3">
                <p className="text-sm font-semibold text-slate-700 flex items-center gap-2"><i data-lucide="bell-off" className="w-4 h-4"></i> Alerts are blocked</p>
                <p className="text-xs text-slate-500 mt-0.5">Notifications are turned off in your browser settings for this site. Re-enable them there, then reload.</p>
              </div>
            ) : (
              <button onClick={enableAlerts} className={`w-full ${cardCls} px-4 py-3 flex items-center justify-between gap-3 active:bg-slate-50 transition`}>
                <span className="text-sm font-semibold text-emerald-700 flex items-center gap-2"><i data-lucide="bell" className="w-4 h-4"></i> Enable alerts on this device</span>
                <i data-lucide="chevron-right" className="w-5 h-5 text-slate-300"></i>
              </button>
            )
          )}

            {/* Install to home screen. Chromium hands us a deferred prompt; iOS has
                no such API, so those users get the Share-sheet instructions. */}
            {!loading && showInstallCard && (
            <div className={`${cardCls} p-4 space-y-3`}>
              <div className="flex items-start gap-3">
                <img src="icons/icon-96.png" alt="" className="w-11 h-11 rounded-xl shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-slate-800 text-sm">Install Ohana on this device</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {installPrompt
                      ? "Full screen, opens instantly, and keeps working without a signal."
                      : "Tap Share, then “Add to Home Screen” — that also unlocks alerts on iPhone."}
                  </p>
                </div>
                <button onClick={snoozeInstall} aria-label="Dismiss" className="text-slate-300 text-sm px-1 shrink-0">✕</button>
              </div>
              {installPrompt && (
                <div className="flex gap-2">
                  <button onClick={snoozeInstall} className="px-4 py-2.5 rounded-xl border border-slate-200 text-slate-500 text-sm font-semibold active:bg-slate-100 transition">Not now</button>
                  <button onClick={runInstall} className="flex-1 py-2.5 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold transition">Install app</button>
                </div>
              )}
            </div>
          )}

          </div>
        )}

        {/* ── NEW LOAN ── */}
        {tab === "new" && (<>
          <div className="bg-white rounded-2xl border border-slate-100 p-4 space-y-3 shadow-sm">
            <p className="font-semibold text-slate-800">{editId ? `Edit Loan · ${editId}` : "Loan Details"}</p>
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
                {FREQUENCIES.map(f => <option key={f}>{f}</option>)}
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
              <button onClick={resetForm} className="px-4 py-3 rounded-xl border border-slate-200 active:bg-slate-100 text-slate-600 text-sm font-medium transition">{editId ? "Cancel" : "Reset"}</button>
            </div>
          </div>

          

          {calc.rows.length > 0 && (
            <div id="projected-export" className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-slate-800">Projected Schedule</p>
                  <p className="text-xs text-slate-500">{name.trim() || "Unnamed"}</p>
                </div>
                <button onClick={exportSchedulePng} disabled={exportBusy}
                  className="no-capture shrink-0 min-h-[44px] px-4 rounded-xl bg-emerald-50 text-emerald-700 text-sm font-semibold flex items-center gap-2 active:bg-emerald-100 disabled:opacity-60 transition">
                  <i data-lucide={exportBusy ? "loader" : "image-down"} className={`w-4 h-4 ${exportBusy ? "animate-spin" : ""}`}></i>
                  {exportBusy ? "Preparing…" : "Save image"}
                </button>
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

          {calc.rows.length > 0 && (<div className="animate-scale-in space-y-3">
            <div className="flex flex-col items-center gap-2 pt-1">
              <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center"><i data-lucide="check" className="w-6 h-6 text-emerald-600" style={{ strokeWidth: 2.5 }}></i></div>
              <p className="text-xs text-slate-500">{Math.floor(Number(terms) || 0)} {frequency} payments · {flatRate}% flat</p>
            </div>
            <div className={`${cardCls} p-4`}>
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-slate-500">Total repayment</span>
                <span className="text-2xl font-bold tabular-nums text-slate-800">{fmt(calc.totalRepay)}</span>
              </div>
              <div className="flex justify-between items-baseline pt-3 mt-3 border-t border-slate-50">
                <span className="text-sm text-slate-500">Interest earned</span>
                <span className="text-lg font-bold tabular-nums text-emerald-600">+{fmt(calc.totalInterest)}</span>
              </div>
              <div className="flex justify-between mt-2.5 text-xs text-slate-400 tabular-nums">
                <span>Principal {fmt(amount)}</span>
                <span>{calc.rows.length} installment{calc.rows.length !== 1 ? "s" : ""}</span>
              </div>
            </div>
          </div>)}

        </>)}

        {/* ── RECORDS ── */}
        {tab === "records" && (
          <div className="mx-auto w-full max-w-6xl space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="font-semibold text-slate-800 min-w-0 truncate">
                {loading ? "Loans"
                  : filteredLoans.length === db.loans.length ? `${db.loans.length} Loan${db.loans.length !== 1 ? "s" : ""}`
                  : `${filteredLoans.length} of ${db.loans.length} loans`}
              </p>
              {/* resetForm() matters: without it, tapping this right after an
                  Edit reopens the form still bound to that loan. */}
              <button onClick={() => { resetForm(); setTab("new"); }} className="px-3.5 py-2 rounded-lg bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold transition shrink-0">+ New</button>
            </div>
            {canImport && <button onClick={importLocal} className="w-full py-2 rounded-xl border border-amber-300 bg-amber-50 text-amber-700 text-xs font-semibold active:bg-amber-100 transition">⤓ Import {localBackup.loans.length} loan(s) saved on this device</button>}

            {loading ? <ScreenSkeleton label="Loading loans" tiles={2} chart={false} />
            : db.loans.length === 0 ? (
              <div className={cardCls}>
                <EmptyPanel icon="file-text" title="No loans yet"
                  body="Create your first loan and it will appear here with its balance, its next due date, and how far along it is."
                  action="Create your first loan" onAction={() => { resetForm(); setTab("new"); }} />
              </div>
            ) : (<>

              {/* Portfolio totals in one strip. The four stat tiles this replaced
                  repeated the Portfolio card on Home and pushed the first loan
                  below the fold. */}
              <div className={`${cardCls} px-4 py-3`}>
                <div className="grid grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Outstanding</p>
                    <p className="mt-0.5 text-lg font-bold tabular-nums text-amber-600 truncate">{fmt(portfolio.outstanding)}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Collected</p>
                    <p className="mt-0.5 text-lg font-bold tabular-nums text-emerald-600 truncate">{fmt(portfolio.collected)}</p>
                  </div>
                </div>
                <p className="mt-2 pt-2 border-t border-slate-50 text-xs text-slate-400">
                  {portfolio.active} active ·{" "}
                  <span className={portfolio.overdue > 0 ? "font-semibold text-red-600" : ""}>{portfolio.overdue} overdue</span>
                  {" "}· {db.loans.length - portfolio.active} fully paid
                </p>
              </div>

              {/* Stays put while the list scrolls — past a dozen loans the search
                  box would otherwise mean scrolling back to the top. bg-white/90
                  is remapped to the page ground in dark, so this reads as the page
                  rather than as another card. */}
              <div className="sticky top-0 z-[2] -mx-4 px-4 py-2 bg-white/90 backdrop-blur space-y-2">
                <Segmented value={recordFilter} onChange={setRecordFilter} options={[
                  ["active", `Active ${portfolio.active}`],
                  ["overdue", `Overdue ${portfolio.overdue}`],
                  ["paid", `Paid ${db.loans.length - portfolio.active}`],
                  ["all", `All ${db.loans.length}`],
                ]} />
                <div className="flex items-center gap-2">
                  <div className="relative flex-1 min-w-0">
                    <i data-lucide="search" className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"></i>
                    <input value={recordSearch} onChange={e => setRecordSearch(e.target.value)} placeholder="Search name or OL-####"
                      className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-100 bg-white text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 transition" />
                  </div>
                  <select aria-label="Sort loans" value={recordSort} onChange={e => setRecordSort(e.target.value)}
                    className="shrink-0 px-2.5 py-2.5 rounded-xl border border-slate-100 bg-white text-xs font-medium text-slate-500 outline-none focus:border-emerald-500 transition">
                    <option value="ref">Loan ID</option>
                    <option value="urgent">Most urgent</option>
                    <option value="balance">Balance</option>
                    <option value="name">Name</option>
                  </select>
                </div>
              </div>

              {filteredLoans.length === 0 ? (
                <div className={cardCls}>
                  {recordSearch
                    ? <EmptyPanel icon="search" title={`No loans match “${recordSearch}”`}
                        body="Try part of a borrower's name, or a loan number like OL-0007."
                        action="Clear search" onAction={() => setRecordSearch("")} />
                    : <EmptyPanel icon={recordFilter === "overdue" ? "check" : "inbox"}
                        title={recordFilter === "overdue" ? "Nothing overdue"
                          : recordFilter === "paid" ? "No loans fully paid yet" : "No active loans"}
                        body={recordFilter === "overdue" ? "Every borrower is up to date on their installments." : undefined}
                        action="Show all loans" onAction={() => setRecordFilter("all")} />}
                </div>
              ) : (
                <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                  {/* Two tap targets per row, always: the row opens Payments and
                      ⋯ opens the loan’s action sheet. Siblings, never nested. */}
                  {filteredLoans.map(({ l, s, paid, overdue, hint, pct }, i) => (
                    <div key={l.id} style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }} className={`${cardCls} relative animate-fade-up`}>
                      <button type="button" aria-haspopup="dialog" aria-label={`More actions for ${l.borrower}`}
                        onClick={() => { buzz(8); setSheetLoanId(l.id); }}
                        className="absolute right-0.5 top-1/2 -translate-y-1/2 h-11 w-10 rounded-full flex items-center justify-center text-slate-400 active:bg-slate-100 transition">
                        <i data-lucide="more-vertical" className="w-5 h-5"></i>
                      </button>

                      <button type="button" onClick={() => openPayments(l)}
                        className="w-full text-left px-3.5 py-3 pr-11 flex items-start gap-3 rounded-2xl active:bg-slate-50 transition">
                        <Avatar name={l.borrower} />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="font-bold text-slate-800 truncate min-w-0">{l.borrower}</p>
                            <p className={`text-sm font-bold tabular-nums shrink-0 ${paid ? "text-emerald-600" : overdue ? "text-red-600" : "text-slate-800"}`}>
                              {paid ? "Settled" : <>{fmt(s.grandLeft)} <span className="font-medium text-slate-400">left</span></>}
                            </p>
                          </div>
                          {/* Overdue says so three ways — the word, the icon and the
                              colour — so the reading never rests on colour alone. */}
                          <p className={`flex items-center gap-1 text-[11px] min-w-0 ${overdue ? "text-red-600 font-medium" : "text-slate-400"}`}>
                            {overdue && <i data-lucide="alert-triangle" className="w-3 h-3 shrink-0"></i>}
                            <span className="truncate">{l.ref || l.id} · {hint}{l.freqChange ? " · Revised" : ""}</span>
                          </p>
                          <div className="flex items-center gap-2 pt-0.5">
                            <div className="flex-1 min-w-0"><ProgressBar pct={pct} tone={paid ? "emerald" : overdue ? "red" : "emerald"} /></div>
                            <span className="text-[11px] tabular-nums text-slate-400 shrink-0">
                              {Math.round(pct * 100)}%
                              <span className="hidden sm:inline"> · {fmt(s.totalLogged)} of {fmt(Number(l.amount) + s.summedInterest)}</span>
                              <span className="sm:hidden"> repaid</span>
                            </span>
                          </div>
                        </div>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>)}
          </div>
        )}

        {/* ── STATUS ── */}
        {tab === "status" && (<>
          <div className="bg-white rounded-2xl border border-slate-100 p-4 grid grid-cols-2 gap-3 shadow-sm">
            <p className="col-span-2 font-semibold text-slate-800">Find Loan</p>
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

          {resolved.prompt && <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center text-slate-400 text-sm">Select a borrower or enter a Loan ID.</div>}
          {resolved.error && <div className="bg-white rounded-2xl border border-amber-200 p-6 text-center text-amber-600 font-medium text-sm">{resolved.error}</div>}

          {resolved.loan && statusData && (<>
            <div className="bg-white rounded-2xl border border-slate-100 p-4 shadow-sm space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar name={resolved.loan.borrower} size="w-10 h-10" />
                  <div className="min-w-0">
                    <p className="text-xs text-emerald-600 font-semibold">{resolved.loan.ref || resolved.loan.id}</p>
                    <p className="font-bold truncate">{resolved.loan.borrower}</p>
                    <p className="text-xs text-slate-500 tabular-nums">{fmt(resolved.loan.amount)} · {resolved.loan.terms} terms · {resolved.loan.flatRate}%</p>
                  </div>
                </div>
                <Badge s={statusData.overallStatus} />
              </div>
              {(() => { const tot = Number(resolved.loan.amount) + statusData.summedInterest; const pct = statusData.totalLogged / (tot || 1); return (
                <div>
                  <div className="flex justify-between text-xs text-slate-400 mb-1"><span className="tabular-nums">{fmt(statusData.totalLogged)} paid</span><span className="tabular-nums">{fmt(statusData.grandLeft)} left · {Math.round(pct * 100)}%</span></div>
                  <ProgressBar pct={pct} tone="emerald" />
                </div>
              ); })()}

              {/* Schedule terms + entry point to the revision sheet — one slim row
                  instead of a full card, since revising is a rare action. */}
              <button onClick={() => setReviseOpen(true)}
                className="w-full flex items-center gap-2 pt-3 border-t border-slate-50 text-left active:opacity-60 transition">
                <i data-lucide="calendar-clock" className="w-4 h-4 text-slate-400 shrink-0"></i>
                <span className="flex-1 min-w-0 text-xs text-slate-500 truncate">
                  {resolved.loan.freqChange
                    ? <span className="font-medium text-emerald-700">{resolved.loan.freqChange.frequency || resolved.loan.frequency}{resolved.loan.freqChange.terms ? ` · ${resolved.loan.freqChange.terms} installments` : ""}</span>
                    : <>{resolved.loan.frequency} · {resolved.loan.terms} terms</>}
                </span>
                {resolved.loan.freqChange && <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 text-[10px] font-semibold shrink-0">Revised</span>}
                <span className="text-xs font-semibold text-emerald-600 shrink-0">Revise</span>
                <i data-lucide="chevron-right" className="w-4 h-4 text-slate-300 shrink-0"></i>
              </button>
            </div>

            {/* Schedule */}
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              <p className="px-4 py-3 font-semibold text-slate-800 border-b border-slate-100">Schedule & Status</p>
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
            <div className="bg-white rounded-2xl border border-slate-100 p-4 space-y-3 shadow-sm">
              <p className="font-semibold text-slate-800">Log a Payment</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Amount</label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">{sym}</span>
                    <input type="number" inputMode="decimal" className={`${inputCls} pl-8`} value={payAmount} onChange={e => setPayAmount(e.target.value)} placeholder="0.00" />
                  </div>
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
                    <div key={p.id} className={`flex items-center justify-between rounded-xl px-3 py-2 text-xs ${p.pending ? "bg-amber-50 border border-amber-100" : "bg-slate-50"}`}>
                      <span className="font-semibold">{fmt(p.amount)}</span>
                      <span className="text-slate-500 flex items-center gap-1.5">
                        {p.pending && <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold">Queued</span>}
                        {p.type} · {fmtDate(parseDate(p.date))}
                      </span>
                      <button onClick={() => deletePayment(p)} className="text-red-400 pl-2 text-base leading-none">×</button>
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
        {tab === "cashflow" && (
          <div className="mx-auto w-full max-w-6xl space-y-4">

            {/* ── Period header ── opens on the whole record; narrowing to one
                month is an explicit choice, not a toggle you have to guess at. */}
            <div className={`${cardCls} p-4 space-y-3`}>
              <div className="min-w-0">
                <p className="text-lg font-bold text-slate-800 leading-tight">Cash Flow</p>
                <p className="text-xs text-slate-400 mt-0.5">{cfAllTime ? "Every movement on record" : `${fmtDate(parseDate(cashflow.start))} – ${fmtDate(parseDate(cashflow.end))}`}</p>
              </div>
              <Segmented value={cfAllTime ? "all" : "month"} onChange={v => { buzz(); setCfAllTime(v === "all"); }}
                options={[["all", "All time"], ["month", "By month"]]} />
              {!cfAllTime && (
                <div className="flex items-center gap-2">
                  <button onClick={() => { buzz(); setCfMonth(m => shiftMonth(m, -1)); }} aria-label="Previous month"
                    className="w-11 h-11 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center active:bg-slate-200 transition shrink-0">
                    <i data-lucide="chevron-left" className="w-5 h-5"></i>
                  </button>
                  <button onClick={() => { if (cfMonth !== thisMonth) { buzz(); setCfMonth(thisMonth); } }}
                    disabled={cfMonth === thisMonth}
                    className="flex-1 min-w-0 h-11 rounded-xl flex flex-col items-center justify-center disabled:opacity-100 active:bg-slate-50 transition">
                    <span className="font-semibold text-slate-800 text-sm truncate">{monthLabelLong(cfMonth)}</span>
                    {cfMonth !== thisMonth && <span className="text-[10px] text-emerald-600 font-medium leading-none mt-0.5">Tap for this month</span>}
                  </button>
                  <button onClick={() => { buzz(); setCfMonth(m => shiftMonth(m, 1)); }} aria-label="Next month"
                    className="w-11 h-11 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center active:bg-slate-200 transition shrink-0">
                    <i data-lucide="chevron-right" className="w-5 h-5"></i>
                  </button>
                </div>
              )}
            </div>

            {/* Stale-data notice — the snapshot is already painted, so say what
                is on screen rather than replacing it with an error. */}
            {loadError && cashflow.hasAnyActivity && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2.5">
                <i data-lucide="wifi-off" className="w-4 h-4 text-amber-700 mt-0.5 shrink-0"></i>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-amber-800">Showing your last synced figures</p>
                  <p className="text-xs text-amber-700 mt-0.5">We couldn&rsquo;t reach the server, so newer entries may be missing.</p>
                </div>
                <button onClick={() => refresh().then(() => setLoadError(false)).catch(() => flash("Still can't reach the server."))}
                  className="px-2.5 py-1 rounded-lg bg-amber-600 text-white text-[11px] font-semibold active:bg-amber-700 transition shrink-0">Retry</button>
              </div>
            )}

            {loading ? <ScreenSkeleton label="Loading cash flow" />
            : loadError && !cashflow.hasAnyActivity ? (
              <div className={cardCls}>
                <EmptyPanel icon="wifi-off" title="We couldn't load your cash flow"
                  body="Check your connection and try again. Nothing you've entered has been lost."
                  action="Try again" onAction={() => refresh().then(() => setLoadError(false)).catch(() => flash("Still can't reach the server."))} />
              </div>
            )
            : !cashflow.hasAnyActivity ? (
              <div className={cardCls}>
                <EmptyPanel icon="trending-up" title="No cash flow yet"
                  body="Your cash movements from loan releases and collections will appear here. You can also record capital, fees and expenses by hand."
                  action="Record a cash entry" onAction={() => setCfEntryOpen(true)} />
              </div>
            ) : (

            /* Mobile reads this top-to-bottom; on large screens the same cards
               pair off into two columns instead of one long ribbon. */
            <div className="space-y-4 md:space-y-0 md:grid md:grid-cols-12 md:gap-4 md:items-start">

              {/* ── 1 · AVAILABLE CASH — the one number that dominates ── */}
              <div className={`${cardCls} p-5 sm:p-6 md:col-span-6 lg:col-span-5`}>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Cash on Hand</p>
                <p className={`mt-1.5 ${heroCls} leading-none font-bold tabular-nums ${cashflow.balance < 0 ? "text-red-600" : "text-slate-800"}`}>{fmt(cashflow.balance)}</p>
                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold tabular-nums ${
                    cashflow.net >= 0 ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>
                    <i data-lucide={cashflow.net >= 0 ? "trending-up" : "trending-down"} className="w-3.5 h-3.5"></i>
                    {cashflow.net >= 0 ? "+" : "−"}{fmt(Math.abs(cashflow.net))}
                  </span>
                  <span className="text-xs text-slate-400">{cfAllTime ? "all time" : `in ${monthLabelLong(cfMonth)}`}</span>
                </div>
                {cashflow.pctChange !== null && Math.abs(cashflow.pctChange) >= 0.05 && (
                  <p className="mt-2 text-xs text-slate-400">
                    {cashflow.pctChange >= 0 ? "↑" : "↓"} {Math.abs(cashflow.pctChange).toFixed(1)}% from {fmt(cashflow.openingForPeriod)}{cfAllTime ? " initial capital" : " at the start of the period"}
                  </p>
                )}
                {periodIsPast && (
                  <p className="mt-2 text-xs text-slate-400">Cash at the close of {monthLabelLong(cfMonth)}: <span className="font-semibold text-slate-600 tabular-nums">{fmt(cashflow.openingForPeriod + cashflow.net)}</span></p>
                )}
                <div className="mt-4 pt-3.5 border-t border-slate-100 space-y-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="cf-opening" className="min-w-0">
                      <span className="block text-xs font-medium text-slate-500">Initial capital</span>
                      <span className="block text-[11px] text-slate-400">Cash you held before these records</span>
                    </label>
                    <input id="cf-opening" type="number" inputMode="decimal" value={openingInput}
                      onChange={e => setOpeningInput(e.target.value)} onBlur={commitOpening} placeholder="0.00"
                      className="w-32 shrink-0 px-3 py-2 rounded-xl border border-slate-100 bg-white focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 outline-none text-sm text-right text-slate-800 transition" />
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">Money you can lend today. Cash already with borrowers is <span className="font-semibold text-slate-500">not</span> counted here.</p>
                  {queueView.rows.length > 0 && (
                    <button onClick={() => setTab("queue")} className="text-xs font-semibold text-emerald-600 active:opacity-70 flex items-center gap-1">
                      {queueView.readyCount} of {queueView.rows.length} in the queue ready to fund
                      <i data-lucide="chevron-right" className="w-3.5 h-3.5"></i>
                    </button>
                  )}
                </div>
              </div>

              {/* ── 2 · MONEY IN − MONEY OUT = NET ── */}
              <div className={`${cardCls} p-4 space-y-3 md:col-span-6 lg:col-span-7`}>
                <CardHead title="Cash flow summary" hint={cfAllTime ? "All recorded movements" : monthLabelLong(cfMonth)} />
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      <i data-lucide="arrow-down-left" className="w-3.5 h-3.5 text-emerald-600"></i>Money In
                    </p>
                    <p className="mt-1 text-base sm:text-lg font-bold tabular-nums text-emerald-700 break-all">{fmt(cashflow.moneyIn)}</p>
                    <div className="mt-2.5 space-y-1">
                      <FlowLine label="Principal repaid" value={fmt(cashflow.principalIn)} muted={cashflow.principalIn <= 0} />
                      <FlowLine label="Interest collected" value={fmt(cashflow.interest)} muted={cashflow.interest <= 0} />
                      <FlowLine label="Fees & income" value={fmt(cashflow.feeIncome + cashflow.otherIn)} muted={cashflow.feeIncome + cashflow.otherIn <= 0} />
                      <FlowLine label="Capital added" value={fmt(cashflow.capitalIn)} muted={cashflow.capitalIn <= 0} />
                    </div>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      <i data-lucide="arrow-up-right" className="w-3.5 h-3.5 text-amber-600"></i>Money Out
                    </p>
                    <p className="mt-1 text-base sm:text-lg font-bold tabular-nums text-amber-700 break-all">{fmt(cashflow.moneyOut)}</p>
                    <div className="mt-2.5 space-y-1">
                      <FlowLine label="Loans released" value={fmt(cashflow.disbursed)} muted={cashflow.disbursed <= 0} />
                      <FlowLine label="Withdrawals" value={fmt(cashflow.withdrawals)} muted={cashflow.withdrawals <= 0} />
                      <FlowLine label="Expenses" value={fmt(cashflow.expenses)} muted={cashflow.expenses <= 0} />
                      <FlowLine label="Other" value={fmt(cashflow.otherOut)} muted={cashflow.otherOut <= 0} />
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 px-3.5 py-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Net Cash Flow</p>
                    <p className="text-[11px] text-slate-400 mt-0.5 tabular-nums truncate">{fmt(cashflow.moneyIn)} in − {fmt(cashflow.moneyOut)} out</p>
                  </div>
                  <p className={`text-xl sm:text-2xl font-bold tabular-nums shrink-0 ${cashflow.net >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {cashflow.net >= 0 ? "+" : "−"}{fmt(Math.abs(cashflow.net))}
                  </p>
                </div>
              </div>

              {/* ── 3 · LENDING ACTIVITY — released vs collected, then the money
                     that is out with borrowers and is NOT available cash. ── */}
              <div className={`${cardCls} p-4 space-y-3.5 md:col-span-6`}>
                <CardHead title="Lending activity" hint={cfAllTime ? "All time" : monthLabelLong(cfMonth)} />
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="rounded-xl border border-slate-100 p-3">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      <i data-lucide="arrow-up-right" className="w-3.5 h-3.5 text-amber-600"></i>Released
                    </p>
                    <p className="mt-1 text-base sm:text-lg font-bold tabular-nums text-slate-800 break-all">{fmt(cashflow.disbursed)}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">{cashflow.releasedCount} loan{cashflow.releasedCount !== 1 ? "s" : ""} released</p>
                  </div>
                  <div className="rounded-xl border border-slate-100 p-3">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      <i data-lucide="arrow-down-left" className="w-3.5 h-3.5 text-emerald-600"></i>Collected
                    </p>
                    <p className="mt-1 text-base sm:text-lg font-bold tabular-nums text-slate-800 break-all">{fmt(cashflow.collected)}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">{cashflow.collectedCount} payment{cashflow.collectedCount !== 1 ? "s" : ""} collected</p>
                  </div>
                </div>
                <div>
                  <div className="flex h-2 rounded-full overflow-hidden bg-slate-100" role="img"
                    aria-label={`Collected ${fmt(cashflow.collected)}, released ${fmt(cashflow.disbursed)}`}>
                    <div className="bg-emerald-500" style={{ width: `${lendSplit}%` }} />
                    <div className="bg-amber-400" style={{ width: `${100 - lendSplit}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-slate-500 leading-relaxed">{lendVerdict}</p>
                </div>
                <div className="pt-3 border-t border-slate-100">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Out with borrowers · not available cash</p>
                  {/* The three read as a chain — released, of that what is still
                      unpaid, and what that becomes once interest is added — so
                      each explanation leans on the one before it.
                      The bubble is positioned against the row (which carries
                      `relative`), not the button, so it spans the row's width and
                      can never be clipped by `main`'s horizontal overflow. */}
                  <div className="mt-1.5 divide-y divide-slate-100 lg:divide-y-0 lg:grid lg:grid-cols-3 lg:gap-3">
                    {[
                      ["Loaned out", fmt(cashflow.loanedOut),
                        `Full amount you released on the ${cashflow.activeLoans} loan${cashflow.activeLoans !== 1 ? "s" : ""} still running.`],
                      ["Outstanding principal", fmt(cashflow.outstandingPrincipal),
                        "Of that, the capital borrowers have not paid back yet."],
                      ["Expected back", fmt(cashflow.expectedCollections),
                        "Outstanding principal plus the interest they still owe."],
                    ].map(([label, value, hint]) => (
                      <div key={label} className="relative flex items-baseline justify-between gap-2 py-2 lg:block lg:py-0">
                        <p className="text-xs font-medium text-slate-500 lg:text-[11px] lg:text-slate-400 flex items-center gap-1 min-w-0">
                          <span className="truncate">{label}</span>
                          <button type="button" aria-label={`What does ${label} mean?`} aria-expanded={cfInfo === label}
                            onClick={e => { e.stopPropagation(); setCfInfo(cfInfo === label ? null : label); }}
                            className="group inline-flex items-center justify-center w-5 h-5 -m-0.5 shrink-0 rounded-full text-slate-300 hover:text-slate-500 transition-colors">
                            <i data-lucide="info" className="w-3.5 h-3.5"></i>
                            <span role="tooltip"
                              className={`pointer-events-none absolute left-0 right-0 top-full z-20 mt-1 rounded-lg bg-slate-900 px-2.5 py-2 text-left text-[11px] font-normal leading-snug text-white shadow-lg transition-opacity group-hover:opacity-100 ${
                                cfInfo === label ? "opacity-100" : "opacity-0"}`}>{hint}</span>
                          </button>
                        </p>
                        <p className="font-bold tabular-nums text-slate-800 text-sm shrink-0 lg:mt-0.5 lg:text-base">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* ── 4 · CASH FORECAST — only from data the app already holds ── */}
              <div className={`${cardCls} p-4 space-y-3 md:col-span-6`}>
                <CardHead title="Cash forecast" hint={forecast.days === 0 ? "As at today" : `Next ${forecast.days} day${forecast.days !== 1 ? "s" : ""}`} />
                <div className="flex items-center gap-2">
                  <label htmlFor="cf-horizon" className="text-xs font-medium text-slate-500 shrink-0">Forecast to</label>
                  <input id="cf-horizon" type="date" value={cfForecastDate} min={todayISO}
                    onChange={e => setCfForecastDate(e.target.value || todayISO)}
                    className={`${inputCls} flex-1 min-w-0`} />
                </div>
                <div className="space-y-0.5">
                  <div className="flex items-baseline justify-between gap-2 py-1.5">
                    <span className="text-xs text-slate-500">Cash on hand now</span>
                    <span className="text-sm font-semibold tabular-nums text-slate-800">{fmt(forecast.cash)}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 py-1.5">
                    <span className="text-xs text-slate-500 min-w-0">
                      <span className={`font-semibold ${forecast.overdueCount ? "text-red-600" : "text-slate-300"}`}>+</span> Overdue collections
                      <span className="block text-[11px] text-slate-400">
                        {forecast.overdueCount ? `${forecast.overdueCount} installment${forecast.overdueCount !== 1 ? "s" : ""} already past due` : "nothing past due"}
                      </span>
                    </span>
                    <span className={`text-sm font-semibold tabular-nums ${forecast.overdueCount ? "text-red-700" : "text-slate-400"}`}>{fmt(forecast.overdueAmt)}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 py-1.5">
                    <span className="text-xs text-slate-500 min-w-0">
                      <span className="text-emerald-600 font-semibold">+</span> Expected collections
                      <span className="block text-[11px] text-slate-400">{forecast.collectionCount} installment{forecast.collectionCount !== 1 ? "s" : ""} falling due</span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-emerald-700">{fmt(forecast.collections)}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 py-1.5">
                    <span className="text-xs text-slate-500 min-w-0">
                      <span className="text-amber-600 font-semibold">−</span> Scheduled releases
                      <span className="block text-[11px] text-slate-400">{forecast.releaseCount ? `${forecast.releaseCount} queued borrower${forecast.releaseCount !== 1 ? "s" : ""}` : "nothing in the queue"}</span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-amber-700">{fmt(forecast.releases)}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 pt-3 mt-1 border-t border-slate-100">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Projected cash</span>
                    <span className={`text-xl font-bold tabular-nums ${forecast.projected < 0 ? "text-red-600" : "text-emerald-600"}`}>{fmt(forecast.projected)}</span>
                  </div>
                </div>
                {forecast.overdueCount > 0 && (
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Includes <span className="font-semibold text-red-700">{fmt(forecast.overdueAmt)}</span> already overdue — this assumes you collect it.
                  </p>
                )}
                <p className="text-[11px] text-slate-400 leading-relaxed">Counts everything past due plus unpaid installments due on or before {fmtDate(parseDate(forecast.horizon))}, less borrowers queued for release by then.</p>
              </div>

              {/* ── 5 · CASH IN vs CASH OUT ── */}
              <div className={`${cardCls} overflow-hidden md:col-span-6 lg:col-span-7`}>
                <div className="p-4 pb-3 space-y-3">
                  <CardHead title="Cash in vs cash out" hint={cfAllTime ? "Monthly totals, all time" : `${cfAgg === "daily" ? "Daily" : cfAgg === "weekly" ? "Weekly" : "Monthly"} totals`}
                    right={
                      <div className="flex flex-col items-end gap-1 text-[11px] text-slate-400 shrink-0">
                        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#10b981" }} />In</span>
                        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#f59e0b" }} />Out</span>
                        {cfProjected && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#6ee7b7" }} />Expected</span>}
                      </div>
                    } />
                  {!cfAllTime && (
                    <Segmented value={cfAgg} onChange={setCfAgg}
                      options={[["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]]} />
                  )}
                </div>
                <FlowChart data={cashflow.buckets} fmt={fmt} />
                <p className="px-4 pb-3 text-[11px] text-slate-400">Bars above the line are cash coming in; below the line is cash going out.</p>
              </div>

              {/* ── 6 · CASH POSITION TREND ── */}
              <div className={`${cardCls} overflow-hidden md:col-span-6 lg:col-span-5`}>
                <div className="px-4 py-3 border-b border-slate-100">
                  <CardHead title="Cash position trend"
                    hint={cashflow.net >= 0 ? "Above the opening line means you are building cash" : "Below the opening line means cash is draining"}
                    right={<span className={`font-bold text-sm tabular-nums shrink-0 ${cashflow.balance < 0 ? "text-red-600" : "text-emerald-700"}`}>{fmt(cashflow.balance)}</span>} />
                </div>
                {cashflow.position.length
                  ? <PositionChart data={cashflow.position} fmt={fmt} baseline={cashflow.opening} />
                  : <EmptyPanel icon="trending-up" title="No trend yet" body="Once this period has cash movements, the running balance will plot here." />}
              </div>

              {/* ── 7 · CASH MOVEMENTS TIMELINE ── */}
              {/* No overflow-hidden here: it would become the scroll container
                  for the sticky day headings and pin them in place. */}
              <div className={`${cardCls} md:col-span-12`}>
                <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 text-sm">Cash movements</p>
                    <p className="text-xs text-slate-400 truncate">{cashflow.ledger.length} entr{cashflow.ledger.length === 1 ? "y" : "ies"} · {cfAllTime ? "all time" : monthLabelLong(cfMonth)}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => setCfFilterOpen(true)}
                      className="h-9 px-3 rounded-lg border border-slate-100 text-slate-500 text-xs font-semibold active:bg-slate-100 transition flex items-center gap-1.5">
                      <i data-lucide="sliders-horizontal" className="w-3.5 h-3.5"></i>Filter
                      {cfFilterCount > 0 && <span className="w-4 h-4 rounded-full bg-emerald-600 text-white text-[10px] font-bold flex items-center justify-center">{cfFilterCount}</span>}
                    </button>
                    {cashflow.ledger.length > 0 && (
                      <button onClick={exportCsv} aria-label="Export CSV" title="Export CSV"
                        className="w-9 h-9 rounded-lg border border-slate-100 text-slate-500 flex items-center justify-center active:bg-slate-100 transition">
                        <i data-lucide="download" className="w-4 h-4"></i>
                      </button>
                    )}
                  </div>
                </div>

                <div className="px-4 py-2.5 border-b border-slate-50">
                  <button onClick={() => setCfProjected(v => !v)} aria-pressed={cfProjected}
                    className={`w-full py-2.5 rounded-xl text-xs font-semibold transition ${
                      cfProjected ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-500 active:bg-slate-200"}`}>
                    {cfProjected ? "✓ Showing projected" : "Show projected"}
                  </button>
                  {cfProjected && (
                    <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
                      Greyed rows are unpaid installments still to be collected — <span className="font-semibold text-slate-500">{fmt(cashflow.expected)}</span> across {cashflow.expectedCount} due{cashflow.expectedCount !== 1 ? "s" : ""} in {cfAllTime ? "your records" : monthLabelLong(cfMonth)}. Their running balance is a projection, not cash you hold.
                    </p>
                  )}
                </div>

                {cfFilterCount > 0 && (
                  <div className="px-4 py-2 border-b border-slate-50 flex flex-wrap items-center gap-1.5">
                    {cfChips.map(([label, clear]) => (
                      <button key={label} onClick={clear}
                        className="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-full bg-slate-100 text-slate-600 text-[11px] font-medium active:bg-slate-200 transition">
                        {label}<span className="text-slate-400 text-sm leading-none">×</span>
                      </button>
                    ))}
                    <button onClick={clearCfFilters} className="text-[11px] font-semibold text-emerald-600 px-1.5 py-1">Clear all</button>
                  </div>
                )}

                {cashflow.days.length === 0 ? (
                  <EmptyPanel icon="inbox"
                    title={cfFilterCount > 0 ? "No movements match these filters" : `No cash movement in ${cfAllTime ? "your records" : monthLabelLong(cfMonth)}`}
                    body={cfFilterCount > 0 ? "Try widening the filters to see the rest of this period."
                      : "Loan releases, collections and manual entries dated in this period will be listed here."}
                    action={cfFilterCount > 0 ? "Clear filters" : (latestActiveMonth && latestActiveMonth !== cfMonth ? `Go to ${monthLabelLong(latestActiveMonth)}` : "Record a cash entry")}
                    onAction={() => { if (cfFilterCount > 0) clearCfFilters(); else if (latestActiveMonth && latestActiveMonth !== cfMonth) setCfMonth(latestActiveMonth); else setCfEntryOpen(true); }} />
                ) : (
                  <div>
                    {cashflow.days.map(day => (
                      <section key={day.date}>
                        <div className="sticky top-0 z-[1] px-4 py-1.5 bg-slate-50 border-y border-slate-100 flex items-center justify-between">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{day.heading}</p>
                          <p className="text-[11px] font-semibold tabular-nums flex items-center gap-1.5">
                            {day.hasActual && <span className={day.net >= 0 ? "text-emerald-600" : "text-amber-600"}>{day.net >= 0 ? "+" : "−"}{fmt(Math.abs(day.net))}</span>}
                            {day.expected > 0 && <span className="text-slate-400 font-medium">+{fmt(day.expected)} expected</span>}
                          </p>
                        </div>
                        <ul className="divide-y divide-slate-50">
                          {day.rows.map(t => {
                            const meta = txnMeta(t.kind);
                            const isIn = t.inflow > 0;
                            return (
                              <li key={t.id}>
                                <div onClick={() => { if (t.ref) { setLoanIdOvr(t.ref); setSelBorrower(""); setTab("status"); } }}
                                  className={`px-4 py-2.5 flex items-center gap-3 ${t.ref ? "cursor-pointer active:bg-slate-50" : ""} transition`}>
                                  <span className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                                    t.projected ? "bg-slate-100 text-slate-400" : isIn ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>
                                    <i data-lucide={meta.icon} className="w-4 h-4"></i>
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <p className={`text-sm font-medium truncate ${t.projected ? "text-slate-500" : "text-slate-800"}`}>{t.borrower || meta.label}</p>
                                    <p className="text-[11px] text-slate-400 truncate">
                                      {t.projected && <span className="mr-1 px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10px] font-semibold">Expected</span>}
                                      {t.pending && <span className="mr-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold">Queued</span>}
                                      {t.borrower ? meta.label : (t.note || t.kind)}
                                      {t.ref ? ` · ${t.ref}` : ""}
                                      {t.borrower && t.note ? ` · ${t.note}` : ""}
                                    </p>
                                  </div>
                                  <div className="text-right shrink-0">
                                    <p className={`text-sm font-bold tabular-nums ${
                                      t.projected ? "text-slate-400" : isIn ? "text-emerald-700" : "text-amber-700"}`}>
                                      {isIn ? "+" : "−"}{fmt(isIn ? t.inflow : t.outflow)}
                                    </p>
                                    <p className={`text-[10px] tabular-nums ${t.projected ? "text-slate-300" : "text-slate-400"}`}>bal {fmt(t.balance)}</p>
                                  </div>
                                  {t.txId && (
                                    <button onClick={e => { e.stopPropagation(); if (confirm("Delete this cash entry?")) deleteTransaction({ id: t.txId, pending: t.pending }); }}
                                      aria-label="Delete entry"
                                      className="w-8 h-8 -mr-1.5 shrink-0 rounded-full text-slate-300 flex items-center justify-center active:bg-slate-100 active:text-red-500 transition">
                                      <i data-lucide="trash-2" className="w-3.5 h-3.5"></i>
                                    </button>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    ))}
                  </div>
                )}

                <div className="p-3 border-t border-slate-100">
                  <button onClick={() => setCfEntryOpen(true)}
                    className="w-full py-2.5 rounded-xl border border-dashed border-slate-200 text-slate-500 text-xs font-semibold active:bg-slate-50 transition flex items-center justify-center gap-1.5">
                    <i data-lucide="plus" className="w-4 h-4"></i>Record a cash entry
                  </button>
                </div>
              </div>

            </div>
            )}
          </div>
        )}

        {/* ── BORROWER QUEUE ── */}
        {tab === "queue" && (<>
          <div className="bg-white rounded-2xl border border-slate-100 p-4 space-y-3 shadow-sm">
            <p className="font-semibold text-slate-800">Borrower Queue</p>
            <p className="text-xs text-slate-400">Borrowers fall in line by date. As cash builds up, the earliest in line become ready to fund.</p>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Cash on Hand" value={fmt(queueView.cash)} tone={queueView.cash >= 0 ? "emerald" : "red"} />
              <Stat label="Ready to Fund" value={`${queueView.readyCount} of ${queueView.rows.length}`} tone="teal" />
            </div>
            {queueView.rows.length > 0 &&
              <p className="text-xs text-slate-400">Total requested in line: <span className="font-semibold text-slate-600">{fmt(queueView.totalRequested)}</span></p>}
          </div>

          {/* Add to queue */}
          <div className="bg-white rounded-2xl border border-slate-100 p-4 space-y-3 shadow-sm">
            <p className="font-semibold text-slate-800">Add to Queue</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className={labelCls}>Borrower</label>
                <input className={inputCls} value={qBorrower} onChange={e => setQBorrower(e.target.value)} placeholder="Full name" />
              </div>
              <div>
                <label className={labelCls}>Requested Amount</label>
                <input type="number" inputMode="decimal" className={inputCls} value={qAmount} onChange={e => setQAmount(e.target.value)} placeholder="0.00" />
              </div>
              <div>
                <label className={labelCls}>Queue Date</label>
                <input type="date" className={inputCls} value={qDate} onChange={e => setQDate(e.target.value)} />
              </div>
              <div className="col-span-2">
                <label className={labelCls}>Note / Purpose</label>
                <input className={inputCls} value={qNote} onChange={e => setQNote(e.target.value)} placeholder="Optional" />
              </div>
            </div>
            <button onClick={addQueueEntry} className="w-full py-2.5 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold transition">Add to Queue</button>
          </div>

          {/* Waiting line */}
          {queueView.rows.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center text-slate-400 text-sm">The queue is empty. Add a borrower above.</div>
          ) : queueView.rows.map(q => (
            <div key={q.id} className={`bg-white rounded-2xl border p-4 space-y-3 shadow-sm ${q.ready ? "border-emerald-200" : "border-slate-100"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <Avatar name={q.borrower} />
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">{q.borrower}</p>
                    <p className="text-xs text-slate-400">#{q.position} in line · {fmtDate(parseDate(q.date))}{q.note ? ` · ${q.note}` : ""}</p>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-semibold text-slate-800 tabular-nums">{fmt(q.amount)}</p>
                  {q.pending
                    ? <span className="inline-block mt-0.5 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-semibold">Queued offline</span>
                    : <span className={`inline-block mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${q.ready ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{q.ready ? "Ready to fund" : "Waiting"}</span>}
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className={q.ready ? "text-emerald-600 font-medium" : "text-amber-600"}>{q.ready ? "Cash covers this borrower" : `Needs ${fmt(Math.max(0, q.cumulative - queueView.cash))} more`}</span>
                  <span className="tabular-nums text-slate-400">{Math.round(Math.max(0, Math.min(1, queueView.cash / (q.cumulative || 1))) * 100)}%</span>
                </div>
                <ProgressBar pct={q.ready ? 1 : queueView.cash / (q.cumulative || 1)} tone={q.ready ? "emerald" : "amber"} />
              </div>
              <div className="flex gap-2">
                <button onClick={() => fundFromQueue(q)} className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition ${q.ready ? "bg-emerald-600 active:bg-emerald-800 text-white" : "border border-emerald-300 active:bg-emerald-50 text-emerald-700"}`}>Fund →</button>
                <button onClick={() => markQueueFunded(q)} className="px-3.5 py-2.5 rounded-xl border border-slate-200 active:bg-slate-100 text-slate-600 text-sm font-semibold transition">Mark funded</button>
                <button onClick={() => deleteQueueEntry(q)} className="px-3.5 py-2.5 rounded-xl border border-red-200 active:bg-red-50 text-red-500 text-sm font-semibold transition">Remove</button>
              </div>
            </div>
          ))}

          {/* Funded history */}
          {queueView.funded.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-100 p-4 space-y-2 shadow-sm">
              <p className="font-semibold text-slate-800">Funded</p>
              {queueView.funded.map(q => (
                <div key={q.id} className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <span className="font-semibold text-slate-600">{q.borrower}</span>
                    <span className="text-slate-400"> · {fmt(q.amount)} · {fmtDate(parseDate(q.date))}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => requeue(q.id)} className="text-emerald-600 font-semibold">Re-queue</button>
                    <button onClick={() => deleteQueueEntry(q)} className="text-red-400 text-base leading-none">×</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>)}

        {/* ── LOAN AGREEMENT ── */}
        {tab === "agreement" && (agreementLoan
          ? <AgreementView loan={agreementLoan} fmt={fmt} onBack={() => setTab("records")} onSave={saveAgreement} />
          : <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center text-slate-400 text-sm">Loan not found. <button onClick={() => setTab("records")} className="text-emerald-600 font-semibold underline">Back to records</button></div>)}
        </div>
      </main>

      {/* ── Exported image: preview, then share ───────────────────────────────
          Not just decoration. On iOS the only reliable way to get a file out of
          a standalone PWA is navigator.share, and share() must run inside a live
          user gesture — which rendering the canvas uses up. So the image is shown
          here and sent from a fresh tap. The share sheet is also the only route
          to Photos or straight into Messenger; a plain download lands in Files. */}
      {shareImg && (
        <div className="no-print fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
          onClick={closeShareImg}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true"
            className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-xl max-h-[92vh] overflow-y-auto overscroll-contain scroll-ios animate-sheet-up"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}>
            <div className="sticky top-0 z-10 bg-white/95 backdrop-blur px-5 pt-3 pb-3 border-b border-slate-50">
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3 sm:hidden" />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800">Schedule image ready</p>
                  <p className="text-xs text-slate-400 truncate">{name.trim() || "Unnamed borrower"}</p>
                </div>
                <button onClick={closeShareImg} aria-label="Close"
                  className="w-8 h-8 -mr-1 rounded-full bg-slate-100 text-slate-500 text-sm flex items-center justify-center active:bg-slate-200 transition shrink-0">✕</button>
              </div>
            </div>

            <div className="px-4 py-4 space-y-3">
              <div className="rounded-xl border border-slate-200 overflow-hidden bg-slate-50">
                <img src={shareImg.url} alt="Payment schedule preview" className="w-full block" />
              </div>

              <button onClick={shareScheduleImage}
                className="w-full min-h-[48px] rounded-xl bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold flex items-center justify-center gap-2 transition">
                <i data-lucide="share-2" className="w-4 h-4"></i>
                Save or send
              </button>

              {/* A real link, so a long-press offers "Save to Photos" even when
                  the share sheet is unavailable. */}
              <a href={shareImg.url} download={shareImg.filename}
                className="w-full min-h-[44px] rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold flex items-center justify-center gap-2 active:bg-slate-100 transition">
                <i data-lucide="arrow-down-to-line" className="w-4 h-4"></i>
                Download file
              </a>

              <p className="text-[11px] text-slate-400 leading-relaxed px-1">
                <span className="font-semibold text-slate-500">Save or send</span> opens your phone's share sheet — choose
                <span className="font-semibold text-slate-500"> Save Image</span> to put it in Photos, or pick a chat to send it straight to the borrower.
                <span className="font-semibold text-slate-500"> Download file</span> saves to Files → Downloads instead.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Schedule export document ──────────────────────────────────────────
          What "Save image" actually captures. Parked off-screen (never visible,
          but laid out, so html2canvas can measure it) at a fixed readable width
          instead of the phone's. The on-screen card is a compact preview; this
          is the artifact a borrower receives, so it carries the things a bare
          table can't: who the loan is for, when the money is released, and what
          it costs in total. Lives outside <main> so nothing clips it. */}
      {calc.rows.length > 0 && (
        <div id="schedule-export-doc" aria-hidden="true"
          style={{ position: "fixed", top: 0, left: "-10000px", background: "#ffffff",
                   width: "max-content", maxWidth: "760px" }}>
          <div className="px-5 pt-7 pb-6">
            <p className="text-[13px] font-bold tracking-[0.18em] text-emerald-600">PAYMENT SCHEDULE</p>
            <p className="mt-1 text-3xl font-bold text-slate-900 leading-tight">{name.trim() || "Unnamed borrower"}</p>
            <p className="mt-2 text-[15px] text-slate-500">
              Release date <span className="text-lg font-semibold text-slate-700">{fmtDate(parseDate(startDate))}</span>
              <span className="text-slate-300"> · </span>
              {Math.floor(Number(terms) || 0)} {frequency.toLowerCase()} payments
              <span className="text-slate-300"> · </span>
              {/* {flatRate}% flat{Number(dropRate) !== Number(flatRate) ? ` · ${dropRate}% diminishing` : ""} */}
            </p>

            <div className="mt-5 grid grid-cols-3 gap-3">
              <div className="rounded-2xl bg-slate-50 px-3 py-3">
                <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-400">Loan amount</p>
                <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{fmt(amount)}</p>
              </div>
              <div className="rounded-2xl bg-amber-50 px-3 py-3">
                <p className="text-[12px] font-semibold uppercase tracking-wide text-amber-600">Total interest</p>
                <p className="mt-1 text-2xl font-bold text-amber-700 tabular-nums">{fmt(calc.totalInterest)}</p>
              </div>
              <div className="rounded-2xl bg-emerald-50 px-3 py-3">
                <p className="text-[12px] font-semibold uppercase tracking-wide text-emerald-600">Total repayment</p>
                <p className="mt-1 text-2xl font-bold text-emerald-700 tabular-nums">{fmt(calc.totalRepay)}</p>
              </div>
            </div>
          </div>

          {/* Due date sits second: it is the column a borrower reads first. */}
          <table className="w-full text-[17px] leading-6" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr className="bg-slate-100 text-slate-500">
                <th className="pl-5 pr-3 py-3 text-left text-[13px] font-bold uppercase tracking-wide">No.</th>
                <th className="px-3 py-3 text-left text-[13px] font-bold uppercase tracking-wide">Due date</th>
                <th className="px-3 py-3 text-right text-[13px] font-bold uppercase tracking-wide">Principal</th>
                <th className="px-3 py-3 text-right text-[13px] font-bold uppercase tracking-wide">Interest</th>
                <th className="pl-3 pr-5 py-3 text-right text-[13px] font-bold uppercase tracking-wide">Amount due</th>
              </tr>
            </thead>
            <tbody>
              {calc.rows.map((r, i) => (
                <tr key={r.period} className={i % 2 ? "bg-slate-50" : "bg-white"}>
                  {/* slate-500 not 400: this is a document someone has to read,
                      and 400 on white falls under the AA contrast floor. */}
                  <td className="pl-5 pr-3 py-2 font-semibold text-slate-500 tabular-nums">{r.period}</td>
                  <td className="px-3 py-2 font-semibold text-slate-800 whitespace-nowrap">{fmtDate(r.due)}</td>
                  <td className="px-3 py-2 text-right text-[#27313e] tabular-nums whitespace-nowrap">{fmt(r.principal)}</td>
                  <td className="px-3 py-2 text-right text-[#eb652e] tabular-nums whitespace-nowrap">{fmt(r.interest)}</td>
                  <td className="pl-3 pr-5 py-2 text-right font-bold text-slate-900 tabular-nums whitespace-nowrap">{fmt(r.total)}</td>
                </tr>
              ))}
              <tr className="bg-emerald-50">
                <td className="pl-5 pr-3 py-3.5 font-bold text-emerald-800" colSpan={2}>Total</td>
                <td className="px-3 py-3.5 text-right font-bold text-slate-700 tabular-nums">{fmt(amount)}</td>
                <td className="px-3 py-3.5 text-right font-bold text-amber-700 tabular-nums">{fmt(calc.totalInterest)}</td>
                <td className="pl-3 pr-5 py-3.5 text-right font-bold text-emerald-700 tabular-nums">{fmt(calc.totalRepay)}</td>
              </tr>
            </tbody>
          </table>

          <div className="px-5 py-4 border-t border-slate-100 flex items-baseline justify-between">
            <p className="text-[13px] text-slate-500 max-w-[300px]">Projection only — not a receipt. Amounts assume every installment is paid in full and on time.</p>
            <p className="text-[13px] text-slate-500 whitespace-nowrap ml-4">Generated {fmtDate(new Date())}</p>
          </div>
        </div>
      )}

      {/* Bottom Tab Bar — 2 tabs · center FAB (New Loan) · 2 tabs */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur border-t border-slate-100 flex items-stretch z-20" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {navItems.map(({ id, label, icon }, i) => (
          <React.Fragment key={id}>
            {i === 2 && (
              <div className="flex-1 flex justify-center">
                <button onClick={() => { resetForm(); setTab("new"); }} aria-label="New loan"
                  className={`-mt-5 w-14 h-14 rounded-full flex items-center justify-center text-white shadow-lg shadow-emerald-600/30 transition active:scale-95 ${tab === "new" ? "bg-emerald-700 ring-4 ring-emerald-100" : "bg-emerald-600"}`}>
                  <i data-lucide="plus" className="w-7 h-7" style={{ strokeWidth: 2.5 }}></i>
                </button>
              </div>
            )}
            <button onClick={() => setTab(id)} className={`flex-1 flex flex-col items-center py-3 gap-0.5 text-[11px] font-medium transition-colors active:bg-slate-100 ${tab === id ? "text-emerald-600" : "text-slate-400"}`}>
              <i data-lucide={icon} className="w-5 h-5" style={{ strokeWidth: tab === id ? 2.5 : 1.8 }}></i>
              {label}
            </button>
          </React.Fragment>
        ))}
      </nav>

      {(!authReady || !session || session.user.is_anonymous || !approved) && (
        <div className="fixed inset-0 z-[60] bg-emerald-700 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="text-center space-y-1">
              <div className="w-12 h-12 mx-auto rounded-xl bg-emerald-600 text-white flex items-center justify-center font-bold">OLC</div>
              <p className="font-bold text-slate-800">JAVILAT LENDING</p>
              <p className="text-xs text-slate-400">{session && !session.user.is_anonymous ? "Account access" : "Sign in to access records"}</p>
            </div>
            {!authReady ? (
              <p className="text-center text-sm text-slate-400 py-4">Loading…</p>
            ) : (session && !session.user.is_anonymous && !approved) ? (<>
              <p className="text-sm text-slate-600 text-center">Your account <b className="text-slate-800">{session.user.email}</b> is pending administrator approval.</p>
              <p className="text-xs text-slate-400 text-center">Ask the administrator to grant your email access, then reload.</p>
              <button onClick={signOut} className="w-full py-2.5 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold active:bg-slate-100 transition">Sign out</button>
            </>) : (<>
              <div>
                <label className={labelCls}>Email</label>
                <input type="email" autoComplete="email" className={inputCls} value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div>
                <label className={labelCls}>Password</label>
                <input type="password" autoComplete="current-password" className={inputCls} value={authPass} onChange={e => setAuthPass(e.target.value)} placeholder="••••••••" onKeyDown={e => { if (e.key === "Enter") signIn(); }} />
              </div>
              {authMsg && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{authMsg}</p>}
              <button disabled={authBusy} onClick={signIn} className="w-full py-3 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white font-semibold text-sm disabled:opacity-50 transition">{authBusy ? "Please wait…" : "Sign in"}</button>
              <button disabled={authBusy} onClick={createAccount} className="w-full py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold disabled:opacity-50 active:bg-slate-100 transition">Create account</button>
            </>)}
          </div>
        </div>
      )}

      {showAdmin && isAdmin && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 no-print" onClick={() => setShowAdmin(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 space-y-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-800">Manage access</p>
              <button onClick={() => setShowAdmin(false)} className="text-slate-400 text-sm">Close</button>
            </div>
            <div className="flex gap-2">
              <input type="email" className={inputCls} value={adminEmail} onChange={e => setAdminEmail(e.target.value)} placeholder="email to approve" onKeyDown={e => { if (e.key === "Enter") approveEmail(adminEmail); }} />
              <button disabled={adminBusy} onClick={() => approveEmail(adminEmail)} className="px-4 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold disabled:opacity-50">Approve</button>
            </div>

            {adminPending.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Pending sign-ups</p>
                {adminPending.map(u => (
                  <div key={u.email} className="flex items-center justify-between bg-amber-50 rounded-xl px-3 py-2 text-xs gap-2">
                    <span className="text-slate-700 truncate">{u.email}</span>
                    <button onClick={() => approveEmail(u.email)} className="px-3 py-1 rounded-lg bg-emerald-600 active:bg-emerald-800 text-white font-semibold shrink-0">Approve</button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Approved users</p>
              {adminUsers.length === 0 ? <p className="text-xs text-slate-400">No one yet.</p> : adminUsers.map(u => (
                <div key={u.email} className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2 text-xs gap-2">
                  <span className="text-slate-700 truncate">{u.email}{u.role === "admin" ? " · admin" : ""}</span>
                  <button onClick={() => revokeEmail(u.email)} className="text-red-500 font-semibold pl-2 shrink-0">Remove</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Revise Remaining Schedule ── bottom sheet on phones, centered dialog on
          wider screens. Kept out of the Payments flow so the tab stays compact. */}
      {reviseOpen && resolved.loan && statusData && (
        <div className="no-print fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
          onClick={() => setReviseOpen(false)}>
          <div onClick={e => e.stopPropagation()}
            className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-xl max-h-[88vh] overflow-y-auto scroll-ios animate-sheet-up"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}>

            <div className="sticky top-0 z-10 bg-white/95 backdrop-blur px-5 pt-3 pb-3 border-b border-slate-50">
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3 sm:hidden" />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800">Revise Remaining Schedule</p>
                  <p className="text-xs text-slate-400 truncate">{resolved.loan.ref || resolved.loan.id} · {resolved.loan.borrower}</p>
                </div>
                <button onClick={() => setReviseOpen(false)} aria-label="Close"
                  className="w-8 h-8 -mr-1 rounded-full bg-slate-100 text-slate-500 text-sm flex items-center justify-center active:bg-slate-200 transition shrink-0">✕</button>
              </div>
            </div>

            <div className="px-5 py-4 space-y-3">
              <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs">
                <span className="text-slate-400">Current schedule</span>
                <span className="font-semibold text-slate-700">{resolved.loan.frequency} · {resolved.loan.terms} terms</span>
              </div>

              {resolved.loan.freqChange ? (<>
                <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-3.5 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600">Active revision</p>
                  <p className="mt-0.5 text-sm font-bold text-emerald-800">
                    {resolved.loan.freqChange.frequency || resolved.loan.frequency}
                    {resolved.loan.freqChange.terms ? ` · ${resolved.loan.freqChange.terms} installments` : ""}
                  </p>
                  <p className="text-xs text-emerald-700">Effective {fmtDate(parseDate(resolved.loan.freqChange.date))}</p>
                </div>
                <p className="text-[11px] text-slate-400">Undoing restores the original schedule. Logged payments are never affected.</p>
                <button onClick={() => clearRevision(resolved.loan)}
                  className="w-full py-3 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold active:bg-slate-100 transition">Undo revision</button>
              </>) : (<>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Effective date</label>
                    <input type="date" className={inputCls} value={freqDate} onChange={e => setFreqDate(e.target.value)} />
                  </div>
                  <div>
                    <label className={labelCls}>New frequency</label>
                    <select className={inputCls} value={revFreq} onChange={e => setRevFreq(e.target.value)}>
                      <option value="">Keep ({resolved.loan.frequency})</option>
                      {FREQUENCIES.filter(f => f !== resolved.loan.frequency).map(f => <option key={f}>{f}</option>)}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className={labelCls}>Remaining installments</label>
                    <input type="number" inputMode="numeric" className={inputCls} value={revTerms} onChange={e => setRevTerms(e.target.value)} placeholder="Leave blank — keep the same payoff date" />
                  </div>
                </div>
                <p className="text-[11px] text-slate-400">Paid installments stay as they are. Changing the number of installments re-prices the total interest; a frequency-only change keeps the same total.</p>

                {revisionPreview ? (
                  <div className="rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-3 space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">After revision</p>
                    <div className="grid grid-cols-2 gap-y-2 gap-x-3 text-xs">
                      <div><p className="text-slate-400">Installments</p><p className="font-bold text-slate-800 tabular-nums">{revisionPreview.installments}</p></div>
                      <div><p className="text-slate-400">Payoff date</p><p className="font-bold text-slate-800 tabular-nums">{revisionPreview.payoff ? fmtDate(revisionPreview.payoff) : "—"}</p></div>
                      <div><p className="text-slate-400">Total interest</p><p className="font-bold text-amber-600 tabular-nums">{fmt(revisionPreview.interest)}</p></div>
                      <div><p className="text-slate-400">Balance left</p><p className="font-bold text-emerald-700 tabular-nums">{fmt(revisionPreview.left)}</p></div>
                    </div>
                    {Math.abs(revisionPreview.delta) > 0.005 && (
                      <p className={`text-[11px] font-semibold ${revisionPreview.delta > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                        {revisionPreview.delta > 0 ? "▲" : "▼"} {fmt(Math.abs(revisionPreview.delta))} interest vs. the current schedule
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 text-center py-2">Pick a new frequency and/or installment count to preview the change.</p>
                )}

                <div className="flex gap-2 pt-1">
                  <button onClick={() => setReviseOpen(false)}
                    className="px-4 py-3 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold active:bg-slate-100 transition">Cancel</button>
                  <button onClick={() => applyRevision(resolved.loan)} disabled={!revisionPreview}
                    className="flex-1 py-3 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold disabled:opacity-40 transition">Apply revision</button>
                </div>
              </>)}
            </div>
          </div>
        </div>
      )}

      {/* ── Cash-flow filters ── a bottom sheet on phones, a centred dialog on
          desktop. Same shell as the loan action sheet below. */}
      {cfFilterOpen && (
        <div className="no-print fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
          onClick={() => setCfFilterOpen(false)}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Filter cash movements"
            className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-xl max-h-[88vh] overflow-y-auto overscroll-contain scroll-ios animate-sheet-up"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}>
            <div className="sticky top-0 z-10 bg-white/95 backdrop-blur px-5 pt-3 pb-3 border-b border-slate-50">
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3 sm:hidden" />
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold text-slate-800">Filter movements</p>
                <button onClick={() => setCfFilterOpen(false)} aria-label="Close"
                  className="w-8 h-8 -mr-1 rounded-full bg-slate-100 text-slate-500 text-sm flex items-center justify-center active:bg-slate-200 transition shrink-0">✕</button>
              </div>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className={labelCls}>Direction</label>
                <Segmented value={cfDir} onChange={setCfDir} size="md"
                  options={[["all", "All"], ["in", "Money in"], ["out", "Money out"]]} />
              </div>
              <div>
                <label className={labelCls}>Category</label>
                <div className="grid grid-cols-2 gap-2">
                  {CF_GROUPS.map(([k, lbl]) => (
                    <button key={k} onClick={() => setCfGroup(k)} aria-pressed={cfGroup === k}
                      className={`px-3 py-2.5 rounded-xl text-xs font-semibold text-left transition border ${
                        cfGroup === k ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-100 text-slate-500 active:bg-slate-50"}`}>{lbl}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className={labelCls}>Borrower, loan ref or note</label>
                <input className={inputCls} value={cfSearch} onChange={e => setCfSearch(e.target.value)} placeholder="e.g. Juan or OL-0001" />
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={clearCfFilters} disabled={cfFilterCount === 0}
                  className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold disabled:opacity-40 active:bg-slate-100 transition">Reset</button>
                <button onClick={() => setCfFilterOpen(false)}
                  className="flex-1 py-3 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold transition">
                  Show {cashflow.ledger.length} entr{cashflow.ledger.length === 1 ? "y" : "ies"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Cash entry ── the manual in/out form, plus the opening balance that
          the whole running position is built on. */}
      {cfEntryOpen && (
        <div className="no-print fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
          onClick={() => setCfEntryOpen(false)}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Record a cash entry"
            className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-xl max-h-[88vh] overflow-y-auto overscroll-contain scroll-ios animate-sheet-up"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}>
            <div className="sticky top-0 z-10 bg-white/95 backdrop-blur px-5 pt-3 pb-3 border-b border-slate-50">
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3 sm:hidden" />
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800">Record a cash entry</p>
                  <p className="text-xs text-slate-400">Capital, fees, withdrawals and expenses</p>
                </div>
                <button onClick={() => setCfEntryOpen(false)} aria-label="Close"
                  className="w-8 h-8 -mr-1 rounded-full bg-slate-100 text-slate-500 text-sm flex items-center justify-center active:bg-slate-200 transition shrink-0">✕</button>
              </div>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
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
                <div className="col-span-2">
                  <label className={labelCls}>Note</label>
                  <input className={inputCls} value={txNote} onChange={e => setTxNote(e.target.value)} placeholder="Optional" />
                </div>
              </div>
              <p className={`flex items-center gap-1.5 text-xs font-medium ${txDir(txCat) === "in" ? "text-emerald-600" : "text-amber-600"}`}>
                <i data-lucide={txDir(txCat) === "in" ? "arrow-down-left" : "arrow-up-right"} className="w-3.5 h-3.5"></i>
                {txDir(txCat) === "in" ? "Adds to your available cash" : "Reduces your available cash"}
              </p>
              <button onClick={() => { addTransaction(); setCfEntryOpen(false); }}
                className="w-full py-3 rounded-xl bg-emerald-600 active:bg-emerald-800 text-white text-sm font-semibold transition">Add entry</button>

              <div className="pt-4 mt-1 border-t border-slate-100">
                <label className={labelCls}>Initial capital</label>
                <div className="flex items-center gap-2">
                  <input type="number" inputMode="decimal" value={openingInput} onChange={e => setOpeningInput(e.target.value)} onBlur={commitOpening}
                    placeholder="0.00" className={`${inputCls} text-right`} />
                </div>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">Cash you already held before any of these records. Every balance on this screen is counted up from here.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Loan actions ── everything that used to be a button on every loan
          card, behind the card's ⋯. Same sheet shell as Revise above. */}
      {sheetLoan && sheetStatus && (
        <div className="no-print fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
          onClick={() => setSheetLoanId(null)}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true"
            className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-xl max-h-[88vh] overflow-y-auto overscroll-contain scroll-ios animate-sheet-up"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}>

            <div className="sticky top-0 z-10 bg-white/95 backdrop-blur px-5 pt-3 pb-3 border-b border-slate-50">
              <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-3 sm:hidden" />
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar name={sheetLoan.borrower} />
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">{sheetLoan.borrower}</p>
                    <p className="text-xs text-slate-400 truncate">{sheetLoan.ref || sheetLoan.id} · {fmt(sheetLoan.amount)} · {sheetStatus.overallStatus}</p>
                  </div>
                </div>
                <button onClick={() => setSheetLoanId(null)} aria-label="Close"
                  className="w-8 h-8 -mr-1 rounded-full bg-slate-100 text-slate-500 text-sm flex items-center justify-center active:bg-slate-200 transition shrink-0">✕</button>
              </div>
            </div>

            <div className="px-4 py-3 space-y-1">
              <SheetRow icon="square-pen" label="Edit loan details"
                disabled={sheetStatus.overallStatus === "FULLY PAID"}
                hint={sheetStatus.overallStatus === "FULLY PAID" ? "Fully paid loans can't be edited" : undefined}
                onClick={() => { setSheetLoanId(null); editLoan(sheetLoan); }} />

              <SheetRow icon="file-text" label="Loan agreement"
                hint={sheetLoan.agreement ? "Signed copy on file" : "Fill in, sign and print"}
                onClick={() => { setSheetLoanId(null); setAgreementLoanId(sheetLoan.id); setTab("agreement"); }} />

              {/* IdPhotoButton keeps its own picker, downscale and viewer — the
                  sheet only frames it. key= resets its state between loans. */}
              <div className="pt-2">
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Borrower ID</p>
                <div className="px-1">
                  <IdPhotoButton key={sheetLoan.id} image={sheetLoan.idImage}
                    onUpload={d => saveIdImage(sheetLoan, d)}
                    onRemove={() => removeIdImage(sheetLoan)} />
                </div>
              </div>

              {/* Destructive: last, fenced off, text-only red. deleteLoan's own
                  confirm() is still the guard. Not closed on tap — cancelling
                  leaves the sheet up, confirming makes the loan vanish and the
                  effect above closes it. */}
              <div className="mt-3 pt-2 border-t border-slate-100">
                <SheetRow icon="trash-2" label="Delete loan" danger
                  hint="Also removes every payment logged against it"
                  onClick={() => deleteLoan(sheetLoan.id, sheetLoan.ref)} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* A new build is downloaded and waiting — the swap happens on tap only,
          so nobody loses a half-entered payment to an auto-refresh. */}
      {updateReady && (
        <div className="no-print fixed left-4 right-4 z-40 sm:left-auto sm:right-4 sm:w-80 animate-fade-up"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 8.5rem)" }}>{/* clears the toast at bottom-24 */}
          <div className="bg-slate-900 text-white rounded-2xl shadow-xl px-4 py-3 flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-300 flex items-center justify-center shrink-0">
              <i data-lucide="arrow-down-to-line" className="w-4 h-4"></i>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-tight">Update ready</p>
              <p className="text-[11px] text-white/60 leading-tight">A newer version of Ohana is downloaded.</p>
            </div>
            <button onClick={() => setUpdateReady(false)} className="text-white/50 text-xs px-1 shrink-0">Later</button>
            <button onClick={applyUpdate} className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-xs font-semibold active:bg-emerald-600 transition shrink-0">Update</button>
          </div>
        </div>
      )}

      <Toast msg={toast} />
    </div>
  );
}

// Init Lucide icons after render
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));
setTimeout(() => { if (window.lucide) lucide.createIcons(); }, 300);