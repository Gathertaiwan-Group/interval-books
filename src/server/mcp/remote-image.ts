/**
 * 從一個公開網址抓圖，交給 src/server/storage.ts#uploadSiteImage() 存進 site-images。
 *
 * ── 跟後台上傳是同一條入庫路，但**不是**同一條壓縮路 ────────────────────
 * 後台的壓縮（長邊 1600、WebP .80，src/lib/admin/image-compress.ts）是**瀏覽器的
 * canvas** 做的；伺服器端沒有 canvas，這個 repo 也刻意不裝 sharp（見 memory／
 * storage.ts）。所以這裡做得到的是入庫那一半，一個字都不放寬：
 *   · magic bytes 嗅探（不信 Content-Type、不信副檔名）、2MB 上限（bucket 的
 *     file_size_limit）、物件名 crypto.randomUUID() —— 全部在 uploadSiteImage() 裡，
 *     這裡直接呼叫它，不抄第二份。
 * 壓縮那一半做不到，所以**明講**：結果會帶回寬高，超過 1600 或不是 WebP 時附一句
 * 警告，讓呼叫端知道這張圖比後台上傳的大。
 *
 * ── SSRF ──────────────────────────────────────────────────────────────────
 * 抓的是呼叫端給的網址，所以：只收 https、主機名解析出來的**每一個**位址都必須是公開
 * 位址（擋 127.0.0.1／10.x／169.254.169.254，以及 IPv4-mapped／NAT64／6to4 這些把
 * IPv4 包在 IPv6 裡的寫法），**連線釘在驗過的那個 IP 上**（擋 DNS rebinding），redirect
 * 自己跟、每一跳重新解析重新檢查、最多 3 跳，讀取時邊讀邊數、超過上限立刻停。
 */
import "@tanstack/react-start/server-only";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import {
  imageInfo,
  isBlockedHostname,
  isPrivateAddress,
  McpInputError,
  type ImageInfo,
} from "./core";

/** 與 storage.ts 的 MAX_UPLOAD_BYTES（bucket 的 file_size_limit）同一個數字。 */
export const REMOTE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** 後台壓縮的長邊上限（image-compress.ts）。只用來產生警告。 */
export const SITE_IMAGE_MAX_EDGE = 1600;

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/**
 * 解析主機名並驗證**每一個**位址都是公開位址，回第一個（之後連線就釘在它上面）。
 */
async function resolvePublic(hostname: string): Promise<{ address: string; family: number }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new McpInputError(`查不到主機 ${hostname}`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new McpInputError("不接受內網或本機位址");
  }
  return addresses[0];
}

function assertUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpInputError("網址格式不正確");
  }
  if (url.protocol !== "https:") throw new McpInputError("只接受 https:// 開頭的圖片網址");
  if (url.username || url.password) throw new McpInputError("網址不可以帶帳號密碼");
  if (url.port && url.port !== "443") throw new McpInputError("只接受預設的 443 連接埠");
  if (isBlockedHostname(url.hostname)) throw new McpInputError("不接受內網或本機位址");
  return url;
}

type Hop = { status: number; location: string | null; body: Uint8Array | null };

/**
 * 一跳 HTTPS GET，連線**釘在已驗證的那個位址上**：`lookup` 選項讓 socket 用我們
 * 驗過的 IP，而不是讓 fetch 自己再解析一次 DNS（那一次可能被 rebinding 成 127.0.0.1）。
 * TLS 的 SNI／憑證驗證仍然用原本的主機名。
 */
function getPinned(
  url: URL,
  pinned: { address: string; family: number },
  signal: AbortSignal,
): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        signal,
        headers: { accept: "image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.1" },
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (opts && opts.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        }) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({
            status,
            location: (res.headers.location as string | undefined) ?? null,
            body: null,
          });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ status, location: null, body: null });
          return;
        }
        const declared = Number(res.headers["content-length"] ?? "0");
        if (declared > REMOTE_IMAGE_MAX_BYTES) {
          res.destroy();
          reject(
            new McpInputError(
              `圖片 ${(declared / 1024 / 1024).toFixed(1)}MB 超過上限 2MB。請提供較小的版本（長邊 1600px 以內的 WebP/JPEG 最理想）。`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.byteLength;
          if (total > REMOTE_IMAGE_MAX_BYTES) {
            res.destroy();
            reject(
              new McpInputError(
                "圖片超過上限 2MB。請提供較小的版本（長邊 1600px 以內的 WebP/JPEG 最理想）。",
              ),
            );
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({ status, location: null, body: new Uint8Array(Buffer.concat(chunks)) }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export type FetchedImage = { bytes: Uint8Array; info: ImageInfo; finalUrl: string };

export async function fetchRemoteImage(raw: string): Promise<FetchedImage> {
  let url = assertUrlShape(raw);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let hop: Hop | null = null;
    for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
      const pinned = await resolvePublic(url.hostname);
      hop = await getPinned(url, pinned, controller.signal);
      if (hop.status >= 300 && hop.status < 400) {
        if (!hop.location) throw new McpInputError(`圖片網址轉址了但沒有目的地（${hop.status}）`);
        url = assertUrlShape(new URL(hop.location, url).href);
        hop = null;
        continue;
      }
      break;
    }
    if (!hop) throw new McpInputError("轉址太多次（超過 3 次）");
    if (!hop.body) throw new McpInputError(`抓圖失敗：對方回 ${hop.status}`);
    const bytes = hop.body;
    if (bytes.byteLength === 0) throw new McpInputError("圖片是空的");
    const info = imageInfo(bytes);
    // dry_run 也要給出跟正式上傳同一個答案：uploadSiteImage() 只收 JPEG／PNG／WebP
    // （magic bytes），讀不出格式的在這裡就擋，不要讓預覽說「檢查通過」、正式呼叫才失敗。
    if (!info) throw new McpInputError("無法辨識的圖片格式，僅接受 JPEG、PNG 或 WebP");
    return { bytes, info, finalUrl: url.href };
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || controller.signal.aborted)) {
      throw new McpInputError("抓圖逾時（超過 15 秒）");
    }
    if (err instanceof McpInputError) throw err;
    throw new McpInputError(`抓圖失敗：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 這張圖跟後台上傳的標準差在哪裡。空陣列＝沒差。 */
export function imageWarnings(info: ImageInfo): string[] {
  const out: string[] = [];
  const edge = Math.max(info.width, info.height);
  if (edge > SITE_IMAGE_MAX_EDGE) {
    out.push(
      `長邊 ${edge}px 超過後台標準 ${SITE_IMAGE_MAX_EDGE}px（伺服器端不重新壓縮，會原樣存放，前台載入會比較慢）`,
    );
  }
  if (info.format !== "webp") out.push(`格式是 ${info.format}，不是後台標準的 WebP（原樣存放）`);
  return out;
}
