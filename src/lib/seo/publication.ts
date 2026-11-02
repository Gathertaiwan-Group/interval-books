/**
 * 地方刊物獨立頁（/publications、/publications/$slug）的 SEO 與頁面組裝 —— 純函式（2026-11 M4）。
 *
 * ⚠️ 與 core.ts、i18n.ts 一樣**零 runtime import 到 "@/…"**（只用相對路徑、`import type`）：
 *    scripts/publication-page-selftest.mjs 直接 import 這個檔案跑真的行為測試。
 *
 * ── 決策紀錄 ───────────────────────────────────────────────────────────────────
 *  · JSON-LD 用 `Book`（有對應商品時 `["Book","Product"]` + offers），不用 `Periodical`：
 *    Periodical 在 schema.org 是 CreativeWorkSeries，指的是「整個刊物系列」；店裡典藏、
 *    販售的是手上那幾本實體刊（「vol.1、vol.3」「創刊號」）。Book 能帶 publisher、
 *    inLanguage（pageHead 會補）、offers，也跟 /shop/pub-* 既有的 Product+Book 標記同一套；
 *    Google 對 Periodical 沒有任何搜尋結果功能，對 Product+offers 有商品摘要。
 *  · 有商品的 19 本：**刊物頁是 canonical**。/shop/pub-* 的商品說明與刊物介紹逐字相同
 *    （2026-11 查過 19/19 相同），兩頁幾乎重複；商品頁照常可以買，但 canonical 指向刊物頁、
 *    不進 sitemap（見 shop.$slug.tsx、sitemap-entries.ts）。刊物頁的 JSON-LD 帶 offers，
 *    價格與購買訊號不會因此消失。
 */
import type { Lang, Localized } from "../../i18n/types";
import {
  absoluteUrl,
  BRAND,
  breadcrumbLd,
  canonicalUrl,
  charLength,
  fitDescription,
  joinTitle,
  ORG_ID,
  STORE_NAME,
  stripForeignBrandSuffix,
  truncate,
  type JsonLd,
} from "./core.ts";
import { localizeHref, type PageTranslation } from "./i18n.ts";
import {
  REGION_GROUP_OTHER,
  regionGroupOf,
  regionGroupsFor,
  SHEET_LABELS,
  type PublicationSheet,
} from "../publication-regions.ts";

/** 刊物總覽頁（不含語言前綴）。 */
export const PUBLICATIONS_PATH = "/publications";

/** 一本刊物的頁面路徑（不含語言前綴）。 */
export function publicationPath(slug: string): string {
  return `${PUBLICATIONS_PATH}/${slug}`;
}

/** 麵包屑與 title 中段用的「地方刊物」。 */
export const PUBLICATIONS_LABEL: Localized = {
  zh: "地方刊物",
  en: "Local Publications",
  ja: "地域の刊行物",
};

const HOME_LABEL: Localized = { zh: "首頁", en: "Home", ja: "ホーム" };

/** 組 SEO 需要的刊物欄位（PublicationEntry 結構上相容）。 */
export type PublicationSeoInput = {
  slug: string;
  sheet: PublicationSheet;
  title: Localized;
  publisher: Localized;
  intro: Localized;
  region: string;
  issues: string | null;
  externalUrl: string | null;
};

/** 刊物頁上的商品（有 product_id 而且讀得到上架中的商品才有）。 */
export type PublicationOffer = {
  slug: string;
  price: number;
  inStock: boolean;
};

/**
 * 地區的顯示名稱：粗分類的名稱（基隆／Keelung）。落在「其他」的（台灣各地、客家文化、
 * 地域編集の教科書…）中日文用原文，英文用國家名——原文是中文，放進英文 title 不合適。
 */
export function publicationRegionLabel(entry: {
  sheet: PublicationSheet;
  region: string;
}): Localized {
  const key = regionGroupOf(entry);
  const group = regionGroupsFor(entry.sheet).find((g) => g.key === key);
  if (group && key !== REGION_GROUP_OTHER.key) return group.label;
  const raw = entry.region.trim();
  const sheet = SHEET_LABELS[entry.sheet];
  const country: Localized =
    entry.sheet === "tw"
      ? { zh: "台灣", en: "Taiwan", ja: "台湾" }
      : { zh: "日本", en: "Japan", ja: "日本" };
  return { zh: raw || sheet.zh, en: country.en, ja: raw || country.ja };
}

/** 「許焜山／八斗子漁村文物館」→「八斗子漁村文物館」：多段的出版者取最後一段（通常是單位名）。 */
export function publisherShort(publisher: string): string {
  const parts = publisher
    .split(/[／/]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : publisher.trim();
}

/** title 的長度上限（超過就拿掉出版者那一段）。中日文以字數、英文以字元數計。 */
const TITLE_LIMIT: Record<Lang, number> = { zh: 40, ja: 40, en: 70 };

/**
 * 「東北風｜基隆・八斗子漁村文物館｜地方刊物｜小時光風土誌書店」。
 * 太長 → 「東北風｜基隆｜地方刊物｜小時光風土誌書店」（刊名本身再長也不截——那是要被搜到的字）。
 */
export function publicationTitle(entry: PublicationSeoInput): Localized {
  const region = publicationRegionLabel(entry);
  const build = (lang: Lang): string => {
    const name = stripForeignBrandSuffix(entry.title[lang] || entry.title.zh);
    const where = region[lang] || region.zh;
    const who = publisherShort(entry.publisher[lang] || entry.publisher.zh);
    const sep = lang === "en" ? " · " : "・";
    const label = PUBLICATIONS_LABEL[lang];
    const full = joinTitle(
      name,
      who && who !== name ? `${where}${sep}${who}` : where,
      label,
      BRAND[lang],
    );
    if (charLength(full) <= TITLE_LIMIT[lang]) return full;
    const short = joinTitle(name, where, label, BRAND[lang]);
    if (charLength(short) <= TITLE_LIMIT[lang]) return short;
    // 刊名本身就很長（英文常見）：再拿掉「地方刊物」那一段，只留 刊名｜地區｜店名。
    return joinTitle(name, where, BRAND[lang]);
  };
  return { zh: build("zh"), en: build("en"), ja: build("ja") };
}

/** description 的長度上限（同 core.ts 的 DESC_LIMITS；這裡要先扣掉結尾刊名的長度）。 */
const DESC_MAX: Record<Lang, number> = { zh: 160, ja: 160, en: 300 };

/**
 * description：「介紹文——《刊名》」，整段 70–160 字（英文 110–300 字元；規則同全站
 * fitDescription）。
 *
 * 2026-11 SEO 健檢：
 *  · 結尾帶刊名——同一個製作團隊的幾本刊物，介紹文有逐字相同的（例：來義鄉刊／泰武鄉刊），
 *    不帶刊名兩頁的描述就一模一樣；刊名放開頭也不夠（刊名一樣長時，截斷後的結尾仍相同），
 *    所以放在**結尾**，介紹文先截短讓位。介紹文本身已經提到刊名就不加。
 *  · 介紹太短時補的是**這一本的**地區、製作單位、集數（publicationFiller），不再接全站同一句
 *    站名標語。補完仍不到 70 字就讓它短。
 */
export function publicationDescription(entry: PublicationSeoInput): Localized {
  const body = fitDescription(entry.intro, null, publicationFiller(entry));
  const build = (lang: Lang): string => {
    const text = body[lang];
    const name = stripForeignBrandSuffix(entry.title[lang] || entry.title.zh);
    if (!text || !name || (entry.intro[lang] || "").includes(name)) return text;
    const tag = lang === "en" ? ` — ${name}` : lang === "ja" ? `——『${name}』` : `——《${name}》`;
    const room = DESC_MAX[lang] - charLength(tag);
    return `${charLength(text) > room ? truncate(text, room) : text}${tag}`;
  };
  return { zh: build("zh"), en: build("en"), ja: build("ja") };
}

/**
 * 刊物介紹太短時的補充句：地區、製作單位、集數——都是刊物頁上印著的欄位。
 * 「店內翻閱」是固定的事實（每一本都在店內展示），放在句首；句尾是這一本自己的欄位，
 * 兩本刊物的描述結尾才不會一樣。
 */
export function publicationFiller(entry: PublicationSeoInput): Localized {
  const region = publicationRegionLabel(entry);
  const issues = (entry.issues ?? "").trim();
  const build = (lang: Lang): string => {
    const where = region[lang] || region.zh;
    const who = publisherShort(entry.publisher[lang] || entry.publisher.zh)
      .replace(/\s*\n\s*/g, lang === "en" ? ", " : "、")
      .trim();
    if (lang === "en")
      return `Kept at Interval Books to browse in store: a local publication from ${where}${who ? `, made by ${who}` : ""}${issues ? ` (${issues})` : ""}.`;
    if (lang === "ja")
      return `小時光 風土誌書店の店頭で閲覧できる、${where}の地域の刊行物${who ? `。発行は${who}` : ""}${issues ? `（${issues}）` : ""}。`;
    return `收藏在小時光風土誌書店、可到店翻閱的${where}地方刊物${who ? `，由${who}製作` : ""}${issues ? `，店內有 ${issues}` : ""}。`;
  };
  return { zh: build("zh"), en: build("en"), ja: build("ja") };
}

const HAN = /[㐀-鿿豈-﫿]/;

/**
 * noindex 規則的輸入：刊名＋介紹（頁面 head() 與 sitemap.ts 共用這一支，答案才會一致）。
 *
 * 刊名**不含漢字**時不拿刊名判斷（傳 null）、只看介紹：既有規則「日文跟中文一字不差且超過
 * 15 字＝沒翻」是用來抓「中文原文貼進日文欄」的；「TOKYO COFFEE FESTIVAL」「We Work HERE
 * PAPER」這種英文專有名詞的刊名三語本來就相同，介紹也已經翻好，不該因此讓日文版 noindex。
 * 含漢字的刊名照既有規則（短的同名漢字刊名本來就算有翻）。
 */
export function publicationTranslationFields(entry: { title: Localized; intro: Localized }): {
  title: Localized | null;
  body: Localized[];
} {
  return { title: HAN.test(entry.title.zh) ? entry.title : null, body: [entry.intro] };
}

/** 頁面 head() 用：讀取失敗（null）→ "full"（那一頁是 503 頁殼）。 */
export function publicationTranslation(
  entry: { title: Localized; intro: Localized } | null,
): PageTranslation {
  return entry ? publicationTranslationFields(entry) : "full";
}

function crumbs(lang: Lang, self?: { name: string; path: string }) {
  const list = [
    { name: HOME_LABEL[lang], path: localizeHref("/", lang) },
    { name: PUBLICATIONS_LABEL[lang], path: localizeHref(PUBLICATIONS_PATH, lang) },
  ];
  if (self) list.push({ name: self.name, path: localizeHref(self.path, lang) });
  return list;
}

/** 總覽頁的麵包屑（首頁 › 地方刊物）。 */
export function publicationsIndexLd(lang: Lang): JsonLd[] {
  return [breadcrumbLd(crumbs(lang))];
}

function httpUrl(v: string | null): string | null {
  return v && /^https?:\/\//i.test(v.trim()) ? v.trim() : null;
}

/**
 * 刊物頁的 JSON-LD：Book（有商品再加 Product 與 offers）＋ BreadcrumbList。
 * 只放資料裡有的欄位；沒有封面就不輸出 image。
 */
export function publicationLd(opts: {
  entry: PublicationSeoInput;
  lang: Lang;
  image: string | null;
  offer: PublicationOffer | null;
}): JsonLd[] {
  const { entry, lang, offer } = opts;
  const path = publicationPath(entry.slug);
  const url = canonicalUrl(path, undefined, lang);
  const name = entry.title[lang] || entry.title.zh;
  const description = publicationDescription(entry);
  const image = absoluteUrl(opts.image);
  const site = httpUrl(entry.externalUrl);
  const book: JsonLd = {
    "@context": "https://schema.org",
    "@type": offer ? ["Book", "Product"] : "Book",
    "@id": `${url}#publication`,
    name,
    description: description[lang] || description.zh,
    url,
    ...(image ? { image: [image] } : {}),
    publisher: { "@type": "Organization", name: entry.publisher[lang] || entry.publisher.zh },
    ...(entry.region.trim()
      ? { spatialCoverage: { "@type": "Place", name: entry.region.trim() } }
      : {}),
    ...(site ? { sameAs: [site] } : {}),
    ...(offer
      ? {
          sku: offer.slug,
          offers: {
            "@type": "Offer",
            price: offer.price,
            priceCurrency: "TWD",
            availability: offer.inStock
              ? "https://schema.org/InStock"
              : "https://schema.org/OutOfStock",
            // 指向刊物頁本身（canonical）：商品頁的 canonical 也指回這裡，不給 Google 兩個網址。
            url,
            seller: { "@type": "Organization", "@id": ORG_ID, name: STORE_NAME },
          },
        }
      : {}),
  };
  return [book, breadcrumbLd(crumbs(lang, { name, path }))];
}

/**
 * 「同地區的其他刊物」：同一個國家、同一個粗分類（regionGroupOf），不含自己，最多 max 本。
 * 從這一本的下一本開始往後取、到尾再繞回前面——每一頁推薦的組合不同，內部連結分得比較開。
 * `all` 的順序就是總覽頁的順序（sort_order、seq）。
 */
export function relatedPublications<
  T extends { slug: string; sheet: PublicationSheet; region: string },
>(
  all: readonly T[],
  current: { slug: string; sheet: PublicationSheet; region: string },
  max = 6,
): T[] {
  const group = regionGroupOf(current);
  const same = all.filter((e) => e.sheet === current.sheet && regionGroupOf(e) === group);
  const at = same.findIndex((e) => e.slug === current.slug);
  const ordered = at < 0 ? same : [...same.slice(at + 1), ...same.slice(0, at)];
  return ordered.filter((e) => e.slug !== current.slug).slice(0, max);
}
