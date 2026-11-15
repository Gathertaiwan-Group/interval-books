/**
 * 推廣者與分潤設定的 zod 規則（/admin/referrals，0040）。
 *
 * 從 src/lib/admin/fns/referrals.ts 搬出來成獨立模組，讓後台 server fn 與 MCP
 * （src/server/mcp/partners-content-tools.ts）用**同一份**規則驗輸入——那個 fns 檔案在
 * 載入時就呼叫 createServerFn，MCP 不 import 它。規則本身一個字都沒改。
 */
import { z } from "zod";
import { parseCommissionTiers, REFERRAL_CODE_RE } from "@/lib/referral";

export const tiersSchema = z
  .array(
    z.object({ upTo: z.number().int().positive().nullable(), rate: z.number().min(0).max(100) }),
  )
  .min(1)
  .max(10)
  .refine((t) => parseCommissionTiers(t) !== null, "級距要由小到大，最後一級不設上限");

export const referrerSchema = z.object({
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

export const referralSettingsSchema = z.object({
  defaultDiscountPercent: z.number().min(0).max(50),
  defaultMarginPercent: z.number().min(0).max(100),
  commissionTiers: tiersSchema,
  newCustomerMultiplier: z.number().min(1).max(3),
  teamPoolBaseline: z.number().int().min(0).nullable(),
  teamPoolPercent: z.number().min(0).max(50),
  teamPoolEqualPercent: z.number().min(0).max(100),
  payoutCapPercent: z.number().min(0).max(100),
  clawbackDays: z.number().int().min(0).max(365),
});
