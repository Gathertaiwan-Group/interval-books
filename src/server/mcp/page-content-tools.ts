/**
 * MCP 工具 —— 頁面設定（pages 表）與清單項目（page_list_items）的修改（2026-11-18）。
 *
 * ── 為什麼要有 ────────────────────────────────────────────────────────────
 * 後台「頁面文案」編輯頁在 44b4933 移除了（業主要求），MCP 只剩 update_page_blocks 改
 * page_blocks。pages 那一列的 SEO 標題／描述、OG、頁首標題／引言／眉標，以及
 * page_list_items（例如 visit 頁 list_key=inside 的「店內體驗」）就沒有任何管道能改。
 *
 * ── 一條規矩：走被移除的後台頁同一條路 ───────────────────────────────────
 * 被移除的 src/lib/admin/fns/pages.ts（見 44b4933^）是這樣寫的：
 *   · updatePageMeta     = pageMetaSchema 驗證 → src/server/repos/pages.ts#updatePageMeta
 *   · upsertPageListItem = pageListItemSchema 驗證 → src/server/repos/pages.ts#upsertPageListItem
 * 這裡照抄：讀出那一列 → 只套上這次有送的欄位 → 用**同一支 zod schema**驗 → 呼叫**同一支 repo**。
 * 這個檔案沒有任何一句自己寫的 update／insert／delete／rpc（自檢守著）。
 *
 * 清單項目只開放「修改既有一項的 label／note／image_key」：不新增、不刪除、不改 list_key、
 * 不改排序（upsertPageListItem 的 update 分支本來就不寫 sort_order；list_key 一律沿用原值）。
 *
 * ── 慣例（照 partners-content-tools.ts）───────────────────────────────────
 * dry_run 預設 true；預覽與寫入都記 mcp_audit_log；一律要 OAuth 管理員身分（靜態 token 拒絕，
 * 被移除的後台頁走 adminFnMiddleware，MCP 的 OAuth 連線只發給管理員）。
 * 三語欄位規則與 update_page_blocks 相同（只給中文 → 自動翻譯英日文）。預覽一律回
 * confirm_args：有送的三語欄位都補成完整 {zh,en,ja}，原樣帶回就不會重新翻譯。
 *
 * repos 一律在 handler 裡 dynamic import，這個模組載入時不碰 Supabase。
 */
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { z as z3 } from "zod";
import { z } from "zod4";
import {
  CONFIRM_ARGS_NEXT_STEP,
  confirmArgs,
  errText,
  fillLocalized,
  imageKeyFromArg,
  jsonText,
  McpInputError,
  stableStringify,
  writeTimeNote,
  zodIssuesText,
  type LocalizedArg,
  type TextResult,
  type Translator,
} from "./core";

const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/* ------------------------------------------------------------------ 共用 arg */

const dryRunArg = z
  .boolean()
  .default(true)
  .describe(
    "預設 true：只回傳會改什麼，不寫入。確認後把預覽回傳的 confirm_args 原樣當參數再呼叫一次才會寫入。",
  );

/** 三語欄位（同 tools.ts）：一段中文（英日文自動翻譯），或 {zh, en?, ja?}。 */
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
      `${what}。三語欄位：可以只給中文字串（英日文會自動翻譯補上），或給 {"zh":…,"en":…,"ja":…}；只給其中一個語言時，缺的那個會自動翻譯。只改中文、英日文不動：把 get_page 讀到的 en／ja 原樣放進來。`,
    );
}

const clearableLocalized = (what: string) =>
  localizedArg(`${what}（null＝清空，前台改用程式內建的後備文案；不送＝不動）`)
    .nullable()
    .optional();

const imageArg = (what: string) =>
  z
    .string()
    .max(500)
    .nullable()
    .optional()
    .describe(
      `${what}：填上傳工具（upload_image_from_url／upload_image_base64／upload_image_file／finalize_image_upload）回傳的 key（storage:… 開頭）或這個站 site-images 的公開網址；null 代表清掉；不送＝不動。`,
    );

/* ------------------------------------------------------------------ 輸入 */

const META_LOCALIZED_REQUIRED = ["meta_title", "meta_description"] as const;
const META_LOCALIZED_CLEARABLE = [
  "og_title",
  "og_description",
  "eyebrow_suffix",
  "header_title",
  "header_intro",
] as const;
const META_LOCALIZED = [...META_LOCALIZED_REQUIRED, ...META_LOCALIZED_CLEARABLE] as const;
const META_FIELDS = [...META_LOCALIZED, "eyebrow_prefix", "og_image_key"] as const;

const LIST_ITEM_FIELDS = ["label", "note", "image_key"] as const;

export const PAGE_CONTENT_TOOL_INPUTS = {
  update_page_meta: z.object({
    slug: z.string().trim().min(1).max(100).describe("pages.slug，見 list_pages／get_page"),
    meta_title: localizedArg("SEO 標題（瀏覽器分頁與搜尋結果的標題）").optional(),
    meta_description: localizedArg("SEO 描述（搜尋結果下方那段文字）").optional(),
    og_title: clearableLocalized("社群分享標題（FB／LINE 預覽）"),
    og_description: clearableLocalized("社群分享描述"),
    eyebrow_suffix: clearableLocalized("頁首眉標後半段（例如「地方刊物」）"),
    header_title: clearableLocalized("頁首大標題"),
    header_intro: clearableLocalized("頁首引言"),
    eyebrow_prefix: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .optional()
      .describe(
        "頁首眉標前半段（英文、不分語言，例如 Local Publications；null＝清空；不送＝不動）",
      ),
    og_image_key: imageArg("社群分享圖"),
    dry_run: dryRunArg,
  }),
  update_page_list_item: z.object({
    page_slug: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe("這一項所在的 pages.slug（get_page 的 list_items[].page_slug）"),
    id: z
      .number()
      .int()
      .positive()
      .describe("get_page 列出的 list_items[].id（只能改既有的項目，不能新增或刪除）"),
    label: localizedArg("項目文字").optional(),
    note: clearableLocalized("項目補充說明"),
    image_key: imageArg("項目圖片"),
    dry_run: dryRunArg,
  }),
} as const;

export type PageContentToolName = keyof typeof PAGE_CONTENT_TOOL_INPUTS;
type Args<N extends PageContentToolName> = z.output<(typeof PAGE_CONTENT_TOOL_INPUTS)[N]>;

const PREVIEW =
  "預設 dry_run=true 只預覽（回傳差異與 confirm_args），確認後把 confirm_args 原樣送回才寫入。預覽與寫入都會記稽核。";
const OAUTH = "需要 OAuth 管理員身分（靜態 token 會被拒絕）。";

export const PAGE_CONTENT_TOOL_META: Record<
  PageContentToolName,
  { title: string; description: string; annotations: ToolAnnotations }
> = {
  update_page_meta: {
    title: "修改頁面設定（SEO／頁首）",
    description:
      "修改 pages 表一頁的設定：SEO 標題與描述（meta_title／meta_description）、社群分享標題／描述／圖片（og_*）、" +
      "頁首眉標（eyebrow_prefix／eyebrow_suffix）、頁首標題與引言（header_title／header_intro）。" +
      "只送要改的欄位，沒送的維持原值；三語欄位規則與 update_page_blocks 相同。不能新增或刪除頁面。" +
      "對應原後台「頁面文案」編輯頁的「頁面設定」儲存（repo updatePageMeta）。改完前台最多約 60 秒後生效（快取）。" +
      PREVIEW +
      OAUTH,
    annotations: WRITE,
  },
  update_page_list_item: {
    title: "修改頁面清單項目",
    description:
      "修改一頁裡既有的一個清單項目（page_list_items，例如 visit 頁 list_key=inside 的「店內體驗」）：" +
      "項目文字 label、補充說明 note、圖片 image_key。用 get_page 列出的 list_items[].id 與 page_slug 指定。" +
      "不能新增、刪除、改分類（list_key）或改排序。三語欄位規則與 update_page_blocks 相同。" +
      "對應原後台「頁面文案」編輯頁的清單項目儲存（repo upsertPageListItem 的修改分支）。改完前台最多約 60 秒後生效（快取）。" +
      PREVIEW +
      OAUTH,
    annotations: WRITE,
  },
};

/* ------------------------------------------------------------------ 小工具 */

function notFound(what: string, id: string | number): never {
  throw new McpInputError(`找不到${what}「${id}」。請先用 list_pages／get_page 查。`);
}

function validateWith<S extends z3.ZodTypeAny>(schema: S, value: unknown): z3.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new McpInputError(
      `欄位驗證失敗（與後台同一套規則）：${zodIssuesText(r.error) ?? "格式不正確"}`,
    );
  }
  return r.data as z3.output<S>;
}

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

/** 翻譯沿用 tools.ts#translator（translate-selftest 守著「只有 tools.ts 這支 MCP 檔案 import 翻譯」）。 */
async function translator(): Promise<Translator | null> {
  const { translator: shared } = await import("./tools");
  return shared();
}

/**
 * 有送的三語欄位補齊成 {zh,en,ja}（null＝清空、undefined＝不動）。三種語言都給了就不碰翻譯。
 */
async function fillSome(
  args: Record<string, unknown>,
  fields: readonly string[],
): Promise<{ values: Record<string, unknown>; translated: string[] }> {
  const values: Record<string, unknown> = {};
  const translated: string[] = [];
  let t: Translator | null | undefined;
  for (const f of fields) {
    const v = args[f];
    if (v === undefined) continue;
    if (v === null) {
      values[f] = null;
      continue;
    }
    const arg = v as LocalizedArg;
    const complete =
      typeof arg === "object" && Boolean(arg.zh?.trim() && arg.en?.trim() && arg.ja?.trim());
    if (!complete && t === undefined) t = await translator();
    const r = await fillLocalized(f, arg, complete ? null : (t ?? null));
    values[f] = r.value;
    if (r.translated) translated.push(f);
  }
  return { values, translated };
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

/** 寫入（含預覽）一律要 OAuth 管理員。 */
async function requireOauth(tool: string): Promise<void> {
  const { currentMcpActor } = await import("./actor");
  const actor = currentMcpActor();
  if (actor?.via === "oauth") return;
  throw new McpInputError(
    `${tool} 需要 OAuth 管理員身分：原後台「頁面文案」只開放給登入的管理員，靜態 token 沒有對應的使用者。` +
      "請改用 claude.ai／ChatGPT 連接器（OAuth）登入的連線。",
  );
}

/** 預覽 → 記 dry_run 稽核、回差異＋confirm_args；正式 → 呼叫 repo、記稽核、回存好的值。 */
async function finish(opts: {
  tool: string;
  entity: string;
  entityId: string;
  args: Record<string, unknown>;
  dryRun: boolean;
  changes: Record<string, { before: unknown; after: unknown }>;
  resolved: Record<string, unknown>;
  translated: string[];
  commit: () => Promise<unknown>;
}): Promise<TextResult> {
  const { tool, entity, entityId, changes } = opts;
  if (Object.keys(changes).length === 0) {
    return jsonText({
      tool,
      id: entityId,
      dry_run: opts.dryRun,
      written: false,
      message: "沒有任何欄位改變，不需要寫入。",
    });
  }
  if (opts.dryRun) {
    await audit(tool, entity, entityId, "update", { changes }, true);
    return jsonText({
      dry_run: true,
      written: false,
      action: "update",
      entity,
      id: entityId,
      changes,
      auto_translated: opts.translated.length ? opts.translated : undefined,
      ...(opts.translated.length ? { note: "英日文是自動翻譯的，請一併確認。" } : {}),
      confirm_args: confirmArgs(opts.args, opts.resolved),
      next_step: CONFIRM_ARGS_NEXT_STEP,
    });
  }
  let saved: unknown;
  try {
    saved = await opts.commit();
  } catch (err) {
    await audit(
      tool,
      entity,
      entityId,
      "update_failed",
      { changes, error: err instanceof Error ? err.message : String(err) },
      false,
    );
    throw err;
  }
  const status = await audit(tool, entity, entityId, "update", { changes }, false);
  return jsonText({
    dry_run: false,
    written: true,
    action: "update",
    entity,
    id: entityId,
    changes,
    saved,
    audit: auditText(status),
    write_note: writeTimeNote(opts.translated),
    reminder: "前台有快取，最多約 60 秒後才看得到新文字。",
  });
}

/* ------------------------------------------------------------------ 實作 */

type Impl = { [N in PageContentToolName]: (args: Args<N>) => Promise<TextResult> };

const IMPL: Impl = {
  async update_page_meta(args) {
    const tool = "update_page_meta";
    await requireOauth(tool);
    const a = args as Record<string, unknown>;
    if (!META_FIELDS.some((f) => a[f] !== undefined)) {
      throw new McpInputError(`沒有要改的欄位。可以改：${META_FIELDS.join("、")}。`);
    }
    const { getPageBySlug } = await import("@/server/repos/pages");
    const current = await getPageBySlug(args.slug);
    if (!current) notFound("頁面", args.slug);

    const filled = await fillSome(a, META_LOCALIZED);
    const next: Record<string, unknown> = {
      slug: current.slug,
      meta_title: current.meta_title,
      meta_description: current.meta_description,
      og_title: current.og_title,
      og_description: current.og_description,
      og_image_key: current.og_image_key,
      eyebrow_prefix: current.eyebrow_prefix,
      eyebrow_suffix: current.eyebrow_suffix,
      header_title: current.header_title,
      header_intro: current.header_intro,
      ...filled.values,
    };
    const resolved: Record<string, unknown> = { ...filled.values };
    if (args.eyebrow_prefix !== undefined) {
      const v = args.eyebrow_prefix?.trim() ? args.eyebrow_prefix.trim() : null;
      next.eyebrow_prefix = v;
      resolved.eyebrow_prefix = v;
    }
    if (args.og_image_key !== undefined) {
      const v = imageKeyFromArg(args.og_image_key, [current.og_image_key]);
      next.og_image_key = v;
      resolved.og_image_key = v;
    }

    const { pageMetaSchema } = await import("@/lib/admin/schemas");
    const payload = validateWith(pageMetaSchema, next);
    const changes = diff(current as unknown as Record<string, unknown>, payload, META_FIELDS);
    return finish({
      tool,
      entity: "pages",
      entityId: current.slug,
      args: a,
      dryRun: args.dry_run !== false,
      changes,
      resolved,
      translated: filled.translated,
      commit: async () => {
        const { updatePageMeta } = await import("@/server/repos/pages");
        const row = await updatePageMeta(payload);
        return Object.fromEntries(META_FIELDS.map((f) => [f, row[f] ?? null]));
      },
    });
  },

  async update_page_list_item(args) {
    const tool = "update_page_list_item";
    await requireOauth(tool);
    const a = args as Record<string, unknown>;
    if (!LIST_ITEM_FIELDS.some((f) => a[f] !== undefined)) {
      throw new McpInputError("沒有要改的欄位。可以改：label、note、image_key。");
    }
    const { listPageListItems } = await import("@/server/repos/pages");
    const items = await listPageListItems(args.page_slug);
    const current = items.find((i) => i.id === args.id);
    if (!current) notFound(`「${args.page_slug}」頁的清單項目`, args.id);

    const filled = await fillSome(a, ["label", "note"]);
    const next: Record<string, unknown> = {
      id: current.id,
      page_slug: current.page_slug,
      list_key: current.list_key,
      label: current.label,
      note: current.note,
      image_key: current.image_key,
      sort_order: current.sort_order,
      ...filled.values,
    };
    const resolved: Record<string, unknown> = { ...filled.values };
    if (args.image_key !== undefined) {
      const v = imageKeyFromArg(args.image_key, [current.image_key]);
      next.image_key = v;
      resolved.image_key = v;
    }

    const { pageListItemSchema } = await import("@/lib/admin/schemas");
    const payload = validateWith(pageListItemSchema, next);
    const changes = diff(current as unknown as Record<string, unknown>, payload, LIST_ITEM_FIELDS);
    return finish({
      tool,
      entity: "page_list_items",
      entityId: String(current.id),
      args: a,
      dryRun: args.dry_run !== false,
      changes,
      resolved,
      translated: filled.translated,
      commit: async () => {
        const { upsertPageListItem } = await import("@/server/repos/pages");
        // id 有值 → repo 走修改分支（不寫 sort_order）；list_key 沿用原值。
        const row = await upsertPageListItem({ ...payload, id: current.id });
        return {
          id: row.id,
          page_slug: row.page_slug,
          list_key: row.list_key,
          label: row.label,
          note: row.note,
          image_key: row.image_key,
        };
      },
    });
  },
};

/* ------------------------------------------------------------------ 包裝 */

function wrap<N extends PageContentToolName>(name: N): (args: unknown) => Promise<TextResult> {
  const schema = PAGE_CONTENT_TOOL_INPUTS[name] as unknown as {
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
      console.error(`[mcp/page-content] ${name} 失敗`, err instanceof Error ? err.message : err);
      return errText(`執行失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export const PAGE_CONTENT_HANDLERS = Object.fromEntries(
  (Object.keys(PAGE_CONTENT_TOOL_INPUTS) as PageContentToolName[]).map((n) => [n, wrap(n)]),
) as { [N in PageContentToolName]: (args: Args<N> | unknown) => Promise<TextResult> };
