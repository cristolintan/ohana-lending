// overdue-check — run once a day by pg_cron. Computes which loans have an
// unpaid installment due today or already overdue (using the same schedule
// engine as the app), then asks send-push to alert all staff.
//
// Protected by a shared secret header (x-cron-secret) since verify_jwt is off.
import { createClient } from "npm:@supabase/supabase-js@2";
import { computeStatus, isoOf, type Loan, type Pay } from "../_shared/schedule.ts";

// "Today" in the business timezone (Philippines, UTC+8) as YYYY-MM-DD.
function manilaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

async function callSendPush(payload: Record<string, unknown>) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-push`;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error("send-push failed", res.status, await res.text());
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const [loansRes, paysRes] = await Promise.all([
    admin.from("loans").select("*"),
    admin.from("payments").select("loan_id,date,amount,type"),
  ]);
  if (loansRes.error) return new Response(loansRes.error.message, { status: 500 });
  if (paysRes.error) return new Response(paysRes.error.message, { status: 500 });

  const pays: Pay[] = (paysRes.data || []).map((p) => ({
    loanId: p.loan_id, date: p.date, amount: +p.amount, type: p.type,
  }));
  const todayStr = manilaToday();

  const overdue: { ref: string; borrower: string; amt: number }[] = [];
  const dueToday: { ref: string; borrower: string; amt: number }[] = [];

  for (const r of loansRes.data || []) {
    const loan: Loan = {
      id: r.id, ref: r.ref, borrower: r.borrower, amount: +r.amount, terms: r.terms,
      flatRate: +r.flat_rate, dropRate: r.drop_rate != null ? +r.drop_rate : +r.flat_rate,
      frequency: r.frequency, startDate: r.start_date, freqChange: r.freq_change || null,
    };
    const st = computeStatus(loan, pays);
    if (st.overallStatus === "FULLY PAID") continue;

    const od = st.rows.filter((row) => row.amtLeft > 0.005 && isoOf(row.due) < todayStr);
    const dt = st.rows.filter((row) => row.amtLeft > 0.005 && isoOf(row.due) === todayStr);
    if (od.length) overdue.push({ ref: loan.ref, borrower: loan.borrower, amt: od.reduce((s, x) => s + x.amtLeft, 0) });
    if (dt.length) dueToday.push({ ref: loan.ref, borrower: loan.borrower, amt: dt.reduce((s, x) => s + x.amtLeft, 0) });
  }

  const peso = (n: number) => "₱" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const names = (list: { borrower: string }[]) => {
    const shown = list.slice(0, 4).map((x) => x.borrower).join(", ");
    return list.length > 4 ? `${shown} +${list.length - 4} more` : shown;
  };

  // One summary notification each → opens the Home dashboard (overdue list, red alerts).
  if (overdue.length) {
    await callSendPush({
      title: `⚠ ${overdue.length} payment${overdue.length > 1 ? "s" : ""} overdue`,
      body: `${names(overdue)} · ${peso(overdue.reduce((s, x) => s + x.amt, 0))} outstanding`,
      url: "./",
      target: "all_staff",
      tag: "overdue-daily",
    });
  }
  if (dueToday.length) {
    await callSendPush({
      title: `${dueToday.length} payment${dueToday.length > 1 ? "s" : ""} due today`,
      body: `${names(dueToday)} · ${peso(dueToday.reduce((s, x) => s + x.amt, 0))} due`,
      url: "./",
      target: "all_staff",
      tag: "due-today",
    });
  }

  return new Response(
    JSON.stringify({ today: todayStr, overdue: overdue.length, dueToday: dueToday.length }),
    { headers: { "Content-Type": "application/json" } },
  );
});
