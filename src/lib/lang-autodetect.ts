/**
 * 依瀏覽器語系自動導到 /en、/ja（或從 /en、/ja 導回中文）—— 2026-11 業主要求。
 *
 * ── 為什麼這樣做（不傷 SEO）──────────────────────────────────────────────────
 *   · 🔴 伺服器**完全不參與**：SSR 不看 Accept-Language、不看 cookie，不回 302、不加 Vary。
 *     同一個網址永遠是同一份 HTML（CDN 快取不會混語言，Googlebot 拿到的一定是網址的語言）。
 *   · 在**瀏覽器端**、<head> 一載入就判斷（root head() 的 inline script，排在 hreflang 的
 *     <link> 之後、body 之前）。stylesheet 本來就擋著第一次繪製，所以多半在中文畫面出現前就轉走。
 *   · 用 location.replace：不留返回紀錄（按上一頁不會又跳回中文頁、又被轉走）。
 *   · 爬蟲（Googlebot、bingbot、FB／LINE／Slack／Discord 預覽…）一律不導。
 *   · 只導到**真的存在、可以收錄**的語言版本：看這一頁 <head> 裡有沒有那個語言的 hreflang
 *     ——pageHead() 只為 isLangIndexable() 的語言輸出 hreflang，跟 noindex、sitemap 同一個判斷。
 *     中文限定著陸頁、私密頁（購物車、結帳、會員、後台）沒有 hreflang，再加一道明確的排除。
 *
 * ── 只導一次、手動優先 ─────────────────────────────────────────────────────────
 *   · 導過一次就記下（LANG_AUTO_KEY），之後這位訪客不再自動導（打開別人分享的中文連結也不轉）。
 *   · 按過頁首的語言切換（LANG_CHOICE_KEY），一律以手動選擇為準，永遠不再自動導。
 *   · 兩個值都同時寫 localStorage 與 cookie（無痕模式 localStorage 可能丟例外，cookie 補位）。
 *     cookie 只給這支 script 自己讀；伺服器不讀。
 *   · 舊版切換鈕只寫 LANG_STORAGE_KEY（interval-books-lang）。那裡的 "zh" 只可能是手動選的
 *     （開中文頁不寫入），當作手動選了中文；"en"／"ja" 開 /en、/ja 頁也會寫入，不能當手動。
 *   · 從**站內**點過來（同源 referrer）一律不導：自動導向只發生在「進站」那一頁。這也涵蓋
 *     中鍵／長按「在新分頁開啟」切換鈕（不會觸發 onClick、記不到手動選擇），以及
 *     localStorage、cookie 都被封鎖、記不住任何東西的瀏覽器（按「中」之後不會又被導回 /en）。
 *
 * ── 每個 document 只跑一次 ──────────────────────────────────────────────────────
 *   TanStack 的 <Script> 在 hydration 後會把 SSR 那份移掉，換頁時（head 變了）再插一份新的並
 *   **立刻執行**。所以 script 開頭用 document.readyState（只在第一次解析時是 "loading"）與
 *   window 旗標擋掉重複執行——否則入口頁沒導的訪客，點站內連結就會在換頁途中被整頁導走。
 *   決定要導時設 window.__ibLangRedirecting：被導走的這一頁若仍來得及 hydrate，
 *   LanguageProvider 不寫「記住的語言」、GA 不送 page_view（isAutoRedirecting()）。
 *
 * ⚠️ 判斷邏輯寫成**字串**（DECIDE_AUTO_LANG_SRC），inline script 與
 *    scripts/lang-autodetect-selftest.mjs 用的是同一份原始碼——測的就是上線的那一份。
 *    不要用 fn.toString()：bundler 可能注入 helper（__name 之類），inline 之後就壞了。
 *    這份字串要能在舊瀏覽器直接跑：只用 ES5（var、function、indexOf）。
 */
import type { Lang } from "@/i18n/types";
import { UNLOCALIZED_PREFIXES, ZH_ONLY_PATHS } from "@/lib/seo/i18n";

/** 訪客**手動**選過的語言（按頁首語言切換、按「View in English」）。 */
export const LANG_CHOICE_KEY = "interval-books-lang-choice";
/** 自動導過一次的結果（導去哪個語言）。有值 = 不再自動導。 */
export const LANG_AUTO_KEY = "interval-books-lang-auto";
/** LanguageContext 的 LANG_STORAGE_KEY（介面語言）。不 import：LanguageContext 是 .tsx（含 React）。 */
export const LEGACY_LANG_KEY = "interval-books-lang";

/**
 * 爬蟲與連結預覽。寧可多擋（真人被擋 = 看中文原頁，有切換鈕可按），不可漏擋。
 *   · bot：Googlebot、bingbot、Twitterbot、Slackbot、Discordbot、LinkedInBot、Applebot、GPTBot…
 *   · google：Google-InspectionTool、AdsBot-Google、Mediapartners-Google、GoogleOther
 *     （一般 Chrome 的 UA 不含 google；Google App 是 GSA/）
 *   · line/、line-：LINE 的預覽（line-poker）與 LINE 內建瀏覽器——業主指定 LINE 一律不導
 *   · headlesschrome、lighthouse：無頭瀏覽器、PageSpeed 等工具
 */
export const BOT_UA_SOURCE =
  "bot|crawl|spider|slurp|google|facebookexternalhit|facebookcatalog|meta-externalagent|whatsapp|preview|embedly|iframely|pinterest|vkshare|yandex|baidu|bytespider|yeti|kakaotalk-scrap|headlesschrome|lighthouse|pagespeed|prerender|\\bline[/-]|curl/|wget|python-|go-http|node-fetch|axios";

/**
 * 純函式：要不要自動導、導去哪裡。回傳 null = 不導；{ lang, path } = 導到 path（呼叫端
 * 自己接上 location.search 與 hash）。
 *
 * 輸入：
 *   ua               navigator.userAgent
 *   languages        navigator.languages（沒有就 [navigator.language]）；只看第一個
 *   manual           LANG_CHOICE_KEY 的值（localStorage 或 cookie）
 *   legacy           舊的 LANG_STORAGE_KEY（interval-books-lang）的值；"zh" = 手動選過中文
 *   auto             LANG_AUTO_KEY 的值
 *   sameOriginReferrer  document.referrer 是不是本站（站內點過來的）
 *   pathname         location.pathname
 *   alternates       這一頁 <head> 裡的 hreflang → href（{ "zh-Hant": …, en: …, ja: …, "x-default": … }）
 *   privatePrefixes  不導的私密路徑（src/lib/seo/i18n.ts 的 UNLOCALIZED_PREFIXES）
 *   zhOnly           中文限定著陸頁（ZH_ONLY_PATHS）
 */
export const DECIDE_AUTO_LANG_SRC = `function decideAutoLang(i) {
  if (i.manual === "zh" || i.manual === "en" || i.manual === "ja") return null;
  if (i.legacy === "zh") return null;
  if (i.auto) return null;
  if (i.sameOriginReferrer) return null;
  var ua = String(i.ua || "");
  if (!ua || new RegExp(${JSON.stringify(BOT_UA_SOURCE)}, "i").test(ua)) return null;
  var first = String((i.languages && i.languages[0]) || "").toLowerCase();
  var pref = /^en(-|$)/.test(first) ? "en" : /^ja(-|$)/.test(first) ? "ja" : /^zh(-|$)/.test(first) ? "zh" : null;
  if (!pref) return null;
  var path = String(i.pathname || "/");
  var m = /^\\/(en|ja)(?=\\/|$)/.exec(path);
  var rest = (m ? path.slice(m[0].length) : path) || "/";
  var restLower = rest.toLowerCase();
  var priv = i.privatePrefixes || [];
  for (var k = 0; k < priv.length; k++) {
    var p = String(priv[k]).toLowerCase();
    if (restLower === p || restLower.indexOf(p + "/") === 0) return null;
  }
  var bare = rest.replace(/\\/+$/, "") || "/";
  if ((i.zhOnly || []).indexOf(bare) >= 0) return null;
  var pageLang = m ? m[1] : "zh";
  if (pref === pageLang) return null;
  var alt = i.alternates && i.alternates[pref === "zh" ? "zh-Hant" : pref];
  if (!alt) return null;
  var target;
  try {
    target = new URL(alt, "https://www.intervalbooks.tw").pathname;
  } catch (e) {
    return null;
  }
  if (!target || target === path) return null;
  var tm = /^\\/(en|ja)(?=\\/|$)/.exec(target);
  if ((tm ? tm[1] : "zh") !== pref) return null;
  return { lang: pref, path: target };
}`;

/** <head> 裡的 inline script（root head() 的 scripts）。內容固定，SSR 與瀏覽器一致。 */
export const LANG_AUTODETECT_SCRIPT = `(function(){try{
if(document.readyState!=="loading"||window.__ibLangAutodetect)return;window.__ibLangAutodetect=1;
var P=${JSON.stringify(UNLOCALIZED_PREFIXES)},Z=${JSON.stringify(ZH_ONLY_PATHS)};
var MK=${JSON.stringify(LANG_CHOICE_KEY)},AK=${JSON.stringify(LANG_AUTO_KEY)},LK=${JSON.stringify(LEGACY_LANG_KEY)};
function rd(k){var v=null;try{v=window.localStorage.getItem(k)}catch(e){}if(v)return v;var c=document.cookie.match(new RegExp("(?:^|; )"+k+"=([^;]*)"));return c?decodeURIComponent(c[1]):null}
function wr(k,v){try{window.localStorage.setItem(k,v)}catch(e){}try{document.cookie=k+"="+encodeURIComponent(v)+"; path=/; max-age=31536000; samesite=lax"+(location.protocol==="https:"?"; secure":"")}catch(e){}}
${DECIDE_AUTO_LANG_SRC}
var alts={},ls=document.querySelectorAll('link[rel="alternate"][hreflang]');
for(var j=0;j<ls.length;j++)alts[ls[j].getAttribute("hreflang")]=ls[j].getAttribute("href");
var n=window.navigator,ref=document.referrer||"",o=location.protocol+"//"+location.host;
var r=decideAutoLang({ua:n.userAgent,languages:(n.languages&&n.languages.length)?n.languages:[n.language],manual:rd(MK),legacy:rd(LK),auto:rd(AK),sameOriginReferrer:ref===o||ref.indexOf(o+"/")===0,pathname:location.pathname,alternates:alts,privatePrefixes:P,zhOnly:Z});
if(!r)return;
window.__ibLangRedirecting=1;
wr(AK,r.lang);
location.replace(r.path+location.search+location.hash);
}catch(e){}})();`;

/** 這一頁正在被自動導走（<head> 的 script 已呼叫 location.replace）。 */
export function isAutoRedirecting(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as { __ibLangRedirecting?: number }).__ibLangRedirecting === 1
  );
}

function writeKey(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
  try {
    document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax${
      location.protocol === "https:" ? "; secure" : ""
    }`;
  } catch {
    /* ignore */
  }
}

/** 訪客手動選了語言（頁首切換鈕、「View in English」）。之後永遠不再自動導。 */
export function writeLangChoice(lang: Lang) {
  if (typeof window === "undefined") return;
  writeKey(LANG_CHOICE_KEY, lang);
}

/** 手動選過的語言（掛載後才可以呼叫）。 */
export function readLangChoice(): Lang | null {
  if (typeof window === "undefined") return null;
  let v: string | null = null;
  try {
    v = window.localStorage.getItem(LANG_CHOICE_KEY);
  } catch {
    /* ignore */
  }
  if (!v) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${LANG_CHOICE_KEY}=([^;]*)`));
    v = m ? decodeURIComponent(m[1]) : null;
  }
  return v === "zh" || v === "en" || v === "ja" ? v : null;
}
