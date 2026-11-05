/**
 * MCP 工具 —— 讓 AI **做**後台的日常營運動作（階段 B）：訂單出貨／標記收款、電話報名、移除報名、
 * 策旅意願單與合作邀約的處理狀態、在庫異動／盤點／進貨，以及介面文字與網站設定。
 *
 * ── 一條規矩：寫入只走後台已經在用的那一支 ───────────────────────────────
 * 每一支寫入都呼叫 src/lib/admin/fns/* 背後那一支 repo 函式（src/server/repos/*），
 * 多數是加鎖的 RPC。這裡**沒有任何一句自己寫的 update／insert／delete**——狀態機、名額、
 * 審核流程、FIFO 全部在原本那一層。這個檔案自己只做三件事：
 *   1. 讀「改前」的狀態（只 select 列出來的欄位），算出「改前 → 改後」給 AI 看；
 *   2. 用後台**同一份** zod 規則（src/lib/admin/schemas.ts、phone-order.ts）驗輸入；
 *   3. dry_run=false 才呼叫 repo，並且預覽與寫入都記 mcp_audit_log（dry_run 照實帶）。
 *
 * ── 預設只是預覽 ───────────────────────────────────────────────────────────
 * 每一支寫入的 dry_run 預設 true：只回「會改什麼」，不呼叫任何寫入的 repo。確認後用同一組
 * 參數加 dry_run=false 再呼叫一次才會寫。讀寫權限（唯讀連線擋寫入，含預覽）由 tools.ts 的
 * add() 依 annotations.readOnlyHint 自動擋，這裡不重複。
 *
 * ── 操作人員（actor）──────────────────────────────────────────────────────
 * 後台的 server fn 一律用 context.admin.userId 當 p_actor_id／p_user_id。MCP 這邊用
 * currentMcpActor() 的 OAuth user_id（那位授權的 admin）。靜態 MCP_TOKEN 沒有對應的使用者：
 *   · RPC 接受 null 的（admin_mark_order_paid、admin_delete_registration）→ 傳 null，
 *     「是誰」照樣記在 mcp_audit_log（actor_via=static_token）；
 *   · RPC 拒絕 null 的（電話報名 0051、進銷存 inv_* 0017：「必須記錄操作人員」）→ 這裡直接
 *     拒絕並說明「需要 OAuth 管理員身分」，不送一個假 UUID 進去。
 *   · 出貨（advanceOrderFulfillment）的 actorId 只進伺服器 log，靜態 token 記 "mcp:static_token"。
 *
 * ── 寄信不在這一階段 ───────────────────────────────────────────────────────
 * 後台按鈕在「標記已收款」之後會立刻排付款成功通知、「標記已出貨」之後會排出貨通知。這裡**不**
 * 呼叫 src/server/notify.ts（寄信是另一個階段）。付款成功那批信由既有的 notify_backlog 排程
 * 補排（已付款、還沒排過通知的訂單）；出貨通知信 MCP 不寄，工具回應會講明。電話報名的
 * createOrder() 內建的「待收款」信照既有流程（那是 createOrder 本人的行為，不是這裡加的）。
 *
 * ── 不做的東西 ─────────────────────────────────────────────────────────────
 * 員工帳號、權限、MCP 連線祕密、金流金鑰、退款、發票。網站設定只開放非祕密欄位：匯款帳戶
 * （bank_*）不讀不寫；notify_emails 可讀不可寫。物流單號、訂單「需專人聯繫」與訂單內部備註、
 * 報名改人數、報到——後台沒有寫入路徑（或 schema 沒有欄位），這裡也不自建。
 *
 * ── 稽核與個資 ─────────────────────────────────────────────────────────────
 * mcp_audit_log 的 changes 也會印進 server log。訂購人／參加者的姓名、電話、Email 不進稽核：
 * 聯絡資料只記「改了哪幾個欄位」（同 0051 order_contact_edit_log 的立場），報名移除只記
 * 姓名首字（同 0044 registration_removal_log）。
 * 例外：update_registration_participant（業主 2026-11-05 要求記前後值）——前後值存進
 * mcp_audit_log，但用 changes._log_redact 讓伺服器 log 只印欄位名（audit.ts）。
 *
 * repos 一律在 handler 裡 dynamic import（同 tools.ts／admin-read-tools.ts），這個模組載入時
 * 不碰 Supabase。
 */
import { randomUUID } from "node:crypto";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { z as z3 } from "zod";
import { z } from "zod4";
import {
  errText,
  jsonText,
  McpInputError,
  stableStringify,
  zodIssuesText,
  type TextResult,
} from "./core";
import { INV_ADJUSTMENT_CATEGORIES, INV_ADJUSTMENT_REASONS } from "@/lib/admin/schemas";
import { WISH_STATUSES } from "@/lib/journey-wish-inbox";
import { INQUIRY_STATUSES } from "@/lib/partnership-inbox";
import { INVOICE_TYPES } from "@/lib/invoice-format";

/* ------------------------------------------------------------------ annotations */

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/* ------------------------------------------------------------------ 共用 arg */

const dryRunArg = z
  .boolean()
  .default(true)
  .describe(
    "預設 true：只回傳會改什麼，不寫入。確認後用同樣參數加 dry_run=false 再呼叫一次才會寫入。",
  );

const uuidArg = (what: string) => z.string().trim().uuid().describe(what);
const dateArg = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式是 YYYY-MM-DD")
    .describe(`${what}（YYYY-MM-DD，台北日期）`);

const orderRef = {
  order_id: z.string().trim().uuid().optional().describe("orders.id（UUID）"),
  order_no: z.string().trim().min(1).max(40).optional().describe("訂單編號（與 order_id 二選一）"),
};
const oneOrderRef = (v: { order_id?: string; order_no?: string }) =>
  Boolean(v.order_id) !== Boolean(v.order_no);
const ONE_ORDER_REF_MSG = "order_id 與 order_no 要給其中一個";

/** 三語欄位的部分更新：一段中文（只改 zh），或 {zh?, en?, ja?}（沒給的語言保留原值）。 */
const localizedPatchArg = (what: string) =>
  z
    .union([
      z.string().trim().min(1).max(5000),
      z
        .object({
          zh: z.string().trim().min(1).max(5000).optional(),
          en: z.string().trim().min(1).max(5000).optional(),
          ja: z.string().trim().min(1).max(5000).optional(),
        })
        .refine((v) => v.zh || v.en || v.ja, "至少給一種語言"),
    ])
    .describe(`${what}：一段中文（只改中文），或 {zh?, en?, ja?}；沒給的語言保留原值`);

const contactName = z.string().trim().max(60);
const contactEmail = z.string().trim().max(120);
const contactPhone = z.string().trim().max(30);

/* ------------------------------------------------------------------ 網站設定欄位 */

/** 三語的網站設定欄位。 */
const SETTINGS_LOCALIZED = ["short_desc", "address", "city", "hours", "closed"] as const;
/** 純文字的網站設定欄位（可寫）。 */
const SETTINGS_TEXT = [
  "contact_email",
  "site_url",
  "social_instagram",
  "social_facebook",
  "social_line",
  "map_embed",
  "map_link",
  "map_apple",
  "meta_site_name",
  "meta_author",
  "meta_twitter_card",
  "meta_og_type",
  "default_meta_title",
  "default_meta_description",
] as const;
/** get_site_settings 回的欄位：可寫的全部＋notify_emails（只讀）＋updated_at。bank_* 永遠不回。 */
const SETTINGS_READABLE = [...SETTINGS_LOCALIZED, ...SETTINGS_TEXT, "notify_emails"] as const;

/* ------------------------------------------------------------------ 輸入 schema */

/** 會建立新列的寫入工具：dry_run=false 時必填（審查 2026-11-03）。預覽會產生一組。 */
const idempotencyKeyArg = z
  .string()
  .trim()
  .uuid()
  .optional()
  .describe(
    "防重複送出的 UUID。dry_run=false 時必填：先用 dry_run=true 預覽取得一組，正式送出帶同一組；同一組只會建立一次。",
  );

/**
 * dry_run=false 的建立動作：idempotency_key 必填，並在送出前佔用它（重用 OAuth 的一次性表
 * mcp_oauth_used_codes，30 天）。同一組 key 第二次送出 → 拒絕，不會建出第二筆。
 * 先佔再寫：寫入失敗之後同一組 key 也不能再用——訊息請 AI 先查清單確認，再用新的 key。
 */
async function claimIdempotencyKey(tool: string, key: string | undefined): Promise<void> {
  if (!key) {
    throw new McpInputError(
      "dry_run=false 時 idempotency_key 必填：先用 dry_run=true 預覽取得一組，正式送出時帶同一組。",
    );
  }
  const { dbOAuthStore } = await import("./oauth-store");
  // jti 上限 80 字：idem:＋工具名（≤24）＋UUID（36）。
  const ok = await dbOAuthStore.consumeOnce(
    `idem:${tool}:${key.toLowerCase()}`,
    Math.floor(Date.now() / 1000) + 30 * 86400,
  );
  if (!ok) {
    throw new McpInputError(
      `這組 idempotency_key 已經送出過（${tool}），可能已建立或上次失敗。請先查清單確認；確定沒有建立，再預覽取得新的一組。`,
    );
  }
}

export const OPS_WRITE_TOOL_INPUTS = {
  /* ---- 訂單 ---- */
  update_order_fulfillment: z
    .object({
      ...orderRef,
      action: z
        .enum(["ship", "pickup", "complete"])
        .describe(
          "ship 標記已出貨（處理中→已出貨，宅配／超商）／pickup 標記已取貨（處理中→已完成，門市自取）／" +
            "complete 標記已完成（已出貨→已完成）。只限已付款的訂單，與後台訂單內頁那顆按鈕同一條件。",
        ),
      dry_run: dryRunArg,
    })
    .refine(oneOrderRef, ONE_ORDER_REF_MSG),
  mark_order_paid: z
    .object({
      ...orderRef,
      note: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("備註，例如「對到 9/3 01:15 那筆」（存進付款紀錄）"),
      dry_run: dryRunArg,
    })
    .refine(oneOrderRef, ONE_ORDER_REF_MSG),

  /* ---- 電話報名 ---- */
  list_phone_order_options: z.object({
    keyword: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("用活動／策旅名稱篩選（中文名稱包含這段字）"),
  }),
  create_phone_order: z.object({
    customer_name: contactName.min(1).describe("訂購人姓名（必填）"),
    customer_email: contactEmail.optional().describe("訂購人 Email（手機與 Email 至少一項）"),
    customer_phone: contactPhone.optional().describe("訂購人手機，09 開頭 10 碼"),
    product_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("活動／策旅商品 id（見 list_phone_order_options）"),
    session_id: uuidArg("場次 id（見 list_phone_order_options）"),
    plan_id: z
      .string()
      .trim()
      .uuid()
      .optional()
      .describe("票種 id；這一場有票種時必填，沒有票種時省略"),
    quantity: z.number().int().min(1).max(99).describe("人數（票數）"),
    participants: z
      .array(
        z.object({
          name: contactName.optional(),
          email: contactEmail.optional(),
          phone: contactPhone.optional(),
        }),
      )
      .max(99)
      .optional()
      .describe(
        "參加者（可省略）。數量要等於座位數（人數 × 票種每單位座位數）；省略或姓名留空時，" +
          "第 1 位帶訂購人姓名、其餘帶「訂購人姓名 同行者 N」。",
      ),
    invoice: z
      .object({
        type: z.enum(INVOICE_TYPES).default("personal"),
        tax_id: z.string().trim().max(20).optional().describe("統一編號（type=company）"),
        company_title: z.string().trim().max(60).optional(),
        carrier_type: z.string().trim().max(20).optional(),
        carrier_number: z.string().trim().max(64).optional(),
        love_code: z.string().trim().max(7).optional().describe("捐贈碼（type=donate）"),
      })
      .optional()
      .describe("發票資料，省略＝個人雲端發票"),
    admin_note: z.string().trim().max(1000).optional().describe("內部備註（客人看不到）"),
    price_override: z
      .object({
        amount: z.number().int().min(0).describe("改後總金額（只能改低）"),
        reason: z.string().trim().min(1).max(200).describe("改價原因"),
      })
      .optional()
      .describe("手動改價；省略＝照票種算"),
    payment_status: z
      .enum(["paid", "unpaid"])
      .describe("paid 已收到匯款（建單後立刻標記已收款）／unpaid 尚未收到"),
    paid_on: dateArg("匯款日期（payment_status=paid 時必填）").optional(),
    last5: z
      .string()
      .trim()
      .regex(/^\d{5}$/, "帳號末五碼是 5 個數字")
      .optional()
      .describe("匯款帳號末五碼（選填）"),
    notify_customer: z
      .boolean()
      .default(false)
      .describe("寄報名成功信給客人（預設 false；需要訂購人 Email）"),
    idempotency_key: z
      .string()
      .trim()
      .uuid()
      .optional()
      .describe("防重複送出的 UUID。預覽會產生一個，正式送出時請帶同一個。"),
    dry_run: dryRunArg,
  }),
  update_phone_order_contacts: z.object({
    order_id: uuidArg("電話報名訂單的 orders.id"),
    customer: z
      .object({
        name: contactName.min(1).optional(),
        email: contactEmail.optional().describe("空字串＝清空"),
        phone: contactPhone.optional().describe("空字串＝清空"),
      })
      .optional()
      .describe("訂購人；只給要改的欄位"),
    participants: z
      .array(
        z.object({
          id: uuidArg("參加者 registration_id（見 get_order 的參加者）"),
          name: contactName.min(1).optional(),
          email: contactEmail.optional().describe("空字串＝清空"),
          phone: contactPhone.optional().describe("空字串＝清空"),
        }),
      )
      .max(99)
      .optional()
      .describe("要改的參加者；只給要改的人與欄位"),
    dry_run: dryRunArg,
  }),

  /* ---- 報名 ---- */
  remove_registration: z.object({
    session_id: uuidArg("場次 id（見 list_registrations／get_session_roster）"),
    registration_id: uuidArg("參加者 registration_id（見 get_session_roster）"),
    dry_run: dryRunArg,
  }),

  update_registration_participant: z
    .object({
      registration_id: z
        .string()
        .trim()
        .uuid()
        .optional()
        .describe(
          "參加者 registration_id（見 get_session_roster）。與 order_no＋current_name 二選一",
        ),
      order_no: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .optional()
        .describe("訂單編號；沒有 registration_id 時，與 current_name 一起定位這位參加者"),
      current_name: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "名單上目前的姓名（與 order_no 一起用；同一張單同名多位時請改給 registration_id）",
        ),
      session_id: z
        .string()
        .trim()
        .uuid()
        .optional()
        .describe("場次 id（選填；有給就必須對得上，避免改到別場的人）"),
      expected: z
        .object({
          name: z.string().max(1000),
          email: z.string().max(1000).nullable(),
          phone: z.string().max(1000).nullable(),
        })
        .optional()
        .describe(
          "預覽回傳的 expected（改前原值），dry_run=false 時必填：送出時資料庫現值跟它不同" +
            "（別人在預覽之後改過）就拒絕，不會把別人改的值蓋回去",
        ),
      name: z.string().max(200).optional().describe("新的姓名（換人時給）"),
      email: z.string().max(400).optional().describe("新的 Email；空字串＝清空"),
      phone: z
        .string()
        .max(100)
        .optional()
        .describe("新的電話（數字、空白與 + ( ) - #）；空字串＝清空"),
      idempotency_key: idempotencyKeyArg,
      dry_run: dryRunArg,
    })
    .refine(
      (v) => Boolean(v.registration_id) !== Boolean(v.order_no && v.current_name),
      "registration_id 與（order_no＋current_name）要給其中一組",
    )
    .refine(
      (v) => v.name !== undefined || v.email !== undefined || v.phone !== undefined,
      "name、email、phone 至少給一個要改的欄位",
    ),

  /* ---- 意願單、合作邀約 ---- */
  update_journey_wish: z
    .object({
      id: uuidArg("journey_wishes.id"),
      status: z
        .enum(WISH_STATUSES)
        .optional()
        .describe("new 未處理／reviewed 已看過／archived 封存"),
      admin_note: z.string().max(2000).optional().describe("內部備註（整段取代，空字串＝清空）"),
      dry_run: dryRunArg,
    })
    .refine(
      (v) => v.status !== undefined || v.admin_note !== undefined,
      "status 與 admin_note 至少給一個",
    ),
  update_partnership_inquiry: z
    .object({
      id: uuidArg("partnership_inquiries.id"),
      status: z
        .enum(INQUIRY_STATUSES)
        .optional()
        .describe("new 未處理／replied 已回覆／archived 封存"),
      admin_note: z.string().max(2000).optional().describe("內部備註（整段取代，空字串＝清空）"),
      dry_run: dryRunArg,
    })
    .refine(
      (v) => v.status !== undefined || v.admin_note !== undefined,
      "status 與 admin_note 至少給一個",
    ),

  /* ---- 進銷存 ---- */
  create_stock_adjustment: z.object({
    product_id: uuidArg("進銷存商品 id（見 list_inventory）"),
    category: z
      .enum(INV_ADJUSTMENT_CATEGORIES)
      .describe(
        "EXP 報廢損耗／PR 公關贈送／SMP 樣品領用／INT 內部領用／ADJ 盤點調整／CMB 商品組合調整",
      ),
    quantity: z
      .number()
      .int()
      .refine((v) => v !== 0, "異動數量不可為 0")
      .refine((v) => Math.abs(v) <= 1_000_000, "數量太大了")
      .describe("異動數量：負數＝出庫（扣庫存），正數＝入庫"),
    reason: z
      .enum(INV_ADJUSTMENT_REASONS)
      .optional()
      .describe("原因：loss／damage／count_error／return／sample／other"),
    notes: z.string().trim().max(2000).optional(),
    adjustment_date: dateArg("異動日期，省略＝今天").optional(),
    submit: z
      .boolean()
      .default(true)
      .describe("true 送出（要不要進待審由資料庫的審核設定決定）／false 存成草稿"),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
  record_stock_count: z.object({
    rows: z
      .array(
        z.object({
          product_id: uuidArg("進銷存商品 id"),
          actual_quantity: z.number().int().min(0).describe("實際盤點數量（不是差異）"),
        }),
      )
      .min(1)
      .max(100)
      .describe("盤點結果，一次最多 100 件。差異由資料庫用送出當下的庫存算，差異 0 的會跳過。"),
    reason: z.enum(INV_ADJUSTMENT_REASONS).describe("差異原因"),
    notes: z.string().trim().max(2000).optional(),
    adjustment_date: dateArg("盤點日期，省略＝今天").optional(),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
  create_purchase: z.object({
    product_id: uuidArg("進銷存商品 id（見 list_inventory）"),
    quantity: z.number().int().min(1).max(1_000_000).describe("進貨數量"),
    unit_cost: z.number().min(0).optional().describe("單位成本（元）"),
    purchase_date: dateArg("進貨日期，省略＝今天").optional(),
    item_name: z.string().trim().max(200).optional().describe("進貨品名（省略＝用商品名稱）"),
    vendor_id: z.string().trim().uuid().optional().describe("供應商 id（見 list_vendors）"),
    vendor: z.string().trim().max(200).optional().describe("供應商名稱（沒有 vendor_id 時）"),
    publisher: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(2000).optional(),
    expiry_date: dateArg("有效期限").optional(),
    expiry_alert_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("到期前幾天警示（預設 7）"),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),

  /* ---- 文案與設定 ---- */
  get_ui_strings: z.object({
    group_key: z.string().trim().min(1).max(100).optional().describe("只看某一組"),
  }),
  update_ui_string: z.object({
    group_key: z.string().trim().min(1).max(100).describe("get_ui_strings 列出的 group_key"),
    string_key: z.string().trim().min(1).max(100).describe("get_ui_strings 列出的 string_key"),
    value: localizedPatchArg("新文字").optional(),
    sort_order: z.number().int().min(-100000).max(100000).optional(),
    dry_run: dryRunArg,
  }),
  get_site_settings: z.object({}),
  update_site_settings: z
    .object({
      short_desc: localizedPatchArg("店家簡介").optional(),
      address: localizedPatchArg("地址").optional(),
      city: localizedPatchArg("城市").optional(),
      hours: localizedPatchArg("營業時間").optional(),
      closed: localizedPatchArg("公休說明").optional(),
      contact_email: z.string().trim().max(200).optional().describe("對外聯絡 Email"),
      site_url: z.string().trim().max(500).optional(),
      social_instagram: z.string().trim().max(500).optional(),
      social_facebook: z.string().trim().max(500).optional(),
      social_line: z.string().trim().max(500).optional(),
      map_embed: z.string().trim().max(4000).optional(),
      map_link: z.string().trim().max(1000).optional(),
      map_apple: z.string().trim().max(1000).optional(),
      meta_site_name: z.string().trim().max(200).optional(),
      meta_author: z.string().trim().max(200).optional(),
      meta_twitter_card: z.string().trim().max(100).optional(),
      meta_og_type: z.string().trim().max(100).optional(),
      default_meta_title: z.string().trim().max(300).optional(),
      default_meta_description: z.string().trim().max(1000).optional(),
      dry_run: dryRunArg,
    })
    .refine(
      (v) => [...SETTINGS_LOCALIZED, ...SETTINGS_TEXT].some((k) => v[k] !== undefined),
      "至少給一個要改的欄位",
    ),
  get_email_copy: z.object({
    template_key: z.string().trim().min(1).max(100).optional().describe("只看某一封信"),
  }),
} as const;

export type OpsWriteToolName = keyof typeof OPS_WRITE_TOOL_INPUTS;
type Args<N extends OpsWriteToolName> = z.output<(typeof OPS_WRITE_TOOL_INPUTS)[N]>;

/* ------------------------------------------------------------------ meta */

const PREVIEW = "預設 dry_run=true 只預覽；dry_run=false 才寫入。預覽與寫入都會記稽核。";

export const OPS_WRITE_TOOL_META: Record<
  OpsWriteToolName,
  { title: string; description: string; annotations: ToolAnnotations }
> = {
  update_order_fulfillment: {
    title: "訂單出貨／取貨／完成",
    description:
      "與後台訂單內頁「標記已出貨／已取貨／已完成」同一支寫入（只改狀態與時間戳，不動庫存、名額、發票）。" +
      "只限已付款訂單；純活動票券（不寄送）沒有這個動作。⚠️ MCP 不寄出貨通知信（後台按鈕會寄）。" +
      PREVIEW,
    annotations: WRITE,
  },
  mark_order_paid: {
    title: "標記訂單已收款",
    description:
      "對完帳之後把一張待付款訂單標成已收款（admin_mark_order_paid，與後台同一支；保留原付款方式，" +
      "金額由資料庫那一列決定）。只限匯款或「店家另行聯繫付款」的訂單；線上金流卡住的單請到金流商後台核對。" +
      "付款成功通知信由既有排程補寄。" +
      PREVIEW,
    annotations: WRITE,
  },
  list_phone_order_options: {
    title: "電話報名可選的活動與場次",
    description:
      "與後台「新增電話報名」表單同一份選項：尚未開始、開放中的場次，各自的剩餘名額與販售中的票種（含價格）。" +
      "唯讀，不會改任何資料。",
    annotations: READ_ONLY,
  },
  create_phone_order: {
    title: "新增電話報名",
    description:
      "與後台「新增電話報名」同一條路：前台結帳同一支建單（價格從票種重讀、名額由加鎖 RPC 佔），" +
      "已收到匯款再走 admin_mark_order_paid。聯絡資料可不完整（姓名必填、手機或 Email 至少一項）。" +
      "需要 OAuth 管理員身分（建立者必須是一位後台使用者）。" +
      PREVIEW,
    annotations: CREATE,
  },
  update_phone_order_contacts: {
    title: "修改電話報名的聯絡資料",
    description:
      "補齊／修改電話報名訂單的訂購人與參加者姓名、手機、Email（admin_update_phone_order_contacts，" +
      "寫入與修改紀錄同一支 RPC）。只限後台電話報名的訂單。需要 OAuth 管理員身分。" +
      PREVIEW,
    annotations: WRITE,
  },
  remove_registration: {
    title: "移除一位報名者",
    description:
      "與後台名單頁「移除」同一支 RPC（admin_delete_registration）：刪除這一位參加者並自動還名額與票種單位，" +
      "留下移除紀錄。已付款的報名也可以移除，但**不會退款**（退款要另外處理）。" +
      PREVIEW,
    annotations: DESTRUCTIVE,
  },
  update_registration_participant: {
    title: "修改一位報名者的姓名與聯絡方式",
    description:
      "與後台名單頁「編輯」同一套規則：只改這一位參加者的姓名、Email、電話（換人＝改姓名與聯絡方式；" +
      "可替同行者補填聯絡資料）。訂單、付款狀態、金額、名額、order_id、session_id 都不會變動；" +
      "「注意事項」同意紀錄不能改。用 registration_id，或 order_no＋current_name 定位。" +
      "不是電話報名的參加者，Email 與電話至少要留一項。dry_run=false 時 idempotency_key 與 expected 必填" +
      "（預覽會給，原樣帶回；預覽之後別人改過就會被拒）。稽核記改前改後的值。" +
      PREVIEW,
    annotations: WRITE,
  },
  update_journey_wish: {
    title: "更新策旅意願單",
    description: "改策旅意願單的處理狀態與內部備註（與後台意願單內頁同一支）。" + PREVIEW,
    annotations: WRITE,
  },
  update_partnership_inquiry: {
    title: "更新合作邀約",
    description: "改合作邀約的處理狀態與內部備註（與後台合作邀約內頁同一支）。" + PREVIEW,
    annotations: WRITE,
  },
  create_stock_adjustment: {
    title: "新增在庫異動單",
    description:
      "與後台「在庫異動」同一支 RPC（inv_save_stock_adjustment）：報廢、公關、樣品、內部領用等。" +
      "要不要進待審由資料庫的審核設定決定，呼叫端指定不了；確認後庫存由資料庫 trigger 加減。" +
      "需要 OAuth 管理員身分（必須記錄操作人員）。" +
      PREVIEW,
    annotations: CREATE,
  },
  record_stock_count: {
    title: "盤點",
    description:
      "與後台盤點頁同一支 RPC（inv_record_stock_count）：送實盤數量，差異由資料庫用當下庫存算，" +
      "差異 0 的跳過。審核規則同在庫異動。需要 OAuth 管理員身分。" +
      PREVIEW,
    annotations: CREATE,
  },
  create_purchase: {
    title: "新增進貨",
    description:
      "與後台「進貨」同一支 RPC（inv_save_purchase）。審核狀態由資料庫決定；核准後庫存由 trigger 增加。" +
      "需要 OAuth 管理員身分。" +
      PREVIEW,
    annotations: CREATE,
  },
  get_ui_strings: {
    title: "介面文字列表",
    description: "網站介面上的固定文字（按鈕、標籤等，三語）。唯讀。",
    annotations: READ_ONLY,
  },
  update_ui_string: {
    title: "修改一則介面文字",
    description:
      "改一則既有介面文字的三語內容或排序（與後台「介面文字」頁同一支；只能改既有的，不能新增）。" +
      "只給中文時英日文保留原值，請記得一併給 en/ja。" +
      PREVIEW,
    annotations: WRITE,
  },
  get_site_settings: {
    title: "網站設定",
    description:
      "店家資訊、地圖、社群連結、SEO 預設值，以及通知信收件人（notify_emails，唯讀）。不含匯款帳戶。唯讀。",
    annotations: READ_ONLY,
  },
  update_site_settings: {
    title: "修改網站設定",
    description:
      "改店家資訊、地圖、社群連結、SEO 預設值（與後台設定頁同一支、同一套驗證）。只給要改的欄位。" +
      "不能改通知信收件人與匯款帳戶。" +
      PREVIEW,
    annotations: WRITE,
  },
  get_email_copy: {
    title: "通知信文案",
    description:
      "系統通知信（付款成功、報名成功、提醒等）目前使用的文案（email_copy）。後台沒有編輯頁，所以這裡也只能讀。唯讀。",
    annotations: READ_ONLY,
  },
};

/* ------------------------------------------------------------------ 小工具 */

function notFound(what: string, id: string): never {
  throw new McpInputError(`找不到${what}「${id}」。請先用對應的 list_*／get_* 工具查 id。`);
}

function taipeiToday(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

const NEXT_STEP = "這只是預覽，還沒有寫入。確認無誤後，用同樣的參數加上 dry_run=false 再呼叫一次。";

/** 後台 zod（v3）規則驗證。失敗回一句中文。 */
function validateWith<S extends z3.ZodTypeAny>(schema: S, value: unknown): z3.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new McpInputError(
      `欄位驗證失敗（與後台同一套規則）：${zodIssuesText(r.error) ?? "格式不正確"}`,
    );
  }
  return r.data as z3.output<S>;
}

/** 只列出真的有變的欄位（before/after 皆給值）。 */
function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[],
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of keys) {
    const b = before[k] ?? null;
    const a = after[k] ?? null;
    if (stableStringify(b) !== stableStringify(a)) out[k] = { before: b, after: a };
  }
  return out;
}

type Localized = { zh: string; en: string; ja: string };
type LocalizedPatch = string | { zh?: string; en?: string; ja?: string };

function mergeLocalized(current: Localized, patch: LocalizedPatch): Localized {
  if (typeof patch === "string") return { ...current, zh: patch };
  return {
    zh: patch.zh ?? current.zh,
    en: patch.en ?? current.en,
    ja: patch.ja ?? current.ja,
  };
}

/** 只改了中文、英日文沒動 → 提醒一句。 */
function staleTranslationWarning(patch: LocalizedPatch | undefined): boolean {
  if (patch === undefined) return false;
  if (typeof patch === "string") return true;
  return Boolean(patch.zh) && (!patch.en || !patch.ja);
}

async function audit(
  tool: string,
  entity: string,
  entityId: string,
  action: string,
  changes: unknown,
  dryRun: boolean,
) {
  const { writeMcpAudit } = await import("./audit");
  return await writeMcpAudit({
    tool,
    entity,
    entity_id: entityId,
    action,
    changes,
    dry_run: dryRun,
  });
}

const auditText = (s: "recorded" | "log_only") =>
  s === "recorded" ? "recorded" : "log_only（稽核表寫入失敗，紀錄只在伺服器 log）";

/** 預覽：記一筆 dry_run=true 的稽核，回「會改什麼」。 */
async function preview(
  tool: string,
  entity: string,
  entityId: string,
  action: string,
  body: Record<string, unknown>,
  auditChanges: unknown,
  extraNext?: string,
): Promise<TextResult> {
  await audit(tool, entity, entityId, action, auditChanges, true);
  return jsonText({
    dry_run: true,
    written: false,
    action,
    ...body,
    next_step: extraNext ? `${NEXT_STEP}${extraNext}` : NEXT_STEP,
  });
}

/** 寫入之後：記一筆 dry_run=false 的稽核，回結果。 */
async function committed(
  tool: string,
  entity: string,
  entityId: string,
  action: string,
  body: Record<string, unknown>,
  auditChanges: unknown,
): Promise<TextResult> {
  const status = await audit(tool, entity, entityId, action, auditChanges, false);
  return jsonText({ dry_run: false, action, ...body, audit: auditText(status) });
}

/** 寫入的 repo 丟例外：也記一筆（action 加 _failed），再往外丟給 wrap() 轉成 isError。 */
async function commitOrAudit<T>(
  tool: string,
  entity: string,
  entityId: string,
  action: string,
  auditChanges: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await audit(
      tool,
      entity,
      entityId,
      `${action}_failed`,
      { ...auditChanges, error: err instanceof Error ? err.message : String(err) },
      false,
    );
    throw err;
  }
}

/* ---- actor ---- */

async function oauthUserId(tool: string): Promise<string> {
  const { currentMcpActor } = await import("./actor");
  const actor = currentMcpActor();
  if (actor?.via === "oauth") return actor.user_id;
  throw new McpInputError(
    `${tool} 需要 OAuth 管理員身分：這個動作背後的 RPC 必須記錄是哪一位後台使用者操作的，` +
      "靜態 token 沒有對應的使用者。請改用 claude.ai／ChatGPT 連接器（OAuth）登入的連線。",
  );
}

/** RPC 接受 null 的 p_actor_id：OAuth 傳 user_id，靜態 token 傳 null（「是誰」記在 mcp_audit_log）。 */
async function actorIdOrNull(): Promise<string | null> {
  const { currentMcpActor } = await import("./actor");
  const actor = currentMcpActor();
  return actor?.via === "oauth" ? actor.user_id : null;
}

/* ---- 訂單 ---- */

type OrderFacts = {
  id: string;
  order_no: string;
  status: string;
  payment_status: string;
  payment_method: string | null;
  paid_at: string | null;
  shipping_method: string;
  shipped_at: string | null;
  completed_at: string | null;
  total: number;
  source: string | null;
};

const ORDER_FACT_COLUMNS =
  "id, order_no, status, payment_status, payment_method, paid_at, shipping_method, shipped_at, completed_at, total, source";

async function loadOrderFacts(ref: { order_id?: string; order_no?: string }): Promise<OrderFacts> {
  const { supabaseAdmin } = await import("@/server/supabase-admin");
  let q = supabaseAdmin().from("orders").select(ORDER_FACT_COLUMNS);
  q = ref.order_id ? q.eq("id", ref.order_id) : q.eq("order_no", ref.order_no ?? "");
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`訂單讀取失敗：${error.code}`);
  if (!data) notFound("訂單", ref.order_id ?? ref.order_no ?? "");
  return data as unknown as OrderFacts;
}

/* ------------------------------------------------------------------ handlers */

type Handlers = { [N in OpsWriteToolName]: (args: Args<N>) => Promise<TextResult> };

const IMPL: Handlers = {
  /* ============================================================ 訂單 */

  async update_order_fulfillment(args) {
    const tool = "update_order_fulfillment";
    const { FULFILLMENT_TRANSITIONS, canApply, classifyAfterNoop, STATUS_LABEL_ZH } =
      await import("@/lib/admin/order-fulfillment");
    const o = await loadOrderFacts(args);
    const t = FULFILLMENT_TRANSITIONS[args.action];
    const target = { order_id: o.id, order_no: o.order_no };

    if (!canApply(args.action, o)) {
      if (classifyAfterNoop(args.action, o) === "already_done") {
        return jsonText({
          ...target,
          dry_run: args.dry_run,
          written: false,
          message: `這張訂單已經是「${STATUS_LABEL_ZH[o.status] ?? o.status}」，不需要再做。`,
        });
      }
      throw new McpInputError(
        `訂單 ${o.order_no} 不能做 ${args.action}：需要已付款（目前 ${o.payment_status}）、` +
          `狀態是「${STATUS_LABEL_ZH[t.from]}」（目前「${STATUS_LABEL_ZH[o.status] ?? o.status}」）、` +
          `收件方式是 ${t.methods.join("／")}（目前 ${o.shipping_method}）。`,
      );
    }

    const changes = {
      status: { before: o.status, after: t.to },
      [t.stampColumn]: { before: o[t.stampColumn] ?? null, after: "（寫入當下的時間）" },
    };
    const auditChanges = { ...target, fulfillment_action: args.action, changes };

    if (args.dry_run) {
      return preview(
        tool,
        "order",
        o.id,
        "fulfill",
        { ...target, changes, email: "MCP 不寄出貨通知信" },
        auditChanges,
      );
    }

    const { advanceOrderFulfillment } = await import("@/server/repos/order-fulfillment");
    const actorId = (await actorIdOrNull()) ?? "mcp:static_token";
    const result = await commitOrAudit(tool, "order", o.id, "fulfill", auditChanges, () =>
      advanceOrderFulfillment({ orderId: o.id, actorId, action: args.action }),
    );
    return committed(
      tool,
      "order",
      o.id,
      "fulfill",
      {
        ...target,
        written: result.updated,
        result,
        email: "MCP 不寄出貨通知信；需要通知客人請另行聯繫。",
      },
      { ...auditChanges, result: result.reason },
    );
  },

  async mark_order_paid(args) {
    const tool = "mark_order_paid";
    const o = await loadOrderFacts(args);
    const target = { order_id: o.id, order_no: o.order_no, total: o.total };

    if (o.payment_status === "paid") {
      return jsonText({
        ...target,
        dry_run: args.dry_run,
        written: false,
        message: "這張訂單已經是已收款，不需要再標記。",
      });
    }
    if (o.payment_method !== "transfer" && o.payment_method !== null) {
      throw new McpInputError(
        `訂單 ${o.order_no} 是線上金流（${o.payment_method}）的單，還沒收到金流商的付款通知。` +
          "後台也不提供手動標記——請到金流商後台核對。只有匯款與「店家另行聯繫付款」的單可以標記已收款。",
      );
    }
    if (o.status !== "pending") {
      throw new McpInputError(
        `訂單 ${o.order_no} 的狀態是 ${o.status}，不是待付款（pending），不能標記已收款（可能已取消）。`,
      );
    }

    const changes = {
      payment_status: { before: o.payment_status, after: "paid" },
      status: { before: o.status, after: "processing" },
      paid_at: { before: o.paid_at, after: "（寫入當下的時間）" },
    };
    const note = args.note && args.note.trim() ? args.note.trim() : null;
    const auditChanges = { ...target, payment_method: o.payment_method, note, changes };

    if (args.dry_run) {
      return preview(
        tool,
        "order",
        o.id,
        "mark_paid",
        { ...target, payment_method: o.payment_method, changes, note },
        auditChanges,
      );
    }

    const { markOrderPaidByAdmin } = await import("@/server/repos/orders-admin");
    const actorId = await actorIdOrNull();
    const result = await commitOrAudit(tool, "order", o.id, "mark_paid", auditChanges, () =>
      // admin_mark_order_paid 的 p_actor_id 接受 null（只落進 payments.raw_response）。
      markOrderPaidByAdmin({ orderId: o.id, actorId: actorId as string, note }),
    );
    return committed(
      tool,
      "order",
      o.id,
      "mark_paid",
      {
        ...target,
        written: result.marked,
        result,
        email: result.marked
          ? "付款成功通知信由既有排程（notify_backlog）補排，MCP 這裡不直接寄。"
          : undefined,
      },
      { ...auditChanges, result: result.reason },
    );
  },

  /* ============================================================ 電話報名 */

  async list_phone_order_options(args) {
    const { listPhoneOrderOptions } = await import("@/server/repos/phone-orders");
    const all = await listPhoneOrderOptions();
    const kw = args.keyword?.toLowerCase() ?? null;
    const rows = kw ? all.filter((p) => (p.title?.zh ?? "").toLowerCase().includes(kw)) : all;
    return jsonText({
      count: rows.length,
      products: rows.map((p) => ({
        product_id: p.id,
        title: p.title.zh,
        product_type: p.productType,
        price: p.price,
        sessions: p.sessions.map((s) => ({
          session_id: s.id,
          title: s.title?.zh ?? null,
          starts_at: s.startsAt,
          ends_at: s.endsAt,
          seats_left: s.seatsLeft,
          capacity: s.capacity,
          has_plans: s.hasPlans,
          plans: s.plans.map((pl) => ({
            plan_id: pl.id,
            title: pl.title.zh,
            price: pl.price,
            seats_per_unit: pl.seatsPerUnit,
            units_left: pl.unitsLeft,
          })),
        })),
      })),
    });
  },

  async create_phone_order(args) {
    const tool = "create_phone_order";
    const actorId = await oauthUserId(tool);

    if (args.payment_status === "paid" && !args.paid_on) {
      throw new McpInputError("payment_status=paid 時 paid_on（匯款日期）必填。");
    }

    const { listPhoneOrderOptions } = await import("@/server/repos/phone-orders");
    const {
      phoneOrderSchema,
      phoneOrderNotifyError,
      quotePhoneOrder,
      priceOverrideError,
      buildPhoneOrderPayload,
      phoneOrderPaidNote,
    } = await import("@/lib/admin/phone-order");

    const options = await listPhoneOrderOptions();
    const product = options.find((p) => p.id === args.product_id);
    const session = product?.sessions.find((s) => s.id === args.session_id);
    if (!product || !session) {
      throw new McpInputError(
        "找不到可報名的這個活動／場次（可能已開始、關閉、下架，或 id 不對）。請先用 list_phone_order_options 查。",
      );
    }
    let plan = null as (typeof session.plans)[number] | null;
    if (args.plan_id) {
      plan = session.plans.find((p) => p.id === args.plan_id) ?? null;
      if (!plan)
        throw new McpInputError(
          "這個票種不存在或目前不在販售期間。請用 list_phone_order_options 查。",
        );
    } else if (session.hasPlans) {
      throw new McpInputError("這一場有票種，請指定 plan_id（見 list_phone_order_options）。");
    }

    const quote = quotePhoneOrder(product, plan, args.quantity);
    const given = args.participants ?? [];
    if (given.length > quote.seats) {
      throw new McpInputError(
        `參加者給了 ${given.length} 位，但這次只有 ${quote.seats} 個座位（人數 ${args.quantity} × 每單位 ${quote.seatsPerUnit} 位）。`,
      );
    }
    // 沒給的位置補空白，由 buildPhoneOrderPayload() 帶預設姓名（同後台表單）。
    const participants = Array.from({ length: quote.seats }, (_, i) => ({
      name: given[i]?.name ?? "",
      email: given[i]?.email ?? "",
      phone: given[i]?.phone ?? "",
    }));

    const overrideErr = priceOverrideError(args.price_override ?? null, quote.total);
    if (overrideErr) throw new McpInputError(`手動改價不合法：${overrideErr}`);

    // dry_run=false 時必填（審查 2026-11-03）：沒帶就不建單，避免 AI 重送時每次換一組 key。
    // 防重複由 createAdminPhoneOrder 的 RPC 以這組 key 保證（同一組 key 重送拿回同一張單）。
    if (!args.dry_run && !args.idempotency_key) {
      throw new McpInputError(
        "dry_run=false 時 idempotency_key 必填：先用 dry_run=true 預覽取得一組，正式送出時帶同一組。",
      );
    }
    const idempotencyKey = args.idempotency_key ?? randomUUID();
    const inv = args.invoice;
    const data = validateWith(phoneOrderSchema, {
      customerName: args.customer_name,
      customerEmail: args.customer_email ?? "",
      customerPhone: args.customer_phone ?? "",
      idempotencyKey,
      productId: args.product_id,
      sessionId: args.session_id,
      planId: args.plan_id ?? null,
      quantity: args.quantity,
      participants,
      invoice: {
        type: inv?.type ?? "personal",
        taxId: inv?.tax_id ?? null,
        companyTitle: inv?.company_title ?? null,
        carrierType: inv?.carrier_type ?? null,
        carrierNumber: inv?.carrier_number ?? null,
        loveCode: inv?.love_code ?? null,
      },
      adminNote: args.admin_note ?? null,
      priceOverride: args.price_override ?? null,
      payment:
        args.payment_status === "paid"
          ? { status: "paid", paidOn: args.paid_on, last5: args.last5 ?? null }
          : { status: "unpaid" },
      notifyCustomer: args.notify_customer,
    });
    const notifyErr = phoneOrderNotifyError(data);
    if (notifyErr) throw new McpInputError(notifyErr);

    const total = data.priceOverride ? data.priceOverride.amount : quote.total;
    const payload = buildPhoneOrderPayload(data);
    const seatsAvailable = plan
      ? Math.min(session.seatsLeft, plan.unitsLeft * quote.seatsPerUnit)
      : session.seatsLeft;
    const willCreate = {
      product: { id: product.id, title: product.title.zh },
      session: { id: session.id, title: session.title?.zh ?? null, starts_at: session.startsAt },
      plan: plan ? { id: plan.id, title: plan.title.zh } : null,
      quantity: args.quantity,
      seats: quote.seats,
      unit_price: quote.unitPrice,
      original_total: quote.total,
      total,
      price_override_reason: data.priceOverride?.reason ?? null,
      payment:
        args.payment_status === "paid"
          ? {
              status: "paid（建單後立刻標記已收款）",
              paid_on: args.paid_on,
              last5: args.last5 ?? null,
            }
          : { status: "unpaid（待付款，不會被逾期自動取消）" },
      customer: {
        name: data.customerName,
        email: data.customerEmail || null,
        phone: data.customerPhone || null,
      },
      participants: payload.items[0]!.participants!.map((p) => ({
        name: p.name,
        email: p.email,
        phone: p.phone,
      })),
      invoice_type: data.invoice.type,
      notify_customer: data.notifyCustomer,
      admin_note: data.adminNote,
    };
    // 稽核不放客人的聯絡資料（姓名／電話／Email），只放「建了什麼」。
    const auditChanges = {
      product_id: product.id,
      session_id: session.id,
      plan_id: plan?.id ?? null,
      quantity: args.quantity,
      seats: quote.seats,
      total,
      price_override: Boolean(data.priceOverride),
      payment_status: args.payment_status,
      notify_customer: data.notifyCustomer,
      idempotency_key: idempotencyKey,
    };

    if (args.dry_run) {
      return preview(
        tool,
        "order",
        "(未建立)",
        "create",
        {
          idempotency_key: idempotencyKey,
          will_create: willCreate,
          seats_left_now: seatsAvailable,
          warning:
            quote.seats > seatsAvailable
              ? `目前只剩 ${seatsAvailable} 個座位，送出時會因名額不足被擋下。`
              : undefined,
        },
        auditChanges,
        `正式送出時請帶 idempotency_key="${idempotencyKey}"，重送也不會建出第二張單。`,
      );
    }

    const { createAdminPhoneOrder, AdminPhoneOrderInputError, AdminPhoneOrderUncertainError } =
      await import("@/server/repos/orders");
    const { CheckoutError, CHECKOUT_ERROR_COPY } = await import("@/lib/checkout");

    let placed;
    try {
      placed = await createAdminPhoneOrder(payload, {
        actorId,
        totalOverride: data.priceOverride ? data.priceOverride.amount : null,
        priceOverrideReason: data.priceOverride ? data.priceOverride.reason : null,
        adminNote: data.adminNote && data.adminNote.trim() ? data.adminNote.trim() : null,
        notifyCustomer: data.notifyCustomer,
        paidUpfront: data.payment.status === "paid",
        remittancePaidOn: data.payment.status === "paid" ? data.payment.paidOn : null,
        remittanceLast5:
          data.payment.status === "paid" && data.payment.last5 ? data.payment.last5 : null,
      });
    } catch (err) {
      let message: string;
      if (err instanceof AdminPhoneOrderInputError) {
        message = `訂單沒有成立：${err.code}`;
      } else if (err instanceof AdminPhoneOrderUncertainError) {
        message =
          "這筆報名可能已經建立（或還在處理中）。請先用 list_orders scope=phone 確認，不要用新的 idempotency_key 再送。";
      } else if (err instanceof CheckoutError) {
        message = `訂單沒有成立（${err.code}）：${CHECKOUT_ERROR_COPY[err.code].zh}`;
      } else {
        message = `訂單建立失敗：${err instanceof Error ? err.message : String(err)}`;
      }
      await audit(
        tool,
        "order",
        "(未建立)",
        "create_failed",
        { ...auditChanges, error: message },
        false,
      );
      return errText(message);
    }

    let paid: unknown = null;
    let warning: string | null = null;
    if (placed.total > 0 && data.payment.status === "paid") {
      // 與後台同一支（0034 §5）。
      const { markOrderPaidByAdmin } = await import("@/server/repos/orders-admin");
      try {
        const r = await markOrderPaidByAdmin({
          orderId: placed.orderId,
          actorId,
          note: phoneOrderPaidNote(data.payment.paidOn, data.payment.last5),
        });
        paid = r;
        if (r.reason !== "marked" && r.reason !== "already_paid") {
          warning = `訂單已建立，但沒有標記成已收款（${r.reason}）。請用 mark_order_paid 確認。`;
        }
      } catch (err) {
        warning = `訂單已建立，但標記已收款失敗（${err instanceof Error ? err.message : String(err)}）。請用 mark_order_paid 再試。`;
      }
    }

    return committed(
      tool,
      "order",
      placed.orderId,
      "create",
      {
        written: true,
        order_id: placed.orderId,
        order_no: placed.orderNo,
        total: placed.total,
        payment_status: placed.paymentStatus,
        mark_paid: paid,
        warning,
      },
      { ...auditChanges, order_no: placed.orderNo, mark_paid: paid, warning },
    );
  },

  async update_phone_order_contacts(args) {
    const tool = "update_phone_order_contacts";
    const actorId = await oauthUserId(tool);
    if (!args.customer && !(args.participants && args.participants.length)) {
      throw new McpInputError("customer 與 participants 至少給一個。");
    }
    const { loadPhoneOrderContacts, updatePhoneOrderContacts } =
      await import("@/server/repos/phone-orders");
    const { phoneOrderContactEditSchema } = await import("@/lib/admin/phone-order");

    const cur = await loadPhoneOrderContacts(args.order_id);
    if (!cur) {
      throw new McpInputError(
        "找不到這張訂單，或它不是後台電話報名的訂單（只有電話報名可以在這裡改聯絡資料）。",
      );
    }

    const patchById = new Map((args.participants ?? []).map((p) => [p.id, p]));
    for (const id of patchById.keys()) {
      if (!cur.participants.some((p) => p.id === id)) {
        throw new McpInputError(`參加者 ${id} 不在這張訂單裡（可能已被移除）。`);
      }
    }
    const nextCustomer = {
      name: args.customer?.name ?? cur.customer.name,
      email: args.customer?.email ?? cur.customer.email,
      phone: args.customer?.phone ?? cur.customer.phone,
    };
    const nextParticipants = cur.participants.map((p) => {
      const patch = patchById.get(p.id);
      return {
        id: p.id,
        name: patch?.name ?? p.name,
        email: patch?.email ?? p.email ?? "",
        phone: patch?.phone ?? p.phone ?? "",
      };
    });
    const data = validateWith(phoneOrderContactEditSchema, {
      orderId: args.order_id,
      customer: nextCustomer,
      participants: nextParticipants,
    });
    if (cur.notifyCustomer && data.customer.email === "") {
      throw new McpInputError("這張單有勾「寄信給客人」，訂購人 Email 不能清空。");
    }

    const KEYS = ["name", "email", "phone"] as const;
    const changes: Record<string, unknown> = {};
    const changedFields: string[] = [];
    const cDiff = diff(cur.customer, data.customer, KEYS);
    if (Object.keys(cDiff).length) {
      changes.customer = cDiff;
      for (const k of Object.keys(cDiff)) changedFields.push(`customer.${k}`);
    }
    const pChanges: Record<string, unknown>[] = [];
    for (const next of data.participants) {
      const before = cur.participants.find((p) => p.id === next.id)!;
      const d = diff(
        { name: before.name, email: before.email ?? "", phone: before.phone ?? "" },
        next,
        KEYS,
      );
      if (Object.keys(d).length) {
        pChanges.push({ id: next.id, seat_no: before.seatNo, changes: d });
        for (const k of Object.keys(d)) changedFields.push(`participant[${before.seatNo}].${k}`);
      }
    }
    if (pChanges.length) changes.participants = pChanges;

    if (changedFields.length === 0) {
      return jsonText({
        order_id: args.order_id,
        dry_run: args.dry_run,
        written: false,
        message: "沒有任何欄位改變，不需要寫入。",
      });
    }
    // 稽核只記欄位名，不記值（同 0051 order_contact_edit_log）。
    const auditChanges = { order_id: args.order_id, fields: changedFields };

    if (args.dry_run) {
      return preview(
        tool,
        "order",
        args.order_id,
        "update_contacts",
        { order_id: args.order_id, changes },
        auditChanges,
      );
    }

    const res = await commitOrAudit(
      tool,
      "order",
      args.order_id,
      "update_contacts",
      auditChanges,
      () =>
        updatePhoneOrderContacts({
          orderId: args.order_id,
          actorId,
          customer: data.customer,
          participants: data.participants,
        }),
    );
    if (!res.updated) {
      await audit(
        tool,
        "order",
        args.order_id,
        "update_contacts_failed",
        { ...auditChanges, reason: res.reason },
        false,
      );
      return errText(`沒有寫入：${res.reason}`);
    }
    return committed(
      tool,
      "order",
      args.order_id,
      "update_contacts",
      { order_id: args.order_id, written: true, reason: res.reason, changes },
      { ...auditChanges, result: res.reason },
    );
  },

  /* ============================================================ 報名 */

  async remove_registration(args) {
    const tool = "remove_registration";
    // 與後台名單頁同一份資料：listSessionRoster()（0021 的名單 view＋聯絡方式），
    // 「已付款／在簽到表上」看 view 的 on_roster，不在這裡自己判斷付款狀態。
    const { listSessionRoster } = await import("@/server/repos/event-registrations");
    const { getEventSessionById } = await import("@/server/repos/event-sessions");
    const [roster, session] = await Promise.all([
      listSessionRoster(args.session_id),
      getEventSessionById(args.session_id),
    ]);
    if (!session) notFound("場次", args.session_id);
    const r = roster.find((x) => x.registration_id === args.registration_id);
    if (!r) {
      throw new McpInputError(
        `這個場次的名單裡找不到參加者「${args.registration_id}」（可能已被移除）。請用 get_session_roster 確認。`,
      );
    }
    const title = session.title as unknown as { zh?: string } | null;

    const target = {
      registration_id: r.registration_id,
      name: r.name,
      seat_no: r.seat_no,
      order_no: r.order_no,
      payment_status: r.payment_status,
      on_roster: r.on_roster,
      session: { id: session.id, title: title?.zh ?? null, starts_at: session.starts_at },
    };
    const auditChanges = {
      registration_id: r.registration_id,
      name_initial: (r.name ?? "").trim().slice(0, 1) || null,
      order_no: r.order_no,
      session_id: r.session_id,
      payment_status: r.payment_status,
      on_roster: r.on_roster,
    };
    // 0059：用實際的付款狀態判斷。0058 起 on_roster 也包含「現場付款、還沒付錢」的人，
    // 他們沒付過錢，不該出現退款警告。
    const warning =
      r.payment_status === "paid"
        ? "這位參加者的訂單已付款。移除只會還名額，不會退款；退款要另外處理。"
        : r.onsite_unpaid
          ? "這位參加者是現場付款、尚未付款（在簽到表上）。移除會還名額；沒有款項要退。"
          : undefined;

    if (args.dry_run) {
      return preview(
        tool,
        "event_registration",
        r.registration_id,
        "delete",
        { will_remove: target, effect: "刪除這一位、場次與票種名額各還 1", warning },
        auditChanges,
      );
    }

    const { deleteAdminRegistration } = await import("@/server/repos/event-registrations-admin");
    const actorId = await actorIdOrNull();
    const result = await commitOrAudit(
      tool,
      "event_registration",
      r.registration_id,
      "delete",
      auditChanges,
      () =>
        // admin_delete_registration 的 p_actor_id 接受 null（coalesce(p_actor_id, auth.uid())）。
        deleteAdminRegistration({ registrationId: r.registration_id, actorId: actorId as string }),
    );
    return committed(
      tool,
      "event_registration",
      r.registration_id,
      "delete",
      { removed: target, written: result.deleted, result, warning },
      { ...auditChanges, result: result.reason },
    );
  },

  async update_registration_participant(args) {
    const tool = "update_registration_participant";
    if (!args.dry_run && !args.expected) {
      throw new McpInputError(
        "dry_run=false 時 expected 必填：先用 dry_run=true 預覽，正式送出時把預覽回傳的 expected 原樣帶回來。",
      );
    }
    const { participantEmailSchema, participantNameSchema, participantPhoneSchema } =
      await import("@/lib/admin/registration-edit");
    const repo = await import("@/server/repos/event-registration-contacts");

    // 定位：registration_id，或 order_no＋目前姓名。
    let registrationId = args.registration_id;
    if (!registrationId) {
      const found = (
        await repo.findRegistrationsByOrderNoAndName(args.order_no ?? "", args.current_name ?? "")
      ).filter((r) => !args.session_id || r.session_id === args.session_id);
      if (found.length === 0) {
        // 錯誤訊息不帶姓名：被拒的原因會進 mcp_audit_log 與伺服器 log（tools.ts auditRejected）。
        throw new McpInputError(
          `訂單「${args.order_no}」裡找不到符合這個姓名的參加者。請用 get_session_roster 或 get_order 確認。`,
        );
      }
      if (found.length > 1) {
        throw new McpInputError(
          `訂單「${args.order_no}」裡有 ${found.length} 位同名的參加者，請改用 registration_id：` +
            found.map((r) => `${r.id}（第 ${r.seat_no} 位）`).join("、"),
        );
      }
      registrationId = found[0].id;
    }

    // 與後台同一份清洗與格式規則（singleLine、長度、Email、電話字元）。
    const patch: { name?: string; email?: string; phone?: string } = {};
    if (args.name !== undefined) patch.name = validateWith(participantNameSchema, args.name);
    if (args.email !== undefined) patch.email = validateWith(participantEmailSchema, args.email);
    if (args.phone !== undefined) patch.phone = validateWith(participantPhoneSchema, args.phone);

    const { planRegistrationEdit, REGISTRATION_EDIT_ERROR_TEXT } =
      await import("@/server/registration-edit");
    const plan = await planRegistrationEdit({
      registrationId,
      sessionId: args.session_id,
      expected: args.expected,
      patch,
    });
    if (!plan.ok) throw new McpInputError(plan.message);

    const reg = plan.registration;
    const target = {
      registration_id: reg.id,
      order_no: reg.order_no,
      seat_no: reg.seat_no,
      session_id: reg.session_id,
      current: plan.before,
    };
    const fields = Object.keys(plan.changes);
    if (fields.length === 0) {
      return jsonText({
        registration_id: reg.id,
        dry_run: args.dry_run,
        written: false,
        message: "沒有任何欄位改變，不需要寫入。",
      });
    }
    // 稽核記前後值（業主 2026-11-05）；_log_redact 讓伺服器 log 只印欄位名、不印值。
    const auditChanges = {
      registration_id: reg.id,
      order_no: reg.order_no,
      session_id: reg.session_id,
      seat_no: reg.seat_no,
      fields: plan.changes,
      _log_redact: ["fields"],
    };
    const untouched = "訂單、付款狀態、金額、名額、order_id、session_id 都不會變動。";

    if (args.dry_run) {
      const key = args.idempotency_key ?? randomUUID();
      return preview(
        tool,
        "event_registration",
        reg.id,
        "update_participant",
        { target, changes: plan.changes, untouched, expected: plan.before, idempotency_key: key },
        auditChanges,
        `正式送出時請帶 idempotency_key="${key}" 與上面的 expected（原樣帶回）。`,
      );
    }

    await claimIdempotencyKey(tool, args.idempotency_key);
    const res = await commitOrAudit(
      tool,
      "event_registration",
      reg.id,
      "update_participant",
      auditChanges,
      () =>
        repo.updateRegistrationContact({
          registrationId: reg.id,
          match: {
            name: plan.registration.name,
            email: plan.registration.email,
            phone: plan.registration.phone,
          },
          after: plan.after,
        }),
    );
    if (res !== "updated") {
      await audit(
        tool,
        "event_registration",
        reg.id,
        "update_participant_failed",
        { ...auditChanges, result: res },
        false,
      );
      throw new McpInputError(
        res === "stale"
          ? `${REGISTRATION_EDIT_ERROR_TEXT.stale}這組 idempotency_key 已用掉，請重新預覽取得新的一組。`
          : "Email 與電話至少要留一項（只有電話報名的同行者可以兩項都空）。",
      );
    }
    return committed(
      tool,
      "event_registration",
      reg.id,
      "update_participant",
      { written: true, target, changes: plan.changes, untouched },
      { ...auditChanges, result: "updated" },
    );
  },

  /* ============================================================ 意願單、合作邀約 */

  async update_journey_wish(args) {
    const tool = "update_journey_wish";
    const { getWish, updateWish } = await import("@/server/repos/journey-wishes");
    const cur = await getWish(args.id);
    if (!cur) notFound("策旅意願單", args.id);
    const next = {
      status: args.status ?? cur.status,
      admin_note: args.admin_note ?? cur.admin_note ?? "",
    };
    const changes = diff({ status: cur.status, admin_note: cur.admin_note ?? "" }, next, [
      "status",
      "admin_note",
    ]);
    if (Object.keys(changes).length === 0) {
      return jsonText({
        id: args.id,
        dry_run: args.dry_run,
        written: false,
        message: "沒有任何欄位改變，不需要寫入。",
      });
    }
    if (args.dry_run) {
      return preview(tool, "journey_wish", args.id, "update", { id: args.id, changes }, changes);
    }
    const row = await commitOrAudit(tool, "journey_wish", args.id, "update", changes, () =>
      updateWish(args.id, next),
    );
    return committed(
      tool,
      "journey_wish",
      args.id,
      "update",
      {
        id: args.id,
        written: true,
        changes,
        saved: { status: row.status, admin_note: row.admin_note, updated_at: row.updated_at },
      },
      changes,
    );
  },

  async update_partnership_inquiry(args) {
    const tool = "update_partnership_inquiry";
    const { getInquiry, updateInquiry } = await import("@/server/repos/partnership-inquiries");
    const cur = await getInquiry(args.id);
    if (!cur) notFound("合作邀約", args.id);
    const next = {
      status: args.status ?? cur.status,
      admin_note: args.admin_note ?? cur.admin_note ?? "",
    };
    const changes = diff({ status: cur.status, admin_note: cur.admin_note ?? "" }, next, [
      "status",
      "admin_note",
    ]);
    if (Object.keys(changes).length === 0) {
      return jsonText({
        id: args.id,
        dry_run: args.dry_run,
        written: false,
        message: "沒有任何欄位改變，不需要寫入。",
      });
    }
    if (args.dry_run) {
      return preview(
        tool,
        "partnership_inquiry",
        args.id,
        "update",
        { id: args.id, changes },
        changes,
      );
    }
    const row = await commitOrAudit(tool, "partnership_inquiry", args.id, "update", changes, () =>
      updateInquiry(args.id, next),
    );
    return committed(
      tool,
      "partnership_inquiry",
      args.id,
      "update",
      {
        id: args.id,
        written: true,
        changes,
        saved: { status: row.status, admin_note: row.admin_note, updated_at: row.updated_at },
      },
      changes,
    );
  },

  /* ============================================================ 進銷存 */

  async create_stock_adjustment(args) {
    const tool = "create_stock_adjustment";
    const userId = await oauthUserId(tool);
    const { invAdjustmentSchema } = await import("@/lib/admin/schemas");
    const data = validateWith(invAdjustmentSchema, {
      product_id: args.product_id,
      adjustment_date: args.adjustment_date ?? taipeiToday(),
      category: args.category,
      quantity: args.quantity,
      reason: args.reason ?? null,
      notes: args.notes ?? null,
      submit: args.submit,
    });
    const { getAdminProduct } = await import("@/server/repos/inv-products");
    const product = await getAdminProduct(data.product_id);
    if (!product) notFound("進銷存商品", data.product_id);

    const { submit, ...payload } = data;
    const willCreate = {
      product: { id: data.product_id, name: product.name, issue_number: product.issue_number },
      ...payload,
      submit,
      stock_now: product.stock_quantity,
      stock_after_if_confirmed: product.stock_quantity + data.quantity,
      note: submit
        ? "送出後是否需要審核由資料庫的審核設定決定；需要審核時，核准後庫存才會變動。"
        : "存成草稿，不會動庫存。",
    };
    const auditChanges = { ...payload, submit, stock_before: product.stock_quantity };

    if (args.dry_run) {
      return preview(
        tool,
        "inv_stock_adjustment",
        "(未建立)",
        "create",
        { idempotency_key: args.idempotency_key ?? randomUUID(), will_create: willCreate },
        auditChanges,
      );
    }
    await claimIdempotencyKey("create_stock_adjustment", args.idempotency_key);
    const { saveAdjustment } = await import("@/server/repos/inv-adjustments");
    const res = await commitOrAudit(
      tool,
      "inv_stock_adjustment",
      "(未建立)",
      "create",
      auditChanges,
      () => saveAdjustment({ userId, payload, submit }),
    );
    return committed(
      tool,
      "inv_stock_adjustment",
      res.id,
      "create",
      { written: true, result: res },
      { ...auditChanges, result: res },
    );
  },

  async record_stock_count(args) {
    const tool = "record_stock_count";
    const userId = await oauthUserId(tool);
    const ids = args.rows.map((r) => r.product_id);
    if (new Set(ids).size !== ids.length)
      throw new McpInputError("同一件商品在 rows 裡出現了兩次。");

    const { stockCountSchema } = await import("@/lib/admin/schemas");
    const data = validateWith(stockCountSchema, {
      rows: args.rows,
      options: {
        reason: args.reason,
        notes: args.notes ?? null,
        adjustment_date: args.adjustment_date ?? taipeiToday(),
      },
    });

    const { supabaseAdmin } = await import("@/server/supabase-admin");
    const { data: prods, error } = await supabaseAdmin()
      .from("inv_admin_products")
      .select("inv_product_id, name, issue_number, stock_quantity")
      .in("inv_product_id", ids);
    if (error) throw new Error(`商品讀取失敗：${error.code ?? error.message}`);
    const byId = new Map(
      (
        (prods ?? []) as unknown as {
          inv_product_id: string;
          name: string;
          issue_number: string | null;
          stock_quantity: number;
        }[]
      ).map((p) => [p.inv_product_id, p]),
    );
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new McpInputError(`找不到進銷存商品：${missing.join("、")}`);

    const lines = data.rows.map((r) => {
      const p = byId.get(r.product_id)!;
      return {
        product_id: r.product_id,
        name: p.name,
        issue_number: p.issue_number,
        stock_now: p.stock_quantity,
        actual_quantity: r.actual_quantity,
        difference: r.actual_quantity - p.stock_quantity,
      };
    });
    const changed = lines.filter((l) => l.difference !== 0);
    const auditChanges = {
      options: data.options,
      rows: lines.map((l) => ({
        product_id: l.product_id,
        stock_now: l.stock_now,
        actual_quantity: l.actual_quantity,
      })),
    };

    if (args.dry_run) {
      return preview(
        tool,
        "inv_stock_adjustment",
        "(未建立)",
        "count",
        {
          idempotency_key: args.idempotency_key ?? randomUUID(),
          options: data.options,
          rows: lines,
          summary: {
            with_difference: changed.length,
            skipped_no_difference: lines.length - changed.length,
            shrinkage: changed
              .filter((l) => l.difference < 0)
              .reduce((n, l) => n - l.difference, 0),
            surplus: changed.filter((l) => l.difference > 0).reduce((n, l) => n + l.difference, 0),
          },
          note: "差異以送出當下的庫存重算（這裡的 stock_now 是預覽當下讀到的）。是否需要審核由資料庫決定。",
        },
        auditChanges,
      );
    }
    await claimIdempotencyKey("record_stock_count", args.idempotency_key);
    const { recordStockCount } = await import("@/server/repos/inv-adjustments");
    const res = await commitOrAudit(
      tool,
      "inv_stock_adjustment",
      "(未建立)",
      "count",
      auditChanges,
      () => recordStockCount({ userId, rows: data.rows, options: data.options }),
    );
    return committed(
      tool,
      "inv_stock_adjustment",
      res.ids.length ? res.ids.join(",").slice(0, 200) : "(無差異)",
      "count",
      { written: res.created > 0, result: res },
      { ...auditChanges, result: res },
    );
  },

  async create_purchase(args) {
    const tool = "create_purchase";
    const userId = await oauthUserId(tool);
    const { invPurchaseSchema } = await import("@/lib/admin/schemas");
    const data = validateWith(invPurchaseSchema, {
      id: null,
      product_id: args.product_id,
      item_name: args.item_name ?? null,
      purchase_date: args.purchase_date ?? taipeiToday(),
      quantity: args.quantity,
      unit_cost: args.unit_cost ?? null,
      vendor_id: args.vendor_id ?? null,
      vendor: args.vendor ?? null,
      publisher: args.publisher ?? null,
      notes: args.notes ?? null,
      expiry_date: args.expiry_date ?? null,
      expiry_alert_days: args.expiry_alert_days ?? null,
    });
    const { getAdminProduct } = await import("@/server/repos/inv-products");
    const product = await getAdminProduct(data.product_id);
    if (!product) notFound("進銷存商品", data.product_id);

    const { id: _id, ...payload } = data;
    const willCreate = {
      product: { id: data.product_id, name: product.name, issue_number: product.issue_number },
      ...payload,
      subtotal: data.unit_cost === null ? null : data.unit_cost * data.quantity,
      stock_now: product.stock_quantity,
      note: "審核狀態由資料庫決定；不需審核（或核准後）庫存才會增加。",
    };
    if (args.dry_run) {
      return preview(
        tool,
        "inv_purchase",
        "(未建立)",
        "create",
        { idempotency_key: args.idempotency_key ?? randomUUID(), will_create: willCreate },
        payload,
      );
    }
    await claimIdempotencyKey("create_purchase", args.idempotency_key);
    const { savePurchase } = await import("@/server/repos/inv-purchases");
    const res = await commitOrAudit(tool, "inv_purchase", "(未建立)", "create", payload, () =>
      savePurchase({ userId, id: null, payload }),
    );
    return committed(
      tool,
      "inv_purchase",
      res.id,
      "create",
      { written: true, result: res },
      { ...payload, result: res },
    );
  },

  /* ============================================================ 文案與設定 */

  async get_ui_strings(args) {
    const { listUiStrings } = await import("@/server/repos/ui-strings");
    const all = await listUiStrings();
    const rows = args.group_key ? all.filter((r) => r.group_key === args.group_key) : all;
    return jsonText({
      count: rows.length,
      rows: rows.map((r) => ({
        group_key: r.group_key,
        string_key: r.string_key,
        value: r.value,
        sort_order: r.sort_order,
      })),
    });
  },

  async update_ui_string(args) {
    const tool = "update_ui_string";
    if (args.value === undefined && args.sort_order === undefined) {
      throw new McpInputError("value 與 sort_order 至少給一個。");
    }
    const { listUiStrings, updateUiString } = await import("@/server/repos/ui-strings");
    const cur = (await listUiStrings()).find(
      (r) => r.group_key === args.group_key && r.string_key === args.string_key,
    );
    if (!cur) notFound("介面文字", `${args.group_key}.${args.string_key}`);
    const { uiStringSchema } = await import("@/lib/admin/schemas");
    const next = validateWith(uiStringSchema, {
      group_key: cur.group_key,
      string_key: cur.string_key,
      value: args.value === undefined ? cur.value : mergeLocalized(cur.value, args.value),
      sort_order: args.sort_order ?? cur.sort_order,
    });
    const id = `${cur.group_key}.${cur.string_key}`;
    const changes = diff(
      cur as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
      ["value", "sort_order"],
    );
    if (Object.keys(changes).length === 0) {
      return jsonText({
        id,
        dry_run: args.dry_run,
        written: false,
        message: "沒有任何欄位改變，不需要寫入。",
      });
    }
    const warning = staleTranslationWarning(args.value)
      ? "只改了中文（或沒給齊英日文），沒給的語言保留原本的翻譯，可能與新中文不一致。"
      : undefined;
    if (args.dry_run) {
      return preview(tool, "ui_string", id, "update", { id, changes, warning }, changes);
    }
    const row = await commitOrAudit(tool, "ui_string", id, "update", changes, () =>
      updateUiString(next),
    );
    return committed(
      tool,
      "ui_string",
      id,
      "update",
      {
        id,
        written: true,
        changes,
        saved: { value: row.value, sort_order: row.sort_order },
        warning,
      },
      changes,
    );
  },

  async get_site_settings() {
    const { getSiteSettings } = await import("@/server/repos/site-settings");
    const row = (await getSiteSettings()) as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of SETTINGS_READABLE) out[k] = row[k];
    return jsonText({
      settings: out,
      updated_at: row.updated_at ?? null,
      note: "notify_emails 只能讀；匯款帳戶不在這裡。",
    });
  },

  async update_site_settings(args) {
    const tool = "update_site_settings";
    const { getSiteSettings, updateSiteSettings } = await import("@/server/repos/site-settings");
    const { siteSettingsSchema } = await import("@/lib/admin/schemas");
    const cur = await getSiteSettings();
    const curRec = cur as unknown as Record<string, unknown>;

    const merged: Record<string, unknown> = {};
    for (const k of SETTINGS_LOCALIZED) {
      const patch = args[k];
      merged[k] = patch === undefined ? cur[k] : mergeLocalized(cur[k], patch);
    }
    for (const k of SETTINGS_TEXT) merged[k] = args[k] ?? cur[k];
    // notify_emails：照現值帶回去（updateSiteSettings 一次寫整組），MCP 改不了它。
    merged.notify_emails = cur.notify_emails;

    const next = validateWith(siteSettingsSchema, merged);
    const changes = diff(curRec, next as unknown as Record<string, unknown>, [
      ...SETTINGS_LOCALIZED,
      ...SETTINGS_TEXT,
    ]);
    if (Object.keys(changes).length === 0) {
      return jsonText({
        dry_run: args.dry_run,
        written: false,
        message: "沒有任何欄位改變，不需要寫入。",
      });
    }
    const warning = SETTINGS_LOCALIZED.some((k) => staleTranslationWarning(args[k]))
      ? "有三語欄位只改了中文（或沒給齊英日文），沒給的語言保留原本的內容。"
      : undefined;
    if (args.dry_run) {
      return preview(tool, "site_settings", "1", "update", { changes, warning }, changes);
    }
    // 送進去的 notify_emails 是剛讀到的現值；若這中間後台有人改了它，這一次會把它寫回舊值——
    // 與後台設定頁存檔的行為相同（一次寫整組）。
    const row = await commitOrAudit(tool, "site_settings", "1", "update", changes, () =>
      updateSiteSettings(next),
    );
    return committed(
      tool,
      "site_settings",
      "1",
      "update",
      { written: true, changes, updated_at: row.updated_at, warning },
      changes,
    );
  },

  async get_email_copy(args) {
    const { loadEmailCopy } = await import("@/server/repos/email-outbox");
    const copy = await loadEmailCopy();
    const rows = Object.entries(copy)
      .map(([key, value]) => {
        const dot = key.indexOf(".");
        return { template_key: key.slice(0, dot), string_key: key.slice(dot + 1), value };
      })
      .filter((r) => !args.template_key || r.template_key === args.template_key)
      .sort((a, b) => (a.template_key + a.string_key < b.template_key + b.string_key ? -1 : 1));
    return jsonText({
      count: rows.length,
      rows,
      note: "後台沒有編輯通知信文案的頁面，MCP 也不提供修改。讀不到資料表時這裡會是空的。",
    });
  },
};

/* ------------------------------------------------------------------ 包裝 */

/**
 * 每一支都先用自己的 schema 再驗一次（SDK 已驗過時是 no-op；自檢直接呼叫時才有作用），
 * 輸入錯誤與 repo 例外一律回 isError 文字，不回協定錯誤。
 */
function wrap<N extends OpsWriteToolName>(name: N): (args: unknown) => Promise<TextResult> {
  const schema = OPS_WRITE_TOOL_INPUTS[name] as unknown as {
    safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown };
  };
  const impl = IMPL[name] as (args: unknown) => Promise<TextResult>;
  return async (raw: unknown) => {
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      return errText(`欄位驗證失敗：${zodIssuesText(parsed.error) ?? "格式不正確"}`);
    }
    try {
      return await impl(parsed.data);
    } catch (err) {
      if (err instanceof McpInputError) return errText(err.message);
      const zodText = zodIssuesText(err);
      if (zodText) return errText(`欄位驗證失敗：${zodText}`);
      console.error(`[mcp/ops-write] ${name} 失敗`, err instanceof Error ? err.message : err);
      return errText(`執行失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export const OPS_WRITE_HANDLERS = Object.fromEntries(
  (Object.keys(OPS_WRITE_TOOL_INPUTS) as OpsWriteToolName[]).map((n) => [n, wrap(n)]),
) as { [N in OpsWriteToolName]: (args: Args<N> | unknown) => Promise<TextResult> };

/** 寫入工具（readOnlyHint=false）的名單，給自檢與整合用。 */
export const OPS_WRITE_TOOLS = (Object.keys(OPS_WRITE_TOOL_META) as OpsWriteToolName[]).filter(
  (n) => OPS_WRITE_TOOL_META[n].annotations.readOnlyHint !== true,
);
