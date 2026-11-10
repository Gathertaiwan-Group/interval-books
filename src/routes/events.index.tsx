import { createFileRoute, Link } from "@tanstack/react-router";
import { journeyKicker } from "@/lib/journey-events";
import { useEffect, useState } from "react";
import { CalendarDays, List } from "lucide-react";
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
import { PrivateBookingBadge, RegistrationClosedBadge } from "@/components/ListingBits";
import { cardRail, RAIL_HINT } from "@/lib/card-rail";
import { splitAtComma } from "@/lib/title-break";
import { nextSessionClosedSlugs, nextStartBySlug, sortByNextStart } from "@/lib/upcoming-order";
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

/** 過往區卡片上的「已結束」小標（page_block filters.pastBadge 可覆寫）。 */
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
 * 2026-11-10 起頂部的「報名中／已結束」切換拿掉（已結束的一律在頁面最下方「過往」區），
 * 所以只剩「目前沒有開放報名」這一種空狀態（依類型三種寫法）。
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
/**
 * 「過往活動」卡片區（2026-10-28 店長：「這邊下方，幫我多一區，用卡片的形式，去展現
 * 已經辦過的活動」）。畫在列表最下方；2026-11-10 起它是已結束場次唯一的入口（頂部切換拿掉），
 * 先列 PAST_SHELF_LIMIT 張，多的按「看全部過往」展開。資料就是同一份 events，不多查一次。
 */
const PAST_SHELF = {
  eyebrow: { zh: "PAST EVENTS", en: "PAST EVENTS", ja: "PAST EVENTS" },
  title: { zh: "過往活動", en: "Past events", ja: "これまでのイベント" },
};
const PAST_MORE = {
  more: { zh: "看全部過往", en: "See all past", ja: "過去分をすべて見る" },
  less: { zh: "收合", en: "Show fewer", ja: "閉じる" },
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
    zh: "若您是地方夥伴、職人、旅宿或品牌，歡迎與我們共創一段台灣地方的策旅。填寫合作表單，或直接來信。",
    en: "If you're a local partner, maker, hotel, or brand, we'd love to co-create a journey somewhere in Taiwan. Fill in the partnership form, or simply email us.",
    ja: "地域のパートナー、作り手、宿、ブランドの方へ。台湾の土地をめぐる旅を、ともにつくりませんか。ご相談フォームから、またはメールで直接どうぞ。",
  },
  /** 2026-11-10 文案健檢 E3：共創段加一顆按鈕連到 /partnership 的合作表單。 */
  collabCta: { zh: "填寫合作表單", en: "Partnership form", ja: "ご相談フォームへ" },
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

/** 月曆／列表切換鈕（一顆圖示）的 aria-label：鈕上顯示的是「要切過去」的那個檢視。 */
const VIEW_LABELS = {
  toggle: {
    calendar: { zh: "切換月曆", en: "Switch to calendar", ja: "カレンダー表示に切り替え" },
    list: { zh: "切換列表", en: "Switch to list", ja: "リスト表示に切り替え" },
  },
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

  // 2026-11-10 業主看手機版：「篩選設計現在太複雜，我要畫面簡潔；活動卡片用左右滑動。」
  //   · 控制收成一排：左邊「全部・活動・策旅」（?type=，網址狀態），右邊一顆小的月曆／列表圖示。
  //   · 「報名中／已結束」切換拿掉：主體只放還沒結束的；已結束的全部收到頁面最下方「過往」區。
  //   · 手機上策旅、活動各一列橫滑卡片（src/lib/card-rail.ts，與首頁同一組 class）。
  // 分類（讀書會、陶藝工作坊…）2026-11-10 起也不再顯示（業主：「活動分類功能都拿掉」）。
  const wantEvents = showsEvents(type);
  const wantJourneys = showsJourneys(type);

  // 🔴 已結束的活動不放進主體，只在最下方「過往」區。辦過的活動留在站上是為了讓人看得到
  //    我們辦過什麼，不是為了讓人以為還能報名。
  // 由近到遠：下一個尚未結束的場次開始時間（月曆資料，含包場場次）；沒有場次時間的排最後。
  // 規則見 src/lib/upcoming-order.ts（2026-11-10 業主：「活動都是先顯示日期最近的」）。
  const nextStarts = nextStartBySlug(calendar.entries);
  // 下一個未結束場次是「報名截止」的活動：卡片標報名截止（排序不變）。
  const closedNext = nextSessionClosedSlugs(calendar.entries);
  const eventList = wantEvents
    ? sortByNextStart(
        events.filter((e) => !isEventPast(e)),
        (e) => nextStarts.get(e.slug),
      )
    : [];
  // 策旅的「已結束」＝卡片指著的那場活動已結束（判準見 src/lib/past-shelf.ts，與首頁同一支）。
  // 過往區可以展開看全部，所以 limit 給到整份清單的長度。
  const split = splitJourneys(allJourneys, journeyEvents, allJourneys.length);
  const journeyList = wantJourneys
    ? sortByNextStart(split.open, (j) => {
        const linked = linkedEventFor(j.externalUrl, journeyEvents);
        return linked ? nextStarts.get(linked.slug) : undefined;
      })
    : [];
  const nothing = eventList.length === 0 && journeyList.length === 0;
  // 「全部」時兩段各有小標；只看一種時不需要。
  const sectioned = type === undefined;

  // 卡片排法：md 以上跟首頁同一套 featureLayout（1 場橫版、2 場兩欄、3 場以上三欄）；
  // 手機兩張以上改成橫滑一列（cardRail），一張時全寬、不顯示滑動提示。
  const eventLayout = featureLayout(eventList.length);
  const journeyLayout = featureLayout(journeyList.length);
  const eventRail = cardRail(eventList.length);
  // LCP（2026-11-10 Lighthouse mobile 7–13 秒：LCP 是第一張卡片 lazy 的模糊底）：首屏只有
  // 「第一段的第一張卡」看得到（策旅段在前；沒有策旅才是活動段），只給它 priority，一頁一張。
  // 第二段的第一張在手機首屏之下，給了只會跟它搶頻寬。明確選月曆時列表不畫，就不給。
  const listPriority = view !== "calendar";
  const journeyRail = cardRail(journeyList.length);

  // 過往區：依類型挑來源，「全部」時依結束日合併。先列 PAST_SHELF_LIMIT 張，其餘按「看全部」展開。
  const pastEventItems = wantEvents
    ? newestEndedFirst(events, events.length).map(
        (e): { endDate: string; item: PastShelfItem } => ({
          endDate: effectiveEndDate(e),
          item: {
            key: e.id,
            title: t(e.title),
            category: "",
            date: e.date,
            image: e.imageKey ? imageFor(e.imageKey, eventImg) : null,
            link: { kind: "event" as const, slug: e.slug },
            privateBooking: e.privateBooking,
          },
        }),
      )
    : [];
  const pastJourneyItems = wantJourneys
    ? split.ended.map(({ journey: j, event: e }): { endDate: string; item: PastShelfItem } => {
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
      })
    : [];
  const allPast = mergeNewestEnded(
    pastJourneyItems,
    pastEventItems,
    pastJourneyItems.length + pastEventItems.length,
  ).map((x) => x.item);
  const [showAllPast, setShowAllPast] = useState(false);
  const shelfItems = showAllPast ? allPast : allPast.slice(0, PAST_SHELF_LIMIT);
  const shelfCopy =
    type === "journey"
      ? {
          eyebrow: t(jp.block("pastEyebrow", JOURNEY_COPY.pastEyebrow)),
          title: t(jp.block("pastTitle", JOURNEY_COPY.pastTitle)),
        }
      : type === "event"
        ? {
            eyebrow: t(p.block("past.eyebrow", PAST_SHELF.eyebrow)),
            title: t(p.block("past.title", PAST_SHELF.title)),
          }
        : { eyebrow: t(PAST_SHELF_ALL.eyebrow), title: t(PAST_SHELF_ALL.title) };

  const pastBadge = t(p.block("filters.pastBadge", PAST_BADGE));
  const emptyText =
    type === "journey"
      ? t(jp.block("emptyOpen", JOURNEY_COPY.emptyOpen))
      : type === "event"
        ? t(p.block("emptyUpcoming", EMPTY_UPCOMING))
        : t(EMPTY_UPCOMING_ALL);

  // 月曆／列表切換鈕：顯示「另一個」檢視的圖示。沒帶 ?view（自動：手機列表、桌機月曆）而且
  // 還沒掛載時，用 CSS 斷點各畫一顆，SSR 與 hydrate 不跳。
  const toggle = (target: EventsView, cls = "") => (
    <Link
      to="/events"
      search={
        target === "calendar" ? { view: target, month: search.month, type } : { view: target, type }
      }
      resetScroll={false}
      aria-label={t(VIEW_LABELS.toggle[target])}
      title={t(VIEW_LABELS.toggle[target])}
      data-testid={`events-view-${target}`}
      className={`inline-flex h-11 w-11 shrink-0 items-center justify-center text-foreground/70 transition-colors hover:text-foreground ${cls}`}
    >
      {target === "calendar" ? (
        <CalendarDays className="h-5 w-5" aria-hidden="true" />
      ) : (
        <List className="h-5 w-5" aria-hidden="true" />
      )}
    </Link>
  );

  return (
    <PageShell>
      <PageHeader
        compact
        // 只放頁名（2026-11-10 手機簡化：「EVENTS & JOURNEYS ／ 活動與策旅」在 390 寬會折行）。
        eyebrow={t(NAME)}
        // 在逗號後換行（「在書店相遇，／走進台灣的土地」），不會從詞中間斷；三語都適用。
        title={splitAtComma(t(p.title(PAGE.title))).map((part, i) => (
          <span key={i} className="inline-block">
            {part}
          </span>
        ))}
        intro={t(p.intro(PAGE.intro))}
      />

      {/* 控制列：一排。左邊類型（文字分頁，選中畫底線），右邊月曆／列表圖示。 */}
      <div className="container-editorial pb-6 md:pb-10">
        <div className="flex items-center justify-between gap-4 border-b border-border">
          <nav aria-label={t(TYPE_LABELS.aria)} data-testid="events-type-filter">
            <ul className="flex items-center gap-5 text-sm tracking-widest md:gap-8">
              {EVENTS_TYPE_OPTIONS.map((opt) => {
                const active = optionFor(type) === opt;
                const label =
                  opt === "all" ? t(p.block("filters.all", TYPE_LABELS.all)) : t(TYPE_LABELS[opt]);
                return (
                  <li key={opt}>
                    <Link
                      to="/events"
                      search={{ view: search.view, month: search.month, type: typeParamFor(opt) }}
                      resetScroll={false}
                      // exact：search 要完全相等才算「目前這一格」。預設是部分比對，/events?type=journey
                      // 會讓「全部」（search 裡沒有 type）也被框架標成 active、多一個 aria-current。
                      activeOptions={{ exact: true }}
                      aria-current={active ? "page" : undefined}
                      data-testid={`events-type-${opt}`}
                      className={`-mb-px inline-flex min-h-11 items-center border-b-2 transition-colors ${
                        active
                          ? "border-foreground text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          {view === null ? (
            <>
              {toggle("calendar", "md:hidden")}
              {toggle("list", "max-md:hidden")}
            </>
          ) : (
            toggle(view === "list" ? "calendar" : "list")
          )}
        </div>
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
          {nothing ? (
            <section className="container-editorial pb-16">
              <div className="border border-border p-8 md:p-10">
                <p className="text-sm leading-relaxed text-muted-foreground">{emptyText}</p>
              </div>
            </section>
          ) : (
            <div className="pb-8 md:pb-16">
              {journeyList.length > 0 ? (
                <section
                  className="container-editorial pb-10 md:pb-12"
                  data-testid="events-journeys-section"
                  aria-label={t(SECTION_LABELS.journey)}
                >
                  {sectioned ? <SectionHeading label={t(SECTION_LABELS.journey)} /> : null}
                  <div className={`${journeyLayout.grid} ${journeyRail.track}`}>
                    {journeyList.map((j, i) => {
                      const linked = linkedEventFor(j.externalUrl, journeyEvents);
                      return (
                        <JourneyCard
                          key={j.id}
                          journey={j}
                          linked={linked}
                          facts={
                            linked
                              ? listingFactsForCard(
                                  linked,
                                  listing[eventProductSlug(linked.slug)],
                                  closedNext.has(linked.slug),
                                )
                              : undefined
                          }
                          layout={journeyLayout}
                          pastBadge={null}
                          className={journeyRail.item}
                          priority={listPriority && i === 0}
                        />
                      );
                    })}
                  </div>
                  <RailHint count={journeyList.length} />
                </section>
              ) : null}

              {eventList.length > 0 ? (
                <section
                  className="container-editorial pb-10 md:pb-12"
                  data-testid="events-events-section"
                  aria-label={t(SECTION_LABELS.event)}
                >
                  {sectioned ? <SectionHeading label={t(SECTION_LABELS.event)} /> : null}
                  <div className={`${eventLayout.grid} ${eventRail.track}`}>
                    {eventList.map((e, i) => (
                      // 整張卡片不是連結（唯一的連結是底下那顆「活動詳情」），所以不加 CARD_HOVER。
                      <article
                        key={e.id}
                        className={`${CARD} ${eventLayout.card} ${eventRail.item}`}
                      >
                        {/* ⚠️ 先判斷 imageKey 非空**再**呼叫 imageFor()。imageFor(key, fallback)
                        永遠會回一張圖，順序反過來就是每一張卡片都長同一張不相干的照片
                        （見 EventEntry.imageKey）。沒設封面的活動就是沒有圖，不放佔位。 */}
                        {e.imageKey ? (
                          <CoverImage
                            src={imageFor(e.imageKey, eventImg)}
                            alt={t(e.title)}
                            loading="lazy"
                            priority={listPriority && journeyList.length === 0 && i === 0}
                            className={`aspect-[4/3] ${eventLayout.image}`}
                          />
                        ) : null}
                        {/* 按鈕靠摘要的 flex-1 推到卡片底部，同一列的按鈕因此對齊；只有一場時
                        featureLayout 給 summary 的 md:flex-none 會把它拿掉，讓整段文字在
                        橫版裡垂直置中（見 feature-layout.ts）。 */}
                        <div className={`flex flex-1 flex-col p-5 md:p-6 ${eventLayout.body}`}>
                          {/* 包場：不開放報名（src/lib/private-booking.ts）。主體只放還沒結束的場次，
                          所以這裡不再需要「已結束」小標（已結束的在最下方過往區）。 */}
                          <div className="mb-3 flex flex-wrap gap-2 empty:hidden">
                            {e.privateBooking ? (
                              <PrivateBookingBadge />
                            ) : closedNext.has(e.slug) ? (
                              <RegistrationClosedBadge />
                            ) : null}
                          </div>
                          {/* h2（2026-11 SEO 健檢 L4：原本 h1 直接跳 h3）；h1–h5 樣式相同，畫面不變。 */}
                          <h2
                            className={`display text-xl leading-snug md:text-2xl ${eventLayout.title}`}
                          >
                            {t(e.title)}
                          </h2>
                          <p className="mt-3 text-sm text-muted-foreground md:mt-4">{e.date}</p>
                          <p
                            className={`mt-3 line-clamp-3 text-sm leading-relaxed text-foreground/75 flex-1 md:mt-4 md:line-clamp-none ${eventLayout.summary}`}
                          >
                            {t(e.summary)}
                          </p>
                          {/* 只留站內的詳情頁（外部連結多半是 0001 的 example.com 種子資料）。 */}
                          <div className="mt-6 md:mt-8">
                            <Link
                              to="/events/$slug"
                              params={{ slug: e.slug }}
                              className="inline-flex min-h-11 items-center border border-foreground px-5 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors text-base"
                            >
                              {t(p.block("detail", DETAIL))}
                            </Link>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                  <RailHint count={eventList.length} />
                </section>
              ) : null}
            </div>
          )}

          {/* 過往：頁面最下方，取代原本頂部的「報名中／已結束」切換。零筆時 PastShelf 自己不畫。 */}
          <div id="past" className="scroll-mt-24">
            <PastShelf
              testId="events-past-shelf"
              eyebrow={shelfCopy.eyebrow}
              title={shelfCopy.title}
              badge={pastBadge}
              items={shelfItems}
              cta={
                allPast.length > PAST_SHELF_LIMIT ? (
                  <button
                    type="button"
                    onClick={() => setShowAllPast((v) => !v)}
                    aria-expanded={showAllPast}
                    className="inline-flex min-h-11 items-center tracking-widest text-clay hover-underline text-base"
                  >
                    {showAllPast ? t(PAST_MORE.less) : `${t(PAST_MORE.more)}（${allPast.length}）`}{" "}
                    →
                  </button>
                ) : undefined
              }
            />
          </div>
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
              <div className="mt-6 flex flex-wrap items-center gap-4">
                <Link
                  to="/partnership"
                  data-testid="events-journey-partnership"
                  className="inline-block border border-foreground bg-foreground px-6 py-3 tracking-widest text-primary-foreground transition-opacity hover:opacity-85 text-base"
                >
                  {t(jp.block("collabCta", JOURNEY_COPY.collabCta))}
                </Link>
                <a
                  href={`mailto:${contactEmail}`}
                  className="inline-block border border-foreground px-6 py-3 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors text-base break-all"
                >
                  {contactEmail}
                </a>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </PageShell>
  );
}

/** 「全部」時兩段（策旅／活動）各自的小標。低調：細字、無計數。 */
function SectionHeading({ label }: { label: string }) {
  return (
    <h2 className="mb-4 font-serif text-lg text-foreground/80 md:mb-6 md:text-2xl">{label}</h2>
  );
}

/** 手機橫滑列底下的提示。一張時不畫（不需要滑）；md 以上不畫（桌機是格線）。 */
function RailHint({ count }: { count: number }) {
  const t = useT();
  if (count < 2) return null;
  return (
    <p
      className="mt-3 text-xs tracking-[0.12em] text-muted-foreground md:hidden"
      aria-hidden="true"
    >
      {t(RAIL_HINT).replace("{n}", String(count))}
      <span className="ml-1">→</span>
    </p>
  );
}
