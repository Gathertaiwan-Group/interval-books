#!/usr/bin/env node
/**
 * customer-account-selftest.mjs —— 客人帳號（0030）的自檢
 *
 * 這一期做的是三件事：0030 的 claim_guest_orders()（把訪客訂單認領給註冊帳號）、
 * src/server/customer-auth.ts（第三種外部使用者的 cookie 與授權邊界）、
 * src/server/repos/customer-orders.ts（客人看自己訂單／報名的**唯一**歸屬過濾層）。
 * 風險全部集中在授權：做錯了，任何人都能看到別人的姓名、電話、地址。
 *
 * 分兩段，理由與這個 repo 其他自檢一致（見 roster-csv-selftest 檔頭）：
 *
 *   [靜態] 讀 0030 與 customer-auth.ts 的原始碼，守的是設計不變量：三道閘都在、
 *          函式簽章沒有偷加 email 參數、三支 cookie 的名字互不相同、kind 判別式
 *          寫死在程式碼裡（不是呼叫端能覆蓋的值）。**永遠會跑，不需要資料庫。**
 *
 *   [動態] **直接 import src/server/repos/customer-orders.ts 本人**（不是複製一份
 *          邏輯來比對），把它唯一的執行期依賴 `@/server/supabase-admin` 換成一個
 *          我們自己控制、可以裝進「兩個使用者的資料混在一起」這種對抗性 fixture 的
 *          假 client。**這是唯一能真的證明「拿掉某一支的 user_id 過濾，測試會變紅」
 *          的辦法**——純靜態比對字串「有沒有出現 .eq("user_id"」擋不住「函式邏輯
 *          本身錯了，但字串剛好還在」這種壞法。
 *
 *          `src/server/customer-auth.ts` 只有 customerAuthRedirectUrl() 這一個
 *          純函式（不碰 DB、不碰 session）也用同一招真的執行；cookie 讀寫本身
 *          （readCustomerSession 等）需要 TanStack Start 的 AsyncLocalStorage 請求
 *          上下文，這台機器上取不到（`getSession()` 在裸 Node 腳本裡會丟出
 *          "No StartEvent found in AsyncLocalStorage"，已經手動驗證過，不是猜的）——
 *          這個 repo 目前**沒有任何一支**自檢對 src/server/** 做過request-level
 *          的整合測試，這裡不额外造一套；那一段改用靜態比對（cookie 名字、kind
 *          寫死的位置），與這個 repo 對 src/server/** 的既有覆蓋深度一致。
 *
 * 為什麼能直接 import 產線的 .ts：Node ≥ 22.18 原生 TypeScript type stripping
 * （這台機器是 25.6.1）。`@/` 是 tsconfig 的 alias，Node 不認得，用
 * `node:module` 的 registerHooks 補一條解析規則——與 scripts/same-as-buyer-selftest.mjs
 * 同一招，這裡多补了「相對路徑也補副檔名」，因為 customer-auth.ts 用的是
 * `./env`、`./supabase-admin`、`./auth` 這種相對匯入。
 *
 * 執行：node scripts/customer-account-selftest.mjs  （或 npm test）
 */

import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
  readMigrationFiles,
} from "./lib/migration-ledger.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/customer-account-selftest.mjs";
const SRC = join(ROOT, "src");

const MIG_DIR = join(ROOT, "supabase/migrations");
const MIG_0030 = join(MIG_DIR, "0030_customer_accounts.sql");

const P_CUSTOMER_AUTH = "src/server/customer-auth.ts";
const P_CUSTOMER_ORDERS_REPO = "src/server/repos/customer-orders.ts";
const P_SESSION = "src/server/session.ts";
const P_VENDOR_AUTH = "src/server/vendor-auth.ts";

// -----------------------------------------------------------------------------
// 迷你測試框架（與 roster-csv-selftest / same-as-buyer-selftest 同一套）
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function check(label, actual, expected, hint) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      預期 ${JSON.stringify(expected)}`));
    console.log(red(`      實際 ${JSON.stringify(actual)}`));
    if (hint) console.log(red(`      ${hint}`));
  }
}

const checkTrue = (label, value, hint) => check(label, value === true, true, hint);
const checkFalse = (label, value, hint) => check(label, value === true, false, hint);

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不回空字串——見 run-selftests.mjs 的「守門 4」。
 * 這一支底下大量 `check("…沒有 X", src.includes("X"), false)` 形狀的否定斷言，
 * 空字串會讓它們全部靜默通過。
 */
const readFile = (relPath) => {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error(
      `selftest 讀不到檔案：${abs}` +
        "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串——回空字串會讓所有" +
        "「確認原始碼裡沒有 X」的否定斷言靜默通過。）",
    );
  }
  return readFileSync(abs, "utf8");
};

// 守著 readFile() 自己：路徑打錯時它必須炸掉，而不是回空字串讓否定斷言靜默通過。
{
  const ghost = "__customer-account-selftest-missing-file-probe__";
  let thrown = null;
  try {
    readFile(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 readFile() 讀不到檔案時丟例外，訊息指出是哪個路徑（不是靜默回空字串）",
    thrown !== null && String(thrown.message).includes(join(ROOT, ghost)),
  );
}

/** 拿掉 SQL 註解（`--` 整行、區塊註解）。不剝字串。 */
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*--.*$/gm, " ");
}

/** 拿掉 TS/JS 註解。與 same-as-buyer-selftest 的同名函式一致。 */
function stripTsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

console.log("═══ 客人帳號自檢（0030 + customer-auth.ts + repos/customer-orders.ts）═══");

// =============================================================================
// [1] migration 帳本
// =============================================================================
console.log("\n[1] migration 帳本");

assertLedgerMatchesDisk(check, MIG_DIR);
assertLedgerDeclarationsHonest(check, MIG_DIR);

const migrations = readMigrationFiles(MIG_DIR);
checkTrue("0030_customer_accounts.sql 在磁碟上", migrations.includes("0030_customer_accounts.sql"));

// 這支自檢依賴的區域：orders（orders_payments）、order_items（掛在 order_expiry
// 底下，見 AREAS 的定義）、event_sessions（session_seats）、event_registrations
// （fetchMyRegistrations 直接查這張表）。目前審到 0030 本身——0030 只標了
// orders_payments 一個區域，其餘三個是這支自檢自己在乎、但 0030 沒有動到的。
assertMigrationDependencies(check, MIG_DIR, {
  suite: "customer-account-selftest",
  dependsOn: ["orders_payments", "order_expiry", "session_seats", "event_registrations"],
  // ── 0031_event_gallery.sql 的重讀結論 ─────────────────────────────────────
  // 0031 加活動相簿（events.gallery_keys text[]），並放寬
  // admin_upsert_event_with_session() 對 external_url 的「不可為空」驗證。
  // 這支函式的本體是 0029 那一份逐字照抄，唯一新寫的程式碼落在 events 那一段
  // （insert 欄位清單、驗證迴圈、一段陣列型別轉換）——它對 session_seats 的
  // 接觸跟 0026／0027／0029 一樣，只是函式本體裡照抄的 event_sessions
  // insert/update 段落，一個字都沒改。0031 完全沒有碰 orders、order_items、
  // event_registrations，也沒有新增或修改任何一支 TypeScript 檔案。
  // fetchMyRegistrations 查的 event_registrations 欄位形狀、reserve_session_seat
  // 的七步都不受影響。原樣成立。
  // ── 0032_admin_order_notify.sql 的重讀結論 ─────────────────────────────────
  // 0032 加店家的新訂單／新報名通知：site_settings.notify_emails ＋
  // enqueue_admin_order_email()，把摘要信排進既有的 email_outbox。它的 SQL 本體
  // 完全沒有碰 public.orders、order_items、event_sessions、event_registrations —
  // 沒有 alter、沒有新的 RLS policy、沒有動任何既有函式，這支帳本列標
  // orders_payments 是**語意上**的（0032 的檔頭 §0.2/§0.6 明講：呼叫端多讀了
  // orders.payment_method / shipping_method 兩欄組信件摘要，SQL 本身一行
  // `from public.orders` 都沒有）。這支自檢在乎的三道閘（claim_guest_orders() 的
  // p_user_id 簽章、user_id is null 的 where 子句、partial index）與
  // customer-orders.ts 的 user_id 過濾層、PII 欄位排除，0032 一個字都沒提到——
  // claim_guest_orders() 不在 0032 的異動清單裡（0032 §0.6：「這支不動 0022 的
  // 任何函式／表，只新增」，而 claim_guest_orders 是 0030 的函式，同樣沒被
  // 0032 碰）。0032 唯一改到的既有 TS 檔案裡也沒有 customer-orders.ts 或
  // customer-auth.ts（見 git show 1fd71b4 --stat：只動了 email-templates.ts /
  // _shell.settings.tsx / server/email.ts / server/notify.ts /
  // repos/email-outbox.ts / repos/site-settings.ts）。「fetchMyRegistrations 查的
  // event_registrations 欄位形狀、reserve_session_seat 的七步」同樣不受影響。
  // 原樣成立。
  // ── 0034_transfer_payment.sql 的重讀結論 ───────────────────────────────────
  // 0034 加匯款付款方式。它動到這支依賴的四個區域，但這支守的是「客人帳號認領訪客
  // 訂單」（claim_guest_orders，0030）與會員中心的讀取範圍，逐條對過：
  //   · orders_payments——0034 對 orders 做的是：payment_method 的 CHECK 多一個值、
  //     加兩個 remittance_* 欄位（都可為 null，都有 default null）、加一支
  //     admin_mark_order_paid()。**沒有碰 user_id、customer_email、public_token**，
  //     也沒有 create or replace claim_guest_orders()。認領的三道閘一個字都沒動。
  //   · order_expiry——只改 expire_unpaid_orders() 第 1 步 claim 條件裡的一行
  //     （匯款訂單門檻取 greatest(p_older_than, 3 days)）。它挑的仍然是同一組欄位，
  //     RETURNS TABLE 逐字未變。會員中心看得到的訂單集合不因此改變——被延後回收的
  //     那些單本來就還在 pending，本來就看得到。
  //   · session_seats / event_registrations——0034 對這兩區的「接觸」全部來自
  //     expire_unpaid_orders() 函式本體那段 0020 的逐字照抄（第 4c 步），沒有任何
  //     新寫的程式碼落在那裡。
  // 原樣成立。
  // ── 0035_admin_order_registration_cleanup.sql 的重讀結論 ───────────────────
  // 0035 是後台訂單刪除／封存＋名單刪除單筆，動到這支依賴的四個區域全部：
  //   · orders_payments——只加一個 nullable 欄位（orders.archived_at）與兩支全新
  //     函式（admin_delete_order／admin_archive_order）。同樣**沒有碰 user_id、
  //     customer_email、public_token**，沒有 create or replace claim_guest_orders()
  //     一個字，認領訪客訂單的三道閘不受影響。
  //   · order_expiry——admin_delete_order() 讀 order_items 只是為了逐一呼叫
  //     release_session_seat()，以及型錄庫存還原那一段的 join；**沒有重寫**
  //     expire_unpaid_orders() 本人，RETURNS TABLE 與挑單條件一個字都沒動。
  //   · session_seats / event_registrations——這是這支自己會動到讀寫的地方，但
  //     動法是「admin 主動對一張未付款訂單呼叫 admin_delete_order() /
  //     admin_delete_registration()」，那是後台的操作，不是
  //     fetchMyRegistrations()／customer-orders.ts 這條會員自己讀自己資料的路徑會
  //     經過的程式碼——0035 沒有改 fetchMyRegistrations 一個字，也沒有改
  //     customer-orders.ts 過濾 user_id 的任何一段。已付款訂單（會員中心真正關心
  //     的那種）走的是 admin_archive_order()，那支連 event_registrations 都不碰
  //     （只設／清 archived_at），會員自己的報名紀錄不受影響。
  // 原樣成立。
  // 0039_referral_program.sql（推薦碼與分潤）對 orders 只做了三件事：加三個 nullable
  // 欄位 referrer_id／referral_code／referral_discount_percent（舊訂單全是 NULL）、
  // 一個部分索引、一個指向新表 referrers 的 FK（on delete restrict，限制的是刪推廣者，
  // 不是刪訂單）。既有欄位、CHECK、函式、policy、grant 一個字都沒改。唯一的語意變化
  // 是 orders.discount 從恆為 0 變成「推薦折扣」（只對選品／書籍、最多 50%），而
  // total = subtotal + shipping_fee − discount 仍是金流、信件、發票唯一使用的金額
  // （發票本來就把 discount 開成負數列）。這支自檢的斷言重讀過，原樣成立。
  reviewedThrough: "0039_referral_program.sql",
});

// =============================================================================
// [2] 0030：claim_guest_orders() 的三道閘（靜態，讀 SQL 原始碼）
// =============================================================================
console.log("\n[2] 0030：claim_guest_orders() 三道閘");

const mig0030Raw = readFile("supabase/migrations/0030_customer_accounts.sql");
const mig0030 = stripSqlComments(mig0030Raw);

checkTrue("反空殼：0030 剝完註解仍有夠多 SQL", mig0030.trim().length > 800);
// 對照組：剝註解真的有剝到——檔頭那句「三道閘，一道都不能少」只在註解裡。
checkFalse(
  "對照組：stripSqlComments 真的拿掉了註解（「三道閘，一道都不能少」不在剝完的字串裡）",
  mig0030.includes("三道閘，一道都不能少"),
);
checkTrue(
  "對照組：那句話在未剝註解的原文裡（證明上一條不是因為讀錯檔）",
  mig0030Raw.includes("三道閘，一道都不能少"),
);

const fnMarker = "create or replace function public.claim_guest_orders";
const fnStart = mig0030.indexOf(fnMarker);
checkTrue("找得到 claim_guest_orders 的函式定義", fnStart >= 0);

const afterFn = mig0030.slice(fnStart);
const asIdx = afterFn.indexOf("as $$");
checkTrue("函式定義裡有 `as $$`（body 的開頭）", asIdx > 0);
const signature = afterFn.slice(0, asIdx);
const bodyStart = asIdx + "as $$".length;
const bodyEndRel = afterFn.indexOf("$$;", bodyStart);
checkTrue("找得到 body 的結尾 `$$;`", bodyEndRel > bodyStart);
const body = afterFn.slice(bodyStart, bodyEndRel);

// 反空殼：body 本身要有實質內容，不能是空殼。
checkTrue("claim_guest_orders 的 body 剝完註解仍有夠多程式碼", body.trim().length > 300);

// ── 簽章：只收 p_user_id uuid，沒有偷加 email 參數 ─────────────────────────
checkTrue(
  "🔴 函式簽章恰好是 (p_user_id uuid)，沒有第二個參數",
  /claim_guest_orders\(\s*p_user_id\s+uuid\s*\)/.test(signature),
);
checkFalse(
  "🔴 全篇（含 body）沒有任何 p_email / p_customer_email 參數——email 一定從 auth.users 讀",
  /\bp_email\b|\bp_customer_email\b/i.test(mig0030),
);
checkTrue("returns int", /returns\s+int\b/i.test(signature));
checkTrue("security definer", /security\s+definer/i.test(signature));
checkTrue(
  "set search_path = ''（收緊到空字串，不是既有函式常用的 'public'）",
  /set\s+search_path\s*=\s*''/i.test(signature),
);

// ── 閘門 ①：email_confirmed_at is not null ────────────────────────────────
checkTrue(
  "🔴 閘門① email_confirmed_at is not null（少了它=攻擊者用受害者 email 註冊、不驗信箱就能認領對方訂單）",
  /u\.email_confirmed_at\s+is\s+not\s+null/i.test(body),
);

// ── 閘門 ②：deleted_at is null ─────────────────────────────────────────────
checkTrue(
  "🔴 閘門② deleted_at is null（少了它=已刪除的帳號仍能認領訂單）",
  /u\.deleted_at\s+is\s+null/i.test(body),
);

// 閘門①②必須是同一句 SELECT 的 where 子句（同一次查 auth.users），不是散在別處
// 各自不相干的檢查——用「兩者之間只隔著 and，中間沒有第二個 select/from」來確認。
checkTrue(
  "閘門①②在同一句 `from auth.users u where … and …` 裡",
  /from\s+auth\.users\s+u\s+where[\s\S]{0,200}?email_confirmed_at\s+is\s+not\s+null[\s\S]{0,200}?deleted_at\s+is\s+null/i.test(
    body,
  ),
);

// ── 閘門 ③：update … where user_id is null ─────────────────────────────────
checkTrue(
  "🔴 閘門③ update public.orders 的 where 子句裡有 user_id is null（少了它=已有主人的訂單會被重新指派）",
  /update\s+public\.orders[\s\S]*?where\s+user_id\s+is\s+null/i.test(body),
);
// 閘門③與「只認領對得上 email 的那些列」必須是同一句 update，不是兩句分開的
// update（分開的話，閘門③可能只保護了另一句無關的更新）。
checkTrue(
  "閘門③與 email 比對在同一句 update 裡（同一個 where，用 and 接）",
  /update\s+public\.orders[\s\S]*?where\s+user_id\s+is\s+null[\s\S]{0,200}?lower\(trim\(customer_email\)\)\s*=\s*v_email/i.test(
    body,
  ),
);

// ── email 一律從 auth.users 讀，且比對前先 lower(trim(...)) ─────────────────
checkTrue(
  "email 從 auth.users u 讀（不是參數）：`select lower(trim(u.email)) into v_email`",
  /select\s+lower\(trim\(u\.email\)\)\s+into\s+v_email/i.test(body),
);
checkTrue(
  "customer_email 比對前也套了同一個正規化（大小寫／空白不敏感）",
  /lower\(trim\(customer_email\)\)\s*=\s*v_email/i.test(body),
);

// ── 權限：只有 service_role 能呼叫 ───────────────────────────────────────────
checkTrue(
  "🔴 revoke all … from public",
  /revoke\s+all\s+on\s+function\s+public\.claim_guest_orders\(uuid\)\s+from\s+public\s*;/i.test(
    mig0030,
  ),
);
checkTrue(
  "🔴 revoke all … from anon, authenticated（authenticated 也在清單裡——這是 security definer 函式，開給 authenticated 等於任何登入中的瀏覽器都能繞過 src/server 直接打 rpc）",
  /revoke\s+all\s+on\s+function\s+public\.claim_guest_orders\(uuid\)\s+from\s+anon,\s*authenticated\s*;/i.test(
    mig0030,
  ),
);
checkTrue(
  "grant execute … to service_role",
  /grant\s+execute\s+on\s+function\s+public\.claim_guest_orders\(uuid\)\s+to\s+service_role\s*;/i.test(
    mig0030,
  ),
);
checkFalse(
  "🔴 全篇沒有任何一句把 execute 開給 anon 或 authenticated",
  /grant\s+execute\s+on\s+function\s+public\.claim_guest_orders\(uuid\)\s+to\s+[^;]*\b(anon|authenticated)\b/i.test(
    mig0030,
  ),
);

// ── 認領用的索引 ─────────────────────────────────────────────────────────────
checkTrue(
  "partial index：lower(trim(customer_email)) where user_id is null",
  /create\s+index\s+if\s+not\s+exists\s+idx_orders_unclaimed_email[\s\S]{0,200}?lower\(trim\(customer_email\)\)[\s\S]{0,100}?where\s+user_id\s+is\s+null/i.test(
    mig0030,
  ),
);

// ── 這一支不開 RLS policy、不對 anon/authenticated 開 grant（0005 的姿態原樣保留）
checkFalse("🔴 0030 沒有任何 create policy", /create\s+policy/i.test(mig0030));
checkFalse(
  "🔴 0030 沒有對 orders 表本身開 grant 給 anon/authenticated（只有函式的 revoke/grant）",
  /grant\s+(select|insert|update|all)\s+on\s+(table\s+)?public\.orders\s+to\s+(anon|authenticated)/i.test(
    mig0030,
  ),
);

// =============================================================================
// [3] `@/` 與相對路徑的 TS 解析 hook —— 讓底下能直接 import 產線的 .ts
// =============================================================================
console.log("\n[3] 準備動態 import（Node 原生 TS type stripping + 自訂 resolver）");

function resolveTsLike(base) {
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * `@/server/supabase-admin` 是 customer-orders.ts / customer-auth.ts 唯一會真的
 * 打資料庫的依賴。這裡把它換成一個假的、我們自己控制的 client——見下面
 * makeFakeClient()。**不是**去改 customer-orders.ts 本人來塞測試鉤子；產線那份
 * import 路徑完全沒被動過，只有「resolve `@/server/supabase-admin` 這個 specifier
 * 時給哪個檔案」被換掉，與 same-as-buyer-selftest 換 `@/` 解析規則同一種手法。
 */
const FAKE_SUPABASE_ADMIN_SPECIFIER = "@/server/supabase-admin";
const FAKE_SUPABASE_ADMIN_URL = "customer-account-selftest:fake-supabase-admin";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === FAKE_SUPABASE_ADMIN_SPECIFIER) {
      return { url: FAKE_SUPABASE_ADMIN_URL, shortCircuit: true };
    }
    if (spec.startsWith("@/")) {
      const hit = resolveTsLike(join(SRC, spec.slice(2)));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const baseDir = dirname(fileURLToPath(ctx.parentURL));
      const hit = resolveTsLike(join(baseDir, spec));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === FAKE_SUPABASE_ADMIN_URL) {
      return {
        format: "module",
        shortCircuit: true,
        // 每次呼叫都重讀 globalThis.__CUSTOMER_SELFTEST_CLIENT__——讓底下每個
        // check 區塊可以換一組不同的 fixture，而不必重新 import 整個模組
        // （ESM 的模組快取只會 import 一次，重 import 同一個 specifier 拿到的是
        // 同一個模組物件）。
        source: `
          export function supabaseAdmin() {
            const c = globalThis.__CUSTOMER_SELFTEST_CLIENT__;
            if (!c) throw new Error("customer-account-selftest: 忘了在呼叫前設定假 client");
            return c;
          }
        `,
      };
    }
    return next(url, ctx);
  },
});

/**
 * 假的 Supabase query builder。**不驗證 `.select()` 的欄位字串**——它總是回傳
 * fixture 裡的完整那一列。這是刻意的：欄位有沒有外洩，交給下面 [4] 直接檢查
 * *回傳值*裡有沒有出現不該有的欄位（例如 customer_email、participant 的
 * email/phone）。真正在資料庫那一層擋欄位的是 SELECT 字串本身，那一段由
 * [4] 用另一條靜態檢查守（ORDER_COLUMNS 不含 customer_* / public_token）。
 * 這裡要驗的是「TS 這一層的 .map() 有沒有不小心把整列展開出去」，那正是
 * fixture 帶著不該外洩的欄位、看回傳值有沒有漏出來這招驗得到的。
 */
function makeChain(rows, onCall) {
  let filtered = rows.slice();
  const applied = [];
  const chain = {
    select(cols) {
      applied.push(["select", cols]);
      return chain;
    },
    eq(col, val) {
      applied.push(["eq", col, val]);
      filtered = filtered.filter((r) => r[col] === val);
      return chain;
    },
    in(col, vals) {
      applied.push(["in", col, vals]);
      const set = new Set(vals);
      filtered = filtered.filter((r) => set.has(r[col]));
      return chain;
    },
    order(col, opts) {
      applied.push(["order", col, opts]);
      // 真的排序（不是假裝）：這樣才驗得到 fetchMyOrders 傳的是
      // `.order("created_at", { ascending: false })`，而不是隨便一個方向。
      const dir = opts?.ascending === false ? -1 : 1;
      filtered = filtered.slice().sort((a, b) => {
        if (a[col] < b[col]) return -1 * dir;
        if (a[col] > b[col]) return 1 * dir;
        return 0;
      });
      return chain;
    },
    async maybeSingle() {
      onCall?.("maybeSingle", applied, filtered);
      return { data: filtered[0] ?? null, error: null };
    },
    then(resolve, reject) {
      onCall?.("then", applied, filtered);
      Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    },
  };
  return chain;
}

/**
 * @param {Record<string, any[]>} tables  table 名 → fixture 列。
 * @param {(table: string) => void} [onFrom]  每次 `.from(table)` 被呼叫時觸發，
 *   用來數「這個 table 在這次呼叫裡被查了幾次」——這是抓「fetchMyOrderDetail
 *   應該只查一次 orders，不該先查存在、再查歸屬」這種結構性回歸的唯一辦法：
 *   兩種寫法在*回傳值*上可能長得一樣（都對「別人的訂單」回 null），但查詢次數
 *   不一樣。
 */
function makeFakeClient(tables, onFrom) {
  return {
    from(table) {
      onFrom?.(table);
      if (table === "orders" && tables.orders) {
        return makeChain(tables.orders);
      }
      if (table === "order_items" && tables.order_items) {
        return makeChain(tables.order_items);
      }
      if (table === "event_registrations" && tables.event_registrations) {
        // 模擬 PostgREST 的 `event_sessions!inner(...)` embed：按 session_id
        // 把對應的場次資料掛上去。
        const sessionsById = new Map((tables.event_sessions ?? []).map((s) => [s.id, s]));
        const withEmbed = tables.event_registrations.map((r) => ({
          ...r,
          event_sessions: sessionsById.get(r.session_id) ?? null,
        }));
        return makeChain(withEmbed);
      }
      return makeChain([]);
    },
  };
}

/** 呼叫任何 `.from()` 就丟例外的 client，用來證明「userId 是空的就不該查資料庫」。 */
function makePoisonedClient() {
  return {
    from(table) {
      throw new Error(`customer-account-selftest: 不該查詢 ${table}——userId/orderNo 是空的`);
    },
  };
}

async function withClient(client, fn) {
  globalThis.__CUSTOMER_SELFTEST_CLIENT__ = client;
  try {
    return await fn();
  } finally {
    globalThis.__CUSTOMER_SELFTEST_CLIENT__ = undefined;
  }
}

let repo;
try {
  repo = await import("@/server/repos/customer-orders");
} catch (e) {
  fail += 1;
  console.log(red(`✗ import src/server/repos/customer-orders.ts 失敗：${e.message}`));
  console.log(red(e.stack ?? ""));
}
checkTrue("import 到 customer-orders.ts 且三支函式都在", !!repo);
if (repo) {
  check(
    "customer-orders.ts 剛好匯出這三支（沒有多、沒有少）",
    Object.keys(repo).sort(),
    ["fetchMyOrderDetail", "fetchMyOrders", "fetchMyRegistrations"].sort(),
  );
}

// =============================================================================
// [4] fetchMyOrders —— 動態：兩個使用者的訂單混在一起，只能看到自己的
// =============================================================================
console.log("\n[4] fetchMyOrders(userId)：動態，對抗性 fixture");

const ORDER_A1 = {
  id: "order-a1",
  order_no: "IB-202600000001",
  user_id: "user-A",
  status: "processing",
  payment_status: "paid",
  payment_method: "card",
  subtotal: 500,
  shipping_fee: 0,
  discount: 0,
  total: 500,
  shipping_method: "none",
  created_at: "2026-06-01T00:00:00Z",
  paid_at: "2026-06-01T00:05:00Z",
  // 下面三欄與 public_token 刻意混進 fixture：它們不該出現在任何回傳值裡。
  customer_name: "王小明",
  customer_email: "wang@example.com",
  customer_phone: "0900000001",
  public_token: "SECRET-TOKEN-A1",
};
const ORDER_A2 = {
  ...ORDER_A1,
  id: "order-a2",
  order_no: "IB-202600000002",
  created_at: "2026-06-03T00:00:00Z",
  paid_at: "2026-06-03T00:05:00Z",
  customer_name: "王小明",
  customer_email: "wang@example.com",
};
const ORDER_B1 = {
  ...ORDER_A1,
  id: "order-b1",
  order_no: "IB-202600000003",
  user_id: "user-B",
  created_at: "2026-06-02T00:00:00Z",
  customer_name: "李小華",
  customer_email: "li@example.com",
  customer_phone: "0900000002",
  public_token: "SECRET-TOKEN-B1",
};

if (repo) {
  await withClient(makeFakeClient({ orders: [ORDER_A1, ORDER_A2, ORDER_B1] }), async () => {
    const mine = await repo.fetchMyOrders("user-A");
    check(
      "🔴 user-A 只看到 user-A 自己的兩張單，看不到 user-B 的（對抗性 fixture：三張單混在同一個 fake table 裡）",
      mine.map((o) => o.orderNo).sort(),
      [ORDER_A1.order_no, ORDER_A2.order_no].sort(),
    );
    check("新的在前（created_at desc）", mine[0]?.orderNo, ORDER_A2.order_no);

    const theirs = await repo.fetchMyOrders("user-B");
    check(
      "user-B 只看到自己那一張",
      theirs.map((o) => o.orderNo),
      [ORDER_B1.order_no],
    );

    checkFalse(
      "🔴 回傳值裡沒有 customerEmail 這個 key（PII 不外流，即使 fixture 有這個欄位）",
      Object.prototype.hasOwnProperty.call(mine[0] ?? {}, "customerEmail"),
    );
    checkFalse(
      "🔴 回傳值序列化後找不到 fixture 裡的 email 字面值",
      JSON.stringify(mine).includes("wang@example.com"),
    );
    checkFalse(
      "🔴 回傳值裡沒有 publicToken／public_token（登入後不需要，且不該流進畫面）",
      JSON.stringify(mine).includes("SECRET-TOKEN"),
    );
  });

  // userId 是空字串／null／undefined：必須回 []，而且**完全不查資料庫**。
  await withClient(makePoisonedClient(), async () => {
    check("空字串 userId → []（不查資料庫）", await repo.fetchMyOrders(""), []);
    check("null userId → []（不查資料庫）", await repo.fetchMyOrders(null), []);
    check("undefined userId → []（不查資料庫）", await repo.fetchMyOrders(undefined), []);
  });
}

// =============================================================================
// [5] fetchMyOrderDetail —— 動態：查無 與 不是你的，回同一個 null
// =============================================================================
console.log("\n[5] fetchMyOrderDetail(userId, orderNo)：查無 vs 不是你的");

const ITEM_A1 = {
  order_id: ORDER_A1.id,
  name: { zh: "測試商品", en: "Test", ja: "テスト" },
  unit_price: 500,
  quantity: 1,
  subtotal: 500,
  product_type: "book",
  session_id: null,
};

if (repo) {
  // (a) 自己的訂單：應該拿到完整明細，含品項。
  await withClient(
    makeFakeClient({ orders: [ORDER_A1, ORDER_B1], order_items: [ITEM_A1] }),
    async () => {
      const own = await repo.fetchMyOrderDetail("user-A", ORDER_A1.order_no);
      checkTrue("自己的訂單：查得到", own !== null);
      check("自己的訂單：orderNo 正確", own?.orderNo, ORDER_A1.order_no);
      check("自己的訂單：品項有帶到（join order_items）", own?.items?.length, 1);
      check("自己的訂單：品項金額正確", own?.items?.[0]?.unitPrice, 500);
      checkFalse(
        "🔴 自己的訂單：回傳值裡沒有 customerEmail／customerName／customerPhone",
        ["customerEmail", "customerName", "customerPhone", "publicToken"].some((k) =>
          Object.prototype.hasOwnProperty.call(own ?? {}, k),
        ),
      );
    },
  );

  // (b) 別人的訂單（存在，但 user_id 不是你）與 (c) 根本不存在的編號。
  let fromCalls = [];
  await withClient(
    makeFakeClient({ orders: [ORDER_A1, ORDER_B1] }, (table) => fromCalls.push(table)),
    async () => {
      fromCalls = [];
      const notMine = await repo.fetchMyOrderDetail("user-A", ORDER_B1.order_no);
      const fromCallsForNotMine = fromCalls.filter((t) => t === "orders").length;

      fromCalls = [];
      const missing = await repo.fetchMyOrderDetail("user-A", "IB-000000009999");
      const fromCallsForMissing = fromCalls.filter((t) => t === "orders").length;

      check(
        "🔴 別人的訂單（存在但不屬於你）→ null",
        notMine,
        null,
        "對抗性 fixture：IB-202600000003 真的存在，屬於 user-B",
      );
      check("🔴 不存在的訂單編號 → null", missing, null);
      check(
        "🔴 兩者回傳值完全相同（deep equal null===null）——不能靠回傳值分辨「存在但不是你的」與「根本不存在」",
        JSON.stringify(notMine),
        JSON.stringify(missing),
      );
      check(
        '結構性防回歸：查「別人的訂單」只打了一次 `.from("orders")`（不是先查存在、再查歸屬——兩次查詢即使回傳值一樣，也代表多了一條可以用時間差／錯誤訊息分辨兩種情況的路徑）',
        fromCallsForNotMine,
        1,
      );
      check(
        '結構性防回歸：查「不存在的訂單」也只打了一次 `.from("orders")`',
        fromCallsForMissing,
        1,
      );
    },
  );

  // (d) userId 或 orderNo 是空的：必須回 null，而且完全不查資料庫。
  await withClient(makePoisonedClient(), async () => {
    check("空字串 userId → null（不查資料庫）", await repo.fetchMyOrderDetail("", "IB-1"), null);
    check("空字串 orderNo → null（不查資料庫）", await repo.fetchMyOrderDetail("user-A", ""), null);
    check("兩者都空 → null（不查資料庫）", await repo.fetchMyOrderDetail("", ""), null);
  });
}

// =============================================================================
// [6] fetchMyRegistrations —— 動態：兩段查詢，只認自己名下的訂單
// =============================================================================
console.log("\n[6] fetchMyRegistrations(userId)：兩段查詢，PII 最小化");

const SESSION_1 = {
  id: "session-1",
  title: { zh: "場次一", en: "Session 1", ja: "セッション1" },
  location: { zh: "台北", en: "Taipei", ja: "台北" },
  starts_at: "2026-07-01T02:00:00Z",
  ends_at: "2026-07-01T05:00:00Z",
};
const REG_A = {
  order_id: ORDER_A1.id,
  seat_no: 1,
  name: "王小明",
  session_id: SESSION_1.id,
  // email/phone 刻意放進 fixture：這是「參加者可能是第三人」的個資，
  // fetchMyRegistrations 不該把它們回傳出去。
  email: "leak-should-not-appear@example.com",
  phone: "0911111111",
};
const REG_B = {
  order_id: ORDER_B1.id,
  seat_no: 1,
  name: "李小華",
  session_id: SESSION_1.id,
  email: "also-should-not-appear@example.com",
  phone: "0922222222",
};

if (repo) {
  await withClient(
    makeFakeClient({
      orders: [ORDER_A1, ORDER_B1],
      event_registrations: [REG_A, REG_B],
      event_sessions: [SESSION_1],
    }),
    async () => {
      const mine = await repo.fetchMyRegistrations("user-A");
      check(
        "🔴 user-A 只看到自己那張訂單底下的報名，看不到 user-B 的（兩段查詢都混進對方的資料）",
        mine.length,
        1,
      );
      check("orderNo 對回去正確", mine[0]?.orderNo, ORDER_A1.order_no);
      check("場次標題正確（embed 對得上）", mine[0]?.sessionTitle?.zh, "場次一");
      check("場次地點正確", mine[0]?.sessionLocation?.zh, "台北");
      check("場次時間正確", mine[0]?.startsAt, SESSION_1.starts_at);
      checkFalse(
        "🔴 回傳值裡沒有 email 這個 key（參加者可能是第三人，見 repo 檔頭）",
        Object.prototype.hasOwnProperty.call(mine[0] ?? {}, "email"),
      );
      checkFalse(
        "🔴 回傳值裡沒有 phone 這個 key",
        Object.prototype.hasOwnProperty.call(mine[0] ?? {}, "phone"),
      );
      checkFalse(
        "🔴 回傳值序列化後找不到 fixture 裡的 email 字面值",
        JSON.stringify(mine).includes("should-not-appear"),
      );

      const theirs = await repo.fetchMyRegistrations("user-B");
      check("user-B 只看到自己的那一筆", theirs.length, 1);
      check("user-B 那筆的 orderNo 正確", theirs[0]?.orderNo, ORDER_B1.order_no);
    },
  );

  await withClient(makePoisonedClient(), async () => {
    check("空字串 userId → []（不查資料庫）", await repo.fetchMyRegistrations(""), []);
  });

  // 使用者沒有任何訂單：不該再去查 event_registrations（第二段查詢應該被短路）。
  let secondStageQueried = false;
  await withClient(
    makeFakeClient({ orders: [ORDER_B1] }, (table) => {
      if (table === "event_registrations") secondStageQueried = true;
    }),
    async () => {
      const none = await repo.fetchMyRegistrations("user-A"); // user-A 在這組 fixture 裡沒有訂單
      check("沒有任何訂單的使用者 → []", none, []);
      checkFalse(
        "沒有訂單就不會再去查 event_registrations（第二段查詢被短路，不是查了但過濾成空）",
        secondStageQueried,
      );
    },
  );
}

// =============================================================================
// [7] customer-orders.ts：SELECT 字串本身也不帶 PII 欄位（第二層防線）
// =============================================================================
console.log("\n[7] SELECT 字串本身不帶 PII 欄位");

const repoSrcRaw = readFile(P_CUSTOMER_ORDERS_REPO);
const repoSrc = stripTsComments(repoSrcRaw);

checkTrue("反空殼：customer-orders.ts 剝完註解仍有夠多程式碼", repoSrc.length > 3000);

const orderColumnsMatch = repoSrc.match(/const ORDER_COLUMNS\s*=\s*"([^"]+)"/);
checkTrue("找得到 ORDER_COLUMNS 常數", !!orderColumnsMatch);
const orderColumns = orderColumnsMatch?.[1] ?? "";
for (const forbidden of ["customer_name", "customer_email", "customer_phone", "public_token"]) {
  checkFalse(`🔴 ORDER_COLUMNS 不含 ${forbidden}`, orderColumns.includes(forbidden));
}

const eventRegSelectMatch = repoSrc.match(
  /\.from\("event_registrations"\)\s*\.select\(\s*"([^"]+)"/,
);
checkTrue("找得到 event_registrations 的 select 字串", !!eventRegSelectMatch);
const eventRegSelect = eventRegSelectMatch?.[1] ?? "";
checkFalse("🔴 event_registrations 的 select 字串不含 email", /\bemail\b/.test(eventRegSelect));
checkFalse("🔴 event_registrations 的 select 字串不含 phone", /\bphone\b/.test(eventRegSelect));

// order_items 不 join products——檔頭明講的不變量，静態核對一次。
checkFalse(
  "🔴 customer-orders.ts 完全不查詢 public.products（品項是快照，不 join 回商品主檔）",
  /\.from\(\s*"products"\s*\)/.test(repoSrc),
);

// =============================================================================
// [8] customer-auth.ts：customerAuthRedirectUrl() —— 動態，真的執行
// =============================================================================
console.log("\n[8] customerAuthRedirectUrl()：動態，涵蓋 2026-09-02 那次事故的教訓");

let customerAuth;
try {
  customerAuth = await import("@/server/customer-auth");
} catch (e) {
  fail += 1;
  console.log(red(`✗ import src/server/customer-auth.ts 失敗：${e.message}`));
  console.log(red(e.stack ?? ""));
}
checkTrue("import 到 customer-auth.ts", !!customerAuth);

if (customerAuth) {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedSiteUrl = process.env.SITE_URL;

  function withEnv(nodeEnv, siteUrl) {
    process.env.NODE_ENV = nodeEnv;
    if (siteUrl === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = siteUrl;
    return customerAuth.customerAuthRedirectUrl();
  }

  check(
    "🔴 production + SITE_URL 未設 → null（2026-09-02 事故：SITE_URL 從沒設在 Vercel 上，見 blackcat.ts IB-202600001191）",
    withEnv("production", undefined),
    null,
  );
  check(
    "🔴 production + SITE_URL=http://localhost:8080 → null（不是「哪個環境」，是「客人的瀏覽器連得到嗎」）",
    withEnv("production", "http://localhost:8080"),
    null,
  );
  check(
    "production + SITE_URL 是真的對外網址 → 組出 /auth/confirm",
    withEnv("production", "https://intervalbooks.example.com"),
    "https://intervalbooks.example.com/auth/confirm",
  );
  check(
    "🔴 production + 非 https → null",
    withEnv("production", "http://intervalbooks.example.com"),
    null,
  );
  check(
    "development + localhost → 放行（本機開發本來就該指回本機）",
    withEnv("development", "http://localhost:8080"),
    "http://localhost:8080/auth/confirm",
  );
  check("SITE_URL 是空字串 → null（組不出網址）", withEnv("production", ""), null);
  check(
    "SITE_URL 是壞掉的網址字面值 → null（new URL() 丟例外，不是讓例外炸穿呼叫端）",
    withEnv("production", "not a url"),
    null,
  );

  process.env.NODE_ENV = savedNodeEnv;
  if (savedSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = savedSiteUrl;
}

// =============================================================================
// [9] 三支 cookie 的名字互不相同（靜態）
// =============================================================================
console.log("\n[9] ib_admin / ib_vendor / ib_customer 三個 cookie 名字互不相同");

const sessionSrc = stripTsComments(readFile(P_SESSION));
const vendorAuthSrc = stripTsComments(readFile(P_VENDOR_AUTH));
const customerAuthSrc = stripTsComments(readFile(P_CUSTOMER_AUTH));

checkTrue("反空殼：session.ts 剝完註解仍有程式碼", sessionSrc.length > 500);
checkTrue("反空殼：vendor-auth.ts 剝完註解仍有程式碼", vendorAuthSrc.length > 2000);
checkTrue("反空殼：customer-auth.ts 剝完註解仍有程式碼", customerAuthSrc.length > 2000);

const adminNameMatch = sessionSrc.match(/name:\s*"([^"]+)"/);
const vendorNameMatch = vendorAuthSrc.match(/name:\s*"([^"]+)"/);
const customerNameMatch = customerAuthSrc.match(/name:\s*"([^"]+)"/);

checkTrue("session.ts 找得到 cookie name", !!adminNameMatch);
checkTrue("vendor-auth.ts 找得到 cookie name", !!vendorNameMatch);
checkTrue("customer-auth.ts 找得到 cookie name", !!customerNameMatch);

const adminCookieName = adminNameMatch?.[1];
const vendorCookieName = vendorNameMatch?.[1];
const customerCookieName = customerNameMatch?.[1];

check("後台 cookie 名字是 ib_admin", adminCookieName, "ib_admin");
check("廠商 cookie 名字是 ib_vendor", vendorCookieName, "ib_vendor");
check("客人 cookie 名字是 ib_customer", customerCookieName, "ib_customer");

checkTrue(
  "🔴 三個名字兩兩不同（admin≠vendor、admin≠customer、vendor≠customer）——這是唯一真正做到隔離的機制，getSession 是按名字取的",
  adminCookieName !== vendorCookieName &&
    adminCookieName !== customerCookieName &&
    vendorCookieName !== customerCookieName,
);

// =============================================================================
// [10] kind 判別式：呼叫端改不了，第二道門
// =============================================================================
console.log("\n[10] kind='customer' 是寫死的，不是呼叫端可以覆蓋的值");

// writeCustomerSession 的物件字面值必須是 `{ ...data, kind: "customer" }`——
// kind 排在 spread 之後，就算呼叫端的 data 裡混進一個 kind 欄位也會被蓋掉。
checkTrue(
  '🔴 writeCustomerSession：`{ ...data, kind: "customer" }`（kind 在 spread 之後，呼叫端塞不進別的值）',
  /\{\s*\.\.\.data,\s*kind:\s*"customer"\s*\}/.test(customerAuthSrc),
);
checkTrue(
  'readCustomerSession 要求 kind === "customer" 才承認這個 session',
  /kind\s*!==\s*"customer"/.test(customerAuthSrc),
);
// 型別層也擋一次：writeCustomerSession 的參數型別是 Omit<CustomerSessionData, "kind">，
// 呼叫端在型別系統裡就传不了 kind 進去（執行期的防線是上面那條 spread-then-literal）。
checkTrue(
  'writeCustomerSession 的參數型別是 Omit<CustomerSessionData, "kind">',
  /writeCustomerSession\(\s*data:\s*Omit<CustomerSessionData,\s*"kind">\s*,?\s*\)/.test(
    customerAuthSrc,
  ),
);

// 對照組：vendor-auth.ts 也是同一套（既有檔案，這裡只讀不改，用來確認客人這一側
// 是照抄，不是自己發明了一套較鬆的規則）。
checkTrue(
  "對照組：vendor-auth.ts 的 writeVendorSession 也是同一個形狀",
  /\{\s*\.\.\.data,\s*kind:\s*"vendor"\s*\}/.test(vendorAuthSrc),
);
checkTrue(
  '對照組：vendor-auth.ts 的 readVendorSession 也要求 kind === "vendor"',
  /kind\s*!==\s*"vendor"/.test(vendorAuthSrc),
);

// session.ts（後台）的 AdminSessionData 沒有 kind 欄位——這是刻意的觀察，不是要
// 補一個。萬一哪天 cookie 名字意外撞名，一份「從來不寫 kind」的 payload 讀進
// readCustomerSession() 時，解構出來的 kind 是 undefined，`undefined !== "customer"`
// 一樣是 true，一樣會被擋下來。
checkFalse(
  "🔴 對照組：session.ts（後台）的 AdminSessionData 型別裡沒有 kind 欄位（證明上面那個防線在「名字意外撞名」時仍然擋得住，不是靠後台也遵守同一個約定）",
  /AdminSessionData\s*=\s*\{[^}]*kind/.test(sessionSrc),
);

// =============================================================================
// [11] EmailNotConfirmedError：與 NotAuthorizedError 分開，且真的被拋出
// =============================================================================
console.log("\n[11] EmailNotConfirmedError 是獨立的錯誤型別，且真的會被拋出");

checkTrue(
  "EmailNotConfirmedError extends Error，name 設對",
  /class EmailNotConfirmedError extends Error/.test(customerAuthSrc),
);
if (customerAuth) {
  const err = new customerAuth.EmailNotConfirmedError();
  checkTrue("EmailNotConfirmedError 的 instance 是 Error 的 instance", err instanceof Error);
  check(
    "EmailNotConfirmedError 的 name 是 EmailNotConfirmedError",
    err.name,
    "EmailNotConfirmedError",
  );
  checkTrue("EmailNotConfirmedError 有預設訊息（不是空字串）", err.message.length > 0);
  checkTrue(
    "EmailNotConfirmedError 不是 NotAuthorizedError 的 instance（呼叫端可以分開處理）",
    !(err instanceof (Object.getPrototypeOf(customerAuth.EmailNotConfirmedError) ?? class {})) ||
      err.constructor.name === "EmailNotConfirmedError",
  );
}

// signInCustomer 必須在兩個地方各查一次「信箱是否已驗證」：
//   1. GoTrue 回的 error.code === "email_not_confirmed"
//   2. 拿到 user 之後再親自查一次 data.user.email_confirmed_at
// 兩者缺一都會讓「Supabase 專案把『未驗證也能登入』打開」這種設定失誤直接放行。
checkTrue(
  '🔴 signInCustomer 檢查 error.code === "email_not_confirmed"',
  /error\.code\s*===\s*"email_not_confirmed"/.test(customerAuthSrc),
);
checkTrue(
  "🔴 signInCustomer 額外自己複查一次 data.user.email_confirmed_at（防守：不能只信任 GoTrue 那一句 error）",
  /if\s*\(\s*!data\.user\.email_confirmed_at\s*\)\s*throw new EmailNotConfirmedError/.test(
    customerAuthSrc,
  ),
);

// =============================================================================
// [12] signInCustomer 呼叫 claim_guest_orders 只帶 p_user_id，且失敗不擋登入
// =============================================================================
console.log("\n[12] claim_guest_orders 的呼叫方式");

checkTrue(
  '🔴 signInCustomer 呼叫 rpc("claim_guest_orders", { p_user_id: … })，只有這一個參數（不傳 email）',
  /rpc\(\s*"claim_guest_orders"\s*,\s*\{\s*p_user_id:\s*session\.userId\s*,?\s*\}\s*\)/.test(
    customerAuthSrc,
  ),
);
checkFalse(
  "🔴 呼叫 claim_guest_orders 時沒有夾帶任何 email 相關參數",
  /claim_guest_orders[\s\S]{0,120}p_email/i.test(customerAuthSrc),
);
// 認領失敗不可以讓例外炸穿 signInCustomer——必須包在 try/catch 裡。
// ⚠️ 這裡不能用 `[^}]*` 從 `try {` 掃到 `claim_guest_orders`：兩者之間隔著
//    `const { data: claimed, error: claimError } = …` 這個解構賦值，本身就帶了
//    一對 `{}`，`[^}]*` 會在那裡提早斷掉、永遠比對不到。改用 `[\s\S]*?`。
checkTrue(
  "呼叫 claim_guest_orders 包在 try/catch 裡（認領失敗不擋登入）",
  /try\s*\{[\s\S]{0,200}?claim_guest_orders[\s\S]{0,300}?\}\s*catch/.test(customerAuthSrc),
);

// =============================================================================
// [13] requireCustomer() 的三個檢查與 0030 的閘門①②是同一組條件
// =============================================================================
console.log("\n[13] requireCustomer() 的 kill switch 與 0030 的閘門①②對齊");

checkTrue(
  "requireCustomer 檢查 !user.email_confirmed_at（與 0030 閘門①同一個欄位）",
  /!user\.email_confirmed_at/.test(customerAuthSrc),
);
checkTrue(
  "requireCustomer 檢查 user.deleted_at != null（與 0030 閘門②同一個欄位）",
  /user\.deleted_at\s*!=\s*null/.test(customerAuthSrc),
);
checkTrue(
  "requireCustomer 額外查 banned_until（0030 沒有這一道——claim 是一次性事件，banned 是持續狀態，讀訂單要每次重查)",
  /banned_until/.test(customerAuthSrc),
);
checkTrue(
  "requireCustomer 用的是 auth.admin.getUserById（每次重查 auth.users，不是只信任 cookie）",
  /supabaseAdmin\(\)\.auth\.admin\.getUserById\(session\.userId\)/.test(customerAuthSrc),
);
// requireCustomer 刻意不查 profiles.role——檔頭解釋過：customer/pending/staff/
// vendor/admin 的值域裡沒有一個代表「被停權」，而且店員老闆也會在自己店裡買書。
checkFalse(
  "🔴 requireCustomer 的函式體不查 profiles.role（刻意的設計，不是漏掉）",
  (() => {
    const start = customerAuthSrc.indexOf("export async function requireCustomer()");
    if (start < 0) return true; // 找不到函式本身另有斷言會報
    const end = customerAuthSrc.indexOf("\nexport async function getCustomerOrNull", start);
    const bodySlice = customerAuthSrc.slice(start, end < 0 ? undefined : end);
    return /from\(\s*"profiles"\s*\)/.test(bodySlice);
  })(),
);
checkTrue(
  "requireCustomer 函式本身找得到（上面那條防線的前提）",
  /export async function requireCustomer\(\)/.test(customerAuthSrc),
);

// =============================================================================
// [14] 沒有新增環境變數
// =============================================================================
console.log("\n[14] 沒有新增環境變數");

const ALLOWED_ENV_VARS = new Set(["NODE_ENV", "SITE_URL"]);
function envVarsUsedIn(src) {
  const found = new Set();
  const re = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(src))) found.add(m[1]);
  return [...found];
}

const authEnvVars = envVarsUsedIn(customerAuthSrc);
const repoEnvVars = envVarsUsedIn(repoSrc);

check(
  "customer-auth.ts 只碰 process.env.NODE_ENV / SITE_URL（都是既有變數，payuni.ts:50、blackcat.ts:71/163-180 已經在讀）",
  authEnvVars.filter((v) => !ALLOWED_ENV_VARS.has(v)).sort(),
  [],
);
check("customer-orders.ts 完全不直接讀 process.env", repoEnvVars, []);
checkFalse(
  "🔴 customer-auth.ts 沒有自己呼叫 required(...)（密鑰一律經 env.ts 的 adminSessionSecret()，不重新宣告一個新變數名）",
  /\brequired\(/.test(customerAuthSrc),
);
checkTrue(
  "customer-auth.ts 的 cookie 密鑰來自既有的 adminSessionSecret()（與 vendor-auth.ts 共用同一把）",
  /password:\s*adminSessionSecret\(\)/.test(customerAuthSrc),
);

// =============================================================================
// 收尾
// =============================================================================
console.log("\n────────────────────────────────────────────────────");
console.log(`${pass + fail} 個 case：${pass} passed, ${fail} failed`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
