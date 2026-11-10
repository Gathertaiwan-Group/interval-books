/**
 * /admin/artists/new —— 只剩轉址，回 /admin。
 *
 * 2026-11-10 業主要求移除後台「講者」。只拿掉後台的編輯介面；public.artists 資料不動；前台活動頁顯示講者照常（events.speaker_id）；後台活動編輯頁的「講者」下拉仍可選（fns/artists.ts 的 listArtistOptions 保留）；MCP 的 list_speakers、get_speaker、update_speaker 保留。
 * 不新增 migration。
 *
 * 舊網址（書籤、對話紀錄）留一個轉址。掛在 _shell 底下，所以沒登入的人先被 _shell 的
 * beforeLoad 帶去 /admin/login。
 *
 * 沒有 component —— beforeLoad 先丟出去，元件永遠不會被畫出來。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/_shell/artists_/new")({
  beforeLoad: () => {
    throw redirect({ to: "/admin", replace: true });
  },
});
