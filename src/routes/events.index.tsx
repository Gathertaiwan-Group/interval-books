import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { isPastEvent } from "@/lib/event-status";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { eyebrowOf, fetchEventCategories, fetchEvents, fetchPage, pageText } from "@/lib/cms";
import { CARD, featureLayout } from "@/lib/feature-layout";
import { useSiteContent } from "@/lib/site-content";
import { imageFor } from "@/lib/images";
import eventImg from "@/assets/event-reading.jpg";

/**
 * 活動列表頁。
 *
 * 🔴 檔名是 events.index.tsx，不是 events.tsx。flat routing 下 `events.tsx` 會變成
 *    /events 底下所有路由的 parent layout —— 它得渲染 <Outlet />，否則
 *    /events/$slug 就是一片空白。repo 自己的慣例已經給了答案：沒有 shop.tsx，
 *    只有 shop.index.tsx + shop.$slug.tsx。這一組照抄。
 */

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "活動 Events｜小時光書店 Interval Books",
    en: "Events｜Interval Books",
    ja: "イベント｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "讀書會、療癒生活節、策旅說明會、陶藝家展售、身心靈工作坊與好書交流——本頁為策展式彙整，每場活動皆有獨立網站。",
    en: "Reading circles, healing festivals, journey briefings, ceramicist showcases, somatic workshops, and book exchanges — a curated overview; each event has its own site.",
    ja: "読書会、ヒーリング・フェス、旅の説明会、陶芸家の展示販売、ソマティック・ワークショップ、本の交流。各イベントには専用サイトがあります。",
  },
  eyebrowSuffix: { zh: "活動", en: "Events", ja: "イベント" },
  title: {
    zh: "閱讀，是一種共同進行的生活",
    en: "Reading, a life held in common",
    ja: "読むことは、ともにある暮らし",
  },
  intro: {
    zh: "每一場活動都有獨立的網站。本頁僅作為策展式彙整，幫助你在書店發生的事情之間，找到屬於自己的節奏。",
    en: "Each event has its own site. This page is a curated overview — find your own rhythm among what unfolds in the bookshop.",
    ja: "各イベントには専用サイトがあります。このページはキュレーションされた目次として、書店で起きることのなかから、ご自身のリズムを見つけていただくためのものです。",
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
 * /admin/pages/events 可以改字。
 */
const EMPTY_UPCOMING = {
  zh: "目前沒有開放報名的活動。新的場次公布前，歡迎先看看我們辦過什麼。",
  en: "No events are open for registration right now. In the meantime, take a look at what we have held.",
  ja: "現在受付中のイベントはありません。これまでに開催したイベントをご覧ください。",
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

export const Route = createFileRoute("/events/")({
  loader: async () => {
    const [page, events, categories] = await Promise.all([
      fetchPage("events"),
      fetchEvents(),
      fetchEventCategories(),
    ]);
    return { page, events, categories };
  },
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    const ogImg = imageFor(loaderData?.page?.ogImageKey, eventImg);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:image", content: ogImg },
        { name: "twitter:image", content: ogImg },
      ],
    };
  },
  component: Events,
});

function Events() {
  const t = useT();
  const { page, events, categories } = Route.useLoaderData();
  const p = pageText(page);
  const { ui } = useSiteContent();
  const heroSrc = imageFor(page?.ogImageKey, eventImg);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
    ogImage: heroSrc,
  });

  const labelById = new Map(categories.map((c) => [c.id, c.label] as const));
  // 「已結束」不是一個 event_categories 的分類，是一個時間狀態，所以它是一個
  // 寫死的哨兵 id 而不是從 categories 來的。放在最後一格。
  // 篩選只有兩格：報名中 / 已結束。
  //
  // 這裡原本還有六到七個分類（讀書會、療癒生活節、陶藝工作坊…），但那些對訪客
  // 不是有用的切法 —— 一家書店同時開放報名的活動通常只有個位數，分類篩完往往
  // 只剩一則，而按下去之前沒人知道會不會是空的。真正會影響行為的問題只有一個：
  // 「這場我還報得到名嗎」。所以留下的兩格就是那個問題的兩個答案。
  //
  // 分類本身沒有消失 —— 每張卡片的 eyebrow 仍然印著它，那是**描述**這場活動是
  // 什麼，與**篩選**是兩回事。categories 因此仍然要載入（labelById 要用）。
  const UPCOMING_FILTER = "__upcoming__";
  const PAST_FILTER = "__past__";
  const filterIds = [UPCOMING_FILTER, PAST_FILTER];

  const [filter, setFilter] = useState<string>(UPCOMING_FILTER);

  // 🔴 已結束的活動**只有在「已結束」那一格才找得到**。辦過的活動留在站上是為了
  //    讓人看得到我們辦過什麼，不是為了讓人以為還能報名。
  const upcoming = events.filter((e) => !isPastEvent(e.isoDate));
  const past = events.filter((e) => isPastEvent(e.isoDate));
  const list = filter === PAST_FILTER ? past : upcoming;
  // 卡片排法跟首頁同一套（src/lib/feature-layout.ts）：1 場＝橫版左圖右字佔滿寬，
  // 2 場兩欄，3 場以上 md 兩欄／lg 三欄。算的是「目前這一格」的筆數，切到
  // 「已結束」會跟著重算。0 場不畫格線，走下面的空狀態。
  const layout = featureLayout(list.length);

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Events", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <section className="container-editorial pb-12">
        <div className="mx-auto w-4/5 aspect-[3/4] md:aspect-[16/10] overflow-hidden bg-muted">
          <img
            src={heroSrc}
            alt={t(p.title(PAGE.title))}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        </div>
      </section>

      <section className="container-editorial pb-12 flex flex-wrap gap-3 text-xs tracking-widest">
        {filterIds.map((f) => {
          const label =
            f === PAST_FILTER
              ? t(p.block("filters.past", PAST_LABEL))
              : t(p.block("filters.upcoming", UPCOMING_LABEL));
          const active = filter === f;
          return (
            <button
              key={f}
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

      {list.length === 0 ? (
        <section className="container-editorial pb-32">
          <div className="border border-border p-8 md:p-10">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {filter === PAST_FILTER
                ? t(p.block("emptyPast", EMPTY_PAST))
                : t(p.block("emptyUpcoming", EMPTY_UPCOMING))}
            </p>
            {/* 只在「報名中是空的、而且真的有辦過活動」時才給這顆按鈕。
                沒有這個條件的話，按下去只是換到另一頁空白 —— 那比沒有按鈕更糟。 */}
            {filter !== PAST_FILTER && past.length > 0 ? (
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
        <section className={`container-editorial pb-32 ${layout.grid}`}>
          {list.map((e) => (
            // 整張卡片不是連結（唯一的連結是底下那顆「活動詳情」），所以不加 CARD_HOVER。
            <article key={e.id} className={`${CARD} ${layout.card}`}>
              {/* ⚠️ 先判斷 imageKey 非空**再**呼叫 imageFor()。imageFor(key, fallback)
                  永遠會回一張圖，順序反過來就是每一張卡片都長同一張不相干的照片
                  （見 EventEntry.imageKey）。沒設封面的活動就是沒有圖，不放佔位。 */}
              {e.imageKey ? (
                <div className={`aspect-[4/3] overflow-hidden ${layout.image}`}>
                  <img
                    src={imageFor(e.imageKey, eventImg)}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </div>
              ) : null}
              {/* 按鈕靠摘要的 flex-1 推到卡片底部，同一列的按鈕因此對齊；只有一場時
                  featureLayout 給 summary 的 md:flex-none 會把它拿掉，讓整段文字在
                  橫版裡垂直置中（見 feature-layout.ts）。不用 mt-auto：auto margin 會
                  先吃掉剩餘空間，橫版的 md:justify-center 就失效了。 */}
              <div className={`flex flex-1 flex-col p-6 ${layout.body}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <p className="eyebrow text-sm tracking-widest">
                    {t(
                      labelById.get(e.category) ?? {
                        zh: e.category,
                        en: e.category,
                        ja: e.category,
                      },
                    )}
                  </p>
                  {/* 已結束要在卡片上看得出來 —— 只靠「它在另一個分頁底下」不夠：
                    分享出去的連結、從搜尋進來的人都不會看到那個分頁。 */}
                  {isPastEvent(e.isoDate) ? (
                    <span className="border border-border px-2 py-0.5 text-xs tracking-widest text-muted-foreground">
                      {t(p.block("filters.pastBadge", PAST_BADGE))}
                    </span>
                  ) : null}
                </div>
                <h3 className={`display mt-4 text-2xl leading-snug ${layout.title}`}>
                  {t(e.title)}
                </h3>
                <p className="mt-4 text-sm text-muted-foreground">{e.date}</p>
                <p
                  className={`mt-4 text-sm leading-relaxed text-foreground/75 flex-1 ${layout.summary}`}
                >
                  {t(e.summary)}
                </p>
                {/* 只留站內的詳情頁。原本旁邊還有一顆「前往活動網站」連到
                  events.external_url —— 但正式庫七場活動裡有五場的那一欄還是
                  https://example.com/event-N（0001 的種子資料，從未替換），所以
                  那顆按鈕多半是把人送去一個不存在的地方。活動詳情頁存在之後，
                  站內那一頁本來就是我們說得最清楚的地方；真的有外部售票連結時，
                  由詳情頁自己決定要不要顯示。 */}
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
        </section>
      )}
    </PageShell>
  );
}
