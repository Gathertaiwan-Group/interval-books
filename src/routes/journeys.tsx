/**
 * /journeys —— 只剩轉址（2026-11-10）。
 *
 * 「活動」與「策旅」兩個列表頁合併成 /events「活動與策旅」：策旅卡片（日期區間、天數、
 * 票價、封面）、過往策旅與「策旅合作共創」都搬進 src/routes/events.index.tsx，用
 * ?type=journey 篩選。這個網址留一個 301 —— 它散在社群貼文、名片與搜尋結果裡，刪掉就是 404。
 * /en/journeys、/ja/journeys 由 router 的 lang rewrite 轉到 /en/events?type=journey 等
 * （與 /visit → /about 同一套，見 src/routes/visit.tsx）。
 *
 * 策旅的詳情頁一直都在 /events/<slug>（例：/events/kungtung），/journeys 本身從來沒有子路由，
 * 所以這支轉址不影響任何一趟策旅的頁面與報名。
 *
 * pages/'journeys' 那一列的 CMS 文案（空狀態、過往策旅標題、合作共創）照樣由 /events 讀取。
 *
 * 沒有 component，也沒有 useDocumentMeta —— 與 src/routes/visit.tsx 相同。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/journeys")({
  beforeLoad: () => {
    throw redirect({ to: "/events", search: { type: "journey" }, statusCode: 301 });
  },
});
