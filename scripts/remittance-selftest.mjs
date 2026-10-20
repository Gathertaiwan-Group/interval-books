#!/usr/bin/env node
/**
 * remittance-selftest.mjs —— 匯款付款方式（0034）的自檢
 *
 * 分兩段，理由與 event-registration-selftest / notify-selftest 相同：這支測試在
 * 沒有資料庫的機器上也必須有意義。
 *
 *   [靜態] 讀 0034 的 SQL 與幾支 .ts 的原始碼，並且**真的呼叫**那些純函式
 *          （publicSiteUrl / remittanceDueAt / renderRemittanceEmail…）。
 *          守的是設計不變量：值域、期限常數、信件內容、授權模型的形狀。
 *          **永遠會跑。**
 *
 *   [連線] 對一個真的 PostgreSQL 跑三組東西，全部驅動**產線的程式碼本人**：
 *            · expire_unpaid_orders() —— 匯款訂單留 3 天、4 天後照收、刷卡不誤傷
 *            · reportRemittance()（src/server/repos/orders.ts）—— 四道閘門
 *            · admin_mark_order_paid() —— 保留 payment_method、冪等、擋已取消
 *          以及 dedupe_key 分不分得開、site_settings 的 column-level grant。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它只認 REMITTANCE_SELFTEST_PG_URL，而那個變數
 *    要自己設；沒設就整段 skip（會印出來，不會靜悄悄消失）。
 *
 *     createdb ib_0034_test
 *     REMITTANCE_SELFTEST_PG_URL=postgres:///ib_0034_test \
 *     REMITTANCE_SELFTEST_APPLY=1 node scripts/remittance-selftest.mjs
 *
 * ── 為什麼 reportRemittance() 是用 shim 打真的資料庫，不是重寫一次那句 SQL ──
 * 那支函式的「只能回報一次」不是靠 if 判斷，是靠**一句帶四個條件的 UPDATE**
 * （WHERE 裡有 remittance_last5 is null）。重寫一次那句 SQL 拿去跑，驗到的是我這
 * 支測試寫得對不對，不是產線那一句寫得對不對——這個 repo 出過六次的假陽性裡就有
 * 這一種。所以下面把 `@/server/supabase-admin` 換成一個把查詢鏈**翻成真 SQL 丟給
 * psql** 的 shim，被測的仍然是 src/server/repos/orders.ts 那一支函式本人。
 *
 * 環境變數：
 *   REMITTANCE_SELFTEST_PG_URL   本機測試庫的連線字串（連線段的開關）
 *   REMITTANCE_SELFTEST_APPLY    設成 1 時先套用 0001–0034
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
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
const MIG_0034 = join(MIG_DIR, "0034_transfer_payment.sql");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 event-registration-selftest 同一套）
// -----------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const skipped = [];
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function check(label, actual, expected, hint) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
    if (hint) console.log(red(`      ${hint}`));
  }
}
const checkTrue = (label, value, hint) => check(label, Boolean(value), true, hint);

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串 —— 回空字串會讓所有
 * 「確認裡面沒有 X」的否定斷言靜默通過。見 run-selftests.mjs 的「守門 4」。
 */
const readFile = (p) => {
  if (!existsSync(p)) {
    throw new Error(
      `selftest 讀不到檔案：${p}（這裡刻意不回空字串 —— 回空字串會讓否定斷言靜默通過）`,
    );
  }
  return readFileSync(p, "utf8");
};

// 守著 readFile() 自己。
{
  const ghost = join(ROOT, "__remittance-selftest-missing-probe__");
  let thrown = null;
  try {
    readFile(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 readFile() 讀不到檔案時丟例外（不是靜默回空字串）",
    thrown !== null && String(thrown.message).includes(ghost),
  );
}

const stripSqlComments = (sql) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

function stripTs(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// -----------------------------------------------------------------------------
// 模組 hook：`@/` 別名 + 把 supabaseAdmin() 換成打真 psql 的 shim
// -----------------------------------------------------------------------------
/**
 * 🔴 為什麼是 shim，而不是在測試裡重寫一次那句 SQL。
 *
 * reportRemittance() 的「只能回報一次」不是靠 if 判斷，是靠**一句帶五個條件的
 * UPDATE**（WHERE 裡有 remittance_last5 is null）。在測試裡重寫一次那句 SQL 拿去
 * 跑，驗到的是這支測試寫得對不對，不是產線那一句寫得對不對——這個 repo 出過六次
 * 的假陽性裡就有這一種。
 *
 * 所以這裡把 `@/server/supabase-admin` 換掉，換成一個把 PostgREST 的查詢鏈**翻成
 * 真 SQL 丟給 psql** 的東西。被測的仍然是 src/server/repos/orders.ts 那一支函式
 * 本人：它組什麼查詢、按什麼順序、帶哪些條件，全部原封不動地跑到真的 Postgres 上，
 * 撞的是真的 CHECK constraint 與真的併發語意。
 *
 * ⚠️ 這個 shim **只實作 reportRemittance() 真的會用到的那幾個方法**。多實作就是多
 *    一份沒有人在驗的假資料庫。用到沒實作的方法會直接丟例外（而不是安靜地回空
 *    結果，讓斷言假性通過）。
 */
const SHIM = { runSql: null };
globalThis.__REMITTANCE_SELFTEST__ = SHIM;

const sqlLit = (v) => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return `'${String(v).replace(/'/g, "''")}'`;
};

class ShimQuery {
  constructor(table) {
    this.table = table;
    this.op = "select";
    this.values = null;
    this.cols = "*";
    this.filters = [];
    this.single = false;
  }
  update(values) {
    this.op = "update";
    this.values = values;
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
  order() {
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  buildSql() {
    const where = this.filters.length ? ` where ${this.filters.join(" and ")}` : "";
    if (this.op === "update") {
      const set = Object.entries(this.values)
        .map(([k, v]) => `${k} = ${sqlLit(v)}`)
        .join(", ");
      return `update public.${this.table} set ${set}${where} returning ${this.cols}`;
    }
    return `select ${this.cols} from public.${this.table}${where}${this.single ? " limit 2" : ""}`;
  }
  async run() {
    if (!SHIM.runSql) throw new Error("shim 還沒接上資料庫（SHIM.runSql 是 null）");
    const r = await SHIM.runSql(this.buildSql());
    if (!r.ok) {
      // 形狀比照 PostgREST 的錯誤物件（code + message），因為產線程式碼會讀這兩欄。
      return { data: null, error: { code: "SHIM", message: r.error.slice(0, 300) } };
    }
    if (this.single) {
      if (r.rows.length > 1)
        return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      return { data: r.rows[0] ?? null, error: null };
    }
    return { data: r.rows, error: null };
  }
  then(onOk, onErr) {
    return this.run().then(onOk, onErr);
  }
}

SHIM.makeQuery = (table) => new ShimQuery(table);

/**
 * `supabaseAdmin().rpc(name, args)` 的 shim。翻成 `select public.<name>(<具名參數>)`。
 *
 * 具名參數（`p_order_id => '…'`）而不是位置參數是刻意的：PostgREST 就是用名字對
 * 參數的，用位置對會讓「參數順序改了但名字沒改」這種變更在測試裡靜默通過。
 */
SHIM.rpc = async (name, args) => {
  const params = Object.entries(args ?? {})
    .map(([k, v]) => `${k} => ${sqlLit(v)}`)
    .join(", ");
  const r = await SHIM.runSql(`select public.${name}(${params}) as v`);
  if (!r.ok) return { data: null, error: { code: "SHIM", message: r.error.slice(0, 300) } };
  return { data: r.rows[0]?.v ?? null, error: null };
};

const SHIM_SRC = [
  "const mk = globalThis.__REMITTANCE_SELFTEST__;",
  "export const supabaseAdmin = () => ({ from: (t) => mk.makeQuery(t), rpc: (n, a) => mk.rpc(n, a) });",
].join("\n");

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@/server/supabase-admin") {
      return { url: "stub:supabase-admin", shortCircuit: true };
    }
    if (spec.startsWith("@/")) {
      return {
        url: pathToFileURL(join(ROOT, "src", `${spec.slice(2)}.ts`)).href,
        shortCircuit: true,
      };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === "stub:supabase-admin") {
      return { format: "module", source: SHIM_SRC, shortCircuit: true };
    }
    return next(url, ctx);
  },
});

// =============================================================================
// [1] 帳本
// =============================================================================
console.log("\n[1] migration 帳本");
assertLedgerMatchesDisk(check, MIG_DIR);
assertLedgerDeclarationsHonest(check, MIG_DIR);
// 這支自檢守的是匯款：訂單與付款（payment_method 的值域、remittance_* 兩欄）、
// 過期回收（3 天門檻）、站台設定（銀行四欄與它們的 grant）、交易信（匯款信）。
assertMigrationDependencies(check, MIG_DIR, {
  suite: "remittance-selftest",
  dependsOn: ["orders_payments", "order_expiry", "cms", "email_outbox"],
  // ── 0035_admin_order_registration_cleanup.sql 的重讀結論 ───────────────────
  // 0035 是後台訂單刪除／封存＋名單刪除單筆。它標了 orders_payments（加
  // orders.archived_at 一個 nullable 欄位、admin_delete_order() /
  // admin_archive_order() 兩支新函式）與 order_expiry（admin_delete_order() 讀
  // order_items 逐一呼叫 release_session_seat()），但**沒有**標 cms 或
  // email_outbox——0035 完全沒有碰 site_settings（銀行四欄與它們的 column-level
  // grant 一個字都沒動）、email_copy、'remittance' 這個 template_key，或任何
  // enqueue 函式。逐條對過與這支自檢真正相交的三件事：
  //
  //   · expire_unpaid_orders()——0035 沒有 create or replace 它，匯款訂單 3 天
  //     寬限那一行（[14] 段驗的核心）一個字沒被 0034 之後的任何一支動過。
  //   · admin_mark_order_paid()——0035 沒有碰它，[16] 段驗的「保留原本
  //     payment_method、四種 reason、稽核列、grants」全部原樣成立。
  //   · reportRemittance() 的四道閘——0035 完全沒有改 orders.remittance_last5／
  //     remittance_reported_at 的寫入路徑，那支函式與它的 UPDATE 條件一個字
  //     沒動。
  //
  // 唯一新增的欄位 archived_at 與唯一新增的兩支函式，都是**匯款訂單核銷完成之後**
  // 才可能用到的東西（封存一張已付款的匯款訂單，或刪除一張始終沒回報末五碼、
  // 已經取消的匯款訂單）——不影響匯款訂單「怎麼從 pending 走到 paid」的任何一步。
  // 原樣成立。
  // 0040_referral_program.sql（推薦碼與分潤）對 orders 只做了三件事：加三個 nullable
  // 欄位 referrer_id／referral_code／referral_discount_percent（舊訂單全是 NULL）、
  // 一個部分索引、一個指向新表 referrers 的 FK（on delete restrict，限制的是刪推廣者，
  // 不是刪訂單）。既有欄位、CHECK、函式、policy、grant 一個字都沒改。唯一的語意變化
  // 是 orders.discount 從恆為 0 變成「推薦折扣」（只對選品／書籍、最多 50%），而
  // total = subtotal + shipping_fee − discount 仍是金流、信件、發票唯一使用的金額
  // （發票本來就把 discount 開成負數列）。這支自檢的斷言重讀過，原樣成立。
  reviewedThrough: "0040_referral_program.sql",
});

const sql0034 = readFile(MIG_0034);
const exec0034 = stripSqlComments(sql0034);
checkTrue("反空殼：0034 不是空檔", sql0034.length > 5000);

// =============================================================================
// [2] orders.payment_method 的值域
// =============================================================================
console.log("\n[2] payment_method 認得 'transfer'");
{
  const m = exec0034.match(
    /add constraint orders_payment_method_check\s*\n?\s*check \(payment_method is null\s*\n?\s*or payment_method in \(([^)]*)\)/,
  );
  checkTrue("切得出 payment_method 的新值域", Boolean(m));
  const values = (m?.[1] ?? "")
    .split(",")
    .map((v) => v.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
  // 🔴 既有五個值一個都不准掉。掉一個的後果是既有訂單寫不進去（或 add constraint
  //    直接失敗），而那是套用 migration 當下才會發現的事。
  for (const v of ["card", "atm", "cvs_cod", "test_paid", "free"]) {
    checkTrue(`既有的 '${v}' 原樣保留`, values.includes(v));
  }
  checkTrue("新增了 'transfer'", values.includes("transfer"));
  check("剛好六個值（沒有順手多加）", values.length, 6);
  // drop + add 必須在同一個交易裡，否則中間那一瞬間 orders 沒有任何約束。
  checkTrue(
    "drop + add 同一個交易（begin 在 drop 之前，commit 在 add 之後）",
    exec0034.indexOf("begin;") <
      exec0034.indexOf("drop constraint if exists orders_payment_method_check") &&
      exec0034.indexOf("add constraint orders_payment_method_check") <
        exec0034.lastIndexOf("commit;"),
  );
  // ⚠️ 'atm' 與 'transfer' 是兩件事，不可以合併。
  const tplSrc = readFile(join(ROOT, "src/lib/email-templates.ts"));
  checkTrue("email 的付款方式對照表把 transfer 與 atm 分開", /transfer: "匯款/.test(tplSrc));
  checkTrue("而 atm 仍然是「ATM 轉帳」", /atm: "ATM 轉帳"/.test(tplSrc));
}

// =============================================================================
// [3] 3 天這個數字：SQL 與前端必須是同一個
// =============================================================================
console.log("\n[3] 匯款期限 3 天 —— 兩邊同步");
{
  const liveExpire = latestDefinition(MIG_DIR, "expire_unpaid_orders", stripSqlComments);
  checkTrue("反空殼：切得到現在生效的 expire 定義", liveExpire.body.length > 1000);
  // 0036：新增了第 4d 步（一併回沖方案的 units_taken），create or replace 了
  // 這支函式，所以「現在生效的那一份」從 0034 換成 0036——這是 latestDefinition()
  // 存在的理由本身（見它的檔頭）：機械地掃到最後一支定義它的檔案，不必每次改動
  // 這支函式都手動去改這裡指到哪一支。這裡仍然寫死檔名，而不是隨便什麼都算過，
  // 是為了在「以為改到了、其實漏了」的情況下當場報錯，而不是安靜地通過。
  check("現在生效的那一份來自 0036", liveExpire.file, "0036_event_session_plans.sql");
  checkTrue(
    "🔴 匯款訂單的門檻是 greatest(p_older_than, interval '3 days')",
    /payment_method = 'transfer'[\s\S]{0,160}greatest\(p_older_than, interval '3 days'\)/.test(
      liveExpire.body,
    ),
  );
  const checkoutTs = readFile(join(ROOT, "src/lib/checkout.ts"));
  checkTrue("🔴 REMITTANCE_DUE_DAYS 與 SQL 一致", /REMITTANCE_DUE_DAYS = 3;/.test(checkoutTs));
}

// =============================================================================
// [4] 純函式：期限、設定完整性、末五碼格式
// =============================================================================
console.log("\n[4] 純函式（真的呼叫，不是讀原始碼）");
const checkout = await import(pathToFileURL(join(ROOT, "src/lib/checkout.ts")).href);
{
  check("PAYMENT_METHODS 是三個值", checkout.PAYMENT_METHODS.join(","), "card,transfer,offline");
  check("REMITTANCE_DUE_DAYS", checkout.REMITTANCE_DUE_DAYS, 3);

  // 期限：下單 + 3 天。
  check(
    "remittanceDueAt 加 3 天",
    checkout.remittanceDueAt("2026-09-03T01:00:00.000Z"),
    "2026-09-06T01:00:00.000Z",
  );
  // 🔴 壞掉的日期回 null，不是 Invalid Date —— 一個印著「請於 Invalid Date 前完成
  //    匯款」的頁面比一個沒有印期限的頁面糟。
  check("remittanceDueAt 對壞掉的輸入回 null", checkout.remittanceDueAt("不是日期"), null);
  check("remittanceDueAt 對空字串回 null", checkout.remittanceDueAt(""), null);

  // 帳戶完整性：戶名與帳號是最低限度，少了任何一個都匯不了款。
  const full = {
    bankName: "中國信託銀行",
    bankCode: "822",
    bankAccount: "0000406540362705",
    accountName: "好日子股份有限公司",
  };
  check("四欄齊全 → configured", checkout.remittanceConfigured(full), true);
  check("null → 不 configured", checkout.remittanceConfigured(null), false);
  check(
    "缺帳號 → 不 configured",
    checkout.remittanceConfigured({ ...full, bankAccount: "" }),
    false,
  );
  check(
    "缺戶名 → 不 configured",
    checkout.remittanceConfigured({ ...full, accountName: "" }),
    false,
  );
  check(
    "只有空白的帳號 → 不 configured",
    checkout.remittanceConfigured({ ...full, bankAccount: "   " }),
    false,
  );
  // 銀行名稱與代號可以空（有些帳號不需要），不影響能不能匯款。
  check(
    "缺銀行代號仍然 configured",
    checkout.remittanceConfigured({ ...full, bankCode: "" }),
    true,
  );

  // 末五碼格式。這條規則有三份（前端、server function 的 zod、0034 的 CHECK），
  // 這裡驗的是唯一的正本。
  const re = checkout.REMITTANCE_LAST5_RE;
  for (const good of ["12345", "00000", "99999"]) {
    checkTrue(`'${good}' 是合法的末五碼`, re.test(good));
  }
  for (const bad of ["1234", "123456", "1234a", "abcde", "", " 1234", "12 34", "1234５"]) {
    check(`'${bad}' 不是合法的末五碼`, re.test(bad), false);
  }
}

// =============================================================================
// [5] publicSiteUrl —— SITE_URL 那顆地雷
// =============================================================================
console.log("\n[5] publicSiteUrl：組不出可用網址就回 null");
const pubUrl = await import(pathToFileURL(join(ROOT, "src/server/public-url.ts")).href);
{
  const saved = process.env.SITE_URL;
  const CASES = [
    [undefined, null, "SITE_URL 沒設（就是 IB-202600001191 那次事故的狀態）"],
    ["", null, "SITE_URL 是空字串"],
    ["http://localhost:8080", null, "siteUrl() 的預設值"],
    ["https://localhost", null, "https 但 localhost"],
    ["https://127.0.0.1", null, "https 但 loopback"],
    ["https://0.0.0.0", null, "https 但 0.0.0.0"],
    ["https://shop.local", null, "https 但 *.local（mDNS，外面解析不到）"],
    ["http://intervalbooks.tw", null, "正式網域但不是 https"],
    ["https://intervalbooks.tw", "https://intervalbooks.tw", "正式網域 + https"],
    ["https://intervalbooks.tw/", "https://intervalbooks.tw", "結尾斜線去掉"],
  ];
  for (const [value, expected, label] of CASES) {
    if (value === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = value;
    check(`publicSiteUrl()：${label}`, pubUrl.publicSiteUrl(), expected);
    // publicUrlFor() 必須與它同進退 —— 匯款信用的是這一支。
    check(
      `publicUrlFor()：${label}`,
      pubUrl.publicUrlFor("/checkout/complete", { token: "abc" }) === null,
      expected === null,
    );
  }
  process.env.SITE_URL = "https://intervalbooks.tw";
  check(
    "publicUrlFor 組出完整網址，token 有 encode",
    pubUrl.publicUrlFor("/checkout/complete", { token: "a b&c" }),
    "https://intervalbooks.tw/checkout/complete?token=a+b%26c",
  );
  if (saved === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = saved;
}

// =============================================================================
// [6] 匯款資訊信
// =============================================================================
console.log("\n[6] renderRemittanceEmail");
const tpl = await import(pathToFileURL(join(ROOT, "src/lib/email-templates.ts")).href);
{
  const input = {
    orderNo: "IB-202600000042",
    customerName: "王小明",
    total: 1800,
    bankName: "中國信託銀行",
    bankCode: "822",
    bankAccount: "0000406540362705",
    accountName: "好日子股份有限公司",
    dueAt: "2026-09-06T01:00:00.000Z",
    orderUrl: "https://intervalbooks.tw/checkout/complete?token=abc123",
    items: [{ name: { zh: "書", en: "book", ja: "本" }, quantity: 2, subtotal: 1800 }],
    sessions: [],
  };
  const mail = tpl.renderRemittanceEmail(input, undefined, "zh");

  checkTrue("有訂單編號", mail.text.includes("IB-202600000042"));
  checkTrue("有金額（信件用 formatMoney）", mail.text.includes("NT$1,800"));
  checkTrue("有戶名", mail.text.includes("好日子股份有限公司"));
  checkTrue("有銀行", mail.text.includes("中國信託銀行"));
  checkTrue("有銀行代號", mail.text.includes("822"));
  checkTrue("有帳號", mail.text.includes("0000406540362705"));
  checkTrue("有匯款期限（台北時區）", /2026\/09\/06\s+09:00/.test(mail.text));
  // 🔴 那條「回訂單頁填末五碼」的連結。純文字版要印出整條網址（純文字信裡沒有
  //    可以點的東西，藏起來的網址等於沒有網址）。
  checkTrue("純文字版有完整網址", mail.text.includes(input.orderUrl));
  checkTrue("HTML 版有 <a href>", mail.html.includes(`href="${input.orderUrl}"`));
  checkTrue("三個部分都有", Boolean(mail.subject && mail.text && mail.html));
  checkTrue("內建佔位一眼看得出還沒填", mail.subject.includes("（待補："));

  // 空欄位不印整列 —— 一個「銀行代號：」後面空白的欄位會讓人以為資料掉了。
  const noCode = tpl.renderRemittanceEmail({ ...input, bankCode: "" }, undefined, "zh");
  check("銀行代號是空的就不印那一列", /銀行代號/.test(noCode.text), false);
  checkTrue("但帳號還在", noCode.text.includes("0000406540362705"));

  // 期限算不出來就整列不印。
  const noDue = tpl.renderRemittanceEmail({ ...input, dueAt: null }, undefined, "zh");
  check("期限是 null 就不印那一列", /匯款期限/.test(noDue.text), false);
  check("而且絕不出現 Invalid Date", /Invalid Date/.test(noDue.text + noDue.html), false);

  // 三語都渲染得出來，而且不是同一份中文。
  for (const lang of ["zh", "en", "ja"]) {
    const m = tpl.renderRemittanceEmail(input, undefined, lang);
    checkTrue(`${lang} 渲染得出來`, m.subject.length > 0 && m.text.length > 0);
    checkTrue(`${lang} 帳號還在`, m.text.includes("0000406540362705"));
  }
  const en = tpl.renderRemittanceEmail(input, undefined, "en");
  checkTrue("en 用的是英文標籤", en.text.includes("Account name"));

  // DB 文案蓋過內建佔位。
  const custom = tpl.renderRemittanceEmail(
    input,
    { "remittance.subject": { zh: "自訂 {orderNo}", en: "x", ja: "x" } },
    "zh",
  );
  check("DB 文案蓋過內建佔位", custom.subject, "自訂 IB-202600000042");

  // 🔴 跳脫。帳號與網址都會進 HTML。
  const evil = tpl.renderRemittanceEmail(
    {
      ...input,
      accountName: `<script>alert(1)</script>`,
      orderUrl: `https://x.tw/?a="onmouseover="alert(1)`,
    },
    undefined,
    "zh",
  );
  check("HTML 沒有生出 <script>", /<script>/.test(evil.html), false);
  check(
    "href 裡的引號被跳脫（不會長出屬性）",
    /onmouseover=/.test(evil.html.replace(/&quot;/g, "")),
    true,
    "這條期望 true 是因為字串本身含這個字 —— 下一條才是真正的斷言",
  );
  check("🔴 href 屬性沒有被引號提早關掉", /href="[^"]*"[^>]*onmouseover/.test(evil.html), false);
}

// =============================================================================
// [7] 店家的兩封信必須分得開
// =============================================================================
console.log("\n[7] 店家通知信：下單當下 vs 付款成功");
{
  const base = {
    orderNo: "IB-202600000042",
    total: 1800,
    paymentMethod: "transfer",
    shippingMethod: "home",
    items: [{ name: { zh: "書", en: "book", ja: "本" }, quantity: 1, subtotal: 1800 }],
    sessions: [],
  };
  const placed = tpl.renderAdminOrderNotificationEmail({ ...base, stage: "atOrderTime" });
  const paid = tpl.renderAdminOrderNotificationEmail({ ...base, stage: "afterPayment" });

  // 🔴 主旨必須不一樣：兩封信要店家做的事完全不同（一封「錢收到了，去出貨」，
  //    一封「還沒收到錢，去追」）。主旨一樣的話收件匣裡分不出來，而分不出來的
  //    後果是有人去出一張沒收到錢的貨。
  checkTrue("下單當下那封主旨寫「待收款」", placed.subject.includes("待收款"));
  check("兩封信的主旨不一樣", placed.subject === paid.subject, false);
  checkTrue("下單當下那封說明款項尚未入帳", placed.text.includes("款項尚未入帳"));
  check("付款成功那封沒有那句話", paid.text.includes("款項尚未入帳"), false);
  checkTrue("下單當下那封告訴店家下一步要做什麼", placed.text.includes("標記為已付款"));
  checkTrue("付款方式印成「匯款（人工對帳）」", placed.text.includes("匯款（人工對帳）"));

  // offline（payment_method = NULL）在下單當下是**正常值**，不是「webhook 還沒填」。
  const offline = tpl.renderAdminOrderNotificationEmail({
    ...base,
    paymentMethod: null,
    stage: "atOrderTime",
  });
  checkTrue(
    "offline 訂單印「由我們與客人聯繫付款」",
    offline.text.includes("由我們與客人聯繫付款"),
  );
  check("而不是「（未設定）」", offline.text.includes("（未設定）"), false);

  // ⚠️ 這封信刻意不含客人的姓名、電話、地址（型別上就沒有這些欄位）。
  const tplSrc = readFile(join(ROOT, "src/lib/email-templates.ts"));
  const typeBlock = tplSrc.slice(
    tplSrc.indexOf("export type AdminOrderNotificationInput"),
    tplSrc.indexOf("// ---", tplSrc.indexOf("export type AdminOrderNotificationInput")),
  );
  checkTrue("反空殼：切得到 AdminOrderNotificationInput 的型別", typeBlock.length > 200);
  for (const field of ["customerName", "customerPhone", "address", "customerEmail"]) {
    check(`店家通知信的型別上沒有 ${field}`, typeBlock.includes(field), false);
  }
}

// =============================================================================
// [8] dedupe_key：兩封店家信的前綴必須不同
// =============================================================================
console.log("\n[8] dedupe_key 的前綴");
// ⚠️ 這裡 import **產線的 notify.ts 本人**，不是用 regex 去掃它的原始碼。
//    regex 會在「格式改了但語意沒改」的時候假性轉紅，更糟的是會在「語意改了但
//    格式還像」的時候假性通過。dedupeKeys 是一個純粹的物件，直接叫它就好。
const notify = await import(pathToFileURL(join(ROOT, "src/server/notify.ts")).href);
{
  const keys = notify.dedupeKeys;
  checkTrue(
    "反空殼：載得動產線的 notify.ts 並拿到 dedupeKeys",
    keys && typeof keys.orderPaid === "function",
  );
  check("orderPaid", keys.orderPaid("OID"), "order_paid:OID");
  check("registrationTicket", keys.registrationTicket("RID"), "registration_ticket:RID");
  check("sessionReminder", keys.sessionReminder("SID", "RID"), "session_reminder:SID:RID");
  check(
    "orderNotifyAdmin（0032，付款成功之後）",
    keys.orderNotifyAdmin("OID"),
    "order_notify_admin:OID",
  );
  check("remittance（0034，客人的匯款資訊信）", keys.remittance("OID"), "remittance:OID");
  check(
    "orderPlacedAdmin（0034，下單當下）",
    keys.orderPlacedAdmin("OID"),
    "order_placed_admin:OID",
  );

  // 🔴 這一條是重點。共用 key 的後果：一張匯款訂單在下單當下佔掉了
  //    order_notify_admin:<id>，店家對完帳把它標成已付款、queueOrderNotifications()
  //    跑起來時，那封「已收款」通知會撞 dedupe_key 變成 no-op —— 店家從此再也收不到
  //    任何一張匯款訂單的收款通知，而 outbox 裡看起來一切正常（那一列確實存在，
  //    只是內容是三天前那封「有新單」）。[17] 對真的 outbox 再驗一次同一件事。
  check(
    "🔴 下單當下與付款成功兩封店家信的 dedupe key 不同",
    keys.orderPlacedAdmin("SAME") === keys.orderNotifyAdmin("SAME"),
    false,
  );
  // 同一張訂單餵給每一支，六個 key 必須互不相同。
  const sameOrder = [
    keys.orderPaid("X"),
    keys.registrationTicket("X"),
    keys.sessionReminder("X", "X"),
    keys.orderNotifyAdmin("X"),
    keys.remittance("X"),
    keys.orderPlacedAdmin("X"),
  ];
  check("同一個 id 餵進六支，六把 key 互不重複", sameOrder.length, new Set(sameOrder).size);
  // 前綴不可以是另一個前綴的前綴（`remittance:` vs `remittance_x:` 這種）——
  // 它們共用一個 unique index，命名相似只是可讀性問題，但相同就是事故。
  checkTrue(
    "每一把 key 都帶冒號分隔的前綴",
    sameOrder.every((k) => /^[a-z_]+:/.test(k)),
  );
}

// =============================================================================
// [9] 授權模型：末五碼與重新付款
// =============================================================================
console.log("\n[9] 授權模型的形狀");
{
  const ordersSrc = readFile(join(ROOT, "src/server/repos/orders.ts"));
  const code = stripTs(ordersSrc);

  // 🔴 「只能回報一次」必須是那句 UPDATE 的 WHERE 條件，不是先 select 再判斷。
  //    先 select 再 update 的寫法在四道閘門之間各有一個空窗。
  const body = code.slice(code.indexOf("export async function reportRemittance"));
  const cas = body.slice(0, body.indexOf('.select("id")'));
  checkTrue("反空殼：切得到 reportRemittance 的 CAS", cas.length > 100 && cas.includes(".update("));
  checkTrue("① 認 public_token（不是訂單編號）", /\.eq\("public_token", token\)/.test(cas));
  checkTrue("② 只有匯款訂單", /\.eq\("payment_method", "transfer"\)/.test(cas));
  checkTrue("③ 只有 pending", /\.eq\("status", "pending"\)/.test(cas));
  checkTrue("④ 已付款的不准", /\.neq\("payment_status", "paid"\)/.test(cas));
  checkTrue(
    "⑤ 🔴 只能回報一次（remittance_last5 is null 在 WHERE 裡）",
    /\.is\("remittance_last5", null\)/.test(cas),
  );
  check(
    "🔴 沒有「先 select 再判斷再 update」的寫法（四道閘門之間會有空窗）",
    /const .*await[\s\S]{0,200}\.select\([\s\S]{0,200}if[\s\S]{0,200}\.update\(/.test(cas),
    false,
  );
  // 格式在進資料庫之前先擋一次。
  checkTrue(
    "末五碼格式用共用的 REMITTANCE_LAST5_RE",
    /REMITTANCE_LAST5_RE\.test\(trimmed\)/.test(code),
  );

  // 🔴 匯款訂單不可以被推進刷卡流程。完成頁不畫那顆按鈕只是不畫，不是防線 ——
  //    retryPayment 是公開的 server function，有 token 就叫得動。
  const reissue = code.slice(code.indexOf("export async function reissuePayment"));
  const reissueBody = reissue.slice(0, reissue.indexOf("\n}"));
  checkTrue(
    "🔴 reissuePayment 擋掉匯款訂單（否則同一個 token 可以再刷一次卡）",
    /payment_method === "transfer"\) return null/.test(reissueBody),
  );
  checkTrue(
    "reissuePayment 有把 payment_method 查出來",
    /payment_method"\)/.test(reissueBody) || /payment_method/.test(reissueBody),
  );

  // awaitingPayment 對匯款訂單必須是 false。
  checkTrue(
    "🔴 awaitingPayment 排除 transfer（否則完成頁會空轉輪詢並長出重新付款按鈕）",
    /payment_method !== "transfer" &&/.test(code),
  );
}

// =============================================================================
// [10] site_settings 的四個銀行欄位不可以對 anon 開放
// =============================================================================
console.log("\n[10] 銀行欄位不進 anon 的 grant 清單");
{
  const sql0032 = readFile(join(MIG_DIR, "0032_admin_order_notify.sql"));
  const grantBlock = (stripSqlComments(sql0032).match(
    /grant select \(([\s\S]*?)\) on public\.site_settings to anon, authenticated;/,
  ) ?? [])[1];
  checkTrue(
    "反空殼：切得到 0032 的 column-level grant 清單",
    Boolean(grantBlock) && grantBlock.length > 100,
  );
  const granted = (grantBlock ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  for (const col of [
    "bank_name",
    "bank_code",
    "bank_account",
    "bank_account_name",
    "notify_emails",
  ]) {
    check(`🔴 ${col} 不在 anon 的 grant 清單裡`, granted.includes(col), false);
  }
  // 🔴 反面對照：前台真的要用的每一欄都必須還在清單裡。漏一欄 = PostgREST 42501，
  //    整個頁尾／聯絡資訊在正式站上消失。
  const cmsSrc = readFile(join(ROOT, "src/lib/cms.ts"));
  const cmsCols = (cmsSrc.match(/"(short_desc,[^"]*)"/) ?? [])[1];
  checkTrue(
    "反空殼：切得到 cms.ts 要的欄位清單",
    Boolean(cmsCols) && cmsCols.split(",").length >= 15,
  );
  for (const col of (cmsCols ?? "").split(",").map((c) => c.trim())) {
    checkTrue(`前台要的 ${col} 仍然在 grant 清單裡`, granted.includes(col));
  }

  // 0034 **不可以**重新下一筆 table-level grant（那會把四欄一起開出去）。
  check(
    "🔴 0034 沒有把整張表的 select 重新 grant 給 anon",
    /grant select on (public\.)?site_settings to/i.test(exec0034),
    false,
  );
  // 0034 自己有一段 DO block 在驗這件事。
  checkTrue(
    "0034 自己有守衛（四欄可讀就 raise）",
    /has_column_privilege\('anon', 'public\.site_settings', col, 'SELECT'\)/.test(exec0034),
  );
  checkTrue(
    "而且有反面對照（short_desc 必須仍然可讀）",
    /has_column_privilege\('anon', 'public\.site_settings', 'short_desc', 'SELECT'\)/.test(
      exec0034,
    ),
  );
}

// =============================================================================
// [11] admin_mark_order_paid 的形狀
// =============================================================================
console.log("\n[11] admin_mark_order_paid");
{
  const fn = latestDefinition(MIG_DIR, "admin_mark_order_paid", stripSqlComments);
  checkTrue("反空殼：切得到函式本體", fn.body.length > 500);
  // 🔴 這支函式存在的唯一理由：markOrderPaid() 會把 payment_method 硬寫成 'card'。
  check(
    "🔴 SET 清單裡沒有 payment_method（保留原本的值）",
    /set[\s\S]*?where o\.id = p_order_id/.test(fn.body) &&
      /set[\s\S]{0,300}payment_method\s*=/.test(fn.body),
    false,
  );
  checkTrue(
    "狀態組合與 markOrderPaid 相同",
    /status\s*=\s*'processing'/.test(fn.body) &&
      /payment_status\s*=\s*'paid'/.test(fn.body) &&
      /paid_at\s*=\s*now\(\)/.test(fn.body),
  );
  // 金額只從資料庫那一列讀。一個 p_amount 參數就是一個「幫我把這張三千塊的單標成
  // 付清」的入口。
  check("沒有金額參數", /p_amount|p_total/.test(fn.body), false);
  checkTrue("security definer", /security definer/.test(fn.body));
  checkTrue("set search_path = ''", /set search_path = ''/.test(fn.body));
  checkTrue(
    "從 public revoke execute",
    /revoke execute on function public\.admin_mark_order_paid\(uuid, uuid, text\) from public/.test(
      exec0034,
    ),
  );
  checkTrue(
    "從 anon/authenticated revoke",
    /revoke execute on function public\.admin_mark_order_paid\(uuid, uuid, text\) from anon, authenticated/.test(
      exec0034,
    ),
  );
  checkTrue(
    "只 grant service_role",
    /grant\s+execute on function public\.admin_mark_order_paid\(uuid, uuid, text\) to service_role/.test(
      exec0034,
    ),
  );
}

// =============================================================================
// 連線段
// =============================================================================
const PG_URL = process.env.REMITTANCE_SELFTEST_PG_URL;

async function q(sql, single = true) {
  const text = single
    ? `select coalesce(json_agg(t), '[]'::json)::text from (\n${sql.trim().replace(/;\s*$/, "")}\n) t`
    : sql;
  try {
    const { stdout } = await execFileAsync(
      "psql",
      ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", PG_URL, "-c", text],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    if (!single) return { ok: true, error: null, rows: [] };
    return { ok: true, error: null, rows: JSON.parse(stdout.trim() || "[]") };
  } catch (err) {
    return { ok: false, error: String(err.stderr ?? err.message ?? err), rows: [] };
  }
}
async function must(sql, single = true) {
  const r = await q(sql, single);
  if (!r.ok)
    throw new Error(`SQL 失敗：${r.error.slice(0, 400)}\n--- SQL ---\n${sql.slice(0, 600)}`);
  return r.rows;
}
const one = (rows) => (Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
const num = (rows) => Number(one(rows)?.n ?? -1);

/**
 * 接上 shim。
 *
 * ⚠️ UPDATE 不能像 SELECT 那樣被包進 `select … from ( … ) t` 的子查詢裡，所以這裡
 *    改用 data-modifying CTE 把 RETURNING 的結果撈出來。兩條路都會回同一個形狀
 *    （{ok, rows}），產線程式碼分辨不出來——它拿到的就是 PostgREST 會給它的東西。
 */
SHIM.runSql = async (sql) => {
  if (!/^\s*update\b/i.test(sql)) return q(sql);
  const text = `with t as (\n${sql}\n) select coalesce(json_agg(t), '[]'::json)::text from t`;
  try {
    const { stdout } = await execFileAsync(
      "psql",
      ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", PG_URL, "-c", text],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return { ok: true, error: null, rows: JSON.parse(stdout.trim() || "[]") };
  } catch (err) {
    return { ok: false, error: String(err.stderr ?? err.message ?? err), rows: [] };
  }
};

const KEY_PREFIX = "rmt34-";
const SLUG_PREFIX = "rmt34-";
const CLEANUP_SQL = `
delete from public.event_registrations r
 where r.order_id in (select o.id from public.orders o where o.idempotency_key like '${KEY_PREFIX}%')
    or r.session_id in (select s.id from public.event_sessions s where s.product_id like '${SLUG_PREFIX}%');
delete from public.email_outbox where dedupe_key like '%${KEY_PREFIX}%';
delete from public.payments where order_id in (select id from public.orders where idempotency_key like '${KEY_PREFIX}%');
delete from public.orders where idempotency_key like '${KEY_PREFIX}%';
delete from public.event_sessions where product_id like '${SLUG_PREFIX}%';
delete from public.products where id like '${SLUG_PREFIX}%';
`;

if (!PG_URL) {
  skipped.push("連線段（缺 REMITTANCE_SELFTEST_PG_URL）");
  console.log(yellow("\n[12–16] 連線段 —— 跳過：沒有 REMITTANCE_SELFTEST_PG_URL"));
  console.log(yellow("       設好之後重跑，才會驗到過期的三條、末五碼的四道閘、"));
  console.log(yellow("       admin_mark_order_paid、dedupe_key 分離與欄位權限。指令見本檔檔頭。"));
} else {
  try {
    if (process.env.REMITTANCE_SELFTEST_APPLY === "1") {
      console.log("\n[12] 套用 0001–0034（REMITTANCE_SELFTEST_APPLY=1）");
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
        // 0008 要 pg_net + vault + pg_cron，本機沒有。
        if (f.startsWith("0008_")) continue;
        const r = await q(readFile(join(MIG_DIR, f)), false);
        if (!r.ok) throw new Error(`套用 ${f} 失敗：${r.error.slice(0, 600)}`);
      }
      checkTrue("0001–0034 套用完成（0008 跳過）", true);
      // 冪等：0034 再套一次必須零錯誤。
      const again = await q(sql0034, false);
      checkTrue("0034 套第二次零錯誤（冪等）", again.ok);
      if (!again.ok) console.log(red(`      ${again.error.slice(0, 300)}`));
    }

    console.log("\n[13] 前置：建立測試資料");
    await must(CLEANUP_SQL, false);
    const LOC = `'{"zh":"自檢","en":"selftest","ja":"セルフテスト"}'::jsonb`;
    const PRODUCT = `${SLUG_PREFIX}ev`;
    const SESSION = "cccc0000-0000-4000-8000-000000000001";
    await must(
      `
      insert into public.products (id, slug, product_type, title, summary, description, price, status)
      values ('${PRODUCT}','${PRODUCT}','event', ${LOC}, ${LOC}, ${LOC}, 500, 'active');
      insert into public.event_sessions (id, product_id, title, location, starts_at, capacity, status)
      values ('${SESSION}','${PRODUCT}', ${LOC}, ${LOC}, now() + interval '40 days', 10, 'open');
      insert into public.orders (customer_name, customer_email, customer_phone,
                                 subtotal, total, idempotency_key, payment_method)
      values ('自檢','rmt-t3@example.invalid','0900000000',500,500,'${KEY_PREFIX}transfer-3h','transfer'),
             ('自檢','rmt-t4@example.invalid','0900000000',500,500,'${KEY_PREFIX}transfer-4d','transfer'),
             ('自檢','rmt-c3@example.invalid','0900000000',500,500,'${KEY_PREFIX}card-3h','card');
      insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
      select o.id, '${PRODUCT}', '${SESSION}', ${LOC}, 500, 1, 500, 'event'
        from public.orders o where o.idempotency_key like '${KEY_PREFIX}%';
      do $$
      declare it record;
      begin
        for it in select oi.id, oi.order_id from public.order_items oi
                   join public.orders o on o.id = oi.order_id
                  where o.idempotency_key like '${KEY_PREFIX}%' order by o.idempotency_key
        loop
          perform public.reserve_session_seat(it.order_id, it.id, '${SESSION}', 1,
            '[{"name":"P","email":"p@example.invalid","phone":null,"noticeAck":"true"}]'::jsonb);
        end loop;
      end $$;
    `,
      false,
    );
    check(
      "前置：3 個位子被佔住",
      num(await must(`select seats_taken n from public.event_sessions where id='${SESSION}'`)),
      3,
    );
    check(
      "前置：3 筆 registrations",
      num(
        await must(
          `select count(*)::int n from public.event_registrations where session_id='${SESSION}'`,
        ),
      ),
      3,
    );

    // =========================================================================
    // [14] 🔴 過期回收：匯款訂單留 3 天
    // =========================================================================
    console.log("\n[14] 🔴 expire_unpaid_orders —— 匯款訂單的 3 天寬限");
    // 把 created_at 挪回去：兩張挪前 3 小時、一張挪到 4 天前。
    await must(
      `
      update public.orders set created_at = now() - interval '3 hours'
       where idempotency_key in ('${KEY_PREFIX}transfer-3h','${KEY_PREFIX}card-3h');
      update public.orders set created_at = now() - interval '4 days'
       where idempotency_key = '${KEY_PREFIX}transfer-4d';
    `,
      false,
    );
    // 正式庫上那支 pg_cron 用的就是這一組參數。
    await must(`select * from public.expire_unpaid_orders(interval '2 hours')`);

    const state = async (key) =>
      one(
        await must(`select status, payment_status, payment_method,
                             (select count(*)::int from public.event_registrations r where r.order_id = o.id) regs
                        from public.orders o where o.idempotency_key = '${key}'`),
      );

    const t3 = await state(`${KEY_PREFIX}transfer-3h`);
    check("🔴 匯款訂單過了 3 小時：**沒有**被取消", t3?.status, "pending");
    check("   payment_status 還是 pending", t3?.payment_status, "pending");
    check("   payment_method 還是 transfer", t3?.payment_method, "transfer");
    check("🔴 它的 event_registrations 還在", Number(t3?.regs), 1);

    const t4 = await state(`${KEY_PREFIX}transfer-4d`);
    check("匯款訂單過了 4 天：被取消", t4?.status, "cancelled");
    check("   它的 event_registrations 被刪掉", Number(t4?.regs), 0);

    // 對照組：沒有這一條，上面兩條有可能是因為 expire 整支壞掉。
    const c3 = await state(`${KEY_PREFIX}card-3h`);
    check("🔴 對照組：刷卡訂單過了 3 小時**照樣**被取消（沒有誤傷）", c3?.status, "cancelled");
    check("   它的 event_registrations 也被刪掉", Number(c3?.regs), 0);

    // 位子回沖：3 個 → 只剩匯款那一張的 1 個。
    check(
      "seats_taken 回沖到 1（只剩還活著那一張）",
      num(await must(`select seats_taken n from public.event_sessions where id='${SESSION}'`)),
      1,
    );

    // =========================================================================
    // [15] 末五碼：四道閘門（驅動產線的 reportRemittance）
    // =========================================================================
    console.log("\n[15] 🔴 reportRemittance —— 四道閘門（產線程式碼 + 真的資料庫）");
    {
      // 兩張新的匯款訂單：一張可以回報，一張已付款。
      await must(
        `
        insert into public.orders (customer_name, customer_email, customer_phone,
                                   subtotal, total, idempotency_key, payment_method)
        values ('自檢','rmt-r1@example.invalid','0900000000',500,500,'${KEY_PREFIX}report-ok','transfer'),
               ('自檢','rmt-r2@example.invalid','0900000000',500,500,'${KEY_PREFIX}report-paid','transfer'),
               ('自檢','rmt-r3@example.invalid','0900000000',500,500,'${KEY_PREFIX}report-card','card');
        update public.orders set payment_status='paid', status='processing', paid_at=now()
         where idempotency_key = '${KEY_PREFIX}report-paid';
      `,
        false,
      );
      // ⚠️ 欄位別名不可以叫 `t` —— q() 會把查詢包進 `… from ( … ) t`，`json_agg(t)`
      //    裡的 `t` 會解成子查詢別名（整列），欄位別名被蓋掉，拿到的是 undefined。
      //    這一條踩過一次，留著註解免得下一個人再踩。
      const tok = async (key) =>
        one(await must(`select public_token tk from public.orders where idempotency_key='${key}'`))
          ?.tk;
      const tokOk = await tok(`${KEY_PREFIX}report-ok`);
      const tokPaid = await tok(`${KEY_PREFIX}report-paid`);
      const tokCard = await tok(`${KEY_PREFIX}report-card`);

      const orders = await import(pathToFileURL(join(ROOT, "src/server/repos/orders.ts")).href);
      checkTrue("反空殼：載得動產線的 orders.ts", typeof orders.reportRemittance === "function");

      // ── 閘 ④：格式 ──────────────────────────────────────────────────────
      for (const bad of ["1234", "123456", "abcde", "12 45", ""]) {
        const r = await orders.reportRemittance(tokOk, bad);
        check(`非 5 碼數字被拒：'${bad}'`, r.ok === false && r.reason === "bad_format", true);
      }
      // 而且**一個字都沒寫進去**。
      check(
        "被拒的請求沒有寫進資料庫",
        num(
          await must(`select count(*)::int n from public.orders
                         where idempotency_key='${KEY_PREFIX}report-ok' and remittance_last5 is not null`),
        ),
        0,
      );

      // ── 別人的 token 改不到 ────────────────────────────────────────────
      const bogus = await orders.reportRemittance("thisisnotarealtoken0000000000", "12345");
      check("🔴 不存在的 token 改不到任何東西", bogus.ok, false);
      check(
        "   而且沒有任何一列被寫入",
        num(
          await must(`select count(*)::int n from public.orders where remittance_last5 = '12345'`),
        ),
        0,
      );

      // ── 閘 ②：不是匯款訂單 ────────────────────────────────────────────
      const card = await orders.reportRemittance(tokCard, "12345");
      check(
        "🔴 刷卡訂單的 token 不能回報末五碼",
        card.ok === false && card.reason === "not_transfer",
        true,
      );

      // ── 閘 ③：已付款 ──────────────────────────────────────────────────
      const paid = await orders.reportRemittance(tokPaid, "12345");
      check("🔴 已付款的訂單拒絕回報", paid.ok, false);
      check(
        "   它的 remittance_last5 仍然是 null",
        num(
          await must(`select count(*)::int n from public.orders
                         where idempotency_key='${KEY_PREFIX}report-paid' and remittance_last5 is null`),
        ),
        1,
      );

      // ── 正常路徑 ──────────────────────────────────────────────────────
      const ok = await orders.reportRemittance(tokOk, "54321");
      check("✅ 正常回報成功", ok.ok, true);
      check("   回傳的末五碼", ok.ok ? ok.last5 : null, "54321");
      const row = one(
        await must(`select remittance_last5 l5, (remittance_reported_at is not null) rep
                                    from public.orders where idempotency_key='${KEY_PREFIX}report-ok'`),
      );
      check("   資料庫裡真的寫進去了", row?.l5, "54321");
      check("   時間戳也一起寫了（CHECK 綁成同進同出）", row?.rep, true);

      // ── 閘 ⑤：只能回報一次 ────────────────────────────────────────────
      const twice = await orders.reportRemittance(tokOk, "11111");
      check("🔴 第二次回報被拒", twice.ok === false && twice.reason === "already_reported", true);
      check(
        "   而且原本那組號碼**沒有**被改掉（這是店家對帳要相信的證詞）",
        one(
          await must(
            `select remittance_last5 l from public.orders where idempotency_key='${KEY_PREFIX}report-ok'`,
          ),
        )?.l,
        "54321",
      );

      // 半套狀態進不去：CHECK 綁著兩欄同進同出。
      const halfA = await q(
        `update public.orders set remittance_last5='99999'
                              where idempotency_key='${KEY_PREFIX}report-paid'`,
        false,
      );
      check("🔴 只寫末五碼、不寫時間 → 被 CHECK 擋下", halfA.ok, false);
      const halfB = await q(
        `update public.orders set remittance_reported_at=now()
                              where idempotency_key='${KEY_PREFIX}report-paid'`,
        false,
      );
      check("🔴 只寫時間、不寫末五碼 → 被 CHECK 擋下", halfB.ok, false);
      // 格式也在資料庫這一層擋一次。
      const badFmt = await q(
        `update public.orders set remittance_last5='abc', remittance_reported_at=now()
                               where idempotency_key='${KEY_PREFIX}report-paid'`,
        false,
      );
      check("🔴 非數字的末五碼 → 被 CHECK 擋下（應用層之外的第二道）", badFmt.ok, false);
    }

    // =========================================================================
    // [16] admin_mark_order_paid
    // =========================================================================
    console.log("\n[16] admin_mark_order_paid —— 保留 payment_method");
    {
      const id = one(
        await must(`select id from public.orders where idempotency_key='${KEY_PREFIX}report-ok'`),
      )?.id;
      const r1 = one(
        await must(`select * from public.admin_mark_order_paid('${id}'::uuid,
                                  '22222222-2222-2222-2222-222222222222'::uuid, '對到 9/3 01:15 那筆')`),
      );
      check("標記成功", r1?.marked, true);
      const after = one(
        await must(`select status, payment_status, payment_method,
                                           (paid_at is not null) p
                                      from public.orders where id='${id}'`),
      );
      check("   status → processing", after?.status, "processing");
      check("   payment_status → paid", after?.payment_status, "paid");
      check(
        "🔴 payment_method **仍然是 transfer**（markOrderPaid 會寫成 card）",
        after?.payment_method,
        "transfer",
      );
      check("   paid_at 有值", after?.p, true);

      // 稽核列。
      const pay = one(
        await must(`select gateway, status, amount, raw_response->>'actor_id' actor,
                                         raw_response->>'note' note, raw_response->>'remittance_last5' l5
                                    from public.payments where order_id='${id}'`),
      );
      check("留下一列 payments 稽核", pay?.gateway, "transfer");
      check("   記下是誰做的", pay?.actor, "22222222-2222-2222-2222-222222222222");
      check("   記下備註", pay?.note, "對到 9/3 01:15 那筆");
      check("   記下當時的末五碼", pay?.l5, "54321");
      check("   金額從訂單那一列讀（不是呼叫端說了算）", Number(pay?.amount), 500);

      // 冪等。
      const r2 = one(
        await must(`select * from public.admin_mark_order_paid('${id}'::uuid, null, null)`),
      );
      check("第二次呼叫回 already_paid（冪等）", r2?.reason, "already_paid");
      check(
        "   而且沒有留下第二列稽核",
        num(await must(`select count(*)::int n from public.payments where order_id='${id}'`)),
        1,
      );

      // 已取消的訂單不准被推回 paid。
      const cancelledId = one(
        await must(`select id from public.orders where idempotency_key='${KEY_PREFIX}card-3h'`),
      )?.id;
      const r3 = one(
        await must(
          `select * from public.admin_mark_order_paid('${cancelledId}'::uuid, null, null)`,
        ),
      );
      check("🔴 已取消的訂單不准被標成已付款", r3?.reason, "order_not_pending");
      check(
        "   它仍然是 cancelled",
        one(await must(`select status s from public.orders where id='${cancelledId}'`))?.s,
        "cancelled",
      );

      const r4 = one(
        await must(
          `select * from public.admin_mark_order_paid('00000000-0000-0000-0000-000000000000'::uuid, null, null)`,
        ),
      );
      check("不存在的訂單回 order_not_found", r4?.reason, "order_not_found");

      // 授權：anon / authenticated 叫不動。
      const acl = one(
        await must(`select
        has_function_privilege('anon','public.admin_mark_order_paid(uuid,uuid,text)','EXECUTE') a,
        has_function_privilege('authenticated','public.admin_mark_order_paid(uuid,uuid,text)','EXECUTE') u,
        has_function_privilege('service_role','public.admin_mark_order_paid(uuid,uuid,text)','EXECUTE') s`),
      );
      check("🔴 anon 叫不動", acl?.a, false);
      check("🔴 authenticated 叫不動", acl?.u, false);
      check("service_role 叫得動（反面對照）", acl?.s, true);
    }

    // =========================================================================
    // [17] dedupe_key 分離 —— 對真的 email_outbox 跑
    // =========================================================================
    console.log("\n[17] 🔴 兩封店家信在真的 outbox 裡分得開");
    {
      // ⚠️ site_settings 的單例列是 supabase/seed.sql 建的，**不是** migration。本機
      //    測試庫沒有它，enqueue_admin_order_email() 會因為查不到列而一律回 false，
      //    於是下面「兩封信都排得進去」會變成一個假性失敗（或者更糟：假性通過）。
      await must(
        `
        insert into public.site_settings
          (id, short_desc, address, city, hours, closed,
           contact_email, site_url, map_embed, map_link, map_apple,
           meta_site_name, meta_author, default_meta_title, default_meta_description,
           notify_emails)
        overriding system value
        values (1, ${LOC}, ${LOC}, ${LOC}, ${LOC}, ${LOC},
                'selftest@example.invalid', 'https://example.invalid', '', '', '',
                'selftest', 'selftest', 'selftest', 'selftest',
                'shop@example.invalid')
        on conflict (id) do update set notify_emails = excluded.notify_emails;
      `,
        false,
      );
      check(
        "前置：site_settings 有店家收件人",
        num(
          await must(`select count(*)::int n from public.site_settings
                         where id = 1 and notify_emails <> ''`),
        ),
        1,
      );
      const oid = one(
        await must(`select id from public.orders where idempotency_key='${KEY_PREFIX}report-paid'`),
      )?.id;
      const placedKey = `order_placed_admin:${oid}`;
      const paidKey = `order_notify_admin:${oid}`;

      const a = one(
        await must(`select public.enqueue_admin_order_email('${placedKey}','待收款','t','h') ok`),
      );
      check("下單當下那封排進去了", a?.ok, true);
      const b = one(
        await must(`select public.enqueue_admin_order_email('${paidKey}','已收款','t','h') ok`),
      );
      check("🔴 付款成功那封**也**排進去了（沒有被前一封的 key 吃掉）", b?.ok, true);
      check(
        "outbox 裡真的有兩列",
        num(
          await must(`select count(*)::int n from public.email_outbox
                         where dedupe_key in ('${placedKey}','${paidKey}')`),
        ),
        2,
      );
      check(
        "   兩封主旨不一樣",
        num(
          await must(`select count(distinct subject)::int n from public.email_outbox
                         where dedupe_key in ('${placedKey}','${paidKey}')`),
        ),
        2,
      );

      // 反面對照：同一把 key 排第二次確實是 no-op —— 證明上面那個「兩列」不是因為
      // dedupe 整個沒作用。
      const dup = one(
        await must(`select public.enqueue_admin_order_email('${placedKey}','重複','t','h') ok`),
      );
      check("🔴 反面對照：同一把 key 第二次是 no-op（dedupe 真的有在作用）", dup?.ok, false);
      check(
        "   outbox 仍然只有兩列",
        num(
          await must(`select count(*)::int n from public.email_outbox
                         where dedupe_key in ('${placedKey}','${paidKey}')`),
        ),
        2,
      );
      await must(
        `delete from public.email_outbox where dedupe_key in ('${placedKey}','${paidKey}')`,
        false,
      );
    }

    // =========================================================================
    // [18] site_settings 的欄位權限（對真的資料庫問）
    // =========================================================================
    console.log("\n[18] 銀行欄位的 column-level grant");
    {
      for (const col of ["bank_name", "bank_code", "bank_account", "bank_account_name"]) {
        const r = one(
          await must(`select
          has_column_privilege('anon','public.site_settings','${col}','SELECT') a,
          has_column_privilege('authenticated','public.site_settings','${col}','SELECT') u`),
        );
        check(`🔴 anon 讀不到 site_settings.${col}`, r?.a, false);
        check(`🔴 authenticated 讀不到 site_settings.${col}`, r?.u, false);
      }
      // 🔴 反面對照：前台要的每一欄都必須讀得到。沒有這一組，上面那幾條有可能是
      //    因為整張表的 grant 被收光了 —— 那是另一個（更嚴重的）bug。
      const cmsSrc = readFile(join(ROOT, "src/lib/cms.ts"));
      const cols = ((cmsSrc.match(/"(short_desc,[^"]*)"/) ?? [])[1] ?? "")
        .split(",")
        .map((c) => c.trim());
      checkTrue("反空殼：cms.ts 的欄位清單抓得到", cols.length >= 15);
      const bad = await must(`select c from unnest(array[${cols.map((c) => `'${c}'`).join(",")}]) c
                               where not has_column_privilege('anon','public.site_settings',c,'SELECT')`);
      check(
        "前台既有的每一欄 anon 都還讀得到",
        bad.map((r) => r.c).join(",") || "（無）",
        "（無）",
      );
    }

    // =========================================================================
    // [20] 🔴 SITE_URL 不可用時：匯款信不寄、訂單照樣成立
    // =========================================================================
    // 這一段驅動**產線的 queueOrderPlacedNotifications()**（src/server/notify.ts），
    // 不是重寫一次它的邏輯。它會真的去讀 site_settings、真的組信、真的呼叫
    // enqueue_order_email() / enqueue_admin_order_email() 這兩支 SQL 函式。
    console.log("\n[20] 🔴 SITE_URL 不可用 → 匯款信不寄，但訂單不受影響");
    {
      // 店家把匯款帳戶設好（否則不寄信的原因會變成「沒帳戶」而不是「沒網址」，
      // 那樣這一段驗到的就不是我們想驗的東西）。
      await must(
        `
        update public.site_settings
           set bank_name = '中國信託銀行', bank_code = '822',
               bank_account = '0000406540362705', bank_account_name = '好日子股份有限公司'
         where id = 1;
      `,
        false,
      );

      const mkOrder = async (key) => {
        await must(
          `
          insert into public.orders (customer_name, customer_email, customer_phone,
                                     subtotal, total, idempotency_key, payment_method, locale)
          values ('自檢','rmt-url@example.invalid','0900000000',500,500,'${KEY_PREFIX}${key}','transfer','zh');
        `,
          false,
        );
        return one(
          await must(`select id from public.orders where idempotency_key='${KEY_PREFIX}${key}'`),
        )?.id;
      };
      const outboxKeys = async (oid) =>
        (
          await must(`select dedupe_key k from public.email_outbox
                      where dedupe_key like '%' || '${oid}'`)
        )
          .map((r) => r.k)
          .sort();

      const savedSiteUrl = process.env.SITE_URL;

      // ── 情況 A：SITE_URL 好的 → 兩封信都排進去 ────────────────────────────
      process.env.SITE_URL = "https://intervalbooks.tw";
      const idA = await mkOrder("url-good");
      const outA = await notify.queueOrderPlacedNotifications(idA);
      check("A：SITE_URL 正常時不 throw，回 ok", outA.ok, true);
      check("A：排了兩封（匯款信 + 店家待收款）", outA.ok ? outA.queued : -1, 2);
      check(
        "A：outbox 裡真的是這兩封",
        (await outboxKeys(idA)).join(","),
        [`order_placed_admin:${idA}`, `remittance:${idA}`].sort().join(","),
      );
      // 信裡真的有那條連結（不是只有「排進去了」）。
      const bodyA =
        one(
          await must(`select body_text bt from public.email_outbox
                                     where dedupe_key = 'remittance:${idA}'`),
        )?.bt ?? "";
      checkTrue(
        "A：匯款信內文有可用的回填連結",
        bodyA.includes(`https://intervalbooks.tw/checkout/complete?token=`),
      );
      checkTrue("A：匯款信內文有帳號", bodyA.includes("0000406540362705"));

      // ── 情況 B：SITE_URL 沒設 → 匯款信**不寄**，店家那封照寄 ──────────────
      // 🔴 這正是 IB-202600001191 那次事故的環境狀態（SITE_URL 從來沒設在 Vercel）。
      delete process.env.SITE_URL;
      const idB = await mkOrder("url-unset");
      const outB = await notify.queueOrderPlacedNotifications(idB);
      check("🔴 B：SITE_URL 沒設時**不 throw**（訂單不可以因此失敗）", outB.ok, true);
      check("🔴 B：只排了一封（匯款信被擋下）", outB.ok ? outB.queued : -1, 1);
      check(
        "🔴 B：outbox 裡**沒有**匯款信，只有店家那封",
        (await outboxKeys(idB)).join(","),
        `order_placed_admin:${idB}`,
      );
      check(
        "🔴 B：確認一封連結壞掉的匯款信真的沒有被排進去",
        num(
          await must(`select count(*)::int n from public.email_outbox
                         where dedupe_key = 'remittance:${idB}'`),
        ),
        0,
      );

      // ── 情況 C：SITE_URL 是 localhost → 同樣擋下 ─────────────────────────
      // 這是比「沒設」更難發現的一種：值有設、看起來正常，但客人點下去打不開。
      process.env.SITE_URL = "http://localhost:8080";
      const idC = await mkOrder("url-localhost");
      const outC = await notify.queueOrderPlacedNotifications(idC);
      check("C：localhost 時不 throw", outC.ok, true);
      check("🔴 C：匯款信一樣被擋下（只排店家那封）", outC.ok ? outC.queued : -1, 1);
      check(
        "🔴 C：outbox 裡沒有匯款信",
        num(
          await must(`select count(*)::int n from public.email_outbox
                         where dedupe_key = 'remittance:${idC}'`),
        ),
        0,
      );

      // ── 反面對照：帳戶沒設定時也不寄（不同的原因，同樣的結果）──────────────
      process.env.SITE_URL = "https://intervalbooks.tw";
      await must(
        `update public.site_settings set bank_account = '', bank_account_name = '' where id = 1;`,
        false,
      );
      const idD = await mkOrder("no-account");
      const outD = await notify.queueOrderPlacedNotifications(idD);
      check("D：店家沒設匯款帳戶時不 throw", outD.ok, true);
      check("D：也不寄匯款信（寄一封沒有帳號的信比不寄糟）", outD.ok ? outD.queued : -1, 1);

      // ── 訂單本身完全不受影響 ─────────────────────────────────────────────
      // 🔴 這是「訂單仍然成立」的直接證據：三張走過失敗路徑的訂單，狀態、座位、
      //    payment_method 一個都沒被動到。
      const survivors =
        await must(`select idempotency_key k, status s, payment_status ps, payment_method pm
                                      from public.orders
                                     where idempotency_key in ('${KEY_PREFIX}url-unset','${KEY_PREFIX}url-localhost','${KEY_PREFIX}no-account')
                                     order by idempotency_key`);
      check("🔴 三張訂單都還在", survivors.length, 3);
      check(
        "🔴 而且全部仍然是 pending / pending / transfer",
        survivors.map((r) => `${r.s}/${r.ps}/${r.pm}`).join(" "),
        "pending/pending/transfer pending/pending/transfer pending/pending/transfer",
      );

      // triggerNotifyAfterOrderPlaced 是 createOrder() 真正呼叫的那一支 —— 它對一個
      // 根本不存在的訂單也必須安靜地回來，不 throw。
      // ⚠️ 這一步的輸出裡會出現一行 `[notify] flush 例外 (data ?? []).map is not a
      //    function`。那**不是** bug：flushEmailOutbox() 會呼叫 claim_email_batch()，
      //    而上面那個 shim 只實作到「回一個純量」的程度，回不出 setof。產線程式碼
      //    把它當成一次沖信失敗吞掉了——而那正是它該做的（信留在 outbox 等下一輪），
      //    所以這一行反而是「沖信失敗不會往上炸」的旁證。
      let threw = null;
      try {
        const outE = await notify.triggerNotifyAfterOrderPlaced(
          "00000000-0000-0000-0000-000000000000",
        );
        check("🔴 訂單不存在時 triggerNotifyAfterOrderPlaced 不 throw", outE.ok, false);
      } catch (e) {
        threw = e;
      }
      check("🔴 而且真的沒有丟出例外（結帳路徑上絕不可以）", threw, null);

      if (savedSiteUrl === undefined) delete process.env.SITE_URL;
      else process.env.SITE_URL = savedSiteUrl;
    }

    // =========================================================================
    // [21] 呼叫點的位置：step 7.5 必須在可回復區間**之外**
    // =========================================================================
    console.log("\n[21] createOrder step 7.5 的位置");
    {
      const ordersSrc = readFile(join(ROOT, "src/server/repos/orders.ts"));
      const code = stripTs(ordersSrc);
      const iCatch = code.indexOf("await releaseInventoryReservations(");
      const iTrigger = code.indexOf("triggerNotifyAfterOrderPlaced");
      checkTrue("反空殼：兩個位置都找得到", iCatch > 0 && iTrigger > 0);
      // 🔴 寄信在 catch（回滾座位、刪訂單）之後才發生。放進 try 裡的話，一次 Resend
      //    逾時就會變成「訂單建立失敗、座位還回去、客人看到請再試一次」—— 而客人的
      //    錢包什麼事都沒發生，只是他的位子沒了。
      checkTrue("🔴 寄信的呼叫在 catch 區塊之後（不在可回復區間裡）", iTrigger > iCatch);
      checkTrue(
        "刷卡訂單不走這條路（它們的通知在付款成功之後才寄）",
        /if \(!wantsCard && total > 0\)/.test(code),
      );
    }

    console.log("\n[19] 清理");
    await must(CLEANUP_SQL, false);
    check(
      "清理成功",
      num(
        await must(
          `select count(*)::int n from public.orders where idempotency_key like '${KEY_PREFIX}%'`,
        ),
      ),
      0,
    );
  } catch (err) {
    fail += 1;
    console.log(red(`\n  ✗ 連線段中斷：${err.message}`));
  }
}

// -----------------------------------------------------------------------------
console.log("\n" + "─".repeat(52));
if (skipped.length > 0) {
  console.log(yellow(`略過 ${skipped.length} 段：`));
  for (const s of skipped) console.log(yellow(`  • ${s}`));
}
console.log(`##SELFTEST## file=scripts/remittance-selftest.mjs pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exit(1);
}
console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
