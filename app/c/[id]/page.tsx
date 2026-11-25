"use client";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ChatStats } from "@/lib/chat/types";
import type { PublicReport } from "@/lib/report/schema";
import { StatsReceipt } from "@/components/StatsReceipt";
import { ReportView } from "@/components/ReportView";
import { BRAND } from "@/lib/brand";
import { Item } from "@/components/receipt";

const WRITING_LINES = ["מסכם את פריט 3…", "בודק כל ציטוט מול המקור…", "סופר מי ענה למי…", "מוחק משפט אחד מיותר…", "מנסח את השורה התחתונה…", "מכין שורה לכל אחד…"];

type Phase = "reading" | "receipt" | "writing" | "report";
type Meta = { stats: ChatStats; groupName: string; reportStatus: string; paid: boolean };

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const search = useSearchParams();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [phase, setPhase] = useState<Phase>("reading");
  const [report, setReport] = useState<PublicReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [readCount, setReadCount] = useState(0);
  const [writeProgress, setWriteProgress] = useState(0);
  const [lineIdx, setLineIdx] = useState(0);
  const started = useRef(false);

  const loadReport = useCallback(async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const r = await fetch(`/api/chats/${id}/report`, { method: "POST" });
      if (r.status === 202) { await new Promise((res) => setTimeout(res, 4000)); continue; }
      const j = await r.json().catch(() => ({ error: "משהו השתבש אצלנו בשרת. רעננו את הדף בעוד דקה." }));
      if (!r.ok || j.error) throw new Error(j.error ?? "שגיאה");
      setReport(j);
      return;
    }
    throw new Error("לוקח יותר מדי זמן");
  }, [id]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const r = await fetch(`/api/chats/${id}`);
      if (!r.ok) return setErr("הצ'אט לא נמצא או שנמחק");
      const m: Meta = await r.json();
      setMeta(m);
      const sid = search.get("session_id");
      if (sid) {
        await fetch(`/api/chats/${id}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid }) });
        router.replace(`/c/${id}`);
      }
      // returning visitor with a finished report: skip the theatre
      if (m.reportStatus === "done" || sid) setPhase("report");
      loadReport().catch((e) => setErr(e.message));
    })();
  }, [id, search, router, loadReport]);

  // reading theatre: count up, then go to the stats
  useEffect(() => {
    if (phase !== "reading" || !meta) return;
    const total = meta.stats.totals.messages;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const f = Math.min(1, (t - t0) / 4200);
      setReadCount(Math.round(total * (1 - Math.pow(1 - f, 2))));
      if (f < 1) raf = requestAnimationFrame(tick);
      else setTimeout(() => setPhase("receipt"), 400);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, meta]);

  // writing: fake-but-honest progress until the report lands
  useEffect(() => {
    if (phase !== "writing") return;
    if (report) { setWriteProgress(100); const t = setTimeout(() => setPhase("report"), 500); return () => clearTimeout(t); }
    const iv = setInterval(() => setWriteProgress((p) => Math.min(94, p + (94 - p) * 0.035)), 500);
    const lv = setInterval(() => setLineIdx((i) => i + 1), 2600);
    return () => { clearInterval(iv); clearInterval(lv); };
  }, [phase, report]);

  async function pay() {
    setPaying(true);
    const r = await fetch(`/api/chats/${id}/checkout`, { method: "POST" });
    const j = await r.json().catch(() => ({ error: "התשלום לא זמין כרגע. נסו שוב בעוד דקה." }));
    if (j.url) window.location.href = j.url;
    else { setErr(j.error ?? "שגיאה בתשלום"); setPaying(false); }
  }

  const Top = (
    <div className="topbar">
      <a href="/" className="wordmark">{BRAND.product}</a>
      <span className="serial">{meta?.groupName ?? ""}</span>
    </div>
  );

  if (err) return <main className="shell">{Top}<p style={{ marginTop: 40 }}>{err}</p></main>;
  if (!meta) return <main className="shell">{Top}<p className="muted" style={{ marginTop: 40 }}>טוען…</p></main>;
  const s = meta.stats;

  if (phase === "reading") {
    const pct = s.totals.messages ? readCount / s.totals.messages : 0;
    const lines = [...s.firstMessages, ...s.lastMessages].filter((m) => !m.media);
    const shown = Math.max(1, Math.round(pct * lines.length));
    return (
      <main className="shell">
        {Top}
        <div className="grow" style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 18 }}>
          <div className="slot"><span className="mouth" aria-hidden /><span className="mono" style={{ fontSize: 12, color: "var(--on-dark-2)" }}>PRINTING</span></div>
          <div className="paper" style={{ marginTop: -14, marginInline: 10 }}>
            <div className="mini-thread">
              {lines.slice(0, shown).map((m, k) => (
                <div className="row printed" key={k}><span className="tm">{new Date(m.ts).toLocaleTimeString("he-IL", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" })}</span><span className="who">{m.sender}</span><span className="tx">{m.text}</span></div>
              ))}
            </div>
          </div>
          <div style={{ textAlign: "center" }} aria-live="off">
            <div className="muted" style={{ fontSize: 14 }}>קורא…</div>
            <div className="mono" style={{ fontSize: 34, fontWeight: 700 }}>{readCount.toLocaleString("he-IL")}</div>
            <div className="mono muted" style={{ fontSize: 13 }}>מתוך {s.totals.messages.toLocaleString("he-IL")}</div>
          </div>
        </div>
      </main>
    );
  }

  if (phase === "receipt") {
    return (
      <main className="shell">
        {Top}
        <div style={{ marginTop: 16 }}><StatsReceipt s={s} groupName={meta.groupName} /></div>
        <div style={{ height: 20 }} />
        <button className="pill" onClick={() => setPhase(report ? "report" : "writing")}>ומה זה אומר עליכם?</button>
      </main>
    );
  }

  if (phase === "writing" || !report) {
    return (
      <main className="shell">
        {Top}
        <div className="grow" style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 16 }}>
          <div className="slot"><span className="mouth" aria-hidden /><span className="mono" style={{ fontSize: 12, color: "var(--on-dark-2)" }}>{Math.round(writeProgress)}%</span></div>
          <h1 style={{ margin: 0, fontSize: 26 }}>מחשב את השורה התחתונה.</h1>
          <div className="mono" style={{ color: "var(--on-dark-3)", fontSize: 14, minHeight: 22 }} aria-live="polite">{WRITING_LINES[lineIdx % WRITING_LINES.length]}</div>
          <div className="progress" role="progressbar" aria-valuenow={Math.round(writeProgress)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${writeProgress}%` }} /></div>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>זה לוקח בערך דקה וחצי. כל ציטוט נבדק מול הצ'אט המקורי לפני שהוא מודפס.</p>
        </div>
      </main>
    );
  }

  const shareUrl = report.shareToken && typeof window !== "undefined" ? `${window.location.origin}/r/${report.shareToken}` : null;
  return (
    <main className="shell">
      {Top}
      <div style={{ marginTop: 16 }}><ReportView r={report} onPay={pay} paying={paying} shareUrl={shareUrl} /></div>
      <div style={{ marginTop: 26, display: "flex", flexDirection: "column", gap: 10 }}>
        <button className="pill ghost small" onClick={() => setPhase("receipt")}>לקבלה המפורטת</button>
        <div className="dark-items" style={{ fontSize: 13 }}>
          <Item k="הבא בתור: קבלה 2, על מה שקרה מאז" v="בקרוב" />
        </div>
      </div>
    </main>
  );
}
