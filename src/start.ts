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
 */
import { createMiddleware, createStart } from "@tanstack/react-start";
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

export const startInstance = createStart(() => ({
  functionMiddleware: [adminCacheInvalidation],
}));
