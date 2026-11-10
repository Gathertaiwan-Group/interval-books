// 營業時間的精簡寫法，頁尾與手機選單抽屜共用（2026-11-10 從 SiteFooter.tsx 抽出）。

/** 「每日」三語。只在頁尾／抽屜這兩處用，不進 CMS。 */
export const DAILY = { zh: "每日", en: "Daily", ja: "毎日" };

/** 「週一至週日 11:00 – 19:00」→「每日 11:00–19:00」。抓不到時間區間就原樣顯示（CMS 可能改成別的寫法）。 */
export function dailyHours(hours: string, daily: string): string {
  const m = hours.match(/(\d{1,2}:\d{2})\s*[–—~-]\s*(\d{1,2}:\d{2})/);
  return m ? `${daily} ${m[1]}–${m[2]}` : hours;
}
