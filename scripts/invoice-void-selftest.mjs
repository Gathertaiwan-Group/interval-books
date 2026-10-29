#!/usr/bin/env node
/**
 * invoice-void-selftest.mjs —— 後台「作廢發票」的自檢（業主 2026-10-29）
 *
 *   [1] 輸入：作廢原因 1–20 字、發票號碼格式、按鈕何時出現、開立日期換算台北
 *   [2] Amego 回應分類：成功／已作廢（3050131 與字樣）／跨期／發票不存在／IP／逾時
 *   [3] 逾時後查詢的解讀
 *   [4] 流程（runInvoiceVoid，假的 DB 與 Amego）：成功、Amego 失敗、已作廢、狀態不是
 *       issued 被拒、並發第二次被拒、逾時後查詢確認（已作廢／仍有效／查不到）、寫回失敗
 *   [5] 給業主看的文字
 *   [6] 接線：server fn 掛 adminFnMiddleware、actorId 只從 context 來、Amego 走
 *       voidInvoice/amegoRequest、按鈕只看伺服器算的 invoice_can_void、告警排除 voided
 *
 * 🔴 這支**不會**呼叫 Amego。[4] 的 callVoid／queryByOrderNo 全是假的；[6] 只讀原始碼。
 *
 * 執行：node scripts/invoice-void-selftest.mjs（或 npm test）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/invoice-void-selftest.mjs";

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

const V = await import(pathToFileURL(join(ROOT, "src/lib/invoice-void.ts")).href);

const ORDER_ID = "5d83c6dd-0000-4000-8000-000000000001";
const NUMBER = "FN59177150";
const ORDER_NO = "IB-202600001200";
const ISSUED_AT = "2026-10-20 10:30:38+00"; // 台北 2026-10-20 18:30
const ACTOR = "11111111-2222-4333-8444-555555555555";

// ── [1] 輸入 ──────────────────────────────────────────────────────────────
console.log("\n[1] 輸入");
check("空原因被擋", V.normalizeVoidReason("   ").ok, false);
check("非字串被擋", V.normalizeVoidReason(undefined).ok, false);
check("去頭尾空白", V.normalizeVoidReason("  測試訂單 "), { ok: true, reason: "測試訂單" });
check("剛好 20 字可以", V.normalizeVoidReason("一".repeat(20)).ok, true);
check("21 字被擋", V.normalizeVoidReason("一".repeat(21)).ok, false);
checkTrue("發票號碼格式", V.isInvoiceNumber(NUMBER));
check("小寫字軌不算", V.isInvoiceNumber("fn59177150"), false);
check("9 碼數字不算", V.isInvoiceNumber("FN5917715"), false);
checkTrue(
  "issued＋號碼 → 顯示按鈕",
  V.canVoidInvoice({ status: "issued", invoice_number: NUMBER }),
);
check(
  "issued 但沒號碼 → 不顯示",
  V.canVoidInvoice({ status: "issued", invoice_number: null }),
  false,
);
for (const st of ["pending", "issuing", "failed", "voided"]) {
  check(`${st} → 不顯示`, V.canVoidInvoice({ status: st, invoice_number: NUMBER }), false);
}
check("沒有發票列 → 不顯示", V.canVoidInvoice(null), false);
check("開立日期換算台北（不是今天）", V.invoiceDateForVoid(ISSUED_AT), "20261020");
check("UTC 16:30 跨日 → 台北隔天", V.invoiceDateForVoid("2026-10-20T16:30:00Z"), "20261021");
check("沒有 issued_at → undefined", V.invoiceDateForVoid(null), undefined);
check("壞掉的時間 → undefined", V.invoiceDateForVoid("not-a-date"), undefined);

// ── [2] Amego 回應分類 ─────────────────────────────────────────────────────
console.log("\n[2] Amego 回應分類");
check("code 0 → voided", V.classifyVoidCall({ ok: true }).kind, "voided");
check(
  "3050131 等待作廢 → already_voided",
  V.classifyVoidCall({ ok: false, kind: "business", code: 3050131, msg: "等待作廢" }).kind,
  "already_voided",
);
check(
  "訊息含「已作廢」但碼不是 3050131 → maybe_voided（要查詢確認，不直接當成功）",
  V.classifyVoidCall({ ok: false, kind: "business", code: 3050199, msg: "此發票已作廢" }).kind,
  "maybe_voided",
);
check(
  "「發票不存在或已作廢」→ maybe_voided，不是 already_voided",
  V.classifyVoidCall({ ok: false, kind: "business", code: 3050125, msg: "發票不存在或已作廢" })
    .kind,
  "maybe_voided",
);
check(
  "訊息只有「作廢原因不可為空」不算已作廢",
  V.classifyVoidCall({ ok: false, kind: "business", code: 3050120, msg: "作廢原因不可為空" }).kind,
  "rejected",
);
check(
  "跨期 → rejected/cross_period",
  V.classifyVoidCall({ ok: false, kind: "business", code: 3050140, msg: "發票已跨期，不可作廢" }),
  { kind: "rejected", code: 3050140, msg: "發票已跨期，不可作廢", hint: "cross_period" },
);
check(
  "超過作廢期限 → cross_period",
  V.classifyVoidCall({ ok: false, kind: "business", code: 3050141, msg: "已超過作廢期限" }).hint,
  "cross_period",
);
check(
  "3050125 發票不存在 → not_found",
  V.classifyVoidCall({ ok: false, kind: "business", code: 3050125, msg: "發票不存在" }).hint,
  "not_found",
);
check(
  "code 14 → ip",
  V.classifyVoidCall({ ok: false, kind: "business", code: 14, msg: "IP 未被允許" }).hint,
  "ip",
);
check(
  "逾時 → uncertain",
  V.classifyVoidCall({ ok: false, kind: "transport", code: null, msg: "timeout_after_15000ms" })
    .kind,
  "uncertain",
);

// ── [3] 查詢的解讀 ─────────────────────────────────────────────────────────
console.log("\n[3] 逾時後查詢的解讀");
const hit = (o) => ({
  ok: true,
  hit: { invoiceNumber: NUMBER, invoiceType: "C0401", pendingVoid: false, ...o },
});
check(
  "wait 有 C0501 → 已作廢",
  V.classifyVoidQuery(hit({ pendingVoid: true }), NUMBER).kind,
  "confirmed_voided",
);
check(
  "類別 C0501 → 已作廢",
  V.classifyVoidQuery(hit({ invoiceType: "C0501" }), NUMBER).kind,
  "confirmed_voided",
);
check("C0401 沒有待作廢 → 仍有效", V.classifyVoidQuery(hit({}), NUMBER).kind, "confirmed_valid");
check(
  "號碼不同 → unknown",
  V.classifyVoidQuery(hit({ invoiceNumber: "XX00000000", pendingVoid: true }), NUMBER).kind,
  "unknown",
);
check("查無資料 → unknown", V.classifyVoidQuery({ ok: true, hit: null }, NUMBER).kind, "unknown");
check(
  "查詢失敗 → unknown",
  V.classifyVoidQuery({ ok: false, msg: "timeout" }, NUMBER).kind,
  "unknown",
);

// ── [4] 流程 ──────────────────────────────────────────────────────────────
console.log("\n[4] 流程（假的 DB 與 Amego，不會真的作廢任何發票）");

/** 模擬 0047：一列發票＋for update 語意（單執行緒裡 claim 是原子的）。 */
function makeDb(init = {}) {
  const row = {
    id: "inv-1",
    status: "issued",
    invoice_number: NUMBER,
    issued_at: ISSUED_AT,
    locked: false,
    voided_at: null,
    void_reason: null,
    voided_by: null,
    ...init,
  };
  const calls = { claim: 0, finish: 0, release: 0 };
  let tokenSeq = 0;
  return {
    row,
    calls,
    async claim(orderId, invoiceNumber) {
      calls.claim += 1;
      if (orderId !== ORDER_ID) return { claimed: false, reason: "order_not_found", status: null };
      if (row.status === "voided")
        return { claimed: false, reason: "already_voided", status: row.status };
      if (row.status !== "issued")
        return { claimed: false, reason: "not_issued", status: row.status };
      if (row.invoice_number !== invoiceNumber)
        return { claimed: false, reason: "number_mismatch", status: row.status };
      if (row.locked) return { claimed: false, reason: "locked", status: row.status };
      tokenSeq += 1;
      row.locked = `token-${tokenSeq}`;
      return {
        claimed: true,
        invoiceId: row.id,
        orderNo: ORDER_NO,
        invoiceNumber: row.invoice_number,
        issuedAt: row.issued_at,
        total: 300,
        lockToken: row.locked,
      };
    },
    async finish({ invoiceId, invoiceNumber, reason, actorId }) {
      calls.finish += 1;
      if (init.finishThrows) throw new Error("PGRST 503");
      if (invoiceId === row.id && row.status === "issued" && row.invoice_number === invoiceNumber) {
        Object.assign(row, {
          status: "voided",
          voided_at: "now",
          void_reason: reason,
          voided_by: actorId,
          locked: false,
        });
        return "voided";
      }
      return row.status === "voided" ? "already_voided" : "not_issued";
    },
    async release(invoiceId, lockToken) {
      calls.release += 1;
      // 0047：只放掉自己那一把（locked_at = p_lock_token）。
      if (invoiceId === row.id && row.status === "issued" && row.locked === lockToken)
        row.locked = false;
    },
  };
}

function makeDeps(db, { voidResult, queryResult, onVoid } = {}) {
  const amego = { void: [], query: [] };
  return {
    amego,
    deps: {
      claim: db.claim,
      finish: db.finish,
      release: db.release,
      async callVoid(p) {
        amego.void.push(p);
        if (onVoid) await onVoid();
        return voidResult ?? { ok: true };
      },
      async queryByOrderNo(orderNo) {
        amego.query.push(orderNo);
        return queryResult ?? { ok: false, msg: "not stubbed" };
      },
    },
  };
}
const input = (o = {}) => ({
  orderId: ORDER_ID,
  invoiceNumber: NUMBER,
  reason: "測試訂單",
  actorId: ACTOR,
  ...o,
});
const unchanged = (row) => ({
  status: row.status,
  voided_at: row.voided_at,
  void_reason: row.void_reason,
  voided_by: row.voided_by,
  locked: row.locked,
});
const UNCHANGED = {
  status: "issued",
  voided_at: null,
  void_reason: null,
  voided_by: null,
  locked: false,
};

// (a) 成功
{
  const db = makeDb();
  const { deps, amego } = makeDeps(db, { voidResult: { ok: true } });
  const out = await V.runInvoiceVoid(input(), deps);
  check(
    "(a) 成功 → voided via amego",
    { ok: out.ok, kind: out.kind, via: out.via },
    { ok: true, kind: "voided", via: "amego" },
  );
  check("(a) 送出作廢一次", amego.void.length, 1);
  check("(a) 帶原開立日期（台北）、不是今天", amego.void[0].invoiceDate, "20261020");
  check("(a) 帶原因", amego.void[0].reason, "測試訂單");
  check(
    "(a) DB：voided＋原因＋操作者",
    { s: db.row.status, r: db.row.void_reason, a: db.row.voided_by },
    { s: "voided", r: "測試訂單", a: ACTOR },
  );
  check("(a) 成功後沒有 release", db.calls.release, 0);
  check("(a) 成功不查詢", amego.query.length, 0);
}

// (b) Amego 失敗
{
  const db = makeDb();
  const { deps, amego } = makeDeps(db, {
    voidResult: { ok: false, kind: "business", code: 3050125, msg: "發票不存在" },
  });
  const out = await V.runInvoiceVoid(input(), deps);
  check(
    "(b) Amego 失敗 → amego_rejected 帶錯誤碼與訊息",
    { kind: out.kind, code: out.code, msg: out.msg, hint: out.hint },
    { kind: "amego_rejected", code: 3050125, msg: "發票不存在", hint: "not_found" },
  );
  check("(b) DB 完全不動（鎖也放掉）", unchanged(db.row), UNCHANGED);
  check("(b) 沒有 finish", db.calls.finish, 0);
  check("(b) 不重送、不查詢", [amego.void.length, amego.query.length], [1, 0]);
}
// (b2) 跨期
{
  const db = makeDb();
  const { deps } = makeDeps(db, {
    voidResult: { ok: false, kind: "business", code: 3050140, msg: "發票已跨期，不可作廢" },
  });
  const out = await V.runInvoiceVoid(input(), deps);
  check("(b2) 跨期 → cross_period", [out.kind, out.hint], ["amego_rejected", "cross_period"]);
  check("(b2) DB 不動", unchanged(db.row), UNCHANGED);
  checkTrue("(b2) 中文說明提到折讓", /折讓/.test(V.describeVoidOutcome(out).text));
}

// (c) 已作廢（Amego 回 3050131）→ 視為成功、同步 DB
{
  const db = makeDb();
  const { deps } = makeDeps(db, {
    voidResult: { ok: false, kind: "business", code: 3050131, msg: "等待作廢" },
  });
  const out = await V.runInvoiceVoid(input(), deps);
  check(
    "(c) 3050131 → voided via already",
    [out.ok, out.kind, out.via],
    [true, "voided", "already"],
  );
  check("(c) DB 同步成 voided", db.row.status, "voided");
}

// (d) 狀態不是 issued → 被拒，完全不打 Amego
for (const st of ["pending", "failed", "issuing"]) {
  const db = makeDb({ status: st });
  const { deps, amego } = makeDeps(db);
  const out = await V.runInvoiceVoid(input(), deps);
  check(
    `(d) ${st} → claim_rejected/not_issued`,
    [out.kind, out.reason],
    ["claim_rejected", "not_issued"],
  );
  check(`(d) ${st} → 沒有打 Amego`, amego.void.length, 0);
}
{
  const db = makeDb({ status: "voided" });
  const { deps, amego } = makeDeps(db);
  const out = await V.runInvoiceVoid(input(), deps);
  check(
    "(d) DB 已是 voided → already_voided、不打 Amego",
    [out.reason, amego.void.length],
    ["already_voided", 0],
  );
  check("(d) 已作廢的說明是 info", V.describeVoidOutcome(out).tone, "info");
}
{
  const db = makeDb();
  const { deps, amego } = makeDeps(db);
  const out = await V.runInvoiceVoid(input({ invoiceNumber: "AB12345678" }), deps);
  check(
    "(d) 號碼對不上 → number_mismatch、不打 Amego",
    [out.reason, amego.void.length],
    ["number_mismatch", 0],
  );
}
{
  const db = makeDb();
  const { deps, amego } = makeDeps(db);
  const out = await V.runInvoiceVoid(input({ reason: "" }), deps);
  check(
    "(d) 沒填原因 → invalid_input、連 claim 都不做",
    [out.kind, db.calls.claim, amego.void.length],
    ["invalid_input", 0, 0],
  );
  const out2 = await V.runInvoiceVoid(input({ reason: "一".repeat(21) }), deps);
  check("(d) 原因 21 字 → invalid_input", out2.kind, "invalid_input");
}

// (e) 並發：第一個還在等 Amego 時，第二個被鎖擋下
{
  const db = makeDb();
  let releaseFirst;
  const gate = new Promise((r) => (releaseFirst = r));
  const { deps, amego } = makeDeps(db, { voidResult: { ok: true }, onVoid: () => gate });
  const first = V.runInvoiceVoid(input(), deps);
  await new Promise((r) => setTimeout(r, 0));
  const second = await V.runInvoiceVoid(input(), deps);
  check(
    "(e) 第二次 → claim_rejected/locked",
    [second.kind, second.reason],
    ["claim_rejected", "locked"],
  );
  check("(e) 第二次沒有打 Amego", amego.void.length, 1);
  check("(e) 第二次沒有放掉第一個的鎖", db.row.locked, "token-1");
  releaseFirst();
  const firstOut = await first;
  check("(e) 第一次照常成功", [firstOut.ok, db.row.status], [true, "voided"]);
  const third = await V.runInvoiceVoid(input(), deps);
  check(
    "(e) 完成之後再按 → already_voided，不再打 Amego",
    [third.reason, amego.void.length],
    ["already_voided", 1],
  );
}

// (f) 逾時後查詢確認
{
  const db = makeDb();
  const { deps, amego } = makeDeps(db, {
    voidResult: { ok: false, kind: "transport", code: null, msg: "timeout_after_15000ms" },
    queryResult: {
      ok: true,
      hit: { invoiceNumber: NUMBER, invoiceType: "C0401", pendingVoid: true },
    },
  });
  const out = await V.runInvoiceVoid(input(), deps);
  check("(f) 逾時＋查到待作廢 → voided via query", [out.ok, out.via], [true, "query"]);
  check(
    "(f) 只送一次作廢（不盲目重送）、查詢一次用訂單編號",
    [amego.void.length, amego.query],
    [1, [ORDER_NO]],
  );
  check("(f) DB 同步成 voided", db.row.status, "voided");
}
{
  const db = makeDb();
  const { deps, amego } = makeDeps(db, {
    voidResult: { ok: false, kind: "transport", code: null, msg: "timeout_after_15000ms" },
    queryResult: {
      ok: true,
      hit: { invoiceNumber: NUMBER, invoiceType: "C0401", pendingVoid: false },
    },
  });
  const out = await V.runInvoiceVoid(input(), deps);
  check("(f) 逾時＋查到仍有效 → not_voided", out.kind, "not_voided");
  check("(f) DB 不動、鎖放掉（可以再按）", unchanged(db.row), UNCHANGED);
  check("(f) 不重送", amego.void.length, 1);
}
{
  const db = makeDb();
  const { deps, amego } = makeDeps(db, {
    voidResult: { ok: false, kind: "transport", code: null, msg: "unexpected_response http=502" },
    queryResult: { ok: false, msg: "code=- timeout" },
  });
  const out = await V.runInvoiceVoid(input(), deps);
  check("(f) 逾時＋查詢也失敗 → uncertain", out.kind, "uncertain");
  check("(f) DB 不動", unchanged(db.row), UNCHANGED);
  check("(f) 不重送", amego.void.length, 1);
  checkTrue(
    "(f) 說明叫人不要到光貿後台另外作廢",
    /不要到光貿後台另外作廢/.test(V.describeVoidOutcome(out).text),
  );
}

// (g) Amego 成功但寫回 DB 失敗
{
  const db = makeDb({ finishThrows: true });
  const { deps } = makeDeps(db, { voidResult: { ok: true } });
  const out = await V.runInvoiceVoid(input(), deps);
  check("(g) 寫回失敗 → db_write_failed", out.kind, "db_write_failed");
  check("(g) 鎖放掉（再按一次會拿到 3050131 → 同步）", db.row.locked, false);
  checkTrue("(g) 說明提到光貿已作廢", /光貿已作廢/.test(V.describeVoidOutcome(out).text));
}

// (h) 訊息像已作廢、碼不是 3050131：查詢確認才同步
{
  const db = makeDb();
  const { deps, amego } = makeDeps(db, {
    voidResult: { ok: false, kind: "business", code: 3050125, msg: "發票不存在或已作廢" },
    queryResult: {
      ok: true,
      hit: { invoiceNumber: NUMBER, invoiceType: "C0401", pendingVoid: false },
    },
  });
  const out = await V.runInvoiceVoid(input(), deps);
  check(
    "(h) 查到仍有效 → amego_rejected，不記成作廢",
    [out.kind, out.code],
    ["amego_rejected", 3050125],
  );
  check("(h) DB 不動", unchanged(db.row), UNCHANGED);
  check("(h) 有查詢、不重送", [amego.void.length, amego.query.length], [1, 1]);
}
{
  const db = makeDb();
  const { deps } = makeDeps(db, {
    voidResult: { ok: false, kind: "business", code: 3050199, msg: "此發票已作廢" },
    queryResult: {
      ok: true,
      hit: { invoiceNumber: NUMBER, invoiceType: "C0401", pendingVoid: true },
    },
  });
  const out = await V.runInvoiceVoid(input(), deps);
  check(
    "(h) 查到待作廢 → 同步成 voided",
    [out.ok, out.via, db.row.status],
    [true, "already", "voided"],
  );
}
{
  const db = makeDb();
  const { deps } = makeDeps(db, {
    voidResult: { ok: false, kind: "business", code: 3050199, msg: "此發票已作廢" },
    queryResult: { ok: false, msg: "timeout" },
  });
  const out = await V.runInvoiceVoid(input(), deps);
  check(
    "(h) 查詢失敗 → uncertain、DB 不動",
    [out.kind, unchanged(db.row)],
    ["uncertain", UNCHANGED],
  );
}

// (i) 沒有開立時間 → 不送（不退回用今天）
{
  const db = makeDb({ issued_at: null });
  const { deps, amego } = makeDeps(db);
  const out = await V.runInvoiceVoid(input(), deps);
  check(
    "(i) 沒有 issued_at → missing_issue_date、沒打 Amego",
    [out.kind, amego.void.length],
    ["missing_issue_date", 0],
  );
  check("(i) 鎖放掉、DB 不動", unchanged(db.row), UNCHANGED);
}

// (j) 鎖過期被接手：舊請求的 release 不會放掉新請求的鎖
{
  const db = makeDb();
  const { deps } = makeDeps(db, {
    voidResult: { ok: false, kind: "business", code: 3050125, msg: "發票不存在" },
    onVoid: async () => {
      // 模擬舊請求卡太久、鎖過期，別的請求接手拿到新的一把
      db.row.locked = "token-from-someone-else";
    },
  });
  await V.runInvoiceVoid(input(), deps);
  check("(j) 別人的鎖還在", db.row.locked, "token-from-someone-else");
}

// ── [5] 文字 ──────────────────────────────────────────────────────────────
console.log("\n[5] 給業主看的文字");
const rejected = {
  ok: false,
  kind: "amego_rejected",
  code: 3050125,
  msg: "發票不存在",
  hint: "not_found",
  orderNo: ORDER_NO,
  invoiceNumber: NUMBER,
};
checkTrue("Amego 失敗的訊息帶錯誤碼", V.describeVoidOutcome(rejected).text.includes("3050125"));
checkTrue("Amego 失敗的訊息帶原訊息", V.describeVoidOutcome(rejected).text.includes("發票不存在"));
checkTrue(
  "Amego 失敗說系統資料沒有變動",
  V.describeVoidOutcome(rejected).text.includes("系統資料沒有變動"),
);
check(
  "成功是 success",
  V.describeVoidOutcome({
    ok: true,
    kind: "voided",
    via: "amego",
    orderNo: ORDER_NO,
    invoiceNumber: NUMBER,
  }).tone,
  "success",
);

// ── [6] 接線 ──────────────────────────────────────────────────────────────
console.log("\n[6] 接線");
const fns = stripComments(read("src/lib/admin/fns/invoices.ts"));
const voidFn = fns.slice(fns.indexOf("export const voidInvoiceAdmin"));
checkTrue("voidInvoiceAdmin 存在", fns.includes("export const voidInvoiceAdmin"));
checkTrue(
  "voidInvoiceAdmin 是 POST",
  /voidInvoiceAdmin = createServerFn\(\{ method: "POST" \}\)/.test(voidFn),
);
checkTrue(
  "voidInvoiceAdmin 掛 adminFnMiddleware",
  /^[\s\S]{0,120}\.middleware\(\[adminFnMiddleware\]\)/.test(
    voidFn.slice(voidFn.indexOf("createServerFn")),
  ),
);
checkTrue("actorId 只從 context.admin.userId 來", /actorId: context\.admin\.userId/.test(voidFn));
check(
  "inputValidator 沒有 actorId 欄位",
  /inputValidator\([\s\S]*?actorId[\s\S]*?\)\s*\.handler/.test(voidFn),
  false,
);

const srv = stripComments(read("src/server/invoice-void.ts"));
checkTrue("server 接線走 runInvoiceVoid", srv.includes("runInvoiceVoid("));
checkTrue(
  "Amego 只走 amego.ts 的 voidInvoice",
  /voidInvoice\(\{ invoiceNumber, invoiceDate, reason \}\)/.test(srv),
);
check("server 接線沒有自己 fetch", /\bfetch\(/.test(srv), false);
checkTrue("中繼沒設定就不送", /amegoRelayConfigured\(\)/.test(srv));
checkTrue("逾時查詢用 findInvoiceByOrderId", /queryByOrderNo: findInvoiceByOrderId/.test(srv));

const amego = stripComments(read("src/server/amego.ts"));
const vi = amego.slice(
  amego.indexOf("export async function voidInvoice"),
  amego.indexOf("export type InvoiceQueryHit"),
);
checkTrue(
  "voidInvoice 經過 amegoRequest（中繼由 amegoTransport 決定）",
  vi.includes('amegoRequest("/json/f0501"'),
);

const repo = stripComments(read("src/server/repos/invoices.ts"));
for (const rpc of ["claim_invoice_void", "finish_invoice_void", "release_invoice_void"]) {
  checkTrue(`repo 呼叫 ${rpc} RPC（鎖在資料庫）`, repo.includes(`rpc("${rpc}"`));
}

const mig = read("supabase/migrations/0047_invoice_void.sql").replace(/--.*$/gm, "");
checkTrue(
  "0047 claim 用 for update",
  /from public\.invoices i\s+where i\.order_id = p_order_id\s+for update/.test(mig),
);
checkTrue("0047 claim 要求 status = issued", /v_inv\.status <> 'issued'/.test(mig));
checkTrue(
  "0047 finish 是條件式 update",
  /where i\.id = p_invoice_id\s+and i\.status = 'issued'\s+and i\.invoice_number = p_invoice_number/.test(
    mig,
  ),
);
checkTrue(
  "0047 release 只放自己那一把（locked_at = p_lock_token）",
  /and i\.locked_at = p_lock_token/.test(mig),
);
checkTrue(
  "0047 三支函式只 grant service_role",
  /revoke execute on function %s from public/.test(mig) &&
    /grant  execute on function %s to service_role/.test(mig),
);

const page = stripComments(read("src/routes/admin/_shell.orders_.$id.tsx"));
checkTrue("按鈕只看伺服器算的 invoice_can_void", /\{detail\.invoice_can_void \? \(/.test(page));
checkTrue("確認框寫「作廢後無法復原」", page.includes("作廢後無法復原"));
checkTrue(
  "確認框顯示發票號碼與金額",
  /發票號碼 \$\{detail\.invoice\?\.invoice_number/.test(page) &&
    /金額 \$\{money\(detail\.total\)\}/.test(page),
);
checkTrue("原因欄位限 20 字", /maxLength=\{VOID_REASON_MAX\}/.test(page));
checkTrue("沒填原因不能按確定", /disabled=\{voiding \|\| !voidReasonCheck\.ok\}/.test(page));
checkTrue("作廢後畫面顯示作廢原因", /作廢原因<\/dt>/.test(page));
checkTrue(
  "動作後 router.invalidate({ sync: true })",
  /submitVoid[\s\S]*?await refresh\(\)/.test(page) &&
    /router\.invalidate\(\{ sync: true \}\)/.test(page),
);

const detailRepo = stripComments(read("src/server/repos/orders-admin.ts"));
checkTrue(
  "detail 由 canVoidInvoice 算 invoice_can_void",
  /invoice_can_void: canVoidInvoice\(invoice\)/.test(detailRepo),
);
checkTrue(
  "detail 撈 void_reason 與 issued_at",
  /issued_at, voided_at, void_reason/.test(detailRepo),
);

const alertsLib = read("src/lib/invoice-alerts.ts");
const alertsSrv = read("src/server/invoice-alerts.ts");
checkTrue("告警判斷排除 voided", /status === "voided"\) return false/.test(alertsLib));
checkTrue(
  "告警查詢排除 issued,voided",
  alertsSrv.includes('.not("status", "in", "(issued,voided)")'),
);

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
}
console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
process.exit(1);
