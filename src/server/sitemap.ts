/**
 * /robots.txt 與 /sitemap.xml（2026-11 SEO 健檢 H1）。由 src/server.ts 攔截後 dynamic import。
 *
 * sitemap 是**即時**從資料庫列出來的（後台新增活動、上架商品，一小時內就會出現在這裡），
 * 讀的是前台同一支 anon client（src/lib/supabase.ts）——RLS 只放得出已發布的活動與
 * status='active' 的商品，所以這裡天生不會把草稿或下架商品列進去；查詢上仍然明寫條件，
 * 不靠 RLS 當唯一防線。
 *
 * 讀取失敗 → 503 + Retry-After，**不回一份殘缺的 sitemap**：少了一半網址的 200 會讓
 * Search Console 以為那些頁不見了。
 */
import { supabase } from "@/lib/supabase";
import { robotsTxt, sitemapXml, type SitemapEntry } from "@/lib/seo/core";

/** CDN 快取一小時、過期後一天內可先吐舊的（背景重新整理）。 */
const SITEMAP_CACHE = "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400";

export function handleRobotsTxt(): Response {
  return new Response(robotsTxt(), {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=86400",
    },
  });
}

/**
 * 固定頁面 ↔ pages 表的 slug（lastmod 用 pages.updated_at）。
 * /shop 本身沒有 pages 列，lastmod 用商品的最新 updated_at。
 */
const STATIC_PAGES: Array<{ path: string; pageSlugs: string[] }> = [
  { path: "/", pageSlugs: ["index"] },
  { path: "/events", pageSlugs: ["events"] },
  { path: "/journeys", pageSlugs: ["journeys"] },
  { path: "/about", pageSlugs: ["about", "visit"] },
  { path: "/curation", pageSlugs: ["curation"] },
  { path: "/partnership", pageSlugs: ["partnership"] },
  { path: "/privacy", pageSlugs: ["privacy"] },
  { path: "/shop?tab=curated", pageSlugs: ["curated"] },
];

/** 寫死在程式碼裡的著陸頁子頁（沒有自己的資料列）。 */
const LANDING_SUBPAGES = ["/events/kungtung/hosts/alice", "/events/kungtung/hosts/fan-yishun"];

type Row = Record<string, unknown>;

function maxOf(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) if (v && (!best || Date.parse(v) > Date.parse(best))) best = v;
  return best;
}

async function rows(
  table: string,
  columns: string,
  opts: { eq?: [string, unknown]; latestOnly?: boolean } = {},
): Promise<Row[]> {
  if (!supabase) throw new Error("Supabase is not configured");
  let query = supabase.from(table).select(columns);
  if (opts.eq) query = query.eq(opts.eq[0], opts.eq[1]);
  if (opts.latestOnly) query = query.order("updated_at", { ascending: false }).limit(1);
  const { data, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as unknown as Row[];
}

export async function collectSitemapEntries(): Promise<SitemapEntry[]> {
  const [pages, events, products, journeys, publications] = await Promise.all([
    rows("pages", "slug,updated_at"),
    rows("events", "slug,updated_at", { eq: ["is_published", true] }),
    rows("products", "slug,product_type,updated_at", { eq: ["status", "active"] }),
    rows("journeys", "external_url,updated_at"),
    rows("publications", "updated_at", { latestOnly: true }),
  ]);

  const pageUpdated = new Map(pages.map((p) => [String(p.slug), p.updated_at as string | null]));
  const entries: SitemapEntry[] = [];

  for (const s of STATIC_PAGES) {
    entries.push({
      path: s.path,
      lastmod: maxOf(s.pageSlugs.map((slug) => pageUpdated.get(slug))),
    });
  }

  // 選物：/shop（商品分頁）與 /shop?tab=publications（地方刊物展）
  entries.push({ path: "/shop", lastmod: maxOf(products.map((p) => p.updated_at as string)) });
  entries.push({
    path: "/shop?tab=publications",
    lastmod: maxOf([
      publications[0]?.updated_at as string | undefined,
      ...products
        .filter((p) => String(p.slug).startsWith("pub-"))
        .map((p) => p.updated_at as string),
    ]),
  });

  // 活動（含著陸頁：/events/kungtung 等靜態路由的 slug 跟活動列相同，sitemapXml 會去重）
  for (const e of events) {
    const slug = String(e.slug ?? "").trim();
    if (slug) entries.push({ path: `/events/${slug}`, lastmod: e.updated_at as string });
  }
  for (const path of LANDING_SUBPAGES) entries.push({ path });

  // 策旅：卡片指著站內頁面的才列（外部網站不是我們的網址）
  for (const j of journeys) {
    const url = String(j.external_url ?? "").trim();
    if (url.startsWith("/") && !url.startsWith("//")) {
      entries.push({ path: url.split("#")[0], lastmod: j.updated_at as string });
    }
  }

  // 商品：選物與刊物。活動票券（event-*／journey）不另列——它們的主頁是 /events/<slug>。
  for (const p of products) {
    const type = String(p.product_type);
    const slug = String(p.slug ?? "").trim();
    if (!slug || type === "event" || type === "journey") continue;
    entries.push({ path: `/shop/${slug}`, lastmod: p.updated_at as string });
  }

  return entries;
}

export async function handleSitemapXml(): Promise<Response> {
  try {
    const entries = await collectSitemapEntries();
    return new Response(sitemapXml(entries), {
      status: 200,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": SITEMAP_CACHE,
      },
    });
  } catch (err) {
    console.warn(`[sitemap] unavailable — ${err instanceof Error ? err.message : String(err)}`);
    return new Response("sitemap temporarily unavailable\n", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "300",
      },
    });
  }
}
