/**
 * 現場付款收款（0057）—— 門市人員在活動現場把**現場付款**的訂單標記已收款。
 *
 * 刻意不放進 fns/orders.ts：那個檔案每一支都只給 admin（對帳與手動核銷付款不下放，見它的
 * 檔頭），有自檢守著「不 import staffFnMiddleware」。這裡是那條規則唯一、而且範圍被釘死的
 * 例外：只限 payment_method = 'onsite'，而且要 event.onsite.collect 細權限。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { staffFnMiddleware } from "@/lib/admin/middleware";

/**
 * 0057：門市人員在活動現場收款——把**現場付款**（payment_method = 'onsite'）的訂單標記已收款。
 *
 * 權限兩道，都在這裡（server 端），按鈕顯示與否只是畫面：
 *   1. staffFnMiddleware("event.onsite.collect")：staff 要有這個細權限；admin 自動擁有。
 *   2. 訂單的 payment_method 必須是 'onsite'——從資料庫重讀，不信任呼叫端。匯款、舊的
 *      「由店家聯繫付款」等其他付款方式一律回 not_onsite，照舊只能由 admin 在訂單內頁標記
 *      （markOrderPaidAdmin，adminFnMiddleware）。
 * payment_method 下單之後沒有任何路徑會改它（admin_mark_order_paid 刻意保留原值），所以
 * 「先讀再標」之間不會被換成別的付款方式。
 *
 * 收款本身與 admin 那一支完全相同：admin_mark_order_paid()（actor 只認 session），標記成功
 * 才觸發付款通知；發票由 invoice_backlog 照常開立。
 */
export const markOnsiteOrderPaidStaff = createServerFn({ method: "POST" })
  .middleware([staffFnMiddleware("event.onsite.collect")])
  .inputValidator(
    z.object({
      orderId: z.string().trim().uuid(),
      note: z.string().trim().max(500).nullable(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { getOrderPaymentMethod, markOrderPaidByAdmin } =
      await import("@/server/repos/orders-admin");
    const method = await getOrderPaymentMethod(data.orderId);
    if (method === undefined) {
      return { marked: false, reason: "order_not_found" as const, order_no: null };
    }
    if (method !== "onsite") {
      return { marked: false, reason: "not_onsite" as const, order_no: null };
    }
    const result = await markOrderPaidByAdmin({
      orderId: data.orderId,
      actorId: context.staff.userId,
      note: data.note,
    });
    if (result.reason === "marked") {
      const { triggerNotifyAfterPayment } = await import("@/server/notify");
      await triggerNotifyAfterPayment(data.orderId);
    }
    return result;
  });
