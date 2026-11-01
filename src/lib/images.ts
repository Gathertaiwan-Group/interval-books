import bookstoreInterior from "@/assets/bookstore-interior.jpg";
import curatedObjects from "@/assets/curated-objects.jpg";
import eventReading from "@/assets/event-reading.jpg";
import exhibitionCorner from "@/assets/exhibition-corner.jpg";
import heroMountain from "@/assets/hero-mountain.jpg";
import journeyMist from "@/assets/journey-mist.jpg";
import storefront from "@/assets/storefront.jpg";
import heroMountain640 from "@/assets/responsive/hero-mountain-640.webp";
import heroMountain1080 from "@/assets/responsive/hero-mountain-1080.webp";
import heroMountain1536 from "@/assets/responsive/hero-mountain-1536.webp";
import bookstoreInterior540 from "@/assets/responsive/bookstore-interior-540.webp";
import bookstoreInterior1080 from "@/assets/responsive/bookstore-interior-1080.webp";

/**
 * image_key -> bundled asset URL.
 *
 * Images are NOT stored in the database. Vite content-hashes every asset at
 * build time, so a path saved in Postgres would break on the next deploy. The
 * DB stores only the filename key (exhibitions.image_key, pages.og_image_key,
 * page_list_items.image_key) and this map resolves it to the real import.
 *
 * Admin-uploaded images are a second, parallel source living in the Supabase
 * Storage `site-images` bucket rather than in this bundle — see the
 * `storage:` branch of imageFor() below. The two are expected to coexist
 * indefinitely: these 7 bundled images stay put and keep being used as the
 * `fallback` argument at every call site (the last resort when the DB itself
 * is unreachable), so they are never migrated into Storage.
 */
export const IMAGE_BY_KEY: Record<string, string> = {
  "bookstore-interior.jpg": bookstoreInterior,
  "curated-objects.jpg": curatedObjects,
  "event-reading.jpg": eventReading,
  "exhibition-corner.jpg": exhibitionCorner,
  "hero-mountain.jpg": heroMountain,
  "journey-mist.jpg": journeyMist,
  "storefront.jpg": storefront,
};

/**
 * image_key values pointing into Storage (rather than this bundle) carry this
 * prefix, e.g. "storage:3f1c9c1e-....webp". Must match the prefix
 * src/server/storage.ts#uploadSiteImage() stamps onto every key it returns.
 */
const STORAGE_KEY_PREFIX = "storage:";

/**
 * The Storage project URL. Deliberately read via import.meta.env rather than
 * src/server/env.ts#supabaseUrl(): that module is server-only (see its doc
 * comment) and this file is not — imageFor() runs in route loaders (server)
 * and again in the same components during client-side render/hydration, so it
 * needs a value Vite has inlined into BOTH bundles. VITE_SUPABASE_URL is
 * exactly that, and (like the anon key) is public information already shipped
 * to the browser via src/lib/supabase.ts.
 */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;

/** Must match the bucket name the images were uploaded into (src/server/storage.ts#SITE_IMAGES_BUCKET). */
const STORAGE_BUCKET = "site-images";

/**
 * 自家網域的圖片代理路徑（2026-11 SEO 健檢 M5）。src/server.ts 攔下 /media/site-images/<name>，
 * 向 Supabase Storage 取圖後加上一年 immutable 快取再回傳（src/server/media-proxy.ts）。
 *
 * 為什麼不直接用 Supabase 的公開網址：搬庫之後 bucket 裡的物件回的是
 * `cache-control: private, no-cache`，每次瀏覽都要重新驗證、CDN 也不存。物件名稱是上傳時
 * 產生的 uuid（uploadSiteImage()），同一個名字永遠是同一張圖，所以可以放心長效快取。
 */
export const MEDIA_PROXY_PREFIX = "/media/site-images/";

/** 代理只接受 uploadSiteImage() 會產生的檔名：uuid + 圖片副檔名。 */
export const MEDIA_OBJECT_NAME_RE = /^[0-9a-f-]{36}\.(webp|jpg|jpeg|png|gif|avif)$/i;

function storagePublicUrl(objectName: string): string | null {
  if (!SUPABASE_URL || !objectName) return null;
  if (MEDIA_OBJECT_NAME_RE.test(objectName)) return `${MEDIA_PROXY_PREFIX}${objectName}`;
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${objectName}`;
}

/** 代理要轉去的上游網址（server 端用）。 */
export function storageUpstreamUrl(objectName: string): string | null {
  if (!SUPABASE_URL || !MEDIA_OBJECT_NAME_RE.test(objectName)) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${objectName}`;
}

/**
 * 首屏大圖的 WebP 多尺寸版本（2026-11 SEO 健檢 M5）。key 是 imageFor() 回傳的網址，
 * 所以後台把首頁／關於頁的圖設成這兩張內建圖時自動套用；換成上傳的圖就沒有 srcset，
 * 照原樣顯示。
 */
const SRCSET_BY_SRC: Record<string, string> = {
  [heroMountain]: `${heroMountain640} 640w, ${heroMountain1080} 1080w, ${heroMountain1536} 1536w`,
  [bookstoreInterior]: `${bookstoreInterior540} 540w, ${bookstoreInterior1080} 1080w`,
};

export function srcSetFor(src: string): string | undefined {
  return SRCSET_BY_SRC[src];
}

/**
 * Resolves an image_key to a displayable URL:
 *   1. `storage:<name>` -> the Storage object's public URL
 *   2. a known bundled key -> its Vite asset URL
 *   3. anything else (null, unknown key, misconfigured Storage URL) -> fallback
 */
export function imageFor(key: string | null | undefined, fallback: string): string {
  if (!key) return fallback;
  if (key.startsWith(STORAGE_KEY_PREFIX)) {
    return storagePublicUrl(key.slice(STORAGE_KEY_PREFIX.length)) ?? fallback;
  }
  return IMAGE_BY_KEY[key] ?? fallback;
}

export {
  bookstoreInterior,
  curatedObjects,
  eventReading,
  exhibitionCorner,
  heroMountain,
  journeyMist,
  storefront,
};
