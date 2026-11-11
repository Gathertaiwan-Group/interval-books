/**
 * /about —— 「關於小時光」
 *
 * 2026-09-02 導覽列從九格收成五格，這一頁吃下原本的 /visit（來店資訊）。順序刻意
 * 是「我們是誰」在前、「怎麼來找我們」在後：
 *
 *   故事 → 我們做的事 → 空間 →｜地圖 → 地址與營業時間 → 一鍵導航 → 交通方式 → 店內＋聯絡
 *                              └─ 以下整段來自 /visit
 *
 * /contact 沒有搬任何東西過來：它上面的每一項 SiteFooter 都已經有，而且讀的是同一份
 * useSiteContent()。詳見 src/routes/contact.tsx 的檔頭。
 *
 * ── 兩個 page row，不是一個 ──────────────────────────────────────────────
 * loader 同時讀 pages/'about' 與 pages/'visit'。來店資訊那一整段的文案與清單（交通、
 * 步行、停車、公車、店內體驗）都存在 page_blocks / page_list_items 的 page_slug='visit'
 * 底下 —— 只讀 about 那一列的話，對 page_slug='visit' 的每一次修改都會變成靜默無效：
 * 存得進去，前台永遠不變。
 *
 * ── h1 為什麼不是 p.title() ──────────────────────────────────────────────
 * 頁面標題要跟導覽列那一格一致（「關於小時光」），但 pages/'about' 的 header_title 在
 * 正式庫裡是「在華山的一段安靜時光」（supabase/seed.sql:203），拿它當 h1 就永遠不會是
 * 「關於小時光」。這一期不准新增 migration、不准動正式庫，所以 h1 走
 * p.block("pageTitle") —— page_blocks 裡目前沒有這個 key，一定落到下面的後備文案，
 * 而客戶想改的時候補一列就會生效。
 *
 * header_title 沒有變成死欄位：它下移成故事段的標題，仍然是後台改了就會變的那一行。
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { INTERVAL_COPY, IntervalCoda } from "@/components/IntervalCoda";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fitDescription } from "@/lib/seo/core";
import { pageHead } from "@/lib/seo/head";
import { pageRowTranslation } from "@/lib/seo/pages";
import { fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import type { PageListEntry } from "@/lib/cms";
import { CARD, featureLayout } from "@/lib/feature-layout";
import { imageFor, srcSetFor } from "@/lib/images";
import { useSiteContent } from "@/lib/site-content";
import interiorImg from "@/assets/bookstore-interior.jpg";
import curatedImg from "@/assets/curated-objects.jpg";
import exhibitionImg from "@/assets/exhibition-corner.jpg";

export const Route = createFileRoute("/about")({
  loader: async () => {
    // indexPage：「店名的由來」那句（hero.intro）一直存在 pages/'index'，後台在那一格改。
    // 2026-11-10 那一段從首頁搬到這裡，句子仍讀同一格（見 src/components/IntervalCoda.tsx）。
    const [page, visitPage, indexPage] = await Promise.all([
      fetchPage("about"),
      fetchPage("visit"),
      fetchPage("index"),
    ]);
    return { page, visitPage, indexPage };
  },
  head: ({ loaderData, matches, match }) => {
    const page = loaderData?.page ?? null;
    const p = pageText(page);
    return {
      ...pageHead(
        { matches, match },
        {
          translation: pageRowTranslation(loaderData?.page ?? null),
          title: p.metaTitle(PAGE.metaTitle),
          description: fitDescription(p.metaDescription(PAGE.metaDescription)),
          ogTitle: p.ogTitle(PAGE.title),
          image: imageFor(page?.ogImageKey, interiorImg),
          type: "website",
        },
      ),
    };
  },
  component: About,
});

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "關於小時光 About｜小時光書店",
    en: "About｜Interval Books",
    ja: "小時光について｜小時光書店",
  },
  metaDescription: {
    zh: "小時光的故事：從一櫃書、一張長桌開始，慢慢有了陶藝家的器物、地方夥伴的選物與每月一場讀書會。這一頁介紹我們做的三件事——風土誌策展、活動與讀書會、策旅與合作共創，也附上紅磚六合院的交通方式與營業時間。",
    en: "Our story, from one bookcase and a long table: terroir curation, reading circles and journeys — plus hours and how to find us in Huashan's Red Brick Courtyard.",
    ja: "一棚の本と長いテーブルから始まった小時光の歩み。風土誌のキュレーション、読書会、旅と共創という三つの仕事と、華山・紅煉瓦六合院への行き方、営業時間をご案内します。",
  },
  eyebrowSuffix: { zh: "關於小時光", en: "About Interval Books", ja: "小時光について" },
  /** h1。與導覽列那一格同一個詞。 */
  pageTitle: {
    zh: "關於小時光",
    en: "About Interval Books",
    ja: "小時光について",
  },
  title: {
    zh: "在華山的一段安靜時光",
    en: "A quiet interval in Huashan",
    ja: "華山の、しずかな小さき時間",
  },
  intro: {
    zh: "小時光書店在華山紅磚六合院，以書店為載體，從一份地方刊物、一場讀書會、一趟策旅出發，讓更多人認識台灣的美好事物。",
    en: "Set in the Red Brick Courtyard of Huashan 1914, Interval Books uses the bookstore as a vessel: starting from a local magazine, a reading circle or a cultural journey, we help more people discover the good things of Taiwan.",
    ja: "華山・紅煉瓦六合院にある小時光書店は、本屋をひとつの器として、一冊の地域誌、ひとつの読書会、ひとつの旅から、台湾のすてきなものをより多くの人に届けています。",
  },
  story: {
    zh: "從一櫃書、一張長桌開始，我們慢慢收進了台灣各地的地方刊物，辦起讀書會與講座，也開始帶著讀者走出書店、走進土地。",
    en: "We began with a single bookcase and a long table. Slowly we gathered local publications from across Taiwan, started reading circles and talks, and began taking readers out of the shop and into the land.",
    ja: "一棚の本と一脚の長机から始まりました。少しずつ台湾各地の地域の刊行物を集め、読書会やトークを開き、やがて読者と一緒に書店を出て、土地へと歩きはじめました。",
  },
  workTitle: { zh: "我們做的事", en: "What we do", ja: "わたしたちのしごと" },
  spaceTitle: { zh: "空間特色", en: "Inside the space", ja: "空間" },
  /** 2026-10-26：異業合作頁的入口（不進主導覽列）。 */
  partnerEyebrow: { zh: "Partnership", en: "Partnership", ja: "Partnership" },
  partnerTitle: {
    zh: "想和小時光一起合作？",
    en: "Want to work with us?",
    ja: "小時光と協働しませんか？",
  },
  partnerBody: {
    zh: "活動、展覽、選物寄賣、品牌聯名、企業包場、講座與工作坊——歡迎填表告訴我們你的想法。",
    en: "Events, exhibitions, consignment, brand collaborations, private bookings, talks and workshops — tell us your idea.",
    ja: "イベント、展示、委託販売、ブランドコラボ、貸切、講座・ワークショップ。アイデアをお聞かせください。",
  },
  partnerCta: { zh: "異業合作洽詢", en: "Partnership inquiry", ja: "協働のご相談" },
};

/**
 * 後備文案 —— 原本住在 src/routes/visit.tsx，隨內容一起搬過來。讀的仍然是
 * pages/'visit' 那一列的 blocks / lists，所以後台改了這裡就會變。
 */
const VISIT = {
  address: { zh: "店址", en: "Address", ja: "ご住所" },
  hours: { zh: "營業時間", en: "Hours", ja: "営業時間" },
  transport: { zh: "交通方式", en: "Getting Here", ja: "アクセス" },
  metro: { zh: "捷運", en: "Metro (MRT)", ja: "MRT" },
  bus: { zh: "公車", en: "Bus", ja: "バス" },
  drive: { zh: "開車・停車", en: "By car & parking", ja: "お車・駐車" },
  walk: { zh: "步行路線", en: "On foot", ja: "徒歩でのご案内" },
  inside: { zh: "店內體驗", en: "Inside", ja: "店内のこと" },
  busDetail: { zh: "查看公車路線", en: "View bus routes", ja: "バス路線を見る" },
  contactUs: { zh: "聯絡我們", en: "Contact us", ja: "お問合せ" },
  navHint: {
    zh: "一鍵開啟導航，帶你走進紅磚六合院。",
    en: "One tap to open turn-by-turn navigation to the Red Brick Courtyard.",
    ja: "ワンタップで紅煉瓦六合院までのナビを開きます。",
  },
  openGoogle: { zh: "Google Maps 導航", en: "Open in Google Maps", ja: "Google マップで開く" },
  openApple: { zh: "Apple 地圖導航", en: "Open in Apple Maps", ja: "Apple マップで開く" },
  navigateEyebrow: { zh: "Navigate", en: "Navigate", ja: "Navigate" },
  contactEyebrow: { zh: "Contact", en: "Contact", ja: "Contact" },
};

/** 2026-11-10 文案健檢 A2：三張卡對齊首頁的「讀．聚．行」（src/routes/index.tsx HOME.read*／gather*／go*）。 */
const WORK_FALLBACK: PageListEntry[] = [
  {
    label: {
      zh: "讀｜選書與地方刊物",
      en: "Read | Books & local publications",
      ja: "読｜選書と地域の刊行物",
    },
    note: {
      zh: "以風土為線索選書，收進台灣各地的地方刊物。",
      en: "Books chosen by the land they come from, and local publications from across Taiwan.",
      ja: "風土を手がかりに本を選び、台湾各地の地域の刊行物を集めています。",
    },
    imageKey: null,
  },
  {
    label: {
      zh: "聚｜讀書會、講座與工作坊",
      en: "Gather | Reading circles, talks & workshops",
      ja: "集｜読書会・トーク・ワークショップ",
    },
    note: {
      zh: "一張長桌，讓讀過的書被好好說出來。",
      en: "One long table, where the books we read get talked through.",
      ja: "長いテーブルひとつで、読んだ本をゆっくり語り合います。",
    },
    imageKey: null,
  },
  {
    label: {
      zh: "行｜走進土地的策旅",
      en: "Go | Journeys into the land",
      ja: "行｜土地へ歩み入る旅",
    },
    note: {
      zh: "跟著書與作者走出書店，到故事發生的地方。",
      en: "We follow books and their authors out of the shop to the places they describe.",
      ja: "本と作家に導かれて書店を出て、物語の舞台へ。",
    },
    imageKey: null,
  },
];

const SPACE_FALLBACK: PageListEntry[] = [
  { label: { zh: "書", en: "Books", ja: "本" }, note: null, imageKey: "bookstore-interior.jpg" },
  { label: { zh: "選品", en: "Objects", ja: "選品" }, note: null, imageKey: "curated-objects.jpg" },
  {
    label: { zh: "策展", en: "Exhibitions", ja: "展覧" },
    note: null,
    imageKey: "exhibition-corner.jpg",
  },
];

/** Positional safety net for SPACE_FALLBACK's bundled images, keyed by list order. */
const SPACE_FALLBACK_IMAGES = [interiorImg, curatedImg, exhibitionImg];

const METRO: Localized[] = [
  {
    zh: "板南線「忠孝新生站」1 號出口，步行約 3 分鐘",
    en: "Bannan Line, Zhongxiao Xinsheng Station, Exit 1 — about 3 min on foot",
    ja: "板南線「忠孝新生」駅 1 番出口より徒歩約 3 分",
  },
  {
    zh: "或「善導寺站」6 號出口，步行約 5 分鐘",
    en: "Or Shandao Temple Station, Exit 6 — about 5 min on foot",
    ja: "または「善導寺」駅 6 番出口より徒歩約 5 分",
  },
];

const BUS: Localized[] = [
  {
    zh: "忠孝國小站：232、232(副)、605 系列、665",
    en: "Zhongxiao Elementary School stop (忠孝國小): 232, 232(sub), 605 series, 665",
    ja: "忠孝國小停留所：232、232(副)、605 系統、665",
  },
  {
    zh: "華山公園站：669",
    en: "Huashan Park stop (華山公園): 669",
    ja: "華山公園停留所：669",
  },
  {
    zh: "審計部（忠孝東路）：205、232、262(區間)、276、299、忠孝新幹線",
    en: "National Audit Office on Zhongxiao E. Rd. (審計部): 205, 232, 262(local), 276, 299, Zhongxiao Express",
    ja: "審計部（忠孝東路）停留所：205、232、262(区間)、276、299、忠孝新幹線",
  },
];

const DRIVE: Localized[] = [
  {
    zh: "園區附設 24 小時停車場（出入口位於八德路一段）",
    en: "On-site 24-hour parking lot (entrance on Bade Rd. Sec. 1)",
    ja: "園内に 24 時間駐車場あり（入口は八德路一段）",
  },
  {
    zh: "平日 TWD 40 ／小時　|　假日 TWD 60 ／小時",
    en: "Weekdays TWD 40 / hr  ·  Weekends TWD 60 / hr",
    ja: "平日 TWD 40 / 時　|　休日 TWD 60 / 時",
  },
  {
    zh: "建議：假日車位緊張，可改搭捷運前往。",
    en: "Tip: weekend parking fills quickly — MRT is recommended.",
    ja: "ヒント：週末は満車になりやすいため、MRT のご利用がおすすめです。",
  },
];

const WALK: Localized[] = [
  {
    zh: "從忠孝新生站 1 號出口出來，沿金山北路向北步行約 200 公尺。",
    en: "From MRT Zhongxiao Xinsheng Exit 1, walk north on Jinshan N. Rd. for ~200 m.",
    ja: "忠孝新生駅 1 番出口から金山北路を北へ約 200 m。",
  },
  {
    zh: "看到紅磚老建築群即進入園區，沿主道走至「紅磚六合院」。",
    en: "Enter the park when you see the red-brick warehouses, then head to the Red Brick Courtyard.",
    ja: "赤煉瓦倉庫群が見えたら園内へ。メイン通りに沿って「紅煉瓦六合院」へ。",
  },
  {
    zh: "穿過六合院中庭，西側第三間即為「西 7-3 館」。",
    en: "Cross the courtyard — West 7-3 is the third unit on the west side.",
    ja: "中庭を抜けた西側 3 番目が「西 7-3 館」です。",
  },
];

const INSIDE: Localized[] = [
  {
    zh: "自選茶點與小份量甜食",
    en: "Self-serve tea and small sweets",
    ja: "セルフのお茶と小ぶりな甘いもの",
  },
  {
    zh: "安靜閱讀座位（請小聲交談）",
    en: "Quiet reading seats (please keep voices low)",
    ja: "静かな読書席（小声でどうぞ）",
  },
  {
    zh: "不定期舉辦讀書會、講座與身心靈活動",
    en: "Occasional reading circles, talks, and healing sessions",
    ja: "読書会、トーク、ヒーリングを随時開催",
  },
  {
    zh: "可詢問主理人選書與選品建議",
    en: "Ask the owner for book and object recommendations",
    ja: "店主におすすめの本や品をお気軽にご相談ください",
  },
];

function About() {
  const t = useT();
  const { page, visitPage, indexPage } = Route.useLoaderData();
  const p = pageText(page);
  /** pages/'visit' 那一列。來店資訊整段的文案與清單都從這裡來。 */
  const pv = pageText(visitPage);
  const { site, map, social, ui, contactEmail } = useSiteContent();

  const workList = p.rows("work", WORK_FALLBACK);
  const spaceList = p.rows("space", SPACE_FALLBACK);
  const workLayout = featureLayout(workList.length);
  const spaceLayout = featureLayout(spaceList.length);

  const metroList = pv.list("metro", METRO);
  const busList = pv.list("bus", BUS);
  const driveList = pv.list("drive", DRIVE);
  const walkList = pv.list("walk", WALK);
  const insideList = pv.list("inside", INSIDE);

  const [busOpen, setBusOpen] = useState(false);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: fitDescription(p.metaDescription(PAGE.metaDescription)),
    ogTitle: p.ogTitle(PAGE.title),
    ogImage: imageFor(page?.ogImageKey, interiorImg),
  });

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "About", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.block("pageTitle", PAGE.pageTitle))}
        intro={t(p.intro(PAGE.intro))}
      />

      {/* 1) 故事 */}
      <section
        className="container-editorial pb-24 grid md:grid-cols-2 gap-12 items-center"
        data-testid="about-story"
        data-reveal-stagger
      >
        <div className="aspect-[4/5] overflow-hidden bg-muted">
          {/* 首屏圖：不 lazy（lazy 會拖慢 LCP）、WebP srcset（2026-11 SEO 健檢 M5）。 */}
          <img
            src={interiorImg}
            srcSet={srcSetFor(interiorImg)}
            sizes="(min-width: 768px) 50vw, 100vw"
            alt={t(p.title(PAGE.title))}
            className="h-full w-full object-cover"
            width={1080}
            height={1920}
            fetchPriority="high"
          />
        </div>
        <div>
          <h2 className="display text-3xl md:text-4xl">{t(p.title(PAGE.title))}</h2>
          <p className="mt-6 text-base md:text-lg leading-loose text-foreground/80">
            {t(p.block("story", PAGE.story))}
          </p>
        </div>
      </section>

      {/* 1.5) 店名的由來（2026-11-10 從首頁收尾段搬來）。放在故事之後、「我們做的事」之前：
          先講這間店怎麼開始，再講「小時光／INTERVAL」這個名字的意思，最後才是做什麼。
          下方「我們做的事」的標題自帶上框線，這裡不再加線。 */}
      <IntervalCoda
        className="pb-24"
        testId="about-interval"
        kicker={t(INTERVAL_COPY.kicker)}
        motto={t(pageText(indexPage).block("hero.intro", INTERVAL_COPY.motto))}
        body={t(INTERVAL_COPY.body)}
      />

      {/* 2) 我們做的事 */}
      <section className="container-editorial pb-24" data-testid="about-work" data-reveal>
        <h2 className="display text-3xl md:text-4xl border-t border-border pt-12">
          {t(p.block("workTitle", PAGE.workTitle))}
        </h2>
        <div className={`mt-12 ${workLayout.grid}`}>
          {workList.map((w, i) => (
            <article key={i} className={`${CARD} ${workLayout.card}`}>
              <div className={`flex flex-1 flex-col p-6 ${workLayout.body}`}>
                <p className="text-xs tracking-widest text-muted-foreground">
                  {String(i + 1).padStart(2, "0")}
                </p>
                <h3 className={`display mt-3 text-2xl leading-snug ${workLayout.title}`}>
                  {t(w.label)}
                </h3>
                <p className="mt-4 text-sm leading-relaxed text-foreground/75">
                  {t(w.note ?? { zh: "", en: "", ja: "" })}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* 3) 空間 */}
      <section className="container-editorial pb-24" data-testid="about-space" data-reveal>
        <p className="eyebrow text-2xl border-t border-border pt-12">
          {t(p.block("spaceTitle", PAGE.spaceTitle))}
        </p>
        <div className={`mt-10 ${spaceLayout.grid}`}>
          {spaceList.map((s, i) => (
            <figure key={i} className={`${CARD} ${spaceLayout.card}`}>
              <div className={`aspect-[4/5] overflow-hidden bg-muted ${spaceLayout.image}`}>
                <img
                  src={imageFor(s.imageKey, SPACE_FALLBACK_IMAGES[i] ?? interiorImg)}
                  alt={t(s.label)}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </div>
              <figcaption className={`flex flex-1 flex-col p-6 ${spaceLayout.body}`}>
                <span className={`display text-2xl leading-snug ${spaceLayout.title}`}>
                  {t(s.label)}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      {/* 3.5) 異業合作入口 */}
      <section className="container-editorial pb-24" data-testid="about-partnership" data-reveal>
        <div className="border border-border bg-[oklch(0.97_0.012_82)] p-8 md:p-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div className="max-w-xl">
            <p className="eyebrow text-2xl">{t(p.block("partnerEyebrow", PAGE.partnerEyebrow))}</p>
            <h2 className="display mt-3 text-2xl md:text-3xl">
              {t(p.block("partnerTitle", PAGE.partnerTitle))}
            </h2>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
              {t(p.block("partnerBody", PAGE.partnerBody))}
            </p>
          </div>
          <Link
            to="/partnership"
            className="self-start md:self-center shrink-0 border border-foreground bg-foreground text-primary-foreground px-6 py-3 text-sm tracking-widest hover:opacity-90 transition-opacity"
          >
            {t(p.block("partnerCta", PAGE.partnerCta))}
          </Link>
        </div>
      </section>

      {/* ─── 以下整段來自舊的 /visit ───────────────────────────────────── */}

      {/* 4) 地圖 */}
      <section className="container-editorial pb-16 pt-12" data-testid="about-map" data-reveal>
        <div className="aspect-[16/9] bg-muted">
          <iframe src={map.embed} className="h-full w-full border-0" loading="lazy" title="Map" />
        </div>
      </section>

      {/* 5) 地址 + 營業時間 */}
      <section
        className="container-editorial pb-16 grid gap-12 md:grid-cols-2"
        data-testid="about-address"
        data-reveal-stagger
      >
        <div>
          <p className="eyebrow text-2xl">{t(pv.block("address", VISIT.address))}</p>
          <h3 className="display mt-3 text-2xl">{t(site.address)}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{t(site.city)}</p>
        </div>
        <div>
          <p className="eyebrow text-2xl">{t(pv.block("hours", VISIT.hours))}</p>
          <p className="mt-3 text-base">{t(site.hours)}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t(ui.footer.everyday)}</p>
        </div>
      </section>

      {/* 6) 一鍵導航 */}
      <section className="container-editorial pb-20" data-reveal>
        <div className="border border-border bg-[oklch(0.97_0.012_82)] p-8 md:p-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div className="max-w-md">
            <p className="eyebrow text-2xl">
              {t(pv.block("navigateEyebrow", VISIT.navigateEyebrow))}
            </p>
            <h3 className="display mt-3 text-2xl md:text-3xl">{t(ui.buttons.navigate)}</h3>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
              {t(pv.block("navHint", VISIT.navHint))}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 text-xs tracking-widest">
            <a
              href={map.link}
              target="_blank"
              rel="noreferrer"
              className="border border-foreground bg-foreground text-primary-foreground px-5 py-3 hover:opacity-90 transition-opacity"
            >
              {t(pv.block("openGoogle", VISIT.openGoogle))}
            </a>
            <a
              href={map.apple}
              target="_blank"
              rel="noreferrer"
              className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
            >
              {t(pv.block("openApple", VISIT.openApple))}
            </a>
          </div>
        </div>
      </section>

      {/* 7) 交通方式 */}
      <section className="container-editorial pb-24" data-testid="about-transport">
        <p data-reveal className="eyebrow text-2xl border-t border-border pt-12">
          {t(pv.block("transport", VISIT.transport))}
        </p>
        <div data-reveal-stagger className="mt-10 grid gap-12 md:grid-cols-2 lg:grid-cols-4">
          {/* Metro */}
          <div>
            <h3 className="font-serif text-xl">{t(pv.block("metro", VISIT.metro))}</h3>
            <div className="rule mt-3" />
            <ul className="mt-5 space-y-3 text-sm leading-relaxed text-foreground/80">
              {metroList.map((item, i) => (
                <li key={i}>· {t(item)}</li>
              ))}
            </ul>
          </div>

          {/* Walk */}
          <div>
            <h3 className="font-serif text-xl">{t(pv.block("walk", VISIT.walk))}</h3>
            <div className="rule mt-3" />
            <ol className="mt-5 space-y-3 text-sm leading-relaxed text-foreground/80 list-decimal pl-5">
              {walkList.map((item, i) => (
                <li key={i}>{t(item)}</li>
              ))}
            </ol>
          </div>

          {/* Drive */}
          <div>
            <h3 className="font-serif text-xl">{t(pv.block("drive", VISIT.drive))}</h3>
            <div className="rule mt-3" />
            <ul className="mt-5 space-y-3 text-sm leading-relaxed text-foreground/80">
              {driveList.map((item, i) => (
                <li key={i}>· {t(item)}</li>
              ))}
            </ul>
          </div>

          {/* Bus (accordion) */}
          <div>
            <h3 className="font-serif text-xl">{t(pv.block("bus", VISIT.bus))}</h3>
            <div className="rule mt-3" />
            <button
              onClick={() => setBusOpen((v) => !v)}
              className="mt-5 text-xs tracking-widest text-clay hover-underline"
            >
              {t(pv.block("busDetail", VISIT.busDetail))} {busOpen ? "−" : "+"}
            </button>
            {busOpen && (
              <ul className="mt-5 space-y-3 text-xs leading-relaxed text-muted-foreground border-l-2 border-clay/40 pl-4">
                {busList.map((item, i) => (
                  <li key={i}>· {t(item)}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* 8) 店內體驗 + 聯絡 */}
      <section
        className="container-editorial pb-32 grid gap-12 md:grid-cols-2"
        data-testid="about-contact"
        data-reveal-stagger
      >
        <div>
          <p className="eyebrow text-2xl border-t border-border pt-12">
            {t(pv.block("inside", VISIT.inside))}
          </p>
          <ul className="mt-6 space-y-3 text-sm leading-relaxed text-foreground/80">
            {insideList.map((item, i) => (
              <li key={i}>· {t(item)}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="eyebrow text-2xl border-t border-border pt-12">
            {t(pv.block("contactEyebrow", VISIT.contactEyebrow))}
          </p>
          <div className="mt-6 flex flex-wrap gap-4 text-xs tracking-widest">
            {/*
              原本這裡是 <Link to="/contact">。/contact 現在轉址回 /about，留著就是
              一顆「按了回到自己」的按鈕。改成直接開信 —— 舊 /contact 頁上寫的也是
              「Email 是最直接的方式」。電話與社群在 footer，每一頁都看得到。
            */}
            <a
              href={`mailto:${contactEmail}`}
              className="border border-foreground px-5 py-3 hover:bg-foreground hover:text-primary-foreground transition-colors"
            >
              {t(pv.block("contactUs", VISIT.contactUs))}
            </a>
            <a
              href={social.instagram}
              target="_blank"
              rel="noreferrer"
              className="self-center text-clay hover-underline"
            >
              @intervalbookstw
            </a>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
