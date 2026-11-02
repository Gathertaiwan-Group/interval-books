/**
 * 英日文網址前綴（/en、/ja）的純函式核心（2026-11）。
 *
 * ⚠️ 跟 core.ts 一樣**零 runtime import**（只有 `import type`）：src/router.tsx 的 location
 *    rewrite、src/server.ts 每一個請求、scripts/i18n-url-selftest.mjs 都直接呼叫這裡。
 *
 * ── 網址規則 ──────────────────────────────────────────────────────────────────
 *   · 中文不加前綴，原網址完全不變（/events/kungtung）。
 *   · 英文 /en/…、日文 /ja/…，涵蓋所有前台公開頁。首頁是 /en、/ja（沒有尾斜線）。
 *   · 私密頁（後台、廠商、結帳、購物車、會員、登入確認、OAuth、API）**不加前綴**：
 *     /en/admin 不會被剝成 /admin，於是沒有路由對得到 → 404。它們的介面語言跟著訪客在
 *     localStorage 記住的語言（LanguageContext）。
 *
 * ── 為什麼語言只看網址 ─────────────────────────────────────────────────────────
 *   SSR 依網址輸出該語言，瀏覽器第一次 render 也依網址 → 一定一致（不會 #418）。
 *   伺服器**永遠**只看網址（不看 Accept-Language／cookie，不 302、不加 Vary）。
 *   依瀏覽器語系自動導向（2026-11 業主要求）只在瀏覽器端做，排除爬蟲、只導一次、手動選擇優先，
 *   見 src/lib/lang-autodetect.ts。
 */
import type { Lang, Localized, LocalizedList } from "../../i18n/types";

/** 有網址前綴的語言。中文是預設語言、沒有前綴。 */
export const PREFIX_LANGS = ["en", "ja"] as const;
export type PrefixLang = (typeof PREFIX_LANGS)[number];
export const SITE_LANGS: readonly Lang[] = ["zh", "en", "ja"];

/** hreflang 的值（spec：zh-Hant、en、ja、x-default）。 */
export const HREFLANG: Record<Lang, string> = { zh: "zh-Hant", en: "en", ja: "ja" };
/** og:locale 的值。 */
export const OG_LOCALE: Record<Lang, string> = { zh: "zh_TW", en: "en_US", ja: "ja_JP" };
/** JSON-LD inLanguage（BCP 47）。中文沿用全站原本的 zh-Hant-TW。 */
export const LD_LANGUAGE: Record<Lang, string> = { zh: "zh-Hant-TW", en: "en", ja: "ja" };

/**
 * 不加語言前綴的路徑。與 core.ts 的 NOINDEX_PREFIXES 大致相同，另外加上非頁面的
 * /media、/assets、/.well-known（圖片代理、bundle、OAuth discovery）。
 */
export const UNLOCALIZED_PREFIXES: readonly string[] = [
  "/admin",
  "/vendor",
  "/checkout",
  "/cart",
  "/account",
  "/auth",
  "/oauth",
  "/api",
  "/_serverFn",
  "/media",
  "/assets",
  "/.well-known",
];
const UNLOCALIZED_EXACT = ["/robots.txt", "/sitemap.xml"];

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** 這條（不含前綴的）路徑能不能有 /en、/ja 版本。大小寫不分（/Admin 也算後台）。 */
export function isLocalizablePath(pathname: string): boolean {
  const p = (pathname || "/").toLowerCase();
  if (!p.startsWith("/")) return false;
  if (UNLOCALIZED_EXACT.includes(p)) return false;
  return !UNLOCALIZED_PREFIXES.some((prefix) => matchesPrefix(p, prefix.toLowerCase()));
}

export type LangSplit = { lang: Lang; rest: string; prefixed: boolean };

/**
 * 拆網址前綴：/en/events → { lang: "en", rest: "/events", prefixed: true }。
 * 只認**小寫**前綴（/EN/events 由 src/server.ts 的 redirectFor() 先 301 成小寫）；
 * 剝掉之後是私密路徑（/en/admin）→ 不拆（那條網址沒有頁面 → 404）。
 */
export function splitLangPrefix(pathname: string): LangSplit {
  const m = /^\/(en|ja)(?=\/|$)/.exec(pathname);
  if (!m) return { lang: "zh", rest: pathname, prefixed: false };
  const rest = pathname.slice(m[0].length) || "/";
  if (!isLocalizablePath(rest)) return { lang: "zh", rest: pathname, prefixed: false };
  return { lang: m[1] as PrefixLang, rest, prefixed: true };
}

/**
 * 這個網址（pathname）屬於哪一種語言的**公開頁**。私密頁 → null（語言跟著 localStorage）。
 */
export function publicLangOf(pathname: string): Lang | null {
  const split = splitLangPrefix(pathname);
  if (split.prefixed) return split.lang;
  return isLocalizablePath(pathname) ? "zh" : null;
}

function splitHref(href: string): { path: string; tail: string } {
  const i = href.search(/[?#]/);
  return i < 0 ? { path: href, tail: "" } : { path: href.slice(0, i), tail: href.slice(i) };
}

/**
 * 站內網址（可含 ?query#hash）→ 指定語言的版本。中文 → 原樣；私密頁、外部網址、
 * 已經有前綴的 → 原樣。router 的 output rewrite 與所有手寫的 `<a href>` 共用這一支。
 */
export function localizeHref(href: string, lang: Lang): string {
  if (lang === "zh") return href;
  const { path, tail } = splitHref(href);
  if (!path.startsWith("/") || path.startsWith("//")) return href;
  // 已經帶前綴（含 /en/admin 這種沒有頁面的）→ 不再加第二層。
  if (!isLocalizablePath(path) || /^\/(en|ja)(?=\/|$)/.test(path)) return href;
  return `/${lang}${path === "/" ? "" : path}${tail}`;
}

/** 去掉語言前綴：/en/events?x=1 → /events?x=1。沒有前綴（或私密頁）原樣。 */
export function delocalizeHref(href: string): string {
  const { path, tail } = splitHref(href);
  const split = splitLangPrefix(path);
  return split.prefixed ? `${split.rest}${tail}` : href;
}

/** 同一頁換成另一種語言的網址（語言切換鈕、「View in English?」提示用）。 */
export function switchLangHref(href: string, target: Lang): string {
  return localizeHref(delocalizeHref(href), target);
}

// =============================================================================
// 翻譯完整度（noindex 規則）
// =============================================================================

/**
 * 寫死在程式碼、只有中文版內容的著陸頁（版面與文案都是中文稿，見各檔檔頭）。
 * 這些頁的 /en、/ja 版本照樣可以開（頁首頁尾是對應語言），但一律 noindex、
 * 不進 sitemap、不輸出它的 hreflang。之後業主給了英日文稿、頁面做成三語，再從這裡拿掉。
 */
export const ZH_ONLY_PATHS: readonly string[] = [
  "/events/kungtung",
  "/events/kungtung/hosts/alice",
  "/events/kungtung/hosts/fan-yishun",
  "/events/sound-of-the-sea",
  "/events/city-salon-0922",
];

export function isZhOnlyPath(pathname: string): boolean {
  return ZH_ONLY_PATHS.includes(pathname.replace(/\/+$/, "") || "/");
}

const HAN = /[㐀-鿿豈-﫿]/g;
const NON_SPACE = /\S/g;

function textOf(v: string | string[] | null | undefined): string {
  return (Array.isArray(v) ? v.join("\n") : (v ?? "")).trim();
}

/**
 * 一段文字在某個語言算不算「有翻譯」：
 *   · 空的 → 沒有
 *   · 英文：漢字佔非空白字元超過 30% → 沒有（把中文原文貼進英文欄）
 *   · 日文：跟中文**一字不差**且超過 15 字 → 沒有（短的書名、刊物名用漢字本來就相同）
 * 中文永遠算有（中文就是原文）。
 */
export function isTextTranslated(
  lang: Lang,
  zh: string | string[] | null | undefined,
  value: string | string[] | null | undefined,
): boolean {
  const v = textOf(value);
  if (lang === "zh") return true;
  if (!v) return false;
  if (lang === "en") {
    const chars = v.match(NON_SPACE)?.length ?? 0;
    const han = v.match(HAN)?.length ?? 0;
    return chars === 0 || han / chars <= 0.3;
  }
  const z = textOf(zh);
  return !(v === z && Array.from(z).length > 15);
}

type Field = Localized | LocalizedList | null | undefined;

/** 欄位在某個語言有沒有翻譯。中文本身是空的（這一欄沒用到）→ null（不列入判斷）。 */
export function fieldTranslated(lang: Lang, field: Field): boolean | null {
  if (!field || !textOf(field.zh)) return null;
  return isTextTranslated(lang, field.zh, field[lang]);
}

export type PageTranslation =
  /** 介面文字寫在程式碼裡、三語齊全的頁面（列表頁、關於…）。 */
  | "full"
  /** 只有中文內容的著陸頁（ZH_ONLY_PATHS）。 */
  | "zh-only"
  /** 內容來自資料庫的頁：主要內容＝標題＋本文欄位。 */
  | { title: Field; body: Field[] };

/**
 * 🔴 noindex 規則：這一頁的某個語言版本能不能被收錄。
 *   · 中文 → 一律可以。
 *   · "full" → 可以；"zh-only" → 不行。
 *   · 資料庫內容：標題沒翻譯 → 不行；本文欄位（中文有內容的那幾欄）**全部**沒翻譯 → 不行。
 *     只缺其中幾欄 → 可以收錄，缺的那幾欄在頁面上顯示中文（t() 的 fallback）。
 * 不行的版本：頁面照樣 200（頁首頁尾是該語言），但 robots noindex、不進 sitemap、
 * 也不出現在任何一頁的 hreflang 裡。
 */
export function isLangIndexable(lang: Lang, translation: PageTranslation): boolean {
  if (lang === "zh") return true;
  if (translation === "full") return true;
  if (translation === "zh-only") return false;
  const title = fieldTranslated(lang, translation.title);
  if (title === false) return false;
  const body = translation.body.map((f) => fieldTranslated(lang, f)).filter((v) => v !== null);
  if (body.length > 0 && !body.includes(true)) return false;
  // 標題與本文都沒有中文內容（讀取失敗的頁殼）→ 那一頁本身就是 503，這裡當作可以。
  return true;
}

/** 這一頁可以被收錄的語言（一定含 zh）。 */
export function indexableLangs(translation: PageTranslation): Lang[] {
  return SITE_LANGS.filter((l) => isLangIndexable(l, translation));
}
