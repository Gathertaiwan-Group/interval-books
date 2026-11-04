#!/usr/bin/env node
/**
 * calendar-ics-selftest.mjs —— src/lib/calendar-ics.ts（/calendar.ics）的行為自檢。
 * 直接 import 真正的程式碼（該模組零 @/ import）。不碰資料庫、不發網路請求。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import {
  buildCalendarIcs,
  buildVevents,
  escapeText,
  foldLine,
  stripHtml,
  inferEndFromDisplay,
  formatUtc,
  distinctSessionTitle,
} from "../src/lib/calendar-ics.ts";

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

const NOW = new Date("2026-11-05T00:00:00Z");
const utf8 = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

// ── 跳脫 ────────────────────────────────────────────────────────────────
check("跳脫：逗號分號反斜線換行", escapeText("a,b;c\\d\ne\r\nf"), "a\\,b\\;c\\\\d\\ne\\nf");
check("跳脫：中文不動", escapeText("布苔球｜工作坊"), "布苔球｜工作坊");

// ── 折行 ────────────────────────────────────────────────────────────────
{
  const long =
    "SUMMARY:" + "植生布植生牆布苔球，工作坊；".repeat(20) + "🌿".repeat(30) + "abc".repeat(40);
  const folded = foldLine(long);
  checkTrue("折行：以 CRLF 結尾", folded.endsWith("\r\n"));
  const physical = folded.slice(0, -2).split("\r\n");
  checkTrue("折行：有多行", physical.length > 3);
  checkTrue(
    "折行：每行 <= 75 octet",
    physical.every((l) => utf8.encode(l).length <= 75),
  );
  checkTrue(
    "折行：續行以空白開頭",
    physical.slice(1).every((l) => l.startsWith(" ")),
  );
  let decodable = true;
  for (const l of physical) {
    try {
      strict.decode(utf8.encode(l));
    } catch {
      decodable = false;
    }
  }
  checkTrue("折行：沒有切斷 UTF-8 字元（中文／emoji）", decodable);
  check("折行：展開後與原文相同", physical.map((l, i) => (i ? l.slice(1) : l)).join(""), long);
  check("折行：短行不折", foldLine("A:B"), "A:B\r\n");
  const exact = "X:" + "a".repeat(73);
  check("折行：剛好 75 octet 不折", foldLine(exact), exact + "\r\n");
  checkTrue("折行：76 octet 折成兩行", foldLine(exact + "a").split("\r\n").length === 3);
}

// ── HTML ────────────────────────────────────────────────────────────────
check(
  "去 HTML",
  stripHtml("<p>你好 &amp; <b>世界</b></p><script>x()</script><p>第二段&nbsp;&#39;ok&#39;</p>"),
  "你好 & 世界\n第二段 'ok'",
);

// ── 時間 ────────────────────────────────────────────────────────────────
check("formatUtc", formatUtc(Date.parse("2026-11-28T07:00:00Z")), "20261128T070000Z");
check(
  "推估結束：15:00–16:30",
  formatUtc(inferEndFromDisplay(Date.parse("2026-11-28T07:00:00Z"), "2026.11.28 (六) 15:00–16:30")),
  "20261128T083000Z",
);
check(
  "推估結束：開始時刻對不上 → null",
  inferEndFromDisplay(Date.parse("2026-11-28T07:00:00Z"), "2026.11.28 10:00–12:00"),
  null,
);
check(
  "推估結束：沒有時間 → null",
  inferEndFromDisplay(Date.parse("2026-11-28T07:00:00Z"), "2026.12.04 (五)~12.06 (日)"),
  null,
);

// ── 組日曆 ──────────────────────────────────────────────────────────────
const ev = (o) => ({
  id: "e-" + o.slug,
  slug: o.slug,
  status: "live",
  titleZh: o.slug,
  summaryZh: "",
  displayDate: "",
  externalUrl: "",
  registrationType: "internal",
  updatedAt: "2026-11-01T00:00:00Z",
  productId: "event-" + o.slug,
  price: 1000,
  ...o,
});
const ses = (o) => ({
  id: "s",
  productId: "p",
  titleZh: "",
  locationZh: "華山",
  startsAt: "2026-11-28T07:00:00Z",
  endsAt: null,
  capacity: 10,
  seatsTaken: 3,
  updatedAt: "2026-11-02T00:00:00Z",
  ...o,
});
const base = {
  events: [
    ev({
      slug: "moss",
      titleZh: "植生布植生牆｜布苔球",
      summaryZh: "<p>手作, 好玩; 歡迎</p>",
      displayDate: "2026.11.28 (六) 15:00–16:30",
      productId: "p-moss",
    }),
    ev({ slug: "draft-one", status: "draft", titleZh: "草稿活動", productId: "p-draft" }),
    ev({ slug: "old-one", status: "archived", titleZh: "下架活動", productId: "p-arch" }),
    ev({ slug: "kungtung", titleZh: "公東教堂之旅", productId: "p-kt", price: 16800 }),
    ev({ slug: "ended", titleZh: "很久以前", productId: "p-ended" }),
    ev({ slug: "recent", titleZh: "上個月", productId: "p-recent" }),
  ],
  sessions: [
    ses({ id: "sess-moss", productId: "p-moss" }),
    ses({ id: "sess-draft", productId: "p-draft" }),
    ses({ id: "sess-arch", productId: "p-arch" }),
    ses({
      id: "sess-kt",
      productId: "p-kt",
      locationZh: "",
      startsAt: "2026-12-03T22:00:00Z",
      endsAt: "2026-12-06T10:00:00Z",
    }),
    ses({
      id: "sess-ended",
      productId: "p-ended",
      startsAt: "2026-07-01T02:00:00Z",
      endsAt: "2026-07-01T04:00:00Z",
    }),
    ses({
      id: "sess-recent",
      productId: "p-recent",
      startsAt: "2026-10-01T02:00:00Z",
      endsAt: null,
    }),
  ],
  plans: [],
  journeyUrls: ["/events/kungtung"],
  storeAddress: "台北市中正區華山1914",
  now: NOW,
};
const vs = buildVevents(base);
const byUid = Object.fromEntries(vs.map((v) => [v.uid, v.lines.join("\n")]));
check(
  "事件 UID 清單（draft、archived、90 天前的被排除）",
  vs.map((v) => v.uid),
  ["sess-recent@intervalbooks.tw", "sess-moss@intervalbooks.tw", "sess-kt@intervalbooks.tw"],
);
checkTrue(
  "布苔球：11/28 15:00 台北 = 07:00Z",
  byUid["sess-moss@intervalbooks.tw"].includes("DTSTART:20261128T070000Z"),
);
checkTrue(
  "布苔球：結束由顯示時間推估 08:30Z",
  byUid["sess-moss@intervalbooks.tw"].includes("DTEND:20261128T083000Z"),
);
checkTrue(
  "沒有結束時間也推不出 → 開始後 2 小時",
  byUid["sess-recent@intervalbooks.tw"].includes("DTSTART:20261001T020000Z") &&
    byUid["sess-recent@intervalbooks.tw"].includes("DTEND:20261001T040000Z"),
);
checkTrue("策旅加前綴", byUid["sess-kt@intervalbooks.tw"].includes("SUMMARY:策旅｜公東教堂之旅"));
checkTrue(
  "一般活動沒有前綴",
  byUid["sess-moss@intervalbooks.tw"].includes("SUMMARY:植生布植生牆｜布苔球"),
);
checkTrue(
  "多日策旅照場次起訖",
  byUid["sess-kt@intervalbooks.tw"].includes("DTSTART:20261203T220000Z") &&
    byUid["sess-kt@intervalbooks.tw"].includes("DTEND:20261206T100000Z"),
);
checkTrue(
  "沒有地點 → 店址",
  byUid["sess-kt@intervalbooks.tw"].includes("LOCATION:台北市中正區華山1914"),
);
checkTrue("有地點用場次地點", byUid["sess-moss@intervalbooks.tw"].includes("LOCATION:華山"));
checkTrue(
  "URL 是活動頁",
  byUid["sess-moss@intervalbooks.tw"].includes("URL:https://www.intervalbooks.tw/events/moss"),
);
checkTrue(
  "DESCRIPTION 去 HTML 且跳脫、含票價名額",
  byUid["sess-moss@intervalbooks.tw"].includes(
    "DESCRIPTION:手作\\, 好玩\\; 歡迎\\n票價：NT$1\\,000\\n名額：10 位（截至訂閱更新時尚餘 7 位）\\n報名／詳情：https://www.intervalbooks.tw/events/moss",
  ),
);
checkTrue(
  "LAST-MODIFIED／DTSTAMP 用資料列時間",
  byUid["sess-moss@intervalbooks.tw"].includes("LAST-MODIFIED:20261102T000000Z") &&
    byUid["sess-moss@intervalbooks.tw"].includes("DTSTAMP:20261102T000000Z"),
);

// UID 穩定：改期後同一個 UID，只有時間變
{
  const moved = structuredClone(base);
  moved.sessions.find((s) => s.id === "sess-moss").startsAt = "2026-12-05T07:00:00Z";
  const a = buildVevents(base).find((v) => v.uid === "sess-moss@intervalbooks.tw");
  const b = buildVevents(moved).find((v) => v.uid === "sess-moss@intervalbooks.tw");
  checkTrue("改期後 UID 不變", a && b);
  checkTrue(
    "改期後時間變了",
    a.lines.join() !== b.lines.join() && b.lines.join().includes("DTSTART:20261205T070000Z"),
  );
  check(
    "輸出是決定性的（同輸入逐位元相同）",
    buildCalendarIcs(base),
    buildCalendarIcs(structuredClone(base)),
  );
}

// 票種方案價格
{
  const withPlans = structuredClone(base);
  withPlans.plans = [
    { sessionId: "sess-moss", titleZh: "早鳥", price: 800, status: "open", updatedAt: null },
    { sessionId: "sess-moss", titleZh: "原價", price: 1200, status: "open", updatedAt: null },
    { sessionId: "sess-moss", titleZh: "停售", price: 1, status: "closed", updatedAt: null },
  ];
  checkTrue(
    "票種方案：價格區間，停售的不算",
    buildVevents(withPlans)
      .find((v) => v.uid.startsWith("sess-moss"))
      .lines.join()
      .includes("票價：NT$800–NT$1\\,200"),
  );
}

// 多場次：標題接場次名
{
  const multi = structuredClone(base);
  multi.sessions.push(
    ses({
      id: "sess-moss2",
      productId: "p-moss",
      titleZh: "第二梯",
      startsAt: "2026-12-12T07:00:00Z",
    }),
  );
  const m = buildVevents(multi).find((v) => v.uid.startsWith("sess-moss2"));
  checkTrue(
    "多場次：SUMMARY 接場次名",
    m.lines.join().includes("SUMMARY:植生布植生牆｜布苔球｜第二梯"),
  );
}

// 場次名稱去重（池上：活動名「…旅行 | 馥自然人文空間」，場次名「馥自然人文空間｜第一梯次｜10/23（五）–10/25（日）」）
{
  const evTitle = "2026 台東池上秋收山海旅行 | 馥自然人文空間";
  check(
    "場次名去重：只留梯次",
    distinctSessionTitle("馥自然人文空間｜第一梯次｜10/23（五）–10/25（日）", evTitle),
    "第一梯次",
  );
  check(
    "場次名去重：開頭帶活動名",
    distinctSessionTitle(`${evTitle}｜第二梯次`, evTitle),
    "第二梯次",
  );
  check("場次名去重：完全相同 → 空", distinctSessionTitle(evTitle, evTitle), "");
  check("場次名去重：不重複的原樣保留", distinctSessionTitle("下午場", "布苔球"), "下午場");
  const j = structuredClone(base);
  j.events.push(ev({ slug: "chishang", titleZh: evTitle, productId: "p-cs" }));
  j.sessions.push(
    ses({
      id: "cs-1",
      productId: "p-cs",
      titleZh: "馥自然人文空間｜第一梯次｜10/23（五）–10/25（日）",
      startsAt: "2026-10-23T06:00:00Z",
    }),
    ses({
      id: "cs-2",
      productId: "p-cs",
      titleZh: "馥自然人文空間｜第二梯次｜10/25（日）–10/27（二）",
      startsAt: "2026-10-25T06:00:00Z",
    }),
  );
  const sums = buildVevents(j)
    .filter((v) => v.uid.startsWith("cs-"))
    .map((v) => v.lines.find((l) => l.startsWith("SUMMARY:")));
  check("多場次 SUMMARY：活動名｜梯次", sums, [
    `SUMMARY:${evTitle}｜第一梯次`,
    `SUMMARY:${evTitle}｜第二梯次`,
  ]);
  const one = structuredClone(j);
  one.sessions = one.sessions.filter((x) => x.id !== "cs-2");
  check(
    "單一場次 SUMMARY：只用活動名",
    buildVevents(one)
      .find((v) => v.uid.startsWith("cs-1"))
      .lines.find((l) => l.startsWith("SUMMARY:")),
    `SUMMARY:${evTitle}`,
  );
}

// 整份檔案格式
{
  const ics = buildCalendarIcs(base);
  checkTrue(
    "開頭 BEGIN:VCALENDAR、結尾 END:VCALENDAR + CRLF",
    ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"),
  );
  checkTrue("沒有裸 LF", !/(^|[^\r])\n/.test(ics));
  checkTrue(
    "每個物理行 <= 75 octet",
    ics.split("\r\n").every((l) => utf8.encode(l).length <= 75),
  );
  checkTrue(
    "X-WR-CALNAME",
    ics.includes("X-WR-CALNAME:小時光風土誌書店 活動") || ics.includes("X-WR-CALNAME:"),
  );
  checkTrue("X-WR-TIMEZONE", ics.includes("X-WR-TIMEZONE:Asia/Taipei\r\n"));
  check(
    "VEVENT 數量",
    (ics.match(/^BEGIN:VEVENT\r$/gm) ?? []).length + (ics.match(/BEGIN:VEVENT\r\n/g) ?? []).length >
      0,
    true,
  );
  check("VEVENT 數量 = 3", ics.split("BEGIN:VEVENT\r\n").length - 1, 3);
  checkTrue("草稿／下架標題不在檔案裡", !ics.includes("草稿活動") && !ics.includes("下架活動"));
}

// ── 接線（靜態）──────────────────────────────────────────────────────────
const server = read("src/server.ts");
checkTrue("server.ts 攔截 /calendar.ics", /pathname === "\/calendar\.ics"/.test(server));
const cal = read("src/server/calendar.ts");
checkTrue(
  "Content-Type text/calendar; charset=utf-8",
  cal.includes('"text/calendar; charset=utf-8"'),
);
checkTrue(
  "CDN 快取 s-maxage=900 + swr=3600",
  cal.includes("s-maxage=900, stale-while-revalidate=3600"),
);
checkTrue("失敗時 503 + no-store", cal.includes("status: 503") && cal.includes('"no-store"'));
checkTrue(
  "沒有應用層快取（Data Cache／模組變數）",
  !/unstable_cache|export const revalidate|let cached|const cache\b/.test(cal),
);
checkTrue("sitemap 不收錄", !read("src/server/sitemap.ts").includes("calendar.ics"));
checkTrue("robots.txt 不另外列", !read("src/lib/seo/core.ts").includes("calendar.ics"));

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
