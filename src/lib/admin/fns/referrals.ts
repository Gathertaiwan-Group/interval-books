/**
 * 推廣與分潤 server functions（/admin/referrals，0040）。
 *
 * 🔴 每一支都掛 adminFnMiddleware —— 與 fns/orders.ts 同一個立場：這一頁看得到
 * 推廣者的聯絡方式、客人的訂單編號，而「標記已結算」是一個會動到錢的動作。門市
 * 人員（staff）不行。scripts/referral-selftest.mjs 會數這個檔案裡的 createServerFn
 * 與 adminFnMiddleware 數量是否相同。
 *
 * 結算的金額**不從 data 來**：伺服器用 period 重算一次報表，取當下的應付金額寫入。
 * 「是誰結算的」也只認 context.admin（同 markOrderPaidAdmin）。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { referralSettingsSchema, referrerSchema } from "@/lib/admin/referral-schemas";
import { PERIOD_RE } from "@/lib/taipei-time";

const periodSchema = z.string().regex(PERIOD_RE);

export const listReferrersAdmin = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listReferrers, getReferralSettings } = await import("@/server/repos/referrals");
    const [referrers, settings] = await Promise.all([listReferrers(), getReferralSettings()]);
    return { referrers, settings };
  });

export const createReferrerAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(referrerSchema)
  .handler(async ({ data }) => {
    const { createReferrer } = await import("@/server/repos/referrals");
    return await createReferrer(data);
  });

export const updateReferrerAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(referrerSchema.extend({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { updateReferrer } = await import("@/server/repos/referrals");
    const { id, ...input } = data;
    return await updateReferrer(id, input);
  });

export const updateReferralSettingsAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(referralSettingsSchema)
  .handler(async ({ data }) => {
    const { updateReferralSettings } = await import("@/server/repos/referrals");
    await updateReferralSettings(data);
    return { ok: true as const };
  });

export const getReferralReportAdmin = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ period: periodSchema }))
  .handler(async ({ data }) => {
    const { getMonthlyReport } = await import("@/server/repos/referrals");
    return await getMonthlyReport(data.period);
  });

export const settleReferralAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      referrerId: z.string().uuid(),
      period: periodSchema,
      note: z.string().trim().max(500).nullable(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { settleReferrerMonth } = await import("@/server/repos/referrals");
    return await settleReferrerMonth({
      referrerId: data.referrerId,
      period: data.period,
      actorId: context.admin.userId,
      actorEmail: context.admin.email,
      note: data.note,
    });
  });
