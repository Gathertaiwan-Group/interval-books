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
    const { loadInvoiceAttentionRows } = await import("@/server/invoice-alerts");
    const { fromIso, toIso } = taipeiWeekWindow(new Date());
    const { loadPendingVoidRequests } = await import("@/server/repos/mcp-void-requests");
    const [counts, sessions, invoiceRows, voidRequests] = await Promise.all([
      getAdminTodoCounts(),
      listUpcomingSessions(fromIso, toIso),
      // 「N 張已付款訂單的發票尚未開立」橫幅（業主 2026-10-28）。null＝讀取失敗。
      loadInvoiceAttentionRows(),
      // 「MCP 申請作廢待處理」（src/lib/mcp-void-requests.ts）。讀失敗＝null，畫面說讀取失敗，
      // 不讓整個首頁掛掉。
      loadPendingVoidRequests().catch((err: unknown) => {
        console.error(
          `[dashboard] MCP 作廢申請讀取失敗：${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }),
    ]);
    return {
      counts,
      sessions,
      invoiceProblems: invoiceRows === null ? null : invoiceRows.length,
      mcpVoidRequests: voidRequests,
    };
  });
