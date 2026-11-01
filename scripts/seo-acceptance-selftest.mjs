#!/usr/bin/env node
/**
 * seo-acceptance-selftest.mjs —— 2026-11 SEO 獨立驗收的 6 項修正
 *
 *   [純函式] src/lib/event-status.ts：isEventEnded（單頁用的「已結束」，與列表同一條規則）、
 *            latestSessionEndIso
 *   [純函式] src/lib/seo/sitemap-entries.ts：lastmod 取內容的 updated_at（含場次、票種）、
 *            已結束活動用結束時間、策旅卡片不帶 lastmod、絕不出現「現在」
 *   [靜態]   詳情頁與三個著陸頁都在「已結束」時改畫 EventEndedNotice；
 *            SessionList 已結束不印「尚餘名額」；/events/$slug、/shop/$slug 查無代稱時
 *            先不分大小寫查找再 301；JSON-LD 的 Offer 價格在頁面上看得到（basePrice）
 *
 * JSON-LD 本身（多場次、SoldOut、PostalAddress、大小寫比對）在 seo-selftest.mjs [8]。
 * 不碰任何資料庫。
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/seo-acceptance-selftest.mjs";

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

const { isEventEnded, isEventPast, latestSessionEndDate, latestSessionEndIso } = await import(
  pathToFileURL(join(ROOT, "src/lib/event-status.ts")).href
);
const { buildSitemapEntries, eventLastmod, latestOf } = await import(
  pathToFileURL(join(ROOT, "src/lib/seo/sitemap-entries.ts")).href
);

const TODAY = "2026-11-01";

// ── isEventEnded ─────────────────────────────────────────────────────────
console.log("\n[1] isEventEnded：與 /events「已結束」分頁同一條規則");
const chishang = [
  { startsAt: "2026-10-23T06:00:00+00:00", endsAt: "2026-10-25T04:00:00+00:00" },
  { startsAt: "2026-10-25T06:00:00+00:00", endsAt: "2026-10-27T04:00:00+00:00" },
];
check(
  "池上（iso 10-23、最後一梯 10-27）11/1 已結束",
  isEventEnded("2026-10-23", chishang, TODAY),
  true,
);
check(
  "與 isEventPast 同答案",
  isEventEnded("2026-10-23", chishang, TODAY),
  isEventPast({ isoDate: "2026-10-23", lastSessionDate: latestSessionEndDate(chishang) }, TODAY),
);
check(
  "iso 已過但場次在今天 → 未結束",
  isEventEnded("2026-10-20", [{ startsAt: "2026-11-01T06:00:00+00:00", endsAt: null }], TODAY),
  false,
);
check(
  "海的聲音（11/6）未結束",
  isEventEnded(
    "2026-11-06",
    [{ startsAt: "2026-11-06T06:00:00+00:00", endsAt: "2026-11-06T08:00:00+00:00" }],
    TODAY,
  ),
  false,
);
check("活動當天仍是進行中", isEventEnded("2026-11-01", [], TODAY), false);
check(
  "著陸頁（iso 未知）用場次判斷：9/22 已結束",
  isEventEnded(
    null,
    [{ startsAt: "2026-09-22T05:30:00+00:00", endsAt: "2026-09-22T07:30:00+00:00" }],
    TODAY,
  ),
  true,
);
check("沒有日期也沒有場次 → 不算結束", isEventEnded(null, [], TODAY), false);
check(
  "台北時區：UTC 10/31 16:30 = 台北 11/1 → 今天，不算結束",
  isEventEnded(null, [{ startsAt: "2026-10-31T16:30:00+00:00", endsAt: null }], TODAY),
  false,
);
check("latestSessionEndIso 取最晚結束", latestSessionEndIso(chishang), "2026-10-27T04:00:00+00:00");
check("latestSessionEndIso 沒有場次 → null", latestSessionEndIso([]), null);

// ── sitemap lastmod ──────────────────────────────────────────────────────
console.log("\n[2] sitemap lastmod：內容的 updated_at；已結束用結束時間");
const sess = (startsAt, endsAt, updatedAt, planUpdatedAts = []) => ({
  startsAt,
  endsAt,
  updatedAt,
  planUpdatedAts,
});
const source = {
  pages: [
    { slug: "index", updatedAt: "2026-08-08T10:01:35Z" },
    { slug: "privacy", updatedAt: "2026-08-08T10:01:35Z" },
    { slug: "about", updatedAt: "2026-08-08T10:01:35Z" },
    { slug: "visit", updatedAt: "2026-08-09T09:22:17Z" },
  ],
  pageParts: [{ pageSlug: "privacy", updatedAt: "2026-10-22T08:31:18Z" }],
  events: [
    {
      slug: "sound-of-the-sea",
      isoDate: "2026-11-06",
      updatedAt: "2026-10-21T09:19:02Z",
      booking: {
        updatedAt: "2026-10-21T09:19:02Z",
        sessions: [
          sess("2026-11-06T06:00:00+00:00", "2026-11-06T08:00:00+00:00", "2026-10-24T05:18:03Z", [
            "2026-10-29T03:05:59Z",
            "2026-10-21T03:45:24Z",
          ]),
        ],
      },
    },
    {
      slug: "InntervalChishang.1023",
      isoDate: "2026-10-23",
      updatedAt: "2026-10-13T06:22:07Z",
      booking: {
        updatedAt: "2026-10-13T06:22:07Z",
        sessions: [
          sess("2026-10-23T06:00:00+00:00", "2026-10-25T04:00:00+00:00", "2026-09-13T18:24:11Z"),
          sess("2026-10-25T06:00:00+00:00", "2026-10-27T04:00:00+00:00", "2026-09-13T18:24:11Z"),
        ],
      },
    },
    {
      slug: "no-sessions-past",
      isoDate: "2026-09-01",
      updatedAt: "2026-09-10T00:00:00Z",
      booking: null,
    },
    { slug: "no-date", isoDate: null, updatedAt: null, booking: null },
    { slug: "kungtung", isoDate: "2026-12-06", updatedAt: "2026-11-01T04:23:48Z", booking: null },
  ],
  products: [
    { slug: "pub-tw-001", productType: "book", updatedAt: "2026-08-15T10:26:09Z" },
    { slug: "event-sound-of-the-sea", productType: "event", updatedAt: "2026-10-21T09:19:02Z" },
  ],
  journeys: [
    { externalUrl: "/events/kungtung", updatedAt: "2026-12-31T00:00:00Z" },
    { externalUrl: "https://example.com/x", updatedAt: "2026-12-31T00:00:00Z" },
  ],
  publicationsLatest: "2026-08-15T10:52:06Z",
  curatedLatest: "2026-08-09T07:25:46Z",
};
const entries = buildSitemapEntries(source, TODAY);
const lm = (path) => entries.filter((e) => e.path === path).map((e) => e.lastmod ?? null);
check("未結束活動：取場次／票種的最新 updated_at（票價改了要算）", lm("/events/sound-of-the-sea"), [
  "2026-10-29T03:05:59Z",
]);
check(
  "已結束活動：保留在 sitemap、lastmod = 最後一梯結束時間",
  lm("/events/InntervalChishang.1023"),
  ["2026-10-27T04:00:00+00:00"],
);
check("已結束、沒有場次：iso_date 當天（台北）", lm("/events/no-sessions-past"), [
  "2026-09-01T00:00:00+08:00",
]);
check("沒有任何 updated_at → 不輸出 lastmod", lm("/events/no-date"), [null]);
check("固定頁：page_blocks 的更新算進去（/privacy 10/22 改過內文）", lm("/privacy"), [
  "2026-10-22T08:31:18Z",
]);
check("/about 取 about＋visit 最新", lm("/about"), ["2026-08-09T09:22:17Z"]);
check("/events 列表算進活動列", lm("/events"), ["2026-11-01T04:23:48Z"]);
check("/shop?tab=curated 算進 curated_*", lm("/shop?tab=curated"), ["2026-08-09T07:25:46Z"]);
check(
  "策旅卡片那一筆不帶 lastmod（journeys.updated_at 不是那一頁的內容）",
  lm("/events/kungtung"),
  ["2026-11-01T04:23:48Z", null],
);
check(
  "外部策旅網址不列",
  entries.some((e) => /example\.com/.test(e.path)),
  false,
);
check(
  "活動票券不另列 /shop/event-*",
  entries.some((e) => e.path === "/shop/event-sound-of-the-sea"),
  false,
);
check("著陸頁子頁（無資料列）沒有 lastmod", lm("/events/kungtung/hosts/alice"), [null]);
{
  const all = new Set(
    [
      ...source.pages.map((p) => p.updatedAt),
      ...source.pageParts.map((p) => p.updatedAt),
      ...source.events.flatMap((e) => [
        e.updatedAt,
        e.booking?.updatedAt,
        ...(e.booking?.sessions ?? []).flatMap((s) => [s.updatedAt, s.endsAt, ...s.planUpdatedAts]),
      ]),
      ...source.products.map((p) => p.updatedAt),
      ...source.journeys.map((j) => j.updatedAt),
      source.publicationsLatest,
      source.curatedLatest,
      "2026-09-01T00:00:00+08:00",
    ].filter(Boolean),
  );
  const strays = entries.filter((e) => e.lastmod && !all.has(e.lastmod));
  check("每個 lastmod 都來自資料（沒有部署時間／現在）", strays, []);
}
check("latestOf 略過壞值", latestOf([null, "x", "2026-01-01T00:00:00Z"]), "2026-01-01T00:00:00Z");
check(
  "eventLastmod 與 build 一致",
  eventLastmod(source.events[1], TODAY),
  "2026-10-27T04:00:00+00:00",
);

// ── 靜態：頁面 ───────────────────────────────────────────────────────────
console.log("\n[3] 頁面：已結束改畫 EventEndedNotice、不印尚餘名額、價格看得到");
const picker = readFile("src/components/shop/SessionPicker.tsx");
checkTrue("EventEndedNotice 存在", /export function EventEndedNotice/.test(picker));
const notice = picker.slice(picker.indexOf("export function EventEndedNotice"));
checkTrue(
  "EventEndedNotice 不畫 /checkout 連結",
  !/checkout/.test(notice.slice(0, notice.indexOf("\n}\n"))),
);
checkTrue(
  "EventEndedNotice 的場次清單 showSeatsRemaining={false} 且 ended",
  /showSeatsRemaining=\{false\}[\s\S]{0,80}ended/.test(notice),
);
checkTrue("EventEndedNotice 的按鈕 disabled", /<button[\s\S]{0,60}disabled/.test(notice));
checkTrue(
  "SessionList 已結束優先於尚餘名額",
  /const closed = ended \|\|[^;]*;\s*const note = closed\s*\?\s*t\(COPY\.sessionEnded\)/.test(
    picker,
  ),
);
checkTrue("SessionList 印票價（JSON-LD 的價格看得到）", /formatPrice\(p\.price\)/.test(picker));

const routes = {
  "src/routes/events.$slug.tsx": /ended && booking\.product \? \(\s*<EventEndedNotice/,
  // 2026-11：著陸頁的 bookingClosed = eventEnded(null, product) || directBookingClosed(…)，
  // 英雄區錨點與報名區用同一個值（session-start-booking-selftest 另外守 directBookingClosed）。
  "src/routes/events.kungtung.tsx":
    /eventEnded\(null, product\) \|\| directBookingClosed\(product, now\)[\s\S]*if \(bookingClosed\) return <EventEndedNotice/,
  "src/routes/events.city-salon-0922.tsx":
    /eventEnded\(null, product\) \|\| directBookingClosed\(product, now\)[\s\S]*if \(bookingClosed\) return <EventEndedNotice/,
  "src/routes/events.sound-of-the-sea.tsx":
    /eventEnded\(null, product\) \|\| directBookingClosed\(product, now\)[\s\S]*if \(bookingClosed\) return <EventEndedNotice/,
};
for (const [rel, re] of Object.entries(routes)) {
  const src = readFile(rel);
  checkTrue(`${rel} 已結束改畫 EventEndedNotice`, re.test(src));
  checkTrue(
    `${rel} SessionPicker 帶 basePrice`,
    /<SessionPicker[\s\S]{0,200}basePrice=\{product\.price\}/.test(src),
  );
  checkTrue(`${rel} JSON-LD 帶書店地址`, /storeAddress(FromMatches|Of)\(/.test(src));
  // 「已結束」只問 eventEnded()（→ isEventEnded → isEventPast），不在頁面裡自己比日期
  check(`${rel} 不自己比日期`, /todayInTaipei|new Date\(\)\s*[<>]/.test(src), false);
}
const pages = readFile("src/lib/seo/pages.ts");
checkTrue(
  "pages.ts 的 eventEnded 走 isEventEnded",
  /isEventEnded\(isoDate, product\?\.sessions \?\? \[\]\)/.test(pages),
);
const cms = readFile("src/lib/cms.ts");
checkTrue("詳情頁讀 iso_date", /display_date,iso_date,category/.test(cms));

console.log("\n[4] 大小寫：查無代稱 → 不分大小寫查找 → 301");
for (const [rel, fn, to] of [
  ["src/routes/events.$slug.tsx", "findEventSlugIgnoringCase", "/events/$slug"],
  ["src/routes/shop.$slug.tsx", "findActiveProductSlugIgnoringCase", "/shop/$slug"],
]) {
  const src = readFile(rel);
  checkTrue(`${rel} 呼叫 ${fn}`, src.includes(`await ${fn}(params.slug)`));
  checkTrue(
    `${rel} 301 到 ${to}`,
    new RegExp(
      `redirect\\(\\{ to: "${to.replace("$", "\\$")}", params: \\{ slug: canonical \\}, statusCode: 301 \\}\\)`,
    ).test(src),
  );
}
checkTrue(
  "活動查找用 ilike＋exactIlikePattern",
  /ilike\("slug", pattern\)/.test(cms) && /exactIlikePattern\(slug\)/.test(cms),
);
const shop = readFile("src/lib/shop.ts");
checkTrue(
  "商品查找只找上架中",
  /\.eq\("status", "active"\)\s*\.ilike\("slug", pattern\)/.test(shop),
);

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
