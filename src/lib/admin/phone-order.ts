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
 * ── 聯絡資料比前台寬（0051，只限電話報名）──────────────────────────────────
 * 接電話常常要不到完整資料，所以這裡**不**沿用前台的訂購人／參加者規則：
 *   · 訂購人：姓名必填；手機或 Email 至少一項。有填的才驗格式（09 開頭 10 碼、合法 Email）。
 *   · 參加者：姓名、手機、Email 都可以留空。姓名留空 → defaultParticipantName()：
 *     第 1 位帶訂購人姓名，第 N+1 位帶「訂購人姓名 同行者 N」。
 *   · 勾「寄報名成功信給客人」一定要有訂購人 Email（phoneOrderNotifyError()，表單與
 *     server fn 都檢查；資料庫 CHECK orders_admin_phone_notify_email 是最後一道）。
 * 前台結帳（src/lib/checkout.ts 的 checkoutFormSchema／participantSchema、createOrder()
 * 對 web 訂單的檢查、event_registrations_contactable）一個字都沒有放寬。
 * 發票（個人／載具／統編／捐贈）仍與前台同一份 invoiceChoiceSchema()。
 *
 * ⚠️ 金額欄位只有 priceOverride（手動改價），而且伺服器只接受「0 ≤ 改後 ≤ 原價」
 *    （createOrder() 裡再驗一次，原價由伺服器自己算）。畫面上的試算只是給人看的。
 */
import { z } from "zod";
import type { Localized } from "@/i18n/types";
import { type CheckoutPayload, invoiceChoiceSchema, REMITTANCE_LAST5_RE } from "@/lib/checkout";

const zh = (m: Localized) => m.zh;

/** 與前台 TW_MOBILE（src/lib/checkout.ts）同一條：09 開頭 10 碼。 */
export const PHONE_ORDER_MOBILE_RE = /^09\d{8}$/;
/** 與前台訂購人 Email 同一個判斷（zod 的 .email()）。 */
const isEmail = (v: string) => z.string().email().safeParse(v).success;

export const PARTICIPANT_NAME_MAX = 60;

/** 沒填就是空字串；有填才驗格式。 */
const optionalEmail = z
  .string()
  .trim()
  .max(120, "Email 太長")
  .refine((v) => v === "" || isEmail(v), "Email 格式不正確")
  .nullable()
  .optional()
  .transform((v) => v ?? "");
const optionalMobile = z
  .string()
  .trim()
  .max(30, "手機太長")
  .refine((v) => v === "" || PHONE_ORDER_MOBILE_RE.test(v), "手機要是 09 開頭的 10 碼數字")
  .nullable()
  .optional()
  .transform((v) => v ?? "");

/**
 * 一位參加者：三欄都可以留空（0051）。姓名空白由 buildPhoneOrderPayload() 補預設值。
 * 有填的聯絡方式才驗格式。
 */
export const phoneOrderParticipantSchema = z.object({
  name: z.string().trim().max(PARTICIPANT_NAME_MAX, "姓名最多 60 字").nullable().optional(),
  email: optionalEmail,
  phone: optionalMobile,
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

const phoneOrderObject = z.object({
  customerName: z.string().trim().min(1, "請輸入姓名").max(60, "姓名最多 60 字"),
  /** 沒有就送空字串（orders.customer_email 是 NOT NULL，存 ''）。 */
  customerEmail: optionalEmail,
  customerPhone: optionalMobile,
  /** 這次送出的 uuid。頁面開啟時產生一次，重送（連點、網路重試）都帶同一個。 */
  idempotencyKey: z.string().uuid(),
  productId: z.string().trim().min(1, "請選擇活動或策旅").max(200),
  sessionId: z.string().uuid("請選擇場次"),
  planId: z.string().uuid().nullable(),
  quantity: z.number().int().min(1, "人數至少 1").max(99),
  participants: z.array(phoneOrderParticipantSchema).min(1).max(99),
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
  /** 寄報名成功信給客人。業主決定預設不勾。沒有訂購人 Email 時不能勾（見 phoneOrderNotifyError）。 */
  notifyCustomer: z.boolean(),
});

/**
 * 表單與 server fn 共用。訂購人手機與 Email 至少一項（0051）。
 *
 * 「勾了寄信卻沒有 Email」**不在**這裡：server fn 要回店員看得懂的一句話，而不是
 * inputValidator 丟出的 zod 錯誤，所以那一條是 phoneOrderNotifyError()。
 */
export const phoneOrderSchema = phoneOrderObject.superRefine((v, ctx) => {
  if (v.customerEmail === "" && v.customerPhone === "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["customerPhone"],
      message: "手機或 Email 至少填一項",
    });
  }
});

export type PhoneOrderInput = z.infer<typeof phoneOrderSchema>;

export const NOTIFY_NEEDS_EMAIL_TEXT = "訂購人沒有 Email，無法寄信";

/** 勾了「寄報名成功信給客人」卻沒有訂購人 Email → 錯誤訊息；沒問題回 null。 */
export function phoneOrderNotifyError(input: {
  notifyCustomer: boolean;
  customerEmail: string | null | undefined;
}): string | null {
  if (!input.notifyCustomer) return null;
  return (input.customerEmail ?? "").trim() === ""
    ? `${NOTIFY_NEEDS_EMAIL_TEXT}。請補上訂購人 Email，或取消勾選「寄報名成功信給客人」。`
    : null;
}

/**
 * 參加者姓名留空時的預設值（0051）：第 1 位＝訂購人姓名；第 i+1 位＝「訂購人姓名 同行者 i」。
 * 超過 60 字（registration 姓名上限）時截訂購人姓名那一段，後綴保留。
 * 訂購人姓名也還沒填時回空字串（表單 placeholder 用）。
 */
export function defaultParticipantName(buyerName: string, index: number): string {
  const buyer = buyerName.trim();
  if (buyer === "") return "";
  if (index <= 0) return buyer.slice(0, PARTICIPANT_NAME_MAX);
  const suffix = ` 同行者 ${index}`;
  return `${buyer.slice(0, PARTICIPANT_NAME_MAX - suffix.length)}${suffix}`;
}

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
 *   · 參加者姓名留空 → defaultParticipantName()；聯絡方式留空 → null（0051）。
 */
export function buildPhoneOrderPayload(data: PhoneOrderInput): CheckoutPayload {
  return {
    customerName: data.customerName,
    // 0051：沒填的一欄是空字串（orders 兩欄 NOT NULL；CHECK orders_admin_phone_contact
    // 保證至少一項）。發票開立時空字串＝不送 BuyerEmailAddress。
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
        participants: data.participants.map((p, i) => ({
          name: (p.name ?? "").trim() || defaultParticipantName(data.customerName, i),
          email: p.email || null,
          phone: p.phone || null,
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

// ---------------------------------------------------------------------------
// 0051：事後補資料（訂單內頁「編輯訂購人／參加者聯絡資料」）
// ---------------------------------------------------------------------------

/** 編輯表單讀到／送出的一位參加者。id＝event_registrations.id。 */
export type PhoneOrderContactPerson = {
  id: string;
  seatNo: number;
  name: string;
  email: string | null;
  phone: string | null;
};

export type PhoneOrderContacts = {
  customer: { name: string; email: string; phone: string };
  notifyCustomer: boolean;
  participants: PhoneOrderContactPerson[];
};

/**
 * 送出的編輯內容。規則同新增電話報名：訂購人姓名必填、手機或 Email 至少一項、有填才驗
 * 格式；參加者姓名必填（編輯時預填目前的名字，清空就是真的要清，不再自動帶預設值），
 * 聯絡方式可以空。只有姓名／手機／Email 三欄，zod 會丟掉其他鍵。
 */
export const phoneOrderContactEditSchema = z.object({
  orderId: z.string().trim().uuid(),
  customer: z
    .object({
      name: z.string().trim().min(1, "訂購人姓名必填").max(60, "姓名最多 60 字"),
      email: optionalEmail,
      phone: optionalMobile,
    })
    .superRefine((v, ctx) => {
      if (v.email === "" && v.phone === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phone"],
          message: "手機或 Email 至少填一項",
        });
      }
    }),
  participants: z
    .array(
      z.object({
        id: z.string().trim().uuid(),
        name: z
          .string()
          .trim()
          .min(1, "參加者姓名必填")
          .max(PARTICIPANT_NAME_MAX, "姓名最多 60 字"),
        email: optionalEmail,
        phone: optionalMobile,
      }),
    )
    .max(99),
});

export type PhoneOrderContactEditInput = z.infer<typeof phoneOrderContactEditSchema>;
