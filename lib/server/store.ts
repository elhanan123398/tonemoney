import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";
import { neon } from "@neondatabase/serverless";
import type { ChatMessage, ChatStats } from "../chat/types";
import type { SetupAnswers } from "../setup";
import type { Report } from "../report/schema";

export interface ChatRecord {
  id: string;
  createdAt: number;
  email: string;
  answers: SetupAnswers;
  stats: ChatStats;
  /** deleted by the cleanup job; the report survives */
  messages: ChatMessage[] | null;
  report: Report | null;
  reportStatus: "none" | "writing" | "done" | "error";
  reportError?: string;
  reportAt: number | null;
  cutoff: number | null;
  readMessages: number;
  paid: boolean;
  paidAt: number | null;
  shareToken: string | null;
  stripeSessionId?: string;
  /** what the LLM calls for this report cost, in USD */
  reportCostUsd?: number;
}

export const newId = (bytes = 16) => crypto.randomBytes(bytes).toString("base64url");
const idRe = /^[A-Za-z0-9_-]{16,64}$/;

/** Demo mode: OTP shown on screen and checkout skipped. Never on in real production. */
export const demoMode = () => process.env.NODE_ENV !== "production" || process.env.DEMO_MODE === "1";

const pack = (msgs: ChatMessage[] | null) => (msgs ? Buffer.from(gzipSync(strToU8(JSON.stringify(msgs)))).toString("base64") : null);
const unpack = (b64: string | null): ChatMessage[] | null => (b64 ? JSON.parse(strFromU8(gunzipSync(Buffer.from(b64, "base64")))) : null);

// ---------------------------------------------------------------------------
// Postgres (Neon) when DATABASE_URL is set – required on Vercel.
// Schema: see db/schema.sql
// ---------------------------------------------------------------------------
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
if (!sql && process.env.VERCEL) {
  // Vercel's filesystem is read-only and not shared between requests: the file store cannot work there.
  console.error("[store] DATABASE_URL is not set on Vercel – add it in Project Settings > Environment Variables.");
}

type Row = { id: string; data: Omit<ChatRecord, "messages">; messages_gz: string | null };
const fromRow = (r: Row): ChatRecord => ({ ...r.data, messages: unpack(r.messages_gz) });

// ---------------------------------------------------------------------------
// File store fallback for local development.
// ---------------------------------------------------------------------------
const DIR = process.env.DATA_DIR ?? path.join(process.cwd(), ".data");
const chatsDir = path.join(DIR, "chats");
const ensure = () => {
  if (process.env.VERCEL) throw new Error("DATABASE_URL is not set");
  return fs.mkdir(chatsDir, { recursive: true });
};

export async function saveChat(rec: ChatRecord): Promise<void> {
  if (sql) {
    const { messages, ...data } = rec;
    await sql`
      insert into chats (id, share_token, created_at, paid, report_at, data, messages_gz)
      values (${rec.id}, ${rec.shareToken}, to_timestamp(${rec.createdAt / 1000}), ${rec.paid},
              ${rec.reportAt ? new Date(rec.reportAt).toISOString() : null}, ${JSON.stringify(data)}::jsonb, ${pack(messages)})
      on conflict (id) do update set
        share_token = excluded.share_token, paid = excluded.paid, report_at = excluded.report_at,
        data = excluded.data, messages_gz = excluded.messages_gz`;
    return;
  }
  await ensure();
  const file = path.join(chatsDir, `${rec.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rec));
  await fs.rename(tmp, file);
}

/** Updates only the metadata (not the messages blob) – cheaper for status changes. */
export async function updateChat(rec: ChatRecord): Promise<void> {
  if (!sql) return saveChat(rec);
  const { messages: _m, ...data } = rec;
  await sql`
    update chats set share_token = ${rec.shareToken}, paid = ${rec.paid},
      report_at = ${rec.reportAt ? new Date(rec.reportAt).toISOString() : null}, data = ${JSON.stringify(data)}::jsonb
    where id = ${rec.id}`;
}

export async function getChat(id: string): Promise<ChatRecord | null> {
  if (!idRe.test(id)) return null;
  if (sql) {
    const rows = (await sql`select id, data, messages_gz from chats where id = ${id}`) as Row[];
    return rows[0] ? fromRow(rows[0]) : null;
  }
  try {
    return JSON.parse(await fs.readFile(path.join(chatsDir, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function findByShareToken(token: string): Promise<ChatRecord | null> {
  if (!idRe.test(token)) return null;
  if (sql) {
    const rows = (await sql`select id, data, null as messages_gz from chats where share_token = ${token} and paid`) as Row[];
    return rows[0] ? fromRow(rows[0]) : null;
  }
  await ensure();
  for (const f of await fs.readdir(chatsDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(await fs.readFile(path.join(chatsDir, f), "utf8")) as ChatRecord;
      if (rec.shareToken === token) return rec;
    } catch {}
  }
  return null;
}

/** Privacy policy: delete unpaid chats after 48h; drop raw messages 7 days after the report. */
export async function cleanup(): Promise<{ deleted: number; purged: number }> {
  const H = 3_600_000;
  const now = Date.now();
  if (sql) {
    const d = (await sql`delete from chats where not paid and created_at < now() - interval '48 hours' returning id`) as unknown[];
    const p = (await sql`update chats set messages_gz = null where paid and messages_gz is not null and report_at < now() - interval '7 days' returning id`) as unknown[];
    return { deleted: d.length, purged: p.length };
  }
  await ensure();
  let deleted = 0;
  let purged = 0;
  for (const f of await fs.readdir(chatsDir)) {
    if (!f.endsWith(".json")) continue;
    const file = path.join(chatsDir, f);
    const rec = JSON.parse(await fs.readFile(file, "utf8")) as ChatRecord;
    if (!rec.paid && now - rec.createdAt > 48 * H) {
      await fs.rm(file, { force: true });
      deleted++;
    } else if (rec.paid && rec.messages && rec.reportAt && now - rec.reportAt > 7 * 24 * H) {
      await saveChat({ ...rec, messages: null });
      purged++;
    }
  }
  return { deleted, purged };
}

// ---- OTP (email + 6 digits, no password) ----
const otpFile = path.join(DIR, "otp.json");
type OtpRow = { hash: string; exp: number; tries: number };
const hash = (email: string, code: string) => crypto.createHash("sha256").update(`${email.toLowerCase()}:${code}`).digest("hex");

async function readOtp(): Promise<Record<string, OtpRow>> {
  try {
    return JSON.parse(await fs.readFile(otpFile, "utf8"));
  } catch {
    return {};
  }
}

export async function issueOtp(email: string): Promise<string> {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const e = email.toLowerCase();
  if (sql) {
    await sql`
      insert into otps (email, hash, expires_at, tries) values (${e}, ${hash(e, code)}, now() + interval '10 minutes', 0)
      on conflict (email) do update set hash = excluded.hash, expires_at = excluded.expires_at, tries = 0`;
    return code;
  }
  if (process.env.VERCEL) throw new Error("DATABASE_URL is not set");
  await fs.mkdir(DIR, { recursive: true });
  const all = await readOtp();
  all[e] = { hash: hash(e, code), exp: Date.now() + 10 * 60_000, tries: 0 };
  await fs.writeFile(otpFile, JSON.stringify(all));
  return code;
}

export async function checkOtp(email: string, code: string): Promise<boolean> {
  const e = email.toLowerCase();
  if (sql) {
    const rows = (await sql`select hash, tries, expires_at > now() as valid from otps where email = ${e}`) as { hash: string; tries: number; valid: boolean }[];
    const row = rows[0];
    if (!row || !row.valid || row.tries >= 5) return false;
    if (row.hash === hash(e, code)) {
      await sql`delete from otps where email = ${e}`;
      return true;
    }
    await sql`update otps set tries = tries + 1 where email = ${e}`;
    return false;
  }
  const all = await readOtp();
  const row = all[e];
  if (!row || row.exp < Date.now() || row.tries >= 5) return false;
  const ok = row.hash === hash(e, code);
  if (ok) delete all[e];
  else row.tries++;
  await fs.writeFile(otpFile, JSON.stringify(all));
  return ok;
}
