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
import type { Localized } from "@/i18n/types";
import { buildSitemapEntries, latestOf, type SitemapContent } from "@/lib/seo/sitemap-entries";
import { eventProductSlug } from "@/lib/shop";
import { publicationTranslationFields } from "@/lib/seo/publication";

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

type Row = Record<string, unknown>;

const ts = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

/**
 * jsonb 的三語欄位 → Localized。規則與 src/lib/cms.ts 的 loc() 相同：三個鍵都要是字串，
 * 否則 null——頁面與 sitemap 對「有沒有翻譯」才會得到同一個答案。
 */
function loc(v: unknown): Localized | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.zh !== "string" || typeof o.en !== "string" || typeof o.ja !== "string") return null;
  return { zh: o.zh, en: o.en, ja: o.ja };
}

/**
 * 活動列、商品列：標題＋摘要＋內文（與 src/lib/seo/pages.ts 的 contentTranslation 相同）。
 * 標題讀不懂 → 頁面那邊會是讀取失敗的頁殼（視同三語），這裡也不給翻譯資料。
 */
function contentOf(r: Row): SitemapContent | undefined {
  const title = loc(r.title);
  if (!title) return undefined;
  return { title, body: [loc(r.summary), loc(r.description)] };
}

/**
 * pages 列（與 pages.ts 的 pageRowTranslation 相同）。meta_title／meta_description 讀不懂時
 * cms.ts 的 fetchPage() 回 null、頁面用程式內建的三語文案 → 這裡也視同三語。
 */
function pageContentOf(p: Row): SitemapContent | undefined {
  const metaTitle = loc(p.meta_title);
  const metaDescription = loc(p.meta_description);
  if (!metaTitle || !metaDescription) return undefined;
  return {
    title: loc(p.header_title) ?? metaTitle,
    body: [loc(p.header_intro), metaDescription],
  };
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

/**
 * 查資料庫 → 交給 buildSitemapEntries()（src/lib/seo/sitemap-entries.ts，lastmod 的規則
 * 寫在那裡）。每一張表都有 updated_at 觸發器；這裡只讀 updated_at，不放任何「現在」。
 */
export async function collectSitemapEntries(): Promise<SitemapEntry[]> {
  const [
    pages,
    pageBlocks,
    pageListItems,
    events,
    products,
    journeys,
    publications,
    curatedItems,
    curatedThemes,
  ] = await Promise.all([
    // 標題／介紹／內文：判斷英日文有沒有翻譯（noindex 的語言版本不進 sitemap，見 i18n.ts）。
    rows("pages", "slug,updated_at,meta_title,meta_description,header_title,header_intro"),
    rows("page_blocks", "page_slug,updated_at,value"),
    rows("page_list_items", "page_slug,updated_at"),
    rows("events", "slug,iso_date,updated_at,title,summary,description", {
      eq: ["is_published", true],
    }),
    // 活動票券連同場次、票種一起 embed（event_sessions.product_id、
    // event_session_plans.session_id 兩條外鍵），活動頁的 lastmod 要算進它們。
    rows(
      "products",
      "id,slug,product_type,updated_at,title,summary,description,event_sessions(starts_at,ends_at,updated_at,event_session_plans(updated_at))",
      { eq: ["status", "active"] },
    ),
    // 0052：只列上架中的卡片（is_published 由 status 推導）；不靠 RLS 當唯一防線。
    rows("journeys", "external_url,updated_at", { eq: ["is_published", true] }),
    // 2026-11 M4：每一本刊物有自己的頁（/publications/<slug>），整份列出來；刊名＋介紹判斷英日文。
    rows("publications", "slug,product_id,updated_at,title,intro", {
      eq: ["is_published", true],
    }),
    rows("curated_items", "updated_at", { latestOnly: true }),
    rows("curated_themes", "updated_at", { latestOnly: true }),
  ]);

  const bookingBySlug = new Map(
    products.map((p) => [
      String(p.slug ?? ""),
      {
        updatedAt: ts(p.updated_at),
        sessions: arr(p.event_sessions).map((s) => ({
          startsAt: ts(s.starts_at),
          endsAt: ts(s.ends_at),
          updatedAt: ts(s.updated_at),
          planUpdatedAts: arr(s.event_session_plans).map((pl) => ts(pl.updated_at)),
        })),
      },
    ]),
  );

  return buildSitemapEntries({
    pages: pages.map((p) => ({
      slug: String(p.slug ?? ""),
      updatedAt: ts(p.updated_at),
      content: pageContentOf(p),
    })),
    pageParts: [
      ...pageBlocks.map((p) => ({
        pageSlug: String(p.page_slug ?? ""),
        updatedAt: ts(p.updated_at),
        value: loc(p.value),
      })),
      ...pageListItems.map((p) => ({
        pageSlug: String(p.page_slug ?? ""),
        updatedAt: ts(p.updated_at),
      })),
    ],
    events: events.map((e) => {
      const slug = String(e.slug ?? "");
      return {
        slug,
        content: contentOf(e),
        isoDate: ts(e.iso_date),
        updatedAt: ts(e.updated_at),
        booking: bookingBySlug.get(eventProductSlug(slug)) ?? null,
      };
    }),
    products: products.map((p) => ({
      id: String(p.id ?? ""),
      slug: String(p.slug ?? ""),
      productType: String(p.product_type ?? ""),
      updatedAt: ts(p.updated_at),
      content: contentOf(p),
    })),
    journeys: journeys.map((j) => ({
      externalUrl: String(j.external_url ?? ""),
      updatedAt: ts(j.updated_at),
    })),
    publicationsLatest: latestOf(publications.map((p) => ts(p.updated_at))),
    publications: publications.map((p) => {
      const title = loc(p.title);
      const intro = loc(p.intro);
      // 與頁面 head() 同一支判斷（publicationTranslation）。三語欄位讀不懂 → 頁面那邊是 503
      // 的頁殼，這裡也不給翻譯資料（視同三語）。
      return {
        slug: String(p.slug ?? ""),
        productId: ts(p.product_id),
        updatedAt: ts(p.updated_at),
        content: title && intro ? publicationTranslationFields({ title, intro }) : undefined,
      };
    }),
    curatedLatest: latestOf([ts(curatedItems[0]?.updated_at), ts(curatedThemes[0]?.updated_at)]),
  });
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
