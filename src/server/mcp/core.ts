/**
 * MCP server 的純函式核心 —— 驗證閘門、輸出截斷、差異、三語補齊、圖片尺寸、內網判斷。
 *
 * 這個檔案**只用相對路徑與 node 內建模組**，不 import `@/…`、不碰 Supabase：
 * scripts/mcp-selftest.mjs 直接 import 它本人來測，驗到的是 production 真的在跑
 * 的那幾行，不是一份長得很像的複本。
 *
 * 🔴 從快樂手那一支（happyhand/apps/web/app/api/mcp/route.ts）搬過來、不能改的規矩：
 *   · 靜態 bearer token，自己用 timingSafeEqual 比對。**不用 mcp-handler 的 withMcpAuth**
 *     （它的 OAuth challenge 指向一個 mcp-handler 自己不提供的 authorization server）。
 *   · 2026-10-26 起多了一條路：OAuth access token（oauth-core.ts）。**只有設了
 *     MCP_OAUTH_SECRET 時**，`/.well-known/oauth-*` 才回 metadata、401 才帶
 *     resource_metadata；沒設就與之前一模一樣（discovery 404、401 只帶裸 `Bearer`）。
 *     ⚠️ 代價：有回報 Cursor 看到 OAuth discovery 會忽略設定的 header 硬走 OAuth。
 *     Claude Code 帶對 header 就不會收到 401，所以不受影響。
 *   · 兩個都沒設 ＝整支關閉（回 404，跟這條路徑不存在長得一樣），不是「沒設就放行」。
 *   · Origin 自己檢查（規範 MUST，createMcpHandler 不做）。沒帶 Origin 是正常的。
 *   · 輸出超過 200k 字就截斷並明講 —— Vercel 4.5MB 上限連回應方向也算。
 */
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  bearerChallenge,
  oauthBaseUrl,
  oauthEnabled,
  TOKEN_PREFIX,
  verifyAccessToken,
  type AccessPayload,
} from "./oauth-core";

export const MCP_PATH = "/api/mcp";

/** 單一工具回應的字數上限。遠低於 Vercel 的 4.5 MB。 */
export const MAX_TEXT = 200_000;

export const TRUNCATION_NOTE = `⚠️ 輸出超過 ${MAX_TEXT} 字已截斷，上面不是完整結果。請縮小查詢範圍（例如改用 get_* 查單筆）再試一次。`;

/* ------------------------------------------------------------------ 驗證閘門 */

/**
 * 固定時間比較。=== 會隨前綴相符的長度而有時間差，理論上能一個字元一個字元試出來。
 * 長度不同直接 false（timingSafeEqual 對不同長度會丟例外）。
 */
export function tokenMatches(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 正式站、claude.ai 連接器。本機（MCP Inspector）另外用正規式放行。 */
export const ALLOWED_ORIGINS = [
  "https://www.intervalbooks.tw",
  "https://intervalbooks.tw",
  "https://claude.ai",
];

/**
 * 大部分 MCP 客戶端是伺服器對伺服器、不送 Origin，所以「沒帶」是正常的。
 * 帶了就必須在清單內 —— 擋的是 DNS rebinding 與瀏覽器端的跨站呼叫。
 */
export function originAllowed(origin: string | null): boolean {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * OAuth／OIDC discovery 的路徑。src/server.ts 一律攔下交給 oauth.ts#handleOAuthDiscovery：
 * 設了 MCP_OAUTH_SECRET 才回 metadata，否則 404；openid-configuration 永遠 404（不是 OIDC）。
 */
export function isOAuthDiscoveryPath(pathname: string): boolean {
  return (
    pathname.startsWith("/.well-known/oauth-") ||
    pathname.startsWith("/.well-known/openid-configuration") ||
    // RFC 9728 的「路徑插入」形式：/.well-known/oauth-protected-resource/api/mcp
    pathname === `${MCP_PATH}/.well-known/oauth-protected-resource`
  );
}

function plain(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

export function notFoundResponse(): Response {
  return plain(404, "Not Found");
}

/**
 * 請求進 MCP handler 之前的閘門（只看靜態 token 的舊介面；自檢與沒開 OAuth 時用）。
 * 回 null ＝放行；否則回一個要直接送出去的 Response。
 *
 * 順序是刻意的：
 *   1. 沒設 token → 404。**在看任何請求內容之前**就關掉，讓「功能沒開」跟「這條路徑
 *      不存在」從外面看不出差別。
 *   2. Origin 不在清單 → 403。
 *   3. token 不對 → 401，只有裸的 `Bearer`，不帶 resource_metadata。
 */
export function gateMcpRequest(req: Request, expectedToken: string | undefined): Response | null {
  const r = authenticateMcpRequest(req, expectedToken, undefined);
  return r.kind === "deny" ? r.response : null;
}

export type McpAuth =
  | { kind: "static" }
  | { kind: "oauth"; token: AccessPayload }
  | { kind: "deny"; response: Response };

function staticTokenUsable(t: string | undefined): t is string {
  return typeof t === "string" && t.trim().length >= 32;
}

/**
 * 完整的閘門：靜態 MCP_TOKEN **或** OAuth access token。
 *
 *   1. 兩個都沒設 → 404。
 *   2. Origin 不在清單 → 403。
 *   3. 先比靜態 token（固定時間）；不符且看起來是 OAuth token（ibat1. 開頭）才解密驗證
 *      （到期、audience＝這支 /api/mcp、scope）。
 *   4. 都不對 → 401。開了 OAuth 時 WWW-Authenticate 帶 resource_metadata（RFC 9728），
 *      claude.ai 靠它找到 authorization server；沒開就是裸的 `Bearer`。
 *
 * ⚠️ OAuth token 通過這裡**還不夠**：http.ts 會再查一次 profiles，確定那個人現在還是 admin。
 *    這個檔案不碰資料庫，所以那一步不在這裡。
 */
export function authenticateMcpRequest(
  req: Request,
  staticToken: string | undefined,
  oauthSecret: string | undefined,
  now?: number,
): McpAuth {
  const staticOn = staticTokenUsable(staticToken);
  const oauthOn = oauthEnabled(oauthSecret);
  if (!staticOn && !oauthOn) return { kind: "deny", response: notFoundResponse() };

  if (!originAllowed(req.headers.get("origin"))) {
    return { kind: "deny", response: plain(403, "forbidden_origin") };
  }

  const base = oauthBaseUrl(req.url);
  const challenge = (invalid: boolean) =>
    oauthOn
      ? bearerChallenge(
          base,
          invalid ? "invalid_token" : undefined,
          invalid ? "token is invalid or expired" : undefined,
        )
      : "Bearer";

  const header = req.headers.get("authorization") ?? "";
  const got = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!got) {
    return {
      kind: "deny",
      response: plain(401, "unauthorized", { "www-authenticate": challenge(false) }),
    };
  }
  if (staticOn && tokenMatches(got, staticToken.trim())) return { kind: "static" };
  if (oauthOn && got.startsWith(TOKEN_PREFIX.access)) {
    const token = verifyAccessToken(got, oauthSecret, base, now);
    if (token) return { kind: "oauth", token };
  }
  return {
    kind: "deny",
    response: plain(401, "unauthorized", { "www-authenticate": challenge(true) }),
  };
}

export function unauthorizedOAuthResponse(req: Request): Response {
  return plain(401, "unauthorized", {
    "www-authenticate": bearerChallenge(
      oauthBaseUrl(req.url),
      "invalid_token",
      "authorization revoked",
    ),
  });
}

/* ------------------------------------------------------------------ 輸出 */

export type TextResult = { content: [{ type: "text"; text: string }]; isError?: boolean };

/**
 * 把結果轉成給模型看的文字。超長就截斷並**講出來** —— 靜默截斷會讓模型以為自己看到
 * 了全部。
 */
export function jsonText(value: unknown): TextResult {
  let text = JSON.stringify(value, null, 2) ?? "null";
  if (text.length > MAX_TEXT) {
    text = `${text.slice(0, MAX_TEXT)}\n\n${TRUNCATION_NOTE}`;
  }
  return { content: [{ type: "text" as const, text }] };
}

/** 工具自己的錯誤回在 result 裡（isError），模型才看得到內容、才能自己修正。 */
export function errText(message: string): TextResult {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** 呼叫端（模型）可以修正的輸入錯誤。訊息原樣給模型看。 */
export class McpInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpInputError";
  }
}

/* ------------------------------------------------------------------ 差異 */

/** 穩定序列化：物件的 key 排序後再比，{zh,en,ja} 與 {en,zh,ja} 算相同。 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export type FieldChange = { before: unknown; after: unknown };

/**
 * 只列出真的有變的欄位。`before` 為 null（新建）時每一個欄位都算變更，before 記成 null。
 */
export function diffFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  fields: readonly string[],
): Record<string, FieldChange> {
  const out: Record<string, FieldChange> = {};
  for (const f of fields) {
    const b = before ? (before[f] ?? null) : null;
    const a = after[f] ?? null;
    if (before === null || stableStringify(b) !== stableStringify(a)) {
      out[f] = { before: b, after: a };
    }
  }
  return out;
}

/** 取出指定欄位（不存在的 key 不會被補成 undefined）。 */
export function pickFields<T extends Record<string, unknown>>(
  row: T,
  fields: readonly string[],
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in row) out[f] = row[f];
  return out as Partial<T>;
}

/** 從 zod（3 或 4）的錯誤收出一句人話。不認得就回 null。 */
export function zodIssuesText(err: unknown): string | null {
  const issues = (err as { issues?: { path?: (string | number)[]; message?: string }[] })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  return issues
    .slice(0, 20)
    .map((i) => `${(i.path ?? []).join(".") || "(root)"}：${i.message ?? "格式不正確"}`)
    .join("；");
}

/* ------------------------------------------------------------------ 三語補齊 */

export type Localized = { zh: string; en: string; ja: string };

/** 工具接受的三語輸入：一段中文字串，或 {zh, en?, ja?}。 */
export type LocalizedArg = string | { zh: string; en?: string | null; ja?: string | null };

export type Translator = (zh: string) => Promise<{ en: string; ja: string }>;

/** 與 src/server/translate.ts 的 MAX_INPUT_CHARS 同一個數字（自檢會對帳）。 */
export const TRANSLATE_MAX_CHARS = 2000;

/** 正式站沒設翻譯金鑰時給模型看的那一句。 */
export const NO_TRANSLATION_KEY =
  '這個站目前沒有設定自動翻譯（GEMINI_API_KEY），無法自動補英日文。請在同一個欄位直接提供 en 與 ja，例如 {"zh":"…","en":"…","ja":"…"}。';

/**
 * 把工具收到的三語輸入補成完整的 {zh,en,ja}。
 *
 * 規則：
 *   · zh 必填、trim 後不可為空（資料庫的 is_localized() 只看 key 在不在，空字串會過，
 *     然後前台渲染一塊空白 —— 所以在這一層就擋）。
 *   · en、ja 都有給（非空）→ 原樣使用，不呼叫翻譯。
 *   · 缺任何一個 → 呼叫 translate(zh)，**只補缺的那一個**，有給的那個不覆寫。
 *   · translate 為 null（沒有金鑰）→ 丟 McpInputError(NO_TRANSLATION_KEY)。
 */
export async function fillLocalized(
  field: string,
  arg: LocalizedArg,
  translate: Translator | null,
): Promise<{ value: Localized; translated: boolean }> {
  const obj = typeof arg === "string" ? { zh: arg } : arg;
  const zh = (obj.zh ?? "").trim();
  if (!zh) throw new McpInputError(`${field}：中文（zh）不可為空`);
  const en = (obj.en ?? "").trim();
  const ja = (obj.ja ?? "").trim();
  if (en && ja) return { value: { zh, en, ja }, translated: false };

  if (!translate) throw new McpInputError(`${field}：${NO_TRANSLATION_KEY}`);
  if (zh.length > TRANSLATE_MAX_CHARS) {
    // translate.ts 會把超過的部分切掉再翻 —— 在後台那是按鈕旁的提示，在這裡就是一份
    // 只翻了前半段的英日文被安靜地寫進資料庫。所以長文一律要呼叫端自己給。
    throw new McpInputError(
      `${field}：中文有 ${zh.length} 字，超過自動翻譯上限 ${TRANSLATE_MAX_CHARS} 字。請直接提供 en 與 ja。`,
    );
  }
  let t: { en: string; ja: string };
  try {
    t = await translate(zh);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new McpInputError(`${field}：自動翻譯失敗（${msg}）。請直接提供 en 與 ja。`);
  }
  const fillEn = en || (t.en ?? "").trim();
  const fillJa = ja || (t.ja ?? "").trim();
  if (!fillEn || !fillJa) {
    throw new McpInputError(`${field}：自動翻譯沒有回傳完整的英日文，請直接提供 en 與 ja。`);
  }
  return { value: { zh, en: fillEn, ja: fillJa }, translated: true };
}

/* ------------------------------------------------------------------ 圖片 */

export type ImageInfo = { format: "png" | "jpeg" | "webp"; width: number; height: number };

/**
 * 從檔頭讀出格式與尺寸（PNG IHDR、JPEG SOFn、WebP VP8/VP8L/VP8X）。讀不出來回 null。
 * 這不是安全邊界 —— storage.ts 的 magic bytes 嗅探才是；這裡只是為了回報尺寸。
 */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const u8 = bytes;
  const be16 = (o: number) => (u8[o] << 8) | u8[o + 1];
  const be32 = (o: number) =>
    ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const le16 = (o: number) => u8[o] | (u8[o + 1] << 8);
  const le24 = (o: number) => u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16);

  // PNG
  if (u8.length >= 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    return { format: "png", width: be32(16), height: be32(20) };
  }
  // JPEG：走 marker 找 SOF0..SOF15（排除 DHT C4、JPG C8、DAC CC）
  if (u8.length >= 4 && u8[0] === 0xff && u8[1] === 0xd8) {
    let o = 2;
    while (o + 9 < u8.length) {
      if (u8[o] !== 0xff) {
        o += 1;
        continue;
      }
      const marker = u8[o + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = be16(o + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { format: "jpeg", width: be16(o + 7), height: be16(o + 5) };
      }
      if (len < 2) return null;
      o += 2 + len;
    }
    return null;
  }
  // WebP
  if (
    u8.length >= 30 &&
    u8[0] === 0x52 &&
    u8[1] === 0x49 &&
    u8[2] === 0x46 &&
    u8[3] === 0x46 &&
    u8[8] === 0x57 &&
    u8[9] === 0x45 &&
    u8[10] === 0x42 &&
    u8[11] === 0x50
  ) {
    const chunk = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
    if (chunk === "VP8X") return { format: "webp", width: le24(24) + 1, height: le24(27) + 1 };
    if (chunk === "VP8L") {
      const b0 = u8[21],
        b1 = u8[22],
        b2 = u8[23],
        b3 = u8[24];
      return {
        format: "webp",
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (chunk === "VP8 ")
      return { format: "webp", width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    return null;
  }
  return null;
}

/**
 * 這個位址是不是內網／本機／保留位址。用來擋 SSRF：從網址抓圖時，主機名解析出來的
 * **每一個** 位址都必須是公開位址。
 */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPrivateV4(address.split(".").map(Number));
  if (kind === 6) {
    const b = parseIPv6(address);
    if (!b) return true; // 解析不了＝不放行
    return isPrivateV6(b);
  }
  return true; // 不是 IP 就不是「可以直接連的公開位址」
}

function isPrivateV4(p: number[]): boolean {
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / 雲端 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && p[2] === 100) return true;
  if (a === 203 && b === 0 && p[2] === 113) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * IPv6 → 16 個 byte。支援 `::` 縮寫與結尾的點分 IPv4（`::ffff:127.0.0.1`）。
 * 去掉 zone id（`fe80::1%en0`）。格式不對回 null。
 */
export function parseIPv6(address: string): number[] | null {
  let s = address.toLowerCase().replace(/^\[|\]$/g, "");
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  let tail: number[] = [];
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const q = v4[2].split(".").map(Number);
    if (q.some((n) => !Number.isInteger(n) || n > 255)) return null;
    tail = [(q[0] << 8) | q[1], (q[2] << 8) | q[3]];
    s = v4[1].endsWith("::") ? v4[1] : v4[1].slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toHextets = (part: string) =>
    part === ""
      ? []
      : part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  const head = toHextets(halves[0]);
  const rest = halves.length === 2 ? toHextets(halves[1]) : [];
  const total = head.length + rest.length + tail.length;
  let hextets: number[];
  if (halves.length === 2) {
    if (total > 7) return null;
    hextets = [...head, ...new Array(8 - total).fill(0), ...rest, ...tail];
  } else {
    if (total !== 8) return null;
    hextets = [...head, ...tail];
  }
  if (hextets.some((h) => Number.isNaN(h))) return null;
  const bytes: number[] = [];
  for (const h of hextets) bytes.push(h >> 8, h & 0xff);
  return bytes;
}

function isPrivateV6(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const v4At = (i: number) => isPrivateV4(b.slice(i, i + 4));
  // ::/128、::1/128、以及整個 ::/96（IPv4-compatible，已廢止）—— 看裡面包的 IPv4
  if (zero(0, 12)) return true;
  // ::ffff:0:0/96 IPv4-mapped、::ffff:0:0:0/96 IPv4-translated —— 一律看裡面的 IPv4
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4At(12);
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) return v4At(12);
  // 64:ff9b::/96 NAT64：看裡面的 IPv4；64:ff9b:1::/48 local-use NAT64 一律擋
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(4, 12)) return v4At(12);
    return true;
  }
  // 2002::/16 6to4：第 2–5 byte 是 IPv4
  if (b[0] === 0x20 && b[1] === 0x02) return v4At(2);
  // 2001:0::/32 Teredo（IPv4 被混淆過，不值得解）—— 一律擋
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;
  // 2001:db8::/32 文件用
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  // 100::/64 discard
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return true;
  if ((b[0] & 0xfe) === 0xfc) return true; // ULA fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // site-local fec0::/10（已廢止）
  if (b[0] === 0xff) return true; // multicast
  return false;
}

/* ------------------------------------------------------------------ 圖片 key */

/** 與 src/server/storage.ts 的 SITE_IMAGES_BUCKET 同一個字（自檢會對帳）。 */
export const SITE_IMAGES_BUCKET_NAME = "site-images";

const STORAGE_KEY_RE = /^storage:[0-9a-f-]{36}\.(webp|jpg|png)$/;
const PUBLIC_URL_RE = new RegExp(
  `/storage/v1/object/public/${SITE_IMAGES_BUCKET_NAME}/([0-9a-f-]{36}\\.(?:webp|jpg|png))$`,
);

/**
 * 工具收到的圖片參數 → 要寫進 image_key 的值。
 *
 *   · null／空字串 → null（清掉這張圖）
 *   · `storage:<uuid>.<ext>`（upload_image_from_url 回的 key）→ 原樣
 *   · 這個站 site-images bucket 的公開網址 → 換回 `storage:<name>`
 *   · `allowed` 裡的值（這一列原本的 key，例如打包進前台的舊檔名）→ 原樣
 *   · 其他一律拒絕 —— 外部網址不能直接塞進 image_key（imageFor() 不認得它），要先用
 *     upload_image_from_url 存進來。
 */
export function imageKeyFromArg(
  value: string | null | undefined,
  allowed: (string | null)[] = [],
): string | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (!v) return null;
  if (STORAGE_KEY_RE.test(v)) return v;
  const m = v.match(PUBLIC_URL_RE);
  if (m) return `storage:${m[1]}`;
  if (allowed.includes(v)) return v;
  throw new McpInputError(
    "圖片要先用 upload_image_from_url 存進網站，再把它回傳的 key（storage:… 開頭）填進來。",
  );
}

/** 主機名本身就明顯是內部的（不必解析 DNS 就能擋）。 */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (isIP(h)) return isPrivateAddress(h);
  return false;
}

/* ------------------------------------------------------------------ 商品 */

/** MCP 改商品時允許寫入的欄位。庫存、代稱、類型、來源一個都不在裡面。 */
export const PRODUCT_CONTENT_KEYS = [
  "title",
  "summary",
  "description",
  "image_key",
  "price",
  "compare_at_price",
  "status",
] as const;

/** 從驗證過的整列值裡只挑出 PRODUCT_CONTENT_KEYS（自檢斷言沒有 stock）。 */
export function productContentPatch(valid: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PRODUCT_CONTENT_KEYS) {
    out[k] = k === "image_key" || k === "compare_at_price" ? (valid[k] ?? null) : valid[k];
  }
  return out;
}
