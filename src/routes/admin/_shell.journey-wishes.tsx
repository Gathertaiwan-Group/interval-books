/**
 * /admin/journey-wishes —— 只剩轉址，回 /admin。
 *
 * 2026-11-10 業主要求移除後台「旅程願望」。只拿掉後台的編輯介面；public.journey_wishes 資料不動；前台願望表單一併停用（見 src/lib/journey-wish.ts 的 JOURNEY_WISH_FORM_ENABLED）；MCP 的 list_journey_wishes、get_journey_wish、update_journey_wish 保留。
 * 不新增 migration。
 *
 * 舊網址（書籤、對話紀錄）留一個轉址。掛在 _shell 底下，所以沒登入的人先被 _shell 的
 * beforeLoad 帶去 /admin/login。
 *
 * 沒有 component —— beforeLoad 先丟出去，元件永遠不會被畫出來。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/_shell/journey-wishes")({
  beforeLoad: () => {
    throw redirect({ to: "/admin", replace: true });
  },
});
