/**
 * 「MCP 申請作廢待處理」的後台 server functions（MCP 的 request_invoice_void 只記申請、不作廢）。
 * 訂單內頁用；首頁的清單由 fns/dashboard.ts 的 getAdminTodo 一起帶。待處理的定義在
 * src/lib/mcp-void-requests.ts。
 *
 * 🔴 兩支都掛 adminFnMiddleware，只有 admin（同「作廢發票」）。作廢本身仍走
 *    fns/invoices.ts 的 voidInvoiceAdmin；這裡不碰發票。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";

export const getMcpVoidRequestsAdmin = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ orderId: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { loadPendingVoidRequests } = await import("@/server/repos/mcp-void-requests");
    return await loadPendingVoidRequests({ orderId: data.orderId });
  });

/** 「不處理，關閉申請」：寫一筆 invoice_void_request_dismissed。關閉者只從 context.admin 來。 */
export const dismissMcpVoidRequestAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ orderId: z.string().trim().uuid() }))
  .handler(async ({ data, context }) => {
    const { dismissVoidRequest } = await import("@/server/repos/mcp-void-requests");
    await dismissVoidRequest({
      orderId: data.orderId,
      adminUserId: context.admin.userId,
      adminEmail: context.admin.email,
    });
    return { ok: true as const };
  });
