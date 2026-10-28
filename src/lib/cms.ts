/**
 * Content layer: reads every piece of site copy from Supabase, with the
 * in-repo constants (src/data/content.ts + src/i18n/strings.ts) as fallback.
 *
 * Design notes
 *  - Every translatable column is jsonb shaped {zh, en, ja}, identical to the
 *    `Localized` type, so rows are handed to `t()` with no transformation.
 *  - snake_case columns are normalised to the camelCase names the components
 *    already use. Two renames come from the schema: description (TS `desc`)
 *    and display_date (TS `date`).
 *  - Nothing here throws. Any network/permission failure degrades to the
 *    bundled fallback so the site never white-screens on a DB hiccup.
 *  - Called exclusively from TanStack Router loaders, which run on the server
 *    during SSR — the rendered HTML therefore carries the real content.
 */
import { supabase } from "@/lib/supabase";
import type { Localized } from "@/i18n/types";
import { EVENT_LIST_FIELDS, type EventListField } from "@/lib/event-blocks";
import { excludeJourneyEvents } from "@/lib/journey-events";
import { latestSessionEndDate } from "@/lib/event-status";
import { eventProductSlug } from "@/lib/shop";
import {
  UI,
  SITE_INFO,
  CONTACT_EMAIL,
  CONTACT_PHONES,
  SITE_URL,
  SOCIAL,
  MAP,
} from "@/i18n/strings";
import {
  events as staticEvents,
  journeys as staticJourneys,
  news as staticNews,
  curatedThemes as staticCuratedThemes,
  collaborations as staticCollaborations,
} from "@/data/content";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * 「一行一項」清單欄位（0027）的三語值。與 Localized 的差別只在值是字串陣列。
 * 缺語系一律給空陣列，呼叫端不必再判斷 undefined。
 */
export type LocalizedList = { zh: string[]; en: string[]; ja: string[] };

export type UiStrings = {
  brand: Localized;
  brandSub: Localized;
  nav: Record<string, Localized>;
  footer: Record<string, Localized>;
  buttons: Record<string, Localized>;
  sections: Record<string, Localized>;
  notFound: Record<string, Localized>;
};

export type SiteContent = {
  ui: UiStrings;
  site: {
    shortDesc: Localized;
    address: Localized;
    city: Localized;
    hours: Localized;
    closed: Localized;
  };
  contactEmail: string;
  siteUrl: string;
  phones: { label: string; display: string; tel: string }[];
  social: { instagram: string; facebook: string; line: string };
  map: { embed: string; link: string; apple: string };
  meta: {
    siteName: string;
    author: string;
    twitterCard: string;
    ogType: string;
    defaultTitle: string;
    defaultDescription: string;
  };
};

export type PageListEntry = {
  label: Localized;
  note: Localized | null;
  imageKey: string | null;
};

export type PageContent = {
  slug: string;
  metaTitle: Localized;
  metaDescription: Localized;
  ogTitle: Localized | null;
  ogDescription: Localized | null;
  ogImageKey: string | null;
  eyebrowPrefix: string | null;
  eyebrowSuffix: Localized | null;
  headerTitle: Localized | null;
  headerIntro: Localized | null;
  blocks: Record<string, Localized>;
  lists: Record<string, PageListEntry[]>;
};

export type EventEntry = {
  id: string;
  /**
   * 網址代稱（0026）。/events/<slug> 就是它。
   *
   * ⚠️ 列表頁**必須**用這一欄連過去，不可以用 id。0026 把 slug 回填成 id，所以
   *    今天兩者相等；一旦有人在後台把代稱改成好看的名字，用 id 連出去的每一條
   *    連結就會 404。bundled fallback 沒有這一欄，退回成 id（見 FALLBACK_EVENTS）。
   */
  slug: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  /**
   * 封面圖 key（0026）。null = 沒設。
   *
   * ⚠️ 呼叫端**必須先判斷它非空再呼叫 imageFor()** —— imageFor(key, fallback)
   *    永遠會回一張圖，順序反過來就是「每一場活動都長同一張不相干的照片」。
   */
  imageKey: string | null;
  /**
   * 活動日期（events.iso_date）。null = 還沒定日期（display_date 可能是「即將公告」）。
   *
   * ⚠️ 這一欄唯一的用途是判斷「已結束」（見 src/lib/event-status.ts）。**畫面上
   *    給人看的日期是 `date`（display_date）**，那是自由文字、可以寫「2026.5.30~5.31」
   *    這種範圍。兩者不可以互換。
   */
  isoDate: string | null;
  /**
   * 這場活動售票商品（products.slug = `event-<slug>`）上，最晚那一場**開放中**場次的
   * 結束日（台北 YYYY-MM-DD）。null = 沒有場次／讀不到。
   *
   * 只給 isEventPast() 用：還有今天或之後的場次，iso_date 填錯了也不算已結束
   * （見 src/lib/event-status.ts）。只有 fetchEvents() 會填；其他來源一律 null。
   */
  lastSessionDate: string | null;
  date: string;
  category: string;
  externalUrl: string;
};

export type EventCategoryEntry = { id: string; label: Localized };

/** Mirrors the events_registration_type_valid CHECK in 0001_init.sql. */
export type EventRegistrationType = "external" | "internal";

/**
 * 講者介紹，只有活動詳情頁需要。null＝這場活動沒有指定講者，或指定的講者已被
 * 停用（public.artists 的 RLS 只讓 anon/authenticated 讀 is_active 的列，見
 * 0019_vendors_pii_portal.sql）——兩種情況前台都是同一個結果：這一頁不畫
 * 講者區。
 *
 * 欄位對應到 public.artists：discipline 當「頭銜」、long_bio 優先於 bio 當
 * 「簡介內文」（跟這一頁 summary/description 的「短句在標題旁、長文在下面」是
 * 同一個決定）。bio/discipline 是純字串不是三語 —— 見
 * src/server/repos/artists.ts 檔頭，這裡不重新發明三語慣例。
 */
export type EventSpeaker = {
  name: string;
  /** artists.discipline，例如「陶藝家」。空字串＝沒有頭銜可顯示。 */
  title: string;
  /** artists.long_bio，退回 artists.bio。空字串＝沒有簡介可顯示。 */
  bio: string;
  /** ⚠️ 呼叫端一樣要先判斷非空再呼叫 imageFor() —— 規則與 imageKey 相同。 */
  imageKey: string | null;
};

/**
 * One event, as the detail page needs it. Adds 列表頁用不到的三塊：
 * `registrationType`（決定報名按鈕連去哪）、`galleryKeys`（相簿）、`speaker`
 * （講者介紹）。
 *
 * ⚠️ imageKey 這一欄在 EventEntry 上一直都是真的（首頁的活動卡片會畫封面），
 *    但詳情頁在這一期之前刻意不畫——select 都不帶 image_key，mapping 直接給
 *    null，理由是 imageFor(key, fallback) 永遠會回*某一張*圖，對還沒設圖的
 *    活動渲染封面得到的不是「沒有封面」，是每場活動都長一樣的灰框佔位。這一期
 *    改成畫大圖，做法是「先判斷 imageKey 非空再呼叫 imageFor()」——見
 *    src/routes/events.$slug.tsx——不是把判斷拿掉。scripts/event-detail-page-selftest.mjs
 *    的 [5] 從這一期起改成守「有判斷才呼叫」，不再是「完全不呼叫」。
 *
 * galleryKeys 與 speaker 用同一條規則：陣列空／物件是 null 就代表這一頁不畫
 * 那一塊，不是「還沒填」與「空框」之間的模糊地帶。
 */
export type EventDetailEntry = EventEntry & {
  registrationType: EventRegistrationType;
  /** events.gallery_keys（0031）。空陣列＝沒有相簿，這一頁不畫相簿區。 */
  galleryKeys: string[];
  /** null＝沒有講者，這一頁不畫講者區。見 EventSpeaker 的欄位對應說明。 */
  speaker: EventSpeaker | null;
  /**
   * 活動頁的「一行一項」清單區塊（0027）。名單與順序的唯一真相是
   * src/lib/event-blocks.ts 的 EVENT_LIST_FIELDS —— 那個陣列的順序就是前台由上
   * 到下的順序，想調換區塊順序改那裡，不要改這裡或 events.$slug.tsx。
   *
   * ⚠️ 空陣列＝那一塊**不印**，而不是印一個只有標題的空區塊。bundled fallback
   *    沒有這些欄位，一律退回空陣列。
   */
  lists: Record<EventListField, LocalizedList>;
};

/**
 * `event: null` with `unavailable: false` means the id really is not there (or
 * the row is unpublished, which RLS makes indistinguishable — see the
 * events_select_public policy in 0001). `unavailable: true` means we could not
 * tell. Callers must 404 only on the first.
 */
export type EventDetailResult = {
  event: EventDetailEntry | null;
  unavailable: boolean;
};

export type JourneyEntry = {
  id: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  days: Localized;
  theme: Localized;
  externalUrl: string;
};

export type NewsEntry = {
  id: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  date: string;
};

export type CuratedThemeEntry = {
  id: string;
  title: Localized;
  description: Localized;
  items: { name: Localized; note: Localized }[];
};

export type CollaborationEntry = {
  id: string;
  title: Localized;
  description: Localized;
};

// -----------------------------------------------------------------------------
// Fallbacks (bundled copy — used when Supabase is unreachable or misconfigured)
// -----------------------------------------------------------------------------

const NOT_FOUND_FALLBACK: Record<string, Localized> = {
  title: { zh: "頁面尚未開放", en: "Page not found", ja: "ページが見つかりません" },
};

function staticUi(): UiStrings {
  return {
    brand: { ...UI.brand },
    brandSub: { ...UI.brandSub },
    nav: { ...UI.nav },
    footer: { ...UI.footer },
    buttons: { ...UI.buttons },
    sections: { ...UI.sections },
    notFound: { ...NOT_FOUND_FALLBACK },
  };
}

export const FALLBACK_SITE_CONTENT: SiteContent = {
  ui: staticUi(),
  site: {
    shortDesc: SITE_INFO.shortDesc,
    address: SITE_INFO.address,
    city: SITE_INFO.city,
    hours: SITE_INFO.hours,
    closed: SITE_INFO.closed,
  },
  contactEmail: CONTACT_EMAIL,
  siteUrl: SITE_URL,
  phones: CONTACT_PHONES.map((p) => ({ label: p.label, display: p.display, tel: p.tel })),
  social: { ...SOCIAL },
  map: { ...MAP },
  meta: {
    siteName: "小時光書店 Interval Books",
    author: "小時光書店 Interval Books",
    twitterCard: "summary_large_image",
    ogType: "website",
    defaultTitle: "小時光書店 Interval Books｜風土誌策展的閱讀與生活場域",
    defaultDescription:
      "我們是在華山的小時光書店，聽得到鳥鳴，聞得到茶香與書香，感受得到人情的溫度與連結。",
  },
};

export const FALLBACK_EVENTS: EventEntry[] = staticEvents.map((e) => ({
  id: e.id,
  // bundled 種子沒有 slug 欄位。退回 id 是對的：0026 就是這樣回填正式庫的。
  slug: e.id,
  // bundled 種子也沒有封面。null 的意思是「不要畫封面」，不是「畫一張預設圖」。
  imageKey: null,
  // bundled 種子沒有 iso_date —— 判不出結束與否，一律留在進行中。
  isoDate: null,
  lastSessionDate: null,
  title: e.title,
  summary: e.summary,
  description: e.description,
  date: e.date,
  category: e.category,
  externalUrl: e.externalUrl,
}));

export const FALLBACK_EVENT_CATEGORIES: EventCategoryEntry[] = [
  { id: "讀書會", label: { zh: "讀書會", en: "Reading Circles", ja: "読書会" } },
  { id: "療癒生活節", label: { zh: "療癒生活節", en: "Healing Festival", ja: "ヒーリング祭" } },
  { id: "策旅說明會", label: { zh: "策旅說明會", en: "Journey Briefings", ja: "旅の説明会" } },
  {
    id: "陶藝家展售",
    label: { zh: "陶藝家展售", en: "Ceramicist Showcases", ja: "陶芸家の展示販売" },
  },
  {
    id: "身心靈工作坊",
    label: { zh: "身心靈工作坊", en: "Mind & Body Workshops", ja: "心身ワークショップ" },
  },
  { id: "好書交流", label: { zh: "好書交流", en: "Book Exchange", ja: "本の交流" } },
];

export const FALLBACK_JOURNEYS: JourneyEntry[] = staticJourneys.map((j) => ({
  id: j.id,
  title: j.title,
  summary: j.summary,
  description: j.description,
  days: j.days,
  theme: j.theme,
  externalUrl: j.externalUrl,
}));

export const FALLBACK_NEWS: NewsEntry[] = staticNews.map((n) => ({
  id: n.id,
  title: n.title,
  summary: n.summary,
  description: n.description,
  date: n.date,
}));

export const FALLBACK_CURATED_THEMES: CuratedThemeEntry[] = staticCuratedThemes.map((c) => ({
  id: c.id,
  title: c.title,
  description: c.description,
  items: c.items.map((i) => ({ name: i.name, note: i.note })),
}));

export const FALLBACK_COLLABORATIONS: CollaborationEntry[] = staticCollaborations.map((c, i) => ({
  id: `co-${i + 1}`,
  title: c.title,
  description: c.desc,
}));

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

type Row = Record<string, unknown>;

function isLocalized(v: unknown): v is Localized {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.zh === "string" && typeof o.en === "string" && typeof o.ja === "string";
}

/** Accepts a jsonb column, returns it only when it really carries zh/en/ja. */
function loc(v: unknown): Localized | null {
  return isLocalized(v) ? { zh: v.zh, en: v.en, ja: v.ja } : null;
}

function locOr(v: unknown, fallback: Localized): Localized {
  return loc(v) ?? fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function nullableStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

type SelectOptions = {
  /** Column to sort by (ascending). */
  order?: string;
  /** Restricts the query to rows where `eq[0]` equals `eq[1]`. */
  eq?: [column: string, value: string];
  /**
   * Restricts the query to rows where `in[0]` is one of `in[1]`.
   * Additive (2026-09) — fetchPages() below is the only caller so far; every
   * existing `select()` call only ever passed `eq`/`order` and is unaffected.
   */
  in?: [column: string, values: string[]];
};

/** Runs a PostgREST query, returning null instead of throwing on any failure. */
async function select(
  table: string,
  columns: string,
  options: SelectOptions = {},
): Promise<Row[] | null> {
  const db = supabase;
  if (!db) return null;
  try {
    let query = db.from(table).select(columns);
    if (options.eq) query = query.eq(options.eq[0], options.eq[1]);
    if (options.in) query = query.in(options.in[0], options.in[1]);
    if (options.order) query = query.order(options.order, { ascending: true });
    const { data, error } = await query;
    if (error || !Array.isArray(data)) {
      if (error) logFailure(table, error.message);
      return null;
    }
    return data as unknown as Row[];
  } catch (err) {
    logFailure(table, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function logFailure(table: string, message: string) {
  // Surfaced in the server log; the caller has already fallen back to bundled copy.
  console.warn(`[cms] ${table} unavailable, using bundled fallback — ${message}`);
}

// -----------------------------------------------------------------------------
// Site-wide content (root route loader)
// -----------------------------------------------------------------------------

function buildUi(rows: Row[]): UiStrings {
  const ui = staticUi();
  for (const row of rows) {
    const group = str(row.group_key);
    const key = str(row.string_key);
    const value = loc(row.value);
    if (!group || !key || !value) continue;

    if (group === "brand") {
      if (key === "brand") ui.brand = value;
      else if (key === "brandSub") ui.brandSub = value;
      continue;
    }
    if (
      group === "nav" ||
      group === "footer" ||
      group === "buttons" ||
      group === "sections" ||
      group === "notFound"
    ) {
      ui[group][key] = value;
    }
  }
  return ui;
}

export async function fetchSiteContent(): Promise<SiteContent> {
  const [settingsRows, uiRows, phoneRows] = await Promise.all([
    select(
      "site_settings",
      "short_desc,address,city,hours,closed,contact_email,site_url,social_instagram,social_facebook,social_line,map_embed,map_link,map_apple,meta_site_name,meta_author,meta_twitter_card,meta_og_type,default_meta_title,default_meta_description",
    ),
    select("ui_strings", "group_key,string_key,value,sort_order", { order: "sort_order" }),
    select("contact_phones", "label,display_text,tel,sort_order", { order: "sort_order" }),
  ]);

  const settings = settingsRows?.[0];
  if (!settings && !uiRows && !phoneRows) return FALLBACK_SITE_CONTENT;

  const fb = FALLBACK_SITE_CONTENT;

  return {
    ui: uiRows ? buildUi(uiRows) : fb.ui,
    site: settings
      ? {
          shortDesc: locOr(settings.short_desc, fb.site.shortDesc),
          address: locOr(settings.address, fb.site.address),
          city: locOr(settings.city, fb.site.city),
          hours: locOr(settings.hours, fb.site.hours),
          closed: locOr(settings.closed, fb.site.closed),
        }
      : fb.site,
    contactEmail: settings ? str(settings.contact_email, fb.contactEmail) : fb.contactEmail,
    siteUrl: settings ? str(settings.site_url, fb.siteUrl) : fb.siteUrl,
    phones:
      phoneRows && phoneRows.length
        ? phoneRows.map((p) => ({
            label: str(p.label),
            display: str(p.display_text),
            tel: str(p.tel),
          }))
        : fb.phones,
    social: settings
      ? {
          instagram: str(settings.social_instagram),
          facebook: str(settings.social_facebook),
          line: str(settings.social_line),
        }
      : fb.social,
    map: settings
      ? {
          embed: str(settings.map_embed, fb.map.embed),
          link: str(settings.map_link, fb.map.link),
          apple: str(settings.map_apple, fb.map.apple),
        }
      : fb.map,
    meta: settings
      ? {
          siteName: str(settings.meta_site_name, fb.meta.siteName),
          author: str(settings.meta_author, fb.meta.author),
          twitterCard: str(settings.meta_twitter_card, fb.meta.twitterCard),
          ogType: str(settings.meta_og_type, fb.meta.ogType),
          defaultTitle: str(settings.default_meta_title, fb.meta.defaultTitle),
          defaultDescription: str(settings.default_meta_description, fb.meta.defaultDescription),
        }
      : fb.meta,
  };
}

// -----------------------------------------------------------------------------
// Per-page content (pages + page_blocks + page_list_items)
// -----------------------------------------------------------------------------

export async function fetchPage(slug: string): Promise<PageContent | null> {
  const [pageRows, blockRows, listRows] = await Promise.all([
    select(
      "pages",
      "slug,meta_title,meta_description,og_title,og_description,og_image_key,eyebrow_prefix,eyebrow_suffix,header_title,header_intro",
      { eq: ["slug", slug] },
    ),
    select("page_blocks", "block_key,value,sort_order", {
      eq: ["page_slug", slug],
      order: "sort_order",
    }),
    select("page_list_items", "list_key,label,note,image_key,sort_order", {
      eq: ["page_slug", slug],
      order: "sort_order",
    }),
  ]);

  const page = pageRows?.[0];
  if (!page) return null;

  const metaTitle = loc(page.meta_title);
  const metaDescription = loc(page.meta_description);
  if (!metaTitle || !metaDescription) return null;

  const blocks: Record<string, Localized> = {};
  for (const row of blockRows ?? []) {
    const key = str(row.block_key);
    const value = loc(row.value);
    if (key && value) blocks[key] = value;
  }

  const lists: Record<string, PageListEntry[]> = {};
  for (const row of listRows ?? []) {
    const key = str(row.list_key);
    const label = loc(row.label);
    if (!key || !label) continue;
    (lists[key] ??= []).push({
      label,
      note: loc(row.note),
      imageKey: nullableStr(row.image_key),
    });
  }

  return {
    slug: str(page.slug, slug),
    metaTitle,
    metaDescription,
    ogTitle: loc(page.og_title),
    ogDescription: loc(page.og_description),
    ogImageKey: nullableStr(page.og_image_key),
    eyebrowPrefix: nullableStr(page.eyebrow_prefix),
    eyebrowSuffix: loc(page.eyebrow_suffix),
    headerTitle: loc(page.header_title),
    headerIntro: loc(page.header_intro),
    blocks,
    lists,
  };
}

/**
 * Batched counterpart of fetchPage() — one round trip per table (three total)
 * instead of one round trip per table *per slug*. Written for
 * src/routes/shop.index.tsx, whose loader used to call fetchPage() three
 * times (shop/publications/curated) — nine Supabase round trips for page
 * copy alone, on every single /shop request.
 *
 * Deliberately NOT implemented by extracting fetchPage()'s row-mapping into a
 * helper shared with fetchPage() itself: fetchPage() is called from nearly
 * every route on the site (home, events, about, privacy, journeys...), and
 * this addition only needs to serve /shop. Keeping fetchPage() byte-for-byte
 * unchanged means none of its other ~20 callers can be touched by this
 * change, at the cost of toPageContent() below duplicating (not sharing)
 * fetchPage()'s row->PageContent mapping. If the pages/page_blocks/
 * page_list_items column list ever changes, both functions need the same
 * edit — grep for `og_description` to find both call sites.
 *
 * Failure semantics match fetchPage() *per slug*: a slug whose `pages` row is
 * missing (or has no title/description, same guard as fetchPage()) maps to
 * `null` in the returned record — exactly what a single fetchPage(slug) call
 * would have returned for it — so one bad or missing page can never drag the
 * other requested slugs down with it. All three reads finish (or fail) before
 * any per-slug mapping runs, so there is no scenario where slug A's outcome
 * depends on slug B's row being well-formed.
 */
export async function fetchPages(slugs: string[]): Promise<Record<string, PageContent | null>> {
  const unique = [...new Set(slugs)];
  if (unique.length === 0) return {};

  const [pageRows, blockRows, listRows] = await Promise.all([
    select(
      "pages",
      "slug,meta_title,meta_description,og_title,og_description,og_image_key,eyebrow_prefix,eyebrow_suffix,header_title,header_intro",
      { in: ["slug", unique] },
    ),
    select("page_blocks", "page_slug,block_key,value,sort_order", {
      in: ["page_slug", unique],
      order: "sort_order",
    }),
    select("page_list_items", "page_slug,list_key,label,note,image_key,sort_order", {
      in: ["page_slug", unique],
      order: "sort_order",
    }),
  ]);

  const blocksBySlug = new Map<string, Row[]>();
  for (const row of blockRows ?? []) {
    const pageSlug = str(row.page_slug);
    if (!pageSlug) continue;
    const bucket = blocksBySlug.get(pageSlug) ?? [];
    bucket.push(row);
    blocksBySlug.set(pageSlug, bucket);
  }

  const listsBySlug = new Map<string, Row[]>();
  for (const row of listRows ?? []) {
    const pageSlug = str(row.page_slug);
    if (!pageSlug) continue;
    const bucket = listsBySlug.get(pageSlug) ?? [];
    bucket.push(row);
    listsBySlug.set(pageSlug, bucket);
  }

  const result: Record<string, PageContent | null> = {};
  for (const slug of unique) {
    const page = (pageRows ?? []).find((r) => str(r.slug) === slug);
    result[slug] = page
      ? toPageContent(slug, page, blocksBySlug.get(slug) ?? [], listsBySlug.get(slug) ?? [])
      : null;
  }
  return result;
}

/**
 * Row(s) -> PageContent. Used only by fetchPages() above — see that
 * function's comment for why this is a separate copy of fetchPage()'s
 * mapping rather than a shared extraction.
 */
function toPageContent(
  slug: string,
  page: Row,
  blockRows: Row[],
  listRows: Row[],
): PageContent | null {
  const metaTitle = loc(page.meta_title);
  const metaDescription = loc(page.meta_description);
  if (!metaTitle || !metaDescription) return null;

  const blocks: Record<string, Localized> = {};
  for (const row of blockRows) {
    const key = str(row.block_key);
    const value = loc(row.value);
    if (key && value) blocks[key] = value;
  }

  const lists: Record<string, PageListEntry[]> = {};
  for (const row of listRows) {
    const key = str(row.list_key);
    const label = loc(row.label);
    if (!key || !label) continue;
    (lists[key] ??= []).push({
      label,
      note: loc(row.note),
      imageKey: nullableStr(row.image_key),
    });
  }

  return {
    slug: str(page.slug, slug),
    metaTitle,
    metaDescription,
    ogTitle: loc(page.og_title),
    ogDescription: loc(page.og_description),
    ogImageKey: nullableStr(page.og_image_key),
    eyebrowPrefix: nullableStr(page.eyebrow_prefix),
    eyebrowSuffix: loc(page.eyebrow_suffix),
    headerTitle: loc(page.header_title),
    headerIntro: loc(page.header_intro),
    blocks,
    lists,
  };
}

/**
 * Field-level accessors over a page row. Every getter takes the bundled copy as
 * a fallback, so a missing row — or a single missing block — degrades to what
 * shipped in the repo instead of rendering an empty page.
 */
export function pageText(page: PageContent | null) {
  return {
    block: (key: string, fallback: Localized): Localized => page?.blocks[key] ?? fallback,
    /** Localized labels of a page_list_items list. */
    list: (key: string, fallback: Localized[]): Localized[] => {
      const rows = page?.lists[key];
      return rows && rows.length ? rows.map((r) => r.label) : fallback;
    },
    /** Full rows (label + note + imageKey) of a page_list_items list. */
    rows: (key: string, fallback: PageListEntry[]): PageListEntry[] => {
      const rows = page?.lists[key];
      return rows && rows.length ? rows : fallback;
    },
    title: (fallback: Localized): Localized => page?.headerTitle ?? fallback,
    intro: (fallback: Localized): Localized => page?.headerIntro ?? fallback,
    metaTitle: (fallback: Localized): Localized => page?.metaTitle ?? fallback,
    metaDescription: (fallback: Localized): Localized => page?.metaDescription ?? fallback,
    ogTitle: (fallback: Localized): Localized => page?.ogTitle ?? fallback,
  };
}

/** Joins the Latin eyebrow prefix with its localized suffix, e.g. "Visit ／ 來店資訊". */
export function eyebrowOf(page: PageContent | null, prefix: string, suffix: string | null): string {
  const p = page?.eyebrowPrefix ?? prefix;
  if (!suffix) return p;
  return `${p}  ／  ${suffix}`;
}

// -----------------------------------------------------------------------------
// Collections
// -----------------------------------------------------------------------------

/**
 * /events 列表與首頁「精選活動」用的活動清單 —— **已經拿掉策旅**。
 *
 * 🔴 策旅的報名掛在一場活動上（events 一列＋journeys 一張卡片連過去），所以 events 表
 *    裡混著策旅。它們只該出現在 /journeys 與首頁策旅區；判準與理由見
 *    src/lib/journey-events.ts。在資料層濾掉（不是在某一頁 filter），兩個呼叫端
 *    因此不會一個記得、一個忘記。/events/<slug> 詳情頁走 fetchEventBySlug，不受影響。
 */
export async function fetchEvents(): Promise<EventEntry[]> {
  const [events, journeyRows] = await Promise.all([
    fetchAllEventRows(),
    select("journeys", "external_url"),
  ]);
  const journeyUrls = journeyRows
    ? journeyRows.map((r) => str(r.external_url))
    : FALLBACK_JOURNEYS.map((j) => j.externalUrl);
  return excludeJourneyEvents(events, journeyUrls);
}

async function fetchAllEventRows(): Promise<EventEntry[]> {
  const rows = await select(
    "events",
    "id,slug,title,summary,description,display_date,iso_date,category,external_url,image_key,sort_order",
    { order: "sort_order" },
  );
  if (!rows || !rows.length) return FALLBACK_EVENTS;
  const mapped: EventEntry[] = [];
  for (const r of rows) {
    const title = loc(r.title);
    const summary = loc(r.summary);
    const description = loc(r.description);
    if (!title || !summary || !description) continue;
    mapped.push({
      id: str(r.id),
      // 0026 之後 slug 是 not null，所以 str() 拿到的一定是真的值；|| id 是給
      // 「migration 還沒套上、這一列還沒有 slug」那一段時間的最後一道防線 ——
      // 空字串連出去會變成 /events/，那比連到舊網址更糟。
      slug: str(r.slug) || str(r.id),
      title,
      summary,
      description,
      date: str(r.display_date),
      category: str(r.category),
      externalUrl: str(r.external_url),
      imageKey: nullableStr(r.image_key),
      isoDate: nullableStr(r.iso_date),
      lastSessionDate: null,
    });
  }
  if (!mapped.length) return FALLBACK_EVENTS;
  return await attachLastSessionDates(mapped);
}

/**
 * /journeys「過往策旅」用：每場活動判斷「已結束」與畫卡片所需的最少欄位。
 *
 * journeys 表沒有日期，一趟策旅的日期與場次在它指向的那一列 events 上（見
 * src/lib/journey-events.ts、src/lib/past-shelf.ts）。只 select 用得到的欄位，
 * 場次結束日與 fetchEvents() 同一支 attachLastSessionDates()（同一條「已結束」規則）。
 * 讀取失敗 → 空陣列：沒有任何策旅會被判成已結束，/journeys 退回原本的樣子。
 */
export type JourneyEventDateRow = {
  slug: string;
  externalUrl: string;
  date: string;
  isoDate: string | null;
  imageKey: string | null;
  lastSessionDate: string | null;
};

export async function fetchJourneyEventDates(): Promise<JourneyEventDateRow[]> {
  const rows = await select("events", "slug,external_url,display_date,iso_date,image_key");
  if (!rows || !rows.length) return [];
  const mapped: JourneyEventDateRow[] = rows
    .map((r) => ({
      slug: str(r.slug),
      externalUrl: str(r.external_url),
      date: str(r.display_date),
      isoDate: nullableStr(r.iso_date),
      imageKey: nullableStr(r.image_key),
      lastSessionDate: null,
    }))
    .filter((r) => r.slug);
  return await attachLastSessionDates(mapped);
}

/**
 * 替每場活動補上 lastSessionDate —— 一次查詢：售票商品（`event-<slug>`）連同它的
 * 場次一起 embed 回來（event_sessions.product_id → products.id 的外鍵）。
 *
 * anon 讀得到的只有 active 商品的 open 場次（0020 的 RLS），這正是「還在賣」的意思。
 * 讀取失敗 → 原樣回傳（lastSessionDate 全是 null），也就是退回 iso_date 的舊規則：
 * 這一步只能讓活動**多留**在報名中，所以失敗不需要比舊行為更保守。
 */
async function attachLastSessionDates<T extends { slug: string; lastSessionDate: string | null }>(
  events: T[],
): Promise<T[]> {
  const bySlug = new Map(events.map((e) => [eventProductSlug(e.slug), e]));
  const rows = await select("products", "slug,event_sessions(starts_at,ends_at)", {
    in: ["slug", [...bySlug.keys()]],
  });
  if (!rows) return events;
  for (const r of rows) {
    const event = bySlug.get(str(r.slug));
    const sessions = Array.isArray(r.event_sessions) ? (r.event_sessions as Row[]) : [];
    if (!event) continue;
    event.lastSessionDate = latestSessionEndDate(
      sessions.map((s) => ({ startsAt: nullableStr(s.starts_at), endsAt: nullableStr(s.ends_at) })),
    );
  }
  return events;
}

/**
 * One event for /events/$slug.
 *
 * ── slug 這一欄在 0026 落地了 ────────────────────────────────────────────────
 * 這裡原本查的是 events.id，因為 public.events 沒有 slug 欄位。當時寫下的計畫是
 * 「之後補上 events.slug 時用 `slug = id` 回填，於是今天發出去的網址仍然有效，
 * 要改的只有 `.eq("id", slug)` → `.eq("slug", slug)`」。
 *
 * supabase/migrations/0026_event_product_link.sql 就是那一支，而且它真的照
 * `slug = id` 回填。所以這一行現在查 slug，**而在 0026 之前發出去的每一個網址仍然
 * 指到同一場活動**。
 *
 * ⚠️ 從這一刻起，「在後台改代稱」＝「讓已經發出去的那個網址 404」。那句警告寫在
 *    0026 的檔頭與後台的 slug 欄位說明上。
 *
 * ── 為什麼這一支不走本檔的 select() ──────────────────────────────────────────
 * 本檔的 select() 把每一種失敗都吞成 null，因為站台文案有 in-repo fallback。
 * 詳情頁沒有：如果讀取失敗與「查無此活動」都收斂成同一個 null，路由就只能二選一
 * ——要嘛把資料庫打嗝當成 404 告訴爬蟲這場活動不存在，要嘛對真的不存在的網址
 * 回 200。所以這裡照 src/lib/shop.ts#fetchActiveProductBySlug 的做法回報
 * `unavailable`，讓路由自己分。它仍然不 throw，這一點與本檔其他函式一致。
 *
 * 也刻意**不**退回 FALLBACK_EVENTS：那份 bundled 資料是 0001 當初的種子，拿它
 * 頂替一個讀不到的即時活動，等於把過期的日期與名額當成現況印給客人看。
 */
/**
 * 把一列 events 的七個清單欄位（0027）讀成詳情頁要的形狀。
 *
 * 欄位名與順序都來自 EVENT_LIST_FIELDS，這裡不另外抄一份。任何一欄缺值、形狀
 * 不對、或陣列裡混進非字串，一律退成空陣列——空陣列的意思是「這一塊不印」，
 * 而這一層本來就不該丟例外（見檔頭：nothing here throws）。
 */
function readEventLists(row: unknown): Record<EventListField, LocalizedList> {
  const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const out = {} as Record<EventListField, LocalizedList>;
  for (const field of EVENT_LIST_FIELDS) {
    const value: LocalizedList = { zh: [], en: [], ja: [] };
    const raw = r[field];
    if (raw && typeof raw === "object") {
      for (const lang of ["zh", "en", "ja"] as const) {
        const arr = (raw as Record<string, unknown>)[lang];
        if (Array.isArray(arr)) {
          value[lang] = arr.filter(
            (item): item is string => typeof item === "string" && item.trim() !== "",
          );
        }
      }
    }
    out[field] = value;
  }
  return out;
}

export async function fetchEventBySlug(slug: string): Promise<EventDetailResult> {
  const db = supabase;
  if (!db) {
    logFailure(`events/${slug}`, "Supabase is not configured");
    return { event: null, unavailable: true };
  }
  try {
    const { data, error } = await db
      .from("events")
      // 只有 public.events 真的有的欄位。這個 repo 曾經因為 select 了一個不存在的
      // 欄位（0025 的 speaker_id 還沒套上正式庫）把整個活動後台弄掛 ——
      // PostgREST 對此回 42703，整頁 500。
      //
      // ⚠️ slug 是 0026 加的。**0026 沒有先套上 live DB 就推這個檔，壞的不只是後台，
      //    連這一頁也會壞**（0025 那次只有後台壞，因為這裡的清單沒有 speaker_id）。
      //
      // image_key / speaker_id / gallery_keys 這一期起真的要讀：大圖、講者、相簿
      // 三塊都要靠它們。image_key 與 speaker_id 從 0025／0026 就存在，只是這一頁
      // 一直刻意不選；gallery_keys 是 0031 新加的欄位，同一條「先套 migration
      // 再推程式碼」規則對它也成立。
      .select(
        // 🔴 這裡必須是**一整條字串字面值**，不可以用模板字串去串 EVENT_LIST_FIELDS。
        //    scripts/event-detail-page-selftest.mjs 是靜態解析這一行、逐欄核對
        //    「select 的每一欄 public.events 真的有」——串起來它就讀不到欄位，那道
        //    防線會安靜地失效，而它擋的正是把後台弄壞過三次的「select 了還沒
        //    migrate 的欄位」（見 CLAUDE.md 的 Migration 那一節）。
        //
        //    後七欄是 0027 的清單欄位，與 src/lib/event-blocks.ts 的
        //    EVENT_LIST_FIELDS 是同一份名單；同一支自檢有一條會逐欄比對兩邊，
        //    在那份名單加欄位卻忘了加到這裡，測試就會紅。
        "id,slug,title,summary,description,display_date,category,external_url,registration_type,image_key,speaker_id,gallery_keys,highlights,suitable_for,not_suitable_for,takeaways,outline,includes,notes",
      )
      .eq("slug", slug)
      .maybeSingle();

    if (error) {
      logFailure(`events/${slug}`, error.message);
      return { event: null, unavailable: true };
    }
    if (!data) return { event: null, unavailable: false };

    const r = data as unknown as Row;
    const title = loc(r.title);
    const summary = loc(r.summary);
    const description = loc(r.description);
    // 三個 jsonb 有任何一個不是 {zh,en,ja}，這一列就不能拿來渲染。回 null 而不是
    // unavailable：這是資料本身壞了，重試一次也不會變好。
    if (!title || !summary || !description) return { event: null, unavailable: false };

    // ── 相簿 ─────────────────────────────────────────────────────────────
    // gallery_keys 是 text[]，not null default '{}'（0031），所以 r.gallery_keys
    // 讀出來一定是陣列，不會是 null——這裡仍然防一手（RLS/schema 之外的來源，
    // 例如還沒套上 0031 的環境）：不是陣列就當成沒有相簿，而不是讓
    // .filter() 在一個非陣列值上炸掉。
    const galleryKeys = Array.isArray(r.gallery_keys)
      ? r.gallery_keys.filter((k): k is string => typeof k === "string" && k.length > 0)
      : [];

    // ── 講者 ─────────────────────────────────────────────────────────────
    // speaker_id 是 FK -> public.artists(id)，on delete set null（0025）。
    // 這裡另外一趟查詢，不是把 artists 塞進上面那個 .select() 裡：那樣寫的話，
    // 上面 [4] 的欄位斷言（一條逐一比對 events 真的有的欄位的清單）得先學會
    // 剖析巢狀的 PostgREST 嵌入語法，而這一頁的講者資料量小到不值得那個複雜度。
    // artists 的 RLS（artists_select_public，0019）只讓 anon/authenticated 讀
    // is_active 的列，所以講者被停用時這裡自然查不到列，不需要另外判斷
    // is_active——跟資料庫裡唯一的真相來源保持一致，不是這裡重新決定一次。
    let speaker: EventSpeaker | null = null;
    const speakerId = nullableStr(r.speaker_id);
    if (speakerId) {
      const { data: artistRow, error: speakerError } = await db
        .from("artists")
        .select("name, discipline, bio, long_bio, image_key")
        .eq("id", speakerId)
        .maybeSingle();
      if (speakerError) {
        // 講者讀不到不該讓整個活動頁跟著壞——這一塊退場，其餘照常渲染。
        logFailure(`events/${slug}/speaker`, speakerError.message);
      } else if (artistRow) {
        const a = artistRow as unknown as Row;
        speaker = {
          name: str(a.name),
          title: nullableStr(a.discipline) ?? "",
          bio: nullableStr(a.long_bio) || nullableStr(a.bio) || "",
          imageKey: nullableStr(a.image_key),
        };
      }
    }

    return {
      event: {
        id: str(r.id),
        slug: str(r.slug),
        title,
        summary,
        description,
        date: str(r.display_date),
        category: str(r.category),
        externalUrl: str(r.external_url),
        // ⚠️ 呼叫端必須先判斷非空再呼叫 imageFor()——見 EventEntry.imageKey 的
        //    型別註解與 events.$slug.tsx 的渲染。這裡不再刻意寫死 null。
        imageKey: nullableStr(r.image_key),
        // 詳情頁不做「已結束」的判斷（直接連過來的人本來就該看得到內容）。
        isoDate: null,
        lastSessionDate: null,
        registrationType: r.registration_type === "internal" ? "internal" : "external",
        galleryKeys,
        speaker,
        lists: readEventLists(r),
      },
      unavailable: false,
    };
  } catch (err) {
    logFailure(`events/${slug}`, err instanceof Error ? err.message : String(err));
    return { event: null, unavailable: true };
  }
}

export async function fetchEventCategories(): Promise<EventCategoryEntry[]> {
  const rows = await select("event_categories", "id,label,sort_order", { order: "sort_order" });
  if (!rows || !rows.length) return FALLBACK_EVENT_CATEGORIES;
  const mapped: EventCategoryEntry[] = [];
  for (const r of rows) {
    const label = loc(r.label);
    if (!label) continue;
    mapped.push({ id: str(r.id), label });
  }
  return mapped.length ? mapped : FALLBACK_EVENT_CATEGORIES;
}

export async function fetchJourneys(): Promise<JourneyEntry[]> {
  const rows = await select(
    "journeys",
    "id,title,summary,description,days,theme,external_url,sort_order",
    { order: "sort_order" },
  );
  if (!rows || !rows.length) return FALLBACK_JOURNEYS;
  const mapped: JourneyEntry[] = [];
  for (const r of rows) {
    const title = loc(r.title);
    const summary = loc(r.summary);
    const description = loc(r.description);
    const days = loc(r.days);
    const theme = loc(r.theme);
    if (!title || !summary || !description || !days || !theme) continue;
    mapped.push({
      id: str(r.id),
      title,
      summary,
      description,
      days,
      theme,
      externalUrl: str(r.external_url),
    });
  }
  return mapped.length ? mapped : FALLBACK_JOURNEYS;
}

export async function fetchNews(): Promise<NewsEntry[]> {
  const rows = await select("news", "id,title,summary,description,display_date,sort_order", {
    order: "sort_order",
  });
  if (!rows || !rows.length) return FALLBACK_NEWS;
  const mapped: NewsEntry[] = [];
  for (const r of rows) {
    const title = loc(r.title);
    const summary = loc(r.summary);
    const description = loc(r.description);
    if (!title || !summary || !description) continue;
    mapped.push({
      id: str(r.id),
      title,
      summary,
      description,
      date: str(r.display_date),
    });
  }
  return mapped.length ? mapped : FALLBACK_NEWS;
}

/** /news 列表上每一則的錨點 id；首頁跑馬燈連到 `/news#${newsAnchorId(id)}`。 */
export function newsAnchorId(id: string): string {
  return `news-${id}`;
}

/** 首頁跑馬燈的一則：只要標題與日期，不帶摘要／內文。 */
export type NewsTickerEntry = Pick<NewsEntry, "id" | "title" | "date">;

/**
 * 首頁「最新消息」跑馬燈用。與 fetchNews() 同一張表、同一個排序、同一套公開可見規則
 * （RLS 只放行已發布的），但只 select 跑馬燈畫得到的欄位——摘要與內文常常是好幾百字，
 * 首頁用不到就不要搬。讀取失敗時退回內建消息（與 fetchNews 一致），所以 /news 與首頁看到的
 * 是同一批。
 */
export async function fetchNewsTicker(limit = 6): Promise<NewsTickerEntry[]> {
  const rows = await select("news", "id,title,display_date,sort_order", { order: "sort_order" });
  const fallback = () =>
    FALLBACK_NEWS.slice(0, limit).map(({ id, title, date }) => ({ id, title, date }));
  if (!rows || !rows.length) return fallback();
  const mapped: NewsTickerEntry[] = [];
  for (const r of rows) {
    const title = loc(r.title);
    if (!title) continue;
    mapped.push({ id: str(r.id), title, date: str(r.display_date) });
    if (mapped.length >= limit) break;
  }
  return mapped.length ? mapped : fallback();
}

export async function fetchCuratedThemes(): Promise<CuratedThemeEntry[]> {
  const [themeRows, itemRows] = await Promise.all([
    select("curated_themes", "id,title,description,sort_order", { order: "sort_order" }),
    select("curated_items", "theme_id,name,note,sort_order", { order: "sort_order" }),
  ]);
  if (!themeRows || !themeRows.length) return FALLBACK_CURATED_THEMES;

  const itemsByTheme = new Map<string, { name: Localized; note: Localized }[]>();
  for (const r of itemRows ?? []) {
    const themeId = str(r.theme_id);
    const name = loc(r.name);
    const note = loc(r.note);
    if (!themeId || !name || !note) continue;
    const bucket = itemsByTheme.get(themeId) ?? [];
    bucket.push({ name, note });
    itemsByTheme.set(themeId, bucket);
  }

  const mapped: CuratedThemeEntry[] = [];
  for (const r of themeRows) {
    const title = loc(r.title);
    const description = loc(r.description);
    if (!title || !description) continue;
    const id = str(r.id);
    mapped.push({ id, title, description, items: itemsByTheme.get(id) ?? [] });
  }
  return mapped.length ? mapped : FALLBACK_CURATED_THEMES;
}

export async function fetchCollaborations(): Promise<CollaborationEntry[]> {
  const rows = await select("collaborations", "id,title,description,sort_order", {
    order: "sort_order",
  });
  if (!rows || !rows.length) return FALLBACK_COLLABORATIONS;
  const mapped: CollaborationEntry[] = [];
  for (const r of rows) {
    const title = loc(r.title);
    const description = loc(r.description);
    if (!title || !description) continue;
    mapped.push({ id: str(r.id), title, description });
  }
  return mapped.length ? mapped : FALLBACK_COLLABORATIONS;
}
