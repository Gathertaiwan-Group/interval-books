#!/usr/bin/env node
/**
 * read-all-pages-selftest.mjs —— PostgREST db-max-rows（1000）靜默截斷的修正（2026-11-03 審查 49be28a）
 *
 *   [1] readAllPages 本人：2500 列、剛好 1000／2000 列、錯誤、安全上限
 *   [2] 低庫存唯一定義 isLowStock：警示值 > 5 的品項不能漏
 *   [3] 用假的 supabaseAdmin（每次最多回 1000 列、會套 range／eq）直接跑 production 函式：
 *       summarisePosSales、countRegistrationsBySession、listEventSessions／Plans、
 *       listStockCountProducts(lowStockOnly)、MCP get_sales_summary
 *   [4] 靜態：那幾支不再寫 .limit(20000)、盤點不再粗篩 stock_quantity <= 5
 *
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15（module.registerHooks）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/read-all-pages-selftest.mjs";
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
const readFile = (p) => {
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};

// ── 假的 Supabase：記錄 eq 篩選、每次最多回 1000 列（模擬 db-max-rows）──────────
const MAX = 1000;
const tables = new Map();
let calls = 0;
function builder(table) {
  const filters = [];
  let range = null;
  const b = {
    select: () => b,
    order: () => b,
    eq: (col, v) => (filters.push((r) => r[col] === v), b),
    neq: (col, v) => (filters.push((r) => r[col] !== v), b),
    gte: () => b,
    lte: () => b,
    lt: () => b,
    gt: () => b,
    is: () => b,
    not: () => b,
    in: () => b,
    or: () => b,
    limit: () => b,
    range: (a, z) => ((range = [a, z]), b),
    maybeSingle: () => ({
      then: (res) => res({ data: (tables.get(table) ?? [])[0] ?? null, error: null }),
    }),
    then(resolve, reject) {
      calls += 1;
      try {
        const all = (tables.get(table) ?? []).filter((r) => filters.every((f) => f(r)));
        const [a, z] = range ?? [0, all.length - 1];
        const data = all.slice(a, Math.min(z + 1, a + MAX));
        resolve({ data, error: null, count: all.length });
      } catch (e) {
        reject(e);
      }
    },
  };
  return b;
}
globalThis.__fakeSupabase = { from: (t) => builder(t) };

function resolveTs(base) {
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand)) return pathToFileURL(cand).href;
  }
  return null;
}
const FAKE_ADMIN =
  "data:text/javascript," +
  encodeURIComponent("export const supabaseAdmin = () => globalThis.__fakeSupabase;");
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
      if (url) return { url, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

console.log("═══ PostgREST 1000 列上限修正 自檢 ═══");

// [1] ------------------------------------------------------------------------
console.log("\n[1] readAllPages");
const { readAllPages, POSTGREST_MAX_ROWS } = await import(
  join(SRC, "server/repos/read-all-pages.ts")
);
check("db-max-rows 常數 = 1000", POSTGREST_MAX_ROWS, 1000);
async function fakeSource(n) {
  const rows = Array.from({ length: n }, (_, i) => ({ i }));
  let n2 = 0;
  const out = await readAllPages(async (a, z) => {
    n2 += 1;
    return { data: rows.slice(a, Math.min(z + 1, a + MAX)), error: null };
  });
  return { len: out.length, last: out.at(-1)?.i ?? null, calls: n2 };
}
check("2500 列 → 全部讀回、3 趟", await fakeSource(2500), { len: 2500, last: 2499, calls: 3 });
check("剛好 1000 列 → 1000、2 趟（第二趟空）", await fakeSource(1000), {
  len: 1000,
  last: 999,
  calls: 2,
});
check("剛好 2000 列 → 2000", (await fakeSource(2000)).len, 2000);
check("0 列 → 0、1 趟", await fakeSource(0), { len: 0, last: null, calls: 1 });
let thrown = null;
try {
  await readAllPages(async () => ({ data: null, error: { code: "42P01", message: "x" } }), {
    label: "t",
  });
} catch (e) {
  thrown = e.message;
}
check("錯誤 → 丟例外（不回空陣列）", typeof thrown === "string" && thrown.includes("42P01"), true);
thrown = null;
try {
  await readAllPages(async (a, z) => ({ data: Array(z - a + 1).fill(0), error: null }), {
    maxRows: 2500,
  });
} catch (e) {
  thrown = e.message;
}
check("無止盡的來源 → 超過安全上限丟例外", typeof thrown === "string", true);

// [2] ------------------------------------------------------------------------
console.log("\n[2] isLowStock");
const { isLowStock } = await import(join(SRC, "lib/admin/low-stock.ts"));
check(
  "警示 10、庫存 8 → 低庫存（> 5 也要抓到）",
  isLowStock({ stock_quantity: 8, low_stock_alert: 10 }),
  true,
);
check("警示 5、庫存 5 → 低庫存", isLowStock({ stock_quantity: 5, low_stock_alert: 5 }), true);
check("警示 5、庫存 6 → 不是", isLowStock({ stock_quantity: 6, low_stock_alert: 5 }), false);
check("警示 0（租借）→ 不警示", isLowStock({ stock_quantity: 0, low_stock_alert: 0 }), false);
check("警示 null → 不警示", isLowStock({ stock_quantity: 0, low_stock_alert: null }), false);

// [3] ------------------------------------------------------------------------
console.log("\n[3] production 函式 × 假 Supabase（每次最多 1000 列）");
{
  tables.set(
    "inv_pos_sales",
    Array.from({ length: 2500 }, (_, i) => ({
      sale_id: `s${String(i).padStart(5, "0")}`,
      quantity: 2,
      amount: 100,
      cost_price: 30,
      channel: i % 2 === 0 ? "pos" : "online",
    })),
  );
  const { summarisePosSales } = await import(join(SRC, "server/repos/inv-sales.ts"));
  const base = {
    from: null,
    to: null,
    channel: "all",
    keyword: null,
    reconciled: "all",
    paymentMethodId: null,
    page: 0,
    pageSize: 50,
  };
  check("summarisePosSales：2500 筆全算（不是 1000）", await summarisePosSales(base), {
    count: 2500,
    quantity: 5000,
    amount: 250000,
    cost: 150000,
  });
  check(
    "summarisePosSales：channel=pos 1250 筆",
    (await summarisePosSales({ ...base, channel: "pos" })).count,
    1250,
  );
}
{
  tables.set(
    "admin_event_roster",
    Array.from({ length: 1500 }, (_, i) => ({
      registration_id: `r${String(i).padStart(5, "0")}`,
      session_id: i < 1200 ? "A" : "B",
      on_roster: i % 3 !== 0,
    })),
  );
  const { countRegistrationsBySession } = await import(
    join(SRC, "server/repos/event-registrations.ts")
  );
  const c = await countRegistrationsBySession();
  check(
    "countRegistrationsBySession：1500 列全數（A 1200、B 300）",
    [c.A?.total, c.B?.total],
    [1200, 300],
  );
  check("countRegistrationsBySession：已付款數也全算", c.A.paid + c.B.paid, 1000);
}
{
  tables.set(
    "event_sessions",
    Array.from({ length: 1100 }, (_, i) => ({ id: `e${i}` })),
  );
  tables.set(
    "event_session_plans",
    Array.from({ length: 1300 }, (_, i) => ({ id: `p${i}` })),
  );
  const repo = await import(join(SRC, "server/repos/event-sessions.ts"));
  check("listEventSessions：1100 列全回", (await repo.listEventSessions()).length, 1100);
  check("listEventSessionPlans：1300 列全回", (await repo.listEventSessionPlans()).length, 1300);
}
{
  // 1200 件啟用品項；低庫存的兩件排在第 1000 件之後，其中一件警示值 10、庫存 8（舊的
  // 「庫存 <= 5」粗篩會漏掉它）。
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    inv_product_id: `i${String(i).padStart(5, "0")}`,
    name: `n${i}`,
    stock_quantity: 50,
    low_stock_alert: 5,
    is_active: true,
    approval_status: "approved",
  }));
  rows[1100] = { ...rows[1100], stock_quantity: 8, low_stock_alert: 10 };
  rows[1150] = { ...rows[1150], stock_quantity: 2, low_stock_alert: 5 };
  rows[1199] = { ...rows[1199], stock_quantity: 0, low_stock_alert: 0 };
  tables.set("inv_admin_products", rows);
  const { listStockCountProducts } = await import(join(SRC, "server/repos/inv-adjustments.ts"));
  const r = await listStockCountProducts({
    keyword: null,
    categoryId: null,
    productType: null,
    lowStockOnly: true,
    page: 0,
    pageSize: 50,
  });
  check(
    "低庫存：第 1000 件之後、警示值 > 5 的品項都抓到（警示 0 不算）",
    [r.total, r.rows.map((x) => x.inv_product_id)],
    [2, ["i01100", "i01150"]],
  );
  const p2 = await listStockCountProducts({
    keyword: null,
    categoryId: null,
    productType: null,
    lowStockOnly: true,
    page: 1,
    pageSize: 1,
  });
  check(
    "低庫存：分頁在篩完之後做",
    [p2.total, p2.rows.map((x) => x.inv_product_id)],
    [2, ["i01150"]],
  );
}
{
  tables.set("inv_pos_sales", []);
  tables.set(
    "orders",
    Array.from({ length: 1800 }, (_, i) => ({
      id: `o${String(i).padStart(5, "0")}`,
      total: 100,
      payment_method: i < 1000 ? "card" : "transfer",
      source: "web",
      payment_status: "paid",
    })),
  );
  const { ADMIN_READ_HANDLERS } = await import(join(SRC, "server/mcp/admin-read-tools.ts"));
  const res = await ADMIN_READ_HANDLERS.get_sales_summary({
    date_from: "2026-10-01",
    date_to: "2026-10-31",
  });
  const j = JSON.parse(res.content[0].text);
  check(
    "MCP get_sales_summary：網站訂單 1800 張全算（不是 1000）",
    [j.web_orders_paid.count, j.web_orders_paid.amount, j.web_orders_paid.by_payment_method],
    [
      1800,
      180000,
      { card: { count: 1000, amount: 100000 }, transfer: { count: 800, amount: 80000 } },
    ],
  );
}

{
  // 推薦碼月報：一個月 1500 張已付款訂單（舊寫法 .limit(5000) 只會拿回 1000 張）。
  tables.set("referral_settings", []);
  tables.set("referrers", []);
  tables.set("referral_settlements", []);
  tables.set("product_inventory_links", []);
  tables.set(
    "orders",
    Array.from({ length: 1500 }, (_, i) => ({
      id: `o${String(i).padStart(5, "0")}`,
      order_no: `N${i}`,
      created_at: "2026-10-10T02:00:00Z",
      paid_at: "2026-10-10T02:00:00Z",
      status: "processing",
      payment_status: "paid",
      payment_method: "card",
      discount: 0,
      customer_email: null,
      customer_phone: null,
      referrer_id: null,
      referral_code: null,
      order_items: [
        { product_id: null, product_type: "book", unit_price: 100, quantity: 1, subtotal: 100 },
      ],
    })),
  );
  const { getMonthlyReport } = await import(join(SRC, "server/repos/referrals.ts"));
  const rep = await getMonthlyReport("2026-10");
  check("推薦碼月報：1500 張已付款訂單全算進全店張數（不是 1000）", rep.shop.orderCount, 1500);
}

// [4] ------------------------------------------------------------------------
console.log("\n[4] 靜態");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
for (const f of [
  "server/repos/inv-sales.ts",
  "server/mcp/admin-read-tools.ts",
  "server/repos/event-registrations.ts",
]) {
  check(`${f} 沒有 .limit(20000)`, /\.limit\(20000\)/.test(strip(readFile(join(SRC, f)))), false);
}
check(
  "referrals.ts 月報不再 .limit(5000)（改 readAllPages）",
  /\.limit\(5000\)/.test(strip(readFile(join(SRC, "server/repos/referrals.ts")))),
  false,
);
check(
  "inv-adjustments.ts 不再用 stock_quantity <= 5 粗篩",
  /lte\("stock_quantity", 5\)/.test(strip(readFile(join(SRC, "server/repos/inv-adjustments.ts")))),
  false,
);
check(
  "StockCountTable 沿用 lib/admin/low-stock 的 isLowStock（不自己再寫一次）",
  /from "@\/lib\/admin\/low-stock"/.test(
    readFile(join(SRC, "components/inventory/StockCountTable.tsx")),
  ),
  true,
);

console.log(
  fail === 0
    ? green(`\n✓ 全部通過：${pass} passed, 0 failed`)
    : red(`\n✗ 有失敗：${pass} passed, ${fail} failed`),
);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
