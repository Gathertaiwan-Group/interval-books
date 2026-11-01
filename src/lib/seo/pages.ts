/**
 * 詳情頁的 SEO 組裝（2026-11 SEO 健檢 H4／M1／M2）：title、description、分享圖、JSON-LD。
 *
 * 每一個欄位都從資料來（活動列、售票商品的場次與票種、商品列）——這裡只做「挑欄位、
 * 截字、套模板」，不新增任何事實。head() 與元件裡的 useDocumentMeta() 都呼叫同一支，
 * SSR 與瀏覽器渲染後的 title 才會一致。
 */
import { PRODUCT_TYPE_LABELS } from "@/components/shop/labels";
import type { Localized } from "@/i18n/types";
import type { EventDetailEntry } from "@/lib/cms";
import { isEventEnded } from "@/lib/event-status";
import { imageFor } from "@/lib/images";
import {
  isPlanAvailable,
  isSoldOut,
  remainingForSession,
  type ShopProduct,
  type ShopSession,
} from "@/lib/shop";
import {
  breadcrumbLd,
  canonicalUrl,
  eventLd,
  fitDescription,
  productLd,
  seoTitle,
  stripForeignBrandSuffix,
  type Crumb,
  type JsonLd,
  type LdSession,
  type StoreAddress,
} from "./core";

export type SeoBundle = {
  title: Localized;
  description: Localized;
  image: string | null;
  jsonLd: JsonLd[];
};

const HOME: Crumb = { name: "首頁", path: "/" };
const EVENTS: Crumb = { name: "活動", path: "/events" };
const SHOP: Crumb = { name: "選物", path: "/shop" };
const PUBLICATIONS: Crumb = { name: "地方刊物", path: "/shop?tab=publications" };

/**
 * 「摘要。內文」串成一段描述的素材（各語言分開），交給 fitDescription() 截到合理長度。
 * 內文常常以摘要的同一句開頭，所以後面的段落裡**已經出現過的句子**會被略過，
 * 不會出現「十月的池上…。十月的池上…」這種重複。
 */
function joinLocalized(...parts: Array<Localized | null | undefined>): Localized {
  const join = (lang: keyof Localized) => {
    const end = lang === "en" ? /(?<=[.!?])\s+/ : /(?<=[。！？!?])/;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of parts) {
      const text = (part?.[lang] || "").replace(/\s+/g, " ").trim();
      for (const raw of text.split(end)) {
        const sentence = raw.trim();
        if (!sentence || seen.has(sentence)) continue;
        seen.add(sentence);
        out.push(sentence);
      }
      // 句尾補標點，下一段才不會黏在一起
      const last = out.length - 1;
      if (last >= 0 && !/[。.!?！？]$/.test(out[last])) out[last] += lang === "en" ? "." : "。";
    }
    return out.join(lang === "en" ? " " : "");
  };
  return { zh: join("zh"), en: join("en"), ja: join("ja") };
}

/** ShopSession → JSON-LD 用的場次（可不可買沿用 shop.ts 的規則：名額＋販售期間）。 */
function ldSessions(sessions: ShopSession[]): LdSession[] {
  return sessions.map((s) => ({
    id: s.id,
    location: s.location.zh,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    available: remainingForSession(s) > 0,
    plans: s.plans.map((p) => ({
      name: p.title.zh,
      price: p.price,
      available: isPlanAvailable(p) && remainingForSession(s) >= Math.max(1, p.seatsPerUnit),
    })),
  }));
}

/**
 * 這場活動結束了沒（頁面報名區、JSON-LD 共用同一個答案）。規則是 event-status.ts 的
 * isEventEnded()——與 /events「已結束」分頁同一條。isoDate 只有詳情頁拿得到；著陸頁傳
 * null，改用售票商品的最晚場次。
 */
export function eventEnded(isoDate: string | null, product: ShopProduct | null): boolean {
  return isEventEnded(isoDate, product?.sessions ?? []);
}

/** root loader 的 site（SiteContent）→ JSON-LD 要的書店地址。沒有（讀取失敗）→ null。 */
export function storeAddressOf(
  site: { site?: { address?: Localized; city?: Localized } } | null | undefined,
): StoreAddress | null {
  const address = site?.site?.address?.zh?.trim() ?? "";
  const city = site?.site?.city?.zh?.trim() ?? "";
  return address || city ? { address, city } : null;
}

/**
 * 子路由的 head() 拿書店地址：root loader 讀的 site_settings 在 matches 的第一個 match 上
 * （root 的 head 用的是同一份）。找不到 → null（JSON-LD 只輸出 addressCountry，不猜）。
 */
export function storeAddressFromMatches(
  matches: ReadonlyArray<{ loaderData?: unknown }> | undefined,
): StoreAddress | null {
  for (const m of matches ?? []) {
    const data = m?.loaderData as { site?: Parameters<typeof storeAddressOf>[0] } | undefined;
    if (data?.site) return storeAddressOf(data.site);
  }
  return null;
}

/** /events/$slug。event 為 null（讀取失敗）時回頁面層的預設值，沒有 JSON-LD。 */
export function eventSeo(
  event: EventDetailEntry | null,
  product: ShopProduct | null,
  fallback: { metaTitle: Localized; metaDescription: Localized },
  store: StoreAddress | null = null,
): SeoBundle {
  if (!event) {
    return {
      title: fallback.metaTitle,
      description: fallback.metaDescription,
      image: null,
      jsonLd: [],
    };
  }
  const path = `/events/${event.slug}`;
  const url = canonicalUrl(path);
  const description = fitDescription(joinLocalized(event.summary, event.description));
  const image = event.imageKey ? imageFor(event.imageKey, "") : null;
  const name = stripForeignBrandSuffix(event.title.zh);
  return {
    title: seoTitle(event.title, event.date || null),
    description,
    image,
    jsonLd: [
      ...eventLd({
        name,
        description: description.zh,
        url,
        image,
        sessions: product ? ldSessions(product.sessions) : [],
        basePrice: product ? product.price : null,
        performer: event.speaker?.name || null,
        ended: eventEnded(event.isoDate, product),
        store,
      }),
      breadcrumbLd([HOME, EVENTS, { name, path }]),
    ],
  };
}

/**
 * 寫死在程式碼裡的活動著陸頁（/events/kungtung、/events/sound-of-the-sea、
 * /events/city-salon-0922）。名稱與描述用頁面自己的 PAGE 常數，日期、地點、價格用
 * 售票商品的場次——跟頁面上報名區印的是同一份資料。
 */
export function landingEventLd(opts: {
  path: string;
  name: string;
  description: string;
  imageKey: string | null;
  product: ShopProduct | null;
  performer?: string | null;
  store?: StoreAddress | null;
}): JsonLd[] {
  const image = opts.imageKey ? imageFor(opts.imageKey, "") : null;
  return [
    ...eventLd({
      name: opts.name,
      description: opts.description,
      url: canonicalUrl(opts.path),
      image,
      sessions: opts.product ? ldSessions(opts.product.sessions) : [],
      basePrice: opts.product ? opts.product.price : null,
      performer: opts.performer ?? null,
      ended: eventEnded(null, opts.product),
      store: opts.store ?? null,
    }),
    breadcrumbLd([HOME, EVENTS, { name: opts.name, path: opts.path }]),
  ];
}

/** 著陸頁子頁（主理人介紹）的麵包屑：首頁 › 活動 › 著陸頁 › 這一頁。 */
export function landingSubpageLd(parent: Crumb, self: Crumb): JsonLd[] {
  return [breadcrumbLd([HOME, EVENTS, parent, self])];
}

/** 地方刊物（pub-*）在 /shop 的分頁裡，類別名稱跟著分頁叫「地方刊物」。 */
function isPublication(product: ShopProduct): boolean {
  return product.productType === "book" && product.slug.startsWith("pub-");
}

const PUBLICATION_LABEL: Localized = {
  zh: "地方刊物",
  en: "Local Publications",
  ja: "地域の刊行物",
};

/** /shop/$slug。product 為 null（讀取失敗）時回頁面層的預設值，沒有 JSON-LD。 */
export function productSeo(
  product: ShopProduct | null,
  fallback: { metaTitle: Localized; metaDescription: Localized },
  fallbackImage: string,
): SeoBundle {
  if (!product) {
    return {
      title: fallback.metaTitle,
      description: fallback.metaDescription,
      image: fallbackImage,
      jsonLd: [],
    };
  }
  const path = `/shop/${product.slug}`;
  const pub = isPublication(product);
  const category = pub ? PUBLICATION_LABEL : PRODUCT_TYPE_LABELS[product.productType];
  const description = fitDescription(joinLocalized(product.summary, product.description));
  const image = imageFor(product.imageKey, fallbackImage);
  const name = product.title.zh;
  return {
    title: seoTitle(product.title, category),
    description,
    image,
    jsonLd: [
      productLd({
        name,
        description: description.zh,
        url: canonicalUrl(path),
        image: product.imageKey ? image : null,
        sku: product.slug,
        price: product.price,
        inStock: !isSoldOut(product),
        isBook: product.productType === "book",
        category: category.zh,
      }),
      breadcrumbLd(pub ? [HOME, SHOP, PUBLICATIONS, { name, path }] : [HOME, SHOP, { name, path }]),
    ],
  };
}
