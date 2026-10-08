#!/usr/bin/env node
/**
 * pos-counter-selftest.mjs —— 門市 POS 與授權層（0014）的自檢
 *
 * 兩段，理由與 inventory-stock-selftest 相同：沒有金鑰的機器上也要有意義。
 *
 *   [靜態] 讀 supabase/migrations/0014 與四個 TypeScript 檔，守的是**設計不變量**：
 *          FIFO trigger 是不是 BEFORE INSERT、有沒有 cost_price IS NOT NULL 的
 *          冪等守門、pos_checkout 有沒有依 uuid 排序取鎖、四個新 view 有沒有先
 *          revoke 再 grant、staffFnMiddleware 有沒有動到 adminFnMiddleware、
 *          fns/pos.ts 有沒有誤掛 adminFnMiddleware。答案都寫在檔案裡。永遠會跑。
 *
 *   [實測] 對目標資料庫真的寫一筆銷售再刪掉，證明三件事：
 *          FIFO 只扣一次（跑兩次驗證）、逃生門會寫告警、POS 與網站扣同一個數字。
 *          需要 SUPABASE_ACCESS_TOKEN；沒有就整段 skip（會印出來）。
 *
 * ⚠️ 實測段會在**正式資料庫**建資料再刪掉。所有測試資料都帶固定前綴（見 MARK），
 *    而且開頭與結尾各清一次 —— 開頭那次是為了讓上一輪中途掛掉的殘骸不會累積。
 *
 * ⚠️ 清理順序是刻意的：inv.sales 一定要在 inv.products 之前刪，因為
 *    rollback_fifo_on_sale_delete 這個 BEFORE DELETE trigger 會去 UPDATE
 *    inv.products —— 先刪商品的話 trigger 會找不到列，庫存與 remaining_quantity
 *    就補不回去了。
 *
 * 執行：
 *   node scripts/pos-counter-selftest.mjs                         # 只跑靜態
 *   SUPABASE_ACCESS_TOKEN=sbp_… node scripts/pos-counter-selftest.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/pos-counter-selftest.mjs";

const MIG_0014 = join(ROOT, "supabase/migrations/0014_pos_counter.sql");
const SRC_MIDDLEWARE = join(ROOT, "src/lib/admin/middleware.ts");
const SRC_AUTH = join(ROOT, "src/server/auth.ts");
const SRC_FNS_POS = join(ROOT, "src/lib/admin/fns/pos.ts");
const SRC_REPO = join(ROOT, "src/server/repos/inv-sales.ts");
const SRC_SCANNER = join(ROOT, "src/components/pos/ScannerInput.tsx");

/** 測試資料的固定標記。刪除全靠它，所以要夠特別。 */
const MARK = "__posselftest__";

// -----------------------------------------------------------------------------
// 迷你測試框架
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function check(label, actual, expected) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
  }
}

const checkTrue = (label, value) => check(label, Boolean(value), true);

/** 把 `--` 註解整行拿掉，免得註解裡提到的字串讓斷言假性通過。 */
function strip(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
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
// [1] 檔案在，而且 0001–0013 一個都沒有被動過
// -----------------------------------------------------------------------------

console.log("\n[1] 檔案盤點");
check("0014 存在", existsSync(MIG_0014), true);
for (const f of [
  "0009_inventory_schema.sql",
  "0010_inventory_identity.sql",
  "0011_inventory_single_source.sql",
  "0012_inventory_listing_admin_views.sql",
  "0013_tighten_availability_grants.sql",
]) {
  check(`${f} 仍在`, existsSync(join(ROOT, "supabase/migrations", f)), true);
}
for (const [label, path] of [
  ["middleware.ts", SRC_MIDDLEWARE],
  ["server/auth.ts", SRC_AUTH],
  ["fns/pos.ts", SRC_FNS_POS],
  ["repos/inv-sales.ts", SRC_REPO],
  ["components/pos/ScannerInput.tsx", SRC_SCANNER],
]) {
  check(`${label} 存在`, existsSync(path), true);
}

const sql0014 = read(MIG_0014);
const exec0014 = strip(sql0014);
// 反空殼：先證明檔案真的有內容，否則下面每一條 includes() 都是假性結果。
checkTrue("0014 不是空檔（> 6000 字）", exec0014.length > 6000);

// -----------------------------------------------------------------------------
// [2] FIFO —— 這一期最容易錯的地方
// -----------------------------------------------------------------------------
// allocate_fifo_cost() 會 UPDATE inv.purchases.remaining_quantity，呼叫兩次就扣
// 兩次，而且不會有任何地方報錯。所以「恰好一次」這件事必須由結構保證。

console.log("\n[2] FIFO 成本分攤：恰好一次");
checkTrue(
  "建了 inv.allocate_fifo_on_sale()",
  exec0014.includes("function inv.allocate_fifo_on_sale()"),
);
checkTrue(
  "trigger 是 BEFORE INSERT（要能改 NEW.cost_price，而且一列只觸發一次）",
  /before insert on inv\.sales/i.test(exec0014),
);
checkTrue(
  "冪等守門：cost_price 已有值就跳過（呼叫端自己算過了，不能再扣一次）",
  /IF NEW\.cost_price IS NOT NULL THEN\s+RETURN NEW;/i.test(exec0014),
);
checkTrue(
  "二手／無 product_id 跳過（與 rollback_fifo_cost 的 guard 對齊）",
  /NEW\.product_id IS NULL OR NEW\.is_secondhand = true/i.test(exec0014),
);
checkTrue(
  "傳 NEW.quantity 而不是自己乘 pack_size（allocate_fifo_cost 內建解析，乘兩次就錯）",
  exec0014.includes("inv.allocate_fifo_cost(NEW.product_id, NEW.user_id, NEW.quantity)"),
);
checkTrue(
  "trigger 先 drop 再 create（重跑 migration 不會疊兩個）",
  exec0014.includes("drop trigger if exists allocate_fifo_before_sale_insert"),
);
checkTrue(
  "函式對 anon/authenticated revoke",
  exec0014.includes(
    "revoke execute on function inv.allocate_fifo_on_sale() from anon, authenticated",
  ),
);

// -----------------------------------------------------------------------------
// [3] pos_checkout
// -----------------------------------------------------------------------------

console.log("\n[3] pos_checkout：整車一個交易");
checkTrue("建了 public.pos_checkout", exec0014.includes("function public.pos_checkout("));
checkTrue(
  "security definer",
  /create or replace function public\.pos_checkout[\s\S]{0,900}?security definer/i.test(exec0014),
);
checkTrue(
  "取鎖依 target_id 排序（兩個櫃檯同時賣 A+B 與 B+A 不會互等）",
  /ORDER BY t\.target_id/i.test(exec0014),
);
checkTrue("鎖了才算可售量（FOR UPDATE）", /FOR UPDATE/i.test(exec0014));
checkTrue(
  "扣可售量時把 stock_reservations 算進去（網站保留的不能在櫃檯賣掉）",
  exec0014.includes("public.stock_reservations"),
);
checkTrue("空車擋掉", exec0014.includes("POS_EMPTY_CART"));
checkTrue("數量 <= 0 擋掉", exec0014.includes("POS_BAD_QUANTITY"));
checkTrue("NaN／負數單價擋掉", exec0014.includes("POS_BAD_PRICE"));
checkTrue("租借品擋掉（來源 canBeSold）", exec0014.includes("POS_PRODUCT_RENTAL"));
checkTrue("未審核擋掉", exec0014.includes("POS_PRODUCT_UNAPPROVED"));
checkTrue("已停用擋掉", exec0014.includes("POS_PRODUCT_INACTIVE"));
checkTrue(
  "寫入時 channel 固定 'pos'",
  /'pos', coalesce\(p_override_reservation, false\)/.test(exec0014),
);
checkTrue(
  "對 anon/authenticated revoke execute",
  exec0014.includes(
    "revoke execute on function public.pos_checkout(uuid, jsonb, uuid, date, text, boolean) from anon, authenticated",
  ),
);

// -----------------------------------------------------------------------------
// [4] 四個 view 的權限 —— 0013 修過的那個坑
// -----------------------------------------------------------------------------
// Supabase 對 public schema 有 ALTER DEFAULT PRIVILEGES，新建的 view 一出生就對
// anon/authenticated 是 ALL。只下 grant select 會留下那個 ALL。

console.log("\n[4] 新 view 的權限");
const VIEWS = ["inv_pos_products", "inv_pos_payment_methods", "inv_pos_sales", "inv_stock_alerts"];
for (const v of VIEWS) {
  checkTrue(`${v} 建了`, exec0014.includes(`create or replace view public.${v}`));
  checkTrue(
    `${v} 先 revoke all from anon, authenticated`,
    exec0014.includes(`revoke all on public.${v}`) &&
      new RegExp(`revoke all on public\\.${v}\\s+from anon, authenticated`).test(exec0014),
  );
  checkTrue(
    `${v} 明確 grant select 給 service_role`,
    new RegExp(`grant select on public\\.${v}\\s+to service_role`).test(exec0014),
  );
  checkTrue(
    `${v} 是 security_invoker = false`,
    new RegExp(
      `create or replace view public\\.${v}\\s*\\n\\s*with \\(security_invoker = false\\)`,
    ).test(exec0014),
  );
}
// revoke 必須排在 grant 前面 —— 反過來會把剛給的權限一起收掉。
checkTrue(
  "revoke 區段整個排在 grant 區段前面",
  exec0014.indexOf("revoke all on public.inv_pos_products") <
    exec0014.indexOf("grant select on public.inv_pos_products"),
);

// -----------------------------------------------------------------------------
// [5] 授權層
// -----------------------------------------------------------------------------

console.log("\n[5] 授權層：兩個門，不是一個");
const middleware = read(SRC_MIDDLEWARE);
const auth = read(SRC_AUTH);
const fnsPos = read(SRC_FNS_POS);

checkTrue("adminFnMiddleware 還在", middleware.includes("export const adminFnMiddleware"));
checkTrue(
  "adminFnMiddleware 仍然呼叫 requireAdmin（沒有被偷偷放寬）",
  /adminFnMiddleware = createMiddleware\(\{ type: "function" \}\)\.server\(\s*async \(\{ next \}\) => \{[\s\S]*?requireAdmin\(\)/.test(
    middleware,
  ),
);
checkTrue(
  "staffFnMiddleware 是並排新增的另一支",
  middleware.includes("export function staffFnMiddleware"),
);
checkTrue(
  "staffFnMiddleware 收 permission 參數",
  /staffFnMiddleware\(permission\?: StaffPermission\)/.test(middleware),
);

checkTrue("requireAdmin 還在", auth.includes("export async function requireAdmin"));
checkTrue(
  "requireAdmin 仍然只放 admin 進來",
  /loadAdminProfile[\s\S]{0,300}?profile\.role !== "admin"/.test(auth),
);
checkTrue("requireStaff 新增了", auth.includes("export async function requireStaff"));
checkTrue(
  "requireStaff 每次重讀 profiles（kill-switch，與 requireAdmin 同一條規矩）",
  /export async function requireStaff[\s\S]{0,600}?loadBackOfficeProfile\(session\.userId\)/.test(
    auth,
  ),
);
checkTrue(
  "pending 丟 PendingApprovalError 而不是 401",
  /profile\.role === "pending"\) throw new PendingApprovalError/.test(auth),
);
checkTrue(
  "pending 的 cookie 不銷毀（不然他每次進來都被登出）",
  /pending 的 cookie \*\*不銷毀\*\*/.test(auth),
);
checkTrue(
  "admin 一律通過細權限（來源 has_permission 的 IF is_admin THEN RETURN true）",
  /if \(role === "admin"\) return \[\.\.\.STAFF_PERMISSIONS\]/.test(auth),
);
checkTrue(
  "customer / vendor 連 cookie 都拿不到",
  /data\.role !== "admin" && data\.role !== "staff" && data\.role !== "pending"\) return null/.test(
    auth,
  ),
);

console.log("\n[6] fns/pos.ts 掛對 middleware");
checkTrue(
  "POS 的 server fn 一支都沒有誤掛 adminFnMiddleware",
  // 只看實際掛上去的那一行 —— 檔頭註解本來就會提到 adminFnMiddleware，
  // 用整檔 includes() 去斷言會讓這一條永遠紅。
  !/\.middleware\(\[\s*adminFnMiddleware/.test(fnsPos),
);
checkTrue("也沒有把 adminFnMiddleware import 進來", !/^import .*adminFnMiddleware/m.test(fnsPos));
check(
  "七支 POS server fn 全部都有 middleware",
  (fnsPos.match(/\.middleware\(\[staffFnMiddleware/g) ?? []).length,
  7,
);
checkTrue(
  "標記告警已處理需要 approve_stock_adjustments",
  fnsPos.includes('staffFnMiddleware("approve_stock_adjustments")'),
);
checkTrue(
  "結帳的 user_id 取自 middleware context，不從 request body 拿",
  /userId: context\.staff\.userId/.test(fnsPos),
);

// -----------------------------------------------------------------------------
// [7] 前端的兩個硬規矩
// -----------------------------------------------------------------------------

console.log("\n[7] 前端：SSR 與 toast");
const scanner = read(SRC_SCANNER);
checkTrue(
  "html5-qrcode 是 dynamic import（靜態 import 會在 SSR 端碰到 window 直接炸）",
  /await import\("html5-qrcode"\)/.test(scanner),
);
checkTrue("沒有 html5-qrcode 的靜態 import", !/^import .*html5-qrcode/m.test(scanner));

// 這個 repo 統一用 sonner。來源的 use-toast/toaster 一律不搬。
const posFiles = [
  "src/routes/admin/_shell.pos.tsx",
  "src/routes/admin/_shell.sales.tsx",
  "src/routes/admin/_shell.stock-alerts.tsx",
  "src/components/pos/ScannerInput.tsx",
  "src/components/pos/CartPanel.tsx",
  "src/components/pos/CheckoutPanel.tsx",
  "src/components/pos/ProductLookup.tsx",
  "src/components/pos/SalesFilterBar.tsx",
  "src/components/pos/SaleDetailDialog.tsx",
];
for (const f of posFiles) check(`${f} 存在`, existsSync(join(ROOT, f)), true);
const allPos = posFiles.map((f) => read(join(ROOT, f))).join("\n");
checkTrue(
  "沒有搬進 use-toast / toaster",
  !/use-toast|useToast|from "@\/hooks\/use-toast"/.test(allPos),
);
checkTrue("要用 toast 的地方走 sonner", /from "sonner"/.test(allPos));
checkTrue("LocalizedField 沒有出現在 POS（進銷存是單語 text）", !/LocalizedField/.test(allPos));

// 所有 supabase 呼叫都下沉到 repo。
console.log("\n[8] supabase 呼叫只在 repo 層");
checkTrue("POS 的路由與元件沒有直接碰 supabase", !/supabaseAdmin|createClient/.test(allPos));
const repo = read(SRC_REPO);
checkTrue("repo 的錯誤一律 throw，沒有吞掉變成空陣列", !/catch\s*\{\s*return \[\]/.test(repo));
check(
  "repo 每一個 supabase 呼叫都檢查 error",
  (repo.match(/if \(error\) throw new Error/g) ?? []).length >= 7,
  true,
);

// -----------------------------------------------------------------------------
// [9]–[12] 實測
// -----------------------------------------------------------------------------

const REF = process.env.SUPABASE_PROJECT_REF ?? "noijrmhdfbfvjyvchvzj";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

async function q(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
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
 * ⚠️ 順序不能換：sales 一定在 products 之前刪。BEFORE DELETE 的
 *    rollback_fifo_cost() 會去 UPDATE inv.products —— 商品先沒了，庫存與
 *    remaining_quantity 就補不回去，正式資料庫會留下一筆對不起來的帳。
 */
async function cleanup() {
  await q(`delete from public.stock_oversold_alerts
            where inv_product_id in (select id from inv.products where name like '${MARK}%')`);
  await q(`delete from public.stock_reservations
            where inv_product_id in (select id from inv.products where name like '${MARK}%')`);
  await q(`delete from inv.sales
            where product_id in (select id from inv.products where name like '${MARK}%')`);
  await q(`delete from inv.purchases
            where product_id in (select id from inv.products where name like '${MARK}%')`);
  await q(`delete from public.orders where customer_name = '${MARK}'`);
  await q(`delete from inv.products where name like '${MARK}%'`);
}

if (!TOKEN) {
  skipped.push("實測段（缺 SUPABASE_ACCESS_TOKEN）");
  console.log(yellow("\n[9–12] 實測 —— 跳過：沒有 SUPABASE_ACCESS_TOKEN"));
} else {
  await cleanup();

  const operator = await q(`select id from public.profiles where role = 'admin' limit 1`);
  const userId = operator.rows?.[0]?.id;

  if (!userId) {
    skipped.push("實測段（找不到可用的操作人員）");
    console.log(yellow("\n[9–12] 實測 —— 跳過：profiles 裡沒有 admin"));
  } else {
    // ---- 造資料：庫存 10，兩批進貨（先進的便宜） -----------------------------
    const setup = await q(`
      with p as (
        insert into inv.products (user_id, name, selling_price, stock_quantity,
                                  product_type, is_active, approval_status)
        values ('${userId}', '${MARK}茶餅', 300, 10, 'outright', true, 'approved')
        returning id
      ), b as (
        insert into inv.purchases (user_id, product_id, quantity, remaining_quantity,
                                   unit_cost, purchase_date)
        -- ⚠️ ::uuid 是必要的：VALUES 裡的字面值會被推斷成目標欄位的型別，
        --    但 SELECT 的字面值預設是 text，會撞 42804。
        select '${userId}'::uuid, p.id, 4, 4, 100, '2026-01-01'::date from p
        union all
        select '${userId}'::uuid, p.id, 6, 6, 200, '2026-02-01'::date from p
        returning product_id
      )
      select id from p;
    `);
    const productId = setup.rows?.[0]?.id;

    console.log("\n[9] 實測：POS 賣一件");
    checkTrue("測試商品建立成功", Boolean(productId));

    if (productId) {
      const sale1 = await q(`
        select public.pos_checkout(
          '${userId}',
          '[{"inv_product_id":"${productId}","quantity":2,"unit_price":300}]'::jsonb
        ) as r;
      `);
      const r1 = sale1.rows?.[0]?.r;
      checkTrue("pos_checkout 成功", Boolean(r1?.sale_ids?.length));
      check("寫了 1 列 inv.sales", r1?.sale_ids?.length ?? 0, 1);
      check("沒有賣超", (r1?.oversold ?? []).length, 0);

      const after1 = await q(`
        select (select stock_quantity from inv.products where id = '${productId}') as stock,
               (select channel from inv.sales where product_id = '${productId}') as channel,
               (select cost_price from inv.sales where product_id = '${productId}')::float as cost,
               (select sum(quantity - remaining_quantity) from inv.purchases
                 where product_id = '${productId}')::int as consumed;
      `);
      const a1 = after1.rows?.[0];
      check("庫存 10 → 8", a1?.stock, 8);
      check("channel 是 pos", a1?.channel, "pos");
      check("FIFO 吃了第一批（單位成本 100）", a1?.cost, 100);
      check("remaining_quantity 只被扣 2", a1?.consumed, 2);

      // ---- [10] FIFO 不重複扣：再賣一次，確認只扣新賣掉的那些 ---------------
      console.log("\n[10] 實測：FIFO 只扣一次（第二次結帳）");
      await q(`
        select public.pos_checkout(
          '${userId}',
          '[{"inv_product_id":"${productId}","quantity":3,"unit_price":300}]'::jsonb
        );
      `);
      const after2 = await q(`
        select (select sum(quantity - remaining_quantity) from inv.purchases
                 where product_id = '${productId}')::int as consumed,
               (select round(cost_price, 2)::float from inv.sales
                 where product_id = '${productId}' order by created_at desc limit 1) as cost;
      `);
      const a2 = after2.rows?.[0];
      // 2 + 3 = 5，不是 2 + 3 + 2（重複扣的話會多）也不是 10。
      check("累計只扣 5（2+3），沒有重複扣", a2?.consumed, 5);
      check("跨批成本 (2×100 + 1×200)/3 = 133.33", a2?.cost, 133.33);

      // 呼叫端自己給成本時，trigger 必須跳過 —— 這是冪等守門的實測。
      const before3 = await q(
        `select sum(quantity - remaining_quantity)::int as c from inv.purchases where product_id = '${productId}'`,
      );
      await q(`
        insert into inv.sales (user_id, product_id, sale_date, quantity, unit_price, amount, cost_price)
        values ('${userId}', '${productId}', current_date, 1, 300, 300, 999);
      `);
      const after3 = await q(
        `select sum(quantity - remaining_quantity)::int as c from inv.purchases where product_id = '${productId}'`,
      );
      check(
        "cost_price 已給值 → FIFO 跳過，remaining_quantity 不動",
        after3.rows?.[0]?.c,
        before3.rows?.[0]?.c,
      );

      // ---- [11] 門市 × 網站扣同一個數字 -------------------------------------
      console.log("\n[11] 實測：網站保留會擋住櫃檯");
      const stockNow = await q(
        `select stock_quantity as s from inv.products where id = '${productId}'`,
      );
      const remaining = stockNow.rows?.[0]?.s ?? 0;

      const order = await q(`
        insert into public.orders (subtotal, total, customer_name, customer_email, customer_phone)
        values (300, 300, '${MARK}', 'posselftest@example.invalid', '0900000000')
        returning id;
      `);
      const orderId = order.rows?.[0]?.id;
      // 把剩下的全部保留起來 —— 可售量歸零。
      await q(`
        insert into public.stock_reservations (order_id, inv_product_id, quantity)
        values ('${orderId}', '${productId}', ${remaining});
      `);

      const blocked = await q(`
        select public.pos_checkout(
          '${userId}',
          '[{"inv_product_id":"${productId}","quantity":1,"unit_price":300}]'::jsonb
        );
      `);
      checkTrue("被網站保留擋下（庫存還在，但可售量 0）", blocked.ok === false);
      checkTrue(
        "錯誤訊息是寫給店員看的中文，不是 INSUFFICIENT_STOCK:<uuid>",
        typeof blocked.error === "string" && blocked.error.includes("可售"),
      );

      // ---- [12] 逃生門：override 成立且留痕 ---------------------------------
      console.log("\n[12] 實測：逃生門會寫告警");
      const forced = await q(`
        select public.pos_checkout(
          '${userId}',
          '[{"inv_product_id":"${productId}","quantity":1,"unit_price":300}]'::jsonb,
          null, current_date, '${MARK} 客人站在櫃檯', true
        ) as r;
      `);
      const rf = forced.rows?.[0]?.r;
      checkTrue("帶 override 就結得掉", Boolean(rf?.sale_ids?.length));
      check("回傳裡帶著賣超資訊", (rf?.oversold ?? []).length, 1);

      const alert = await q(`
        select source, shortfall, resolved_at,
               (select count(*)::int from public.inv_stock_alerts
                 where inv_product_id = '${productId}') as via_view
          from public.stock_oversold_alerts
         where inv_product_id = '${productId}';
      `);
      const al = alert.rows?.[0];
      check("寫了一列 stock_oversold_alerts", alert.rows?.length ?? 0, 1);
      check("source 是 pos_override", al?.source, "pos_override");
      check("shortfall 是 1", al?.shortfall, 1);
      check("預設未處理", al?.resolved_at, null);
      check("inv_stock_alerts view 看得到它", al?.via_view, 1);

      // 標記已處理（repo 的 update 走的是同一條路）
      const resolved = await q(`
        update public.stock_oversold_alerts
           set resolved_at = now(), resolved_by = '${userId}', resolution_note = '${MARK} 已盤點'
         where inv_product_id = '${productId}' and resolved_at is null
        returning id;
      `);
      check("標記已處理寫得進去", resolved.rows?.length ?? 0, 1);
      const reResolve = await q(`
        update public.stock_oversold_alerts
           set resolved_at = now()
         where inv_product_id = '${productId}' and resolved_at is null
        returning id;
      `);
      check("已處理的不會被第二個人蓋掉（回 0 列）", reResolve.rows?.length ?? 0, 0);

      // ---- 權限：anon 對四個新 view 一個字都讀不到 --------------------------
      console.log("\n[13] 實測：anon / authenticated 對新 view 零權限");
      const grants = await q(`
        select count(*)::int as n from information_schema.role_table_grants
         where table_schema = 'public'
           and table_name in ('inv_pos_products','inv_pos_payment_methods',
                              'inv_pos_sales','inv_stock_alerts')
           and grantee in ('anon','authenticated');
      `);
      check("anon/authenticated 的授權列數是 0", grants.rows?.[0]?.n, 0);

      const fnGrants = await q(`
        select count(*)::int as n from information_schema.role_routine_grants
         where routine_schema = 'public' and routine_name = 'pos_checkout'
           and grantee in ('anon','authenticated','PUBLIC');
      `);
      check("pos_checkout 對 anon/authenticated/PUBLIC 沒有 execute", fnGrants.rows?.[0]?.n, 0);
    }

    // ---- 收尾：全部刪掉，並證明真的刪乾淨了 --------------------------------
    console.log("\n[14] 收尾：測試資料全部刪除");
    await cleanup();
    const leftovers = await q(`
      select (select count(*)::int from inv.products where name like '${MARK}%') as products,
             (select count(*)::int from public.orders where customer_name = '${MARK}') as orders,
             (select count(*)::int from public.stock_oversold_alerts a
                join inv.products p on p.id = a.inv_product_id
               where p.name like '${MARK}%') as alerts;
    `);
    const lo = leftovers.rows?.[0];
    check("沒有殘留的測試商品", lo?.products, 0);
    check("沒有殘留的測試訂單", lo?.orders, 0);
    check("沒有殘留的測試告警", lo?.alerts, 0);

    // 這一支動過 inv.sales，所以順手證明既有的 665 列還在（新增的都刪光了）。
    const baseline = await q(`select count(*)::int as n from inv.sales`);
    check("inv.sales 回到 665 列", baseline.rows?.[0]?.n, 665);
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
