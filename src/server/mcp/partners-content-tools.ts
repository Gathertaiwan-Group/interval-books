/**
 * MCP 工具 —— 選品、廠商、推薦人、聯絡電話（2026-11-15，業主要全程用手機透過 MCP 操作）。
 *
 * ── 一條規矩：寫入只走後台已經在用的那一支 ───────────────────────────────
 * 每一支寫入都呼叫 src/lib/admin/fns/* 背後那一支 repo 函式（src/server/repos/*），驗證用
 * 後台**同一份** zod 規則：
 *   · 選品主題／品項／排序 = fns/curated.ts（curatedThemeSchema、curatedItemSchema、
 *     admin_reorder_curated_items RPC）；品項連結商品的「只能連書籍／選物」規則照抄
 *     upsertCuratedItem 的伺服器端檢查（同一支 getProductById＋isCuratedLinkableType）。
 *   · 廠商送審商品 = fns/inv-vendors.ts#approveVendorSubmission（inv_approve_vendor_product）。
 *   · 廠商主檔 = saveVendor（inv_save_vendor）；廠商核准 = approveVendor（inv_approve_record
 *     的 'vendors'）；聯絡窗口 = saveVendorContact（inv_save_vendor_contact）。
 *   · 推薦人／分潤設定 = fns/referrals.ts（規則在 src/lib/admin/referral-schemas.ts，兩邊共用）。
 *   · 聯絡電話 = fns/contact-phones.ts（contactPhoneSchema）。
 * 這個檔案**沒有任何一句自己寫的 update／insert／delete／rpc**（自檢守著）。
 *
 * ── 慣例（照 ops-write-tools.ts）────────────────────────────────────────────
 * 寫入一律 dry_run 預設 true；會建立新列的工具 dry_run=false 必帶 idempotency_key（先佔用再寫）；
 * 預覽與寫入都記 mcp_audit_log；寫入一律要 OAuth 管理員身分（靜態 token 拒絕）。
 *
 * ── 權限 ──────────────────────────────────────────────────────────────────
 * 後台：選品、推廣、電話 = adminFnMiddleware；廠商 = staffFnMiddleware，核准廠商要
 * approve_vendors、核准送審商品要 approve_products。MCP 的 OAuth 連線只發給管理員，而且
 * http.ts 每次請求都重查 profiles.role = 'admin'；管理員在 src/server/auth.ts#loadStaffPermissions
 * 一律具備全部細權限（照 inv.has_permission() 的第一句）。所以「OAuth 管理員」就是與後台相同的
 * 權限檢查；靜態 token 沒有使用者 → 一律拒絕。
 *
 * ── 廠商的敏感欄位：一個都不碰 ───────────────────────────────────────────
 * 敏感的分類照後台 readVendorSensitive（VENDOR_SENSITIVE_FIELDS）：統一編號、身分證字號、
 * 國外識別碼、居留證號碼、匯款帳戶。**統編也算敏感**（它在那份清單裡，後台看完整統編也要
 * inv.vendor.pii.read 並留 pii_access_log）。所以：
 *   · 輸入沒有這些欄位，回傳也不回（連遮罩版本都不回，與 get_vendor 相同）。
 *   · inv_save_vendor() 的 UPDATE 會把四個識別碼整欄覆寫，後台編輯表單因此規定「已有號碼的
 *     廠商要先按『更改』重新輸入完整號碼才能存」。MCP 不經手號碼，所以**已存有任何識別碼的
 *     廠商不能用 MCP 改**（會被洗掉），update_vendor 直接拒絕並請業主到後台改。
 *   · 新增只能建「國內個人」且不填身分證（0061 起選填）——國內公司要統編、國外要識別碼，
 *     那些都是敏感欄位，MCP 不收。
 *   · 匯款帳戶、附件、廠商入口帳號啟停、刪除廠商：不開放。
 *   · 財務條件（付款條件、結算日、手續費率、抽成、寄售）不開放修改：沿用原值（新增用後台預設值）。
 *
 * ── 不做的東西 ─────────────────────────────────────────────────────────────
 * 刪除（選品主題／品項、聯絡電話、廠商與子表）、推廣月結結算（settleReferralAdmin）。
 *
 * ── 稽核與個資 ─────────────────────────────────────────────────────────────
 * 廠商聯絡窗口、推薦人的電話／Email 屬個資：前後值存進 mcp_audit_log，但用 changes._log_redact
 * 讓伺服器 log 只印欄位名（audit.ts）。
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
  jsonText,
  McpInputError,
  stableStringify,
  writeTimeNote,
  zodIssuesText,
  type LocalizedArg,
  type TextResult,
  type Translator,
} from "./core";
import { VENDOR_STATUSES } from "@/lib/admin/schemas";

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
      `${what}。三語欄位：可以只給中文字串（英日文會自動翻譯補上），或給 {"zh":…,"en":…,"ja":…}；只給其中一個語言時，缺的那個會自動翻譯。`,
    );
}

/** 可清空的短文字：null＝清空；不送＝不動。 */
const optText = (max: number, what: string) =>
  z.string().trim().max(max).nullable().optional().describe(`${what}（null＝清空；不送＝不動）`);

/* ------------------------------------------------------------------ 廠商可改欄位 */

/** MCP 開放的廠商欄位（非敏感）。其餘欄位一律沿用原值。 */
const VENDOR_TEXT_FIELDS = [
  "name",
  "name_en",
  "short_name",
  "representative",
  "phone",
  "fax",
  "email",
  "address",
  "address_en",
  "invoice_address",
  "notes",
] as const;
const VENDOR_EDITABLE = [...VENDOR_TEXT_FIELDS, "category_id", "is_preferred", "status"] as const;
/** 回傳／稽核裡屬於個資、只進稽核表不進伺服器 log 的欄位。 */
const SENSITIVE_IDENTIFIERS = [
  "tax_id",
  "id_number",
  "foreign_id",
  "residence_permit_number",
] as const;
const IDENTIFIER_LABELS: Record<(typeof SENSITIVE_IDENTIFIERS)[number], string> = {
  tax_id: "統一編號",
  id_number: "身分證字號",
  foreign_id: "國外識別碼",
  residence_permit_number: "居留證號碼",
};

const vendorFieldArgs = {
  name_en: optText(200, "英文名稱"),
  short_name: optText(100, "簡稱"),
  representative: optText(100, "負責人"),
  phone: optText(50, "電話"),
  fax: optText(50, "傳真"),
  email: optText(200, "Email"),
  address: optText(500, "地址"),
  address_en: optText(500, "英文地址"),
  invoice_address: optText(500, "發票地址"),
  notes: optText(2000, "備註"),
  category_id: z
    .string()
    .trim()
    .uuid()
    .nullable()
    .optional()
    .describe("廠商分類 id（null＝不分類；不送＝不動）"),
  is_preferred: z.boolean().optional().describe("是否為優先廠商"),
  status: z
    .enum(VENDOR_STATUSES)
    .optional()
    .describe("往來狀態：active 往來中／suspended 暫停往來／inactive 已終止（與審核狀態無關）"),
};

const contactFieldArgs = {
  job_title: optText(100, "職稱"),
  phone: optText(50, "市話"),
  mobile: optText(50, "手機"),
  email: optText(200, "Email"),
  notes: optText(500, "備註"),
  is_primary: z.boolean().optional().describe("是否為主要聯絡人"),
  is_finance_contact: z.boolean().optional().describe("是否為帳務聯絡人"),
  sort_order: z.number().int().min(0).max(999).optional().describe("排序（小的在前）"),
};

/* ------------------------------------------------------------------ 推廣 arg */

const tiersArg = z
  .array(
    z.object({
      up_to: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe("這一級的業績上限（元）；最後一級填 null（不設上限）"),
      rate: z.number().min(0).max(100).describe("這一級的分潤比例（%）"),
    }),
  )
  .min(1)
  .max(10)
  .describe("分潤級距（由小到大，最後一級 up_to=null）");

const referrerFieldArgs = {
  kind: z.enum(["team", "external"]).optional().describe("team 團隊成員／external 外部推廣者"),
  contact: optText(200, "聯絡方式（LINE 等）"),
  email: optText(120, "Email"),
  phone: optText(30, "電話"),
  base_salary: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe("底薪（元，團隊成員用；null＝無）"),
  discount_percent: z
    .number()
    .min(0)
    .max(50)
    .nullable()
    .optional()
    .describe("客人用這個推薦碼的折扣 %（null＝用全站預設）"),
  commission_tiers: tiersArg
    .nullable()
    .optional()
    .describe("這位推廣者自己的分潤級距（null＝用全站預設級距）"),
  active: z.boolean().optional().describe("是否啟用（停用後推薦碼結帳無效）"),
  note: optText(500, "備註"),
};

/* ------------------------------------------------------------------ 輸入 schema */

export const PARTNERS_CONTENT_TOOL_INPUTS = {
  /* ---- 選品 ---- */
  create_curated_theme: z.object({
    title: localizedArg("主題名稱"),
    description: localizedArg("主題說明"),
    is_published: z.boolean().default(false).describe("是否公開（預設 false＝不公開）"),
    sort_order: z
      .number()
      .int()
      .optional()
      .describe("主題排序（小的在前）。省略＝排在最後（與後台新增主題相同）"),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
  update_curated_theme: z.object({
    id: z.string().trim().min(1).max(200).describe("選品主題 id（見 list_curated）"),
    title: localizedArg("主題名稱").optional(),
    description: localizedArg("主題說明").optional(),
    is_published: z.boolean().optional().describe("是否公開"),
    sort_order: z
      .number()
      .int()
      .optional()
      .describe("主題排序（小的在前；改主題順序就是改這個數字，與後台主題表單同一欄）"),
    dry_run: dryRunArg,
  }),
  create_curated_item: z.object({
    theme_id: z.string().trim().min(1).max(200).describe("放在哪個主題底下（見 list_curated）"),
    name: localizedArg("選品名稱"),
    note: localizedArg("主理人短評"),
    product_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .optional()
      .describe(
        "連結的商品 id（只能是書籍或選物，見 list_shop_products）。⚠️ 前台只顯示有連結商品的選品；不連結＝只存在後台。",
      ),
    is_published: z.boolean().default(false).describe("是否公開（預設 false）"),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
  update_curated_item: z.object({
    id: z.number().int().positive().describe("選品品項 id（數字，見 list_curated）"),
    name: localizedArg("選品名稱").optional(),
    note: localizedArg("主理人短評").optional(),
    product_id: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .optional()
      .describe("連結的商品 id（只能是書籍或選物）；null＝解除連結（前台就不顯示了）；不送＝不動"),
    is_published: z.boolean().optional().describe("是否公開"),
    dry_run: dryRunArg,
  }),
  reorder_curated_items: z.object({
    theme_id: z.string().trim().min(1).max(200).describe("主題 id（見 list_curated）"),
    item_ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(500)
      .describe("這個主題底下**全部**品項 id，照想要的順序排（第一個顯示在最前面）"),
    dry_run: dryRunArg,
  }),

  /* ---- 廠商送審商品 ---- */
  list_vendor_submissions: z.object({
    status: z
      .enum(["pending", "approved", "rejected", "all"])
      .default("pending")
      .describe("pending 待審（預設）／approved 已核准／rejected 已退回／all 全部"),
    limit: z.number().int().min(1).max(100).default(50).describe("最多列幾筆（預設 50）"),
  }),
  approve_vendor_submission: z
    .object({
      id: uuidArg("送審商品的 id（見 list_vendor_submissions）"),
      decision: z.enum(["approve", "reject"]).describe("approve 核准／reject 退回"),
      listing: z
        .object({
          slug: z.string().trim().min(1).max(100).describe("網址代稱（小寫英數字與連字號）"),
          product_type: z
            .enum(["goods", "book"])
            .default("goods")
            .describe("goods 選物／book 書籍"),
          title: localizedArg("商品名稱"),
          summary: localizedArg("摘要"),
          description: localizedArg("商品介紹"),
          price: z.number().int().min(0).describe("定價（元）"),
          units_per_sale: z
            .number()
            .int()
            .min(1)
            .max(999)
            .default(1)
            .describe("每賣一件扣幾個庫存單位（預設 1）"),
          status: z
            .enum(["draft", "active"])
            .default("draft")
            .describe("draft 草稿（預設）／active 立即上架"),
        })
        .optional()
        .describe(
          "給了＝「核准並上架」：同一個交易建網站商品（圖片沿用廠商上傳的）。只能配 decision=approve。",
        ),
      idempotency_key: idempotencyKeyArg,
      dry_run: dryRunArg,
    })
    .refine((v) => !v.listing || v.decision === "approve", "退回時不能同時上架（listing）"),

  /* ---- 廠商 ---- */
  create_vendor: z.object({
    name: z.string().trim().min(1).max(200).describe("廠商（個人戶）名稱"),
    ...vendorFieldArgs,
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
  update_vendor: z.object({
    vendor_id: uuidArg("廠商 vendor_id（見 list_vendors）"),
    name: z.string().trim().min(1).max(200).optional().describe("廠商名稱"),
    ...vendorFieldArgs,
    dry_run: dryRunArg,
  }),
  approve_vendor: z.object({
    vendor_id: uuidArg("待審廠商的 vendor_id（見 list_vendors，approval_status=pending）"),
    decision: z.enum(["approve", "reject"]).describe("approve 核准往來／reject 退回"),
    dry_run: dryRunArg,
  }),
  list_vendor_contacts: z.object({
    vendor_id: uuidArg("廠商 vendor_id（見 list_vendors）"),
  }),
  save_vendor_contact: z.object({
    vendor_id: uuidArg("廠商 vendor_id（見 list_vendors）"),
    contact_id: z
      .string()
      .trim()
      .uuid()
      .optional()
      .describe("要修改的聯絡窗口 id（見 list_vendor_contacts）；省略＝新增一位"),
    name: z.string().trim().min(1).max(100).optional().describe("聯絡人姓名（新增時必填）"),
    ...contactFieldArgs,
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),

  /* ---- 推廣 ---- */
  get_referral_settings: z.object({}),
  create_referrer: z.object({
    name: z.string().trim().min(1).max(60).describe("推廣者名稱"),
    code: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .describe("推薦碼（2–20 個英文字母或數字，自動轉大寫、去空白）"),
    ...referrerFieldArgs,
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
  update_referrer: z.object({
    id: uuidArg("推廣者 id（見 list_referrers／get_referral_settings）"),
    name: z.string().trim().min(1).max(60).optional().describe("推廣者名稱"),
    code: z.string().trim().min(2).max(40).optional().describe("推薦碼（改了舊的碼就失效）"),
    ...referrerFieldArgs,
    dry_run: dryRunArg,
  }),
  update_referral_settings: z.object({
    default_discount_percent: z
      .number()
      .min(0)
      .max(50)
      .optional()
      .describe("推薦碼預設折扣 %（0–50）"),
    default_margin_percent: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("查不到成本時假設的毛利 %（0–100）"),
    commission_tiers: tiersArg.optional().describe("全站預設分潤級距"),
    new_customer_multiplier: z
      .number()
      .min(1)
      .max(3)
      .optional()
      .describe("新客業績加權倍數（1–3）"),
    team_pool_baseline: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("團隊獎金池門檻（元；null＝不計算團隊獎金池）"),
    team_pool_percent: z.number().min(0).max(50).optional().describe("團隊獎金池比例 %（0–50）"),
    team_pool_equal_percent: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("獎金池平均分配的部分 %（0–100）"),
    payout_cap_percent: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("分潤上限（占毛利 %，0–100）"),
    clawback_days: z.number().int().min(0).max(365).optional().describe("退貨追回天數（0–365）"),
    dry_run: dryRunArg,
  }),

  /* ---- 聯絡電話 ---- */
  list_contact_phones: z.object({}),
  create_contact_phone: z.object({
    label: z.string().trim().min(1).max(100).describe("標籤，例如「門市」"),
    display_text: z.string().trim().min(1).max(100).describe("網站上顯示的文字，例如 02-2345-6789"),
    tel: z.string().trim().min(1).max(40).describe("撥號用號碼，例如 +886223456789"),
    sort_order: z.number().int().optional().describe("排序（小的在前）；省略＝排在最後"),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
  update_contact_phone: z.object({
    id: z.number().int().positive().describe("聯絡電話 id（見 list_contact_phones）"),
    label: z.string().trim().min(1).max(100).optional().describe("標籤"),
    display_text: z.string().trim().min(1).max(100).optional().describe("顯示文字"),
    tel: z.string().trim().min(1).max(40).optional().describe("撥號用號碼"),
    sort_order: z.number().int().optional().describe("排序（小的在前）"),
    dry_run: dryRunArg,
  }),
} as const;

export type PartnersContentToolName = keyof typeof PARTNERS_CONTENT_TOOL_INPUTS;
type Args<N extends PartnersContentToolName> = z.output<(typeof PARTNERS_CONTENT_TOOL_INPUTS)[N]>;

/* ------------------------------------------------------------------ 說明 */

const PREVIEW = "預設 dry_run=true 只預覽；dry_run=false 才寫入。預覽與寫入都會記稽核。";
const OAUTH = "需要 OAuth 管理員身分（靜態 token 會被拒絕）。";
const CURATED_NOTE =
  "⚠️ 前台目前只顯示「有連結商品（product_id）且公開」的選品，沒連結商品的品項只存在後台。";

export const PARTNERS_CONTENT_TOOL_META: Record<
  PartnersContentToolName,
  { title: string; description: string; annotations: ToolAnnotations }
> = {
  create_curated_theme: {
    title: "新增選品主題",
    description:
      "與後台 /admin/products/curated-themes「新增主題」同一支（fns/curated.ts#upsertCuratedTheme，同一份 curatedThemeSchema）。" +
      "排序省略時排在最後。" +
      CURATED_NOTE +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
  update_curated_theme: {
    title: "修改選品主題（含主題排序）",
    description:
      "與後台選品主題頁的「編輯主題」同一支（upsertCuratedTheme）。只送要改的欄位；主題的先後順序就是 sort_order。" +
      "不能刪除主題（請到後台）。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  create_curated_item: {
    title: "新增主理人選品",
    description:
      "與後台 /admin/products/curated/new 同一支（upsertCuratedItem，同一份 curatedItemSchema）。" +
      "排序自動排在該主題最後（與後台相同），要調整用 reorder_curated_items。" +
      "連結商品只能是書籍或選物（活動／策旅票券不行，伺服器端同一條檢查）。" +
      CURATED_NOTE +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
  update_curated_item: {
    title: "修改主理人選品",
    description:
      "與後台選品編輯頁的「儲存」同一支（upsertCuratedItem）。只送要改的欄位；不能換主題、不能改排序（排序用 reorder_curated_items），與後台編輯頁相同。" +
      CURATED_NOTE +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  reorder_curated_items: {
    title: "調整選品順序",
    description:
      "與後台選品主題頁的上下箭頭同一支 RPC（admin_reorder_curated_items，一個交易重排，不會撞 unique(theme_id, sort_order)）。" +
      "item_ids 要列出該主題底下全部品項，照新的順序。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  list_vendor_submissions: {
    title: "廠商送審的商品",
    description:
      "與後台 /admin/inventory-vendors「廠商送審」佇列同一支查詢（inv_admin_vendor_submissions，只有廠商入口送來的商品）。" +
      "拿到 id 後用 approve_vendor_submission 核准或退回。唯讀。",
    annotations: READ_ONLY,
  },
  approve_vendor_submission: {
    title: "核准／退回廠商送審的商品（可同時上架）",
    description:
      "與後台「廠商送審」的「核准」「核准並上架」「退回」三顆按鈕同一支（fns/inv-vendors.ts#approveVendorSubmission → inv_approve_vendor_product）。" +
      "給 listing＝核准並上架：同一個資料庫交易建網站商品（三語文案、網址代稱、定價；圖片沿用廠商上傳的），此時 dry_run=false 必帶 idempotency_key。" +
      "只動待審的那一筆，已處理過的回 written=false。後台需要 approve_products 權限；MCP 的 OAuth 連線只發給管理員（管理員具備全部審核權限）。" +
      "同一位管理員可以核准自己建立的資料（業主決定不做職責分離，與後台相同）；核准前請先用 dry_run 預覽，把要核准的內容給使用者看過再送出。" +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
  create_vendor: {
    title: "新增廠商（國內個人戶）",
    description:
      "與後台 /admin/inventory-vendors/new「新增廠商」同一支 RPC（inv_save_vendor，同一份 vendorSchema）。" +
      "MCP 只收非敏感欄位：名稱、負責人、電話、傳真、Email、地址、備註、分類、優先廠商、往來狀態。" +
      "統一編號、身分證字號、國外識別碼、居留證、匯款帳戶、附件一律不經 MCP（統編與身分證屬後台『查看廠商敏感資料』的範圍），" +
      "所以只能建「國內個人」且不填身分證（0061 起選填）；國內公司（要統編）或國外廠商請到後台新增。" +
      "財務條件用後台的預設值。新廠商是否要審核由資料庫的審核設定決定，需要審核時用 approve_vendor。" +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
  update_vendor: {
    title: "修改廠商基本資料（非敏感欄位）",
    description:
      "與後台廠商編輯頁的「儲存」同一支 RPC（inv_save_vendor）。只能改名稱、負責人、電話、傳真、Email、地址、備註、分類、優先廠商、往來狀態；" +
      "財務條件與識別碼沿用原值、不能改。" +
      "⚠️ 已存有統編／身分證／國外識別碼／居留證的廠商不能用 MCP 改：這支 RPC 會整欄覆寫識別碼，後台也規定要先重新輸入完整號碼才能存，而 MCP 不經手號碼——這類廠商請到後台修改。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  approve_vendor: {
    title: "核准／退回待審的廠商",
    description:
      "與後台廠商清單的「核准」「退回」按鈕同一支（fns/inv-vendors.ts#approveVendor → inv_approve_record 'vendors'）。" +
      "只動待審（pending）的那一筆。後台需要 approve_vendors 權限；MCP 的 OAuth 連線只發給管理員（管理員具備全部審核權限）。" +
      "同一位管理員可以核准自己建立的資料（業主決定不做職責分離，與後台相同）；核准前請先用 dry_run 預覽，把要核准的內容給使用者看過再送出。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  list_vendor_contacts: {
    title: "廠商聯絡窗口",
    description:
      "與後台廠商詳情頁「聯絡人」分頁同一支查詢（inv_admin_vendor_contacts）。含聯絡人姓名、電話、Email，只在回答需要時引用。唯讀。",
    annotations: READ_ONLY,
  },
  save_vendor_contact: {
    title: "新增／修改廠商聯絡窗口",
    description:
      "與後台廠商編輯頁「聯絡人」分頁的儲存同一支 RPC（inv_save_vendor_contact，同一份 vendorContactSchema）。" +
      "給 contact_id＝修改那一位（只送要改的欄位）；省略＝新增一位（name 必填，dry_run=false 必帶 idempotency_key）。不能刪除。" +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
  get_referral_settings: {
    title: "分潤設定與推廣者完整設定",
    description:
      "與後台 /admin/referrals 同一支查詢：全站分潤設定（預設折扣、分潤級距、新客倍數、團隊獎金池、上限、追回天數）＋每位推廣者的完整設定（含聯絡方式、底薪、個人級距）。" +
      "業績與月結用 get_referral_report。唯讀。",
    annotations: READ_ONLY,
  },
  create_referrer: {
    title: "新增推廣者（推薦碼）",
    description:
      "與後台 /admin/referrals/new 同一支（createReferrer，同一份 referrerSchema）。推薦碼不可重複。" +
      "折扣與級距不填＝用全站預設。不做月結結算（請到後台）。" +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
  update_referrer: {
    title: "修改推廣者／個人分潤比例",
    description:
      "與後台推廣者編輯頁的「儲存」同一支（updateReferrer，同一份 referrerSchema）。只送要改的欄位；可改推薦碼、折扣、個人分潤級距、啟用與否。" +
      "已結算的月份不受影響；不做月結結算（請到後台）。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  update_referral_settings: {
    title: "修改全站分潤設定",
    description:
      "與後台 /admin/referrals「分潤設定」的儲存同一支（updateReferralSettings，同一份規則）。只送要改的欄位，其餘沿用目前設定。" +
      "影響之後計算的月報；已結算的月份用當時的快照，不受影響。不做月結結算。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  list_contact_phones: {
    title: "網站聯絡電話",
    description:
      "與後台 /admin/phones 同一支查詢：網站上顯示的聯絡電話（標籤、顯示文字、撥號號碼、排序）。唯讀。",
    annotations: READ_ONLY,
  },
  create_contact_phone: {
    title: "新增網站聯絡電話",
    description:
      "與後台 /admin/phones「新增」同一支（upsertContactPhone，同一份 contactPhoneSchema）。排序省略＝排在最後（與後台相同）。不能刪除。" +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
  update_contact_phone: {
    title: "修改網站聯絡電話",
    description:
      "與後台 /admin/phones「編輯」同一支（upsertContactPhone）。只送要改的欄位。不能刪除。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
};

/* ------------------------------------------------------------------ 小工具 */

const NEXT_STEP = "這只是預覽，還沒有寫入。確認無誤後，用同樣的參數加上 dry_run=false 再呼叫一次。";

function notFound(what: string, id: string | number): never {
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
 * 翻譯函式沿用 tools.ts#translator（scripts/translate-selftest.mjs 守著「只有 tools.ts 這支 MCP
 * 檔案 import @/server/translate」）。呼叫時才 dynamic import，避免與 tools.ts 互相載入。
 */
async function translator(): Promise<Translator | null> {
  const { translator: shared } = await import("./tools");
  return shared();
}

/** 三語補齊：三種語言都給了就不碰翻譯。 */
async function fillL(field: string, arg: LocalizedArg) {
  const complete =
    typeof arg === "object" && Boolean(arg.zh?.trim() && arg.en?.trim() && arg.ja?.trim());
  return fillLocalized(field, arg, complete ? null : await translator());
}

/** fillL 結果裡「是自動翻譯補的」那幾欄的名字。 */
function translatedNames(rs: Record<string, { translated: boolean }>): string[] {
  return Object.entries(rs)
    .filter(([, r]) => r.translated)
    .map(([k]) => k);
}

/** 修改類：有送的三語欄位補齊（沒送＝不動），回補好的值與哪幾欄是自動翻譯。 */
async function fillSome(
  fields: Record<string, LocalizedArg | undefined>,
): Promise<{ values: Record<string, unknown>; translated: string[] }> {
  const values: Record<string, unknown> = {};
  const translated: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const r = await fillL(k, v);
    values[k] = r.value;
    if (r.translated) translated.push(k);
  }
  return { values, translated };
}

/** 修改類預覽：有自動翻譯才附 confirm_args（沒有翻譯＝原參數就已經是定案值）。 */
function lockedPreview(
  args: Record<string, unknown>,
  filled: { values: Record<string, unknown>; translated: string[] },
): Record<string, unknown> {
  if (!filled.translated.length) return {};
  return { confirm_args: confirmArgs(args, filled.values), next_step: CONFIRM_ARGS_NEXT_STEP };
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

function noChange(tool: string, entityId: string | number, dryRun: boolean): TextResult {
  return jsonText({
    tool,
    id: entityId,
    dry_run: dryRun,
    written: false,
    message: "沒有任何欄位改變，不需要寫入。",
  });
}

/** 寫入一律要 OAuth 管理員（後台的 adminFn／staffFn＋細權限，對管理員都成立）。 */
async function oauthUserId(tool: string): Promise<string> {
  const { currentMcpActor } = await import("./actor");
  const actor = currentMcpActor();
  if (actor?.via === "oauth") return actor.user_id;
  throw new McpInputError(
    `${tool} 需要 OAuth 管理員身分：後台這個動作只開放給登入的管理員（廠商審核還要審核權限），` +
      "靜態 token 沒有對應的使用者。請改用 claude.ai／ChatGPT 連接器（OAuth）登入的連線。",
  );
}

/** dry_run=false 的建立動作：idempotency_key 必填並先佔用（同 ops-write-tools.ts）。 */
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

/** 預覽時給一組新的 key（呼叫端有給就沿用）。 */
async function previewKey(given: string | undefined): Promise<string> {
  if (given) return given;
  const { randomUUID } = await import("node:crypto");
  return randomUUID();
}

/** 只把有送的欄位套上去（undefined＝不動）。 */
function applyDefined<T extends Record<string, unknown>>(
  base: T,
  patch: Record<string, unknown>,
  keys: readonly string[],
): T {
  const next: Record<string, unknown> = { ...base };
  for (const k of keys) if (patch[k] !== undefined) next[k] = patch[k];
  return next as T;
}

/* ---- 選品 ---- */

async function linkCheck(productId: string | null | undefined) {
  if (!productId) return null;
  // 與 fns/curated.ts#upsertCuratedItem 同一條伺服器端規則。
  const { getProductById } = await import("@/server/repos/products");
  const { isCuratedLinkableType } = await import("@/lib/admin/unified-products");
  const product = await getProductById(productId);
  if (!product) throw new McpInputError("找不到要連結的商品，可能已被刪除。");
  if (!isCuratedLinkableType(product.product_type)) {
    throw new McpInputError("選品只能連結書籍或一般商品，不能連結活動／策旅票券。");
  }
  return {
    id: product.id,
    product_type: product.product_type,
    title: (product.title as { zh?: string } | null)?.zh ?? null,
    status: product.status,
  };
}

/* ---- 廠商 ---- */

type VendorDetail = import("@/server/repos/inv-vendors").AdminVendorDetail;

/** 回傳用：識別碼連遮罩都不回（同 get_vendor），只回有沒有填。 */
function vendorPublic(detail: VendorDetail) {
  const out: Record<string, unknown> = {};
  for (const k of [
    "vendor_id",
    "vendor_code",
    "entity_type",
    "approval_status",
    ...VENDOR_EDITABLE,
  ] as const) {
    out[k] = (detail as unknown as Record<string, unknown>)[k] ?? null;
  }
  return out;
}

function storedIdentifiers(detail: VendorDetail): string[] {
  const masks: Record<(typeof SENSITIVE_IDENTIFIERS)[number], string | null> = {
    tax_id: detail.tax_id_masked,
    id_number: detail.id_number_masked,
    foreign_id: detail.foreign_id_masked,
    residence_permit_number: detail.residence_permit_number_masked,
  };
  return SENSITIVE_IDENTIFIERS.filter((k) => masks[k] !== null && masks[k] !== "").map(
    (k) => IDENTIFIER_LABELS[k],
  );
}

/** payload 裡四個識別碼必須全是 null（防線：MCP 永遠不送號碼）。 */
function assertNoIdentifiers(payload: Record<string, unknown>) {
  for (const k of SENSITIVE_IDENTIFIERS) {
    if (payload[k] !== null && payload[k] !== undefined) {
      throw new Error(`內部錯誤：廠商 payload 帶了 ${k}，MCP 不應經手識別碼。`);
    }
  }
}

/** 表單狀態（字串）的欄位：null → ""。 */
function toFormPatch(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of VENDOR_TEXT_FIELDS) {
    if (args[k] !== undefined) out[k] = args[k] === null ? "" : args[k];
  }
  if (args.category_id !== undefined) out.category_id = args.category_id;
  if (args.is_preferred !== undefined) out.is_preferred = args.is_preferred;
  if (args.status !== undefined) out.status = args.status;
  return out;
}

const CONTACT_FIELDS = [
  "name",
  "job_title",
  "phone",
  "mobile",
  "email",
  "is_primary",
  "is_finance_contact",
  "notes",
  "sort_order",
] as const;

/* ---- 推廣 ---- */

type ReferrerInput = import("@/server/repos/referrals").ReferrerInput;
type ReferrerRow = import("@/server/repos/referrals").ReferrerRow;

const tiersIn = (t: { up_to: number | null; rate: number }[] | null | undefined) =>
  t === undefined ? undefined : t === null ? null : t.map((x) => ({ upTo: x.up_to, rate: x.rate }));

function referrerInputFromRow(r: ReferrerRow): ReferrerInput {
  return {
    name: r.name,
    code: r.code,
    kind: r.kind,
    contact: r.contact,
    email: r.email,
    phone: r.phone,
    baseSalary: r.base_salary,
    discountPercent: r.discount_percent,
    commissionTiers: r.commission_tiers,
    active: r.active,
    note: r.note,
  };
}

/** 工具參數（snake_case）→ ReferrerInput 的部分欄位。 */
function referrerPatch(args: Record<string, unknown>): Partial<ReferrerInput> {
  const map: [string, keyof ReferrerInput][] = [
    ["name", "name"],
    ["code", "code"],
    ["kind", "kind"],
    ["contact", "contact"],
    ["email", "email"],
    ["phone", "phone"],
    ["base_salary", "baseSalary"],
    ["discount_percent", "discountPercent"],
    ["active", "active"],
    ["note", "note"],
  ];
  const out: Record<string, unknown> = {};
  for (const [from, to] of map) if (args[from] !== undefined) out[to] = args[from];
  const tiers = tiersIn(args.commission_tiers as never);
  if (tiers !== undefined) out.commissionTiers = tiers;
  return out as Partial<ReferrerInput>;
}

const REFERRER_KEYS = [
  "name",
  "code",
  "kind",
  "contact",
  "email",
  "phone",
  "baseSalary",
  "discountPercent",
  "commissionTiers",
  "active",
  "note",
] as const;
/** 推薦人的個資欄位：前後值只進稽核表，伺服器 log 只印欄位名。 */
const REFERRER_PII = ["contact", "email", "phone", "baseSalary"];

/* ------------------------------------------------------------------ 實作 */

type Impl = { [N in PartnersContentToolName]: (args: Args<N>) => Promise<TextResult> };

const IMPL: Impl = {
  /* ============================================================ 選品 */

  async create_curated_theme(args) {
    const tool = "create_curated_theme";
    await oauthUserId(tool);
    const title = await fillL("title", args.title as LocalizedArg);
    const description = await fillL("description", args.description as LocalizedArg);
    const { listCuratedThemes } = await import("@/server/repos/curated");
    const themes = await listCuratedThemes();
    const sortOrder =
      args.sort_order ?? themes.reduce((max, t) => Math.max(max, t.sort_order), 0) + 1;
    const { curatedThemeSchema } = await import("@/lib/admin/schemas");
    const payload = validateWith(curatedThemeSchema, {
      title: title.value,
      description: description.value,
      is_published: args.is_published,
      sort_order: sortOrder,
    });
    const translated = [title, description].some((r) => r.translated);
    const translatedFields = translatedNames({ title, description });
    const auditChanges = { will_create: payload };
    if (args.dry_run) {
      const key = await previewKey(args.idempotency_key);
      return preview(
        tool,
        "curated_theme",
        "(未建立)",
        "create",
        {
          will_create: payload,
          ...(translated ? { note: "英日文是自動翻譯的，請一併確認。" } : {}),
          idempotency_key: key,
          reminder: CURATED_NOTE,
          confirm_args: confirmArgs(args, {
            title: title.value,
            description: description.value,
            sort_order: sortOrder,
            idempotency_key: key,
          }),
          next_step: CONFIRM_ARGS_NEXT_STEP,
        },
        auditChanges,
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const { upsertCuratedTheme } = await import("@/server/repos/curated");
    const row = await commitOrAudit(tool, "curated_theme", "(未建立)", "create", auditChanges, () =>
      upsertCuratedTheme(payload),
    );
    return committed(
      tool,
      "curated_theme",
      row.id,
      "create",
      { written: true, theme: row, write_note: writeTimeNote(translatedFields) },
      { ...auditChanges, id: row.id },
    );
  },

  async update_curated_theme(args) {
    const tool = "update_curated_theme";
    await oauthUserId(tool);
    const { getCuratedThemeById } = await import("@/server/repos/curated");
    const current = await getCuratedThemeById(args.id);
    if (!current) notFound("選品主題", args.id);
    const next: Record<string, unknown> = {
      id: current.id,
      title: current.title,
      description: current.description,
      is_published: current.is_published,
      sort_order: current.sort_order,
    };
    const filled = await fillSome({ title: args.title, description: args.description });
    Object.assign(next, filled.values);
    if (args.is_published !== undefined) next.is_published = args.is_published;
    if (args.sort_order !== undefined) next.sort_order = args.sort_order;
    const { curatedThemeSchema } = await import("@/lib/admin/schemas");
    const payload = validateWith(curatedThemeSchema, next);
    const changes = diff(current, payload, ["title", "description", "is_published", "sort_order"]);
    if (Object.keys(changes).length === 0) return noChange(tool, current.id, args.dry_run);
    if (args.dry_run) {
      return preview(
        tool,
        "curated_theme",
        current.id,
        "update",
        { changes, ...lockedPreview(args, filled) },
        { changes },
      );
    }
    const { upsertCuratedTheme } = await import("@/server/repos/curated");
    await commitOrAudit(tool, "curated_theme", current.id, "update", { changes }, () =>
      upsertCuratedTheme({ ...payload, id: current.id }),
    );
    return committed(
      tool,
      "curated_theme",
      current.id,
      "update",
      { written: true, changes, write_note: writeTimeNote(filled.translated) },
      { changes },
    );
  },

  async create_curated_item(args) {
    const tool = "create_curated_item";
    await oauthUserId(tool);
    const { getCuratedThemeById, listCuratedItemsByTheme } = await import("@/server/repos/curated");
    const theme = await getCuratedThemeById(args.theme_id);
    if (!theme) notFound("選品主題", args.theme_id);
    const linked = await linkCheck(args.product_id);
    const name = await fillL("name", args.name as LocalizedArg);
    const note = await fillL("note", args.note as LocalizedArg);
    const { nextCuratedSortOrder } = await import("@/lib/admin/unified-products");
    const items = await listCuratedItemsByTheme(theme.id);
    const { curatedItemSchema } = await import("@/lib/admin/schemas");
    const payload = validateWith(curatedItemSchema, {
      theme_id: theme.id,
      name: name.value,
      note: note.value,
      is_published: args.is_published,
      sort_order: nextCuratedSortOrder(items, theme.id),
      product_id: args.product_id ?? null,
    });
    const visibility =
      payload.product_id && payload.is_published
        ? "會出現在前台（主題公開時）。"
        : payload.product_id
          ? "目前不公開；改成公開後才會出現在前台。"
          : "⚠️ 沒有連結商品：前台不會顯示這個選品，只存在後台。";
    const auditChanges = { will_create: payload };
    if (args.dry_run) {
      const key = await previewKey(args.idempotency_key);
      return preview(
        tool,
        "curated_item",
        "(未建立)",
        "create",
        {
          will_create: payload,
          theme: { id: theme.id, title: theme.title.zh },
          linked_product: linked,
          visibility,
          ...(name.translated || note.translated
            ? { note: "英日文是自動翻譯的，請一併確認。" }
            : {}),
          idempotency_key: key,
          confirm_args: confirmArgs(args, {
            name: name.value,
            note: note.value,
            idempotency_key: key,
          }),
          next_step: CONFIRM_ARGS_NEXT_STEP,
        },
        auditChanges,
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const { upsertCuratedItem } = await import("@/server/repos/curated");
    const row = await commitOrAudit(tool, "curated_item", "(未建立)", "create", auditChanges, () =>
      upsertCuratedItem(payload),
    );
    return committed(
      tool,
      "curated_item",
      String(row.id),
      "create",
      {
        written: true,
        item: row,
        visibility,
        write_note: writeTimeNote(translatedNames({ name, note })),
      },
      { ...auditChanges, id: row.id },
    );
  },

  async update_curated_item(args) {
    const tool = "update_curated_item";
    await oauthUserId(tool);
    const { getCuratedItemById } = await import("@/server/repos/curated");
    const current = await getCuratedItemById(args.id);
    if (!current) notFound("選品品項", args.id);
    const linked = args.product_id !== undefined ? await linkCheck(args.product_id) : null;
    const next: Record<string, unknown> = {
      id: current.id,
      theme_id: current.theme_id,
      name: current.name,
      note: current.note,
      is_published: current.is_published,
      sort_order: current.sort_order,
    };
    const filled = await fillSome({ name: args.name, note: args.note });
    Object.assign(next, filled.values);
    if (args.is_published !== undefined) next.is_published = args.is_published;
    if (args.product_id !== undefined) next.product_id = args.product_id;
    const { curatedItemSchema } = await import("@/lib/admin/schemas");
    const payload = validateWith(curatedItemSchema, next);
    // product_id：沒送＝不動（沿用原值）；null＝解除連結。
    const after = {
      ...payload,
      product_id: payload.product_id === undefined ? current.product_id : payload.product_id,
    };
    const changes = diff(current, after, ["name", "note", "is_published", "product_id"]);
    if (Object.keys(changes).length === 0) return noChange(tool, current.id, args.dry_run);
    const visibility = after.product_id
      ? undefined
      : "⚠️ 沒有連結商品：前台不會顯示這個選品，只存在後台。";
    if (args.dry_run) {
      return preview(
        tool,
        "curated_item",
        String(current.id),
        "update",
        {
          changes,
          linked_product: linked,
          ...(visibility ? { visibility } : {}),
          ...lockedPreview(args, filled),
        },
        { changes },
      );
    }
    const { upsertCuratedItem } = await import("@/server/repos/curated");
    await commitOrAudit(tool, "curated_item", String(current.id), "update", { changes }, () =>
      upsertCuratedItem(payload),
    );
    return committed(
      tool,
      "curated_item",
      String(current.id),
      "update",
      {
        written: true,
        changes,
        ...(visibility ? { visibility } : {}),
        write_note: writeTimeNote(filled.translated),
      },
      { changes },
    );
  },

  async reorder_curated_items(args) {
    const tool = "reorder_curated_items";
    await oauthUserId(tool);
    const { getCuratedThemeById, listCuratedItemsByTheme } = await import("@/server/repos/curated");
    const theme = await getCuratedThemeById(args.theme_id);
    if (!theme) notFound("選品主題", args.theme_id);
    const items = await listCuratedItemsByTheme(theme.id);
    const have = items.map((i) => i.id);
    const want = args.item_ids;
    const same =
      want.length === have.length &&
      new Set(want).size === want.length &&
      want.every((id) => have.includes(id));
    if (!same) {
      throw new McpInputError(
        `item_ids 必須剛好是這個主題底下的全部品項（共 ${have.length} 個：${have.join(", ")}），每個一次，照新的順序。`,
      );
    }
    const label = (id: number) => {
      const it = items.find((i) => i.id === id);
      return { id, name: it?.name.zh ?? "", has_product: Boolean(it?.product_id) };
    };
    const before = have.map(label);
    const after = want.map(label);
    if (stableStringify(have) === stableStringify(want))
      return noChange(tool, theme.id, args.dry_run);
    const changes = { order: { before: have, after: want } };
    if (args.dry_run) {
      return preview(
        tool,
        "curated_theme",
        theme.id,
        "reorder",
        { theme: { id: theme.id, title: theme.title.zh }, before, after },
        changes,
      );
    }
    const { reorderCuratedItems } = await import("@/server/repos/curated");
    await commitOrAudit(tool, "curated_theme", theme.id, "reorder", changes, () =>
      reorderCuratedItems(theme.id, want),
    );
    return committed(
      tool,
      "curated_theme",
      theme.id,
      "reorder",
      { written: true, order: after },
      changes,
    );
  },

  /* ============================================================ 廠商送審商品 */

  async list_vendor_submissions(args) {
    const { listVendorSubmissions } = await import("@/server/repos/inv-vendors");
    const rows = await listVendorSubmissions(args.status);
    return jsonText({
      status: args.status,
      total: rows.length,
      rows: rows.slice(0, args.limit).map((r) => ({
        id: r.inv_product_id,
        name: r.name,
        issue_number: r.issue_number,
        series: r.series,
        publisher: r.publisher,
        barcode: r.barcode,
        notes: r.notes,
        has_image: Boolean(r.image_key),
        selling_price: r.selling_price,
        approval_status: r.approval_status,
        vendor_id: r.vendor_id,
        vendor_name: r.vendor_name,
        vendor_code: r.vendor_code,
        vendor_is_consignment: r.vendor_is_consignment,
        vendor_commission_rate: r.vendor_commission_rate,
        created_at: r.created_at,
      })),
      note: "核准／退回用 approve_vendor_submission（id）；要同時上架就給 listing。",
    });
  },

  async approve_vendor_submission(args) {
    const tool = "approve_vendor_submission";
    const userId = await oauthUserId(tool);
    const { listVendorSubmissions } = await import("@/server/repos/inv-vendors");
    const row = (await listVendorSubmissions("all")).find((r) => r.inv_product_id === args.id);
    if (!row) notFound("廠商送審的商品", args.id);
    const approved = args.decision === "approve";
    if (row.approval_status !== "pending") {
      return jsonText({
        id: args.id,
        dry_run: args.dry_run,
        written: false,
        status: row.approval_status,
        message: `這件送審商品目前是「${row.approval_status}」，不是待審，不需要（也不能）再審核。`,
      });
    }
    let listing: Record<string, unknown> | null = null;
    let translated = false;
    let translatedListing: string[] = [];
    if (args.listing) {
      const l = args.listing;
      const [title, summary, description] = await Promise.all([
        fillL("listing.title", l.title as LocalizedArg),
        fillL("listing.summary", l.summary as LocalizedArg),
        fillL("listing.description", l.description as LocalizedArg),
      ]);
      translated = [title, summary, description].some((r) => r.translated);
      translatedListing = translatedNames({
        "listing.title": title,
        "listing.summary": summary,
        "listing.description": description,
      });
      listing = {
        slug: l.slug,
        product_type: l.product_type,
        title: title.value,
        summary: summary.value,
        description: description.value,
        price: l.price,
        units_per_sale: l.units_per_sale,
        // 與後台 VendorListingDialog 相同：廠商上傳的圖直接沿用。
        image_key: row.image_key,
        status: l.status,
      };
    }
    const { vendorSubmissionApprovalSchema } = await import("@/lib/admin/schemas");
    const valid = validateWith(vendorSubmissionApprovalSchema, {
      id: args.id,
      approved,
      listing,
    });
    const target = {
      name: row.name,
      vendor_name: row.vendor_name,
      selling_price: row.selling_price,
    };
    const action = !approved ? "reject" : valid.listing ? "approve_and_list" : "approve";
    const auditChanges = {
      status: { before: "pending", after: approved ? "approved" : "rejected" },
      listing: valid.listing,
    };
    if (args.dry_run) {
      return preview(
        tool,
        "inv_product",
        args.id,
        action,
        {
          target,
          status: auditChanges.status,
          ...(valid.listing && listing
            ? await (async () => {
                const key = await previewKey(args.idempotency_key);
                return {
                  will_list: valid.listing,
                  idempotency_key: key,
                  confirm_args: confirmArgs(args, {
                    listing: {
                      ...(args.listing as Record<string, unknown>),
                      title: listing.title,
                      summary: listing.summary,
                      description: listing.description,
                    },
                    idempotency_key: key,
                  }),
                  next_step: CONFIRM_ARGS_NEXT_STEP,
                };
              })()
            : {}),
          ...(translated ? { note: "英日文是自動翻譯的，請一併確認。" } : {}),
        },
        auditChanges,
      );
    }
    if (valid.listing) await claimIdempotencyKey(tool, args.idempotency_key);
    const { approveVendorProduct } = await import("@/server/repos/inv-vendors");
    const res = await commitOrAudit(tool, "inv_product", args.id, action, auditChanges, () =>
      approveVendorProduct({
        userId,
        id: args.id,
        approved,
        listing: (valid.listing as Record<string, unknown> | null) ?? null,
      }),
    );
    return committed(
      tool,
      "inv_product",
      args.id,
      action,
      {
        written: res.changed,
        result: res,
        write_note: writeTimeNote(translatedListing),
        ...(!res.changed
          ? { message: `已經有人審過了（目前：${res.previous_status ?? "未知"}）。` }
          : {}),
      },
      { ...auditChanges, result: res },
    );
  },

  /* ============================================================ 廠商 */

  async create_vendor(args) {
    const tool = "create_vendor";
    const userId = await oauthUserId(tool);
    const { EMPTY_FORM, toVendorPayload } = await import("@/components/inventory/VendorFormState");
    const form = {
      ...EMPTY_FORM,
      entity_type: "domestic_individual" as const,
      ...toFormPatch(args as Record<string, unknown>),
      name: args.name,
    };
    const { vendorSchema } = await import("@/lib/admin/schemas");
    const valid = validateWith(vendorSchema, toVendorPayload(form as typeof EMPTY_FORM, null));
    const { id: _id, ...payload } = valid;
    assertNoIdentifiers(payload);
    const shown = Object.fromEntries(
      ["entity_type", ...VENDOR_EDITABLE].map((k) => [
        k,
        (payload as Record<string, unknown>)[k] ?? null,
      ]),
    );
    const auditChanges = { will_create: shown, _log_redact: ["will_create"] };
    if (args.dry_run) {
      return preview(
        tool,
        "vendor",
        "(未建立)",
        "create",
        {
          will_create: shown,
          finance_terms: "付款條件、結算、手續費率、抽成用後台預設值；要改請到後台。",
          idempotency_key: await previewKey(args.idempotency_key),
        },
        auditChanges,
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const { saveVendor } = await import("@/server/repos/inv-vendors");
    const res = await commitOrAudit(tool, "vendor", "(未建立)", "create", auditChanges, () =>
      saveVendor({ userId, id: null, payload }),
    );
    return committed(
      tool,
      "vendor",
      res.id,
      "create",
      {
        written: true,
        vendor: {
          vendor_id: res.id,
          vendor_code: res.vendor_code,
          approval_status: res.approval_status,
        },
        ...(res.approval_status === "pending"
          ? { next_step: "這家廠商待審核：用 approve_vendor 核准後才能開始往來。" }
          : {}),
      },
      { ...auditChanges, result: res },
    );
  },

  async update_vendor(args) {
    const tool = "update_vendor";
    const userId = await oauthUserId(tool);
    const { getAdminVendor } = await import("@/server/repos/inv-vendors");
    const detail = await getAdminVendor(args.vendor_id);
    if (!detail) notFound("廠商", args.vendor_id);
    const stored = storedIdentifiers(detail);
    if (stored.length > 0) {
      throw new McpInputError(
        `「${detail.name}」已存有${stored.join("、")}。後台的儲存會整欄覆寫這些號碼，所以後台也規定要先重新輸入完整號碼才能存；` +
          "MCP 不經手這些敏感號碼，這家廠商請到後台 /admin/inventory-vendors 修改。",
      );
    }
    const { formFromDetail, toVendorPayload } =
      await import("@/components/inventory/VendorFormState");
    const base = formFromDetail(detail);
    const form = { ...base, ...toFormPatch(args as Record<string, unknown>) };
    const { vendorSchema } = await import("@/lib/admin/schemas");
    const valid = validateWith(
      vendorSchema,
      toVendorPayload(form as typeof base, detail.vendor_id),
    );
    const { id: _id, ...payload } = valid;
    assertNoIdentifiers(payload);
    const before = vendorPublic(detail);
    const changes = diff(before, payload as Record<string, unknown>, VENDOR_EDITABLE);
    if (Object.keys(changes).length === 0) return noChange(tool, detail.vendor_id, args.dry_run);
    const auditChanges = { changes, _log_redact: ["changes"] };
    if (args.dry_run) {
      return preview(
        tool,
        "vendor",
        detail.vendor_id,
        "update",
        { vendor: { vendor_id: detail.vendor_id, name: detail.name }, changes },
        auditChanges,
      );
    }
    const { saveVendor } = await import("@/server/repos/inv-vendors");
    const res = await commitOrAudit(tool, "vendor", detail.vendor_id, "update", auditChanges, () =>
      saveVendor({ userId, id: detail.vendor_id, payload }),
    );
    return committed(
      tool,
      "vendor",
      detail.vendor_id,
      "update",
      { written: true, changes, approval_status: res.approval_status },
      auditChanges,
    );
  },

  async approve_vendor(args) {
    const tool = "approve_vendor";
    const userId = await oauthUserId(tool);
    const { getAdminVendor } = await import("@/server/repos/inv-vendors");
    const detail = await getAdminVendor(args.vendor_id);
    if (!detail) notFound("廠商", args.vendor_id);
    const approved = args.decision === "approve";
    if (detail.approval_status !== "pending") {
      return jsonText({
        vendor_id: detail.vendor_id,
        dry_run: args.dry_run,
        written: false,
        status: detail.approval_status,
        message: `「${detail.name}」目前是「${detail.approval_status}」，不是待審，不需要（也不能）再審核。`,
      });
    }
    const { approveRecordSchema } = await import("@/lib/admin/schemas");
    validateWith(approveRecordSchema, { module: "vendors", id: detail.vendor_id, approved });
    const changes = {
      approval_status: { before: "pending", after: approved ? "approved" : "rejected" },
    };
    const action = approved ? "approve" : "reject";
    if (args.dry_run) {
      return preview(
        tool,
        "vendor",
        detail.vendor_id,
        action,
        { vendor: { vendor_id: detail.vendor_id, name: detail.name }, changes },
        changes,
      );
    }
    const { approveRecord } = await import("@/server/repos/inv-products");
    const res = await commitOrAudit(tool, "vendor", detail.vendor_id, action, changes, () =>
      approveRecord({ userId, module: "vendors", id: detail.vendor_id, approved }),
    );
    return committed(
      tool,
      "vendor",
      detail.vendor_id,
      action,
      {
        written: res.changed,
        result: res,
        ...(!res.changed
          ? { message: `已經有人審過了（目前：${res.previous_status ?? "未知"}）。` }
          : {}),
      },
      { ...changes, result: res },
    );
  },

  async list_vendor_contacts(args) {
    const { getAdminVendor, listVendorContacts } = await import("@/server/repos/inv-vendors");
    const detail = await getAdminVendor(args.vendor_id);
    if (!detail) notFound("廠商", args.vendor_id);
    const rows = await listVendorContacts(args.vendor_id);
    return jsonText({
      vendor: { vendor_id: detail.vendor_id, name: detail.name },
      count: rows.length,
      contacts: rows.map((c) => ({
        contact_id: c.contact_id,
        name: c.name,
        job_title: c.job_title,
        phone: c.phone,
        mobile: c.mobile,
        email: c.email,
        is_primary: c.is_primary,
        is_finance_contact: c.is_finance_contact,
        notes: c.notes,
        sort_order: c.sort_order,
      })),
    });
  },

  async save_vendor_contact(args) {
    const tool = "save_vendor_contact";
    const userId = await oauthUserId(tool);
    const { getAdminVendor, listVendorContacts } = await import("@/server/repos/inv-vendors");
    const detail = await getAdminVendor(args.vendor_id);
    if (!detail) notFound("廠商", args.vendor_id);
    const contacts = await listVendorContacts(args.vendor_id);
    const creating = !args.contact_id;
    let before: Record<string, unknown>;
    if (creating) {
      if (!args.name) throw new McpInputError("新增聯絡窗口時 name 必填。");
      before = {
        name: "",
        job_title: null,
        phone: null,
        mobile: null,
        email: null,
        is_primary: contacts.length === 0,
        is_finance_contact: false,
        notes: null,
        sort_order: Math.min(
          999,
          contacts.reduce((m, c) => Math.max(m, c.sort_order ?? 0), -1) + 1,
        ),
      };
    } else {
      const c = contacts.find((x) => x.contact_id === args.contact_id);
      if (!c) notFound(`「${detail.name}」的聯絡窗口`, args.contact_id as string);
      before = {
        name: c.name,
        job_title: c.job_title,
        phone: c.phone,
        mobile: c.mobile,
        email: c.email,
        is_primary: c.is_primary ?? false,
        is_finance_contact: c.is_finance_contact ?? false,
        notes: c.notes,
        sort_order: c.sort_order ?? 0,
      };
    }
    const next = applyDefined(before, args as Record<string, unknown>, CONTACT_FIELDS);
    const { vendorContactSchema } = await import("@/lib/admin/schemas");
    const valid = validateWith(vendorContactSchema, {
      ...next,
      id: creating ? null : args.contact_id,
    });
    const { id: contactId, ...payload } = valid;
    const changes = creating
      ? diff({}, payload as Record<string, unknown>, CONTACT_FIELDS)
      : diff(before, payload as Record<string, unknown>, CONTACT_FIELDS);
    if (!creating && Object.keys(changes).length === 0)
      return noChange(tool, args.contact_id as string, args.dry_run);
    const action = creating ? "create" : "update";
    const entityId = creating ? "(未建立)" : (contactId as string);
    const auditChanges = { vendor_id: detail.vendor_id, changes, _log_redact: ["changes"] };
    if (args.dry_run) {
      return preview(
        tool,
        "vendor_contact",
        entityId,
        action,
        {
          vendor: { vendor_id: detail.vendor_id, name: detail.name },
          changes,
          ...(creating ? { idempotency_key: await previewKey(args.idempotency_key) } : {}),
        },
        auditChanges,
      );
    }
    if (creating) await claimIdempotencyKey(tool, args.idempotency_key);
    const { saveVendorContact } = await import("@/server/repos/inv-vendors");
    const res = await commitOrAudit(tool, "vendor_contact", entityId, action, auditChanges, () =>
      saveVendorContact({
        userId,
        vendorId: detail.vendor_id,
        id: creating ? null : (contactId as string),
        payload,
      }),
    );
    return committed(
      tool,
      "vendor_contact",
      res.id,
      action,
      { written: true, contact_id: res.id, changes },
      auditChanges,
    );
  },

  /* ============================================================ 推廣 */

  async get_referral_settings() {
    const { listReferrers, getReferralSettings } = await import("@/server/repos/referrals");
    const [referrers, settings] = await Promise.all([listReferrers(), getReferralSettings()]);
    const tiersOut = (t: { upTo: number | null; rate: number }[] | null) =>
      t === null ? null : t.map((x) => ({ up_to: x.upTo, rate: x.rate }));
    return jsonText({
      settings: {
        default_discount_percent: settings.defaultDiscountPercent,
        default_margin_percent: settings.defaultMarginPercent,
        commission_tiers: tiersOut(settings.commissionTiers),
        new_customer_multiplier: settings.newCustomerMultiplier,
        team_pool_baseline: settings.teamPoolBaseline,
        team_pool_percent: settings.teamPoolPercent,
        team_pool_equal_percent: settings.teamPoolEqualPercent,
        payout_cap_percent: settings.payoutCapPercent,
        clawback_days: settings.clawbackDays,
      },
      referrers: referrers.map((r) => ({ ...r, commission_tiers: tiersOut(r.commission_tiers) })),
      note: "推廣者聯絡方式屬個資，只在回答需要時引用。月結結算請到後台。",
    });
  },

  async create_referrer(args) {
    const tool = "create_referrer";
    await oauthUserId(tool);
    const base: ReferrerInput = {
      name: args.name,
      code: args.code,
      kind: "external",
      contact: null,
      email: null,
      phone: null,
      baseSalary: null,
      discountPercent: null,
      commissionTiers: null,
      active: true,
      note: null,
    };
    const { referrerSchema } = await import("@/lib/admin/referral-schemas");
    const input = validateWith(referrerSchema, {
      ...base,
      ...referrerPatch(args as Record<string, unknown>),
    }) as ReferrerInput;
    const { listReferrers } = await import("@/server/repos/referrals");
    const taken = (await listReferrers()).find((r) => r.code === input.code);
    if (taken) {
      throw new McpInputError(`推薦碼「${input.code}」已經被「${taken.name}」使用，請換一個。`);
    }
    const auditChanges = { will_create: input, _log_redact: ["will_create"] };
    if (args.dry_run) {
      return preview(
        tool,
        "referrer",
        "(未建立)",
        "create",
        {
          will_create: input,
          defaults:
            "discountPercent／commissionTiers 為 null＝用全站預設（見 get_referral_settings）。",
          idempotency_key: await previewKey(args.idempotency_key),
        },
        auditChanges,
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const { createReferrer } = await import("@/server/repos/referrals");
    const res = await commitOrAudit(tool, "referrer", "(未建立)", "create", auditChanges, () =>
      createReferrer(input),
    );
    if (!res.ok) throw new McpInputError(`推薦碼「${input.code}」已經被使用，請換一個。`);
    return committed(
      tool,
      "referrer",
      res.id,
      "create",
      { written: true, id: res.id, code: input.code },
      { ...auditChanges, id: res.id },
    );
  },

  async update_referrer(args) {
    const tool = "update_referrer";
    await oauthUserId(tool);
    const { listReferrers } = await import("@/server/repos/referrals");
    const all = await listReferrers();
    const row = all.find((r) => r.id === args.id);
    if (!row) notFound("推廣者", args.id);
    const before = referrerInputFromRow(row);
    const { referrerSchema } = await import("@/lib/admin/referral-schemas");
    const input = validateWith(referrerSchema, {
      ...before,
      ...referrerPatch(args as Record<string, unknown>),
    }) as ReferrerInput;
    if (input.code !== row.code) {
      const taken = all.find((r) => r.code === input.code && r.id !== row.id);
      if (taken) {
        throw new McpInputError(`推薦碼「${input.code}」已經被「${taken.name}」使用，請換一個。`);
      }
    }
    const changes = diff(before, input, REFERRER_KEYS);
    if (Object.keys(changes).length === 0) return noChange(tool, row.id, args.dry_run);
    const redact = Object.keys(changes).some((k) => REFERRER_PII.includes(k));
    const auditChanges = { changes, ...(redact ? { _log_redact: ["changes"] } : {}) };
    if (args.dry_run) {
      return preview(
        tool,
        "referrer",
        row.id,
        "update",
        {
          referrer: { id: row.id, name: row.name, code: row.code },
          changes,
          ...(changes.code ? { warning: "改了推薦碼之後，舊的碼在結帳就無效了。" } : {}),
        },
        auditChanges,
      );
    }
    const { updateReferrer } = await import("@/server/repos/referrals");
    const res = await commitOrAudit(tool, "referrer", row.id, "update", auditChanges, () =>
      updateReferrer(row.id, input),
    );
    if (!res.ok) throw new McpInputError(`推薦碼「${input.code}」已經被使用，請換一個。`);
    return committed(tool, "referrer", row.id, "update", { written: true, changes }, auditChanges);
  },

  async update_referral_settings(args) {
    const tool = "update_referral_settings";
    await oauthUserId(tool);
    const { getReferralSettings } = await import("@/server/repos/referrals");
    const current = await getReferralSettings();
    const map: [string, keyof typeof current][] = [
      ["default_discount_percent", "defaultDiscountPercent"],
      ["default_margin_percent", "defaultMarginPercent"],
      ["new_customer_multiplier", "newCustomerMultiplier"],
      ["team_pool_baseline", "teamPoolBaseline"],
      ["team_pool_percent", "teamPoolPercent"],
      ["team_pool_equal_percent", "teamPoolEqualPercent"],
      ["payout_cap_percent", "payoutCapPercent"],
      ["clawback_days", "clawbackDays"],
    ];
    const next: Record<string, unknown> = { ...current };
    const a = args as Record<string, unknown>;
    for (const [from, to] of map) if (a[from] !== undefined) next[to] = a[from];
    const tiers = tiersIn(args.commission_tiers);
    if (tiers !== undefined) next.commissionTiers = tiers;
    const { referralSettingsSchema } = await import("@/lib/admin/referral-schemas");
    const settings = validateWith(referralSettingsSchema, next);
    const changes = diff(current, settings, Object.keys(current));
    if (Object.keys(changes).length === 0) return noChange(tool, "referral_settings", args.dry_run);
    if (args.dry_run) {
      return preview(
        tool,
        "referral_settings",
        "1",
        "update",
        {
          changes,
          note: "影響之後計算的月報；已結算的月份用當時的快照，不受影響。",
        },
        { changes },
      );
    }
    const { updateReferralSettings } = await import("@/server/repos/referrals");
    await commitOrAudit(tool, "referral_settings", "1", "update", { changes }, () =>
      updateReferralSettings(settings),
    );
    return committed(
      tool,
      "referral_settings",
      "1",
      "update",
      { written: true, changes },
      { changes },
    );
  },

  /* ============================================================ 聯絡電話 */

  async list_contact_phones() {
    const { listContactPhones } = await import("@/server/repos/contact-phones");
    const rows = await listContactPhones();
    return jsonText({
      count: rows.length,
      phones: rows.map((r) => ({
        id: r.id,
        label: r.label,
        display_text: r.display_text,
        tel: r.tel,
        sort_order: r.sort_order,
      })),
    });
  },

  async create_contact_phone(args) {
    const tool = "create_contact_phone";
    await oauthUserId(tool);
    const { listContactPhones } = await import("@/server/repos/contact-phones");
    const phones = await listContactPhones();
    const sortOrder =
      args.sort_order ?? phones.reduce((max, p) => Math.max(max, p.sort_order), 0) + 1;
    const { contactPhoneSchema } = await import("@/lib/admin/schemas");
    const payload = validateWith(contactPhoneSchema, {
      label: args.label,
      display_text: args.display_text,
      tel: args.tel,
      sort_order: sortOrder,
    });
    const auditChanges = { will_create: payload };
    if (args.dry_run) {
      return preview(
        tool,
        "contact_phone",
        "(未建立)",
        "create",
        { will_create: payload, idempotency_key: await previewKey(args.idempotency_key) },
        auditChanges,
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const { upsertContactPhone } = await import("@/server/repos/contact-phones");
    const row = await commitOrAudit(tool, "contact_phone", "(未建立)", "create", auditChanges, () =>
      upsertContactPhone(payload),
    );
    return committed(
      tool,
      "contact_phone",
      String(row.id),
      "create",
      { written: true, phone: row },
      { ...auditChanges, id: row.id },
    );
  },

  async update_contact_phone(args) {
    const tool = "update_contact_phone";
    await oauthUserId(tool);
    const { getContactPhoneById } = await import("@/server/repos/contact-phones");
    const current = await getContactPhoneById(args.id);
    if (!current) notFound("聯絡電話", args.id);
    const keys = ["label", "display_text", "tel", "sort_order"] as const;
    const next = applyDefined(
      {
        id: current.id,
        label: current.label,
        display_text: current.display_text,
        tel: current.tel,
        sort_order: current.sort_order,
      },
      args as Record<string, unknown>,
      keys,
    );
    const { contactPhoneSchema } = await import("@/lib/admin/schemas");
    const payload = validateWith(contactPhoneSchema, next);
    const changes = diff(current, payload, keys);
    if (Object.keys(changes).length === 0) return noChange(tool, current.id, args.dry_run);
    if (args.dry_run) {
      return preview(tool, "contact_phone", String(current.id), "update", { changes }, { changes });
    }
    const { upsertContactPhone } = await import("@/server/repos/contact-phones");
    await commitOrAudit(tool, "contact_phone", String(current.id), "update", { changes }, () =>
      upsertContactPhone({ ...payload, id: current.id }),
    );
    return committed(
      tool,
      "contact_phone",
      String(current.id),
      "update",
      { written: true, changes },
      { changes },
    );
  },
};

/* ------------------------------------------------------------------ 包裝 */

function wrap<N extends PartnersContentToolName>(name: N): (args: unknown) => Promise<TextResult> {
  const schema = PARTNERS_CONTENT_TOOL_INPUTS[name] as unknown as {
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
      console.error(
        `[mcp/partners-content] ${name} 失敗`,
        err instanceof Error ? err.message : err,
      );
      return errText(`執行失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export const PARTNERS_CONTENT_HANDLERS = Object.fromEntries(
  (Object.keys(PARTNERS_CONTENT_TOOL_INPUTS) as PartnersContentToolName[]).map((n) => [n, wrap(n)]),
) as { [N in PartnersContentToolName]: (args: Args<N> | unknown) => Promise<TextResult> };
