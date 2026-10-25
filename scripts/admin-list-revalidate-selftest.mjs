#!/usr/bin/env node
/**
 * 後台第 2 批（2026-10-25）：列表「背景重抓看得到、回到列表篩選還原」的自檢。
 *
 * 第 1 批留下的已知問題：幾個後台列表把 route loader 的資料抄進 useState，router 在背景
 * 重跑 loader（30 秒 staleTime 過期、寫入後 invalidate）拿到的新資料永遠不會出現在畫面上。
 * 這五頁改用 useLoaderBackedList（取 loader 與依篩選自己抓的兩份裡比較新的、篩選記在
 * list-memory）。
 *
 *   [1] 五頁：用 useLoaderBackedList、拿 match.updatedAt、沒有 useState(loader 資料) 副本、
 *       沒有自己的 setData/setAlerts/setSummary、寫入後 reload → router.invalidate。
 *   [2] 進行中的編輯不被背景更新洗掉：勾選、正在盤的那一列、正在標記的告警與說明、
 *       明細／詳情對話框都留在頁面自己的 state。
 *   [3] pruneVanishedIds：只拿掉「剛剛還在、這次不見了」的勾選。
 *
 * 執行：node scripts/admin-list-revalidate-selftest.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-list-revalidate-selftest.mjs";
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
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const PAGES = {
  "_shell.inventory-purchases.tsx": { key: "inventory-purchases", writes: true },
  "_shell.inventory-adjustments.tsx": { key: "inventory-adjustments", writes: true },
  "_shell.inventory-count.tsx": { key: "inventory-count", writes: true },
  "_shell.sales.tsx": { key: "sales", writes: false },
  "_shell.stock-alerts.tsx": { key: "stock-alerts", writes: true },
};

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] 五頁用 useLoaderBackedList，沒有 loader 資料副本");
const keys = [];
for (const [route, { key, writes }] of Object.entries(PAGES)) {
  const src = stripComments(read(`src/routes/admin/${route}`));
  checkTrue(`${route}：呼叫 useLoaderBackedList`, /useLoaderBackedList\(\{/.test(src));
  checkTrue(
    `${route}：import 自 @/lib/admin/useLoaderBackedList`,
    /from "@\/lib\/admin\/useLoaderBackedList"/.test(src),
  );
  checkTrue(`${route}：list-memory key = "${key}"`, new RegExp(`key: "${key}"`).test(src));
  keys.push(key);
  checkTrue(
    `${route}：loaderUpdatedAt 取 match.updatedAt`,
    /Route\.useMatch\(\{ select: \(m\) => m\.updatedAt \}\)/.test(src) &&
      /loaderUpdatedAt[,\n]/.test(src),
  );
  check(
    `${route}：沒有 useState(initial…/loader…) 副本`,
    /useState(<[^>]*>)?\((initial\w*|loader\w*)\)/.test(src),
    false,
  );
  check(
    `${route}：沒有自己抄一份清單的 setter（setData/setSummary/setAlerts/setRows）`,
    /\bset(Data|Summary|Alerts|Rows)\b/.test(src),
    false,
  );
  check(
    `${route}：沒有「第一次不重打」的 isInitial 旗標（hook 自己比 loader 篩選）`,
    /\bisInitial\b/.test(src),
    false,
  );
  if (writes) {
    checkTrue(
      `${route}：寫入後先重抓目前篩選，再 router.invalidate()`,
      /await (reloadList|list\.reload)\(\);\s*await router\.invalidate\(\);/.test(src),
    );
  }
}
check("五頁的 list-memory key 互不相同", new Set(keys).size, keys.length);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] 進行中的編輯留在頁面自己的 state");
{
  const pur = stripComments(read("src/routes/admin/_shell.inventory-purchases.tsx"));
  checkTrue("進貨：勾選是頁面 state", /useState<string\[\]>\(\[\]\)/.test(pur));
  checkTrue(
    "進貨：背景更新只拿掉消失的勾選（usePruneVanishedSelection）",
    /usePruneVanishedSelection\(rowIds, stableStringify\(filter\), loading, setSelectedIds\)/.test(
      pur,
    ),
  );
  checkTrue(
    "進貨：換篩選才清勾選（與原本一致）",
    /function changeFilter[\s\S]{0,120}setSelectedIds\(\[\]\);\s*list\.setFilter\(next\)/.test(pur),
  );
  checkTrue(
    "進貨：編輯中的那一筆是副本（setEditing(row)），不從清單反查",
    /setEditing\(row\)/.test(pur),
  );

  const cnt = stripComments(read("src/routes/admin/_shell.inventory-count.tsx"));
  checkTrue(
    "盤點：正在盤的那一列是點下去那一刻的副本",
    /useState<StockCountProductRow \| null>\(null\)/.test(cnt) &&
      /onCount=\{setCounting\}/.test(cnt),
  );
  checkTrue(
    "盤點：對話框吃 counting，不是從 data 用 id 反查（換 product 會清掉打到一半的數量）",
    /product=\{counting\}/.test(cnt) && !/data\.rows\.find/.test(cnt),
  );
  const dlg = stripComments(read("src/components/inventory/StockCountDialog.tsx"));
  checkTrue(
    "（前提）StockCountDialog 在 open/product 換掉時重設輸入 —— 所以上面那條才重要",
    /\}, \[open, product\]\);/.test(dlg),
  );

  const adj = stripComments(read("src/routes/admin/_shell.inventory-adjustments.tsx"));
  checkTrue(
    "異動：詳情是點開那一刻的副本",
    /useState<AdminAdjustmentRow \| null>\(null\)/.test(adj) && /onView=\{setDetail\}/.test(adj),
  );

  const sales = stripComments(read("src/routes/admin/_shell.sales.tsx"));
  checkTrue(
    "銷售：明細對話框留著，看的是點開那一刻的副本",
    /SaleDetailDialog sale=\{selected\}/.test(sales) && /setSelected\(row\)/.test(sales),
  );
  checkTrue(
    "銷售：換頁用目前篩選組下一份（hook 的 setFilter 不收 updater）",
    /setFilter\(\{ \.\.\.filter, page: filter\.page \+ 1 \}\)/.test(sales) &&
      !/setFilter\(\(f\)/.test(sales),
  );

  const al = stripComments(read("src/routes/admin/_shell.stock-alerts.tsx"));
  checkTrue(
    "告警：正在標記的那一列與說明是頁面 state",
    /useState<StockAlertRow \| null>\(null\)/.test(al) && /useState\(""\)/.test(al),
  );
  check(
    "告警：沒有樂觀更新（不直接改本地清單）",
    /\.map\(\(a\) =>[^)]*resolved_at:/.test(al),
    false,
  );
  checkTrue(
    "告警：分頁籤就是 hook 的篩選",
    /onValueChange=\{\(v\) => list\.setFilter\(v as Status\)\}/.test(al),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] pruneVanishedIds");
{
  const { pruneVanishedIds } = await imp("src/lib/admin/usePruneVanishedSelection.ts");
  const sel = ["a", "b", "x"];
  check(
    "沒有列消失 → 同一個陣列",
    pruneVanishedIds(sel, ["a", "b"], ["a", "b", "c"]) === sel,
    true,
  );
  check("b 消失了 → 拿掉 b", pruneVanishedIds(sel, ["a", "b"], ["a"]), ["a", "x"]);
  check("x 不在上一份資料（別的分頁勾的）→ 留著", pruneVanishedIds(["x"], ["a", "b"], ["c"]), [
    "x",
  ]);
  check("消失的列沒被勾 → 同一個陣列", pruneVanishedIds(sel, ["a", "z"], ["a"]) === sel, true);
  check("空勾選", pruneVanishedIds([], ["a"], []), []);

  const hook = stripComments(read("src/lib/admin/usePruneVanishedSelection.ts"));
  checkTrue("hook：loading（換篩選那一下）不算數", /if \(loading\) return;/.test(hook));
  checkTrue(
    "hook：篩選換了只記新基準，不拿上一組篩選的資料比",
    /prev\.key !== filterKey\) return;/.test(hook),
  );
}

console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m`);
