#!/usr/bin/env node
/**
 * mcp-ops-write-selftest.mjs —— MCP 營運寫入工具（階段 B，src/server/mcp/ops-write-tools.ts）
 *
 *   [1] 形狀：三份匯出對得起來、每支有 annotations、寫入工具 dry_run 預設 true、讀取工具 readOnlyHint
 *   [2] 沒有任何工具收祕密欄位（匯款帳戶、token、金鑰、密碼、notify_emails 寫入）
 *   [3] 每支寫入：預覽不呼叫寫入 RPC／不 update／不 insert（稽核除外），且記一筆 dry_run=true 的稽核
 *   [4] 每支寫入：dry_run=false 才呼叫正確的 repo／RPC 與參數，並記一筆 dry_run=false 的稽核
 *   [5] 錯誤輸入回 isError；靜態 token 打需要操作人員的 RPC → isError、不寫
 *   [6] 靜態：這個檔案自己不寫 update／insert／delete／rpc、不 import 寄信模組、不用 payments 的 markOrderPaid
 *
 * 用假的 supabaseAdmin（記錄 rpc 與寫入、照 eq／in 篩選）跑 production 的 handler 與 repo 本人。
 * repos/orders.ts（createOrder 那一整條）換成記錄呼叫的假模組——那條路有自己的自檢
 * （admin-phone-order-selftest.mjs），這裡只驗 MCP 傳給它的參數。
 *
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15（module.registerHooks）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/mcp-ops-write-selftest.mjs";
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
    is: pass_,
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
          // 一次性表：主鍵重複 → 23505（idempotency_key 重送）。
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

// 假的 repos/orders.ts：只記錄 createAdminPhoneOrder 收到的參數。
globalThis.__phoneCalls = [];
const FAKE_ORDERS =
  "data:text/javascript," +
  encodeURIComponent(`
    export class AdminPhoneOrderInputError extends Error { constructor(c){ super(c); this.code=c; } }
    export class AdminPhoneOrderUncertainError extends Error {}
    export async function createAdminPhoneOrder(payload, admin) {
      globalThis.__phoneCalls.push({ payload, admin });
      return { orderId: "99999999-9999-4999-8999-999999999999", orderNo: "P0001", total: 600, paymentStatus: "pending" };
    }
  `);

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
    if (spec === "@/server/repos/orders") return { url: FAKE_ORDERS, shortCircuit: true };
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

// 稽核會 console.info 一行；自檢輸出不需要它。
const origInfo = console.info;
console.info = () => {};

const MOD = await import(join(SRC, "server/mcp/ops-write-tools.ts"));
const { OPS_WRITE_TOOL_INPUTS: INPUTS, OPS_WRITE_TOOL_META: META, OPS_WRITE_HANDLERS: H } = MOD;
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
// 業務資料的寫入（稽核表與 idempotency_key 的一次性表不算）。
const dataWrites = () =>
  log.writes.filter((w) => w.table !== "mcp_audit_log" && w.table !== "mcp_oauth_used_codes");

console.log("═══ MCP 營運寫入工具（階段 B）自檢 ═══");

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
check(
  "讀取工具＝get_／list_ 開頭",
  READS.every((n) => /^(get|list)_/.test(n)),
  true,
);
check("寫入工具清單", WRITES, [
  "approve_inventory_record",
  "create_inventory_product",
  "create_phone_order",
  "create_pos_sale",
  "create_purchase",
  "create_secondhand_sale",
  "create_stock_adjustment",
  "mark_order_paid",
  "record_stock_count",
  "remove_registration",
  "update_journey_wish",
  "update_order_fulfillment",
  "update_partnership_inquiry",
  "update_phone_order_contacts",
  "update_registration_participant",
  "update_site_settings",
  "update_ui_string",
]);
check(
  "每支都有 title／description／四個 annotations",
  names.every(
    (n) =>
      META[n].title &&
      META[n].description &&
      ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].every(
        (k) => typeof META[n].annotations[k] === "boolean",
      ),
  ),
  true,
);
check(
  "remove_registration 標 destructiveHint",
  META.remove_registration.annotations.destructiveHint,
  true,
);
const dryDefaults = WRITES.map((n) => {
  const js = z.toJSONSchema(INPUTS[n], { io: "input" });
  return js.properties?.dry_run?.default;
});
check(
  "每支寫入 dry_run 預設 true",
  dryDefaults.every((d) => d === true),
  true,
);

// 與既有工具不撞名（tools.ts／admin-read-tools.ts／create-tools.ts／image-upload.ts 的 schema key）
const existing = new Set();
for (const f of ["tools.ts", "admin-read-tools.ts", "create-tools.ts", "image-upload.ts"]) {
  for (const m of readFile(join(SRC, "server/mcp", f)).matchAll(/^ {2}([a-z_]+): z/gm))
    existing.add(m[1]);
}
check(
  "不與既有 MCP 工具撞名",
  names.filter((n) => existing.has(n)),
  [],
);

// [2] ------------------------------------------------------------------------
console.log("\n[2] 沒有祕密欄位");
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
const offenders = [];
for (const n of names) {
  for (const p of propNames(z.toJSONSchema(INPUTS[n], { io: "input" }))) {
    if (SECRET_RE.test(p)) offenders.push(`${n}.${p}`);
  }
}
check("輸入沒有任何祕密／帳戶／notify_emails 欄位", offenders, []);

// [3][4] ---------------------------------------------------------------------
const U = (n) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const ORDER_SHIP = U(1);
const ORDER_TRANSFER = U(2);
const ORDER_CARD = U(3);
const ORDER_PHONE = U(4);
const REG1 = U(5);
const REG2 = U(6);
const SESS1 = U(7);
const WISH1 = U(8);
const INQ1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROD1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROD2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROD_PENDING = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PUR_PENDING = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PUR_DONE = "12121212-1212-4121-8121-121212121212";
const ADJ_PENDING = "13131313-1313-4131-8131-131313131313";
const PAY_CASH = "14141414-1414-4141-8141-141414141414";
const PAY_LINE = "15151515-1515-4151-8151-151515151515";
const CAT1 = "16161616-1616-4161-8161-161616161616";
const L = (zh) => ({ zh, en: `${zh}-en`, ja: `${zh}-ja` });
const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();

const BASE_TABLES = {
  orders: [
    {
      id: ORDER_SHIP,
      order_no: "A001",
      status: "processing",
      payment_status: "paid",
      payment_method: "card",
      paid_at: "2026-11-01T00:00:00Z",
      shipping_method: "home",
      shipped_at: null,
      completed_at: null,
      total: 500,
      source: "web",
    },
    {
      id: ORDER_TRANSFER,
      order_no: "B001",
      status: "pending",
      payment_status: "pending",
      payment_method: "transfer",
      paid_at: null,
      shipping_method: "none",
      shipped_at: null,
      completed_at: null,
      total: 800,
      source: "web",
    },
    {
      id: ORDER_CARD,
      order_no: "C001",
      status: "pending",
      payment_status: "pending",
      payment_method: "card",
      paid_at: null,
      shipping_method: "none",
      shipped_at: null,
      completed_at: null,
      total: 300,
      source: "web",
    },
    {
      id: ORDER_PHONE,
      order_no: "P900",
      status: "pending",
      payment_status: "pending",
      payment_method: "transfer",
      paid_at: null,
      shipping_method: "none",
      shipped_at: null,
      completed_at: null,
      total: 300,
      source: "admin_phone",
      notify_customer: false,
      customer_name: "林大同",
      customer_email: "",
      customer_phone: "0912345678",
    },
  ],
  event_registrations: [
    {
      id: REG1,
      order_id: ORDER_TRANSFER,
      session_id: SESS1,
      seat_no: 1,
      name: "王小明",
      email: null,
      phone: null,
      created_at: "2026-11-01T00:00:00Z",
    },
    {
      id: REG2,
      order_id: ORDER_PHONE,
      session_id: SESS1,
      seat_no: 1,
      name: "林大同",
      email: null,
      phone: null,
      created_at: "2026-11-01T00:00:00Z",
    },
  ],
  // 0021 的名單 view（listSessionRoster 讀它）。REG1 在簽到表上（on_roster）且已付款。
  // ⚠️ 0059 之前這一列是 payment_status 'pending' + on_roster true——那個組合在 0058 之前
  //    根本不存在（on_roster 就是 paid），測試靠 on_roster 判斷退款警告才過得了。0059 起警告
  //    看實際的 payment_status，所以 fixture 改成真的已付款。
  admin_event_roster: [
    {
      registration_id: REG1,
      session_id: SESS1,
      order_id: ORDER_TRANSFER,
      order_item_id: 1,
      seat_no: 1,
      name: "王小明",
      notice_ack_at: null,
      created_at: "2026-11-01T00:00:00Z",
      order_no: "B001",
      payment_status: "paid",
      paid_at: "2026-11-01T01:00:00Z",
      on_roster: true,
      onsite_unpaid: false,
    },
  ],
  event_sessions: [
    {
      id: SESS1,
      product_id: "prod-1",
      title: L("週六場"),
      starts_at: FUTURE,
      ends_at: null,
      capacity: 10,
      seats_taken: 2,
      sort_order: 0,
      status: "open",
    },
  ],
  products: [
    { id: "prod-1", title: L("讀書會"), product_type: "event", price: 300, status: "active" },
  ],
  event_session_plans: [],
  journey_wishes: [
    { id: WISH1, status: "new", admin_note: "", updated_at: "2026-11-01T00:00:00Z" },
  ],
  partnership_inquiries: [
    { id: INQ1, status: "new", admin_note: "舊備註", updated_at: "2026-11-01T00:00:00Z" },
  ],
  inv_admin_products: [
    {
      inv_product_id: PROD1,
      name: "小誌 12 期",
      issue_number: "12",
      barcode: "9789860000001",
      stock_quantity: 10,
      cost_price: 100,
      selling_price: 150,
      approval_status: "approved",
      is_active: true,
      product_type: "outright",
      user_id: "x",
    },
    {
      inv_product_id: PROD2,
      name: "明信片",
      issue_number: null,
      barcode: null,
      stock_quantity: 4,
      cost_price: 10,
      selling_price: 30,
      approval_status: "approved",
      is_active: true,
      product_type: "outright",
      user_id: "x",
    },
    {
      inv_product_id: PROD_PENDING,
      name: "個人藏書：海邊的卡夫卡",
      issue_number: null,
      barcode: null,
      stock_quantity: 0,
      cost_price: 0,
      selling_price: 200,
      approval_status: "pending",
      is_active: true,
      product_type: "outright",
      creator_name: "店長",
      user_id: "x",
    },
  ],
  inv_pos_products: [
    {
      inv_product_id: PROD1,
      name: "小誌 12 期",
      issue_number: "12",
      selling_price: 150,
      stock_quantity: 10,
      reserved: 2,
      available: 8,
    },
    {
      inv_product_id: PROD2,
      name: "明信片",
      issue_number: null,
      selling_price: 30,
      stock_quantity: 4,
      reserved: 0,
      available: 4,
    },
  ],
  inv_pos_payment_methods: [
    { payment_method_id: PAY_CASH, name: "現金", is_default: true, display_order: 1 },
    { payment_method_id: PAY_LINE, name: "LINE Pay", is_default: false, display_order: 2 },
  ],
  inv_admin_categories: [{ category_id: CAT1, name: "二手書", icon: null, display_order: 1 }],
  inv_admin_vendors: [],
  inv_admin_approval_settings: [
    { module: "products", is_enabled: true, updated_at: "2026-11-01T00:00:00Z" },
    { module: "purchases", is_enabled: true, updated_at: "2026-11-01T00:00:00Z" },
  ],
  inv_admin_purchases: [
    {
      purchase_id: PUR_PENDING,
      product_id: PROD_PENDING,
      product_name: "個人藏書：海邊的卡夫卡",
      item_name: null,
      purchase_date: "2026-11-15",
      quantity: 1,
      unit_cost: 0,
      subtotal: 0,
      approval_status: "pending",
      creator_name: "店長",
      user_id: "x",
    },
    {
      purchase_id: PUR_DONE,
      product_id: PROD1,
      product_name: "小誌 12 期",
      item_name: null,
      purchase_date: "2026-11-01",
      quantity: 5,
      unit_cost: 80,
      subtotal: 400,
      approval_status: "approved",
      user_id: "x",
    },
  ],
  inv_admin_stock_adjustments: [
    {
      adjustment_id: ADJ_PENDING,
      adjustment_number: "EXP-0001",
      product_id: PROD1,
      product_name: "小誌 12 期",
      product_stock_quantity: 10,
      category: "EXP",
      quantity: -1,
      reason: "damage",
      status: "pending_approval",
      user_id: "x",
    },
  ],
  ui_strings: [{ group_key: "nav", string_key: "home", value: L("首頁"), sort_order: 1 }],
  site_settings: [
    {
      id: 1,
      short_desc: L("簡介"),
      address: L("地址"),
      city: L("台北"),
      hours: L("12-20"),
      closed: L("週一"),
      contact_email: "hi@example.com",
      site_url: "https://example.com",
      social_instagram: "",
      social_facebook: "",
      social_line: "",
      map_embed: "",
      map_link: "",
      map_apple: "",
      meta_site_name: "小時光",
      meta_author: "",
      meta_twitter_card: "summary",
      meta_og_type: "website",
      default_meta_title: "t",
      default_meta_description: "d",
      notify_emails: "owner@example.com",
      bank_name: "某銀行",
      bank_code: "000",
      bank_account: "1234567890",
      bank_account_name: "某某",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
    },
  ],
  email_copy: [{ template_key: "paid", string_key: "subject", value: L("付款成功") }],
};
const BASE_RPC = {
  admin_mark_order_paid: [{ marked: true, reason: "marked", order_no: "B001" }],
  admin_delete_registration: [{ deleted: true, reason: "deleted", freed: 1 }],
  admin_update_phone_order_contacts: [{ updated: true, reason: "updated" }],
  inv_save_stock_adjustment: {
    id: "adj-1",
    adjustment_number: "ADJ-0001",
    status: "confirmed",
    needs_approval: false,
    stock_before: 10,
  },
  inv_record_stock_count: {
    created: 1,
    skipped: 1,
    shrinkage: 2,
    surplus: 0,
    status: "confirmed",
    needs_approval: false,
    ids: ["cnt-1"],
  },
  inv_save_purchase: {
    id: "pur-1",
    created: true,
    approval_status: "pending",
    needs_approval: true,
  },
  // 回讀用：假 DB 不會真的建列，所以讓 RPC 回傳表裡那件待審商品的 id。
  inv_save_product: {
    id: PROD_PENDING,
    created: true,
    purchase_created: true,
    price_change_pending: false,
  },
  inv_approve_record: { changed: true, module: "purchases", previous_status: "pending" },
  pos_checkout: { sale_ids: ["sale-1"], total_amount: 270, total_cost: 110, oversold: [] },
  inv_secondhand_checkout: {
    sale_id: "sale-2",
    item_name: "海邊的卡夫卡",
    quantity: 1,
    amount: 200,
  },
};

/** 每支寫入的「一組合法參數」與正式寫入後的期望。 */
const CASES = {
  update_order_fulfillment: {
    args: { order_id: ORDER_SHIP, action: "ship" },
    expect: () => {
      const w = dataWrites();
      return [w.length, w[0]?.table, w[0]?.payload?.status, typeof w[0]?.payload?.shipped_at];
    },
    want: [1, "orders", "shipped", "string"],
  },
  mark_order_paid: {
    args: { order_no: "B001", note: "對到 11/2 那筆" },
    expect: () => [log.rpc.map((c) => c.name), log.rpc[0]?.args],
    want: [
      ["admin_mark_order_paid"],
      { p_order_id: ORDER_TRANSFER, p_actor_id: ADMIN_ID, p_note: "對到 11/2 那筆" },
    ],
  },
  create_phone_order: {
    args: {
      customer_name: "陳小華",
      customer_phone: "0911222333",
      product_id: "prod-1",
      session_id: SESS1,
      quantity: 2,
      payment_status: "paid",
      paid_on: "2026-11-02",
      last5: "12345",
      idempotency_key: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    },
    expect: () => {
      const c = globalThis.__phoneCalls[0];
      return [
        globalThis.__phoneCalls.length,
        c?.admin?.actorId,
        c?.admin?.paidUpfront,
        c?.payload?.idempotencyKey,
        c?.payload?.items?.[0]?.participants?.map((p) => p.name),
        log.rpc.map((r) => [r.name, r.args.p_actor_id]),
      ];
    },
    want: [
      1,
      ADMIN_ID,
      true,
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ["陳小華", "陳小華 同行者 1"],
      [["admin_mark_order_paid", ADMIN_ID]],
    ],
  },
  update_phone_order_contacts: {
    args: {
      order_id: ORDER_PHONE,
      customer: { email: "lin@example.com" },
      participants: [{ id: REG2, phone: "0922333444" }],
    },
    expect: () => [
      log.rpc.map((r) => r.name),
      log.rpc[0]?.args?.p_actor_id,
      log.rpc[0]?.args?.p_customer,
      log.rpc[0]?.args?.p_participants,
    ],
    want: [
      ["admin_update_phone_order_contacts"],
      ADMIN_ID,
      { name: "林大同", email: "lin@example.com", phone: "0912345678" },
      [{ id: REG2, name: "林大同", email: null, phone: "0922333444" }],
    ],
  },
  remove_registration: {
    args: { session_id: SESS1, registration_id: REG1 },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [["admin_delete_registration"], { p_registration_id: REG1, p_actor_id: ADMIN_ID }],
  },
  update_registration_participant: {
    args: {
      registration_id: REG1,
      phone: "0922-333 444",
      expected: { name: "王小明", email: null, phone: null },
      idempotency_key: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
    },
    expect: () => [log.rpc.length, dataWrites().map((w) => [w.table, w.op, w.payload])],
    want: [
      0,
      [["event_registrations", "update", { name: "王小明", email: null, phone: "0922-333 444" }]],
    ],
  },
  update_journey_wish: {
    args: { id: WISH1, status: "reviewed", admin_note: "已回覆" },
    expect: () => [
      dataWrites().map((w) => [w.table, w.op, w.payload.status, w.payload.admin_note]),
    ],
    want: [[["journey_wishes", "update", "reviewed", "已回覆"]]],
  },
  update_partnership_inquiry: {
    args: { id: INQ1, status: "replied" },
    expect: () => [
      dataWrites().map((w) => [w.table, w.op, w.payload.status, w.payload.admin_note]),
    ],
    want: [[["partnership_inquiries", "update", "replied", "舊備註"]]],
  },
  create_stock_adjustment: {
    args: {
      idempotency_key: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      product_id: PROD1,
      category: "EXP",
      quantity: -2,
      reason: "damage",
      adjustment_date: "2026-11-02",
    },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [
      ["inv_save_stock_adjustment"],
      {
        p_user_id: ADMIN_ID,
        p_payload: {
          product_id: PROD1,
          adjustment_date: "2026-11-02",
          category: "EXP",
          quantity: -2,
          reason: "damage",
          notes: null,
        },
        p_submit: true,
      },
    ],
  },
  record_stock_count: {
    args: {
      idempotency_key: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      rows: [
        { product_id: PROD1, actual_quantity: 8 },
        { product_id: PROD2, actual_quantity: 4 },
      ],
      reason: "count_error",
      adjustment_date: "2026-11-02",
    },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [
      ["inv_record_stock_count"],
      {
        p_user_id: ADMIN_ID,
        p_rows: [
          { product_id: PROD1, actual_quantity: 8 },
          { product_id: PROD2, actual_quantity: 4 },
        ],
        p_options: { reason: "count_error", notes: null, adjustment_date: "2026-11-02" },
      },
    ],
  },
  create_purchase: {
    args: {
      idempotency_key: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      product_id: PROD1,
      quantity: 20,
      unit_cost: 80,
      purchase_date: "2026-11-02",
      vendor: "某出版社",
    },
    expect: () => [
      log.rpc.map((r) => r.name),
      log.rpc[0]?.args?.p_user_id,
      log.rpc[0]?.args?.p_id,
      log.rpc[0]?.args?.p_payload?.product_id,
      log.rpc[0]?.args?.p_payload?.quantity,
      "approval_status" in (log.rpc[0]?.args?.p_payload ?? {}),
    ],
    want: [["inv_save_purchase"], ADMIN_ID, null, PROD1, 20, false],
  },
  create_inventory_product: {
    args: {
      idempotency_key: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaab1",
      name: "個人藏書：海邊的卡夫卡",
      selling_price: 200,
      category_id: CAT1,
      notes: "店長個人藏書",
      purchase: { quantity: 1, cost_price: 0, purchase_date: "2026-11-15" },
    },
    expect: () => [
      log.rpc.map((r) => r.name),
      log.rpc[0]?.args?.p_user_id,
      log.rpc[0]?.args?.p_id,
      log.rpc[0]?.args?.p_payload?.name,
      log.rpc[0]?.args?.p_payload?.low_stock_alert,
      log.rpc[0]?.args?.p_payload?.pack_size,
      log.rpc[0]?.args?.p_payload?.product_type,
      ["approval_status", "stock_quantity", "user_id", "purchase", "id"].filter(
        (k) => k in (log.rpc[0]?.args?.p_payload ?? {}),
      ),
      log.rpc[0]?.args?.p_purchase,
    ],
    want: [
      ["inv_save_product"],
      ADMIN_ID,
      null,
      "個人藏書：海邊的卡夫卡",
      5,
      1,
      "outright",
      [],
      { quantity: 1, cost_price: 0, vendor: null, purchase_date: "2026-11-15" },
    ],
  },
  approve_inventory_record: {
    args: { module: "purchases", id: PUR_PENDING, decision: "approve" },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [
      ["inv_approve_record"],
      { p_user_id: ADMIN_ID, p_module: "purchases", p_id: PUR_PENDING, p_approved: true },
    ],
  },
  create_pos_sale: {
    args: {
      idempotency_key: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaab2",
      items: [
        { product_id: PROD1, quantity: 1, unit_price: 120 },
        { product_id: PROD2, quantity: 2 },
      ],
      payment_method: "LINE Pay",
      notes: "熟客折扣",
      sale_date: "2026-11-15",
    },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [
      ["pos_checkout"],
      {
        p_user_id: ADMIN_ID,
        p_items: [
          { inv_product_id: PROD1, quantity: 1, unit_price: 120 },
          { inv_product_id: PROD2, quantity: 2, unit_price: 30 },
        ],
        p_payment_method_id: PAY_LINE,
        p_sale_date: "2026-11-15",
        p_notes: "熟客折扣",
        p_override_reservation: false,
      },
    ],
  },
  create_secondhand_sale: {
    args: {
      idempotency_key: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaab3",
      item_name: "海邊的卡夫卡",
      unit_price: 200,
      sale_date: "2026-11-15",
    },
    expect: () => [log.rpc.map((r) => r.name), log.rpc[0]?.args],
    want: [
      ["inv_secondhand_checkout"],
      {
        p_user_id: ADMIN_ID,
        p_item_name: "海邊的卡夫卡",
        p_quantity: 1,
        p_unit_price: 200,
        p_sale_date: "2026-11-15",
        p_payment_method_id: PAY_CASH,
        p_notes: null,
      },
    ],
  },
  update_ui_string: {
    args: {
      group_key: "nav",
      string_key: "home",
      value: { zh: "回首頁", en: "Home", ja: "ホーム" },
    },
    expect: () => [dataWrites().map((w) => [w.table, w.op, w.payload])],
    want: [
      [
        [
          "ui_strings",
          "update",
          { value: { zh: "回首頁", en: "Home", ja: "ホーム" }, sort_order: 1 },
        ],
      ],
    ],
  },
  update_site_settings: {
    args: { hours: { zh: "13-21", en: "1-9pm", ja: "13-21時" }, social_line: "https://line.me/x" },
    expect: () => {
      const w = dataWrites();
      const p = w[0]?.payload ?? {};
      return [
        w.map((x) => [x.table, x.op]),
        p.hours,
        p.social_line,
        p.notify_emails,
        Object.keys(p).filter((k) => k.startsWith("bank")),
      ];
    },
    want: [
      [["site_settings", "update"]],
      { zh: "13-21", en: "1-9pm", ja: "13-21時" },
      "https://line.me/x",
      "owner@example.com",
      [],
    ],
  },
};

check(
  "每支寫入工具都有測試案例",
  WRITES.filter((n) => !CASES[n]),
  [],
);

console.log("\n[3] 預覽（dry_run 預設 true）不寫入、記一筆 dry_run=true 稽核");
for (const n of WRITES) {
  resetDb(BASE_TABLES, BASE_RPC);
  globalThis.__phoneCalls = [];
  const r = await asOAuth(() => H[n](CASES[n].args));
  const out = parseOut(r);
  const a = audits();
  check(
    `${n}：預覽成功、written=false、沒有 rpc／資料寫入、稽核 1 筆 dry_run=true`,
    [
      r.isError === true ? `isError: ${r.content[0].text}` : "ok",
      out.dry_run,
      out.written,
      log.rpc.length,
      dataWrites().length,
      globalThis.__phoneCalls.length,
      a.length,
      a[0]?.dry_run,
      a[0]?.tool,
    ],
    ["ok", true, false, 0, 0, 0, 1, true, n],
  );
}

console.log("\n[4] dry_run=false 才呼叫正確的 repo／RPC，並記一筆 dry_run=false 稽核");
for (const n of WRITES) {
  resetDb(BASE_TABLES, BASE_RPC);
  globalThis.__phoneCalls = [];
  const r = await asOAuth(() => H[n]({ ...CASES[n].args, dry_run: false }));
  const out = parseOut(r);
  const a = audits();
  check(
    `${n}：寫入成功`,
    [r.isError === true ? `isError: ${r.content[0].text}` : "ok", out.dry_run],
    ["ok", false],
  );
  check(`${n}：呼叫參數`, CASES[n].expect(), CASES[n].want);
  check(
    `${n}：稽核 1 筆 dry_run=false、actor 是 OAuth 那位`,
    [a.length, a[0]?.dry_run, a[0]?.tool, a[0]?.actor_user_id],
    [1, false, n, ADMIN_ID],
  );
}

// 個資不進稽核
resetDb(BASE_TABLES, BASE_RPC);
await asOAuth(() =>
  H.remove_registration({ session_id: SESS1, registration_id: REG1, dry_run: false }),
);
check(
  "remove_registration 稽核只記姓名首字",
  [audits()[0]?.changes?.name_initial, JSON.stringify(audits()[0]).includes("王小明")],
  ["王", false],
);
resetDb(BASE_TABLES, BASE_RPC);
const rrPreview = parseOut(
  await asOAuth(() => H.remove_registration({ session_id: SESS1, registration_id: REG1 })),
);
check(
  "remove_registration 預覽：已付款 → 警告不退款",
  [
    rrPreview.will_remove?.name,
    typeof rrPreview.warning === "string" && rrPreview.warning.includes("不會退款"),
  ],
  ["王小明", true],
);
// 0059：現場付款、還沒付錢的人也在簽到表上（on_roster），但沒有錢可退——不跳退款警告。
resetDb(
  {
    ...BASE_TABLES,
    admin_event_roster: BASE_TABLES.admin_event_roster.map((r) => ({
      ...r,
      payment_status: "pending",
      paid_at: null,
      on_roster: true,
      onsite_unpaid: true,
    })),
  },
  BASE_RPC,
);
const rrOnsite = parseOut(
  await asOAuth(() => H.remove_registration({ session_id: SESS1, registration_id: REG1 })),
);
check(
  "🔴 remove_registration 預覽：現場付款未收款（on_roster）→ 不跳退款警告",
  [
    typeof rrOnsite.warning === "string" && rrOnsite.warning.includes("不會退款"),
    typeof rrOnsite.warning === "string" && rrOnsite.warning.includes("沒有款項要退"),
  ],
  [false, true],
);
resetDb(BASE_TABLES, BASE_RPC);
await asOAuth(() =>
  H.update_phone_order_contacts({ ...CASES.update_phone_order_contacts.args, dry_run: false }),
);
check(
  "update_phone_order_contacts 稽核只記欄位名、不記新值",
  [audits()[0]?.changes?.fields, JSON.stringify(audits()[0]).includes("lin@example.com")],
  [["customer.email", "participant[1].phone"], false],
);
resetDb(BASE_TABLES, BASE_RPC);
globalThis.__phoneCalls = [];
await asOAuth(() => H.create_phone_order({ ...CASES.create_phone_order.args, dry_run: false }));
check(
  "create_phone_order 稽核不含客人姓名電話",
  [JSON.stringify(audits()).includes("陳小華"), JSON.stringify(audits()).includes("0911222333")],
  [false, false],
);

// update_registration_participant：稽核記前後值、伺服器 log 不印值、定位、只改三欄
{
  resetDb(BASE_TABLES, BASE_RPC);
  const logged = [];
  console.info = (line) => logged.push(String(line));
  const r = parseOut(
    await asOAuth(() =>
      H.update_registration_participant({
        ...CASES.update_registration_participant.args,
        name: "  陳\u0007大文 ",
        dry_run: false,
      }),
    ),
  );
  console.info = () => {};
  const a = audits()[0];
  check(
    "update_registration_participant 稽核記前後值（姓名經 singleLine 清洗）",
    [a?.action, a?.entity, a?.changes?.fields, "_log_redact" in (a?.changes ?? {})],
    [
      "update_participant",
      "event_registration",
      {
        name: { before: "王小明", after: "陳 大文" },
        phone: { before: null, after: "0922-333 444" },
      },
      false,
    ],
  );
  check(
    "update_registration_participant 伺服器 log 只印欄位名、不印值",
    [
      logged.some((l) => l.includes("王小明") || l.includes("0922-333 444")),
      logged.some((l) => l.includes("redacted_keys")),
    ],
    [false, true],
  );
  check(
    "update_registration_participant 回應說明不動訂單付款名額",
    [r.written, typeof r.untouched === "string" && r.untouched.includes("付款")],
    [true, true],
  );
  check(
    "update_registration_participant 不碰 orders／event_sessions／event_session_plans",
    dataWrites().filter((w) => w.table !== "event_registrations").length,
    0,
  );
}
{
  resetDb(BASE_TABLES, BASE_RPC);
  const pv = parseOut(
    await asStatic(() =>
      H.update_registration_participant({
        order_no: "P900",
        current_name: "林大同",
        email: "lin@example.com",
      }),
    ),
  );
  check(
    "update_registration_participant 用 order_no＋current_name 定位、預覽給 idempotency_key",
    [
      pv.dry_run,
      pv.target?.registration_id,
      typeof pv.idempotency_key,
      pv.expected,
      dataWrites().length,
    ],
    [true, REG2, "string", { name: "林大同", email: null, phone: null }, 0],
  );
}
{
  resetDb(BASE_TABLES, BASE_RPC);
  const same = parseOut(
    await asOAuth(() =>
      H.update_registration_participant({
        registration_id: REG2,
        name: "林大同",
        expected: { name: "林大同", email: null, phone: null },
        dry_run: false,
      }),
    ),
  );
  check(
    "update_registration_participant 沒有變更 → 不寫、不佔 idempotency_key",
    [same.written, log.writes.length],
    [false, 0],
  );
}

// 讀取工具
console.log("\n讀取工具");
resetDb(BASE_TABLES, BASE_RPC);
const ss = parseOut(await H.get_site_settings({}));
check(
  "get_site_settings 不回匯款帳戶、notify_emails 可讀",
  [
    JSON.stringify(ss).includes("1234567890"),
    Object.keys(ss.settings).some((k) => k.startsWith("bank")),
    ss.settings.notify_emails,
  ],
  [false, false, "owner@example.com"],
);
const ui = parseOut(await H.get_ui_strings({ group_key: "nav" }));
check("get_ui_strings", [ui.count, ui.rows[0].string_key], [1, "home"]);
const ec = parseOut(await H.get_email_copy({}));
check("get_email_copy", ec.rows, [
  { template_key: "paid", string_key: "subject", value: L("付款成功") },
]);
const po = parseOut(await H.list_phone_order_options({}));
check(
  "list_phone_order_options",
  [po.count, po.products[0].sessions[0].session_id, po.products[0].sessions[0].seats_left],
  [1, SESS1, 8],
);
check("讀取工具不寫任何東西", [log.rpc.length, log.writes.length], [0, 0]);

// [5] ------------------------------------------------------------------------
console.log("\n[5] 錯誤輸入 → isError，不寫");
async function expectError(label, fn, actor = asOAuth) {
  resetDb(BASE_TABLES, BASE_RPC);
  globalThis.__phoneCalls = [];
  const r = await actor(fn);
  check(
    label,
    [r.isError === true, log.rpc.length, dataWrites().length, globalThis.__phoneCalls.length],
    [true, 0, 0, 0],
  );
  return r;
}
await expectError("update_order_fulfillment 沒給訂單", () =>
  H.update_order_fulfillment({ action: "ship" }),
);
await expectError("update_order_fulfillment order_id 不是 UUID", () =>
  H.update_order_fulfillment({ order_id: "x", action: "ship" }),
);
await expectError("update_order_fulfillment 找不到訂單", () =>
  H.update_order_fulfillment({ order_id: U(9), action: "ship", dry_run: false }),
);
await expectError("update_order_fulfillment 未付款不能出貨", () =>
  H.update_order_fulfillment({ order_id: ORDER_TRANSFER, action: "ship", dry_run: false }),
);
await expectError("mark_order_paid 線上金流的單不能手動標記", () =>
  H.mark_order_paid({ order_id: ORDER_CARD, dry_run: false }),
);
// ── idempotency_key（審查 2026-11-03）：dry_run=false 必填、同一組只建一次 ─────────
for (const n of [
  "create_stock_adjustment",
  "record_stock_count",
  "create_purchase",
  "create_inventory_product",
  "create_pos_sale",
  "create_secondhand_sale",
]) {
  const { idempotency_key: _k, ...noKey } = CASES[n].args;
  await expectError(`${n}：dry_run=false 沒帶 idempotency_key → 拒絕`, () =>
    asOAuth(() => H[n]({ ...noKey, dry_run: false })),
  );
  await expectError(`${n}：同一組 idempotency_key 第二次送出 → 拒絕（不呼叫 RPC）`, () => {
    // 模擬第一次已送出：一次性表裡已有這組 key。
    tables.mcp_oauth_used_codes = [{ jti: `idem:${n}:${CASES[n].args.idempotency_key}` }];
    return asOAuth(() => H[n]({ ...CASES[n].args, dry_run: false }));
  });
}
{
  const { idempotency_key: _k, ...noKey } = CASES.create_phone_order.args;
  await expectError("create_phone_order：dry_run=false 沒帶 idempotency_key → 拒絕", () =>
    asOAuth(() => H.create_phone_order({ ...noKey, dry_run: false })),
  );
}
await expectError("create_stock_adjustment 數量 0", () =>
  H.create_stock_adjustment({ product_id: PROD1, category: "EXP", quantity: 0, dry_run: false }),
);
await expectError("create_stock_adjustment 不明類別", () =>
  H.create_stock_adjustment({ product_id: PROD1, category: "XXX", quantity: -1, dry_run: false }),
);
await expectError("record_stock_count 重複商品", () =>
  H.record_stock_count({
    rows: [
      { product_id: PROD1, actual_quantity: 1 },
      { product_id: PROD1, actual_quantity: 2 },
    ],
    reason: "loss",
    dry_run: false,
  }),
);
await expectError("create_purchase 數量 0", () =>
  H.create_purchase({ product_id: PROD1, quantity: 0, dry_run: false }),
);
await expectError("update_journey_wish 沒給要改的欄位", () => H.update_journey_wish({ id: WISH1 }));
await expectError("update_journey_wish 不明狀態", () =>
  H.update_journey_wish({ id: WISH1, status: "done", dry_run: false }),
);
await expectError("update_ui_string 不存在的 key（不會新增）", () =>
  H.update_ui_string({ group_key: "nav", string_key: "nope", value: "x", dry_run: false }),
);
await expectError("update_site_settings 不收 notify_emails（被當成沒給欄位）", () =>
  H.update_site_settings({ notify_emails: "evil@example.com", dry_run: false }),
);
await expectError("update_site_settings contact_email 格式錯（後台同一套驗證）", () =>
  H.update_site_settings({ contact_email: "not-an-email", dry_run: false }),
);
await expectError("create_phone_order paid 沒給匯款日", () =>
  H.create_phone_order({ ...CASES.create_phone_order.args, paid_on: undefined, dry_run: false }),
);
await expectError("create_phone_order 參加者多於座位", () =>
  H.create_phone_order({
    ...CASES.create_phone_order.args,
    quantity: 1,
    participants: [{ name: "a" }, { name: "b" }],
    dry_run: false,
  }),
);
await expectError("create_phone_order 沒有手機也沒有 Email", () =>
  H.create_phone_order({
    ...CASES.create_phone_order.args,
    customer_phone: undefined,
    dry_run: false,
  }),
);
await expectError("create_phone_order 改價高於原價", () =>
  H.create_phone_order({
    ...CASES.create_phone_order.args,
    price_override: { amount: 9999, reason: "x" },
    dry_run: false,
  }),
);
await expectError("update_phone_order_contacts 不是電話報名的單", () =>
  H.update_phone_order_contacts({
    order_id: ORDER_TRANSFER,
    customer: { name: "x" },
    dry_run: false,
  }),
);
await expectError("update_phone_order_contacts 參加者不在這張單", () =>
  H.update_phone_order_contacts({
    order_id: ORDER_PHONE,
    participants: [{ id: REG1, name: "x" }],
    dry_run: false,
  }),
);
await expectError("update_registration_participant dry_run=false 沒帶 idempotency_key", () =>
  H.update_registration_participant({ registration_id: REG1, phone: "0911", dry_run: false }),
);
await expectError("update_registration_participant 同一組 idempotency_key 第二次送出", () => {
  tables.mcp_oauth_used_codes = [
    {
      jti: `idem:update_registration_participant:${CASES.update_registration_participant.args.idempotency_key}`,
    },
  ];
  return H.update_registration_participant({
    ...CASES.update_registration_participant.args,
    dry_run: false,
  });
});
await expectError("update_registration_participant 電話含英文字母", () =>
  H.update_registration_participant({
    registration_id: REG1,
    phone: "09abc",
    expected: { name: "王小明", email: null, phone: null },
    idempotency_key: U(1),
    dry_run: false,
  }),
);
await expectError("update_registration_participant Email 格式錯", () =>
  H.update_registration_participant({
    registration_id: REG1,
    email: "not-an-email",
    expected: { name: "王小明", email: null, phone: null },
    idempotency_key: U(1),
    dry_run: false,
  }),
);
await expectError("update_registration_participant 姓名清成空白", () =>
  H.update_registration_participant({
    registration_id: REG1,
    name: " \u0000 ",
    expected: { name: "王小明", email: null, phone: null },
    idempotency_key: U(1),
    dry_run: false,
  }),
);
await expectError("update_registration_participant 前台訂單把 Email 與電話都清空", () => {
  tables.event_registrations[0].email = "a@example.com";
  return H.update_registration_participant({
    registration_id: REG1,
    email: "",
    expected: { name: "王小明", email: "a@example.com", phone: null },
    idempotency_key: U(1),
    dry_run: false,
  });
});
await expectError("update_registration_participant 場次對不上", () =>
  H.update_registration_participant({
    registration_id: REG1,
    session_id: U(9),
    phone: "0911",
    expected: { name: "王小明", email: null, phone: null },
    idempotency_key: U(1),
    dry_run: false,
  }),
);
await expectError("update_registration_participant 找不到", () =>
  H.update_registration_participant({
    registration_id: U(9),
    phone: "0911",
    expected: { name: "王小明", email: null, phone: null },
    idempotency_key: U(1),
    dry_run: false,
  }),
);
{
  const r = await expectError("update_registration_participant dry_run=false 沒帶 expected", () =>
    H.update_registration_participant({
      registration_id: REG1,
      phone: "0911",
      idempotency_key: U(1),
      dry_run: false,
    }),
  );
  check(
    "沒帶 expected 的訊息講明要帶預覽的 expected",
    r.content[0].text.includes("expected"),
    true,
  );
}
{
  // 驗收 2026-11-05：預覽之後別人改了 → 送出時拒絕（stale），不把別人改的值蓋回去。
  const r = await expectError(
    "update_registration_participant 預覽後別人改過（expected 對不上）→ 拒絕",
    () => {
      tables.event_registrations[0].email = "someone@example.com";
      return H.update_registration_participant({
        registration_id: REG1,
        name: "王大明",
        expected: { name: "王小明", email: null, phone: null },
        idempotency_key: U(1),
        dry_run: false,
      });
    },
  );
  check("stale 訊息請重新整理／重新預覽", r.content[0].text.includes("剛被別人改過"), true);
}
{
  const r = await expectError("update_registration_participant 用姓名定位找不到", () =>
    H.update_registration_participant({
      order_no: "B001",
      current_name: "不存在的人",
      phone: "0911",
    }),
  );
  check(
    "定位失敗的錯誤訊息不含姓名（會進稽核與 log）",
    r.content[0].text.includes("不存在的人"),
    false,
  );
}
{
  const r = await expectError("update_registration_participant 同名多位", () => {
    tables.event_registrations.push({ ...tables.event_registrations[0], id: U(3), seat_no: 2 });
    return H.update_registration_participant({
      order_no: "B001",
      current_name: "王小明",
      phone: "0911",
    });
  });
  check(
    "同名多位：訊息列 registration_id、不含姓名",
    [r.content[0].text.includes(U(3)), r.content[0].text.includes("王小明")],
    [true, false],
  );
}
await expectError("update_registration_participant 同時給兩種定位", () =>
  H.update_registration_participant({
    registration_id: REG1,
    order_no: "B001",
    current_name: "王小明",
    phone: "0911",
  }),
);
await expectError(
  "update_registration_participant 不收 order_id／payment_status（被當成沒給欄位）",
  () =>
    H.update_registration_participant({
      registration_id: REG1,
      order_id: ORDER_SHIP,
      payment_status: "pending",
      dry_run: false,
    }),
);
await expectError("remove_registration 找不到", () =>
  H.remove_registration({ session_id: SESS1, registration_id: U(9), dry_run: false }),
);

console.log("\n[5b] 靜態 token：RPC 必須記錄操作人員的 → 拒絕；接受 null 的 → 傳 null");
for (const n of [
  "create_phone_order",
  "update_phone_order_contacts",
  "create_stock_adjustment",
  "record_stock_count",
  "create_purchase",
  "create_inventory_product",
  "approve_inventory_record",
  "create_pos_sale",
  "create_secondhand_sale",
]) {
  const r = await expectError(
    `${n} 靜態 token 拒絕`,
    () => H[n]({ ...CASES[n].args, dry_run: false }),
    asStatic,
  );
  check(`${n} 錯誤訊息講明需要 OAuth`, r.content[0].text.includes("OAuth"), true);
}
resetDb(BASE_TABLES, BASE_RPC);
await asStatic(() => H.mark_order_paid({ order_no: "B001", dry_run: false }));
check(
  "mark_order_paid 靜態 token → p_actor_id null、稽核 actor_via=static_token",
  [log.rpc[0]?.args?.p_actor_id, audits()[0]?.actor_via],
  [null, "static_token"],
);
resetDb(BASE_TABLES, BASE_RPC);
await asStatic(() =>
  H.remove_registration({ session_id: SESS1, registration_id: REG1, dry_run: false }),
);
check("remove_registration 靜態 token → p_actor_id null", log.rpc[0]?.args?.p_actor_id, null);

// 冪等的 no-op
resetDb(BASE_TABLES, BASE_RPC);
tables.orders[1].payment_status = "paid";
const again = parseOut(
  await asOAuth(() => H.mark_order_paid({ order_no: "B001", dry_run: false })),
);
check(
  "mark_order_paid 已收款 → 不呼叫 RPC、written=false",
  [log.rpc.length, again.written],
  [0, false],
);
resetDb(BASE_TABLES, BASE_RPC);
const same = parseOut(
  await asOAuth(() => H.update_journey_wish({ id: WISH1, status: "new", dry_run: false })),
);
check("update_journey_wish 沒有變更 → 不寫", [dataWrites().length, same.written], [0, false]);

// [5c] 進銷存新增／審核／門市結帳（2026-11-15）-------------------------------
console.log("\n[5c] 新增商品／審核／門市結帳／二手書");
{
  resetDb(BASE_TABLES, BASE_RPC);
  const out = parseOut(
    await asOAuth(() => H.create_inventory_product(CASES.create_inventory_product.args)),
  );
  check(
    "create_inventory_product 預覽：商品與進貨都預告待審、分類名稱帶出",
    [
      out.will_create?.product?.approval?.startsWith("pending"),
      out.will_create?.purchase?.approval?.startsWith("pending"),
      out.will_create?.product?.category_name,
      out.will_create?.product?.stock_quantity,
    ],
    [true, true, "二手書", 0],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const dup = parseOut(
    await asOAuth(() =>
      H.create_inventory_product({
        name: "小誌 12 期",
        selling_price: 150,
        barcode: "9789860000001",
      }),
    ),
  );
  check("create_inventory_product 預覽：同條碼 → 警告", (dup.warnings ?? []).length, 1);
  resetDb(BASE_TABLES, BASE_RPC);
  const done = parseOut(
    await asOAuth(() =>
      H.create_inventory_product({ ...CASES.create_inventory_product.args, dry_run: false }),
    ),
  );
  check(
    "create_inventory_product 寫入後回報待審的商品與進貨 id（給 approve_inventory_record）",
    done.needs_approval,
    [
      { module: "products", id: PROD_PENDING },
      { module: "purchases", id: PUR_PENDING },
    ],
  );
  await expectError("create_inventory_product 不存在的分類", () =>
    H.create_inventory_product({ name: "x", selling_price: 1, category_id: U(9), dry_run: false }),
  );
  await expectError("create_inventory_product 售價負數", () =>
    H.create_inventory_product({ name: "x", selling_price: -1, dry_run: false }),
  );

  resetDb(BASE_TABLES, BASE_RPC);
  const pend = parseOut(await asOAuth(() => H.list_pending_approvals({})));
  check(
    "list_pending_approvals：三類各列出待審那一筆、不寫",
    [
      pend.products?.rows?.map((r) => r.id),
      pend.purchases?.rows?.map((r) => r.id),
      pend.stock_adjustments?.rows?.map((r) => r.id),
      pend.approval_settings?.stock_adjustments,
      log.rpc.length,
      log.writes.length,
    ],
    [[PROD_PENDING], [PUR_PENDING], [ADJ_PENDING], "需要審核", 0, 0],
  );

  resetDb(BASE_TABLES, BASE_RPC);
  const ap = parseOut(
    await asOAuth(() =>
      H.approve_inventory_record({ module: "purchases", id: PUR_PENDING, decision: "approve" }),
    ),
  );
  check(
    "approve_inventory_record 預覽：pending → approved、庫存 0 → 1",
    [ap.changes?.status, ap.target?.stock_now, ap.target?.stock_after_if_approved],
    [{ before: "pending", after: "approved" }, 0, 1],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const adj = parseOut(
    await asOAuth(() =>
      H.approve_inventory_record({
        module: "stock_adjustments",
        id: ADJ_PENDING,
        decision: "approve",
        dry_run: false,
      }),
    ),
  );
  check(
    "approve_inventory_record 在庫異動：pending_approval → confirmed，走 inv_approve_record",
    [adj.written, log.rpc[0]?.args?.p_module, log.rpc[0]?.args?.p_approved],
    [true, "stock_adjustments", true],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const noop = parseOut(
    await asOAuth(() =>
      H.approve_inventory_record({
        module: "purchases",
        id: PUR_DONE,
        decision: "approve",
        dry_run: false,
      }),
    ),
  );
  check(
    "approve_inventory_record 已核准的 → 不呼叫 RPC、written=false",
    [log.rpc.length, noop.written],
    [0, false],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  await asOAuth(() =>
    H.approve_inventory_record({
      module: "products",
      id: PROD_PENDING,
      decision: "reject",
      dry_run: false,
    }),
  );
  check("approve_inventory_record 退回 → p_approved=false", log.rpc[0]?.args?.p_approved, false);
  await expectError("approve_inventory_record 不開放的模組（vendors）", () =>
    H.approve_inventory_record({
      module: "vendors",
      id: PUR_PENDING,
      decision: "approve",
      dry_run: false,
    }),
  );
  await expectError("approve_inventory_record 找不到", () =>
    H.approve_inventory_record({
      module: "purchases",
      id: U(9),
      decision: "approve",
      dry_run: false,
    }),
  );

  // 超過可售量：預覽警告；不帶 override 照樣交給資料庫判斷（與後台同一個守門）。
  resetDb(BASE_TABLES, BASE_RPC);
  const over = parseOut(
    await asOAuth(() => H.create_pos_sale({ items: [{ product_id: PROD1, quantity: 9 }] })),
  );
  check(
    "create_pos_sale 預覽：超過可售量 → 警告會被拒、預設付款方式＝現金、單價＝售價",
    [
      typeof over.warning === "string" && over.warning.includes("拒絕"),
      over.will_create?.payment_method,
      over.will_create?.lines?.[0]?.unit_price,
      over.will_create?.lines?.[0]?.over_available,
    ],
    [true, "現金", 150, 1],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  await asOAuth(() =>
    H.create_pos_sale({
      items: [{ product_id: PROD1, quantity: 9 }],
      override_reservation: true,
      idempotency_key: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaab9",
      dry_run: false,
    }),
  );
  check(
    "create_pos_sale override_reservation=true 原樣傳給 pos_checkout",
    log.rpc[0]?.args?.p_override_reservation,
    true,
  );
  const unapproved = await expectError("create_pos_sale 待審商品 → 拒絕並說明要先核准", () =>
    H.create_pos_sale({ items: [{ product_id: PROD_PENDING, quantity: 1 }], dry_run: false }),
  );
  check(
    "create_pos_sale 待審商品的錯誤訊息指向 approve_inventory_record",
    unapproved.content[0].text.includes("approve_inventory_record"),
    true,
  );
  await expectError("create_pos_sale 同一件商品兩行", () =>
    H.create_pos_sale({
      items: [
        { product_id: PROD1, quantity: 1 },
        { product_id: PROD1, quantity: 1 },
      ],
    }),
  );
  await expectError("create_pos_sale 不存在的付款方式", () =>
    H.create_pos_sale({ items: [{ product_id: PROD1, quantity: 1 }], payment_method: "比特幣" }),
  );
  await expectError("create_pos_sale 備註超過 500 字", () =>
    H.create_pos_sale({ items: [{ product_id: PROD1, quantity: 1 }], notes: "字".repeat(501) }),
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const sh = parseOut(
    await asOAuth(() =>
      H.create_secondhand_sale({ item_name: "海邊的卡夫卡", unit_price: 200, quantity: 2 }),
    ),
  );
  check(
    "create_secondhand_sale 預覽：金額＝數量×售價、不動庫存",
    [sh.will_create?.amount, sh.will_create?.is_secondhand, typeof sh.will_create?.stock_change],
    [400, true, "string"],
  );
  await expectError("create_secondhand_sale 沒有書名", () =>
    H.create_secondhand_sale({ item_name: " ", unit_price: 1, dry_run: false }),
  );
  check(
    "create_secondhand_sale 輸入沒有 product_id（二手書不建商品）",
    "product_id" in (z.toJSONSchema(INPUTS.create_secondhand_sale).properties ?? {}),
    false,
  );
}

// [6] ------------------------------------------------------------------------
console.log("\n[6] 靜態");
const srcText = readFile(join(SRC, "server/mcp/ops-write-tools.ts"));
const code = srcText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
check(
  "自己不寫 .update(/.insert(/.delete(/.upsert(/.rpc(",
  /\.(update|insert|delete|upsert|rpc)\(/.test(code),
  false,
);
check("不 import 寄信模組（@/server/notify）", /@\/server\/notify/.test(code), false);
check("不用 payments.ts 的 markOrderPaid", /repos\/payments|\bmarkOrderPaid\b/.test(code), false);
check("不碰 bank_ 欄位名", /bank_/.test(code), false);

console.info = origInfo;
console.log(
  fail === 0
    ? green(`\n✓ 全部通過：${pass} passed, 0 failed`)
    : red(`\n✗ 有失敗：${pass} passed, ${fail} failed`),
);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
