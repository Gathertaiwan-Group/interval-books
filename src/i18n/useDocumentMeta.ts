import { useEffect } from "react";
import { absoluteUrl } from "@/lib/seo/core";
import { useLang } from "./LanguageContext";
import type { Localized } from "./types";

type MetaInput = {
  title: Localized;
  description: Localized;
  ogTitle?: Localized;
  ogDescription?: Localized;
  ogImage?: string;
};

function setMeta(selector: string, attr: "name" | "property", key: string, content: string) {
  if (typeof document === "undefined") return;
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

/**
 * Reactively updates <title> and meta tags based on the current language.
 * Runs client-side only; SSR keeps the static fallback from each route's head().
 */
export function useDocumentMeta(meta: MetaInput) {
  const { lang } = useLang();

  useEffect(() => {
    const title = meta.title[lang] || meta.title.zh;
    const description = meta.description[lang] || meta.description.zh;
    const ogTitle = (meta.ogTitle ?? meta.title)[lang] || title;
    const ogDescription = (meta.ogDescription ?? meta.description)[lang] || description;

    document.title = title;
    setMeta('meta[name="description"]', "name", "description", description);
    setMeta('meta[property="og:title"]', "property", "og:title", ogTitle);
    setMeta('meta[property="og:description"]', "property", "og:description", ogDescription);
    setMeta('meta[name="twitter:title"]', "name", "twitter:title", ogTitle);
    setMeta('meta[name="twitter:description"]', "name", "twitter:description", ogDescription);
    if (meta.ogImage) {
      // 絕對網址：與 head() 的 SSR 輸出一致（見 src/lib/seo/head.ts），FB／LINE 只吃絕對網址。
      const ogImage = absoluteUrl(meta.ogImage);
      setMeta('meta[property="og:image"]', "property", "og:image", ogImage);
      setMeta('meta[name="twitter:image"]', "name", "twitter:image", ogImage);
    }
    // 沒給 ogImage 時**不再移除** og:image（2026-11）：__root.tsx 的 head() 現在一定會放
    // 一張全站預設分享圖，那是 React（HeadContent）管的節點，從 DOM 拔掉它下一次換頁
    // React 會對著一個不存在的節點 reconcile。換頁時 HeadContent 本來就會換成新頁面的值，
    // 不會留下前一頁的圖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    lang,
    meta.title.zh,
    meta.title.en,
    meta.title.ja,
    meta.description.zh,
    meta.description.en,
    meta.description.ja,
    meta.ogTitle?.zh,
    meta.ogTitle?.en,
    meta.ogTitle?.ja,
    meta.ogDescription?.zh,
    meta.ogDescription?.en,
    meta.ogDescription?.ja,
    meta.ogImage,
  ]);
}
