/**
 * 活動頁判斷「場次開始了沒」用的那個時間點。
 *
 * 規則本身只有一份：src/lib/event-status.ts 的 isSessionClosedForBooking()——場次
 * starts_at 一到就不收新訂單，結帳伺服器、資料庫 reserve_session_seat() 用的是同一條。
 * 這支 hook 不判斷任何東西，只負責回答「拿哪個 now 去問那條規則」。
 *
 * ── 1. SSR 與第一次 hydrate 必須是同一個 now ──────────────────────────────
 * 初始值是 loader 帶下來的 `loadedAt`（伺服器算 HTML 的那一刻，跟著 loader 資料序列化），
 * 不是 Date.now()。開場那一秒伺服器說「還可以報名」、瀏覽器說「已結束」，就是 React
 * #418 hydration mismatch。延續 a61488a 結帳頁的做法。
 *
 * ── 2. 快取的 HTML 會比現在舊 ────────────────────────────────────────────
 * /events/* 走 src/server/cache-policy.ts 的 `s-maxage=60, stale-while-revalidate=600`：
 * CDN 最多可能吐出 11 分鐘前算的 HTML，超過可以接受的 1 分鐘。所以掛載後**立刻**用
 * 瀏覽器時間校正一次（在 effect 裡，hydrate 已經完成，不會 mismatch）。
 *
 * 瀏覽器時鐘慢的人：`offset = max(0, loadedAt - Date.now())`。HTML 是新鮮的時候
 * loadedAt 約等於伺服器現在，客人時鐘慢 5 分鐘 → offset 補回 5 分鐘；HTML 是快取的
 * 舊頁時 loadedAt 比較早，offset 落到 0，直接用客人時鐘。只往前補、不往回拉，所以
 * 時間永遠不會比伺服器算 HTML 的那一刻早。時鐘快的人會提早看到「已結束」——方向是
 * 收緊（fail closed），與 isSessionClosedForBooking 讀不懂時間就當已開始同一個立場；
 * 真正擋下單的仍是伺服器 priceLines() 與資料庫那兩道。
 *
 * ── 3. 頁面開著時，時間一到就停用：計時器排在「下一個場次的 starts_at」 ────
 * 不用每分鐘輪詢，理由：
 *   · 驗收要的是「開始當秒就停用」。每分鐘檢查最多會晚 59 秒，那 59 秒內頁面上的
 *     「我要報名」按得下去、到結帳頁才被擋，正是這次要消掉的情況。
 *   · 一頁通常只有一兩個未來場次，排一個 setTimeout 就夠，沒有東西要輪詢。
 * 計時器的兩個已知弱點各自補上：
 *   · 背景分頁／電腦睡眠時計時器會被節流或暫停 → visibilitychange、focus、pageshow
 *     （bfcache 回來）都會立刻重算一次。
 *   · setTimeout 的延遲超過 2^31-1 ms（約 24.8 天）會溢位成「立刻觸發」→ 單次最多睡
 *     MAX_TIMER_DELAY_MS，醒來重排。
 * 計時器提早幾毫秒醒來（不同時鐘來源）也沒關係：醒來重算，還沒到就再排一次。
 */
import { useEffect, useMemo, useState } from "react";

/** 單次計時器最長睡多久。遠小於 setTimeout 的溢位上限，也讓時鐘漂移有機會被校正。 */
export const MAX_TIMER_DELAY_MS = 60 * 60 * 1000;

/**
 * 下一個「會讓某個場次從可報名變成已截止」的時間點：嚴格晚於 now 的最早 starts_at。
 * isSessionClosedForBooking 的條件是 `starts_at <= now`，所以 starts_at === now 的
 * 場次已經是關的，不算「下一個」。沒有 → null（不用排計時器）。
 */
export function nextBookingCutoff(
  sessions: ReadonlyArray<{ startsAt?: string | null }>,
  now: number,
): number | null {
  let next: number | null = null;
  for (const s of sessions) {
    if (!s.startsAt) continue;
    const t = Date.parse(s.startsAt);
    if (Number.isNaN(t) || t <= now) continue;
    if (next === null || t < next) next = t;
  }
  return next;
}

/** 排下一次重算要等多久（毫秒）。沒有下一個場次 → null。 */
export function bookingTimerDelay(
  sessions: ReadonlyArray<{ startsAt?: string | null }>,
  now: number,
): number | null {
  const next = nextBookingCutoff(sessions, now);
  return next === null ? null : Math.min(next - now, MAX_TIMER_DELAY_MS);
}

/**
 * 掛載時的時鐘校正量（見檔頭第 2 點）：只補瀏覽器時鐘比 loader 慢的那一段。
 */
export function bookingClockOffset(loadedAt: number, clientNow: number): number {
  return Math.max(0, loadedAt - clientNow);
}

/**
 * @param loadedAt  loader 回傳的 `now`（伺服器時間）。SSR 與第一次 render 都用它。
 * @param sessions  這一頁畫得出來的場次。只讀 startsAt，用來排下一次重算。
 * @returns 拿去問 isSessionClosedForBooking() 的 now。只會往前走。
 */
export function useBookingNow(
  loadedAt: number,
  sessions: ReadonlyArray<{ startsAt?: string | null }>,
): number {
  const [now, setNow] = useState(loadedAt);
  // 以 starts_at 字串當依賴，不是陣列本身：每次 render 都是新陣列，拿它當依賴會讓
  // effect 每次 render 都拆掉重排。ISO 字串裡沒有 "|"。
  const startsKey = sessions.map((s) => s.startsAt ?? "").join("|");
  const starts = useMemo(
    () => (startsKey ? startsKey.split("|").map((startsAt) => ({ startsAt })) : []),
    [startsKey],
  );

  useEffect(() => {
    const offset = bookingClockOffset(loadedAt, Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sync = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const current = Date.now() + offset;
      setNow((prev) => (current > prev ? current : prev));
      const delay = bookingTimerDelay(starts, current);
      if (delay !== null) timer = setTimeout(sync, delay);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };

    sync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", sync);
    window.addEventListener("pageshow", sync);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, [loadedAt, starts]);

  return now;
}
