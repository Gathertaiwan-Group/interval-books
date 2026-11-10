import { createFileRoute, Link } from "@tanstack/react-router";
import { journeyKicker } from "@/lib/journey-events";
import { useEffect, useRef, useState } from "react";
import { isEventPast } from "@/lib/event-status";
import { PageShell, PageHeader } from "@/components/PageShell";
import { CoverImage } from "@/components/CoverImage";
import { PastShelf, type PastShelfItem } from "@/components/PastShelf";
import {
  effectiveEndDate,
  linkedEventFor,
  newestEndedFirst,
  PAST_SHELF_LIMIT,
  splitJourneys,
} from "@/lib/past-shelf";
import { useLocalizeHref, useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fitDescription } from "@/lib/seo/core";
import { pageHead } from "@/lib/seo/head";
import { pageRowTranslation } from "@/lib/seo/pages";
import {
  eyebrowOf,
  fetchEvents,
  fetchJourneyEventDates,
  fetchJourneys,
  fetchPages,
  pageText,
} from "@/lib/cms";
import { CARD, featureLayout } from "@/lib/feature-layout";
import { useSiteContent } from "@/lib/site-content";
import { imageFor } from "@/lib/images";
import { EventsCalendar } from "@/components/events/EventsCalendar";
import { fetchCalendarEntries } from "@/lib/events-calendar-data";
import { parseMonthParam, taipeiDateAt, taipeiMonthAt } from "@/lib/events-calendar";
import {
  EVENTS_TYPE_OPTIONS,
  filterByKind,
  mergeNewestEnded,
  optionFor,
  parseTypeParam,
  showsEvents,
  showsJourneys,
  typeParamFor,
  type EventsType,
} from "@/lib/events-type";
import { fetchListingFacts, listingFactsForCard } from "@/lib/home-listing";
import { eventProductSlug } from "@/lib/shop";
import { journeyLinkProps } from "@/lib/journey-link";
import { JourneyCard } from "@/components/events/JourneyCard";
import { PrivateBookingBadge } from "@/components/ListingBits";
import eventImg from "@/assets/event-reading.jpg";
import journeyImg from "@/assets/journey-mist.jpg";

/**
 * 「活動與策旅」列表頁（2026-11-10 起 /events 與 /journeys 合併成這一頁）。
 *
 * ?type=event|journey 篩選類型（解析與排法理由見 src/lib/events-type.ts）；舊的 /journeys
 * 301 到 /events?type=journey（src/routes/journeys.tsx）。策旅卡片、過往策旅與「策旅合作共創」
 * 從原本的 /journeys 搬過來，文案仍讀 pages/'journeys' 那一列的區塊。
 *
 * 🔴 檔名是 events.index.tsx，不是 events.tsx。flat routing 下 `events.tsx` 會變成
 *    /events 底下所有路由的 parent layout —— 它得渲染 <Outlet />，否則
 *    /events/$slug 就是一片空白。repo 自己的慣例已經給了答案：沒有 shop.tsx，
 *    只有 shop.index.tsx + shop.$slug.tsx。這一組照抄。
 */

/**
 * 頁名（title、description、eyebrow）—— 合併後的「活動與策旅」。
 *
 * 🔴 這三個**刻意不讀** pages/'events' 的 meta_title／meta_description／eyebrow：那一列寫的
 *    是合併前的「活動 Events」，而 MCP 只能改區塊（update_page_blocks）、改不到 pages 本身的
 *    SEO 欄位。讀 CMS 的話頁名會一直停在「活動」。之後若要讓後台改頁名，先把 pages/'events'
 *    的 meta 更新成合併後的文字，再把這裡換回 p.metaTitle(...)／p.metaDescription(...)。
 *    頁首大標、介紹文、og:title 仍然讀 CMS（那幾句不提「活動」或「策旅」，合併後照樣成立）。
 */
const NAME = { zh: "活動與策旅", en: "Events & Journeys", ja: "イベント・旅" };

/** Fallback copy — header title／intro 只在 Supabase 讀不到時使用。 */
const PAGE = {
  metaTitle: {
    zh: "活動與策旅 Events & Journeys｜小時光書店",
    en: "Events & Journeys｜Interval Books",
    ja: "イベント・旅｜小時光書店",
  },
  metaDescription: {
    zh: "在書店裡一起讀，也跟著書走到土地上：讀書會、繪本分享會、城市思享沙龍，以及台東公東教堂、池上秋收等文化策旅。正在報名與已結束的場次都在這裡，可切換月曆，點進去就是報名頁。",
    en: "Reading circles, talks and salons at our Huashan bookstore, plus cultural journeys out to the land — open and past events and journeys, with a calendar view.",
    ja: "読書会、絵本のおはなし会、都市のサロン、そして本とともに土地を訪ねる文化の旅。受付中と終了したイベント・旅をまとめ、カレンダー表示と申し込みページへご案内します。",
  },
  title: {
    zh: "在書店相遇，走進台灣的土地",
    en: "Meet at the bookstore, step into Taiwan",
    ja: "本屋で出会い、台湾の土地へ",
  },
  intro: {
    zh: "讀書會、講座、手作工作坊，還有走出書店的文化策旅。在這裡找一場想參加的，跟我們一起認識台灣的美好事物。",
    en: "Reading circles, talks, hands-on workshops, and cultural journeys beyond the shop. Find one that speaks to you and discover the good things of Taiwan with us.",
    ja: "読書会、トーク、ワークショップ、そして本屋の外へ出る文化の旅。気になるひとつを見つけて、台湾の素晴らしさを一緒に知りましょう。",
  },
};

/** "all" filter pill — a page_block on the events page. */
const UPCOMING_LABEL = { zh: "報名中", en: "Open", ja: "受付中" };
const PAST_LABEL = { zh: "已結束", en: "Past", ja: "終了" };
const PAST_BADGE = { zh: "已結束", en: "Ended", ja: "終了" };

/**
 * 「活動詳情」——  連到 /events/$slug。
 *
 * 走 p.block() 讓後台可以覆寫，與這一頁其他文案一致；PAGE 裡的這一份只是
 * 資料庫讀不到時的退路。
 */
const DETAIL = { zh: "活動詳情", en: "Event details", ja: "イベント詳細" };

/**
 * 零筆結果的文案。
 *
 * 🔴 為什麼非有不可：下面的列表是一張一張獨立的卡片（featureLayout），格線容器
 *    本身沒有底色。list 是空陣列時格線裡一張卡片都沒有，篩選鈕底下就只剩 pb-32
 *    的一段空白 —— 看起來像沒載入完或壞掉，不是「目前沒有活動」；「報名中」空了時
 *    該給的下一步（看過去的活動）也跟著不見。所以零筆時不畫格線，改畫這段文案。
 *
 *    以前這裡是 1px 細線磚牆（feature-layout.ts 檔頭 🔴 說的那種）：容器鋪 border 色、
 *    每張卡片再用 bg-background 蓋回來，空陣列時整個容器連同 pb-32 會變成一大片灰色。
 *    改成卡片之後灰色色塊不會再出現（單數筆時最後一格的灰色空位也一起沒了），但
 *    「空白看起來像壞掉」這一半還在，所以這段文案照樣留著。
 *
 * 兩種空狀態分開寫，因為這一頁的兩個 filter 空掉時「下一步」不一樣：「報名中」
 * 空了的時候使用者還有地方可以去（過去辦過的活動），「已結束」空了則沒有。
 *
 * 同一頁其他文案的慣例照舊 —— 三語常數當退路，實際顯示走 p.block() 讓
 * pages/'events' 的區塊（MCP update_page_blocks）可以改字。
 */
const EMPTY_UPCOMING = {
  zh: "目前沒有開放報名的活動。新的場次公布前，歡迎先看看我們辦過什麼。",
  en: "No events are open for registration right now. In the meantime, take a look at what we have held.",
  ja: "現在受付中のイベントはありません。これまでに開催したイベントをご覧ください。",
};
const EMPTY_UPCOMING_ALL = {
  zh: "目前沒有開放報名的活動或策旅。新的場次公布前，歡迎先看看我們辦過什麼。",
  en: "Nothing is open for registration right now. In the meantime, take a look at what we have held.",
  ja: "現在受付中のイベント・旅はありません。これまでの開催をご覧ください。",
};
const EMPTY_PAST = {
  zh: "還沒有已結束的活動。",
  en: "No past events yet.",
  ja: "終了したイベントはまだありません。",
};
const SEE_PAST = {
  zh: "看看過去的活動",
  en: "Browse past events",
  ja: "過去のイベントを見る",
};

/**
 * 「過往活動」卡片區（2026-10-28 店長：「這邊下方，幫我多一區，用卡片的形式，去展現
 * 已經辦過的活動」）。畫在「報名中」列表下方，訪客不必切分頁就看得到辦過什麼；
 * 「查看全部」切到既有的「已結束」分頁（那一格本身不動）。資料就是同一份 events，
 * 不多查一次。
 */
const PAST_SHELF = {
  eyebrow: { zh: "PAST EVENTS", en: "PAST EVENTS", ja: "PAST EVENTS" },
  title: { zh: "過往活動", en: "Past events", ja: "これまでのイベント" },
  cta: { zh: "查看全部已結束活動", en: "See all past events", ja: "終了したイベントをすべて見る" },
};

/** 類型篩選列（全部｜活動｜策旅）。「全部」沿用 pages/'events' 既有的 filters.all 區塊。 */
const TYPE_LABELS = {
  all: { zh: "全部", en: "All", ja: "すべて" },
  event: { zh: "活動", en: "Events", ja: "イベント" },
  journey: { zh: "策旅", en: "Journeys", ja: "旅" },
  aria: { zh: "類型", en: "Type", ja: "種類" },
};

/** 「全部」時兩段各自的小標（策旅在前，理由見 src/lib/events-type.ts）。 */
const SECTION_LABELS = {
  journey: { zh: "策旅", en: "Journeys", ja: "旅" },
  event: { zh: "活動", en: "Events", ja: "イベント" },
};

/**
 * 從 /journeys 搬過來的文案。實際顯示走 pages/'journeys' 的區塊（jp.block），這裡只是讀不到
 * 時的退路 —— 與原本 src/routes/journeys.tsx 的 PAGE 同一份字、同一組 block key。
 */
const JOURNEY_COPY = {
  coCreateEyebrow: { zh: "Co-create", en: "Co-create", ja: "Co-create" },
  collab: { zh: "策旅合作共創", en: "Journey co-creation", ja: "旅の共創" },
  collabBody: {
    zh: "若您是地方夥伴、職人、旅宿或品牌，歡迎與我們共創一段屬於風土的策旅。請以 Email 聯繫。",
    en: "If you're a local partner, maker, hotel, or brand, we'd love to co-create a journey rooted in place. Reach us by email.",
    ja: "地域のパートナー、作り手、宿、ブランドの方へ。風土に根ざした旅をともに育てましょう。メールでご連絡ください。",
  },
  pastEyebrow: { zh: "PAST JOURNEYS", en: "PAST JOURNEYS", ja: "PAST JOURNEYS" },
  pastTitle: { zh: "過往策旅", en: "Past journeys", ja: "これまでの旅" },
  emptyOpen: {
    zh: "目前沒有開放報名的策旅。新的旅程公布前，歡迎先看看我們走過的地方。",
    en: "No journeys are open for registration right now. In the meantime, take a look at where we have been.",
    ja: "現在受付中の旅はありません。これまでの旅をご覧ください。",
  },
  emptyPast: {
    zh: "還沒有已結束的策旅。",
    en: "No past journeys yet.",
    ja: "終了した旅はまだありません。",
  },
};

/** 「全部」時過往卡片區的標題（活動與策旅混在一起）。 */
const PAST_SHELF_ALL = {
  eyebrow: { zh: "PAST", en: "PAST", ja: "PAST" },
  title: { zh: "過往活動與策旅", en: "Past events & journeys", ja: "これまでのイベント・旅" },
  cta: { zh: "查看全部已結束", en: "See everything past", ja: "終了分をすべて見る" },
};

/**
 * 「列表｜月曆」檢視（2026-11）。
 *
 * ?view=list|calendar、?month=YYYY-MM 都是 optional：站內的 <Link to="/events"> 都不帶
 * search，它們要去的就是預設檢視。canonical 不含這兩個參數（canonicalUrl() 只對 /shop
 * 保留 ?tab），所以分享出去的月曆網址不會變成另一頁被收錄。
 *
 * 沒帶 view 時是「自動」：桌機（md 以上）看月曆、手機看原本的卡片列表 —— 用 CSS 斷點切，
 * 不是用 JS 量螢幕（SSR 不知道螢幕多寬，量了就會在 hydrate 時跳一次）。理由：桌機一眼
 * 看得完一整個月，月曆最能回答「這個月有什麼」；手機上卡片有封面圖、是主要的報名入口，
 * 月曆（議程）一鍵可達。
 */
type EventsView = "list" | "calendar";
type EventsSearch = { view?: EventsView; month?: string; type?: EventsType };

const VIEW_LABELS = {
  list: { zh: "列表", en: "List", ja: "リスト" },
  calendar: { zh: "月曆", en: "Calendar", ja: "カレンダー" },
  aria: { zh: "檢視方式", en: "View", ja: "表示" },
};

export const Route = createFileRoute("/events/")({
  validateSearch: (search: Record<string, unknown>): EventsSearch => {
    const out: EventsSearch = {};
    if (search.view === "list" || search.view === "calendar") out.view = search.view;
    const month = parseMonthParam(search.month);
    if (month) out.month = month;
    const type = parseTypeParam(search.type);
    if (type) out.type = type;
    return out;
  },
  loader: async () => {
    // loadedAt：月曆的「今天」「已結束」都用它算 —— SSR 與 hydrate 拿到同一個值。
    const loadedAt = Date.now();
    // journeys／journeyEvents／listing：策旅卡片（原 /journeys 與首頁同一組查詢）；全部平行，
    // 不多一段等待。pages 一次讀 events 與 journeys 兩列（後者是策旅區塊的文案）。
    // 活動分類（event_categories）2026-11-10 起不再查：業主「活動分類功能都拿掉」，卡片不印分類。
    const [pages, events, calendar, journeys, journeyEvents, listing] = await Promise.all([
      fetchPages(["events", "journeys"]),
      fetchEvents(),
      fetchCalendarEntries(loadedAt),
      fetchJourneys(),
      fetchJourneyEventDates(),
      fetchListingFacts(),
    ]);
    return {
      page: pages.events ?? null,
      journeysPage: pages.journeys ?? null,
      events,
      calendar,
      journeys,
      journeyEvents,
      listing,
      loadedAt,
    };
  },
  head: ({ loaderData, matches, match }) => {
    const p = pageText(loaderData?.page ?? null);
    const ogImg = imageFor(loaderData?.page?.ogImageKey, eventImg);
    return {
      ...pageHead(
        { matches, match },
        {
          translation: pageRowTranslation(loaderData?.page ?? null),
          title: PAGE.metaTitle,
          description: fitDescription(PAGE.metaDescription),
          ogTitle: p.ogTitle(PAGE.title),
          image: ogImg,
          type: "website",
        },
      ),
    };
  },
  component: Events,
});

function Events() {
  const t = useT();
  const localizeHref = useLocalizeHref();
  const {
    page,
    journeysPage,
    events,
    calendar,
    journeys: allJourneys,
    journeyEvents,
    listing,
    loadedAt,
  } = Route.useLoaderData();
  const search = Route.useSearch();
  const type = search.type;
  const currentMonth = taipeiMonthAt(loadedAt);
  const calendarMonth = search.month ?? currentMonth;
  // 沒帶 ?view＝自動（見 Route 上方的說明）。掛載後才用 matchMedia 決定「現在算哪一個」，
  // 只為了切換鈕的 aria-current；畫面本身在 SSR 時就由 CSS 斷點決定好了。
  const [autoView, setAutoView] = useState<EventsView | null>(null);
  useEffect(() => {
    if (search.view) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setAutoView(mq.matches ? "calendar" : "list");
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [search.view]);
  const view: EventsView | null = search.view ?? autoView;
  const p = pageText(page);
  const jp = pageText(journeysPage);
  const { contactEmail } = useSiteContent();
  const heroSrc = imageFor(page?.ogImageKey, eventImg);

  useDocumentMeta({
    title: PAGE.metaTitle,
    description: fitDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
    ogImage: heroSrc,
  });

  // 篩選只有兩格：報名中 / 已結束（「已結束」是時間狀態，用寫死的哨兵 id）。
  //
  // 這裡原本還有六到七個分類（讀書會、療癒生活節、陶藝工作坊…），但那些對訪客
  // 不是有用的切法 —— 真正會影響行為的問題只有一個：「這場我還報得到名嗎」。
  // 2026-11-10 業主：「活動分類功能都拿掉」—— 卡片上的分類字也一起拿掉，不再查 event_categories。
  // 合併策旅之後多了一個「類型」篩選，但它在網址上 —— 見 src/lib/events-type.ts。
  const UPCOMING_FILTER = "__upcoming__";
  const PAST_FILTER = "__past__";
  const filterIds = [UPCOMING_FILTER, PAST_FILTER];

  const [filter, setFilter] = useState<string>(UPCOMING_FILTER);
  const isPastTab = filter === PAST_FILTER;

  const wantEvents = showsEvents(type);
  const wantJourneys = showsJourneys(type);

  // 🔴 已結束的活動**只有在「已結束」那一格才找得到**。辦過的活動留在站上是為了
  //    讓人看得到我們辦過什麼，不是為了讓人以為還能報名。
  const upcoming = wantEvents ? events.filter((e) => !isEventPast(e)) : [];
  const past = wantEvents ? events.filter((e) => isEventPast(e)) : [];
  // 策旅的「已結束」＝卡片指著的那場活動已結束（判準見 src/lib/past-shelf.ts，與首頁同一支）。
  // 「已結束」那一格要列全部，所以 limit 給到整份清單的長度。
  const split = splitJourneys(allJourneys, journeyEvents, allJourneys.length);
  const openJourneys = wantJourneys ? split.open : [];
  const endedJourneys = wantJourneys ? split.ended : [];

  const eventList = isPastTab ? past : upcoming;
  const journeyList = isPastTab ? endedJourneys.map(({ journey }) => journey) : openJourneys;
  const nothing = eventList.length === 0 && journeyList.length === 0;
  const hasAnyPast = past.length > 0 || endedJourneys.length > 0;
  // 「全部」時兩段各有小標；只看一種時不需要。
  const sectioned = type === undefined;

  // 卡片排法跟首頁同一套（src/lib/feature-layout.ts）：1 場＝橫版左圖右字佔滿寬，
  // 2 場兩欄，3 場以上 md 兩欄／lg 三欄。活動與策旅各自算。
  const eventLayout = featureLayout(eventList.length);
  const journeyLayout = featureLayout(journeyList.length);

  // 過往卡片區（只在「報名中」那一格畫）：依類型挑來源，「全部」時依結束日合併。
  const pastEventItems = newestEndedFirst(events).map(
    (e): { endDate: string; item: PastShelfItem } => ({
      endDate: effectiveEndDate(e),
      item: {
        key: e.id,
        title: t(e.title),
        category: "",
        date: e.date,
        image: e.imageKey ? imageFor(e.imageKey, eventImg) : null,
        link: { kind: "event" as const, slug: e.slug },
      },
    }),
  );
  const pastJourneyItems = split.ended
    .slice(0, PAST_SHELF_LIMIT)
    .map(({ journey: j, event: e }): { endDate: string; item: PastShelfItem } => {
      const link = journeyLinkProps(j.externalUrl, localizeHref);
      return {
        endDate: effectiveEndDate(e),
        item: {
          key: j.id,
          title: t(j.title),
          category: journeyKicker(t(j.days), t(j.theme)),
          date: e.date,
          image: e.imageKey ? imageFor(e.imageKey, journeyImg) : journeyImg,
          link: link ? { kind: "href" as const, ...link } : null,
        },
      };
    });
  const shelfItems = (
    type === "event"
      ? pastEventItems
      : type === "journey"
        ? pastJourneyItems
        : mergeNewestEnded(pastJourneyItems, pastEventItems, PAST_SHELF_LIMIT)
  ).map((x) => x.item);
  const shelfCopy =
    type === "journey"
      ? {
          eyebrow: t(jp.block("pastEyebrow", JOURNEY_COPY.pastEyebrow)),
          title: t(jp.block("pastTitle", JOURNEY_COPY.pastTitle)),
          cta: null,
        }
      : type === "event"
        ? {
            eyebrow: t(p.block("past.eyebrow", PAST_SHELF.eyebrow)),
            title: t(p.block("past.title", PAST_SHELF.title)),
            cta: t(p.block("past.cta", PAST_SHELF.cta)),
          }
        : {
            eyebrow: t(PAST_SHELF_ALL.eyebrow),
            title: t(PAST_SHELF_ALL.title),
            cta: t(PAST_SHELF_ALL.cta),
          };

  const filtersRef = useRef<HTMLElement>(null);
  const showAllPast = () => {
    setFilter(PAST_FILTER);
    filtersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const pastBadge = t(p.block("filters.pastBadge", PAST_BADGE));
  const emptyText = isPastTab
    ? type === "journey"
      ? t(JOURNEY_COPY.emptyPast)
      : t(p.block("emptyPast", EMPTY_PAST))
    : type === "journey"
      ? t(jp.block("emptyOpen", JOURNEY_COPY.emptyOpen))
      : type === "event"
        ? t(p.block("emptyUpcoming", EMPTY_UPCOMING))
        : t(EMPTY_UPCOMING_ALL);

  const segBtn = "inline-flex min-h-11 items-center justify-center px-4 sm:px-5 transition-colors";

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(null, "Events & Journeys", t(NAME))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <div className="container-editorial pb-8 flex flex-wrap items-center justify-between gap-3">
        {/* 類型：全部｜活動｜策旅。是網址狀態（?type=），可以分享；切換時保留 view 與 month。 */}
        <nav aria-label={t(TYPE_LABELS.aria)} data-testid="events-type-filter">
          <div className="inline-flex border border-foreground text-sm tracking-widest">
            {EVENTS_TYPE_OPTIONS.map((opt) => {
              const active = optionFor(type) === opt;
              const label =
                opt === "all" ? t(p.block("filters.all", TYPE_LABELS.all)) : t(TYPE_LABELS[opt]);
              return (
                <Link
                  key={opt}
                  to="/events"
                  search={{ view: search.view, month: search.month, type: typeParamFor(opt) }}
                  resetScroll={false}
                  // exact：search 要完全相等才算「目前這一格」。預設是部分比對，/events?type=journey
                  // 會讓「全部」（search 裡沒有 type）也被框架標成 active、多一個 aria-current。
                  activeOptions={{ exact: true }}
                  aria-current={active ? "page" : undefined}
                  data-testid={`events-type-${opt}`}
                  className={`${segBtn} min-w-16 ${
                    active ? "bg-foreground text-primary-foreground" : "hover:bg-muted"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </nav>

        <nav aria-label={t(p.block("view.aria", VIEW_LABELS.aria))}>
          <div className="inline-flex border border-foreground text-sm tracking-widest">
            {(["list", "calendar"] as const).map((v) => {
              const active = view === v;
              // 自動模式、尚未掛載時：用斷點把「目前這一格」畫成選中（桌機月曆、手機列表）。
              const autoCls =
                view === null
                  ? v === "calendar"
                    ? "md:bg-foreground md:text-primary-foreground"
                    : "max-md:bg-foreground max-md:text-primary-foreground"
                  : active
                    ? "bg-foreground text-primary-foreground"
                    : "";
              return (
                <Link
                  key={v}
                  to="/events"
                  search={
                    v === "calendar" ? { view: v, month: search.month, type } : { view: v, type }
                  }
                  resetScroll={false}
                  activeOptions={{ exact: true }}
                  aria-current={active ? "page" : undefined}
                  data-testid={`events-view-${v}`}
                  className={`${segBtn} min-w-20 ${autoCls} ${
                    active || view === null ? "" : "hover:bg-muted"
                  }`}
                >
                  {t(p.block(`view.${v}`, VIEW_LABELS[v]))}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>

      {view !== "list" ? (
        <section
          className={`container-editorial pb-32 ${view === null ? "hidden md:block" : ""}`}
          data-testid="events-calendar-section"
        >
          <EventsCalendar
            entries={filterByKind(calendar.entries, type)}
            unavailable={calendar.unavailable}
            month={calendarMonth}
            currentMonth={currentMonth}
            today={taipeiDateAt(loadedAt)}
            type={type}
          />
        </section>
      ) : null}

      {view !== "calendar" ? (
        <div className={view === null ? "md:hidden" : ""}>
          <section
            ref={filtersRef}
            className="container-editorial pb-12 flex flex-wrap gap-3 text-xs tracking-widest scroll-mt-24"
          >
            {filterIds.map((f) => {
              const label =
                f === PAST_FILTER
                  ? t(p.block("filters.past", PAST_LABEL))
                  : t(p.block("filters.upcoming", UPCOMING_LABEL));
              const active = filter === f;
              return (
                <button
                  key={f}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(f)}
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

          {nothing ? (
            <section className="container-editorial pb-32">
              <div className="border border-border p-8 md:p-10">
                <p className="text-sm leading-relaxed text-muted-foreground">{emptyText}</p>
                {/* 只在「報名中是空的、而且真的有辦過」時才給這顆按鈕。
                沒有這個條件的話，按下去只是換到另一頁空白 —— 那比沒有按鈕更糟。 */}
                {!isPastTab && hasAnyPast ? (
                  <button
                    type="button"
                    onClick={() => setFilter(PAST_FILTER)}
                    className="mt-8 inline-block border border-foreground px-5 py-3 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors text-base"
                  >
                    {t(p.block("seePast", SEE_PAST))}
                  </button>
                ) : null}
              </div>
            </section>
          ) : (
            <div className="pb-20">
              {journeyList.length > 0 ? (
                <section
                  className="container-editorial pb-12"
                  data-testid="events-journeys-section"
                  aria-label={t(SECTION_LABELS.journey)}
                >
                  {sectioned ? (
                    <SectionHeading label={t(SECTION_LABELS.journey)} count={journeyList.length} />
                  ) : null}
                  <div className={journeyLayout.grid}>
                    {journeyList.map((j) => {
                      const linked = linkedEventFor(j.externalUrl, journeyEvents);
                      return (
                        <JourneyCard
                          key={j.id}
                          journey={j}
                          linked={linked}
                          facts={
                            linked
                              ? listingFactsForCard(linked, listing[eventProductSlug(linked.slug)])
                              : undefined
                          }
                          layout={journeyLayout}
                          pastBadge={isPastTab ? pastBadge : null}
                        />
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {eventList.length > 0 ? (
                <section
                  className="container-editorial pb-12"
                  data-testid="events-events-section"
                  aria-label={t(SECTION_LABELS.event)}
                >
                  {sectioned ? (
                    <SectionHeading label={t(SECTION_LABELS.event)} count={eventList.length} />
                  ) : null}
                  <div className={eventLayout.grid}>
                    {eventList.map((e) => (
                      // 整張卡片不是連結（唯一的連結是底下那顆「活動詳情」），所以不加 CARD_HOVER。
                      <article key={e.id} className={`${CARD} ${eventLayout.card}`}>
                        {/* ⚠️ 先判斷 imageKey 非空**再**呼叫 imageFor()。imageFor(key, fallback)
                        永遠會回一張圖，順序反過來就是每一張卡片都長同一張不相干的照片
                        （見 EventEntry.imageKey）。沒設封面的活動就是沒有圖，不放佔位。 */}
                        {e.imageKey ? (
                          <CoverImage
                            src={imageFor(e.imageKey, eventImg)}
                            alt={t(e.title)}
                            loading="lazy"
                            className={`aspect-[4/3] ${eventLayout.image}`}
                          />
                        ) : null}
                        {/* 按鈕靠摘要的 flex-1 推到卡片底部，同一列的按鈕因此對齊；只有一場時
                        featureLayout 給 summary 的 md:flex-none 會把它拿掉，讓整段文字在
                        橫版裡垂直置中（見 feature-layout.ts）。 */}
                        <div className={`flex flex-1 flex-col p-6 ${eventLayout.body}`}>
                          {/* 已結束要在卡片上看得出來 —— 分享出去的連結、從搜尋進來的人
                          都不會看到那個分頁。分類字 2026-11-10 拿掉（業主：「活動分類功能都拿掉」）。 */}
                          {isEventPast(e) || e.privateBooking ? (
                            <p className="flex flex-wrap gap-2">
                              {isEventPast(e) ? (
                                <span className="border border-border px-2 py-0.5 text-xs tracking-widest text-muted-foreground">
                                  {pastBadge}
                                </span>
                              ) : null}
                              {/* 包場：不開放報名（src/lib/private-booking.ts）。 */}
                              {e.privateBooking ? <PrivateBookingBadge /> : null}
                            </p>
                          ) : null}
                          {/* h2（2026-11 SEO 健檢 L4：原本 h1 直接跳 h3）；h1–h5 樣式相同，畫面不變。 */}
                          <h2
                            className={`display text-2xl leading-snug ${isEventPast(e) || e.privateBooking ? "mt-4" : ""} ${eventLayout.title}`}
                          >
                            {t(e.title)}
                          </h2>
                          <p className="mt-4 text-sm text-muted-foreground">{e.date}</p>
                          <p
                            className={`mt-4 text-sm leading-relaxed text-foreground/75 flex-1 ${eventLayout.summary}`}
                          >
                            {t(e.summary)}
                          </p>
                          {/* 只留站內的詳情頁（外部連結多半是 0001 的 example.com 種子資料）。 */}
                          <div className="mt-8">
                            <Link
                              to="/events/$slug"
                              params={{ slug: e.slug }}
                              className="inline-block border border-foreground px-5 py-3 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors text-base"
                            >
                              {t(p.block("detail", DETAIL))}
                            </Link>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          )}

          {/* 只在「報名中」這一格畫：切到「已結束」時上面的列表就是完整版，再畫一次是重複。 */}
          {!isPastTab ? (
            <PastShelf
              testId="events-past-shelf"
              eyebrow={shelfCopy.eyebrow}
              title={shelfCopy.title}
              badge={pastBadge}
              items={shelfItems}
              cta={
                shelfCopy.cta ? (
                  <button
                    type="button"
                    onClick={showAllPast}
                    className="inline-block tracking-widest text-clay hover-underline text-base"
                  >
                    {shelfCopy.cta} →
                  </button>
                ) : undefined
              }
            />
          ) : null}
        </div>
      ) : null}

      {/* 策旅合作共創（原 /journeys 頁尾）。只在看策旅時出現；文案讀 pages/'journeys' 的區塊。 */}
      {type === "journey" ? (
        <section className="container-editorial pb-32" data-testid="events-journey-cocreate">
          <div className="border-t border-border pt-16 grid md:grid-cols-2 gap-10">
            <div>
              <p className="eyebrow text-2xl">
                {t(jp.block("coCreateEyebrow", JOURNEY_COPY.coCreateEyebrow))}
              </p>
              <h2 className="display mt-4 text-3xl md:text-4xl">
                {t(jp.block("collab", JOURNEY_COPY.collab))}
              </h2>
            </div>
            <div>
              <p className="text-base leading-relaxed text-foreground/80">
                {t(jp.block("collabBody", JOURNEY_COPY.collabBody))}
              </p>
              <a
                href={`mailto:${contactEmail}`}
                className="mt-6 inline-block border border-foreground px-6 py-3 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors text-base break-all"
              >
                {contactEmail}
              </a>
            </div>
          </div>
        </section>
      ) : null}
    </PageShell>
  );
}

/** 「全部」時兩段（策旅／活動）各自的小標，樣式與首頁「近期活動與策旅」的小標一致。 */
function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-6 flex items-baseline justify-between gap-6 border-b border-border pb-2 md:pb-3">
      <h2 className="font-serif text-xl md:text-2xl">{label}</h2>
      <span className="text-sm tracking-widest text-muted-foreground tabular-nums">{count}</span>
    </div>
  );
}
