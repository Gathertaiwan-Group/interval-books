/**
 * 套餐與二手書的 server functions。
 *
 * ── 授權 ──────────────────────────────────────────────────────────────────
 *   staffFnMiddleware()                     維護套餐、賣套餐、二手書入帳（日常作業）
 *   staffFnMiddleware() + 細權限檢查         審核（approve_combo_sets）
 *
 * ⚠️ **側欄隱藏不是授權**。擋住直接打 `/_serverFn/…` 的只有 `.middleware([...])`。
 * ⚠️ 一個字都沒有動到 adminFnMiddleware 與 requireAdmin()。
 *
 * ── 這裡沒有任何金額運算 ──────────────────────────────────────────────────
 * 套餐的組合價怎麼分攤到組成品項，整段在 inv.allocate_combo_amounts()／
 * inv_combo_checkout() 裡。來源是在瀏覽器裡算（`isFirstItem ? sellingPrice : 0`），
 * 所以改一個 request body 就能決定哪一件商品拿到全部營收 —— 那正是寄賣廠商的
 * 拆帳基礎。見 0018 檔頭問題一。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { staffFnMiddleware } from "@/lib/admin/middleware";
import { readOnlyFnMiddleware } from "@/lib/admin/read-only-fn";
import {
  comboCheckoutSchema,
  comboFilterSchema,
  comboSetSchema,
  secondhandSaleSchema,
} from "@/lib/admin/schemas";

// ---------------------------------------------------------------------------
// 讀
// ---------------------------------------------------------------------------

export const listAdminComboSets = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(comboFilterSchema)
  .handler(async ({ data }) => {
    const { listAdminComboSets, listAllComboItems } = await import("@/server/repos/inv-combos");
    // 一次撈完組成品項，清單頁才不會是 N+1。
    const [sets, items] = await Promise.all([listAdminComboSets(data), listAllComboItems()]);
    return { sets, items };
  });

/**
 * 表單要的選項：審核設定（提示文字用）與可選的商品（與櫃檯同一個範圍：已審核、上架、
 * 不是組合子品項）。新增頁與編輯頁的 loader 用。
 *
 * 2026-10-25：拿掉 paymentMethods —— 套餐頁從來沒有用到（結帳在 /admin/pos，自己抓）。
 * 2026-10-26：可選商品只帶選擇器與分攤預覽用得到的七欄（listComboPickerProducts），
 * 不再整份沿用櫃檯的 listPosProducts。
 */
async function loadComboFormOptions() {
  const { listApprovalSettings } = await import("@/server/repos/inv-products");
  const { listComboPickerProducts } = await import("@/server/repos/inv-sales");
  const [approvalSettings, products] = await Promise.all([
    listApprovalSettings(),
    listComboPickerProducts(),
  ]);
  return { approvalSettings, products };
}

/** 建／改套餐時要選商品（/admin/inventory-combos/new 與 /$id/edit 的 loader）。 */
export const listComboFormOptions = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async () => await loadComboFormOptions());

/**
 * /admin/inventory-combos 列表的 loader 一支拿齊：套餐清單＋組成品項＋審核設定。
 *
 * 2026-10-25 後台第 2 批：表單搬到內頁以後，列表只剩「需審核」那個提示要用審核設定。
 * 原本列表另外抓 listComboFormOptions（整份可選商品，約 496 KB）只為了表單，現在不抓。
 * 權限與 listAdminComboSets／listComboFormOptions 相同（staffFnMiddleware）。
 */
export const getInventoryCombosPageData = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .inputValidator(comboFilterSchema)
  .handler(async ({ data }) => {
    const { listAdminComboSets, listAllComboItems } = await import("@/server/repos/inv-combos");
    const { listApprovalSettings } = await import("@/server/repos/inv-products");
    const [sets, items, approvalSettings] = await Promise.all([
      listAdminComboSets(data),
      listAllComboItems(),
      listApprovalSettings(),
    ]);
    return { list: { sets, items }, approvalSettings };
  });

/**
 * /admin/inventory-combos/$id（詳情與編輯共用的 layout loader）一支拿齊：套餐、組成品項、
 * 最近 50 筆套餐銷售、審核設定。
 *
 * 2026-10-25 後台第 2 批：原本詳情彈窗打 getAdminComboSet ∥ listComboSales（兩支、各驗一次
 * 身分），編輯彈窗又打一次 getAdminComboSet。現在兩頁共用這一個 loader，詳情 → 編輯不重抓套餐。
 * 可選商品清單（約 496 KB）只有編輯頁要用，由編輯頁自己的 loader 叫 listComboFormOptions——
 * 只看詳情的人不用等它。
 * 權限與原本的 getAdminComboSet／listComboSales（2026-10-26 已移除）與 listComboFormOptions
 * 相同（staffFnMiddleware）。
 */
export const getInventoryComboPageData = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ comboSetId: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { getAdminComboSet, listComboItems, listComboSales } =
      await import("@/server/repos/inv-combos");
    const { listApprovalSettings } = await import("@/server/repos/inv-products");
    const [set, items, sales, approvalSettings] = await Promise.all([
      getAdminComboSet(data.comboSetId),
      listComboItems(data.comboSetId),
      // 不限日期：套餐一年賣不到幾百份，最近 50 筆就是完整的故事。
      listComboSales({ comboSetId: data.comboSetId, dateFrom: null, dateTo: null, limit: 50 }),
      listApprovalSettings(),
    ]);
    return { set, items, sales, approvalSettings };
  });

// ---------------------------------------------------------------------------
// 寫
// ---------------------------------------------------------------------------

export const saveComboSet = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(comboSetSchema)
  .handler(async ({ data, context }) => {
    const { saveComboSet } = await import("@/server/repos/inv-combos");
    return await saveComboSet({
      userId: context.staff.userId,
      id: data.id,
      // 只挑四個欄位傳下去。整包 data 丟過去的話，日後 schema 多一個欄位就會
      // 悄悄變成「可以從瀏覽器設定的東西」。
      payload: {
        name: data.name,
        selling_price: data.selling_price,
        notes: data.notes,
        is_active: data.is_active,
      },
      items: data.items,
    });
  });

export const setComboSetActive = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid(), isActive: z.boolean() }))
  .handler(async ({ data }) => {
    const { setComboSetActive } = await import("@/server/repos/inv-combos");
    return await setComboSetActive(data);
  });

export const deleteComboSet = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { deleteComboSet } = await import("@/server/repos/inv-combos");
    return await deleteComboSet(data.id);
  });

export const resubmitComboSet = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { resubmitComboSet } = await import("@/server/repos/inv-combos");
    return await resubmitComboSet(data.id);
  });

/**
 * 審核／退回套餐。
 *
 * ⚠️ 與 fns/inv-adjustments.ts#approveRecord 同一個形狀：權限在**這裡**重讀一次
 *    context.staff.permissions（那是 requireStaff 從 staff_permissions 查出來的），
 *    不信任前端送來的任何東西。module 是寫死的 'combo_sets'，不是參數 —— 來源的
 *    useApprovalMutation({ table }) 是讓呼叫端指定要更新哪張表。
 */
export const approveComboSet = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid(), approved: z.boolean() }))
  .handler(async ({ data, context }) => {
    if (!context.staff.permissions.includes("approve_combo_sets")) {
      const { NotAuthorizedError } = await import("@/server/auth");
      throw new NotAuthorizedError("需要「approve_combo_sets」權限");
    }

    const { approveRecord } = await import("@/server/repos/inv-products");
    return await approveRecord({
      userId: context.staff.userId,
      module: "combo_sets",
      id: data.id,
      approved: data.approved,
    });
  });

/**
 * 賣一份套餐。
 *
 * ⚠️ 這一支不是 admin-only：櫃檯店員本來就要能結帳（與 pos_checkout 同一條線）。
 *    但「哪些套餐賣得動」是資料庫說了算 —— inv_combo_checkout() 會擋掉停用、
 *    未審核、沒有組成品項、組成品項停用的套餐。
 */
export const comboCheckout = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(comboCheckoutSchema)
  .handler(async ({ data, context }) => {
    const { comboCheckout } = await import("@/server/repos/inv-combos");
    return await comboCheckout({
      userId: context.staff.userId,
      comboSetId: data.combo_set_id,
      quantity: data.quantity,
      saleDate: data.sale_date,
      paymentMethodId: data.payment_method_id,
      notes: data.notes,
      overrideReservation: data.override_reservation,
    });
  });

export const secondhandCheckout = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(secondhandSaleSchema)
  .handler(async ({ data, context }) => {
    const { secondhandCheckout } = await import("@/server/repos/inv-combos");
    return await secondhandCheckout({
      userId: context.staff.userId,
      itemName: data.item_name,
      quantity: data.quantity,
      unitPrice: data.unit_price,
      saleDate: data.sale_date,
      paymentMethodId: data.payment_method_id,
      notes: data.notes,
    });
  });
