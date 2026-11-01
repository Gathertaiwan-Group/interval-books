/**
 * /media/site-images/<uuid>.<ext> —— Supabase Storage 公開圖片的自家網域代理（2026-11 SEO 健檢 M5）。
 *
 * 為什麼要代理：bucket 裡的物件（搬庫時複製過來的）回 `cache-control: private, no-cache`，
 * 瀏覽器每次都要重新驗證、Vercel CDN 不存。這裡取回同一張圖，改成一年 immutable 快取：
 *   - 物件名稱是 uploadSiteImage() 產生的 uuid，同名永遠是同一張圖，長效快取是安全的。
 *   - s-maxage 讓 Vercel CDN 存住，之後同一張圖不會再進到函式。
 *
 * 安全：只接受 MEDIA_OBJECT_NAME_RE（uuid + 圖片副檔名）的名字，上游網址固定是本站
 * Supabase 的 site-images bucket——不是開放代理，拿不到別的 bucket 或別的網站。
 * 上游非 200 → 原狀態碼回傳且不快取（避免把一次暫時失敗存一年）。
 *
 * ⚠️ 沒有做縮圖：Supabase 的 image transformation 是按原圖數量計費的付費功能，這一期不開。
 */
import { MEDIA_PROXY_PREFIX, storageUpstreamUrl } from "@/lib/images";

const IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable";

export async function handleMediaProxy(request: Request, pathname: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const name = decodeURIComponent(pathname.slice(MEDIA_PROXY_PREFIX.length));
  const upstream = storageUpstreamUrl(name);
  if (!upstream)
    return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });

  let res: Response;
  try {
    res = await fetch(upstream, { method: request.method });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: { "cache-control": "no-store" } });
  }
  if (res.status !== 200) {
    return new Response(null, {
      status: res.status === 400 ? 404 : res.status,
      headers: { "cache-control": "no-store" },
    });
  }
  const headers = new Headers();
  const type = res.headers.get("content-type");
  if (type) headers.set("content-type", type);
  const length = res.headers.get("content-length");
  if (length) headers.set("content-length", length);
  const etag = res.headers.get("etag");
  if (etag) headers.set("etag", etag);
  headers.set("cache-control", IMMUTABLE);
  headers.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : res.body, { status: 200, headers });
}
