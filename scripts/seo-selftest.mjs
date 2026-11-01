#!/usr/bin/env node
/**
 * seo-selftest.mjs —— src/lib/seo/core.ts 的行為測試（2026-11 SEO 健檢）。
 *
 * core.ts 刻意零 runtime import（同 src/server/cache-policy.ts），所以這裡可以直接 import
 * 真的程式碼、呼叫真的函式。實際 SSR 輸出的檢查在 scripts/check-seo.mjs（要連線，不進 CI）。
 *
 * 守的東西：
 *   [1] canonical：去 query、去尾斜線、固定路徑小寫、活動代稱大小寫保留、/shop 分頁
 *   [2] 轉址：尾斜線 308、大小寫 301、非頁面路徑與非 GET 不轉
 *   [3] noindex／robots.txt
 *   [4] 描述：佔位符、長度 70–160、標題模板與外來品牌後綴
 *   [5] JSON-LD：Event／Product／BreadcrumbList／BookStore 的 Google 必要欄位
 *   [6] sitemap.xml：合法 XML、去重、絕對網址
 *   [7] STATIC_PUBLIC_PATHS 與 routeTree.gen.ts 對帳（新增前台頁面忘了加會紅）
 *
 * 執行：node scripts/seo-selftest.mjs（或 npm test）
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  absoluteUrl,
  bookStoreLd,
  breadcrumbLd,
  canonicalUrl,
  charLength,
  eventLd,
  fitDescription,
  hasPlaceholder,
  isNoindexPath,
  parseOpeningHours,
  productLd,
  redirectFor,
  robotsTagFor,
  robotsTxt,
  seoTitle,
  sitemapXml,
  STATIC_PUBLIC_PATHS,
  stripForeignBrandSuffix,
  toTaipeiIso,
} from "../src/lib/seo/core.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/seo-selftest.mjs";

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
const checkTrue = (label, v) => check(label, v === true, true);

const readFile = (p) => {
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};

const O = "https://www.intervalbooks.tw";

console.log("\n[1] canonical");
check("首頁", canonicalUrl("/"), `${O}/`);
check("去 query（utm）", canonicalUrl("/", { utm_source: "fb" }), `${O}/`);
check("去尾斜線", canonicalUrl("/events/"), `${O}/events`);
check("固定路徑轉小寫", canonicalUrl("/EVENTS"), `${O}/events`);
check(
  "/Shop/<slug> 第一段小寫、slug 保留",
  canonicalUrl("/Shop/pub-tw-001"),
  `${O}/shop/pub-tw-001`,
);
check(
  "活動代稱大小寫保留（InntervalChishang.1023）",
  canonicalUrl("/events/InntervalChishang.1023"),
  `${O}/events/InntervalChishang.1023`,
);
check(
  "著陸頁子頁小寫",
  canonicalUrl("/Events/Kungtung/Hosts/Alice"),
  `${O}/events/kungtung/hosts/alice`,
);
check(
  "/shop?tab=publications 自我 canonical",
  canonicalUrl("/shop", { tab: "publications" }),
  `${O}/shop?tab=publications`,
);
check(
  "/shop?tab=curated 自我 canonical",
  canonicalUrl("/shop", { tab: "curated" }),
  `${O}/shop?tab=curated`,
);
check("/shop?tab=products → /shop", canonicalUrl("/shop", { tab: "products" }), `${O}/shop`);
check("/shop?tab=亂寫 → /shop", canonicalUrl("/shop", { tab: "x" }), `${O}/shop`);
check("absoluteUrl 補網域", absoluteUrl("/assets/a.jpg"), `${O}/assets/a.jpg`);
check(
  "absoluteUrl 絕對網址原樣",
  absoluteUrl("https://x.supabase.co/a.webp"),
  "https://x.supabase.co/a.webp",
);
check("absoluteUrl 空值", absoluteUrl(""), "");

console.log("\n[2] 轉址");
check("/events/ → 308 /events", redirectFor("/events/", "", "GET"), {
  status: 308,
  location: "/events",
});
check("/shop/pub-tw-001/?a=1 → 308 保留 query", redirectFor("/shop/pub-tw-001/", "?a=1", "GET"), {
  status: 308,
  location: "/shop/pub-tw-001?a=1",
});
check("/EVENTS → 301 /events", redirectFor("/EVENTS", "", "GET"), {
  status: 301,
  location: "/events",
});
check("/Shop/pub-tw-001 → 301", redirectFor("/Shop/pub-tw-001", "", "HEAD"), {
  status: 301,
  location: "/shop/pub-tw-001",
});
check("活動代稱含大寫不轉", redirectFor("/events/InntervalChishang.1023", "", "GET"), null);
check("首頁不轉", redirectFor("/", "", "GET"), null);
check("POST 不轉", redirectFor("/events/", "", "POST"), null);
check("/_serverFn/ 不轉", redirectFor("/_serverFn/abc/", "", "GET"), null);
check("/api/mcp/ 不轉", redirectFor("/api/mcp/", "", "GET"), null);
check(
  "/.well-known/ 不轉",
  redirectFor("/.well-known/oauth-authorization-server/", "", "GET"),
  null,
);

console.log("\n[3] noindex／robots.txt");
for (const p of [
  "/admin",
  "/admin/login",
  "/vendor/login",
  "/account",
  "/checkout",
  "/checkout/complete",
  "/cart",
  "/api/mcp",
  "/oauth/authorize",
  "/auth/confirm",
]) {
  check(`${p} → X-Robots-Tag noindex`, robotsTagFor(p), "noindex, nofollow");
}
for (const p of [
  "/",
  "/events",
  "/events/kungtung",
  "/shop",
  "/shop/pub-tw-001",
  "/about",
  "/journeys",
  "/accounting-book",
]) {
  check(`${p} 可收錄`, isNoindexPath(p), false);
}
const robots = robotsTxt();
checkTrue("robots.txt 宣告 sitemap", robots.includes(`Sitemap: ${O}/sitemap.xml`));
for (const p of [
  "/admin",
  "/vendor",
  "/account",
  "/checkout",
  "/cart",
  "/api",
  "/oauth",
  "/auth",
]) {
  checkTrue(`robots.txt Disallow: ${p}`, robots.split("\n").includes(`Disallow: ${p}`));
}
checkTrue("robots.txt 不擋 /_serverFn（渲染要用）", !robots.includes("Disallow: /_serverFn"));

console.log("\n[4] 文字");
checkTrue("佔位符偵測（＿＿＿）", hasPlaceholder("留一段屬於自己的＿＿＿小時光。"));
const home = fitDescription(
  { zh: "留一段屬於自己的＿＿＿小時光。", en: "Keep an interval.", ja: "あなただけの時間。" },
  { zh: "替代描述。".repeat(20), en: "x", ja: "y" },
);
checkTrue("有佔位符時用 fallback", home.zh.startsWith("替代描述"));
checkTrue("太長截到 160 字以內", charLength(home.zh) <= 160);
const short = fitDescription({
  zh: "小時光書店之隱私權聲明。",
  en: "Privacy.",
  ja: "プライバシー。",
});
checkTrue(`太短補標語（${charLength(short.zh)} 字 ≥ 70）`, charLength(short.zh) >= 70);
checkTrue("補的是站名標語", short.zh.includes("華山文創園區"));
check(
  "外來品牌後綴拿掉（半形 | ）",
  stripForeignBrandSuffix("2026 台東池上秋收山海旅行 | 馥自然人文空間"),
  "2026 台東池上秋收山海旅行",
);
check("全形｜副標保留", stripForeignBrandSuffix("打開心流｜陶作閱讀課"), "打開心流｜陶作閱讀課");
check(
  "商品 title 模板",
  seoTitle(
    { zh: "東北風", en: "Dongbeifeng", ja: "東北風" },
    { zh: "地方刊物", en: "Local Publications", ja: "地域の刊行物" },
  ),
  {
    zh: "東北風｜地方刊物｜小時光書店",
    en: "Dongbeifeng｜Local Publications｜Interval Books",
    ja: "東北風｜地域の刊行物｜小時光書店",
  },
);
check(
  "活動 title 掛回自家品牌",
  seoTitle(
    { zh: "2026 台東池上秋收山海旅行 | 馥自然人文空間", en: "Chishang", ja: "池上" },
    "2026.9.5~2026.10.23",
  ).zh,
  "2026 台東池上秋收山海旅行｜2026.9.5~2026.10.23｜小時光書店",
);

console.log("\n[5] JSON-LD");
check("台北時間", toTaipeiIso("2026-12-04T03:10:00+00:00"), "2026-12-04T11:10:00+08:00");
const events = eventLd({
  name: "范毅舜公東教堂文化之旅",
  description: "d",
  url: `${O}/events/kungtung`,
  image: "/media/site-images/x.webp",
  sessions: [
    {
      location: "台東",
      startsAt: "2026-12-04T03:10:00+00:00",
      endsAt: "2026-12-06T08:13:00+00:00",
      available: true,
      plans: [
        { name: "早鳥", price: 19800, available: true },
        { name: "一般", price: 21800, available: false },
      ],
    },
    {
      location: "",
      startsAt: "2026-12-04T03:10:00+00:00",
      endsAt: null,
      available: true,
      plans: [],
    },
  ],
  basePrice: 21800,
  performer: "范毅舜",
});
check("沒有地點的場次不輸出", events.length, 1);
const ev = events[0];
for (const key of [
  "name",
  "startDate",
  "endDate",
  "eventStatus",
  "eventAttendanceMode",
  "location",
  "organizer",
  "offers",
  "image",
]) {
  checkTrue(`Event.${key}`, ev[key] !== undefined);
}
check("Event.location.address", ev.location.address, "台東");
check("Event.offers 每個票種一個", ev.offers.length, 2);
check("Offer 幣別", ev.offers[0].priceCurrency, "TWD");
check("售完的票種標 SoldOut", ev.offers[1].availability, "https://schema.org/SoldOut");
check("image 絕對網址", ev.image[0], `${O}/media/site-images/x.webp`);
check(
  "沒有場次就沒有 Event",
  eventLd({ name: "x", description: "", url: O, image: null, sessions: [], basePrice: 1 }).length,
  0,
);
const prod = productLd({
  name: "東北風",
  description: "d",
  url: `${O}/shop/pub-tw-001`,
  image: "https://x/a.jpg",
  sku: "pub-tw-001",
  price: 150,
  inStock: false,
  isBook: true,
  category: "地方刊物",
});
check("Product+Book", prod["@type"], ["Product", "Book"]);
check("Product.offers.price", prod.offers.price, 150);
check("Product 售完 OutOfStock", prod.offers.availability, "https://schema.org/OutOfStock");
const bc = breadcrumbLd([
  { name: "首頁", path: "/" },
  { name: "活動", path: "/events" },
]);
check(
  "Breadcrumb position",
  bc.itemListElement.map((i) => i.position),
  [1, 2],
);
check("Breadcrumb item 絕對網址", bc.itemListElement[1].item, `${O}/events`);
check("營業時間解析", parseOpeningHours("Mon – Sun, 11:00 – 19:00")?.opens, "11:00");
check("營業時間七天", parseOpeningHours("Mon – Sun, 11:00 – 19:00")?.dayOfWeek.length, 7);
check("認不出的營業時間不猜", parseOpeningHours("每日開放，特殊節日另行公告"), null);
const store = bookStoreLd(
  {
    site: {
      address: { zh: "華山文創園區．紅磚六合院 西7-3館", en: "", ja: "" },
      city: { zh: "台北市中正區", en: "", ja: "" },
      hours: { zh: "", en: "Mon – Sun, 11:00 – 19:00", ja: "" },
      shortDesc: { zh: "我們是在華山的小時光書店", en: "", ja: "" },
    },
    contactEmail: "a@b.c",
    phones: [{ label: "Tel", display: "+886 2 2341 6800", tel: "+886223416800" }],
    social: { instagram: "https://www.instagram.com/intervalbookstw/", facebook: "", line: "" },
    map: {
      link: "https://goo.gl/maps/x",
      apple: "https://maps.apple.com/?q=x&ll=25.0440,121.5298",
    },
    meta: { siteName: "小時光書店 Interval Books" },
  },
  "/assets/s.jpg",
  "/logo.png",
);
check(
  "BookStore 地址來自 site_settings",
  store.address.streetAddress,
  "華山文創園區．紅磚六合院 西7-3館",
);
check("BookStore 電話", store.telephone, "+886223416800");
check("BookStore geo 來自 Apple Maps ll", store.geo.latitude, 25.044);
check("BookStore 沒有郵遞區號（不編造）", store.address.postalCode, undefined);
check("空的 social 不進 sameAs", store.sameAs, ["https://www.instagram.com/intervalbookstw/"]);

console.log("\n[6] sitemap.xml");
const xml = sitemapXml([
  { path: "/", lastmod: "2026-08-08T10:01:35.955115+00:00" },
  { path: "/events/kungtung", lastmod: "2026-09-01T00:00:00Z" },
  { path: "/events/kungtung", lastmod: "2026-11-01T04:23:48Z" },
  { path: "/shop?tab=publications" },
  { path: "/events/a&b" },
]);
checkTrue(
  "XML 宣告與命名空間",
  xml.startsWith(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ),
);
check(
  "重複網址去重",
  (xml.match(/<loc>https:\/\/www\.intervalbooks\.tw\/events\/kungtung<\/loc>/g) ?? []).length,
  1,
);
checkTrue("重複時取最新 lastmod", xml.includes("<lastmod>2026-11-01T04:23:48Z</lastmod>"));
checkTrue("& 有跳脫", xml.includes("/events/a&amp;b"));
checkTrue("query 網址保留", xml.includes(`<loc>${O}/shop?tab=publications</loc>`));
check("<url> 成對", (xml.match(/<url>/g) ?? []).length, (xml.match(/<\/url>/g) ?? []).length);

console.log("\n[7] STATIC_PUBLIC_PATHS 與路由表對帳");
const tree = readFile(join(ROOT, "src/routeTree.gen.ts"));
const block = /export interface FileRoutesByFullPath \{([\s\S]*?)\n\}/.exec(tree)?.[1] ?? "";
const fullPaths = [...block.matchAll(/'([^']+)':/g)].map((m) => m[1]);
checkTrue(`路由表讀得到（${fullPaths.length} 條）`, fullPaths.length > 50);
const publicStatic = fullPaths
  .filter((p) => !p.includes("$"))
  .map((p) => (p.length > 1 ? p.replace(/\/$/, "") : p))
  .filter((p) => !/^\/(admin|vendor)\/./.test(p));
const missing = [...new Set(publicStatic)].filter((p) => !STATIC_PUBLIC_PATHS.includes(p));
check("前台固定路徑都在 STATIC_PUBLIC_PATHS", missing, []);

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
