/**
 * 「選物」的〈商品〉分頁 —— 唯一能結帳的那一個。
 *
 * 內容逐字搬自舊的 src/routes/shop.index.tsx（2026-09-02 導覽列合併），只是把
 * PageShell/PageHeader 留在路由檔、這裡只負責分頁內部。loader 資料一律由
 * shop.index.tsx 從 Route.useLoaderData() 取出後傳進來，這個檔案自己不讀資料庫。
 */
import { Link } from "@tanstack/react-router";
import { CoverImage } from "@/components/CoverImage";
import { useState } from "react";
import { PRODUCT_TYPE_LABELS } from "@/components/shop/labels";
import { ShopCategoryStrip } from "@/components/shop/ShopCategoryStrip";
import { PriceTag, StockBadge } from "@/components/shop/ShopBits";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { pageText, type CuratedThemeEntry, type PageContent } from "@/lib/cms";
import { CARD, CARD_HOVER } from "@/lib/feature-layout";
import { displayableCuratedThemes } from "@/lib/home-shelf";
import { imageFor } from "@/lib/images";
import type { PublicationListResult } from "@/lib/publications";
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
  publications,
  curatedThemes,
  heroAlt,
}: {
  page: PageContent | null;
  catalogue: ShopListCardResult;
  /** 只拿來算品類入口上的「N 本」——清單本身在〈地方刊物〉分頁畫。 */
  publications: PublicationListResult;
  /** 只拿主題名稱給品類入口用——櫥窗本身在〈主理人的選品〉分頁畫。
   *  傳給入口前先用 displayableCuratedThemes() 濾掉沒連真實商品的範例（2026-11-10 S3）。 */
  curatedThemes: CuratedThemeEntry[];
  heroAlt: string;
}) {
  const t = useT();
  const p = pageText(page);
  const { ui } = useSiteContent();
  const heroSrc = imageFor(page?.ogImageKey, curatedImg);

  // 活動與策旅不在 /shop 的商品清單出現 —— 它們有 /events「活動與策旅」當
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
  // 入口卡分開算：書刊只算書，地方好物（goods，例如金弘的麻油、花生醬）另一張卡。
  const books = products.filter((prod) => prod.productType === "book");
  const goods = products.filter((prod) => prod.productType === "goods");

  return (
    <>
      {/* 手機版不放這張大圖：它在 390 寬佔掉 ~410px，第一件商品要捲過一整個螢幕
          才看得到。首屏改給下面的品類入口（2026-11 手機版優化）。 */}
      <section className="container-editorial hidden pb-12 md:block">
        <div className="mx-auto w-4/5 aspect-[3/4] md:aspect-[16/10] overflow-hidden bg-muted">
          <img src={heroSrc} alt={heroAlt} className="h-full w-full object-cover" loading="lazy" />
        </div>
      </section>

      <ShopCategoryStrip
        bookCount={books.length}
        bookCover={books[0] ? imageFor(books[0].imageKey, curatedImg) : curatedImg}
        goodsCount={goods.length}
        goodsCover={goods[0] ? imageFor(goods[0].imageKey, curatedImg) : undefined}
        onPickType={setFilter}
        publicationCount={publications.publications.length}
        curatedThemes={displayableCuratedThemes(curatedThemes, catalogue.products)}
      />

      {presentTypes.length > 1 && (
        <section
          className="container-editorial pb-8 md:pb-12 flex gap-2 overflow-x-auto [scrollbar-width:none] md:flex-wrap md:gap-3 text-xs tracking-widest"
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
                className={`shrink-0 min-h-11 px-4 py-2 border transition-colors ${
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
          id="product-grid"
          className="container-editorial pb-24 md:pb-32 grid grid-cols-2 gap-x-3 gap-y-5 scroll-mt-28 md:gap-8 lg:grid-cols-3"
          data-testid="product-grid"
          data-reveal-stagger
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
                  {/* 手機兩欄 3:4、桌機 4:3。商品幾乎都是地方刊物，封面上有字、比例不一（有橫式
                      跨頁、正方形），所以跟首頁那一排一樣用 CoverImage：整張完整顯示，多出來
                      的空白用同一張圖模糊補邊。直式書封在 3:4 框裡看起來與 cover 一樣。 */}
                  <CoverImage
                    src={imageFor(prod.imageKey, curatedImg)}
                    alt={t(prod.title)}
                    className="aspect-[3/4] md:aspect-[4/3]"
                    imgClassName={`transition-transform duration-500 group-hover:scale-[1.03] ${
                      soldOut ? "opacity-50" : ""
                    }`}
                    loading="lazy"
                  />
                  <div className="flex flex-1 flex-col p-3 md:p-6">
                    <p className="eyebrow text-xs md:text-sm tracking-widest">
                      {t(PRODUCT_TYPE_LABELS[prod.productType])}
                    </p>
                    <h2 className="font-serif text-base md:text-xl mt-1.5 md:mt-3 leading-snug line-clamp-2 md:line-clamp-none group-hover:underline underline-offset-4">
                      {t(prod.title)}
                    </h2>
                    <p className="mt-1 md:mt-3 text-xs md:text-sm leading-relaxed text-muted-foreground line-clamp-2 md:line-clamp-none">
                      {t(prod.summary)}
                    </p>
                    {/* 價格與庫存標籤推到卡片底部：同一列的卡片底部對齊。 */}
                    <div className="mt-auto pt-3 md:pt-6">
                      <PriceTag price={prod.price} compareAtPrice={prod.compareAtPrice} />
                      {(soldOut || low) && (
                        <div className="mt-2 md:mt-4">
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
