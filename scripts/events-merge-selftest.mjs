#!/usr/bin/env node
/**
 * events-merge-selftest.mjs —— 2026-11-10「活動」(/events) 與「策旅」(/journeys) 列表頁合併。
 *
 * 守四件事：
 *   [1] ?type= 篩選參數的解析與月曆篩選（src/lib/events-type.ts，真的行為測試）
 *   [2] /journeys 301 → /events?type=journey（路由檔）；策旅詳情（/events/<slug>）不受影響
 *   [3] 導覽：頁首一格「活動與策旅」、站內沒有任何連結還指著 /journeys 列表；
 *       首頁／選物入口的「查看全部」帶對 type；月曆換月保留 type
 *   [4] sitemap：不列 /journeys、/events 的 lastmod 算進策旅卡片；canonical 不含 ?type
 *
 * 不碰資料庫、不發網路請求。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

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
const checkTrue = (name, v) => check(name, v === true, true);
const readFile = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${rel}`);
  return readFileSync(p, "utf8");
};
/** 剝掉註解（註解裡提到 /journeys 是正常的，只看程式碼）。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const {
  EVENTS_TYPE_OPTIONS,
  JOURNEYS_REDIRECT,
  filterByKind,
  mergeNewestEnded,
  optionFor,
  parseTypeParam,
  showsEvents,
  showsJourneys,
  typeParamFor,
} = await import(pathToFileURL(join(ROOT, "src/lib/events-type.ts")).href);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] ?type= 篩選參數");
check("event", parseTypeParam("event"), "event");
check("journey", parseTypeParam("journey"), "journey");
check("all → 不帶（全部）", parseTypeParam("all"), undefined);
check("大小寫不同 → 不認", parseTypeParam("Journey"), undefined);
check("空字串 → 不帶", parseTypeParam(""), undefined);
check("陣列（?type=a&type=b）→ 不帶", parseTypeParam(["event", "journey"]), undefined);
check("數字 → 不帶", parseTypeParam(1), undefined);
check("undefined → 不帶", parseTypeParam(undefined), undefined);
check("篩選列三格、順序：全部｜活動｜策旅", [...EVENTS_TYPE_OPTIONS], ["all", "event", "journey"]);
check("「全部」那一格網址上不帶 type", typeParamFor("all"), undefined);
check("「策旅」那一格 → type=journey", typeParamFor("journey"), "journey");
check("沒有 type → 選中「全部」", optionFor(undefined), "all");
check("type=event → 選中「活動」", optionFor("event"), "event");
check("全部：兩種都顯示", [showsEvents(undefined), showsJourneys(undefined)], [true, true]);
check("只看活動", [showsEvents("event"), showsJourneys("event")], [true, false]);
check("只看策旅", [showsEvents("journey"), showsJourneys("journey")], [false, true]);

const entries = [
  { id: "a", kind: "event" },
  { id: "b", kind: "journey" },
  { id: "c", kind: "event" },
];
check(
  "月曆：全部 → 原樣",
  filterByKind(entries, undefined).map((e) => e.id),
  ["a", "b", "c"],
);
check(
  "月曆：只看活動",
  filterByKind(entries, "event").map((e) => e.id),
  ["a", "c"],
);
check(
  "月曆：只看策旅",
  filterByKind(entries, "journey").map((e) => e.id),
  ["b"],
);
check("月曆篩選不改動傳入的陣列", entries.length, 3);

const J = [
  { endDate: "2026-10-27", id: "chishang" },
  { endDate: "2026-06-01", id: "old-trip" },
];
const E = [
  { endDate: "2026-11-06", id: "sea" },
  { endDate: "2026-10-27", id: "same-day-event" },
  { endDate: "2026-09-01", id: "talk" },
];
check(
  "過往卡片區（全部）：依結束日合併、同一天策旅在前",
  mergeNewestEnded(J, E, 8).map((x) => x.id),
  ["sea", "chishang", "same-day-event", "talk", "old-trip"],
);
check(
  "過往卡片區（全部）：取前 limit 筆",
  mergeNewestEnded(J, E, 2).map((x) => x.id),
  ["sea", "chishang"],
);
check("過往卡片區：兩邊都空 → 空", mergeNewestEnded([], [], 8), []);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] /journeys 301 → /events?type=journey");
check("轉址目的地常數", JOURNEYS_REDIRECT, { to: "/events", search: { type: "journey" } });
const journeysRoute = strip(readFile("src/routes/journeys.tsx"));
checkTrue("journeys.tsx 宣告 /journeys", journeysRoute.includes('createFileRoute("/journeys")'));
checkTrue(
  "throw redirect 到 /events?type=journey、301",
  /throw redirect\(\{\s*to: "\/events",\s*search: \{ type: "journey" \},\s*statusCode: 301\s*\}\)/.test(
    journeysRoute,
  ),
);
checkTrue("journeys.tsx 沒有 component（真的只轉址）", !/component\s*:/.test(journeysRoute));
checkTrue("journeys.tsx 沒有 loader", !/loader\s*:/.test(journeysRoute));
// /journeys 從來沒有子路由；策旅詳情在 /events/<slug>。轉址只能動列表這一條。
const routeFiles = readdirSync(join(ROOT, "src/routes")).filter((f) => f.startsWith("journeys"));
check("src/routes 底下以 journeys 開頭的只有列表那一支", routeFiles, ["journeys.tsx"]);
const tree = readFile("src/routeTree.gen.ts");
checkTrue("路由表仍有 /journeys（轉址要有路由才會執行）", tree.includes("'/journeys'"));
// admin 底下的 /admin/journeys/$id 是後台，在路由樹裡的相對 path 也是 '/journeys/...'，所以看 fullPath。
checkTrue("路由表沒有前台 /journeys/ 子路由", !/fullPath: '\/journeys\//.test(tree));

const eventsIndex = readFile("src/routes/events.index.tsx");
const eventsCode = strip(eventsIndex);
checkTrue(
  "/events validateSearch 用 parseTypeParam 解析 ?type=",
  /const type = parseTypeParam\(search\.type\);\s*if \(type\) out\.type = type;/.test(eventsCode),
);
checkTrue(
  "/events validateSearch 仍解析 view 與 month（可共存）",
  eventsCode.includes('search.view === "list" || search.view === "calendar"') &&
    eventsCode.includes("parseMonthParam(search.month)"),
);
checkTrue(
  "月曆條目依 type 篩選",
  eventsCode.includes("entries={filterByKind(calendar.entries, type)}"),
);
checkTrue("月曆收到 type（換月保留篩選）", /<EventsCalendar[\s\S]*?type=\{type\}/.test(eventsCode));
checkTrue(
  "類型篩選鈕保留 view 與 month",
  eventsCode.includes(
    "search={{ view: search.view, month: search.month, type: typeParamFor(opt) }}",
  ),
);
checkTrue(
  "月曆／列表切換鈕保留 type（與 month）",
  eventsCode.includes("{ view: target, month: search.month, type }") &&
    eventsCode.includes("{ view: target, type }"),
);

// 2026-11-10 業主：「篩選設計現在太複雜，我要畫面簡潔；活動卡片用左右滑動。」
console.log("\n[2b] 手機版簡化：一排控制、無報名中／已結束切換、橫滑卡片");
checkTrue(
  "頂部「報名中／已結束」切換拿掉",
  !eventsCode.includes("PAST_FILTER") && !/UPCOMING_LABEL|PAST_LABEL/.test(eventsCode),
);
checkTrue("主體只放還沒結束的活動", eventsCode.includes("events.filter((e) => !isEventPast(e))"));
checkTrue(
  "已結束的在最下方過往區（PastShelf，id=past）",
  /id="past"[\s\S]*<PastShelf/.test(eventsCode),
);
checkTrue(
  "月曆／列表是一顆圖示鈕（CalendarDays／List）",
  eventsCode.includes("<CalendarDays") && eventsCode.includes("<List "),
);
checkTrue(
  "圖示鈕有 aria-label（切換月曆／切換列表）",
  eventsCode.includes("aria-label={t(VIEW_LABELS.toggle[target])}") &&
    eventsIndex.includes('zh: "切換月曆"'),
);
checkTrue("圖示鈕點擊區 ≥44px（h-11 w-11）", eventsCode.includes("h-11 w-11"));
checkTrue(
  "類型分頁點擊區 ≥44px、選中用底線（無粗黑框）",
  eventsCode.includes("min-h-11 items-center border-b-2") &&
    !eventsCode.includes("border border-foreground text-sm tracking-widest"),
);
checkTrue(
  "活動列與策旅列都用橫滑（cardRail）",
  eventsCode.includes("cardRail(eventList.length)") &&
    eventsCode.includes("cardRail(journeyList.length)"),
);
checkTrue("區塊小標不再印計數", !/SectionHeading[^>]*count=/.test(eventsCode));
checkTrue(
  "頁首手機收斂（compact＋clampIntro）",
  /<PageHeader\s+compact\s+clampIntro/.test(eventsCode),
);
const { cardRail, RAIL_HINT } = await import(
  pathToFileURL(join(ROOT, "src/lib/card-rail.ts")).href
);
check("一張卡：不橫滑", cardRail(1), { track: "", item: "" });
checkTrue(
  "兩張以上：82% 寬＋snap",
  cardRail(2).item.includes("max-md:w-[82%]") &&
    cardRail(2).track.includes("max-md:snap-mandatory"),
);
checkTrue(
  "橫滑 class 全部帶 max-md:（桌機交回 featureLayout）",
  [...cardRail(3).track.split(/\s+/), ...cardRail(3).item.split(/\s+/)].every((c) =>
    c.startsWith("max-md:"),
  ),
);
check("滑動提示文案", RAIL_HINT.zh, "共 {n} 則，左右滑動看更多");
checkTrue(
  "過往區的包場活動也標「包場」（PastShelfItem.privateBooking）",
  eventsCode.includes("privateBooking: e.privateBooking,") &&
    strip(readFile("src/components/PastShelf.tsx")).includes(
      "{item.privateBooking ? <PrivateBookingBadge /> : null}",
    ),
);
checkTrue("策旅卡片用 JourneyCard", eventsCode.includes("<JourneyCard"));
checkTrue("策旅合作共創只在 type=journey", eventsCode.includes('{type === "journey" ? ('));
checkTrue(
  "策旅文案仍讀 pages/'journeys' 的區塊",
  eventsCode.includes('fetchPages(["events", "journeys"])') &&
    eventsCode.includes('jp.block("collabBody"'),
);
const cal = strip(readFile("src/components/events/EventsCalendar.tsx"));
const calLinks = [...cal.matchAll(/search=\{\{ view: "calendar", month: [^}]*\}\}/g)].map(
  (m) => m[0],
);
check("月曆裡的 5 個連結（上月／本月／下月／跳月×2）", calLinks.length, 5);
checkTrue(
  "月曆每一個連結都帶 type",
  calLinks.every((l) => /, type \}\}$/.test(l)),
);
// 報名與結帳不在這次的範圍：/events 列表頁不應該碰報名元件。
for (const forbidden of [
  "SessionPicker",
  "PlanPicker",
  "directCheckoutSearch",
  "directSeatLimit",
]) {
  checkTrue(`/events 列表頁沒有碰 ${forbidden}`, !eventsCode.includes(forbidden));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 導覽與站內連結");
const header = strip(readFile("src/components/SiteHeader.tsx"));
checkTrue(
  "頁首「活動與策旅」一格指向 /events",
  header.includes('{ to: "/events", label: t(ui.nav.eventsJourneys), exact: false }'),
);
checkTrue("頁首不再有 /journeys", !header.includes('"/journeys"'));
checkTrue("頁首不再用 nav.journeys／nav.events", !/ui\.nav\.(journeys|events)\b/.test(header));
const strings = readFile("src/i18n/strings.ts");
checkTrue(
  "nav.eventsJourneys 三語",
  strings.includes(
    'eventsJourneys: { zh: "活動與策旅", en: "Events & Journeys", ja: "イベント・旅" }',
  ),
);

// 全站（不含後台、路由宣告本身）不准再有指向 /journeys 列表的連結。
function walkDir(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkDir(p, out);
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const linkPatterns = [
  /to=["{]\s*"?\/journeys["}]/,
  /to:\s*"\/journeys"/,
  /href=\{?["'`]\/journeys(["'`?#]|$)/,
  /"\/journeys" as const/,
  /localizeHref\(\s*"\/journeys"/,
];
const offenders = [];
for (const file of walkDir(join(ROOT, "src"))) {
  const rel = relative(ROOT, file);
  if (rel.startsWith("src/routes/admin") || rel === "src/routeTree.gen.ts") continue;
  const code = strip(readFileSync(file, "utf8"));
  if (linkPatterns.some((re) => re.test(code))) offenders.push(rel);
}
check("src/ 沒有任何連結還指著 /journeys 列表", offenders, []);

const home = strip(readFile("src/routes/index.tsx"));
checkTrue(
  "首頁「近期活動」查看全部 → /events?type=event",
  home.includes('link={{ type: "event", label: t(ui.buttons.viewAll) }}'),
);
checkTrue(
  "首頁「近期策旅」查看全部 → /events?type=journey",
  home.includes('link={{ type: "journey", label: t(ui.buttons.viewAll) }}'),
);
checkTrue(
  "SubHeader 的連結落在 /events 並帶 type",
  home.includes('<Link to="/events" search={{ type: link.type }}'),
);
checkTrue(
  "「讀．聚．行」的「行」→ /events?type=journey",
  /to: "\/events" as const,\s*type: "journey" as const/.test(home),
);
checkTrue(
  "首頁 hero 主按鈕：有近期場次時捲到正下方的 #upcoming，沒有時去 /events",
  home.includes('<a href="#upcoming" className="btn-solid">') &&
    home.includes('<Link to="/events" className="btn-solid">'),
);
const strip2 = strip(readFile("src/components/shop/ShopCategoryStrip.tsx"));
checkTrue(
  "選物頁分類列：策旅那一格 → /events?type=journey",
  /key: "journeys",[\s\S]*?to: "\/events",\s*type: "journey"/.test(strip2),
);
checkTrue(
  "選物頁分類列：活動那一格 → /events?type=event",
  /key: "events",[\s\S]*?to: "\/events",\s*type: "event"/.test(strip2),
);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] sitemap 與 canonical");
const { buildSitemapEntries } = await import(
  pathToFileURL(join(ROOT, "src/lib/seo/sitemap-entries.ts")).href
);
const sitemap = buildSitemapEntries(
  {
    pages: [
      { slug: "events", updatedAt: "2026-11-01T00:00:00Z" },
      { slug: "journeys", updatedAt: "2026-11-05T00:00:00Z" },
    ],
    pageParts: [],
    events: [
      { slug: "kungtung", isoDate: "2026-12-06", updatedAt: "2026-11-02T00:00:00Z", booking: null },
    ],
    products: [],
    journeys: [{ externalUrl: "/events/kungtung", updatedAt: "2026-11-03T00:00:00Z" }],
    publicationsLatest: null,
    curatedLatest: null,
  },
  "2026-11-10",
);
const paths = sitemap.map((e) => e.path);
checkTrue("sitemap 不列 /journeys", !paths.includes("/journeys"));
checkTrue("sitemap 仍列 /events", paths.includes("/events"));
checkTrue("策旅詳情頁（/events/kungtung）仍在 sitemap", paths.includes("/events/kungtung"));
check(
  "/events 的 lastmod 算進 pages/'journeys'（策旅文案搬到這一頁）",
  sitemap.find((e) => e.path === "/events")?.lastmod,
  "2026-11-05T00:00:00Z",
);

const { canonicalUrl, SITE_ORIGIN, isNoindexPath } = await import(
  pathToFileURL(join(ROOT, "src/lib/seo/core.ts")).href
);
check(
  "canonical：/events?type=journey → /events",
  canonicalUrl("/events", { type: "journey" }),
  `${SITE_ORIGIN}/events`,
);
check(
  "canonical：/events?type=event&view=calendar&month=2026-12 → /events",
  canonicalUrl("/events", { type: "event", view: "calendar", month: "2026-12" }),
  `${SITE_ORIGIN}/events`,
);
check(
  "canonical：英文版 → /en/events",
  canonicalUrl("/events", { type: "journey" }, "en"),
  `${SITE_ORIGIN}/en/events`,
);
check("/events 可收錄", isNoindexPath("/events"), false);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] 活動分類移除（2026-11-10 業主：「活動分類功能都拿掉」）");
{
  const evIdx = strip(readFile("src/routes/events.index.tsx"));
  const evSlug = strip(readFile("src/routes/events.$slug.tsx"));
  const homeSrc = strip(readFile("src/routes/index.tsx"));
  checkTrue("/events 不再查 fetchEventCategories", !evIdx.includes("fetchEventCategories"));
  checkTrue("/events 卡片不再印分類（沒有 e.category）", !/\be\.category\b/.test(evIdx));
  checkTrue("活動詳情頁不再查 fetchEventCategories", !evSlug.includes("fetchEventCategories"));
  checkTrue("活動詳情頁不再印分類", !/categoryLabel|event\.category/.test(evSlug));
  checkTrue("首頁活動卡不再印分類", !/\{e\.category\}|category: e\.category/.test(homeSrc));
  const shelf = strip(readFile("src/components/PastShelf.tsx"));
  checkTrue("PastShelf：category 空字串就不印 eyebrow", shelf.includes("{item.category ? ("));
  const routes = readdirSync(join(ROOT, "src/routes")).filter((f) => /categor/i.test(f));
  check("前台沒有分類列表頁路由（只剩後台 _shell.categories）", routes, []);
  const adminRoutes = readdirSync(join(ROOT, "src/routes/admin")).filter((f) => /categor/i.test(f));
  check("後台分類頁檔案仍在（直接打網址還進得去）", adminRoutes, ["_shell.categories.tsx"]);
  const shell = strip(readFile("src/routes/admin/_shell.tsx"));
  checkTrue("後台導覽不再有「活動分類」", !shell.includes('"/admin/categories"'));
  const list = strip(readFile("src/routes/admin/_shell.events.tsx"));
  checkTrue("後台活動列表沒有分類欄", !list.includes("<TableHead>分類</TableHead>"));
  const quick = strip(readFile("src/components/admin/EventQuickCreate.tsx"));
  checkTrue("一頁新增不再顯示分類選單", !/label="分類"/.test(quick));
  checkTrue(
    "一頁新增仍帶一個有效分類（events.category 必填外鍵）",
    quick.includes("category: defaultCategoryId(categories, isJourney)"),
  );
  const tree = readFile("src/routeTree.gen.ts");
  checkTrue("路由表沒有 /events/category 之類的分類頁", !/fullPath: '\/events\/categor/.test(tree));
}

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
