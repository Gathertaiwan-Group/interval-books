#!/usr/bin/env node
/**
 * sales-seller-selftest.mjs —— 銷售紀錄「經手人」（2026-11-19，業主：要看得到是誰賣的）
 *
 *   [1] sellerLabel()：inv.profiles 名字 → 帳號 email 前綴 → 「—」；網站訂單一律「網站」
 *   [2] repo：listPosSales／getPosSale 帶 seller_name、列表不回 user_id；經手人篩選
 *       選人時同時限定 channel = 'pos'（網站訂單的 user_id 是品項擁有者，不是經手人）；
 *       listSalesSellers() 依筆數排序、最後加「網站」、>1000 筆全讀
 *   [3] MCP：list_sales 每列有 seller_name、可用名稱篩選、名字打錯回可用名單；
 *       get_sale 回 seller_name 不回 user_id／operator_name；export_sales_csv 有「經手人」欄
 *   [4] 寫入端：三種門市結帳（單品／套餐／二手）的後台 server fn 都用 context.staff.userId，
 *       MCP 三支 create_*_sale 用 OAuth 身分（實際送進 RPC 的 p_user_id 另由
 *       mcp-ops-write／mcp-pos-stock 兩支自檢驗證）；inv_pos_sales.user_id 來自 inv.sales.user_id
 *
 * 用 registerHooks 把 @/server/supabase-admin 換成假的。不連任何真的資料庫。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/sales-seller-selftest.mjs";
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

// ── 假的 Supabase ───────────────────────────────────────────────────────────
const MAX = 1000;
const tables = new Map();
const uploads = [];
const signs = [];
const inserts = [];
const maxReturned = { n: 0 };
function builder(table) {
  const filters = [];
  const orders = [];
  let range = null;
  let single = false;
  const b = {
    select: () => b,
    order: (col, opts) => (orders.push([col, opts?.ascending !== false]), b),
    eq: (c, v) => (filters.push((r) => r[c] === v), b),
    neq: (c, v) => (filters.push((r) => r[c] !== v), b),
    gte: (c, v) => (filters.push((r) => r[c] != null && r[c] >= v), b),
    gt: (c, v) => (filters.push((r) => r[c] != null && r[c] > v), b),
    lte: (c, v) => (filters.push((r) => r[c] != null && r[c] <= v), b),
    lt: (c, v) => (filters.push((r) => r[c] != null && r[c] < v), b),
    is: (c, v) => (filters.push((r) => (r[c] ?? null) === v), b),
    in: (c, vs) => (filters.push((r) => vs.includes(r[c])), b),
    or: () => b,
    limit: () => b,
    range: (a, z) => ((range = [a, z]), b),
    maybeSingle: () => ((single = true), b),
    insert: (rec) => {
      inserts.push({ table, rec });
      return Promise.resolve({ error: null });
    },
    then(resolve, reject) {
      try {
        let all = (tables.get(table) ?? []).filter((r) => filters.every((f) => f(r)));
        if (orders.length) {
          all = [...all].sort((x, y) => {
            for (const [c, asc] of orders) {
              if (x[c] === y[c]) continue;
              return (x[c] < y[c] ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
        }
        if (single) return resolve({ data: all[0] ?? null, error: null });
        const [a, z] = range ?? [0, all.length - 1];
        const data = all.slice(a, Math.min(z + 1, a + MAX));
        maxReturned.n = Math.max(maxReturned.n, data.length);
        resolve({ data, error: null, count: all.length });
      } catch (e) {
        reject(e);
      }
    },
  };
  return b;
}
globalThis.__fakeSupabase = {
  from: (t) => builder(t),
  storage: {
    from: (bucket) => ({
      upload: async (path, body, opts) => {
        uploads.push({
          bucket,
          path,
          text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(body),
          opts,
        });
        return { data: { path }, error: null };
      },
      createSignedUrl: async (path, expiresIn, opts) => {
        signs.push({ bucket, path, expiresIn, opts });
        return {
          data: { signedUrl: `https://fake.supabase/sign/${bucket}/${path}?token=t` },
          error: null,
        };
      },
    }),
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

const json = (res) => JSON.parse(res.content[0].text);
const code = (p) => readFile(join(ROOT, p));

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // inv.profiles 有名字
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // inv.profiles 只有 email
const CAROL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // 只在 public.profiles（MCP 管理員）
const GHOST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // 哪裡都查不到
const OWNER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // 網站訂單的品項擁有者

console.log("═══ 銷售紀錄「經手人」自檢 ═══");

// [1] ------------------------------------------------------------------------
console.log("\n[1] sellerLabel()");
const { sellerLabel, emailPrefix } = await import(join(SRC, "lib/admin/seller-name.ts"));
check("有名字 → 名字", sellerLabel({ channel: "pos", operatorName: "小美" }), "小美");
check(
  "名字是 email → @ 前綴",
  sellerLabel({ channel: "pos", operatorName: "bob.lin@example.com" }),
  "bob.lin",
);
check(
  "沒有 inv 名字 → 帳號 email 前綴",
  sellerLabel({ channel: "pos", operatorName: null, accountEmail: "carol@example.com" }),
  "carol",
);
check(
  "空白名字 → 退到帳號 email",
  sellerLabel({ channel: "pos", operatorName: "  ", accountEmail: "c@x.tw" }),
  "c",
);
check("都查不到 → —（不猜）", sellerLabel({ channel: "pos", operatorName: null }), "—");
check(
  "網站訂單 → 網站（不顯示品項擁有者）",
  sellerLabel({ channel: "online", operatorName: "品項擁有者", accountEmail: "o@x.tw" }),
  "網站",
);
check("emailPrefix(null) = null", emailPrefix(null), null);

// [2] ------------------------------------------------------------------------
console.log("\n[2] repo：列表、明細、篩選、下拉選項");
const sale = (i, over) => ({
  sale_id: `s${String(i).padStart(5, "0")}`,
  sale_date: "2026-11-10",
  created_at: "2026-11-10T02:00:00Z",
  channel: "pos",
  override_reservation: false,
  quantity: 1,
  unit_price: 200,
  amount: 200,
  cost_price: 120,
  gross_profit: 80,
  product_name: `刊物${i}`,
  issue_number: "01",
  series: null,
  product_type: "outright",
  inv_product_id: "p1",
  payment_method_id: null,
  payment_method_name: "現金",
  is_reconciled: false,
  notes: null,
  web_order_id: null,
  ...over,
});
const SALES = [
  ...Array.from({ length: 1200 }, (_, i) => sale(i, { user_id: ALICE, operator_name: "小美" })),
  sale(1200, { user_id: BOB, operator_name: "bob.lin@example.com" }),
  sale(1201, { user_id: CAROL, operator_name: null }),
  sale(1202, { user_id: CAROL, operator_name: null }),
  sale(1203, { user_id: GHOST, operator_name: null }),
  sale(1204, { channel: "online", user_id: OWNER, operator_name: "擁有者" }),
  sale(1205, { channel: "online", user_id: ALICE, operator_name: "小美" }),
];
tables.set("inv_pos_sales", SALES);
tables.set("profiles", [
  { id: CAROL, email: "carol@example.com", role: "admin" },
  { id: ALICE, email: "alice@example.com", role: "admin" },
]);

const repo = await import(join(SRC, "server/repos/inv-sales.ts"));
const base = {
  from: null,
  to: null,
  channel: "all",
  keyword: null,
  reconciled: "all",
  paymentMethodId: null,
  seller: null,
  page: 0,
  pageSize: 200,
};
{
  // 第 7 頁（offset 1200）剛好是那 6 筆非小美的列。
  const { rows } = await repo.listPosSales({ ...base, page: 6 });
  const by = Object.fromEntries(rows.map((r) => [r.sale_id, r.seller_name]));
  check(
    "列表：有名字",
    by.s01199 ?? (await repo.listPosSales({ ...base, page: 0 })).rows[0].seller_name,
    "小美",
  );
  check("列表：inv email → 前綴", by.s01200, "bob.lin");
  check("列表：只在 public.profiles → email 前綴", by.s01201, "carol");
  check("列表：查不到 → —", by.s01203, "—");
  check("列表：網站訂單 → 網站", [by.s01204, by.s01205], ["網站", "網站"]);
  check(
    "列表不把 user_id／operator_name 帶回瀏覽器",
    rows.some((r) => "user_id" in r || "operator_name" in r),
    false,
  );
}
{
  const { rows, total } = await repo.listPosSales({ ...base, seller: ALICE });
  check("篩選小美：只有門市 1200 筆（她擁有品項的網站訂單不算）", total, 1200);
  check(
    "篩選小美：沒有任何網站訂單混進來",
    rows.some((r) => r.channel === "online"),
    false,
  );
  const web = await repo.listPosSales({ ...base, seller: "web" });
  check("篩選「網站」：2 筆網站訂單", web.total, 2);
  const sum = await repo.summarisePosSales({ ...base, seller: CAROL });
  check("合計也套經手人篩選", sum.count, 2);
}
{
  const opts = await repo.listSalesSellers();
  check(
    "下拉選項：依筆數排序、>1000 筆全讀、最後是網站",
    opts.map((o) => [o.name, o.count]),
    [
      ["小美", 1200],
      ["carol", 2],
      ["—", 1],
      ["bob.lin", 1],
      ["網站", 2],
    ],
  );
  check(
    "下拉選項的值：人員＝user_id、網站＝web",
    [opts[0].value, opts.at(-1).value],
    [ALICE, "web"],
  );
}
{
  tables.set("inv_pos_sales", [sale(1201, { user_id: CAROL, operator_name: null })]);
  const one = await repo.getPosSale("s01201");
  check("明細：seller_name 補上 email 前綴", one.seller_name, "carol");
  tables.set("inv_pos_sales", SALES);
}

// [3] ------------------------------------------------------------------------
console.log("\n[3] MCP");
{
  const { ADMIN_READ_TOOL_INPUTS, ADMIN_READ_HANDLERS, ADMIN_READ_TOOL_META } = await import(
    join(SRC, "server/mcp/admin-read-tools.ts")
  );
  const callRead = async (name, raw) =>
    json(await ADMIN_READ_HANDLERS[name](ADMIN_READ_TOOL_INPUTS[name].parse(raw)));
  const r = await callRead("list_sales", { limit: 100 });
  check(
    "list_sales 每列都有 seller_name",
    r.rows.every((x) => typeof x.seller_name === "string"),
    true,
  );
  check(
    "list_sales 不回 user_id",
    r.rows.some((x) => "user_id" in x),
    false,
  );
  check(
    "list_sales 附可用的經手人名單",
    r.sellers.map((s) => s.name),
    ["小美", "carol", "—", "bob.lin", "網站"],
  );
  const f = await callRead("list_sales", { seller: "Carol", limit: 100 });
  check(
    "list_sales seller=名稱（不分大小寫）→ 只剩那個人",
    [f.total, f.rows.map((x) => x.seller_name)],
    [2, ["carol", "carol"]],
  );
  const w = await callRead("list_sales", { seller: "網站", limit: 100 });
  check("list_sales seller=網站 → 網站訂單", w.total, 2);
  const bad = await ADMIN_READ_HANDLERS.list_sales(
    ADMIN_READ_TOOL_INPUTS.list_sales.parse({ seller: "不存在" }),
  ).then(
    () => "沒擋",
    (e) => [e.name, e.message.includes("小美")],
  );
  check("名字打錯 → McpInputError 並列出可用名單", bad, ["McpInputError", true]);
  check(
    "list_sales 說明提到經手人",
    ADMIN_READ_TOOL_META.list_sales.description.includes("seller_name"),
    true,
  );

  const SID = "11111111-1111-4111-8111-111111111111";
  tables.set("inv_pos_sales", [sale(1201, { sale_id: SID, user_id: CAROL, operator_name: null })]);
  const g = await callRead("get_sale", { sale_id: SID });
  check(
    "get_sale 回 seller_name、不回 user_id／operator_name",
    g && [g.seller_name, "user_id" in g, "operator_name" in g],
    ["carol", false, false],
  );
  tables.set("inv_pos_sales", SALES);
}
{
  const { REPORT_TOOL_INPUTS, REPORT_HANDLERS } = await import(
    join(SRC, "server/mcp/report-tools.ts")
  );
  uploads.length = 0;
  const r = await REPORT_HANDLERS.export_sales_csv(
    REPORT_TOOL_INPUTS.export_sales_csv.parse({ date_from: "2026-11-01", date_to: "2026-11-30" }),
  );
  const text = uploads[0]?.text ?? "";
  const lines = text.split("\r\n").filter(Boolean);
  const header = lines[0].replace(/^﻿/, "").split(",");
  check("CSV 最後一欄是「經手人」", header.at(-1), "經手人");
  const col = (needle) =>
    lines
      .find((l) => l.includes(needle))
      ?.split(",")
      .at(-1);
  check(
    "CSV 經手人：名字／email 前綴／—／網站",
    [col("刊物1200,"), col("刊物1201,"), col("刊物1203,"), col("刊物1204,")],
    ["bob.lin", "carol", "—", "網站"],
  );
  check("CSV 列數 = 1206", json(r).rows, 1206);
}

// [4] ------------------------------------------------------------------------
console.log("\n[4] 寫入端：經手人來自登入身分");
{
  const pos = code("src/lib/admin/fns/pos.ts");
  const combos = code("src/lib/admin/fns/inv-combos.ts");
  check(
    "單品結帳 server fn：posCheckout 的 userId 取自 context.staff.userId",
    /posCheckout\(\{\s*userId: context\.staff\.userId/.test(pos),
    true,
  );
  check(
    "套餐／二手結帳 server fn：comboCheckout、secondhandCheckout 都用 context.staff.userId",
    [
      /comboCheckout\(\{\s*userId: context\.staff\.userId/.test(combos),
      /secondhandCheckout\(\{\s*userId: context\.staff\.userId/.test(combos),
    ],
    [true, true],
  );
  const ops = code("src/server/mcp/ops-write-tools.ts");
  const ps = code("src/server/mcp/pos-stock-tools.ts");
  const seg = (s, name) => s.slice(s.indexOf(`async ${name}(`), s.indexOf(`async ${name}(`) + 6000);
  check(
    "MCP create_pos_sale／create_secondhand_sale／create_combo_sale 都先取 oauthUserId",
    [
      /const userId = await oauthUserId\(tool\)/.test(seg(ops, "create_pos_sale")),
      /const userId = await oauthUserId\(tool\)/.test(seg(ops, "create_secondhand_sale")),
      /const userId = await oauthUserId\(tool\)/.test(seg(ps, "create_combo_sale")),
    ],
    [true, true, true],
  );
  const repoSrc = code("src/server/repos/inv-sales.ts");
  check(
    "repo 送進 pos_checkout 的 p_user_id 就是 input.userId",
    /p_user_id: input\.userId/.test(repoSrc),
    true,
  );
  const v = code("supabase/migrations/0014_pos_counter.sql");
  check("inv_pos_sales.user_id 就是 inv.sales.user_id", /s\.user_id\s+as user_id/.test(v), true);
}

console.log(
  fail === 0
    ? green(`\n✓ 全部通過：${pass} passed, 0 failed`)
    : red(`\n✗ 有失敗：${pass} passed, ${fail} failed`),
);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
