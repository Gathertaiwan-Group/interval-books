#!/usr/bin/env node
/**
 * journey-events-selftest.mjs —— 策旅不該出現在 /events 列表與首頁「精選活動」
 *
 * 2026-10-20 店長回報：/events 列出了「2026 台東池上秋收山海旅行」（策旅）。
 * 策旅＝events 一列（報名、收錢）＋ journeys 一張卡片（external_url 連到那場活動）。
 *
 *   [純函式] src/lib/journey-events.ts：
 *              · 站內路徑／本站完整網址 → slug；外部網址、空字串 → null
 *              · 正式庫現況（2026-10-20 讀）：池上被濾掉，其他三場一般活動留著
 *              · 外部連結報名的策旅（活動與卡片同一個外部網址）也濾掉
 *   [整合]   一頁新增的 journey 模式（站內報名／外部連結）建出來的活動，都會被這條規則濾掉；
 *            event 模式建出來的活動不會
 *   [靜態]   fetchEvents() 在資料層套用排除；/events、首頁都走 fetchEvents()；
 *            /events/$slug 走 fetchEventBySlug()，不經過排除（策旅在那一頁報名付款）
 *
 * 不碰任何資料庫。
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/journey-events-selftest.mjs";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      return {
        url: pathToFileURL(join(ROOT, "src", `${spec.slice(2)}.ts`)).href,
        shortCircuit: true,
      };
    }
    return next(spec, ctx);
  },
});

let pass = 0;
let fail = 0;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
  }
}
const checkTrue = (label, v) => check(label, Boolean(v), true);
const checkFalse = (label, v) => check(label, Boolean(v), false);

/** 讀原始碼。檔案不存在＝丟例外，不是回空字串（run-selftests.mjs 守門 4）。 */
function readFile(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`selftest 讀不到檔案：${rel}`);
  return readFileSync(abs, "utf8");
}

/** 拿掉 TS 註解，免得註解裡提到的字串讓斷言假性通過。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const { eventSlugFromJourneyUrl, excludeJourneyEvents, journeyEventMatcher } = await import(
  pathToFileURL(join(ROOT, "src/lib/journey-events.ts")).href
);

// =============================================================================
console.log("\n[1] 卡片連結 → 活動 slug");
check(
  "站內路徑",
  eventSlugFromJourneyUrl("/events/InntervalChishang.1023"),
  "InntervalChishang.1023",
);
check("前後空白、結尾斜線", eventSlugFromJourneyUrl("  /events/abc/ "), "abc");
check("帶 query／hash", eventSlugFromJourneyUrl("/events/abc?utm=x#reg"), "abc");
check("URL 編碼", eventSlugFromJourneyUrl("/events/%E6%B1%A0%E4%B8%8A"), "池上");
check("本站完整網址", eventSlugFromJourneyUrl("https://www.intervalbooks.tw/events/abc"), "abc");
check("本站裸網域", eventSlugFromJourneyUrl("https://intervalbooks.tw/events/abc"), "abc");
check("別人的網站同路徑不算", eventSlugFromJourneyUrl("https://example.com/events/abc"), null);
check("外部報名網址", eventSlugFromJourneyUrl("https://forms.gle/x"), null);
check("空字串", eventSlugFromJourneyUrl(""), null);
check("null", eventSlugFromJourneyUrl(null), null);
check("/events 本身", eventSlugFromJourneyUrl("/events"), null);
check("/events/ 結尾", eventSlugFromJourneyUrl("/events/"), null);
check("更深的路徑不算", eventSlugFromJourneyUrl("/events/a/b"), null);
check("/journeys 不算", eventSlugFromJourneyUrl("/journeys"), null);

// =============================================================================
console.log("\n[2] 正式庫現況（2026-10-20 唯讀查詢的形狀）");
// journeys：只有一列，external_url=/events/InntervalChishang.1023
// events：四列，池上的分類是「策旅說明會」
const prodEvents = [
  { slug: "city-salon-0922", category: "城市思享沙龍", externalUrl: "" },
  { slug: "yokky-flow-0905", category: "陶藝工作坊", externalUrl: "" },
  { slug: "sound-of-the-sea", category: "好書交流", externalUrl: "" },
  { slug: "InntervalChishang.1023", category: "策旅說明會", externalUrl: "" },
];
const prodJourneyUrls = ["/events/InntervalChishang.1023"];
check(
  "池上被濾掉，其餘三場一般活動照順序留著",
  excludeJourneyEvents(prodEvents, prodJourneyUrls).map((e) => e.slug),
  ["city-salon-0922", "yokky-flow-0905", "sound-of-the-sea"],
);
check("沒有策旅卡片時一場都不濾（判準不是分類）", excludeJourneyEvents(prodEvents, []).length, 4);
check(
  "卡片連到一場不存在的活動 → 不影響其他",
  excludeJourneyEvents(prodEvents, ["/events/nope"]).length,
  4,
);
check("不改原陣列", prodEvents.length, 4);

// =============================================================================
console.log("\n[3] 外部連結報名的策旅");
const ext = [
  { slug: "a", externalUrl: "https://forms.gle/trip" },
  { slug: "b", externalUrl: "https://forms.gle/other" },
  { slug: "c", externalUrl: "" },
];
check(
  "活動與卡片同一個外部網址 → 濾掉",
  excludeJourneyEvents(ext, ["https://forms.gle/trip/"]).map((e) => e.slug),
  ["b", "c"],
);
checkFalse("空外部網址不會互相配對", journeyEventMatcher([""])({ slug: "c", externalUrl: "" }));
checkFalse(
  "站內卡片不會拿網址去配外部活動",
  journeyEventMatcher(["/events/x"])({ slug: "y", externalUrl: "/events/x" }),
);

// =============================================================================
console.log("\n[4] 一頁新增（journey 模式）建出來的活動會被濾掉");
const qc = await import(pathToFileURL(join(ROOT, "src/lib/admin/event-quick-create.ts")).href);
const base = {
  ...qc.initialQuickCreate("journey"),
  title: "台東池上三日",
  description: "稻浪與山海之間的慢旅行。",
  category: "策旅說明會",
  sessions: [
    {
      date: "2026-11-20",
      start: "08:00",
      end: "12:00",
      end_date: "2026-11-22",
      location: "台東池上",
      capacity: 12,
    },
  ],
};
for (const [mode, extra] of [
  ["free", {}],
  ["paid", {}],
  ["external", { external_url: "https://forms.gle/chishang" }],
]) {
  const input = { ...base, mode, ...extra };
  const plan = qc.buildQuickCreatePlan(input, {
    slug: "20261120",
    sortOrder: 9,
    translations: new Map(),
  });
  const card = qc.buildJourneyCard(input, plan.event, {
    sortOrder: 2,
    translations: new Map(),
    categoryLabel: null,
  });
  const created = { slug: plan.event.slug, externalUrl: plan.event.external_url };
  const listed = excludeJourneyEvents(
    [...prodEvents, created],
    [...prodJourneyUrls, card.external_url],
  );
  check(
    `${mode}：新策旅的活動不在列表，原本三場一般活動還在`,
    listed.map((e) => e.slug),
    ["city-salon-0922", "yokky-flow-0905", "sound-of-the-sea"],
  );
}
{
  const input = {
    ...qc.initialQuickCreate("event"),
    title: "讀書會",
    mode: "free",
    sessions: [{ ...base.sessions[0], date: "2026-11-21", end_date: "", end: "16:00" }],
  };
  const plan = qc.buildQuickCreatePlan(input, {
    slug: "20261121",
    sortOrder: 9,
    translations: new Map(),
  });
  checkTrue(
    "event 模式建的一般活動不會被濾掉",
    excludeJourneyEvents(
      [{ slug: plan.event.slug, externalUrl: plan.event.external_url }],
      prodJourneyUrls,
    ).length === 1,
  );
}

// =============================================================================
console.log("\n[5] 靜態：排除在資料層，詳情頁不受影響");
const cms = stripTs(readFile("src/lib/cms.ts"));
const fetchEventsBody = cms.slice(
  cms.indexOf("export async function fetchEvents()"),
  cms.indexOf("async function fetchAllEventRows"),
);
checkTrue(
  "fetchEvents() 讀 journeys 的 external_url",
  fetchEventsBody.includes('select("journeys", "external_url")'),
);
checkTrue(
  "fetchEvents() 回傳前套 excludeJourneyEvents",
  fetchEventsBody.includes("return excludeJourneyEvents("),
);
const bySlug = cms.slice(cms.indexOf("export async function fetchEventBySlug"));
checkFalse(
  "fetchEventBySlug（/events/$slug）不套排除",
  bySlug.slice(0, bySlug.indexOf("\nexport ")).includes("excludeJourneyEvents"),
);
const eventsIndex = stripTs(readFile("src/routes/events.index.tsx"));
checkTrue("/events 列表走 fetchEvents()", eventsIndex.includes("fetchEvents()"));
checkFalse("/events 列表不自己 select events 表", eventsIndex.includes('.from("events")'));
const home = stripTs(readFile("src/routes/index.tsx"));
checkTrue("首頁精選活動走 fetchEvents()", home.includes("fetchEvents()"));
const detail = stripTs(readFile("src/routes/events.$slug.tsx"));
checkTrue("/events/$slug 走 fetchEventBySlug", detail.includes("fetchEventBySlug("));
checkFalse("/events/$slug 不用 fetchEvents()", detail.includes("fetchEvents("));

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
