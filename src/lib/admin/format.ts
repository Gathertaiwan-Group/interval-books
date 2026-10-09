/**
 * Display formatting helpers shared by the admin list pages. Kept separate
 * from schemas.ts (validation) and middleware.ts (auth) — this file has no
 * server-only concerns and is imported directly by route components.
 */

/**
 * Formats a Postgres `timestamptz` string (e.g. a row's `updated_at`, as
 * returned verbatim by the repos in src/server/repos/**) into the
 * Taiwan-conventional "YYYY/MM/DD HH:mm" string used in admin table columns.
 *
 * A timestamp that falls on the current calendar day (local time) collapses
 * to "今天 HH:mm" instead — the common case right after an edit — so it reads
 * faster than the full date. Everything else always shows the full date.
 */
import { formatTaipeiDateTime } from "@/lib/taipei-time";

export function formatUpdatedAt(iso: string): string {
  // 一律用台北時間：getHours()／getDate() 讀的是執行環境的時區，Vercel 在 UTC，伺服器會印出晚
  // 8 小時的時間、「今天」也會判錯，瀏覽器再印一次就對不上（React #418）。見 lib/taipei-time.ts。
  const full = formatTaipeiDateTime(iso); // "2026/10/09 19:05"
  const today = formatTaipeiDateTime(new Date().toISOString()).slice(0, 10);
  return full.startsWith(today) ? `今天 ${full.slice(11)}` : full;
}
