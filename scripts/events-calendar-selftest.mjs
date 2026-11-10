#!/usr/bin/env node
/**
 * events-calendar-selftest.mjs —— /events 月曆檢視（src/lib/events-calendar.ts）的行為自檢。
 * 直接 import 真正的程式碼（該模組零 @/ import）。不碰資料庫、不發網路請求。
 *
 * 重點：月份切換（跨年）、月初星期偏移、Asia/Taipei 時區邊界（UTC 前一天 16:00 以後
 * = 台北隔天）、多場次／跨日／策旅、已結束與額滿只是「傳遞」不是自己算座位。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import {
  taipeiParts,
  taipeiMonthAt,
  taipeiDateAt,
  parseMonthParam,
  shiftMonth,
  addDays,
  daysBetween,
  weekdayOf,
  daysInMonth,
  monthGrid,
  buildCalendarEntries,
  itemsByDay,
  agendaGroups,
  monthHasEntries,
  nearestMonthWithEntries,
  monthLabel,
  dayLabel,
  rangeLabel,
  eventSlugForProduct,
} from "../src/lib/events-calendar.ts";

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
const L = (zh) => ({ zh, en: zh, ja: zh });

// ── 月份切換 ────────────────────────────────────────────────────────────
check("下一月：跨年", shiftMonth("2026-12", 1), "2027-01");
check("上一月：跨年", shiftMonth("2027-01", -1), "2026-12");
check("同年", shiftMonth("2026-11", 1), "2026-12");
check("一次跳 13 個月", shiftMonth("2026-11", 13), "2027-12");
check("往回 24 個月", shiftMonth("2026-01", -24), "2024-01");
check("往回 12 個月（12 月邊界）", shiftMonth("2026-12", -12), "2025-12");

// ── ?month= 驗證 ────────────────────────────────────────────────────────
check("合法", parseMonthParam("2026-11"), "2026-11");
check("前後空白", parseMonthParam(" 2026-03 "), "2026-03");
check("月份 13", parseMonthParam("2026-13"), undefined);
check("月份 00", parseMonthParam("2026-00"), undefined);
check("少補零", parseMonthParam("2026-3"), undefined);
check("年份過遠", parseMonthParam("9999-01"), undefined);
check("非字串", parseMonthParam(202611), undefined);
check("含日期", parseMonthParam("2026-11-01"), undefined);

// ── 曆法 ────────────────────────────────────────────────────────────────
check("2026-11-01 星期日", weekdayOf("2026-11-01"), 0);
check("2026-12-01 星期二", weekdayOf("2026-12-01"), 2);
check("2027-01-01 星期五", weekdayOf("2027-01-01"), 5);
check("2026-02 有 28 天", daysInMonth("2026-02"), 28);
check("2028-02 閏年 29 天", daysInMonth("2028-02"), 29);
check("2026-12 有 31 天", daysInMonth("2026-12"), 31);
check("加天數跨年", addDays("2026-12-31", 1), "2027-01-01");
check("減天數跨月", addDays("2026-03-01", -1), "2026-02-28");
check("天數差", daysBetween("2026-12-30", "2027-01-02"), 3);

{
  const nov = monthGrid("2026-11");
  check("11 月：第一格就是 1 日（偏移 0）", nov[0][0].date, "2026-11-01");
  check("11 月：5 列", nov.length, 5);
  check("11 月：最後一格補到 12/5", nov[4][6].date, "2026-12-05");
  check("11 月：補上的格子不算本月", nov[4][6].inMonth, false);

  const dec = monthGrid("2026-12");
  check(
    "12 月：前面補 2 格（11/29、11/30）",
    [dec[0][0].date, dec[0][1].date],
    ["2026-11-29", "2026-11-30"],
  );
  check("12 月：1 日在第三欄（星期二）", [dec[0][2].date, dec[0][2].weekday], ["2026-12-01", 2]);
  check("12 月：5 列", dec.length, 5);

  const jan = monthGrid("2027-01");
  check("2027-01：1 日在星期五欄（偏移 5）", jan[0][5].date, "2027-01-01");
  check("2027-01：第一格是 2026-12-27（跨年補格）", jan[0][0].date, "2026-12-27");
  check("2027-01：6 列", jan.length, 6);

  const feb = monthGrid("2026-02");
  check("2026-02：剛好 4 列", feb.length, 4);
  checkTrue(
    "每列 7 格",
    [nov, dec, jan, feb].every((g) => g.every((w) => w.length === 7)),
  );
  checkTrue(
    "每一格的 weekday 等於所在欄",
    jan.every((w) => w.every((d, i) => weekdayOf(d.date) === i && d.weekday === i)),
  );
}

// ── Asia/Taipei 時區邊界 ────────────────────────────────────────────────
check("UTC 前一天 16:00 = 台北隔天 00:00", taipeiParts("2026-11-30T16:00:00Z"), {
  date: "2026-12-01",
  time: "00:00",
});
check("UTC 15:59 仍是台北當天 23:59", taipeiParts("2026-11-30T15:59:00Z"), {
  date: "2026-11-30",
  time: "23:59",
});
check("+00:00 格式（PostgREST 給的）", taipeiParts("2026-11-24T11:30:00+00:00"), {
  date: "2026-11-24",
  time: "19:30",
});
check(
  "跨年夜：UTC 12/31 16:00 = 台北 2027-01-01",
  taipeiParts("2026-12-31T16:00:00Z")?.date,
  "2027-01-01",
);
check("解不開 → null", taipeiParts("not a date"), null);
check("空 → null", taipeiParts(null), null);
check(
  "本月（台北）：UTC 10/31 16:30 已是 11 月",
  taipeiMonthAt(Date.parse("2026-10-31T16:30:00Z")),
  "2026-11",
);
check("今天（台北）", taipeiDateAt(Date.parse("2026-11-09T17:00:00Z")), "2026-11-10");

// ── 組裝 ────────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-11-10T04:00:00Z"); // 台北 11/10 12:00
const input = {
  nowMs: NOW,
  journeyUrls: ["/events/kungtung", "https://example.com/trip"],
  events: [
    { slug: "soul-dinner", title: L("小時光｜靈魂飯桌"), externalUrl: "", isoDate: "2026-12-15" },
    { slug: "kungtung", title: L("公東教堂文化之旅"), externalUrl: "", isoDate: "2026-12-06" },
    { slug: "morning", title: L("晨間講座"), externalUrl: "", isoDate: "2026-11-07" },
    { slug: "no-session", title: L("外部報名的活動"), externalUrl: "", isoDate: "2026-11-20" },
    { slug: "tbd", title: L("即將公告"), externalUrl: "", isoDate: null },
    {
      slug: "ext-trip",
      title: L("外站策旅"),
      externalUrl: "https://example.com/trip/",
      isoDate: "2026-11-15",
    },
  ],
  sessions: [
    {
      id: "s-dinner-1",
      productSlug: "event-soul-dinner",
      title: L("2026.11.24（二）19:30–21:30｜光之行者"),
      location: L("小時光書店"),
      startsAt: "2026-11-24T11:30:00+00:00",
      endsAt: "2026-11-24T13:30:00+00:00",
      full: true,
    },
    {
      id: "s-dinner-2",
      productSlug: "event-soul-dinner",
      title: L("2026.12.01（二）19:30–21:30｜光之行者 第二集"),
      location: L("小時光書店"),
      startsAt: "2026-12-01T11:30:00+00:00",
      endsAt: "2026-12-01T13:30:00+00:00",
      full: false,
    },
    {
      id: "s-midnight",
      productSlug: "event-soul-dinner",
      title: L("跨日邊界"),
      location: L("小時光書店"),
      // UTC 11/30 16:30 = 台北 12/1 00:30 → 必須落在 12/1
      startsAt: "2026-11-30T16:30:00Z",
      endsAt: null,
      full: false,
    },
    {
      id: "s-kungtung",
      productSlug: "event-kungtung",
      title: L("2026.12.04（五）–12.06（日）"),
      location: L("台東"),
      startsAt: "2026-12-04T08:30:00+00:00",
      endsAt: "2026-12-06T08:55:00+00:00",
      full: false,
    },
    {
      id: "s-morning-1",
      productSlug: "event-morning",
      title: L("09:00"),
      location: L("書店"),
      startsAt: "2026-11-07T01:00:00+00:00",
      endsAt: "2026-11-07T02:00:00+00:00",
      full: false,
    },
    {
      id: "s-morning-2",
      productSlug: "event-morning",
      title: L("10:00"),
      location: L("書店"),
      startsAt: "2026-11-07T02:00:00+00:00",
      endsAt: "2026-11-07T03:00:00+00:00",
      full: false,
    },
    {
      id: "s-orphan",
      productSlug: "event-not-published",
      title: L("下架活動的場次"),
      location: L("x"),
      startsAt: "2026-11-11T02:00:00Z",
      endsAt: null,
      full: false,
    },
  ],
};
const entries = buildCalendarEntries(input);
const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));

check(
  "排序：依開始時間",
  entries.map((e) => e.key),
  [
    "s-morning-1",
    "s-morning-2",
    "event:ext-trip",
    "event:no-session",
    "s-dinner-1",
    "s-midnight",
    "s-dinner-2",
    "s-kungtung",
  ],
);
check("同一活動多場次各自一筆", entries.filter((e) => e.slug === "morning").length, 2);
check("下架活動的場次不出現", byKey["s-orphan"], undefined);
check(
  "沒日期也沒場次的活動不出現",
  entries.some((e) => e.slug === "tbd"),
  false,
);
check(
  "時間：台北 19:30–21:30",
  [byKey["s-dinner-1"].startTime, byKey["s-dinner-1"].endTime],
  ["19:30", "21:30"],
);
check(
  "時區邊界：UTC 前一天 16:30 的場次落在台北 12/1",
  byKey["s-midnight"].startDate,
  "2026-12-01",
);
check("場次名稱只留不重複的部分", byKey["s-dinner-1"].detail?.zh, "光之行者");
check("純日期的場次名稱 → null", byKey["s-kungtung"].detail, null);
{
  const e = buildCalendarEntries({
    nowMs: NOW,
    journeyUrls: [],
    events: [
      {
        slug: "k",
        title: { zh: "公東之旅", en: "Kung Tung", ja: "公東" },
        externalUrl: "",
        isoDate: null,
      },
    ],
    sessions: [
      {
        id: "k1",
        productSlug: "event-k",
        title: { zh: "2026.12.04（五）–12.06（日）", en: "Dec 4 – Dec 6", ja: "12月4日〜6日" },
        location: L("台東"),
        startsAt: "2026-12-04T08:30:00Z",
        endsAt: null,
        full: false,
      },
    ],
  });
  check("中文只有日期、英日文是日期的另一種寫法 → 整個 null（不留孤單的｜）", e[0].detail, null);
}
check(
  "額滿是傳進來的（不自己算）",
  [byKey["s-dinner-1"].full, byKey["s-dinner-2"].full],
  [true, false],
);
check("已結束：11/7 的場次", byKey["s-morning-1"].ended, true);
check("未結束：11/24 的場次", byKey["s-dinner-1"].ended, false);
check("策旅：站內連結判定", byKey["s-kungtung"].kind, "journey");
check("策旅：外站連結（尾斜線不同）也判定", byKey["event:ext-trip"].kind, "journey");
check("一般活動", byKey["s-dinner-1"].kind, "event");
check(
  "跨日：12/4–12/6",
  [byKey["s-kungtung"].startDate, byKey["s-kungtung"].endDate],
  ["2026-12-04", "2026-12-06"],
);
check("跨日範圍文字", rangeLabel(byKey["s-kungtung"]), "12/4–12/6");
check(
  "沒場次但有日期：整天一筆",
  [byKey["event:no-session"].startDate, byKey["event:no-session"].startTime],
  ["2026-11-20", null],
);

{
  // ends_at 剛好台北午夜 → 不多塗一天
  const e = buildCalendarEntries({
    nowMs: NOW,
    journeyUrls: [],
    events: [{ slug: "a", title: L("A"), externalUrl: "", isoDate: null }],
    sessions: [
      {
        id: "x",
        productSlug: "event-a",
        title: L("A"),
        location: L(""),
        startsAt: "2026-11-20T12:00:00Z", // 台北 20:00
        endsAt: "2026-11-20T16:00:00Z", // 台北 11/21 00:00
        full: false,
      },
      {
        id: "y",
        productSlug: "event-a",
        title: L("A"),
        location: L(""),
        startsAt: "2026-11-01T02:00:00Z",
        endsAt: "2027-06-01T02:00:00Z", // 填錯：跨半年
        full: false,
      },
    ],
  });
  const m = Object.fromEntries(e.map((x) => [x.key, x]));
  check("結束在台北午夜 → 仍是單日", m.x.endDate, "2026-11-20");
  check("跨日上限 14 天", daysBetween(m.y.startDate, m.y.endDate) + 1, 14);
  check("沒地點 → null", m.x.location, null);
}

// ── 分組 ────────────────────────────────────────────────────────────────
{
  const decDays = itemsByDay(entries, "2026-12");
  check(
    "12 月格：12/4、12/5、12/6 都有策旅（第 1–3 天）",
    ["2026-12-04", "2026-12-05", "2026-12-06"].map((d) => decDays.get(d)?.[0]?.dayIndex),
    [1, 2, 3],
  );
  check(
    "12 月格：12/1 有兩筆（午夜邊界 + 第二集），依時間",
    (decDays.get("2026-12-01") ?? []).map((i) => i.entry.key),
    ["s-midnight", "s-dinner-2"],
  );
  check(
    "11 月格：11/30 沒有東西（邊界場次不漏到前一天）",
    itemsByDay(entries, "2026-11").get("2026-11-30"),
    undefined,
  );
  check("11 月格：11/7 兩場", itemsByDay(entries, "2026-11").get("2026-11-07")?.length, 2);

  // 上個月開始、本月還在進行的跨日場次
  const span = buildCalendarEntries({
    nowMs: NOW,
    journeyUrls: [],
    events: [{ slug: "t", title: L("跨月"), externalUrl: "", isoDate: null }],
    sessions: [
      {
        id: "t1",
        productSlug: "event-t",
        title: L("跨月"),
        location: L(""),
        startsAt: "2026-12-30T01:00:00Z",
        endsAt: "2027-01-02T08:00:00Z",
        full: false,
      },
    ],
  });
  check(
    "跨月：1 月格 1/1、1/2 有（第 3、4 天）",
    ["2027-01-01", "2027-01-02"].map((d) => itemsByDay(span, "2027-01").get(d)?.[0]?.dayIndex),
    [3, 4],
  );
  check(
    "跨月議程：列在 1/1、標第 3 天",
    agendaGroups(span, "2027-01").map((g) => [g.date, g.items[0].dayIndex]),
    [["2027-01-01", 3]],
  );
  check(
    "跨月議程：12 月列在開始日",
    agendaGroups(span, "2026-12").map((g) => g.date),
    ["2026-12-30"],
  );
  checkTrue(
    "跨月：兩個月都算有活動",
    monthHasEntries(span, "2026-12") && monthHasEntries(span, "2027-01"),
  );

  const agenda = agendaGroups(entries, "2026-12");
  check(
    "12 月議程：日期遞增、策旅只列一次",
    agenda.map((g) => [g.date, g.items.length]),
    [
      ["2026-12-01", 2],
      ["2026-12-04", 1],
    ],
  );
  check("空月份", monthHasEntries(entries, "2027-03"), false);
  check("下一個有活動的月份", nearestMonthWithEntries(entries, "2026-10", 1), "2026-11");
  check("上一個有活動的月份", nearestMonthWithEntries(entries, "2027-03", -1), "2026-12");
  check("之後沒有", nearestMonthWithEntries(entries, "2026-12", 1), null);
}

// ── 文字 ────────────────────────────────────────────────────────────────
check("月份標題 zh", monthLabel("2026-11", "zh"), "2026 年 11 月");
check("月份標題 en", monthLabel("2027-01", "en"), "January 2027");
check("月份標題 ja", monthLabel("2026-11", "ja"), "2026年11月");
check("日期標籤 zh", dayLabel("2026-11-24", "zh"), "11月24日（二）");
check("日期標籤 en", dayLabel("2026-11-24", "en"), "Tue, Nov 24");

// ── 已關閉場次（報名截止）與包場（2026-11-10）──────────────────────────
{
  const NOWC = Date.parse("2026-11-10T04:00:00Z");
  const es = buildCalendarEntries({
    events: [
      { slug: "talk", title: L("講座"), externalUrl: "", isoDate: "2026-11-20" },
      {
        slug: "tea",
        title: L("木柵茶"),
        externalUrl: "",
        isoDate: "2026-11-17",
        privateBooking: true,
      },
    ],
    sessions: [
      // anon 讀得到的 open 場次（額滿）
      {
        id: "open-1",
        productSlug: "event-talk",
        title: L("第一場"),
        location: L("書店"),
        startsAt: "2026-11-20T06:00:00Z",
        endsAt: "2026-11-20T08:00:00Z",
        full: true,
      },
      // server fn 補回來的 closed 場次（一般活動 → 報名截止）
      {
        id: "closed-1",
        productSlug: "event-talk",
        title: L("第二場"),
        location: L("書店"),
        startsAt: "2026-11-21T06:00:00Z",
        endsAt: "2026-11-21T08:00:00Z",
        full: false,
        closed: true,
      },
      // 已結束的 closed 場次
      {
        id: "closed-old",
        productSlug: "event-talk",
        title: L("第零場"),
        location: L("書店"),
        startsAt: "2026-11-01T06:00:00Z",
        endsAt: "2026-11-01T08:00:00Z",
        full: false,
        closed: true,
      },
      // 包場的 closed 場次
      {
        id: "closed-tea",
        productSlug: "event-tea",
        title: L("2026.11.17"),
        location: L("書店"),
        startsAt: "2026-11-17T07:30:00Z",
        endsAt: "2026-11-17T09:00:00Z",
        full: false,
        closed: true,
      },
    ],
    journeyUrls: [],
    nowMs: NOWC,
  });
  const by = Object.fromEntries(es.map((e) => [e.key, e]));
  check(
    "關閉場次出現在月曆、時間正確（不是全天）",
    [by["closed-1"]?.startDate, by["closed-1"]?.startTime, by["closed-1"]?.endTime],
    ["2026-11-21", "14:00", "16:00"],
  );
  check(
    "一般活動的關閉場次：標報名截止、不標額滿、不是包場",
    [by["closed-1"]?.registrationClosed, by["closed-1"]?.full, by["closed-1"]?.privateBooking],
    [true, false, false],
  );
  check(
    "open 場次：額滿照舊、不是報名截止",
    [by["open-1"]?.full, by["open-1"]?.registrationClosed],
    [true, false],
  );
  check(
    "包場的關閉場次：仍標包場、不標報名截止",
    [
      by["closed-tea"]?.privateBooking,
      by["closed-tea"]?.registrationClosed,
      by["closed-tea"]?.full,
    ],
    [true, false, false],
  );
  checkTrue("已結束的關閉場次照舊是 ended（淡化）", by["closed-old"]?.ended === true);
  check("有關閉場次就不再退回 iso_date 全天", es.filter((e) => e.key === "event:talk").length, 0);
  const allDay = buildCalendarEntries({
    events: [{ slug: "x", title: L("x"), externalUrl: "", isoDate: "2026-11-30" }],
    sessions: [],
    journeyUrls: [],
    nowMs: NOWC,
  });
  check("全天條目：registrationClosed = false", allDay[0]?.registrationClosed, false);
}

// ── 商品對活動：source_id 優先、slug 後備 ───────────────────────────────
{
  const ids = new Map([
    ["ev-1", "kungtung"],
    ["ev-2", "soul-dinner"],
  ]);
  check(
    "source_id 對得上 → 用活動代稱（即使商品 slug 舊了）",
    eventSlugForProduct({ slug: "event-old-name", sourceId: "ev-1" }, ids),
    "kungtung",
  );
  check(
    "source_id 空 → 退回 event-<slug>",
    eventSlugForProduct({ slug: "event-soul-dinner", sourceId: null }, ids),
    "soul-dinner",
  );
  check(
    "source_id 對不上 → 退回 event-<slug>",
    eventSlugForProduct({ slug: "event-other", sourceId: "ev-9" }, ids),
    "other",
  );
  check("都對不上 → null", eventSlugForProduct({ slug: "book-123", sourceId: "ev-9" }, ids), null);
  check("只有前綴 → null", eventSlugForProduct({ slug: "event-", sourceId: null }, ids), null);
  // 端到端：舊 slug 的商品，經 source_id 對到活動後，場次出現在那場活動上。
  const slug = eventSlugForProduct({ slug: "event-old-name", sourceId: "ev-1" }, ids);
  const es = buildCalendarEntries({
    events: [{ id: "ev-1", slug: "kungtung", title: L("公東"), externalUrl: "", isoDate: null }],
    sessions: [
      {
        id: "kt-1",
        productSlug: `event-${slug}`,
        title: L("梯次"),
        location: L("台東"),
        startsAt: "2026-12-04T08:30:00Z",
        endsAt: "2026-12-06T08:55:00Z",
        full: false,
      },
    ],
    journeyUrls: ["/events/kungtung"],
    nowMs: Date.parse("2026-11-10T04:00:00Z"),
  });
  check(
    "source_id 對應後場次掛到活動上（跨日 12/4–12/6、策旅）",
    [es[0]?.slug, es[0]?.startDate, es[0]?.endDate, es[0]?.kind],
    ["kungtung", "2026-12-04", "2026-12-06", "journey"],
  );
}

// ── 資料層／畫面接線（靜態）──────────────────────────────────────────────
{
  const data = read("src/lib/events-calendar-data.ts");
  checkTrue(
    "資料層：商品用 source_id 對活動（eventSlugForProduct）、查 source_type=event",
    data.includes("source_id,event_sessions(") &&
      data.includes('.eq("source_type", "event")') &&
      /eventSlugForProduct\(/.test(data),
  );
  checkTrue(
    "資料層：所有上架活動都補讀關閉場次（fetchClosedSessionTimes），補回來的標 closed",
    /fetchClosedSessionTimes\(closedSlugs\)/.test(data) && data.includes("closed: true,"),
  );
  const ui = read("src/components/events/EventsCalendar.tsx");
  checkTrue(
    "畫面：「報名截止」三語",
    ui.includes(
      'registrationClosed: { zh: "報名截止", en: "Registration closed", ja: "受付終了" }',
    ),
  );
  checkTrue(
    "畫面：格子與議程都畫「報名截止」",
    (ui.match(/<Badge tone="muted">\{t\(COPY\.registrationClosed\)\}<\/Badge>/g) ?? []).length ===
      2,
  );
  const srv = read("src/server/private-booking.ts");
  const fn = srv.slice(srv.indexOf("export async function readClosedSessionTimes"));
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  checkTrue(
    "🔴 server：只讀 live 活動、只回 closed 場次、不讀名額",
    code.includes('.eq("status", "live")') &&
      code.includes('if (s.status !== "closed") continue;') &&
      !/capacity|seats_taken|registrations|orders/.test(code),
  );
  const fns = read("src/lib/private-booking-fns.ts");
  checkTrue(
    "server fn：輸入先截 50、再過 sanitizePrivateSlugs",
    /getClosedSessionTimes[\s\S]*slice\(0, 50\)[\s\S]*readClosedSessionTimes\(sanitizePrivateSlugs\(data\.slugs\)\)/.test(
      fns,
    ),
  );
  checkTrue(
    "service role 只在 server 端（fns 動態 import server 模組）",
    !/supabase-admin|supabaseAdmin/.test(fns) &&
      read("src/server/private-booking.ts").includes('import "@tanstack/react-start/server-only";'),
  );
}

// ── 原始碼守門 ──────────────────────────────────────────────────────────
{
  const lib = read("src/lib/events-calendar.ts");
  const code = lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  checkTrue(
    "純函式不讀執行環境時區（getDate/getHours/getDay）",
    !/\.get(Date|Hours|Day|Month|FullYear)\(/.test(code),
  );
  checkTrue("純函式不碰座位欄位", !/capacity|seatsTaken|seats_taken/.test(code));
  checkTrue("純函式零 @/ import", !/from "@\//.test(lib));
  const data = read("src/lib/events-calendar-data.ts");
  checkTrue("額滿走 remainingForSession()", /remainingForSession\(/.test(data));
  checkTrue("資料層不自己減座位", !/capacity\s*-\s*|seatsTaken\s*\)\s*<=|-\s*seats/.test(data));
  const ui = read("src/components/events/EventsCalendar.tsx");
  checkTrue("月曆是 <table>（語意）", ui.includes("<table") && ui.includes('scope="col"'));
  checkTrue("每筆有 aria-label", (ui.match(/aria-label=\{ariaFor\(/g) ?? []).length >= 2);
  checkTrue("不碰報名／結帳", !/directCheckoutSearch|SessionPicker|\/checkout/.test(ui));
  const route = read("src/routes/events.index.tsx");
  checkTrue("路由驗證 ?month= 用 parseMonthParam", route.includes("parseMonthParam(search.month)"));
  checkTrue("月曆的今天用 loader 時間（SSR 一致）", route.includes("taipeiDateAt(loadedAt)"));
}

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
