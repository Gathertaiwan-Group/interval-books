/**
 * /admin/collaborations/new —— 只剩轉址，回 /admin。
 *
 * 2026-11-10 業主要求移除後台「合作」。只拿掉後台的編輯介面；public.collaborations 資料與前台讀取（/partnership、/curation 的合作案例）不動；MCP 的 list_collaborations、get_collaboration、update_collaboration 保留。
 * 不新增 migration。
 *
 * 舊網址（書籤、對話紀錄）留一個轉址。掛在 _shell 底下，所以沒登入的人先被 _shell 的
 * beforeLoad 帶去 /admin/login。
 *
 * 沒有 component —— beforeLoad 先丟出去，元件永遠不會被畫出來。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/_shell/collaborations_/new")({
  beforeLoad: () => {
    throw redirect({ to: "/admin", replace: true });
  },
});
