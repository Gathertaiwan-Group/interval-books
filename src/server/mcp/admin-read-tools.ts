/**
 * MCP 工具 —— 讓 AI **查**後台資料：訂單、報名名單、策旅意願單、銷售、進銷存、推廣、合作邀約、
 * 首頁待辦。業主 2026-11-03：想在 Claude／ChatGPT 連接器直接問「這場誰報名了、這張單發票開了沒、
 * 這個月賣了多少」，不必登入 /admin 翻頁。
 *
 * ── 一條規矩：只讀，而且走後台同一支 repo ───────────────────────────────────
 * 這裡**沒有任何一支寫入**：不標記收款、不出貨、不刪報名、不開／作廢發票、不退款、不結算分潤、
 * 不改意願單狀態。每一支都是呼叫後台頁面已經在用的 repo 讀取函式（src/server/repos/*），
 * 條件與後台畫面逐字相同（例如 needs_contact／to_ship 的定義、低庫存的 per-row 門檻）。
 * 後台 repo 沒有的查詢（訂單的多條件篩選、付款紀錄、聯絡資料修改紀錄、報名移除紀錄、網站訂單
 * 營收彙總）才在這裡直接 select，而且只 select 列出來的欄位。
 *
 * ── 授權 ──────────────────────────────────────────────────────────────────
 * 與 tools.ts 同一個模型：呼叫端已經通過 http.ts（靜態 MCP_TOKEN，或 OAuth token ＋ 每次重查
 * profiles 確認仍是 admin）。後台這幾頁的 server fn 全是 adminFnMiddleware（名單是 staff＋
 * event.roster.read，admin 一律通過），所以 MCP 這把「admin 身分」看得到的範圍與後台相同。
 *
 * ── 不回的東西 ─────────────────────────────────────────────────────────────
 * 付款閘道原始回應（payments.raw_response）、webhook payload、廠商身分證／統編／居留證（連遮罩
 * 版本都不回）、廠商匯款帳戶、人員帳號、任何 token／金鑰。個資（客人姓名、電話、Email、地址、
 * 參加者名單）照後台明文規則回（業主 2026-10-25／26 決定後台看明文），但只在 get_* 與名單工具。
 *
 * ── 回傳量 ────────────────────────────────────────────────────────────────
 * list_* 一律 limit（預設 20、上限 100）＋ page（從 1 起），回 total／has_more；欄位精簡，
 * 細節請用對應的 get_*。repos 都在 handler 裡 dynamic import（同 tools.ts），這個模組載入時不碰
 * Supabase —— scripts/mcp-selftest.mjs 才能在沒有金鑰的機器上列工具。
 */
import { z } from "zod4";
import { jsonText, McpInputError, type TextResult } from "./core";

/* ------------------------------------------------------------------ 共用 */

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;

const pageArgs = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIMIT_MAX)
    .default(LIMIT_DEFAULT)
    .describe(`每頁幾筆，預設 ${LIMIT_DEFAULT}、上限 ${LIMIT_MAX}`),
  page: z.number().int().min(1).max(10000).default(1).describe("第幾頁，從 1 開始"),
};

const uuidArg = (what: string) => z.string().trim().uuid().describe(what);

const dateArg = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式是 YYYY-MM-DD")
    .optional()
    .describe(`${what}（YYYY-MM-DD，台北日期，含當天）`);

const keywordArg = (what: string) => z.string().trim().min(1).max(100).optional().describe(what);

function paged<T>(all: readonly T[], limit: number, page: number) {
  const from = (page - 1) * limit;
  const rows = all.slice(from, from + limit);
  return { total: all.length, page, limit, has_more: from + rows.length < all.length, rows };
}

function pageMeta(total: number, limit: number, page: number, got: number) {
  return { total, page, limit, has_more: (page - 1) * limit + got < total };
}

/** 台北日期 → [start, end) 的 UTC ISO。 */
function taipeiDayStartIso(day: string): string {
  return new Date(`${day}T00:00:00+08:00`).toISOString();
}
function taipeiDayEndIso(day: string): string {
  return new Date(new Date(`${day}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
}

/** PostgREST or() 用逗號與括號當分隔符，先剝掉（與 repos/inv-*.ts 同一支寫法）。 */
function orSafe(keyword: string | undefined): string | null {
  if (!keyword) return null;
  const s = keyword.replace(/[(),%*]/g, " ").trim();
  return s || null;
}

function notFound(what: string, id: string): never {
  throw new McpInputError(`找不到${what}「${id}」。請先用對應的 list_* 工具查 id。`);
}

/** 三語欄位只取中文（列表用）。 */
function zh(v: unknown): string | null {
  if (v && typeof v === "object" && "zh" in v) return String((v as { zh: unknown }).zh ?? "");
  return typeof v === "string" ? v : null;
}

/* ------------------------------------------------------------------ 輸入 schema */

const ORDER_SCOPES = [
  "all",
  "transfer_pending",
  "needs_contact",
  "to_ship",
  "invoice_problem",
  "phone",
] as const;

export const ADMIN_READ_TOOL_INPUTS = {
  get_admin_dashboard: z.object({}),

  list_orders: z.object({
    scope: z
      .enum(ORDER_SCOPES)
      .default("all")
      .describe(
        "與後台訂單頁的分頁籤同一組條件：all 全部（可再加下面的篩選）／transfer_pending 匯款未收／" +
          "needs_contact 需專人聯繫（未付款、未取消）／to_ship 待出貨／invoice_problem 發票尚未開立／" +
          "phone 後台電話報名。非 all 的分頁籤是後台同一支查詢（最新 300 筆），其餘篩選在那之上套用。",
      ),
    status: z
      .enum(["pending", "processing", "shipped", "completed", "cancelled"])
      .optional()
      .describe("訂單狀態"),
    payment_status: z
      .enum(["pending", "paid", "failed", "refunded"])
      .optional()
      .describe("付款狀態"),
    payment_method: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .optional()
      .describe("付款方式，例如 card、transfer、free、atm"),
    source: z
      .enum(["web", "admin_phone"])
      .optional()
      .describe("web 前台結帳／admin_phone 電話報名"),
    needs_contact: z.boolean().optional().describe("客人勾了「需要專人聯繫協助付款」"),
    date_from: dateArg("下單日起"),
    date_to: dateArg("下單日迄"),
    keyword: keywordArg("搜尋訂單編號、訂購人姓名、Email、電話"),
    include_archived: z.boolean().default(false).describe("是否包含已封存訂單，預設 false"),
    ...pageArgs,
  }),
  get_order: z
    .object({
      id: z.string().trim().uuid().optional().describe("orders.id（UUID）"),
      order_no: z.string().trim().min(1).max(40).optional().describe("訂單編號（與 id 二選一）"),
    })
    .refine((v) => Boolean(v.id) !== Boolean(v.order_no), "id 與 order_no 要給其中一個"),

  list_registrations: z.object({
    product_type: z
      .enum(["event", "journey", "all"])
      .default("all")
      .describe("event 活動／journey 策旅"),
    when: z
      .enum(["upcoming", "past", "all"])
      .default("all")
      .describe("upcoming 尚未開始（依開始時間由近到遠）／past 已開始／all 全部（由新到舊）"),
    keyword: keywordArg("搜尋活動／策旅名稱、網址代稱（slug）、場次名稱"),
    ...pageArgs,
  }),
  get_session_roster: z.object({
    session_id: uuidArg("event_sessions.id（見 list_registrations）"),
  }),

  list_journey_wishes: z.object({
    status: z.enum(["new", "reviewed", "archived", "all"]).default("all").describe("處理狀態"),
    ...pageArgs,
  }),
  get_journey_wish: z.object({ id: uuidArg("journey_wishes.id") }),

  list_sales: z.object({
    date_from: dateArg("銷售日起"),
    date_to: dateArg("銷售日迄"),
    channel: z.enum(["all", "pos", "online"]).default("all").describe("pos 門市／online 網站"),
    reconciled: z.enum(["all", "yes", "no"]).default("all").describe("是否已對帳"),
    keyword: keywordArg("搜尋品名、期數、系列、備註"),
    ...pageArgs,
  }),
  get_sale: z.object({ sale_id: uuidArg("銷售紀錄 sale_id（見 list_sales）") }),
  get_sales_summary: z.object({
    date_from: dateArg("起日；省略＝本月 1 日"),
    date_to: dateArg("迄日；省略＝今天"),
  }),

  list_inventory: z.object({
    keyword: keywordArg("搜尋品名、期數、條碼、系列、出版社"),
    low_stock_only: z
      .boolean()
      .default(false)
      .describe("只列低庫存（庫存 ≤ 該品項自己的警示數量；與後台盤點頁同一個判斷）"),
    active: z.enum(["all", "active", "inactive"]).default("active").describe("啟用狀態"),
    product_type: z
      .enum(["outright", "consignment", "rental"])
      .optional()
      .describe("outright 買斷／consignment 寄賣／rental 租借"),
    ...pageArgs,
  }),
  get_inventory_product: z.object({ id: uuidArg("進銷存商品 inv_product_id") }),
  list_stock_alerts: z.object({
    status: z.enum(["open", "resolved", "all"]).default("open").describe("open 未處理（預設）"),
    ...pageArgs,
  }),
  list_purchases: z.object({
    keyword: keywordArg("搜尋品名、期數、系列、廠商、出版社"),
    date_from: dateArg("進貨日起"),
    date_to: dateArg("進貨日迄"),
    vendor_id: z.string().trim().uuid().optional().describe("廠商 vendor_id（見 list_vendors）"),
    approval_status: z
      .enum(["all", "pending", "approved", "rejected"])
      .default("all")
      .describe("審核狀態"),
    ...pageArgs,
  }),
  get_purchase: z.object({ id: uuidArg("進貨單 purchase_id") }),
  list_vendors: z.object({
    keyword: keywordArg("搜尋廠商名稱、簡稱、英文名、代號、電話、Email"),
    status: z.enum(["all", "active", "suspended", "inactive"]).default("all"),
    ...pageArgs,
  }),
  get_vendor: z.object({ id: uuidArg("廠商 vendor_id") }),

  list_referrers: z.object({ ...pageArgs }),
  get_referral_report: z.object({
    period: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "月份格式是 YYYY-MM")
      .optional()
      .describe("月份 YYYY-MM（台北）；省略＝本月"),
    referrer_id: z
      .string()
      .trim()
      .uuid()
      .optional()
      .describe("只看一位推廣者並列出逐筆訂單（見 list_referrers）"),
  }),

  list_partnership_inquiries: z.object({
    status: z.enum(["new", "replied", "archived", "all"]).default("all").describe("處理狀態"),
    ...pageArgs,
  }),
  get_partnership_inquiry: z.object({ id: uuidArg("partnership_inquiries.id") }),
} as const;

export type AdminReadToolName = keyof typeof ADMIN_READ_TOOL_INPUTS;
type Args<N extends AdminReadToolName> = z.output<(typeof ADMIN_READ_TOOL_INPUTS)[N]>;

const NOTE = "唯讀，不會改任何資料。";

export const ADMIN_READ_TOOL_META: Record<
  AdminReadToolName,
  { title: string; description: string }
> = {
  get_admin_dashboard: {
    title: "後台首頁待辦",
    description: `後台首頁「今日待辦」：匯款未收、待出貨、賣超告警、待審商品／調價／進貨、發票尚未開立的張數，以及未來 7 天的場次與報名人數。${NOTE}`,
  },
  list_orders: {
    title: "訂單列表",
    description: `列出訂單（精簡欄位：編號、時間、金額、付款方式與狀態、訂單狀態、來源、訂購人姓名）。可依分頁籤、狀態、付款方式、來源、需聯繫、下單日期、關鍵字篩選。明細、付款紀錄、發票請用 get_order。${NOTE}`,
  },
  get_order: {
    title: "單筆訂單",
    description: `用 id 或訂單編號取一張訂單的完整內容：品項（含場次）、金額拆解、訂購人與收件資料、備註、付款紀錄（不含閘道原始回應）、發票（號碼／狀態／作廢）、參加者、聯絡資料修改紀錄、報名移除紀錄。${NOTE}`,
  },
  list_registrations: {
    title: "報名場次列表",
    description: `列出活動／策旅的場次與報名人數（名額、已佔、報名總數、已付款數、剩餘）。要看某場的名單用 get_session_roster。${NOTE}`,
  },
  get_session_roster: {
    title: "場次報名名單",
    description: `一個場次的完整名單（與後台名單頁相同，明文姓名／電話／Email）：每位參加者、所屬訂單與付款狀態、是否算在簽到表上（on_roster），加上票種名額與報名移除紀錄。${NOTE}`,
  },
  list_journey_wishes: {
    title: "策旅意願單列表",
    description: `列出策旅願望表單的回覆（時間、來源頁、興趣、願望摘要、姓名、Email、處理狀態），附各狀態筆數。${NOTE}`,
  },
  get_journey_wish: {
    title: "單筆策旅意願單",
    description: `一筆策旅意願單的完整內容（含語言、來源網址、內部備註、通知信狀態）。${NOTE}`,
  },
  list_sales: {
    title: "銷售紀錄列表",
    description: `進銷存的銷售紀錄（門市 POS 與網站），與後台「銷售紀錄」頁同一支查詢。可依日期、通路、對帳狀態、關鍵字篩選；回傳附同條件的合計。${NOTE}`,
  },
  get_sale: {
    title: "單筆銷售紀錄",
    description: `一筆銷售的完整明細（品項、數量、單價、成本、毛利、付款方式、操作人員、對帳、備註）。${NOTE}`,
  },
  get_sales_summary: {
    title: "期間營收彙總",
    description:
      "日期區間（台北，預設本月 1 日到今天）的營收彙總：" +
      "①進銷存銷售紀錄依通路（門市 pos／網站 online）的筆數、件數、金額、成本、毛利（與後台銷售紀錄頁的合計同一支）；" +
      "②網站訂單（含活動／策旅票券）已付款的張數與金額，依付款方式與來源拆分（依付款時間）。" +
      `注意：網站賣出的選物／書會同時出現在①的 online 與②，兩者不要相加。${NOTE}`,
  },
  list_inventory: {
    title: "進銷存商品與庫存",
    description: `列出進銷存商品的庫存（庫存、預留、可售、警示數量、售價、分類、廠商、是否上架網站）。low_stock_only=true 只列低庫存。${NOTE}`,
  },
  get_inventory_product: {
    title: "單一進銷存商品",
    description: `一件進銷存商品的完整資料（含進價、審核、調價申請、網站上架連結）。${NOTE}`,
  },
  list_stock_alerts: {
    title: "賣超告警",
    description: `庫存不足仍賣出的告警（與後台「賣超告警」頁同一支查詢），預設只列未處理。${NOTE}`,
  },
  list_purchases: {
    title: "進貨單列表",
    description: `列出進貨紀錄（日期、品項、數量、剩餘、進價、小計、廠商、審核狀態）。${NOTE}`,
  },
  get_purchase: {
    title: "單筆進貨單",
    description: `一筆進貨的完整資料（含效期、備註、審核人）。${NOTE}`,
  },
  list_vendors: {
    title: "廠商列表",
    description: `列出廠商（名稱、代號、類型、寄賣與否、狀態、商品數、庫存件數）。不含身分證、統編、匯款帳戶。${NOTE}`,
  },
  get_vendor: {
    title: "單一廠商",
    description: `一家廠商的基本資料、聯絡方式、付款與結算條件、手續費率。身分證、統編、居留證、匯款帳戶一律不回（請到後台查閱，會留紀錄）。${NOTE}`,
  },
  list_referrers: {
    title: "推廣者列表",
    description: `列出推薦碼推廣者（名稱、推薦碼、類型、折扣%、是否啟用）。業績與分潤用 get_referral_report。${NOTE}`,
  },
  get_referral_report: {
    title: "推薦碼月報",
    description: `某個月（預設本月）的推薦碼業績與分潤試算，與後台「推廣與分潤」頁同一支計算：全店營收／毛利、每位推廣者的導購營收、分潤、扣回、應付、是否已結算。帶 referrer_id 會列出那位推廣者的逐筆訂單。${NOTE}`,
  },
  list_partnership_inquiries: {
    title: "合作邀約列表",
    description: `列出合作邀約表單（類型、公司、聯絡人、Email、電話、預算、時程、處理狀態），附各狀態筆數。${NOTE}`,
  },
  get_partnership_inquiry: {
    title: "單筆合作邀約",
    description: `一筆合作邀約的完整內容（含網站、訊息、內部備註、通知信狀態）。${NOTE}`,
  },
};

/* ------------------------------------------------------------------ 實作 */

type Handlers = { [N in AdminReadToolName]: (args: Args<N>) => Promise<TextResult> };

export const ADMIN_READ_HANDLERS: Handlers = {
  /* ============================================================ 首頁待辦 */

  async get_admin_dashboard() {
    // 與 src/lib/admin/fns/dashboard.ts#getAdminTodo 同一組呼叫。
    const { getAdminTodoCounts, listUpcomingSessions } = await import("@/server/repos/admin-todo");
    const { taipeiWeekWindow } = await import("@/lib/admin/todo");
    const { loadInvoiceAttentionRows } = await import("@/server/invoice-alerts");
    const { fromIso, toIso } = taipeiWeekWindow(new Date());
    const [counts, sessions, invoiceRows] = await Promise.all([
      getAdminTodoCounts(),
      listUpcomingSessions(fromIso, toIso),
      loadInvoiceAttentionRows(),
    ]);
    return jsonText({
      note: "null 代表那一項讀取失敗（不是 0）。",
      counts: {
        transfer_pending: counts.transferPending,
        to_ship: counts.toShip,
        stock_alerts_open: counts.stockAlertsOpen,
        products_pending: counts.productsPending,
        price_changes_pending: counts.priceChangesPending,
        purchases_pending: counts.purchasesPending,
        invoice_problems: invoiceRows === null ? null : invoiceRows.length,
      },
      upcoming_sessions_7d: sessions,
    });
  },

  /* ============================================================ 訂單 */

  async list_orders(args) {
    type Row = {
      id: string;
      order_no: string;
      created_at: string;
      total: number;
      payment_method: string | null;
      payment_status: string;
      status: string;
      shipping_method: string;
      source: string;
      customer_name: string;
      needs_contact: boolean;
      archived_at: string | null;
    };
    const slim = (r: Row) => ({
      id: r.id,
      order_no: r.order_no,
      created_at: r.created_at,
      total: r.total,
      payment_method: r.payment_method,
      payment_status: r.payment_status,
      status: r.status,
      shipping_method: r.shipping_method,
      source: r.source,
      customer_name: r.customer_name,
      needs_contact: r.needs_contact,
      archived: r.archived_at !== null,
    });

    if (args.scope !== "all") {
      // 後台分頁籤：同一支 listAdminOrders（條件與後台、首頁計數逐字相同），其餘篩選疊在上面。
      const { listAdminOrders } = await import("@/server/repos/orders-admin");
      const base = (await listAdminOrders({
        scope: args.scope,
        includeArchived: args.include_archived,
      })) as unknown as Row[];
      const from = args.date_from ? taipeiDayStartIso(args.date_from) : null;
      const to = args.date_to ? taipeiDayEndIso(args.date_to) : null;
      const kw = args.keyword?.toLowerCase() ?? null;
      const rows = base.filter(
        (r) =>
          (!args.status || r.status === args.status) &&
          (!args.payment_status || r.payment_status === args.payment_status) &&
          (!args.payment_method || r.payment_method === args.payment_method) &&
          (!args.source || r.source === args.source) &&
          (args.needs_contact === undefined || r.needs_contact === args.needs_contact) &&
          (!from || r.created_at >= from) &&
          (!to || r.created_at < to) &&
          (!kw ||
            r.order_no.toLowerCase().includes(kw) ||
            r.customer_name.toLowerCase().includes(kw)),
      );
      const p = paged(rows, args.limit, args.page);
      return jsonText({
        scope: args.scope,
        ...p,
        rows: p.rows.map(slim),
        note: "分頁籤模式只看後台那一頁的最新 300 筆；關鍵字只比對訂單編號與姓名。",
      });
    }

    const { supabaseAdmin } = await import("@/server/supabase-admin");
    const offset = (args.page - 1) * args.limit;
    let q = supabaseAdmin()
      .from("orders")
      .select(
        "id, order_no, created_at, total, payment_method, payment_status, status, shipping_method, source, customer_name, needs_contact, archived_at",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + args.limit - 1);
    if (!args.include_archived) q = q.is("archived_at", null);
    if (args.status) q = q.eq("status", args.status);
    if (args.payment_status) q = q.eq("payment_status", args.payment_status);
    if (args.payment_method) q = q.eq("payment_method", args.payment_method);
    if (args.source) q = q.eq("source", args.source);
    if (args.needs_contact !== undefined) q = q.eq("needs_contact", args.needs_contact);
    if (args.date_from) q = q.gte("created_at", taipeiDayStartIso(args.date_from));
    if (args.date_to) q = q.lt("created_at", taipeiDayEndIso(args.date_to));
    const kw = orSafe(args.keyword);
    if (kw) {
      q = q.or(
        `order_no.ilike.%${kw}%,customer_name.ilike.%${kw}%,customer_email.ilike.%${kw}%,customer_phone.ilike.%${kw}%`,
      );
    }
    const { data, error, count } = await q;
    if (error) {
      // 只印 code＋message：PostgREST 的 DETAIL 會帶整列客人資料（同 orders-admin.ts）。
      console.error(`[mcp/list_orders] ${error.code} ${error.message}`);
      throw new Error(`訂單列表讀取失敗：${error.code}`);
    }
    const rows = (data ?? []) as unknown as Row[];
    return jsonText({
      scope: "all",
      ...pageMeta(count ?? 0, args.limit, args.page, rows.length),
      rows: rows.map(slim),
    });
  },

  async get_order(args) {
    const { supabaseAdmin } = await import("@/server/supabase-admin");
    const db = supabaseAdmin();
    let id = args.id ?? null;
    if (!id) {
      const { data, error } = await db
        .from("orders")
        .select("id")
        .eq("order_no", args.order_no ?? "")
        .maybeSingle();
      if (error) throw new Error(`訂單讀取失敗：${error.code}`);
      if (!data) notFound("訂單", args.order_no ?? "");
      id = (data as { id: string }).id;
    }

    const { getAdminOrderDetail } = await import("@/server/repos/orders-admin");
    const { listRegistrationsByOrder } = await import("@/server/repos/event-registrations");
    const detail = await getAdminOrderDetail(id);
    if (!detail) notFound("訂單", id);

    // 後台 repo 沒有的三段：付款紀錄（不含 raw_response）、聯絡資料修改紀錄（0051，只記欄位名
    // 不記值）、報名移除紀錄（0044，只有姓氏首字）。參加者走 repos/event-registrations.ts#listRegistrationsByOrder（0021 的名單 view）。
    const [payRes, editRes, regRes, removedRes] = await Promise.all([
      db
        .from("payments")
        .select("gateway, gateway_tx_id, status, amount, paid_at, created_at, updated_at")
        .eq("order_id", id)
        .order("created_at", { ascending: true }),
      db
        .from("order_contact_edit_log")
        .select("edited_at, actor_id, changes")
        .eq("order_id", id)
        .order("edited_at", { ascending: true }),
      listRegistrationsByOrder(id).then(
        (data) => ({ data, error: null }),
        () => ({ data: null, error: { code: "roster" } }),
      ),
      db
        .from("registration_removal_log")
        .select("removed_at, session_id, name_initial, seats_freed, units_freed")
        .eq("order_id", id)
        .order("removed_at", { ascending: true }),
    ]);
    const part = <T>(r: { data: unknown; error: { code?: string } | null }, label: string) =>
      r.error ? { error: `${label}讀取失敗：${r.error.code ?? ""}` } : ((r.data ?? []) as T[]);

    return jsonText({
      ...detail,
      payments: part(payRes, "付款紀錄"),
      registrations: part(regRes, "參加者"),
      contact_edit_log: part(editRes, "聯絡資料修改紀錄"),
      registration_removal_log: part(removedRes, "報名移除紀錄"),
    });
  },

  /* ============================================================ 報名 */

  async list_registrations(args) {
    // 與 /admin/registrations（fns/event-sessions.ts#getAdminRegistrationsPageData）同三支。
    const repo = await import("@/server/repos/event-sessions");
    const { countRegistrationsBySession } = await import("@/server/repos/event-registrations");
    const [sessions, products, counts] = await Promise.all([
      repo.listEventSessions(),
      repo.listBookableProducts(),
      countRegistrationsBySession(),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const now = new Date().toISOString();
    const kw = args.keyword?.toLowerCase() ?? null;
    let rows = sessions
      .map((s) => ({ s, p: productById.get(s.product_id) }))
      .filter(({ s, p }) => {
        if (args.product_type !== "all" && p?.product_type !== args.product_type) return false;
        if (args.when === "upcoming" && s.starts_at < now) return false;
        if (args.when === "past" && s.starts_at >= now) return false;
        if (!kw) return true;
        return [p?.slug, zh(p?.title), zh(s.title)].some((t) => t?.toLowerCase().includes(kw));
      });
    if (args.when === "upcoming") rows = rows.reverse(); // repo 是由新到舊，upcoming 改成由近到遠

    const p = paged(rows, args.limit, args.page);
    return jsonText({
      ...p,
      rows: p.rows.map(({ s, p: prod }) => {
        const c = counts[s.id] ?? { total: 0, paid: 0 };
        return {
          session_id: s.id,
          product_type: prod?.product_type ?? null,
          product_slug: prod?.slug ?? null,
          product_title: zh(prod?.title),
          session_title: zh(s.title),
          starts_at: s.starts_at,
          status: s.status,
          capacity: s.capacity,
          seats_taken: s.seats_taken,
          seats_left: Math.max(0, s.capacity - s.seats_taken),
          registrations_total: c.total,
          registrations_paid: c.paid,
        };
      }),
    });
  },

  async get_session_roster({ session_id }) {
    const repo = await import("@/server/repos/event-sessions");
    const { listSessionRoster } = await import("@/server/repos/event-registrations");
    const { supabaseAdmin } = await import("@/server/supabase-admin");
    const [session, products, plans, roster, removedRes] = await Promise.all([
      repo.getEventSessionById(session_id),
      repo.listBookableProducts(),
      repo.listEventSessionPlans(),
      listSessionRoster(session_id),
      supabaseAdmin()
        .from("registration_removal_log")
        .select("removed_at, order_id, name_initial, seats_freed, units_freed")
        .eq("session_id", session_id)
        .order("removed_at", { ascending: true }),
    ]);
    if (!session) notFound("場次", session_id);
    const product = products.find((p) => p.id === session.product_id) ?? null;
    const onRoster = roster.filter((r) => r.on_roster).length;
    return jsonText({
      session: {
        id: session.id,
        title: zh(session.title),
        location: zh(session.location),
        starts_at: session.starts_at,
        ends_at: session.ends_at,
        status: session.status,
        capacity: session.capacity,
        seats_taken: session.seats_taken,
        seats_left: Math.max(0, session.capacity - session.seats_taken),
      },
      product: product
        ? {
            id: product.id,
            slug: product.slug,
            title: zh(product.title),
            product_type: product.product_type,
          }
        : null,
      plans: plans
        .filter((pl) => pl.session_id === session_id)
        .map((pl) => ({
          id: pl.id,
          title: zh(pl.title),
          price: pl.price,
          seats_per_unit: pl.seats_per_unit,
          capacity: pl.capacity,
          units_taken: pl.units_taken,
          status: pl.status,
        })),
      summary: {
        registrations_total: roster.length,
        on_roster: onRoster,
        not_on_roster: roster.length - onRoster,
        note: "on_roster＝已付款、算在簽到表上（0021 §3 的唯一定義）；其餘是未付款或已取消的訂單押著的名額。",
      },
      roster,
      removal_log: removedRes.error
        ? { error: `報名移除紀錄讀取失敗：${removedRes.error.code ?? ""}` }
        : (removedRes.data ?? []),
    });
  },

  /* ============================================================ 策旅意願單 */

  async list_journey_wishes(args) {
    const { listWishes, countWishes, WISH_LIST_LIMIT } =
      await import("@/server/repos/journey-wishes");
    const [rows, counts] = await Promise.all([listWishes(args.status), countWishes()]);
    const p = paged(rows, args.limit, args.page);
    return jsonText({
      counts,
      ...p,
      rows: p.rows.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        source: r.source,
        interests: r.interests,
        wish: r.wish.length > 200 ? `${r.wish.slice(0, 200)}…` : r.wish,
        name: r.name,
        email: r.email,
        join_friends: r.join_friends,
        notify_opt_in: r.notify_opt_in,
        status: r.status,
      })),
      note: `後台同一支查詢最多讀最新 ${WISH_LIST_LIMIT} 筆；願望超過 200 字已截短，完整內容用 get_journey_wish。`,
    });
  },

  async get_journey_wish({ id }) {
    const { getWish } = await import("@/server/repos/journey-wishes");
    const row = await getWish(id);
    if (!row) notFound("策旅意願單", id);
    const { email_id: _emailId, ...rest } = row;
    return jsonText(rest);
  },

  /* ============================================================ 銷售 */

  async list_sales(args) {
    const { listPosSales, summarisePosSales } = await import("@/server/repos/inv-sales");
    const filter = {
      from: args.date_from ?? null,
      to: args.date_to ?? null,
      channel: args.channel,
      keyword: args.keyword ?? null,
      reconciled: args.reconciled,
      paymentMethodId: null,
      page: args.page - 1,
      pageSize: args.limit,
    };
    const [list, sum] = await Promise.all([listPosSales(filter), summarisePosSales(filter)]);
    return jsonText({
      ...pageMeta(list.total, args.limit, args.page, list.rows.length),
      summary: { ...sum, gross_profit: sum.amount - sum.cost },
      rows: list.rows,
    });
  },

  async get_sale({ sale_id }) {
    const { getPosSale } = await import("@/server/repos/inv-sales");
    const row = await getPosSale(sale_id);
    if (!row) notFound("銷售紀錄", sale_id);
    const { user_id: _user, ...rest } = row;
    return jsonText(rest);
  },

  async get_sales_summary(args) {
    const { taipeiToday } = await import("@/lib/taipei-time");
    const today = taipeiToday();
    const from = args.date_from ?? `${today.slice(0, 7)}-01`;
    const to = args.date_to ?? today;
    if (from > to) throw new McpInputError("date_from 不能晚於 date_to");

    const { summarisePosSales } = await import("@/server/repos/inv-sales");
    const { readAllPages } = await import("@/server/repos/read-all-pages");
    const { supabaseAdmin } = await import("@/server/supabase-admin");
    const base = {
      from,
      to,
      keyword: null,
      reconciled: "all" as const,
      paymentMethodId: null,
      page: 0,
      pageSize: 1,
    };
    const [pos, online, ordersRes] = await Promise.all([
      summarisePosSales({ ...base, channel: "pos" }),
      summarisePosSales({ ...base, channel: "online" }),
      // ⚠️ 不能 .limit(20000)：PostgREST 的 db-max-rows（1000）會靜默截斷，營收少算
      //    （2026-11-03 審查）。依 id 分段讀完。
      readAllPages(
        (a, b) =>
          supabaseAdmin()
            .from("orders")
            .select("id, total, payment_method, source")
            .eq("payment_status", "paid")
            .gte("paid_at", taipeiDayStartIso(from))
            .lt("paid_at", taipeiDayEndIso(to))
            .order("id", { ascending: true })
            .range(a, b) as unknown as PromiseLike<{
            data: { total: number; payment_method: string | null; source: string | null }[] | null;
            error: { code?: string; message: string } | null;
          }>,
        { label: "網站訂單" },
      ),
    ]);

    const withProfit = (s: typeof pos) => ({ ...s, gross_profit: s.amount - s.cost });
    const orders = ordersRes;
    const group = (key: (o: (typeof orders)[number]) => string) => {
      const out: Record<string, { count: number; amount: number }> = {};
      for (const o of orders) {
        const g = (out[key(o)] ??= { count: 0, amount: 0 });
        g.count += 1;
        g.amount += Number(o.total ?? 0);
      }
      return out;
    };
    return jsonText({
      date_from: from,
      date_to: to,
      inventory_sales: {
        note: "進銷存銷售紀錄（/admin/sales 同一支合計）。cost 是單位成本×數量。",
        pos: withProfit(pos),
        online: withProfit(online),
        total: withProfit({
          count: pos.count + online.count,
          quantity: pos.quantity + online.quantity,
          amount: pos.amount + online.amount,
          cost: pos.cost + online.cost,
        }),
      },
      web_orders_paid: {
        note: "網站訂單（含活動／策旅票券、電話報名）已付款，依付款時間（台北）。選物／書也已計入上面的 online，不要相加。",
        count: orders.length,
        amount: orders.reduce((n, o) => n + Number(o.total ?? 0), 0),
        by_payment_method: group((o) => o.payment_method ?? "unknown"),
        by_source: group((o) => o.source ?? "web"),
      },
    });
  },

  /* ============================================================ 進銷存 */

  async list_inventory(args) {
    const slim = (r: {
      inv_product_id: string;
      name: string;
      issue_number: string | null;
      barcode: string | null;
      series: string | null;
      product_type: string;
      category_name: string | null;
      stock_quantity: number;
      low_stock_alert: number | null;
      vendor_name?: string | null;
      selling_price?: number | null;
      reserved?: number;
      available?: number;
      is_active?: boolean;
      listed_slug?: string | null;
    }) => ({
      inv_product_id: r.inv_product_id,
      name: r.name,
      issue_number: r.issue_number,
      barcode: r.barcode,
      series: r.series,
      product_type: r.product_type,
      category_name: r.category_name,
      vendor_name: r.vendor_name,
      selling_price: r.selling_price,
      stock_quantity: r.stock_quantity,
      reserved: r.reserved,
      available: r.available,
      low_stock_alert: r.low_stock_alert,
      is_active: r.is_active,
      listed_slug: r.listed_slug,
    });

    if (args.low_stock_only) {
      // 與盤點頁同一支（repos/inv-adjustments.ts#listStockCountProducts）：分段讀完後用
      // src/lib/admin/low-stock.ts#isLowStock（每件自己的警示值）篩，分頁也在 repo 裡做。
      const { listStockCountProducts } = await import("@/server/repos/inv-adjustments");
      const { rows, total } = await listStockCountProducts({
        keyword: args.keyword ?? null,
        categoryId: null,
        productType: args.product_type ?? null,
        lowStockOnly: true,
        page: args.page - 1,
        pageSize: args.limit,
      });
      return jsonText({
        low_stock_only: true,
        ...pageMeta(total, args.limit, args.page, rows.length),
        rows: rows.map(slim),
        note: "與後台盤點頁相同：只看啟用且已審核的品項；庫存 ≤ 該品項自己的警示數量（警示 0＝不警示），依品名排序。",
      });
    }

    const { listAdminProducts } = await import("@/server/repos/inv-products");
    const { rows, total } = await listAdminProducts({
      keyword: args.keyword ?? null,
      categoryId: null,
      productType: args.product_type ?? null,
      vendorId: null,
      approvalStatus: "all",
      activeStatus: args.active,
      priceChange: "all",
      sort: "name_asc",
      page: args.page - 1,
      pageSize: args.limit,
    });
    return jsonText({
      ...pageMeta(total, args.limit, args.page, rows.length),
      rows: rows.map(slim),
    });
  },

  async get_inventory_product({ id }) {
    const { getAdminProduct } = await import("@/server/repos/inv-products");
    const row = await getAdminProduct(id);
    if (!row) notFound("進銷存商品", id);
    const { user_id: _user, ...rest } = row;
    return jsonText(rest);
  },

  async list_stock_alerts(args) {
    const { listStockAlerts } = await import("@/server/repos/inv-sales");
    const rows = await listStockAlerts(args.status);
    const p = paged(rows, args.limit, args.page);
    return jsonText({
      ...p,
      rows: p.rows.map(({ resolved_by: _by, ...r }) => r),
      note: "後台同一支查詢最多讀最新 500 筆。",
    });
  },

  async list_purchases(args) {
    const { listAdminPurchases } = await import("@/server/repos/inv-purchases");
    const { rows, total } = await listAdminPurchases({
      keyword: args.keyword ?? null,
      categoryId: null,
      vendorId: args.vendor_id ?? null,
      productType: null,
      approvalStatus: args.approval_status,
      expiryStatus: "all",
      stockStatus: "all",
      dateFrom: args.date_from ?? null,
      dateTo: args.date_to ?? null,
      sort: "purchase_date_desc",
      page: args.page - 1,
      pageSize: args.limit,
    });
    return jsonText({
      ...pageMeta(total, args.limit, args.page, rows.length),
      rows: rows.map((r) => ({
        purchase_id: r.purchase_id,
        purchase_date: r.purchase_date,
        product_name: r.product_name ?? r.item_name,
        issue_number: r.issue_number,
        quantity: r.quantity,
        remaining_quantity: r.remaining_quantity,
        unit_cost: r.unit_cost,
        subtotal: r.subtotal,
        vendor_name: r.vendor_name ?? r.vendor_text,
        approval_status: r.approval_status,
      })),
    });
  },

  async get_purchase({ id }) {
    const { getAdminPurchase } = await import("@/server/repos/inv-purchases");
    const row = await getAdminPurchase(id);
    if (!row) notFound("進貨單", id);
    const { user_id: _user, ...rest } = row;
    return jsonText(rest);
  },

  async list_vendors(args) {
    const { listAdminVendors } = await import("@/server/repos/inv-vendors");
    const rows = await listAdminVendors({
      keyword: args.keyword ?? null,
      entityType: "all",
      consignment: "all",
      status: args.status,
      approvalStatus: "all",
      sort: "name_asc",
    });
    const p = paged(rows, args.limit, args.page);
    return jsonText({
      ...p,
      rows: p.rows.map((r) => ({
        vendor_id: r.vendor_id,
        vendor_code: r.vendor_code,
        name: r.name,
        short_name: r.short_name,
        entity_type: r.entity_type,
        category_name: r.category_name,
        is_consignment: r.is_consignment,
        status: r.status,
        approval_status: r.approval_status,
        phone: r.phone,
        email: r.email,
        product_count: r.product_count,
        active_product_count: r.active_product_count,
        stock_units: r.stock_units,
        purchase_count: r.purchase_count,
        contract_end_date: r.contract_end_date,
      })),
    });
  },

  async get_vendor({ id }) {
    const { getAdminVendor, getAdminVendorRow } = await import("@/server/repos/inv-vendors");
    const [detail, row] = await Promise.all([getAdminVendor(id), getAdminVendorRow(id)]);
    if (!detail) notFound("廠商", id);
    // 🔴 識別碼連遮罩版本都不回（身分證、統編、外籍證號、居留證），只回「有沒有填」。
    const {
      tax_id_masked: _tax,
      id_number_masked: _idn,
      foreign_id_masked: _fid,
      residence_permit_number_masked: _rp,
      ...rest
    } = detail;
    return jsonText({
      ...rest,
      has_tax_id: row?.has_tax_id ?? null,
      has_id_number: row?.has_id_number ?? null,
      stats: row
        ? {
            product_count: row.product_count,
            active_product_count: row.active_product_count,
            stock_units: row.stock_units,
            purchase_count: row.purchase_count,
            contract_end_date: row.contract_end_date,
          }
        : null,
    });
  },

  /* ============================================================ 推廣 */

  async list_referrers(args) {
    const { listReferrers } = await import("@/server/repos/referrals");
    const rows = await listReferrers();
    const p = paged(rows, args.limit, args.page);
    return jsonText({
      ...p,
      rows: p.rows.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        kind: r.kind,
        discount_percent: r.discount_percent,
        active: r.active,
        created_at: r.created_at,
      })),
    });
  },

  async get_referral_report(args) {
    const { getMonthlyReport } = await import("@/server/repos/referrals");
    const { currentTaipeiMonth } = await import("@/lib/taipei-time");
    const period = args.period ?? currentTaipeiMonth();
    const report = await getMonthlyReport(period);
    const one = args.referrer_id
      ? report.referrers.find((r) => r.referrer.id === args.referrer_id)
      : undefined;
    if (args.referrer_id && !one) notFound("推廣者", args.referrer_id);
    const summary = (r: (typeof report.referrers)[number]) => ({
      id: r.referrer.id,
      name: r.referrer.name,
      code: r.referrer.code,
      kind: r.referrer.kind,
      active: r.referrer.active,
      order_count: r.orders.length,
      attributed_revenue: r.attributedRevenue,
      attributed_gross_profit: r.attributedGrossProfit,
      average_rate: r.averageRate,
      commission: r.commission,
      pool_share: r.poolShare,
      clawback: r.clawback.amount,
      payable: r.payable,
      settled_at: r.settlement?.settledAt ?? null,
      settled_amount: r.settlement?.amount ?? null,
      settled_differs: r.settledDiffers,
    });
    if (one) {
      return jsonText({
        period,
        referrer: summary(one),
        orders: one.orders,
        clawback_orders: one.clawback.orders,
      });
    }
    return jsonText({
      period,
      shop: report.shop,
      pool: report.pool,
      cap: report.cap,
      totals: report.totals,
      referrers: report.referrers.map(summary),
    });
  },

  /* ============================================================ 合作邀約 */

  async list_partnership_inquiries(args) {
    const { listInquiries, countInquiries, INQUIRY_LIST_LIMIT } =
      await import("@/server/repos/partnership-inquiries");
    const [rows, counts] = await Promise.all([listInquiries(args.status), countInquiries()]);
    const p = paged(rows, args.limit, args.page);
    return jsonText({
      counts,
      ...p,
      rows: p.rows.map(({ updated_at: _u, email_status: _e, ...r }) => r),
      note: `後台同一支查詢最多讀最新 ${INQUIRY_LIST_LIMIT} 筆。`,
    });
  },

  async get_partnership_inquiry({ id }) {
    const { getInquiry } = await import("@/server/repos/partnership-inquiries");
    const row = await getInquiry(id);
    if (!row) notFound("合作邀約", id);
    const { email_id: _emailId, ...rest } = row;
    return jsonText(rest);
  },
};
