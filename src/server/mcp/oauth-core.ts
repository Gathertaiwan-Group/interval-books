/**
 * MCP 的 OAuth 2.1 authorization server —— 純函式核心（2026-10-26）。
 *
 * ── 為什麼有這個檔案 ─────────────────────────────────────────────────────────
 * 老闆在 claude.ai／Claude 桌面版「新增自訂連接器」貼上 /api/mcp，得到「Couldn't register
 * with 小時光's sign-in service」。claude.ai 的連接器**只走 OAuth**（MCP authorization
 * spec 2025-06-18：RFC 9728 protected resource metadata → RFC 8414 AS metadata → RFC 7591
 * 動態註冊 → authorization code + PKCE），不能貼靜態 header。所以這裡實作一個最小、
 * 只服務這一支 MCP 的 authorization server；靜態 MCP_TOKEN 照舊可用（Claude Code）。
 *
 * ── 狀態（2026-10-28 起；0043_mcp_oauth_state.sql）────────────────────────────
 * 一開始沒有 DDL 權限，所以是無狀態設計：
 *   · client_id   ＝ HMAC 簽章的註冊內容（名稱、redirect_uris、驗證方式）。
 *   · client_secret（只有選了 client_secret_post/basic 的客戶端才有）＝ HMAC(client_id)。
 *   · 授權碼／access token／refresh token ＝ AES-256-GCM 加密＋驗證的 blob，內含到期時間。
 *   · 全部的金鑰從 MCP_OAUTH_SECRET 用 HKDF 衍生。**換掉這個環境變數＝全部作廢**
 *     （所有 client、碼、token 一次失效），那仍然是總開關。
 * 這些都還在；0043 之後**另外**多了一層存在資料庫的狀態（介面是下面的 OAuthStore，實作在
 * oauth-store.ts，這個檔案仍然不碰資料庫）：
 *   · 授權碼真正只能用一次：換碼時 consumeOnce(jti)（mcp_oauth_used_codes 的主鍵），
 *     撞到＝重放 → invalid_grant。跨 instance 成立。
 *   · 一次「允許」＝一條授權鏈（mcp_oauth_grants 一列，token 內帶 gid）。refresh 輪替時以
 *     「現在有效的那張 refresh 的 jti」為條件做 compare-and-swap；舊的那張再出現＝重用
 *     （被偷或被重放）→ **整條鏈撤銷**，正牌客戶端也得重新授權（OAuth 2.1 §4.3.1）。
 *     例外：**剛被換掉不到 30 秒**的那一張（REFRESH_REUSE_GRACE_SECONDS）再出現，多半是
 *     回應遺失後的重送或併發 refresh——只回 invalid_grant、不撤銷，免得把老闆踢掉。
 *   · 授權碼在「全部撤銷」之前簽出、之後才兌換 → 作廢（比對 epoch 的 updated_at）。
 *   · /oauth/revoke 與後台「Claude 連線授權」的撤銷真的撤得掉（revoked_at）。
 *   · access token 每次呼叫都確認所屬的鏈沒被撤銷（每個 instance 快取 ≤60 秒）。
 *   · 每人一個 epoch（token 內帶 ep）：後台「全部撤銷」把它加一，連升級前簽發、沒有鏈可撤的
 *     舊 token 也一起失效。
 *
 * ── 升級前簽發的 token（沒有 gid）────────────────────────────────────────────
 *   · 舊 access token：照常有效到它自己到期（≤1 小時），只多檢查 epoch。
 *   · 舊 refresh token：**每一條舊鏈第一次**拿來 refresh 時照常成功，而且當場「搬進」一條新的
 *     授權鏈（at0 沿用，90 天封頂不變），發出帶 gid 的新 token；那條舊鏈（以 sub＋client＋at0
 *     辨識，legacyChainKey）記進 used_codes（'lrt:' 前綴），之後同一條舊鏈的任何一張再出現
 *     ＝重用 → invalid_grant 並撤銷搬進來的那條鏈。所以已經連著的連接器不會
 *     被踢掉，下一次 refresh 起就受撤銷與重用偵測保護。舊 refresh 若一直沒被用，到它自己
 *     的到期日（≤30 天）就失效，之後要重新授權。
 *
 * 仍然存在的限制：限流是記憶體內、每個 instance 各自計算的，是減速帶不是牆；撤銷對
 * access token 最多晚 60 秒生效（快取）。
 *
 * ── 這個檔案的規矩 ───────────────────────────────────────────────────────────
 * 與 core.ts 一樣**只用相對路徑與 node 內建模組**：scripts/mcp-oauth-selftest.mjs 直接
 * import 它本人。任何碰 Supabase／cookie 的事都在 oauth.ts／oauth-consent.ts。
 * 🔴 這裡沒有任何一行會把 token、code、secret 印到 log。
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

/* ------------------------------------------------------------------ 常數 */

export const OAUTH_REGISTER_PATH = "/oauth/register";
export const OAUTH_TOKEN_PATH = "/oauth/token";
export const OAUTH_REVOKE_PATH = "/oauth/revoke";
export const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";

export const PRM_PATH = "/.well-known/oauth-protected-resource";
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** 正式站的 origin。issuer、resource 都以它為準（本機開發另外處理，見 oauthBaseUrl）。 */
export const PRODUCTION_ORIGIN = "https://www.intervalbooks.tw";

export const OAUTH_SCOPE = "mcp";

export const CODE_TTL_SECONDS = 5 * 60;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 從使用者按「允許」那一刻起算，整條 refresh 鏈最多活多久。無狀態下唯一的封頂。 */
export const REFRESH_ABSOLUTE_MAX_SECONDS = 90 * 24 * 60 * 60;
/** 同意頁 CSRF token 的有效時間。 */
export const CONSENT_TTL_SECONDS = 15 * 60;

/** MCP_OAUTH_SECRET 至少要這麼長，否則整個 OAuth 關閉（與 MCP_TOKEN 的 32 字同一條規矩）。 */
export const MIN_SECRET_LENGTH = 32;

/**
 * 允許註冊的 redirect_uri。**白名單制**：精確比對的完整網址＋本機 loopback（Claude Code
 * 在本機開一個 port 接 callback）。其他一律拒絕註冊 —— 這是擋 open redirect 與「註冊一個
 * 指向攻擊者的 client，再騙老闆按允許」的第一道牆。
 */
export const REDIRECT_URI_ALLOWLIST: readonly string[] = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];
/** loopback：http、主機只能是 localhost／127.0.0.1，port 任意。 */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];

export const TOKEN_PREFIX = {
  code: "ibcode1.",
  access: "ibat1.",
  refresh: "ibrt1.",
} as const;
export const CLIENT_ID_PREFIX = "ibc1.";

export const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/* ------------------------------------------------------------------ 小工具 */

export function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromB64url(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  return Buffer.from(s, "base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function oauthEnabled(secret: string | undefined | null): secret is string {
  // Vercel 的 Preview 部署一律關閉：oauthBaseUrl() 在 https 下固定回正式站，preview 若也拿到
  // 這把 secret，就能簽出正式站收的 token（審查 2026-10-26 #2）。本機沒有 VERCEL_ENV。
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv && vercelEnv !== "production") return false;
  return typeof secret === "string" && secret.trim().length >= MIN_SECRET_LENGTH;
}

/* ------------------------------------------------------------------ 金鑰 */

export type OAuthKeys = { enc: Buffer; mac: Buffer };

const keyCache = new Map<string, OAuthKeys>();

/** HKDF 從單一 secret 衍生兩把用途分開的 key。 */
export function deriveKeys(secret: string): OAuthKeys {
  const s = secret.trim();
  const hit = keyCache.get(s);
  if (hit) return hit;
  const salt = Buffer.from("intervalbooks-mcp-oauth-v1");
  const enc = Buffer.from(hkdfSync("sha256", s, salt, "aes-256-gcm", 32));
  const mac = Buffer.from(hkdfSync("sha256", s, salt, "hmac-sha256", 32));
  const keys = { enc, mac };
  keyCache.set(s, keys);
  return keys;
}

function hmac(keys: OAuthKeys, label: string, data: string): Buffer {
  return createHmac("sha256", keys.mac).update(`${label}|${data}`).digest();
}

/* ------------------------------------------------------------------ base URL */

const LOCAL_DEV_HOST_RE = /^(localhost|127\.0\.0\.1)$/;

/**
 * issuer／resource 的 origin。
 *
 * 正式站一律 PRODUCTION_ORIGIN —— **不信任 Host header**（不讓一個偽造的 Host 改寫 metadata
 * 裡的端點）。只有請求本身打的是 localhost／127.0.0.1（本機 vite dev）時才用請求的 origin，
 * 這樣本機能跑完整流程，而本機簽出的 token 的 aud 是 localhost，拿到正式站會被拒。
 */
export function oauthBaseUrl(requestUrl: string): string {
  try {
    const u = new URL(requestUrl);
    if (u.protocol === "http:" && LOCAL_DEV_HOST_RE.test(u.hostname)) return u.origin;
  } catch {
    /* fallthrough */
  }
  return PRODUCTION_ORIGIN;
}

export function resourceFor(base: string): string {
  return `${base}/api/mcp`;
}

/** RFC 8707 的 resource 參數：允許帶或不帶結尾斜線。 */
export function resourceMatches(given: string | null | undefined, base: string): boolean {
  if (given === null || given === undefined || given === "") return true;
  const want = resourceFor(base);
  return given === want || given === `${want}/`;
}

/* ------------------------------------------------------------------ metadata */

export function protectedResourceMetadata(base: string) {
  return {
    resource: resourceFor(base),
    authorization_servers: [base],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "小時光書店後台 MCP",
  };
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}${OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${base}${OAUTH_TOKEN_PATH}`,
    registration_endpoint: `${base}${OAUTH_REGISTER_PATH}`,
    revocation_endpoint: `${base}${OAUTH_REVOKE_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

export function resourceMetadataUrl(base: string): string {
  return `${base}${PRM_PATH}`;
}

/** 401 的 WWW-Authenticate（RFC 9728 §5.1）。 */
export function bearerChallenge(base: string, error?: "invalid_token", description?: string) {
  let v = `Bearer resource_metadata="${resourceMetadataUrl(base)}"`;
  if (error) v += `, error="${error}"`;
  if (description) v += `, error_description="${description.replace(/["\\]/g, "")}"`;
  return v;
}

/* ------------------------------------------------------------------ redirect_uri */

/**
 * 這個 redirect_uri 可不可以被註冊。精確白名單，或 http loopback（任意 port、任意 path）。
 * 不准有 fragment、userinfo；loopback 不准 https 以外的奇怪 scheme。
 */
export function redirectUriAllowed(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 512) return false;
  if (REDIRECT_URI_ALLOWLIST.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTS.includes(u.hostname)) return false;
  if (u.username || u.password || u.hash || uri.includes("#")) return false;
  // 原字串必須就是正規化後的樣子 —— 擋 "http://localhost:1234@evil" 這類解析差異。
  if (!uri.startsWith(`http://${u.host}/`) && uri !== `http://${u.host}`) return false;
  return true;
}

/** 給同意頁顯示「授權後會回到哪裡」。 */
export function redirectDisplay(uri: string): { host: string; loopback: boolean } {
  try {
    const u = new URL(uri);
    return { host: u.host, loopback: LOOPBACK_HOSTS.includes(u.hostname) };
  } catch {
    return { host: uri, loopback: false };
  }
}

/* ------------------------------------------------------------------ client */

export type RegisteredClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: AuthMethod;
  client_id_issued_at: number;
};

type ClientBlob = { v: 1; n: string; r: string[]; m: AuthMethod; t: number };

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  // 控制字元、零寬字元、雙向覆寫字元一律拿掉（同意頁會顯示它）。
  const cleaned = Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
      if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)) return false;
      if (c >= 0x2066 && c <= 0x2069) return false;
      return true;
    })
    .join("")
    .trim()
    .slice(0, 80);
  return cleaned || "MCP client";
}

/**
 * RFC 7591 動態註冊。驗證 → 簽出 client_id。丟 OAuthError（invalid_redirect_uri／
 * invalid_client_metadata）。
 */
export function registerClient(
  body: unknown,
  secret: string,
  now = nowSeconds(),
): RegisteredClient & { client_secret?: string; client_secret_expires_at?: number } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OAuthError("invalid_client_metadata", "body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty array (≤5)");
  }
  for (const u of uris) {
    if (!redirectUriAllowed(u)) {
      throw new OAuthError(
        "invalid_redirect_uri",
        `redirect_uri not allowed: ${typeof u === "string" ? u.slice(0, 200) : typeof u}`,
      );
    }
  }
  const method = (b.token_endpoint_auth_method ?? "none") as AuthMethod;
  if (!AUTH_METHODS.includes(method)) {
    throw new OAuthError("invalid_client_metadata", "unsupported token_endpoint_auth_method");
  }
  if (b.grant_types !== undefined) {
    if (
      !Array.isArray(b.grant_types) ||
      !b.grant_types.every((g) => g === "authorization_code" || g === "refresh_token")
    ) {
      throw new OAuthError("invalid_client_metadata", "unsupported grant_types");
    }
  }
  if (b.response_types !== undefined) {
    if (!Array.isArray(b.response_types) || !b.response_types.every((r) => r === "code")) {
      throw new OAuthError("invalid_client_metadata", "unsupported response_types");
    }
  }
  const blob: ClientBlob = {
    v: 1,
    n: cleanName(b.client_name),
    r: [...new Set(uris as string[])],
    m: method,
    t: now,
  };
  const keys = deriveKeys(secret);
  const body64 = b64url(Buffer.from(JSON.stringify(blob)));
  const sig = b64url(hmac(keys, "client", body64));
  const client_id = `${CLIENT_ID_PREFIX}${body64}.${sig}`;
  const out: RegisteredClient & { client_secret?: string; client_secret_expires_at?: number } = {
    client_id,
    client_name: blob.n,
    redirect_uris: blob.r,
    token_endpoint_auth_method: method,
    client_id_issued_at: now,
  };
  if (method !== "none") {
    out.client_secret = clientSecretFor(client_id, keys);
    out.client_secret_expires_at = 0;
  }
  return out;
}

function clientSecretFor(clientId: string, keys: OAuthKeys): string {
  return b64url(hmac(keys, "secret", clientId));
}

/** 驗 client_id 的簽章並解開。簽章不對／格式不對 → null。 */
export function verifyClientId(clientId: unknown, secret: string): RegisteredClient | null {
  if (typeof clientId !== "string" || clientId.length > 4096) return null;
  if (!clientId.startsWith(CLIENT_ID_PREFIX)) return null;
  const rest = clientId.slice(CLIENT_ID_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const body64 = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  const keys = deriveKeys(secret);
  if (!safeEqual(sig, b64url(hmac(keys, "client", body64)))) return null;
  const raw = fromB64url(body64);
  if (!raw) return null;
  let blob: ClientBlob;
  try {
    blob = JSON.parse(raw.toString("utf8")) as ClientBlob;
  } catch {
    return null;
  }
  if (blob?.v !== 1 || !Array.isArray(blob.r) || !AUTH_METHODS.includes(blob.m)) return null;
  // 白名單之後被收緊時，舊的已簽 client 也要跟著失效。
  if (!blob.r.every(redirectUriAllowed)) return null;
  return {
    client_id: clientId,
    client_name: cleanName(blob.n),
    redirect_uris: blob.r,
    token_endpoint_auth_method: blob.m,
    client_id_issued_at: blob.t,
  };
}

export function clientHash(clientId: string): string {
  return b64url(createHash("sha256").update(clientId).digest()).slice(0, 22);
}

/**
 * Token／revoke 端點的 client 驗證。public client（none）只要 client_id 有效；
 * secret 類的必須帶對 secret（固定時間比對）。
 */
export function authenticateClient(
  params: URLSearchParams,
  authorization: string | null,
  secret: string,
): RegisteredClient {
  let id = params.get("client_id");
  let sec = params.get("client_secret");
  let viaBasic = false;
  if (authorization && /^basic /i.test(authorization)) {
    try {
      const dec = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
      const i = dec.indexOf(":");
      if (i > 0) {
        id = decodeURIComponent(dec.slice(0, i));
        sec = decodeURIComponent(dec.slice(i + 1));
        viaBasic = true;
      }
    } catch {
      /* 交給下面的 invalid_client */
    }
  }
  const client = verifyClientId(id, secret);
  if (!client) throw new OAuthError("invalid_client", "unknown client", 401);
  if (client.token_endpoint_auth_method !== "none") {
    if (client.token_endpoint_auth_method === "client_secret_basic" && !viaBasic) {
      throw new OAuthError("invalid_client", "client must authenticate with HTTP Basic", 401);
    }
    const want = clientSecretFor(client.client_id, deriveKeys(secret));
    if (!sec || !safeEqual(sec, want)) {
      throw new OAuthError("invalid_client", "client authentication failed", 401);
    }
  }
  return client;
}

/* ------------------------------------------------------------------ seal / unseal */

type Kind = keyof typeof TOKEN_PREFIX;

/** AES-256-GCM，AAD＝種類。不同種類的 blob 互相不能冒用（拿 refresh 當 access 會解不開）。 */
export function seal(kind: Kind, payload: Record<string, unknown>, secret: string): string {
  const { enc } = deriveKeys(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", enc, iv);
  cipher.setAAD(Buffer.from(kind));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${TOKEN_PREFIX[kind]}${b64url(Buffer.concat([iv, ct, tag]))}`;
}

export function unseal<T extends { exp: number }>(
  kind: Kind,
  token: unknown,
  secret: string,
  now = nowSeconds(),
): T | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const prefix = TOKEN_PREFIX[kind];
  if (!token.startsWith(prefix)) return null;
  const raw = fromB64url(token.slice(prefix.length));
  if (!raw || raw.length < 12 + 16 + 2) return null;
  const { enc } = deriveKeys(secret);
  try {
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const d = createDecipheriv("aes-256-gcm", enc, iv);
    d.setAAD(Buffer.from(kind));
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    const obj = JSON.parse(pt) as T;
    if (typeof obj?.exp !== "number" || obj.exp <= now) return null;
    return obj;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ PKCE */

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function pkceChallengeFor(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) return false;
  return safeEqual(pkceChallengeFor(verifier), challenge);
}

/* ------------------------------------------------------------------ payloads */

export type CodePayload = {
  exp: number;
  jti: string;
  sub: string;
  cid: string;
  ru: string;
  cc: string;
  sc: string;
  aud: string;
  at0: number;
  /** authorize 時有沒有明講 redirect_uri（RFC 6749 §4.1.3：有講，token 端點才必須相同）。 */
  rp: boolean;
};

export type AccessPayload = {
  exp: number;
  iat: number;
  sub: string;
  cid: string;
  sc: string;
  aud: string;
  /** 授權鏈 id（mcp_oauth_grants.id）。0043 之前簽發的 token 沒有。 */
  gid?: string;
  /** 簽發當下這位使用者的撤銷 epoch。沒有＝0。 */
  ep?: number;
};

export type RefreshPayload = AccessPayload & { at0: number; jti: string };

/* ------------------------------------------------------------------ authorize */

export type AuthorizeRequest = {
  client: RegisteredClient;
  redirectUri: string;
  redirectUriProvided: boolean;
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string;
};

export type AuthorizeCheck =
  | { ok: true; req: AuthorizeRequest }
  /** client／redirect_uri 有問題：**不可以**導回去（那就是 open redirect），只能顯示錯誤。 */
  | { ok: false; fatal: true; message: string }
  /** 其他錯誤：照 RFC 6749 §4.1.2.1 導回 client，帶 error 與 state。 */
  | { ok: false; fatal: false; redirectUrl: string };

export function redirectWith(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params))
    if (v !== null && v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * /oauth/authorize 的參數檢查。順序是刻意的：先確定 client 與 redirect_uri 是真的、是註冊過
 * 的、在白名單內，之後的錯誤才可以導回去。
 */
export function checkAuthorizeParams(query: string, secret: string, base: string): AuthorizeCheck {
  const p = new URLSearchParams(query);
  const dup = (k: string) => p.getAll(k).length > 1;
  if (dup("client_id") || dup("redirect_uri")) {
    return { ok: false, fatal: true, message: "請求參數重複（client_id／redirect_uri）。" };
  }
  const client = verifyClientId(p.get("client_id"), secret);
  if (!client) {
    return {
      ok: false,
      fatal: true,
      message: "這個應用程式沒有註冊過，或註冊已失效。請回到 Claude 重新新增連接器。",
    };
  }
  let redirectUri = p.get("redirect_uri");
  const redirectUriProvided = redirectUri !== null;
  if (redirectUri === null) {
    if (client.redirect_uris.length !== 1) {
      return { ok: false, fatal: true, message: "缺少 redirect_uri。" };
    }
    redirectUri = client.redirect_uris[0];
  }
  if (!client.redirect_uris.includes(redirectUri) || !redirectUriAllowed(redirectUri)) {
    return { ok: false, fatal: true, message: "redirect_uri 與註冊時的不一致，已拒絕。" };
  }

  const state = p.get("state");
  const back = (error: string, description: string): AuthorizeCheck => ({
    ok: false,
    fatal: false,
    redirectUrl: redirectWith(redirectUri, {
      error,
      error_description: description,
      state,
      iss: base,
    }),
  });

  for (const k of [
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "state",
    "scope",
    "resource",
  ]) {
    if (dup(k)) return back("invalid_request", `duplicate parameter: ${k}`);
  }
  if (p.get("response_type") !== "code") {
    return back("unsupported_response_type", "only response_type=code is supported");
  }
  // 🔴 PKCE 必填，而且只收 S256。沒帶 method 不當成 plain（擋降級）。
  if (p.get("code_challenge_method") !== "S256") {
    return back("invalid_request", "code_challenge_method must be S256");
  }
  const cc = p.get("code_challenge") ?? "";
  if (!CHALLENGE_RE.test(cc)) return back("invalid_request", "invalid code_challenge");
  if (state !== null && state.length > 1024) return back("invalid_request", "state too long");

  const scopeParam = p.get("scope");
  if (scopeParam !== null && scopeParam.trim() !== "") {
    const asked = scopeParam.split(/\s+/).filter(Boolean);
    if (!asked.includes(OAUTH_SCOPE)) return back("invalid_scope", "only scope=mcp is available");
  }
  const resource = p.get("resource");
  if (!resourceMatches(resource, base)) {
    return back("invalid_target", "resource must be this MCP server");
  }

  return {
    ok: true,
    req: {
      client,
      redirectUri,
      redirectUriProvided,
      state,
      codeChallenge: cc,
      scope: OAUTH_SCOPE,
      resource: resourceFor(base),
    },
  };
}

/** 同意頁的 CSRF token：綁使用者、綁這一組授權參數、15 分鐘到期。 */
export function consentToken(
  userId: string,
  query: string,
  secret: string,
  now = nowSeconds(),
): string {
  const exp = now + CONSENT_TTL_SECONDS;
  const sig = b64url(
    hmac(deriveKeys(secret), "consent", `${userId}|${canonicalQuery(query)}|${exp}`),
  );
  return `${exp}.${sig}`;
}

export function verifyConsentToken(
  token: unknown,
  userId: string,
  query: string,
  secret: string,
  now = nowSeconds(),
): boolean {
  if (typeof token !== "string" || token.length > 200) return false;
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp <= now || !sig) return false;
  const want = b64url(
    hmac(deriveKeys(secret), "consent", `${userId}|${canonicalQuery(query)}|${exp}`),
  );
  return safeEqual(sig, want);
}

function canonicalQuery(query: string): string {
  const p = new URLSearchParams(query);
  const keys = [
    "client_id",
    "redirect_uri",
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "state",
    "scope",
    "resource",
  ];
  return keys.map((k) => `${k}=${p.get(k) ?? ""}`).join("&");
}

export function mintCode(
  req: AuthorizeRequest,
  userId: string,
  secret: string,
  now = nowSeconds(),
): string {
  const payload: CodePayload = {
    exp: now + CODE_TTL_SECONDS,
    jti: b64url(randomBytes(16)),
    sub: userId,
    cid: clientHash(req.client.client_id),
    ru: req.redirectUri,
    cc: req.codeChallenge,
    sc: req.scope,
    aud: req.resource,
    at0: now,
    rp: req.redirectUriProvided,
  };
  return seal("code", payload, secret);
}

/** 使用者按「允許」之後導回 client 的網址。 */
export function approvalRedirect(req: AuthorizeRequest, code: string, base: string): string {
  return redirectWith(req.redirectUri, { code, state: req.state, iss: base });
}

export function denialRedirect(req: AuthorizeRequest, base: string): string {
  return redirectWith(req.redirectUri, {
    error: "access_denied",
    error_description: "the administrator denied the request",
    state: req.state,
    iss: base,
  });
}

/* ------------------------------------------------------------------ token endpoint */

export type AdminCheck = (userId: string) => Promise<boolean>;

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

/* ------------------------------------------------------------------ 狀態（OAuthStore） */

/**
 * ok＝換好了；reused＝舊的那張又出現（撤銷整條鏈）；stale＝剛被換掉不到
 * REFRESH_REUSE_GRACE_SECONDS 的那一張又出現（網路重送或併發 refresh，只拒絕、不撤銷）；
 * revoked／missing＝鏈已撤銷、到期或不存在。
 */
export type RotateResult = "ok" | "reused" | "stale" | "revoked" | "missing";

/** 剛被輪替掉的 refresh 在這幾秒內再出現，視為客戶端重送而不是被偷（見 RotateResult）。 */
export const REFRESH_REUSE_GRACE_SECONDS = 30;

export type EpochInfo = {
  epoch: number;
  /** 上一次 epoch 被加一的時間（unix 秒）；沒加過＝0。比它早簽發的授權碼一律作廢。 */
  since: number;
};

export type NewGrant = {
  userId: string;
  clientHash: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  refreshJti: string;
  /** 整條鏈的封頂時間（unix 秒）＝ at0 + REFRESH_ABSOLUTE_MAX_SECONDS。 */
  expiresAt: number;
};

/**
 * 授權狀態的儲存介面。正式路徑是 oauth-store.ts（Supabase，service role）；自檢與沒有資料庫的
 * 情境用 createMemoryOAuthStore()。**所有方法查詢失敗一律丟例外**（fail closed：呼叫端回 500／
 * 503，絕不當成「沒用過」或「沒撤銷」）。
 */
export interface OAuthStore {
  /** 第一次看到這個 key → true（並記下來，到 exp 為止）；看過 → false。 */
  consumeOnce(key: string, exp: number): Promise<boolean>;
  /** 建一條授權鏈，回 id。 */
  createGrant(grant: NewGrant): Promise<string>;
  /**
   * refresh 輪替：鏈存在、屬於 userId 與 clientHash、沒撤銷、沒過封頂、而且 current jti 等於
   * oldJti → 換成 newJti（舊的記成 previous、記下輪替時間）、更新 last_used_at、回 ok。
   * jti 不符：等於 previous 而且輪替不到 REFRESH_REUSE_GRACE_SECONDS 秒 → stale；
   * 其餘 → reused（呼叫端撤銷整條鏈）。
   */
  rotateRefresh(
    gid: string,
    userId: string,
    clientHash: string,
    oldJti: string,
    newJti: string,
    now: number,
  ): Promise<RotateResult>;
  revokeGrant(gid: string, reason: "client" | "refresh_reuse" | "admin"): Promise<void>;
  /**
   * 撤銷「由某一條升級前的舊鏈搬進來」的授權鏈（以 user、client、封頂時間辨識——搬進來的鏈
   * expires_at 就是舊鏈的 at0 + 90 天）。只撤 createdBefore 之前建立的（寬限期內的重送不撤）。
   * 回傳撤了幾條。
   */
  revokeMigratedChain(
    userId: string,
    clientHash: string,
    expiresAt: number,
    createdBefore: number,
  ): Promise<number>;
  /**
   * 這位使用者目前的撤銷 epoch（沒有列＝0）。fresh：略過快取直接查（/oauth/token 用；
   * /api/mcp 的每次呼叫可以吃 ≤60 秒的快取）。
   */
  userEpoch(userId: string, opts?: { fresh?: boolean }): Promise<EpochInfo>;
  /**
   * access token 驗證用：這條鏈現在能不能用（存在、屬於 userId、沒撤銷、沒過封頂）。
   * 實作可以順手更新 last_used_at。
   */
  grantActive(gid: string, userId: string, now: number): Promise<boolean>;
}

type MemGrant = NewGrant & {
  id: string;
  current: string;
  previous: string | null;
  rotatedAt: number | null;
  createdAt: number;
  revokedAt: number | null;
};

/** 記憶體版（自檢、以及沒有資料庫時的語意參考）。每次呼叫回一個獨立的新 store。 */
export function createMemoryOAuthStore(): OAuthStore & {
  grants: Map<string, MemGrant>;
  epochs: Map<string, EpochInfo>;
} {
  const used = new Map<string, number>();
  const grants = new Map<string, MemGrant>();
  const epochs = new Map<string, EpochInfo>();
  return {
    grants,
    epochs,
    async consumeOnce(key, exp) {
      const now = nowSeconds();
      for (const [k, e] of used) if (e <= now) used.delete(k);
      if (used.has(key)) return false;
      used.set(key, exp);
      return true;
    },
    async createGrant(g) {
      const id = randomBytes(16)
        .toString("hex")
        .replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
      grants.set(id, {
        ...g,
        id,
        current: g.refreshJti,
        previous: null,
        rotatedAt: null,
        createdAt: nowSeconds(),
        revokedAt: null,
      });
      return id;
    },
    async rotateRefresh(gid, userId, ch, oldJti, newJti, now) {
      const g = grants.get(gid);
      if (!g || g.userId !== userId || g.clientHash !== ch) return "missing";
      if (g.revokedAt !== null || g.expiresAt <= now) return "revoked";
      if (g.current !== oldJti) {
        const fresh = g.rotatedAt !== null && now - g.rotatedAt < REFRESH_REUSE_GRACE_SECONDS;
        return g.previous === oldJti && fresh ? "stale" : "reused";
      }
      g.previous = oldJti;
      g.rotatedAt = now;
      g.current = newJti;
      return "ok";
    },
    async revokeGrant(gid) {
      const g = grants.get(gid);
      if (g && g.revokedAt === null) g.revokedAt = nowSeconds();
    },
    async revokeMigratedChain(userId, ch, expiresAt, createdBefore) {
      let n = 0;
      for (const g of grants.values()) {
        if (
          g.userId === userId &&
          g.clientHash === ch &&
          g.expiresAt === expiresAt &&
          g.revokedAt === null &&
          g.createdAt < createdBefore
        ) {
          g.revokedAt = nowSeconds();
          n += 1;
        }
      }
      return n;
    },
    async userEpoch(userId) {
      return epochs.get(userId) ?? { epoch: 0, since: 0 };
    },
    async grantActive(gid, userId, now) {
      const g = grants.get(gid);
      return !!g && g.userId === userId && g.revokedAt === null && g.expiresAt > now;
    },
  };
}

/**
 * 沒注入 store 時用的預設（只有自檢與舊的呼叫端會走到）。正式路徑（oauth.ts）一律注入
 * oauth-store.ts 的資料庫版。
 */
let defaultStore: OAuthStore = createMemoryOAuthStore();

/**
 * 同一個 instance 內先用記憶體擋一次重放（不必等資料庫），真正的判準是 store.consumeOnce。
 */
const usedCodes = new Map<string, number>();

function seenCodeLocally(jti: string, now: number): boolean {
  for (const [k, e] of usedCodes) if (e <= now) usedCodes.delete(k);
  return usedCodes.has(jti);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGrantId(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function issuePair(
  base: { sub: string; cid: string; sc: string; aud: string; at0: number; gid: string; ep: number },
  refreshJti: string,
  secret: string,
  now: number,
): TokenResponse {
  const access: AccessPayload = {
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    iat: now,
    sub: base.sub,
    cid: base.cid,
    sc: base.sc,
    aud: base.aud,
    gid: base.gid,
    ep: base.ep,
  };
  const refreshExp = Math.min(
    now + REFRESH_TOKEN_TTL_SECONDS,
    base.at0 + REFRESH_ABSOLUTE_MAX_SECONDS,
  );
  const refresh: RefreshPayload = {
    ...access,
    exp: refreshExp,
    at0: base.at0,
    jti: refreshJti,
  };
  return {
    access_token: seal("access", access, secret),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: seal("refresh", refresh, secret),
    scope: base.sc,
  };
}

const newRefreshJti = () => b64url(randomBytes(12));

/**
 * 升級前的舊鏈的身分。無狀態時代每次 refresh 都發新的、舊的不失效，但同一條鏈的每一張都帶
 * 同一個 at0——所以「燒掉」要以整條鏈為單位，不是單張 jti（審查 2026-10-28 #1：被輪替掉的
 * 舊 refresh 不能再開出第二條鏈）。
 */
export function legacyChainKey(sub: string, cid: string, at0: number): string {
  return `lrt:${b64url(createHash("sha256").update(`${sub}|${cid}|${at0}`).digest())}`;
}

/**
 * /oauth/token 的核心。丟 OAuthError；成功回 TokenResponse。isAdmin 由呼叫端注入（查
 * profiles），store 由呼叫端注入（資料庫），讓這支保持純函式、可以在自檢裡測。
 *
 * 順序是刻意的：先做所有不碰狀態的檢查（解密、client、audience、PKCE、封頂、角色），
 * 全部通過才動 store —— 拿錯 client 的 refresh 來試，不會被當成「重用」而把正牌的鏈撤掉。
 */
export async function exchangeToken(
  params: URLSearchParams,
  authorization: string | null,
  secret: string,
  baseUrl: string,
  isAdmin: AdminCheck,
  now = nowSeconds(),
  store: OAuthStore = defaultStore,
): Promise<TokenResponse> {
  const grant = params.get("grant_type");
  if (grant !== "authorization_code" && grant !== "refresh_token") {
    throw new OAuthError("unsupported_grant_type", "unsupported grant_type");
  }
  const client = authenticateClient(params, authorization, secret);
  const cid = clientHash(client.client_id);
  const aud = resourceFor(baseUrl);
  if (!resourceMatches(params.get("resource"), baseUrl)) {
    throw new OAuthError("invalid_target", "resource must be this MCP server");
  }

  if (grant === "authorization_code") {
    const code = unseal<CodePayload>("code", params.get("code"), secret, now);
    if (!code) throw new OAuthError("invalid_grant", "invalid or expired code");
    if (code.cid !== cid)
      throw new OAuthError("invalid_grant", "code was issued to another client");
    const ru = params.get("redirect_uri");
    if ((code.rp || ru !== null) && ru !== code.ru) {
      throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    }
    if (code.aud !== aud) throw new OAuthError("invalid_grant", "audience mismatch");
    if (!verifyPkce(params.get("code_verifier"), code.cc)) {
      throw new OAuthError("invalid_grant", "PKCE verification failed");
    }
    if (seenCodeLocally(code.jti, now)) throw new OAuthError("invalid_grant", "code already used");
    // 先查角色再燒掉這張碼：查詢暫時失敗（丟例外 → 500）時，同一張碼還可以重試。
    // 仍是 fail closed —— 查詢出錯就不會發 token。
    if (!(await isAdmin(code.sub))) {
      throw new OAuthError("invalid_grant", "the authorizing user is no longer an administrator");
    }
    // 🔴 跨 instance 的「只能用一次」。store 出錯 → 丟例外 → 500，這張碼沒被燒掉、可重試。
    if (!(await store.consumeOnce(code.jti, code.exp))) {
      usedCodes.set(code.jti, code.exp);
      throw new OAuthError("invalid_grant", "code already used");
    }
    usedCodes.set(code.jti, code.exp);
    const { epoch: ep, since } = await store.userEpoch(code.sub, { fresh: true });
    // 「全部撤銷」之前就簽出、還沒兌換的授權碼也作廢（審查 2026-10-28 #4）。
    if (code.at0 < since) {
      throw new OAuthError("invalid_grant", "authorization revoked, please reconnect");
    }
    const jti = newRefreshJti();
    const gid = await store.createGrant({
      userId: code.sub,
      clientHash: cid,
      clientName: client.client_name,
      redirectUri: code.ru,
      scope: code.sc,
      refreshJti: jti,
      expiresAt: code.at0 + REFRESH_ABSOLUTE_MAX_SECONDS,
    });
    return issuePair(
      { sub: code.sub, cid, sc: code.sc, aud, at0: code.at0, gid, ep },
      jti,
      secret,
      now,
    );
  }

  const rt = unseal<RefreshPayload>("refresh", params.get("refresh_token"), secret, now);
  if (!rt) throw new OAuthError("invalid_grant", "invalid or expired refresh_token");
  if (rt.cid !== cid)
    throw new OAuthError("invalid_grant", "refresh_token was issued to another client");
  if (rt.aud !== aud) throw new OAuthError("invalid_grant", "audience mismatch");
  if (rt.at0 + REFRESH_ABSOLUTE_MAX_SECONDS <= now) {
    throw new OAuthError("invalid_grant", "authorization expired, please reconnect");
  }
  if (typeof rt.jti !== "string" || rt.jti.length < 8) {
    throw new OAuthError("invalid_grant", "invalid refresh_token");
  }
  if (!(await isAdmin(rt.sub))) {
    throw new OAuthError("invalid_grant", "the authorizing user is no longer an administrator");
  }
  const { epoch: ep } = await store.userEpoch(rt.sub, { fresh: true });
  if ((rt.ep ?? 0) !== ep) {
    throw new OAuthError("invalid_grant", "authorization revoked, please reconnect");
  }
  const jti = newRefreshJti();

  if (rt.gid !== undefined) {
    if (!isGrantId(rt.gid)) throw new OAuthError("invalid_grant", "invalid refresh_token");
    const r = await store.rotateRefresh(rt.gid, rt.sub, cid, rt.jti, jti, now);
    if (r === "reused") {
      // 🔴 已經被換掉的那張又出現了：不管是攻擊者還是正牌客戶端，整條鏈都不能再信任。
      await store.revokeGrant(rt.gid, "refresh_reuse");
      throw new OAuthError("invalid_grant", "refresh_token reuse detected; authorization revoked");
    }
    if (r === "stale") {
      // 剛換掉的那張在寬限期內又出現：多半是回應在網路上遺失後的重送，或併發 refresh。
      // 拒絕但不撤銷——拿到新那張的那一邊照常可用。
      throw new OAuthError("invalid_grant", "refresh_token was just rotated");
    }
    if (r !== "ok")
      throw new OAuthError("invalid_grant", "authorization revoked, please reconnect");
    return issuePair(
      { sub: rt.sub, cid, sc: rt.sc, aud, at0: rt.at0, gid: rt.gid, ep },
      jti,
      secret,
      now,
    );
  }

  // 升級前簽發、沒有授權鏈的舊 refresh token（見檔頭）：**每一條舊鏈**只能搬一次，用的當下
  // 搬進一條新鏈。同一條舊鏈的任何一張（含早就被輪替掉的）再出現＝重用 → 撤銷搬進來的那條鏈
  // （寬限期內的重送除外）。
  const chainExp = rt.at0 + REFRESH_ABSOLUTE_MAX_SECONDS;
  if (!(await store.consumeOnce(legacyChainKey(rt.sub, cid, rt.at0), chainExp))) {
    const n = await store.revokeMigratedChain(
      rt.sub,
      cid,
      chainExp,
      now - REFRESH_REUSE_GRACE_SECONDS,
    );
    throw new OAuthError(
      "invalid_grant",
      n > 0 ? "refresh_token reuse detected; authorization revoked" : "refresh_token already used",
    );
  }
  const gid = await store.createGrant({
    userId: rt.sub,
    clientHash: cid,
    clientName: client.client_name,
    redirectUri: client.redirect_uris[0] ?? "",
    scope: rt.sc,
    refreshJti: jti,
    expiresAt: rt.at0 + REFRESH_ABSOLUTE_MAX_SECONDS,
  });
  return issuePair({ sub: rt.sub, cid, sc: rt.sc, aud, at0: rt.at0, gid, ep }, jti, secret, now);
}

/**
 * /oauth/revoke 的核心（RFC 7009）。token 解不開、不是這個 client 的 → 什麼都不做（呼叫端
 * 一律回 200）。有授權鏈 → 撤銷整條鏈；升級前的舊 refresh → 燒掉它（之後不能再 refresh）。
 */
export async function revokeToken(
  token: unknown,
  clientId: string,
  secret: string,
  store: OAuthStore = defaultStore,
  now = nowSeconds(),
): Promise<"revoked" | "burned" | "ignored"> {
  const cid = clientHash(clientId);
  const rt = unseal<RefreshPayload>("refresh", token, secret, now);
  const at = rt ? null : unseal<AccessPayload>("access", token, secret, now);
  const p = rt ?? at;
  if (!p || p.cid !== cid) return "ignored";
  if (p.gid !== undefined) {
    if (!isGrantId(p.gid)) return "ignored";
    await store.revokeGrant(p.gid, "client");
    return "revoked";
  }
  if (rt && typeof rt.at0 === "number") {
    // 舊鏈：燒掉整條（之後不能再搬），已經搬進來的那條也一起撤銷。
    const chainExp = rt.at0 + REFRESH_ABSOLUTE_MAX_SECONDS;
    await store.consumeOnce(legacyChainKey(rt.sub, cid, rt.at0), chainExp);
    await store.revokeMigratedChain(rt.sub, cid, chainExp, now + 1);
    return "burned";
  }
  return "ignored";
}

/**
 * access token 通過密碼學驗證之後的狀態檢查：鏈沒被撤銷、epoch 沒被加過。升級前簽發、
 * 沒有 gid 的 token 只檢查 epoch（見檔頭）。store 出錯 → 丟例外（呼叫端回 503）。
 */
export async function accessTokenActive(
  at: AccessPayload,
  store: OAuthStore,
  now = nowSeconds(),
): Promise<boolean> {
  const { epoch: ep } = await store.userEpoch(at.sub);
  if ((at.ep ?? 0) !== ep) return false;
  if (at.gid === undefined) return true;
  if (!isGrantId(at.gid)) return false;
  return await store.grantActive(at.gid, at.sub, now);
}

/** /api/mcp 的 access token 驗證。成功回 payload；失敗回 null。 */
export function verifyAccessToken(
  token: string,
  secret: string,
  baseUrl: string,
  now = nowSeconds(),
): AccessPayload | null {
  const at = unseal<AccessPayload>("access", token, secret, now);
  if (!at) return null;
  if (at.aud !== resourceFor(baseUrl)) return null;
  if (at.sc !== OAUTH_SCOPE) return null;
  if (typeof at.sub !== "string" || !at.sub) return null;
  return at;
}

/* ------------------------------------------------------------------ 限流 */

const buckets = new Map<string, { n: number; reset: number }>();

/**
 * 固定視窗限流（記憶體內、每個 instance 各自）。true＝放行。
 */
export function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  now = Date.now(),
): boolean {
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || b.reset <= now) {
    buckets.set(key, { n: 1, reset: now + windowSeconds * 1000 });
    return true;
  }
  b.n += 1;
  return b.n <= limit;
}

export function clientIp(headers: Headers): string {
  const pick = (v: string | null) => (v ?? "").split(",")[0]?.trim() ?? "";
  const ip =
    pick(headers.get("x-vercel-forwarded-for")) ||
    pick(headers.get("x-real-ip")) ||
    pick(headers.get("x-forwarded-for"));
  return ip && ip.length <= 64 ? ip : "unknown";
}

export const __TEST_ONLY__ = {
  resetRateLimits: () => buckets.clear(),
  resetUsedCodes: () => {
    usedCodes.clear();
    defaultStore = createMemoryOAuthStore();
  },
  /** 只清本 instance 的記憶體（模擬「換了一個 serverless instance」），store 保留。 */
  resetLocalUsedCodes: () => usedCodes.clear(),
  /** 讓自檢拿到預設 store 的那一份（看 grants、epochs）。 */
  defaultStore: () => defaultStore,
};
