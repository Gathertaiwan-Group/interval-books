#!/usr/bin/env node
/**
 * free-order-selftest.mjs —— 免費訂單（total = 0）結算（0028）的自檢
 *
 * ── 這一期在修什麼 ────────────────────────────────────────────────────────
 * 免費活動的報名會靜默消失。訂單停在 pending → 每 5 分鐘的 expire_unpaid_orders()
 * 把它當成「沒付錢」取消 → 0020 §4c 順手把 event_registrations 整批刪掉、座位還
 * 回去。沒有任何錯誤訊息，只是那個人不在名單上了。完整推理見 0028 的檔頭。
 *
 * 分兩段：
 *
 *   [靜態] 讀 0028 的 SQL 與結帳路徑的 .ts，守的是**設計不變量**：settle_free_order
 *          有沒有金額參數（有的話呼叫端就能宣稱一張三千塊的單是免費的）、
 *          invoice_backlog 有沒有 total > 0、CHECK 有沒有 'free'、結帳路徑有沒有
 *          真的接上去。這些答案寫在檔案裡，不連線也回答得出來。**永遠會跑。**
 *
 *   [連線] 對一個真的資料庫跑三條行為實測。這一期的核心就在這一段：
 *            A. total = 0 的訂單 + 報名 → expire_unpaid_orders() → 報名還在、座位沒動
 *            B. total > 0 未付款 → expire_unpaid_orders() → **仍然被清掉**
 *            C. invoice_backlog()：免費已付款訂單不回、有金額的已付款訂單仍然回
 *          A 沒有 B 是不夠的：只驗 A 的話，把整個過期機制關掉也會綠。
 *
 * ── 🔴 這一支**不會**幫你套 migration ──────────────────────────────────────
 * 這個 repo 出過的假陽性裡有一種是「連線段開頭先重套一次 migration，於是 drop 掉
 * 索引也照樣綠」——測試自己先把要驗的東西修好了再驗，等於什麼都沒驗。所以這裡
 * **沒有 APPLY 開關**，一個都沒有：連線段開頭先確認這個庫已經套過 0028（找不到就
 * **紅**，不是 skip、也不是「那我幫你套一下」），確認完才跑行為探針。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它只認 FREE_ORDER_SELFTEST_PG_URL，那個變數要
 *    自己設；沒設就整段 skip（會印出來，不會靜悄悄消失）。
 *
 * 準備一個可以跑的本機庫（PostgreSQL 14+ 即可，實測 18.3）：
 *
 *     createdb alice_0028_test
 *     # 先建 anon/authenticated/service_role 三個 role 與 auth/storage 兩個 schema，
 *     # 再依序套 supabase/migrations/*.sql（0008 需要 pg_net / vault / pg_cron，
 *     # 本機沒有，跳過它不影響這一期要驗的任何東西）
 *     FREE_ORDER_SELFTEST_PG_URL=postgres:///alice_0028_test node scripts/free-order-selftest.mjs
 *
 * 環境變數：
 *   FREE_ORDER_SELFTEST_PG_URL   本機測試庫的連線字串（[連線] 段的開關）
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
} from "./lib/migration-ledger.mjs";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/free-order-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");
const MIG_0028 = join(MIG_DIR, "0028_free_order_settlement.sql");
const SRC_DIR = join(ROOT, "src");

// -----------------------------------------------------------------------------
// 迷你測試框架（與其他自檢同一套）
// -----------------------------------------------------------------------------

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

function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串。
 *
 * 這一支底下有好幾條 `check("…沒有 X", src.includes("X"), false)` 的否定斷言 ——
 * 路徑一打錯（或檔案被改名、搬走），`"".includes("X")` 就是 `false`，那條斷言
 * **靜默通過**，從此永遠是綠的。見 run-selftests.mjs 的「守門 4」。
 */
const readFile = (p) => {
  if (!existsSync(p)) {
    throw new Error(
      `selftest 讀不到檔案：${p}` +
        "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串 —— 回空字串會讓所有" +
        "「確認原始碼裡沒有 X」的否定斷言靜默通過。）",
    );
  }
  return readFileSync(p, "utf8");
};

// 守著 readFile() 自己。
{
  const ghost = join(ROOT, "__free-order-selftest-missing-probe__");
  let thrown = null;
  try {
    readFile(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 readFile() 讀不到檔案時丟例外，訊息指出是哪個路徑（不是靜默回空字串）",
    thrown instanceof Error && thrown.message.includes(ghost),
  );
}

/** 剝掉 SQL 註解。與 migration-ledger 同樣的理由：檔頭散文裡什麼字都有。 */
const stripSqlComments = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*--.*$/gm, " ");

/** 剝掉 JS/TS 註解。斷言要驗的是**程式碼**，不是註解裡的說明文字。 */
const stripTsComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");

/** 遞迴列出 src/ 底下所有 .ts / .tsx。 */
function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listSourceFiles(abs));
    else if (/\.tsx?$/.test(abs)) out.push(abs);
  }
  return out;
}

// =============================================================================
// [1] 帳本
// =============================================================================
console.log("\n[1] migration 帳本");

assertLedgerMatchesDisk(check, MIG_DIR);
assertLedgerDeclarationsHonest(check, MIG_DIR);

// 這一支守的是「免費訂單成立之後不會被回收，而且不會被拿去開發票」。那牽涉到
// 訂單狀態（orders_payments）、過期機制撈得到誰（order_expiry）、被刪掉的是誰
// （event_registrations / session_seats），以及發票的待處理清單（invoice）。
assertMigrationDependencies(check, MIG_DIR, {
  suite: "free-order-selftest",
  dependsOn: ["orders_payments", "order_expiry", "event_registrations", "session_seats", "invoice"],
  // ── 0029_event_seats_visibility.sql 的重讀結論 ───────────────────────────
  // 0029 讓「尚餘名額 N」變成逐場活動可以關掉：public.events 與 public.products 各加
  // 一個 show_seats_remaining（boolean not null default true ＝ 維持既有行為），加兩個
  // trigger 讓兩邊不分岔（events→products 推、products 寫入時反向拉），並用
  // create or replace 讓 admin_upsert_event_with_session() 多讀一個 payload key。
  // **沒有 ALTER 任何一張既有欄位、沒有 drop 任何函式、沒有動到任何一支 RPC 的邏輯**
  // ——那支函式的本體是 0027 那一份逐字照抄，只多了三處 show_seats_remaining
  // （0029 §5 寫了差異清單，scripts/event-blocks-selftest.mjs [7] 現在改成驗
  //   **最後一支重新定義它的 migration**，所以那份抄寫走樣會轉紅）。
  // 逐條重讀之後：settle_free_order()、orders_payment_method_check、invoice_backlog()
  // 的 total > 0，0029 一個字都沒提到。它對 session_seats 的接觸只是函式本體裡照抄的
  // event_sessions 段落。免費訂單的結清路徑與名額顯示是兩件無關的事。原樣成立。
  // ── 0030_customer_accounts.sql 的重讀結論 ────────────────────────────────
  // 0030 加客人帳號的資料層：一支新函式 claim_guest_orders(uuid)（security definer、
  // 只 grant execute 給 service_role），把 customer_email 對得上、而且 user_id 仍是
  // null 的訪客訂單指給註冊並驗證過信箱的帳號；外加一支 partial index。
  // **沒有 ALTER 任何一張表、沒有 create or replace 任何既有函式、沒有動任何 CHECK／
  // trigger／排程，也沒有開任何 RLS policy 或對 anon / authenticated 的 grant**。
  // 它唯一寫到的欄位是 public.orders.user_id（0005:65 就存在，到 0029 為止沒有任何
  // 程式碼讀或寫過它）。
  // 逐條重讀之後：settle_free_order()、orders_payment_method_check 的允許值、
  // invoice_backlog() 的 total > 0、expire_unpaid_orders() 撈得到誰 —— 0030 一個字
  // 都沒提到。認領只改 user_id，而過期路徑挑的是 status / payment_status / paid_at
  // 三欄，兩者沒有交集；發票的待處理清單也不看 user_id。原樣成立。
  // ── 0031_event_gallery.sql 的重讀結論 ─────────────────────────────────────
  // 0031 加活動相簿（events.gallery_keys text[]），並放寬
  // admin_upsert_event_with_session() 對 external_url 的「不可為空」驗證。函式
  // 本體是 0029 那一份逐字照抄，新寫的程式碼只在 events 那一段（insert 欄位
  // 清單、驗證迴圈、一段陣列型別轉換）；它對 session_seats 的接觸跟 0029 一樣，
  // 只是函式本體裡照抄的 event_sessions 段落，一個字都沒改。逐條重讀之後：
  // settle_free_order()、orders_payment_method_check、invoice_backlog() 的
  // total > 0、expire_unpaid_orders() 撈得到誰，0031 一個字都沒提到。免費訂單
  // 的結清路徑與活動的相簿、外部連結是兩件無關的事。原樣成立。
  // ── 0032_admin_order_notify.sql 的重讀結論 ─────────────────────────────────
  // 0032 加店家的新訂單／新報名通知：site_settings.notify_emails ＋
  // enqueue_admin_order_email()，把摘要信排進既有的 email_outbox。它的 SQL 本體
  // 完全沒有碰 settle_free_order()、orders_payment_method_check、
  // invoice_backlog()、expire_unpaid_orders()——沒有 alter 任何一張表、沒有
  // create or replace 任何既有函式。帳本標 orders_payments 是語意上的：
  // enqueue_admin_order_email() 本身只查 site_settings 不查 orders，真正讀
  // public.orders 的是既有的 getOrderForNotify()（0022 就有），0032 只多加
  // payment_method / shipping_method 兩個既有欄位（0005 就存在）用來組信件摘要，
  // 完全不碰 status / payment_status / paid_at 這三個 settle_free_order() 與
  // expire_unpaid_orders() 實際判斷的欄位。這支自檢守的「免費訂單成立之後不會被
  // 回收、也不會被拿去開發票」跟「有沒有人排了一封通知信」是兩件不相交的事——
  // 免費訂單一樣會走 queueOrderNotifications()，店家一樣會收到通知（那正是
  // 0032 要補的洞），但那不影響訂單本身的 status / payment_status，也不影響
  // invoice_backlog() 的 total > 0 判斷。原樣成立。
  // ── 0034_transfer_payment.sql 的重讀結論 ───────────────────────────────────
  // 0034 加匯款付款方式。這支守的是「total = 0 的訂單在結帳當下就結清，不會被
  // expire_unpaid_orders() 連同 event_registrations 一起收掉」（0028）。逐條對過：
  //   · order_expiry——0034 改的是 expire 第 1 步 claim 條件裡的一行，而且只對
  //     payment_method = 'transfer' 生效。免費訂單的 payment_method 是 'free'，走
  //     的是 else 那一支（門檻仍然是 p_older_than）——但那不重要，因為免費訂單根本
  //     進不了 claim：settle_free_order() 已經把它推成 payment_status = 'paid'，
  //     而 claim 的第二個條件是 payment_status <> 'paid'。0028 的保護一個字都沒被
  //     碰到，下面每一條斷言原樣成立。
  //   · orders_payments——payment_method 的 CHECK 從五個值變六個（drop + add，
  //     'free' 原樣保留）。這支自檢驗的是 settle_free_order() 寫 'free'，那一句
  //     0034 沒碰。
  //   · session_seats / event_registrations——同上，全部來自 expire 本體的逐字照抄。
  //   · invoice——0034 **沒有碰 invoice_backlog()**。它的條件是
  //     `payment_status = 'paid' and total > 0`，不看 payment_method，所以匯款訂單
  //     被標成已付款之後會自動排進開票佇列，而免費訂單（total = 0）照樣被排除。
  //     兩件事都是既有行為的自然結果，不是新規則。
  //
  // ⚠️ 順帶記下一個**這一期發現、但不屬於這一期**的事實：createOrder() 對免費訂單
  //    從來沒有呼叫過 queueOrderNotifications()，所以免費報名的客人與參加者其實都
  //    收不到信（0022 那條路只由 webhook 與 /api/tasks/notify 觸發，而免費訂單沒有
  //    webhook）。0034 沒有動它——那是另一個洞，要修得動 0028 那條路的觸發點。
  // 原樣成立。
  // ── 0035_admin_order_registration_cleanup.sql 的重讀結論 ───────────────────
  // 0035 是後台訂單刪除／封存＋名單刪除單筆，動到這支依賴的五個區域全部（欄位／
  // 函式清單見 [7c] 之前那幾支自檢的重讀結論，這裡只交代與「免費訂單」的交集）：
  //
  //   · 免費訂單在結帳當下就被 settle_free_order() 推成 payment_status = 'paid'
  //     （0028），而 admin_delete_order() 第一道閘就是 `payment_status = 'paid'
  //     → order_is_paid`——**免費訂單天生刪不掉**，admin 對它只能呼叫
  //     admin_archive_order()，而那支不動名額、不動 event_registrations、不動
  //     payments／invoices，純粹設／清 archived_at。settle_free_order() 本人一個
  //     字沒被 0035 碰到。
  //   · order_expiry／invoice——同上幾支的結論：admin_delete_order() 沒有重寫
  //     expire_unpaid_orders()，也沒有碰 invoice_backlog()；它讀 order_items 只是
  //     為了逐一呼叫 release_session_seat() 與型錄庫存還原，不影響「total = 0 的
  //     訂單不會被 expire 回收、也不會被排進開票佇列」這兩條規則。
  //   · session_seats／event_registrations——admin_delete_registration()（移除
  //     單筆報名）理論上可以用在免費活動的報名上，但那是 admin 主動的操作，不是
  //     expire_unpaid_orders() 或任何自動排程會觸發的路徑，跟這支自檢守的「不會被
  //     自動回收」是兩件不相交的事。
  // 原樣成立。
  // 0040_referral_program.sql（推薦碼與分潤）對 orders 只做了三件事：加三個 nullable
  // 欄位 referrer_id／referral_code／referral_discount_percent（舊訂單全是 NULL）、
  // 一個部分索引、一個指向新表 referrers 的 FK（on delete restrict，限制的是刪推廣者，
  // 不是刪訂單）。既有欄位、CHECK、函式、policy、grant 一個字都沒改。唯一的語意變化
  // 是 orders.discount 從恆為 0 變成「推薦折扣」（只對選品／書籍、最多 50%），而
  // total = subtotal + shipping_fee − discount 仍是金流、信件、發票唯一使用的金額
  // （發票本來就把 discount 開成負數列）。這支自檢的斷言重讀過，原樣成立。
  // 0044（移除報名補票種＋稽核）：admin_delete_registration() 簽章與回傳形狀不變，只多讀
  // order_items.plan_id、場次先票種後加鎖、退 event_session_plans.units_taken、改用
  // DELETE…RETURNING（沒刪到就不扣 seats_taken）、寫一列新表 registration_removal_log；
  // 另外校正一個票種的 units_taken。不改 order_items／event_registrations／event_sessions
  // 的欄位、約束、trigger 或其他函式，不碰訂單、付款、發票、交易信。這支自檢的斷言重讀過，原樣成立。
  // 0045（票種改依實際刪掉的報名列數退）：create or replace 了 release_session_seat() 與
  // expire_unpaid_orders()，簽章、回傳形狀、security definer、grant 都不變。唯一的行為差異是
  // event_session_plans.units_taken 退 ceil(實際刪掉列數/spu) 而不是 order_items.quantity（沒人
  // 被單筆移除過時兩者相等）；expire 的 4c／4d 合成一句，認領條件（含 0034 匯款 3 天）、商品
  // 庫存、products.seats_taken、inv 保留、取消訂單、付款嘗試、回傳值逐字沿用 0036。另 revoke
  // registration_removal_log 的 sequence 權限。這支自檢的斷言重讀過，原樣成立。
  // 0047（後台作廢發票）：invoices 只加三個 nullable 欄位與 CHECK，新增 claim／finish／release_invoice_void
  // 三支函式；public.orders 只被 claim 唯讀 select order_no／total。0007 的開立函式、invoice_backlog、
  // orders／payments 的欄位、約束、grant 一個都沒動。這支自檢的斷言重讀過，原樣成立。
  reviewedThrough: "0047_invoice_void.sql",
});

// =============================================================================
// [2] 0028 的 SQL
// =============================================================================
console.log("\n[2] 0028 的 SQL");

const sql28raw = readFile(MIG_0028);
const sql28 = stripSqlComments(sql28raw);

checkTrue(
  "0028 建了 public.settle_free_order",
  /create\s+or\s+replace\s+function\s+public\.settle_free_order/i.test(sql28),
);

// 🔴 這一條是整支 migration 最重要的安全性質。settle_free_order 是 security definer
//    而且能把訂單標成已付款；只要它多一個金額參數，呼叫端就能宣稱一張三千塊的單是
//    免費的。所以簽名必須**只有** p_order_id。
{
  const sig = /create\s+or\s+replace\s+function\s+public\.settle_free_order\s*\(([^)]*)\)/i.exec(
    sql28,
  );
  const params = (sig?.[1] ?? "").trim();
  check(
    "🔴 settle_free_order 的參數只有 p_order_id uuid（沒有任何金額參數）",
    params,
    "p_order_id uuid",
  );
  checkTrue(
    "🔴 settle_free_order 的簽名裡沒有 total／amount／price 這類欄位",
    !/total|amount|price|subtotal/i.test(params),
  );
}

// ⚠️ 底下每一條都對**切出來的那一段**比對，不對整支 sql28。
//
// 這是突變測試逼出來的：原本 'free' 那一條寫成
// `/add constraint orders_payment_method_check[\s\S]{0,300}?'free'/`，
// 而 ADD CONSTRAINT 後面 300 字內就是 `comment on column … is '…''free'' ＝ …'`。
// 把 'free' 從 CHECK 的允許值裡拿掉之後，**那條斷言仍然是綠的** —— 它在讀說明文字，
// 不是在讀約束。這正是這個 repo 出過的「斷言被字串內容餵飽」那一種。

/** 從 `as $$ … $$;` 之間切出一支函式的本體。切不出來就回空字串，由呼叫端斷言長度。 */
function functionBody(sql, name) {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}[\\s\\S]*?\\bas\\s+\\$\\$([\\s\\S]*?)\\$\\$\\s*;`,
    "i",
  );
  return re.exec(sql)?.[1] ?? "";
}

const settleBody = functionBody(sql28, "settle_free_order");
checkTrue(
  "切得出 settle_free_order 的函式本體（切不出來下面每一條都沒在驗東西）",
  settleBody.length > 200,
);

// 金額是從 orders 那一列讀的，不是參數。
checkTrue(
  "settle_free_order 從 orders 那一列讀金額（v_order.total）",
  /v_order\.total\s*<>\s*0/.test(settleBody),
);
checkTrue(
  "settle_free_order 用 for update 鎖住訂單列（序列化點）",
  /from\s+public\.orders\s+o\s+where\s+o\.id\s*=\s*p_order_id\s+for\s+update/i.test(settleBody),
);

// 狀態組合必須與 markOrderPaid 一致。只對那一句 UPDATE 比對。
const settleUpdate = /update\s+public\.orders\s+o\s+set([\s\S]*?);/i.exec(settleBody)?.[0] ?? "";
checkTrue("切得出 settle_free_order 的 UPDATE 敘述", settleUpdate.length > 100);
for (const [label, re] of [
  ["status = 'processing'", /set\s+status\s*=\s*'processing'/i],
  ["payment_status = 'paid'", /payment_status\s*=\s*'paid'/i],
  ["payment_method = 'free'", /payment_method\s*=\s*'free'/i],
  ["paid_at = now()", /paid_at\s*=\s*now\(\)/i],
]) {
  checkTrue(`settle_free_order 的 UPDATE 寫入 ${label}`, re.test(settleUpdate));
}

// UPDATE 的述詞在列已鎖住的情況下重述一次 —— 防「不管三七二十一標成付清」。
checkTrue(
  "🔴 settle_free_order 的 UPDATE 自己也帶 total = 0 的述詞（不只靠上面的 if）",
  /and\s+o\.total\s*=\s*0/i.test(settleUpdate),
);
checkTrue(
  "🔴 UPDATE 也帶 status/payment_status 必須是 pending 的述詞",
  /and\s+o\.status\s*=\s*'pending'/i.test(settleUpdate) &&
    /and\s+o\.payment_status\s*=\s*'pending'/i.test(settleUpdate),
);

// §1 CHECK —— 只切 `add constraint … check ( … );` 括號裡那一段。
const addCheckBody =
  /add\s+constraint\s+orders_payment_method_check\s+check\s*\(([\s\S]*?)\)\s*;/i.exec(sql28)?.[1] ??
  "";
checkTrue("切得出 orders_payment_method_check 的 CHECK 內容", addCheckBody.length > 20);
checkTrue("🔴 orders.payment_method 的 CHECK 加了 'free'", /'free'/.test(addCheckBody));
checkTrue(
  "CHECK 是 drop if exists + add（重複套用安全）",
  /drop\s+constraint\s+if\s+exists\s+orders_payment_method_check/i.test(sql28),
);
// 既有的四個值一個都不准掉 —— 加值不是換值。
for (const v of ["card", "atm", "cvs_cod", "test_paid"]) {
  checkTrue(`CHECK 仍然認得既有的 '${v}'`, new RegExp(`'${v}'`).test(addCheckBody));
}
checkTrue(
  "CHECK 仍然允許 NULL（未經金流的訂單）",
  /payment_method\s+is\s+null/i.test(addCheckBody),
);

// §3 invoice_backlog
{
  const inv = functionBody(sql28, "invoice_backlog");
  checkTrue("0028 重寫了 public.invoice_backlog（切得出本體）", inv.length > 200);
  checkTrue("🔴 invoice_backlog 加了 o.total > 0", /and\s+o\.total\s*>\s*0/i.test(inv));
  // 逐字照抄的其餘條件一條都不准掉。
  checkTrue(
    "invoice_backlog 仍然只挑 payment_status = 'paid'",
    /o\.payment_status\s*=\s*'paid'/i.test(inv),
  );
  checkTrue(
    "invoice_backlog 仍然排除 issued / voided",
    /coalesce\(i\.status,\s*'missing'\)\s+not\s+in\s+\('issued',\s*'voided'\)/i.test(inv),
  );
  checkTrue(
    "invoice_backlog 仍然有重試上限",
    /coalesce\(i\.retry_count,\s*0\)\s*<\s*p_max_retries/i.test(inv),
  );
  checkTrue("invoice_backlog 仍然排除新鮮的 issuing", /i\.status\s*=\s*'issuing'/i.test(inv));
  checkTrue(
    "invoice_backlog 仍然 order by o.paid_at nulls last",
    /order\s+by\s+o\.paid_at\s+nulls\s+last/i.test(inv),
  );
  checkTrue(
    "invoice_backlog 仍然 limit greatest(p_limit, 0)",
    /limit\s+greatest\(p_limit,\s*0\)/i.test(inv),
  );
}

// 權限：兩支都是 security definer，都不可以讓瀏覽器的金鑰碰到。
for (const fn of ["settle_free_order", "invoice_backlog"]) {
  checkTrue(
    `${fn} 從 public revoke execute（這是真正生效的那一半）`,
    new RegExp(
      `revoke\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s+from\\s+public`,
      "i",
    ).test(sql28),
  );
  checkTrue(
    `${fn} 從 anon, authenticated revoke execute`,
    new RegExp(
      `revoke\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s+from\\s+anon,\\s*authenticated`,
      "i",
    ).test(sql28),
  );
  checkTrue(
    `${fn} grant execute 給 service_role`,
    new RegExp(
      `grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s+to\\s+service_role`,
      "i",
    ).test(sql28),
  );
}

checkTrue(
  "settle_free_order 是 security definer 且釘死 search_path",
  /security\s+definer[\s\S]{0,80}set\s+search_path\s*=\s*public/i.test(sql28),
);

// 0028 不可以碰 0001–0027 的任何一個檔（規約），也不可以在自己裡面重寫
// expire_unpaid_orders —— 它刻意不動那支，理由寫在檔頭。
checkTrue(
  "🔴 0028 沒有重寫 expire_unpaid_orders（刻意不動它，理由見 0028 檔頭）",
  !/create\s+or\s+replace\s+function\s+public\.expire_unpaid_orders/i.test(sql28),
);
checkTrue("0028 整支包在一個交易裡", /^begin;$/m.test(sql28raw) && /^commit;$/m.test(sql28raw));

// =============================================================================
// [3] 結帳路徑真的接上去了
// =============================================================================
console.log("\n[3] 結帳路徑");

// ⚠️ 不釘死「src/server/repos/orders.ts 裡有 settle_free_order」這種寫法。程式碼
//    搬家之後那條會靜默失去覆蓋（這個 repo 出過這種假陽性）。改成掃整個 src/：
//    「到底有幾個地方呼叫它、那個地方是不是結帳路徑」。
const sourceFiles = listSourceFiles(SRC_DIR);
checkTrue(
  `src/ 底下掃到 .ts/.tsx（掃描本身沒壞）：${sourceFiles.length} 個`,
  sourceFiles.length > 50,
);

const callers = sourceFiles.filter((f) =>
  stripTsComments(readFile(f)).includes("settle_free_order"),
);
check(
  "🔴 整個 src/ 底下剛好一個地方呼叫 settle_free_order",
  callers.map((f) => relative(ROOT, f)).join(",") || "（沒有任何地方呼叫）",
  callers.length === 1 ? relative(ROOT, callers[0]) : "（應該剛好一個）",
);

if (callers.length === 1) {
  const checkoutPath = relative(ROOT, callers[0]);
  const raw = readFile(callers[0]);
  const code = stripTsComments(raw);

  checkTrue(
    `呼叫它的就是建立訂單的那個檔（${checkoutPath} 裡有 createOrder）`,
    /export\s+async\s+function\s+createOrder/.test(code),
  );

  // 🔴 判準必須是金額，而且是**伺服器自己算出來的** total，不是 payload 裡的東西。
  //
  // ⚠️ 這一條原本只寫 `/if \(total === 0\)/.test(code)` —— 突變測試（把 step 5b 的
  //    守衛改成 `subtotal === 0`）**沒有被抓到**，因為 step 8 那一句
  //    `if (total === 0) await commitInventoryForOrder(...)` 也長這樣，它一個人就把
  //    這條斷言餵飽了。所以要綁在**呼叫點上**：守衛必須緊接著那一個 rpc 呼叫。
  checkTrue(
    "🔴 settle_free_order 的呼叫**就在** total === 0 的守衛裡（不是別的變數、也不是別處那個同名守衛）",
    /if\s*\(\s*total\s*===\s*0\s*\)\s*\{[\s\S]{0,300}?rpc\(\s*["']settle_free_order["']/.test(code),
  );
  checkTrue(
    "settle_free_order 只送 p_order_id（沒有把金額也送過去）",
    /rpc\(\s*["']settle_free_order["']\s*,\s*\{\s*p_order_id:[^}]*\}\s*\)/.test(code),
  );

  // 失敗必須 throw，讓既有的補償把座位還回去、訂單刪掉。靜默往下走的話，那張單會
  // 停在 pending 然後被回收 —— 正是這一期要修的那個 bug。
  checkTrue(
    "🔴 settle_free_order 失敗會 throw CheckoutError（不是靜默往下走）",
    /settleError[\s\S]{0,400}?throw\s+new\s+CheckoutError/.test(code),
  );
  checkTrue(
    "🔴 沒有生效（settled !== true 且 reason !== already_settled）也會 throw",
    /already_settled[\s\S]{0,400}?throw\s+new\s+CheckoutError/.test(code),
  );

  // 免費訂單不可以被送去金流。
  checkTrue("🔴 刷卡交接的前提加上了 total > 0", /wantsCard\s*&&\s*total\s*>\s*0/.test(code));

  // 免費訂單永遠不會有 webhook，所以庫存保留只能在這裡承兌。
  checkTrue(
    "🔴 免費訂單會呼叫 commitInventoryForOrder（它永遠不會有 webhook 幫它做這件事）",
    /if\s*\(\s*total\s*===\s*0\s*\)\s*await\s+commitInventoryForOrder/.test(code),
  );

  // 這個檔案仍然不可以自己寫 payment_status = 'paid'（那條規則寫在 createOrder 的
  // 檔頭）。0028 的例外是「呼叫一支自己讀金額的函式」，不是「自己寫那個欄位」。
  checkTrue(
    '🔴 結帳路徑仍然沒有自己寫 payment_status: "paid"',
    !/payment_status\s*:\s*["']paid["']/.test(code),
  );
  checkTrue(
    '結帳路徑仍然沒有自己寫 payment_method: "free"（那是 SQL 那一側的事）',
    !/payment_method\s*:\s*["']free["']/.test(code),
  );
}

// =============================================================================
// [4] 這一支自己不准偷偷套 migration
// =============================================================================
console.log("\n[4] 守著這支自檢自己");

// 這個 repo 出過的假陽性：連線段開頭先重套一次 migration，於是從 migration 裡把東西
// 刪掉也照樣綠。這一條擋住日後有人「為了方便」把 APPLY 加回來。
{
  const own = stripTsComments(readFile(join(ROOT, SELF)));
  // ⚠️ 兩個要找的字串都**拼出來**，不寫成字面值。寫成字面值的話這一行自己就含有
  //    它，斷言永遠是紅的 —— 兩個半邊都實測踩過一次。連 "-f" 都要拆成 "-" + "f"，
  //    因為只要原始碼裡出現過一次帶引號的 -f，這條就會抓到自己。
  const psqlFileFlag = '"' + "-" + "f" + '"';
  const applyFlag = "SELFTEST" + "_APPLY";
  checkTrue(
    "🔴 這支自檢的連線段不會自己套用 migration（沒有 psql -f，也沒有 APPLY 開關）",
    !own.includes(psqlFileFlag) && !own.includes(applyFlag),
  );
  checkTrue(
    "🔴 這支自檢不會對 supabase/migrations 執行任何東西",
    !/execFileAsync\([\s\S]{0,200}migrations/.test(own),
  );
}

// =============================================================================
// [5] 連線段
// =============================================================================
console.log("\n[5] 連線段 —— 真的跑 SQL");

const PG_URL = process.env.FREE_ORDER_SELFTEST_PG_URL;

async function psqlRows(text) {
  const { stdout } = await execFileAsync(
    "psql",
    ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", PG_URL, "-c", text],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return Object.fromEntries(
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.includes("|"))
      .map((l) => {
        const i = l.indexOf("|");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
}

// ── 前置條件：這個庫**必須已經套過 0028** ────────────────────────────────────
// 找不到就紅，不是 skip，也不是「那我幫你套一下」。
const PRECONDITION_SQL = `
select 'fn_settle|'  || (to_regprocedure('public.settle_free_order(uuid)') is not null)::text
union all
select 'fn_backlog|' || (to_regprocedure('public.invoice_backlog(integer,integer,interval)') is not null)::text
union all
select 'backlog_total|' || (pg_get_functiondef(to_regprocedure('public.invoice_backlog(integer,integer,interval)')) ~ 'o\\.total > 0')::text
union all
select 'check_free|' || coalesce((
    select (pg_get_constraintdef(oid) like '%free%')::text
      from pg_constraint
     where conname = 'orders_payment_method_check'
       and conrelid = to_regclass('public.orders')
  ), 'missing')
union all
select 'fn_expire|' || (to_regprocedure('public.expire_unpaid_orders(interval,integer)') is not null)::text
union all
select 'regs_table|' || (to_regclass('public.event_registrations') is not null)::text
`;

// 固定資料的清理。**不只認 email**：event_registrations.session_id 是
// on delete RESTRICT，所以任何一筆殘留的報名都會讓 event_sessions 刪不掉，整段
// 連線測試就跑不起來。這裡連「訂單裡有 t28 商品」的那些一起收，讓這一段對
// 「上一輪跑到一半掛掉」與「有人手動跑過同名探針」都成立。
const CLEANUP_SQL = `
create temp table if not exists t28_orders as
  select o.id from public.orders o
   where o.customer_email like '%@t28.invalid'
      or exists (select 1 from public.order_items oi
                  where oi.order_id = o.id and oi.product_id in ('t28-free','t28-paid'));
delete from public.event_registrations r where r.order_id in (select id from t28_orders);
delete from public.event_registrations r
 where r.session_id in (select s.id from public.event_sessions s
                         where s.product_id in ('t28-free','t28-paid'));
delete from public.invoices i where i.order_id in (select id from t28_orders);
delete from public.orders o where o.id in (select id from t28_orders);
delete from public.event_sessions s where s.product_id in ('t28-free','t28-paid');
delete from public.products p where p.id in ('t28-free','t28-paid');
drop table t28_orders;
select 'cleanup|done';
`;

const PROBE_SQL = `
create temp table probe(k text, v text);

insert into public.products (id, slug, product_type, title, summary, description, price, status, requires_shipping)
values
  ('t28-free','t28-free','event','{"zh":"免費","en":"Free","ja":"無料"}'::jsonb,'{"zh":"","en":"","ja":""}'::jsonb,'{"zh":"","en":"","ja":""}'::jsonb,0,'active',false),
  ('t28-paid','t28-paid','event','{"zh":"付費","en":"Paid","ja":"有料"}'::jsonb,'{"zh":"","en":"","ja":""}'::jsonb,'{"zh":"","en":"","ja":""}'::jsonb,1000,'active',false);

insert into public.event_sessions (id, product_id, title, location, starts_at, capacity, status)
values
  ('11111111-1111-1111-1111-111111111111','t28-free','{"zh":"場","en":"S","ja":"S"}'::jsonb,'{"zh":"店","en":"Shop","ja":"店"}'::jsonb, now()+interval '7 days', 10, 'open'),
  ('22222222-2222-2222-2222-222222222222','t28-paid','{"zh":"場","en":"S","ja":"S"}'::jsonb,'{"zh":"店","en":"Shop","ja":"店"}'::jsonb, now()+interval '7 days', 10, 'open');

do $$
declare
  s_free uuid := '11111111-1111-1111-1111-111111111111';
  s_paid uuid := '22222222-2222-2222-2222-222222222222';
  o_free uuid; o_paid uuid; o_zero_card uuid; o_charged uuid; o_cancelled uuid;
  i_free bigint; i_paid bigint;
  r record;
begin
  -- ══ A. 免費訂單 ═════════════════════════════════════════════════════════
  insert into public.orders (customer_name, customer_email, customer_phone,
                             subtotal, shipping_fee, discount, total, created_at)
  values ('免費測試','free@t28.invalid','0900000001',0,0,0,0, now() - interval '2 hours')
  returning id into o_free;

  insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
  values (o_free,'t28-free',s_free,'{"zh":"免費","en":"Free","ja":"無料"}'::jsonb,0,1,0,'event')
  returning id into i_free;

  perform public.reserve_session_seat(o_free, i_free, s_free, 1,
    '[{"name":"甲","email":"a@t28.invalid","phone":null,"noticeAck":"true"}]'::jsonb);

  insert into probe values ('A_regs_before', (select count(*)::text from public.event_registrations where order_id = o_free));
  insert into probe values ('A_seats_before', (select seats_taken::text from public.event_sessions where id = s_free));

  select * into r from public.settle_free_order(o_free);
  insert into probe values ('A_settle_settled', r.settled::text);
  insert into probe values ('A_settle_reason', r.reason);

  select o.status, o.payment_status, o.payment_method, (o.paid_at is not null) as has_paid_at
    into r from public.orders o where o.id = o_free;
  insert into probe values ('A_status', r.status);
  insert into probe values ('A_payment_status', r.payment_status);
  insert into probe values ('A_payment_method', r.payment_method);
  insert into probe values ('A_paid_at_set', r.has_paid_at::text);

  select * into r from public.settle_free_order(o_free);
  insert into probe values ('A_settle2_settled', r.settled::text);
  insert into probe values ('A_settle2_reason', r.reason);

  -- ══ B. 對照組：total > 0 且未付款 ═══════════════════════════════════════
  insert into public.orders (customer_name, customer_email, customer_phone,
                             subtotal, shipping_fee, discount, total, created_at)
  values ('付費測試','paid@t28.invalid','0900000002',1000,0,0,1000, now() - interval '2 hours')
  returning id into o_paid;

  insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
  values (o_paid,'t28-paid',s_paid,'{"zh":"付費","en":"Paid","ja":"有料"}'::jsonb,1000,1,1000,'event')
  returning id into i_paid;

  perform public.reserve_session_seat(o_paid, i_paid, s_paid, 1,
    '[{"name":"乙","email":"b@t28.invalid","phone":null,"noticeAck":"true"}]'::jsonb);

  insert into probe values ('B_regs_before', (select count(*)::text from public.event_registrations where order_id = o_paid));
  insert into probe values ('B_seats_before', (select seats_taken::text from public.event_sessions where id = s_paid));

  select * into r from public.settle_free_order(o_paid);
  insert into probe values ('B_settle_settled', r.settled::text);
  insert into probe values ('B_settle_reason', r.reason);

  -- ══ C. 掃過期 ══════════════════════════════════════════════════════════
  insert into probe values ('C_expired_count',
    (select count(*)::text from public.expire_unpaid_orders('0 seconds'::interval, 200)));

  insert into probe values ('A_regs_after', (select count(*)::text from public.event_registrations where order_id = o_free));
  insert into probe values ('A_seats_after', (select seats_taken::text from public.event_sessions where id = s_free));
  insert into probe values ('A_status_after', (select status from public.orders where id = o_free));
  insert into probe values ('A_payment_status_after', (select payment_status from public.orders where id = o_free));

  insert into probe values ('B_regs_after', (select count(*)::text from public.event_registrations where order_id = o_paid));
  insert into probe values ('B_seats_after', (select seats_taken::text from public.event_sessions where id = s_paid));
  insert into probe values ('B_status_after', (select status from public.orders where id = o_paid));

  -- ══ D. 發票 ════════════════════════════════════════════════════════════
  insert into public.invoices (order_id) values (o_free) on conflict (order_id) do nothing;
  insert into probe values ('D_backlog_has_free',
    (select exists(select 1 from public.invoice_backlog(50,5,'5 minutes'::interval) b where b.order_id = o_free)::text));

  insert into public.orders (customer_name, customer_email, customer_phone,
                             subtotal, shipping_fee, discount, total,
                             status, payment_status, payment_method, paid_at)
  values ('已付款','charged@t28.invalid','0900000003',500,0,0,500,'processing','paid','card', now())
  returning id into o_charged;
  insert into public.invoices (order_id) values (o_charged) on conflict (order_id) do nothing;
  insert into probe values ('D_backlog_has_charged',
    (select exists(select 1 from public.invoice_backlog(50,5,'5 minutes'::interval) b where b.order_id = o_charged)::text));

  insert into public.orders (customer_name, customer_email, customer_phone,
                             subtotal, shipping_fee, discount, total,
                             status, payment_status, payment_method, paid_at)
  values ('零元刷卡','zerocard@t28.invalid','0900000004',0,0,0,0,'processing','paid','card', now())
  returning id into o_zero_card;
  insert into public.invoices (order_id) values (o_zero_card) on conflict (order_id) do nothing;
  insert into probe values ('D_backlog_has_zero_card',
    (select exists(select 1 from public.invoice_backlog(50,5,'5 minutes'::interval) b where b.order_id = o_zero_card)::text));

  -- ══ E. settle_free_order 的其他分支 ═════════════════════════════════════
  insert into probe values ('E_unknown_order',
    (select reason from public.settle_free_order('99999999-9999-9999-9999-999999999999'::uuid)));

  insert into public.orders (customer_name, customer_email, customer_phone,
                             subtotal, shipping_fee, discount, total, status, payment_status)
  values ('已取消','cancelled@t28.invalid','0900000005',0,0,0,0,'cancelled','failed')
  returning id into o_cancelled;
  insert into probe values ('E_cancelled', (select reason from public.settle_free_order(o_cancelled)));

  -- ══ F. payment_method 的 CHECK ═════════════════════════════════════════
  begin
    insert into public.orders (customer_name, customer_email, customer_phone,
                               subtotal, shipping_fee, discount, total, payment_method)
    values ('壞值','bad@t28.invalid','0900000006',0,0,0,0,'gift');
    insert into probe values ('F_bad_value', '00000');
  exception when others then
    insert into probe values ('F_bad_value', sqlstate);
  end;
  begin
    insert into public.orders (customer_name, customer_email, customer_phone,
                               subtotal, shipping_fee, discount, total, payment_method)
    values ('free 值','freeok@t28.invalid','0900000007',0,0,0,0,'free');
    insert into probe values ('F_free_value', '00000');
  exception when others then
    insert into probe values ('F_free_value', sqlstate);
  end;
end $$;

insert into probe values ('G_anon_settle',
  case when has_function_privilege('anon','public.settle_free_order(uuid)','execute') then 'yes' else 'no' end);
insert into probe values ('G_auth_settle',
  case when has_function_privilege('authenticated','public.settle_free_order(uuid)','execute') then 'yes' else 'no' end);
insert into probe values ('G_public_settle',
  case when has_function_privilege('public','public.settle_free_order(uuid)','execute') then 'yes' else 'no' end);
insert into probe values ('G_service_settle',
  case when has_function_privilege('service_role','public.settle_free_order(uuid)','execute') then 'yes' else 'no' end);
insert into probe values ('G_anon_backlog',
  case when has_function_privilege('anon','public.invoice_backlog(integer,integer,interval)','execute') then 'yes' else 'no' end);

select k || '|' || coalesce(v,'(null)') from probe order by k;
`;

if (!PG_URL) {
  skipped.push("[5] 連線段（缺 FREE_ORDER_SELFTEST_PG_URL）");
  console.log(yellow("  跳過：沒有 FREE_ORDER_SELFTEST_PG_URL"));
  console.log(yellow("  設好之後重跑，才會驗到「免費訂單的報名真的沒有被 expire_unpaid_orders()"));
  console.log(yellow("  刪掉」、「total > 0 的未付款訂單仍然被清掉」、以及「invoice_backlog"));
  console.log(yellow("  真的不回免費訂單」。指令見本檔檔頭。"));
} else {
  let r = null;
  try {
    // 🔴 schema 事實必須在任何寫入之前驗完。這一段刻意排在 CLEANUP／PROBE 前面：
    //    先確認這個庫真的套過 0028，再開始跑行為探針。
    const pre = await psqlRows(PRECONDITION_SQL);
    checkTrue("這個庫已經套過 0028：public.settle_free_order(uuid) 在", pre.fn_settle === "true");
    checkTrue("public.invoice_backlog(integer,integer,interval) 在", pre.fn_backlog === "true");
    checkTrue("🔴 庫上的 invoice_backlog 真的帶著 o.total > 0", pre.backlog_total === "true");
    checkTrue("🔴 庫上的 orders_payment_method_check 真的認得 'free'", pre.check_free === "true");
    checkTrue(
      "public.expire_unpaid_orders(interval,integer) 在（對照組要用）",
      pre.fn_expire === "true",
    );
    checkTrue("public.event_registrations 在", pre.regs_table === "true");

    const ready =
      pre.fn_settle === "true" &&
      pre.fn_backlog === "true" &&
      pre.backlog_total === "true" &&
      pre.check_free === "true" &&
      pre.fn_expire === "true" &&
      pre.regs_table === "true";

    if (!ready) {
      fail += 1;
      console.log(red("  ✗ 這個庫沒有套過 0028 —— 行為探針不跑"));
      console.log(red("      這一支**不會**幫你套 migration（那樣連 0028 被刪光都照樣綠）。"));
      console.log(
        red(
          "      先跑：psql -d <db> -v ON_ERROR_STOP=1 -f supabase/migrations/0028_free_order_settlement.sql",
        ),
      );
    } else {
      await psqlRows(CLEANUP_SQL);
      r = await psqlRows(PROBE_SQL);
      await psqlRows(CLEANUP_SQL);
    }
  } catch (err) {
    fail += 1;
    console.log(red("  ✗ 連線測試跑不起來"));
    console.log(red(`      ${String(err.stderr ?? err.message ?? err).slice(0, 800)}`));
  }

  if (r) {
    console.log("  ── settle_free_order 把免費訂單推到哪裡 ──");
    check("免費訂單結算成功", r.A_settle_settled, "true");
    check("reason = settled", r.A_settle_reason, "settled");
    check("status = processing（與 markOrderPaid 同一組狀態）", r.A_status, "processing");
    check("payment_status = paid", r.A_payment_status, "paid");
    check(
      "🔴 payment_method = free（不是 NULL —— NULL 的意思是「還有錢要收」）",
      r.A_payment_method,
      "free",
    );
    check("paid_at 有值", r.A_paid_at_set, "true");
    check("冪等：第二次呼叫回 already_settled", r.A_settle2_reason, "already_settled");
    check("冪等：第二次呼叫的 settled 是 false（沒有重做）", r.A_settle2_settled, "false");

    console.log("  ── 🔴 核心：跑過 expire_unpaid_orders() 之後，免費報名還在嗎 ──");
    check("（前置）免費訂單有 1 筆報名", r.A_regs_before, "1");
    check("（前置）場次已佔 1 個座位", r.A_seats_before, "1");
    check("🔴 掃過期之後，報名紀錄還在", r.A_regs_after, "1");
    check("🔴 掃過期之後，座位沒有被還回去", r.A_seats_after, "1");
    check("🔴 掃過期之後，免費訂單沒有被取消", r.A_status_after, "processing");
    check("掃過期之後，免費訂單仍然是 paid", r.A_payment_status_after, "paid");

    console.log("  ── 🔴 反向對照：過期機制沒有被整個關掉 ──");
    check("（前置）付費訂單有 1 筆報名", r.B_regs_before, "1");
    check("（前置）場次已佔 1 個座位", r.B_seats_before, "1");
    check("🔴 total > 0 且未付款 → 仍然被取消", r.B_status_after, "cancelled");
    check("🔴 它的報名紀錄仍然被刪掉", r.B_regs_after, "0");
    check("🔴 它的座位仍然被還回去", r.B_seats_after, "0");
    check("這一輪剛好清掉 1 張訂單（免費那張沒被算進去）", r.C_expired_count, "1");
    check("settle_free_order 拒絕 total > 0 的訂單", r.B_settle_reason, "order_not_free");
    check("而且沒有把它標成已付款", r.B_settle_settled, "false");

    console.log("  ── 🔴 發票：免費訂單不可以被拿去 Amego 開 NT$0 ──");
    check("🔴 invoice_backlog 不回 total = 0 的已付款訂單", r.D_backlog_has_free, "false");
    check(
      "🔴 invoice_backlog 仍然回 total > 0 的已付款訂單（沒有把清單整個關掉）",
      r.D_backlog_has_charged,
      "true",
    );
    // 判準是金額不是 payment_method：這一張是 payment_method='card' 的 0 元單。
    check(
      "🔴 判準是金額不是 payment_method：payment_method='card' 的 0 元單也被排除",
      r.D_backlog_has_zero_card,
      "false",
    );

    console.log("  ── settle_free_order 的其他分支 ──");
    check("不存在的訂單 → order_not_found", r.E_unknown_order, "order_not_found");
    check(
      "已取消的訂單 → order_not_pending（不准被推回 paid）",
      r.E_cancelled,
      "order_not_pending",
    );

    console.log("  ── payment_method 的 CHECK ──");
    check("沒被承認的值（'gift'）→ 23514", r.F_bad_value, "23514");
    check("'free' → 過", r.F_free_value, "00000");

    console.log("  ── 權限 ──");
    check("🔴 anon 沒有 settle_free_order 的 execute", r.G_anon_settle, "no");
    check("🔴 authenticated 沒有 settle_free_order 的 execute", r.G_auth_settle, "no");
    check(
      "🔴 public 沒有 settle_free_order 的 execute（這是真正生效的那一半）",
      r.G_public_settle,
      "no",
    );
    check("service_role 有 settle_free_order 的 execute（對照組）", r.G_service_settle, "yes");
    check("anon 沒有 invoice_backlog 的 execute", r.G_anon_backlog, "no");
  }
}

// =============================================================================
// 收尾
// =============================================================================
console.log("\n────────────────────────────────────────────────────");
if (skipped.length > 0) {
  console.log(yellow(`跳過：${skipped.length} 段`));
  for (const s of skipped) console.log(yellow(`  • ${s}`));
}
console.log(`${pass} passed, ${fail} failed`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
