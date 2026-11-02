/**
 * GA4 與 Search Console 驗證（2026-11，業主提供的 ID）。
 *
 * ── GA4 評估 ID ───────────────────────────────────────────────────────────
 * 環境變數 VITE_GA4_MEASUREMENT_ID 為主，程式內常數當保底（與 gather 的做法相同）：
 * Vercel 的 env 有時在 build 時讀到空值，只靠 env 的話整站會靜默地沒有統計。
 * env 有值但格式不是 G-XXXX 也一樣退回保底，不把奇怪的字串塞進 script 網址。
 *
 * ── 範圍 ──────────────────────────────────────────────────────────────────
 * 前台頁面才載（含結帳頁）；後台 /admin/*、廠商入口 /vendor/* 不載、也不送 page_view。
 *
 * ── page_view ─────────────────────────────────────────────────────────────
 * 這是 SPA：config 時關掉自動 send_page_view，由 __root.tsx 的 <GaPageViews /> 在每次
 * 路由完成（含第一頁）時手動送一次——不關的話第一頁會被算兩次。
 */
import { isAutoRedirecting } from "@/lib/lang-autodetect";
const FALLBACK_GA4_ID = "G-34972QC1RW";

function resolveGa4Id(): string {
  const fromEnv = String(import.meta.env.VITE_GA4_MEASUREMENT_ID ?? "").trim();
  return /^G-[A-Z0-9]{4,}$/.test(fromEnv) ? fromEnv : FALLBACK_GA4_ID;
}

export const GA4_ID = resolveGa4Id();

/** Search Console 的 HTML 標記驗證（google-site-verification）。 */
export const GOOGLE_SITE_VERIFICATION = "ycX_QzdBy7UXIJv2CR8tLcnIayB_5mPp98DuxLjI89M";

/** 這條路徑要不要載 GA（後台、廠商入口不載）。 */
export function analyticsEnabledFor(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return !(
    p === "/admin" ||
    p.startsWith("/admin/") ||
    p === "/vendor" ||
    p.startsWith("/vendor/")
  );
}

/** head().scripts：gtag.js 本體與初始化（send_page_view 關掉，見檔頭）。 */
export function ga4HeadScripts(): Array<{ src?: string; async?: boolean; children?: string }> {
  return [
    { src: `https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`, async: true },
    {
      children: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config','${GA4_ID}',{send_page_view:false});`,
    },
  ];
}

type Gtag = (...args: unknown[]) => void;

/** 送一次 page_view。gtag 還沒載入（被擋、離線）就什麼都不做。 */
export function sendPageView(): void {
  if (typeof window === "undefined") return;
  if (!analyticsEnabledFor(window.location.pathname)) return;
  // 依瀏覽器語系自動導走的那一頁不算一次瀏覽（導到的那一頁會再送）。
  if (isAutoRedirecting()) return;
  const gtag = (window as unknown as { gtag?: Gtag }).gtag;
  if (typeof gtag !== "function") return;
  gtag("event", "page_view", {
    page_location: window.location.href,
    page_path: window.location.pathname + window.location.search,
    page_title: document.title,
  });
}
