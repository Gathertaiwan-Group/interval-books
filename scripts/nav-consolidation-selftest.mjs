#!/usr/bin/env node
/**
 * nav-consolidation-selftest.mjs —— 導覽列九格 → 五格（2026-09-02）的自檢
 *
 * 這一期做了兩件合併：
 *
 *   /shop   ← 選購 ＋ 地方刊物展 ＋ 主理人的選品（一頁、三個分頁、?tab= 決定看哪一個）
 *   /about  ← 關於 ＋ 來店資訊；/contact 純移除（footer 已經有它的每一項）
 *
 * 四個被收掉的網址（/visit /contact /publications /curated）沒有刪檔案，改成 301
 * 轉址 —— 它們散在 Google 商家、名片與社群貼文上。
 *
 * ── 這支自檢在防哪幾種假性通過 ────────────────────────────────────────────
 *
 * 1. **被註解餵飽。** 這一期的每一個檔案的檔頭都寫著 "/publications"、"/contact"、
 *    "ui.nav.about" 這些字串（那是解釋為什麼要搬走）。任何
 *    `src.includes("/contact")` 形狀的斷言都會被那段散文餵成綠燈，而且會在
 *    **相反的方向**上綠：程式碼真的還連著 /contact 時它也是綠的。
 *    → 所以底下**一條 includes() 都沒有**。全部走 @babel/parser 的 AST：
 *      JSX 屬性值、MemberExpression 路徑、CallExpression 的字串引數。註解與
 *      字串內容進不了這些節點。
 *
 * 2. **自搭 harness 把 props 直接傳進去。** 三個分頁被抽成
 *    src/components/shop/*Panel.tsx。只驗「Panel 元件自己畫得出東西」的話，
 *    /shop 根本沒把 loader 資料接上去也照樣全綠。
 *    → [3] 段不驗 Panel 畫什麼，只驗**接線**：loader 回傳物件的 key、
 *      Route.useLoaderData() 解構出來的名字、三個 <Panel> 的每一個 prop
 *      identifier，三者必須是同一組名字。而且反過來驗 Panel 檔案自己
 *      **不呼叫任何 fetch***（資料只能從路由流進去，不能自己偷讀）。
 *
 * 3. **稽核工具被放寬。** scripts/check-meta.mjs 這一期學會了「只轉址、沒有
 *    component 的路由不需要 meta」。這是一個真的可以被拿來當後門的洞：把
 *    component 刪掉、隨手 throw 一個 redirect，整頁就從稽核裡消失了。
 *    → [8] 段**真的 spawn check-meta.mjs**，在暫存目錄裡餵四種 fixture，證明
 *      放寬只放寬了該放寬的那一種，另外三種仍然轉紅。這一段是這支自檢裡唯一
 *      會真的執行產線程式的部分，也是最重要的一段。
 *
 * ⚠️ 每一條斷言都做過突變測試（把產線那一行改壞、確認轉紅、再改回來），結果寫在
 *    交付回報裡。
 *
 * ⚠️ 這支測試不碰資料庫、不讀環境變數、不發網路請求。它也**不引用
 *    scripts/lib/migration-ledger.mjs** —— 這一期一支 migration 都沒有新增，動到的
 *    全是 src/routes、src/components 與 src/i18n。25 支自檢裡有 18 支同樣不引用
 *    帳本（帳本守的是 SQL 面的區域），這一支是第 19 支。
 */

import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseJs } from "@babel/parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/nav-consolidation-selftest.mjs";

// -----------------------------------------------------------------------------
// 迷你測試框架（與 localized-list-selftest / translate-selftest 同一套）
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function check(label, actual, expected, hint) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
    if (hint) console.log(red(`      ${hint}`));
  }
}

const checkTrue = (label, value, hint) => check(label, value === true, true, hint);
const checkFalse = (label, value, hint) => check(label, value === false, true, hint);

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串。
 * 理由見 scripts/run-selftests.mjs 的「守門 4」：空字串會讓否定斷言靜默通過。
 */
const readFile = (p) => {
  if (!existsSync(p)) {
    throw new Error(`selftest 讀不到檔案：${p} —— 路徑打錯或檔案被搬走了，不是「檔案是空的」。`);
  }
  return readFileSync(p, "utf8");
};

// -----------------------------------------------------------------------------
// AST 工具
// -----------------------------------------------------------------------------

const parseTsx = (src) => parseJs(src, { sourceType: "module", plugins: ["typescript", "jsx"] });

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key.endsWith("Comments")) continue;
    walk(node[key], visit);
  }
}

/** 剝掉 TSAsExpression / TSSatisfiesExpression 這類只影響型別的外殼。 */
function unwrap(node) {
  let n = node;
  while (n && (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression")) n = n.expression;
  return n;
}

const propKey = (p) => p.key?.name ?? p.key?.value ?? null;

/** ObjectExpression 上某個 key 的值節點。 */
function propValue(obj, key) {
  if (!obj || obj.type !== "ObjectExpression") return null;
  const p = obj.properties.find((x) => x.type === "ObjectProperty" && propKey(x) === key);
  return p ? unwrap(p.value) : null;
}

const hasProp = (obj, key) =>
  !!obj &&
  obj.type === "ObjectExpression" &&
  obj.properties.some((p) => p.type === "ObjectProperty" && propKey(p) === key);

const strOf = (node) => (unwrap(node)?.type === "StringLiteral" ? unwrap(node).value : null);

/** "ui.nav.home" —— 只認純識別字組成的 MemberExpression。 */
function memberPath(node) {
  const parts = [];
  let n = node;
  while (n && n.type === "MemberExpression" && !n.computed) {
    if (n.property.type !== "Identifier") return null;
    parts.unshift(n.property.name);
    n = n.object;
  }
  if (n?.type !== "Identifier") return null;
  parts.unshift(n.name);
  return parts.join(".");
}

/** 頂層 `const NAME = …` 的初始值。 */
function topLevelInit(ast, name) {
  let found = null;
  walk(ast.program, (n) => {
    if (n.type !== "VariableDeclarator") return;
    if (n.id?.type === "Identifier" && n.id.name === name) found = unwrap(n.init);
  });
  return found;
}

/** createFileRoute("/x")({ … }) 的兩半。 */
function routeParts(ast) {
  let out = { path: null, options: null };
  walk(ast.program, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = n.callee;
    if (callee?.type !== "CallExpression") return;
    if (callee.callee?.type !== "Identifier" || callee.callee.name !== "createFileRoute") return;
    out = { path: strOf(callee.arguments[0]), options: unwrap(n.arguments[0]) };
  });
  return out;
}

/** 指定名稱的 JSX 元素，回傳 [{ props: {name: node}, node }]。 */
function jsxElements(ast, name) {
  const found = [];
  walk(ast.program, (n) => {
    if (n.type !== "JSXOpeningElement") return;
    if (n.name?.type !== "JSXIdentifier" || n.name.name !== name) return;
    const props = {};
    for (const a of n.attributes) {
      if (a.type !== "JSXAttribute" || a.name?.type !== "JSXIdentifier") continue;
      props[a.name.name] =
        a.value?.type === "JSXExpressionContainer" ? unwrap(a.value.expression) : unwrap(a.value);
    }
    found.push({ props, node: n });
  });
  return found;
}

/** 某個節點底下，`obj.method("key", …)` 的第一個字串引數集合。 */
function callKeys(node, objName, methodName) {
  const keys = new Set();
  walk(node, (n) => {
    if (n.type !== "CallExpression") return;
    if (memberPath(n.callee) !== `${objName}.${methodName}`) return;
    const k = strOf(n.arguments[0]);
    if (k !== null) keys.add(k);
  });
  return keys;
}

/** 某個節點底下所有被呼叫的函式名（純 Identifier callee）。 */
function calledFunctions(node) {
  const names = new Set();
  walk(node, (n) => {
    if (n.type === "CallExpression" && n.callee?.type === "Identifier") names.add(n.callee.name);
  });
  return names;
}

const sorted = (set) => [...set].sort();

// =============================================================================
// [0] 反空殼
// =============================================================================
console.log("\n[0] 反空殼 —— 每個受檢檔案都真的讀得到程式碼");

const FILES = {
  header: "src/components/SiteHeader.tsx",
  footer: "src/components/SiteFooter.tsx",
  strings: "src/i18n/strings.ts",
  about: "src/routes/about.tsx",
  shop: "src/routes/shop.index.tsx",
  index: "src/routes/index.tsx",
  visit: "src/routes/visit.tsx",
  contact: "src/routes/contact.tsx",
  publications: "src/routes/publications.tsx",
  curated: "src/routes/curated.tsx",
  productsPanel: "src/components/shop/ProductsPanel.tsx",
  publicationsPanel: "src/components/shop/PublicationsPanel.tsx",
  curatedPanel: "src/components/shop/CuratedPanel.tsx",
  checkMeta: "scripts/check-meta.mjs",
  seed: "supabase/seed.sql",
};

const src = {};
const ast = {};
for (const [key, rel] of Object.entries(FILES)) {
  src[key] = readFile(join(ROOT, rel));
}
// 轉址頁刻意很短（只有檔頭註解 + 一個 beforeLoad），門檻分開設。
const MIN_LEN = { visit: 300, contact: 300, publications: 300, curated: 300 };
for (const key of Object.keys(FILES)) {
  const min = MIN_LEN[key] ?? 1200;
  checkTrue(`${FILES[key]} 長度 > ${min}`, src[key].length > min);
}
for (const key of Object.keys(FILES)) {
  if (key === "seed" || key === "checkMeta") continue;
  ast[key] = parseTsx(src[key]);
}

// =============================================================================
// [1] 導覽列剛好五格
// =============================================================================
console.log("\n[1] SiteHeader —— 五格，順序與目標正確");

const navArray = topLevelInit(ast.header, "NAV");
checkTrue("SiteHeader 裡找得到 NAV 陣列", navArray?.type === "ArrayExpression");

const navEntries = (navArray?.elements ?? []).map((el) => {
  const obj = unwrap(el);
  const label = propValue(obj, "label");
  // label 長成 t(ui.nav.X)
  const inner = label?.type === "CallExpression" ? label.arguments[0] : null;
  return { to: strOf(propValue(obj, "to")), label: memberPath(inner) };
});

check("NAV 剛好 5 格", navEntries.length, 5);
check("NAV 的順序、網址與字串 key 全部正確", navEntries, [
  { to: "/", label: "ui.nav.home" },
  { to: "/shop", label: "ui.nav.select" },
  { to: "/events", label: "ui.nav.events" },
  { to: "/journeys", label: "ui.nav.journeys" },
  { to: "/about", label: "ui.nav.aboutStore" },
]);

// 被收掉的四個網址不可以還留在導覽列裡。
// 走 AST 的 `to:` 值，不是 includes() —— 這個檔案的註解裡就寫著這四個字串。
const navTargets = new Set(navEntries.map((e) => e.to));
for (const gone of ["/visit", "/contact", "/publications", "/curated"]) {
  checkFalse(`NAV 不再指向 ${gone}`, navTargets.has(gone));
}

// SiteHeader 用到的每一個 ui.nav.* key。
const headerNavKeys = new Set();
walk(ast.header.program, (n) => {
  if (n.type !== "MemberExpression") return;
  const p = memberPath(n);
  if (p && p.startsWith("ui.nav.")) headerNavKeys.add(p.slice("ui.nav.".length));
});
check("SiteHeader 只用這幾個 nav key", sorted(headerNavKeys), [
  "aboutStore",
  "account",
  "cart",
  "events",
  "home",
  "journeys",
  "select",
]);
// 為什麼特別釘住 about / shop：seed.sql 在正式庫塞了 ('nav','about')，
// cms.ts 的 buildUi() 會讓資料庫那一列覆蓋掉 strings.ts。用回舊 key，
// 畫面就會變回「關於」，而且改的人看不出原因。
checkFalse("SiteHeader 沒有用回 ui.nav.about（會被資料庫覆蓋）", headerNavKeys.has("about"));
checkFalse("SiteHeader 沒有用回 ui.nav.shop", headerNavKeys.has("shop"));

// =============================================================================
// [2] 四個舊網址 = 真的轉址路由
// =============================================================================
console.log("\n[2] 四個舊網址轉址（不是 404、不是留著空頁）");

const REDIRECTS = [
  { key: "visit", route: "/visit", to: "/about", tab: null },
  { key: "contact", route: "/contact", to: "/about", tab: null },
  { key: "publications", route: "/publications", to: "/shop", tab: "publications" },
  { key: "curated", route: "/curated", to: "/shop", tab: "curated" },
];

for (const r of REDIRECTS) {
  const { path, options } = routeParts(ast[r.key]);
  check(`${FILES[r.key]} 宣告成 ${r.route}`, path, r.route);
  checkFalse(`${r.route} 沒有 component（真的不畫任何東西）`, hasProp(options, "component"));
  checkTrue(`${r.route} 有 beforeLoad`, hasProp(options, "beforeLoad"));

  const thrown = [];
  walk(options, (n) => {
    if (n.type !== "ThrowStatement") return;
    const a = n.argument;
    if (
      a?.type === "CallExpression" &&
      a.callee?.type === "Identifier" &&
      a.callee.name === "redirect"
    )
      thrown.push(unwrap(a.arguments[0]));
  });
  check(`${r.route} 剛好 throw 一次 redirect()`, thrown.length, 1);
  const arg = thrown[0] ?? null;
  check(`${r.route} 轉去 ${r.to}`, strOf(propValue(arg, "to")), r.to);
  check(
    `${r.route} 用 301（永久搬遷，舊連結的權重跟著走）`,
    propValue(arg, "statusCode")?.value ?? null,
    301,
  );
  const searchTab = strOf(propValue(propValue(arg, "search"), "tab"));
  check(`${r.route} 落在 ${r.tab ?? "（無 tab）"} 分頁`, searchTab, r.tab);
}

// check-meta 產出的報告要跟磁碟上的路由檔對得起來（報告不是舊的）。
const metaReport = JSON.parse(readFile(join(ROOT, "reports/meta-audit.json")));
check("meta 稽核 0 個問題", metaReport.summary.totalIssues, 0);
check("meta 報告認定的轉址路由就是這四個", [...metaReport.summary.redirectRouteList].sort(), [
  "/contact",
  "/curated",
  "/publications",
  "/visit",
]);
check(
  "meta 報告的 metaAudited = 路由總數 − 轉址數（沒有第五條路由偷偷退出稽核）",
  metaReport.summary.metaAudited,
  metaReport.summary.routesAudited - metaReport.summary.redirectRoutes,
);

// =============================================================================
// [3] 「選物」三分頁 —— 真的接上 loader，不是 harness 綠
// =============================================================================
console.log("\n[3] /shop 三分頁：loader → useLoaderData → <Panel> 是同一組名字");

const shopRoute = routeParts(ast.shop);
check("shop.index.tsx 宣告成 /shop/", shopRoute.path, "/shop/");
checkTrue(
  "/shop 有 validateSearch（?tab= 是真的路由狀態）",
  hasProp(shopRoute.options, "validateSearch"),
);

const shopLoader = propValue(shopRoute.options, "loader");
const loaderCalls = calledFunctions(shopLoader);
// 2026-09 前台載入速度優化改了這裡呼叫的函式（不是這支測試原本要守的「三分頁
// 接線」本身）：三次 fetchPage() 併成一次 fetchPages()，商品目錄的
// fetchActiveProducts()+fetchActiveProductsByIds()（讀兩次、大量重疊）併成一次
// fetchActiveProductsForList()，刊物目錄的 fetchPublications()（126 筆每筆帶
// 完整三語 intro，點開才會用到）換成 fetchPublicationsForList()（不含 intro，
// 見 lib/publications.ts）。下面同時測「新名字真的被呼叫」與「舊名字真的不再
// 出現」——只測前者的話，舊呼叫留著沒刪掉也會誤判成通過。
for (const fn of [
  "fetchPages",
  "fetchActiveProductsForList",
  "fetchPublicationsForList",
  "fetchCuratedThemes",
]) {
  checkTrue(`/shop loader 真的呼叫 ${fn}()`, loaderCalls.has(fn));
}
for (const fn of [
  "fetchPage",
  "fetchActiveProducts",
  "fetchActiveProductsByIds",
  "fetchPublications",
]) {
  checkFalse(`/shop loader 不再呼叫 ${fn}()（改用批次／單次讀取版本）`, loaderCalls.has(fn));
}

let fetchPagesArgSlugs = null;
walk(shopLoader, (n) => {
  if (n.type !== "CallExpression") return;
  if (n.callee?.type !== "Identifier" || n.callee.name !== "fetchPages") return;
  const arg = unwrap(n.arguments[0]);
  if (arg?.type !== "ArrayExpression") return;
  fetchPagesArgSlugs = arg.elements.map((el) => strOf(el)).filter((s) => s !== null);
});
check(
  "/shop loader 用 fetchPages([...]) 一次批次讀三個 slug（三個分頁各自的文案都還是後台驅動）",
  fetchPagesArgSlugs ? sorted(new Set(fetchPagesArgSlugs)) : null,
  ["curated", "publications", "shop"],
);

// loader 回傳物件的 key
const loaderReturnKeys = new Set();
walk(shopLoader, (n) => {
  if (n.type !== "ReturnStatement") return;
  const obj = unwrap(n.argument);
  if (obj?.type !== "ObjectExpression") return;
  for (const p of obj.properties) {
    if (p.type === "ObjectProperty") loaderReturnKeys.add(propKey(p));
    else if (p.type === "SpreadElement") loaderReturnKeys.add("…spread");
  }
});

// Route.useLoaderData() 解構出來的名字
const useLoaderNames = new Set();
walk(ast.shop.program, (n) => {
  if (n.type !== "VariableDeclarator") return;
  const init = unwrap(n.init);
  if (init?.type !== "CallExpression" || memberPath(init.callee) !== "Route.useLoaderData") return;
  if (n.id?.type !== "ObjectPattern") return;
  for (const p of n.id.properties) if (p.type === "ObjectProperty") useLoaderNames.add(propKey(p));
});
checkTrue("/shop 從 Route.useLoaderData() 解構（不是自己 fetch）", useLoaderNames.size > 0);

// 2026-09：PublicationsPanel 的 catalogue prop 從專用的 publicationProducts
// （另一次 fetchActiveProductsByIds() 讀出來的、與 catalogue 大量重疊的子集）
// 改成直接共用 catalogue——見上面 loader 那段。ProductsPanel 與
// PublicationsPanel 現在指到同一個 useLoaderData 變數，這正是這支測試 ①②③
// 要守的「prop 是不是真的接到 loader」，只是這次兩個 Panel 接到同一條線。
const PANEL_WIRING = [
  { name: "ProductsPanel", props: { page: "page", catalogue: "catalogue" } },
  {
    name: "PublicationsPanel",
    props: { page: "publicationsPage", list: "publications", catalogue: "catalogue" },
  },
  { name: "CuratedPanel", props: { page: "curatedPage", curatedThemes: "curatedThemes" } },
];

for (const panel of PANEL_WIRING) {
  const els = jsxElements(ast.shop, panel.name);
  check(`/shop 只畫一次 <${panel.name}>`, els.length, 1);
  const props = els[0]?.props ?? {};
  for (const [prop, expected] of Object.entries(panel.props)) {
    const node = props[prop];
    const name = node?.type === "Identifier" ? node.name : null;
    // ① prop 的值是一個變數（不是就地捏出來的字面量／假資料）
    check(`<${panel.name} ${prop}={${expected}}>`, name, expected);
    // ② 那個變數是 useLoaderData 解構出來的
    checkTrue(`  ${panel.name}.${prop} 來自 useLoaderData`, useLoaderNames.has(name));
    // ③ loader 真的回傳這個 key
    checkTrue(`  loader 回傳 ${name}`, loaderReturnKeys.has(name));
  }
}

// 反向守門：Panel 自己不可以偷讀資料。它們只能收 props —— 否則 [3] ①②③
// 全綠但頁面其實是 Panel 自己去撈的，路由那條線斷了也看不出來。
//
// 2026-09 前台載入速度優化加了唯一一個例外：PublicationsPanel.tsx 裡的
// fetchPublicationDetail()，使用者點開某一本刊物的「刊物介紹」才會被呼叫
// （見 src/lib/publications.ts#fetchPublicationDetail 檔頭）。這條守門原本要
// 防的是「初始頁面資料繞過 loader、自己偷撈」——fetchPublicationDetail 不是
// 初始資料，它是點擊之後才發生的動作，跟 handleAdd() 呼叫 addItem()（購物車
// mutation）是同一個類別，不是這條規則想擋的那種。允許清單只放這一個名字，
// 任何其他 fetch* 仍然會讓下面轉紅。
const PANEL_FETCH_ALLOWLIST = {
  productsPanel: [],
  publicationsPanel: ["fetchPublicationDetail"],
  curatedPanel: [],
};
for (const key of ["productsPanel", "publicationsPanel", "curatedPanel"]) {
  const fns = calledFunctions(ast[key]);
  const allowed = new Set(PANEL_FETCH_ALLOWLIST[key]);
  const fetchers = [...fns].filter((f) => f.startsWith("fetch") && !allowed.has(f));
  check(
    `${FILES[key]} 自己不呼叫任何未列入白名單的 fetch*（資料只能從 /shop 流進來，白名單：${
      PANEL_FETCH_ALLOWLIST[key].join(", ") || "（無）"
    }）`,
    fetchers,
    [],
  );
  if (allowed.size > 0) {
    checkTrue(
      `  ${FILES[key]} 真的呼叫了白名單裡的 ${[...allowed].join(", ")}`,
      [...allowed].every((f) => fns.has(f)),
    );
  }
}

// =============================================================================
// [4] /about 併入來店資訊，而且讀兩列 page row
// =============================================================================
console.log("\n[4] /about —— 併入 /visit，兩列 page row，h1 = 關於小時光");

const aboutRoute = routeParts(ast.about);
check("about.tsx 宣告成 /about", aboutRoute.path, "/about");

const aboutLoader = propValue(aboutRoute.options, "loader");
const aboutSlugs = new Set();
walk(aboutLoader, (n) => {
  if (
    n.type === "CallExpression" &&
    n.callee?.type === "Identifier" &&
    n.callee.name === "fetchPage"
  ) {
    const s = strOf(n.arguments[0]);
    if (s) aboutSlugs.add(s);
  }
});
// 只讀 about 那一列的話，後台 /admin/pages/visit 的每一次編輯都會變成靜默無效。
check("/about loader 同時讀 about 與 visit 兩列", sorted(aboutSlugs), ["about", "visit"]);

const aboutLoaderNames = new Set();
walk(ast.about.program, (n) => {
  if (n.type !== "VariableDeclarator") return;
  const init = unwrap(n.init);
  if (init?.type !== "CallExpression" || memberPath(init.callee) !== "Route.useLoaderData") return;
  if (n.id?.type !== "ObjectPattern") return;
  for (const p of n.id.properties)
    if (p.type === "ObjectProperty") aboutLoaderNames.add(propKey(p));
});
check("/about 解構出 page 與 visitPage", sorted(aboutLoaderNames), ["page", "visitPage"]);

// pv = pageText(visitPage)
let pvSource = null;
walk(ast.about.program, (n) => {
  if (n.type !== "VariableDeclarator" || n.id?.type !== "Identifier" || n.id.name !== "pv") return;
  const init = unwrap(n.init);
  if (
    init?.type === "CallExpression" &&
    init.callee?.type === "Identifier" &&
    init.callee.name === "pageText"
  )
    pvSource = init.arguments[0]?.type === "Identifier" ? init.arguments[0].name : null;
});
check("pv = pageText(visitPage)", pvSource, "visitPage");

const VISIT_BLOCK_KEYS = [
  "address",
  "bus",
  "busDetail",
  "contactEyebrow",
  "contactUs",
  "drive",
  "hours",
  "inside",
  "metro",
  "navHint",
  "navigateEyebrow",
  "openApple",
  "openGoogle",
  "transport",
  "walk",
];
const VISIT_LIST_KEYS = ["bus", "drive", "inside", "metro", "walk"];

const pvBlocks = callKeys(ast.about.program, "pv", "block");
const pvLists = callKeys(ast.about.program, "pv", "list");
check(
  "來店資訊的每一個文案 key 都走 pv.block（= visit 那一列）",
  sorted(pvBlocks),
  VISIT_BLOCK_KEYS,
);
check("交通／店內五份清單都走 pv.list", sorted(pvLists), VISIT_LIST_KEYS);

// 反向：這些 key 不可以有人改讀 about 那一列 —— 那會讓後台編輯靜默無效。
const pBlocks = callKeys(ast.about.program, "p", "block");
const pLists = callKeys(ast.about.program, "p", "list");
check(
  "沒有任何來店資訊 key 誤讀成 p.block（about 那一列）",
  VISIT_BLOCK_KEYS.filter((k) => pBlocks.has(k)),
  [],
);
check("about 那一列沒有被要求提供 visit 的清單", [...pLists], []);

// h1
const pageHeaders = jsxElements(ast.about, "PageHeader");
check("/about 有一個 PageHeader", pageHeaders.length, 1);
const titleExpr = pageHeaders[0]?.props?.title ?? null;
const titleBlockKeys = callKeys(titleExpr, "p", "block");
checkTrue('h1 走 p.block("pageTitle")', titleBlockKeys.has("pageTitle"));
// 而且不是 p.title() —— pages.about.header_title 在正式庫是「在華山的一段安靜時光」
checkFalse(
  "h1 沒有走 p.title()（那一欄會蓋掉「關於小時光」）",
  callKeys(titleExpr, "p", "title").size > 0,
);

const aboutPage = topLevelInit(ast.about, "PAGE");
const pageTitleObj = propValue(aboutPage, "pageTitle");
check("PAGE.pageTitle.zh = 關於小時光", strOf(propValue(pageTitleObj, "zh")), "關於小時光");
for (const lang of ["en", "ja"]) {
  checkTrue(
    `PAGE.pageTitle.${lang} 有值`,
    (strOf(propValue(pageTitleObj, lang)) ?? "").trim().length > 0,
  );
}

// header_title 沒有變成死欄位：它下移成故事段的 h2。
let pTitleUsed = false;
walk(ast.about.program, (n) => {
  if (n.type === "CallExpression" && memberPath(n.callee) === "p.title") pTitleUsed = true;
});
checkTrue("p.title() 仍然被用到（header_title 沒有變成後台改了沒反應的死欄位）", pTitleUsed);

// /about 上不可以再有指回 /contact 的連結（/contact 現在轉回 /about，會變成按了回到自己）
const aboutLinkTargets = jsxElements(ast.about, "Link").map((e) => strOf(e.props.to));
check("/about 上沒有任何 <Link>（聯絡改成直接開信）", aboutLinkTargets, []);
let mailtoFound = false;
walk(ast.about.program, (n) => {
  if (n.type !== "TemplateLiteral") return;
  const raw = n.quasis.map((q) => q.value.cooked).join("");
  if (raw.startsWith("mailto:")) mailtoFound = true;
});
checkTrue("/about 的聯絡按鈕是 mailto:", mailtoFound);

// 八個區塊都在，順序正確（data-testid 是 DOM 上真的看得到的錨點）
const testIds = [];
walk(ast.about.program, (n) => {
  if (n.type !== "JSXAttribute" || n.name?.name !== "data-testid") return;
  const v = n.value?.type === "StringLiteral" ? n.value.value : null;
  if (v?.startsWith("about-")) testIds.push(v);
});
check("/about 區塊順序：我們是誰 → 怎麼來找我們", testIds, [
  "about-story",
  "about-work",
  "about-space",
  "about-map",
  "about-address",
  "about-transport",
  "about-contact",
]);

// =============================================================================
// [5] footer 仍然涵蓋 /contact 曾經有的每一項
// =============================================================================
console.log("\n[5] SiteFooter —— /contact 能被純移除的唯一理由");

// ⚠️ 只收**畫出來**的東西：JSXExpressionContainer 底下的識別字與 member path。
//    掃全檔的話，`const { contactEmail } = useSiteContent()` 這一行自己就會餵飽
//    斷言 —— 把整個 <a mailto> 刪掉、email 從畫面上消失，斷言照樣是綠的。
//    （這條當初就是這樣寫的，突變測試 M12 抓到了。）
const footerPaths = new Set();
const footerIdents = new Set();
walk(ast.footer.program, (n) => {
  if (n.type !== "JSXExpressionContainer") return;
  walk(n.expression, (m) => {
    if (m.type === "MemberExpression") {
      const path = memberPath(m);
      if (path) footerPaths.add(path);
    }
    if (m.type === "Identifier") footerIdents.add(m.name);
  });
});

let footerFromSiteContent = false;
walk(ast.footer.program, (n) => {
  if (n.type !== "VariableDeclarator") return;
  const init = unwrap(n.init);
  if (
    init?.type === "CallExpression" &&
    init.callee?.type === "Identifier" &&
    init.callee.name === "useSiteContent"
  )
    footerFromSiteContent = true;
});
checkTrue("footer 的資料來自 useSiteContent()（與舊 /contact 同一份來源）", footerFromSiteContent);

for (const ident of ["contactEmail", "phones", "siteUrl"]) {
  checkTrue(`footer 有 ${ident}`, footerIdents.has(ident));
}
for (const path of [
  "social.instagram",
  "social.facebook",
  "social.line",
  "site.address",
  "site.hours",
]) {
  checkTrue(`footer 有 ${path}`, footerPaths.has(path));
}
let footerMailto = false;
let footerTel = false;
walk(ast.footer.program, (n) => {
  if (n.type !== "TemplateLiteral") return;
  const raw = n.quasis.map((q) => q.value.cooked).join("");
  if (raw.startsWith("mailto:")) footerMailto = true;
  if (raw.startsWith("tel:")) footerTel = true;
});
checkTrue("footer 的 email 是可點的 mailto:", footerMailto);
checkTrue("footer 的電話是可點的 tel:", footerTel);
// 兩支電話是 .map() 出來的：只驗「有 phones 這個字」不夠，那在解構那一行就成立了。
let footerPhonesMapped = false;
walk(ast.footer.program, (n) => {
  if (n.type === "CallExpression" && memberPath(n.callee) === "phones.map")
    footerPhonesMapped = true;
});
checkTrue("footer 真的把每一支電話都畫出來（phones.map）", footerPhonesMapped);

// =============================================================================
// [6] 首頁的站內連結指向新家
// =============================================================================
console.log("\n[6] 首頁 —— 站內連結不繞 301");

const indexLinks = jsxElements(ast.index, "Link");
const indexTargets = indexLinks.map((e) => strOf(e.props.to));
checkFalse('首頁沒有 <Link to="/curated">', indexTargets.includes("/curated"));
checkFalse('首頁沒有 <Link to="/visit">', indexTargets.includes("/visit"));
checkTrue('首頁有 <Link to="/about">', indexTargets.includes("/about"));

const shopLinkWithTab = indexLinks.find((e) => strOf(e.props.to) === "/shop" && e.props.search);
checkTrue('首頁有 <Link to="/shop" search={…}>', !!shopLinkWithTab);
// 2026-10：首頁「主理人的選品」那一區改成直接顯示商品卡，「走進選品櫥窗」就是那排卡片的
// 「查看全部」，所以落在〈商品〉分頁（能結帳的那一個），不再是只能看的 curated 清單。
check(
  "首頁的選品入口直接落在 products 分頁（商品卡的「查看全部」）",
  strOf(propValue(shopLinkWithTab?.props?.search ?? null, "tab")),
  "products",
);

// =============================================================================
// [7] i18n —— 新 key 的三語齊全，舊 key 沒有被刪
// =============================================================================
console.log("\n[7] strings.ts —— 新 key 三語齊全、舊 key 還在");

const uiObj = topLevelInit(ast.strings, "UI");
const navObj = propValue(uiObj, "nav");
checkTrue("strings.ts 找得到 UI.nav", navObj?.type === "ObjectExpression");

const NEW_KEYS = { select: "選物", aboutStore: "關於小時光" };
for (const [key, zh] of Object.entries(NEW_KEYS)) {
  const entry = propValue(navObj, key);
  checkTrue(`UI.nav.${key} 存在`, entry?.type === "ObjectExpression");
  check(`UI.nav.${key}.zh`, strOf(propValue(entry, "zh")), zh);
  for (const lang of ["en", "ja"]) {
    checkTrue(
      `UI.nav.${key}.${lang} 有值`,
      (strOf(propValue(entry, lang)) ?? "").trim().length > 0,
    );
  }
}
// 舊 key 不能刪：index.tsx 拿 curated/visit 當區塊標題，footer 拿 curation/privacy。
for (const key of ["curated", "visit", "curation", "privacy", "cart"]) {
  checkTrue(`舊的 UI.nav.${key} 還在（站上其他地方還在用）`, hasProp(navObj, key));
}
// 為什麼一定要用新 key：正式庫的 ui_strings 有 ('nav','about') 這一列會覆蓋 strings.ts。
checkTrue(
  "seed.sql 確實有 ('nav', 'about') 這一列（新 key 的理由還成立）",
  /\(\s*'nav'\s*,\s*'about'\s*,/.test(src.seed),
);

// =============================================================================
// [8] check-meta 的放寬只放寬了該放寬的那一種（真的執行）
// =============================================================================
console.log("\n[8] check-meta 端到端 —— 轉址路由的豁免不是一個後門");

const CHECK_META = join(ROOT, "scripts/check-meta.mjs");
checkTrue("check-meta.mjs 在", existsSync(CHECK_META));

const FIXTURES = {
  // ① 這一期新增的形狀：沒有 component、beforeLoad 丟 redirect → 不該被要求 meta
  redirectOnly: `
import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/gone")({
  beforeLoad: () => {
    throw redirect({ to: "/about", statusCode: 301 });
  },
});
`,
  // ② 一般頁面漏掉 useDocumentMeta → 必須照樣轉紅
  missingMeta: `
import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/page")({ component: Page });
function Page() {
  return <div>hi</div>;
}
`,
  // ③ 有 component、又有條件式 redirect（例：admin/_shell.index.tsx）
  //    → 它有頁面，必須照一般頁面稽核，不可以因為出現 redirect 就被豁免
  componentAndRedirect: `
import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/guarded")({
  beforeLoad: ({ context }) => {
    if (context.user) {
      throw redirect({ to: "/about" });
    }
  },
  component: Page,
});
function Page() {
  return <div>hi</div>;
}
`,
  // ④ component 被刪掉、但沒有 redirect → 頁面不見了，必須轉紅
  //    （這是「把 component 刪掉就從稽核裡消失」那個後門的直接測試）
  noComponentNoRedirect: `
import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/orphan")({
  loader: async () => ({}),
});
`,
};

/** 在暫存目錄裡建一個假的專案，把 check-meta 真的跑一次。 */
function runCheckMeta(routeFileName, code) {
  const dir = mkdtempSync(join(tmpdir(), "alice-checkmeta-"));
  try {
    mkdirSync(join(dir, "src/routes"), { recursive: true });
    mkdirSync(join(dir, "src/data"), { recursive: true });
    writeFileSync(join(dir, "src/routes", routeFileName), code, "utf8");
    writeFileSync(join(dir, "src/data/content.ts"), "export const NOTHING = 1;\n", "utf8");
    const run = spawnSync(process.execPath, [CHECK_META], { cwd: dir, encoding: "utf8" });
    let report = null;
    const reportPath = join(dir, "reports/meta-audit.json");
    if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, "utf8"));
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "", report };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const a = runCheckMeta("gone.tsx", FIXTURES.redirectOnly);
check("① 只轉址的路由 → check-meta 通過", a.status, 0);
check("① 而且被算成轉址路由", a.report?.summary?.redirectRoutes ?? null, 1);
check("① 沒有任何一條被拿去做 meta 稽核", a.report?.summary?.metaAudited ?? null, 0);

const b = runCheckMeta("page.tsx", FIXTURES.missingMeta);
check("② 一般頁面漏 useDocumentMeta → 仍然失敗", b.status, 1);
check("② 失敗原因是 no_hook_call", b.report?.summary?.issuesByCode?.no_hook_call ?? null, 1);
check("② 沒有被誤判成轉址路由", b.report?.summary?.redirectRoutes ?? null, 0);

const c = runCheckMeta("guarded.tsx", FIXTURES.componentAndRedirect);
check("③ 有 component 又會 redirect → 仍然當一般頁面稽核（失敗）", c.status, 1);
check("③ 沒有被誤判成轉址路由", c.report?.summary?.redirectRoutes ?? null, 0);
check("③ 仍然要求 meta", c.report?.summary?.issuesByCode?.no_hook_call ?? null, 1);

const d = runCheckMeta("orphan.tsx", FIXTURES.noComponentNoRedirect);
check("④ 沒有 component 也沒有 redirect → 仍然失敗（後門關著）", d.status, 1);
check("④ 沒有被誤判成轉址路由", d.report?.summary?.redirectRoutes ?? null, 0);

// -----------------------------------------------------------------------------
// 收尾
// -----------------------------------------------------------------------------

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
