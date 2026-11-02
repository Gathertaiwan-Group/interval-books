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
 *   - 英日文網址（2026-11 /en /ja）：<html lang>、canonical 指自己、hreflang 三語＋x-default 且
 *     互相對應、站內連結帶前綴、中文限定著陸頁的英日版 noindex、私密頁 404、轉址、Vary、
 *     sitemap 的 xhtml:link（見 checkLanguageVersions()）
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
    // 2026-11 驗收 #4：address 是 PostalAddress、至少有國別（不准只是一串字）
    need(
      n.location?.address?.["@type"] === "PostalAddress",
      "Event.location.address 是 PostalAddress",
    );
    need(n.location?.address?.addressCountry === "TW", "PostalAddress.addressCountry");
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
    len(h.title) >= 8 &&
      len(h.title) <= 70 &&
      /小時光風土誌書店|小時光 風土誌書店|Interval Books/.test(h.title),
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

  // ── 2026-11 SEO 驗收（只對有 Event 的頁）─────────────────────────────────
  const events = nodes.filter((n) => typesOf(n).includes("Event"));
  if (events.length) {
    const pairs = events.map((e) => `${e.name}\u0000${e.url}`);
    ok(
      `#1 沒有同名同網址的 Event（${events.length} 個）`,
      new Set(pairs).size === pairs.length,
      events.map((e) => e.name).join(" / "),
    );
    ok(
      "#1 每個 Event 的 @id 不同",
      new Set(events.map((e) => e["@id"])).size === events.length,
      events.map((e) => e["@id"]).join(" / "),
    );
    const body = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    // #2：最後一個場次（endDate／startDate 的台北日期）早於今天 → 已結束
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
    const lastDay = events
      .map((e) => String(e.endDate || e.startDate || "").slice(0, 10))
      .sort()
      .at(-1);
    const offers = events.flatMap((e) => [].concat(e.offers ?? []));
    if (lastDay && lastDay < today) {
      ok(
        `#2 已結束（${lastDay}）→ 每個 Offer 都是 SoldOut`,
        offers.every((o) => o.availability === "https://schema.org/SoldOut"),
        offers.map((o) => o.availability).join(","),
      );
      ok(
        "#2 已結束 → eventStatus 仍是 EventScheduled",
        events.every((e) => e.eventStatus === "https://schema.org/EventScheduled"),
      );
      ok("#2 已結束 → 頁面沒有「尚餘名額」", !body.includes("尚餘名額"));
      ok("#2 已結束 → 頁面沒有去結帳的連結", !/href="\/checkout/.test(html));
      ok("#2 已結束 → 報名按鈕改成「活動已結束」", body.includes("活動已結束"));
    }
    // #3：JSON-LD 的每個價格在頁面上看得到
    for (const price of new Set(offers.map((o) => o.price))) {
      const shown =
        price === 0
          ? /免費|免費參加|不收費/.test(body)
          : body.includes(`NT$${price.toLocaleString("en-US")}`);
      ok(`#3 JSON-LD 價格 ${price} 在頁面上看得到`, shown);
    }
  }
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
  // Vercel 會吃掉 s-maxage（不轉給瀏覽器），正式站改看第二次請求是不是 CDN HIT。
  const again = await get("/sitemap.xml");
  await again.arrayBuffer();
  ok(
    "有 CDN 快取（s-maxage 或 x-vercel-cache: HIT）",
    /s-maxage=\d+/.test(s.headers.get("cache-control") ?? "") ||
      /HIT|STALE/.test(again.headers.get("x-vercel-cache") ?? ""),
  );
  ok(
    "XML 開頭與 urlset 命名空間",
    /^<\?xml[^>]*\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"( xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml")?>/.test(
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
  // ── 多語（2026-11 /en /ja）────────────────────────────────────────────────
  const urlBlocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  const groups = urlBlocks.map((b) => ({
    loc: decode((/<loc>([^<]+)<\/loc>/.exec(b) ?? [])[1] ?? ""),
    alts: [...b.matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)"\/>/g)].map(
      (m) => [m[1], decode(m[2])],
    ),
  }));
  const locSet = new Set(locs);
  ok(
    `有英文網址（${locs.filter((l) => l.startsWith(`${ORIGIN}/en`)).length}）`,
    locs.some((l) => l.startsWith(`${ORIGIN}/en`)),
  );
  ok(
    `有日文網址（${locs.filter((l) => l.startsWith(`${ORIGIN}/ja`)).length}）`,
    locs.some((l) => l.startsWith(`${ORIGIN}/ja`)),
  );
  ok(
    "中文限定的著陸頁沒有英日文網址",
    !locs.some((l) =>
      /^https:\/\/www\.intervalbooks\.tw\/(en|ja)\/events\/(kungtung|sound-of-the-sea|city-salon-0922)(\/|$)/.test(
        l,
      ),
    ),
  );
  const multi = groups.filter((g) => g.alts.length > 0);
  ok(
    "有 xhtml:link 的每一筆都把自己列為 alternate",
    multi.every((g) => g.alts.some(([, href]) => href === g.loc)),
  );
  ok(
    "xhtml:link 的每個 alternate 都有自己的 <url>（互相對應）",
    multi.every((g) => g.alts.every(([, href]) => locSet.has(href))),
  );
  ok(
    "x-default 指向中文版",
    multi.every((g) =>
      g.alts.some(
        ([lang, href]) => lang === "x-default" && !/intervalbooks\.tw\/(en|ja)(\/|$|\?)/.test(href),
      ),
    ),
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
      ...locs.filter((l) => /\.tw\/en(\/|$|\?)/.test(l)).slice(0, 2),
      ...locs.filter((l) => /\.tw\/ja(\/|$|\?)/.test(l)).slice(0, 2),
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
  // 2026-11 驗收 #5：代稱只差大小寫 → 不分大小寫查找後 301 到資料庫裡的正確寫法
  for (const [from, to] of [
    ["/shop/PUB-TW-001", "/shop/pub-tw-001"],
    ["/events/inntervalchishang.1023", "/events/InntervalChishang.1023"],
  ]) {
    const r = await get(from);
    const loc = (r.headers.get("location") ?? "").replace(/^https?:\/\/[^/]+/, "");
    ok(`${from} → ${r.status} ${loc}`, r.status === 301 && loc === to);
    await r.arrayBuffer();
  }
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

// =============================================================================
// 英日文網址（2026-11 /en /ja，src/lib/seo/i18n.ts）
// =============================================================================

const LANG_INFO = {
  en: { html: "en", og: "en_US", ld: "en" },
  ja: { html: "ja", og: "ja_JP", ld: "ja" },
};
const PRIVATE_RE = /^\/(admin|vendor|checkout|cart|account|auth|oauth|api)(\/|$|\?)/;

function localized(path, lang) {
  if (lang === "zh") return path;
  const [p, q] = path.split("?");
  return `/${lang}${p === "/" ? "" : p}${q ? `?${q}` : ""}`;
}

function alternatesOf(html) {
  return [...html.matchAll(/<link\b[^>]*>/g)]
    .map((m) => attrsOf(m[0]))
    .filter((l) => l.rel === "alternate" && l.hreflang)
    .map((l) => [l.hreflang, l.href]);
}

/** 有翻譯的頁：三語都可收錄。 */
const LANG_PAGES = [
  "/",
  "/events",
  "/events/InntervalChishang.1023",
  "/journeys",
  "/shop",
  "/shop?tab=publications",
  "/shop/pub-tw-001",
  "/about",
  "/curation",
  "/privacy",
];

async function checkLanguageVersions() {
  console.log("\n[英日文網址]");
  const zhHtml = new Map();
  for (const path of LANG_PAGES) {
    const zh = await get(path);
    zhHtml.set(path, await zh.text());
  }
  for (const path of LANG_PAGES) {
    const zhAlts = alternatesOf(zhHtml.get(path));
    const zhHead = parseHead(zhHtml.get(path));
    const zhH1 = zhHead.h1[0] ?? "";
    const zhTitle = zhHead.title;
    for (const lang of ["en", "ja"]) {
      const lp = localized(path, lang);
      const info = LANG_INFO[lang];
      const res = await get(lp);
      const html = await res.text();
      const h = parseHead(html);
      const self = `${ORIGIN}${lp}`;
      console.log(`  ${lp}`);
      ok(`${lp} 200`, res.status === 200, `實得 ${res.status}`);
      ok(`${lp} <html lang="${info.html}">`, h.lang === info.html, h.lang);
      ok(
        `${lp} canonical 指向自己`,
        h.canonicals.length === 1 && h.canonicals[0] === self,
        h.canonicals.join(","),
      );
      ok(`${lp} og:url = canonical`, h.meta("og:url")[0] === self);
      ok(`${lp} og:locale = ${info.og}`, h.meta("og:locale")[0] === info.og);
      ok(`${lp} 沒有 noindex`, !h.meta("robots").some((v) => /noindex/.test(v)));
      // 書名、刊物名在日文常常就是同一組漢字（東北風），那種頁看 title（類別名稱會換成日文）。
      ok(
        `${lp} h1／title 是譯文（≠ 中文版）`,
        h.h1.length === 1 && (h.h1[0] !== zhH1 || h.title !== zhTitle),
        `${h.h1.join(" / ")}｜${h.title}`,
      );
      const alts = alternatesOf(html);
      const want = [
        ["zh-Hant", `${ORIGIN}${path === "/" ? "/" : path}`],
        ["en", `${ORIGIN}${localized(path, "en")}`],
        ["ja", `${ORIGIN}${localized(path, "ja")}`],
        ["x-default", `${ORIGIN}${path === "/" ? "/" : path}`],
      ];
      ok(
        `${lp} hreflang 三語＋x-default`,
        JSON.stringify([...alts].sort()) === JSON.stringify([...want].sort()),
        JSON.stringify(alts),
      );
      ok(
        `${lp} hreflang 與中文版互相對應`,
        JSON.stringify([...alts].sort()) === JSON.stringify([...zhAlts].sort()),
        JSON.stringify(zhAlts),
      );
      const nodes = [];
      for (const raw of h.ldRaw) {
        try {
          flattenLd(JSON.parse(raw), nodes);
        } catch {
          /* checkPage 已檢查 */
        }
      }
      const page = nodes.find((n) => typesOf(n).includes("WebPage"));
      ok(
        `${lp} JSON-LD WebPage inLanguage=${info.ld}`,
        page?.inLanguage === info.ld && page?.url === self,
      );
      // 站內連結：語言切換鈕（有 hreflang 屬性）以外，一律帶前綴或是私密頁
      const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => attrsOf(m[0]));
      const bad = anchors
        .filter((a) => a.href && a.href.startsWith("/") && !a.href.startsWith("//") && !a.hreflang)
        .map((a) => a.href)
        .filter((href) => !href.startsWith(`/${lang}`) && !PRIVATE_RE.test(href));
      ok(`${lp} 站內連結都帶 /${lang}`, bad.length === 0, bad.slice(0, 5).join(" "));
      const switches = anchors.filter((a) => a.hreflang).map((a) => [a.hreflang, a.href]);
      ok(
        `${lp} 語言切換鈕連到對應網址`,
        switches.some(([l, href]) => l === "zh-Hant" && href === path) &&
          switches.some(([l, href]) => l === "en" && href === localized(path, "en")) &&
          switches.some(([l, href]) => l === "ja" && href === localized(path, "ja")),
        JSON.stringify(switches.slice(0, 3)),
      );
      const vary = (res.headers.get("vary") ?? "").toLowerCase();
      ok(
        `${lp} 沒有依 cookie／Accept-Language 的 Vary`,
        !/cookie|accept-language/.test(vary),
        vary,
      );
    }
  }

  console.log("\n[中文頁不跟著瀏覽器語言變]");
  for (const al of ["en-US,en;q=0.9", "ja-JP,ja;q=0.9"]) {
    const r = await fetch(`${BASE}/events`, { headers: { "accept-language": al } });
    const h = parseHead(await r.text());
    ok(`Accept-Language: ${al} 開 /events 仍是 zh-Hant`, h.lang === "zh-Hant", h.lang);
  }

  console.log("\n[中文限定著陸頁的英日版]");
  for (const lp of [
    "/en/events/kungtung",
    "/ja/events/kungtung",
    "/en/events/sound-of-the-sea",
    "/ja/events/city-salon-0922",
    "/en/events/kungtung/hosts/alice",
  ]) {
    const r = await get(lp);
    const html = await r.text();
    const h = parseHead(html);
    ok(`${lp} 200`, r.status === 200, `實得 ${r.status}`);
    ok(
      `${lp} noindex`,
      h.meta("robots").some((v) => /noindex/.test(v)),
    );
    ok(
      `${lp} 沒有 canonical／hreflang`,
      h.canonicals.length === 0 && alternatesOf(html).length === 0,
    );
  }
  const zhOnly = parseHead(await (await get("/events/kungtung")).text());
  ok("/events/kungtung（中文）仍可收錄", !zhOnly.meta("robots").some((v) => /noindex/.test(v)));
  const zhOnlyAlts = alternatesOf(await (await get("/events/kungtung")).text());
  ok(
    "/events/kungtung 的 hreflang 不含英日文",
    !zhOnlyAlts.some(([l]) => l === "en" || l === "ja"),
    JSON.stringify(zhOnlyAlts),
  );

  console.log("\n[私密頁沒有語言前綴]");
  for (const p of ["/en/admin", "/en/admin/login", "/ja/cart", "/en/checkout", "/ja/account"]) {
    const r = await get(p);
    const h = parseHead(await r.text());
    ok(`${p} 404（${r.status}）`, r.status === 404);
    ok(
      `${p} noindex`,
      h.meta("robots").some((v) => /noindex/.test(v)),
    );
  }

  console.log("\n[英日文的轉址]");
  for (const [from, status, to] of [
    ["/en/", [308], "/en"],
    ["/en/events/", [308], "/en/events"],
    ["/EN/Events", [301], "/en/events"],
    ["/Ja/Shop/pub-tw-001", [301], "/ja/shop/pub-tw-001"],
    ["/en/news", [301], "/en"],
    ["/ja/news/whatever", [301], "/ja"],
    ["/en/visit", [301], "/en/about"],
    ["/en/events/inntervalchishang.1023", [301], "/en/events/InntervalChishang.1023"],
    ["/ja/shop/PUB-TW-001", [301], "/ja/shop/pub-tw-001"],
  ]) {
    const r = await get(from);
    const loc = (r.headers.get("location") ?? "").replace(/^https?:\/\/[^/]+/, "");
    ok(`${from} → ${r.status} ${loc}`, status.includes(r.status) && loc === to);
    await r.arrayBuffer();
  }
}

console.log(`→ SEO_BASE = ${BASE}`);
await checkRobotsAndSitemap();
for (const page of PAGES) await checkPage(page);
await checkRedirectsAndNoindex();
await checkLanguageVersions();

console.log(`\n${"─".repeat(52)}`);
console.log(`check-seo: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
