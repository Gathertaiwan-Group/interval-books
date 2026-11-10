/**
 * 賣超告警（public.inv_stock_alerts）在後台首頁卡片上的純邏輯：哪一筆最急、件數怎麼數。
 *
 * 不 import 任何 server 程式，scripts/stock-alerts-dashboard-selftest.mjs 直接用 Node 原生
 * 型別剝離載入驗證。資料本身仍由 lib/admin/fns/pos.ts 的 listStockAlerts 查（staffFnMiddleware）。
 *
 * 這裡沒有「門檻／低庫存」的概念：一筆告警就是「賣掉了，但架上的數字不夠」，嚴重程度看
 * 差幾件（shortfall）。兩個來源都是刻意放行（見 _shell.stock-alerts.tsx 舊檔頭／0011）：
 *   online_commit —— 網站付款成功時庫存不夠：客人已經付錢、正在等貨，最急。
 *   pos_override  —— 店員在櫃檯強制放行：客人已經把書帶走，只剩帳要對回去。
 */

/** 卡片只需要的欄位（StockAlertRow 的子集），讓純邏輯不必 import server 型別。 */
export type StockAlertLike = {
  alert_id: number;
  created_at: string;
  source: string;
  shortfall: number;
  resolved_at: string | null;
};

export const STOCK_ALERTS_ANCHOR = "stock-alerts";
export const STOCK_ALERTS_TOP_N = 5;

export function stockAlertSourceLabel(source: string): string {
  return source === "pos_override" ? "櫃檯強制放行" : "網站付款後庫存不足";
}

/** 標題旁的件數徽章：只數未處理的。 */
export function countOpenAlertsBySource(alerts: readonly StockAlertLike[]): {
  online: number;
  pos: number;
  total: number;
} {
  let online = 0;
  let pos = 0;
  for (const a of alerts) {
    if (a.resolved_at !== null) continue;
    if (a.source === "pos_override") pos += 1;
    else online += 1;
  }
  return { online, pos, total: online + pos };
}

/**
 * 最急的排前面：未處理優先 → 網站付款（客人在等貨）優先於櫃檯放行 → 差的件數多的優先 →
 * 越早發生的越前面（放越久越該處理）。不改動傳進來的陣列。
 */
export function sortStockAlertsByUrgency<T extends StockAlertLike>(alerts: readonly T[]): T[] {
  const rank = (a: T) => (a.resolved_at === null ? 0 : 1);
  const sourceRank = (a: T) => (a.source === "pos_override" ? 1 : 0);
  return [...alerts].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      sourceRank(a) - sourceRank(b) ||
      b.shortfall - a.shortfall ||
      a.created_at.localeCompare(b.created_at) ||
      a.alert_id - b.alert_id,
  );
}
