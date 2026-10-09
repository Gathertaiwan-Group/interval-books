/**
 * 「選物」的〈商品〉分頁 —— 唯一能結帳的那一個。
 *
 * 內容逐字搬自舊的 src/routes/shop.index.tsx（2026-09-02 導覽列合併），只是把
 * PageShell/PageHeader 留在路由檔、這裡只負責分頁內部。loader 資料一律由
 * shop.index.tsx 從 Route.useLoaderData() 取出後傳進來，這個檔案自己不讀資料庫。
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PRODUCT_TYPE_LABELS } from "@/components/shop/labels";
import { PriceTag, StockBadge } from "@/components/shop/ShopBits";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { pageText, type PageContent } from "@/lib/cms";
import { CARD, CARD_HOVER } from "@/lib/feature-layout";
import { imageFor } from "@/lib/images";
import { isSoldOut, remainingFor, SHOP_PRODUCT_TYPES, type ShopListCardResult } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import curatedImg from "@/assets/curated-objects.jpg";

/** 後備文案 —— 只有在 Supabase 讀不到 pages/'shop' 那一列時才會用到。 */
const COPY = {
  filterAll: { zh: "全部", en: "All", ja: "すべて" },
  empty: {
    zh: "目前沒有上架中的商品，歡迎到店裡看看。",
    en: "Nothing is on sale right now — do come and see us in the shop.",
    ja: "現在お取り扱い中の商品はありません。ぜひ店頭にもお立ち寄りください。",
  },
  emptyFiltered: {
    zh: "這個分類目前沒有商品。",
    en: "No items in this category right now.",
    ja: "このカテゴリーの商品は現在ありません。",
  },
  unavailable: {
    zh: "商品資料暫時無法載入，請稍後再試。",
    en: "The catalogue is temporarily unavailable. Please try again shortly.",
    ja: "商品情報を読み込めませんでした。しばらくしてからお試しください。",
  },
  lowStock: { zh: "僅剩", en: "Only", ja: "残り" },
  lowStockUnit: { zh: "件", en: "left", ja: "点" },
  // event/journey are booked, not stocked — "2 pieces left" is the wrong noun
  // for a reading circle.
  seatsLeft: { zh: "尚餘名額", en: "Places left", ja: "残り枠" },
} satisfies Record<string, Localized>;

/** Below this, the remaining quantity is worth saying out loud on the card. */
const LOW_STOCK_THRESHOLD = 5;

export function ProductsPanel({
  page,
  catalogue,
  heroAlt,
}: {
  page: PageContent | null;
  catalogue: ShopListCardResult;
  heroAlt: string;
}) {
  const t = useT();
  const p = pageText(page);
  const { ui } = useSiteContent();
  const heroSrc = imageFor(page?.ogImageKey, curatedImg);

  // 活動與策旅不在 /shop 的商品清單出現 —— 它們各自有 /events 與 /journeys 當
  // 入口，在這裡再列一次，同一場活動就有兩個長得不一樣的門。
  //
  // 🔴 過濾放在這裡，而不是在 shop.index.tsx 傳進來之前先濾掉：loader 讀到的
  //    那一份 catalogue 必須原封不動同時餵給 ProductsPanel 與 PublicationsPanel
  //    （後者要拿它核對哪幾本刊物能買），nav-consolidation 與 shop-list-payload
  //    兩支自檢都在守「兩個面板吃的是同一份 catalogue」這條線。
  //
  //    下面的 presentTypes 是照 products 現有的型別算出來的，所以這兩種一被濾掉，
  //    「活動」「策旅」那兩顆篩選 pill 也跟著消失，不需要另外處理。
  const { unavailable } = catalogue;
  const products = catalogue.products.filter(
    (prod) => prod.productType !== "event" && prod.productType !== "journey",
  );

  // Only offer a filter for types that actually have something to show, so the
  // shop never presents a pill that leads to an empty grid.
  const presentTypes = SHOP_PRODUCT_TYPES.filter((type) =>
    products.some((prod) => prod.productType === type),
  );
  const [filter, setFilter] = useState<string>("all");
  // Products are already ordered by sort_order (then id) in the query — see
  // fetchActiveProducts — and .filter preserves that order.
  const list = filter === "all" ? products : products.filter((prod) => prod.productType === filter);

  return (
    <>
      <section className="container-editorial pb-12">
        <div className="mx-auto w-4/5 aspect-[3/4] md:aspect-[16/10] overflow-hidden bg-muted">
          <img src={heroSrc} alt={heroAlt} className="h-full w-full object-cover" loading="lazy" />
        </div>
      </section>

      {presentTypes.length > 1 && (
        <section
          className="container-editorial pb-12 flex flex-wrap gap-3 text-xs tracking-widest"
          data-testid="product-type-filter"
        >
          {["all", ...presentTypes].map((f) => {
            const label =
              f === "all"
                ? t(p.block("filters.all", COPY.filterAll))
                : t(PRODUCT_TYPE_LABELS[f as keyof typeof PRODUCT_TYPE_LABELS]);
            const active = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={active}
                className={`px-4 py-2 border transition-colors ${
                  active
                    ? "border-foreground bg-foreground text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            );
          })}
        </section>
      )}

      {/* "The read failed" and "there is genuinely nothing for sale" are
          different facts and get different copy — see the header of
          src/lib/shop.ts. */}
      {unavailable ? (
        <section className="container-editorial pb-32">
          <p className="border border-border p-8 text-sm text-muted-foreground">
            {t(p.block("unavailable", COPY.unavailable))}
          </p>
        </section>
      ) : list.length === 0 ? (
        <section className="container-editorial pb-32">
          <p className="border border-border p-8 text-sm text-muted-foreground">
            {products.length === 0
              ? t(p.block("empty", COPY.empty))
              : t(p.block("emptyFiltered", COPY.emptyFiltered))}
          </p>
        </section>
      ) : (
        <section
          className="container-editorial pb-32 grid grid-cols-1 gap-6 sm:grid-cols-2 md:gap-8 lg:grid-cols-3"
          data-testid="product-grid"
        >
          {list.map((prod) => {
            const soldOut = isSoldOut(prod);
            const remaining = remainingFor(prod);
            const low =
              !soldOut && remaining !== null && remaining > 0 && remaining <= LOW_STOCK_THRESHOLD;
            const isBooking = prod.productType === "event" || prod.productType === "journey";
            // 一件一張獨立卡片，外框用前台共用的 CARD（src/lib/feature-layout.ts）。
            // 整張卡就是一個連結，所以加 CARD_HOVER（刊物卡不是連結，就不加）。
            return (
              <article key={prod.id} className={`${CARD} ${CARD_HOVER}`}>
                <Link
                  to="/shop/$slug"
                  params={{ slug: prod.slug }}
                  className="flex flex-1 flex-col"
                >
                  <div className="aspect-[4/3] overflow-hidden bg-muted">
                    <img
                      src={imageFor(prod.imageKey, curatedImg)}
                      alt={t(prod.title)}
                      className={`h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03] ${
                        soldOut ? "opacity-50" : ""
                      }`}
                      loading="lazy"
                    />
                  </div>
                  <div className="flex flex-1 flex-col p-5 md:p-6">
                    <p className="eyebrow text-sm tracking-widest">
                      {t(PRODUCT_TYPE_LABELS[prod.productType])}
                    </p>
                    <h2 className="font-serif text-xl mt-3 leading-snug group-hover:underline underline-offset-4">
                      {t(prod.title)}
                    </h2>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                      {t(prod.summary)}
                    </p>
                    {/* 價格與庫存標籤推到卡片底部：同一列的卡片底部對齊。 */}
                    <div className="mt-auto pt-6">
                      <PriceTag price={prod.price} compareAtPrice={prod.compareAtPrice} />
                      {(soldOut || low) && (
                        <div className="mt-4">
                          {soldOut ? (
                            <StockBadge tone="alert">{t(ui.buttons.soldOut)}</StockBadge>
                          ) : isBooking ? (
                            <StockBadge>
                              {t(p.block("seatsLeft", COPY.seatsLeft))} {remaining}
                            </StockBadge>
                          ) : (
                            <StockBadge>
                              {t(p.block("lowStock", COPY.lowStock))} {remaining}{" "}
                              {t(p.block("lowStockUnit", COPY.lowStockUnit))}
                            </StockBadge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </Link>
              </article>
            );
          })}
        </section>
      )}
    </>
  );
}
