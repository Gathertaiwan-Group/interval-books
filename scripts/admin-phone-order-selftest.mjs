#!/usr/bin/env node
/**
 * admin-phone-order-selftest.mjs —— 後台「新增電話報名」（0050）的自檢
 *
 *   [靜態] 兩支 server fn 都掛 adminFnMiddleware、建立者只認 context.admin.userId、
 *          「已收到匯款」走 admin_mark_order_paid()（markOrderPaidByAdmin）、migration 0050
 *          的三個關鍵條件（expire 跳過 admin_phone、兩支 enqueue 擋 notify_customer）。
 *   [動態] 驅動**產線本人**的 createAdminPhoneOrder() → createOrder()，資料庫換成假的
 *          query builder（同 session-ended-checkout-selftest.mjs 的做法）：
 *            已收款／未收款／免費招待／手動改價（合法、太高、沒原因）／名額不足／
 *            已開始的場次／重複送出／前台結帳的 insert 形狀沒變。
 *   [純函式] phone-order.ts 的 schema、試算、payload；店家通知信標「後台電話報名」。
 *
 * 寫入路徑在**真的資料庫**上的驗證（占名額、paid、invoice_backlog、不被逾期取消、
 * 不勾寄信就沒有客人信）是在正式庫單一交易內 begin → 呼叫 → 檢查 → rollback 做的，
 * 見那次提交的回報；這支測試不連資料庫，CI 上永遠會跑。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function check(label, actual, expected) {
  const ok =
    typeof expected === "object" && expected !== null
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : Object.is(actual, expected);
  if (ok) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
  }
}
const checkTrue = (label, v) => check(label, Boolean(v), true);

/** 檔案不存在＝丟例外，不回空字串（否則否定斷言會靜默通過；見 run-selftests.mjs 守門 4）。 */
const readFile = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const stripSqlComments = (src) => src.replace(/^[ \t]*--.*$/gm, "");

// =============================================================================
console.log("\n[1] 🔴 靜態：授權、建立者、標記已收款走既有 RPC");
{
  const fns = stripComments(readFile("src/lib/admin/fns/phone-orders.ts"));
  const serverFns = (fns.match(/createServerFn\(/g) ?? []).length;
  // 0050 兩支（選項、建單）＋0051 兩支（讀／改聯絡資料）。
  check("fns/phone-orders.ts 有四支 server fn", serverFns, 4);
  check(
    "🔴 每一支都 .middleware([adminFnMiddleware])",
    (fns.match(/\.middleware\(\[adminFnMiddleware\]\)/g) ?? []).length,
    serverFns,
  );
  checkTrue("建立者只認 context.admin.userId", /actorId: context\.admin\.userId/.test(fns));
  checkTrue(
    "「已收到匯款」呼叫 markOrderPaidByAdmin（＝admin_mark_order_paid，與前台匯款單同一支）",
    /markOrderPaidByAdmin\(/.test(fns),
  );
  checkTrue("標記成功（marked）才觸發付款成功通知", /result\.reason === "marked"/.test(fns));

  const lib = stripComments(readFile("src/lib/admin/phone-order.ts"));
  checkTrue(
    "🔴 表單 schema 沒有 actorId／createdBy 欄位",
    !/actorId|createdBy|created_by/.test(lib),
  );
  checkTrue("寄信勾選是必填 boolean（沒有預設 true）", /notifyCustomer: z\.boolean\(\)/.test(lib));

  const mw = stripComments(readFile("src/lib/admin/middleware.ts"));
  checkTrue("adminFnMiddleware 呼叫 requireAdmin()", /requireAdmin\(\)/.test(mw));
  const start = stripComments(readFile("src/start.ts"));
  checkTrue(
    "CSRF：全域 createCsrfMiddleware 套在所有 server fn",
    /createCsrfMiddleware\(/.test(start) && /handlerType === "serverFn"/.test(start),
  );

  const route = readFile("src/routes/admin/_shell.orders_.new.tsx");
  checkTrue("新增頁在 src/routes/admin/ 裡（check-meta 不把它當公開頁）", route.length > 200);
  const form = stripComments(readFile("src/components/admin/PhoneOrderForm.tsx"));
  checkTrue("新增頁用 AdminDetailPage", /<AdminDetailPage/.test(form));
  checkTrue("新增頁用 UnsavedChangesGuard", /useUnsavedChangesGuard\(/.test(form));
  checkTrue(
    "寄信勾選預設不勾",
    /useState\(false\);\s*$/m.test(
      form.split("notifyCustomer, setNotifyCustomer] = ")[1]?.split("\n")[0] ?? "",
    ),
  );

  const sql = stripSqlComments(readFile("supabase/migrations/0050_admin_phone_orders.sql"));
  checkTrue("0050：orders.source default 'web'", /source text not null default 'web'/.test(sql));
  checkTrue(
    "0050：notify_customer default true＋前台訂單不可關（CHECK）",
    /notify_customer boolean not null default true/.test(sql) &&
      /check \(notify_customer or source = 'admin_phone'\)/.test(sql),
  );
  checkTrue(
    "0050：expire_unpaid_orders 跳過 admin_phone",
    /and o\.source <> 'admin_phone'/.test(sql),
  );
  check(
    "0050：兩支 enqueue 都加了 o.notify_customer",
    (sql.match(/and o\.notify_customer/g) ?? []).length,
    2,
  );
  checkTrue("0050：沒有碰 admin_mark_order_paid", !/admin_mark_order_paid/.test(sql));
}

// =============================================================================
// 模組替身：資料庫、server-only 標記、寄信。其餘全部是產線本人。
// =============================================================================
const STUBS = {
  "@tanstack/react-start/server-only": "export {};",
  "@/server/supabase-admin": "export function supabaseAdmin() { return globalThis.__fakeDb; }",
  "@/server/notify":
    "export async function triggerNotifyAfterOrderPlaced(id) { (globalThis.__notified ??= []).push(id); }",
};
let stubHits = 0;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec in STUBS) {
      stubHits += 1;
      return {
        url: `data:text/javascript,${encodeURIComponent(STUBS[spec])}`,
        shortCircuit: true,
      };
    }
    if (spec.startsWith("@/")) {
      const base = join(ROOT, "src", spec.slice(2));
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
});

const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function makeDb(world) {
  const log = [];
  function builder(table) {
    const q = { table, op: "select", filters: [], payload: null };
    const resolveIt = () => {
      log.push({ table: q.table, op: q.op, filters: q.filters, payload: q.payload });
      return world.answer(q);
    };
    const b = {
      select() {
        return b;
      },
      insert(payload) {
        q.op = "insert";
        q.payload = payload;
        return b;
      },
      update(payload) {
        q.op = "update";
        q.payload = payload;
        return b;
      },
      delete() {
        q.op = "delete";
        return b;
      },
      eq(col, val) {
        q.filters.push(["eq", col, val]);
        return b;
      },
      in(col, val) {
        q.filters.push(["in", col, val]);
        return b;
      },
      order() {
        return b;
      },
      limit() {
        return b;
      },
      single() {
        return Promise.resolve(resolveIt());
      },
      maybeSingle() {
        return Promise.resolve(resolveIt());
      },
      then(onOk, onErr) {
        return Promise.resolve(resolveIt()).then(onOk, onErr);
      },
    };
    return b;
  }
  return {
    log,
    from: (table) => builder(table),
    rpc(name, args) {
      log.push({ table: null, op: "rpc", name, args });
      return Promise.resolve(world.rpc(name, args));
    },
  };
}

const L = (s) => ({ zh: s, en: s, ja: s });
const EVENT = {
  id: "p-event",
  product_type: "event",
  title: L("海的聲音"),
  price: 1200,
  stock: null,
  capacity: null,
  seats_taken: 0,
  requires_shipping: false,
  status: "active",
};
const now = Date.now();
const SESSIONS = {
  "00000000-0000-4000-8000-00000000000a": {
    id: "00000000-0000-4000-8000-00000000000a",
    product_id: "p-event",
    capacity: 30,
    seats_taken: 3,
    status: "open",
    starts_at: iso(now + 5 * 24 * HOUR),
  },
  "00000000-0000-4000-8000-00000000000b": {
    id: "00000000-0000-4000-8000-00000000000b",
    product_id: "p-event",
    capacity: 30,
    seats_taken: 3,
    status: "open",
    starts_at: iso(now - HOUR),
  },
  "00000000-0000-4000-8000-00000000000c": {
    id: "00000000-0000-4000-8000-00000000000c",
    product_id: "p-event",
    capacity: 4,
    seats_taken: 3,
    status: "open",
    starts_at: iso(now + 5 * 24 * HOUR),
  },
};
const FUTURE = "00000000-0000-4000-8000-00000000000a";
const STARTED = "00000000-0000-4000-8000-00000000000b";
const ALMOST_FULL = "00000000-0000-4000-8000-00000000000c";

function world(opts = {}) {
  let inserted = null;
  let seats = opts.existingSeats ?? 0;
  return {
    answer(q) {
      if (q.table === "event_registrations" && q.op === "select") {
        return { data: Array.from({ length: seats }, (_, i) => ({ id: `r${i}` })), error: null };
      }
      if (q.table === "orders" && q.op === "select") {
        if (opts.existingOrder) return { data: opts.existingOrder, error: null };
        // createAdminPhoneOrder() 建完之後用 idempotency_key + source 讀回來。
        const bySource = q.filters.some((f) => f[1] === "source");
        if (inserted && bySource) {
          return {
            data: {
              id: "o-new",
              order_no: "IB-TEST",
              total: inserted.total,
              payment_status: inserted.total === 0 ? "paid" : "pending",
            },
            error: null,
          };
        }
        return { data: null, error: null };
      }
      if (q.table === "products" && q.op === "select") {
        const ids = q.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] ?? [];
        return { data: [EVENT].filter((p) => ids.includes(p.id)), error: null };
      }
      if (q.table === "event_sessions" && q.op === "select") {
        const ids = q.filters.find((f) => f[0] === "in")?.[2] ?? [];
        return { data: ids.map((id) => SESSIONS[id]).filter(Boolean), error: null };
      }
      if (q.table === "event_session_plans") return { data: [], error: null };
      if (q.table === "product_availability") return { data: [], error: null };
      if (q.table === "orders" && q.op === "insert") {
        inserted = q.payload;
        return {
          data: { id: "o-new", order_no: "IB-TEST", public_token: "tok", total: q.payload.total },
          error: null,
        };
      }
      if (q.table === "order_items" && q.op === "insert") {
        return {
          data: q.payload.map((row, i) => ({
            id: 9000 + i,
            product_id: row.product_id,
            session_id: row.session_id ?? null,
          })),
          error: null,
        };
      }
      return { data: null, error: null };
    },
    rpc(name, args) {
      if (opts.rpc) {
        const r = opts.rpc(name, args);
        if (r) return r;
      }
      if (name === "commit_inventory_reservations") return { data: 0, error: null };
      if (name === "reserve_session_seat") {
        seats += args.p_participants.length;
        return { data: args.p_quantity, error: null };
      }
      if (name === "settle_free_order") {
        return { data: [{ settled: true, reason: "settled", order_no: "IB-TEST" }], error: null };
      }
      return { data: 1, error: null };
    },
  };
}

const { createOrder, createAdminPhoneOrder } = await import(
  pathToFileURL(join(ROOT, "src/server/repos/orders.ts")).href
);
const phone = await import(pathToFileURL(join(ROOT, "src/lib/admin/phone-order.ts")).href);
const tpl = await import(pathToFileURL(join(ROOT, "src/lib/email-templates.ts")).href);

console.log("\n[2] 載得起產線本人");
checkTrue("createAdminPhoneOrder 是產線那一支", typeof createAdminPhoneOrder === "function");
checkTrue("替身都真的被用到（沒有漏網的真資料庫）", stubHits >= 2);

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
function input(over = {}) {
  return {
    idempotencyKey: crypto.randomUUID(),
    productId: "p-event",
    sessionId: FUTURE,
    planId: null,
    quantity: 2,
    participants: [
      { name: "王小明", phone: "0912345678", email: null },
      { name: "李小華", phone: null, email: "hua@example.invalid" },
    ],
    customerName: "王小明",
    customerPhone: "0912345678",
    customerEmail: "ming@example.invalid",
    invoice: { type: "personal" },
    adminNote: "電話報名",
    priceOverride: null,
    payment: { status: "paid", paidOn: "2026-11-01", last5: "12345" },
    notifyCustomer: false,
    ...over,
  };
}
function adminOpts(data) {
  return {
    actorId: ADMIN_ID,
    totalOverride: data.priceOverride ? data.priceOverride.amount : null,
    priceOverrideReason: data.priceOverride ? data.priceOverride.reason : null,
    adminNote: data.adminNote,
    notifyCustomer: data.notifyCustomer,
    paidUpfront: data.payment.status === "paid",
    remittancePaidOn: data.payment.status === "paid" ? data.payment.paidOn : null,
    remittanceLast5: data.payment.status === "paid" ? (data.payment.last5 ?? null) : null,
  };
}
async function run(w, data) {
  const db = makeDb(w);
  globalThis.__fakeDb = db;
  globalThis.__notified = [];
  try {
    const r = await createAdminPhoneOrder(phone.buildPhoneOrderPayload(data), adminOpts(data));
    return { ok: true, r, log: db.log, notified: globalThis.__notified };
  } catch (err) {
    return {
      ok: false,
      code: err?.code ?? err?.name ?? String(err),
      log: db.log,
      notified: globalThis.__notified,
    };
  }
}
const orderInsert = (log) => log.find((e) => e.table === "orders" && e.op === "insert")?.payload;
const rpcs = (log, name) => log.filter((e) => e.op === "rpc" && e.name === name);
const wrote = (log) =>
  log.filter((e) => e.op === "insert" || e.op === "update" || e.op === "delete" || e.op === "rpc");

// =============================================================================
console.log("\n[3] 已收到匯款");
{
  const data = input();
  const res = await run(world(), data);
  checkTrue("建單成功、回 orderId", res.ok && res.r.orderId === "o-new");
  const row = orderInsert(res.log);
  check("source = admin_phone", row?.source, "admin_phone");
  check("created_by = 管理員", row?.created_by, ADMIN_ID);
  check("payment_method = transfer（與前台匯款單同一種）", row?.payment_method, "transfer");
  check("total 依商品價算 1200 × 2", row?.total, 2400);
  check("notify_customer = false（沒勾）", row?.notify_customer, false);
  check("匯款日期", row?.remittance_paid_on, "2026-11-01");
  check("末五碼", row?.remittance_last5, "12345");
  checkTrue(
    "末五碼與回報時間成對（remittance_pair_check）",
    typeof row?.remittance_reported_at === "string",
  );
  check("admin_note", row?.admin_note, "電話報名");
  check("沒有改價 → price_override_reason null", row?.price_override_reason, null);
  check("needs_contact false", row?.needs_contact, false);
  check(
    "🔴 占名額：reserve_session_seat 呼叫一次",
    rpcs(res.log, "reserve_session_seat").length,
    1,
  );
  check(
    "   要 2 位，參加者 2 位、noticeAck 不代勾",
    rpcs(res.log, "reserve_session_seat")[0]?.args.p_participants.map((p) => p.noticeAck),
    ["false", "false"],
  );
  check("已收款：不寄「待收款」那批信（呼叫端接著 admin_mark_order_paid）", res.notified.length, 0);
}

console.log("\n[4] 尚未收到匯款");
{
  const data = input({ payment: { status: "unpaid" }, notifyCustomer: true });
  const res = await run(world(), data);
  const row = orderInsert(res.log);
  checkTrue("建單成功", res.ok);
  check("payment_method = transfer", row?.payment_method, "transfer");
  check("沒有匯款日期", row?.remittance_paid_on, null);
  checkTrue("沒有末五碼", !("remittance_last5" in (row ?? {})));
  check("notify_customer = true（有勾）", row?.notify_customer, true);
  check("下單當下那批信照寄（店家待收款通知；客人信看 notify_customer）", res.notified, ["o-new"]);
  check("名額照樣占", rpcs(res.log, "reserve_session_seat").length, 1);
}

console.log("\n[5] 免費招待（手動改成 0）");
{
  const data = input({
    payment: { status: "unpaid" },
    priceOverride: { amount: 0, reason: "講者親友招待" },
  });
  const res = await run(world(), data);
  const row = orderInsert(res.log);
  checkTrue("建單成功", res.ok);
  check("total 0", row?.total, 0);
  check("discount = 原價 2400（發票上是一列折扣）", row?.discount, 2400);
  check("subtotal 仍是原價", row?.subtotal, 2400);
  check("改價原因存下來", row?.price_override_reason, "講者親友招待");
  check("🔴 走既有 settle_free_order()", rpcs(res.log, "settle_free_order").length, 1);
  check("免費單不寄「待收款」信", res.notified.length, 0);
}

console.log("\n[6] 手動改價（降價、太高、沒原因）");
{
  const ok = await run(world(), input({ priceOverride: { amount: 2000, reason: "團體價" } }));
  const row = orderInsert(ok.log);
  check("降到 2000：total", row?.total, 2000);
  check("   discount 400", row?.discount, 400);
  check("   不呼叫 settle_free_order", rpcs(ok.log, "settle_free_order").length, 0);

  const high = await run(world(), input({ priceOverride: { amount: 3000, reason: "加價" } }));
  check("改高於原價 → price_override_invalid", high.code, "price_override_invalid");
  check("   而且沒有寫任何東西", wrote(high.log).length, 0);

  const db = makeDb(world());
  globalThis.__fakeDb = db;
  let code = null;
  try {
    await createAdminPhoneOrder(phone.buildPhoneOrderPayload(input()), {
      ...adminOpts(input()),
      totalOverride: 100,
      priceOverrideReason: "  ",
    });
  } catch (err) {
    code = err?.code;
  }
  check("改價沒原因 → price_override_invalid（伺服器端再擋一次）", code, "price_override_invalid");
}

console.log("\n[7] 名額不足／已開始的場次");
{
  const full = await run(world(), input({ sessionId: ALMOST_FULL }));
  check("剩 1 位要 2 位 → no_seats_left（便宜的預先檢查）", full.code, "no_seats_left");
  check("   沒有寫任何東西", wrote(full.log).length, 0);

  const race = await run(
    world({
      rpc: (name) =>
        name === "reserve_session_seat"
          ? { data: null, error: { code: "P0001", message: "NO_SEATS_LEFT:x" } }
          : null,
    }),
    input(),
  );
  check("reserve_session_seat 回 NO_SEATS_LEFT → no_seats_left", race.code, "no_seats_left");
  checkTrue(
    "   訂單被刪回去（不留半張單）",
    race.log.some((e) => e.table === "orders" && e.op === "delete"),
  );

  const started = await run(world(), input({ sessionId: STARTED }));
  check("已開始的場次 → session_ended", started.code, "session_ended");
  check("   沒有寫任何東西", wrote(started.log).length, 0);
}

console.log("\n[8] 重複送出（同一個 idempotencyKey）");
{
  const res = await run(
    world({
      existingOrder: {
        id: "o-old",
        order_no: "IB-OLD",
        public_token: "tok-old",
        total: 2400,
        status: "processing",
        payment_status: "paid",
        payment_method: "transfer",
      },
    }),
    input(),
  );
  check(
    "報名還沒寫齊（第一個請求還在跑）→ 結果不確定，不讓呼叫端標記已收款",
    res.code,
    "AdminPhoneOrderUncertainError",
  );
  check("🔴 沒有第二次 insert、沒有再占名額", wrote(res.log).length, 0);

  const done = await run(
    world({
      existingSeats: 2,
      existingOrder: {
        id: "o-old",
        order_no: "IB-OLD",
        public_token: "tok-old",
        total: 2400,
        status: "processing",
        payment_status: "paid",
        payment_method: "transfer",
      },
    }),
    input(),
  );
  checkTrue("第一個請求已完成 → 回原本那張單", done.ok && done.r.orderId === "o-old");
  check("   一樣沒有任何寫入", wrote(done.log).length, 0);
}

console.log("\n[8b] 不勾寄信 → 不把信箱交給光貿（發票開立通知）");
{
  const inv = stripComments(readFile("src/server/repos/invoices.ts"));
  checkTrue(
    "getOrderForInvoice 讀 notify_customer，false 時 customerEmail 給空字串",
    /notify_customer/.test(inv) && /o\.notify_customer === false \? ""/.test(inv),
  );
}

console.log("\n[9] 前台結帳的 insert 形狀沒變");
{
  const db = makeDb(world());
  globalThis.__fakeDb = db;
  globalThis.__notified = [];
  const p = phone.buildPhoneOrderPayload(input());
  await createOrder(p);
  const row = orderInsert(db.log);
  for (const k of [
    "source",
    "created_by",
    "admin_note",
    "price_override_reason",
    "notify_customer",
    "remittance_paid_on",
  ]) {
    checkTrue(`前台訂單不帶 ${k}（靠 DB default）`, row && !(k in row));
  }
}

// =============================================================================
console.log("\n[10] 純函式：schema、試算、payload");
{
  const s = phone.phoneOrderSchema;
  checkTrue("合法輸入通過", s.safeParse(input()).success);
  checkTrue("訂購人手機格式錯 → 擋", !s.safeParse(input({ customerPhone: "123" })).success);
  checkTrue(
    "0051：參加者信箱與手機都沒填 → 通過（電話報名放寬）",
    s.safeParse(input({ participants: [{ name: "A", phone: null, email: null }] })).success,
  );
  checkTrue(
    "0051：參加者手機有填但格式錯 → 仍然擋",
    !s.safeParse(input({ participants: [{ name: "A", phone: "123", email: null }] })).success,
  );
  checkTrue(
    "統編檢核碼錯 → 擋（與前台同一份規則）",
    !s.safeParse(input({ invoice: { type: "company", taxId: "12345678" } })).success,
  );
  checkTrue(
    "末五碼不是 5 碼 → 擋",
    !s.safeParse(input({ payment: { status: "paid", paidOn: "2026-11-01", last5: "12" } })).success,
  );
  checkTrue(
    "改價沒原因 → 擋",
    !s.safeParse(input({ priceOverride: { amount: 100, reason: "" } })).success,
  );
  checkTrue(
    "notifyCustomer 不送 → 擋（沒有隱含預設）",
    !s.safeParse({ ...input(), notifyCustomer: undefined }).success,
  );

  check("試算：沒有票種用商品價", phone.quotePhoneOrder({ price: 1200 }, null, 2), {
    unitPrice: 1200,
    seatsPerUnit: 1,
    seats: 2,
    total: 2400,
  });
  check(
    "試算：雙人票種一份佔 2 位",
    phone.quotePhoneOrder({ price: 1200 }, { price: 3000, seatsPerUnit: 2 }, 2),
    { unitPrice: 3000, seatsPerUnit: 2, seats: 4, total: 6000 },
  );
  check(
    "改價高於原價 → 錯誤訊息",
    typeof phone.priceOverrideError({ amount: 3000, reason: "x" }, 2400),
    "string",
  );
  check("改價合法 → null", phone.priceOverrideError({ amount: 0, reason: "招待" }, 2400), null);

  const payload = phone.buildPhoneOrderPayload(input());
  check("payload：匯款", payload.paymentMethod, "transfer");
  check("payload：不用推薦碼", payload.referralCode, "");
  check("payload：不寄送", payload.shippingMethod, "none");
  check("payload：客人備註留空（店員的話在 admin_note）", payload.note, null);
  check(
    "phoneOrderPaidNote",
    phone.phoneOrderPaidNote("2026-11-01", "12345"),
    "後台電話報名：匯款日 2026-11-01，帳號末五碼 12345",
  );
}

console.log("\n[11] 店家通知信標明「後台電話報名」");
{
  const base = {
    stage: "afterPayment",
    orderNo: "IB-TEST",
    total: 2400,
    contact: null,
    adminUrl: null,
    paymentMethod: "transfer",
    shippingMethod: "none",
    items: [],
    sessions: [],
  };
  const withPhone = tpl.renderAdminOrderNotificationEmail({
    ...base,
    phoneOrder: { notifyCustomer: false, adminNote: "老客人", createdByEmail: "a@example.invalid" },
  });
  checkTrue("主旨有「後台電話報名」", withPhone.subject.includes("後台電話報名"));
  checkTrue("內文寫出不寄給客人", withPhone.text.includes("不寄給客人"));
  checkTrue("內文有內部備註", withPhone.text.includes("老客人"));
  const web = tpl.renderAdminOrderNotificationEmail(base);
  checkTrue("前台訂單的信沒有這個標籤", !web.subject.includes("後台電話報名"));
}

// =============================================================================
console.log("\n[12] 0051：只有姓名＋手機的訂購人、參加者全空也能建單");
{
  const s = phone.phoneOrderSchema;
  const raw = input({
    customerEmail: "",
    customerPhone: "0912345678",
    participants: [
      { name: "", phone: null, email: null },
      { name: null, phone: "", email: "" },
    ],
    notifyCustomer: false,
  });
  const parsed = s.safeParse(raw);
  checkTrue("schema：訂購人只有姓名＋手機、兩位參加者全空 → 通過", parsed.success);
  const data = parsed.data;
  const payload = phone.buildPhoneOrderPayload(data);
  check("payload：訂購人 Email 是空字串（orders 欄位 NOT NULL，存 ''）", payload.customerEmail, "");
  check(
    "payload：參加者姓名自動帶入（第 1 位＝訂購人，第 2 位＝同行者 1）",
    payload.items[0].participants.map((p) => p.name),
    ["王小明", "王小明 同行者 1"],
  );
  check(
    "payload：參加者聯絡方式是 null（不是空字串）",
    payload.items[0].participants.map((p) => [p.email, p.phone]),
    [
      [null, null],
      [null, null],
    ],
  );

  const res = await run(world(), data);
  checkTrue(
    "建單成功（createAdminPhoneOrder → createOrder，產線本人）",
    res.ok && res.r.orderId === "o-new",
  );
  const row = orderInsert(res.log);
  check("orders insert：customer_email ''", row?.customer_email, "");
  check("orders insert：customer_phone 照填", row?.customer_phone, "0912345678");
  check("orders insert：notify_customer false", row?.notify_customer, false);
  const seat = rpcs(res.log, "reserve_session_seat")[0];
  check(
    "reserve_session_seat 收到的參加者：名字已帶入、聯絡方式 null",
    seat?.args.p_participants.map((p) => [p.name, p.email, p.phone]),
    [
      ["王小明", null, null],
      ["王小明 同行者 1", null, null],
    ],
  );

  const emailOnly = s.safeParse(
    input({ customerPhone: "", customerEmail: "ming@example.invalid" }),
  );
  checkTrue("訂購人只有 Email（沒手機）→ 通過", emailOnly.success);
  checkTrue(
    "訂購人手機與 Email 都沒有 → 擋",
    !s.safeParse(input({ customerPhone: "", customerEmail: "" })).success,
  );
  checkTrue(
    "訂購人 Email 有填但格式錯 → 擋",
    !s.safeParse(input({ customerEmail: "abc" })).success,
  );
  checkTrue(
    "訂購人 Email 判斷與前台同一個（zod .email()：a..b@x.yz 擋）",
    !s.safeParse(input({ customerEmail: "a..b@x.yz" })).success,
  );
  checkTrue("訂購人姓名空白 → 擋", !s.safeParse(input({ customerName: "  " })).success);

  const noContact = await run(world(), { ...data, customerPhone: "" });
  check(
    "repo 邊界：訂購人沒有任何聯絡方式 → AdminPhoneOrderInputError，一筆都沒寫",
    [noContact.ok, noContact.code, wrote(noContact.log).length],
    [false, "customer_contact_required", 0],
  );
}

console.log("\n[13] 0051：沒有 Email 卻要寄信 → 擋（表單、server fn、repo、DB 四層）");
{
  check(
    "phoneOrderNotifyError：有勾、沒 Email → 錯誤訊息含「訂購人沒有 Email，無法寄信」",
    String(phone.phoneOrderNotifyError({ notifyCustomer: true, customerEmail: "" })).includes(
      "訂購人沒有 Email，無法寄信",
    ),
    true,
  );
  check(
    "phoneOrderNotifyError：有 Email → null",
    phone.phoneOrderNotifyError({ notifyCustomer: true, customerEmail: "a@example.invalid" }),
    null,
  );
  check(
    "phoneOrderNotifyError：沒勾 → null",
    phone.phoneOrderNotifyError({ notifyCustomer: false, customerEmail: "" }),
    null,
  );
  const data = phone.phoneOrderSchema.parse(
    input({ customerEmail: "", customerPhone: "0912345678", notifyCustomer: true }),
  );
  const res = await run(world(), data);
  check(
    "repo 邊界：notifyCustomer 但沒 Email → email_required_for_notify，一筆都沒寫",
    [res.ok, res.code, wrote(res.log).length],
    [false, "email_required_for_notify", 0],
  );

  const fns = stripComments(readFile("src/lib/admin/fns/phone-orders.ts"));
  const guardIdx = fns.indexOf("phoneOrderNotifyError(data)");
  const createIdx = fns.indexOf("createAdminPhoneOrder(buildPhoneOrderPayload(data)");
  checkTrue(
    "server fn：建單之前先 phoneOrderNotifyError(data)，回 { ok:false, message }",
    guardIdx > 0 &&
      createIdx > guardIdx &&
      /if \(notifyError\) return \{ ok: false, message: notifyError \}/.test(fns),
  );
  checkTrue(
    "server fn：AdminPhoneOrderInputError 轉成店員看得懂的話",
    /err instanceof AdminPhoneOrderInputError/.test(fns),
  );

  const form = stripComments(readFile("src/components/admin/PhoneOrderForm.tsx"));
  checkTrue("表單：沒有 Email 時勾選框 disabled", /disabled=\{!buyerHasEmail\}/.test(form));
  checkTrue(
    "表單：送出用 effectiveNotify（清掉 Email 不殘留勾選）",
    /notifyCustomer: effectiveNotify/.test(form),
  );
  checkTrue("表單：說明文字用 NOTIFY_NEEDS_EMAIL_TEXT", /NOTIFY_NEEDS_EMAIL_TEXT/.test(form));
  check("NOTIFY_NEEDS_EMAIL_TEXT", phone.NOTIFY_NEEDS_EMAIL_TEXT, "訂購人沒有 Email，無法寄信");
  checkTrue(
    "表單：參加者姓名 placeholder 顯示預設值",
    /placeholder=\{\s*defaultParticipantName\(buyer\.name, i\)/.test(form),
  );

  const sql = stripSqlComments(
    readFile("supabase/migrations/0051_phone_order_optional_contact.sql"),
  );
  checkTrue(
    "DB：orders_admin_phone_notify_email（admin_phone 勾寄信一定要有 Email）",
    /orders_admin_phone_notify_email check \(\s*source <> 'admin_phone'\s*or not notify_customer\s*or nullif\(btrim\(customer_email\), ''\) is not null/.test(
      sql,
    ),
  );
}

console.log("\n[14] 0051：沒有 Email 時的發票——照開、不帶 BuyerEmailAddress");
{
  const amego = await import(pathToFileURL(join(ROOT, "src/server/amego.ts")).href);
  const lines = [{ description: "海的聲音", quantity: 2, unitPrice: 300, amount: 600 }];
  const b2c = amego.buildIssuePayload({ orderId: "IB-T", lines, buyerEmail: "" });
  check(
    "buildIssuePayload：空字串 Email → 不帶 BuyerEmailAddress",
    "BuyerEmailAddress" in b2c,
    false,
  );
  check(
    "buildIssuePayload：買方仍是 0000000000／消費者（B2C 照開）",
    [b2c.BuyerIdentifier, b2c.BuyerName],
    ["0000000000", "消費者"],
  );
  check("buildIssuePayload：金額照算", b2c.TotalAmount, "600");
  const donate = amego.buildIssuePayload({
    orderId: "IB-T",
    lines,
    buyerEmail: null,
    loveCode: "168001",
  });
  check("沒有 Email＋捐贈 → NPOBAN 照帶", donate.NPOBAN, "168001");

  const inv = stripComments(readFile("src/server/repos/invoices.ts"));
  checkTrue(
    "getOrderForInvoice：notify_customer=false（沒有 Email 的電話報名一定是 false）→ customerEmail 給空字串",
    /customerEmail: o\.notify_customer === false \? "" : String\(o\.customer_email \?\? ""\)/.test(
      inv,
    ),
  );
  const issuer = stripComments(readFile("src/server/invoice-issuer.ts"));
  check(
    "invoice-issuer：兩次開立都是 buyerEmail: order.customerEmail || null（空 → null，不擋開立）",
    (issuer.match(/buyerEmail: order\.customerEmail \|\| null/g) ?? []).length,
    2,
  );
  checkTrue(
    "invoice-issuer：沒有任何「沒有 Email 就不開」的分支",
    !/customerEmail[^\n]{0,40}(throw|return \{ ok: false)/.test(issuer),
  );
}

console.log("\n[15] 0051：前台結帳規則不變");
{
  const co = await import(pathToFileURL(join(ROOT, "src/lib/checkout.ts")).href);
  const front = co.checkoutFormSchema({ t: (m) => m.zh, requireAddress: false });
  const base = {
    customerName: "王小明",
    customerEmail: "ming@example.invalid",
    customerPhone: "0912345678",
    shippingMethod: "none",
    address: null,
    note: null,
    participants: [
      { lineKey: "k", name: "王小明", email: "ming@example.invalid", phone: null, noticeAck: true },
    ],
  };
  checkTrue("前台：完整資料 → 通過", front.safeParse(base).success);
  checkTrue("前台：沒有 Email → 擋", !front.safeParse({ ...base, customerEmail: "" }).success);
  checkTrue("前台：沒有手機 → 擋", !front.safeParse({ ...base, customerPhone: "" }).success);
  checkTrue(
    "前台：參加者信箱與手機都沒填 → 擋",
    !front.safeParse({
      ...base,
      participants: [{ lineKey: "k", name: "A", email: null, phone: null, noticeAck: true }],
    }).success,
  );
  checkTrue(
    "前台：參加者沒姓名 → 擋",
    !front.safeParse({
      ...base,
      participants: [
        { lineKey: "k", name: "", email: "a@example.invalid", phone: null, noticeAck: true },
      ],
    }).success,
  );
  checkTrue(
    "前台 payload schema：customerEmail 空字串 → 擋",
    !co.checkoutPayloadSchema.safeParse({
      ...base,
      customerEmail: "",
      items: [{ productId: "p", quantity: 1 }],
      locale: "zh",
      idempotencyKey: crypto.randomUUID(),
    }).success,
  );

  // createOrder()（前台，沒有 admin）：參加者沒有聯絡方式 → order_failed，連 orders 都沒寫。
  const db = makeDb(world());
  globalThis.__fakeDb = db;
  globalThis.__notified = [];
  const p = phone.buildPhoneOrderPayload(
    phone.phoneOrderSchema.parse(input({ participants: [{ name: "A" }, { name: "B" }] })),
  );
  let code = "no error";
  try {
    await createOrder(p);
  } catch (err) {
    code = err?.code ?? String(err);
  }
  check("前台 createOrder：參加者沒聯絡方式 → order_failed", code, "order_failed");
  check("前台 createOrder：被擋時沒有寫任何東西", wrote(db.log).length, 0);

  const orders = stripComments(readFile("src/server/repos/orders.ts"));
  checkTrue(
    "orders.ts：放寬只在 admin 分支（allowParticipantWithoutContact: admin !== null）",
    /allowParticipantWithoutContact: admin !== null/.test(orders),
  );
  checkTrue(
    "orders.ts：priceLines 預設 allowParticipantWithoutContact=false",
    /= \{ allowParticipantWithoutContact: false \}/.test(orders),
  );

  const sql = stripSqlComments(
    readFile("supabase/migrations/0051_phone_order_optional_contact.sql"),
  );
  checkTrue(
    "DB 觸發器：兩者皆空只有 o.source = 'admin_phone' 放行，否則同名 check_violation",
    /o\.source = 'admin_phone'/.test(sql) &&
      /errcode = 'check_violation'/.test(sql) &&
      /constraint = 'event_registrations_contactable'/.test(sql),
  );
  checkTrue(
    "DB：orders_admin_phone_contact 只約束 admin_phone",
    /orders_admin_phone_contact check \(\s*source <> 'admin_phone'/.test(sql),
  );
  checkTrue("DB：沒有放寬 customer_email／customer_phone 的 NOT NULL", !/drop not null/i.test(sql));
  checkTrue("DB：沒有改 reserve_session_seat", !/reserve_session_seat/.test(sql));
}

console.log("\n[16] 0051：事後補資料（訂單內頁編輯聯絡資料）");
{
  const fns = stripComments(readFile("src/lib/admin/fns/phone-orders.ts"));
  checkTrue(
    "updatePhoneOrderContactsAdmin：adminFnMiddleware＋inputValidator(phoneOrderContactEditSchema)",
    /updatePhoneOrderContactsAdmin = createServerFn\(\{ method: "POST" \}\)\s*\.middleware\(\[adminFnMiddleware\]\)\s*\.inputValidator\(phoneOrderContactEditSchema\)/.test(
      fns,
    ),
  );
  checkTrue(
    "稽核的操作者只認 context.admin.userId",
    /updatePhoneOrderContacts\(\{\s*orderId: data\.orderId,\s*actorId: context\.admin\.userId/.test(
      fns,
    ),
  );
  checkTrue(
    "getPhoneOrderContacts：GET＋adminFnMiddleware",
    /getPhoneOrderContacts = createServerFn\(\{ method: "GET" \}\)\s*\.middleware\(\[adminFnMiddleware\]\)/.test(
      fns,
    ),
  );
  const repo = stripComments(readFile("src/server/repos/phone-orders.ts"));
  checkTrue(
    "讀取只回 admin_phone 的訂單",
    /order\.source !== "admin_phone"\) return null/.test(repo),
  );
  checkTrue(
    "寫入走 admin_update_phone_order_contacts RPC",
    /rpc\("admin_update_phone_order_contacts"/.test(repo),
  );
  const page = stripComments(readFile("src/routes/admin/_shell.orders_.$id.tsx"));
  checkTrue(
    "訂單內頁：編輯器只掛在電話報名（detail.phone_order）",
    /\{detail\.phone_order \? \(\s*<PhoneOrderContactEditor/.test(page),
  );

  const e = phone.phoneOrderContactEditSchema;
  const id = "00000000-0000-4000-8000-0000000000aa";
  const ok = {
    orderId: id,
    customer: { name: "王小明", email: "", phone: "0912345678" },
    participants: [{ id, name: "林小美", email: "", phone: "" }],
  };
  checkTrue("編輯：訂購人只有手機、參加者沒聯絡方式 → 通過", e.safeParse(ok).success);
  checkTrue(
    "編輯：訂購人手機與 Email 都清空 → 擋",
    !e.safeParse({ ...ok, customer: { name: "王", email: "", phone: "" } }).success,
  );
  checkTrue(
    "編輯：手機格式錯 → 擋",
    !e.safeParse({ ...ok, participants: [{ id, name: "A", email: "", phone: "12" }] }).success,
  );
  checkTrue(
    "編輯：參加者姓名清空 → 擋",
    !e.safeParse({ ...ok, participants: [{ id, name: " ", email: "", phone: "" }] }).success,
  );
  const stripped = e.parse({ ...ok, customer: { ...ok.customer, total: 1 }, extra: "x" });
  checkTrue(
    "編輯：多餘欄位被丟掉（只有姓名／手機／Email）",
    !("extra" in stripped) && !("total" in stripped.customer),
  );

  const sql = stripSqlComments(
    readFile("supabase/migrations/0051_phone_order_optional_contact.sql"),
  );
  checkTrue("RPC：限 admin_phone", /'not_phone_order'/.test(sql));
  checkTrue(
    "RPC：驗證參加者時就 for update 鎖列（不會與單筆移除競爭出不實稽核）",
    /and r\.order_id = p_order_id\s*for update;\s*if not found then\s*return query select false, 'registration_not_in_order'/.test(
      sql,
    ),
  );
  checkTrue(
    "RPC：參加者必須屬於這張單",
    /r\.order_id = p_order_id/.test(sql) && /'registration_not_in_order'/.test(sql),
  );
  checkTrue(
    "RPC：有變動才寫稽核",
    /insert into public\.order_contact_edit_log \(actor_id, order_id, changes\)/.test(sql),
  );
  checkTrue(
    "RPC：只 grant service_role",
    /revoke all on function public\.admin_update_phone_order_contacts\(uuid, uuid, jsonb, jsonb\)\s*from public, anon, authenticated/.test(
      sql,
    ) &&
      /grant execute on function public\.admin_update_phone_order_contacts\(uuid, uuid, jsonb, jsonb\)\s*to service_role/.test(
        sql,
      ),
  );
  checkTrue(
    "稽核表：RLS on、anon/authenticated 全收",
    /order_contact_edit_log enable row level security/.test(sql) &&
      /revoke all on table public\.order_contact_edit_log from anon, authenticated/.test(sql),
  );
}

console.log("\n[17] 0051：預設姓名");
{
  check("第 1 位＝訂購人姓名", phone.defaultParticipantName("王小明", 0), "王小明");
  check("第 3 位＝同行者 2", phone.defaultParticipantName("王小明", 2), "王小明 同行者 2");
  check(
    "訂購人還沒填 → 空字串（placeholder 改顯示說明）",
    phone.defaultParticipantName(" ", 1),
    "",
  );
  const long = "名".repeat(60);
  const d = phone.defaultParticipantName(long, 12);
  check(
    "超過 60 字時截訂購人姓名、保留後綴",
    [d.length <= 60, d.endsWith(" 同行者 12")],
    [true, true],
  );
  const p = phone.buildPhoneOrderPayload(
    phone.phoneOrderSchema.parse(input({ participants: [{ name: "自己填" }, { name: "  " }] })),
  );
  check(
    "有填的姓名照用，空白才帶預設",
    p.items[0].participants.map((x) => x.name),
    ["自己填", "王小明 同行者 1"],
  );
}

console.log("\n" + "─".repeat(52));
console.log(`##SELFTEST## file=scripts/admin-phone-order-selftest.mjs pass=${pass} fail=${fail}`);
console.log(
  `${fail === 0 ? green(`✓ 全部通過：${pass} passed, 0 failed`) : red(`✗ 有失敗：${pass} passed, ${fail} failed`)}`,
);
process.exit(fail === 0 ? 0 : 1);
