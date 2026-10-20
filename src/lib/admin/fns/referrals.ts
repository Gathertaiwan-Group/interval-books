/**
 * 推廣與分潤 server functions（/admin/referrals，0039）。
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
import { parseCommissionTiers, REFERRAL_CODE_RE } from "@/lib/referral";
import { PERIOD_RE } from "@/lib/taipei-time";

const tiersSchema = z
  .array(
    z.object({ upTo: z.number().int().positive().nullable(), rate: z.number().min(0).max(100) }),
  )
  .min(1)
  .max(10)
  .refine((t) => parseCommissionTiers(t) !== null, "級距要由小到大，最後一級不設上限");

const referrerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  code: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, "").toUpperCase())
    .pipe(z.string().regex(REFERRAL_CODE_RE, "推薦碼限 2–20 個英文字母或數字")),
  kind: z.enum(["team", "external"]),
  contact: z.string().trim().max(200).nullable(),
  email: z.string().trim().max(120).nullable(),
  phone: z.string().trim().max(30).nullable(),
  baseSalary: z.number().int().min(0).nullable(),
  discountPercent: z.number().min(0).max(50).nullable(),
  commissionTiers: tiersSchema.nullable(),
  active: z.boolean(),
  note: z.string().trim().max(500).nullable(),
});

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
  .inputValidator(
    z.object({
      defaultDiscountPercent: z.number().min(0).max(50),
      defaultMarginPercent: z.number().min(0).max(100),
      commissionTiers: tiersSchema,
      newCustomerMultiplier: z.number().min(1).max(3),
      teamPoolBaseline: z.number().int().min(0).nullable(),
      teamPoolPercent: z.number().min(0).max(50),
      teamPoolEqualPercent: z.number().min(0).max(100),
      payoutCapPercent: z.number().min(0).max(100),
      clawbackDays: z.number().int().min(0).max(365),
    }),
  )
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
