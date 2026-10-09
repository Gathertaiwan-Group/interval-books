/**
 * 〈地方刊物〉分頁的篩選：先選國家（工作表），再選地區。
 *
 * 2026-10 業主看過 /shop 之後說「篩選設計太複雜」：原本「關注地域」是一整片約 30 顆
 * chips（基隆、新北…金門、香港、跨區域／其他、北海道…日本全國），手機上佔 7 行。
 * 改成國家三段切換＋一個原生 <select>。這個檔案是那個介面背後的純函式——不碰
 * React、不碰資料庫，PublicationsPanel.tsx 只負責把結果畫出來。
 *
 * 🔴 「篩出哪幾本」的語意跟舊的 chips **完全相同**，換的只是選的方式：
 *
 *   國家：sheet === "all" → 全部；否則 e.sheet === sheet
 *   地區：region === "all" → 全部；否則 regionGroupOf(e) === region
 *
 *   粗分類一律問 lib/publications.ts 的 regionGroupOf()／presentRegionGroups()，
 *   這裡不重寫任何一條比對規則。
 *
 * ⚠️ 「跨區域／其他」（REGION_GROUP_OTHER）在台灣與日本兩份清單裡是同一個 key
 *    "other"。國家選「全部」時它只出現一次、自成「其他」一組，選了會同時篩出兩國
 *    的「其他」——跟舊 chips 把兩顆同名按鈕合成一顆是同一個行為。
 */
import type { Localized } from "@/i18n/types";
import {
  presentRegionGroups,
  REGION_GROUP_OTHER,
  regionGroupOf,
  type PublicationListEntry,
  type PublicationSheet,
} from "@/lib/publications";

/** 國家切換的三個值。"all" = 不分國家。 */
export type SheetFilter = "all" | PublicationSheet;

/** 地區下拉的「所有地區」。regionGroupsFor() 裡沒有任何一組的 key 叫 "all"。 */
export const ALL_REGIONS = "all";

export function entriesForSheet(
  entries: PublicationListEntry[],
  sheet: SheetFilter,
): PublicationListEntry[] {
  return sheet === "all" ? entries : entries.filter((e) => e.sheet === sheet);
}

export function entriesForRegion(
  entries: PublicationListEntry[],
  region: string,
): PublicationListEntry[] {
  return region === ALL_REGIONS ? entries : entries.filter((e) => regionGroupOf(e) === region);
}

/** 下拉裡的一個地區：count = 選了它之後會列出幾本。 */
export type RegionOption = { key: string; label: Localized; count: number };

/** 一組選項。group 為 null = 不包 <optgroup>（只選了一個國家的時候）。 */
export type RegionOptionGroup = {
  group: PublicationSheet | "other" | null;
  options: RegionOption[];
};

/**
 * 地區下拉的選項。`entries` 是已經照國家篩過的那一批，所以只會列出目前這個國家
 * 底下真的有刊物的地區。
 *
 *   國家 = 台灣／日本 → 一組、不分 optgroup；「跨區域／其他」照 presentRegionGroups 放最後
 *   國家 = 全部       → 台灣／日本／其他三組（沒有選項的那一組不出現）
 *
 * 每一本刊物剛好落在一個地區（regionGroupOf 找不到就是 other），所以同一個國家底下
 * 所有選項的 count 加起來，一定等於那個國家的本數。
 */
export function regionOptionGroups(
  entries: PublicationListEntry[],
  sheet: SheetFilter,
): RegionOptionGroup[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = regionGroupOf(e);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const toOption = (g: { key: string; label: Localized }): RegionOption => ({
    key: g.key,
    label: g.label,
    count: counts.get(g.key) ?? 0,
  });

  if (sheet !== "all") {
    return [{ group: null, options: presentRegionGroups(entries, sheet).map(toOption) }];
  }

  const ofSheet = (s: PublicationSheet): RegionOptionGroup => ({
    group: s,
    options: presentRegionGroups(entries, s)
      .filter((g) => g.key !== REGION_GROUP_OTHER.key)
      .map(toOption),
  });
  const other: RegionOptionGroup = {
    group: "other",
    options: counts.has(REGION_GROUP_OTHER.key) ? [toOption(REGION_GROUP_OTHER)] : [],
  };
  return [ofSheet("tw"), ofSheet("jp"), other].filter((g) => g.options.length > 0);
}

/**
 * 換國家之後，原本選的地區還留不留：新國家底下還有這個地區的刊物就留（例如從
 * 「全部＋基隆」切到「台灣刊物」），沒有就回到「所有地區」。留著一個新選單裡
 * 不存在的值，<select> 會顯示空白，結果是 0 本。
 */
export function regionAfterSheetChange(
  entries: PublicationListEntry[],
  nextSheet: SheetFilter,
  region: string,
): string {
  if (region === ALL_REGIONS) return ALL_REGIONS;
  const stillThere = entriesForSheet(entries, nextSheet).some((e) => regionGroupOf(e) === region);
  return stillThere ? region : ALL_REGIONS;
}
