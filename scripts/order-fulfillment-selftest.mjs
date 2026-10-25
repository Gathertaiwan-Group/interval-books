#!/usr/bin/env node
/**
 * order-fulfillment-selftest.mjs —— 後台「標記已出貨／已取貨／已完成」的自檢。
 *
 *   [純邏輯]  直接 import src/lib/admin/order-fulfillment.ts（零 import），窮舉
 *             status × payment_status × paid_at × shipping_method 的組合，驗證哪一顆
 *             按鈕會出現、0 列更新時怎麼分類。
 *   [shim]    把 @/server/supabase-admin 換成一個**記憶體裡的 orders 表**，驅動
 *             src/server/repos/order-fulfillment.ts 本人：conditional update 的每一個
 *             篩選條件都真的被套用在那一列上（不是只檢查字串），所以「少了
 *             .eq("status", from)」會讓已取消的訂單被改成已出貨，這裡會紅。
 *   [靜態]    server fn 掛 adminFnMiddleware（AST）、actorId 只認 context.admin.userId、
 *             這條路徑沒有寄信／發票／庫存、列表與首頁「待出貨」用同一組條件。
 *
 * 不碰任何資料庫，也不需要網路。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";
import { parse as parseJs } from "@babel/parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/order-fulfillment-selftest.mjs";

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
const checkTrue = (label, v) => check(label, v === true, true);

/** 讀不到就丟例外，不回空字串（run-selftests.mjs 守門 4）。 */
function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

const F = await import(pathToFileURL(join(ROOT, "src/lib/admin/order-fulfillment.ts")).href);

const PAID_AT = "2026-10-20T03:00:00.000Z";
const base = { status: "processing", payment_status: "paid", paid_at: PAID_AT };

// =============================================================================
console.log("\n[1] 哪一顆按鈕會出現");
// =============================================================================
check(
  "宅配＋已付款＋處理中 → ship",
  F.availableFulfillmentAction({ ...base, shipping_method: "home" }),
  "ship",
);
check(
  "超商＋已付款＋處理中 → ship",
  F.availableFulfillmentAction({ ...base, shipping_method: "cvs" }),
  "ship",
);
check(
  "自取＋已付款＋處理中 → pickup",
  F.availableFulfillmentAction({ ...base, shipping_method: "pickup" }),
  "pickup",
);
check(
  "🔴 純票券（none）→ 沒有按鈕",
  F.availableFulfillmentAction({ ...base, shipping_method: "none" }),
  null,
);
check(
  "已出貨（宅配）→ complete",
  F.availableFulfillmentAction({ ...base, status: "shipped", shipping_method: "home" }),
  "complete",
);
check(
  "已出貨（超商）→ complete",
  F.availableFulfillmentAction({ ...base, status: "shipped", shipping_method: "cvs" }),
  "complete",
);
for (const status of ["pending", "completed", "cancelled", "failed"]) {
  for (const m of ["home", "cvs", "pickup", "none"]) {
    check(
      `status=${status}、${m} → 沒有按鈕`,
      F.availableFulfillmentAction({ ...base, status, shipping_method: m }),
      null,
    );
  }
}
for (const ps of ["pending", "failed", "refunded"]) {
  check(
    `🔴 payment_status=${ps}（宅配、處理中）→ 沒有按鈕`,
    F.availableFulfillmentAction({ ...base, payment_status: ps, shipping_method: "home" }),
    null,
  );
}
check(
  "🔴 payment_status=paid 但 paid_at 是 null → 沒有按鈕（兩欄都要成立）",
  F.availableFulfillmentAction({ ...base, paid_at: null, shipping_method: "home" }),
  null,
);
check(
  "🔴 paid_at 有值但 payment_status=pending → 沒有按鈕",
  F.availableFulfillmentAction({ ...base, payment_status: "pending", shipping_method: "cvs" }),
  null,
);

// =============================================================================
console.log("\n[2] 狀態轉換表");
// =============================================================================
check("ship：processing → shipped、home/cvs、蓋 shipped_at", F.FULFILLMENT_TRANSITIONS.ship, {
  from: "processing",
  to: "shipped",
  methods: ["home", "cvs"],
  stampColumn: "shipped_at",
});
check("pickup：processing → completed、pickup、蓋 completed_at", F.FULFILLMENT_TRANSITIONS.pickup, {
  from: "processing",
  to: "completed",
  methods: ["pickup"],
  stampColumn: "completed_at",
});
check(
  "complete：shipped → completed、home/cvs、蓋 completed_at",
  F.FULFILLMENT_TRANSITIONS.complete,
  { from: "shipped", to: "completed", methods: ["home", "cvs"], stampColumn: "completed_at" },
);
check("待出貨條件 = ship 的條件", F.TO_SHIP_FILTER, {
  status: "processing",
  payment_status: "paid",
  shipping_methods: ["home", "cvs"],
});

// =============================================================================
console.log("\n[3] 0 列更新後的分類");
// =============================================================================
check(
  "ship 之後已經是 shipped → already_done",
  F.classifyAfterNoop("ship", { ...base, status: "shipped", shipping_method: "home" }),
  "already_done",
);
check(
  "ship 之後已經 completed 且有 shipped_at → already_done",
  F.classifyAfterNoop("ship", {
    ...base,
    status: "completed",
    shipping_method: "home",
    shipped_at: PAID_AT,
  }),
  "already_done",
);
check(
  "ship 但訂單已取消 → ineligible",
  F.classifyAfterNoop("ship", { ...base, status: "cancelled", shipping_method: "home" }),
  "ineligible",
);
check(
  "ship 但未付款（pending）→ ineligible",
  F.classifyAfterNoop("ship", {
    ...base,
    status: "pending",
    payment_status: "pending",
    shipping_method: "home",
  }),
  "ineligible",
);
check(
  "🔴 ship 但收件方式是 pickup（即使 status=shipped 也不算做過）→ ineligible",
  F.classifyAfterNoop("ship", { ...base, status: "shipped", shipping_method: "pickup" }),
  "ineligible",
);
check(
  "pickup 之後已經 completed → already_done",
  F.classifyAfterNoop("pickup", { ...base, status: "completed", shipping_method: "pickup" }),
  "already_done",
);
check(
  "complete 之後已經 completed → already_done",
  F.classifyAfterNoop("complete", { ...base, status: "completed", shipping_method: "cvs" }),
  "already_done",
);
check(
  "complete 但還在 processing → ineligible",
  F.classifyAfterNoop("complete", { ...base, shipping_method: "cvs" }),
  "ineligible",
);

// =============================================================================
console.log("\n[4] 二次確認的文字");
// =============================================================================
{
  const d = F.confirmDescription("ship", "IB20261022-0001");
  checkTrue("講出訂單編號", d.includes("IB20261022-0001"));
  checkTrue("講出狀態從「處理中」改成「已出貨」", d.includes("從「處理中」改成「已出貨」"));
  const dm = F.confirmDescription("ship", "IB20261022-0001", "ab***@example.com");
  checkTrue(
    "ship：講出會寄出貨通知信給遮罩後的信箱",
    dm.includes("並寄出貨通知信給 ab***@example.com"),
  );
  check("ship：不再說「不會寄信」", dm.includes("不會寄信"), false);
  checkTrue("ship：沒有信箱時寫「訂購人信箱」", d.includes("並寄出貨通知信給 訂購人信箱"));
  checkTrue(
    "pickup：仍然講出不會寄信",
    F.confirmDescription("pickup", "X", "ab***@example.com").includes("不會寄信"),
  );
  checkTrue(
    "complete：仍然講出不會寄信",
    F.confirmDescription("complete", "X", "ab***@example.com").includes("不會寄信"),
  );
  checkTrue(
    "pickup 的文字是「處理中」→「已完成」",
    F.confirmDescription("pickup", "X").includes("從「處理中」改成「已完成」"),
  );
  checkTrue(
    "complete 的文字是「已出貨」→「已完成」",
    F.confirmDescription("complete", "X").includes("從「已出貨」改成「已完成」"),
  );
  check("按鈕文字", F.ACTION_BUTTON_LABEL, {
    ship: "標記已出貨",
    pickup: "標記已取貨",
    complete: "標記已完成",
  });
}

// =============================================================================
console.log("\n[5] shim：驅動 src/server/repos/order-fulfillment.ts 本人");
// =============================================================================
// 記憶體裡的 orders 表 + 一個只實作這支 repo 用到的方法的 query builder。
// 篩選條件是**真的套用**在列上，不是只記錄字串。
globalThis.__OF_SHIM__ = {
  rows: new Map(),
  calls: [],
  // [7] 出貨通知信用：其他幾張只讀的表＋假的 email_outbox（dedupe_key unique）。
  tables: { order_items: [], order_addresses: [], site_settings: [], email_copy: [] },
  outbox: new Map(),
  enqueueFail: false,
  rpcCalls: [],
};
const SHIM_SRC = `
const S = globalThis.__OF_SHIM__;
function builder(table) {
  const st = { table, op: "select", patch: null, filters: [], single: false };
  const match = (r) => st.filters.every(([k, col, v]) => {
    if (k === "eq") return r[col] === v;
    if (k === "in") return v.includes(r[col]);
    if (k === "notnull") return r[col] !== null && r[col] !== undefined;
    throw new Error("unknown filter " + k);
  });
  const run = () => {
    S.calls.push({ op: st.op, filters: st.filters.map((f) => f.slice()), patch: st.patch });
    const source = st.table === "orders" ? [...S.rows.values()] : S.tables[st.table];
    if (!source) throw new Error("shim 沒有 " + st.table + " 表");
    if (st.op === "update" && st.table !== "orders") throw new Error("shim 只能寫 orders 表");
    const hit = source.filter(match);
    if (st.op === "update") for (const r of hit) Object.assign(r, st.patch);
    const data = hit.map((r) => ({ ...r }));
    return st.single ? { data: data[0] ?? null, error: null } : { data, error: null };
  };
  const b = {
    update(p) { st.op = "update"; st.patch = p; return b; },
    select() { return b; },
    eq(c, v) { st.filters.push(["eq", c, v]); return b; },
    in(c, v) { st.filters.push(["in", c, v]); return b; },
    not(c, op, v) {
      if (op !== "is" || v !== null) throw new Error("shim 只支援 not(col, 'is', null)");
      st.filters.push(["notnull", c]); return b;
    },
    order() { return b; },
    maybeSingle() { st.single = true; return Promise.resolve(run()); },
    then(res, rej) { return Promise.resolve(run()).then(res, rej); },
  };
  return b;
}
// 假的 enqueue_order_email：與 0022 §7 同語意——地址從 orders join、沒有信箱不排、
// on conflict (dedupe_key) do nothing、回 true 只代表這一次真的新增了一列。
async function rpc(name, args) {
  S.rpcCalls.push({ name, args });
  if (name === "enqueue_order_email") {
    if (S.enqueueFail) return { data: null, error: { code: "XX000", message: "shim enqueue fail" } };
    const o = S.rows.get(args.p_order_id);
    if (!o || !o.customer_email) return { data: false, error: null };
    if (S.outbox.has(args.p_dedupe_key)) return { data: false, error: null };
    S.outbox.set(args.p_dedupe_key, {
      to_email: o.customer_email,
      subject: args.p_subject,
      body_text: args.p_body_text,
      body_html: args.p_body_html,
    });
    return { data: true, error: null };
  }
  if (name === "claim_email_batch") return { data: [], error: null };
  throw new Error("shim 沒有 rpc " + name);
}
export function supabaseAdmin() { return { from: builder, rpc }; }
`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@/server/supabase-admin")
      return { url: "stub:of-supabase-admin", shortCircuit: true };
    if (spec === "@tanstack/react-start/server-only")
      return { url: "stub:server-only", shortCircuit: true };
    if (spec.startsWith("@/")) {
      return {
        url: pathToFileURL(join(ROOT, "src", `${spec.slice(2)}.ts`)).href,
        shortCircuit: true,
      };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === "stub:of-supabase-admin")
      return { format: "module", source: SHIM_SRC, shortCircuit: true };
    if (url === "stub:server-only")
      return { format: "module", source: "export {};", shortCircuit: true };
    return next(url, ctx);
  },
});

const R = await import(pathToFileURL(join(ROOT, "src/server/repos/order-fulfillment.ts")).href);
const S = globalThis.__OF_SHIM__;
const ACTOR = "22222222-2222-2222-2222-222222222222";
function seed(id, over) {
  S.rows.set(id, {
    id,
    order_no: `T-${id.slice(0, 4)}`,
    status: "processing",
    payment_status: "paid",
    paid_at: PAID_AT,
    shipping_method: "home",
    shipped_at: null,
    completed_at: null,
    ...over,
  });
}
// 結構化稽核 log 抓下來檢查
const logs = [];
const origLog = console.log;
function capture(fn) {
  return async (...a) => {
    console.log = (...x) => logs.push(x.join(" "));
    try {
      return await fn(...a);
    } finally {
      console.log = origLog;
    }
  };
}
const advance = capture(R.advanceOrderFulfillment);

{
  seed("aaaa0000", {});
  const r1 = await advance({ orderId: "aaaa0000", actorId: ACTOR, action: "ship" });
  check(
    "宅配已付款 ship → updated",
    [r1.updated, r1.reason, r1.status],
    [true, "updated", "shipped"],
  );
  checkTrue("shipped_at 被蓋上時間", typeof S.rows.get("aaaa0000").shipped_at === "string");
  check("completed_at 沒被動", S.rows.get("aaaa0000").completed_at, null);
  const upd = S.calls.find((c) => c.op === "update");
  check("🔴 conditional update 的篩選條件齊全", upd.filters, [
    ["eq", "id", "aaaa0000"],
    ["eq", "status", "processing"],
    ["eq", "payment_status", "paid"],
    ["notnull", "paid_at"],
    ["in", "shipping_method", ["home", "cvs"]],
  ]);
  check("🔴 patch 只有 status 與 shipped_at 兩欄", Object.keys(upd.patch).sort(), [
    "shipped_at",
    "status",
  ]);
  const audit = logs.find((l) => l.startsWith("[order-status] "));
  checkTrue("寫了一行 [order-status] 稽核 log", Boolean(audit));
  const entry = JSON.parse(audit.slice("[order-status] ".length));
  check(
    "稽核 log 的內容（action／from／to／actor）",
    [entry.event, entry.action, entry.order_id, entry.from, entry.to, entry.actor_id],
    ["order_status_changed", "ship", "aaaa0000", "processing", "shipped", ACTOR],
  );
  checkTrue("🔴 稽核 log 沒有客人個資欄位", !/customer_|email|phone|recipient/.test(audit));

  const firstShippedAt = S.rows.get("aaaa0000").shipped_at;
  const r2 = await advance({ orderId: "aaaa0000", actorId: ACTOR, action: "ship" });
  check("再按一次 ship → already_done（冪等）", [r2.updated, r2.reason], [false, "already_done"]);
  check("冪等：shipped_at 沒被改寫", S.rows.get("aaaa0000").shipped_at, firstShippedAt);

  const r3 = await advance({ orderId: "aaaa0000", actorId: ACTOR, action: "complete" });
  check("已出貨 complete → updated、completed", [r3.reason, r3.status], ["updated", "completed"]);
  checkTrue("completed_at 被蓋上時間", typeof S.rows.get("aaaa0000").completed_at === "string");
  const r4 = await advance({ orderId: "aaaa0000", actorId: ACTOR, action: "ship" });
  check("已完成之後舊分頁再按 ship → already_done", r4.reason, "already_done");
}
{
  seed("bbbb0000", { status: "cancelled" });
  const r = await advance({ orderId: "bbbb0000", actorId: ACTOR, action: "ship" });
  check(
    "🔴 已取消的訂單 ship → ineligible，狀態不變",
    [r.reason, S.rows.get("bbbb0000").status],
    ["ineligible", "cancelled"],
  );
  seed("cccc0000", { payment_status: "pending", paid_at: null, status: "pending" });
  const r2 = await advance({ orderId: "cccc0000", actorId: ACTOR, action: "ship" });
  check(
    "🔴 未付款 ship → ineligible，狀態不變",
    [r2.reason, S.rows.get("cccc0000").status],
    ["ineligible", "pending"],
  );
  seed("dddd0000", { payment_status: "paid", paid_at: null });
  const r3 = await advance({ orderId: "dddd0000", actorId: ACTOR, action: "ship" });
  check(
    "🔴 paid 但 paid_at 是 null → ineligible",
    [r3.reason, S.rows.get("dddd0000").status],
    ["ineligible", "processing"],
  );
  seed("eeee0000", { shipping_method: "none" });
  const r4 = await advance({ orderId: "eeee0000", actorId: ACTOR, action: "ship" });
  check(
    "🔴 純票券 ship → ineligible",
    [r4.reason, S.rows.get("eeee0000").status],
    ["ineligible", "processing"],
  );
  const r5 = await advance({ orderId: "eeee0000", actorId: ACTOR, action: "pickup" });
  check(
    "🔴 純票券 pickup → ineligible",
    [r5.reason, S.rows.get("eeee0000").status],
    ["ineligible", "processing"],
  );
  seed("ffff0000", { shipping_method: "pickup" });
  const r6 = await advance({ orderId: "ffff0000", actorId: ACTOR, action: "ship" });
  check(
    "🔴 自取訂單不能 ship",
    [r6.reason, S.rows.get("ffff0000").status],
    ["ineligible", "processing"],
  );
  const r7 = await advance({ orderId: "ffff0000", actorId: ACTOR, action: "pickup" });
  check(
    "自取 pickup → completed",
    [r7.reason, S.rows.get("ffff0000").status],
    ["updated", "completed"],
  );
  check("自取不蓋 shipped_at", S.rows.get("ffff0000").shipped_at, null);
  const r8 = await advance({ orderId: "ffff0000", actorId: ACTOR, action: "pickup" });
  check("自取再按一次 → already_done", r8.reason, "already_done");
  const r9 = await advance({ orderId: "99990000", actorId: ACTOR, action: "ship" });
  check("不存在的訂單 → order_not_found", [r9.reason, r9.order_no], ["order_not_found", null]);
  seed("abab0000", { status: "processing", shipping_method: "cvs" });
  const r10 = await advance({ orderId: "abab0000", actorId: ACTOR, action: "complete" });
  check(
    "處理中直接 complete（跳過出貨）→ ineligible",
    [r10.reason, S.rows.get("abab0000").status],
    ["ineligible", "processing"],
  );
}

// =============================================================================
console.log("\n[6] 靜態：授權、沒有寄信、列表與首頁同一組條件");
// =============================================================================
{
  const fnsRaw = read("src/lib/admin/fns/orders.ts");
  const ast = parseJs(fnsRaw, { sourceType: "module", plugins: ["typescript"] });
  let decl = null;
  for (const stmt of ast.program.body) {
    if (stmt.type !== "ExportNamedDeclaration" || stmt.declaration?.type !== "VariableDeclaration")
      continue;
    for (const d of stmt.declaration.declarations) {
      if (d.id?.name === "advanceOrderFulfillmentAdmin") decl = d;
    }
  }
  checkTrue("fns/orders.ts 匯出 advanceOrderFulfillmentAdmin", Boolean(decl));
  let hasMw = false;
  let cur = decl?.init;
  while (cur?.type === "CallExpression") {
    const c = cur.callee;
    if (c.type === "MemberExpression" && c.property?.name === "middleware") {
      const arg = cur.arguments[0];
      hasMw ||=
        arg?.type === "ArrayExpression" &&
        arg.elements.some((e) => e?.type === "Identifier" && e.name === "adminFnMiddleware");
    }
    cur = c.type === "MemberExpression" ? c.object : null;
  }
  checkTrue("🔴 advanceOrderFulfillmentAdmin 掛 adminFnMiddleware（AST）", hasMw);
  const fnSrc = fnsRaw.slice(decl.start, decl.end);
  checkTrue(
    "🔴 actorId 只認 context.admin.userId",
    /actorId:\s*context\.admin\.userId/.test(fnSrc),
  );
  checkTrue("input 沒有 actorId 欄位", !/actorId:\s*z\./.test(fnSrc));
  const fnCode = stripComments(fnSrc);
  checkTrue("🔴 這支 fn 不開發票", !/invoice|amego/i.test(fnCode));
  checkTrue(
    "這支 fn 的編排走 runFulfillmentWithNotify（只在真的出貨時寄信）",
    /runFulfillmentWithNotify\(data\.action,/.test(fnCode),
  );
  checkTrue(
    "寄信只透過 triggerNotifyAfterShipped（notifyShipped 依賴）",
    /notifyShipped:[\s\S]*triggerNotifyAfterShipped\(data\.orderId\)/.test(fnCode) &&
      (fnCode.match(/@\/server\/notify/g) ?? []).length === 1,
  );

  const repo = stripComments(read("src/server/repos/order-fulfillment.ts"));
  checkTrue(
    "🔴 repo 不 import 任何寄信／通知／發票／金流／庫存模組",
    !/from\s+"@\/server\/(notify|email|invoice-issuer|amego|payuni|blackcat|repos\/(payments|orders|invoices|email-outbox|inv-))/.test(
      repo,
    ) && !/import\(\s*"@\/server\/(notify|email)/.test(repo),
  );
  checkTrue("🔴 repo 沒有 rpc()／delete()／insert()", !/\.(rpc|delete|insert|upsert)\(/.test(repo));
  checkTrue(
    "repo 只寫 orders 表",
    (repo.match(/\.from\("([a-z_]+)"\)/g) ?? []).every((m) => m === '.from("orders")'),
  );
  checkTrue('conditional update：.eq("status", t.from)', /\.eq\("status", t\.from\)/.test(repo));
  checkTrue(
    'conditional update：.eq("payment_status", "paid")',
    /\.eq\("payment_status", "paid"\)/.test(repo),
  );
  checkTrue(
    'conditional update：.not("paid_at", "is", null)',
    /\.not\("paid_at", "is", null\)/.test(repo),
  );
  checkTrue(
    'conditional update：.in("shipping_method", …)',
    /\.in\("shipping_method", \[\.\.\.t\.methods\]\)/.test(repo),
  );

  const list = stripComments(read("src/server/repos/orders-admin.ts"));
  const todo = stripComments(read("src/server/repos/admin-todo.ts"));
  for (const [label, src] of [
    ["列表 scope=to_ship", list],
    ["首頁 toShip 計數", todo],
  ]) {
    checkTrue(
      `${label}：status = TO_SHIP_FILTER.status`,
      src.includes('.eq("status", TO_SHIP_FILTER.status)'),
    );
    checkTrue(
      `${label}：payment_status = TO_SHIP_FILTER.payment_status`,
      src.includes('.eq("payment_status", TO_SHIP_FILTER.payment_status)'),
    );
    checkTrue(`${label}：paid_at is not null`, src.includes('.not("paid_at", "is", null)'));
    checkTrue(
      `${label}：shipping_method in TO_SHIP_FILTER.shipping_methods`,
      src.includes('.in("shipping_method", [...TO_SHIP_FILTER.shipping_methods])'),
    );
  }
  checkTrue(
    "🔴 orders-admin.ts 仍然沒有任何 .update()（寫入只在 order-fulfillment.ts）",
    !/\.update\(/.test(list),
  );

  // 2026-10-25：詳情從列表頁的 Dialog 搬到 /admin/orders/$id（_shell.orders_.$id.tsx）。
  //   列表相關（分頁、列表狀態欄）看 route，詳情相關看 detailRoute。
  const route = stripComments(read("src/routes/admin/_shell.orders.tsx"));
  const detailRoute = stripComments(read("src/routes/admin/_shell.orders_.$id.tsx"));
  const labels = stripComments(read("src/lib/admin/order-labels.ts"));
  checkTrue(
    "詳情的按鈕由 availableFulfillmentAction() 決定",
    /availableFulfillmentAction\(detail\)/.test(detailRoute),
  );
  checkTrue(
    "有二次確認（confirmDescription，帶訂購人信箱）",
    /confirmDescription\(fulfillAction, detail\.order_no, detail\.customer_email\)/.test(
      detailRoute,
    ),
  );
  checkTrue(
    "詳情顯示出貨時間（formatTaipeiDateTime）",
    /formatTaipeiDateTime\(detail\.shipped_at\)/.test(detailRoute),
  );
  checkTrue("有「待出貨」分頁", /value="to_ship"/.test(route));
  checkTrue(
    "按鈕旁的說明：ship 講會寄出貨通知信、不再說不會寄信",
    /ship: "[^"]*寄出貨通知信[^"]*"/.test(detailRoute) && !/ship: "[^"]*不會寄信/.test(detailRoute),
  );
  checkTrue(
    "排信失敗時顯示 notify_warning（toast.warning）",
    /if \(result\.notify_warning\) toast\.warning\(result\.notify_warning\)/.test(detailRoute),
  );
  checkTrue("列表顯示訂單狀態", /STATUS_LABEL\[o\.status\]/.test(route));
  checkTrue(
    "STATUS_LABEL 有 已出貨／已完成",
    /shipped: "已出貨"/.test(labels) && /completed: "已完成"/.test(labels),
  );
}

// =============================================================================
console.log("\n[7] 出貨通知信：只在 processing → shipped 真的發生時排一封");
// =============================================================================
// 驅動的是產線本人：runFulfillmentWithNotify（server fn 的編排）＋
// advanceOrderFulfillment（記憶體 orders 表）＋ notify.ts 的 triggerNotifyAfterShipped
// （假的 email_outbox，dedupe_key unique 的語意與 0022 §7 相同）。
process.env.SITE_URL = "https://intervalbooks.example.com";
const N = await import(pathToFileURL(join(ROOT, "src/server/notify.ts")).href);
{
  check("dedupe key 格式", N.dedupeKeys.orderShipped("OID"), "order_shipped:OID");
  check(
    "dedupe key 與其他信的前綴都不同",
    Object.entries(N.dedupeKeys)
      .filter(([k]) => k !== "orderShipped")
      .some(([, f]) => f("OID") === "order_shipped:OID"),
    false,
  );

  check("shouldSendShippedEmail(ship, updated)", F.shouldSendShippedEmail("ship", "updated"), true);
  for (const [a, r] of [
    ["ship", "already_done"],
    ["ship", "ineligible"],
    ["ship", "order_not_found"],
    ["pickup", "updated"],
    ["complete", "updated"],
    ["pickup", "already_done"],
    ["complete", "already_done"],
  ]) {
    check(`shouldSendShippedEmail(${a}, ${r}) = false`, F.shouldSendShippedEmail(a, r), false);
  }
  check("warning：queued → null", F.shippedNotifyWarning({ status: "queued" }), null);
  check("warning：duplicate → null", F.shippedNotifyWarning({ status: "duplicate" }), null);
  check(
    "warning：failed → 狀態已更新，但通知信排入失敗",
    F.shippedNotifyWarning({ status: "failed", reason: "enqueue_error" }),
    "狀態已更新，但通知信排入失敗",
  );

  S.tables.site_settings.push({ id: 1, contact_email: "hello@shop.example.com" });
  const seedShip = (id, over, addr) => {
    seed(id, {
      customer_email: "buyer@example.com",
      customer_name: "林小明",
      locale: "zh",
      public_token: "tok_" + id,
      ...over,
    });
    S.tables.order_items.push({
      order_id: id,
      name: { zh: "島嶼書寫", en: "Island Writing", ja: "島の書" },
      quantity: 2,
      subtotal: 760,
    });
    if (addr) S.tables.order_addresses.push({ order_id: id, type: "shipping", ...addr });
  };
  let notifyCalls = 0;
  const run = (orderId, action) =>
    F.runFulfillmentWithNotify(action, {
      advance: () => advance({ orderId, actorId: ACTOR, action }),
      notifyShipped: () => {
        notifyCalls += 1;
        return N.triggerNotifyAfterShipped(orderId);
      },
    });
  const keysFor = (id) => [...S.outbox.keys()].filter((k) => k.endsWith(id));

  // ---- 宅配：真的出貨 → 一封 -------------------------------------------------
  seedShip(
    "a1a10000",
    {},
    {
      recipient: "林小明",
      phone: "0912345678",
      postal_code: "106",
      city: "臺北市",
      district: "大安區",
      street: "羅斯福路三段 1 號",
    },
  );
  const r1 = await run("a1a10000", "ship");
  check("宅配 ship → updated、無警告", [r1.reason, r1.notify_warning], ["updated", null]);
  check("🔴 恰好排進一封，key = order_shipped:<id>", keysFor("a1a10000"), [
    "order_shipped:a1a10000",
  ]);
  const m1 = S.outbox.get("order_shipped:a1a10000");
  check("收件人來自 orders.customer_email（SQL join）", m1.to_email, "buyer@example.com");
  checkTrue(
    "主旨有訂單編號與「已出貨」",
    m1.subject.includes("T-a1a1") && m1.subject.includes("已出貨"),
  );
  checkTrue("內文是宅配的說法", m1.body_text.includes("宅配") && !m1.body_text.includes("超商"));
  checkTrue("內文列出品項", m1.body_text.includes("島嶼書寫 × 2"));
  checkTrue("內文有收件地址", m1.body_text.includes("106 臺北市大安區羅斯福路三段 1 號"));
  checkTrue(
    "🔴 內文不印電話",
    !m1.body_text.includes("0912345678") && !m1.body_html.includes("0912345678"),
  );
  checkTrue("內文有店家聯絡信箱", m1.body_text.includes("hello@shop.example.com"));
  checkTrue(
    "內文有訂單頁連結（/checkout/complete?token=…）",
    m1.body_text.includes("https://intervalbooks.example.com/checkout/complete?token=tok_a1a10000"),
  );
  checkTrue(
    "HTML 版也有內容",
    m1.body_html.includes("羅斯福路三段") && m1.body_html.includes("<h1"),
  );

  // ---- 冪等 no-op：不叫通知 --------------------------------------------------
  const callsBefore = notifyCalls;
  const r2 = await run("a1a10000", "ship");
  check(
    "再按一次 ship → already_done、無警告",
    [r2.reason, r2.notify_warning],
    ["already_done", null],
  );
  check("🔴 no-op 不呼叫寄信", notifyCalls, callsBefore);
  check("🔴 仍然只有一封", keysFor("a1a10000").length, 1);

  // ---- 就算真的又被叫一次，dedupe_key 擋住 ----------------------------------
  const again = await N.queueOrderShippedEmail("a1a10000");
  check("重排一次 → duplicate", again, { status: "duplicate" });
  check("🔴 dedupe：仍然只有一封", keysFor("a1a10000").length, 1);

  // ---- 已出貨 → 已完成：不寄 ---------------------------------------------
  const outboxSize = S.outbox.size;
  const r3 = await run("a1a10000", "complete");
  check(
    "complete → updated、無警告",
    [r3.reason, r3.status, r3.notify_warning],
    ["updated", "completed", null],
  );
  check("🔴 complete 不呼叫寄信", notifyCalls, callsBefore);
  check("🔴 complete 不排信", S.outbox.size, outboxSize);

  // ---- 門市自取 → 已取貨：不寄 -------------------------------------------
  seedShip("b1b10000", { shipping_method: "pickup" }, null);
  const r4 = await run("b1b10000", "pickup");
  check("pickup → updated", [r4.reason, r4.notify_warning], ["updated", null]);
  check("🔴 pickup 不排信", keysFor("b1b10000"), []);
  check("🔴 pickup 不呼叫寄信", notifyCalls, callsBefore);

  // ---- 未付款：ineligible，不寄 ------------------------------------------
  seedShip("c1c10000", { payment_status: "pending", paid_at: null, status: "pending" }, null);
  const r5 = await run("c1c10000", "ship");
  check("未付款 ship → ineligible", r5.reason, "ineligible");
  check("🔴 ineligible 不排信", keysFor("c1c10000"), []);

  // ---- 超商：說法不同、印門市 ---------------------------------------------
  seedShip(
    "d1d10000",
    { shipping_method: "cvs", locale: "zh" },
    {
      recipient: "林小明",
      phone: "0912345678",
      cvs_store_id: "123456",
      cvs_store_name: "7-ELEVEN 台大門市",
      cvs_address: "臺北市大安區新生南路三段 2 號",
    },
  );
  const r6 = await run("d1d10000", "ship");
  check("超商 ship → updated", r6.reason, "updated");
  const m6 = S.outbox.get("order_shipped:d1d10000");
  checkTrue("超商：內文是超商的說法", Boolean(m6) && m6.body_text.includes("超商門市"));
  checkTrue("超商：印出門市名稱與代號", m6.body_text.includes("7-ELEVEN 台大門市 (123456)"));
  checkTrue("超商：不是宅配的說法", !m6.body_text.includes("交給宅配"));

  // ---- 英文訂單用英文寫 ---------------------------------------------------
  seedShip("e1e10000", { locale: "en" }, null);
  await run("e1e10000", "ship");
  const m7 = S.outbox.get("order_shipped:e1e10000");
  checkTrue("英文訂單 → 英文主旨", Boolean(m7) && m7.subject.includes("has shipped"));
  checkTrue("英文訂單 → 英文品名", m7.body_text.includes("Island Writing × 2"));

  // ---- 🔴 排信失敗：狀態照樣成立、回警告 ----------------------------------
  seedShip("f1f10000", {}, null);
  S.enqueueFail = true;
  const r8 = await run("f1f10000", "ship");
  S.enqueueFail = false;
  check(
    "🔴 排信失敗 → 仍然 updated，附警告",
    [r8.updated, r8.reason, r8.notify_warning],
    [true, "updated", "狀態已更新，但通知信排入失敗"],
  );
  check("🔴 排信失敗不回滾狀態", S.rows.get("f1f10000").status, "shipped");
  check("排信失敗 → 沒有列", keysFor("f1f10000"), []);

  // ---- 🔴 寄信那一段整個 throw：狀態照樣成立、回警告 ------------------------
  seedShip("a2a20000", {}, null);
  const r9 = await F.runFulfillmentWithNotify("ship", {
    advance: () => advance({ orderId: "a2a20000", actorId: ACTOR, action: "ship" }),
    notifyShipped: async () => {
      throw new Error("boom");
    },
  });
  check(
    "🔴 notify throw → 仍然 updated，附警告",
    [r9.reason, r9.notify_warning, S.rows.get("a2a20000").status],
    ["updated", "狀態已更新，但通知信排入失敗", "shipped"],
  );

  // ---- advance 本身失敗：照樣往外丟，而且沒寄信 ----------------------------
  let threw = false;
  const callsNow = notifyCalls;
  try {
    await F.runFulfillmentWithNotify("ship", {
      advance: async () => {
        throw new Error("db down");
      },
      notifyShipped: () => {
        notifyCalls += 1;
        return Promise.resolve({ status: "queued" });
      },
    });
  } catch {
    threw = true;
  }
  checkTrue("狀態寫入失敗 → 錯誤照樣往外丟", threw);
  check("狀態寫入失敗 → 不寄信", notifyCalls, callsNow);

  // ---- 跳脫 ---------------------------------------------------------------
  const x = await import(pathToFileURL(join(ROOT, "src/lib/email-templates.ts")).href);
  const esc = x.renderOrderShippedEmail(
    {
      orderNo: "IB-1",
      customerName: "<script>",
      shippingMethod: "home",
      items: [],
      address: null,
      orderUrl: null,
      contactEmail: null,
    },
    {},
    "zh",
  );
  checkTrue(
    "姓名在 HTML 裡被跳脫",
    !esc.html.includes("<script>") && esc.html.includes("&lt;script&gt;"),
  );
  checkTrue("沒有連結時不印連結", !esc.html.includes("<a "));
}

// =============================================================================
console.log("\n[8] 靜態：出貨通知信的邊界");
// =============================================================================
{
  const notifySrc = stripComments(read("src/server/notify.ts"));
  checkTrue(
    "notify.ts 的出貨信用 dedupeKeys.orderShipped",
    /dedupeKey: dedupeKeys\.orderShipped\(orderId\)/.test(notifySrc),
  );
  const repo = stripComments(read("src/server/repos/order-fulfillment.ts"));
  checkTrue(
    "🔴 寫狀態的 repo 仍然不碰寄信（寄信在 server fn 寫入之後另外做）",
    !/notify|email|outbox/i.test(repo),
  );
}

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
