#!/usr/bin/env node
/**
 * onsite-payment-selftest.mjs —— 活動報名結帳的第三種付款方式「現場付款」（0056，業主 2026-11-04）
 *
 * 守五件事（業主的驗收條件），全部驅動**產線的程式碼本人**，不重寫一份邏輯：
 *
 *   1. 活動票券的結帳出現「現場付款」；
 *   2. 一般商品／書／策旅、或混了一般商品的購物車**不出現**，伺服器也不收；
 *   3. 現場付款訂單**不呼叫任何金流**（createOrder() 不載入 blackcat／payuni／payments）；
 *   4. **不被**「逾時未付款自動取消」（expire_unpaid_orders，0056）取消，名額照常保留；
 *   5. 後台「標記已收款」（admin_mark_order_paid）之後進入發票 backlog（invoice_backlog）。
 *
 * 以及：確認頁／確認信寫明「請於活動當天至現場繳費」＋金額＋活動時間地點、不含匯款帳號；
 * 中英日三語文案；後台列表、內頁、報名名單的標示；免費票不受影響；0056 的形狀與冪等。
 *
 * ── 兩段 ────────────────────────────────────────────────────────────────────
 *   [1–6] 靜態＋純函式：永遠會跑。
 *   [7–10] 連線段：對一個**本機**的 PostgreSQL 跑（套 0001–最新，0008 跳過），把
 *          `@/server/supabase-admin` 換成把查詢鏈翻成真 SQL 的 shim，驅動 createOrder()、
 *          queueOrderPlacedNotifications()、expire_unpaid_orders()、admin_mark_order_paid()、
 *          invoice_backlog() 本人。沒設 ONSITE_SELFTEST_PG_URL 就整段 skip（會印出來）。
 *
 * ⚠️ **這支測試永遠不碰正式庫、不寄信。** 只認 ONSITE_SELFTEST_PG_URL（自己設）；
 *    `@/server/email` 換成只記錄不寄的 stub，RESEND_API_KEY 在行程內被清掉。
 *
 *     createdb ib_onsite_test
 *     ONSITE_SELFTEST_PG_URL=postgres:///ib_onsite_test ONSITE_SELFTEST_APPLY=1 \
 *       node scripts/onsite-payment-selftest.mjs
 *
 * 執行（不連線）：node scripts/onsite-payment-selftest.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { registerHooks } from "node:module";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
  readMigrationFiles,
} from "./lib/migration-ledger.mjs";
import { latestDefinition } from "./lib/live-definition.mjs";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = join(ROOT, "supabase/migrations");
const SELF = "scripts/onsite-payment-selftest.mjs";
const PG_URL = process.env.ONSITE_SELFTEST_PG_URL ?? "";

// 這支測試絕不寄信：就算行程從外面帶了金鑰進來也清掉（email 模組另外被 stub）。
delete process.env.RESEND_API_KEY;

let pass = 0;
let fail = 0;
const skipped = [];
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function check(label, actual, expected) {
  if (Object.is(actual, expected)) {
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
  const p = rel.startsWith("/") ? rel : join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};
const stripTs = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
const stripSqlComments = (sql) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

// -----------------------------------------------------------------------------
// 模組 hook：`@/` 別名、supabase-admin 換成打真 psql 的 shim、金流與寄信換成記錄用 stub
// -----------------------------------------------------------------------------
/**
 * 🔴 金流 stub 是「不呼叫金流」那一條的證據來源：createOrder() 只在 wantsCard 時才
 *    `await import("@/server/blackcat" | "@/server/payuni" | "@/server/repos/payments")`。
 *    這三個模組被換成「一被呼叫就記一筆」的 stub；現場付款下單之後記錄必須是空的，而
 *    對照組（刷卡下單）必須記到東西——沒有對照組，空記錄可能只是 stub 沒接上。
 */
const STATE = {
  runSql: null,
  gatewayCalls: [],
  sentEmails: [],
};
globalThis.__ONSITE_SELFTEST__ = STATE;

const sqlLit = (v) => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

/**
 * PostgREST 查詢鏈 → 真 SQL。**只實作 createOrder()／notify／event-sessions 真的會用到的
 * 方法**；用到沒實作的會直接丟 TypeError（不是安靜地回空結果讓斷言假性通過）。
 */
class ShimQuery {
  constructor(table) {
    this.table = table;
    this.op = "select";
    this.values = null;
    this.cols = null;
    this.filters = [];
    this.wantSingle = false;
    this.strictSingle = false;
    this.orderBy = [];
    this.limitN = null;
  }
  insert(values) {
    this.op = "insert";
    this.values = values;
    return this;
  }
  update(values) {
    this.op = "update";
    this.values = values;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  select(cols) {
    this.cols = cols || "*";
    return this;
  }
  eq(col, v) {
    this.filters.push(`${col} = ${sqlLit(v)}`);
    return this;
  }
  neq(col, v) {
    this.filters.push(`${col} <> ${sqlLit(v)}`);
    return this;
  }
  is(col, v) {
    this.filters.push(`${col} is ${v === null ? "null" : sqlLit(v)}`);
    return this;
  }
  in(col, arr) {
    this.filters.push(arr.length ? `${col} in (${arr.map(sqlLit).join(", ")})` : "false");
    return this;
  }
  order(col, opts) {
    this.orderBy.push(`${col} ${opts?.ascending === false ? "desc" : "asc"}`);
    return this;
  }
  limit(n) {
    this.limitN = n;
    return this;
  }
  maybeSingle() {
    this.wantSingle = true;
    return this;
  }
  single() {
    this.wantSingle = true;
    this.strictSingle = true;
    return this;
  }
  buildSql() {
    const where = this.filters.length ? ` where ${this.filters.join(" and ")}` : "";
    const ret = this.cols ? ` returning ${this.cols}` : "";
    const t = `public.${this.table}`;
    if (this.op === "insert") {
      const rows = Array.isArray(this.values) ? this.values : [this.values];
      const keys = Object.keys(rows[0]);
      const cols = keys.join(", ");
      return (
        `insert into ${t} (${cols}) select ${cols} from json_populate_recordset(null::${t}, ` +
        `${sqlLit(rows)}::json)${ret}`
      );
    }
    if (this.op === "update") {
      const set = Object.entries(this.values)
        .map(([k, v]) => `${k} = ${sqlLit(v)}`)
        .join(", ");
      return `update ${t} set ${set}${where}${ret}`;
    }
    if (this.op === "delete") return `delete from ${t}${where}${ret}`;
    const order = this.orderBy.length ? ` order by ${this.orderBy.join(", ")}` : "";
    const limit =
      this.limitN !== null ? ` limit ${this.limitN}` : this.wantSingle ? " limit 2" : "";
    return `select ${this.cols ?? "*"} from ${t}${where}${order}${limit}`;
  }
  async run() {
    if (!STATE.runSql) throw new Error("shim 還沒接上資料庫");
    const r = await STATE.runSql(this.buildSql(), this.op !== "select");
    if (!r.ok) {
      const code = /duplicate key/.test(r.error)
        ? "23505"
        : /violates check constraint/.test(r.error)
          ? "23514"
          : "SHIM";
      return { data: null, error: { code, message: r.error.slice(0, 300) } };
    }
    if (this.wantSingle) {
      if (r.rows.length > 1)
        return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      if (this.strictSingle && r.rows.length === 0)
        return { data: null, error: { code: "PGRST116", message: "no rows" } };
      return { data: r.rows[0] ?? null, error: null };
    }
    return { data: this.op === "select" || this.cols ? r.rows : null, error: null };
  }
  then(onOk, onErr) {
    return this.run().then(onOk, onErr);
  }
}

/**
 * rpc：`select * from public.<name>(具名參數) as v`。回單一欄 v（純量函式）就拆成純量，
 * 否則回整組列（RETURNS TABLE）——與 PostgREST 的形狀一致。
 */
STATE.rpc = async (name, args) => {
  const params = Object.entries(args ?? {})
    .map(([k, v]) => `${k} => ${sqlLit(v)}`)
    .join(", ");
  const r = await STATE.runSql(`select * from public.${name}(${params}) as v`, true);
  if (!r.ok) {
    const m = /ERROR:\s+([A-Z_]+)/.exec(r.error);
    return { data: null, error: { code: "P0001", message: m ? m[1] : r.error.slice(0, 300) } };
  }
  if (r.rows.length === 1 && Object.keys(r.rows[0]).join() === "v") {
    return { data: r.rows[0].v, error: null };
  }
  return { data: r.rows, error: null };
};
STATE.makeQuery = (table) => new ShimQuery(table);

const STUBS = {
  "@/server/supabase-admin": [
    "const s = globalThis.__ONSITE_SELFTEST__;",
    "export const supabaseAdmin = () => ({ from: (t) => s.makeQuery(t), rpc: (n, a) => s.rpc(n, a) });",
  ].join("\n"),
  "@/server/email": [
    "const s = globalThis.__ONSITE_SELFTEST__;",
    "export const emailConfigured = () => false;",
    "export async function sendEmail(m) { s.sentEmails.push(m); return { outcome: 'dry_run', id: null, error: null }; }",
  ].join("\n"),
  "@/server/blackcat": [
    "const s = globalThis.__ONSITE_SELFTEST__;",
    "const rec = (n) => (...a) => { s.gatewayCalls.push('blackcat.' + n); return n.endsWith('Configured') ? false : null; };",
    "export const blackcatConfigured = rec('blackcatConfigured');",
    "export const blackcatApnUrl = rec('blackcatApnUrl');",
    "export const blackcatReturnUrl = rec('blackcatReturnUrl');",
    "export const createCocsOrder = rec('createCocsOrder');",
  ].join("\n"),
  "@/server/payuni": [
    "const s = globalThis.__ONSITE_SELFTEST__;",
    "const rec = (n) => (...a) => { s.gatewayCalls.push('payuni.' + n); return n.endsWith('Configured') ? false : null; };",
    "export const payuniConfigured = rec('payuniConfigured');",
    "export const buildUppForm = rec('buildUppForm');",
    "export const payuniReturnUrl = rec('payuniReturnUrl');",
  ].join("\n"),
  "@/server/repos/payments": [
    "const s = globalThis.__ONSITE_SELFTEST__;",
    "export async function recordPaymentIntent() { s.gatewayCalls.push('payments.recordPaymentIntent'); }",
  ].join("\n"),
};

registerHooks({
  resolve(spec, ctx, next) {
    if (spec in STUBS) return { url: `stub:${spec}`, shortCircuit: true };
    if (spec.startsWith("@/")) {
      const base = join(ROOT, "src", spec.slice(2));
      for (const cand of [`${base}.ts`, `${base}.tsx`, base, join(base, "index.ts")]) {
        if (existsSync(cand) && !cand.endsWith("/")) {
          return { url: pathToFileURL(cand).href, shortCircuit: true };
        }
      }
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.startsWith("stub:")) {
      return { format: "module", source: STUBS[url.slice(5)], shortCircuit: true };
    }
    return next(url, ctx);
  },
});

const checkout = await import(pathToFileURL(join(ROOT, "src/lib/checkout.ts")).href);
const tpl = await import(pathToFileURL(join(ROOT, "src/lib/email-templates.ts")).href);
const labels = await import(pathToFileURL(join(ROOT, "src/lib/admin/order-labels.ts")).href);

// =============================================================================
console.log("\n[1] migration 帳本");
assertLedgerMatchesDisk(check, MIG_DIR);
assertLedgerDeclarationsHonest(check, MIG_DIR);
assertMigrationDependencies(check, MIG_DIR, {
  suite: "onsite-payment-selftest",
  dependsOn: ["orders_payments", "order_expiry", "event_registrations", "session_seats"],
  reviewedThrough: "0056_onsite_payment.sql",
});

// =============================================================================
console.log("\n[2] 純函式：哪一車可以選現場付款（onsiteEligible／checkoutMethodOptions）");
const ev = { productType: "event" };
check(
  "✅ 只有活動票券、要付錢 → 可以",
  checkout.onsiteEligible({ lines: [ev, ev], total: 1200 }),
  true,
);
check(
  "商品 → 不行",
  checkout.onsiteEligible({ lines: [{ productType: "goods" }], total: 500 }),
  false,
);
check(
  "書 → 不行",
  checkout.onsiteEligible({ lines: [{ productType: "book" }], total: 500 }),
  false,
);
check(
  "策旅（journey）→ 不行",
  checkout.onsiteEligible({ lines: [{ productType: "journey" }], total: 8000 }),
  false,
);
check(
  "🔴 活動票券混一本書 → 不行",
  checkout.onsiteEligible({ lines: [ev, { productType: "book" }], total: 1500 }),
  false,
);
check("免費票（total = 0）→ 不顯示", checkout.onsiteEligible({ lines: [ev], total: 0 }), false);
check("空車 → 不行", checkout.onsiteEligible({ lines: [], total: 100 }), false);

check(
  "✅ 活動結帳：選項出現 onsite（排在 card、transfer 之後）",
  checkout
    .checkoutMethodOptions({ cardAvailable: true, transferAvailable: true, onsiteAvailable: true })
    .join(","),
  "card,transfer,onsite",
);
check(
  "商品結帳（onsiteAvailable false）：選項與 0048 逐字相同",
  checkout
    .checkoutMethodOptions({ cardAvailable: true, transferAvailable: true, onsiteAvailable: false })
    .join(","),
  "card,transfer",
);
check(
  "不帶 onsiteAvailable（舊呼叫端）：不出現 onsite",
  checkout.checkoutMethodOptions({ cardAvailable: true, transferAvailable: true }).join(","),
  "card,transfer",
);
check(
  "只有現場付款可用時：不退回 offline 降級畫面",
  checkout
    .checkoutMethodOptions({
      cardAvailable: false,
      transferAvailable: false,
      onsiteAvailable: true,
    })
    .join(","),
  "onsite",
);
{
  const r = checkout.resolveOrderPaymentChoice({
    paymentMethod: "onsite",
    needsContact: true,
    transferAvailable: true,
  });
  check("伺服器：onsite → payment_method 'onsite'（不改成匯款或刷卡）", r.paymentMethod, "onsite");
  check("伺服器：onsite 不帶 needs_contact（勾選框只屬於匯款）", r.needsContact, false);
}
check(
  "zod payload 收 onsite",
  checkout.checkoutPayloadSchema.shape.paymentMethod.parse("onsite"),
  "onsite",
);
checkTrue(
  "錯誤碼 onsite_not_allowed 有三語文案",
  ["zh", "en", "ja"].every(
    (l) => (checkout.CHECKOUT_ERROR_COPY.onsite_not_allowed?.[l] ?? "").length > 5,
  ),
);

// =============================================================================
console.log("\n[3] 結帳頁與伺服器的接線（剝掉註解後比對）");
const pageCode = stripTs(readFile("src/routes/checkout.index.tsx"));
checkTrue(
  "結帳頁用 onsiteEligible() 算 onsiteAvailable（判準只有一份）",
  /const onsiteAvailable = useMemo\([\s\S]{0,200}onsiteEligible\(\{/.test(pageCode),
);
checkTrue(
  "結帳頁把 onsiteAvailable 交給 checkoutMethodOptions()",
  /checkoutMethodOptions\(\{ cardAvailable, transferAvailable, onsiteAvailable \}\)/.test(pageCode),
);
checkTrue(
  "中文標籤「現場付款」",
  pageCode.includes('payOnsite: { zh: "現場付款", en: "Pay at the venue", ja: "当日現地払い" }'),
);
checkTrue(
  "PAYMENT_LABELS／PAYMENT_NOTES 都有 onsite",
  /onsite: PAGE\.payOnsite,/.test(pageCode) && /onsite: PAGE\.payOnsiteNote,/.test(pageCode),
);
checkTrue(
  "選項消失時選擇退回第一個（不留看不到的選擇）",
  /if \(!methodOptions\.includes\(payWith\)\) setPayWith\(methodOptions\[0\]\)/.test(pageCode),
);
checkTrue("說明文字寫明「請於活動當天至現場繳費」", pageCode.includes("請於活動當天至現場繳費"));

const ordersCode = stripTs(readFile("src/server/repos/orders.ts"));
checkTrue(
  "🔴 createOrder：選 onsite 但車裡不全是活動票券 → onsite_not_allowed（看定價後的 product_type）",
  /if \(wantsOnsite && \(admin !== null \|\| !lines\.every\(\(l\) => l\.productType === "event"\)\)\) \{\s*throw new CheckoutError\("onsite_not_allowed"\);/.test(
    ordersCode,
  ),
);
checkTrue(
  "insert：onsite 只在 total > 0 時寫（0 元照舊 NULL → settle_free_order 改 free）",
  /wantsOnsite && total > 0\s*\?\s*"onsite"\s*:\s*null/.test(ordersCode),
);
checkTrue(
  "🔴 金流只在 wantsCard 時才碰（onsite 的 wantsCard 恆為 false）",
  /const payment = wantsCard && total > 0 \? await buildCardHandoff\(order\) : null;/.test(
    ordersCode,
  ),
);
checkTrue(
  "reissuePayment：onsite 回 null（完成頁不會長出「重新付款」）",
  /if \(order\.payment_method === "onsite"\) return null;/.test(ordersCode),
);
checkTrue(
  "awaitingPayment 排除 onsite（不輪詢、不算在等金流）",
  /o\.payment_method !== "onsite" &&/.test(ordersCode),
);
checkTrue(
  "確認頁資料：onsite 只在未付清、未取消時組",
  /o\.payment_method === "onsite" && o\.payment_status !== "paid" && o\.status !== "cancelled"/.test(
    ordersCode,
  ),
);

const completeCode = stripTs(readFile("src/routes/checkout.complete.tsx"));
checkTrue(
  "確認頁：標題「報名已成立，請於活動當天至現場繳費」",
  completeCode.includes('zh: "報名已成立，請於活動當天至現場繳費"'),
);
checkTrue(
  "確認頁：印金額（order.total）",
  /data-testid="onsite-payment"[\s\S]{0,600}formatPrice\(order\.total\)/.test(completeCode),
);
checkTrue(
  "確認頁：印每一場的時間與地點",
  /onsite\.sessions\.map[\s\S]{0,700}formatTaipeiDateTime\(s\.startsAt\)[\s\S]{0,500}t\(s\.location\)/.test(
    completeCode,
  ),
);

// =============================================================================
console.log("\n[4] 0056 的形狀");
const sql0056raw = readFile(join(MIG_DIR, "0056_onsite_payment.sql"));
const sql0056 = stripSqlComments(sql0056raw);
checkTrue(
  "CHECK 值域 = 0034 + onsite",
  sql0056.includes(
    "payment_method in ('card', 'atm', 'cvs_cod', 'test_paid', 'free', 'transfer', 'onsite')",
  ),
);
checkTrue(
  "CHECK 是 drop if exists + add（冪等）",
  /drop constraint if exists orders_payment_method_check;/.test(sql0056),
);
checkTrue(
  "🔴 expire 候選條件跳過 onsite，且用 is distinct from（NULL 的舊單照舊回收）",
  /and o\.source <> 'admin_phone'\s*and o\.payment_method is distinct from 'onsite'/.test(sql0056),
);
{
  // 0056 的 expire 本體除了那一行之外，與 0050 逐字相同（取自正式庫的那一份）。
  const body = (sql, file) => {
    const s = sql.indexOf("CREATE OR REPLACE FUNCTION public.expire_unpaid_orders");
    const e = sql.indexOf("$function$;", s);
    if (s === -1 || e === -1) throw new Error(`${file} 切不出 expire_unpaid_orders`);
    return sql.slice(s, e);
  };
  const b50 = body(
    stripSqlComments(readFile(join(MIG_DIR, "0050_admin_phone_orders.sql"))),
    "0050",
  );
  const b56 = body(sql0056, "0056").replace(
    /\n\s*and o\.payment_method is distinct from 'onsite'/,
    "",
  );
  check("expire 本體：拿掉那一行之後與 0050 逐字相同", b56, b50);
}
checkTrue(
  "expire 只 grant service_role",
  /grant execute on function public\.expire_unpaid_orders\(interval, integer\) to service_role;/.test(
    sql0056,
  ),
);
{
  const mark = latestDefinition(MIG_DIR, "admin_mark_order_paid", stripSqlComments);
  checkFalse(
    "admin_mark_order_paid 的現行定義不看 payment_method（onsite 標得了）",
    /where[\s\S]*payment_method\s*(=|in|<>)/i.test(
      mark.body.split("insert into public.payments")[0],
    ),
  );
  const backlog = latestDefinition(MIG_DIR, "invoice_backlog", stripSqlComments);
  checkFalse(
    "invoice_backlog 的現行定義不看 payment_method（標記之後就進 backlog）",
    /payment_method/.test(backlog.body),
  );
  checkTrue(
    "invoice_backlog 只收 paid 且 total > 0（未付款的 onsite 不會開發票）",
    /o\.payment_status = 'paid'\s*and o\.total > 0/.test(backlog.body),
  );
}

// =============================================================================
console.log("\n[5] 確認信（中／英／日）與店家通知信");
const SESSION_BRIEF = {
  title: { zh: "布苔球手作課", en: "Moss ball workshop", ja: "苔玉ワークショップ" },
  location: { zh: "小時光風土誌書店", en: "Interval Books", ja: "小時光書店" },
  startsAt: "2026-12-20T06:00:00.000Z",
  endsAt: "2026-12-20T08:00:00.000Z",
};
for (const lang of ["zh", "en", "ja"]) {
  const mail = tpl.renderOnsitePaymentEmail(
    {
      orderNo: "IB-TEST-1",
      customerName: "王小明",
      total: 1200,
      items: [{ name: SESSION_BRIEF.title, quantity: 2, subtotal: 1200 }],
      sessions: [SESSION_BRIEF],
      orderUrl: null,
    },
    {},
    lang,
  );
  const must = { zh: "請於活動當天至現場繳費", en: "pay at the venue", ja: "当日" }[lang];
  checkTrue(`${lang}：主旨／內文寫明現場繳費`, (mail.subject + mail.text).includes(must));
  checkTrue(`${lang}：有金額 NT$1,200`, mail.text.includes("1,200"));
  checkTrue(`${lang}：有活動地點`, mail.text.includes(SESSION_BRIEF.location[lang]));
  checkTrue(`${lang}：有活動時間（12/20）`, /12/.test(mail.text) && /20/.test(mail.text));
  checkFalse(
    `${lang}：🔴 不含任何匯款帳號欄位`,
    ["戶名", "帳號", "Account number", "口座番号", "匯款", "Bank transfer"].some((w) =>
      mail.text.includes(w),
    ),
  );
}
{
  const admin = tpl.renderAdminOrderNotificationEmail({
    stage: "atOrderTime",
    orderNo: "IB-TEST-1",
    total: 1200,
    paymentMethod: "onsite",
    shippingMethod: "none",
    items: [],
    sessions: [],
  });
  checkTrue("店家待收款信：主旨標「現場付款」", admin.subject.includes("｜現場付款"));
  checkTrue("店家待收款信：付款方式印「現場付款」", admin.text.includes("付款方式：現場付款"));
  checkTrue("店家待收款信：說明不會被逾時自動取消", admin.text.includes("不會被逾時自動取消"));
}
check(
  "email-templates 的付款方式對照：onsite → 現場付款",
  tpl.paymentMethodLabel("onsite"),
  "現場付款",
);

// notify.ts 的註解裡有 `/api/tasks/*` 這種字，stripTs 的區塊註解規則會吃掉一大段——這裡比對原始碼。
const notifyCode = readFile("src/server/notify.ts");
checkTrue(
  "notify：onsite 也走下單當下那條路",
  /const isOnsite = order\.paymentMethod === "onsite";/.test(notifyCode),
);
checkTrue(
  "notify：onsite 的客人信用 renderOnsitePaymentEmail（不是匯款資訊信）",
  /if \(isOnsite && notifyCustomer\) \{[\s\S]{0,1500}renderOnsitePaymentEmail\(/.test(notifyCode),
);
checkFalse(
  "notify：onsite 那一段不讀匯款帳戶",
  notifyCode
    .slice(
      notifyCode.indexOf("if (isOnsite && notifyCustomer)"),
      notifyCode.indexOf("// ---- 2. 店家的"),
    )
    .includes("getRemittanceAccount"),
);

// =============================================================================
console.log("\n[6] 後台標示：列表、內頁、報名名單");
check("後台付款方式：onsite → 現場付款", labels.paymentMethodLabel("onsite"), "現場付款");
check(
  "未付款的現場付款單亮「現場付款・未收款」",
  labels.showOnsiteUnpaid({
    payment_method: "onsite",
    payment_status: "pending",
    status: "pending",
  }),
  true,
);
check(
  "已付清的不亮",
  labels.showOnsiteUnpaid({
    payment_method: "onsite",
    payment_status: "paid",
    status: "processing",
  }),
  false,
);
check(
  "已取消的不亮",
  labels.showOnsiteUnpaid({
    payment_method: "onsite",
    payment_status: "failed",
    status: "cancelled",
  }),
  false,
);
check(
  "匯款單不亮",
  labels.showOnsiteUnpaid({
    payment_method: "transfer",
    payment_status: "pending",
    status: "pending",
  }),
  false,
);
check(
  "列表分頁 onsite_pending 解析得回來",
  labels.parseOrderListSearch({ scope: "onsite_pending" }).scope,
  "onsite_pending",
);
checkTrue(
  "server fn 的 scope 白名單收 onsite_pending",
  /"onsite_pending",\s*\] as const/.test(readFile("src/lib/admin/fns/orders.ts")),
);
checkTrue(
  "repo：onsite_pending 的條件與標示相同",
  /filter\.scope === "onsite_pending"\) \{[\s\S]{0,300}\.eq\("payment_method", "onsite"\)\s*\.neq\("payment_status", "paid"\)\s*\.neq\("status", "cancelled"\)/.test(
    readFile("src/server/repos/orders-admin.ts"),
  ),
);
const listCode = stripTs(readFile("src/routes/admin/_shell.orders.tsx"));
checkTrue(
  "列表：有「現場付款待收款」分頁",
  listCode.includes('<TabsTrigger value="onsite_pending">現場付款待收款</TabsTrigger>'),
);
checkTrue("列表：每列標示", /showOnsiteUnpaid\(o\) \?/.test(listCode));
const detailCode = stripTs(readFile("src/routes/admin/_shell.orders_.$id.tsx"));
checkTrue("內頁：頂端標示", /showOnsiteUnpaid\(detail\) \?/.test(detailCode));
checkTrue(
  "內頁：onsite 給「標記已收款」",
  /detail\.payment_method === "onsite" \|\|/.test(detailCode),
);
const rosterCode = stripTs(readFile("src/components/admin/SessionRosterTable.tsx"));
checkTrue(
  "名單：現場付款未收款的列有標示",
  /rowOnsiteUnpaid\(r\) \?[\s\S]{0,200}ONSITE_UNPAID_LABEL/.test(rosterCode),
);
checkTrue(
  "🔴 名單：一鍵標記已收款走的是同一支 markOrderPaidAdmin（admin_mark_order_paid）",
  /markOrderPaidAdmin\(\{\s*data: \{ orderId: payTarget\.order_id/.test(rosterCode),
);
checkTrue(
  "名單：按鈕只給 admin（canMarkPaid）",
  /canMarkPaid && rowOnsiteUnpaid\(r\)/.test(rosterCode),
);
checkTrue(
  "名單 repo：從 orders 補 payment_method／status／total（view 不動）",
  /\.from\("orders"\)\s*\.select\("id, payment_method, status, total"\)\s*\.in\("id", orderIds\)/.test(
    readFile("src/server/repos/event-registrations.ts"),
  ),
);

// =============================================================================
// [7–10] 連線段
// =============================================================================
async function q(sql, returning = true) {
  const text = returning
    ? /^\s*(insert|update|delete)\b/i.test(sql)
      ? `with t as (\n${sql}\n) select coalesce(json_agg(t), '[]'::json)::text from t`
      : `select coalesce(json_agg(t), '[]'::json)::text from (\n${sql}\n) t`
    : sql;
  try {
    const { stdout } = await execFileAsync(
      "psql",
      ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", PG_URL, "-c", text],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    if (!returning) return { ok: true, error: null, rows: [] };
    return { ok: true, error: null, rows: JSON.parse(stdout.trim() || "[]") };
  } catch (err) {
    return { ok: false, error: String(err.stderr ?? err.message ?? err), rows: [] };
  }
}
async function must(sql, returning = true) {
  const r = await q(sql, returning);
  if (!r.ok)
    throw new Error(`SQL 失敗：${r.error.slice(0, 400)}\n--- SQL ---\n${sql.slice(0, 600)}`);
  return r.rows;
}
const one = (rows) => (Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
STATE.runSql = (sql, isWrite) =>
  // 寫入一律包 CTE 拿 RETURNING；沒有 returning 子句的寫入回空陣列。
  isWrite && !/\breturning\b/i.test(sql) && /^\s*(insert|update|delete)\b/i.test(sql)
    ? q(sql, false)
    : q(sql, true);

const P = "onsite56-";
const CLEANUP_SQL = `
delete from public.email_outbox where to_email like '${P}%';
delete from public.invoices where order_id in (select id from public.orders where idempotency_key like '${P}%' or customer_email like '${P}%');
delete from public.event_registrations where order_id in (select id from public.orders where idempotency_key like '${P}%' or customer_email like '${P}%');
delete from public.payments where order_id in (select id from public.orders where idempotency_key like '${P}%' or customer_email like '${P}%');
delete from public.order_items where order_id in (select id from public.orders where idempotency_key like '${P}%' or customer_email like '${P}%');
delete from public.orders where idempotency_key like '${P}%' or customer_email like '${P}%';
delete from public.event_sessions where product_id like '${P}%';
delete from public.products where id like '${P}%';
`;

if (!PG_URL) {
  skipped.push("連線段 [7–10]（缺 ONSITE_SELFTEST_PG_URL）");
  console.log(yellow("\n[7–10] 連線段 —— 跳過：沒有 ONSITE_SELFTEST_PG_URL（指令見本檔檔頭）"));
} else {
  try {
    if (process.env.ONSITE_SELFTEST_APPLY === "1") {
      console.log("\n[7] 套用 0001–最新（ONSITE_SELFTEST_APPLY=1，0008 跳過）");
      await must(
        `
        create extension if not exists pgcrypto;
        do $$ begin
          if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
        end $$;
        create schema if not exists auth;
        create table if not exists auth.users (
          id uuid primary key default gen_random_uuid(), email text,
          raw_user_meta_data jsonb, created_at timestamptz not null default now(),
          email_confirmed_at timestamptz, deleted_at timestamptz);
        create or replace function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;
        create schema if not exists storage;
        create table if not exists storage.buckets (
          id text primary key, name text, public boolean default false,
          file_size_limit bigint, allowed_mime_types text[], owner uuid,
          created_at timestamptz default now());
        create table if not exists storage.objects (
          id uuid primary key default gen_random_uuid(), bucket_id text, name text,
          owner uuid, metadata jsonb, created_at timestamptz default now());
        alter table storage.objects enable row level security;
        grant usage on schema public to anon, authenticated, service_role;
      `,
        false,
      );
      for (const f of readMigrationFiles(MIG_DIR)) {
        if (f.startsWith("0008_")) continue;
        const r = await q(readFile(join(MIG_DIR, f)), false);
        if (!r.ok) throw new Error(`套用 ${f} 失敗：${r.error.slice(0, 600)}`);
      }
      checkTrue("0001–最新套用完成（0008 跳過）", true);
    }
    const again = await q(sql0056raw, false);
    checkTrue("0056 再套一次零錯誤（冪等）", again.ok);
    if (!again.ok) console.log(red(`      ${again.error.slice(0, 300)}`));

    console.log("\n[8] createOrder() 本人：活動票券選現場付款");
    await must(CLEANUP_SQL, false);
    const LOC = `'{"zh":"自檢","en":"selftest","ja":"セルフテスト"}'::jsonb`;
    const EV = `${P}ev`;
    const BOOK = `${P}book`;
    const FREE = `${P}free`;
    const S1 = "dddd0000-0000-4000-8000-000000000056";
    const S2 = "dddd0000-0000-4000-8000-000000000057";
    await must(
      `
      insert into public.products (id, slug, product_type, title, summary, description, price, status, requires_shipping)
      values ('${EV}','${EV}','event', ${LOC}, ${LOC}, ${LOC}, 600, 'active', false),
             ('${FREE}','${FREE}','event', ${LOC}, ${LOC}, ${LOC}, 0, 'active', false);
      insert into public.products (id, slug, product_type, title, summary, description, price, status, stock, requires_shipping)
      values ('${BOOK}','${BOOK}','book', ${LOC}, ${LOC}, ${LOC}, 300, 'active', 5, false);
      insert into public.event_sessions (id, product_id, title, location, starts_at, ends_at, capacity, status)
      values ('${S1}','${EV}', ${LOC}, '{"zh":"小時光風土誌書店","en":"Interval Books","ja":"小時光書店"}'::jsonb,
              now() + interval '40 days', now() + interval '40 days 2 hours', 10, 'open'),
             ('${S2}','${FREE}', ${LOC}, ${LOC}, now() + interval '41 days', null, 10, 'open');
    `,
      false,
    );
    // 店家通知信的收件人（site_settings 單例）。本機庫沒有這一列就補一列；收件人一律是
    // Resend 的測試信箱。信只會進 outbox 與 email stub，不會真的寄出。
    await must(
      `insert into public.site_settings (short_desc, address, city, hours, closed, contact_email,
                                         site_url, map_embed, map_link, map_apple, meta_site_name,
                                         meta_author, default_meta_title, default_meta_description)
       select ${LOC}, ${LOC}, ${LOC}, ${LOC}, ${LOC}, 'delivered@resend.dev', 'https://intervalbooks.tw',
              '', '', '', ${LOC}, '', ${LOC}, ${LOC}
        where not exists (select 1 from public.site_settings);
       update public.site_settings set notify_emails = 'delivered@resend.dev';`,
      false,
    );
    const orders = await import(pathToFileURL(join(ROOT, "src/server/repos/orders.ts")).href);
    const notify = await import(pathToFileURL(join(ROOT, "src/server/notify.ts")).href);
    const person = (n) => ({
      name: n,
      email: `${P}${n}@example.invalid`,
      phone: null,
      noticeAck: true,
    });
    const payload = (key, paymentMethod, items) =>
      checkout.checkoutPayloadSchema.parse({
        customerName: "現場自檢",
        customerEmail: `${P}${key}@example.invalid`,
        customerPhone: "0912345678",
        shippingMethod: "none",
        items,
        locale: "zh",
        idempotencyKey: crypto.randomUUID(),
        paymentMethod,
      });
    const evItem = (qty, names) => ({
      productId: EV,
      quantity: qty,
      sessionId: S1,
      participants: names.map(person),
    });

    STATE.gatewayCalls.length = 0;
    const placed = await orders.createOrder(payload("onsite", "onsite", [evItem(2, ["甲", "乙"])]));
    check("✅ 訂單成立，total 從票價重算 = 1200", placed.total, 1200);
    check("🔴 不回任何金流 hand-off（payment = null）", placed.payment, null);
    check(
      "🔴 金流模組一次都沒被呼叫（blackcat／payuni／payments）",
      STATE.gatewayCalls.join(",") || "（無）",
      "（無）",
    );
    const row = one(
      await must(`select id, status, payment_status, payment_method, needs_contact, total,
                         (select count(*)::int from public.payments p where p.order_id = o.id) pays,
                         (select count(*)::int from public.event_registrations r where r.order_id = o.id) regs
                    from public.orders o where o.order_no = '${placed.orderNo}'`),
    );
    check("orders.payment_method = 'onsite'", row?.payment_method, "onsite");
    check("狀態維持 pending／pending", `${row?.status}/${row?.payment_status}`, "pending/pending");
    check("沒有任何 payments 列", Number(row?.pays), 0);
    check("名額照常保留：2 位參加者", Number(row?.regs), 2);
    check(
      "event_sessions.seats_taken = 2",
      Number(
        one(await must(`select seats_taken n from public.event_sessions where id='${S1}'`))?.n,
      ),
      2,
    );
    {
      const ob = await must(
        `select dedupe_key k, body_text bt, subject s from public.email_outbox where dedupe_key like '%${row.id}' order by 1`,
      );
      check(
        "下單當下排了兩封：客人的現場付款確認信＋店家待收款",
        ob.map((r) => r.k.split(":")[0]).join(","),
        "onsite_payment,order_placed_admin",
      );
      const cust = ob.find((r) => r.k.startsWith("onsite_payment:"));
      checkTrue(
        "客人信：請於活動當天至現場繳費",
        (cust?.s ?? "").includes("請於活動當天至現場繳費"),
      );
      checkTrue("客人信：金額 NT$1,200", (cust?.bt ?? "").includes("1,200"));
      checkTrue("客人信：地點", (cust?.bt ?? "").includes("小時光風土誌書店"));
      checkFalse("🔴 客人信：沒有匯款帳號", /戶名|帳號|匯款/.test(cust?.bt ?? ""));
      checkFalse(
        "沒有排匯款資訊信（remittance:）",
        ob.some((r) => r.k.startsWith("remittance:")),
      );
      // flushEmailOutbox() 會把 outbox 交給 sendEmail()——那一支在這裡是 stub，只記錄不寄。
      checkTrue(
        "🔴 沒有真的寄信：寄信模組是 stub，收件人只有測試信箱（example.invalid／delivered@resend.dev）",
        STATE.sentEmails.every((m) =>
          /@example\.invalid$|^delivered@resend\.dev$/.test(String(m.to)),
        ),
      );
      const adm = ob.find((r) => r.k.startsWith("order_placed_admin:"));
      checkTrue("店家信：主旨標「現場付款」", (adm?.s ?? "").includes("｜現場付款"));
    }
    {
      const conf = await orders.getOrderByToken(placed.publicToken);
      check(
        "確認頁：awaitingPayment = false（不輪詢、沒有重新付款）",
        conf?.awaitingPayment,
        false,
      );
      check("確認頁：沒有匯款資訊", conf?.remittance, null);
      check("確認頁：onsite 區塊帶 1 場", conf?.onsite?.sessions?.length, 1);
      check("確認頁：場次地點", conf?.onsite?.sessions?.[0]?.location?.zh, "小時光風土誌書店");
      check(
        "reissuePayment：onsite 回 null",
        await orders.reissuePayment(placed.publicToken),
        null,
      );
    }

    console.log("\n[8b] 商品不行、免費票不受影響、對照組");
    {
      let code = null;
      try {
        await orders.createOrder(
          payload("mixed", "onsite", [evItem(1, ["丙"]), { productId: BOOK, quantity: 1 }]),
        );
      } catch (e) {
        code = e?.code ?? String(e);
      }
      check("🔴 活動＋書選現場付款 → onsite_not_allowed", code, "onsite_not_allowed");
      check(
        "   而且什麼都沒寫（沒有訂單、名額沒動）",
        Number(
          one(
            await must(
              `select count(*)::int n from public.orders where customer_email = '${P}mixed@example.invalid'`,
            ),
          )?.n,
        ),
        0,
      );
      check(
        "   seats_taken 還是 2",
        Number(
          one(await must(`select seats_taken n from public.event_sessions where id='${S1}'`))?.n,
        ),
        2,
      );
    }
    {
      let code = null;
      try {
        await orders.createOrder(payload("bookonly", "onsite", [{ productId: BOOK, quantity: 1 }]));
      } catch (e) {
        code = e?.code ?? String(e);
      }
      check("商品結帳選現場付款 → onsite_not_allowed", code, "onsite_not_allowed");
    }
    {
      const free = await orders.createOrder(
        payload("free", "onsite", [
          { productId: FREE, quantity: 1, sessionId: S2, participants: [person("丁")] },
        ]),
      );
      const fr = one(
        await must(
          `select payment_method, payment_status from public.orders where order_no='${free.orderNo}'`,
        ),
      );
      check("✅ 免費票（0 元）照舊當場結清：payment_method = free", fr?.payment_method, "free");
      check("   payment_status = paid", fr?.payment_status, "paid");
    }
    {
      // 對照組：刷卡下單會去問金流（stub 記得到）——證明上面的「零呼叫」不是 stub 沒接上。
      STATE.gatewayCalls.length = 0;
      await orders.createOrder(payload("card", "card", [evItem(1, ["戊"])]));
      checkTrue("對照組：刷卡下單有碰金流模組", STATE.gatewayCalls.length > 0);
    }

    console.log("\n[9] 🔴 expire_unpaid_orders：現場付款不被逾時取消");
    {
      // 第二張現場付款單＋兩個對照組，全部挪到 10 天前。
      const o2 = await orders.createOrder(payload("onsite-old", "onsite", [evItem(1, ["己"])]));
      const tr = await orders.createOrder(payload("transfer-old", "transfer", [evItem(1, ["庚"])]));
      await must(
        `insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key, payment_method, locale)
         values ('自檢','${P}null-old@example.invalid','0900000000',600,600,'${P}null-old',null,'zh');
         update public.orders set created_at = now() - interval '10 days'
          where order_no in ('${placed.orderNo}','${o2.orderNo}','${tr.orderNo}')
             or idempotency_key = '${P}null-old';`,
        false,
      );
      await must(`select * from public.expire_unpaid_orders(interval '2 hours')`);
      const st = async (where) =>
        one(
          await must(`select status, payment_method,
                             (select count(*)::int from public.event_registrations r where r.order_id = o.id) regs
                        from public.orders o where ${where}`),
        );
      const a = await st(`order_no='${placed.orderNo}'`);
      check("✅ 現場付款（10 天前）：沒有被取消", a?.status, "pending");
      check("   參加者還在（2 位）", Number(a?.regs), 2);
      const b = await st(`order_no='${o2.orderNo}'`);
      check("✅ 另一張現場付款：沒有被取消", b?.status, "pending");
      const c = await st(`order_no='${tr.orderNo}'`);
      check("對照組：匯款 10 天前 → 取消（expire 本身沒壞）", c?.status, "cancelled");
      check("   它的參加者被刪掉", Number(c?.regs), 0);
      const d = await st(`idempotency_key='${P}null-old'`);
      check(
        "對照組：payment_method NULL 的舊單 → 照舊取消（is distinct from 沒有誤放）",
        d?.status,
        "cancelled",
      );
    }

    console.log("\n[10] 🔴 標記已收款 → 進入發票 backlog");
    {
      const id = row.id;
      const inBacklog = async () =>
        (
          await must(`select order_id from public.invoice_backlog(500, 5, interval '5 minutes')`)
        ).some((r) => r.order_id === id);
      check("標記之前：不在發票 backlog（現場付款時不開發票）", await inBacklog(), false);
      const marked = one(
        await must(
          `select * from public.admin_mark_order_paid('${id}'::uuid, null, '現場收款自檢')`,
        ),
      );
      check("admin_mark_order_paid → marked", marked?.reason, "marked");
      const after = one(
        await must(
          `select status, payment_status, payment_method from public.orders where id='${id}'`,
        ),
      );
      check(
        "已付清：processing／paid",
        `${after?.status}/${after?.payment_status}`,
        "processing/paid",
      );
      check("payment_method 還是 onsite（沒被改成 card）", after?.payment_method, "onsite");
      check("✅ 標記之後：出現在 invoice_backlog()", await inBacklog(), true);
      const again2 = one(
        await must(`select * from public.admin_mark_order_paid('${id}'::uuid, null, null)`),
      );
      check("冪等：第二次 → already_paid", again2?.reason, "already_paid");
    }
    {
      const bad = await q(
        `insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key, payment_method)
         values ('自檢','${P}bad@example.invalid','0900000000',1,1,'${P}bad','bogus')`,
        false,
      );
      checkFalse("CHECK 仍擋未知的付款方式", bad.ok);
    }
    await must(CLEANUP_SQL, false);
  } catch (err) {
    fail += 1;
    console.log(red(`  ✗ 連線段發生例外：${err instanceof Error ? err.stack : String(err)}`));
  }
}

// =============================================================================
console.log("\n" + "─".repeat(52));
if (skipped.length > 0) {
  console.log(yellow(`略過 ${skipped.length} 段：`));
  for (const s of skipped) console.log(yellow(`  • ${s}`));
}
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exit(1);
}
console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
