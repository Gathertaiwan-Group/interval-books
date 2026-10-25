/**
 * 進銷存商品主檔的 server functions —— 店員維護商品的唯一入口。
 *
 * ── 授權分三層，而且每一支自己擋 ──────────────────────────────────────────
 *   staffFnMiddleware()                        檢視、編輯（店員日常作業）
 *   staffFnMiddleware("approve_products")      審核商品
 *   staffFnMiddleware("approve_price_changes") 審核調價
 *
 * ⚠️ **側欄隱藏不是授權**。/admin/_shell 的 NAV_GROUPS 與這一頁的 canApprove
 *    旗標只決定畫面長什麼樣。擋住 `curl -X POST /_serverFn/…` 的只有下面每一行
 *    `.middleware([...])` —— 而 requireStaff() 每一次都重讀 profiles 與
 *    staff_permissions，所以把權限收回去，下一個請求就被擋，不是等 cookie 過期。
 *
 * ⚠️ 一個字都沒有動到 adminFnMiddleware 與 requireAdmin()。那一支守著內容管理
 *    那 15 支，語意仍然是「role 必須是 admin」。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { staffFnMiddleware } from "@/lib/admin/middleware";
import { readOnlyFnMiddleware } from "@/lib/admin/read-only-fn";
import {
  approveRecordSchema,
  batchUpdateSchema,
  importProductsSchema,
  invProductSchema,
  priceChangeSchema,
  productFilterSchema,
} from "@/lib/admin/schemas";

// ---------------------------------------------------------------------------
// 讀
// ---------------------------------------------------------------------------

export const listAdminProducts = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(productFilterSchema)
  .handler(async ({ data }) => {
    const { listAdminProducts } = await import("@/server/repos/inv-products");
    return await listAdminProducts(data);
  });

/** 分類／供應商／審核設定／母品項候選 —— 表單開一次要的四份參考資料。 */
async function loadProductFormOptions() {
  const { listAdminCategories, listAdminVendors, listApprovalSettings, listBaseProductCandidates } =
    await import("@/server/repos/inv-products");
  const [categories, vendors, approvalSettings, baseProducts] = await Promise.all([
    listAdminCategories(),
    listAdminVendors(),
    listApprovalSettings(),
    listBaseProductCandidates(),
  ]);
  return { categories, vendors, approvalSettings, baseProducts };
}

export const listProductFormOptions = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async () => await loadProductFormOptions());

export const getAdminProduct = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { getAdminProduct } = await import("@/server/repos/inv-products");
    return await getAdminProduct(data.id);
  });

// ---------------------------------------------------------------------------
// 寫 —— 日常作業（staff）
// ---------------------------------------------------------------------------

/**
 * 新增／編輯商品。
 *
 * user_id 取自 middleware 的 context，**不從 request body 拿** —— 讓前端指定
 * 建立者等於讓任何一個店員把商品掛在別人頭上，而 canModifyRecord 正是靠這一欄
 * 判斷誰改得動。
 *
 * approval_status 也不從 body 拿：它由資料庫的 inv.initial_approval_status()
 * 算，查不到設定一律 pending（fail-closed，語意來自來源的 getInitialApprovalStatus，
 * 只是位置從瀏覽器搬到了資料庫）。
 */
export const saveProduct = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(invProductSchema)
  .handler(async ({ data, context }) => {
    const { saveProduct } = await import("@/server/repos/inv-products");
    const { id, purchase, ...payload } = data;
    return await saveProduct({
      userId: context.staff.userId,
      id: id ?? null,
      payload,
      // 進貨只在新增時一起建。編輯既有商品時就算送了也忽略 —— 那是進貨頁的事。
      purchase: id ? null : (purchase ?? null),
    });
  });

export const setProductActive = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid(), is_active: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { setProductActive } = await import("@/server/repos/inv-products");
    return await setProductActive({
      userId: context.staff.userId,
      id: data.id,
      isActive: data.is_active,
    });
  });

export const deleteProduct = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { deleteProduct } = await import("@/server/repos/inv-products");
    return await deleteProduct(data.id);
  });

/**
 * 送出調價。
 *
 * **送出**不需要 approve_price_changes —— 那是「我想改價」，不是「這個價格算數」。
 * 需要權限的是下面的 approveRecord。這與 0014 對賣超的判斷是同一條：做事不需要
 * 授權，宣告需要。
 */
export const requestPriceChange = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(priceChangeSchema)
  .handler(async ({ data, context }) => {
    const { requestPriceChange } = await import("@/server/repos/inv-products");
    return await requestPriceChange({
      userId: context.staff.userId,
      id: data.id,
      costPrice: data.cost_price,
      sellingPrice: data.selling_price,
    });
  });

/**
 * Excel 匯入。
 *
 * xlsx 在瀏覽器解析（純檔案處理，dynamic import，SSR 端不會載到它），但**寫入
 * 只有這一條路**。瀏覽器拿不到 service_role，也打不到 inv.*。
 */
export const importProducts = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(importProductsSchema)
  .handler(async ({ data, context }) => {
    const { importProducts } = await import("@/server/repos/inv-products");
    return await importProducts({
      userId: context.staff.userId,
      rows: data.rows,
      options: data.options,
    });
  });

export const batchUpdateProducts = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(batchUpdateSchema)
  .handler(async ({ data, context }) => {
    const { batchUpdateProducts } = await import("@/server/repos/inv-products");
    return await batchUpdateProducts({
      userId: context.staff.userId,
      ids: data.ids,
      patch: data.patch,
    });
  });

// ---------------------------------------------------------------------------
// 寫 —— 審核（要細權限）
// ---------------------------------------------------------------------------

/**
 * 審核／退回一筆記錄。
 *
 * ── 這一支就是那個被重寫的 hook ────────────────────────────────────────────
 * 來源：useApprovalMutation({ table, queryKey, statusField }) —— 呼叫端自己傳
 *       「要更新哪張表」「哪一個欄位是狀態」。
 * 這裡：approveRecord({ module, id, approved }) —— module 是七個代號之一，
 *       zod enum 在這裡擋一次，PL/pgSQL 的 CASE 在資料庫再擋一次，兩層都不認得
 *       的字串連 UPDATE 都不會發生。表名一次都沒有出現在網路上。
 *
 * ── 為什麼權限查兩次而不是一次 ────────────────────────────────────────────
 * 七個模組對應七種 approve_*，但 middleware 只能在建立時綁死一個。所以這裡的
 * middleware 先擋掉「連 staff 都不是」的人（那是絕大多數的攻擊面），再依 module
 * 查一次對應的細權限。兩次都是 server 端，兩次都重讀 staff_permissions。
 *
 * 沒有走「七支 server fn 各綁一個 middleware」是因為那會讓白名單散在七個地方，
 * 而白名單只要有兩份就會有一天長得不一樣。
 */
export const approveRecord = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(approveRecordSchema)
  .handler(async ({ data, context }) => {
    // module → 需要哪一種 approve_*。這一份對照表也只在 server 端。
    const permission = `approve_${data.module}` as const;

    if (!context.staff.permissions.includes(permission)) {
      // 與 requireStaff() 丟出來的訊息同一個形狀，讓前端不用分辨是哪一層擋的。
      const { NotAuthorizedError } = await import("@/server/auth");
      throw new NotAuthorizedError(`需要「${permission}」權限`);
    }

    const { approveRecord } = await import("@/server/repos/inv-products");
    return await approveRecord({
      userId: context.staff.userId,
      module: data.module,
      id: data.id,
      approved: data.approved,
    });
  });

/**
 * 重新送審：把一筆被退回的商品打回 pending。
 *
 * 不需要 approve_products —— 被退回的人本來就該能改完再送一次，那正是退回的
 * 意思。真正的守門在下一輪審核。
 */
export const resubmitProduct = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { resubmitProduct } = await import("@/server/repos/inv-products");
    // 「只有 rejected 能重送」的判斷在 inv_resubmit_product() 裡面，不在這裡先
    // 查一次再決定 —— 先查後改中間有窗口，而且那個判斷會變成兩份。
    return await resubmitProduct(data.id);
  });

// ---------------------------------------------------------------------------
// 整頁的資料（2026-10-25 後台提速）
// ---------------------------------------------------------------------------
// 頁面進場時原本平行打好幾支 fn —— 每一支都各自驗一次身分（重讀 profiles），正式站上每一支
// 還是一趟獨立的 HTTP。這裡改成一支：身分只驗一次，查詢在伺服器上平行跑。
// 權限與原本那幾支**完全一樣**（都是 staffFnMiddleware()，不帶細權限）；原本那幾支保留給
// 頁面上的換頁／篩選／重抓使用。

export const getInventoryProductsPageData = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ filter: productFilterSchema }))
  .handler(async ({ data }) => {
    const { listAdminProducts } = await import("@/server/repos/inv-products");
    const [page, options] = await Promise.all([
      listAdminProducts(data.filter),
      loadProductFormOptions(),
    ]);
    return { page, options };
  });

/**
 * /admin/inventory-products/$id（詳情與編輯共用的 layout loader）一支拿齊：商品那一列、
 * 最近 50 筆異動紀錄、表單選項（分類／供應商／審核設定／母品項候選）。
 *
 * 2026-10-25 後台第 2 批（彈窗改內頁）：詳情與編輯兩頁共用這一個 loader，「詳情 → 編輯」
 * 不重抓。權限與原本的 getAdminProduct／listProductMovements（fns/inv-adjustments.ts）／
 * listProductFormOptions **完全一樣**：三支都是 staffFnMiddleware()，不帶細權限。
 * 異動紀錄讀的是 union view（inv_admin_product_movements），新舊兩張表都在裡面。
 */
export const getInventoryProductPageData = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ productId: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { getAdminProduct } = await import("@/server/repos/inv-products");
    const { listProductMovements } = await import("@/server/repos/inv-adjustments");
    const [product, movements, options] = await Promise.all([
      getAdminProduct(data.productId),
      listProductMovements(data.productId, 50),
      loadProductFormOptions(),
    ]);
    return { product, movements, options };
  });
