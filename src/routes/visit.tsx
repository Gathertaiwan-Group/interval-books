/**
 * /visit —— 只剩轉址。
 *
 * 2026-09-02 導覽列從九格收成五格，來店資訊（地圖、地址與營業時間、一鍵導航、交通
 * 方式、店內體驗、聯絡）整段搬進 /about 的後半。
 *
 * 這個網址最不能刪：它就是 Google 商家、名片、社群簡介上寫的那一個。留一個 301。
 * 內容仍然由 pages/'visit' 那一列驅動 —— src/routes/about.tsx 的 loader 會同時讀
 * about 與 visit 兩列，對 visit 那一列的修改（MCP update_page_blocks）照樣即時生效。
 *
 * 沒有 component，也沒有 useDocumentMeta —— 說明見 src/routes/publications.tsx。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/visit")({
  beforeLoad: () => {
    throw redirect({ to: "/about", statusCode: 301 });
  },
});
