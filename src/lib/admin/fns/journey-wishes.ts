/**
 * 旅程願望收件匣（/admin/journey-wishes）的 server functions。每一支都掛 adminFnMiddleware——
 * 只有 admin。那個 middleware，不是側欄或 route guard，才是真正的授權邊界
 * （見 src/lib/admin/middleware.ts）。照 src/lib/admin/fns/partnerships.ts。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { WISH_STATUSES } from "@/lib/journey-wish-inbox";

export const listJourneyWishes = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ status: z.enum([...WISH_STATUSES, "all"]) }))
  .handler(async ({ data }) => {
    const { listWishes, countWishes, WISH_LIST_LIMIT } =
      await import("@/server/repos/journey-wishes");
    const [rows, counts] = await Promise.all([listWishes(data.status), countWishes()]);
    return { rows, counts, limit: WISH_LIST_LIMIT };
  });

export const getJourneyWish = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { getWish } = await import("@/server/repos/journey-wishes");
    return await getWish(data.id);
  });

export const updateJourneyWish = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      id: z.string().uuid(),
      status: z.enum(WISH_STATUSES),
      admin_note: z.string().max(2000, "內部備註最多 2000 字"),
    }),
  )
  .handler(async ({ data }) => {
    const { updateWish } = await import("@/server/repos/journey-wishes");
    return await updateWish(data.id, { status: data.status, admin_note: data.admin_note });
  });
