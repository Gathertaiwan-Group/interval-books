#!/usr/bin/env node
/**
 * i18n-url-selftest.mjs —— 英日文網址前綴（/en、/ja，2026-11）的行為測試。
 *
 * 直接 import 真的程式碼（src/lib/seo/i18n.ts、core.ts、sitemap-entries.ts、src/lib/i18n-rewrite.ts），
 * 並用真的 @tanstack/react-router 建 router 驗 rewrite。SSR 實際輸出由 scripts/check-seo.mjs 檢查。
 *
 * 守的東西：
 *   [1] 前綴拆解：/en/events → /events；/en/admin 不拆（→ 404）；大寫前綴不認
 *   [2] localizeHref／switchLangHref：私密頁不加前綴、不加第二層、保留 query／hash
 *   [3] canonical、轉址、noindex：/EN/Events 301、/en/ 308、/en/admin noindex
 *   [4] 🔴 noindex 規則（isLangIndexable）：標題沒翻譯、本文全部沒翻譯、中文限定頁 → 不可收錄
 *   [5] sitemap：每個語言一筆 <url>＋xhtml:link 互相對應、不可收錄的語言不出現
 *   [6] buildSitemapEntries：活動／商品依翻譯判斷、策旅卡片沿用活動頁的語言
 *   [7] router rewrite：輸入輸出可逆（SSR 不會多一次轉址）、站內連結帶前綴、私密頁不帶
 *   [8] 靜態守門：公開頁都用 pageHead()、root 不再輸出 canonical、LanguageProvider 不讀 navigator
 *
 * 執行：node scripts/i18n-url-selftest.mjs（或 npm test）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/i18n-url-selftest.mjs";

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
    console.log(
      red(
        `  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`,
      ),
    );
  }
}
const checkTrue = (label, v) => check(label, v === true, true);
const readFile = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${rel}`);
  return readFileSync(p, "utf8");
};

const i18n = await import(pathToFileURL(join(ROOT, "src/lib/seo/i18n.ts")).href);
const core = await import(pathToFileURL(join(ROOT, "src/lib/seo/core.ts")).href);
const { buildSitemapEntries } = await import(
  pathToFileURL(join(ROOT, "src/lib/seo/sitemap-entries.ts")).href
);
const { createLangRewrite } = await import(
  pathToFileURL(join(ROOT, "src/lib/i18n-rewrite.ts")).href
);

const L = (zh, en, ja) => ({ zh, en, ja });

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] 前綴拆解");
check("/en/events", i18n.splitLangPrefix("/en/events"), {
  lang: "en",
  rest: "/events",
  prefixed: true,
});
check("/ja", i18n.splitLangPrefix("/ja"), { lang: "ja", rest: "/", prefixed: true });
check("/events（中文）", i18n.splitLangPrefix("/events"), {
  lang: "zh",
  rest: "/events",
  prefixed: false,
});
check("/en/admin 不拆", i18n.splitLangPrefix("/en/admin"), {
  lang: "zh",
  rest: "/en/admin",
  prefixed: false,
});
check("/ja/cart 不拆", i18n.splitLangPrefix("/ja/cart").prefixed, false);
check(
  "/EN/events 不認（大寫由 redirectFor 先 301）",
  i18n.splitLangPrefix("/EN/events").prefixed,
  false,
);
check("/english 不是前綴", i18n.splitLangPrefix("/english").prefixed, false);
check("/events/en 不是前綴", i18n.splitLangPrefix("/events/en").prefixed, false);
check("publicLangOf /ja/shop/x", i18n.publicLangOf("/ja/shop/x"), "ja");
check("publicLangOf /about", i18n.publicLangOf("/about"), "zh");
check("publicLangOf /checkout → null（私密頁）", i18n.publicLangOf("/checkout"), null);
check("publicLangOf /Admin → null", i18n.publicLangOf("/Admin"), null);
for (const p of [
  "/admin",
  "/vendor/x",
  "/checkout/complete",
  "/cart",
  "/account/login",
  "/auth/confirm",
  "/oauth/authorize",
  "/api/mcp",
  "/_serverFn/x",
  "/media/site-images/a.jpg",
  "/sitemap.xml",
  "/robots.txt",
]) {
  check(`${p} 不可加前綴`, i18n.isLocalizablePath(p), false);
}
for (const p of [
  "/",
  "/events",
  "/events/InntervalChishang.1023",
  "/shop/pub-tw-001",
  "/about",
  "/partnership",
  "/news",
]) {
  check(`${p} 可加前綴`, i18n.isLocalizablePath(p), true);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] localizeHref／switchLangHref");
check("首頁 → /en", i18n.localizeHref("/", "en"), "/en");
check("首頁帶 query → /en?x=1", i18n.localizeHref("/?x=1", "en"), "/en?x=1");
check(
  "/shop?tab=publications → /ja/shop?tab=publications",
  i18n.localizeHref("/shop?tab=publications", "ja"),
  "/ja/shop?tab=publications",
);
check(
  "hash 保留",
  i18n.localizeHref("/events/kungtung#register", "en"),
  "/en/events/kungtung#register",
);
check("中文 → 原樣", i18n.localizeHref("/events", "zh"), "/events");
check("私密頁不加", i18n.localizeHref("/checkout?product=x", "en"), "/checkout?product=x");
check("不加第二層", i18n.localizeHref("/en/events", "ja"), "/en/events");
check("/en/admin 不再加", i18n.localizeHref("/en/admin", "en"), "/en/admin");
check("外部網址不動", i18n.localizeHref("https://example.com/x", "en"), "https://example.com/x");
check("// 開頭不動", i18n.localizeHref("//evil.com/x", "en"), "//evil.com/x");
check("switch /en/events → zh", i18n.switchLangHref("/en/events", "zh"), "/events");
check("switch /en → ja", i18n.switchLangHref("/en", "ja"), "/ja");
check(
  "switch /shop?tab=curated → en",
  i18n.switchLangHref("/shop?tab=curated", "en"),
  "/en/shop?tab=curated",
);
check("switch /ja/events/x → en", i18n.switchLangHref("/ja/events/x", "en"), "/en/events/x");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] canonical／轉址／noindex");
check("canonicalPathname /EN/Events", core.canonicalPathname("/EN/Events"), "/en/events");
check("canonicalPathname /en/", core.canonicalPathname("/en/"), "/en");
check(
  "canonicalPathname /Ja/Shop/PUB-1（代稱大小寫保留）",
  core.canonicalPathname("/Ja/Shop/PUB-1"),
  "/ja/shop/PUB-1",
);
check("canonicalPathname /en/Admin 不動大小寫", core.canonicalPathname("/en/Admin"), "/en/Admin");
check("redirect /en/ → 308 /en", core.redirectFor("/en/", "", "GET"), {
  status: 308,
  location: "/en",
});
check("redirect /EN → 301 /en", core.redirectFor("/EN", "", "GET"), {
  status: 301,
  location: "/en",
});
check("redirect /En/Events/?x=1 → 301", core.redirectFor("/En/Events/", "?x=1", "GET"), {
  status: 301,
  location: "/en/events?x=1",
});
check("/en/events 不轉", core.redirectFor("/en/events", "", "GET"), null);
check("/events 不轉（中文原樣）", core.redirectFor("/events", "", "GET"), null);
check("canonicalUrl 中文不變", core.canonicalUrl("/events"), "https://www.intervalbooks.tw/events");
check("canonicalUrl 首頁中文不變", core.canonicalUrl("/"), "https://www.intervalbooks.tw/");
check(
  "canonicalUrl en",
  core.canonicalUrl("/events", undefined, "en"),
  "https://www.intervalbooks.tw/en/events",
);
check(
  "canonicalUrl en 首頁",
  core.canonicalUrl("/", undefined, "en"),
  "https://www.intervalbooks.tw/en",
);
check(
  "canonicalUrl ja /shop?tab=curated",
  core.canonicalUrl("/shop", { tab: "curated" }, "ja"),
  "https://www.intervalbooks.tw/ja/shop?tab=curated",
);
check(
  "canonicalUrl en 去追蹤參數",
  core.canonicalUrl("/events", { utm_source: "x" }, "en"),
  "https://www.intervalbooks.tw/en/events",
);
check("isNoindexPath /en/admin", core.isNoindexPath("/en/admin"), true);
check("isNoindexPath /ja/cart", core.isNoindexPath("/ja/cart"), true);
check("isNoindexPath /en/events", core.isNoindexPath("/en/events"), false);
check("isNoindexPath /en", core.isNoindexPath("/en"), false);
check(
  "alternateUrls 三語＋x-default",
  core.alternateUrls("/about", undefined, ["zh", "en", "ja"]),
  [
    { lang: "zh", href: "https://www.intervalbooks.tw/about" },
    { lang: "en", href: "https://www.intervalbooks.tw/en/about" },
    { lang: "ja", href: "https://www.intervalbooks.tw/ja/about" },
    { lang: "x-default", href: "https://www.intervalbooks.tw/about" },
  ],
);
check(
  "alternateUrls 只有中文可收錄 → 不列英日",
  core.alternateUrls("/events/kungtung", undefined, ["zh"]),
  [
    { lang: "zh", href: "https://www.intervalbooks.tw/events/kungtung" },
    { lang: "x-default", href: "https://www.intervalbooks.tw/events/kungtung" },
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] 🔴 noindex 規則");
check("英文空的 → 沒翻譯", i18n.isTextTranslated("en", "中文", ""), false);
check(
  "英文欄位貼中文 → 沒翻譯",
  i18n.isTextTranslated("en", "十月的池上", "十月的池上，一年最慢的季節"),
  false,
);
check(
  "英文夾少量漢字（人名）→ 有翻譯",
  i18n.isTextTranslated("en", "范毅舜", "A journey with Fan Yi-shun (范毅舜) to Kung Tung"),
  true,
);
check("日文短書名同漢字 → 有翻譯", i18n.isTextTranslated("ja", "東北風", "東北風"), true);
check(
  "日文長文一字不差 → 沒翻譯",
  i18n.isTextTranslated(
    "ja",
    "這是一段超過十五個字的中文介紹文字內容",
    "這是一段超過十五個字的中文介紹文字內容",
  ),
  false,
);
check("日文有翻 → 有翻譯", i18n.isTextTranslated("ja", "活動介紹", "イベント紹介"), true);
check("中文永遠算有", i18n.isTextTranslated("zh", "", ""), true);
check(
  "清單欄位（陣列）",
  i18n.fieldTranslated("en", { zh: ["一", "二"], en: ["one", "two"], ja: [] }),
  true,
);
check("中文沒內容的欄位不列入", i18n.fieldTranslated("en", L("", "", "")), null);

const full = {
  title: L("標題", "Title", "タイトル"),
  body: [L("摘要", "Summary", "要約"), L("內文", "Body", "本文")],
};
check("全部翻好 → en 可收錄", i18n.isLangIndexable("en", full), true);
check("中文永遠可收錄", i18n.isLangIndexable("zh", { title: L("標題", "", ""), body: [] }), true);
check(
  "標題沒翻 → noindex",
  i18n.isLangIndexable("en", { ...full, title: L("標題", "", "タイトル") }),
  false,
);
check(
  "本文全部沒翻 → noindex",
  i18n.isLangIndexable("ja", {
    title: full.title,
    body: [L("摘要", "Summary", ""), L("內文", "Body", "")],
  }),
  false,
);
check(
  "本文缺一欄（另一欄有翻）→ 仍可收錄（缺的顯示中文）",
  i18n.isLangIndexable("ja", {
    title: full.title,
    body: [L("摘要", "Summary", ""), L("內文", "Body", "本文")],
  }),
  true,
);
check(
  "只有標題的頁（本文都沒中文）→ 看標題",
  i18n.isLangIndexable("en", { title: full.title, body: [L("", "", "")] }),
  true,
);
check('"full" → 可收錄', i18n.isLangIndexable("ja", "full"), true);
check('"zh-only" → noindex', i18n.isLangIndexable("en", "zh-only"), false);
check('"zh-only" 中文 → 可收錄', i18n.isLangIndexable("zh", "zh-only"), true);
check("indexableLangs 缺日文", i18n.indexableLangs({ title: L("標題", "Title", ""), body: [] }), [
  "zh",
  "en",
]);
check(
  "ZH_ONLY_PATHS 含 kungtung 與主理人頁",
  [
    "/events/kungtung",
    "/events/kungtung/hosts/alice",
    "/events/sound-of-the-sea",
    "/events/city-salon-0922",
  ].every(i18n.isZhOnlyPath),
  true,
);
check("一般活動不是中文限定", i18n.isZhOnlyPath("/events/InntervalChishang.1023"), false);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] sitemap：每語一筆＋xhtml:link");
const xml = core.sitemapXml([
  { path: "/", lastmod: "2026-11-01T00:00:00Z", langs: ["zh", "en", "ja"] },
  { path: "/events/kungtung", langs: ["zh"] },
  { path: "/events/kungtung", langs: ["zh", "en", "ja"] },
  { path: "/shop?tab=publications", langs: ["zh", "en", "ja"] },
  { path: "/shop/x", langs: ["zh", "en"] },
  { path: "/legacy" },
]);
const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
checkTrue("有 xhtml 命名空間", xml.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"'));
check("網址清單", locs, [
  "https://www.intervalbooks.tw/",
  "https://www.intervalbooks.tw/en",
  "https://www.intervalbooks.tw/ja",
  "https://www.intervalbooks.tw/events/kungtung",
  "https://www.intervalbooks.tw/shop?tab=publications",
  "https://www.intervalbooks.tw/en/shop?tab=publications",
  "https://www.intervalbooks.tw/ja/shop?tab=publications",
  "https://www.intervalbooks.tw/shop/x",
  "https://www.intervalbooks.tw/en/shop/x",
  "https://www.intervalbooks.tw/legacy",
]);
const blocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
const altsOf = (b) =>
  [...b.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
check("/en 那筆列出三語＋x-default", altsOf(blocks[1]), [
  "zh-Hant https://www.intervalbooks.tw/",
  "en https://www.intervalbooks.tw/en",
  "ja https://www.intervalbooks.tw/ja",
  "x-default https://www.intervalbooks.tw/",
]);
check(
  "三語各筆的 alternate 一模一樣（互相對應）",
  altsOf(blocks[0]).join("|") === altsOf(blocks[2]).join("|"),
  true,
);
check("lastmod 三語都帶", (xml.match(/<lastmod>2026-11-01T00:00:00Z<\/lastmod>/g) ?? []).length, 3);
check("重複的網址取語言交集（kungtung 只剩中文、沒有 alternate）", altsOf(blocks[3]), []);
check(
  "缺日文的商品：沒有 ja、alternate 不列 ja",
  altsOf(blocks[8]).some((a) => a.startsWith("ja ")),
  false,
);
check("query 的 & 有跳脫", xml.includes("/shop?tab=publications</loc>"), true);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6] buildSitemapEntries 依翻譯判斷");
const entries = buildSitemapEntries(
  {
    pages: [
      {
        slug: "index",
        updatedAt: null,
        content: { title: L("首頁", "Home", "ホーム"), body: [L("介紹", "Intro", "紹介")] },
      },
      {
        slug: "about",
        updatedAt: null,
        content: { title: L("關於", "", ""), body: [L("介紹", "", "")] },
      },
    ],
    pageParts: [{ pageSlug: "about", updatedAt: null, value: L("區塊", "Block", "") }],
    events: [
      {
        slug: "ok",
        isoDate: null,
        updatedAt: null,
        booking: null,
        content: { title: L("活動", "Event", "イベント"), body: [L("摘要", "Sum", "要約")] },
      },
      {
        slug: "zh",
        isoDate: null,
        updatedAt: null,
        booking: null,
        content: { title: L("活動", "", ""), body: [L("摘要", "", "")] },
      },
      {
        slug: "kungtung",
        isoDate: null,
        updatedAt: null,
        booking: null,
        content: { title: L("公東", "Kung Tung", "公東"), body: [L("摘要", "Sum", "要約")] },
      },
    ],
    products: [
      {
        slug: "p1",
        productType: "book",
        updatedAt: null,
        content: { title: L("書", "Book", "本"), body: [L("介紹", "Intro", "")] },
      },
    ],
    journeys: [
      { externalUrl: "/events/ok", updatedAt: null },
      { externalUrl: "/events/kungtung#x", updatedAt: null },
    ],
    publicationsLatest: null,
    curatedLatest: null,
  },
  "2026-11-01",
);
const langsAt = (path) => entries.filter((e) => e.path === path).map((e) => e.langs);
check("首頁三語", langsAt("/")[0], ["zh", "en", "ja"]);
check("/about：英文靠區塊有翻 → en 可、ja 不可… 但標題沒翻 → 只剩中文", langsAt("/about")[0], [
  "zh",
]);
check("活動有翻譯 → 三語", langsAt("/events/ok")[0], ["zh", "en", "ja"]);
check("活動沒翻譯 → 只有中文", langsAt("/events/zh")[0], ["zh"]);
check("kungtung（中文限定）→ 只有中文", langsAt("/events/kungtung")[0], ["zh"]);
check("策旅卡片沿用活動頁的語言", langsAt("/events/ok")[1], ["zh", "en", "ja"]);
check("主理人子頁只有中文", langsAt("/events/kungtung/hosts/alice")[0], ["zh"]);
check("商品：日文本文空、標題有翻 → 不可（本文全缺）", langsAt("/shop/p1")[0], ["zh", "en"]);
check("沒給翻譯資料的頁（/journeys）→ 三語", langsAt("/journeys")[0], ["zh", "en", "ja"]);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[7] router rewrite（真的 @tanstack/react-router）");
const { createRouter, createRootRoute, createRoute } = await import("@tanstack/react-router");
const { createMemoryHistory } = await import("@tanstack/history");
const root = createRootRoute({});
const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: "/" }),
  createRoute({ getParentRoute: () => root, path: "/events" }),
  createRoute({ getParentRoute: () => root, path: "/events/$slug" }),
  createRoute({ getParentRoute: () => root, path: "/shop" }),
  createRoute({ getParentRoute: () => root, path: "/cart" }),
  createRoute({ getParentRoute: () => root, path: "/admin" }),
]);
function routerAt(href) {
  const r = createLangRewrite();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [href] }),
    rewrite: r.rewrite,
  });
  r.normalizePublicHref(router);
  return { router, state: r.state };
}
/** SSR 的 loadServerRoute 與 Transitioner 做的同一個比對：不同就會多一次轉址。 */
function canonicalOf(router) {
  const loc = router.latestLocation;
  const next = router.buildLocation({
    to: loc.pathname,
    search: true,
    params: true,
    hash: true,
    state: true,
    _includeValidateSearch: true,
  });
  return { loc, next };
}
for (const href of [
  "/",
  "/en",
  "/ja?x=1",
  "/events",
  "/en/events",
  "/ja/events/InntervalChishang.1023",
  "/en/events/%E4%B8%AD%E6%96%87",
  "/events?x=a%20b",
  "/en/events?x=a%20b",
  "/events?a=1&a=2",
  "/shop?tab=publications&utm_source=fb",
  "/cart",
  "/en/admin",
]) {
  const { router } = routerAt(href);
  const { loc, next } = canonicalOf(router);
  check(`${href}：publicHref 與重組的一致（不會多一次轉址）`, loc.publicHref, next.publicHref);
}
{
  const { router, state } = routerAt("/en/events");
  check("/en/events → 內部 /events", router.latestLocation.pathname, "/events");
  check("語言狀態 en", state.lang, "en");
  check("<Link to=/shop> → /en/shop", router.buildLocation({ to: "/shop" }).publicHref, "/en/shop");
  check("<Link to=/> → /en", router.buildLocation({ to: "/" }).publicHref, "/en");
  check(
    "<Link to=/events/$slug> → /en/events/x",
    router.buildLocation({ to: "/events/$slug", params: { slug: "x" } }).publicHref,
    "/en/events/x",
  );
  check("<Link to=/cart> 不帶前綴", router.buildLocation({ to: "/cart" }).publicHref, "/cart");
  check(
    "內部 href 不帶前綴（loader 快取 key 與中文共用路由）",
    router.buildLocation({ to: "/shop" }).href,
    "/shop",
  );
}
{
  const { router, state } = routerAt("/events");
  check(
    "中文頁：<Link to=/shop> → /shop（原網址不變）",
    router.buildLocation({ to: "/shop" }).publicHref,
    "/shop",
  );
  check("中文頁語言 zh", state.lang, "zh");
}
{
  const { router } = routerAt("/en/admin");
  check("/en/admin 沒有被剝前綴（→ 404）", router.latestLocation.pathname, "/en/admin");
  check(
    "/en/admin 對不到後台路由",
    router.matchRoutes(router.latestLocation).some((m) => m.routeId === "/admin"),
    false,
  );
}
{
  // 私密頁沿用最後一次公開頁的語言（SPA 從 /en/shop 走到 /cart 再回選物）
  const { router, state } = routerAt("/ja/shop");
  router.history.push("/cart");
  router.updateLatestLocation();
  check("/cart 不帶前綴", router.latestLocation.publicHref, "/cart");
  check("私密頁不改語言狀態", state.lang, "ja");
  check("從 /cart 回選物 → /ja/shop", router.buildLocation({ to: "/shop" }).publicHref, "/ja/shop");
}

{
  // 直接載入私密頁（/cart）：一開始是中文；掛載後換成記住的英文，站內連結跟著換
  const r = createLangRewrite();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/cart"] }),
    rewrite: r.rewrite,
  });
  r.normalizePublicHref(router);
  const opts = { to: "/shop", _fromLocation: router.latestLocation };
  check(
    "直接載入 /cart：選物連結先是中文（與 SSR 一致）",
    router.buildLocation(opts).publicHref,
    "/shop",
  );
  r.setPreferredLang(router, "en");
  check(
    "setPreferredLang(en) 之後（同一個 opts 物件，不吃舊快取）→ /en/shop",
    router.buildLocation(opts).publicHref,
    "/en/shop",
  );
  check("網址本身不變", router.latestLocation.publicHref, "/cart");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[8] 靜態守門");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const routesDir = join(ROOT, "src/routes");
const publicRoutes = readdirSync(routesDir).filter(
  (f) =>
    f.endsWith(".tsx") &&
    !/^(__root|account|cart|checkout|auth|news|visit|contact|curated|publications)/.test(f),
);
checkTrue(`公開頁路由檔數量（${publicRoutes.length}）`, publicRoutes.length >= 15);
for (const f of publicRoutes) {
  const src = strip(readFile(`src/routes/${f}`));
  checkTrue(
    `${f} 的 head 用 pageHead()（依語言輸出 canonical／hreflang）`,
    /pageHead\(\s*\{\s*matches,\s*match\s*\}/.test(src),
  );
  check(`${f} 沒有殘留的 pageMeta()`, /\bpageMeta\(/.test(src), false);
}
const rootSrc = strip(readFile("src/routes/__root.tsx"));
check("__root 不再輸出 canonical（改由 pageHead）", /rel: "canonical"/.test(rootSrc), false);
checkTrue(
  "__root 的 <html lang> 依網址",
  /<html lang=\{HTML_LANG\[urlLang \?\? "zh"\]\}>/.test(rootSrc),
);
const ctxSrc = strip(readFile("src/i18n/LanguageContext.tsx"));
check("LanguageProvider 不讀 navigator.language", /navigator\.language/.test(ctxSrc), false);
checkTrue(
  "公開頁語言＝網址（urlLang 優先於記住的語言）",
  /const lang: Lang = urlLang \?\? stored \?\? "zh"/.test(ctxSrc),
);
const hintSrc = strip(readFile("src/components/LanguageHint.tsx"));
check(
  "中文頁的提示不自動轉址（沒有 location.assign／replace）",
  /location\.(assign|replace|href\s*=)/.test(hintSrc),
  false,
);
const headSrc = strip(readFile("src/lib/seo/head.ts"));
check(
  "og:locale:alternate 不輸出（HeadContent 同名去重只留一個）",
  /og:locale:alternate/.test(headSrc),
  false,
);
checkTrue("inLanguage 只加在 Event／Book", /t === "Event" \|\| t === "Book"/.test(headSrc));
checkTrue(
  "提示只在那個語言有版本（hreflang）時出現",
  /link\[rel="alternate"\]\[hreflang=/.test(hintSrc),
);
const rootSrc2 = strip(readFile("src/routes/__root.tsx"));
checkTrue(
  "root loader 的語言過期（私密頁換語言後進公開頁）會重跑",
  /rootLangIsStale\(location\.publicHref\)/.test(rootSrc2),
);
const sitemapSrc = strip(readFile("src/server/sitemap.ts"));
checkTrue(
  "sitemap 的 loc() 與 cms.ts 同樣要求三個鍵都是字串",
  /typeof o\.zh !== "string" \|\| typeof o\.en !== "string" \|\| typeof o\.ja !== "string"/.test(
    sitemapSrc,
  ),
);
const routerSrc = strip(readFile("src/router.tsx"));
checkTrue(
  "router 掛了 rewrite 與 publicHref 正規化",
  /rewrite: langRewrite\.rewrite/.test(routerSrc) &&
    /normalizePublicHref\(router\)/.test(routerSrc),
);
const serverSrc = strip(readFile("src/server.ts"));
checkTrue(
  "快取規則用剝掉前綴的路徑",
  /cacheControlFor\(splitLangPrefix\(pathname\)\.rest/.test(serverSrc),
);

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
