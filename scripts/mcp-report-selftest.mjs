#!/usr/bin/env node
/**
 * mcp-report-selftest.mjs —— 階段 D「分析與報表」MCP 工具（src/server/mcp/report-tools.ts）
 *
 *   [1] 工具表：名稱、annotations（全部 readOnlyHint:true）、匯出說明講清楚含個資
 *   [2] 匯出：私有 bucket、signed URL 900 秒、不回 CSV 內文、>1000 列全進 CSV、
 *       與後台同欄位（ROSTER_CSV_COLUMNS）、稽核有寫且不含個資
 *   [3] 排行：排序、同值 tiebreak、上限、口徑（只算 paid）
 *   [4] 報名率：已付款 ÷ 名額、名額 0 → null、整體合計
 *   [5] 回購率：email／電話任一相同即同一人、unidentified 不進分母、returning
 *   [6] 0055 migration：public=false、只收 text/csv、沒有任何 policy；帳本有登記
 *
 * 用 registerHooks 把 @/server/supabase-admin 換成假的（每次最多回 1000 列、會套
 * eq／gte／lt／lte／is／in／range／order；storage.from().upload／createSignedUrl 記錄呼叫）。
 * 不連任何真的資料庫。需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/mcp-report-selftest.mjs";
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

const mod = await import(join(SRC, "server/mcp/report-tools.ts"));
const {
  REPORT_TOOL_INPUTS,
  REPORT_TOOL_META,
  REPORT_HANDLERS,
  MCP_REPORT_BUCKET,
  REPORT_URL_TTL_SECONDS,
  rankProducts,
  computeRepurchase,
  normPhone,
  normEmail,
} = mod;
const json = (res) => JSON.parse(res.content[0].text);
const call = async (name, raw) =>
  json(await REPORT_HANDLERS[name](REPORT_TOOL_INPUTS[name].parse(raw)));

console.log("═══ MCP 階段 D 分析與報表 自檢 ═══");

// [1] ------------------------------------------------------------------------
console.log("\n[1] 工具表與 annotations");
const NAMES = [
  "export_roster_csv",
  "export_orders_csv",
  "export_sales_csv",
  "get_top_products",
  "get_event_fill_rates",
  "get_repurchase_rate",
];
check("工具清單", Object.keys(REPORT_TOOL_INPUTS).sort(), [...NAMES].sort());
check("META 與 INPUTS 一一對應", Object.keys(REPORT_TOOL_META).sort(), [...NAMES].sort());
check("handler 與 INPUTS 一一對應", Object.keys(REPORT_HANDLERS).sort(), [...NAMES].sort());
check(
  "全部 readOnlyHint:true、destructiveHint:false、openWorldHint:false",
  NAMES.every(
    (n) =>
      REPORT_TOOL_META[n].annotations.readOnlyHint === true &&
      REPORT_TOOL_META[n].annotations.destructiveHint === false &&
      REPORT_TOOL_META[n].annotations.openWorldHint === false,
  ),
  true,
);
check(
  "匯出工具的說明講清楚：含個資的下載連結、15 分鐘",
  NAMES.filter((n) => n.startsWith("export_")).every(
    (n) =>
      /個資/.test(REPORT_TOOL_META[n].description) &&
      /15 分鐘/.test(REPORT_TOOL_META[n].description),
  ),
  true,
);
check("bucket 名稱是私有那支", MCP_REPORT_BUCKET, "mcp-report-exports");
check("signed URL 效期常數 = 900 秒", REPORT_URL_TTL_SECONDS, 900);
check(
  "排行 limit 上限 100（101 被拒）",
  REPORT_TOOL_INPUTS.get_top_products.safeParse({ limit: 101 }).success,
  false,
);
check("排行 limit 預設 20", REPORT_TOOL_INPUTS.get_top_products.parse({}).limit, 20);
check(
  "匯出訂單：日期區間超過 366 天被拒",
  await REPORT_HANDLERS.export_orders_csv(
    REPORT_TOOL_INPUTS.export_orders_csv.parse({ date_from: "2025-01-01", date_to: "2026-06-30" }),
  ).then(
    () => "沒擋",
    (e) => e.name,
  ),
  "McpInputError",
);

// [2] ------------------------------------------------------------------------
console.log("\n[2] 匯出");
const SECRET_NAME = "王小明";
const SECRET_PHONE = "0912345678";
const SECRET_EMAIL = "secret@example.com";
{
  // 訂單：1500 張（> 1000），只有 2026-10 的才在區間內；一張封存。
  const orders = Array.from({ length: 1600 }, (_, i) => ({
    id: `o${String(i).padStart(5, "0")}`,
    order_no: `IB-2026${String(i).padStart(8, "0")}`,
    created_at: i < 1500 ? "2026-10-15T03:00:00.000Z" : "2026-09-15T03:00:00.000Z",
    paid_at: "2026-10-15T04:00:00.000Z",
    status: "completed",
    payment_status: i % 10 === 0 ? "refunded" : "paid",
    payment_method: "card",
    source: "web",
    subtotal: 100,
    shipping_fee: 0,
    discount: 0,
    total: 100,
    customer_name: SECRET_NAME,
    customer_phone: SECRET_PHONE,
    customer_email: SECRET_EMAIL,
    archived_at: i === 7 ? "2026-10-20T00:00:00.000Z" : null,
  }));
  tables.set("orders", orders);
  uploads.length = 0;
  signs.length = 0;
  inserts.length = 0;
  maxReturned.n = 0;
  const r = await call("export_orders_csv", { date_from: "2026-10-01", date_to: "2026-10-31" });
  check("訂單匯出：1499 列（1500 減 1 張封存，> 1000 全進）", r.rows, 1499);
  check("假 Supabase 確實每段最多回 1000 列", maxReturned.n, 1000);
  const up = uploads[0];
  check("上傳到私有 bucket", up?.bucket, "mcp-report-exports");
  check(
    "上傳 contentType 是 text/csv、不覆寫",
    [up?.opts?.contentType, up?.opts?.upsert],
    ["text/csv", false],
  );
  check("CSV 行數＝1 表頭＋1499 列", up.text.split("\r\n").filter(Boolean).length, 1500);
  check("CSV 有 BOM（Excel 中文）", up.text.charCodeAt(0), 0xfeff);
  check("電話強制文字（Excel 不吃 0）", up.text.includes(`"=""${SECRET_PHONE}"""`), true);
  check("簽名的是同一個 bucket＋路徑", [signs[0]?.bucket, signs[0]?.path], [up.bucket, up.path]);
  check("signed URL 到期秒數 = 900", signs[0]?.expiresIn, 900);
  check("回傳 expires_in_seconds = 900", r.expires_in_seconds, 900);
  check(
    "回傳有 download_url",
    typeof r.download_url === "string" && r.download_url.length > 0,
    true,
  );
  const text = JSON.stringify(r);
  check(
    "回傳不含 CSV 內文／個資",
    [text.includes(SECRET_NAME), text.includes(SECRET_PHONE), text.includes(SECRET_EMAIL)],
    [false, false, false],
  );
  const audit = inserts.filter((x) => x.table === "mcp_audit_log");
  check("稽核寫了一筆", audit.length, 1);
  check(
    "稽核 action=export、tool、列數",
    [audit[0]?.rec.action, audit[0]?.rec.tool, audit[0]?.rec.changes?.rows],
    ["export", "export_orders_csv", 1499],
  );
  const a = JSON.stringify(audit[0]?.rec ?? {});
  check(
    "稽核不含個資",
    [a.includes(SECRET_NAME), a.includes(SECRET_PHONE), a.includes(SECRET_EMAIL)],
    [false, false, false],
  );
  check("稽核記了條件（日期）", audit[0]?.rec.changes?.filters?.date_from, "2026-10-01");
  check("回傳 audit 狀態", r.audit, "recorded");

  const r2 = await call("export_orders_csv", {
    date_from: "2026-10-01",
    date_to: "2026-10-31",
    payment_status: "refunded",
    include_archived: true,
  });
  check("訂單匯出篩選：refunded＋含封存 = 150", r2.rows, 150);
}
{
  // 名單：與後台同欄位（ROSTER_CSV_COLUMNS）。
  tables.set("event_sessions", [
    {
      id: "11111111-1111-4111-8111-111111111111",
      product_id: "p1",
      title: { zh: "春日讀書會" },
      starts_at: "2026-11-20T06:00:00.000Z",
      capacity: 20,
      seats_taken: 3,
      status: "open",
    },
  ]);
  tables.set("admin_event_roster", [
    {
      registration_id: "r1",
      session_id: "11111111-1111-4111-8111-111111111111",
      seat_no: 1,
      notice_ack_at: null,
      order_no: "IB-1",
      paid_at: "2026-11-01T00:00:00Z",
      created_at: "2026-11-01T00:00:00Z",
      on_roster: true,
    },
    {
      registration_id: "r2",
      session_id: "11111111-1111-4111-8111-111111111111",
      seat_no: 2,
      notice_ack_at: null,
      order_no: "IB-1",
      paid_at: "2026-11-01T00:00:00Z",
      created_at: "2026-11-01T00:00:01Z",
      on_roster: true,
    },
    {
      registration_id: "r3",
      session_id: "11111111-1111-4111-8111-111111111111",
      seat_no: 3,
      notice_ack_at: null,
      order_no: "IB-2",
      paid_at: null,
      created_at: "2026-11-02T00:00:00Z",
      on_roster: false,
    },
  ]);
  tables.set("event_registrations", [
    {
      id: "r1",
      session_id: "11111111-1111-4111-8111-111111111111",
      name: SECRET_NAME,
      email: SECRET_EMAIL,
      phone: SECRET_PHONE,
    },
    {
      id: "r2",
      session_id: "11111111-1111-4111-8111-111111111111",
      name: "=HYPERLINK(1)",
      email: null,
      phone: null,
    },
    {
      id: "r3",
      session_id: "11111111-1111-4111-8111-111111111111",
      name: "未付款",
      email: null,
      phone: null,
    },
  ]);
  uploads.length = 0;
  signs.length = 0;
  inserts.length = 0;
  const r = await call("export_roster_csv", { session_id: "11111111-1111-4111-8111-111111111111" });
  const { ROSTER_CSV_COLUMNS } = await import(join(SRC, "lib/admin/roster-csv.ts"));
  const header = uploads[0].text.replace(/^﻿/, "").split("\r\n")[0];
  check(
    "名單表頭＝後台 ROSTER_CSV_COLUMNS",
    header,
    ROSTER_CSV_COLUMNS.map((c) => c.header).join(","),
  );
  check("名單只含 on_roster（2 列）", r.rows, 2);
  check("名單 CSV 擋公式", uploads[0].text.includes("'=HYPERLINK(1)"), true);
  check("名單檔名沿用後台規則", r.filename, "小時光報名名單_春日讀書會_20261120.csv");
  check(
    "名單 signed URL 900 秒、私有 bucket",
    [signs[0].expiresIn, signs[0].bucket],
    [900, "mcp-report-exports"],
  );
  const a = JSON.stringify(inserts.find((x) => x.table === "mcp_audit_log")?.rec ?? {});
  check(
    "名單稽核只記 session_id，不含個資",
    [
      a.includes("11111111-1111-4111-8111-111111111111"),
      a.includes(SECRET_NAME),
      a.includes(SECRET_PHONE),
    ],
    [true, false, false],
  );
  check(
    "找不到場次 → McpInputError",
    await REPORT_HANDLERS.export_roster_csv({
      session_id: "22222222-2222-4222-8222-222222222222",
    }).then(
      () => "沒擋",
      (e) => e.name,
    ),
    "McpInputError",
  );
}
{
  // 銷售：inventory 2300 筆（> 1000）、web_orders 品項。
  tables.set(
    "inv_pos_sales",
    Array.from({ length: 2300 }, (_, i) => ({
      sale_id: `s${String(i).padStart(5, "0")}`,
      sale_date: i < 2200 ? "2026-10-10" : "2026-11-10",
      created_at: "2026-10-10T02:00:00Z",
      channel: i % 2 ? "pos" : "online",
      inv_product_id: `inv${i % 3}`,
      product_name: `刊物${i % 3}`,
      issue_number: "01",
      series: null,
      product_type: "outright",
      quantity: 1,
      unit_price: 200,
      amount: 200,
      cost_price: 120,
      gross_profit: 80,
      payment_method_name: "現金",
      is_reconciled: false,
    })),
  );
  uploads.length = 0;
  const r = await call("export_sales_csv", { date_from: "2026-10-01", date_to: "2026-10-31" });
  check("銷售匯出（inventory）：2200 列全進", r.rows, 2200);
  check("銷售 CSV 行數 = 2201", uploads[0].text.split("\r\n").filter(Boolean).length, 2201);
  const r2 = await call("export_sales_csv", {
    date_from: "2026-10-01",
    date_to: "2026-10-31",
    channel: "pos",
  });
  check("銷售匯出 channel=pos：1100", r2.rows, 1100);

  tables.set(
    "order_items",
    Array.from({ length: 1500 }, (_, i) => ({
      id: i + 1,
      order_id: `o${String(i).padStart(5, "0")}`,
      product_id: "book-1",
      name: { zh: "小時光誌 01" },
      unit_price: 100,
      quantity: 1,
      subtotal: 100,
      product_type: "book",
    })),
  );
  uploads.length = 0;
  const r3 = await call("export_sales_csv", {
    date_from: "2026-10-01",
    date_to: "2026-10-31",
    source: "web_orders",
  });
  // orders 表：1600 張 paid_at 都在 10/15，其中 160 張 refunded → 1440 張 paid；品項只有前 1500 張有。
  check("網站訂單明細：只算 paid（1500 張有品項 − 150 張退款 = 1350）", r3.rows, 1350);
  check("網站訂單明細不含客人資料", uploads[0].text.includes(SECRET_NAME), false);
}

// [3] ------------------------------------------------------------------------
console.log("\n[3] 排行");
{
  const rows = [
    {
      key: "a",
      product_id: "a",
      title: "甲",
      product_type: "book",
      quantity: 5,
      amount: 500,
      orders: 5,
    },
    {
      key: "b",
      product_id: "b",
      title: "乙",
      product_type: "book",
      quantity: 9,
      amount: 300,
      orders: 9,
    },
    {
      key: "c",
      product_id: "c",
      title: "丙",
      product_type: "book",
      quantity: 5,
      amount: 900,
      orders: 2,
    },
  ];
  check(
    "依數量：乙 9 > 丙 5（金額 900 勝）> 甲 5",
    rankProducts(rows, "quantity", 20).map((r) => r.title),
    ["乙", "丙", "甲"],
  );
  check(
    "依金額：丙 > 甲 > 乙",
    rankProducts(rows, "amount", 20).map((r) => r.title),
    ["丙", "甲", "乙"],
  );
  check(
    "rank 從 1 起",
    rankProducts(rows, "amount", 20).map((r) => r.rank),
    [1, 2, 3],
  );
  check("limit 2", rankProducts(rows, "quantity", 2).length, 2);
  const many = Array.from({ length: 250 }, (_, i) => ({
    ...rows[0],
    key: `k${i}`,
    title: `t${i}`,
    quantity: i,
  }));
  check("上限 100（就算傳更大）", rankProducts(many, "quantity", 500).length, 100);

  // 端到端：web_orders 只算 paid。order_items 加一個票券商品在 o00001（paid）與 o00000（refunded）。
  const items = tables.get("order_items");
  items.push(
    {
      id: 9001,
      order_id: "o00001",
      product_id: "ev-1",
      name: { zh: "讀書會票" },
      unit_price: 500,
      quantity: 3,
      subtotal: 1500,
      product_type: "event",
    },
    {
      id: 9002,
      order_id: "o00000",
      product_id: "ev-1",
      name: { zh: "讀書會票" },
      unit_price: 500,
      quantity: 50,
      subtotal: 25000,
      product_type: "event",
    },
  );
  const r = await call("get_top_products", { date_from: "2026-10-01", date_to: "2026-10-31" });
  check(
    "web_orders 依數量：小時光誌 01（1350）> 讀書會票（3，退款那張不算）",
    r.rows.map((x) => [x.title, x.quantity, x.amount]),
    [
      ["小時光誌 01", 1350, 135000],
      ["讀書會票", 3, 1500],
    ],
  );
  const r2 = await call("get_top_products", {
    date_from: "2026-10-01",
    date_to: "2026-10-31",
    product_type: "event",
  });
  check(
    "web_orders product_type=event",
    r2.rows.map((x) => x.title),
    ["讀書會票"],
  );
  const r3 = await call("get_top_products", {
    date_from: "2026-10-01",
    date_to: "2026-10-31",
    source: "inventory",
    sort_by: "amount",
    limit: 2,
  });
  check(
    "inventory：2200 筆全算、前 2 名、附毛利",
    [
      r3.product_count,
      r3.totals.quantity,
      r3.rows.length,
      r3.rows[0].quantity,
      r3.rows[0].gross_profit,
    ],
    [3, 2200, 2, 734, 734 * 80],
  );
}

// [4] ------------------------------------------------------------------------
console.log("\n[4] 報名率");
{
  tables.set("products", [
    {
      id: "p1",
      slug: "salon",
      title: { zh: "讀書會" },
      product_type: "event",
      status: "active",
      sort_order: 1,
    },
    {
      id: "p2",
      slug: "trip",
      title: { zh: "花蓮策旅" },
      product_type: "journey",
      status: "active",
      sort_order: 2,
    },
  ]);
  tables.set("event_sessions", [
    {
      id: "S1",
      product_id: "p1",
      title: { zh: "第一場" },
      starts_at: "2026-10-01T06:00:00Z",
      capacity: 20,
      seats_taken: 15,
      status: "open",
    },
    {
      id: "S2",
      product_id: "p1",
      title: { zh: "第二場" },
      starts_at: "2026-10-08T06:00:00Z",
      capacity: 10,
      seats_taken: 10,
      status: "closed",
    },
    {
      id: "S3",
      product_id: "p2",
      title: { zh: "梯次" },
      starts_at: "2026-10-15T06:00:00Z",
      capacity: 0,
      seats_taken: 0,
      status: "open",
    },
  ]);
  // S1：1200 列（> 1000）中 12 位已付款？——用比例：S1 15 列，其中 12 paid；S2 10 列全 paid。
  const roster = [];
  for (let i = 0; i < 15; i++)
    roster.push({
      registration_id: `a${String(i).padStart(4, "0")}`,
      session_id: "S1",
      on_roster: i < 12,
    });
  for (let i = 0; i < 10; i++)
    roster.push({
      registration_id: `b${String(i).padStart(4, "0")}`,
      session_id: "S2",
      on_roster: true,
    });
  // 另外 1100 列別的場次（讓 countRegistrationsBySession 一定要分段）
  for (let i = 0; i < 1100; i++)
    roster.push({
      registration_id: `z${String(i).padStart(5, "0")}`,
      session_id: "OTHER",
      on_roster: true,
    });
  tables.set("admin_event_roster", roster);
  const r = await call("get_event_fill_rates", { sort_by: "fill_rate_desc" });
  check(
    "報名率：S2 10/10=1、S1 12/20=0.6、S3 名額 0 → null（排最後）",
    r.rows.map((x) => [x.session_id, x.paid_registrations, x.capacity, x.fill_rate]),
    [
      ["S2", 10, 10, 1],
      ["S1", 12, 20, 0.6],
      ["S3", 0, 0, null],
    ],
  );
  check("佔位率 S1 = 15/20", r.rows.find((x) => x.session_id === "S1").occupancy_rate, 0.75);
  check(
    "整體：只算名額 > 0 的場次（22/30）",
    [r.summary.capacity, r.summary.paid_registrations, r.summary.overall_fill_rate],
    [30, 22, 0.7333],
  );
  const r2 = await call("get_event_fill_rates", { product_type: "journey" });
  check(
    "product_type=journey",
    r2.rows.map((x) => x.session_id),
    ["S3"],
  );
  const r3 = await call("get_event_fill_rates", { limit: 1 });
  check(
    "limit 1、預設依開始時間由新到舊",
    [r3.rows.length, r3.rows[0].session_id, r3.summary.sessions],
    [1, "S3", 3],
  );
  const r4 = await call("get_event_fill_rates", { date_from: "2026-10-05", date_to: "2026-10-10" });
  check(
    "場次開始日區間",
    r4.rows.map((x) => x.session_id),
    ["S2"],
  );
}

// [5] ------------------------------------------------------------------------
console.log("\n[5] 回購率");
{
  check("電話正規化：+886 912-345-678 → 0912345678", normPhone("+886 912-345-678"), "0912345678");
  check("Email 正規化：大小寫與空白", normEmail("  A@B.com "), "a@b.com");
  check("太短的電話不算", normPhone("123"), null);
  const S = "2026-10-01T00:00:00.000Z";
  const E = "2026-11-01T00:00:00.000Z";
  const o = (id, email, phone, paid_at) => ({
    id,
    customer_email: email,
    customer_phone: phone,
    paid_at,
    total: 100,
  });
  const orders = [
    // 客人 A：期間內兩張（第二張只留電話、大小寫不同的 email 在第一張）→ repeat
    o("1", "A@x.com", "0911000111", "2026-10-02T00:00:00Z"),
    o("2", null, "+886911000111", "2026-10-20T00:00:00Z"),
    // 客人 B：期間內一張，期間前買過（用 email 連起來）→ returning
    o("3", "b@x.com", null, "2026-10-05T00:00:00Z"),
    o("4", "B@X.COM", "0922000222", "2026-08-01T00:00:00Z"),
    // 客人 C：期間內一張
    o("5", "c@x.com", "0933000333", "2026-10-06T00:00:00Z"),
    // 連鎖：D1 email=d、D2 email=d phone=0944、D3 phone=0944 → 同一人，期間內 3 張
    o("6", "d@x.com", null, "2026-10-07T00:00:00Z"),
    o("7", "d@x.com", "0944000444", "2026-10-08T00:00:00Z"),
    o("8", null, "0944000444", "2026-10-09T00:00:00Z"),
    // 沒有聯絡方式（電話報名）
    o("9", null, null, "2026-10-10T00:00:00Z"),
    // 期間之後的不算
    o("10", "c@x.com", null, "2026-11-05T00:00:00Z"),
  ];
  const r = computeRepurchase(orders, S, E);
  check(
    "客人數 4（A、B、C、D）、unidentified 1、期間內訂單 8",
    [r.customers, r.unidentified_orders, r.orders_in_period],
    [4, 1, 8],
  );
  check("repeat：A、D → 2/4 = 0.5", [r.repeat_customers, r.repeat_rate], [2, 0.5]);
  check("returning：B → 1/4 = 0.25", [r.returning_customers, r.returning_rate], [1, 0.25]);
  check("分布 1:2、2:1、3+:1", r.orders_per_customer, { 1: 2, 2: 1, "3+": 1 });
  check("沒有客人 → rate null（不是 0）", computeRepurchase([], S, E).repeat_rate, null);

  // 端到端：handler 只回統計、不回個資；只讀 paid。
  tables.set(
    "orders",
    orders.map((x, i) => ({
      ...x,
      payment_status: i === 4 ? "refunded" : "paid",
      total: i === 2 ? 0 : 100,
    })),
  );
  const h = await call("get_repurchase_rate", { date_from: "2026-10-01", date_to: "2026-10-31" });
  check("handler：退款那張（C）不算 → 客人 3", h.customers, 3);
  check("handler 回傳不含 email／電話", /@x\.com|0911000111/.test(JSON.stringify(h)), false);
  const h2 = await call("get_repurchase_rate", {
    date_from: "2026-10-01",
    date_to: "2026-10-31",
    exclude_free: true,
  });
  check("exclude_free：B 的 0 元單不算 → 客人 2", h2.customers, 2);
}

// [6] ------------------------------------------------------------------------
console.log("\n[6] 0055 migration 與帳本");
{
  const migDir = join(ROOT, "supabase/migrations");
  const raw = readFile(join(migDir, "0055_mcp_report_exports.sql"));
  const sql = raw.replace(/^[ \t]*--.*$/gm, " ");
  check(
    "建的是 mcp-report-exports",
    /'mcp-report-exports',\s*'mcp-report-exports'/.test(sql),
    true,
  );
  check(
    "public = false（insert 與 on conflict 都是）",
    (sql.match(/\bfalse\b/g) ?? []).length >= 1 && /set public\s*=\s*false/.test(sql),
    true,
  );
  check("沒有 public = true", /public\s*=\s*true|,\s*true\s*,/.test(sql), false);
  check("只收 text/csv", /array\['text\/csv'\]/.test(sql), true);
  check(
    "沒有任何 policy／grant",
    /\b(create|alter)\s+policy\b|\bgrant\b|storage\.objects/i.test(sql),
    false,
  );
  const { MIGRATION_LEDGER, assertLedgerMatchesDisk, assertLedgerDeclarationsHonest } =
    await import(join(ROOT, "scripts/lib/migration-ledger.mjs"));
  const entry = MIGRATION_LEDGER.find((e) => e.file === "0055_mcp_report_exports.sql");
  check("帳本有 0055、touches=[storage]", entry?.touches, ["storage"]);
  assertLedgerMatchesDisk(check, migDir);
  assertLedgerDeclarationsHonest(check, migDir);
  const src = readFile(join(SRC, "server/mcp/report-tools.ts"));
  check(
    "report-tools 用的 bucket 常數與 0055 一致",
    src.includes(`"${"mcp-report-exports"}"`),
    true,
  );
  check("report-tools 沒有 .limit(（大量讀取一律 readAllPages）", /\.limit\(/.test(src), false);
}

console.log(
  fail === 0
    ? green(`\n✓ 全部通過：${pass} passed, 0 failed`)
    : red(`\n✗ 有失敗：${pass} passed, ${fail} failed`),
);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
