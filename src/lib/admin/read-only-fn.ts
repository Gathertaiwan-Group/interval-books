/**
 * 「這支 POST server fn 其實只讀不寫」的標記（2026-10-25 後台提速）。
 *
 * src/start.ts 的全域 middleware 把每一次 POST 都當成寫入、清掉後台的路由快取（見
 * src/lib/admin/route-cache.ts）。進銷存／門市有一批讀取 fn 是 POST（篩選條件可能含品名、
 * 廠商名，刻意不放進網址），不標的話每換一次頁、改一次篩選就把整個後台快取清空，而且會把
 * 正在預載的那一頁自己中斷。
 *
 * 掛法：`.middleware([staffFnMiddleware(), readOnlyFnMiddleware])`——**放在授權 middleware 後面**，
 * 它只有 client 那一半，不是授權，什麼都不擋。
 *
 * 🔴 只能掛在真的只讀的 fn 上。掛在會寫入（包括寫查閱紀錄，例如 listSessionRoster、
 *    readVendorSensitive）的 fn 上，寫入之後後台快取就不會清，30 秒內會看到舊資料。
 */
import { createMiddleware } from "@tanstack/react-start";
import { markReadOnlyServerFn } from "@/lib/admin/route-cache";

export const readOnlyFnMiddleware = createMiddleware({ type: "function" }).client(
  async ({ next, serverFnMeta }) => {
    if (typeof window !== "undefined" && serverFnMeta?.id) markReadOnlyServerFn(serverFnMeta.id);
    return next();
  },
);
