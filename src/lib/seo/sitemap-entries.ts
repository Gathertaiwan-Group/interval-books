/**
 * sitemap.xml 的網址與 lastmod —— 純函式（src/server/sitemap.ts 查完資料庫後交給這裡）。
 *
 * ── lastmod 的規則（2026-11 SEO 驗收 #6）─────────────────────────────────────
 * lastmod 一律是**這一頁內容真正的更新時間**：組成這一頁的那幾張表的 updated_at
 * 取最新的一筆（每張表都有 *_set_updated_at 觸發器維護）。
 *
 *   · 固定頁：pages ＋ page_blocks ＋ page_list_items（該頁的 slug）；/events、首頁另外
 *     算進 events，/journeys 算進 journeys，/shop?tab=curated 算進 curated_*。
 *   · 活動頁：events 列 ＋ 售票商品 ＋ 場次 ＋ 票種。報名區印的日期、地點、票價、
 *     尚餘名額都來自後三者——只看 events.updated_at 會漏掉「改了票價」這種更新。
 *   · **已結束的活動**：保留在 sitemap，lastmod 用最後一個場次的結束時間（沒有場次就用
 *     iso_date 當天）。「已結束」與 /events「已結束」分頁同一條規則（isEventEnded）。
 *   · 策旅卡片指著的站內頁：卡片在 /journeys 上，journeys.updated_at 不是那一頁的內容，
 *     所以這一筆不帶 lastmod（那一頁自己的那筆會帶）。
 *   · 沒有資料列的頁（寫死在程式碼裡的著陸頁子頁）：不輸出 lastmod。
 *
 * 🔴 **絕不放部署時間或「現在」**：沒有 updated_at 可用就不輸出 lastmod。
 *
 * ── 語言（2026-11 /en /ja）─────────────────────────────────────────────────────
 * 每一筆帶 langs（可收錄的語言），規則與頁面 head() 同一支：i18n.ts 的 isLangIndexable()。
 *   · 活動、商品：標題＋摘要＋內文（與 pages.ts 的 contentTranslation 相同）。
 *   · 固定頁：pages 列的頁首標題（沒有就 meta_title）＋頁首介紹＋描述＋頁面區塊
 *     （與 pages.ts 的 pageRowTranslation 相同）；查不到那一列 → 三語（畫面用程式內建文案）。
 *   · 中文限定的著陸頁（ZH_ONLY_PATHS）→ 只有中文。
 * 沒給翻譯資料（舊的呼叫端／測試）→ 視同三語齊全。
 */
import { isEventEnded, latestSessionEndIso, todayInTaipei } from "@/lib/event-status";
import type { Lang, Localized } from "@/i18n/types";
import { indexableLangs, isZhOnlyPath, SITE_LANGS, type PageTranslation } from "@/lib/seo/i18n";
import type { SitemapEntry } from "./core";

type Ts = string | null | undefined;

export type SitemapSessionRow = {
  startsAt: string | null;
  endsAt: string | null;
  updatedAt: Ts;
  planUpdatedAts: Ts[];
};

/** 標題＋本文欄位（noindex 規則的輸入）。沒有 → 視同三語齊全。 */
export type SitemapContent = { title: Localized | null; body: Array<Localized | null> };

export type SitemapEventRow = {
  slug: string;
  content?: SitemapContent;
  isoDate: string | null;
  updatedAt: Ts;
  /** 售票商品（event-<slug>）。沒有（外部報名）→ null。 */
  booking: { updatedAt: Ts; sessions: SitemapSessionRow[] } | null;
};

export type SitemapSource = {
  /** pages 表：slug → updated_at。 */
  pages: Array<{ slug: string; updatedAt: Ts; content?: SitemapContent }>;
  /** page_blocks ＋ page_list_items：page_slug → updated_at。 */
  pageParts: Array<{ pageSlug: string; updatedAt: Ts; value?: Localized | null }>;
  events: SitemapEventRow[];
  /** 上架中的商品（含活動票券）。 */
  products: Array<{
    slug: string;
    productType: string;
    updatedAt: Ts;
    content?: SitemapContent;
  }>;
  journeys: Array<{ externalUrl: string; updatedAt: Ts }>;
  publicationsLatest: Ts;
  curatedLatest: Ts;
};

/** 固定頁面 ↔ pages 表的 slug，以及另外算進 lastmod 的內容來源。 */
const STATIC_PAGES: Array<{
  path: string;
  /** 第一個是這一頁自己的 pages 列（翻譯判斷看它）；其餘只算 lastmod。 */
  pageSlugs: string[];
  extra?: "events" | "journeys" | "curated";
}> = [
  { path: "/", pageSlugs: ["index"], extra: "events" },
  { path: "/events", pageSlugs: ["events"], extra: "events" },
  { path: "/journeys", pageSlugs: ["journeys"], extra: "journeys" },
  { path: "/about", pageSlugs: ["about", "visit"] },
  { path: "/curation", pageSlugs: ["curation"] },
  { path: "/partnership", pageSlugs: ["partnership"] },
  { path: "/privacy", pageSlugs: ["privacy"] },
  { path: "/shop?tab=curated", pageSlugs: ["curated"], extra: "curated" },
];

/** 寫死在程式碼裡的著陸頁子頁（沒有自己的資料列 → 沒有 lastmod）。 */
const LANDING_SUBPAGES = ["/events/kungtung/hosts/alice", "/events/kungtung/hosts/fan-yishun"];

/** 最新的那一個時間（讀不懂的略過）。全部都沒有 → null。 */
export function latestOf(values: ReadonlyArray<Ts>): string | null {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isNaN(t) || t <= bestT) continue;
    best = v;
    bestT = t;
  }
  return best;
}

/** 一場活動頁的 lastmod（規則見檔頭）。 */
export function eventLastmod(e: SitemapEventRow, today = todayInTaipei()): string | null {
  const sessions = e.booking?.sessions ?? [];
  if (isEventEnded(e.isoDate, sessions, today)) {
    return latestSessionEndIso(sessions) ?? (e.isoDate ? `${e.isoDate}T00:00:00+08:00` : null);
  }
  return latestOf([
    e.updatedAt,
    e.booking?.updatedAt,
    ...sessions.flatMap((s) => [s.updatedAt, ...s.planUpdatedAts]),
  ]);
}

function langsOf(content: SitemapContent | undefined): Lang[] {
  if (!content) return [...SITE_LANGS];
  const translation: PageTranslation = { title: content.title, body: content.body };
  return indexableLangs(translation);
}

/** 不含前綴的路徑 → 可收錄的語言（中文限定的著陸頁只有中文）。 */
function langsFor(path: string, content: SitemapContent | undefined): Lang[] {
  return isZhOnlyPath(path.split("?")[0]) ? ["zh"] : langsOf(content);
}

export function buildSitemapEntries(src: SitemapSource, today = todayInTaipei()): SitemapEntry[] {
  const pageUpdated = new Map<string, Ts[]>();
  const add = (slug: string, v: Ts) => {
    const list = pageUpdated.get(slug);
    if (list) list.push(v);
    else pageUpdated.set(slug, [v]);
  };
  for (const p of src.pages) add(p.slug, p.updatedAt);
  for (const p of src.pageParts) add(p.pageSlug, p.updatedAt);

  const extras: Record<"events" | "journeys" | "curated", Ts[]> = {
    events: src.events.map((e) => e.updatedAt),
    journeys: src.journeys.map((j) => j.updatedAt),
    curated: [src.curatedLatest],
  };

  // 固定頁的翻譯判斷：pages 列（頁首標題、介紹、描述）＋該頁所有區塊。
  const pageContent = new Map<string, SitemapContent>();
  for (const p of src.pages) {
    if (p.content) pageContent.set(p.slug, { title: p.content.title, body: [...p.content.body] });
  }
  for (const part of src.pageParts) {
    const c = pageContent.get(part.pageSlug);
    if (c && part.value) c.body.push(part.value);
  }
  const staticLangs = (slug: string) => langsOf(pageContent.get(slug));

  const entries: SitemapEntry[] = [];
  for (const s of STATIC_PAGES) {
    entries.push({
      path: s.path,
      lastmod: latestOf([
        ...s.pageSlugs.flatMap((slug) => pageUpdated.get(slug) ?? []),
        ...(s.extra ? extras[s.extra] : []),
      ]),
      langs: staticLangs(s.pageSlugs[0]),
    });
  }

  // 選物：/shop（商品分頁）與 /shop?tab=publications（地方刊物展）
  entries.push({
    path: "/shop",
    lastmod: latestOf(src.products.map((p) => p.updatedAt)),
    langs: staticLangs("shop"),
  });
  entries.push({
    path: "/shop?tab=publications",
    lastmod: latestOf([
      src.publicationsLatest,
      ...src.products.filter((p) => p.slug.startsWith("pub-")).map((p) => p.updatedAt),
    ]),
    langs: staticLangs("publications"),
  });

  // 活動（含著陸頁：/events/kungtung 等靜態路由的 slug 跟活動列相同，sitemapXml 會去重）
  const eventLangs = new Map<string, Lang[]>();
  for (const e of src.events) {
    const slug = e.slug.trim();
    if (!slug) continue;
    const path = `/events/${slug}`;
    const langs = langsFor(path, e.content);
    eventLangs.set(path, langs);
    entries.push({ path, lastmod: eventLastmod(e, today), langs });
  }
  for (const path of LANDING_SUBPAGES) entries.push({ path, langs: langsFor(path, undefined) });

  // 策旅：卡片指著站內頁面的才列（外部網站不是我們的網址）。不帶 lastmod（見檔頭）。
  // 語言跟著那一頁自己的那一筆（活動頁）；不是活動頁 → 依路徑判斷。
  for (const j of src.journeys) {
    const url = j.externalUrl.trim();
    if (!url.startsWith("/") || url.startsWith("//")) continue;
    const path = url.split("#")[0];
    entries.push({ path, langs: eventLangs.get(path) ?? langsFor(path, undefined) });
  }

  // 商品：選物與刊物。活動票券（event-*／journey）不另列——它們的主頁是 /events/<slug>。
  for (const p of src.products) {
    const slug = p.slug.trim();
    if (!slug || p.productType === "event" || p.productType === "journey") continue;
    const path = `/shop/${slug}`;
    entries.push({ path, lastmod: p.updatedAt ?? null, langs: langsFor(path, p.content) });
  }

  return entries;
}
