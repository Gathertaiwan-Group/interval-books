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
 */
import { isEventEnded, latestSessionEndIso, todayInTaipei } from "@/lib/event-status";
import type { SitemapEntry } from "./core";

type Ts = string | null | undefined;

export type SitemapSessionRow = {
  startsAt: string | null;
  endsAt: string | null;
  updatedAt: Ts;
  planUpdatedAts: Ts[];
};

export type SitemapEventRow = {
  slug: string;
  isoDate: string | null;
  updatedAt: Ts;
  /** 售票商品（event-<slug>）。沒有（外部報名）→ null。 */
  booking: { updatedAt: Ts; sessions: SitemapSessionRow[] } | null;
};

export type SitemapSource = {
  /** pages 表：slug → updated_at。 */
  pages: Array<{ slug: string; updatedAt: Ts }>;
  /** page_blocks ＋ page_list_items：page_slug → updated_at。 */
  pageParts: Array<{ pageSlug: string; updatedAt: Ts }>;
  events: SitemapEventRow[];
  /** 上架中的商品（含活動票券）。 */
  products: Array<{ slug: string; productType: string; updatedAt: Ts }>;
  journeys: Array<{ externalUrl: string; updatedAt: Ts }>;
  publicationsLatest: Ts;
  curatedLatest: Ts;
};

/** 固定頁面 ↔ pages 表的 slug，以及另外算進 lastmod 的內容來源。 */
const STATIC_PAGES: Array<{
  path: string;
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

  const entries: SitemapEntry[] = [];
  for (const s of STATIC_PAGES) {
    entries.push({
      path: s.path,
      lastmod: latestOf([
        ...s.pageSlugs.flatMap((slug) => pageUpdated.get(slug) ?? []),
        ...(s.extra ? extras[s.extra] : []),
      ]),
    });
  }

  // 選物：/shop（商品分頁）與 /shop?tab=publications（地方刊物展）
  entries.push({ path: "/shop", lastmod: latestOf(src.products.map((p) => p.updatedAt)) });
  entries.push({
    path: "/shop?tab=publications",
    lastmod: latestOf([
      src.publicationsLatest,
      ...src.products.filter((p) => p.slug.startsWith("pub-")).map((p) => p.updatedAt),
    ]),
  });

  // 活動（含著陸頁：/events/kungtung 等靜態路由的 slug 跟活動列相同，sitemapXml 會去重）
  for (const e of src.events) {
    const slug = e.slug.trim();
    if (slug) entries.push({ path: `/events/${slug}`, lastmod: eventLastmod(e, today) });
  }
  for (const path of LANDING_SUBPAGES) entries.push({ path });

  // 策旅：卡片指著站內頁面的才列（外部網站不是我們的網址）。不帶 lastmod（見檔頭）。
  for (const j of src.journeys) {
    const url = j.externalUrl.trim();
    if (url.startsWith("/") && !url.startsWith("//")) entries.push({ path: url.split("#")[0] });
  }

  // 商品：選物與刊物。活動票券（event-*／journey）不另列——它們的主頁是 /events/<slug>。
  for (const p of src.products) {
    const slug = p.slug.trim();
    if (!slug || p.productType === "event" || p.productType === "journey") continue;
    entries.push({ path: `/shop/${slug}`, lastmod: p.updatedAt ?? null });
  }

  return entries;
}
