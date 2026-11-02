/**
 * 後台「新增電話報名」（0050）的 server functions。
 *
 * 🔴 兩支都掛 adminFnMiddleware：這是一個會建立訂單、占名額、標記已收款（動到錢）的
 *    動作，與 fns/orders.ts 的「標記已收款」同一個立場——只有 role='admin'，門市人員不行。
 *    CSRF 由 src/start.ts 的全域 createCsrfMiddleware 擋（所有 server fn 一律 same-origin）。
 *
 * 建立者（created_by）與 admin_mark_order_paid() 的 p_actor_id 只認 context.admin.userId，
 * inputValidator 裡**沒有** actorId 這個欄位——呼叫端不能宣稱是誰做的。
 *
 * 重複送出：idempotencyKey 一路傳到 orders.idempotency_key（unique）。同一個 key 重送，
 * createOrder() 第 0 步就回原本那張單；「已收到匯款」的第二次 admin_mark_order_paid()
 * 回 already_paid、不再觸發通知。
 */
import { createServerFn } from "@tanstack/react-start";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { phoneOrderSchema } from "@/lib/admin/phone-order";

export const getPhoneOrderFormOptions = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listPhoneOrderOptions } = await import("@/server/repos/phone-orders");
    return await listPhoneOrderOptions();
  });

/**
 * 給店員看的錯誤訊息。前台的 CHECKOUT_ERROR_COPY 是寫給客人的（「請回到購物車…」），
 * 這裡沒有購物車，常見的幾種改成店員能照著做的話；其餘沿用前台文案的中文。
 */
const ADMIN_ERROR_TEXT: Partial<Record<string, string>> = {
  no_seats_left: "名額不足（場次或票種已滿），訂單沒有成立。請減少人數或換場次／票種。",
  session_ended: "這個場次已經開始，不能再報名，訂單沒有成立。",
  product_unavailable:
    "這個活動、場次或票種目前無法報名（可能已下架、關閉或不在販售期間），訂單沒有成立。",
  order_failed: "訂單建立失敗（例如參加者人數與名額不符），訂單沒有成立。請檢查後再試一次。",
};

export type CreatePhoneOrderResult =
  | {
      ok: true;
      orderId: string;
      orderNo: string;
      /** 建單成功但「標記已收款」沒有成功時的提示（訂單已建立，請到訂單頁手動標記）。 */
      warning: string | null;
    }
  | { ok: false; message: string };

export const createPhoneOrderAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(phoneOrderSchema)
  .handler(async ({ data, context }): Promise<CreatePhoneOrderResult> => {
    const { buildPhoneOrderPayload, phoneOrderPaidNote } = await import("@/lib/admin/phone-order");
    const { createAdminPhoneOrder } = await import("@/server/repos/orders");
    const { CheckoutError, CHECKOUT_ERROR_COPY } = await import("@/lib/checkout");

    let placed;
    try {
      placed = await createAdminPhoneOrder(buildPhoneOrderPayload(data), {
        actorId: context.admin.userId,
        totalOverride: data.priceOverride ? data.priceOverride.amount : null,
        priceOverrideReason: data.priceOverride ? data.priceOverride.reason : null,
        adminNote: data.adminNote && data.adminNote.trim() ? data.adminNote.trim() : null,
        notifyCustomer: data.notifyCustomer,
        paidUpfront: data.payment.status === "paid",
        remittancePaidOn: data.payment.status === "paid" ? data.payment.paidOn : null,
        remittanceLast5:
          data.payment.status === "paid" && data.payment.last5 ? data.payment.last5 : null,
      });
    } catch (err) {
      if (err instanceof CheckoutError) {
        return {
          ok: false,
          message: ADMIN_ERROR_TEXT[err.code] ?? CHECKOUT_ERROR_COPY[err.code].zh,
        };
      }
      console.error(
        `[admin/phone-orders] 建單失敗：${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, message: "訂單建立失敗，請再試一次。" };
    }

    let warning: string | null = null;
    const { triggerNotifyAfterPayment } = await import("@/server/notify");
    if (placed.total === 0) {
      // 0 元（免費招待）：createOrder() 已經 settle_free_order() 成已付款。直接排付款成功
      // 那批信（店家信；客人信看 notifyCustomer）。claim 讓重送不會排第二次。
      await triggerNotifyAfterPayment(placed.orderId);
    } else if (data.payment.status === "paid") {
      // 與後台把前台匯款單標成已收款**同一支** RPC（0034 §5，保留 payment_method='transfer'）。
      const { markOrderPaidByAdmin } = await import("@/server/repos/orders-admin");
      try {
        const result = await markOrderPaidByAdmin({
          orderId: placed.orderId,
          actorId: context.admin.userId,
          note: phoneOrderPaidNote(data.payment.paidOn, data.payment.last5),
        });
        if (result.reason === "marked") {
          await triggerNotifyAfterPayment(placed.orderId);
        } else if (result.reason !== "already_paid") {
          warning = `訂單已建立，但沒有標記成已收款（${result.reason}）。請在訂單頁確認。`;
        }
      } catch (err) {
        console.error(
          `[admin/phone-orders] 標記已收款失敗 order=${placed.orderNo}：${err instanceof Error ? err.message : String(err)}`,
        );
        warning = "訂單已建立，但標記已收款失敗。請在訂單頁按「標記已收款」。";
      }
    }

    return { ok: true, orderId: placed.orderId, orderNo: placed.orderNo, warning };
  });
