/**
 * 地方刊物展的前台讀取層 —— public.publications（migration 0015）。
 *
 * 走 anon client 而不是 src/server/repos/**，理由與 src/lib/shop.ts 檔頭那段完全
 * 一樣：service_role 會繞過 RLS，而 0015 的 publications_select_public 已經把
 * 「只讀得到已發布的」寫進資料庫了。下面那句 .eq("is_published", true) 是縱深
 * 防禦，不是主要控制。
 *
 * 這一層**不查商品**。哪幾本可以買是 products / product_availability 的事，
 * 由 src/lib/shop.ts#fetchActiveProductsByIds 回答；路由把兩邊接起來。分開的
 * 理由是它們的失敗模式不同：刊物讀失敗 = 展覽頁沒東西可看（要說「暫時無法載入」），
 * 商品讀失敗 = 展覽頁照常，只是購買鈕不出現（展覽本身不該因為電商掛掉而消失）。
 */
import { supabase } from "@/lib/supabase";
import type { Localized } from "@/i18n/types";
import { caseInsensitiveMatch, exactIlikePattern } from "@/lib/seo/core";

import { regionGroupOf, type PublicationSheet } from "./publication-regions";

export type { PublicationSheet } from "./publication-regions";

export type PublicationEntry = {
  id: string;
  /** tw-001 / jp-024 —— 也是頁內錨點。 */
  slug: string;
  sheet: PublicationSheet;
  seq: number;
  title: Localized;
  publisher: Localized;
  intro: Localized;
  /** 「關注地域」原文。粗分類請用 regionGroupOf()，不要自己 parse。 */
  region: string;
  /** 「集數」，人寫的字串；null = 原始資料沒填。 */
  issues: string | null;
  externalUrl: string | null;
  coverImageKey: string | null;
  /** null = 只在店內展示。非 null = 對應 public.products 的一件商品。 */
  productId: string | null;
};

export type PublicationsResult = {
  publications: PublicationEntry[];
  /** true 只代表「這次讀取失敗」。空陣列 + false 是真的沒有資料。 */
  unavailable: boolean;
};

const COLUMNS =
  "id, slug, sheet, seq, title, publisher, intro, region, issues, external_url, cover_image_key, product_id";

type Row = Record<string, unknown>;

function isLocalized(v: unknown): v is Localized {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.zh === "string" && typeof o.en === "string" && typeof o.ja === "string";
}

function loc(v: unknown): Localized | null {
  return isLocalized(v) ? { zh: v.zh, en: v.en, ja: v.ja } : null;
}

function nullableStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toEntry(r: Row): PublicationEntry | null {
  const id = typeof r.id === "string" ? r.id : null;
  const slug = typeof r.slug === "string" ? r.slug : null;
  const sheet = r.sheet === "tw" || r.sheet === "jp" ? r.sheet : null;
  const title = loc(r.title);
  const publisher = loc(r.publisher);
  const intro = loc(r.intro);
  // 三個 jsonb 欄位在 DB 有 is_localized() CHECK，理論上不會缺；跳過而不是崩掉，
  // 與 cms.ts / shop.ts 同一種姿態 —— 一列壞掉不該讓整頁 500。
  if (!id || !slug || !sheet || !title || !publisher || !intro) return null;
  return {
    id,
    slug,
    sheet,
    seq: typeof r.seq === "number" ? r.seq : 0,
    title,
    publisher,
    intro,
    region: typeof r.region === "string" ? r.region : "",
    issues: nullableStr(r.issues),
    externalUrl: nullableStr(r.external_url),
    coverImageKey: nullableStr(r.cover_image_key),
    productId: nullableStr(r.product_id),
  };
}

/**
 * Card-shaped publication — everything PublicationEntry has except `intro`
 * and `externalUrl`. /shop's loader used to preload all 126 publications'
 * `intro` up front — measured at roughly 227KB of the page's ~330KB SSR
 * payload (2026-09 前台載入速度優化).
 *
 * 2026-11（M4）起，介紹文住在每一本自己的頁面 /publications/$slug（SSR 輸出、
 * fetchPublicationBySlug()），列表卡片直接連過去；原本「點開卡片才現查介紹」的
 * fetchPublicationDetail() 已經沒有呼叫端，一併拿掉。列表仍然不帶 intro。
 * fetchPublications() 仍然沒有呼叫端，保留原樣。
 */
export type PublicationListEntry = Omit<PublicationEntry, "intro" | "externalUrl">;

const CARD_COLUMNS =
  "id, slug, sheet, seq, title, publisher, region, issues, cover_image_key, product_id";

function toCardEntry(r: Row): PublicationListEntry | null {
  const id = typeof r.id === "string" ? r.id : null;
  const slug = typeof r.slug === "string" ? r.slug : null;
  const sheet = r.sheet === "tw" || r.sheet === "jp" ? r.sheet : null;
  const title = loc(r.title);
  const publisher = loc(r.publisher);
  if (!id || !slug || !sheet || !title || !publisher) return null;
  return {
    id,
    slug,
    sheet,
    seq: typeof r.seq === "number" ? r.seq : 0,
    title,
    publisher,
    region: typeof r.region === "string" ? r.region : "",
    issues: nullableStr(r.issues),
    coverImageKey: nullableStr(r.cover_image_key),
    productId: nullableStr(r.product_id),
  };
}

export type PublicationListResult = {
  publications: PublicationListEntry[];
  unavailable: boolean;
};

export async function fetchPublicationsForList(): Promise<PublicationListResult> {
  const db = supabase;
  if (!db) {
    console.warn("[publications] unavailable — Supabase is not configured");
    return { publications: [], unavailable: true };
  }
  try {
    const { data, error } = await db
      .from("publications")
      .select(CARD_COLUMNS)
      .eq("is_published", true)
      .order("sheet", { ascending: false }) // tw 先於 jp
      .order("sort_order", { ascending: true })
      .order("seq", { ascending: true });

    if (error || !Array.isArray(data)) {
      console.warn(`[publications] unavailable — ${error?.message ?? "unexpected response shape"}`);
      return { publications: [], unavailable: true };
    }
    const publications: PublicationListEntry[] = [];
    for (const row of data as unknown as Row[]) {
      const e = toCardEntry(row);
      if (e) publications.push(e);
    }
    return { publications, unavailable: false };
  } catch (err) {
    console.warn(
      `[publications] unavailable — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { publications: [], unavailable: true };
  }
}

/**
 * 一本刊物的完整資料（/publications/$slug，2026-11 M4）。intro 只在這裡、在 SSR 讀——
 * 列表（fetchPublicationsForList）仍然不帶 intro，理由見上面 PublicationListEntry 的檔頭。
 *
 * 回傳語意與 src/lib/shop.ts#fetchActiveProductBySlug 相同：
 *   publication: null + unavailable: false → 查無此刊物（路由回 404）
 *   publication: null + unavailable: true  → 讀取失敗（路由回 503，不讓爬蟲以為頁面不見了）
 */
export async function fetchPublicationBySlug(
  slug: string,
): Promise<{ publication: PublicationEntry | null; unavailable: boolean }> {
  const db = supabase;
  if (!db) return { publication: null, unavailable: true };
  try {
    const { data, error } = await db
      .from("publications")
      .select(COLUMNS)
      .eq("slug", slug)
      .eq("is_published", true)
      .maybeSingle();
    if (error) {
      console.warn(`[publications] detail unavailable for ${slug} — ${error.message}`);
      return { publication: null, unavailable: true };
    }
    if (!data) return { publication: null, unavailable: false };
    const entry = toEntry(data as unknown as Row);
    // 列存在但三語欄位壞掉：當成讀取失敗（503），不是 404——那一本確實在。
    return entry
      ? { publication: entry, unavailable: false }
      : { publication: null, unavailable: true };
  } catch (err) {
    console.warn(
      `[publications] detail unavailable for ${slug} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { publication: null, unavailable: true };
  }
}

/**
 * /publications/TW-001 → 不分大小寫再找一次，剛好一筆而且大小寫不同才回傳正確寫法
 * （路由 301 過去）。與 shop.ts#findActiveProductSlugIgnoringCase 同一套。
 */
export async function findPublicationSlugIgnoringCase(slug: string): Promise<string | null> {
  const db = supabase;
  const pattern = exactIlikePattern(slug);
  if (!db || !pattern) return null;
  try {
    const { data, error } = await db
      .from("publications")
      .select("slug")
      .eq("is_published", true)
      .ilike("slug", pattern)
      .limit(5);
    if (error || !Array.isArray(data)) return null;
    return caseInsensitiveMatch(
      slug,
      (data as unknown as Row[]).map((r) => String(r.slug ?? "")),
    );
  } catch {
    return null;
  }
}

/**
 * 某件商品對應的刊物（/shop/$slug 用：有對應刊物的商品頁，canonical 指向刊物頁）。
 * 讀不到、沒有對應 → null（商品頁照原樣自我 canonical）。
 */
export async function fetchPublicationForProduct(
  productId: string,
): Promise<{ slug: string; title: Localized; intro: Localized } | null> {
  const db = supabase;
  if (!db || !productId) return null;
  try {
    const { data, error } = await db
      .from("publications")
      .select("slug, title, intro")
      .eq("product_id", productId)
      .eq("is_published", true)
      .order("seq", { ascending: true })
      .limit(1);
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const row = data[0] as unknown as Row;
    const title = loc(row.title);
    const intro = loc(row.intro);
    if (typeof row.slug !== "string" || !row.slug || !title || !intro) return null;
    return { slug: row.slug, title, intro };
  } catch {
    return null;
  }
}

export async function fetchPublications(): Promise<PublicationsResult> {
  const db = supabase;
  if (!db) {
    console.warn("[publications] unavailable — Supabase is not configured");
    return { publications: [], unavailable: true };
  }
  try {
    const { data, error } = await db
      .from("publications")
      .select(COLUMNS)
      .eq("is_published", true)
      .order("sheet", { ascending: false }) // tw 先於 jp
      .order("sort_order", { ascending: true })
      .order("seq", { ascending: true });

    if (error || !Array.isArray(data)) {
      console.warn(`[publications] unavailable — ${error?.message ?? "unexpected response shape"}`);
      return { publications: [], unavailable: true };
    }
    const publications: PublicationEntry[] = [];
    for (const row of data as unknown as Row[]) {
      const e = toEntry(row);
      if (e) publications.push(e);
    }
    return { publications, unavailable: false };
  } catch (err) {
    console.warn(
      `[publications] unavailable — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { publications: [], unavailable: true };
  }
}

// -----------------------------------------------------------------------------
// 關注地域的粗分類 —— 規則在 ./publication-regions.ts（純函式，selftest 直接 import）。
// -----------------------------------------------------------------------------
export {
  REGION_GROUP_OTHER,
  presentRegionGroups,
  regionGroupOf,
  regionGroupsFor,
  SHEET_LABELS,
  type RegionGroup,
} from "./publication-regions";

// -----------------------------------------------------------------------------
// 首頁「地方刊物典藏」區塊（2026-11 首頁改版）
// -----------------------------------------------------------------------------
/**
 * 首頁只需要三個數字（總數／台灣／日本）和幾張封面，不需要整份清單。
 *
 * 一支查詢讀回所有已發布刊物的「卡片最小欄位」（不含 intro），在 loader 裡就聚合成
 * 三個數字＋幾張封面再回傳——整份清單不會進 SSR payload（/shop 那份清單的教訓見上面
 * PublicationListEntry）。
 *
 * 封面挑法：與 /shop〈地方刊物〉同一個排序，但**每個地區只取第一本**（regionGroupOf 的粗分類），
 * 台灣 perSheet.tw 本、日本 perSheet.jp 本。照原排序直接取前幾本會全部是基隆（資料就是從
 * 基隆開始編號的），首頁要讓人一眼看到「各地」。
 *
 * 讀取失敗 → unavailable: true、counts: null，呼叫端改用不帶數字的文案，不顯示 0。
 */
export type PublicationTeaserCover = {
  slug: string;
  sheet: PublicationSheet;
  title: Localized;
  region: string;
  coverImageKey: string;
};

export type PublicationsTeaser = {
  counts: { total: number; tw: number; jp: number } | null;
  covers: PublicationTeaserCover[];
  unavailable: boolean;
};

export async function fetchPublicationsTeaser(
  perSheet: { tw: number; jp: number } = { tw: 4, jp: 2 },
): Promise<PublicationsTeaser> {
  const db = supabase;
  if (!db) return { counts: null, covers: [], unavailable: true };
  try {
    const { data, error } = await db
      .from("publications")
      .select("slug, sheet, title, region, cover_image_key")
      .eq("is_published", true)
      .order("sheet", { ascending: false }) // tw 先於 jp
      .order("sort_order", { ascending: true })
      .order("seq", { ascending: true });
    if (error || !Array.isArray(data)) {
      console.warn(`[publications] teaser unavailable — ${error?.message ?? "bad shape"}`);
      return { counts: null, covers: [], unavailable: true };
    }
    let tw = 0;
    let jp = 0;
    const covers: PublicationTeaserCover[] = [];
    const seenGroups = new Set<string>();
    const picked = { tw: 0, jp: 0 };
    for (const r of data as unknown as Row[]) {
      const sheet = r.sheet === "tw" || r.sheet === "jp" ? r.sheet : null;
      if (!sheet) continue;
      if (sheet === "tw") tw += 1;
      else jp += 1;
      if (picked[sheet] >= perSheet[sheet]) continue;
      const title = loc(r.title);
      const key = nullableStr(r.cover_image_key);
      const region = typeof r.region === "string" ? r.region : "";
      if (!title || !key || typeof r.slug !== "string") continue;
      const group = `${sheet}:${regionGroupOf({ sheet, region })}`;
      if (seenGroups.has(group)) continue;
      seenGroups.add(group);
      picked[sheet] += 1;
      covers.push({ slug: r.slug, sheet, title, region, coverImageKey: key });
    }
    return { counts: { total: tw + jp, tw, jp }, covers, unavailable: false };
  } catch (err) {
    console.warn(
      `[publications] teaser unavailable — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { counts: null, covers: [], unavailable: true };
  }
}
