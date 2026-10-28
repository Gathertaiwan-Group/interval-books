/**
 * 異業合作收件匣（/admin/partnerships）的 server functions。每一支都掛 adminFnMiddleware——
 * 只有 admin（門市人員看不到也叫不動）。那個 middleware，不是側欄或 route guard，才是真正的
 * 授權邊界（見 src/lib/admin/middleware.ts）。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { INQUIRY_STATUSES } from "@/lib/partnership-inbox";

export const listPartnershipInquiries = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ status: z.enum([...INQUIRY_STATUSES, "all"]) }))
  .handler(async ({ data }) => {
    const { listInquiries, countInquiries, INQUIRY_LIST_LIMIT } =
      await import("@/server/repos/partnership-inquiries");
    const [rows, counts] = await Promise.all([listInquiries(data.status), countInquiries()]);
    return { rows, counts, limit: INQUIRY_LIST_LIMIT };
  });

export const getPartnershipInquiry = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { getInquiry } = await import("@/server/repos/partnership-inquiries");
    return await getInquiry(data.id);
  });

export const updatePartnershipInquiry = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      id: z.string().uuid(),
      status: z.enum(INQUIRY_STATUSES),
      admin_note: z.string().max(2000, "內部備註最多 2000 字"),
    }),
  )
  .handler(async ({ data }) => {
    const { updateInquiry } = await import("@/server/repos/partnership-inquiries");
    return await updateInquiry(data.id, { status: data.status, admin_note: data.admin_note });
  });
