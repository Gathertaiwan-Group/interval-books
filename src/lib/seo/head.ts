/**
 * 各路由 head() 共用的 meta 組裝（2026-11 SEO 健檢修正）。
 *
 * 規則（全站一致）：
 *   - title／description／og:title／og:description／twitter:title／twitter:description
 *     依**網址的語言**在 SSR 輸出（/en/… 英文、/ja/… 日文，2026-11）。useDocumentMeta 只在
 *     私密頁（介面跟著記住的語言）真的會換掉東西；公開頁的語言在同一個 document 裡不會變。
 *   - og:image／twitter:image 一律是**絕對網址**（FB、LINE 只吃絕對網址）。
 *   - canonical、og:url、og:locale、hreflang 由 pageHead() 輸出（要看這一頁各語言有沒有
 *     翻譯）；全站 JSON-LD（Organization／WebSite／BookStore）仍由 __root.tsx 輸出。
 *
 * ⚠️ 每一頁的 useDocumentMeta() 必須拿**同一組** Localized 值（同一個 seoTitle()／
 *    fitDescription() 的結果），否則瀏覽器一跑起來就把 SSR 的 title 換成另一個字串——
 *    Googlebot 看的是渲染後的 DOM。
 */
import type { AnyRouteMatch } from "@tanstack/react-router";
import type { Lang, Localized } from "@/i18n/types";
import { absoluteUrl, alternateUrls, canonicalUrl, ldMeta, WEBSITE_ID, type JsonLd } from "./core";
import { HREFLANG, indexableLangs, LD_LANGUAGE, OG_LOCALE, type PageTranslation } from "./i18n";

export type OgType = "website" | "article" | "product" | "profile";

/** head().meta 的一個項目。 */
export type MetaEntry = NonNullable<NonNullable<AnyRouteMatch["meta"]>[number]>;
/** head().links 的一個項目。 */
export type LinkEntry = NonNullable<NonNullable<AnyRouteMatch["links"]>[number]>;

/**
 * JSON-LD → head().meta 項目。TanStack 的 HeadContent 認得 `script:ld+json` 這個鍵，
 * 會輸出 <script type="application/ld+json"> 並做 HTML 跳脫（router-core 的
 * buildTagsFromMatches）；只是它的 TS 型別只列了 <meta> 的屬性，所以這裡轉一次型。
 */
export function ld(data: JsonLd): MetaEntry {
  return ldMeta(data) as unknown as MetaEntry;
}

/** head() 拿得到的東西（只列這裡用到的欄位，不綁 router 的泛型）。 */
export type HeadCtx = {
  matches: ReadonlyArray<{ loaderData?: unknown }>;
  match: { pathname: string; search?: unknown };
};

/** 這一頁（document）的語言：root loader 依網址算好的（見 __root.tsx）。 */
export function langFromMatches(matches: HeadCtx["matches"] | undefined): Lang {
  const data = matches?.[0]?.loaderData as { lang?: unknown } | undefined;
  const lang = data?.lang;
  return lang === "en" || lang === "ja" ? lang : "zh";
}

export type PageMetaOpts = {
  title: Localized;
  description: Localized;
  ogTitle?: Localized;
  ogDescription?: Localized;
  image?: string | null;
  type?: OgType;
  noindex?: boolean;
  jsonLd?: JsonLd[];
  /** 這一頁的英日文有沒有翻譯（noindex 規則，見 i18n.ts 的 isLangIndexable）。預設 "full"。 */
  translation?: PageTranslation;
};

/**
 * 公開頁的 head()：title／description／og／twitter、canonical、hreflang、og:locale、robots、
 * JSON-LD，全部依**這一頁的語言**在 SSR 就輸出（2026-11 /en /ja）。
 *
 *   · 文字：該語言的值，空的退回中文（與 useDocumentMeta、t() 同一條 fallback 規則）。
 *   · canonical 指向**自己這個語言**的網址；hreflang 列出所有「可收錄」的語言＋x-default（中文）。
 *     A 指 B、B 也指 A：每個語言版本用的是同一份 indexableLangs()。
 *   · 這個語言版本不可收錄（翻譯缺、或中文限定的著陸頁）→ robots noindex,follow，
 *     不輸出 canonical 與 hreflang（也不會出現在其他語言版本的 hreflang 裡）。
 *   · JSON-LD：頁面層的 Event、Book 補上 inLanguage，另外加一個 WebPage 節點。
 */
export function pageHead(
  ctx: HeadCtx,
  opts: PageMetaOpts,
): { meta: MetaEntry[]; links: LinkEntry[] } {
  const lang = langFromMatches(ctx.matches);
  const path = ctx.match.pathname || "/";
  const search = ctx.match.search;
  const langs = indexableLangs(opts.translation ?? "full");
  const indexable = !opts.noindex && langs.includes(lang);

  const pick = (v: Localized) => v[lang] || v.zh;
  const title = pick(opts.title);
  const ogTitle = pick(opts.ogTitle ?? opts.title);
  const ogDescription = pick(opts.ogDescription ?? opts.description);
  const image = absoluteUrl(opts.image);
  const canonical = canonicalUrl(path, search, lang);

  const meta: MetaEntry[] = [
    { title },
    { name: "description", content: pick(opts.description) },
    { property: "og:title", content: ogTitle },
    { property: "og:description", content: ogDescription },
    { name: "twitter:title", content: ogTitle },
    { name: "twitter:description", content: ogDescription },
    { property: "og:locale", content: OG_LOCALE[lang] },
  ];
  // og:locale:alternate 刻意不輸出：HeadContent 以 name／property 去重，同名的只會留一個
  // （留下來的那個反而是錯的組合）。語言版本的對應交給 hreflang。
  if (indexable) meta.push({ property: "og:url", content: canonical });
  if (opts.type) meta.push({ property: "og:type", content: opts.type });
  if (image) {
    meta.push({ property: "og:image", content: image });
    meta.push({ name: "twitter:image", content: image });
  }
  if (opts.noindex) meta.push({ name: "robots", content: "noindex, nofollow" });
  else if (!indexable) meta.push({ name: "robots", content: "noindex, follow" });

  // 中文限定的著陸頁：/en、/ja 版本的內容仍是中文，JSON-LD 照實標中文。
  const inLanguage = LD_LANGUAGE[opts.translation === "zh-only" ? "zh" : lang];
  for (const data of opts.jsonLd ?? []) meta.push(ld(withInLanguage(data, inLanguage)));
  if (indexable) {
    meta.push(
      ld({
        "@context": "https://schema.org",
        "@type": "WebPage",
        "@id": canonical,
        url: canonical,
        name: title,
        inLanguage,
        isPartOf: { "@id": WEBSITE_ID },
      }),
    );
  }

  const links: LinkEntry[] = indexable
    ? [
        { rel: "canonical", href: canonical },
        ...alternateUrls(path, search, langs).map((a) => ({
          rel: "alternate",
          hrefLang: a.lang === "x-default" ? "x-default" : HREFLANG[a.lang],
          href: a.href,
        })),
      ]
    : [];
  return { meta, links };
}

/** 頁面層 JSON-LD（Event、Product…）補 inLanguage；麵包屑不需要。 */
function withInLanguage(data: JsonLd, inLanguage: string): JsonLd {
  // inLanguage 是 CreativeWork／Event 的屬性；一般 Product（非書）、麵包屑沒有這個屬性，
  // 加了 Schema Markup Validator 會警告。
  const types = ([] as unknown[]).concat(data["@type"] ?? []);
  if (!types.some((t) => t === "Event" || t === "Book")) return data;
  return { ...data, inLanguage };
}

/** pageHead() 的結果再加上這一頁自己要的 <link>（字型、頁面專屬 CSS）。 */
export function withLinks(
  head: { meta: MetaEntry[]; links: LinkEntry[] },
  extra: LinkEntry[],
): { meta: MetaEntry[]; links: LinkEntry[] } {
  return { meta: head.meta, links: [...head.links, ...extra] };
}
