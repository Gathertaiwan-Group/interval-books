#!/usr/bin/env node
/**
 * past-shelf-selftest.mjs —— /events「過往活動」與 /journeys「過往策旅」卡片區
 *
 * 2026-10-28 店長：「這邊下方，幫我多一區，用卡片的形式，去展現已經辦過的活動」
 * 「策旅的部分也是」。
 *
 *   [純函式] src/lib/past-shelf.ts：
 *              · newestEndedFirst：只留已結束、最近結束在前、限筆數；場次延後的不算結束
 *              · splitJourneys：策旅的「已結束」看它指著的那場活動；指不到 → 留在進行中
 *              · 首頁精選策旅與 /journeys 共用 splitJourneys；卡片封面＝指著的活動 image_key
 *   [靜態]   兩頁都用 PastShelf；/events 不多查一次（沿用 fetchEvents）、
 *            /journeys 在同一個 Promise.all 裡查；卡片圖走 CoverImage + lazy；
 *            日期原樣印出（不用 toLocale*）
 *
 * 不碰任何資料庫。
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/past-shelf-selftest.mjs";

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
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? green("✓") : red("✗")} ${name}${ok ? "" : `\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`}`,
  );
}
const readFile = (rel) => readFileSync(join(ROOT, rel), "utf8");

const { newestEndedFirst, splitJourneys, linkedEventFor, effectiveEndDate, PAST_SHELF_LIMIT } =
  await import(pathToFileURL(join(ROOT, "src/lib/past-shelf.ts")).href);

const TODAY = "2026-10-28";

// ── newestEndedFirst ────────────────────────────────────────────────────
// 正式庫 2026-10-28 的四場（池上已由 fetchEvents 濾掉，這裡照樣放進來測排序）
const events = [
  { id: "city-salon-0922", isoDate: "2026-09-22", lastSessionDate: "2026-09-22" },
  { id: "yokky-flow-0905", isoDate: "2026-09-05", lastSessionDate: null },
  // 海的聲音：iso_date 是區間開頭，場次在 11/6 —— 還沒結束
  { id: "sound-of-the-sea", isoDate: "2026-10-20", lastSessionDate: "2026-11-06" },
  // 還沒定日期 → 不算結束
  { id: "tba", isoDate: null, lastSessionDate: null },
  // 今天的活動 → 還沒結束
  { id: "today", isoDate: TODAY, lastSessionDate: null },
  // iso_date 早、場次晚 → 以場次為準排序
  { id: "late-session", isoDate: "2026-08-01", lastSessionDate: "2026-10-01" },
];
check(
  "只留已結束，最近結束的在前（場次結束日優先於 iso_date）",
  newestEndedFirst(events, 8, TODAY).map((e) => e.id),
  ["late-session", "city-salon-0922", "yokky-flow-0905"],
);
check(
  "limit 生效",
  newestEndedFirst(events, 2, TODAY).map((e) => e.id),
  ["late-session", "city-salon-0922"],
);
check("預設最多 8 張（6–8）", PAST_SHELF_LIMIT >= 6 && PAST_SHELF_LIMIT <= 8, true);
check("不改動傳入陣列", events[0].id, "city-salon-0922");
check(
  "沒有已結束 → 空陣列（呼叫端據此不畫這一區）",
  newestEndedFirst([events[2], events[3]], 8, TODAY),
  [],
);
check("effectiveEndDate：null iso → 空字串", effectiveEndDate({ isoDate: null }), "");

// ── splitJourneys ───────────────────────────────────────────────────────
const journeyEvents = [
  {
    slug: "InntervalChishang.1023",
    externalUrl: "",
    date: "2026.9.5~2026.10.23",
    isoDate: "2026-09-05",
    lastSessionDate: "2026-10-25",
    imageKey: null,
  },
  {
    slug: "future-trip",
    externalUrl: "",
    date: "2026.12.1",
    isoDate: "2026-12-01",
    lastSessionDate: null,
    imageKey: "x",
  },
  {
    slug: "old-trip",
    externalUrl: "https://ext.example/trip",
    date: "2026.6.1",
    isoDate: "2026-06-01",
    lastSessionDate: null,
    imageKey: null,
  },
];
const journeys = [
  { id: "j-chishang", externalUrl: "/events/InntervalChishang.1023" },
  { id: "j-future", externalUrl: "https://www.intervalbooks.tw/events/future-trip" },
  { id: "j-ext-old", externalUrl: "https://ext.example/trip/" },
  { id: "j-unlinked", externalUrl: "" },
];
const split = splitJourneys(journeys, journeyEvents, 8, TODAY);
check(
  "進行中：未結束的與指不到活動的，順序不變",
  split.open.map((j) => j.id),
  ["j-future", "j-unlinked"],
);
check(
  "已結束：最近結束的在前（站內路徑與外部同網址都認得）",
  split.ended.map((x) => x.journey.id),
  ["j-chishang", "j-ext-old"],
);
check("已結束帶著它指著的活動（日期要用）", split.ended[0].event.date, "2026.9.5~2026.10.23");
check(
  "場次還在未來 → 不算結束",
  splitJourneys(journeys, journeyEvents, 8, "2026-10-24").ended.map((x) => x.journey.id),
  ["j-ext-old"],
);
check("讀不到活動（空陣列）→ 全部留在進行中", splitJourneys(journeys, [], 8, TODAY).open.length, 4);

// ── 首頁精選策旅（2026-10-29 業主：池上那趟 10 月辦完了還掛在首頁精選）──────
// 正式庫 2026-10-29 的兩趟：池上最後場次 10/27 結束、公東 12/6 結束（2026-11-01 業主改期，原 11/14–11/16）。
const liveEvents = [
  {
    slug: "InntervalChishang.1023",
    externalUrl: "",
    date: "2026.9.5~2026.10.23",
    isoDate: "2026-10-23",
    lastSessionDate: "2026-10-27",
    imageKey: "storage:chishang.webp",
  },
  {
    slug: "kungtung",
    externalUrl: "",
    date: "2026.12.04 (五)~12.06 (日)",
    isoDate: "2026-12-06",
    lastSessionDate: "2026-12-06",
    imageKey: "storage:91c89fe9-1301-4d69-8708-7ff42ffbab94.webp",
  },
];
const liveJourneys = [
  { id: "j-chishang", externalUrl: "/events/InntervalChishang.1023" },
  { id: "j-kungtung", externalUrl: "/events/kungtung" },
];
const live = splitJourneys(liveJourneys, liveEvents, 8, "2026-10-29");
check(
  "結束的策旅不在精選：10/29 精選只剩公東",
  live.open.map((j) => j.id),
  ["j-kungtung"],
);
check(
  "結束的策旅進過往策旅：池上",
  live.ended.map((x) => x.journey.id),
  ["j-chishang"],
);
check(
  "最後場次當天仍算進行中（台北 10/27 池上還在精選）",
  splitJourneys(liveJourneys, liveEvents, 8, "2026-10-27").open.map((j) => j.id),
  ["j-chishang", "j-kungtung"],
);
check(
  "全部結束 → 精選零筆（首頁整區不畫）",
  splitJourneys(liveJourneys, liveEvents, 8, "2026-12-07").open.length,
  0,
);
check(
  "卡片封面＝指著的那場活動的 image_key",
  linkedEventFor("/events/kungtung", liveEvents)?.imageKey,
  "storage:91c89fe9-1301-4d69-8708-7ff42ffbab94.webp",
);
check("指不到活動 → 沒有封面 key（用意象圖）", linkedEventFor("", liveEvents), null);

// ── 靜態 ────────────────────────────────────────────────────────────────
const eventsIndex = readFile("src/routes/events.index.tsx");
// 2026-11-10：/journeys 併入 /events，策旅卡片在 src/components/events/JourneyCard.tsx。
const journeyCard = readFile("src/components/events/JourneyCard.tsx");
const shelf = readFile("src/components/PastShelf.tsx");
const cms = readFile("src/lib/cms.ts");
check("/events 用 PastShelf", eventsIndex.includes("<PastShelf"), true);
check(
  "/events 過往活動沿用同一份 events（newestEndedFirst(events)）",
  eventsIndex.includes("newestEndedFirst(events)"),
  true,
);
check(
  // 2026-11 月曆檢視多了第四支 fetchCalendarEntries()（場次時間，見 events-calendar-selftest）；
  // 過往活動區本身仍然沒有多查——它用的是同一份 events。
  // 2026-11-10 /journeys 併入：多了策旅卡片要的 fetchJourneys／fetchJourneyEventDates／
  // fetchListingFacts，pages 改一次讀 events＋journeys 兩列。仍然全部在同一個 Promise.all。
  // 2026-11-10 業主「活動分類功能都拿掉」：不再查 fetchEventCategories()。
  "/events loader 全部平行（pages／events／月曆／策旅三支）",
  /Promise\.all\(\[\s*fetchPages\(\["events", "journeys"\]\),\s*fetchEvents\(\),\s*fetchCalendarEntries\(loadedAt\),\s*fetchJourneys\(\),\s*fetchJourneyEventDates\(\),\s*fetchListingFacts\(\),\s*\]\)/.test(
    eventsIndex,
  ),
  true,
);
check(
  "/events 查看全部切到既有的已結束分頁",
  eventsIndex.includes("setFilter(PAST_FILTER);"),
  true,
);
check(
  "/events 的過往策旅用同一個 splitJourneys（不另寫判準）",
  eventsIndex.includes("splitJourneys(allJourneys, journeyEvents, allJourneys.length)"),
  true,
);
const homeRoute = readFile("src/routes/index.tsx");
check(
  "首頁精選策旅用同一個 splitJourneys（不另寫判準）",
  homeRoute.includes("splitJourneys(journeys, journeyEvents).open.slice(0, 3)"),
  true,
);
check(
  "首頁在同一個 Promise.all 查活動日期",
  /Promise\.all\(\[[^\]]*fetchJourneyEventDates\(\)/.test(homeRoute),
  true,
);
check("首頁精選零筆整區不畫", homeRoute.includes("{featuredJourneys.length > 0 && ("), true);
check(
  "首頁不在模組層算今天（每次 render 才算）",
  /^const [^=]*=\s*splitJourneys/m.test(homeRoute),
  false,
);
check(
  "首頁 策旅卡封面走指著的活動 image_key",
  /imageFor\(\s*linkedEventFor\(j\.externalUrl, journeyEvents\)\?\.imageKey,\s*journeyImg,?\s*\)/.test(
    homeRoute,
  ),
  true,
);
check(
  "/events 策旅卡封面走指著的活動 image_key（linkedEventFor → JourneyCard）",
  eventsIndex.includes("linkedEventFor(j.externalUrl, journeyEvents)") &&
    journeyCard.includes("imageFor(linked?.imageKey, journeyImg)"),
  true,
);
check(
  "fetchJourneyEventDates 只 select 需要的欄位",
  // 0052：多一個 eq is_published（只看上架中的活動），select 的欄位不變。
  cms.includes('select("events", "slug,external_url,display_date,iso_date,image_key,notes", {'),
  true,
);
check("PastShelf 用 CoverImage", shelf.includes("<CoverImage"), true);
check("PastShelf 圖片 lazy", shelf.includes('loading="lazy"'), true);
check("PastShelf 標題兩行截斷", shelf.includes("line-clamp-2"), true);
check("PastShelf 零筆不畫", shelf.includes("if (items.length === 0) return null;"), true);
for (const [rel, src] of [
  ["PastShelf", shelf],
  ["past-shelf.ts", readFile("src/lib/past-shelf.ts")],
]) {
  check(`${rel} 不用 toLocale*`, /toLocale/.test(src), false);
}

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
