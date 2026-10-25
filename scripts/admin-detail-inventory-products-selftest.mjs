#!/usr/bin/env node
/**
 * 後台第 2 批（2026-10-25）：進銷存商品的詳細／新增／編輯從彈窗改成內頁的自檢（靜態）。
 * 業主：「不要用彈窗，直接顯示內頁＆回到上一頁」。
 *
 *   [1] 新 route 的 loader 各只叫一支 server fn，而且那支 fn 的授權與原本那幾支相同
 *       （getAdminProduct／listProductMovements／listProductFormOptions 都是 staffFnMiddleware()）。
 *   [2] 詳情與編輯共用 layout loader（詳情 → 編輯不重抓）；layout 有 pendingComponent。
 *   [3] 表單頁：未存變更防呆、存檔成功 allowLeave → invalidate → 回上一頁或詳情。
 *   [4] 列表：不再把 loader 資料抄進 useState；連到內頁用 Link preload="intent" + peek。
 *   [5] 舊彈窗檔已刪；留成對話框的（調價、匯入、批次、刪除）還在。
 *
 * 執行：node scripts/admin-detail-inventory-products-selftest.mjs
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-detail-inventory-products-selftest.mjs";
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
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = (rel) => stripComments(read(rel));

const R = "src/routes/admin/";
const LAYOUT = `${R}_shell.inventory-products_.$id.tsx`;
const INDEX = `${R}_shell.inventory-products_.$id.index.tsx`;
const EDIT = `${R}_shell.inventory-products_.$id.edit.tsx`;
const NEW = `${R}_shell.inventory-products_.new.tsx`;
const LIST = `${R}_shell.inventory-products.tsx`;
const FORM = "src/components/inventory/ProductForm.tsx";
const FNS = "src/lib/admin/fns/inv-products.ts";

/** 一支 export const X = createServerFn(...) 到下一支 export 之間的原始碼。 */
function fnBlock(src, name) {
  const i = src.indexOf(`export const ${name} = createServerFn`);
  if (i < 0) return "";
  const j = src.indexOf("export const ", i + 10);
  return src.slice(i, j < 0 ? undefined : j);
}
function middlewareOf(src, name) {
  return (
    fnBlock(src, name)
      .match(/\.middleware\(\[([^\]]*)\]\)/)?.[1]
      .trim() ?? null
  );
}
/** loader: async (...) => { ... } 的本體（到 head: 為止）。 */
function loaderBody(src) {
  const i = src.indexOf("loader:");
  const j = src.indexOf("head:", i);
  return i < 0 ? "" : src.slice(i, j < 0 ? undefined : j);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] loader 只叫一支 fn，授權不放寬");
{
  for (const f of [LAYOUT, INDEX, EDIT, NEW]) check(`${f} 存在`, existsSync(join(ROOT, f)), true);

  const fns = code(FNS);
  const adj = code("src/lib/admin/fns/inv-adjustments.ts");
  check(
    "🔴 getInventoryProductPageData：GET＋staffFnMiddleware()",
    /export const getInventoryProductPageData = createServerFn\(\{ method: "GET" \}\)\s*\.middleware\(\[staffFnMiddleware\(\)\]\)/.test(
      fns,
    ),
    true,
  );
  // 原本詳情／編輯／異動紀錄用的三支：新的整頁 fn 必須與它們同級（或更嚴）。
  check(
    "原本的 getAdminProduct 是 staffFnMiddleware()",
    middlewareOf(fns, "getAdminProduct"),
    "staffFnMiddleware(), readOnlyFnMiddleware",
  );
  check(
    "原本的 listProductFormOptions 是 staffFnMiddleware()",
    middlewareOf(fns, "listProductFormOptions"),
    "staffFnMiddleware()",
  );
  check(
    "原本的 listProductMovements 是 staffFnMiddleware()",
    middlewareOf(adj, "listProductMovements"),
    "staffFnMiddleware(), readOnlyFnMiddleware",
  );
  const page = fnBlock(fns, "getInventoryProductPageData");
  checkTrue(
    "整頁 fn 的 id 走 uuid 驗證",
    /productId: z\.string\(\)\.trim\(\)\.uuid\(\)/.test(page),
  );
  checkTrue(
    "整頁 fn 拿商品（getAdminProduct repo）",
    /getAdminProduct\(data\.productId\)/.test(page),
  );
  checkTrue(
    "整頁 fn 拿異動紀錄（union view 的 listProductMovements repo）",
    /listProductMovements\(data\.productId, 50\)/.test(page) &&
      /@\/server\/repos\/inv-adjustments/.test(page),
  );
  checkTrue(
    "整頁 fn 拿表單選項（loadProductFormOptions）",
    /loadProductFormOptions\(\)/.test(page),
  );

  const layoutLoader = loaderBody(code(LAYOUT));
  checkTrue(
    "layout loader 叫 getInventoryProductPageData",
    layoutLoader.includes("getInventoryProductPageData("),
  );
  check(
    "layout loader 只叫一支 server fn",
    (layoutLoader.match(/await \w+\(\{ data:/g) ?? []).length,
    1,
  );
  checkTrue(
    "🔴 layout loader 先 isUuid 再打 fn（壞 id → data: null → 找不到）",
    /if \(!isUuid\(params\.id\)\) return \{ data: null \};[\s\S]*getInventoryProductPageData/.test(
      layoutLoader,
    ),
  );

  const newLoader = loaderBody(code(NEW));
  checkTrue(
    "新增頁 loader 叫 listProductFormOptions",
    newLoader.includes("listProductFormOptions()"),
  );
  check(
    "新增頁 loader 只叫一支 server fn",
    (newLoader.match(/await \w+\(/g) ?? []).filter((m) => !m.includes("import")).length,
    1,
  );

  for (const f of [LAYOUT, NEW]) {
    checkTrue(`${f}：head 標題「…｜小時光書店後台」`, /｜小時光書店後台/.test(read(f)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] 詳情與編輯共用 layout loader；pendingComponent");
{
  const layout = code(LAYOUT);
  checkTrue(
    "layout：createFileRoute(/admin/_shell/inventory-products_/$id)",
    layout.includes('createFileRoute("/admin/_shell/inventory-products_/$id")'),
  );
  checkTrue("layout：component 是 Outlet", /component: Outlet/.test(layout));
  checkTrue("layout：有 pendingComponent", /pendingComponent: \w+/.test(layout));
  checkTrue(
    "layout：用 ADMIN_DETAIL_PENDING 的時間設定",
    /\.\.\.ADMIN_DETAIL_PENDING/.test(layout),
  );
  checkTrue(
    "layout：pending 先用列表那一列（readAdminPeek inv-product）",
    /readAdminPeek<AdminProductRow>\("inv-product", id\)/.test(layout),
  );
  for (const f of [INDEX, EDIT]) {
    const src = code(f);
    checkTrue(`${f}：沒有自己的 loader（詳情 → 編輯不重抓）`, !/loader:/.test(src));
    checkTrue(
      `${f}：讀 layout 的 loader 資料`,
      /getRouteApi\("\/admin\/_shell\/inventory-products_\/\$id"\)/.test(src) &&
        /layout\.useLoaderData\(\)/.test(src),
    );
    checkTrue(`${f}：找不到 → AdminDetailNotFound`, /AdminDetailNotFound/.test(src));
  }
  const index = code(INDEX);
  checkTrue(
    "詳情頁：顯示異動紀錄（movements 傳進 ProductDetailView）",
    /movements=\{movements\}/.test(index),
  );
  checkTrue(
    "詳情頁：編輯是 Link preload=intent 到 /$id/edit",
    /to="\/admin\/inventory-products\/\$id\/edit"[\s\S]{0,120}preload="intent"/.test(index),
  );
  checkTrue("詳情頁：調價維持對話框（PriceChangeDialog）", /<PriceChangeDialog/.test(index));
  const view = code("src/components/inventory/ProductMovementList.tsx");
  checkTrue("異動紀錄表格包 overflow-x-auto（手機不水平捲）", /overflow-x-auto/.test(view));
  checkTrue("異動紀錄舊表代碼走 legacyTypeLabel", /legacyTypeLabel\(m\.code\)/.test(view));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 表單頁：防呆、只在掛載時初始化、存檔成功換頁");
{
  const form = code(FORM);
  checkTrue(
    "🔴 ProductForm：掛 useUnsavedChangesGuard(dirty)（存檔中也攔，成功由 allowLeave 放行）",
    /useUnsavedChangesGuard\(dirty\)/.test(form),
  );
  checkTrue(
    "ProductForm：dirty 來自 useFormDirty",
    /useFormDirty\(\{ form, withPurchase, purchase \}\)/.test(form),
  );
  checkTrue("ProductForm：渲染 guard.dialog", /\{guard\.dialog\}/.test(form));
  checkTrue(
    "🔴 ProductForm：存檔成功先 allowLeave 再交給 onSaved 換頁",
    /guard\.allowLeave\(\);\s*await onSaved\(result\.id\)/.test(form),
  );
  checkTrue(
    "ProductForm：只在掛載時從 product 填（useState 初始化函式）",
    /useState<ProductFormState>\(\(\) =>\s*product \? formFromProduct\(product\)/.test(form),
  );
  checkTrue("🔴 ProductForm：沒有 useEffect 回頭蓋掉表單", !/useEffect/.test(form));
  checkTrue(
    "ProductForm：寫入仍只走 saveProduct",
    /saveProduct\(\{ data: parsed\.data \}\)/.test(form),
  );
  checkTrue("ProductForm：zod 驗證在送出前", /invProductSchema\.safeParse\(candidate\)/.test(form));
  checkTrue("ProductForm：用 AdminDetailPage 外框", /<AdminDetailPage/.test(form));
  checkTrue("ProductForm：md 以上內容底部再放一份動作", /hidden justify-end md:flex/.test(form));

  const edit = code(EDIT);
  checkTrue(
    "編輯頁：key={product.inv_product_id}（換一件重新掛載）",
    /key=\{product\.inv_product_id\}/.test(edit),
  );
  checkTrue(
    "編輯頁：存檔 → invalidate → 回上一頁（詳情或列表），否則 replace 到詳情",
    /await router\.invalidate\(\{ sync: true \}\);[\s\S]*backIfPreviousIs\(router\.history, \[detailPath, "\/admin\/inventory-products"\]\)[\s\S]*replace: true/.test(
      edit,
    ),
  );
  const nw = code(NEW);
  checkTrue(
    "新增頁：存檔 → invalidate → replace 到新商品詳情",
    /await router\.invalidate\(\{ sync: true \}\);[\s\S]*to: "\/admin\/inventory-products\/\$id"[\s\S]*replace: true/.test(
      nw,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] 列表：loader-backed、Link 進內頁");
{
  const list = code(LIST);
  const hook = code("src/lib/admin/useProductListState.ts");
  for (const [name, src] of [
    [LIST, list],
    ["useProductListState.ts", hook],
  ]) {
    check(
      `${name}：沒有 useState(loader 資料) 的副本`,
      /useState(<[^>]*>)?\((initial\w*|loader\w*)\)/.test(src),
      false,
    );
  }
  checkTrue("useProductListState 用 useLoaderBackedList", /useLoaderBackedList\(\{/.test(hook));
  checkTrue("list-memory key 是 inventory-products", /key: "inventory-products"/.test(hook));
  checkTrue("勾選仍是頁內 useState（不跨頁記住）", /useState<string\[\]>\(\[\]\)/.test(hook));
  checkTrue(
    "列表把 loader 的 updatedAt 傳進去",
    /Route\.useMatch\(\{ select: \(m\) => m\.updatedAt \}\)/.test(list),
  );
  checkTrue(
    "拍照辨識的「手動輸入」導到 /new",
    /onManualEntry=\{\(\) => void navigate\(\{ to: "\/admin\/inventory-products\/new" \}\)\}/.test(
      list,
    ),
  );
  checkTrue(
    "列表沒有 beforeLoad redirect（原本就沒有會開彈窗的網址參數）",
    !/validateSearch|beforeLoad/.test(list),
  );

  const table = code("src/components/inventory/ProductTable.tsx");
  for (const to of ["/admin/inventory-products/$id", "/admin/inventory-products/$id/edit"]) {
    const esc = to.replace(/[$/]/g, "\\$&");
    checkTrue(
      `表格：Link 到 ${to}（preload=intent＋rememberAdminPeek）`,
      new RegExp(
        `to="${esc}"[\\s\\S]{0,200}preload="intent"[\\s\\S]{0,300}rememberAdminPeek\\("inv-product", row\\.inv_product_id, row\\)`,
      ).test(table),
    );
  }
  checkTrue("表格：不再有 onView／onEdit 回呼", !/onView|onEdit/.test(table));
  const header = code("src/components/inventory/ProductPageHeader.tsx");
  checkTrue(
    "標題列：新增商品是 Link 到 /new（preload=intent）",
    /to="\/admin\/inventory-products\/new" preload="intent"/.test(header),
  );

  const tree = read("src/routeTree.gen.ts");
  for (const p of [
    "/admin/inventory-products/$id",
    "/admin/inventory-products/$id/edit",
    "/admin/inventory-products/new",
  ]) {
    checkTrue(`routeTree 有 ${p}`, tree.includes(`'${p}'`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] 舊彈窗已刪；留成對話框的還在");
{
  for (const f of [
    "src/components/inventory/ProductDetailDialog.tsx",
    "src/components/inventory/ProductFormDialog.tsx",
  ]) {
    check(`舊彈窗已刪：${f}`, existsSync(join(ROOT, f)), false);
  }
  const all = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes("routeTree")) all.push(rel);
    }
  };
  walk("src");
  const users = all.filter((f) => /\bProductDetailDialog\b|\bProductFormDialog\b/.test(code(f)));
  check("src 沒有任何程式碼再用到舊彈窗", users, []);
  const dialogs = code("src/components/inventory/ProductDialogs.tsx");
  for (const d of ["PriceChangeDialog", "ExcelImportDialog", "BatchUpdateDialog", "AlertDialog"]) {
    checkTrue(`ProductDialogs 仍管 ${d}`, new RegExp(`<${d}\\b`).test(dialogs));
  }
}

console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m`);
