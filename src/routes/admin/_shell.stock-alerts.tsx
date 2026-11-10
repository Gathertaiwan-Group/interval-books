/**
 * /admin/stock-alerts —— 賣超告警。
 *
 * 2026-11-10 業主要求把這一頁併進後台首頁（今日待辦）的「賣超告警」卡片
 * （src/components/admin/StockAlertsPanel.tsx）：
 *   · admin 打這個網址 → 轉去 /admin#stock-alerts，卡片自動展開並捲到那裡。
 *   · 門市人員（staff）進不了 /admin（_shell.index.tsx 把他們導去櫃檯），但他們原本就看得到
 *     這一頁、有 approve_stock_adjustments 的還能標記已處理——不能讓他們失去這個功能，所以
 *     staff 留在這裡，畫的是同一張卡片（直接展開）。側欄的入口也只對 staff 顯示
 *     （_shell.tsx 的 staffOnly）。
 *
 * 0011 建了 public.stock_oversold_alerts；兩個來源（online_commit／pos_override）都是刻意
 * 放行的結果，只有人能把帳對回去，所以唯一的動作是「我處理完了，這是我做了什麼」。
 * 資料與動作沿用 lib/admin/fns/pos.ts 的 listStockAlerts／resolveStockAlert。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { StockAlertsPanel } from "@/components/admin/StockAlertsPanel";
import { STOCK_ALERTS_ANCHOR } from "@/lib/admin/stock-alerts";

export const Route = createFileRoute("/admin/_shell/stock-alerts")({
  beforeLoad: ({ context }) => {
    if (context.user?.role === "admin") {
      throw redirect({ to: "/admin", hash: STOCK_ALERTS_ANCHOR, replace: true });
    }
  },
  loader: async () => {
    const { listStockAlerts } = await import("@/lib/admin/fns/pos");
    return { alerts: await listStockAlerts({ data: { status: "open" } }) };
  },
  head: () => ({ meta: [{ title: "賣超告警｜小時光書店後台" }] }),
  component: StockAlertsPage,
});

function StockAlertsPage() {
  const { alerts } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  return (
    <StockAlertsPanel
      openAlerts={alerts}
      canResolve={user.permissions.includes("approve_stock_adjustments")}
      defaultExpanded
    />
  );
}
