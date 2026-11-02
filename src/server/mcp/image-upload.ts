/**
 * MCP 直接上傳圖片 —— 不必先把圖推進 repo、部署換一個公開網址。
 *
 * 三條入口，最後**全部**走同一個出口 storeSiteImageBytes() → src/server/storage.ts#
 * uploadSiteImage()（後台上傳同一支：magic bytes 嗅探、2MB、物件名 randomUUID）：
 *
 *   · upload_image_base64        —— 網頁版 Claude 等只能把圖轉成 base64 放進參數的 AI
 *   · upload_image_file          —— ChatGPT（Apps SDK 的 `openai/fileParams`）把對話裡的
 *                                   圖片以 {download_url, file_id, …} 交進來，伺服器自己抓
 *   · create_image_upload_url    —— 能跑 curl 的 AI（Claude Code、Codex）：拿一張 signed
 *     + finalize_image_upload       upload URL 直傳，再呼叫 finalize 由伺服器驗過才入庫
 *
 * ── 為什麼 signed URL 要多一步 finalize，而且先傳進「私有暫存 bucket」────────
 * Supabase 的 signed upload token 只綁「bucket＋路徑」：沒有大小、沒有內容型別、效期在
 * hosted 版固定約 2 小時、自己不能調短（storage-js 的 createSignedUploadUrl 只收 upsert）。
 * bucket 層級的 file_size_limit／allowed_mime_types 會生效，但 allowed_mime_types 只看
 * 呼叫端自己報的 Content-Type header —— 報 image/png、內容塞 HTML 照樣進得去。
 * 若直接發 site-images（公開讀）的 signed URL，那段「傳上去 → 被驗之前」的時間裡，一個
 * 沒驗過的檔案已經有公開網址了。所以：
 *   1. signed URL 指向**私有**的 mcp-image-uploads（0053，2MB、只收三種 MIME），路徑由
 *      伺服器產生 `<簽發秒數>-<uuid>.<ext>`，呼叫端一個字都不能指定；token 綁死這個路徑、
 *      不開 upsert，所以同一張 URL 傳一次之後就不能再覆寫。
 *   2. finalize 由伺服器把它讀回來 → 走跟 base64 同一條驗證（magic bytes、尺寸可解析、
 *      ≤2MB、與宣告格式一致）→ uploadSiteImage() 存進 site-images（新的 uuid）→ 刪掉暫存檔。
 *      不合格一樣刪掉暫存檔並回錯。
 *   3. 「短效」由 finalize 執行：簽發超過 UPLOAD_WINDOW_SECONDS（10 分鐘）的暫存檔，
 *      finalize 只會刪掉、不會入庫。即使 Supabase 那端 token 還沒過期，傳上去也沒有用。
 *   最終 key 在 finalize 才發（`storage:<uuid>.<ext>`，副檔名由實際內容決定），沒驗過的
 *   檔案永遠不會出現在公開 bucket。
 *
 * ── 不做的事 ──────────────────────────────────────────────────────────────
 *   · 不收 SVG／HTML／AVIF／GIF：uploadSiteImage() 與 image_key 的格式（core.ts 的
 *     STORAGE_KEY_RE：webp|jpg|png）都只認 JPEG／PNG／WebP。
 *   · 不在伺服器轉 WebP、不縮圖：伺服器端沒有 canvas，repo 刻意不裝 sharp（與
 *     upload_image_from_url 相同，見 remote-image.ts），所以只**警告**（imageWarnings）。
 *   · 稽核不記 base64 內容、不記 ChatGPT 的 download_url（帶簽章）、不記 signed URL 的 token。
 *   · 上傳了但沒被任何頁面使用的檔案不清理（site-images 本來就是這樣）；暫存 bucket 裡
 *     沒 finalize 的檔案也不清理，它是私有的，沒有公開網址。
 */
import "@tanstack/react-start/server-only";
import { z } from "zod4";
import { imageInfo, McpInputError, type ImageInfo } from "./core";
import { imageWarnings, REMOTE_IMAGE_MAX_BYTES } from "./remote-image";

/* ------------------------------------------------------------------ 規則 */

/** 與 storage.ts 的 MAX_UPLOAD_BYTES、site-images 的 file_size_limit、0053 暫存 bucket 同一個數字。 */
export const MCP_IMAGE_MAX_BYTES = REMOTE_IMAGE_MAX_BYTES;

/** 唯一收的三種格式 → 副檔名。與 storage.ts#sniffImageFormat、core.ts#STORAGE_KEY_RE 一致。 */
export const MCP_IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type McpImageType = keyof typeof MCP_IMAGE_TYPES;
const FORMAT_TO_TYPE: Record<ImageInfo["format"], McpImageType> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * base64 字串的上限。原檔 2MB → base64 是 4×ceil(2,097,152/3) = 2,796,204 字。
 * Vercel 的 request body 上限約 4.5MB，換回原檔約 3.3MB，但網站的上限是 2MB（bucket 的
 * file_size_limit），所以 2MB 才是真正的天花板；JSON-RPC 外框只多幾百字，離 4.5MB 很遠。
 */
export const MCP_BASE64_MAX_CHARS = 4 * Math.ceil(MCP_IMAGE_MAX_BYTES / 3);

/** 私有暫存 bucket（0053）。 */
export const MCP_UPLOAD_STAGING_BUCKET = "mcp-image-uploads";
/** 簽發後多久之內 finalize 才算數。 */
export const UPLOAD_WINDOW_SECONDS = 10 * 60;

/** ChatGPT 檔案下載網址只放行 OpenAI 自己的網域（含子網域）。 */
export const OPENAI_FILE_HOST_SUFFIXES = ["oaiusercontent.com", "openai.com"] as const;

const ALLOWED_NAME_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

/* ------------------------------------------------------------------ 輸入 schema */

const fileNameArg = z
  .string()
  .min(1)
  .max(200)
  .describe("原始檔名，只用來記稽核（例如 cover.jpg）。副檔名只能是 jpg／jpeg／png／webp。");

const contentTypeArg = z
  .enum(["image/jpeg", "image/png", "image/webp"])
  .describe("圖片格式：image/jpeg、image/png 或 image/webp（不收 SVG、GIF、AVIF、HTML）。");

/** OpenAI Apps SDK 規定的檔案物件形狀（developers.openai.com/apps-sdk/reference）。 */
export const OpenAIFileArg = z
  .strictObject({
    download_url: z.string().max(4000).describe("ChatGPT 提供的暫時下載網址"),
    file_id: z.string().max(300).describe("ChatGPT 的檔案 id（file_…）"),
    mime_type: z.string().max(100).optional(),
    file_name: z.string().max(300).optional(),
  })
  .describe("ChatGPT 對話裡的圖片檔（使用者貼上或上傳的圖）");

export const UPLOAD_TOOL_INPUTS = {
  create_image_upload_url: z.object({
    file_name: fileNameArg,
    content_type: contentTypeArg,
    size: z
      .number()
      .int()
      .min(1)
      .max(1_000_000_000)
      .describe("檔案大小（bytes），上限 2MB = 2097152"),
  }),
  finalize_image_upload: z.object({
    upload_id: z.string().min(1).max(100).describe("create_image_upload_url 回傳的 upload_id"),
  }),
  upload_image_base64: z.object({
    file_name: fileNameArg,
    content_type: contentTypeArg,
    data: z
      .string()
      .min(1)
      // 真正的上限（2MB 原檔 = 2,796,204 字）在 handler 裡檢查，才能回中文建議；這裡只擋荒謬的長度。
      .max(6_000_000)
      .describe(
        "圖片的 base64（可帶或不帶 data:image/…;base64, 前綴）。原檔 2MB 以內，base64 約 2,796,204 字以內。",
      ),
  }),
  upload_image_file: z.object({
    file: OpenAIFileArg,
  }),
} as const;

/* ------------------------------------------------------------------ 共用驗證 */

export type ValidatedImage = { bytes: Uint8Array; info: ImageInfo; contentType: McpImageType };

function mb(n: number): string {
  return (n / 1024 / 1024).toFixed(2);
}

/** 檔名只拿來記稽核：去掉控制字元、截長，並擋掉明顯不是點陣圖的副檔名（.svg、.html…）。 */
export function cleanFileName(name: string): string {
  const clean = Array.from(name)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && c !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, 200);
  const dot = clean.lastIndexOf(".");
  if (dot > 0) {
    const ext = clean.slice(dot + 1).toLowerCase();
    if (!ALLOWED_NAME_EXT.has(ext)) {
      throw new McpInputError(
        `不接受 .${ext} 檔。只收 JPEG、PNG、WebP 圖片；SVG、HTML、GIF、AVIF 等格式一律不收。`,
      );
    }
  }
  return clean || "image";
}

/**
 * 實際內容的驗證，三條入口共用：非空、≤2MB、magic bytes＋尺寸解析得出來（imageInfo，
 * 與 upload_image_from_url 同一支）、與宣告的格式一致。
 * 宣告不一致＝拒絕（例如副檔名／content_type 寫 png，內容其實是 HTML 或 JPEG）。
 */
export function validateImageBytes(bytes: Uint8Array, declared?: string | null): ValidatedImage {
  if (bytes.byteLength === 0) throw new McpInputError("圖片是空的");
  if (bytes.byteLength > MCP_IMAGE_MAX_BYTES) {
    throw new McpInputError(
      `圖片 ${mb(bytes.byteLength)}MB 超過上限 2MB。請先壓縮（長邊 1600px 以內的 WebP／JPEG 最理想）再上傳。`,
    );
  }
  const info = imageInfo(bytes);
  if (!info || info.width <= 0 || info.height <= 0) {
    throw new McpInputError(
      "檔案內容不是 JPEG、PNG 或 WebP 圖片（依檔案開頭的 magic bytes 判斷，不看副檔名）。SVG、HTML 等格式一律不收。",
    );
  }
  const contentType = FORMAT_TO_TYPE[info.format];
  if (declared && declared !== contentType) {
    throw new McpInputError(
      `宣告的格式是 ${declared}，但檔案內容其實是 ${contentType}。請把 content_type 改成 ${contentType} 再上傳。`,
    );
  }
  return { bytes, info, contentType };
}

/** 存進 site-images：**後台上傳同一支** uploadSiteImage()。 */
export async function storeSiteImageBytes(
  bytes: Uint8Array,
): Promise<{ key: string; url: string }> {
  const { uploadSiteImage, ImageUploadError } = await import("@/server/storage");
  try {
    return await uploadSiteImage(new File([bytes as BlobPart], "mcp-image"));
  } catch (err) {
    if (err instanceof ImageUploadError) throw new McpInputError(err.message);
    throw err;
  }
}

export function imageSummary(v: ValidatedImage) {
  const warnings = imageWarnings(v.info);
  return {
    bytes: v.bytes.byteLength,
    format: v.info.format,
    content_type: v.contentType,
    width: v.info.width,
    height: v.info.height,
    warnings: warnings.length ? warnings : undefined,
  };
}

/* ------------------------------------------------------------------ base64 */

/**
 * base64 → bytes。先看長度（在解碼前就擋，不浪費記憶體），再嚴格檢查字元集。
 * 接受 data URL 前綴、換行空白、base64url（-_）。
 */
export function decodeBase64Image(raw: string): Uint8Array {
  let s = raw.trim();
  const m = s.match(/^data:([^;,]*)(;[^,]*)?,/i);
  if (m) {
    if (!/;base64/i.test(m[2] ?? "")) throw new McpInputError("data URL 必須是 base64 編碼");
    s = s.slice(m[0].length);
  }
  s = s.replace(/\s+/g, "");
  const tooBig = (approx: number) =>
    new McpInputError(
      `圖片太大：原檔約 ${mb(approx)}MB（base64 ${s.length.toLocaleString("en-US")} 字），上限是原檔 2MB（base64 約 ${MCP_BASE64_MAX_CHARS.toLocaleString("en-US")} 字）。` +
        "請先壓縮（長邊 1600px 以內、轉成 WebP 或 JPEG），或如果你能執行指令，改用 create_image_upload_url 直接上傳檔案。",
    );
  // 解碼前先用長度擋（不浪費記憶體）。
  if (s.length > MCP_BASE64_MAX_CHARS) throw tooBig(Math.floor((s.length * 3) / 4));
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  if (s.length % 4 === 2) s += "==";
  else if (s.length % 4 === 3) s += "=";
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new McpInputError("data 不是合法的 base64 字串");
  }
  const bytes = new Uint8Array(Buffer.from(s, "base64"));
  // 長度剛好在上限邊緣（4 字一組會進位）時，以解碼後的實際大小為準。
  if (bytes.byteLength > MCP_IMAGE_MAX_BYTES) throw tooBig(bytes.byteLength);
  return bytes;
}

/* ------------------------------------------------------------------ ChatGPT 檔案 */

export function isOpenAIFileHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return OPENAI_FILE_HOST_SUFFIXES.some((suf) => h === suf || h.endsWith(`.${suf}`));
}

/* ------------------------------------------------------------------ signed upload */

const UPLOAD_ID_RE =
  /^(\d{10})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png|webp)$/;

export function parseUploadId(id: string): { issuedAt: number; ext: string } | null {
  const m = id.match(UPLOAD_ID_RE);
  if (!m) return null;
  return { issuedAt: Number(m[1]), ext: m[3] };
}

export function newUploadId(contentType: McpImageType, nowMs = Date.now()): string {
  return `${Math.floor(nowMs / 1000)}-${crypto.randomUUID()}.${MCP_IMAGE_TYPES[contentType]}`;
}

export function assertDeclaredSize(size: number): void {
  if (size > MCP_IMAGE_MAX_BYTES) {
    throw new McpInputError(
      `圖片 ${mb(size)}MB 超過上限 2MB。請先壓縮（長邊 1600px 以內的 WebP／JPEG 最理想）再上傳。`,
    );
  }
}

/** 一行 curl，給能跑指令的 AI 照抄。 */
export function curlLine(uploadUrl: string, contentType: string): string {
  return `curl -sS -X PUT -H "Content-Type: ${contentType}" -H "x-upsert: false" --data-binary @<本機檔案路徑> "${uploadUrl}"`;
}

export async function createStagedUpload(contentType: McpImageType) {
  const uploadId = newUploadId(contentType);
  const { supabaseAdmin } = await import("@/server/supabase-admin");
  const { data, error } = await supabaseAdmin()
    .storage.from(MCP_UPLOAD_STAGING_BUCKET)
    .createSignedUploadUrl(uploadId);
  if (error || !data?.signedUrl) {
    throw new Error(`無法建立上傳網址：${error?.message ?? "沒有回傳網址"}`);
  }
  return { uploadId, uploadUrl: data.signedUrl };
}

/**
 * 讀回暫存檔 → 驗證 → 存進 site-images。**不論成功失敗都刪掉暫存檔**（成功後它沒用了；
 * 失敗的是不合格的檔案；過期的是不再接受的檔案）。
 */
export async function finalizeStagedUpload(uploadId: string, nowMs = Date.now()) {
  const parsed = parseUploadId(uploadId);
  if (!parsed) throw new McpInputError("upload_id 格式不對，請用 create_image_upload_url 回傳的值");
  const { supabaseAdmin } = await import("@/server/supabase-admin");
  const bucket = supabaseAdmin().storage.from(MCP_UPLOAD_STAGING_BUCKET);
  const remove = async () => {
    const { error } = await bucket.remove([uploadId]);
    if (error) console.error(`[mcp] 刪除暫存上傳檔失敗 ${uploadId}：${error.message}`);
  };

  const age = Math.floor(nowMs / 1000) - parsed.issuedAt;
  if (age > UPLOAD_WINDOW_SECONDS || age < -60) {
    await remove();
    throw new McpInputError(
      "這個上傳網址已經超過 10 分鐘，不再接受。請重新呼叫 create_image_upload_url 拿一個新的網址再傳一次。",
    );
  }

  const { data, error } = await bucket.download(uploadId);
  if (error || !data) {
    throw new McpInputError(
      "找不到這次上傳的檔案：可能還沒用 curl 傳上去、傳失敗了，或已經 finalize 過了（每個 upload_id 只能 finalize 一次）。",
    );
  }
  try {
    if (data.size > MCP_IMAGE_MAX_BYTES) {
      throw new McpInputError(`圖片 ${mb(data.size)}MB 超過上限 2MB。`);
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    const declared = (Object.entries(MCP_IMAGE_TYPES).find(([, ext]) => ext === parsed.ext)?.[0] ??
      null) as McpImageType | null;
    const validated = validateImageBytes(bytes, declared);
    const stored = await storeSiteImageBytes(validated.bytes);
    return { validated, stored };
  } finally {
    await remove();
  }
}
