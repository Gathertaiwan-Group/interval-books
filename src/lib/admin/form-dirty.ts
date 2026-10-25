/**
 * 「這張表單有沒有改過」的判斷（後台內頁的未存變更防呆用，見 UnsavedChangesGuard）。
 *
 * 比的是值，不是「有沒有打過字」：改了又改回原樣 → 不算改過，離開不會被問。
 * 物件的 key 先排序再序列化，`{ ...prev, ...patch }` 換了 key 的順序也不會誤判。
 *
 * stableStringify 純邏輯、零 import：selftest 直接 import()。
 */
import { useCallback, useMemo, useState } from "react";

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "undefined";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * current：表單現在的值。第一次 render 的值就是基準。
 * markClean(v)：存檔成功後把基準換成剛存進去的值（留在同一頁繼續編輯時用）。
 */
export function useFormDirty<T>(current: T): { dirty: boolean; markClean: (next: T) => void } {
  const [baseline, setBaseline] = useState(() => stableStringify(current));
  const now = stableStringify(current);
  const dirty = useMemo(() => now !== baseline, [now, baseline]);
  const markClean = useCallback((next: T) => setBaseline(stableStringify(next)), []);
  return { dirty, markClean };
}
