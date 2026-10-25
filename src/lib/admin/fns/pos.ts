/**
 * 門市 POS 的 server functions —— 店員碰進銷存的唯一入口。
 *
 * ⚠️ 每一支都串 staffFnMiddleware()，**不是** adminFnMiddleware。這是這一期唯一
 *    放寬到 staff 的地方，而放寬的邊界就是這個檔案：其他 15 支後台函式一個字
 *    都沒有動。
 *
 * ⚠️ 側欄把某個模組藏起來不是授權。店員硬打 /admin/products 也好、用 curl 直接
 *    POST /_serverFn/… 也好，擋住他的是 middleware 重讀 profiles 那一下，不是
 *    NAV_GROUPS 的 `staff: false`。
 *
 * ── 為什麼「標記告警已處理」要細權限，「賣超放行」不要 ──────────────────
 * 逃生門不擋：客人已經站在櫃檯，擋下來就是把生意推出門，而且它每一次都會在
 * stock_oversold_alerts 留一列，事後查得到。
 * 標記已處理要擋：那是在宣告「帳現在對了」。宣告需要授權，做事不需要。
 * approve_stock_adjustments 正是來源系統對這件事的名字。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { staffFnMiddleware } from "@/lib/admin/middleware";
import { readOnlyFnMiddleware } from "@/lib/admin/read-only-fn";
import { posCheckoutSchema, resolveAlertSchema, salesFilterSchema } from "@/lib/admin/schemas";

export const listPosProducts = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async () => {
    const { listPosProducts } = await import("@/server/repos/inv-sales");
    return await listPosProducts();
  });

export const listPosPaymentMethods = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async () => {
    const { listPosPaymentMethods } = await import("@/server/repos/inv-sales");
    return await listPosPaymentMethods();
  });

export const findPosProductByBarcode = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(z.object({ barcode: z.string().trim().min(1).max(64) }))
  .handler(async ({ data }) => {
    const { findPosProductByBarcode } = await import("@/server/repos/inv-sales");
    return await findPosProductByBarcode(data.barcode);
  });

/**
 * 結帳。
 *
 * user_id 取自 middleware 的 context，**不從 request body 拿** —— 讓前端指定
 * 操作人員等於讓任何一個店員把交易掛在別人頭上。
 */
export const posCheckout = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware()])
  .inputValidator(posCheckoutSchema)
  .handler(async ({ data, context }) => {
    const { posCheckout } = await import("@/server/repos/inv-sales");
    return await posCheckout({
      userId: context.staff.userId,
      items: data.items,
      paymentMethodId: data.payment_method_id,
      saleDate: data.sale_date,
      notes: data.notes,
      overrideReservation: data.override_reservation,
    });
  });

export const listPosSales = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(salesFilterSchema)
  .handler(async ({ data }) => {
    const { listPosSales, summarisePosSales } = await import("@/server/repos/inv-sales");
    const [page, summary] = await Promise.all([listPosSales(data), summarisePosSales(data)]);
    return { ...page, summary };
  });

export const listStockAlerts = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware(), readOnlyFnMiddleware])
  .inputValidator(z.object({ status: z.enum(["all", "open", "resolved"]) }))
  .handler(async ({ data }) => {
    const { listStockAlerts } = await import("@/server/repos/inv-sales");
    return await listStockAlerts(data.status);
  });

/** 只有帶 approve_stock_adjustments 的店員（或 admin）能宣告一筆賣超處理完了。 */
export const resolveStockAlert = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware("approve_stock_adjustments")])
  .inputValidator(resolveAlertSchema)
  .handler(async ({ data, context }) => {
    const { resolveStockAlert } = await import("@/server/repos/inv-sales");
    return await resolveStockAlert({
      alertId: data.alert_id,
      userId: context.staff.userId,
      note: data.note,
    });
  });
