/**
 * 銷售紀錄的「經手人」顯示名稱（/admin/sales 列表與明細、MCP list_sales／get_sale、
 * export_sales_csv 共用這一條規則，不要在別處各寫一份）。
 *
 * 資料來源：inv.sales.user_id。三支結帳 RPC（pos_checkout／inv_combo_checkout／
 * inv_secondhand_checkout）都把呼叫端傳的 p_user_id 寫進去；後台 server fn 傳
 * context.staff.userId，MCP 傳 OAuth 身分（oauthUserId），從來不吃 request body。
 *
 * ⚠️ 網站訂單（channel = 'online'）的 user_id **不是**經手人：commit_inventory_reservations()
 *    （0011 §7）沒有店員可填，退回「品項擁有者」只是為了滿足 NOT NULL。所以網站訂單一律顯示
 *    「網站」，也不能拿 user_id 去篩選（見 inv-sales.ts 的 seller 篩選）。
 *
 * 名稱優先序：inv.profiles.name（view 的 operator_name）→ 帳號 email 的 @ 前綴 → 「—」。
 * 不猜、不回填：查不到就是「—」。
 */
export const SELLER_WEB = "網站";
export const SELLER_UNKNOWN = "—";

/** 篩選值：「web」＝網站訂單；其他＝門市經手人的 user_id（uuid）。 */
export const SELLER_FILTER_WEB = "web";

export function emailPrefix(email: string | null | undefined): string | null {
  const s = (email ?? "").trim();
  if (!s) return null;
  const at = s.indexOf("@");
  const prefix = (at >= 0 ? s.slice(0, at) : s).trim();
  return prefix || null;
}

export function sellerLabel(input: {
  channel: string | null | undefined;
  /** inv_pos_sales.operator_name = coalesce(inv.profiles.name, inv.profiles.email) */
  operatorName: string | null | undefined;
  /** public.profiles.email（後台帳號），inv.profiles 沒有名字時的退路 */
  accountEmail?: string | null;
}): string {
  if (input.channel === "online") return SELLER_WEB;
  const op = (input.operatorName ?? "").trim();
  if (op && !op.includes("@")) return op;
  return emailPrefix(op) ?? emailPrefix(input.accountEmail) ?? SELLER_UNKNOWN;
}
