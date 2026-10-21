/**
 * /checkout — collect who this is going to, create the order, hand off to PayUni.
 *
 * The totals rendered here are advisory. Every number is recomputed on the
 * server from public.products before anything is written, so what this panel
 * shows and what the order says can only differ if the catalogue changed
 * mid-checkout — in which case the server's answer is the correct one. The same
 * goes for the amount PayUni is asked for: it is the server's `total`, never
 * the one on screen.
 *
 * WHAT HAPPENS ON SUBMIT
 * ----------------------
 * placeOrder() returns either a `payment` form or null.
 *   * form → build it in the DOM and submit it. PayUni's integrated payment
 *     page only exists as the result of a browser POST; there is no URL to
 *     redirect to (see src/lib/payment-redirect.ts).
 *   * null → the pre-gateway behaviour: the order stands and we contact the
 *     shopper about payment. This is what an unconfigured PAYUNI_* environment
 *     falls back to, so a missing key degrades to "order held", never to
 *     "checkout broken".
 *
 * The cart is NOT cleared here and NOT cleared on arrival at the confirmation
 * page — only once payment is actually settled. See checkout.complete.tsx.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { PageShell, PageHeader } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useLang, useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { keyOfLine, useCart, useCartHydrated, type CartLine } from "@/lib/cart";
import {
  amountToFreeShipping,
  checkoutErrorText,
  checkoutFormSchemaWithParticipants,
  computeShippingFee,
  SHIPPING_RULES,
  type CheckoutFormValues,
  type OfferedShippingMethod,
  type PaymentMethodChoice,
} from "@/lib/checkout";
import { fetchPaymentOptions, placeOrder, previewReferralCode } from "@/lib/checkout-fns";
import {
  computeReferralDiscount,
  hasReferralEligibleLine,
  normalizeReferralCode,
  readReferralCookie,
} from "@/lib/referral";
import {
  parseDirectCheckoutSearch,
  rememberCartKept,
  resolveDirectCheckout,
  type DirectCheckoutSearch,
  type DirectFailureReason,
} from "@/lib/direct-checkout";
import { ParticipantFields } from "@/components/shop/ParticipantFields";
import { submitPaymentForm } from "@/lib/payment-redirect";
import { fetchActiveProducts, formatPrice } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import type { Localized } from "@/i18n/types";

const PAGE = {
  metaTitle: {
    zh: "結帳 Checkout｜小時光書店 Interval Books",
    en: "Checkout｜Interval Books",
    ja: "ご購入手続き｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "填寫收件資料，完成小時光書店的訂單。付款方式將於下一階段開放。",
    en: "Enter your delivery details to complete your Interval Books order. Payment opens in the next phase.",
    ja: "お届け先をご入力いただき、小時光書店のご注文を確定します。お支払いは次の段階で開放されます。",
  },
  eyebrowSuffix: { zh: "結帳", en: "Checkout", ja: "ご購入手続き" },
  title: { zh: "留下收件資料", en: "Where should this go", ja: "お届け先のご入力" },
  intro: {
    zh: "確認品項與金額後填寫收件資料。送出後訂單就會成立，我們會與你聯繫付款方式。",
    en: "Check the items and the total, then tell us where to send them. Your order is created on submit and we will follow up about payment.",
    ja: "商品と金額をご確認のうえ、お届け先をご入力ください。送信後にご注文が成立し、お支払い方法についてご連絡いたします。",
  },
  empty: {
    zh: "購物車是空的，還沒有可以結帳的品項。",
    en: "Your cart is empty — there is nothing to check out yet.",
    ja: "カートが空のため、お手続きに進めません。",
  },
  contactSection: { zh: "聯絡資料", en: "Your details", ja: "ご連絡先" },
  participantsSection: { zh: "參加者資料", en: "Who is coming", ja: "参加者情報" },
  participantsIntro: {
    zh: "活動報名需要每一位參加者的姓名與聯絡方式，現場才點得到名。",
    en: "Bookings need a name and a way to reach each attendee, so we can check everyone in on the day.",
    ja: "当日の受付のため、参加者お一人ずつのお名前とご連絡先をご入力ください。",
  },
  shippingSection: { zh: "寄送方式", en: "Delivery", ja: "お届け方法" },
  addressSection: { zh: "收件地址", en: "Delivery address", ja: "お届け先住所" },
  noteSection: { zh: "備註", en: "Notes", ja: "備考" },
  name: { zh: "姓名", en: "Name", ja: "お名前" },
  email: { zh: "電子信箱", en: "Email", ja: "メールアドレス" },
  phone: { zh: "手機號碼", en: "Mobile number", ja: "携帯番号" },
  recipient: { zh: "收件人姓名", en: "Recipient", ja: "お届け先のお名前" },
  recipientPhone: { zh: "收件人電話", en: "Recipient phone", ja: "お届け先電話番号" },
  postalCode: { zh: "郵遞區號（選填）", en: "Postal code (optional)", ja: "郵便番号（任意）" },
  city: { zh: "縣市", en: "City", ja: "市・県" },
  district: { zh: "鄉鎮市區（選填）", en: "District (optional)", ja: "区・町（任意）" },
  street: { zh: "詳細地址", en: "Street address", ja: "番地・建物名" },
  note: {
    zh: "想讓我們知道的事（選填）",
    en: "Anything we should know (optional)",
    ja: "ご要望など（任意）",
  },
  methodHome: { zh: "宅配到府", en: "Home delivery", ja: "自宅へお届け" },
  methodPickup: { zh: "到店自取", en: "Pick up in store", ja: "店頭でお受け取り" },
  methodFree: { zh: "免運費", en: "Free", ja: "送料無料" },
  noShippingNeeded: {
    zh: "這筆訂單只有活動與策旅名額，不需要寄送，也不收運費。",
    en: "This order is bookings only — nothing to post, and no shipping to pay.",
    ja: "このご注文はお申し込みのみのため、配送も送料もございません。",
  },
  pickupNote: {
    zh: "到店自取免運費。我們會在備妥後與你聯繫取件時間。",
    en: "Store pickup is free. We will be in touch once your order is ready to collect.",
    ja: "店頭でのお受け取りは送料無料です。ご用意ができ次第ご連絡いたします。",
  },
  freeShippingGap: { zh: "再買", en: "Spend", ja: "あと" },
  freeShippingGapTail: { zh: "即可免運", en: "more for free shipping", ja: "で送料無料" },
  summary: { zh: "訂單明細", en: "Order summary", ja: "ご注文内容" },
  // 0036：訂單明細裡，一個購買單位佔多個座位的方案（雙人房這類）額外標出座位數。
  seatsUnit: { zh: "位", en: "seats", ja: "名" },
  subtotal: { zh: "小計", en: "Subtotal", ja: "小計" },
  shipping: { zh: "運費", en: "Shipping", ja: "送料" },
  total: { zh: "應付總額", en: "Total", ja: "合計" },
  // 0040 推薦碼
  referralSection: { zh: "推薦碼", en: "Referral code", ja: "紹介コード" },
  referralLabel: { zh: "推薦碼（選填）", en: "Referral code (optional)", ja: "紹介コード（任意）" },
  referralHint: {
    zh: "有推薦碼可享選品與書籍折扣；活動、策旅票券不適用。",
    en: "A referral code gives a discount on books and goods; event and journey tickets are not included.",
    ja: "紹介コードで書籍・雑貨が割引になります。イベント・旅のチケットは対象外です。",
  },
  referralApply: { zh: "套用", en: "Apply", ja: "適用" },
  referralChecking: { zh: "確認中…", en: "Checking…", ja: "確認中…" },
  referralOk: {
    zh: "已套用推薦碼，選品享",
    en: "Referral code applied:",
    ja: "紹介コードを適用しました：",
  },
  referralOkTail: { zh: "% 折扣", en: "% off books and goods", ja: "% 割引（書籍・雑貨）" },
  referralInvalid: {
    zh: "這個推薦碼無效或已停用。請確認後重新輸入，或清空這一欄。",
    en: "This referral code is not valid. Please check it, or clear the field.",
    ja: "この紹介コードは無効です。ご確認いただくか、空欄にしてください。",
  },
  referralDiscount: { zh: "推薦折扣", en: "Referral discount", ja: "紹介割引" },
  submit: { zh: "送出訂單", en: "Place order", ja: "注文を確定する" },
  submitPay: { zh: "前往付款", en: "Continue to payment", ja: "お支払いへ進む" },
  submitting: { zh: "訂單建立中…", en: "Creating your order…", ja: "ご注文を作成中…" },
  redirecting: {
    zh: "正在前往付款頁，請不要關閉或重新整理…",
    en: "Taking you to the payment page — please do not close or refresh…",
    ja: "決済ページへ移動しています。閉じたり更新したりしないでください…",
  },
  paymentSection: { zh: "付款方式", en: "Payment", ja: "お支払い方法" },
  payCard: { zh: "信用卡線上付款", en: "Pay by card", ja: "クレジットカード決済" },
  payCardNote: {
    zh: "送出後會前往統一金流 PayUni 的付款頁完成刷卡。付款成功才會扣除購物車。",
    en: "You will be taken to PayUni's secure page to pay by card. Your cart is only emptied once payment succeeds.",
    ja: "送信後、PayUni の決済ページでお支払いいただきます。カートはお支払い完了後に空になります。",
  },
  payTransfer: { zh: "銀行匯款", en: "Bank transfer", ja: "銀行振込" },
  payTransferNote: {
    zh: "訂單成立後會顯示匯款帳號，也會用電子信箱寄給你一份。請在 3 天內完成匯款，並回到訂單頁填寫帳號末五碼；逾期未匯款的訂單會自動取消，品項與名額會釋出。",
    en: "The bank details appear once your order is placed, and we email you a copy. Please transfer within 3 days and come back to the order page to tell us the last five digits of your account — unpaid orders are cancelled automatically after that and the items and places are released.",
    ja: "ご注文確定後にお振込先を表示し、メールでもお送りします。3 日以内にお振込のうえ、ご注文ページで口座番号の下 5 桁をご入力ください。期限を過ぎたご注文は自動的にキャンセルとなり、商品・お席は解放されます。",
  },
  payOffline: {
    zh: "由我們與你聯繫付款",
    en: "Arrange payment with us",
    ja: "個別にお支払いをご案内",
  },
  payOfflineNote: {
    zh: "訂單會先成立並保留品項，我們會以電子信箱與你聯繫付款方式。",
    en: "Your order is created and the items are held; we will email you about payment.",
    ja: "ご注文を確定し商品をお取り置きしたうえで、お支払い方法をメールでご案内します。",
  },
  paymentUnavailable: {
    zh: "線上付款目前未開放，訂單成立後我們會直接與你聯繫付款方式。",
    en: "Online payment is not open yet — we will contact you about payment once the order is placed.",
    ja: "オンライン決済は現在ご利用いただけません。ご注文後にお支払い方法をご連絡いたします。",
  },
  invoiceSection: { zh: "電子發票", en: "Invoice", ja: "電子インボイス" },
  submitTransfer: { zh: "送出訂單並取得匯款帳號", en: "Place order", ja: "注文して振込先を表示" },
  invoiceIntro: {
    zh: "付款完成後會自動開立電子發票，並以電子信箱通知。統編與載具送出後就不能改，請先確認。",
    en: "An e-invoice is issued automatically once payment clears, and emailed to you. A business number or carrier cannot be changed after submitting, so please check it now.",
    ja: "お支払い完了後に電子インボイスを自動発行し、メールでお知らせします。統一番号・キャリアは送信後に変更できませんのでご確認ください。",
  },
  invoicePersonal: { zh: "個人（含載具）", en: "Personal", ja: "個人（キャリア対応）" },
  invoiceCompany: {
    zh: "公司（統一編號）",
    en: "Company (business number)",
    ja: "法人（統一番号）",
  },
  invoiceDonate: { zh: "捐贈發票", en: "Donate the invoice", ja: "インボイスを寄付" },
  invoicePersonalNote: {
    zh: "不指定載具時，發票會由我們保管並以電子信箱寄送通知。",
    en: "With no carrier chosen, we hold the invoice for you and send the details by email.",
    ja: "キャリアを指定しない場合、インボイスは当店で保管し、内容をメールでお送りします。",
  },
  invoiceCompanyNote: {
    zh: "開立統編發票後就不會再有載具，這張發票會直接寄到你的電子信箱。",
    en: "A business-number invoice carries no mobile carrier; we email it to you directly.",
    ja: "統一番号ありのインボイスにキャリアは付きません。メールで直接お送りします。",
  },
  invoiceDonateNote: {
    zh: "捐贈之後這張發票就不屬於你了，無法再兌獎或折讓退回。",
    en: "Once donated, the invoice is no longer yours — it cannot be redeemed or returned.",
    ja: "寄付後のインボイスはお客様のものではなくなり、換金や返却はできません。",
  },
  carrierLabel: { zh: "載具類型", en: "Carrier", ja: "キャリアの種類" },
  carrierNone: {
    zh: "不指定（寄送電子信箱）",
    en: "None — email it to me",
    ja: "指定しない（メール送付）",
  },
  carrierMobile: { zh: "手機條碼", en: "Mobile barcode", ja: "携帯バーコード" },
  carrierNpc: { zh: "自然人憑證", en: "Citizen digital certificate", ja: "自然人証明書" },
  carrierNumber: { zh: "載具號碼", en: "Carrier number", ja: "キャリア番号" },
  taxId: { zh: "統一編號", en: "Business number", ja: "統一番号" },
  companyTitle: { zh: "公司抬頭（選填）", en: "Company name (optional)", ja: "会社名（任意）" },
  loveCode: { zh: "愛心碼", en: "Donation code", ja: "愛心コード" },
  loveCodeNote: {
    zh: "常見的愛心碼例如 25885（家扶基金會）、8585（伊甸社會福利基金會）。",
    en: "Common codes include 25885 (TFCF) and 8585 (Eden Social Welfare Foundation).",
    ja: "よく使われるコード：25885（家扶基金会）、8585（伊甸社会福祉基金会）。",
  },
  unavailableWarning: {
    zh: "購物車中有無法購買的品項，請先回到購物車移除。",
    en: "Your cart holds something that can no longer be bought. Please remove it in the cart first.",
    ja: "カートにご購入いただけない商品があります。カートで削除してからお進みください。",
  },
  backToCart: { zh: "回到購物車", en: "Back to cart", ja: "カートへ戻る" },
  // ── 直接結帳（從活動頁帶著場次與人數進來）─────────────────────────────────
  // 這幾句是網址被改壞時看到的畫面。四種原因分開講，因為它們的下一步不一樣：
  // 「這一場滿了」值得去看別場，「連結失效」只能回列表重找。
  backToEvents: { zh: "回到活動", en: "Back to events", ja: "イベント一覧へ" },
  directProblemTitle: {
    zh: "這個報名連結用不了",
    en: "This registration link does not work",
    ja: "このお申し込みリンクはご利用いただけません",
  },
  directProductGone: {
    zh: "找不到這個品項。它可能已經下架，或連結被改過了。",
    en: "We cannot find that item. It may have been taken down, or the link was altered.",
    ja: "この商品が見つかりません。掲載が終了したか、リンクが変更された可能性があります。",
  },
  directSessionRequired: {
    zh: "這個連結沒有指定場次。請回到活動頁選一場再報名。",
    en: "This link does not say which sitting. Please go back to the event and choose one.",
    ja: "このリンクには開催回の指定がありません。イベントページで回をお選びください。",
  },
  directSessionGone: {
    zh: "找不到這個場次。它可能已經結束或被取消了。",
    en: "We cannot find that sitting. It may have finished or been cancelled.",
    ja: "この回が見つかりません。終了または中止となった可能性があります。",
  },
  // 0036：這一場開了方案時，連結必須指定方案（早鳥／一般…），跟
  // directSessionRequired 同一個理由——沒有指定會被 priceLines() 用同一句
  // product_unavailable 拒絕，這裡先攔下來給一句看得懂的話。
  directPlanRequired: {
    zh: "這個連結沒有指定方案。請回到活動頁選一個方案再報名。",
    en: "This link does not say which plan to book. Please go back to the event and choose one.",
    ja: "このリンクにはプランの指定がありません。イベントページでプランをお選びください。",
  },
  directSoldOut: {
    zh: "這一場的名額已經滿了。歡迎回到活動頁看看其他場次。",
    en: "That sitting is full. Have a look at the other sittings on the event page.",
    ja: "この回は満席です。イベントページで他の回もご覧ください。",
  },
  directClamped: {
    zh: "報名人數已調整為這一場目前還剩下的名額。",
    en: "The number of places has been adjusted to what is still left in this sitting.",
    ja: "お申し込み人数を、この回の残席数に合わせて調整しました。",
  },
  backToItem: { zh: "看這個品項", en: "View this item", ja: "商品ページを見る" },
  catalogueDown: {
    zh: "商品資料暫時無法載入，請稍後再試。",
    en: "The catalogue is temporarily unavailable. Please try again shortly.",
    ja: "商品情報を読み込めませんでした。しばらくしてからお試しください。",
  },
};

const NO_ITEMS: CartLine[] = [];

/**
 * 直接結帳失敗的四種原因，各自對應一句話。
 *
 * 寫成 switch 而不是查表，是為了讓 DirectFailureReason 之後多一種時 TypeScript 立刻
 * 在這裡叫回來 —— 一個「多了一種原因、但畫面上沒有那一句」的漏洞是靜默的（會掉進
 * default 印出別人的話），而這一頁在收錢。
 */
function directProblemText(reason: DirectFailureReason) {
  switch (reason) {
    case "product_gone":
      return PAGE.directProductGone;
    case "session_required":
      return PAGE.directSessionRequired;
    case "session_gone":
      return PAGE.directSessionGone;
    case "plan_required":
      return PAGE.directPlanRequired;
    case "sold_out":
      return PAGE.directSoldOut;
  }
}

/**
 * 付款方式 → 畫面上的字。⚠️ **鍵是 PaymentMethodChoice**，所以
 * src/lib/checkout.ts 的 PAYMENT_METHODS 多一個值而這裡忘了加字，是編譯錯誤，
 * 不是一顆沒有標籤的 radio。這正是 0034 加第三個選項時想要的行為。
 */
const PAYMENT_LABELS: Record<PaymentMethodChoice, Localized> = {
  card: PAGE.payCard,
  transfer: PAGE.payTransfer,
  offline: PAGE.payOffline,
};

const PAYMENT_NOTES: Record<PaymentMethodChoice, Localized> = {
  card: PAGE.payCardNote,
  transfer: PAGE.payTransferNote,
  offline: PAGE.payOfflineNote,
};

export const Route = createFileRoute("/checkout/")({
  /**
   * 品項的**第二個**來源：直接結帳（活動頁 →「我要報名」）。
   *
   * 三個參數都是選填，所以一個都不帶時這一頁與從前一模一樣 —— 走購物車。解析規則
   * （包括「網址參數什麼都不能相信」）全部在 src/lib/direct-checkout.ts，這裡只是把
   * TanStack 交來的 raw search 轉過去，不在路由檔裡放第二份解析。
   */
  validateSearch: (search: Record<string, unknown>): DirectCheckoutSearch =>
    parseDirectCheckoutSearch(search),
  // Same read as /cart: the catalogue decides prices, purchase limits and —
  // uniquely here — whether anything in the cart needs posting at all.
  // paymentOptions is a single boolean read at request time, so adding the
  // PayUni keys to the deployment turns the card option on without a rebuild.
  //
  // 直接結帳**不多讀一次資料庫**：fetchActiveProducts() 已經把場次一起掛上來了
  // （attachSessions），所以品項是從這同一份目錄組出來的 —— 畫面上的名額與夾數量用的
  // 名額不可能是兩個不同時間點的答案。
  loader: async () => ({
    catalogue: await fetchActiveProducts(),
    paymentOptions: await fetchPaymentOptions(),
  }),
  head: () => ({
    meta: [
      { title: PAGE.metaTitle.zh },
      { name: "description", content: PAGE.metaDescription.zh },
      { property: "og:title", content: PAGE.title.zh },
      { property: "og:description", content: PAGE.metaDescription.zh },
      // Carries a half-filled form and a live cart; never a search result.
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Checkout,
});

function Checkout() {
  const t = useT();
  const { lang } = useLang();
  const navigate = useNavigate();
  const { catalogue, paymentOptions } = Route.useLoaderData();
  const { ui } = useSiteContent();

  useDocumentMeta({
    title: PAGE.metaTitle,
    description: PAGE.metaDescription,
    ogTitle: PAGE.title,
  });

  const hydrated = useCartHydrated();
  const storedItems = useCart((s) => s.items);
  const syncFromCatalogue = useCart((s) => s.syncFromCatalogue);

  /**
   * 品項的來源有兩個，而且是互斥的。
   *
   * `direct === null` 就是原本的路徑：品項來自購物車，這一頁的行為與從前逐字相同。
   * 不是 null 時這一頁在服務一筆從活動頁直接帶進來的報名 —— 那時候**購物車完全不參與**：
   * 不讀它的內容、不 syncFromCatalogue（那會寫回 localStorage）、成立訂單之後也不清它。
   * 最後那一條見 onSubmit 裡的 rememberCartKept()。
   *
   * 依賴列刻意攤成四個原始值而不是整個 search 物件：search 的參照是否穩定是 router 的
   * 實作細節，而這個 memo 的下游（participantSlots → zod schema）每一次換參照都要重建。
   */
  const {
    product: directProduct,
    session: directSession,
    qty: directQty,
    plan: directPlan,
  } = Route.useSearch();
  const direct = useMemo(
    () =>
      resolveDirectCheckout(catalogue.products, {
        product: directProduct,
        session: directSession,
        qty: directQty,
        // 🔴 0036 漏掉的那一個。少了它，只要場次開了票種，resolveDirectCheckout()
        //    就會以 plan_required 拒絕——站內「我要報名」按鈕直接撞錯誤頁。之所以
        //    一直沒人踩到，是因為在此之前正式庫沒有任何場次開過方案。
        plan: directPlan,
      }),
    [catalogue.products, directProduct, directSession, directQty, directPlan],
  );
  const directMode = direct !== null;
  const directItems = useMemo<CartLine[]>(() => (direct?.ok ? [direct.line] : NO_ITEMS), [direct]);
  const items = directMode ? directItems : hydrated ? storedItems : NO_ITEMS;

  const [submitting, setSubmitting] = useState(false);
  const [method, setMethod] = useState<OfferedShippingMethod>("home");

  /**
   * 第一位參加者的「同購買人」開關。
   *
   * 🔴 刻意**不放進 react-hook-form**。表單值會被 `{...values}` 整包送進 placeOrder()，
   *    多一個欄位就是改了送出去的形狀 —— 而這個布林對伺服器毫無意義（它只是幫使用者
   *    填格子的一個畫面開關）。同理它也不進購物車：CartLine 會被 persist() 寫進
   *    localStorage，見 src/lib/cart.ts 與 ParticipantFields.tsx 的檔頭。
   *
   * 預設 false：預先勾好會讓「我勾的」與「系統幫我勾的」長得一樣，而下一步就是收錢。
   */
  const [sameAsBuyer, setSameAsBuyer] = useState(false);

  // Card when it is available, otherwise the pre-gateway flow. Held outside
  // react-hook-form because it is not a validated field — it steers where the
  // browser goes next and has no bearing on what the order costs.
  //
  // 🔴 0034：從兩個選項變成三個之後，「這個站現在提供哪幾種付款方式」必須算出來
  //    一次、然後同時當成**畫面上要畫哪幾顆 radio** 與**送出前的白名單**。原本
  //    那一行 fallback（`cardAvailable ? payWith : "offline"`，:591）在兩個選項的
  //    世界裡剛好是對的，多一個選項之後就不是了 —— 一個沒設定金流、但設定了匯款
  //    帳戶的站，客人選了「匯款」會被那一行改寫成 "offline"，訂單變成
  //    payment_method = NULL，匯款資訊信不寄、完成頁不顯示帳號，而客人以為他選了
  //    匯款。所以白名單的判準改成「這個方式在不在提供清單裡」，不是「card 有沒有
  //    開」。清單只有這一份，畫面與送出用的是同一個。
  const cardAvailable = paymentOptions.cardAvailable;
  const transferAvailable = paymentOptions.transferAvailable;
  const methodOptions = useMemo<PaymentMethodChoice[]>(
    () => [
      ...(cardAvailable ? (["card"] as const) : []),
      ...(transferAvailable ? (["transfer"] as const) : []),
      // offline 永遠在清單裡：它不需要任何設定，是這家店在金流出現之前就有的路。
      "offline" as const,
    ],
    [cardAvailable, transferAvailable],
  );
  const [payWith, setPayWith] = useState<PaymentMethodChoice>(methodOptions[0]);
  /**
   * Set once the PayUni form has been submitted; the page is navigating away.
   * Mirrored in a ref because the `finally` block runs in the same tick as the
   * setState and would otherwise still read the old value.
   */
  const [redirecting, setRedirecting] = useState(false);
  const redirectingRef = useRef(false);

  // One key per visit to this page. orders.idempotency_key is unique, so a
  // double-clicked submit (or a retried request) replays the first order
  // instead of reserving the stock a second time.
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : "00000000-0000-4000-8000-000000000000",
  );

  useEffect(() => {
    // 直接結帳不碰購物車：syncFromCatalogue 會寫回 store（也就是 localStorage），
    // 而這一筆訂單與購物車裡放著什麼無關。
    if (directMode) return;
    if (!hydrated || catalogue.unavailable) return;
    syncFromCatalogue(catalogue.products);
  }, [directMode, hydrated, catalogue, syncFromCatalogue]);

  const buyable = useMemo(() => items.filter((i) => !i.unavailable), [items]);
  const hasUnavailable = items.length > buyable.length;

  /**
   * Whether anything in the cart has to be posted. Read from the live
   * catalogue rather than the cart line, because CartLine is a snapshot taken
   * at add-to-cart time and carries no requires_shipping field — and because
   * this has to agree with what the server independently decides from the same
   * column. A product that has vanished from the catalogue is treated as
   * shippable, which errs towards collecting an address we might not need
   * rather than silently waiving freight.
   */
  const needsShipping = useMemo(() => {
    const byId = new Map(catalogue.products.map((p) => [p.id, p]));
    return buyable.some((line) => byId.get(line.productId)?.requiresShipping ?? true);
  }, [buyable, catalogue.products]);

  const subtotal = useMemo(() => buyable.reduce((sum, l) => sum + l.price * l.qty, 0), [buyable]);
  const effectiveMethod = needsShipping ? method : "none";
  const shippingFee = computeShippingFee({ needsShipping, method: effectiveMethod, subtotal });

  /**
   * 推薦碼（0040）。刻意**不放進 react-hook-form**（理由同 sameAsBuyer）：它在送出時
   * 明確加進 payload。預填 ib_ref cookie（?ref= 連結寫的）；客人清空就是不用。
   * 畫面上的折扣只是預覽 —— 伺服器用同一支 computeReferralDiscount() 重算。
   */
  const [referralInput, setReferralInput] = useState("");
  const [referral, setReferral] = useState<
    | { state: "idle" }
    | { state: "checking" }
    | { state: "ok"; code: string; percent: number }
    | { state: "invalid" }
  >({ state: "idle" });
  async function checkReferral(raw: string) {
    const code = normalizeReferralCode(raw);
    if (!code) {
      setReferral({ state: "idle" });
      return;
    }
    setReferral({ state: "checking" });
    try {
      const res = await previewReferralCode({ data: { code } });
      setReferral(
        res.ok
          ? { state: "ok", code: res.code, percent: res.discountPercent }
          : { state: "invalid" },
      );
    } catch {
      setReferral({ state: "invalid" });
    }
  }
  useEffect(() => {
    const fromCookie = readReferralCookie(typeof document === "undefined" ? "" : document.cookie);
    if (!fromCookie) return;
    setReferralInput(fromCookie);
    void checkReferral(fromCookie);
    // 只在進頁面時預填一次。
  }, []);
  /**
   * 只有票券（活動／策旅）時整個推薦碼欄位不顯示 —— 折不到任何東西。ib_ref cookie
   * 不動（下次買選品時照樣預填）。
   */
  const showReferral = hasReferralEligibleLine(buyable);
  const referralDiscount =
    referral.state === "ok" && normalizeReferralCode(referralInput) === referral.code
      ? computeReferralDiscount(
          buyable.map((l) => ({ productType: l.productType, subtotal: l.price * l.qty })),
          referral.percent,
        )
      : 0;
  const total = subtotal + shippingFee - referralDiscount;
  const freeGap = amountToFreeShipping({ needsShipping, method: effectiveMethod, subtotal });

  const requireAddress = needsShipping && method === "home";

  /**
   * 每一行 booking 展開成 qty 個位子，攤平成一個有順序的清單。
   *
   * 這個順序就是表單欄位 `participants.<index>` 的順序，也是送出時分組回
   * items[].participants 的依據 —— 兩邊都從這一個陣列推導，所以不可能對不上。
   *
   * 排序固定成購物車的順序（buyable 本身的順序），不要換成 Map 迭代或 sort：
   * 順序一變，已經填好的欄位就會跳到別位參加者身上。
   */
  const participantSlots = useMemo(
    () =>
      buyable
        .filter((l) => l.productType === "event" || l.productType === "journey")
        // 0036：一份要收的是座位數（qty × planSeatsPerUnit），不是 qty 本身——
        // 沒有方案的行 planSeatsPerUnit 恆為 1，這裡對既有行為逐字相同。雙人房
        // 這類方案買 1 個單位，這裡要展開成 2 份參加者表單。
        .map((l) => ({ line: l, lineKey: keyOfLine(l), count: l.qty * l.planSeatsPerUnit })),
    [buyable],
  );
  const totalParticipants = useMemo(
    () => participantSlots.reduce((sum, s) => sum + s.count, 0),
    [participantSlots],
  );

  const schema = useMemo(
    () =>
      checkoutFormSchemaWithParticipants({
        t,
        requireAddress,
        participantSlots: participantSlots.map((s) => ({ lineKey: s.lineKey, count: s.count })),
      }),
    [t, requireAddress, participantSlots],
  );

  const form = useForm<CheckoutFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      customerName: "",
      customerEmail: "",
      customerPhone: "",
      shippingMethod: "home",
      address: {
        recipient: "",
        phone: "",
        postalCode: "",
        city: "",
        district: "",
        street: "",
      },
      note: "",
      // 參加者由下面的 useEffect 依購物車補齊。這裡給空陣列而不是 undefined，
      // 因為 react-hook-form 要有一個穩定的初始形狀才綁得住 participants.N.*。
      participants: [],
      // 預設個人、無載具 —— 這是絕大多數客人的情況，也是不做任何選擇時最不會出錯的
      // 一種（發票開得出來、寄得到信箱、之後還能補登載具）。
      invoice: {
        type: "personal",
        taxId: "",
        companyTitle: "",
        carrierType: "",
        carrierNumber: "",
        loveCode: "",
      },
    },
  });

  /**
   * 讓 participants 陣列的長度與購物車一致。
   *
   * 購物車在這一頁是會變的（syncFromCatalogue 會把賣完的行 clamp 成 0），所以
   * 欄位數不能只在 mount 時算一次。已經填好的值**逐格保留** —— 用同一個
   * (lineKey, offset) 去對舊值，所以「某一行少了一個位子」不會把後面每一位的
   * 資料往前推一格。
   *
   * 只有在真的不一樣時才 setValue，否則這個 effect 會自己觸發自己。
   */
  useEffect(() => {
    const current = form.getValues("participants") ?? [];
    const byKey = new Map<string, CheckoutFormValues["participants"]>();
    for (const p of current) {
      const list = byKey.get(p.lineKey) ?? [];
      list.push(p);
      byKey.set(p.lineKey, list);
    }
    const next: NonNullable<CheckoutFormValues["participants"]> = [];
    for (const slot of participantSlots) {
      const old = byKey.get(slot.lineKey) ?? [];
      for (let i = 0; i < slot.count; i++) {
        next.push(
          old[i] ?? { lineKey: slot.lineKey, name: "", email: "", phone: "", noticeAck: false },
        );
      }
    }
    const same =
      next.length === current.length &&
      next.every((p, i) => p === current[i] || p.lineKey === current[i]?.lineKey);
    if (!same) form.setValue("participants", next, { shouldValidate: false });
  }, [participantSlots, form]);

  /**
   * 切換發票類型時，把另外兩種的欄位清空。
   *
   * 不清空的話，一個先填了統編、又改選捐贈的客人，會把統編一起送上來。伺服器端的
   * normalizeInvoiceChoice() 本來就會丟掉不屬於該類型的欄位，所以那不會開錯發票 ——
   * 但那些值仍然會離開瀏覽器，而「使用者已經在畫面上取消的輸入不應該被送出」是一條
   * 值得自己遵守的規矩，尤其這裡是統一編號。
   */
  const invoiceType = form.watch("invoice.type") ?? "personal";
  function selectInvoiceType(next: "personal" | "company" | "donate") {
    form.setValue("invoice.type", next, { shouldValidate: false });
    if (next !== "company") {
      form.setValue("invoice.taxId", "");
      form.setValue("invoice.companyTitle", "");
    }
    if (next !== "personal") {
      form.setValue("invoice.carrierType", "");
      form.setValue("invoice.carrierNumber", "");
    }
    if (next !== "donate") form.setValue("invoice.loveCode", "");
    form.clearErrors("invoice");
  }

  async function onSubmit(values: CheckoutFormValues) {
    if (buyable.length === 0) return;
    if (hasUnavailable) {
      toast.error(t(PAGE.unavailableWarning));
      return;
    }
    // 欄位沒顯示（只有票券）時：客人看不到、也改不了這一欄，所以不可以拿它擋送出。
    // cookie 的碼確認有效就照送（歸屬與以前一樣），否則當作沒用推薦碼。
    const typedReferral = showReferral
      ? normalizeReferralCode(referralInput)
      : referral.state === "ok"
        ? referral.code
        : "";
    if (
      showReferral &&
      typedReferral &&
      !(referral.state === "ok" && referral.code === typedReferral)
    ) {
      // 還沒確認過（打完直接按送出）或確認失敗：不送出。先確認一次並把折扣顯示出來，
      // 讓客人看到折後總額再按一次 —— 不可以在他沒看過金額的情況下就送出。
      // 結果（有效／無效）顯示在推薦碼欄位底下。
      await checkReferral(typedReferral);
      document.getElementById("referral-code")?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const result = await placeOrder({
        data: {
          ...values,
          shippingMethod: effectiveMethod,
          // Only what, which sitting, how many, and who is coming. Prices,
          // names and totals are still the server's to decide — see
          // src/lib/checkout-fns.ts.
          //
          // 參加者從攤平的表單陣列依 lineKey 分組回每一行。分組的來源與
          // participantSlots 是同一個 keyOfLine()，所以不會有「填在 A 行、送到
          // B 行」的可能。伺服器仍然自己驗一次筆數，最後由
          // reserve_session_seat() 的第 ① 步在同一個交易裡拍板。
          items: buyable.map((l) => {
            const key = keyOfLine(l);
            const people = (values.participants ?? []).filter((p) => p.lineKey === key);
            return {
              productId: l.productId,
              // 0036：買了幾個「單位」，不是幾個座位——伺服器用 planId 查出
              // seats_per_unit 再自己換算座位數。沒有方案的行 quantity 仍然
              // 直接等於座位數，與 0020 之後的行為逐字相同。
              quantity: l.qty,
              sessionId: l.sessionId,
              planId: l.planId,
              participants:
                l.productType === "event" || l.productType === "journey"
                  ? people.map((p) => ({
                      name: p.name,
                      email: p.email ?? null,
                      phone: p.phone ?? null,
                      noticeAck: p.noticeAck === true,
                    }))
                  : undefined,
            };
          }),
          address: requireAddress ? values.address : null,
          locale: lang,
          idempotencyKey,
          // Steers the next hop only. The amount PayUni is asked for is
          // recomputed server-side from public.products; nothing in this
          // payload can change it.
          // 🔴 白名單是「這個方式現在有提供嗎」，不是「card 有沒有開」。見
          //    methodOptions 那一段的註解——舊的那一行會把一個選了匯款的客人
          //    靜靜改成 offline。
          paymentMethod: methodOptions.includes(payWith) ? payWith : "offline",
          // 0040：只送碼，不送折扣。空字串＝不用推薦碼（伺服器不會再退回 cookie）。
          referralCode: typedReferral,
        },
      });

      if (!result.ok) {
        toast.error(checkoutErrorText(result.code, lang));
        return;
      }

      /**
       * 🔴 直接結帳的訂單**不可以清購物車**。
       *
       * /checkout/complete 在付款結清之後呼叫的是 cart 的 clear()，而那支是清空整個
       * 購物車、不分辨訂單是哪裡來的。這一筆訂單從來沒有經過購物車，所以那一下清掉的
       * 會是別人的東西 —— 一個購物車裡放著兩本書的客人，從活動頁報名並付款成功，回來
       * 會發現那兩本書不見了。旗標記在這裡（建單當下、拿得到 token 的唯一時機），
       * 由 /checkout/complete 讀。理由與做法見 src/lib/direct-checkout.ts。
       */
      if (directMode) rememberCartKept(result.publicToken);

      // The cart is NOT cleared here, and not on arrival at the confirmation
      // page either — only once payment is settled. Clearing it now would send
      // anyone whose card is declined back to an empty cart with an unpaid
      // order they cannot retry, which is the exact bug Realreal shipped.
      if (result.payment) {
        // Navigating away: keep the button disabled and say what is happening,
        // because the browser will sit on this page for a beat before PayUni's
        // page paints. Deliberately no `finally` reset — see below.
        redirectingRef.current = true;
        setRedirecting(true);
        submitPaymentForm(result.payment);
        return;
      }

      await navigate({ to: "/checkout/complete", search: { token: result.publicToken } });
    } catch (err) {
      toast.error(checkoutErrorText(err, lang));
    } finally {
      // Leaves `submitting` true on the PayUni path on purpose: the form has
      // been submitted and the page is on its way out, so re-enabling the
      // button would only invite a second order.
      if (!redirectingRef.current) setSubmitting(false);
    }
  }

  /**
   * 直接結帳組不出品項的四種情況，各自有一句話與一條回得去的路。
   *
   * 放在購物車的空狀態**之前**：這時候購物車裡有沒有東西完全不相干，掉回「購物車是
   * 空的」會是一句與事實無關的話（而且那個「繼續選購」按鈕會把人帶去一個他沒在找的
   * 地方）。目錄整個讀不到時另外講，因為那時候「找不到這件商品」還不知道是不是真的。
   */
  if (directMode && !direct.ok) {
    return (
      <PageShell>
        <PageHeader
          eyebrow={`Checkout  ／  ${t(PAGE.eyebrowSuffix)}`}
          title={t(PAGE.directProblemTitle)}
        />
        <section className="container-editorial pb-32">
          <div className="border border-border p-10">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {catalogue.unavailable ? t(PAGE.catalogueDown) : t(directProblemText(direct.reason))}
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link
                to="/events"
                className="inline-block border border-foreground px-5 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
              >
                {t(PAGE.backToEvents)}
              </Link>
              <Link
                to="/shop"
                className="inline-block border border-border px-5 py-3 text-xs tracking-widest text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
              >
                {t(ui.buttons.continueShopping)}
              </Link>
            </div>
          </div>
        </section>
      </PageShell>
    );
  }

  if (!directMode && hydrated && buyable.length === 0) {
    return (
      <PageShell>
        <PageHeader eyebrow={`Checkout  ／  ${t(PAGE.eyebrowSuffix)}`} title={t(PAGE.title)} />
        <section className="container-editorial pb-32">
          <div className="border border-border p-10">
            <p className="text-sm text-muted-foreground">{t(PAGE.empty)}</p>
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

  return (
    <PageShell>
      <PageHeader
        eyebrow={`Checkout  ／  ${t(PAGE.eyebrowSuffix)}`}
        title={t(PAGE.title)}
        intro={t(PAGE.intro)}
      />

      <section className="container-editorial pb-32 grid gap-12 lg:grid-cols-3 lg:gap-16">
        <div className="lg:col-span-2">
          {catalogue.unavailable && (
            <p className="mb-8 border border-clay p-5 text-sm text-clay">{t(PAGE.catalogueDown)}</p>
          )}
          {hasUnavailable && (
            <p className="mb-8 border border-clay p-5 text-sm text-clay">
              {t(PAGE.unavailableWarning)}{" "}
              <Link to="/cart" className="underline underline-offset-4">
                {t(PAGE.backToCart)}
              </Link>
            </p>
          )}
          {/* 網址帶的人數被夾過（0、負數，或多過這一場剩下的名額）。夾了就要說 ——
              一個安靜變小的數字會在客人按下「前往付款」之後才被發現。 */}
          {direct?.ok && direct.clamped && (
            <p className="mb-8 border border-border p-5 text-sm text-muted-foreground">
              {t(PAGE.directClamped)}
            </p>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-12">
              <fieldset className="space-y-5">
                <legend className="eyebrow text-xl">{t(PAGE.contactSection)}</legend>
                <FormField
                  control={form.control}
                  name="customerName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t(PAGE.name)}</FormLabel>
                      <FormControl>
                        <Input autoComplete="name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="customerEmail"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t(PAGE.email)}</FormLabel>
                      <FormControl>
                        <Input type="email" inputMode="email" autoComplete="email" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="customerPhone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t(PAGE.phone)}</FormLabel>
                      <FormControl>
                        <Input
                          inputMode="tel"
                          autoComplete="tel"
                          placeholder="09xxxxxxxx"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </fieldset>

              {/* 參加者放在聯絡資料之後、寄送之前：填的順序與客人腦中的順序一致
                  （先是「我是誰」，再是「誰要來」，最後才是「寄到哪」）。
                  全是書的購物車不會渲染這一段，連標題都不會出現。 */}
              {participantSlots.length > 0 ? (
                <fieldset className="space-y-5">
                  <legend className="eyebrow text-xl">{t(PAGE.participantsSection)}</legend>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {t(PAGE.participantsIntro)}
                  </p>
                  {participantSlots.map((slot, idx) => (
                    <ParticipantFields
                      key={slot.lineKey}
                      lineTitle={slot.line.title}
                      sessionTitle={slot.line.sessionTitle}
                      startIndex={participantSlots
                        .slice(0, idx)
                        .reduce((sum, s) => sum + s.count, 0)}
                      count={slot.count}
                      // 「同購買人」只交給第一組（第一組的第一位就是全表單的第一位）。
                      // 其餘的 ParticipantFields 拿不到 handler，也就完全不渲染那個框。
                      sameAsBuyer={idx === 0 ? sameAsBuyer : undefined}
                      onSameAsBuyerChange={idx === 0 ? setSameAsBuyer : undefined}
                    />
                  ))}
                </fieldset>
              ) : null}

              {needsShipping ? (
                <>
                  <fieldset className="space-y-4">
                    <legend className="eyebrow text-xl">{t(PAGE.shippingSection)}</legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(["home", "pickup"] as const).map((m) => {
                        const rule = SHIPPING_RULES[m];
                        const selected = method === m;
                        return (
                          <label
                            key={m}
                            className={`flex cursor-pointer items-baseline justify-between gap-4 border p-4 transition-colors ${
                              selected
                                ? "border-foreground"
                                : "border-border hover:border-foreground/40"
                            }`}
                          >
                            <span className="flex items-baseline gap-3">
                              <input
                                type="radio"
                                name="shippingMethod"
                                value={m}
                                checked={selected}
                                onChange={() => setMethod(m)}
                                className="accent-current"
                              />
                              <span className="text-sm">
                                {m === "home" ? t(PAGE.methodHome) : t(PAGE.methodPickup)}
                              </span>
                            </span>
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {rule.fee === 0 ? t(PAGE.methodFree) : formatPrice(rule.fee)}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {method === "pickup" && (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t(PAGE.pickupNote)}
                      </p>
                    )}
                  </fieldset>

                  {requireAddress && (
                    <fieldset className="space-y-5">
                      <legend className="eyebrow text-xl">{t(PAGE.addressSection)}</legend>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <FormField
                          control={form.control}
                          name="address.recipient"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t(PAGE.recipient)}</FormLabel>
                              <FormControl>
                                <Input
                                  autoComplete="shipping name"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="address.phone"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t(PAGE.recipientPhone)}</FormLabel>
                              <FormControl>
                                <Input
                                  inputMode="tel"
                                  autoComplete="shipping tel"
                                  placeholder="09xxxxxxxx"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="address.postalCode"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t(PAGE.postalCode)}</FormLabel>
                              <FormControl>
                                <Input
                                  inputMode="numeric"
                                  autoComplete="shipping postal-code"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="address.city"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t(PAGE.city)}</FormLabel>
                              <FormControl>
                                <Input
                                  autoComplete="shipping address-level1"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="address.district"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t(PAGE.district)}</FormLabel>
                              <FormControl>
                                <Input
                                  autoComplete="shipping address-level2"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="address.street"
                          render={({ field }) => (
                            <FormItem className="sm:col-span-2">
                              <FormLabel>{t(PAGE.street)}</FormLabel>
                              <FormControl>
                                <Input
                                  autoComplete="shipping street-address"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </fieldset>
                  )}
                </>
              ) : (
                <p className="border border-border p-5 text-sm leading-relaxed text-muted-foreground">
                  {t(PAGE.noShippingNeeded)}
                </p>
              )}

              <fieldset className="space-y-4">
                <legend className="eyebrow text-xl">{t(PAGE.paymentSection)}</legend>
                {/*
                  只剩一個選項（＝金流與匯款都沒設定，只有 offline）時不畫 radio ——
                  一組只有一顆、而且不能不選的 radio 不是選擇，是雜訊。那個情況畫的
                  是既有的 paymentUnavailable 說明，與 0034 之前的行為完全相同。
                */}
                {methodOptions.length > 1 ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {methodOptions.map((p) => {
                      const selected = payWith === p;
                      return (
                        <label
                          key={p}
                          className={`flex cursor-pointer items-baseline gap-3 border p-4 transition-colors ${
                            selected
                              ? "border-foreground"
                              : "border-border hover:border-foreground/40"
                          }`}
                        >
                          <input
                            type="radio"
                            name="paymentMethod"
                            value={p}
                            checked={selected}
                            onChange={() => setPayWith(p)}
                            className="accent-current"
                          />
                          <span className="text-sm">{t(PAYMENT_LABELS[p])}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="border border-border p-5 text-sm leading-relaxed text-muted-foreground">
                    {t(PAGE.paymentUnavailable)}
                  </p>
                )}
                {methodOptions.length > 1 && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t(PAYMENT_NOTES[payWith])}
                  </p>
                )}
              </fieldset>

              {/*
                電子發票。三選一，預設個人。
                ⚠️ 這一整段不影響訂單金額：送出的欄位只有開法、統編、載具與愛心碼，
                金額由伺服器從 public.products 重算（見 src/lib/checkout.ts）。
              */}
              <fieldset className="space-y-4">
                <legend className="eyebrow text-xl">{t(PAGE.invoiceSection)}</legend>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t(PAGE.invoiceIntro)}
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(["personal", "company", "donate"] as const).map((kind) => {
                    const selected = invoiceType === kind;
                    return (
                      <label
                        key={kind}
                        className={`flex cursor-pointer items-baseline gap-3 border p-4 transition-colors ${
                          selected
                            ? "border-foreground"
                            : "border-border hover:border-foreground/40"
                        }`}
                      >
                        <input
                          type="radio"
                          name="invoiceType"
                          value={kind}
                          checked={selected}
                          onChange={() => selectInvoiceType(kind)}
                          className="accent-current"
                        />
                        <span className="text-sm">
                          {kind === "personal"
                            ? t(PAGE.invoicePersonal)
                            : kind === "company"
                              ? t(PAGE.invoiceCompany)
                              : t(PAGE.invoiceDonate)}
                        </span>
                      </label>
                    );
                  })}
                </div>

                {invoiceType === "personal" && (
                  <div className="grid gap-5 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="invoice.carrierType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t(PAGE.carrierLabel)}</FormLabel>
                          <FormControl>
                            <select
                              {...field}
                              value={field.value ?? ""}
                              onChange={(e) => {
                                field.onChange(e);
                                // 換載具類型時舊號碼一定不合新格式，留著只會讓客人看到
                                // 一則指著他沒改過的欄位的錯誤。
                                form.setValue("invoice.carrierNumber", "");
                                form.clearErrors("invoice.carrierNumber");
                              }}
                              className="h-9 w-full border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none md:text-sm"
                            >
                              <option value="">{t(PAGE.carrierNone)}</option>
                              <option value="3J0002">{t(PAGE.carrierMobile)}</option>
                              <option value="CQ0001">{t(PAGE.carrierNpc)}</option>
                            </select>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {(form.watch("invoice.carrierType") ?? "") !== "" && (
                      <FormField
                        control={form.control}
                        name="invoice.carrierNumber"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t(PAGE.carrierNumber)}</FormLabel>
                            <FormControl>
                              <Input
                                autoComplete="off"
                                placeholder={
                                  form.watch("invoice.carrierType") === "3J0002"
                                    ? "/ABC+123"
                                    : "AB12345678901234"
                                }
                                {...field}
                                value={field.value ?? ""}
                                onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                    <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
                      {t(PAGE.invoicePersonalNote)}
                    </p>
                  </div>
                )}

                {invoiceType === "company" && (
                  <div className="grid gap-5 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="invoice.taxId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t(PAGE.taxId)}</FormLabel>
                          <FormControl>
                            <Input
                              inputMode="numeric"
                              autoComplete="off"
                              maxLength={8}
                              placeholder="12345675"
                              {...field}
                              value={field.value ?? ""}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="invoice.companyTitle"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t(PAGE.companyTitle)}</FormLabel>
                          <FormControl>
                            <Input
                              autoComplete="organization"
                              {...field}
                              value={field.value ?? ""}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
                      {t(PAGE.invoiceCompanyNote)}
                    </p>
                  </div>
                )}

                {invoiceType === "donate" && (
                  <div className="grid gap-5 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="invoice.loveCode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t(PAGE.loveCode)}</FormLabel>
                          <FormControl>
                            <Input
                              inputMode="numeric"
                              autoComplete="off"
                              maxLength={7}
                              placeholder="25885"
                              {...field}
                              value={field.value ?? ""}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
                      {t(PAGE.loveCodeNote)} {t(PAGE.invoiceDonateNote)}
                    </p>
                  </div>
                )}
              </fieldset>

              {showReferral && (
                <fieldset className="space-y-3">
                  <legend className="eyebrow text-xl">{t(PAGE.referralSection)}</legend>
                  <label htmlFor="referral-code" className="block text-sm font-medium">
                    {t(PAGE.referralLabel)}
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="referral-code"
                      value={referralInput}
                      maxLength={20}
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      className="max-w-[14rem] uppercase"
                      aria-invalid={referral.state === "invalid"}
                      aria-describedby="referral-status"
                      onChange={(e) => {
                        setReferralInput(e.target.value);
                        if (referral.state !== "idle") setReferral({ state: "idle" });
                      }}
                      onBlur={() => void checkReferral(referralInput)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void checkReferral(referralInput);
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void checkReferral(referralInput)}
                      disabled={referral.state === "checking" || !referralInput.trim()}
                    >
                      {t(PAGE.referralApply)}
                    </Button>
                  </div>
                  <p id="referral-status" className="text-xs leading-relaxed" aria-live="polite">
                    {referral.state === "checking" ? (
                      <span className="text-muted-foreground">{t(PAGE.referralChecking)}</span>
                    ) : referral.state === "ok" ? (
                      <span className="text-emerald-700 dark:text-emerald-400">
                        {t(PAGE.referralOk)} {referral.percent}
                        {t(PAGE.referralOkTail)}
                      </span>
                    ) : referral.state === "invalid" ? (
                      <span className="text-destructive">{t(PAGE.referralInvalid)}</span>
                    ) : (
                      <span className="text-muted-foreground">{t(PAGE.referralHint)}</span>
                    )}
                  </p>
                </fieldset>
              )}

              <fieldset className="space-y-5">
                <legend className="eyebrow text-xl">{t(PAGE.noteSection)}</legend>
                <FormField
                  control={form.control}
                  name="note"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t(PAGE.note)}</FormLabel>
                      <FormControl>
                        <Textarea rows={4} maxLength={500} {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </fieldset>

              <div className="space-y-3">
                <Button
                  type="submit"
                  className="w-full sm:w-auto"
                  disabled={submitting || redirecting || hasUnavailable || buyable.length === 0}
                >
                  {redirecting
                    ? t(PAGE.redirecting)
                    : submitting
                      ? t(PAGE.submitting)
                      : payWith === "card"
                        ? t(PAGE.submitPay)
                        : payWith === "transfer"
                          ? t(PAGE.submitTransfer)
                          : t(PAGE.submit)}
                </Button>
                {redirecting && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t(PAGE.redirecting)}
                  </p>
                )}
              </div>
            </form>
          </Form>
        </div>

        <aside className="lg:col-span-1">
          <div className="border border-border p-7 md:p-8 lg:sticky lg:top-28">
            <p className="eyebrow text-xl">{t(PAGE.summary)}</p>

            <ul className="mt-6 space-y-4 border-b border-border pb-6">
              {buyable.map((line) => (
                <li key={keyOfLine(line)} className="flex justify-between gap-4 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{t(line.title)}</span>
                    {line.sessionTitle ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {t(line.sessionTitle)}
                      </span>
                    ) : null}
                    {/* 0036：方案名稱另起一行——跟 sessionTitle 同一個理由，
                        沒有方案的行 planTitle 是 null，這裡完全不畫。 */}
                    {line.planTitle ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {t(line.planTitle)}
                      </span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      × {line.qty}
                      {/* 一個單位佔多個座位時把座位數也印出來——不然「× 1」對
                          雙人房這種方案看起來像只訂了一位。 */}
                      {line.planSeatsPerUnit > 1
                        ? `（${line.qty * line.planSeatsPerUnit} ${t(PAGE.seatsUnit)}）`
                        : ""}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatPrice(line.price * line.qty)}
                  </span>
                </li>
              ))}
            </ul>

            <dl className="mt-6 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t(PAGE.subtotal)}</dt>
                <dd className="tabular-nums">{formatPrice(subtotal)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t(PAGE.shipping)}</dt>
                <dd className="tabular-nums">
                  {shippingFee === 0 ? t(PAGE.methodFree) : formatPrice(shippingFee)}
                </dd>
              </div>
              {referralDiscount > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">
                    {t(PAGE.referralDiscount)}（{referral.state === "ok" ? referral.code : ""}）
                  </dt>
                  <dd className="tabular-nums">−{formatPrice(referralDiscount)}</dd>
                </div>
              )}
            </dl>

            {freeGap !== null && (
              <p className="mt-4 text-xs text-muted-foreground">
                {t(PAGE.freeShippingGap)} {formatPrice(freeGap)} {t(PAGE.freeShippingGapTail)}
              </p>
            )}

            <div className="rule my-6" />

            <div className="flex items-baseline justify-between gap-4">
              <span className="eyebrow text-xl">{t(PAGE.total)}</span>
              <span className="font-serif text-2xl tabular-nums">{formatPrice(total)}</span>
            </div>

            {/* 直接結帳的人沒有「回到購物車」這件事可做（他的購物車與這一筆訂單
                無關，而且裡面可能正放著別的東西）。給他回得去的是那個品項自己。 */}
            {direct?.ok ? (
              <Link
                to="/shop/$slug"
                params={{ slug: direct.line.slug }}
                className="mt-7 inline-block border border-foreground px-5 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
              >
                {t(PAGE.backToItem)}
              </Link>
            ) : (
              <Link
                to="/cart"
                className="mt-7 inline-block border border-foreground px-5 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
              >
                {t(PAGE.backToCart)}
              </Link>
            )}
          </div>
        </aside>
      </section>
    </PageShell>
  );
}
