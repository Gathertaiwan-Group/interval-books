/**
 * /admin/pages —— 只剩轉址，回 /admin。
 *
 * 2026-10-29 業主要求移除後台「頁面文案」。只拿掉後台的編輯介面；前台讀 public.pages／
 * page_blocks／page_list_items 的邏輯不動（現有文案照常顯示），資料與 schema 不動，
 * MCP 的 list_pages、get_page、update_page_blocks 也保留。
 *
 * 舊網址（書籤、對話紀錄）留一個轉址。/admin/pages/<slug> 由 _shell.pages.$.tsx 接住。
 * 掛在 _shell 底下，所以沒登入的人先被 _shell 的 beforeLoad 帶去 /admin/login。
 *
 * 沒有 component —— beforeLoad 先丟出去，元件永遠不會被畫出來。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/_shell/pages")({
  beforeLoad: () => {
    throw redirect({ to: "/admin", replace: true });
  },
});
