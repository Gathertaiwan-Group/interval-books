/**
 * MCP 工具 —— 門市套餐與庫存異動（2026-11-15）：
 *   · 套餐結帳（/admin/pos 第二個分頁「套餐結帳」）
 *   · 套餐設定（/admin/inventory-combos：列表、內頁、新增、編輯、上架／下架、重新送審）
 *     —— 套餐的「通過／退回」併進 ops-write-tools.ts 的 approve_inventory_record（module=combo_sets）
 *   · 在庫異動（/admin/inventory-adjustments：列表、內頁、送出草稿／重新送審）
 *     —— 新增異動單＝既有的 create_stock_adjustment；核准＝既有的 approve_inventory_record
 *   · 賣超告警標成已處理（/admin/stock-alerts「標記已處理」）
 *
 * ── 規矩與 ops-write-tools.ts 相同 ─────────────────────────────────────────
 * 每一支寫入都呼叫後台按鈕背後那一支 repo 函式（src/server/repos/inv-combos.ts、
 * inv-adjustments.ts、inv-sales.ts），那一層再呼叫 SECURITY DEFINER RPC。這裡**沒有**
 * 自己寫的 update／insert／delete／rpc——分攤、FIFO、審核狀態、狀態機全部在資料庫。
 * 這個檔案只做：讀「改前」、用後台同一份 zod 規則驗輸入、dry_run=false 才呼叫 repo，
 * 預覽與寫入都記 mcp_audit_log。
 *
 * ── 操作人員與權限 ────────────────────────────────────────────────────────
 * 後台的 server fn 都用 context.staff.userId 當 p_user_id；這裡用 OAuth 的 user_id，
 * 靜態 token 一律拒絕（RPC 必須記錄操作人員）。後台的細權限：
 *   · 套餐審核 approve_combo_sets（approve_inventory_record 那一支）
 *   · 賣超告警標已處理 approve_stock_adjustments（staffFnMiddleware("approve_stock_adjustments")）
 *   · 其餘（結帳、維護套餐、送出異動單）只要 staffFnMiddleware()
 * MCP 的 OAuth 連線只發給管理員，而且每一次請求都重查 profiles（http.ts）；後台的
 * loadStaffPermissions() 對 admin 一律回完整權限，所以這裡的權限與後台相同。
 *
 * ── 不做的東西 ─────────────────────────────────────────────────────────────
 * 刪除套餐、刪除異動單草稿、沖帳——依 MCP 規則不開放刪除與沖銷，請到後台。
 *
 * repos 一律在 handler 裡 dynamic import，這個模組載入時不碰 Supabase。
 */
import { randomUUID } from "node:crypto";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { z as z3 } from "zod";
import { z } from "zod4";
import { errText, jsonText, McpInputError, zodIssuesText, type TextResult } from "./core";
import { INV_ADJUSTMENT_CATEGORIES, INV_ADJUSTMENT_STATUSES } from "@/lib/admin/schemas";

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

/* ------------------------------------------------------------------ 共用 arg */

const dryRunArg = z
  .boolean()
  .default(true)
  .describe(
    "預設 true：只回傳會改什麼，不寫入。確認後用同樣參數加 dry_run=false 再呼叫一次才會寫入。",
  );
const idempotencyKeyArg = z
  .string()
  .trim()
  .uuid()
  .optional()
  .describe(
    "防重複送出的 UUID。dry_run=false 時必填：先用 dry_run=true 預覽取得一組，正式送出帶同一組；同一組只會建立一次。",
  );
const uuidArg = (what: string) => z.string().trim().uuid().describe(what);
const dateArg = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式是 YYYY-MM-DD")
    .describe(`${what}（YYYY-MM-DD，台北日期）`);
const pageArgs = {
  limit: z.number().int().min(1).max(100).default(20).describe("每頁幾筆，預設 20、上限 100"),
  page: z.number().int().min(1).max(10000).default(1).describe("第幾頁，從 1 開始"),
};
const paymentArgs = {
  payment_method_id: z
    .string()
    .trim()
    .uuid()
    .optional()
    .describe(
      "付款方式 id（預覽會列出可選的）。與 payment_method 二選一，都省略＝後台的預設付款方式",
    ),
  payment_method: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe("付款方式名稱（例如「現金」，需與後台名稱完全相同）"),
};
const comboItemsArg = z
  .array(
    z.object({
      product_id: uuidArg("進銷存商品 id（見 list_inventory；只能選櫃檯賣得到的商品）"),
      quantity: z.number().int().min(1).max(999).describe("這件商品在一份套餐裡的數量"),
    }),
  )
  .min(1)
  .max(50);

/* ------------------------------------------------------------------ 輸入 schema */

export const POS_STOCK_TOOL_INPUTS = {
  /* ---- 套餐結帳 ---- */
  create_combo_sale: z.object({
    combo_set_id: uuidArg("套餐 id（見 list_combo_sets；要「上架」且「已審核」）"),
    quantity: z.number().int().min(1).max(100).default(1).describe("賣幾份（預設 1，最多 100）"),
    ...paymentArgs,
    sale_date: dateArg("銷售日期，省略＝今天").optional(),
    notes: z.string().trim().max(2000).optional().describe("備註"),
    override_reservation: z
      .boolean()
      .default(false)
      .describe(
        "組成品項庫存不夠時要不要照賣（＝後台套餐結帳的「先賣」勾選）。預設 false：不夠會被資料庫拒絕；" +
          "true 照樣結帳、組成品項庫存可能變負數，並記進賣超告警。",
      ),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),

  /* ---- 套餐設定 ---- */
  list_combo_sets: z.object({
    keyword: z.string().trim().max(100).optional().describe("搜尋套餐名稱、備註"),
    active_status: z
      .enum(["all", "active", "inactive"])
      .default("all")
      .describe("all（預設）／active 上架中／inactive 已下架"),
    approval_status: z
      .enum(["all", "pending", "approved", "rejected"])
      .default("all")
      .describe("all（預設）／pending 待審／approved 已核准／rejected 已退回"),
    sort: z
      .enum(["name_asc", "name_desc", "created_desc", "sold_desc", "price_desc"])
      .default("name_asc"),
    ...pageArgs,
  }),
  get_combo_set: z.object({ id: uuidArg("套餐 id（combo_set_id）") }),
  create_combo_set: z.object({
    name: z.string().trim().min(1).max(200).describe("套餐名稱"),
    selling_price: z.number().min(0).describe("組合價（元）"),
    items: comboItemsArg.describe("組成品項（至少一件；同一件商品只列一次，要多件請改 quantity）"),
    notes: z.string().trim().max(2000).optional(),
    is_active: z.boolean().default(true).describe("建立後是否上架（預設 true，與後台表單相同）"),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
  update_combo_set: z.object({
    id: uuidArg("套餐 id"),
    name: z.string().trim().min(1).max(200).optional(),
    selling_price: z
      .number()
      .min(0)
      .optional()
      .describe("組合價（元）。改價錢會重新送審（審核有開的話），與後台相同"),
    notes: z.string().trim().max(2000).nullable().optional().describe("備註；null＝清空"),
    is_active: z.boolean().optional(),
    items: comboItemsArg
      .optional()
      .describe("組成品項（給了就整組換掉，與後台表單相同；省略＝不動）"),
    dry_run: dryRunArg,
  }),
  set_combo_set_active: z.object({
    id: uuidArg("套餐 id"),
    is_active: z.boolean().describe("true 上架／false 下架"),
    dry_run: dryRunArg,
  }),
  resubmit_combo_set: z.object({
    id: uuidArg("被退回（rejected）的套餐 id"),
    dry_run: dryRunArg,
  }),

  /* ---- 在庫異動 ---- */
  list_stock_adjustments: z.object({
    keyword: z.string().trim().max(100).optional().describe("搜尋單號、品名、期數、備註"),
    category: z
      .enum(INV_ADJUSTMENT_CATEGORIES)
      .optional()
      .describe("EXP 報廢損耗／PR 公關／SMP 樣品／INT 內部領用／ADJ 盤點調整／CMB 組合調整"),
    status: z
      .enum(["all", ...INV_ADJUSTMENT_STATUSES])
      .default("all")
      .describe(
        "all（預設）／draft 草稿／pending_approval 待審／confirmed 已確認／rejected 已退回",
      ),
    product_id: uuidArg("只看某一件商品").optional(),
    date_from: dateArg("異動日起").optional(),
    date_to: dateArg("異動日迄").optional(),
    sort: z.enum(["date_desc", "date_asc", "created_at", "quantity_desc"]).default("date_desc"),
    ...pageArgs,
  }),
  get_stock_adjustment: z.object({ id: uuidArg("異動單 id（adjustment_id）") }),
  submit_stock_adjustment: z.object({
    id: uuidArg("草稿（draft）或被退回（rejected）的異動單 id"),
    dry_run: dryRunArg,
  }),

  /* ---- 賣超告警 ---- */
  resolve_stock_alert: z.object({
    alert_id: z.number().int().positive().describe("告警編號（見 list_stock_alerts 的 alert_id）"),
    note: z.string().trim().min(1).max(500).describe("怎麼處理的（必填，最多 500 字）"),
    dry_run: dryRunArg,
  }),
} as const;

export type PosStockToolName = keyof typeof POS_STOCK_TOOL_INPUTS;
type Args<N extends PosStockToolName> = z.output<(typeof POS_STOCK_TOOL_INPUTS)[N]>;

/* ------------------------------------------------------------------ 說明 */

const PREVIEW = "預設 dry_run=true 只預覽；dry_run=false 才寫入。預覽與寫入都會記稽核。";
const OAUTH = "需要 OAuth 管理員身分（RPC 必須記錄操作人員）。";
const READ_NOTE = "唯讀，不會改任何資料。";

export const POS_STOCK_TOOL_META: Record<
  PosStockToolName,
  { title: string; description: string; annotations: ToolAnnotations }
> = {
  create_combo_sale: {
    title: "門市套餐結帳",
    description:
      "與後台 /admin/pos 第二個分頁「套餐結帳」同一支 RPC（inv_combo_checkout，一個交易）：賣幾份套餐、扣組成品項庫存、記付款方式。" +
      "組合價怎麼分攤到組成品項由資料庫算（呼叫端改不了金額）。只能賣「上架」且「已審核」的套餐。" +
      "付款方式、備註、日期、超賣行為與 create_pos_sale 相同：庫存不夠預設被資料庫拒絕；override_reservation=true 才照賣並記賣超告警。" +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
  list_combo_sets: {
    title: "套餐列表",
    description:
      "與後台 /admin/inventory-combos 列表同一支查詢：套餐名稱、組合價、上架、審核狀態、組成品項、還能組幾份（max_sets）、已售份數。" +
      READ_NOTE,
    annotations: READ_ONLY,
  },
  get_combo_set: {
    title: "單一套餐",
    description:
      "與後台套餐內頁同一支查詢：套餐資料、組成品項（含庫存）、最近 20 筆套餐銷售、是否需要審核。" +
      READ_NOTE,
    annotations: READ_ONLY,
  },
  create_combo_set: {
    title: "新增套餐",
    description:
      "與後台 /admin/inventory-combos/new「新增套餐」同一支 RPC（inv_save_combo_set）。組成品項只能選櫃檯賣得到的商品（與後台選擇器同一個範圍）。" +
      "要不要審核由資料庫的審核設定決定；需要審核時，核准前櫃檯不能賣，請接著用 approve_inventory_record（module=combo_sets）。" +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
  update_combo_set: {
    title: "修改套餐",
    description:
      "與後台套餐「編輯」頁同一支 RPC（inv_save_combo_set）。只送要改的欄位；給 items 就整組換掉。" +
      "改到組合價會重新送審（審核有開的話），改名字、備註、品項不會——與後台相同。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  set_combo_set_active: {
    title: "套餐上架／下架",
    description:
      "與後台套餐列表與內頁的「上架／下架」按鈕同一支 RPC（inv_set_combo_set_active）。下架後櫃檯看不到。" +
      PREVIEW,
    annotations: WRITE,
  },
  resubmit_combo_set: {
    title: "套餐重新送審",
    description:
      "與後台套餐的「重新送審」按鈕同一支 RPC（inv_resubmit_combo_set）：只有被退回（rejected）的套餐可以，送出後變回待審。" +
      "新增的套餐本來就會自動進待審，不需要這支。核准／退回用 approve_inventory_record（module=combo_sets）。" +
      PREVIEW,
    annotations: WRITE,
  },
  list_stock_adjustments: {
    title: "在庫異動單列表",
    description:
      "與後台 /admin/inventory-adjustments 列表同一支查詢：單號、商品、類別、數量、狀態、原因、建立者。" +
      "新增異動單用 create_stock_adjustment；待審的用 approve_inventory_record（module=stock_adjustments）核准。" +
      READ_NOTE,
    annotations: READ_ONLY,
  },
  get_stock_adjustment: {
    title: "單一在庫異動單",
    description: "與後台異動單內頁同一支查詢（含成本、異動前庫存、沖帳關聯、核准人）。" + READ_NOTE,
    annotations: READ_ONLY,
  },
  submit_stock_adjustment: {
    title: "送出在庫異動單",
    description:
      "與後台異動單的「送出」（草稿 → inv_submit_stock_adjustment）與「重新送審」（被退回 → inv_resubmit_stock_adjustment）按鈕同一支 RPC，依目前狀態自動選。" +
      "送出後要不要審核由資料庫的審核設定決定；不需審核時庫存立刻變動。不做刪除、不做沖帳。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  resolve_stock_alert: {
    title: "賣超告警標成已處理",
    description:
      "與後台 /admin/stock-alerts「標記已處理」同一支（repos/inv-sales resolveStockAlert）：寫下處理說明、記處理人。" +
      "只動還沒處理的那一筆；已經有人處理過回 written=false，不會蓋掉前一位的說明。" +
      "後台需要 approve_stock_adjustments 權限；MCP 的 OAuth 連線只發給管理員（每次請求重查），管理員具備這個權限。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
};

/* ------------------------------------------------------------------ 小工具 */

function notFound(what: string, id: string | number): never {
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

async function preview(
  tool: string,
  entity: string,
  entityId: string,
  action: string,
  body: Record<string, unknown>,
  auditChanges: unknown,
): Promise<TextResult> {
  await audit(tool, entity, entityId, action, auditChanges, true);
  return jsonText({ dry_run: true, written: false, action, ...body, next_step: NEXT_STEP });
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
  return jsonText({
    dry_run: false,
    action,
    ...body,
    audit: status === "recorded" ? "recorded" : "log_only（稽核表寫入失敗，紀錄只在伺服器 log）",
  });
}

/** repo 丟例外：也記一筆（action 加 _failed），再往外丟給 wrap() 轉成 isError。 */
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

async function oauthUserId(tool: string): Promise<string> {
  const { currentMcpActor } = await import("./actor");
  const actor = currentMcpActor();
  if (actor?.via === "oauth") return actor.user_id;
  throw new McpInputError(
    `${tool} 需要 OAuth 管理員身分：這個動作背後的 RPC 必須記錄是哪一位後台使用者操作的，` +
      "靜態 token 沒有對應的使用者。請改用 claude.ai／ChatGPT 連接器（OAuth）登入的連線。",
  );
}

/** 與 ops-write-tools.ts 同一個機制（mcp_oauth_used_codes 一次性表，30 天）。 */
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

/** 付款方式：與 create_pos_sale 同一個規則（id 或名稱二選一；都沒給＝後台預設，沒有就第一個）。 */
async function resolvePaymentMethod(
  id: string | undefined,
  name: string | undefined,
): Promise<{ payment_method_id: string; name: string } | null> {
  if (id && name) throw new McpInputError("payment_method_id 與 payment_method 只給一個。");
  const { listPosPaymentMethods } = await import("@/server/repos/inv-sales");
  const methods = await listPosPaymentMethods();
  const options = methods.map((m) => m.name).join("、") || "（沒有）";
  let hit = null as (typeof methods)[number] | null;
  if (id) {
    hit = methods.find((m) => m.payment_method_id === id) ?? null;
    if (!hit) throw new McpInputError(`找不到付款方式「${id}」。可選：${options}`);
  } else if (name) {
    const key = name.trim().toLowerCase();
    hit = methods.find((m) => m.name.trim().toLowerCase() === key) ?? null;
    if (!hit) throw new McpInputError(`找不到付款方式「${name}」。可選：${options}`);
  } else {
    hit = methods.find((m) => m.is_default) ?? methods[0] ?? null;
  }
  return hit ? { payment_method_id: hit.payment_method_id, name: hit.name } : null;
}

async function paymentOptions() {
  const { listPosPaymentMethods } = await import("@/server/repos/inv-sales");
  return (await listPosPaymentMethods()).map((m) => ({
    id: m.payment_method_id,
    name: m.name,
    is_default: m.is_default,
  }));
}

/** 審核設定：查不到＝要審核（與 inv.initial_approval_status() 同一個 fail-closed 語意，只用來預告）。 */
async function needsApproval(module: string): Promise<boolean> {
  const { listApprovalSettings } = await import("@/server/repos/inv-products");
  const settings = await listApprovalSettings();
  return settings.find((s) => s.module === module)?.is_enabled ?? true;
}

async function loadComboOrThrow(id: string) {
  const { getAdminComboSet } = await import("@/server/repos/inv-combos");
  const set = await getAdminComboSet(id);
  if (!set) notFound("套餐", id);
  return set;
}

function comboBrief(s: {
  combo_set_id: string;
  name: string;
  selling_price: number;
  is_active: boolean;
  approval_status: string;
  notes: string | null;
}) {
  return {
    id: s.combo_set_id,
    name: s.name,
    selling_price: s.selling_price,
    is_active: s.is_active,
    approval_status: s.approval_status,
    notes: s.notes,
  };
}

/**
 * 套餐組成品項：新加進來的商品必須在後台選擇器的範圍（inv_pos_products：已核准、啟用、不是租借），
 * 原本就在這個套餐裡的品項保留（後台編輯頁也不會因為某件商品後來停用就逼你拿掉）。
 */
async function resolveComboItems(
  items: { product_id: string; quantity: number }[],
  existing: { product_id: string; product_name: string; selling_price: number }[] = [],
) {
  const ids = items.map((i) => i.product_id);
  if (new Set(ids).size !== ids.length)
    throw new McpInputError("同一件商品不可以在套餐裡出現兩次，請改用數量。");
  const { listComboPickerProducts } = await import("@/server/repos/inv-sales");
  const picker = await listComboPickerProducts();
  const byId = new Map(picker.map((p) => [p.inv_product_id, p]));
  const old = new Map(existing.map((e) => [e.product_id, e]));
  const bad = ids.filter((id) => !byId.has(id) && !old.has(id));
  if (bad.length) {
    throw new McpInputError(
      `這些商品不在櫃檯可販售的清單裡（要已核准、啟用、不是租借），不能放進套餐：${bad.join("、")}。請先用 list_inventory 查。`,
    );
  }
  return items.map((i) => {
    const p = byId.get(i.product_id);
    const o = old.get(i.product_id);
    return {
      product_id: i.product_id,
      quantity: i.quantity,
      name: p?.name ?? o?.product_name ?? null,
      selling_price: p ? Number(p.selling_price ?? 0) : (o?.selling_price ?? null),
      stock_quantity: p?.stock_quantity ?? null,
    };
  });
}

/* ------------------------------------------------------------------ handlers */

type Handlers = { [N in PosStockToolName]: (args: Args<N>) => Promise<TextResult> };

const IMPL: Handlers = {
  /* ============================================================ 套餐結帳 */

  async create_combo_sale(args) {
    const tool = "create_combo_sale";
    const userId = await oauthUserId(tool);
    const set = await loadComboOrThrow(args.combo_set_id);
    // 與後台 ComboCheckoutTab 的「賣得動」同一個條件（真正的守門在 inv_combo_checkout()）。
    if (!set.is_active) throw new McpInputError(`「${set.name}」已下架，不能販售。`);
    if (set.approval_status !== "approved")
      throw new McpInputError(
        `「${set.name}」還沒通過審核（${set.approval_status}），不能販售。請先用 approve_inventory_record（module=combo_sets）核准。`,
      );
    const { listComboItems } = await import("@/server/repos/inv-combos");
    const items = await listComboItems(set.combo_set_id);
    if (!items.length) throw new McpInputError(`「${set.name}」沒有設定組成品項，不能販售。`);

    const payment = await resolvePaymentMethod(args.payment_method_id, args.payment_method);
    const { comboCheckoutSchema } = await import("@/lib/admin/schemas");
    const data = validateWith(comboCheckoutSchema, {
      combo_set_id: set.combo_set_id,
      quantity: args.quantity,
      sale_date: args.sale_date ?? taipeiToday(),
      payment_method_id: payment?.payment_method_id ?? null,
      notes: args.notes ?? null,
      override_reservation: args.override_reservation,
    });
    const shortfall =
      set.max_sets === null ? data.quantity : Math.max(data.quantity - set.max_sets, 0);
    const auditChanges = {
      ...data,
      combo_name: set.name,
      total_amount: set.selling_price * data.quantity,
    };

    if (args.dry_run) {
      return preview(
        tool,
        "inv_sale",
        "(未建立)",
        "combo_checkout",
        {
          idempotency_key: args.idempotency_key ?? randomUUID(),
          will_create: {
            channel: "pos",
            combo: { id: set.combo_set_id, name: set.name, selling_price: set.selling_price },
            sets: data.quantity,
            total_amount: set.selling_price * data.quantity,
            allocation_basis: set.allocation_basis,
            items: items.map((i) => ({
              product_id: i.product_id,
              name: i.product_name,
              issue_number: i.issue_number,
              quantity_per_set: i.quantity,
              quantity_total: i.quantity * data.quantity,
              stock_quantity: i.stock_quantity,
            })),
            max_sets: set.max_sets,
            sale_date: data.sale_date,
            payment_method: payment?.name ?? null,
            notes: data.notes,
            override_reservation: data.override_reservation,
          },
          payment_method_options: await paymentOptions(),
          ...(shortfall > 0
            ? {
                warning: data.override_reservation
                  ? `目前庫存只夠組 ${set.max_sets ?? 0} 份：會照樣結帳、組成品項庫存可能變負數，並記進賣超告警（與後台勾「先賣」相同）。`
                  : `目前庫存只夠組 ${set.max_sets ?? 0} 份：照這樣送出會被資料庫拒絕（與後台相同）。確認架上真的有貨，才加 override_reservation=true。`,
              }
            : {}),
          note: "金額分攤與庫存以送出當下資料庫計算為準。",
        },
        auditChanges,
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const { comboCheckout } = await import("@/server/repos/inv-combos");
    const res = await commitOrAudit(
      tool,
      "inv_sale",
      "(未建立)",
      "combo_checkout",
      auditChanges,
      () =>
        comboCheckout({
          userId,
          comboSetId: data.combo_set_id,
          quantity: data.quantity,
          saleDate: data.sale_date,
          paymentMethodId: data.payment_method_id,
          notes: data.notes,
          overrideReservation: data.override_reservation,
        }),
    );
    return committed(
      tool,
      "inv_sale",
      (res.sale_groups ?? []).join(",").slice(0, 200) || "(無)",
      "combo_checkout",
      {
        written: true,
        result: res,
        ...(data.override_reservation
          ? { warning: "已結帳；若組成品項庫存不足，已記進賣超告警（list_stock_alerts 看得到）。" }
          : {}),
      },
      { ...auditChanges, result: res },
    );
  },

  /* ============================================================ 套餐設定 */

  async list_combo_sets(args) {
    const { listAdminComboSets, listAllComboItems } = await import("@/server/repos/inv-combos");
    const [sets, items] = await Promise.all([
      listAdminComboSets({
        keyword: args.keyword ?? null,
        activeStatus: args.active_status,
        approvalStatus: args.approval_status,
        sort: args.sort,
      }),
      listAllComboItems(),
    ]);
    const from = (args.page - 1) * args.limit;
    const rows = sets.slice(from, from + args.limit);
    return jsonText({
      total: sets.length,
      page: args.page,
      limit: args.limit,
      has_more: from + rows.length < sets.length,
      rows: rows.map((s) => ({
        ...comboBrief(s),
        item_count: s.item_count,
        total_list_price: s.total_list_price,
        allocation_basis: s.allocation_basis,
        max_sets: s.max_sets,
        sold_sets: s.sold_sets,
        sold_revenue: s.sold_revenue,
        creator_name: s.creator_name,
        approved_by_name: s.approved_by_name,
        created_at: s.created_at,
        items: items
          .filter((i) => i.combo_set_id === s.combo_set_id)
          .map((i) => ({
            product_id: i.product_id,
            name: i.product_name,
            issue_number: i.issue_number,
            quantity: i.quantity,
            selling_price: i.selling_price,
            stock_quantity: i.stock_quantity,
            product_active: i.product_active,
          })),
      })),
    });
  },

  async get_combo_set(args) {
    const { getAdminComboSet, listComboItems, listComboSales } =
      await import("@/server/repos/inv-combos");
    const set = await getAdminComboSet(args.id);
    if (!set) notFound("套餐", args.id);
    const [items, sales, approval] = await Promise.all([
      listComboItems(args.id),
      listComboSales({ comboSetId: args.id, dateFrom: null, dateTo: null, limit: 20 }),
      needsApproval("combo_sets"),
    ]);
    const { user_id: _u, ...rest } = set;
    return jsonText({
      combo: rest,
      items: items.map(({ item_id: _i, combo_set_id: _c, ...i }) => i),
      recent_sales: sales.map(({ user_id: _uid, ...s }) => s),
      approval_setting: approval ? "需要審核" : "不需審核",
      sellable_at_pos: set.is_active && set.approval_status === "approved" && items.length > 0,
    });
  },

  async create_combo_set(args) {
    const tool = "create_combo_set";
    const userId = await oauthUserId(tool);
    const { comboSetSchema } = await import("@/lib/admin/schemas");
    const data = validateWith(comboSetSchema, {
      id: null,
      name: args.name,
      selling_price: args.selling_price,
      notes: args.notes ?? null,
      is_active: args.is_active,
      items: args.items,
    });
    const lines = await resolveComboItems(data.items);
    const approval = await needsApproval("combo_sets");
    const payload = {
      name: data.name,
      selling_price: data.selling_price,
      notes: data.notes,
      is_active: data.is_active,
    };
    const auditChanges = { payload, items: data.items };

    if (args.dry_run) {
      return preview(
        tool,
        "inv_combo_set",
        "(未建立)",
        "create",
        {
          idempotency_key: args.idempotency_key ?? randomUUID(),
          will_create: {
            ...payload,
            items: lines,
            total_list_price: lines.reduce((n, l) => n + (l.selling_price ?? 0) * l.quantity, 0),
            approval: approval ? "pending（需要核准，核准前櫃檯不能賣）" : "approved",
          },
        },
        auditChanges,
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const { saveComboSet } = await import("@/server/repos/inv-combos");
    const res = await commitOrAudit(tool, "inv_combo_set", "(未建立)", "create", auditChanges, () =>
      saveComboSet({ userId, id: null, payload, items: data.items }),
    );
    return committed(
      tool,
      "inv_combo_set",
      res.id,
      "create",
      {
        written: true,
        result: res,
        ...(res.approval_status === "pending"
          ? {
              needs_approval: [{ module: "combo_sets", id: res.id }],
              next_step:
                "套餐待審：用 approve_inventory_record（module=combo_sets）核准後櫃檯才賣得到。",
            }
          : {}),
      },
      { ...auditChanges, result: res },
    );
  },

  async update_combo_set(args) {
    const tool = "update_combo_set";
    const userId = await oauthUserId(tool);
    const set = await loadComboOrThrow(args.id);
    const { listComboItems } = await import("@/server/repos/inv-combos");
    const current = await listComboItems(args.id);
    const nextItems =
      args.items ?? current.map((i) => ({ product_id: i.product_id, quantity: i.quantity }));
    const { comboSetSchema } = await import("@/lib/admin/schemas");
    // 與後台編輯表單送出的形狀一致：四個欄位＋整組品項。
    const data = validateWith(comboSetSchema, {
      id: set.combo_set_id,
      name: args.name ?? set.name,
      selling_price: args.selling_price ?? Number(set.selling_price),
      notes: args.notes === undefined ? set.notes : args.notes,
      is_active: args.is_active ?? set.is_active,
      items: nextItems,
    });
    const lines = args.items ? await resolveComboItems(data.items, current) : null;

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const before = comboBrief(set);
    for (const k of ["name", "selling_price", "notes", "is_active"] as const) {
      const b = before[k] ?? null;
      const a = data[k] ?? null;
      if (JSON.stringify(b) !== JSON.stringify(k === "selling_price" ? Number(a) : a))
        changes[k] = { before: b, after: a };
    }
    if (lines) {
      const key = (xs: { product_id: string; quantity: number }[]) =>
        JSON.stringify(
          [...xs]
            .sort((x, y) => x.product_id.localeCompare(y.product_id))
            .map((x) => [x.product_id, x.quantity]),
        );
      const oldItems = current.map((i) => ({ product_id: i.product_id, quantity: i.quantity }));
      if (key(oldItems) !== key(data.items))
        changes.items = {
          before: current.map((i) => ({
            product_id: i.product_id,
            name: i.product_name,
            quantity: i.quantity,
          })),
          after: lines.map((l) => ({
            product_id: l.product_id,
            name: l.name,
            quantity: l.quantity,
          })),
        };
    }
    if (!Object.keys(changes).length) {
      return jsonText({
        id: args.id,
        dry_run: args.dry_run,
        written: false,
        message: "沒有任何欄位跟現在不同，不需要寫入。",
      });
    }
    const priceChanged = "selling_price" in changes;
    const reReview = priceChanged && (await needsApproval("combo_sets"));
    const payload = {
      name: data.name,
      selling_price: data.selling_price,
      notes: data.notes,
      is_active: data.is_active,
    };
    const auditChanges = { changes };

    if (args.dry_run) {
      return preview(
        tool,
        "inv_combo_set",
        args.id,
        "update",
        {
          id: args.id,
          name: set.name,
          changes,
          ...(reReview
            ? {
                warning: `改了組合價會重新送審：「${set.name}」會變回待審，核准前櫃檯不能賣（與後台相同）。`,
              }
            : {}),
        },
        auditChanges,
      );
    }
    const { saveComboSet } = await import("@/server/repos/inv-combos");
    const res = await commitOrAudit(tool, "inv_combo_set", args.id, "update", auditChanges, () =>
      saveComboSet({ userId, id: set.combo_set_id, payload, items: data.items }),
    );
    return committed(
      tool,
      "inv_combo_set",
      args.id,
      "update",
      {
        written: true,
        result: res,
        ...(res.approval_status === "pending" && set.approval_status !== "pending"
          ? { next_step: "已變回待審：用 approve_inventory_record（module=combo_sets）核准。" }
          : {}),
      },
      { ...auditChanges, result: res },
    );
  },

  async set_combo_set_active(args) {
    const tool = "set_combo_set_active";
    await oauthUserId(tool);
    const set = await loadComboOrThrow(args.id);
    if (set.is_active === args.is_active) {
      return jsonText({
        id: args.id,
        dry_run: args.dry_run,
        written: false,
        message: `「${set.name}」已經是${set.is_active ? "上架" : "下架"}，不需要再改。`,
      });
    }
    const changes = { is_active: { before: set.is_active, after: args.is_active } };
    if (args.dry_run) {
      return preview(
        tool,
        "inv_combo_set",
        args.id,
        args.is_active ? "activate" : "deactivate",
        {
          id: args.id,
          name: set.name,
          changes,
          ...(args.is_active && set.approval_status !== "approved"
            ? { warning: `上架了也還不能賣：「${set.name}」審核狀態是 ${set.approval_status}。` }
            : {}),
        },
        { changes },
      );
    }
    const { setComboSetActive } = await import("@/server/repos/inv-combos");
    const res = await commitOrAudit(
      tool,
      "inv_combo_set",
      args.id,
      args.is_active ? "activate" : "deactivate",
      { changes },
      () => setComboSetActive({ id: args.id, isActive: args.is_active }),
    );
    return committed(
      tool,
      "inv_combo_set",
      args.id,
      args.is_active ? "activate" : "deactivate",
      { written: true, result: res },
      { changes, result: res },
    );
  },

  async resubmit_combo_set(args) {
    const tool = "resubmit_combo_set";
    await oauthUserId(tool);
    const set = await loadComboOrThrow(args.id);
    if (set.approval_status !== "rejected") {
      return jsonText({
        id: args.id,
        dry_run: args.dry_run,
        written: false,
        status: set.approval_status,
        message: `「${set.name}」目前是「${set.approval_status}」，只有被退回（rejected）的套餐可以重新送審。`,
      });
    }
    const changes = { approval_status: { before: "rejected", after: "pending" } };
    if (args.dry_run) {
      return preview(
        tool,
        "inv_combo_set",
        args.id,
        "resubmit",
        { id: args.id, name: set.name, changes },
        { changes },
      );
    }
    const { resubmitComboSet } = await import("@/server/repos/inv-combos");
    const res = await commitOrAudit(tool, "inv_combo_set", args.id, "resubmit", { changes }, () =>
      resubmitComboSet(args.id),
    );
    return committed(
      tool,
      "inv_combo_set",
      args.id,
      "resubmit",
      {
        written: true,
        result: res,
        next_step: "已變回待審：用 approve_inventory_record（module=combo_sets）核准。",
      },
      { changes, result: res },
    );
  },

  /* ============================================================ 在庫異動 */

  async list_stock_adjustments(args) {
    const { listAdminAdjustments } = await import("@/server/repos/inv-adjustments");
    const { rows, total } = await listAdminAdjustments({
      keyword: args.keyword ?? null,
      category: args.category ?? null,
      status: args.status,
      productId: args.product_id ?? null,
      dateFrom: args.date_from ?? null,
      dateTo: args.date_to ?? null,
      sort: args.sort,
      page: args.page - 1,
      pageSize: args.limit,
    });
    return jsonText({
      total,
      page: args.page,
      limit: args.limit,
      has_more: (args.page - 1) * args.limit + rows.length < total,
      rows: rows.map((r) => ({
        id: r.adjustment_id,
        adjustment_number: r.adjustment_number,
        adjustment_date: r.adjustment_date,
        product_id: r.product_id,
        product_name: r.product_name,
        issue_number: r.issue_number,
        category: r.category,
        quantity: r.quantity,
        status: r.status,
        reason: r.reason,
        notes: r.notes,
        product_stock_quantity: r.product_stock_quantity,
        reversal_of_number: r.reversal_of_number,
        reversed_by_number: r.reversed_by_number,
        creator_name: r.creator_name,
        approved_by_name: r.approved_by_name,
        created_at: r.created_at,
      })),
      note: "draft 用 submit_stock_adjustment 送出；pending_approval 用 approve_inventory_record（module=stock_adjustments）核准；rejected 用 submit_stock_adjustment 重新送審。",
    });
  },

  async get_stock_adjustment(args) {
    const { getAdminAdjustment } = await import("@/server/repos/inv-adjustments");
    const a = await getAdminAdjustment(args.id);
    if (!a) notFound("在庫異動單", args.id);
    const { user_id: _u, ...rest } = a;
    return jsonText({ adjustment: rest });
  },

  async submit_stock_adjustment(args) {
    const tool = "submit_stock_adjustment";
    const userId = await oauthUserId(tool);
    const { getAdminAdjustment } = await import("@/server/repos/inv-adjustments");
    const a = await getAdminAdjustment(args.id);
    if (!a) notFound("在庫異動單", args.id);
    const label = a.adjustment_number ?? a.product_name ?? args.id;
    if (a.status !== "draft" && a.status !== "rejected") {
      return jsonText({
        id: args.id,
        dry_run: args.dry_run,
        written: false,
        status: a.status,
        message: `${label} 目前是「${a.status}」，只有草稿（draft）可以送出、被退回（rejected）可以重新送審。`,
      });
    }
    const resubmit = a.status === "rejected";
    const approval = await needsApproval("stock_adjustments");
    const after = resubmit ? "pending_approval" : approval ? "pending_approval" : "confirmed";
    const action = resubmit ? "resubmit" : "submit";
    const changes = { status: { before: a.status, after } };
    const target = {
      adjustment_number: a.adjustment_number,
      product_id: a.product_id,
      product_name: a.product_name,
      category: a.category,
      quantity: a.quantity,
      reason: a.reason,
      stock_now: a.product_stock_quantity,
      effect:
        after === "confirmed"
          ? `不需審核：送出後庫存立刻 ${a.quantity > 0 ? "+" : ""}${a.quantity}`
          : "送出後進待審，核准（approve_inventory_record）後庫存才會變動。",
    };
    if (args.dry_run) {
      return preview(
        tool,
        "inv_stock_adjustment",
        args.id,
        action,
        { id: args.id, target, changes },
        { changes },
      );
    }
    const repo = await import("@/server/repos/inv-adjustments");
    const res = await commitOrAudit(
      tool,
      "inv_stock_adjustment",
      args.id,
      action,
      { changes },
      () =>
        resubmit
          ? repo.resubmitAdjustment(args.id)
          : repo.submitAdjustment({ userId, id: args.id }),
    );
    return committed(
      tool,
      "inv_stock_adjustment",
      args.id,
      action,
      {
        id: args.id,
        written: res.changed,
        result: res,
        ...(res.changed
          ? {}
          : {
              message: `資料庫回報沒有變更：可能剛剛已經有人處理過（目前：${res.previous_status}）。`,
            }),
      },
      { changes, result: res },
    );
  },

  /* ============================================================ 賣超告警 */

  async resolve_stock_alert(args) {
    const tool = "resolve_stock_alert";
    const userId = await oauthUserId(tool);
    const { resolveAlertSchema } = await import("@/lib/admin/schemas");
    const data = validateWith(resolveAlertSchema, { alert_id: args.alert_id, note: args.note });
    const { supabaseAdmin } = await import("@/server/supabase-admin");
    // 只讀後台告警頁那一支 view 的幾個欄位（不讀客人個資以外的東西也不寫）。
    const { data: row, error } = await supabaseAdmin()
      .from("inv_stock_alerts")
      .select(
        "alert_id, created_at, source, shortfall, inv_product_id, product_name, current_stock, sale_id, order_id, resolved_at, resolution_note",
      )
      .eq("alert_id", data.alert_id)
      .maybeSingle();
    if (error) throw new Error(`賣超告警讀取失敗：${error.code ?? error.message}`);
    if (!row) notFound("賣超告警", data.alert_id);
    const alert = row as unknown as {
      alert_id: number;
      product_name: string;
      shortfall: number;
      current_stock: number;
      resolved_at: string | null;
      resolution_note: string | null;
    };
    if (alert.resolved_at) {
      return jsonText({
        alert_id: data.alert_id,
        dry_run: args.dry_run,
        written: false,
        message: "這筆告警已經有人處理過了，不會蓋掉前一位的說明。",
        resolved_at: alert.resolved_at,
        resolution_note: alert.resolution_note,
      });
    }
    const changes = {
      resolved: { before: false, after: true },
      resolution_note: { before: null, after: data.note },
    };
    const id = String(data.alert_id);
    if (args.dry_run) {
      return preview(tool, "stock_oversold_alert", id, "resolve", { alert, changes }, { changes });
    }
    const { resolveStockAlert } = await import("@/server/repos/inv-sales");
    const res = await commitOrAudit(tool, "stock_oversold_alert", id, "resolve", { changes }, () =>
      resolveStockAlert({ alertId: data.alert_id, userId, note: data.note }),
    );
    return committed(
      tool,
      "stock_oversold_alert",
      id,
      "resolve",
      {
        alert_id: data.alert_id,
        written: res.resolved,
        ...(res.resolved ? {} : { message: "資料庫回報沒有變更：剛剛已經有人處理過。" }),
      },
      { changes, result: res },
    );
  },
};

/* ------------------------------------------------------------------ 匯出 */

/** 先用自己的 schema 再驗一次；輸入錯誤與 repo 例外一律回 isError 文字。 */
function wrap<N extends PosStockToolName>(name: N): (args: unknown) => Promise<TextResult> {
  const schema = POS_STOCK_TOOL_INPUTS[name] as unknown as {
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
      console.error(`[mcp/pos-stock] ${name} 失敗`, err instanceof Error ? err.message : err);
      return errText(`執行失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export const POS_STOCK_HANDLERS = Object.fromEntries(
  (Object.keys(POS_STOCK_TOOL_INPUTS) as PosStockToolName[]).map((n) => [n, wrap(n)]),
) as { [N in PosStockToolName]: (args: Args<N> | unknown) => Promise<TextResult> };
