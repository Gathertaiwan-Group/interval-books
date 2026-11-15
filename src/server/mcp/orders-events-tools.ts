/**
 * MCP 工具 —— 訂單與活動（2026-11-15 擴充）：活動現場收款、出貨（可選寄出貨通知信）、封存訂單、
 * 場次與票種的新增／修改、活動內容區塊（新增／修改／排序）、Google 日曆立即同步。
 *
 * ── 一條規矩：寫入只走後台已經在用的那一支 ───────────────────────────────
 * 每一支寫入都呼叫後台 server fn（src/lib/admin/fns/*）背後同一支 repo／RPC：
 *   · 現場收款      = fns/onsite-collect.ts#markOnsiteOrderPaidStaff → admin_mark_order_paid()
 *   · 出貨          = fns/orders.ts#advanceOrderFulfillmentAdmin → advanceOrderFulfillment()
 *                     （＋ runFulfillmentWithNotify／triggerNotifyAfterShipped，只在要求寄信時）
 *   · 封存          = fns/orders.ts#archiveAdminOrder → admin_archive_order()
 *   · 場次／票種    = fns/event-sessions.ts#upsertEventSession／upsertEventSessionPlan
 *                     （＋ nudgeGoogleCalendarSync，與後台存檔相同）
 *   · 內容區塊      = fns/event-blocks.ts#upsertEventBlock／reorderEventBlocks
 *                     （排序走 admin_reorder_event_blocks()，一個交易）
 *   · 日曆立即同步  = fns/google-calendar.ts#syncGoogleCalendarNow → runGoogleCalendarSync("manual")
 * 這個檔案自己**沒有任何一句 update／insert／delete／rpc**；它只讀「改前」、用後台同一份 zod 規則
 * 驗輸入、算出差異給 AI 看，dry_run=false 才呼叫 repo，預覽與寫入都記 mcp_audit_log。
 *
 * ── 身分與權限 ─────────────────────────────────────────────────────────────
 * 寫入一律要 OAuth 管理員身分（靜態 token 拒絕）：後台這幾顆按鈕都是 adminFnMiddleware
 * （現場收款是 staffFnMiddleware("event.onsite.collect")，admin 自動擁有），MCP 的 OAuth
 * 在 http.ts 每次都重查 profiles 確認是 active admin，所以權限與後台相同；actor 一律傳
 * 那位 admin 的 user_id，不送假 UUID。
 *
 * ── 寄信 ───────────────────────────────────────────────────────────────────
 * 會寄給客人的兩支（collect_onsite_payment、ship_order）預設**不寄**；notify_customer=true
 * 才與後台按鈕一樣立刻排信並試寄。
 *   · 現場收款不寄時：付款成功信仍會由既有排程（notify_backlog）稍後補排——與 mark_order_paid
 *     相同，這是付款流程本身的行為，這裡不改它，工具回應會講明。
 *   · 出貨不寄時：出貨通知信沒有排程補寄（與 update_order_fulfillment 相同）。
 *
 * ── 不做的東西 ─────────────────────────────────────────────────────────────
 * 刪除場次／票種／內容區塊／訂單、Google 日曆連線與中斷、改名額計數（seats_taken／units_taken
 * 只由加鎖 RPC 維護，repo 本來就不收這兩欄）。
 *
 * repos 一律在 handler 裡 dynamic import，這個模組載入時不碰 Supabase。
 */
import { randomUUID } from "node:crypto";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { z as z3 } from "zod";
import { z } from "zod4";
import {
  CONFIRM_ARGS_NEXT_STEP,
  confirmArgs,
  errText,
  fillLocalized,
  jsonText,
  McpInputError,
  stableStringify,
  writeTimeNote,
  zodIssuesText,
  type Localized,
  type LocalizedArg,
  type TextResult,
  type Translator,
} from "./core";
import { EVENT_BLOCK_KINDS } from "@/lib/event-blocks";

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
/** 會寄信給客人（notify_customer=true 時）的寫入。 */
const WRITE_MAY_EMAIL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const CREATE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** 寫到外部服務（Google 日曆）。 */
const EXTERNAL_SYNC: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/* ------------------------------------------------------------------ 共用 arg */

const dryRunArg = z
  .boolean()
  .default(true)
  .describe(
    "預設 true：只回傳會改什麼，不寫入。確認後用同樣參數加 dry_run=false 再呼叫一次才會寫入。",
  );

const orderRef = {
  order_id: z.string().trim().uuid().optional().describe("orders.id（UUID）"),
  order_no: z.string().trim().min(1).max(40).optional().describe("訂單編號（與 order_id 二選一）"),
};
const oneOrderRef = (v: { order_id?: string; order_no?: string }) =>
  Boolean(v.order_id) !== Boolean(v.order_no);
const ONE_ORDER_REF_MSG = "order_id 與 order_no 要給其中一個";

const notifyCustomerArg = (what: string) =>
  z
    .boolean()
    .default(false)
    .describe(
      `預設 false＝不寄。true＝與後台按鈕一樣，寫入成功後立刻寄${what}給訂購人（真的會寄到客人信箱）。`,
    );

/**
 * 三語：一段中文（en/ja 自動翻譯），或 {zh, en?, ja?}。
 *
 * en/ja 上限是中文的 3 倍（與 create-tools.ts#localizedText 同一規則）：英日文常比中文長，
 * 若與中文同上限，預覽自動翻譯出來的 confirm_args 原樣送回會被 schema 擋下，「預覽＝寫入」失效。
 */
const localizedArg = (what: string, max = 2000) =>
  z
    .union([
      z.string().trim().min(1).max(max),
      z.object({
        zh: z.string().trim().min(1).max(max),
        en: z
          .string()
          .trim()
          .max(max * 3, `${what}的英文最多 ${max * 3} 字`)
          .optional(),
        ja: z
          .string()
          .trim()
          .max(max * 3, `${what}的日文最多 ${max * 3} 字`)
          .optional(),
      }),
    ])
    .describe(`${what}：一段中文（英日文自動翻譯），或 {"zh","en","ja"}`);

/** 台北時間：YYYY-MM-DD HH:mm（或 T 分隔），也接受帶時區的 ISO。 */
const dateTimeArg = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe(`${what}（台北時間 YYYY-MM-DD HH:mm，例如 2026-12-05 19:30）`);

const idempotencyKeyArg = z
  .string()
  .trim()
  .uuid()
  .optional()
  .describe(
    "防重複送出的 UUID。dry_run=false 時必填：先用 dry_run=true 預覽取得一組，正式送出帶同一組；同一組只會建立一次。",
  );

const blockIdArg = z.number().int().positive();

/* ------------------------------------------------------------------ 輸入 schema */

export const ORDERS_EVENTS_TOOL_INPUTS = {
  /* ---- 訂單 ---- */
  collect_onsite_payment: z
    .object({
      ...orderRef,
      note: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("備註，例如「現場收現金」（存進付款紀錄）"),
      notify_customer: notifyCustomerArg("付款成功信"),
      dry_run: dryRunArg,
    })
    .refine(oneOrderRef, ONE_ORDER_REF_MSG),
  ship_order: z
    .object({
      ...orderRef,
      notify_customer: notifyCustomerArg("出貨通知信"),
      dry_run: dryRunArg,
    })
    .refine(oneOrderRef, ONE_ORDER_REF_MSG),
  archive_order: z
    .object({
      ...orderRef,
      archived: z
        .boolean()
        .default(true)
        .describe("true 封存（預設）／false 取消封存。只是列表顯示狀態，不動名額與任何紀錄。"),
      dry_run: dryRunArg,
    })
    .refine(oneOrderRef, ONE_ORDER_REF_MSG),

  /* ---- 場次與票種 ---- */
  list_event_sessions: z.object({
    product_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "活動／策旅的票券商品 id（get_event 的 ticket_product.id、list_phone_order_options）",
      ),
    keyword: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("用活動／策旅名稱篩選（中文名稱包含這段字）"),
    include_ended: z.boolean().default(false).describe("預設 false：只列還沒結束的場次"),
  }),
  create_event_session: z.object({
    product_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("活動／策旅的票券商品 id（見 list_event_sessions）"),
    title: localizedArg("場次名稱", 200),
    location: localizedArg("地點", 500),
    starts_at: dateTimeArg("開始時間"),
    ends_at: dateTimeArg("結束時間").optional(),
    capacity: z.number().int().min(0).max(100000).describe("名額（人數）"),
    status: z
      .enum(["open", "closed"])
      .default("closed")
      .describe("報名狀態：open 開放報名／closed 未開放（預設，與後台新增場次相同）"),
    sort_order: z.number().int().optional().describe("排序；省略＝排在最後（與後台相同）"),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
  update_event_session: z
    .object({
      session_id: z.string().trim().uuid().describe("場次 id（見 list_event_sessions）"),
      title: localizedArg("場次名稱", 200).optional(),
      location: localizedArg("地點", 500).optional(),
      starts_at: dateTimeArg("開始時間").optional(),
      ends_at: dateTimeArg("結束時間").nullable().optional().describe("null＝清空結束時間"),
      capacity: z.number().int().min(0).max(100000).optional().describe("名額；不能低於已報名人數"),
      status: z.enum(["open", "closed"]).optional().describe("報名狀態：open 開放／closed 關閉"),
      sort_order: z.number().int().optional(),
      dry_run: dryRunArg,
    })
    .refine(
      (v) =>
        [v.title, v.location, v.starts_at, v.ends_at, v.capacity, v.status, v.sort_order].some(
          (x) => x !== undefined,
        ),
      "至少給一個要改的欄位",
    ),
  create_ticket_type: z.object({
    session_id: z.string().trim().uuid().describe("場次 id（見 list_event_sessions）"),
    title: localizedArg("票種名稱", 200),
    price: z.number().int().min(0).max(10_000_000).describe("票價（新台幣元，整數）"),
    seats_per_unit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(1)
      .describe("每張票佔幾個名額（雙人票＝2），預設 1"),
    capacity: z.number().int().min(0).max(100000).describe("可售張數"),
    sale_starts_at: dateTimeArg("開賣時間").optional().describe("省略＝不限"),
    sale_ends_at: dateTimeArg("停售時間").optional().describe("省略＝不限"),
    status: z.enum(["open", "closed"]).default("open").describe("open 販售中（預設）／closed 停售"),
    sort_order: z.number().int().optional().describe("排序；省略＝排在這一場的最後"),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
  update_ticket_type: z
    .object({
      ticket_type_id: z.string().trim().uuid().describe("票種 id（見 list_event_sessions）"),
      title: localizedArg("票種名稱", 200).optional(),
      price: z.number().int().min(0).max(10_000_000).optional().describe("票價（新台幣元）"),
      seats_per_unit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("每張票佔幾個名額。已售張數 > 0 時不能改（另開票種）"),
      capacity: z
        .number()
        .int()
        .min(0)
        .max(100000)
        .optional()
        .describe("可售張數；不能低於已售張數"),
      sale_starts_at: dateTimeArg("開賣時間").nullable().optional().describe("null＝不限"),
      sale_ends_at: dateTimeArg("停售時間").nullable().optional().describe("null＝不限"),
      status: z.enum(["open", "closed"]).optional(),
      sort_order: z.number().int().optional(),
      dry_run: dryRunArg,
    })
    .refine(
      (v) =>
        [
          v.title,
          v.price,
          v.seats_per_unit,
          v.capacity,
          v.sale_starts_at,
          v.sale_ends_at,
          v.status,
          v.sort_order,
        ].some((x) => x !== undefined),
      "至少給一個要改的欄位",
    ),

  /* ---- 活動內容區塊 ---- */
  list_event_blocks: z.object({
    event_id: z.string().trim().min(1).max(200).describe("events.id（見 list_events／get_event）"),
  }),
  create_event_block: z.object({
    event_id: z.string().trim().min(1).max(200).describe("events.id"),
    kind: z
      .enum(EVENT_BLOCK_KINDS)
      .describe("faq 常見問答（問／答）／info_row 資訊列（標籤／值）／agenda 流程（時間／內容）"),
    title: localizedArg("標題（問題／標籤／時間）", 500),
    body: localizedArg("內容（答案／值／流程說明）", 2000),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
  update_event_block: z
    .object({
      event_id: z.string().trim().min(1).max(200).describe("events.id"),
      block_id: blockIdArg.describe("區塊 id（見 list_event_blocks）"),
      title: localizedArg("標題", 500).optional(),
      body: localizedArg("內容", 2000).optional(),
      dry_run: dryRunArg,
    })
    .refine((v) => v.title !== undefined || v.body !== undefined, "title、body 至少給一個"),
  reorder_event_blocks: z.object({
    event_id: z.string().trim().min(1).max(200).describe("events.id"),
    kind: z.enum(EVENT_BLOCK_KINDS).describe("要排序的那一種區塊"),
    block_ids: z
      .array(blockIdArg)
      .min(1)
      .max(200)
      .describe("這一種區塊的**完整** id 清單，依新順序由上到下（見 list_event_blocks）"),
    dry_run: dryRunArg,
  }),

  /* ---- Google 日曆 ---- */
  sync_google_calendar: z.object({
    dry_run: z
      .boolean()
      .default(true)
      .describe("預設 true：只回目前連線與上次同步狀態，不同步。dry_run=false 才立即同步。"),
  }),
} as const;

export type OrdersEventsToolName = keyof typeof ORDERS_EVENTS_TOOL_INPUTS;
type Args<N extends OrdersEventsToolName> = z.output<(typeof ORDERS_EVENTS_TOOL_INPUTS)[N]>;

/* ------------------------------------------------------------------ meta */

const PREVIEW =
  "預設 dry_run=true 只預覽；dry_run=false 才寫入。預覽與寫入都會記稽核。需要 OAuth 管理員身分。";

export const ORDERS_EVENTS_TOOL_META: Record<
  OrdersEventsToolName,
  { title: string; description: string; annotations: ToolAnnotations }
> = {
  collect_onsite_payment: {
    title: "活動現場收款",
    description:
      "把「現場付款」的報名訂單標成已收款＝後台名單頁的「標記已收款」（markOnsiteOrderPaidStaff → admin_mark_order_paid）。" +
      "只限付款方式是現場付款（onsite）的待付款訂單；匯款單請用 mark_order_paid。" +
      "notify_customer 預設 false＝這裡不寄信（付款成功信仍會由既有排程稍後補寄，同 mark_order_paid）；true＝與後台一樣立刻寄。" +
      PREVIEW,
    annotations: WRITE_MAY_EMAIL,
  },
  ship_order: {
    title: "標記已出貨（可選寄出貨通知信）",
    description:
      "與後台訂單內頁「標記已出貨」同一支（advanceOrderFulfillment：處理中→已出貨，宅配／超商，只限已付款）。" +
      "notify_customer 預設 false＝不寄；true＝與後台按鈕相同，這一次真的從處理中變已出貨才排出貨通知信（同一張單只會寄一封）。" +
      "門市自取、已出貨→已完成請用 update_order_fulfillment。" +
      PREVIEW,
    annotations: WRITE_MAY_EMAIL,
  },
  archive_order: {
    title: "封存／取消封存訂單",
    description:
      "＝後台訂單內頁「封存／取消封存」（admin_archive_order）。只設 orders.archived_at：不動名額、付款、發票，隨時可取消封存。" +
      "與後台相同只對已付款訂單提供；不提供刪除訂單。" +
      PREVIEW,
    annotations: WRITE,
  },
  list_event_sessions: {
    title: "活動場次與票種（含 id）",
    description:
      "與後台「報名管理」同一份資料：每個活動／策旅商品的場次（時間、地點、名額、已報名、報名狀態、排序）與票種（票價、每張佔位、可售張數、已售、販售期間、狀態）。" +
      "改場次／票種前先用這支取 id。",
    annotations: READ_ONLY,
  },
  create_event_session: {
    title: "新增場次",
    description:
      "＝後台「新增場次」（upsertEventSession）。新場次預設 closed（未開放），確認後再用 update_event_session 開放。" +
      "存檔後與後台一樣通知 Google 日曆同步。不能刪除場次。" +
      PREVIEW,
    annotations: CREATE,
  },
  update_event_session: {
    title: "修改場次",
    description:
      "＝後台場次編輯頁「儲存」（upsertEventSession）：日期時間、地點、名稱、名額、報名狀態（open／closed）、排序。只送要改的欄位。" +
      "名額不能低於已報名人數（資料庫也會擋）；已報名人數不能改。" +
      "⚠️ 已有報名者時改日期／開始時間：系統不會自動通知報名者（不寄改期信），預覽會提醒；開課提醒信會依新的時間寄出。" +
      PREVIEW,
    annotations: WRITE,
  },
  create_ticket_type: {
    title: "新增票種",
    description:
      "＝後台場次頁「新增方案」（upsertEventSessionPlan）：名稱、票價、每張佔幾個名額、可售張數、販售期間、狀態。" +
      PREVIEW,
    annotations: CREATE,
  },
  update_ticket_type: {
    title: "修改票種",
    description:
      "＝後台場次頁方案「編輯」（upsertEventSessionPlan）。只送要改的欄位；可售張數不能低於已售張數。改票價只影響之後的訂單。" +
      "已售出（已售張數 > 0）的票種不能改「每張票佔幾個名額」（seats_per_unit）：已成立訂單佔的名額是照舊值算的，改了會讓名額帳對不起來——要不同人數請另開一個票種。" +
      PREVIEW,
    annotations: WRITE,
  },
  list_event_blocks: {
    title: "活動內容區塊",
    description:
      "列出一場活動的內容區塊（faq 常見問答／info_row 資訊列／agenda 流程），依種類與順序，含 id。",
    annotations: READ_ONLY,
  },
  create_event_block: {
    title: "新增活動內容區塊",
    description:
      "＝後台活動編輯頁區塊編輯器「新增」（upsertEventBlock）。新的一列排在同種類的最後；要換位置再用 reorder_event_blocks。" +
      PREVIEW,
    annotations: CREATE,
  },
  update_event_block: {
    title: "修改活動內容區塊",
    description:
      "＝區塊編輯器「編輯」（upsertEventBlock）：只改標題與內容，不改種類與順序。" + PREVIEW,
    annotations: WRITE,
  },
  reorder_event_blocks: {
    title: "活動內容區塊排序",
    description:
      "＝區塊編輯器的上移／下移（reorderEventBlocks → admin_reorder_event_blocks，一個交易）。" +
      "block_ids 要給那一種區塊的完整清單（新順序）。排序不刪任何區塊；不提供刪除。" +
      PREVIEW,
    annotations: WRITE,
  },
  sync_google_calendar: {
    title: "Google 日曆立即同步",
    description:
      "＝後台 /admin/google-calendar 的「立即同步」（runGoogleCalendarSync manual）：把站上活動場次寫進已連結的 Google 日曆。" +
      "dry_run=true 只看連線與上次同步結果。不提供連線／中斷連線。需要 OAuth 管理員身分。",
    annotations: EXTERNAL_SYNC,
  },
};

/* ------------------------------------------------------------------ 小工具 */

const NEXT_STEP = "這只是預覽，還沒有寫入。確認無誤後，用同樣的參數加上 dry_run=false 再呼叫一次。";

function notFound(what: string, id: string): never {
  throw new McpInputError(`找不到${what}「${id}」。請先用對應的 list_*／get_* 工具查 id。`);
}

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

/** 只列出真的有變的欄位。 */
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

/**
 * 台北時間 → ISO（UTC）。接受 `YYYY-MM-DD HH:mm`、`YYYY-MM-DDTHH:mm(:ss)`（視為台北），
 * 或帶 Z／±hh:mm 的完整 ISO。
 */
export function taipeiToIso(field: string, text: string): string {
  const t = text.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(t);
  const iso = local
    ? `${local[1]}T${local[2]}${local[3] ?? ":00"}+08:00`
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(t)
      ? t
      : null;
  const ms = iso ? Date.parse(iso) : NaN;
  if (!iso || Number.isNaN(ms)) {
    throw new McpInputError(`${field}：時間格式是 YYYY-MM-DD HH:mm（台北時間），收到「${text}」`);
  }
  return new Date(ms).toISOString();
}

/** 顯示用的台北時間（Vercel 是 UTC，不用 toLocaleString）。 */
function taipeiText(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(Date.parse(iso) + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 翻譯函式借用 tools.ts 那一支（translate-selftest 守著只有 tools.ts 能匯入 @/server/translate）。
 * dynamic import：tools.ts 靜態匯入這個檔案，執行到這裡時它早已載入完成。
 */
async function translator(): Promise<Translator | null> {
  const { translator: shared } = await import("./tools");
  return await shared();
}

/** 把有給的三語欄位補齊；回補好的值與「哪幾欄是自動翻譯」。 */
async function fillAll(
  fields: Record<string, LocalizedArg | undefined>,
): Promise<{ values: Record<string, Localized>; translated: string[] }> {
  const values: Record<string, Localized> = {};
  const translated: string[] = [];
  let t: Translator | null | undefined;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const needs = typeof v === "string" || !(v.en?.trim() && v.ja?.trim());
    if (needs && t === undefined) t = await translator();
    const r = await fillLocalized(k, v, t ?? null);
    values[k] = r.value;
    if (r.translated) translated.push(k);
  }
  return { values, translated };
}

/**
 * 已有報名者的場次改了開始日期／時間：預覽與結果都要明講（審查 2026-11-15）。
 * 開課提醒信（sessions_due_for_reminder）是照 starts_at 撈的，所以會跟著新時間；
 * 去重靠 dedupe_key，改期前已寄過提醒的人不會再收到一次。
 */
export function rescheduleWarning(
  seatsTaken: number,
  beforeIso: string | null,
  afterIso: string | null,
): string | undefined {
  if (seatsTaken <= 0 || beforeIso === afterIso) return undefined;
  return (
    `⚠️ 這一場已有 ${seatsTaken} 位報名，開始時間會從 ${taipeiText(beforeIso)} 改成 ${taipeiText(afterIso)}（台北）。` +
    "系統不會自動通知報名者改期（不會寄改期信），請另外聯絡他們（get_session_roster 看名單）；" +
    "開課提醒信會依新的開始時間寄出（改期前已寄過提醒的人不會再收到一次）。請先讓使用者確認再送出。"
  );
}

/* ---- 稽核 ---- */

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

async function preview(
  tool: string,
  entity: string,
  entityId: string,
  action: string,
  body: Record<string, unknown>,
  auditChanges: unknown,
): Promise<TextResult> {
  await audit(tool, entity, entityId, action, auditChanges, true);
  return jsonText({
    dry_run: true,
    written: false,
    action,
    ...body,
    next_step: typeof body.next_step === "string" ? body.next_step : NEXT_STEP,
  });
}

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

/** 寫入（含預覽）一律要 OAuth 管理員：後台這幾支都只收登入的 admin，actor 要是真人。 */
async function oauthUserId(tool: string): Promise<string> {
  const { currentMcpActor } = await import("./actor");
  const actor = currentMcpActor();
  if (actor?.via === "oauth") return actor.user_id;
  throw new McpInputError(
    `${tool} 需要 OAuth 管理員身分：後台這個動作只開放登入的管理員，靜態 token 沒有對應的使用者。` +
      "請改用 claude.ai／ChatGPT 連接器（OAuth）登入的連線。",
  );
}

/** dry_run=false 的建立動作：佔用 idempotency_key（同 ops-write-tools.ts，30 天一次性）。 */
async function claimIdempotencyKey(tool: string, key: string | undefined): Promise<void> {
  if (!key) {
    throw new McpInputError(
      "dry_run=false 時 idempotency_key 必填：先用 dry_run=true 預覽取得一組，正式送出時帶同一組。",
    );
  }
  const { dbOAuthStore } = await import("./oauth-store");
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
  archived_at: string | null;
  total: number;
};

const ORDER_FACT_COLUMNS =
  "id, order_no, status, payment_status, payment_method, paid_at, shipping_method, shipped_at, completed_at, archived_at, total";

async function loadOrderFacts(ref: { order_id?: string; order_no?: string }): Promise<OrderFacts> {
  const { supabaseAdmin } = await import("@/server/supabase-admin");
  let q = supabaseAdmin().from("orders").select(ORDER_FACT_COLUMNS);
  q = ref.order_id ? q.eq("id", ref.order_id) : q.eq("order_no", ref.order_no ?? "");
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`訂單讀取失敗：${error.code}`);
  if (!data) notFound("訂單", ref.order_id ?? ref.order_no ?? "");
  return data as unknown as OrderFacts;
}

/* ---- 場次 ---- */

async function loadSession(id: string) {
  const { getEventSessionById } = await import("@/server/repos/event-sessions");
  const row = await getEventSessionById(id);
  if (!row) notFound("場次", id);
  return row;
}

const SESSION_KEYS = [
  "product_id",
  "title",
  "location",
  "starts_at",
  "ends_at",
  "capacity",
  "status",
  "sort_order",
] as const;
const PLAN_KEYS = [
  "session_id",
  "title",
  "price",
  "seats_per_unit",
  "capacity",
  "sale_starts_at",
  "sale_ends_at",
  "status",
  "sort_order",
] as const;

function pick<T extends Record<string, unknown>>(row: T, keys: readonly string[]) {
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null])) as Record<string, unknown>;
}

async function nudgeCalendar(): Promise<void> {
  // 與後台 upsertEventSession／upsertEventSessionPlan 相同：非阻塞、永不 throw。
  await (await import("@/server/google-calendar")).nudgeGoogleCalendarSync();
}

/* ---- 區塊 ---- */

async function requireEvent(eventId: string) {
  const { getEventById } = await import("@/server/repos/events");
  const row = await getEventById(eventId);
  if (!row) notFound("活動", eventId);
  return row;
}

/* ------------------------------------------------------------------ handlers */

type Handlers = { [N in OrdersEventsToolName]: (args: Args<N>) => Promise<TextResult> };

const IMPL: Handlers = {
  /* ============================================================ 訂單 */

  async collect_onsite_payment(args) {
    const tool = "collect_onsite_payment";
    const actorId = await oauthUserId(tool);
    const o = await loadOrderFacts(args);
    const target = { order_id: o.id, order_no: o.order_no, total: o.total };

    if (o.payment_method !== "onsite") {
      throw new McpInputError(
        `訂單 ${o.order_no} 的付款方式不是現場付款（目前 ${o.payment_method ?? "未指定"}），後台現場收款只收 onsite 的單。` +
          "匯款或「店家另行聯繫付款」的單請用 mark_order_paid。",
      );
    }
    if (o.payment_status === "paid") {
      return jsonText({
        ...target,
        dry_run: args.dry_run,
        written: false,
        message: "這張訂單已經是已收款，不需要再標記。",
      });
    }
    if (o.status !== "pending") {
      throw new McpInputError(
        `訂單 ${o.order_no} 的狀態是 ${o.status}，不是待付款（pending），不能標記已收款（可能已取消）。`,
      );
    }

    const note = args.note && args.note.trim() ? args.note.trim() : null;
    const changes = {
      payment_status: { before: o.payment_status, after: "paid" },
      status: { before: o.status, after: "processing" },
      paid_at: { before: o.paid_at, after: "（寫入當下的時間）" },
    };
    const emailPlan = args.notify_customer
      ? "寫入成功後立刻寄付款成功信給訂購人（與後台按鈕相同）"
      : "MCP 這裡不寄；付款成功信會由既有排程（notify_backlog）稍後補寄，與 mark_order_paid 相同";
    const auditChanges = {
      ...target,
      payment_method: o.payment_method,
      note,
      notify_customer: args.notify_customer,
      changes,
    };

    if (args.dry_run) {
      return preview(
        tool,
        "order",
        o.id,
        "collect_onsite",
        { ...target, changes, note, email: emailPlan },
        auditChanges,
      );
    }

    const { markOrderPaidByAdmin } = await import("@/server/repos/orders-admin");
    const result = await commitOrAudit(tool, "order", o.id, "collect_onsite", auditChanges, () =>
      markOrderPaidByAdmin({ orderId: o.id, actorId, note }),
    );
    let email: unknown = result.marked ? emailPlan : "沒有寫入，不寄信";
    if (result.reason === "marked" && args.notify_customer) {
      const { triggerNotifyAfterPayment } = await import("@/server/notify");
      const outcome = await triggerNotifyAfterPayment(o.id);
      email = outcome.ok
        ? "已排入付款成功信並試寄"
        : `已收款，但付款成功信排入失敗（${outcome.reason}），排程會再補`;
    }
    return committed(
      tool,
      "order",
      o.id,
      "collect_onsite",
      { ...target, written: result.marked, result, email },
      { ...auditChanges, result: result.reason },
    );
  },

  async ship_order(args) {
    const tool = "ship_order";
    const actorId = await oauthUserId(tool);
    const { FULFILLMENT_TRANSITIONS, canApply, classifyAfterNoop, STATUS_LABEL_ZH } =
      await import("@/lib/admin/order-fulfillment");
    const o = await loadOrderFacts(args);
    const t = FULFILLMENT_TRANSITIONS.ship;
    const target = { order_id: o.id, order_no: o.order_no };

    if (!canApply("ship", o)) {
      if (classifyAfterNoop("ship", o) === "already_done") {
        return jsonText({
          ...target,
          dry_run: args.dry_run,
          written: false,
          message: `這張訂單已經是「${STATUS_LABEL_ZH[o.status] ?? o.status}」，不需要再做，也不會寄信。`,
        });
      }
      throw new McpInputError(
        `訂單 ${o.order_no} 不能標記已出貨：需要已付款（目前 ${o.payment_status}）、` +
          `狀態是「${STATUS_LABEL_ZH[t.from]}」（目前「${STATUS_LABEL_ZH[o.status] ?? o.status}」）、` +
          `收件方式是 ${t.methods.join("／")}（目前 ${o.shipping_method}）。`,
      );
    }

    const changes = {
      status: { before: o.status, after: t.to },
      shipped_at: { before: o.shipped_at, after: "（寫入當下的時間）" },
    };
    const emailPlan = args.notify_customer
      ? "寫入成功後寄出貨通知信給訂購人（與後台按鈕相同，同一張單只會寄一封）"
      : "不寄出貨通知信（notify_customer=false）";
    const auditChanges = { ...target, notify_customer: args.notify_customer, changes };

    if (args.dry_run) {
      return preview(
        tool,
        "order",
        o.id,
        "ship",
        { ...target, changes, email: emailPlan },
        auditChanges,
      );
    }

    const { advanceOrderFulfillment } = await import("@/server/repos/order-fulfillment");
    const advance = () => advanceOrderFulfillment({ orderId: o.id, actorId, action: "ship" });
    if (!args.notify_customer) {
      const result = await commitOrAudit(tool, "order", o.id, "ship", auditChanges, advance);
      return committed(
        tool,
        "order",
        o.id,
        "ship",
        { ...target, written: result.updated, result, email: emailPlan },
        { ...auditChanges, result: result.reason },
      );
    }

    const { runFulfillmentWithNotify, shouldSendShippedEmail } =
      await import("@/lib/admin/order-fulfillment");
    const result = await commitOrAudit(tool, "order", o.id, "ship", auditChanges, () =>
      runFulfillmentWithNotify("ship", {
        advance,
        notifyShipped: async () => {
          const { triggerNotifyAfterShipped } = await import("@/server/notify");
          return await triggerNotifyAfterShipped(o.id);
        },
        onNotifyError: (message) =>
          console.error(`[mcp/orders-events] 出貨通知信例外 order=${o.id}：${message}`),
      }),
    );
    const sent = shouldSendShippedEmail("ship", result.reason);
    return committed(
      tool,
      "order",
      o.id,
      "ship",
      {
        ...target,
        written: result.updated,
        result,
        email: sent
          ? (result.notify_warning ?? "已排入出貨通知信")
          : "這一次沒有真的改狀態，不寄信",
      },
      {
        ...auditChanges,
        result: result.reason,
        email_sent: sent,
        notify_warning: result.notify_warning,
      },
    );
  },

  async archive_order(args) {
    const tool = "archive_order";
    const actorId = await oauthUserId(tool);
    const o = await loadOrderFacts(args);
    const target = { order_id: o.id, order_no: o.order_no };
    if (o.payment_status !== "paid") {
      throw new McpInputError(
        `訂單 ${o.order_no} 還沒付款（${o.payment_status}）。後台只對已付款訂單提供封存；未付款的單在後台是用刪除處理（MCP 不提供刪除）。`,
      );
    }
    const isArchived = Boolean(o.archived_at);
    if (isArchived === args.archived) {
      return jsonText({
        ...target,
        dry_run: args.dry_run,
        written: false,
        message: args.archived ? "這張訂單已經是封存狀態。" : "這張訂單沒有被封存。",
      });
    }
    const changes = {
      archived_at: {
        before: o.archived_at,
        after: args.archived ? "（寫入當下的時間）" : null,
      },
    };
    const action = args.archived ? "archive" : "unarchive";
    const auditChanges = { ...target, archived: args.archived, changes };
    if (args.dry_run) {
      return preview(tool, "order", o.id, action, { ...target, changes }, auditChanges);
    }
    const { archiveAdminOrder } = await import("@/server/repos/orders-admin");
    const result = await commitOrAudit(tool, "order", o.id, action, auditChanges, () =>
      archiveAdminOrder({ orderId: o.id, actorId, archived: args.archived }),
    );
    return committed(
      tool,
      "order",
      o.id,
      action,
      { ...target, written: result.updated, result },
      { ...auditChanges, result: result.reason },
    );
  },

  /* ============================================================ 場次與票種 */

  async list_event_sessions(args) {
    const repo = await import("@/server/repos/event-sessions");
    const [products, sessions, plans] = await Promise.all([
      repo.listBookableProducts(),
      repo.listEventSessions(),
      repo.listEventSessionPlans(),
    ]);
    const kw = args.keyword?.toLowerCase() ?? null;
    const now = Date.now();
    const picked = products.filter(
      (p) =>
        (!args.product_id || p.id === args.product_id) &&
        (!kw || (p.title?.zh ?? "").toLowerCase().includes(kw)),
    );
    if (args.product_id && picked.length === 0) notFound("活動／策旅商品", args.product_id);
    const out = picked
      .map((p) => ({
        product_id: p.id,
        title: p.title?.zh ?? "",
        product_type: p.product_type,
        status: p.status,
        sessions: sessions
          .filter((s) => s.product_id === p.id)
          .filter(
            (s) => args.include_ended || Date.parse(s.ends_at ?? s.starts_at) >= now - 86_400_000,
          )
          .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
          .map((s) => ({
            session_id: s.id,
            title: s.title,
            location: s.location,
            starts_at: taipeiText(s.starts_at),
            ends_at: taipeiText(s.ends_at),
            capacity: s.capacity,
            seats_taken: s.seats_taken,
            status: s.status,
            sort_order: s.sort_order,
            ticket_types: plans
              .filter((pl) => pl.session_id === s.id)
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((pl) => ({
                ticket_type_id: pl.id,
                title: pl.title,
                price: pl.price,
                seats_per_unit: pl.seats_per_unit,
                capacity: pl.capacity,
                units_taken: pl.units_taken,
                sale_starts_at: taipeiText(pl.sale_starts_at),
                sale_ends_at: taipeiText(pl.sale_ends_at),
                status: pl.status,
                sort_order: pl.sort_order,
              })),
          })),
      }))
      .filter((p) => args.product_id || p.sessions.length > 0);
    return jsonText({ count: out.length, times: "台北時間", products: out });
  },

  async create_event_session(args) {
    const tool = "create_event_session";
    await oauthUserId(tool);
    const repo = await import("@/server/repos/event-sessions");
    const [products, sessions] = await Promise.all([
      repo.listBookableProducts(),
      repo.listEventSessions(),
    ]);
    const product = products.find((p) => p.id === args.product_id);
    if (!product) notFound("活動／策旅商品", args.product_id);
    const { values, translated } = await fillAll({ title: args.title, location: args.location });
    const { eventSessionSchema } = await import("@/lib/admin/schemas");
    const input = validateWith(eventSessionSchema, {
      product_id: product.id,
      title: values.title,
      location: values.location,
      starts_at: taipeiToIso("starts_at", args.starts_at),
      ends_at: args.ends_at ? taipeiToIso("ends_at", args.ends_at) : null,
      capacity: args.capacity,
      status: args.status,
      sort_order: args.sort_order ?? sessions.reduce((m, s) => Math.max(m, s.sort_order), 0) + 1,
    });
    const willCreate = {
      ...input,
      product_title: product.title?.zh ?? "",
      starts_at_taipei: taipeiText(input.starts_at),
      ends_at_taipei: taipeiText(input.ends_at ?? null),
    };
    const auditChanges = { will_create: input, auto_translated: translated };

    if (args.dry_run) {
      const key = args.idempotency_key ?? randomUUID();
      return preview(
        tool,
        "event_session",
        product.id,
        "create",
        {
          will_create: willCreate,
          auto_translated: translated.length ? translated : undefined,
          idempotency_key: key,
          confirm_args: confirmArgs(args, {
            ...values,
            sort_order: input.sort_order,
            idempotency_key: key,
          }),
          next_step: CONFIRM_ARGS_NEXT_STEP,
        },
        { ...auditChanges, idempotency_key: key },
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const row = await commitOrAudit(tool, "event_session", product.id, "create", auditChanges, () =>
      repo.upsertEventSession(input),
    );
    await nudgeCalendar();
    return committed(
      tool,
      "event_session",
      row.id,
      "create",
      { written: true, session_id: row.id, session: row, write_note: writeTimeNote(translated) },
      { ...auditChanges, session_id: row.id, idempotency_key: args.idempotency_key },
    );
  },

  async update_event_session(args) {
    const tool = "update_event_session";
    await oauthUserId(tool);
    const cur = await loadSession(args.session_id);
    const { values, translated } = await fillAll({ title: args.title, location: args.location });
    const next = {
      id: cur.id,
      product_id: cur.product_id,
      title: values.title ?? cur.title,
      location: values.location ?? cur.location,
      starts_at:
        args.starts_at !== undefined ? taipeiToIso("starts_at", args.starts_at) : cur.starts_at,
      ends_at:
        args.ends_at === undefined
          ? cur.ends_at
          : args.ends_at === null
            ? null
            : taipeiToIso("ends_at", args.ends_at),
      capacity: args.capacity ?? cur.capacity,
      status: args.status ?? cur.status,
      sort_order: args.sort_order ?? cur.sort_order,
    };
    if (next.capacity < cur.seats_taken) {
      throw new McpInputError(
        `名額不能低於已報名人數：這一場已經有 ${cur.seats_taken} 位，收到 ${next.capacity}（資料庫也會拒絕）。`,
      );
    }
    const { eventSessionSchema } = await import("@/lib/admin/schemas");
    // 資料庫回的 timestamptz 是 +00:00 結尾；統一成 ISO 再比，免得 "結束早於開始" 誤判。
    const norm = (v: string | null) => (v ? new Date(v).toISOString() : null);
    const input = validateWith(eventSessionSchema, {
      ...next,
      starts_at: norm(next.starts_at),
      ends_at: norm(next.ends_at),
    });
    const changes = diff(
      { ...pick(cur, SESSION_KEYS), starts_at: norm(cur.starts_at), ends_at: norm(cur.ends_at) },
      input,
      SESSION_KEYS,
    );
    const target = {
      session_id: cur.id,
      seats_taken: cur.seats_taken,
      starts_at_taipei: taipeiText(input.starts_at),
    };
    const reschedule = rescheduleWarning(cur.seats_taken, norm(cur.starts_at), input.starts_at);
    if (Object.keys(changes).length === 0) {
      return jsonText({
        ...target,
        dry_run: args.dry_run,
        written: false,
        message: "沒有任何欄位會變。",
      });
    }
    const auditChanges = { ...target, changes, auto_translated: translated };
    if (args.dry_run) {
      return preview(
        tool,
        "event_session",
        cur.id,
        "update",
        {
          ...target,
          changes,
          ...(reschedule ? { warning: reschedule } : {}),
          auto_translated: translated.length ? translated : undefined,
          ...(translated.length
            ? {
                confirm_args: confirmArgs(args, values),
                next_step: CONFIRM_ARGS_NEXT_STEP,
              }
            : {}),
        },
        auditChanges,
      );
    }
    const { upsertEventSession } = await import("@/server/repos/event-sessions");
    const row = await commitOrAudit(tool, "event_session", cur.id, "update", auditChanges, () =>
      upsertEventSession(input),
    );
    await nudgeCalendar();
    return committed(
      tool,
      "event_session",
      cur.id,
      "update",
      {
        ...target,
        written: true,
        changes,
        session: row,
        ...(reschedule ? { warning: reschedule } : {}),
        write_note: writeTimeNote(translated),
      },
      auditChanges,
    );
  },

  async create_ticket_type(args) {
    const tool = "create_ticket_type";
    await oauthUserId(tool);
    const session = await loadSession(args.session_id);
    const repo = await import("@/server/repos/event-sessions");
    const plans = (await repo.listEventSessionPlans()).filter((p) => p.session_id === session.id);
    const { values, translated } = await fillAll({ title: args.title });
    const { eventSessionPlanSchema } = await import("@/lib/admin/schemas");
    const input = validateWith(eventSessionPlanSchema, {
      session_id: session.id,
      title: values.title,
      price: args.price,
      seats_per_unit: args.seats_per_unit,
      capacity: args.capacity,
      sale_starts_at: args.sale_starts_at
        ? taipeiToIso("sale_starts_at", args.sale_starts_at)
        : null,
      sale_ends_at: args.sale_ends_at ? taipeiToIso("sale_ends_at", args.sale_ends_at) : null,
      status: args.status,
      sort_order: args.sort_order ?? plans.reduce((m, p) => Math.max(m, p.sort_order), 0) + 1,
    });
    const auditChanges = { will_create: input, auto_translated: translated };
    if (args.dry_run) {
      const key = args.idempotency_key ?? randomUUID();
      return preview(
        tool,
        "event_session_plan",
        session.id,
        "create",
        {
          will_create: {
            ...input,
            session_starts_at_taipei: taipeiText(session.starts_at),
            sale_starts_at_taipei: taipeiText(input.sale_starts_at ?? null),
            sale_ends_at_taipei: taipeiText(input.sale_ends_at ?? null),
          },
          existing_ticket_types: plans.length,
          auto_translated: translated.length ? translated : undefined,
          idempotency_key: key,
          confirm_args: confirmArgs(args, {
            ...values,
            sort_order: input.sort_order,
            idempotency_key: key,
          }),
          next_step: CONFIRM_ARGS_NEXT_STEP,
        },
        { ...auditChanges, idempotency_key: key },
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const row = await commitOrAudit(
      tool,
      "event_session_plan",
      session.id,
      "create",
      auditChanges,
      () => repo.upsertEventSessionPlan(input),
    );
    await nudgeCalendar();
    return committed(
      tool,
      "event_session_plan",
      row.id,
      "create",
      {
        written: true,
        ticket_type_id: row.id,
        ticket_type: row,
        write_note: writeTimeNote(translated),
      },
      { ...auditChanges, ticket_type_id: row.id, idempotency_key: args.idempotency_key },
    );
  },

  async update_ticket_type(args) {
    const tool = "update_ticket_type";
    await oauthUserId(tool);
    const repo = await import("@/server/repos/event-sessions");
    const cur = (await repo.listEventSessionPlans()).find((p) => p.id === args.ticket_type_id);
    if (!cur) notFound("票種", args.ticket_type_id);
    if (
      args.seats_per_unit !== undefined &&
      args.seats_per_unit !== cur.seats_per_unit &&
      cur.units_taken > 0
    ) {
      throw new McpInputError(
        `這個票種已售出 ${cur.units_taken} 張，不能把「每張票佔幾個名額」從 ${cur.seats_per_unit} 改成 ${args.seats_per_unit}：` +
          "已成立的訂單是照舊的人數佔名額，改了會讓場次名額對不起來。要不同人數的票，請用 create_ticket_type 另開一個票種（必要時把這個票種設 closed）。",
      );
    }
    const { values, translated } = await fillAll({ title: args.title });
    const norm = (v: string | null) => (v ? new Date(v).toISOString() : null);
    const timeArg = (field: string, v: string | null | undefined, old: string | null) =>
      v === undefined ? norm(old) : v === null ? null : taipeiToIso(field, v);
    const next = {
      id: cur.id,
      session_id: cur.session_id,
      title: values.title ?? cur.title,
      price: args.price ?? cur.price,
      seats_per_unit: args.seats_per_unit ?? cur.seats_per_unit,
      capacity: args.capacity ?? cur.capacity,
      sale_starts_at: timeArg("sale_starts_at", args.sale_starts_at, cur.sale_starts_at),
      sale_ends_at: timeArg("sale_ends_at", args.sale_ends_at, cur.sale_ends_at),
      status: args.status ?? cur.status,
      sort_order: args.sort_order ?? cur.sort_order,
    };
    if (next.capacity < cur.units_taken) {
      throw new McpInputError(
        `可售張數不能低於已售張數：已售 ${cur.units_taken} 張，收到 ${next.capacity}。`,
      );
    }
    const { eventSessionPlanSchema } = await import("@/lib/admin/schemas");
    const input = validateWith(eventSessionPlanSchema, next);
    const changes = diff(
      {
        ...pick(cur, PLAN_KEYS),
        sale_starts_at: norm(cur.sale_starts_at),
        sale_ends_at: norm(cur.sale_ends_at),
      },
      input,
      PLAN_KEYS,
    );
    const target = {
      ticket_type_id: cur.id,
      session_id: cur.session_id,
      units_taken: cur.units_taken,
    };
    if (Object.keys(changes).length === 0) {
      return jsonText({
        ...target,
        dry_run: args.dry_run,
        written: false,
        message: "沒有任何欄位會變。",
      });
    }
    const auditChanges = { ...target, changes, auto_translated: translated };
    if (args.dry_run) {
      return preview(
        tool,
        "event_session_plan",
        cur.id,
        "update",
        {
          ...target,
          changes,
          note: changes.price ? "改票價只影響之後的新訂單，已成立的訂單金額不變。" : undefined,
          auto_translated: translated.length ? translated : undefined,
          ...(translated.length
            ? { confirm_args: confirmArgs(args, values), next_step: CONFIRM_ARGS_NEXT_STEP }
            : {}),
        },
        auditChanges,
      );
    }
    const row = await commitOrAudit(
      tool,
      "event_session_plan",
      cur.id,
      "update",
      auditChanges,
      () => repo.upsertEventSessionPlan(input),
    );
    await nudgeCalendar();
    return committed(
      tool,
      "event_session_plan",
      cur.id,
      "update",
      {
        ...target,
        written: true,
        changes,
        ticket_type: row,
        write_note: writeTimeNote(translated),
      },
      auditChanges,
    );
  },

  /* ============================================================ 活動內容區塊 */

  async list_event_blocks(args) {
    await requireEvent(args.event_id);
    const { listEventBlocks } = await import("@/server/repos/event-blocks");
    const rows = await listEventBlocks(args.event_id);
    const byKind = Object.fromEntries(
      EVENT_BLOCK_KINDS.map((k) => [
        k,
        rows
          .filter((r) => r.kind === k)
          .map((r) => ({ block_id: r.id, sort_order: r.sort_order, title: r.title, body: r.body })),
      ]),
    );
    return jsonText({ event_id: args.event_id, count: rows.length, blocks: byKind });
  },

  async create_event_block(args) {
    const tool = "create_event_block";
    await oauthUserId(tool);
    await requireEvent(args.event_id);
    const { listEventBlocks, upsertEventBlock } = await import("@/server/repos/event-blocks");
    const sameKind = (await listEventBlocks(args.event_id)).filter((b) => b.kind === args.kind);
    const { values, translated } = await fillAll({ title: args.title, body: args.body });
    const { eventBlockSchema } = await import("@/lib/admin/schemas");
    const input = validateWith(eventBlockSchema, {
      event_id: args.event_id,
      kind: args.kind,
      title: values.title,
      body: values.body,
    });
    const auditChanges = { will_create: input, auto_translated: translated };
    if (args.dry_run) {
      const key = args.idempotency_key ?? randomUUID();
      return preview(
        tool,
        "event_block",
        args.event_id,
        "create",
        {
          will_create: input,
          position: `排在 ${args.kind} 的第 ${sameKind.length + 1} 個（最後）`,
          auto_translated: translated.length ? translated : undefined,
          idempotency_key: key,
          confirm_args: confirmArgs(args, { ...values, idempotency_key: key }),
          next_step: CONFIRM_ARGS_NEXT_STEP,
        },
        { ...auditChanges, idempotency_key: key },
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const row = await commitOrAudit(
      tool,
      "event_block",
      args.event_id,
      "create",
      auditChanges,
      () => upsertEventBlock(input),
    );
    return committed(
      tool,
      "event_block",
      String(row.id),
      "create",
      { written: true, block_id: row.id, block: row, write_note: writeTimeNote(translated) },
      { ...auditChanges, block_id: row.id, idempotency_key: args.idempotency_key },
    );
  },

  async update_event_block(args) {
    const tool = "update_event_block";
    await oauthUserId(tool);
    await requireEvent(args.event_id);
    const { listEventBlocks, upsertEventBlock } = await import("@/server/repos/event-blocks");
    const cur = (await listEventBlocks(args.event_id)).find((b) => b.id === args.block_id);
    if (!cur) notFound(`活動 ${args.event_id} 的區塊`, String(args.block_id));
    const { values, translated } = await fillAll({ title: args.title, body: args.body });
    const { eventBlockSchema } = await import("@/lib/admin/schemas");
    const input = validateWith(eventBlockSchema, {
      id: cur.id,
      event_id: cur.event_id,
      kind: cur.kind,
      title: values.title ?? cur.title,
      body: values.body ?? cur.body,
    });
    const changes = diff(cur, input, ["title", "body"]);
    const target = { event_id: cur.event_id, block_id: cur.id, kind: cur.kind };
    if (Object.keys(changes).length === 0) {
      return jsonText({
        ...target,
        dry_run: args.dry_run,
        written: false,
        message: "沒有任何欄位會變。",
      });
    }
    const auditChanges = { ...target, changes, auto_translated: translated };
    if (args.dry_run) {
      return preview(
        tool,
        "event_block",
        String(cur.id),
        "update",
        {
          ...target,
          changes,
          auto_translated: translated.length ? translated : undefined,
          ...(translated.length
            ? { confirm_args: confirmArgs(args, values), next_step: CONFIRM_ARGS_NEXT_STEP }
            : {}),
        },
        auditChanges,
      );
    }
    const row = await commitOrAudit(
      tool,
      "event_block",
      String(cur.id),
      "update",
      auditChanges,
      () =>
        upsertEventBlock({
          id: input.id,
          event_id: input.event_id,
          kind: input.kind,
          title: input.title,
          body: input.body,
        }),
    );
    return committed(
      tool,
      "event_block",
      String(cur.id),
      "update",
      { ...target, written: true, changes, block: row, write_note: writeTimeNote(translated) },
      auditChanges,
    );
  },

  async reorder_event_blocks(args) {
    const tool = "reorder_event_blocks";
    await oauthUserId(tool);
    await requireEvent(args.event_id);
    const { listEventBlocks, reorderEventBlocks } = await import("@/server/repos/event-blocks");
    const current = (await listEventBlocks(args.event_id)).filter((b) => b.kind === args.kind);
    const currentIds = current.map((b) => b.id);
    const want = [...args.block_ids];
    const sameSet =
      want.length === currentIds.length &&
      new Set(want).size === want.length &&
      want.every((id) => currentIds.includes(id));
    if (!sameSet) {
      throw new McpInputError(
        `block_ids 要是活動 ${args.event_id} 的 ${args.kind} 區塊完整清單（不多不少不重複）。目前有：${currentIds.join(", ") || "（沒有）"}`,
      );
    }
    const titleOf = (id: number) => current.find((b) => b.id === id)?.title.zh ?? "";
    const before = currentIds.map((id) => ({ block_id: id, title: titleOf(id) }));
    const after = want.map((id) => ({ block_id: id, title: titleOf(id) }));
    const target = { event_id: args.event_id, kind: args.kind };
    if (stableStringify(currentIds) === stableStringify(want)) {
      return jsonText({
        ...target,
        dry_run: args.dry_run,
        written: false,
        message: "順序沒有變。",
      });
    }
    const auditChanges = { ...target, order: { before: currentIds, after: want } };
    if (args.dry_run) {
      return preview(
        tool,
        "event_block",
        args.event_id,
        "reorder",
        { ...target, order: { before, after } },
        auditChanges,
      );
    }
    await commitOrAudit(tool, "event_block", args.event_id, "reorder", auditChanges, () =>
      reorderEventBlocks(args.event_id, args.kind, want),
    );
    return committed(
      tool,
      "event_block",
      args.event_id,
      "reorder",
      { ...target, written: true, order: { before, after } },
      auditChanges,
    );
  },

  /* ============================================================ Google 日曆 */

  async sync_google_calendar(args) {
    const tool = "sync_google_calendar";
    await oauthUserId(tool);
    const gcal = await import("@/server/google-calendar");
    const st = await gcal.getGoogleCalendarStatus();
    if (!st.configured) {
      throw new McpInputError(
        "Google 日曆同步尚未設定（缺環境變數），請到後台 /admin/google-calendar 查看。",
      );
    }
    if (!st.connected || !st.calendarId) {
      throw new McpInputError(
        "還沒連結 Google 日曆（或還沒選日曆）。連線要在後台 /admin/google-calendar 按「連結」，MCP 不提供。",
      );
    }
    const status = {
      calendar: st.calendarSummary ?? st.calendarId,
      running: st.running,
      needs_reconnect: st.needsReconnect,
      last_sync: {
        started_at: taipeiText(st.lastSync.startedAt),
        finished_at: taipeiText(st.lastSync.finishedAt),
        ok: st.lastSync.ok,
        trigger: st.lastSync.trigger,
        summary: st.lastSync.summary,
        error: st.lastSync.error,
      },
    };
    if (args.dry_run) {
      return preview(
        tool,
        "google_calendar",
        "sync",
        "sync",
        { status, will: "把站上活動場次同步到上面這個 Google 日曆（與後台「立即同步」相同）" },
        { calendar: status.calendar },
      );
    }
    const outcome = await commitOrAudit(
      tool,
      "google_calendar",
      "sync",
      "sync",
      { calendar: status.calendar },
      () => gcal.runGoogleCalendarSync("manual"),
    );
    return committed(
      tool,
      "google_calendar",
      "sync",
      "sync",
      {
        written: outcome.status === "done",
        outcome,
        message:
          outcome.status === "busy"
            ? "另一次同步正在進行中，這次沒有執行；稍後再試或用 dry_run=true 看結果。"
            : undefined,
      },
      { calendar: status.calendar, outcome: outcome.status },
    );
  },
};

/* ------------------------------------------------------------------ wrap */

/**
 * 每一支都先用自己的 schema 再驗一次（SDK 已驗過時是 no-op；自檢直接呼叫時才有作用），
 * 輸入錯誤與 repo 例外一律回 isError 文字，不回協定錯誤。
 */
function wrap<N extends OrdersEventsToolName>(name: N): (args: unknown) => Promise<TextResult> {
  const schema = ORDERS_EVENTS_TOOL_INPUTS[name] as unknown as {
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
      console.error(`[mcp/orders-events] ${name} 失敗`, err instanceof Error ? err.message : err);
      return errText(`執行失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export const ORDERS_EVENTS_HANDLERS = Object.fromEntries(
  (Object.keys(ORDERS_EVENTS_TOOL_INPUTS) as OrdersEventsToolName[]).map((n) => [n, wrap(n)]),
) as { [N in OrdersEventsToolName]: (args: Args<N> | unknown) => Promise<TextResult> };
