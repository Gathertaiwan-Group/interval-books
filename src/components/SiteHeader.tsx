import { Link, useRouterState } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ShoppingBag, UserRound } from "lucide-react";
import { useLang, useT, writeStoredLang } from "@/i18n/LanguageContext";
import { HTML_LANG, type Lang } from "@/i18n/types";
import { writeLangChoice } from "@/lib/lang-autodetect";
import { switchLangHref } from "@/lib/seo/i18n";
import { useCartCount, useCartHydrated } from "@/lib/cart";
import { useSiteContent } from "@/lib/site-content";

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const t = useT();
  const { lang } = useLang();
  const { ui } = useSiteContent();

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
   */
  const NAV = [
    { to: "/", label: t(ui.nav.home), exact: true },
    { to: "/shop", label: t(ui.nav.select), exact: false },
    { to: "/events", label: t(ui.nav.eventsJourneys), exact: false },
    { to: "/about", label: t(ui.nav.aboutStore), exact: false },
  ] as const;

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur-md">
      <div className="container-editorial flex items-center justify-between py-4 gap-6">
        <Link to="/" className="flex flex-col leading-tight" onClick={() => setOpen(false)}>
          <span className="font-serif text-[1.35rem] tracking-tight">{t(ui.brand)}</span>
          <span className="eyebrow mt-1 text-[0.6rem]">{t(ui.brandSub)}</span>
        </Link>

        <nav className="hidden lg:flex items-center gap-7 text-[0.875rem] tracking-[0.06em] text-foreground/75">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.exact }}
              activeProps={{ className: "text-foreground after:w-full" }}
              className="hover-underline py-1 transition-colors hover:text-foreground"
            >
              {n.label}
            </Link>
          ))}

          <LangSegmented className="ml-1" />

          <AccountLink label={t(ui.nav.account)} />
          <CartLink label={t(ui.nav.cart)} />
        </nav>

        <div className="flex items-center gap-1 lg:hidden">
          <AccountLink label={t(ui.nav.account)} onNavigate={() => setOpen(false)} />
          <CartLink label={t(ui.nav.cart)} onNavigate={() => setOpen(false)} />
          <button
            aria-label="Menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex h-10 w-10 items-center justify-center text-foreground"
          >
            <span className="flex flex-col gap-1.5">
              <span className="block h-px w-6 bg-current" />
              <span className="block h-px w-6 bg-current" />
              <span className="block h-px w-6 bg-current" />
            </span>
          </button>
        </div>
      </div>

      {open && (
        <div className="lg:hidden border-t border-border/60 bg-background">
          {/* 手機：語言切換放在選單最上面（頁首放不下：店名＋帳號＋購物車＋選單鈕已經佔滿 390px）。 */}
          <div className="container-editorial border-b border-border/40 pt-5 pb-4">
            <LangSegmented />
          </div>
          <nav className="container-editorial flex flex-col py-6 gap-4 text-base">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                onClick={() => setOpen(false)}
                activeOptions={{ exact: n.exact }}
                activeProps={{ className: "text-foreground font-medium" }}
                className="text-foreground/75"
              >
                {n.label}
              </Link>
            ))}
            <Link
              to="/cart"
              onClick={() => setOpen(false)}
              activeProps={{ className: "text-foreground font-medium" }}
              className="text-foreground/75"
            >
              {t(ui.nav.cart)}
            </Link>
            <Link
              to="/account"
              onClick={() => setOpen(false)}
              activeProps={{ className: "text-foreground font-medium" }}
              className="text-foreground/75"
            >
              {t(ui.nav.account)}
            </Link>
          </nav>
        </div>
      )}
    </header>
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
function CartLink({ label, onNavigate }: { label: string; onNavigate?: () => void }) {
  const hydrated = useCartHydrated();
  const storedCount = useCartCount();
  const count = hydrated ? storedCount : 0;

  return (
    <Link
      to="/cart"
      onClick={onNavigate}
      aria-label={count > 0 ? `${label} (${count})` : label}
      className="relative ml-2 flex h-10 w-10 items-center justify-center text-foreground/80 transition-colors hover:text-foreground"
    >
      <ShoppingBag className="h-5 w-5" aria-hidden="true" />
      {count > 0 && (
        <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-foreground px-1 text-center text-[0.6rem] leading-4 text-primary-foreground tabular-nums">
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
function AccountLink({ label, onNavigate }: { label: string; onNavigate?: () => void }) {
  return (
    <Link
      to="/account"
      onClick={onNavigate}
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
 *   · 每格高 40px、寬 44px（點擊範圍 ≥ 40px）；鍵盤 Tab 進得來，focus-visible 有外框。
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

const SEGMENT_BASE =
  "relative inline-flex h-10 w-11 items-center justify-center text-[0.75rem] leading-none tracking-[0.08em] transition-colors focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground";
const SEGMENT_ON = "bg-foreground text-primary-foreground";
const SEGMENT_OFF = "text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground";

function LangSwitch({ code, name, children }: { code: Lang; name: string; children: ReactNode }) {
  const { lang, urlLang, setLang } = useLang();
  const publicHref = useRouterState({ select: (s) => s.location.publicHref });
  const current = lang === code;
  const className = `${SEGMENT_BASE} ${current ? SEGMENT_ON : SEGMENT_OFF}`;
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
