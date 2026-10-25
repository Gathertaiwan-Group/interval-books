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

export const getAdminComboSet = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { getAdminComboSet, listComboItems } = await import("@/server/repos/inv-combos");
    const [set, items] = await Promise.all([getAdminComboSet(data.id), listComboItems(data.id)]);
    return { set, items };
  });

export const listComboSales = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(
    z.object({
      comboSetId: z.string().trim().uuid().nullable(),
      dateFrom: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
      dateTo: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
      limit: z.number().int().min(1).max(500),
    }),
  )
  .handler(async ({ data }) => {
    const { listComboSales } = await import("@/server/repos/inv-combos");
    return await listComboSales(data);
  });

/** 建套餐時要選商品。沿用商品主檔那一支（已審核、上架、不是組合子品項）。 */
export const listComboFormOptions = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async () => {
    const { listApprovalSettings } = await import("@/server/repos/inv-products");
    const { listPosProducts, listPosPaymentMethods } = await import("@/server/repos/inv-sales");
    const [approvalSettings, products, paymentMethods] = await Promise.all([
      listApprovalSettings(),
      listPosProducts(),
      listPosPaymentMethods(),
    ]);
    return { approvalSettings, products, paymentMethods };
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
