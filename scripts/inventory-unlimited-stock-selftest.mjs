#!/usr/bin/env node
/**
 * inventory-unlimited-stock-selftest.mjs —— 0062 進銷存「不限庫存」旗標的自檢
 *
 *   [1] 純邏輯：src/lib/admin/low-stock.ts 的 isLowStock（Node 原生型別剝離直接 import）。
 *   [2] 靜態：0062 migration 的形狀——欄位＋CHECK、七支函式都有不限庫存分支而且一般品項
 *       的錯誤碼照舊、product_availability 欄位形狀不變、view 只在尾端加欄、權限重申。
 *   [3] 靜態：程式碼——表單／schema／MCP／櫃檯／盤點都接上 unlimited_stock。
 *   [4] 行為（選擇性）：設了 UNLIMITED_SELFTEST_PG_URL 就對那個資料庫跑
 *       scripts/fixtures/inventory-unlimited-stock/*.sql（每支都在交易裡 rollback，不留資料），
 *       輸出與 *.expected.txt 逐字比對。
 *       · regress.sql：一般品項（買斷／一般寄賣）的保留、櫃檯、套餐、網路入帳、盤點、成本——
 *         它的 expected 是在**套 0062 之前**錄的，所以「套了之後逐字相同」＝一般商品行為不變。
 *       · unlimited.sql／cand.sql：不限庫存品項不被擋、不寫告警、成本用 cost_price、盤點略過、
 *         旗標只限寄賣母品項。
 *       那個資料庫要是正式庫 schema 的副本（supabase/consolidation/api_ddl.py 產的 schema-only
 *       dump 載進本機 Postgres 再套 0062）。**絕對不要指向正式庫**——雖然每支都 rollback，
 *       這支測試的規矩是不在正式庫造資料。沒設就 skip（會印出來）。
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/inventory-unlimited-stock-selftest.mjs";
const FIX = join(ROOT, "scripts/fixtures/inventory-unlimited-stock");

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
const checkTrue = (label, v) => check(label, v === true, true);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripSql = (s) => s.replace(/--.*$/gm, "");
const stripTs = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

/** 取出 migration 裡某支函式的本體（到下一個 CREATE OR REPLACE／create or replace 為止）。 */
function fnBody(sql, name) {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION ${name.replace(".", "\\.")}\\(`, "i");
  const m = re.exec(sql);
  if (!m) return "";
  const rest = sql.slice(m.index + 10);
  const next = rest.search(/create or replace (function|view)/i);
  return next === -1 ? rest : rest.slice(0, next);
}

// -----------------------------------------------------------------------------
console.log("\n[1] 純邏輯：isLowStock");
const LS = await import(pathToFileURL(join(ROOT, "src/lib/admin/low-stock.ts")).href);
check(
  "一般品項：庫存 ≤ 警示 → 低庫存",
  LS.isLowStock({ stock_quantity: 3, low_stock_alert: 5 }),
  true,
);
check(
  "一般品項：庫存 > 警示 → 不是",
  LS.isLowStock({ stock_quantity: 6, low_stock_alert: 5 }),
  false,
);
check("警示 0 → 不警示", LS.isLowStock({ stock_quantity: 0, low_stock_alert: 0 }), false);
check(
  "🔴 不限庫存：庫存 0（甚至負數）也不算低庫存",
  LS.isLowStock({ stock_quantity: -12, low_stock_alert: 5, unlimited_stock: true }),
  false,
);
check(
  "unlimited_stock=false 與沒帶一樣",
  LS.isLowStock({ stock_quantity: 1, low_stock_alert: 5, unlimited_stock: false }),
  true,
);

// -----------------------------------------------------------------------------
console.log("\n[2] 靜態：0062 migration");
const MIG = "supabase/migrations/0062_inventory_unlimited_stock.sql";
const raw = read(MIG);
const sql = stripSql(raw);
checkTrue(
  "包在 begin; … commit; 裡",
  /^\s*begin;/m.test(sql) && /commit;\s*$/.test(sql.trim() + "\n"),
);
checkTrue(
  "inv.products 加 unlimited_stock boolean not null default false（if not exists，冪等）",
  /add column if not exists unlimited_stock boolean not null default false/i.test(sql),
);
checkTrue(
  "CHECK：只限寄賣、非子品項",
  /check \(not unlimited_stock or \(product_type = 'consignment' and base_product_id is null\)\)/i.test(
    sql,
  ),
);
checkTrue(
  "CHECK 先 drop if exists 再加（冪等）",
  /drop constraint if exists products_unlimited_stock_consignment_only/i.test(sql),
);

const fns = {
  "public.reserve_inventory_stock": ["INSUFFICIENT_STOCK", "not v_row.unlimited_stock"],
  "public.commit_inventory_reservations": ["stock_oversold_alerts", "unlimited_stock"],
  "inv.update_stock_on_sale": ["INSUFFICIENT_STOCK", "pos_override", "v_unlimited"],
  "public.pos_checkout": ["POS_INSUFFICIENT_STOCK", "coalesce(v_unlimited, false)"],
  "inv.allocate_fifo_cost": ["remaining_quantity > 0", "v_target_cost"],
  "public.inv_record_stock_count": ["unlimited_skipped", "COUNT_BAD_QUANTITY"],
  "public.inv_save_product": ["PRODUCT_UNLIMITED_CONSIGNMENT_ONLY", "PRODUCT_UNLIMITED_NO_BASE"],
};
for (const [name, needles] of Object.entries(fns)) {
  const body = fnBody(sql, name);
  checkTrue(`${name}：有重建`, body.length > 0);
  for (const n of needles) checkTrue(`${name}：含「${n}」`, body.includes(n));
}
// 簽名沒變 → 不必 DROP（RETURNS TABLE／OUT 參數改形狀才需要）。
for (const [name, ret] of [
  ["public.reserve_inventory_stock", "RETURNS integer"],
  ["public.commit_inventory_reservations", "RETURNS integer"],
  ["public.pos_checkout", "RETURNS jsonb"],
  ["public.inv_record_stock_count", "RETURNS jsonb"],
  ["public.inv_save_product", "RETURNS jsonb"],
  ["inv.allocate_fifo_cost", "RETURNS numeric"],
  ["inv.update_stock_on_sale", "RETURNS trigger"],
]) {
  checkTrue(`${name}：回傳型別仍是 ${ret}`, fnBody(sql, name).includes(ret));
}
checkTrue(
  "🔴 一般品項的櫃檯擋超賣仍在（update_stock_on_sale 的 ELSIF 分支）",
  /ELSIF COALESCE\(NEW\.channel, 'pos'\) = 'pos'\s+AND COALESCE\(NEW\.override_reservation, false\) = false THEN\s+IF v_available < v_deduct_quantity THEN/.test(
    fnBody(sql, "inv.update_stock_on_sale"),
  ),
);
checkTrue(
  "不限庫存仍照扣 stock_quantity（刪銷售的回補才對稱）",
  /UPDATE inv\.products\s+SET stock_quantity = stock_quantity - v_deduct_quantity/.test(
    fnBody(sql, "inv.update_stock_on_sale"),
  ),
);

const pa = /create or replace view public\.product_availability[\s\S]*?;\n/i.exec(sql)?.[0] ?? "";
checkTrue("product_availability 有重建", pa.length > 0);
check(
  "product_availability 欄位形狀不變（anon 讀的 view，只有三欄）",
  [...pa.matchAll(/\bAS (product_id|in_stock|available_capped|unlimited\w*)\b/g)].map((m) => m[1]),
  ["product_id", "in_stock", "available_capped"],
);
checkTrue("product_availability：不限庫存目標回 10", /unlimited_stock, false\)\) THEN 10/.test(pa));
checkTrue(
  "inv_listing_candidates：庫存 0 的不限庫存品項可上架",
  /\(\(stock_quantity > 0\) OR unlimited_stock\)/.test(sql),
);
for (const v of [
  "inv_listed_products",
  "inv_admin_products",
  "inv_pos_products",
  "inv_listing_candidates",
  "inv_admin_combo_set_items",
  "inv_admin_combo_sets",
  "product_availability",
]) {
  checkTrue(
    `${v}：明寫 security_invoker = false（replace 會重設 reloptions）`,
    new RegExp(
      `create or replace view public\\.${v} with \\(security_invoker = false\\)`,
      "i",
    ).test(sql),
  );
}
checkTrue(
  "重申 view 權限只給 service_role",
  /grant select on public\.inv_listed_products[\s\S]*?to service_role;/i.test(sql),
);
checkTrue(
  "重申函式權限只給 service_role",
  /grant execute on function public\.pos_checkout\(uuid, jsonb, uuid, date, text, boolean\) to service_role;/i.test(
    sql,
  ),
);

// -----------------------------------------------------------------------------
console.log("\n[3] 靜態：程式碼接線");
const schemas = stripTs(read("src/lib/admin/schemas.ts"));
checkTrue(
  "invProductSchema 有 unlimited_stock（optional＝沒帶不改）",
  /unlimited_stock: z\.boolean\(\)\.optional\(\)/.test(schemas),
);
checkTrue("schema 先擋非寄賣", schemas.includes("只有寄賣品可以設定不限庫存"));
checkTrue("schema 先擋子品項", schemas.includes("子品項不能設定不限庫存"));
const repo = read("src/server/repos/inv-products.ts");
checkTrue(
  "inv_admin_products 的欄位清單含 unlimited_stock",
  /listed_status, unlimited_stock"/.test(repo),
);
const fields = stripTs(read("src/components/inventory/ProductFormFields.tsx"));
checkTrue("商品表單掛上 UnlimitedStockField", /<UnlimitedStockField form=\{form\}/.test(fields));
const ulField = stripTs(read("src/components/inventory/UnlimitedStockField.tsx"));
checkTrue(
  "「不限庫存」勾選只在寄賣時出現",
  /if \(form\.product_type !== "consignment"\) return null;/.test(ulField),
);
checkTrue("子品項的勾選停用", /disabled=\{isChild\}/.test(ulField));
const adj = stripTs(read("src/server/repos/inv-adjustments.ts"));
checkTrue("盤點清單排除不限庫存品項", /\.eq\("unlimited_stock", false\)/.test(adj));
const cat = stripTs(read("src/server/mcp/catalog-inventory-tools.ts"));
checkTrue(
  "MCP update_inventory_product 收 unlimited_stock",
  /"unlimited_stock",\n\] as const;/.test(cat) && /unlimited_stock: z\s*\.boolean\(\)/.test(cat),
);
const ops = stripTs(read("src/server/mcp/ops-write-tools.ts"));
checkTrue(
  "MCP create_inventory_product 收 unlimited_stock",
  /unlimited_stock: args\.unlimited_stock/.test(ops),
);
checkTrue("MCP record_stock_count 擋不限庫存品項", ops.includes("不限庫存」品項，不盤點"));
const reads = stripTs(read("src/server/mcp/admin-read-tools.ts"));
checkTrue(
  "MCP list_inventory 回傳 unlimited_stock",
  /unlimited_stock: r\.unlimited_stock === true/.test(reads),
);
const checkout = stripTs(read("src/components/pos/CheckoutPanel.tsx"));
checkTrue(
  "櫃檯結帳不把不限庫存算進超賣",
  /!l\.product\.unlimited_stock && l\.quantity > l\.product\.available/.test(checkout),
);
const ledger = read("scripts/lib/migration-ledger.mjs");
checkTrue("帳本登記了 0062", ledger.includes('file: "0062_inventory_unlimited_stock.sql"'));

// -----------------------------------------------------------------------------
console.log("\n[4] 行為（本機 Postgres，選擇性）");
const PG = process.env.UNLIMITED_SELFTEST_PG_URL;
if (!PG) {
  skipped.push(
    "行為測試（缺 UNLIMITED_SELFTEST_PG_URL；要一個載了正式 schema＋0062 的本機資料庫）",
  );
} else if (/supabase\.(co|com)/.test(PG)) {
  fail += 1;
  console.log(red("  ✗ UNLIMITED_SELFTEST_PG_URL 指向 Supabase——這支只准跑本機副本"));
} else {
  for (const name of ["regress", "unlimited", "cand"]) {
    const r = spawnSync("psql", [PG, "-X", "-q", "-f", join(FIX, `${name}.sql`)], {
      cwd: FIX,
      encoding: "utf8",
    });
    const got = (r.stdout ?? "") + (r.stderr ?? "");
    const want = readFileSync(join(FIX, `${name}.expected.txt`), "utf8");
    check(`${name}.sql 輸出與 ${name}.expected.txt 逐字相同`, got, want);
  }
}

if (skipped.length) {
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
