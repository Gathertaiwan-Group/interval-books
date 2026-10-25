/**
 * TanStack Start 的 start entry（start-plugin-core 的 resolveStartEntryPlan() 會自動把
 * `src/start.ts` 當成 start entry）。這裡只掛一支全域的 function middleware，而且只有
 * client 那一半：
 *
 *   瀏覽器每送出一次 POST server fn（這個專案的寫入全部是 POST）→ 結束之後（成功或失敗都算，
 *   失敗也可能已經寫了一半）通知後台路由快取「有東西改了」，見 src/lib/admin/route-cache.ts。
 *
 * ⚠️ 這支 middleware **沒有 server 那一半，也不是授權**。授權仍然是每一支 fn 自己的
 *    adminFnMiddleware／staffFnMiddleware／vendorFnMiddleware。
 *
 * ── CSRF（2026-10-26）────────────────────────────────────────────────────────
 * 框架建議的 createCsrfMiddleware，只套在 server fn 請求上（handlerType === "serverFn"）：
 * 瀏覽器帶的 Sec-Fetch-Site 必須是 same-origin（沒有這個標頭的舊瀏覽器退回比對 Origin，
 * 再退回 Referer；三個都沒有就擋）。後台的 cookie 是 SameSite=Lax，跨站 POST 本來就不會帶，
 * 這裡是框架層的第二道。
 *
 * 不受影響的路徑：金流與排程的 webhook（黑貓 APN／導回、PayUni、發票／通知／掃描圖排程、
 * /api/mcp）全部在 src/server.ts 被攔下、**根本不會進到** startFetch，也就不經過這裡；
 * 就算進來了，filter 也只認 server fn。一般頁面（handlerType === "router"）不檢查。
 *
 * 加這支之前，因為專案有自己的 createStart()，框架**不會**套用它內建的預設 CSRF（只有沒有
 * start entry 時才會），dev 每次啟動都印「server functions are not protected by the CSRF
 * middleware」。
 */
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { isReadOnlyServerFn, noteAdminMutation } from "@/lib/admin/route-cache";

const adminCacheInvalidation = createMiddleware({ type: "function" }).client(
  async ({ next, method, serverFnMeta }) => {
    if (method !== "POST" || typeof window === "undefined") return next();
    try {
      return await next();
    } finally {
      // 標成只讀的 POST fn（readOnlyFnMiddleware 在 next() 裡面就登記好了）不算寫入。
      if (!isReadOnlyServerFn(serverFnMeta?.id)) noteAdminMutation();
    }
  },
);

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [adminCacheInvalidation],
}));
