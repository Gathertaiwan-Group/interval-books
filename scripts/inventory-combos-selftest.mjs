#!/usr/bin/env node
/**
 * inventory-combos-selftest.mjs —— 套餐、二手書、Gemini OCR（0018）的自檢
 *
 * 兩段，理由與 inventory-products-selftest 相同：沒有金鑰的機器上也要有意義。
 *
 *   [靜態] 讀 supabase/migrations/0018 與新增的 TypeScript 檔，守的是**設計不變量**：
 *          · 套餐結帳是先依 id 排序 FOR UPDATE 再寫入（防死鎖唯一的機制）
 *          · 組合價的分攤在資料庫算，前端與 payload 都碰不到金額
 *          · 二手書那條死碼真的不在了，而且活著的 is_secondhand 判斷還在
 *          · OCR 走 server fn，**不是 client 直連 Gemini**，而且不收 base64
 *          · inv schema 對 anon/authenticated 零 grant
 *          答案都寫在檔案裡。永遠會跑。
 *
 *   [實測] 對目標資料庫真的跑一輪：建商品 → 建套餐 → 待審核擋下 → 核准 → 賣出
 *          → 驗分攤加總／庫存／FIFO → **兩個組成順序相反的套餐同時賣（併發鎖序）**
 *          → 二手書入帳 → CHECK 擋住錯誤形狀，然後全部刪掉並證明基準線一筆不差。
 *          需要 SUPABASE_ACCESS_TOKEN；沒有就整段 skip。
 *
 * ⚠️ 實測段會在**正式資料庫**建資料再刪掉。所有測試資料都帶固定前綴（見 MARK），
 *    開頭與結尾各清一次 —— 開頭那次是為了讓上一輪中途掛掉的殘骸不會累積。
 *
 * ⚠️ 清理順序：sales → combo_set_items → combo_sets → purchases → products。
 *    倒過來會被 FK 擋住（sales_combo_set_id_fkey 沒有 ON DELETE 動作，那是刻意的
 *    —— 0018 的 inv_delete_combo_set 就是靠它擋住「刪掉有銷售紀錄的套餐」）。
 *
 * 執行：
 *   node scripts/inventory-combos-selftest.mjs                         # 只跑靜態
 *   SUPABASE_ACCESS_TOKEN=sbp_… node scripts/inventory-combos-selftest.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/inventory-combos-selftest.mjs";

const MIG_0018 = join(ROOT, "supabase/migrations/0018_inventory_combos_secondhand.sql");
const SRC_FNS_COMBO = join(ROOT, "src/lib/admin/fns/inv-combos.ts");
const SRC_FNS_OCR = join(ROOT, "src/lib/admin/fns/ocr.ts");
const SRC_REPO_COMBO = join(ROOT, "src/server/repos/inv-combos.ts");
const SRC_GEMINI = join(ROOT, "src/server/gemini.ts");
const SRC_STORAGE = join(ROOT, "src/server/storage.ts");
const SRC_ENV = join(ROOT, "src/server/env.ts");
const SRC_SCHEMAS = join(ROOT, "src/lib/admin/schemas.ts");
const SRC_COMPRESS = join(ROOT, "src/lib/admin/image-compress.ts");
const SRC_SHELL = join(ROOT, "src/routes/admin/_shell.tsx");

/** 測試資料的固定標記。刪除全靠它，所以要夠特別。 */
const MARK = "__invcomboselftest__";

// -----------------------------------------------------------------------------
// 迷你測試框架（與另外兩支進銷存自檢逐字相同）
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
 * 0018 與新的 TS 檔在註解裡**大量**引用來源的錯誤寫法（`isFirstItem ? … : 0`、
 * `product_type = 'secondhand'`、`base64`…）。用整檔 includes() 去斷言「這個字
 * 沒有出現」的話，**寫得越清楚的註解越會讓測試變紅**，那會逼下一個人去刪註解
 * 而不是去修程式。
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

function lineCount(text) {
  // 與 `wc -l` 同一種數法：檔尾那個換行不算一行
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

// -----------------------------------------------------------------------------
// [1] 檔案盤點，而且 0001–0017 一個都沒有被動過
// -----------------------------------------------------------------------------

console.log("\n[1] 檔案盤點");
check("0018 存在", existsSync(MIG_0018), true);

const MIG_DIR = join(ROOT, "supabase/migrations");
const migFiles = readdirSync(MIG_DIR);
for (let n = 1; n <= 17; n += 1) {
  const prefix = String(n).padStart(4, "0");
  check(
    `migration ${prefix} 仍在`,
    migFiles.some((f) => f.startsWith(`${prefix}_`)),
    true,
  );
}
// ⚠️ 這一條的作用是「下一期的人一定要回來看這支測試」。0019（廠商／PII 治理）
// 加進來時它就是這樣把人叫回來的 —— 那一期改了 sales_product_id_fkey 與
// combo_set_items_product_id_fkey 的 ON DELETE 行為（SET NULL/CASCADE → RESTRICT），
// 所以下面的清理順序與「刪商品」相關的斷言都要在 0019 的前提下重讀一次。
// 0020（場次名額／逐位參加者）不碰套餐、二手書或 OCR bucket，所以這支測試的
// 斷言全部原樣成立。它動的是 public.products 的名額欄位與 event_sessions 那兩張
// 新表，由 event-registration-selftest 驗。
check(
  "0020 在（場次名額）",
  migFiles.some((f) => f.startsWith("0020_")),
  true,
);
// 0021（名單的遮罩 view、明文揭露與 CSV 匯出）同樣不碰套餐、二手書或 OCR bucket。
// 逐條重讀過：它加了 inv.mask_email()（一支新的遮罩函式，沒有覆寫 inv.mask_tail），
// 放寬了 pii_access_log 與 staff_permissions 的三條 CHECK，其餘全在 public 的
// event_* 上。下面的斷言全部原樣成立。0021 自己的內容由 roster-csv-selftest 驗。
check(
  "0021 在（名單 PII）",
  migFiles.some((f) => f.startsWith("0021_")),
  true,
);
// 0022（交易信 outbox 與付款通知）第三次把人叫回來。逐條重讀過：它只新增
// public.email_outbox 與 public.email_copy 兩張表、十二支 public.* 的函式，以及
// 一段往 public.order_post_payment_log 補列的回填。**它一個 drop 都沒有，
// alter table 只打在自己新建的那兩張表上**（notify-selftest [2] 用 regex 把
// alter 的目標抓出來比對，守著這件事）。inv 的任何一張表、任何一支函式、
// sales_product_id_fkey 與 combo_set_items_product_id_fkey 的 ON DELETE 行為全部
// 沒有被碰到，所以下面關於套餐、二手書、OCR bucket 與清理順序的斷言原樣成立。
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

const sql = read(MIG_0018);
const exec = strip(sql);
// 反空殼：先證明檔案真的有內容，否則下面每一條 includes() 都是假性結果。
checkTrue("0018 不是空檔（> 15000 字）", exec.length > 15000, `實際 ${exec.length} 字`);

for (const f of [SRC_FNS_COMBO, SRC_FNS_OCR, SRC_REPO_COMBO, SRC_GEMINI, SRC_COMPRESS]) {
  checkTrue(`${f.replace(ROOT + "/", "")} 存在`, existsSync(f));
}

// -----------------------------------------------------------------------------
// [2] 二手書：死碼真的不在了，活著的判斷還在
// -----------------------------------------------------------------------------

console.log("\n[2] 二手書：收斂資料模型");

// 0018 重寫了 update_stock_on_sale 與 rollback_fifo_cost。抓出它們在 0018 裡的
// 函式本體（去掉註解）來驗——不能整檔搜，因為檔頭花了 20 行解釋那個死碼長什麼樣。
function bodyOf(name) {
  const re = new RegExp(`create or replace function inv\\.${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`, "m");
  const m = re.exec(exec);
  return m ? m[0] : "";
}

const bodyStock = bodyOf("update_stock_on_sale");
const bodyRollback = bodyOf("rollback_fifo_cost");
checkTrue("0018 有重寫 update_stock_on_sale", bodyStock.length > 500);
checkTrue("0018 有重寫 rollback_fifo_cost", bodyRollback.length > 500);

const DEAD = /product_type\s*(=|!=|<>)\s*'secondhand'/;
checkTrue(
  "update_stock_on_sale 的 product_type='secondhand' 死碼已刪",
  !DEAD.test(bodyStock),
  "products.product_type 的 CHECK 只允許 outright/consignment/rental，這個分支永遠進不去",
);
checkTrue("rollback_fifo_cost 的同一段死碼也刪了", !DEAD.test(bodyRollback));

// 對照組：活著的那個判斷**必須**還在，否則上面兩條就只是「把二手支援整個拔掉」。
checkTrue(
  "對照組：update_stock_on_sale 仍用 is_secondhand 早退（真正生效的那一句）",
  /NEW\.product_id IS NULL OR NEW\.is_secondhand\s*=\s*true/i.test(bodyStock),
);
checkTrue(
  "對照組：rollback_fifo_cost 仍用 is_secondhand 早退",
  /OLD\.product_id IS NULL OR OLD\.is_secondhand\s*=\s*true/i.test(bodyRollback),
);

checkTrue(
  "補上 sales_secondhand_has_no_product 這條 CHECK",
  /add constraint sales_secondhand_has_no_product[\s\S]{0,200}check\s*\(\s*is_secondhand\s*=\s*false\s+or\s+product_id\s+is\s+null/i.test(
    exec,
  ),
);
// ⚠️ 這一條要精準：0018 的 comment on function 字串裡本來就寫著
//    「刪掉了 product_type = ''secondhand'' 那個分支」（SQL 的雙引號跳脫），
//    用寬鬆的 includes() 會被那句註解騙到。所以只找**真的動到 CHECK 的 DDL**。
checkTrue(
  "沒有把 'secondhand' 加進 products.product_type 的 CHECK（那是被否決的模型）",
  !/alter table\s+inv\.products[\s\S]{0,400}product_type[\s\S]{0,200}secondhand/i.test(exec) &&
    !/products_product_type_check/i.test(exec),
  "補 CHECK 等於把作者自己在 2026-01-26 當天就否決掉的模型重新合法化",
);
checkTrue(
  "二手書結帳函式硬寫 product_id = NULL（不接受呼叫端指定商品）",
  /inv_secondhand_checkout[\s\S]*?INSERT INTO inv\.sales[\s\S]{0,400}NULL,\s*$/m.test(exec) ||
    /p_user_id,\s*\n\s*NULL,/.test(exec),
);

// zod 要鏡射 DB 的形狀：二手書的 schema 不可以有 product_id
const schemasTs = stripTs(read(SRC_SCHEMAS));
checkTrue(
  "secondhandSaleSchema 沒有 product_id 欄位（DB 的 CHECK 也擋著）",
  /secondhandSaleSchema[\s\S]*?\}\);/.test(schemasTs) &&
    !/secondhandSaleSchema[\s\S]*?product_id[\s\S]*?\}\);/.test(schemasTs),
);
checkTrue(
  "INV_PRODUCT_TYPES 仍然只有三種（沒有偷偷多一個 secondhand）",
  /INV_PRODUCT_TYPES\s*=\s*\[\s*"outright",\s*"consignment",\s*"rental"\s*\]/.test(schemasTs),
);

// -----------------------------------------------------------------------------
// [3] 套餐：鎖序（防死鎖）
// -----------------------------------------------------------------------------

console.log("\n[3] 套餐：先依 id 排序鎖完，再寫入");

const checkoutFn =
  /create or replace function public\.inv_combo_checkout\([\s\S]*?\n\$\$;/m.exec(exec)?.[0] ?? "";
checkTrue("找得到 inv_combo_checkout 的函式本體", checkoutFn.length > 1000);

const lockIdx = checkoutFn.search(/FOR UPDATE/i);
const insertIdx = checkoutFn.search(/INSERT INTO inv\.sales/i);
checkTrue("inv_combo_checkout 有 FOR UPDATE", lockIdx >= 0);
checkTrue("inv_combo_checkout 有寫 inv.sales", insertIdx >= 0);
checkTrue(
  "**鎖在寫入之前**（順序反了就等於沒鎖）",
  lockIdx >= 0 && insertIdx >= 0 && lockIdx < insertIdx,
  `FOR UPDATE 在 ${lockIdx}，INSERT 在 ${insertIdx}`,
);
checkTrue(
  "鎖的時候有 order by（依 id，這是防死鎖唯一的機制）",
  /ORDER BY\s+p\.id\s*\n?\s*FOR UPDATE/i.test(checkoutFn),
  "兩張組成品項順序相反的套餐同時賣 = ABBA 死鎖，見 0018 檔頭問題二",
);
checkTrue(
  "組成品項是依 product_id 排序讀出來的（分攤才會是決定性的）",
  /ORDER BY i\.product_id/i.test(checkoutFn),
  "來源抓 combo_set_items 沒有 order by，於是「第一件」由 heap 掃描順序決定",
);
checkTrue(
  "鎖的是要扣庫存的那一列（母子品項時是母品項）",
  /coalesce\(p\.base_product_id, i\.product_id\)/i.test(checkoutFn),
);

// 這一支不可以自己扣庫存 —— 那是 trigger 的事，兩條路就會有扣兩次的方法
checkTrue(
  "inv_combo_checkout 沒有自己 UPDATE inv.products.stock_quantity",
  !/UPDATE inv\.products[\s\S]{0,120}stock_quantity/i.test(checkoutFn),
  "庫存由 on_sale_insert trigger 扣，與單品銷售同一條路",
);
checkTrue(
  "inv_combo_checkout 沒有自己呼叫 allocate_fifo_cost",
  !/allocate_fifo_cost/i.test(checkoutFn),
  "成本由 allocate_fifo_before_sale_insert trigger 算；來源是 client 先 rpc 再 insert，中間斷線就漏帳",
);
// 欄位清單裡有 cost_price，VALUES 裡對應的位置寫 NULL 並就地註明理由。
// （strip() 只拿掉整行註解，行尾註解還在，所以不能用 /NULL,\s*$/。）
checkTrue(
  "cost_price 寫 NULL 讓 trigger 去算",
  /unit_price,\s*amount,\s*cost_price/i.test(checkoutFn) &&
    /NULL,\s*--\s*←\s*讓 allocate_fifo_before_sale_insert/.test(checkoutFn),
  "自己算成本就會有第二條路，兩條路遲早會不一致",
);

// -----------------------------------------------------------------------------
// [4] 套餐：分攤口徑
// -----------------------------------------------------------------------------

console.log("\n[4] 套餐：組合價的分攤在資料庫算");

const allocFn =
  /create or replace function inv\.allocate_combo_amounts\([\s\S]*?\n\$\$;/m.exec(exec)?.[0] ?? "";
checkTrue("找得到 allocate_combo_amounts", allocFn.length > 500);
checkTrue("它是 immutable 純函式（可以單獨餵資料驗算）", /immutable/i.test(allocFn));
checkTrue("它不碰任何表", !/\b(insert|update|delete)\s+(into\s+)?inv\./i.test(allocFn));
checkTrue(
  "有最大餘額法的配發迴圈（保證加總等於總額）",
  /WHILE v_assigned < v_units LOOP/i.test(allocFn),
);
checkTrue(
  "拿過餘額的項目會退出競爭（否則餘數會全堆在同一件商品上）",
  /v_frac\[v_best\]\s*:=\s*-1/.test(allocFn),
);
checkTrue(
  "權重全 0 時退回均分（不能除以 0，也不能讓整筆營收消失）",
  /IF v_sum = 0 THEN/i.test(allocFn),
);
checkTrue(
  "有任何一件沒定價時，整組退回按數量均分",
  /IF v_zero_price THEN/i.test(checkoutFn) && /v_basis\s*:=\s*'quantity'/.test(checkoutFn),
  "來源是「第一件吃全額、其餘記 0」。只把沒定價的那件記 0 只是換一個品項去背",
);
checkTrue(
  "結帳結果會回報用了哪一種分攤（店員看得到錢怎麼拆）",
  /'basis',\s*v_basis/.test(checkoutFn),
);
checkTrue(
  "unit_price 由 amount 反推，兩種營收口徑不會打架",
  /round\(v_amounts\[v_i\] \/ v_qtys\[v_i\], 2\)/.test(checkoutFn),
);

// 待審核／停用／空套餐都要擋
for (const [label, re] of [
  ["停用的套餐不可販售", /COMBO_INACTIVE/],
  ["未審核的套餐不可販售（來源只看 is_active，pending 照賣）", /COMBO_NOT_APPROVED/],
  ["沒有組成品項的套餐不可販售（正式庫有三個這種）", /COMBO_NO_ITEMS/],
  ["組成品項停用時擋下", /COMBO_ITEM_INACTIVE/],
]) {
  checkTrue(label, re.test(checkoutFn));
}

// 改價要重新送審
const saveFn =
  /create or replace function public\.inv_save_combo_set\([\s\S]*?\n\$\$;/m.exec(exec)?.[0] ?? "";
checkTrue("找得到 inv_save_combo_set", saveFn.length > 800);
checkTrue(
  "改動組合價會重新送審（來源的 updateMutation 從來不重設 approval_status）",
  /v_old_price IS DISTINCT FROM v_price/i.test(saveFn),
);
checkTrue(
  "初始 approval_status 由資料庫算（呼叫端指定不了）",
  /inv\.initial_approval_status\('combo_sets'\)/.test(saveFn),
);
checkTrue("同一件商品不可以在套餐裡出現兩次", /COMBO_DUP_ITEM/.test(saveFn));
checkTrue("有銷售紀錄的套餐不可刪（要改成停用）", /COMBO_HAS_SALES/.test(exec));

// -----------------------------------------------------------------------------
// [5] 權限：inv 對 anon/authenticated 零 grant
// -----------------------------------------------------------------------------

console.log("\n[5] 0018 的每一個新物件都先 revoke 再 grant");

const NEW_FUNCS = [
  "inv.allocate_combo_amounts",
  "public.inv_combo_checkout",
  "public.inv_secondhand_checkout",
  "public.inv_save_combo_set",
  "public.inv_set_combo_set_active",
  "public.inv_delete_combo_set",
  "public.inv_resubmit_combo_set",
];
for (const fn of NEW_FUNCS) {
  const esc = fn.replace(/\./g, "\\.");
  checkTrue(
    `${fn} 對 anon/authenticated revoke`,
    new RegExp(`revoke execute on function ${esc}\\([^)]*\\) from anon, authenticated;`, "i").test(
      exec,
    ),
  );
  checkTrue(
    `${fn} 只 grant 給 service_role`,
    new RegExp(`grant\\s+execute on function ${esc}\\([^)]*\\) to service_role;`, "i").test(exec),
  );
}

const NEW_VIEWS = ["inv_admin_combo_sets", "inv_admin_combo_set_items", "inv_admin_combo_sales"];
for (const v of NEW_VIEWS) {
  checkTrue(
    `${v} 是 security_invoker = false`,
    new RegExp(`create view public\\.${v}\\s*\\n?with \\(security_invoker = false\\)`, "i").test(
      exec,
    ),
  );
  checkTrue(
    `${v} 對 anon/authenticated revoke all`,
    new RegExp(`revoke all on public\\.${v}\\s+from anon, authenticated;`, "i").test(exec),
  );
  checkTrue(
    `${v} 只 grant select 給 service_role`,
    new RegExp(`grant select on public\\.${v}\\s+to service_role;`, "i").test(exec),
  );
  // create or replace view 不能改欄位名／順序，所以新 view 一律 drop + create
  checkTrue(
    `${v} 是 drop + create（可以重跑）`,
    new RegExp(`drop view if exists public\\.${v} cascade;`, "i").test(exec),
  );
}

checkTrue(
  "OCR 的 bucket 是私有的（進貨單上有廠商資料）",
  /'ocr-scans'[\s\S]{0,200}false,\s*--/.test(exec) || /'ocr-scans',\s*\n\s*false,/.test(exec),
);
checkTrue(
  "on conflict 時也強制 public = false（重跑不會把它變公開）",
  /on conflict \(id\) do update[\s\S]{0,120}set public\s*=\s*false/i.test(exec),
);

// -----------------------------------------------------------------------------
// [6] Server fn：授權與 payload 形狀
// -----------------------------------------------------------------------------

console.log("\n[6] server fn：授權在 middleware，金額不在 payload");

const fnsCombo = stripTs(read(SRC_FNS_COMBO));
const fnsOcr = stripTs(read(SRC_FNS_OCR));
const repoCombo = stripTs(read(SRC_REPO_COMBO));

checkTrue(
  "套餐的 server fn 沒有一支漏掉 middleware",
  (() => {
    const decls = fnsCombo.match(/createServerFn\(/g) ?? [];
    const mws = fnsCombo.match(/\.middleware\(\[staffFnMiddleware\(\)\]\)/g) ?? [];
    return decls.length > 0 && decls.length === mws.length;
  })(),
  "每一支 createServerFn 都要 chain staffFnMiddleware()",
);

checkTrue(
  "OCR 的 server fn 也沒有一支漏掉 middleware",
  (() => {
    const decls = fnsOcr.match(/createServerFn\(/g) ?? [];
    const mws = fnsOcr.match(/\.middleware\(\[staffFnMiddleware\(\)\]\)/g) ?? [];
    return decls.length > 0 && decls.length === mws.length;
  })(),
);

checkTrue(
  "審核那一支另外查 approve_combo_sets（middleware 只擋到 staff）",
  /permissions\.includes\("approve_combo_sets"\)/.test(fnsCombo),
);
checkTrue(
  "審核的 module 是寫死的字串，不是參數（來源讓 client 指定要更新哪張表）",
  /module:\s*"combo_sets"/.test(fnsCombo) && !/module:\s*data\./.test(fnsCombo),
);
checkTrue(
  "一個字都沒有動到 adminFnMiddleware",
  !/adminFnMiddleware/.test(fnsCombo) && !/adminFnMiddleware/.test(fnsOcr),
);
checkTrue(
  "userId 取自 context.staff，不是 payload",
  /context\.staff\.userId/.test(fnsCombo) && !/userId:\s*data\./.test(fnsCombo),
);
checkTrue(
  "存檔時只挑白名單欄位轉下去（不是整包 data）",
  /payload:\s*\{\s*\n\s*name:/.test(fnsCombo),
);

// -----------------------------------------------------------------------------
// [7] OCR：走 server fn，不是 client 直連；而且不收 base64
// -----------------------------------------------------------------------------
// ⚠️ 4a/4b 的自檢守的是「OCR 入口按鈕不存在」（因為它打的是已經失效的 Lovable
//    AI Gateway）。4c 接上之後那條斷言換成這一段：**入口回來了，但它必須走
//    server fn**。單純把舊斷言刪掉的話，「前端自己拿金鑰打 Gemini」會靜默通過。

console.log("\n[7] OCR：金鑰在伺服器，圖走 storage key");

const gemini = stripTs(read(SRC_GEMINI));
const envTs = stripTs(read(SRC_ENV));
const storageTs = stripTs(read(SRC_STORAGE));

checkTrue("gemini.ts 是 server-only", /@tanstack\/react-start\/server-only/.test(gemini));
checkTrue("金鑰從 src/server/env.ts 拿", /geminiApiKey\(\)/.test(gemini));
checkTrue(
  "金鑰沒有 VITE_ 前綴（那會被 define 進瀏覽器 bundle）",
  !/VITE_GEMINI/.test(envTs) &&
    /process\.env\["?GEMINI_API_KEY"?\]|required\("GEMINI_API_KEY"\)/.test(envTs),
);
checkTrue("金鑰走 header 不走 query string（網址會進 log）", /"x-goog-api-key"/.test(gemini));
checkTrue("沒有留著 Lovable AI Gateway 的位址", !/lovable/i.test(gemini));
checkTrue(
  "沒有建 edge function（這個專案一支都沒有）",
  !existsSync(join(ROOT, "supabase/functions")),
);

// 前端的每一個檔案都不可以自己打 Gemini
const CLIENT_DIRS = ["src/components", "src/routes", "src/lib"];
let clientCode = "";
function walk(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel);
    else if (/\.tsx?$/.test(entry.name)) clientCode += read(join(ROOT, rel)) + "\n";
  }
}
for (const d of CLIENT_DIRS) walk(d);
const clientStripped = stripTs(clientCode);

checkTrue(
  "前端不是空的（> 100000 字）",
  clientStripped.length > 100000,
  `實際 ${clientStripped.length} 字`,
);
checkTrue(
  "前端沒有任何一處打 generativelanguage.googleapis.com",
  !/generativelanguage/.test(clientStripped),
  "client 直連 = 金鑰在瀏覽器裡",
);
checkTrue("前端沒有出現 GEMINI_API_KEY", !/GEMINI_API_KEY/.test(clientStripped));
checkTrue(
  "server fn 只收 storage key，schema 裡沒有 base64/dataUrl 這種欄位",
  /ocrScanKeySchema/.test(schemasTs) &&
    !/(base64|dataUrl|data_url|imageBase64)/i.test(stripTs(read(SRC_FNS_OCR))),
);
checkTrue(
  "ocrScanKeySchema 綁死 ocr: 前綴與檔名形狀",
  /\^ocr:\\d\{4\}-\\d\{2\}-\\d\{2\}\\\//.test(schemasTs),
);
checkTrue(
  "storage.ts 另外自己再驗一次 key 的形狀（不信任上游）",
  /function ocrObjectName/.test(storageTs) && /ocrObjectName/.test(storageTs),
);
checkTrue(
  "OCR 圖走 signed URL，沒有 public URL（bucket 是私有的）",
  /createSignedUrl/.test(storageTs) && !/object\/public\/\$\{OCR_SCANS_BUCKET\}/.test(storageTs),
);
checkTrue(
  "上傳一樣嗅 magic bytes，不信 file.type",
  /uploadOcrScan[\s\S]{0,600}sniffImageFormat/.test(storageTs),
);

// 降級到手動輸入：失敗要分得出種類，而且不 throw（前端才有辦法分開處理）
checkTrue(
  "辨識失敗有分類（quota/timeout/bad_response/no_content/service）",
  (() => {
    return ["quota", "timeout", "bad_response", "no_content", "service"].every((k) =>
      new RegExp(`"${k}"`).test(gemini),
    );
  })(),
);
checkTrue(
  "有逾時保護（AbortController）",
  /AbortController/.test(gemini) && /AbortError/.test(gemini),
);
checkTrue(
  "429 與 402/403 分開處理（來源把額度用完混成一句 500）",
  /=== 429/.test(gemini) && /=== 402/.test(gemini),
);
checkTrue(
  "server fn 把辨識失敗收成 ok:false 而不是 throw（前端要分種類）",
  /ok:\s*false,\s*kind/.test(fnsOcr),
);
checkTrue(
  "OCR 這一層不寫任何一張 inv 表（AI 沒有寫入權）",
  !/inv_save_|inv_import_|inv_combo_checkout|INSERT INTO/i.test(fnsOcr),
);
checkTrue(
  "用 responseSchema 拿結構化結果，不是抓第一個 { 到最後一個 }",
  /responseSchema/.test(gemini) && !/\\\{\[\\s\\S\]\*\\\}/.test(gemini),
);
checkTrue(
  "模型認出來的數量／單價仍然自己驗一次（模型不是驗證器）",
  /Number\.isFinite\(quantity\)/.test(gemini) && /Number\.isFinite\(unitCost\)/.test(gemini),
);

// -----------------------------------------------------------------------------
// [8] 前端不變量
// -----------------------------------------------------------------------------

console.log("\n[8] 前端：沒有搬進來的東西");

const NEW_FRONT_DIRS = ["src/components/ocr", "src/components/pos"];
const newFrontFiles = [];
for (const d of NEW_FRONT_DIRS) {
  const abs = join(ROOT, d);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs)) if (/\.tsx?$/.test(f)) newFrontFiles.push(`${d}/${f}`);
}
const comboComp = existsSync(join(ROOT, "src/components/inventory"))
  ? readdirSync(join(ROOT, "src/components/inventory"))
      .filter((f) => /^Combo/.test(f))
      .map((f) => `src/components/inventory/${f}`)
  : [];
const ROUTES = ["src/routes/admin/_shell.inventory-combos.tsx", "src/routes/admin/_shell.pos.tsx"];
const ALL_NEW = [...newFrontFiles, ...comboComp, ...ROUTES].filter((f) =>
  existsSync(join(ROOT, f)),
);

checkTrue(`掃到 ${ALL_NEW.length} 個前端檔（> 8）`, ALL_NEW.length > 8);
const frontCode = stripTs(ALL_NEW.map((f) => read(join(ROOT, f))).join("\n"));
checkTrue(
  "這批前端檔不是空的（> 20000 字）",
  frontCode.length > 20000,
  `實際 ${frontCode.length} 字`,
);

checkTrue(
  "沒有 react-query",
  !/@tanstack\/react-query|useQuery|useMutation|queryClient/.test(frontCode),
);
checkTrue("沒有搬進 use-toast / toaster", !/use-toast|useToast|Toaster/.test(frontCode));
checkTrue("LocalizedField 沒有出現（進銷存是單語 text）", !/LocalizedField/.test(frontCode));
checkTrue("沒有 xlsx 的靜態 import", !/^import .*["']xlsx["']/m.test(frontCode));
checkTrue(
  "前端沒有直接碰 supabase",
  !/supabaseAdmin|createClient|@supabase\/supabase-js/.test(frontCode),
);
checkTrue(
  "日期用 todayInTaipei 不是 toISOString",
  !/toISOString\(\)\.slice\(0,\s*10\)/.test(frontCode),
);
checkTrue(
  "前端沒有自己算分攤後直接送金額（amount/cost_price 不在 payload 裡）",
  !/amount:\s*[^,}\n]+,[\s\S]{0,80}(comboCheckout|secondhandCheckout)/.test(frontCode),
);

console.log("\n[8b] 每個新檔案都在 300 行以內");
for (const f of ALL_NEW) {
  const n = lineCount(read(join(ROOT, f)));
  checkTrue(`${f}（${n} 行）`, n <= 300, "超過 300 行，請再拆");
}

console.log("\n[8c] 側欄有套餐入口，而且是 staff 看得到的");
const shell = read(SRC_SHELL);
checkTrue(
  "側欄有「套餐」且 staff: true",
  // 不要求寫在同一行 —— 理由與 inventory-adjustments-selftest 同一條：prettier
  // 會依 icon 名稱長度折行。[^{}]* 保證不會跨過物件邊界讀到下一個項目。
  /to:\s*"\/admin\/inventory-combos",[^{}]*label:\s*"套餐",[^{}]*staff:\s*true/.test(shell),
);
// ⚠️ 側欄把模組藏起來不是授權。真正的擋在每一支 server fn 的 middleware。
checkTrue(
  "_shell.tsx 沒有被改成用 approve_* 做側欄過濾",
  !/approve_combo_sets/.test(stripTs(shell)),
);

// -----------------------------------------------------------------------------
// [9]–[13] 實測
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
 * ⚠️ 順序不能換：sales → combo_set_items → combo_sets → purchases → products。
 *    sales 先走是因為 sales_combo_set_id_fkey 沒有 ON DELETE 動作（那正是
 *    inv_delete_combo_set 用來擋「刪掉有銷售的套餐」的機制）。
 * ⚠️ 已出庫的進貨批次不可刪 → 先把 remaining_quantity 補回 quantity。
 */
async function cleanup() {
  const pids = `(select id from inv.products where name like '${MARK}%')`;
  const cids = `(select id from inv.combo_sets where name like '${MARK}%')`;
  await q(`delete from inv.sales where combo_set_id in ${cids};`);
  await q(`delete from inv.sales where product_id in ${pids};`);
  await q(`delete from inv.sales where item_name like '${MARK}%';`);
  await q(`delete from inv.combo_set_items where combo_set_id in ${cids};`);
  await q(`delete from inv.combo_sets where name like '${MARK}%';`);
  await q(`update inv.purchases set remaining_quantity = quantity where product_id in ${pids};`);
  await q(`delete from inv.purchases where product_id in ${pids};`);
  await q(`delete from inv.products where name like '${MARK}%';`);
}

if (!TOKEN) {
  skipped.push("實測（缺 SUPABASE_ACCESS_TOKEN）");
  console.log(yellow("\n[9]–[13] 跳過實測：沒有 SUPABASE_ACCESS_TOKEN"));
} else {
  await cleanup();

  const operator = await q(`select user_id from inv.profiles limit 1;`);
  const uid = operator.rows[0]?.user_id;
  checkTrue("拿得到一個操作人員 uuid", Boolean(uid));

  const baseline = await q(`
    select (select count(*)::int from inv.products) p,
           (select count(*)::int from inv.purchases) pu,
           (select count(*)::int from inv.sales) s,
           (select count(*)::int from inv.stock_adjustments) sa,
           (select count(*)::int from inv.inventory_adjustments) ia,
           (select count(*)::int from inv.combo_sets) cs,
           (select count(*)::int from inv.combo_set_items) ci,
           (select count(*)::int from public.publications) pub,
           (select count(*)::int from public.products) pp;`);
  const base = baseline.rows[0] ?? {};
  checkTrue("讀得到基準線", Boolean(base.p));

  // ── [9] 建資料 → 分攤 → 庫存 → FIFO ────────────────────────────────────
  console.log("\n[9] 實測：建套餐 → 待審核擋下 → 核准 → 賣出 → 驗分攤／庫存／FIFO");

  const setup = await q(`
    create temp table if not exists combolog(seq serial, step text, detail text);
    truncate combolog;
    do $selftest$
    declare
      v_uid uuid; v_a uuid; v_b uuid; v_c uuid; v_combo uuid; v_r jsonb;
      v_sum numeric; v_rows int; v_zero int; v_mismatch int; v_stock text; v_rem text;
    begin
      select user_id into v_uid from inv.profiles limit 1;

      -- 三件商品，定價 120 / 60 / 20，各進 100 件成本 10 / 5 / 2
      insert into inv.products(name,user_id,stock_quantity,selling_price,cost_price,product_type,is_active,approval_status)
        values ('${MARK}A', v_uid, 0, 120, 10, 'outright', true, 'approved') returning id into v_a;
      insert into inv.products(name,user_id,stock_quantity,selling_price,cost_price,product_type,is_active,approval_status)
        values ('${MARK}B', v_uid, 0, 60, 5, 'consignment', true, 'approved') returning id into v_b;
      insert into inv.products(name,user_id,stock_quantity,selling_price,cost_price,product_type,is_active,approval_status)
        values ('${MARK}C', v_uid, 0, 20, 2, 'outright', true, 'approved') returning id into v_c;

      insert into inv.purchases(user_id,product_id,quantity,unit_cost,purchase_date,remaining_quantity,approval_status)
        values (v_uid,v_a,100,10,'2026-01-01',100,'approved'),
               (v_uid,v_b,100,5,'2026-01-01',100,'approved'),
               (v_uid,v_c,100,2,'2026-01-01',100,'approved');
      update inv.products set stock_quantity = 100 where id in (v_a,v_b,v_c);

      -- 組合價 160（定價合計 200，打八折）
      v_r := public.inv_save_combo_set(v_uid, null,
        jsonb_build_object('name','${MARK}套餐','selling_price',160,'is_active',true),
        jsonb_build_array(
          jsonb_build_object('product_id', v_a, 'quantity', 1),
          jsonb_build_object('product_id', v_b, 'quantity', 1),
          jsonb_build_object('product_id', v_c, 'quantity', 1)));
      v_combo := (v_r ->> 'id')::uuid;
      -- 狀態是 inv.initial_approval_status('combo_sets') 算的，不是呼叫端給的。
      -- ⚠️ 正式庫的 approval_settings.combo_sets 目前是**關著的**，所以這裡會是
      --    'approved'。斷言比對的是「DB 自己算出來的那個值」而不是寫死 'pending'
      --    —— 寫死的話，這個測試會變成在測店家的設定，而不是測程式。
      insert into combolog(step,detail) values ('建套餐', v_r ->> 'approval_status');
      insert into combolog(step,detail) values ('DB 算的初始狀態', inv.initial_approval_status('combo_sets'));

      -- 待審核時不可販售。不動全域設定（那是正式資料庫），直接把**這一筆測試資料**
      -- 壓成 pending 再試賣 —— 這樣不管店家把審核開著還關著，這條都測得到。
      update inv.combo_sets set approval_status = 'pending' where id = v_combo;
      begin
        v_r := public.inv_combo_checkout(v_uid, v_combo, 1, CURRENT_DATE);
        insert into combolog(step,detail) values ('pending 販售', '沒有被擋下');
      exception when others then
        insert into combolog(step,detail) values ('pending 販售', left(SQLERRM, 60));
      end;

      v_r := public.inv_approve_record(v_uid,'combo_sets',v_combo,true);
      v_r := public.inv_combo_checkout(v_uid, v_combo, 1, CURRENT_DATE);
      insert into combolog(step,detail) values ('分攤口徑', v_r ->> 'basis');
      insert into combolog(step,detail) values ('結帳總額', v_r ->> 'total_amount');

      select sum(amount), count(*), count(*) filter (where amount = 0),
             count(*) filter (where round(unit_price*quantity,2) <> amount)
        into v_sum, v_rows, v_zero, v_mismatch
        from inv.sales where combo_set_id = v_combo;
      insert into combolog(step,detail) values ('營收加總', v_sum::text);
      insert into combolog(step,detail) values ('列數', v_rows::text);
      insert into combolog(step,detail) values ('零營收列數', v_zero::text);
      insert into combolog(step,detail) values ('unit_price*qty≠amount 的列數', v_mismatch::text);

      select string_agg(stock_quantity::text, '/' order by name) into v_stock
        from inv.products where name like '${MARK}%';
      insert into combolog(step,detail) values ('庫存', v_stock);

      select string_agg(pu.remaining_quantity::text, '/' order by p.name) into v_rem
        from inv.purchases pu join inv.products p on p.id = pu.product_id where p.name like '${MARK}%';
      insert into combolog(step,detail) values ('FIFO 剩餘', v_rem);

      -- ⚠️ round(...)：cost_price 是 numeric，allocate_fifo_cost 回的是
      --    「總成本 / 數量」，於是 10 會存成 10.0000000000000000。這裡比的是數值
      --    不是字面，所以先正規化 —— 不然這條斷言測到的是 numeric 的顯示格式。
      select string_agg(round(s.cost_price, 2)::text, '/' order by p.name) into v_rem
        from inv.sales s join inv.products p on p.id = s.product_id where s.combo_set_id = v_combo;
      insert into combolog(step,detail) values ('逐列成本', v_rem);

      select string_agg(s.amount::text, '/' order by p.name) into v_rem
        from inv.sales s join inv.products p on p.id = s.product_id where s.combo_set_id = v_combo;
      insert into combolog(step,detail) values ('逐列營收', v_rem);
    end $selftest$;
    select seq, step, detail from combolog order by seq;
  `);

  if (!setup.ok) {
    fail += 1;
    console.log(red(`  ✗ 實測前置失敗：${String(setup.error).slice(0, 300)}`));
  } else {
    const m = new Map(setup.rows.map((r) => [r.step, r.detail]));
    check(
      "套餐的初始狀態 = DB 自己算的那個（呼叫端指定不了）",
      m.get("建套餐"),
      m.get("DB 算的初始狀態"),
    );
    checkTrue(
      "而且那個值是合法的兩種之一",
      ["pending", "approved"].includes(m.get("DB 算的初始狀態")),
      m.get("DB 算的初始狀態"),
    );
    checkTrue(
      "待審核的套餐被擋下",
      String(m.get("pending 販售") ?? "").includes("COMBO_NOT_APPROVED"),
      m.get("pending 販售"),
    );
    check("三件都有定價 → 依定價比例分攤", m.get("分攤口徑"), "list_price");
    // 160 × 120/200 = 96；160 × 60/200 = 48；160 × 20/200 = 16
    check("逐列營收 = 96/48/16（依定價比例）", m.get("逐列營收"), "96.00/48.00/16.00");
    check("營收加總 = 組合價 160", Number(m.get("營收加總")), 160);
    check("一份套餐寫三列", Number(m.get("列數")), 3);
    check("沒有任何一列是零營收（寄賣才拆得到帳）", Number(m.get("零營收列數")), 0);
    check(
      "unit_price × 數量 = amount，一列都沒有例外",
      Number(m.get("unit_price*qty≠amount 的列數")),
      0,
    );
    check("三件庫存各扣 1", m.get("庫存"), "99/99/99");
    check("三個 FIFO 批次各吃 1", m.get("FIFO 剩餘"), "99/99/99");
    check("逐列成本走 FIFO trigger（10/5/2）", m.get("逐列成本"), "10.00/5.00/2.00");
  }

  // ── [9b] 審核開／關兩種設定，initial_approval_status 都要對 ──────────────
  // 正式庫的 approval_settings.combo_sets 目前是**關著的**。上面那一段刻意寫成
  // 「跟 DB 算出來的值比對」所以不管開關都會過 —— 但那也代表**只測到現在這一邊**。
  // 這一段兩邊都測：暫時把設定翻過去、建一個套餐、看狀態，再翻回來。
  //
  // ⚠️ 這是正式資料庫的設定。整段包在一個 DO block 裡（= 一個交易），而且
  //    restore 寫在 exception handler 之後：正常路徑會還原，非正常路徑整個交易
  //    回捲也會還原。兩條路都不會把店家的設定留在被改過的狀態。
  console.log("\n[9b] 實測：審核開與關，初始狀態都由 DB 決定");
  const both = await q(`
    create temp table if not exists apprlog(seq serial, step text, detail text);
    truncate apprlog;
    do $selftest$
    declare
      v_uid uuid; v_pid uuid; v_r jsonb; v_was boolean; v_id uuid;
    begin
      select user_id into v_uid from inv.profiles limit 1;
      select is_enabled into v_was from inv.approval_settings where module = 'combo_sets';
      insert into apprlog(step,detail) values ('原始設定', coalesce(v_was::text,'(無此列)'));

      insert into inv.products(name,user_id,stock_quantity,selling_price,cost_price,product_type,is_active,approval_status)
        values ('${MARK}審核用', v_uid, 5, 50, 10, 'outright', true, 'approved') returning id into v_pid;

      -- (1) 審核開著 → 新套餐必須是 pending
      update inv.approval_settings set is_enabled = true where module = 'combo_sets';
      v_r := public.inv_save_combo_set(v_uid, null,
        jsonb_build_object('name','${MARK}審核ON','selling_price',50,'is_active',true),
        jsonb_build_array(jsonb_build_object('product_id', v_pid, 'quantity', 1)));
      insert into apprlog(step,detail) values ('審核開著時的初始狀態', v_r ->> 'approval_status');
      v_id := (v_r ->> 'id')::uuid;

      -- 而且改價要把它打回 pending（先核准再改價）
      perform public.inv_approve_record(v_uid,'combo_sets',v_id,true);
      v_r := public.inv_save_combo_set(v_uid, v_id,
        jsonb_build_object('name','${MARK}審核ON','selling_price',60,'is_active',true),
        jsonb_build_array(jsonb_build_object('product_id', v_pid, 'quantity', 1)));
      insert into apprlog(step,detail) values ('審核開著時改價後', v_r ->> 'approval_status');

      -- 改名字不算改價，不該把它打回 pending
      perform public.inv_approve_record(v_uid,'combo_sets',v_id,true);
      v_r := public.inv_save_combo_set(v_uid, v_id,
        jsonb_build_object('name','${MARK}審核ON改名','selling_price',60,'is_active',true),
        jsonb_build_array(jsonb_build_object('product_id', v_pid, 'quantity', 1)));
      insert into apprlog(step,detail) values ('審核開著時只改名', v_r ->> 'approval_status');

      -- (2) 審核關著 → 新套餐必須是 approved
      update inv.approval_settings set is_enabled = false where module = 'combo_sets';
      v_r := public.inv_save_combo_set(v_uid, null,
        jsonb_build_object('name','${MARK}審核OFF','selling_price',50,'is_active',true),
        jsonb_build_array(jsonb_build_object('product_id', v_pid, 'quantity', 1)));
      insert into apprlog(step,detail) values ('審核關著時的初始狀態', v_r ->> 'approval_status');

      -- 關著的時候改價**不該**把它打回 pending（不然等於偷偷開啟審核）
      v_r := public.inv_save_combo_set(v_uid, (v_r ->> 'id')::uuid,
        jsonb_build_object('name','${MARK}審核OFF','selling_price',70,'is_active',true),
        jsonb_build_array(jsonb_build_object('product_id', v_pid, 'quantity', 1)));
      insert into apprlog(step,detail) values ('審核關著時改價後', v_r ->> 'approval_status');

      -- (3) 呼叫端硬送 approval_status 也沒有用
      update inv.approval_settings set is_enabled = true where module = 'combo_sets';
      v_r := public.inv_save_combo_set(v_uid, null,
        jsonb_build_object('name','${MARK}硬送狀態','selling_price',50,'is_active',true,'approval_status','approved'),
        jsonb_build_array(jsonb_build_object('product_id', v_pid, 'quantity', 1)));
      insert into apprlog(step,detail) values ('payload 硬送 approved', v_r ->> 'approval_status');

      -- 還原店家的設定
      update inv.approval_settings set is_enabled = v_was where module = 'combo_sets';
      select is_enabled into v_was from inv.approval_settings where module = 'combo_sets';
      insert into apprlog(step,detail) values ('還原後的設定', v_was::text);
    end $selftest$;
    select seq, step, detail from apprlog order by seq;
  `);

  if (!both.ok) {
    fail += 1;
    console.log(red(`  ✗ 審核開關段失敗：${String(both.error).slice(0, 300)}`));
  } else {
    const m = new Map(both.rows.map((r) => [r.step, r.detail]));
    check("審核開著時，新套餐是 pending", m.get("審核開著時的初始狀態"), "pending");
    check("審核開著時，改組合價會打回 pending", m.get("審核開著時改價後"), "pending");
    check("但只改名字不會（改名不是改價）", m.get("審核開著時只改名"), "approved");
    check("審核關著時，新套餐直接 approved", m.get("審核關著時的初始狀態"), "approved");
    check("審核關著時，改價不會憑空變成待審", m.get("審核關著時改價後"), "approved");
    check(
      "payload 裡硬送 approval_status 完全無效（來源是在瀏覽器算完再送）",
      m.get("payload 硬送 approved"),
      "pending",
    );
    check("店家的 approval_settings 已還原", m.get("還原後的設定"), m.get("原始設定"));
  }

  // ── [10] 併發：兩個組成順序相反的套餐同時賣 ─────────────────────────────
  console.log("\n[10] 實測：兩個組成順序相反的套餐同時賣（鎖序）");

  const conc = await q(`
    create temp table if not exists conclog(seq serial, step text, detail text);
    truncate conclog;
    do $selftest$
    declare
      v_uid uuid; v_a uuid; v_b uuid; v_x uuid; v_y uuid; v_r jsonb;
      v_lock_order text; v_def_order text;
    begin
      select user_id into v_uid from inv.profiles limit 1;
      select id into v_a from inv.products where name = '${MARK}A';
      select id into v_b from inv.products where name = '${MARK}B';
      -- 前置沒建起來就大聲停在這裡。放著跑下去會拿 NULL 去建套餐，
      -- 錯誤訊息會變成「組成品項缺少商品」，把真正的原因蓋掉。
      if v_a is null or v_b is null then
        raise exception 'SELFTEST_PRECONDITION: [9] 的測試商品不存在，[10] 沒有前置可用';
      end if;

      -- 兩個套餐，組成品項的**寫入順序相反**
      v_r := public.inv_save_combo_set(v_uid, null,
        jsonb_build_object('name','${MARK}套餐X','selling_price',100,'is_active',true),
        jsonb_build_array(jsonb_build_object('product_id',v_a,'quantity',1),
                          jsonb_build_object('product_id',v_b,'quantity',1)));
      v_x := (v_r ->> 'id')::uuid;
      v_r := public.inv_save_combo_set(v_uid, null,
        jsonb_build_object('name','${MARK}套餐Y','selling_price',100,'is_active',true),
        jsonb_build_array(jsonb_build_object('product_id',v_b,'quantity',1),
                          jsonb_build_object('product_id',v_a,'quantity',1)));
      v_y := (v_r ->> 'id')::uuid;
      perform public.inv_approve_record(v_uid,'combo_sets',v_x,true);
      perform public.inv_approve_record(v_uid,'combo_sets',v_y,true);

      -- 兩個套餐**依 combo_set_items 的自然順序**看是不是真的相反
      select string_agg(product_id::text, ',' order by ctid) into v_def_order
        from inv.combo_set_items where combo_set_id = v_x;
      insert into conclog(step,detail) values ('X 的定義順序', v_def_order);
      select string_agg(product_id::text, ',' order by ctid) into v_def_order
        from inv.combo_set_items where combo_set_id = v_y;
      insert into conclog(step,detail) values ('Y 的定義順序', v_def_order);

      -- 兩個套餐**拿鎖的順序**（依 product_id 排序）必須一樣 —— 這是防死鎖的關鍵
      select string_agg(product_id::text, ',' order by product_id) into v_lock_order
        from inv.combo_set_items where combo_set_id = v_x;
      insert into conclog(step,detail) values ('X 的鎖序', v_lock_order);
      select string_agg(product_id::text, ',' order by product_id) into v_lock_order
        from inv.combo_set_items where combo_set_id = v_y;
      insert into conclog(step,detail) values ('Y 的鎖序', v_lock_order);

      perform public.inv_combo_checkout(v_uid, v_x, 1, CURRENT_DATE);
      perform public.inv_combo_checkout(v_uid, v_y, 1, CURRENT_DATE);
      insert into conclog(step,detail) values ('兩邊都賣得掉', 'yes');
    end $selftest$;
    select seq, step, detail from conclog order by seq;
  `);

  if (!conc.ok) {
    fail += 1;
    console.log(red(`  ✗ 併發前置失敗：${String(conc.error).slice(0, 300)}`));
  } else {
    const m = new Map(conc.rows.map((r) => [r.step, r.detail]));
    checkTrue(
      "兩個套餐的**定義順序**確實相反（否則這一段測不到東西）",
      m.get("X 的定義順序") !== m.get("Y 的定義順序") &&
        Boolean(m.get("X 的定義順序")) &&
        m.get("X 的定義順序").split(",").reverse().join(",") === m.get("Y 的定義順序"),
      `X=${m.get("X 的定義順序")} Y=${m.get("Y 的定義順序")}`,
    );
    check(
      "但兩個套餐的**鎖序**一樣（依 product_id）—— 這就是不會死鎖的原因",
      m.get("X 的鎖序"),
      m.get("Y 的鎖序"),
    );
    check("兩個套餐都賣得掉", m.get("兩邊都賣得掉"), "yes");
  }

  // 真的併發：兩個連線同時打，證明不是靠序列化才過的
  console.log("\n[10b] 實測：真的同時打兩個連線");
  const ids = await q(
    `select name, id from inv.combo_sets where name in ('${MARK}套餐X','${MARK}套餐Y');`,
  );
  const idX = ids.rows.find((r) => r.name === `${MARK}套餐X`)?.id;
  const idY = ids.rows.find((r) => r.name === `${MARK}套餐Y`)?.id;
  checkTrue("拿得到兩個套餐 id", Boolean(idX && idY));

  if (idX && idY) {
    const shots = [];
    for (let i = 0; i < 8; i += 1) {
      const target = i % 2 === 0 ? idX : idY;
      shots.push(
        q(`select public.inv_combo_checkout('${uid}'::uuid, '${target}'::uuid, 1, CURRENT_DATE);`),
      );
    }
    const results = await Promise.all(shots);
    const deadlocks = results.filter((r) => !r.ok && /deadlock/i.test(String(r.error))).length;
    const errors = results.filter((r) => !r.ok).length;
    check("8 個同時打的套餐結帳，死鎖 0 次", deadlocks, 0);
    check(
      "8 個同時打的套餐結帳，失敗 0 次",
      errors,
      0,
      JSON.stringify(results.find((r) => !r.ok)?.error ?? "").slice(0, 200),
    );

    // 帳要對得起來：X 賣 1+4、Y 賣 1+4，兩件商品各再扣 10
    const after = await q(`
      select string_agg(stock_quantity::text, '/' order by name) st
      from inv.products where name in ('${MARK}A','${MARK}B');`);
    check("A/B 的庫存精確扣到 89/89（1+1+4+4 = 10 份）", after.rows[0]?.st, "89/89");
  }

  // ── [11] 二手書 ─────────────────────────────────────────────────────────
  console.log("\n[11] 實測：二手書入帳與 CHECK");

  const sh = await q(`
    create temp table if not exists shlog(seq serial, step text, detail text);
    truncate shlog;
    do $selftest$
    declare v_uid uuid; v_r jsonb; v_pid uuid; v_n int; v_stock int;
    begin
      select user_id into v_uid from inv.profiles limit 1;
      select id into v_pid from inv.products where name = '${MARK}A';
      if v_pid is null then
        raise exception 'SELFTEST_PRECONDITION: [9] 的測試商品不存在，CHECK 這一段沒有真商品可用';
      end if;
      select stock_quantity into v_stock from inv.products where id = v_pid;

      v_r := public.inv_secondhand_checkout(v_uid, '${MARK}舊書', 1, 150, CURRENT_DATE);
      insert into shlog(step,detail) values ('二手金額', v_r ->> 'amount');

      select count(*) into v_n from inv.sales
        where item_name = '${MARK}舊書' and product_id is null and cost_price is null and is_secondhand;
      insert into shlog(step,detail) values ('形狀正確的二手列', v_n::text);

      -- 庫存一格都不能動
      select stock_quantity into v_n from inv.products where id = v_pid;
      insert into shlog(step,detail) values ('庫存有沒有被動到', (v_n - v_stock)::text);

      -- CHECK：真商品不可以當二手賣（那會靜默跳過扣庫存）
      begin
        -- item_name 也帶 MARK：這一列**應該**被 CHECK 擋掉，但萬一哪天 CHECK 失效，
        -- cleanup 仍然掃得到它。測試自己不可以在正式庫留垃圾。
        insert into inv.sales(user_id,product_id,is_secondhand,item_name,quantity,unit_price,amount,sale_date)
          values (v_uid, v_pid, true, '${MARK}不該存在', 1, 100, 100, CURRENT_DATE);
        insert into shlog(step,detail) values ('CHECK', '沒有被擋下');
      exception when others then
        insert into shlog(step,detail) values ('CHECK', left(SQLERRM, 200));
      end;
    end $selftest$;
    select seq, step, detail from shlog order by seq;
  `);

  if (!sh.ok) {
    fail += 1;
    console.log(red(`  ✗ 二手書段失敗：${String(sh.error).slice(0, 300)}`));
  } else {
    const m = new Map(sh.rows.map((r) => [r.step, r.detail]));
    check("二手書金額 = 單價 × 數量", Number(m.get("二手金額")), 150);
    check("二手列的形狀：product_id 與 cost_price 都是 NULL", Number(m.get("形狀正確的二手列")), 1);
    check("二手書沒有動到任何庫存", Number(m.get("庫存有沒有被動到")), 0);
    checkTrue(
      "CHECK 擋住「拿真商品當二手賣」",
      String(m.get("CHECK") ?? "").includes("sales_secondhand_has_no_product"),
      m.get("CHECK"),
    );
  }

  // ── [12] 刪除守衛 ───────────────────────────────────────────────────────
  console.log("\n[12] 實測：有銷售紀錄的套餐不可刪");
  if (idX) {
    const del = await q(`select public.inv_delete_combo_set('${idX}'::uuid);`);
    checkTrue(
      "有銷售紀錄的套餐刪不掉，而且訊息叫人改成停用",
      !del.ok && String(del.error).includes("COMBO_HAS_SALES"),
      String(del.error).slice(0, 160),
    );
  }

  // ── [13] 清乾淨，基準線一筆不差 ─────────────────────────────────────────
  console.log("\n[13] 實測：測試資料全刪，基準線一筆不差");
  await cleanup();

  const after = await q(`
    select (select count(*)::int from inv.products) p,
           (select count(*)::int from inv.purchases) pu,
           (select count(*)::int from inv.sales) s,
           (select count(*)::int from inv.stock_adjustments) sa,
           (select count(*)::int from inv.inventory_adjustments) ia,
           (select count(*)::int from inv.combo_sets) cs,
           (select count(*)::int from inv.combo_set_items) ci,
           (select count(*)::int from public.publications) pub,
           (select count(*)::int from public.products) pp,
           (select count(*)::int from inv.products where name like '${MARK}%') leftover_p,
           (select count(*)::int from inv.combo_sets where name like '${MARK}%') leftover_c,
           (select count(*)::int from inv.sales where item_name like '${MARK}%') leftover_s;`);
  const a = after.rows[0] ?? {};

  check("inv.products 回到基準線", a.p, base.p);
  check("inv.purchases 回到基準線", a.pu, base.pu);
  check("inv.sales 回到基準線", a.s, base.s);
  check("inv.stock_adjustments 沒有被動到", a.sa, base.sa);
  check("inv.inventory_adjustments 沒有被動到（已凍結）", a.ia, base.ia);
  check("inv.combo_sets 回到基準線", a.cs, base.cs);
  check("inv.combo_set_items 回到基準線", a.ci, base.ci);
  check("public.publications 沒有被動到", a.pub, base.pub);
  check("public.products 沒有被動到", a.pp, base.pp);
  check("沒有殘留的測試商品", a.leftover_p, 0);
  check("沒有殘留的測試套餐", a.leftover_c, 0);
  check("沒有殘留的測試二手書", a.leftover_s, 0);

  // 正式庫的絕對數字。基準線比對只證明「跑完前後一樣」，這一段證明「一樣的那個
  // 數字是對的」—— 兩者都要，否則測試在一個已經被弄壞的資料庫上也會全綠。
  console.log("\n[13b] 正式庫的絕對筆數");
  check("inv.products = 993", a.p, 993);
  check("inv.purchases = 1029", a.pu, 1029);
  check("inv.sales = 665", a.s, 665);
  check("inv.stock_adjustments = 50", a.sa, 50);
  check("inv.inventory_adjustments = 30", a.ia, 30);
  check("public.publications = 126", a.pub, 126);
  check("public.products = 19", a.pp, 19);

  // ── 歷史資料沒有被改寫 ────────────────────────────────────────────────
  const hist = await q(`
    select count(*)::int n,
           count(*) filter (where amount = 0)::int zero
      from inv.sales where combo_set_id is not null;`);
  check("215 筆歷史套餐銷售還在（不改寫歷史）", hist.rows[0]?.n, 215);
  check("而且它們仍是舊口徑（114 列零營收）", hist.rows[0]?.zero, 114);
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
