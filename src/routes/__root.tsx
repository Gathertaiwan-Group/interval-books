import { ChatLauncher } from "@/components/chat/ChatLauncher";
import { useEffect } from "react";
import {
  Outlet,
  Link,
  createRootRoute,
  HeadContent,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { LanguageProvider, useT } from "@/i18n/LanguageContext";
import { HTML_LANG } from "@/i18n/types";
import { LanguageHint } from "@/components/LanguageHint";
import { OG_LOCALE, publicLangOf } from "@/lib/seo/i18n";
import { fetchSiteContent, FALLBACK_SITE_CONTENT } from "@/lib/cms";
import { isBackOfficePath } from "@/lib/admin/back-office-path";
import { SiteContentProvider, useSiteContent } from "@/lib/site-content";
import { ReferralCapture } from "@/components/ReferralCapture";
import { absoluteUrl, isNoindexPath, siteGraphLd } from "@/lib/seo/core";
import { ld } from "@/lib/seo/head";
import { LANG_AUTODETECT_SCRIPT } from "@/lib/lang-autodetect";
import {
  analyticsEnabledFor,
  ga4HeadScripts,
  GOOGLE_SITE_VERIFICATION,
  sendPageView,
} from "@/lib/analytics";
import heroImg from "@/assets/hero-mountain.jpg";
import storefrontImg from "@/assets/storefront.jpg";

import appCss from "../styles.css?url";

/**
 * 目前網址的語言（公開頁）／null（私密頁）。看的是**給人看的網址**（publicHref，含 /en、/ja
 * 前綴），不是路由表的網址（/en/events 在路由表裡是 /events，見 src/lib/i18n-rewrite.ts）。
 */
function useUrlLang() {
  const publicHref = useRouterState({ select: (s) => s.location.publicHref });
  return publicLangOf((publicHref ?? "/").split(/[?#]/)[0]);
}

function NotFoundComponent() {
  const urlLang = useUrlLang();
  return (
    <LanguageProvider urlLang={urlLang}>
      <NotFoundInner />
    </LanguageProvider>
  );
}

function NotFoundInner() {
  const t = useT();
  const { ui } = useSiteContent();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <p className="eyebrow text-2xl">404</p>
        {/* h1（2026-11 SEO 健檢 L3）：class 不變，樣子與原本的 h2 一樣（h1–h5 共用同一組 base 樣式）。 */}
        <h1 className="display mt-4 text-4xl">{t(ui.notFound.title)}</h1>
        <div className="mt-8">
          <Link
            to="/"
            className="inline-flex items-center justify-center border border-foreground px-6 py-3 text-sm tracking-wide hover:bg-foreground hover:text-primary-foreground transition-colors"
          >
            {t(ui.buttons.backHome)}
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * 瀏覽器端：root loader 手上的資料是不是「後台用的預設文案」。第一次是 SSR 給的（loader 沒有在
 * 瀏覽器跑過），所以用載入時的網址判斷；之後每次 root loader 在瀏覽器跑都會更新。
 */
let rootDataIsBackOfficeFallback =
  typeof window !== "undefined" && isBackOfficePath(window.location.pathname);

/** 瀏覽器端：root loader 手上的 lang（第一次是 SSR 依載入網址算的，公式同 loader）。 */
let rootDataLang =
  typeof window !== "undefined" ? (publicLangOf(window.location.pathname) ?? "zh") : null;

/**
 * 換到一個語言跟 root loader 手上不同的公開頁 → root 要重跑，各頁 head() 才拿得到對的語言。
 * 平常不會發生（同一個 document 裡語言不變）；只有「直接載入私密頁（/cart）→ 介面跟著記住的
 * 英文 → 點頁首連到 /en/events」這條路會走到。
 */
function rootLangIsStale(publicHref: string | undefined): boolean {
  if (typeof window === "undefined" || !publicHref) return false;
  const lang = publicLangOf(publicHref.split(/[?#]/)[0]);
  return lang !== null && lang !== rootDataLang;
}

export const Route = createRootRoute({
  // Runs on the server for the initial request (and on the client for
  // subsequent navigations), so the shell copy is present in the SSR HTML.
  //
  // 後台（/admin 底下）一個字都不用前台的站台文案（site_settings／ui_strings／
  // contact_phones），所以不查那三張表——否則後台每一次整頁載入都多三個查詢。
  // 後台頁面的 <title> 各自有寫；萬一有哪裡用到 useSiteContent()，拿到的是程式內建的預設值。
  //
  // root 的 match 在整個 SPA 期間不會自己重跑（換頁都是 cause "stay"）。所以從後台用 client 端
  // 換頁到前台（404 頁的「回首頁」、上一頁／下一頁）時要強制重跑一次，前台才不會一直掛著預設文案。
  loader: async ({ location }) => {
    // lang：這一頁（document）的語言，給各頁 head() 用（src/lib/seo/head.ts 的 langFromMatches）。
    // 同一個 document 裡語言不會變（語言切換是整頁載入），所以 root loader 不需要每次換頁重跑。
    // 私密頁 → 中文（它們 noindex，head 用哪一種語言不影響收錄）。
    const lang = publicLangOf((location.publicHref ?? location.pathname).split(/[?#]/)[0]) ?? "zh";
    const backOffice = isBackOfficePath(location.pathname);
    if (typeof window !== "undefined") rootDataIsBackOfficeFallback = backOffice;
    if (typeof window !== "undefined") rootDataLang = lang;
    return { site: backOffice ? FALLBACK_SITE_CONTENT : await fetchSiteContent(), lang };
  },
  shouldReload: ({ location }) =>
    typeof window !== "undefined" &&
    rootDataIsBackOfficeFallback &&
    !isBackOfficePath(location.pathname)
      ? true
      : rootLangIsStale(location.publicHref)
        ? true
        : undefined,
  head: ({ loaderData, matches }) => {
    const site = loaderData?.site ?? FALLBACK_SITE_CONTENT;
    // ── 全站 SEO（2026-11 SEO 健檢 H3／H4／L3／L5／M3）──────────────────────────
    // root 的 head() 每次換頁都會跟著重跑（router-core 的 projectLane 對整條 match 鏈
    // 逐一呼叫 head），所以這裡從「最深的那一個 match」拿得到目前頁面的路徑與 search。
    // 子路由的 meta 同名時子路由贏（HeadContent 由深到淺去重），所以這裡放的是預設值。
    //
    // canonical／og:url／hreflang／og:locale 由各頁的 pageMeta()／pageLinks() 輸出（2026-11
    // /en /ja：要知道這一頁各語言有沒有翻譯，只有那一頁自己知道，見 src/lib/seo/head.ts）。
    const leaf = matches[matches.length - 1];
    const pathname = leaf?.pathname ?? "/";
    const lang = loaderData?.lang ?? "zh";
    const isNotFound = matches.some((m) => m.status === "notFound" || m._notFound);
    const noindex = isNotFound || isNoindexPath(pathname);
    const backOffice = isBackOfficePath(pathname) || pathname.startsWith("/vendor");
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        {
          title: isNotFound ? `找不到頁面｜${site.meta.siteName}` : site.meta.defaultTitle,
        },
        { name: "description", content: site.meta.defaultDescription },
        { name: "author", content: site.meta.author },
        { property: "og:type", content: site.meta.ogType },
        { property: "og:site_name", content: site.meta.siteName },
        { property: "og:locale", content: OG_LOCALE[lang] },
        { name: "twitter:card", content: site.meta.twitterCard },
        // Search Console 的 HTML 標記驗證：全站 SSR 輸出（首頁一定要有）。
        { name: "google-site-verification", content: GOOGLE_SITE_VERIFICATION },
        // 預設分享圖：子路由沒給自己的 og:image 時用這張（絕對網址）。
        ...(backOffice
          ? []
          : [
              { property: "og:image", content: absoluteUrl(heroImg) },
              { name: "twitter:image", content: absoluteUrl(heroImg) },
            ]),
        ...(noindex ? [{ name: "robots", content: "noindex, nofollow" }] : []),
        // Organization／WebSite／BookStore：資料全部來自後台的 site_settings（頁尾與 /about
        // 印的同一份），後台頁面與 404 不輸出。
        ...(backOffice || isNotFound ? [] : [ld(siteGraphLd(site, storefrontImg, "/logo.png"))]),
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
        // Google Fonts（2026-11 字型載入優化）：
        // - 四個字族都是可變字型，Google 對 300／400／500 三個字重給的是「同一批」woff2。用
        //   wght@300..500 範圍寫法，CSS 每個 unicode-range 分片只宣告一次（不是每個字重各一次），
        //   這支會擋渲染的 CSS 從 ~290KB(gzip) 降到 ~70KB；字型檔與畫面完全不變（逐像素比對過）。
        // - 拿掉 Noto Sans JP：站上沒有任何 font-family 用到它（日文版的假名也是 Noto Sans TC 畫的），
        //   之前只是白白多出 ~90KB 的 @font-face 宣告。
        // - 不 preload 任何 woff2：gstatic 的檔名帶版本會變，中文又切成上百個分片。
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300..500&family=Inter:wght@300..500&family=Noto+Sans+TC:wght@300..500&family=Noto+Serif+TC:wght@300..500&display=swap",
        },
        { rel: "icon", type: "image/png", href: "/logo.png" },
        { rel: "apple-touch-icon", href: "/logo.png" },
      ],
      scripts: [
        // 依瀏覽器語系自動導向（2026-11）：瀏覽器端、排除爬蟲、只導一次、手動優先，
        // 見 src/lib/lang-autodetect.ts。HeadContent 把 head scripts 排在所有 <link>（含各頁的
        // hreflang）之後，script 才讀得到這一頁有哪些語言版本。
        // 每一頁都輸出、內容固定（SSR 與 hydration 一致）。TanStack 換頁時會把它移掉再插一份
        // 並執行——script 自己用 readyState／window 旗標擋掉，每個 document 只判斷一次。
        { children: LANG_AUTODETECT_SCRIPT },
        // GA4：前台才載（後台、廠商入口不載），見 src/lib/analytics.ts。
        ...(analyticsEnabledFor(pathname) ? ga4HeadScripts() : []),
      ],
    };
  },
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  // 公開頁依網址（/en → en、/ja → ja）；私密頁先輸出中文，掛載後由 LanguageProvider 換成記住的語言。
  const urlLang = useUrlLang();
  return (
    <html lang={HTML_LANG[urlLang ?? "zh"]}>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        {/* sonner was a dependency but was never mounted, so toast() calls
            silently did nothing. The /admin forms rely on it for save feedback. */}
        <Toaster position="top-center" richColors closeButton />
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { site } = Route.useLoaderData();
  const urlLang = useUrlLang();
  return (
    <SiteContentProvider value={site}>
      <LanguageProvider urlLang={urlLang}>
        <ReferralCapture />
        <GaPageViews />
        <LanguageHint />
        <Outlet />
        <ChatLauncher />
      </LanguageProvider>
    </SiteContentProvider>
  );
}

/**
 * GA4 的 page_view：每次路由**完成**（resolvedLocation 換了，含第一頁 hydrate）送一次。
 * gtag 的 config 關掉了自動 send_page_view（見 src/lib/analytics.ts），所以第一頁不會重複。
 * 延到下一個 tick 送，讓各頁 useDocumentMeta 的 effect 先把 document.title 換好。
 */
function GaPageViews() {
  const href = useRouterState({ select: (s) => s.resolvedLocation?.href });
  useEffect(() => {
    if (!href) return;
    const timer = window.setTimeout(sendPageView, 0);
    return () => window.clearTimeout(timer);
  }, [href]);
  return null;
}
