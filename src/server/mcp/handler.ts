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

export const MCP_INSTRUCTIONS = `小時光風土誌書店（www.intervalbooks.tw）網站內容管理 MCP。

【能做什麼】
讀：最新消息、活動（含票券／場次／票種的唯讀摘要）、策旅、選物與書籍商品、地方刊物、選品、講者、合作、頁面文案、店家基本資訊、活動分類。
寫：新增／修改／刪除最新消息；新增活動（create_event）與策旅（create_journey），一次建好活動頁、售票商品、場次、票種（策旅另加卡片）；新增書或選物（create_shop_product，不設庫存）；修改活動與策旅的文案、封面、分類、講者、顯示日期；活動與策旅上架／下架（set_event_status，一個狀態：草稿／上架／下架，活動頁、票券商品、策旅卡片一起切換）；修改選物／書籍的文案、圖片、售價與上下架；修改刊物、講者、合作；修改頁面文案區塊的文字；上傳圖片（從網址、curl 直傳、ChatGPT 對話裡的圖、base64）。

【寫入流程】
1. 每一支寫入工具預設 dry_run=true，只回傳「改前 → 改後」差異，不會寫入。
2. 把差異給使用者確認後，用同樣參數加 dry_run=false 再呼叫一次才會寫入。
3. 只送要改的欄位；沒送的欄位維持原值。
4. 三語欄位（中／英／日）可以只給中文，英日文會自動翻譯；也可以自己給 {"zh","en","ja"}。
5. 刪除只開放最新消息，而且要 dry_run=false 加 confirm=true；只想隱藏最新消息請改 is_published=false；活動／策旅要下架請用 set_event_status（status=archived）。
6. 圖片要先存進網站，再把回傳的 key（storage:… 開頭）填進 image_key —— 上傳本身不會改任何頁面，所以上傳工具沒有 dry_run。依情境選一支：
   · 圖片有公開 https 網址 → upload_image_from_url
   · 你能執行指令（Claude Code、Codex 等）→ create_image_upload_url 拿 10 分鐘有效的上傳網址，用回傳的 curl 傳檔，再呼叫 finalize_image_upload 取得 key
   · ChatGPT 生成或使用者在對話裡貼上的圖片 → upload_image_file（ChatGPT 會把圖片當檔案交進來）
   · 只能把圖片轉成 base64 放進參數（例如網頁版 Claude）→ upload_image_base64（原檔 2MB 以內）
   只收 JPEG／PNG／WebP、2MB 以內；SVG、HTML、GIF、AVIF 一律不收。
7. 改價會在結果裡列出舊價 → 新價。每一筆寫入都會留下稽核紀錄（actor=mcp）。
8. 新增活動／策旅／商品（create_*）預設建成草稿（publish=false），網站上看不到；dry_run=true 回傳「將會建立什麼」的完整預覽（每次呼叫都記稽核）。時間一律台北時間。新增商品不設庫存，由店員在後台處理後再上架。

【不開放（請到 /admin 後台處理）】
訂單、付款、發票、退款；活動報名名單與任何個人資料；人員帳號與權限；進銷存（庫存、進貨、廠商）與商品庫存數量；付款帳戶與通知信設定；既有活動／策旅的票價、場次、票種、名額的修改（新增時一起建立的除外）；既有資料的網址代稱；頁面區塊的新增或刪除。

---

Interval Books (www.intervalbooks.tw) website content MCP.

Read: news, events (with a read-only summary of ticket product / sessions / plans), journeys, shop goods & books, local publications, curated picks, speakers, collaborations, page copy, store info, event categories.
Write: create / update / delete news; create an event (create_event) or journey (create_journey) together with its ticket product, sessions and ticket types; create a book or goods product (create_shop_product, no stock); update event & journey copy, cover, category, speaker and display date; list / unlist an event or journey with set_event_status (one status: draft / live / archived — the event page, its ticket product and its journey card switch together in one transaction); update goods/book copy, image, price and status; update publications, speakers, collaborations; update the text of existing page copy blocks; upload images (from a URL, by direct curl upload, from a ChatGPT chat, or as base64).

Every write tool defaults to dry_run=true and returns a before/after diff without writing. Show the diff to the user, then call again with dry_run=false to apply. Send only the fields you want to change. Localized fields accept a Chinese string (en/ja are auto-translated) or {"zh","en","ja"}. Deleting is allowed for news only and needs dry_run=false plus confirm=true. Upload images first, then put the returned key (storage:…) into image_key — uploading alone changes no page, so upload tools have no dry_run. Pick by situation: the image has a public https URL → upload_image_from_url; you can run shell commands (Claude Code, Codex) → create_image_upload_url, PUT the file with the returned curl line within 10 minutes, then finalize_image_upload to get the key; an image generated in ChatGPT or attached in the chat → upload_image_file; you can only pass base64 (e.g. Claude on the web) → upload_image_base64 (original file ≤ 2MB). Only JPEG / PNG / WebP up to 2MB; SVG, HTML, GIF and AVIF are rejected. Price changes report old → new. Every write is audit-logged with actor "mcp". create_* tools default to a draft (publish=false) and to dry_run=true (a full preview of what would be created; every call, including dry runs, is audit-logged). Times are Asia/Taipei. New products have no stock set; staff handle stock in the back office before listing.

Not available (use the /admin back office): orders, payments, invoices, refunds; event registrations and any personal data; staff accounts and permissions; inventory (stock, purchases, vendors); payment-account and notification-email settings; changing ticket prices, sessions, plans or capacity of existing events (creating them with a new event is allowed); stock quantities; slugs of existing records; adding or removing page blocks.`;

let handler: ((request: Request) => Promise<Response>) | null = null;

export function mcpHandler(): (request: Request) => Promise<Response> {
  if (handler) return handler;
  handler = createMcpHandler((server) => registerContentTools(server), {
    serverInfo: { name: "intervalbooks", version: "1.0.0" },
    instructions: MCP_INSTRUCTIONS,
  });
  return handler;
}
