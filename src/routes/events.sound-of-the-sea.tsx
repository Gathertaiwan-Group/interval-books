import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { SessionPicker, SessionList } from "@/components/shop/SessionPicker";
import { PlanPicker } from "@/components/shop/PlanPicker";
import { QuantityStepper } from "@/components/shop/ShopBits";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import {
  directAnySeatsLeft,
  directCheckoutSearch,
  directSeatLimit,
  directSoleSession,
} from "@/lib/direct-checkout";
import { bookstoreInterior, imageFor } from "@/lib/images";
import {
  fetchActiveProductForEventSlug,
  formatPrice,
  isPlanAvailable,
  type ShopProduct,
  type ShopSession,
} from "@/lib/shop";
import heroWaves from "@/assets/sound-of-the-sea/hero-waves.jpg";
import pictureBook from "@/assets/sound-of-the-sea/picture-book.jpg";
import laiChunchun from "@/assets/sound-of-the-sea/lai-chunchun.jpg";

/**
 * 胡海音《海的聲音》手作繪本分享會的獨立著陸頁（2026-11-06）。
 *
 * ═══ 為什麼有自己的路由 ═══════════════════════════════════════════════════════
 * 店家給的版面是一份 Lovable 稿（sound-of-sea-story-circle.lovable.app），要「長得
 * 一模一樣」。那是一整頁自己的視覺系統（海藍／紙色、Noto Serif TC、自己的頁首頁尾），
 * 不是通用活動詳情頁換資料能做到的，所以照 events.city-salon-0922.tsx 的做法：
 * 靜態檔名優先於 events.$slug.tsx，網址 /events/sound-of-the-sea 不變。
 *
 * 🔴 版面照稿，**報名與收錢走站上既有的那一套**（見 CLAUDE.md 最上面那條）：
 *    products（event-sound-of-the-sea）→ event_sessions → event_session_plans
 *    → /checkout（directCheckoutSearch）→ orders → event_registrations。
 *    稿上的報名表（姓名／電話／Email／人數／加購本數）**沒有照搬**：聯絡資料在
 *    /checkout 填，「加購繪本」做成第二個票種「入場＋手作繪本」NT$725。
 *
 * 與稿不同的地方（刻意的）：
 *   - 稿上的「圖片待替換」佔位框：書店空間改用站上既有的書店實景照；范毅舜那一張
 *     沒有照片，改成不假裝是照片的文字區塊。
 *   - 「場次名稱與日期：待主辦補充」與頁尾的「主辦方後台」連結拿掉。
 *   - 「付款」那一列寫的是站上真的有的付款方式（信用卡線上付款／銀行匯款）。
 *
 * ⚠️ 內容寫死在這個檔案，後台改不到——/admin/events 改這一場只影響活動列表的卡片。
 * ⚠️ 內文只有中文（對象是台灣讀者），meta 三語（scripts/check-meta.mjs 要求）。
 */

/** 三語 meta。⚠️ 必須是頂層靜態常數、每一句都是字面值——check-meta.mjs 靜態解析這個物件。 */
const PAGE = {
  metaTitle: {
    zh: "胡海音《海的聲音》手作繪本分享會｜小時光書店",
    en: "Hu Hai-Yin: The Voice of the Sea — Handmade Picture Book Talk｜Interval Books",
    ja: "胡海音『海の聲』手作り絵本トーク｜小時光書店",
  },
  metaDescription: {
    zh: "2026/11/6（五）14:00–16:00，於小時光書店。聽胡海音老師分享手作繪本《海的聲音》，在生命的聲音裡，練習傾聽與對話。下午茶入場 NT$300。",
    en: "Fri 6 Nov 2026, 14:00–16:00 at Interval Books. Hu Hai-Yin shares her handmade picture book The Voice of the Sea — on listening and dialogue. Admission NT$300 with afternoon tea.",
    ja: "2026年11月6日（金）14:00–16:00、小時光書店にて。胡海音先生が手作り絵本『海の聲』を語ります。アフタヌーンティー付き入場 NT$300。",
  },
};

const EVENT_SLUG = "sound-of-the-sea";

/**
 * 兩張圖直接用活動在 site-images bucket 裡的那兩張：封面（海報，= events.image_key）
 * 與相簿第一張（老師照片，= events.gallery_keys[0]）。刻意寫死、不從 loader 讀，理由同
 * city-salon-0922 的 OG_IMAGE_KEY：head() 要在 SSR 第一時間吐出 og:image，而 loader
 * 只取報名用的商品。後台換圖時這裡要一起改。
 */
const POSTER_KEY = "storage:be316c36-4761-4913-91f0-4a64da463f6a.webp";
const TEACHER_KEY = "storage:a41379fb-f3aa-4a64-94b4-953919d6cb7d.webp";

const PHONE = "02-2341-6800";

/**
 * 稿上的配色與字體。只活在這一頁，不進全站 token。
 *
 * 做法是在外層 div 上**覆寫**站上的 CSS 變數（--primary、--accent、--border…）：
 * styles.css 的 @theme inline 讓 text-primary 之類直接吃 var(--primary)，所以這一頁
 * 底下（包含 SessionPicker／PlanPicker 這些共用元件）自動換成海藍與紙色，不用改它們。
 * --font-serif／--font-sans 也一樣：h1–h3 的 base 樣式吃 var(--font-serif)。
 */
const THEME = {
  "--sos-paper": "oklch(97.5% 0.014 85)",
  "--sos-ocean": "oklch(29% 0.07 250)",
  "--sos-ocean-fg": "oklch(97% 0.015 85)",
  "--sos-shadow": "0 20px 50px -25px color-mix(in oklab, oklch(29% 0.07 250) 35%, transparent)",
  "--sand": "oklch(93% 0.025 80)",
  "--background": "oklch(97.5% 0.014 85)",
  "--foreground": "oklch(24% 0.035 250)",
  "--card": "oklch(99% 0.008 85)",
  "--card-foreground": "oklch(24% 0.035 250)",
  "--primary": "oklch(32% 0.08 250)",
  "--primary-foreground": "oklch(97% 0.015 85)",
  "--secondary": "oklch(93% 0.025 80)",
  "--secondary-foreground": "oklch(28% 0.05 250)",
  "--muted": "oklch(94% 0.018 82)",
  "--muted-foreground": "oklch(48% 0.03 250)",
  "--accent": "oklch(62% 0.09 60)",
  "--accent-foreground": "oklch(98% 0.01 85)",
  "--clay": "oklch(62% 0.09 60)",
  "--border": "oklch(86% 0.025 80)",
  "--input": "oklch(84% 0.025 80)",
  "--ring": "oklch(45% 0.08 250)",
  "--radius": "0.375rem",
  "--font-serif": '"Noto Serif TC", "Songti TC", serif',
  "--font-sans": '"Noto Sans TC", "PingFang TC", sans-serif',
  fontFamily: "var(--font-sans)",
} as React.CSSProperties;

/** 稿上的 font-serif。站上的 .font-serif 是 Cormorant 打頭的字面值，不能用。 */
const SERIF = "[font-family:var(--font-serif)]";
/** 稿上的 shadow-soft。 */
const SOFT = "[box-shadow:var(--sos-shadow)]";

/** 稿上的 .wave-divider（兩條墨線的海浪）。 */
const WAVE_DIVIDER: React.CSSProperties = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='28' viewBox='0 0 120 28'%3E%3Cpath d='M0 14 Q15 4 30 14 T60 14 T90 14 T120 14' fill='none' stroke='%23324a73' stroke-opacity='.35' stroke-width='1.2'/%3E%3Cpath d='M0 20 Q15 12 30 20 T60 20 T90 20 T120 20' fill='none' stroke='%23324a73' stroke-opacity='.18' stroke-width='1'/%3E%3C/svg%3E\")",
  backgroundRepeat: "repeat-x",
  backgroundSize: "120px 28px",
  height: 28,
};

export const Route = createFileRoute("/events/sound-of-the-sea")({
  loader: async () => fetchActiveProductForEventSlug(EVENT_SLUG),
  head: () => ({
    meta: [
      { title: PAGE.metaTitle.zh },
      { name: "description", content: PAGE.metaDescription.zh },
      { property: "og:title", content: PAGE.metaTitle.zh },
      { property: "og:description", content: PAGE.metaDescription.zh },
      { property: "og:image", content: imageFor(POSTER_KEY, "") },
      { name: "twitter:image", content: imageFor(POSTER_KEY, "") },
    ],
    links: [
      // 稿用的是 Noto Serif TC 400/600 與 Noto Sans TC 400/500；全站只載了
      // Serif 300–500，「應付總額」那個 600 要這一頁自己補。
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500&family=Noto+Serif+TC:wght@400;600&display=swap",
      },
    ],
  }),
  component: SoundOfTheSea,
});

function SoundOfTheSea() {
  useDocumentMeta({
    title: PAGE.metaTitle,
    description: PAGE.metaDescription,
    ogTitle: PAGE.metaTitle,
    ogDescription: PAGE.metaDescription,
    // ⚠️ 一定要帶：沒給 ogImage 時 useDocumentMeta 會移除 head() 放好的 og:image。
    ogImage: imageFor(POSTER_KEY, ""),
  });

  // 稿的 html 是 scroll-behavior: smooth（頁內錨點滑動）。只在這一頁開，離開時還原。
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.scrollBehavior;
    html.style.scrollBehavior = "smooth";
    return () => {
      html.style.scrollBehavior = prev;
    };
  }, []);

  return (
    <div style={THEME} className="min-h-screen bg-(--sos-paper) pb-24 text-foreground sm:pb-0">
      <TopBar />
      <Hero />
      <Quote />
      <Teacher />
      <PictureBook />
      <EventInfo />
      <About />
      <Past />
      <Registration />
      <footer className="py-10 text-center text-sm text-muted-foreground">
        <p className={`${SERIF} text-primary`}>小時光書店</p>
        <p className="mt-2">胡海音《海的聲音》手作繪本分享會</p>
      </footer>
      <BottomBar />
    </div>
  );
}

function SectionHead({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-10 text-center">
      <p className="text-xs tracking-[0.4em] text-accent">{eyebrow}</p>
      <h2 className={`${SERIF} mt-3 text-3xl tracking-normal text-primary sm:text-4xl`}>{title}</h2>
      <div className="mx-auto mt-5 w-40" style={WAVE_DIVIDER} />
    </div>
  );
}

function TopBar() {
  return (
    <header className="absolute inset-x-0 top-0 z-20">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Link to="/" className={`${SERIF} text-lg tracking-widest text-primary`}>
          小時光書店
        </Link>
        <nav className="hidden gap-8 text-sm text-foreground/80 sm:flex">
          <a href="#teacher" className="hover:text-primary">
            老師介紹
          </a>
          <a href="#book" className="hover:text-primary">
            繪本介紹
          </a>
          <a href="#info" className="hover:text-primary">
            活動資訊
          </a>
          <a href="#about" className="hover:text-primary">
            關於書店
          </a>
          <a href="#past" className="hover:text-primary">
            活動回顧
          </a>
        </nav>
        <a
          href="#register"
          className="rounded-full border border-primary px-4 py-1.5 text-sm text-primary transition hover:bg-primary hover:text-primary-foreground"
        >
          立即報名
        </a>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative flex min-h-[92vh] items-center overflow-hidden">
      <img
        src={heroWaves}
        alt="墨筆繪製的海浪"
        width={1920}
        height={1088}
        className="absolute inset-0 h-full w-full object-cover object-[70%_center]"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-(--sos-paper) via-(--sos-paper)/85 to-(--sos-paper)/10 sm:via-(--sos-paper)/70" />
      <div className="relative mx-auto w-full max-w-6xl px-5 pt-20">
        <div className="max-w-xl animate-in fade-in slide-in-from-bottom-[14px] duration-[900ms] ease-out fill-mode-both">
          <p className="text-sm tracking-[0.35em] text-accent">手作繪本分享會</p>
          <h1
            className={`${SERIF} mt-5 text-5xl leading-tight tracking-normal text-primary sm:text-7xl`}
          >
            海的聲音，
            <br />
            你聽過嗎？
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-foreground/85 sm:text-xl">
            胡海音｜在生命的聲音裡，練習傾聽與對話
          </p>
          <div className="mt-8 space-y-1 text-sm text-foreground/75">
            <p>2026.11.6（五）14:00–16:00</p>
            <p>小時光書店｜下午茶入場 NT$300</p>
          </div>
          <a
            href="#register"
            className={`mt-10 inline-flex items-center gap-3 rounded-md bg-primary px-8 py-4 text-base tracking-widest text-primary-foreground ${SOFT} transition hover:opacity-90`}
          >
            立即報名 <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>
    </section>
  );
}

function Quote() {
  return (
    <section className="bg-(--sos-ocean) py-16 text-(--sos-ocean-fg)">
      <blockquote
        className={`${SERIF} mx-auto max-w-3xl px-6 text-center text-xl leading-loose sm:text-2xl`}
      >
        「生命走過的痕跡都有聲音，你聽到了嗎？
        <br className="hidden sm:block" />
        我聽到海的聲音，來說給你聽，也聽聽你的聲音。」
      </blockquote>
    </section>
  );
}

function Teacher() {
  return (
    <section id="teacher" className="scroll-mt-10 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHead eyebrow="THE GUIDE" title="老師介紹" />
        <div className="grid items-start gap-10 md:grid-cols-[2fr_3fr] md:gap-16">
          <img
            src={imageFor(TEACHER_KEY, "")}
            alt="胡海音老師在分享會上手持麥克風的照片"
            loading="lazy"
            className={`aspect-[3/4] w-full rounded-lg object-cover ${SOFT}`}
          />
          <div>
            <h3 className={`${SERIF} text-3xl tracking-normal text-primary`}>胡海音</h3>
            <p className="mt-2 text-sm tracking-widest text-accent">
              溝通引導者・人文教育工作者・生命探索者
            </p>
            <div className="mt-6 space-y-4 leading-loose text-foreground/85">
              <p className={`${SERIF} text-lg text-primary/90`}>
                每個人的生命，都有自己的聲音。有些聲音來自歲月的累積，有些藏在未曾說出口的故事裡。當我們願意停下腳步，認真傾聽，或許就能重新理解自己，也重新理解彼此。
              </p>
              <p>
                胡海音老師長年投入企業文化、人文教育與溝通對話領域，始終相信，真正的溝通不只是語言的交換，更是人與人之間的理解與連結。
              </p>
              <p>
                她畢業於台灣大學農業經濟研究所，曾於中國生產力中心從事企業文化培訓及輔導工作 30
                年，在企業組織中播下人文思維的種子。她師從陳怡安老師，持續探索人文意識與生命思維，並投入非暴力溝通的學習與實踐，為
                CNVC（國際非暴力溝通中心）培訓師候選人。
              </p>
              <p>對她而言，溝通是一生的學習，生命則是一場值得不斷探索的旅程。</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function PictureBook() {
  const stats = [
    { n: "11", label: "段文字" },
    { n: "11", label: "頁圖畫" },
    { n: "＋", label: "生命簡史與照片" },
  ];
  return (
    <section id="book" className="scroll-mt-10 bg-sand/50 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHead eyebrow="THE PICTURE BOOK" title="繪本介紹" />
        <div className="grid items-center gap-10 md:grid-cols-2 md:gap-16">
          <div className="order-2 space-y-5 leading-loose text-foreground/85 md:order-1">
            <h3 className={`${SERIF} text-2xl tracking-normal text-primary`}>
              手作繪本《海的聲音》
            </h3>
            <p>近年，她將生命的感受與記憶，化為手作繪本《海的聲音》。</p>
            <div className="grid grid-cols-3 gap-3 py-2 text-center">
              {stats.map((s) => (
                <div key={s.label} className="rounded-md border border-border bg-card px-2 py-4">
                  <p className={`${SERIF} text-2xl text-primary`}>{s.n}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>
            <p>記錄歲月走過的痕跡，也留下對生命的凝視。</p>
            <p>
              在小時光書店，我們期待透過胡海音老師的分享，讓閱讀不只是知識的獲得，更成為生命之間溫柔而真實的交流。
            </p>
            <p className={`${SERIF} text-lg text-primary`}>因為每一段生命，都值得被聽見。</p>
          </div>
          <div className="order-1 grid grid-cols-1 gap-4 sm:grid-cols-2 md:order-2">
            <img
              src={pictureBook}
              alt="《海的聲音》書本實拍，擺放在書店木質層架上"
              loading="lazy"
              className={`aspect-[7/6] w-full rounded-lg object-cover ${SOFT}`}
            />
            <div className="sm:mt-10">
              <img
                src={imageFor(POSTER_KEY, "")}
                alt="《海的聲音》分享會活動海報，含日期、時間、地點與入場方式"
                loading="lazy"
                className={`aspect-[4/5] w-full rounded-lg object-cover ${SOFT}`}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function InfoRows({
  rows,
  dense = false,
}: {
  rows: { label: string; value: string }[];
  dense?: boolean;
}) {
  return (
    <dl
      className={`divide-y divide-border rounded-lg border border-border bg-card ${SOFT} ${dense ? "text-sm" : ""}`}
    >
      {rows.map((r) => (
        <div
          key={r.label}
          className={
            dense
              ? "grid grid-cols-[3.5rem_1fr] gap-3 px-4 py-3"
              : "grid grid-cols-[5rem_1fr] gap-4 px-6 py-5 sm:grid-cols-[8rem_1fr]"
          }
        >
          <dt className={`${SERIF} text-primary`}>{r.label}</dt>
          <dd className="text-foreground/85">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EventInfo() {
  return (
    <section id="info" className="scroll-mt-10 py-20 sm:py-28">
      <div className="mx-auto max-w-4xl px-5">
        <SectionHead eyebrow="EVENT INFO" title="活動資訊" />
        <InfoRows
          rows={[
            { label: "日期", value: "2026 年 11 月 6 日（星期五）" },
            { label: "時間", value: "14:00 – 16:00" },
            { label: "地點", value: "小時光書店（華山文創園區 紅磚六合院 西 7-3 館）" },
            { label: "入場", value: "每人 NT$300（含下午茶）" },
            {
              label: "加購",
              value:
                "《海的聲音》手作繪本 每本 NT$425（可選；報名時選「入場＋《海的聲音》手作繪本」NT$725）",
            },
            {
              label: "付款",
              value: "線上報名即付款：信用卡線上付款，或銀行匯款（下單後 3 天內完成）",
            },
          ]}
        />
      </div>
    </section>
  );
}

function About() {
  const features = [
    { title: "風土誌策展", body: "以地方為線索，策劃書展、選物與內容。" },
    { title: "活動與讀書會", body: "讀書會、講座、工作坊、身心靈活動。" },
    { title: "策旅與合作共創", body: "與在地夥伴設計風土主題旅程與品牌共創。" },
  ];
  const bullets = [
    "自選茶點與小份量甜食",
    "安靜閱讀座位（請小聲交談）",
    "不定期舉辦讀書會、講座與身心靈活動",
    "可詢問主理人選書與選品建議",
  ];
  return (
    <section id="about" className="scroll-mt-10 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHead eyebrow="THE BOOKSTORE" title="關於小時光書店" />
        <div className="grid items-start gap-10 md:grid-cols-[3fr_2fr] md:gap-16">
          <div className="space-y-5 leading-loose text-foreground/85">
            <p className={`${SERIF} text-lg text-primary/90`}>
              我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。
            </p>
            <p>
              從一櫃書、一張長桌開始，我們慢慢有了陶藝家的器物、地方夥伴的選物，與每月一場讀書會。書店並不大，但它是我們對於「閱讀」的長時間練習——讓書頁與生活，能彼此呼吸。
            </p>
            <div className="grid gap-3 pt-2 sm:grid-cols-3">
              {features.map((f) => (
                <div key={f.title} className="rounded-md border border-border bg-card p-4">
                  <p className={`${SERIF} text-primary`}>{f.title}</p>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                </div>
              ))}
            </div>
            <ul className="space-y-2 border-t border-border pt-5 text-sm text-foreground/80">
              {bullets.map((b) => (
                <li key={b} className="flex items-start gap-3">
                  <span aria-hidden="true" className="mt-2 h-px w-6 shrink-0 bg-accent/60" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-4">
            {/* 稿上這裡是「書店空間照片／圖片待替換」的佔位框，換成站上既有的書店實景。 */}
            <img
              src={bookstoreInterior}
              alt="小時光書店空間"
              loading="lazy"
              className={`aspect-[4/3] w-full rounded-lg object-cover ${SOFT}`}
            />
            <InfoRows
              dense
              rows={[
                {
                  label: "來訪",
                  value: "華山文創園區 紅磚六合院 西 7-3 館（台北市中正區八德路一段 1 號）",
                },
                { label: "時間", value: "週一至週日 11:00 – 19:00" },
                { label: "捷運", value: "板南線「忠孝新生站」1 號出口，步行約 3 分鐘" },
                { label: "聯繫", value: `intervalbookstores@gmail.com｜${PHONE}` },
              ]}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Past() {
  return (
    <section id="past" className="scroll-mt-10 bg-sand/50 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHead eyebrow="PAST GATHERINGS" title="歷史活動精彩回顧" />
        <p className="mx-auto max-w-2xl text-center leading-loose text-foreground/80">
          一張長桌，也容得下許多的相遇。以下節錄曾與我們同行、或正在往來的創作者——他們的名字，是這間書店的一部分。
        </p>
        <div className="mt-12 grid gap-8 md:grid-cols-2">
          <article className={`overflow-hidden rounded-lg border border-border bg-card ${SOFT}`}>
            <img
              src={laiChunchun}
              alt="活動現場：前景為《存在・變化 賴純純》一書（家庭美術館・美術家傳記叢書，張晴文 著），背景講師正持麥克風開講"
              loading="lazy"
              className={`aspect-[4/3] w-full rounded-lg object-cover ${SOFT}`}
            />
            <div className="p-6 sm:p-8">
              <p className="text-xs tracking-[0.3em] text-accent">藝術家</p>
              <h3 className={`${SERIF} mt-2 text-2xl tracking-normal text-primary`}>賴純純</h3>
              <div className="mt-4 space-y-3 text-sm leading-loose text-foreground/85">
                <p>
                  1953
                  年生於臺北，中國文化大學美術系畢業，日本多摩美術大學藝術學院碩士。創作涵蓋繪畫、雕塑、裝置、觀念行動與公共藝術。
                </p>
                <p>
                  2000
                  年起以「仙境」為創作主軸，在青春、島嶼與海洋的子題下，建構個人與島嶼的定位；2007
                  年後將重心轉向東部海洋，長居都蘭。
                </p>
                <p>
                  創辦 SOCA
                  現代藝術工作室，為台灣女性藝術協會創會理事長；曾獲台北市立美術館「現代雕塑展」首獎、文化部公共藝術獎項及吳三連「藝術成就獎」。
                </p>
              </div>
            </div>
          </article>
          <article className={`overflow-hidden rounded-lg border border-border bg-card ${SOFT}`}>
            {/* 稿上這裡是「范毅舜照片／圖片待替換」。沒有照片，就不畫一個假裝是照片的框，
                改成他的創作信念——同樣的 4:3 位置，兩張卡片高度仍然對齊。 */}
            <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-4 rounded-lg bg-(--sos-ocean) px-8 text-center text-(--sos-ocean-fg)">
              <svg
                width="44"
                height="22"
                viewBox="0 0 44 22"
                fill="none"
                aria-hidden="true"
                className="opacity-60"
              >
                <path
                  d="M1 11 Q6 3 11 11 T22 11 T33 11 T44 11"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
              </svg>
              <p className={`${SERIF} text-xl leading-loose sm:text-2xl`}>
                「拍我寫不出來的，
                <br />
                寫我拍不出來的」
              </p>
              <p className="text-xs tracking-[0.3em] opacity-70">范毅舜</p>
            </div>
            <div className="p-6 sm:p-8">
              <p className="text-xs tracking-[0.3em] text-accent">國際攝影藝術家・作家</p>
              <h3 className={`${SERIF} mt-2 text-2xl tracking-normal text-primary`}>范毅舜</h3>
              <div className="mt-4 space-y-3 text-sm leading-loose text-foreground/85">
                <p>
                  人稱「小五哥」，美國加州布魯克攝影學院（Brooks Institute of
                  Photography）碩士。曾受邀於美國華府參議院、德國 Leica 藝廊、法國尼斯 Alian
                  Coutuier 藝廊、台北誠品藝廊等地舉行攝影個展。
                </p>
                <p>
                  獲瑞典哈蘇專業相機公司推崇為全球最優秀的 150 位攝影家之一，也是在德國 Leica
                  總部舉行攝影個展的唯一華人；作品為美國會圖書館、參議院與台北市立美術館等典藏。
                </p>
                <p>
                  已出版近 50
                  本著作，包括《老家人》《海岸山脈的瑞士人》《山丘上的修道院》《公東的教堂》；以「拍我寫不出來的，寫我拍不出來的」為創作信念。
                </p>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

// ── 報名 ──────────────────────────────────────────────────────────────────────

/**
 * 報名區：外觀照稿（海藍底、白卡片、金額小計、應付總額），內容是站上既有的三個零件。
 *
 * 🔴 不自己算任何座位數字——上限一律問 directSeatLimit()，剩餘由 SessionPicker／
 *    PlanPicker 自己顯示。沒選好場次與方案時按鈕是 <button disabled>，不是 <Link>：
 *    「沒選就去結帳」在 DOM 裡不存在。理由與 events.city-salon-0922.tsx 相同。
 */
function Registration() {
  const { product, unavailable } = Route.useLoaderData();
  return (
    <section id="register" className="scroll-mt-6 bg-(--sos-ocean) py-20 sm:py-28">
      <div className="mx-auto max-w-2xl px-5">
        <div className="mb-10 text-center text-(--sos-ocean-fg)">
          <p className="text-xs tracking-[0.4em] opacity-70">REGISTRATION</p>
          <h2 className={`${SERIF} mt-3 text-3xl tracking-normal sm:text-4xl`}>報名參加</h2>
          <p className="mt-4 text-sm opacity-80">帶著你的故事來，一起聽見海的聲音。</p>
        </div>
        <div className={`rounded-xl bg-card p-6 sm:p-10 ${SOFT}`}>
          {unavailable ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              報名資料暫時無法載入，請稍後再試，或直接來電 {PHONE}。
            </p>
          ) : !product ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              報名尚未開放。開放之後會在這裡放上報名方式。
            </p>
          ) : (
            <Booking product={product} />
          )}
        </div>
      </div>
    </section>
  );
}

/** 唯一場次底下，第一個還能買的方案（＝稿上一打開就是「入場（含下午茶）× 1」）。 */
function firstOpenPlanId(session: ShopSession | null): string | null {
  return session?.plans.find((p) => isPlanAvailable(p))?.id ?? null;
}

function Booking({ product }: { product: ShopProduct }) {
  const [sessionId, setSessionId] = useState<string | null>(
    () => directSoleSession(product)?.id ?? null,
  );
  const [planId, setPlanId] = useState<string | null>(() =>
    firstOpenPlanId(directSoleSession(product)),
  );
  const [qty, setQty] = useState(1);

  const selectedSession = product.sessions.find((s) => s.id === sessionId) ?? null;
  const needsPlan = selectedSession !== null && selectedSession.plans.length > 0;
  const selectedPlan = selectedSession?.plans.find((p) => p.id === planId) ?? null;
  const readyToBook = selectedSession !== null && (!needsPlan || selectedPlan !== null);
  const seatLimit = selectedSession ? directSeatLimit(product, selectedSession, selectedPlan) : 1;
  // 單價只拿來顯示小計；結帳頁會用目錄裡的價格重新算一次，這裡算錯也收不到錯的錢。
  const unitPrice = selectedPlan ? selectedPlan.price : product.price;
  const lineLabel = selectedPlan ? selectedPlan.title.zh : "入場（含下午茶）";

  if (!directAnySeatsLeft(product)) {
    return (
      <>
        <SessionList sessions={product.sessions} showSeatsRemaining={product.showSeatsRemaining} />
        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          本場次名額已滿。若仍希望參加，歡迎來電 {PHONE} 由我們為您安排候補。
        </p>
      </>
    );
  }

  return (
    <div className="space-y-5">
      <SessionPicker
        sessions={product.sessions}
        showSeatsRemaining={product.showSeatsRemaining}
        selectedId={sessionId}
        onSelect={(id) => {
          setSessionId(id);
          setPlanId(firstOpenPlanId(product.sessions.find((s) => s.id === id) ?? null));
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

      <div>
        <p className="mb-1.5 block text-sm font-medium text-foreground">參加人數</p>
        <QuantityStepper
          value={qty}
          max={seatLimit}
          onChange={(next) => setQty(Math.max(1, next))}
          label="參加人數"
          disabled={!readyToBook}
        />
      </div>

      <div className="rounded-lg border border-border bg-muted p-5" aria-live="polite">
        <div className="flex justify-between gap-4 text-sm text-muted-foreground">
          <span>
            {lineLabel} {formatPrice(unitPrice)} × {qty}
          </span>
          <span className="shrink-0">{formatPrice(unitPrice * qty)}</span>
        </div>
        <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
          <span className={`${SERIF} text-lg`}>應付總額</span>
          <span className={`${SERIF} text-2xl font-semibold text-primary`}>
            {formatPrice(unitPrice * qty)}
          </span>
        </div>
      </div>

      <p className="text-sm leading-relaxed">
        下一步填寫參加者姓名、電話與電子郵件並完成付款。個人資料僅用於本次活動之報名聯繫、人數統計與書籍準備，不作其他用途。
      </p>
      <p className="rounded-md border-l-2 border-accent bg-card px-4 py-3 text-sm text-muted-foreground">
        付款方式於下一步選擇：信用卡線上付款，或銀行匯款（下單後 3
        天內完成，逾期名額將釋出）。完成付款即完成報名。
      </p>

      {readyToBook && selectedSession ? (
        <Link
          to="/checkout"
          search={directCheckoutSearch(product, selectedSession, qty, selectedPlan)}
          className={`block w-full rounded-md bg-primary px-6 py-4 text-center text-base font-medium tracking-widest text-primary-foreground ${SOFT} transition hover:opacity-90`}
        >
          立即報名 →
        </Link>
      ) : (
        // 🔴 不是 <Link>。沒選好場次與方案的時候「去結帳」這條路在 DOM 裡不該存在。
        <button
          type="button"
          disabled
          className={`w-full cursor-not-allowed rounded-md bg-primary px-6 py-4 text-base font-medium tracking-widest text-primary-foreground opacity-60 ${SOFT}`}
        >
          立即報名 →
        </button>
      )}
    </div>
  );
}

function BottomBar() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-(--sos-paper)/95 px-4 py-3 backdrop-blur sm:hidden">
      <a
        href="#register"
        className="flex items-center justify-between rounded-md bg-primary px-5 py-3.5 text-primary-foreground"
      >
        <span className="text-sm">11/6（五）14:00｜NT$300</span>
        <span className="font-medium tracking-widest">立即報名 →</span>
      </a>
    </div>
  );
}
