/**
 * Checkout rules shared by the browser and the server.
 *
 * Everything in here is pure: no Supabase client, no server-only import, no
 * React. That is what lets the same shipping formula price the summary the
 * shopper is looking at and the order that actually gets written, instead of
 * two implementations drifting apart — which is precisely how the Realreal
 * storefront ended up with four different shipping tables (see the comment on
 * SHIPPING_RULES).
 *
 * The one thing this module deliberately cannot do is *decide* what anything
 * costs. computeShippingFee() takes a subtotal; it does not compute one. Line
 * prices come from public.products inside src/server/repos/orders.ts and
 * nowhere else, so a tampered request can change what is bought but never what
 * it costs.
 */
import { z } from "zod";
import type { Lang, Localized } from "@/i18n/types";
import {
  CARRIER_MOBILE,
  CARRIER_NPC,
  INVOICE_TYPES,
  isValidLoveCode,
  isValidMobileCarrier,
  isValidNpcCarrier,
  isValidTaxId,
  type InvoiceType,
} from "@/lib/invoice-format";

/** Mirrors orders.shipping_method's CHECK in 0005_commerce_orders.sql. */
export type ShippingMethod = "home" | "cvs" | "pickup" | "none";

/** Mirrors order_items.product_type's CHECK in 0005_commerce_orders.sql. */
export type ProductTypeForOrder = "goods" | "book" | "event" | "journey";

/**
 * What the shopper may ask to pay with.
 *
 * A subset of orders.payment_method's CHECK
 * ('card','atm','cvs_cod','test_paid','free','transfer'):
 *
 *   card      → the gateway path (黑貓 PAY / PayUni). Writes 'card'.
 *   transfer  → 匯款：the shopper wires money to the shop's own fixed bank
 *               account and reports the last five digits; the shop reconciles
 *               by hand (0034). Writes 'transfer'. **NOT the same as 'atm'** —
 *               that value means "the gateway minted a virtual account number
 *               and will reconcile it automatically" (src/server/blackcat.ts),
 *               which is a different thing with a different failure mode.
 *   offline   → not a payment_method at all: it writes NULL and means "we will
 *               arrange payment with you", which is what this shop did before
 *               the gateway existed and what it falls back to when no gateway
 *               is configured.
 *
 * ⚠️ This field must never influence money. Prices, shipping and the total are
 * re-read from public.products on the server (see src/server/repos/orders.ts);
 * choosing a payment method changes where the shopper is sent next and nothing
 * else.
 */
export const PAYMENT_METHODS = ["card", "transfer", "offline"] as const;
export type PaymentMethodChoice = (typeof PAYMENT_METHODS)[number];

/**
 * 結帳頁實際畫出來的付款選項（0048，業主方案 A）。
 *
 * 「銀行匯款」與「由我們與你聯繫付款」合併：結帳頁只剩 card 與 transfer，想要店家
 * 主動聯繫的客人選 transfer 並勾「我需要專人聯繫協助付款」（needsContact）。
 *
 * offline 只在 card 與 transfer **都沒有設定**時出現（＝不畫 radio、只印說明的那個
 * 降級畫面）——那是沒有金流、也沒有匯款帳戶的部署唯一能成立訂單的路，拿掉它等於
 * 那種部署整個結帳壞掉。正式站設好了匯款帳戶，所以客人看不到它。
 */
export function checkoutMethodOptions(opts: {
  cardAvailable: boolean;
  transferAvailable: boolean;
}): PaymentMethodChoice[] {
  const out: PaymentMethodChoice[] = [];
  if (opts.cardAvailable) out.push("card");
  if (opts.transferAvailable) out.push("transfer");
  if (out.length === 0) out.push("offline");
  return out;
}

/**
 * 伺服器端：結帳請求的付款選擇 → 要寫進 orders 的兩欄（0048）。
 *
 * 🔴 送來 offline（＝payment_method NULL）的新請求：**店家設好匯款帳戶時自動轉成
 *    transfer + needs_contact = true**，不拒絕。理由：
 *      · offline 的原意就是「請店家聯繫我付款」，transfer + 需聯繫 是它在新流程裡
 *        一模一樣的意思，沒有資訊遺失；
 *      · 會送 offline 的只有部署前就開著的舊分頁（舊版 JS 預設就是 offline，zod 的
 *        default 也是），拒絕會讓這位客人在最後一步看到錯誤、購物車白填；
 *      · 轉成 transfer 之後他會拿到匯款帳號與 3 天保留（舊 NULL 單只有 2 小時），
 *        店家也會在通知信與後台看到「需聯繫」，對兩邊都比較好。
 *    沒有匯款帳戶的部署照舊寫 NULL（那是它唯一的路，見 checkoutMethodOptions）。
 *
 * needsContact 只對 transfer 生效；card 一律 false（勾選框只在選匯款時出現，送來
 * card + true 是竄改或殘留狀態，不該讓刷卡單在後台被標成需聯繫）。
 */
export function resolveOrderPaymentChoice(input: {
  paymentMethod: PaymentMethodChoice;
  needsContact: boolean;
  transferAvailable: boolean;
}): { paymentMethod: "card" | "transfer" | null; needsContact: boolean } {
  if (input.paymentMethod === "card") return { paymentMethod: "card", needsContact: false };
  if (input.paymentMethod === "transfer") {
    return { paymentMethod: "transfer", needsContact: input.needsContact === true };
  }
  // offline
  if (input.transferAvailable) return { paymentMethod: "transfer", needsContact: true };
  return { paymentMethod: null, needsContact: false };
}

/**
 * 匯款期限：下單 + 3 天。
 *
 * 🔴 這個數字**必須**與 supabase/migrations/0034 的 expire_unpaid_orders() 裡的
 *    `greatest(p_older_than, interval '3 days')` 一致。兩邊分岔的後果是完成頁與信
 *    上寫著「3 天內匯款」，而排程在第 2 天就把訂單連同座位一起收走了 —— 客人照著
 *    我們寫的期限去匯款，錢進來時訂單已經不存在。
 *
 * scripts/notify-selftest.mjs 有一條把這個常數拿去 0034 的 SQL 裡對的斷言。
 */
export const REMITTANCE_DUE_DAYS = 3;

/** 匯款帳戶。四個欄位都空＝店家還沒設定，前端就不顯示匯款選項。 */
export type RemittanceAccount = {
  bankName: string;
  bankCode: string;
  bankAccount: string;
  accountName: string;
};

/** 這個站有沒有可以顯示的匯款帳戶。戶名與帳號是最低限度——少了任何一個都匯不了款。 */
export function remittanceConfigured(account: RemittanceAccount | null | undefined): boolean {
  if (!account) return false;
  return account.bankAccount.trim() !== "" && account.accountName.trim() !== "";
}

/**
 * 匯款期限的 ISO 字串。輸入是訂單的 created_at。
 *
 * 純函式（沒有 `new Date()` 的隱含現在時間），所以測得起來：見
 * scripts/notify-selftest.mjs。壞掉的日期字串回 null 而不是 Invalid Date —— 一個
 * 印著「請於 Invalid Date 前完成匯款」的頁面比一個沒有印期限的頁面糟。
 */
export function remittanceDueAt(createdAtIso: string): string | null {
  const t = Date.parse(createdAtIso);
  if (Number.isNaN(t)) return null;
  return new Date(t + REMITTANCE_DUE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** 末五碼的唯一格式定義。前端、server function 與 0034 的 CHECK 三處共用同一條規則。 */
export const REMITTANCE_LAST5_RE = /^[0-9]{5}$/;

/**
 * A gateway hand-off, as the browser must perform it.
 *
 * ⚠️ **The two gateways hand off in genuinely different ways, and neither can be
 * expressed as the other.** This is a union rather than a single shape because
 * flattening it would break one of them:
 *
 *   kind: "form"      PayUni 直連 UPP。它**沒有**「伺服器端建立交易、拿回導向網址」
 *                     的流程 —— 交易是在*瀏覽器*把 MerID / Version / EncryptInfo /
 *                     HashInfo POST 過去的那一刻才產生的。所以這裡是一張要組出來
 *                     然後送出的表單，不是一個可以導過去的網址。想把它「簡化」成
 *                     redirect 的每一次嘗試，結局都是客人看著 PayUni 的錯誤頁。
 *
 *   kind: "redirect"  黑貓 PAY（統一客樂得 COCS）。**這是這家店實際在跑的那條。**
 *                     伺服器端呼叫 CocsOrderAppend 就把訂單建出來了，回覆裡直接帶
 *                     一個線上刷卡網址（規格 V1.28.2 P42 的 `url` 欄位）。反過來,
 *                     把它硬塞成 form 也不行 —— 那個網址是 GET 的，POST 過去沒有意義。
 *
 * 兩者共存不是過渡狀態：黑貓是現在在跑的，PayUni 留著是為了哪天真的開直連。
 */
export type PaymentHandoff =
  | {
      kind: "form";
      action: string;
      fields: Record<string, string>;
    }
  | {
      kind: "redirect";
      url: string;
    };

// -----------------------------------------------------------------------------
// Shipping
// -----------------------------------------------------------------------------

/**
 * TWD whole dollars. `freeThreshold: 0` means "this method has no free-shipping
 * tier" — not "everything is free" — which is the same convention Realreal uses
 * (apps/api/src/lib/shipping.ts).
 *
 * WHY THESE NUMBERS ARE CONSTANTS AND NOT A SETTINGS TABLE
 * --------------------------------------------------------
 * Realreal keeps its rates in an encrypted app_settings table with a 30-second
 * cache and a code-level fallback. That indirection is why it now has FOUR
 * disagreeing sources of truth — the DB seed says 100/60, the code defaults say
 * 150/80, the hard fallback says 80/80 with a free threshold of *zero*, and a
 * dead client-side copy says 100/80. Its own 0029 migration exists to explain
 * an outage where the encrypted read failed and free shipping silently
 * switched off site-wide for everyone.
 *
 * A two-method shop with one rate each does not need any of that. These are the
 * rates from Realreal's own seed migration (0027_shipping_settings.sql), stated
 * once, in the open, where a code review can see them change.
 *
 * `cvs` is priced but not offered: convenience-store pickup needs ECPay's store
 * picker to produce a store id, and there is nowhere to put one yet. The rate
 * is here so that turning it on later is a UI change, not a pricing decision.
 */
export const SHIPPING_RULES: Record<ShippingMethod, { fee: number; freeThreshold: number }> = {
  home: { fee: 100, freeThreshold: 999 },
  cvs: { fee: 60, freeThreshold: 499 },
  pickup: { fee: 0, freeThreshold: 0 },
  none: { fee: 0, freeThreshold: 0 },
};

/** What the checkout form actually shows. See the `cvs` note on SHIPPING_RULES. */
export const OFFERED_SHIPPING_METHODS = ["home", "pickup"] as const;
export type OfferedShippingMethod = (typeof OFFERED_SHIPPING_METHODS)[number];

/**
 * Freight for one cart.
 *
 * `needsShipping` comes from the products, never from the form: a cart holding
 * only event or journey bookings (products.requires_shipping = false) has
 * nothing to post, so it pays nothing and is never asked for an address.
 * Realreal has no equivalent — it has no per-product shipping flag at all and
 * charges one cart-wide rate regardless — so this is the one place the model
 * here is deliberately larger than the one it was copied from.
 */
export function computeShippingFee({
  needsShipping,
  method,
  subtotal,
}: {
  needsShipping: boolean;
  method: ShippingMethod;
  subtotal: number;
}): number {
  if (!needsShipping) return 0;
  const rule = SHIPPING_RULES[method] ?? SHIPPING_RULES.home;
  if (rule.freeThreshold > 0 && subtotal >= rule.freeThreshold) return 0;
  return rule.fee;
}

/** How much more is needed to reach free shipping, or null when it does not apply. */
export function amountToFreeShipping({
  needsShipping,
  method,
  subtotal,
}: {
  needsShipping: boolean;
  method: ShippingMethod;
  subtotal: number;
}): number | null {
  if (!needsShipping) return null;
  const rule = SHIPPING_RULES[method] ?? SHIPPING_RULES.home;
  if (rule.freeThreshold <= 0) return null;
  const gap = rule.freeThreshold - subtotal;
  return gap > 0 ? gap : null;
}

// -----------------------------------------------------------------------------
// Failures
// -----------------------------------------------------------------------------

/**
 * A checkout failure the shopper is allowed to see, as a stable token rather
 * than a sentence. The server has no business choosing between zh, en and ja —
 * the browser knows which one is on screen, so it does the rendering.
 */
export type CheckoutErrorCode =
  | "cart_empty"
  | "product_unavailable"
  | "insufficient_stock"
  | "no_seats_left"
  | "shipping_address_required"
  | "order_failed"
  | "payment_unavailable"
  | "payment_already_settled"
  | "referral_invalid";

export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode;
  constructor(code: CheckoutErrorCode) {
    super(code);
    this.name = "CheckoutError";
    this.code = code;
  }
}

export const CHECKOUT_ERROR_COPY: Record<CheckoutErrorCode, Localized> = {
  cart_empty: {
    zh: "購物車是空的。",
    en: "Your cart is empty.",
    ja: "カートが空です。",
  },
  product_unavailable: {
    zh: "購物車中有商品已經下架，請回到購物車移除後再結帳。",
    en: "Something in your cart is no longer available. Please remove it in the cart and try again.",
    ja: "カート内に取り扱いを終了した商品があります。カートで削除してからお進みください。",
  },
  insufficient_stock: {
    zh: "庫存不足，訂單沒有成立。請回到購物車調整數量。",
    en: "There is not enough stock, so no order was created. Please adjust the quantity in your cart.",
    ja: "在庫が足りないため、ご注文は成立していません。カートで数量をご調整ください。",
  },
  no_seats_left: {
    zh: "名額已滿，訂單沒有成立。請回到購物車調整數量。",
    en: "There are no places left, so no order was created. Please adjust the quantity in your cart.",
    ja: "空き枠がないため、ご注文は成立していません。カートで数量をご調整ください。",
  },
  shipping_address_required: {
    zh: "這筆訂單需要寄送地址。",
    en: "This order needs a delivery address.",
    ja: "このご注文にはお届け先の住所が必要です。",
  },
  order_failed: {
    zh: "訂單建立失敗，請稍後再試。若持續發生，歡迎來信告訴我們。",
    en: "We could not create the order. Please try again shortly, or write to us if it keeps happening.",
    ja: "ご注文を作成できませんでした。しばらくしてからお試しいただくか、解決しない場合はご連絡ください。",
  },
  payment_unavailable: {
    zh: "線上付款暫時無法使用。訂單已經保留，我們會直接與你聯繫付款方式。",
    en: "Online payment is temporarily unavailable. Your order is held and we will arrange payment with you directly.",
    ja: "オンライン決済を一時的にご利用いただけません。ご注文はお預かりしておりますので、お支払い方法は個別にご案内いたします。",
  },
  payment_already_settled: {
    zh: "這筆訂單已經不需要再付款了。",
    en: "This order no longer needs to be paid.",
    ja: "このご注文は、これ以上のお支払いは不要です。",
  },
  // 0040：客人**自己打的**推薦碼無效或已停用。訂單沒有成立 —— 照原價成立會讓客人
  // 付的錢比畫面上看到的多。cookie 帶來的碼無效則靜默忽略（客人沒看過它）。
  referral_invalid: {
    zh: "推薦碼無效或已停用，訂單沒有成立。請修改或清空推薦碼後再送出。",
    en: "That referral code is not valid, so no order was created. Please correct or clear it and try again.",
    ja: "紹介コードが無効のため、ご注文は成立していません。修正するか空欄にしてから再度お進みください。",
  },
};

const KNOWN_CODES = new Set(Object.keys(CHECKOUT_ERROR_COPY));

/**
 * Turns whatever came back from the server function into copy in the current
 * language. Accepts a bare code (the normal path — placeOrder *returns*
 * failures rather than throwing them) or a thrown Error (the path that only
 * fires when the transport itself broke).
 *
 * Anything unrecognized is reported as a generic failure rather than printed.
 * Server-side exception text is written for a log, not for a shopper, and tends
 * to say more about the system than it should.
 */
export function checkoutErrorText(codeOrError: unknown, lang: Lang): string {
  const raw =
    typeof codeOrError === "string"
      ? codeOrError
      : codeOrError instanceof Error
        ? codeOrError.message
        : "";
  const code = (KNOWN_CODES.has(raw) ? raw : "order_failed") as CheckoutErrorCode;
  return CHECKOUT_ERROR_COPY[code][lang] || CHECKOUT_ERROR_COPY[code].zh;
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/**
 * Taiwan mobile numbers, copied verbatim from Realreal's checkout
 * (apps/web/src/app/checkout/page.tsx). Its API later relaxed the same field to
 * `min(1)` to accommodate overseas numbers; this shop posts domestically only,
 * so the strict form is kept on both sides rather than validated in the browser
 * and waved through on the server.
 */
const TW_MOBILE = /^09\d{8}$/;

type Translate = (value: Localized) => string;

const MSG = {
  name: { zh: "請輸入姓名", en: "Please enter a name", ja: "お名前をご入力ください" },
  nameLong: { zh: "姓名過長", en: "That name is too long", ja: "お名前が長すぎます" },
  email: {
    zh: "請輸入電子信箱",
    en: "Please enter an email address",
    ja: "メールアドレスをご入力ください",
  },
  emailFormat: {
    zh: "電子信箱格式不正確",
    en: "That email address does not look right",
    ja: "メールアドレスの形式が正しくありません",
  },
  phone: {
    zh: "請輸入手機號碼（09 開頭共 10 碼）",
    en: "Please enter a mobile number (10 digits starting 09)",
    ja: "携帯番号をご入力ください（09 で始まる 10 桁）",
  },
  recipient: {
    zh: "請輸入收件人姓名",
    en: "Please enter a recipient",
    ja: "お届け先のお名前をご入力ください",
  },
  city: { zh: "請輸入縣市", en: "Please enter a city", ja: "市・県をご入力ください" },
  street: { zh: "請輸入詳細地址", en: "Please enter a street address", ja: "住所をご入力ください" },
  tooLong: { zh: "內容過長", en: "That is too long", ja: "内容が長すぎます" },
  noteLong: {
    zh: "備註最多 500 字",
    en: "Notes are limited to 500 characters",
    ja: "備考は 500 文字までです",
  },
  taxId: {
    zh: "請輸入 8 碼統一編號",
    en: "Please enter the 8-digit business number",
    ja: "8 桁の統一番号をご入力ください",
  },
  taxIdInvalid: {
    zh: "統一編號檢核碼不正確，請再確認一次",
    en: "That business number fails its check digit — please check it again",
    ja: "統一番号のチェックディジットが正しくありません。ご確認ください",
  },
  carrierMobile: {
    zh: "手機條碼載具為 / 開頭共 8 碼（可含 0-9、A-Z、+、-、.）",
    en: "A mobile barcode is 8 characters starting with / (0-9, A-Z, +, -, . allowed)",
    ja: "携帯バーコードは / で始まる 8 文字です（0-9、A-Z、+、-、. が使えます）",
  },
  carrierNpc: {
    zh: "自然人憑證載具為 2 個大寫英文字母 + 14 個數字",
    en: "A citizen digital certificate is 2 capital letters followed by 14 digits",
    ja: "自然人証明書は大文字 2 字 + 数字 14 桁です",
  },
  loveCode: {
    zh: "愛心碼為 3–7 位數字",
    en: "A donation code is 3–7 digits",
    ja: "愛心コードは 3〜7 桁の数字です",
  },
  participantName: {
    zh: "請輸入參加者姓名",
    en: "Please enter this attendee's name",
    ja: "参加者のお名前をご入力ください",
  },
  participantContact: {
    zh: "請至少留下電子信箱或手機號碼其中一項",
    en: "Please leave at least an email address or a mobile number",
    ja: "メールアドレスか携帯番号のいずれかをご入力ください",
  },
  participantNotice: {
    zh: "請先閱讀並同意活動注意事項",
    en: "Please read and accept the activity notes first",
    ja: "ご参加にあたっての注意事項をご確認のうえ、同意してください",
  },
} satisfies Record<string, Localized>;

/**
 * 發票開法的欄位規則。
 *
 * ⚠️ 這個 schema 裡沒有任何金額欄位，而且不可以加。發票決定的是「這張稅務憑證的抬頭
 * 與載具」，不是「客人要付多少錢」——金額一律由 src/server/repos/orders.ts 從
 * public.products 重算。checkoutPayloadSchema 的註解說的「這裡沒有一個欄位動得了錢」
 * 在加了發票之後仍然成立，靠的就是這件事。
 *
 * 三種開法各自只驗自己那組欄位，錯誤用 superRefine 掛在**該欄位的 path 上**，
 * react-hook-form 才會把訊息印在那個輸入框旁邊，而不是變成一個沒有出處的表單層錯誤
 * （或更糟：handleSubmit 靜默地不送出，畫面上什麼都沒有）。
 */
function invoiceSchema(t: Translate) {
  return z
    .object({
      type: z.enum(INVOICE_TYPES).default("personal"),
      taxId: z.string().trim().max(20, t(MSG.tooLong)).optional().nullable(),
      companyTitle: z.string().trim().max(60, t(MSG.tooLong)).optional().nullable(),
      carrierType: z.string().trim().max(20, t(MSG.tooLong)).optional().nullable(),
      carrierNumber: z.string().trim().max(64, t(MSG.tooLong)).optional().nullable(),
      loveCode: z.string().trim().max(7, t(MSG.tooLong)).optional().nullable(),
    })
    .superRefine((value, ctx) => {
      if (value.type === "company") {
        const taxId = (value.taxId ?? "").trim();
        if (!/^\d{8}$/.test(taxId)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["taxId"], message: t(MSG.taxId) });
        } else if (!isValidTaxId(taxId)) {
          // 檢核碼是與「8 碼數字」分開的一則訊息：客人打滿 8 碼之後看到「請輸入 8 碼」
          // 會以為是自己數錯了，而真正的問題是其中一碼打錯。
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["taxId"],
            message: t(MSG.taxIdInvalid),
          });
        }
        return;
      }

      if (value.type === "donate") {
        if (!isValidLoveCode(value.loveCode)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["loveCode"],
            message: t(MSG.loveCode),
          });
        }
        return;
      }

      // personal：載具是選填的，沒選就什麼都不驗。選了類型才驗號碼。
      const carrierType = (value.carrierType ?? "").trim();
      if (carrierType === CARRIER_MOBILE && !isValidMobileCarrier(value.carrierNumber)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["carrierNumber"],
          message: t(MSG.carrierMobile),
        });
      }
      if (carrierType === CARRIER_NPC && !isValidNpcCarrier(value.carrierNumber)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["carrierNumber"],
          message: t(MSG.carrierNpc),
        });
      }
    });
}

/**
 * 一位參加者。
 *
 * ⚠️ 這裡沒有任何金額欄位，而且不可以加 —— 與 invoiceSchema 同一條規矩
 *    （見 checkoutPayloadSchema 的註解）。它描述的是「誰要來」，不是「要付多少」。
 *
 * `email` 與 `phone` 各自可以留空，但不能兩個都空：現場找不到人的一列名單沒有用。
 * 這條規則與 0020 的 `event_registrations_contactable` CHECK 逐字對應。
 *
 * `noticeAck` 必須是 true。存進資料庫的是 `notice_ack_at`（時間，不是 boolean），
 * 由 reserve_session_seat() 在寫入的當下取 now()。一個永遠沒人勾的同意欄位就是
 * 一個死欄位 —— 那正是 events.registration_type 的下場，所以這裡讓它是必填。
 */
function participantSchema(t: Translate) {
  return z
    .object({
      /** 對應購物車的 cartLineKey()，讓伺服器知道這一位屬於哪一行。 */
      lineKey: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1, t(MSG.participantName)).max(60, t(MSG.nameLong)),
      email: z.string().trim().max(120, t(MSG.tooLong)).optional().nullable(),
      phone: z.string().trim().max(30, t(MSG.tooLong)).optional().nullable(),
      noticeAck: z.boolean(),
    })
    .superRefine((value, ctx) => {
      const hasEmail = (value.email ?? "").trim().length > 0;
      const hasPhone = (value.phone ?? "").trim().length > 0;
      if (!hasEmail && !hasPhone) {
        // 掛在 email 上而不是整個物件上：react-hook-form 才印得到輸入框旁邊。
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["email"],
          message: t(MSG.participantContact),
        });
      }
      if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value.email ?? "").trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["email"],
          message: t(MSG.emailFormat),
        });
      }
      if (hasPhone && !TW_MOBILE.test((value.phone ?? "").trim())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["phone"], message: t(MSG.phone) });
      }
      if (!value.noticeAck) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["noticeAck"],
          message: t(MSG.participantNotice),
        });
      }
    });
}

/**
 * One schema definition, rendered in whichever language is asked for.
 *
 * The browser passes the live translator so a Japanese shopper gets Japanese
 * validation errors; the server function passes the zh reader, because its
 * messages are never displayed — by the time the server rejects something, the
 * browser has already validated it, so a server-side failure means the payload
 * was edited in transit and the shopper sees the generic failure instead.
 */
export function checkoutFormSchema({
  t,
  requireAddress,
}: {
  t: Translate;
  requireAddress: boolean;
}) {
  const strictAddress = z.object({
    recipient: z.string().trim().min(1, t(MSG.recipient)).max(60, t(MSG.nameLong)),
    phone: z.string().trim().regex(TW_MOBILE, t(MSG.phone)),
    postalCode: z.string().trim().max(10, t(MSG.tooLong)).optional().nullable(),
    city: z.string().trim().min(1, t(MSG.city)).max(40, t(MSG.tooLong)),
    district: z.string().trim().max(40, t(MSG.tooLong)).optional().nullable(),
    street: z.string().trim().min(1, t(MSG.street)).max(200, t(MSG.tooLong)),
  });

  /**
   * Same fields, no rules — deliberately NOT `strictAddress.partial()`.
   *
   * `.partial()` only makes a key allowed to be absent; a key that is present
   * and empty still runs its rule. The form keeps `address` mounted with empty
   * defaults so that switching delivery method does not lose what was typed,
   * so under `.partial()` an empty `phone: ""` failed the 09-prefix regex on a
   * field the shopper could not see and had no reason to fill — and
   * handleSubmit then refused to submit, silently, with nothing on screen to
   * explain why. Keeping the length caps but dropping the format rules is what
   * makes "this address is not needed" mean it.
   */
  const looseAddress = z.object({
    recipient: z.string().trim().max(60, t(MSG.nameLong)).optional().nullable(),
    phone: z.string().trim().max(30, t(MSG.tooLong)).optional().nullable(),
    postalCode: z.string().trim().max(10, t(MSG.tooLong)).optional().nullable(),
    city: z.string().trim().max(40, t(MSG.tooLong)).optional().nullable(),
    district: z.string().trim().max(40, t(MSG.tooLong)).optional().nullable(),
    street: z.string().trim().max(200, t(MSG.tooLong)).optional().nullable(),
  });

  return z.object({
    customerName: z.string().trim().min(1, t(MSG.name)).max(60, t(MSG.nameLong)),
    customerEmail: z
      .string()
      .trim()
      .min(1, t(MSG.email))
      .email(t(MSG.emailFormat))
      .max(120, t(MSG.tooLong)),
    customerPhone: z.string().trim().regex(TW_MOBILE, t(MSG.phone)),
    shippingMethod: z.enum(["home", "cvs", "pickup", "none"]),
    // Whether an address is required is a fact about the cart, and the cart is
    // not in this object. The form passes requireAddress; the server re-derives
    // the same answer from products.requires_shipping and enforces it itself,
    // so a request that skips the browser cannot skip the address.
    address: (requireAddress ? strictAddress : looseAddress).optional().nullable(),
    note: z.string().trim().max(500, t(MSG.noteLong)).optional().nullable(),
    /**
     * 逐位參加者，攤平成一個陣列（每一筆自己帶 lineKey）而不是
     * `Record<lineKey, Participant[]>`。
     *
     * 理由是 react-hook-form：巢狀 record 的欄位名稱裡會出現 uuid 與冒號，
     * `name="participants.<uuid>:<uuid>.0.name"` 這種路徑 RHF 解析不了（它把
     * `.` 當成層級分隔）。攤平之後每個欄位就是 `participants.3.name`，錯誤訊息
     * 也印得回正確的輸入框。
     *
     * `.optional()` 是同 invoice 的向後相容：一個全是書的購物車沒有這個欄位。
     */
    participants: z.array(participantSchema(t)).max(200).optional(),
    /**
     * 發票開法。`.optional()` 是刻意的向後相容：這個欄位是在金流之後才加的，一個
     * 還在跑舊 bundle 的分頁送上來的 payload 沒有它，那種請求應該照舊建立訂單並開
     * 一張 B2C 個人發票，而不是整筆結帳失敗。伺服器端用 normalizeInvoiceChoice()
     * 補上預設值。
     */
    invoice: invoiceSchema(t).optional().nullable(),
  });
}

/**
 * The schema the /checkout form actually binds to: checkoutFormSchema plus the
 * cross-field rule that每一行 booking 要幾位就必須有幾位.
 *
 * 分成兩支而不是一支的理由很實際：superRefine 會把 ZodObject 變成 ZodEffects，
 * 而 ZodEffects 沒有 `.extend()` —— 下面的 checkoutPayloadSchema 需要 extend。
 * 所以「可以被 extend 的那一份」與「表單用的那一份」分開，而不是讓伺服器端的
 * payload schema 遷就表單。
 *
 * ⚠️ 這一條規則只是**體驗**：少一位在畫面上長得像「那一格沒填」，多一位則是
 *    payload 被改過，兩者都應該讓客人當場看到，而不是送到伺服器才換回一句籠統的
 *    「訂單建立失敗」。真正的保證在 reserve_session_seat() 的第 ① 步，它與寫入在
 *    同一個交易裡（supabase/migrations/0020 §2），而且伺服器端根本不看這個陣列 ——
 *    它從 items[].quantity 自己推導該有幾位。
 */
export function checkoutFormSchemaWithParticipants(args: {
  t: Translate;
  requireAddress: boolean;
  participantSlots: { lineKey: string; count: number }[];
}) {
  const { t, participantSlots } = args;
  return checkoutFormSchema(args).superRefine((value, ctx) => {
    if (participantSlots.length === 0) return;
    const got = new Map<string, number>();
    for (const p of value.participants ?? []) {
      got.set(p.lineKey, (got.get(p.lineKey) ?? 0) + 1);
    }
    for (const slot of participantSlots) {
      if ((got.get(slot.lineKey) ?? 0) !== slot.count) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["participants"],
          message: t(MSG.participantName),
        });
        return;
      }
    }
  });
}

/**
 * Written out rather than inferred: checkoutFormSchema returns one of two
 * shapes, and react-hook-form needs a single stable value type to bind the
 * inputs to. This is the looser of the two, which is the one every field can
 * satisfy.
 */
export type CheckoutFormValues = {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingMethod: ShippingMethod;
  address?: {
    recipient?: string | null;
    phone?: string | null;
    postalCode?: string | null;
    city?: string | null;
    district?: string | null;
    street?: string | null;
  } | null;
  note?: string | null;
  /** 逐位參加者，攤平成一個陣列。空陣列＝這個購物車裡沒有活動。 */
  participants?: {
    lineKey: string;
    name: string;
    email?: string | null;
    phone?: string | null;
    noticeAck: boolean;
  }[];
  /**
   * Optional for the same reason `address` is loose: this is the *input* shape
   * react-hook-form binds to, and it has to be at least as permissive as the
   * schema's input or the resolver will not type-check. The form always mounts
   * it with `type: "personal"`; the server fills the gap for anyone who does not
   * send it (see normalizeInvoiceChoice).
   */
  invoice?: {
    type?: InvoiceType;
    taxId?: string | null;
    companyTitle?: string | null;
    carrierType?: string | null;
    carrierNumber?: string | null;
    loveCode?: string | null;
  } | null;
};

/**
 * One cart line as the browser is permitted to describe it: what, which sitting,
 * how many, and who is coming.
 *
 * ⚠️ `sessionId` is the first field the browser has ever been able to send that
 * points at a *different row* than `productId` does, and that opened a new way
 * to lie: "charge me for product A, seat me in product B's session". Nothing in
 * this schema can catch that — the two ids are individually well-formed — so it
 * is caught in the database, inside the same transaction that takes the seat
 * (reserve_session_seat() step ③, supabase/migrations/0020 §2). Do not move that
 * check up here and delete it down there.
 *
 * `participants` still carries no money field, same as the rest of this payload:
 * a name, an email, a phone and a consent flag. zod strips unknown keys, so a
 * `price` bolted onto a participant never reaches the repo.
 */
export const checkoutItemSchema = z.object({
  productId: z.string().trim().min(1).max(200),
  /**
   * 買了幾個「單位」。沒有選方案（或這場沒有方案）時，一個單位就是一個座位——
   * 與 0020 之後的行為逐字相同。選了方案時，一個單位可能佔用場次的多個座位
   * （見 `event_session_plans.seats_per_unit`，0036），實際佔用的座位數由伺服器
   * 用 planId 查出來的 seats_per_unit 換算，不是這個數字本身。
   */
  quantity: z.number().int().min(1).max(99),
  /** uuid of public.event_sessions. Required for event/journey, null otherwise. */
  sessionId: z.string().uuid().nullable().optional(),
  /**
   * uuid of public.event_session_plans（0036）。選填——沒有方案的場次不帶這個
   * 欄位，行為與 0020 之後逐字相同。
   *
   * ⚠️ 這裡跟這個檔案的其他每一個欄位一樣：**只有 id，沒有價格**。方案的單價、
   * 名稱、每單位佔幾位，全部由伺服器用這個 id 向 public.event_session_plans
   * 重新查出來（src/server/repos/orders.ts 的 priceLines()）。一個被改過的
   * planId 頂多讓伺服器查到「不屬於這個場次的方案」而整筆拒絕（與
   * SESSION_PRODUCT_MISMATCH 同一類防禦），絕不可能讓客人自己決定要付多少錢。
   */
  planId: z.string().uuid().nullable().optional(),
  participants: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        email: z.string().trim().max(120).nullable().optional(),
        phone: z.string().trim().max(30).nullable().optional(),
        noticeAck: z.boolean().optional(),
      }),
    )
    .max(99)
    .optional(),
});

/**
 * The full server-function input.
 *
 * Note what is absent: no price, no subtotal, no total, no shipping fee, no
 * product name, no stock figure. There is no field here a shopper could edit to
 * change what they are charged, because none of those numbers make the trip —
 * they are all read out of the database on the server side.
 *
 * ⚠️ The invoice block added by `checkoutFormSchema` does not change that, and
 * it is worth being explicit because a tax document is the one place a money
 * field would look like it belongs. It carries a type, a business number, a
 * carrier and a donation code — and nothing else. zod strips unknown keys, so a
 * payload that bolts `total` onto `invoice` (or onto the root) loses it during
 * parsing and never reaches src/server/repos/orders.ts, which prices the cart
 * from public.products regardless. scripts/invoice-selftest.mjs asserts this.
 */
export const checkoutPayloadSchema = checkoutFormSchema({
  t: (m) => m.zh,
  requireAddress: false,
  // 伺服器端用的是 items[].participants，不是表單那一份攤平的 participants ——
  // 「這一行要幾位」的答案在伺服器上是從 items[].quantity 推導的，不是從瀏覽器
  // 送來的 slot 清單。所以這裡用的是不帶那條 superRefine 的版本。
}).extend({
  items: z.array(checkoutItemSchema).min(1).max(50),
  locale: z.enum(["zh", "en", "ja"]),
  /** Per-attempt UUID; orders.idempotency_key is unique, so a double-submit replays. */
  idempotencyKey: z.string().uuid(),
  /**
   * Where to send the shopper next — NOT what to charge them.
   *
   * This is the one field added to this schema since the gateway landed, and
   * it was worth restating the rule for: there is still no price, subtotal,
   * total, shipping fee or discount here. The server prices the cart from
   * public.products and then asks PayUni for exactly that number, so a payload
   * edited in transit can change the destination of the redirect and nothing
   * about the amount. Defaults to `offline` so an old client that does not
   * send it behaves exactly as it did before.
   */
  paymentMethod: z.enum(PAYMENT_METHODS).default("offline"),
  /**
   * 0048：選銀行匯款時的「我需要專人聯繫協助付款」勾選框。預設 false（不勾）。
   * 只在 paymentMethod = 'transfer' 時有意義；伺服器對其他付款方式一律寫 false
   * （見 resolveOrderPaymentChoice()）。同樣**不影響金額**。
   */
  needsContact: z.boolean().default(false),
  /**
   * 推薦碼（0040）。**只是一個碼，不是金額** —— 折扣%由伺服器用這個碼向
   * public.referrers 查出來、折扣金額由 computeReferralDiscount() 算，與上面每一個
   * 金額同一個立場。
   *
   * undefined（舊版前台沒送）→ 伺服器退回 ib_ref cookie；空字串 → 客人清掉了，不用碼。
   * 見 src/lib/referral.ts resolveReferralCode()。
   */
  referralCode: z.string().trim().max(40).optional(),
});

export type CheckoutPayload = z.infer<typeof checkoutPayloadSchema>;

/** What the confirmation page is allowed to know. No PII, and never the token. */
export type OrderConfirmation = {
  orderNo: string;
  status: string;
  paymentStatus: string;
  /** NULL when nothing was sent to a gateway — see PAYMENT_METHODS. */
  paymentMethod: string | null;
  /**
   * True while this order is still waiting on a gateway result.
   *
   * The confirmation page uses this for two things, both of which used to be
   * wrong: whether to keep polling, and — critically — whether it is safe to
   * empty the cart. Clearing an unpaid order's cart is how Realreal stranded
   * shoppers whose payment failed in front of an empty cart with nothing to
   * retry. Derived on the server from the order's own columns; never from a
   * URL parameter the gateway might have set.
   *
   * ⚠️ 匯款訂單（payment_method = 'transfer'）**不算**在等付款結果：沒有任何金流
   *    欠我們一個答案，等的是客人自己去銀行。把它算進來會有三個後果，每一個都是
   *    錯的 —— 完成頁會印「還在等金流回覆」、會空轉輪詢兩分鐘、而且會長出一顆
   *    「重新付款」按鈕把匯款訂單推去刷卡。見 getOrderByToken()。
   */
  awaitingPayment: boolean;
  /**
   * 匯款資訊。只有 payment_method = 'transfer' 的訂單才不是 null（0034）。
   *
   * ⚠️ 帳戶資料從 site_settings 讀，而那四欄對 anon **沒有** SELECT 權限
   *    （0034 §0.4）—— 所以它是由 server function 用 service_role 讀出來、
   *    夾在這一包裡送給瀏覽器的，不是瀏覽器自己去查表。
   */
  remittance: {
    account: RemittanceAccount;
    /** ISO；下單 + REMITTANCE_DUE_DAYS 天。 */
    dueAt: string | null;
    /** 客人回報過的帳號末五碼。null ＝ 還沒回報。 */
    last5: string | null;
    reportedAt: string | null;
    /** 0048：客人勾了「我需要專人聯繫協助付款」。完成頁在匯款資訊旁加一句「我們會盡快與你聯繫」。 */
    needsContact: boolean;
  } | null;
  subtotal: number;
  shippingFee: number;
  discount: number;
  total: number;
  /** 這張訂單用的推薦碼（0040）。只有碼，不含推廣者是誰。 */
  referralCode: string | null;
  shippingMethod: ShippingMethod;
  createdAt: string;
  items: {
    name: Localized;
    unitPrice: number;
    quantity: number;
    subtotal: number;
    productType: ProductTypeForOrder;
  }[];
};
