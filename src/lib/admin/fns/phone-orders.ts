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
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import {
  phoneOrderContactEditSchema,
  phoneOrderNotifyError,
  phoneOrderSchema,
} from "@/lib/admin/phone-order";

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
    const { createAdminPhoneOrder, AdminPhoneOrderInputError, AdminPhoneOrderUncertainError } =
      await import("@/server/repos/orders");
    const { CheckoutError, CHECKOUT_ERROR_COPY } = await import("@/lib/checkout");

    // 0051：沒有訂購人 Email 卻要求寄信 → 不建單，回一句店員看得懂的話。
    const notifyError = phoneOrderNotifyError(data);
    if (notifyError) return { ok: false, message: notifyError };

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
      if (err instanceof AdminPhoneOrderInputError) {
        return {
          ok: false,
          message:
            err.code === "email_required_for_notify"
              ? (phoneOrderNotifyError({ notifyCustomer: true, customerEmail: "" }) ?? "")
              : "訂購人的手機或 Email 至少要填一項，訂單沒有成立。",
        };
      }
      if (err instanceof AdminPhoneOrderUncertainError) {
        // 訂單可能已經成立（或同一筆送出還在處理中）——不標記已收款、也不說「沒有成立」。
        console.error(`[admin/phone-orders] 建單結果不確定：${err.message}`);
        return {
          ok: false,
          message:
            "這筆報名可能已經建立（或還在處理中）。請先到訂單列表的「後台電話報名」分頁確認，不要再送一次。",
        };
      }
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

// ---------------------------------------------------------------------------
// 0051：事後補資料（訂單內頁「編輯訂購人／參加者聯絡資料」）
// ---------------------------------------------------------------------------

/**
 * 讀這張電話報名訂單目前的訂購人與參加者聯絡資料（明文，給編輯表單預填）。
 * 只限 source = 'admin_phone'；其他訂單回 null。同訂單內頁一樣只有 admin 看得到。
 */
export const getPhoneOrderContacts = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ orderId: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { loadPhoneOrderContacts } = await import("@/server/repos/phone-orders");
    return await loadPhoneOrderContacts(data.orderId);
  });

export type UpdatePhoneOrderContactsResult =
  | { ok: true; changed: boolean }
  | { ok: false; message: string };

const CONTACT_EDIT_ERROR_TEXT: Record<string, string> = {
  not_found: "找不到這張訂單，可能已被刪除。",
  not_phone_order: "只有後台電話報名的訂單可以在這裡改聯絡資料。",
  customer_name_required: "訂購人姓名必填。",
  customer_contact_required: "訂購人的手機或 Email 至少要填一項。",
  email_required_for_notify: "這張單有勾「寄信給客人」，訂購人 Email 不能清空。",
  registration_not_in_order: "參加者資料已經變動（可能被移除），請重新整理後再試。",
  participant_name_required: "每一位參加者都要有姓名。",
};

/**
 * 改電話報名訂單的訂購人／參加者姓名、手機、Email。寫入與稽核在同一支 RPC
 * （admin_update_phone_order_contacts，0051 §3）：誰（context.admin.userId，呼叫端
 * 不能宣稱）、什麼時候、改了哪幾個欄位。CSRF 由全域 createCsrfMiddleware 擋。
 */
export const updatePhoneOrderContactsAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(phoneOrderContactEditSchema)
  .handler(async ({ data, context }): Promise<UpdatePhoneOrderContactsResult> => {
    const { updatePhoneOrderContacts } = await import("@/server/repos/phone-orders");
    const res = await updatePhoneOrderContacts({
      orderId: data.orderId,
      actorId: context.admin.userId,
      customer: data.customer,
      participants: data.participants,
    });
    if (res.updated) return { ok: true, changed: res.reason === "updated" };
    return { ok: false, message: CONTACT_EDIT_ERROR_TEXT[res.reason] ?? "儲存失敗，請再試一次。" };
  });
