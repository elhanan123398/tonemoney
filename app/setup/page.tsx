"use client";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { unzipSync, strFromU8, gzipSync, strToU8 } from "fflate";
import { parseWhatsApp, applyNames } from "@/lib/chat/parse";
import type { ChatMessage } from "@/lib/chat/types";
import { BRAND } from "@/lib/brand";
import {
  FOCUS, LANGS, RELATIONSHIPS, SOURCES, TOTAL_STEPS, toneCaption,
  type Focus, type Relationship, type ReportLang, type Source,
} from "@/lib/setup";
import { ArrowRight, ClipIcon, FileIcon, Item, SendIcon } from "@/components/receipt";

type Parsed = { messages: ChatMessage[]; groupName: string | null; fileName: string };

async function readChatFile(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (file.name.toLowerCase().endsWith(".zip") || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    const files = unzipSync(buf, { filter: (f) => f.name.toLowerCase().endsWith(".txt") });
    const names = Object.keys(files);
    const name = names.find((n) => n.endsWith("_chat.txt")) ?? names[0];
    if (!name) throw new Error("לא מצאתי קובץ טקסט בתוך ה-zip. ייצאתם \"בלי מדיה\"?");
    return strFromU8(files[name]);
  }
  return new TextDecoder("utf-8").decode(buf);
}

const fmt = (n: number) => n.toLocaleString("he-IL");

/** Reads a JSON reply; a crashed server returns an empty or HTML body, so never surface parser errors. */
async function readJson(r: Response): Promise<{ error?: string; [k: string]: unknown }> {
  try {
    return await r.json();
  } catch {
    return { error: r.ok ? "תשובה לא צפויה מהשרת. נסו שוב." : "משהו השתבש אצלנו בשרת. נסו שוב בעוד דקה." };
  }
}

function App({ children, q }: { children: ReactNode; q?: boolean }) {
  return <div className={`b app ${q ? "q" : ""}`}>{children}</div>;
}
function Me({ children }: { children: ReactNode }) {
  return <div className="b me">{children}</div>;
}

export default function Setup() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [typing, setTyping] = useState(false);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [mergeSel, setMergeSel] = useState<string[]>([]);
  const [merges, setMerges] = useState(0);
  const [me, setMe] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus[]>([]);
  const [spice, setSpice] = useState(50);
  const [lang, setLang] = useState<ReportLang>("he");
  const [email, setEmail] = useState("");
  const [draft, setDraft] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const renamed = useMemo(() => (parsed ? applyNames(parsed.messages, names) : []), [parsed, names]);
  const people = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of renamed) m.set(x.sender, (m.get(x.sender) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [renamed]);
  const originals = useMemo(() => [...new Set((parsed?.messages ?? []).map((m) => m.sender))], [parsed]);
  const originalsOf = (display: string) => originals.filter((o) => (names[o] ?? o) === display);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [step, typing, codeSent, uploadErr, err, parsed, people.length]);

  /** advance with a short "typing…" beat so it reads like a conversation */
  function next() {
    setTyping(true);
    setStep((s) => s + 1);
    setTimeout(() => setTyping(false), 550);
  }
  function back() {
    if (step === 1) return router.push("/");
    if (step === 8 && codeSent) { setCodeSent(false); setCode(""); return; }
    setStep(step - 1);
  }

  async function onFile(file: File) {
    setUploadErr(null);
    try {
      const text = await readChatFile(file);
      const res = parseWhatsApp(text);
      if (res.messages.length < 10) throw new Error("לא הצלחתי לקרוא הודעות מהקובץ. זה ייצוא של WhatsApp?");
      setParsed({ messages: res.messages, groupName: res.groupName, fileName: file.name });
      const senders = [...new Set(res.messages.map((m) => m.sender))];
      setGroupName(res.groupName ?? (senders.length === 2 ? senders.join(" ו") : "הקבוצה"));
      setNames({});
      setMe(null);
      setMerges(0);
      next();
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : "שגיאה בקריאת הקובץ");
    }
  }

  function merge() {
    if (mergeSel.length < 2) return;
    const target = mergeSel[0];
    const nextNames = { ...names };
    for (const display of mergeSel.slice(1)) for (const o of originalsOf(display)) nextNames[o] = target;
    setNames(nextNames);
    setMerges((m) => m + mergeSel.length - 1);
    setMergeSel([]);
  }

  function rename(display: string, value: string) {
    const v = value.trim();
    if (!v || v === display) return;
    const nextNames = { ...names };
    for (const o of originalsOf(display)) nextNames[o] = v;
    setNames(nextNames);
    if (me === display) setMe(v);
  }

  async function sendEmail() {
    const e = draft.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return setErr("זה לא נראה כמו כתובת מייל. נסו שוב?");
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/otp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e }) });
      const j = await readJson(r);
      if (!r.ok || j.error) throw new Error(j.error ?? "שגיאה");
      setEmail(e);
      setDraft("");
      setCodeSent(true);
      setDevCode(typeof j.devCode === "string" ? j.devCode : null);
      setTyping(true);
      setTimeout(() => setTyping(false), 500);
    } catch (x) {
      setErr(x instanceof Error && /[\u0590-\u05FF]/.test(x.message) ? x.message : "אין חיבור לשרת. בדקו את האינטרנט ונסו שוב.");
    } finally {
      setBusy(false);
    }
  }

  async function finish(c: string) {
    setErr(null);
    setBusy(true);
    try {
      const finalNames: Record<string, string> = {};
      for (const o of originals) finalNames[o] = (names[o] ?? o).trim() || o;
      const r = await fetch("/api/chats", {
        method: "POST",
        headers: { "content-type": "application/gzip" },
        body: gzipSync(strToU8(JSON.stringify({
          email,
          code: c,
          messages: renamed,
          answers: { relationship, source, names: finalNames, me, groupName, focus, spice, lang, email },
        }))),
      });
      const j = await readJson(r);
      if (!r.ok || j.error) throw new Error(j.error ?? "שגיאה");
      router.push(`/c/${j.id}`);
    } catch (x) {
      setErr(x instanceof Error && /[\u0590-\u05FF]/.test(x.message) ? x.message : "אין חיבור לשרת. בדקו את האינטרנט ונסו שוב.");
      setCode("");
      setBusy(false);
    }
  }

  const label = <T extends string>(list: { id: T; label: string }[], id: T | null) => list.find((x) => x.id === id)?.label ?? "";
  const total = renamed.length;

  // ---------- the thread: answered steps + the current question ----------
  const turns: { q: ReactNode; a?: ReactNode; ack?: ReactNode }[] = [
    {
      q: (
        <>
          <App>היי. אני קורא צ'אטים מההתחלה ועד הסוף, ומדפיס עליהם קבלה.</App>
          <App>שמונה שאלות קצרות ואני מתחיל. הראשונה:</App>
          <App q>מה הקשר בין האנשים בצ'אט?</App>
        </>
      ),
      a: label(RELATIONSHIPS, relationship),
      ack: <App>רשמתי.</App>,
    },
    { q: <App q>מאיפה הצ'אט?</App>, a: label(SOURCES, source) },
    {
      q: (
        <>
          <App q>שלחו לי את הצ'אט.</App>
          <App>
            בוואטסאפ: נכנסים לצ'אט ← לוחצים על השם למעלה ← ייצוא צ'אט ← <b>בלי מדיה</b>. את קובץ ה-zip שמקבלים מצרפים לכאן.
          </App>
        </>
      ),
      a: parsed && (
        <span className="filecard">
          <FileIcon />
          <span><span className="fn">{parsed.fileName}</span><span className="fm">{fmt(parsed.messages.length)} הודעות</span></span>
        </span>
      ),
      ack: parsed && (
        <App>
          קיבלתי. {fmt(parsed.messages.length)} הודעות מ-{fmt(originals.length)} אנשים
          {parsed.messages.length > 2000 ? ". איכות מעולה." : parsed.messages.length > 300 ? ". מספיק בהחלט." : ". קצר, אבל אסתדר."}{" "}
          הקובץ נקרא כאן בדפדפן, ועוד לא נשלח לשום מקום.
        </App>
      ),
    },
    {
      q: (
        <>
          <App>
            אלה האנשים שמצאתי:
            <div className="mini">
              {people.slice(0, 8).map(([n, c]) => <Item key={n} k={n} v={`${Math.round((c / Math.max(1, total)) * 100)}%`} />)}
              {people.length > 8 && <span style={{ fontSize: 12, color: "var(--on-dark-2)" }}>ועוד {people.length - 8}</span>}
            </div>
          </App>
          <App q>מישהו מופיע פעמיים? (מספר ישן, שם אחר)</App>
        </>
      ),
      a: merges ? `איחדתי ${merges === 1 ? "פרופיל אחד" : `${merges} פרופילים`}. עכשיו זה נכון.` : "הכל נכון",
    },
    {
      q: <App q>איך לקרוא לכל אחד? ומי מהם את/ה?</App>,
      a: me ? `אני ${me}` : "",
      ack: me && <App>נעים מאוד, {me}.</App>,
    },
    {
      q: <App q>מה הכי מעניין אותך לגלות? עד שלושה.</App>,
      a: focus.map((f) => label(FOCUS, f)).join(" · "),
    },
    {
      q: <App q>כמה ישיר לכתוב, ובאיזו שפה?</App>,
      a: `${toneCaption(spice)} · ${label(LANGS, lang)}`,
      ack: <App>אחרונה.</App>,
    },
    {
      q: <App q>לאן לשלוח את הקבלה? רק מייל, בלי סיסמה.</App>,
      a: email || undefined,
    },
  ];

  const S = step; // current step (1-based)

  return (
    <main className="chat" onDragOver={(e) => { if (S === 3) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={(e) => { if (S === 3) { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); } }}>
      <header className="chat-head">
        <button className="icon-btn" onClick={back} aria-label="חזרה"><ArrowRight /></button>
        <div className="c"><div className="n">{BRAND.product}</div><div className="s">שואל 8 שאלות, ואז קורא</div></div>
        <span className="step-pill" aria-label={`שאלה ${S} מתוך ${TOTAL_STEPS}`}>{S}/{TOTAL_STEPS}</span>
      </header>

      <div className="thread" ref={threadRef} aria-live="polite">
        <span className="day">היום</span>
        {turns.slice(0, S).map((t, i) => {
          const n = i + 1;
          const done = n < S;
          return (
            <Fragment key={n}>
              {(n < S || !typing) && t.q}
              {done && t.a && <Me>{t.a}</Me>}
              {done && t.ack}
            </Fragment>
          );
        })}
        {typing && <div className="typing" aria-label="מקליד"><i /><i /><i /></div>}
        {!typing && S === 3 && uploadErr && <div className="b err">{uploadErr}</div>}
        {!typing && S === 8 && codeSent && (
          <>
            <App>שלחתי קוד בן 6 ספרות ל-<span dir="ltr">{email}</span>. מה הוא?</App>
            {devCode && <App><span className="mono" style={{ fontSize: 13 }}>מצב פיתוח: {devCode}</span></App>}
          </>
        )}
        {!typing && S === 8 && busy && codeSent && <><Me><span className="mono" dir="ltr">{"• ".repeat(6).trim()}</span></Me><App>מתחיל לקרוא.</App></>}
        {err && <div className="b err">{err}</div>}
      </div>

      <div className="panel">
        {S === 1 && (
          <>
            <span className="cap">תשובות מהירות</span>
            <div className="qr">
              {RELATIONSHIPS.map((o) => (
                <button key={o.id} aria-pressed={relationship === o.id} onClick={() => { setRelationship(o.id); next(); }}>{o.label}</button>
              ))}
            </div>
          </>
        )}

        {S === 2 && (
          <>
            <span className="cap">תשובות מהירות</span>
            <div className="qr">
              {SOURCES.map((o) => (
                <button key={o.id} disabled={!o.supported} aria-pressed={source === o.id} onClick={() => { setSource(o.id); next(); }}>
                  {o.label}{!o.supported && <span className="soon">בקרוב</span>}
                </button>
              ))}
            </div>
          </>
        )}

        {S === 3 && (
          <>
            <button className={`attach ${over ? "over" : ""}`} onClick={() => fileRef.current?.click()}><ClipIcon />צירוף קובץ ה-zip</button>
            <input ref={fileRef} type="file" accept=".zip,.txt,application/zip,text/plain" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            <span className="cap"><span>אפשר גם לגרור את הקובץ לכאן</span><span>zip או txt</span></span>
          </>
        )}

        {S === 4 && (
          <>
            <label className="composer" style={{ height: 44 }}>
              <span className="sr">שם הקבוצה</span>
              <span className="muted" style={{ fontSize: 13, whiteSpace: "nowrap" }}>שם הקבוצה:</span>
              <input value={groupName} onChange={(e) => setGroupName(e.target.value)} />
            </label>
            <span className="cap"><span>סמנו שני פרופילים של אותו אדם</span><span>{mergeSel.length > 0 ? `${mergeSel.length} מסומנים` : ""}</span></span>
            <div className="chipset">
              {people.map(([n, c]) => (
                <button key={n} aria-pressed={mergeSel.includes(n)} onClick={() => setMergeSel(mergeSel.includes(n) ? mergeSel.filter((x) => x !== n) : [...mergeSel, n])}>
                  {n}<span className="c">{fmt(c)}</span>
                </button>
              ))}
            </div>
            <div className="row2">
              <button className="pill ghost small" disabled={mergeSel.length < 2} onClick={merge}>{mergeSel.length >= 2 ? `לאחד ל"${mergeSel[0]}"` : "לאחד מסומנים"}</button>
              <button className="pill small" onClick={next}>הכל נכון</button>
            </div>
          </>
        )}

        {S === 5 && (
          <>
            <span className="cap"><span>לחצו על שם כדי לשנות אותו</span><span>{me ? "" : "סמנו מי את/ה"}</span></span>
            <div className="names">
              {people.slice(0, 30).map(([n]) => (
                <div className="nr" key={n}>
                  <input defaultValue={n} aria-label={`שם עבור ${n}`} onBlur={(e) => rename(n, e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
                  <button aria-pressed={me === n} onClick={() => setMe(n)}>{me === n ? "זה אני" : "אני?"}</button>
                </div>
              ))}
            </div>
            <button className="pill small" disabled={!me} onClick={next}>זהו</button>
          </>
        )}

        {S === 6 && (
          <>
            <span className="cap"><span>בחרו עד שלושה</span><span className="mono">{focus.length}/3</span></span>
            <div className="qr">
              {FOCUS.map((o) => (
                <button
                  key={o.id}
                  aria-pressed={focus.includes(o.id)}
                  onClick={() => setFocus(focus.includes(o.id) ? focus.filter((x) => x !== o.id) : focus.length >= 3 ? [...focus.slice(1), o.id] : [...focus, o.id])}
                >{o.label}</button>
              ))}
            </div>
            <button className="pill small" disabled={!focus.length} onClick={next}>זהו</button>
          </>
        )}

        {S === 7 && (
          <>
            <div className="tone">
              <div className="cap2" aria-live="polite">{toneCaption(spice)}</div>
              <input className="range" type="range" min={0} max={100} value={spice} onChange={(e) => setSpice(+e.target.value)} aria-label="כמה ישיר" aria-valuetext={toneCaption(spice)} />
              <div className="ends"><span>עדין</span><span>בלי הנחות</span></div>
            </div>
            <div className="chipset" role="radiogroup" aria-label="שפת הקבלה">
              {LANGS.map((l) => <button key={l.id} role="radio" aria-checked={lang === l.id} aria-pressed={lang === l.id} onClick={() => setLang(l.id)}>{l.label}</button>)}
            </div>
            <button className="pill small" onClick={next}>אישור</button>
          </>
        )}

        {S === 8 && !codeSent && (
          <>
            <form className="composer" onSubmit={(e) => { e.preventDefault(); sendEmail(); }}>
              <label className="sr" htmlFor="email">אימייל</label>
              <input id="email" type="email" inputMode="email" autoComplete="email" dir="ltr" placeholder="you@example.com" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button className="send" type="submit" disabled={busy || !draft.includes("@")} aria-label="שליחה"><SendIcon /></button>
            </form>
            <span className="cap"><span>בלחיצה אני מאשר/ת שמותר לי לשתף את הצ'אט. הוא יימחק אחרי 48 שעות אם לא אזמין קבלה.</span></span>
          </>
        )}

        {S === 8 && codeSent && (
          <form className="composer" onSubmit={(e) => { e.preventDefault(); if (code.length === 6) finish(code); }}>
            <label className="sr" htmlFor="code">קוד בן 6 ספרות</label>
            <input
              id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} dir="ltr" placeholder="••••••"
              style={{ letterSpacing: 8, fontFamily: "var(--mono)" }}
              value={code}
              onChange={(e) => { const v = e.target.value.replace(/\D/g, "").slice(0, 6); setCode(v); if (v.length === 6) finish(v); }}
              disabled={busy}
            />
            <button className="send" type="submit" disabled={busy || code.length !== 6} aria-label="אישור קוד"><SendIcon /></button>
          </form>
        )}
      </div>
    </main>
  );
}
