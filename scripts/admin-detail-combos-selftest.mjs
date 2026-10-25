#!/usr/bin/env node
/**
 * 後台第 2 批（2026-10-25）：套餐的詳情／編輯／新增從彈窗改成內頁的自檢（全靜態）。
 * 業主：「不要用彈窗，直接顯示內頁＆回到上一頁」。
 *
 *   [1] server fn：新的整頁 fn 是 GET、掛 staffFnMiddleware()（與原本 getAdminComboSet／
 *       listComboSales／listComboFormOptions 相同，沒有放寬）；列表的整頁 fn 不再帶可選商品。
 *   [2] route：layout 的 loader 只叫一支 fn、先驗 id、有 pendingComponent；詳情／編輯不另外抓。
 *   [3] 表單：未存變更防呆、只在掛載時初始化、payload 不含資料庫算的四個欄位。
 *   [4] 列表：不再把 loader 資料抄進 useState；詳情／編輯／新增是 Link（預載＋peek）。
 *   [5] 舊彈窗已刪、沒有殘留引用；刪除確認仍是 AlertDialog。
 *
 * 執行：node scripts/admin-detail-combos-selftest.mjs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-detail-combos-selftest.mjs";
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

const R = "src/routes/admin";
const LIST = `${R}/_shell.inventory-combos.tsx`;
const LAYOUT = `${R}/_shell.inventory-combos_.$id.tsx`;
const INDEX = `${R}/_shell.inventory-combos_.$id.index.tsx`;
const EDIT = `${R}/_shell.inventory-combos_.$id.edit.tsx`;
const NEW = `${R}/_shell.inventory-combos_.new.tsx`;
const FORM = "src/components/inventory/ComboSetForm.tsx";
const FNS = "src/lib/admin/fns/inv-combos.ts";

/** 取出 `export const name = createServerFn(...)` 到下一個 export 之間的那一段。 */
function fnBlock(src, name) {
  const i = src.indexOf(`export const ${name} = `);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + 1);
  return src.slice(i, j < 0 ? undefined : j);
}
/** route 檔 loader 叫了哪些 server fn（`await xxx({` / `await xxx()`）。 */
function loaderCalls(src) {
  const i = src.indexOf("loader:");
  if (i < 0) return [];
  const body = src.slice(i, src.indexOf("\n  },", i));
  return [...body.matchAll(/await (\w+)\(/g)].map((m) => m[1]).filter((n) => n !== "import");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] server fn：GET＋staffFnMiddleware()，權限沒有放寬");
const fns = stripComments(read(FNS));
{
  for (const name of [
    "getInventoryComboPageData",
    "getInventoryCombosPageData",
    "listComboFormOptions",
  ]) {
    checkTrue(
      `🔴 ${name}：GET＋.middleware([staffFnMiddleware()])`,
      new RegExp(
        `export const ${name} = createServerFn\\(\\{ method: "GET" \\}\\)\\s*\\.middleware\\(\\[staffFnMiddleware\\(\\)\\]\\)`,
      ).test(fns),
    );
  }
  for (const name of ["getAdminComboSet", "listComboSales", "listAdminComboSets"]) {
    checkTrue(
      `原本的 ${name} 仍是 staffFnMiddleware()（整頁 fn 與它同等）`,
      new RegExp(
        `export const ${name} = createServerFn\\(\\{ method: "POST" \\}\\)\\s*\\.middleware\\(\\[staffFnMiddleware\\(\\), readOnlyFnMiddleware\\]\\)`,
      ).test(fns),
    );
  }
  checkTrue(
    "🔴 inv-combos.ts 沒有出現 adminFnMiddleware（不是 admin-only 也沒有換掉）",
    !/adminFnMiddleware/.test(fns),
  );

  const page = fnBlock(fns, "getInventoryComboPageData");
  checkTrue("整頁 fn 驗 uuid", /comboSetId: z\.string\(\)\.trim\(\)\.uuid\(\)/.test(page));
  for (const part of [
    "getAdminComboSet(",
    "listComboItems(",
    "listComboSales(",
    "loadComboFormOptions(",
  ]) {
    checkTrue(`整頁 fn 在伺服器上一起抓：${part}`, page.includes(part));
  }
  checkTrue("整頁 fn 用 Promise.all（不是一支接一支）", /Promise\.all\(\[/.test(page));
  checkTrue(
    "銷售紀錄仍是最近 50 筆、不限日期",
    /dateFrom: null, dateTo: null, limit: 50/.test(page),
  );

  const list = fnBlock(fns, "getInventoryCombosPageData");
  checkTrue(
    "列表整頁 fn 帶篩選（comboFilterSchema）",
    /inputValidator\(comboFilterSchema\)/.test(list),
  );
  checkTrue("列表整頁 fn 有審核設定（「需審核」提示）", /listApprovalSettings\(/.test(list));
  checkTrue(
    "🔴 列表整頁 fn 不帶可選商品清單（表單才要；約 496 KB）",
    !/listPosProducts|loadComboFormOptions/.test(list),
  );

  const decls = [...fns.matchAll(/export const (\w+) = createServerFn\([^)]*\)\s*(\.\w+)/g)];
  check(
    "🔴 fns/inv-combos.ts：每一支 server fn 都先掛 middleware",
    decls.filter((m) => m[2] !== ".middleware").map((m) => m[1]),
    [],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] route：一頁一支 fn、詳情→編輯不重抓");
{
  const layout = stripComments(read(LAYOUT));
  check("layout loader 只叫一支 fn：getInventoryComboPageData", loaderCalls(layout), [
    "getInventoryComboPageData",
  ]);
  checkTrue(
    "layout loader 先 isUuid(params.id)，不是就回 { data: null }",
    /if \(!isUuid\(params\.id\)\) return \{ data: null \};/.test(layout),
  );
  checkTrue("layout 有 pendingComponent", /pendingComponent: \w+/.test(layout));
  checkTrue("layout 帶 ADMIN_DETAIL_PENDING 的時間設定", /\.\.\.ADMIN_DETAIL_PENDING/.test(layout));
  checkTrue(
    'pending 畫面用列表那一列（readAdminPeek("combo"）',
    /readAdminPeek<\w+>\("combo", id\)/.test(layout),
  );
  checkTrue("layout 的 component 是 Outlet", /component: Outlet/.test(layout));
  checkTrue("layout 的 head 給標題", /｜套餐｜小時光書店後台/.test(layout));

  for (const f of [INDEX, EDIT]) {
    const src = stripComments(read(f));
    checkTrue(`${f}：沒有自己的 loader`, !/loader:/.test(src));
    checkTrue(
      `${f}：資料取自 layout（getRouteApi）`,
      /getRouteApi\("\/admin\/_shell\/inventory-combos_\/\$id"\)/.test(src),
    );
    checkTrue(`${f}：不另外 import server fn`, !/fns\/inv-combos/.test(src));
    checkTrue(`${f}：找不到時 AdminDetailNotFound`, /<AdminDetailNotFound/.test(src));
  }

  const neu = stripComments(read(NEW));
  check("新增頁 loader 只叫一支 fn：listComboFormOptions", loaderCalls(neu), [
    "listComboFormOptions",
  ]);
  checkTrue("新增頁 head 給標題", /新增套餐｜小時光書店後台/.test(neu));
  checkTrue("新增頁存檔後 replace 到詳情", /replace: true/.test(neu));

  const index = stripComments(read(INDEX));
  checkTrue(
    "詳情頁：動作做完 router.invalidate()",
    /useComboActions\(\s*async \(\) => \{\s*await router\.invalidate\(\);/.test(index),
  );
  checkTrue("詳情頁：有編輯連結", /to="\/admin\/inventory-combos\/\$id\/edit"/.test(index));
  checkTrue("詳情頁：有上下架", /handleToggleActive\(set\)/.test(index));
  checkTrue(
    "詳情頁：審核走 ApprovalActions（approve_combo_sets）",
    /permissionName="approve_combo_sets"/.test(index),
  );
  checkTrue("詳情頁：沒有刪除（留在列表的 AlertDialog）", !/handleDelete/.test(index));

  const actions = stripComments(read("src/lib/admin/useComboActions.ts"));
  check(
    "useComboActions 每個動作都 await refresh()（busy 等到重抓完才放，畫面不停在舊狀態）",
    (actions.match(/await refresh\(\);/g) ?? []).length,
    4,
  );

  const tree = read("src/routeTree.gen.ts");
  for (const id of [
    "/admin/_shell/inventory-combos_/$id",
    "/admin/_shell/inventory-combos_/$id/",
    "/admin/_shell/inventory-combos_/$id/edit",
    "/admin/_shell/inventory-combos_/new",
  ]) {
    checkTrue(`routeTree 有 ${id}`, tree.includes(`'${id}'`) || tree.includes(`"${id}"`));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 表單：防呆、初始化、payload");
{
  const form = stripComments(read(FORM));
  checkTrue(
    "🔴 掛 useUnsavedChangesGuard(dirty && !saving)",
    /useUnsavedChangesGuard\(dirty && !saving\)/.test(form),
  );
  checkTrue("渲染 guard.dialog", /\{guard\.dialog\}/.test(form));
  checkTrue(
    "存檔成功先 allowLeave 再交給呼叫端換頁",
    /guard\.allowLeave\(\);\s*await onSaved\(result\.id\);/.test(form),
  );
  checkTrue(
    "dirty 用 useFormDirty（值比對）",
    /useFormDirty\(\{ name, price, notes, isActive, items \}\)/.test(form),
  );
  checkTrue(
    "只在掛載時初始化（useState(() => …)）",
    (form.match(/useState(<[^>]*>)?\(\(\) =>/g) ?? []).length >= 5,
  );
  checkTrue(
    "沒有 useEffect 依 props 重設欄位（loader 重跑不可蓋掉打到一半的欄位）",
    !/useEffect/.test(form),
  );
  checkTrue("品項編輯器照舊", /<ComboSetItemEditor/.test(form));
  checkTrue("分攤預覽照舊", /<ComboSetAllocationPreview/.test(form));
  checkTrue("送出走 comboSetSchema.safeParse", /comboSetSchema\.safeParse\(\{/.test(form));
  const parse = form.slice(
    form.indexOf("comboSetSchema.safeParse({"),
    form.indexOf("});", form.indexOf("comboSetSchema.safeParse({")),
  );
  check(
    "payload 只有 id/name/selling_price/notes/is_active/items",
    [...parse.matchAll(/^\s+(\w+)(:|,)/gm)].map((m) => m[1]),
    ["id", "name", "selling_price", "notes", "is_active", "items"],
  );
  checkTrue(
    "🔴 payload 沒有 approval_status / amount / unit_price / cost_price",
    !/approval_status|\bamount\b|unit_price|cost_price/.test(parse),
  );
  checkTrue("表單內容底部也有一份動作（md 以上）", /hidden justify-end md:flex/.test(form));
  checkTrue(
    "檔頭仍說明 payload 不含那四個欄位",
    /沒有 approval_status，也沒有 amount \/ unit_price \/\n \*    cost_price/.test(read(FORM)),
  );

  const edit = stripComments(read(EDIT));
  checkTrue("編輯頁 key={套餐 id}（換一筆重新掛載）", /key=\{data\.set\.combo_set_id\}/.test(edit));
  checkTrue(
    "編輯頁存檔後 backIfPreviousIs 回詳情",
    /backIfPreviousIs\(router\.history, \[`\/admin\/inventory-combos\/\$\{comboSetId\}`\]\)/.test(
      edit,
    ),
  );
  checkTrue("編輯頁否則 replace 到詳情", /replace: true/.test(edit));
  checkTrue("編輯頁存檔後 router.invalidate()", /await router\.invalidate\(\);/.test(edit));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] 列表");
{
  const list = stripComments(read(LIST));
  check("列表 loader 只叫一支 fn：getInventoryCombosPageData", loaderCalls(list), [
    "getInventoryCombosPageData",
  ]);
  checkTrue("🔴 列表不再抓 listComboFormOptions", !/listComboFormOptions/.test(list));
  check(
    "沒有 useState(loader 資料) 的副本",
    /useState(<[^>]*>)?\((initial\w*|loader\w*)\)/.test(list),
    false,
  );
  checkTrue("用 useLoaderBackedList", /useLoaderBackedList\(\{/.test(list));
  checkTrue(
    "loaderUpdatedAt 取自 match.updatedAt",
    /Route\.useMatch\(\{ select: \(m\) => m\.updatedAt \}\)/.test(list),
  );
  checkTrue(
    "寫入後 reload 再 router.invalidate()",
    /await reloadList\(\);\s*await router\.invalidate\(\);/.test(list),
  );
  checkTrue(
    "新增是 Link（預載）",
    /<Link to="\/admin\/inventory-combos\/new" preload="intent">/.test(list),
  );
  checkTrue("刪除確認留在列表", /<ComboSetDialogs/.test(list) && /setDeleting/.test(list));

  const row = stripComments(read("src/components/inventory/ComboSetRowActions.tsx"));
  for (const to of ["/admin/inventory-combos/$id", "/admin/inventory-combos/$id/edit"]) {
    const esc = to.replace(/\$/g, "\\$").replace(/\//g, "\\/");
    checkTrue(
      `列上 ${to} 是 Link preload="intent" + rememberAdminPeek`,
      new RegExp(
        `to="${esc}"\\s*params=\\{\\{ id: row\\.combo_set_id \\}\\}\\s*preload="intent"[\\s\\S]{0,120}rememberAdminPeek\\("combo", row\\.combo_set_id, row\\)`,
      ).test(row),
    );
  }
  checkTrue("列上沒有 onView／onEdit 回呼了", !/onView|onEdit/.test(row));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] 舊彈窗");
{
  for (const f of [
    "src/components/inventory/ComboSetDetailDialog.tsx",
    "src/components/inventory/ComboSetFormDialog.tsx",
  ]) {
    check(`舊彈窗已刪：${f}`, existsSync(join(ROOT, f)), false);
  }
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (
        /\.tsx?$/.test(e.name) &&
        /ComboSet(Detail|Form)Dialog/.test(stripComments(read(rel)))
      )
        hits.push(rel);
    }
  };
  walk("src");
  check("src 底下沒有任何程式碼引用舊彈窗", hits, []);
  const dialogs = stripComments(read("src/components/inventory/ComboSetDialogs.tsx"));
  checkTrue(
    "ComboSetDialogs 只剩 AlertDialog（沒有 ui/dialog）",
    /AlertDialog/.test(dialogs) && !/@\/components\/ui\/dialog"/.test(dialogs),
  );
}

console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m`);
