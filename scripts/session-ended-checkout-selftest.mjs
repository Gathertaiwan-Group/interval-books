#!/usr/bin/env node
/**
 * session-ended-checkout-selftest.mjs —— 場次開始後不收新訂單（0049）
 *
 * 漏洞：活動頁在活動結束後拿掉了報名入口，但結帳流程本身不檢查場次時間，手動組出
 * /checkout?product=…&session=… 就能下單、付款、佔名額。修法有三道：
 *
 *   1. 伺服器 priceLines()：場次 starts_at <= 伺服器現在時間 → CheckoutError("session_ended")
 *   2. 資料庫 reserve_session_seat() 第 ④b 步：starts_at <= now() → 'SESSION_STARTED'
 *      （orders.ts 把它對成同一個 session_ended）
 *   3. 畫面：直接結帳 resolveDirectCheckout() 回 session_ended、購物車 syncFromCatalogue()
 *      標 session_ended（那兩條在 direct-checkout-selftest 的 [6c]／[8b] 驗）
 *
 * 這一支**驅動產線的 createOrder() 本人**（src/server/repos/orders.ts），只把
 * supabaseAdmin() 換成記錄每一次呼叫的假資料庫，所以能證明的是「真的那一份程式碼」：
 *
 *   · 已開始的場次被拒，而且**一個字都沒寫**（沒有 insert orders、沒有打任何 RPC）
 *   · 還沒開始的場次、書、選物照常成立
 *   · 資料庫那一道擋下時（priceLines 讀完之後場次剛好開始），客人拿到同一句話、
 *     訂單被刪掉
 *   · 🔴 已經成立的訂單（同一個 idempotency key 重送）在場次開始後仍然原樣拿回來
 *   · 🔴 付款確認的路徑（webhook、補付款、匯款確認、後台改狀態）不經過這條規則（靜態）
 *
 * 不連資料庫、不寄信、不下單。執行：node scripts/session-ended-checkout-selftest.mjs
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
const checkFalse = (label, v) => check(label, Boolean(v), false);

/** 檔案不存在＝丟例外，不回空字串（否則否定斷言會靜默通過；見 run-selftests.mjs 守門 4）。 */
const readFile = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

// -----------------------------------------------------------------------------
// 模組替身：只換掉三個 —— 資料庫、server-only 標記、寄信。其餘全部是產線本人。
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// 假資料庫：可串接的 query builder，每一次呼叫都記下來。回什麼由 world 決定。
// -----------------------------------------------------------------------------
const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function makeDb(world) {
  const log = [];
  function builder(table) {
    const q = { table, op: "select", filters: [], payload: null };
    const resolveIt = () => {
      log.push({ table: q.table, op: q.op, filters: q.filters });
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
const BOOK = {
  id: "p-book",
  product_type: "book",
  title: L("一本書"),
  price: 400,
  stock: 5,
  capacity: null,
  seats_taken: 0,
  requires_shipping: false,
  status: "active",
};
const GOODS = { ...BOOK, id: "p-goods", product_type: "goods", title: L("選物") };
const now = Date.now();
const SESSIONS = {
  "s-started": {
    id: "s-started",
    product_id: "p-event",
    capacity: 30,
    seats_taken: 3,
    status: "open",
    starts_at: iso(now - HOUR), // 一小時前開始（池上、yokky 那種）
  },
  "s-just": {
    id: "s-just",
    product_id: "p-event",
    capacity: 30,
    seats_taken: 3,
    status: "open",
    starts_at: iso(now - 1000), // 一秒前剛開始
  },
  "s-future": {
    id: "s-future",
    product_id: "p-event",
    capacity: 30,
    seats_taken: 3,
    status: "open",
    starts_at: iso(now + 5 * 24 * HOUR), // 海的聲音 11/6、公東 12/4 那種
  },
};

/**
 * @param {object} opts
 * @param {Record<string, unknown> | null} [opts.existingOrder] idempotency key 已經有單
 * @param {(name: string, args: unknown) => unknown} [opts.rpc]
 */
function world(opts = {}) {
  return {
    answer(q) {
      if (q.table === "orders" && q.op === "select") {
        return { data: opts.existingOrder ?? null, error: null };
      }
      if (q.table === "products" && q.op === "select") {
        const ids = q.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] ?? [];
        return { data: [EVENT, BOOK, GOODS].filter((p) => ids.includes(p.id)), error: null };
      }
      if (q.table === "event_sessions" && q.op === "select") {
        const ids = q.filters.find((f) => f[0] === "in")?.[2] ?? [];
        return { data: ids.map((id) => SESSIONS[id]).filter(Boolean), error: null };
      }
      if (q.table === "event_session_plans") return { data: [], error: null };
      if (q.table === "product_availability") return { data: [], error: null };
      if (q.table === "orders" && q.op === "insert") {
        return {
          data: { id: "o-new", order_no: "IB-TEST", public_token: "tok-new", total: 1 },
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
      return { data: 1, error: null };
    },
  };
}

const { createOrder } = await import(pathToFileURL(join(ROOT, "src/server/repos/orders.ts")).href);
const { isSessionClosedForBooking } = await import(
  pathToFileURL(join(ROOT, "src/lib/event-status.ts")).href
);
const { CHECKOUT_ERROR_COPY, checkoutErrorText } = await import(
  pathToFileURL(join(ROOT, "src/lib/checkout.ts")).href
);

console.log("\n[0] 載得起產線本人");
checkTrue("createOrder 是產線那一支", typeof createOrder === "function");
checkTrue("三個替身都真的被用到（沒有漏網的真資料庫）", stubHits >= 2);

const person = { name: "測試", email: "t@example.invalid", phone: null, noticeAck: true };
function payload(items, key = `k-${Math.random()}`) {
  return {
    items,
    customerName: "測試",
    customerEmail: "t@example.invalid",
    customerPhone: "0912345678",
    shippingMethod: "pickup",
    address: null,
    locale: "zh",
    idempotencyKey: key,
    paymentMethod: "transfer",
    needsContact: false,
    invoice: { type: "personal" },
    note: null,
  };
}
const eventItem = (sessionId, qty = 1) => ({
  productId: "p-event",
  sessionId,
  planId: null,
  quantity: qty,
  participants: Array.from({ length: qty }, () => person),
});

async function run(w, p) {
  const db = makeDb(w);
  globalThis.__fakeDb = db;
  globalThis.__notified = [];
  try {
    const r = await createOrder(p);
    return { ok: true, r, log: db.log };
  } catch (err) {
    return { ok: false, code: err?.code ?? String(err), log: db.log };
  }
}
const wrote = (log) =>
  log.filter((e) => e.op === "insert" || e.op === "update" || e.op === "delete" || e.op === "rpc");

// =============================================================================
console.log("\n[1] 🔴 伺服器端：已開始／已結束的場次被拒");
for (const sid of ["s-started", "s-just"]) {
  const res = await run(world(), payload([eventItem(sid)]));
  check(`${sid}：createOrder 拋 session_ended`, res.code, "session_ended");
  check(`${sid}：一個字都沒寫（沒有 insert／update／delete／RPC）`, wrote(res.log).length, 0);
}
{
  // 混著書的購物車：整張拒絕，不是默默丟掉那一行（丟掉會讓客人付到他沒同意的金額）。
  const res = await run(
    world(),
    payload([{ productId: "p-book", quantity: 1 }, eventItem("s-started")]),
  );
  check("書＋已開始場次：整張拒絕 session_ended", res.code, "session_ended");
  check("   而且沒有寫任何東西", wrote(res.log).length, 0);
}
check(
  "錯誤碼有三語文案，中文講清楚已結束",
  CHECKOUT_ERROR_COPY.session_ended.zh.includes("這個場次已經結束，無法報名"),
  true,
);
check(
  "checkoutErrorText 認得這個碼（不會被當成未知錯誤吞成 order_failed）",
  checkoutErrorText("session_ended", "zh"),
  CHECKOUT_ERROR_COPY.session_ended.zh,
);

// =============================================================================
console.log("\n[2] 還在報名期間的場次、書、選物：照常成立");
{
  const res = await run(world(), payload([eventItem("s-future", 2)]));
  checkTrue("還沒開始的場次：訂單成立", res.ok);
  check(
    "   reserve_session_seat 被呼叫一次，帶的是那個場次",
    res.log.filter((e) => e.name === "reserve_session_seat").map((e) => e.args.p_session_id),
    ["s-future"],
  );
}
for (const item of [
  { productId: "p-book", quantity: 2 },
  { productId: "p-goods", quantity: 1 },
]) {
  const res = await run(world(), payload([item]));
  checkTrue(`${item.productId}：訂單成立`, res.ok);
  checkFalse(
    `${item.productId}：沒有去讀場次（非活動商品完全不經過這條規則）`,
    res.log.some((e) => e.table === "event_sessions"),
  );
}
{
  const res = await run(
    world(),
    payload([{ productId: "p-book", quantity: 1 }, eventItem("s-future")]),
  );
  checkTrue("書＋還沒開始的場次：訂單成立", res.ok);
}

// =============================================================================
console.log("\n[3] 🔴 資料庫那一道（0049 ④b）：priceLines 之後場次剛好開始");
{
  const res = await run(
    world({
      rpc: (name, args) =>
        name === "reserve_session_seat"
          ? {
              data: null,
              error: { code: "23514", message: `SESSION_STARTED:${args.p_session_id}` },
            }
          : null,
    }),
    payload([eventItem("s-future")]),
  );
  check(
    "SESSION_STARTED → 客人拿到 session_ended（不是籠統的 order_failed）",
    res.code,
    "session_ended",
  );
  checkTrue(
    "   剛建的訂單被刪掉（deleteOrder 有跑）",
    res.log.some((e) => e.table === "orders" && e.op === "delete"),
  );
  checkFalse("   沒有寄任何通知", (globalThis.__notified ?? []).length > 0);
}
{
  // 對照組：NO_SEATS_LEFT 的對應沒有被這次改動弄壞。
  const res = await run(
    world({
      rpc: (name) =>
        name === "reserve_session_seat"
          ? { data: null, error: { code: "23514", message: "NO_SEATS_LEFT:s-future" } }
          : null,
    }),
    payload([eventItem("s-future")]),
  );
  check("對照組：NO_SEATS_LEFT 仍然是 no_seats_left", res.code, "no_seats_left");
  const other = await run(
    world({
      rpc: (name) =>
        name === "reserve_session_seat"
          ? { data: null, error: { code: "23514", message: "SESSION_NOT_OPEN:s-future" } }
          : null,
    }),
    payload([eventItem("s-future")]),
  );
  check("對照組：其他錯誤仍然是 order_failed", other.code, "order_failed");
}

// =============================================================================
console.log("\n[4] 🔴 已經成立的訂單不受影響");
{
  // 客人在場次開始前下了單（匯款），之後重送同一個請求（雙擊、網路重試）。場次已經開始，
  // 但那張單本來就成立了 —— 拿回原本那張，不可以變成 session_ended。
  const res = await run(
    world({
      existingOrder: {
        id: "o-old",
        order_no: "IB-OLD",
        public_token: "tok-old",
        total: 1200,
        status: "pending",
        payment_status: "pending",
        payment_method: "transfer",
      },
    }),
    payload([eventItem("s-started")], "k-existing"),
  );
  checkTrue("同一個 idempotency key 重送：拿回原本那張單", res.ok && res.r.orderNo === "IB-OLD");
  checkFalse(
    "   沒有去讀場次（replay 在 priceLines 之前）",
    res.log.some((e) => e.table === "event_sessions"),
  );
}

// 付款確認的每一條路徑都不經過 priceLines／reserve_session_seat／isSessionClosedForBooking。
// 這些檔案若哪天開始呼叫它們，這一組會轉紅，逼人回答「已成立的訂單會不會被擋」。
const PAYMENT_PATHS = [
  "src/server/repos/payments.ts", // markOrderPaid（webhook 共用）
  "src/server/payuni-webhook.ts",
  "src/server/blackcat-webhook.ts",
  "src/server/repos/orders-admin.ts", // 後台改狀態、標記已付款
  "src/server/repos/order-fulfillment.ts",
];
for (const rel of PAYMENT_PATHS) {
  const code = stripComments(readFile(rel));
  checkTrue(`對照組：${rel} 讀得到而且不是空殼`, code.length > 500);
  checkFalse(
    `${rel} 不呼叫 priceLines／createOrder／reserve_session_seat／isSessionClosedForBooking`,
    /\bpriceLines\(|\bcreateOrder\(|reserve_session_seat|isSessionClosedForBooking/.test(code),
  );
}
{
  const orders = stripComments(readFile("src/server/repos/orders.ts"));
  // reissuePayment（補付款）與 reportRemittance（匯款回報）也在 orders.ts，切出函式本體驗。
  for (const fn of ["reissuePayment", "reportRemittance", "getOrderByToken"]) {
    const start = orders.indexOf(`export async function ${fn}(`);
    const next = orders.indexOf("\nexport ", start + 10);
    const body = start >= 0 ? orders.slice(start, next < 0 ? undefined : next) : "";
    checkTrue(`切得出 ${fn} 的本體`, body.length > 100);
    checkFalse(
      `${fn} 不經過場次時間檢查`,
      /\bpriceLines\(|reserve_session_seat|isSessionClosedForBooking/.test(body),
    );
  }
  // 規則在 orders.ts 裡只出現在兩個地方：priceLines 的那一行與 RPC 錯誤對應。
  check(
    "orders.ts 裡 isSessionClosedForBooking( 只被呼叫一次（priceLines）",
    (orders.match(/isSessionClosedForBooking\(/g) ?? []).length,
    1,
  );
  const replayIdx = orders.indexOf("const replay = await findByIdempotencyKey(");
  const priceIdx = orders.indexOf("const lines = await priceLines(payload.items);");
  checkTrue(
    "replay 短路在 priceLines 之前（已成立的單重送不會被新規則擋）",
    replayIdx > 0 && replayIdx < priceIdx,
  );
}

// =============================================================================
console.log("\n[5] 規則本身（isSessionClosedForBooking）");
{
  const t = Date.parse("2026-12-04T08:30:00.000Z"); // 公東 12/4 16:30（台北）
  check("開始前 1 毫秒 → 收", isSessionClosedForBooking({ startsAt: iso(t) }, t - 1), false);
  check("開始那一刻 → 不收", isSessionClosedForBooking({ startsAt: iso(t) }, t), true);
  check("開始後 → 不收", isSessionClosedForBooking({ startsAt: iso(t) }, t + 1), true);
  check(
    "帶 +08:00 的字串與 Z 字串是同一個時間點（與伺服器時區無關）",
    isSessionClosedForBooking({ startsAt: "2026-12-04T16:30:00+08:00" }, t - 1),
    false,
  );
  check(
    "讀不懂的時間 → 不收（fail closed）",
    isSessionClosedForBooking({ startsAt: "not-a-date" }),
    true,
  );
  check("沒有時間 → 不收（fail closed）", isSessionClosedForBooking({ startsAt: null }), true);
}

// =============================================================================
console.log("\n[5b] 結帳頁：判斷時間來自 loader（SSR 與首次渲染同一個時間）");
{
  const page = stripComments(readFile("src/routes/checkout.index.tsx"));
  checkTrue("loader 回傳 now: Date.now()", /now: Date\.now\(\),/.test(page));
  checkTrue(
    "resolveDirectCheckout 收到 loader 的時間（不是各自的 Date.now()）",
    /resolveDirectCheckout\([\s\S]{0,400}\},\s*loadedAt,?\s*\)/.test(page),
  );
  checkTrue(
    "session_ended 有自己的標題「此場次已結束」",
    /direct\.reason === "session_ended"[\s\S]{0,80}PAGE\.directSessionEndedTitle/.test(page) &&
      page.includes('zh: "此場次已結束"'),
  );
  checkTrue(
    "購物車裡有已結束場次時講原因（sessionEndedWarning），送出鈕跟著 hasUnavailable 停用",
    /hasEndedSession \? PAGE\.sessionEndedWarning/.test(page) &&
      /disabled=\{submitting \|\| redirecting \|\| hasUnavailable/.test(page),
  );
}

// =============================================================================
console.log("\n[6] 0049 的形狀");
{
  const sql = readFile("supabase/migrations/0049_reserve_session_seat_reject_started.sql");
  const code = sql.replace(/--[^\n]*/g, "");
  checkTrue(
    "create or replace（不 drop，簽章不變）",
    /create or replace function public\.reserve_session_seat\(\s*p_order_id\s+uuid,\s*p_order_item_id\s+bigint,\s*p_session_id\s+uuid,\s*p_quantity\s+integer,\s*p_participants\s+jsonb\s*\)\s*returns integer/i.test(
      code,
    ),
  );
  checkFalse("沒有 drop function", /drop\s+function/i.test(code));
  checkTrue("用 DB 的 now() 判斷", /v_starts_at is null or v_starts_at <= now\(\)/.test(code));
  checkTrue("錯誤字串是 SESSION_STARTED", /raise exception 'SESSION_STARTED:%'/.test(code));
  const gate = code.indexOf("SESSION_STARTED");
  checkTrue(
    "④b 在 ⑥ 佔位（update seats_taken）之前",
    gate > 0 && gate < code.indexOf("set seats_taken = seats_taken + p_quantity"),
  );
  checkTrue(
    "只 grant service_role",
    /grant\s+execute on function public\.reserve_session_seat\([^)]*\) to service_role;/.test(
      code,
    ) &&
      /revoke execute on function public\.reserve_session_seat\([^)]*\) from anon, authenticated;/.test(
        code,
      ),
  );
  checkTrue(
    "security definer＋search_path=public",
    /security definer\s+set search_path = public/.test(code),
  );
}

console.log("\n" + "─".repeat(52));
console.log(
  `##SELFTEST## file=scripts/session-ended-checkout-selftest.mjs pass=${pass} fail=${fail}`,
);
console.log(
  `${fail === 0 ? green(`✓ 全部通過：${pass} passed, 0 failed`) : red(`✗ 有失敗：${pass} passed, ${fail} failed`)}`,
);
process.exit(fail === 0 ? 0 : 1);
