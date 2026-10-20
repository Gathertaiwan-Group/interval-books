/**
 * 遠端 MCP server（/api/mcp）—— 讓 Claude Code／claude.ai 讀、改小時光網站的內容。
 *
 * 掛載點是 src/server.ts（這個專案唯一的非 createServerFn 伺服器路徑）。請求先過
 * core.ts#gateMcpRequest()（token／Origin），才會 dynamic import 到這個模組。
 *
 * 協定：mcp-handler 2.x 預設雙軌（2026-07-28 無狀態＋2025 世代的 Streamable HTTP），
 * 🔴 不要關掉 —— Claude Code CLI 目前只認得 2025-11-25。
 */
import "@tanstack/react-start/server-only";
import { createMcpHandler } from "mcp-handler";
import { registerContentTools } from "./tools";

export const MCP_INSTRUCTIONS = `小時光書店（www.intervalbooks.tw）網站內容管理 MCP。

【能做什麼】
讀：最新消息、活動（含票券／場次／票種的唯讀摘要）、策旅、選物與書籍商品、地方刊物、選品、講者、合作、頁面文案、店家基本資訊、活動分類。
寫：新增／修改／刪除最新消息；修改活動與策旅的文案、封面、分類、講者、顯示日期與公開狀態；修改選物／書籍的文案、圖片、售價與上下架；修改刊物、講者、合作；修改頁面文案區塊的文字；從網址上傳圖片。

【寫入流程】
1. 每一支寫入工具預設 dry_run=true，只回傳「改前 → 改後」差異，不會寫入。
2. 把差異給使用者確認後，用同樣參數加 dry_run=false 再呼叫一次才會寫入。
3. 只送要改的欄位；沒送的欄位維持原值。
4. 三語欄位（中／英／日）可以只給中文，英日文會自動翻譯；也可以自己給 {"zh","en","ja"}。
5. 刪除只開放最新消息，而且要 dry_run=false 加 confirm=true；只想隱藏請改 is_published=false。
6. 圖片要先用 upload_image_from_url 存進網站，再把回傳的 key 填進 image_key。
7. 改價會在結果裡列出舊價 → 新價。每一筆寫入都會留下稽核紀錄（actor=mcp）。

【不開放（請到 /admin 後台處理）】
訂單、付款、發票、退款；活動報名名單與任何個人資料；人員帳號與權限；進銷存（庫存、進貨、廠商）；付款帳戶與通知信設定；活動／策旅的票價、場次、票種、名額的建立與修改；網址代稱；頁面區塊的新增或刪除。

---

Interval Books (www.intervalbooks.tw) website content MCP.

Read: news, events (with a read-only summary of ticket product / sessions / plans), journeys, shop goods & books, local publications, curated picks, speakers, collaborations, page copy, store info, event categories.
Write: create / update / delete news; update event & journey copy, cover, category, speaker, display date and visibility; update goods/book copy, image, price and status; update publications, speakers, collaborations; update the text of existing page copy blocks; upload an image from a URL.

Every write tool defaults to dry_run=true and returns a before/after diff without writing. Show the diff to the user, then call again with dry_run=false to apply. Send only the fields you want to change. Localized fields accept a Chinese string (en/ja are auto-translated) or {"zh","en","ja"}. Deleting is allowed for news only and needs dry_run=false plus confirm=true. Upload images first with upload_image_from_url and use the returned key. Price changes report old → new. Every write is audit-logged with actor "mcp".

Not available (use the /admin back office): orders, payments, invoices, refunds; event registrations and any personal data; staff accounts and permissions; inventory (stock, purchases, vendors); payment-account and notification-email settings; creating or changing ticket prices, sessions, plans or capacity; URL slugs; adding or removing page blocks.`;

let handler: ((request: Request) => Promise<Response>) | null = null;

export function mcpHandler(): (request: Request) => Promise<Response> {
  if (handler) return handler;
  handler = createMcpHandler((server) => registerContentTools(server), {
    serverInfo: { name: "intervalbooks", version: "1.0.0" },
    instructions: MCP_INSTRUCTIONS,
  });
  return handler;
}
