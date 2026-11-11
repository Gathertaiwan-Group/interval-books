#!/usr/bin/env node
/**
 * google-calendar-selftest.mjs —— 活動同步進業主 Google 日曆（0060）的行為自檢。
 *
 * 直接 import 真正的程式碼（src/lib/google-calendar-sync.ts、src/server/google-calendar-crypto.ts、
 * google-calendar-config.ts、google-calendar-api.ts 都只 import 相對路徑與 node:crypto）。
 * Google 一律用假的 client／假的 fetch：不發任何網路請求、不碰資料庫、不寫任何日曆。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import {
  buildDesiredGoogleEvents,
  googleEventIdForKey,
  isValidGoogleEventId,
  isOwnEvent,
  planSync,
  historyCutoffMs,
  eventEndMs,
  syncCalendar,
  GoogleApiError,
  GCAL_MANAGED_PROP,
  GCAL_KEY_PROP,
  GCAL_HASH_PROP,
} from "../src/lib/google-calendar-sync.ts";
import { buildCalendarEntries, buildCalendarIcs } from "../src/lib/calendar-ics.ts";
import {
  encryptSecret,
  decryptSecret,
  parseTokenKey,
  keyId,
  signState,
  verifyState,
  pkceChallenge,
  safeEqual,
} from "../src/server/google-calendar-crypto.ts";
import {
  readGoogleCalendarConfig,
  DEFAULT_REDIRECT_URI,
  GOOGLE_CALENDAR_SCOPES,
} from "../src/server/google-calendar-config.ts";
import { buildAuthorizeUrl, createCalendarClient } from "../src/server/google-calendar-api.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = relative(ROOT, fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else {
    fail++;
    console.log(
      `✗ ${name}\n    actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`,
    );
  }
}
const checkTrue = (name, v) => check(name, !!v, true);
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// =============================================================================
// 固定的網站資料
// =============================================================================
const NOW = new Date("2026-11-05T00:00:00Z");
function fixture(overrides = {}) {
  return {
    events: [
      {
        id: "e1",
        slug: "moss",
        status: "live",
        titleZh: "布苔球工作坊",
        summaryZh: "<p>做一顆苔球</p>",
        displayDate: "2026.11.28 (六) 15:00–16:30",
        externalUrl: "",
        registrationType: "internal",
        updatedAt: "2026-11-01T00:00:00Z",
        productId: "p1",
        price: 800,
        isoDate: "2026-11-28",
      },
      {
        id: "e2",
        slug: "trip",
        status: "live",
        titleZh: "花蓮策旅",
        summaryZh: "三天兩夜",
        displayDate: "",
        externalUrl: "https://x.example/j",
        registrationType: "external",
        updatedAt: "2026-10-01T00:00:00Z",
        productId: null,
        price: null,
        isoDate: "2026-12-10",
      },
      {
        id: "e3",
        slug: "draft",
        status: "draft",
        titleZh: "草稿活動",
        summaryZh: "",
        displayDate: "",
        externalUrl: "",
        registrationType: "internal",
        updatedAt: null,
        productId: "p3",
        price: 0,
        isoDate: null,
      },
      {
        id: "e4",
        slug: "talk",
        status: "live",
        titleZh: "講座",
        summaryZh: "",
        displayDate: "",
        externalUrl: "",
        registrationType: "internal",
        updatedAt: null,
        productId: "p4",
        price: 0,
        isoDate: null,
      },
    ],
    sessions: [
      {
        id: "s1",
        productId: "p1",
        titleZh: "布苔球工作坊｜第一梯次",
        locationZh: "華山",
        startsAt: "2026-11-28T07:00:00Z",
        endsAt: null,
        capacity: 10,
        seatsTaken: 3,
        updatedAt: null,
      },
      {
        id: "s2",
        productId: "p1",
        titleZh: "第二梯次",
        locationZh: "",
        startsAt: "2026-11-29T07:00:00Z",
        endsAt: "2026-11-29T09:00:00Z",
        capacity: 0,
        seatsTaken: 0,
        updatedAt: null,
      },
      {
        id: "s3",
        productId: "p3",
        titleZh: "",
        locationZh: "",
        startsAt: "2026-12-01T07:00:00Z",
        endsAt: null,
        capacity: 5,
        seatsTaken: 0,
        updatedAt: null,
      },
      // 超出 90 天：不出現
      {
        id: "s4",
        productId: "p4",
        titleZh: "",
        locationZh: "",
        startsAt: "2026-06-01T07:00:00Z",
        endsAt: null,
        capacity: 5,
        seatsTaken: 0,
        updatedAt: null,
      },
      // 90 天內、報名截止（額滿）：照樣出現
      {
        id: "s5",
        productId: "p4",
        titleZh: "",
        locationZh: "",
        startsAt: "2026-10-01T07:00:00Z",
        endsAt: null,
        capacity: 5,
        seatsTaken: 9,
        updatedAt: null,
      },
    ],
    plans: [],
    journeyUrls: ["https://x.example/j"],
    storeAddress: "台北市華山",
    now: NOW,
    ...overrides,
  };
}

// =============================================================================
// [1] 事件組裝（與 /calendar.ics 同一份規則）
// =============================================================================
console.log("[1] 事件組裝");
{
  const input = fixture();
  const desired = buildDesiredGoogleEvents(input);
  const entries = buildCalendarEntries(input);
  check("事件數與 /calendar.ics 的條目一致", desired.length, entries.length);
  check(
    "對應鍵：場次＋沒有場次的活動用 event:",
    desired.map((d) => d.extendedProperties.private[GCAL_KEY_PROP]),
    ["session:s5", "session:s1", "session:s2", "event:e2"],
  );
  const ics = buildCalendarIcs(input);
  check(
    "ICS 的 VEVENT 數與 Google 事件數一致",
    (ics.match(/BEGIN:VEVENT/g) ?? []).length,
    desired.length,
  );
  const byKey = Object.fromEntries(
    desired.map((d) => [d.extendedProperties.private[GCAL_KEY_PROP], d]),
  );
  const s1 = byKey["session:s1"];
  check("多場次活動標題帶場次名", s1.summary, "布苔球工作坊｜第一梯次");
  check("時間：dateTime（UTC ISO）＋ Asia/Taipei", s1.start, {
    dateTime: "2026-11-28T07:00:00.000Z",
    timeZone: "Asia/Taipei",
  });
  check("沒有 ends_at 用顯示時間推估（16:30 台北）", s1.end.dateTime, "2026-11-28T08:30:00.000Z");
  check("地點", s1.location, "華山");
  check("場次沒填地點 → 書店地址", byKey["session:s2"].location, "台北市華山");
  checkTrue("描述含活動網址", s1.description.includes("https://www.intervalbooks.tw/events/moss"));
  checkTrue("名額那一行用「同步」措辭", s1.description.includes("截至同步時尚餘 7 位"));
  checkTrue(
    "/calendar.ics 照舊用「訂閱更新」措辭",
    ics.replace(/\r\n /g, "").includes("截至訂閱更新時尚餘 7 位"),
  );
  check("source.url 是活動頁", s1.source.url, "https://www.intervalbooks.tw/events/moss");
  check("不跳通知", s1.reminders, { useDefault: false });
  check("場次佔忙碌時段", s1.transparency, "opaque");
  const trip = byKey["event:e2"];
  check("策旅加「策旅｜」前綴", trip.summary, "策旅｜花蓮策旅");
  check(
    "沒有場次 → 全天事件（台北日期）",
    [trip.start, trip.end],
    [{ date: "2026-12-10" }, { date: "2026-12-11" }],
  );
  check("全天事件不佔忙碌時段", trip.transparency, "transparent");
  checkTrue("外部報名附報名連結", trip.description.includes("報名連結：https://x.example/j"));
  checkTrue("草稿活動不出現", !desired.some((d) => d.summary.includes("草稿")));
  checkTrue("報名截止（額滿）場次照樣出現", !!byKey["session:s5"]);
  checkTrue("超過 90 天的場次不出現", !byKey["session:s4"]);
}

// =============================================================================
// [2] id 對應
// =============================================================================
console.log("[2] id 對應");
{
  const id = googleEventIdForKey("session:3f2a6c1e-0000-4000-8000-000000000001");
  checkTrue("固定 id 符合 Google 規則（base32hex 小寫 5–1024）", isValidGoogleEventId(id));
  check("固定 id 長度 34", id.length, 34);
  check(
    "同一個 key 永遠同一個 id",
    googleEventIdForKey("session:3f2a6c1e-0000-4000-8000-000000000001"),
    id,
  );
  checkTrue(
    "不同 key 不同 id",
    googleEventIdForKey("session:x") !== googleEventIdForKey("event:x"),
  );
  checkTrue(
    "大寫或 w-z 不合規則",
    !isValidGoogleEventId("ABCDE") && !isValidGoogleEventId("abcdz"),
  );
  const d = buildDesiredGoogleEvents(fixture());
  checkTrue(
    "每一筆事件 id 都等於 key 的雜湊",
    d.every((e) => e.id === googleEventIdForKey(e.extendedProperties.private[GCAL_KEY_PROP])),
  );
  checkTrue(
    "每一筆都標 managed=1 與內容雜湊",
    d.every(
      (e) =>
        e.extendedProperties.private[GCAL_MANAGED_PROP] === "1" &&
        /^[0-9a-f]{32}$/.test(e.extendedProperties.private[GCAL_HASH_PROP]),
    ),
  );
  const again = buildDesiredGoogleEvents(fixture());
  check(
    "同樣的資料 → 同樣的雜湊（決定性）",
    again.map((e) => e.extendedProperties.private[GCAL_HASH_PROP]),
    d.map((e) => e.extendedProperties.private[GCAL_HASH_PROP]),
  );
}

// =============================================================================
// [3] 只動自己的事件
// =============================================================================
console.log("[3] 只動自己的事件");
{
  const ours = buildDesiredGoogleEvents(fixture())[0];
  checkTrue(
    "自己建立的 → isOwnEvent",
    isOwnEvent({ id: ours.id, extendedProperties: ours.extendedProperties }),
  );
  checkTrue("業主手動建立（沒有屬性）→ 不是", !isOwnEvent({ id: "abc123manual" }));
  checkTrue(
    "有 managed 但 id 對不上 key（偽造／複製）→ 不是",
    !isOwnEvent({
      id: "ib0000",
      extendedProperties: { private: { [GCAL_MANAGED_PROP]: "1", [GCAL_KEY_PROP]: "session:s1" } },
    }),
  );
  checkTrue(
    'managed 不是 "1" → 不是',
    !isOwnEvent({
      id: ours.id,
      extendedProperties: {
        private: { ...ours.extendedProperties.private, [GCAL_MANAGED_PROP]: "0" },
      },
    }),
  );
  checkTrue(
    "key 格式不對 → 不是",
    !isOwnEvent({
      id: googleEventIdForKey("whatever"),
      extendedProperties: { private: { [GCAL_MANAGED_PROP]: "1", [GCAL_KEY_PROP]: "whatever" } },
    }),
  );
}

// =============================================================================
// [4] 差異計算＋執行（假 Calendar client）
// =============================================================================
console.log("[4] 新增／更新／刪除");

/** 假 Google 日曆：listManaged 照 Google 的 privateExtendedProperty 篩選（只看屬性，不驗 id）。 */
function fakeCalendar(initial = []) {
  const store = new Map(initial.map((e) => [e.id, structuredClone(e)]));
  const calls = [];
  const fails = { insert: new Map(), patch: new Map(), remove: new Map() };
  return {
    store,
    calls,
    fails,
    client: {
      async listManaged(cal) {
        calls.push(["list", cal]);
        return [...store.values()]
          .filter(
            (e) =>
              e.extendedProperties?.private?.[GCAL_MANAGED_PROP] === "1" &&
              e.status !== "cancelled",
          )
          .map((e) => ({
            id: e.id,
            status: e.status,
            end: structuredClone(e.end),
            extendedProperties: structuredClone(e.extendedProperties),
          }));
      },
      async get(cal, id) {
        calls.push(["get", id]);
        const e = store.get(id);
        return e
          ? {
              id: e.id,
              status: e.status,
              extendedProperties: structuredClone(e.extendedProperties),
            }
          : null;
      },
      async insert(cal, ev) {
        calls.push(["insert", ev.id]);
        if (fails.insert.has(ev.id)) throw fails.insert.get(ev.id);
        if (store.has(ev.id)) throw new GoogleApiError(409, "duplicate", "exists");
        store.set(ev.id, structuredClone(ev));
      },
      async patch(cal, id, ev) {
        calls.push(["patch", id]);
        if (fails.patch.has(id)) throw fails.patch.get(id);
        if (!store.has(id)) throw new GoogleApiError(404, "notFound", "nope");
        store.set(id, { ...store.get(id), ...structuredClone(ev), id });
      },
      async remove(cal, id) {
        calls.push(["remove", id]);
        if (fails.remove.has(id)) throw fails.remove.get(id);
        if (!store.has(id)) throw new GoogleApiError(410, "deleted", "gone");
        store.delete(id);
      },
    },
  };
}

const manual1 = { id: "manualevent0001", summary: "中華文創台北分會" };
const manual2 = {
  id: "manualevent0002",
  summary: "Yoki 來華山講座",
  extendedProperties: { private: { other: "x" } },
};
// 偽造：帶了 managed=1，但 id 不是 key 的雜湊 —— 不可以被刪。
const forged = {
  id: "forged00001",
  summary: "複製來的事件",
  extendedProperties: { private: { [GCAL_MANAGED_PROP]: "1", [GCAL_KEY_PROP]: "session:s1" } },
};

{
  const cal = fakeCalendar([manual1, manual2, forged]);
  const desired = buildDesiredGoogleEvents(fixture());
  const r1 = await syncCalendar(cal.client, "cal-1", desired);
  check("第一輪：全部新增", [r1.inserted, r1.updated, r1.removed, r1.errors.length], [4, 0, 0, 0]);
  check("第一輪：偽造事件被算成 foreign、不碰", r1.foreign, 1);
  checkTrue("業主手動事件還在", cal.store.has(manual1.id) && cal.store.has(manual2.id));
  checkTrue("偽造事件還在", cal.store.has(forged.id));

  const r2 = await syncCalendar(cal.client, "cal-1", buildDesiredGoogleEvents(fixture()));
  check(
    "第二輪（內容沒變）：完全不寫",
    [r2.inserted, r2.updated, r2.removed, r2.unchanged],
    [0, 0, 0, 4],
  );
  check("第二輪只呼叫 list", cal.calls.slice(-1)[0][0], "list");

  // 改時間＋改標題＋改地點
  const changed = fixture();
  changed.sessions = changed.sessions.map((s) =>
    s.id === "s2"
      ? {
          ...s,
          startsAt: "2026-11-30T07:00:00Z",
          endsAt: "2026-11-30T09:00:00Z",
          locationZh: "松菸",
        }
      : s,
  );
  changed.events = changed.events.map((e) =>
    e.id === "e2" ? { ...e, titleZh: "花蓮策旅（改）" } : e,
  );
  const r3 = await syncCalendar(cal.client, "cal-1", buildDesiredGoogleEvents(changed));
  check(
    "時間／地點／標題變更：只更新那兩筆",
    [r3.inserted, r3.updated, r3.removed, r3.unchanged],
    [0, 2, 0, 2],
  );
  const s2 = cal.store.get(googleEventIdForKey("session:s2"));
  check(
    "更新後的時間與地點",
    [s2.start.dateTime, s2.location],
    ["2026-11-30T07:00:00.000Z", "松菸"],
  );

  // 活動下架＋場次刪除
  const removed = fixture();
  removed.events = removed.events.map((e) => (e.id === "e2" ? { ...e, status: "archived" } : e));
  removed.sessions = removed.sessions.filter((s) => s.id !== "s2");
  const r4 = await syncCalendar(cal.client, "cal-1", buildDesiredGoogleEvents(removed), {
    keepEndedBeforeMs: historyCutoffMs(removed.now),
  });
  check("下架＋場次刪除：刪兩筆", r4.removed, 2);
  checkTrue(
    "刪的正是那兩筆",
    !cal.store.has(googleEventIdForKey("event:e2")) &&
      !cal.store.has(googleEventIdForKey("session:s2")),
  );
  checkTrue(
    "業主手動事件與偽造事件仍在",
    cal.store.has(manual1.id) && cal.store.has(manual2.id) && cal.store.has(forged.id),
  );

  // 超出範圍（業主 2026-11-11 決定：歷史保留）：時間往後推到 2027-01-05，分界 2026-10-07。
  //   s5（10/01 結束）已是歷史 → 保留、不刪、不更新；
  //   s1（11/28，仍在範圍內）同時被刪掉場次 → 照刪。
  const later = fixture({ now: new Date("2027-01-05T00:00:00Z") });
  later.sessions = later.sessions.filter((s) => s.id !== "s2" && s.id !== "s1");
  later.events = later.events.map((e) => (e.id === "e2" ? { ...e, status: "archived" } : e));
  const s5Before = JSON.stringify(cal.store.get(googleEventIdForKey("session:s5")));
  const callsBefore = cal.calls.length;
  const r5 = await syncCalendar(cal.client, "cal-1", buildDesiredGoogleEvents(later), {
    keepEndedBeforeMs: historyCutoffMs(later.now),
  });
  check(
    "歷史分界 = now − 90 天",
    new Date(historyCutoffMs(later.now)).toISOString(),
    "2026-10-07T00:00:00.000Z",
  );
  checkTrue("超出 90 天的場次保留在日曆（歷史）", cal.store.has(googleEventIdForKey("session:s5")));
  check(
    "歷史事件內容一個字沒動",
    JSON.stringify(cal.store.get(googleEventIdForKey("session:s5"))),
    s5Before,
  );
  checkTrue(
    "沒有對歷史事件發任何寫入",
    !cal.calls
      .slice(callsBefore)
      .some(([op, id]) => op !== "list" && id === googleEventIdForKey("session:s5")),
  );
  // inserted 1：e1 的場次全被刪光 → 退回 iso_date 全天事件（與 /calendar.ics 同一規則）。
  check("範圍內被刪的場次照刪、歷史計 kept", [r5.removed, r5.kept, r5.inserted], [1, 1, 1]);
  checkTrue("e1 場次刪光 → 改成全天事件", cal.store.has(googleEventIdForKey("event:e1")));
  checkTrue("範圍內被刪的 s1 不在了", !cal.store.has(googleEventIdForKey("session:s1")));

  // 歷史事件之後被下架（活動 e4 archived）：照樣保留，不刪
  const later2 = structuredClone(later);
  later2.now = later.now;
  later2.events = later2.events.map((e) => (e.id === "e4" ? { ...e, status: "archived" } : e));
  const r5b = await syncCalendar(cal.client, "cal-1", buildDesiredGoogleEvents(later2), {
    keepEndedBeforeMs: historyCutoffMs(later2.now),
  });
  checkTrue(
    "歷史事件的活動下架 → 仍保留",
    cal.store.has(googleEventIdForKey("session:s5")) && r5b.removed === 0,
  );

  // 沒給 keepEndedBeforeMs（舊行為）→ 歷史也會被刪：證明保留是那個選項造成的，不是巧合
  const plan0 = planSync([], [structuredClone(cal.store.get(googleEventIdForKey("session:s5")))]);
  check("不給分界 → 可刪", plan0.remove.length, 1);
  const plan1 = planSync([], [structuredClone(cal.store.get(googleEventIdForKey("session:s5")))], {
    keepEndedBeforeMs: historyCutoffMs(later.now),
  });
  check("給分界 → 保留", [plan1.remove.length, plan1.kept], [0, 1]);
  const ownNoEnd = {
    ...structuredClone(cal.store.get(googleEventIdForKey("session:s5"))),
    end: undefined,
  };
  check(
    "結束時間讀不出來 → 當成範圍內（可刪）",
    planSync([], [ownNoEnd], { keepEndedBeforeMs: historyCutoffMs(later.now) }).remove.length,
    1,
  );
  check(
    "全天事件 end.date 以台北午夜算",
    eventEndMs({ id: "x", end: { date: "2026-12-11" } }),
    Date.parse("2026-12-10T16:00:00Z"),
  );

  // 清空（換日曆／中斷連結）：desired = [] 只刪自己的——歷史事件也一起清（不給分界）
  const r6 = await syncCalendar(cal.client, "cal-1", []);
  check(
    "清空：剩下的都是業主的與偽造的",
    [...cal.store.keys()].sort(),
    [forged.id, manual1.id, manual2.id].sort(),
  );
  check("清空沒有錯誤", r6.errors.length, 0);
  const touched = cal.calls.filter(([op]) => op !== "list").map(([, id]) => id);
  checkTrue(
    "全程沒有對業主事件或偽造事件發過寫入",
    !touched.some((id) => [manual1.id, manual2.id, forged.id].includes(id)),
  );
}

{
  // 409：業主手動刪過（Google 留著 cancelled 的同一個 id）→ 改用 patch 恢復
  const desired = buildDesiredGoogleEvents(fixture());
  const cancelled = { ...structuredClone(desired[0]), status: "cancelled" };
  const cal = fakeCalendar([cancelled]);
  const r = await syncCalendar(cal.client, "cal-1", desired);
  check("409 改走 patch，算新增成功", [r.inserted, r.errors.length], [desired.length, 0]);
  check("被恢復成 confirmed", cal.store.get(desired[0].id).status, "confirmed");

  // 409 但那筆不是我們的（有人用同一個 id 造了一筆）→ 不 patch、算 foreign
  const squatter = { id: desired[0].id, summary: "別人的事件", status: "confirmed" };
  const cal2 = fakeCalendar([squatter]);
  const r2 = await syncCalendar(cal2.client, "cal-1", desired);
  check("409 且非自己的：不修改", cal2.store.get(desired[0].id).summary, "別人的事件");
  check("409 且非自己的：計 foreign＋一筆錯誤", [r2.foreign, r2.errors.length], [1, 1]);
  checkTrue(
    "409 且非自己的：沒有對它發 patch",
    !cal2.calls.some(([op, id]) => op === "patch" && id === desired[0].id),
  );
}
{
  // 地點清空：PATCH 是合併語意，location 必須一律送（空字串）才清得掉
  const ev = buildDesiredGoogleEvents(fixture({ storeAddress: "" })).find(
    (e) => e.extendedProperties.private[GCAL_KEY_PROP] === "session:s2",
  );
  check(
    "沒有地點 → location 送空字串（不是省略）",
    Object.prototype.hasOwnProperty.call(ev, "location") && ev.location,
    "",
  );
}
{
  // 單筆失敗不中斷整輪；刪除遇到 404/410 視為已刪
  const desired = buildDesiredGoogleEvents(fixture());
  const cal = fakeCalendar();
  cal.fails.insert.set(desired[1].id, new GoogleApiError(500, "backendError", "boom"));
  const r = await syncCalendar(cal.client, "cal-1", desired);
  check(
    "一筆失敗，其他照常寫入",
    [r.inserted, r.errors.length, r.errors[0]?.op],
    [desired.length - 1, 1, "insert"],
  );
  const stale = buildDesiredGoogleEvents(fixture())[0];
  const cal2 = fakeCalendar([stale]);
  cal2.fails.remove.set(stale.id, new GoogleApiError(410, "deleted", "gone"));
  const r2 = await syncCalendar(cal2.client, "cal-1", []);
  check("刪除遇到 410 視為已刪", [r2.removed, r2.errors.length], [1, 0]);
}
{
  // 列不出現況 → 整輪 throw（不知道現況就不算差異、更不刪）
  let threw = false;
  try {
    await syncCalendar(
      {
        listManaged: async () => {
          throw new Error("list failed");
        },
        insert: async () => {},
        patch: async () => {},
        remove: async () => {},
      },
      "cal-1",
      [],
    );
  } catch {
    threw = true;
  }
  checkTrue("listManaged 失敗 → throw", threw);
  const p = planSync([], [{ id: "x", status: "cancelled", extendedProperties: { private: {} } }]);
  check("planSync：非自己的事件計 foreign", p.foreign, 1);
}

// =============================================================================
// [5] token 加解密與 state
// =============================================================================
console.log("[5] 加密");
{
  const k1 = parseTokenKey(Buffer.alloc(32, 1).toString("base64"));
  const k2 = parseTokenKey(Buffer.alloc(32, 2).toString("base64url"));
  checkTrue("32 bytes base64／base64url 都接受", k1 && k2 && k1.length === 32 && k2.length === 32);
  check("長度不對 → null", parseTokenKey(Buffer.alloc(16).toString("base64")), null);
  check("空字串 → null", parseTokenKey(""), null);
  const blob = encryptSecret("1//refresh-token-秘密", k1);
  checkTrue("密文不含明文", !blob.includes("refresh-token"));
  check("密文格式 v1.<kid>.…", blob.split(".").slice(0, 2), ["v1", keyId(k1)]);
  checkTrue("每次加密都不同（隨機 IV）", encryptSecret("x", k1) !== encryptSecret("x", k1));
  check("解密還原", decryptSecret(blob, [k1]).plaintext, "1//refresh-token-秘密");
  check("用現行金鑰解開 → 不需輪替", decryptSecret(blob, [k1]).stale, false);
  check(
    "輪替：新鑰在前、舊鑰在後 → 用舊鑰解開並標記需要重新加密",
    decryptSecret(blob, [k2, k1]).stale,
    true,
  );
  let wrongKey = false;
  try {
    decryptSecret(blob, [k2]);
  } catch {
    wrongKey = true;
  }
  checkTrue("金鑰不在設定裡 → throw", wrongKey);
  const parts = blob.split(".");
  const ct = Buffer.from(parts[3], "base64url");
  ct[0] ^= 1;
  parts[3] = ct.toString("base64url");
  let tampered = false;
  try {
    decryptSecret(parts.join("."), [k1]);
  } catch {
    tampered = true;
  }
  checkTrue("密文被竄改 → throw（GCM 驗證）", tampered);
  const short = blob.split(".");
  short[4] = Buffer.from(short[4], "base64url").subarray(0, 4).toString("base64url");
  let shortTag = false;
  try {
    decryptSecret(short.join("."), [k1]);
  } catch {
    shortTag = true;
  }
  checkTrue("截短的驗證標籤 → throw", shortTag);

  const payload = { s: "state123", v: "verifier", u: "user-1", exp: 2_000 };
  const tok = signState(payload, k1);
  check("state 簽章可驗", verifyState(tok, k1, 1_000), payload);
  check("過期 → null", verifyState(tok, k1, 3_000), null);
  check("換金鑰 → null", verifyState(tok, k2, 1_000), null);
  const [body, mac] = tok.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ ...payload, u: "attacker" })).toString(
    "base64url",
  );
  check("改內容 → null", verifyState(`${forgedBody}.${mac}`, k1, 1_000), null);
  check("沒有 cookie → null", verifyState(undefined, k1, 1_000), null);
  checkTrue("body 本身不是明碼 JSON 以外的秘密（只是簽章）", body.length > 10);
  check(
    "safeEqual",
    [safeEqual("a", "a"), safeEqual("a", "b"), safeEqual("a", "ab")],
    [true, false, false],
  );
  check(
    "PKCE S256（RFC 7636 附錄 B 測試向量）",
    pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
}

// =============================================================================
// [6] 未設定時停用
// =============================================================================
console.log("[6] 設定");
{
  const off = readGoogleCalendarConfig({});
  check(
    "什麼都沒設 → 停用＋列出缺哪三個",
    [off.enabled, off.missing],
    [false, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_CALENDAR_TOKEN_KEY"]],
  );
  const key = Buffer.alloc(32, 7).toString("base64");
  check(
    "缺 secret → 停用",
    readGoogleCalendarConfig({ GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_CALENDAR_TOKEN_KEY: key })
      .enabled,
    false,
  );
  const bad = readGoogleCalendarConfig({
    GOOGLE_OAUTH_CLIENT_ID: "id",
    GOOGLE_OAUTH_CLIENT_SECRET: "s",
    GOOGLE_CALENDAR_TOKEN_KEY: "short",
  });
  check("金鑰長度不對 → 停用＋標 invalid", [bad.enabled, bad.invalid.length], [false, 1]);
  const on = readGoogleCalendarConfig({
    GOOGLE_OAUTH_CLIENT_ID: "id",
    GOOGLE_OAUTH_CLIENT_SECRET: "s",
    GOOGLE_CALENDAR_TOKEN_KEY: key,
  });
  check(
    "設齊 → 啟用、預設 redirect",
    [on.enabled, on.redirectUri, on.keys.length],
    [true, DEFAULT_REDIRECT_URI, 1],
  );
  check(
    "預設 redirect URI",
    DEFAULT_REDIRECT_URI,
    "https://www.intervalbooks.tw/admin/google-calendar/callback",
  );
  const rot = readGoogleCalendarConfig({
    GOOGLE_OAUTH_CLIENT_ID: "id",
    GOOGLE_OAUTH_CLIENT_SECRET: "s",
    GOOGLE_CALENDAR_TOKEN_KEY: key,
    GOOGLE_CALENDAR_TOKEN_KEY_PREVIOUS: Buffer.alloc(32, 8).toString("base64"),
  });
  check("輪替中：兩把金鑰、現行在前", rot.keys.length, 2);
  check(
    "http redirect 不接受",
    readGoogleCalendarConfig({
      GOOGLE_OAUTH_CLIENT_ID: "id",
      GOOGLE_OAUTH_CLIENT_SECRET: "s",
      GOOGLE_CALENDAR_TOKEN_KEY: key,
      GOOGLE_OAUTH_REDIRECT_URI: "http://x/cb",
    }).enabled,
    false,
  );
  check(
    "scope 只有兩個（events＋calendarlist.readonly）",
    [...GOOGLE_CALENDAR_SCOPES],
    [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    ],
  );

  // 停用時不碰資料庫、不打 Google（靜態：設定檢查在任何 DB 讀取之前）
  const gc = stripComments(read("src/server/google-calendar.ts"));
  const fnBody = (name) => {
    const i = gc.indexOf(`export async function ${name}`);
    return gc.slice(i, gc.indexOf("\nexport ", i + 10));
  };
  const status = fnBody("getGoogleCalendarStatus");
  checkTrue(
    "狀態：未設定時在 readRow 之前 return",
    status.indexOf("if (!cfg.enabled) return") > 0 &&
      status.indexOf("if (!cfg.enabled) return") < status.indexOf("readRow()"),
  );
  const run = fnBody("runGoogleCalendarSync");
  checkTrue(
    "同步：未設定時在 supabaseAdmin 之前 return disabled",
    run.indexOf('return { status: "disabled" }') > 0 &&
      run.indexOf('return { status: "disabled" }') < run.indexOf("supabaseAdmin()"),
  );
  const nudge = fnBody("nudgeGoogleCalendarSync");
  checkTrue(
    "觸發：未設定時在 rpc 之前 return",
    nudge.indexOf("enabled) return") > 0 &&
      nudge.indexOf("enabled) return") < nudge.indexOf(".rpc("),
  );
  checkTrue(
    "觸發：整支包在 try/catch（永不 throw）",
    /try \{[\s\S]*\} catch \(err\) \{[\s\S]*console\.warn/.test(nudge),
  );
  checkTrue(
    "換日曆在同步鎖裡清舊日曆、清不乾淨就不換",
    /withSyncLock\("switch"[\s\S]*purgeOwnEvents[\s\S]*r\.errors\.length\) \{\s*throw/.test(
      fnBody("setGoogleCalendarTarget"),
    ),
  );
  checkTrue(
    "定期同步帶歷史分界（90 天前的事件保留）",
    /keepEndedBeforeMs: historyCutoffMs\(input\.now\)/.test(run),
  );
  checkTrue(
    "清空（換日曆／中斷連結）不帶分界",
    /syncCalendar\(createCalendarClient\(accessToken\), calendarId, \[\]\)/.test(gc),
  );
  checkTrue(
    "中斷連結在同步鎖裡清事件並刪列",
    /withSyncLock\("disconnect"[\s\S]*await work\(\);\s*await deleteRow\(\);/.test(
      fnBody("disconnectGoogleCalendar"),
    ),
  );
}

// =============================================================================
// [7] Google API 的請求形狀（假 fetch）
// =============================================================================
console.log("[7] API");
{
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "cid",
      redirectUri: DEFAULT_REDIRECT_URI,
      scopes: GOOGLE_CALENDAR_SCOPES,
      state: "st",
      codeChallenge: "cc",
      loginHint: "shop@example.com",
    }),
  );
  check("同意畫面網址", url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  check(
    "參數：offline＋consent＋PKCE＋state",
    ["access_type", "prompt", "code_challenge_method", "state", "redirect_uri", "login_hint"].map(
      (k) => url.searchParams.get(k),
    ),
    ["offline", "consent", "S256", "st", DEFAULT_REDIRECT_URI, "shop@example.com"],
  );
  check("scope 以空白分隔", url.searchParams.get("scope"), GOOGLE_CALENDAR_SCOPES.join(" "));

  const seen = [];
  let rateLimitedOnce = false;
  const fakeFetch = async (u, init = {}) => {
    seen.push({ u, method: init.method ?? "GET", auth: init.headers?.authorization });
    if ((init.method ?? "GET") === "POST" && !rateLimitedOnce) {
      rateLimitedOnce = true;
      return new Response(
        JSON.stringify({
          error: { errors: [{ reason: "rateLimitExceeded" }], message: "slow down" },
        }),
        { status: 403 },
      );
    }
    if ((init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ items: [{ id: "a" }] }), { status: 200 });
    }
    if (init.method === "PATCH")
      return new Response(
        JSON.stringify({ error: { message: "nope", errors: [{ reason: "notFound" }] } }),
        { status: 404 },
      );
    return new Response(init.method === "DELETE" ? null : "{}", {
      status: init.method === "DELETE" ? 204 : 200,
    });
  };
  const client = createCalendarClient("AT", fakeFetch, async () => {});
  const listed = await client.listManaged("shop@group.calendar.google.com");
  check("list 結果", listed, [{ id: "a" }]);
  const listUrl = new URL(seen[0].u);
  check(
    "list 用 privateExtendedProperty 篩選",
    listUrl.searchParams.get("privateExtendedProperty"),
    "intervalbooksManaged=1",
  );
  checkTrue(
    "list 有取 end（歷史判斷要用）",
    /items\(id,status,end,extendedProperties\)/.test(listUrl.searchParams.get("fields")),
  );
  checkTrue(
    "list 的日曆 id 有 URL 編碼",
    seen[0].u.includes("/calendars/shop%40group.calendar.google.com/events"),
  );
  check("帶 Bearer", seen[0].auth, "Bearer AT");
  const ev = buildDesiredGoogleEvents(fixture())[0];
  await client.insert("primary", ev);
  check("insert 遇到 rateLimitExceeded 會重試", seen.filter((s) => s.method === "POST").length, 2);
  checkTrue(
    "insert 不寄通知（sendUpdates=none）",
    seen.find((s) => s.method === "POST").u.includes("sendUpdates=none"),
  );
  let status = 0;
  try {
    await client.patch("primary", ev.id, ev);
  } catch (err) {
    status = err.status;
  }
  check("patch 404 → GoogleApiError.status = 404", status, 404);
  await client.remove("primary", ev.id);
  checkTrue(
    "delete 用固定 id",
    seen.some((s) => s.method === "DELETE" && s.u.includes(`/events/${ev.id}`)),
  );
}

// =============================================================================
// [8] 接線（靜態）
// =============================================================================
console.log("[8] 接線");
{
  const fns = stripComments(read("src/lib/admin/fns/google-calendar.ts"));
  const exports = fns.match(/export const \w+ = createServerFn[\s\S]*?\.handler/g) ?? [];
  check("fns：7 支 server fn", exports.length, 7);
  checkTrue(
    "fns：每一支都掛 adminFnMiddleware",
    exports.every((e) => e.includes(".middleware([adminFnMiddleware])")),
  );
  checkTrue(
    "callback：驗 state（常數時間）與同一位管理員",
    /safeEqual\(st\.s, data\.state\)/.test(fns) && /st\.u !== context\.admin\.userId/.test(fns),
  );
  checkTrue("callback：cookie 用過即刪", /deleteCookie\(STATE_COOKIE/.test(fns));
  checkTrue("state cookie 是 httpOnly", /httpOnly: true/.test(fns));

  for (const [file, names] of [
    [
      "src/lib/admin/fns/events.ts",
      [
        "upsertEvent",
        "upsertEventWithProduct",
        "createEventQuick",
        "removeEvent",
        "setEventStatus",
      ],
    ],
    [
      "src/lib/admin/fns/event-sessions.ts",
      [
        "upsertEventSession",
        "removeEventSession",
        "upsertEventSessionPlan",
        "removeEventSessionPlan",
      ],
    ],
    ["src/lib/admin/fns/journeys.ts", ["upsertJourney", "removeJourney", "setJourneyStatus"]],
  ]) {
    const src = stripComments(read(file));
    for (const n of names) {
      const i = src.indexOf(`export const ${n} = createServerFn`);
      const j = src.indexOf("\nexport const ", i + 10);
      const body = src.slice(i, j < 0 ? undefined : j);
      checkTrue(
        `${n}：存檔後觸發同步（在寫入之後）`,
        i >= 0 &&
          /nudgeGoogleCalendarSync\(\)/.test(body) &&
          body.indexOf("nudgeGoogleCalendarSync") > body.indexOf("const result"),
      );
    }
  }

  const server = stripComments(read("src/server.ts"));
  checkTrue(
    "server.ts 攔 /api/tasks/google-calendar（dynamic import）",
    /pathname === GOOGLE_CALENDAR_TASK_PATH\) \{\s*const \{ handleGoogleCalendarTask \} = await import\("@\/server\/task-endpoints"\)/.test(
      server,
    ),
  );
  const tasks = stripComments(read("src/server/task-endpoints.ts"));
  const h = tasks.slice(tasks.indexOf("export async function handleGoogleCalendarTask"));
  checkTrue(
    "task：路徑常數",
    /GOOGLE_CALENDAR_TASK_PATH = "\/api\/tasks\/google-calendar"/.test(tasks),
  );
  checkTrue(
    "task：缺密鑰 503、不符 404、密鑰檢查在載入同步程式之前",
    h.indexOf("503") > 0 &&
      h.indexOf('"not found", 404') > 0 &&
      h.indexOf('"not found", 404') < h.indexOf('import("@/server/google-calendar")'),
  );

  const sql = read("supabase/migrations/0060_google_calendar_sync.sql").replace(/--.*$/gm, "");
  checkTrue(
    "0060：開 RLS",
    /alter table public\.google_calendar_sync enable row level security/.test(sql),
  );
  checkTrue(
    "0060：anon／authenticated 沒有權限",
    /revoke all on table public\.google_calendar_sync from public, anon, authenticated/.test(sql),
  );
  checkTrue("0060：沒有任何 policy", !/create policy/i.test(sql));
  checkTrue(
    "0060：沒連結時 return null（不送 HTTP）",
    /if not found then\s*return null;/.test(sql) &&
      sql.indexOf("return null") < sql.indexOf("net.http_post"),
  );
  checkTrue(
    "0060：密鑰從 vault 讀、不寫進 cron 指令",
    /\$cron\$select public\.request_google_calendar_sync\(\)\$cron\$/.test(sql),
  );
  checkTrue(
    "0060：排程 9-54/15、不存在才建",
    /'9-54\/15 \* \* \* \*'/.test(sql) &&
      /if not exists \(select 1 from cron\.job where jobname = 'sync-google-calendar'\)/.test(sql),
  );
  checkTrue("0060：to_regprocedure 守衛（不是 to_regproc）", !/to_regproc\(/.test(sql));
  checkTrue(
    "0060：函式只 grant service_role",
    (sql.match(/grant  execute on function %s to service_role/g) ?? []).length === 1 &&
      /revoke execute on function %s from anon, authenticated/.test(sql),
  );
}

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
