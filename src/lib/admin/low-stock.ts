/**
 * 低庫存的唯一定義：每件商品自己的 low_stock_alert（預設 5），不是全站一個數字。
 * 盤點頁（StockCountTable）、repo 的篩選（inv-adjustments.ts#listStockCountProducts）與
 * MCP list_inventory 都用這一支。0 或 null＝不警示（租借品預設 0）。
 */
export function isLowStock(row: {
  stock_quantity: number;
  low_stock_alert: number | null;
}): boolean {
  return (
    row.low_stock_alert !== null &&
    row.low_stock_alert > 0 &&
    row.stock_quantity <= row.low_stock_alert
  );
}
