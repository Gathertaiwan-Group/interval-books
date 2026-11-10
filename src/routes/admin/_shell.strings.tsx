/**
 * /admin/strings —— 只剩轉址，回 /admin。
 *
 * 2026-11-10 業主要求移除後台「介面文字」。只拿掉後台的編輯介面；前台讀 public.ui_strings
 * 覆寫 src/i18n/strings.ts 預設文案的邏輯不動（src/lib/cms.ts、src/server/repos/ui-strings.ts），
 * 資料表與資料不動，MCP 的 get_ui_strings、update_ui_string 也保留。
 *
 * 舊網址（書籤、對話紀錄）留一個轉址。掛在 _shell 底下，所以沒登入的人先被 _shell 的
 * beforeLoad 帶去 /admin/login。
 *
 * 沒有 component —— beforeLoad 先丟出去，元件永遠不會被畫出來。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/_shell/strings")({
  beforeLoad: () => {
    throw redirect({ to: "/admin", replace: true });
  },
});
