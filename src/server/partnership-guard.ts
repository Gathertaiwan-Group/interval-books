/**
 * 異業合作表單的防濫用零件：表單 token（最短填寫時間）、蜜罐、每 IP 限流。
 *
 * 只依賴 node:crypto，**不 import server-only**——自檢要直接載入
 * （scripts/partnership-selftest.mjs，與 src/server/amego.ts 同一個理由：驗一份複製品
 * 等於沒驗）。真正的呼叫端是 src/server/partnership.ts。
 *
 * ── 為什麼要有這些 ────────────────────────────────────────────────────────
 * 這是一個**不用登入就能觸發寄信**的端點。收件人固定是店家（不接受客人指定，所以不是
 * open relay），但被灌爆一樣會讓店家信箱失去用處，也會吃掉 Resend 的額度與寄件信譽。
 *
 *   1. 蜜罐：一個畫面上看不見的欄位。人類不會填，照表單填空的機器人會。
 *   2. 表單 token：頁面出現時向伺服器拿一張「發行時間＋HMAC」的票，送出時驗：
 *        · 簽章對不對（不能自己捏一個很久以前的時間）；
 *        · 距離發行至少 MIN_FILL_MS（3 秒，人類填不完這張表）；
 *        · 不超過 MAX_AGE_MS（一天；太舊的票請重新整理）。
 *   3. 每 IP 限流：記憶體裡的滑動視窗。⚠️ **best-effort**：Vercel 的每一個 instance
 *      各有一份，冷啟動就歸零。它擋的是「一台機器在一分鐘內狂送」，不是分散式攻擊。
 *      沒有 DDL 權限（2026-10-26），所以沒有放進資料庫。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseRecipients } from "../lib/email-templates.ts";

export const MIN_FILL_MS = 3_000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** HMAC 的用途標籤：同一把 secret 用在別處時，簽出來的東西不能互相冒用。 */
const TOKEN_PURPOSE = "ib-partnership-form-v1";

function sign(issuedAt: number, secret: string): string {
  return createHmac("sha256", secret).update(`${TOKEN_PURPOSE}|${issuedAt}`).digest("base64url");
}

/** 「<發行時間 ms>.<簽章>」 */
export function issueFormToken(secret: string, now: number = Date.now()): string {
  if (!secret) throw new Error("[partnership] 沒有簽 token 用的 secret");
  const issuedAt = Math.floor(now);
  return `${issuedAt}.${sign(issuedAt, secret)}`;
}

export type TokenCheck = "ok" | "invalid" | "too_fast" | "expired";

export function checkFormToken(
  token: unknown,
  secret: string,
  now: number = Date.now(),
): TokenCheck {
  if (typeof token !== "string" || token.length > 200 || !secret) return "invalid";
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{20,100})$/.exec(token);
  if (!m) return "invalid";
  const issuedAt = Number(m[1]);
  const expected = Buffer.from(sign(issuedAt, secret));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "invalid";
  const age = now - issuedAt;
  // 未來的時間（時鐘被竄改或 token 是偽造的）當作無效，不是「太快」。
  if (age < -5_000) return "invalid";
  if (age < MIN_FILL_MS) return "too_fast";
  if (age > MAX_AGE_MS) return "expired";
  return "ok";
}

/** 蜜罐欄位：任何非空白內容都算中招。 */
export function honeypotTripped(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value != null && value !== false;
}

/**
 * 滑動視窗限流。`limit` 次／`windowMs`，key 通常是 IP。
 *
 * Map 有上限（maxKeys）：被大量不同 IP 打的時候，先丟掉最舊的 key，不讓記憶體無限長。
 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  // 不用 parameter properties：Node 的型別剝離（自檢直接載入）不支援那個語法。
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  constructor(limit: number, windowMs: number, maxKeys = 5_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  /** 這一次算不算數？算數就記一筆並回 true；超過上限回 false（不記）。 */
  take(key: string, now: number = Date.now()): boolean {
    const since = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.delete(key); // 重新插入 → 移到 Map 的最後面（最新）
    this.hits.set(key, list);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
    return true;
  }
}

/**
 * 從請求標頭取客人的 IP。Vercel 會設 x-vercel-forwarded-for／x-real-ip（由平台覆寫，
 * 客人自己帶的值不會原樣傳進來）；都沒有時才看 x-forwarded-for 的第一段。
 * 都拿不到就回 "unknown"——所有拿不到 IP 的請求共用一個桶，寧可誤擋也不放生。
 */
export function clientIpFrom(get: (name: string) => string | undefined): string {
  const pick = (v: string | undefined) => (v ?? "").split(",")[0]?.trim() ?? "";
  const ip =
    pick(get("x-vercel-forwarded-for")) || pick(get("x-real-ip")) || pick(get("x-forwarded-for"));
  return ip && ip.length <= 64 ? ip : "unknown";
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/**
 * 收件人：site_settings.notify_emails 拆開（parseRecipients，與新訂單通知同一支）、
 * 丟掉不像 email 的段落。
 *
 * testOverride（環境變數 PARTNERSHIP_TEST_RECIPIENT）只有在**每一個地址都是
 * `@resend.dev`** 時才生效——那是 Resend 的測試信箱，不會進到任何真人的收件匣。
 * 其他值一律忽略，這個開關不能被拿來把表單導去別的真實信箱。
 */
export function resolvePartnershipRecipients(
  notifyEmails: string | null | undefined,
  testOverride: string | null | undefined,
): { to: string[]; test: boolean } {
  const override = parseRecipients(testOverride);
  if (override.length > 0) {
    if (override.every((a) => /@resend\.dev$/i.test(a) && EMAIL_RE.test(a))) {
      return { to: override, test: true };
    }
    console.warn("[partnership] 忽略 PARTNERSHIP_TEST_RECIPIENT：只接受 @resend.dev 地址");
  }
  return { to: parseRecipients(notifyEmails).filter((a) => EMAIL_RE.test(a)), test: false };
}
