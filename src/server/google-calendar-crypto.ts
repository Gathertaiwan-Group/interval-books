/**
 * Google 日曆連結的密碼學小工具：refresh token 的靜態加密（AES-256-GCM）、OAuth state cookie
 * 的簽章（HMAC-SHA256）、PKCE。
 *
 * ⚠️ 這支檔案只 import node:crypto（同 src/server/blackcat.ts 的規約）：
 *    scripts/google-calendar-selftest.mjs 直接 import 真正的程式碼測加解密與竄改偵測。
 *
 * ── refresh token 存哪裡、怎麼輪替 ───────────────────────────────────────────
 * 密文存在資料庫 public.google_calendar_sync.refresh_token_enc（0060，只有 service_role 讀得到），
 * 金鑰在 Vercel env（GOOGLE_CALENDAR_TOKEN_KEY，32 bytes base64）。兩邊要同時外洩才拿得到
 * token：資料庫備份（gooddays-db-backup）或 Supabase 被讀走，沒有 Vercel 的金鑰也只是亂碼。
 *
 * 密文格式：v1.<kid>.<iv>.<ciphertext>.<tag>（base64url；kid = sha256(金鑰) 前 8 hex）。
 * AAD 綁定用途字串，這份密文拿去別的欄位用解不開。
 *
 * 輪替金鑰：把舊值搬到 GOOGLE_CALENDAR_TOKEN_KEY_PREVIOUS、新值放 GOOGLE_CALENDAR_TOKEN_KEY →
 * 重新部署 → 下一輪同步用舊鑰解開後自動以新鑰重新加密寫回 → 後台顯示同步成功後即可刪掉
 * _PREVIOUS。輪替 token 本身：後台「中斷連結」（會向 Google 撤銷）再重新連結。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const TOKEN_AAD = Buffer.from("intervalbooks:google-calendar:refresh-token:v1", "utf8");
const FORMAT = "v1";

const b64url = (b: Buffer) => b.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

/** env 的金鑰字串（base64 或 base64url，解出來必須正好 32 bytes）→ Buffer；不合格 → null。 */
export function parseTokenKey(raw: string | undefined | null): Buffer | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const buf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.length === 32 ? buf : null;
}

export function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(TOKEN_AAD);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT, keyId(key), b64url(iv), b64url(ct), b64url(tag)].join(".");
}

export type Decrypted = {
  plaintext: string;
  keyId: string;
  /** 不是用第一把（現行）金鑰解開的 → 該重新加密。 */ stale: boolean;
};

/**
 * 依序用 keys（第一把是現行金鑰）嘗試解密。格式錯、kid 對不上任何一把、被竄改 → throw。
 */
export function decryptSecret(blob: string, keys: Buffer[]): Decrypted {
  const parts = blob.split(".");
  if (parts.length !== 5 || parts[0] !== FORMAT) throw new Error("token 密文格式不正確");
  const [, kid, iv, ct, tag] = parts;
  const idx = keys.findIndex((k) => keyId(k) === kid);
  if (idx < 0)
    throw new Error("token 密文的金鑰不在目前的設定裡（金鑰被換掉但沒有設 _PREVIOUS？）");
  const tagBuf = fromB64url(tag);
  if (tagBuf.length !== 16) throw new Error("token 密文的驗證標籤長度不正確");
  const decipher = createDecipheriv("aes-256-gcm", keys[idx], fromB64url(iv), {
    authTagLength: 16,
  });
  decipher.setAAD(TOKEN_AAD);
  decipher.setAuthTag(tagBuf);
  const plaintext = Buffer.concat([decipher.update(fromB64url(ct)), decipher.final()]).toString(
    "utf8",
  );
  return { plaintext, keyId: kid, stale: idx !== 0 };
}

// =============================================================================
// OAuth state cookie
// =============================================================================

export type OAuthStatePayload = {
  /** 隨機 state（同時放在 Google 的 redirect 參數裡）。 */
  s: string;
  /** PKCE code_verifier。 */
  v: string;
  /** 發起連結的管理員 user id：callback 必須是同一個人。 */
  u: string;
  /** 到期時間（epoch ms）。 */
  exp: number;
};

function stateMacKey(tokenKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", tokenKey, Buffer.alloc(0), "gcal-oauth-state-v1", 32));
}

export function signState(payload: OAuthStatePayload, tokenKey: Buffer): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = createHmac("sha256", stateMacKey(tokenKey)).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

/** 簽章不符、格式錯、過期 → null。 */
export function verifyState(
  token: string | undefined | null,
  tokenKey: Buffer,
  nowMs: number,
): OAuthStatePayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = fromB64url(token.slice(dot + 1));
  const expected = createHmac("sha256", stateMacKey(tokenKey)).update(body).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  try {
    const p = JSON.parse(fromB64url(body).toString("utf8")) as OAuthStatePayload;
    if (typeof p.s !== "string" || typeof p.v !== "string" || typeof p.u !== "string") return null;
    if (typeof p.exp !== "number" || p.exp < nowMs) return null;
    return p;
  } catch {
    return null;
  }
}

/** 常數時間字串比對。 */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}
