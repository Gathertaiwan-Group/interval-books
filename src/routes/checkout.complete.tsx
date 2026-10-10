/**
 * /checkout/complete?token=… — the order exists; here is its number.
 *
 * WHY THE TOKEN AND NOT THE ORDER NUMBER
 * --------------------------------------
 * orders.order_no is IB-YYYY00000001, IB-YYYY00000002, … — quotable on the
 * phone, and for exactly that reason trivially enumerable. Keying this page on
 * it would let anyone walk the sequence and read what every customer spent.
 * orders.public_token is 24 random bytes and exists in 0005_commerce_orders.sql
 * for precisely this purpose ("Unguessable order lookup key for guests").
 *
 * What comes back is still deliberately thin — order number, amounts, lines. No
 * name, no email, no phone, no address, and the token is never echoed. A URL
 * ends up in browser history and over the shoulder of the person next to you;
 * it should not be a key to somebody's home address.
 *
 * WHY THE PAYMENT STATE IS RE-READ AND NOT TAKEN FROM THE URL
 * ----------------------------------------------------------
 * This is also PayUni's ReturnURL — the page the shopper lands on after paying
 * — so the gateway appends its own parameters on the way back. None of them are
 * read here. "Paid" is whatever the database says when this page asks it, which
 * is the only version of the answer that a shopper cannot edit in the address
 * bar. The gateway's real report arrives out of band at the webhook
 * (src/server/payuni-webhook.ts); this page just waits for it to land.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Clock, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { PageShell, PageHeader } from "@/components/PageShell";
import { PRODUCT_TYPE_LABELS } from "@/components/shop/labels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLang, useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { useCart } from "@/lib/cart";
import { checkoutErrorText, REMITTANCE_LAST5_RE, type OrderConfirmation } from "@/lib/checkout";
import { fetchOrderConfirmation, reportRemittance, retryPayment } from "@/lib/checkout-fns";
import { shouldClearCartAfterOrder } from "@/lib/direct-checkout";
import { submitPaymentForm } from "@/lib/payment-redirect";
import { formatPrice } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import { formatTaipeiDateTime } from "@/lib/taipei-time";

const PAGE = {
  metaTitle: {
    zh: "訂單完成｜小時光書店 Interval Books",
    en: "Order complete｜Interval Books",
    ja: "ご注文完了｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "你的小時光書店訂單已經成立，這裡是訂單編號與明細。",
    en: "Your Interval Books order has been created. Here is the order number and what is in it.",
    ja: "小時光書店のご注文が成立しました。ご注文番号と内容はこちらです。",
  },
  eyebrowSuffix: { zh: "訂單完成", en: "Order complete", ja: "ご注文完了" },
  title: { zh: "訂單已成立", en: "Your order is in", ja: "ご注文を承りました" },
  intro: {
    zh: "謝謝你。我們會盡快與你聯繫付款與寄送方式，訂單編號請先留著。",
    en: "Thank you. We will be in touch shortly about payment and delivery — please keep the order number.",
    ja: "ありがとうございます。お支払いとお届けについて追ってご連絡いたします。ご注文番号はお控えください。",
  },
  orderNo: { zh: "訂單編號", en: "Order number", ja: "ご注文番号" },
  summary: { zh: "訂單明細", en: "Order summary", ja: "ご注文内容" },
  subtotal: { zh: "小計", en: "Subtotal", ja: "小計" },
  shipping: { zh: "運費", en: "Shipping", ja: "送料" },
  free: { zh: "免運費", en: "Free", ja: "送料無料" },
  total: { zh: "應付總額", en: "Total", ja: "合計" },
  paymentPending: {
    zh: "這筆訂單尚未付款。線上付款開放前，我們會直接與你聯繫付款方式。",
    en: "This order has not been paid yet. Until online payment opens, we will arrange it with you directly.",
    ja: "このご注文はまだお支払いいただいておりません。オンライン決済の開始まで、個別にご案内いたします。",
  },
  titlePaid: { zh: "付款完成", en: "Payment complete", ja: "お支払い完了" },
  titleWaiting: { zh: "等待付款結果", en: "Waiting for payment", ja: "お支払いの確認中" },
  paid: {
    zh: "已收到你的付款，謝謝。我們會盡快為你備貨並通知寄送進度。",
    en: "We have received your payment — thank you. We will prepare your order and let you know when it ships.",
    ja: "お支払いを確認いたしました。ありがとうございます。準備が整い次第、発送のご連絡をいたします。",
  },
  waiting: {
    zh: "還在等金流回覆付款結果，這通常只需要幾秒。這一頁會自動更新，購物車會先幫你保留著。",
    en: "We are still waiting for the payment result — this usually takes a few seconds. This page updates itself, and your cart is kept in the meantime.",
    ja: "決済結果の確認中です。通常は数秒で完了します。このページは自動で更新され、その間カートは保持されます。",
  },
  failed: {
    zh: "這次付款沒有完成。訂單與購物車都還在，你可以直接重新付款。",
    en: "That payment did not go through. Your order and your cart are both still here — you can try paying again.",
    ja: "お支払いが完了しませんでした。ご注文もカートもそのままですので、再度お支払いいただけます。",
  },
  retry: { zh: "重新付款", en: "Try paying again", ja: "もう一度支払う" },
  retrying: { zh: "前往付款頁…", en: "Opening the payment page…", ja: "決済ページへ移動中…" },
  backToCart: { zh: "回到購物車", en: "Back to cart", ja: "カートへ戻る" },
  notFound: {
    zh: "找不到這筆訂單。連結可能不完整，或訂單並未成立。",
    en: "We could not find that order. The link may be incomplete, or the order was never created.",
    ja: "ご注文が見つかりませんでした。リンクが不完全か、ご注文が成立していない可能性があります。",
  },

  // ---- 匯款（0034）---------------------------------------------------------
  titleTransfer: {
    zh: "訂單已成立，請完成匯款",
    en: "Please complete your transfer",
    ja: "お振込のお願い",
  },
  transferCopy: {
    zh: "訂單已經成立，品項與名額已為你保留。請於下列期限前匯款到這個帳戶，匯款後回到這一頁填寫帳號末五碼，我們核對後會再以電子信箱通知你。這些資訊也已經寄到你的信箱。",
    en: "Your order is placed and the items and places are held for you. Please transfer to the account below by the due date, then come back to this page and tell us the last five digits of your account. We will email you once it is reconciled. A copy of these details is already in your inbox.",
    ja: "ご注文が成立し、商品・お席をお取り置きしております。下記の期日までにお振込のうえ、このページに戻って口座番号の下 5 桁をご入力ください。確認後にメールでご連絡いたします。この内容はメールでもお送りしています。",
  },
  transferAccount: { zh: "匯款帳戶", en: "Bank account", ja: "お振込先" },
  bankAccountName: { zh: "戶名", en: "Account name", ja: "口座名義" },
  bankName: { zh: "銀行", en: "Bank", ja: "銀行" },
  bankCode: { zh: "銀行代號", en: "Bank code", ja: "銀行コード" },
  bankAccount: { zh: "帳號", en: "Account number", ja: "口座番号" },
  transferAmount: { zh: "應匯金額", en: "Amount to transfer", ja: "お振込金額" },
  transferDue: { zh: "匯款期限", en: "Transfer by", ja: "お振込期限" },
  transferDueNote: {
    zh: "逾期未匯款的訂單會自動取消，品項與名額會釋出。",
    en: "Orders that are not paid by then are cancelled automatically, and the items and places are released.",
    ja: "期限までにご入金がない場合、ご注文は自動的にキャンセルとなり、商品・お席は解放されます。",
  },
  last5Section: {
    zh: "回報匯款帳號末五碼",
    en: "Tell us your last five digits",
    ja: "下 5 桁のご入力",
  },
  last5Label: { zh: "匯款帳號末五碼", en: "Last five digits", ja: "口座番号の下 5 桁" },
  last5Hint: {
    zh: "請填 5 位數字，我們用它比對銀行的入帳紀錄。只能填寫一次，送出前請確認。",
    en: "Five digits, which we use to match your payment against our bank records. It can only be submitted once, so please check it first.",
    ja: "5 桁の数字をご入力ください。入金記録の照合に使用します。ご入力は一度のみですのでご確認ください。",
  },
  last5Submit: { zh: "送出末五碼", en: "Submit", ja: "送信する" },
  last5Submitting: { zh: "送出中…", en: "Submitting…", ja: "送信中…" },
  last5Done: { zh: "已回報末五碼", en: "Last five digits received", ja: "下 5 桁を受け付けました" },
  last5DoneNote: {
    zh: "謝謝，我們核對入帳後會以電子信箱通知你。",
    en: "Thank you — we will email you once we have matched the payment.",
    ja: "ありがとうございます。入金確認後、メールでご連絡いたします。",
  },
  last5BadFormat: {
    zh: "請填 5 位數字。",
    en: "Please enter five digits.",
    ja: "5 桁の数字をご入力ください。",
  },
  last5Already: {
    zh: "這筆訂單已經回報過末五碼了。若填錯了，請直接與我們聯繫。",
    en: "The last five digits have already been submitted for this order. If they were wrong, please contact us.",
    ja: "このご注文はすでに下 5 桁をご入力済みです。誤りがある場合はご連絡ください。",
  },
  last5Failed: {
    zh: "沒能送出，請稍後再試，或直接與我們聯繫。",
    en: "That did not go through. Please try again shortly, or contact us.",
    ja: "送信できませんでした。しばらくしてから再度お試しいただくか、ご連絡ください。",
  },
};

/**
 * 匯款期限的顯示字串：台北時間「2026/10/09 23:59」，三種語言都一樣。
 * - 時區固定 Asia/Taipei —— 這是一間台北的書店，而 Vercel 的機器是 UTC：不指定時區的話，
 *   「9/5 23:59 截止」會在頁面上變成「9/5 15:59」，客人會以為自己少了 8 小時。
 * - 不能直接用 Intl.DateTimeFormat(語系).format()：這頁是 SSR，Node 與瀏覽器的 ICU 印出來的
 *   空白字元不同（zh-TW 日期後面一個是 U+2009、一個是一般空白），React 對不上就整頁重畫（#418）。
 *   所以走 src/lib/taipei-time.ts，只拿數字自己拼。
 * 信裡（email-templates.ts 的 formatDateTime）用各語系的格式，時間點相同；信不經過 hydration。
 */
function formatDueDate(iso: string): string {
  return formatTaipeiDateTime(iso);
}

export const Route = createFileRoute("/checkout/complete")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ deps }) => {
    // Matches the server function's own minimum, so an obviously-truncated
    // link renders "not found" instead of a validation error.
    if (deps.token.length < 16) return { order: null };
    return { order: await fetchOrderConfirmation({ data: { token: deps.token } }) };
  },
  head: () => ({
    meta: [
      { title: PAGE.metaTitle.zh },
      { name: "description", content: PAGE.metaDescription.zh },
      { property: "og:title", content: PAGE.title.zh },
      { property: "og:description", content: PAGE.metaDescription.zh },
      // Per-order and behind a secret; must never be indexed or followed.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: CheckoutComplete,
});

/** How long to keep asking the server whether the gateway has reported in. */
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 30; // ≈2 minutes, then stop and let the shopper reload

function CheckoutComplete() {
  const t = useT();
  const { lang } = useLang();
  const { token } = Route.useSearch();
  const { order: initialOrder } = Route.useLoaderData();
  const { ui } = useSiteContent();
  const clear = useCart((s) => s.clear);
  const cleared = useRef(false);

  const [order, setOrder] = useState<OrderConfirmation | null>(initialOrder);
  const [retrying, setRetrying] = useState(false);

  useDocumentMeta({
    title: PAGE.metaTitle,
    description: PAGE.metaDescription,
    ogTitle: PAGE.title,
  });

  /**
   * Empty the cart only once the order no longer owes anybody money — and only
   * when the cart is what the order came from.
   *
   * THIS CONDITION IS THE WHOLE POINT — do not simplify it back to `if (order)`.
   * Arriving here does not mean the shopper paid: with a gateway in the flow
   * there is now a middle state ("order created, payment not settled") that did
   * not exist before, and it is reached by anyone who closes PayUni's page or
   * has a card declined. Clearing the cart in that state is what sent Realreal's
   * shoppers to an empty cart with an unpaid order and no way to retry.
   *
   * `awaitingPayment` is computed on the server from the order's own columns
   * (see getOrderByToken) — never from a URL parameter the gateway controls —
   * and is false both for a settled card order and for an offline order, which
   * has no payment step to wait for.
   *
   * 🔴 第二個條件是直接結帳（活動頁 →「我要報名」）帶來的：`clear()` 清的是**整個**
   *    購物車，不分辨這張單是哪裡來的。一筆從活動頁直接下的訂單從來沒有經過購物車，
   *    所以那一下清掉的會是別人的東西 —— 客人放在裡面的兩本書。判斷本身是
   *    src/lib/direct-checkout.ts 的 shouldClearCartAfterOrder()：抽成純函式是因為
   *    這條規則的兩個錯法（清了不該清的、該清的沒清）都是靜默的，只能靠真的跑一次
   *    來證明，見 scripts/direct-checkout-selftest.mjs。
   */
  useEffect(() => {
    if (cleared.current) return;
    if (!shouldClearCartAfterOrder(order, token)) return;
    cleared.current = true;
    clear();
  }, [order, token, clear]);

  /**
   * While the gateway still owes us an answer, ask the server again.
   *
   * The shopper is usually back here before PayUni's server-to-server
   * notification has been processed, so the first read almost always says
   * "pending". Polling turns that into a page that resolves itself instead of
   * one that needs a manual refresh. Bounded on purpose: an order that is still
   * unsettled after two minutes needs a human, not more requests.
   */
  useEffect(() => {
    if (!token || !order) return;
    if (!order.awaitingPayment || order.paymentStatus !== "pending") return;

    let attempts = 0;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      attempts += 1;
      if (attempts > POLL_MAX_ATTEMPTS) {
        clearInterval(timer);
        return;
      }
      void fetchOrderConfirmation({ data: { token } })
        .then((fresh) => {
          if (!stopped && fresh) setOrder(fresh);
        })
        .catch(() => {
          /* transient; the next tick tries again */
        });
    }, POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [token, order]);

  /**
   * 末五碼回報（0034）。
   *
   * `reportedLast5` 的來源有兩個，順序不可以顛倒：伺服器回來的那一份是權威
   * （重新整理、換裝置都看得到），本地的 state 只是「這一次剛送出成功」的即時回饋
   * ——不等下一次 fetch 就把畫面切成「已回報」。兩者都沒有就是還沒回報。
   */
  const [last5, setLast5] = useState("");
  const [reporting, setReporting] = useState(false);
  const [justReported, setJustReported] = useState<string | null>(null);
  const reportedLast5 = order?.remittance?.last5 ?? justReported;

  const onReportLast5 = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!token) return;
      const value = last5.trim();
      // 送出前先擋一次格式。三層裡的第一層（另外兩層是 server function 的 zod 與
      // 0034 的 CHECK）——它的作用是讓客人立刻看到問題，不是安全邊界。
      if (!REMITTANCE_LAST5_RE.test(value)) {
        toast.error(t(PAGE.last5BadFormat));
        return;
      }
      setReporting(true);
      try {
        const result = await reportRemittance({ data: { token, last5: value } });
        if (result.ok) {
          setJustReported(result.last5);
          return;
        }
        toast.error(
          result.reason === "bad_format"
            ? t(PAGE.last5BadFormat)
            : result.reason === "already_reported"
              ? t(PAGE.last5Already)
              : t(PAGE.last5Failed),
        );
      } catch {
        toast.error(t(PAGE.last5Failed));
      } finally {
        setReporting(false);
      }
    },
    [token, last5, t],
  );

  /** Re-issues the PayUni form for an order whose payment did not complete. */
  const onRetry = useCallback(async () => {
    if (!token) return;
    setRetrying(true);
    try {
      const result = await retryPayment({ data: { token } });
      if (!result.ok) {
        toast.error(checkoutErrorText(result.code, lang));
        setRetrying(false);
        return;
      }
      // Navigating away — leave `retrying` true so the button cannot be
      // pressed twice while the browser is on its way to PayUni.
      submitPaymentForm(result.payment);
    } catch (err) {
      toast.error(checkoutErrorText(err, lang));
      setRetrying(false);
    }
  }, [token, lang]);

  if (!order) {
    return (
      <PageShell>
        <PageHeader eyebrow={`Order  ／  ${t(PAGE.eyebrowSuffix)}`} title={t(PAGE.title)} />
        <section className="container-editorial pb-32">
          <div className="border border-border p-10">
            <p className="text-sm text-muted-foreground">{t(PAGE.notFound)}</p>
            <Link
              to="/shop"
              className="mt-8 inline-block border border-foreground px-5 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
            >
              {t(ui.buttons.continueShopping)}
            </Link>
          </div>
        </section>
      </PageShell>
    );
  }

  // Four shapes of the same page, chosen from the server's answer only.
  const isPaid = order.paymentStatus === "paid";
  const isFailed = order.awaitingPayment && order.paymentStatus === "failed";
  const isWaiting = order.awaitingPayment && order.paymentStatus === "pending";
  /**
   * 匯款訂單，而且還沒收到款（0034）。
   *
   * ⚠️ `order.remittance` 是 server 端組的：只有 payment_method = 'transfer'
   *    **而且**店家真的設定好帳戶時才不是 null（見 getOrderByToken）。所以這裡不必
   *    （也不可以）自己再判斷一次 payment_method —— 「有沒有匯款資訊可以顯示」的
   *    判準只有伺服器那一份。
   *
   * 已經收到款的匯款訂單走 isPaid 那一條（跟刷卡訂單一樣），不再顯示帳號 ——
   * 錢已經進來了，再印一次帳號只會讓人以為要再匯一次。
   */
  const transfer = !isPaid && order.remittance ? order.remittance : null;

  const StatusIcon = isPaid
    ? Check
    : isFailed
      ? TriangleAlert
      : isWaiting || transfer
        ? Clock
        : Check;
  const heading = isPaid
    ? PAGE.titlePaid
    : transfer
      ? PAGE.titleTransfer
      : isWaiting
        ? PAGE.titleWaiting
        : isFailed
          ? PAGE.titleWaiting
          : PAGE.title;
  const statusCopy = isPaid
    ? PAGE.paid
    : isFailed
      ? PAGE.failed
      : transfer
        ? PAGE.transferCopy
        : isWaiting
          ? PAGE.waiting
          : PAGE.paymentPending;

  return (
    <PageShell>
      <PageHeader
        eyebrow={`Order  ／  ${t(PAGE.eyebrowSuffix)}`}
        title={t(heading)}
        intro={t(PAGE.intro)}
      />

      <section className="container-editorial pb-32 max-w-2xl">
        <div className="flex items-center gap-4 border border-foreground p-6">
          <StatusIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="eyebrow text-xl">{t(PAGE.orderNo)}</p>
            <p className="mt-1 font-serif text-2xl tabular-nums break-all">{order.orderNo}</p>
          </div>
        </div>

        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">{t(statusCopy)}</p>

        {order.awaitingPayment && (
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Button type="button" onClick={onRetry} disabled={retrying}>
              {retrying ? t(PAGE.retrying) : t(PAGE.retry)}
            </Button>
            <Link to="/cart" className="text-xs tracking-widest underline underline-offset-4">
              {t(PAGE.backToCart)}
            </Link>
          </div>
        )}

        {/* ---- 匯款帳戶與末五碼回報（0034）------------------------------- */}
        {transfer && (
          <div className="mt-10 border border-foreground p-7 md:p-8">
            <p className="eyebrow text-xl">{t(PAGE.transferAccount)}</p>

            <dl className="mt-6 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t(PAGE.bankAccountName)}</dt>
                <dd className="text-right font-medium">{transfer.account.accountName}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t(PAGE.bankName)}</dt>
                <dd className="text-right font-medium">{transfer.account.bankName}</dd>
              </div>
              {transfer.account.bankCode !== "" && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t(PAGE.bankCode)}</dt>
                  <dd className="text-right font-medium tabular-nums">
                    {transfer.account.bankCode}
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t(PAGE.bankAccount)}</dt>
                {/* break-all：帳號很長，手機上不可以撐破版面而讓人看不到後幾碼。 */}
                <dd className="text-right font-serif text-lg tabular-nums break-all">
                  {transfer.account.bankAccount}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t(PAGE.transferAmount)}</dt>
                <dd className="text-right font-serif text-lg tabular-nums">
                  {formatPrice(order.total)}
                </dd>
              </div>
              {/*
                期限算不出來就整列不印。印一列「匯款期限：Invalid Date」比不印那一列
                糟得多 —— 客人會照著它去判斷什麼時候該匯款。
              */}
              {transfer.dueAt && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t(PAGE.transferDue)}</dt>
                  <dd className="text-right tabular-nums">{formatDueDate(transfer.dueAt)}</dd>
                </div>
              )}
            </dl>

            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              {t(PAGE.transferDueNote)}
            </p>

            <div className="rule my-6" />

            {reportedLast5 !== null ? (
              // 已回報：顯示填過的號碼，**不提供修改**。這個欄位是店家對帳時要相信的
              // 證詞，能改就等於沒有證詞（伺服器那一側也擋著，見 reportRemittance）。
              <div>
                <p className="eyebrow text-xl">{t(PAGE.last5Done)}</p>
                <p className="mt-2 font-serif text-2xl tabular-nums">{reportedLast5}</p>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  {t(PAGE.last5DoneNote)}
                </p>
              </div>
            ) : (
              <form onSubmit={onReportLast5} className="space-y-3">
                <label className="eyebrow block text-xl" htmlFor="remittance-last5">
                  {t(PAGE.last5Section)}
                </label>
                <p className="text-xs leading-relaxed text-muted-foreground">{t(PAGE.last5Hint)}</p>
                <div className="flex flex-wrap items-start gap-3">
                  <Input
                    id="remittance-last5"
                    name="last5"
                    value={last5}
                    onChange={(e) => setLast5(e.target.value.replace(/\D/g, "").slice(0, 5))}
                    // inputMode/pattern：手機上直接跳數字鍵盤。maxLength 與上面那一行
                    // 的 replace 是兩層——貼上與輸入法走的路徑不一樣。
                    inputMode="numeric"
                    pattern="[0-9]{5}"
                    maxLength={5}
                    autoComplete="off"
                    aria-label={t(PAGE.last5Label)}
                    className="w-32 font-serif text-lg tabular-nums"
                  />
                  <Button type="submit" disabled={reporting || !REMITTANCE_LAST5_RE.test(last5)}>
                    {reporting ? t(PAGE.last5Submitting) : t(PAGE.last5Submit)}
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}

        <div className="mt-12 border border-border p-7 md:p-8">
          <p className="eyebrow text-xl">{t(PAGE.summary)}</p>

          <ul className="mt-6 space-y-4 border-b border-border pb-6">
            {order.items.map((item, i) => (
              <li key={i} className="flex justify-between gap-4 text-sm">
                <span className="min-w-0">
                  <span className="eyebrow block text-lg">
                    {t(PRODUCT_TYPE_LABELS[item.productType])}
                  </span>
                  <span className="block">{t(item.name)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatPrice(item.unitPrice)} × {item.quantity}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">{formatPrice(item.subtotal)}</span>
              </li>
            ))}
          </ul>

          <dl className="mt-6 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t(PAGE.subtotal)}</dt>
              <dd className="tabular-nums">{formatPrice(order.subtotal)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t(PAGE.shipping)}</dt>
              <dd className="tabular-nums">
                {order.shippingFee === 0 ? t(PAGE.free) : formatPrice(order.shippingFee)}
              </dd>
            </div>
          </dl>

          <div className="rule my-6" />

          <div className="flex items-baseline justify-between gap-4">
            <span className="eyebrow text-xl">{t(PAGE.total)}</span>
            <span className="font-serif text-2xl tabular-nums">{formatPrice(order.total)}</span>
          </div>
        </div>

        <Link
          to="/shop"
          className="mt-10 inline-block border border-foreground px-5 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
        >
          {t(ui.buttons.continueShopping)}
        </Link>
      </section>
    </PageShell>
  );
}
