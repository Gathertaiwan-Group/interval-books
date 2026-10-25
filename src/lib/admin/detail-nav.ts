/**
 * 後台內頁「← 回到列表」要不要用瀏覽器的上一頁（2026-10-25 後台第 2 批：彈窗改內頁）。
 *
 * 業主：「不要用彈窗，直接顯示內頁＆回到上一頁」。回到列表有兩種做法：
 *
 *   · history.back()：回到**一模一樣**的列表——網址參數（分頁籤、篩選）、捲動位置
 *     （router 的 scrollRestoration）、30 秒內的 loader 快取，全部原樣。
 *   · navigate(列表)：開一個新的歷史紀錄，捲動回頂端。
 *
 * 只有在「上一筆歷史紀錄就是那個列表」時才能用第一種；否則（直接打開內頁網址、從
 * 別的頁面點進來、重新整理過）按「上一頁」會跑到別的地方，甚至離開網站。
 *
 * 判斷方式：每次換頁完成（router 的 onResolved）記下「這一筆歷史紀錄的前一筆是哪個
 * pathname」。只記用 push 進來的那一筆（目標的 __TSR_index ＝ 來源 + 1）；
 * 按上一頁／下一頁回來的不記，replace 沿用原本那筆的記錄。
 *
 * 只記 pathname，不記任何資料。純邏輯、零 import：selftest 直接 import()。
 */

type LocationLike = { pathname: string; state?: { __TSR_index?: unknown } | null };

/** 歷史紀錄第 i 筆 → 它前一筆（i-1）的 pathname。只在瀏覽器端寫入。 */
const previousPathnameByIndex = new Map<number, string>();

function historyIndex(loc: LocationLike | undefined): number | null {
  const v = loc?.state?.__TSR_index;
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/** router.subscribe("onResolved") 每次換頁完成時呼叫。 */
export function noteAdminNavigation(from: LocationLike | undefined, to: LocationLike): void {
  const toIndex = historyIndex(to);
  const fromIndex = historyIndex(from);
  if (toIndex === null || fromIndex === null || !from) return;
  if (toIndex === fromIndex + 1) {
    // push：這一筆的前一筆就是來源。push 之後瀏覽器會丟掉「下一頁」那些紀錄。
    previousPathnameByIndex.set(toIndex, from.pathname);
    for (const k of [...previousPathnameByIndex.keys()]) {
      if (k > toIndex) previousPathnameByIndex.delete(k);
    }
  }
  // replace（同一個 index）：前一筆沒變，沿用。上一頁／下一頁：不改任何記錄。
}

/**
 * 目前這一筆歷史紀錄（index）的前一筆，是不是 listPathname 那個列表。
 * true → 「回到列表」可以直接 history.back()。
 */
export function previousEntryIsList(currentIndex: unknown, listPathname: string): boolean {
  if (typeof currentIndex !== "number") return false;
  const prev = previousPathnameByIndex.get(currentIndex);
  return prev !== undefined && normalize(prev) === normalize(listPathname);
}

function normalize(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * src/router.tsx 在瀏覽器端建好 router 之後呼叫。參數刻意用最小的形狀：直接在 getRouter()
 * 裡寫 router.subscribe(..., (e) => …) 會讓 getRouter 的回傳型別參照到自己，整個專案的
 * loader 型別塌成 any。
 */
export function registerAdminDetailNav(router: {
  subscribe: (
    event: "onResolved",
    fn: (e: { fromLocation?: LocationLike; toLocation: LocationLike }) => void,
  ) => () => void;
}): void {
  router.subscribe("onResolved", (e) => noteAdminNavigation(e.fromLocation, e.toLocation));
}

/** selftest 用。 */
export function resetAdminDetailNavForTests(): void {
  previousPathnameByIndex.clear();
}

type HistoryLike = { location: { state: { __TSR_index?: unknown } }; back: () => void };

/**
 * 上一筆歷史紀錄是 pathnames 其中之一 → history.back() 並回傳 true；否則什麼都不做、回傳 false
 * （呼叫端自己 navigate）。內頁存檔後回詳情、刪除後回列表用。
 */
export function backIfPreviousIs(history: HistoryLike, pathnames: readonly string[]): boolean {
  const index = history.location.state.__TSR_index;
  if (!pathnames.some((p) => previousEntryIsList(index, p))) return false;
  history.back();
  return true;
}
