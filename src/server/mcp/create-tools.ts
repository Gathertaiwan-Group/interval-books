/**
 * MCP 的三支「新增」工具：create_event、create_journey、create_shop_product。
 *
 * ── 一條規矩：走後台同一條路，不另寫任何 INSERT ──────────────────────────
 *   活動／策旅 → src/server/event-quick-create.ts（後台「一頁新增」那一支）
 *                prepareEventQuick() 算計畫（dry_run 到此為止）→ commitEventQuick() 寫入。
 *                活動＋票券商品走 0027 的 RPC、場次與票種走既有 repo，順序與失敗回復都
 *                是後台那一套；策旅多一張 /journeys 卡片。
 *   商品       → 後台「新增商品 › 一般商品」那一條：unified-products.ts#buildNewGoodsPayload
 *                → 後台同一支 productSchema 驗證 → repos/products.ts#upsertProduct。
 *                **不連進銷存、不寫庫存數字**（stock 一律 null＝「不管理」，與後台新增表單
 *                的預設相同）。要接進銷存或限量，店員到後台處理。
 *
 * ── 三個預設，都是「AI 一次呼叫不會讓客人看到東西」 ───────────────────────
 *   · dry_run 預設 true：只回傳「將會建立什麼」與驗證錯誤，不寫入。
 *   · publish 預設 false：建成草稿（0052 的單一狀態 events.status='draft'，票券商品與策旅
 *     卡片由 trigger 跟著；一般商品 status=draft）。publish=true ＝直接上架（一支 RPC 把
 *     活動、票券商品、策旅卡片一起翻成上架）；之後要上架／下架用 set_event_status。
 *   · 每一次呼叫（預覽、被擋下、寫入成功、寫入失敗）都記一筆 mcp_audit_log。
 *
 * ── 授權 ──────────────────────────────────────────────────────────────────
 * 與其他工具一樣假設已經通過 src/server/mcp/http.ts（靜態 MCP_TOKEN，或 OAuth 且每次
 * 重查 profiles 是 admin）。另外多守一層：沒有 MCP 身分（currentMcpActor() 是 null，
 * 也就是沒經過那道閘門）就拒絕，不靠「只有 http.ts 會呼叫到這裡」這個默契。
 */
import "@tanstack/react-start/server-only";
import { z } from "zod4";
import {
  errText,
  fillLocalized,
  imageKeyFromArg,
  jsonText,
  McpInputError,
  zodIssuesText,
  type Localized,
  type LocalizedArg,
  type TextResult,
  type Translator,
} from "./core";
import { currentMcpActor } from "./actor";
import {
  DEFAULT_CAPACITY,
  DEFAULT_JOURNEY_CAPACITY,
  DEFAULT_LOCATION,
  QUICK_LIMITS,
  pastSessionErrors,
  planCapacityFor,
  validateQuickCreate,
  type QuickCreateErrors,
  type QuickCreateInput,
  type QuickKind,
} from "@/lib/admin/event-quick-create";

export const SITE_ORIGIN = "https://www.intervalbooks.tw";

/** 與 src/lib/admin/schemas.ts#eventSchema 的代稱規則逐字相同。 */
export const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SLUG_RULE = "網址代稱只能用英數字、連字號（-）、底線（_）與點（.），而且要以英數字開頭";

/* ------------------------------------------------------------------ 參數 */

/** 三語短欄位：中文字串，或 {zh, en?, ja?}。 */
function localizedText(what: string, max: number) {
  return z
    .union([
      z.string().trim().min(1, `${what}不可為空`).max(max, `${what}最多 ${max} 字`),
      z
        .object({
          zh: z
            .string()
            .trim()
            .min(1, `${what}的中文（zh）不可為空`)
            .max(max, `${what}最多 ${max} 字`),
          en: z
            .string()
            .trim()
            .max(max * 3, `${what}的英文太長`)
            .optional(),
          ja: z
            .string()
            .trim()
            .max(max * 3, `${what}的日文太長`)
            .optional(),
        })
        .strict(),
    ])
    .describe(
      `${what}。可以只給中文字串；或給 {"zh":…,"en":…,"ja":…}。英日文留空會自動翻譯，翻譯失敗就暫用中文（與後台一頁新增同一個規則）。`,
    );
}

const DATE_DESC = "日期 YYYY-MM-DD（台北時間）";
const dateArg = (what: string) =>
  z
    .string({ error: `${what}要填日期，格式 YYYY-MM-DD` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${what}格式要是 YYYY-MM-DD，例如 2026-12-20`)
    .describe(`${what}，${DATE_DESC}`);
const timeArg = (what: string) =>
  z
    .string({ error: `${what}要填時間，格式 HH:mm` })
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${what}格式要是 24 小時制 HH:mm，例如 14:00`)
    .describe(`${what}，24 小時制 HH:mm（台北時間）`);

const dryRunArg = z
  .boolean()
  .default(true)
  .describe(
    "預設 true：只回傳「將會建立什麼」的完整預覽與驗證錯誤，不寫入。確認後再以 false 呼叫一次才會真的建立。",
  );

const publishArg = (what: string) =>
  z
    .boolean()
    .default(false)
    .describe(
      `預設 false：建成草稿（${what}），網站上看不到。true＝直接上架（活動、票券商品、策旅卡片一起）；也可以先建草稿，之後用 set_event_status 設 status=live 上架。`,
    );

const slugArg = z
  .string()
  .trim()
  .min(1, "網址代稱不可為空字串；不想指定就不要送這個欄位")
  .max(80, "網址代稱最多 80 字")
  .regex(SLUG_RE, SLUG_RULE)
  .optional();

const imageArg = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .optional()
  .describe(
    "封面圖：先用 upload_image_from_url 上傳，再填它回傳的 key（storage:… 開頭）或這個站 site-images 的公開網址。省略＝沒有封面。",
  );

function eventInputSchema(kind: QuickKind) {
  const isJourney = kind === "journey";
  const noun = isJourney ? "策旅" : "活動";
  const defaultCap = isJourney ? DEFAULT_JOURNEY_CAPACITY : DEFAULT_CAPACITY;
  return z.object({
    title: localizedText(`${noun}名稱`, QUICK_LIMITS.title),
    category: z
      .string({ error: "請填分類 id（用 list_event_categories 查）" })
      .trim()
      .min(1, "請填分類 id（用 list_event_categories 查）")
      .max(100)
      .describe("分類：event_categories.id，用 list_event_categories 查"),
    summary: localizedText("摘要（列表卡片上的一句話）", QUICK_LIMITS.summary)
      .optional()
      .describe("摘要（列表卡片上的一句話）。選填：省略＝取介紹的第一段（超過 120 字截斷）。"),
    description: localizedText(`${noun}介紹（內文）`, QUICK_LIMITS.description),
    location: localizedText("地點", QUICK_LIMITS.location)
      .optional()
      .describe(
        isJourney
          ? "集合地點，套用到每一個梯次（梯次自己有 location 就用梯次的）。策旅必填（這裡或每個梯次擇一）。"
          : `地點，套用到每一個場次（場次自己有 location 就用場次的）。省略＝「${DEFAULT_LOCATION.zh}」。`,
      ),
    sessions: z
      .array(
        z.object({
          date: dateArg(isJourney ? "出發日期" : "場次日期"),
          start: timeArg("開始時間"),
          end: timeArg("結束時間"),
          end_date: dateArg("結束日期")
            .optional()
            .describe(
              isJourney
                ? "回程日期 YYYY-MM-DD。省略＝當天來回。"
                : "結束日期 YYYY-MM-DD。省略＝與開始同一天（活動通常不用填）。",
            ),
          location: localizedText("這一場的地點", QUICK_LIMITS.location).optional(),
          capacity: z
            .number({ error: "名額要是整數" })
            .int("名額要是整數")
            .min(1, "名額至少 1 位")
            .max(QUICK_LIMITS.capacity, `名額最多 ${QUICK_LIMITS.capacity}`)
            .optional()
            .describe(`名額（人數）。省略＝${defaultCap}。`),
        }),
      )
      .max(QUICK_LIMITS.sessions, `一次最多 ${QUICK_LIMITS.sessions} 個場次`)
      .default([])
      .describe(
        `${isJourney ? "梯次" : "場次"}（台北時間）。站內報名（paid／free）至少要一個；結束必須晚於開始，開始時間不能已經過去。`,
      ),
    registration_mode: z
      .enum(["paid", "free", "external"], { error: "報名方式只能是 paid、free 或 external" })
      .default("paid")
      .describe(
        "報名方式：paid＝站內付費報名（要有 ticket_types）；free＝站內免費報名；external＝連到外部報名網址（要有 external_url，不建票券商品與場次）。預設 paid。",
      ),
    ticket_types: z
      .array(
        z.object({
          name: localizedText("票種名稱", QUICK_LIMITS.planName),
          price: z
            .number({ error: "票價要是整數（新台幣元）" })
            .int("票價要是整數（新台幣元，不收小數）")
            .min(0, "票價不可為負數")
            .max(QUICK_LIMITS.price, "票價太大了"),
          seats_per_unit: z
            .number({ error: "每張票人數要是整數" })
            .int("每張票人數要是整數")
            .min(1, "每張票至少 1 人")
            .max(QUICK_LIMITS.seatsPerUnit, `每張票最多 ${QUICK_LIMITS.seatsPerUnit} 人`)
            .optional()
            .describe("每張票是幾個人（雙人票＝2）。省略＝1。"),
        }),
      )
      .max(QUICK_LIMITS.plans, `最多 ${QUICK_LIMITS.plans} 個票種`)
      .default([])
      .describe(
        "票種（registration_mode=paid 時必填，至少一個）。每個場次都會掛上同一組票種；票種的可售張數＝場次名額 ÷ 每張票人數。",
      ),
    external_url: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe("外部報名網址（registration_mode=external 時必填，https:// 開頭）"),
    speaker_id: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .optional()
      .describe("講者：artists.id，用 list_speakers 查。選填。"),
    image_key: imageArg,
    slug: slugArg.describe(
      `網址代稱（/events/<代稱>）。選填：省略＝用第一場日期 YYYYMMDD 自動產生（撞號加 -2、-3）。指定的代稱若已被使用會被擋下。${SLUG_RULE}。`,
    ),
    ...(isJourney
      ? {
          theme: localizedText("策旅卡片上的主題（一句話）", 200)
            .optional()
            .describe("策旅卡片上的主題（一句話）。選填：省略＝用分類名稱。"),
        }
      : {}),
    publish: publishArg(isJourney ? "活動、票券商品、策旅卡片都是草稿" : "活動與票券商品都是草稿"),
    dry_run: dryRunArg,
  });
}

export const CREATE_TOOL_INPUTS = {
  create_event: eventInputSchema("event"),
  create_journey: eventInputSchema("journey"),
  create_shop_product: z.object({
    product_type: z
      .enum(["book", "goods"], { error: "商品分類只能是 book（書）或 goods（選物）" })
      .describe("分類：book＝書、goods＝選物"),
    title: localizedText("商品名稱", 200),
    summary: localizedText("一句話介紹", 500),
    description: localizedText("商品說明（長）", 5000)
      .optional()
      .describe("商品說明。選填：省略＝沿用 summary（與後台新增表單相同）。"),
    price: z
      .number({ error: "售價要是整數（新台幣元）" })
      .int("售價要是整數（新台幣元，不收小數）")
      .min(1, "售價至少 1 元")
      .max(1_000_000, "售價太大了")
      .describe("售價（新台幣整數元，至少 1）"),
    image_key: imageArg.describe(
      "商品圖：先用 upload_image_from_url 上傳，再填它回傳的 key（storage:… 開頭）或 site-images 公開網址。省略＝沒有圖。",
    ),
    slug: slugArg.describe(
      `網址代稱。選填：省略＝用英文名稱自動產生（加一段亂數避免撞號）。指定的代稱若已被使用會被擋下。${SLUG_RULE}。`,
    ),
    publish: z
      .boolean()
      .default(false)
      .describe(
        "只能是 false（預設）：商品一律建成草稿（status=draft）。MCP 不設庫存，所以不能一建好就上架；請店員在後台設定庫存或接進銷存後，再用 update_shop_product 設 status=active。",
      ),
    dry_run: dryRunArg,
  }),
} as const;

export type CreateToolName = keyof typeof CREATE_TOOL_INPUTS;

/** 參數格式不合 zod 時，交給 handler 的替身（見 auditedInputSchema）。 */
export type InvalidCreateArgs = {
  __invalid: { path: string; message: string }[];
  __raw: unknown;
};

/**
 * zod 的錯誤訊息 → 中文。schema 上自訂的訊息本來就是中文，原樣保留；只有 zod 內建的
 * 英文預設訊息（沒送必填欄位、型別錯、多餘的 key、三語格式不對…）依 issue code 換成中文。
 */
export function zhIssueMessage(issue: {
  code?: string;
  message: string;
  expected?: unknown;
  keys?: string[];
  maximum?: unknown;
  minimum?: unknown;
}): string {
  if (/[\u3400-\u9fff]/.test(issue.message)) return issue.message;
  switch (issue.code) {
    case "invalid_type":
      return /received undefined/.test(issue.message)
        ? "必填，請提供這個欄位"
        : `型別不對（應為 ${String(issue.expected ?? "?")}）`;
    case "invalid_union":
      return '格式不對：三語欄位請給一段中文字串，或 {"zh":…,"en":…,"ja":…}（只收 zh、en、ja 三個 key）';
    case "unrecognized_keys":
      return `不認得的欄位：${(issue.keys ?? []).join("、")}（三語欄位只收 zh、en、ja）`;
    case "too_big":
      return `太長或太大（上限 ${String(issue.maximum ?? "?")}）`;
    case "too_small":
      return `太短或太小（下限 ${String(issue.minimum ?? "?")}）`;
    case "invalid_value":
      return "不是允許的值";
    case "invalid_format":
      return "格式不對";
    default:
      return `格式不正確（${issue.message}）`;
  }
}

/** 取出 data 在 path 上的值（拿來判斷「沒送」）。 */
function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = data;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

/** 稽核裡的原始參數最多存這麼長（JSON 字元數）；格式錯的呼叫還沒過長度限制。 */
export const AUDIT_INPUT_MAX_CHARS = 16_000;

export function boundedForAudit(value: unknown): unknown {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    return { unserializable: true };
  }
  if (text.length <= AUDIT_INPUT_MAX_CHARS) return value;
  return {
    truncated: true,
    original_chars: text.length,
    head: text.slice(0, AUDIT_INPUT_MAX_CHARS),
  };
}

export function isInvalidArgs(v: unknown): v is InvalidCreateArgs {
  return typeof v === "object" && v !== null && "__invalid" in v;
}

/**
 * 給 SDK 註冊用的 inputSchema：JSON Schema（tools/list 給 AI 看的）與原本的 zod schema
 * 一模一樣，但驗證失敗時**不在 SDK 那一層就丟回去**，而是把錯誤包成 InvalidCreateArgs
 * 交給 handler —— handler 記一筆稽核（outcome=rejected）再回中文錯誤。
 *
 * 為什麼：規格是「每一次呼叫都記稽核」。SDK 的 validateToolInput() 失敗時根本不會呼叫
 * handler，格式錯的呼叫就會在稽核表裡消失。驗證規則本身仍然只有一份（就是這支 zod schema）。
 */
export function auditedInputSchema<S extends z.ZodType>(schema: S): S {
  const std = schema["~standard"];
  const wrapped = {
    "~standard": {
      version: 1 as const,
      vendor: std.vendor,
      jsonSchema: std.jsonSchema,
      validate: (data: unknown) => {
        const r = schema.safeParse(data);
        if (r.success) return { value: r.data };
        const value: InvalidCreateArgs = {
          __invalid: r.error.issues.map((i) => ({
            path: i.path.map((p) => String(p)).join("."),
            message:
              valueAt(data, i.path) === undefined && !/[\u3400-\u9fff]/.test(i.message)
                ? "必填，請提供這個欄位"
                : zhIssueMessage(i),
          })),
          __raw: data,
        };
        return { value };
      },
    },
  };
  return wrapped as unknown as S;
}
export type CreateEventArgs = z.output<(typeof CREATE_TOOL_INPUTS)["create_journey"]>;
export type CreateShopProductArgs = z.output<(typeof CREATE_TOOL_INPUTS)["create_shop_product"]>;

/* ------------------------------------------------------------------ 說明 */

const COMMON_NOTE =
  "🔸 預設 dry_run=true：只回傳「將會建立什麼」的完整預覽（含驗證錯誤），不寫入；把預覽給使用者確認後，用同樣參數加 dry_run=false 再呼叫一次才會建立。" +
  "🔸 預設建成草稿（publish=false），網站上看不到；要直接上架必須明確帶 publish=true，或之後用 set_event_status（活動／策旅）或 update_shop_product（一般商品）上架。" +
  "🔸 時間一律台北時間；開始時間已經過去、結束早於開始、名稱或網址代稱與既有資料重複都會被擋下。" +
  "🔸 每一次呼叫（含 dry_run）都會留稽核紀錄。";

export const CREATE_TOOL_META: Record<CreateToolName, { title: string; description: string }> = {
  create_event: {
    title: "新增活動",
    description:
      "新增一場活動，一次建好：活動頁、售票商品、場次、票種（與後台「一頁新增活動」同一套流程）。" +
      "需要：名稱、分類（list_event_categories）、介紹、場次（日期＋開始/結束時間＋名額）、票種（名稱＋價格）。" +
      "免費活動 registration_mode=free（不用票種）；外部報名 registration_mode=external＋external_url。" +
      "封面圖先用 upload_image_from_url 上傳再填 image_key。" +
      COMMON_NOTE +
      "🔸 不碰訂單、金流、報名名單；建好後的場次與票種修改請到後台。",
  },
  create_journey: {
    title: "新增策旅",
    description:
      "新增一個策旅（旅行行程），一次建好：活動頁、售票商品、梯次、票種，再加一張 /journeys 的策旅卡片（與後台「一頁新增策旅」同一套流程）。" +
      "梯次可以跨日：date＝出發日、end_date＝回程日。集合地點必填（location 或每個梯次的 location）。" +
      COMMON_NOTE +
      "🔸 不碰訂單、金流、報名名單；建好後的梯次與票種修改請到後台。",
  },
  create_shop_product: {
    title: "新增商品（書／選物）",
    description:
      "新增一件一般商品（book 書或 goods 選物），與後台「新增商品 › 一般商品」同一條路。" +
      "只建商品資料：名稱、分類、售價、介紹、圖片、三語。" +
      "🔸 不設庫存：不寫庫存數字、也不連進銷存（庫存顯示為「不管理」），建好後由店員在後台設定庫存或接進銷存。" +
      "🔸 預設 dry_run=true：只回傳「將會建立什麼」的完整預覽（含驗證錯誤），不寫入；確認後用同樣參數加 dry_run=false 再呼叫一次才會建立。" +
      "🔸 一律建成草稿（status=draft），網站上看不到；因為沒有庫存，不能一建好就上架（publish=true 會被擋下）。店員處理庫存後，再用 update_shop_product 設 status=active。" +
      "🔸 名稱或網址代稱與既有商品重複會被擋下。🔸 每一次呼叫（含 dry_run）都會留稽核紀錄。",
  },
};

/* ------------------------------------------------------------------ 共用 */

/** 欄位路徑 → 給人看的名稱（"sessions.0.end" → 「場次 1 的結束時間」）。 */
export function fieldLabel(path: string, kind: QuickKind | "product" = "event"): string {
  const sessionNoun = kind === "journey" ? "梯次" : "場次";
  const top: Record<string, string> = {
    title: "名稱（title）",
    category: "分類（category）",
    summary: "摘要（summary）",
    description: "介紹（description）",
    sessions: `${sessionNoun}（sessions）`,
    plans: "票種（ticket_types）",
    ticket_types: "票種（ticket_types）",
    registration_mode: "報名方式（registration_mode）",
    publish: "是否公開（publish）",
    dry_run: "預覽模式（dry_run）",
    external_url: "外部報名網址（external_url）",
    speaker_id: "講者（speaker_id）",
    image_key: "封面圖（image_key）",
    slug: "網址代稱（slug）",
    location: "地點（location）",
    theme: "主題（theme）",
    price: "售價（price）",
    product_type: "分類（product_type）",
  };
  const sub: Record<string, string> = {
    date: kind === "journey" ? "出發日期（date）" : "日期（date）",
    start: "開始時間（start）",
    end: "結束時間（end）",
    end_date: kind === "journey" ? "回程日期（end_date）" : "結束日期（end_date）",
    location: "地點（location）",
    capacity: "名額（capacity）",
    name: "名稱（name）",
    price: "價格（price）",
    seats_per_unit: "每張票人數（seats_per_unit）",
  };
  const m = /^(sessions|plans|ticket_types)\.(\d+)\.(\w+)(?:\..*)?$/.exec(path);
  if (m) {
    const noun = m[1] === "sessions" ? sessionNoun : "票種";
    return `第 ${Number(m[2]) + 1} 個${noun}的${sub[m[3]] ?? m[3]}`;
  }
  const head = path.split(".")[0];
  return top[path] ?? top[head] ?? (path || "(整體參數)");
}

/** 錯誤集合 → 一段給 AI 看得懂「要補什麼」的文字。 */
export function errorsText(errors: QuickCreateErrors, kind: QuickKind | "product"): string {
  const lines = Object.entries(errors).map(([k, v]) => `・${fieldLabel(k, kind)}：${v}`);
  return `參數有 ${lines.length} 個問題，沒有寫入任何資料。請修正後再呼叫一次：\n${lines.join("\n")}`;
}

/** 被擋下的輸入錯誤，帶著逐欄的錯誤清單（給稽核記錄）。 */
export class CreateValidationError extends McpInputError {
  readonly errors: QuickCreateErrors;
  constructor(errors: QuickCreateErrors, kind: QuickKind | "product") {
    super(errorsText(errors, kind));
    this.name = "CreateValidationError";
    this.errors = errors;
  }
}

function kindOf(tool: CreateToolName): QuickKind | "product" {
  return tool === "create_journey" ? "journey" : tool === "create_event" ? "event" : "product";
}

function requireGatedActor(): void {
  if (!currentMcpActor()) {
    throw new McpInputError(
      "這個請求沒有通過 MCP 認證（需要 MCP_TOKEN，或 admin 帳號的 OAuth 授權）。",
    );
  }
}

function toArg(v: LocalizedArg | undefined): { zh: string; en?: string; ja?: string } | null {
  if (v === undefined) return null;
  if (typeof v === "string") return { zh: v.trim() };
  return { zh: v.zh.trim(), en: v.en?.trim() || undefined, ja: v.ja?.trim() || undefined };
}

type AuditOutcome = "preview" | "rejected" | "created" | "failed";

async function audit(
  tool: CreateToolName,
  entity: string,
  entityId: string,
  outcome: AuditOutcome,
  dryRun: boolean,
  changes: Record<string, unknown>,
): Promise<"recorded" | "log_only"> {
  const { writeMcpAudit } = await import("./audit");
  return writeMcpAudit({
    tool,
    entity,
    entity_id: entityId,
    action: "create",
    changes: { dry_run: dryRun, outcome, ...changes },
    dry_run: dryRun,
  });
}

function auditLabel(status: "recorded" | "log_only"): string {
  return status === "recorded" ? "recorded" : "log_only（稽核表寫入失敗，紀錄只在伺服器 log）";
}

/**
 * 包住一支新增工具：任何結果（預覽／擋下／成功／失敗）都記稽核，然後才回給 AI。
 * 稽核本身永不 throw（audit.ts）。
 */
async function withAudit(
  tool: CreateToolName,
  entity: string,
  args: { dry_run?: boolean },
  fn: () => Promise<{
    result: Record<string, unknown>;
    entityId: string;
    outcome: "preview" | "created";
    auditChanges: Record<string, unknown>;
  }>,
): Promise<TextResult> {
  try {
    requireGatedActor();
  } catch (err) {
    // 正常流量到不了這裡（http.ts 先回 401）；真的到了也記一筆（_actor 會是空的）。
    await audit(
      tool,
      entity,
      "(未建立)",
      "rejected",
      (args as { dry_run?: unknown })?.dry_run !== false,
      {
        error: (err as Error).message,
      },
    );
    return errText((err as Error).message);
  }
  if (isInvalidArgs(args)) {
    // 格式錯：SDK 那一層的 zod 驗證沒過（見 auditedInputSchema）。記稽核、回中文。
    const raw = args.__raw as { dry_run?: unknown } | null;
    const errors: QuickCreateErrors = {};
    for (const i of args.__invalid) {
      if (!errors[i.path]) errors[i.path] = i.message;
    }
    const message = errorsText(errors, kindOf(tool));
    const status = await audit(tool, entity, "(未建立)", "rejected", raw?.dry_run !== false, {
      input: boundedForAudit(args.__raw),
      error: message,
      errors,
    });
    return errText(`${message}\n（稽核：${auditLabel(status)}）`);
  }
  const dryRun = args.dry_run !== false;
  const input = boundedForAudit({ ...(args as Record<string, unknown>) });
  try {
    const out = await fn();
    const status = await audit(tool, entity, out.entityId, out.outcome, dryRun, {
      input,
      ...out.auditChanges,
    });
    return jsonText({ ...out.result, audit: auditLabel(status) });
  } catch (err) {
    const isInput = err instanceof McpInputError;
    const zodText = isInput ? null : zodIssuesText(err);
    const message = isInput
      ? err.message
      : zodText
        ? `欄位驗證失敗：${zodText}`
        : `執行失敗：${err instanceof Error ? err.message : String(err)}`;
    if (!isInput && !zodText) console.error(`[mcp] ${tool} error`, err);
    const status = await audit(
      tool,
      entity,
      "(未建立)",
      isInput || zodText ? "rejected" : "failed",
      dryRun,
      {
        input,
        error: message,
        errors: err instanceof CreateValidationError ? err.errors : undefined,
      },
    );
    return errText(`${message}\n（稽核：${auditLabel(status)}）`);
  }
}

/* ------------------------------------------------------------------ 活動／策旅 */

/**
 * MCP 參數 → 後台一頁新增的 QuickCreateInput，加上呼叫端給好的英日文。純函式。
 */
export function toQuickCreateInput(
  kind: QuickKind,
  args: CreateEventArgs,
  imageKey: string | null,
): { input: QuickCreateInput; preset: Map<string, { en?: string; ja?: string }> } {
  const preset = new Map<string, { en?: string; ja?: string }>();
  const take = (v: LocalizedArg | undefined): string => {
    const a = toArg(v);
    if (!a) return "";
    if (a.en || a.ja) {
      const prev = preset.get(a.zh) ?? {};
      preset.set(a.zh, { en: a.en ?? prev.en, ja: a.ja ?? prev.ja });
    }
    return a.zh;
  };
  const isJourney = kind === "journey";
  const fallbackLocation = take(args.location) || (isJourney ? "" : DEFAULT_LOCATION.zh);
  const defaultCap = isJourney ? DEFAULT_JOURNEY_CAPACITY : DEFAULT_CAPACITY;
  const input: QuickCreateInput = {
    kind,
    title: take(args.title),
    category: args.category.trim(),
    speaker_id: args.speaker_id?.trim() || null,
    image_key: imageKey,
    description: take(args.description),
    summary: take(args.summary),
    sessions: (args.sessions ?? []).map((s) => ({
      date: s.date,
      start: s.start,
      end: s.end,
      end_date: s.end_date ?? "",
      location: take(s.location) || fallbackLocation,
      capacity: s.capacity ?? defaultCap,
    })),
    mode: args.registration_mode,
    plans:
      args.registration_mode === "paid"
        ? (args.ticket_types ?? []).map((p) => ({
            name: take(p.name),
            price: p.price,
            seats_per_unit: p.seats_per_unit ?? 1,
          }))
        : [],
    external_url: args.registration_mode === "external" ? (args.external_url ?? "").trim() : "",
    publish: args.publish === true,
    theme: isJourney ? take((args as { theme?: LocalizedArg }).theme) : "",
  };
  return { input, preset };
}

/** 台北時間的顯示字串（不用 toLocaleString；Vercel 是 UTC）。 */
function taipeiText(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}（台北）`;
}

export async function runCreateEvent(kind: QuickKind, args: CreateEventArgs): Promise<TextResult> {
  const tool: CreateToolName = kind === "journey" ? "create_journey" : "create_event";
  const noun = kind === "journey" ? "策旅" : "活動";
  return withAudit(tool, kind === "journey" ? "journey" : "event", args, async () => {
    const dryRun = args.dry_run !== false;
    const errors: QuickCreateErrors = {};

    let imageKey: string | null = null;
    try {
      imageKey = imageKeyFromArg(args.image_key ?? null);
    } catch (err) {
      errors.image_key = (err as Error).message;
    }

    const { input, preset } = toQuickCreateInput(kind, args, imageKey);
    Object.assign(errors, validateQuickCreate(input), pastSessionErrors(input, Date.now()));

    const [
      { listEvents, listTakenEventSlugs },
      { listJourneys },
      { getEventCategoryById, listEventCategories },
      { getArtistById },
    ] = await Promise.all([
      import("@/server/repos/events"),
      import("@/server/repos/journeys"),
      import("@/server/repos/event-categories"),
      import("@/server/repos/artists"),
    ]);

    const title = input.title.trim();
    const [events, journeys, category, speaker, takenSlugs] = await Promise.all([
      listEvents(),
      kind === "journey" ? listJourneys() : Promise.resolve([]),
      input.category ? getEventCategoryById(input.category) : Promise.resolve(null),
      input.speaker_id ? getArtistById(input.speaker_id) : Promise.resolve(null),
      args.slug ? listTakenEventSlugs(args.slug) : Promise.resolve([] as string[]),
    ]);

    if (input.category && !category) {
      const ids = (await listEventCategories()).map((c) => `${c.id}（${c.label.zh}）`);
      errors.category = `找不到分類「${input.category}」。可用的分類：${ids.join("、")}`;
    }
    if (input.speaker_id && !speaker) {
      errors.speaker_id = `找不到講者「${input.speaker_id}」，請用 list_speakers 查 id，或不要送這個欄位`;
    }
    if (title) {
      const dupEvent = events.find((e) => e.title.zh.trim() === title);
      if (dupEvent) {
        errors.title = `已經有一場同名的活動「${title}」（id ${dupEvent.id}）。請換一個名稱；要改既有的那一場請用 update_event`;
      } else {
        const dupJourney = journeys.find((j) => j.title.zh.trim() === title);
        if (dupJourney) {
          errors.title = `已經有一個同名的策旅「${title}」（id ${dupJourney.id}）。請換一個名稱；要改既有的請用 update_journey`;
        }
      }
    }
    if (args.slug) {
      const lower = args.slug.toLowerCase();
      if (takenSlugs.some((s) => s.toLowerCase() === lower)) {
        errors.slug = `網址代稱「${args.slug}」已經被使用了，請換一個（或不要送，讓系統自動產生）`;
      }
    }
    if (Object.keys(errors).length) throw new CreateValidationError(errors, kind);

    const { prepareEventQuick, commitEventQuick } = await import("@/server/event-quick-create");
    const prepared = await prepareEventQuick(input, { slug: args.slug, preset });
    const { plan, journeyCard } = prepared;

    const preview = {
      [kind]: {
        slug: prepared.slug,
        url: `${SITE_ORIGIN}/events/${prepared.slug}`,
        title: plan.event.title,
        summary: plan.event.summary,
        description: plan.event.description,
        category: plan.event.category,
        speaker_id: plan.event.speaker_id,
        image_key: plan.event.image_key,
        display_date: plan.event.display_date,
        registration_type: plan.event.registration_type,
        payment_enabled: plan.event.payment_enabled,
        external_url: plan.event.external_url || undefined,
        status: input.publish ? "live" : "draft",
      },
      ticket_product: plan.product
        ? {
            price: plan.product.price,
            status: input.publish ? "active" : "draft",
            note: "售票商品由活動自動投影（名稱、摘要、圖片、上下架狀態都跟著活動走）",
          }
        : null,
      sessions: plan.sessions.map((s) => ({
        title: s.title.zh,
        starts_at: taipeiText(s.starts_at),
        ends_at: taipeiText(s.ends_at),
        location: s.location,
        capacity: s.capacity,
        status: "open",
        ticket_types: plan.plans.map((p) => ({
          title: p.title,
          price: p.price,
          seats_per_unit: p.seats_per_unit,
          capacity: planCapacityFor(s.capacity, p.seats_per_unit),
        })),
      })),
      journey_card: journeyCard
        ? {
            ...journeyCard,
            status: input.publish ? "live" : "draft",
            note: "卡片的上下架跟著活動走",
          }
        : undefined,
    };
    const translationNote =
      prepared.untranslated > 0
        ? `有 ${prepared.untranslated} 段中文自動翻譯失敗，英日文暫用中文（與後台一頁新增同一規則）；可以在正式呼叫時自己帶 {"zh","en","ja"}。`
        : undefined;

    if (dryRun) {
      return {
        entityId: "(dry_run)",
        outcome: "preview",
        auditChanges: { slug: prepared.slug },
        result: {
          dry_run: true,
          written: false,
          will_create: preview,
          translation_note: translationNote,
          next_step:
            `這只是預覽，還沒有寫入。確認無誤後，用同樣的參數加上 dry_run=false 再呼叫一次。` +
            `英日文是自動翻譯的，正式呼叫時會重新翻譯；要保證一字不差，請把上面的 en/ja 以 {"zh","en","ja"} 帶進來。` +
            (input.publish
              ? ""
              : `預設建成草稿，網站上看不到；建好後可用 set_event_status（status=live）上架${kind === "journey" ? "，策旅卡片會一起上架" : ""}。`),
        },
      };
    }

    const saved = await commitEventQuick(prepared);
    return {
      entityId: saved.eventId,
      outcome: "created",
      auditChanges: {
        event_id: saved.eventId,
        slug: saved.slug,
        product_id: saved.productId,
        session_ids: saved.sessionIds,
        plan_ids: saved.planIds,
        journey_id: saved.journeyId,
        published: saved.published,
      },
      result: {
        dry_run: false,
        written: true,
        message: `已建立${noun}${saved.published ? "（已上架）" : "（草稿，網站上看不到）"}`,
        event_id: saved.eventId,
        journey_id: saved.journeyId ?? undefined,
        product_id: saved.productId,
        session_ids: saved.sessionIds,
        ticket_type_ids: saved.planIds,
        slug: saved.slug,
        url: `${SITE_ORIGIN}/events/${saved.slug}`,
        published: saved.published,
        created: preview,
        translation_note:
          saved.untranslated > 0
            ? `有 ${saved.untranslated} 段英日文暫用中文，可用 update_${kind === "journey" ? "journey" : "event"} 補。`
            : undefined,
        next_step: saved.published
          ? undefined
          : `這是草稿。要上架：set_event_status（id=${saved.eventId}, status=live），活動、票券商品${
              saved.journeyId ? "、策旅卡片" : ""
            }會一起上架。`,
      },
    };
  });
}

/* ------------------------------------------------------------------ 一般商品 */

/** 一般商品的代稱尾巴：與後台新增頁同一個做法（5 碼亂數）。 */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}

export async function runCreateShopProduct(
  args: CreateShopProductArgs,
  deps: { translator: () => Promise<Translator | null> },
): Promise<TextResult> {
  return withAudit("create_shop_product", "product", args, async () => {
    const dryRun = args.dry_run !== false;
    const errors: QuickCreateErrors = {};

    let imageKey: string | null = null;
    try {
      imageKey = imageKeyFromArg(args.image_key ?? null);
    } catch (err) {
      errors.image_key = (err as Error).message;
    }

    const [
      { listProducts, upsertProduct, findProductConflicts },
      { productSchema },
      { buildNewGoodsPayload, slugFromTitle },
    ] = await Promise.all([
      import("@/server/repos/products"),
      import("@/lib/admin/schemas"),
      import("@/lib/admin/unified-products"),
    ]);
    const titleZhForLookup = toArg(args.title)?.zh ?? "";
    const [products, conflicts] = await Promise.all([
      listProducts(),
      findProductConflicts({ titleZh: titleZhForLookup, slug: args.slug ?? null }),
    ]);

    if (args.publish === true) {
      errors.publish =
        "新增商品不能直接上架（MCP 不設庫存，直接上架會變成不限量販售）。請拿掉 publish 或設 false；店員在後台設定庫存後，再用 update_shop_product 設 status=active";
    }
    const titleZh = titleZhForLookup;
    // 精準查（不靠 listProducts 全表：PostgREST 一次最多回 1000 列，商品多了會漏）。
    const dup = conflicts.sameTitle.find(
      (p) => p.product_type === "goods" || p.product_type === "book",
    );
    if (dup) {
      errors.title = `已經有同名的商品「${titleZh}」（id ${dup.id}，狀態 ${dup.status}）。請換一個名稱；要改既有的請用 update_shop_product`;
    }
    if (args.slug) {
      const lower = args.slug.toLowerCase();
      if (conflicts.sameSlug.some((p) => p.slug.toLowerCase() === lower)) {
        errors.slug = `網址代稱「${args.slug}」已經被使用了，請換一個（或不要送，讓系統自動產生）`;
      }
    }
    if (Object.keys(errors).length) throw new CreateValidationError(errors, "product");

    // 三語：與其他 MCP 寫入工具同一個規則（core.ts#fillLocalized）。
    const t = await deps.translator();
    const translated: string[] = [];
    const fill = async (field: string, v: LocalizedArg): Promise<Localized> => {
      const r = await fillLocalized(field, v, t);
      if (r.translated) translated.push(field);
      return r.value;
    };
    const title = await fill("title", args.title);
    const summary = await fill("summary", args.summary);
    const description = args.description ? await fill("description", args.description) : summary;

    const slug = args.slug ?? slugFromTitle(title.en, randomSuffix());
    const sortOrder = products.reduce((max, p) => Math.max(max, p.sort_order), 0) + 1;
    const payload = buildNewGoodsPayload({
      product_type: args.product_type,
      title,
      summary,
      description,
      price: args.price,
      stock: null, // 🔴 不設庫存：null＝「不管理」，與後台新增表單的預設相同。見檔頭。
      image_key: imageKey,
      publish: false, // 一律草稿：publish=true 在上面就被擋下了。
      slug,
      sort_order: sortOrder,
    });
    const parsed = productSchema.safeParse(payload);
    if (!parsed.success) {
      throw new McpInputError(
        `欄位驗證失敗（與後台同一套規則）：${zodIssuesText(parsed.error) ?? "格式不正確"}`,
      );
    }
    const valid = parsed.data;

    const preview = {
      product: {
        slug: valid.slug,
        product_type: valid.product_type,
        title: valid.title,
        summary: valid.summary,
        description: valid.description,
        price: valid.price,
        image_key: valid.image_key ?? null,
        status: valid.status,
        stock: "不設定（顯示為「不管理」；不連進銷存）",
        requires_shipping: valid.requires_shipping,
      },
      auto_translated: translated.length ? translated : undefined,
    };
    const stockNote =
      "庫存沒有設定（MCP 不碰庫存）。上架前請店員到後台「商品」設定庫存數量，或從「進銷存」上架連動庫存；目前是草稿，網站上看不到。";

    if (dryRun) {
      return {
        entityId: "(dry_run)",
        outcome: "preview",
        auditChanges: { slug: valid.slug },
        result: {
          dry_run: true,
          written: false,
          will_create: preview,
          stock_note: stockNote,
          next_step:
            "這只是預覽，還沒有寫入。確認無誤後，用同樣的參數加上 dry_run=false 再呼叫一次。" +
            (translated.length
              ? '英日文是自動翻譯的；要保證寫入的譯文與這裡一字不差，請把上面的 en/ja 以 {"zh","en","ja"} 帶進正式呼叫。'
              : "") +
            (args.slug ? "" : "網址代稱的亂數尾巴每次呼叫都會不同；要固定請帶 slug。"),
        },
      };
    }

    const row = await upsertProduct(valid);
    return {
      entityId: row.id,
      outcome: "created",
      auditChanges: { product_id: row.id, slug: row.slug, status: row.status },
      result: {
        dry_run: false,
        written: true,
        message: "已建立商品（草稿，網站上看不到）",
        product_id: row.id,
        slug: row.slug,
        status: row.status,
        created: preview,
        stock_note: stockNote,
        next_step: `要上架：先請店員設定庫存，再用 update_shop_product（id=${row.id}）設 status=active。`,
      },
    };
  });
}
