import { createFileRoute, Link } from "@tanstack/react-router";
import { journeyKicker } from "@/lib/journey-events";
import type { ReactNode } from "react";
import { PageShell } from "@/components/PageShell";
import { CoverImage } from "@/components/CoverImage";
import { PastShelf } from "@/components/PastShelf";
import { HomeProductShelf } from "@/components/shop/HomeProductShelf";
import { useLocalizeHref, useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchEvents, fetchJourneyEventDates, fetchJourneys, fetchPage, pageText } from "@/lib/cms";
import { useSiteContent } from "@/lib/site-content";
import { isEventPast } from "@/lib/event-status";
import { CARD, CARD_HOVER, featureLayout } from "@/lib/feature-layout";
import { imageFor, srcSetFor } from "@/lib/images";
import { eventProductSlug, fetchHomeShelfProducts } from "@/lib/shop";
import { fetchListingFacts, listingFactsForCard } from "@/lib/home-listing";
import { ListingBadge, ListingDate, ListingFooter } from "@/components/ListingBits";
import { fetchPublicationsTeaser } from "@/lib/publications";
import heroImg from "@/assets/hero-mountain.jpg";
import storefrontImg from "@/assets/storefront.jpg";
import curatedImg from "@/assets/curated-objects.jpg";
import journeyImg from "@/assets/journey-mist.jpg";
import bookstoreImg from "@/assets/bookstore-interior.jpg";
import eventReadingImg from "@/assets/event-reading.jpg";
import exhibitionImg from "@/assets/exhibition-corner.jpg";
import { journeyLinkProps } from "@/lib/journey-link";
import { fitDescription } from "@/lib/seo/core";
import { splitAtComma } from "@/lib/title-break";
import { pageHead } from "@/lib/seo/head";
import { pageRowTranslation } from "@/lib/seo/pages";
import { linkedEventFor, newestEndedFirst, splitJourneys } from "@/lib/past-shelf";
import { fetchCalendarEntries } from "@/lib/events-calendar-data";
import { nextStartBySlug, sortByNextStart } from "@/lib/upcoming-order";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE_META = {
  title: {
    zh: "小時光書店 Interval Books｜華山的風土誌選書與地方刊物",
    en: "Interval Books｜A bookstore of place in Huashan, Taipei",
    ja: "小時光書店 Interval Books｜華山で地域誌と出会う書店",
  },
  /**
   * 首頁的搜尋結果描述（2026-11 SEO 健檢 M2）。
   *
   * 2026-11 首頁改版上線時，pages/'index' 的 meta_description 已從佔位句「留一段屬於自己的
   * ＿＿＿小時光。」改成與這裡相同的定位描述；這一段只在 DB 讀不到（或又被改回佔位符，
   * fitDescription() 會偵測）時才用。
   */
  description: {
    zh: "從一份地方刊物，讀懂一片土地。小時光書店位在台北華山文創園區紅磚六合院，是一間以風土誌選書的書店，典藏台灣各地的地方刊物，舉辦讀書會、講座與工作坊，也帶你走進各地的文化策旅。",
    en: "Read a place through its local publications. Interval Books at Huashan 1914: books chosen by the land, local magazines from across Taiwan, talks and journeys.",
    ja: "一冊の地域誌から、ひとつの土地を読む。台北・華山1914文化創意産業園区の小時光書店は、風土誌を軸に本を選ぶ書店。台湾各地の地域誌を所蔵し、読書会やトーク、各地への旅も企画しています。",
  },
};

const HERO = {
  eyebrow: {
    zh: "Interval Books  ／  Est.",
    en: "Interval Books  ／  Est.",
    ja: "Interval Books  ／  Est.",
  },
  titleMain: { zh: "小時光書店", en: "Interval Books", ja: "小時光書店" },
  titleSub: {
    zh: "留一點時間給真正重要的事",
    en: "Save a little time for what truly matters.",
    ja: "本当に大切なことに、少しの時間を。",
  },
  intro: {
    zh: "留一段屬於自己的＿＿＿小時光。",
    en: "Keep an interval that belongs only to you.",
    ja: "あなただけの小さな時間を、ひとつ。",
  },
};

/**
 * 2026-11 首頁改版的新文案。
 *
 * 全部走 p.block("home.*", 這裡的預設值)：pages/'index' 目前**沒有**這些 key，所以畫面上
 * 就是這裡的字；之後在 DB 補上同名 block，後台就能改字，不用動程式。
 * 舊的 hero.titleSub（留一點時間給真正重要的事）與 hero.intro（留一段屬於自己的＿＿＿小時光）
 * 繼續沿用 DB 那兩格——前者 2026-11-10 起不在首屏印出、只當 og:title 預設值，後者 2026-11-10 起搬到 /about 的「店名的由來」（IntervalCoda）。
 *
 * ⚠️ 英文與日文是改版提案，待業主確認。
 */
const HOME = {
  place: {
    zh: "華山紅磚六合院 西7-3館",
    en: "Huashan Red Brick Courtyard, West 7-3",
    ja: "華山・紅煉瓦六合院 西7-3館",
  },
  /** 首屏大標（2026-11-10 業主指定）。逗號後換行由 splitAtComma 處理，這裡不放 \n。 */
  headline: {
    zh: "以書店為載體，讓更多人認識台灣的美好。",
    en: "A bookstore as a vessel, sharing the good things of Taiwan.",
    ja: "本屋を器に、台湾の素晴らしさを届ける。",
  },
  heroInsetAlt: {
    zh: "書店裡攤開在木桌上的台灣與日本地方刊物",
    en: "Local publications from Taiwan and Japan laid out on wooden tables in the store",
    ja: "店内の木の台に並ぶ、台湾と日本の地域刊行物",
  },
  heroCaption: {
    zh: "華山 1914 文創園區，紅磚六合院西 7-3 館。",
    en: "Huashan 1914 Creative Park, Red Brick Courtyard, West 7-3.",
    ja: "華山1914文化創意産業園区、紅煉瓦六合院 西7-3館。",
  },
  pillarsKicker: { zh: "我們做的事", en: "What we do", ja: "私たちのこと" },
  pillarsTitle: {
    zh: "讀懂一片土地，有三種方式。",
    en: "Three ways to read a place.",
    ja: "土地を読む、三つの方法。",
  },
  readChar: { zh: "讀", en: "Read", ja: "読" },
  readTitle: { zh: "選書與地方刊物", en: "Books & local publications", ja: "選書と地域の刊行物" },
  readBody: {
    zh: "以風土為線索選書。地方刊物多由當地人自己編寫，記下文史、產業與日常——是一個地方寫給自己的信。",
    en: "Books chosen by the land they come from. Local publications are mostly written by the people who live there — a place writing a letter to itself.",
    ja: "風土を手がかりに本を選びます。地域の刊行物の多くは、そこに暮らす人が自ら編んだもの。土地が自分にあてた手紙です。",
  },
  readCta: { zh: "逛選書與選物", en: "Browse the shelves", ja: "選書とセレクトを見る" },
  gatherChar: { zh: "聚", en: "Gather", ja: "集" },
  gatherTitle: {
    zh: "讀書會、講座與作家活動",
    en: "Reading circles, talks & authors",
    ja: "読書会・トーク・作家の会",
  },
  gatherBody: {
    zh: "每月一場讀書會，不定期的講座、作家分享與手作工作坊。一張長桌，讓讀過的書被好好說出來。",
    en: "A reading circle every month, plus talks, author evenings and hands-on workshops. One long table, where the books we read get talked through.",
    ja: "毎月の読書会に、不定期のトーク、作家の会、手しごとのワークショップ。長いテーブルひとつで、読んだ本をゆっくり語り合います。",
  },
  gatherCta: { zh: "看活動", en: "See events", ja: "イベントを見る" },
  goChar: { zh: "行", en: "Go", ja: "行" },
  goTitle: { zh: "走進土地的策旅", en: "Journeys into the land", ja: "土地へ歩み入る旅" },
  goBody: {
    zh: "跟著書與作者走出書店，到故事發生的地方——一座教堂、一片稻田、一條老街。每一趟策旅，都是把書讀到現場。",
    en: "We follow books and their authors out of the shop to the places they describe — a chapel, a rice field, an old street. Every journey is a way of reading on site.",
    ja: "本と作家に導かれて書店を出て、物語の舞台へ——教会、田んぼ、古い街並み。どの旅も、本を現地で読むためのものです。",
  },
  goCta: { zh: "看策旅", en: "See journeys", ja: "旅を見る" },
  imgReadAlt: {
    zh: "小時光書店店內，紅磚牆下的書架與平台",
    en: "Inside Interval Books: shelves and tables under red brick walls",
    ja: "小時光書店の店内。紅煉瓦の壁の下の書棚と平台",
  },
  imgGatherAlt: {
    zh: "兩位讀者在書店裡一起翻讀一本書",
    en: "Two readers sharing a book in the store",
    ja: "店内で一冊の本を一緒に読む二人",
  },
  imgGoAlt: {
    zh: "策旅途中，旅人在台東的草地與山景前合影",
    en: "Travellers posing for a photo on a Taitung meadow during a journey",
    ja: "旅の途中、台東の草原と山を背に記念撮影する参加者",
  },

  upcomingKicker: { zh: "近期", en: "Upcoming", ja: "近日" },
  upcomingTitle: {
    zh: "近期活動與策旅",
    en: "Upcoming events & journeys",
    ja: "近日のイベントと旅",
  },
  upcomingEmpty: {
    zh: "下一場活動還在安排中。歡迎先來店裡坐坐，或到活動頁看看我們辦過什麼。",
    en: "The next gathering is still being planned. Drop by the store, or see what we have hosted before.",
    ja: "次の催しは準備中です。まずはお店へ、またはこれまでのイベントをご覧ください。",
  },
  upcomingEventsLabel: { zh: "活動", en: "Events", ja: "イベント" },
  upcomingJourneysLabel: { zh: "策旅", en: "Journeys", ja: "旅" },
  /** 手機橫滑卡片列底下的提示。{n} = 這一列幾張。 */
  railHint: {
    zh: "共 {n} 則，左右滑動看更多",
    en: "{n} in total — swipe for more",
    ja: "全{n}件・横にスワイプ",
  },

  archiveKicker: {
    zh: "地方刊物典藏",
    en: "Local publications archive",
    ja: "地域刊行物アーカイブ",
  },
  archiveUnit: { zh: "份地方刊物", en: "local publications", ja: "冊の地域刊行物" },
  archiveSplit: {
    zh: "台灣 {tw}．日本 {jp}",
    en: "Taiwan {tw} · Japan {jp}",
    ja: "台湾 {tw}・日本 {jp}",
  },
  archiveTitle: {
    zh: "一個地方，怎麼被自己的人寫下來。",
    en: "How a place gets written down by its own people.",
    ja: "その土地の人が、その土地を書く。",
  },
  archiveBody: {
    zh: "從基隆的漁村到花蓮的溪流，這些刊物多半不是為了賣而做的，是為了留下來。大部分只在店裡展示，歡迎來翻。",
    en: "From a Keelung fishing village to a Hualien river, most of these were not made to be sold — they were made to remain. Most are on display in the store only; come and leaf through them.",
    ja: "基隆の漁村から花蓮の川まで。その多くは売るためではなく、遺すためにつくられました。ほとんどは店頭展示のみ。どうぞ手に取ってご覧ください。",
  },
  archiveCta: { zh: "翻閱刊物目錄", en: "Browse the archive", ja: "所蔵リストを見る" },
  archiveCoverLabel: {
    zh: "{title}（{region}）",
    en: "{title} ({region})",
    ja: "{title}（{region}）",
  },

  pastKicker: { zh: "回顧", en: "Looking back", ja: "これまで" },
  pastTitle: { zh: "在這裡發生過的事", en: "What has happened here", ja: "ここで起きたこと" },
  pastBadge: { zh: "已結束", en: "Past", ja: "終了" },
  pastCta: { zh: "看所有過往活動", en: "All past events", ja: "過去のイベントをすべて見る" },

  visitTitle: { zh: "來小時光坐坐", en: "Come and sit a while", ja: "小時光で、ひと休み" },
  visitTransit: {
    zh: "捷運板南線忠孝新生站 1 號出口，步行約 3 分鐘；穿過紅磚六合院中庭，西側第三間。",
    en: "MRT Zhongxiao Xinsheng Station, Exit 1 — about 3 minutes on foot. Cross the Red Brick Courtyard; we are the third door on the west side.",
    ja: "MRT板南線・忠孝新生駅1番出口から徒歩約3分。紅煉瓦六合院の中庭を抜け、西側の三軒目です。",
  },
  visitHoursLabel: { zh: "營業時間", en: "Hours", ja: "営業時間" },
  visitWhereLabel: { zh: "地址", en: "Address", ja: "所在地" },
  visitHowLabel: { zh: "交通", en: "Getting here", ja: "アクセス" },
};

const ENTRIES = {
  curatedTitle: {
    zh: "一本好書，一份心意，\n風帶不走了，都留在美好的人情連結裡。",
    en: "A window, not a shelf.",
    ja: "棚ではなく、窓辺に。",
  },
  curatedBody: {
    zh: "關於這片土地的故事\n地方風土、器物與陶、茶與日常。\n都是被留下來的緩慢時間。",
    en: "Three themes, dozens of pieces — place, vessels, tea. Each one a quiet pause held in form.",
    ja: "三つのテーマ、数十の品. 土地, 器, 茶. それぞれが、留め置かれた緩やかな時間。",
  },
  curatedCta: { zh: "走進選品櫥窗", en: "Enter the window", ja: "選品の窓辺へ" },
  visitFull: { zh: "完整來訪資訊", en: "Full visit info", ja: "ご案内" },
};

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

export const Route = createFileRoute("/")({
  loader: async () => {
    // shelf：「主理人的選品」那一排商品卡，跟其他讀取平行，不多一段等待。
    // journeyEvents：策旅卡片指著的那幾列 events（日期＋最晚場次＋封面），用來判斷
    // 「已結束」與決定卡片封面——與 /events 策旅卡同一支查詢、同一套判準。
    // archive：「地方刊物典藏」區塊的份數與幾張封面（2026-11 改版，只聚合後的數字進 payload）。
    // listing：活動／策旅卡片上的票價與「額滿／最後 N 位」（見 src/lib/home-listing.ts），
    // 讀不到就是空物件，卡片只是不印那一行。
    // calendar：每場活動「下一個尚未結束的場次」開始時間，近期活動與策旅由近到遠排
    // （2026-11-10 業主：「活動都是先顯示日期最近的」；規則見 src/lib/upcoming-order.ts）。
    // 與 /events 月曆同一支（含包場場次）；只把算好的 slug → 時間放進 payload，不帶整份條目。
    const [page, events, journeys, journeyEvents, shelf, archive, listing, calendar] =
      await Promise.all([
        fetchPage("index"),
        fetchEvents(),
        fetchJourneys(),
        fetchJourneyEventDates(),
        fetchHomeShelfProducts(4),
        fetchPublicationsTeaser(),
        fetchListingFacts(),
        fetchCalendarEntries(Date.now()),
      ]);
    const nextStarts = Object.fromEntries(nextStartBySlug(calendar.entries));
    return { page, events, journeys, journeyEvents, shelf, archive, listing, nextStarts };
  },
  head: ({ loaderData, matches, match }) => {
    const p = pageText(loaderData?.page ?? null);
    const ogImg = imageFor(loaderData?.page?.ogImageKey, heroImg);
    return {
      ...pageHead(
        { matches, match },
        {
          translation: pageRowTranslation(loaderData?.page ?? null),
          title: p.metaTitle(PAGE_META.title),
          description: fitDescription(p.metaDescription(HERO.intro), PAGE_META.description),
          ogTitle: p.ogTitle(HERO.titleSub),
          image: ogImg,
          type: "website",
        },
      ),
    };
  },
  component: Index,
});

function Index() {
  const t = useT();
  const localizeHref = useLocalizeHref();
  const { page, events, journeys, journeyEvents, shelf, archive, listing, nextStarts } =
    Route.useLoaderData();
  const shelfProducts = shelf.products;

  // 策旅與活動用同一種卡片、同一套版面規則（見 featureLayout），所以這裡也
  // 取到三筆，而不是像以前那樣只挑一筆做成橫幅。
  //
  // 已結束的策旅不放精選（2026-10-29 業主：池上那趟 10 月就辦完了還掛在首頁）。判準
  // 與 /events 的策旅一模一樣：splitJourneys()（src/lib/past-shelf.ts）＝卡片指著的那場活動
  // 最後一個場次已結束（台北時間）。結束的只出現在下方「回顧」與 /events 的過往卡片區。
  // 今天的日期在每次 render 時才取（splitJourneys 的預設參數），不是 build 時寫死。
  // 由近到遠（下一個尚未結束的場次），先排序再取前三（src/lib/upcoming-order.ts）。
  const featuredJourneys = sortByNextStart(
    splitJourneys(journeys, journeyEvents).open,
    (j) => nextStarts[linkedEventFor(j.externalUrl, journeyEvents)?.slug ?? ""],
  ).slice(0, 3);
  const endedJourneys = splitJourneys(journeys, journeyEvents).ended.slice(0, 2);
  // 🔴 一趟策旅在資料上是**兩列**（events 負責內頁與報名、journeys 負責策旅區卡片）。
  //    fetchEvents() 已經在資料層把**所有**策旅的那一列濾掉（見 src/lib/journey-events.ts），
  //    所以這裡的 events 只有一般活動，同一趟旅程不會在首頁出現兩次。
  // 首頁不放已結束的活動 —— 「近期活動」印一場去年辦完的講座沒有意義。
  // 已結束的活動只出現在下方「回顧」（最近結束的幾場）與 /events 的「已結束」那一格。
  // 由近到遠（下一個尚未結束的場次；包場一樣算；沒有場次時間的排最後），先排序再取前三。
  const featuredEvents = sortByNextStart(
    events.filter((e) => !isEventPast(e)),
    (e) => nextStarts[e.slug],
  ).slice(0, 3);
  const pastEvents = newestEndedFirst(events, 6 - endedJourneys.length);
  const eventsLayout = featureLayout(featuredEvents.length);
  const journeysLayout = featureLayout(featuredJourneys.length);
  const p = pageText(page);
  const { ui, site, map } = useSiteContent();
  const heroSrc = imageFor(page?.ogImageKey, heroImg);
  const counts = archive.counts;

  useDocumentMeta({
    title: p.metaTitle(PAGE_META.title),
    description: fitDescription(p.metaDescription(HERO.intro), PAGE_META.description),
    ogTitle: p.ogTitle(HERO.titleSub),
    ogImage: heroSrc,
  });

  const pillars = [
    {
      key: "read",
      no: "01",
      char: t(p.block("home.readChar", HOME.readChar)),
      title: t(p.block("home.readTitle", HOME.readTitle)),
      body: t(p.block("home.readBody", HOME.readBody)),
      cta: t(p.block("home.readCta", HOME.readCta)),
      img: bookstoreImg,
      alt: t(HOME.imgReadAlt),
      to: "/shop" as const,
      type: undefined,
    },
    {
      key: "gather",
      no: "02",
      char: t(p.block("home.gatherChar", HOME.gatherChar)),
      title: t(p.block("home.gatherTitle", HOME.gatherTitle)),
      body: t(p.block("home.gatherBody", HOME.gatherBody)),
      cta: t(p.block("home.gatherCta", HOME.gatherCta)),
      img: eventReadingImg,
      alt: t(HOME.imgGatherAlt),
      to: "/events" as const,
      // 2026-11-10 /events 與 /journeys 合併：「聚」落在只看活動的篩選，「行」落在只看策旅。
      type: "event" as const,
    },
    {
      key: "go",
      no: "03",
      char: t(p.block("home.goChar", HOME.goChar)),
      title: t(p.block("home.goTitle", HOME.goTitle)),
      body: t(p.block("home.goBody", HOME.goBody)),
      cta: t(p.block("home.goCta", HOME.goCta)),
      img: journeyImg,
      alt: t(HOME.imgGoAlt),
      to: "/events" as const,
      type: "journey" as const,
    },
  ];

  const hasUpcoming = featuredEvents.length > 0 || featuredJourneys.length > 0;

  return (
    <PageShell>
      {/* ── Hero ────────────────────────────────────────────────────────────
          2026-11-10 業主精簡：一句話讀懂定位——地點 eyebrow＋定位句大標＋首圖。
          拿掉小字店名、說明段落、兩顆按鈕與「留一點時間給真正重要的事」斜體句
          （那句仍是 hero.titleSub，繼續當 og:title 的預設值，只是不在首屏印出）。
          h1 仍是全頁唯一的 h1；店名只給螢幕閱讀器與搜尋引擎（sr-only），畫面上不重複。
          大標在逗號後換行：splitAtComma（src/lib/title-break.ts）切兩段各包 inline-block，
          寬度不夠時只會在逗號後斷，不會斷在詞中間；三語同一套。
          字級依「逗號後那一段（中文 12 字）在一行放得下」來定：手機 7.2vw（375 寬約 27px×12＜327px），
          lg／xl 兩欄時以日文逗號後 13 字放得下為準 → 2.05rem／2.5rem；手機上日文第二段 13 字，另以 :lang(ja) 縮到 6.4vw。 */}
      <section className="container-editorial pt-10 md:pt-16 pb-16 md:pb-20">
        <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-6">
            <p className="kicker">{t(p.block("home.place", HOME.place))}</p>
            <h1 className="mt-6 md:mt-8">
              <span className="sr-only">{t(p.block("hero.titleMain", HERO.titleMain))}｜</span>
              <span className="display block text-[clamp(1.5rem,7.2vw,3rem)] leading-[1.3] max-md:[:lang(ja)_&]:text-[6.4vw] lg:text-[2.05rem] xl:text-[2.5rem]">
                {splitAtComma(t(p.block("home.headline", HOME.headline))).map((part, i) => (
                  <span key={i} className="inline-block">
                    {part}
                  </span>
                ))}
              </span>
            </h1>
          </div>

          <figure className="lg:col-span-6">
            <div className="relative">
              <div className="relative aspect-[4/3] overflow-hidden bg-muted lg:aspect-[5/4]">
                {/* 首屏大圖（LCP）：WebP 多尺寸 srcset，JPG 留作 src 退路（2026-11 SEO 健檢 M5）。
                    width/height 是原圖真實尺寸 1536×864；外框由 aspect 決定，不影響版面。
                    React 依 fetchPriority＋srcSet 在 <head> 自動輸出 preload。 */}
                <img
                  src={heroSrc}
                  srcSet={srcSetFor(heroSrc)}
                  sizes="(min-width: 1024px) 50vw, 100vw"
                  alt={t(p.block("hero.titleMain", HERO.titleMain))}
                  className="absolute inset-0 h-full w-full object-cover"
                  width={1536}
                  height={864}
                  fetchPriority="high"
                />
              </div>
              {/* 疊在角落的第二張：店裡攤開的地方刊物——讓「書店」與「刊物」在首屏同時被看到。 */}
              <div className="absolute -bottom-8 -left-4 hidden w-[38%] border-[6px] border-background bg-muted shadow-[0_24px_48px_-28px_oklch(0.245_0.018_60/0.55)] sm:block lg:-left-10">
                <img
                  src={exhibitionImg}
                  alt={t(HOME.heroInsetAlt)}
                  className="aspect-[4/3] h-full w-full object-cover"
                  width={1200}
                  height={800}
                  loading="lazy"
                />
              </div>
            </div>
            <figcaption className="mt-4 text-right text-xs tracking-[0.12em] text-muted-foreground sm:mt-12">
              {t(HOME.heroCaption)}
            </figcaption>
          </figure>
        </div>

        {/* 2026-11-10 業主要求拿掉 hero 下方的「三個數字」（刊物份數／每月讀書會／台灣策旅）。
            文案原本就寫在程式裡（HOME.fact*），一併刪掉；刊物份數只留在下方「地方刊物典藏」的大數字。 */}
      </section>

      {/* ── 近期活動與策旅 ───────────────────────────────────────────────────
          2026-11-10 從「讀．聚．行」之後移到 hero 正後方：hero（店名、定位句、首圖）
          已經把「這是哪裡、在做什麼」講完，支柱區是同一段敘事的展開，可以晚一點讀；
          活動與策旅才是有時效、要報名的東西，手機上原本要滑過支柱區近 2000px 才看得到。
          已結束的不顯示（活動 isEventPast、策旅 splitJourneys）。兩邊都沒有時留一句話與入口，
          不讓整區消失——「有在辦活動」是這間店的核心。
          手機版：兩筆以上排成可橫滑的卡片列（露出下一張一截＋一行提示），桌機維持 featureLayout。 */}
      <section
        id="upcoming"
        className="scroll-mt-24 border-t border-border"
        aria-labelledby="home-upcoming"
      >
        <div className="container-editorial section-y max-md:py-12">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="kicker">{t(p.block("home.upcomingKicker", HOME.upcomingKicker))}</p>
              <h2 id="home-upcoming" className="display mt-4 text-3xl md:mt-5 md:text-5xl">
                {t(p.block("home.upcomingTitle", HOME.upcomingTitle))}
              </h2>
            </div>
          </div>

          {!hasUpcoming ? (
            <div className="mt-12 border border-border bg-card/70 p-8 md:p-10">
              <p className="max-w-xl leading-[1.9] text-foreground/80">
                {t(p.block("home.upcomingEmpty", HOME.upcomingEmpty))}
              </p>
              <Link to="/events" className="link-arrow mt-6 min-h-11 text-sm">
                {t(ui.buttons.viewAll)}
                <span className="arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            </div>
          ) : null}

          {/* 精選活動 —— 沒有任何一場就整組（含小標與「查看全部」）不出現 */}
          {featuredEvents.length > 0 && (
            <>
              <SubHeader
                label={t(p.block("home.upcomingEventsLabel", HOME.upcomingEventsLabel))}
                link={{ type: "event", label: t(ui.buttons.viewAll) }}
              />
              {/* ⚠️ 這裡連的是**站內**的 /events/$slug，不是 e.externalUrl。
                  0001 的種子資料把 externalUrl 填成 https://example.com/event-N，首頁曾經
                  有三顆按鈕直接把客人送去 example.com（那批 ev-1~ev-6 已於 2026-09-12 連同
                  content.ts 與 seed.sql 裡的副本一起清掉）。規則不變：活動詳情頁才是正確的
                  目的地，外部售票連結留在詳情頁上，由那一頁自己決定要不要顯示。 */}
              <div
                data-home-events
                className={`${eventsLayout.grid} ${railFor(featuredEvents.length).track}`}
              >
                {featuredEvents.map((e) => (
                  <Link
                    key={e.id}
                    to="/events/$slug"
                    params={{ slug: e.slug }}
                    className={`${CARD} ${CARD_HOVER} ${eventsLayout.card} ${railFor(featuredEvents.length).item}`}
                  >
                    {/* ⚠️ 先判斷 imageKey 非空**再**呼叫 imageFor()。imageFor(key, fallback)
                        永遠會回一張圖，順序反過來就是每一張卡片都長同一張不相干的照片。 */}
                    {e.imageKey ? (
                      <CoverImage
                        src={imageFor(e.imageKey, storefrontImg)}
                        alt={t(e.title)}
                        loading="lazy"
                        className={`aspect-[4/3] ${eventsLayout.image}`}
                        imgClassName="img-zoom"
                      />
                    ) : null}
                    <div className={`flex flex-1 flex-col p-5 md:p-7 ${eventsLayout.body}`}>
                      {/* 分類字 2026-11-10 拿掉（業主：「活動分類功能都拿掉」）；只剩報名狀態小標，
                          平常不印、整行不佔高度。 */}
                      <div className="flex items-start justify-end gap-3 empty:hidden">
                        <ListingBadge
                          facts={listingFactsForCard(e, listing[eventProductSlug(e.slug)])}
                        />
                      </div>
                      <h3
                        className={`display mt-2 text-xl leading-snug md:mt-3 md:text-2xl ${eventsLayout.title}`}
                      >
                        {t(e.title)}
                      </h3>
                      <ListingDate>{e.date}</ListingDate>
                      {/* line-clamp 的段落不能自己 flex-1：被撐高後，截斷點之後的字會照樣露出來。
                          撐高的工作交給下面的空白 div（單筆橫版時同樣被 summary 的 md:flex-none 取消）。 */}
                      <p
                        className={`mt-3 line-clamp-2 text-sm leading-[1.8] text-foreground/75 md:mt-4 md:line-clamp-4 md:leading-[1.85]`}
                      >
                        {t(e.summary)}
                      </p>
                      <div aria-hidden="true" className={`flex-1 ${eventsLayout.summary}`} />
                      <ListingFooter
                        facts={listingFactsForCard(e, listing[eventProductSlug(e.slug)])}
                        cta={t(ui.buttons.viewEvent)}
                      />
                    </div>
                  </Link>
                ))}
              </div>
              <RailHint count={featuredEvents.length} />
            </>
          )}

          {/* 精選策旅 —— 沒有任何一趟就整組不出現 */}
          {featuredJourneys.length > 0 && (
            <>
              <SubHeader
                label={t(p.block("home.upcomingJourneysLabel", HOME.upcomingJourneysLabel))}
                link={{ type: "journey", label: t(ui.buttons.viewAll) }}
              />
              <div
                data-home-journeys
                className={`${journeysLayout.grid} ${railFor(featuredJourneys.length).track}`}
              >
                {featuredJourneys.map((j) => {
                  // 策旅的連結可能是站內路徑、也可能是外部網站（見 journeyLinkProps）。
                  // 還沒設連結的策旅仍然要看得到卡片，只是整張卡不可點——不要讓它消失。
                  const link = journeyLinkProps(j.externalUrl, localizeHref);
                  // 日期區間、票價與名額都在卡片指著的那場活動上（journeys 表沒有日期與價格）。
                  const linked = linkedEventFor(j.externalUrl, journeyEvents);
                  const body = (
                    <>
                      {/* journeys 表沒有 image_key；封面用卡片指著的那場活動的 events.image_key
                          （與 /journeys、過往策旅同一個來源），指不到或沒設圖才用固定意象圖。
                          手機框改 16:10 壓低高度；CoverImage 完整顯示＋模糊補邊，不會裁到字。 */}
                      <CoverImage
                        src={imageFor(
                          linkedEventFor(j.externalUrl, journeyEvents)?.imageKey,
                          journeyImg,
                        )}
                        alt={t(j.title)}
                        loading="lazy"
                        className={`aspect-[16/10] md:aspect-[4/3] ${journeysLayout.image}`}
                        imgClassName="img-zoom"
                      />
                      <div className={`flex flex-1 flex-col p-5 md:p-7 ${journeysLayout.body}`}>
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-xs tracking-[0.18em] text-clay">
                            {journeyKicker(t(j.days), t(j.theme))}
                          </p>
                          <ListingBadge
                            facts={
                              linked
                                ? listingFactsForCard(
                                    linked,
                                    listing[eventProductSlug(linked.slug)],
                                  )
                                : undefined
                            }
                          />
                        </div>
                        <h3
                          className={`display mt-2 text-xl leading-snug whitespace-pre-line md:mt-3 md:text-2xl ${journeysLayout.title}`}
                        >
                          {t(j.title)}
                        </h3>
                        {linked?.date ? <ListingDate>{linked.date}</ListingDate> : null}
                        <p
                          className={`mt-3 line-clamp-3 text-sm leading-[1.8] text-foreground/75 md:mt-4 md:line-clamp-none md:leading-[1.85]`}
                        >
                          {t(j.summary)}
                        </p>
                        <div aria-hidden="true" className={`flex-1 ${journeysLayout.summary}`} />
                        <ListingFooter
                          facts={
                            linked
                              ? listingFactsForCard(linked, listing[eventProductSlug(linked.slug)])
                              : undefined
                          }
                          cta={link ? t(ui.buttons.toJourney) : null}
                        />
                      </div>
                    </>
                  );
                  const cardClass = `${CARD} ${journeysLayout.card} ${railFor(featuredJourneys.length).item}`;
                  return link ? (
                    <a key={j.id} {...link} className={`${cardClass} ${CARD_HOVER}`}>
                      {body}
                    </a>
                  ) : (
                    <div key={j.id} className={cardClass}>
                      {body}
                    </div>
                  );
                })}
              </div>
              <RailHint count={featuredJourneys.length} />
            </>
          )}
        </div>
      </section>

      {/* ── 地方刊物典藏 ─────────────────────────────────────────────────────
          這間店最獨特的東西，給它一整條色帶與一個大數字。份數與封面來自 publications 表；
          讀不到就不印數字（不顯示 0），封面區整塊不畫。 */}
      <section className="bg-oat/80 border-y border-border" aria-labelledby="home-archive">
        <div className="container-editorial section-y grid gap-14 lg:grid-cols-12 lg:gap-16 lg:items-center">
          <div className="lg:col-span-5">
            <p className="kicker">{t(p.block("home.archiveKicker", HOME.archiveKicker))}</p>
            {counts ? (
              <p className="mt-8 flex items-baseline gap-4">
                <span className="display text-[5.5rem] leading-none md:text-[7.5rem] [font-variant-numeric:lining-nums]">
                  {counts.total}
                </span>
                <span className="font-serif text-xl md:text-2xl">{t(HOME.archiveUnit)}</span>
              </p>
            ) : null}
            {counts ? (
              <p className="mt-3 text-sm tracking-[0.12em] text-muted-foreground">
                {fill(t(HOME.archiveSplit), { tw: counts.tw, jp: counts.jp })}
              </p>
            ) : null}
            <h2 id="home-archive" className="display mt-10 text-3xl md:text-4xl">
              {t(p.block("home.archiveTitle", HOME.archiveTitle))}
            </h2>
            <p className="mt-6 max-w-md leading-[1.95] text-foreground/80">
              {t(p.block("home.archiveBody", HOME.archiveBody))}
            </p>
            <PublicationsLink className="btn-line mt-10">
              {t(p.block("home.archiveCta", HOME.archiveCta))}
            </PublicationsLink>
          </div>
          {archive.covers.length > 0 ? (
            <ul className="-mx-6 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-6 px-6 pb-2 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-6 sm:overflow-visible sm:px-0 lg:col-span-7 [&::-webkit-scrollbar]:hidden">
              {archive.covers.map((c, i) => (
                <li
                  key={c.slug}
                  className={`w-[42%] shrink-0 snap-start sm:w-auto ${i % 3 === 1 ? "sm:translate-y-8" : ""}`}
                >
                  <Link
                    to="/publications/$slug"
                    params={{ slug: c.slug }}
                    className="group block"
                    data-testid="home-publication-cover"
                  >
                    <div className="aspect-[3/4] overflow-hidden bg-background/70 p-3 shadow-[0_18px_36px_-26px_oklch(0.245_0.018_60/0.6)]">
                      <img
                        src={imageFor(c.coverImageKey, exhibitionImg)}
                        alt={fill(t(HOME.archiveCoverLabel), {
                          title: t(c.title),
                          region: c.region,
                        })}
                        loading="lazy"
                        className="img-zoom h-full w-full object-contain"
                      />
                    </div>
                    <p className="mt-3 text-sm leading-snug">{t(c.title)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{c.region}</p>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="aspect-[3/2] overflow-hidden bg-muted lg:col-span-7">
              <img
                src={exhibitionImg}
                alt={t(HOME.heroInsetAlt)}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </div>
          )}
        </div>
      </section>

      {/* 主理人的選品 —— 2026-10 起右邊那張花瓶大圖換成可以直接買的商品卡。
          標題與內文仍然是 pages/index 的可編輯區塊（entries.curatedTitle／curatedBody）。
          選哪幾件（2026-10-26 起）= 先放後台「選品」裡連結了商品的那幾件（主題順序、品項
          順序，買得到的書籍／選物才算），不滿 4 件再用 /shop〈商品〉分頁同一個排序補
          （見 src/lib/shop.ts#fetchHomeShelfProducts、src/lib/home-shelf.ts）。
          讀不到任何一件（讀取失敗或全部售完）時退回原本的單張意象圖，不開天窗。 */}
      {shelfProducts.length > 0 ? (
        <section className="container-editorial section-y" data-testid="home-curated">
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-12">
            <div>
              <p className="kicker">{t(ui.nav.curated)}</p>
              <h2 className="display mt-5 text-3xl md:text-[2.6rem] leading-[1.3] whitespace-pre-line">
                {t(p.block("entries.curatedTitle", ENTRIES.curatedTitle))}
              </h2>
              <p className="mt-6 max-w-md text-base leading-[1.95] text-foreground/75 whitespace-pre-line">
                {t(p.block("entries.curatedBody", ENTRIES.curatedBody))}
              </p>
            </div>
            {/* 「查看全部」：卡片是商品，所以落在〈商品〉分頁（能結帳的那一個），
                不是只能看不能買的〈主理人的選品〉清單。 */}
            <Link
              to="/shop"
              search={{ tab: "products" }}
              className="link-arrow shrink-0 self-start md:self-end"
            >
              {t(p.block("entries.curatedCta", ENTRIES.curatedCta))}
              <span className="arrow" aria-hidden="true">
                →
              </span>
            </Link>
          </div>
          <div className="mt-12">
            <HomeProductShelf products={shelfProducts} />
          </div>
        </section>
      ) : (
        <section className="container-editorial section-y">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <p className="kicker">{t(ui.nav.curated)}</p>
              <h2 className="display mt-5 text-3xl md:text-[2.6rem] leading-[1.3] whitespace-pre-line">
                {t(p.block("entries.curatedTitle", ENTRIES.curatedTitle))}
              </h2>
              <p className="mt-6 max-w-md text-base leading-[1.95] text-foreground/75 whitespace-pre-line">
                {t(p.block("entries.curatedBody", ENTRIES.curatedBody))}
              </p>
              <Link to="/shop" search={{ tab: "products" }} className="link-arrow mt-8">
                {t(p.block("entries.curatedCta", ENTRIES.curatedCta))}
                <span className="arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            </div>
            <div className="aspect-[4/5] overflow-hidden bg-muted">
              <img
                src={curatedImg}
                alt={t(ui.nav.curated)}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </div>
          </div>
        </section>
      )}

      {/* ── 回顧：最近結束的活動與策旅 ────────────────────────────────────────
          與 /events「過往活動」、/journeys「過往策旅」同一個元件、同一套判準
          （newestEndedFirst／splitJourneys）。零筆時 PastShelf 自己不畫。 */}
      <PastShelf
        testId="home-past-shelf"
        eyebrow={t(p.block("home.pastKicker", HOME.pastKicker))}
        title={t(p.block("home.pastTitle", HOME.pastTitle))}
        badge={t(p.block("home.pastBadge", HOME.pastBadge))}
        items={[
          ...endedJourneys.map(({ journey: j, event: e }) => {
            const link = journeyLinkProps(j.externalUrl, localizeHref);
            return {
              key: `j-${j.id}`,
              title: t(j.title),
              category: journeyKicker(t(j.days), t(j.theme)),
              date: e.date,
              // 首頁上方「行」已經用了那張固定意象圖，這裡沒有封面就不放圖，避免同一張照片重複出現。
              image: e.imageKey ? imageFor(e.imageKey, journeyImg) : null,
              link: link ? { kind: "href" as const, ...link } : null,
            };
          }),
          ...pastEvents.map((e) => ({
            key: `e-${e.id}`,
            title: t(e.title),
            category: "",
            date: e.date,
            image: e.imageKey ? imageFor(e.imageKey, storefrontImg) : null,
            link: { kind: "event" as const, slug: e.slug },
          })),
        ]}
        cta={
          <Link to="/events" className="link-arrow">
            {t(p.block("home.pastCta", HOME.pastCta))}
            <span className="arrow" aria-hidden="true">
              →
            </span>
          </Link>
        }
      />

      {/* ── 三個支柱：讀．聚．行 ───────────────────────────────────────────
          2026-11-10 業主要求移到「來小時光坐坐」（來訪資訊）正上方，內容不變。
          上一區通常是「回顧」（PastShelf：container 內一條上框線＋pb-24），這裡用同一個做法——
          container 內畫上框線、上方不再疊 section-y 的留白，免得兩區之間空一大段卻沒有分隔；
          下方的來訪資訊自帶整寬上框線。 */}
      <section
        className="container-editorial pb-[var(--space-section)]"
        aria-labelledby="home-pillars"
      >
        <div className="border-t border-border pt-16">
          <div className="max-w-2xl">
            <p className="kicker">{t(p.block("home.pillarsKicker", HOME.pillarsKicker))}</p>
            <h2 id="home-pillars" className="display mt-5 text-3xl md:text-5xl">
              {t(p.block("home.pillarsTitle", HOME.pillarsTitle))}
            </h2>
          </div>
          <ul className="mt-14 grid gap-12 md:grid-cols-3 md:gap-8 lg:gap-12">
            {pillars.map((pl) => (
              <li key={pl.key}>
                <Link
                  to={pl.to}
                  search={pl.to === "/events" ? { type: pl.type } : undefined}
                  className="group block"
                >
                  <div className="aspect-[5/4] overflow-hidden bg-muted">
                    <img
                      src={pl.img}
                      srcSet={srcSetFor(pl.img)}
                      sizes="(min-width: 768px) 30vw, 100vw"
                      alt={pl.alt}
                      loading="lazy"
                      className="img-zoom h-full w-full object-cover"
                    />
                  </div>
                  <div className="mt-6 flex items-baseline gap-4">
                    <span className="text-xs tracking-[0.2em] text-clay">{pl.no}</span>
                    <span className="display text-4xl md:text-5xl" aria-hidden="true">
                      {pl.char}
                    </span>
                  </div>
                  <h3 className="mt-4 font-serif text-2xl">{pl.title}</h3>
                  <p className="mt-3 text-[0.95rem] leading-[1.9] text-foreground/75">{pl.body}</p>
                  <span className="link-arrow mt-5 text-sm">
                    {pl.cta}
                    <span className="arrow" aria-hidden="true">
                      →
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── 來訪資訊 ─────────────────────────────────────────────────────── */}
      <section className="border-t border-border" aria-labelledby="home-visit">
        <div className="container-editorial section-y grid items-stretch gap-12 md:grid-cols-2 lg:gap-16">
          <div className="flex flex-col justify-center md:order-2">
            <p className="kicker">{t(ui.nav.visit)}</p>
            <h2 id="home-visit" className="display mt-5 text-3xl md:text-5xl">
              {t(p.block("home.visitTitle", HOME.visitTitle))}
            </h2>
            <dl className="mt-10 space-y-6 text-[0.95rem] leading-[1.85]">
              <div className="grid grid-cols-[5.5rem_1fr] gap-4 border-t border-border pt-5">
                <dt className="text-sm text-muted-foreground">{t(HOME.visitWhereLabel)}</dt>
                <dd>
                  {t(site.address)}
                  <span className="block text-muted-foreground">{t(site.city)}</span>
                </dd>
              </div>
              <div className="grid grid-cols-[5.5rem_1fr] gap-4 border-t border-border pt-5">
                <dt className="text-sm text-muted-foreground">{t(HOME.visitHoursLabel)}</dt>
                <dd>
                  {t(site.hours)}
                  <span className="block text-muted-foreground">{t(ui.footer.everyday)}</span>
                </dd>
              </div>
              <div className="grid grid-cols-[5.5rem_1fr] gap-4 border-y border-border py-5">
                <dt className="text-sm text-muted-foreground">{t(HOME.visitHowLabel)}</dt>
                <dd>{t(p.block("home.visitTransit", HOME.visitTransit))}</dd>
              </div>
            </dl>
            <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4">
              <a href={map.link} target="_blank" rel="noreferrer" className="btn-solid">
                {t(ui.buttons.navigate)}
                <span className="arrow" aria-hidden="true">
                  ↗
                </span>
              </a>
              {/* 來店資訊 2026-09-02 併進 /about 的後半。同上：站內連結直接指向新家。 */}
              <Link to="/about" className="link-arrow">
                {t(p.block("entries.visitFull", ENTRIES.visitFull))}
                <span className="arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            </div>
          </div>
          <div className="aspect-[4/3] bg-muted md:order-1 md:aspect-auto md:min-h-[28rem]">
            <iframe
              src={map.embed}
              className="h-full w-full border-0"
              loading="lazy"
              title={t(site.address)}
            />
          </div>
        </div>
      </section>

      {/* 2026-11-10：原本這裡的收尾段（休止符＋INTERVAL＋「留一段屬於自己的＿＿＿小時光。」）
          搬到 /about 當「店名的由來」，見 src/components/IntervalCoda.tsx。 */}
    </PageShell>
  );
}

/**
 * 手機（< md）兩筆以上時，卡片排成可橫滑的一列：每張 82% 寬，露出下一張一截。
 * 只加 max-md: 前綴的 class，md 以上完全交回 featureLayout（桌機不變）。
 * 一筆時不需要滑，照原本的直排。
 */
function railFor(count: number) {
  if (count < 2) return { track: "", item: "" };
  return {
    track:
      "max-md:-mx-6 max-md:flex max-md:snap-x max-md:snap-mandatory max-md:gap-4 max-md:overflow-x-auto max-md:scroll-px-6 max-md:px-6 max-md:pb-2 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden",
    item: "max-md:w-[82%] max-md:shrink-0 max-md:snap-start",
  };
}

function RailHint({ count }: { count: number }) {
  const t = useT();
  if (count < 2) return null;
  return (
    <p
      className="mt-3 text-xs tracking-[0.12em] text-muted-foreground md:hidden"
      aria-hidden="true"
    >
      {fill(t(HOME.railHint), { n: count })}
      <span className="ml-1">→</span>
    </p>
  );
}

function SubHeader({
  label,
  link,
}: {
  label: string;
  /** 「查看全部」落在 /events 合併頁的哪一種篩選（2026-11-10 /journeys 併入 /events）。 */
  link: { type: "event" | "journey"; label: string };
}) {
  return (
    <div className="mt-10 mb-5 flex items-center justify-between gap-6 border-b border-border pb-2 md:mt-14 md:mb-6 md:pb-3">
      <p className="font-serif text-xl md:text-2xl">{label}</p>
      {/* min-h-11：手機點擊區至少 44px（文字本身只有 20px 高）。 */}
      <Link to="/events" search={{ type: link.type }} className="link-arrow min-h-11 text-sm">
        {link.label}
        <span className="arrow" aria-hidden="true">
          →
        </span>
      </Link>
    </div>
  );
}

/**
 * 連到地方刊物總覽頁 /publications（2026-11 M4 起是獨立頁面；原本是 /shop?tab=publications）。
 *
 * 獨立成小元件、放在檔案最後：nav-consolidation-selftest 以「首頁第一個帶 search 的
 * <Link to="/shop">」確認主理人選品的「查看全部」落在 products 分頁；把刊物入口集中在這裡，
 * 那條檢查仍然對準選品那一顆。
 */
function PublicationsLink({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Link to="/publications" className={className}>
      {children}
      <span className="arrow" aria-hidden="true">
        →
      </span>
    </Link>
  );
}
