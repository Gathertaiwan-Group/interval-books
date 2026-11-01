#!/usr/bin/env node
/**
 * check-seo.mjs —— 對「真的跑起來的站」抓 SSR 原始 HTML，檢查 SEO 必要元素（2026-11 SEO 健檢 L8）。
 *
 * check:meta 只靜態解析 useDocumentMeta() 的字面值，看不到 SSR 實際輸出的東西。這支補上：
 *   - 每個抽查路由：200、<html lang="zh-Hant">、唯一一個 canonical（絕對網址、等於預期）、
 *     og:url = canonical、og:image 是絕對網址且抓得到（200）、title／description 長度、
 *     JSON-LD 每一塊都是合法 JSON，且 Google 複合式搜尋結果的必要欄位都在
 *   - robots.txt 有 Sitemap 一行、擋後台；sitemap.xml 是合法 XML，抽查網址都回 200
 *   - 轉址：尾斜線 308／301、/EVENTS 301 到 /events；?utm_source 的 canonical 是乾淨網址
 *   - noindex：/admin/login 有 robots noindex 與 X-Robots-Tag；404 頁回 404 且 noindex
 *
 * 用法：
 *   node scripts/check-seo.mjs                          # 預設打 https://www.intervalbooks.tw
 *   SEO_BASE=http://localhost:5173 node scripts/check-seo.mjs   # 本機 dev／preview
 *
 * canonical 一律是正式網址（https://www.intervalbooks.tw），與 SEO_BASE 無關——本機檢查時
 * 拿的是「這一頁說它的正式網址是什麼」。og:image 的可達性檢查會把正式網域換成 SEO_BASE
 * （新部署的圖要在部署後才存在於正式網域）。
 *
 * 需要網路，所以不進 npm test（CI 不連外）；部署後跑 `npm run check:seo`。
 */
const BASE = (process.env.SEO_BASE || "https://www.intervalbooks.tw").replace(/\/$/, "");
const ORIGIN = "https://www.intervalbooks.tw";

let pass = 0;
let fail = 0;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`));
  }
}

const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) out[m[1].toLowerCase()] = decode(m[2]);
  return out;
}

function parseHead(html) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/g)].map((m) => attrsOf(m[0]));
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => attrsOf(m[0]));
  const meta = (key) =>
    metas.filter((m) => m.name === key || m.property === key).map((m) => m.content);
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/.exec(html) ?? [])[1] ?? "");
  const lang = (/<html[^>]*\slang="([^"]*)"/.exec(html) ?? [])[1] ?? "";
  const canonicals = links.filter((l) => l.rel === "canonical").map((l) => l.href);
  const ldRaw = [
    ...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]);
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((m) =>
    decode(m[1].replace(/<[^>]+>/g, "")).trim(),
  );
  return { meta, title, lang, canonicals, ldRaw, h1 };
}

const len = (s) => Array.from(s ?? "").length;

/** JSON-LD 物件攤平（@graph、陣列）。 */
function flattenLd(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => flattenLd(n, out));
  else if (node && typeof node === "object") {
    if (Array.isArray(node["@graph"])) flattenLd(node["@graph"], out);
    else out.push(node);
  }
  return out;
}
const typesOf = (n) => (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]]);

/** Google 複合式搜尋結果的必要欄位（developers.google.com/search/docs/appearance/structured-data）。 */
function requiredFieldProblems(n) {
  const t = typesOf(n);
  const problems = [];
  const need = (cond, what) => {
    if (!cond) problems.push(what);
  };
  if (t.includes("Event")) {
    need(n.name, "Event.name");
    need(/T\d{2}:\d{2}.*[+-]\d{2}:\d{2}$/.test(n.startDate ?? ""), "Event.startDate（含時區）");
    need(n.location?.name || n.location?.address, "Event.location");
    need(n.location?.address, "Event.location.address");
    need(n.eventStatus, "Event.eventStatus");
    need(n.eventAttendanceMode, "Event.eventAttendanceMode");
    need(n.organizer?.name, "Event.organizer");
    const offers = [].concat(n.offers ?? []);
    need(offers.length > 0, "Event.offers");
    for (const o of offers) {
      need(typeof o.price === "number", "Offer.price");
      need(o.priceCurrency === "TWD", "Offer.priceCurrency");
      need(/schema\.org\//.test(o.availability ?? ""), "Offer.availability");
    }
  }
  if (t.includes("Product")) {
    need(n.name, "Product.name");
    need(n.offers, "Product.offers");
    need(typeof n.offers?.price === "number", "Product.offers.price");
    need(n.offers?.priceCurrency === "TWD", "Product.offers.priceCurrency");
    need(/schema\.org\//.test(n.offers?.availability ?? ""), "Product.offers.availability");
    need(Array.isArray(n.image) && n.image.length, "Product.image");
  }
  if (t.includes("BreadcrumbList")) {
    const items = n.itemListElement ?? [];
    need(items.length >= 2, "BreadcrumbList 至少兩層");
    items.forEach((it, i) => {
      need(it.position === i + 1, `ListItem[${i}].position`);
      need(it.name, `ListItem[${i}].name`);
      need(/^https:\/\//.test(it.item ?? ""), `ListItem[${i}].item 絕對網址`);
    });
  }
  if (t.includes("BookStore")) {
    need(n.name, "BookStore.name");
    need(n.address?.streetAddress, "BookStore.address");
    need(n.telephone, "BookStore.telephone");
    need(n.openingHoursSpecification, "BookStore.openingHoursSpecification");
  }
  if (t.includes("Organization")) {
    need(n.name && n.url, "Organization.name/url");
    need(/^https:\/\//.test(n.logo ?? ""), "Organization.logo 絕對網址");
  }
  return problems;
}

async function get(path, init = {}) {
  return fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
      "accept-language": "en-US",
    },
    ...init,
  });
}

const imageChecked = new Map();
async function imageOk(url) {
  const local = url.startsWith(ORIGIN) ? `${BASE}${url.slice(ORIGIN.length)}` : url;
  if (!imageChecked.has(local)) {
    imageChecked.set(
      local,
      fetch(local, { method: "GET" })
        .then(async (r) => {
          await r.arrayBuffer();
          return r.status;
        })
        .catch(() => 0),
    );
  }
  return imageChecked.get(local);
}

/** 抽查的頁面：路徑、預期 canonical、必須出現的 JSON-LD 類型。 */
const PAGES = [
  { path: "/", canonical: `${ORIGIN}/`, ld: ["Organization", "BookStore", "WebSite"] },
  { path: "/events", canonical: `${ORIGIN}/events`, ld: ["Organization"] },
  {
    path: "/events/yokky-flow-0905",
    canonical: `${ORIGIN}/events/yokky-flow-0905`,
    ld: ["Event", "BreadcrumbList"],
  },
  {
    path: "/events/InntervalChishang.1023",
    canonical: `${ORIGIN}/events/InntervalChishang.1023`,
    ld: ["Event", "BreadcrumbList"],
  },
  {
    path: "/events/kungtung",
    canonical: `${ORIGIN}/events/kungtung`,
    ld: ["Event", "BreadcrumbList"],
  },
  {
    path: "/events/sound-of-the-sea",
    canonical: `${ORIGIN}/events/sound-of-the-sea`,
    ld: ["Event", "BreadcrumbList"],
  },
  {
    path: "/events/city-salon-0922",
    canonical: `${ORIGIN}/events/city-salon-0922`,
    ld: ["Event", "BreadcrumbList"],
  },
  {
    path: "/events/kungtung/hosts/alice",
    canonical: `${ORIGIN}/events/kungtung/hosts/alice`,
    ld: ["BreadcrumbList"],
  },
  { path: "/journeys", canonical: `${ORIGIN}/journeys`, ld: ["Organization"] },
  { path: "/shop", canonical: `${ORIGIN}/shop`, ld: ["Organization"] },
  {
    path: "/shop?tab=publications",
    canonical: `${ORIGIN}/shop?tab=publications`,
    ld: ["Organization"],
  },
  { path: "/shop?tab=curated", canonical: `${ORIGIN}/shop?tab=curated`, ld: ["Organization"] },
  {
    path: "/shop/pub-tw-001",
    canonical: `${ORIGIN}/shop/pub-tw-001`,
    ld: ["Product", "BreadcrumbList"],
  },
  { path: "/about", canonical: `${ORIGIN}/about`, ld: ["BookStore"] },
  { path: "/partnership", canonical: `${ORIGIN}/partnership`, ld: ["Organization"] },
  { path: "/curation", canonical: `${ORIGIN}/curation`, ld: ["Organization"] },
  { path: "/privacy", canonical: `${ORIGIN}/privacy`, ld: ["Organization"] },
];

const titlesSeen = new Map();

async function checkPage({ path, canonical, ld }) {
  console.log(`\n[page] ${path}`);
  const res = await get(path);
  ok("200", res.status === 200, `實得 ${res.status}`);
  const html = await res.text();
  const h = parseHead(html);
  ok('<html lang="zh-Hant">', h.lang === "zh-Hant", h.lang);
  ok("剛好一個 canonical", h.canonicals.length === 1, JSON.stringify(h.canonicals));
  ok("canonical 等於預期", h.canonicals[0] === canonical, h.canonicals[0]);
  ok("og:url = canonical", h.meta("og:url")[0] === canonical, h.meta("og:url")[0]);
  ok("og:locale = zh_TW", h.meta("og:locale")[0] === "zh_TW");
  ok("沒有 noindex", !h.meta("robots").some((v) => /noindex/.test(v)));
  ok(
    `title 長度合理（${len(h.title)} 字）且有品牌`,
    len(h.title) >= 8 && len(h.title) <= 70 && /小時光書店|Interval Books/.test(h.title),
    h.title,
  );
  const desc = h.meta("description")[0] ?? "";
  ok(
    `description 長度 70–160（${len(desc)} 字）、沒有佔位符`,
    len(desc) >= 70 && len(desc) <= 160 && !/＿|_{3,}/.test(desc),
    desc,
  );
  ok("description 只有一個", h.meta("description").length === 1);
  const prev = titlesSeen.get(h.title);
  ok("title 沒有跟別的抽查頁重複", !prev, prev ? `與 ${prev} 相同` : "");
  titlesSeen.set(h.title, path);
  const ogImage = h.meta("og:image")[0] ?? "";
  ok("og:image 是絕對網址", /^https:\/\/[^/]+\//.test(ogImage), ogImage);
  if (ogImage) {
    const status = await imageOk(ogImage);
    ok(`og:image 抓得到（${status}）`, status === 200, ogImage);
  }
  ok("twitter:image 有輸出", h.meta("twitter:image").length === 1);
  ok("有 JSON-LD", h.ldRaw.length > 0);
  const nodes = [];
  for (const raw of h.ldRaw) {
    try {
      flattenLd(JSON.parse(raw), nodes);
      ok("JSON-LD 是合法 JSON", true);
    } catch (e) {
      ok("JSON-LD 是合法 JSON", false, String(e));
    }
  }
  const types = new Set(nodes.flatMap(typesOf));
  for (const t of ld) ok(`JSON-LD 有 ${t}`, types.has(t), [...types].join(","));
  for (const n of nodes) {
    const problems = requiredFieldProblems(n);
    ok(`${typesOf(n).join("+")} 必要欄位齊全`, problems.length === 0, problems.join("、"));
  }
  ok("剛好一個 h1", h.h1.length === 1, JSON.stringify(h.h1));
}

async function checkRobotsAndSitemap() {
  console.log("\n[robots.txt]");
  const r = await get("/robots.txt");
  const text = await r.text();
  ok("200 text/plain", r.status === 200 && /text\/plain/.test(r.headers.get("content-type") ?? ""));
  ok("宣告 Sitemap", text.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
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
    ok(`Disallow: ${p}`, text.split("\n").includes(`Disallow: ${p}`));
  }

  console.log("\n[sitemap.xml]");
  const s = await get("/sitemap.xml");
  const xml = await s.text();
  ok("200 application/xml", s.status === 200 && /xml/.test(s.headers.get("content-type") ?? ""));
  ok("有 s-maxage 快取", /s-maxage=\d+/.test(s.headers.get("cache-control") ?? ""));
  ok(
    "XML 開頭與 urlset 命名空間",
    /^<\?xml[^>]*\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(
      xml,
    ),
  );
  ok("標籤成對", (xml.match(/<url>/g) ?? []).length === (xml.match(/<\/url>/g) ?? []).length);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]));
  ok(`網址數量合理（${locs.length}）`, locs.length >= 20 && locs.length < 5000);
  ok(
    "全部是 https://www. 絕對網址",
    locs.every((l) => l.startsWith(`${ORIGIN}/`)),
  );
  ok("沒有重複", new Set(locs).size === locs.length);
  ok(
    "沒有後台／結帳網址",
    !locs.some((l) => /\/(admin|vendor|checkout|cart|account)(\/|$)/.test(l)),
  );
  const lastmods = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
  ok(
    "lastmod 是 W3C 時間",
    lastmods.length > 0 && lastmods.every((d) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(d)),
  );
  // 抽查：固定 5 個 + 隨機 5 個
  const sample = [
    ...new Set([
      locs[0],
      locs[1],
      ...locs.filter((l) => /\/events\//.test(l)).slice(0, 2),
      ...locs.filter((l) => /\/shop\//.test(l)).slice(0, 1),
      ...locs.sort(() => Math.random() - 0.5).slice(0, 5),
    ]),
  ];
  for (const loc of sample) {
    const res = await get(loc.slice(ORIGIN.length));
    ok(`sitemap 抽查 ${loc} → ${res.status}`, res.status === 200);
    await res.arrayBuffer();
  }
}

async function checkRedirectsAndNoindex() {
  console.log("\n[轉址]");
  const slash = await get("/events/");
  ok(
    `/events/ → ${slash.status} ${slash.headers.get("location")}`,
    [301, 308].includes(slash.status) && slash.headers.get("location") === "/events",
  );
  const slash2 = await get("/shop/pub-tw-001/");
  ok(
    `/shop/pub-tw-001/ → ${slash2.status}`,
    [301, 308].includes(slash2.status) && slash2.headers.get("location") === "/shop/pub-tw-001",
  );
  const upper = await get("/EVENTS");
  ok(
    `/EVENTS → ${upper.status} ${upper.headers.get("location")}`,
    upper.status === 301 && upper.headers.get("location") === "/events",
  );
  const upper2 = await get("/Shop/pub-tw-001");
  ok(
    `/Shop/pub-tw-001 → ${upper2.status}`,
    upper2.status === 301 && upper2.headers.get("location") === "/shop/pub-tw-001",
  );
  const slug = await get("/events/InntervalChishang.1023");
  ok("大小寫敏感的活動代稱不被轉址（200）", slug.status === 200);
  await slug.arrayBuffer();

  console.log("\n[追蹤參數]");
  for (const [path, want] of [
    ["/?utm_source=x&fbclid=abc", `${ORIGIN}/`],
    ["/events/kungtung?ref=abc", `${ORIGIN}/events/kungtung`],
    ["/shop?tab=products&utm_medium=y", `${ORIGIN}/shop`],
  ]) {
    const res = await get(path);
    const h = parseHead(await res.text());
    ok(`${path} 的 canonical = ${want}`, h.canonicals[0] === want, h.canonicals[0]);
  }

  console.log("\n[noindex]");
  const admin = await get("/admin/login");
  const ah = parseHead(await admin.text());
  ok(
    "/admin/login 有 robots noindex",
    ah.meta("robots").some((v) => /noindex/.test(v)),
  );
  ok("/admin/login 有 X-Robots-Tag", /noindex/.test(admin.headers.get("x-robots-tag") ?? ""));
  ok("/admin/login 沒有 canonical", ah.canonicals.length === 0);
  ok(
    "/admin/login 不載 GA",
    !/googletagmanager\.com\/gtag/.test(await (await get("/admin/login")).text()),
  );
  const vendor = await get("/vendor/login");
  ok("/vendor/login 有 X-Robots-Tag", /noindex/.test(vendor.headers.get("x-robots-tag") ?? ""));
  ok(
    "/vendor/login 有 robots noindex",
    parseHead(await vendor.text())
      .meta("robots")
      .some((v) => /noindex/.test(v)),
  );
  const cart = await get("/cart");
  ok("/cart 有 X-Robots-Tag", /noindex/.test(cart.headers.get("x-robots-tag") ?? ""));
  await cart.arrayBuffer();
  for (const p of [
    "/totally-missing-page-xyz",
    "/events/this-does-not-exist-xyz",
    "/shop/no-such-product-xyz",
  ]) {
    const nf = await get(p);
    const nh = parseHead(await nf.text());
    ok(`${p} 回 404（${nf.status}）`, nf.status === 404);
    ok(
      `${p} 有 noindex`,
      nh.meta("robots").some((v) => /noindex/.test(v)),
    );
    ok(`${p} 有自己的 title`, /找不到頁面/.test(nh.title), nh.title);
    ok(`${p} 有 h1`, nh.h1.length === 1);
  }

  console.log("\n[GA4／Search Console]");
  const home = await (await get("/")).text();
  ok(
    "首頁有 google-site-verification",
    /<meta name="google-site-verification" content="ycX_QzdBy7UXIJv2CR8tLcnIayB_5mPp98DuxLjI89M"\/?>/.test(
      home,
    ),
  );
  ok(
    "首頁有 gtag.js",
    /<script[^>]+src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]+"/.test(home),
  );
  ok("gtag config 關掉自動 page_view", /send_page_view:false/.test(home));
}

console.log(`→ SEO_BASE = ${BASE}`);
await checkRobotsAndSitemap();
for (const page of PAGES) await checkPage(page);
await checkRedirectsAndNoindex();

console.log(`\n${"─".repeat(52)}`);
console.log(`check-seo: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
