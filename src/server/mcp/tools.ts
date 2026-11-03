/**
 * MCP 工具 —— 讓 AI 讀、改網站「內容」。
 *
 * ── 一條規矩：走後台同一條路 ──────────────────────────────────────────────
 * 每一支寫入工具都是「讀出那一列 → 套上這次的修改 → 用**後台同一支 zod schema**
 * （src/lib/admin/schemas.ts）驗過 → 呼叫**後台同一支 repo 函式**（src/server/repos/*）」。
 * 不寫任何一行繞過它們的 SQL，所以三語欄位的 is_localized() 規則、代稱、活動 → 商品
 * 的投影（admin_upsert_event_with_session）、錯誤訊息全部跟後台按「儲存」一模一樣。
 *
 * repos 一律在 handler 裡 dynamic import（與 src/lib/admin/fns/* 同一個慣例），這個模組
 * 本身載入時不碰 Supabase —— scripts/mcp-selftest.mjs 才能在沒有金鑰的機器上把整套工具
 * 列出來檢查。
 *
 * ── 授權 ──────────────────────────────────────────────────────────────────
 * 這裡的每一支都假設呼叫端已經通過 src/server/mcp/core.ts#gateMcpRequest()（與 repos
 * 假設呼叫端通過 adminFnMiddleware 是同一個模型）。能做什麼由**這個檔案註冊了哪些工具**
 * 決定 —— 這份清單就是白名單。**寫入**工具碰不到訂單、金流、發票、報名名單、人員權限、
 * 進銷存、付款與寄信設定、既有活動的票價／場次／票種修改。
 *
 * 2026-11-03 起多了一組**唯讀**的後台查詢（訂單、報名名單、策旅意願單、銷售、進銷存、推廣、
 * 合作邀約、首頁待辦，業主要在連接器裡直接問），實作在 ./admin-read-tools.ts，全部 READ_ONLY、
 * 沒有任何寫入參數；人員帳號與權限、付款與寄信設定仍然一支都沒有。
 *
 * 例外是「新增」：create_event／create_journey 會連同場次與票種一起建（走後台一頁新增
 * 同一支 src/server/event-quick-create.ts），create_shop_product 建一般商品但不寫庫存。
 * 三支的實作在 ./create-tools.ts。
 *
 * ── dry_run ───────────────────────────────────────────────────────────────
 * 每一支寫入工具預設 dry_run=true：回傳「改之前 → 改之後」的差異，不寫入。要真的寫，
 * 必須明確送 dry_run=false。刪除（只有最新消息）另外要 confirm=true。
 */
import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod4";
import {
  diffFields,
  errText,
  fillLocalized,
  imageKeyFromArg,
  jsonText,
  McpInputError,
  pickFields,
  productContentPatch,
  zodIssuesText,
  type LocalizedArg,
  type TextResult,
  type Translator,
} from "./core";
import {
  auditedInputSchema,
  CREATE_TOOL_INPUTS,
  CREATE_TOOL_META,
  runCreateEvent,
  runCreateShopProduct,
} from "./create-tools";
import { UPLOAD_TOOL_INPUTS } from "./image-upload";
import {
  ADMIN_READ_HANDLERS,
  ADMIN_READ_TOOL_INPUTS,
  ADMIN_READ_TOOL_META,
  type AdminReadToolName,
} from "./admin-read-tools";

/* ------------------------------------------------------------------ 共用 */

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

/** 新增：不是冪等的（同樣參數呼叫兩次會被「名稱重複」擋下，但語意上是建立）。 */
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

/** 三語欄位：一段中文，或 {zh, en?, ja?}。 */
function localizedArg(what: string) {
  return z
    .union([
      z.string().min(1).max(20000),
      z
        .object({
          zh: z.string().min(1).max(20000),
          en: z.string().max(60000).optional(),
          ja: z.string().max(60000).optional(),
        })
        .strict(),
    ])
    .describe(
      `${what}。三語欄位：可以只給中文字串（英日文會自動翻譯補上），或給 {"zh":…,"en":…,"ja":…}；只給其中一個語言時，缺的那個會自動翻譯。`,
    );
}

const dryRunArg = z
  .boolean()
  .default(true)
  .describe("預設 true：只回傳改前／改後差異，不寫入。確認後再以 false 呼叫一次才會真的寫入。");

const idArg = (what: string) => z.string().min(1).max(200).describe(what);

const imageArg = (what: string) =>
  z
    .string()
    .max(500)
    .nullable()
    .optional()
    .describe(
      `${what}：填上傳工具（upload_image_from_url／upload_image_base64／upload_image_file／finalize_image_upload）回傳的 key（storage:… 開頭）或這個站 site-images 的公開網址；null 代表清掉。`,
    );

/** 寫入工具的固定說明尾巴。 */
/** 三種上傳情境各用哪一支 —— 每一支上傳工具的說明都附上，模型不論先看到哪一支都選得對。 */
const UPLOAD_GUIDE =
  "\n【選哪一支上傳】有公開 https 網址 → upload_image_from_url；能執行 curl 指令 → create_image_upload_url＋finalize_image_upload；" +
  "ChatGPT 生成或使用者貼上的圖片 → upload_image_file；只能把圖轉成 base64 → upload_image_base64。" +
  "上傳只是存素材：還要再呼叫 update_event／create_event 等工具把回傳的 key 填進 image_key，圖片才會出現在頁面上。" +
  "\n[Which upload tool] Public https URL → upload_image_from_url. Can run curl → create_image_upload_url then finalize_image_upload. " +
  "Image generated in ChatGPT or attached in chat → upload_image_file. Can only send base64 → upload_image_base64. " +
  "Uploading only stores the asset; call update_event / create_event etc. with the returned key as image_key to show it on a page.";

/** 上傳工具共用的回傳形狀。 */
function uploadResult(
  stored: { key: string; url: string },
  summary: Record<string, unknown>,
  audit: "recorded" | "log_only",
) {
  return {
    written: true,
    key: stored.key,
    url: stored.url,
    ...summary,
    audit: audit === "recorded" ? "recorded" : "log_only（稽核表寫入失敗，紀錄只在伺服器 log）",
    next_step:
      "圖片已存進網站，但還沒出現在任何頁面。把 key 填進 update_event／create_event／create_journey／create_shop_product／update_shop_product／update_speaker 的 image_key（或 update_publication 的 cover_image_key）。",
  };
}

const WRITE_NOTE =
  "預設 dry_run=true，只回傳差異；確認後以 dry_run=false 再呼叫一次才會寫入。只送要改的欄位，沒送的欄位維持原值。";

/**
 * 有翻譯金鑰就回一個翻譯函式，沒有就回 null（fillLocalized 會叫呼叫端自己給 en/ja）。
 * 金鑰一律經 env.ts 讀（translate-selftest 守著「只有 env.ts 讀 GEMINI_API_KEY」）。
 */
async function translator(): Promise<Translator | null> {
  const { geminiApiKey } = await import("@/server/env");
  try {
    geminiApiKey();
  } catch {
    return null;
  }
  const { translateToEnJa } = await import("@/server/translate");
  return (zh: string) => translateToEnJa({ text: zh });
}

/**
 * 把 args 裡有出現的欄位套到 base 上。localized 的欄位補齊三語，其他欄位原樣。
 * 回傳套好的物件與「哪幾欄是自動翻譯補的」。
 */
async function applyPatch(
  base: Record<string, unknown>,
  args: Record<string, unknown>,
  spec: { localized?: readonly string[]; plain?: readonly string[] },
): Promise<{ next: Record<string, unknown>; translated: string[] }> {
  const next = { ...base };
  const translated: string[] = [];
  let t: Translator | null | undefined;
  for (const f of spec.localized ?? []) {
    if (args[f] === undefined) continue;
    if (t === undefined) t = await translator();
    const r = await fillLocalized(f, args[f] as LocalizedArg, t);
    next[f] = r.value;
    if (r.translated) translated.push(f);
  }
  for (const f of spec.plain ?? []) {
    if (args[f] !== undefined) next[f] = args[f];
  }
  return { next, translated };
}

/** zod3（後台 schema）驗證；錯誤轉成給模型看的一句話。 */
function validate<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } },
  value: unknown,
): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new McpInputError(
      `欄位驗證失敗（與後台同一套規則）：${zodIssuesText(r.error) ?? "格式不正確"}`,
    );
  }
  return r.data as T;
}

type WritePlan = {
  tool: string;
  entity: string;
  id: string;
  action: "create" | "update" | "delete";
  dryRun: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  fields: readonly string[];
  translated?: string[];
  extra?: Record<string, unknown>;
  commit: () => Promise<{ id: string; row: Record<string, unknown> | null }>;
};

/**
 * 所有寫入工具的共同收尾：算差異 → dry_run 就回差異 → 否則寫入、記稽核、回結果。
 */
async function runWrite(plan: WritePlan): Promise<TextResult> {
  const changes =
    plan.action === "delete"
      ? diffFields(plan.before, {}, plan.fields)
      : diffFields(plan.before, plan.after, plan.fields);
  const base = {
    entity: plan.entity,
    id: plan.id,
    action: plan.action,
    changes,
    auto_translated: plan.translated && plan.translated.length ? plan.translated : undefined,
    ...plan.extra,
  };

  if (Object.keys(changes).length === 0) {
    return jsonText({
      ...base,
      dry_run: plan.dryRun,
      written: false,
      message: "沒有任何欄位改變，不需要寫入。",
    });
  }

  if (plan.dryRun) {
    // 0054：預覽也記一筆（dry_run=true），業主要查得到「AI 打算改什麼」。
    const { writeMcpAudit } = await import("./audit");
    await writeMcpAudit({
      tool: plan.tool,
      entity: plan.entity,
      entity_id: plan.id,
      action: plan.action,
      changes,
      dry_run: true,
    });
    return jsonText({
      ...base,
      dry_run: true,
      written: false,
      next_step:
        "這只是預覽，還沒有寫入。確認差異無誤後，用同樣的參數加上 dry_run=false 再呼叫一次。" +
        (plan.translated && plan.translated.length
          ? "（英日文是自動翻譯的；若要保證寫入的譯文與這裡一字不差，請把上面 after 的 en/ja 一起帶進正式呼叫。）"
          : ""),
    });
  }

  const saved = await plan.commit();
  const { writeMcpAudit } = await import("./audit");
  const audit = await writeMcpAudit({
    tool: plan.tool,
    entity: plan.entity,
    entity_id: saved.id,
    action: plan.action,
    changes,
  });
  return jsonText({
    ...base,
    id: saved.id,
    dry_run: false,
    written: true,
    audit: audit === "recorded" ? "recorded" : "log_only（稽核表寫入失敗，紀錄只在伺服器 log）",
    saved: saved.row,
  });
}

/** 包住每一支 handler：輸入錯誤回 isError 文字，不回協定錯誤。 */
async function safe(fn: () => Promise<TextResult>): Promise<TextResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof McpInputError) return errText(err.message);
    const zodText = zodIssuesText(err);
    if (zodText) return errText(`欄位驗證失敗：${zodText}`);
    console.error("[mcp] tool error", err);
    return errText(`執行失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 唯讀連線（MCP_READONLY_TOKEN，或後台設成「唯讀」的 OAuth 連線）呼叫寫入工具 → 回錯誤文字並記
 * 一筆 action=denied 的稽核。沒有 actor（自檢直接呼叫）視為可寫入，與 http.ts 以外沒有入口一致。
 */
export async function denyIfReadOnly(tool: string): Promise<TextResult | null> {
  const { currentMcpActor } = await import("./actor");
  const actor = currentMcpActor();
  if (!actor || actor.access === "write") return null;
  const { writeMcpAudit } = await import("./audit");
  await writeMcpAudit({
    tool,
    entity: "mcp_access",
    entity_id: "-",
    action: "denied",
    changes: { reason: "read_only_connection" },
  });
  return errText(
    `這條連線是「唯讀」，不能使用寫入工具 ${tool}（預覽也不行）。` +
      "請管理員到後台 /admin/mcp-connections 把這條連線改成「可寫入」，最多 1 分鐘後生效。",
  );
}

function notFound(what: string, id: string): never {
  throw new McpInputError(`找不到${what}「${id}」。請先用對應的 list_* 工具查 id。`);
}

/* ------------------------------------------------------------------ 輸入 schema */

const NEWS_LOCALIZED = ["title", "summary", "description"] as const;
const NEWS_FIELDS = [...NEWS_LOCALIZED, "display_date", "is_published", "sort_order"] as const;

const EVENT_LOCALIZED = ["title", "summary", "description"] as const;
const EVENT_FIELDS = [
  ...EVENT_LOCALIZED,
  "display_date",
  "category",
  "speaker_id",
  "image_key",
  "status",
] as const;

const JOURNEY_LOCALIZED = ["title", "summary", "description", "days", "theme"] as const;
const JOURNEY_FIELDS = [...JOURNEY_LOCALIZED] as const;

/** 0052：活動／策旅的單一上架狀態。 */
const listingStatusArg = z
  .enum(["draft", "live", "archived"])
  .describe(
    "draft 草稿（網站上看不到）／live 上架（看得到；站內報名可報名，仍受場次時間與名額限制）／archived 下架（看不到，報名紀錄與訂單保留）",
  );

/** 0052：舊參數。帶了就拒絕，不讓它被 zod 安靜地丟掉、讓 AI 以為已經公開。 */
const retiredPublishedArg = z
  .boolean()
  .optional()
  .describe(
    "已停用：上架／下架請改用 set_event_status（status=live／archived／draft）。帶了會被拒絕。",
  );

const PRODUCT_LOCALIZED = ["title", "summary", "description"] as const;
const PRODUCT_FIELDS = [
  ...PRODUCT_LOCALIZED,
  "image_key",
  "price",
  "compare_at_price",
  "status",
] as const;

const PUBLICATION_LOCALIZED = ["title", "publisher", "intro"] as const;
const PUBLICATION_FIELDS = [
  ...PUBLICATION_LOCALIZED,
  "region",
  "issues",
  "external_url",
  "cover_image_key",
  "is_published",
] as const;

const SPEAKER_FIELDS = [
  "name",
  "name_en",
  "discipline",
  "bio",
  "long_bio",
  "image_key",
  "portal_url",
  "is_active",
] as const;

const COLLAB_LOCALIZED = ["title", "description"] as const;
const COLLAB_FIELDS = [...COLLAB_LOCALIZED, "is_published"] as const;

/** 只有這兩種商品開放 MCP 改價／上下架。活動、策旅的票價不開放。 */
const SHOP_PRODUCT_TYPES = ["goods", "book"] as const;

/**
 * 每一支工具的輸入 schema。匯出給 scripts/mcp-selftest.mjs 對帳 —— 那支測試會確認
 * 寫入工具全都有 dry_run、刪除有 confirm、沒有任何一支收 price 以外的金流欄位。
 */
export const TOOL_INPUTS = {
  /* 讀 */
  list_news: z.object({}),
  get_news: z.object({ id: idArg("news.id") }),
  list_events: z.object({}),
  get_event: z.object({ id: idArg("events.id（不是 slug）") }),
  list_journeys: z.object({}),
  get_journey: z.object({ id: idArg("journeys.id") }),
  list_shop_products: z.object({
    include_event_products: z
      .boolean()
      .optional()
      .describe("是否一併列出活動／策旅的票券商品（唯讀，預設 false）"),
  }),
  get_shop_product: z.object({ id: idArg("products.id") }),
  list_publications: z.object({}),
  get_publication: z.object({ id: idArg("publications.id") }),
  list_curated: z.object({}),
  list_speakers: z.object({}),
  get_speaker: z.object({ id: idArg("artists.id") }),
  list_collaborations: z.object({}),
  get_collaboration: z.object({ id: idArg("collaborations.id") }),
  list_pages: z.object({}),
  get_page: z.object({
    slug: z.string().min(1).max(100).describe("pages.slug，例如 index、about"),
  }),
  get_site_info: z.object({}),
  list_event_categories: z.object({}),

  /* 寫 */
  create_news: z.object({
    title: localizedArg("標題"),
    summary: localizedArg("摘要"),
    description: localizedArg("內文"),
    display_date: z.string().min(1).max(100).describe("顯示用日期文字，例如 2026.05.22–05.24"),
    is_published: z.boolean().default(false).describe("是否立刻公開，預設 false（草稿）"),
    sort_order: z
      .number()
      .int()
      .optional()
      .describe("排序（小的在前）；省略＝排在最後，與後台新增同一規則"),
    dry_run: dryRunArg,
  }),
  update_news: z.object({
    id: idArg("news.id"),
    title: localizedArg("標題").optional(),
    summary: localizedArg("摘要").optional(),
    description: localizedArg("內文").optional(),
    display_date: z.string().min(1).max(100).optional(),
    is_published: z.boolean().optional().describe("true 公開／false 隱藏"),
    sort_order: z.number().int().optional(),
    dry_run: dryRunArg,
  }),
  delete_news: z.object({
    id: idArg("news.id"),
    confirm: z.boolean().default(false).describe("真的要刪除時必須是 true（且 dry_run=false）"),
    dry_run: dryRunArg,
  }),
  update_event: z.object({
    id: idArg("events.id"),
    title: localizedArg("活動名稱").optional(),
    summary: localizedArg("摘要（也會同步成票券商品的說明）").optional(),
    description: localizedArg("活動介紹").optional(),
    display_date: z.string().min(1).max(100).optional().describe("顯示用日期文字"),
    category: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("event_categories.id，見 list_event_categories"),
    speaker_id: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe("artists.id，見 list_speakers；null＝不指定"),
    image_key: imageArg("封面圖"),
    status: listingStatusArg
      .optional()
      .describe(
        "上架狀態（選填）。與文案同一個交易寫入，票券商品與策旅卡片會一起跟著。只想改狀態請用 set_event_status。",
      ),
    is_published: retiredPublishedArg,
    dry_run: dryRunArg,
  }),
  update_journey: z.object({
    id: idArg("journeys.id"),
    title: localizedArg("策旅名稱").optional(),
    summary: localizedArg("摘要").optional(),
    description: localizedArg("介紹").optional(),
    days: localizedArg("天數文字，例如 3 天 2 夜").optional(),
    theme: localizedArg("主題關鍵字").optional(),
    is_published: retiredPublishedArg,
    dry_run: dryRunArg,
  }),
  set_event_status: z.object({
    id: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("活動的 events.id 或網址代稱（slug）。與 journey_id 二選一。"),
    journey_id: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "策旅卡片的 journeys.id（選填，與 id 二選一）。卡片連到某場活動時，等於改那場活動的狀態。",
      ),
    status: listingStatusArg,
    dry_run: dryRunArg,
  }),
  update_shop_product: z.object({
    id: idArg("products.id（只限選物 goods／書 book）"),
    title: localizedArg("商品名稱").optional(),
    summary: localizedArg("摘要").optional(),
    description: localizedArg("商品說明").optional(),
    image_key: imageArg("商品圖"),
    price: z.number().int().min(0).optional().describe("售價（新台幣整數）"),
    compare_at_price: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("原價（劃線價），null＝不顯示"),
    status: z
      .enum(["draft", "active", "archived"])
      .optional()
      .describe("active 上架／draft 草稿／archived 下架"),
    dry_run: dryRunArg,
  }),
  update_publication: z.object({
    id: idArg("publications.id"),
    title: localizedArg("刊物名稱").optional(),
    publisher: localizedArg("出版單位").optional(),
    intro: localizedArg("介紹").optional(),
    region: z.string().max(200).optional(),
    issues: z.string().max(500).nullable().optional(),
    external_url: z.string().max(1000).nullable().optional(),
    cover_image_key: imageArg("封面"),
    is_published: z.boolean().optional(),
    dry_run: dryRunArg,
  }),
  update_speaker: z.object({
    id: idArg("artists.id"),
    name: z.string().min(1).max(200).optional().describe("姓名（不分語言、不翻譯）"),
    name_en: z.string().max(200).nullable().optional(),
    discipline: z.string().max(200).nullable().optional().describe("領域／頭銜（不分語言）"),
    bio: z.string().max(2000).nullable().optional().describe("短介紹（不分語言）"),
    long_bio: z.string().max(20000).nullable().optional().describe("長介紹（不分語言）"),
    image_key: imageArg("照片"),
    portal_url: z.string().max(1000).nullable().optional(),
    is_active: z.boolean().optional().describe("false＝不再出現在講者清單與活動下拉"),
    dry_run: dryRunArg,
  }),
  update_collaboration: z.object({
    id: idArg("collaborations.id"),
    title: localizedArg("標題").optional(),
    description: localizedArg("說明").optional(),
    is_published: z.boolean().optional(),
    dry_run: dryRunArg,
  }),
  update_page_blocks: z.object({
    page_slug: z.string().min(1).max(100).describe("pages.slug，見 list_pages／get_page"),
    blocks: z
      .array(
        z.object({
          block_key: z
            .string()
            .min(1)
            .max(200)
            .describe("get_page 列出的 block_key（不能新增或刪除）"),
          value: localizedArg("這一塊的文案"),
        }),
      )
      .min(1)
      .max(50),
    dry_run: dryRunArg,
  }),
  upload_image_from_url: z.object({
    url: z.string().url().max(2000).describe("圖片的公開 https 網址（JPEG／PNG／WebP，2MB 以內）"),
    dry_run: dryRunArg,
  }),

  /* 新增（./create-tools.ts） */
  ...CREATE_TOOL_INPUTS,

  /* 直接上傳圖片（./image-upload.ts）。只上傳素材、不改任何頁面，所以沒有 dry_run。 */
  ...UPLOAD_TOOL_INPUTS,

  /* 後台資料唯讀查詢（./admin-read-tools.ts）。 */
  ...ADMIN_READ_TOOL_INPUTS,
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;

/** 寫入工具的名單（自檢用）。 */
export const WRITE_TOOLS: readonly ToolName[] = [
  "create_news",
  "update_news",
  "delete_news",
  "update_event",
  "update_journey",
  "set_event_status",
  "update_shop_product",
  "update_publication",
  "update_speaker",
  "update_collaboration",
  "update_page_blocks",
  "upload_image_from_url",
  "create_event",
  "create_journey",
  "create_shop_product",
];

/**
 * 直接上傳圖片的工具（./image-upload.ts）。會寫進 storage、記稽核，但**不改任何頁面**，
 * 所以刻意不在 WRITE_TOOLS（那份清單的規矩是「預設 dry_run=true」）。
 */
export const UPLOAD_TOOLS: readonly ToolName[] = [
  "create_image_upload_url",
  "finalize_image_upload",
  "upload_image_base64",
  "upload_image_file",
];

/**
 * 後台資料唯讀查詢（./admin-read-tools.ts）。訂單、名單、銷售、進銷存等「排除領域」只准出現在
 * 這份清單裡，而且全部 READ_ONLY —— scripts/mcp-selftest.mjs 守著這兩件事。
 */
export const ADMIN_READ_TOOLS = Object.keys(ADMIN_READ_TOOL_INPUTS) as readonly AdminReadToolName[];

type Args<N extends ToolName> = z.output<(typeof TOOL_INPUTS)[N]>;

/* ------------------------------------------------------------------ 註冊 */

export function registerContentTools(server: McpServer): void {
  function add<N extends ToolName>(
    name: N,
    meta: {
      title: string;
      description: string;
      annotations: ToolAnnotations;
      /** 只有新增工具用：同一支 schema 包成「驗證失敗也交給 handler 記稽核」。 */
      auditInvalid?: boolean;
      /** tools/list 的 _meta（upload_image_file 用 openai/fileParams）。 */
      _meta?: Record<string, unknown>;
    },
    fn: (args: Args<N>) => Promise<TextResult>,
  ) {
    server.registerTool(
      name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: meta.auditInvalid ? auditedInputSchema(TOOL_INPUTS[name]) : TOOL_INPUTS[name],
        ...(meta._meta ? { _meta: meta._meta } : {}),
      },
      // SDK 已經用同一支 schema 驗過並套上預設值；這裡的轉型只是把型別接回來。
      (async (args: unknown) => {
        // 0054 讀寫分級：不是 readOnlyHint 的工具，唯讀連線一律拒絕（含 dry_run 預覽）。
        if (meta.annotations.readOnlyHint !== true) {
          const denied = await denyIfReadOnly(name);
          if (denied) return denied;
        }
        return safe(() => fn(args as Args<N>));
      }) as never,
    );
  }

  /* ============================================================ 最新消息 */

  add(
    "list_news",
    {
      title: "最新消息列表",
      description: "列出所有最新消息（含未公開），依排序。",
      annotations: READ_ONLY,
    },
    async () => {
      const { listNews } = await import("@/server/repos/news");
      const rows = await listNews();
      return jsonText({
        count: rows.length,
        news: rows.map((r) => ({
          id: r.id,
          title: r.title.zh,
          display_date: r.display_date,
          is_published: r.is_published,
          sort_order: r.sort_order,
          updated_at: r.updated_at,
        })),
      });
    },
  );

  add(
    "get_news",
    {
      title: "單則最新消息",
      description: "用 id 取一則最新消息的完整三語內容。",
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const { getNewsById } = await import("@/server/repos/news");
      const row = await getNewsById(id);
      if (!row) notFound("最新消息", id);
      return jsonText(row);
    },
  );

  add(
    "create_news",
    {
      title: "新增最新消息",
      description: `新增一則最新消息（預設不公開）。${WRITE_NOTE}`,
      annotations: WRITE,
    },
    async (args) => {
      const [{ listNews, upsertNews }, { newsSchema }] = await Promise.all([
        import("@/server/repos/news"),
        import("@/lib/admin/schemas"),
      ]);
      const sortOrder =
        args.sort_order ??
        (await listNews()).reduce((max, n) => Math.max(max, n.sort_order), 0) + 1;
      const { next, translated } = await applyPatch(
        { display_date: args.display_date, is_published: args.is_published, sort_order: sortOrder },
        args,
        { localized: NEWS_LOCALIZED },
      );
      const valid = validate<import("@/server/repos/news").NewsUpsertInput>(newsSchema, next);
      return runWrite({
        tool: "create_news",
        entity: "news",
        id: "(寫入時產生)",
        action: "create",
        dryRun: args.dry_run !== false,
        before: null,
        after: valid,
        fields: NEWS_FIELDS,
        translated,
        commit: async () => {
          const row = await upsertNews(valid);
          return { id: row.id, row };
        },
      });
    },
  );

  add(
    "update_news",
    {
      title: "修改最新消息",
      description: `修改一則最新消息的內容或公開狀態。${WRITE_NOTE}`,
      annotations: WRITE,
    },
    async (args) => {
      const [{ getNewsById, upsertNews }, { newsSchema }] = await Promise.all([
        import("@/server/repos/news"),
        import("@/lib/admin/schemas"),
      ]);
      const row = await getNewsById(args.id);
      if (!row) notFound("最新消息", args.id);
      const before = pickFields(row, ["id", ...NEWS_FIELDS]);
      const { next, translated } = await applyPatch(before, args, {
        localized: NEWS_LOCALIZED,
        plain: ["display_date", "is_published", "sort_order"],
      });
      const valid = validate<import("@/server/repos/news").NewsUpsertInput>(newsSchema, next);
      return runWrite({
        tool: "update_news",
        entity: "news",
        id: row.id,
        action: "update",
        dryRun: args.dry_run !== false,
        before,
        after: valid,
        fields: NEWS_FIELDS,
        translated,
        commit: async () => {
          const saved = await upsertNews({ ...valid, id: row.id });
          return { id: saved.id, row: saved };
        },
      });
    },
  );

  add(
    "delete_news",
    {
      title: "刪除最新消息",
      description:
        "永久刪除一則最新消息（資料表沒有軟刪除，刪了就沒有了；只想先藏起來請用 update_news 把 is_published 設成 false）。" +
        "dry_run=true 先看會刪掉什麼；真的刪除要 dry_run=false 且 confirm=true。",
      annotations: DESTRUCTIVE,
    },
    async (args) => {
      const { getNewsById, removeNews } = await import("@/server/repos/news");
      const row = await getNewsById(args.id);
      if (!row) notFound("最新消息", args.id);
      const dryRun = args.dry_run !== false;
      if (!dryRun && args.confirm !== true) {
        throw new McpInputError(
          "刪除需要 confirm=true。這個動作無法復原；只想隱藏請改用 update_news 設 is_published=false。",
        );
      }
      const before = pickFields(row, ["id", ...NEWS_FIELDS]);
      return runWrite({
        tool: "delete_news",
        entity: "news",
        id: row.id,
        action: "delete",
        dryRun,
        before,
        after: {},
        fields: NEWS_FIELDS,
        extra: { warning: "刪除無法復原" },
        commit: async () => {
          await removeNews(row.id);
          return { id: row.id, row: null };
        },
      });
    },
  );

  /* ============================================================ 活動 */

  add(
    "list_events",
    {
      title: "活動列表",
      description:
        "列出所有活動（含草稿與下架）。status 是唯一的上架狀態（draft 草稿／live 上架／archived 下架）；" +
        "booking 是上架中的活動依時間與名額推導的報名狀況（報名中／額滿／報名截止／已結束）。票券商品的狀態跟著活動走（唯讀）。",
      annotations: READ_ONLY,
    },
    async () => {
      const { listEvents, listEventProducts } = await import("@/server/repos/events");
      const { bookingPhase, BOOKING_PHASE_LABEL, LISTING_STATUS_LABEL } =
        await import("@/lib/listing-status");
      const [rows, products] = await Promise.all([listEvents(), listEventProducts()]);
      return jsonText({
        count: rows.length,
        events: rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          url: `/events/${r.slug}`,
          title: r.title.zh,
          display_date: r.display_date,
          category: r.category,
          speaker_id: r.speaker_id,
          status: r.status,
          status_label: LISTING_STATUS_LABEL[r.status],
          booking:
            r.status === "live"
              ? BOOKING_PHASE_LABEL[
                  bookingPhase({
                    registrationType: r.registration_type,
                    isoDate: r.iso_date,
                    sessions: products[r.id]?.sessions ?? [],
                  })
                ]
              : undefined,
          sort_order: r.sort_order,
          ticket_product: products[r.id]
            ? {
                status: products[r.id].status,
                price: products[r.id].price,
                session_count: products[r.id].session_count,
              }
            : null,
        })),
      });
    },
  );

  add(
    "get_event",
    {
      title: "單一活動",
      description:
        "用 id 取一場活動的完整內容，加上票券商品、場次與票種的**唯讀**摘要（場次／票種／票價不能用 MCP 修改）。",
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const { getEventById, listEventProducts, listSessionsForEvent } =
        await import("@/server/repos/events");
      const { listEventSessionPlans } = await import("@/server/repos/event-sessions");
      const row = await getEventById(id);
      if (!row) notFound("活動", id);
      const [products, sessions, plans] = await Promise.all([
        listEventProducts(),
        listSessionsForEvent(id),
        listEventSessionPlans(),
      ]);
      const sessionIds = new Set(sessions.map((s) => s.id));
      const { sessions: _bookingSessions, ...ticket } = products[id] ?? { sessions: undefined };
      return jsonText({
        event: row,
        read_only: {
          note: "以下只供參考；票價、場次、票種、名額請在後台修改。上架狀態用 set_event_status 改。",
          ticket_product: products[id] ? ticket : null,
          sessions,
          plans: plans
            .filter((p) => sessionIds.has(p.session_id))
            .map((p) => ({
              id: p.id,
              session_id: p.session_id,
              title: p.title,
              price: p.price,
              capacity: p.capacity,
              units_taken: p.units_taken,
              status: p.status,
            })),
        },
      });
    },
  );

  add(
    "update_event",
    {
      title: "修改活動內容",
      description:
        "修改活動的文案（名稱、摘要、介紹）、封面、分類、講者、顯示日期，也可以順便改上架狀態 status。" +
        "走後台同一支 admin_upsert_event_with_session（一個交易）：名稱／摘要／封面會同步到票券商品；帶 status 時票券商品與策旅卡片的上下架一起跟著，票價不會被動到。" +
        `不能改代稱、報名方式、票價、場次。只想上架／下架請用 set_event_status。${WRITE_NOTE}`,
      annotations: WRITE,
    },
    async (args) => {
      const [{ getEventById, upsertEventWithProduct }, { eventSchema }] = await Promise.all([
        import("@/server/repos/events"),
        import("@/lib/admin/schemas"),
      ]);
      if (args.is_published !== undefined) {
        throw new McpInputError(
          "is_published 已停用：活動改成單一上架狀態。請改用 set_event_status（status=live 上架／archived 下架／draft 草稿），或在 update_event 帶 status。",
        );
      }
      const row = await getEventById(args.id);
      if (!row) notFound("活動", args.id);

      if (args.category !== undefined) {
        const { listEventCategories } = await import("@/server/repos/event-categories");
        const cats = await listEventCategories();
        if (!cats.some((c) => c.id === args.category)) {
          throw new McpInputError(
            `沒有「${args.category}」這個分類。可用：${cats.map((c) => c.id).join("、")}`,
          );
        }
      }
      if (args.speaker_id) {
        const { getArtistById } = await import("@/server/repos/artists");
        if (!(await getArtistById(args.speaker_id))) notFound("講者", args.speaker_id);
      }

      const patch: Record<string, unknown> = { ...args };
      if (args.image_key !== undefined)
        patch.image_key = imageKeyFromArg(args.image_key, [row.image_key]);

      const { next, translated } = await applyPatch(
        row as unknown as Record<string, unknown>,
        patch,
        {
          localized: EVENT_LOCALIZED,
          plain: ["display_date", "category", "speaker_id", "image_key", "status"],
        },
      );
      const valid = validate<import("@/lib/admin/schemas").EventFormValues>(eventSchema, next);
      const before = pickFields(row as unknown as Record<string, unknown>, EVENT_FIELDS);
      return runWrite({
        tool: "update_event",
        entity: "event",
        id: row.id,
        action: "update",
        dryRun: args.dry_run !== false,
        before,
        after: valid as unknown as Record<string, unknown>,
        fields: EVENT_FIELDS,
        translated,
        commit: async () => {
          // product: null ＝這一次不動商品的價格；lists: {} ＝七個清單欄位不動。
          // status 有改才送（0052：省略＝不動），票券商品與策旅卡片由 trigger 在同一個交易跟著。
          const { status, ...rest } = valid;
          const saved = await upsertEventWithProduct(
            {
              ...rest,
              id: row.id,
              lists: {},
              ...(args.status !== undefined ? { status } : {}),
            },
            null,
          );
          return {
            id: saved.event.id,
            row: pickFields(saved.event as unknown as Record<string, unknown>, [
              "id",
              "slug",
              ...EVENT_FIELDS,
            ]),
          };
        },
      });
    },
  );

  /* ============================================================ 策旅 */

  add(
    "list_journeys",
    {
      title: "策旅列表",
      description:
        "列出所有策旅卡片（含草稿與下架）。linked_event_id 是這張卡片跟著的那場活動：卡片的上下架跟著活動走，" +
        "要上架／下架用 set_event_status（帶 id=linked_event_id 或 journey_id）。",
      annotations: READ_ONLY,
    },
    async () => {
      const { listJourneys } = await import("@/server/repos/journeys");
      const { listEvents } = await import("@/server/repos/events");
      const { linkedEventIdFor } = await import("@/lib/journey-events");
      const { LISTING_STATUS_LABEL } = await import("@/lib/listing-status");
      const [rows, events] = await Promise.all([listJourneys(), listEvents()]);
      return jsonText({
        count: rows.length,
        journeys: rows.map((r) => ({
          id: r.id,
          title: r.title.zh,
          days: r.days.zh,
          status: r.status,
          status_label: LISTING_STATUS_LABEL[r.status],
          linked_event_id: linkedEventIdFor(r.external_url, events),
          sort_order: r.sort_order,
        })),
      });
    },
  );

  add(
    "get_journey",
    {
      title: "單一策旅",
      description: "用 id 取一個策旅的完整內容，加上票券商品的唯讀摘要。",
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const { getJourneyById } = await import("@/server/repos/journeys");
      const { listProducts } = await import("@/server/repos/products");
      const row = await getJourneyById(id);
      if (!row) notFound("策旅", id);
      const product = (await listProducts()).find(
        (p) => p.source_type === "journey" && p.source_id === id,
      );
      return jsonText({
        journey: row,
        read_only: {
          note: "票價、場次、票種請在後台修改。",
          ticket_product: product
            ? { id: product.id, status: product.status, price: product.price }
            : null,
        },
      });
    },
  );

  add(
    "update_journey",
    {
      title: "修改策旅內容",
      description: `修改策旅卡片的文案。不能改報名方式與票價；上架／下架請用 set_event_status（卡片跟著活動走）。${WRITE_NOTE}`,
      annotations: WRITE,
    },
    async (args) => {
      const [{ getJourneyById, upsertJourney }, { journeySchema }] = await Promise.all([
        import("@/server/repos/journeys"),
        import("@/lib/admin/schemas"),
      ]);
      if (args.is_published !== undefined) {
        throw new McpInputError(
          "is_published 已停用：策旅卡片的上下架跟著活動走。請改用 set_event_status（journey_id=這張卡片，status=live／archived／draft）。",
        );
      }
      const row = await getJourneyById(args.id);
      if (!row) notFound("策旅", args.id);
      const { is_published: _retired, ...patchArgs } = args;
      const { next, translated } = await applyPatch(
        row as unknown as Record<string, unknown>,
        patchArgs,
        {
          localized: JOURNEY_LOCALIZED,
          plain: [],
        },
      );
      const valid = validate<import("@/server/repos/journeys").JourneyUpsertInput>(
        journeySchema,
        next,
      );
      return runWrite({
        tool: "update_journey",
        entity: "journey",
        id: row.id,
        action: "update",
        dryRun: args.dry_run !== false,
        before: pickFields(row as unknown as Record<string, unknown>, JOURNEY_FIELDS),
        after: valid as unknown as Record<string, unknown>,
        fields: JOURNEY_FIELDS,
        translated,
        commit: async () => {
          const saved = await upsertJourney({ ...valid, id: row.id });
          return {
            id: saved.id,
            row: pickFields(saved as unknown as Record<string, unknown>, ["id", ...JOURNEY_FIELDS]),
          };
        },
      });
    },
  );

  add(
    "set_event_status",
    {
      title: "活動／策旅上架、下架",
      description:
        "把一場活動（或策旅）切到 draft 草稿／live 上架／archived 下架，一句話完成。" +
        "這是活動與策旅唯一的上架狀態：活動頁、票券商品（能不能結帳）、策旅卡片在同一個資料庫交易裡一起切換，不會出現「看得到卻不能報名」。" +
        "live＝前台看得到，站內報名的活動可以報名（仍受場次時間與名額限制）；draft＝前台看不到；archived＝前台看不到（舊網址 404），報名紀錄與訂單都保留。" +
        "用 id（events.id 或網址代稱）指定活動，或用 journey_id 指定策旅卡片（會改它連到的那場活動）。場次各自的開放／關閉不受影響。" +
        WRITE_NOTE,
      annotations: WRITE,
    },
    async (args) => {
      if (Boolean(args.id) === Boolean(args.journey_id)) {
        throw new McpInputError("id（活動）與 journey_id（策旅卡片）要剛好給一個。");
      }
      const { listEvents, getEventListingSnapshot, setEventStatus } =
        await import("@/server/repos/events");
      const { getJourneyById, setJourneyStatus } = await import("@/server/repos/journeys");
      const { linkedEventIdFor } = await import("@/lib/journey-events");
      const { LISTING_STATUS_LABEL, listingToProductStatus } = await import("@/lib/listing-status");
      const dryRun = args.dry_run !== false;
      const events = await listEvents();

      let eventId: string | null = null;
      if (args.id) {
        const ev = events.find((e) => e.id === args.id) ?? events.find((e) => e.slug === args.id);
        if (!ev) notFound("活動", args.id);
        eventId = ev.id;
      } else {
        const card = await getJourneyById(args.journey_id as string);
        if (!card) notFound("策旅", args.journey_id as string);
        eventId = linkedEventIdFor(card.external_url, events);
        if (!eventId) {
          // 孤兒卡片（沒有連到任何活動）：只改卡片本身。
          return runWrite({
            tool: "set_event_status",
            entity: "journey",
            id: card.id,
            action: "update",
            dryRun,
            before: { status: card.status, is_published: card.is_published },
            after: { status: args.status, is_published: args.status === "live" },
            fields: ["status", "is_published"],
            extra: {
              title: card.title.zh,
              note: "這張策旅卡片沒有連到任何活動，只改卡片本身。",
              status_label: {
                before: LISTING_STATUS_LABEL[card.status],
                after: LISTING_STATUS_LABEL[args.status],
              },
            },
            commit: async () => {
              const r = await setJourneyStatus(card.id, args.status);
              return { id: card.id, row: r as unknown as Record<string, unknown> };
            },
          });
        }
      }

      const ev = events.find((e) => e.id === eventId)!;
      const snap = await getEventListingSnapshot(ev.id);
      if (!snap) notFound("活動", ev.id);
      const shape = (s: {
        status: string;
        is_published: boolean;
        product: { status: string } | null;
        journeys: { id: string; status: string; is_published: boolean }[];
      }) => ({
        status: s.status,
        is_published: s.is_published,
        ticket_product_status: s.product ? s.product.status : null,
        journey_cards: s.journeys.map((j) => ({
          id: j.id,
          status: j.status,
          is_published: j.is_published,
        })),
      });
      const before = shape(snap);
      const after = shape({
        status: args.status,
        is_published: args.status === "live",
        product: snap.product ? { status: listingToProductStatus(args.status) } : null,
        journeys: snap.journeys.map((j) => ({
          id: j.id,
          status: args.status,
          is_published: args.status === "live",
        })),
      });
      const warnings: string[] = [];
      if (args.status === "live" && ev.registration_type === "internal" && !snap.product) {
        warnings.push(
          "這場是站內報名但還沒有票券商品，上架後看得到、但還不能報名；請到後台活動頁開啟販售並排場次。",
        );
      }
      if (args.status !== "live" && snap.status === "live") {
        warnings.push(
          "切離上架後客人就看不到這一頁、也不能再下單；已經成立的訂單與報名紀錄都保留。",
        );
      }
      return runWrite({
        tool: "set_event_status",
        entity: "event",
        id: ev.id,
        action: "update",
        dryRun,
        before,
        after,
        fields: ["status", "is_published", "ticket_product_status", "journey_cards"],
        extra: {
          title: ev.title.zh,
          slug: ev.slug,
          url: `/events/${ev.slug}`,
          status_label: {
            before: LISTING_STATUS_LABEL[snap.status],
            after: LISTING_STATUS_LABEL[args.status],
          },
          warnings: warnings.length ? warnings : undefined,
        },
        commit: async () => {
          const res = await setEventStatus(ev.id, args.status);
          // 已經 commit 了，不丟例外（否則稽核會記成失敗、狀態卻已經改了）；trigger 的設計下
          // consistent 恆為 true，真的出現就在結果裡講出來。
          return {
            id: ev.id,
            row: {
              ...shape(res),
              ...(res.consistent
                ? {}
                : { warning: "寫入後檢查發現活動／商品／卡片狀態不一致，請回報管理員" }),
            },
          };
        },
      });
    },
  );

  /* ============================================================ 商品 */

  add(
    "list_shop_products",
    {
      title: "選物／書籍商品列表",
      description: "列出選物（goods）與書（book）商品，含價格與上下架狀態。",
      annotations: READ_ONLY,
    },
    async ({ include_event_products }) => {
      const { listProducts } = await import("@/server/repos/products");
      const rows = (await listProducts()).filter(
        (p) =>
          include_event_products ||
          (SHOP_PRODUCT_TYPES as readonly string[]).includes(p.product_type),
      );
      return jsonText({
        count: rows.length,
        products: rows.map((p) => ({
          id: p.id,
          slug: p.slug,
          product_type: p.product_type,
          title: p.title.zh,
          price: p.price,
          compare_at_price: p.compare_at_price,
          status: p.status,
          image_key: p.image_key,
          editable_via_mcp: (SHOP_PRODUCT_TYPES as readonly string[]).includes(p.product_type),
        })),
      });
    },
  );

  add(
    "get_shop_product",
    { title: "單一商品", description: "用 id 取一件商品的完整內容。", annotations: READ_ONLY },
    async ({ id }) => {
      const { getProductById } = await import("@/server/repos/products");
      const row = await getProductById(id);
      if (!row) notFound("商品", id);
      return jsonText(row);
    },
  );

  add(
    "update_shop_product",
    {
      title: "修改選物／書籍商品",
      description:
        "修改選物（goods）或書（book）的名稱、說明、圖片、售價、原價與上架（active）／草稿（draft）／下架（archived）。" +
        `活動與策旅的票券商品不開放（票價請在後台改）；庫存不開放。改價時結果會列出舊價→新價。${WRITE_NOTE}`,
      annotations: WRITE,
    },
    async (args) => {
      const [{ getProductById, updateProductContent }, { productSchema }] = await Promise.all([
        import("@/server/repos/products"),
        import("@/lib/admin/schemas"),
      ]);
      const row = await getProductById(args.id);
      if (!row) notFound("商品", args.id);
      if (!(SHOP_PRODUCT_TYPES as readonly string[]).includes(row.product_type)) {
        throw new McpInputError(
          `這件是「${row.product_type}」票券商品，MCP 不開放修改（票價與上下架請到後台；活動文案請用 update_event）。`,
        );
      }
      const patch: Record<string, unknown> = { ...args };
      if (args.image_key !== undefined)
        patch.image_key = imageKeyFromArg(args.image_key, [row.image_key]);
      const { next, translated } = await applyPatch(
        row as unknown as Record<string, unknown>,
        patch,
        {
          localized: PRODUCT_LOCALIZED,
          plain: ["image_key", "price", "compare_at_price", "status"],
        },
      );
      const valid = validate<import("@/server/repos/products").ProductUpsertInput>(
        productSchema,
        next,
      );
      const priceChange =
        valid.price !== row.price ||
        (valid.compare_at_price ?? null) !== (row.compare_at_price ?? null)
          ? {
              price: { old: row.price, new: valid.price },
              compare_at_price: { old: row.compare_at_price, new: valid.compare_at_price ?? null },
            }
          : null;
      return runWrite({
        tool: "update_shop_product",
        entity: "product",
        id: row.id,
        action: "update",
        dryRun: args.dry_run !== false,
        before: pickFields(row as unknown as Record<string, unknown>, PRODUCT_FIELDS),
        after: valid as unknown as Record<string, unknown>,
        fields: PRODUCT_FIELDS,
        translated,
        extra: priceChange ? { price_change: priceChange } : undefined,
        commit: async () => {
          // 只送門面七欄（.update()），庫存／代稱／類型／來源不碰 —— 見 repo 的註解。
          const saved = await updateProductContent(
            row.id,
            productContentPatch(
              valid as unknown as Record<string, unknown>,
            ) as unknown as import("@/server/repos/products").ProductContentPatch,
          );
          return {
            id: saved.id,
            row: pickFields(saved as unknown as Record<string, unknown>, [
              "id",
              "slug",
              ...PRODUCT_FIELDS,
            ]),
          };
        },
      });
    },
  );

  /* ============================================================ 刊物 */

  add(
    "list_publications",
    { title: "地方刊物列表", description: "列出地方刊物（含未公開）。", annotations: READ_ONLY },
    async () => {
      const { listPublications } = await import("@/server/repos/publications");
      const rows = await listPublications();
      return jsonText({
        count: rows.length,
        publications: rows.map((p) => ({
          id: p.id,
          slug: p.slug,
          sheet: p.sheet,
          title: p.title.zh,
          region: p.region,
          is_published: p.is_published,
          has_product: Boolean(p.product_id),
        })),
      });
    },
  );

  add(
    "get_publication",
    { title: "單一刊物", description: "用 id 取一本刊物的完整內容。", annotations: READ_ONLY },
    async ({ id }) => {
      const { getPublicationById } = await import("@/server/repos/publications");
      const row = await getPublicationById(id);
      if (!row) notFound("刊物", id);
      return jsonText(row);
    },
  );

  add(
    "update_publication",
    {
      title: "修改地方刊物",
      description: `修改刊物的名稱、出版單位、介紹、地區、期數、外部連結、封面與公開狀態。與進銷存的連結與售價不開放。${WRITE_NOTE}`,
      annotations: WRITE,
    },
    async (args) => {
      const [{ getPublicationById, updatePublication }, { publicationSchema }] = await Promise.all([
        import("@/server/repos/publications"),
        import("@/lib/admin/schemas"),
      ]);
      const row = await getPublicationById(args.id);
      if (!row) notFound("刊物", args.id);
      const patch: Record<string, unknown> = { ...args };
      if (args.cover_image_key !== undefined) {
        patch.cover_image_key = imageKeyFromArg(args.cover_image_key, [row.cover_image_key]);
      }
      const { next, translated } = await applyPatch(
        row as unknown as Record<string, unknown>,
        patch,
        {
          localized: PUBLICATION_LOCALIZED,
          plain: ["region", "issues", "external_url", "cover_image_key", "is_published"],
        },
      );
      const valid = validate<import("@/server/repos/publications").PublicationUpdateInput>(
        publicationSchema,
        next,
      );
      return runWrite({
        tool: "update_publication",
        entity: "publication",
        id: row.id,
        action: "update",
        dryRun: args.dry_run !== false,
        before: pickFields(row as unknown as Record<string, unknown>, PUBLICATION_FIELDS),
        after: valid as unknown as Record<string, unknown>,
        fields: PUBLICATION_FIELDS,
        translated,
        commit: async () => {
          const saved = await updatePublication({ ...valid, id: row.id });
          return {
            id: saved.id,
            row: pickFields(saved as unknown as Record<string, unknown>, [
              "id",
              ...PUBLICATION_FIELDS,
            ]),
          };
        },
      });
    },
  );

  /* ============================================================ 選品（唯讀） */

  add(
    "list_curated",
    {
      title: "選品主題與品項",
      description: "列出選品主題與每個主題底下的品項（唯讀）。",
      annotations: READ_ONLY,
    },
    async () => {
      const { listCuratedThemes, listCuratedItemsByTheme } = await import("@/server/repos/curated");
      const themes = await listCuratedThemes();
      const items = await Promise.all(themes.map((t) => listCuratedItemsByTheme(t.id)));
      return jsonText({ themes: themes.map((t, i) => ({ ...t, items: items[i] })) });
    },
  );

  /* ============================================================ 講者 */

  /** vendor_id 是指到 inv.vendors 的會計面綁定，不是門面資料 —— 不輸出。 */
  function speakerPublic(row: Record<string, unknown>) {
    const { vendor_id: _vendor, ...rest } = row;
    void _vendor;
    return rest;
  }

  add(
    "list_speakers",
    { title: "講者列表", description: "列出所有講者。", annotations: READ_ONLY },
    async () => {
      const { listArtists } = await import("@/server/repos/artists");
      const rows = await listArtists();
      return jsonText({
        count: rows.length,
        speakers: rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          name_en: r.name_en,
          discipline: r.discipline,
          is_active: r.is_active,
          image_key: r.image_key,
        })),
      });
    },
  );

  add(
    "get_speaker",
    { title: "單一講者", description: "用 id 取一位講者的完整資料。", annotations: READ_ONLY },
    async ({ id }) => {
      const { getArtistById } = await import("@/server/repos/artists");
      const row = await getArtistById(id);
      if (!row) notFound("講者", id);
      return jsonText(speakerPublic(row as unknown as Record<string, unknown>));
    },
  );

  add(
    "update_speaker",
    {
      title: "修改講者",
      description:
        "修改講者的姓名、領域、介紹、照片、個人網站與是否啟用。注意：講者的欄位**不分語言**（三種語系顯示同一份），不會自動翻譯。" +
        WRITE_NOTE,
      annotations: WRITE,
    },
    async (args) => {
      const [{ getArtistById, upsertArtist }, { artistSchema }] = await Promise.all([
        import("@/server/repos/artists"),
        import("@/lib/admin/schemas"),
      ]);
      const row = await getArtistById(args.id);
      if (!row) notFound("講者", args.id);
      const patch: Record<string, unknown> = { ...args };
      if (args.image_key !== undefined)
        patch.image_key = imageKeyFromArg(args.image_key, [row.image_key]);
      const base = speakerPublic(row as unknown as Record<string, unknown>);
      const { next } = await applyPatch(base, patch, { plain: SPEAKER_FIELDS });
      const valid = validate<import("@/server/repos/artists").ArtistUpsertInput>(
        artistSchema,
        next,
      );
      return runWrite({
        tool: "update_speaker",
        entity: "speaker",
        id: row.id,
        action: "update",
        dryRun: args.dry_run !== false,
        before: pickFields(base, SPEAKER_FIELDS),
        after: valid as unknown as Record<string, unknown>,
        fields: SPEAKER_FIELDS,
        commit: async () => {
          const saved = await upsertArtist({ ...valid, id: row.id });
          return { id: saved.id, row: speakerPublic(saved as unknown as Record<string, unknown>) };
        },
      });
    },
  );

  /* ============================================================ 合作 */

  add(
    "list_collaborations",
    { title: "合作列表", description: "列出所有合作項目（含未公開）。", annotations: READ_ONLY },
    async () => {
      const { listCollaborations } = await import("@/server/repos/collaborations");
      const rows = await listCollaborations();
      return jsonText({
        count: rows.length,
        collaborations: rows.map((r) => ({
          id: r.id,
          title: r.title.zh,
          is_published: r.is_published,
          sort_order: r.sort_order,
        })),
      });
    },
  );

  add(
    "get_collaboration",
    { title: "單一合作", description: "用 id 取一個合作項目的完整內容。", annotations: READ_ONLY },
    async ({ id }) => {
      const { getCollaborationById } = await import("@/server/repos/collaborations");
      const row = await getCollaborationById(id);
      if (!row) notFound("合作", id);
      return jsonText(row);
    },
  );

  add(
    "update_collaboration",
    {
      title: "修改合作",
      description: `修改合作項目的標題、說明與公開狀態。${WRITE_NOTE}`,
      annotations: WRITE,
    },
    async (args) => {
      const [{ getCollaborationById, upsertCollaboration }, { collaborationSchema }] =
        await Promise.all([import("@/server/repos/collaborations"), import("@/lib/admin/schemas")]);
      const row = await getCollaborationById(args.id);
      if (!row) notFound("合作", args.id);
      const { next, translated } = await applyPatch(
        row as unknown as Record<string, unknown>,
        args,
        {
          localized: COLLAB_LOCALIZED,
          plain: ["is_published"],
        },
      );
      const valid = validate<import("@/server/repos/collaborations").CollaborationUpsertInput>(
        collaborationSchema,
        next,
      );
      return runWrite({
        tool: "update_collaboration",
        entity: "collaboration",
        id: row.id,
        action: "update",
        dryRun: args.dry_run !== false,
        before: pickFields(row as unknown as Record<string, unknown>, COLLAB_FIELDS),
        after: valid as unknown as Record<string, unknown>,
        fields: COLLAB_FIELDS,
        translated,
        commit: async () => {
          const saved = await upsertCollaboration({ ...valid, id: row.id });
          return {
            id: saved.id,
            row: pickFields(saved as unknown as Record<string, unknown>, ["id", ...COLLAB_FIELDS]),
          };
        },
      });
    },
  );

  /* ============================================================ 頁面文案 */

  add(
    "list_pages",
    {
      title: "頁面列表",
      description: "列出網站各頁（slug、標題）。頁面文案用 get_page 看、update_page_blocks 改。",
      annotations: READ_ONLY,
    },
    async () => {
      const { listPages } = await import("@/server/repos/pages");
      const rows = await listPages();
      return jsonText({
        pages: rows.map((p) => ({
          slug: p.slug,
          meta_title: p.meta_title.zh,
          header_title: p.header_title?.zh ?? null,
        })),
      });
    },
  );

  add(
    "get_page",
    {
      title: "單一頁面文案",
      description: "取一頁的 SEO 資訊、所有文案區塊（block_key → 三語文字）與清單項目（唯讀）。",
      annotations: READ_ONLY,
    },
    async ({ slug }) => {
      const { getPageBySlug, listPageBlocks, listPageListItems } =
        await import("@/server/repos/pages");
      const page = await getPageBySlug(slug);
      if (!page) notFound("頁面", slug);
      const [blocks, listItems] = await Promise.all([
        listPageBlocks(slug),
        listPageListItems(slug),
      ]);
      return jsonText({
        page,
        blocks: blocks.map((b) => ({ block_key: b.block_key, value: b.value })),
        list_items: listItems,
      });
    },
  );

  add(
    "update_page_blocks",
    {
      title: "修改頁面文案區塊",
      description:
        "修改一頁裡既有文案區塊的文字（用 get_page 列出的 block_key）。區塊是前台程式寫死的位置，**不能新增或刪除**，只能改內容。" +
        WRITE_NOTE,
      annotations: WRITE,
    },
    async (args) => {
      const [{ listPageBlocks, bulkUpdatePageBlocks }, { pageBlocksBulkSchema }] =
        await Promise.all([import("@/server/repos/pages"), import("@/lib/admin/schemas")]);
      const existing = await listPageBlocks(args.page_slug);
      if (existing.length === 0) notFound("頁面（或這頁沒有文案區塊）", args.page_slug);
      const byKey = new Map(existing.map((b) => [b.block_key, b]));
      const seen = new Set<string>();
      for (const b of args.blocks) {
        if (!byKey.has(b.block_key)) {
          throw new McpInputError(
            `「${args.page_slug}」沒有 block_key「${b.block_key}」（區塊不能新增）。這頁有：${[...byKey.keys()].join("、")}`,
          );
        }
        if (seen.has(b.block_key)) throw new McpInputError(`block_key「${b.block_key}」重複了`);
        seen.add(b.block_key);
      }

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const translated: string[] = [];
      const t = await translator();
      const updates: {
        id: number;
        block_key: string;
        value: { zh: string; en: string; ja: string };
      }[] = [];
      for (const b of args.blocks) {
        const row = byKey.get(b.block_key)!;
        const r = await fillLocalized(b.block_key, b.value as LocalizedArg, t);
        if (r.translated) translated.push(b.block_key);
        before[b.block_key] = row.value;
        after[b.block_key] = r.value;
        updates.push({ id: row.id, block_key: row.block_key, value: r.value });
      }
      const valid = validate<{ page_slug: string; blocks: typeof updates }>(pageBlocksBulkSchema, {
        page_slug: args.page_slug,
        blocks: updates,
      });
      const keys = args.blocks.map((b) => b.block_key);
      return runWrite({
        tool: "update_page_blocks",
        entity: "page_blocks",
        id: args.page_slug,
        action: "update",
        dryRun: args.dry_run !== false,
        before,
        after,
        fields: keys,
        translated,
        commit: async () => {
          // 只送真的有變的那幾塊，沒變的不碰（updated_at 不會被無意義地刷新）。
          const changed = valid.blocks.filter(
            (b) => JSON.stringify(byKey.get(b.block_key)!.value) !== JSON.stringify(b.value),
          );
          const rows = await bulkUpdatePageBlocks(valid.page_slug, changed);
          return {
            id: valid.page_slug,
            row: {
              blocks: rows
                .filter((r) => keys.includes(r.block_key))
                .map((r) => ({ block_key: r.block_key, value: r.value })),
            },
          };
        },
      });
    },
  );

  /* ============================================================ 全站設定／分類（唯讀） */

  add(
    "get_site_info",
    {
      title: "店家基本資訊",
      description:
        "店家簡介、地址、營業時間、聯絡信箱、社群連結、預設 SEO（唯讀；付款帳戶與通知信箱不提供）。",
      annotations: READ_ONLY,
    },
    async () => {
      const { getSiteSettings } = await import("@/server/repos/site-settings");
      const s = await getSiteSettings();
      // 白名單：notify_emails 與 bank_* 刻意不在裡面。
      return jsonText(
        pickFields(s as unknown as Record<string, unknown>, [
          "short_desc",
          "address",
          "city",
          "hours",
          "closed",
          "contact_email",
          "site_url",
          "social_instagram",
          "social_facebook",
          "social_line",
          "map_link",
          "map_apple",
          "meta_site_name",
          "meta_author",
          "default_meta_title",
          "default_meta_description",
          "updated_at",
        ]),
      );
    },
  );

  add(
    "list_event_categories",
    {
      title: "活動分類",
      description: "列出活動分類（update_event 的 category 要用這裡的 id）。",
      annotations: READ_ONLY,
    },
    async () => {
      const { listEventCategories } = await import("@/server/repos/event-categories");
      return jsonText({ categories: await listEventCategories() });
    },
  );

  /* ============================================================ 圖片 */

  add(
    "upload_image_from_url",
    {
      title: "從網址上傳圖片",
      description:
        "從一個公開 https 網址抓圖（JPEG／PNG／WebP，2MB 以內），存進網站的圖片空間，回傳可以填進其他工具 image_key 的 key 與公開網址。" +
        "伺服器端不會重新壓縮：超過長邊 1600px 或不是 WebP 時會在結果裡警告。dry_run=true 只檢查不存。" +
        UPLOAD_GUIDE,
      annotations: { ...WRITE, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const { fetchRemoteImage, imageWarnings } = await import("./remote-image");
      const fetched = await fetchRemoteImage(args.url);
      const warnings = imageWarnings(fetched.info);
      const summary = {
        source: fetched.finalUrl,
        bytes: fetched.bytes.byteLength,
        format: fetched.info?.format ?? null,
        width: fetched.info?.width ?? null,
        height: fetched.info?.height ?? null,
        warnings: warnings.length ? warnings : undefined,
      };
      if (args.dry_run !== false) {
        return jsonText({
          dry_run: true,
          written: false,
          ...summary,
          next_step: "檢查通過，尚未存檔。用同一個網址加上 dry_run=false 再呼叫一次才會存進網站。",
        });
      }
      const { storeSiteImageBytes } = await import("./image-upload");
      const uploaded = await storeSiteImageBytes(fetched.bytes);
      const { writeMcpAudit } = await import("./audit");
      const audit = await writeMcpAudit({
        tool: "upload_image_from_url",
        entity: "site_image",
        entity_id: uploaded.key,
        action: "upload",
        changes: summary,
      });
      return jsonText({
        dry_run: false,
        written: true,
        key: uploaded.key,
        url: uploaded.url,
        ...summary,
        audit: audit === "recorded" ? "recorded" : "log_only（稽核表寫入失敗，紀錄只在伺服器 log）",
        next_step:
          "把 key 填進 create_event／create_journey／create_shop_product／update_event／update_shop_product／update_speaker 的 image_key（或 update_publication 的 cover_image_key）。",
      });
    },
  );

  /* ============================================================ 直接上傳圖片（./image-upload.ts） */
  // 只上傳素材、不改任何頁面：沒有 dry_run。稽核只記檔名、大小、格式、key ——
  // 不記 base64 內容、不記 ChatGPT 的 download_url、不記 signed URL（都帶簽章或就是圖本身）。

  add(
    "create_image_upload_url",
    {
      title: "取得圖片直傳網址（能跑 curl 的 AI 用）",
      description:
        "給能執行指令的 AI（Claude Code、Codex）：拿一個 10 分鐘內有效、只能傳一次的上傳網址，用回傳的 curl 指令把本機圖片直接傳上去，" +
        "**傳完一定要呼叫 finalize_image_upload(upload_id)**，伺服器檢查過（JPEG／PNG／WebP、2MB 以內、內容真的是圖片）才會存進網站並回傳 key。" +
        "路徑由伺服器決定，不能指定。" +
        UPLOAD_GUIDE,
      annotations: { ...WRITE, idempotentHint: false },
    },
    async (args) => {
      const up = await import("./image-upload");
      const fileName = up.cleanFileName(args.file_name);
      up.assertDeclaredSize(args.size);
      const { uploadId, uploadUrl } = await up.createStagedUpload(args.content_type);
      const { writeMcpAudit } = await import("./audit");
      const audit = await writeMcpAudit({
        tool: "create_image_upload_url",
        entity: "site_image_upload",
        entity_id: uploadId,
        action: "create",
        changes: { file_name: fileName, content_type: args.content_type, size: args.size },
      });
      return jsonText({
        upload_id: uploadId,
        upload_url: uploadUrl,
        method: "PUT",
        headers: { "Content-Type": args.content_type, "x-upsert": "false" },
        curl: up.curlLine(uploadUrl, args.content_type),
        expires_in_seconds: up.UPLOAD_WINDOW_SECONDS,
        max_bytes: up.MCP_IMAGE_MAX_BYTES,
        audit: audit === "recorded" ? "recorded" : "log_only（稽核表寫入失敗，紀錄只在伺服器 log）",
        next_step:
          "1) 用上面的 curl 把檔案傳上去（Content-Type 要跟宣告一致）；2) 呼叫 finalize_image_upload，upload_id 填這個值，拿到 key（storage:… 開頭）；" +
          "3) 把 key 填進 update_event／create_event 等工具的 image_key，圖片才會出現在頁面上。10 分鐘內沒 finalize 就要重新申請。",
      });
    },
  );

  add(
    "finalize_image_upload",
    {
      title: "完成圖片直傳（檢查並存進網站）",
      description:
        "create_image_upload_url 的第二步：用 curl 傳完之後呼叫。伺服器讀回檔案，檢查 magic bytes（真的是 JPEG／PNG／WebP、與宣告一致）、尺寸、2MB 上限，" +
        "合格才存進網站並回傳 key（storage:… 開頭）；不合格或超過 10 分鐘就作廢這張上傳網址並回錯。每個 upload_id 只能 finalize 一次（檔案還沒傳上去時可以傳好再呼叫）。" +
        "上傳後還要再呼叫 update_event、create_event 等工具把 key 填進 image_key，圖片才會出現在頁面上。",
      annotations: { ...WRITE, idempotentHint: false },
    },
    async (args) => {
      const up = await import("./image-upload");
      const { validated, stored } = await up.finalizeStagedUpload(args.upload_id);
      const summary = {
        source: "signed_upload",
        upload_id: args.upload_id,
        ...up.imageSummary(validated),
      };
      const { writeMcpAudit } = await import("./audit");
      const audit = await writeMcpAudit({
        tool: "finalize_image_upload",
        entity: "site_image",
        entity_id: stored.key,
        action: "upload",
        changes: { ...summary, key: stored.key },
      });
      return jsonText(uploadResult(stored, summary, audit));
    },
  );

  add(
    "upload_image_base64",
    {
      title: "上傳圖片（base64）",
      description:
        "給只能把圖片轉成文字放進參數的 AI（例如網頁版 Claude）：data 放圖片的 base64，伺服器解碼後檢查 magic bytes（真的是 JPEG／PNG／WebP、與 content_type 一致）與大小，" +
        "合格就存進網站並回傳 key（storage:… 開頭）。原檔上限 2MB（base64 約 2,796,204 字）；太大請先壓縮，或能跑指令就改用 create_image_upload_url。" +
        UPLOAD_GUIDE,
      annotations: { ...WRITE, idempotentHint: false },
    },
    async (args) => {
      const up = await import("./image-upload");
      const fileName = up.cleanFileName(args.file_name);
      const bytes = up.decodeBase64Image(args.data);
      const validated = up.validateImageBytes(bytes, args.content_type);
      const stored = await up.storeSiteImageBytes(validated.bytes);
      const summary = { source: "base64", file_name: fileName, ...up.imageSummary(validated) };
      const { writeMcpAudit } = await import("./audit");
      // 🔴 不放 args.data：稽核只記檔名、大小、格式、key。
      const audit = await writeMcpAudit({
        tool: "upload_image_base64",
        entity: "site_image",
        entity_id: stored.key,
        action: "upload",
        changes: { ...summary, key: stored.key },
      });
      return jsonText(uploadResult(stored, summary, audit));
    },
  );

  add(
    "upload_image_file",
    {
      title: "上傳 ChatGPT 對話裡的圖片",
      description:
        "ChatGPT 生成或使用者貼上的圖片，請用這支：把對話裡的圖片檔交給 file 參數（ChatGPT 會自動帶 download_url／file_id），" +
        "伺服器只從 OpenAI 的檔案網域下載，檢查 magic bytes（JPEG／PNG／WebP）與 2MB 上限後存進網站並回傳 key（storage:… 開頭）。" +
        "如果 ChatGPT 無法把生成的圖當成檔案交出來，請使用者先把圖下載、再貼回對話，然後重試。" +
        UPLOAD_GUIDE,
      annotations: { ...WRITE, idempotentHint: false, openWorldHint: true },
      // OpenAI Apps SDK：列在這裡的參數，ChatGPT 會換成 {download_url, file_id, mime_type?, file_name?}。
      _meta: { "openai/fileParams": ["file"] },
    },
    async (args) => {
      const up = await import("./image-upload");
      const { fetchRemoteImage } = await import("./remote-image");
      let host = "";
      try {
        host = new URL(args.file.download_url).hostname;
      } catch {
        throw new McpInputError("file.download_url 不是合法網址");
      }
      const fetched = await fetchRemoteImage(args.file.download_url, {
        allowHost: up.isOpenAIFileHost,
        hostError: (h) =>
          `下載網址的主機 ${h} 不是 OpenAI 的檔案網域（只接受 ${up.OPENAI_FILE_HOST_SUFFIXES.map((x) => `*.${x}`).join("、")}）。` +
          "一般網址請改用 upload_image_from_url。",
      });
      const declared =
        args.file.mime_type && Object.hasOwn(up.MCP_IMAGE_TYPES, args.file.mime_type)
          ? args.file.mime_type
          : null;
      if (args.file.mime_type && !declared) {
        throw new McpInputError(
          `檔案類型 ${args.file.mime_type} 不收。只收 JPEG、PNG、WebP 圖片；SVG、HTML、GIF、AVIF 等格式一律不收。`,
        );
      }
      const fileName = args.file.file_name ? up.cleanFileName(args.file.file_name) : null;
      const validated = up.validateImageBytes(fetched.bytes, declared);
      const stored = await up.storeSiteImageBytes(validated.bytes);
      const summary = {
        source: "chatgpt_file",
        file_id: args.file.file_id,
        file_name: fileName,
        download_host: host,
        ...up.imageSummary(validated),
      };
      const { writeMcpAudit } = await import("./audit");
      // 🔴 不放 download_url（帶簽章）。
      const audit = await writeMcpAudit({
        tool: "upload_image_file",
        entity: "site_image",
        entity_id: stored.key,
        action: "upload",
        changes: { ...summary, key: stored.key },
      });
      return jsonText(uploadResult(stored, summary, audit));
    },
  );

  /* ============================================================ 新增（./create-tools.ts） */
  // 稽核在 create-tools.ts 的 withAudit() 裡記（含 dry_run 與被擋下的呼叫），錯誤也在那裡
  // 轉成文字；外面再包一層 safe() 只是保險。

  add(
    "create_event",
    { ...CREATE_TOOL_META.create_event, annotations: CREATE, auditInvalid: true },
    async (args) => runCreateEvent("event", args),
  );

  add(
    "create_journey",
    { ...CREATE_TOOL_META.create_journey, annotations: CREATE, auditInvalid: true },
    async (args) => runCreateEvent("journey", args),
  );

  add(
    "create_shop_product",
    { ...CREATE_TOOL_META.create_shop_product, annotations: CREATE, auditInvalid: true },
    async (args) => runCreateShopProduct(args, { translator }),
  );

  /* ============================================================ 後台資料（唯讀，./admin-read-tools.ts） */
  // 一律 READ_ONLY；說明與實作都在那個檔案，這裡只負責註冊。

  for (const name of ADMIN_READ_TOOLS) {
    const run = ADMIN_READ_HANDLERS[name] as (args: unknown) => Promise<TextResult>;
    add(name, { ...ADMIN_READ_TOOL_META[name], annotations: READ_ONLY }, (args) => run(args));
  }
}
