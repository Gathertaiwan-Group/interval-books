#!/usr/bin/env node
/**
 * 後台第 2 批（2026-10-25）：/admin/products 的「商品／刊物／選品」編輯與新增從彈窗改成內頁。
 * 業主：「不要用彈窗，直接顯示內頁＆回到上一頁」。
 *
 *   [1] 純邏輯（直接 import src/lib/admin/unified-products.ts）：清單一列 → 哪一個內頁；
 *       網址參數的 id 怎麼擋（products／publications 是 text pk、curated_items 是 bigint）。
 *   [2] 每一個內頁 route 的 loader 只叫一支 fn；那支 fn 是 GET，授權 middleware 與原本的
 *       存檔 fn（upsertProduct／updatePublication／upsertCuratedItem）**一字不差**——不可放寬。
 *   [3] 表單內頁：useUnsavedChangesGuard + guard.dialog；存檔成功 allowLeave → invalidate
 *       → 回上一頁或 navigate（順序）；每張表單往上報 dirty；只在掛載時初始化（key=）。
 *   [4] 清單：「編輯」是 <Link preload="intent"> + rememberAdminPeek；$id 內頁有
 *       pendingComponent 用 peek 先畫標題；搜尋／狀態／排序記在 list-memory；沒有 loader 副本。
 *   [5] 舊的編輯／新增彈窗已移除；該留的對話框（連到庫存、解除連結、刪除、主題名稱）還在。
 *
 * 執行：node scripts/admin-detail-products-selftest.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-detail-products-selftest.mjs";
let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    fail += 1;
    console.log(
      `  \x1b[31m✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}\x1b[0m`,
    );
  }
}
const checkTrue = (label, v) => check(label, !!v, true);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
const code = (rel) => stripComments(read(rel));
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const R = (f) => `src/routes/admin/${f}`;
const LIST = R("_shell.products.tsx");
const THEMES = R("_shell.products_.curated-themes.tsx");
const P = "src/components/admin/products/";

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] 純邏輯：一列 → 內頁、網址 id");
{
  const up = await imp("src/lib/admin/unified-products.ts");
  check("一般商品 → product", up.detailKindFor({ kind: "goods", eventId: null }), "product");
  check(
    "沒有活動頁的票券（策旅）→ product",
    up.detailKindFor({ kind: "ticket", eventId: null }),
    "product",
  );
  check(
    "🔴 活動票券（有 eventId）→ null（連到活動頁，不在這裡另做一份）",
    up.detailKindFor({ kind: "ticket", eventId: "e1" }),
    null,
  );
  check(
    "刊物 → publication",
    up.detailKindFor({ kind: "publication", eventId: null }),
    "publication",
  );
  check("選品 → curated", up.detailKindFor({ kind: "curated", eventId: null }), "curated");

  check("text id：uuid 可以", up.isProductTextId("4f1c2a52-0d3e-4b44-9b1c-6a0e7f1f2b3c"), true);
  check(
    "text id：seed 的文字 id 可以（products／publications 是 text pk）",
    up.isProductTextId("tw-001"),
    true,
  );
  check("text id：空字串不行", up.isProductTextId(""), false);
  check("text id：有空白不行", up.isProductTextId("a b"), false);
  check("text id：有斜線不行", up.isProductTextId("a/b"), false);
  check("text id：太長不行", up.isProductTextId("x".repeat(201)), false);
  check("text id：不是字串不行", up.isProductTextId(42), false);

  check("選品 id：正整數字串", up.parseCuratedItemId("17"), 17);
  check("選品 id：0 不行", up.parseCuratedItemId("0"), null);
  check("選品 id：前導 0 不行", up.parseCuratedItemId("017"), null);
  check("選品 id：負數不行", up.parseCuratedItemId("-3"), null);
  check("選品 id：小數不行", up.parseCuratedItemId("1.5"), null);
  check("選品 id：new 不行（new 是新增頁）", up.parseCuratedItemId("new"), null);
  check("選品 id：超過安全整數不行", up.parseCuratedItemId("9999999999999999"), null);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] loader 一支 fn、授權與原本的存檔 fn 相同");
{
  const fnSrc = (f) => code(`src/lib/admin/fns/${f}.ts`);
  /** fn 宣告的 method 與 middleware 陣列內容（原樣字串）。 */
  function decl(file, name) {
    const m = fnSrc(file).match(
      new RegExp(
        `export const ${name} = createServerFn\\(\\{ method: "(\\w+)" \\}\\)\\s*\\.middleware\\(\\[([^\\]]*)\\]\\)`,
      ),
    );
    return m ? { method: m[1], mw: m[2].trim() } : null;
  }
  const ORIGINAL = {
    upsertProduct: decl("products", "upsertProduct"),
    updatePublication: decl("publications", "updatePublication"),
    upsertCuratedItem: decl("curated", "upsertCuratedItem"),
  };
  for (const [n, d] of Object.entries(ORIGINAL)) {
    check(`原本的存檔 fn ${n} 掛 adminFnMiddleware（基準）`, d?.mw, "adminFnMiddleware");
  }

  // [route 檔, loader 叫的整頁 fn, 對應的原本存檔 fn]
  const ROUTES = [
    ["_shell.products_.product.$id.tsx", "getProductEditPageData", "upsertProduct"],
    ["_shell.products_.product.new.tsx", "getNewGoodsPageData", "upsertProduct"],
    ["_shell.products_.publication.$id.tsx", "getPublicationEditPageData", "updatePublication"],
    ["_shell.products_.curated.$id.tsx", "getCuratedItemEditPageData", "upsertCuratedItem"],
    ["_shell.products_.curated.new.tsx", "getCuratedItemNewPageData", "upsertCuratedItem"],
  ];
  for (const [route, fn, original] of ROUTES) {
    const src = code(R(route));
    const loader = src.slice(src.indexOf("loader:"), src.indexOf("head:"));
    checkTrue(`${route}：loader 叫 ${fn}`, loader.includes(`${fn}(`));
    const calls = [...loader.matchAll(/\b(get|list)\w+\(\{|\b(get|list)\w+\(\)/g)].length;
    check(`${route}：loader 只叫一支 fn`, calls, 1);
    const d = decl("products", fn);
    check(`🔴 ${fn}：GET`, d?.method, "GET");
    check(`🔴 ${fn}：middleware 與 ${original} 一字不差`, d?.mw, ORIGINAL[original]?.mw);
    checkTrue(`${route}：head() 給標題`, /head:[\s\S]{0,300}小時光書店後台/.test(src));
  }

  // 每一支 fn 都先掛 middleware（新加的不可以漏）。
  const products = fnSrc("products");
  const decls = [...products.matchAll(/export const (\w+) = createServerFn\([^)]*\)\s*(\.\w+)/g)];
  check(
    "🔴 fns/products.ts：每一支 server fn 都先掛 middleware",
    decls.filter((m) => m[2] !== ".middleware").map((m) => m[1]),
    [],
  );

  // 網址 id 先擋再查
  checkTrue(
    "商品編輯 loader：isProductTextId 擋網址 id",
    /if \(!isProductTextId\(params\.id\)\) return \{ product: null \}/.test(
      code(R("_shell.products_.product.$id.tsx")),
    ),
  );
  checkTrue(
    "刊物編輯 loader：isProductTextId 擋網址 id",
    /if \(!isProductTextId\(params\.id\)\) return \{ publication: null \}/.test(
      code(R("_shell.products_.publication.$id.tsx")),
    ),
  );
  checkTrue(
    "選品編輯 loader：parseCuratedItemId 擋網址 id",
    /parseCuratedItemId\(params\.id\);\s*if \(id === null\) return/.test(
      code(R("_shell.products_.curated.$id.tsx")),
    ),
  );
  checkTrue(
    "🔴 活動投影的商品直接打網址 → 轉去活動頁（不另開一條會互相覆蓋的編輯路徑）",
    /product\?\.source_type === "event" && product\.source_id\)\s*\{\s*throw redirect\(\{ to: "\/admin\/events\/\$id"/.test(
      code(R("_shell.products_.product.$id.tsx")),
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 表單內頁：未存變更防呆、存檔後換頁、只初始化一次");
{
  const page = code(`${P}ProductFormPage.tsx`);
  checkTrue(
    "🔴 ProductFormPage：掛 useUnsavedChangesGuard(dirty)（存檔中也攔，成功由 allowLeave 放行）",
    /useUnsavedChangesGuard\(dirty\)/.test(page),
  );
  checkTrue("ProductFormPage：渲染 guard.dialog", /\{guard\.dialog\}/.test(page));
  const order = [
    "guard.allowLeave()",
    "router.invalidate({ sync: true })",
    "backIfPreviousIs(",
    "router.navigate(",
  ].map((s) => page.indexOf(s));
  checkTrue(
    "🔴 存檔成功：allowLeave → invalidate → backIfPreviousIs → navigate（replace）",
    order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]),
  );
  checkTrue("navigate 用 replace（上一頁不會回到填好的表單）", /replace: true/.test(page));
  checkTrue(
    "送出鈕在動作列（type=submit form={formId}），內容底部再放一份",
    /type="submit" form=\{formId\}/.test(page) && /hidden justify-end md:flex/.test(page),
  );

  const PAGES = [
    "_shell.products_.product.$id.tsx",
    "_shell.products_.product.new.tsx",
    "_shell.products_.publication.$id.tsx",
    "_shell.products_.curated.$id.tsx",
    "_shell.products_.curated.new.tsx",
  ];
  for (const f of PAGES) {
    const src = code(R(f));
    checkTrue(`${f}：用 ProductFormPage（防呆在那一層）`, src.includes("<ProductFormPage"));
    checkTrue(`${f}：表單接上 onDirtyChange`, /onDirtyChange=\{slot\.onDirtyChange\}/.test(src));
  }
  for (const f of [
    "_shell.products_.product.$id.tsx",
    "_shell.products_.publication.$id.tsx",
    "_shell.products_.curated.$id.tsx",
  ]) {
    checkTrue(
      `${f}：key={id}（換一筆＝重新掛載）`,
      /key=\{(product|publication|item)\.id\}/.test(code(R(f))),
    );
  }

  for (const f of [
    "ProductForm.tsx",
    "NewGoodsForm.tsx",
    "CuratedItemForm.tsx",
    "PublicationForms.tsx",
  ]) {
    const src = code(P + f);
    checkTrue(
      `${f}：useReportDirty 往上報 dirty`,
      /useReportDirty\(form\.control, onDirtyChange\)/.test(src),
    );
    checkTrue(`${f}：<form id={formId}>`, /<form id=\{formId\}/.test(src));
  }
  for (const f of ["ProductForm.tsx", "NewGoodsForm.tsx", "CuratedItemForm.tsx"]) {
    check(`${f}：不再帶 DialogFooter（不是彈窗了）`, /DialogFooter/.test(code(P + f)), false);
  }
  const pubForms = code(`${P}PublicationForms.tsx`);
  const pubForm = pubForms.slice(
    pubForms.indexOf("export function PublicationForm("),
    pubForms.indexOf("export function LinkForm("),
  );
  check("PublicationForm（校稿）不再帶 DialogFooter", /DialogFooter/.test(pubForm), false);

  const dirty = code(`${P}useReportDirty.ts`);
  checkTrue(
    "useReportDirty：整張表單的值（useWatch）丟給 useFormDirty（值比對；圖片上傳改到 key 也算）",
    /useWatch\(\{ control \}\)/.test(dirty) && /useFormDirty\(values\)/.test(dirty),
  );
  checkTrue(
    "🔴 選品編輯不給換主題（不傳 themes）",
    !/themes=/.test(code(R("_shell.products_.curated.$id.tsx"))),
  );
  checkTrue(
    "選品新增：sort_order 依選的主題算（nextCuratedSortOrder）",
    /nextCuratedSortOrder\(itemOrders, values\.theme_id\)/.test(
      code(R("_shell.products_.curated.new.tsx")),
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] 清單：連結、peek、列表記憶、沒有 loader 副本");
{
  const cells = code(`${P}ProductRowCells.tsx`);
  for (const to of [
    "/admin/products/product/$id",
    "/admin/products/publication/$id",
    "/admin/products/curated/$id",
  ]) {
    checkTrue(`「編輯」連到 ${to}`, cells.includes(`to="${to}"`));
  }
  checkTrue(
    "「編輯」preload=intent＋點下去前 rememberAdminPeek",
    /preload: "intent", onClick: remember/.test(cells) &&
      /rememberAdminPeek\(PRODUCT_PEEK_KIND, `\$\{kind\}:\$\{id\}`, row\)/.test(cells),
  );
  checkTrue(
    "活動票券仍連到 /admin/events/$id",
    /to="\/admin\/events\/\$id" params=\{\{ id: row\.eventId \}\}/.test(cells),
  );

  for (const [f, k] of [
    ["_shell.products_.product.$id.tsx", "product"],
    ["_shell.products_.publication.$id.tsx", "publication"],
    ["_shell.products_.curated.$id.tsx", "curated"],
  ]) {
    const src = code(R(f));
    checkTrue(
      `${f}：pendingComponent 用 peek 先畫標題`,
      /\.\.\.ADMIN_DETAIL_PENDING,\s*pendingComponent:/.test(src) &&
        src.includes(`readAdminPeek`) &&
        src.includes(`\`${k}:\${id}\``),
    );
  }

  const list = code(LIST);
  check(
    "清單：沒有 useState(loader 資料) 的副本",
    /useState(<[^>]*>)?\((initial\w*|loader\w*|data\.\w+)\)/.test(list),
    false,
  );
  checkTrue(
    "清單：資料直接用 Route.useLoaderData()",
    /const data = Route\.useLoaderData\(\)/.test(list),
  );
  checkTrue(
    "清單：搜尋／狀態／排序記在 list-memory（回到列表還原）",
    /readAdminListMemory<ListPrefs>\(LIST_PREFS_KEY\)/.test(list) &&
      /writeAdminListMemory\(LIST_PREFS_KEY, next\)/.test(list),
  );
  checkTrue(
    "清單：「新增」連到新增內頁",
    list.includes('to="/admin/products/product/new"') &&
      list.includes('to="/admin/products/curated/new"'),
  );

  const themes = code(THEMES);
  checkTrue(
    "主題頁：目前選的主題記在 list-memory（從品項內頁回來面板照樣開著）",
    /readAdminListMemory<string>\(SELECTED_THEME_KEY\)/.test(themes) &&
      /writeAdminListMemory\(SELECTED_THEME_KEY, id\)/.test(themes),
  );
  checkTrue(
    "主題頁：品項編輯連到共用的選品內頁（preload＋peek）",
    /to="\/admin\/products\/curated\/\$id"[\s\S]{0,200}preload="intent"[\s\S]{0,200}rememberAdminPeek/.test(
      themes,
    ),
  );
  checkTrue(
    "主題頁：新增品項帶 ?theme=",
    /to="\/admin\/products\/curated\/new"\s*search=\{\{ theme: selectedTheme\.id \}\}/.test(themes),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] 舊彈窗已移除、該留的對話框還在");
{
  const list = code(LIST);
  for (const gone of [
    "<ProductForm ",
    "<ProductForm\n",
    "<NewGoodsForm",
    "<CuratedItemForm",
    "<PublicationForm ",
    "<PublicationForm\n",
    "setEdit(",
    "setCreate(",
    'create === "pick"',
  ]) {
    check(`清單：${gone} 已移除`, list.includes(gone), false);
  }
  check("清單 route 檔不再自己定義商品表單", /function ProductForm\(/.test(list), false);
  checkTrue("清單：連到庫存（上架）對話框留著", /<LinkForm/.test(list));
  checkTrue("清單：解除連結確認留著", /解除「\{unlinkTarget\?\.title\.zh\}」的商品連結/.test(list));
  checkTrue("清單：刪除確認留著", /確定要刪除「\{deleteTarget\?\.name\}」嗎/.test(list));
  checkTrue(
    "🔴 列上快速動作仍先讀最新一列再寫",
    /async function patchProduct[\s\S]{0,400}getProductById/.test(list),
  );

  const themes = code(THEMES);
  for (const gone of ["itemDialogOpen", "editingItem", "<CuratedItemForm", "handleItemSubmit"]) {
    check(`主題頁：${gone} 已移除`, themes.includes(gone), false);
  }
  checkTrue(
    "主題頁：主題名稱對話框留著",
    /<ThemeForm/.test(themes) && /themeDialogOpen/.test(themes),
  );
  checkTrue("主題頁：排序仍走 reorderCuratedItems", themes.includes("reorderCuratedItems"));

  check(
    "沒有舊網址參數會開彈窗（validateSearch 只有 type）",
    /edit|item|product=/.test((list.match(/validateSearch:[\s\S]*?\},\n/) ?? [""])[0]),
    false,
  );
  checkTrue("ProductForm 已搬到 components", existsSync(join(ROOT, `${P}ProductForm.tsx`)));
}

console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m`);
