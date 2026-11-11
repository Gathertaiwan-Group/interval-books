import { Link, useRouterState } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Clock, Instagram, ShoppingBag, UserRound, X } from "lucide-react";
import { useLang, useT, writeStoredLang } from "@/i18n/LanguageContext";
import { HTML_LANG, type Lang } from "@/i18n/types";
import { writeLangChoice } from "@/lib/lang-autodetect";
import { switchLangHref } from "@/lib/seo/i18n";
import { useCartCount, useCartHydrated } from "@/lib/cart";
import { useSiteContent } from "@/lib/site-content";
import { DAILY, dailyHours } from "@/lib/daily-hours";

// 手機抽屜專用的小字串（三語）。只在這個元件用，不進 CMS——也刻意不放進 ui.nav，
// nav-consolidation-selftest 釘住了頁首只准用的那幾個 nav key。
const MENU_TITLE = { zh: "選單", en: "Menu", ja: "メニュー" };
const MENU_OPEN = { zh: "開啟選單", en: "Open menu", ja: "メニューを開く" };
const MENU_CLOSE = { zh: "關閉選單", en: "Close menu", ja: "メニューを閉じる" };

/** lg 斷點（Tailwind 預設 1024px）：桌機導覽出現、手機抽屜要收起來。 */
const DESKTOP_MQ = "(min-width: 1024px)";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const t = useT();
  const { ui } = useSiteContent();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  /**
   * 四格。2026-09-02 從九格收束成五格，兩組合併：
   *
   *   /shop        ← 選購 ＋ 地方刊物展 ＋ 主理人的選品（同一頁三個分頁）
   *   /about       ← 關於 ＋ 來店資訊 ＋ 聯絡
   *
   * 被收掉的四個網址（/publications /curated /visit /contact）都還在，各自轉址到
   * 新家 —— 它們散在 Google 商家、名片與社群貼文上，刪掉就是 404。
   *
   * 標籤走 nav.select / nav.aboutStore 這兩個新 key，理由見 src/i18n/strings.ts。
   *
   * 2026-11-10 再從五格收成四格：「活動」「策旅」兩個列表頁合併成 /events「活動與策旅」
   * （?type=event|journey 篩選）。舊的 /journeys 301 到 /events?type=journey。標籤用新 key
   * nav.eventsJourneys —— 理由同上：ui_strings 若已有 ('nav','events') 那一列會蓋掉改寫的值。
   *
   * 2026-11-11 業主：加第五格「異業合作」（/partnership），放在「關於小時光」之後。沿用
   * 2026-10-26 就有的 nav.partnership（footer 早就在用，三語已備齊）。
   */
  const NAV = [
    { to: "/", label: t(ui.nav.home), exact: true },
    { to: "/shop", label: t(ui.nav.select), exact: false },
    { to: "/events", label: t(ui.nav.eventsJourneys), exact: false },
    { to: "/about", label: t(ui.nav.aboutStore), exact: false },
    { to: "/partnership", label: t(ui.nav.partnership), exact: false },
  ] as const;

  return (
    <>
      <header className="site-header-vt sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur-md">
        <div className="container-editorial flex items-center justify-between py-4 gap-6">
          <Link to="/" className="flex shrink-0 flex-col leading-tight">
            <span className="font-serif text-[1.35rem] tracking-tight">{t(ui.brand)}</span>
            <span className="eyebrow mt-1 text-[0.6875rem] tracking-[0.24em]">
              {t(ui.brandSub)}
            </span>
          </Link>

          {/* 五格之後 1024–1279 寬會擠（英文、日文換行、店名被壓）：只在 lg 這一段縮小字級／字距／
              間距與語言鈕寬度，xl（≥1280）以上維持原樣。連結一律不換行。 */}
          <nav className="hidden lg:flex items-center gap-4 xl:gap-7 text-[0.8125rem] xl:text-[0.875rem] tracking-[0.03em] xl:tracking-[0.06em] text-foreground/75">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                activeOptions={{ exact: n.exact }}
                activeProps={{ className: "text-foreground after:w-full" }}
                className="hover-underline whitespace-nowrap py-1 transition-colors hover:text-foreground"
              >
                {n.label}
              </Link>
            ))}

            <LangSegmented className="ml-1" />

            <AccountLink label={t(ui.nav.account)} />
            <CartLink label={t(ui.nav.cart)} />
          </nav>

          {/* 手機：只留購物車＋漢堡鈕（2026-11-11 業主：帳號 icon 多餘）。帳號的手機入口在
              抽屜裡的「我的帳號」。兩顆都 44px，中間 8px，店名那一側不被擠。 */}
          <div className="flex shrink-0 items-center gap-2 lg:hidden">
            <CartLink label={t(ui.nav.cart)} size="h-11 w-11" />
            <button
              ref={menuButtonRef}
              type="button"
              aria-label={t(MENU_OPEN)}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls="mobile-drawer"
              onClick={() => setOpen(true)}
              className="flex h-11 w-11 items-center justify-center text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            >
              <span className="flex flex-col gap-1.5" aria-hidden="true">
                <span className="block h-px w-6 bg-current" />
                <span className="block h-px w-6 bg-current" />
                <span className="block h-px w-6 bg-current" />
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* 抽屜放在 <header> 外面：header 有 backdrop-blur（backdrop-filter），會變成 fixed
          子元素的定位容器，抽屜放裡面只會蓋住頁首那一條。 */}
      <MobileDrawer open={open} onClose={close} returnFocusTo={menuButtonRef} nav={NAV} />
    </>
  );
}

/**
 * 手機選單：從右側滑出的抽屜（2026-11-10，取代「在頁首下方往下展開、把整頁推下去」）。
 *
 * 依據 W3C WAI-ARIA APG「Dialog (Modal)」：
 *   · role="dialog" aria-modal="true"，aria-labelledby 指向（視覺隱藏的）標題；
 *   · 開啟時焦點移到抽屜內的關閉鈕；Tab／Shift+Tab 在抽屜內循環；Esc 關閉；
 *   · 關閉後焦點回到漢堡鈕。
 * 其他行為：點遮罩關閉、開著時鎖住頁面捲動、換頁（路由變更）或轉到桌機寬度時自動關閉；
 * prefers-reduced-motion 時不做滑動動畫。
 *
 * 一直留在 DOM 裡（SSR 也輸出、關著時 invisible）：滑入／滑出才有轉場可做，
 * 而 visibility:hidden 會把它整個移出 Tab 順序與無障礙樹。
 */
function MobileDrawer({
  open,
  onClose,
  returnFocusTo,
  nav,
}: {
  open: boolean;
  onClose: () => void;
  returnFocusTo: RefObject<HTMLButtonElement | null>;
  nav: ReadonlyArray<{ to: string; label: string; exact: boolean }>;
}) {
  const t = useT();
  const { ui, site, social } = useSiteContent();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const hydrated = useCartHydrated();
  const storedCount = useCartCount();
  const cartCount = hydrated ? storedCount : 0;

  // 路由變更 → 關閉（點連結本來就會關；這裡兜住瀏覽器上一頁／下一頁）。
  const locationKey = useRouterState({ select: (s) => s.location.href });
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationKey]);

  // 轉到桌機寬度 → 關閉（桌機導覽接手，抽屜不該還鎖著捲動）。
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia(DESKTOP_MQ);
    const onChange = () => mq.matches && onClose();
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [open, onClose]);

  // 開：鎖捲動、焦點進抽屜、Esc 關閉。關：焦點回到漢堡鈕。
  useEffect(() => {
    if (!open) {
      if (wasOpen.current) {
        wasOpen.current = false;
        returnFocusTo.current?.focus({ preventScroll: true });
      }
      return;
    }
    wasOpen.current = true;
    const html = document.documentElement;
    const prevHtml = html.style.overflow;
    const prevBody = document.body.style.overflow;
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panelRef.current.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      html.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
    };
  }, [open, onClose, returnFocusTo]);

  const hours = dailyHours(t(site.hours), t(DAILY));
  const secondaryLink =
    "flex min-h-12 items-center gap-3 text-[0.95rem] text-foreground/80 transition-colors hover:text-foreground";

  return (
    <div className="lg:hidden">
      {/* 遮罩：點一下關閉。不進 Tab 順序（抽屜裡已有關閉鈕）。 */}
      <div
        aria-hidden="true"
        onClick={onClose}
        data-testid="drawer-overlay"
        className={`fixed inset-0 z-50 bg-[oklch(0.245_0.018_60)]/35 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        ref={panelRef}
        id="mobile-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`fixed inset-y-0 right-0 z-50 flex w-[84vw] max-w-[360px] flex-col overflow-y-auto overscroll-contain border-l border-border/70 bg-background shadow-[-12px_0_32px_-16px_oklch(0.245_0.018_60/0.35)] motion-reduce:transition-none ${
          open
            ? "visible translate-x-0 [transition:transform_240ms_var(--ease-quiet),visibility_0s]"
            : "invisible translate-x-full [transition:transform_220ms_var(--ease-quiet),visibility_0s_linear_220ms]"
        }`}
      >
        <div className="flex items-center justify-between border-b border-border/60 py-3 pl-6 pr-3">
          <h2 id={titleId} className="eyebrow">
            {t(MENU_TITLE)}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t(MENU_CLOSE)}
            className="flex h-12 w-12 items-center justify-center text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-foreground"
          >
            <X className="h-6 w-6" strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>

        {/* 主導覽：大字、每格 ≥56px，目前頁面左側一條細線＋字重。 */}
        <nav aria-label={t(MENU_TITLE)} className="px-6 pt-4">
          <ul>
            {nav.map((n) => (
              <li key={n.to} className="border-b border-border/50">
                <Link
                  to={n.to}
                  onClick={onClose}
                  activeOptions={{ exact: n.exact }}
                  activeProps={{ className: "text-foreground font-medium before:bg-foreground" }}
                  inactiveProps={{ className: "text-foreground/75 before:bg-transparent" }}
                  className="relative -ml-6 flex min-h-14 items-center pl-6 font-serif text-[1.375rem] tracking-tight transition-colors before:absolute before:inset-y-4 before:left-3 before:w-[2px] before:content-[''] hover:text-foreground"
                >
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* 次要：購物車（件數）、我的帳號。 */}
        <div className="flex flex-col px-6 pt-5">
          <Link to="/cart" onClick={onClose} className={secondaryLink}>
            <ShoppingBag className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
            <span>{t(ui.nav.cart)}</span>
            {cartCount > 0 && (
              <span className="ml-auto min-w-6 rounded-full bg-foreground px-2 text-center text-xs leading-6 text-primary-foreground tabular-nums">
                {cartCount}
              </span>
            )}
          </Link>
          <Link to="/account" onClick={onClose} className={secondaryLink}>
            <UserRound className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
            <span>{t(ui.nav.account)}</span>
          </Link>
        </div>

        {/* 底部：營業時間、社群、語言。 */}
        <div className="mt-auto border-t border-border/60 px-6 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <p className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <Clock className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span>{hours}</span>
          </p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <LangText />
            <div className="flex items-center">
              {social.instagram && (
                <a
                  href={social.instagram}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Instagram"
                  title="Instagram"
                  className="flex h-11 w-11 items-center justify-center text-foreground/70 transition-colors hover:text-foreground"
                >
                  <Instagram
                    className="h-[1.1rem] w-[1.1rem]"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                </a>
              )}
              {social.line && (
                <a
                  href={social.line}
                  target="_blank"
                  rel="noreferrer"
                  title="LINE"
                  className="flex h-11 min-w-11 items-center justify-center text-xs font-medium tracking-wide text-foreground/75 transition-colors hover:text-foreground"
                >
                  LINE
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Cart icon with a unit-count badge.
 *
 * The count is gated on useCartHydrated(): the cart lives in localStorage, so
 * the server has no idea what is in it. Rendering the real number on the first
 * client pass would disagree with the SSR HTML and trip a hydration mismatch —
 * hence "0 until the effect has read storage", which is the same discipline
 * every cart-reading component in Realreal follows.
 */
function CartLink({
  label,
  size = "ml-2 h-10 w-10",
}: {
  label: string;
  /** 桌機沿用原本的 40px＋左距；手機頁首傳 44px（點擊區 ≥44px）。 */
  size?: string;
}) {
  const hydrated = useCartHydrated();
  const storedCount = useCartCount();
  const count = hydrated ? storedCount : 0;

  return (
    <Link
      to="/cart"
      aria-label={count > 0 ? `${label} (${count})` : label}
      className={`relative flex ${size} items-center justify-center text-foreground/80 transition-colors hover:text-foreground`}
    >
      <ShoppingBag className="h-5 w-5" aria-hidden="true" />
      {count > 0 && (
        <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-foreground px-1 text-center text-[0.6875rem] leading-4 text-primary-foreground tabular-nums">
          {count}
        </span>
      )}
    </Link>
  );
}

/**
 * 客人帳號的入口（2026-09-03）。刻意用圖示、不佔用文字導覽的五格——見上面 NAV
 * 那段「九格 → 五格」的理由，同一個空間預算。
 *
 * 一律指到 /account，不在頁首自己判斷有沒有登入：那一頁自己的 beforeLoad 會導去
 * /account/login（見 routes/account.tsx 檔頭）。這裡不重複判斷一次，避免登入
 * 狀態的判斷分散在兩個地方。
 */
function AccountLink({ label }: { label: string }) {
  return (
    <Link
      to="/account"
      aria-label={label}
      title={label}
      className="flex h-10 w-10 items-center justify-center text-foreground/80 transition-colors hover:text-foreground"
    >
      <UserRound className="h-5 w-5" aria-hidden="true" />
    </Link>
  );
}

/**
 * 語言切換：分段按鈕「中｜EN｜日」（2026-11 業主：「換成按鈕狀、簡潔」）。
 *
 *   · 細線外框、三格等寬、目前語言實心（深咖啡底＋米白字），配合首頁改版的頁首。
 *   · 每格高 40px、寬 44px（1024–1279 寬為 36px，五格導覽擠；點擊範圍 ≥ 36px）；鍵盤 Tab 進得來，focus-visible 有外框。
 *   · 公開頁：連到**同一頁的另一個語言網址**的 <a href>（整頁載入；搜尋引擎也看得到這三個
 *     連結，hreflang／lang 屬性照舊），按下時記住選擇——
 *       writeStoredLang：之後的購物車、結帳介面跟著換；
 *       writeLangChoice：手動選過 → 以後永遠不再依瀏覽器語系自動導（src/lib/lang-autodetect.ts）。
 *   · 私密頁（購物車、結帳、會員…；沒有 /en 網址）：同樣外觀的 <button>，只換介面語言。
 */
const LANG_SEGMENTS: { code: Lang; label: string; name: string }[] = [
  { code: "zh", label: "中", name: "中文" },
  { code: "en", label: "EN", name: "English" },
  { code: "ja", label: "日", name: "日本語" },
];

const GROUP_LABEL: Record<Lang, string> = { zh: "語言", en: "Language", ja: "言語" };

function LangSegmented({ className = "" }: { className?: string }) {
  const { lang } = useLang();
  return (
    <div
      role="group"
      aria-label={GROUP_LABEL[lang]}
      className={`inline-flex shrink-0 divide-x divide-foreground/25 border border-foreground/35 ${className}`}
    >
      {LANG_SEGMENTS.map((seg) => (
        <LangSwitch key={seg.code} code={seg.code} name={seg.name}>
          {seg.label}
        </LangSwitch>
      ))}
    </div>
  );
}

/**
 * 手機抽屜底部的語言列：「中・EN・日」一排小字（2026-11-10）。選單的主角是導覽，
 * 語言是偶爾才用的設定，不該在最上面佔一排粗框按鈕。點擊範圍仍是 40×44px。
 */
function LangText() {
  const { lang } = useLang();
  return (
    <div
      role="group"
      aria-label={GROUP_LABEL[lang]}
      className="flex items-center text-foreground/40"
    >
      {LANG_SEGMENTS.map((seg, i) => (
        <span key={seg.code} className="flex items-center">
          {i > 0 && <span aria-hidden="true">・</span>}
          <LangSwitch code={seg.code} name={seg.name} variant="text">
            {seg.label}
          </LangSwitch>
        </span>
      ))}
    </div>
  );
}

const SEGMENT_BASE =
  "relative inline-flex h-10 w-9 xl:w-11 items-center justify-center text-xs leading-none tracking-[0.08em] transition-colors focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";
const SEGMENT_ON = "bg-foreground text-primary-foreground";
const SEGMENT_OFF = "text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground";
const TEXT_BASE =
  "inline-flex h-10 min-w-10 items-center justify-center px-1 text-sm tracking-[0.06em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground";
const TEXT_ON = "text-foreground font-medium underline underline-offset-4 decoration-1";
const TEXT_OFF = "text-foreground/75 hover:text-foreground";

function LangSwitch({
  code,
  name,
  children,
  variant = "segment",
}: {
  code: Lang;
  name: string;
  children: ReactNode;
  variant?: "segment" | "text";
}) {
  const { lang, urlLang, setLang } = useLang();
  const publicHref = useRouterState({ select: (s) => s.location.publicHref });
  const current = lang === code;
  const className =
    variant === "text"
      ? `${TEXT_BASE} ${current ? TEXT_ON : TEXT_OFF}`
      : `${SEGMENT_BASE} ${current ? SEGMENT_ON : SEGMENT_OFF}`;
  if (urlLang !== null) {
    return (
      <a
        // hash 不帶：SSR 拿不到 hash，帶了會讓 SSR 與瀏覽器的 href 不一致。
        href={switchLangHref((publicHref ?? "/").split("#")[0], code)}
        hrefLang={HTML_LANG[code]}
        lang={HTML_LANG[code]}
        title={name}
        aria-label={name}
        onClick={() => {
          writeStoredLang(code);
          writeLangChoice(code);
        }}
        className={className}
        aria-current={current ? "true" : undefined}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      lang={HTML_LANG[code]}
      title={name}
      aria-label={name}
      onClick={() => {
        setLang(code);
        writeLangChoice(code);
      }}
      className={className}
      aria-pressed={current}
    >
      {children}
    </button>
  );
}
