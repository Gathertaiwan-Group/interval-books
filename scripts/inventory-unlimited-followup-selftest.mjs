#!/usr/bin/env node
/**
 * inventory-unlimited-followup-selftest.mjs —— 「不限庫存」（0062）驗收後的三個修正＋防呆
 *
 *   [1] 在庫異動選得到不限庫存品項：repos/inv-adjustments.ts#listStockCountProducts 的
 *       excludeUnlimited 參數（省略＝排除；false＝不排除；low_stock_only 一律排除），
 *       在庫異動的商品選單傳 false，盤點頁／批次盤點／MCP low_stock_only 不傳。
 *   [2] 廠商面不顯示負庫存：0063（inv_vendor_products 尾端加 unlimited_stock、
 *       inv_admin_vendor_list 的 stock_units 排除不限庫存並尾端加 unlimited_product_count），
 *       repo 讀新欄位、廠商入口顯示「不限量」、廠商詳情註明另有幾件不限量。
 *   [3] 批次修改／匯入撞 products_unlimited_stock_consignment_only → 中文訊息（repo 層對應）。
 *   [4] 防呆：不限庫存＋成本 0 → 提醒（不擋）。
 *
 * 用假的 supabaseAdmin 跑 production 的 repo 本人（不連資料庫）。
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15（module.registerHooks）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/inventory-unlimited-followup-selftest.mjs";
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
const checkTrue = (label, cond) => check(label, Boolean(cond), true);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ── 假的 Supabase：記下每一趟查詢的 select 欄位與 eq 條件；rpc 回傳設定好的錯誤 ──
const log = { queries: [], rpc: [] };
let rows = [];
let rpcError = null;
function builder(table) {
  const q = { table, select: null, eq: [] };
  log.queries.push(q);
  const pass_ = () => b;
  const b = {
    select: (cols) => ((q.select = cols), b),
    order: pass_,
    or: pass_,
    range: pass_,
    limit: pass_,
    eq: (c, v) => (q.eq.push([c, v]), b),
    then(resolve) {
      const data = rows.filter((r) => q.eq.every(([c, v]) => r[c] === v));
      resolve({ data, error: null, count: data.length });
    },
  };
  return b;
}
globalThis.__fakeSupabase = {
  from: (t) => builder(t),
  rpc: async (name, args) => {
    log.rpc.push({ name, args });
    return rpcError ? { data: null, error: rpcError } : { data: [], error: null };
  },
};
function resolveTs(base) {
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand)) return pathToFileURL(cand).href;
  }
  return null;
}
const FAKE_ADMIN =
  "data:text/javascript," +
  encodeURIComponent("export const supabaseAdmin = () => globalThis.__fakeSupabase;");
const REAL_ADMIN = resolveTs(join(SRC, "server/supabase-admin"));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@/server/supabase-admin") return { url: FAKE_ADMIN, shortCircuit: true };
    if (spec === "@tanstack/react-start/server-only")
      return { url: "data:text/javascript,", shortCircuit: true };
    if (spec.startsWith("@/")) {
      const url = resolveTs(join(SRC, spec.slice(2)));
      if (url) return { url, shortCircuit: true };
    }
    if (spec.startsWith(".") && !/\.[a-zA-Z]+$/.test(spec) && ctx.parentURL) {
      const url = resolveTs(fileURLToPath(new URL(spec, ctx.parentURL)));
      if (url && url === REAL_ADMIN) return { url: FAKE_ADMIN, shortCircuit: true };
      if (url) return { url, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const adj = await import(join(SRC, "server/repos/inv-adjustments.ts"));
const prod = await import(join(SRC, "server/repos/inv-products.ts"));
const { unlimitedStockZeroCostWarning } = await import(join(SRC, "lib/admin/unlimited-stock.ts"));

const base = (over) => ({
  inv_product_id: "p",
  name: "n",
  issue_number: null,
  series: null,
  barcode: null,
  product_type: "consignment",
  stock_quantity: 0,
  low_stock_alert: 5,
  cost_price: 10,
  category_id: null,
  category_name: null,
  is_active: true,
  approval_status: "approved",
  unlimited_stock: false,
  ...over,
});
const FILTER = {
  keyword: null,
  categoryId: null,
  productType: null,
  lowStockOnly: false,
  page: 0,
  pageSize: 50,
};

console.log("\n[1] listStockCountProducts：excludeUnlimited");
{
  rows = [
    base({ inv_product_id: "normal", stock_quantity: 3 }),
    base({ inv_product_id: "unl", stock_quantity: -4, unlimited_stock: true }),
  ];
  log.queries = [];
  const dflt = await adj.listStockCountProducts(FILTER);
  check(
    "省略（盤點頁）：排除不限庫存",
    dflt.rows.map((r) => r.inv_product_id),
    ["normal"],
  );
  checkTrue(
    "省略：查詢帶 unlimited_stock=false",
    log.queries[0].eq.some(([c, v]) => c === "unlimited_stock" && v === false),
  );
  checkTrue("select 帶回 unlimited_stock 欄", /unlimited_stock/.test(log.queries[0].select));

  log.queries = [];
  const all = await adj.listStockCountProducts({ ...FILTER, excludeUnlimited: false });
  check(
    "excludeUnlimited=false（在庫異動）：選得到不限庫存品項",
    all.rows.map((r) => r.inv_product_id).sort(),
    ["normal", "unl"],
  );
  check(
    "excludeUnlimited=false：不帶 unlimited_stock 條件",
    log.queries[0].eq.filter(([c]) => c === "unlimited_stock").length,
    0,
  );

  log.queries = [];
  const low = await adj.listStockCountProducts({
    ...FILTER,
    lowStockOnly: true,
    excludeUnlimited: false,
  });
  check(
    "low_stock_only：就算傳 false 也排除不限庫存",
    low.rows.map((r) => r.inv_product_id),
    ["normal"],
  );
}

console.log("\n[1b] 呼叫端：只有在庫異動傳 excludeUnlimited: false");
{
  const dialog = read("src/components/inventory/AdjustmentFormDialog.tsx");
  checkTrue(
    "AdjustmentFormDialog 傳 excludeUnlimited: false",
    /excludeUnlimited:\s*false/.test(dialog),
  );
  for (const f of [
    "src/routes/admin/_shell.inventory-count.tsx",
    "src/components/inventory/BatchStockCountDialog.tsx",
    "src/server/mcp/admin-read-tools.ts",
  ]) {
    checkTrue(
      `${f} 沒有關掉排除（盤點／low_stock_only 維持排除）`,
      !/excludeUnlimited/.test(read(f)),
    );
  }
  const fields = read("src/components/inventory/AdjustmentFormFields.tsx");
  checkTrue(
    "異動表單的商品選單對不限庫存顯示「不限量」",
    /unlimited_stock \? "（不限量）"/.test(fields),
  );
  checkTrue(
    "異動表單不對不限庫存品項預告負庫存",
    /selected && !selected\.unlimited_stock/.test(fields),
  );
  checkTrue(
    "server fn 的 schema 收 excludeUnlimited（選填）",
    /excludeUnlimited: z\.boolean\(\)\.optional\(\)/.test(
      read("src/lib/admin/fns/inv-adjustments.ts"),
    ),
  );
}

console.log("\n[2] 0063：廠商面的不限庫存");
{
  const sql = read("supabase/migrations/0063_vendor_views_unlimited_stock.sql");
  const code = sql.replace(/--[^\n]*/g, "");
  checkTrue(
    "RETURNS TABLE 改形狀：先 drop 再 create",
    /drop function if exists public\.inv_vendor_products\(uuid\)/.test(code),
  );
  checkTrue(
    "inv_vendor_products 回傳表最後一欄是 unlimited_stock boolean",
    /listed_status\s+text,\s*unlimited_stock\s+boolean\s*\)/.test(code),
  );
  checkTrue(
    "inv_vendor_products 仍是 SECURITY DEFINER、search_path 不變",
    /security definer\s+set search_path = public, inv/.test(code),
  );
  checkTrue(
    "inv_vendor_products 仍由 vendor_my_id 推導廠商",
    /WHERE p\.vendor_id = v_vendor_id/.test(code),
  );
  checkTrue(
    "inv_vendor_products：revoke public／anon／authenticated、只給 service_role",
    /revoke execute on function public\.inv_vendor_products\(uuid\) from public;/.test(code) &&
      /revoke execute on function public\.inv_vendor_products\(uuid\) from anon, authenticated;/.test(
        code,
      ) &&
      /grant\s+execute on function public\.inv_vendor_products\(uuid\) to service_role;/.test(code),
  );
  checkTrue(
    "inv_admin_vendor_list 明寫 security_invoker = false",
    /inv_admin_vendor_list\s+with \(security_invoker = false\)/.test(code),
  );
  checkTrue(
    "stock_units 只加總非不限庫存品項",
    /sum\(p\.stock_quantity\) filter \(where not p\.unlimited_stock\)/.test(code),
  );
  checkTrue(
    "unlimited_product_count 加在 view 最尾端（portal_account_count 之後）",
    /portal_account_count,\s*coalesce\(agg\.unlimited_product_count, 0\) as unlimited_product_count\s+from inv\.vendors/.test(
      code,
    ),
  );
  checkTrue(
    "view 權限照 0019：revoke anon／authenticated、只給 service_role",
    /revoke all on public\.inv_admin_vendor_list from public, anon, authenticated;/.test(code) &&
      /grant select on public\.inv_admin_vendor_list to service_role;/.test(code),
  );
  checkTrue("包在交易裡", /^\s*begin;/m.test(code) && /^\s*commit;/m.test(code));

  const repo = read("src/server/repos/inv-vendors.ts");
  checkTrue(
    "廠商列表欄位讀 unlimited_product_count",
    /portal_account_count, unlimited_product_count"/.test(repo),
  );
  checkTrue("VendorPortalProduct 有 unlimited_stock", /unlimited_stock: boolean;\n\};/.test(repo));
  const table = read("src/components/vendor/VendorProductTable.tsx");
  checkTrue("廠商入口：不限庫存顯示「不限量」", /row\.unlimited_stock\s*\?\s*"不限量"/.test(table));
  const detail = read("src/components/inventory/VendorDetailView.tsx");
  checkTrue(
    "廠商詳情：註明另有幾件不限量",
    /另有 \{row\.unlimited_product_count\} 件不限量/.test(detail),
  );
}

console.log("\n[3] 批次修改／匯入撞 CHECK → 中文");
{
  const pgMsg =
    'new row for relation "products" violates check constraint "products_unlimited_stock_consignment_only"';
  rpcError = { code: "23514", message: pgMsg };
  let msg = null;
  try {
    await prod.batchUpdateProducts({
      userId: "u",
      ids: ["a"],
      patch: { product_type: "outright" },
    });
  } catch (e) {
    msg = e.message;
  }
  check("批次修改：換成中文", msg, prod.UNLIMITED_CHECK_BATCH_MESSAGE);
  checkTrue("批次修改訊息沒有英文原文", msg && !/violates|constraint/.test(msg));
  checkTrue("批次修改訊息講到不限庫存與下一步", /不限庫存/.test(msg) && /關閉/.test(msg));

  msg = null;
  try {
    await prod.importProducts({ userId: "u", rows: [], options: {} });
  } catch (e) {
    msg = e.message;
  }
  check("匯入：換成中文", msg, prod.UNLIMITED_CHECK_IMPORT_MESSAGE);

  rpcError = { code: "P0001", message: "INV_BATCH_EMPTY: 沒有勾選任何商品" };
  msg = null;
  try {
    await prod.batchUpdateProducts({ userId: "u", ids: [], patch: {} });
  } catch (e) {
    msg = e.message;
  }
  check("其他錯誤照舊剝掉前綴", msg, "沒有勾選任何商品");
  rpcError = null;
}

console.log("\n[4] 防呆：不限庫存＋成本 0");
{
  const w = (unlimited_stock, cost_price) =>
    unlimitedStockZeroCostWarning({ unlimited_stock, cost_price }) !== null;
  check("不限庫存＋成本 0 → 提醒", w(true, 0), true);
  check("不限庫存＋成本沒填（null）→ 提醒", w(true, null), true);
  check("不限庫存＋表單空字串 → 提醒", w(true, ""), true);
  check('不限庫存＋表單 "0" → 提醒', w(true, "0"), true);
  check("不限庫存＋成本 80 → 不提醒", w(true, 80), false);
  check('不限庫存＋表單 "80" → 不提醒', w(true, "80"), false);
  check("一般品項成本 0 → 不提醒", w(false, 0), false);
  checkTrue(
    "後台表單 UnlimitedStockField 用同一支提醒",
    /unlimitedStockZeroCostWarning/.test(read("src/components/inventory/UnlimitedStockField.tsx")),
  );
  checkTrue(
    "MCP create／update 預覽用同一支提醒",
    /unlimitedStockZeroCostWarning/.test(read("src/server/mcp/ops-write-tools.ts")) &&
      /unlimitedStockZeroCostWarning/.test(read("src/server/mcp/catalog-inventory-tools.ts")),
  );
}

console.log(`\n${fail === 0 ? green("全部通過") : red("有失敗")}：pass=${pass} fail=${fail}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
