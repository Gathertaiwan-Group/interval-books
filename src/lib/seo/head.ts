/**
 * 各路由 head() 共用的 meta 組裝（2026-11 SEO 健檢修正）。
 *
 * 規則（全站一致）：
 *   - title／description／og:title／og:description／twitter:title／twitter:description
 *     一律在 SSR 輸出中文版（訪客切語言時由 useDocumentMeta 在瀏覽器換掉）。
 *   - og:image／twitter:image 一律是**絕對網址**（FB、LINE 只吃絕對網址）。
 *   - canonical、og:url、og:locale、全站 JSON-LD 由 __root.tsx 統一輸出，不在這裡。
 *
 * ⚠️ 每一頁的 useDocumentMeta() 必須拿**同一組** Localized 值（同一個 seoTitle()／
 *    fitDescription() 的結果），否則瀏覽器一跑起來就把 SSR 的 title 換成另一個字串——
 *    Googlebot 看的是渲染後的 DOM。
 */
import type { AnyRouteMatch } from "@tanstack/react-router";
import type { Localized } from "@/i18n/types";
import { absoluteUrl, ldMeta, type JsonLd } from "./core";

export type OgType = "website" | "article" | "product" | "profile";

/** head().meta 的一個項目。 */
export type MetaEntry = NonNullable<NonNullable<AnyRouteMatch["meta"]>[number]>;

/**
 * JSON-LD → head().meta 項目。TanStack 的 HeadContent 認得 `script:ld+json` 這個鍵，
 * 會輸出 <script type="application/ld+json"> 並做 HTML 跳脫（router-core 的
 * buildTagsFromMatches）；只是它的 TS 型別只列了 <meta> 的屬性，所以這裡轉一次型。
 */
export function ld(data: JsonLd): MetaEntry {
  return ldMeta(data) as unknown as MetaEntry;
}

export function pageMeta(opts: {
  title: Localized;
  description: Localized;
  ogTitle?: Localized;
  ogDescription?: Localized;
  image?: string | null;
  type?: OgType;
  noindex?: boolean;
  jsonLd?: JsonLd[];
}): MetaEntry[] {
  const ogTitle = (opts.ogTitle ?? opts.title).zh;
  const ogDescription = (opts.ogDescription ?? opts.description).zh;
  const image = absoluteUrl(opts.image);
  const meta: MetaEntry[] = [
    { title: opts.title.zh },
    { name: "description", content: opts.description.zh },
    { property: "og:title", content: ogTitle },
    { property: "og:description", content: ogDescription },
    { name: "twitter:title", content: ogTitle },
    { name: "twitter:description", content: ogDescription },
  ];
  if (opts.type) meta.push({ property: "og:type", content: opts.type });
  if (image) {
    meta.push({ property: "og:image", content: image });
    meta.push({ name: "twitter:image", content: image });
  }
  if (opts.noindex) meta.push({ name: "robots", content: "noindex, nofollow" });
  for (const data of opts.jsonLd ?? []) meta.push(ld(data));
  return meta;
}
