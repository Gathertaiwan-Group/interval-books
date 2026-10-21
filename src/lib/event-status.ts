/**
 * 活動是「已結束」還是「還沒到」。
 *
 * 規則只有一條：**活動日期的隔天起算已結束。** 活動當天仍然是進行中 —— 早上十點
 * 的工作坊，當天下午還看得到它在列表上，那是對的。
 *
 * ── 🔴 為什麼時區要寫死 ──────────────────────────────────────────────────
 * 這個站是 SSR 的。用 `new Date().getDate()` 那一組讀的是「執行環境」的時區：
 * 伺服器跑在 UTC，台北時間 9/5 早上八點時 UTC 還是 9/5 凌晨，看起來沒問題；但
 * 台北時間 9/6 早上七點時 UTC 才 9/5 23:00 —— 於是伺服器算出「還沒結束」而瀏覽器
 * 算出「已結束」，同一張卡片在 hydrate 前後跳一次。
 *
 * 同一個教訓在 src/components/shop/SessionPicker.tsx 的 formatSessionWhen() 已經
 * 踩過一次（10:00 的場次被 SSR 畫成 02:00）。這裡從一開始就寫死。
 */
const EVENT_TIME_ZONE = "Asia/Taipei";

const YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: EVENT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 今天（台北）的 YYYY-MM-DD。 */
export function todayInTaipei(now: Date = new Date()): string {
  return YMD.format(now);
}

/**
 * 已結束？
 *
 * ⚠️ `isoDate` 為 null 時回 **false** —— 「沒有日期」不等於「已經結束」。正式庫
 *    裡確實有這種活動（display_date 是「即將公告」），把它們掃進已結束區等於讓
 *    還沒公布日期的活動從列表上消失。判不出來就留在進行中，這是刻意的。
 *
 * 字串直接比大小是安全的：兩邊都是 YYYY-MM-DD，字典序等於時間序。
 */
export function isPastEvent(isoDate: string | null | undefined, today = todayInTaipei()): boolean {
  if (!isoDate) return false;
  return isoDate < today;
}

/**
 * 一場活動的場次裡，最晚那一場的「結束日」（台北 YYYY-MM-DD）。沒有場次 → null。
 *
 * 每一場取 `endsAt`，沒填就退回 `startsAt`。時間字串讀不懂的那一場略過（不是拋錯：
 * 這個值只用來**延後**「已結束」，略過頂多退回 iso_date 的舊規則）。
 */
export function latestSessionEndDate(
  sessions: ReadonlyArray<{ startsAt?: string | null; endsAt?: string | null }>,
): string | null {
  let latest: string | null = null;
  for (const s of sessions) {
    const raw = s.endsAt || s.startsAt;
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) continue;
    const ymd = todayInTaipei(new Date(t));
    if (latest === null || ymd > latest) latest = ymd;
  }
  return latest;
}

/**
 * 活動列表用的「已結束」：**還有今天或之後的場次就不算結束。**
 *
 * ── 為什麼不能只看 iso_date ───────────────────────────────────────────────
 * 2026-10-21《海的聲音》從 /events「報名中」消失：它的 iso_date 是 2026-10-20 ——
 * 顯示日期「2026.10.20~11.7」的**開頭**——但唯一的場次在 11/6，票還在賣。
 * iso_date 是人手填的，填成區間開頭的人不會是最後一個。場次時間是報名本來就要
 * 的資料，所以拿它來兜底：
 *
 *   · iso_date 為 null → 不算結束（理由見 isPastEvent；場次只能**延後**、不會提早）
 *   · 否則取 max(iso_date, 最晚場次結束日)，早於今天才算結束
 *   · 沒有場次（外部報名、場次讀不到）→ 等同 isPastEvent(iso_date) 的舊規則
 */
export function isEventPast(
  event: { isoDate: string | null | undefined; lastSessionDate?: string | null },
  today = todayInTaipei(),
): boolean {
  if (!event.isoDate) return false;
  const last = event.lastSessionDate;
  const effective = last && last > event.isoDate ? last : event.isoDate;
  return isPastEvent(effective, today);
}
