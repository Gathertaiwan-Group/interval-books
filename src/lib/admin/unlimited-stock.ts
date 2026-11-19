/**
 * 「不限庫存」（0062，inv.products.unlimited_stock）的共用小工具。
 *
 * 後台商品表單（UnlimitedStockField）與 MCP 的 create／update_inventory_product 預覽共用，
 * 兩邊的提醒文字與判斷條件只有這一份。
 */

/**
 * 開了不限庫存、但成本是 0（或沒填）時的提醒。**只提醒、不擋**。
 *
 * 不限庫存的品項通常沒有進貨批次，0062 的 inv.allocate_fifo_cost() 對批次不足的件數改用
 * 品項的 cost_price 計銷貨成本——成本 0 會讓每一筆銷售的毛利等於售價。
 */
export function unlimitedStockZeroCostWarning(input: {
  unlimited_stock?: boolean | null;
  cost_price?: number | string | null;
}): string | null {
  if (input.unlimited_stock !== true) return null;
  const raw = input.cost_price;
  const cost =
    raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")
      ? 0
      : Number(raw);
  if (Number.isFinite(cost) && cost > 0) return null;
  return "成本是 0：不限庫存的品項通常沒有進貨批次，銷貨成本會用這裡的「成本」計算，成本 0 會讓毛利等於售價。確定的話仍可儲存。";
}

/** products_unlimited_stock_consignment_only（0062 的 CHECK）的名字。 */
export const UNLIMITED_STOCK_CHECK = "products_unlimited_stock_consignment_only";
