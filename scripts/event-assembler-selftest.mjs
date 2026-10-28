#!/usr/bin/env node
/**
 * event-assembler-selftest.mjs —— 活動頁組裝器（D3 / 後台 UI）的自檢
 *
 * ⚠️ **這一頁在登入牆後面，這支測試看不到畫面。** 所以它刻意分成兩種證據，而且
 *    絕不假裝自己看過畫面：
 *
 *   [執行] 直接 `await import()` **產線上真正跑的那幾個純函式模組**
 *          （nav-active.ts / dirty-sections.ts / form-errors.ts / localized-list.ts /
 *          event-blocks.ts / schemas.ts），拿真的輸入餵進去看它回什麼。這一段驗的是
 *          「側欄會不會亮兩個」「沒有髒東西時提示是不是真的一個字都沒有」「驗證失敗
 *          時那句話會不會是空的」—— 這些是行為，讀原始碼比對字串證明不了。
 *
 *   [靜態] 用 **AST**（不是 grep）掃 src/routes/admin/_shell.events.$id.tsx。這一段守
 *          的是六個雷裡「只看得出形狀」的那幾個：段號有沒有提前領號、ImageField 有沒有
 *          被包進 FormControl、handleSubmit 有沒有第二個參數、主儲存後有沒有 bump
 *          formKey、主表單是不是一個空的隱藏 <form>。
 *
 *          🔴 **一律用 AST，不用 grep。** 這個 repo 出過的假陽性裡有一整族是「斷言被
 *             註解或字串的內容餵飽」——而這一頁的註解裡就寫著 `const Foo = (…
 *             step={nextStep()})` 這個**反例**。grep 版本會被自己的警告文字餵飽。
 *
 *   [連線] 對一個真的本機 PostgreSQL 驗最後一哩：七個清單欄位各三行送進 0027 的
 *          admin_upsert_event_with_session()，回頭數 jsonb_array_length。整段包在
 *          BEGIN … ROLLBACK 裡，跑完資料庫一列都沒有多。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它只認 EVENT_ASSEMBLER_SELFTEST_PG_URL，沒設就整段
 *    skip（會印出來，不會靜悄悄消失）。
 *
 *     createdb ib_d3_test   # 或沿用 D1 那顆已經套到 0027 的庫
 *     EVENT_ASSEMBLER_SELFTEST_PG_URL=postgres:///ib_d3_test node scripts/event-assembler-selftest.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { registerHooks } from "node:module";
import { parse as parseJs } from "@babel/parser";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/event-assembler-selftest.mjs";
const PG_URL = process.env.EVENT_ASSEMBLER_SELFTEST_PG_URL ?? "";

// -----------------------------------------------------------------------------
// 迷你測試框架（與 event-blocks-selftest 同一套）
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

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

function checkTrue(label, value, extra = "") {
  if (value) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    if (extra) console.log(red(`      ${extra}`));
  }
}

const checkFalse = (label, value, extra = "") => checkTrue(label, !value, extra);

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串。
 * 見 scripts/run-selftests.mjs 的「守門 4」：回空字串會讓每一條否定斷言靜默通過。
 */
const readFile = (p) => {
  const abs = p.startsWith("/") ? p : join(ROOT, p);
  if (!existsSync(abs)) {
    throw new Error(
      `selftest 讀不到檔案：${abs}` +
        "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串 —— 回空字串會讓所有" +
        "「確認原始碼裡沒有 X」的否定斷言靜默通過。）",
    );
  }
  return readFileSync(abs, "utf8");
};

// 守著 readFile() 自己。
{
  const ghost = join(ROOT, "__event-assembler-selftest-missing-probe__");
  let thrown = null;
  try {
    readFile(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 readFile() 讀不到檔案時丟例外，訊息指出是哪個路徑（不是靜默回空字串）",
    thrown !== null && String(thrown.message).includes(ghost),
  );
}

/** 遞迴列出一個目錄底下所有 .ts / .tsx。 */
function walkSrc(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walkSrc(abs, out);
    else if (/\.tsx?$/.test(abs)) out.push(abs);
  }
  return out;
}

/** 走 AST。刻意跳過 comments —— 註解不該餵飽任何斷言。 */
function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walkAst(n, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    if (key === "innerComments" || key === "comments") continue;
    walkAst(node[key], visit);
  }
}

function parseTsx(src, label) {
  return parseJs(src, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    errorRecovery: false,
    sourceFilename: label,
  });
}

/** JSX 元素的名字（<Foo>、<Foo.Bar> 都回得出來）。 */
function jsxName(node) {
  const n = node?.openingElement?.name ?? node?.name;
  if (!n) return "";
  if (n.type === "JSXIdentifier") return n.name;
  if (n.type === "JSXMemberExpression") return `${jsxName({ name: n.object })}.${n.property.name}`;
  return "";
}

/** 取一個 JSX 屬性節點。 */
function jsxAttr(node, attrName) {
  const attrs = node?.openingElement?.attributes ?? [];
  return attrs.find((a) => a.type === "JSXAttribute" && a.name?.name === attrName) ?? null;
}

/** 取一個 JSX 屬性的字串值（只認字面字串；表達式回 null）。 */
function jsxAttrString(node, attrName) {
  const a = jsxAttr(node, attrName);
  if (!a) return null;
  if (a.value?.type === "StringLiteral") return a.value.value;
  if (a.value?.type === "JSXExpressionContainer" && a.value.expression?.type === "StringLiteral") {
    return a.value.expression.value;
  }
  return null;
}

/**
 * 取一個 JSX 屬性的**已解析**字串：字面字串，或
 * `EVENT_BLOCK_COPY.<kind>.<欄位>` 這種指向產線文案表的成員存取。
 *
 * ── 為什麼要有這一支 ────────────────────────────────────────────────────────
 * D4 之後 §5／§8／§9 的段落標題**刻意不是字面字串** —— 三種區塊的名字只有一個家
 * （src/lib/admin/event-block-copy.ts），組裝器再抄一份的下場是段落改名之後 sticky bar
 * 還在講舊名字。但「每一段都有講得出口而且互不重複的標題」這條斷言不可以因此變鬆。
 *
 * 所以這裡**去產線那張表把值拿出來**（EVENT_BLOCK_COPY 是這支自檢真的 import 進來的
 * 那一份，不是複製品）。結果是斷言變強了：它同時證明了「標題存在且唯一」與「區塊的
 * 標題來自唯一的那張表」。解不出來就回 null，該紅照樣紅。
 */
function jsxAttrResolvedString(node, attrName, copyTable) {
  const literal = jsxAttrString(node, attrName);
  if (literal !== null) return literal;
  const a = jsxAttr(node, attrName);
  const expr = a?.value?.type === "JSXExpressionContainer" ? a.value.expression : null;
  if (expr?.type !== "MemberExpression") return null;
  // EVENT_BLOCK_COPY.<kind>.<prop>
  const outer = expr.object;
  if (outer?.type !== "MemberExpression") return null;
  if (outer.object?.type !== "Identifier" || outer.object.name !== "EVENT_BLOCK_COPY") return null;
  const kind = outer.property?.name;
  const prop = expr.property?.name;
  const value = copyTable?.[kind]?.[prop];
  return typeof value === "string" ? value : null;
}

console.log("═══ 活動頁組裝器自檢（D3 / 後台 UI）═══");

// =============================================================================
// [0] 產線純函式模組本人
// =============================================================================
console.log("\n[0] 產線模組（直接載入本人，不是複製品）");

if (typeof registerHooks !== "function") {
  console.log(red("  ✗ 這個 Node 沒有 module.registerHooks（需要 ≥ 22.15）"));
  console.log(`##SELFTEST## file=${SELF} pass=0 fail=1`);
  process.exit(1);
}

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      const base = join(ROOT, "src", spec.slice(2));
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
});

const SRC_FILES = walkSrc(join(ROOT, "src"));

/**
 * 🔴 **不寫死路徑**：掃 src/ 找「誰 export 了這個名字」，而且要求**剛好一個檔**。
 *
 *   · 0 個 → 那個東西被改名或刪掉了，底下的斷言全部失去意義（而寫死路徑的版本會
 *     在這時候丟 readFile 例外，看起來像是路徑打錯）。
 *   · ≥2 個 → 有第二份了，「產線上跑的是這一份」這句話立刻不成立。
 */
function findSoleDefiner(exportName) {
  const hits = SRC_FILES.filter((f) =>
    new RegExp(`export\\s+(?:const|function)\\s+${exportName}\\b`).test(readFileSync(f, "utf8")),
  );
  check(
    `src/ 底下剛好一個檔 export ${exportName}`,
    hits.map((f) => relative(ROOT, f)),
    hits.length === 1 ? [relative(ROOT, hits[0])] : ["（剛好一個）"],
  );
  return hits.length === 1 ? hits[0] : null;
}

const NAV_ACTIVE_PATH = findSoleDefiner("isNavItemActive");
const DIRTY_PATH = findSoleDefiner("dirtyBannerText");
const FORM_ERRORS_PATH = findSoleDefiner("invalidToastMessage");

if (!NAV_ACTIVE_PATH || !DIRTY_PATH || !FORM_ERRORS_PATH) {
  console.log(red("  ✗ 找不到唯一的產線模組，後面的行為驗證無法進行"));
  console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail + 1}`);
  process.exit(1);
}

const navMod = await import(pathToFileURL(NAV_ACTIVE_PATH).href);
const dirtyMod = await import(pathToFileURL(DIRTY_PATH).href);
const errMod = await import(pathToFileURL(FORM_ERRORS_PATH).href);
const vocab = await import(pathToFileURL(join(ROOT, "src/lib/event-blocks.ts")).href);
const listMod = await import(pathToFileURL(join(ROOT, "src/lib/admin/localized-list.ts")).href);
const schemas = await import(pathToFileURL(join(ROOT, "src/lib/admin/schemas.ts")).href);
const copyMod = await import(pathToFileURL(join(ROOT, "src/lib/admin/event-block-copy.ts")).href);
const { EVENT_BLOCK_COPY } = copyMod;

const { isNavItemActive } = navMod;
const { dirtyBannerText, markDirty, dirtyKeys, hasDirty } = dirtyMod;
const { collectErrorPaths, invalidToastMessage } = errMod;
const { EVENT_LIST_FIELDS, EVENT_BLOCK_KINDS } = vocab;
const { linesToList } = listMod;

// 這三個模組要能被上面那個 await import 直接載起來，所以不可以有 import。
for (const [label, p] of [
  ["nav-active", NAV_ACTIVE_PATH],
  ["dirty-sections", DIRTY_PATH],
  ["form-errors", FORM_ERRORS_PATH],
]) {
  checkFalse(
    `${label} 一行 import 都沒有（自檢才載得起產線本人）`,
    /^\s*import\s/m.test(readFile(p).replace(/\/\*[\s\S]*?\*\//g, "")),
  );
}

// =============================================================================
// [1] 側欄：/admin/events/xxx 時「活動」亮、「儀表板」不亮
// =============================================================================
console.log("\n[1] 側欄的 isActive");

check(
  "完全相符：/admin/events 讓「活動」亮",
  isNavItemActive("/admin/events", "/admin/events"),
  true,
);
check(
  "子頁：/admin/events/abc 讓「活動」亮",
  isNavItemActive("/admin/events/abc", "/admin/events"),
  true,
);
check(
  "🔴 子頁：/admin/events/abc **不會**讓「儀表板」跟著亮",
  isNavItemActive("/admin/events/abc", "/admin"),
  false,
);
check(
  "🔴 既有的同一個 bug：/admin/news/abc 讓「最新消息」亮",
  isNavItemActive("/admin/news/abc", "/admin/news"),
  true,
);
check(
  "🔴 /admin/news/abc 不會讓「儀表板」跟著亮",
  isNavItemActive("/admin/news/abc", "/admin"),
  false,
);
check("/admin 本人讓「儀表板」亮", isNavItemActive("/admin", "/admin"), true);
check("結尾斜線也算：/admin/ 讓「儀表板」亮", isNavItemActive("/admin/", "/admin"), true);
check(
  "🔴 前綴比對認路徑分隔線：/admin/inventory-counting 不會讓「庫存盤點」亮",
  isNavItemActive("/admin/inventory-counting", "/admin/inventory-count"),
  false,
);
check(
  "別的模組不會互相點亮：/admin/products 不會讓「商品管理」亮",
  isNavItemActive("/admin/products", "/admin/inventory-products"),
  false,
);

/**
 * 🔴 這一條才是驗收條件本身：**同時只有一項亮**。
 *
 * 上面那幾條是一項一項問的，答對了也可能整條側欄同時亮兩個（那正是把 === 換成
 * startsWith 之後會發生的事）。所以這裡把 _shell.tsx 真正的 NAV_GROUPS 清單抓出來，
 * 對每一個網址算「有幾項是亮的」。
 */
const shellSrc = readFile("src/routes/admin/_shell.tsx");
const navStart = shellSrc.indexOf("const NAV_GROUPS");
const navSlice =
  navStart === -1 ? "" : shellSrc.slice(navStart, shellSrc.indexOf("] as const;", navStart));
const NAV_TARGETS = [...navSlice.matchAll(/to:\s*"([^"]+)"/g)].map((m) => m[1]);

checkTrue(
  "抓得到 NAV_GROUPS 的項目清單",
  NAV_TARGETS.length >= 10,
  `實得 ${NAV_TARGETS.length} 項`,
);
checkTrue("清單裡有「儀表板」/admin", NAV_TARGETS.includes("/admin"));
checkTrue("清單裡有「活動」/admin/events", NAV_TARGETS.includes("/admin/events"));
checkTrue("清單裡有「最新消息」/admin/news", NAV_TARGETS.includes("/admin/news"));
// 2026-10-29 業主要求移除後台「頁面文案」；側欄不該再有 /admin/pages。
checkTrue("清單裡已經沒有「頁面文案」/admin/pages", !NAV_TARGETS.includes("/admin/pages"));

function activeItemsAt(pathname) {
  return NAV_TARGETS.filter((to) => isNavItemActive(pathname, to));
}

check("🔴 /admin/events/abc 時剛好一項亮，而且是「活動」", activeItemsAt("/admin/events/abc"), [
  "/admin/events",
]);
check("🔴 /admin/news/abc 時剛好一項亮，而且是「最新消息」", activeItemsAt("/admin/news/abc"), [
  "/admin/news",
]);
check("/admin 時剛好一項亮，而且是「儀表板」", activeItemsAt("/admin"), ["/admin"]);
check("/admin/events 時剛好一項亮", activeItemsAt("/admin/events"), ["/admin/events"]);
for (const to of NAV_TARGETS) {
  check(`${to} 本人時剛好一項亮`, activeItemsAt(to), [to]);
}

// 側欄真的用了那支函式，而不是留著舊的 ===。
const shellAst = parseTsx(shellSrc, "_shell.tsx");
let usesNavFn = false;
let usesOldEquality = false;
walkAst(shellAst.program, (n) => {
  if (
    n.type === "CallExpression" &&
    n.callee?.type === "Identifier" &&
    n.callee.name === "isNavItemActive"
  ) {
    usesNavFn = true;
  }
  // 舊寫法：isActive={pathname === item.to}
  if (
    n.type === "BinaryExpression" &&
    n.operator === "===" &&
    n.left?.type === "Identifier" &&
    n.left.name === "pathname" &&
    n.right?.type === "MemberExpression" &&
    n.right.property?.name === "to"
  ) {
    usesOldEquality = true;
  }
});
checkTrue("_shell.tsx 真的呼叫 isNavItemActive()", usesNavFn);
checkFalse("🔴 _shell.tsx 沒有留著舊的 `pathname === item.to`", usesOldEquality);

// =============================================================================
// [2] 髒狀態：提示是條件式的，不是常駐句
// =============================================================================
console.log("\n[2] 髒狀態提示");

check(
  "🔴 沒有髒東西時 dirtyBannerText 回 null（＝那一條上一個字都不出現）",
  dirtyBannerText([]),
  null,
);
checkTrue("一段髒時有話說", typeof dirtyBannerText(["活動內容"]) === "string");
checkTrue("那句話點名是哪一段", dirtyBannerText(["活動內容"]).includes("活動內容"));
checkTrue(
  "多段髒時每一段都點名",
  ["A", "B"].every((l) => dirtyBannerText(["A", "B"]).includes(l)),
);
check("markDirty：乾淨 → 髒", dirtyKeys(markDirty({}, "content", true)), ["content"]);
check(
  "markDirty：髒 → 乾淨會把 key 拿掉",
  dirtyKeys(markDirty({ content: true }, "content", false)),
  [],
);
checkTrue(
  "🔴 markDirty 值沒變時回**原本那個物件**（否則每次 onChange 都整頁重畫）",
  (() => {
    const s0 = { content: true };
    return markDirty(s0, "content", true) === s0;
  })(),
);
check("hasDirty 對空的登記簿是 false", hasDirty({}), false);
check("hasDirty 對有東西的登記簿是 true", hasDirty({ content: true }), true);

// =============================================================================
// [3] 驗證失敗：一定要說出一句話
// =============================================================================
console.log("\n[3] onInvalid 的那句話");

// react-hook-form 的錯誤樹長這樣（zod resolver 產的）。
//
// ⚠️ `ref` 底下是**真的 DOM 節點**（有 parentNode、form、ownerDocument…），所以這裡的
//    假 ref 也刻意做成一個有巢狀物件的東西 —— 一個扁平的 `{name:"…"}` 假 ref 會讓
//    「不准走進 ref」那條斷言變成一句空話（走進去也走不到任何東西）。
const fakeErrors = {
  title: {
    en: {
      type: "too_small",
      message: "請輸入英文內容",
      ref: { name: "title.en", parentNode: { tagName: "DIV", message: "這是 DOM，不是錯誤" } },
    },
  },
  product: { price: { type: "custom", message: "價格不能是負數" } },
  highlights: { zh: { type: "custom", message: "最多 40 項" } },
};
check("collectErrorPaths 抓得出巢狀路徑", collectErrorPaths(fakeErrors).sort(), [
  "highlights.zh",
  "product.price",
  "title.en",
]);
checkTrue(
  "🔴 就算一個欄位都認不出來，invalidToastMessage 也不回空字串",
  invalidToastMessage([]).length > 0,
);
checkTrue(
  "那句話說得出欄位名（有對照表時）",
  invalidToastMessage(["title.en"], { title: "§2 標題" }).includes("§2 標題"),
);
checkTrue(
  "沒有對照的欄位不會被丟掉（退回路徑本身）",
  invalidToastMessage(["mystery_field"]).includes("mystery_field"),
);
checkTrue(
  "同一段的多個錯誤只講一次",
  (invalidToastMessage(["title.zh", "title.en"], { title: "§2 標題" }).match(/§2 標題/g) ?? [])
    .length === 1,
);
/**
 * 🔴 「不准沿著 ref 走進 DOM」這條守衛，只在**沒有 message 的那種節點**上才用得到
 *    （有 message 的節點會先被當成葉子回傳，根本走不到它的 ref）。所以這裡刻意用一個
 *    「只有 ref、沒有 message」的節點來驗它 —— 拿有 message 的節點來驗等於沒驗，
 *    把 "ref" 從白名單拿掉照樣是綠的。
 *
 * ref 底下做成**環狀**（DOM 節點就是這樣：parentNode 指回來）。少了這條守衛，
 * 這一行不是回一個多餘的路徑，是直接爆掉。
 */
const cyclicRef = { name: "x", tagName: "INPUT" };
cyclicRef.parentNode = { tagName: "DIV", message: "這是 DOM，不是錯誤", child: cyclicRef };
let refWalkResult = null;
let refWalkThrew = null;
try {
  refWalkResult = collectErrorPaths({ someField: { ref: cyclicRef } });
} catch (e) {
  refWalkThrew = e;
}
check("🔴 collectErrorPaths 不會沿著 ref 走進 DOM（也不會被環狀參照打爆）", refWalkResult, []);
checkTrue("而且沒有丟例外", refWalkThrew === null, String(refWalkThrew?.message ?? ""));

// =============================================================================
// [4] 組裝器：段號 1 → 11 連號
// =============================================================================
console.log("\n[4] 段號");

const ASSEMBLER_PATH = "src/routes/admin/_shell.events.$id.tsx";
const assemblerSrc = readFile(ASSEMBLER_PATH);
const assemblerAst = parseTsx(assemblerSrc, ASSEMBLER_PATH);

/** 依原始碼順序收集所有 `step={nextStep()}` 的 JSX 元素。 */
const stepSites = [];
walkAst(assemblerAst.program, (n) => {
  if (n.type !== "JSXElement") return;
  const a = jsxAttr(n, "step");
  if (!a || a.value?.type !== "JSXExpressionContainer") return;
  const expr = a.value.expression;
  if (expr?.type !== "CallExpression" || expr.callee?.name !== "nextStep") return;
  stepSites.push({
    start: a.start,
    name: jsxName(n),
    // 字面字串，或指向產線文案表的 EVENT_BLOCK_COPY.<kind>.sectionTitle（見上面那支
    // 函式的註解）。兩種都解不出來才是 null，而 null 會讓下面兩條斷言轉紅。
    title: jsxAttrResolvedString(n, "title", EVENT_BLOCK_COPY),
    node: n,
  });
});
stepSites.sort((x, y) => x.start - y.start);

check("組裝器上有 11 段", stepSites.length, 11);
// nextStep() 每次 +1、而且都在原始碼順序上求值 → 實際渲染出來的段號就是 1…11。
const rendered = stepSites.map((_, i) => i + 1);
check("🔴 段號 1 → 11 連號無斷號", rendered, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
console.log("      實際渲染出來的段號與標題：");
for (const [i, s] of stepSites.entries()) {
  console.log(`        §${i + 1} ${s.title ?? "（標題不是字面字串）"}  <${s.name}>`);
}
checkTrue(
  "每一段都有字面字串的標題（段號要能被人講出來）",
  stepSites.every((s) => typeof s.title === "string" && s.title.length > 0),
);
check("11 個標題互不重複", new Set(stepSites.map((s) => s.title)).size, 11);

/* ── D4：11 段全部是真的，沒有 placeholder 了 ──────────────────────────────
   D3 那一期這裡驗的是「§3／§5／§8／§9 是 placeholder」。D4 把那四段填成真的，所以
   這條**不是被放寬，是換成更具體的三條**：
     (a) 一個 placeholder 都不剩；
     (b) PlaceholderSection 那個元件本身也不在了（留著一個「誰都能拿來用的空殼」，
         下一期就會有人再放一段假的進來，而段落清單看起來照樣是 11 段）；
     (c) §5／§8／§9 各掛一個 EventBlockEditor，kind 剛好是那三種。
   (c) 比原本那條強：原本只知道「那三段不是真的」，現在知道「那三段是哪三種區塊」。 */
check(
  "🔴 沒有任何一段還是 placeholder（11 段全部是真的編輯器或唯讀鏡子）",
  stepSites
    .map((s, i) => (s.name === "PlaceholderSection" ? i + 1 : null))
    .filter((x) => x !== null),
  [],
);
checkFalse(
  "🔴 PlaceholderSection 這個元件也拿掉了（不留一個「再放一段假的進來」的空殼）",
  /function PlaceholderSection\b/.test(assemblerSrc),
);

/** 某一個 <Section> 底下（JSX 子孫）用到的元件名。 */
function componentsUnder(node, name) {
  const out = [];
  walkAst(node.children, (m) => {
    if (m.type === "JSXElement" && jsxName(m) === name) out.push(m);
  });
  return out;
}

const blockEditorSites = stepSites
  .map((s, i) => {
    const hits = componentsUnder(s.node, "EventBlockEditor");
    return hits.length === 0
      ? null
      : { step: i + 1, kinds: hits.map((h) => jsxAttrString(h, "kind")) };
  })
  .filter(Boolean);
check("🔴 §5／§8／§9 各掛一個區塊編輯器，kind 分別是 agenda／info_row／faq", blockEditorSites, [
  { step: 5, kinds: ["agenda"] },
  { step: 8, kinds: ["info_row"] },
  { step: 9, kinds: ["faq"] },
]);
check(
  "🔴 三種 kind 就是 EVENT_BLOCK_KINDS 那三個（不是第二份名單）",
  blockEditorSites.flatMap((s) => s.kinds).sort(),
  [...EVENT_BLOCK_KINDS].sort(),
);

/* ── §3 是唯讀的鏡子 ────────────────────────────────────────────────────────
   場次的 seats_taken 只由 0020 §7 的三支 RPC 在持有列鎖時維護。組裝器上出現任何一個
   可以寫回場次的控制項，就是超賣的入口。所以 §3 底下**一個輸入元件都不准有**。

   ⚠️ 先確認 §3 真的有東西（sessions.map 的那一段），否則「§3 沒有輸入框」在 §3 是一
      塊空白時也是綠的 —— 那種綠燈什麼都沒有在守。 */
const sessionSection = stepSites[2];
checkTrue(
  "第三段就是場次那一段",
  (sessionSection?.title ?? "").includes("場次"),
  sessionSection?.title,
);
const sessionInputs = [
  "FormField",
  "LocalizedField",
  "LocalizedListField",
  "Input",
  "Switch",
  "Textarea",
  "EventBlockEditor",
].flatMap((nm) => componentsUnder(sessionSection.node, nm).map(() => nm));
check("🔴 §3 底下一個輸入元件都沒有（唯讀鏡子）", sessionInputs, []);
checkTrue(
  "（對照組）§3 真的有在畫場次，不是一塊空白",
  componentsUnder(sessionSection.node, "MirrorNote").length === 1 &&
    /sessions\.map\(/.test(assemblerSrc),
);

/**
 * 🔴 雷 4 的守門：`const … = (… step={nextStep()} …)`。
 *
 * 寫成 const 的那一刻，那段 JSX 在元件本體執行到那一行時就先領走一個編號，於是它
 * 後面的每一段都往後退一號 —— 來源專案就是這樣讓整頁從第 10 段開始的。
 *
 * 用 AST 掃「任何一個 VariableDeclarator 的初始值裡出現 nextStep 的呼叫」，
 * 所以連 `const n = nextStep()` 這種也一起抓得到。**不用 grep**：這個檔案的註解裡
 * 就寫著這個反例的字面樣子，grep 版本會被自己的警告文字餵飽。
 */
const prematureSteps = [];
walkAst(assemblerAst.program, (n) => {
  if (n.type !== "VariableDeclarator" || !n.init) return;
  // nextStep 自己的定義（const nextStep = () => (step += 1)）不算。
  if (n.id?.type === "Identifier" && n.id.name === "nextStep") return;
  let hit = false;
  walkAst(n.init, (m) => {
    if (
      m.type === "CallExpression" &&
      m.callee?.type === "Identifier" &&
      m.callee.name === "nextStep"
    ) {
      hit = true;
    }
  });
  if (hit) prematureSteps.push(n.loc?.start?.line ?? 0);
});
check(
  "🔴 沒有任何 `const … = (…nextStep()…)`（提前領號會讓整頁從第 N 段開始全錯）",
  prematureSteps,
  [],
);

// nextStep 只有一支，而且它就是 +1。
let nextStepDefs = 0;
walkAst(assemblerAst.program, (n) => {
  if (n.type === "VariableDeclarator" && n.id?.type === "Identifier" && n.id.name === "nextStep") {
    nextStepDefs += 1;
    const body = n.init?.body;
    const isPlusOne =
      body?.type === "AssignmentExpression" &&
      body.operator === "+=" &&
      body.right?.type === "NumericLiteral" &&
      body.right.value === 1;
    checkTrue("nextStep() 就是「往前一號」（step += 1）", isPlusOne);
  }
});
check("nextStep 只定義一次", nextStepDefs, 1);

// =============================================================================
// [5] 雷 5：ImageField 不可以包在 <FormControl> 裡
// =============================================================================
console.log("\n[5] ImageField 與 FormControl");

/**
 * 🔴 這一條掃的是**整個 src/**，不是只掃組裝器。釘死單一檔案路徑的斷言在程式碼搬家
 *    之後會靜默失去覆蓋 —— 而這一期就是一次搬家（表單從 _shell.events.tsx 搬到
 *    _shell.events.$id.tsx）。
 *
 * ⚠️ 而且**先數 ImageField 出現幾次**：一條「FormControl 底下沒有 ImageField」的斷言，
 *    在整個 repo 一個 ImageField 都沒有的時候也是綠的 —— 那種綠燈什麼都沒有在守。
 */
let imageFieldUses = 0;
const imageFieldInFormControl = [];
for (const abs of SRC_FILES.filter((f) => f.endsWith(".tsx"))) {
  const rel = relative(ROOT, abs);
  let ast;
  try {
    ast = parseTsx(readFileSync(abs, "utf8"), rel);
  } catch (err) {
    fail += 1;
    console.log(red(`  ✗ ${rel} 解析失敗：${err.message}`));
    continue;
  }
  walkAst(ast.program, (n) => {
    if (n.type !== "JSXElement") return;
    if (jsxName(n) === "ImageField") imageFieldUses += 1;
    if (jsxName(n) !== "FormControl") return;
    walkAst(n.children, (m) => {
      if (m.type === "JSXElement" && jsxName(m) === "ImageField") {
        imageFieldInFormControl.push(`${rel}:${m.loc?.start?.line ?? 0}`);
      }
    });
  });
}
checkTrue(
  "src/ 底下真的有人用 ImageField（否則下面那條否定斷言是空的）",
  imageFieldUses >= 2,
  `實得 ${imageFieldUses} 處`,
);
check(
  "🔴 沒有任何一處 ImageField 被包在 <FormControl> 裡（Slot 的 ref cloning 會噴 warning）",
  imageFieldInFormControl,
  [],
);
// 組裝器自己有那一欄（不然上面那條與這一頁無關）。
let assemblerHasImageField = false;
walkAst(assemblerAst.program, (n) => {
  if (n.type === "JSXElement" && jsxName(n) === "ImageField") assemblerHasImageField = true;
});
checkTrue("組裝器上有活動圖片欄位", assemblerHasImageField);

// =============================================================================
// [6] 雷 1：主儲存之後不 bump formKey
// =============================================================================
console.log("\n[6] 主儲存之後怎麼收尾");

const identifiers = new Set();
const memberProps = new Set();
walkAst(assemblerAst.program, (n) => {
  if (n.type === "Identifier") identifiers.add(n.name);
  if (n.type === "JSXIdentifier") identifiers.add(n.name);
  if (n.type === "MemberExpression" && n.property?.type === "Identifier") {
    memberProps.add(n.property.name);
  }
});
checkFalse(
  "🔴 組裝器裡沒有 setFormKey（remount 會把每個區塊編輯器的非受控輸入清空）",
  identifiers.has("setFormKey"),
);
checkFalse("🔴 組裝器裡沒有 formKey", identifiers.has("formKey"));
checkTrue("存完之後有 router.invalidate()", memberProps.has("invalidate"));
// form.reset(nextValues) —— 有參數的 reset 才是「重新對準剛存回來的那一份」。
let resetWithArg = false;
walkAst(assemblerAst.program, (n) => {
  if (
    n.type === "CallExpression" &&
    n.callee?.type === "MemberExpression" &&
    n.callee.property?.name === "reset" &&
    n.arguments.length === 1
  ) {
    resetWithArg = true;
  }
});
checkTrue("存完之後有 form.reset(新值)（取代 remount）", resetWithArg);

// =============================================================================
// [7] 雷 3：handleSubmit 一定要有第二個參數
// =============================================================================
console.log("\n[7] handleSubmit 的第二個參數");

const handleSubmitCalls = [];
walkAst(assemblerAst.program, (n) => {
  if (
    n.type === "CallExpression" &&
    n.callee?.type === "MemberExpression" &&
    n.callee.property?.name === "handleSubmit"
  ) {
    handleSubmitCalls.push(n.arguments.length);
  }
});
check("組裝器只有一處 handleSubmit", handleSubmitCalls.length, 1);
check(
  "🔴 handleSubmit 傳了兩個參數（少了 onInvalid，驗證失敗時會什麼都不做）",
  handleSubmitCalls,
  [2],
);
// onInvalid 真的會 toast，不是一個空函式。
const invalidFn = assemblerSrc.slice(
  assemblerSrc.indexOf("function handleInvalid"),
  assemblerSrc.indexOf("function toggleSell"),
);
checkTrue("handleInvalid 真的 toast", /toast\.error\(/.test(invalidFn));
checkTrue("而且那句話是 invalidToastMessage() 產的", /invalidToastMessage\(/.test(invalidFn));

// =============================================================================
// [8] 雷 2：主表單是一個空的隱藏 <form>，儲存鈕靠 form= 歸隊
// =============================================================================
console.log("\n[8] 主表單的 <form>");

const formElements = [];
walkAst(assemblerAst.program, (n) => {
  if (n.type === "JSXElement" && jsxName(n) === "form") formElements.push(n);
});
check("組裝器上剛好一個 <form> 元素（HTML 的 form 不能巢狀）", formElements.length, 1);
if (formElements.length === 1) {
  const f = formElements[0];
  const realChildren = (f.children ?? []).filter(
    (c) => c.type !== "JSXText" || c.value.trim().length > 0,
  );
  check("🔴 那個 <form> 是空的（區塊編輯器要能在它外面開自己的 form）", realChildren.length, 0);
  checkTrue("它有 id", jsxAttr(f, "id") !== null);
  check("它是隱藏的", jsxAttrString(f, "className"), "hidden");
  checkTrue("它掛著 onSubmit", jsxAttr(f, "onSubmit") !== null);
}
// 儲存鈕用 form= 屬性歸隊。
let submitButtons = 0;
let submitButtonsWithFormAttr = 0;
walkAst(assemblerAst.program, (n) => {
  if (n.type !== "JSXElement" || jsxName(n) !== "Button") return;
  if (jsxAttrString(n, "type") !== "submit") return;
  submitButtons += 1;
  if (jsxAttr(n, "form") !== null) submitButtonsWithFormAttr += 1;
});
check("有一顆送出鈕", submitButtons, 1);
check("🔴 送出鈕用 form= 屬性歸隊到那個隱藏的 <form>", submitButtonsWithFormAttr, 1);
checkTrue(
  'CONTENT_FORM_ID 的值是 "event-content"',
  /const CONTENT_FORM_ID = "event-content";/.test(assemblerSrc),
);

// =============================================================================
// [9] 雷 6 的第三層：useBlocker + beforeunload
// =============================================================================
console.log("\n[9] 離開頁面的守衛");

const handleValidSrcForGuard = assemblerSrc.slice(
  assemblerSrc.indexOf("async function handleValid"),
  assemblerSrc.indexOf("function handleInvalid"),
);
checkTrue("切得出 handleValid()（給離開守衛那幾條用）", handleValidSrcForGuard.length > 0);

let blockerOpts = null;
walkAst(assemblerAst.program, (n) => {
  if (
    n.type === "CallExpression" &&
    n.callee?.type === "Identifier" &&
    n.callee.name === "useBlocker"
  ) {
    blockerOpts = n.arguments[0];
  }
});
checkTrue("組裝器有呼叫 useBlocker()", blockerOpts !== null);
if (blockerOpts?.type === "ObjectExpression") {
  const keys = blockerOpts.properties.map((p) => p.key?.name).filter(Boolean);
  checkTrue("useBlocker 有 shouldBlockFn（站內換頁）", keys.includes("shouldBlockFn"));
  checkTrue(
    "🔴 useBlocker 有 enableBeforeUnload（關分頁／重新整理）",
    keys.includes("enableBeforeUnload"),
  );
  checkTrue("withResolver: true（才畫得出自己的確認框）", keys.includes("withResolver"));
}
/**
 * 🔴 「新增」存完之後那一次導頁不可以被自己的守衛攔下來。
 *
 * form.reset() 讓 isDirty 變成 false，但那要等下一次 render 才反映到守衛看的那個值上，
 * 而 navigate() 就在這一次 render 裡 —— 所以放行必須走 ref（當下的值），而且要在
 * navigate 之前設。這裡驗的是那個順序。
 */
const bypassSet = handleValidSrcForGuard.indexOf("bypassLeaveGuard.current = true");
const navigateAt = handleValidSrcForGuard.indexOf("await navigate(");
checkTrue("儲存路徑裡有離開守衛的放行 ref", bypassSet >= 0);
checkTrue("而且它設在 navigate() 之前", bypassSet >= 0 && navigateAt > bypassSet);
checkTrue(
  "shouldBlockFn 讀的是 ref 的當下值（不是這一次 render 凍住的 boolean）",
  /shouldBlockLeaving = \(\) => pageDirty && !bypassLeaveGuard\.current/.test(assemblerSrc),
);

// 不可以自己再掛一個 beforeunload —— 兩個監聽器會讓同一次關閉跳兩次確認。
//
// ⚠️ 這一條用 AST。regex 版本在這一頁一定是紅的，因為檔案裡那段**警告文字本身**就寫著
//    addEventListener("beforeunload") —— 正是「斷言被註解內容餵飽」的同一個家族，
//    只是方向相反（假陰性變成假陽性）。
let ownBeforeUnload = 0;
walkAst(assemblerAst.program, (n) => {
  if (n.type !== "CallExpression") return;
  if (n.callee?.type !== "MemberExpression") return;
  if (n.callee.property?.name !== "addEventListener") return;
  if (n.arguments[0]?.type === "StringLiteral" && n.arguments[0].value === "beforeunload") {
    ownBeforeUnload += 1;
  }
});
check("沒有自己再掛一個 beforeunload 監聽器（@tanstack/history 已經掛了）", ownBeforeUnload, 0);

// =============================================================================
// [10] 五個 MirrorNote
// =============================================================================
console.log("\n[10] MirrorNote");

const mirrorNotes = [];
walkAst(assemblerAst.program, (n) => {
  if (n.type !== "JSXElement" || jsxName(n) !== "MirrorNote") return;
  mirrorNotes.push({
    label: jsxAttrString(n, "label"),
    direction: jsxAttrString(n, "direction") ?? "mirror",
    to: jsxAttrString(n, "to"),
  });
});
check("剛好五個 MirrorNote", mirrorNotes.length, 5);
check(
  "五塊分別是：講者／活動分類／活動地點／報名名單／這場活動的商品",
  mirrorNotes.map((m) => m.label).sort(),
  ["這場活動的商品", "報名名單", "活動分類", "活動地點", "講者"].sort(),
);
check(
  "🔴 只有「這場活動的商品」是方向相反的那一塊",
  mirrorNotes.filter((m) => m.direction === "source").map((m) => m.label),
  ["這場活動的商品"],
);
for (const [label, to] of [
  ["講者", "/admin/artists"],
  ["活動分類", "/admin/categories"],
  ["報名名單", "/admin/registrations"],
  ["這場活動的商品", "/admin/products"],
]) {
  check(`「${label}」連到 ${to}`, mirrorNotes.find((m) => m.label === label)?.to, to);
}
// 「活動地點」的真相是最近一場場次，所以它的資料要來自 listSessionsForEvent。
checkTrue(
  "「活動地點」的值取自場次（listSessionsForEvent）",
  /listSessionsForEvent/.test(assemblerSrc),
);
// 那一塊在畫面上要講出「這裡改不動 / 這裡會覆蓋那邊」，而不是只有一個連結。
const mirrorSrc = readFile("src/components/admin/MirrorNote.tsx");
checkTrue("mirror 方向講「真相在別的地方」", mirrorSrc.includes("這一欄在這裡改不動"));
checkTrue("source 方向講「會被蓋回去」", mirrorSrc.includes("會被蓋回去"));

// =============================================================================
// [11] 七個清單欄位
// =============================================================================
console.log("\n[11] 七個清單欄位");

const listFieldNames = [];
walkAst(assemblerAst.program, (n) => {
  if (n.type !== "JSXElement" || jsxName(n) !== "LocalizedListField") return;
  listFieldNames.push({
    name: jsxAttrString(n, "name"),
    optional: jsxAttr(n, "optional") !== null,
  });
});
check(
  "七個清單欄位都在畫面上，而且就是 EVENT_LIST_FIELDS 那七個",
  listFieldNames.map((f) => f.name).sort(),
  [...EVENT_LIST_FIELDS].sort(),
);
checkTrue(
  "🔴 七個都是 optional（整組留空＝這一塊關掉，不是驗證失敗）",
  listFieldNames.length === 7 && listFieldNames.every((f) => f.optional),
);

// schema 的行為（產線那一份）。
const { optionalLocalizedListSchema, optionalLocalizedLinesFormSchema } = schemas;
check(
  "🔴 三語全空是合法的送出值（＝這一塊關掉）",
  optionalLocalizedListSchema.safeParse({ zh: [], en: [], ja: [] }).success,
  true,
);
check(
  "三語各三項是合法的",
  optionalLocalizedListSchema.safeParse({
    zh: ["a", "b", "c"],
    en: ["a", "b", "c"],
    ja: ["a", "b", "c"],
  }).success,
  true,
);
check(
  "🔴 只填一半（中文有、英日空）擋下來",
  optionalLocalizedListSchema.safeParse({ zh: ["a"], en: [], ja: [] }).success,
  false,
);
check(
  "表單端：三個 textarea 全空是合法的",
  optionalLocalizedLinesFormSchema.safeParse({ zh: "", en: "", ja: "" }).success,
  true,
);
check(
  "表單端：只填中文擋下來",
  optionalLocalizedLinesFormSchema.safeParse({ zh: "一\n二", en: "", ja: "" }).success,
  false,
);
check(
  "表單端：三語都填得上就過",
  optionalLocalizedLinesFormSchema.safeParse({ zh: "一\n二", en: "a\nb", ja: "あ\nい" }).success,
  true,
);
check("linesToList 三行就是三項", linesToList("一\n二\n三").length, 3);
check("空行不算一項", linesToList("一\n\n二\n\n三\n").length, 3);

// 組裝器送出前真的呼叫 linesToList（三語各一次）。
const handleValidSrc = assemblerSrc.slice(
  assemblerSrc.indexOf("async function handleValid"),
  assemblerSrc.indexOf("function handleInvalid"),
);
checkTrue("切得出 handleValid()", handleValidSrc.length > 0);
for (const lang of ["zh", "en", "ja"]) {
  checkTrue(
    `送出前把 ${lang} 的一行一項換成陣列`,
    handleValidSrc.includes(`linesToList(values[f].${lang})`),
  );
}
checkTrue(
  "而且七欄是照 EVENT_LIST_FIELDS 跑的，不是抄第二份名單",
  handleValidSrc.includes("EVENT_LIST_FIELDS.map"),
);

// =============================================================================
// [12] 一顆儲存鈕 = 一支 server fn = 一次 RPC
// =============================================================================
console.log("\n[12] 儲存路徑");

checkTrue(
  "組裝器呼叫 upsertEventWithProduct()",
  handleValidSrc.includes("upsertEventWithProduct("),
);
checkFalse(
  "🔴 組裝器沒有第二條寫入路徑（不會有一半寫進去、一半沒有）",
  /\bupsertEvent\(\s*\{/.test(handleValidSrc),
);
checkFalse(
  "🔴 後台沒有直接寫 products 表（投影規則只住在 SQL 裡）",
  /from\("products"\)/.test(assemblerSrc),
);
// 送出時不可以再打一次翻譯 —— 翻譯只發生在按那顆按鈕的當下。
checkFalse(
  "🔴 送出路徑不會發翻譯請求（翻譯只在 LocalizedListField 的按鈕上）",
  /translateToEnJa/.test(assemblerSrc),
);
checkTrue(
  "翻譯的唯一家還在 LocalizedListField",
  readFile("src/components/admin/LocalizedListField.tsx").includes("translateToEnJa"),
);
// 行數對不上時：照樣寫進去、跳警告、而且強制攤開（Collapsible 不准收）。
const listFieldSrc = readFile("src/components/admin/LocalizedListField.tsx");
checkTrue("行數對不上會跳 toast.warning", /toast\.warning\(/.test(listFieldSrc));
checkTrue(
  "行數對不上會強制攤開",
  /if \(enResult\.length !== source\.length[\s\S]{0,200}setManuallyOpen\(true\)/.test(listFieldSrc),
);
checkTrue(
  "而且在對齊之前不准收起來",
  /if \(\(missing \|\| mismatched\) && !next\) return;/.test(listFieldSrc),
);

// server fn / repo 這一側
const fnsSrc = readFile("src/lib/admin/fns/events.ts");
checkTrue(
  "fns 用 EVENT_LIST_FIELDS 組 lists，不是抄第二份名單",
  fnsSrc.includes("EVENT_LIST_FIELDS.filter"),
);
const repoSrc = readFile("src/server/repos/events.ts");
for (const f of EVENT_LIST_FIELDS) {
  checkTrue(
    `repo 的 COLUMNS 讀得到 ${f}`,
    new RegExp(`COLUMNS =[\\s\\S]{0,600}\\b${f}\\b`).test(repoSrc),
  );
}
checkTrue(
  "🔴 repo 送 RPC 時，沒給值的欄位整個 key 都不放（＝那一欄不動）",
  /EVENT_LIST_FIELDS\.filter\(\(f\) => input\.lists\?\.\[f\] !== undefined\)/.test(repoSrc),
);
// 0029：後台要**讀得回**這一欄，否則表單永遠拿到 undefined，而 toFormValues 的
// `?? true` 會把它畫成「開著」—— 店家關掉、重新整理、發現又開回來了，沒有錯誤訊息。
checkTrue(
  "repo 的 COLUMNS 讀得到 show_seats_remaining",
  /COLUMNS =[\s\S]{0,900}\bshow_seats_remaining\b/.test(repoSrc),
);
// 只寫 events 的那條路徑（不上架的活動走它）也要寫這一欄 —— 它是 upsert 不是 patch，
// 漏掉會撞 NOT NULL，而不是「沿用舊值」。
checkTrue(
  "upsertEvent()（只寫 events 的那條路）也帶了這一欄",
  /show_seats_remaining: input\.show_seats_remaining \?\? true,/.test(repoSrc),
);
// 走 RPC 的那條路要遵守「沒給值就整個 key 不放」的同一條規則。
checkTrue(
  "🔴 走 RPC 的那條路，沒給值時整個 key 不放進 payload",
  /input\.show_seats_remaining === undefined\s*\n?\s*\? \{\}/.test(repoSrc),
);

// =============================================================================
// [13] 列表頁：表單搬走了，不是複製一份
// =============================================================================
console.log("\n[13] 列表頁與組裝器的分工");

const listPageSrc = readFile("src/routes/admin/_shell.events.tsx");
checkTrue("列表頁會渲染 <Outlet />（否則子頁會疊在列表上）", listPageSrc.includes("<Outlet />"));
checkTrue(
  "列表頁只在 /admin/events 這個路徑本身顯示列表",
  /pathname === "\/admin\/events"/.test(listPageSrc),
);
checkFalse("🔴 列表頁已經沒有活動表單（欄位只有一個家）", listPageSrc.includes("<FormField"));
checkFalse("列表頁沒有 LocalizedField", listPageSrc.includes("LocalizedField"));
checkFalse("列表頁沒有 ImageField", listPageSrc.includes("ImageField"));
checkTrue("列表頁的「編輯」連到組裝器", listPageSrc.includes('to="/admin/events/$id"'));
checkTrue("列表頁的「新增」也連到組裝器", listPageSrc.includes('params={{ id: "new" }}'));
// 固定欄位在組裝器上真的都在（搬家不能掉東西）。
const fieldNames = new Set();
walkAst(assemblerAst.program, (n) => {
  if (n.type !== "JSXElement") return;
  const nm = jsxName(n);
  if (nm !== "FormField" && nm !== "LocalizedField") return;
  const v = jsxAttrString(n, "name");
  if (v) fieldNames.add(v);
});
for (const f of [
  "slug",
  "title",
  "summary",
  "description",
  "display_date",
  "iso_date",
  "category",
  "speaker_id",
  "image_key",
  "external_url",
  "registration_type",
  "payment_enabled",
  // 0029：名額顯示的開關。它跟名額、售票是同一類設定，所以在 §4，不是活動內容那一段。
  "show_seats_remaining",
  "is_published",
  "sort_order",
  "product.price",
  "product.compare_at_price",
  "product.status",
]) {
  checkTrue(`組裝器上有 ${f}`, fieldNames.has(f));
}
// 那五個投影欄位不准在後台開第二個家。
for (const forbidden of [
  "product.description",
  "product.summary",
  "product.title",
  "product.slug",
]) {
  checkFalse(`🔴 組裝器沒有 ${forbidden}（那五樣是從活動投影過去的）`, fieldNames.has(forbidden));
}
// 0029：show_seats_remaining 也是投影欄位（events → products），所以商品那一段
// **不准**再開一個同名欄位 —— 開了就是替同一個事實開第二個家，而且 0029 的
// products_pull_seats_visibility trigger 會把使用者在那裡填的值蓋掉（一個改了沒用
// 的欄位比沒有欄位更糟）。
checkFalse(
  "🔴 組裝器沒有 product.show_seats_remaining（那是從活動投影過去的衍生值）",
  fieldNames.has("product.show_seats_remaining"),
);
// 這個開關必須落在「報名與售票」那一段，不是被塞到活動內容裡。段落是用
// <Section title="…"> 分的，所以這裡切出那一段的 JSX 再看欄位在不在裡面。
{
  const at = assemblerSrc.indexOf('title="報名與售票"');
  checkTrue("找得到「報名與售票」那一段", at > 0);
  // 🔴 **先剝註解再比對。** 這一段旁邊就有一則 JSX 註解寫著「『已額滿』不受影響，
  //    永遠會顯示」—— 不剝的話，下面那條「說明文字寫明已額滿不受影響」會被**註解**
  //    餵飽：把真正給店家看的那句話從畫面上刪掉，斷言照樣是綠的。
  //    （寫這條斷言時第一版就是這樣，做突變測試才抓出來。）
  const sectionJsx = assemblerSrc
    .slice(at, assemblerSrc.indexOf("</Section>", at))
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  checkTrue("反空殼：那一段切得出內容", sectionJsx.length > 500);
  checkFalse("反餵飽：剝完之後那一段裡沒有殘留的註解標記", /\/\*|\*\//.test(sectionJsx));
  checkTrue(
    "🔴 名額顯示開關在「報名與售票」那一段裡",
    /name="show_seats_remaining"/.test(sectionJsx),
  );
  // 說明文字必須講出「關掉之後已額滿還是會顯示」—— 沒有這句話，店家會以為
  // 關掉開關等於把整張卡片的狀態藏起來，而那正是這個開關**不做**的事。
  checkTrue(
    "🔴 說明文字寫明「已額滿」不受影響",
    /已額滿[\s\S]{0,40}顯示|顯示[\s\S]{0,40}已額滿/.test(sectionJsx),
  );
}
// 新增的活動預設**顯示**（＝ 0029 的欄位預設，也是這一期之前的行為）。
// 寫成 `?? false` 會讓每一場新活動都安靜地把名額藏起來。
checkTrue(
  "🔴 toFormValues 對新活動回 true（預設顯示，不是預設藏起來）",
  /show_seats_remaining: row\?\.show_seats_remaining \?\? true,/.test(assemblerSrc),
);
checkTrue(
  "eventSchema 收得下 show_seats_remaining（server fn 的門）",
  "show_seats_remaining" in schemas.eventSchema.shape,
);
// journeys 與 events 共用 registrationFields，而 public.journeys 沒有這一欄 ——
// 掛在共用那一組上會讓策旅表單多送一個資料庫不認得的欄位。
checkFalse(
  "🔴 沒有掛到 journeySchema 上（那張表沒有這一欄）",
  "show_seats_remaining" in schemas.journeySchema.shape,
);
// slug 那句 404 警告要跟著搬過來。
checkTrue(
  "🔴 slug 的說明還寫著「改代稱會讓已經發出去的舊網址 404」",
  assemblerSrc.includes("404") && assemblerSrc.includes("已經發出去"),
);

// =============================================================================
// [連線] 七個清單欄位真的存得進去、三語都是三項
// =============================================================================
console.log("\n[連線] 真的存一次（BEGIN … ROLLBACK）");

if (!PG_URL) {
  skipped.push("[連線] 沒有設 EVENT_ASSEMBLER_SELFTEST_PG_URL，整段跳過");
  console.log(yellow("  ⚠ 跳過：沒有設 EVENT_ASSEMBLER_SELFTEST_PG_URL"));
} else {
  const three = { zh: ["一", "二", "三"], en: ["one", "two", "three"], ja: ["いち", "に", "さん"] };
  // 🔴 payload 的七個 key 用**產線的 EVENT_LIST_FIELDS**，值用**產線的 linesToList()**
  //    產生 —— 不是在這裡手打七個名字與三個陣列。
  const listPayload = Object.fromEntries(
    EVENT_LIST_FIELDS.map((f) => [
      f,
      {
        zh: linesToList(three.zh.join("\n")),
        en: linesToList(three.en.join("\n")),
        ja: linesToList(three.ja.join("\n")),
      },
    ]),
  );
  const payload = {
    event: {
      id: "d3-selftest-event",
      slug: "d3-selftest-event",
      title: { zh: "自檢", en: "selftest", ja: "セルフテスト" },
      summary: { zh: "自檢", en: "selftest", ja: "セルフテスト" },
      description: { zh: "自檢", en: "selftest", ja: "セルフテスト" },
      display_date: "2026.01.01",
      category: "d3-selftest-cat",
      external_url: "https://example.com/e",
      registration_type: "external",
      payment_enabled: false,
      is_published: false,
      sort_order: 0,
      ...listPayload,
    },
    product: null,
  };

  const sql = `
begin;
insert into public.event_categories (id, label, sort_order)
  values ('d3-selftest-cat', '{"zh":"自檢","en":"selftest","ja":"セルフテスト"}'::jsonb, 999);
select public.admin_upsert_event_with_session($json$${JSON.stringify(payload)}$json$::jsonb) is not null as rpc_ok;
select ${EVENT_LIST_FIELDS.map(
    (f) =>
      `jsonb_array_length(${f}->'zh')::text || ',' || jsonb_array_length(${f}->'en')::text || ',' || jsonb_array_length(${f}->'ja')::text as ${f}`,
  ).join(", ")}
  from public.events where id = 'd3-selftest-event';
rollback;
`;

  try {
    const { stdout } = await execFileAsync("psql", [
      PG_URL,
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-F",
      "|",
      "-c",
      sql,
    ]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    checkTrue(
      "RPC 有回東西",
      lines.some((l) => l.trim() === "t"),
      stdout,
    );
    // psql 會把 BEGIN／INSERT 0 1／ROLLBACK 這些 command tag 一起印在 stdout 上，
    // 所以**不能**直接拿最後一行 —— 挑那一行「N,N,N|N,N,N|…」出來。
    const countLine = lines.find((l) => /^\d+,\d+,\d+(\|\d+,\d+,\d+)*$/.test(l.trim()));
    checkTrue("找得到那一行數量", Boolean(countLine), stdout);
    const counts = (countLine ?? "").trim().split("|");
    check(
      `🔴 七欄 × 三語，每一格都是 3 項`,
      counts,
      EVENT_LIST_FIELDS.map(() => "3,3,3"),
    );
    console.log(`      ${EVENT_LIST_FIELDS.map((f, i) => `${f}=${counts[i]}`).join("  ")}`);
  } catch (err) {
    fail += 1;
    console.log(red(`  ✗ [連線] 失敗：${err.stderr || err.message}`));
  }
}

// -----------------------------------------------------------------------------
console.log("\n────────────────────────────────────────────────────");
for (const s of skipped) console.log(yellow(`⚠ ${s}`));
console.log(`${pass} passed, ${fail} failed`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
