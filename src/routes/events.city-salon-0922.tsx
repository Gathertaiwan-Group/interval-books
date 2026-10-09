import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarDays, Clock, Map, MapPin } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { SessionPicker, SessionList } from "@/components/shop/SessionPicker";
import { PlanPicker } from "@/components/shop/PlanPicker";
import { QuantityStepper } from "@/components/shop/ShopBits";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { CARD } from "@/lib/feature-layout";
import {
  directAnySeatsLeft,
  directCheckoutSearch,
  directSeatLimit,
  directSoleSession,
} from "@/lib/direct-checkout";
import { imageFor } from "@/lib/images";
import { fetchActiveProductForEventSlug, type ShopProduct } from "@/lib/shop";

/**
 * 城市思享沙龍 #01 的獨立著陸頁。
 *
 * ═══ 為什麼這一場有自己的路由，而不是走 /events/$slug ═══════════════════════
 *
 * 這個檔名是 `events.city-salon-0922.tsx` —— flat routing 下靜態片段優先於動態
 * 參數，所以 /events/city-salon-0922 會走這裡，而不是通用的 events.$slug.tsx。
 * 網址沒有變，活動列表那張卡片點進來就是這一頁。
 *
 * 通用詳情頁能表達的東西是固定的：封面、說明、相簿、講者、梯次、報名按鈕。這一場
 * 需要的是英雄區、對談陣容、120 分鐘議程、沙龍後續路徑、以及一份七欄的邀請回條 ——
 * 那不是「同一個模板換資料」，是另一種頁面。硬要塞進通用模板，代價是給 events 加
 * 一堆只有一場活動會用到的欄位，那正是這個 repo 一直在避免的事
 * （0020:46-50「欄位要跟讀它的程式碼同一期出」）。
 *
 * ⚠️ **代價要講清楚**：這一頁的內容在下面的 SALON 常數裡，**後台改不到**。
 *    /admin/events 改 city-salon-0922 那一列，只會影響活動列表上那張卡片
 *    （標題、日期、分類、封面），不會影響這一頁。這是刻意的取捨——一次性的
 *    邀請頁不值得為它做一套 CMS；但如果之後 #02、#03 都要，就該把 SALON 這個
 *    形狀變成資料表，而不是複製這個檔案第三次。
 *
 * ⚠️ 內文只有中文。全站有 ZH/EN/JA 切換，這一頁切過去內文不會變——這是刻意的：
 *    對象是台灣的受邀者，把整頁三語化會讓維護成本變三倍而沒有讀者。meta 仍然
 *    是三語（scripts/check-meta.mjs 要求，也是分享出去時的預覽文字）。
 */

/** 三語 meta。⚠️ 必須是頂層靜態常數、每一句都是字面值——check-meta.mjs 靜態解析這個物件。 */
const PAGE = {
  metaTitle: {
    zh: "城市思享沙龍 #01｜台東，不只是遠方",
    en: "City Think Salon #01｜Taitung Is Not Just a Distant Place",
    ja: "都市サロン #01｜台東は、遠い場所であるだけではない",
  },
  metaDescription: {
    zh: "2026.9.22 於小時光風土誌書店。藝術、地方創生與一種新的商業生活方式——15 席限定的定向邀請沙龍。",
    en: "22 Sep 2026 at Interval Books. Art, regional regeneration and a new way of living with commerce — an invitation-only salon limited to 15 seats.",
    ja: "2026年9月22日、小時光風土誌書店にて。アート、地域創生、そして新しい商いの暮らし方——15席限定の招待制サロン。",
  },
};

/**
 * 這一場沙龍的全部內容。
 *
 * 集中放在這裡而不是散在 JSX 裡，是為了讓「改內容」與「改版面」是兩件不會互相
 * 弄壞的事——講者確定了、議程調整了，只要動這個物件。
 */
const SALON = {
  cohosts: "小時光書店 Interval Books ✕ 中華民國購物中心暨商業地產協會",
  badge: "城市思享沙龍 CITY THINK SALON #01｜10月台東參訪前導沙龍",
  headline: "台東，不只是遠方",
  subheadline: "藝術、地方創生與一種新的商業生活方式",
  quote: "如果一座城市，不再只追求更大、更快、更多，我們還可以如何生活？",
  // 邀請函上的四列。標籤是兩個字加寬字距，跟印刷品同一個節奏。
  meta: [
    { icon: CalendarDays, label: "日　期", value: "2026.9.22（二）" },
    { icon: Clock, label: "時　間", value: "13:30 – 15:30", note: "13:00 入場交流" },
    { icon: MapPin, label: "地　點", value: "小時光風土誌書店" },
    {
      icon: Map,
      label: "地　址",
      value: "台北市中正區八德路一段1號",
      note: "（紅磚區六合院西 7-3 館）",
    },
  ],
  invitationTitle: "空間的文藝復興",
  invitationSub: "從閒置資產到創生通路的「商道藝術」",
  lead: ["當空間遇見人，", "當藝術走進生活，", "閒置不再是終點，而是創生的起點。"],
  invite: ["誠摯邀請您蒞臨本次城市思享沙龍，", "從一間書店出發，一起想像城市與地方的更多可能。"],
  vertical: "書，土地，與人的小時光",
  seats: "15 席限定・定向審核邀請制",

  curationEyebrow: "策展緣起",
  curationTitle: "商道之藝",
  curationEssay: [
    "我們透過選書、選品、茶飲與人物策訪，讓讀者靠近土地，也讓創作者的生命被看見。",
    "當文化策展遇上商業地產，商業運作不再只是坪效的計算，而是一場承載土地與理想的「商道之藝」——把藝術家帶到人們面前，也把人們帶進地方真正的生活之中。",
  ],
  themes: [
    "為什麼這幾年，大家重新嚮往台東？",
    "一個地方真正的資產是土地、建築，還是生活方式？",
    "藝術與創生如何走出補助，走向永續商模？",
    "地方小品牌如何對接台北商場與地產通路？",
  ],

  speakers: [
    {
      role: "主持人",
      name: "Jeff 蔡明璋",
      title: "中華民國購物中心暨商業地產協會 理事長",
      view: "從城市、商業地產、通路生態與蚊子館活化看地方創生",
      pending: false,
    },
    {
      role: "主持人",
      name: "Alice",
      title: "小時光風土誌書店 主理人 / 策展人",
      view: "從藝術、土地、生活方式看台東——藝術如何進入生活",
      pending: false,
    },
    {
      role: "嘉賓",
      name: "賴純純",
      title: "跨界藝術家 / 生活美學推廣者",
      view: "藝術為什麼可以改變一個地方的生命力？",
      pending: false,
    },
    {
      role: "嘉賓",
      name: "敬請期待",
      title: "台東在地品牌 / 旅宿推手",
      view: "住在台東、做一件事情，真實的樣貌是什麼？",
      pending: true,
    },
  ],

  agenda: [
    { time: "13:00 – 13:30", title: "風土迎賓", detail: "茶飲、自由交流與微型台東書展體驗" },
    { time: "13:30 – 13:40", title: "策展引言", detail: "為什麼今天在小時光談台東？（Alice）" },
    { time: "13:40 – 13:55", title: "商道新局", detail: "從商業地產走向地方創生（Jeff）" },
    { time: "13:55 – 14:15", title: "土地視角", detail: "我看見的台東——藝術如何進入生活（Alice）" },
    { time: "14:15 – 14:40", title: "在地實踐", detail: "特邀嘉賓觀點分享（每人 12 分鐘）" },
    { time: "14:40 – 15:10", title: "跨界思享", detail: "四人對談「台東能給城市什麼啟示？」" },
    { time: "15:10 – 15:25", title: "圓桌共創", detail: "15 人每人一句「我想到的一個可能」" },
    {
      time: "15:25 – 15:30",
      title: "結語展望",
      detail: "Jeff 結語 ＆ 10/22-23 協會台東深度參訪團前導",
    },
  ],

  paths: [
    {
      label: "深入在地現場",
      body: "10/22-23 協會台東參訪團——拜會縣府、Gaya Hotel、江賢二藝術園區、小村遠遠等。",
    },
    { label: "城市持續思享", body: "預約城市思享沙龍第二場前排席次。" },
    { label: "商業資源對接", body: "現場交換「我能提供什麼 / 我正在尋找什麼」資源卡。" },
  ],

  rsvpNote: "本場次僅保留 15 席 VIP 席位，收到回覆後將寄發行前專屬入場通知。",
  address: "台北市中正區八德路一段1號（華山1914文化創意產業園區）",
  phone: "02-23416800",
};

const EVENT_SLUG = "city-salon-0922";

/**
 * 分享預覽圖（Open Graph）。
 *
 * 這一頁的英雄區是純文字的，所以 og:image 不是「把畫面上的圖再貼一次」——它是把
 * 連結貼到 LINE／Facebook／Email 時**唯一**會出現的視覺。沒有它，一場定向邀請的
 * 沙龍在對話串裡就只是一行藍字。
 *
 * 這個 key 與 public.events.image_key 指向同一張（台東的風景照，1200×900 webp，放在
 * site-images bucket）。第一版是一張排版式的文字橫幅（1.9:1），在首頁 4:3 的卡片框裡
 * 被切掉一半的標題，使用者說醜——換成照片之後兩邊比例剛好一致，不再被裁。刻意寫死而不是從 loader 讀：head() 要在 SSR 的第一時間就吐出 meta，
 * 而這一頁的 loader 只取商品（報名用），沒有、也不需要為了一張圖再多查一次活動。
 * 換圖的時候這裡與後台要一起改——只有一張圖，兩個地方，值得用一句註解換掉一次查詢。
 */
const OG_IMAGE_KEY = "storage:03f5d1e1-58c7-43be-a96a-4478269c2e4d.webp";

export const Route = createFileRoute("/events/city-salon-0922")({
  // 報名走站上既有的那一套：商品（product_type='event'）→ 場次 → 直接結帳 →
  // reserve_session_seat() → event_registrations。名單因此直接出現在
  // /admin/registrations，不需要為這一場另外做一個後台。
  loader: async () => fetchActiveProductForEventSlug(EVENT_SLUG),
  head: () => ({
    meta: [
      { title: PAGE.metaTitle.zh },
      { name: "description", content: PAGE.metaDescription.zh },
      { property: "og:title", content: PAGE.metaTitle.zh },
      { property: "og:description", content: PAGE.metaDescription.zh },
      { property: "og:image", content: imageFor(OG_IMAGE_KEY, "") },
      { name: "twitter:image", content: imageFor(OG_IMAGE_KEY, "") },
    ],
  }),
  component: CitySalon,
});

/** 章節標題。整頁只有一種，讓節奏一致。 */
function SectionHead({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="max-w-3xl">
      <p className="eyebrow text-2xl text-clay">{eyebrow}</p>
      <h2 className="display mt-4 text-3xl md:text-4xl leading-snug">{title}</h2>
    </div>
  );
}

function CitySalon() {
  useDocumentMeta({
    title: PAGE.metaTitle,
    description: PAGE.metaDescription,
    ogTitle: PAGE.metaTitle,
    ogDescription: PAGE.metaDescription,
    // ⚠️ 這裡一定要帶：useDocumentMeta 在沒收到 ogImage 時會**移除**既有的
    //    og:image／twitter:image（見那支 hook 的檔頭）。head() 放好的標籤會在
    //    hydrate 之後被清掉，分享預覽就沒圖了。
    ogImage: imageFor(OG_IMAGE_KEY, ""),
  });

  return (
    <PageShell>
      {/* 鼠尾草綠只有徽章與少數重點用得到，不值得進全站 token；用一個頁面層級的
          變數帶著走，這樣整頁只有這裡定義一次顏色。 */}
      <div
        style={
          {
            // 邀請函的兩個主色。墨綠是那張印刷品的識別色，站上的 token 沒有；
            // 銅棕比 --clay 再深一點，配在細線與標籤上才壓得住。
            // 只活在這一頁，不進全站 token —— 其他頁面沒有理由變成邀請函。
            ["--salon-green" as string]: "oklch(0.35 0.045 158)",
            ["--salon-bronze" as string]: "oklch(0.52 0.052 62)",
            ["--salon-sage" as string]: "oklch(0.55 0.032 155)",
          } as React.CSSProperties
        }
      >
        <CohostBar />
        <Hero />
        <Curation />
        <Speakers />
        <Agenda />
        <Paths />
        <Registration />
        <Venue />
      </div>
    </PageShell>
  );
}

// ── 共同主辦條 ────────────────────────────────────────────────────────────────

function CohostBar() {
  return (
    <div className="border-b border-border bg-oat/60">
      <div className="container-editorial flex flex-wrap items-center justify-between gap-3 py-3">
        <p className="text-xs tracking-widest text-muted-foreground">{SALON.cohosts}</p>
        <a
          href="#rsvp"
          className="text-xs tracking-widest border border-foreground px-4 py-2 hover:bg-foreground hover:text-primary-foreground transition-colors"
        >
          專屬邀請席位確認
        </a>
      </div>
    </div>
  );
}

// ── 英雄區 ────────────────────────────────────────────────────────────────────

/**
 * 花飾分隔線。邀請函上「邀請函 INVITATION」的上下各一條，中間一個小菱形捲飾。
 *
 * 用 SVG 而不是字元（❦ 之類）：那些字元在不同平台會 fallback 到完全不同的字型，
 * 有的甚至變成彩色 emoji，一張邀請函上出現彩色圖示會很突兀。
 */
function Fleuron({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center gap-4 ${className}`} aria-hidden>
      <span className="h-px w-16 bg-[var(--salon-bronze)] opacity-45 sm:w-24" />
      <svg width="34" height="10" viewBox="0 0 34 10" fill="none">
        <path
          d="M17 1.2 20 5l-3 3.8L14 5l3-3.8Z"
          stroke="var(--salon-bronze)"
          strokeWidth="0.9"
          opacity="0.75"
        />
        <path
          d="M13 5c-2.6 0-4-1.5-6-1.5S3.4 5 3.4 5s1.6 1.5 3.6 1.5S10.4 5 13 5Z"
          stroke="var(--salon-bronze)"
          strokeWidth="0.9"
          opacity="0.5"
        />
        <path
          d="M21 5c2.6 0 4-1.5 6-1.5S30.6 5 30.6 5s-1.6 1.5-3.6 1.5S23.6 5 21 5Z"
          stroke="var(--salon-bronze)"
          strokeWidth="0.9"
          opacity="0.5"
        />
      </svg>
      <span className="h-px w-16 bg-[var(--salon-bronze)] opacity-45 sm:w-24" />
    </div>
  );
}

/**
 * 四角的植物線描。邀請函四角都有，這裡只放左上與右下兩角。
 *
 * 只放兩角是刻意的：印刷品是固定尺寸，四角一定對稱；網頁會隨寬度伸縮，四角都放
 * 在窄螢幕上會擠到內容。對角線兩角保住了「這是一張邀請函」的暗示，又不會在手機上
 * 變成干擾。`hidden md:block` 讓它在手機上直接不出現。
 */
function Botanical({ corner }: { corner: "tl" | "br" }) {
  const tl = corner === "tl";
  return (
    <svg
      className={`pointer-events-none absolute hidden md:block ${
        tl ? "left-2 top-4" : "bottom-4 right-2 rotate-180"
      }`}
      width="190"
      height="190"
      viewBox="0 0 190 190"
      fill="none"
      aria-hidden
    >
      {/* 一根弧形的莖，兩側各三片葉。第一版只有幾條曲線，遠看像一團污漬——
          葉片要有閉合的形狀才讀得出是植物。 */}
      <g stroke="var(--salon-green)" strokeWidth="1.1" opacity="0.2" fill="none">
        <path d="M6 168C10 96 62 34 150 14" strokeWidth="1.3" />
        {/* 左上側的葉 */}
        <path d="M28 128c-14-6-19-20-14-33 14 3 22 15 21 29-2 3-5 5-7 4Z" />
        <path d="M58 92c-13-8-16-22-9-34 13 5 19 18 16 31-3 3-5 4-7 3Z" />
        <path d="M96 56c-12-9-13-23-5-34 12 7 17 20 13 32-3 3-6 4-8 2Z" />
        {/* 右下側的葉 */}
        <path d="M40 146c9 12 24 15 36 7-6-13-20-18-33-14-3 2-4 5-3 7Z" />
        <path d="M74 106c10 11 25 12 36 3-7-12-21-16-34-10-3 2-4 5-2 7Z" />
        <path d="M114 68c11 10 26 9 35-1-8-11-22-14-34-7-3 3-3 6-1 8Z" />
      </g>
    </svg>
  );
}

/** 邀請函那四列資訊的一列：銅色圓框圖示 ＋ 加寬字距的標籤 ＋ 值。 */
function MetaRow({ item }: { item: (typeof SALON.meta)[number] }) {
  const Icon = item.icon;
  return (
    <li className="flex items-start gap-4">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--salon-bronze)]/40">
        <Icon className="h-4 w-4 text-[var(--salon-bronze)]" strokeWidth={1.4} aria-hidden />
      </span>
      <span className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pt-1.5">
        <span className="text-sm tracking-[0.3em] text-[var(--salon-bronze)]">{item.label}</span>
        <span className="hidden h-4 w-px bg-[var(--salon-bronze)]/35 sm:block" aria-hidden />
        <span className="font-serif text-lg leading-snug [font-variant-numeric:lining-nums] md:text-xl">
          {item.value}
        </span>
        {item.note ? <span className="text-sm text-muted-foreground">{item.note}</span> : null}
      </span>
    </li>
  );
}

/**
 * 表頭 —— 照邀請函的版式重做。
 *
 * 印刷品是置中對稱的，網頁不是：一張 A4 一眼看完，網頁是往下捲的。所以這裡分成
 * 兩段 —— 上半（邀請函／主標題）沿用印刷品的置中與花飾，下半（沙龍標籤、副標、
 * 四列資訊）改成靠左，因為那是要「讀」的資訊，置中的長段落在寬螢幕上每一行的起點
 * 都不一樣，讀起來很累。
 */
function Hero() {
  return (
    <section className="relative overflow-hidden">
      <Botanical corner="tl" />
      <Botanical corner="br" />

      {/* 右側直排標語，取自邀請函右緣。窄螢幕放不下就不出現。 */}
      <p
        className="pointer-events-none absolute right-6 top-32 hidden font-serif text-sm tracking-[0.45em] text-[var(--salon-green)]/55 lg:block"
        style={{ writingMode: "vertical-rl" }}
        aria-hidden
      >
        {SALON.vertical}
      </p>

      <div className="container-editorial relative pt-14 md:pt-20">
        {/* ── 上半：置中的邀請函頭 ── */}
        <Fleuron />
        <div className="mt-7 text-center">
          <p className="font-serif text-3xl tracking-[0.5em] text-[var(--salon-green)] md:text-4xl">
            邀請函
          </p>
          <p className="mt-3 text-[0.7rem] tracking-[0.55em] text-[var(--salon-bronze)]">
            INVITATION
          </p>
        </div>
        <Fleuron className="mt-7" />

        <h1 className="mt-12 text-center font-serif text-5xl leading-tight text-[var(--salon-green)] md:text-7xl">
          {SALON.invitationTitle}
        </h1>
        <p className="mt-5 text-center font-serif text-xl leading-snug text-[var(--salon-green)]/85 md:text-2xl">
          {SALON.invitationSub}
        </p>

        <Fleuron className="mt-12" />

        {/* ── 下半：靠左的內容 ── */}
        <div className="mt-14 max-w-3xl">
          {/* 深綠實心標籤，右邊那一豎是邀請函上就有的收尾 */}
          <p className="inline-flex items-center gap-4 bg-[var(--salon-green)] px-5 py-2.5 text-primary-foreground">
            <span className="font-serif text-lg tracking-[0.28em] md:text-xl">城市思享沙龍</span>
            <span className="h-5 w-px bg-primary-foreground/50" aria-hidden />
          </p>

          <h2 className="mt-7 font-serif text-4xl leading-tight text-[var(--salon-green)] md:text-6xl">
            {SALON.headline}
          </h2>
          <p className="mt-4 font-serif text-lg leading-snug md:text-2xl">{SALON.subheadline}</p>

          <div className="mt-10 space-y-1 text-base leading-relaxed text-foreground/80 md:text-lg">
            {SALON.lead.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>

          <span className="my-9 block h-px w-14 bg-[var(--salon-bronze)]/50" aria-hidden />

          <div className="space-y-1 text-base leading-relaxed text-foreground/80 md:text-lg">
            {SALON.invite.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>

          <ul className="mt-12 space-y-5">
            {SALON.meta.map((m) => (
              <MetaRow key={m.label} item={m} />
            ))}
          </ul>

          <p className="mt-8 text-sm tracking-[0.2em] text-[var(--salon-bronze)]">{SALON.seats}</p>

          <div className="mt-10">
            <a
              href="#rsvp"
              className="inline-block border border-[var(--salon-green)] px-8 py-4 tracking-widest text-[var(--salon-green)] transition-colors hover:bg-[var(--salon-green)] hover:text-primary-foreground"
            >
              確認出席 / 預約席位
            </a>
          </div>
        </div>

        <Fleuron className="mt-16" />
      </div>
    </section>
  );
}

// ── 策展緣起 ──────────────────────────────────────────────────────────────────

function Curation() {
  return (
    <section className="container-editorial py-16 md:py-24 border-t border-border">
      <div className="grid gap-12 md:grid-cols-12 md:gap-16">
        <div className="md:col-span-5">
          <SectionHead eyebrow={SALON.curationEyebrow} title={SALON.curationTitle} />
          <div className="mt-8 space-y-5">
            {SALON.curationEssay.map((p) => (
              <p key={p} className="text-base leading-loose text-foreground/75">
                {p}
              </p>
            ))}
          </div>
        </div>

        <div className="md:col-span-7">
          <p className="eyebrow text-2xl text-muted-foreground">本場思享題目</p>
          {/* 題目是有順序的一串，所以維持單欄直排，只是每題各自一張卡（CARD）。
              CARD 是直向 flex，編號與題目要左右並排，所以橫排放在裡面那一層。 */}
          <ol className="mt-6 grid gap-4">
            {SALON.themes.map((t, i) => (
              <li key={t} className={CARD}>
                <div className="flex gap-5 p-6">
                  <span className="font-serif text-xl text-clay tabular-nums shrink-0">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-base leading-relaxed">{t}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

// ── 對談陣容 ──────────────────────────────────────────────────────────────────

function Speakers() {
  return (
    <section className="container-editorial py-16 md:py-24 border-t border-border">
      <SectionHead eyebrow="對談陣容" title="四種看台東的方式" />

      {/* 卡片外框走共用的 CARD（src/lib/feature-layout.ts）；欄數維持這一頁自己的 2×2——
          四位講者用 featureLayout 的「3 筆以上三欄」會在寬螢幕排成 3＋1。 */}
      <div className="mt-12 grid gap-8 sm:grid-cols-2">
        {SALON.speakers.map((s) => (
          <article key={s.title} className={`${CARD} p-6`}>
            <p className="text-[0.7rem] tracking-widest text-[var(--salon-sage)]">{s.role}</p>
            <h3 className={`display mt-3 text-2xl ${s.pending ? "text-muted-foreground" : ""}`}>
              {s.name}
            </h3>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed">{s.title}</p>
            <div className="rule my-6" />
            <p className="text-sm leading-relaxed text-foreground/75 flex-1">{s.view}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

// ── 議程 ──────────────────────────────────────────────────────────────────────

function Agenda() {
  return (
    <section className="container-editorial py-16 md:py-24 border-t border-border">
      <SectionHead eyebrow="沙龍流程" title="120 分鐘" />

      <ol className="mt-12 max-w-4xl">
        {SALON.agenda.map((row) => (
          <li
            key={row.time}
            className="grid gap-2 border-t border-border py-6 sm:grid-cols-[10rem_1fr] sm:gap-8 last:border-b"
          >
            <p className="text-sm tabular-nums tracking-wide text-clay pt-0.5">{row.time}</p>
            <div>
              <p className="font-serif text-lg leading-snug">{row.title}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{row.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── 沙龍後續路徑 ──────────────────────────────────────────────────────────────

function Paths() {
  return (
    <section className="container-editorial py-16 md:py-24 border-t border-border">
      <SectionHead eyebrow="沙龍之後" title="三條可以繼續走的路" />

      {/* 同上：外框用 CARD，欄數維持這一頁原本的 md 起三欄一列（featureLayout 的三筆
          在 md～lg 之間是兩欄，會排成 2＋1）。 */}
      <div className="mt-12 grid gap-8 md:grid-cols-3">
        {SALON.paths.map((p, i) => (
          <article key={p.label} className={`${CARD} p-6`}>
            <p className="font-serif text-xl text-clay tabular-nums">
              {String(i + 1).padStart(2, "0")}
            </p>
            <h3 className="mt-4 text-base tracking-wide">{p.label}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

// ── 受邀出席回覆 ──────────────────────────────────────────────────────────────

/**
 * 報名區。
 *
 * 🔴 這裡**不自己算任何座位數字**。數量上限一律問 directSeatLimit()（它轉給
 *    cartInputFor()，與購物車、活動詳情頁走同一行程式），剩餘席次由 SessionPicker
 *    自己顯示。這一頁只負責問「選了哪一場、幾位」，然後把答案交給 /checkout。
 *
 *    這條規矩與 src/routes/events.$slug.tsx 的 RegistrationPanel 相同，理由也相同：
 *    活動頁自己算一次上限，就會出現「頁面說可以買 5、場次只剩 1」這種對不起來的
 *    畫面。共用的是**演算法**（那幾支 helper），不是複製一份面板——那支面板被
 *    scripts/event-detail-page-selftest.mjs 用字面值釘在它自己的檔案裡，抽出來會
 *    讓那條守衛失效。
 *
 * 沒有選場次時上限鎖 1、按鈕是 <button disabled> 而不是 <Link>——「沒選場次就去
 * 結帳」在 DOM 裡不存在任何一條路徑。
 */
function Registration() {
  const { product, unavailable } = Route.useLoaderData();

  if (unavailable) {
    return (
      <RsvpShell>
        <p className="text-sm leading-relaxed text-muted-foreground">
          報名資料暫時無法載入，請稍後再試，或直接來電 {SALON.phone}。
        </p>
      </RsvpShell>
    );
  }
  if (!product) {
    return (
      <RsvpShell>
        <p className="text-sm leading-relaxed text-muted-foreground">
          報名尚未開放。開放之後會在這裡放上報名連結。
        </p>
      </RsvpShell>
    );
  }
  return (
    <RsvpShell>
      <SeatBooking product={product} />
    </RsvpShell>
  );
}

/** 報名區的外框。三種狀態共用，免得標題與說明在每個分支各寫一次。 */
function RsvpShell({ children }: { children: React.ReactNode }) {
  return (
    <section id="rsvp" className="border-t border-border bg-oat/50">
      <div className="container-editorial py-16 md:py-24">
        <SectionHead eyebrow="受邀出席回覆" title="確認您的席位" />
        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {SALON.rsvpNote}
        </p>
        <div className="mt-10 max-w-2xl border border-border bg-background p-8 md:p-10">
          {children}
        </div>
      </div>
    </section>
  );
}

function SeatBooking({ product }: { product: ShopProduct }) {
  const [sessionId, setSessionId] = useState<string | null>(
    () => directSoleSession(product)?.id ?? null,
  );
  const [planId, setPlanId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);

  const selectedSession = product.sessions.find((s) => s.id === sessionId) ?? null;
  // 這一場現在沒有票種，但後台隨時可以加（/admin/registrations 的方案編輯器）。
  // 加了之後這一段就會自動出現，不用再回來改這個檔案。
  const needsPlan = selectedSession !== null && selectedSession.plans.length > 0;
  const selectedPlan = selectedSession?.plans.find((p) => p.id === planId) ?? null;
  const readyToBook = selectedSession !== null && (!needsPlan || selectedPlan !== null);
  const seatLimit = selectedSession ? directSeatLimit(product, selectedSession, selectedPlan) : 1;
  const anySeats = directAnySeatsLeft(product);

  if (!anySeats) {
    return (
      <>
        <SessionList sessions={product.sessions} showSeatsRemaining={product.showSeatsRemaining} />
        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          本場次席位已滿。若仍希望出席，歡迎來電 {SALON.phone} 由我們為您安排候補。
        </p>
      </>
    );
  }

  return (
    <>
      <SessionPicker
        sessions={product.sessions}
        showSeatsRemaining={product.showSeatsRemaining}
        selectedId={sessionId}
        onSelect={(id) => {
          setSessionId(id);
          setPlanId(null);
          setQty(1);
        }}
      />

      {selectedSession && needsPlan ? (
        <PlanPicker
          plans={selectedSession.plans}
          showSeatsRemaining={product.showSeatsRemaining}
          selectedId={planId}
          onSelect={(id) => {
            setPlanId(id);
            setQty(1);
          }}
        />
      ) : null}

      <div className="mt-8 flex flex-wrap items-center gap-4">
        <QuantityStepper
          value={qty}
          max={seatLimit}
          onChange={(next) => setQty(Math.max(1, next))}
          label="出席人數"
          disabled={!readyToBook}
        />
        {readyToBook && selectedSession ? (
          <Link
            to="/checkout"
            search={directCheckoutSearch(product, selectedSession, qty, selectedPlan)}
            className="inline-block border border-foreground px-7 py-4 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors"
          >
            確認出席 / 填寫資料
          </Link>
        ) : (
          // 🔴 不是 <Link>。沒選場次的時候「去結帳」這條路在 DOM 裡不該存在。
          <button
            type="button"
            disabled
            className="inline-block border border-border px-7 py-4 tracking-widest text-muted-foreground"
          >
            確認出席 / 填寫資料
          </button>
        )}
      </div>

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        下一步會請您填寫出席者的姓名與聯絡方式。本場次免費，不會向您收取任何費用。
      </p>
    </>
  );
}

// ── 地點與聯絡 ────────────────────────────────────────────────────────────────

function Venue() {
  return (
    <section className="container-editorial py-16 md:py-20 border-t border-border">
      <div className="grid gap-10 md:grid-cols-3">
        <div>
          <p className="eyebrow text-2xl text-muted-foreground">主辦</p>
          <p className="mt-4 text-sm leading-relaxed">{SALON.cohosts}</p>
        </div>
        <div>
          <p className="eyebrow text-2xl text-muted-foreground">地點</p>
          <p className="mt-4 text-sm leading-relaxed">小時光風土誌書店</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{SALON.address}</p>
        </div>
        <div>
          <p className="eyebrow text-2xl text-muted-foreground">洽詢</p>
          <a
            href={`tel:${SALON.phone.replace(/-/g, "")}`}
            className="mt-4 block text-sm hover-underline"
          >
            {SALON.phone}
          </a>
        </div>
      </div>
    </section>
  );
}
