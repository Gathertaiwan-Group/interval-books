/**
 * /news —— 只剩轉址。
 *
 * 2026-10-29 業主：「把網站最新消息的功能移除」。只拿掉前台（這一頁、首頁跑馬燈）；
 * public.news 的資料、後台 /admin/news 與 MCP 的 news 工具都保留，日後要恢復不用重建。
 *
 * 網址仍然保留並 301 回首頁，理由與 /contact、/visit 相同：外部連結與搜尋引擎收錄的
 * 舊網址不該變成 404。/news/<任何東西>（含舊的 #news-<id> 錨點、萬一有人自己拼的
 * 逐則網址）由 src/routes/news.$.tsx 接住，同樣回首頁。
 *
 * 沒有 component —— beforeLoad 先丟出去，元件永遠不會被畫出來。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/news")({
  beforeLoad: () => {
    throw redirect({ to: "/", statusCode: 301 });
  },
});
