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
 * 底下 —— 只讀 about 那一列的話，後台 /admin/pages/visit 的每一次編輯都會變成靜默無效：
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
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import type { PageListEntry } from "@/lib/cms";
import { CARD, featureLayout } from "@/lib/feature-layout";
import { imageFor } from "@/lib/images";
import { useSiteContent } from "@/lib/site-content";
import interiorImg from "@/assets/bookstore-interior.jpg";
import curatedImg from "@/assets/curated-objects.jpg";
import exhibitionImg from "@/assets/exhibition-corner.jpg";

export const Route = createFileRoute("/about")({
  loader: async () => {
    const [page, visitPage] = await Promise.all([fetchPage("about"), fetchPage("visit")]);
    return { page, visitPage };
  },
  head: ({ loaderData }) => {
    const page = loaderData?.page ?? null;
    const p = pageText(page);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:image", content: imageFor(page?.ogImageKey, interiorImg) },
      ],
    };
  },
  component: About,
});

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "關於小時光 About｜小時光書店 Interval Books",
    en: "About｜Interval Books",
    ja: "小時光について｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。地址、營業時間與交通方式也在這一頁。",
    en: "We are Interval Books, tucked inside Huashan — birdsong, the scent of tea and paper, and the warmth of small encounters. Address, hours and directions are on this page too.",
    ja: "華山の小時光書店です。鳥のさえずり、茶と本の香り、ひとのぬくもりが交わる場。住所・営業時間・アクセスもこのページに。",
  },
  eyebrowSuffix: { zh: "關於小時光", en: "About", ja: "小時光について" },
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
    zh: "我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。",
    en: "We are Interval Books, tucked inside Huashan — birdsong, the scent of tea and paper, and the warmth of small encounters.",
    ja: "華山の小時光書店です。鳥のさえずり、茶と本の香り、ひとのぬくもりが交わる場。",
  },
  story: {
    zh: "從一櫃書、一張長桌開始，我們慢慢有了陶藝家的器物、地方夥伴的選物、與每月一場讀書會。書店並不大，但它是我們對於「閱讀」的長時間練習——讓書頁與生活，能彼此呼吸。",
    en: "We began with a single shelf and a long table. Then came the ceramicists' vessels, the local partners' selections, and a monthly reading circle. The shop is small, but it is our long practice of reading — letting page and life breathe together.",
    ja: "一棚の本と一脚の長机から始まりました。やがて陶芸家の器、地方の作り手の品、月に一度の読書会が加わりました。小さな店ですが、本と暮らしがともに呼吸できる場をめざす、長い練習なのです。",
  },
  workTitle: { zh: "我們做的事", en: "What we do", ja: "わたしたちのしごと" },
  spaceTitle: { zh: "空間特色", en: "Inside the space", ja: "空間" },
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

const WORK_FALLBACK: PageListEntry[] = [
  {
    label: { zh: "風土誌策展", en: "Terroir Curation", ja: "風土誌キュレーション" },
    note: {
      zh: "以地方為線索，策劃書展、選物與內容。",
      en: "Place as the thread for book shows, objects, and content.",
      ja: "土地を糸口に、書展・選品・コンテンツを編む。",
    },
    imageKey: null,
  },
  {
    label: { zh: "活動與讀書會", en: "Events & Reading Circles", ja: "イベントと読書会" },
    note: {
      zh: "讀書會、講座、工作坊、身心靈活動。",
      en: "Reading circles, talks, workshops, and healing practice.",
      ja: "読書会、トーク、ワークショップ、ヒーリング。",
    },
    imageKey: null,
  },
  {
    label: { zh: "策旅與合作共創", en: "Journeys & Co-creation", ja: "旅と共創" },
    note: {
      zh: "與在地夥伴設計風土主題旅程與品牌共創。",
      en: "Place-rooted journeys and brand co-creation with local partners.",
      ja: "地のパートナーと風土の旅、ブランド共創を設計します。",
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
  const { page, visitPage } = Route.useLoaderData();
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
    description: p.metaDescription(PAGE.metaDescription),
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
      >
        <div className="aspect-[4/5] overflow-hidden bg-muted">
          <img
            src={interiorImg}
            alt={t(p.title(PAGE.title))}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        </div>
        <div>
          <h2 className="display text-3xl md:text-4xl">{t(p.title(PAGE.title))}</h2>
          <p className="mt-6 text-base md:text-lg leading-loose text-foreground/80">
            {t(p.block("story", PAGE.story))}
          </p>
        </div>
      </section>

      {/* 2) 我們做的事 */}
      <section className="container-editorial pb-24" data-testid="about-work">
        <h2 className="display text-3xl md:text-4xl border-t border-border pt-12">
          {t(p.block("workTitle", PAGE.workTitle))}
        </h2>
        <div className={`mt-12 ${workLayout.grid}`}>
          {workList.map((w, i) => (
            <article key={i} className={`${CARD} ${workLayout.card}`}>
              <div className={`flex flex-1 flex-col p-6 ${workLayout.body}`}>
                <p className="text-[0.65rem] tracking-widest text-muted-foreground">
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
      <section className="container-editorial pb-24" data-testid="about-space">
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

      {/* ─── 以下整段來自舊的 /visit ───────────────────────────────────── */}

      {/* 4) 地圖 */}
      <section className="container-editorial pb-16 pt-12" data-testid="about-map">
        <div className="aspect-[16/9] bg-muted">
          <iframe src={map.embed} className="h-full w-full border-0" loading="lazy" title="Map" />
        </div>
      </section>

      {/* 5) 地址 + 營業時間 */}
      <section
        className="container-editorial pb-16 grid gap-12 md:grid-cols-2"
        data-testid="about-address"
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
      <section className="container-editorial pb-20">
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
        <p className="eyebrow text-2xl border-t border-border pt-12">
          {t(pv.block("transport", VISIT.transport))}
        </p>
        <div className="mt-10 grid gap-12 md:grid-cols-2 lg:grid-cols-4">
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
