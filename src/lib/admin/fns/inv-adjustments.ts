/**
 * 在庫異動與庫存盤點的 server functions。
 *
 * ── 授權 ──────────────────────────────────────────────────────────────────
 *   staffFnMiddleware()                          建單、盤點、送出、沖帳（日常作業）
 *   staffFnMiddleware() + 細權限檢查              審核（approve_stock_adjustments）
 *
 * ⚠️ **側欄隱藏不是授權**。擋住直接打 `/_serverFn/…` 的只有 `.middleware([...])`。
 * ⚠️ 一個字都沒有動到 adminFnMiddleware 與 requireAdmin()。
 *
 * ── 這裡沒有「盤點」與「在庫異動」兩套函式 ────────────────────────────────
 * 它們寫的是同一張 inv.stock_adjustments。盤點只是 category='ADJ' 而且差異由
 * 資料庫算的那條路徑（recordStockCount），其他五類走 saveAdjustment。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { staffFnMiddleware } from "@/lib/admin/middleware";
import { readOnlyFnMiddleware } from "@/lib/admin/read-only-fn";
import {
  adjustmentFilterSchema,
  approveRecordSchema,
  invAdjustmentSchema,
  INV_PRODUCT_TYPES,
  stockCountSchema,
} from "@/lib/admin/schemas";

const summaryRangeSchema = z.object({
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});

const stockCountFilterSchema = z.object({
  keyword: z.string().trim().max(100).nullable(),
  categoryId: z.string().trim().uuid().nullable(),
  productType: z.enum(INV_PRODUCT_TYPES).nullable(),
  lowStockOnly: z.boolean(),
  page: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(200),
});

// ---------------------------------------------------------------------------
// 讀
// ---------------------------------------------------------------------------

export const listAdminAdjustments = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(adjustmentFilterSchema)
  .handler(async ({ data }) => {
    const { listAdminAdjustments } = await import("@/server/repos/inv-adjustments");
    return await listAdminAdjustments(data);
  });

export const getAdjustmentSummary = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(summaryRangeSchema)
  .handler(async ({ data }) => {
    const { getAdjustmentSummary } = await import("@/server/repos/inv-adjustments");
    return await getAdjustmentSummary(data);
  });

export const listStockCountProducts = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(stockCountFilterSchema)
  .handler(async ({ data }) => {
    const { listStockCountProducts } = await import("@/server/repos/inv-adjustments");
    return await listStockCountProducts(data);
  });

/**
 * 一件商品的異動紀錄。
 *
 * 讀的是 union view，所以現役的 stock_adjustments 與已凍結的
 * inventory_adjustments 都在裡面 —— 來源的商品詳細頁只讀舊表，2026-03 之後做的
 * 每一次盤點在那裡都是空的。
 */
export const listProductMovements = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(
    z.object({
      productId: z.string().trim().uuid(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { listProductMovements } = await import("@/server/repos/inv-adjustments");
    return await listProductMovements(data.productId, data.limit ?? 50);
  });

// ---------------------------------------------------------------------------
// 寫
// ---------------------------------------------------------------------------

/**
 * 新增一張在庫異動單。
 *
 * ⚠️ payload 裡**沒有 status**。要不要進待審是 inv.stock_adjustment_initial_status()
 *    在資料庫算的。來源的兩支盤點對話框把 status 硬寫成 'confirmed'，等於審核
 *    開關對盤點完全無效 —— 那正是這一期要修的東西之一。
 */
export const saveAdjustment = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(invAdjustmentSchema)
  .handler(async ({ data, context }) => {
    const { saveAdjustment } = await import("@/server/repos/inv-adjustments");
    const { submit, ...payload } = data;
    return await saveAdjustment({ userId: context.staff.userId, payload, submit });
  });

/**
 * 盤點（單筆與批次同一支）。
 *
 * ⚠️ 送的是**實盤數量**，不是差異。差異由 inv_record_stock_count() 用當下的
 *    stock_quantity 算 —— 來源在瀏覽器算 `actual - product.stock_quantity`，而那個
 *    stock_quantity 是頁面載入時抓的，畫面開十分鐘就會扣錯。
 */
export const recordStockCount = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(stockCountSchema)
  .handler(async ({ data, context }) => {
    const { recordStockCount } = await import("@/server/repos/inv-adjustments");
    return await recordStockCount({
      userId: context.staff.userId,
      rows: data.rows,
      options: data.options,
    });
  });

export const submitAdjustment = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data, context }) => {
    const { submitAdjustment } = await import("@/server/repos/inv-adjustments");
    return await submitAdjustment({ userId: context.staff.userId, id: data.id });
  });

export const deleteAdjustment = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { deleteAdjustment } = await import("@/server/repos/inv-adjustments");
    return await deleteAdjustment(data.id);
  });

/**
 * 沖帳。
 *
 * 不需要 approve_stock_adjustments：沖的是一筆**已經生效**的異動，庫存現在就是
 * 錯的，讓它卡在待審等於明知帳錯還要等人按。防亂沖靠的是「沖帳單自己不能再被
 * 沖」與「同一張不能沖兩次」，那兩條都在 inv_reverse_stock_adjustment() 裡面。
 */
export const reverseAdjustment = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data, context }) => {
    const { reverseAdjustment } = await import("@/server/repos/inv-adjustments");
    return await reverseAdjustment({ userId: context.staff.userId, id: data.id });
  });

/**
 * 重新送審：把一張被退回的異動單打回 pending_approval。
 *
 * 不需要 approve_stock_adjustments —— 被退回的人本來就該能改完再送一次，那正是
 * 退回的意思。真正的守門在下一輪審核。
 */
export const resubmitAdjustment = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { resubmitAdjustment } = await import("@/server/repos/inv-adjustments");
    // 「只有 rejected 能重送」的判斷在 inv_resubmit_stock_adjustment() 裡面。
    return await resubmitAdjustment(data.id);
  });

/** 審核／退回。權限查兩次的理由與 fns/inv-purchases.ts 那一支相同。 */
export const approveRecord = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(approveRecordSchema)
  .handler(async ({ data, context }) => {
    const permission = `approve_${data.module}` as const;

    if (!context.staff.permissions.includes(permission)) {
      const { NotAuthorizedError } = await import("@/server/auth");
      throw new NotAuthorizedError(`需要「${permission}」權限`);
    }

    const { approveRecord } = await import("@/server/repos/inv-adjustments");
    return await approveRecord({
      userId: context.staff.userId,
      module: data.module,
      id: data.id,
      approved: data.approved,
    });
  });

// ---------------------------------------------------------------------------
// 整頁的資料（2026-10-25 後台提速）
// ---------------------------------------------------------------------------
// 盤點頁與在庫異動頁進場時原本各打 4 支／3 支 fn —— 每一支都各自驗一次身分（重讀 profiles），
// 正式站上每一支還是一趟獨立的 HTTP。這裡改成一支：身分只驗一次，查詢在伺服器上平行跑。
// 權限與原本那幾支**完全一樣**：全部都是 staffFnMiddleware()（不帶細權限）。
// 原本那幾支保留給頁面上的換頁／篩選／重抓使用。

export const getInventoryCountPageData = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .inputValidator(
    z.object({
      filter: stockCountFilterSchema,
      summary: summaryRangeSchema,
      recent: adjustmentFilterSchema,
    }),
  )
  .handler(async ({ data }) => {
    const repo = await import("@/server/repos/inv-adjustments");
    const [page, options, summary, recent] = await Promise.all([
      repo.listStockCountProducts(data.filter),
      repo.listAdjustmentFormOptions(),
      repo.getAdjustmentSummary(data.summary),
      repo.listAdminAdjustments(data.recent),
    ]);
    return { page, options, summary, recent };
  });

export const getInventoryAdjustmentsPageData = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ filter: adjustmentFilterSchema, summary: summaryRangeSchema }))
  .handler(async ({ data }) => {
    const repo = await import("@/server/repos/inv-adjustments");
    const [page, summary, options] = await Promise.all([
      repo.listAdminAdjustments(data.filter),
      repo.getAdjustmentSummary(data.summary),
      repo.listAdjustmentFormOptions(),
    ]);
    return { page, summary, options };
  });

/**
 * 一張異動單的內頁（/admin/inventory-adjustments/$id，2026-10-26 後台第 3 批：從詳情對話框改成
 * 內頁）。staffFnMiddleware()，與原本的 getAdminAdjustment 相同；GET——內頁的 loader 用，id 在
 * 網址上本來就看得到。查不到回 null。
 */
export const getInventoryAdjustmentPageData = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ adjustmentId: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { getAdminAdjustment } = await import("@/server/repos/inv-adjustments");
    return { adjustment: await getAdminAdjustment(data.adjustmentId) };
  });
