#!/usr/bin/env node
/**
 * mcp-outbound-selftest.mjs —— MCP 階段 C「對外動作」（src/server/mcp/outbound-tools.ts）
 *
 *   [1] resend_order_email：預設只寄管理員；寄給客人兩步確認（第一次只回 token 不寄）；
 *       錯 token／過期／參數被改／收件人被改／重放都拒絕；第二次才寄且只寄一次；不回地址
 *   [2] reissue_invoice：預覽不呼叫光貿／開立流程；實際只走 reissueInvoiceForOrder
 *   [3] request_invoice_void：不呼叫作廢；記申請；待處理判斷（pendingVoidRequests）與關閉申請
 *   [4] 沒有 cancel_order、不呼叫任何退款；預覽與實際都有稽核
 *   [5] 靜態：不 import 作廢／金流模組、不直接讀 process.env
 *
 * 🔴 絕不打外部服務：supabase-admin、email-outbox、notify、invoice-issuer、invoice-void、amego、
 *    email（Resend）、payuni 全部用 module.registerHooks 換成假的（範本：read-all-pages-selftest.mjs）。
 *
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15（module.registerHooks）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/mcp-outbound-selftest.mjs";
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

process.env.MCP_OAUTH_SECRET = "selftest-secret-0123456789abcdef-0123456789";
process.env.SITE_URL = "https://intervalbooks.tw";
delete process.env.RESEND_API_KEY;

// ── 假的 Supabase（記憶體表）───────────────────────────────────────────────
const tables = new Map();
const T = (name) => {
  if (!tables.has(name)) tables.set(name, []);
  return tables.get(name);
};
let nextAuditId = 1;
function builder(table) {
  const filters = [];
  let desc = false;
  let lim = null;
  const run = () => {
    let rows = T(table).filter((r) => filters.every((f) => f(r)));
    if (table === "orders") {
      rows = rows.map((o) => ({
        ...o,
        invoices: T("invoices").filter((i) => i.order_id === o.id),
      }));
    }
    if (desc) rows = [...rows].sort((a, b) => b.id - a.id);
    if (lim !== null) rows = rows.slice(0, lim);
    return rows;
  };
  const b = {
    select: () => b,
    eq: (c, v) => (filters.push((r) => r[c] === v), b),
    in: (c, vs) => (filters.push((r) => vs.includes(r[c])), b),
    order: (_c, o) => ((desc = o?.ascending === false), b),
    limit: (n) => ((lim = n), b),
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    insert: async (rec) => {
      if (table === "mcp_oauth_used_codes" && T(table).some((r) => r.jti === rec.jti)) {
        return { error: { code: "23505", message: "duplicate" } };
      }
      T(table).push(
        table === "mcp_audit_log"
          ? { id: nextAuditId++, created_at: new Date().toISOString(), ...rec }
          : rec,
      );
      return { error: null };
    },
    then(resolve, reject) {
      try {
        resolve({ data: run(), error: null });
      } catch (e) {
        reject(e);
      }
    },
  };
  return b;
}
globalThis.__fakeSupabase = {
  from: (t) => builder(t),
  rpc: () => {
    throw new Error("不應該打 rpc");
  },
};

// ── 假模組：每個 export 轉給 globalThis.__fakes[模組][名稱]，並計次 ──────────────
const calls = {};
const hit = (k) => (calls[k] = (calls[k] ?? 0) + 1);
globalThis.__fakes = {};
function fakeModule(spec, impl) {
  globalThis.__fakes[spec] = impl;
  const body = Object.keys(impl)
    .map(
      (k) =>
        `export const ${k} = (...a) => globalThis.__fakes[${JSON.stringify(spec)}][${JSON.stringify(k)}](...a);`,
    )
    .join("\n");
  return "data:text/javascript," + encodeURIComponent(body);
}

const O1 = "11111111-1111-4111-8111-111111111111"; // 已付款、發票已開立
const O2 = "22222222-2222-4222-8222-222222222222"; // 匯款未付
const O3 = "33333333-3333-4333-8333-333333333333"; // 已付款、發票開立失敗停止重試
const S1 = "99999999-9999-4999-8999-999999999999";
const CUST = "cust@example.com";
const ATT = ["att1@example.com", "att2@example.com"];

const outboxLog = { order: [], admin: [], reg: [] };
const FAKES = {
  "@/server/repos/email-outbox": {
    loadEmailCopy: async () => ({}),
    getOrderForNotify: async (id) => {
      const o = T("orders").find((r) => r.id === id);
      if (!o) return null;
      return {
        order: {
          id,
          orderNo: o.order_no,
          customerName: "王小明",
          total: o.total,
          locale: "zh",
          paymentMethod: o.payment_method,
          shippingMethod: "none",
          createdAt: "2026-11-01T00:00:00.000Z",
          needsContact: false,
          phoneOrder: null,
        },
        items: [
          {
            name: { zh: "城市沙龍", en: "Salon", ja: "サロン" },
            quantity: 2,
            subtotal: o.total,
            sessionId: S1,
          },
        ],
      };
    },
    getOrderPublicToken: async () => "public-token",
    enqueueOrderEmailResult: async (x) => (hit("enqueueOrder"), outboxLog.order.push(x), "queued"),
    enqueueAdminOrderEmail: async (x) => (hit("enqueueAdmin"), outboxLog.admin.push(x), true),
    enqueueRegistrationEmails: async (items) => (
      hit("enqueueReg"),
      outboxLog.reg.push(...items),
      items.length
    ),
  },
  "@/server/repos/event-registrations": {
    loadPaidRosterByOrder: async (id) =>
      id === O1
        ? ["r1", "r2"].map((rid, i) => ({
            registration_id: rid,
            session_id: S1,
            order_id: O1,
            seat_no: i + 1,
            name: `參加者${i + 1}`,
            has_email: true,
            order_no: "IB001",
          }))
        : [],
  },
  "@/server/repos/event-sessions": {
    getEventSessionById: async () => ({
      title: { zh: "城市沙龍", en: "Salon", ja: "サロン" },
      location: { zh: "台北", en: "Taipei", ja: "台北" },
      starts_at: "2026-11-20T10:00:00.000Z",
      ends_at: "2026-11-20T12:00:00.000Z",
    }),
  },
  "@/server/repos/site-settings": {
    getRemittanceAccount: async () => ({
      bankName: "測試銀行",
      bankCode: "000",
      bankAccount: "1234567890",
      accountName: "小時光",
    }),
  },
  "@/server/notify": { flushEmailOutbox: async () => (hit("flush"), { sent: 0 }) },
  "@/server/invoice-issuer": {
    reissueInvoiceForOrder: async () => (
      hit("reissue"),
      { reason: "issued", orderNo: "IB003", invoiceNumber: "ZZ00000001" }
    ),
    issueInvoiceForOrder: async () => (hit("issue"), { ok: false }),
  },
  "@/server/invoice-void": { voidInvoiceForOrder: async () => (hit("void"), {}) },
  "@/server/amego": {
    amegoConfigured: () => true,
    amegoRelayConfigured: () => true,
    issueInvoice: async () => (hit("amego"), {}),
    voidInvoice: async () => (hit("amego"), {}),
    findInvoiceByOrderId: async () => (hit("amego"), {}),
  },
  "@/server/email": {
    sendEmail: async () => (hit("resend"), { outcome: "dry_run" }),
    emailConfigured: () => false,
  },
  "@/server/payuni": { refund: async () => (hit("refund"), {}) },
};
const FAKE_URLS = Object.fromEntries(
  Object.entries(FAKES).map(([s, impl]) => [s, fakeModule(s, impl)]),
);
const FAKE_ADMIN =
  "data:text/javascript," +
  encodeURIComponent("export const supabaseAdmin = () => globalThis.__fakeSupabase;");

function resolveTs(base) {
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand) && /\.tsx?$/.test(cand)) return pathToFileURL(cand).href;
  }
  return null;
}
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@/server/supabase-admin") return { url: FAKE_ADMIN, shortCircuit: true };
    if (FAKE_URLS[spec]) return { url: FAKE_URLS[spec], shortCircuit: true };
    if (spec === "@tanstack/react-start/server-only")
      return { url: "data:text/javascript,", shortCircuit: true };
    if (spec.startsWith("@/")) {
      const url = resolveTs(join(SRC, spec.slice(2)));
      if (url) return { url, shortCircuit: true };
    }
    if (
      spec.startsWith(".") &&
      ctx.parentURL?.startsWith("file:") &&
      !/\.(m?js|json)$/.test(spec)
    ) {
      const url = resolveTs(fileURLToPath(new URL(spec, ctx.parentURL)));
      if (url) return { url, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

// ── 資料 ──────────────────────────────────────────────────────────────────
const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
T("orders").push(
  {
    id: O1,
    order_no: "IB001",
    status: "processing",
    payment_status: "paid",
    payment_method: "card",
    total: 1200,
    paid_at: old,
    notify_customer: true,
    customer_email: CUST,
  },
  {
    id: O2,
    order_no: "IB002",
    status: "pending",
    payment_status: "pending",
    payment_method: "transfer",
    total: 800,
    paid_at: null,
    notify_customer: true,
    customer_email: CUST,
  },
  {
    id: O3,
    order_no: "IB003",
    status: "processing",
    payment_status: "paid",
    payment_method: "card",
    total: 500,
    paid_at: old,
    notify_customer: true,
    customer_email: "o3@example.com",
  },
);
T("invoices").push(
  {
    order_id: O1,
    status: "issued",
    retry_count: 0,
    updated_at: old,
    invoice_number: "AB12345678",
    error_message: null,
  },
  {
    order_id: O3,
    status: "failed",
    retry_count: 5,
    updated_at: old,
    invoice_number: null,
    error_message: "IP 錯誤",
  },
);
T("site_settings").push({
  id: 1,
  notify_emails: "admin1@intervalbooks.tw, admin2@intervalbooks.tw",
});
T("event_registrations").push({ id: "r1", email: ATT[0] }, { id: "r2", email: ATT[1] });

const mod = await import(join(SRC, "server/mcp/outbound-tools.ts"));
const { OUTBOUND_TOOL_INPUTS, OUTBOUND_TOOL_META, OUTBOUND_HANDLERS } = mod;
const { pendingVoidRequests } = await import(join(SRC, "lib/mcp-void-requests.ts"));
const voidRepo = await import(join(SRC, "server/repos/mcp-void-requests.ts"));

const outputs = [];
async function call(tool, raw) {
  const args = OUTBOUND_TOOL_INPUTS[tool].parse(raw);
  try {
    const r = await OUTBOUND_HANDLERS[tool](args);
    const text = r.content[0].text;
    outputs.push(text);
    return { ok: true, json: JSON.parse(text) };
  } catch (e) {
    outputs.push(String(e?.message));
    return { ok: false, error: String(e?.message), name: e?.name ?? e?.constructor?.name };
  }
}
const audits = () => T("mcp_audit_log");
const lastAudit = () => audits().at(-1);
const c = (k) => calls[k] ?? 0;

console.log("═══ MCP 階段 C 對外動作 自檢 ═══");

// [1] ------------------------------------------------------------------------
console.log("\n[1] resend_order_email");
{
  const r = await call("resend_order_email", { order: "IB001", kind: "order_paid" });
  check("預設 dry_run=true、不寄", [r.ok, r.json.dry_run, r.json.sent], [true, true, false]);
  check("預設只算管理員收件人（2 位）", r.json.recipient_count, 2);
  check("預覽沒有排任何信", [c("enqueueAdmin"), c("enqueueOrder"), c("enqueueReg")], [0, 0, 0]);
  check(
    "預覽記稽核 dry_run=true",
    [lastAudit().action, lastAudit().dry_run, lastAudit().changes.target],
    ["email_resend_preview", true, "admin"],
  );
}
{
  const r = await call("resend_order_email", { order: O1, kind: "order_paid", dry_run: false });
  check(
    "send_to_customer 預設 false → 只寄管理員一封",
    [r.json.sent, c("enqueueAdmin"), c("enqueueOrder"), c("enqueueReg")],
    [true, 1, 0, 0],
  );
  check("管理員副本主旨有標示", outboxLog.admin[0].subject.startsWith("[重寄副本・管理員]"), true);
  check(
    "實際寄送記稽核 dry_run=false",
    [lastAudit().action, lastAudit().dry_run],
    ["email_resend", false],
  );
  check("排信後有沖寄件匣", c("flush"), 1);
}
{
  const r = await call("resend_order_email", {
    order: O1,
    kind: "session_reminder",
    dry_run: false,
  });
  check(
    "行前通知（管理員模式）也只寄一封副本給管理員",
    [c("enqueueAdmin"), c("enqueueReg")],
    [2, 0],
  );
  check("…說明原本會寄給 2 位", outboxLog.admin[1].text.includes("原本會寄給 2 位"), true);
  void r;
}

let token1;
{
  const before = audits().length;
  const r = await call("resend_order_email", {
    order: O1,
    kind: "order_paid",
    send_to_customer: true,
  });
  token1 = r.json.confirm_token;
  check(
    "寄客人第一次：只回 token、不寄",
    [r.json.sent, typeof token1, c("enqueueOrder")],
    [false, "string", 0],
  );
  check(
    "第一次回收件人數 1、主旨與摘要",
    [r.json.recipient_count, !!r.json.preview.subject, !!r.json.preview.summary],
    [1, true, true],
  );
  check(
    "第一次有記稽核（預覽）",
    [audits().length - before, lastAudit().dry_run, lastAudit().changes.target],
    [1, true, "customer"],
  );
}
{
  const r = await call("resend_order_email", {
    order: O1,
    kind: "order_paid",
    send_to_customer: true,
    dry_run: false,
  });
  check(
    "dry_run=false 但沒帶 token：仍只回 token、不寄",
    [r.json.sent, typeof r.json.confirm_token, c("enqueueOrder")],
    [false, "string", 0],
  );
}
{
  const bad = token1.slice(0, -3) + (token1.endsWith("AAA") ? "BBB" : "AAA");
  const r = await call("resend_order_email", {
    order: O1,
    kind: "order_paid",
    send_to_customer: true,
    dry_run: false,
    confirm_token: bad,
  });
  check("錯的 token 拒絕", [r.ok, /不是這個伺服器簽發/.test(r.error)], [false, true]);
  check(
    "…沒有寄、記了 rejected 稽核",
    [c("enqueueOrder"), lastAudit().action],
    [0, "email_resend_rejected"],
  );
}
{
  const r = await call("resend_order_email", {
    order: O3,
    kind: "order_paid",
    send_to_customer: true,
    dry_run: false,
    confirm_token: token1,
  });
  check(
    "參數被改（換訂單）拒絕",
    [r.ok, /參數/.test(r.error), c("enqueueOrder")],
    [false, true, 0],
  );
}
{
  const r = await call("resend_order_email", {
    order: O1,
    kind: "session_reminder",
    send_to_customer: true,
    dry_run: false,
    confirm_token: token1,
  });
  check(
    "參數被改（換信件種類）拒絕",
    [r.ok, /參數/.test(r.error), c("enqueueReg")],
    [false, true, 0],
  );
}
{
  T("orders")[0].customer_email = "changed@example.com";
  const r = await call("resend_order_email", {
    order: O1,
    kind: "order_paid",
    send_to_customer: true,
    dry_run: false,
    confirm_token: token1,
  });
  check(
    "收件人在預覽後被改：拒絕",
    [r.ok, /收件人/.test(r.error), c("enqueueOrder")],
    [false, true, 0],
  );
  T("orders")[0].customer_email = CUST;
}
{
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  const r = await call("resend_order_email", {
    order: O1,
    kind: "order_paid",
    send_to_customer: true,
    dry_run: false,
    confirm_token: token1,
  });
  Date.now = realNow;
  check("過期（11 分鐘後）拒絕", [r.ok, /過期/.test(r.error), c("enqueueOrder")], [false, true, 0]);
}
{
  const r = await call("resend_order_email", {
    order: O1,
    kind: "order_paid",
    send_to_customer: true,
    dry_run: false,
    confirm_token: token1,
  });
  check(
    "同參數＋正確 token＋dry_run=false：寄出一封給客人",
    [r.ok, r.json.sent, r.json.queued, c("enqueueOrder")],
    [true, true, 1, 1],
  );
  check(
    "…dedupe_key 含一次性 jti",
    /^mcp_resend:order_paid:.+:[0-9a-f-]{36}$/.test(outboxLog.order[0].dedupeKey),
    true,
  );
  check(
    "…稽核 dry_run=false、target=customer",
    [lastAudit().action, lastAudit().dry_run, lastAudit().changes.target],
    ["email_resend", false, "customer"],
  );
  check("…token 已被 consumeOnce 記下", T("mcp_oauth_used_codes").length, 1);
  const again = await call("resend_order_email", {
    order: O1,
    kind: "order_paid",
    send_to_customer: true,
    dry_run: false,
    confirm_token: token1,
  });
  check(
    "重放同一個 token 拒絕，仍只寄一次",
    [again.ok, /已經用過/.test(again.error), c("enqueueOrder")],
    [false, true, 1],
  );
}
{
  const p = await call("resend_order_email", {
    order: O1,
    kind: "session_reminder",
    send_to_customer: true,
  });
  check(
    "行前通知給客人：預覽收件人 2 位",
    [p.json.recipient_count, p.json.preview.mail_count, c("enqueueReg")],
    [2, 2, 0],
  );
  const r = await call("resend_order_email", {
    order: O1,
    kind: "session_reminder",
    send_to_customer: true,
    dry_run: false,
    confirm_token: p.json.confirm_token,
  });
  check(
    "…確認後排 2 封給參加者",
    [r.json.queued, c("enqueueReg"), outboxLog.reg.length],
    [2, 1, 2],
  );
}
{
  const p = await call("resend_order_email", {
    order: O2,
    kind: "remittance",
    send_to_customer: true,
  });
  check("匯款資訊信（未付款匯款單）可預覽", [p.ok, p.json.recipient_count], [true, 1]);
  const bad = await call("resend_order_email", { order: O1, kind: "remittance" });
  check("已付款訂單不寄匯款資訊信", bad.ok, false);
  const bad2 = await call("resend_order_email", { order: O2, kind: "order_paid" });
  check("未付款訂單沒有付款成功信", bad2.ok, false);
}
{
  const leaked = outputs.some((t) =>
    [CUST, ...ATT, "admin1@intervalbooks.tw", "changed@example.com"].some((e) => t.includes(e)),
  );
  check("所有工具輸出都沒有任何收件地址", leaked, false);
  const auditLeak = audits().some(
    (a) => JSON.stringify(a).includes(CUST) || ATT.some((e) => JSON.stringify(a).includes(e)),
  );
  check("稽核紀錄也沒有收件地址", auditLeak, false);
  check("全程沒有呼叫 Resend（sendEmail）", c("resend"), 0);
}

// [2] ------------------------------------------------------------------------
console.log("\n[2] reissue_invoice");
{
  const p = await call("reissue_invoice", { order: "IB003" });
  check(
    "預覽：can_reissue=true、目前狀態 failed",
    [p.json.dry_run, p.json.can_reissue, p.json.current.invoice_status],
    [true, true, "failed"],
  );
  check("預覽不呼叫開立流程、不打光貿", [c("reissue"), c("issue"), c("amego")], [0, 0, 0]);
  check("預覽記稽核", [lastAudit().action, lastAudit().dry_run], ["invoice_reissue", true]);
  const r = await call("reissue_invoice", { order: O3, dry_run: false });
  check("實際：只呼叫 reissueInvoiceForOrder 一次", [r.ok, c("reissue"), c("amego")], [true, 1, 0]);
  check("實際記稽核", [lastAudit().action, lastAudit().dry_run], ["invoice_reissue", false]);
  const no = await call("reissue_invoice", { order: O1, dry_run: false });
  check("已開立的發票不重開（不呼叫）", [no.ok, c("reissue")], [false, 1]);
}

// [3] ------------------------------------------------------------------------
console.log("\n[3] request_invoice_void");
{
  const p = await call("request_invoice_void", { order: O1, reason: "客人退票" });
  check(
    "預覽：不作廢",
    [p.json.dry_run, p.json.voided, c("void"), c("amego")],
    [true, false, 0, 0],
  );
  check(
    "預覽記稽核 dry_run=true（不算待辦）",
    [lastAudit().action, lastAudit().dry_run, (await voidRepo.loadPendingVoidRequests()).length],
    ["invoice_void_request", true, 0],
  );
  const r = await call("request_invoice_void", { order: O1, reason: "客人退票", dry_run: false });
  check(
    "實際：記申請、不作廢",
    [r.json.requested, r.json.voided, c("void"), c("amego")],
    [true, false, 0, 0],
  );
  const pend = await voidRepo.loadPendingVoidRequests();
  check(
    "後台待辦出現這筆",
    pend.map((x) => [x.order_no, x.invoice_number, x.reason]),
    [["IB001", "AB12345678", "客人退票"]],
  );
  const dup = await call("request_invoice_void", { order: O1, reason: "又一次", dry_run: false });
  check(
    "已有待處理就不重複建立",
    [dup.json.requested, (await voidRepo.loadPendingVoidRequests()).length],
    [false, 1],
  );
  await voidRepo.dismissVoidRequest({
    orderId: O1,
    adminUserId: "u1",
    adminEmail: "boss@intervalbooks.tw",
  });
  check("後台關閉申請後不再待處理", (await voidRepo.loadPendingVoidRequests()).length, 0);
  const bad = await call("request_invoice_void", { order: O3, reason: "x", dry_run: false });
  check("沒有已開立發票的訂單不能申請", bad.ok, false);
  const tooLong = await call("request_invoice_void", {
    order: O1,
    reason: "一二三四五六七八九十一二三四五六七八九十" + "x",
    dry_run: true,
  }).catch(() => ({ ok: false }));
  check("原因超過 20 字被 schema 擋下", tooLong.ok, false);
}
{
  const req = (id, order, number) => ({
    id,
    created_at: "2026-11-03T00:00:00Z",
    entity_id: order,
    action: "invoice_void_request",
    changes: { invoice_number: number, reason: "r" },
    actor_email: null,
    client_name: null,
  });
  const dis = (id, order) => ({
    id,
    created_at: "2026-11-03T00:00:00Z",
    entity_id: order,
    action: "invoice_void_request_dismissed",
    changes: {},
    actor_email: null,
    client_name: null,
  });
  const inv = (order, status, number) => ({
    order_id: order,
    order_no: "N",
    status,
    invoice_number: number,
  });
  check(
    "pending：已開立且號碼相同",
    pendingVoidRequests([req(1, "a", "AB00000001")], [inv("a", "issued", "AB00000001")]).length,
    1,
  );
  check(
    "已作廢 → 不再待處理",
    pendingVoidRequests([req(1, "a", "AB00000001")], [inv("a", "voided", "AB00000001")]).length,
    0,
  );
  check(
    "發票號碼換了 → 申請過時",
    pendingVoidRequests([req(1, "a", "AB00000001")], [inv("a", "issued", "AB00000002")]).length,
    0,
  );
  check(
    "關閉之後又申請 → 重新待處理",
    pendingVoidRequests(
      [req(1, "a", "AB00000001"), dis(2, "a"), req(3, "a", "AB00000001")],
      [inv("a", "issued", "AB00000001")],
    ).length,
    1,
  );
  check(
    "申請之後被關閉 → 不待處理",
    pendingVoidRequests(
      [req(1, "a", "AB00000001"), dis(2, "a")],
      [inv("a", "issued", "AB00000001")],
    ).length,
    0,
  );
}

// [4] ------------------------------------------------------------------------
console.log("\n[4] 取消／退款／稽核／annotations");
check("沒有 cancel_order（沒有既有的取消 RPC，不自建）", Object.keys(OUTBOUND_TOOL_INPUTS).sort(), [
  "reissue_invoice",
  "request_invoice_void",
  "resend_order_email",
]);
check("全程沒有呼叫任何退款", c("refund"), 0);
check("全程沒有呼叫作廢", c("void"), 0);
check(
  "每支都是非唯讀（唯讀連線會被 tools.ts 擋）",
  Object.values(OUTBOUND_TOOL_META).map((m) => m.annotations.readOnlyHint),
  [false, false, false],
);
check(
  "dry_run 預設皆為 true",
  Object.values(OUTBOUND_TOOL_INPUTS).map(
    (s) => s.parse({ order: O1, kind: "order_paid", reason: "r" }).dry_run,
  ),
  [true, true, true],
);
const actions = new Set(audits().map((a) => `${a.action}:${a.dry_run}`));
check(
  "預覽與實際都有稽核（三支工具）",
  [
    "email_resend_preview:true",
    "email_resend:false",
    "invoice_reissue:true",
    "invoice_reissue:false",
    "invoice_void_request:true",
    "invoice_void_request:false",
  ].every((k) => actions.has(k)),
  true,
);

// [5] ------------------------------------------------------------------------
console.log("\n[5] 靜態");
const srcText = readFileSync(join(SRC, "server/mcp/outbound-tools.ts"), "utf8").replace(
  /^\s*(\*|\/\/).*$/gm,
  "",
);
check(
  "不 import 作廢接線（@/server/invoice-void）",
  srcText.includes('"@/server/invoice-void"'),
  false,
);
check("不 import 金流（payuni）", /payuni/i.test(srcText), false);
check("不直接讀 process.env（只經 env.ts）", srcText.includes("process.env"), false);
check("不 import Resend 寄送（@/server/email）", srcText.includes('"@/server/email"'), false);

console.log(`\n${fail === 0 ? green("全部通過") : red("有失敗")}：${pass} 通過，${fail} 失敗`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
