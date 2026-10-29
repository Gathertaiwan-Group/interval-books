import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { SessionPicker, SessionList } from "@/components/shop/SessionPicker";
import { PlanPicker } from "@/components/shop/PlanPicker";
import { QuantityStepper } from "@/components/shop/ShopBits";
import { FixedLanguage } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import {
  directAnySeatsLeft,
  directCheckoutSearch,
  directSeatLimit,
  directSoleSession,
} from "@/lib/direct-checkout";
import { imageFor } from "@/lib/images";
import {
  fetchActiveProductForEventSlug,
  formatPrice,
  isPlanAvailable,
  type ShopProduct,
  type ShopSession,
} from "@/lib/shop";
import { HERO_KEY } from "@/components/kungtung/images";
import {
  Faq,
  Hero,
  Hosts,
  Itinerary,
  Moments,
  Price,
  SiteFooter,
  SiteHeader,
  SkipLink,
  Space,
  Story,
  TripNotice,
  Values,
} from "@/components/kungtung/MainSections";
import kungtungCss from "@/components/kungtung/kungtung.css?url";

/**
 * 《范毅舜公東教堂文化之旅｜台東三天兩夜》（2026.11.14–11.16）的策旅著陸頁。
 *
 * ═══ 為什麼有自己的路由 ═══════════════════════════════════════════════════════
 * 業主在 Lovable 做好一份參考站（www.kungtung.intervalbooks.tw），要「一模一樣」。
 * 做法照《海的聲音》（events.sound-of-the-sea.tsx）：靜態檔名優先於 events.$slug.tsx。
 * 網址放在 /events/kungtung 而不是 /journeys/<slug>，因為這是站上策旅的既有慣例：
 * 策旅卡片（public.journeys）的 external_url 指向報名那一場活動的頁面（池上那檔是
 * /events/InntervalChishang.1023，一頁新增 buildJourneyCard() 也是這樣產生的），
 * 而 /journeys 本身沒有子路由。
 *
 * 版面：靜態章節是把參考站伺服器輸出的 HTML 逐節轉成 JSX（MainSections.tsx），樣式是
 * 參考站 styles.css 的自訂部分加上 .kt-root 範圍與 kt- 前綴（kungtung.css）。
 *
 * 🔴 版面照稿，**報名與收錢走站上既有的那一套**（見 CLAUDE.md 最上面那條）：
 *    products（event-kungtung）→ event_sessions（1 梯）→ event_session_plans（4 種）
 *    → /checkout（directCheckoutSearch）→ orders → event_registrations。
 *    稿上的報名表（姓名／電話／Email／人數／飲食需求／備註）**沒有照搬**：聯絡資料在
 *    /checkout 填，飲食需求與小時光知友身分寫在結帳頁的備註（orders.note）。
 *
 * 與稿不同的地方（刻意的）：
 *   - 報名區右欄換成場次／票種／人數與「前往結帳」，付款說明寫站上真的有的三種方式。
 *   - 「下次，我想這樣玩」願望募集：站上沒有收這種資料的表，送出改成開啟電子郵件
 *     寄給書店信箱；「會儲存在小時光的後台」那句改寫成實際行為。
 *   - 原站的 favicon 不搬，沿用全站的。
 */

/** 三語 meta。⚠️ 必須是頂層靜態常數、每一句都是字面值——check-meta.mjs 靜態解析這個物件。 */
const PAGE = {
  metaTitle: {
    zh: "范毅舜公東教堂文化之旅｜台東三天兩夜｜小時光書店",
    en: "Nicholas Fan's Kung Tung Chapel Cultural Journey｜Taitung, 3 Days 2 Nights｜Interval Books",
    ja: "范毅舜と巡る公東教会文化の旅｜台東2泊3日｜小時光書店",
  },
  metaDescription: {
    zh: "2026.11.14–11.16｜台東・三天兩夜。跟著范毅舜讀懂一座教堂，跟著 Alice 感受一種生活。范毅舜親自導覽公東教堂、入住 INNTERVAL 馥自然人文空間。旅程費用 NT$19,800／人起。",
    en: "14–16 Nov 2026, Taitung, 3 days 2 nights. Read the Kung Tung Chapel with photographer Nicholas Fan and stay at INNTERVAL Fu Nature & Humanities Space. From NT$19,800 per person.",
    ja: "2026年11月14日〜16日、台東2泊3日。写真家・范毅舜の案内で公東教会を巡り、INNTERVAL 馥自然人文空間に滞在する旅。お一人様 NT$19,800 から。",
  },
};

const EVENT_SLUG = "kungtung";
const PHONE = "02-2341-6800";
const EMAIL = "intervalbookstores@gmail.com";

/** 原站載入的字重（Noto Sans TC 300/400/500、Noto Serif TC 400/600）。全站沒有 Serif 600。 */
const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500&family=Noto+Serif+TC:wght@400;600&display=swap";

/** 原站 shadcn Button（variant default）的 class，報名區與手機底部列的按鈕用。 */
const BUTTON =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2";

export const Route = createFileRoute("/events/kungtung")({
  loader: async () => fetchActiveProductForEventSlug(EVENT_SLUG),
  head: () => ({
    meta: [
      { title: PAGE.metaTitle.zh },
      { name: "description", content: PAGE.metaDescription.zh },
      { property: "og:title", content: PAGE.metaTitle.zh },
      { property: "og:description", content: PAGE.metaDescription.zh },
      { property: "og:image", content: imageFor(HERO_KEY, "") },
      { name: "twitter:image", content: imageFor(HERO_KEY, "") },
    ],
    links: [
      { rel: "stylesheet", href: FONTS_HREF },
      { rel: "stylesheet", href: kungtungCss },
    ],
  }),
  component: KungtungJourney,
});

function KungtungJourney() {
  useDocumentMeta({
    title: PAGE.metaTitle,
    description: PAGE.metaDescription,
    ogTitle: PAGE.metaTitle,
    ogDescription: PAGE.metaDescription,
    // ⚠️ 一定要帶：沒給 ogImage 時 useDocumentMeta 會移除 head() 放好的 og:image。
    ogImage: imageFor(HERO_KEY, ""),
  });

  // 原站 html { scroll-behavior: smooth }。只在這一頁開，離開時還原。
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.scrollBehavior;
    html.style.scrollBehavior = "smooth";
    return () => {
      html.style.scrollBehavior = prev;
    };
  }, []);

  // 原站：報名區進入畫面時，手機底部的「預約」列收起來。
  const [formVisible, setFormVisible] = useState(false);
  useEffect(() => {
    const el = document.getElementById("register");
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) =>
      setFormVisible(entry?.isIntersecting ?? false),
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="kt-root">
      <main className="kt-tour-page">
        <SkipLink />
        <SiteHeader />
        <Hero />
        <Story />
        <Values />
        <Hosts />
        <Moments />
        <Itinerary />
        <Space />
        <Price />
        <Faq />
        <Registration />
        <NextJourney />
        <TripNotice />
        <SiteFooter />
        <MobileReserve formVisible={formVisible} />
      </main>
    </div>
  );
}

function ArrowUpRight() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="lucide lucide-arrow-up-right"
      aria-hidden="true"
    >
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="lucide lucide-phone"
      aria-hidden="true"
    >
      <path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="lucide lucide-mail"
      aria-hidden="true"
    >
      <path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" />
      <rect x="2" y="4" width="20" height="16" rx="2" />
    </svg>
  );
}

/**
 * 報名區。左欄照稿；右欄原本是自己的報名表，換成站上既有的場次／票種／人數與結帳。
 *
 * 🔴 不自己算任何座位數字——上限一律問 directSeatLimit()，剩餘由 SessionPicker／
 *    PlanPicker 自己顯示。沒選好場次與方案時按鈕是 <button disabled>，不是 <Link>。
 */
function Registration() {
  const { product, unavailable } = Route.useLoaderData();
  return (
    <section id="register" className="kt-registration-section kt-section-band">
      <div className="kt-editorial-container kt-registration-layout">
        <div>
          <p className="kt-eyebrow">RESERVE YOUR JOURNEY / 預約旅程</p>
          <h2 className="kt-section-title">
            留一段時間，
            <br />
            給值得走進的故事。
          </h2>
          <p className="mt-6 leading-loose">
            2026.11.14–11.16｜台東・三天兩夜
            <br />
            旅程費用 NT$19,800／人・小時光知友 NT$16,800
            <br />
            兩人一房・6 人（含）以上成行
            <br />
            單人入住兩晚加價 NT$10,000
          </p>
          <div className="kt-contact-block">
            <h3 className="text-lg">聯絡窗口</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              行程、付款與報名確認，歡迎來電或來信。
            </p>
            <a href="tel:0223416800">
              <PhoneIcon />
              02-2341-6800
            </a>
            <a href="tel:0917540615">
              <PhoneIcon />
              0917-540-615
            </a>
            <a href={`mailto:${EMAIL}`}>
              <MailIcon />
              {EMAIL}
            </a>
          </div>
        </div>
        <div>
          <div className="kt-registration-form" aria-label="文化旅程報名">
            {unavailable ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                報名資料暫時無法載入，請稍後再試，或直接來電 {PHONE}。
              </p>
            ) : !product ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                報名尚未開放。開放之後會在這裡放上報名方式。
              </p>
            ) : (
              // 這一頁只有中文版：共用的場次／票種元件也固定顯示中文。
              <FixedLanguage lang="zh">
                <Booking product={product} />
              </FixedLanguage>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** 唯一梯次底下，第一個還能買的票種（＝一般旅程價・兩人一房）。 */
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
  const lineLabel = selectedPlan ? selectedPlan.title.zh : "旅程費用";

  if (!directAnySeatsLeft(product)) {
    return (
      <>
        <SessionList sessions={product.sessions} showSeatsRemaining={product.showSeatsRemaining} />
        <p className="text-sm leading-relaxed text-muted-foreground">
          本梯次名額已滿。若仍希望參加，歡迎來電 {PHONE} 由我們為您安排候補。
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
        <p className="mb-1.5 block text-sm">報名人數</p>
        <QuantityStepper
          value={qty}
          max={seatLimit}
          onChange={(next) => setQty(Math.max(1, next))}
          label="報名人數"
          disabled={!readyToBook}
        />
      </div>

      <div className="border-t border-border pt-5" aria-live="polite">
        <div className="flex justify-between gap-4 text-sm text-muted-foreground">
          <span>
            {lineLabel} {formatPrice(unitPrice)} × {qty}
          </span>
          <span className="shrink-0">{formatPrice(unitPrice * qty)}</span>
        </div>
        <div className="mt-3 flex items-baseline justify-between">
          <span className="font-serif text-lg">應付總額</span>
          <span className="font-serif text-2xl text-primary">{formatPrice(unitPrice * qty)}</span>
        </div>
      </div>

      <p className="text-sm leading-relaxed text-muted-foreground">
        下一步填寫姓名、聯絡電話與
        Email，並選擇付款方式。飲食需求、其他備註，以及小時光知友身分，請寫在結帳頁的「備註」。
      </p>

      <div className="kt-privacy-notice" id="privacy-notice">
        您的姓名、聯絡方式、人數及需求，僅供本次旅程報名聯繫、行程安排與必要服務確認使用。
      </div>

      {readyToBook && selectedSession ? (
        <Link
          to="/checkout"
          search={directCheckoutSearch(product, selectedSession, qty, selectedPlan)}
          className={`${BUTTON} kt-journey-button w-full`}
          aria-describedby="privacy-notice"
        >
          填寫報名資料
          <ArrowUpRight />
        </Link>
      ) : (
        // 🔴 不是 <Link>。沒選好梯次與票種的時候「去結帳」這條路在 DOM 裡不該存在。
        <button type="button" disabled className={`${BUTTON} kt-journey-button w-full`}>
          填寫報名資料
          <ArrowUpRight />
        </button>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        付款方式於下一步選擇：信用卡線上付款、銀行匯款（報名後席次保留 3 天，請於 3
        天內完成匯款，逾期名額將釋出），或由我們與你聯繫付款。
      </p>
    </>
  );
}

const WISH_OPTIONS = [
  "秘境建築與文化",
  "攝影與藝術旅行",
  "名人作家同行",
  "山海風土美食",
  "音樂與生活沙龍",
  "自然療癒與慢旅",
  "地方職人深度交流",
  "一個人的自在旅行",
];

/**
 * 「下次，我想這樣玩」願望募集。版面與欄位照稿。
 *
 * ⚠️ 原站把願望存進它自己的後台；本站沒有收這種資料的表（CLAUDE.md 只准報名走
 *    event_registrations，這不是報名），所以送出時組一封信、用 mailto: 開啟訪客的
 *    電子郵件程式寄到書店信箱。要改成存進後台，得先問店家要不要、誰來看。
 */
function NextJourney() {
  const [picked, setPicked] = useState<string[]>([]);
  const [wish, setWish] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [joinFriends, setJoinFriends] = useState(false);
  const [notify, setNotify] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (opt: string) =>
    setPicked((cur) => (cur.includes(opt) ? cur.filter((o) => o !== opt) : [...cur, opt]));

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (picked.length === 0 && !wish.trim()) {
      setError("請至少選一項，或寫下你的旅行願望。");
      return;
    }
    setError(null);
    const body = [
      `下一次最想體驗：${picked.length ? picked.join("、") : "（未選）"}`,
      "",
      "旅行願望：",
      wish.trim() || "（未填）",
      "",
      `怎麼稱呼：${name.trim() || "（未填）"}`,
      `電子信箱：${email.trim() || "（未填）"}`,
      `免費加入小時光知友：${joinFriends ? "是" : "否"}`,
      `同意接收未來策旅通知：${notify ? "是" : "否"}`,
    ].join("\n");
    const subject = "【下次，我想這樣玩】旅行願望（范毅舜公東教堂文化之旅頁面）";
    window.location.href = `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <section id="next-journey" className="kt-next-journey-band">
      <div className="kt-editorial-container">
        <p className="kt-eyebrow">NEXT JOURNEY / 下一次，我想這樣玩</p>
        <h2 className="kt-section-title">下次，我想這樣玩！</h2>
        <p className="kt-body-copy mt-4 max-w-2xl">
          每個人心裡，都藏著一趟嚮往的旅行。也許是跟著攝影家尋找光影、走進有故事的建築，或只是找個地方，陪自己慢慢生活。告訴我們，你心中最想要的旅行模樣。你的想法，可能成為小時光下一趟文化策旅的靈感。
        </p>
        <p className="kt-wish-disclaimer" role="note">
          這是未來旅程的靈感募集，不影響本次 11/14–11/16 已公布的行程，也不代表主辦方已承諾安排。
        </p>
        <form className="mt-8 max-w-2xl space-y-6" onSubmit={onSubmit} noValidate>
          <fieldset>
            <legend className="mb-3 text-sm font-medium">下一次，你最想體驗什麼？（可複選）</legend>
            <div className="flex flex-wrap gap-2">
              {WISH_OPTIONS.map((opt) => {
                const on = picked.includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(opt)}
                    className={`rounded-full border px-4 py-2 text-sm transition-colors ${on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:border-primary"}`}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label className="block">
            <span className="mb-2 block text-sm font-medium">
              如果可以許一個旅行願望，你會想去哪裡、做什麼？
            </span>
            <textarea
              maxLength={1000}
              rows={4}
              value={wish}
              onChange={(e) => setWish(e.target.value)}
              placeholder="例如：想去有老建築的小鎮住兩晚、想跟著喜歡的作家走讀、想找個海邊什麼都不做……"
              className="w-full rounded-sm border border-input bg-background p-3 text-base leading-relaxed"
            />
          </label>
          <fieldset className="space-y-4">
            <legend className="text-sm font-medium">
              聯絡方式（完全選填，想讓我們認識你再填就好）
            </legend>
            <label className="block">
              <span className="mb-2 block text-sm">怎麼稱呼你</span>
              <input
                type="text"
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-sm border border-input bg-background p-3 text-base"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm">電子信箱</span>
              <input
                type="email"
                maxLength={255}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-sm border border-input bg-background p-3 text-base"
              />
            </label>
          </fieldset>
          <div className="space-y-3">
            <label className="flex items-start gap-3 text-sm leading-relaxed">
              <input
                type="checkbox"
                className="mt-1"
                checked={joinFriends}
                onChange={(e) => setJoinFriends(e.target.checked)}
              />
              <span>免費加入小時光知友</span>
            </label>
            <label className="flex items-start gap-3 text-sm leading-relaxed">
              <input
                type="checkbox"
                className="mt-1"
                checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
              />
              <span>同意接收未來策旅通知</span>
            </label>
            <p className="text-xs text-muted-foreground leading-relaxed">
              兩項都是自由勾選，不勾也不影響送出願望；填寫願望不等於報名本次旅程。
            </p>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className={BUTTON}>
            送出我的旅行願望
          </button>
          <p className="kt-privacy-notice">
            按下送出後，會開啟您的電子郵件程式，把願望與聯絡方式寄到小時光的信箱（{EMAIL}
            ），僅供主辦方規劃未來文化策旅時參考，不會公開，也不會提供給第三方。不想留下聯絡方式，也可以只寫願望。
          </p>
        </form>
      </div>
    </section>
  );
}

function MobileReserve({ formVisible }: { formVisible: boolean }) {
  return (
    <div className="kt-mobile-reserve" data-form-visible={formVisible ? "true" : "false"}>
      <div>
        <strong>NT$19,800</strong>
        <span>／人・知友 NT$16,800</span>
      </div>
      <a href="#register" className={`${BUTTON} kt-journey-button`}>
        預約這趟文化旅程
        <ArrowUpRight />
      </a>
    </div>
  );
}
