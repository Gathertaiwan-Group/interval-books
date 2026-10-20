/**
 * 細權限（staff_permissions）的中文名稱 —— 後台人員頁的勾選框與「為什麼這顆按鈕
 * 按不下去」的提示共用同一份，店員看到的名字才會和店長在人員頁勾的那一格一模一樣。
 *
 * 以前提示寫的是資料庫裡的權限代碼（approve_… 那一類），店員看不懂、也不知道該找誰。
 */
import type { STAFF_PERMISSIONS } from "@/lib/admin/schemas";

export type PermissionValue = (typeof STAFF_PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<PermissionValue, string> = {
  approve_products: "審核商品",
  approve_purchases: "審核進貨",
  approve_price_changes: "審核調價",
  approve_vendors: "審核廠商",
  approve_combo_sets: "審核套餐",
  approve_stock_adjustments: "審核在庫異動／處理賣超告警",
  approve_inventory_adjustments: "審核庫存調整（目前未啟用：沒有畫面在檢查這個權限）",
  "inv.vendor.pii.read": "查看廠商完整身分資料（統編、身分證、匯款帳戶）",
  "event.roster.read": "查看活動報名名單",
};

/**
 * 人員頁不顯示的權限。approve_inventory_adjustments 全 repo 沒有任何一支 server fn、
 * 畫面或資料庫函式在檢查它（只出現在常數定義與 0010／0019／0021 的 CHECK 值域），
 * 勾了也沒有任何效果，留在畫面上只會讓店長以為多開了一項能力。
 *
 * 只是不顯示：既有帳號身上若已經有這一列，編輯時照樣原封不動送回去，不會被清掉。
 */
export const HIDDEN_PERMISSIONS: ReadonlySet<PermissionValue> = new Set<PermissionValue>([
  "approve_inventory_adjustments",
]);

/** 按鈕停用時的提示：「需要店長開通『審核商品』權限」。 */
export function needsPermissionHint(permission: PermissionValue): string {
  return `需要店長開通「${PERMISSION_LABELS[permission]}」權限`;
}
