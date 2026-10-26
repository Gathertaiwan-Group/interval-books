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
 * ── 為什麼是無狀態的 ─────────────────────────────────────────────────────────
 * 目前沒有 DDL 權限，而既有的表裡沒有可以放任意 key 的設定表（site_settings 是固定欄位
 * 的單列表、ui_strings 是前台公開讀的文案）。所以：
 *   · client_id   ＝ HMAC 簽章的註冊內容（名稱、redirect_uris、驗證方式）。
 *   · client_secret（只有選了 client_secret_post/basic 的客戶端才有）＝ HMAC(client_id)。
 *   · 授權碼／access token／refresh token ＝ AES-256-GCM 加密＋驗證的 blob，內含到期時間。
 *   · 全部的金鑰從 MCP_OAUTH_SECRET 用 HKDF 衍生。**換掉這個環境變數＝全部作廢**
 *     （所有 client、碼、token 一次失效），那就是總開關。
 * 已知限制（寫在這裡，也寫在交接報告）：
 *   · 授權碼的「只能用一次」只在同一個 serverless instance 內成立（記憶體裡的 jti 表）；
 *     跨 instance 重放靠的是 5 分鐘 TTL＋PKCE verifier＋redirect_uri＋client 綁定。
 *   · refresh token 會輪替，但舊的那張在到期前密碼學上仍然有效（沒有地方記「已用過」）。
 *     用絕對壽命（REFRESH_ABSOLUTE_MAX_SECONDS）把整個授權鏈封頂。
 *   · /oauth/revoke 只能回 200（RFC 7009 規定對未知 token 也回 200），實際上撤不掉。
 *     要撤銷單一個人：把他的 profiles.role 改掉（每一次 MCP 呼叫都重查）；要全撤：換
 *     MCP_OAUTH_SECRET。
 *   · 限流是記憶體內、每個 instance 各自計算的，是減速帶不是牆。
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

/**
 * 記憶體內「這張授權碼用過了」。只在同一個 instance 內有效，見檔頭的已知限制。
 */
const usedCodes = new Map<string, number>();

function markCodeUsed(jti: string, exp: number, now: number): boolean {
  for (const [k, e] of usedCodes) if (e <= now) usedCodes.delete(k);
  if (usedCodes.has(jti)) return false;
  usedCodes.set(jti, exp);
  return true;
}

function issuePair(
  base: { sub: string; cid: string; sc: string; aud: string; at0: number },
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
  };
  const refreshExp = Math.min(
    now + REFRESH_TOKEN_TTL_SECONDS,
    base.at0 + REFRESH_ABSOLUTE_MAX_SECONDS,
  );
  const refresh: RefreshPayload = {
    ...access,
    exp: refreshExp,
    at0: base.at0,
    jti: b64url(randomBytes(12)),
  };
  return {
    access_token: seal("access", access, secret),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: seal("refresh", refresh, secret),
    scope: base.sc,
  };
}

/**
 * /oauth/token 的核心。丟 OAuthError；成功回 TokenResponse。isAdmin 由呼叫端注入（查
 * profiles），讓這支保持純函式、可以在自檢裡測角色閘門。
 */
export async function exchangeToken(
  params: URLSearchParams,
  authorization: string | null,
  secret: string,
  baseUrl: string,
  isAdmin: AdminCheck,
  now = nowSeconds(),
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
    // 先查角色再燒掉這張碼：查詢暫時失敗（丟例外 → 500）時，同一張碼還可以重試。
    // 仍是 fail closed —— 查詢出錯就不會發 token。
    if (!(await isAdmin(code.sub))) {
      throw new OAuthError("invalid_grant", "the authorizing user is no longer an administrator");
    }
    if (!markCodeUsed(code.jti, code.exp, now)) {
      throw new OAuthError("invalid_grant", "code already used");
    }
    return issuePair({ sub: code.sub, cid, sc: code.sc, aud, at0: code.at0 }, secret, now);
  }

  const rt = unseal<RefreshPayload>("refresh", params.get("refresh_token"), secret, now);
  if (!rt) throw new OAuthError("invalid_grant", "invalid or expired refresh_token");
  if (rt.cid !== cid)
    throw new OAuthError("invalid_grant", "refresh_token was issued to another client");
  if (rt.aud !== aud) throw new OAuthError("invalid_grant", "audience mismatch");
  if (rt.at0 + REFRESH_ABSOLUTE_MAX_SECONDS <= now) {
    throw new OAuthError("invalid_grant", "authorization expired, please reconnect");
  }
  if (!(await isAdmin(rt.sub))) {
    throw new OAuthError("invalid_grant", "the authorizing user is no longer an administrator");
  }
  return issuePair({ sub: rt.sub, cid, sc: rt.sc, aud, at0: rt.at0 }, secret, now);
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
  resetUsedCodes: () => usedCodes.clear(),
};
