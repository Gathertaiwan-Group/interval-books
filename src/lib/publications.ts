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

/** 原始 Excel 的兩張工作表。對應 publications.sheet 的 CHECK。 */
export type PublicationSheet = "tw" | "jp";

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
 * and `externalUrl`. Both fields only ever appear inside the "刊物介紹"
 * expand panel in PublicationsPanel.tsx, which starts closed for every card
 * and never runs a route loader on toggle (same "loader preloads once, no
 * per-interaction refetch" shape as the rest of this storefront). /shop's
 * loader used to preload all 126 publications' `intro` up front regardless —
 * measured at roughly 227KB of the page's ~330KB SSR payload (2026-09 前台
 * 載入速度優化), almost all of it text nobody reads unless they click "+" on
 * that specific title.
 *
 * fetchPublicationsForList() below is the list-safe read (used by /shop);
 * fetchPublicationDetail() fetches the two omitted fields for exactly one
 * publication, on demand, when its card is expanded — see
 * PublicationsPanel.tsx. fetchPublications() above is left untouched (still
 * correct, just currently unused after this change) rather than deleted,
 * matching this file's existing functions/types, which nothing else in the
 * repo imports as of this writing — a later cleanup pass can remove it once
 * that is confirmed to still hold.
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
 * The two fields a publication card only needs once expanded. Runs the same
 * anon client as every other read in this file (see the header — RLS, not
 * this function, is what keeps unpublished rows out of reach), called
 * directly from the browser by PublicationsPanel's "刊物介紹" toggle.
 *
 * `null` means "could not read it" — the caller must show a temporarily-
 * unavailable state, never blank text standing in for a real (empty) intro.
 * `id` comes from a row the visitor can already see in the list they were
 * just shown, so this is not exposing anything fetchPublicationsForList()
 * did not already make visible for that same row.
 */
export async function fetchPublicationDetail(
  id: string,
): Promise<{ intro: Localized; externalUrl: string | null } | null> {
  const db = supabase;
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("publications")
      .select("intro, external_url")
      .eq("id", id)
      .eq("is_published", true)
      .maybeSingle();
    if (error || !data) {
      console.warn(`[publications] detail unavailable for ${id} — ${error?.message ?? "no row"}`);
      return null;
    }
    const row = data as unknown as Row;
    const intro = loc(row.intro);
    if (!intro) return null;
    return { intro, externalUrl: nullableStr(row.external_url) };
  } catch (err) {
    console.warn(
      `[publications] detail unavailable for ${id} — ${err instanceof Error ? err.message : String(err)}`,
    );
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
// 關注地域的粗分類
// -----------------------------------------------------------------------------
/**
 * publications.region 是原文照抄的自由文字：「基隆-八斗子」「坪林北勢溪流域」
 * 「日本全國」「南部農漁村」都是原始資料裡的寫法。要能篩選就得有粗分類，而粗分類
 * 放在這裡而不是資料庫裡，理由有兩個：
 *
 *   1. 分類規則會改（今天「東北角」算新北，明天可能想獨立成一組），而原文不會改。
 *      規則寫在程式碼裡，改規則是一次部署；寫進資料庫就變成一次資料遷移。
 *   2. 原文才是可核對的東西。後台編輯的是原文，不是分類 —— 沒有人要維護第二份
 *      互相矛盾的欄位。
 *
 * 比對方式是**依序**找第一個出現的關鍵字，所以順序有意義：「新北」要排在
 * 「坪林／淡水／竹圍」這些鄉鎮名之前沒有關係（它們互不包含），但「高雄-屏東」
 * 這種橫跨兩地的寫法會落在先出現的那一組。
 */
type RegionGroup = {
  key: string;
  label: Localized;
  /** 只要 region 含有其中任一字串就歸到這一組。 */
  match: string[];
};

const TW_GROUPS: RegionGroup[] = [
  { key: "keelung", label: { zh: "基隆", en: "Keelung", ja: "基隆" }, match: ["基隆"] },
  {
    key: "new-taipei",
    label: { zh: "新北", en: "New Taipei", ja: "新北" },
    match: ["新北", "坪林", "淡水", "竹圍", "東北角"],
  },
  { key: "taipei", label: { zh: "台北", en: "Taipei", ja: "台北" }, match: ["台北", "臺北"] },
  { key: "taoyuan", label: { zh: "桃園", en: "Taoyuan", ja: "桃園" }, match: ["桃園"] },
  { key: "hsinchu", label: { zh: "新竹", en: "Hsinchu", ja: "新竹" }, match: ["新竹"] },
  { key: "miaoli", label: { zh: "苗栗", en: "Miaoli", ja: "苗栗" }, match: ["苗栗"] },
  { key: "taichung", label: { zh: "台中", en: "Taichung", ja: "台中" }, match: ["台中", "臺中"] },
  { key: "changhua", label: { zh: "彰化", en: "Changhua", ja: "彰化" }, match: ["彰化", "鹿港"] },
  { key: "nantou", label: { zh: "南投", en: "Nantou", ja: "南投" }, match: ["南投"] },
  { key: "chiayi", label: { zh: "嘉義", en: "Chiayi", ja: "嘉義" }, match: ["嘉義"] },
  {
    key: "tainan",
    label: { zh: "台南", en: "Tainan", ja: "台南" },
    match: ["台南", "臺南", "曾文溪"],
  },
  {
    key: "kaohsiung",
    label: { zh: "高雄", en: "Kaohsiung", ja: "高雄" },
    match: ["高雄", "美濃", "鹽埕"],
  },
  { key: "pingtung", label: { zh: "屏東", en: "Pingtung", ja: "屏東" }, match: ["屏東"] },
  { key: "yilan", label: { zh: "宜蘭", en: "Yilan", ja: "宜蘭" }, match: ["宜蘭", "龜山島"] },
  { key: "hualien", label: { zh: "花蓮", en: "Hualien", ja: "花蓮" }, match: ["花蓮"] },
  {
    key: "taitung",
    label: { zh: "台東", en: "Taitung", ja: "台東" },
    match: ["台東", "臺東", "綠島", "蘭嶼"],
  },
  { key: "penghu", label: { zh: "澎湖", en: "Penghu", ja: "澎湖" }, match: ["澎湖"] },
  { key: "kinmen", label: { zh: "金門", en: "Kinmen", ja: "金門" }, match: ["金門"] },
  { key: "hongkong", label: { zh: "香港", en: "Hong Kong", ja: "香港" }, match: ["香港"] },
];

const JP_GROUPS: RegionGroup[] = [
  { key: "hokkaido", label: { zh: "北海道", en: "Hokkaido", ja: "北海道" }, match: ["北海道"] },
  { key: "akita", label: { zh: "秋田", en: "Akita", ja: "秋田" }, match: ["秋田"] },
  { key: "yamagata", label: { zh: "山形", en: "Yamagata", ja: "山形" }, match: ["山形"] },
  { key: "fukushima", label: { zh: "福島", en: "Fukushima", ja: "福島" }, match: ["福島", "福嶋"] },
  { key: "tochigi", label: { zh: "栃木", en: "Tochigi", ja: "栃木" }, match: ["栃木"] },
  { key: "yamanashi", label: { zh: "山梨", en: "Yamanashi", ja: "山梨" }, match: ["山梨"] },
  {
    key: "kanagawa",
    label: { zh: "神奈川", en: "Kanagawa", ja: "神奈川" },
    match: ["神奈川"],
  },
  { key: "nara", label: { zh: "奈良", en: "Nara", ja: "奈良" }, match: ["奈良"] },
  { key: "shimane", label: { zh: "島根", en: "Shimane", ja: "島根" }, match: ["島根"] },
  { key: "kyushu", label: { zh: "九州", en: "Kyushu", ja: "九州" }, match: ["九州"] },
  {
    key: "nationwide",
    label: { zh: "日本全國", en: "Nationwide", ja: "日本全国" },
    match: ["日本全國", "日本全国"],
  },
];

/** 落不進任何一組的：跨區域、全台、主題性的，以及原始資料填錯的那一筆。 */
export const REGION_GROUP_OTHER: RegionGroup = {
  key: "other",
  label: { zh: "跨區域／其他", en: "Cross-region / Other", ja: "広域・その他" },
  match: [],
};

export function regionGroupsFor(sheet: PublicationSheet): RegionGroup[] {
  return sheet === "tw" ? TW_GROUPS : JP_GROUPS;
}

/**
 * 一本刊物的地域分類鍵。找不到就是 REGION_GROUP_OTHER.key。
 *
 * 參數型別是 PublicationListEntry（2026-09）：只讀 sheet/region，intro／
 * externalUrl 從來沒被用過。PublicationEntry 仍然能直接傳進來（它是
 * PublicationListEntry 多兩個欄位），呼叫端不必轉型。
 */
export function regionGroupOf(entry: Pick<PublicationListEntry, "sheet" | "region">): string {
  for (const g of regionGroupsFor(entry.sheet)) {
    if (g.match.some((m) => entry.region.includes(m))) return g.key;
  }
  return REGION_GROUP_OTHER.key;
}

/** 這批刊物實際用到的地域分類，照 regionGroupsFor 的順序，其他放最後。 */
export function presentRegionGroups(
  entries: PublicationListEntry[],
  sheet: PublicationSheet,
): RegionGroup[] {
  const used = new Set(entries.filter((e) => e.sheet === sheet).map(regionGroupOf));
  const groups = regionGroupsFor(sheet).filter((g) => used.has(g.key));
  if (used.has(REGION_GROUP_OTHER.key)) groups.push(REGION_GROUP_OTHER);
  return groups;
}

export const SHEET_LABELS: Record<PublicationSheet, Localized> = {
  tw: { zh: "台灣刊物", en: "Taiwan", ja: "台湾の刊行物" },
  jp: { zh: "日本刊物", en: "Japan", ja: "日本の刊行物" },
};

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
