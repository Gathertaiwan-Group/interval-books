import { useEffect, useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { fetchEventVisibility } from "@/lib/cms";
import { EventEndedNotice, SessionList, SessionPicker } from "@/components/shop/SessionPicker";
import { PlanPicker } from "@/components/shop/PlanPicker";
import { QuantityStepper } from "@/components/shop/ShopBits";
import { FixedLanguage } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fitDescription } from "@/lib/seo/core";
import { langFromMatches, pageHead, withLinks } from "@/lib/seo/head";
import { eventEnded, landingEventLd, storeAddressFromMatches } from "@/lib/seo/pages";
import {
  directAnySeatsLeft,
  directBookingClosed,
  directCheckoutSearch,
  directSeatLimit,
  directSelectedSession,
  directSoleSession,
} from "@/lib/direct-checkout";
import { useBookingNow } from "@/hooks/use-booking-now";
import { imageFor } from "@/lib/images";
import {
  fetchActiveProductForEventSlug,
  formatPrice,
  isPlanAvailable,
  type ShopProduct,
  type ShopSession,
} from "@/lib/shop";
import heroTable from "@/assets/soul-dinner/hero-table.webp";
import { Section, SoulFooter, SoulHeader } from "@/components/soul-dinner/Chrome";
import {
  BUTTON_BASE,
  BUTTON_CLAY,
  EVENT_SLUG,
  FILMS,
  FONTS_HREF,
  HERO_KEY,
  SCHEDULE,
} from "@/components/soul-dinner/data";
import soulCss from "@/components/soul-dinner/soul-dinner.css?url";

/**
 * 《小時光｜靈魂飯桌》著陸頁（週二晚間電影飯桌，2026-11-24 起）。
 *
 * ═══ 為什麼有自己的路由 ═══════════════════════════════════════════════════════
 * 業主在 Lovable 做好一份參考站（soul-movie.lovable.app），要「內容完全一模一樣」。
 * 做法照公東策旅（events.kungtung.tsx）：靜態檔名優先於 events.$slug.tsx，五個電影
 * 子頁是 events.soul-dinner_.films.$film.tsx；樣式是稿上的色票與紙卡，限定在 .sd-root。
 *
 * 🔴 版面照稿，**報名與收錢走站上既有的那一套**（見 CLAUDE.md 最上面那條）：
 *    products（event-soul-dinner）→ event_sessions（四個週二，各 20 位）→
 *    event_session_plans（單場飯票 NT$500）→ /checkout → orders → event_registrations。
 *    稿上的預約表（姓名／Email／票種／人數／飲食需求）沒有照搬：聯絡資料在 /checkout
 *    填，飲食需求寫在結帳頁的備註。
 *
 * 與稿不同的地方（業主 2026-11-08 決定）：
 *   - 不賣「五場套票 NT$2,000」：站上一張票只對應一個場次，沒有跨場次的套票。第五場
 *     片名公布後再開放單場報名（屆時到後台加場次即可，這一頁的報名區自動出現）。
 *   - 不做「映後小客廳」留言區：電影子頁拿掉留言區，頁首的「登入」與 FAQ 那一題一併拿掉。
 *   - FAQ「送出表單就完成報名了嗎？」「第五場」「飲食限制」三題的答案改寫成站上實際的
 *     報名與付款方式（稿上是「預約登記、尚未付款」）。
 *
 * ⚠️ 內容寫死在這裡與 src/components/soul-dinner/data.ts，後台改不到。
 * ⚠️ 內文只有中文（ZH_ONLY_PATHS），meta 三語（scripts/check-meta.mjs 要求）。
 */

/** 三語 meta。⚠️ 必須是頂層靜態常數、每一句都是字面值——check-meta.mjs 靜態解析這個物件。 */
const PAGE = {
  metaTitle: {
    zh: "小時光｜靈魂飯桌｜給靈魂一張飯票，也給相遇一個位置",
    en: "Interval Books｜Soul Dinner Table｜A meal ticket for the soul, a seat for meeting",
    ja: "小時光｜魂の食卓｜魂に一枚の食事券を、出会いにひとつの席を",
  },
  metaDescription: {
    zh: "一起吃飯，看電影，遇見懂你的人。光中心周介偉老師與 Alice老師共同主講，週二晚間五場電影飯桌，開放預約報名。",
    en: "Share a meal, watch a film, and meet people who understand you. Five Tuesday-evening film dinners co-hosted by Chou Chieh-Wei of Light Center and Alice. Booking now open.",
    ja: "一緒に食べて、映画を観て、わかり合える人に出会う。光中心の周介偉先生と Alice 先生による、火曜夜の五回の映画の食卓。予約受付中。",
  },
};

const TICKET_PRICE = 500;

const FAQ: readonly { q: string; a: string }[] = [
  {
    q: "這是交友或配對活動嗎？",
    a: "不是。靈魂飯桌是一起吃飯、看電影與交流的聚會，不提供配對服務，也不保證任何關係的結果。我們只是為相遇留一個位置。",
  },
  {
    q: "送出表單就完成報名了嗎？",
    a: "選好場次與人數後會進入結帳頁，填寫聯絡資料並選擇付款方式；完成付款（匯款則於核對款項後）即保留座位，我們會以 Email 寄送報名確認。",
  },
  { q: "活動地點在哪裡？", a: "地點待確認，確認後會通知已報名的朋友，並更新於本頁。" },
  {
    q: "晚餐是什麼時候？流程如何？",
    a: "活動時間為週二 19:30–21:30，晚餐時間與實際觀影流程待公布。",
  },
  { q: "第五場是什麼電影？", a: "第五場片名待公布，片名確認後再開放報名。" },
  { q: "有飲食限制怎麼辦？", a: "可在結帳頁的備註填寫飲食需求，我們會盡量協助安排。" },
];

export const Route = createFileRoute("/events/soul-dinner")({
  // now：「場次開始了沒」的判斷時間點，SSR 與第一次 hydrate 共用（見 useBookingNow）。
  // 版面寫死在這裡，草稿／下架時要另外擋——活動不是「上架」就 404，與 /events/$slug 同一條規則。
  loader: async () => {
    const [visibility, booking] = await Promise.all([
      fetchEventVisibility(EVENT_SLUG),
      fetchActiveProductForEventSlug(EVENT_SLUG),
    ]);
    if (!visibility.visible && !visibility.unavailable) throw notFound();
    return { ...booking, now: Date.now() };
  },
  head: ({ matches, match, loaderData }) =>
    withLinks(
      pageHead(
        { matches, match },
        {
          translation: "zh-only",
          title: PAGE.metaTitle,
          description: fitDescription(PAGE.metaDescription),
          image: imageFor(HERO_KEY, ""),
          type: "article",
          jsonLd: landingEventLd({
            path: "/events/" + EVENT_SLUG,
            name: "小時光｜靈魂飯桌",
            description: fitDescription(PAGE.metaDescription).zh,
            imageKey: HERO_KEY,
            product: loaderData?.product ?? null,
            store: storeAddressFromMatches(matches),
            lang: langFromMatches(matches),
            performer: "周介偉、Alice",
          }),
        },
      ),
      [
        { rel: "stylesheet", href: FONTS_HREF },
        { rel: "stylesheet", href: soulCss },
      ],
    ),
  component: SoulDinner,
});

function SoulDinner() {
  useDocumentMeta({
    title: PAGE.metaTitle,
    description: fitDescription(PAGE.metaDescription),
    ogTitle: PAGE.metaTitle,
    ogDescription: fitDescription(PAGE.metaDescription),
    // ⚠️ 一定要帶：沒給 ogImage 時 useDocumentMeta 會移除 head() 放好的 og:image。
    ogImage: imageFor(HERO_KEY, ""),
  });

  // 頁內錨點（#reserve、#films）平滑捲動。只在這一頁開，離開時還原。
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.scrollBehavior;
    html.style.scrollBehavior = "smooth";
    return () => {
      html.style.scrollBehavior = prev;
    };
  }, []);

  const { product, now: loadedAt } = Route.useLoaderData();
  const now = useBookingNow(loadedAt, product?.sessions ?? []);
  const bookingClosed =
    product !== null && (eventEnded(null, product) || directBookingClosed(product, now));

  return (
    <div className="sd-root">
      <SoulHeader bookingClosed={bookingClosed} />
      <main>
        <Hero bookingClosed={bookingClosed} />
        <Section eyebrow="理念" title="在一張飯桌上，找到靈魂家人">
          <div className="grid gap-6 leading-8 sm:grid-cols-2">
            <p>
              有些相遇，從一頓好好的晚餐開始。我們邀請你放下手機與身份，和一群願意真誠交談的人，一起吃飯、一起看一部電影，再聊聊電影在心裡留下的光。
            </p>
            <p>
              我們相信，懂你的人會在交流中慢慢浮現——也許是靈魂家人，也許，是為靈魂伴侶留下的一點可能。
              <span className="mt-3 block text-sm text-muted-foreground">
                本活動不保證配對，也不是交友平台。
              </span>
            </p>
          </div>
        </Section>
        <Section eyebrow="飯票內容" title="一張飯票，三份心意">
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ["簡單輕食晚餐", "一起坐下，用一頓簡單的晚餐開場。"],
              ["電影賞析", "由兩位老師帶領，從電影走回自己的生命。"],
              ["交流", "在溫柔安全的氛圍裡，分享也傾聽。"],
            ].map(([title, text], i) => (
              <div key={title} className="paper-card p-5">
                <p className="sd-text-gold font-serif text-3xl">0{i + 1}</p>
                <h3 className="mt-2 text-lg text-primary">{title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">晚餐時間、菜色與實際觀影流程待公布。</p>
        </Section>
        <Section id="films" eyebrow="五場片單" title="五個週二，五張飯桌">
          <ol className="space-y-4">
            {FILMS.map((f) => (
              <li key={f.slug}>
                <Link
                  to="/events/soul-dinner/films/$film"
                  params={{ film: f.slug }}
                  className="paper-card group flex items-center gap-5 p-5 transition-transform hover:-translate-y-0.5"
                >
                  <span className="sd-text-gold font-serif text-4xl">{f.n}</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-lg text-primary">
                      {f.title}
                      {f.episode ? <span className="text-clay">｜{f.episode}</span> : null}
                    </h3>
                    <p className="text-xs text-muted-foreground">{f.date}・暫訂</p>
                    <p className="mt-1 text-sm text-foreground/75">{f.blurb}</p>
                  </div>
                  <span className="text-xs text-primary group-hover:underline">詳情 →</span>
                </Link>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted-foreground">所有日期皆為暫訂；地點待確認。</p>
        </Section>
        <Section eyebrow="共同主講" title="兩位老師，陪你看見">
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ["光中心", "周介偉老師"],
              ["共同主講", "Alice老師"],
            ].map(([role, name]) => (
              <div key={name} className="paper-card flex items-center gap-4 p-5">
                <div aria-hidden="true" className="sd-avatar h-14 w-14 shrink-0 rounded-full" />
                <div>
                  <p className="text-xs tracking-widest text-clay">{role}</p>
                  <h3 className="text-xl text-primary">{name}</h3>
                </div>
              </div>
            ))}
          </div>
        </Section>
        <Section eyebrow="票價" title="選一張適合你的飯票">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="paper-card p-6">
              <h3 className="text-lg text-primary">單場飯票</h3>
              <p className="mt-2 font-serif text-4xl text-primary">
                NT${TICKET_PRICE.toLocaleString("en-US")}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                含簡單輕食晚餐、電影賞析與交流。可選已公布的 4 場；第五場片名公布後開放報名。
              </p>
            </div>
          </div>
        </Section>
        <Section eyebrow="常見問題" title="出發前，你可能想知道">
          <FaqList />
        </Section>
        <Section id="reserve" eyebrow="預約報名" title="預約一張飯票">
          <div className="mx-auto max-w-xl">
            <Reserve now={now} bookingClosed={bookingClosed} />
          </div>
        </Section>
      </main>
      <SoulFooter />
    </div>
  );
}

function Hero({ bookingClosed }: { bookingClosed: boolean }) {
  return (
    <>
      <section className="relative overflow-hidden">
        <img
          src={heroTable}
          alt="水墨水彩繪製的窗邊餐桌與晚光"
          width={1536}
          height={1024}
          fetchPriority="high"
          className="h-[58vh] min-h-[360px] w-full object-cover sm:h-[70vh]"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background/10 via-background/30 to-background" />
        <div className="absolute inset-x-0 bottom-0 mx-auto max-w-5xl px-5 pb-6">
          <p className="text-xs tracking-[0.4em] text-clay">小時光｜靈魂飯桌</p>
          <h1 className="mt-3 text-[1.9rem] leading-[1.35] text-primary sm:text-5xl">
            給靈魂一張飯票，
            <br />
            也給相遇一個位置。
          </h1>
        </div>
      </section>
      <div className="mx-auto max-w-5xl px-5">
        <p className="mt-4 text-lg text-foreground/80">一起吃飯，看電影，遇見懂你的人。</p>
        <p className="mt-3 text-sm text-muted-foreground">
          {SCHEDULE}・五場・光中心 周介偉老師 × Alice老師 共同主講
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {bookingClosed ? null : (
            <a href="#reserve" className={`${BUTTON_CLAY} h-12 rounded-md px-8 text-sm`}>
              預約一張飯票
            </a>
          )}
          <a
            href="#films"
            className={`${BUTTON_BASE} h-12 rounded-full border border-input bg-background px-8 text-sm shadow-sm hover:bg-accent hover:text-accent-foreground`}
          >
            看五場片單
          </a>
        </div>
      </div>
    </>
  );
}

/** 稿上是 Radix Accordion（一次只開一題）。 */
function FaqList() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="paper-card px-5">
      {FAQ.map(({ q, a }, i) => {
        const isOpen = open === i;
        return (
          <div key={q} className={i === FAQ.length - 1 ? "border-b-0" : "border-b"}>
            <h3 className="flex">
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={`sd-faq-${i}`}
                onClick={() => setOpen(isOpen ? null : i)}
                className="flex flex-1 cursor-pointer items-center justify-between py-4 text-left text-sm font-medium transition-all hover:underline"
              >
                {q}
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
              </button>
            </h3>
            <div id={`sd-faq-${i}`} role="region" hidden={!isOpen} className="pb-4 text-sm">
              {a}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 稿上的預約表換成站上的場次／人數＋結帳。外框照稿（paper-card、max-w-xl）。
 */
function Reserve({ now, bookingClosed }: { now: number; bookingClosed: boolean }) {
  const { product, unavailable, now: loadedAt } = Route.useLoaderData();
  return (
    <div className="paper-card space-y-5 p-5 sm:p-7">
      {unavailable ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          報名資料暫時無法載入，請稍後再試。
        </p>
      ) : !product ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          報名尚未開放。開放之後會在這裡放上報名方式。
        </p>
      ) : (
        // 這一頁只有中文版：共用的場次／票種元件也固定顯示中文。
        <FixedLanguage lang="zh">
          <Booking product={product} loadedAt={loadedAt} now={now} bookingClosed={bookingClosed} />
        </FixedLanguage>
      )}
    </div>
  );
}

/** 某一場底下，第一個還能買的票種（＝單場飯票）。 */
function firstOpenPlanId(session: ShopSession | null, now: number): string | null {
  return session?.plans.find((p) => isPlanAvailable(p, now))?.id ?? null;
}

function Booking({
  product,
  loadedAt,
  now,
  bookingClosed,
}: {
  product: ShopProduct;
  /** loader 的 now：預選只在第一次 render 算，用它才與 SSR 一致。 */
  loadedAt: number;
  /** useBookingNow() 的值。 */
  now: number;
  /** 每一個場次都已開始或已結束（由頁面判斷，英雄區用同一個值）。 */
  bookingClosed: boolean;
}) {
  const [sessionId, setSessionId] = useState<string | null>(
    () => directSoleSession(product, loadedAt)?.id ?? null,
  );
  const [planId, setPlanId] = useState<string | null>(() =>
    firstOpenPlanId(directSoleSession(product, loadedAt), loadedAt),
  );
  const [qty, setQty] = useState(1);

  // 選中的場次一開始就不算選中，按鈕回到 <button disabled>。
  const selectedSession = directSelectedSession(product, sessionId, now);
  const needsPlan = selectedSession !== null && selectedSession.plans.length > 0;
  const selectedPlan = selectedSession?.plans.find((p) => p.id === planId) ?? null;
  const readyToBook = selectedSession !== null && (!needsPlan || selectedPlan !== null);
  const seatLimit = selectedSession ? directSeatLimit(product, selectedSession, selectedPlan) : 1;
  // 單價只拿來顯示預估總額；結帳頁會用目錄裡的價格重新算一次。
  const unitPrice = selectedPlan ? selectedPlan.price : product.price;

  if (bookingClosed) return <EventEndedNotice product={product} />;

  if (!directAnySeatsLeft(product, now)) {
    return (
      <>
        <SessionList
          sessions={product.sessions}
          showSeatsRemaining={product.showSeatsRemaining}
          basePrice={product.price}
          now={now}
        />
        <p className="text-sm leading-relaxed text-muted-foreground">已公布的場次都已額滿。</p>
      </>
    );
  }

  return (
    <>
      <div className="space-y-1.5">
        <p className="text-sm font-medium leading-none">場次</p>
        <SessionPicker
          sessions={product.sessions}
          showSeatsRemaining={product.showSeatsRemaining}
          basePrice={product.price}
          now={now}
          selectedId={sessionId}
          onSelect={(id) => {
            setSessionId(id);
            setPlanId(firstOpenPlanId(product.sessions.find((s) => s.id === id) ?? null, now));
            setQty(1);
          }}
        />
        <p className="text-xs text-muted-foreground">第五場片名尚未公布，片名確認後再開放報名。</p>
      </div>

      {selectedSession && needsPlan && selectedSession.plans.length > 1 ? (
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

      <div className="space-y-1.5">
        <p className="text-sm font-medium leading-none">人數</p>
        <QuantityStepper
          value={qty}
          max={seatLimit}
          onChange={(next) => setQty(Math.max(1, next))}
          label="人數"
          disabled={!readyToBook}
        />
      </div>

      <div className="flex items-baseline justify-between rounded-md bg-muted px-4 py-3">
        <span className="text-sm text-muted-foreground">預估總額</span>
        <span className="font-serif text-2xl text-primary" aria-live="polite">
          {readyToBook ? formatPrice(unitPrice * qty) : "—"}
        </span>
      </div>

      <p className="text-sm leading-6">
        下一步填寫姓名、電話與
        Email，並選擇付款方式。飲食需求（例如：素食、過敏食材）請寫在結帳頁的「備註」。
      </p>
      <p className="text-xs leading-6 text-muted-foreground">
        您的資料僅用於本活動的報名聯繫、場地與付款通知及餐點準備，不公開、不另作他用。
      </p>

      {readyToBook && selectedSession ? (
        <Link
          to="/checkout"
          search={directCheckoutSearch(product, selectedSession, qty, selectedPlan)}
          className={`${BUTTON_CLAY} h-12 w-full rounded-md px-8 text-sm`}
        >
          預約一張飯票
        </Link>
      ) : (
        // 🔴 不是 <Link>。沒選好場次的時候「去結帳」這條路在 DOM 裡不該存在。
        <button
          type="button"
          disabled
          className={`${BUTTON_CLAY} h-12 w-full rounded-md px-8 text-sm`}
        >
          預約一張飯票
        </button>
      )}
      <p className="text-xs leading-6 text-muted-foreground">
        付款方式於下一步選擇：信用卡線上付款或銀行匯款（匯款帳戶於結帳完成後提供，請於下單後 3
        天內完成，逾期名額將釋出）。
      </p>
    </>
  );
}
