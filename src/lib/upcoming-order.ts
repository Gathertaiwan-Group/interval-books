/**
 * 「近期」活動與策旅的排序（2026-11-10 業主：「活動都是先顯示日期最近的」）。
 *
 * 規則：依「下一個尚未結束的場次」的開始時間，由近到遠。
 *   · 多場次的活動：取最近一場還沒結束的場次（已結束的場次不算；正在進行中的跨日場次算，
 *     它的開始時間已過，所以排最前面）。
 *   · 包場活動：場次是 closed、anon 讀不到，時間由 private-booking 的 server fn 補進月曆資料
 *     （src/lib/events-calendar-data.ts），所以一樣參與排序。
 *   · 讀不到任何場次時間（沒有場次、只有活動日期、外部網址的策旅）：排最後，彼此維持原本順序。
 *
 * 資料來源是月曆的條目（fetchCalendarEntries → CalendarEntry），首頁與 /events 用同一份，
 * 判準只有一個。月曆讀取失敗時條目是空的 → 全部視為沒有時間 → 維持原本順序（不壞）。
 *
 * ⚠️ 零 runtime import：scripts/events-merge-selftest.mjs 直接 import。
 */

/** CalendarEntry 裡排序用得到的欄位。 */
export type StartEntry = {
  /** 場次 id；只有活動日期、沒有場次的條目是 "event:<slug>"（不算場次時間）。 */
  key: string;
  slug: string;
  /** 場次開始時間（ms）。 */
  sortMs: number;
  /** 場次已結束（結束時間──沒填就是開始時間──已過）。 */
  ended: boolean;
  /** 報名截止：一般活動（非包場）的場次被後台關閉、活動照常舉辦（月曆補讀的那幾筆）。 */
  registrationClosed?: boolean;
};

/** 「報名截止」三語（卡片小標與月曆共用）。 */
export const REGISTRATION_CLOSED_LABEL = {
  zh: "報名截止",
  en: "Registration closed",
  ja: "受付終了",
} as const;

/**
 * 哪些活動的「下一個尚未結束的場次」是報名截止（closed 且非包場）。與 nextStartBySlug()
 * 同一個「下一場」：已結束的、只有活動日期（event:<slug>）的不算；同時刻多場時任一場開放
 * 就不算截止。排序不受影響（業主 2026-11-10：報名截止的場次繼續顯示、照時間排）。
 */
export function nextSessionClosedSlugs(entries: ReadonlyArray<StartEntry>): Set<string> {
  const next = new Map<string, { ms: number; closed: boolean }>();
  for (const e of entries) {
    if (e.ended || e.key.startsWith("event:") || !Number.isFinite(e.sortMs)) continue;
    const closed = e.registrationClosed === true;
    const prev = next.get(e.slug);
    if (prev === undefined || e.sortMs < prev.ms) next.set(e.slug, { ms: e.sortMs, closed });
    else if (e.sortMs === prev.ms && !closed) prev.closed = false;
  }
  const out = new Set<string>();
  for (const [slug, v] of next) if (v.closed) out.add(slug);
  return out;
}

/** 每場活動（events.slug）→ 下一個尚未結束的場次開始時間（ms）。沒有 → 不在 map 裡。 */
export function nextStartBySlug(entries: ReadonlyArray<StartEntry>): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.ended || e.key.startsWith("event:") || !Number.isFinite(e.sortMs)) continue;
    const prev = out.get(e.slug);
    if (prev === undefined || e.sortMs < prev) out.set(e.slug, e.sortMs);
  }
  return out;
}

/** 依 startOf() 由近到遠排序；undefined／null 排最後。穩定排序，不改動傳入的陣列。 */
export function sortByNextStart<T>(
  items: ReadonlyArray<T>,
  startOf: (item: T) => number | null | undefined,
): T[] {
  return items
    .map((item, i) => ({ item, i, t: startOf(item) }))
    .sort((a, b) => {
      const ta = a.t ?? Infinity;
      const tb = b.t ?? Infinity;
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.item);
}
