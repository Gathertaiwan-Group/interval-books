/**
 * 最新消息「過期就不在前台顯示」（2026-10-28，業主：「過期的最新消息，就不顯示了」）。
 *
 * ── 為什麼從「顯示用日期文字」推結束日 ─────────────────────────────────────
 * public.news 只有 display_date（自由文字）、sort_order、is_published、時間戳記，沒有任何
 * 結束日／到期欄位，也沒有 DDL 權限可以加。所以從 display_date 推一個結束日——而且推法
 * **刻意保守**：看不懂就當作「不會過期」，寧可多顯示一則舊消息，也不要讓一則還有效的
 * 消息因為寫法特別而從網站上消失。
 *
 * ── 規則 ──────────────────────────────────────────────────────────────────
 *   · 認得的日期：YYYY.MM.DD、YYYY/MM/DD、YYYY-MM-DD（月日可一位數）
 *   · 區間：~ ～ – — - 至 到；結尾可以省略年（2026.10.20~11.7 → 2026-11-07）
 *     或省略年月（2026.05.22–24 → 2026-05-24）。省略的部分從前一個日期補，補完比
 *     開頭還早就往後進位（2026.12.28~1.3 → 2027-01-03）
 *   · 文字裡有好幾個日期 → 取**最後一個**當結束日；只有一個 → 就是那一天
 *   · 任何一個日期不合法（2026.13.40、2026.02.30）→ 整段當作看不懂
 *   · 看不懂／空白 → null = 永不過期
 *   · 過期 = 結束日 < 今天（台北）。結束日當天整天都還顯示。
 *
 * 只有前台（/news、首頁跑馬燈）套用；後台一律全部列出並標「已過期・前台不顯示」，
 * MCP 讀取也不受影響。
 */
import { taipeiToday } from "./taipei-time.ts";

const FULL_WIDTH: Record<string, string> = {
  "．": ".",
  "／": "/",
  "－": "-",
  "～": "~",
  "〜": "~",
};

function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．／－～〜]/g, (c) => FULL_WIDTH[c] ?? c);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function valid(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 完整日期：前後不能黏著別的數字（避免從一長串數字中間切出一個日期）。 */
const FULL_DATE = /(?<!\d)(\d{4})\s*([./-])\s*(\d{1,2})\s*\2\s*(\d{1,2})(?!\d)/g;

/** 緊接在某個完整日期後面的「區間結尾」：月.日 或 只有日。 */
const RANGE_TAIL =
  /^\s*(?:~|–|—|-|至|到)\s*(?:(\d{1,2})\s*[./-]\s*(\d{1,2})(?![\d./:-])|(\d{1,2})(?![\d./:-]))/;

/**
 * display_date → 結束日 "YYYY-MM-DD"；看不懂回 null（= 永不過期）。
 */
export function parseNewsEndDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const s = normalize(text);
  let last: { y: number; m: number; d: number; end: number } | null = null;
  for (const match of s.matchAll(FULL_DATE)) {
    const y = Number(match[1]);
    const m = Number(match[3]);
    const d = Number(match[4]);
    if (!valid(y, m, d)) return null;
    last = { y, m, d, end: (match.index ?? 0) + match[0].length };
  }
  if (!last) return null;

  const tail = RANGE_TAIL.exec(s.slice(last.end));
  if (!tail) return ymd(last.y, last.m, last.d);

  let y = last.y;
  let m: number;
  let d: number;
  if (tail[1] !== undefined) {
    m = Number(tail[1]);
    d = Number(tail[2]);
    if (m < last.m || (m === last.m && d < last.d)) y += 1;
  } else {
    m = last.m;
    d = Number(tail[3]);
    if (d < last.d) {
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }
  if (!valid(y, m, d)) return null;
  return ymd(y, m, d);
}

/** 已過期？結束日早於今天（台北）才算；看不懂的一律 false。 */
export function isNewsExpired(
  text: string | null | undefined,
  today: string = taipeiToday(),
): boolean {
  const end = parseNewsEndDate(text);
  return end !== null && end < today;
}

/** 前台用：拿掉已過期的消息，順序不變。 */
export function liveNews<T extends { date: string }>(
  items: readonly T[],
  today: string = taipeiToday(),
): T[] {
  return items.filter((n) => !isNewsExpired(n.date, today));
}
