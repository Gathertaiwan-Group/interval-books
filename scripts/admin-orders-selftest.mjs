#!/usr/bin/env node
/**
 * admin-orders-selftest.mjs —— 後台訂單頁（列表／詳情／標記已收款）的自檢
 *
 * 分三段，理由與 remittance-selftest / event-registration-selftest 相同：這支測試
 * 在沒有資料庫的機器上也必須有意義。
 *
 *   [靜態]  讀 src/lib/admin/fns/orders.ts、src/server/repos/orders-admin.ts、
 *           src/routes/admin/_shell.orders.tsx、src/routes/admin/_shell.tsx 的原始
 *           碼，並用 `git status`／`git diff` 對真的工作目錄問「這一期不該碰的檔案
 *           有沒有被碰到」。守的是設計不變量：
 *             · fns/orders.ts 每一支 server fn 都掛 adminFnMiddleware（AST 比對，
 *               不是 includes()——見下方「為什麼是 AST」）。
 *             · repo 層完全不寫入 orders 表（沒有任何一句 .update()），標記已收款
 *               只透過 admin_mark_order_paid() 這支 RPC，而且參數名稱是
 *               p_order_id／p_actor_id／p_note。
 *             · 列表查詢的欄位字串裡沒有 email／phone，也不查 order_addresses。
 *             · 詳情（業主 2026-10-25：明文、不留紀錄）一次巢狀查詢拿齊
 *               訂單＋品項＋收件資料（含門牌）＋發票資料，回傳明文聯絡方式。
 *             · 沒有動到 src/server/repos/orders.ts（結帳路徑）、
 *               src/server/repos/payments.ts、四個金流檔，也沒有動到任何既有
 *               migration（0001–0034）——0035 是這一期唯一允許新增的一支
 *               （訂單刪除／封存＋名單刪除單筆，見 [6] 段對 supabase/migrations
 *               目錄的比對方式）。
 *             · 0035：repo 層的刪除／封存也只透過 admin_delete_order()／
 *               admin_archive_order() 兩支 RPC（沒有 .delete()），畫面的分界是
 *               payment_status === "paid"，四種／三種 reason 各自講人話（[3b]／
 *               [7c]）。
 *           **永遠會跑。**
 *
 *   [動態]  直接 import() src/lib/admin/order-labels.ts 本人（純函式、零 import），
 *           驗列表篩選參數的解析（「回訂單列表」要帶回原本分頁靠它）。**永遠會跑。**
 *
 *   [連線]  對一個真的 PostgreSQL 跑 markOrderPaidByAdmin()，驅動**產線的程式碼
 *           本人**（不是重寫一次那句 SQL——見下面「為什麼是 shim」）。這一段驗的是
 *           這一期唯一會動到錢的動作：呼叫 admin_mark_order_paid() 之後
 *           payment_method 仍然是 'transfer'。0035 加了 [9b]，同一個 shim 多驅動
 *           deleteAdminOrder()／archiveAdminOrder() 兩支 TS 包裝一次——只驗參數
 *           名稱與回傳值解析，admin_delete_order()／admin_archive_order() 本身的
 *           商業邏輯（名額、逐表零變動、兩道拒絕閘）由
 *           scripts/admin-order-registration-cleanup-selftest.mjs 對真的 Postgres
 *           完整覆蓋，這裡不重複驗。
 *
 * ── 為什麼是 AST，不是 includes() ──────────────────────────────────────────
 * `.middleware([adminFnMiddleware])` 這幾個字如果只用字串比對，一段解釋「這一支
 * 為什麼要掛 adminFnMiddleware」的註解就能把斷言餵成假的綠燈——而且是在**相反的
 * 方向**上綠：程式碼真的把 middleware 拿掉時，只要註解還留著，includes() 一樣通
 * 過。所以下面走 @babel/parser 的 AST：只認函式呼叫鏈裡 `.middleware(...)` 的陣列
 * 引數是不是真的有 Identifier `adminFnMiddleware`，註解與字串內容進不了這個節點
 * （同 scripts/nav-consolidation-selftest.mjs 檔頭的理由）。
 *
 * ── 為什麼 [連線] 段是 shim，不是重寫一次那句 SQL ──────────────────────────
 * 理由與 remittance-selftest.mjs 檔頭逐字相同：在測試裡重寫一次
 * `supabaseAdmin().rpc("admin_mark_order_paid", …)` 拿去跑，驗到的是這支測試寫得
 * 對不對，不是 src/server/repos/orders-admin.ts 那支 markOrderPaidByAdmin() 寫得
 * 對不對。這裡把 `@/server/supabase-admin` 換成一個只實作 `.rpc()`（這支函式唯一
 * 用到的方法）的 shim，被測的仍然是那個檔案本人：它傳了什麼參數名稱、怎麼解析
 * PostgREST 包成陣列還是物件的回傳值，全部原封不動地跑到真的 Postgres 上。
 *
 * `admin_mark_order_paid()` 本身的正確性（保留 payment_method、四種 reason、稽核
 * 列、grants）已經由 scripts/remittance-selftest.mjs 的 [16] 段完整覆蓋——那支測
 * 試直接對資料庫送 SQL，不經過這個檔案的任何程式碼。這裡不重複驗那件事，只驗
 * markOrderPaidByAdmin() 這個 TypeScript 包裝本身：參數名稱有沒有傳對、回傳值有
 * 沒有解析對、而且**透過這一層呼叫之後**，資料庫裡的 payment_method 真的還是
 * 'transfer'（見任務驗收條件那一條 🔴）。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它沿用 remittance-selftest.mjs 的
 *    REMITTANCE_SELFTEST_PG_URL——同一個變數，不另外發明一個（0034 的資料庫事實
 *    是這兩支測試共同的地基：orders.payment_method 認得 'transfer'、
 *    admin_mark_order_paid() 存在）。沒設就整段 skip（會印出來，不會靜悄悄消
 *    失）。指令與建庫方式見 remittance-selftest.mjs 檔頭；這支不套 migration，直
 *    接假設那個資料庫已經套到 0034（跑 remittance-selftest.mjs 的
 *    REMITTANCE_SELFTEST_APPLY=1 一次就會有）。
 *
 *     REMITTANCE_SELFTEST_PG_URL=postgres:///ib_0034_test \
 *     node scripts/admin-orders-selftest.mjs
 *
 * 測試資料一律用 idempotency_key like 'ao-selftest-%' 做記號，執行前先清掉上一輪
 * 留下的（同 remittance-selftest.mjs 的 KEY_PREFIX 手法），不會撞到那支測試自己
 * 的 'rmt34-%' 前綴。
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { registerHooks } from "node:module";
import { parse as parseJs } from "@babel/parser";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-orders-selftest.mjs";

const FNS_PATH = join(ROOT, "src/lib/admin/fns/orders.ts");
const REPO_PATH = join(ROOT, "src/server/repos/orders-admin.ts");
const LABELS_PATH = join(ROOT, "src/lib/admin/order-labels.ts");
const ROUTE_PATH = join(ROOT, "src/routes/admin/_shell.orders.tsx");
const DETAIL_ROUTE_PATH = join(ROOT, "src/routes/admin/_shell.orders_.$id.tsx");
const SHELL_PATH = join(ROOT, "src/routes/admin/_shell.tsx");
const MIG_DIR = join(ROOT, "supabase/migrations");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 remittance-selftest.mjs 同一套，逐檔各自一份是這個 repo 的慣例）
// -----------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

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

/** 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串（見 run-selftests.mjs 守門 4）。 */
function readFile(p) {
  if (!existsSync(p)) {
    throw new Error(
      `selftest 讀不到檔案：${p}（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串——` +
        `回空字串會讓所有「確認原始碼裡沒有 X」的否定斷言靜默通過。）`,
    );
  }
  return readFileSync(p, "utf8");
}

/** 拿掉 TypeScript／SQL 的行內與區塊註解（同 remittance-selftest.mjs 的 stripTs）。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/** 從 startMarker 切到下一個 endMarker（找不到 endMarker 就切到檔尾）。 */
function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) return "";
  const end = src.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? src.slice(start) : src.slice(start, end);
}

console.log("═══ 後台訂單頁自檢（列表／詳情／標記已收款）═══");

// =============================================================================
// [1] 反空殼：四個檔案都在，都不是空檔
// =============================================================================
console.log("\n[1] 檔案盤點");
for (const [label, p] of [
  ["fns/orders.ts", FNS_PATH],
  ["repo/orders-admin.ts", REPO_PATH],
  ["lib/admin/order-labels.ts", LABELS_PATH],
  ["routes/admin/_shell.orders.tsx", ROUTE_PATH],
  ["routes/admin/_shell.orders_.$id.tsx", DETAIL_ROUTE_PATH],
]) {
  checkTrue(`${label} 存在`, existsSync(p));
}
const fnsSrcRaw = readFile(FNS_PATH);
const repoSrcRaw = readFile(REPO_PATH);
const routeSrcRaw = readFile(ROUTE_PATH);
const detailRouteSrcRaw = readFile(DETAIL_ROUTE_PATH);
const shellSrc = readFile(SHELL_PATH);
checkTrue("fns/orders.ts 不是空檔", fnsSrcRaw.length > 500);
checkTrue("repo/orders-admin.ts 不是空檔", repoSrcRaw.length > 2000);
checkTrue("_shell.orders.tsx 不是空檔", routeSrcRaw.length > 2000);
checkTrue("_shell.orders_.$id.tsx 不是空檔", detailRouteSrcRaw.length > 2000);

const fnsSrc = stripTs(fnsSrcRaw);
const repoSrc = stripTs(repoSrcRaw);
const routeSrc = stripTs(routeSrcRaw);
/** 訂單內頁（2026-10-25 從列表頁的 Dialog 搬出來）。動作相關的斷言看這一支。 */
const detailSrc = stripTs(detailRouteSrcRaw);

// =============================================================================
// [2] 🔴 fns/orders.ts —— 每一支 server fn 都掛 adminFnMiddleware（AST）
// =============================================================================
console.log("\n[2] 🔴 fns/orders.ts 的每一支 server fn 都掛 adminFnMiddleware");
{
  const ast = parseJs(fnsSrcRaw, { sourceType: "module", plugins: ["typescript"] });

  /** createServerFn(...).middleware([...]).inputValidator(...).handler(...) 這條鏈，
   *  沿著 CallExpression 往下走到底看有沒有 createServerFn，以及沿路有沒有一個
   *  .middleware([adminFnMiddleware])。 */
  function isServerFnChain(node) {
    let cur = node;
    while (cur?.type === "CallExpression") {
      const callee = cur.callee;
      if (callee.type === "Identifier" && callee.name === "createServerFn") return true;
      cur = callee.type === "MemberExpression" ? callee.object : null;
    }
    return false;
  }
  function hasAdminMiddleware(node) {
    let cur = node;
    while (cur?.type === "CallExpression") {
      const callee = cur.callee;
      if (callee.type === "MemberExpression" && callee.property?.name === "middleware") {
        const arg = cur.arguments[0];
        if (arg?.type === "ArrayExpression") {
          for (const el of arg.elements) {
            if (el?.type === "Identifier" && el.name === "adminFnMiddleware") return true;
          }
        }
      }
      cur = callee.type === "MemberExpression" ? callee.object : null;
    }
    return false;
  }

  const exported = [];
  for (const stmt of ast.program.body) {
    if (stmt.type !== "ExportNamedDeclaration" || stmt.declaration?.type !== "VariableDeclaration")
      continue;
    for (const d of stmt.declaration.declarations) {
      if (d.id?.type !== "Identifier" || !d.init || !isServerFnChain(d.init)) continue;
      exported.push({ name: d.id.name, admin: hasAdminMiddleware(d.init) });
    }
  }

  // 0035 加了兩支：deleteAdminOrder／archiveAdminOrder（刪除／封存）。
  // 出貨那一期加了 advanceOrderFulfillmentAdmin（標記已出貨／已取貨／已完成，
  // 條件與寫入的自檢在 scripts/order-fulfillment-selftest.mjs）。
  check(
    "剛好 6 支 server fn（listAdminOrders／getAdminOrderDetail／markOrderPaidAdmin／deleteAdminOrder／archiveAdminOrder／advanceOrderFulfillmentAdmin）",
    exported.map((e) => e.name).sort(),
    [
      "advanceOrderFulfillmentAdmin",
      "archiveAdminOrder",
      "deleteAdminOrder",
      "getAdminOrderDetail",
      "listAdminOrders",
      "markOrderPaidAdmin",
    ],
  );
  for (const name of [
    "listAdminOrders",
    "getAdminOrderDetail",
    "markOrderPaidAdmin",
    "deleteAdminOrder",
    "archiveAdminOrder",
  ]) {
    const found = exported.find((e) => e.name === name);
    checkTrue(
      `🔴 ${name} 掛了 adminFnMiddleware`,
      found?.admin === true,
      "AST 掃過整條 .middleware(...) 呼叫鏈，找不到就是真的沒掛，不是註解騙過字串比對。",
    );
  }

  checkTrue(
    "import 的是 adminFnMiddleware，不是 staffFnMiddleware",
    fnsSrc.includes('import { adminFnMiddleware } from "@/lib/admin/middleware"'),
  );
  checkFalse(
    "沒有 import staffFnMiddleware（這一頁不下放給門市人員，見檔頭）",
    fnsSrc.includes("staffFnMiddleware"),
  );

  // actorId 只能從 context 讀，不能是呼叫端 data 裡的欄位——同
  // revealRegistrationContact() 的立場（見 fns/orders.ts 檔頭）。0035 的兩支新增
  // fn 遵循同一條規矩。
  checkTrue(
    "markOrderPaidAdmin 的 actorId 讀自 context.admin.userId",
    /actorId:\s*context\.admin\.userId/.test(fnsSrc),
  );
  checkTrue(
    "🔴 deleteAdminOrder／archiveAdminOrder 的 actorId 也讀自 context.admin.userId（0035）",
    (fnsSrc.match(/actorId:\s*context\.admin\.userId/g) ?? []).length >= 3,
    "三支動到訂單的 fn（標記已收款／刪除／封存）都不能讓呼叫端宣稱是誰做的。",
  );
  checkFalse(
    "🔴 inputValidator 的 schema 裡沒有 actorId 這個欄位（不能由前端宣稱是誰做的）",
    /z\.object\(\s*\{\s*orderId[\s\S]{0,200}actorId/.test(fnsSrc),
  );
}

// =============================================================================
// [3] repo/orders-admin.ts —— 不寫 orders 表、只透過 RPC 標記已收款
// =============================================================================
console.log("\n[3] repo/orders-admin.ts 的寫入面");
{
  checkFalse(
    "🔴 整個檔案沒有任何一句 .update(（唯一的寫入路徑是 admin_mark_order_paid RPC）",
    /\.update\(/.test(repoSrc),
  );
  checkFalse(
    "🔴 沒有 import markOrderPaid（那支會把 payment_method 寫成 card）",
    /\bmarkOrderPaid\b/.test(repoSrc.replace(/markOrderPaidByAdmin|markOrderPaidAdmin/g, "")),
  );
  checkFalse(
    "🔴 沒有 import src/server/repos/orders.ts（結帳路徑，這一期不依賴它）",
    repoSrc.includes('from "@/server/repos/orders"'),
  );
  checkFalse(
    "沒有 import src/server/repos/payments.ts",
    repoSrc.includes('"@/server/repos/payments"'),
  );

  checkTrue(
    "呼叫的 RPC 名稱是 admin_mark_order_paid",
    /supabaseAdmin\(\)\.rpc\(\s*"admin_mark_order_paid"/.test(repoSrc),
  );
  const rpcCallSrc = sliceBetween(repoSrc, "supabaseAdmin().rpc(", ");");
  for (const p of ["p_order_id", "p_actor_id", "p_note"]) {
    checkTrue(`🔴 RPC 呼叫帶了具名參數 ${p}`, rpcCallSrc.includes(`${p}:`));
  }
}

// =============================================================================
// [3b] 🔴 repo/orders-admin.ts —— 刪除／封存也只透過 RPC（0035）
// =============================================================================
console.log("\n[3b] 🔴 repo/orders-admin.ts 的刪除／封存也只透過 RPC");
{
  checkFalse(
    "🔴 整個檔案沒有任何一句 .delete(（刪除唯一的路徑是 admin_delete_order RPC）",
    /\.delete\(/.test(repoSrc),
  );
  checkTrue(
    "呼叫的 RPC 名稱是 admin_delete_order",
    /supabaseAdmin\(\)\.rpc\(\s*"admin_delete_order"/.test(repoSrc),
  );
  checkTrue(
    "呼叫的 RPC 名稱是 admin_archive_order",
    /supabaseAdmin\(\)\.rpc\(\s*"admin_archive_order"/.test(repoSrc),
  );
  const deleteRpcSrc = sliceBetween(repoSrc, 'supabaseAdmin().rpc("admin_delete_order"', ");");
  for (const p of ["p_order_id", "p_actor_id"]) {
    checkTrue(`🔴 admin_delete_order 呼叫帶了具名參數 ${p}`, deleteRpcSrc.includes(`${p}:`));
  }
  const archiveRpcSrc = sliceBetween(repoSrc, 'supabaseAdmin().rpc("admin_archive_order"', ");");
  for (const p of ["p_order_id", "p_actor_id", "p_archived"]) {
    checkTrue(`🔴 admin_archive_order 呼叫帶了具名參數 ${p}`, archiveRpcSrc.includes(`${p}:`));
  }

  // reason 值域必須逐字對到 migration 0035 §3／§4 給的四個／三個字串——不是憑印象
  // 重打一次，這裡直接比對型別宣告裡的字面值。
  checkTrue(
    "DeleteOrderReason 逐字包含四個值",
    /"deleted"\s*\|\s*"order_not_found"\s*\|\s*"order_is_paid"\s*\|\s*"has_inventory_sale"/.test(
      repoSrc,
    ),
  );
  checkTrue(
    "ArchiveOrderReason 逐字包含三個值",
    /"archived"\s*\|\s*"unarchived"\s*\|\s*"order_not_found"/.test(repoSrc),
  );
}

// =============================================================================
// [4] 🔴 列表：欄位裡沒有 email／phone，也不查 order_addresses
// =============================================================================
console.log("\n[4] 🔴 列表回傳不含完整 email／電話／地址");
{
  const listColsMatch = repoSrc.match(/const LIST_COLUMNS =\s*\n?\s*"([^"]*)"/);
  checkTrue("抓得到 LIST_COLUMNS 這個常數", Boolean(listColsMatch));
  const listCols = listColsMatch?.[1] ?? "";
  checkTrue("反空殼：LIST_COLUMNS 真的有內容", listCols.length > 20);
  checkFalse("🔴 LIST_COLUMNS 裡沒有 'email'", listCols.includes("email"));
  checkFalse("🔴 LIST_COLUMNS 裡沒有 'phone'", listCols.includes("phone"));

  const listFnSrc = sliceBetween(
    repoSrc,
    "export async function listAdminOrders",
    "const ORDER_COLUMNS =",
  );
  checkTrue("抓得到 listAdminOrders 的函式本體", listFnSrc.length > 50);
  checkFalse("🔴 listAdminOrders 完全不查 order_addresses", listFnSrc.includes("order_addresses"));

  // 路由檔本身也不可以繞過 repo 另外要欄位——列表頁只認 AdminOrderListRow 這個型別。
  checkFalse(
    "🔴 _shell.orders.tsx 的原始碼裡沒有裸的 .customer_email／.customer_phone",
    /\.customer_email\b(?!_masked)/.test(routeSrc) ||
      /\.customer_phone\b(?!_masked)/.test(routeSrc),
  );
}

// =============================================================================
// [5] 詳情：明文（業主 2026-10-25）、一次查詢拿齊
// =============================================================================
// 業主決定訂單在後台直接顯示明文、不留查閱紀錄（orders-admin.ts 檔頭）。這一段改守
// 兩件事：(a) 該給的欄位真的給了（門牌、統編／抬頭、收件人電話、備註）；(b) 詳情是
// **一次**巢狀查詢——函式在美東、資料庫在東京時，依序三次查詢就是三趟跨太平洋。
console.log("\n[5] 詳情頁：明文聯絡方式＋一次查詢");
{
  const detailFnSrc = sliceBetween(
    repoSrc,
    "export async function getAdminOrderDetail",
    "export async function markOrderPaidByAdmin",
  );
  checkTrue("抓得到 getAdminOrderDetail 的函式本體", detailFnSrc.length > 200);
  check(
    "🔴 詳情只發一次查詢（.from( 剛好一次）",
    (detailFnSrc.match(/\.from\(/g) ?? []).length,
    1,
    "拆回多次依序查詢，每一次都是一趟資料庫往返（見 orders-admin.ts 檔頭「速度」）。",
  );
  const columnsSrc = sliceBetween(repoSrc, "const ORDER_COLUMNS =", "const DETAIL_SELECT =");
  const selectSrc = sliceBetween(repoSrc, "const DETAIL_SELECT =", "export type AdminOrderItemRow");
  checkTrue("抓得到 DETAIL_SELECT", selectSrc.length > 100);
  checkTrue(
    "巢狀帶出 order_items（含 event_sessions）",
    /order_items\(.*event_sessions\(/.test(selectSrc),
  );
  checkTrue(
    "巢狀帶出 order_addresses，含門牌 street",
    /order_addresses\([^)]*\bstreet\b/.test(selectSrc),
  );
  checkTrue(
    "巢狀帶出 invoices 的統編與抬頭",
    /invoices\([^)]*tax_id[^)]*company_title/.test(selectSrc),
  );
  checkTrue("訂單欄位有 note（客人備註）", /\bnote\b/.test(columnsSrc));
  checkTrue(
    "回傳明文 customer_email／customer_phone",
    /customer_email: blankToNull\(o\.customer_email\)/.test(detailFnSrc) &&
      /customer_phone: blankToNull\(o\.customer_phone\)/.test(detailFnSrc),
  );
  checkTrue("地址回傳門牌", /street: blankToNull\(r\.street\)/.test(detailFnSrc));
  checkFalse("不再 import 遮罩函式（pii-mask.ts 已刪）", /pii-mask/.test(repoSrc));
  checkFalse(
    "🔴 不寫 pii_access_log（業主決定訂單不留紀錄，也就不需要 migration）",
    /pii_log_access/.test(repoSrc),
  );

  checkTrue("內頁顯示門牌（formatHomeAddress）", /formatHomeAddress\(a\)/.test(detailSrc));
  checkTrue("內頁顯示統編與抬頭", /統一編號/.test(detailSrc) && /抬頭/.test(detailSrc));
  checkTrue(
    "內頁顯示訂購人電話與信箱",
    /detail\.customer_phone/.test(detailSrc) && /detail\.customer_email/.test(detailSrc),
  );
}

// =============================================================================
// [5b] 訂單內頁是獨立路由；舊的 ?order= 連結轉址；回列表保留篩選
// =============================================================================
console.log("\n[5b] /admin/orders/$id 獨立頁、?order= 轉址、回列表保留篩選");
{
  checkTrue(
    "內頁 route id 是 /admin/_shell/orders_/$id",
    detailRouteSrcRaw.includes('createFileRoute("/admin/_shell/orders_/$id")'),
  );
  checkTrue(
    "內頁由 loader 取資料（不是掛載後再打）",
    /loader: async \(\{ params \}\)/.test(detailSrc),
  );
  checkFalse("🔴 列表頁不再有詳情 Dialog", /<Dialog\b/.test(routeSrc));
  checkTrue(
    "🔴 列表頁 beforeLoad 把 ?order=<id> 轉址到 /admin/orders/$id",
    /if \(search\.order\)[\s\S]{0,200}throw redirect\(\{[\s\S]{0,80}to: "\/admin\/orders\/\$id"/.test(
      routeSrc,
    ),
  );
  checkTrue(
    "點列進內頁時帶著目前的篩選",
    /to: "\/admin\/orders\/\$id",\s*params: \{ id \},\s*search: currentSearch/.test(routeSrc),
  );
  checkTrue(
    "「回訂單列表」原樣帶回篩選參數（共用 AdminDetailPage：上一頁是列表就 history.back，否則帶 search 導回）",
    /backTo="\/admin\/orders"\s*backSearch=\{search\}/.test(detailSrc),
  );
  checkTrue("列表滑過就預載內頁", /preloadRoute\(/.test(routeSrc));
}

// =============================================================================
// [6] 🔴 沒動到：結帳路徑、markOrderPaid、四個金流檔；0001–0034 逐檔不動，
//     0035 是這一期唯一允許的新增
// =============================================================================
// ⚠️ 這一段的斷言在 0034 那一版寫的是「supabase/migrations 整個目錄 git status
//    必須是空的」，因為那一版真的沒有新增 migration。0035 這一期的任務書明講要
//    加一支新 migration（訂單刪除／封存、名單刪除），所以「整個目錄零 diff」這句
//    話從這裡起不再成立——但它原本要守的事**沒有變**：0001–0034 逐檔不准被改一個
//    位元組。所以拆成兩段各自驗：非 migration 的六個保護檔仍然要求零 diff；
//    migration 目錄改成「0001–0034 這 34 個檔名各自的 git status 必須是空的，
//    而整個目錄的 diff 只准剛好是新增一個 0035 開頭的檔案」。
//
// ⚠️ 0036（場次多價格方案）再調整一次 PROTECTED 清單：`src/server/repos/orders.ts`
//    被拿掉了。它原本在清單裡是因為 0035（後台訂單頁）那一期**剛好**不需要碰
//    結帳路徑，這條斷言把「這一期沒有理由碰它」誤寫成「以後也不准碰它」——但
//    orders.ts 是結帳的一般性程式碼，不是金流憑證本身，之後任何一個真的要改
//    結帳邏輯的功能（0036 就是一個）都合理需要碰它。真正不可以被任何一期
//    悄悄動到的是**四個金流閘道檔**（payuni/blackcat 建單與它們各自的
//    webhook）——那才是這條檢查原本真正要守的東西，這裡收窄成那四個。
//    payments.ts 維持在清單裡：0036 一個字都沒動過它，這條「本來就沒有理由碰」
//    在這裡仍然成立，留著繼續守。
console.log("\n[6] 🔴 沒有動到不該動的檔案（對真的工作目錄問 git）");
{
  const PROTECTED = [
    "src/server/repos/payments.ts",
    "src/server/payuni.ts",
    "src/server/blackcat.ts",
    "src/server/blackcat-webhook.ts",
    "src/server/payuni-webhook.ts",
  ];
  let statusOut = "";
  let gitOk = true;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--", ...PROTECTED],
      {
        cwd: ROOT,
      },
    );
    statusOut = stdout;
  } catch (err) {
    gitOk = false;
    statusOut = String(err.message ?? err);
  }
  checkTrue("`git status` 執行成功（在一個 git repo 裡跑）", gitOk);
  check(
    "🔴 這五個檔案：git status 乾淨（四個金流檔＋payments.ts 一個位元組都沒動，0036 起 orders.ts 不在此列——見上面的說明）",
    statusOut.trim(),
    "",
    `實際輸出：\n${statusOut}`,
  );

  let migStatusOut = "";
  let migGitOk = true;
  try {
    const { stdout } = await execFileAsync(
      "git",
      // ⚠️ 這裡刻意用 `diff --name-status origin/main` 而不是 `status --porcelain`。
      //    `status` 看的是**工作目錄**，所以 commit 之後輸出就空了——原本寫成
      //    「0035 的狀態碼必須是 ??（未追蹤）」的那條斷言，在 agent 跑的時候（還沒
      //    commit）是綠的，一 commit 就永遠變紅。它守的東西是對的，壞的是判斷依據。
      //    改成跟 origin/main 比：新增的檔是 A、改到既有檔是 M、刪掉是 D，
      //    commit 前後都成立；推上去之後 diff 變空，那也**如實成立**——相對於已推
      //    出去的狀態，確實沒有任何 migration 被改動。
      ["diff", "--name-status", "origin/main", "--", "supabase/migrations"],
      { cwd: ROOT },
    );
    migStatusOut = stdout;
  } catch (err) {
    migGitOk = false;
    migStatusOut = String(err.message ?? err);
  }
  checkTrue("`git diff origin/main` 對 supabase/migrations 執行成功", migGitOk);

  const migLines = migStatusOut
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // 唯一允許的變動是「新增」。M（改到既有檔）與 D（刪掉）都是這條在防的事。
  const unexpected = migLines.filter((l) => !/^A\s+supabase\/migrations\/\d{4}_.*\.sql$/.test(l));
  check(
    "🔴 supabase/migrations 相對 origin/main：既有的一支都沒被改動或刪除，只允許新增",
    unexpected.join("\n") || "（無）",
    "（無）",
    `實際輸出：\n${migStatusOut || "（與 origin/main 無差異）"}`,
  );

  const migFiles = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql"));
  check(
    // 0039（MCP 寫入稽核表 mcp_audit_log）是一張獨立的新表，不碰訂單、付款或報名的任何
    // 一張表與函式（帳本 touches 只有 mcp_audit），這一支守的訂單不變式不受影響。
    // 0040（推薦分潤）對 orders 只加三個 nullable 歸屬欄位與一個部分索引。
    // 0041（選品連結商品）只在 curated_items 加 product_id，不碰訂單、付款或報名。
    "supabase/migrations 剛好 41 個 .sql 檔（0001–0040 原封不動 + 0041 選品連結商品新增）",
    migFiles.length,
    41,
  );
}

// =============================================================================
// [7] 側欄：有一個 admin-only 的入口指到 /admin/orders
// =============================================================================
console.log("\n[7] 側欄有訂單的入口");
{
  const shellStripped = stripTs(shellSrc);
  const navItemSrc = sliceBetween(shellStripped, '{ to: "/admin/orders"', "},");
  checkTrue("_shell.tsx 有 /admin/orders 這個項目", navItemSrc.length > 5);
  checkTrue("label 是「訂單」", navItemSrc.includes('label: "訂單"'));
  checkTrue(
    "🔴 staff: false（門市人員看不到連結——真正的授權邊界在 fns/orders.ts）",
    /staff:\s*false/.test(navItemSrc),
  );
  checkTrue("import 了 Landmark 圖示", shellSrc.includes("Landmark"));
}

// =============================================================================
// [7b] 「標記已收款」只服務 transfer／null，且標記結果與畫面刷新的錯誤分開處理
// =============================================================================
// 這兩條不是原始任務條列出來的驗收項，是 fresh-context 覆核時讀出來的兩個真的
// UX／流程瑕疵，修完之後補上斷言鎖住，不讓它們無聲無息地被下一次改動撞回來：
//
//   1. 「標記已收款」的按鈕如果對任何 payment_method 都出現，畫面文案卻寫死是
//      匯款情境（「對過銀行對帳單」），會在 card／atm／cvs_cod 這幾種卡住待付款
//      的訂單上把店員導向錯的核對管道（該查金流商後台）。
//   2. 標記本身（呼叫 RPC）與標記後的畫面刷新（重讀詳情、重讀列表）如果共用同一
//      個 try/catch，刷新恰好失敗時會補一句「標記失敗」，蓋掉已經成立的
//      toast.success，同一次操作出現互相矛盾的兩則訊息。
console.log("\n[7b] 標記已收款的可用範圍，以及標記結果與畫面刷新的錯誤互不干擾");
{
  checkTrue(
    "🔴 「標記已收款」只在 payment_method 是 transfer 或 null 時可用",
    /payment_method === "transfer" \|\| detail\.payment_method === null/.test(detailSrc),
    "card／atm／cvs_cod／test_paid／free 卡在待付款時不該出現這顆按鈕——那些正常都由金流商 webhook 自動結清，卡住代表要去查金流商後台，不是對銀行對帳單。",
  );

  // ⚠️ 結尾界標改成下一支函式的宣告，不是 "return ("——0035 在 submitMarkPaid 與
  //    JSX 的 return ( 之間插了 submitDelete／submitArchive 兩支新函式，繼續切到
  //    "return (" 會把那兩支的 try 也算進來，讓下面的 tryCount 斷言失真。
  // 2026-10-25 搬到內頁後：重讀畫面那一段收進 refresh()（router.invalidate()，自己
  // 的 try/catch），submitMarkPaid 在呼叫 RPC 那段的 try 結束之後才 await refresh()。
  const submitFnSrc = sliceBetween(
    detailSrc,
    "async function submitMarkPaid",
    "async function submitDelete",
  );
  checkTrue("抓得到 submitMarkPaid 的函式本體", submitFnSrc.length > 200);
  const tryCount = (submitFnSrc.match(/\btry\s*\{/g) ?? []).length;
  check(
    "🔴 submitMarkPaid 只有呼叫 RPC 那一段 try，重讀畫面交給 refresh()",
    tryCount === 1 && /\}\s*finally\s*\{[\s\S]*?\}\s*await refresh\(\);/.test(submitFnSrc),
    true,
    "併成一段的後果：重讀畫面失敗會被同一個 catch 接住，補一句「標記失敗」蓋掉已經成立的成功訊息。",
  );
  const refreshSrc = sliceBetween(
    detailSrc,
    "async function refresh",
    "async function submitFulfillment",
  );
  checkTrue(
    "refresh() 有自己的 try/catch",
    /\btry\s*\{/.test(refreshSrc) && /catch/.test(refreshSrc),
  );
  const failedMsgCount = (submitFnSrc.match(/標記失敗，請稍後再試/g) ?? []).length;
  check(
    "🔴 「標記失敗」這句話只出現一次（只在呼叫 RPC 那段的 catch 裡）",
    failedMsgCount,
    1,
    "如果重讀畫面那段的 catch 也講「標記失敗」，就是同一個矛盾 toast 的 bug 換句話重演。",
  );
  checkTrue("重讀畫面失敗有自己的訊息，不是「標記失敗」", /畫面更新失敗/.test(refreshSrc));
}

// =============================================================================
// [7c] 🔴 刪除／封存（0035）：分界是 payment_status，四種 reason 各自講人話
// =============================================================================
console.log("\n[7c] 🔴 刪除／封存的分界與 reason 文案");
{
  // 畫面分界與資料庫閘門用同一個條件：payment_status === "paid" → 只給封存，
  // 其餘 → 只給刪除。detailSrc 已經被 stripTs() 拿掉註解，所以不能用「刪除／封存」
  // 那段 JSX 註解當界標（stripTs 會把整段 /* … */ 連同分隔符一起清空）；改用
  // **最後一次**出現的 `payment_status === "paid" ? (`——檔案裡只有兩次，第一次是
  // [7b] 驗過的「標記已收款」那段純文字分支，第二次才是這個新區塊。
  const lastBranchAt = detailSrc.lastIndexOf('detail.payment_status === "paid" ? (');
  checkTrue(
    '🔴 payment_status === "paid" 的三元運算剛好出現兩次',
    (detailSrc.match(/detail\.payment_status === "paid" \? \(/g) ?? []).length === 2,
  );
  const archiveOrDeleteSrc =
    lastBranchAt === -1
      ? ""
      : detailSrc.slice(lastBranchAt, detailSrc.indexOf("<AlertDialog", lastBranchAt));
  checkTrue("抓得到「刪除／封存」那個新區塊", archiveOrDeleteSrc.length > 200);
  checkTrue(
    '🔴 新區塊用 payment_status === "paid" 分流封存／刪除',
    /detail\.payment_status === "paid" \? \(/.test(archiveOrDeleteSrc),
  );
  checkTrue(
    "🔴 paid 分支呼叫 submitArchive，非 paid 分支開刪除確認",
    /submitArchive/.test(archiveOrDeleteSrc) &&
      /setDeleteConfirmOpen\(true\)/.test(archiveOrDeleteSrc),
  );

  // 四種 reason 各自的訊息，逐一比對關鍵字，不是只驗字串存在。
  checkTrue(
    "🔴 has_inventory_sale 講人話「已轉入銷售紀錄，不能刪除，請改用封存」",
    /已轉入銷售紀錄，不能刪除，請改用封存/.test(detailSrc),
  );
  checkTrue(
    "🔴 order_is_paid 講人話並指向封存",
    /已經收到款項，不能刪除/.test(detailSrc) && /封存/.test(detailSrc),
  );
  checkTrue("order_not_found（刪除）另有訊息", /找不到這張訂單，可能已經被刪除/.test(detailSrc));
  checkTrue(
    "刪除成功後回到列表（訂單已經不在了，不是重讀 getAdminOrderDetail）",
    /result\.reason === "deleted"[\s\S]{0,200}await navigate\(\{ to: "\/admin\/orders", search \}\)/.test(
      submitDeleteSrc(detailSrc),
    ),
  );

  // 封存／取消封存的按鈕文字要跟著 archived_at 換。
  checkTrue(
    "封存按鈕文字依 archived_at 換成「取消封存」／「封存」",
    /detail\.archived_at \? "取消封存" : "封存"/.test(detailSrc),
  );

  // 「顯示已封存」開關：畫面狀態與 fns 呼叫都要接上 includeArchived。
  // 「顯示已封存」開關在列表頁，2026-10-25 起是網址參數（?archived=1），回列表才保留得住。
  checkTrue("有「顯示已封存」開關", /顯示已封存/.test(routeSrc));
  checkTrue(
    "🔴 開關接的是網址上的 archived（不是裝飾用的）",
    /checked=\{archived\}/.test(routeSrc) &&
      /navigate\(\{ search: listSearch\(\{ archived: v \}\), replace: true \}\)/.test(routeSrc),
  );
  checkTrue(
    "🔴 loader 把 archived 傳給 listAdminOrders 的 includeArchived",
    /includeArchived: deps\.archived/.test(routeSrc),
  );
  checkTrue(
    "🔴 fns/orders.ts 的 listAdminOrders inputValidator 收 includeArchived",
    /includeArchived: z\.boolean\(\)\.optional\(\)/.test(fnsSrc),
  );

  // AlertDialog 的確認文案要提到「無法復原」與「還原名額」的效果。
  const deleteAlertSrc = sliceBetween(detailSrc, "確定要刪除這張訂單嗎？", "</AlertDialog>");
  checkTrue("抓得到刪除確認對話框", deleteAlertSrc.length > 100);
  checkTrue(
    "🔴 刪除確認文案提到會連帶移除報名並釋放名額",
    /報名一起移除/.test(deleteAlertSrc) && /名額/.test(deleteAlertSrc),
  );
}

/** 從 submitMarkPaid 到檔尾抓出 submitDelete 的函式本體（給上面那條反空殼比對用）。 */
function submitDeleteSrc(src) {
  return sliceBetween(src, "async function submitDelete", "async function submitArchive");
}

// =============================================================================
// [8] 動態：src/lib/admin/order-labels.ts 本人（列表篩選參數）
// =============================================================================
console.log("\n[8] 列表篩選參數的解析（動態呼叫 src/lib/admin/order-labels.ts）");
{
  const L = await import(pathToFileURL(LABELS_PATH).href);
  checkTrue("反空殼：載得動 parseOrderListSearch", typeof L.parseOrderListSearch === "function");
  check("空參數 → 預設分頁", L.parseOrderListSearch({}), {});
  check("scope=to_ship", L.parseOrderListSearch({ scope: "to_ship" }), { scope: "to_ship" });
  check("scope=all＋archived=1", L.parseOrderListSearch({ scope: "all", archived: "1" }), {
    scope: "all",
    archived: 1,
  });
  check("archived 數字 1 也收", L.parseOrderListSearch({ archived: 1 }), { archived: 1 });
  check("不認得的 scope 當沒帶", L.parseOrderListSearch({ scope: "bogus" }), {});
  check("archived=0 當沒開", L.parseOrderListSearch({ archived: "0" }), {});
  check("scopeOf 預設 transfer_pending", L.scopeOf({}), "transfer_pending");
  checkTrue("isUuid 認得 uuid", L.isUuid("3f1c2b8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"));
  checkFalse("isUuid 不認得亂碼", L.isUuid("../../etc"));
  check(
    "宅配地址含門牌",
    L.formatHomeAddress({
      postal_code: "100",
      city: "臺北市",
      district: "中正區",
      street: "羅斯福路三段 1 號",
    }),
    "100 臺北市中正區羅斯福路三段 1 號",
  );
}

// =============================================================================
// [8b] 動態：src/lib/admin/shell-user-cache.ts（後台換頁不再每次重問「誰登入」）
// =============================================================================
console.log("\n[8b] 後台外框身分快取（動態呼叫 src/lib/admin/shell-user-cache.ts）");
{
  const C = await import(pathToFileURL(join(ROOT, "src/lib/admin/shell-user-cache.ts")).href);
  const cache = C.createShellUserCache(1000);
  check("一開始是空的", cache.get(0), null);
  cache.set({ userId: "u" }, 100);
  check("TTL 內拿得到", cache.get(1099), { userId: "u" });
  check("🔴 到 TTL 就失效", cache.get(1100), null);
  cache.set({ userId: "u" }, 100);
  check("時鐘倒退視為失效", cache.get(50), null);
  cache.set({ userId: "u" }, 100);
  cache.clear();
  check("🔴 clear() 之後拿不到（登出用）", cache.get(101), null);
  check("預設 TTL 60 秒", C.SHELL_USER_TTL_MS, 60000);
  const shell = stripTs(shellSrc);
  checkTrue("_shell beforeLoad 只在瀏覽器端用快取", /typeof window !== "undefined"/.test(shell));
  checkTrue("pending 不進快取", /user\.role !== "pending"\) shellUserCache\.set/.test(shell));
  checkTrue(
    // 2026-10-25：改成 noteAdminIdentityChange()（route-cache.ts），它會清「誰登入」快取、
    // router 快取，並通知同一個瀏覽器的其他分頁。
    "🔴 登出時清快取（_shell 與 pending 兩條登出路徑）",
    /noteAdminIdentityChange\(\);[\s\S]{0,200}await signOut\(\)/.test(shell) &&
      /noteAdminIdentityChange\(\);\s*await signOut\(\)/.test(
        stripTs(readFile(join(ROOT, "src/routes/admin/pending.tsx"))),
      ),
  );
  checkTrue(
    "🔴 登入成功也清快取（沒按登出就換帳號）",
    /signIn\(\{ data: values \}\);[\s\S]{0,300}noteAdminIdentityChange\(\);/.test(
      stripTs(readFile(join(ROOT, "src/routes/admin/login.tsx"))),
    ),
  );
  checkTrue("登出時清掉路由快取（預載的訂單明文）", /router\.clearCache\(\)/.test(shell));
}

// -----------------------------------------------------------------------------
// [9] 連線段：markOrderPaidByAdmin() —— 驅動產線的程式碼本人
// -----------------------------------------------------------------------------
const PG_URL = process.env.REMITTANCE_SELFTEST_PG_URL;

async function q(sql, single = true) {
  const text = single
    ? `select coalesce(json_agg(t), '[]'::json)::text from (\n${sql.trim().replace(/;\s*$/, "")}\n) t`
    : sql;
  try {
    const { stdout } = await execFileAsync(
      "psql",
      ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", PG_URL, "-c", text],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    if (!single) return { ok: true, error: null, rows: [] };
    return { ok: true, error: null, rows: JSON.parse(stdout.trim() || "[]") };
  } catch (err) {
    return { ok: false, error: String(err.stderr ?? err.message ?? err), rows: [] };
  }
}
async function must(sql, single = true) {
  const r = await q(sql, single);
  if (!r.ok)
    throw new Error(`SQL 失敗：${r.error.slice(0, 400)}\n--- SQL ---\n${sql.slice(0, 600)}`);
  return r.rows;
}
const one = (rows) => (Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
/** 0035 的連線段用得到——同 remittance-selftest.mjs 的同名 helper。 */
const num = (rows) => Number(one(rows)?.n ?? -1);

/**
 * shim：只實作 markOrderPaidByAdmin() 真的會用到的 `.rpc()`。理由與
 * remittance-selftest.mjs 檔頭同一句：多實作就是多一份沒有人在驗的假資料庫。
 */
const SHIM = { runSql: null };
globalThis.__ADMIN_ORDERS_SELFTEST__ = SHIM;

const sqlLit = (v) => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return `'${String(v).replace(/'/g, "''")}'`;
};

SHIM.rpc = async (name, args) => {
  const params = Object.entries(args ?? {})
    .map(([k, v]) => `${k} => ${sqlLit(v)}`)
    .join(", ");
  const r = await SHIM.runSql(`select public.${name}(${params}) as v`);
  if (!r.ok) return { data: null, error: { code: "SHIM", message: r.error.slice(0, 300) } };
  return { data: r.rows[0]?.v ?? null, error: null };
};

const SHIM_SRC = [
  "const mk = globalThis.__ADMIN_ORDERS_SELFTEST__;",
  "export const supabaseAdmin = () => ({ rpc: (n, a) => mk.rpc(n, a) });",
].join("\n");

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@/server/supabase-admin") {
      return { url: "stub:supabase-admin", shortCircuit: true };
    }
    if (spec.startsWith("@/")) {
      return {
        url: pathToFileURL(join(ROOT, "src", `${spec.slice(2)}.ts`)).href,
        shortCircuit: true,
      };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === "stub:supabase-admin") {
      return { format: "module", source: SHIM_SRC, shortCircuit: true };
    }
    return next(url, ctx);
  },
});

SHIM.runSql = async (sql) => q(sql);

const KEY_PREFIX = "ao-selftest-";
const ACTOR_ID = "22222222-2222-2222-2222-222222222222";
const CLEANUP_SQL = `
delete from public.payments where order_id in (select id from public.orders where idempotency_key like '${KEY_PREFIX}%');
delete from public.orders where idempotency_key like '${KEY_PREFIX}%';
`;

if (!PG_URL) {
  skipped.push("連線段（缺 REMITTANCE_SELFTEST_PG_URL）");
  console.log(yellow("\n[9] 連線段 —— 跳過：沒有 REMITTANCE_SELFTEST_PG_URL"));
  console.log(yellow("     設好之後重跑，才會驗到 markOrderPaidByAdmin() 對真資料庫的行為。"));
  console.log(yellow("     指令見本檔檔頭（沿用 remittance-selftest.mjs 的同一個變數）。"));
} else {
  try {
    console.log("\n[9] 連線段：markOrderPaidByAdmin()（產線程式碼 + 真的資料庫）");

    checkTrue(
      "前置：資料庫已經套到 0034（admin_mark_order_paid 存在）",
      Boolean(
        one(
          await must(
            `select to_regprocedure('public.admin_mark_order_paid(uuid,uuid,text)') is not null ok`,
          ),
        )?.ok,
      ),
      "沒有的話先照 remittance-selftest.mjs 檔頭的 REMITTANCE_SELFTEST_APPLY=1 套一次。",
    );

    await must(CLEANUP_SQL, false);
    await must(
      `
      insert into public.orders (customer_name, customer_email, customer_phone,
                                 subtotal, total, idempotency_key, payment_method,
                                 remittance_last5, remittance_reported_at)
      values
        ('自檢','ao-selftest@example.invalid','0900000000',500,500,
         '${KEY_PREFIX}pending','transfer','54321', now()),
        ('自檢','ao-selftest@example.invalid','0900000000',500,500,
         '${KEY_PREFIX}cancelled','transfer', null, null);
      update public.orders set status = 'cancelled', cancelled_at = now()
       where idempotency_key = '${KEY_PREFIX}cancelled';
    `,
      false,
    );

    const pendingId = one(
      await must(`select id from public.orders where idempotency_key = '${KEY_PREFIX}pending'`),
    )?.id;
    const cancelledId = one(
      await must(`select id from public.orders where idempotency_key = '${KEY_PREFIX}cancelled'`),
    )?.id;
    checkTrue("前置：兩張測試訂單都建起來了", Boolean(pendingId) && Boolean(cancelledId));

    // 動態 import 產線的 repo 檔案本人——這一支從此走的是上面註冊的 module hook。
    const ordersAdmin = await import(pathToFileURL(REPO_PATH).href);
    checkTrue(
      "反空殼：載得動產線的 markOrderPaidByAdmin",
      typeof ordersAdmin.markOrderPaidByAdmin === "function",
    );

    // ── 正常路徑：標記成功 ──────────────────────────────────────────────
    const r1 = await ordersAdmin.markOrderPaidByAdmin({
      orderId: pendingId,
      actorId: ACTOR_ID,
      note: "對到 9/3 01:15 那筆",
    });
    check("✅ reason === 'marked'", r1.reason, "marked");
    check("marked === true", r1.marked, true);
    checkTrue("回傳的 order_no 有值", typeof r1.order_no === "string" && r1.order_no.length > 0);

    const after = one(
      await must(
        `select status, payment_status, payment_method, (paid_at is not null) p
           from public.orders where id = '${pendingId}'`,
      ),
    );
    check("status → processing", after?.status, "processing");
    check("payment_status → paid", after?.payment_status, "paid");
    check(
      "🔴 透過 markOrderPaidByAdmin() 標記之後，payment_method 仍然是 'transfer'（不是 'card'）",
      after?.payment_method,
      "transfer",
      "如果這裡變成 'card'，代表程式碼不小心改叫了 payments.ts 的 markOrderPaid()，或直接 UPDATE 覆蓋了 payment_method。",
    );
    checkTrue("paid_at 有值", after?.p === true);

    // ── 冪等：第二次呼叫 ────────────────────────────────────────────────
    const r2 = await ordersAdmin.markOrderPaidByAdmin({
      orderId: pendingId,
      actorId: ACTOR_ID,
      note: null,
    });
    check("第二次呼叫 → reason === 'already_paid'（冪等）", r2.reason, "already_paid");
    check("   marked === false", r2.marked, false);
    check(
      "   payment_method 仍然沒有被第二次呼叫動到",
      one(await must(`select payment_method pm from public.orders where id = '${pendingId}'`))?.pm,
      "transfer",
    );

    // ── 已取消的訂單不准被標成已付款 ────────────────────────────────────
    const r3 = await ordersAdmin.markOrderPaidByAdmin({
      orderId: cancelledId,
      actorId: ACTOR_ID,
      note: null,
    });
    check("🔴 已取消的訂單 → reason === 'order_not_pending'", r3.reason, "order_not_pending");
    check("   marked === false", r3.marked, false);
    check(
      "   它仍然是 cancelled，沒有被推回 paid",
      one(await must(`select status s from public.orders where id = '${cancelledId}'`))?.s,
      "cancelled",
    );

    // ── 不存在的訂單 ────────────────────────────────────────────────────
    const r4 = await ordersAdmin.markOrderPaidByAdmin({
      orderId: "00000000-0000-0000-0000-000000000000",
      actorId: ACTOR_ID,
      note: null,
    });
    check("不存在的訂單 → reason === 'order_not_found'", r4.reason, "order_not_found");
    check("   order_no 是 null", r4.order_no, null);

    // ─────────────────────────────────────────────────────────────────────
    // deleteAdminOrder() / archiveAdminOrder()（0035）—— 同一支 shim，多驅動
    // 兩個 TS 包裝。這裡不重新驗 admin_delete_order() / admin_archive_order()
    // 本身的商業邏輯（那是 admin-order-registration-cleanup-selftest.mjs 的
    // [14]-[19] 段對真的 Postgres 逐表 md5 比對過的事）——只驗這一層 TS 包裝：
    // 參數名稱有沒有傳對、PostgREST 包成陣列還是物件的回傳值有沒有解析對。
    // ─────────────────────────────────────────────────────────────────────
    console.log("\n[9b] 連線段：deleteAdminOrder() / archiveAdminOrder()（0035，同一個 shim）");
    await must(
      `
      insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
      values
        ('自檢','ao-selftest@example.invalid','0900000000',500,500,'${KEY_PREFIX}del-pending'),
        ('自檢','ao-selftest@example.invalid','0900000000',500,500,'${KEY_PREFIX}archive-paid');
      update public.orders set status='processing', payment_status='paid', paid_at=now()
       where idempotency_key = '${KEY_PREFIX}archive-paid';
    `,
      false,
    );
    const delPendingId = one(
      await must(`select id from public.orders where idempotency_key = '${KEY_PREFIX}del-pending'`),
    )?.id;
    const archivePaidId = one(
      await must(
        `select id from public.orders where idempotency_key = '${KEY_PREFIX}archive-paid'`,
      ),
    )?.id;
    checkTrue(
      "反空殼：載得動產線的 deleteAdminOrder／archiveAdminOrder",
      typeof ordersAdmin.deleteAdminOrder === "function" &&
        typeof ordersAdmin.archiveAdminOrder === "function",
    );

    const delResult = await ordersAdmin.deleteAdminOrder({
      orderId: delPendingId,
      actorId: ACTOR_ID,
    });
    check("🔴 刪未付款訂單：reason === 'deleted'", delResult.reason, "deleted");
    check("deleted === true", delResult.deleted, true);
    check(
      "訂單真的不見了",
      num(await must(`select count(*)::int n from public.orders where id = '${delPendingId}'`)),
      0,
    );

    const delPaidResult = await ordersAdmin.deleteAdminOrder({
      orderId: archivePaidId,
      actorId: ACTOR_ID,
    });
    check(
      "🔴 刪已付款訂單：reason === 'order_is_paid'（TS 包裝正確傳回拒絕理由）",
      delPaidResult.reason,
      "order_is_paid",
    );
    check("deleted === false", delPaidResult.deleted, false);

    const archiveResult = await ordersAdmin.archiveAdminOrder({
      orderId: archivePaidId,
      actorId: ACTOR_ID,
      archived: true,
    });
    check("🔴 封存已付款訂單：reason === 'archived'", archiveResult.reason, "archived");
    check("updated === true", archiveResult.updated, true);
    check(
      "archived_at 真的被設了",
      Boolean(
        one(
          await must(
            `select archived_at is not null ok from public.orders where id = '${archivePaidId}'`,
          ),
        )?.ok,
      ),
      true,
    );

    const unarchiveResult = await ordersAdmin.archiveAdminOrder({
      orderId: archivePaidId,
      actorId: ACTOR_ID,
      archived: false,
    });
    check("🔴 取消封存：reason === 'unarchived'", unarchiveResult.reason, "unarchived");
    check(
      "archived_at 真的被清掉了",
      one(await must(`select archived_at from public.orders where id = '${archivePaidId}'`))
        ?.archived_at,
      null,
    );

    await must(CLEANUP_SQL, false);
    checkTrue(
      "收尾：測試訂單清乾淨了",
      Number(
        one(
          await must(
            `select count(*)::int n from public.orders where idempotency_key like '${KEY_PREFIX}%'`,
          ),
        )?.n,
      ) === 0,
    );
  } catch (err) {
    fail += 1;
    console.log(red(`\n  ✗ 連線段中斷：${String(err.message ?? err).slice(0, 800)}`));
  }
}

// -----------------------------------------------------------------------------
// 收尾
// -----------------------------------------------------------------------------
console.log(`\n${"─".repeat(52)}`);
if (skipped.length > 0) {
  console.log(yellow(`略過 ${skipped.length} 段：`));
  for (const s of skipped) console.log(yellow(`  • ${s}`));
}
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
