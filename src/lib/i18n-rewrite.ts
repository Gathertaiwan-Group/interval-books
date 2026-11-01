/**
 * /en、/ja 網址前綴 ↔ 路由表的對應（TanStack Router 的 location rewrite，2026-11）。
 *
 * 路由檔一個都沒搬：路由表裡只有中文網址（/events、/shop/$slug…）。
 *   · input：瀏覽器／請求的網址 → 路由表的網址。/en/events → /events，並記下「這個 router
 *     現在是英文」。私密頁（/en/admin）不剝 → 對不到路由 → 404。
 *   · output：路由表的網址 → 給人看的網址。<Link to="/events"> 在英文頁產生 /en/events；
 *     loader 裡的 redirect({ to: "/" })（/news 301、活動代稱大小寫 301）同樣帶回 /en。
 *     私密頁（/checkout、/cart…）永遠不加前綴。
 *
 * 語言狀態存在**這個 router 實例**裡（server 每個請求都 new 一個 router，不共用）。同一個頁面
 * （document）裡語言不會變：語言切換鈕是 <a href> 整頁載入，站內連結都經過 output 帶著同一個
 * 前綴。從私密頁（/cart）回到公開頁，沿用最後一次公開頁的語言。
 *
 * 🔴 坑：一開 rewrite，router-core 的 parseLocation 就把 publicHref 設成**原始** href（query
 *    沒有正規化），而 SSR（load-server.js 的 loadServerRoute）與瀏覽器（Transitioner）都會拿它
 *    跟「重新組出來的標準網址」比，不同就 307／replaceState。結果 /events?x=a%20b 這種網址
 *    （空白編成 %20、同名參數兩次）會多一次轉址——中文站的行為就變了。normalizePublicHref()
 *    把 publicHref 改成「內部網址 → output」，等於沒開 rewrite 時的正規化行為。
 */
import type { AnyRouter, ParsedLocation } from "@tanstack/react-router";
import type { Lang } from "@/i18n/types";
import { isLocalizablePath, localizeHref, splitLangPrefix } from "@/lib/seo/i18n";

export function createLangRewrite(initial: Lang = "zh") {
  const state = { lang: initial };

  const rewrite = {
    input: ({ url }: { url: URL }) => {
      const split = splitLangPrefix(url.pathname);
      if (split.prefixed) {
        state.lang = split.lang;
        // 🔴 一定要回傳新的 URL：router-core 會把同一個 url 物件拿去算別的東西
        //    （server 的 handleServerRoutes 傳進來的是請求本身的 url）。
        const next = new URL(url.href);
        next.pathname = split.rest;
        return next;
      }
      // 沒有前綴的公開頁 = 中文。私密頁不改語言（沿用最後一次公開頁的語言）。
      if (isLocalizablePath(url.pathname)) state.lang = "zh";
      return undefined;
    },
    output: ({ url }: { url: URL }) => {
      const pathname = localizeHref(url.pathname, state.lang);
      if (pathname === url.pathname) return undefined;
      // 🔴 不可以直接改 url：buildLocation 之後還拿同一個物件算內部的 href（路由表的網址），
      //    改了會讓內部 href 也帶上 /en。
      const next = new URL(url.href);
      next.pathname = pathname;
      return next;
    },
  };

  function normalizePublicHref(router: AnyRouter) {
    const parse = router.parseLocation.bind(router) as AnyRouter["parseLocation"];
    router.parseLocation = ((location, previous) => {
      const parsed: ParsedLocation = parse(location, previous);
      if (parsed.external || parsed.maskedLocation) return parsed;
      return { ...parsed, publicHref: localizeHref(parsed.href, state.lang) };
    }) as AnyRouter["parseLocation"];
    // 建構時已經用原版 parse 過一次，換掉之後重算，第一次比對就用正規化的版本。
    if (router.history) {
      router.updateLatestLocation();
      router.stores?.location.set(router.latestLocation);
    }
  }

  /**
   * 私密頁（/cart、/checkout/complete…）**直接載入**時，state 是預設的中文，頁首「活動」「選物」
   * 會連回中文站——但介面已經換成訪客記住的英文。掛載之後（hydration 完成、不會造成屬性不一致）
   * 由 LanguageProvider 呼叫這裡，把之後產生的站內連結換成那個語言：
   *   · 清掉 router 的 staticLocations（buildLocation 依 opts 物件快取結果，語言換了要重算）
   *   · 用一個新的 location 物件觸發 <Link> 的 selector 重算 href（網址本身不變）
   * 公開頁不會呼叫（語言由網址決定，同一個 document 裡不會變）。
   */
  function setPreferredLang(router: AnyRouter, lang: Lang) {
    if (state.lang === lang) return;
    state.lang = lang;
    (router as unknown as { staticLocations?: WeakMap<object, unknown> }).staticLocations =
      new WeakMap();
    const stores = router.stores;
    if (stores) stores.location.set({ ...stores.location.get() });
  }

  return { rewrite, normalizePublicHref, setPreferredLang, state };
}

/** 瀏覽器端唯一的 router（server 每個請求各自一個，不登記）。 */
let clientLangSync: ((lang: Lang) => void) | null = null;

export function registerClientLangRewrite(
  router: AnyRouter,
  langRewrite: ReturnType<typeof createLangRewrite>,
) {
  clientLangSync = (lang) => langRewrite.setPreferredLang(router, lang);
}

/** 私密頁的站內連結跟著介面語言（見 setPreferredLang）。沒有 router（selftest）→ 什麼都不做。 */
export function syncRouterLang(lang: Lang) {
  clientLangSync?.(lang);
}
