#!/usr/bin/env node
/**
 * mcp-pos-stock-selftest.mjs —— MCP 門市套餐與庫存異動工具（src/server/mcp/pos-stock-tools.ts）
 * ＋ ops-write-tools.ts 的 approve_inventory_record／list_pending_approvals 加上的 combo_sets。
 *
 *   [1] 形狀：三份匯出一致、annotations、寫入 dry_run 預設 true、讀取＝get_/list_、沒有祕密欄位
 *   [2] 每支寫入：預覽不呼叫 RPC／不寫業務資料、記一筆 dry_run=true 稽核
 *   [3] 每支寫入：dry_run=false 才呼叫後台同一支 RPC／repo 與參數，記一筆 dry_run=false 稽核
 *   [4] 靜態 token 拒絕；建立類 idempotency_key 必填且只能用一次
 *   [5] 行為：賣不動的套餐、超賣警告、改價重新送審、無變更不寫、狀態不對 no-op、已處理的告警不覆蓋
 *   [6] 讀取工具
 *   [7] 套餐核准走 approve_inventory_record（inv_approve_record module=combo_sets）
 *   [8] 靜態：這個檔案自己不寫 update／insert／delete／upsert／rpc
 *
 * 用假的 supabaseAdmin 跑 production 的 handler 與 repo 本人（同 mcp-ops-write-selftest.mjs）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/mcp-pos-stock-selftest.mjs";
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
const log = { rpc: [], writes: [] };
let tables = {};
let rpcData = {};
function resetDb(t, r) {
  tables = structuredClone(t);
  rpcData = structuredClone(r);
  log.rpc = [];
  log.writes = [];
}
function builder(table) {
  const st = { op: "select", payload: null, filters: [], single: null };
  const pass_ = () => b;
  const b = {
    select: pass_,
    order: pass_,
    gt: pass_,
    gte: pass_,
    lt: pass_,
    lte: pass_,
    limit: pass_,
    range: pass_,
    or: pass_,
    is: (c, v) => (st.filters.push((r) => (r[c] ?? null) === v), b),
    insert: (p) => ((st.op = "insert"), (st.payload = p), b),
    update: (p) => ((st.op = "update"), (st.payload = p), b),
    upsert: (p) => ((st.op = "upsert"), (st.payload = p), b),
    delete: () => ((st.op = "delete"), b),
    eq: (c, v) => (st.filters.push((r) => r[c] === v), b),
    neq: (c, v) => (st.filters.push((r) => r[c] !== v), b),
    in: (c, vs) => (st.filters.push((r) => vs.includes(r[c])), b),
    not: (c, op, v) => (
      st.filters.push((r) =>
        op === "is" && v === null ? r[c] !== null && r[c] !== undefined : true,
      ),
      b
    ),
    maybeSingle: () => ((st.single = "maybe"), b),
    single: () => ((st.single = "one"), b),
    then(resolve, reject) {
      try {
        const rows = (tables[table] ?? []).filter((r) => st.filters.every((f) => f(r)));
        if (st.op !== "select") log.writes.push({ table, op: st.op, payload: st.payload });
        if (st.op === "update") for (const r of rows) Object.assign(r, st.payload);
        if (st.op === "insert") {
          if (table === "mcp_oauth_used_codes") {
            const used = (tables[table] ??= []);
            if (used.some((r) => r.jti === st.payload.jti)) {
              resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
              return;
            }
            used.push({ ...st.payload });
          }
          resolve({ data: null, error: null });
          return;
        }
        const data = st.single ? (rows[0] ?? null) : rows;
        resolve({ data, error: null, count: rows.length });
      } catch (e) {
        reject(e);
      }
    },
  };
  return b;
}
globalThis.__fakeSupabase = {
  from: (t) => builder(t),
  rpc: async (name, args) => {
    log.rpc.push({ name, args });
    return { data: rpcData[name] ?? null, error: null };
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

const origInfo = console.info;
console.info = () => {};

const MOD = await import(join(SRC, "server/mcp/pos-stock-tools.ts"));
const { POS_STOCK_TOOL_INPUTS: INPUTS, POS_STOCK_TOOL_META: META, POS_STOCK_HANDLERS: H } = MOD;
const OPS = (await import(join(SRC, "server/mcp/ops-write-tools.ts"))).OPS_WRITE_HANDLERS;
const { runAsMcpActor } = await import(join(SRC, "server/mcp/actor.ts"));
const { z } = await import("zod4");

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OAUTH = {
  via: "oauth",
  user_id: ADMIN_ID,
  email: "admin@example.com",
  client: "c",
  client_name: "Claude",
  access: "write",
};
const STATIC = { via: "static_token", access: "write" };
const asOAuth = (fn) => runAsMcpActor(OAUTH, fn);
const asStatic = (fn) => runAsMcpActor(STATIC, fn);
const parseOut = (r) => {
  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return r.content[0].text;
  }
};
const audits = () => log.writes.filter((w) => w.table === "mcp_audit_log").map((w) => w.payload);
const dataWrites = () =>
  log.writes.filter((w) => w.table !== "mcp_audit_log" && w.table !== "mcp_oauth_used_codes");

console.log("═══ MCP 門市套餐與庫存異動工具 自檢 ═══");

// [1] ------------------------------------------------------------------------
console.log("\n[1] 形狀");
const names = Object.keys(INPUTS).sort();
check(
  "INPUTS／META／HANDLERS 名單一致",
  [Object.keys(META).sort(), Object.keys(H).sort()],
  [names, names],
);
const READS = names.filter((n) => META[n].annotations.readOnlyHint === true);
const WRITES = names.filter((n) => META[n].annotations.readOnlyHint !== true);
check("讀取工具清單", READS, [
  "get_combo_set",
  "get_stock_adjustment",
  "list_combo_sets",
  "list_stock_adjustments",
]);
check("寫入工具清單", WRITES, [
  "create_combo_sale",
  "create_combo_set",
  "resolve_stock_alert",
  "resubmit_combo_set",
  "set_combo_set_active",
  "submit_stock_adjustment",
  "update_combo_set",
]);
check(
  "沒有任何刪除／沖帳工具",
  names.filter((n) => /delete|remove|reverse|void/.test(n)),
  [],
);
check(
  "每支都有 title／description／四個 annotations、沒有 destructiveHint",
  names.every(
    (n) =>
      META[n].title &&
      META[n].description &&
      ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].every(
        (k) => typeof META[n].annotations[k] === "boolean",
      ) &&
      META[n].annotations.destructiveHint === false,
  ),
  true,
);
check(
  "建立類（create_*）idempotentHint=false",
  WRITES.filter((n) => n.startsWith("create_")).map((n) => META[n].annotations.idempotentHint),
  [false, false],
);
check(
  "每支寫入 dry_run 預設 true",
  WRITES.map((n) => z.toJSONSchema(INPUTS[n], { io: "input" }).properties?.dry_run?.default),
  WRITES.map(() => true),
);
check(
  "說明寫明對應的後台 RPC／按鈕",
  WRITES.every((n) => /RPC|後台/.test(META[n].description)),
  true,
);
function propNames(schema, out = new Set()) {
  if (!schema || typeof schema !== "object") return out;
  if (schema.properties) for (const k of Object.keys(schema.properties)) out.add(k);
  for (const v of Object.values(schema)) {
    if (Array.isArray(v)) v.forEach((x) => propNames(x, out));
    else if (v && typeof v === "object") propNames(v, out);
  }
  return out;
}
const SECRET_RE =
  /bank|token|secret|password|passwd|api_?key|private|credential|account|notify_emails|webhook|hash_?key|iv$/i;
// 寫入工具另外不准收：操作人員、審核狀態、分攤金額、成本（那些都是資料庫算的）。
const WRITE_BANNED_RE = /user_id|approval_status|amount|unit_cost|cost_price|allocation/i;
const offenders = [];
for (const n of names) {
  for (const p of propNames(z.toJSONSchema(INPUTS[n], { io: "input" }))) {
    if (SECRET_RE.test(p) || (WRITES.includes(n) && WRITE_BANNED_RE.test(p)))
      offenders.push(`${n}.${p}`);
  }
}
check("輸入沒有祕密欄位；寫入不收操作人員／審核狀態／金額分攤／成本", offenders, []);
// 與既有工具不撞名
const existing = new Set();
for (const f of [
  "tools.ts",
  "admin-read-tools.ts",
  "create-tools.ts",
  "image-upload.ts",
  "ops-write-tools.ts",
  "outbound-tools.ts",
  "report-tools.ts",
]) {
  for (const m of readFile(join(SRC, "server/mcp", f)).matchAll(/^ {2}([a-z_]+): z/gm))
    existing.add(m[1]);
}
check(
  "不與既有 MCP 工具撞名",
  names.filter((n) => existing.has(n)),
  [],
);

// 資料 -----------------------------------------------------------------------
const U = (n) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const PROD1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROD2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROD_RENTAL = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const COMBO_OK = U(1);
const COMBO_PENDING = U(2);
const COMBO_REJECTED = U(3);
const COMBO_OFF = U(4);
const ADJ_DRAFT = U(5);
const ADJ_REJECTED = U(6);
const ADJ_CONFIRMED = U(7);
const PAY_CASH = "14141414-1414-4141-8141-141414141414";
const PAY_LINE = "15151515-1515-4151-8151-151515151515";

const combo = (id, name, extra) => ({
  combo_set_id: id,
  name,
  selling_price: 300,
  is_active: true,
  notes: null,
  approval_status: "approved",
  approved_at: null,
  approved_by_name: null,
  user_id: "x",
  creator_name: "店長",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  item_count: 2,
  total_list_price: 210,
  allocation_basis: "list_price",
  zero_priced_items: 0,
  max_sets: 2,
  sold_sets: 0,
  sold_revenue: 0,
  ...extra,
});
const item = (setId, pid, qty, name, price, stock) => ({
  item_id: `${setId}-${pid}`,
  combo_set_id: setId,
  product_id: pid,
  quantity: qty,
  product_name: name,
  issue_number: null,
  series: null,
  product_type: "outright",
  selling_price: price,
  product_active: true,
  base_product_id: null,
  pack_size: 1,
  stock_quantity: stock,
});
const adj = (id, number, status) => ({
  adjustment_id: id,
  adjustment_number: number,
  product_id: PROD1,
  product_name: "小誌 12 期",
  issue_number: "12",
  product_stock_quantity: 10,
  category: "EXP",
  quantity: -1,
  reason: "damage",
  notes: null,
  status,
  user_id: "x",
  creator_name: "店員",
  created_at: "2026-11-10T00:00:00Z",
  adjustment_date: "2026-11-10",
});

const BASE_TABLES = {
  inv_admin_combo_sets: [
    combo(COMBO_OK, "雜誌明信片組"),
    combo(COMBO_PENDING, "待審組", { approval_status: "pending" }),
    combo(COMBO_REJECTED, "退回組", { approval_status: "rejected" }),
    combo(COMBO_OFF, "下架組", { is_active: false }),
  ],
  inv_admin_combo_set_items: [
    item(COMBO_OK, PROD1, 1, "小誌 12 期", 150, 10),
    item(COMBO_OK, PROD2, 2, "明信片", 30, 4),
    item(COMBO_REJECTED, PROD1, 1, "小誌 12 期", 150, 10),
    item(COMBO_REJECTED, PROD_RENTAL, 1, "展示品", 0, 1),
  ],
  inv_admin_combo_sales: [],
  inv_pos_products: [
    { inv_product_id: PROD1, name: "小誌 12 期", selling_price: 150, stock_quantity: 10 },
    { inv_product_id: PROD2, name: "明信片", selling_price: 30, stock_quantity: 4 },
  ],
  inv_pos_payment_methods: [
    { payment_method_id: PAY_CASH, name: "現金", is_default: true, display_order: 1 },
    { payment_method_id: PAY_LINE, name: "LINE Pay", is_default: false, display_order: 2 },
  ],
  inv_admin_approval_settings: [
    { module: "combo_sets", is_enabled: true, updated_at: "2026-11-01T00:00:00Z" },
    { module: "stock_adjustments", is_enabled: false, updated_at: "2026-11-01T00:00:00Z" },
  ],
  inv_admin_stock_adjustments: [
    adj(ADJ_DRAFT, "EXP-0010", "draft"),
    adj(ADJ_REJECTED, "EXP-0011", "rejected"),
    adj(ADJ_CONFIRMED, "EXP-0012", "confirmed"),
  ],
  inv_stock_alerts: [
    {
      alert_id: 7,
      created_at: "2026-11-14T00:00:00Z",
      source: "pos",
      shortfall: 2,
      inv_product_id: PROD1,
      product_name: "小誌 12 期",
      current_stock: -2,
      sale_id: "s1",
      order_id: null,
      resolved_at: null,
      resolution_note: null,
    },
    {
      alert_id: 8,
      created_at: "2026-11-13T00:00:00Z",
      source: "pos",
      shortfall: 1,
      inv_product_id: PROD2,
      product_name: "明信片",
      current_stock: -1,
      sale_id: "s2",
      order_id: null,
      resolved_at: "2026-11-14T00:00:00Z",
      resolution_note: "補登進貨",
    },
  ],
  stock_oversold_alerts: [
    { id: 7, resolved_at: null, resolved_by: null, resolution_note: null },
    { id: 8, resolved_at: "2026-11-14T00:00:00Z", resolved_by: "y", resolution_note: "補登進貨" },
  ],
};
const BASE_RPC = {
  inv_combo_checkout: {
    combo_set_id: COMBO_OK,
    combo_name: "雜誌明信片組",
    sets: 1,
    sale_ids: ["s1", "s2"],
    sale_groups: ["g1"],
    total_amount: 300,
    total_cost: 120,
    basis: "list_price",
    allocation: [],
  },
  inv_save_combo_set: { id: U(9), created: true, approval_status: "pending", item_count: 2 },
  inv_set_combo_set_active: { id: COMBO_OK, name: "雜誌明信片組", is_active: false },
  inv_resubmit_combo_set: { id: COMBO_REJECTED, name: "退回組" },
  inv_submit_stock_adjustment: {
    changed: true,
    previous_status: "draft",
    status: "confirmed",
    needs_approval: false,
  },
  inv_resubmit_stock_adjustment: { changed: true, previous_status: "rejected" },
  inv_approve_record: { changed: true, module: "combo_sets", previous_status: "pending" },
};

/** 每支寫入的「一組合法參數」與 dry_run=false 後的期望。 */
const CASES = {
  create_combo_sale: {
    args: {
      idempotency_key: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaac1",
      combo_set_id: COMBO_OK,
      quantity: 2,
      payment_method: "LINE Pay",
      notes: "熟客",
      sale_date: "2026-11-15",
    },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [
      ["inv_combo_checkout"],
      {
        p_user_id: ADMIN_ID,
        p_combo_set_id: COMBO_OK,
        p_quantity: 2,
        p_sale_date: "2026-11-15",
        p_payment_method_id: PAY_LINE,
        p_notes: "熟客",
        p_override_reservation: false,
      },
    ],
  },
  create_combo_set: {
    args: {
      idempotency_key: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaac2",
      name: "新套餐",
      selling_price: 199,
      items: [
        { product_id: PROD1, quantity: 1 },
        { product_id: PROD2, quantity: 3 },
      ],
    },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [
      ["inv_save_combo_set"],
      {
        p_user_id: ADMIN_ID,
        p_id: null,
        p_payload: { name: "新套餐", selling_price: 199, notes: null, is_active: true },
        p_items: [
          { product_id: PROD1, quantity: 1 },
          { product_id: PROD2, quantity: 3 },
        ],
      },
    ],
  },
  update_combo_set: {
    args: { id: COMBO_OK, name: "雜誌明信片組（新）" },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [
      ["inv_save_combo_set"],
      {
        p_user_id: ADMIN_ID,
        p_id: COMBO_OK,
        p_payload: {
          name: "雜誌明信片組（新）",
          selling_price: 300,
          notes: null,
          is_active: true,
        },
        p_items: [
          { product_id: PROD1, quantity: 1 },
          { product_id: PROD2, quantity: 2 },
        ],
      },
    ],
  },
  set_combo_set_active: {
    args: { id: COMBO_OK, is_active: false },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [["inv_set_combo_set_active"], { p_id: COMBO_OK, p_is_active: false }],
  },
  resubmit_combo_set: {
    args: { id: COMBO_REJECTED },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [["inv_resubmit_combo_set"], { p_id: COMBO_REJECTED }],
  },
  submit_stock_adjustment: {
    args: { id: ADJ_DRAFT },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [["inv_submit_stock_adjustment"], { p_user_id: ADMIN_ID, p_id: ADJ_DRAFT }],
  },
  resolve_stock_alert: {
    args: { alert_id: 7, note: "補登進貨 2 本" },
    expect: () => {
      const w = dataWrites();
      return [
        log.rpc.length,
        w.map((x) => [x.table, x.op]),
        w[0]?.payload?.resolved_by,
        w[0]?.payload?.resolution_note,
        typeof w[0]?.payload?.resolved_at,
        tables.stock_oversold_alerts.find((r) => r.id === 8).resolution_note,
      ];
    },
    want: [
      0,
      [["stock_oversold_alerts", "update"]],
      ADMIN_ID,
      "補登進貨 2 本",
      "string",
      "補登進貨",
    ],
  },
};
check("每支寫入都有測試案例", Object.keys(CASES).sort(), WRITES);

// [2][3] ---------------------------------------------------------------------
console.log("\n[2] 預覽不寫、記 dry_run=true 稽核");
for (const n of WRITES) {
  resetDb(BASE_TABLES, BASE_RPC);
  const r = await asOAuth(() => H[n]({ ...CASES[n].args }));
  const out = parseOut(r);
  const a = audits();
  check(
    `${n} 預覽：不呼叫 RPC、不寫業務資料、一筆 dry_run=true 稽核`,
    [
      r.isError ?? false,
      out.dry_run,
      out.written,
      log.rpc.length,
      dataWrites().length,
      a.length,
      a[0]?.dry_run,
      a[0]?.tool,
    ],
    [false, true, false, 0, 0, 1, true, n],
  );
}
console.log("\n[3] dry_run=false 走後台同一支");
for (const n of WRITES) {
  resetDb(BASE_TABLES, BASE_RPC);
  const r = await asOAuth(() => H[n]({ ...CASES[n].args, dry_run: false }));
  const out = parseOut(r);
  check(`${n} 寫入：沒有錯誤`, [r.isError ?? false, out.dry_run], [false, false]);
  check(`${n} 寫入：呼叫的 RPC／參數`, CASES[n].expect(), CASES[n].want);
  const a = audits();
  check(`${n} 寫入：一筆 dry_run=false 稽核`, [a.length, a[0]?.dry_run, a[0]?.tool], [1, false, n]);
}

// [4] ------------------------------------------------------------------------
console.log("\n[4] 身分與 idempotency_key");
async function expectError(label, fn, actor = asOAuth) {
  resetDb(BASE_TABLES, BASE_RPC);
  const r = await actor(fn);
  check(label, [r.isError === true, log.rpc.length, dataWrites().length], [true, 0, 0]);
  return r;
}
for (const n of WRITES) {
  await expectError(
    `${n} 靜態 token 拒絕（預覽與寫入都不行）`,
    () => H[n]({ ...CASES[n].args, dry_run: false }),
    asStatic,
  );
}
for (const n of ["create_combo_sale", "create_combo_set"]) {
  const { idempotency_key: _k, ...noKey } = CASES[n].args;
  await expectError(`${n}：dry_run=false 沒帶 idempotency_key → 拒絕`, () =>
    H[n]({ ...noKey, dry_run: false }),
  );
  resetDb(BASE_TABLES, BASE_RPC);
  await asOAuth(() => H[n]({ ...CASES[n].args, dry_run: false }));
  const second = await asOAuth(() => H[n]({ ...CASES[n].args, dry_run: false }));
  check(
    `${n}：同一組 idempotency_key 第二次送出 → 拒絕、只建一次`,
    [second.isError, log.rpc.length],
    [true, 1],
  );
}

// [5] ------------------------------------------------------------------------
console.log("\n[5] 行為");
await expectError("create_combo_sale 待審的套餐不能賣", () =>
  H.create_combo_sale({ combo_set_id: COMBO_PENDING }),
);
await expectError("create_combo_sale 下架的套餐不能賣", () =>
  H.create_combo_sale({ combo_set_id: COMBO_OFF }),
);
await expectError("create_combo_sale 找不到套餐", () =>
  H.create_combo_sale({ combo_set_id: U(9) }),
);
await expectError("create_combo_sale 份數超過 100", () =>
  H.create_combo_sale({ combo_set_id: COMBO_OK, quantity: 101 }),
);
await expectError("create_combo_sale 付款方式名稱不存在", () =>
  H.create_combo_sale({ combo_set_id: COMBO_OK, payment_method: "比特幣" }),
);
await expectError("create_combo_sale 付款方式 id 與名稱同時給", () =>
  H.create_combo_sale({
    combo_set_id: COMBO_OK,
    payment_method: "現金",
    payment_method_id: PAY_CASH,
  }),
);
{
  resetDb(BASE_TABLES, BASE_RPC);
  const out = parseOut(
    await asOAuth(() => H.create_combo_sale({ combo_set_id: COMBO_OK, quantity: 3 })),
  );
  check(
    "create_combo_sale 預覽：超過能組的份數 → 警告會被拒、預設付款＝現金、品項總數×份數、金額＝組合價×份數",
    [
      typeof out.warning === "string" && out.warning.includes("拒絕"),
      out.will_create?.payment_method,
      out.will_create?.items?.map((i) => i.quantity_total),
      out.will_create?.total_amount,
      out.payment_method_options?.length,
    ],
    [true, "現金", [3, 6], 900, 2],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const ov = parseOut(
    await asOAuth(() =>
      H.create_combo_sale({ combo_set_id: COMBO_OK, quantity: 3, override_reservation: true }),
    ),
  );
  check(
    "create_combo_sale 預覽：override_reservation=true → 警告會記賣超告警",
    typeof ov.warning === "string" && ov.warning.includes("賣超告警"),
    true,
  );
  resetDb(BASE_TABLES, BASE_RPC);
  await asOAuth(() =>
    H.create_combo_sale({
      combo_set_id: COMBO_OK,
      override_reservation: true,
      idempotency_key: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaac9",
      dry_run: false,
    }),
  );
  check(
    "create_combo_sale override 原樣傳給 RPC、日期預設今天（台北）",
    [
      log.rpc[0]?.args?.p_override_reservation,
      /^\d{4}-\d{2}-\d{2}$/.test(log.rpc[0]?.args?.p_sale_date),
    ],
    [true, true],
  );
}
await expectError("create_combo_set 品項不在櫃檯清單（租借／未核准）→ 拒絕", () =>
  H.create_combo_set({
    name: "x",
    selling_price: 1,
    items: [{ product_id: PROD_RENTAL, quantity: 1 }],
  }),
);
await expectError("create_combo_set 同一件商品出現兩次 → 拒絕", () =>
  H.create_combo_set({
    name: "x",
    selling_price: 1,
    items: [
      { product_id: PROD1, quantity: 1 },
      { product_id: PROD1, quantity: 2 },
    ],
  }),
);
{
  const tomorrow = new Date(Date.now() + 8 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
  await expectError("create_combo_sale 銷售日期晚於今天（台北）→ 拒絕（審查 2026-11-15）", () =>
    H.create_combo_sale({ combo_set_id: COMBO_OK, sale_date: tomorrow }),
  );
  // 組合價 300 × 100 份 = 30,000，不到上限；把組合價調高看總額上限。
  resetDb(BASE_TABLES, BASE_RPC);
  const big = await asOAuth(async () => {
    const t = tables.inv_admin_combo_sets ?? tables.inv_combo_sets_admin;
    const row = (t ?? []).find((c) => (c.combo_set_id ?? c.id) === COMBO_OK);
    if (row) row.selling_price = 5_000;
    return H.create_combo_sale({ combo_set_id: COMBO_OK, quantity: 61 });
  });
  check(
    "create_combo_sale 總額超過 300,000 → 拒絕",
    [big.isError === true, /300,000/.test(big.content[0].text), log.rpc.length],
    [true, true, 0],
  );
  await expectError("create_combo_set 組合價超過 100,000 → 拒絕", () =>
    H.create_combo_set({
      name: "x",
      selling_price: 100_001,
      items: [{ product_id: PROD1, quantity: 1 }],
    }),
  );
  await expectError("update_combo_set 組合價超過 100,000 → 拒絕", () =>
    H.update_combo_set({ id: COMBO_OK, selling_price: 100_001 }),
  );
  check(
    "create_combo_sale 說明寫明上限與日期規則",
    /300,000/.test(META.create_combo_sale.description) &&
      /晚於今天/.test(META.create_combo_sale.description),
    true,
  );
}
await expectError("create_combo_set 售價負數 → 拒絕", () =>
  H.create_combo_set({ name: "x", selling_price: -1, items: [{ product_id: PROD1, quantity: 1 }] }),
);
{
  resetDb(BASE_TABLES, BASE_RPC);
  const out = parseOut(await asOAuth(() => H.create_combo_set(CASES.create_combo_set.args)));
  check(
    "create_combo_set 預覽：品名帶出、定價合計、預告待審",
    [
      out.will_create?.items?.map((i) => i.name),
      out.will_create?.total_list_price,
      out.will_create?.approval?.startsWith("pending"),
    ],
    [["小誌 12 期", "明信片"], 240, true],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const done = parseOut(
    await asOAuth(() => H.create_combo_set({ ...CASES.create_combo_set.args, dry_run: false })),
  );
  check("create_combo_set 寫入後回報待審 id（給 approve_inventory_record）", done.needs_approval, [
    { module: "combo_sets", id: U(9) },
  ]);

  resetDb(BASE_TABLES, BASE_RPC);
  const same = parseOut(
    await asOAuth(() => H.update_combo_set({ id: COMBO_OK, name: "雜誌明信片組", dry_run: false })),
  );
  check(
    "update_combo_set 沒有變更 → 不呼叫 RPC、written=false",
    [log.rpc.length, same.written],
    [0, false],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const price = parseOut(
    await asOAuth(() => H.update_combo_set({ id: COMBO_OK, selling_price: 250 })),
  );
  check(
    "update_combo_set 預覽：改價 → 列出前後值並警告重新送審",
    [
      price.changes?.selling_price,
      typeof price.warning === "string" && price.warning.includes("送審"),
    ],
    [{ before: 300, after: 250 }, true],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const nm = parseOut(await asOAuth(() => H.update_combo_set({ id: COMBO_OK, name: "改名" })));
  check(
    "update_combo_set 預覽：只改名 → 不警告送審",
    [Object.keys(nm.changes ?? {}), nm.warning],
    [["name"], undefined],
  );
  // 原本就在套餐裡、後來不在櫃檯清單的品項可以保留（與後台編輯頁相同）；新加的不行。
  resetDb(BASE_TABLES, BASE_RPC);
  const keep = await asOAuth(() =>
    H.update_combo_set({
      id: COMBO_REJECTED,
      items: [
        { product_id: PROD1, quantity: 2 },
        { product_id: PROD_RENTAL, quantity: 1 },
      ],
      dry_run: false,
    }),
  );
  check(
    "update_combo_set 保留原有的不在清單品項 → 照送 RPC（整組換掉）",
    [keep.isError ?? false, log.rpc[0]?.args?.p_items],
    [
      false,
      [
        { product_id: PROD1, quantity: 2 },
        { product_id: PROD_RENTAL, quantity: 1 },
      ],
    ],
  );
}
await expectError("update_combo_set 新加不在清單的品項 → 拒絕", () =>
  H.update_combo_set({ id: COMBO_OK, items: [{ product_id: PROD_RENTAL, quantity: 1 }] }),
);
await expectError("update_combo_set 找不到套餐", () => H.update_combo_set({ id: U(9), name: "x" }));
{
  resetDb(BASE_TABLES, BASE_RPC);
  const out = parseOut(
    await asOAuth(() => H.set_combo_set_active({ id: COMBO_OK, is_active: true, dry_run: false })),
  );
  check("set_combo_set_active 已經是上架 → no-op", [log.rpc.length, out.written], [0, false]);
  resetDb(BASE_TABLES, BASE_RPC);
  const out2 = parseOut(
    await asOAuth(() => H.resubmit_combo_set({ id: COMBO_OK, dry_run: false })),
  );
  check(
    "resubmit_combo_set 不是被退回的 → no-op",
    [log.rpc.length, out2.written, out2.status],
    [0, false, "approved"],
  );

  resetDb(BASE_TABLES, BASE_RPC);
  const pv = parseOut(await asOAuth(() => H.submit_stock_adjustment({ id: ADJ_DRAFT })));
  check(
    "submit_stock_adjustment 預覽：審核關閉 → draft → confirmed、說明庫存立刻變動",
    [pv.changes?.status, pv.target?.effect?.includes("立刻")],
    [{ before: "draft", after: "confirmed" }, true],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  await asOAuth(() => H.submit_stock_adjustment({ id: ADJ_REJECTED, dry_run: false }));
  check(
    "submit_stock_adjustment 被退回的 → inv_resubmit_stock_adjustment（＝重新送審按鈕）",
    [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    [["inv_resubmit_stock_adjustment"], { p_id: ADJ_REJECTED }],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const done = parseOut(
    await asOAuth(() => H.submit_stock_adjustment({ id: ADJ_CONFIRMED, dry_run: false })),
  );
  check(
    "submit_stock_adjustment 已確認的 → no-op（不沖帳）",
    [log.rpc.length, done.written],
    [0, false],
  );

  resetDb(BASE_TABLES, BASE_RPC);
  const res = parseOut(
    await asOAuth(() => H.resolve_stock_alert({ alert_id: 8, note: "覆蓋", dry_run: false })),
  );
  check(
    "resolve_stock_alert 已處理的 → 不寫、不覆蓋前一位的說明",
    [dataWrites().length, res.written, res.resolution_note],
    [0, false, "補登進貨"],
  );
}
await expectError("resolve_stock_alert 說明空白 → 拒絕", () =>
  H.resolve_stock_alert({ alert_id: 7, note: "  ", dry_run: false }),
);
await expectError("resolve_stock_alert 找不到", () =>
  H.resolve_stock_alert({ alert_id: 99, note: "x", dry_run: false }),
);
await expectError("submit_stock_adjustment 找不到", () =>
  H.submit_stock_adjustment({ id: U(9), dry_run: false }),
);

// [6] ------------------------------------------------------------------------
console.log("\n[6] 讀取");
{
  resetDb(BASE_TABLES, BASE_RPC);
  const list = parseOut(await H.list_combo_sets({}));
  const ok = list.rows?.find((r) => r.id === COMBO_OK);
  check(
    "list_combo_sets：全部列出、帶組成品項、不回 user_id、不寫",
    [
      list.total,
      ok?.items?.map((i) => i.name),
      "user_id" in (ok ?? {}),
      log.rpc.length,
      log.writes.length,
    ],
    [4, ["小誌 12 期", "明信片"], false, 0, 0],
  );
  const pg = parseOut(await H.list_combo_sets({ limit: 1, page: 2 }));
  check("list_combo_sets 分頁", [pg.rows?.length, pg.has_more], [1, true]);
  const one = parseOut(await H.get_combo_set({ id: COMBO_OK }));
  check(
    "get_combo_set：套餐＋品項＋審核設定＋賣得動",
    [
      one.combo?.name,
      one.items?.length,
      one.approval_setting,
      one.sellable_at_pos,
      "user_id" in (one.combo ?? {}),
    ],
    ["雜誌明信片組", 2, "需要審核", true, false],
  );
  const miss = await H.get_combo_set({ id: U(9) });
  check("get_combo_set 找不到 → isError", miss.isError, true);
  const adjs = parseOut(await H.list_stock_adjustments({}));
  check(
    "list_stock_adjustments：列出三張、id 欄位對上",
    [adjs.total, adjs.rows?.map((r) => r.id)],
    [3, [ADJ_DRAFT, ADJ_REJECTED, ADJ_CONFIRMED]],
  );
  const drafts = parseOut(await H.list_stock_adjustments({ status: "draft" }));
  check(
    "list_stock_adjustments status 篩選",
    drafts.rows?.map((r) => r.id),
    [ADJ_DRAFT],
  );
  const a1 = parseOut(await H.get_stock_adjustment({ id: ADJ_DRAFT }));
  check(
    "get_stock_adjustment：單號、不回 user_id",
    [a1.adjustment?.adjustment_number, "user_id" in (a1.adjustment ?? {})],
    ["EXP-0010", false],
  );
  check("讀取工具不寫任何東西", [log.rpc.length, log.writes.length], [0, 0]);
}

// [7] ------------------------------------------------------------------------
console.log("\n[7] 套餐核准（approve_inventory_record module=combo_sets）");
{
  resetDb(BASE_TABLES, BASE_RPC);
  const pv = parseOut(
    await asOAuth(() =>
      OPS.approve_inventory_record({
        module: "combo_sets",
        id: COMBO_PENDING,
        decision: "approve",
      }),
    ),
  );
  check(
    "預覽：pending → approved、不呼叫 RPC",
    [pv.changes?.status, pv.target?.name, log.rpc.length],
    [{ before: "pending", after: "approved" }, "待審組", 0],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const done = parseOut(
    await asOAuth(() =>
      OPS.approve_inventory_record({
        module: "combo_sets",
        id: COMBO_PENDING,
        decision: "reject",
        dry_run: false,
      }),
    ),
  );
  check(
    "寫入：inv_approve_record（＝後台 approveComboSet 同一支）",
    [done.written, log.rpc.map((r) => r.name), log.rpc[0]?.args],
    [
      true,
      ["inv_approve_record"],
      { p_user_id: ADMIN_ID, p_module: "combo_sets", p_id: COMBO_PENDING, p_approved: false },
    ],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const noop = parseOut(
    await asOAuth(() =>
      OPS.approve_inventory_record({
        module: "combo_sets",
        id: COMBO_OK,
        decision: "approve",
        dry_run: false,
      }),
    ),
  );
  check("已核准的套餐 → no-op", [log.rpc.length, noop.written], [0, false]);
  resetDb(BASE_TABLES, BASE_RPC);
  const st = await asStatic(() =>
    OPS.approve_inventory_record({
      module: "combo_sets",
      id: COMBO_PENDING,
      decision: "approve",
      dry_run: false,
    }),
  );
  check("靜態 token 拒絕", [st.isError, log.rpc.length], [true, 0]);
  resetDb(BASE_TABLES, BASE_RPC);
  const pend = parseOut(await asOAuth(() => OPS.list_pending_approvals({ module: "combo_sets" })));
  check(
    "list_pending_approvals module=combo_sets：列出待審套餐、審核設定",
    [
      pend.combo_sets?.rows?.map((r) => r.id),
      pend.approval_settings?.combo_sets,
      "products" in pend,
    ],
    [[COMBO_PENDING], "需要審核", false],
  );
}

// [8] ------------------------------------------------------------------------
console.log("\n[8] 靜態");
const code = readFile(join(SRC, "server/mcp/pos-stock-tools.ts"))
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
check(
  "自己不寫 .update(/.insert(/.delete(/.upsert(/.rpc(",
  /\.(update|insert|delete|upsert|rpc)\(/.test(code),
  false,
);
check(
  "不呼叫刪除／沖帳的 repo",
  /deleteComboSet|deleteAdjustment|reverseAdjustment/.test(code),
  false,
);
check("不 import 寄信模組", /@\/server\/notify/.test(code), false);
const toolsSrc = readFile(join(SRC, "server/mcp/tools.ts"));
check(
  "tools.ts 有註冊（import、TOOL_INPUTS、handlers）",
  [
    toolsSrc.includes('from "./pos-stock-tools"'),
    toolsSrc.includes("...POS_STOCK_TOOL_INPUTS"),
    toolsSrc.includes("[POS_STOCK_TOOL_META, POS_STOCK_HANDLERS"),
  ],
  [true, true, true],
);

console.info = origInfo;
console.log(
  fail === 0
    ? green(`\n✓ 全部通過：${pass} passed, 0 failed`)
    : red(`\n✗ 有失敗：${pass} passed, ${fail} failed`),
);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
