/**
 * /admin/settings —— 只剩轉址，回 /admin。
 *
 * 2026-11-10 業主要求移除後台「全站設定」。只拿掉後台的編輯介面；前台與寄信流程讀
 * public.site_settings 的邏輯不動（src/server/repos/site-settings.ts），資料表與資料不動，
 * MCP 的 get_site_settings、update_site_settings 也保留。
 *
 * ⚠️ notify_emails（店家通知信收件人）原本只有這一頁改得到——MCP update_site_settings 刻意
 * 不收這一欄。之後要改只能由工程直接改資料庫。
 *
 * 舊網址（書籤、對話紀錄）留一個轉址。掛在 _shell 底下，所以沒登入的人先被 _shell 的
 * beforeLoad 帶去 /admin/login。
 *
 * 沒有 component —— beforeLoad 先丟出去，元件永遠不會被畫出來。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/_shell/settings")({
  beforeLoad: () => {
    throw redirect({ to: "/admin", replace: true });
  },
});
