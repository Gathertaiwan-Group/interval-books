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
查後台資料（唯讀，與 /admin 同一套查詢）：首頁待辦（get_admin_dashboard）；訂單（list_orders／get_order：明細、付款紀錄、發票號碼與狀態、聯絡資料修改紀錄）；報名（list_registrations 列場次與人數、get_session_roster 看某場名單）；策旅意願單（list_journey_wishes／get_journey_wish）；銷售（list_sales／get_sale、get_sales_summary 期間營收）；進銷存（list_inventory 含低庫存、list_stock_alerts 賣超告警、list_purchases／get_purchase 進貨、list_vendors／get_vendor 廠商）；推薦碼（list_referrers、get_referral_report 月報）；合作邀約（list_partnership_inquiries／get_partnership_inquiry）。list_* 預設 20 筆、上限 100，用 page 翻頁；細節用 get_*。名單與訂單含客人個資，只在回答使用者需要時引用。
寫：新增／修改／刪除最新消息；新增活動（create_event）與策旅（create_journey），一次建好活動頁、售票商品、場次、票種（策旅另加卡片）；新增書或選物（create_shop_product，不設庫存）；修改活動與策旅的文案、封面、分類、講者、顯示日期；活動與策旅上架／下架（set_event_status，一個狀態：草稿／上架／下架，活動頁、票券商品、策旅卡片一起切換）；修改選物／書籍的文案、圖片、售價與上下架；修改刊物、講者、合作；修改頁面文案區塊的文字；上傳圖片（從網址、curl 直傳、ChatGPT 對話裡的圖、base64）。

營運寫入（需「可寫入」連線，全部預設 dry_run=true）：訂單出貨／完成（update_order_fulfillment）、標記已收款（mark_order_paid）、電話報名（create_phone_order／update_phone_order_contacts）、移除報名（remove_registration，名額自動釋放）、意願單與合作邀約狀態、庫存異動／盤點／進貨、介面文字與網站設定（祕密與匯款欄位不開放）。
對外動作：重寄訂單信（resend_order_email，預設只寄管理員；寄客人要 send_to_customer=true 並用第一次回傳的 confirm_token 再呼叫一次）、重新開立發票（reissue_invoice）、申請作廢發票（request_invoice_void，只在後台產生待辦，由人按「作廢發票」）。不退款、不直接作廢。
報表：CSV 匯出（名單／訂單／營收，回 15 分鐘到期的下載連結）、熱銷排行、活動報名率、回購率。唯讀連線呼叫寫入工具一律被拒（含預覽）；含個資的 CSV 匯出也只開放可寫入連線。

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
訂單、付款、發票、退款、報名名單、進銷存（庫存、進貨、廠商）、推薦碼結算、意願單與合作邀約的任何修改（這些只開放唯讀查詢）；人員帳號與權限；付款帳戶與通知信設定；廠商身分證／統編／匯款帳戶；既有活動／策旅的票價、場次、票種、名額的修改（新增時一起建立的除外）；既有資料的網址代稱；頁面區塊的新增或刪除。

---

Interval Books (www.intervalbooks.tw) website content MCP.

Read: news, events (with a read-only summary of ticket product / sessions / plans), journeys, shop goods & books, local publications, curated picks, speakers, collaborations, page copy, store info, event categories.
Back-office lookups (read-only, same queries as /admin): dashboard to-dos, orders (list_orders / get_order with items, payments, invoice number & status, contact-edit log), registrations (list_registrations, get_session_roster), journey wishes, sales (list_sales / get_sale / get_sales_summary), inventory (list_inventory incl. low stock, list_stock_alerts, purchases, vendors), referrals (list_referrers, get_referral_report), partnership inquiries. list_* default to 20 rows (max 100) with page; use get_* for details. Orders and rosters contain customer personal data — quote it only as the user needs.
Write: create / update / delete news; create an event (create_event) or journey (create_journey) together with its ticket product, sessions and ticket types; create a book or goods product (create_shop_product, no stock); update event & journey copy, cover, category, speaker and display date; list / unlist an event or journey with set_event_status (one status: draft / live / archived — the event page, its ticket product and its journey card switch together in one transaction); update goods/book copy, image, price and status; update publications, speakers, collaborations; update the text of existing page copy blocks; upload images (from a URL, by direct curl upload, from a ChatGPT chat, or as base64).

Every write tool defaults to dry_run=true and returns a before/after diff without writing. Show the diff to the user, then call again with dry_run=false to apply. Send only the fields you want to change. Localized fields accept a Chinese string (en/ja are auto-translated) or {"zh","en","ja"}. Deleting is allowed for news only and needs dry_run=false plus confirm=true. Upload images first, then put the returned key (storage:…) into image_key — uploading alone changes no page, so upload tools have no dry_run. Pick by situation: the image has a public https URL → upload_image_from_url; you can run shell commands (Claude Code, Codex) → create_image_upload_url, PUT the file with the returned curl line within 10 minutes, then finalize_image_upload to get the key; an image generated in ChatGPT or attached in the chat → upload_image_file; you can only pass base64 (e.g. Claude on the web) → upload_image_base64 (original file ≤ 2MB). Only JPEG / PNG / WebP up to 2MB; SVG, HTML, GIF and AVIF are rejected. Price changes report old → new. Every write is audit-logged with actor "mcp". create_* tools default to a draft (publish=false) and to dry_run=true (a full preview of what would be created; every call, including dry runs, is audit-logged). Times are Asia/Taipei. New products have no stock set; staff handle stock in the back office before listing.

Not available (use the /admin back office): any change to orders, payments, invoices, refunds, registrations, inventory (stock, purchases, vendors), referral settlements, journey wishes or partnership inquiries (these are read-only here); staff accounts and permissions; payment-account and notification-email settings; vendor ID / tax numbers and bank accounts; changing ticket prices, sessions, plans or capacity of existing events (creating them with a new event is allowed); stock quantities; slugs of existing records; adding or removing page blocks.`;

let handler: ((request: Request) => Promise<Response>) | null = null;

export function mcpHandler(): (request: Request) => Promise<Response> {
  if (handler) return handler;
  handler = createMcpHandler((server) => registerContentTools(server), {
    serverInfo: { name: "intervalbooks", version: "1.0.0" },
    instructions: MCP_INSTRUCTIONS,
  });
  return handler;
}
