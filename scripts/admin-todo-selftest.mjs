#!/usr/bin/env node
/**
 * admin-todo-selftest.mjs —— 後台簡化（P1）的自檢
 *
 *   [1] 新增的最新消息／合作案例排到最前面：newFirstSortOrder() = min − 1
 *       （前台 src/lib/cms.ts 由小到大排；以前是 max + 1，新的一則永遠落在最底下）
 *   [2] 首頁「今日待辦」的純邏輯：卡片、排序、7 天區間（台北時間）
 *   [3] 接線：路由真的用了上面那兩支、首頁 server fn 掛 adminFnMiddleware、
 *       staff 導去 POS 的 beforeLoad 還在、畫面上的工程用語拿掉了
 *
 * [1][2] 直接 import 產線的 .ts（Node 原生型別剝離），驗的是真的那份程式。
 *
 * 執行：node scripts/admin-todo-selftest.mjs（或 npm test）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-todo-selftest.mjs";

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

/** 讀不到就丟例外，不回空字串（run-selftests.mjs 守門 4）。 */
function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
/** 剝掉 // 與 /* *\/ 註解，避免斷言被檔頭的說明文字餵飽。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

const { newFirstSortOrder } = await import(
  pathToFileURL(join(ROOT, "src/lib/admin/sort-order.ts")).href
);
const T = await import(pathToFileURL(join(ROOT, "src/lib/admin/todo.ts")).href);

// -----------------------------------------------------------------------------
console.log("\n[1] newFirstSortOrder：新的一筆排最前面");
check("空清單 → 0（與欄位 default 一致）", newFirstSortOrder([]), 0);
check(
  "[1,2,3] → 0",
  newFirstSortOrder([{ sort_order: 1 }, { sort_order: 2 }, { sort_order: 3 }]),
  0,
);
check(
  "亂序 [5,-2,9] → -3（取最小值，不是第一筆）",
  newFirstSortOrder([{ sort_order: 5 }, { sort_order: -2 }, { sort_order: 9 }]),
  -3,
);
check("單筆 [10] → 9", newFirstSortOrder([{ sort_order: 10 }]), 9);

// 模擬前台：新增後依 sort_order 由小到大排（同 cms.ts select order: "sort_order"）
{
  const rows = [
    { id: "a", sort_order: 1 },
    { id: "b", sort_order: 2 },
  ];
  const added = { id: "new", sort_order: newFirstSortOrder(rows) };
  const front = [...rows, added].sort((x, y) => x.sort_order - y.sort_order).map((r) => r.id);
  check("前台由小到大排時，新的一則在第一個", front[0], "new");
  // 舊寫法（max + 1）會排到最後 —— 留著當對照，證明這條斷言真的分得出兩種寫法
  const oldWay = { id: "new", sort_order: Math.max(...rows.map((r) => r.sort_order)) + 1 };
  const frontOld = [...rows, oldWay].sort((x, y) => x.sort_order - y.sort_order).map((r) => r.id);
  check("對照：舊的 max+1 會落在最後", frontOld.at(-1), "new");
}

// -----------------------------------------------------------------------------
console.log("\n[2] 今日待辦卡片");
const counts = {
  transferPending: 0,
  toShip: 3,
  stockAlertsOpen: 2,
  productsPending: null,
  priceChangesPending: 0,
  purchasesPending: 1,
};
const cards = T.buildTodoCards(counts);
check(
  "六張卡片、各自連到對的頁",
  cards.map((c) => [c.key, c.href]),
  [
    ["transferPending", "/admin/orders"],
    ["toShip", "/admin/orders"],
    ["stockAlertsOpen", "/admin/stock-alerts"],
    ["productsPending", "/admin/inventory-products"],
    ["priceChangesPending", "/admin/inventory-products"],
    ["purchasesPending", "/admin/inventory-purchases"],
  ],
);
check(
  "「待出貨」卡片帶 ?scope=to_ship（點進去落在待出貨分頁），其餘卡片不帶 search",
  cards.map((c) => c.search ?? null),
  [null, { scope: "to_ship" }, null, null, null, null],
);
check(
  "count 原樣帶過去（null 不被改成 0）",
  cards.map((c) => c.count),
  [0, 3, 2, null, 0, 1],
);
check(
  "有事要做（>0 或讀取失敗）的排前面，其餘維持原順序",
  T.sortTodoCards(cards).map((c) => c.key),
  [
    "toShip",
    "stockAlertsOpen",
    "productsPending",
    "purchasesPending",
    "transferPending",
    "priceChangesPending",
  ],
);

console.log("\n[2b] 7 天區間（台北今天 00:00 起）");
// 台北 2026-10-20 09:30 = UTC 01:30
check("台北早上：從台北當天 00:00 算", T.taipeiWeekWindow(new Date("2026-10-20T01:30:00Z")), {
  fromIso: "2026-10-19T16:00:00.000Z",
  toIso: "2026-10-26T16:00:00.000Z",
});
// 台北 2026-10-20 23:30 = UTC 15:30 —— 還是 10/20
check(
  "台北深夜：還是同一天",
  T.taipeiWeekWindow(new Date("2026-10-20T15:30:00Z")).fromIso,
  "2026-10-19T16:00:00.000Z",
);
// 台北 2026-10-21 00:10 = UTC 2026-10-20 16:10 —— UTC 還是 10/20，台北已經 10/21
check(
  "台北過午夜、UTC 還沒換日：用台北的日期",
  T.taipeiWeekWindow(new Date("2026-10-20T16:10:00Z")).fromIso,
  "2026-10-20T16:00:00.000Z",
);

// -----------------------------------------------------------------------------
console.log("\n[3] 接線");
const news = stripComments(read("src/routes/admin/_shell.news.tsx"));
checkTrue("最新消息新增時用 newFirstSortOrder(news)", /newFirstSortOrder\(news\)/.test(news));
checkTrue("最新消息不再用 max + 1", !/Math\.max\(max, n\.sort_order\)/.test(news));
checkTrue(
  "排序欄位收進 <AdvancedSection>",
  /<AdvancedSection[\s\S]*name="sort_order"[\s\S]*<\/AdvancedSection>/.test(news),
);
const collab = stripComments(read("src/routes/admin/_shell.collaborations.tsx"));
checkTrue("合作案例新增時用 newFirstSortOrder", /newFirstSortOrder\(collaborations\)/.test(collab));

const index = stripComments(read("src/routes/admin/_shell.index.tsx"));
checkTrue(
  "首頁保留 staff → /admin/pos 的 beforeLoad",
  /role === "staff"[\s\S]*redirect\(\{ to: "\/admin\/pos" \}\)/.test(index),
);
checkTrue(
  "首頁 loader 動態 import fns/dashboard",
  /await import\("@\/lib\/admin\/fns\/dashboard"\)/.test(index),
);
checkTrue(
  "首頁沒有 toLocaleString（React #418）",
  !/toLocale(String|DateString|TimeString)/.test(index),
);
const dashFn = stripComments(read("src/lib/admin/fns/dashboard.ts"));
checkTrue(
  "getAdminTodo 掛 adminFnMiddleware",
  /\.middleware\(\[adminFnMiddleware\]\)/.test(dashFn),
);
const repo = stripComments(read("src/server/repos/admin-todo.ts"));
checkTrue(
  "repo 只讀：沒有 insert/update/upsert/delete/rpc",
  !/\.(insert|update|upsert|delete|rpc)\(/.test(repo),
);

const settings = stripComments(read("src/routes/admin/_shell.settings.tsx"));
const adv = settings.slice(
  settings.indexOf("<AdvancedSection"),
  settings.indexOf("</AdvancedSection>"),
);
for (const name of ["map_embed", "meta_author", "meta_twitter_card", "meta_og_type"]) {
  checkTrue(`全站設定：${name} 在「進階」裡`, adv.includes(`name="${name}"`));
  check(`全站設定：${name} 只出現一次`, settings.split(`name="${name}"`).length - 1, 1);
}

const jargon = [
  ["src/routes/admin/_shell.pos.tsx", "channel=pos）"],
  ["src/routes/admin/_shell.stock-alerts.tsx", "需要 approve_stock_adjustments 權限"],
  ["src/components/inventory/VendorTable.tsx", "需要「inv.vendor.pii.read」權限"],
  ["src/components/inventory/VendorSensitiveDialog.tsx", "需要「inv.vendor.pii.read」權限"],
  ["src/components/inventory/VendorSensitiveDialog.tsx", "approve_* 是不同維度"],
  ["src/routes/admin/_shell.registrations.tsx", "尚未套用到資料庫"],
  ["src/routes/admin/_shell.registrations.tsx", "這一頁要等 migration 0020"],
];
for (const [file, s] of jargon)
  checkTrue(`${file} 不再顯示「${s}」`, !stripComments(read(file)).includes(s));

const labels = await import(pathToFileURL(join(ROOT, "src/lib/admin/permission-labels.ts")).href);
check(
  "提示寫中文權限名稱",
  labels.needsPermissionHint("approve_stock_adjustments"),
  "需要店長開通「審核在庫異動／處理賣超告警」權限",
);
checkTrue(
  "approve_inventory_adjustments 在隱藏清單",
  labels.HIDDEN_PERMISSIONS.has("approve_inventory_adjustments"),
);
const staff = stripComments(read("src/routes/admin/_shell.staff.tsx"));
checkTrue(
  "人員頁勾選框只列 VISIBLE_PERMISSIONS",
  /VISIBLE_PERMISSIONS\.map\(/.test(staff) && !/STAFF_PERMISSIONS\.map\(/.test(staff),
);

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
