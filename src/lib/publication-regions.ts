/**
 * 地方刊物「關注地域」的粗分類 —— 純函式（2026-11 從 src/lib/publications.ts 搬出來）。
 *
 * 搬家的理由：刊物獨立頁（/publications/$slug）的 SEO 組裝與「同地區的其他刊物」要用
 * regionGroupOf()，而 scripts/publication-page-selftest.mjs 要直接 import 來跑真的行為測試。
 * publications.ts 會 import Supabase client（"@/lib/supabase"），selftest 沒有 "@/" 別名
 * 解析能力，所以分類規則放在這支**零 runtime import** 的檔案（只有 `import type`）。
 * publications.ts 原樣 re-export，既有的呼叫端不用改。
 */
import type { Localized } from "../i18n/types";

/** 原始 Excel 的兩張工作表。對應 publications.sheet 的 CHECK。 */
export type PublicationSheet = "tw" | "jp";

/** 分類只看這兩個欄位（PublicationEntry／PublicationListEntry 都直接傳得進來）。 */
export type RegionInput = { sheet: PublicationSheet; region: string };

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
export type RegionGroup = {
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
 * 只讀 sheet/region（RegionInput）。PublicationEntry、PublicationListEntry 都能直接傳進來，
 * 呼叫端不必轉型。
 */
export function regionGroupOf(entry: RegionInput): string {
  for (const g of regionGroupsFor(entry.sheet)) {
    if (g.match.some((m) => entry.region.includes(m))) return g.key;
  }
  return REGION_GROUP_OTHER.key;
}

/** 這批刊物實際用到的地域分類，照 regionGroupsFor 的順序，其他放最後。 */
export function presentRegionGroups(
  entries: readonly RegionInput[],
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
