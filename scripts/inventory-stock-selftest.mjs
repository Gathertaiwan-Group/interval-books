#!/usr/bin/env node
/**
 * inventory-stock-selftest.mjs —— 庫存單一真相（0011）的併發自檢
 *
 * 分兩段，理由與 inventory-migration-selftest 相同：這支測試在沒有金鑰的機器上
 * 也必須有意義。
 *
 *   [靜態] 讀 supabase/migrations/0011 與 0012 的檔案內容，守的是**設計不變量**：
 *          四支函式有沒有 security definer、有沒有 revoke、product_availability
 *          有沒有只暴露三個欄位、commit 有沒有真的用 DELETE…RETURNING 當 claim。
 *          這些答案就寫在檔案裡，不連線也回答得出來。永遠會跑。
 *
 *   [併發] 對目標資料庫**真的同時發請求**。每一次 q() 都是一個獨立的
 *          Management API HTTP 呼叫，也就是一條獨立的連線與一個獨立的交易，
 *          所以 Promise.all 出來的就是真正的併發，不是模擬。
 *          需要 SUPABASE_ACCESS_TOKEN；沒有就整段 skip（會印出來，不會靜悄悄消失）。
 *
 * ⚠️ 這支測試會在**正式資料庫**建立資料再刪掉。所有測試資料都帶著固定的前綴
 *    （見 MARK / SLUG_PREFIX / KEY_PREFIX），而且**開頭與結尾各清一次** ——
 *    開頭那次是為了讓上一輪中途掛掉留下的殘骸不會累積。
 *
 * ⚠️ 第 5 條（過期回收）會呼叫 expire_unpaid_orders(interval '0')，那支函式**不能
 *    只掃一張訂單**。所以呼叫前會先確認「除了本測試自己的訂單之外，沒有別的
 *    pending 未付款訂單」；有的話這一條會 skip 而不是把真客人的訂單掃掉。
 *
 * 執行：
 *   node scripts/inventory-stock-selftest.mjs                    # 只跑靜態
 *   SUPABASE_ACCESS_TOKEN=sbp_… node scripts/inventory-stock-selftest.mjs
 *
 * 環境變數：
 *   SUPABASE_ACCESS_TOKEN   Management API token（併發段的開關）
 *   SUPABASE_PROJECT_REF    目標專案 ref，預設 noijrmhdfbfvjyvchvzj（2026-10 三站合併後的專案；小時光的表仍在 public／inv）
 *   VITE_SUPABASE_URL       anon 外洩測試用；沒設會去讀 .env.local
 *   VITE_SUPABASE_ANON_KEY  同上
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/inventory-stock-selftest.mjs";

const MIG_0011 = join(ROOT, "supabase/migrations/0011_inventory_single_source.sql");
const MIG_0012 = join(ROOT, "supabase/migrations/0012_inventory_listing_admin_views.sql");

/** 測試資料的固定標記。刪除全部靠這三個前綴，所以它們必須夠特別。 */
const MARK = "__invselftest__";
const SLUG_PREFIX = "invselftest-";
const KEY_PREFIX = "invselftest-";

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

function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

// -----------------------------------------------------------------------------
// [1]–[3] 靜態：設計不變量就寫在 migration 檔案裡
// -----------------------------------------------------------------------------

console.log("\n[1] migration 檔案存在");
check("0011 存在", existsSync(MIG_0011), true);
check("0012 存在", existsSync(MIG_0012), true);
// 這一期不准動到既有的 0001–0010，所以它們也必須都還在。
for (const f of [
  "0004_commerce_products.sql",
  "0006_order_expiry.sql",
  "0009_inventory_schema.sql",
  "0010_inventory_identity.sql",
]) {
  check(`${f} 仍在`, existsSync(join(ROOT, "supabase/migrations", f)), true);
}

// 不加 `existsSync(…) ? … : ""` 的守衛：回空字串會讓下面所有「確認 SQL 裡沒有 X」的
// 否定斷言在路徑打錯時靜默通過。讀不到就讓它炸，訊息裡有路徑。（見 run-selftests.mjs 守門 4）
const sql0011 = readFileSync(MIG_0011, "utf8");
const sql0012 = readFileSync(MIG_0012, "utf8");
/** 把 `--` 註解整行拿掉，免得註解裡提到的字串讓下面的斷言假性通過。 */
const exec0011 = sql0011
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const exec0012 = sql0012
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

console.log("\n[2] 0011 的設計不變量");
// 反空殼：先證明檔案真的有內容，否則下面每一條 includes() 都會是假性失敗／通過。
checkTrue("0011 不是空檔（> 8000 字）", exec0011.length > 8000);

check(
  "四支新函式都建了",
  [
    "function public.reserve_inventory_stock",
    "function public.commit_inventory_reservations",
    "function public.release_inventory_reservations",
    "function inv.resolve_stock_target",
  ].filter((s) => exec0011.includes(s)).length,
  4,
);
check(
  "四支都 revoke 給 public/anon/authenticated",
  [
    "public.reserve_inventory_stock(uuid, jsonb)",
    "public.commit_inventory_reservations(uuid, uuid)",
    "public.release_inventory_reservations(uuid)",
    "inv.resolve_stock_target(uuid)",
  ].filter((s) => exec0011.includes(s)).length,
  4,
);
checkTrue(
  "revoke ... from public 這一句在",
  exec0011.includes("revoke execute on function %s from public"),
);
checkTrue(
  "grant 給 service_role",
  exec0011.includes("grant  execute on function %s to service_role"),
);

// 併發正確性的關鍵：三支會動庫存的函式都要有 order by … for update。
check(
  "for update 出現次數（reserve/commit/release/trigger/expire 各一以上）",
  (exec0011.match(/for update/gi) ?? []).length >= 5,
  true,
);
checkTrue("鎖是依 id 排序取的", /order by ip\.id\s*\n?\s*for update/i.test(exec0011));

// 冪等 claim：沒有 DELETE…RETURNING 就不是 claim，webhook 重送會重複扣庫存。
checkTrue(
  "commit 用 DELETE…RETURNING 當冪等 claim",
  /delete from public\.stock_reservations[\s\S]{0,200}returning/i.test(exec0011),
);
/**
 * 切出單一函式的本體。
 *
 * 不能用「從函式名開始到下一個 $$; 為止」的 lazy 比對 —— 那條 regex 會一路吃過
 * 函式邊界（這支測試第一次跑就是這樣假性失敗的）。從宣告切到它自己的 comment on
 * 才是真正的邊界。
 */
function functionBody(sql, signature) {
  const start = sql.indexOf(`create or replace function ${signature}`);
  if (start === -1) return "";
  const end = sql.indexOf(`comment on function ${signature}`, start);
  return sql.slice(start, end === -1 ? sql.length : end);
}

const commitBody = functionBody(exec0011, "public.commit_inventory_reservations");
// 反空殼：先確定真的切出東西了，否則下面那條「沒有 X」永遠會通過。
checkTrue("切得出 commit 的函式本體", commitBody.length > 500);
// commit 不可以有任何「庫存不足就拋錯」的路徑：錢已經收了，拋錯會讓訂單被
// expire_unpaid_orders() 取消掉，變成「客人付了錢卻沒有訂單」。
checkTrue("commit 沒有 INSUFFICIENT_STOCK 的 raise", !commitBody.includes("INSUFFICIENT_STOCK"));
checkTrue(
  "commit 只有 NULL_ORDER_ID 一種 raise",
  (commitBody.match(/raise exception/gi) ?? []).length === 1,
);
checkTrue("commit 會寫 stock_oversold_alerts", commitBody.includes("'online_commit'"));
// 反面對照：reserve **必須**有那個 raise，否則上面那條「沒有」是因為整個檔案都沒有。
const reserveBody = functionBody(exec0011, "public.reserve_inventory_stock");
checkTrue("reserve 有 INSUFFICIENT_STOCK 的 raise", reserveBody.includes("INSUFFICIENT_STOCK"));

// 三張表都要 RLS 開著、零 policy、瀏覽器零 grant。
check("0011 一條 policy 都沒建", (exec0011.match(/create policy/gi) ?? []).length, 0);
check(
  "三張新表都 enable row level security",
  (exec0011.match(/enable row level security/gi) ?? []).length,
  3,
);
check(
  "三張新表都 revoke anon/authenticated",
  (exec0011.match(/revoke all on table public\.\w+ from anon, authenticated/gi) ?? []).length,
  3,
);

// product_availability 只能有三個欄位，而且必須是 anon 讀得到的那一個。
checkTrue("product_availability 建了", exec0011.includes("view public.product_availability"));
checkTrue("只暴露 in_stock", exec0011.includes("as in_stock"));
checkTrue("只暴露 available_capped", exec0011.includes("as available_capped"));
checkTrue("上限是 10", /least\(v\.units, 10\)/.test(exec0011));
checkTrue(
  "grant select 給 anon",
  exec0011.includes("grant select on public.product_availability to anon, authenticated"),
);
checkTrue("view 只看 active 商品", /where p\.status = 'active'/.test(exec0011));
checkTrue(
  "view 沒有暴露 stock_quantity 這個欄位名",
  !/as\s+stock_quantity/i.test(exec0011.split("view public.product_availability")[1] ?? ""),
);

// 型錄與庫存不可以同時管同一件商品。
checkTrue("有 products 端的 stock NULL trigger", exec0011.includes("products_linked_stock_guard"));
checkTrue(
  "有 link 端的 stock NULL trigger",
  exec0011.includes("product_inventory_links_stock_guard"),
);

// POS 的逃生門。
checkTrue("update_stock_on_sale 被覆寫", exec0011.includes("function inv.update_stock_on_sale()"));
checkTrue(
  "channel 預設 pos",
  exec0011.includes("add column if not exists channel text not null default 'pos'"),
);
checkTrue("override 會留痕", exec0011.includes("'pos_override'"));

// ⚠️ 0020 之後，`expire_unpaid_orders()` 與 `product_availability` 這兩樣東西的
//    **現行定義在 0020，不在 0011**。上面那幾條讀的是 0011 這個檔案，守的是
//    「0011 當時說了什麼」不要被人偷改；「現在生效的是什麼」由
//    scripts/event-registration-selftest.mjs 對 0020 驗。兩支各守一半，不要把
//    其中一支的斷言搬到另一支去。
//
// expire 的回傳形狀不能變（改了要先 DROP，而 DROP 會影響已排程的呼叫）。
checkTrue("expire_unpaid_orders 被覆寫", exec0011.includes("function public.expire_unpaid_orders"));
checkTrue("expire 回傳形狀不變", exec0011.includes("restored_stock   integer"));
checkTrue(
  "expire 會刪保留列",
  /delete from public\.stock_reservations r\s*\n\s*where r\.order_id = any\(v_ids\)/.test(exec0011),
);

console.log("\n[3] 0012 的設計不變量");
checkTrue(
  "兩個後台 view 都建了",
  exec0012.includes("view public.inv_listing_candidates") &&
    exec0012.includes("view public.inv_listed_products"),
);
checkTrue(
  "後台 view 不給 anon",
  exec0012.includes("revoke all on public.inv_listing_candidates from anon, authenticated") &&
    exec0012.includes("revoke all on public.inv_listed_products   from anon, authenticated"),
);
checkTrue(
  "後台 view 只給 service_role",
  exec0012.includes("grant select on public.inv_listing_candidates to service_role"),
);

// -----------------------------------------------------------------------------
// 連線層
// -----------------------------------------------------------------------------

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const REF = process.env.SUPABASE_PROJECT_REF ?? "noijrmhdfbfvjyvchvzj";

/**
 * 送一句 SQL。**不 throw** —— 併發測試需要拿到「誰失敗了、為什麼」，
 * 而不是被第一個預期中的失敗炸掉。
 */
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

/** 只在「這句一定要成功」的時候用。失敗就整支測試中止（前置條件壞了）。 */
async function must(sql) {
  const r = await q(sql);
  if (!r.ok)
    throw new Error(`SQL 失敗：${r.error.slice(0, 400)}\n--- SQL ---\n${sql.slice(0, 600)}`);
  return r.rows;
}

const one = (rows) => (Array.isArray(rows) && rows.length > 0 ? rows[0] : null);

/** FK 安全的清理順序。開頭與結尾各跑一次。 */
const CLEANUP_SQL = `
-- 1. sales 先走：web_order_id 對 orders 沒有 cascade，product_id 是 SET NULL
--    （留著會變成 orphan，讓 migration selftest 的 665 筆對不上）。
delete from inv.sales s
 where s.product_id in (select p.id from inv.products p where p.name like '${MARK}%')
    or s.web_order_id in (select o.id from public.orders o where o.idempotency_key like '${KEY_PREFIX}%');
-- 2. 告警（inv_product_id 是 restrict）
delete from public.stock_oversold_alerts a
 where a.inv_product_id in (select p.id from inv.products p where p.name like '${MARK}%');
-- 3. 保留列（inv_product_id 是 restrict）
delete from public.stock_reservations r
 where r.inv_product_id in (select p.id from inv.products p where p.name like '${MARK}%')
    or r.order_id in (select o.id from public.orders o where o.idempotency_key like '${KEY_PREFIX}%');
-- 4. 連結（inv_product_id 是 restrict）
delete from public.product_inventory_links l
 where l.product_id like '${SLUG_PREFIX}%'
    or l.inv_product_id in (select p.id from inv.products p where p.name like '${MARK}%');
-- 5. 訂單（order_items / order_addresses / invoices 靠 cascade）
delete from public.orders where idempotency_key like '${KEY_PREFIX}%';
-- 6. 型錄商品
delete from public.products where id like '${SLUG_PREFIX}%';
-- 7. 進銷存品項（base_product_id 是 SET NULL，所以順序無所謂）
delete from inv.products where name like '${MARK}%';
`;

if (!TOKEN) {
  skipped.push("併發測試（缺 SUPABASE_ACCESS_TOKEN）");
  console.log(yellow("\n[4–11] 併發測試 —— 跳過：沒有 SUPABASE_ACCESS_TOKEN"));
  console.log(
    yellow("       設好之後重跑，才會驗到超賣、冪等、POS 交叉、pack_size、過期、死鎖那七條。"),
  );
} else {
  // ---------------------------------------------------------------------------
  // 前置：清掉殘骸，記下基準線，建立 fixture
  // ---------------------------------------------------------------------------
  console.log("\n[4] 前置：清理殘骸並建立測試資料");
  // 先數再清。有殘骸就代表上一輪被中斷了（Ctrl-C、逾時被砍），而那件事有後果：
  // run-selftests 是照檔名排序跑的，inventory-migration-selftest 排在這支**前面**，
  // 所以它會先看到那些殘骸，然後在「21 張表總和 = 2,864」那幾條上紅掉。
  // 下面這句清完之後就會自己好，但沒有這行警告的話，那次紅燈看起來會像是資料真的少了。
  const debris = one(
    await must(`select
        (select count(*)::int from inv.products where name like '${MARK}%')
      + (select count(*)::int from public.products where id like '${SLUG_PREFIX}%')
      + (select count(*)::int from public.orders where idempotency_key like '${KEY_PREFIX}%') n`),
  ).n;
  if (Number(debris) > 0) {
    console.log(yellow(`  ⚠ 找到 ${debris} 筆上一輪留下的殘骸（上次被中斷了）。清掉再繼續。`));
    console.log(
      yellow(
        "     若 inventory-migration-selftest 這一輪也紅了，原因就是它排在前面、先看到了這些。",
      ),
    );
  }
  await must(CLEANUP_SQL);

  const baseline = one(
    await must(`select
        (select count(*)::int from inv.products) inv_products,
        (select coalesce(sum(stock_quantity),0)::int from inv.products) sum_stock,
        (select count(*)::int from inv.sales) inv_sales,
        (select count(*)::int from public.products) pub_products,
        (select count(*)::int from public.stock_reservations) reservations,
        (select count(*)::int from public.stock_oversold_alerts) alerts,
        (select count(*)::int from public.orders) orders,
        (select count(*)::int from public.product_inventory_links) links,
        (select count(*)::int from inv.sales where product_id is null) orphan_sales`),
  );
  console.log(
    `    基準線：inv.products=${baseline.inv_products} sum_stock=${baseline.sum_stock} ` +
      `inv.sales=${baseline.inv_sales} public.products=${baseline.pub_products}`,
  );

  // 借一個既有的 auth.users id 當 inv.products.user_id（NOT NULL + FK）。
  // 絕不新建或刪除 auth 使用者。
  const owner = one(await must(`select user_id from inv.products limit 1`)).user_id;

  const P = {
    single: "aaaa0000-0000-4000-8000-000000000001", // 庫存 1，測超賣
    cross: "aaaa0000-0000-4000-8000-000000000002", // 庫存 2，測 POS 交叉
    packBase: "aaaa0000-0000-4000-8000-000000000003", // pack 的 base，庫存 100
    pack: "aaaa0000-0000-4000-8000-000000000004", // pack_size = 10
    expire: "aaaa0000-0000-4000-8000-000000000005", // 測過期回收
    lockA: "aaaa0000-0000-4000-8000-000000000006", // 死鎖測試 A（id 較小）
    lockB: "aaaa0000-0000-4000-8000-000000000007", // 死鎖測試 B（id 較大）
  };
  const S = {
    single: `${SLUG_PREFIX}single`,
    cross: `${SLUG_PREFIX}cross`,
    pack: `${SLUG_PREFIX}pack`,
    expire: `${SLUG_PREFIX}expire`,
    legacy: `${SLUG_PREFIX}legacy`,
    lockA: `${SLUG_PREFIX}lock-a`,
    lockB: `${SLUG_PREFIX}lock-b`,
  };
  const LOC = `'{"zh":"自檢","en":"selftest","ja":"セルフテスト"}'::jsonb`;

  await must(`
    insert into inv.products (id, user_id, name, selling_price, stock_quantity, pack_size, base_product_id, is_active, approval_status) values
      ('${P.single}',  '${owner}', '${MARK}single',   100, 1,   1,  null, true, 'approved'),
      ('${P.cross}',   '${owner}', '${MARK}cross',    100, 2,   1,  null, true, 'approved'),
      ('${P.packBase}','${owner}', '${MARK}packbase',  10, 100, 1,  null, true, 'approved'),
      ('${P.expire}',  '${owner}', '${MARK}expire',   100, 7,   1,  null, true, 'approved'),
      ('${P.lockA}',   '${owner}', '${MARK}lock-a',   100, 50,  1,  null, true, 'approved'),
      ('${P.lockB}',   '${owner}', '${MARK}lock-b',   100, 50,  1,  null, true, 'approved');
    insert into inv.products (id, user_id, name, selling_price, stock_quantity, pack_size, base_product_id, is_active, approval_status) values
      ('${P.pack}', '${owner}', '${MARK}pack10', 100, 0, 10, '${P.packBase}', true, 'approved');

    insert into public.products (id, slug, product_type, title, summary, description, price, stock, status) values
      ('${S.single}','${S.single}','goods',${LOC},${LOC},${LOC},100,null,'active'),
      ('${S.cross}', '${S.cross}', 'goods',${LOC},${LOC},${LOC},100,null,'active'),
      ('${S.pack}',  '${S.pack}',  'goods',${LOC},${LOC},${LOC},100,null,'active'),
      ('${S.expire}','${S.expire}','goods',${LOC},${LOC},${LOC},100,null,'active'),
      ('${S.lockA}', '${S.lockA}', 'goods',${LOC},${LOC},${LOC},100,null,'active'),
      ('${S.lockB}', '${S.lockB}', 'goods',${LOC},${LOC},${LOC},100,null,'active'),
      ('${S.legacy}','${S.legacy}','goods',${LOC},${LOC},${LOC},100,5,   'active');

    insert into public.product_inventory_links (product_id, inv_product_id) values
      ('${S.single}','${P.single}'),
      ('${S.cross}', '${P.cross}'),
      ('${S.pack}',  '${P.pack}'),
      ('${S.expire}','${P.expire}'),
      ('${S.lockA}', '${P.lockA}'),
      ('${S.lockB}', '${P.lockB}');
  `);
  checkTrue("fixture 建立完成", true);

  /** 一個「下單」：建訂單 + 明細 + 保留，全在一個交易裡（等同 createOrder 的 2/3/6a）。 */
  const placeOrderSql = (key, items) => `
    do $$
    declare v_order uuid;
    begin
      insert into public.orders
        (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
      values ('selftest','selftest@example.invalid','0900000000',100,100,'${key}')
      returning id into v_order;
      ${items
        .map(
          (it) => `insert into public.order_items
            (order_id, product_id, name, unit_price, quantity, subtotal, product_type)
          values (v_order, '${it.slug}', ${LOC}, 100, ${it.qty}, 100, 'goods');`,
        )
        .join("\n      ")}
      perform public.reserve_inventory_stock(
        v_order,
        '${JSON.stringify(items.map((it) => ({ product_id: it.slug, quantity: it.qty })))}'::jsonb
      );
    end $$;
  `;

  try {
    // -------------------------------------------------------------------------
    // [5] 超賣：可售 1，同時 20 個下單請求
    // -------------------------------------------------------------------------
    console.log("\n[5] 超賣 —— 可售 1，同時發 20 個下單請求");
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        q(placeOrderSql(`${KEY_PREFIX}race-${i}`, [{ slug: S.single, qty: 1 }])),
      ),
    );
    const won = attempts.filter((r) => r.ok).length;
    const lost = attempts.filter((r) => !r.ok);
    const lostForRightReason = lost.filter((r) => /INSUFFICIENT_STOCK/.test(r.error)).length;

    check("恰好 1 個成功", won, 1);
    check("19 個失敗", lost.length, 19);
    check("19 個都是 INSUFFICIENT_STOCK（不是別的錯）", lostForRightReason, 19);
    check(
      "stock_reservations 恰好 1 列",
      Number(
        one(
          await must(
            `select count(*)::int n from public.stock_reservations where inv_product_id='${P.single}'`,
          ),
        ).n,
      ),
      1,
    );
    check(
      "實體庫存仍為 1（尚未付款，一動也沒動）",
      Number(one(await must(`select stock_quantity n from inv.products where id='${P.single}'`)).n),
      1,
    );
    check(
      "inv.sales 沒有多出任何列",
      Number(one(await must(`select count(*)::int n from inv.sales`)).n),
      baseline.inv_sales,
    );
    check(
      "前台可售量歸零",
      Number(
        one(
          await must(
            `select available_capped n from public.product_availability where product_id='${S.single}'`,
          ),
        ).n,
      ),
      0,
    );

    // -------------------------------------------------------------------------
    // [6] 重複 commit：webhook 重送
    // -------------------------------------------------------------------------
    console.log("\n[6] 重複 commit —— 同一張訂單 commit 三次");
    const raceOrder = one(
      await must(
        `select o.id from public.orders o
          join public.stock_reservations r on r.order_id = o.id
         where r.inv_product_id = '${P.single}' limit 1`,
      ),
    ).id;

    const c1 = Number(
      one(await must(`select public.commit_inventory_reservations('${raceOrder}', null) n`)).n,
    );
    const c2 = Number(
      one(await must(`select public.commit_inventory_reservations('${raceOrder}', null) n`)).n,
    );
    const c3 = Number(
      one(await must(`select public.commit_inventory_reservations('${raceOrder}', null) n`)).n,
    );

    check("第 1 次沒有賣超（回 0）", c1, 0);
    check("第 2 次回 0（重送）", c2, 0);
    check("第 3 次回 0（重送）", c3, 0);
    check(
      "inv.sales 只有 1 列 channel=online",
      Number(
        one(await must(`select count(*)::int n from inv.sales where web_order_id='${raceOrder}'`))
          .n,
      ),
      1,
    );
    check(
      "那一列真的是 online",
      one(await must(`select channel from inv.sales where web_order_id='${raceOrder}'`)).channel,
      "online",
    );
    check(
      "庫存只減 1 次（1 → 0）",
      Number(one(await must(`select stock_quantity n from inv.products where id='${P.single}'`)).n),
      0,
    );
    check(
      "保留列已被 claim 掉",
      Number(
        one(
          await must(
            `select count(*)::int n from public.stock_reservations where order_id='${raceOrder}'`,
          ),
        ).n,
      ),
      0,
    );

    // -------------------------------------------------------------------------
    // [7] POS × 網站交叉
    // -------------------------------------------------------------------------
    console.log("\n[7] POS × 網站交叉 —— 庫存 2，網站保留 1");
    await must(placeOrderSql(`${KEY_PREFIX}cross-1`, [{ slug: S.cross, qty: 1 }]));
    check(
      "網站保留 1 之後，庫存仍是 2",
      Number(one(await must(`select stock_quantity n from inv.products where id='${P.cross}'`)).n),
      2,
    );

    const posSale = (extra = "") => `
      insert into inv.sales (user_id, product_id, quantity, unit_price, amount${extra ? ", override_reservation" : ""})
      values ('${owner}','${P.cross}',1,100,100${extra ? ", true" : ""});`;

    const pos1 = await q(posSale());
    checkTrue("POS 賣第 1 個成功", pos1.ok);
    check(
      "庫存 2 → 1",
      Number(one(await must(`select stock_quantity n from inv.products where id='${P.cross}'`)).n),
      1,
    );

    const pos2 = await q(posSale());
    checkTrue("POS 賣第 2 個必須失敗（那 1 個是網站保留的）", !pos2.ok);
    checkTrue(
      "失敗原因是 INSUFFICIENT_STOCK",
      pos2.ok ? false : /INSUFFICIENT_STOCK/.test(pos2.error),
    );
    check(
      "失敗之後庫存沒有被動到",
      Number(one(await must(`select stock_quantity n from inv.products where id='${P.cross}'`)).n),
      1,
    );

    const pos3 = await q(posSale("override"));
    checkTrue("帶 override_reservation=true 再賣成功", pos3.ok);
    check(
      "庫存 1 → 0",
      Number(one(await must(`select stock_quantity n from inv.products where id='${P.cross}'`)).n),
      0,
    );
    const alert = one(
      await must(
        `select source, shortfall, order_id, sale_id from public.stock_oversold_alerts
          where inv_product_id='${P.cross}' order by id desc limit 1`,
      ),
    );
    checkTrue("寫入了告警", alert !== null);
    check("告警來源是 pos_override", alert?.source, "pos_override");
    check("shortfall = 1", Number(alert?.shortfall), 1);
    check("櫃檯強制放行沒有對應訂單", alert?.order_id, null);
    checkTrue("告警指得出是哪一筆銷售", Boolean(alert?.sale_id));

    // -------------------------------------------------------------------------
    // [8] pack_size
    // -------------------------------------------------------------------------
    console.log("\n[8] pack_size —— base_product_id 非空、pack_size=10，下單 1");
    await must(placeOrderSql(`${KEY_PREFIX}pack-1`, [{ slug: S.pack, qty: 1 }]));
    const packRes = one(
      await must(
        `select inv_product_id, quantity from public.stock_reservations
          where order_id = (select id from public.orders where idempotency_key='${KEY_PREFIX}pack-1')`,
      ),
    );
    check("保留的目標是 base product，不是 pack", packRes?.inv_product_id, P.packBase);
    check("保留的數量已經乘過 pack_size（10）", Number(packRes?.quantity), 10);

    const packOrder = one(
      await must(`select id from public.orders where idempotency_key='${KEY_PREFIX}pack-1'`),
    ).id;
    await must(`select public.commit_inventory_reservations('${packOrder}', null)`);
    check(
      "base product 的庫存減 10，不是 1",
      Number(
        one(await must(`select stock_quantity n from inv.products where id='${P.packBase}'`)).n,
      ),
      90,
    );
    check(
      "pack 自己的庫存沒被動到",
      Number(one(await must(`select stock_quantity n from inv.products where id='${P.pack}'`)).n),
      0,
    );
    // sales 存的是**原始**品項與**原始**數量，讓既有 trigger 自己再解析一次。
    const packSale = one(
      await must(`select product_id, quantity from inv.sales where web_order_id='${packOrder}'`),
    );
    check("inv.sales 記的是 pack 品項本身", packSale?.product_id, P.pack);
    check("inv.sales 記的是原始數量 1", Number(packSale?.quantity), 1);

    // -------------------------------------------------------------------------
    // [9] 過期回收
    // -------------------------------------------------------------------------
    console.log("\n[9] 過期回收 —— 下單不付，expire_unpaid_orders(interval '0')");
    const stockBefore = Number(
      one(await must(`select stock_quantity n from inv.products where id='${P.expire}'`)).n,
    );
    const salesBefore = Number(one(await must(`select count(*)::int n from inv.sales`)).n);
    await must(placeOrderSql(`${KEY_PREFIX}expire-1`, [{ slug: S.expire, qty: 3 }]));
    check(
      "保留期間實體庫存沒變",
      Number(one(await must(`select stock_quantity n from inv.products where id='${P.expire}'`)).n),
      stockBefore,
    );

    // expire_unpaid_orders 沒辦法只掃一張訂單。掃到真客人的待付款訂單會把它取消掉，
    // 所以先確認除了自己的以外沒有別的 pending —— 有的話寧可 skip 也不動它。
    const foreign = Number(
      one(
        await must(`select count(*)::int n from public.orders o
                     where o.status='pending' and o.payment_status<>'paid' and o.paid_at is null
                       and (o.idempotency_key is null or o.idempotency_key not like '${KEY_PREFIX}%')`),
      ).n,
    );
    if (foreign > 0) {
      skipped.push(`過期回收（有 ${foreign} 張非本測試的待付款訂單，不掃）`);
      console.log(yellow(`  ⚠ 有 ${foreign} 張別人的待付款訂單，這一條跳過以免掃到真客人的單`));
      await must(`select public.release_inventory_reservations(
                    (select id from public.orders where idempotency_key='${KEY_PREFIX}expire-1'))`);
    } else {
      await must(`select * from public.expire_unpaid_orders(interval '0', 200)`);
      const expiredOrder = one(
        await must(
          `select id, status from public.orders where idempotency_key='${KEY_PREFIX}expire-1'`,
        ),
      );
      check("訂單被取消", expiredOrder?.status, "cancelled");
      check(
        "保留列被刪掉",
        Number(
          one(
            await must(
              `select count(*)::int n from public.stock_reservations where order_id='${expiredOrder.id}'`,
            ),
          ).n,
        ),
        0,
      );
      check(
        "實體庫存從頭到尾沒變過",
        Number(
          one(await must(`select stock_quantity n from inv.products where id='${P.expire}'`)).n,
        ),
        stockBefore,
      );
      check(
        "inv.sales 沒有多出任何列（報表沒被汙染）",
        Number(one(await must(`select count(*)::int n from inv.sales`)).n),
        salesBefore,
      );
    }

    // -------------------------------------------------------------------------
    // [10] 既有路徑不變
    // -------------------------------------------------------------------------
    console.log("\n[10] 既有路徑不變 —— 沒有 link、public.products.stock=5");
    check(
      "沒有連結列",
      Number(
        one(
          await must(
            `select count(*)::int n from public.product_inventory_links where product_id='${S.legacy}'`,
          ),
        ).n,
      ),
      0,
    );
    // ⚠️ 用一張**自己新建**的訂單，不要借用第 5 條那 20 張裡的任何一張。
    // 那一條裡誰贏是不確定的，借 race-0 會在「race-0 剛好不是贏家」的那幾次跑
    // 變成 NULL_ORDER_ID —— 一個只有在完整跑整套時才會現形的 flaky。
    await must(`insert into public.orders
                  (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
                values ('selftest','selftest@example.invalid','0900000000',100,100,'${KEY_PREFIX}legacy-1')`);
    const legacyOrder = one(
      await must(`select id from public.orders where idempotency_key='${KEY_PREFIX}legacy-1'`),
    ).id;
    check(
      "reserve 對它視而不見（回 0 列）",
      Number(
        one(
          await must(`select public.reserve_inventory_stock('${legacyOrder}',
                        '[{"product_id":"${S.legacy}","quantity":1}]'::jsonb) n`),
        ).n,
      ),
      0,
    );
    await must(
      `select public.atomic_deduct_stock('[{"product_id":"${S.legacy}","quantity":2}]'::jsonb)`,
    );
    check(
      "atomic_deduct_stock 照舊：5 → 3",
      Number(one(await must(`select stock n from public.products where id='${S.legacy}'`)).n),
      3,
    );
    check(
      "可售量 view 對它回報型錄庫存",
      Number(
        one(
          await must(
            `select available_capped n from public.product_availability where product_id='${S.legacy}'`,
          ),
        ).n,
      ),
      3,
    );

    // -------------------------------------------------------------------------
    // [11] 死鎖：兩品項、順序相反、同時下單
    // -------------------------------------------------------------------------
    console.log("\n[11] 死鎖 —— 兩張訂單各含 A、B 但順序相反，同時發 16 個");
    const pairs = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        q(
          placeOrderSql(
            `${KEY_PREFIX}lock-${i}`,
            i % 2 === 0
              ? [
                  { slug: S.lockA, qty: 1 },
                  { slug: S.lockB, qty: 1 },
                ]
              : [
                  { slug: S.lockB, qty: 1 },
                  { slug: S.lockA, qty: 1 },
                ],
          ),
        ),
      ),
    );
    const deadlocks = pairs.filter((r) => !r.ok && /deadlock detected/i.test(r.error));
    const otherErrors = pairs.filter((r) => !r.ok && !/deadlock detected/i.test(r.error));
    check("沒有任何一筆 deadlock detected", deadlocks.length, 0);
    check("16 筆全部完成（庫存 50 綽綽有餘）", pairs.filter((r) => r.ok).length, 16);
    check("沒有其他非預期錯誤", otherErrors.length, 0);
    check(
      "A 的保留總量 = 16",
      Number(
        one(
          await must(
            `select coalesce(sum(quantity),0)::int n from public.stock_reservations where inv_product_id='${P.lockA}'`,
          ),
        ).n,
      ),
      16,
    );
    check(
      "B 的保留總量 = 16",
      Number(
        one(
          await must(
            `select coalesce(sum(quantity),0)::int n from public.stock_reservations where inv_product_id='${P.lockB}'`,
          ),
        ).n,
      ),
      16,
    );

    // -------------------------------------------------------------------------
    // [12] anon 讀得到可售量，讀不到精確庫存
    // -------------------------------------------------------------------------
    console.log("\n[12] anon 的可見範圍");
    const { url, key } = readAnonCreds();
    if (!url || !key) {
      skipped.push("anon 外洩測試（缺 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）");
      console.log(yellow("  ⚠ 缺 anon 金鑰，跳過"));
    } else {
      const h = { apikey: key, Authorization: `Bearer ${key}` };
      const avail = await fetch(`${url}/rest/v1/product_availability?select=*&limit=200`, {
        headers: h,
      });
      checkTrue("anon 讀得到 product_availability", avail.ok);
      const rows = avail.ok ? await avail.json() : [];
      const cols = rows.length > 0 ? Object.keys(rows[0]).sort() : [];
      check(
        "而且只有三個欄位",
        JSON.stringify(cols),
        JSON.stringify(["available_capped", "in_stock", "product_id"]),
      );

      // 精確庫存的三條路：inv schema、後台 view、保留 ledger。三條都要打不開。
      const invTry = await fetch(`${url}/rest/v1/products?select=stock_quantity&limit=1`, {
        headers: { ...h, "Accept-Profile": "inv" },
      });
      checkTrue("anon 打不到 inv.products", invTry.status >= 400);
      const listedTry = await fetch(`${url}/rest/v1/inv_listed_products?select=*&limit=1`, {
        headers: h,
      });
      checkTrue("anon 打不到 inv_listed_products（後台精確庫存）", listedTry.status >= 400);
      const resTry = await fetch(`${url}/rest/v1/stock_reservations?select=*&limit=1`, {
        headers: h,
      });
      checkTrue("anon 打不到 stock_reservations", resTry.status >= 400);
      const linkTry = await fetch(`${url}/rest/v1/product_inventory_links?select=*&limit=1`, {
        headers: h,
      });
      checkTrue("anon 打不到 product_inventory_links", linkTry.status >= 400);
      // 對照組：anon 本來就讀得到 public.products，證明上面不是「金鑰整個壞掉」。
      const control = await fetch(`${url}/rest/v1/products?select=id&limit=1`, { headers: h });
      checkTrue("對照組：anon 讀得到 public.products", control.ok);
    }
  } catch (err) {
    // 記成一條失敗再往下走，而不是讓例外殺掉整個行程。
    // 直接讓它炸掉的話，收尾的 ##SELFTEST## 那一行印不出來，runner 只會說
    // 「沒有印出收尾行」——已經跑完的 100 條結果全部看不到，也不知道是哪一段掛的。
    fail += 1;
    console.log(red(`  ✗ 併發測試中止：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    // -------------------------------------------------------------------------
    // [13] 收尾：全部刪光，並證明 inv 一筆都沒少
    // -------------------------------------------------------------------------
    console.log("\n[13] 清理並對帳");
    await must(CLEANUP_SQL);
    const after = one(
      await must(`select
          (select count(*)::int from inv.products) inv_products,
          (select coalesce(sum(stock_quantity),0)::int from inv.products) sum_stock,
          (select count(*)::int from inv.sales) inv_sales,
          (select count(*)::int from public.products) pub_products,
          (select count(*)::int from public.stock_reservations) reservations,
          (select count(*)::int from public.stock_oversold_alerts) alerts,
          (select count(*)::int from public.orders) orders,
          (select count(*)::int from public.product_inventory_links) links,
          (select count(*)::int from inv.sales where product_id is null) orphan_sales`),
    );
    check("inv.products 筆數回到基準線", after.inv_products, baseline.inv_products);
    check("inv.products 總庫存回到基準線", after.sum_stock, baseline.sum_stock);
    check("inv.sales 筆數回到基準線", after.inv_sales, baseline.inv_sales);
    check("public.products 筆數回到基準線", after.pub_products, baseline.pub_products);
    check("stock_reservations 回到基準線", after.reservations, baseline.reservations);
    check("stock_oversold_alerts 回到基準線", after.alerts, baseline.alerts);
    check("orders 回到基準線", after.orders, baseline.orders);
    // 比基準線而不是 0：0015 之後正式資料本來就有連結（地方刊物展上架的那幾本），
    // 這一條要驗的是「這支測試自己造的連結收乾淨了」，不是「這張表是空的」。
    check("product_inventory_links 回到基準線", after.links, baseline.links);
    // sales.product_id 是 ON DELETE SET NULL，所以「刪品項時忘了先刪 sales」的後果
    // 是留下一列指向 NULL 的孤兒 —— 總筆數不變，不會有任何錯誤訊息，而報表從此少一
    // 筆有品項的銷售。所以這一條不能只看總數。
    //
    // 比的是**基準線**而不是 0：來源系統本來就有 46 列 product_id 為 NULL（其中 45
    // 列是帶 item_name 的二手銷售，這是 inv.sales 原本就支援的用法），那些不是孤兒。
    check("沒有新增 product_id 為 NULL 的孤兒 sales", after.orphan_sales, baseline.orphan_sales);
  }
}

/** anon 可達性測試要的兩個值：先看 env，沒有就退回讀 .env.local。 */
function readAnonCreds() {
  let url = process.env.VITE_SUPABASE_URL;
  let key = process.env.VITE_SUPABASE_ANON_KEY;
  const envFile = join(ROOT, ".env.local");
  if ((!url || !key) && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === "VITE_SUPABASE_URL" && !url) url = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "VITE_SUPABASE_ANON_KEY" && !key) key = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return { url, key };
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
