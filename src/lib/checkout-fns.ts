/**
 * Server functions for the storefront checkout.
 *
 * WHY THESE DO NOT CHAIN adminFnMiddleware
 * ----------------------------------------
 * Every other server function in this app does (see src/lib/admin/fns/*.ts),
 * and src/lib/admin/middleware.ts calls itself THE security boundary. These two
 * are the deliberate exception: a guest has to be able to buy a book without an
 * account, so there is no session to check.
 *
 * Dropping the middleware moves the entire burden onto this file and
 * src/server/repos/orders.ts, so the rules that replace it are worth stating
 * outright:
 *
 *   1. The input is validated by a schema that has no field for money.
 *      checkoutPayloadSchema accepts a product id and a quantity per line and
 *      nothing else — no unit price, no subtotal, no total, no shipping fee,
 *      no product status. There is no value a caller can send that changes what
 *      they are charged, because those numbers are re-read from public.products
 *      on the server. Anyone may POST here; the worst they can do is create an
 *      order for themselves at the real price.
 *
 *   2. Nothing is read back that was not asked for by key. The confirmation
 *      read takes orders.public_token — 24 random bytes — and never accepts an
 *      order number, which is sequential and therefore guessable. It returns no
 *      name, email, phone or address, so even a leaked token exposes amounts
 *      rather than a person.
 *
 *   3. Expected failures are RETURNED, not thrown. A thrown error crosses the
 *      server-function boundary as whatever the framework decides to serialize,
 *      which in production can flatten a precise "not enough stock" into an
 *      opaque 500 and, in the other direction, can carry internal text to the
 *      browser. A discriminated result keeps both from happening.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  checkoutPayloadSchema,
  type CheckoutErrorCode,
  type OrderConfirmation,
  type PaymentHandoff,
} from "@/lib/checkout";

export type PlaceOrderResult =
  | {
      ok: true;
      orderNo: string;
      publicToken: string;
      total: number;
      /**
       * Present only when this order is going to PayUni. The browser must POST
       * it as a form — see PaymentHandoff. `null` means the order stands and
       * payment is arranged off-site, which is what happened before the gateway
       * existed and what still happens when it is unconfigured.
       */
      payment: PaymentHandoff | null;
    }
  | { ok: false; code: CheckoutErrorCode };

/**
 * Whether the card option may be shown.
 *
 * A boolean, deliberately — the browser is told *that* online payment works,
 * never anything about the credentials that make it work. Read at request time
 * rather than baked into the bundle so that adding the gateway keys to Vercel
 * turns card payment on with a redeploy of nothing.
 *
 * 兩個金流任一個設定完成就顯示刷卡。實務上是黑貓 PAY（統一客樂得 COCS）——
 * 這家店的商店帳號就是它，PayUni 只是它的收單銀行。PayUni 直連那條路留著但沒有
 * 憑證，所以 payuniConfigured() 會是 false。
 *
 * ⚠️ 兩個都沒設定時回 false，結帳頁就**不顯示刷卡選項**（退回「不經金流、由店家
 *    另行安排付款」）。那是刻意的降級：缺憑證的部署要長成「沒有這個選項」，
 *    而不是「選了之後結帳失敗」。
 */
export const fetchPaymentOptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ cardAvailable: boolean; transferAvailable: boolean }> => {
    try {
      const [{ blackcatConfigured }, { payuniConfigured }, { getRemittanceAccount }, checkout] =
        await Promise.all([
          import("@/server/blackcat"),
          import("@/server/payuni"),
          import("@/server/repos/site-settings"),
          import("@/lib/checkout"),
        ]);
      // 0034：匯款選項的開關是「店家設好帳戶了沒有」，與金流憑證無關（兩者可以同時
      // 開、也可以同時關）。⚠️ 這裡只回一個布林 —— 帳號本身**不進**結帳頁的 loader。
      // 它對 anon 沒有 SELECT 權限（0034 §0.4），而結帳頁是公開頁面：把帳號放進它的
      // loader 等於把公司帳號寫進每一個訪客都拿得到的 SSR payload，換來的好處是零
      // （客人在完成頁與信裡才需要看到帳號，那時候他已經有 public_token 了）。
      const account = await getRemittanceAccount();
      return {
        cardAvailable: blackcatConfigured() || payuniConfigured(),
        transferAvailable: checkout.remittanceConfigured(account),
      };
    } catch (err) {
      console.error("[checkout] fetchPaymentOptions failed", err);
      return { cardAvailable: false, transferAvailable: false };
    }
  },
);

export const placeOrder = createServerFn({ method: "POST" })
  .inputValidator(checkoutPayloadSchema)
  .handler(async ({ data }): Promise<PlaceOrderResult> => {
    // Imported inside the handler so the service-role client never appears in
    // the client module graph — the same pattern as the admin functions.
    const { createOrder } = await import("@/server/repos/orders");
    const { CheckoutError } = await import("@/lib/checkout");
    try {
      // 0040：ib_ref cookie 只在 payload 沒帶 referralCode（舊前台）時才用，見
      // resolveReferralCode()。讀 cookie 失敗不影響下單。
      let cookieReferralCode: string | null = null;
      try {
        const { getCookie } = await import("@tanstack/react-start/server");
        const { REFERRAL_COOKIE } = await import("@/lib/referral");
        cookieReferralCode = getCookie(REFERRAL_COOKIE) ?? null;
      } catch {
        cookieReferralCode = null;
      }
      const order = await createOrder(data, { cookieReferralCode });
      return { ok: true, ...order };
    } catch (err) {
      if (err instanceof CheckoutError) return { ok: false, code: err.code };
      console.error("[checkout] placeOrder failed", err);
      return { ok: false, code: "order_failed" };
    }
  });

/**
 * Reads one order back for the confirmation page.
 *
 * Returns null rather than an error for an unknown token: "this token is not an
 * order" and "this token is an order you may not see" must be indistinguishable,
 * or the endpoint becomes an oracle for probing tokens.
 */
export const fetchOrderConfirmation = createServerFn({ method: "GET" })
  .inputValidator(z.object({ token: z.string().trim().min(16).max(200) }))
  .handler(async ({ data }): Promise<OrderConfirmation | null> => {
    const { getOrderByToken } = await import("@/server/repos/orders");
    try {
      return await getOrderByToken(data.token);
    } catch (err) {
      console.error("[checkout] fetchOrderConfirmation failed", err);
      return null;
    }
  });

export type RetryPaymentResult =
  | { ok: true; payment: PaymentHandoff }
  | { ok: false; code: CheckoutErrorCode };

/**
 * Hands the shopper a fresh gateway hand-off for an order they created but never
 * paid for — the "card declined, try again" path.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Without it, a failed payment is a dead end: the order holds the stock, the
 * shopper has no way to pay, and the only recovery is to build a second order
 * for the same goods. Realreal shipped exactly that, compounded it by emptying
 * the cart at submit time, and left people staring at an empty cart with an
 * unpaid order they could not retry. This route and the cart-clearing rule in
 * /checkout/complete are two halves of the same fix — do not remove one and
 * keep the other.
 *
 * Keyed on public_token, never on order number: this returns a live payment
 * form, so it must not be reachable by guessing IB-2026000000NN. The repo
 * refuses any order that is not still `pending` and unpaid, so a paid or
 * cancelled order cannot be handed a payment form no matter what is sent here.
 */
export const retryPayment = createServerFn({ method: "POST" })
  .inputValidator(z.object({ token: z.string().trim().min(16).max(200) }))
  .handler(async ({ data }): Promise<RetryPaymentResult> => {
    const { reissuePayment } = await import("@/server/repos/orders");
    try {
      const payment = await reissuePayment(data.token);
      // One code for both "no such order" and "this order may not be paid":
      // distinguishing them would turn this into an oracle for probing tokens.
      if (!payment) return { ok: false, code: "payment_already_settled" };
      return { ok: true, payment };
    } catch (err) {
      console.error("[checkout] retryPayment failed", err);
      return { ok: false, code: "payment_unavailable" };
    }
  });

export type ReportRemittanceResult =
  | { ok: true; last5: string; reportedAt: string }
  | { ok: false; reason: "not_found" | "not_transfer" | "already_reported" | "bad_format" };

/**
 * 客人回報匯款帳號末五碼（0034）。
 *
 * 授權模型與 retryPayment 逐字相同：認 orders.public_token，不認訂單編號。理由也
 * 一樣 —— 訂單編號是流水號（IB-2026000000NN），拿它當鑰匙等於讓任何人沿著號碼走
 * 一遍，把每一張待收款的單都標上一組假的末五碼，讓店家的對帳畫面全部失效。
 *
 * ⚠️ 與 retryPayment 不同的是，這裡的失敗原因**有分辨**（already_reported /
 *    bad_format …）。那不違反 retryPayment 上面那條「不要變成探針」的規則：那條
 *    規則守的是「別讓人用亂猜的 token 問出一張訂單存不存在」，而這裡對一個不存在
 *    的 token 一律回 not_found，對一個存在但不能回報的訂單一律回 not_transfer。
 *    分辨得出來的兩種（已回報過、格式錯）都需要 token 本來就對得上，那時候呼叫者
 *    已經是訂單的持有人了，告訴他「你已經填過 12345」是他該看到的東西。
 *
 * 「只能填一次」不是靠這裡擋的 —— 它是 reportRemittance() 那一句 UPDATE 的 WHERE
 * 條件（見那支函式）。這一層只負責把明顯不合格式的請求擋在資料庫外面。
 */
export const reportRemittance = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      token: z.string().trim().min(16).max(200),
      // 與 src/lib/checkout.ts 的 REMITTANCE_LAST5_RE 和 0034 的 CHECK 是同一條規則。
      last5: z
        .string()
        .trim()
        .regex(/^[0-9]{5}$/),
    }),
  )
  .handler(async ({ data }): Promise<ReportRemittanceResult> => {
    const { reportRemittance: report } = await import("@/server/repos/orders");
    try {
      return await report(data.token, data.last5);
    } catch (err) {
      console.error("[checkout] reportRemittance failed", err);
      return { ok: false, reason: "not_found" };
    }
  });

export type ReferralPreviewResult =
  | { ok: true; code: string; discountPercent: number }
  | { ok: false; reason: "invalid" };

/**
 * 結帳頁的推薦碼即時檢查（0040）。
 *
 * 公開的 server fn（客人不用登入），所以只回「這個碼有效嗎、打幾折」：
 * **不回推廣者的姓名、聯絡方式或 id**。格式錯、不存在、已停用一律回同一個
 * `invalid`，不分辨。分享出去的碼本來就是公開的，所以這裡不怕被列舉出「碼」，
 * 只怕被列舉出「人」。
 *
 * 這裡算出來的折扣只是給畫面看；真正的折扣在 createOrder() 裡重算一次。
 */
export const previewReferralCode = createServerFn({ method: "POST" })
  .inputValidator(z.object({ code: z.string().trim().max(40) }))
  .handler(async ({ data }): Promise<ReferralPreviewResult> => {
    try {
      const { normalizeReferralCode, isValidReferralCode } = await import("@/lib/referral");
      const code = normalizeReferralCode(data.code);
      if (!isValidReferralCode(code)) return { ok: false, reason: "invalid" };
      const { findReferrerForCheckout } = await import("@/server/repos/referrals");
      const found = await findReferrerForCheckout(code);
      if (!found) return { ok: false, reason: "invalid" };
      return { ok: true, code: found.code, discountPercent: found.discountPercent };
    } catch (err) {
      console.error("[checkout] previewReferralCode failed", err);
      return { ok: false, reason: "invalid" };
    }
  });
