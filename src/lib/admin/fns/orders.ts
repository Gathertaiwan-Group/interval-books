/**
 * orders server functions —— 後台訂單列表／詳情／標記已收款／標記已出貨
 * （src/routes/admin/_shell.orders.tsx）。
 *
 * 🔴 每一支都掛 adminFnMiddleware。這一頁看得到客人的姓名與遮罩後的聯絡方式，而
 * 「標記已收款」是一個會動到錢的動作 —— 與 middleware.ts 檔頭記錄的既有 15 支
 * admin-only 函式同一個立場，只有 role='admin' 能碰，門市人員（staff）不行。
 *
 * 與 event-registrations.ts 那四支（staffFnMiddleware + event.roster.read）刻意
 * 不同：那邊在 0021 §4 已經有一個獨立的細權限可以授權給工讀生，這裡沒有這種需
 * 求 —— 對帳與手動核銷付款不是可以下放給門市人員的工作，「先當作只有 admin 能碰
 * 比較安全」與這個檔案要保護的東西（金額、付款狀態）相稱。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";

export const listAdminOrders = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      scope: z.enum(["transfer_pending", "to_ship", "all"]),
      includeArchived: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { listAdminOrders } = await import("@/server/repos/orders-admin");
    return await listAdminOrders(data);
  });

export const getAdminOrderDetail = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ orderId: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { getAdminOrderDetail } = await import("@/server/repos/orders-admin");
    return await getAdminOrderDetail(data.orderId);
  });

/**
 * 標記一張訂單已收款（呼叫 0034 §5 的 admin_mark_order_paid()）。
 *
 * p_actor_id 只認 context.admin.userId —— 與 inv-vendors.ts 的
 * readVendorSensitive() 同一個立場：「是誰做的」不能由呼叫端在 data 裡宣稱，
 * 只能從已經驗證過的 session 讀。data 裡因此**沒有** actorId 這個欄位。
 *
 * 只有 reason==='marked' 才代表這一次呼叫真的讓一筆新的付款生效，才順手觸發付款
 * 通知；其餘三種 reason（already_paid／order_not_pending／order_not_found）都代表
 * 沒有新的付款事件發生，通知會是重複或無意義的，不觸發。
 */
export const markOrderPaidAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      orderId: z.string().trim().uuid(),
      note: z.string().trim().max(500).nullable(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { markOrderPaidByAdmin } = await import("@/server/repos/orders-admin");
    const result = await markOrderPaidByAdmin({
      orderId: data.orderId,
      actorId: context.admin.userId,
      note: data.note,
    });

    if (result.reason === "marked") {
      // best-effort、8 秒逾時保護，失敗不影響上面已經成立的標記結果 —— 信本來就
      // 會被 notifyBacklog 的排程補寄，見 src/server/notify.ts 檔頭。
      const { triggerNotifyAfterPayment } = await import("@/server/notify");
      await triggerNotifyAfterPayment(data.orderId);
    }

    return result;
  });

/**
 * 刪除一張未付款／已取消的訂單（0035，呼叫 admin_delete_order()）。
 *
 * actorId 同 markOrderPaidAdmin()：只認 context.admin.userId，data 裡沒有這個
 * 欄位——呼叫端不能宣稱是誰做的。
 */
export const deleteAdminOrder = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ orderId: z.string().trim().uuid() }))
  .handler(async ({ data, context }) => {
    const { deleteAdminOrder } = await import("@/server/repos/orders-admin");
    return await deleteAdminOrder({ orderId: data.orderId, actorId: context.admin.userId });
  });

/**
 * 封存／取消封存一張已付款訂單（0035，呼叫 admin_archive_order()）。純顯示狀態，
 * 可逆——與 deleteAdminOrder() 不同，這裡沒有拒絕理由要處理，任何存在的訂單都
 * 封存得動。
 */
export const archiveAdminOrder = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ orderId: z.string().trim().uuid(), archived: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { archiveAdminOrder } = await import("@/server/repos/orders-admin");
    return await archiveAdminOrder({
      orderId: data.orderId,
      actorId: context.admin.userId,
      archived: data.archived,
    });
  });

/**
 * 標記已出貨（ship）／已取貨（pickup）／已完成（complete）。
 *
 * 與上面幾支同一個立場：adminFnMiddleware、actorId 只認 context.admin.userId。
 * 條件與狀態轉換在 src/lib/admin/order-fulfillment.ts，寫入是
 * src/server/repos/order-fulfillment.ts 的一句 conditional update。
 *
 * ── 出貨通知信（業主 2026-10-22 核准）───────────────────────────────────────
 * 只有 action === "ship" **且** 這一次真的寫入了（reason === "updated"，也就是
 * processing → shipped 剛剛發生）才排出貨通知信給訂購人。冪等的 already_done、
 * 門市自取（pickup）、已出貨 → 已完成（complete）都不寄。dedupe_key
 * `order_shipped:<order_id>` 保證同一張單只會有一封。
 *
 * 🔴 排信失敗**不回滾、也不讓這次呼叫失敗**——狀態已經寫進去了。回傳值多一個
 *    `notify_warning` 讓後台顯示「狀態已更新，但通知信排入失敗」。
 *
 * 仍然不開發票、不動庫存與名額。
 */
export const advanceOrderFulfillmentAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      orderId: z.string().trim().uuid(),
      action: z.enum(["ship", "pickup", "complete"]),
    }),
  )
  .handler(async ({ data, context }) => {
    const { advanceOrderFulfillment } = await import("@/server/repos/order-fulfillment");
    const { runFulfillmentWithNotify } = await import("@/lib/admin/order-fulfillment");
    return await runFulfillmentWithNotify(data.action, {
      advance: () =>
        advanceOrderFulfillment({
          orderId: data.orderId,
          actorId: context.admin.userId,
          action: data.action,
        }),
      // 只有 processing → shipped 這一次真的發生才會被叫到（見 runFulfillmentWithNotify）。
      notifyShipped: async () => {
        const { triggerNotifyAfterShipped } = await import("@/server/notify");
        return await triggerNotifyAfterShipped(data.orderId);
      },
      onNotifyError: (message) =>
        console.error(`[admin/orders] 出貨通知信例外 order=${data.orderId}：${message}`),
    });
  });
