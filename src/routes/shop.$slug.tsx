import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { PRODUCT_TYPE_LABELS, SEATS_LEFT_LABEL } from "@/components/shop/labels";
import { PlanPicker } from "@/components/shop/PlanPicker";
import { EventEndedNotice, SessionPicker } from "@/components/shop/SessionPicker";
import { PriceTag, QuantityStepper, StockBadge } from "@/components/shop/ShopBits";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { cartInputFor, useCart } from "@/lib/cart";
import {
  directBookingClosed,
  directOpenProduct,
  directSelectedSession,
} from "@/lib/direct-checkout";
import { isSessionClosedForBooking } from "@/lib/event-status";
import { useBookingNow } from "@/hooks/use-booking-now";
import { imageFor } from "@/lib/images";
import { pageMeta } from "@/lib/seo/head";
import { productSeo } from "@/lib/seo/pages";
import { unavailableHeaders } from "@/lib/seo/status";
import {
  fetchActiveProductBySlug,
  findActiveProductSlugIgnoringCase,
  isSoldOut,
  remainingForSession,
  type ShopSession,
} from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import curatedImg from "@/assets/curated-objects.jpg";

/**
 * Page copy. The product's own title/summary/description come from the
 * database; these are the surrounding chrome plus the meta fallbacks used
 * before the product is known (and by scripts/check-meta.mjs, which resolves
 * this object statically — keep every entry a plain zh/en/ja string literal).
 */
const PAGE = {
  metaTitle: {
    zh: "商品｜小時光書店 Interval Books",
    en: "Item｜Interval Books",
    ja: "商品｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "小時光書店的選物與書籍，一件一件挑過才留下來。",
    en: "Books and objects from Interval Books — each one chosen by hand before it earned its place.",
    ja: "小時光書店が一点ずつ選んだ書籍とセレクト品をご紹介します。",
  },
  back: { zh: "回到選購", en: "Back to shop", ja: "ショップへ戻る" },
  quantity: { zh: "數量", en: "Quantity", ja: "数量" },
  remaining: { zh: "尚有庫存", en: "In stock", ja: "在庫あり" },
  remainingCount: { zh: "僅剩", en: "Only", ja: "残り" },
  remainingUnit: { zh: "件", en: "left", ja: "点" },
  // 「尚餘名額」在 @/components/shop/labels，因為 SessionPicker 也用同一句；
  // 場次選擇器自己的三句文案（選擇場次／已額滿／目前沒有開放報名的場次）跟著元件走。
  pickSessionFirst: {
    zh: "請先選擇場次",
    en: "Please choose a sitting first",
    ja: "先に回をお選びください",
  },
  // 0036：這一場開了方案時，選完場次還要再選一個方案。
  pickPlanFirst: {
    zh: "請先選擇方案",
    en: "Please choose a plan first",
    ja: "先にプランをお選びください",
  },
  unlimited: { zh: "常備品項", en: "Always in stock", ja: "常時ご用意" },
  soldOutNote: {
    zh: "這件已經售完了。歡迎來信或到店詢問補貨。",
    en: "This one has sold out. Write to us or drop by to ask about a restock.",
    ja: "こちらは完売しました。再入荷についてはメールまたは店頭でお問い合わせください。",
  },
  addedToast: { zh: "已加入購物車", en: "Added to cart", ja: "カートに入れました" },
  cappedToast: {
    zh: "已達可購買數量上限",
    en: "That is all we have available",
    ja: "ご購入いただける上限に達しました",
  },
  soldOutToast: {
    zh: "這件商品目前售完",
    en: "This item is sold out",
    ja: "この商品は完売しています",
  },
  unavailable: {
    zh: "商品資料暫時無法載入，請稍後再試。",
    en: "This item is temporarily unavailable. Please try again shortly.",
    ja: "商品情報を読み込めませんでした。しばらくしてからお試しください。",
  },
  aboutThis: { zh: "關於這件", en: "About this item", ja: "この商品について" },
};

/**
 * Prefers the product's own localized copy and falls back to the page-level
 * constant before the product is known (loader failure) — and, importantly,
 * gives scripts/check-meta.mjs a statically resolvable object literal to audit.
 */
function metaOr(value: Localized | undefined, fallback: Localized): Localized {
  return value ?? fallback;
}

export const Route = createFileRoute("/shop/$slug")({
  loader: async ({ params }) => {
    const { product, unavailable } = await fetchActiveProductBySlug(params.slug);
    // A slug that resolves to nothing really is a 404. A failed read is not —
    // that would tell crawlers a live product is gone because Supabase blinked.
    if (!product && !unavailable) {
      // 2026-11 SEO 驗收 #5：/shop/PUB-TW-001 → 不分大小寫再找一次，找到就 301 到資料庫
      // 裡的正確寫法（與 /events/$slug 同一套；不一律轉小寫，代稱的大小寫以資料庫為準）。
      const canonical = await findActiveProductSlugIgnoringCase(params.slug);
      if (canonical) {
        throw redirect({ to: "/shop/$slug", params: { slug: canonical }, statusCode: 301 });
      }
      throw notFound();
    }
    // now：「場次開始了沒」的判斷時間點，SSR 與第一次 hydrate 共用（見 useBookingNow）。
    return { product, unavailable, now: Date.now() };
  },
  // SEO（2026-11 健檢）：title「{品名}｜{類別}｜小時光書店」、描述取摘要＋介紹文、
  // JSON-LD 輸出 Product（刊物另標 Book）與麵包屑。組裝在 src/lib/seo/pages.ts#productSeo。
  head: ({ loaderData }) => {
    const seo = productSeo(loaderData?.product ?? null, PAGE, curatedImg);
    return {
      meta: pageMeta({
        title: seo.title,
        description: seo.description,
        image: seo.image,
        type: "product",
        jsonLd: seo.jsonLd,
      }),
    };
  },
  // 讀不到商品（不是查無此商品）→ 503 + Retry-After。
  headers: ({ loaderData }) =>
    unavailableHeaders(Boolean(loaderData?.unavailable && !loaderData?.product)),
  component: ProductDetail,
});

function ProductDetail() {
  const t = useT();
  const { product, unavailable, now: loadedAt } = Route.useLoaderData();
  const { ui } = useSiteContent();
  // 場次開始了沒（isSessionClosedForBooking）。在 early return 之前（hook 規則）。
  const now = useBookingNow(loadedAt, product?.sessions ?? []);
  const addItem = useCart((s) => s.addItem);
  const [qty, setQty] = useState(1);
  /**
   * 只有 event/journey 用得到。預設選第一個**還有位子**的場次，沒有的話就是 null
   * —— 不預設一個已額滿的場次，否則「加入購物車」會在客人還沒選之前就是灰的，
   * 而灰的原因看不出來。
   */
  const [sessionId, setSessionId] = useState<string | null>(
    () =>
      product?.sessions.find(
        // 已開始的場次不預設（2026-11）：與額滿同一個理由。用 loader 的時間，SSR 才一致。
        (s) => !isSessionClosedForBooking(s, loadedAt) && remainingForSession(s) > 0,
      )?.id ?? null,
  );
  // 0036：這個場次選了哪個方案。跟 sessionId 一樣只活在這個元件裡。
  const [planId, setPlanId] = useState<string | null>(null);

  const seo = productSeo(product, PAGE, curatedImg);
  useDocumentMeta({
    title: metaOr(seo.title, PAGE.metaTitle),
    description: metaOr(seo.description, PAGE.metaDescription),
    ogTitle: metaOr(seo.title, PAGE.metaTitle),
    ogImage: seo.image ?? undefined,
  });

  if (!product) {
    return (
      <PageShell>
        <section className="container-editorial py-32">
          <p className="border border-border p-8 text-sm text-muted-foreground">
            {t(PAGE.unavailable)}
          </p>
          <BackLink label={t(PAGE.back)} />
        </section>
      </PageShell>
    );
  }

  const isBooking = product.productType === "event" || product.productType === "journey";
  // 已開始的場次不算選中（directSelectedSession → isSessionClosedForBooking）。
  const selectedSession: ShopSession | null = isBooking
    ? directSelectedSession(product, sessionId, now)
    : null;
  // 每一個場次都已開始：報名區換成 EventEndedNotice（與活動頁同一個畫面）。
  const bookingClosed = isBooking && directBookingClosed(product, now);
  // 0036：這個場次有沒有開方案——有的話得先選一個才能加入購物車。
  const needsPlan = selectedSession !== null && selectedSession.plans.length > 0;
  const selectedPlan = selectedSession?.plans.find((p) => p.id === planId) ?? null;
  const readyToBook =
    !isBooking || (selectedSession !== null && (!needsPlan || selectedPlan !== null));

  // 活動的「還剩幾個」是**選中那一場（與方案）**的剩餘，不是商品層級的最大值。
  // 用後者當上限的話，兩個各 5 個位子的梯次會讓單一梯次的數量選到 5 —— 而那一場
  // 可能只剩 1 個。這裡改走 cartInputFor()（跟購物車行、direct-checkout 同一個
  // 算式），不自己重算——理由與那兩個檔案完全一樣：算法只能有一份。沒選場次
  // （或沒有方案）時它自己會落回商品層級／場次層級的數字，那只是給徽章看的。
  // 已開始的場次不算進「還剩幾位」（沒選場次時那是跨場次最大值）。
  const remaining = cartInputFor(
    isBooking ? directOpenProduct(product, now) : product,
    1,
    selectedSession,
    selectedPlan,
  ).limit;
  const soldOut = isBooking ? (remaining ?? 0) <= 0 : isSoldOut(product);
  /**
   * 徽章那一行整個不畫的條件。**只對報名商品成立** —— goods/book 的徽章講的是
   * 庫存不是名額，這個開關管不到它們。額滿另外處理（見下面），這裡不判。
   */
  const hideSeatsBadge = isBooking && !product.showSeatsRemaining;

  function handleAdd() {
    // `product` is narrowed above, but the closure needs its own guard.
    if (!product || soldOut || bookingClosed) return;
    if (isBooking && !selectedSession) {
      toast.error(t(PAGE.pickSessionFirst));
      return;
    }
    if (isBooking && needsPlan && !selectedPlan) {
      toast.error(t(PAGE.pickPlanFirst));
      return;
    }
    const result = addItem(cartInputFor(product, qty, selectedSession, selectedPlan));
    if (result === "added") {
      toast.success(t(PAGE.addedToast));
      setQty(1);
    } else if (result === "capped") {
      toast.warning(t(PAGE.cappedToast));
    } else {
      toast.error(t(PAGE.soldOutToast));
    }
  }

  return (
    <PageShell>
      <section className="container-editorial pt-12 md:pt-16">
        <BackLink label={t(PAGE.back)} />
      </section>

      <section className="container-editorial pb-24 pt-8 grid gap-12 md:grid-cols-2 md:gap-16">
        <div className="aspect-[4/5] overflow-hidden bg-muted">
          <img
            src={imageFor(product.imageKey, curatedImg)}
            alt={t(product.title)}
            className={`h-full w-full object-cover ${soldOut || bookingClosed ? "opacity-60" : ""}`}
          />
        </div>

        <div className="flex flex-col">
          <p className="eyebrow text-2xl">{t(PRODUCT_TYPE_LABELS[product.productType])}</p>
          <h1 className="display mt-4 text-4xl md:text-5xl leading-tight">{t(product.title)}</h1>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground">
            {t(product.summary)}
          </p>

          <PriceTag
            price={product.price}
            compareAtPrice={product.compareAtPrice}
            size="lg"
            className="mt-8"
          />

          {/* 名額／庫存徽章。
              🔴 **售罄（活動就是「已額滿」）永遠顯示**，不受 showSeatsRemaining 影響 ——
                 那是「你買不到了」，跟「還剩幾件／幾位」不是同一件事。
              旗標關掉時只有**報名商品**的剩餘那一句消失（連整個 <div> 一起，否則
              會留下一條 mt-5 的空白）；書與選物的「僅剩 N 件」與它無關，那不是名額。 */}
          {bookingClosed ? null : soldOut ? (
            <div className="mt-5">
              <StockBadge tone="alert">{t(ui.buttons.soldOut)}</StockBadge>
            </div>
          ) : hideSeatsBadge ? null : (
            <div className="mt-5">
              {remaining === null ? (
                <StockBadge>{t(PAGE.unlimited)}</StockBadge>
              ) : remaining <= 5 ? (
                <StockBadge tone="alert">
                  {isBooking
                    ? `${t(SEATS_LEFT_LABEL)} ${remaining}`
                    : `${t(PAGE.remainingCount)} ${remaining} ${t(PAGE.remainingUnit)}`}
                </StockBadge>
              ) : (
                <StockBadge>
                  {isBooking ? `${t(SEATS_LEFT_LABEL)} ${remaining}` : t(PAGE.remaining)}
                </StockBadge>
              )}
            </div>
          )}

          <div className="rule my-8" />

          {/* 場次選擇。只有活動／策旅會渲染，而且**先於**數量選擇 —— 上限是選中
              那一場的剩餘，所以順序反過來會讓數量先被一個還沒決定的上限夾住。 */}
          {/* 每一個場次都已開始（2026-11）：與活動頁同一個結束畫面——場次標「已結束」、
              按鈕停用、沒有加入購物車的路。 */}
          {bookingClosed ? (
            <EventEndedNotice product={product} />
          ) : isBooking ? (
            <SessionPicker
              sessions={product.sessions}
              showSeatsRemaining={product.showSeatsRemaining}
              now={now}
              selectedId={sessionId}
              onSelect={(id) => {
                setSessionId(id);
                // 換場次就把方案與數量都收回：舊的方案可能不屬於新場次，舊的
                // 數量可能超過新場次（或新方案）的剩餘，而 clampToLimit 只在
                // 加入購物車那一刻才作用。
                setPlanId(null);
                setQty(1);
              }}
            />
          ) : null}

          {/* 0036：選了場次、而且那個場次有開方案，才畫方案選擇器——沒有方案的
              場次這裡完全不畫，畫面與 0020 之後逐字相同。 */}
          {selectedSession && needsPlan ? (
            <PlanPicker
              plans={selectedSession.plans}
              showSeatsRemaining={product.showSeatsRemaining}
              selectedId={planId}
              onSelect={(id) => {
                setPlanId(id);
                setQty(1);
              }}
            />
          ) : null}

          {bookingClosed ? null : soldOut ? (
            <p className="text-sm leading-relaxed text-muted-foreground">{t(PAGE.soldOutNote)}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <QuantityStepper
                value={qty}
                max={remaining}
                onChange={(next) => setQty(Math.max(1, next))}
                label={t(PAGE.quantity)}
                disabled={!readyToBook}
              />
              <button
                type="button"
                onClick={handleAdd}
                disabled={!readyToBook}
                className="border border-foreground px-6 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-30"
              >
                {t(ui.buttons.addToCart)}
              </button>
              <Link
                to="/cart"
                className="text-xs tracking-widest text-muted-foreground hover-underline hover:text-foreground transition-colors"
              >
                {t(ui.buttons.viewCart)}
              </Link>
            </div>
          )}
          {!readyToBook && !soldOut && !bookingClosed ? (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {selectedSession === null ? t(PAGE.pickSessionFirst) : t(PAGE.pickPlanFirst)}
            </p>
          ) : null}

          {/* `unavailable` can only be true here when the product came back
              null, which the early return above already handled — but keeping
              the branch means a future loader change cannot silently drop it. */}
          {unavailable && (
            <p className="mt-6 text-sm text-muted-foreground">{t(PAGE.unavailable)}</p>
          )}
        </div>
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-12 max-w-3xl">
          <p className="eyebrow text-2xl">{t(PAGE.aboutThis)}</p>
          <p className="mt-6 whitespace-pre-line text-base leading-relaxed text-foreground/80">
            {t(product.description)}
          </p>
        </div>
      </section>
    </PageShell>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      to="/shop"
      className="inline-flex items-center gap-2 text-xs tracking-widest text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {label}
    </Link>
  );
}
