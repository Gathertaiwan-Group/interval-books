/**
 * 「選物」〈商品〉分頁最上方的品類入口（2026-11 手機版優化）。
 *
 * 為什麼要有：線上能結帳的 19 件目前全是書刊，手機首屏如果只看到書，客人會以為這裡
 * 只是一間賣書的店。實際上店裡還有 126 本地方刊物展、主理人的三個主題櫥窗、活動與策旅。
 * 這一列把這些入口放到首屏，作法參考 Uniqlo／無印良品手機版的「品類入口」：一排可橫滑
 * 的圖卡，每張寫清楚類別名稱與一句「這裡有什麼、能不能線上買」。
 *
 * ⚠️ 只是入口，不是商品。卡片一律連到各自的頁面／分頁，不在這裡放價格或購物車——
 *    與 shop.index.tsx 檔頭「分頁的意義就是讓『這個能買、那個不能』看得出來」同一條線。
 *    所以每張卡的副標都老實寫出「可線上購買」或「到店翻閱／詢問」。
 *
 * 資料全由 props 帶進來（來源是 shop.index.tsx 的 loader），這個檔案不讀資料庫。
 */
import { Link } from "@tanstack/react-router";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import type { CuratedThemeEntry } from "@/lib/cms";
import exhibitionThumb from "@/assets/responsive/exhibition-corner-360.jpg";
import curatedThumb from "@/assets/responsive/curated-objects-360.jpg";
import eventThumb from "@/assets/responsive/event-reading-360.jpg";
import journeyThumb from "@/assets/responsive/journey-mist-360.jpg";

const COPY = {
  heading: { zh: "逛逛店裡的選物", en: "Browse the shop", ja: "店内のセレクトを見る" },
  alsoInStore: { zh: "店裡也有", en: "Also in store", ja: "店頭には" },
  books: { zh: "書刊", en: "Books & zines", ja: "本と冊子" },
  booksSub: { zh: "本可線上購買", en: "to buy online", ja: "冊をオンラインで" },
  publications: { zh: "地方刊物展", en: "Local publications", ja: "地域の刊行物" },
  publicationsSub: { zh: "本・到店翻閱", en: "titles · browse in store", ja: "冊・店頭で" },
  curated: { zh: "主理人的選品", en: "Curated goods", ja: "店主の選品" },
  curatedSubFallback: { zh: "器物・茶・風土", en: "Vessels, tea, terroir", ja: "器・茶・風土" },
  events: { zh: "活動", en: "Events", ja: "イベント" },
  eventsSub: { zh: "讀書會與講座", en: "Readings & talks", ja: "読書会と講座" },
  journeys: { zh: "策旅", en: "Journeys", ja: "旅" },
  journeysSub: { zh: "跟著主理人走地方", en: "Travel with the owner", ja: "店主と土地を歩く" },
} satisfies Record<string, Localized>;

type Entry = {
  key: string;
  title: string;
  sub: string;
  img: string;
  /** 書刊那一格捲到下方清單；其他連到各自的頁面。 */
  to: "#product-grid" | "/publications" | "/shop" | "/events" | "/journeys";
};

const CARD_CLASS =
  "group flex w-[6.5rem] shrink-0 snap-start flex-col md:w-auto focus-visible:outline-2 focus-visible:outline-offset-2";

export function ShopCategoryStrip({
  bookCount,
  bookCover,
  publicationCount,
  curatedThemes,
}: {
  bookCount: number;
  bookCover: string;
  publicationCount: number;
  curatedThemes: CuratedThemeEntry[];
}) {
  const t = useT();
  const curatedSub =
    curatedThemes.length > 0
      ? curatedThemes.map((theme) => t(theme.title)).join("・")
      : t(COPY.curatedSubFallback);

  // 順序刻意把「主理人的選品」放第一張：首屏第一眼要先看到「不只賣書」。
  const entries: Entry[] = [
    {
      key: "curated",
      title: t(COPY.curated),
      sub: curatedSub,
      img: curatedThumb,
      to: "/shop" as const,
    },
    ...(bookCount > 0
      ? [
          {
            key: "books",
            title: t(COPY.books),
            sub: `${bookCount} ${t(COPY.booksSub)}`,
            img: bookCover,
            to: "#product-grid" as const,
          },
        ]
      : []),
    ...(publicationCount > 0
      ? [
          {
            key: "publications",
            title: t(COPY.publications),
            sub: `${publicationCount} ${t(COPY.publicationsSub)}`,
            img: exhibitionThumb,
            to: "/publications" as const,
          },
        ]
      : []),
    {
      key: "events",
      title: t(COPY.events),
      sub: t(COPY.eventsSub),
      img: eventThumb,
      to: "/events",
    },
    {
      key: "journeys",
      title: t(COPY.journeys),
      sub: t(COPY.journeysSub),
      img: journeyThumb,
      to: "/journeys",
    },
  ];

  // 「店裡也有」：每個主題輪流挑一件，最多 8 件，讓首屏直接看到器物、茶、風土的實際品名。
  // 這些大多買不到（curated_items 多半沒連商品），所以整列連到〈主理人的選品〉分頁，不放價格。
  const samples: string[] = [];
  for (let i = 0; samples.length < 8; i++) {
    const row = curatedThemes.map((theme) => theme.items[i]).filter(Boolean);
    if (row.length === 0) break;
    for (const item of row) if (samples.length < 8) samples.push(t(item.name));
  }

  const body = (entry: Entry) => (
    <>
      <span className="block aspect-square overflow-hidden bg-muted">
        <img
          src={entry.img}
          alt=""
          width={360}
          height={360}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          loading="eager"
          decoding="async"
        />
      </span>
      <span className="mt-2 block font-serif text-[0.95rem] leading-snug text-foreground group-hover:underline underline-offset-4">
        {entry.title}
      </span>
      <span className="mt-0.5 block text-[0.7rem] leading-snug text-muted-foreground line-clamp-2">
        {entry.sub}
      </span>
    </>
  );

  return (
    <section
      className="container-editorial pb-8 md:pb-12"
      data-testid="shop-category-strip"
      aria-label={t(COPY.heading)}
    >
      <h2 className="eyebrow mb-3 md:mb-5">{t(COPY.heading)}</h2>
      {/* 手機：橫向滑動＋snap，右邊露出半張提示還有更多；md 以上：一排五格。
          -mx/px 讓卡片可以滑到螢幕邊緣，不被 container 的內距切掉。 */}
      <ul className="-mx-6 flex snap-x snap-mandatory scroll-px-6 gap-3 overflow-x-auto px-6 pb-2 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-5 md:scroll-px-0 md:gap-6 md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden">
        {entries.map((entry) => (
          <li key={entry.key} className="contents">
            {entry.to === "#product-grid" ? (
              <a
                href="#product-grid"
                className={CARD_CLASS}
                data-testid={`shop-category-${entry.key}`}
              >
                {body(entry)}
              </a>
            ) : entry.to === "/shop" ? (
              <Link
                to="/shop"
                search={{ tab: "curated" }}
                className={CARD_CLASS}
                data-testid={`shop-category-${entry.key}`}
              >
                {body(entry)}
              </Link>
            ) : (
              <Link to={entry.to} className={CARD_CLASS} data-testid={`shop-category-${entry.key}`}>
                {body(entry)}
              </Link>
            )}
          </li>
        ))}
      </ul>
      {samples.length > 0 && (
        <Link
          to="/shop"
          search={{ tab: "curated" }}
          className="-mx-6 mt-3 flex items-center gap-2 overflow-x-auto px-6 py-1 text-xs [scrollbar-width:none] md:mx-0 md:mt-5 md:flex-wrap md:px-0 [&::-webkit-scrollbar]:hidden"
          data-testid="shop-category-samples"
        >
          <span className="shrink-0 text-muted-foreground">{t(COPY.alsoInStore)}</span>
          {samples.map((name) => (
            <span
              key={name}
              className="shrink-0 rounded-full border border-border bg-card/70 px-3 py-1.5 text-foreground/80"
            >
              {name}
            </span>
          ))}
        </Link>
      )}
    </section>
  );
}
