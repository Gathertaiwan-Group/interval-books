/**
 * MCP 工具 —— 進銷存商品「上架到網站」、修改既有商品、拍照辨識進貨單、修改進貨、出版品對應進銷存
 * （2026-11-15，業主要全程用手機透過 MCP 操作）。
 *
 * ── 一條規矩：走後台同一條路 ──────────────────────────────────────────────
 * 每一支寫入都呼叫後台 server fn 背後**同一支 repo 函式**（src/server/repos/*），輸入用後台**同一份**
 * zod 規則（src/lib/admin/schemas.ts）驗過。這個檔案沒有任何一句自己寫的 insert／update／delete：
 *
 *   create_inventory_listing         = /admin/inventory-listing「上架」     → repos/inventory-listing#createInventoryListing
 *   update_inventory_product         = /admin/inventory-products/$id/edit  → repos/inv-products#saveProduct（inv_save_product）
 *   set_inventory_product_active     = 商品列表「停用／恢復」               → repos/inv-products#setProductActive（inv_set_product_active）
 *   request_inventory_price_change   = 商品內頁「調價」                     → repos/inv-products#requestPriceChange（inv_request_price_change）
 *   recognize_purchase_order         = 進貨頁「拍照辨識」的上傳＋辨識        → storage#uploadOcrScan ＋ gemini#recognisePurchaseOrder（唯讀建議）
 *   import_purchases                 = 拍照辨識確認表「匯入」／Excel 進貨匯入 → repos/inv-purchases#importPurchases（inv_import_purchases）
 *   update_purchase                  = /admin/inventory-purchases/$id 編輯   → repos/inv-purchases#savePurchase（inv_save_purchase）
 *   link_publication_to_inventory    = 後台「商品」頁刊物「連結進銷存」       → repos/publications#linkPublicationToInventory
 *
 * ── 權限 ──────────────────────────────────────────────────────────────────
 * 後台：上架與刊物連結是 adminFnMiddleware（role=admin）；商品／進貨的這幾支是 staffFnMiddleware()
 * **不帶細權限**（調價「送出」也不需要 approve_price_changes，見 fns/inv-products.ts）。MCP 的 OAuth
 * 連線只發給管理員、每次請求重查 profiles（core.ts／oauth-core.ts），所以兩種都涵蓋。
 * 每一支寫入（含辨識：會存檔、會花辨識額度）都要 OAuth 管理員身分：inv_* RPC 必須記錄操作人員，
 * 上架／刊物連結雖然 repo 不收 user id，也一律拒絕靜態 token，「是誰」才有一個真人可查。
 * 唯讀連線擋寫入（含預覽）由 tools.ts 的 add() 依 annotations.readOnlyHint 自動處理。
 *
 * ── 預設只是預覽 ───────────────────────────────────────────────────────────
 * 寫入一律 dry_run 預設 true；建立類（上架、匯入進貨、刊物連結）dry_run=false 必帶 idempotency_key
 * （預覽會給一組）。預覽與寫入都記 mcp_audit_log。recognize_purchase_order 不改任何業務資料（辨識結果
 * 只是建議，與後台對話框相同），所以沒有 dry_run；要變成進貨一定要再呼叫 import_purchases。
 *
 * ── 刻意不做 ───────────────────────────────────────────────────────────────
 * 下架（removeInventoryListing）與解除刊物連結（unlinkPublication）在後台都是**刪掉型錄商品那一列**
 * （order_items.product_id 會被 set null）——刪除資料不開放給 MCP。要讓網站不再賣，用既有的
 * update_shop_product 把 status 設成 archived（下架）或 draft；連結與庫存都保留。商品／進貨刪除也不做。
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
  imageKeyFromArg,
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
import { OpenAIFileArg } from "./image-upload";
import { INV_PRODUCT_TYPES } from "@/lib/admin/schemas";

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
/** 辨識：存一張私有掃描圖、呼叫外部辨識服務；不改業務資料。 */
const RECOGNISE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
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

const localizedArg = (what: string) =>
  z
    .union([
      z.string().trim().min(1).max(20000),
      z
        .object({
          zh: z.string().trim().min(1).max(20000),
          en: z.string().max(60000).optional(),
          ja: z.string().max(60000).optional(),
        })
        .strict(),
    ])
    .describe(
      `${what}。三語：可以只給中文字串（英日文自動翻譯補上），或給 {"zh":…,"en":…,"ja":…}；缺的語言會自動翻譯。`,
    );

/** 可清空的文字欄位：null＝清掉，省略＝不改。 */
const nullableText = (max: number, what: string) =>
  z.string().trim().max(max).nullable().optional().describe(`${what}（null＝清空，省略＝不改）`);

/* ------------------------------------------------------------------ 輸入 schema */

export const CATALOG_INV_TOOL_INPUTS = {
  /* ---- 上架 ---- */
  list_inventory_listings: z.object({
    keyword: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("用品名／網址代稱／條碼篩選（包含這段字）"),
    limit: z.number().int().min(1).max(200).default(50).describe("每一份清單最多幾筆（預設 50）"),
  }),
  create_inventory_listing: z.object({
    inv_product_id: uuidArg("要上架的進銷存商品 id（見 list_inventory_listings 的 candidates）"),
    title: localizedArg("網站上的商品名稱（省略＝進銷存品名）").optional(),
    summary: localizedArg("摘要（必填，商品卡片與列表上的一句話）"),
    description: localizedArg("商品說明（省略＝同摘要）").optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "網址代稱只能是小寫英數與連字號")
      .optional()
      .describe("網址代稱（小寫英數與 -）。省略＝依英文名稱自動產生"),
    price: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("網站售價（整數元）。省略＝進銷存售價四捨五入（與後台上架表單相同）"),
    units_per_sale: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(1)
      .describe("賣出一件扣幾個庫存單位（預設 1）"),
    product_type: z
      .enum(["goods", "book"])
      .default("goods")
      .describe("goods 選物（預設）／book 書"),
    status: z
      .enum(["draft", "active"])
      .default("draft")
      .describe("draft 草稿（預設，網站看不到）／active 直接上架開賣"),
    image_key: z
      .string()
      .trim()
      .max(300)
      .nullable()
      .optional()
      .describe(
        "商品圖 key（先用 upload_image_* 上傳）。省略＝沿用進銷存商品的照片（若有），null＝不放圖",
      ),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),

  /* ---- 進銷存商品 ---- */
  update_inventory_product: z
    .object({
      id: uuidArg("進銷存商品 id（見 list_inventory／get_inventory_product）"),
      name: z.string().trim().min(1).max(200).optional().describe("商品名稱"),
      issue_number: nullableText(
        50,
        "期數／規格。series 相同的已上架商品會在商品頁出現規格切換，規格用「罐別:大罐｜口味:焦糖」格式（｜分隔各軸）",
      ),
      barcode: nullableText(64, "條碼／ISBN"),
      category_id: z.string().trim().uuid().nullable().optional().describe("分類 id（null＝清空）"),
      product_type: z
        .enum(INV_PRODUCT_TYPES)
        .optional()
        .describe("outright 買斷／consignment 寄賣／rental 租借"),
      series: nullableText(
        200,
        "系列。series 相同的已上架商品會在商品頁出現規格切換（各件的 issue_number 用「罐別:大罐｜口味:焦糖」格式）",
      ),
      publisher: nullableText(200, "出版社"),
      vendor_id: z.string().trim().uuid().nullable().optional().describe("供應商 id（null＝清空）"),
      selling_price: z
        .number()
        .min(0)
        .optional()
        .describe("售價（元）。調價審核開著時會變成待審調價，核准後才生效"),
      cost_price: z.number().min(0).optional().describe("成本（元）。同上，可能進待審"),
      low_stock_alert: z.number().int().min(0).optional().describe("低庫存警示數量"),
      pack_size: z.number().int().min(1).optional().describe("每組數量"),
      base_product_id: z
        .string()
        .trim()
        .uuid()
        .nullable()
        .optional()
        .describe("母品項 id（null＝清空）"),
      image_key: z
        .string()
        .trim()
        .max(300)
        .nullable()
        .optional()
        .describe("商品照片 key（先用 upload_image_* 上傳；null＝清空）"),
      notes: nullableText(2000, "備註"),
      unlimited_stock: z
        .boolean()
        .optional()
        .describe(
          "不限庫存（寄賣不限量）。只限寄賣品、非子品項；開啟後庫存 0 也能上架販售、網站不顯示數字、不進低庫存與盤點，成本用 cost_price。與後台商品編輯的「不限庫存」勾選相同",
        ),
      dry_run: dryRunArg,
    })
    .refine(
      (v) =>
        Object.keys(v).some(
          (k) => k !== "id" && k !== "dry_run" && v[k as keyof typeof v] !== undefined,
        ),
      "至少給一個要改的欄位",
    ),
  set_inventory_product_active: z.object({
    id: uuidArg("進銷存商品 id"),
    is_active: z.boolean().describe("true 恢復啟用／false 停用（櫃檯與進貨選單看不到）"),
    dry_run: dryRunArg,
  }),
  request_inventory_price_change: z.object({
    id: uuidArg("進銷存商品 id"),
    selling_price: z.number().min(0).describe("新售價（元）"),
    cost_price: z.number().min(0).optional().describe("新成本（元）。省略＝維持目前成本"),
    dry_run: dryRunArg,
  }),

  /* ---- 拍照辨識進貨單 ---- */
  recognize_purchase_order: z
    .object({
      image_base64: z
        .object({
          data: z
            .string()
            .min(1)
            .max(6_000_000)
            .describe("圖片 base64（可帶 data:image/…;base64, 前綴），原檔 2MB 以內"),
          content_type: z
            .enum(["image/jpeg", "image/png", "image/webp"])
            .optional()
            .describe("宣告格式（選填；給了就要跟內容一致）"),
        })
        .optional()
        .describe("只能傳 base64 的 AI（例如網頁版 Claude）用這個"),
      image_url: z
        .string()
        .trim()
        .url()
        .max(2000)
        .optional()
        .describe("圖片的公開 https 網址（JPEG／PNG／WebP，2MB 以內）"),
      file: OpenAIFileArg.optional().describe("ChatGPT 對話裡使用者拍的照片／貼上的圖"),
      upload_id: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "能跑 curl 的 AI：先用 create_image_upload_url 拿網址把照片 PUT 上去，再把回傳的 upload_id 給這裡（不要呼叫 finalize_image_upload——進貨單不能進公開圖片區）",
        ),
      scan_key: z
        .string()
        .trim()
        .regex(/^ocr:\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(webp|jpg|png)$/, "掃描圖代碼不正確")
        .optional()
        .describe("上一次辨識回傳的 scan_key（ocr:…），用同一張圖再辨識一次，不必重傳"),
      confirm: z
        .boolean()
        .default(false)
        .describe(
          "預設 false：只檢查參數、回報「將會上傳到私有掃描區並花一次辨識額度」，不上傳、不辨識、不下載。使用者同意後再用 true 呼叫才真的上傳＋辨識。",
        ),
    })
    .refine(
      (v) =>
        [v.image_base64, v.image_url, v.file, v.upload_id, v.scan_key].filter(
          (x) => x !== undefined,
        ).length === 1,
      "image_base64、image_url、file、upload_id、scan_key 要剛好給其中一個",
    ),
  import_purchases: z.object({
    rows: z
      .array(
        z.object({
          product_id: z
            .string()
            .trim()
            .uuid()
            .nullable()
            .optional()
            .describe(
              "對到的進銷存商品 id；null／省略＝由資料庫依條碼或「品名＋期數＋系列」比對，對不到就新建商品",
            ),
          name: z.string().trim().min(1).max(200).describe("品名（進貨單上的寫法）"),
          issue_number: z.string().trim().max(50).nullable().optional().describe("期數"),
          series: z.string().trim().max(200).nullable().optional().describe("系列"),
          barcode: z.string().trim().max(100).nullable().optional().describe("條碼／ISBN"),
          quantity: z.number().int().min(1).max(1_000_000).describe("進貨數量"),
          unit_cost: z.number().min(0).nullable().optional().describe("單位成本（元）"),
        }),
      )
      .min(1)
      .max(200)
      .describe(
        "要建立的進貨明細（通常是 recognize_purchase_order 的 suggested_import.rows，確認／修改後送出）",
      ),
    vendor_id: z.string().trim().uuid().optional().describe("供應商 id（與 vendor 二選一）"),
    vendor: z.string().trim().max(200).optional().describe("供應商名稱（對不到名單時的文字）"),
    purchase_date: dateArg("進貨日期，省略＝今天").optional(),
    notes: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe("備註（每一列都會帶，資料庫會加註「Excel 匯入」）"),
    category_id: z
      .string()
      .trim()
      .uuid()
      .optional()
      .describe("對不到而要新建的商品放進哪個分類（選填）"),
    scan_key: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe("來源掃描圖（recognize_purchase_order 的 scan_key），只記進稽核方便回查"),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),

  /* ---- 進貨單 ---- */
  update_purchase: z
    .object({
      id: uuidArg("進貨 id（見 list_purchases／get_purchase）"),
      item_name: nullableText(200, "進貨品名"),
      purchase_date: dateArg("進貨日期").optional(),
      quantity: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .optional()
        .describe("數量（已賣掉的件數以下改不了，資料庫會擋）"),
      unit_cost: z.number().min(0).nullable().optional().describe("單位成本（元，null＝清空）"),
      vendor_id: z.string().trim().uuid().nullable().optional().describe("供應商 id（null＝清空）"),
      vendor: nullableText(200, "供應商名稱（文字）"),
      publisher: nullableText(200, "出版社"),
      notes: nullableText(2000, "備註"),
      expiry_date: dateArg("有效期限").nullable().optional(),
      expiry_alert_days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .nullable()
        .optional()
        .describe("到期前幾天警示"),
      dry_run: dryRunArg,
    })
    .refine(
      (v) =>
        Object.keys(v).some(
          (k) => k !== "id" && k !== "dry_run" && v[k as keyof typeof v] !== undefined,
        ),
      "至少給一個要改的欄位",
    ),

  /* ---- 出版品對應進銷存 ---- */
  link_publication_to_inventory: z.object({
    publication_id: z.string().trim().min(1).max(200).describe("刊物 id（見 list_publications）"),
    inv_product_id: uuidArg("進銷存商品 id（見 list_inventory_listings 的 candidates）"),
    price: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("網站售價（整數元，至少 1）。省略＝進銷存售價四捨五入"),
    units_per_sale: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(1)
      .describe("賣出一件扣幾個庫存單位（預設 1）"),
    idempotency_key: idempotencyKeyArg,
    dry_run: dryRunArg,
  }),
} as const;

export type CatalogInvToolName = keyof typeof CATALOG_INV_TOOL_INPUTS;
type Args<N extends CatalogInvToolName> = z.output<(typeof CATALOG_INV_TOOL_INPUTS)[N]>;

/* ------------------------------------------------------------------ meta */

const PREVIEW = "預設 dry_run=true 只預覽；dry_run=false 才寫入。預覽與寫入都會記稽核。";
const OAUTH = "需要 OAuth 管理員身分。";

export const CATALOG_INV_TOOL_META: Record<
  CatalogInvToolName,
  {
    title: string;
    description: string;
    annotations: ToolAnnotations;
    _meta?: Record<string, unknown>;
  }
> = {
  list_inventory_listings: {
    title: "可上架／已上架的進銷存商品",
    description:
      "與後台 /admin/inventory-listing 同一份資料：candidates＝可以上架到網站的進銷存商品（已核准、啟用、有庫存、還沒上架），" +
      "listed＝已經上架的網站商品（網站售價、狀態、庫存與可售量並列）。拿 candidates 的 id 去 create_inventory_listing。唯讀。",
    annotations: READ_ONLY,
  },
  create_inventory_listing: {
    title: "把進銷存商品上架到網站",
    description:
      "與後台「上架」同一支（createInventoryListing）：建一件網站商品並連到這個進銷存商品，網站的庫存就是進銷存的庫存（網站商品自己不存庫存）。" +
      "只能上架 list_inventory_listings 的 candidates（已核准、啟用、有庫存、還沒上架——與後台下拉選單相同）；剛建的商品要先核准、進貨核准後才會出現。" +
      "預設 status=draft（網站看不到），確認後可直接 active，或之後用 update_shop_product 改狀態、圖、文案。三語只給中文會自動翻譯。" +
      "⚠️ 下架請用 update_shop_product 把 status 設 archived（MCP 不開放刪除網站商品）。" +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
  update_inventory_product: {
    title: "修改進銷存商品",
    description:
      "與後台商品「編輯」同一支 RPC（inv_save_product，同一份欄位驗證）：只送要改的欄位，其他維持原值。" +
      "改到售價或成本時：調價審核開著就變成待審調價（核准後才生效，用 approve_inventory_record 的 price_changes 以外請到後台審），關著就直接生效——預覽會說是哪一種。" +
      "庫存不能在這裡改（用進貨／在庫異動／盤點）；寄賣不限量的品項可設 unlimited_stock=true（只限寄賣、非子品項）。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  set_inventory_product_active: {
    title: "停用／恢復進銷存商品",
    description:
      "與後台商品列表「停用／恢復」同一支 RPC（inv_set_product_active）。停用後櫃檯、進貨選單看不到，庫存與紀錄都保留；" +
      "若這件商品還掛在上架中的網站商品上，結果會提醒你（網站仍可下單）——要一起下架請用 update_shop_product 設 archived。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  request_inventory_price_change: {
    title: "送出進銷存商品調價",
    description:
      "與後台商品內頁「調價」同一支 RPC（inv_request_price_change）：調價審核開著就進待審（核准前價格不變），關著就直接生效。" +
      "送出不需要 approve_price_changes 權限（與後台相同，審核才需要）。不影響已上架網站商品的網站售價（那個用 update_shop_product 改）。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  recognize_purchase_order: {
    title: "拍照辨識進貨單（只產生預覽）",
    description:
      "＝後台進貨頁「拍照辨識」：把進貨單照片存進私有掃描區（與後台同一支 uploadOcrScan），用同一支辨識（recognisePurchaseOrder）讀出廠商、日期與每一列品名／期數／數量／單價，" +
      "再用後台同一套規則比對既有商品與廠商。**不建立任何進貨**——回傳 suggested_import，請使用者逐列確認或修改後，再呼叫 import_purchases（先 dry_run 預覽）。" +
      "圖片給其中一種：image_base64（網頁版 Claude）、image_url（公開 https）、file（ChatGPT 對話裡的照片）、upload_id（能跑 curl：create_image_upload_url 傳完直接給 upload_id，不要 finalize）、scan_key（同一張重新辨識）。" +
      "JPEG／PNG／WebP，原檔 2MB 以內。每次辨識都會花辨識額度並記稽核。" +
      "預設 confirm=false 只檢查參數、說明將會做什麼（不上傳、不辨識、不花額度）；使用者同意後 confirm=true 才執行。" +
      OAUTH,
    annotations: RECOGNISE,
    _meta: { "openai/fileParams": ["file"] },
  },
  import_purchases: {
    title: "建立進貨（整批，拍照辨識確認後用）",
    description:
      "與後台「拍照辨識 → 確認匯入」／Excel 進貨匯入同一支 RPC（inv_import_purchases，整批一個交易：一列失敗全部不寫）。" +
      "每列有 product_id 就進到那件商品；沒有就由資料庫用條碼或「品名＋期數＋系列」比對，對不到會**新建商品（售價 0）**——預覽會列出哪幾列會新建，之後用 update_inventory_product 補售價。" +
      "進貨與新商品要不要審核由資料庫決定；核准後庫存才會加（approve_inventory_record）。單筆進貨也可以用 create_purchase。" +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
  update_purchase: {
    title: "修改進貨",
    description:
      "與後台進貨內頁「編輯」同一支 RPC（inv_save_purchase）：只送要改的欄位，其他維持原值；不能換商品（要換請到後台）。" +
      "改數量時庫存由資料庫 trigger 一起對齊；已經賣掉（FIFO 消耗）的件數以下會被資料庫擋。審核狀態不變。" +
      OAUTH +
      PREVIEW,
    annotations: WRITE,
  },
  link_publication_to_inventory: {
    title: "地方刊物連結進銷存（開賣）",
    description:
      "與後台「商品」頁刊物「連結進銷存」同一支（linkPublicationToInventory）：用刊物的名稱、出版單位、介紹、封面建一件網站書籍商品（代稱 pub-<刊物代稱>、直接上架），" +
      "並連到這個進銷存商品（庫存共用）。只能連 list_inventory_listings 的 candidates；已連結的刊物要先在後台解除。" +
      "⚠️ 解除連結在後台會刪掉網站商品，MCP 不開放；要停賣請用 update_shop_product 把那件商品設 archived。" +
      OAUTH +
      PREVIEW,
    annotations: CREATE,
  },
};

/* ------------------------------------------------------------------ 小工具 */

const NEXT_STEP = "這只是預覽，還沒有寫入。確認無誤後，用同樣的參數加上 dry_run=false 再呼叫一次。";

function notFound(what: string, id: string): never {
  throw new McpInputError(`找不到${what}「${id}」。請先用對應的 list_*／get_* 工具查 id。`);
}

function taipeiToday(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
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

async function oauthUserId(tool: string): Promise<string> {
  const { currentMcpActor } = await import("./actor");
  const actor = currentMcpActor();
  if (actor?.via === "oauth") return actor.user_id;
  throw new McpInputError(
    `${tool} 需要 OAuth 管理員身分：這個動作必須記錄是哪一位後台使用者操作的，` +
      "靜態 token 沒有對應的使用者。請改用 claude.ai／ChatGPT 連接器（OAuth）登入的連線。",
  );
}

/** 同 ops-write-tools.ts：佔用 idempotency_key（mcp_oauth_used_codes 一次性表，30 天）。 */
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

/** 與 tools.ts 同一條：有翻譯金鑰才回翻譯函式（金鑰一律經 env.ts 讀）。 */
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

/** 「查不到設定＝要審核」，與 inv.initial_approval_status() 同一個 fail-closed 語意（只用來預告）。 */
async function approvalOn(module: string): Promise<boolean> {
  const { listApprovalSettings } = await import("@/server/repos/inv-products");
  const settings = await listApprovalSettings();
  return settings.find((s) => s.module === module)?.is_enabled ?? true;
}

/**
 * 進銷存商品能不能上架／連結刊物：必須在 inv_listing_candidates 裡（與後台下拉選單同一份）。
 * 不在的話用商品那一列說清楚是哪一條沒過。
 */
async function requireCandidate(invProductId: string) {
  const { listInventoryCandidates } = await import("@/server/repos/inventory-listing");
  const candidates = await listInventoryCandidates();
  const hit = candidates.find((c) => c.inv_product_id === invProductId);
  if (hit) return hit;
  const { getAdminProduct } = await import("@/server/repos/inv-products");
  const p = await getAdminProduct(invProductId);
  if (!p) notFound("進銷存商品", invProductId);
  const why: string[] = [];
  if (p.listed_product_id)
    why.push(`已經上架過了（網站商品 ${p.listed_product_id}，狀態 ${p.listed_status ?? "?"}）`);
  if (p.approval_status !== "approved")
    why.push(`商品還沒核准（${p.approval_status}，用 approve_inventory_record）`);
  if (!p.is_active) why.push("商品已停用（set_inventory_product_active）");
  if (!(p.stock_quantity > 0) && !p.unlimited_stock)
    why.push(
      "庫存是 0（進貨核准後才有庫存；寄賣不限量的品項可用 update_inventory_product 開 unlimited_stock）",
    );
  throw new McpInputError(
    `「${p.name}」目前不能上架：${why.length ? why.join("；") : "不在可上架清單裡"}。與後台上架頁的下拉選單同一個條件。`,
  );
}

/* ------------------------------------------------------------------ 進銷存商品欄位 */

const PRODUCT_FIELDS = [
  "name",
  "issue_number",
  "barcode",
  "category_id",
  "product_type",
  "series",
  "publisher",
  "vendor_id",
  "selling_price",
  "cost_price",
  "low_stock_alert",
  "pack_size",
  "base_product_id",
  "image_key",
  "notes",
  "unlimited_stock",
] as const;

const PURCHASE_FIELDS = [
  "item_name",
  "purchase_date",
  "quantity",
  "unit_cost",
  "vendor_id",
  "vendor",
  "publisher",
  "notes",
  "expiry_date",
  "expiry_alert_days",
] as const;

/* ------------------------------------------------------------------ 圖片（辨識） */

type ScanSource = { source: string; detail?: Record<string, unknown> };

/** 驗過的 bytes 存進私有 ocr-scans（後台同一支 uploadOcrScan）。 */
async function storeOcrBytes(bytes: Uint8Array): Promise<{ key: string }> {
  const { uploadOcrScan, ImageUploadError } = await import("@/server/storage");
  try {
    return await uploadOcrScan(new File([bytes as BlobPart], "mcp-ocr-scan"));
  } catch (err) {
    if (err instanceof ImageUploadError) throw new McpInputError(err.message);
    throw err;
  }
}

/** 依參數取得圖片並存成 ocr:… key。scan_key 直接沿用。 */
async function scanKeyFromArgs(
  args: Args<"recognize_purchase_order">,
): Promise<{ scanKey: string } & ScanSource> {
  if (args.scan_key) return { scanKey: args.scan_key, source: "scan_key" };
  const up = await import("./image-upload");
  if (args.upload_id) {
    const { validated, stored } = await up.finalizeStagedUpload(
      args.upload_id,
      Date.now(),
      storeOcrBytes,
    );
    return { scanKey: stored.key, source: "upload_id", detail: up.imageSummary(validated) };
  }
  let bytes: Uint8Array;
  let declared: string | null = null;
  let detail: Record<string, unknown> = {};
  let source: string;
  if (args.image_base64) {
    bytes = up.decodeBase64Image(args.image_base64.data);
    declared = args.image_base64.content_type ?? null;
    source = "base64";
  } else if (args.image_url) {
    const { fetchRemoteImage } = await import("./remote-image");
    const fetched = await fetchRemoteImage(args.image_url);
    bytes = fetched.bytes;
    source = "url";
    detail = { host: new URL(fetched.finalUrl).hostname };
  } else if (args.file) {
    const { fetchRemoteImage } = await import("./remote-image");
    const fetched = await fetchRemoteImage(args.file.download_url, {
      allowHost: up.isOpenAIFileHost,
      hostError: (h) => `下載網址的主機 ${h} 不是 OpenAI 的檔案網域。一般網址請改用 image_url。`,
    });
    bytes = fetched.bytes;
    declared =
      args.file.mime_type && Object.hasOwn(up.MCP_IMAGE_TYPES, args.file.mime_type)
        ? args.file.mime_type
        : null;
    if (args.file.mime_type && !declared) {
      throw new McpInputError(`檔案類型 ${args.file.mime_type} 不收。只收 JPEG、PNG、WebP 圖片。`);
    }
    source = "chatgpt_file";
    // 🔴 不記 download_url（帶簽章）。
    detail = { file_id: args.file.file_id };
  } else {
    throw new McpInputError("沒有收到圖片");
  }
  const validated = up.validateImageBytes(bytes, declared);
  const stored = await storeOcrBytes(validated.bytes);
  return { scanKey: stored.key, source, detail: { ...detail, ...up.imageSummary(validated) } };
}

/**
 * recognize_purchase_order 的 confirm=false：只檢查參數，不上傳、不辨識、不下載、不消耗 upload_id。
 * base64 在本機就能驗格式與大小（純計算，沒有副作用），其他來源只說明將會怎麼取圖。
 */
async function recognisePreview(
  tool: string,
  args: Args<"recognize_purchase_order">,
): Promise<TextResult> {
  let source: string;
  let detail: Record<string, unknown> = {};
  if (args.scan_key) {
    source = "scan_key";
    detail = { scan_key: args.scan_key, will: "沿用已存好的掃描圖，不再上傳" };
  } else if (args.upload_id) {
    source = "upload_id";
    detail = { will: "把這個 upload_id 暫存的照片搬進私有掃描區（upload_id 會被用掉）" };
  } else if (args.image_base64) {
    source = "base64";
    const up = await import("./image-upload");
    // 兩支都只丟 McpInputError（格式、大小不對），純計算。
    const validated = up.validateImageBytes(
      up.decodeBase64Image(args.image_base64.data),
      args.image_base64.content_type ?? null,
    );
    detail = { ...up.imageSummary(validated), will: "存進私有掃描區" };
  } else if (args.image_url) {
    source = "url";
    detail = { host: new URL(args.image_url).hostname, will: "下載這張圖並存進私有掃描區" };
  } else if (args.file) {
    source = "chatgpt_file";
    detail = { file_id: args.file.file_id, will: "下載這張圖並存進私有掃描區" };
  } else {
    throw new McpInputError("沒有收到圖片");
  }
  await audit(tool, "ocr_scan", "(未上傳)", "recognise_preview", { source, ...detail }, true);
  return jsonText({
    dry_run: true,
    confirm: false,
    written: false,
    uploaded: false,
    recognised: false,
    source,
    ...detail,
    will_do: [
      "把照片存進私有掃描區（ocr-scans，不公開、不進網站圖片區）",
      "呼叫辨識服務讀出廠商、日期與每一列品項——會花一次辨識額度",
      "不會建立任何進貨（辨識結果只是建議，之後要 import_purchases）",
    ],
    next_step:
      "還沒有上傳也還沒有辨識。請先跟使用者確認要花一次辨識額度，同意後用同樣的參數加上 confirm=true 再呼叫一次。",
  });
}

/* ------------------------------------------------------------------ handlers */

const IMPL: { [N in CatalogInvToolName]: (args: Args<N>) => Promise<TextResult> } = {
  async list_inventory_listings(args) {
    const { listInventoryCandidates, listListedInventoryProducts } =
      await import("@/server/repos/inventory-listing");
    const [candidates, listed] = await Promise.all([
      listInventoryCandidates(),
      listListedInventoryProducts(),
    ]);
    const kw = args.keyword?.toLowerCase();
    const has = (...vals: (string | null | undefined)[]) =>
      !kw || vals.some((v) => (v ?? "").toLowerCase().includes(kw));
    const c = candidates.filter((r) => has(r.name, r.barcode));
    const l = listed.filter((r) => has(r.inv_name, r.slug, r.title?.zh));
    return jsonText({
      candidates: {
        total: c.length,
        rows: c.slice(0, args.limit).map((r) => ({
          id: r.inv_product_id,
          name: r.name,
          selling_price: r.selling_price,
          stock_quantity: r.stock_quantity,
          pack_size: r.pack_size,
          barcode: r.barcode,
          unlimited_stock: r.unlimited_stock === true,
        })),
      },
      listed: {
        total: l.length,
        rows: l.slice(0, args.limit).map((r) => ({
          product_id: r.product_id,
          slug: r.slug,
          title: r.title?.zh ?? null,
          price: r.price,
          status: r.status,
          inv_product_id: r.inv_product_id,
          inv_name: r.inv_name,
          units_per_sale: r.units_per_sale,
          stock_quantity: r.stock_quantity,
          reserved: r.reserved,
          available: r.unlimited_stock ? "不限量" : r.available,
          unlimited_stock: r.unlimited_stock === true,
        })),
      },
      note: "candidates 只列已核准、啟用、有庫存（或不限庫存）、還沒上架的進銷存商品（與後台上架頁相同）。",
    });
  },

  async create_inventory_listing(args) {
    const tool = "create_inventory_listing";
    await oauthUserId(tool);
    const candidate = await requireCandidate(args.inv_product_id);
    const { getAdminProduct } = await import("@/server/repos/inv-products");
    const invRow = await getAdminProduct(args.inv_product_id);

    const t = await translator();
    const translated: string[] = [];
    const fill = async (field: string, v: LocalizedArg): Promise<Localized> => {
      const r = await fillLocalized(field, v, t);
      if (r.translated) translated.push(field);
      return r.value;
    };
    const title = await fill("title", args.title ?? candidate.name);
    const summary = await fill("summary", args.summary);
    const description = args.description ? await fill("description", args.description) : summary;

    let imageKey: string | null = null;
    if (args.image_key !== undefined) {
      imageKey = imageKeyFromArg(args.image_key);
    } else if (invRow?.image_key) {
      // 沿用進銷存照片：只收網站圖片區的 key（storage:…），其他格式略過不帶。
      try {
        imageKey = imageKeyFromArg(invRow.image_key);
      } catch {
        imageKey = null;
      }
    }

    const { slugFromTitle } = await import("@/lib/admin/unified-products");
    const slug = args.slug ?? slugFromTitle(title.en, Math.random().toString(36).slice(2, 7));
    const { inventoryListingSchema } = await import("@/lib/admin/schemas");
    const data = validateWith(inventoryListingSchema, {
      inv_product_id: args.inv_product_id,
      slug,
      title,
      summary,
      description,
      price: args.price ?? Math.round(Number(candidate.selling_price)),
      units_per_sale: args.units_per_sale,
      product_type: args.product_type,
      status: args.status,
      image_key: imageKey,
    });

    const { findProductConflicts } = await import("@/server/repos/products");
    const conflicts = await findProductConflicts({ titleZh: "", slug: data.slug });
    if (conflicts.sameSlug.some((p) => p.slug.toLowerCase() === data.slug.toLowerCase())) {
      throw new McpInputError(
        `網址代稱「${data.slug}」已經被使用了，請換一個（或不要送，讓系統自動產生）。`,
      );
    }

    const warnings: string[] = [];
    if (data.units_per_sale > 1 && candidate.stock_quantity < data.units_per_sale) {
      warnings.push(
        `目前庫存 ${candidate.stock_quantity}，不夠賣一件（每件扣 ${data.units_per_sale}）。`,
      );
    }
    if (!data.image_key)
      warnings.push("沒有商品圖，網站會顯示預設圖。可先用 upload_image_* 上傳再給 image_key。");

    const auditChanges = { ...data, translated };
    if (args.dry_run) {
      const key = args.idempotency_key ?? randomUUID();
      return preview(
        tool,
        "product",
        "(未建立)",
        "create_listing",
        {
          idempotency_key: key,
          confirm_args: confirmArgs(args, {
            title: data.title,
            summary: data.summary,
            description: data.description,
            slug: data.slug,
            price: data.price,
            image_key: data.image_key,
            idempotency_key: key,
          }),
          next_step: CONFIRM_ARGS_NEXT_STEP,
          will_create: {
            ...data,
            stock: "由進銷存決定（網站商品不存庫存）",
            inventory: {
              id: candidate.inv_product_id,
              name: candidate.name,
              selling_price: candidate.selling_price,
              stock_quantity: candidate.stock_quantity,
            },
          },
          ...(translated.length ? { translated } : {}),
          ...(warnings.length ? { warnings } : {}),
        },
        auditChanges,
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const { createInventoryListing } = await import("@/server/repos/inventory-listing");
    const res = await commitOrAudit(
      tool,
      "product",
      "(未建立)",
      "create_listing",
      auditChanges,
      () => createInventoryListing(data),
    );
    return committed(
      tool,
      "product",
      res.product_id,
      "create_listing",
      {
        written: true,
        product_id: res.product_id,
        slug: data.slug,
        status: data.status,
        write_note: writeTimeNote(translated, args.slug ? null : data.slug),
        ...(data.status === "draft"
          ? { next_step: "目前是草稿，網站看不到。要開賣用 update_shop_product 設 status=active。" }
          : {}),
      },
      { ...auditChanges, result: res },
    );
  },

  async update_inventory_product(args) {
    const tool = "update_inventory_product";
    const userId = await oauthUserId(tool);
    const { getAdminProduct } = await import("@/server/repos/inv-products");
    const row = await getAdminProduct(args.id);
    if (!row) notFound("進銷存商品", args.id);

    const before: Record<string, unknown> = {};
    for (const k of PRODUCT_FIELDS)
      before[k] = (row as unknown as Record<string, unknown>)[k] ?? null;
    // 0062：旗標是 not null boolean；舊資料列（或還沒讀到這一欄）一律當 false。
    before.unlimited_stock = row.unlimited_stock === true;
    const next: Record<string, unknown> = { ...before };
    for (const k of PRODUCT_FIELDS) {
      const v = (args as Record<string, unknown>)[k];
      if (v !== undefined) next[k] = v;
    }
    if (args.image_key !== undefined)
      next.image_key = imageKeyFromArg(args.image_key, [row.image_key]);
    if (args.base_product_id && args.base_product_id === args.id) {
      throw new McpInputError("母品項不能是自己");
    }

    const { invProductSchema } = await import("@/lib/admin/schemas");
    // 與後台 ProductForm 編輯送出的形狀相同（id 有值、purchase=null）。
    const data = validateWith(invProductSchema, {
      id: args.id,
      ...next,
      selling_price: next.selling_price ?? 0,
      low_stock_alert: next.low_stock_alert ?? 5,
      pack_size: next.pack_size ?? 1,
      purchase: null,
    });
    const { id: _id, purchase: _purchase, ...payload } = data;
    const changes = diff(before, payload as Record<string, unknown>, PRODUCT_FIELDS);
    if (Object.keys(changes).length === 0) {
      return jsonText({
        dry_run: args.dry_run,
        written: false,
        note: "沒有任何欄位改變，不需要寫入。",
      });
    }

    // 外鍵目標存在（預覽就講清楚，不等 RPC 丟外鍵錯誤）。
    if (changes.category_id && payload.category_id) {
      const { listAdminCategories } = await import("@/server/repos/inv-products");
      if (!(await listAdminCategories()).some((c) => c.category_id === payload.category_id))
        notFound("分類", payload.category_id);
    }
    if (changes.vendor_id && payload.vendor_id) {
      const { listAdminVendors } = await import("@/server/repos/inv-products");
      if (!(await listAdminVendors()).some((v) => v.vendor_id === payload.vendor_id))
        notFound("供應商", payload.vendor_id);
    }
    if (changes.base_product_id && payload.base_product_id) {
      if (!(await getAdminProduct(payload.base_product_id)))
        notFound("母品項", payload.base_product_id);
    }

    const priceTouched = Boolean(changes.selling_price || changes.cost_price);
    const priceNeedsApproval = priceTouched && (await approvalOn("price_changes"));
    const notes: string[] = [];
    if (priceNeedsApproval) {
      notes.push(
        "調價審核開著：售價／成本會變成待審調價，核准後才生效（目前價格不變）；其他欄位立即生效。",
      );
    }
    if (row.listed_product_id && changes.selling_price) {
      notes.push(
        `這件已上架到網站（${row.listed_slug ?? row.listed_product_id}），網站售價不會跟著變，要改請用 update_shop_product。`,
      );
    }
    const auditChanges = { changes };
    if (args.dry_run) {
      return preview(
        tool,
        "inv_product",
        args.id,
        "update",
        {
          product: { id: row.inv_product_id, name: row.name },
          changes,
          ...(notes.length ? { notes } : {}),
        },
        auditChanges,
      );
    }
    const { saveProduct } = await import("@/server/repos/inv-products");
    const res = await commitOrAudit(tool, "inv_product", args.id, "update", auditChanges, () =>
      saveProduct({ userId, id: args.id, payload, purchase: null }),
    );
    return committed(
      tool,
      "inv_product",
      args.id,
      "update",
      {
        written: true,
        changes,
        price_change_pending: res.price_change_pending,
        ...(res.price_change_pending ? { note: "價格變更已送待審，核准後才生效。" } : {}),
      },
      { ...auditChanges, result: res },
    );
  },

  async set_inventory_product_active(args) {
    const tool = "set_inventory_product_active";
    const userId = await oauthUserId(tool);
    const { getAdminProduct } = await import("@/server/repos/inv-products");
    const row = await getAdminProduct(args.id);
    if (!row) notFound("進銷存商品", args.id);
    const changes = diff({ is_active: row.is_active }, { is_active: args.is_active }, [
      "is_active",
    ]);
    if (Object.keys(changes).length === 0) {
      return jsonText({
        dry_run: args.dry_run,
        written: false,
        note: `「${row.name}」已經是${row.is_active ? "啟用" : "停用"}狀態，不需要寫入。`,
      });
    }
    const warning =
      !args.is_active && row.listed_product_id && row.listed_status === "active"
        ? `這件還掛在上架中的網站商品（${row.listed_slug ?? row.listed_product_id}）上：網站仍可下單但櫃檯出不了貨。要一起下架請用 update_shop_product 設 status=archived。`
        : null;
    if (args.dry_run) {
      return preview(
        tool,
        "inv_product",
        args.id,
        "set_active",
        {
          product: { id: row.inv_product_id, name: row.name },
          changes,
          ...(warning ? { warning } : {}),
        },
        changes,
      );
    }
    const { setProductActive } = await import("@/server/repos/inv-products");
    const res = await commitOrAudit(tool, "inv_product", args.id, "set_active", changes, () =>
      setProductActive({ userId, id: args.id, isActive: args.is_active }),
    );
    return committed(
      tool,
      "inv_product",
      args.id,
      "set_active",
      {
        written: true,
        result: res,
        ...(!res.is_active && res.listed_count > 0
          ? {
              warning: `「${res.name}」已停用，但還掛在 ${res.listed_count} 件上架中的網站商品上——網站買得下去但櫃檯出不了貨。請用 update_shop_product 設 status=archived。`,
            }
          : {}),
      },
      { ...changes, result: res },
    );
  },

  async request_inventory_price_change(args) {
    const tool = "request_inventory_price_change";
    const userId = await oauthUserId(tool);
    const { getAdminProduct } = await import("@/server/repos/inv-products");
    const row = await getAdminProduct(args.id);
    if (!row) notFound("進銷存商品", args.id);
    const { priceChangeSchema } = await import("@/lib/admin/schemas");
    const data = validateWith(priceChangeSchema, {
      id: args.id,
      cost_price: args.cost_price ?? null,
      selling_price: args.selling_price,
    });
    const needs = await approvalOn("price_changes");
    const change = {
      selling_price: { before: row.selling_price, after: data.selling_price },
      cost_price: { before: row.cost_price, after: data.cost_price ?? row.cost_price },
    };
    const warnings: string[] = [];
    if (row.price_change_status === "pending") {
      warnings.push(
        `已經有一筆待審調價（售價 ${row.pending_selling_price ?? "?"}、成本 ${row.pending_cost_price ?? "?"}），送出會覆蓋它。`,
      );
    }
    if (row.listed_product_id) {
      warnings.push(
        `這件已上架到網站（${row.listed_slug ?? row.listed_product_id}），網站售價不會跟著變，要改請用 update_shop_product。`,
      );
    }
    const auditChanges = { change, needs_approval: needs };
    if (args.dry_run) {
      return preview(
        tool,
        "inv_product",
        args.id,
        "price_change",
        {
          product: { id: row.inv_product_id, name: row.name },
          change,
          effect: needs ? "進待審：核准後才生效（目前價格不變）" : "調價審核關著：送出後立即生效",
          ...(warnings.length ? { warnings } : {}),
        },
        auditChanges,
      );
    }
    const { requestPriceChange } = await import("@/server/repos/inv-products");
    const res = await commitOrAudit(
      tool,
      "inv_product",
      args.id,
      "price_change",
      auditChanges,
      () =>
        requestPriceChange({
          userId,
          id: args.id,
          costPrice: data.cost_price,
          sellingPrice: data.selling_price,
        }),
    );
    return committed(
      tool,
      "inv_product",
      args.id,
      "price_change",
      {
        written: true,
        result: res,
        note: res.pending ? "已送待審，核准後才生效。" : "已直接生效。",
      },
      { ...auditChanges, result: res },
    );
  },

  async recognize_purchase_order(args) {
    const tool = "recognize_purchase_order";
    await oauthUserId(tool);
    if (!args.confirm) return recognisePreview(tool, args);
    const scan = await scanKeyFromArgs(args);

    const [{ recognisePurchaseOrder, OcrError }, { listPosProducts }, purchasesRepo] =
      await Promise.all([
        import("@/server/gemini"),
        import("@/server/repos/inv-sales"),
        import("@/server/repos/inv-purchases"),
      ]);
    // 與 fns/ocr.ts 相同：已知商品截 300 筆當比對提示。
    const knownProducts = (await listPosProducts()).slice(0, 300).map((p) => ({
      name: p.name,
      issue_number: p.issue_number,
      series: p.series,
    }));

    let result: Awaited<ReturnType<typeof recognisePurchaseOrder>>;
    try {
      result = await recognisePurchaseOrder({ scanKey: scan.scanKey, knownProducts });
    } catch (err) {
      if (err instanceof OcrError) {
        await audit(
          tool,
          "ocr_scan",
          scan.scanKey,
          "recognise_failed",
          { source: scan.source, ...scan.detail, kind: err.kind, error: err.message },
          false,
        );
        return errText(
          `辨識失敗（${err.kind}）：${err.message}` +
            (err.kind === "timeout" || err.kind === "service" || err.kind === "quota"
              ? `。圖已存好，稍後可用 scan_key「${scan.scanKey}」重新辨識，不必重傳。`
              : "。請重拍（光線充足、整張單子入鏡）或改用 import_purchases／create_purchase 手動輸入。"),
        );
      }
      throw err;
    }

    // 配對：與後台確認表同一支純函式（lib/admin/ocr-match.ts、ocr-purchase-map.ts）。
    const [{ matchOcrProduct, ocrMatchCandidates, describeProduct }, { toPurchaseOptions }] =
      await Promise.all([import("@/lib/admin/ocr-match"), import("@/lib/admin/ocr-purchase-map")]);
    const [products, formOptions] = await Promise.all([
      purchasesRepo.listProductPickerRows(),
      purchasesRepo.listPurchaseFormOptions(),
    ]);
    const options = toPurchaseOptions(formOptions.vendors, result);
    const items = result.items.map((item, index) => {
      const matched = matchOcrProduct(products, item);
      const candidates = matched
        ? []
        : ocrMatchCandidates(products, item, 3).map((p) => ({
            id: p.inv_product_id,
            label: describeProduct(p),
          }));
      return {
        line: index + 1,
        ...item,
        matched_product: matched
          ? {
              id: matched.inv_product_id,
              label: describeProduct(matched),
              cost_price: matched.cost_price,
            }
          : null,
        ...(candidates.length ? { candidates } : {}),
        will: matched
          ? "進到既有商品"
          : "對不到既有商品：匯入時會新建商品（售價 0），或請使用者從 candidates 選一個",
      };
    });
    const vendorName = options.vendor_id
      ? (formOptions.vendors.find((v) => v.vendor_id === options.vendor_id)?.name ?? null)
      : null;

    await audit(
      tool,
      "ocr_scan",
      scan.scanKey,
      "recognise",
      {
        source: scan.source,
        ...scan.detail,
        vendor: result.vendor,
        purchase_date: result.purchase_date,
        items: result.items.length,
        matched: items.filter((i) => i.matched_product).length,
      },
      false,
    );
    return jsonText({
      written: false,
      scan_key: scan.scanKey,
      recognised: {
        vendor: result.vendor,
        vendor_match: options.vendor_id ? { id: options.vendor_id, name: vendorName } : null,
        purchase_date: result.purchase_date,
        notes: result.notes,
      },
      items,
      suggested_import: {
        rows: items.map((i) => ({
          product_id: i.matched_product?.id ?? null,
          name: i.name,
          issue_number: i.issue_number,
          series: i.series,
          quantity: i.quantity,
          unit_cost: i.unit_cost,
        })),
        ...(options.vendor_id
          ? { vendor_id: options.vendor_id }
          : options.vendor
            ? { vendor: options.vendor }
            : {}),
        purchase_date: options.purchase_date,
        ...(options.notes ? { notes: options.notes } : {}),
        scan_key: scan.scanKey,
      },
      next_step:
        "這只是辨識結果，還沒有建立任何進貨。請把 items 念給使用者確認（品名、期數、數量、單價、對到的商品），" +
        "修改後把 suggested_import 交給 import_purchases（先 dry_run=true 預覽，再 dry_run=false）。模型可能讀錯數字，一定要人確認。",
    });
  },

  async import_purchases(args) {
    const tool = "import_purchases";
    const userId = await oauthUserId(tool);
    if (args.vendor_id && args.vendor) {
      throw new McpInputError("vendor_id 與 vendor 只能給一個");
    }
    const purchasesRepo = await import("@/server/repos/inv-purchases");
    const [products, formOptions] = await Promise.all([
      purchasesRepo.listProductPickerRows(),
      purchasesRepo.listPurchaseFormOptions(),
    ]);
    if (args.vendor_id && !formOptions.vendors.some((v) => v.vendor_id === args.vendor_id))
      notFound("供應商", args.vendor_id);
    if (args.category_id && !formOptions.categories.some((c) => c.category_id === args.category_id))
      notFound("分類", args.category_id);

    const { getAdminProduct } = await import("@/server/repos/inv-products");
    const purchaseDate = args.purchase_date ?? taipeiToday();
    // 與後台 PurchaseOCRDialog#runImport 送出的形狀逐欄相同。
    const rows = args.rows.map((r) => ({
      product_id: r.product_id ?? null,
      name: r.name,
      issue_number: r.issue_number ?? null,
      series: r.series ?? null,
      barcode: r.barcode ?? null,
      quantity: r.quantity,
      unit_cost: r.unit_cost ?? null,
      vendor_id: args.vendor_id ?? null,
      vendor: args.vendor_id ? null : (args.vendor ?? null),
      purchase_date: purchaseDate,
      notes: args.notes ?? null,
      expiry_date: null,
      expiry_alert_days: null,
      product_type: null,
      category_id: args.category_id ?? null,
    }));
    const { importPurchasesSchema } = await import("@/lib/admin/schemas");
    const data = validateWith(importPurchasesSchema, {
      rows,
      options: {
        default_vendor_id: args.vendor_id ?? null,
        default_category_id: args.category_id ?? null,
        default_purchase_date: purchaseDate,
        default_expiry_alert_days: null,
      },
    });

    // 預告每一列會進到哪裡（資料庫比對：條碼 → 品名＋期數＋系列完全相同，不分大小寫）。
    const low = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
    const lines = [];
    for (const [i, r] of data.rows.entries()) {
      let target: { id: string; name: string; how: string } | null = null;
      if (r.product_id) {
        const p = await getAdminProduct(r.product_id);
        if (!p) notFound(`第 ${i + 1} 列的進銷存商品`, r.product_id);
        target = { id: p.inv_product_id, name: p.name, how: "指定" };
      } else {
        const hit =
          (r.barcode ? products.find((p) => low(p.barcode) === low(r.barcode)) : undefined) ??
          products.find(
            (p) =>
              low(p.name) === low(r.name) &&
              low(p.issue_number) === low(r.issue_number) &&
              low(p.series) === low(r.series),
          );
        if (hit) target = { id: hit.inv_product_id, name: hit.name, how: "比對" };
      }
      lines.push({
        line: i + 1,
        name: r.name,
        issue_number: r.issue_number,
        quantity: r.quantity,
        unit_cost: r.unit_cost,
        subtotal: r.unit_cost === null ? null : r.unit_cost * r.quantity,
        product: target ?? { new_product: true, note: "會新建商品（售價 0、庫存從這筆進貨開始）" },
      });
    }
    const newCount = lines.filter((l) => "new_product" in l.product).length;
    const [purchaseApproval, productApproval] = await Promise.all([
      approvalOn("purchases"),
      approvalOn("products"),
    ]);
    const auditChanges = {
      rows: data.rows.length,
      new_products_estimated: newCount,
      vendor_id: args.vendor_id ?? null,
      vendor: args.vendor ?? null,
      purchase_date: purchaseDate,
      scan_key: args.scan_key ?? null,
      lines: lines.map((l) => ({ name: l.name, quantity: l.quantity, unit_cost: l.unit_cost })),
    };
    if (args.dry_run) {
      return preview(
        tool,
        "inv_purchase",
        "(未建立)",
        "import",
        {
          idempotency_key: args.idempotency_key ?? randomUUID(),
          will_create: {
            purchases: lines,
            total_quantity: lines.reduce((n, l) => n + l.quantity, 0),
            total_cost: lines.reduce((n, l) => n + (l.subtotal ?? 0), 0),
            vendor: args.vendor_id
              ? {
                  id: args.vendor_id,
                  name: formOptions.vendors.find((v) => v.vendor_id === args.vendor_id)?.name,
                }
              : (args.vendor ?? null),
            purchase_date: purchaseDate,
            approval: purchaseApproval
              ? "進貨需要核准，核准後庫存才會加（approve_inventory_record）"
              : "進貨不需審核，建立後庫存直接增加",
          },
          ...(newCount
            ? {
                warnings: [
                  `預估有 ${newCount} 列對不到既有商品，會新建商品（售價 0` +
                    (productApproval ? "，需要核准" : "") +
                    "）。若其實是既有商品，請給 product_id；新建的之後用 update_inventory_product 補售價。",
                ],
              }
            : {}),
          note: "整批一個交易：任何一列失敗就全部不寫。實際比對以資料庫為準。",
        },
        auditChanges,
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const res = await commitOrAudit(tool, "inv_purchase", "(未建立)", "import", auditChanges, () =>
      purchasesRepo.importPurchases({
        userId,
        rows: data.rows as unknown as Record<string, unknown>[],
        options: data.options as unknown as Record<string, unknown>,
      }),
    );
    return committed(
      tool,
      "inv_purchase",
      `(${res.purchases_created} 筆)`,
      "import",
      {
        written: true,
        result: res,
        ...(res.needs_approval
          ? {
              next_step:
                "進貨待審：用 list_pending_approvals → approve_inventory_record 核准後庫存才會加。",
            }
          : {}),
      },
      { ...auditChanges, result: res },
    );
  },

  async update_purchase(args) {
    const tool = "update_purchase";
    const userId = await oauthUserId(tool);
    const { getAdminPurchase } = await import("@/server/repos/inv-purchases");
    const row = await getAdminPurchase(args.id);
    if (!row) notFound("進貨", args.id);

    // 與後台 PurchaseForm 的初值相同：vendor 文字欄位來自 vendor_text。
    const before: Record<string, unknown> = {
      item_name: row.item_name,
      purchase_date: row.purchase_date,
      quantity: row.quantity,
      unit_cost: row.unit_cost,
      vendor_id: row.vendor_id,
      vendor: row.vendor_text,
      publisher: row.publisher,
      notes: row.notes,
      expiry_date: row.expiry_date,
      expiry_alert_days: row.expiry_alert_days,
    };
    const next: Record<string, unknown> = { ...before };
    for (const k of PURCHASE_FIELDS) {
      const v = (args as Record<string, unknown>)[k];
      if (v !== undefined) next[k] = v;
    }
    if (next.expiry_date === null) next.expiry_alert_days = null;

    const { invPurchaseSchema } = await import("@/lib/admin/schemas");
    const data = validateWith(invPurchaseSchema, {
      id: args.id,
      product_id: row.product_id,
      ...next,
    });
    // 與 fns/inv-purchases.ts#savePurchase 相同：編輯不送 product_id。
    const { id: _id, product_id: _pid, ...payload } = data;
    const changes = diff(before, payload as Record<string, unknown>, PURCHASE_FIELDS);
    if (Object.keys(changes).length === 0) {
      return jsonText({
        dry_run: args.dry_run,
        written: false,
        note: "沒有任何欄位改變，不需要寫入。",
      });
    }
    if (changes.vendor_id && payload.vendor_id) {
      const { listPurchaseFormOptions } = await import("@/server/repos/inv-purchases");
      const opts = await listPurchaseFormOptions();
      if (!opts.vendors.some((v) => v.vendor_id === payload.vendor_id))
        notFound("供應商", payload.vendor_id);
    }
    const warnings: string[] = [];
    if (changes.quantity && payload.quantity < row.consumed_quantity) {
      throw new McpInputError(
        `這批已經賣掉 ${row.consumed_quantity} 件，數量不能改成 ${payload.quantity}（資料庫也會擋）。要扣庫存請用 create_stock_adjustment。`,
      );
    }
    if (changes.quantity && row.approval_status === "approved") {
      warnings.push(`已核准的進貨：庫存會跟著 ${row.quantity} → ${payload.quantity} 調整。`);
    }
    if (changes.unit_cost && row.consumed_quantity > 0) {
      warnings.push(`這批已賣掉 ${row.consumed_quantity} 件，已入帳的銷售成本不會回頭重算。`);
    }
    const auditChanges = { changes };
    if (args.dry_run) {
      return preview(
        tool,
        "inv_purchase",
        args.id,
        "update",
        {
          purchase: {
            id: row.purchase_id,
            product: row.product_name,
            approval_status: row.approval_status,
            consumed_quantity: row.consumed_quantity,
          },
          changes,
          ...(warnings.length ? { warnings } : {}),
        },
        auditChanges,
      );
    }
    const { savePurchase } = await import("@/server/repos/inv-purchases");
    const res = await commitOrAudit(tool, "inv_purchase", args.id, "update", auditChanges, () =>
      savePurchase({ userId, id: args.id, payload }),
    );
    return committed(
      tool,
      "inv_purchase",
      args.id,
      "update",
      { written: true, changes, result: res },
      { ...auditChanges, result: res },
    );
  },

  async link_publication_to_inventory(args) {
    const tool = "link_publication_to_inventory";
    await oauthUserId(tool);
    const { getPublicationById } = await import("@/server/repos/publications");
    const pub = await getPublicationById(args.publication_id);
    if (!pub) notFound("刊物", args.publication_id);
    if (pub.product_id) {
      throw new McpInputError(
        `這本刊物已經連到網站商品 ${pub.product_id}。要換連結請到後台先解除（MCP 不開放解除，因為會刪掉網站商品）。`,
      );
    }
    const candidate = await requireCandidate(args.inv_product_id);
    const { publicationLinkSchema } = await import("@/lib/admin/schemas");
    const data = validateWith(publicationLinkSchema, {
      publication_id: args.publication_id,
      inv_product_id: args.inv_product_id,
      price: args.price ?? Math.round(Number(candidate.selling_price)),
      units_per_sale: args.units_per_sale,
    });
    const slug = `pub-${pub.slug}`;
    const { findProductConflicts } = await import("@/server/repos/products");
    const conflicts = await findProductConflicts({ titleZh: "", slug });
    if (conflicts.sameSlug.some((p) => p.slug.toLowerCase() === slug.toLowerCase())) {
      throw new McpInputError(
        `網址代稱「${slug}」已經被使用了（可能有舊的同名商品），請到後台處理。`,
      );
    }
    const auditChanges = { ...data, slug };
    if (args.dry_run) {
      return preview(
        tool,
        "publication",
        pub.id,
        "link_inventory",
        {
          idempotency_key: args.idempotency_key ?? randomUUID(),
          publication: { id: pub.id, title: pub.title?.zh ?? null, is_published: pub.is_published },
          will_create: {
            product: {
              slug,
              product_type: "book",
              status: "active（立即可在網站購買）",
              title: pub.title,
              summary: pub.publisher,
              price: data.price,
              image_key: pub.cover_image_key,
            },
            inventory: {
              id: candidate.inv_product_id,
              name: candidate.name,
              selling_price: candidate.selling_price,
              stock_quantity: candidate.stock_quantity,
            },
            units_per_sale: data.units_per_sale,
          },
        },
        auditChanges,
      );
    }
    await claimIdempotencyKey(tool, args.idempotency_key);
    const { linkPublicationToInventory } = await import("@/server/repos/publications");
    const res = await commitOrAudit(
      tool,
      "publication",
      pub.id,
      "link_inventory",
      auditChanges,
      () => linkPublicationToInventory(data),
    );
    return committed(
      tool,
      "publication",
      pub.id,
      "link_inventory",
      { written: true, product_id: res.product_id, slug },
      { ...auditChanges, result: res },
    );
  },
};

/* ------------------------------------------------------------------ 包裝 */

function wrap<N extends CatalogInvToolName>(name: N): (args: unknown) => Promise<TextResult> {
  const schema = CATALOG_INV_TOOL_INPUTS[name] as unknown as {
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
        `[mcp/catalog-inventory] ${name} 失敗`,
        err instanceof Error ? err.message : err,
      );
      return errText(`執行失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export const CATALOG_INV_HANDLERS = Object.fromEntries(
  (Object.keys(CATALOG_INV_TOOL_INPUTS) as CatalogInvToolName[]).map((n) => [n, wrap(n)]),
) as { [N in CatalogInvToolName]: (args: Args<N> | unknown) => Promise<TextResult> };
