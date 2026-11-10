/**
 * artists server functions — 後台目前只剩活動／策旅編輯頁的「講者」下拉會用到。
 * Every export chains adminFnMiddleware: that middleware, not the /admin/_shell
 * route guard, is the real authorization boundary (see src/lib/admin/middleware.ts).
 *
 * 2026-11-10 業主要求移除後台「講者」管理頁（/admin/artists 只剩轉址），清單／
 * 詳情／新增修改／刪除那幾支一起拿掉。public.artists 資料與 src/server/repos/artists.ts
 * 都不動，講者資料改由 MCP（list_speakers／get_speaker／update_speaker）或工程維護。
 */
import { createServerFn } from "@tanstack/react-start";
import { adminFnMiddleware } from "@/lib/admin/middleware";

/** 活動後台「主講人」下拉的選項（只有啟用中的講者，依 sort_order）。 */
export const listArtistOptions = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listArtistOptions } = await import("@/server/repos/artists");
    return await listArtistOptions();
  });
