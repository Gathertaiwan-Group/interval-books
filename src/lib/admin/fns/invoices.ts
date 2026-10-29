/**
 * 發票相關的後台 server functions —— 「N 張已付款訂單的發票尚未開立」橫幅與
 * 「重新開立發票」按鈕（業主 2026-10-28 核准）。
 *
 * 🔴 三支都掛 adminFnMiddleware，只有 role='admin' 能碰，門市人員（staff）不行。
 *    重新開立會打 Amego 開出**真的稅務憑證**，與 fns/orders.ts 的「標記已收款」同一個
 *    等級的動作。授權邊界在 middleware，不在畫面（見 src/lib/admin/middleware.ts 檔頭）。
 *
 * 🔴 actorId 只認 context.admin.userId，data 裡沒有這個欄位（同 markOrderPaidAdmin）。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";

/** 橫幅用：需要人看的發票數。讀失敗回 count=null（畫面說「讀取失敗」，不說 0）。 */
export const getInvoiceProblemSummary = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { loadInvoiceAttentionRows } = await import("@/server/invoice-alerts");
    const rows = await loadInvoiceAttentionRows();
    return { count: rows === null ? null : rows.length };
  });

/**
 * 重新開立一張訂單的發票。只處理這一張；冪等（先查 Amego 有沒有開過、claim 擋併發）。
 * 細節見 src/server/invoice-issuer.ts 的 reissueInvoiceForOrder()。
 */
export const reissueInvoiceAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ orderId: z.string().trim().uuid() }))
  .handler(async ({ data, context }) => {
    const { reissueInvoiceForOrder } = await import("@/server/invoice-issuer");
    return await reissueInvoiceForOrder(data.orderId, context.admin.userId);
  });

/**
 * 作廢一張發票（業主 2026-10-29）。只有 admin（adminFnMiddleware）；狀態檢查、併發鎖、
 * Amego 回應的處理全在 src/lib/invoice-void.ts 的 runInvoiceVoid()。
 *
 * reason 在這裡只擋型別與粗略長度，1–20 字的規則由 runInvoiceVoid 的
 * normalizeVoidReason 判斷（同一支函式也給畫面用），不在兩個地方各寫一套。
 */
export const voidInvoiceAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      orderId: z.string().trim().uuid(),
      invoiceNumber: z
        .string()
        .trim()
        .regex(/^[A-Z]{2}\d{8}$/),
      reason: z.string().max(200),
    }),
  )
  .handler(async ({ data, context }) => {
    const { voidInvoiceForOrder } = await import("@/server/invoice-void");
    return await voidInvoiceForOrder({
      orderId: data.orderId,
      invoiceNumber: data.invoiceNumber,
      reason: data.reason,
      actorId: context.admin.userId,
    });
  });
