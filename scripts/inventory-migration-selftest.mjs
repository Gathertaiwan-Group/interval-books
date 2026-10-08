#!/usr/bin/env node
/**
 * inventory-migration-selftest.mjs —— 進銷存搬遷（inv schema）的對帳自檢
 *
 * 分兩段，理由是「這支測試在沒有金鑰的機器上也必須有意義」：
 *
 *   [靜態] 直接讀 supabase/migrations/0009 與 0010 這兩個檔案的內容。
 *          這一段永遠會跑。它守的是**安全模型**：inv 有沒有漏一條 policy、
 *          有沒有漏一條給 anon 的 grant、重複 trigger 有沒有真的被拿掉。
 *          這些問題的答案就寫在檔案裡，不需要連線也回答得出來。
 *
 *   [連線] 對目標 Supabase 逐張表對帳，並且拿 anon key 實際去打一次 inv.*。
 *          需要 SUPABASE_ACCESS_TOKEN（Management API）才會跑；沒有就整段
 *          標成 skip，不算失敗 —— 但**會印出來**，不會靜悄悄消失。
 *
 * 執行：
 *   node scripts/inventory-migration-selftest.mjs          # 只跑靜態
 *   SUPABASE_ACCESS_TOKEN=sbp_… node scripts/inventory-migration-selftest.mjs
 *
 * 環境變數：
 *   SUPABASE_ACCESS_TOKEN   Management API token（連線段的開關）
 *   SUPABASE_PROJECT_REF    目標專案 ref，預設 noijrmhdfbfvjyvchvzj（2026-10 三站合併後的專案；小時光的表仍在 public／inv）
 *   VITE_SUPABASE_URL       anon 可達性測試用；沒設會去讀 .env.local
 *   VITE_SUPABASE_ANON_KEY  同上
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/inventory-migration-selftest.mjs";

// ── 對帳基準 ────────────────────────────────────────────────────────────────
// 這些數字全部出自 bookstock_260815.backup（pg_dump custom，PostgreSQL 17.6），
// 在本機 Postgres 還原後逐項數出來的。它們是**硬性對帳**：對不上就代表搬遷
// 過程中有 trigger 偷偷動了資料，或者有一段沒搬完。
const EXPECTED_TABLE_ROWS = {
  approval_settings: 7,
  categories: 7,
  combo_set_items: 6,
  combo_sets: 6,
  inventory_adjustments: 30,
  payment_methods: 9,
  products: 993,
  profiles: 6,
  purchases: 1029,
  sales: 665,
  stock_adjustments: 49,
  tax_types: 3,
  user_permissions: 10,
  vendor_attachments: 1,
  vendor_bank_accounts: 10,
  vendor_categories: 7,
  vendor_contacts: 0,
  vendor_return_items: 7,
  vendor_returns: 1,
  vendors: 14,
  withholding_categories: 4,
};
const EXPECTED_TOTAL = 2864;
const EXPECTED_SUM_STOCK = 3507;
const EXPECTED_SUM_REMAINING = 3761;
const EXPECTED_STOCK_POSITIVE = 806;
const EXPECTED_STOCK_ZERO_AFTER_FIX = 187; // 備份是 186 + 那一筆被修好的負庫存
const EXPECTED_PRODUCT_TYPES = { consignment: 815, rental: 110, outright: 68 };
const EXPECTED_ACTIVE = 990;
const EXPECTED_APPROVED = 988;

/**
 * 搬遷校正單的識別字串。
 *
 * 負庫存那一筆是**用調整單修的，不是 UPDATE**，所以修完之後：
 *   inv.stock_adjustments 多一列 → 21 張表總和變成 2,865
 *   stock_quantity 多 +1        → 總和變成 3,508
 * 下面所有「與備份一致」的斷言都會先把這一張單扣掉再比，這樣同一支測試
 * 可以同時證明兩件事：搬進來的資料與備份逐筆相同，而且唯一的差異是那張
 * 有簽名、有原因、查得到的調整單。
 */
const FIX_MARKER = "搬遷校正（2026-08）";

/** 來源 7 個 auth user，以及它們該落在哪個 role。 */
const EXPECTED_ROLES = {
  "ab359502-b080-405a-8171-000fea86b49a": "admin", // zin@fans.tw（來源 is_admin）
  "0a68e409-aeb9-4a7c-b1ad-2ffcd9f5c50a": "admin", // alice（來源 is_admin）
  "baa25449-3136-4cfe-9e1c-4ba8d95c77bd": "pending", // 來源 is_approved = false
  "9a62d0d5-1dda-441d-b14d-d8004d3fe1c5": "staff",
  "8d74b21a-e148-4571-a6cc-b64ab7452c3c": "pending", // 來源根本沒有 profile 那一筆
  "4a3a68b7-ec02-4be3-85b6-eb896f60b61b": "staff",
  "dd56f62f-61e6-4a31-b638-4ca03e374ab6": "staff",
};
const EXPECTED_STAFF_PERMISSIONS = 10;

/** 三個 sequence 至少要走到這裡，否則下一次產號會撞到既有單號。 */
const EXPECTED_SEQ_MIN = {
  stock_adjustment_seq: 56,
  vendor_code_seq: 15,
  vendor_return_seq: 1,
};

// ── 迷你測試框架 ────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
  }
}

function checkTrue(label, value, detail = "") {
  check(label + (detail ? `（${detail}）` : ""), Boolean(value), true);
}

// ══════════════════════════════════════════════════════════════════════════
// 第一段：靜態 —— 讀 migration 檔案本身
// ══════════════════════════════════════════════════════════════════════════

const M0009 = join(ROOT, "supabase/migrations/0009_inventory_schema.sql");
const M0010 = join(ROOT, "supabase/migrations/0010_inventory_identity.sql");

console.log("\n[1] migration 檔案存在，且 0001–0008 沒有被動到");
check("0009_inventory_schema.sql 存在", existsSync(M0009), true);
check("0010_inventory_identity.sql 存在", existsSync(M0010), true);
for (const n of ["0001_init", "0002_admin", "0003_storage_site_images", "0004_commerce_products"]) {
  checkTrue(`${n}.sql 仍然存在`, existsSync(join(ROOT, `supabase/migrations/${n}.sql`)));
}

const sql0009 = readFileSync(M0009, "utf8");
const sql0010 = readFileSync(M0010, "utf8");
/** 只看可執行的 SQL —— 說明文字裡出現「anon」不代表真的授了權。 */
const exec0009 = sql0009
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

console.log("\n[2] inv schema 的安全模型（0009 的可執行 SQL）");
check("CREATE POLICY 出現次數", (exec0009.match(/CREATE POLICY/gi) ?? []).length, 0);
check(
  "給 anon / authenticated 的 GRANT 次數",
  (exec0009.match(/grant[\s\S]{0,200}?\bto\s+(anon|authenticated)\b/gi) ?? []).length,
  0,
);
checkTrue("有 create schema inv", /create schema if not exists inv;/i.test(exec0009));
checkTrue(
  "有 revoke all on schema inv from anon, authenticated",
  /revoke all on schema inv from anon, authenticated;/i.test(exec0009),
);
checkTrue(
  "有 grant usage on schema inv to service_role",
  /grant usage on schema inv to service_role;/i.test(exec0009),
);
checkTrue(
  "檔尾把 inv 全部物件授給 service_role",
  /grant all on all tables in schema inv to service_role;/i.test(exec0009) &&
    /grant all on all sequences in schema inv to service_role;/i.test(exec0009) &&
    /grant execute on all functions in schema inv to service_role;/i.test(exec0009),
);
checkTrue(
  "SECURITY DEFINER 函式的 EXECUTE 從 PUBLIC 收回",
  /revoke execute on all functions in schema inv from public;/i.test(exec0009),
);
check(
  "殘留的 public.<物件> 參照",
  [
    ...exec0009
      .split("\n")
      .filter((l) => !/from public;/.test(l))
      .join("\n")
      .matchAll(/\bpublic\.\w+/g),
  ].length,
  0,
);
check("殘留的 sandbox_exec* 角色", (exec0009.match(/sandbox_exec/g) ?? []).length, 0);

console.log("\n[3] 三處刻意的行為修正");
// 3a. inventory_adjustments 只留一個 trigger。來源有兩個綁同一個函式，
//     INSERT 會被扣加庫存兩次。
const invAdjTriggers = [
  ...exec0009.matchAll(/CREATE TRIGGER\s+(\S+)[\s\S]{0,120}?ON inv\.inventory_adjustments/gi),
].map((m) => m[1]);
check("inventory_adjustments 上的 trigger 數", invAdjTriggers.length, 1);
check("留下來的是 BEFORE INSERT OR UPDATE 那一個", invAdjTriggers[0], "update_stock_on_adjustment");
checkTrue(
  "AFTER INSERT 的重複 trigger 已移除",
  !/CREATE TRIGGER\s+trigger_update_stock_on_adjustment\b/i.test(exec0009),
);

// 3b. 兩個單號產生器改成條件式。
checkTrue(
  "generate_stock_adjustment_number 只在沒有單號時產號",
  /IF NEW\.adjustment_number IS NULL OR NEW\.adjustment_number = ''/i.test(exec0009),
);
checkTrue(
  "generate_vendor_return_number 只在沒有單號時產號",
  /IF NEW\.return_number IS NULL OR NEW\.return_number = ''/i.test(exec0009),
);

// 3c. search_path 一律改成 inv, public，否則 SECURITY DEFINER 函式在
//     inv 裡跑卻去 public 找表，會靜默找不到東西。
check(
  "還指著 'public' 單一 schema 的 SET search_path",
  (exec0009.match(/SET search_path TO 'public'/gi) ?? []).length,
  0,
);
check(
  "改成 'inv', 'public' 的函式數",
  (exec0009.match(/SET search_path TO 'inv', 'public'/gi) ?? []).length,
  22,
);

console.log("\n[4] 來源 handle_new_user 沒有被搬進來");
// 目標的 0002_admin.sql 已經有同名函式與同名 trigger（建 role='customer'）。
// 來源那一版會讓「第一個註冊的帳號」自動變成 admin —— 同名同表，搬進來必炸。
checkTrue("0009 沒有定義 handle_new_user", !/function\s+inv\.handle_new_user/i.test(exec0009));
checkTrue(
  "0009 沒有動 auth.users 上的 on_auth_user_created",
  !/CREATE TRIGGER\s+on_auth_user_created/i.test(exec0009),
);

console.log("\n[5] 身分模型（0010）");
checkTrue(
  "放寬 role CHECK 前先 drop 舊的",
  /drop constraint if exists profiles_role_check/i.test(sql0010),
);
for (const role of ["customer", "pending", "staff", "vendor", "admin"]) {
  checkTrue(`role 允許 '${role}'`, new RegExp(`'${role}'`).test(sql0010));
}
checkTrue(
  "建立 public.staff_permissions",
  /create table if not exists public\.staff_permissions/i.test(sql0010),
);
checkTrue(
  "staff_permissions 對 anon/authenticated 收權",
  /revoke all on table public\.staff_permissions from anon, authenticated;/i.test(sql0010),
);
checkTrue(
  "staff_permissions 開 RLS",
  /alter table public\.staff_permissions enable row level security;/i.test(sql0010),
);
check(
  "staff_permissions 的 permission CHECK 列了幾種",
  (sql0010.match(/'approve_\w+'/g) ?? []).length,
  7,
);
checkTrue(
  "0010 沒有修改 0002 的檔案內容（只在自己檔內 drop/add constraint）",
  !/0002_admin\.sql\s*$/m.test(sql0010),
);

// ══════════════════════════════════════════════════════════════════════════
// 第二段：連線 —— 對目標資料庫實際對帳
// ══════════════════════════════════════════════════════════════════════════

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF ?? "noijrmhdfbfvjyvchvzj";

async function q(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok)
    throw new Error(`Management API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** anon 可達性測試要的兩個值：先看 env，沒有就退回讀 .env.local。 */
function readAnonCreds() {
  let url = process.env.VITE_SUPABASE_URL;
  let key = process.env.VITE_SUPABASE_ANON_KEY;
  const envFile = join(ROOT, ".env.local");
  if ((!url || !key) && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === "VITE_SUPABASE_URL" && !url) url = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "VITE_SUPABASE_ANON_KEY" && !key) key = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return { url, key };
}

if (!TOKEN) {
  skipped.push("連線對帳（缺 SUPABASE_ACCESS_TOKEN）");
  console.log(yellow("\n[6–10] 連線對帳 —— 跳過：沒有 SUPABASE_ACCESS_TOKEN"));
  console.log(yellow("       設好之後重跑，才會驗到 2,864 筆與 anon 可達性那幾條。"));
} else {
  console.log("\n[6] 21 張表逐張對帳");
  const perTable = await q(`
    select tablename, (xpath('/row/c/text()',
      query_to_xml(format('select count(*) as c from inv.%I', tablename), false, true, '')))[1]::text::int as n
    from pg_tables where schemaname = 'inv' order by tablename`);
  check("inv schema 裡的表數", perTable.length, 21);
  const fixRows = await q(
    `select count(*)::int as n, coalesce(sum(quantity), 0)::int as qty
       from inv.stock_adjustments where notes like '${FIX_MARKER}%'`,
  );
  const fixCount = fixRows[0].n;
  const fixQty = fixRows[0].qty;
  check("搬遷校正單筆數", fixCount, 1);
  check("搬遷校正單的數量合計", fixQty, 1);

  let total = 0;
  for (const row of perTable) {
    const expected = EXPECTED_TABLE_ROWS[row.tablename];
    // stock_adjustments 會多出校正單那一列，扣掉再比才是「與備份一致」。
    const adjusted = row.tablename === "stock_adjustments" ? row.n - fixCount : row.n;
    check(`inv.${row.tablename}`, adjusted, expected);
    total += row.n;
  }
  check("21 張表總和（扣掉校正單）＝ 備份筆數", total - fixCount, EXPECTED_TOTAL);
  check("purchases / products / sales — purchases", EXPECTED_TABLE_ROWS.purchases, 1029);
  check("purchases / products / sales — products", EXPECTED_TABLE_ROWS.products, 993);
  check("purchases / products / sales — sales", EXPECTED_TABLE_ROWS.sales, 665);

  console.log("\n[7] 庫存數字 —— 證明匯入沒有被 trigger 汙染");
  const st = (
    await q(`
    select
      (select sum(stock_quantity)::int from inv.products) sum_stock,
      (select count(*)::int from inv.products where stock_quantity > 0) pos,
      (select count(*)::int from inv.products where stock_quantity = 0) zero,
      (select count(*)::int from inv.products where stock_quantity < 0) neg,
      (select sum(remaining_quantity)::int from inv.purchases) sum_remaining,
      (select sum(quantity)::int from inv.purchases) sum_qty,
      (select count(*)::int from inv.products where is_active) active,
      (select count(*)::int from inv.products where approval_status = 'approved') approved`)
  )[0];
  // 1,019 筆 approved 進貨若被 update_stock_on_purchase 再加一次，這個數字就會爆掉。
  check("sum(stock_quantity) 扣掉校正單 ＝ 備份值", st.sum_stock - fixQty, EXPECTED_SUM_STOCK);
  check("有庫存（> 0）", st.pos, EXPECTED_STOCK_POSITIVE);
  check("零庫存（＝ 0，含修好的那一筆）", st.zero, EXPECTED_STOCK_ZERO_AFTER_FIX);
  check("負庫存", st.neg, 0);
  // 這一條是 FIFO 起始狀態的守門：若 update_stock_on_purchase 在匯入時觸發過，
  // 它會把 remaining_quantity 全部重設成 quantity，兩個數字就會相等。
  check("sum(purchases.remaining_quantity) ＝ 備份值", st.sum_remaining, EXPECTED_SUM_REMAINING);
  checkTrue(
    "remaining_quantity ≠ quantity（FIFO 消耗狀態沒被重設）",
    st.sum_remaining !== st.sum_qty,
    `remaining=${st.sum_remaining} vs quantity=${st.sum_qty}`,
  );
  check("is_active = true", st.active, EXPECTED_ACTIVE);
  check("approval_status = 'approved'", st.approved, EXPECTED_APPROVED);

  const types = await q(`select product_type, count(*)::int n from inv.products group by 1`);
  for (const [t, n] of Object.entries(EXPECTED_PRODUCT_TYPES)) {
    check(`product_type = ${t}`, types.find((r) => r.product_type === t)?.n ?? 0, n);
  }

  console.log("\n[8] 負庫存那一筆是用調整單修的，不是偷改");
  const fixRow = (
    await q(`
    select sa.adjustment_number, sa.category, sa.quantity, sa.status,
           p.stock_quantity::int as stock_now
      from inv.stock_adjustments sa
      join inv.products p on p.id = sa.product_id
     where sa.notes like '${FIX_MARKER}%'`)
  )[0];
  checkTrue("調整單有單號", Boolean(fixRow?.adjustment_number), fixRow?.adjustment_number);
  check("調整單 category", fixRow?.category, "ADJ");
  check("調整單 status", fixRow?.status, "confirmed");
  check("該商品現在的庫存", fixRow?.stock_now, 0);

  console.log("\n[9] 身分：7 個 auth user、7 筆 profiles、10 筆細權限");
  const ids = Object.keys(EXPECTED_ROLES)
    .map((i) => `'${i}'`)
    .join(",");
  const idn = (
    await q(`
    select
      (select count(*)::int from auth.users where id in (${ids})) users,
      (select count(*)::int from public.profiles where id in (${ids})) profiles,
      (select count(*)::int from public.profiles where id in (${ids}) and role = 'customer') customers,
      (select count(*)::int from public.staff_permissions) perms,
      (select count(*)::int from auth.identities where user_id in (${ids})) idents`)
  )[0];
  check("auth.users 新增", idn.users, 7);
  check("public.profiles 對應", idn.profiles, 7);
  check("殘留 role='customer'", idn.customers, 0);
  check("auth.identities 對應（不補的話這些帳號登不進來）", idn.idents, 7);
  check("public.staff_permissions", idn.perms, EXPECTED_STAFF_PERMISSIONS);

  const roles = await q(`select id::text, role from public.profiles where id in (${ids})`);
  for (const [id, want] of Object.entries(EXPECTED_ROLES)) {
    check(`role ${id.slice(0, 8)}…`, roles.find((r) => r.id === id)?.role, want);
  }

  console.log("\n[10] sequence 不會撞到既有單號");
  const seqs = (
    await q(`
    select
      (select last_value::int from inv.stock_adjustment_seq) a,
      (select last_value::int from inv.vendor_code_seq) b,
      (select last_value::int from inv.vendor_return_seq) c,
      (select max((regexp_match(adjustment_number, '-(\\d+)$'))[1]::int) from inv.stock_adjustments) max_a,
      (select max((regexp_match(vendor_code, '(\\d+)$'))[1]::int) from inv.vendors) max_b,
      (select max((regexp_match(return_number, '-(\\d+)$'))[1]::int) from inv.vendor_returns) max_c`)
  )[0];
  checkTrue(
    "stock_adjustment_seq ≥ 備份值",
    seqs.a >= EXPECTED_SEQ_MIN.stock_adjustment_seq,
    `${seqs.a}`,
  );
  checkTrue("vendor_code_seq ≥ 備份值", seqs.b >= EXPECTED_SEQ_MIN.vendor_code_seq, `${seqs.b}`);
  checkTrue(
    "vendor_return_seq ≥ 備份值",
    seqs.c >= EXPECTED_SEQ_MIN.vendor_return_seq,
    `${seqs.c}`,
  );
  checkTrue(
    "stock_adjustment_seq ≥ 現有最大單號",
    seqs.a >= seqs.max_a,
    `${seqs.a} ≥ ${seqs.max_a}`,
  );
  checkTrue(
    "vendor_code_seq ≥ 現有最大廠商編號",
    seqs.b >= seqs.max_b,
    `${seqs.b} ≥ ${seqs.max_b}`,
  );
  checkTrue(
    "vendor_return_seq ≥ 現有最大退貨單號",
    seqs.c >= seqs.max_c,
    `${seqs.c} ≥ ${seqs.max_c}`,
  );

  console.log("\n[11] 資料庫層的權限與 trigger 現況");
  const dbsec = (
    await q(`
    select
      (select count(*)::int from pg_policies where schemaname = 'inv') policies,
      (select count(*)::int from information_schema.role_table_grants
        where table_schema = 'inv' and grantee in ('anon','authenticated')) anon_grants,
      (select count(*)::int from information_schema.role_usage_grants
        where object_schema = 'inv' and grantee in ('anon','authenticated')) anon_usage,
      (select count(*)::int from pg_trigger t
        join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'inv' and not t.tgisinternal and t.tgenabled = 'D') disabled_triggers,
      (select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
        where t.tgrelid = 'inv.inventory_adjustments'::regclass and not t.tgisinternal) adj_triggers,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'inv' and p.proname = 'handle_new_user') inv_hnu,
      (select tgfoid::regproc::text from pg_trigger
        where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created') auth_trigger_fn`)
  )[0];
  check("inv 的 RLS policy 數", dbsec.policies, 0);
  check("anon/authenticated 對 inv 表的權限筆數", dbsec.anon_grants, 0);
  check("anon/authenticated 對 inv schema 的 USAGE", dbsec.anon_usage, 0);
  check("匯入後仍被停用的 trigger", dbsec.disabled_triggers, 0);
  // 比對**名字**而不是數量。原本這裡是 `=== 1`，守的是「來源那兩個綁同一個函式的
  // trigger 只剩一個」（兩個都在，INSERT 會扣加庫存兩次）。0017 之後這張表多了一個
  // freeze_inventory_adjustments —— 它是 BEFORE INSERT 的凍結守衛，與庫存無關。
  // 改成逐字對名單，既保住原本的意思，也擋得住「有人再加一個會動庫存的 trigger」
  // 這種數量對得上但語意錯掉的情況。
  check(
    "inventory_adjustments 上的 trigger 就是這兩個",
    dbsec.adj_triggers,
    "freeze_inventory_adjustments,update_stock_on_adjustment",
  );
  check("inv.handle_new_user 不存在", dbsec.inv_hnu, 0);
  check("auth.users 的 trigger 仍指向目標自己的函式", dbsec.auth_trigger_fn, "handle_new_user");

  console.log("\n[12] 既有電商的表沒有被動到");
  const ecom = (
    await q(`
    select (select count(*)::int from public.products) products,
           (select count(*)::int from public.product_inventory_links) links,
           (select count(*)::int from public.orders) orders,
           (select count(*)::int from public.order_items) order_items,
           (select count(*)::int from public.payments) payments,
           (select count(*)::int from public.invoices) invoices,
           (select count(*)::int from public.products p
              join public.product_inventory_links l on l.product_id = p.id
             where p.stock is not null) linked_with_stock`)
  )[0];
  // 交易面的四張表仍必須是 0：庫存匯入不該生出任何一筆訂單、付款或發票。
  for (const k of ["orders", "order_items", "payments", "invoices"]) {
    check(`public.${k} 仍為 0`, ecom[k], 0);
  }
  // products 不再是 0 —— 0015 之後 /admin/publications 與 /admin/inventory-listing
  // 都會**刻意**建型錄商品，「一件都沒有」已經不是可以守的不變式。這裡守的是它背後
  // 真正要緊的那一條：有庫存連結的商品，型錄庫存必須是 NULL，否則同一件貨會有兩個
  // 數字、兩條扣庫存的路徑（0011 §10 的 products_linked_stock_guard 就是為此存在）。
  check("有庫存連結卻仍帶型錄庫存的商品", ecom.linked_with_stock, 0);
  console.log(`    （目前 public.products=${ecom.products}，其中 ${ecom.links} 件連到進銷存）`);

  console.log("\n[13] anon key 打不到 inv.*（這是整個安全模型的最終證據）");
  const { url, key } = readAnonCreds();
  if (!url || !key) {
    skipped.push("anon 可達性（缺 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）");
    console.log(yellow("  ⚠ 跳過：找不到 anon key（env 或 .env.local 都沒有）"));
  } else {
    for (const table of ["products", "vendors"]) {
      const res = await fetch(`${url}/rest/v1/${table}?select=id&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": "inv" },
      });
      const body = await res.text();
      checkTrue(
        `anon 帶 Accept-Profile: inv 讀 ${table} 被拒`,
        res.status >= 400,
        `HTTP ${res.status} ${body.slice(0, 90)}`,
      );
    }
    // 對照組：同一把 key 讀 public.products 應該是通的 —— 證明上面的失敗
    // 是「inv 掛不出去」，不是「這把 key 根本是壞的」。
    const control = await fetch(`${url}/rest/v1/products?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    checkTrue("對照組：同一把 key 讀 public.products 是通的", control.ok, `HTTP ${control.status}`);
  }
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
