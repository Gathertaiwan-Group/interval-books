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
  check("fns/phone-orders.ts 有兩支 server fn", serverFns, 2);
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
  return {
    answer(q) {
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
      code: err?.code ?? String(err),
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
  checkTrue("回原本那張單", res.ok && res.r.orderId === "o-old");
  check("🔴 沒有第二次 insert、沒有再占名額", wrote(res.log).length, 0);
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
    "參加者信箱與手機都沒填 → 擋",
    !s.safeParse(input({ participants: [{ name: "A", phone: null, email: null }] })).success,
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

console.log("\n" + "─".repeat(52));
console.log(`##SELFTEST## file=scripts/admin-phone-order-selftest.mjs pass=${pass} fail=${fail}`);
console.log(
  `${fail === 0 ? green(`✓ 全部通過：${pass} passed, 0 failed`) : red(`✗ 有失敗：${pass} passed, ${fail} failed`)}`,
);
process.exit(fail === 0 ? 0 : 1);
