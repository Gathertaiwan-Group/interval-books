/**
 * /calendar.ics —— 把站上所有「上架中」活動與策旅的每一個場次，輸出成 iCalendar（RFC 5545）。
 * 書店的 Google 日曆用「透過網址訂閱」訂這個網址，網站新增／改期／下架就會自動跟著更新。
 *
 * 這支模組刻意**零 import（@/ 別名）**、純函式：scripts/calendar-ics-selftest.mjs 用相對路徑
 * 直接 import 真正的程式碼跑行為測試（同 src/server/cache-policy.ts 的理由）。資料庫讀取在
 * src/server/calendar.ts，這裡只吃讀好的列。
 *
 * ── 規則 ──────────────────────────────────────────────────────────────────
 *   · 只放 events.status === "live"（0052 的唯一真相）。草稿、下架不放。場次被刪就是資料庫裡
 *     沒有那一列，自然不會出現。
 *   · 策旅 = 有一張上架中的策旅卡片指著的活動（journeyEventMatcher，與 /events、/journeys 同一支
 *     判準）→ SUMMARY 加「策旅｜」。
 *   · 過去的場次留最近 90 天（以結束時間算，多日策旅進行中不會被丟掉），未來的全放。
 *   · 場次不分 open／closed 都放（報名截止、包場的場次活動照常舉辦）——與 /events 月曆同一個範圍。
 *   · 上架活動沒有票券商品（外部報名）或沒有任何場次、但有 iso_date → 一筆全天事件
 *     （DTSTART;VALUE=DATE、DTEND 次日，UID = event-<events.id>@intervalbooks.tw），
 *     與月曆「讀不到場次就用活動日期畫全天」同一個規則。
 *   · UID = <場次 id>@intervalbooks.tw：場次改期時 UID 不變，日曆更新同一筆而不是多一筆。
 *   · 時間一律輸出 UTC（…Z），不需要 VTIMEZONE；X-WR-TIMEZONE 讓 Google 用台北顯示。
 *   · DTSTAMP／LAST-MODIFIED 用資料列的 updated_at（不用「現在」）：內容沒變，輸出就逐位元相同。
 */
import { journeyEventMatcher } from "./journey-events.ts";

export const CALENDAR_PATH = "/calendar.ics";
export const CALENDAR_NAME = "小時光書店 活動";
export const JOURNEY_PREFIX = "策旅｜";
export const UID_DOMAIN = "intervalbooks.tw";
export const SITE_ORIGIN = "https://www.intervalbooks.tw";
/** 過去的場次保留幾天。 */
export const PAST_DAYS = 90;
/** 推估不出結束時間時，開始後幾小時。 */
export const DEFAULT_DURATION_HOURS = 2;
/** DESCRIPTION 最長字數（超過加「…」）。 */
export const DESCRIPTION_MAX_CHARS = 900;

const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const TAIPEI_OFFSET_MS = 8 * HOUR_MS;

// =============================================================================
// RFC 5545 文字處理
// =============================================================================

/** TEXT 值的跳脫：反斜線、分號、逗號、換行。 */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

/**
 * 內容行折行：每行（含 CRLF 以外的全部）最多 75 octet，續行以一個空白開頭（那個空白也算
 * 一個 octet）。以 code point 為單位切，絕不把 UTF-8 多位元組字元（中文 3 octet、emoji 4）
 * 或 surrogate pair 從中間切斷。回傳已含 CRLF 的字串。
 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // 續行前面有一個空白
    if (curBytes + n > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join("\r\n") + "\r\n";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** 去 HTML：標籤、script/style、實體；區塊標籤換成換行；空白收斂。 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code =
          e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : m;
      }
      return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 依 code point 截斷（不切斷 surrogate pair），超過加「…」。 */
export function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max
    ? s
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

// =============================================================================
// 時間
// =============================================================================

/** ms → "20261128T070000Z"。 */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * 沒有 ends_at 時，用活動的顯示時間（display_date）推估結束：
 *   「2026.11.28 (六) 15:00–16:30」且 15:00 與場次開始的台北時刻相同 → 當天 16:30。
 * 對不上（顯示時間是別場、沒有時間、格式不同）→ null，由呼叫端退回開始後 2 小時。
 * 要求開始時刻相同，是為了多場次活動不會把 A 場的時間套到 B 場。
 */
export function inferEndFromDisplay(startMs: number, displayDate: string): number | null {
  const m = /(\d{1,2}):(\d{2})\s*[–—~\-－]\s*(\d{1,2}):(\d{2})/.exec(displayDate);
  if (!m) return null;
  const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (sh > 23 || eh > 24 || sm > 59 || em > 59) return null;
  const local = new Date(startMs + TAIPEI_OFFSET_MS);
  if (local.getUTCHours() !== sh || local.getUTCMinutes() !== sm) return null;
  const dayStartLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let end = dayStartLocal + (eh * 60 + em) * 60000 - TAIPEI_OFFSET_MS;
  if (end <= startMs) end += DAY_MS; // 跨午夜
  return end;
}

// =============================================================================
// 輸入形狀與建構
// =============================================================================

export type CalEvent = {
  id: string;
  slug: string;
  /** events.status：只有 "live" 會輸出。 */
  status: string;
  titleZh: string;
  summaryZh: string;
  displayDate: string;
  /** 外部報名連結（registration_type = external 才有意義）。 */
  externalUrl: string;
  registrationType: string;
  updatedAt: string | null;
  /** 票券商品（products.id）；沒有 → 沒有場次可輸出。 */
  productId: string | null;
  /** 商品單價（沒有任何票種方案時用）。 */
  price: number | null;
  /** events.iso_date（"YYYY-MM-DD"）：沒有商品或沒有場次時，用它輸出一筆全天事件。 */
  isoDate?: string | null;
};

export type CalSession = {
  id: string;
  productId: string;
  titleZh: string;
  locationZh: string;
  startsAt: string;
  endsAt: string | null;
  capacity: number;
  seatsTaken: number;
  updatedAt: string | null;
};

export type CalPlan = {
  sessionId: string;
  titleZh: string;
  price: number;
  status: string;
  updatedAt: string | null;
};

export type CalendarInput = {
  events: CalEvent[];
  sessions: CalSession[];
  plans: CalPlan[];
  /** 上架中策旅卡片的 external_url（呼叫端只給 status = live 的）。 */
  journeyUrls: string[];
  /** 活動沒填地點時的書店地址。 */
  storeAddress: string;
  now: Date;
};

const money = (n: number) => `NT$${n.toLocaleString("en-US")}`;

function priceText(event: CalEvent, plans: CalPlan[]): string | null {
  const open = plans.filter((p) => p.status === "open");
  if (open.length) {
    const prices = open.map((p) => p.price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    if (lo === hi) return lo === 0 ? "免費" : money(lo);
    return `${money(lo)}–${money(hi)}`;
  }
  if (event.price == null) return null;
  return event.price === 0 ? "免費" : money(event.price);
}

function eventUrl(event: CalEvent): string {
  return `${SITE_ORIGIN}/events/${encodeURIComponent(event.slug)}`;
}

function maxIso(values: Array<string | null | undefined>): number | null {
  let best: number | null = null;
  for (const v of values) {
    const t = parseMs(v);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

/** 只有日期／星期／符號的片段（「10/23（五）–10/25（日）」）：日曆本來就有時間，不重複寫。 */
const DATE_ONLY_SEGMENT = /^[\d\s/.:\-–—~（）()一二三四五六日]+$/;

/**
 * 場次名稱裡「和活動名稱不重複」的部分。場次名常是「活動名｜第一梯次｜10/23（五）–10/25（日）」，
 * 直接接在活動名後面會變成同一個名字講兩次。以 ｜ 或 | 切段：和活動名稱相同、被活動名稱
 * 包含、包含活動名稱的片段，以及純日期片段都拿掉（包含活動名稱者先去掉那段字再看剩什麼）。
 * 剩下的用「｜」接回；什麼都不剩 → 空字串。
 */
export function distinctSessionTitle(sessionTitle: string, eventTitle: string): string {
  const ev = eventTitle.trim();
  const keep: string[] = [];
  for (const raw of sessionTitle.split(/[｜|]/)) {
    let seg = raw.trim();
    if (ev && seg.includes(ev)) seg = seg.replace(ev, "").trim();
    if (!seg || (ev && ev.includes(seg)) || DATE_ONLY_SEGMENT.test(seg)) continue;
    keep.push(seg);
  }
  return keep.join("｜");
}

export type BuiltVevent = { uid: string; startMs: number; lines: string[] };

/** 組出所有要輸出的 VEVENT（已排序）。 */
export function buildVevents(input: CalendarInput): BuiltVevent[] {
  const isJourney = journeyEventMatcher(input.journeyUrls);
  const cutoff = input.now.getTime() - PAST_DAYS * DAY_MS;
  const sessionsByProduct = new Map<string, CalSession[]>();
  for (const s of input.sessions) {
    const list = sessionsByProduct.get(s.productId) ?? [];
    list.push(s);
    sessionsByProduct.set(s.productId, list);
  }
  const plansBySession = new Map<string, CalPlan[]>();
  for (const p of input.plans) {
    const list = plansBySession.get(p.sessionId) ?? [];
    list.push(p);
    plansBySession.set(p.sessionId, list);
  }

  const out: BuiltVevent[] = [];
  for (const event of input.events) {
    if (event.status !== "live") continue;
    const sessions = event.productId ? (sessionsByProduct.get(event.productId) ?? []) : [];
    const journey = isJourney({
      slug: event.slug,
      externalUrl: event.registrationType === "external" ? event.externalUrl : null,
    });
    const url = eventUrl(event);

    // 沒有商品／沒有任何可用的場次時間 → 有 iso_date 就輸出一筆全天事件。
    if (!sessions.some((s) => parseMs(s.startsAt) !== null)) {
      const allDay = buildAllDayVevent(event, journey, url, cutoff);
      if (allDay) out.push(allDay);
      continue;
    }

    for (const s of sessions) {
      const startMs = parseMs(s.startsAt);
      if (startMs === null) continue;
      let endMs = parseMs(s.endsAt);
      if (endMs === null || endMs < startMs) {
        endMs =
          inferEndFromDisplay(startMs, event.displayDate) ??
          startMs + DEFAULT_DURATION_HOURS * HOUR_MS;
      }
      if (endMs < cutoff) continue;

      const plans = plansBySession.get(s.id) ?? [];
      const sessionTitle = distinctSessionTitle(s.titleZh, event.titleZh);
      const eventTitle = event.titleZh.trim();
      let summary = `${journey ? JOURNEY_PREFIX : ""}${eventTitle}`;
      if (sessions.length > 1 && sessionTitle) {
        summary += `｜${sessionTitle}`;
      }

      const desc: string[] = [];
      const brief = stripHtml(event.summaryZh);
      if (brief) desc.push(brief);
      const price = priceText(event, plans);
      if (price) desc.push(`票價：${price}`);
      if (event.registrationType === "internal" && s.capacity > 0) {
        const left = Math.max(0, s.capacity - s.seatsTaken);
        desc.push(`名額：${s.capacity} 位（截至訂閱更新時尚餘 ${left} 位）`);
      }
      desc.push(
        `${event.registrationType === "external" && event.externalUrl ? "報名連結：" + event.externalUrl + "\n活動頁：" : "報名／詳情："}${url}`,
      );

      const lastMod = maxIso([event.updatedAt, s.updatedAt, ...plans.map((p) => p.updatedAt)]);
      const stampMs = lastMod ?? startMs;
      const location = s.locationZh.trim() || input.storeAddress.trim();

      const uid = `${s.id}@${UID_DOMAIN}`;
      const props: Array<[string, string]> = [
        ["UID", uid],
        ["DTSTAMP", formatUtc(stampMs)],
        ["LAST-MODIFIED", formatUtc(stampMs)],
        ["DTSTART", formatUtc(startMs)],
        ["DTEND", formatUtc(endMs)],
        ["SUMMARY", escapeText(summary)],
      ];
      if (location) props.push(["LOCATION", escapeText(location)]);
      props.push(["URL", url]);
      props.push(["DESCRIPTION", escapeText(truncate(desc.join("\n"), DESCRIPTION_MAX_CHARS))]);
      props.push(["STATUS", "CONFIRMED"], ["TRANSP", "OPAQUE"]);

      out.push({
        uid,
        startMs,
        lines: ["BEGIN:VEVENT", ...props.map(([k, v]) => `${k}:${v}`), "END:VEVENT"],
      });
    }
  }
  out.sort((a, b) => a.startMs - b.startMs || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  return out;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" → 台北那一天 00:00 的 UTC ms；格式不對 → null。 */
function taipeiMidnightMs(isoDate: string | null | undefined): number | null {
  const m = ISO_DATE_RE.exec((isoDate ?? "").trim());
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(utc);
  // 2026-02-31 這種會被 Date.UTC 進位成別天的，視為無效。
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return utc - TAIPEI_OFFSET_MS;
}

/** UTC ms（某個台北午夜）→ "YYYYMMDD"（台北日期）。 */
function formatTaipeiDate(ms: number): string {
  return formatUtc(ms + TAIPEI_OFFSET_MS).slice(0, 8);
}

/** 沒有場次的上架活動 → 一筆全天事件（iso_date 那一天）。沒有 iso_date／太舊 → null。 */
function buildAllDayVevent(
  event: CalEvent,
  journey: boolean,
  url: string,
  cutoff: number,
): BuiltVevent | null {
  const startMs = taipeiMidnightMs(event.isoDate);
  if (startMs === null) return null;
  const endMs = startMs + DAY_MS;
  if (endMs < cutoff) return null;

  const desc: string[] = [];
  const brief = stripHtml(event.summaryZh);
  if (brief) desc.push(brief);
  const price = priceText(event, []);
  if (price) desc.push(`票價：${price}`);
  desc.push(
    `${event.registrationType === "external" && event.externalUrl ? "報名連結：" + event.externalUrl + "\n活動頁：" : "報名／詳情："}${url}`,
  );

  const stampMs = parseMs(event.updatedAt) ?? startMs;
  const uid = `event-${event.id}@${UID_DOMAIN}`;
  const props: Array<[string, string]> = [
    ["UID", uid],
    ["DTSTAMP", formatUtc(stampMs)],
    ["LAST-MODIFIED", formatUtc(stampMs)],
    ["DTSTART;VALUE=DATE", formatTaipeiDate(startMs)],
    ["DTEND;VALUE=DATE", formatTaipeiDate(endMs)],
    ["SUMMARY", escapeText(`${journey ? JOURNEY_PREFIX : ""}${event.titleZh.trim()}`)],
    ["URL", url],
    ["DESCRIPTION", escapeText(truncate(desc.join("\n"), DESCRIPTION_MAX_CHARS))],
    ["STATUS", "CONFIRMED"],
    // 全天事件不佔用行事曆的忙碌時段。
    ["TRANSP", "TRANSPARENT"],
  ];
  return {
    uid,
    startMs,
    lines: ["BEGIN:VEVENT", ...props.map(([k, v]) => `${k}:${v}`), "END:VEVENT"],
  };
}

/** 整份 .ics 全文（CRLF、已折行）。 */
export function buildCalendarIcs(input: CalendarInput): string {
  const events = buildVevents(input);
  const head = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Interval Books//Events Calendar//ZH",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(CALENDAR_NAME)}`,
    "X-WR-TIMEZONE:Asia/Taipei",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  const lines = [...head, ...events.flatMap((e) => e.lines), "END:VCALENDAR"];
  return lines.map(foldLine).join("");
}
