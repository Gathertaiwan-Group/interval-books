#!/usr/bin/env node
/**
 * mcp-partners-content-selftest.mjs —— MCP 選品／廠商／推薦人／聯絡電話（src/server/mcp/partners-content-tools.ts）
 *
 *   [1] 形狀：三份匯出一致、annotations、寫入 dry_run 預設 true、讀取＝list_／get_、不與既有工具撞名
 *   [2] 敏感：輸入沒有識別碼／匯款／附件／結算／刪除欄位；回傳（預覽、寫入、唯讀）不出現識別碼與遮罩
 *   [3] 每支寫入：預覽不寫資料（只記 dry_run=true 稽核）；dry_run=false 才呼叫後台同一支 repo／RPC
 *   [4] 建立類：dry_run=false 沒帶 idempotency_key → 拒絕；同一組送第二次 → 拒絕
 *   [5] 靜態 token → 一律拒絕寫入
 *   [6] 業務規則：選品只能連書籍／選物、沒連商品提醒前台不顯示、排序要列全部品項、
 *       已有識別碼的廠商拒絕修改、推薦碼重複、只動待審的那一筆
 *   [7] 靜態：這個檔案不寫 update／insert／delete／upsert／rpc、不碰禁用的 server fn
 *
 * 用假的 supabaseAdmin（記錄 rpc 與寫入）跑 production 的 handler 與 repo 本人。
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15（module.registerHooks）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/mcp-partners-content-selftest.mjs";
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

delete process.env.GEMINI_API_KEY;

// ── 假的 Supabase ───────────────────────────────────────────────────────────
const log = { rpc: [], writes: [] };
let tables = {};
let rpcData = {};
let nextId = 1000;
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
    limit: pass_,
    range: pass_,
    insert: (p) => ((st.op = "insert"), (st.payload = p), b),
    update: (p) => ((st.op = "update"), (st.payload = p), b),
    upsert: (p) => ((st.op = "upsert"), (st.payload = p), b),
    delete: () => ((st.op = "delete"), b),
    eq: (c, v) => (st.filters.push((r) => r[c] === v), b),
    in: (c, vs) => (st.filters.push((r) => vs.includes(r[c])), b),
    maybeSingle: () => ((st.single = "maybe"), b),
    single: () => ((st.single = "one"), b),
    then(resolve, reject) {
      try {
        const all = (tables[table] ??= []);
        if (st.op !== "select") log.writes.push({ table, op: st.op, payload: st.payload });
        if (st.op === "insert") {
          if (table === "mcp_oauth_used_codes" && all.some((r) => r.jti === st.payload.jti)) {
            resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
            return;
          }
          const row = { id: nextId++, ...st.payload };
          all.push(row);
          resolve({ data: st.single ? row : [row], error: null });
          return;
        }
        if (st.op === "upsert") {
          const i = all.findIndex((r) => r.id === st.payload.id);
          const row = i >= 0 ? Object.assign(all[i], st.payload) : { ...st.payload };
          if (i < 0) all.push(row);
          resolve({ data: st.single ? row : [row], error: null });
          return;
        }
        const rows = all.filter((r) => st.filters.every((f) => f(r)));
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

function resolveTs(base) {
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand)) return pathToFileURL(cand).href;
  }
  return null;
}
const FAKE_ADMIN =
  "data:text/javascript," +
  encodeURIComponent("export const supabaseAdmin = () => globalThis.__fakeSupabase;");
// 假的翻譯（🔴 不打真的 Gemini）：只有 [6b] 暫時設 GEMINI_API_KEY 時才會被用到。
globalThis.__translateCalls = [];
const FAKE_TRANSLATE =
  "data:text/javascript," +
  encodeURIComponent(`
    export async function translateToEnJa({ text }) {
      globalThis.__translateCalls.push(text);
      return { en: "EN" + globalThis.__translateCalls.length + " " + text, ja: "JA " + text };
    }
  `);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@/server/supabase-admin") return { url: FAKE_ADMIN, shortCircuit: true };
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

const MOD = await import(join(SRC, "server/mcp/partners-content-tools.ts"));
const {
  PARTNERS_CONTENT_TOOL_INPUTS: INPUTS,
  PARTNERS_CONTENT_TOOL_META: META,
  PARTNERS_CONTENT_HANDLERS: H,
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

console.log("═══ MCP 選品／廠商／推薦人／聯絡電話 自檢 ═══");

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
  "get_referral_settings",
  "list_contact_phones",
  "list_vendor_contacts",
  "list_vendor_submissions",
]);
check("寫入工具清單", WRITES, [
  "approve_vendor",
  "approve_vendor_submission",
  "create_contact_phone",
  "create_curated_item",
  "create_curated_theme",
  "create_referrer",
  "create_vendor",
  "reorder_curated_items",
  "save_vendor_contact",
  "update_contact_phone",
  "update_curated_item",
  "update_curated_theme",
  "update_referral_settings",
  "update_referrer",
  "update_vendor",
]);
check(
  "每支都有 title／description／四個 annotations，且都不是 destructive",
  names.every(
    (n) =>
      META[n].title &&
      META[n].description &&
      META[n].annotations.destructiveHint === false &&
      ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].every(
        (k) => typeof META[n].annotations[k] === "boolean",
      ),
  ),
  true,
);
check(
  "每支寫入 dry_run 預設 true",
  WRITES.filter(
    (n) => z.toJSONSchema(INPUTS[n], { io: "input" }).properties?.dry_run?.default !== true,
  ),
  [],
);
const CREATES = WRITES.filter((n) => META[n].annotations.idempotentHint === false);
check(
  "建立類（idempotentHint=false）都有 idempotency_key",
  CREATES.filter((n) => !("idempotency_key" in INPUTS[n].shape)),
  [],
);
check(
  "選品工具說明都提醒「前台只顯示有連結商品的選品」",
  ["create_curated_theme", "create_curated_item", "update_curated_item"].filter(
    (n) => !META[n].description.includes("有連結商品"),
  ),
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
]) {
  for (const m of readFile(join(SRC, "server/mcp", f)).matchAll(/^ {2}([a-z_]+): z/gm))
    existing.add(m[1]);
}
check(
  "不與既有 MCP 工具撞名",
  names.filter((n) => existing.has(n)),
  [],
);

// [2] ------------------------------------------------------------------------
console.log("\n[2] 敏感欄位");
function propNames(schema, out = new Set()) {
  if (!schema || typeof schema !== "object") return out;
  if (schema.properties) for (const k of Object.keys(schema.properties)) out.add(k);
  for (const v of Object.values(schema)) {
    if (Array.isArray(v)) v.forEach((x) => propNames(x, out));
    else if (v && typeof v === "object") propNames(v, out);
  }
  return out;
}
const BANNED_INPUT =
  /tax_id|id_number|foreign_id|residence|permit|bank|account|attachment|file_path|portal|settle|delete|remove|password|token|secret|pii|commission_rate|fee_rate|payment_terms|consignment|entity_type/i;
const offenders = [];
for (const n of names) {
  for (const p of propNames(z.toJSONSchema(INPUTS[n], { io: "input" }))) {
    if (BANNED_INPUT.test(p)) offenders.push(`${n}.${p}`);
  }
}
check("輸入沒有識別碼／匯款／附件／入口帳號／結算／刪除／財務條件欄位", offenders, []);
const LEAK_RE = /tax_id|id_number|foreign_id|residence_permit|masked|A123456789|12345678|\*\*\*\*/;

// ── 測試資料 ────────────────────────────────────────────────────────────────
const U = (n) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const L = (zh) => ({ zh, en: `${zh}-en`, ja: `${zh}-ja` });
const V_PLAIN = U(1);
const V_TAXID = U(2);
const V_PENDING = U(3);
const SUB_PENDING = U(4);
const SUB_DONE = U(5);
const REF1 = U(6);
const REF2 = U(7);
const CONTACT1 = U(8);
const vendorDetail = (over) => ({
  vendor_id: V_PLAIN,
  vendor_code: "V0001",
  entity_type: "domestic_individual",
  category_id: null,
  name: "王小明手作",
  name_en: null,
  short_name: null,
  representative: null,
  is_preferred: false,
  notes: null,
  tax_id_masked: null,
  id_number_masked: null,
  foreign_id_masked: null,
  residence_permit_number_masked: null,
  foreign_id_type: null,
  taiwan_residency_status: null,
  country_code: null,
  phone: "02-1111-1111",
  fax: null,
  email: null,
  address: null,
  address_en: null,
  invoice_address: null,
  default_tax_type_id: null,
  default_withholding_category_id: null,
  is_nhi_applicable: false,
  voucher_category: "receipt",
  einvoice_type: "none",
  payment_terms: "monthly",
  payment_terms_note: null,
  settlement_type: "end_of_month",
  settlement_start_day: null,
  settlement_interval_days: null,
  bill_due_day: 10,
  is_consignment: true,
  cash_fee_rate: 0.08,
  domestic_card_fee_rate: 0.101,
  foreign_card_fee_rate: 0.1115,
  commission_rate: 0.3,
  status: "active",
  approval_status: "approved",
  ...over,
});
const BASE_TABLES = {
  curated_themes: [
    { id: "t1", title: L("書店選書"), description: L("說明"), is_published: true, sort_order: 1 },
    { id: "t2", title: L("冬日"), description: L("說明2"), is_published: false, sort_order: 4 },
  ],
  curated_items: [
    {
      id: 11,
      theme_id: "t1",
      name: L("甲"),
      note: L("評甲"),
      is_published: true,
      sort_order: 1,
      product_id: "book-1",
    },
    {
      id: 12,
      theme_id: "t1",
      name: L("乙"),
      note: L("評乙"),
      is_published: true,
      sort_order: 2,
      product_id: null,
    },
    {
      id: 13,
      theme_id: "t1",
      name: L("丙"),
      note: L("評丙"),
      is_published: false,
      sort_order: 3,
      product_id: null,
    },
  ],
  products: [
    { id: "book-1", product_type: "book", title: L("一本書"), status: "active" },
    { id: "goods-1", product_type: "goods", title: L("杯子"), status: "draft" },
    { id: "event-1", product_type: "event", title: L("講座"), status: "active" },
  ],
  inv_admin_vendor_detail: [
    vendorDetail({}),
    vendorDetail({
      vendor_id: V_TAXID,
      entity_type: "domestic_company",
      name: "某某公司",
      tax_id_masked: "****5678",
    }),
    vendorDetail({ vendor_id: V_PENDING, name: "新廠商", approval_status: "pending" }),
  ],
  inv_admin_vendor_contacts: [
    {
      contact_id: CONTACT1,
      vendor_id: V_PLAIN,
      name: "陳窗口",
      job_title: null,
      phone: null,
      mobile: "0912000000",
      email: null,
      is_primary: true,
      is_finance_contact: false,
      notes: null,
      sort_order: 0,
    },
  ],
  inv_admin_vendor_submissions: [
    {
      inv_product_id: SUB_PENDING,
      name: "紅烏龍茶餅",
      selling_price: 480,
      image_key: "vendor/x.jpg",
      approval_status: "pending",
      vendor_id: V_PLAIN,
      vendor_name: "王小明手作",
    },
    {
      inv_product_id: SUB_DONE,
      name: "舊品",
      selling_price: 100,
      image_key: null,
      approval_status: "approved",
      vendor_id: V_PLAIN,
      vendor_name: "王小明手作",
    },
  ],
  referrers: [
    {
      id: REF1,
      name: "阿美",
      code: "AMY",
      kind: "external",
      contact: null,
      email: "amy@example.com",
      phone: null,
      base_salary: null,
      discount_percent: null,
      commission_tiers: null,
      active: true,
      note: null,
      created_at: "2026-10-01",
    },
    {
      id: REF2,
      name: "小傑",
      code: "JAY",
      kind: "team",
      contact: null,
      email: null,
      phone: null,
      base_salary: 30000,
      discount_percent: 5,
      commission_tiers: null,
      active: true,
      note: null,
      created_at: "2026-10-02",
    },
  ],
  referral_settings: [
    {
      id: 1,
      default_discount_percent: 5,
      default_margin_percent: 40,
      commission_tiers: [
        { upTo: 10000, rate: 15 },
        { upTo: null, rate: 25 },
      ],
      new_customer_multiplier: 1.5,
      team_pool_baseline: null,
      team_pool_percent: 5,
      team_pool_equal_percent: 50,
      payout_cap_percent: 50,
      clawback_days: 14,
    },
  ],
  contact_phones: [
    { id: 1, label: "門市", display_text: "02-2345-6789", tel: "+886223456789", sort_order: 1 },
    { id: 2, label: "客服", display_text: "0912-345-678", tel: "+886912345678", sort_order: 3 },
  ],
};
const BASE_RPC = {
  inv_save_vendor: { id: U(9), created: true, vendor_code: "V0009", approval_status: "pending" },
  inv_approve_vendor_product: { changed: true, previous_status: "pending", listed: false },
  inv_approve_record: { changed: true, module: "vendors", previous_status: "pending" },
  inv_save_vendor_contact: { id: U(9), created: true },
  admin_reorder_curated_items: null,
};
const KEY = "99999999-9999-4999-8999-999999999999";
const KEY2 = "98989898-9898-4989-8989-989898989898";

async function expectError(label, fn) {
  resetDb(BASE_TABLES, BASE_RPC);
  const r = await asOAuth(fn);
  check(
    `${label} → isError、沒有寫入`,
    [r.isError === true, dataWrites().length, log.rpc.length],
    [true, 0, 0],
  );
  return r;
}

/**
 * 每支寫入的一組案例：args（不含 dry_run）、預期的 dry_run=false 寫入（repo 的 rpc 或 table op）。
 */
const CASES = {
  create_curated_theme: {
    args: { title: L("秋天"), description: L("秋天說明") },
    expect: () =>
      log.writes.find((w) => w.table === "curated_themes" && w.op === "upsert")?.payload
        ?.sort_order,
    expected: 5,
  },
  update_curated_theme: {
    args: { id: "t2", sort_order: 0, is_published: true },
    expect: () => log.writes.find((w) => w.table === "curated_themes")?.payload,
    expected: {
      id: "t2",
      title: L("冬日"),
      description: L("說明2"),
      is_published: true,
      sort_order: 0,
    },
  },
  create_curated_item: {
    args: { theme_id: "t1", name: L("丁"), note: L("評丁"), product_id: "goods-1" },
    expect: () => {
      const p = log.writes.find((w) => w.table === "curated_items" && w.op === "insert")?.payload;
      return p && [p.theme_id, p.sort_order, p.product_id, p.is_published];
    },
    expected: ["t1", 4, "goods-1", false],
  },
  update_curated_item: {
    args: { id: 12, product_id: "book-1" },
    expect: () => {
      const w = log.writes.find((x) => x.table === "curated_items");
      return w && [w.op, w.payload.product_id, "sort_order" in w.payload];
    },
    expected: ["update", "book-1", false],
  },
  reorder_curated_items: {
    args: { theme_id: "t1", item_ids: [13, 11, 12] },
    expect: () => log.rpc.find((r) => r.name === "admin_reorder_curated_items")?.args,
    expected: { p_theme_id: "t1", p_ids: [13, 11, 12] },
  },
  approve_vendor_submission: {
    args: { id: SUB_PENDING, decision: "approve" },
    expect: () => log.rpc.find((r) => r.name === "inv_approve_vendor_product")?.args,
    expected: { p_user_id: ADMIN_ID, p_id: SUB_PENDING, p_approved: true, p_listing: null },
  },
  create_vendor: {
    args: { name: "林阿姨果醬", phone: "0922-000-000", notes: "寄賣" },
    expect: () => {
      const a = log.rpc.find((r) => r.name === "inv_save_vendor")?.args;
      return (
        a && [
          a.p_user_id,
          a.p_id,
          a.p_payload.entity_type,
          a.p_payload.name,
          a.p_payload.tax_id,
          a.p_payload.id_number,
          a.p_payload.cash_fee_rate,
        ]
      );
    },
    expected: [ADMIN_ID, null, "domestic_individual", "林阿姨果醬", null, null, 0.08],
  },
  update_vendor: {
    args: { vendor_id: V_PLAIN, email: "wang@example.com", address: "台北市" },
    expect: () => {
      const a = log.rpc.find((r) => r.name === "inv_save_vendor")?.args;
      return (
        a && [
          a.p_id,
          a.p_payload.email,
          a.p_payload.address,
          a.p_payload.phone,
          a.p_payload.commission_rate,
          a.p_payload.is_consignment,
          a.p_payload.payment_terms,
          a.p_payload.id_number,
        ]
      );
    },
    expected: [V_PLAIN, "wang@example.com", "台北市", "02-1111-1111", 0.3, true, "monthly", null],
  },
  approve_vendor: {
    args: { vendor_id: V_PENDING, decision: "approve" },
    expect: () => log.rpc.find((r) => r.name === "inv_approve_record")?.args,
    expected: { p_user_id: ADMIN_ID, p_module: "vendors", p_id: V_PENDING, p_approved: true },
  },
  save_vendor_contact: {
    args: { vendor_id: V_PLAIN, name: "李會計", is_finance_contact: true },
    expect: () => {
      const a = log.rpc.find((r) => r.name === "inv_save_vendor_contact")?.args;
      return (
        a && [
          a.p_vendor_id,
          a.p_id,
          a.p_payload.name,
          a.p_payload.is_finance_contact,
          a.p_payload.is_primary,
          a.p_payload.sort_order,
        ]
      );
    },
    expected: [V_PLAIN, null, "李會計", true, false, 1],
  },
  create_referrer: {
    args: {
      name: "小花",
      code: "flower 01",
      commission_tiers: [
        { up_to: 5000, rate: 10 },
        { up_to: null, rate: 20 },
      ],
    },
    expect: () => {
      const p = log.writes.find((w) => w.table === "referrers" && w.op === "insert")?.payload;
      return p && [p.code, p.kind, p.active, p.commission_tiers];
    },
    expected: [
      "FLOWER01",
      "external",
      true,
      [
        { upTo: 5000, rate: 10 },
        { upTo: null, rate: 20 },
      ],
    ],
  },
  update_referrer: {
    args: { id: REF2, discount_percent: 8, active: false },
    expect: () => {
      const p = log.writes.find((w) => w.table === "referrers" && w.op === "update")?.payload;
      return p && [p.code, p.discount_percent, p.active, p.base_salary];
    },
    expected: ["JAY", 8, false, 30000],
  },
  update_referral_settings: {
    args: { default_discount_percent: 10, clawback_days: 30 },
    expect: () => {
      const p = log.writes.find((w) => w.table === "referral_settings")?.payload;
      return (
        p && [
          p.default_discount_percent,
          p.clawback_days,
          p.default_margin_percent,
          p.commission_tiers,
        ]
      );
    },
    expected: [
      10,
      30,
      40,
      [
        { upTo: 10000, rate: 15 },
        { upTo: null, rate: 25 },
      ],
    ],
  },
  create_contact_phone: {
    args: { label: "LINE 客服", display_text: "@intervalbooks", tel: "+886900000000" },
    expect: () =>
      log.writes.find((w) => w.table === "contact_phones" && w.op === "insert")?.payload,
    expected: {
      label: "LINE 客服",
      display_text: "@intervalbooks",
      tel: "+886900000000",
      sort_order: 4,
    },
  },
  update_contact_phone: {
    args: { id: 2, display_text: "0912-000-111" },
    expect: () => {
      const w = log.writes.find((x) => x.table === "contact_phones");
      return w && [w.op, w.payload.display_text, w.payload.tel];
    },
    expected: ["update", "0912-000-111", "+886912345678"],
  },
};
check(
  "每支寫入都有行為案例",
  WRITES.filter((n) => !CASES[n]),
  [],
);

// [3][4][5] ------------------------------------------------------------------
console.log("\n[3] 預覽不寫、[4] dry_run=false 走後台同一支、[5] 靜態 token 拒絕");
for (const n of WRITES) {
  const c = CASES[n];
  // 預覽
  resetDb(BASE_TABLES, BASE_RPC);
  const pv = await asOAuth(() => H[n]({ ...c.args }));
  const pvOut = parseOut(pv);
  check(
    `${n} 預覽：不呼叫 RPC、不寫資料、記一筆 dry_run=true 稽核`,
    [
      pv.isError ?? false,
      pvOut.dry_run,
      log.rpc.length,
      dataWrites().length,
      audits().map((a) => a.dry_run),
    ],
    [false, true, 0, 0, [true]],
  );
  check(`${n} 預覽沒有洩漏識別碼`, LEAK_RE.test(pv.content[0].text), false);
  const key = pvOut.idempotency_key;
  // 正式寫入
  resetDb(BASE_TABLES, BASE_RPC);
  const args = {
    ...c.args,
    dry_run: false,
    ...(CREATES.includes(n) && key ? { idempotency_key: key } : {}),
  };
  const wr = await asOAuth(() => H[n](args));
  check(`${n} dry_run=false 成功`, [wr.isError ?? false, parseOut(wr).dry_run], [false, false]);
  check(`${n} 寫入參數與後台同一支`, c.expect(), c.expected);
  check(
    `${n} 寫入記一筆 dry_run=false 稽核`,
    audits().map((a) => a.dry_run),
    [false],
  );
  check(`${n} 寫入回傳沒有洩漏識別碼`, LEAK_RE.test(wr.content[0].text), false);
  // 靜態 token
  resetDb(BASE_TABLES, BASE_RPC);
  const st = await asStatic(() => H[n]({ ...args }));
  check(
    `${n} 靜態 token → 拒絕（含預覽）`,
    [st.isError, st.content[0].text.includes("OAuth"), dataWrites().length, log.rpc.length],
    [true, true, 0, 0],
  );
}

console.log("\n[4] idempotency_key");
// approve_vendor_submission 只有「核准並上架」才建資料（下面 [6] 另測）。
for (const n of CREATES.filter((x) => x !== "approve_vendor_submission")) {
  const c = CASES[n];
  await expectError(`${n} dry_run=false 沒帶 idempotency_key`, () =>
    H[n]({ ...c.args, dry_run: false, idempotency_key: undefined }),
  );
}
{
  resetDb(BASE_TABLES, BASE_RPC);
  const args = { ...CASES.create_contact_phone.args, dry_run: false, idempotency_key: KEY };
  await asOAuth(() => H.create_contact_phone(args));
  const again = await asOAuth(() => H.create_contact_phone(args));
  check(
    "同一組 idempotency_key 第二次送出 → 拒絕，只建一筆",
    [again.isError, log.writes.filter((w) => w.table === "contact_phones").length],
    [true, 1],
  );
}

// [6] ------------------------------------------------------------------------
console.log("\n[6] 業務規則");
await expectError("選品連結活動票券", () =>
  H.create_curated_item({
    theme_id: "t1",
    name: L("x"),
    note: L("y"),
    product_id: "event-1",
    dry_run: false,
    idempotency_key: KEY,
  }),
);
await expectError("選品連結不存在的商品", () =>
  H.update_curated_item({ id: 11, product_id: "nope", dry_run: false }),
);
await expectError("選品主題不存在", () =>
  H.create_curated_item({ theme_id: "zz", name: L("x"), note: L("y") }),
);
{
  resetDb(BASE_TABLES, BASE_RPC);
  const r = parseOut(
    await asOAuth(() => H.create_curated_item({ theme_id: "t1", name: L("x"), note: L("y") })),
  );
  check(
    "沒連結商品的選品：預覽提醒前台不會顯示",
    String(r.visibility).includes("前台不會顯示"),
    true,
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const u = parseOut(await asOAuth(() => H.update_curated_item({ id: 11, product_id: null })));
  check(
    "解除連結：changes.product_id 由 book-1 → null，並提醒",
    [u.changes?.product_id, String(u.visibility).includes("前台不會顯示")],
    [{ before: "book-1", after: null }, true],
  );
}
await expectError("排序沒列全部品項", () =>
  H.reorder_curated_items({ theme_id: "t1", item_ids: [12, 11], dry_run: false }),
);
await expectError("排序有重複", () =>
  H.reorder_curated_items({ theme_id: "t1", item_ids: [11, 11, 12], dry_run: false }),
);
{
  resetDb(BASE_TABLES, BASE_RPC);
  const r = parseOut(
    await asOAuth(() => H.update_curated_theme({ id: "t1", is_published: true, dry_run: false })),
  );
  check("沒有改變 → written=false、不寫", [r.written, dataWrites().length], [false, 0]);
}
{
  resetDb(BASE_TABLES, BASE_RPC);
  const r = await asOAuth(() => H.create_curated_theme({ title: "只有中文" }));
  check("缺 description → isError", r.isError, true);
  resetDb(BASE_TABLES, BASE_RPC);
  const t = await asOAuth(() => H.create_curated_theme({ title: "只有中文", description: L("d") }));
  check(
    "只給中文且沒有翻譯金鑰 → isError 請呼叫端給 en/ja",
    [t.isError, t.content[0].text.includes("en 與 ja")],
    [true, true],
  );
}
const tax = await expectError("已存有統編的廠商不能用 MCP 改", () =>
  H.update_vendor({ vendor_id: V_TAXID, phone: "02-0000-0000", dry_run: false }),
);
check(
  "拒絕訊息說明原因、指向後台、不含號碼",
  [
    tax.content[0].text.includes("統一編號"),
    tax.content[0].text.includes("後台"),
    LEAK_RE.test(tax.content[0].text),
  ],
  [true, true, false],
);
await expectError("廠商 Email 格式錯（同 vendorSchema）", () =>
  H.update_vendor({ vendor_id: V_PLAIN, email: "not-an-email", dry_run: false }),
);
{
  resetDb(BASE_TABLES, BASE_RPC);
  const r = await asOAuth(() =>
    H.update_vendor({
      vendor_id: V_PLAIN,
      tax_id: "12345678",
      id_number: "A123456789",
      dry_run: false,
    }),
  );
  check(
    "update_vendor 送識別碼：被輸入 schema 丟掉，RPC 收到的仍是 null",
    [r.isError ?? false, log.rpc.length],
    [false, 0],
  );
}
{
  resetDb(BASE_TABLES, BASE_RPC);
  const r = parseOut(
    await asOAuth(() =>
      H.approve_vendor({ vendor_id: V_PLAIN, decision: "approve", dry_run: false }),
    ),
  );
  check("已核准的廠商 → written=false、不呼叫 RPC", [r.written, log.rpc.length], [false, 0]);
  resetDb(BASE_TABLES, BASE_RPC);
  const s = parseOut(
    await asOAuth(() =>
      H.approve_vendor_submission({ id: SUB_DONE, decision: "approve", dry_run: false }),
    ),
  );
  check("已審過的送審商品 → written=false、不呼叫 RPC", [s.written, log.rpc.length], [false, 0]);
}
await expectError("退回時不能同時上架", () =>
  H.approve_vendor_submission({
    id: SUB_PENDING,
    decision: "reject",
    listing: { slug: "tea", title: L("茶"), summary: L("s"), description: L("d"), price: 480 },
  }),
);
{
  const listing = {
    slug: "red-oolong",
    title: L("紅烏龍茶餅"),
    summary: L("s"),
    description: L("d"),
    price: 480,
  };
  resetDb(BASE_TABLES, BASE_RPC);
  const pv = parseOut(
    await asOAuth(() =>
      H.approve_vendor_submission({ id: SUB_PENDING, decision: "approve", listing }),
    ),
  );
  check(
    "核准並上架：預覽給 idempotency_key 與上架內容",
    [typeof pv.idempotency_key, pv.will_list?.slug, pv.will_list?.status],
    ["string", "red-oolong", "draft"],
  );
  await expectError("核准並上架 dry_run=false 沒帶 idempotency_key", () =>
    H.approve_vendor_submission({ id: SUB_PENDING, decision: "approve", listing, dry_run: false }),
  );
  resetDb(BASE_TABLES, BASE_RPC);
  await asOAuth(() =>
    H.approve_vendor_submission({
      id: SUB_PENDING,
      decision: "approve",
      listing,
      dry_run: false,
      idempotency_key: KEY2,
    }),
  );
  const a = log.rpc.find((r) => r.name === "inv_approve_vendor_product")?.args;
  check(
    "核准並上架：listing 圖片沿用廠商上傳的、單位預設 1",
    [a?.p_listing?.image_key, a?.p_listing?.units_per_sale, a?.p_listing?.product_type],
    ["vendor/x.jpg", 1, "goods"],
  );
  await expectError("上架網址代稱格式錯（同 vendorSubmissionApprovalSchema）", () =>
    H.approve_vendor_submission({
      id: SUB_PENDING,
      decision: "approve",
      listing: { ...listing, slug: "紅烏龍" },
    }),
  );
}
await expectError("新增聯絡窗口沒給 name", () =>
  H.save_vendor_contact({ vendor_id: V_PLAIN, mobile: "0900" }),
);
{
  resetDb(BASE_TABLES, BASE_RPC);
  await asOAuth(() =>
    H.save_vendor_contact({
      vendor_id: V_PLAIN,
      contact_id: CONTACT1,
      email: "chen@example.com",
      dry_run: false,
    }),
  );
  const a = log.rpc.find((r) => r.name === "inv_save_vendor_contact")?.args;
  check(
    "修改聯絡窗口：帶 contact_id、保留原值、不需要 idempotency_key",
    [a?.p_id, a?.p_payload?.name, a?.p_payload?.mobile, a?.p_payload?.email],
    [CONTACT1, "陳窗口", "0912000000", "chen@example.com"],
  );
  const au = audits()[0];
  check(
    "聯絡窗口的前後值只進稽核表，伺服器 log 遮蔽（_log_redact 已處理、表內有值）",
    Boolean(au?.changes?.changes?.email),
    true,
  );
}
await expectError("推薦碼與既有重複", () =>
  H.create_referrer({ name: "x", code: "amy", dry_run: false, idempotency_key: KEY }),
);
await expectError("改推薦碼撞到別人", () =>
  H.update_referrer({ id: REF1, code: "JAY", dry_run: false }),
);
await expectError("推薦碼格式錯（同 referrerSchema）", () =>
  H.create_referrer({ name: "x", code: "中文碼", dry_run: false, idempotency_key: KEY }),
);
await expectError("級距最後一級要不設上限（同 tiersSchema）", () =>
  H.update_referral_settings({ commission_tiers: [{ up_to: 100, rate: 10 }], dry_run: false }),
);
await expectError("預設折扣超過 50%（同後台規則）", () =>
  H.update_referral_settings({ default_discount_percent: 60, dry_run: false }),
);
{
  resetDb(BASE_TABLES, BASE_RPC);
  const r = parseOut(await asOAuth(() => H.get_referral_settings({})));
  check(
    "get_referral_settings：設定與推廣者級距轉成 up_to",
    [r.settings?.commission_tiers?.[1], r.referrers?.length],
    [{ up_to: null, rate: 25 }, 2],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const ph = parseOut(await asOAuth(() => H.list_contact_phones({})));
  check("list_contact_phones 列出兩筆", ph.count, 2);
  resetDb(BASE_TABLES, BASE_RPC);
  const subs = parseOut(await asOAuth(() => H.list_vendor_submissions({})));
  check(
    "list_vendor_submissions 預設只列待審",
    subs.rows?.map((x) => x.id),
    [SUB_PENDING],
  );
  resetDb(BASE_TABLES, BASE_RPC);
  const cts = await asOAuth(() => H.list_vendor_contacts({ vendor_id: V_TAXID }));
  check("list_vendor_contacts 回傳不含識別碼／遮罩", LEAK_RE.test(cts.content[0].text), false);
  check("唯讀工具不寫任何東西", dataWrites().length + log.rpc.length, 0);
}
await expectError("聯絡電話標籤空白（同 contactPhoneSchema）", () =>
  H.update_contact_phone({ id: 1, label: " ", dry_run: false }),
);
await expectError("聯絡電話 id 不存在", () =>
  H.update_contact_phone({ id: 99, tel: "1", dry_run: false }),
);

// [7] ------------------------------------------------------------------------
console.log("\n[6b] 預覽＝寫入：confirm_args 帶回不再翻譯（審查 2026-11-15）");
process.env.GEMINI_API_KEY = "selftest-fake-key";
{
  const tr = () => globalThis.__translateCalls.length;
  const cases = [
    [
      "create_curated_theme",
      { title: "冬天", description: "冬天說明" },
      () => log.writes.find((w) => w.table === "curated_themes")?.payload,
      (pv) => pv.will_create,
    ],
    [
      "create_curated_item",
      { theme_id: "t1", name: "丙", note: "評丙", product_id: "goods-1" },
      () => log.writes.find((w) => w.table === "curated_items")?.payload,
      (pv) => pv.will_create,
    ],
    [
      "update_curated_theme",
      { id: "t2", title: "冬日（改）" },
      () => log.writes.find((w) => w.table === "curated_themes")?.payload,
      (pv) => ({ title: pv.changes.title.after }),
    ],
    [
      "update_curated_item",
      { id: 12, note: "新評語" },
      () => log.writes.find((w) => w.table === "curated_items")?.payload,
      (pv) => ({ note: pv.changes.note.after }),
    ],
  ];
  for (const [tool, args, written, expectedOf] of cases) {
    resetDb(BASE_TABLES, BASE_RPC);
    const pv = parseOut(await asOAuth(() => H[tool](args)));
    checkTrue(
      `${tool} 預覽：有 confirm_args、next_step 要求原樣帶回`,
      pv.confirm_args?.dry_run === false && /confirm_args/.test(pv.next_step),
    );
    const n = tr();
    resetDb(BASE_TABLES, BASE_RPC);
    const w = parseOut(await asOAuth(() => H[tool](pv.confirm_args)));
    const row = written();
    const exp = expectedOf(pv);
    check(
      `${tool} 帶回 confirm_args：寫入的三語＝預覽、沒有再翻譯、沒有 write_note`,
      [
        w.written,
        Object.fromEntries(
          Object.keys(exp)
            .filter((k) => ["title", "description", "name", "note"].includes(k))
            .map((k) => [k, row?.[k]]),
        ),
        tr() - n,
        w.write_note,
      ],
      [
        true,
        Object.fromEntries(
          Object.keys(exp)
            .filter((k) => ["title", "description", "name", "note"].includes(k))
            .map((k) => [k, exp[k]]),
        ),
        0,
        undefined,
      ],
    );
  }
  resetDb(BASE_TABLES, BASE_RPC);
  const raw = parseOut(
    await asOAuth(() =>
      H.create_curated_theme({
        title: "春天",
        description: "春天說明",
        dry_run: false,
        idempotency_key: crypto.randomUUID(),
      }),
    ),
  );
  checkTrue(
    "沒帶回（中文字串）：照寫但 write_note 講明寫入時才翻譯",
    raw.written && /寫入時才自動翻譯/.test(raw.write_note),
  );

  const listing = {
    slug: "red-oolong",
    title: "紅烏龍茶餅",
    summary: "s",
    description: "d",
    price: 480,
  };
  resetDb(BASE_TABLES, BASE_RPC);
  const pv = parseOut(
    await asOAuth(() =>
      H.approve_vendor_submission({ id: SUB_PENDING, decision: "approve", listing }),
    ),
  );
  check(
    "approve_vendor_submission 預覽：confirm_args.listing 帶完整三語、idempotency_key",
    [
      pv.confirm_args?.listing?.title,
      pv.confirm_args?.listing?.slug,
      pv.confirm_args?.idempotency_key === pv.idempotency_key,
      pv.confirm_args?.dry_run,
    ],
    [pv.will_list.title, "red-oolong", true, false],
  );
  const n = tr();
  resetDb(BASE_TABLES, BASE_RPC);
  await asOAuth(() => H.approve_vendor_submission(pv.confirm_args));
  const a = log.rpc.find((r) => r.name === "inv_approve_vendor_product")?.args;
  check(
    "approve_vendor_submission 帶回：RPC 收到的上架三語＝預覽、沒有再翻譯",
    [a?.p_listing?.title, a?.p_listing?.summary, a?.p_listing?.description, tr() - n],
    [pv.will_list.title, pv.will_list.summary, pv.will_list.description, 0],
  );
}
delete process.env.GEMINI_API_KEY;
for (const n of ["approve_vendor", "approve_vendor_submission"]) {
  checkTrue(
    `${n} 說明：同一位管理員可核准自己建立的、核准前先給使用者看預覽`,
    /同一位管理員可以核准自己建立的資料/.test(META[n].description) &&
      /預覽/.test(META[n].description),
  );
}

console.log("\n[7] 靜態");
const srcText = readFile(join(SRC, "server/mcp/partners-content-tools.ts"));
const code = srcText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
check(
  "自己不寫 .update(/.insert(/.delete(/.upsert(/.rpc(",
  /\.(update|insert|delete|upsert|rpc)\(/.test(code),
  false,
);
check(
  "不呼叫敏感／禁止的後台函式（readVendorSensitive、匯款、附件、入口帳號、刪除、結算）",
  code.match(
    /readVendorSensitive|saveVendorBankAccount|saveVendorAttachment|setVendorPortalAccountActive|deleteVendor|removeCurated|removeContactPhone|settleReferr/g,
  ) ?? [],
  [],
);
check("不碰 bank_ 欄位名", /bank_/.test(code), false);
const toolsSrc = readFile(join(SRC, "server/mcp/tools.ts"));
check(
  "tools.ts 有註冊這一組（import＋INPUTS＋handler）",
  [
    toolsSrc.includes('from "./partners-content-tools"'),
    toolsSrc.includes("...PARTNERS_CONTENT_TOOL_INPUTS"),
    toolsSrc.includes("[PARTNERS_CONTENT_TOOL_META, PARTNERS_CONTENT_HANDLERS as never]"),
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
