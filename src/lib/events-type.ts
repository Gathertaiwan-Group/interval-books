/**
 * /events「活動與策旅」合併頁的類型篩選（2026-11-10：/events 與 /journeys 兩個列表頁合併）。
 *
 * ⚠️ 這支模組刻意**零 runtime import**：scripts/events-merge-selftest.mjs 用相對路徑直接
 *    import 它跑行為測試（selftest 沒有 "@/..." 別名解析能力）。
 *
 * ── 網址 ────────────────────────────────────────────────────────────────────
 *   /events                 全部（預設；站內沒帶 search 的 <Link to="/events"> 都落在這裡）
 *   /events?type=event      只看活動
 *   /events?type=journey    只看策旅（舊的 /journeys 301 到這裡）
 * 與既有的 ?view=list|calendar、?month=YYYY-MM 互不干擾、可以同時存在、可以分享。
 * canonical 一律是乾淨的 /events（canonicalUrl() 只對 /shop 保留 ?tab），三種篩選不會
 * 被當成三個重複頁收錄。
 *
 * ── 列表的排法（為什麼「全部」是分兩段，不是依日期混排）───────────────────────
 * 策旅與活動是兩種形狀不同的東西：策旅是三天兩夜、票價高、一年只有幾趟，卡片印天數＋
 * 主題＋日期區間＋票價；活動是一個下午的講座，卡片印分類與日期。兩種卡片依日期混在
 * 同一個格線裡，每一張長得都不一樣、讀者得逐張辨認「這張是哪一種」。分兩段、各有一個
 * 小標（與首頁「近期活動與策旅」同一個做法）就沒有這個問題；策旅放前面，因為筆數少、
 * 需要提早規劃，放在後面會被一整排講座淹沒。
 */

export type EventsType = "event" | "journey";

/** 篩選列的三格（順序就是畫面上的順序）。"all" 對應網址上沒有 type。 */
export const EVENTS_TYPE_OPTIONS = ["all", "event", "journey"] as const;
export type EventsTypeOption = (typeof EVENTS_TYPE_OPTIONS)[number];

/** ?type= 的解析：只認 event／journey，其他（含 all、大小寫不同、陣列）一律視為「全部」。 */
export function parseTypeParam(value: unknown): EventsType | undefined {
  return value === "event" || value === "journey" ? value : undefined;
}

/** 篩選列某一格對應的 type 參數（"all" → undefined，網址上就不帶 type）。 */
export function typeParamFor(option: EventsTypeOption): EventsType | undefined {
  return option === "all" ? undefined : option;
}

/** 目前網址的 type 參數對應到篩選列的哪一格。 */
export function optionFor(type: EventsType | undefined): EventsTypeOption {
  return type ?? "all";
}

export const showsEvents = (type: EventsType | undefined) => type !== "journey";
export const showsJourneys = (type: EventsType | undefined) => type !== "event";

/** 月曆條目依類型篩選（CalendarEntry.kind）。沒有 type → 原樣回傳。 */
export function filterByKind<T extends { kind: EventsType }>(
  entries: ReadonlyArray<T>,
  type: EventsType | undefined,
): T[] {
  return type ? entries.filter((e) => e.kind === type) : [...entries];
}

/**
 * 「全部」模式的過往卡片區：策旅與活動各自已經是「最近結束的在前」，這裡依結束日
 * （YYYY-MM-DD 字串，可直接比大小）合併成一列，取前 limit 筆。同一天結束時策旅在前。
 */
export function mergeNewestEnded<T extends { endDate: string }>(
  journeys: ReadonlyArray<T>,
  events: ReadonlyArray<T>,
  limit: number,
): T[] {
  return [...journeys, ...events]
    .map((item, i) => ({ item, i }))
    .sort((a, b) =>
      a.item.endDate === b.item.endDate ? a.i - b.i : a.item.endDate < b.item.endDate ? 1 : -1,
    )
    .slice(0, limit)
    .map((x) => x.item);
}

/**
 * 舊網址 /journeys 的去處（src/routes/journeys.tsx 的 301）。/en/journeys、/ja/journeys
 * 由 router 的 lang rewrite 自動帶回語言前綴（與 /visit → /about 同一套）。
 */
export const JOURNEYS_REDIRECT = { to: "/events", search: { type: "journey" } } as const;
