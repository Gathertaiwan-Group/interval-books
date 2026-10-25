import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { LanguageProvider, useT } from "@/i18n/LanguageContext";
import { fetchSiteContent, FALLBACK_SITE_CONTENT } from "@/lib/cms";
import { isBackOfficePath } from "@/lib/admin/back-office-path";
import { SiteContentProvider, useSiteContent } from "@/lib/site-content";
import { ReferralCapture } from "@/components/ReferralCapture";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <LanguageProvider>
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
        <h2 className="display mt-4 text-4xl">{t(ui.notFound.title)}</h2>
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
    const backOffice = isBackOfficePath(location.pathname);
    if (typeof window !== "undefined") rootDataIsBackOfficeFallback = backOffice;
    return { site: backOffice ? FALLBACK_SITE_CONTENT : await fetchSiteContent() };
  },
  shouldReload: ({ location }) =>
    typeof window !== "undefined" &&
    rootDataIsBackOfficeFallback &&
    !isBackOfficePath(location.pathname)
      ? true
      : undefined,
  head: ({ loaderData }) => {
    const site = loaderData?.site ?? FALLBACK_SITE_CONTENT;
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: site.meta.defaultTitle },
        { name: "description", content: site.meta.defaultDescription },
        { name: "author", content: site.meta.author },
        { property: "og:type", content: site.meta.ogType },
        { property: "og:site_name", content: site.meta.siteName },
        { name: "twitter:card", content: site.meta.twitterCard },
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=Inter:wght@300;400;500&family=Noto+Sans+TC:wght@300;400;500&family=Noto+Sans+JP:wght@300;400;500&family=Noto+Serif+TC:wght@300;400;500&display=swap",
        },
        { rel: "icon", type: "image/png", href: "/logo.png" },
        { rel: "apple-touch-icon", href: "/logo.png" },
      ],
    };
  },
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
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
  return (
    <SiteContentProvider value={site}>
      <LanguageProvider>
        <ReferralCapture />
        <Outlet />
      </LanguageProvider>
    </SiteContentProvider>
  );
}
