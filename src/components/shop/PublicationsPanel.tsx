/**
 * 「選物」的〈地方刊物〉分頁。
 *
 * 內容逐字搬自舊的 src/routes/publications.tsx（2026-09-02 導覽列合併）。分頁的存在
 * 本身就是重點：126 本刊物裡**絕大多數買不到**，混進商品格狀清單裡客人會以為都能買。
 *
 * 「可買」與「只展示」的分界線仍然是 publications.product_id：
 *
 *   product_id 為 null            → 只展示，顯示「到店選購」
 *   product_id 指到一件 active 商品 → 購買鈕，可售量走 product_availability
 *   product_id 有值但商品讀不到     → 也只展示。商品讀失敗不該讓展覽頁跟著壞掉，
 *                                    這正是 loader 分兩次讀的理由（見 lib/publications.ts）。
 *
 * 所以「之後在後台補完定價」不需要動這一頁：後台把某一本連上庫存商品之後，
 * 下一次載入這一頁就長出購買鈕。
 *
 * 2026-11（SEO 健檢 M4）：每一本刊物有自己的頁面 /publications/$slug。卡片的封面、刊名與
 * 「刊物介紹 →」都連過去（介紹文在那一頁 SSR 輸出）；原本「點開卡片才現查介紹」的展開區
 * 拿掉了。這個元件同時用在 /publications（總覽頁，showIntro=false，標題由 PageHeader 出）
 * 與 /shop?tab=publications（舊網址，canonical 指向 /publications）。
 *
 * 篩選（2026-10 改版）：國家三段切換＋一個「地區」原生下拉，取代原本約 30 顆的
 * 「關注地域」chips。篩選狀態仍然只是這個元件的 useState（sheet／region），沒有
 * 進網址——網址上只有 shop.index.tsx 的 ?tab=。篩選的純函式在
 * ./publication-filters.ts，結果與舊 chips 逐本相同。
 */
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { Fragment, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ALL_REGIONS,
  entriesForRegion,
  entriesForSheet,
  regionAfterSheetChange,
  regionOptionGroups,
  type RegionOption,
  type RegionOptionGroup,
  type SheetFilter,
} from "@/components/shop/publication-filters";
import { PriceTag, StockBadge } from "@/components/shop/ShopBits";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { pageText, type PageContent } from "@/lib/cms";
import { cartInputFor, useCart } from "@/lib/cart";
import { CARD } from "@/lib/feature-layout";
import { imageFor } from "@/lib/images";
import {
  SHEET_LABELS,
  type PublicationListEntry,
  type PublicationListResult,
} from "@/lib/publications";
import { isSoldOut, remainingFor, type ShopListCardResult, type ShopProductCard } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import bookstoreImg from "@/assets/bookstore-interior.jpg";

/** 後備文案 —— 只有在 Supabase 讀不到 pages/'publications' 那一列時才會用到。 */
const COPY = {
  title: {
    zh: "一個地方，怎麼被自己的人寫下來",
    en: "How a place gets written down by its own people",
    ja: "その土地の人が、その土地を書く",
  },
  intro: {
    zh: "從基隆的漁村到花蓮的溪流，126 本地方刊物擺在同一張桌子上。它們大多不是為了賣而做的，是為了留下來。",
    en: "From a fishing village in Keelung to a river in Hualien, 126 local publications share one table. Most were not made to be sold — they were made to remain.",
    ja: "基隆の漁村から花蓮の川まで、126冊の地域刊行物がひとつの机に並びます。その多くは売るためではなく、遺すためにつくられました。",
  },
  filterAll: { zh: "全部", en: "All", ja: "すべて" },
  regionLabel: { zh: "地區", en: "Region", ja: "地域" },
  regionAll: { zh: "所有地區", en: "All regions", ja: "すべての地域" },
  // 下拉選項「基隆（8）」。三語各寫完整的格式，{region}／{n} 是佔位
  // （與 ParticipantFields.tsx 的 seatLabel 同一種寫法）。
  regionOption: { zh: "{region}（{n}）", en: "{region} ({n})", ja: "{region}（{n}）" },
  // 國家選「全部」時下拉裡的三個 <optgroup>。
  regionGroupTw: { zh: "台灣", en: "Taiwan", ja: "台湾" },
  regionGroupJp: { zh: "日本", en: "Japan", ja: "日本" },
  regionGroupOther: { zh: "其他", en: "Other", ja: "その他" },
  publisherLabel: { zh: "製作單位", en: "Published by", ja: "発行" },
  issuesLabel: { zh: "集數", en: "Issues", ja: "号" },
  readMore: { zh: "刊物介紹", en: "About this title", ja: "この刊行物について" },
  displayOnly: {
    zh: "此本僅供店內展示",
    en: "On display in store only",
    ja: "店頭展示のみ",
  },
  countSuffix: { zh: "本", en: "titles", ja: "冊" },
  empty: {
    zh: "這個條件下沒有刊物，換一個地區看看。",
    en: "Nothing matches this filter — try another region.",
    ja: "この条件に合う刊行物はありません。別の地域をお試しください。",
  },
  unavailable: {
    zh: "刊物資料暫時無法載入，請稍後再試。",
    en: "The publication list is temporarily unavailable. Please try again shortly.",
    ja: "刊行物の情報を読み込めませんでした。しばらくしてからお試しください。",
  },
  addedToast: { zh: "已加入購物車", en: "Added to cart", ja: "カートに入れました" },
  cappedToast: {
    zh: "已達可購買的數量上限",
    en: "That is all we can sell right now",
    ja: "購入可能な数量の上限です",
  },
  soldOutToast: {
    zh: "這一本剛剛售完了",
    en: "This one has just sold out",
    ja: "こちらは完売しました",
  },
  lowStock: { zh: "僅剩", en: "Only", ja: "残り" },
  lowStockUnit: { zh: "本", en: "left", ja: "冊" },
} satisfies Record<string, Localized>;

/** 低於這個數字才把剩餘量說出來。與商品分頁同一個門檻。 */
const LOW_STOCK_THRESHOLD = 5;

export function PublicationsPanel({
  page,
  list,
  catalogue,
  showIntro = true,
}: {
  page: PageContent | null;
  list: PublicationListResult;
  catalogue: ShopListCardResult;
  /** false：頁面自己的 PageHeader 已經印了同一組標題與介紹（/publications）。 */
  showIntro?: boolean;
}) {
  const t = useT();
  const p = pageText(page);
  const { ui } = useSiteContent();

  const { publications, unavailable } = list;
  const productById = useMemo(
    () => new Map(catalogue.products.map((prod) => [prod.id, prod])),
    [catalogue.products],
  );

  const [sheet, setSheet] = useState<SheetFilter>("all");
  const [region, setRegion] = useState<string>(ALL_REGIONS);
  const regionSelectId = useId();

  const sheetFiltered = useMemo(() => entriesForSheet(publications, sheet), [publications, sheet]);

  // 地區選項跟著國家走：選了「日本刊物」就不該還看得到「基隆」這個選項。
  const regionGroups = useMemo(
    () => regionOptionGroups(sheetFiltered, sheet),
    [sheetFiltered, sheet],
  );
  const regionOptionCount = regionGroups.reduce((n, g) => n + g.options.length, 0);

  const visible = useMemo(() => entriesForRegion(sheetFiltered, region), [sheetFiltered, region]);

  function changeSheet(next: SheetFilter) {
    setSheet(next);
    // 原本選的地區在新的國家底下還有刊物就留著，沒有才回到「所有地區」。
    setRegion(regionAfterSheetChange(publications, next, region));
  }

  function changeRegion(next: string) {
    setRegion(next);
  }

  const optgroupLabel: Record<NonNullable<RegionOptionGroup["group"]>, string> = {
    tw: t(p.block("regionGroupTw", COPY.regionGroupTw)),
    jp: t(p.block("regionGroupJp", COPY.regionGroupJp)),
    other: t(p.block("regionGroupOther", COPY.regionGroupOther)),
  };
  // 用函式當替換值：地區名稱裡要是有 "$"，字串替換值會被當成特殊樣式。
  const optionText = (o: RegionOption) =>
    t(p.block("regionOption", COPY.regionOption))
      .replace("{region}", () => t(o.label))
      .replace("{n}", () => String(o.count));

  return (
    <>
      {showIntro ? (
        <PanelIntro title={t(p.title(COPY.title))} intro={t(p.intro(COPY.intro))} />
      ) : null}

      {unavailable ? (
        <section className="container-editorial pb-32">
          <p className="border border-border p-8 text-sm text-muted-foreground">
            {t(p.block("unavailable", COPY.unavailable))}
          </p>
        </section>
      ) : (
        <>
          {/* 手機：國家／地區／本數上下排，下拉撐滿整列。md 以上排成同一列、本數跟在
              下拉旁邊；一列放不下（日文、平板寬度）就整項換行，不會撐出橫向捲動。 */}
          <section className="container-editorial pb-8">
            <div className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-center md:gap-x-8">
              <div
                className="flex flex-wrap gap-2 text-xs tracking-widest sm:gap-3"
                data-testid="sheet-filter"
              >
                {(["all", "tw", "jp"] as const).map((f) => {
                  const label =
                    f === "all" ? t(p.block("filters.all", COPY.filterAll)) : t(SHEET_LABELS[f]);
                  const active = sheet === f;
                  const count =
                    f === "all"
                      ? publications.length
                      : publications.filter((e) => e.sheet === f).length;
                  // px-3／gap-2 只在手機：390px 寬時三顆才排得進同一行（中、英文）。
                  return (
                    <button
                      key={f}
                      onClick={() => changeSheet(f)}
                      aria-pressed={active}
                      className={`px-3 py-2 border transition-colors sm:px-4 ${
                        active
                          ? "border-foreground bg-foreground text-primary-foreground"
                          : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                      <span className="ml-2 tabular-nums opacity-70">{count}</span>
                    </button>
                  );
                })}
              </div>

              {regionOptionCount > 1 && (
                <div className="flex items-center gap-3">
                  <label
                    htmlFor={regionSelectId}
                    className="shrink-0 text-xs tracking-widest text-muted-foreground"
                  >
                    {t(p.block("regionLabel", COPY.regionLabel))}
                  </label>
                  <div className="relative min-w-0 flex-1 md:flex-none">
                    {/* 手機上是 text-base（16px）：iOS Safari 對字級小於 16px 的表單
                        欄位，點下去會把整頁放大。md 以上回到跟國家切換同一個字級。 */}
                    <select
                      id={regionSelectId}
                      value={region}
                      onChange={(e) => changeRegion(e.target.value)}
                      data-testid="region-filter"
                      className="w-full appearance-none rounded-none border border-border bg-background py-2 pl-3 pr-9 text-base text-foreground transition-colors hover:border-foreground md:w-auto md:min-w-44 md:text-xs md:tracking-widest"
                    >
                      <option value={ALL_REGIONS}>{t(p.block("regionAll", COPY.regionAll))}</option>
                      {regionGroups.map((g) => {
                        const options = g.options.map((o) => (
                          <option key={o.key} value={o.key}>
                            {optionText(o)}
                          </option>
                        ));
                        return g.group === null ? (
                          <Fragment key="flat">{options}</Fragment>
                        ) : (
                          <optgroup key={g.group} label={optgroupLabel[g.group]}>
                            {options}
                          </optgroup>
                        );
                      })}
                    </select>
                    <ChevronDown
                      aria-hidden="true"
                      className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    />
                  </div>
                </div>
              )}

              <p
                className="text-xs text-muted-foreground tabular-nums"
                data-testid="visible-count"
                aria-live="polite"
              >
                {visible.length} {t(p.block("countSuffix", COPY.countSuffix))}
              </p>
            </div>
          </section>

          {visible.length === 0 ? (
            <section className="container-editorial pb-32">
              <p className="border border-border p-8 text-sm text-muted-foreground">
                {t(p.block("empty", COPY.empty))}
              </p>
            </section>
          ) : (
            <section
              className="container-editorial pb-32 grid grid-cols-1 gap-6 sm:grid-cols-2 md:gap-8 lg:grid-cols-3"
              data-testid="publication-grid"
            >
              {visible.map((entry) => (
                <PublicationCard
                  key={entry.id}
                  entry={entry}
                  product={entry.productId ? (productById.get(entry.productId) ?? null) : null}
                  text={p}
                  soldOutLabel={t(ui.buttons.soldOut)}
                  addToCartLabel={t(ui.buttons.addToCart)}
                  viewProductLabel={t(ui.buttons.viewProduct)}
                />
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}

/** 分頁自己的小標題。整頁的 h1 是「選物」，這裡是 h2。 */
export function PanelIntro({ title, intro }: { title: string; intro: string }) {
  return (
    <section className="container-editorial pb-12">
      <h2 className="display text-3xl md:text-4xl max-w-3xl">{title}</h2>
      <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground">{intro}</p>
    </section>
  );
}

type CardProps = {
  entry: PublicationListEntry;
  product: ShopProductCard | null;
  text: ReturnType<typeof pageText>;
  soldOutLabel: string;
  addToCartLabel: string;
  viewProductLabel: string;
};

function PublicationCard({
  entry,
  product,
  text,
  soldOutLabel,
  addToCartLabel,
  viewProductLabel,
}: CardProps) {
  const t = useT();
  const addItem = useCart((s) => s.addItem);
  const soldOut = product !== null && isSoldOut(product);
  const remaining = product ? remainingFor(product) : null;
  const low = !soldOut && remaining !== null && remaining > 0 && remaining <= LOW_STOCK_THRESHOLD;

  function handleAdd() {
    if (!product) return;
    // 刊物展賣的是書，所以這裡永遠是 goods/book。萬一有人把某一本的 product_id
    // 指到活動商品，加進購物車會產生一行沒有 sessionId 的 booking —— 結帳會拒收
    // 它，而客人看到的是一句籠統的失敗。寧可在這裡什麼都不做，讓他走商品頁選場次。
    if (product.productType === "event" || product.productType === "journey") return;
    const result = addItem(cartInputFor(product, 1));
    if (result === "added") toast.success(t(text.block("addedToast", COPY.addedToast)));
    else if (result === "capped") toast.warning(t(text.block("cappedToast", COPY.cappedToast)));
    else toast.error(t(text.block("soldOutToast", COPY.soldOutToast)));
  }

  // 卡片外框用前台共用的 CARD（src/lib/feature-layout.ts），但不加 CARD_HOVER：
  // 整張卡不是一個連結（裡面還有購買鈕，連結不能包按鈕）。封面、刊名、「刊物介紹 →」
  // 各自連到 /publications/$slug。
  return (
    <article
      id={entry.slug}
      data-testid="publication-card"
      data-slug={entry.slug}
      data-purchasable={product !== null && !soldOut ? "yes" : "no"}
      className={`${CARD} scroll-mt-24`}
    >
      {/* 封面：126 張全部在同一頁，一律 lazy＋async decode，只有捲到附近才下載。
          width/height 是 4:3 的版面比例（卡片實際寬約 360px），讓瀏覽器先保留位置。
          這張連結跟下面的刊名指向同一頁，從無障礙樹拿掉、不進 tab 順序，避免同一個連結念兩次。 */}
      <Link
        to="/publications/$slug"
        params={{ slug: entry.slug }}
        tabIndex={-1}
        aria-hidden="true"
        className="block aspect-[4/3] overflow-hidden bg-muted"
      >
        <img
          src={imageFor(entry.coverImageKey, bookstoreImg)}
          alt={t(entry.title)}
          width={480}
          height={360}
          loading="lazy"
          decoding="async"
          className={`h-full w-full object-contain ${soldOut ? "opacity-60" : ""}`}
        />
      </Link>

      <div className="flex flex-1 flex-col p-5 md:p-6">
        <p className="eyebrow text-sm tracking-widest">
          {entry.region || t(SHEET_LABELS[entry.sheet])}
        </p>
        <h3 className="font-serif text-xl mt-3 leading-snug">
          <Link
            to="/publications/$slug"
            params={{ slug: entry.slug }}
            data-testid="publication-link"
            className="hover-underline"
          >
            {t(entry.title)}
          </Link>
        </h3>
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="opacity-70">{t(text.block("publisherLabel", COPY.publisherLabel))}</span>{" "}
          {t(entry.publisher)}
        </p>
        {entry.issues && (
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="opacity-70">{t(text.block("issuesLabel", COPY.issuesLabel))}</span>{" "}
            {entry.issues}
          </p>
        )}

        <Link
          to="/publications/$slug"
          params={{ slug: entry.slug }}
          className="mt-5 self-start text-xs tracking-widest text-clay hover-underline"
        >
          {t(text.block("readMore", COPY.readMore))} →
        </Link>

        <div className="mt-auto pt-6">
          {product === null ? (
            <StockBadge>{t(text.block("displayOnly", COPY.displayOnly))}</StockBadge>
          ) : (
            <>
              <PriceTag price={product.price} compareAtPrice={product.compareAtPrice} />
              {low && (
                <div className="mt-3">
                  <StockBadge>
                    {t(text.block("lowStock", COPY.lowStock))} {remaining}{" "}
                    {t(text.block("lowStockUnit", COPY.lowStockUnit))}
                  </StockBadge>
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={soldOut}
                  data-testid="add-to-cart"
                  className="border border-foreground bg-foreground px-5 py-2.5 text-sm tracking-widest text-primary-foreground transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100"
                >
                  {soldOut ? soldOutLabel : addToCartLabel}
                </button>
                <Link
                  to="/shop/$slug"
                  params={{ slug: product.slug }}
                  className="text-xs tracking-widest text-muted-foreground hover-underline hover:text-foreground"
                >
                  {viewProductLabel}
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
