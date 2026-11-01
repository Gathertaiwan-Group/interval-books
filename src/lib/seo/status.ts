/**
 * 「這一頁讀不到資料，請回 503」的內部標頭（2026-11 SEO 健檢 L7）。
 *
 * 為什麼不是在 loader 裡 setResponseStatus(503)：TanStack Start 的 SSR 回應狀態碼是
 * router 自己決定的（getSsrStatus()：只會是 200／404／500），h3 event 上設的狀態碼
 * 會被蓋掉。所以改走「路由 headers() 送一個內部標頭 → src/server.ts 看到就改成 503
 * 並補 Retry-After、再把這個標頭拿掉」——瀏覽器與 CDN 永遠看不到它。
 *
 * 只用在「主體資料讀不到」的詳情頁（/events/$slug、/shop/$slug 的 unavailable 分支）。
 * 查無此資料仍然是 404，不是 503。
 */
export const INTERNAL_STATUS_HEADER = "x-interval-internal-status";

/** 路由的 headers() 用：讀取失敗時回這個，其餘回 undefined。 */
export function unavailableHeaders(unavailable: boolean): Record<string, string> | undefined {
  return unavailable ? { [INTERNAL_STATUS_HEADER]: "503" } : undefined;
}
