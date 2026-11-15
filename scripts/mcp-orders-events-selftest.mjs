#!/usr/bin/env node
/**
 * mcp-orders-events-selftest.mjs —— MCP 訂單與活動工具（src/server/mcp/orders-events-tools.ts）
 *
 *   [1] 形狀：三份匯出對得起來、annotations、寫入 dry_run 預設 true、寄信預設 false、沒有刪除工具
 *   [2] 每支寫入：靜態 token 拒絕（不寫、不寄）
 *   [3] 每支寫入：預覽不寫業務資料、不寄信、記一筆 dry_run=true 的稽核
 *   [4] 每支寫入：dry_run=false 才呼叫正確的 repo／RPC 與參數，並記 dry_run=false 的稽核
 *   [5] 寄信：notify_customer=false 不呼叫寄信；true 才呼叫（假的 notify 模組，不會真寄）
 *   [6] 業務規則：非現場付款、未付款封存、名額低於已報名、排序清單不完整、idempotency_key
 *   [7] 靜態：這個檔案自己不寫 update／insert／delete／rpc、不 import @/server/translate
 *
 * 用假的 supabaseAdmin（記錄 rpc 與寫入、照 eq／in 篩選）跑 production 的 handler 與 repo 本人。
 * @/server/notify 與 @/server/google-calendar 換成記錄呼叫的假模組——絕不寄信、不碰 Google。
 *
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15（module.registerHooks）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/mcp-orders-events-selftest.mjs";
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
const readFile = (p) => {
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};

// ── 假的 Supabase ───────────────────────────────────────────────────────────
const log = { rpc: [], writes: [] };
let tables = {};
let rpcData = {};
let nextBlockId = 100;
function resetDb(t, r = {}) {
  tables = structuredClone(t);
  rpcData = structuredClone(r);
  log.rpc = [];
  log.writes = [];
  notifyCalls.length = 0;
  gcalCalls.length = 0;
}
function builder(table) {
  const st = { op: "select", payload: null, filters: [], single: null, orders: [] };
  const pass_ = () => b;
  const b = {
    select: pass_,
    order: (c, o) => (st.orders.push([c, o?.ascending !== false]), b),
    gt: pass_,
    gte: pass_,
    lt: pass_,
    lte: pass_,
    limit: pass_,
    range: (from) => (from > 0 ? ((st.empty = true), b) : b),
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
        if (st.op !== "select") log.writes.push({ table, op: st.op, payload: st.payload });
        if (st.op === "insert") {
          const rows = (tables[table] ??= []);
          if (table === "mcp_oauth_used_codes" && rows.some((r) => r.jti === st.payload.jti)) {
            resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
            return;
          }
          const row = { ...st.payload };
          if (row.id === undefined) {
            row.id =
              table === "event_blocks"
                ? nextBlockId++
                : `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`;
          }
          rows.push(row);
          resolve({ data: st.single ? row : [row], error: null });
          return;
        }
        if (st.empty) {
          resolve({ data: [], error: null });
          return;
        }
        const rows = (tables[table] ?? []).filter((r) => st.filters.every((f) => f(r)));
        if (st.op === "select" && st.orders.length) {
          rows.sort((x, y) => {
            for (const [c, asc] of st.orders) {
              if (x[c] === y[c]) continue;
              return (x[c] < y[c] ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
        }
        if (st.op === "update") for (const r of rows) Object.assign(r, st.payload);
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

// 假的寄信與 Google 日曆模組：只記錄呼叫。
const notifyCalls = [];
const gcalCalls = [];
globalThis.__notifyCalls = notifyCalls;
globalThis.__gcalCalls = gcalCalls;
globalThis.__gcalStatus = null;
const FAKE_NOTIFY =
  "data:text/javascript," +
  encodeURIComponent(`
    export async function triggerNotifyAfterPayment(id) { globalThis.__notifyCalls.push(["payment", id]); return { ok: true, queued: 1 }; }
    export async function triggerNotifyAfterShipped(id) { globalThis.__notifyCalls.push(["shipped", id]); return { status: "queued" }; }
  `);
const FAKE_GCAL =
  "data:text/javascript," +
  encodeURIComponent(`
    export async function getGoogleCalendarStatus() { return globalThis.__gcalStatus; }
    export async function runGoogleCalendarSync(t) { globalThis.__gcalCalls.push(["run", t]); return { status: "done", passes: 1, ok: true, summary: null, error: null }; }
    export async function nudgeGoogleCalendarSync() { globalThis.__gcalCalls.push(["nudge"]); }
  `);

// 假的翻譯（🔴 不打真的 Gemini）：只記錄呼叫次數。
globalThis.__translateCalls = [];
const FAKE_TRANSLATE =
  "data:text/javascript," +
  encodeURIComponent(`
    export async function translateToEnJa({ text }) {
      globalThis.__translateCalls.push(text);
      // __translateLong：模擬英日文比中文長（約 1.5 倍），驗 en/ja 上限不會擋回送的 confirm_args。
      if (globalThis.__translateLong) {
        const n = Math.ceil(text.length * 1.5);
        return { en: "E".repeat(n), ja: "ジ".repeat(n) };
      }
      return { en: "EN" + globalThis.__translateCalls.length + " " + text, ja: "JA " + text };
    }
  `);
process.env.GEMINI_API_KEY = "selftest-fake-key";

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
    if (spec === "@/server/notify") return { url: FAKE_NOTIFY, shortCircuit: true };
    if (spec === "@/server/google-calendar") return { url: FAKE_GCAL, shortCircuit: true };
    if (spec === "@/server/translate" || spec === "./translate")
      return { url: FAKE_TRANSLATE, shortCircuit: true };
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

const MOD = await import(join(SRC, "server/mcp/orders-events-tools.ts"));
const {
  ORDERS_EVENTS_TOOL_INPUTS: INPUTS,
  ORDERS_EVENTS_TOOL_META: META,
  ORDERS_EVENTS_HANDLERS: H,
  taipeiToIso,
} = MOD;
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
const bizRpc = () => log.rpc.filter((r) => r.name !== "request_google_calendar_sync");

console.log("═══ MCP 訂單與活動工具自檢 ═══");

// [1] ------------------------------------------------------------------------
console.log("\n[1] 形狀");
const names = Object.keys(INPUTS).sort();
check(
  "INPUTS／META／HANDLERS 名單一致",
  [Object.keys(META).sort(), Object.keys(H).sort()],
  [names, names],
);
check("工具清單", names, [
  "archive_order",
  "collect_onsite_payment",
  "create_event_block",
  "create_event_session",
  "create_ticket_type",
  "list_event_blocks",
  "list_event_sessions",
  "reorder_event_blocks",
  "ship_order",
  "sync_google_calendar",
  "update_event_block",
  "update_event_session",
  "update_ticket_type",
]);
const READS = names.filter((n) => META[n].annotations.readOnlyHint === true);
const WRITES = names.filter((n) => META[n].annotations.readOnlyHint !== true);
check("讀取工具＝list_ 開頭", READS, ["list_event_blocks", "list_event_sessions"]);
check(
  "沒有任何刪除工具",
  names.filter((n) => /delete|remove/.test(n)),
  [],
);
check(
  "沒有任何工具標 destructiveHint",
  names.filter((n) => META[n].annotations.destructiveHint),
  [],
);
check(
  "每支寫入 dry_run 預設 true",
  WRITES.filter(
    (n) => z.toJSONSchema(INPUTS[n], { io: "input" }).properties?.dry_run?.default !== true,
  ),
  [],
);
check(
  "會寄信的兩支 notify_customer 預設 false",
  ["collect_onsite_payment", "ship_order"].map(
    (n) => z.toJSONSchema(INPUTS[n], { io: "input" }).properties?.notify_customer?.default,
  ),
  [false, false],
);
check(
  "建立類都有 idempotency_key",
  ["create_event_session", "create_ticket_type", "create_event_block"].map(
    (n) => "idempotency_key" in z.toJSONSchema(INPUTS[n]).properties,
  ),
  [true, true, true],
);
check(
  "場次／票種輸入沒有 seats_taken／units_taken（計數器只由 RPC 維護）",
  names.filter((n) => {
    const p = z.toJSONSchema(INPUTS[n], { io: "input" }).properties ?? {};
    return "seats_taken" in p || "units_taken" in p;
  }),
  [],
);
const existing = new Set();
for (const f of [
  "tools.ts",
  "admin-read-tools.ts",
  "create-tools.ts",
  "image-upload.ts",
  "ops-write-tools.ts",
  "outbound-tools.ts",
  "report-tools.ts",
  "pos-stock-tools.ts",
]) {
  for (const m of readFile(join(SRC, "server/mcp", f)).matchAll(/^ {2}([a-z_]+): z/gm))
    existing.add(m[1]);
}
check(
  "不與既有 MCP 工具撞名",
  names.filter((n) => existing.has(n)),
  [],
);
check(
  "時間轉換：台北 19:30 → UTC 11:30；帶 Z 原樣",
  [taipeiToIso("t", "2026-12-05 19:30"), taipeiToIso("t", "2026-12-05T11:30:00Z")],
  ["2026-12-05T11:30:00.000Z", "2026-12-05T11:30:00.000Z"],
);

// 資料 --------------------------------------------------------------------------
const U = (n) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const ORDER_ONSITE = U(1);
const ORDER_TRANSFER = U(2);
const ORDER_SHIP = U(3);
const ORDER_PAID_PICKUP = U(4);
const SESS1 = U(5);
const PLAN1 = U(6);
const PROD_EVT = "evt-prod-1";
const EVENT1 = "evt-1";
const L = (zh) => ({ zh, en: `${zh}-en`, ja: `${zh}-ja` });

const order = (id, no, extra) => ({
  id,
  order_no: no,
  status: "pending",
  payment_status: "unpaid",
  payment_method: "transfer",
  paid_at: null,
  shipping_method: "none",
  shipped_at: null,
  completed_at: null,
  archived_at: null,
  total: 800,
  ...extra,
});
const BASE = {
  orders: [
    order(ORDER_ONSITE, "S001", { payment_method: "onsite" }),
    order(ORDER_TRANSFER, "T001"),
    order(ORDER_SHIP, "H001", {
      status: "processing",
      payment_status: "paid",
      payment_method: "card",
      paid_at: "2026-11-01T00:00:00Z",
      shipping_method: "home",
    }),
    order(ORDER_PAID_PICKUP, "P001", {
      status: "completed",
      payment_status: "paid",
      payment_method: "card",
      paid_at: "2026-11-01T00:00:00Z",
      shipping_method: "pickup",
    }),
  ],
  products: [
    { id: PROD_EVT, slug: "salon", title: L("城市沙龍"), product_type: "event", status: "active" },
  ],
  event_sessions: [
    {
      id: SESS1,
      product_id: PROD_EVT,
      title: L("第一場"),
      location: L("小時光"),
      starts_at: "2099-12-05T11:30:00+00:00",
      ends_at: "2099-12-05T13:30:00+00:00",
      capacity: 20,
      seats_taken: 5,
      status: "open",
      sort_order: 3,
    },
  ],
  event_session_plans: [
    {
      id: PLAN1,
      session_id: SESS1,
      title: L("單人票"),
      price: 500,
      seats_per_unit: 1,
      capacity: 20,
      units_taken: 4,
      sale_starts_at: null,
      sale_ends_at: null,
      status: "open",
      sort_order: 1,
    },
  ],
  events: [{ id: EVENT1, title: L("城市沙龍") }],
  event_blocks: [
    { id: 11, event_id: EVENT1, kind: "faq", title: L("Q1"), body: L("A1"), sort_order: 1 },
    { id: 12, event_id: EVENT1, kind: "faq", title: L("Q2"), body: L("A2"), sort_order: 2 },
    { id: 13, event_id: EVENT1, kind: "agenda", title: L("19:30"), body: L("入場"), sort_order: 1 },
  ],
};
const RPC = {
  admin_mark_order_paid: [{ marked: true, reason: "marked", order_no: "S001" }],
  admin_archive_order: [{ updated: true, reason: "archived", order_no: "H001" }],
};
const GCAL_OK = {
  configured: true,
  connected: true,
  calendarId: "cal@group",
  calendarSummary: "小時光活動",
  running: false,
  needsReconnect: false,
  lastSync: {
    startedAt: null,
    finishedAt: null,
    ok: null,
    trigger: null,
    summary: null,
    error: null,
  },
};

// 每支寫入的最小正確輸入（dry_run 省略＝預覽）。
const SAMPLE = {
  collect_onsite_payment: { order_no: "S001", note: "現場收現金" },
  ship_order: { order_id: ORDER_SHIP },
  archive_order: { order_id: ORDER_SHIP },
  create_event_session: {
    product_id: PROD_EVT,
    title: L("第二場"),
    location: L("小時光"),
    starts_at: "2099-12-12 19:30",
    ends_at: "2099-12-12 21:30",
    capacity: 15,
  },
  update_event_session: { session_id: SESS1, capacity: 30, status: "closed" },
  create_ticket_type: {
    session_id: SESS1,
    title: L("雙人票"),
    price: 900,
    seats_per_unit: 2,
    capacity: 5,
  },
  update_ticket_type: { ticket_type_id: PLAN1, price: 450 },
  create_event_block: { event_id: EVENT1, kind: "faq", title: L("Q3"), body: L("A3") },
  update_event_block: { event_id: EVENT1, block_id: 12, body: L("A2 改") },
  reorder_event_blocks: { event_id: EVENT1, kind: "faq", block_ids: [12, 11] },
  sync_google_calendar: {},
};
check("每支寫入都有樣本", Object.keys(SAMPLE).sort(), [...WRITES].sort());

// [2] ------------------------------------------------------------------------
console.log("\n[2] 靜態 token 一律拒絕");
for (const n of WRITES) {
  resetDb(BASE, RPC);
  globalThis.__gcalStatus = GCAL_OK;
  const r = await asStatic(() => H[n]({ ...SAMPLE[n], dry_run: false, idempotency_key: U(9) }));
  check(
    `${n}：靜態 token → isError、提到 OAuth、不寫、不寄、不同步`,
    [
      r.isError === true,
      /OAuth/.test(r.content[0].text),
      dataWrites().length,
      bizRpc().length,
      notifyCalls.length,
      gcalCalls.length,
    ],
    [true, true, 0, 0, 0, 0],
  );
}

// [3] ------------------------------------------------------------------------
console.log("\n[3] 預覽不寫");
const previews = {};
for (const n of WRITES) {
  resetDb(BASE, RPC);
  globalThis.__gcalStatus = GCAL_OK;
  const r = await asOAuth(() => H[n](SAMPLE[n]));
  const out = parseOut(r);
  previews[n] = out;
  const a = audits();
  check(
    `${n}：預覽 → 不寫業務資料、不呼叫 RPC、不寄、不同步、記一筆 dry_run=true 稽核`,
    [
      r.isError ?? false,
      out.dry_run,
      out.written,
      dataWrites().length,
      bizRpc().length,
      notifyCalls.length,
      gcalCalls.length,
      a.length,
      a[0]?.dry_run,
      a[0]?.tool,
    ],
    [false, true, false, 0, 0, 0, 0, 1, true, n],
  );
}
check(
  "create_* 預覽都回一組 idempotency_key",
  ["create_event_session", "create_ticket_type", "create_event_block"].map((n) =>
    /^[0-9a-f-]{36}$/.test(previews[n].idempotency_key ?? ""),
  ),
  [true, true, true],
);
check(
  "create_event_session 預覽：預設 closed、排序接在最後、時間轉成 UTC",
  [
    previews.create_event_session.will_create?.status,
    previews.create_event_session.will_create?.sort_order,
    previews.create_event_session.will_create?.starts_at,
  ],
  ["closed", 4, "2099-12-12T11:30:00.000Z"],
);
check(
  "update_event_session 預覽：只列有變的欄位",
  Object.keys(previews.update_event_session.changes ?? {}).sort(),
  ["capacity", "status"],
);
check("update_ticket_type 預覽：票價 500 → 450", previews.update_ticket_type.changes?.price, {
  before: 500,
  after: 450,
});
check(
  "reorder 預覽：前後順序",
  [
    previews.reorder_event_blocks.order?.before.map((x) => x.block_id),
    previews.reorder_event_blocks.order?.after.map((x) => x.block_id),
  ],
  [
    [11, 12],
    [12, 11],
  ],
);
check("ship_order 預覽：預設說不寄信", /不寄/.test(previews.ship_order.email ?? ""), true);

// [4][5] ---------------------------------------------------------------------
console.log("\n[4] 正式寫入走後台同一支");
const commit = async (n, extra = {}) =>
  parseOut(await asOAuth(() => H[n]({ ...SAMPLE[n], dry_run: false, ...extra })));
const lastAudit = () => audits().at(-1);

resetDb(BASE, RPC);
let out = await commit("collect_onsite_payment");
check(
  "collect_onsite_payment：admin_mark_order_paid（actor＝OAuth admin、note），預設不寄",
  [
    log.rpc.map((r) => r.name),
    log.rpc[0]?.args,
    out.written,
    notifyCalls.length,
    lastAudit()?.dry_run,
  ],
  [
    ["admin_mark_order_paid"],
    { p_order_id: ORDER_ONSITE, p_actor_id: ADMIN_ID, p_note: "現場收現金" },
    true,
    0,
    false,
  ],
);
resetDb(BASE, RPC);
await commit("collect_onsite_payment", { notify_customer: true });
check("collect_onsite_payment notify_customer=true → 寄付款成功信（假模組）", notifyCalls, [
  ["payment", ORDER_ONSITE],
]);

resetDb(BASE, RPC);
out = await commit("ship_order");
const shipped = tables.orders.find((o) => o.id === ORDER_SHIP);
check(
  "ship_order：processing→shipped、寫 shipped_at，預設不寄",
  [shipped.status, typeof shipped.shipped_at, out.written, notifyCalls.length],
  ["shipped", "string", true, 0],
);
resetDb(BASE, RPC);
out = await commit("ship_order", { notify_customer: true });
check("ship_order notify_customer=true → 寄出貨通知信一次（假模組）", notifyCalls, [
  ["shipped", ORDER_SHIP],
]);
// 已經出貨過 → 不寫、不寄
out = await commit("ship_order", { notify_customer: true });
check("ship_order 已出貨的單再呼叫 → 不寫、不再寄", [out.written, notifyCalls.length], [false, 1]);

resetDb(BASE, RPC);
out = await commit("archive_order");
check(
  "archive_order：admin_archive_order(p_archived=true, actor)",
  [log.rpc[0]?.name, log.rpc[0]?.args, out.written],
  ["admin_archive_order", { p_order_id: ORDER_SHIP, p_actor_id: ADMIN_ID, p_archived: true }, true],
);

resetDb(BASE, RPC);
const key1 = U(7);
out = await commit("create_event_session", { idempotency_key: key1 });
const newSess = tables.event_sessions.at(-1);
check(
  "create_event_session：insert 一列（不含 seats_taken）＋通知日曆同步",
  [
    dataWrites().map((w) => `${w.table}:${w.op}`),
    "seats_taken" in dataWrites()[0].payload,
    newSess.capacity,
    newSess.status,
    gcalCalls,
    out.session_id === newSess.id,
  ],
  [["event_sessions:insert"], false, 15, "closed", [["nudge"]], true],
);
out = parseOut(
  await asOAuth(() =>
    H.create_event_session({
      ...SAMPLE.create_event_session,
      dry_run: false,
      idempotency_key: key1,
    }),
  ),
);
check(
  "create_event_session 同一組 idempotency_key 再送 → 拒絕，不建第二筆",
  [typeof out === "string" && /idempotency_key/.test(out), tables.event_sessions.length],
  [true, 2],
);
resetDb(BASE, RPC);
const noKey = await asOAuth(() =>
  H.create_event_session({ ...SAMPLE.create_event_session, dry_run: false }),
);
check(
  "create_event_session dry_run=false 沒帶 idempotency_key → 拒絕",
  [noKey.isError, dataWrites().length],
  [true, 0],
);

resetDb(BASE, RPC);
await commit("update_event_session");
const s1 = tables.event_sessions[0];
check(
  "update_event_session：update 那一列（capacity／status），不送 seats_taken",
  [
    dataWrites().length,
    dataWrites()[0]?.op,
    "seats_taken" in (dataWrites()[0]?.payload ?? {}),
    s1.capacity,
    s1.status,
    s1.seats_taken,
    gcalCalls,
  ],
  [1, "update", false, 30, "closed", 5, [["nudge"]]],
);

resetDb(BASE, RPC);
out = await commit("create_ticket_type", { idempotency_key: U(8) });
const np = tables.event_session_plans.at(-1);
check(
  "create_ticket_type：insert 一列（不含 units_taken），排序接在最後",
  [
    dataWrites().map((w) => `${w.table}:${w.op}`),
    "units_taken" in dataWrites()[0].payload,
    np.seats_per_unit,
    np.sort_order,
    np.status,
  ],
  [["event_session_plans:insert"], false, 2, 2, "open"],
);

resetDb(BASE, RPC);
await commit("update_ticket_type");
check(
  "update_ticket_type：只改票價，不送 units_taken",
  [
    tables.event_session_plans[0].price,
    tables.event_session_plans[0].units_taken,
    "units_taken" in dataWrites()[0].payload,
  ],
  [450, 4, false],
);

resetDb(BASE, RPC);
out = await commit("create_event_block", { idempotency_key: U(9) });
check(
  "create_event_block：insert，sort_order 接在同種類最後",
  [
    dataWrites().map((w) => `${w.table}:${w.op}`),
    tables.event_blocks.at(-1).sort_order,
    tables.event_blocks.at(-1).kind,
  ],
  [["event_blocks:insert"], 3, "faq"],
);

resetDb(BASE, RPC);
await commit("update_event_block");
check(
  "update_event_block：只 update title/body（不碰 sort_order、kind）",
  [
    Object.keys(dataWrites()[0]?.payload ?? {}).sort(),
    tables.event_blocks[1].body.zh,
    tables.event_blocks[1].sort_order,
  ],
  [["body", "title"], "A2 改", 2],
);

resetDb(BASE, RPC);
await commit("reorder_event_blocks");
check(
  "reorder_event_blocks：admin_reorder_event_blocks（完整清單），不逐列 update",
  [log.rpc, dataWrites().length],
  [
    [
      {
        name: "admin_reorder_event_blocks",
        args: { p_event_id: EVENT1, p_kind: "faq", p_ids: [12, 11] },
      },
    ],
    0,
  ],
);

resetDb(BASE, RPC);
globalThis.__gcalStatus = GCAL_OK;
out = await commit("sync_google_calendar");
check(
  "sync_google_calendar：runGoogleCalendarSync('manual')",
  [gcalCalls, out.written],
  [[["run", "manual"]], true],
);

// [6] ------------------------------------------------------------------------
console.log("\n[6] 業務規則");
const expectError = async (label, fn, re) => {
  resetDb(BASE, RPC);
  const r = await asOAuth(fn);
  check(
    `${label} → isError、不寫、不寄`,
    [
      r.isError === true,
      re ? re.test(r.content[0].text) : true,
      dataWrites().length,
      bizRpc().length,
      notifyCalls.length,
    ],
    [true, true, 0, 0, 0],
  );
};
await expectError(
  "collect_onsite_payment 匯款單",
  () =>
    H.collect_onsite_payment({ order_id: ORDER_TRANSFER, dry_run: false, notify_customer: true }),
  /mark_order_paid/,
);
await expectError("collect_onsite_payment 兩個訂單參照都給", () =>
  H.collect_onsite_payment({ order_id: ORDER_ONSITE, order_no: "S001" }),
);
await expectError("ship_order 門市自取／已完成的單", () =>
  H.ship_order({ order_id: ORDER_PAID_PICKUP, dry_run: false, notify_customer: true }),
);
await expectError(
  "archive_order 未付款的單",
  () => H.archive_order({ order_id: ORDER_TRANSFER, dry_run: false }),
  /已付款/,
);
await expectError(
  "update_event_session 名額低於已報名",
  () => H.update_event_session({ session_id: SESS1, capacity: 3, dry_run: false }),
  /已報名/,
);
await expectError("update_event_session 結束早於開始", () =>
  H.update_event_session({ session_id: SESS1, ends_at: "2099-12-05 10:00", dry_run: false }),
);
await expectError(
  "update_event_session 時間格式錯",
  () => H.update_event_session({ session_id: SESS1, starts_at: "12/5 晚上", dry_run: false }),
  /YYYY-MM-DD/,
);
await expectError(
  "update_ticket_type 可售張數低於已售",
  () => H.update_ticket_type({ ticket_type_id: PLAN1, capacity: 2, dry_run: false }),
  /已售/,
);
await expectError("create_ticket_type 停售早於開賣", () =>
  H.create_ticket_type({
    ...SAMPLE.create_ticket_type,
    sale_starts_at: "2099-12-01 10:00",
    sale_ends_at: "2099-11-01 10:00",
    dry_run: false,
    idempotency_key: U(9),
  }),
);
await expectError(
  "create_event_session 不存在的商品",
  () => H.create_event_session({ ...SAMPLE.create_event_session, product_id: "nope" }),
  /找不到/,
);
await expectError(
  "reorder_event_blocks 清單不完整",
  () => H.reorder_event_blocks({ event_id: EVENT1, kind: "faq", block_ids: [12], dry_run: false }),
  /完整清單/,
);
await expectError(
  "update_event_block 別的活動的區塊",
  () => H.update_event_block({ event_id: EVENT1, block_id: 999, body: L("x"), dry_run: false }),
  /找不到/,
);
globalThis.__gcalStatus = { ...GCAL_OK, connected: false };
await expectError(
  "sync_google_calendar 還沒連結",
  () => H.sync_google_calendar({ dry_run: false }),
  /連結/,
);
globalThis.__gcalStatus = GCAL_OK;

// 唯讀
resetDb(BASE, RPC);
const ls = parseOut(await asOAuth(() => H.list_event_sessions({ product_id: PROD_EVT })));
check(
  "list_event_sessions：場次與票種含 id、台北時間、已報名",
  [
    ls.products?.[0]?.sessions?.[0]?.session_id,
    ls.products?.[0]?.sessions?.[0]?.starts_at,
    ls.products?.[0]?.sessions?.[0]?.seats_taken,
    ls.products?.[0]?.sessions?.[0]?.ticket_types?.[0]?.ticket_type_id,
    dataWrites().length,
  ],
  [SESS1, "2099-12-05 19:30", 5, PLAN1, 0],
);
const lb = parseOut(await asOAuth(() => H.list_event_blocks({ event_id: EVENT1 })));
check(
  "list_event_blocks：依種類分組",
  [lb.blocks?.faq?.map((b) => b.block_id), lb.blocks?.agenda?.length, lb.blocks?.info_row?.length],
  [[11, 12], 1, 0],
);

// [7] ------------------------------------------------------------------------
console.log("\n[6b] 預覽＝寫入、票種人數、改期警告（審查 2026-11-15）");
{
  // 翻譯假模組每次回不同的英文（EN1、EN2…）：寫入時若重翻，結果一定跟預覽不同。
  resetDb(BASE, RPC);
  globalThis.__translateCalls = [];
  const pv = parseOut(
    await asOAuth(() =>
      H.create_event_session({
        ...SAMPLE.create_event_session,
        title: "第三場",
        location: "書店二樓",
      }),
    ),
  );
  const ca = pv.confirm_args;
  check(
    "create_event_session 預覽：confirm_args 帶完整三語、排序、idempotency_key、dry_run=false",
    [
      ca?.title,
      ca?.location?.zh,
      ca?.sort_order,
      ca?.idempotency_key === pv.idempotency_key,
      ca?.dry_run,
    ],
    [pv.will_create.title, "書店二樓", pv.will_create.sort_order, true, false],
  );
  checkTrue("create_event_session 預覽：next_step 要求原樣帶回", /confirm_args/.test(pv.next_step));
  checkTrue("confirm_args 通過工具 schema", INPUTS.create_event_session.safeParse(ca).success);
  const before = globalThis.__translateCalls.length;
  resetDb(BASE, RPC);
  const w = parseOut(await asOAuth(() => H.create_event_session(ca)));
  const insSess = dataWrites().find((x) => x.table === "event_sessions");
  check(
    "create_event_session 帶回 confirm_args：寫入的三語＝預覽、沒有再呼叫翻譯、沒有 write_note",
    [
      w.written,
      insSess?.payload?.title,
      insSess?.payload?.location,
      globalThis.__translateCalls.length - before,
      w.write_note,
    ],
    [true, pv.will_create.title, pv.will_create.location, 0, undefined],
  );

  resetDb(BASE, RPC);
  const raw = parseOut(
    await asOAuth(() =>
      H.create_event_session({
        ...SAMPLE.create_event_session,
        title: "第四場",
        dry_run: false,
        idempotency_key: crypto.randomUUID(),
      }),
    ),
  );
  checkTrue(
    "沒帶回（中文字串）：照寫但 write_note 明講寫入時才翻譯",
    raw.written && /寫入時才自動翻譯/.test(raw.write_note),
  );

  for (const [tool, args] of [
    ["create_ticket_type", { ...SAMPLE.create_ticket_type, title: "親子票" }],
    ["create_event_block", { ...SAMPLE.create_event_block, title: "問題", body: "回答" }],
  ]) {
    resetDb(BASE, RPC);
    const p1 = parseOut(await asOAuth(() => H[tool](args)));
    const n = globalThis.__translateCalls.length;
    resetDb(BASE, RPC);
    const w1 = parseOut(await asOAuth(() => H[tool](p1.confirm_args)));
    const ins = dataWrites().find((x) => x.op === "insert");
    check(
      `${tool} 帶回 confirm_args：寫入標題＝預覽、沒有再翻譯`,
      [w1.written, ins?.payload?.title, globalThis.__translateCalls.length - n],
      [true, p1.will_create.title, 0],
    );
  }
  for (const [tool, args, key] of [
    ["update_event_session", { session_id: SESS1, title: "第一場（改）" }, "event_sessions"],
    ["update_ticket_type", { ticket_type_id: PLAN1, title: "早鳥票" }, "event_session_plans"],
    ["update_event_block", { event_id: EVENT1, block_id: 12, body: "新答案" }, "event_blocks"],
  ]) {
    resetDb(BASE, RPC);
    const p1 = parseOut(await asOAuth(() => H[tool](args)));
    const field = Object.keys(p1.changes).find((k) => k === "title" || k === "body");
    const n = globalThis.__translateCalls.length;
    resetDb(BASE, RPC);
    const w1 = parseOut(await asOAuth(() => H[tool](p1.confirm_args)));
    const upd = dataWrites().find((x) => x.table === key);
    check(
      `${tool} 帶回 confirm_args：寫入＝預覽的 after、沒有再翻譯`,
      [w1.written, upd?.payload?.[field], globalThis.__translateCalls.length - n],
      [true, p1.changes[field].after, 0],
    );
  }
}
await expectError(
  "update_ticket_type 已售出後改每張佔幾個名額",
  () => H.update_ticket_type({ ticket_type_id: PLAN1, seats_per_unit: 2, dry_run: false }),
  /已售出 4 張/,
);
await expectError(
  "update_ticket_type 已售出後改每張佔幾個名額（預覽也擋）",
  () => H.update_ticket_type({ ticket_type_id: PLAN1, seats_per_unit: 2 }),
  /另開一個票種/,
);
{
  resetDb(BASE, RPC);
  tables.event_session_plans[0].units_taken = 0;
  const ok = parseOut(
    await asOAuth(() => H.update_ticket_type({ ticket_type_id: PLAN1, seats_per_unit: 2 })),
  );
  check("update_ticket_type 未售出：可以改每張佔幾個名額", ok.changes?.seats_per_unit, {
    before: 1,
    after: 2,
  });
  resetDb(BASE, RPC);
  const same = parseOut(
    await asOAuth(() =>
      H.update_ticket_type({ ticket_type_id: PLAN1, seats_per_unit: 1, price: 480 }),
    ),
  );
  checkTrue(
    "update_ticket_type 已售出但人數沒變（同值）：不擋",
    !same.error && same.changes?.price,
  );

  resetDb(BASE, RPC);
  const mv = parseOut(
    await asOAuth(() =>
      H.update_event_session({
        session_id: SESS1,
        starts_at: "2099-12-06 19:30",
        ends_at: "2099-12-06 21:30",
      }),
    ),
  );
  checkTrue(
    "update_event_session 有報名者改期：預覽警告（不會通知、提醒信跟著新時間）",
    /5 位報名/.test(mv.warning) && /不會自動通知/.test(mv.warning) && /提醒信/.test(mv.warning),
  );
  resetDb(BASE, RPC);
  const mvw = parseOut(
    await asOAuth(() =>
      H.update_event_session({
        session_id: SESS1,
        starts_at: "2099-12-06 19:30",
        ends_at: "2099-12-06 21:30",
        dry_run: false,
      }),
    ),
  );
  checkTrue(
    "update_event_session 改期寫入：結果也帶警告",
    mvw.written && /不會自動通知/.test(mvw.warning),
  );
  resetDb(BASE, RPC);
  const cap = parseOut(
    await asOAuth(() => H.update_event_session({ session_id: SESS1, capacity: 30 })),
  );
  check("update_event_session 沒改時間：沒有警告", cap.warning, undefined);
  resetDb(BASE, RPC);
  tables.event_sessions[0].seats_taken = 0;
  const empty = parseOut(
    await asOAuth(() =>
      H.update_event_session({
        session_id: SESS1,
        starts_at: "2099-12-06 19:30",
        ends_at: "2099-12-06 21:30",
      }),
    ),
  );
  check("update_event_session 沒人報名改期：沒有警告", empty.warning, undefined);
}

console.log("\n[6c] 長翻譯（英日文約 1.5 倍中文）：預覽的 confirm_args 仍通過 schema 並可寫入");
{
  // 中文剛好頂到上限，假翻譯回 1.5 倍長：舊版 en/ja 與中文同上限會被 schema 擋下。
  const zh = (n) => "長".repeat(n);
  const cases = [
    [
      "create_event_session",
      { ...SAMPLE.create_event_session, title: zh(200), location: zh(500) },
      ["title", "location"],
    ],
    ["create_ticket_type", { ...SAMPLE.create_ticket_type, title: zh(200) }, ["title"]],
    [
      "create_event_block",
      { ...SAMPLE.create_event_block, title: zh(500), body: zh(2000) },
      ["title", "body"],
    ],
    [
      "update_event_session",
      { session_id: SESS1, title: zh(200), location: zh(500) },
      ["title", "location"],
    ],
    ["update_ticket_type", { ticket_type_id: PLAN1, title: zh(200) }, ["title"]],
    [
      "update_event_block",
      { event_id: EVENT1, block_id: 12, title: zh(500), body: zh(2000) },
      ["title", "body"],
    ],
  ];
  globalThis.__translateLong = true;
  try {
    for (const [tool, args, fields] of cases) {
      resetDb(BASE, RPC);
      // 輸入走工具 schema（與 MCP 實際呼叫同一條路），不直接把原始物件丟給 handler。
      const parsedIn = INPUTS[tool].safeParse(args);
      checkTrue(`${tool} 中文頂到上限的輸入通過 schema`, parsedIn.success);
      if (!parsedIn.success) continue;
      const pv = parseOut(await asOAuth(() => H[tool](parsedIn.data)));
      const ca = pv.confirm_args;
      checkTrue(
        `${tool} 預覽的英日文確實比中文上限長（1.5 倍）`,
        fields.every(
          (f) =>
            typeof ca?.[f]?.en === "string" &&
            ca[f].en.length > ca[f].zh.length &&
            ca[f].ja.length > ca[f].zh.length,
        ),
      );
      const parsedCa = INPUTS[tool].safeParse(ca);
      checkTrue(`${tool} 長翻譯的 confirm_args 通過 INPUTS.${tool}.safeParse`, parsedCa.success);
      if (!parsedCa.success) continue;
      const n = globalThis.__translateCalls.length;
      resetDb(BASE, RPC);
      const w = parseOut(await asOAuth(() => H[tool](parsedCa.data)));
      check(
        `${tool} 長翻譯 confirm_args 經 schema 後寫入成功、沒有再翻譯`,
        [w.written, globalThis.__translateCalls.length - n],
        [true, 0],
      );
    }
    // 上限仍在：超過中文上限 3 倍的英文要擋。
    checkTrue(
      "create_event_block 英文超過中文上限 3 倍仍被擋",
      !INPUTS.create_event_block.safeParse({
        ...SAMPLE.create_event_block,
        title: { zh: "問", en: "E".repeat(1501), ja: "ジ" },
      }).success,
    );
  } finally {
    globalThis.__translateLong = false;
  }
}

console.log("\n[7] 靜態");
const srcText = readFile(join(SRC, "server/mcp/orders-events-tools.ts"));
const code = srcText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
check(
  "自己不寫 .update(/.insert(/.delete(/.upsert(/.rpc(",
  /\.(update|insert|delete|upsert|rpc)\(/.test(code),
  false,
);
check(
  "不匯入 @/server/translate（借 tools.ts 的 translator）",
  /@\/server\/translate/.test(code),
  false,
);
check(
  "不碰刪除 repo（removeEventSession／removeEventBlock／deleteOrder）",
  /removeEvent|deleteAdminOrder|admin_delete/.test(code),
  false,
);
check(
  "不碰 Google 日曆連線／中斷",
  /disconnectGoogleCalendar|saveGoogleCalendarConnection/.test(code),
  false,
);
const toolsSrc = readFile(join(SRC, "server/mcp/tools.ts"));
check(
  "tools.ts 有註冊 ORDERS_EVENTS（INPUTS 與 META/HANDLERS）",
  [
    /\.\.\.ORDERS_EVENTS_TOOL_INPUTS/.test(toolsSrc),
    /\[ORDERS_EVENTS_TOOL_META, ORDERS_EVENTS_HANDLERS/.test(toolsSrc),
  ],
  [true, true],
);

console.info = origInfo;
console.log(
  fail === 0
    ? green(`\n✓ 全部通過：${pass} passed, 0 failed`)
    : red(`\n✗ 有失敗：${pass} passed, ${fail} failed`),
);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
