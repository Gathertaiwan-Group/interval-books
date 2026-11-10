/**
 * /events 的「月曆」檢視 —— 純函式（日期計算、分組、把場次組成月曆上的一格一格）。
 *
 * 零 @/ import（只有相對路徑的 .ts），scripts/events-calendar-selftest.mjs 直接 import。
 * 讀資料庫的那一半在 src/lib/events-calendar-data.ts；畫面在
 * src/components/events/EventsCalendar.tsx。
 *
 * ── 🔴 時區一律 Asia/Taipei ────────────────────────────────────────────────
 * 這是 SSR 的站：伺服器跑在 UTC，瀏覽器在台灣。getDate()／getHours() 讀的是執行環境
 * 的時區，兩邊算出來的「哪一天」會不一樣（UTC 前一天 16:00 以後 = 台北隔天），
 * 於是同一場活動 SSR 畫在 11/30、hydrate 後跳到 12/1 —— React #418。
 * 所以場次時間一律用 Intl 的 formatToParts（timeZone 寫死）只拿數字；月曆本身的
 * 「某月 1 日是星期幾」「某天加幾天」是純粹的曆法運算，用 Date.UTC 算，與時區無關。
 *
 * ── 🔴 不在這裡算座位 ─────────────────────────────────────────────────────
 * 「額滿」由呼叫端用 remainingForSession()（src/lib/shop.ts）算好，以 `full` 傳進來。
 * 這支檔案不碰 capacity／seats_taken（見 CLAUDE.md「不要自己算座位數字」）。
 */
import { distinctSessionTitle } from "./calendar-ics.ts";
import { journeyEventMatcher } from "./journey-events.ts";

export type CalLocalized = { zh: string; en: string; ja: string };

const TAIPEI_TIME_ZONE = "Asia/Taipei";

const TAIPEI_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: TAIPEI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 一個跨日場次最多畫幾天（防呆：ends_at 填錯成明年時不會把整年都塗滿）。 */
export const MAX_SPAN_DAYS = 14;

// =============================================================================
// 日期／月份
// =============================================================================

/** "YYYY-MM"，月份 01–12。 */
export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** "YYYY-MM-DD"。 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** timestamptz → 台北的 { date: "YYYY-MM-DD", time: "HH:mm" }。解不開 → null。 */
export function taipeiParts(iso: string | null | undefined): { date: string; time: string } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const p: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of TAIPEI_PARTS.formatToParts(new Date(t))) p[part.type] = part.value;
  const two = (v: string | undefined) => (v ?? "").padStart(2, "0");
  // 部分 runtime 在午夜給 "24"（同 src/lib/taipei-time.ts 的註解）。
  const hour = p.hour === "24" ? "00" : two(p.hour);
  return { date: `${p.year}-${two(p.month)}-${two(p.day)}`, time: `${hour}:${two(p.minute)}` };
}

/** 現在是台北的哪一個月 "YYYY-MM"。 */
export function taipeiMonthAt(nowMs: number): string {
  return (taipeiParts(new Date(nowMs).toISOString()) as { date: string }).date.slice(0, 7);
}

/** 今天（台北）"YYYY-MM-DD"。 */
export function taipeiDateAt(nowMs: number): string {
  return (taipeiParts(new Date(nowMs).toISOString()) as { date: string }).date;
}

/**
 * ?month= 的驗證。合法回 "YYYY-MM"，其他一律 undefined（走預設月份）。
 * 年份限 2000–2100：網址被亂改成 ?month=9999-01 時不要真的畫出一張空的未來月曆。
 */
export function parseMonthParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = MONTH_RE.exec(value.trim());
  if (!m) return undefined;
  const y = Number(m[1]);
  if (y < 2000 || y > 2100) return undefined;
  return `${m[1]}-${m[2]}`;
}

/** 月份加減：shiftMonth("2026-01", -1) = "2025-12"。 */
export function shiftMonth(month: string, delta: number): string {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`bad month: ${month}`);
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const y = Math.floor(idx / 12);
  const mo = idx - y * 12 + 1;
  return `${y}-${String(mo).padStart(2, "0")}`;
}

function ymdToUtcMs(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`bad date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function utcMsToYmd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** 純曆法：某天加 n 天（跨月、跨年、閏年都由 Date.UTC 處理）。 */
export function addDays(date: string, n: number): string {
  return utcMsToYmd(ymdToUtcMs(date) + n * 86_400_000);
}

/** b − a 的天數。 */
export function daysBetween(a: string, b: string): number {
  return Math.round((ymdToUtcMs(b) - ymdToUtcMs(a)) / 86_400_000);
}

/** 0 = 星期日 … 6 = 星期六。純曆法（UTC 午夜），與執行環境時區無關。 */
export function weekdayOf(date: string): number {
  return new Date(ymdToUtcMs(date)).getUTCDay();
}

/** 某月有幾天。 */
export function daysInMonth(month: string): number {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`bad month: ${month}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
}

export type GridDay = { date: string; inMonth: boolean; weekday: number };

/**
 * 月曆格：週日開頭（台灣的掛曆慣例），每列 7 天。前後補上相鄰月份的日子湊滿整週，
 * 列數 4–6 不固定（2026-02 剛好四列）。
 */
export function monthGrid(month: string): GridDay[][] {
  const first = `${month}-01`;
  const offset = weekdayOf(first);
  const total = daysInMonth(month);
  const cells = Math.ceil((offset + total) / 7) * 7;
  const weeks: GridDay[][] = [];
  for (let i = 0; i < cells; i++) {
    const date = addDays(first, i - offset);
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({ date, inMonth: date.slice(0, 7) === month, weekday: i % 7 });
  }
  return weeks;
}

// =============================================================================
// 月曆上的一筆
// =============================================================================

export type CalendarEntry = {
  /** React key（場次 id；沒有場次的活動用 "event:<slug>"）。 */
  key: string;
  /** /events/<slug>。 */
  slug: string;
  kind: "event" | "journey";
  title: CalLocalized;
  /** 場次名稱裡和活動名稱不重複的部分（「光之行者」）；沒有 → null。 */
  detail: CalLocalized | null;
  location: CalLocalized | null;
  /** 台北日期 "YYYY-MM-DD"。 */
  startDate: string;
  /** 跨日場次的最後一天（含）；單日 = startDate。 */
  endDate: string;
  /** 台北 "HH:mm"；沒有場次、只有活動日期時為 null（整天）。 */
  startTime: string | null;
  endTime: string | null;
  /** 排序用（同一天依開始時間）。 */
  sortMs: number;
  /** 已結束（結束時間──沒填就是開始時間──已過）。 */
  ended: boolean;
  /** 已額滿（呼叫端用 remainingForSession() 算好傳進來）。包場時一律 false。 */
  full: boolean;
  /** 包場，不開放報名（src/lib/private-booking.ts）。月曆標「包場」，不標額滿。 */
  privateBooking: boolean;
};

export type RawCalendarEvent = {
  slug: string;
  title: CalLocalized;
  externalUrl: string;
  isoDate: string | null;
  /** 包場（events.notes 的保留 key）。場次時間由呼叫端從 server fn 補進 sessions。 */
  privateBooking?: boolean;
};

export type RawCalendarSession = {
  id: string;
  /** products.slug（`event-<events.slug>`）。 */
  productSlug: string;
  title: CalLocalized;
  location: CalLocalized;
  startsAt: string;
  endsAt: string | null;
  /** 🔴 呼叫端用 remainingForSession(session) <= 0 算，不要在這裡算。 */
  full: boolean;
};

export type CalendarInput = {
  events: RawCalendarEvent[];
  sessions: RawCalendarSession[];
  /** 上架中策旅卡片的 external_url。 */
  journeyUrls: string[];
  nowMs: number;
};

function distinctLocalized(session: CalLocalized, event: CalLocalized): CalLocalized | null {
  const out = {
    zh: distinctSessionTitle(session.zh ?? "", event.zh ?? ""),
    en: distinctSessionTitle(session.en ?? "", event.en ?? ""),
    ja: distinctSessionTitle(session.ja ?? "", event.ja ?? ""),
  };
  // 中文是主語言：中文那一段沒有不重複的部分（純日期），英日文多半也只是日期的另一種寫法。
  if (!out.zh) return null;
  // 某語言沒有就退回中文（站上其他 Localized 的慣例：翻譯缺了看中文）。
  return { zh: out.zh, en: out.en || out.zh, ja: out.ja || out.zh };
}

/**
 * 把活動與場次組成月曆的筆數，依時間排序。
 *
 *   · 有場次的活動：一個場次一筆（同一活動多場次各自出現）。日期以 starts_at 的台北日期為準。
 *   · 跨日場次（策旅三天兩夜）：endDate 取 ends_at 的台北日期；ends_at 剛好落在午夜 00:00
 *     的視為前一天結束（不多塗一天）。最多 MAX_SPAN_DAYS 天。
 *   · 讀不到任何場次、但有 iso_date 的活動：一筆整天的（沒有時間），讓「有這場活動」仍看得到。
 *   · 策旅：events 表裡被策旅卡片連到的那幾列（journeyEventMatcher，與 /calendar.ics、
 *     fetchEvents() 同一個判準）。
 */
export function buildCalendarEntries(input: CalendarInput): CalendarEntry[] {
  const isJourney = journeyEventMatcher(input.journeyUrls);
  const sessionsByProduct = new Map<string, RawCalendarSession[]>();
  for (const s of input.sessions) {
    const list = sessionsByProduct.get(s.productSlug) ?? [];
    list.push(s);
    sessionsByProduct.set(s.productSlug, list);
  }

  const out: CalendarEntry[] = [];
  for (const event of input.events) {
    if (!event.slug) continue;
    const kind = isJourney(event) ? "journey" : "event";
    const privateBooking = event.privateBooking === true;
    const sessions = sessionsByProduct.get(`event-${event.slug}`) ?? [];
    let added = 0;
    for (const s of sessions) {
      const start = taipeiParts(s.startsAt);
      if (!start) continue;
      const startMs = Date.parse(s.startsAt);
      const endRaw = s.endsAt && !Number.isNaN(Date.parse(s.endsAt)) ? s.endsAt : null;
      const end = endRaw ? taipeiParts(endRaw) : null;
      let endDate = start.date;
      if (end && end.date > start.date) {
        endDate = end.time === "00:00" ? addDays(end.date, -1) : end.date;
        if (endDate < start.date) endDate = start.date;
        if (daysBetween(start.date, endDate) > MAX_SPAN_DAYS - 1) {
          endDate = addDays(start.date, MAX_SPAN_DAYS - 1);
        }
      }
      const endMs = endRaw ? Date.parse(endRaw) : startMs;
      out.push({
        key: s.id,
        slug: event.slug,
        kind,
        title: event.title,
        detail: distinctLocalized(s.title, event.title),
        location: s.location?.zh || s.location?.en ? s.location : null,
        startDate: start.date,
        endDate,
        startTime: start.time,
        endTime: end ? end.time : null,
        sortMs: startMs,
        ended: endMs <= input.nowMs,
        // 包場不賣位子：名額（capacity 多半只是佔位）不代表「額滿」。
        full: privateBooking ? false : s.full,
        privateBooking,
      });
      added++;
    }
    if (added === 0 && event.isoDate && DATE_RE.test(event.isoDate)) {
      out.push({
        key: `event:${event.slug}`,
        slug: event.slug,
        kind,
        title: event.title,
        detail: null,
        location: null,
        startDate: event.isoDate,
        endDate: event.isoDate,
        startTime: null,
        endTime: null,
        // 整天的排在同一天有時間的前面。
        sortMs: ymdToUtcMs(event.isoDate) - 8 * 3_600_000,
        ended: event.isoDate < taipeiDateAt(input.nowMs),
        full: false,
        privateBooking,
      });
    }
  }
  out.sort((a, b) => a.sortMs - b.sortMs || a.key.localeCompare(b.key));
  return out;
}

// =============================================================================
// 分組
// =============================================================================

export type DayItem = {
  entry: CalendarEntry;
  /** 跨日場次的第幾天（1 起算）。 */
  dayIndex: number;
  totalDays: number;
};

/**
 * 月曆格用：某月每一天（只有本月的日子）有哪些筆。跨日場次在每一天都出現
 * （dayIndex 2 之後是「續」）。
 */
export function itemsByDay(entries: CalendarEntry[], month: string): Map<string, DayItem[]> {
  const map = new Map<string, DayItem[]>();
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  for (const entry of entries) {
    if (entry.endDate < first || entry.startDate > last) continue;
    const totalDays = daysBetween(entry.startDate, entry.endDate) + 1;
    for (let i = 0; i < totalDays; i++) {
      const date = addDays(entry.startDate, i);
      if (date < first || date > last) continue;
      const list = map.get(date) ?? [];
      list.push({ entry, dayIndex: i + 1, totalDays });
      map.set(date, list);
    }
  }
  return map;
}

export type AgendaGroup = { date: string; items: DayItem[] };

/**
 * 手機議程用：依日期分組的列表。跨日場次只列一次 —— 在它落在本月的第一天
 * （上個月開始、這個月還在進行的策旅，列在本月 1 日，標第幾天）。
 */
export function agendaGroups(entries: CalendarEntry[], month: string): AgendaGroup[] {
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const map = new Map<string, DayItem[]>();
  for (const entry of entries) {
    if (entry.endDate < first || entry.startDate > last) continue;
    const date = entry.startDate < first ? first : entry.startDate;
    const totalDays = daysBetween(entry.startDate, entry.endDate) + 1;
    const list = map.get(date) ?? [];
    list.push({ entry, dayIndex: daysBetween(entry.startDate, date) + 1, totalDays });
    map.set(date, list);
  }
  return [...map.keys()].sort().map((date) => ({ date, items: map.get(date) as DayItem[] }));
}

/** 某月有沒有任何一筆。 */
export function monthHasEntries(entries: CalendarEntry[], month: string): boolean {
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  return entries.some((e) => !(e.endDate < first || e.startDate > last));
}

/**
 * 往前（dir = -1）或往後（dir = 1）最近一個有活動的月份；沒有 → null。
 * 空月份的「下一場在 12 月」按鈕用。
 */
export function nearestMonthWithEntries(
  entries: CalendarEntry[],
  month: string,
  dir: 1 | -1,
): string | null {
  let best: string | null = null;
  for (const e of entries) {
    const startM = e.startDate.slice(0, 7);
    const endM = e.endDate.slice(0, 7);
    if (dir === 1 && startM > month && (best === null || startM < best)) best = startM;
    if (dir === -1 && endM < month && (best === null || endM > best)) best = endM;
  }
  return best;
}

// =============================================================================
// 文字
// =============================================================================

export const WEEKDAYS: Record<"zh" | "en" | "ja", readonly string[]> = {
  zh: ["日", "一", "二", "三", "四", "五", "六"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  ja: ["日", "月", "火", "水", "木", "金", "土"],
};

const EN_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** 「2026 年 11 月」／"November 2026"／「2026年11月」。 */
export function monthLabel(month: string, lang: "zh" | "en" | "ja"): string {
  const [y, m] = month.split("-");
  const mo = Number(m);
  if (lang === "en") return `${EN_MONTHS[mo - 1]} ${y}`;
  if (lang === "ja") return `${y}年${mo}月`;
  return `${y} 年 ${mo} 月`;
}

/** 「11月24日（二）」／"Tue, Nov 24"／「11月24日（火）」—— aria-label 與議程用。 */
export function dayLabel(date: string, lang: "zh" | "en" | "ja"): string {
  const [, m, d] = date.split("-").map(Number);
  const wd = WEEKDAYS[lang][weekdayOf(date)];
  if (lang === "en") return `${wd}, ${EN_MONTHS[m - 1].slice(0, 3)} ${d}`;
  return `${m}月${d}日（${wd}）`;
}

/** 「11/23–11/25」：跨日場次的日期範圍（同月也寫月份，讀起來不會誤會）。 */
export function rangeLabel(entry: CalendarEntry): string {
  const fmt = (date: string) => {
    const [, m, d] = date.split("-").map(Number);
    return `${m}/${d}`;
  };
  return entry.endDate === entry.startDate
    ? fmt(entry.startDate)
    : `${fmt(entry.startDate)}–${fmt(entry.endDate)}`;
}
