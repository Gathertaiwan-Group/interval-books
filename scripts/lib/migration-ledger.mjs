/**
 * supabase/migrations 的**共用帳本**，以及三條建立在它上面的斷言。
 *
 * ═══ 為什麼有這個檔案 ═══════════════════════════════════════════════════════
 *
 * 在這之前，「migration 盤點」散在八支自檢裡，長成三種形狀：
 *
 *   (a) 純數量快照   check("migrations 共 27 支", migrations.length, 27)   ×3 支
 *   (b) 位置快照     check("0023 是最後一支", migrations[22], "0023_…")     ×3 支
 *   (c) 存在性檢查   migFiles.some((f) => f.startsWith("0024_"))            ×一堆
 *
 * 每加一支 migration，(a) 會在三個地方轉紅，作者去把 27 改成 28。那個「被叫回來」
 * 是**特性不是 bug**：它逼作者對每一個受保護的區域回答一次「0028 有沒有動到我
 * 這一區」。所以這個檔案的目的**不是**把它變成「改一個數字、八支全綠」——那會
 * 把強迫機制拆掉，而且沒有人會發現它被拆掉了。
 *
 * ── 舊機制真正壞在哪裡（這是動手改的理由）────────────────────────────────
 *
 * 1. **(b) 那三條在說謊，而且它們根本沒在強迫任何人。**
 *    `migrations[22] === "0023_fix_cron_guard.sql"` 斷言的是「0023 在第 23 個
 *    位置」。加了 0028 之後 0023 還是在第 23 個位置，所以這條**不會轉紅**。但它
 *    的標籤寫著「0023 是最後一支」，於是測試輸出會印出綠色的
 *    「✓ 0023 是最後一支」——而真正的最後一支是 0027。它們既沒有守門，還在騙
 *    讀者。這比維護負擔嚴重得多。
 *
 * 2. **作者的答覆寫在註解裡，沒有任何東西驗證它。**
 *    每一支自檢的 [1] 上面都有一大段散文：「0027 加了七個 jsonb 欄位、建
 *    event_blocks…它對 event_sessions 那一段是逐字照抄 0026 的，所以下面每一條
 *    斷言原樣成立」。那段散文才是真正的表態，但它是註解。作者少寫一句、寫錯一句、
 *    或整段複製上一期的，沒有任何機制會發現。
 *
 * ── 這個檔案怎麼在**消掉重複**的同時**把強迫機制加強** ──────────────────
 *
 * 把「回答」從八個「你沒動到我吧？」（淺、重複、寫在註解裡）換成一個
 * 「我動了什麼？」（深、只答一次、被機器驗證），再由機器把它路由到該看的自檢：
 *
 *   1. `MIGRATION_LEDGER` —— 每一支 migration 一列，附一行「它動了什麼」與一組
 *      **區域標籤**。這是作者唯一要回答的地方。新增 migration 而不補這一列，
 *      `assertLedgerMatchesDisk()` 就轉紅（在每一支引用它的自檢裡都轉紅）。
 *
 *   2. `assertLedgerDeclarationsHonest()` —— **反少報偵測器**。每個區域帶一組
 *      識別字（表名／函式名）。掃 migration 的 SQL（剝掉註解），只要提到某區域的
 *      識別字、而作者沒有標那個區域，就轉紅。所以「0028 我什麼都沒動」這種偷懶
 *      答案騙不過去。多標是安全的（只會叫更多支自檢回來看），少標會被抓。
 *      **這一條是整個設計的承重牆**：沒有它，帳本就只是一個沒人驗的宣告。
 *
 *   3. `assertMigrationDependencies()` —— 每支自檢宣告「我依賴哪幾個區域」與
 *      「我審到哪一支」。帳本裡只要出現一支「在我審過的之後、而且動到我依賴的
 *      區域」的 migration，那支自檢就轉紅，訊息直接寫出是哪一支動到哪一區。
 *      作者讀完那一區的斷言，把 reviewedThrough 往前推一格。
 *
 * ── 所以「強迫表態」保住了嗎 ─────────────────────────────────────────────
 *
 * 保住了，而且比原來強。逐項對照：
 *
 *   · **整片板子還是會亮紅。** 新增一支 migration 而沒補帳本 → 每一支引用
 *     `assertLedgerMatchesDisk()` 的自檢**全部轉紅**（跟以前一樣多），只是修法
 *     從「在 N 個地方各改一個數字」變成「在一個地方回答一次」。**紅燈的數量沒
 *     有減少，減少的只有機械性的編輯次數。**
 *   · **答覆從註解變成被驗證的資料。** 以前作者寫「0027 沒碰 email_outbox」是
 *     散文；現在他寫 `touches: [...]`，而偵測器會拿 SQL 對答案。
 *   · **問題從「是非題」變成「問答題」。** 以前八次「你沒動到我吧？」預設答案
 *     是「對，沒動到」，複製上一期的註解就過關；現在一次「你動了什麼？」沒有
 *     預設答案，而且答錯會被 SQL 打臉。
 *   · **路由是機器做的，所以不會漏。** 以前作者要自己記得「roster-csv 也在乎
 *     event_registrations」；漏掉一支就沒人看。現在只要標了
 *     `event_registrations`，所有依賴它的自檢自動轉紅。
 *
 * 唯一被放掉的是「動到完全無關的區域時，那幾支自檢也要作者去看一眼」。那個是
 * 真正的雜訊：作者去看，然後把數字改掉，沒有產生任何資訊。
 *
 * ── 這個檔案不做的事 ─────────────────────────────────────────────────────
 *
 * `touches` **必須是寫死在下面的字面值**，不可以改成「跑的時候從 SQL 算出來」。
 * 一算出來就沒有作者的宣告了，偵測器會變成拿自己的輸出跟自己比對——這個 repo
 * 出過六次的假陽性裡就有這一種（「測試自己先把要驗的東西修好了再驗」）。
 * 偵測器的角色是**拿 SQL 檢查作者寫下的字面值**，不是產生它。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 讀 migration 檔。**讀不到就丟例外**，不回空字串。
 * 理由與各支自檢的 readFile 相同，見 run-selftests.mjs 的「守門 4」：回空字串會讓
 * 所有「確認裡面沒有 X」的否定斷言靜默通過。
 */
const readSql = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(
      `migration-ledger 讀不到檔案：${p}（${err.code ?? err.message}）。` +
        "這裡刻意不回空字串 —— 回空字串會讓底下的識別字掃描永遠掃不到東西，" +
        "於是「這支 migration 沒動到任何區域」變成一個靜默通過的結論。",
    );
  }
};

/**
 * 區域。**每一個都必須有識別字**（`assertLedgerDeclarationsHonest` 會檢查這件事），
 * 因為只有帶識別字的區域才驗得起來——沒有識別字的區域等於「相信作者說的」，而這個
 * 檔案存在的理由就是不要再相信沒被驗證的宣告。
 *
 * 識別字的比對規則：
 *   · 在 migration 的 SQL 上比對，**只剝掉註解，不剝字串**。字串裡出現的識別字是
 *     算數的 —— 例如 0021 的 pii_access_log CHECK 裡寫著 `'inv.vendors'`，那代表
 *     這支 migration 確實在治理廠商 PII 的存取，不是巧合。
 *   · 前後帶 word boundary，所以 `orders` 不會誤中 `order_items`、`inv.` 不會誤中
 *     `invoice`。
 *   · 多標是安全的（叫更多支自檢回來看），少標會被偵測器抓到。設計上就偏向多標。
 *
 * `witness` 是**這一區的守門人**。它是一支「毫無疑問屬於這個區域」的 migration，
 * 由人手寫下來；`assertLedgerDeclarationsHonest()` 會確認這一區的識別字**真的**在
 * 那支檔案裡對得到。
 *
 * 為什麼需要它：識別字被改窄（例如把 "email_outbox" 打錯成 "email_outbx"，或有人
 * 為了消掉一個誤判把整組識別字砍到只剩一個罕見的字）之後，偵測器對這一區就永遠
 * 掃不到東西 —— 於是「這支 migration 沒碰 email_outbox」變成一個**靜默成立**的
 * 結論，而所有依賴 email_outbox 的自檢從此再也不會被叫回來。畫面上全綠。
 * 這正是這個 repo 出過六次的假陽性形狀（「斷言釘死單一路徑，程式碼搬家後靜默
 * 失去覆蓋」）的變體，所以要明著擋：只要識別字對不到自己的 witness，就轉紅。
 */
export const AREAS = Object.freeze({
  admin_auth: {
    witness: "0002_admin.sql",
    label: "後台身分與權限",
    identifiers: ["staff_permissions", "is_admin", "profiles"],
  },
  storage: {
    witness: "0003_storage_site_images.sql",
    label: "Storage bucket 與 policy",
    identifiers: ["storage.buckets", "site-images"],
  },
  cms: {
    witness: "0001_init.sql",
    label: "站台內容（頁面／展覽／刊物／講者）",
    identifiers: ["pages", "site_settings", "exhibitions", "publications", "artists"],
  },
  orders_payments: {
    witness: "0005_commerce_orders.sql",
    label: "訂單、付款與 webhook",
    identifiers: [
      "orders",
      "payments",
      "webhook_events",
      "payment_alerts",
      "order_post_payment_log",
    ],
  },
  order_expiry: {
    witness: "0006_order_expiry.sql",
    label: "未付款訂單過期與 order_items",
    identifiers: ["expire_unpaid_orders", "order_items"],
  },
  products_availability: {
    witness: "0004_commerce_products.sql",
    label: "商品主檔與可售量",
    identifiers: ["products", "product_availability"],
  },
  session_seats: {
    witness: "0020_event_sessions_registrations.sql",
    label: "場次名額與座位計數（0020 之前掛在 products，之後掛在 event_sessions）",
    identifiers: ["event_sessions", "reserve_session_seat", "release_session_seat", "seats_taken"],
  },
  event_registrations: {
    witness: "0020_event_sessions_registrations.sql",
    label: "逐位參加者",
    identifiers: ["event_registrations"],
  },
  roster_pii: {
    witness: "0021_roster_pii.sql",
    label: "名單遮罩、明文出口與 PII 存取紀錄",
    identifiers: ["admin_event_roster", "pii_access_log", "on_roster"],
  },
  email_outbox: {
    witness: "0022_email_outbox_notify.sql",
    label: "交易信 outbox 與通知函式",
    identifiers: [
      "email_outbox",
      "email_copy",
      "claim_order_notify",
      "notify_backlog",
      "dispatch_notify_task",
      "enqueue_registration_emails",
      "sessions_due_for_reminder",
    ],
  },
  cron_jobs: {
    witness: "0008_invoice_cron.sql",
    label: "pg_cron 排程",
    identifiers: ["cron.schedule", "cron.job", "to_regproc", "to_regprocedure"],
  },
  invoice: {
    witness: "0007_invoice_issue.sql",
    label: "電子發票",
    identifiers: ["invoices", "invoice_backlog", "claim_invoice_issue", "dispatch_invoice_task"],
  },
  inventory: {
    witness: "0009_inventory_schema.sql",
    label: "進銷存（inv schema）",
    identifiers: [
      "inv.",
      "inv_admin_products",
      "inventory_adjustments",
      "combo_set_items",
      "vendors",
    ],
  },
  events_shape: {
    witness: "0001_init.sql",
    label: "public.events 的欄位形狀與活動頁組裝",
    identifiers: ["public.events", "event_blocks", "admin_upsert_event_with_session", "speaker_id"],
  },
  localized_list: {
    witness: "0027_event_blocks.sql",
    label: "三語 jsonb 的形狀守衛（is_localized / is_localized_list）",
    // ⚠️ 這一區故意跟 events_shape 分開。三語形狀不是 events 的專利 —— 0004 的商品、
    //    0015 的刊物、0020 的場次都用同一個 is_localized() 守自己的 jsonb 欄位。
    //    掛進 events_shape 會逼著那幾支 migration 標上「碰了 events 的欄位形狀」，
    //    那是假的；分開之後兩邊的標籤都說實話。
    identifiers: ["is_localized", "is_localized_list"],
  },
  pos: {
    witness: "0014_pos_counter.sql",
    label: "門市 POS 櫃檯",
    identifiers: ["pos_checkout", "inv_pos_products", "inv_pos_sales", "inv_pos_payment_methods"],
  },
  session_plans: {
    witness: "0036_event_session_plans.sql",
    label: "場次內的多價格方案（票種）與它們自己的名額池",
    // ⚠️ 這一區故意跟 session_seats 分開，即使兩者這一期高度相關：session_seats
    //    數的是「位子」（event_sessions.seats_taken），這一區數的是「單位」
    //    （event_session_plans.units_taken）——0036 檔頭 §1 整段就是在講這兩個
    //    量為什麼不能混。分開兩個區域，才能讓「以後誰動了方案的名額」與「以後誰
    //    動了場次的座位」各自被正確的自檢叫回去，而不是永遠綁在一起被同一組
    //    斷言籠統覆蓋。
    identifiers: ["event_session_plans", "reserve_plan_units", "release_plan_units", "units_taken"],
  },
  // 沙龍的席位回覆自成一區，**不**掛進 event_registrations。
  //
  // 兩者長得像但不是同一件事：event_registrations 的每一列都掛著 order_id 與
  // order_item_id，是「這個位子是哪一張訂單買的」，seats_taken 只由 0020 的三支
  // 加鎖 RPC 維護；salon_rsvps 沒有訂單、沒有金額、沒有名額扣減，它是不收錢的
  // 審核邀請制回條，連「遺憾不克前往」都要存。
  //
  // 掛進去的話，動到 salon_rsvps 的 migration 會把六支盯著訂單／座位不變式的自檢
  // 全部叫回來重審一次它們根本不在乎的東西；反過來，動到 event_registrations 的
  // migration 也會誤觸這一區。分開之後兩邊的標籤都說實話——與上面 localized_list
  // 為什麼不掛進 events_shape 是同一個理由。
  salon_rsvp: {
    witness: "0037_salon_rsvp.sql",
    label: "沙龍席位回覆",
    identifiers: ["salon_rsvps"],
  },
  // 遠端 MCP server 的寫入稽核（0039）。獨立一區，理由與 salon_rsvp 相同：這張表跟
  // 任何既有區域都沒有關係（沒有外鍵、不被任何函式讀），掛進別區只會把不相干的自檢
  // 叫回來；反過來，日後動到它的 migration 會被路由回 mcp-selftest。
  mcp_audit: {
    witness: "0039_mcp_audit_log.sql",
    label: "MCP 寫入稽核",
    identifiers: ["mcp_audit_log"],
  },
  // 推薦碼與分潤（0040）。自成一區：推廣者、月結紀錄與全站分潤設定是新的一組事實，
  // 不掛進 orders_payments——0040 對 orders 只加了三個 nullable 歸屬欄位（那一部分
  // 它照樣標 orders_payments，由偵測器確認）。
  referrals: {
    witness: "0040_referral_program.sql",
    label: "推薦碼、推廣者與分潤月結",
    identifiers: ["referrers", "referral_settings", "referral_settlements"],
  },
  // 主理人的選品（curated_themes / curated_items）。0041 之前它沒有自己的區域——
  // 0001 建表、0002 的 admin_reorder_curated_items 之後就沒有任何 migration 再碰它，
  // 所以一直沒人需要被叫回來。0041 給 curated_items 加了 product_id（連到商品），
  // 首頁那一排與 /shop〈主理人的選品〉的「可不可以買」從此取決於這一欄，於是開一區，
  // 讓日後動到這兩張表的 migration 被路由回 curated-link-selftest。
  // 開區之後偵測器會回頭掃舊的 migration：0001（建表）、0002（reorder RPC）補標了
  // 這一區——那是實話，不是新的改動。
  curated: {
    witness: "0001_init.sql",
    label: "主理人的選品（主題與品項）",
    identifiers: ["curated_items", "curated_themes"],
  },
  // 異業合作收件匣（0042）。自成一區：與訂單、名單、交易信 outbox 都沒有關係（沒有外鍵、
  // 不被任何函式讀），只被 src/server/partnership.ts 與 /admin/partnerships 讀寫。
  partnership: {
    witness: "0042_partnership_inquiries.sql",
    label: "異業合作收件匣",
    identifiers: ["partnership_inquiries"],
  },
  // MCP OAuth 的狀態（0043）：授權鏈、用過的授權碼、每人的撤銷 epoch。與 mcp_audit 分開——
  // 稽核是「做了什麼」，這一區是「誰還能進來」；日後動到它的 migration 被路由回
  // mcp-oauth-selftest。
  mcp_oauth: {
    witness: "0043_mcp_oauth_state.sql",
    label: "MCP OAuth 授權鏈與撤銷",
    identifiers: ["mcp_oauth_grants", "mcp_oauth_used_codes", "mcp_oauth_user_epochs"],
  },
});

/**
 * 帳本。**一支 migration 一列，順序就是磁碟上的順序。**
 *
 * ⚠️ 新增 migration 時要做的唯一一件事：在最後面加一列，寫下
 *    `note`（一行「它動了什麼」）與 `touches`（它碰到的區域）。
 *    · 少寫一列 → `assertLedgerMatchesDisk()` 在每一支引用它的自檢轉紅。
 *    · `touches` 少標 → `assertLedgerDeclarationsHonest()` 轉紅並指名漏了哪一區。
 *    · 標到某支自檢依賴的區域 → 那支自檢轉紅，要你去重讀它的斷言。
 *
 * ⚠️ `touches` 是**作者的宣告**，不是掃描結果。不要改成執行時計算 —— 見檔頭最後
 *    一段。它可以（也應該）被偵測器打臉，但它必須先被人寫下來。
 */
export const MIGRATION_LEDGER = Object.freeze([
  {
    file: "0001_init.sql",
    note: "內容層初始 schema：pages / exhibitions / events / site_contents",
    // curated：0041 開區之後補標（0001 建了 curated_themes / curated_items）。
    touches: ["cms", "events_shape", "localized_list", "curated"],
  },
  {
    file: "0002_admin.sql",
    note: "/admin 後台需要的身分：profiles、role、is_admin()",
    // curated：0041 開區之後補標（0002 建了 admin_reorder_curated_items）。
    touches: ["admin_auth", "curated"],
  },
  {
    file: "0003_storage_site_images.sql",
    note: "site-images Storage bucket 與它的 policy",
    touches: ["storage"],
  },
  {
    file: "0004_commerce_products.sql",
    note: "商品主檔；名額（capacity/seats_taken）當時掛在 products 上",
    touches: ["products_availability", "session_seats", "localized_list"],
  },
  {
    file: "0005_commerce_orders.sql",
    note: "訂單、付款、發票、物流四張表",
    touches: [
      "orders_payments",
      "order_expiry",
      "products_availability",
      "invoice",
      "localized_list",
    ],
  },
  {
    file: "0006_order_expiry.sql",
    note: "沒人付款就把庫存與名額還回去（expire_unpaid_orders）",
    touches: ["orders_payments", "order_expiry", "products_availability", "session_seats"],
  },
  {
    file: "0007_invoice_issue.sql",
    note: "開發票的 claim-then-act 鎖與 invoice_backlog",
    touches: ["orders_payments", "invoice"],
  },
  {
    file: "0008_invoice_cron.sql",
    note: "把 /api/tasks/invoices 掛上 pg_cron",
    touches: ["cron_jobs", "invoice"],
  },
  {
    file: "0009_inventory_schema.sql",
    note: "進銷存 21 張表搬進 inv schema（由 scripts/rewrite-inv-schema.mjs 產生）",
    touches: ["admin_auth", "products_availability", "inventory"],
  },
  {
    file: "0010_inventory_identity.sql",
    note: "進銷存的三層權限接到 public.profiles",
    touches: ["admin_auth"],
  },
  {
    file: "0011_inventory_single_source.sql",
    note: "庫存單一真相：網站賣 inv 的實體庫存；重寫 product_availability 與過期回補",
    touches: [
      "orders_payments",
      "order_expiry",
      "products_availability",
      "session_seats",
      "inventory",
    ],
  },
  {
    file: "0012_inventory_listing_admin_views.sql",
    note: "上架頁需要的兩個唯讀 view",
    touches: ["products_availability", "inventory"],
  },
  {
    file: "0013_tighten_availability_grants.sql",
    note: "收緊 product_availability 對 anon / authenticated 的 grant",
    touches: ["products_availability"],
  },
  {
    file: "0014_pos_counter.sql",
    note: "門市櫃檯走同一條庫存路徑",
    touches: ["admin_auth", "orders_payments", "products_availability", "inventory", "pos"],
  },
  {
    file: "0015_publications.sql",
    note: "地方刊物展的 126 本刊物（獨立一張表）",
    touches: ["cms", "products_availability", "localized_list"],
  },
  {
    file: "0016_inventory_products_admin.sql",
    note: "商品主檔的 CRUD 與審核搬進後台",
    touches: ["admin_auth", "products_availability", "inventory"],
  },
  {
    file: "0017_inventory_purchases_adjustments.sql",
    note: "進貨、盤點、在庫異動搬進後台",
    touches: ["admin_auth", "products_availability", "inventory"],
  },
  {
    file: "0018_inventory_combos_secondhand.sql",
    note: "套餐、二手書，以及 OCR 的私有 bucket",
    touches: ["admin_auth", "storage", "products_availability", "inventory"],
  },
  {
    file: "0019_vendors_pii_portal.sql",
    note: "廠商主檔、PII 治理（pii_access_log）、廠商自助入口",
    touches: ["admin_auth", "storage", "cms", "products_availability", "roster_pii", "inventory"],
  },
  {
    file: "0020_event_sessions_registrations.sql",
    note: "名額從 products 搬到 event_sessions，並開始收逐位參加者",
    touches: [
      "orders_payments",
      "order_expiry",
      "products_availability",
      "session_seats",
      "event_registrations",
      "cron_jobs",
      "inventory",
      "localized_list",
    ],
  },
  {
    file: "0021_roster_pii.sql",
    note: "名單的遮罩 view、兩個會留痕的明文出口；順手重寫 inv.mask_email",
    touches: [
      "admin_auth",
      "orders_payments",
      "session_seats",
      "event_registrations",
      "roster_pii",
      "inventory",
    ],
  },
  {
    file: "0022_email_outbox_notify.sql",
    note: "交易信 outbox 與付款成功後的通知（只讀 0020 建的東西）",
    touches: [
      "orders_payments",
      "session_seats",
      "event_registrations",
      "roster_pii",
      "email_outbox",
      "cron_jobs",
      "localized_list",
    ],
  },
  {
    file: "0023_fix_cron_guard.sql",
    note: "修好 to_regproc 讓排程靜默不建立的守衛，並補建 dispatch-notify-task 與發票排程",
    // ⚠️ email_outbox / invoice 這兩個標籤是被 assertLedgerDeclarationsHonest() 逼出來的：
    //    這一列原本只標了 orders_payments / order_expiry / cron_jobs，偵測器指出 0023
    //    的 SQL 裡有 dispatch_notify_task 與 dispatch_invoice_task。它是對的 —— 0023
    //    的整個目的就是把那兩支被守衛靜默跳過的排程補建回來，那當然算碰到了通知與
    //    發票。這一列就是這個機制實際運作的樣子。
    touches: ["orders_payments", "order_expiry", "cron_jobs", "email_outbox", "invoice"],
  },
  {
    file: "0024_blackcat_payment.sql",
    note: "黑貓 PAY 線上刷卡：orders.payment_url、payments.gateway_trans_id、payment_alerts()",
    touches: ["orders_payments"],
  },
  {
    file: "0025_event_speaker.sql",
    note: "活動掛講者：public.events.speaker_id → public.artists.id（一欄一索引）",
    touches: ["cms", "events_shape"],
  },
  {
    file: "0026_event_product_link.sql",
    note: "活動與商品的真連結：events.slug / image_key、admin_upsert_event_with_session()",
    touches: ["products_availability", "session_seats", "events_shape", "localized_list"],
  },
  {
    file: "0027_event_blocks.sql",
    note: "活動頁組裝器的資料層：events 七個 jsonb 欄位、event_blocks、reorder RPC",
    touches: ["products_availability", "session_seats", "events_shape", "localized_list"],
  },
  {
    file: "0028_free_order_settlement.sql",
    note: "免費訂單（total = 0）在結帳當下就結清：settle_free_order()、payment_method 認 'free'、invoice_backlog 加 total > 0",
    // ⚠️ order_expiry / event_registrations / session_seats 這三個標籤是**語意上的**，
    //    不是偵測器逼出來的：0028 一個字都沒有重寫 expire_unpaid_orders()，
    //    event_registrations 與 event_sessions 也完全沒被 ALTER。但它改掉的正是
    //    「哪些訂單會被 expire_unpaid_orders() 撈到」——免費訂單從此不再是 pending，
    //    於是它們的 order_items 不會被刪、event_registrations 不會 cascade 消失、
    //    座位不會被還回去。守著那三個區域的自檢（event-registration / notify /
    //    roster-csv）必須為此回來重讀一次，而唯一能叫得動它們的辦法就是在這裡標上。
    //    這是刻意的多標；帳本的設計說多標是安全的方向，這一列就是那個方向的用途。
    touches: ["orders_payments", "order_expiry", "event_registrations", "session_seats", "invoice"],
  },
  {
    file: "0029_event_seats_visibility.sql",
    note: "「尚餘名額」逐場可關：events / products 各加一個 show_seats_remaining，兩個 trigger 讓兩邊不分岔，RPC 多讀一個 key",
    // ⚠️ session_seats 與 localized_list 這兩個標籤是**函式重建帶進來的**，不是這一支
    //    新動了名額或三語形狀：0029 用 create or replace 重建
    //    admin_upsert_event_with_session()，而那支函式的本體裡本來就寫著
    //    event_sessions 的 insert/update 與 is_localized() 的驗證。逐字照抄 0027 的
    //    那一份、只多了三處 show_seats_remaining（差異見 0029 §5 的說明）。
    //    標上它們是對的：任何依賴那兩區的自檢都該回來確認那份抄寫沒有走樣。
    touches: ["products_availability", "session_seats", "events_shape", "localized_list"],
  },
  {
    file: "0030_customer_accounts.sql",
    note: "客人帳號：claim_guest_orders() 把 customer_email 對得上、且還沒有主人的訪客訂單指給註冊後的 auth 帳號，加一支正規化 email 的 partial index",
    // ⚠️ 只標 orders_payments，而且那不是偷懶：這一支唯一寫到的表就是
    //    public.orders 的 user_id 欄位（0005:65 就存在、從來沒被寫過）。
    //    它沒有 ALTER 任何表、沒有重建任何既有函式、沒有碰 order_items、
    //    沒有碰 event_registrations / event_sessions，也沒有開任何 RLS policy
    //    或對 anon / authenticated 的 grant（0005:318-336 的姿態原樣保留）。
    //    偵測器掃得到的識別字也只有 orders 一個。
    touches: ["orders_payments"],
  },
  {
    file: "0031_event_gallery.sql",
    note: "活動相簿：events.gallery_keys text[]；admin_upsert_event_with_session() 多吃這個 key，並放寬 external_url 的「不可為空」（改成允許空字串，修好 5 場已清空外部連結的活動存不回去的 bug）",
    // ⚠️ events_shape / localized_list / products_availability / session_seats
    //    這四個標籤是**函式重建帶進來的**，跟 0026／0027／0029 同一個理由：
    //    admin_upsert_event_with_session() 用 create or replace 整支重寫，
    //    而它的本體裡本來就寫著 products 與 event_sessions 的 insert/update、
    //    is_localized() / is_localized_list() 的驗證——逐字照抄 0029 那一份，
    //    只多了 gallery_keys 與 external_url 兩處改動，兩者都在 events 那一段。
    //    講者（public.artists）**不在**這一支範圍：events.speaker_id 從 0025
    //    就指到 artists 了，這一支沒有加任何新欄位、沒有動 artists 一個字，
    //    所以不標 cms。
    touches: ["events_shape", "localized_list", "products_availability", "session_seats"],
  },
  {
    file: "0032_admin_order_notify.sql",
    note: "店家通知信：site_settings.notify_emails（收件人，逗號分隔）＋ enqueue_admin_order_email() 把摘要信排進既有的 email_outbox，沿用 claim_order_notify 的 claim 與 dedupe_key",
    // ⚠️ cms 標籤是 site_settings 帶進來的，而且這一支對它做的**不只是加欄位**：
    //    0001:484 對 anon / authenticated 是整張表的 blanket `grant select`，
    //    notify_emails 直接加進去等於店家信箱可以被任何人用公開的 anon key 從
    //    PostgREST 讀走。所以這一支把那筆 table-level select 收掉，改成逐欄
    //    列出的 column-level grant，刻意漏掉 notify_emails。
    //    → 日後**再往 site_settings 加任何欄位，都必須同時決定它進不進那份
    //      grant 清單**；漏掉的話前台會讀不到（PostgREST 直接 42501），
    //      多加的話就是把內部欄位公開出去。
    // ⚠️ orders_payments 是 enqueue_admin_order_email() 讀 public.orders 帶進來的
    //    （只讀，組信件摘要用）；它沒有 ALTER orders、沒有改任何既有的
    //    enqueue/claim 函式，客人那兩封信的路徑一個字都沒動。
    touches: ["cms", "orders_payments", "email_outbox"],
  },
  {
    file: "0033_admin_staff_management.sql",
    note: "後台人員管理頁的資料庫底座：profiles_keep_last_admin（保底至少一位 admin 的 AFTER STATEMENT trigger）＋ admin_update_profile_role／admin_replace_staff_permissions 兩支 RPC",
    // 識別字掃描結果只命中 admin_auth（staff_permissions、profiles 兩個識別字都對到）。
    // 沒有 alter 任何既有欄位、沒有重建任何既有函式，所以沒有「函式重建帶進來」
    // 那種借標；三個新物件（trigger 函式、trigger、兩支 RPC）名字全新，
    // 不會被任何既有識別字掃到，也不會誤觸其他區域。
    touches: ["admin_auth"],
  },
  {
    file: "0034_transfer_payment.sql",
    note: "匯款付款方式：orders.payment_method 多一個 'transfer'、orders 加 remittance_last5／remittance_reported_at、site_settings 加四個銀行欄位（刻意不進 anon 的 column-level grant）、email_copy 認得 'remittance' 並種四筆文案、admin_mark_order_paid()（手動核銷，保留原本的 payment_method），以及 expire_unpaid_orders() 只改一行 WHERE ——匯款訂單至少留 3 天",
    // ⚠️ 這一列的 touches 是**掃出來的**（拿 AREAS 的識別字對這一支剝過註解的 SQL），
    //    不是憑印象寫的。八個裡有三個值得說明它們為什麼在：
    //
    //    · products_availability（識別字 products）與 inventory（識別字 inv.）
    //      **是 expire_unpaid_orders() 的函式本體帶進來的**，跟 0026／0029／0031 對
    //      admin_upsert_event_with_session() 是同一種情況：這一支用 create or replace
    //      整支重寫它，而它的本體裡本來就寫著 public.products 的庫存還原（第 3、4 步）
    //      與 inv.products／stock_reservations 的保留列刪除（第 4b 步）。那兩段是
    //      0011／0020 那一份**逐字照抄**，一個字都沒改——但識別字確實在檔案裡，
    //      少標就是少報，所以標上。同理 session_seats 與 event_registrations 是
    //      第 4c 步帶進來的。
    //    · email_outbox（識別字 email_copy）是 §3 帶進來的：這一支動了
    //      email_copy_template_valid 這條 CHECK（多一個 'remittance'）並種了四筆
    //      文案。email_outbox 那張表與 0022 的每一支函式一個字都沒動。
    //    · cms（識別字 site_settings）與 0032 是同一個情況，而且要注意同一件事：
    //      0032 §0.2 把 anon/authenticated 的 SELECT 收成逐欄授權，而 column-level
    //      grant **不涵蓋日後新增的欄位**——所以這一支的四個銀行欄位天生就是 anon
    //      讀不到的，這裡刻意不去碰那份清單。0034 §1 結尾有一段 DO block 明著驗
    //      這件事（四欄可讀就 raise，並反向確認 short_desc 仍然可讀）。
    //
    //    唯一真正改變既有行為的是 order_expiry：expire_unpaid_orders() 的第 1 步
    //    claim 條件多了一個 case（payment_method = 'transfer' 時門檻取
    //    greatest(p_older_than, 3 days)）。簽章與 RETURNS TABLE 逐字未動——動了就
    //    得 drop function，而 drop 會斷掉正式庫上那支每 5 分鐘的 pg_cron。
    touches: [
      "cms",
      "orders_payments",
      "order_expiry",
      "products_availability",
      "session_seats",
      "event_registrations",
      "email_outbox",
      "inventory",
    ],
  },
  {
    file: "0035_admin_order_registration_cleanup.sql",
    note: "後台終於有地方可以刪資料：orders.archived_at（封存，nullable，部分索引）、admin_delete_order()（未付款／已取消的訂單真的刪，擋已付款與已進 inv.sales 兩種）、admin_archive_order()（已付款訂單的可逆替身，只設／清 archived_at）、admin_delete_registration()（名單單筆移除，seats_taken 自動還 1）。三支都 security definer + search_path='' + 只 grant service_role",
    // ⚠️ 這一列的 touches 是**用 AREAS 的識別字實際掃過這支剝過註解的 SQL 算出來
    //    的**（node 對 stripSqlComments() 之後的檔案內容逐區跑 identifierRe()），
    //    不是憑印象寫的；跑法留在交付回報裡。六個裡有兩個特別容易被少報：
    //
    //    · order_expiry（識別字 order_items）——admin_delete_order() 迴圈
    //      `select id from public.order_items where order_id = p_order_id` 來逐一
    //      呼叫 release_session_seat()，以及型錄庫存還原那段的
    //      `from public.order_items oi`。這支**沒有**重寫 expire_unpaid_orders()
    //      本人一個字，「order_expiry」這個標籤在這裡純粹是因為提到了
    //      order_items 這張表，不是因為動了過期回收的邏輯。
    //    · products_availability（識別字 products）——這是這支自己發現、任務書
    //      沒提到的第五個坑（見 migration §1.5）：goods/book 若沒連 inv，走的是
    //      `public.products.stock`，只在訂單還是 pending 時才需要跟著
    //      admin_delete_order() 一起還原，用 `if v_order.status = 'pending'`
    //      擋掉對已經被 expire_unpaid_orders() 處理過的訂單重複入帳。
    //
    //    其餘四個都直接對應到看得到的程式碼：orders_payments（alter table
    //    orders、三支函式都收 p_order_id 查 public.orders）、session_seats
    //    （event_sessions、release_session_seat、seats_taken 都在
    //    admin_delete_order() 與 admin_delete_registration() 裡出現）、
    //    event_registrations（admin_delete_registration() 直接 delete 那張表）、
    //    inventory（識別字 inv.——has_inventory_sale 那道閘查的是 inv.sales，
    //    release_inventory_reservations() 的呼叫則沒有把 "inv." 這個字面值帶進
    //    這支檔案，是前面那個查詢帶進來的）。
    //
    //    不在 touches 裡、但看起來像會中的兩個：roster_pii（識別字
    //    admin_event_roster／pii_access_log／on_roster）——這支完全沒有碰名單的
    //    遮罩或明文出口，UI 端的警示文案讀的是既有的 payment_status／on_roster
    //    欄位，SQL 這一層一個字都沒有新寫這三個識別字中的任何一個。admin_auth
    //    （識別字 staff_permissions／is_admin／profiles）——p_actor_id 只是原樣
    //    存進 raise log 的參數，SQL 本體完全沒有查 profiles 或
    //    staff_permissions；授權在 TS 那一層的 adminFnMiddleware 做，不在這支
    //    migration 裡。
    touches: [
      "orders_payments",
      "order_expiry",
      "products_availability",
      "session_seats",
      "event_registrations",
      "inventory",
    ],
  },
  {
    file: "0036_event_session_plans.sql",
    note: "一個場次可以開多個價格方案（票種）：新表 event_session_plans（單位計的名額池，seats_per_unit 讓一個單位佔多個座位）、order_items 加 plan_id／plan_title、新函式 reserve_plan_units()／release_plan_units()，並 create or replace release_session_seat() 與 expire_unpaid_orders()（RETURNS TABLE 形狀逐字不變）一併回沖 units_taken",
    // ⚠️ 這一列的 touches 是**用 AREAS 的識別字實際掃過這支剝過註解的 SQL 算出來
    //    的**（node -e 對 stripSqlComments() 之後的檔案內容逐區跑
    //    identifierRe()，做法與 0035 那一列相同），不是憑印象寫的。八個裡有五個
    //    值得說明它們為什麼在：
    //
    //    · session_plans（識別字 event_session_plans／reserve_plan_units／
    //      release_plan_units／units_taken）——這一支自己開的新區域，見 AREAS
    //      裡那一段「為什麼跟 session_seats 分開」。
    //    · session_seats（識別字 event_sessions／release_session_seat／
    //      seats_taken）——release_session_seat() 被 create or replace 整支
    //      重寫，本體裡本來就有這三個識別字；這一支**沒有**動 reserve_session_seat
    //      一個字（簽章與內部契約都不用改，見檔頭 §1），所以那個識別字不會被
    //      掃到，也確實沒在 touches 裡。
    //    · order_expiry（識別字 expire_unpaid_orders／order_items）——
    //      expire_unpaid_orders() 整支被 create or replace 重寫（新增第 4d
    //      步），release_session_seat() 也讀 order_items.plan_id／quantity。
    //    · orders_payments（識別字 orders／payments）、products_availability
    //      （識別字 products）、inventory（識別字 inv.）——都是
    //      expire_unpaid_orders() 函式本體帶進來的，跟 0026／0029／0031／0034
    //      對 admin_upsert_event_with_session() 或它自己是同一種情況：0034 那一份
    //      逐字照抄，這一支只多接了第 4d 步，前面幾步（給回型錄庫存、放掉進銷存
    //      保留、關掉付款嘗試）一個字沒改，但識別字確實在檔案裡，少標就是少報。
    //    · event_registrations（識別字 event_registrations）——同上，第 4c 步
    //      （0020 就有的）沒有被動過，但識別字仍在被重寫的函式本體裡。
    //    · localized_list（識別字 is_localized）——event_session_plans.title 的
    //      CHECK 用了 is_localized()，跟 event_sessions.title 同一條規則。
    //
    //    不在 touches 裡、但看起來像會中的兩個：events_shape（識別字
    //    public.events／event_blocks／admin_upsert_event_with_session／
    //    speaker_id）——這一支完全沒有碰 public.events 或那支 RPC，商品與活動的
    //    連結（0026）一個字沒動。cron_jobs（識別字 cron.schedule 等）——
    //    expire_unpaid_orders() 的排程是 0020 建的，這一支只改函式本體、沒有
    //    重新下 cron.schedule。
    touches: [
      "session_plans",
      "orders_payments",
      "order_expiry",
      "products_availability",
      "session_seats",
      "event_registrations",
      "inventory",
      "localized_list",
    ],
  },
  {
    file: "0037_salon_rsvp.sql",
    note: "城市思享沙龍的席位回覆：public.salon_rsvps（event_slug 純文字非 FK、attending yes/no、name/email 非空白 CHECK、(event_slug, created_at desc) 索引）。RLS 開著、零 policy、anon/authenticated 權限收回、只 grant service_role——與 event_registrations 同規格，因為整張表都是個資。不碰任何既有表、函式或約束",
    // ⚠️ touches 是**實際掃過剝掉註解的 SQL 算出來的**（用 AREAS 的識別字逐區跑
    //    identifierRe()，同 0035 那一列的做法），不是憑印象填的。結果是空的。
    //
    //    第一版不是空的：`comment on … is '…'` 裡寫了「與 event_registrations 無關」
    //    與「沒有對應的 public.events 列」，於是被判定成動到 event_registrations 與
    //    events_shape 兩區——偵測器剝掉的是 `--` 註解，**字串常值它照掃**。那兩句
    //    話會把九支依賴那兩區的自檢一起叫回來重審，而這支 migration 一個字都沒動
    //    那兩張表。解法是把說明搬回 `--` 區塊（migration §0），`comment on` 的字串
    //    只留不含識別字的敘述。這件事本身值得記著：**COMMENT ON 的內容算程式碼，
    //    不算註解。**
    //
    //    掃出來是空的，但帳本**不接受空的 touches**（那條斷言是對的：一支什麼區域
    //    都沒碰的 migration，多半是識別字漏了而不是真的無關）。這裡的處理不是去
    //    放寬那條斷言，而是承認 salon_rsvps 是一個新的區域，把它加進 AREAS ——
    //    這樣日後任何動到這張表的 migration 都會被路由回宣告依賴它的自檢，
    //    而不是靜靜地滑過去。
    touches: ["salon_rsvp"],
  },
  {
    file: "0038_drop_salon_rsvp.sql",
    note: "收掉 0037 建的 salon_rsvps。沙龍改走既有報名流程（price=0 的 event 商品 + 15 席場次 → 結帳 → event_registrations），名單直接進 /admin/registrations；那張自製的回條表沒有後台，只能下 SQL 看。表內從來沒有正式資料（上線只做過一次端到端驗證，當下就刪了），drop 之前 count=0，不做備份表",
    // 掃描結果就是 salon_rsvp 一個區域（識別字 salon_rsvps 出現在 drop 那一句）。
    // 這一區的 witness 仍然是 0037——witness 要的是「毫無疑問屬於這一區」的檔案，
    // 建表那一支比刪表這一支更適合當守門人，而且它還在磁碟上。
    touches: ["salon_rsvp"],
  },
  {
    file: "0039_mcp_audit_log.sql",
    note: "遠端 MCP server（/api/mcp）的寫入稽核：public.mcp_audit_log（identity id、tool／entity／entity_id／action／changes jsonb，actor_role CHECK 釘死 'mcp'、沒有 actor_id 也沒有外鍵）。RLS 開著零 policy、anon/authenticated 全收回、service_role 只有 select/insert（append-only）。不碰任何既有表、函式或約束",
    // touches 是實際掃過剝掉註解的 SQL 算出來的（同 0037 的做法）：只有 mcp_audit_log
    // 這個識別字。comment on 的字串刻意只寫不含其他區域識別字的敘述。
    touches: ["mcp_audit"],
  },
  {
    file: "0040_referral_program.sql",
    note: "推薦碼與分潤：新表 referrers（推廣者，團隊成員／外部推廣者）、referral_settings（單列全站預設：折扣、估算毛利率、累進分潤級距、新客倍率、團隊獎金池、發放上限、扣回天數）、referral_settlements（推廣者 × 月份唯一的結算紀錄與逐筆快照）；orders 只加三個 nullable 歸屬欄位 referrer_id／referral_code／referral_discount_percent 與一個部分索引，折扣金額沿用 0005 既有的 orders.discount。三張新表 RLS 開、零 policy、只 grant service_role",
    // touches 是用 AREAS 的識別字實際掃過剝掉註解的 SQL 算出來的（與 0036 那一列同一個
    // 做法）：orders_payments（識別字 orders —— alter table public.orders 與
    // references public.orders 的索引那兩段）、referrals（這一支自己開的區域）。
    // 沒有碰 order_items、products、event_sessions、email_outbox、invoices 或任何函式。
    touches: ["orders_payments", "referrals"],
  },
  {
    file: "0041_curated_item_product_link.sql",
    note: "主理人的選品連到真正的商品：curated_items 加 nullable product_id text（references public.products(id) on delete set null）與部分索引（where product_id is not null）。不加 unique（同一件商品可以出現在兩個主題櫥窗）；不碰 products 本身的欄位、函式、RLS 或 grant；curated_items 的 grant／RLS 沿用 0001",
    // touches 是用 AREAS 的識別字實際掃過剝掉註解的 SQL 算出來的：curated（alter table
    // public.curated_items 與 create index … on public.curated_items）、products_availability
    // （識別字 products —— references public.products 那一句）。這一支沒有 comment on。
    touches: ["curated", "products_availability"],
  },
  {
    file: "0042_partnership_inquiries.sql",
    note: "異業合作收件匣：新表 partnership_inquiries（類型／公司／聯絡人／Email／電話／官網／時間／預算／內容／語言／來源網址、status new→replied→archived、email_status pending/sent/failed、email_id、email_error、admin_note），CHECK 與 src/lib/partnership.ts 的值域與長度上限一致（message 下限放寬成 1，見檔頭）。RLS 開、零 policy、anon/authenticated 全收回、service_role 只有 select/insert/update/delete。另外 on conflict do nothing 種一列 pages('partnership')，內容與 /partnership 的內建後備逐字相同",
    // touches 是用 AREAS 的識別字實際掃過剝掉註解的 SQL 算出來的：partnership（這一支自己
    // 開的區域）、cms（識別字 pages —— insert into public.pages 那一句）。沒有 comment on。
    touches: ["cms", "partnership"],
  },
  {
    file: "0043_mcp_oauth_state.sql",
    note: "MCP OAuth 從無狀態升級：新表 mcp_oauth_grants（一次允許＝一條 refresh 鏈，current_refresh_jti 做輪替的 compare-and-swap、revoked_at／revoked_reason）、mcp_oauth_used_codes（用過的授權碼與升級前舊 refresh token 的 jti，主鍵擋重放）、mcp_oauth_user_epochs（每人一個撤銷 epoch）。三張表 RLS 開、零 policy、anon/authenticated 全收回、service_role 只有必要的權限。pg_cron 新增 ib_mcp_oauth_used_codes_purge（每天 03:17 清過期一天以上的已用授權碼），沒有 pg_cron 時只印 warning",
    // touches 是用 AREAS 的識別字實際掃過剝掉註解的 SQL 算出來的：mcp_oauth（這一支自己開的
    // 區域）、cron_jobs（cron.schedule 與 to_regprocedure）。auth.users 不屬於任何區域；沒有
    // comment on；沒有碰 mcp_audit_log、profiles 或任何既有表。
    touches: ["cron_jobs", "mcp_oauth"],
  },
]);

/** 磁碟上的 migration 檔名，排序過。空目錄 = 丟例外（那不是「沒有違規」）。 */
export function readMigrationFiles(migDir) {
  let files;
  try {
    files = readdirSync(migDir);
  } catch (err) {
    throw new Error(`migration-ledger 讀不到目錄：${migDir}（${err.code ?? err.message}）`);
  }
  const sql = files.filter((f) => f.endsWith(".sql")).sort();
  if (sql.length === 0) {
    throw new Error(
      `migration-ledger：${migDir} 底下一個 .sql 都沒有。` +
        "這裡刻意丟例外 —— 空清單會讓底下每一條「沒有任何一支違規」的斷言靜默通過。",
    );
  }
  return sql;
}

/** 識別字 → 正規表示式。頭尾是 word char 才補 boundary，所以 `inv.` 不會誤中 `invoice`。 */
function identifierRe(id) {
  const W = /[A-Za-z0-9_]/;
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pre = W.test(id[0]) ? "(?<![A-Za-z0-9_])" : "";
  const post = W.test(id[id.length - 1]) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(pre + esc + post, "i");
}

/**
 * 剝掉 SQL 註解。**不剝字串**——字串裡的識別字是算數的（見 AREAS 的說明）。
 * 剝註解是必要的：每一支 migration 的檔頭都在**說明**自己跟前幾支的關係，那些
 * 散文裡塞滿了別的區域的識別字，不剝的話每一支都會被標成碰了所有區域。
 */
function stripSqlComments(sql) {
  return (
    sql
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*--.*$/gm, " ")
      // `comment on <物件> is '…'` 的**字串內容**也算註解 —— 那是 SQL 自己的文件
      // 設施，裡面是散文。0016 就在一個 comment on view 的說明裡寫著「與
      // inv_pos_products 的差別是…」，那不是它碰了 POS。
      //
      // ⚠️ 只剝掉引號裡那一段，**保留前面的物件名**（`comment on function
      //    public.pos_checkout(...)` 這種才是真的訊號）。也只剝 comment on，別的
      //    字串一律保留 —— 0021 的 pii_access_log CHECK 裡寫著 'inv.vendors'，那是
      //    真的在治理廠商 PII，剝掉就漏了。
      .replace(/(\bcomment\s+on\b[\s\S]{0,400}?\bis\s+)'(?:[^']|'')*'/gi, "$1''")
  );
}

/** 剝過註解的 SQL，讀一次就記著（下面有好幾趟掃描要跑過全部 migration）。 */
const codeCache = new Map();
function migrationCode(migDir, file) {
  const key = join(migDir, file);
  if (!codeCache.has(key)) codeCache.set(key, stripSqlComments(readSql(key)));
  return codeCache.get(key);
}

/** 這支 migration 的 SQL 實際提到了哪些區域的識別字。 */
function areasMentionedIn(migDir, file) {
  const code = migrationCode(migDir, file);
  return Object.entries(AREAS)
    .filter(([, spec]) => spec.identifiers.some((id) => identifierRe(id).test(code)))
    .map(([area]) => area);
}

/**
 * 帳本與磁碟必須一一對應：同樣的檔、同樣的順序、編號從 0001 起連續不重複。
 *
 * 這一條取代了散在三支自檢裡的 `check("migrations 共 27 支", migrations.length, 27)`。
 * 它**比原來那條強**：原來只比對數量，這裡比對完整的有序檔名清單（少一支、多一支、
 * 改名、跳號、重號、順序不對，全都抓得到）。
 *
 * @param {(label: string, actual: unknown, expected: unknown) => void} check
 *   各支自檢自己的 check()。只用三個參數，所以四支自檢的不同簽名都吃得下。
 */
export function assertLedgerMatchesDisk(check, migDir) {
  const disk = readMigrationFiles(migDir);
  const ledger = MIGRATION_LEDGER.map((e) => e.file);

  const missing = ledger.filter((f) => !disk.includes(f));
  const extra = disk.filter((f) => !ledger.includes(f));
  if (extra.length > 0 || missing.length > 0) {
    console.log(
      `      → 帳本在 scripts/lib/migration-ledger.mjs 的 MIGRATION_LEDGER。\n` +
        `        新增 migration 時要在最後面補一列，寫下「它動了什麼」與它碰到的區域；\n` +
        `        少標區域會被 assertLedgerDeclarationsHonest() 抓到，標對了會自動把\n` +
        `        依賴那些區域的自檢叫回來重讀。這是這一整套唯一要人回答的地方。`,
    );
  }

  check(
    "磁碟上的 migration 全都在帳本裡（沒有人加了 migration 卻沒登記）",
    extra.join(",") || "（無）",
    "（無）",
  );
  check(
    "帳本裡的 migration 全都還在磁碟上（沒有人刪檔或改名）",
    missing.join(",") || "（無）",
    "（無）",
  );
  // ⚠️ 這裡刻意不寫成 `check(…, ledger.join(","), disk.join(","))`。那樣寫在失敗時
  //    會把兩份 28 個檔名的清單各印一次（兩行、每行一千多字），而真正的資訊只有
  //    「第幾個位置不一樣」。訊息要能行動，所以只報第一個對不上的位置。
  const len = Math.max(ledger.length, disk.length);
  let orderDiff = "（一致）";
  for (let i = 0; i < len; i += 1) {
    if (ledger[i] !== disk[i]) {
      orderDiff = `第 ${i + 1} 個位置：帳本是 ${ledger[i] ?? "（沒有了）"}，磁碟是 ${disk[i] ?? "（沒有了）"}`;
      break;
    }
  }
  check("帳本與磁碟的順序完全一致", orderDiff, "（一致）");

  const nums = disk.map((f) => Number(f.slice(0, 4)));
  check(
    "migration 編號從 0001 起連續、不重複",
    nums.join(","),
    nums.map((_, i) => i + 1).join(","),
  );

  const noteless = MIGRATION_LEDGER.filter((e) => !e.note || e.note.trim().length < 4);
  check(
    "帳本每一列都寫了「它動了什麼」",
    noteless.map((e) => e.file).join(",") || "（無）",
    "（無）",
  );

  const untagged = MIGRATION_LEDGER.filter(
    (e) => !Array.isArray(e.touches) || e.touches.length === 0,
  );
  check(
    "帳本每一列都至少標了一個區域",
    untagged.map((e) => e.file).join(",") || "（無）",
    "（無）",
  );

  const unknownArea = MIGRATION_LEDGER.flatMap((e) =>
    (e.touches ?? []).filter((a) => !(a in AREAS)).map((a) => `${e.file}:${a}`),
  );
  check(
    "帳本標的區域都是 AREAS 裡有定義的（擋打錯字）",
    unknownArea.join(",") || "（無）",
    "（無）",
  );
}

/**
 * **反少報偵測器。** 這是整套設計的承重牆。
 *
 * 帳本把「八支自檢各答一次『你沒動到我吧』」換成「作者在一個地方答一次『我動了
 * 什麼』」。這個交換只有在**那一個答案騙不過去**的時候才划算 —— 否則就是把八道
 * 淺的關卡換成一道可以隨便填的關卡，而且沒有人會發現。
 *
 * 所以：拿 migration 的 SQL 對答案。SQL 裡出現某區域的識別字、而作者沒標那個
 * 區域 → 紅。多標不罰（多標只會叫更多支自檢回來看，那是安全的方向）。
 */
export function assertLedgerDeclarationsHonest(check, migDir) {
  const disk = readMigrationFiles(migDir);

  // ── 先守偵測器自己 ──────────────────────────────────────────────────────
  // (1) 沒有識別字的區域是驗不起來的，等於「相信作者說的」。
  const unverifiable = Object.entries(AREAS)
    .filter(([, spec]) => !Array.isArray(spec.identifiers) || spec.identifiers.length === 0)
    .map(([area]) => area);
  check(
    "每個區域都有識別字（沒有識別字的區域驗不起來，等於沒在守）",
    unverifiable.join(",") || "（無）",
    "（無）",
  );

  // (2) **識別字真的對得到自己的 witness。** 光有識別字不夠 —— 識別字被改窄
  //     （打錯字、或為了消掉誤判被砍到剩一個罕見的字）之後，這一區的偵測就永遠
  //     空轉，而且是靜默的：從此每一支 migration 都被判定成「沒碰這一區」，依賴
  //     它的自檢再也不會被叫回來，畫面上全綠。witness 是人手寫的「這一支毫無疑問
  //     屬於這一區」，對不到就代表偵測器對這一區已經死了。
  const deadAreas = [];
  for (const [area, spec] of Object.entries(AREAS)) {
    if (!spec.witness) {
      deadAreas.push(`${area} 沒有指定 witness`);
      continue;
    }
    if (!disk.includes(spec.witness)) {
      deadAreas.push(`${area} 的 witness ${spec.witness} 不在磁碟上`);
      continue;
    }
    if (!areasMentionedIn(migDir, spec.witness).includes(area)) {
      deadAreas.push(`${area} 的識別字在 ${spec.witness} 裡一個都對不到`);
    }
  }
  if (deadAreas.length > 0) {
    console.log(
      "      → 這幾個區域的偵測已經空轉了：識別字對不到那支「毫無疑問屬於這一區」的\n" +
        "        migration，所以從現在起每一支新 migration 都會被判定成沒碰這一區，\n" +
        "        依賴它的自檢再也不會被叫回來。要修的是 AREAS 裡的識別字或 witness，\n" +
        "        不是把這條斷言拿掉。",
    );
  }
  check(
    "每個區域的識別字都對得到自己的 witness（擋偵測器空轉）",
    deadAreas.join("；") || "（無）",
    "（無）",
  );

  // (3) **每一個識別字都是活的。** witness 是區域層級的：只要同一區還有一個識別字
  //     活著，整區就過關 —— 所以「email_outbox 被打成 email_outbx，但同區的
  //     order_notify 還好好的」這種一半壞掉的情況騙得過 (2)。而它的後果是實打實的：
  //     日後一支只碰 email_outbox 這張表、沒碰 order_notify 的 migration 就掃不到了。
  //     這裡逐一驗：每個識別字都必須在 27 支 migration 裡至少對到一次。它們全都是
  //     這個 schema 裡真實存在的表名／函式名，對不到就代表被打錯或改窄了。
  const deadIdentifiers = [];
  for (const [area, spec] of Object.entries(AREAS)) {
    for (const id of spec.identifiers ?? []) {
      const re = identifierRe(id);
      if (!disk.some((f) => re.test(migrationCode(migDir, f)))) {
        deadIdentifiers.push(`${area}.${id}`);
      }
    }
  }
  if (deadIdentifiers.length > 0) {
    console.log(
      "      → 這幾個識別字在全部 migration 裡一次都沒對到。它們應該是這個 schema 裡\n" +
        "        真實存在的表名／函式名 —— 對不到就是被打錯或改窄了，而那會讓偵測器對\n" +
        "        那一塊靜默失去覆蓋。要新增一個目前還沒有人用到的識別字（例如先幫下一期\n" +
        "        的表名佔位），請連同它的第一支 migration 一起進來。",
    );
  }
  check(
    "每個識別字都至少對到一支 migration（擋識別字被改窄）",
    deadIdentifiers.join(",") || "（無）",
    "（無）",
  );

  const underDeclared = [];
  for (const entry of MIGRATION_LEDGER) {
    if (!disk.includes(entry.file)) continue; // 檔不在的情況由 assertLedgerMatchesDisk 報
    const mentioned = areasMentionedIn(migDir, entry.file);
    const declared = new Set(entry.touches ?? []);
    for (const area of mentioned) {
      if (!declared.has(area)) underDeclared.push(`${entry.file} 漏標 ${area}`);
    }
  }

  if (underDeclared.length > 0) {
    console.log(
      "      → SQL 裡提到了那個區域的識別字（表名／函式名），但帳本沒標。\n" +
        "        少標的代價是：依賴那個區域的自檢不會被叫回來，於是「有人動了我的東西」\n" +
        "        變成一件靜默發生的事。要嘛補上標籤，要嘛說明為什麼那個識別字出現在\n" +
        "        SQL 裡卻不算碰到（若真是誤判，改的是 AREAS 的識別字，不是拿掉標籤）。",
    );
  }
  check("帳本沒有少報：SQL 提到的區域都標了", underDeclared.join("；") || "（無）", "（無）");
}

/**
 * **強迫表態的那一條。** 每支自檢宣告：我依賴哪幾個區域、我審到哪一支。
 *
 * 帳本裡只要出現一支「排在 reviewedThrough 之後、而且動到 dependsOn 裡任何一個
 * 區域」的 migration，這條就轉紅，並指名是哪一支動到哪一區。作者去重讀那一段
 * 斷言，確認它們在新的 migration 之後仍然成立，然後把 reviewedThrough 推一格。
 *
 * 這一條**不會**因為「migration 總數變了」而轉紅 —— 那是 assertLedgerMatchesDisk
 * 的工作，而且那條已經在每一支自檢裡都會紅了。這一條回答的是更難的問題：
 * 「新來的那一支，動的是不是我在乎的東西。」
 *
 * ── ⚠️ dependsOn 少寫一個區域，是這整套設計唯一會靜默失去覆蓋的地方 ────────
 *
 * 底下的檢查擋得住：區域名打錯（比對 AREAS）、空清單、reviewedThrough 指到不存在
 * 的檔。但它擋不住「這支自檢其實也在乎 event_registrations，作者卻沒寫進 dependsOn」
 * —— 那樣的話動到 event_registrations 的 migration 不會叫它回來，而畫面是綠的。
 *
 * 沒有把這件事做成自動斷言，是刻意的：能想到的自動版本（掃自檢原始碼裡出現的區域
 * 識別字）誤判太多 —— PG 測試 harness 裡 `create table storage.buckets`、seed 資料裡
 * 的 `insert into public.products` 都會中，於是每一支都要配一份「這些不算」的例外
 * 清單，而那份清單就是下一個可以偷偷藏東西的地方。與其做一個帶逃生門的守衛，不如
 * 把程序寫下來。
 *
 * **改了自檢的斷言、或新開一支自檢時，用這個程序重新核對 dependsOn：**
 *
 *   1. 把自檢原始碼剝掉 JS 註解（保留字串 —— 斷言就寫在字串裡）。
 *   2. 對每一個 AREAS 的識別字做一次比對，列出「出現了但沒宣告」的區域。
 *   3. 逐個判斷：它出現在**斷言**裡（要宣告），還是只出現在**測試 harness／seed
 *      資料**裡（不用宣告 —— 那一類壞掉是會炸的，不是靜默的）。
 *
 * 目前這五支的清單就是這樣核出來的。第一版漏了好幾個（notify 漏了
 * event_registrations 與 roster_pii、roster-csv 漏了 inventory —— 0021 重寫了
 * inv.mask_email()、event-registration 漏了 orders_payments），跑一次上面的程序
 * 才抓出來。
 *
 * @param {(label, actual, expected) => void} check 各支自檢自己的 check()
 * @param {string} migDir supabase/migrations 的絕對路徑
 * @param {{suite: string, dependsOn: string[], reviewedThrough: string}} decl
 */
export function assertMigrationDependencies(check, migDir, decl) {
  const { suite, dependsOn, reviewedThrough } = decl;

  // ── 先守宣告本身 ────────────────────────────────────────────────────────
  // 打錯的區域名永遠比對不到任何 migration，於是這一支自檢從此再也不會被叫回來，
  // 而且畫面上是綠的。這正是這個 repo 出過六次的假陽性形狀，所以要明著擋。
  const badAreas = (dependsOn ?? []).filter((a) => !(a in AREAS));
  check(`${suite}：宣告依賴的區域都存在（擋打錯字）`, badAreas.join(",") || "（無）", "（無）");
  check(`${suite}：有宣告依賴的區域（空清單＝沒在守任何東西）`, (dependsOn ?? []).length > 0, true);

  const reviewedIdx = MIGRATION_LEDGER.findIndex((e) => e.file === reviewedThrough);
  check(
    `${suite}：reviewedThrough 指到帳本裡真的有的 migration`,
    reviewedIdx === -1 ? `找不到 ${reviewedThrough}` : "（有）",
    "（有）",
  );
  if (reviewedIdx === -1) return;

  // 順手確認那一支真的在磁碟上（帳本與磁碟脫節時，上面那條會另外報）。
  const disk = readMigrationFiles(migDir);
  check(
    `${suite}：審到的那一支 ${reviewedThrough} 還在磁碟上`,
    disk.includes(reviewedThrough),
    true,
  );

  // ── 正題 ────────────────────────────────────────────────────────────────
  const watched = new Set(dependsOn);
  const needsReview = MIGRATION_LEDGER.slice(reviewedIdx + 1)
    .map((e) => {
      const hit = (e.touches ?? []).filter((a) => watched.has(a));
      return hit.length > 0 ? `${e.file} 動到 ${hit.join("/")}` : null;
    })
    .filter(Boolean);

  if (needsReview.length > 0) {
    console.log(
      `      → 這幾支 migration 動到了 ${suite} 依賴的區域，但它宣告只審到 ${reviewedThrough}。\n` +
        "        請重讀這支自檢底下的斷言，確認它們在那幾支 migration 之後仍然成立\n" +
        "        （不是「看起來還在」，是逐條確認語意沒被改掉），然後把這支自檢的\n" +
        "        reviewedThrough 推到最新的那一支。若確認之後發現斷言真的失守，要修的\n" +
        "        是斷言，不是 reviewedThrough。",
    );
  }
  check(
    `${suite}：已審過的 ${reviewedThrough} 之後，沒有 migration 動到它依賴的區域`,
    needsReview.join("；") || "（無）",
    "（無）",
  );
}
