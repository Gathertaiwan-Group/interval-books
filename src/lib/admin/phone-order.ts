/**
 * 後台「新增電話報名」（0050）的規則：表單與 server fn 共用的 zod schema、畫面上的
 * 金額試算。純模組（只 import zod 與 src/lib/checkout.ts 的純函式），瀏覽器與伺服器
 * 都可以用。
 *
 * ── 為什麼不是一個新的建單流程 ─────────────────────────────────────────────
 * 送出後走的是 src/server/repos/orders.ts 的 createOrder()（經 createAdminPhoneOrder()），
 * 也就是前台結帳那八步：價格從票種／商品重讀、reserve_session_seat() 占名額（名額不足、
 * 場次已開始都在那裡擋）、0 元走 settle_free_order()、idempotency_key 防重複送出。
 * 「已收到匯款」再接 admin_mark_order_paid()——與後台把前台匯款單標成已收款**同一支**。
 *
 * ── 這裡的欄位與前台結帳一致 ─────────────────────────────────────────────
 * 訂購人姓名／信箱／手機、發票（個人／載具／統編／捐贈）直接取 checkoutFormSchema()
 * 與 invoiceChoiceSchema()；每位參加者用 participantContactSchema()（同前台的「信箱與
 * 手機至少一項」與格式規則，但沒有客人本人才能勾的注意事項同意）。
 *
 * ⚠️ 金額欄位只有 priceOverride（手動改價），而且伺服器只接受「0 ≤ 改後 ≤ 原價」
 *    （createOrder() 裡再驗一次，原價由伺服器自己算）。畫面上的試算只是給人看的。
 */
import { z } from "zod";
import type { Localized } from "@/i18n/types";
import {
  type CheckoutPayload,
  checkoutFormSchema,
  invoiceChoiceSchema,
  participantContactSchema,
  REMITTANCE_LAST5_RE,
} from "@/lib/checkout";

const zh = (m: Localized) => m.zh;

const buyerSchema = checkoutFormSchema({ t: zh, requireAddress: false }).pick({
  customerName: true,
  customerEmail: true,
  customerPhone: true,
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const PHONE_ORDER_NOTE_MAX = 1000;
export const PRICE_OVERRIDE_REASON_MAX = 200;

export const phoneOrderPaymentSchema = z.discriminatedUnion("status", [
  z.object({
    /** 已收到匯款：建單後立刻 admin_mark_order_paid()。 */
    status: z.literal("paid"),
    paidOn: z
      .string()
      .trim()
      .regex(DATE_RE, "請選擇匯款日期")
      .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "匯款日期不正確"),
    last5: z
      .string()
      .trim()
      .regex(REMITTANCE_LAST5_RE, "帳號末五碼是 5 個數字")
      .nullable()
      .optional(),
  }),
  z.object({
    /** 尚未收到匯款：建成 payment_method='transfer' 的待付款訂單（不會被逾期取消）。 */
    status: z.literal("unpaid"),
  }),
]);

export const phoneOrderSchema = buyerSchema.extend({
  /** 這次送出的 uuid。頁面開啟時產生一次，重送（連點、網路重試）都帶同一個。 */
  idempotencyKey: z.string().uuid(),
  productId: z.string().trim().min(1, "請選擇活動或策旅").max(200),
  sessionId: z.string().uuid("請選擇場次"),
  planId: z.string().uuid().nullable(),
  quantity: z.number().int().min(1, "人數至少 1").max(99),
  participants: z.array(participantContactSchema(zh)).min(1).max(99),
  invoice: invoiceChoiceSchema(zh),
  adminNote: z.string().trim().max(PHONE_ORDER_NOTE_MAX, "內部備註最多 1000 字").nullable(),
  priceOverride: z
    .object({
      amount: z.number().int("金額要是整數").min(0, "金額不能是負的"),
      reason: z
        .string()
        .trim()
        .min(1, "改價要填原因")
        .max(PRICE_OVERRIDE_REASON_MAX, "原因最多 200 字"),
    })
    .nullable(),
  payment: phoneOrderPaymentSchema,
  /** 寄報名成功信給客人。業主決定預設不勾。 */
  notifyCustomer: z.boolean(),
});

export type PhoneOrderInput = z.infer<typeof phoneOrderSchema>;

/** 表單用的選項資料（loader 給）。 */
export type PhoneOrderPlanOption = {
  id: string;
  title: Localized;
  price: number;
  seatsPerUnit: number;
  /** 這個票種還剩幾個單位。 */
  unitsLeft: number;
};

export type PhoneOrderSessionOption = {
  id: string;
  title: Localized | null;
  startsAt: string;
  endsAt: string | null;
  seatsLeft: number;
  capacity: number;
  /** 販售中的票種。空陣列＋hasPlans=false＝這場沒有票種，用活動本身的價格。 */
  plans: PhoneOrderPlanOption[];
  /** 這場有沒有任何開放中的票種（不論是否在販售期間）。有、但沒有販售中的 → 不能報。 */
  hasPlans: boolean;
};

export type PhoneOrderProductOption = {
  id: string;
  title: Localized;
  productType: "event" | "journey";
  price: number;
  sessions: PhoneOrderSessionOption[];
};

/**
 * 依選擇試算：單價、每單位佔幾位、要填幾位參加者、原價總額。
 * 與 priceLines() 同一個規則（選了票種用票種價、座位 = 人數 × seats_per_unit）。
 */
export function quotePhoneOrder(
  product: Pick<PhoneOrderProductOption, "price"> | null,
  plan: Pick<PhoneOrderPlanOption, "price" | "seatsPerUnit"> | null,
  quantity: number,
): { unitPrice: number; seatsPerUnit: number; seats: number; total: number } {
  const unitPrice = plan ? plan.price : (product?.price ?? 0);
  const seatsPerUnit = plan ? Math.max(1, plan.seatsPerUnit) : 1;
  const q = Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
  return { unitPrice, seatsPerUnit, seats: q * seatsPerUnit, total: unitPrice * q };
}

/** 手動改價是否合法（畫面先擋一次；真正的邊界在 createOrder()）。 */
export function priceOverrideError(
  override: { amount: number; reason: string } | null,
  computedTotal: number,
): string | null {
  if (!override) return null;
  if (!Number.isInteger(override.amount) || override.amount < 0) return "金額要是 0 以上的整數";
  if (override.amount > computedTotal) return "手動改價只能改低（不能高於依票種算出的金額）";
  if (override.reason.trim() === "") return "改價要填原因";
  return null;
}

/** 寫進 admin_mark_order_paid() 的 p_note（會存進 payments.raw_response.note）。 */
export function phoneOrderPaidNote(paidOn: string, last5: string | null | undefined): string {
  return `後台電話報名：匯款日 ${paidOn}${last5 ? `，帳號末五碼 ${last5}` : ""}`;
}

/**
 * 表單資料 → createOrder() 吃的 CheckoutPayload。固定值的理由：
 *   · shippingMethod 'none'、address null：活動報名不寄送（伺服器也會從商品重新推導）。
 *   · paymentMethod 'transfer'：電話報名都是匯款（已收到或還沒收到），與前台匯款單同一種；
 *     0 元的單會被 settle_free_order() 改成 'free'。needsContact 一律 false。
 *   · referralCode ''：明確不用推薦碼（createOrder() 對電話報名本來也不解析）。
 *   · noticeAck false：注意事項同意是客人本人在網頁上勾的，店員不能代勾。
 *   · note null：客人備註留給客人；店員的話寫在 adminNote（orders.admin_note）。
 */
export function buildPhoneOrderPayload(data: PhoneOrderInput): CheckoutPayload {
  return {
    customerName: data.customerName,
    customerEmail: data.customerEmail,
    customerPhone: data.customerPhone,
    shippingMethod: "none",
    address: null,
    note: null,
    invoice: data.invoice,
    items: [
      {
        productId: data.productId,
        quantity: data.quantity,
        sessionId: data.sessionId,
        planId: data.planId,
        participants: data.participants.map((p) => ({
          name: p.name,
          email: p.email ?? null,
          phone: p.phone ?? null,
          noticeAck: false,
        })),
      },
    ],
    locale: "zh",
    idempotencyKey: data.idempotencyKey,
    paymentMethod: "transfer",
    needsContact: false,
    referralCode: "",
  };
}
