#!/usr/bin/env node
/**
 * inventory-adjustments-selftest.mjs —— 進貨、庫存盤點、在庫異動（0017）的自檢
 *
 * 兩段，理由與 inventory-products-selftest 相同：沒有金鑰的機器上也要有意義。
 *
 *   [靜態] 讀 supabase/migrations/0017 與新增的 TypeScript 檔，守的是**設計不變量**：
 *          · 新的寫入路徑一筆都不寫已凍結的 inv.inventory_adjustments
 *          · 異動單的 status 由資料庫算，schema 與 payload 裡連這個欄位都沒有
 *          · 盤點送的是實盤數量而不是差異
 *          · 庫存加減只在 trigger 裡，RPC 沒有一行 UPDATE inv.products.stock_quantity
 *          · 新 view 有沒有先 revoke 再 grant
 *          · 前端沒有 react-query / use-toast / LocalizedField / 靜態 xlsx / OCR
 *          答案都寫在檔案裡。永遠會跑。
 *
 *   [實測] 對目標資料庫真的跑一輪：進貨 → 賣掉一部分 → 編輯進貨（驗 FIFO 不會
 *          對不起來）→ 盤盈盤虧 → 六類狀態機 → 沖帳 → Excel 匯入，然後全部刪掉
 *          並證明基準線一筆不差。需要 SUPABASE_ACCESS_TOKEN；沒有就整段 skip。
 *
 * ⚠️ 實測段會在**正式資料庫**建資料再刪掉。所有測試資料都帶固定前綴（見 MARK），
 *    開頭與結尾各清一次 —— 開頭那次是為了讓上一輪中途掛掉的殘骸不會累積。
 *
 * ⚠️ 清理有兩個坑，都是 0017 自己的守衛造成的（也就是它們真的有效）：
 *    · 已確認的異動單不可刪 → 先 update status='draft' 再刪
 *      （confirmed → draft 不觸發任何庫存 trigger）
 *    · 已出庫的進貨批次不可刪 → 先把 remaining_quantity 補回 quantity 再刪
 *
 * 執行：
 *   node scripts/inventory-adjustments-selftest.mjs                         # 只跑靜態
 *   SUPABASE_ACCESS_TOKEN=sbp_… node scripts/inventory-adjustments-selftest.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/inventory-adjustments-selftest.mjs";

const MIG_0017 = join(ROOT, "supabase/migrations/0017_inventory_purchases_adjustments.sql");
const SRC_FNS_PUR = join(ROOT, "src/lib/admin/fns/inv-purchases.ts");
const SRC_FNS_ADJ = join(ROOT, "src/lib/admin/fns/inv-adjustments.ts");
const SRC_REPO_PUR = join(ROOT, "src/server/repos/inv-purchases.ts");
const SRC_REPO_ADJ = join(ROOT, "src/server/repos/inv-adjustments.ts");
const SRC_SCHEMAS = join(ROOT, "src/lib/admin/schemas.ts");
const SRC_SHELL = join(ROOT, "src/routes/admin/_shell.tsx");

/** 測試資料的固定標記。刪除全靠它，所以要夠特別。 */
const MARK = "__invadjselftest__";

// -----------------------------------------------------------------------------
// 迷你測試框架
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function check(label, actual, expected, note) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
    if (note) console.log(red(`      ${note}`));
  }
}

const checkTrue = (label, value, note) => check(label, Boolean(value), true, note);

/** 把 `--` 註解整行拿掉，免得註解裡提到的字串讓斷言假性通過。 */
function strip(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/**
 * TypeScript 版的同一件事。
 *
 * 0017 的檔頭與每一支函式的註解裡本來就大量提到 `inventory_adjustments`、
 * `status`、`stock_quantity` —— 用整檔 includes() 去斷言「這個字沒有出現」的話，
 * **寫得越清楚的註解越會讓測試變紅**，那會逼下一個人去刪註解而不是去修程式。
 */
function stripTs(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串。
 *
 * 這裡曾經是 `existsSync(p) ? readFileSync(p, "utf8") : ""`。問題在於這一支底下大量
 * 的斷言長成 `check("…沒有 X", src.includes("X"), false)` —— 路徑一打錯（或檔案被改名、
 * 搬走），`"".includes("X")` 就是 `false`，那條斷言**靜默通過**，從此永遠是綠的，而且
 * 再也沒有在檢查任何東西。正面斷言會轉紅所以是安全的；只有否定斷言會這樣壞掉。
 * 見 run-selftests.mjs 的「守門 4」。
 */
function read(path) {
  if (!existsSync(path)) {
    throw new Error(
      `selftest 讀不到檔案：${path}` +
        "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串 —— 回空字串會讓所有" +
        "「確認原始碼裡沒有 X」的否定斷言靜默通過。）",
    );
  }
  return readFileSync(path, "utf8");
}

// 守著 read() 自己：路徑打錯時它必須炸掉，而不是回空字串讓否定斷言靜默通過。
{
  const ghost = join(ROOT, "__selftest-missing-file-probe__");
  let thrown = null;
  try {
    read(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 read() 讀不到檔案時丟例外，訊息指出是哪個路徑（不是靜默回空字串）",
    thrown !== null && String(thrown.message).includes(ghost),
  );
}

// -----------------------------------------------------------------------------
// [1] 檔案盤點，而且 0001–0016 一個都沒有被動過
// -----------------------------------------------------------------------------

console.log("\n[1] 檔案盤點");
check("0017 存在", existsSync(MIG_0017), true);

const MIG_DIR = join(ROOT, "supabase/migrations");
const migFiles = readdirSync(MIG_DIR);
for (let n = 1; n <= 16; n += 1) {
  const prefix = String(n).padStart(4, "0");
  check(
    `migration ${prefix} 仍在`,
    migFiles.some((f) => f.startsWith(`${prefix}_`)),
    true,
  );
}
// 4c 加了 0018（套餐／二手書／OCR bucket）。這一條原本是「0017 是最後一號」，
// 目的不是凍結號碼，是**擋住有人偷偷改既有 migration 的行為**：要改就開新號。
// 所以往前推一格，繼續守著。0018 自己的內容由 inventory-combos-selftest 驗。
check(
  "0018 在（4c 加的）",
  migFiles.some((f) => f.startsWith("0018_")),
  true,
);
// ⚠️ 這一條的作用是「下一期的人一定要回來看這支測試」。0019（廠商／PII 治理）
// 加進來時它就是這樣把人叫回來的 —— 那一期改了 sales_product_id_fkey 與
// combo_set_items_product_id_fkey 的 ON DELETE 行為（SET NULL/CASCADE → RESTRICT），
// 所以下面的清理順序與「刪商品」相關的斷言都要在 0019 的前提下重讀一次。
//
// 0020（場次名額／逐位參加者）加進來時再被叫回來過一次。那一期覆寫了
// expire_unpaid_orders() 與 product_availability，並且把名額從 public.products
// 搬到 public.event_sessions —— 三件事都不碰 inv 的在庫異動，所以下面的斷言全部
// 原樣成立。0020 自己的內容由 event-registration-selftest 驗。
check(
  "0020 在（場次名額）",
  migFiles.some((f) => f.startsWith("0020_")),
  true,
);
// 0021（名單的遮罩 view、明文揭露與 CSV 匯出）第三次把人叫回來。逐條重讀過：
// 它動的是 public.pii_access_log 的兩條 CHECK、public.staff_permissions 的
// permission CHECK（第九種權限 event.roster.read），以及兩張 event_* 表上的
// view 與函式。**inv 的任何一張表、任何一支函式都沒有被碰到**，尤其是
// inv.inventory_adjustments 與 inv_admin_product_movements —— 下面的斷言全部原樣
// 成立。0021 自己的內容由 roster-csv-selftest 驗。
check(
  "0021 在（名單 PII）",
  migFiles.some((f) => f.startsWith("0021_")),
  true,
);
// 0022（交易信 outbox 與付款通知）第四次把人叫回來。逐條重讀過：它新增的是
// public.email_outbox / public.email_copy 兩張表與十二支 public.* 函式，另外往
// public.order_post_payment_log 補了一批「這一步關掉了」的列（那是寫**列**不是
// 改結構）。**inv 的任何一張表、任何一支函式都沒有被碰到**，尤其是
// inv.inventory_adjustments 與 inv_admin_product_movements；0022 連一個 drop 都
// 沒有，alter table 也只打在自己新建的那兩張表上。下面的斷言全部原樣成立。
// 0022 自己的內容由 notify-selftest 驗。
check(
  "0022 在（交易信 outbox）",
  migFiles.some((f) => f.startsWith("0022_")),
  true,
);
// 0024 是黑貓 PAY 線上刷卡加的（見 supabase/migrations/0024_blackcat_payment.sql）。
// 它沒有碰進銷存的任何一張表，所以這一支測試的其他斷言原樣成立。
check(
  "0024 在（黑貓 PAY 金流欄位）",
  migFiles.some((f) => f.startsWith("0024_")),
  true,
);
// 0025_event_speaker.sql（活動掛講者：public.events.speaker_id -> public.artists.id）
// 是這一期加的。它只在 public.events 上加一欄與一個索引，**inv 的任何一張表、
// 任何一支函式都沒有被碰到**，也沒有任何 drop。下面的斷言全部原樣成立。
// 0025 自己的內容由 artists-selftest 驗。
check(
  "0025 在（活動掛講者）",
  migFiles.some((f) => f.startsWith("0025_")),
  true,
);
// 0026_event_product_link.sql（活動與商品的真連結：events.slug / events.image_key、
// products 對活動來源的唯一索引、admin_upsert_event_with_session()）是這一期加的。
// 它只碰 public.events / public.products / public.event_sessions，**inv 的任何一張表、
// 任何一支函式都沒有被碰到**，也沒有任何 drop。下面的斷言全部原樣成立。
// 0026 自己的內容由 event-product-selftest 驗。
check(
  "0026 在（活動與商品的真連結）",
  migFiles.some((f) => f.startsWith("0026_")),
  true,
);

const sql = read(MIG_0017);
const exec = strip(sql);
// 反空殼：先證明檔案真的有內容，否則下面每一條 includes() 都是假性結果。
checkTrue("0017 不是空檔（> 20000 字）", exec.length > 20000, `實際 ${exec.length} 字`);
checkTrue("0017 有 begin; … commit;", /^begin;/m.test(exec) && /^commit;/m.test(exec));

// -----------------------------------------------------------------------------
// [2] 兩張異動表的決定 —— 新的寫入一筆都不進 inventory_adjustments
// -----------------------------------------------------------------------------

console.log("\n[2] inv.inventory_adjustments 已凍結，沒有任何新的寫入路徑");

// 0017 裡唯一可以碰 inventory_adjustments 的地方是 inv_approve_record 的那個分支
// （30 筆歷史全是 approved，留一條退回的路）與 union view 的 SELECT。
// 不可以有 INSERT INTO inv.inventory_adjustments。
checkTrue(
  "0017 沒有 insert into inv.inventory_adjustments",
  !/insert\s+into\s+inv\.inventory_adjustments/i.test(exec),
);
checkTrue(
  "union view 有讀 inv.inventory_adjustments（30 筆歷史沒有消失）",
  /from\s+inv\.inventory_adjustments/i.test(exec),
);
checkTrue(
  "inv_admin_product_movements 是 union（兩張表都在）",
  /create or replace view public\.inv_admin_product_movements[\s\S]*?union all[\s\S]*?inv\.inventory_adjustments/i.test(
    exec,
  ),
);

// 「我們決定不寫那一張」與「那一張寫不進去」是兩件事。下一個人看到
// ProductDetailDialog 讀舊表，很可能就順手往那裡插一筆 —— 然後同一次盤點被扣
// 兩次，而且沒有任何地方會報錯。所以決定要做成守衛。
checkTrue(
  "有 BEFORE INSERT 的凍結 trigger",
  /create trigger freeze_inventory_adjustments\s+before insert on inv\.inventory_adjustments/i.test(
    exec,
  ),
);
checkTrue("凍結 trigger 會 RAISE", /INVENTORY_ADJUSTMENTS_FROZEN/.test(exec));
checkTrue(
  "凍結只擋 INSERT（UPDATE/DELETE 留著，30 筆歷史還要能修）",
  !/before insert or update on inv\.inventory_adjustments/i.test(exec) &&
    !/before delete on inv\.inventory_adjustments/i.test(exec),
);

const repoAdj = stripTs(read(SRC_REPO_ADJ));
checkTrue("repos/inv-adjustments.ts 不是空檔", repoAdj.length > 3000);
checkTrue(
  "repo 沒有直接寫 inventory_adjustments",
  !/inv_admin_inventory_adjustments|inventory_adjustments/.test(repoAdj),
  "只能透過 inv_admin_product_movements 這個 union view 讀到它",
);

// -----------------------------------------------------------------------------
// [3] 審核不再被繞過 —— status 由資料庫算
// -----------------------------------------------------------------------------

console.log("\n[3] 異動單的 status 由資料庫算，呼叫端指定不了");

checkTrue(
  "0017 有 inv.stock_adjustment_initial_status()",
  /create or replace function inv\.stock_adjustment_initial_status\(\)/.test(exec),
);
checkTrue(
  "它承接 inv.initial_approval_status('stock_adjustments')",
  /inv\.initial_approval_status\('stock_adjustments'\)/.test(exec),
);
checkTrue(
  "轉成這張表的值域 pending_approval / confirmed",
  /when 'pending' then 'pending_approval'/.test(exec),
);

// 三支寫入函式都要用它，而且不可以從 payload 讀 status。
for (const fn of [
  "inv_save_stock_adjustment",
  "inv_record_stock_count",
  "inv_submit_stock_adjustment",
]) {
  const start = exec.indexOf(`create or replace function public.${fn}(`);
  const end = exec.indexOf(`comment on function public.${fn}`);
  const body = start >= 0 && end > start ? exec.slice(start, end) : "";
  checkTrue(`${fn} 找得到函式本體`, body.length > 200);
  checkTrue(
    `${fn} 呼叫 inv.stock_adjustment_initial_status()`,
    /inv\.stock_adjustment_initial_status\(\)/.test(body),
  );
  checkTrue(
    `${fn} 沒有從 payload 讀 status`,
    !/->>\s*'status'/.test(body),
    "status 一旦能從瀏覽器送進來，審核開關就等於沒有",
  );
}

const schemas = read(SRC_SCHEMAS);
const invAdjSchema = schemas.slice(
  schemas.indexOf("export const invAdjustmentSchema"),
  schemas.indexOf("export type InvAdjustmentValues"),
);
checkTrue("找得到 invAdjustmentSchema", invAdjSchema.length > 200);
checkTrue(
  "invAdjustmentSchema 沒有 status 欄位",
  !/^\s*status:/m.test(invAdjSchema),
  "來源的兩支盤點對話框把 status 硬寫成 'confirmed'，這個 schema 少掉這一欄就是那個 bug 在型別上被關起來",
);
checkTrue(
  "invAdjustmentSchema 沒有 unit_cost / total_cost",
  !/unit_cost|total_cost/.test(invAdjSchema),
  "成本由 FIFO 算，從瀏覽器送進來等於讓人自己填毛利",
);

const stockCountSchema = schemas.slice(
  schemas.indexOf("export const stockCountSchema"),
  schemas.indexOf("export type StockCountValues"),
);
checkTrue("找得到 stockCountSchema", stockCountSchema.length > 200);
checkTrue("盤點送的是 actual_quantity", /actual_quantity/.test(stockCountSchema));
checkTrue(
  "盤點沒有 quantity / difference 欄位",
  !/^\s*(quantity|difference):/m.test(stockCountSchema),
  "差異必須在資料庫用當下的 stock_quantity 算，不是在瀏覽器",
);

// -----------------------------------------------------------------------------
// [4] 庫存只由 trigger 加減
// -----------------------------------------------------------------------------

console.log("\n[4] RPC 不自己動 stock_quantity");

const RPCS = [
  "inv_save_purchase",
  "inv_delete_purchase",
  "inv_batch_update_purchases",
  "inv_import_purchases",
  "inv_save_stock_adjustment",
  "inv_record_stock_count",
  "inv_submit_stock_adjustment",
  "inv_delete_stock_adjustment",
  "inv_reverse_stock_adjustment",
  "inv_resubmit_stock_adjustment",
];

for (const fn of RPCS) {
  const start = exec.indexOf(`create or replace function public.${fn}(`);
  const end = exec.indexOf(`comment on function public.${fn}`);
  const body = start >= 0 && end > start ? exec.slice(start, end) : "";
  checkTrue(`${fn} 存在`, body.length > 150);
  checkTrue(
    `${fn} 沒有 UPDATE inv.products … stock_quantity`,
    !/UPDATE\s+inv\.products[\s\S]{0,200}?stock_quantity\s*=/i.test(body),
    "庫存加減全部在 trigger 裡（0016 立的規矩）",
  );
  checkTrue(`${fn} 是 security definer`, /security definer/.test(body));
  checkTrue(`${fn} 有 set search_path`, /set search_path/.test(body));
}

// -----------------------------------------------------------------------------
// [5] FIFO 的兩條缺口路徑被 trigger 補上了
// -----------------------------------------------------------------------------

console.log("\n[5] 進貨改數量／刪除時 remaining_quantity 會跟著對齊");

checkTrue(
  "update_stock_on_purchase 有「數量被改了」的分支",
  /NEW\.quantity IS DISTINCT FROM OLD\.quantity/.test(exec),
);
checkTrue(
  "已消耗量 = 原數量 − 原剩餘量",
  /OLD\.quantity - COALESCE\(OLD\.remaining_quantity, OLD\.quantity\)/.test(exec),
);
checkTrue("改到比已消耗量小會 RAISE", /PURCHASE_BELOW_CONSUMED/.test(exec));
checkTrue(
  "有 BEFORE DELETE 的 rollback_stock_on_purchase_delete",
  /create trigger rollback_stock_on_purchase_delete\s+before delete on inv\.purchases/i.test(exec),
);
checkTrue("已出庫的批次不准刪", /PURCHASE_ALREADY_CONSUMED/.test(exec));

console.log("\n[5b] 走審核的異動單也算得到 FIFO 成本");
checkTrue(
  "UPDATE 成 confirmed 時補算 FIFO",
  /update_stock_on_stock_adjustment[\s\S]*?inv\.allocate_fifo_cost/.test(exec),
);
checkTrue(
  "一出生就 confirmed 的走 BEFORE INSERT",
  /create trigger allocate_fifo_before_adjustment_insert\s+before insert on inv\.stock_adjustments/i.test(
    exec,
  ),
);
checkTrue(
  "兩條路徑都有 unit_cost IS NULL 的防重複分攤 guard",
  (exec.match(/unit_cost IS NULL/g) ?? []).length >= 2,
);

// -----------------------------------------------------------------------------
// [6] 0016 的審核缺口修好了
// -----------------------------------------------------------------------------

console.log("\n[6] inv_approve_record 的 stock_adjustments 分支");

const approveBody = exec.slice(
  exec.indexOf("create or replace function public.inv_approve_record("),
  exec.indexOf("comment on function public.inv_approve_record"),
);
checkTrue("找得到 inv_approve_record 本體", approveBody.length > 1000);
checkTrue(
  "起點是 ('draft', 'pending_approval')",
  /status IN \('draft', 'pending_approval'\)/.test(approveBody),
  "0016 寫的是 ('draft','pending')，而 'pending' 這個值在 inv.stock_adjustments 從來不存在 —— 核准一筆待審單會靜默 changed=false",
);
checkTrue("內沒有 EXECUTE（沒有動態 SQL）", !/\bEXECUTE\b/i.test(approveBody));
checkTrue("內沒有 format()", !/\bformat\s*\(/i.test(approveBody));
checkTrue("內沒有 quote_ident()", !/quote_ident/i.test(approveBody));
checkTrue("白名單外會 RAISE", /APPROVAL_UNKNOWN_MODULE/.test(approveBody));

// -----------------------------------------------------------------------------
// [7] 權限：先 revoke 再 grant
// -----------------------------------------------------------------------------

console.log("\n[7] 新物件的 grant / revoke");

const FUNC_SIGS = [
  "inv.stock_adjustment_initial_status()",
  "public.inv_approve_record(uuid, text, uuid, boolean)",
  "public.inv_save_purchase(uuid, uuid, jsonb)",
  "public.inv_delete_purchase(uuid)",
  "public.inv_batch_update_purchases(uuid, uuid[], jsonb)",
  "public.inv_import_purchases(uuid, jsonb, jsonb)",
  "public.inv_save_stock_adjustment(uuid, jsonb, boolean)",
  "public.inv_record_stock_count(uuid, jsonb, jsonb)",
  "public.inv_submit_stock_adjustment(uuid, uuid)",
  "public.inv_delete_stock_adjustment(uuid)",
  "public.inv_reverse_stock_adjustment(uuid, uuid)",
  "public.inv_resubmit_stock_adjustment(uuid)",
];

for (const f of FUNC_SIGS) {
  const esc = f.replace(/[.()[\]]/g, (c) => `\\${c}`);
  checkTrue(
    `${f} 對 anon/authenticated revoke`,
    new RegExp(`revoke execute on function ${esc} from anon, authenticated`).test(exec),
  );
  checkTrue(
    `${f} grant 給 service_role`,
    new RegExp(`grant\\s+execute on function ${esc} to service_role`).test(exec),
  );
}

const VIEWS = ["inv_admin_purchases", "inv_admin_stock_adjustments", "inv_admin_product_movements"];
for (const v of VIEWS) {
  checkTrue(
    `${v} 是 security_invoker = false`,
    new RegExp(
      `create or replace view public\\.${v}\\s*\\n?with \\(security_invoker = false\\)`,
    ).test(exec),
  );
  checkTrue(
    `${v} 對 anon/authenticated revoke all`,
    new RegExp(`revoke all on public\\.${v}\\s+from anon, authenticated`).test(exec),
  );
  checkTrue(
    `${v} grant select 給 service_role`,
    new RegExp(`grant select on public\\.${v}\\s+to service_role`).test(exec),
  );
  checkTrue(`${v} 有 comment`, new RegExp(`comment on view public\\.${v}`).test(exec));
  // revoke 一定要排在 grant 前面 —— Supabase 對 public schema 有 ALTER DEFAULT
  // PRIVILEGES，新 view 一出生就對 anon/authenticated 是 ALL。0013 就是在修這個。
  checkTrue(
    `${v} 的 revoke 排在 grant 前面`,
    exec.indexOf(`revoke all on public.${v}`) < exec.indexOf(`grant select on public.${v}`),
  );
}

// -----------------------------------------------------------------------------
// [8] server fn 層：middleware 掛滿、沒有誤用 adminFnMiddleware
// -----------------------------------------------------------------------------

console.log("\n[8] server fn 的授權");

for (const [name, path] of [
  ["fns/inv-purchases.ts", SRC_FNS_PUR],
  ["fns/inv-adjustments.ts", SRC_FNS_ADJ],
]) {
  const src = read(path);
  const code = stripTs(src);
  checkTrue(`${name} 不是空檔`, code.length > 2000);

  const fnCount = (code.match(/createServerFn\(/g) ?? []).length;
  const mwCount = (code.match(/\.middleware\(\[staffFnMiddleware/g) ?? []).length;
  checkTrue(
    `${name} 每一支 server fn 都有 staffFnMiddleware（${fnCount} 支）`,
    fnCount > 0 && fnCount === mwCount,
    `createServerFn=${fnCount} middleware=${mwCount}`,
  );
  checkTrue(`${name} 沒有用 adminFnMiddleware`, !/adminFnMiddleware/.test(code));
  checkTrue(`${name} 沒有用 requireAdmin`, !/requireAdmin/.test(code));
  checkTrue(
    `${name} 審核有查細權限 approve_\${module}`,
    /approve_\$\{data\.module\}/.test(code) && /NotAuthorizedError/.test(code),
  );
  checkTrue(
    `${name} userId 取自 context 不是 body`,
    /context\.staff\.userId/.test(code) && !/data\.userId|data\.user_id/.test(code),
  );
  checkTrue(`${name} repo 一律 dynamic import`, !/^import .*@\/server\/repos/m.test(code));
}

// middleware.ts 與 auth.ts 沒有被動過（這一期不該碰它們）
const mw = read(join(ROOT, "src/lib/admin/middleware.ts"));
checkTrue("middleware.ts 仍有 adminFnMiddleware", /export const adminFnMiddleware/.test(mw));
checkTrue("middleware.ts 仍有 staffFnMiddleware", /export function staffFnMiddleware/.test(mw));

const auth = read(join(ROOT, "src/server/auth.ts"));
checkTrue(
  "auth.ts 的 STAFF_PERMISSIONS 仍有 approve_stock_adjustments",
  /"approve_stock_adjustments"/.test(auth),
);
checkTrue("auth.ts 的 STAFF_PERMISSIONS 仍有 approve_purchases", /"approve_purchases"/.test(auth));

// -----------------------------------------------------------------------------
// [9] repo 層：不吞錯誤、不從前端碰 supabase
// -----------------------------------------------------------------------------

console.log("\n[9] repo 層");

for (const [name, path] of [
  ["repos/inv-purchases.ts", SRC_REPO_PUR],
  ["repos/inv-adjustments.ts", SRC_REPO_ADJ],
]) {
  const src = read(path);
  const code = stripTs(src);
  checkTrue(`${name} 不是空檔`, code.length > 3000);
  checkTrue(
    `${name} 第一行是 server-only`,
    /^import "@tanstack\/react-start\/server-only";/m.test(src),
  );

  const errChecks = (code.match(/if \(error\) throw new Error/g) ?? []).length;
  const errUses = (code.match(/\berror\b\s*[,)}]/g) ?? []).length;
  checkTrue(
    `${name} 每個 error 都被 throw（${errChecks} 處）`,
    errChecks >= 8,
    `errUses=${errUses}`,
  );
  checkTrue(
    `${name} 沒有把錯誤吞成空陣列`,
    !/catch\s*\([\s\S]{0,40}\)\s*\{\s*return\s*(\[\]|null)/.test(code),
  );
  checkTrue(`${name} 有 speak() 剝 PL/pgSQL 前綴`, /function speak\(/.test(code));
}

// -----------------------------------------------------------------------------
// [10] 前端不變量
// -----------------------------------------------------------------------------

console.log("\n[10] 前端：沒有搬進來的東西");

const FRONT = [
  "src/routes/admin/_shell.inventory-purchases.tsx",
  "src/routes/admin/_shell.inventory-count.tsx",
  "src/routes/admin/_shell.inventory-adjustments.tsx",
  "src/lib/admin/inv-adjustment-labels.ts",
];

// 元件檔的清單用掃的（元件會拆會併），但三個 route 與標籤檔是寫死的：
// 檔案被刪掉的話上面那個迴圈會直接紅，斷言不會變成空的。
const COMP_DIR = join(ROOT, "src/components/inventory");
const compAll = existsSync(COMP_DIR) ? readdirSync(COMP_DIR) : [];
const compFiles = compAll
  .filter((f) => /^(Purchase|Adjustment|StockCount|BatchStockCount|VendorSelect)/.test(f))
  .map((f) => `src/components/inventory/${f}`);

// ⚠️ [10b] 的行數上限掃得比 [10] 廣：整批 Vendor* 都要進來。
//
//    為什麼要分兩份清單，而不是把上面那個前綴直接放寬？因為 [10] 的內容不變量對廠商
//    那批**不成立**：VendorSubmissionQueue 底下的「核准並上架」是在填官網商品，那是
//    真的三語（VendorLocalizedField），會直接撞上「LocalizedField 沒有出現（進銷存是
//    單語 text）」那一條。那條斷言對進貨／異動／盤點是對的，不該為了讓廠商檔進來就
//    把它放寬 —— 所以放寬的是行數那一條，[10] 的掃描範圍一個字都沒動。
//
//    這條線當初要防的是「5,500 行拆小之後又慢慢長回來」，而最該被防的那個檔案
//    （VendorFormDialog，2,353 行）當時剛好落在前綴外面，站在網子外。
const cappedFiles = compAll
  .filter((f) => /^(Purchase|Adjustment|StockCount|BatchStockCount|Vendor)/.test(f))
  .map((f) => `src/components/inventory/${f}`);
const HOOKS = [
  "src/lib/admin/usePurchaseActions.ts",
  "src/lib/admin/useAdjustmentActions.ts",
].filter((f) => existsSync(join(ROOT, f)));

const ALL_FRONT = [...FRONT, ...compFiles, ...HOOKS];
/** [10b] 專用：與 ALL_FRONT 同樣的三段，但元件那段換成放寬後的（嚴格是超集）。 */
const ALL_CAPPED = [...FRONT, ...cappedFiles, ...HOOKS];
for (const f of FRONT) check(`${f} 存在`, existsSync(join(ROOT, f)), true);
checkTrue(`元件檔掃到 ${compFiles.length} 個（> 6）`, compFiles.length > 6);
checkTrue(
  `行數上限掃到 ${cappedFiles.length} 個，而且是 compFiles 的超集`,
  cappedFiles.length > compFiles.length && compFiles.every((f) => cappedFiles.includes(f)),
  "放寬只能加不能減：[10] 掃到的每一個檔案都必須也在 [10b] 裡",
);
checkTrue(
  "VendorFormDialog 真的進了行數那條線",
  cappedFiles.includes("src/components/inventory/VendorFormDialog.tsx"),
  "它是當初被漏掉的那個 2,353 行檔案。掉出去就等於這條線白改了",
);

const codeFront = stripTs(ALL_FRONT.map((f) => read(join(ROOT, f))).join("\n"));
checkTrue("前端不是空的（> 20000 字）", codeFront.length > 20000, `實際 ${codeFront.length} 字`);

// ⚠️ 這一條在 4b 是「AI 拍照辨識沒有被搬進來（入口按鈕也沒留）」—— 當時它打的是
//    Lovable AI Gateway，這個專案沒有那支 edge function，留著就是一顆按了必定
//    500 的按鈕。0018 把它接上 Gemini 了，所以斷言換成**它必須走 server fn**。
//    直接刪掉的話，「前端自己拿金鑰打 Gemini」會靜默通過 —— 那比一顆壞按鈕糟。
checkTrue(
  "進貨單拍照辨識的入口回來了（0018 接上 Gemini）",
  /PurchaseOCR|拍照辨識/.test(codeFront),
  "4b 刻意拿掉，4c 接回來。找不到入口代表整合掉了",
);
checkTrue(
  "但它是走 server fn，不是 client 直連 Gemini",
  !/generativelanguage|GEMINI_API_KEY|x-goog-api-key/.test(codeFront),
  "client 直連 = 金鑰在瀏覽器裡。辨識要走 src/lib/admin/fns/ocr.ts",
);
checkTrue(
  "而且沒有把 base64 塞進 server fn（Vercel body 上限 4.5MB）",
  !/(imageBase64|dataUrl|data_url)/.test(codeFront) &&
    !/base64[\s\S]{0,80}(recogniseBook|recognisePurchaseOrder)/.test(codeFront),
  "server fn 只收私有 bucket 的 storage key，見 src/lib/admin/fns/ocr.ts 檔頭",
);
checkTrue(
  "沒有留著已失效的 Lovable edge function 名稱",
  !/recognize-purchase-order|recognize-book|recognize-product|lovable/i.test(codeFront),
);
checkTrue("沒有 xlsx 的靜態 import", !/^import .*["']xlsx["']/m.test(codeFront));
checkTrue(
  "沒有 react-query",
  !/@tanstack\/react-query|useQuery|useMutation|queryClient/.test(codeFront),
);
checkTrue("沒有搬進 use-toast / toaster", !/use-toast|useToast|Toaster/.test(codeFront));
checkTrue("LocalizedField 沒有出現（進銷存是單語 text）", !/LocalizedField/.test(codeFront));
checkTrue(
  "前端沒有直接碰 supabase",
  !/supabaseAdmin|createClient|@supabase\/supabase-js/.test(codeFront),
);
checkTrue(
  "前端沒有自己算盤點差異再送出",
  !/actual_quantity\s*[-−]\s*|difference:\s*.*actual/.test(
    codeFront.replace(/const\s+\w*[Dd]iff\w*\s*=[^;]*;/g, ""),
  ),
  "顯示預估差異可以，但 payload 只能有 actual_quantity",
);
checkTrue(
  "日期用 todayInTaipei 不是 toISOString",
  !/toISOString\(\)\.slice\(0,\s*10\)/.test(codeFront),
);

console.log("\n[10b] 每個新檔案都在 300 行以內");
// 這一期的硬要求：來源 5,500 行拆成一堆 300 行以內的檔案。沒有這一條的話，
// 下一次「順手加一點」會讓它慢慢長回 1,597 行。
for (const f of ALL_CAPPED) {
  const text = read(join(ROOT, f));
  if (!text) continue;
  // 與 `wc -l` 同一種數法：檔尾那個換行不算一行
  const n = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  checkTrue(`${f}（${n} 行）`, n <= 300, "超過 300 行，請再拆");
}

console.log("\n[10c] 側欄有三個新入口，而且是 staff 看得到的");
const shell = read(SRC_SHELL);
for (const [to, label] of [
  ["/admin/inventory-purchases", "進貨"],
  ["/admin/inventory-count", "庫存盤點"],
  ["/admin/inventory-adjustments", "在庫異動"],
]) {
  checkTrue(
    `側欄有「${label}」且 staff: true`,
    // ⚠️ 不要求寫在同一行。prettier 會依 icon 名稱的長度決定折不折行（
    //    SlidersHorizontal 就被折了），寫死單行等於在測排版而不是測授權。
    //    [^{}]* 保證比對不會跨過物件邊界跑去讀下一個項目的 staff。
    new RegExp(`to:\\s*"${to}",[^{}]*label:\\s*"${label}",[^{}]*staff:\\s*true`).test(shell),
  );
}
// ⚠️ 側欄把模組藏起來不是授權。真正的擋在每一支 server fn 的 middleware。
checkTrue(
  "_shell.tsx 沒有被改成用 approve_* 做側欄過濾",
  !/approve_(purchases|stock_adjustments)/.test(stripTs(shell)),
);

// -----------------------------------------------------------------------------
// [11]–[16] 實測
// -----------------------------------------------------------------------------

const REF = process.env.SUPABASE_PROJECT_REF ?? "noijrmhdfbfvjyvchvzj";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

async function q(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: text, rows: [] };
  try {
    return { ok: true, error: null, rows: JSON.parse(text) };
  } catch {
    return { ok: true, error: null, rows: [] };
  }
}

/**
 * 清乾淨。
 *
 * ⚠️ 前兩句是在解掉 0017 自己的兩個守衛（它們擋得住手打 SQL，那正是重點）：
 *    · 已確認的異動單不可刪 → 先退回 draft（confirmed → draft 不觸發庫存 trigger）
 *    · 已出庫的進貨批次不可刪 → 先把 remaining_quantity 補回 quantity
 * ⚠️ 順序不能換：stock_adjustments → sales → purchases → products。
 */
async function cleanup() {
  const ids = `(select id from inv.products where name like '${MARK}%')`;
  await q(`update inv.stock_adjustments set status = 'draft' where product_id in ${ids};`);
  await q(`delete from inv.stock_adjustments where product_id in ${ids};`);
  await q(`delete from inv.sales where product_id in ${ids};`);
  await q(`update inv.purchases set remaining_quantity = quantity where product_id in ${ids};`);
  await q(`delete from inv.purchases where product_id in ${ids};`);
  await q(`delete from inv.products where name like '${MARK}%';`);
}

/** 一行 DO block + 一張暫存表 —— Management API 不回傳 NOTICE。 */
async function runSteps(body) {
  const res = await q(`
    create temp table if not exists invadjlog(seq serial, step text, detail text);
    truncate invadjlog;
    do $selftest$
    declare
      v_uid uuid; v_pid uuid; v_purid uuid; v_r jsonb; v_stock int; v_rem int;
      v_id uuid; v_cat text; v_n int; v_before int;
    begin
      select user_id into v_uid from inv.profiles limit 1;
      ${body}
    end $selftest$;
    select seq, step, detail from invadjlog order by seq;
  `);
  if (!res.ok) return { ok: false, error: res.error, map: new Map() };
  const map = new Map();
  for (const row of res.rows) map.set(row.step, row.detail);
  return { ok: true, error: null, map };
}

if (!TOKEN) {
  skipped.push("實測（缺 SUPABASE_ACCESS_TOKEN）");
  console.log(yellow("\n[11]–[16] 跳過實測：沒有 SUPABASE_ACCESS_TOKEN"));
} else {
  await cleanup();

  const operator = await q(`select user_id from inv.profiles limit 1;`);
  const uid = operator.rows[0]?.user_id;
  checkTrue("拿得到一個操作人員 uuid", Boolean(uid));

  // 前提：這兩個開關是開著的。讀，不改 —— 這是正式資料庫。
  const settings = await q(
    `select module, is_enabled from inv.approval_settings where module in ('purchases','stock_adjustments');`,
  );
  const onPur = settings.rows.find((r) => r.module === "purchases")?.is_enabled === true;
  const onAdj = settings.rows.find((r) => r.module === "stock_adjustments")?.is_enabled === true;
  check("approval_settings.purchases 是開著的（這幾段的前提）", onPur, true);
  check("approval_settings.stock_adjustments 是開著的（這幾段的前提）", onAdj, true);

  const baseline = await q(`
    select (select count(*)::int from inv.products) p,
           (select count(*)::int from inv.purchases) pu,
           (select count(*)::int from inv.sales) s,
           (select count(*)::int from inv.stock_adjustments) sa,
           (select count(*)::int from inv.inventory_adjustments) ia,
           (select count(*)::int from public.publications) pub;`);
  const base = baseline.rows[0] ?? {};
  checkTrue("讀得到基準線", Boolean(base.p));

  // ── [11] 進貨 CRUD 與 FIFO ────────────────────────────────────────────────
  console.log("\n[11] 實測：進貨 CRUD → 賣掉一部分 → 編輯進貨（FIFO 不會對不起來）");
  const r11 = await runSteps(`
    insert into inv.products(name,user_id,stock_quantity,selling_price,cost_price,product_type,is_active,approval_status)
      values ('${MARK}FIFO', v_uid, 0, 100, 50, 'outright', true, 'approved') returning id into v_pid;

    v_r := public.inv_save_purchase(v_uid, null,
      jsonb_build_object('product_id', v_pid, 'quantity', 10, 'unit_cost', 50, 'purchase_date','2026-01-01'));
    v_purid := (v_r ->> 'id')::uuid;
    insert into invadjlog(step,detail) values ('新增進貨', v_r ->> 'approval_status');

    v_r := public.inv_approve_record(v_uid,'purchases',v_purid,true);
    select stock_quantity into v_stock from inv.products where id=v_pid;
    select remaining_quantity into v_rem from inv.purchases where id=v_purid;
    insert into invadjlog(step,detail) values ('核准後', format('%s/%s', v_stock, v_rem));

    insert into inv.sales(user_id,product_id,quantity,unit_price,sale_date) values (v_uid,v_pid,4,100,CURRENT_DATE);
    select stock_quantity into v_stock from inv.products where id=v_pid;
    select remaining_quantity into v_rem from inv.purchases where id=v_purid;
    insert into invadjlog(step,detail) values ('賣4後', format('%s/%s', v_stock, v_rem));

    v_r := public.inv_save_purchase(v_uid,v_purid, jsonb_build_object('quantity',20,'unit_cost',50,'purchase_date','2026-01-01'));
    select stock_quantity into v_stock from inv.products where id=v_pid;
    select remaining_quantity into v_rem from inv.purchases where id=v_purid;
    insert into invadjlog(step,detail) values ('改20後', format('%s/%s/%s', v_stock, v_rem, 20 - v_rem));

    v_r := public.inv_save_purchase(v_uid,v_purid, jsonb_build_object('quantity',6,'unit_cost',50,'purchase_date','2026-01-01'));
    select stock_quantity into v_stock from inv.products where id=v_pid;
    select remaining_quantity into v_rem from inv.purchases where id=v_purid;
    insert into invadjlog(step,detail) values ('改6後', format('%s/%s/%s', v_stock, v_rem, 6 - v_rem));

    begin
      v_r := public.inv_save_purchase(v_uid,v_purid, jsonb_build_object('quantity',3,'unit_cost',50));
      insert into invadjlog(step,detail) values ('改到3','沒被擋');
    exception when others then
      insert into invadjlog(step,detail) values ('改到3', SQLERRM);
    end;

    begin
      v_r := public.inv_delete_purchase(v_purid);
      insert into invadjlog(step,detail) values ('刪已出庫','沒被擋');
    exception when others then
      insert into invadjlog(step,detail) values ('刪已出庫', SQLERRM);
    end;

    delete from inv.sales where product_id=v_pid;
    select remaining_quantity into v_rem from inv.purchases where id=v_purid;
    insert into invadjlog(step,detail) values ('刪銷售後', v_rem::text);

    v_r := public.inv_delete_purchase(v_purid);
    select stock_quantity into v_stock from inv.products where id=v_pid;
    insert into invadjlog(step,detail) values ('刪進貨後', format('%s/%s', v_stock, v_r ->> 'stock_rolled_back'));
  `);
  checkTrue("[11] DO block 跑得起來", r11.ok, String(r11.error).slice(0, 200));
  check("進貨建立時是待審（approval_settings 開著）", r11.map.get("新增進貨"), "pending");
  check("核准後 庫存/剩餘 = 10/10", r11.map.get("核准後"), "10/10");
  check("賣 4 之後 庫存/剩餘 = 6/6（FIFO 吃掉 4）", r11.map.get("賣4後"), "6/6");
  check("編輯 10→20 後 庫存/剩餘/已消耗 = 16/16/4", r11.map.get("改20後"), "16/16/4");
  check("編輯 20→6 後 庫存/剩餘/已消耗 = 2/2/4", r11.map.get("改6後"), "2/2/4");
  checkTrue(
    "改到比已消耗量小被擋",
    String(r11.map.get("改到3")).includes("PURCHASE_BELOW_CONSUMED"),
    String(r11.map.get("改到3")),
  );
  checkTrue(
    "已出庫的批次不能刪",
    String(r11.map.get("刪已出庫")).includes("PURCHASE_ALREADY_CONSUMED"),
    String(r11.map.get("刪已出庫")),
  );
  check("刪掉銷售之後 FIFO 回補 remaining = 6", r11.map.get("刪銷售後"), "6");
  check("刪掉未出庫的進貨 → 庫存收回 0，且回報有收回", r11.map.get("刪進貨後"), "0/true");

  // ── [12] 盤點 ─────────────────────────────────────────────────────────────
  console.log("\n[12] 實測：盤盈盤虧各一次，只加扣一次，而且不寫舊表");
  const r12 = await runSteps(`
    select id into v_pid from inv.products where name='${MARK}FIFO';
    insert into inv.purchases(user_id,product_id,quantity,unit_cost,purchase_date,approval_status)
      values (v_uid,v_pid,100,50,CURRENT_DATE,'approved');
    select count(*)::int into v_before from inv.inventory_adjustments;
    select stock_quantity into v_stock from inv.products where id=v_pid;
    insert into invadjlog(step,detail) values ('備貨', v_stock::text);

    v_r := public.inv_record_stock_count(v_uid,
      jsonb_build_array(jsonb_build_object('product_id',v_pid,'actual_quantity',97)),
      '{"reason":"count_error","notes":"${MARK}盤虧"}'::jsonb);
    v_id := ((v_r->'ids')->>0)::uuid;
    select stock_quantity into v_stock from inv.products where id=v_pid;
    insert into invadjlog(step,detail) values ('盤虧送出',
      format('%s/%s/%s', v_r->>'status', v_stock, (select stock_before from inv.stock_adjustments where id=v_id)));

    v_r := public.inv_approve_record(v_uid,'stock_adjustments',v_id,true);
    select stock_quantity into v_stock from inv.products where id=v_pid;
    insert into invadjlog(step,detail) values ('盤虧核准',
      format('%s/%s/%s', v_r->>'changed', v_stock, (select unit_cost is not null from inv.stock_adjustments where id=v_id)));

    v_r := public.inv_approve_record(v_uid,'stock_adjustments',v_id,true);
    select stock_quantity into v_stock from inv.products where id=v_pid;
    insert into invadjlog(step,detail) values ('重複核准', format('%s/%s', v_r->>'changed', v_stock));

    v_r := public.inv_record_stock_count(v_uid,
      jsonb_build_array(jsonb_build_object('product_id',v_pid,'actual_quantity',102)),
      '{"reason":"count_error","notes":"${MARK}盤盈"}'::jsonb);
    perform public.inv_approve_record(v_uid,'stock_adjustments',((v_r->'ids')->>0)::uuid,true);
    select stock_quantity into v_stock from inv.products where id=v_pid;
    insert into invadjlog(step,detail) values ('盤盈核准', v_stock::text);

    v_r := public.inv_record_stock_count(v_uid,
      jsonb_build_array(jsonb_build_object('product_id',v_pid,'actual_quantity',102)),
      '{"reason":"count_error","notes":"${MARK}無差異"}'::jsonb);
    insert into invadjlog(step,detail) values ('差異0', format('%s/%s', v_r->>'created', v_r->>'skipped'));

    select count(*)::int into v_n from inv.inventory_adjustments;
    insert into invadjlog(step,detail) values ('舊表', format('%s/%s', v_before, v_n));

    select count(*)::int into v_n from public.inv_admin_product_movements
      where product_id = v_pid and source = 'stock_adjustment';
    insert into invadjlog(step,detail) values ('詳細頁看得到', v_n::text);

    begin
      insert into inv.inventory_adjustments(user_id,product_id,adjustment_type,quantity,reason)
        values (v_uid, v_pid, 'shrinkage', -1, 'other');
      insert into invadjlog(step,detail) values ('凍結','沒被擋');
    exception when others then
      insert into invadjlog(step,detail) values ('凍結', SQLERRM);
    end;
  `);
  checkTrue("[12] DO block 跑得起來", r12.ok, String(r12.error).slice(0, 200));
  check("備貨 100", r12.map.get("備貨"), "100");
  check(
    "盤虧送出 → pending_approval，庫存不動（100），stock_before 記下 100",
    r12.map.get("盤虧送出"),
    "pending_approval/100/100",
  );
  // ⚠️ format('%s', boolean) 在 PL/pgSQL 印的是 t/f 不是 true/false。
  check(
    "核准 → changed=true，庫存 100→97（只扣一次），FIFO 成本算得出來",
    r12.map.get("盤虧核准"),
    "true/97/t",
  );
  check("重複核准 → changed=false，沒有扣第二次", r12.map.get("重複核准"), "false/97");
  check("盤盈核准 → 97→102（只加一次）", r12.map.get("盤盈核准"), "102");
  check("差異 0 → created=0 skipped=1", r12.map.get("差異0"), "0/1");
  checkTrue(
    "inv.inventory_adjustments 一筆都沒被寫",
    (() => {
      const [b, a] = String(r12.map.get("舊表")).split("/");
      return b === a;
    })(),
    String(r12.map.get("舊表")),
  );
  // 這一段建了兩張有差異的盤點單（盤虧、盤盈），第三次差異為 0 被跳過所以沒有單。
  check("剛做完的兩張盤點在商品詳細頁（union view）看得到", Number(r12.map.get("詳細頁看得到")), 2);
  checkTrue(
    "手打 SQL 也插不進已凍結的 inv.inventory_adjustments",
    String(r12.map.get("凍結")).includes("INVENTORY_ADJUSTMENTS_FROZEN"),
    String(r12.map.get("凍結")),
  );

  // ── [13] 六類狀態機 ───────────────────────────────────────────────────────
  console.log("\n[13] 實測：六類異動的狀態機 draft → pending_approval → confirmed");
  const r13 = await runSteps(`
    select id into v_pid from inv.products where name='${MARK}FIFO';
    foreach v_cat in array array['EXP','PR','SMP','INT','ADJ','CMB'] loop
      v_r := public.inv_save_stock_adjustment(v_uid,
        jsonb_build_object('product_id',v_pid,'category',v_cat,'quantity',-1,'notes','${MARK}'||v_cat), false);
      insert into invadjlog(step,detail) values ('draft-'||v_cat, v_r->>'status');
      v_r := public.inv_submit_stock_adjustment(v_uid, (v_r->>'id')::uuid);
      insert into invadjlog(step,detail) values ('submit-'||v_cat, v_r->>'status');
    end loop;
    select stock_quantity into v_stock from inv.products where id=v_pid;
    insert into invadjlog(step,detail) values ('待審中庫存', v_stock::text);

    for v_id in select id from inv.stock_adjustments
                 where notes like '${MARK}%' and status='pending_approval' loop
      perform public.inv_approve_record(v_uid,'stock_adjustments',v_id,true);
    end loop;
    select stock_quantity into v_stock from inv.products where id=v_pid;
    insert into invadjlog(step,detail) values ('六類核准後', v_stock::text);
  `);
  checkTrue("[13] DO block 跑得起來", r13.ok, String(r13.error).slice(0, 200));
  for (const cat of ["EXP", "PR", "SMP", "INT", "ADJ", "CMB"]) {
    check(`${cat} 存成草稿 = draft`, r13.map.get(`draft-${cat}`), "draft");
    check(`${cat} 送出 = pending_approval`, r13.map.get(`submit-${cat}`), "pending_approval");
  }
  check("六張待審時庫存不動（仍是 102）", r13.map.get("待審中庫存"), "102");
  check("六類核准後 102−6 = 96", r13.map.get("六類核准後"), "96");

  // ── [14] 沖帳與刪除守衛 ───────────────────────────────────────────────────
  console.log("\n[14] 實測：已確認的不可刪除、沖帳、退回、重新送審");
  const r14 = await runSteps(`
    select id into v_pid from inv.products where name='${MARK}FIFO';
    select id into v_id from inv.stock_adjustments where notes='${MARK}EXP';

    begin
      v_r := public.inv_delete_stock_adjustment(v_id);
      insert into invadjlog(step,detail) values ('刪已確認','沒被擋');
    exception when others then
      insert into invadjlog(step,detail) values ('刪已確認', SQLERRM);
    end;

    v_r := public.inv_reverse_stock_adjustment(v_uid, v_id);
    select stock_quantity into v_stock from inv.products where id=v_pid;
    insert into invadjlog(step,detail) values ('沖帳', format('%s/%s', v_r->>'quantity', v_stock));

    begin
      v_r := public.inv_reverse_stock_adjustment(v_uid, v_id);
      insert into invadjlog(step,detail) values ('沖兩次','沒被擋');
    exception when others then
      insert into invadjlog(step,detail) values ('沖兩次', SQLERRM);
    end;

    begin
      v_r := public.inv_reverse_stock_adjustment(v_uid, (select id from inv.stock_adjustments where reversal_of = v_id));
      insert into invadjlog(step,detail) values ('沖帳單再沖','沒被擋');
    exception when others then
      insert into invadjlog(step,detail) values ('沖帳單再沖', SQLERRM);
    end;

    v_r := public.inv_save_stock_adjustment(v_uid,
      jsonb_build_object('product_id',v_pid,'category','EXP','quantity',-1,'notes','${MARK}退回'), true);
    v_id := (v_r->>'id')::uuid;
    begin
      perform public.inv_delete_stock_adjustment(v_id);
      insert into invadjlog(step,detail) values ('刪待審','沒被擋');
    exception when others then
      insert into invadjlog(step,detail) values ('刪待審', SQLERRM);
    end;

    perform public.inv_approve_record(v_uid,'stock_adjustments',v_id,false);
    insert into invadjlog(step,detail) values ('退回', (select status from inv.stock_adjustments where id=v_id));
    v_r := public.inv_resubmit_stock_adjustment(v_id);
    insert into invadjlog(step,detail) values ('重新送審',
      format('%s/%s', v_r->>'changed', (select status from inv.stock_adjustments where id=v_id)));

    v_r := public.inv_save_stock_adjustment(v_uid,
      jsonb_build_object('product_id',v_pid,'category','PR','quantity',-1,'notes','${MARK}草稿'), false);
    v_r := public.inv_delete_stock_adjustment((v_r->>'id')::uuid);
    insert into invadjlog(step,detail) values ('刪草稿', v_r->>'deleted');
  `);
  checkTrue("[14] DO block 跑得起來", r14.ok, String(r14.error).slice(0, 200));
  checkTrue(
    "已確認的異動單不可刪除",
    String(r14.map.get("刪已確認")).includes("ADJUSTMENT_CONFIRMED"),
    String(r14.map.get("刪已確認")),
  );
  check("沖帳 → 反向 +1，庫存 96→97", r14.map.get("沖帳"), "1/97");
  checkTrue(
    "同一張不能沖兩次",
    String(r14.map.get("沖兩次")).includes("ADJUSTMENT_ALREADY_REVERSED"),
    String(r14.map.get("沖兩次")),
  );
  checkTrue(
    "沖帳單自己不能再被沖",
    String(r14.map.get("沖帳單再沖")).includes("ADJUSTMENT_ALREADY_REVERSAL"),
    String(r14.map.get("沖帳單再沖")),
  );
  checkTrue(
    "待審中的單不能刪（審核的人不該看到資料憑空消失）",
    String(r14.map.get("刪待審")).includes("ADJUSTMENT_PENDING"),
    String(r14.map.get("刪待審")),
  );
  check("退回 → rejected", r14.map.get("退回"), "rejected");
  check("重新送審 → pending_approval", r14.map.get("重新送審"), "true/pending_approval");
  check("草稿可以刪", r14.map.get("刪草稿"), "true");

  // ── [15] Excel 匯入 ───────────────────────────────────────────────────────
  console.log("\n[15] 實測：Excel 進貨匯入（5 列，2 列對到既有商品、3 列自動新建）");
  const r15 = await runSteps(`
    v_r := public.inv_import_purchases(v_uid,
      jsonb_build_array(
        jsonb_build_object('name','${MARK}FIFO','quantity',3,'unit_cost',50),
        jsonb_build_object('name','${MARK}FIFO','quantity',2,'unit_cost',55),
        jsonb_build_object('name','${MARK}匯入A','issue_number','1','series','測試','quantity',5,'unit_cost',120),
        jsonb_build_object('name','${MARK}匯入B','barcode','${MARK}9990001','quantity',4,'unit_cost',80),
        jsonb_build_object('name','${MARK}匯入C','quantity',6,'unit_cost',90,'expiry_date','2026-12-31')),
      '{"default_purchase_date":"2026-08-16"}'::jsonb);
    insert into invadjlog(step,detail) values ('匯入',
      format('%s/%s/%s', v_r->>'purchases_created', v_r->>'products_created', v_r->>'approval_status'));
    select count(*)::int into v_n from inv.purchases where item_name like '${MARK}%' and notes like '%Excel 匯入%';
    insert into invadjlog(step,detail) values ('匯入標記', v_n::text);

    select count(*)::int into v_before from inv.purchases;
    begin
      v_r := public.inv_import_purchases(v_uid,
        jsonb_build_array(
          jsonb_build_object('name','${MARK}原子A','quantity',1,'unit_cost',10),
          jsonb_build_object('name','${MARK}原子B','quantity',0,'unit_cost',10)),
        '{}'::jsonb);
      insert into invadjlog(step,detail) values ('原子性','沒被擋');
    exception when others then
      select count(*)::int into v_n from inv.purchases;
      insert into invadjlog(step,detail) values ('原子性', format('%s|%s|%s', SQLERRM, v_before, v_n));
    end;
  `);
  checkTrue("[15] DO block 跑得起來", r15.ok, String(r15.error).slice(0, 200));
  check("匯入 5 列 → 5 筆進貨、3 件新商品、待審", r15.map.get("匯入"), "5/3/pending");
  check("5 筆都帶「Excel 匯入」標記", r15.map.get("匯入標記"), "5");
  checkTrue(
    "第 2 列數量 0 → 整批回滾（來源是逐筆 insert，會留下孤兒商品）",
    (() => {
      const [msg, b, a] = String(r15.map.get("原子性")).split("|");
      return msg.includes("IMPORT_BAD_QUANTITY") && b === a;
    })(),
    String(r15.map.get("原子性")),
  );

  // ── [16] 清理與基準線 ─────────────────────────────────────────────────────
  console.log("\n[16] 實測：測試資料全刪，基準線一筆不差");
  await cleanup();

  check(
    "測試商品全部刪光",
    (await q(`select count(*)::int as n from inv.products where name like '${MARK}%';`)).rows[0]?.n,
    0,
  );
  check(
    "測試異動單全部刪光",
    (await q(`select count(*)::int as n from inv.stock_adjustments where notes like '${MARK}%';`))
      .rows[0]?.n,
    0,
  );
  check(
    "測試進貨全部刪光",
    (await q(`select count(*)::int as n from inv.purchases where item_name like '${MARK}%';`))
      .rows[0]?.n,
    0,
  );

  const after =
    (
      await q(`
    select (select count(*)::int from inv.products) p,
           (select count(*)::int from inv.purchases) pu,
           (select count(*)::int from inv.sales) s,
           (select count(*)::int from inv.stock_adjustments) sa,
           (select count(*)::int from inv.inventory_adjustments) ia,
           (select count(*)::int from public.publications) pub;`)
    ).rows[0] ?? {};

  check("inv.products 回到測試前", after.p, base.p);
  check("inv.purchases 回到測試前", after.pu, base.pu);
  check("inv.sales 回到測試前", after.s, base.s);
  check("inv.stock_adjustments 回到測試前", after.sa, base.sa);
  check("inv.inventory_adjustments 全程沒被動過（30 筆）", after.ia, 30);
  check("public.publications 仍是 126 筆", after.pub, 126);
  check(
    "掛得上型錄的刊物仍是 19 本",
    (await q(`select count(*)::int as n from public.publications where product_id is not null;`))
      .rows[0]?.n,
    19,
  );

  console.log("\n[17] 實測：anon 打不到新 view，也叫不動新的寫入函式");
  const viewGrants = await q(`
    select count(*)::int as n from information_schema.role_table_grants
     where grantee in ('anon','authenticated')
       and table_name in ('inv_admin_purchases','inv_admin_stock_adjustments','inv_admin_product_movements');`);
  check("anon/authenticated 對三個新 view 一個權限都沒有", viewGrants.rows[0]?.n, 0);

  const fnGrants = await q(`
    select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname in ('public','inv')
       and (p.proname like 'inv\\_%' or p.proname = 'stock_adjustment_initial_status')
       and (has_function_privilege('anon', p.oid, 'execute')
         or has_function_privilege('authenticated', p.oid, 'execute'));`);
  check("anon/authenticated 一支 inv_* 函式都執行不了", fnGrants.rows[0]?.n, 0);

  // 白名單以外的 module 一定被拒 + 對照組
  console.log("\n[18] 實測：inv_approve_record 的白名單");
  const target = await q(
    `select id from inv.stock_adjustments where status = 'pending_approval' limit 1;`,
  );
  const anyId = target.rows[0]?.id ?? "00000000-0000-0000-0000-000000000000";
  for (const bad of [
    "profiles",
    "auth.users",
    "inv.stock_adjustments",
    "stock_adjustments; drop table inv.products",
    "",
  ]) {
    const attempt = await q(
      `select public.inv_approve_record('${uid}'::uuid, '${bad.replace(/'/g, "''")}', '${anyId}'::uuid, true);`,
    );
    checkTrue(
      `module='${bad || "(空字串)"}' 被拒`,
      !attempt.ok && String(attempt.error).includes("APPROVAL_UNKNOWN_MODULE"),
      String(attempt.error).slice(0, 120),
    );
  }
  // 對照組：白名單內的一定要被認得，否則上面五條「被拒」是假性通過。
  const good = await q(
    `select public.inv_approve_record('${uid}'::uuid, 'stock_adjustments', '00000000-0000-0000-0000-000000000000'::uuid, true);`,
  );
  checkTrue(
    "對照組：module='stock_adjustments' 過了白名單（因為找不到那一筆才失敗）",
    !good.ok && String(good.error).includes("APPROVAL_NOT_FOUND"),
    String(good.error).slice(0, 160),
  );
}

// ── 結果 ────────────────────────────────────────────────────────────────────

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
