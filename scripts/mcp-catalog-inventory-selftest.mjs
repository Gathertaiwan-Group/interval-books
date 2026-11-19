#!/usr/bin/env node
/**
 * mcp-catalog-inventory-selftest.mjs —— src/server/mcp/catalog-inventory-tools.ts
 * （上架、進銷存商品修改／停用／調價、拍照辨識進貨單、整批匯入進貨、修改進貨、刊物連結進銷存）
 *
 *   [1] 形狀：三份匯出一致、寫入 dry_run 預設 true、annotations、辨識工具帶 openai/fileParams
 *   [2] 每支寫入：預覽不呼叫 RPC／不寫業務表、記 dry_run=true 稽核
 *   [3] 每支寫入：dry_run=false 才呼叫後台同一支 repo／RPC，參數形狀與後台相同，記 dry_run=false 稽核
 *   [4] 建立類：沒有 idempotency_key 拒絕、同一組 key 第二次拒絕
 *   [5] 靜態 token 一律拒絕（不寫、不辨識）；錯誤輸入回 isError
 *   [6] 辨識：圖存進私有 ocr-scans（不進 site-images）、只呼叫假的辨識（🔴 不打真的 Gemini）、不寫任何業務表
 *   [7] 靜態：這個檔案自己不寫 insert／update／delete／rpc；不呼叫任何刪除（下架／解除連結／刪商品／刪進貨）
 *
 * 用假的 supabaseAdmin（記錄 rpc、表寫入與 storage 上傳）跑 production 的 handler 與 repo 本人；
 * @/server/gemini 與 @/server/translate 換成假模組（不連外、不花錢）。
 *
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15（module.registerHooks）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/mcp-catalog-inventory-selftest.mjs";
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

// ── 假的 Supabase（資料表＋storage）──────────────────────────────────────────
const log = { rpc: [], writes: [], storage: [] };
let tables = {};
let rpcData = {};
let buckets = {};
function resetDb(t, r, b = {}) {
  tables = structuredClone(t);
  rpcData = structuredClone(r);
  buckets = {};
  for (const [name, files] of Object.entries(b)) buckets[name] = new Map(Object.entries(files));
  log.rpc = [];
  log.writes = [];
  log.storage = [];
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
    ilike: (c, v) => (
      st.filters.push((r) => String(r[c] ?? "").toLowerCase() === String(v).toLowerCase()),
      b
    ),
    neq: (c, v) => (st.filters.push((r) => r[c] !== v), b),
    in: (c, vs) => (st.filters.push((r) => vs.includes(r[c])), b),
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
function bucketApi(name) {
  const files = (buckets[name] ??= new Map());
  return {
    async upload(path, bytes, opts = {}) {
      log.storage.push({
        bucket: name,
        op: "upload",
        path,
        size: bytes.byteLength ?? bytes.length,
      });
      if (files.has(path) && !opts.upsert) return { data: null, error: { message: "exists" } };
      files.set(path, new Uint8Array(bytes));
      return { data: { path }, error: null };
    },
    async download(path) {
      log.storage.push({ bucket: name, op: "download", path });
      if (!files.has(path)) return { data: null, error: { message: "not found" } };
      return { data: new Blob([files.get(path)]), error: null };
    },
    async remove(paths) {
      for (const p of paths) files.delete(p);
      return { data: null, error: null };
    },
    getPublicUrl: (path) => ({ data: { publicUrl: `https://example.test/${name}/${path}` } }),
  };
}
globalThis.__fakeSupabase = {
  from: (t) => builder(t),
  rpc: async (name, args) => {
    log.rpc.push({ name, args });
    return { data: rpcData[name] ?? null, error: null };
  },
  storage: { from: (bucket) => bucketApi(bucket) },
};

// 假的辨識（🔴 不打真的 Gemini）與假的翻譯。
globalThis.__ocrCalls = [];
globalThis.__ocrResult = null;
globalThis.__ocrError = null;
const FAKE_GEMINI =
  "data:text/javascript," +
  encodeURIComponent(`
    export class OcrError extends Error { constructor(kind, m){ super(m); this.kind = kind; } }
    export async function recognisePurchaseOrder(input) {
      globalThis.__ocrCalls.push(input);
      if (globalThis.__ocrError) throw new OcrError(globalThis.__ocrError.kind, globalThis.__ocrError.message);
      return structuredClone(globalThis.__ocrResult);
    }
    export async function recogniseBook() { throw new Error("not used"); }
  `);
globalThis.__translateCalls = [];
const FAKE_TRANSLATE =
  "data:text/javascript," +
  encodeURIComponent(`
    export async function translateToEnJa({ text }) {
      globalThis.__translateCalls.push(text);
      return { en: "EN " + text, ja: "JA " + text };
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
const REAL_ADMIN = resolveTs(join(SRC, "server/supabase-admin"));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@/server/supabase-admin") return { url: FAKE_ADMIN, shortCircuit: true };
    if (spec === "@/server/gemini" || spec === "./gemini")
      return { url: FAKE_GEMINI, shortCircuit: true };
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
      // storage.ts 用相對路徑 import ./supabase-admin —— 一樣換成假的。
      if (url && url === REAL_ADMIN) return { url: FAKE_ADMIN, shortCircuit: true };
      if (url) return { url, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const origInfo = console.info;
console.info = () => {};
const origError = console.error;
console.error = () => {};

const MOD = await import(join(SRC, "server/mcp/catalog-inventory-tools.ts"));
const {
  CATALOG_INV_TOOL_INPUTS: INPUTS,
  CATALOG_INV_TOOL_META: META,
  CATALOG_INV_HANDLERS: H,
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
const text = (r) => r.content[0].text;
const audits = () => log.writes.filter((w) => w.table === "mcp_audit_log").map((w) => w.payload);
const dataWrites = () =>
  log.writes.filter((w) => w.table !== "mcp_audit_log" && w.table !== "mcp_oauth_used_codes");

// ── 測試資料 ──────────────────────────────────────────────────────────────
const P1 = "11111111-1111-4111-8111-111111111111"; // 可上架
const P2 = "22222222-2222-4222-8222-222222222222"; // 待審、庫存 0
const P3 = "33333333-3333-4333-8333-333333333333"; // 已上架
const CAT = "44444444-4444-4444-8444-444444444444";
const VEN = "55555555-5555-4555-8555-555555555555";
const PU1 = "66666666-6666-4666-8666-666666666666";
const IMG = "storage:77777777-7777-4777-8777-777777777777.webp";
const product = (over) => ({
  inv_product_id: P1,
  name: "地味手帖",
  issue_number: "13",
  barcode: "9789860000001",
  series: null,
  publisher: "地味出版",
  notes: null,
  image_key: IMG,
  product_type: "outright",
  selling_price: 380.4,
  cost_price: 250,
  stock_quantity: 5,
  low_stock_alert: 5,
  pack_size: 1,
  is_active: true,
  category_id: CAT,
  category_name: "雜誌",
  vendor_id: VEN,
  vendor_name: "永樂圖書",
  base_product_id: null,
  approval_status: "approved",
  pending_cost_price: null,
  pending_selling_price: null,
  price_change_status: null,
  user_id: ADMIN_ID,
  listed_product_id: null,
  listed_slug: null,
  listed_status: null,
  ...over,
});
const BASE_TABLES = {
  inv_listing_candidates: [
    {
      inv_product_id: P1,
      name: "地味手帖",
      selling_price: 380.4,
      stock_quantity: 5,
      pack_size: 1,
      barcode: "9789860000001",
    },
  ],
  inv_listed_products: [
    {
      product_id: "prod-old",
      slug: "old-thing",
      title: { zh: "舊東西", en: "Old", ja: "古い" },
      price: 100,
      status: "active",
      inv_product_id: P3,
      inv_name: "舊東西",
      units_per_sale: 1,
      stock_quantity: 3,
      reserved: 0,
      available: 3,
    },
  ],
  inv_admin_products: [
    product(),
    product({ inv_product_id: P2, name: "新書", approval_status: "pending", stock_quantity: 0 }),
    product({
      inv_product_id: P3,
      name: "舊東西",
      listed_product_id: "prod-old",
      listed_slug: "old-thing",
      listed_status: "active",
    }),
  ],
  inv_admin_categories: [{ category_id: CAT, name: "雜誌", icon: null, display_order: 1 }],
  inv_admin_vendors: [
    {
      vendor_id: VEN,
      name: "永樂圖書",
      short_name: "永樂",
      status: "active",
      approval_status: "approved",
    },
  ],
  inv_admin_approval_settings: [
    { module: "price_changes", is_enabled: true },
    { module: "purchases", is_enabled: true },
    { module: "products", is_enabled: false },
  ],
  inv_admin_purchases: [
    {
      purchase_id: PU1,
      product_id: P1,
      product_name: "地味手帖",
      item_name: "地味手帖 13",
      purchase_date: "2026-11-01",
      quantity: 10,
      remaining_quantity: 7,
      consumed_quantity: 3,
      unit_cost: 250,
      vendor_id: null,
      vendor_text: "路邊書商",
      publisher: null,
      notes: "第一批",
      expiry_date: null,
      expiry_alert_days: null,
      approval_status: "approved",
    },
  ],
  inv_pos_products: [{ name: "地味手帖", issue_number: "13", series: null }],
  products: [{ id: "prod-old", slug: "old-thing", product_type: "goods", status: "active" }],
  publications: [
    {
      id: "tw-001",
      slug: "tw-001",
      title: { zh: "地方誌", en: "Local", ja: "地方" },
      publisher: { zh: "某鎮公所", en: "Town", ja: "町" },
      intro: { zh: "介紹", en: "Intro", ja: "紹介" },
      cover_image_key: IMG,
      product_id: null,
      is_published: true,
    },
    {
      id: "tw-002",
      slug: "tw-002",
      title: { zh: "已連結", en: "Linked", ja: "済" },
      publisher: { zh: "x", en: "x", ja: "x" },
      intro: { zh: "x", en: "x", ja: "x" },
      cover_image_key: null,
      product_id: "prod-old",
      is_published: true,
    },
  ],
};
const BASE_RPC = {
  inv_save_product: { id: P1, created: false, purchase_created: false, price_change_pending: true },
  inv_set_product_active: { id: P1, name: "地味手帖", is_active: false, listed_count: 0 },
  inv_request_price_change: { id: P1, name: "地味手帖", pending: true },
  inv_save_purchase: {
    id: PU1,
    created: false,
    approval_status: "approved",
    needs_approval: false,
  },
  inv_import_purchases: {
    purchases_created: 2,
    products_created: 1,
    approval_status: "pending",
    needs_approval: true,
  },
};
const reset = (b) => resetDb(BASE_TABLES, BASE_RPC, b);
const KEY = () => crypto.randomUUID();

console.log("═══ MCP 上架／進銷存商品／拍照辨識進貨／刊物連結 自檢 ═══");

// [1] ------------------------------------------------------------------------
console.log("\n[1] 形狀");
const names = Object.keys(INPUTS).sort();
check(
  "INPUTS／META／HANDLERS 名單一致",
  [Object.keys(META).sort(), Object.keys(H).sort()],
  [names, names],
);
check("工具清單", names, [
  "create_inventory_listing",
  "import_purchases",
  "link_publication_to_inventory",
  "list_inventory_listings",
  "recognize_purchase_order",
  "request_inventory_price_change",
  "set_inventory_product_active",
  "update_inventory_product",
  "update_purchase",
]);
const WRITES = names.filter(
  (n) => META[n].annotations.readOnlyHint !== true && n !== "recognize_purchase_order",
);
for (const n of WRITES) {
  const js = z.toJSONSchema(INPUTS[n], { io: "input" });
  check(`${n}：dry_run 預設 true`, js.properties?.dry_run?.default, true);
}
check(
  "list_inventory_listings 標 readOnlyHint",
  META.list_inventory_listings.annotations.readOnlyHint,
  true,
);
check(
  "🔴 沒有任何 destructive 工具",
  names.filter((n) => META[n].annotations.destructiveHint !== false),
  [],
);
check(
  "建立類 idempotentHint=false",
  ["create_inventory_listing", "import_purchases", "link_publication_to_inventory"].map(
    (n) => META[n].annotations.idempotentHint,
  ),
  [false, false, false],
);
check(
  "recognize_purchase_order：不是唯讀（會存檔、花額度）、帶 openai/fileParams",
  [META.recognize_purchase_order.annotations.readOnlyHint, META.recognize_purchase_order._meta],
  [false, { "openai/fileParams": ["file"] }],
);
checkTrue(
  "每支說明寫明後台按鈕或 RPC",
  names.every((n) => /後台|RPC|inv_|same|同一/.test(META[n].description)),
);

// [2][3][4][5] -------------------------------------------------------------
console.log("\n[2] list_inventory_listings");
reset();
{
  const out = parseOut(await asOAuth(() => H.list_inventory_listings({})));
  check(
    "candidates／listed",
    [out.candidates.total, out.candidates.rows[0].id, out.listed.rows[0].slug],
    [1, P1, "old-thing"],
  );
  check("唯讀：沒有任何寫入", log.writes.length + log.rpc.length, 0);
  const kw = parseOut(await asOAuth(() => H.list_inventory_listings({ keyword: "舊" })));
  check("keyword 篩選", [kw.candidates.total, kw.listed.total], [0, 1]);
}

console.log("\n[3] create_inventory_listing");
reset();
{
  const r = await asOAuth(() =>
    H.create_inventory_listing({ inv_product_id: P1, summary: "日本地方生活誌" }),
  );
  const out = parseOut(r);
  check("預覽：dry_run／written", [out.dry_run, out.written], [true, false]);
  check(
    "預覽：價格＝進銷存售價四捨五入、預設草稿、沿用進銷存照片",
    [
      out.will_create.price,
      out.will_create.status,
      out.will_create.image_key,
      out.will_create.units_per_sale,
      out.will_create.product_type,
    ],
    [380, "draft", IMG, 1, "goods"],
  );
  check("預覽：標題預設進銷存品名、翻譯補英日", out.will_create.title, {
    zh: "地味手帖",
    en: "EN 地味手帖",
    ja: "JA 地味手帖",
  });
  checkTrue("預覽：代稱自動由英文產生", /^en/.test(out.will_create.slug));
  checkTrue("預覽：給 idempotency_key", /^[0-9a-f-]{36}$/.test(out.idempotency_key));
  check("預覽：不寫業務表、不呼叫 RPC", [dataWrites().length, log.rpc.length], [0, 0]);
  check(
    "預覽：記一筆 dry_run=true 稽核",
    audits().map((a) => [a.tool, a.dry_run]),
    [["create_inventory_listing", true]],
  );

  // 審查 2026-11-15：預覽＝寫入。confirm_args 帶回 → 不再翻譯、代稱不再產生，寫入的就是預覽那一份。
  check(
    "預覽：confirm_args 帶完整三語、定案代稱、idempotency_key、dry_run=false",
    [
      out.confirm_args.title,
      out.confirm_args.summary,
      out.confirm_args.slug === out.will_create.slug,
      out.confirm_args.idempotency_key === out.idempotency_key,
      out.confirm_args.dry_run,
    ],
    [
      { zh: "地味手帖", en: "EN 地味手帖", ja: "JA 地味手帖" },
      { zh: "日本地方生活誌", en: "EN 日本地方生活誌", ja: "JA 日本地方生活誌" },
      true,
      true,
      false,
    ],
  );
  checkTrue("預覽：next_step 要求原樣帶回 confirm_args", /confirm_args/.test(out.next_step));
  checkTrue(
    "預覽：confirm_args 通過工具自己的 schema",
    INPUTS.create_inventory_listing.safeParse(out.confirm_args).success,
  );
  reset();
  globalThis.__translateCalls = [];
  const locked = parseOut(await asOAuth(() => H.create_inventory_listing(out.confirm_args)));
  const lockedIns = dataWrites().find((w) => w.table === "products");
  check(
    "帶回 confirm_args：寫入的三語與代稱＝預覽、沒有呼叫翻譯、沒有 write_note",
    [
      locked.written,
      locked.slug,
      lockedIns?.payload?.slug,
      lockedIns?.payload?.title,
      lockedIns?.payload?.summary,
      globalThis.__translateCalls.length,
      locked.write_note,
    ],
    [
      true,
      out.will_create.slug,
      out.will_create.slug,
      out.will_create.title,
      out.will_create.summary,
      0,
      undefined,
    ],
  );
  reset();
  globalThis.__translateCalls = [];
  const unlocked = parseOut(
    await asOAuth(() =>
      H.create_inventory_listing({
        inv_product_id: P1,
        summary: "日本地方生活誌",
        idempotency_key: KEY(),
        dry_run: false,
      }),
    ),
  );
  checkTrue(
    "沒帶回（中文字串、沒 slug）：照寫，但 write_note 明講寫入時才翻譯／才產生代稱",
    unlocked.written &&
      globalThis.__translateCalls.length > 0 &&
      /寫入時才自動翻譯/.test(unlocked.write_note) &&
      /寫入時才產生/.test(unlocked.write_note),
  );

  reset();
  const noKey = await asOAuth(() =>
    H.create_inventory_listing({ inv_product_id: P1, summary: "x", dry_run: false }),
  );
  checkTrue(
    "dry_run=false 沒有 idempotency_key → isError",
    noKey.isError && /idempotency_key/.test(text(noKey)),
  );
  check("沒 key：不寫", dataWrites().length, 0);

  reset();
  const key = KEY();
  const args = {
    inv_product_id: P1,
    title: { zh: "地味手帖 13", en: "Jimi 13", ja: "地味 13" },
    summary: { zh: "摘要", en: "Summary", ja: "要約" },
    slug: "jimi-13",
    price: 400,
    status: "active",
    product_type: "book",
    idempotency_key: key,
    dry_run: false,
  };
  const ok = parseOut(await asOAuth(() => H.create_inventory_listing(args)));
  check(
    "寫入：written",
    [ok.dry_run, ok.written, ok.slug, ok.status],
    [false, true, "jimi-13", "active"],
  );
  const ins = dataWrites();
  check(
    "寫入：products insert（stock=null、狀態、價格）→ product_inventory_links insert",
    [
      ins.map((w) => [w.table, w.op]),
      ins[0]?.payload?.stock,
      ins[0]?.payload?.status,
      ins[0]?.payload?.price,
      ins[0]?.payload?.product_type,
      ins[1]?.payload?.inv_product_id,
      ins[1]?.payload?.units_per_sale,
    ],
    [
      [
        ["products", "insert"],
        ["product_inventory_links", "insert"],
      ],
      null,
      "active",
      400,
      "book",
      P1,
      1,
    ],
  );
  check(
    "寫入：沒有翻譯呼叫（三語都給了）",
    globalThis.__translateCalls.filter((t) => t === "地味手帖 13").length,
    0,
  );
  check(
    "寫入：記一筆 dry_run=false 稽核",
    audits()
      .filter((a) => !a.dry_run)
      .map((a) => a.tool),
    ["create_inventory_listing"],
  );
  const again = await asOAuth(() => H.create_inventory_listing(args));
  checkTrue(
    "同一組 idempotency_key 第二次 → isError",
    again.isError && /已經送出過/.test(text(again)),
  );
  check("第二次：沒有再寫", dataWrites().filter((w) => w.table === "products").length, 1);

  reset();
  const notCand = await asOAuth(() =>
    H.create_inventory_listing({ inv_product_id: P2, summary: "x" }),
  );
  checkTrue(
    "不在可上架清單（待審、庫存 0）→ isError 並說明原因",
    notCand.isError && /還沒核准/.test(text(notCand)) && /庫存是 0/.test(text(notCand)),
  );
  const listedAlready = await asOAuth(() =>
    H.create_inventory_listing({ inv_product_id: P3, summary: "x" }),
  );
  checkTrue("已上架過 → isError", listedAlready.isError && /已經上架過/.test(text(listedAlready)));
  const slugTaken = await asOAuth(() =>
    H.create_inventory_listing({ inv_product_id: P1, summary: "x", slug: "old-thing" }),
  );
  checkTrue("代稱已被使用 → isError", slugTaken.isError && /已經被使用/.test(text(slugTaken)));
  const badImg = await asOAuth(() =>
    H.create_inventory_listing({
      inv_product_id: P1,
      summary: "x",
      image_key: "https://evil.example/a.png",
    }),
  );
  checkTrue("外部圖片網址 → isError", badImg.isError);
  check("以上錯誤都沒有寫業務表", dataWrites().length, 0);

  reset();
  const st = await asStatic(() => H.create_inventory_listing({ inv_product_id: P1, summary: "x" }));
  checkTrue("靜態 token → isError（需要 OAuth）", st.isError && /OAuth/.test(text(st)));
  check("靜態 token：不寫、不記", [dataWrites().length, audits().length], [0, 0]);
}

console.log("\n[4] update_inventory_product");
reset();
{
  const out = parseOut(
    await asOAuth(() =>
      H.update_inventory_product({ id: P1, name: "地味手帖（新版）", selling_price: 420 }),
    ),
  );
  check("預覽：只列有變的欄位", Object.keys(out.changes).sort(), ["name", "selling_price"]);
  checkTrue(
    "預覽：調價審核開著 → 提醒待審",
    (out.notes ?? []).some((n) => /待審/.test(n)),
  );
  check("預覽：不呼叫 RPC", log.rpc.length, 0);
  check(
    "預覽：稽核 dry_run=true",
    audits().map((a) => a.dry_run),
    [true],
  );

  reset();
  const ok = parseOut(
    await asOAuth(() =>
      H.update_inventory_product({
        id: P1,
        name: "地味手帖（新版）",
        selling_price: 420,
        notes: null,
        dry_run: false,
      }),
    ),
  );
  const call = log.rpc.find((c) => c.name === "inv_save_product");
  check(
    "寫入：inv_save_product（操作人員、p_id、purchase=null）",
    [call?.args.p_user_id, call?.args.p_id, call?.args.p_purchase],
    [ADMIN_ID, P1, null],
  );
  check(
    "寫入：整列送出、沒改的欄位保留原值（同後台編輯表單）",
    [
      call?.args.p_payload.name,
      call?.args.p_payload.selling_price,
      call?.args.p_payload.cost_price,
      call?.args.p_payload.barcode,
      call?.args.p_payload.category_id,
      call?.args.p_payload.image_key,
      call?.args.p_payload.issue_number,
      "id" in (call?.args.p_payload ?? {}),
      "purchase" in (call?.args.p_payload ?? {}),
    ],
    ["地味手帖（新版）", 420, 250, "9789860000001", CAT, IMG, "13", false, false],
  );
  check("寫入：回報 price_change_pending", ok.price_change_pending, true);
  check("寫入：沒有直接寫表", dataWrites().length, 0);

  reset();
  const same = parseOut(
    await asOAuth(() => H.update_inventory_product({ id: P1, name: "地味手帖", dry_run: false })),
  );
  check("沒有改變 → 不呼叫 RPC", [same.written, log.rpc.length], [false, 0]);
  const empty = await asOAuth(() => H.update_inventory_product({ id: P1 }));
  checkTrue("沒有任何欄位 → isError", empty.isError);
  const self = await asOAuth(() => H.update_inventory_product({ id: P1, base_product_id: P1 }));
  checkTrue("母品項是自己 → isError", self.isError);
  const missing = await asOAuth(() =>
    H.update_inventory_product({ id: "99999999-9999-4999-8999-999999999999", name: "x" }),
  );
  checkTrue("找不到商品 → isError", missing.isError && /找不到/.test(text(missing)));
  const st = await asStatic(() =>
    H.update_inventory_product({ id: P1, name: "x", dry_run: false }),
  );
  checkTrue("靜態 token → isError", st.isError);
  check("以上都沒有呼叫 RPC", log.rpc.length, 0);
}

console.log("\n[4b] update_inventory_product：不限庫存（0062）");
reset();
{
  // 買斷品不能開：schema 先擋（資料庫另有 CHECK），不呼叫 RPC。
  const bad = await asOAuth(() => H.update_inventory_product({ id: P1, unlimited_stock: true }));
  checkTrue("買斷品開不限庫存 → isError（只限寄賣）", bad.isError && /寄賣/.test(text(bad)));
  check("買斷品：不呼叫 RPC", log.rpc.length, 0);

  // 寄賣品：預覽列出 unlimited_stock 這一欄的變更；寫入時整列送出、旗標為 true。
  tables.inv_admin_products = tables.inv_admin_products.map((r) =>
    r.inv_product_id === P1 ? { ...r, product_type: "consignment", unlimited_stock: false } : r,
  );
  const pv = parseOut(
    await asOAuth(() => H.update_inventory_product({ id: P1, unlimited_stock: true })),
  );
  check("寄賣品預覽：只列 unlimited_stock", Object.keys(pv.changes ?? {}), ["unlimited_stock"]);
  check("寄賣品預覽：不呼叫 RPC", log.rpc.length, 0);
  await asOAuth(() =>
    H.update_inventory_product({ id: P1, unlimited_stock: true, dry_run: false }),
  );
  const call = log.rpc.find((c) => c.name === "inv_save_product");
  check(
    "寄賣品寫入：inv_save_product 帶 unlimited_stock=true、類型不變",
    [call?.args.p_payload.unlimited_stock, call?.args.p_payload.product_type],
    [true, "consignment"],
  );

  // 沒帶 unlimited_stock 的修改：送出原值（false），不會意外打開或關掉。
  reset();
  await asOAuth(() =>
    H.update_inventory_product({ id: P1, name: "地味手帖（新版）", dry_run: false }),
  );
  const keep = log.rpc.find((c) => c.name === "inv_save_product");
  check("沒帶旗標：送出原值 false", keep?.args.p_payload.unlimited_stock, false);
}

console.log("\n[5] set_inventory_product_active／request_inventory_price_change");
reset();
{
  const pv = parseOut(
    await asOAuth(() => H.set_inventory_product_active({ id: P3, is_active: false })),
  );
  checkTrue(
    "停用預覽：已上架 → 提醒用 update_shop_product 下架",
    /update_shop_product/.test(pv.warning ?? ""),
  );
  check("停用預覽：不呼叫 RPC", log.rpc.length, 0);
  const ok = parseOut(
    await asOAuth(() =>
      H.set_inventory_product_active({ id: P1, is_active: false, dry_run: false }),
    ),
  );
  check(
    "停用寫入：inv_set_product_active 參數",
    log.rpc.map((c) => [c.name, c.args.p_user_id, c.args.p_id, c.args.p_is_active]),
    [["inv_set_product_active", ADMIN_ID, P1, false]],
  );
  check("停用寫入：written", ok.written, true);
  reset();
  const same = parseOut(
    await asOAuth(() =>
      H.set_inventory_product_active({ id: P1, is_active: true, dry_run: false }),
    ),
  );
  check("已經是啟用 → 不呼叫 RPC", [same.written, log.rpc.length], [false, 0]);

  reset();
  const pp = parseOut(
    await asOAuth(() => H.request_inventory_price_change({ id: P1, selling_price: 450 })),
  );
  check(
    "調價預覽：前後與效果",
    [pp.change.selling_price, pp.change.cost_price.after, /待審/.test(pp.effect)],
    [{ before: 380.4, after: 450 }, 250, true],
  );
  check("調價預覽：不呼叫 RPC", log.rpc.length, 0);
  await asOAuth(() =>
    H.request_inventory_price_change({ id: P1, selling_price: 450, dry_run: false }),
  );
  check(
    "調價寫入：inv_request_price_change（成本省略＝null＝維持）",
    log.rpc.map((c) => [
      c.name,
      c.args.p_user_id,
      c.args.p_id,
      c.args.p_cost_price,
      c.args.p_selling_price,
    ]),
    [["inv_request_price_change", ADMIN_ID, P1, null, 450]],
  );
  const neg = await asOAuth(() => H.request_inventory_price_change({ id: P1, selling_price: -1 }));
  checkTrue("負價 → isError", neg.isError);
  const st = await asStatic(() =>
    H.request_inventory_price_change({ id: P1, selling_price: 1, dry_run: false }),
  );
  checkTrue("靜態 token → isError", st.isError);
  check("RPC 只有那一次", log.rpc.length, 1);
}

console.log("\n[6] recognize_purchase_order（假的辨識）");
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
// confirm 預設 false（審查 2026-11-15）：只檢查參數，不上傳、不辨識、不下載、不消耗 upload_id。
reset();
globalThis.__ocrCalls = [];
{
  const pre = parseOut(
    await asOAuth(() => H.recognize_purchase_order({ image_base64: { data: PNG_B64 } })),
  );
  check(
    "confirm 省略：預覽，不上傳、不辨識",
    [pre.dry_run, pre.uploaded, pre.recognised, pre.source, pre.format],
    [true, false, false, "base64", "png"],
  );
  checkTrue(
    "confirm 省略：說明會花辨識額度、要 confirm=true",
    /額度/.test(pre.will_do.join("")) && /confirm=true/.test(pre.next_step),
  );
  check(
    "confirm 省略：storage 沒有任何動作、辨識 0 次",
    [log.storage.length, globalThis.__ocrCalls.length],
    [0, 0],
  );
  check(
    "confirm 省略：稽核記一筆 dry_run=true 的 recognise_preview",
    audits().map((a) => [a.action, a.dry_run]),
    [["recognise_preview", true]],
  );
  check(
    "confirm 省略：schema 預設 false",
    INPUTS.recognize_purchase_order.parse({
      scan_key: "ocr:2026-11-15/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png",
    }).confirm,
    false,
  );
  reset();
  const uploadId = `${Math.floor(Date.now() / 1000)}-${crypto.randomUUID()}.png`;
  buckets["mcp-image-uploads"] = new Map([
    [uploadId, new Uint8Array(Buffer.from(PNG_B64, "base64"))],
  ]);
  const preUp = parseOut(await asOAuth(() => H.recognize_purchase_order({ upload_id: uploadId })));
  check(
    "confirm 省略（upload_id）：暫存檔沒被搬走、沒有任何 storage 動作",
    [preUp.uploaded, log.storage.length, buckets["mcp-image-uploads"].get(uploadId).byteLength > 0],
    [false, 0, true],
  );
  const preUrl = parseOut(
    await asOAuth(() => H.recognize_purchase_order({ image_url: "https://example.com/a.png" })),
  );
  check(
    "confirm 省略（image_url）：不下載",
    [preUrl.uploaded, preUrl.host, log.storage.length],
    [false, "example.com", 0],
  );
  const preBad = await asOAuth(() =>
    H.recognize_purchase_order({
      image_base64: { data: Buffer.from("<html>hi</html>").toString("base64") },
    }),
  );
  checkTrue("confirm 省略：不是圖片照樣 isError", preBad.isError);
  check("confirm 省略：辨識 0 次", globalThis.__ocrCalls.length, 0);
}

const OCR_RESULT = {
  vendor: "永樂圖書",
  purchase_date: "2026-11-14",
  notes: null,
  items: [
    { name: "地味手帖", issue_number: "13", series: null, quantity: 5, unit_cost: 240 },
    { name: "完全沒看過的書", issue_number: null, series: null, quantity: 2, unit_cost: 100 },
  ],
};
reset();
globalThis.__ocrResult = OCR_RESULT;
globalThis.__ocrCalls = [];
{
  const out = parseOut(
    await asOAuth(() =>
      H.recognize_purchase_order({
        image_base64: { data: `data:image/png;base64,${PNG_B64}` },
        confirm: true,
      }),
    ),
  );
  checkTrue(
    "回傳 scan_key（ocr:…）",
    /^ocr:\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.png$/.test(out.scan_key),
  );
  check(
    "🔴 圖存進私有 ocr-scans、沒有進 site-images",
    log.storage.filter((s) => s.op === "upload").map((s) => s.bucket),
    ["ocr-scans"],
  );
  check(
    "辨識只呼叫一次，帶同一個 scan_key 與已知商品提示",
    [
      globalThis.__ocrCalls.length,
      globalThis.__ocrCalls[0]?.scanKey === out.scan_key,
      globalThis.__ocrCalls[0]?.knownProducts?.[0]?.name,
    ],
    [1, true, "地味手帖"],
  );
  check(
    "第一列對到既有商品（期數一致）、第二列對不到",
    [out.items[0].matched_product?.id, out.items[1].matched_product],
    [P1, null],
  );
  check("廠商對到名單", out.recognised.vendor_match, { id: VEN, name: "永樂圖書" });
  check(
    "suggested_import 可直接交給 import_purchases",
    [
      out.suggested_import.rows.map((r) => r.product_id),
      out.suggested_import.vendor_id,
      out.suggested_import.purchase_date,
      out.suggested_import.scan_key === out.scan_key,
      INPUTS.import_purchases.safeParse(out.suggested_import).success,
    ],
    [[P1, null], VEN, "2026-11-14", true, true],
  );
  check("🔴 不寫任何業務表、不呼叫 RPC", [dataWrites().length, log.rpc.length], [0, 0]);
  check(
    "稽核：一筆 recognise（不含圖片內容）",
    audits().map((a) => [
      a.tool,
      a.action,
      a.dry_run,
      JSON.stringify(a.changes).includes(PNG_B64.slice(0, 20)),
    ]),
    [["recognize_purchase_order", "recognise", false, false]],
  );

  reset();
  globalThis.__ocrCalls = [];
  const again = parseOut(
    await asOAuth(() => H.recognize_purchase_order({ scan_key: out.scan_key, confirm: true })),
  );
  check(
    "scan_key 重新辨識：不重傳圖",
    [again.scan_key, log.storage.length, globalThis.__ocrCalls.length],
    [out.scan_key, 0, 1],
  );

  // create_image_upload_url 那條：暫存檔 → ocr-scans（不進 site-images）
  reset();
  const uploadId = `${Math.floor(Date.now() / 1000)}-${crypto.randomUUID()}.png`;
  buckets["mcp-image-uploads"] = new Map([
    [uploadId, new Uint8Array(Buffer.from(PNG_B64, "base64"))],
  ]);
  const viaUpload = parseOut(
    await asOAuth(() => H.recognize_purchase_order({ upload_id: uploadId, confirm: true })),
  );
  checkTrue("upload_id：辨識成功", /^ocr:/.test(viaUpload.scan_key));
  check(
    "upload_id：存進 ocr-scans、沒有 site-images",
    [...new Set(log.storage.filter((s) => s.op === "upload").map((s) => s.bucket))].sort(),
    ["mcp-image-uploads", "ocr-scans"],
  );
  check("upload_id：暫存檔寫成墓碑", buckets["mcp-image-uploads"].get(uploadId).byteLength, 0);

  reset();
  globalThis.__ocrError = { kind: "timeout", message: "逾時" };
  const failed = await asOAuth(() =>
    H.recognize_purchase_order({ image_base64: { data: PNG_B64 }, confirm: true }),
  );
  checkTrue(
    "辨識失敗 → isError，並給 scan_key 可重試",
    failed.isError && /timeout/.test(text(failed)) && /scan_key/.test(text(failed)),
  );
  check(
    "辨識失敗也記稽核",
    audits().map((a) => a.action),
    ["recognise_failed"],
  );
  globalThis.__ocrError = null;

  reset();
  globalThis.__ocrCalls = [];
  const two = await asOAuth(() =>
    H.recognize_purchase_order({ image_base64: { data: PNG_B64 }, scan_key: out.scan_key }),
  );
  checkTrue("給兩種圖片來源 → isError", two.isError);
  const none = await asOAuth(() => H.recognize_purchase_order({}));
  checkTrue("沒給圖 → isError", none.isError);
  const notImg = await asOAuth(() =>
    H.recognize_purchase_order({
      image_base64: { data: Buffer.from("<html>hi</html>").toString("base64") },
    }),
  );
  checkTrue("不是圖片 → isError", notImg.isError);
  const st = await asStatic(() => H.recognize_purchase_order({ image_base64: { data: PNG_B64 } }));
  checkTrue("靜態 token → isError", st.isError && /OAuth/.test(text(st)));
  check("以上都沒有存檔、沒有辨識", [log.storage.length, globalThis.__ocrCalls.length], [0, 0]);
}

console.log("\n[7] import_purchases");
reset();
{
  const base = {
    rows: [
      { product_id: P1, name: "地味手帖", issue_number: "13", quantity: 5, unit_cost: 240 },
      { name: "完全沒看過的書", quantity: 2, unit_cost: 100 },
    ],
    vendor_id: VEN,
    purchase_date: "2026-11-14",
    scan_key: "ocr:2026-11-15/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png",
  };
  const out = parseOut(await asOAuth(() => H.import_purchases(base)));
  check(
    "預覽：每列去向（指定／新建）",
    out.will_create.purchases.map((l) => l.product.id ?? (l.product.new_product ? "NEW" : "?")),
    [P1, "NEW"],
  );
  check("預覽：合計", [out.will_create.total_quantity, out.will_create.total_cost], [7, 1400]);
  checkTrue(
    "預覽：警告會新建商品（售價 0）",
    (out.warnings ?? []).some((w) => /新建商品/.test(w)),
  );
  check("預覽：不呼叫 RPC、不寫表", [log.rpc.length, dataWrites().length], [0, 0]);
  check(
    "預覽：稽核 dry_run=true、記 scan_key",
    audits().map((a) => [a.dry_run, a.changes.scan_key]),
    [[true, base.scan_key]],
  );

  reset();
  const noKey = await asOAuth(() => H.import_purchases({ ...base, dry_run: false }));
  checkTrue("沒有 idempotency_key → isError", noKey.isError);
  const key = KEY();
  const ok = parseOut(
    await asOAuth(() => H.import_purchases({ ...base, idempotency_key: key, dry_run: false })),
  );
  const call = log.rpc.find((c) => c.name === "inv_import_purchases");
  check(
    "寫入：inv_import_purchases（操作人員、整批）",
    [call?.args.p_user_id, call?.args.p_rows.length],
    [ADMIN_ID, 2],
  );
  check("寫入：每列形狀與後台拍照辨識確認表相同", call?.args.p_rows[1], {
    product_id: null,
    name: "完全沒看過的書",
    issue_number: null,
    series: null,
    barcode: null,
    quantity: 2,
    unit_cost: 100,
    vendor_id: VEN,
    vendor: null,
    purchase_date: "2026-11-14",
    notes: null,
    expiry_date: null,
    expiry_alert_days: null,
    product_type: null,
    category_id: null,
  });
  check("寫入：options", call?.args.p_options, {
    default_vendor_id: VEN,
    default_category_id: null,
    default_purchase_date: "2026-11-14",
    default_expiry_alert_days: null,
  });
  check(
    "寫入：回報結果與下一步",
    [ok.written, ok.result.purchases_created, /approve_inventory_record/.test(ok.next_step)],
    [true, 2, true],
  );
  const again = await asOAuth(() =>
    H.import_purchases({ ...base, idempotency_key: key, dry_run: false }),
  );
  checkTrue("同一組 key 第二次 → isError", again.isError);
  check("只匯入一次", log.rpc.filter((c) => c.name === "inv_import_purchases").length, 1);

  reset();
  const both = await asOAuth(() => H.import_purchases({ ...base, vendor: "x" }));
  checkTrue("vendor_id 與 vendor 同時給 → isError", both.isError);
  const badProd = await asOAuth(() =>
    H.import_purchases({
      rows: [{ product_id: "99999999-9999-4999-8999-999999999999", name: "x", quantity: 1 }],
    }),
  );
  checkTrue("指定的商品不存在 → isError", badProd.isError);
  const zero = await asOAuth(() => H.import_purchases({ rows: [{ name: "x", quantity: 0 }] }));
  checkTrue("數量 0 → isError", zero.isError);
  const st = await asStatic(() =>
    H.import_purchases({ ...base, idempotency_key: KEY(), dry_run: false }),
  );
  checkTrue("靜態 token → isError", st.isError);
  check("以上都沒有呼叫 RPC", log.rpc.length, 0);
}

console.log("\n[8] update_purchase");
reset();
{
  const out = parseOut(
    await asOAuth(() => H.update_purchase({ id: PU1, quantity: 12, unit_cost: 260 })),
  );
  check("預覽：只列有變的欄位", Object.keys(out.changes).sort(), ["quantity", "unit_cost"]);
  checkTrue(
    "預覽：已核准改數量 → 提醒庫存跟著調整",
    (out.warnings ?? []).some((w) => /庫存/.test(w)),
  );
  check("預覽：不呼叫 RPC", log.rpc.length, 0);
  await asOAuth(() => H.update_purchase({ id: PU1, quantity: 12, dry_run: false }));
  const call = log.rpc.find((c) => c.name === "inv_save_purchase");
  check(
    "寫入：inv_save_purchase（操作人員、p_id）",
    [call?.args.p_user_id, call?.args.p_id],
    [ADMIN_ID, PU1],
  );
  check(
    "寫入：編輯不送 product_id、沒改的欄位保留（vendor 取自 vendor_text）",
    [
      "product_id" in (call?.args.p_payload ?? {}),
      call?.args.p_payload.quantity,
      call?.args.p_payload.vendor,
      call?.args.p_payload.notes,
      call?.args.p_payload.item_name,
      call?.args.p_payload.purchase_date,
    ],
    [false, 12, "路邊書商", "第一批", "地味手帖 13", "2026-11-01"],
  );
  reset();
  const below = await asOAuth(() => H.update_purchase({ id: PU1, quantity: 2, dry_run: false }));
  checkTrue("改成少於已賣掉的件數 → isError", below.isError && /已經賣掉 3 件/.test(text(below)));
  const same = parseOut(
    await asOAuth(() => H.update_purchase({ id: PU1, quantity: 10, dry_run: false })),
  );
  check("沒有改變 → 不寫", same.written, false);
  const st = await asStatic(() => H.update_purchase({ id: PU1, quantity: 11, dry_run: false }));
  checkTrue("靜態 token → isError", st.isError);
  check("以上都沒有呼叫 RPC", log.rpc.length, 0);
}

console.log("\n[9] link_publication_to_inventory");
reset();
{
  const out = parseOut(
    await asOAuth(() =>
      H.link_publication_to_inventory({ publication_id: "tw-001", inv_product_id: P1 }),
    ),
  );
  check(
    "預覽：代稱 pub-<slug>、書、價格四捨五入、封面沿用",
    [
      out.will_create.product.slug,
      out.will_create.product.product_type,
      out.will_create.product.price,
      out.will_create.product.image_key,
    ],
    ["pub-tw-001", "book", 380, IMG],
  );
  check("預覽：不寫", dataWrites().length, 0);
  reset();
  const key = KEY();
  const ok = parseOut(
    await asOAuth(() =>
      H.link_publication_to_inventory({
        publication_id: "tw-001",
        inv_product_id: P1,
        price: 350,
        idempotency_key: key,
        dry_run: false,
      }),
    ),
  );
  const w = dataWrites();
  check(
    "寫入：products insert → links insert → publications update",
    w.map((x) => [x.table, x.op]),
    [
      ["products", "insert"],
      ["product_inventory_links", "insert"],
      ["publications", "update"],
    ],
  );
  check(
    "寫入：網站商品內容來自刊物",
    [
      w[0].payload.slug,
      w[0].payload.price,
      w[0].payload.status,
      w[0].payload.title.zh,
      w[2].payload.product_id === ok.product_id,
    ],
    ["pub-tw-001", 350, "active", "地方誌", true],
  );
  reset();
  const linked = await asOAuth(() =>
    H.link_publication_to_inventory({ publication_id: "tw-002", inv_product_id: P1 }),
  );
  checkTrue("已連結的刊物 → isError", linked.isError && /已經連到/.test(text(linked)));
  const zeroPrice = await asOAuth(() =>
    H.link_publication_to_inventory({ publication_id: "tw-001", inv_product_id: P1, price: 0 }),
  );
  checkTrue("價格 0 → isError", zeroPrice.isError);
  const notCand = await asOAuth(() =>
    H.link_publication_to_inventory({ publication_id: "tw-001", inv_product_id: P2 }),
  );
  checkTrue("不可上架的商品 → isError", notCand.isError);
  const st = await asStatic(() =>
    H.link_publication_to_inventory({
      publication_id: "tw-001",
      inv_product_id: P1,
      idempotency_key: KEY(),
      dry_run: false,
    }),
  );
  checkTrue("靜態 token → isError", st.isError);
  check("以上都沒有寫", dataWrites().length, 0);
}

console.log("\n[10] 靜態檢查");
{
  const src = readFileSync(join(SRC, "server/mcp/catalog-inventory-tools.ts"), "utf8");
  const code = src.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
  check(
    "🔴 自己不寫 insert／update／upsert／delete／rpc",
    code.match(/\.(insert|update|upsert|delete|rpc)\(/g) ?? [],
    [],
  );
  check(
    "🔴 不呼叫任何刪除（下架、解除連結、刪商品、刪進貨）",
    code.match(
      /removeInventoryListing|unlinkPublication|deleteProduct|deletePurchase|deleteSiteImage/g,
    ) ?? [],
    [],
  );
  checkTrue("🔴 不直接呼叫辨識服務的網址", !/generativelanguage|fetch\(/.test(code));
  checkTrue(
    "🔴 辨識的圖不進公開 site-images（不呼叫 storeSiteImageBytes／uploadSiteImage）",
    !/storeSiteImageBytes|uploadSiteImage/.test(code),
  );
}

console.info = origInfo;
console.error = origError;
console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
