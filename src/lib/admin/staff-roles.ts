/**
 * 後台人員頁（/admin/staff 列表與 /admin/staff/$id 編輯內頁）共用的角色文字與可勾選的細權限。
 * 2026-10-26 後台第 3 批：編輯身分從列表裡的 Dialog 改成內頁時，從 _shell.staff.tsx 搬出來。
 */
import { CREATABLE_BACKOFFICE_ROLES, STAFF_PERMISSIONS } from "@/lib/admin/schemas";
import { HIDDEN_PERMISSIONS } from "@/lib/admin/permission-labels";

export type CreatableRole = (typeof CREATABLE_BACKOFFICE_ROLES)[number];

export const ROLE_LABEL: Record<CreatableRole, string> = {
  admin: "管理員",
  staff: "門市人員",
  pending: "待審核",
};

export const ROLE_DESCRIPTION: Record<CreatableRole, string> = {
  admin: "能進所有模組、能管理後台人員",
  staff: "能進「門市」與勾選的細權限對應模組，看不到這一頁",
  pending: "已登入但尚未開通任何模組，看到的是待開通說明頁",
};

// 九個細權限的中文名稱在 src/lib/admin/permission-labels.ts，與各頁「需要店長開通
// 『○○』權限」的提示共用。approve_inventory_adjustments 在那裡標成 HIDDEN_PERMISSIONS：
// 沒有任何程式在檢查它，所以這一頁不再列出來（帳號身上既有的值照樣保留，不會被清掉）。
export const VISIBLE_PERMISSIONS = STAFF_PERMISSIONS.filter((p) => !HIDDEN_PERMISSIONS.has(p));
