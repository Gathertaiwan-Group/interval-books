/**
 * 賣超告警併進後台首頁（2026-11-10）的自檢。
 *
 * [1] 純邏輯：直接 import src/lib/admin/stock-alerts.ts（Node 原生型別剝離）——排序、件數。
 * [2] 接線（靜態）：首頁並行讀告警、卡片沿用原本的 server fn、/admin/stock-alerts 對 admin
 *     轉去 /admin#stock-alerts、對門市人員保留頁面、側欄只對門市人員顯示。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/stock-alerts-dashboard-selftest.mjs";

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
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

// -----------------------------------------------------------------------------
console.log("\n[1] 純邏輯");
const L = await import(pathToFileURL(join(ROOT, "src/lib/admin/stock-alerts.ts")).href);

const row = (alert_id, source, shortfall, created_at, resolved_at = null) => ({
  alert_id,
  source,
  shortfall,
  created_at,
  resolved_at,
});
const alerts = [
  row(1, "pos_override", 5, "2026-11-01T00:00:00Z"),
  row(2, "online_commit", 1, "2026-11-03T00:00:00Z"),
  row(3, "online_commit", 3, "2026-11-04T00:00:00Z"),
  row(4, "online_commit", 3, "2026-11-02T00:00:00Z"),
  row(5, "online_commit", 9, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
  row(6, "pos_override", 2, "2026-11-05T00:00:00Z"),
];
check(
  "排序：未處理優先 → 網站付款優先 → 差得多的優先 → 越早越前面",
  L.sortStockAlertsByUrgency(alerts).map((a) => a.alert_id),
  [4, 3, 2, 1, 6, 5],
);
check(
  "排序不改動原陣列",
  alerts.map((a) => a.alert_id),
  [1, 2, 3, 4, 5, 6],
);
check("件數只數未處理", L.countOpenAlertsBySource(alerts), { online: 3, pos: 2, total: 5 });
check("空清單件數為 0", L.countOpenAlertsBySource([]), { online: 0, pos: 0, total: 0 });
check("來源標籤：櫃檯", L.stockAlertSourceLabel("pos_override"), "櫃檯強制放行");
check("來源標籤：網站", L.stockAlertSourceLabel("online_commit"), "網站付款後庫存不足");
check("前 N 筆是 5", L.STOCK_ALERTS_TOP_N, 5);
check("錨點", L.STOCK_ALERTS_ANCHOR, "stock-alerts");

// -----------------------------------------------------------------------------
console.log("\n[2] 接線");
const index = stripComments(read("src/routes/admin/_shell.index.tsx"));
checkTrue(
  "首頁 loader 與待辦數字並行讀告警（Promise.all + listStockAlerts open）",
  /Promise\.all\(\[\s*getAdminTodo\(\),\s*listStockAlerts\(\{ data: \{ status: "open" \} \}\)/.test(
    index,
  ),
);
checkTrue(
  "🔴 告警讀失敗不讓首頁掛掉（.catch → null）",
  /listStockAlerts\([^)]*\)\)?\.catch\(/.test(index),
);
checkTrue("首頁畫出 StockAlertsPanel", /<StockAlertsPanel/.test(index));
checkTrue(
  "標記權限照原頁（approve_stock_adjustments）",
  /canResolve=\{user\.permissions\.includes\("approve_stock_adjustments"\)\}/.test(index),
);
checkTrue(
  "首頁仍把 staff 導去櫃檯",
  /role === "staff"[\s\S]*redirect\(\{ to: "\/admin\/pos" \}\)/.test(index),
);

const panel = stripComments(read("src/components/admin/StockAlertsPanel.tsx"));
checkTrue("卡片沿用 fns/pos 的 listStockAlerts", /import\("@\/lib\/admin\/fns\/pos"\)/.test(panel));
checkTrue("卡片沿用 resolveStockAlert", /resolveStockAlert\(\{/.test(panel));
checkTrue("卡片有錨點 id", /id=\{STOCK_ALERTS_ANCHOR\}/.test(panel));
checkTrue("帶錨點時自動展開", /STOCK_ALERTS_ANCHOR\) \{\s*setExpanded\(true\)/.test(panel));
checkTrue("收合時只列前 N 筆", /open\.slice\(0, STOCK_ALERTS_TOP_N\)/.test(panel));
checkTrue("「看全部（N）」按鈕", panel.includes("看全部（{open.length}）"));
checkTrue("沒有告警時一行說明", panel.includes("庫存帳都對得上"));
checkTrue(
  "展開後保留原頁的 待處理／已處理／全部",
  ["待處理", "已處理", "全部"].every((s) => panel.includes(s)),
);
checkTrue("點擊區 ≥44px（min-h-11）", (panel.match(/min-h-11/g) ?? []).length >= 3);
check("卡片不直接碰 supabase", /supabaseAdmin|createClient/.test(panel), false);

const route = stripComments(read("src/routes/admin/_shell.stock-alerts.tsx"));
checkTrue(
  "/admin/stock-alerts：admin 轉去 /admin#stock-alerts",
  /role === "admin"[\s\S]*redirect\(\{ to: "\/admin", hash: STOCK_ALERTS_ANCHOR, replace: true \}\)/.test(
    route,
  ),
);
checkTrue(
  "🔴 /admin/stock-alerts：門市人員仍有頁面（同一張卡片、直接展開）",
  /<StockAlertsPanel[\s\S]*defaultExpanded/.test(route),
);

const shell = stripComments(read("src/routes/admin/_shell.tsx"));
checkTrue(
  "側欄：賣超告警 staffOnly（admin 看不到，門市人員看得到）",
  /to: "\/admin\/stock-alerts",[\s\S]{0,120}staff: true,\s*staffOnly: true/.test(shell),
);
checkTrue(
  "側欄過濾：admin 跳過 staffOnly 的項目",
  /if \(isAdmin\) return !\("staffOnly" in item && item\.staffOnly\);/.test(shell),
);

const todo = stripComments(read("src/lib/admin/todo.ts"));
check("待辦卡不再連到 /admin/stock-alerts", todo.includes('"/admin/stock-alerts"'), false);

console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
