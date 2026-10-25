/**
 * 勾選以 id 存的列表：背景重抓回來時，只拿掉「剛剛還在畫面上、這一次不見了」的 id
 * （2026-10-25 後台第 2 批，配合 useLoaderBackedList）。
 *
 * 為什麼不是「新資料裡沒有的 id 全部拿掉」：進貨頁換分頁**不清勾選**（原本就是這樣，
 * 批次修改可以跨頁勾），第 1 頁勾的 id 本來就不在第 2 頁的資料裡。這裡只處理
 * 「同一組篩選、資料換了一份」——也就是別人刪掉／這一頁寫入後那一列消失了——
 * 其他勾選一個都不動，使用者勾到一半的東西不會被背景更新洗掉。
 *
 * ⚠️ 換篩選那一下（loading = true、畫面上還是舊資料）不算數：等新篩選的資料回來，
 *    把它記成新的基準就好，不拿它跟上一組篩選的資料比。
 */
import { useEffect, useRef } from "react";

/**
 * 純邏輯（selftest 直接 import）：上一份資料有、這一份沒有的 id 從勾選拿掉；
 * 不在上一份資料裡的勾選（例如別的分頁勾的）一個都不動。沒變就回傳同一個陣列。
 */
export function pruneVanishedIds(
  selected: string[],
  prevIds: readonly string[],
  nextIds: readonly string[],
): string[] {
  const alive = new Set(nextIds);
  const vanished = new Set(prevIds.filter((id) => !alive.has(id)));
  if (vanished.size === 0) return selected;
  const next = selected.filter((id) => !vanished.has(id));
  return next.length === selected.length ? selected : next;
}

export function usePruneVanishedSelection(
  rowIds: readonly string[],
  filterKey: string,
  loading: boolean,
  setSelectedIds: (update: (cur: string[]) => string[]) => void,
) {
  const base = useRef({ key: filterKey, ids: rowIds });

  useEffect(() => {
    if (loading) return;
    const prev = base.current;
    base.current = { key: filterKey, ids: rowIds };
    if (prev.ids === rowIds || prev.key !== filterKey) return;
    setSelectedIds((cur) => pruneVanishedIds(cur, prev.ids, rowIds));
  }, [rowIds, filterKey, loading, setSelectedIds]);
}
