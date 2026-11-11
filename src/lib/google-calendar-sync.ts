/**
 * Google 日曆同步的核心規則（純函式）：把 buildCalendarEntries() 組出的事件換成 Google Calendar
 * API 的 event resource，並算出「要新增／更新／刪除哪幾筆」。
 *
 * 業主 2026-11：活動要直接寫進「我的日曆」裡書店自己的日曆，不要再用 /calendar.ics 訂閱
 * （那會出現在「其他日曆」）。要上哪些事件、標題／時間／地點／描述怎麼組，全部沿用
 * src/lib/calendar-ics.ts 的 buildCalendarEntries() —— 這裡不再寫第二份規則。
 *
 * 這支模組只 import 相對路徑的 calendar-ics.ts 與 node:crypto，scripts/google-calendar-selftest.mjs
 * 直接 import 真正的程式碼、用假的 Calendar client 跑行為測試。網路呼叫在
 * src/server/google-calendar-api.ts，資料庫與排程在 src/server/google-calendar.ts。
 *
 * ── 只動自己建立的事件 ──────────────────────────────────────────────────────
 * 業主的日曆裡有她自己手動建立的行程（「中華文創台北分會」「Yoki 來華山講座」…），**一筆都
 * 不能碰**。「是我們建立的」要三個條件同時成立（isOwnEvent）：
 *   1. extendedProperties.private.intervalbooksManaged === "1"
 *   2. 有 intervalbooksKey（"session:<id>"／"event:<id>"）
 *   3. event id 正好等於 googleEventIdForKey(key)（固定 id，由 key 雜湊得出）
 * 列出既有事件時已經用 privateExtendedProperty 篩過，這裡再驗一次：就算 API 的篩選哪天
 * 行為改變、或有人手動複製了一筆帶屬性的事件，也不會被誤刪。
 *
 * ── 冪等 ────────────────────────────────────────────────────────────────────
 * event id 固定（"ib" + sha256(key) 前 32 個 hex；hex 是 Google 要求的 base32hex 的子集），
 * 所以同一個場次永遠是同一筆事件：重跑不會多一筆，新增撞到 409（例如業主手動刪過、Google
 * 留著已取消的那筆）就改成 patch 把它恢復。內容雜湊存在 intervalbooksHash，沒變就不打 API。
 */
import { createHash } from "node:crypto";
import {
  buildCalendarEntries,
  PAST_DAYS,
  type CalendarEntry,
  type CalendarInput,
} from "./calendar-ics.ts";

export const GCAL_MANAGED_PROP = "intervalbooksManaged";
export const GCAL_KEY_PROP = "intervalbooksKey";
export const GCAL_HASH_PROP = "intervalbooksHash";
/** 內容雜湊的格式版本：要改 event resource 的組法時加一，讓所有事件重寫一次。 */
export const GCAL_FORMAT_VERSION = "1";
export const GCAL_TIME_ZONE = "Asia/Taipei";
export const GCAL_SOURCE_TITLE = "小時光書店";
const EVENT_ID_PREFIX = "ib";
const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;

/** Google Calendar API 的 event resource（只列我們會送的欄位）。 */
export type GoogleEventResource = {
  id: string;
  summary: string;
  /** 一律送（沒有地點就是 ""）：PATCH 是合併語意，不送的話舊地點會留在 Google 上。 */
  location: string;
  description: string;
  start: { dateTime: string; timeZone: string } | { date: string };
  end: { dateTime: string; timeZone: string } | { date: string };
  transparency: "opaque" | "transparent";
  status: "confirmed";
  source: { title: string; url: string };
  /** 不跳通知：跟以前訂閱的 .ics 一樣，每一場活動都不會叫業主的手機。 */
  reminders: { useDefault: false };
  extendedProperties: { private: Record<string, string> };
};

/** events.list 回來、我們需要看的欄位。 */
export type ExistingGoogleEvent = {
  id: string;
  status?: string;
  /** 結束時間：判斷「已經是 90 天前的歷史」要用（見 planSync 的 keepEndedBeforeMs）。 */
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
};

/**
 * 歷史保留的分界（業主 2026-11-11 決定）：結束時間早於「現在 − 90 天」的事件是歷史紀錄，
 * **留在業主日曆上，既不新增也不刪除、也不再更新**。90 天與 /calendar.ics 的 PAST_DAYS 同一個數。
 */
export function historyCutoffMs(now: Date): number {
  return now.getTime() - PAST_DAYS * 24 * 3600 * 1000;
}

/** Google 事件的結束時間（ms）。全天事件的 date 以台北午夜算；讀不出來 → null。 */
export function eventEndMs(ev: ExistingGoogleEvent): number | null {
  const dt = ev.end?.dateTime;
  if (dt) {
    const t = Date.parse(dt);
    return Number.isNaN(t) ? null : t;
  }
  const d = ev.end?.date;
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const t = Date.parse(`${d}T00:00:00+08:00`);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** 假 client 與真 client 共用的介面（src/server/google-calendar-api.ts 實作）。 */
export interface CalendarClient {
  /** 列出帶 intervalbooksManaged=1 的事件（含全部分頁）。 */
  listManaged(calendarId: string): Promise<ExistingGoogleEvent[]>;
  /** 讀單一事件（含已取消的）；不存在回 null。只在 insert 撞 409 時用來確認那筆是不是我們的。 */
  get(calendarId: string, eventId: string): Promise<ExistingGoogleEvent | null>;
  insert(calendarId: string, event: GoogleEventResource): Promise<void>;
  patch(calendarId: string, eventId: string, event: GoogleEventResource): Promise<void>;
  remove(calendarId: string, eventId: string): Promise<void>;
}

/** API 錯誤：帶 HTTP 狀態碼，讓同步邏輯分辨 409（已存在）與 404／410（已不在）。 */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
    this.reason = reason;
  }
}

// =============================================================================
// id 與雜湊
// =============================================================================

/** "session:<uuid>" → 固定的 Google event id（base32hex 小寫、34 字元）。 */
export function googleEventIdForKey(key: string): string {
  return EVENT_ID_PREFIX + createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}

/** Google event id 的格式規則：base32hex 小寫（0-9a-v）、5–1024 字元。 */
export function isValidGoogleEventId(id: string): boolean {
  return /^[0-9a-v]{5,1024}$/.test(id);
}

/** 依 key 排序後序列化，讓雜湊不受物件屬性順序影響。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(resource: Omit<GoogleEventResource, "extendedProperties">): string {
  return createHash("sha256")
    .update(`${GCAL_FORMAT_VERSION}|${stableStringify(resource)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

// =============================================================================
// CalendarEntry → Google event resource
// =============================================================================

/** UTC ms → 台北日期 "YYYY-MM-DD"（全天事件用）。 */
function taipeiDate(ms: number): string {
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

export function toGoogleEvent(entry: CalendarEntry): GoogleEventResource {
  const body: Omit<GoogleEventResource, "extendedProperties"> = {
    id: googleEventIdForKey(entry.key),
    summary: entry.summary,
    location: entry.location,
    description: entry.description,
    start: entry.allDay
      ? { date: taipeiDate(entry.startMs) }
      : { dateTime: new Date(entry.startMs).toISOString(), timeZone: GCAL_TIME_ZONE },
    end: entry.allDay
      ? { date: taipeiDate(entry.endMs) }
      : { dateTime: new Date(entry.endMs).toISOString(), timeZone: GCAL_TIME_ZONE },
    transparency: entry.transparent ? "transparent" : "opaque",
    status: "confirmed",
    source: { title: GCAL_SOURCE_TITLE, url: entry.url },
    reminders: { useDefault: false },
  };
  return {
    ...body,
    extendedProperties: {
      private: {
        [GCAL_MANAGED_PROP]: "1",
        [GCAL_KEY_PROP]: entry.key,
        [GCAL_HASH_PROP]: contentHash(body),
      },
    },
  };
}

/** 網站資料 → 要在 Google 日曆上的事件（與 /calendar.ics 同一份規則）。 */
export function buildDesiredGoogleEvents(input: CalendarInput): GoogleEventResource[] {
  return buildCalendarEntries(input, { seatsAsOf: "同步" }).map(toGoogleEvent);
}

// =============================================================================
// 差異計算
// =============================================================================

/** 這筆事件是不是我們建立的（三個條件，見檔頭）。 */
export function isOwnEvent(ev: ExistingGoogleEvent): boolean {
  const props = ev.extendedProperties?.private;
  if (!props || props[GCAL_MANAGED_PROP] !== "1") return false;
  const key = props[GCAL_KEY_PROP];
  if (!key || !/^(session|event):\S+$/.test(key)) return false;
  return ev.id === googleEventIdForKey(key);
}

export type SyncPlan = {
  insert: GoogleEventResource[];
  update: GoogleEventResource[];
  /** 要刪的 event id（一定是 isOwnEvent 的）。 */
  remove: string[];
  unchanged: number;
  /** 帶了我們的屬性、但不符合 isOwnEvent 的事件數（不碰，只回報）。 */
  foreign: number;
  /** 已經是歷史（結束早於 keepEndedBeforeMs）而保留不動的自有事件數。 */
  kept: number;
};

/**
 * keepEndedBeforeMs：結束時間早於它、又不在 desired 裡的自有事件 → 保留（歷史），不刪。
 * 只有「範圍內」的自有事件不在 desired 裡（活動下架、場次被刪、活動被刪）才刪。
 * 不給（換日曆、中斷連結的清空）→ 自有事件全部可刪。結束時間讀不出來 → 當成範圍內。
 */
export function planSync(
  desired: GoogleEventResource[],
  existing: ExistingGoogleEvent[],
  options: { keepEndedBeforeMs?: number } = {},
): SyncPlan {
  const want = new Map(desired.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const plan: SyncPlan = { insert: [], update: [], remove: [], unchanged: 0, foreign: 0, kept: 0 };
  const keepBefore = options.keepEndedBeforeMs;

  for (const ev of existing) {
    if (!isOwnEvent(ev)) {
      plan.foreign++;
      continue;
    }
    if (ev.status === "cancelled") continue; // 已取消：當作不存在（需要的話下面會重新 insert）
    const target = want.get(ev.id);
    if (!target) {
      const end = eventEndMs(ev);
      if (keepBefore !== undefined && end !== null && end < keepBefore) plan.kept++;
      else plan.remove.push(ev.id);
      continue;
    }
    seen.add(ev.id);
    const hash = ev.extendedProperties?.private?.[GCAL_HASH_PROP];
    if (hash === target.extendedProperties.private[GCAL_HASH_PROP]) plan.unchanged++;
    else plan.update.push(target);
  }
  for (const d of desired) if (!seen.has(d.id)) plan.insert.push(d);
  return plan;
}

// =============================================================================
// 執行
// =============================================================================

export type SyncResult = {
  calendarId: string;
  desired: number;
  inserted: number;
  updated: number;
  removed: number;
  unchanged: number;
  foreign: number;
  kept: number;
  errors: Array<{ op: "insert" | "update" | "remove"; id: string; message: string }>;
};

const MAX_ERRORS_KEPT = 20;

async function runLimited<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 把 desired 套到 calendarId 上。單筆失敗不會中斷整輪（記在 errors），讓其他事件照常更新；
 * 列出既有事件失敗則整輪 throw（不知道現況就不能算差異，更不能刪）。
 *
 * desired = [] 就是「把我們建立的事件全部清掉」（換日曆、中斷連結時用），一樣只動 isOwnEvent。
 */
export async function syncCalendar(
  client: CalendarClient,
  calendarId: string,
  desired: GoogleEventResource[],
  options: { concurrency?: number; keepEndedBeforeMs?: number } = {},
): Promise<SyncResult> {
  const existing = await client.listManaged(calendarId);
  const plan = planSync(desired, existing, { keepEndedBeforeMs: options.keepEndedBeforeMs });
  const result: SyncResult = {
    calendarId,
    desired: desired.length,
    inserted: 0,
    updated: 0,
    removed: 0,
    unchanged: plan.unchanged,
    foreign: plan.foreign,
    kept: plan.kept,
    errors: [],
  };
  const fail = (op: SyncResult["errors"][number]["op"], id: string, err: unknown) => {
    if (result.errors.length < MAX_ERRORS_KEPT)
      result.errors.push({ op, id, message: errMessage(err) });
    else if (result.errors.length === MAX_ERRORS_KEPT)
      result.errors.push({ op, id: "…", message: "更多錯誤已省略" });
  };
  const concurrency = options.concurrency ?? 3;

  await runLimited(plan.insert, concurrency, async (ev) => {
    try {
      await client.insert(calendarId, ev);
      result.inserted++;
    } catch (err) {
      // 409：這個 id 已經存在、但不在「我們的」清單裡。多半是業主手動刪過（Google 保留已取消的
      // 那筆）→ patch 恢復。**先讀回來確認**：只有已取消、或確實是我們建立的才 patch；其他
      // （有人用同一個 id 造了一筆）一律不碰，算 foreign。
      if (err instanceof GoogleApiError && err.status === 409) {
        try {
          const cur = await client.get(calendarId, ev.id);
          if (cur && (cur.status === "cancelled" || isOwnEvent(cur))) {
            await client.patch(calendarId, ev.id, ev);
            result.inserted++;
          } else {
            result.foreign++;
            fail("insert", ev.id, new Error("日曆裡已有同 id、但不是網站建立的事件，未修改"));
          }
        } catch (err2) {
          fail("insert", ev.id, err2);
        }
      } else fail("insert", ev.id, err);
    }
  });
  await runLimited(plan.update, concurrency, async (ev) => {
    try {
      await client.patch(calendarId, ev.id, ev);
      result.updated++;
    } catch (err) {
      fail("update", ev.id, err);
    }
  });
  await runLimited(plan.remove, concurrency, async (id) => {
    try {
      await client.remove(calendarId, id);
      result.removed++;
    } catch (err) {
      // 404／410：已經不在了，目的已達成。
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) {
        result.removed++;
      } else fail("remove", id, err);
    }
  });
  return result;
}
