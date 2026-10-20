/**
 * 後台首頁「今日待辦」—— 唯讀。
 *
 * 🔴 掛 adminFnMiddleware：卡片裡有待收款訂單數、廠商與進貨審核數，與
 *    fns/orders.ts 同一個立場，只有 role='admin' 能讀。店員本來就不會落在首頁
 *    （_shell.index.tsx 的 beforeLoad 把 staff 導去櫃檯結帳）。
 */
import { createServerFn } from "@tanstack/react-start";
import { adminFnMiddleware } from "@/lib/admin/middleware";

export const getAdminTodo = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { getAdminTodoCounts, listUpcomingSessions } = await import("@/server/repos/admin-todo");
    const { taipeiWeekWindow } = await import("@/lib/admin/todo");
    const { fromIso, toIso } = taipeiWeekWindow(new Date());
    const [counts, sessions] = await Promise.all([
      getAdminTodoCounts(),
      listUpcomingSessions(fromIso, toIso),
    ]);
    return { counts, sessions };
  });
