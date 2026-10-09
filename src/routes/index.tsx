import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchEvents, fetchJourneys, fetchNews, fetchPage, pageText } from "@/lib/cms";
import { useSiteContent } from "@/lib/site-content";
import { isPastEvent } from "@/lib/event-status";
import { CARD, featureLayout } from "@/lib/feature-layout";
import { imageFor } from "@/lib/images";
import heroImg from "@/assets/hero-mountain.jpg";
import storefrontImg from "@/assets/storefront.jpg";
import curatedImg from "@/assets/curated-objects.jpg";
import journeyImg from "@/assets/journey-mist.jpg";
import { journeyLinkProps } from "@/lib/journey-link";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE_META = {
  title: {
    zh: "小時光書店 Interval Books｜風土誌策展的閱讀與生活場域",
    en: "Interval Books｜A curated home for reading, terroir, and quiet life",
    ja: "小時光書店 Interval Books｜風土誌をキュレーションする読書と暮らしの場",
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

const ENTRIES = {
  events: { zh: "看活動", en: "Events", ja: "イベント" },
  eventsDesc: {
    zh: "讀書會、講座、工作坊與身心靈活動。",
    en: "Reading circles, talks, workshops, and healing practice.",
    ja: "読書会、トーク、ワークショップ、ヒーリング。",
  },
  journeys: { zh: "看策旅", en: "Journeys", ja: "旅" },
  journeysDesc: {
    zh: "由書與土地共同寫成的深度旅程。",
    en: "Slow journeys co-written by books and the land.",
    ja: "本と土地が共に綴る、深い旅。",
  },
  visit: { zh: "來店資訊", en: "Visit", ja: "ご来店" },
  visitDesc: {
    zh: "華山，紅磚六合院，西7-3館。",
    en: "Huashan, Red Brick Courtyard, West 7-3.",
    ja: "華山、紅煉瓦六合院、西7-3館。",
  },
  explore: { zh: "Explore", en: "Explore", ja: "Explore" },
  goTo: { zh: "前往", en: "Enter", ja: "見る" },
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

/** entryCards page_list_items fallback — position 0/1/2 map to /events, /journeys, /visit. */
const ENTRY_CARDS_FALLBACK = [
  { label: ENTRIES.events, note: ENTRIES.eventsDesc, imageKey: null },
  { label: ENTRIES.journeys, note: ENTRIES.journeysDesc, imageKey: null },
  { label: ENTRIES.visit, note: ENTRIES.visitDesc, imageKey: null },
];
const ENTRY_LINKS = ["/events", "/journeys", "/visit"] as const;

/** Latin section eyebrows — same string in all three languages, matching current output. */
const SECTION_EYEBROWS = {
  journeys: { zh: "Journeys", en: "Journeys", ja: "Journeys" },
  news: { zh: "News", en: "News", ja: "News" },
};

export const Route = createFileRoute("/")({
  loader: async () => {
    const [page, events, journeys, news] = await Promise.all([
      fetchPage("index"),
      fetchEvents(),
      fetchJourneys(),
      fetchNews(),
    ]);
    return { page, events, journeys, news };
  },
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    const ogImg = imageFor(loaderData?.page?.ogImageKey, heroImg);
    return {
      meta: [
        { title: p.metaTitle(PAGE_META.title).zh },
        { name: "description", content: p.metaDescription(HERO.intro).zh },
        { property: "og:title", content: p.ogTitle(HERO.titleSub).zh },
        { property: "og:description", content: p.metaDescription(HERO.intro).zh },
        { property: "og:image", content: ogImg },
        { name: "twitter:image", content: ogImg },
      ],
    };
  },
  component: Index,
});

function Index() {
  const t = useT();
  const { page, events, journeys, news } = Route.useLoaderData();

  // 策旅與活動用同一種卡片、同一套版面規則（見 featureLayout），所以這裡也
  // 取到三筆，而不是像以前那樣只挑一筆做成橫幅。
  const featuredJourneys = journeys.slice(0, 3);
  // 🔴 一趟策旅在資料上是**兩列**：events 那一列負責內頁與報名（走活動那一套），
  //    journeys 那一列負責策旅區的卡片。兩區各自取資料，同一趟旅程就會在首頁出現
  //    兩次 —— 自從策旅也改成卡片之後，那兩張還長得一模一樣。
  //
  //    策旅卡片的連結指的就是它自己的活動頁（journeys.external_url 存站內路徑，
  //    見 src/lib/journey-link.ts），所以用那條連結把活動區裡的同一場濾掉。只比對
  //    真的會出現在策旅區的那幾筆：沒被 slice 到的策旅並不佔版面，對應的活動自然
  //    還是該照常出現在活動區。
  const journeyEventSlugs = new Set(
    featuredJourneys
      .map((j) => j.externalUrl.trim())
      .filter((url) => url.startsWith("/events/"))
      .map((url) => url.slice("/events/".length)),
  );
  // 首頁不放已結束的活動 —— 「本月精選」印一場去年辦完的講座沒有意義。
  // 已結束的活動只在 /events 的「已結束」那一格找得到。
  const featuredEvents = events
    .filter((e) => !isPastEvent(e.isoDate) && !journeyEventSlugs.has(e.slug))
    .slice(0, 3);
  const eventsLayout = featureLayout(featuredEvents.length);
  const journeysLayout = featureLayout(featuredJourneys.length);
  const latestNews = news.slice(0, 3);
  const newsLayout = featureLayout(latestNews.length);
  const p = pageText(page);
  const { ui, site, map } = useSiteContent();
  const heroSrc = imageFor(page?.ogImageKey, heroImg);

  useDocumentMeta({
    title: p.metaTitle(PAGE_META.title),
    description: p.metaDescription(HERO.intro),
    ogTitle: p.ogTitle(HERO.titleSub),
    ogImage: heroSrc,
  });

  return (
    <PageShell>
      {/* Hero */}
      <section className="container-editorial pt-16 md:pt-24 pb-20">
        <div className="grid lg:grid-cols-12 gap-10 lg:gap-16 items-end">
          <div className="lg:col-span-6">
            <p className="eyebrow text-2xl">{t(p.block("hero.eyebrow", HERO.eyebrow))}</p>
            <h1 className="display mt-6 text-5xl md:text-7xl lg:text-[5.5rem]">
              {t(p.block("hero.titleMain", HERO.titleMain))}
              <span className="block text-2xl md:text-3xl mt-6 text-muted-foreground font-light">
                {t(p.block("hero.titleSub", HERO.titleSub))}
              </span>
            </h1>
            <p className="mt-10 max-w-lg text-base md:text-lg leading-relaxed text-foreground/75">
              {t(p.block("hero.intro", HERO.intro))}
            </p>
            <div className="rule mt-10" />
            <p className="mt-8 max-w-lg text-sm leading-relaxed text-muted-foreground italic">
              {t(site.shortDesc)}
            </p>
          </div>
          <div className="lg:col-span-6">
            <div className="relative aspect-[4/3] overflow-hidden bg-muted">
              <img
                src={heroSrc}
                alt={t(p.block("hero.titleMain", HERO.titleMain))}
                className="absolute inset-0 h-full w-full object-cover"
                width={1536}
                height={1920}
              />
            </div>
          </div>
        </div>
      </section>

      {/* 精選活動 —— 沒有任何一場就整區（含標題與「查看全部」）不出現 */}
      {featuredEvents.length > 0 && (
        <>
          <SectionHeader
            eyebrow={t(ui.sections.thisMonth)}
            title={t(ui.sections.featuredEvents)}
            link={{ to: "/events", label: t(ui.buttons.viewAll) }}
          />
          {/* ⚠️ 這裡連的是**站內**的 /events/$slug，不是 e.externalUrl。
              0001 的種子資料把 externalUrl 填成 https://example.com/event-N，首頁曾經
              有三顆按鈕直接把客人送去 example.com（那批 ev-1~ev-6 已於 2026-09-12 連同
              content.ts 與 seed.sql 裡的副本一起清掉）。規則不變：活動詳情頁才是正確的
              目的地，外部售票連結留在詳情頁上，由那一頁自己決定要不要顯示。 */}
          <div className={`container-editorial pb-20 ${eventsLayout.grid}`}>
            {featuredEvents.map((e) => (
              <Link
                key={e.id}
                to="/events/$slug"
                params={{ slug: e.slug }}
                className={`group flex flex-col ${eventsLayout.card} border border-border bg-background/40 hover:border-foreground/40 transition-colors`}
              >
                {/* ⚠️ 先判斷 imageKey 非空**再**呼叫 imageFor()。imageFor(key, fallback)
                    永遠會回一張圖，順序反過來就是每一張卡片都長同一張不相干的照片。 */}
                {e.imageKey ? (
                  <div className={`aspect-[4/3] overflow-hidden ${eventsLayout.image}`}>
                    <img
                      src={imageFor(e.imageKey, storefrontImg)}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                  </div>
                ) : null}
                <div className={`flex flex-1 flex-col p-6 ${eventsLayout.body}`}>
                  <p className="eyebrow text-sm tracking-widest">{e.category}</p>
                  <h3 className={`display mt-3 text-2xl leading-snug ${eventsLayout.title}`}>
                    {t(e.title)}
                  </h3>
                  <p className="mt-3 text-sm text-muted-foreground">{e.date}</p>
                  <p
                    className={`mt-4 text-sm leading-relaxed text-foreground/75 flex-1 ${eventsLayout.summary}`}
                  >
                    {t(e.summary)}
                  </p>
                  <span className="mt-6 inline-block tracking-widest text-clay group-hover:underline self-start text-base">
                    {t(ui.buttons.viewEvent)} →
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* 精選策旅 —— 沒有任何一趟就整區不出現 */}
      {featuredJourneys.length > 0 && (
        <>
          <SectionHeader
            eyebrow={t(p.block("sections.journeysEyebrow", SECTION_EYEBROWS.journeys))}
            title={t(ui.sections.featuredJourney)}
            link={{ to: "/journeys", label: t(ui.buttons.viewAll) }}
          />
          <div className={`container-editorial pb-24 ${journeysLayout.grid}`}>
            {featuredJourneys.map((j) => {
              // 策旅的連結可能是站內路徑、也可能是外部網站（見 journeyLinkProps）。
              // 還沒設連結的策旅仍然要看得到卡片，只是整張卡不可點——不要讓它消失。
              const link = journeyLinkProps(j.externalUrl);
              const body = (
                <>
                  {/* journeys 表沒有 image_key（見 cms.ts#fetchJourneys 選的欄位），
                      所以這裡用固定的策旅意象圖，而不是活動卡那種 imageFor()。 */}
                  <div className={`aspect-[4/3] overflow-hidden ${journeysLayout.image}`}>
                    <img
                      src={journeyImg}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                  </div>
                  <div className={`flex flex-1 flex-col p-6 ${journeysLayout.body}`}>
                    <p className="eyebrow text-sm tracking-widest">
                      {t(j.days)} ／ {t(j.theme)}
                    </p>
                    <h3
                      className={`display mt-3 text-2xl leading-snug whitespace-pre-line ${journeysLayout.title}`}
                    >
                      {t(j.title)}
                    </h3>
                    <p
                      className={`mt-4 text-sm leading-relaxed text-foreground/75 flex-1 ${journeysLayout.summary}`}
                    >
                      {t(j.summary)}
                    </p>
                    {link ? (
                      <span className="mt-6 inline-block tracking-widest text-clay group-hover:underline self-start text-base">
                        {t(ui.buttons.toJourney)} →
                      </span>
                    ) : null}
                  </div>
                </>
              );
              const cardClass = `group flex flex-col ${journeysLayout.card} border border-border bg-background/40 transition-colors`;
              return link ? (
                <a key={j.id} {...link} className={`${cardClass} hover:border-foreground/40`}>
                  {body}
                </a>
              ) : (
                <div key={j.id} className={cardClass}>
                  {body}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* 主理人選品預告 */}
      <section className="container-editorial pb-24">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <p className="eyebrow text-2xl">{t(ui.nav.curated)}</p>
            <h2 className="display mt-5 md:text-5xl text-3xl font-mono text-left whitespace-pre-line">
              {t(p.block("entries.curatedTitle", ENTRIES.curatedTitle))}
            </h2>
            <p className="mt-6 max-w-md text-base leading-relaxed text-foreground/75 whitespace-pre-line">
              {t(p.block("entries.curatedBody", ENTRIES.curatedBody))}
            </p>
            {/* 主理人的選品 2026-09-02 併進「選物」的分頁。/curated 仍然轉址得過來，
                但首頁是站內連結，直接指向新家，不必多繞一次 301。 */}
            <Link
              to="/shop"
              search={{ tab: "curated" }}
              className="mt-8 inline-block tracking-widest text-clay hover-underline text-base"
            >
              {t(p.block("entries.curatedCta", ENTRIES.curatedCta))} →
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

      {/* 來店資訊 */}
      <section className="container-editorial pb-24">
        <div className="grid md:grid-cols-2 gap-12 items-stretch">
          <div className="aspect-[4/3] md:aspect-auto bg-muted">
            <iframe src={map.embed} className="h-full w-full border-0" loading="lazy" title="Map" />
          </div>
          <div className="flex flex-col justify-center">
            <p className="eyebrow text-2xl">{t(ui.nav.visit)}</p>
            <h2 className="display mt-5 text-3xl md:text-4xl">{t(site.address)}</h2>
            <p className="mt-6 text-base text-foreground/75">{t(site.hours)}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t(ui.footer.everyday)}</p>
            <div className="mt-8 flex flex-wrap gap-4 text-xs tracking-widest">
              <a
                href={map.link}
                target="_blank"
                rel="noreferrer"
                className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
              >
                {t(ui.buttons.navigate)}
              </a>
              {/* 來店資訊 2026-09-02 併進 /about 的後半。同上：站內連結直接指向新家。 */}
              <Link to="/about" className="self-center text-clay hover-underline">
                {t(p.block("entries.visitFull", ENTRIES.visitFull))} →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* 最新消息 —— 沒有任何一則就整區（含標題與「查看全部」）不出現 */}
      {latestNews.length > 0 && (
        <>
          <SectionHeader
            eyebrow={t(p.block("sections.newsEyebrow", SECTION_EYEBROWS.news))}
            title={t(ui.sections.latestNews)}
            link={{ to: "/news", label: t(ui.buttons.viewAll) }}
          />
          <div className={`container-editorial pb-24 ${newsLayout.grid}`}>
            {latestNews.map((n) => (
              <article key={n.id} className={`${CARD} ${newsLayout.card}`}>
                <div className={`flex flex-1 flex-col p-6 ${newsLayout.body}`}>
                  <p className="text-sm tracking-widest text-muted-foreground">{n.date}</p>
                  <h3
                    className={`display mt-3 text-2xl leading-snug whitespace-pre-line ${newsLayout.title}`}
                  >
                    {t(n.title)}
                  </h3>
                  <p className="mt-4 text-sm leading-relaxed text-foreground/75 whitespace-pre-line">
                    {t(n.summary)}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </PageShell>
  );
}

function SectionHeader({
  eyebrow,
  title,
  link,
}: {
  eyebrow: string;
  title: string;
  link?: { to: "/events" | "/journeys" | "/news"; label: string };
}) {
  return (
    <div className="container-editorial pt-12 pb-10 flex items-end justify-between border-t border-border">
      <div>
        <p className="eyebrow text-2xl">{eyebrow}</p>
        <h2 className="display mt-3 text-3xl md:text-4xl">{title}</h2>
      </div>
      {link && (
        <Link
          to={link.to}
          className="text-xs tracking-widest text-clay hover-underline hidden md:inline-block"
        >
          {link.label} →
        </Link>
      )}
    </div>
  );
}
