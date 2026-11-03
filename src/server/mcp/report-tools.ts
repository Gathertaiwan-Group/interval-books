/**
 * MCP 工具 —— 階段 D「分析與報表」：CSV 匯出、熱銷排行、活動報名率、客人回購率。
 *
 * ── 一條規矩：只讀業務資料 ─────────────────────────────────────────────────
 * 這裡**沒有任何一支改業務資料**（訂單、報名、商品、庫存都不碰）。唯一的「寫」是：
 *   · 把匯出的 CSV 放進**私有** bucket mcp-report-exports（0055），回 15 分鐘到期的
 *     signed URL；
 *   · 每次匯出寫一筆 mcp_audit_log（action="export"，記工具、條件、列數，不記個資）。
 * 所以 annotations 全部 readOnlyHint:true（唯讀連線也能用），但匯出工具的說明裡講清楚
 * 「會產生含個資的下載連結」。
 *
 * ── 為什麼回 signed URL，不回 CSV 內文 ──────────────────────────────────────
 * CSV 內文一回到對話裡，就進了模型的上下文、對話紀錄、可能還有第三方的 log。下載連結
 * 15 分鐘後失效，檔案留在私有 bucket（沒有任何 storage.objects policy，與 0053 同寫法）。
 *
 * ── 大量讀取 ──────────────────────────────────────────────────────────────
 * PostgREST 每次最多回 1000 列（db-max-rows），整表讀取一律走 readAllPages、依唯一鍵排序
 * 分段（src/server/repos/read-all-pages.ts）。排行與報名率的回傳量：預設前 20、上限 100。
 *
 * ── 授權 ──────────────────────────────────────────────────────────────────
 * 與 admin-read-tools.ts 同一個模型：呼叫端已經通過 http.ts 的 admin 驗證。repos 一律在
 * handler 裡 dynamic import，這個模組載入時不碰 Supabase。
 *
 * GA4／Search Console 不在這裡（沒有 service account，業主另行處理）。
 */
import { z } from "zod4";
import { jsonText, McpInputError, type TextResult } from "./core";

/* ------------------------------------------------------------------ 共用 */

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;

/** 私有 bucket（0055）。 */
export const MCP_REPORT_BUCKET = "mcp-report-exports";
/** signed URL 的效期：15 分鐘。 */
export const REPORT_URL_TTL_SECONDS = 900;
/** 與 0055 的 file_size_limit 同一個數字（20 MiB）。 */
export const REPORT_MAX_BYTES = 20 * 1024 * 1024;
/** 匯出的日期區間上限（天）。 */
const MAX_SPAN_DAYS = 366;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dateReq = (what: string) =>
  z
    .string()
    .regex(DATE_RE, "日期格式是 YYYY-MM-DD")
    .describe(`${what}（YYYY-MM-DD，台北日期，含當天）`);
const dateOpt = (what: string) =>
  z
    .string()
    .regex(DATE_RE, "日期格式是 YYYY-MM-DD")
    .optional()
    .describe(`${what}（YYYY-MM-DD，台北日期，含當天）`);

const limitArg = z
  .number()
  .int()
  .min(1)
  .max(LIMIT_MAX)
  .default(LIMIT_DEFAULT)
  .describe(`回傳前幾名，預設 ${LIMIT_DEFAULT}、上限 ${LIMIT_MAX}`);

/** 台北日期 → [start, end) 的 UTC ISO。 */
function taipeiDayStartIso(day: string): string {
  return new Date(`${day}T00:00:00+08:00`).toISOString();
}
function taipeiDayEndIso(day: string): string {
  return new Date(new Date(`${day}T00:00:00+08:00`).getTime() + 86_400_000).toISOString();
}

/** 驗證區間：from ≤ to、不超過 MAX_SPAN_DAYS 天。 */
function checkSpan(from: string, to: string): void {
  if (from > to) throw new McpInputError("date_from 不能晚於 date_to");
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (!Number.isFinite(days)) throw new McpInputError("日期不合法");
  if (days > MAX_SPAN_DAYS) {
    throw new McpInputError(`日期區間最多 ${MAX_SPAN_DAYS} 天，請分段查詢`);
  }
}

/** 省略時：本月 1 日到今天（台北）。 */
async function defaultPeriod(
  from: string | undefined,
  to: string | undefined,
): Promise<{ from: string; to: string }> {
  const { taipeiToday } = await import("@/lib/taipei-time");
  const today = taipeiToday();
  const out = { from: from ?? `${today.slice(0, 7)}-01`, to: to ?? today };
  checkSpan(out.from, out.to);
  return out;
}

/** 三語欄位只取中文。 */
function zh(v: unknown): string | null {
  if (v && typeof v === "object" && "zh" in v) return String((v as { zh: unknown }).zh ?? "");
  return typeof v === "string" ? v : null;
}

function rate(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 10000) / 10000 : null;
}

type Page<T> = PromiseLike<{ data: T[] | null; error: { code?: string; message: string } | null }>;

/** CSV 裡的台北時間；null → 空白（不是「—」）。 */
async function csvTime(): Promise<(iso: string | null | undefined) => string> {
  const { formatTaipeiDateTime } = await import("@/lib/taipei-time");
  return (iso) => (iso ? formatTaipeiDateTime(iso) : "");
}

/* ------------------------------------------------------------------ 匯出：上傳＋簽名＋稽核 */

type ExportKind = "roster" | "orders" | "sales";

/**
 * CSV → 私有 bucket → 15 分鐘 signed URL → 稽核。回傳給模型的只有連結與統計，**沒有內文**。
 */
async function publishCsv(input: {
  tool: string;
  kind: ExportKind;
  filename: string;
  csv: string;
  rows: number;
  filters: Record<string, unknown>;
}): Promise<TextResult> {
  const bytes = new TextEncoder().encode(input.csv);
  if (bytes.byteLength > REPORT_MAX_BYTES) {
    throw new McpInputError(
      `CSV 有 ${bytes.byteLength} bytes，超過上限 ${REPORT_MAX_BYTES}（20 MiB）。請縮小日期範圍或加篩選條件再匯出。`,
    );
  }
  const { randomUUID } = await import("node:crypto");
  const { taipeiToday } = await import("@/lib/taipei-time");
  const path = `${input.kind}/${taipeiToday()}/${randomUUID()}.csv`;

  const { supabaseAdmin } = await import("@/server/supabase-admin");
  const bucket = supabaseAdmin().storage.from(MCP_REPORT_BUCKET);
  const up = await bucket.upload(path, bytes, { contentType: "text/csv", upsert: false });
  if (up.error) throw new Error(`CSV 上傳失敗：${up.error.message}`);
  const signed = await bucket.createSignedUrl(path, REPORT_URL_TTL_SECONDS, {
    download: input.filename,
  });
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(`下載連結建立失敗：${signed.error?.message ?? "沒有回傳網址"}`);
  }

  // 稽核：工具、條件、列數。filters 只放 id／日期／列舉值，沒有姓名、電話、Email。
  const { writeMcpAudit } = await import("./audit");
  const audit = await writeMcpAudit({
    tool: input.tool,
    entity: "report_export",
    entity_id: path,
    action: "export",
    changes: {
      bucket: MCP_REPORT_BUCKET,
      path,
      filters: input.filters,
      rows: input.rows,
      bytes: bytes.byteLength,
      expires_in_seconds: REPORT_URL_TTL_SECONDS,
    },
  });

  return jsonText({
    download_url: signed.data.signedUrl,
    expires_in_seconds: REPORT_URL_TTL_SECONDS,
    expires_at: new Date(Date.now() + REPORT_URL_TTL_SECONDS * 1000).toISOString(),
    filename: input.filename,
    rows: input.rows,
    bytes: bytes.byteLength,
    filters: input.filters,
    audit,
    note: "⚠️ 這個連結可以下載含個資的檔案，15 分鐘後失效。請只交給需要的人，不要貼到公開的地方。CSV 內文刻意不放進對話。",
  });
}

/* ------------------------------------------------------------------ 資料讀取（全部分段） */

type PaidOrder = {
  id: string;
  order_no: string;
  paid_at: string | null;
  total: number;
  payment_method: string | null;
  source: string | null;
};

/** 已付款、付款時間在 [from, to] 的訂單（台北日期）。 */
async function readPaidOrders(from: string, to: string): Promise<PaidOrder[]> {
  const { readAllPages } = await import("@/server/repos/read-all-pages");
  const { supabaseAdmin } = await import("@/server/supabase-admin");
  return readAllPages<PaidOrder>(
    (a, b) =>
      supabaseAdmin()
        .from("orders")
        .select("id, order_no, paid_at, total, payment_method, source")
        .eq("payment_status", "paid")
        .gte("paid_at", taipeiDayStartIso(from))
        .lt("paid_at", taipeiDayEndIso(to))
        .order("id", { ascending: true })
        .range(a, b) as unknown as Page<PaidOrder>,
    { label: "已付款訂單" },
  );
}

type ItemRow = {
  id: number;
  order_id: string;
  product_id: string | null;
  name: unknown;
  unit_price: number;
  quantity: number;
  subtotal: number;
  product_type: string;
};

/** 這幾張訂單的 order_items。order_id 每 200 張一批（URL 長度），每批再分段讀。 */
async function readOrderItems(orderIds: readonly string[]): Promise<ItemRow[]> {
  if (orderIds.length === 0) return [];
  const { readAllPages } = await import("@/server/repos/read-all-pages");
  const { supabaseAdmin } = await import("@/server/supabase-admin");
  const out: ItemRow[] = [];
  for (let i = 0; i < orderIds.length; i += 200) {
    const chunk = orderIds.slice(i, i + 200);
    out.push(
      ...(await readAllPages<ItemRow>(
        (a, b) =>
          supabaseAdmin()
            .from("order_items")
            .select("id, order_id, product_id, name, unit_price, quantity, subtotal, product_type")
            .in("order_id", chunk)
            .order("id", { ascending: true })
            .range(a, b) as unknown as Page<ItemRow>,
        { label: "訂單品項" },
      )),
    );
  }
  return out;
}

type SaleRow = {
  sale_id: string;
  sale_date: string;
  created_at: string;
  channel: string;
  inv_product_id: string | null;
  product_name: string | null;
  issue_number: string | null;
  series: string | null;
  product_type: string | null;
  quantity: number;
  unit_price: number | null;
  amount: number | null;
  cost_price: number | null;
  gross_profit: number | null;
  payment_method_name: string | null;
  is_reconciled: boolean | null;
};

/** 進銷存銷售紀錄（inv_pos_sales，與 /admin/sales 同一個 view），sale_date 在 [from, to]。 */
async function readInventorySales(
  from: string,
  to: string,
  channel: "all" | "pos" | "online",
): Promise<SaleRow[]> {
  const { readAllPages } = await import("@/server/repos/read-all-pages");
  const { supabaseAdmin } = await import("@/server/supabase-admin");
  return readAllPages<SaleRow>(
    (a, b) => {
      let q = supabaseAdmin()
        .from("inv_pos_sales")
        .select(
          "sale_id, sale_date, created_at, channel, inv_product_id, product_name, issue_number, series, product_type, quantity, unit_price, amount, cost_price, gross_profit, payment_method_name, is_reconciled",
        )
        .gte("sale_date", from)
        .lte("sale_date", to)
        .order("sale_id", { ascending: true })
        .range(a, b);
      if (channel !== "all") q = q.eq("channel", channel);
      return q as unknown as Page<SaleRow>;
    },
    { label: "進銷存銷售紀錄" },
  );
}

/* ------------------------------------------------------------------ 純函式（selftest 直接測） */

export type RankRow = {
  key: string;
  product_id: string | null;
  title: string;
  product_type: string | null;
  quantity: number;
  amount: number;
  orders: number;
  gross_profit?: number | null;
};

/** 排序：依 by 由大到小，同值再比另一個指標，再比名稱。截到 limit。 */
export function rankProducts(
  rows: readonly RankRow[],
  by: "quantity" | "amount",
  limit: number,
): (RankRow & { rank: number })[] {
  const other = by === "quantity" ? "amount" : "quantity";
  return [...rows]
    .sort(
      (a, b) => b[by] - a[by] || b[other] - a[other] || a.title.localeCompare(b.title, "zh-Hant"),
    )
    .slice(0, Math.min(Math.max(1, limit), LIMIT_MAX))
    .map((r, i) => ({ rank: i + 1, ...r }));
}

/** Email：去空白、轉小寫；沒有 @ 就不算。 */
export function normEmail(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toLowerCase();
  return s.includes("@") ? s : null;
}

/** 電話：只留數字；+886 9xx… → 09xx…；少於 8 碼不算。 */
export function normPhone(v: string | null | undefined): string | null {
  let d = (v ?? "").replace(/\D/g, "");
  if (d.startsWith("886") && d.length >= 11) d = `0${d.slice(3)}`;
  return d.length >= 8 ? d : null;
}

export type IdentOrder = {
  id: string;
  customer_email: string | null;
  customer_phone: string | null;
  paid_at: string;
  total: number;
};

/**
 * 回購率。口徑：
 *   · 同一位客人＝email（小寫）**或**電話（只留數字）相同，兩者任一相同就連在一起
 *     （union-find：A 單 email 與 B 單相同、B 單電話與 C 單相同 → A、B、C 是同一人）；
 *   · 兩者都沒有的訂單（電話報名可以不留聯絡方式）算 unidentified，不進分母；
 *   · repeat：期間內有 ≥ 2 張已付款訂單的客人 ÷ 期間內有下單的客人；
 *   · returning：期間內有下單、而且在期間開始**之前**也有已付款訂單的客人 ÷ 期間內客人。
 *
 * @param orders  付款時間 < periodEnd 的全部已付款訂單（含期間之前的歷史）
 */
export function computeRepurchase(
  orders: readonly IdentOrder[],
  periodStartIso: string,
  periodEndIso: string,
) {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    let c = x;
    while (c !== r) {
      const n = parent.get(c) as string;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const keyed: { order: IdentOrder; key: string | null }[] = [];
  for (const o of orders) {
    const keys = [normEmail(o.customer_email), normPhone(o.customer_phone)]
      .map((k, i) => (k ? `${i === 0 ? "e" : "p"}:${k}` : null))
      .filter((k): k is string => k !== null);
    for (const k of keys) if (!parent.has(k)) parent.set(k, k);
    if (keys.length === 2) union(keys[0], keys[1]);
    keyed.push({ order: o, key: keys[0] ?? null });
  }

  const inPeriod = (o: IdentOrder) => o.paid_at >= periodStartIso && o.paid_at < periodEndIso;
  const before = (o: IdentOrder) => o.paid_at < periodStartIso;
  const periodCount = new Map<string, number>();
  const hadBefore = new Set<string>();
  let ordersInPeriod = 0;
  let unidentified = 0;
  for (const { order, key } of keyed) {
    if (inPeriod(order)) {
      ordersInPeriod += 1;
      if (!key) {
        unidentified += 1;
        continue;
      }
      const c = find(key);
      periodCount.set(c, (periodCount.get(c) ?? 0) + 1);
    } else if (before(order) && key) {
      hadBefore.add(find(key));
    }
  }
  const customers = periodCount.size;
  let repeat = 0;
  let returning = 0;
  const dist = { "1": 0, "2": 0, "3+": 0 };
  for (const [c, n] of periodCount) {
    if (n >= 2) repeat += 1;
    if (hadBefore.has(c)) returning += 1;
    if (n === 1) dist["1"] += 1;
    else if (n === 2) dist["2"] += 1;
    else dist["3+"] += 1;
  }
  return {
    orders_in_period: ordersInPeriod,
    unidentified_orders: unidentified,
    customers,
    repeat_customers: repeat,
    repeat_rate: rate(repeat, customers),
    returning_customers: returning,
    returning_rate: rate(returning, customers),
    orders_per_customer: dist,
  };
}

/* ------------------------------------------------------------------ 輸入 schema */

export const REPORT_TOOL_INPUTS = {
  export_roster_csv: z.object({
    session_id: z.string().trim().uuid().describe("event_sessions.id（見 list_registrations）"),
  }),
  export_orders_csv: z.object({
    date_from: dateReq("下單日起"),
    date_to: dateReq("下單日迄"),
    status: z
      .enum(["pending", "processing", "shipped", "completed", "cancelled", "failed"])
      .optional()
      .describe("訂單狀態"),
    payment_status: z
      .enum(["pending", "paid", "failed", "refunded"])
      .optional()
      .describe("付款狀態"),
    payment_method: z
      .string()
      .trim()
      .regex(/^[a-z_]{2,20}$/, "付款方式是小寫英文，例如 card、transfer、free、atm")
      .optional()
      .describe("付款方式，例如 card、transfer、free、atm"),
    source: z
      .enum(["web", "admin_phone"])
      .optional()
      .describe("web 前台結帳／admin_phone 電話報名"),
    include_archived: z.boolean().default(false).describe("是否包含已封存訂單，預設 false"),
  }),
  export_sales_csv: z.object({
    date_from: dateReq("起日"),
    date_to: dateReq("迄日"),
    source: z
      .enum(["inventory", "web_orders"])
      .default("inventory")
      .describe(
        "inventory＝進銷存銷售紀錄（門市 POS＋網站選物，依銷售日）；web_orders＝網站訂單已付款的逐項明細（含活動／策旅票券，依付款時間）。兩者的網站選物重疊，不要相加。",
      ),
    channel: z
      .enum(["all", "pos", "online"])
      .default("all")
      .describe("只對 inventory 有效：pos 門市／online 網站"),
  }),

  get_top_products: z.object({
    date_from: dateOpt("起日；省略＝本月 1 日"),
    date_to: dateOpt("迄日；省略＝今天"),
    source: z
      .enum(["web_orders", "inventory"])
      .default("web_orders")
      .describe(
        "web_orders＝網站已付款訂單的品項（含刊物、選物、活動／策旅票券；依付款時間）；inventory＝進銷存銷售紀錄（門市＋網站，依銷售日）。兩者的網站選物重疊，所以分開看、不合併。",
      ),
    product_type: z
      .enum(["all", "goods", "book", "event", "journey"])
      .default("all")
      .describe("只對 web_orders 有效：goods 選物／book 刊物／event 活動／journey 策旅"),
    channel: z
      .enum(["all", "pos", "online"])
      .default("all")
      .describe("只對 inventory 有效：pos 門市／online 網站"),
    sort_by: z.enum(["quantity", "amount"]).default("quantity").describe("依數量或金額排序"),
    limit: limitArg,
  }),
  get_event_fill_rates: z.object({
    product_type: z
      .enum(["event", "journey", "all"])
      .default("all")
      .describe("event 活動／journey 策旅"),
    when: z
      .enum(["upcoming", "past", "all"])
      .default("all")
      .describe("upcoming 尚未開始／past 已開始／all 全部"),
    date_from: dateOpt("場次開始日起"),
    date_to: dateOpt("場次開始日迄"),
    sort_by: z
      .enum(["starts_at", "fill_rate_desc", "fill_rate_asc"])
      .default("starts_at")
      .describe(
        "starts_at 依開始時間（upcoming 由近到遠，其餘由新到舊）／fill_rate_desc／fill_rate_asc",
      ),
    limit: limitArg,
  }),
  get_repurchase_rate: z.object({
    date_from: dateOpt("起日；省略＝本月 1 日"),
    date_to: dateOpt("迄日；省略＝今天"),
    exclude_free: z.boolean().default(false).describe("排除 0 元訂單（免費場次報名），預設 false"),
  }),
} as const;

export type ReportToolName = keyof typeof REPORT_TOOL_INPUTS;
type Args<N extends ReportToolName> = z.output<(typeof REPORT_TOOL_INPUTS)[N]>;

/* ------------------------------------------------------------------ meta */

type Annotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

/** 不改業務資料。匯出每次產生新檔與新連結，所以不是冪等。 */
const EXPORT_ANN: Annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const READ_ANN: Annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const EXPORT_NOTE =
  "不改任何業務資料；CSV 放在私有儲存區，回傳 15 分鐘後失效的下載連結（不回 CSV 內文），每次匯出都會留操作紀錄。" +
  "⚠️ 這個連結可以下載含個資的檔案，請只交給需要的人。";
const READ_NOTE = "唯讀，不會改任何資料。";

export const REPORT_TOOL_META: Record<
  ReportToolName,
  { title: string; description: string; annotations: Annotations }
> = {
  export_roster_csv: {
    title: "匯出場次名單 CSV",
    description: `匯出一個場次的簽到名單 CSV，與後台名單頁的「匯出 CSV」同一份資料與欄位（座位、姓名、電話、Email、訂單編號、付款時間、注意事項同意時間；只含已付款、算在簽到表上的參加者）。含明文個資。${EXPORT_NOTE}`,
    annotations: EXPORT_ANN,
  },
  export_orders_csv: {
    title: "匯出訂單 CSV",
    description: `匯出下單日期區間（最多 366 天）內的訂單 CSV，可依訂單狀態、付款狀態、付款方式、來源篩選。欄位：訂單編號、下單時間、付款時間、狀態、付款狀態與方式、來源、小計／運費／折扣／總額、訂購人姓名、電話、Email。含明文個資。${EXPORT_NOTE}`,
    annotations: EXPORT_ANN,
  },
  export_sales_csv: {
    title: "匯出營收明細 CSV",
    description: `匯出期間（最多 366 天）的營收明細 CSV。source=inventory：進銷存銷售紀錄逐筆（銷售日、通路、品名、期數、數量、單價、金額、成本、毛利、付款方式、對帳）；source=web_orders：網站已付款訂單的逐項明細（付款時間、訂單編號、品名、類型、單價、數量、小計、付款方式、來源；不含客人資料）。${EXPORT_NOTE}`,
    annotations: EXPORT_ANN,
  },
  get_top_products: {
    title: "熱銷排行",
    description:
      "期間（台北，預設本月 1 日到今天）內的熱銷刊物／商品排行，依數量或金額。口徑：" +
      "source=web_orders 只算付款狀態為 paid 的網站訂單（退款不算），依付款時間，金額＝品項小計（未扣訂單層級的折扣與推薦碼優惠、不含運費），同一商品以 product_id 歸併；" +
      "source=inventory 是進銷存銷售紀錄（門市＋網站，依銷售日），金額＝銷售金額，附毛利。兩個來源的網站選物重疊，不要相加。" +
      `預設前 20、上限 100。${READ_NOTE}`,
    annotations: READ_ANN,
  },
  get_event_fill_rates: {
    title: "活動報名率",
    description:
      "各場活動／策旅的報名率＝已付款報名人數（簽到表上的人，0021 on_roster）÷ 名額（capacity）。另附佔位率＝已佔名額（seats_taken，含未付款訂單押著的位子）÷ 名額。名額 0 的場次報名率為 null。" +
      `附整體合計。預設 20 場、上限 100。${READ_NOTE}`,
    annotations: READ_ANN,
  },
  get_repurchase_rate: {
    title: "客人回購率",
    description:
      "期間（台北，預設本月 1 日到今天）內的客人回購率。口徑：只算付款狀態 paid 的網站訂單（含電話報名，依付款時間）；" +
      "同一位客人以 Email（不分大小寫）或電話（只比數字，+886 視同 0）任一相同辨識；兩者都沒有的訂單另計 unidentified_orders、不進分母。" +
      "repeat_rate＝期間內 ≥2 張訂單的客人 ÷ 期間內客人；returning_rate＝期間開始前也買過的客人 ÷ 期間內客人。只回統計數字，不回任何客人資料。" +
      READ_NOTE,
    annotations: READ_ANN,
  },
};

/* ------------------------------------------------------------------ 實作 */

type Handlers = { [N in ReportToolName]: (args: Args<N>) => Promise<TextResult> };

export const REPORT_HANDLERS: Handlers = {
  /* ============================================================ 匯出 */

  async export_roster_csv({ session_id }) {
    // 與後台名單匯出（fns/event-registrations.ts）同一支 repo、同一組欄位、同一個檔名規則。
    const { loadRosterExport } = await import("@/server/repos/event-registrations");
    const { ROSTER_CSV_COLUMNS, rosterFilename } = await import("@/lib/admin/roster-csv");
    const { toCsv } = await import("@/lib/csv");
    let exp;
    try {
      exp = await loadRosterExport(session_id);
    } catch (err) {
      if (err instanceof Error && err.message === "找不到這個場次") {
        throw new McpInputError(`找不到場次「${session_id}」。請先用 list_registrations 查 id。`);
      }
      throw err;
    }
    return publishCsv({
      tool: "export_roster_csv",
      kind: "roster",
      filename: rosterFilename(zh(exp.session_title) ?? "", exp.starts_at),
      csv: toCsv(exp.rows, ROSTER_CSV_COLUMNS),
      rows: exp.rows.length,
      filters: { session_id },
    });
  },

  async export_orders_csv(args) {
    checkSpan(args.date_from, args.date_to);
    type Row = {
      id: string;
      order_no: string;
      created_at: string;
      paid_at: string | null;
      status: string;
      payment_status: string;
      payment_method: string | null;
      source: string | null;
      subtotal: number;
      shipping_fee: number;
      discount: number;
      total: number;
      customer_name: string | null;
      customer_phone: string | null;
      customer_email: string | null;
    };
    const { readAllPages } = await import("@/server/repos/read-all-pages");
    const { supabaseAdmin } = await import("@/server/supabase-admin");
    const rows = await readAllPages<Row>(
      (a, b) => {
        let q = supabaseAdmin()
          .from("orders")
          .select(
            "id, order_no, created_at, paid_at, status, payment_status, payment_method, source, subtotal, shipping_fee, discount, total, customer_name, customer_phone, customer_email",
          )
          .gte("created_at", taipeiDayStartIso(args.date_from))
          .lt("created_at", taipeiDayEndIso(args.date_to))
          .order("id", { ascending: true })
          .range(a, b);
        if (!args.include_archived) q = q.is("archived_at", null);
        if (args.status) q = q.eq("status", args.status);
        if (args.payment_status) q = q.eq("payment_status", args.payment_status);
        if (args.payment_method) q = q.eq("payment_method", args.payment_method);
        if (args.source) q = q.eq("source", args.source);
        return q as unknown as Page<Row>;
      },
      { label: "訂單匯出" },
    );
    rows.sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id));

    const t = await csvTime();
    const { toCsv } = await import("@/lib/csv");
    const csv = toCsv<Row>(rows, [
      { header: "訂單編號", value: (r) => r.order_no, forceText: true },
      { header: "下單時間", value: (r) => t(r.created_at) },
      { header: "付款時間", value: (r) => t(r.paid_at) },
      { header: "訂單狀態", value: (r) => r.status },
      { header: "付款狀態", value: (r) => r.payment_status },
      { header: "付款方式", value: (r) => r.payment_method ?? "" },
      { header: "來源", value: (r) => r.source ?? "web" },
      { header: "小計", value: (r) => r.subtotal },
      { header: "運費", value: (r) => r.shipping_fee },
      { header: "折扣", value: (r) => r.discount },
      { header: "總額", value: (r) => r.total },
      { header: "訂購人", value: (r) => r.customer_name ?? "" },
      { header: "電話", value: (r) => r.customer_phone ?? "", forceText: true },
      { header: "Email", value: (r) => r.customer_email ?? "" },
    ]);
    const { include_archived, ...rest } = args;
    return publishCsv({
      tool: "export_orders_csv",
      kind: "orders",
      filename: `小時光訂單_${args.date_from.replace(/-/g, "")}-${args.date_to.replace(/-/g, "")}.csv`,
      csv,
      rows: rows.length,
      filters: { ...rest, include_archived },
    });
  },

  async export_sales_csv(args) {
    checkSpan(args.date_from, args.date_to);
    const { toCsv } = await import("@/lib/csv");
    const t = await csvTime();
    const span = `${args.date_from.replace(/-/g, "")}-${args.date_to.replace(/-/g, "")}`;

    if (args.source === "inventory") {
      const rows = await readInventorySales(args.date_from, args.date_to, args.channel);
      rows.sort(
        (x, y) =>
          x.sale_date.localeCompare(y.sale_date) ||
          x.created_at.localeCompare(y.created_at) ||
          x.sale_id.localeCompare(y.sale_id),
      );
      const csv = toCsv<SaleRow>(rows, [
        { header: "銷售日", value: (r) => r.sale_date },
        {
          header: "通路",
          value: (r) =>
            r.channel === "pos" ? "門市" : r.channel === "online" ? "網站" : r.channel,
        },
        { header: "品名", value: (r) => r.product_name ?? "" },
        { header: "期數", value: (r) => r.issue_number ?? "", forceText: true },
        { header: "系列", value: (r) => r.series ?? "" },
        { header: "類型", value: (r) => r.product_type ?? "" },
        { header: "數量", value: (r) => r.quantity },
        { header: "單價", value: (r) => r.unit_price ?? "" },
        { header: "金額", value: (r) => r.amount ?? "" },
        { header: "成本單價", value: (r) => r.cost_price ?? "" },
        { header: "毛利", value: (r) => r.gross_profit ?? "" },
        { header: "付款方式", value: (r) => r.payment_method_name ?? "" },
        { header: "已對帳", value: (r) => (r.is_reconciled ? "是" : "否") },
      ]);
      return publishCsv({
        tool: "export_sales_csv",
        kind: "sales",
        filename: `小時光銷售明細_${span}.csv`,
        csv,
        rows: rows.length,
        filters: { ...args },
      });
    }

    // web_orders：已付款訂單（依付款時間）的逐項明細，不含客人資料。
    const orders = await readPaidOrders(args.date_from, args.date_to);
    const byId = new Map(orders.map((o) => [o.id, o]));
    const items = await readOrderItems(orders.map((o) => o.id));
    type Line = ItemRow & { order: PaidOrder };
    const lines: Line[] = items
      .map((it) => ({ ...it, order: byId.get(it.order_id) as PaidOrder }))
      .filter((l) => l.order);
    lines.sort(
      (x, y) =>
        (x.order.paid_at ?? "").localeCompare(y.order.paid_at ?? "") ||
        x.order.order_no.localeCompare(y.order.order_no) ||
        x.id - y.id,
    );
    const csv = toCsv<Line>(lines, [
      { header: "付款時間", value: (l) => t(l.order.paid_at) },
      { header: "訂單編號", value: (l) => l.order.order_no, forceText: true },
      { header: "品名", value: (l) => zh(l.name) ?? "" },
      { header: "類型", value: (l) => l.product_type },
      { header: "單價", value: (l) => l.unit_price },
      { header: "數量", value: (l) => l.quantity },
      { header: "小計", value: (l) => l.subtotal },
      { header: "付款方式", value: (l) => l.order.payment_method ?? "" },
      { header: "來源", value: (l) => l.order.source ?? "web" },
    ]);
    const { channel: _channel, ...filters } = args;
    return publishCsv({
      tool: "export_sales_csv",
      kind: "sales",
      filename: `小時光網站訂單明細_${span}.csv`,
      csv,
      rows: lines.length,
      filters,
    });
  },

  /* ============================================================ 排行與轉換率 */

  async get_top_products(args) {
    const { from, to } = await defaultPeriod(args.date_from, args.date_to);
    const agg = new Map<string, RankRow & { _orders: Set<string> }>();

    if (args.source === "web_orders") {
      const orders = await readPaidOrders(from, to);
      const items = await readOrderItems(orders.map((o) => o.id));
      for (const it of items) {
        if (args.product_type !== "all" && it.product_type !== args.product_type) continue;
        const title = zh(it.name) ?? "";
        const key = it.product_id ? `p:${it.product_id}` : `n:${title}`;
        const g =
          agg.get(key) ??
          ({
            key,
            product_id: it.product_id,
            title,
            product_type: it.product_type,
            quantity: 0,
            amount: 0,
            orders: 0,
            _orders: new Set<string>(),
          } as RankRow & { _orders: Set<string> });
        g.quantity += Number(it.quantity ?? 0);
        g.amount += Number(it.subtotal ?? 0);
        g._orders.add(it.order_id);
        agg.set(key, g);
      }
    } else {
      const sales = await readInventorySales(from, to, args.channel);
      for (const s of sales) {
        const title = s.product_name ?? "";
        const key = s.inv_product_id ? `i:${s.inv_product_id}` : `n:${title}`;
        const g =
          agg.get(key) ??
          ({
            key,
            product_id: s.inv_product_id,
            title: s.issue_number ? `${title}（${s.issue_number}）` : title,
            product_type: s.product_type,
            quantity: 0,
            amount: 0,
            orders: 0,
            gross_profit: 0,
            _orders: new Set<string>(),
          } as RankRow & { _orders: Set<string> });
        g.quantity += Number(s.quantity ?? 0);
        g.amount += Number(s.amount ?? 0);
        // 有任何一筆沒有成本，毛利就不完整：標成 null 而不是少算。
        g.gross_profit =
          g.gross_profit === null || s.gross_profit === null
            ? null
            : (g.gross_profit ?? 0) + Number(s.gross_profit);
        g._orders.add(s.sale_id);
        agg.set(key, g);
      }
    }

    const all = [...agg.values()].map(({ _orders, ...r }) => ({ ...r, orders: _orders.size }));
    const ranked = rankProducts(all, args.sort_by, args.limit).map(({ key: _key, ...r }) => r);
    return jsonText({
      date_from: from,
      date_to: to,
      source: args.source,
      sort_by: args.sort_by,
      product_count: all.length,
      totals: {
        quantity: all.reduce((n, r) => n + r.quantity, 0),
        amount: all.reduce((n, r) => n + r.amount, 0),
      },
      rows: ranked,
      note:
        args.source === "web_orders"
          ? "網站已付款訂單（依付款時間）；amount＝品項小計（未扣訂單折扣、不含運費）；orders＝含此商品的訂單數。"
          : "進銷存銷售紀錄（依銷售日）；amount＝銷售金額；orders＝銷售筆數；gross_profit 為 null 表示有筆數沒填成本。",
    });
  },

  async get_event_fill_rates(args) {
    if (args.date_from && args.date_to && args.date_from > args.date_to) {
      throw new McpInputError("date_from 不能晚於 date_to");
    }
    // 與 /admin/registrations、list_registrations 同三支 repo。
    const repo = await import("@/server/repos/event-sessions");
    const { countRegistrationsBySession } = await import("@/server/repos/event-registrations");
    const [sessions, products, counts] = await Promise.all([
      repo.listEventSessions(),
      repo.listBookableProducts(),
      countRegistrationsBySession(),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const now = new Date().toISOString();
    const fromIso = args.date_from ? taipeiDayStartIso(args.date_from) : null;
    const toIso = args.date_to ? taipeiDayEndIso(args.date_to) : null;

    let rows = sessions
      .map((s) => {
        const p = productById.get(s.product_id);
        const c = counts[s.id] ?? { total: 0, paid: 0 };
        return {
          session_id: s.id,
          product_type: p?.product_type ?? null,
          product_slug: p?.slug ?? null,
          product_title: zh(p?.title),
          session_title: zh(s.title),
          starts_at: s.starts_at,
          status: s.status,
          capacity: s.capacity,
          paid_registrations: c.paid,
          registrations_total: c.total,
          seats_taken: s.seats_taken,
          fill_rate: rate(c.paid, s.capacity),
          occupancy_rate: rate(s.seats_taken, s.capacity),
        };
      })
      .filter((r) => {
        if (args.product_type !== "all" && r.product_type !== args.product_type) return false;
        if (args.when === "upcoming" && r.starts_at < now) return false;
        if (args.when === "past" && r.starts_at >= now) return false;
        if (fromIso && r.starts_at < fromIso) return false;
        if (toIso && r.starts_at >= toIso) return false;
        return true;
      });

    const byStart = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
      args.when === "upcoming"
        ? a.starts_at.localeCompare(b.starts_at)
        : b.starts_at.localeCompare(a.starts_at);
    if (args.sort_by === "starts_at") rows = rows.sort(byStart);
    else {
      const dir = args.sort_by === "fill_rate_desc" ? -1 : 1;
      // 名額 0（fill_rate null）一律排最後。
      rows = rows.sort((a, b) => {
        if (a.fill_rate === null || b.fill_rate === null) {
          return (a.fill_rate === null ? 1 : 0) - (b.fill_rate === null ? 1 : 0) || byStart(a, b);
        }
        return dir * (a.fill_rate - b.fill_rate) || byStart(a, b);
      });
    }

    const withCap = rows.filter((r) => r.capacity > 0);
    const capacity = withCap.reduce((n, r) => n + r.capacity, 0);
    const paid = withCap.reduce((n, r) => n + r.paid_registrations, 0);
    return jsonText({
      summary: {
        sessions: rows.length,
        sessions_with_capacity: withCap.length,
        capacity,
        paid_registrations: paid,
        overall_fill_rate: rate(paid, capacity),
      },
      returned: Math.min(rows.length, args.limit),
      rows: rows.slice(0, args.limit),
      note: "fill_rate＝已付款報名人數（簽到表上的人）÷ 名額；occupancy_rate＝已佔名額（含未付款訂單押著的位子）÷ 名額。整體合計只算名額 > 0 的場次。",
    });
  },

  async get_repurchase_rate(args) {
    const { from, to } = await defaultPeriod(args.date_from, args.date_to);
    const startIso = taipeiDayStartIso(from);
    const endIso = taipeiDayEndIso(to);
    const { readAllPages } = await import("@/server/repos/read-all-pages");
    const { supabaseAdmin } = await import("@/server/supabase-admin");
    // 期間結束前的全部已付款訂單（含歷史，才算得出 returning）。只取辨識用的欄位，
    // 在這個行程裡算完就丟，不回給呼叫端。
    const all = await readAllPages<IdentOrder>(
      (a, b) =>
        supabaseAdmin()
          .from("orders")
          .select("id, customer_email, customer_phone, paid_at, total")
          .eq("payment_status", "paid")
          .lt("paid_at", endIso)
          .order("id", { ascending: true })
          .range(a, b) as unknown as Page<IdentOrder>,
      { label: "回購率訂單" },
    );
    const orders = all.filter((o) => o.paid_at && (!args.exclude_free || Number(o.total ?? 0) > 0));
    return jsonText({
      date_from: from,
      date_to: to,
      exclude_free: args.exclude_free,
      ...computeRepurchase(orders, startIso, endIso),
      note: "只算已付款訂單（依付款時間）；同一客人＝Email 或電話任一相同。unidentified_orders 是沒有 Email 也沒有電話的訂單，不進分母。",
    });
  },
};
