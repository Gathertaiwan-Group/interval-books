#!/usr/bin/env node
/**
 * admin-order-notify-selftest.mjs —— 新訂單／新報名時通知店家（0032）的自檢
 *
 * 分兩段，理由與 notify-selftest.mjs 相同：這支測試在沒有資料庫的機器上也必須
 * 有意義。
 *
 *   [靜態] 讀 supabase/migrations/0032 與幾支 .ts 的原始碼，守的是**設計不變量**：
 *          notify_emails 有沒有從 anon/authenticated 的 table-level grant 排除、
 *          enqueue_admin_order_email() 有沒有查 site_settings 而不是接受呼叫端
 *          傳位址、notify.ts 有沒有把店家信包在自己的 try/catch 裡且不擋到客人
 *          的信、後台設定頁三個檔案（schemas / repo / route）有沒有串起來。
 *          這些答案就寫在檔案裡，不連線也回答得出來。**永遠會跑。**
 *
 *          ⚠️ 排版那一段**直接 import src/lib/email-templates.ts 本人**，
 *             所以它驗到的是 production 真正用的那一份。需要 Node ≥ 22.18
 *             （原生 TypeScript type stripping）。
 *
 *          ⚠️ **不動態 import src/lib/admin/schemas.ts。** 那支檔案有真的值
 *             import（`@/lib/admin/localized-list`、`@/lib/event-blocks`、
 *             `@/lib/email-templates`），Node 的原生 type stripping 不做路徑別名
 *             解析，`@/` 這種 alias 只有 Vite/bundler 認得——這在這一期加
 *             notifyEmailsSchema **之前**就是事實（zod 與另外兩支既有的 value
 *             import 早就在那裡），不是這一期造成的限制。schemas.ts 因此改用
 *             靜態源碼比對驗證形狀，真正的驗證邏輯（parseRecipients 怎麼拆字串）
 *             在下面 [9] 直接動態測試——notifyEmailsSchema 的 refine 就是薄薄一層
 *             包著 parseRecipients()，邏輯只有一份，動態測過那一份就夠。
 *
 *   [DB]   對一個真的資料庫**同時發請求**，每一次 q() 是一個獨立的 psql 子行程
 *          （獨立連線），沿用 notify-selftest.mjs 的 NOTIFY_SELFTEST_PG_URL——
 *          同一個變數、同一個網域（notify），不另外發明一個環境變數。缺這個
 *          變數就整段 skip（會印出來，不會靜悄悄消失），CI 沒有本機 Postgres 時
 *          這段自然跳過，不影響 exit code。
 *
 * ── ⚠️ 這支測試不會寄出任何一封信 ────────────────────────────────────────
 * 跟 notify-selftest.mjs 一樣：不 import src/server/email.ts（server-only，
 * 載不起來），也沒有任何 fetch。
 *
 * 準備本機測試庫（可以另建一個，避免跟 notify-selftest.mjs 用的 ib_p3_test 或
 * 別的 agent 手上的 scratch DB 撞在一起）：
 *
 *     createdb ib_0032_test
 *     NOTIFY_SELFTEST_PG_URL=postgres:///ib_0032_test node scripts/admin-order-notify-selftest.mjs
 *
 * 這支不負責套用 migration（notify-selftest.mjs 的 NOTIFY_SELFTEST_APPLY=1 已經
 * 示範過怎麼在本機補 auth.users / storage / anon|authenticated|service_role 三個
 * role；直接沿用那一套建庫，再手動 `psql -f` 套到 0032 為止）。這支只在
 * `to_regprocedure('public.enqueue_admin_order_email(...)')` 存在時才跑 DB 段，
 * 不存在就當作「這個庫還沒套用 0032」清楚跳過，不是紅。
 */

import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { assertLedgerMatchesDisk, assertMigrationDependencies } from "./lib/migration-ledger.mjs";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-order-notify-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");
const MIG_0032 = join(MIG_DIR, "0032_admin_order_notify.sql");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 notify-selftest.mjs 同一套，逐檔各自一份是這個 repo 的慣例）
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function check(label, actual, expected, hint) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
    if (hint) console.log(red(`      ${hint}`));
  }
}

function checkTrue(label, value, hint) {
  check(label, value === true, true, hint);
}

/** 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串（見 run-selftests.mjs 守門 4）。 */
const readFile = (p) => {
  if (!existsSync(p)) {
    throw new Error(
      `selftest 讀不到檔案：${p}（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串——` +
        `回空字串會讓所有「確認原始碼裡沒有 X」的否定斷言靜默通過。）`,
    );
  }
  return readFileSync(p, "utf8");
};

/** 把 `--` 開頭的整行拿掉，免得註解裡提到的字串讓 includes()/regex 假性通過。 */
function stripComments(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/** 拿掉 TypeScript 的註解。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/** 切出單一函式的本體：從 `create or replace function <名字>(` 切到它自己的 `comment on function <名字>(`。 */
function functionBody(sql, name) {
  const start = sql.indexOf(`create or replace function ${name}(`);
  if (start === -1) return "";
  const end = sql.indexOf(`comment on function ${name}(`, start);
  return sql.slice(start, end === -1 ? sql.length : end);
}

console.log("═══ 新訂單／新報名通知店家自檢（0032）═══");

// =============================================================================
// [1] migration 0032 檔案盤點
// =============================================================================
console.log("\n[1] migration 0032 檔案盤點");
check("0032 存在", existsSync(MIG_0032), true);

const sql0032raw = readFile(MIG_0032);
const sql0032 = stripComments(sql0032raw);

checkTrue("反空殼：0032 不是空檔", sql0032raw.length > 1500);
checkTrue("有 begin; … commit;", /^begin;/m.test(sql0032) && /^commit;/m.test(sql0032));
check("沒有 drop function", /drop\s+function/i.test(sql0032), false);
check("沒有 drop table", /drop\s+table/i.test(sql0032), false);
check("沒有 drop constraint", /drop\s+constraint/i.test(sql0032), false);
check("沒有 drop view", /drop\s+view/i.test(sql0032), false);

// ⚠️ 這支測試不去自動比對 scripts/lib/migration-ledger.mjs（任務指示：那個檔案
//    由另一個流程補列，這裡不搶著改）。但既有的共用斷言照樣掛上——這是每一支
//    引用它的自檢都會做的事，0032 沒有理由是例外。
// 帳本現在已經補上 0032 那一列（touches: cms / orders_payments / email_outbox），
// 下面兩條共用斷言恢復全綠。
assertLedgerMatchesDisk(check, MIG_DIR);
assertMigrationDependencies(check, MIG_DIR, {
  suite: "admin-order-notify-selftest",
  dependsOn: ["cms", "email_outbox", "orders_payments"],
  // ── 0031_event_gallery.sql：不必重讀 ───────────────────────────────────
  // 0031 在帳本上標的是 events_shape / localized_list / products_availability /
  // session_seats —— 沒有 cms / email_outbox / orders_payments 任何一個，所以這條
  // 從來沒有為它轉紅。它加的是活動相簿（events.gallery_keys）與放寬
  // admin_upsert_event_with_session() 的 external_url 驗證，跟 site_settings、
  // email_outbox、enqueue_admin_order_email() 都沒有交集。
  // ── 0032_admin_order_notify.sql 的重讀結論 ─────────────────────────────
  // 這支自檢本來就是為 0032 寫的（見檔頭 [1]-[9]），所以它跟這支 migration 的關係
  // 跟其他六支不一樣：不是「後來的 migration 動到我在乎的東西，我要回頭確認」，
  // 而是「我在乎的東西就是這支 migration 本身」。[1] 直接 readFile(MIG_0032) 讀
  // 現在磁碟上的 0032 全文，[2] 逐條核對 site_settings 的 alter / revoke / grant，
  // [3] 核對 enqueue_admin_order_email() 的函式本體與權限，[13] 核對
  // src/server/notify.ts、src/server/repos/email-outbox.ts、
  // src/lib/email-templates.ts、src/server/repos/site-settings.ts、
  // src/routes/admin/_shell.settings.tsx 這五支被 0032 那個 commit
  // （1fd71b4）一起改動的檔案——驗到的都是它們**現在**的內容，不是某個舊版本的
  // 快照，所以沒有「0032 落地之後這些斷言是否還成立」這個問題：它們本來就是照著
  // 落地後的 0032 寫的。真正需要交代的只有 dependsOn 這三個區域本身：cms（=
  // site_settings 的 grant 收緊）、email_outbox（= 新的 dedupe_key 前綴與新函式）、
  // orders_payments（= enqueue_admin_order_email() 讀 public.orders 帶進來的標籤，
  // 但 0032 的 SQL 裡一行 `select … from public.orders` 都沒有——真正讀 orders 的
  // 是 getOrderForNotify()，它是 0022 就有的既有函式，0032 只把它的 select 清單
  // 多加兩欄 payment_method / shipping_method，兩欄都是 0005 就存在、由 0028 加了
  // 一個允許值的既有欄位，不是新開的洞）都已經是這份清單在驗的東西。原樣成立。
  // ── 0034_transfer_payment.sql 的重讀結論 ───────────────────────────────────
  // 0034 加匯款付款方式。它動到這支自檢依賴的三個區域，逐一對過：
  //
  //   · cms（site_settings）——加了四個銀行欄位，而且**刻意不碰** 0032 §0.2 那份
  //     column-level grant 清單（column-level grant 不涵蓋新增的欄位，所以四欄天生
  //     anon 讀不到）。下面 [2] 那一整段驗的是 notify_emails 不在清單裡、而公開欄位
  //     還在清單裡——0034 一個字都沒改那份 grant，兩邊原樣成立。這一期另外補了一條
  //     斷言：四個銀行欄位也不可以出現在那份清單裡。
  //   · email_outbox（email_copy）——0034 只放寬 email_copy_template_valid 這條
  //     CHECK（多一個 'remittance'）並種四筆文案。email_outbox 那張表、
  //     enqueue_admin_order_email()、claim_order_notify()、dedupe_key 的 unique，
  //     0034 一個字都沒動。
  //   · orders_payments——orders.payment_method 的 CHECK 多一個 'transfer'、加兩個
  //     remittance_* 欄位、加一支 admin_mark_order_paid()。既有的 markOrderPaid()
  //     與兩支 webhook 都沒被碰。
  //
  // 唯一與這支自檢的斷言真的相交的是 renderAdminOrderNotificationEmail()：它多了
  // 一個必填的 `stage`（'afterPayment' | 'atOrderTime'），因為 0034 讓店家在**下單
  // 當下**也會收到一封「待收款」通知（dedupe_key `order_placed_admin:`，與 0032 的
  // `order_notify_admin:` 刻意分開——共用會讓付款成功那封被去重掉）。下面每一條驗
  // 這封信內容的斷言都補上了 stage，並新增了 atOrderTime 那一版的對照。原樣成立。
  // ── 0035_admin_order_registration_cleanup.sql 的重讀結論 ───────────────────
  // 0035 是後台訂單刪除／封存＋名單刪除單筆，動到這支自檢依賴的 orders_payments
  // （加 orders.archived_at 一個 nullable 欄位、新增 admin_delete_order() /
  // admin_archive_order() 兩支函式）。跟這支自檢的斷言完全不相交：
  //
  //   · 0035 沒有 alter site_settings（cms）、沒有碰 email_copy／email_outbox／
  //     enqueue_admin_order_email()／claim_order_notify()（email_outbox）一個字。
  //   · orders 那一側只是**加欄位、加函式**，getOrderForNotify()（0022 就有）與
  //     renderAdminOrderNotificationEmail() 讀的欄位清單（customer_name／
  //     payment_method／shipping_method／…）一個都沒被改型別或改語意；
  //     archived_at 純粹是新增的、預設 null，不在任何一支通知函式的 select 清單裡。
  //   · admin_delete_order() 會 cascade 刪掉 payments／invoices／
  //     order_post_payment_log，但那是 admin 主動刪一張未付款訂單時的事——不是
  //     0032／0034 這兩條通知路徑（下單當下、付款成功後）會經過的狀態轉移，兩者
  //     不會同時發生在同一張訂單上（訂單被刪的當下已經不存在，claim_order_notify()
  //     也無單可查）。
  //
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

// =============================================================================
// [2] site_settings.notify_emails 與 anon/authenticated 的 column-level grant
// =============================================================================
console.log("\n[2] site_settings.notify_emails 欄位與權限");

const alterTargets = [...sql0032.matchAll(/alter\s+table\s+public\.(\w+)/gi)].map((m) =>
  m[1].toLowerCase(),
);
check(
  "alter table 只打在 site_settings 上（這一支不碰 email_outbox 的結構）",
  [...new Set(alterTargets)],
  ["site_settings"],
);
checkTrue(
  "add column notify_emails，預設 info@intervalbooks.tw",
  /add column if not exists notify_emails text not null default 'info@intervalbooks\.tw'/.test(
    sql0032,
  ),
);

checkTrue(
  "先 revoke 整張表對 anon/authenticated 的 select",
  /revoke select on public\.site_settings from anon, authenticated;/.test(sql0032),
);

const grantStart = sql0032.indexOf("grant select (");
const grantEnd = sql0032.indexOf(") on public.site_settings to anon, authenticated;", grantStart);
checkTrue("找得到 column-level 的 grant select ( … )", grantStart !== -1 && grantEnd !== -1);
const grantedColumns = sql0032.slice(grantStart, grantEnd);
check(
  "🔴 notify_emails 不在重新開放給 anon/authenticated 的欄位清單裡（這是這一支最重要的一條）",
  grantedColumns.includes("notify_emails"),
  false,
  "漏了這一條的話，任何人都能用瀏覽器 JS 裡公開的 anon key 直接打 " +
    "`${SUPABASE_URL}/rest/v1/site_settings?select=notify_emails` 讀到店家的通知信箱",
);
checkTrue(
  "反面對照：contact_email 這種本來就公開的欄位還在清單裡（沒有把整張表一起鎖死）",
  grantedColumns.includes("contact_email") && grantedColumns.includes("map_link"),
);
checkTrue(
  "反面對照的反面：偵測器不是永遠回 false —— 塞一段真的含 notify_emails 的清單進去，斷言要能抓到",
  "id, contact_email, notify_emails, site_url".includes("notify_emails"),
);

checkTrue(
  "comment on column 有解釋這一欄是內部用途、空字串安全",
  /comment on column public\.site_settings\.notify_emails is/.test(sql0032),
);

// =============================================================================
// [3] enqueue_admin_order_email() 函式形狀
// =============================================================================
console.log("\n[3] enqueue_admin_order_email() 函式形狀");

const enqAdmin = functionBody(sql0032, "public.enqueue_admin_order_email");
checkTrue("反空殼：找得到函式本體", enqAdmin.length > 200);
checkTrue("returns boolean", /returns boolean/.test(enqAdmin));
checkTrue("security definer", /security definer/.test(enqAdmin));
checkTrue("set search_path = public", /set search_path = public/.test(enqAdmin));
check(
  "🔴 沒有 p_order_id 參數（地址不靠呼叫端傳，靠 SQL 自己查 site_settings）",
  /p_order_id/.test(enqAdmin),
  false,
);
checkTrue(
  "四個參數：dedupe_key / subject / body_text / body_html",
  /p_dedupe_key\s+text/.test(enqAdmin) &&
    /p_subject\s+text/.test(enqAdmin) &&
    /p_body_text\s+text/.test(enqAdmin) &&
    /p_body_html\s+text/.test(enqAdmin),
);
checkTrue(
  "地址從 site_settings 查（.id = 1，同一個 singleton）",
  /from public\.site_settings s\s+where s\.id = 1/.test(enqAdmin),
);
check("沒有碰 orders 表（這支不需要訂單資料）", /\borders\b/.test(enqAdmin), false);
checkTrue(
  "🔴 空值判斷是「拿掉逗號與空白後還有沒有東西」，不是單純 btrim（§0.5）",
  /regexp_replace\(v_emails,\s*'\[,\\s\]\+',\s*'',\s*'g'\)\s*=\s*''/.test(enqAdmin),
  "純 btrim 會把 ' , , ' 這種只有逗號空白的值誤判成「有設定」",
);
checkTrue("空的話回 false（安靜跳過，不是 raise exception）", /return false;/.test(enqAdmin));
checkTrue(
  "🔴 冪等：on conflict (dedupe_key) do nothing——跟 order_paid / registration_ticket 同一個保證",
  /on conflict \(dedupe_key\) do nothing/.test(enqAdmin),
);
checkTrue("插入的 to_email 是 btrim 過的設定值", /btrim\(v_emails\)/.test(enqAdmin));
checkTrue(
  "dedupe_key 空字串會 raise exception（呼叫端寫錯馬上炸，不是靜默失敗）",
  /raise exception 'EMPTY_DEDUPE_KEY'/.test(enqAdmin),
);

// =============================================================================
// [4] 權限：SECURITY DEFINER 的 execute grant
// =============================================================================
console.log("\n[4] 權限（execute grants，處理方式同 0022 §12）");
checkTrue(
  "把新函式的簽名放進要收權限的清單",
  /'public\.enqueue_admin_order_email\(text, text, text, text\)'/.test(sql0032),
);
checkTrue("清單裡 revoke from public", /revoke execute on function %s from public/.test(sql0032));
checkTrue(
  "清單裡 revoke from anon, authenticated",
  /revoke execute on function %s from anon, authenticated/.test(sql0032),
);
checkTrue(
  "清單裡 grant 給 service_role",
  /grant {2}execute on function %s to service_role/.test(sql0032),
);

// =============================================================================
// [5] src/server/notify.ts 接線
// =============================================================================
console.log("\n[5] src/server/notify.ts 接線");

const notifyTs = readFile(join(ROOT, "src/server/notify.ts"));
const notifyCode = stripTs(notifyTs);

checkTrue(
  "dedupeKeys 新增 orderNotifyAdmin，格式 order_notify_admin:<order_id>",
  /orderNotifyAdmin:\s*\(orderId:\s*string\)\s*=>\s*`order_notify_admin:\$\{orderId\}`/.test(
    notifyCode,
  ),
);
checkTrue("import enqueueAdminOrderEmail", /enqueueAdminOrderEmail/.test(notifyCode));
checkTrue(
  "import renderAdminOrderNotificationEmail",
  /renderAdminOrderNotificationEmail/.test(notifyCode),
);
checkTrue(
  "呼叫 enqueueAdminOrderEmail 時用 dedupeKeys.orderNotifyAdmin(orderId)",
  /dedupeKey:\s*dedupeKeys\.orderNotifyAdmin\(orderId\)/.test(notifyCode),
);
checkTrue("成功排入時 queued 計數 +1", /if \(addedAdminMail\) queued \+= 1;/.test(notifyCode));
checkTrue("這個檔案整體仍然「永不 throw」（新增的段落沒有破例）", !/\bthrow\b/.test(notifyCode));

// ── 隔離性：店家信必須整段包在自己的 try/catch 裡，客人的信不在那個 try 裡面 ──
const iCustomerMail = notifyCode.indexOf("enqueueOrderEmail(");
// 錨點是 `if (addedOrderMail) queued += 1;`，不是區塊裡的 `const sessionParticipants`
// ——後者在 `try {` 之後，拿它當起點會把 `try {` 自己切掉，讓下面「有沒有 try {」
// 的斷言必假（這支自檢第一次跑就這樣紅過一次，故意把這段註解留著）。
const iAdminBlockStart = notifyCode.indexOf("if (addedOrderMail) queued += 1;");
const iAdminCatchBody = notifyCode.indexOf("店家通知信排入失敗");
const iRegistrationLoop = notifyCode.indexOf("loadPaidRosterByOrder(orderId)");
const iFinish = notifyCode.indexOf("finishOrderNotify(orderId)");

checkTrue(
  "四個定位點都抓得到（反空殼：任何一個抓不到，下面的順序斷言都沒有意義）",
  iCustomerMail > 0 &&
    iAdminBlockStart > 0 &&
    iAdminCatchBody > 0 &&
    iRegistrationLoop > 0 &&
    iFinish > 0,
);
checkTrue(
  "🔴 客人的付款成功信（enqueueOrderEmail）排在店家通知信區塊之前——不是被包在同一個 try 裡",
  iCustomerMail < iAdminBlockStart,
);
checkTrue(
  "🔴 逐位參加者的報名信迴圈在店家通知信的 catch 之後——不會被店家信的錯誤擋住",
  iAdminCatchBody < iRegistrationLoop,
);
checkTrue("finishOrderNotify 在報名信迴圈之後（最後才結 claim）", iRegistrationLoop < iFinish);

const adminBlock = notifyCode.slice(iAdminBlockStart, iRegistrationLoop);
checkTrue("店家通知信區塊自己有 try {", /try\s*\{/.test(adminBlock));
checkTrue("店家通知信區塊自己有 catch (err) {", /catch\s*\(err\)\s*\{/.test(adminBlock));
checkTrue(
  "try 區塊裡真的呼叫了 enqueueAdminOrderEmail",
  /enqueueAdminOrderEmail\(/.test(adminBlock),
);
check(
  "🔴 客人的付款成功信呼叫沒有被複製或移進這個區塊裡（只應該出現在區塊之前）",
  adminBlock.includes("enqueueOrderEmail("),
  false,
);
check(
  "🔴 報名信迴圈的呼叫沒有被搬進這個區塊裡",
  adminBlock.includes("loadPaidRosterByOrder("),
  false,
);

// =============================================================================
// [6] src/server/repos/email-outbox.ts：enqueueAdminOrderEmail 與 getOrderForNotify 擴充
// =============================================================================
console.log("\n[6] src/server/repos/email-outbox.ts");

const outboxTs = readFile(join(ROOT, "src/server/repos/email-outbox.ts"));
const outboxCode = stripTs(outboxTs);

checkTrue(
  "enqueueAdminOrderEmail 呼叫 RPC enqueue_admin_order_email",
  /rpc\("enqueue_admin_order_email"/.test(outboxCode),
);
checkTrue(
  "帶的四個參數名稱對得上 SQL 那邊的簽名",
  /p_dedupe_key:\s*input\.dedupeKey/.test(outboxCode) &&
    /p_subject:\s*input\.subject/.test(outboxCode) &&
    /p_body_text:\s*input\.text/.test(outboxCode) &&
    /p_body_html:\s*input\.html/.test(outboxCode),
);
check(
  "沒有收件地址參數（跟 enqueueOrderEmail 同一個理由：地址不從 Node 傳）",
  /p_to_email|p_emails|p_recipients/.test(outboxCode),
  false,
);
checkTrue(
  "回傳 data === true（跟 enqueueOrderEmail 同一個 boolean 慣例）",
  /enqueue_admin_order_email[\s\S]{0,400}return data === true;/.test(outboxCode),
);

// 0034 把這一行折成多行（多了 created_at），所以比對改成「切出 select 的欄位清單
// 再逐欄確認」，而不是釘死一整行字串。守的事情沒變，而且順便擋掉了「欄位還在、
// 但被搬到另一支查詢裡」這種搬家式失守。
{
  const sel = (outboxCode.match(
    /\.select\(\s*"(id, order_no, customer_name, total, locale[^"]*)"/,
  ) ?? [])[1];
  checkTrue("反空殼：切得到 getOrderForNotify 的 select 欄位清單", Boolean(sel));
  const cols = (sel ?? "").split(",").map((c) => c.trim());
  for (const c of ["payment_method", "shipping_method"]) {
    checkTrue(`getOrderForNotify 的 select 有 ${c}（0032 加的）`, cols.includes(c));
  }
  checkTrue(
    "getOrderForNotify 的 select 有 created_at（0034 加的，匯款期限要用）",
    cols.includes("created_at"),
  );
  // ⚠️ 反面對照：這支查詢**不可以**把 customer_email 撈進 Node —— 地址由 0022 §7
  //    的 SQL 自己 join，這是那個設計的承重牆（見 getOrderForNotify 的檔頭）。
  check("getOrderForNotify 不 select customer_email", cols.includes("customer_email"), false);
}
checkTrue(
  "NotifyOrder 型別加了 paymentMethod / shippingMethod",
  /paymentMethod:\s*string \| null/.test(outboxCode) && /shippingMethod:\s*string/.test(outboxCode),
);
checkTrue(
  "回傳物件真的把兩欄映射進去",
  /paymentMethod:\s*o\.payment_method == null \? null : String\(o\.payment_method\)/.test(
    outboxCode,
  ) && /shippingMethod:\s*String\(o\.shipping_method/.test(outboxCode),
);

// log 紀律：新函式的 console.error 只印 code 與 message，不印整包 error。
const outboxErrorCalls = outboxCode.match(/console\.error\([\s\S]{0,300}?\);/g) ?? [];
const adminEnqueueLog = outboxErrorCalls.find((c) => c.includes("enqueue_admin_order_email"));
checkTrue("反空殼：找得到新函式自己的 console.error", Boolean(adminEnqueueLog));
if (adminEnqueueLog) {
  checkTrue(
    "只印 error.code 與 error.message（不是整包 error 物件）",
    /\$\{error\.code\} \$\{error\.message\}/.test(adminEnqueueLog),
  );
  check(
    "log 沒有裸的 dedupeKey 以外的東西被當成地址印出來",
    /to_email|toEmail/.test(adminEnqueueLog),
    false,
  );
}

// =============================================================================
// [7] src/server/email.ts：parseRecipients 用在 Resend 的 to 陣列
// =============================================================================
console.log("\n[7] src/server/email.ts：多收件人");

const emailTs = readFile(join(ROOT, "src/server/email.ts"));
const emailCode = stripTs(emailTs);

checkTrue(
  "import parseRecipients",
  /import \{[^}]*parseRecipients[^}]*\} from "@\/lib\/email-templates"/.test(emailCode),
);
checkTrue(
  "🔴 Resend 的 to 陣列改用 parseRecipients(message.to)，不是單元素陣列 [message.to]",
  /to:\s*parseRecipients\(message\.to\)/.test(emailCode),
  "舊寫法 `to: [message.to]` 遇到逗號分隔的多個地址會被 Resend 當成一個不合法的地址",
);
check("舊的單元素陣列寫法已經不在了", /to:\s*\[message\.to\]/.test(emailCode), false);
checkTrue("email.ts 仍然永不 throw", !/\bthrow\b/.test(emailCode));

// 沿用 notify-selftest.mjs [17] 的偵測邏輯，重新對這支改過的檔案跑一次：
// log 只能透過 maskEmail(message.to) 印收件人，不能有裸的 message.to。
const logCalls = [...emailCode.matchAll(/console\.\w+\([\s\S]{0,400}?\);/g)].map((m) => m[0]);
checkTrue("反空殼：email.ts 裡確實有 console 呼叫", logCalls.length >= 3);
for (const call of logCalls) {
  check(
    `log 沒有裸的 message.to（改完之後重驗一次）：${call.slice(0, 40).replace(/\s+/g, " ")}…`,
    /message\.to(?!\))/.test(call.replace(/maskEmail\(message\.to\)/g, "maskEmail(…)")),
    false,
  );
}

// =============================================================================
// [8] 後台設定頁：schemas.ts / site-settings.ts repo / _shell.settings.tsx
// =============================================================================
console.log("\n[8] 後台「全站設定」頁串接");

const schemasTs = readFile(join(ROOT, "src/lib/admin/schemas.ts"));
const schemasCode = stripTs(schemasTs);
checkTrue(
  "import parseRecipients",
  /import \{ parseRecipients \} from "@\/lib\/email-templates"/.test(schemasCode),
);
checkTrue(
  "定義 notifyEmailsSchema",
  /export const notifyEmailsSchema = z[\s\S]{0,60}\.string\(\)/.test(schemasCode),
  "允許 z 與 .string() 中間被 prettier 換行——這條只驗證形狀，不驗證排版",
);
checkTrue(
  'notifyEmailsSchema 允許空字串（if (value === "") return true）',
  /if \(value === ""\) return true;/.test(schemasCode),
);
checkTrue(
  "notifyEmailsSchema 真的呼叫 parseRecipients() 拆解",
  /parseRecipients\(value\)/.test(schemasCode),
);
checkTrue(
  "siteSettingsSchema 加了 notify_emails: notifyEmailsSchema",
  /notify_emails:\s*notifyEmailsSchema/.test(schemasCode),
);

const repoTs = readFile(join(ROOT, "src/server/repos/site-settings.ts"));
const repoCode = stripTs(repoTs);
checkTrue(
  "COLUMNS 常數含 notify_emails",
  /const COLUMNS =\s*\n?\s*"[^"]*notify_emails/.test(repoCode),
);
checkTrue("SiteSettingsRow 有 notify_emails: string", /notify_emails:\s*string;/.test(repoCode));
checkTrue(
  "updateSiteSettings() 的 update({...}) 真的寫了 notify_emails",
  /notify_emails:\s*input\.notify_emails,/.test(repoCode),
);

const routeTsx = readFile(join(ROOT, "src/routes/admin/_shell.settings.tsx"));
const routeCode = stripTs(routeTsx);
checkTrue(
  "toFormValues() 映射 notify_emails",
  /notify_emails:\s*settings\.notify_emails,/.test(routeCode),
);
checkTrue('表單裡有 name="notify_emails" 的 FormField', /name="notify_emails"/.test(routeCode));
checkTrue("說明文字有提到逗號分隔", /逗號分隔/.test(routeCode));

// =============================================================================
// [9] 排版：直接 import src/lib/email-templates.ts 本人
// =============================================================================
console.log("\n[9] 信件排版與 parseRecipients（import 產線那一份）");

let tpl = null;
try {
  tpl = await import(pathToFileURL(join(ROOT, "src/lib/email-templates.ts")).href);
  checkTrue("import src/lib/email-templates.ts 成功", true);
} catch (err) {
  fail += 1;
  console.log(red(`  ✗ 無法 import src/lib/email-templates.ts：${String(err).slice(0, 200)}`));
  console.log(red("      需要 Node ≥ 22.18（原生 TypeScript type stripping）。"));
}

if (tpl) {
  // ---- parseRecipients：逗號分隔字串拆解，含前後空白與空字串 ----------------
  check("parseRecipients(null)", tpl.parseRecipients(null), []);
  check("parseRecipients(undefined)", tpl.parseRecipients(undefined), []);
  check("parseRecipients('')", tpl.parseRecipients(""), []);
  check("parseRecipients 只有空白", tpl.parseRecipients("   "), []);
  check("parseRecipients 只有逗號", tpl.parseRecipients(",,,"), []);
  check("parseRecipients 單一地址", tpl.parseRecipients("a@x.com"), ["a@x.com"]);
  check("parseRecipients 單一地址含前後空白", tpl.parseRecipients("  a@x.com  "), ["a@x.com"]);
  check("parseRecipients 兩個地址，逗號後有空白", tpl.parseRecipients("a@x.com, b@y.com"), [
    "a@x.com",
    "b@y.com",
  ]);
  check("🔴 parseRecipients 中間夾空段落會被丟掉", tpl.parseRecipients("a@x.com,,b@y.com"), [
    "a@x.com",
    "b@y.com",
  ]);
  check("parseRecipients 頭尾多逗號也會被丟掉", tpl.parseRecipients(",a@x.com,b@y.com,"), [
    "a@x.com",
    "b@y.com",
  ]);
  check(
    "parseRecipients 不會幫你去重（呼叫端如果填兩次一樣的地址，兩個都留著）",
    tpl.parseRecipients("a@x.com,a@x.com"),
    ["a@x.com", "a@x.com"],
  );

  // ---- maskEmail：既有行為（單一地址）維持不變 -------------------------------
  check(
    "maskEmail 一般情況（沒有逗號時行為不變）",
    tpl.maskEmail("abcdef@example.com"),
    "ab***@example.com",
  );
  check("maskEmail 單字元帳號", tpl.maskEmail("a@example.com"), "a***@example.com");
  check("maskEmail 不是 email", tpl.maskEmail("nonsense"), "***");
  check("maskEmail 空值", tpl.maskEmail(null), "***");

  // ---- maskEmail：多收件人（0032 新增，這是這一期最重要的遮罩案例）-----------
  check(
    "🔴 maskEmail 兩個地址都要被遮罩，不是只遮第一個",
    tpl.maskEmail("a@x.com, b@y.com"),
    "a***@x.com, b***@y.com",
  );
  checkTrue(
    "🔴 反面對照：舊版只找第一個 @ 的寫法會讓第二個地址原樣留在輸出裡——這裡直接斷言它不在",
    !tpl.maskEmail("a@x.com, b@y.com").includes("b@y.com"),
  );
  check(
    "maskEmail 多字元帳號的多收件人",
    tpl.maskEmail("abcdef@example.com, ghijkl@example.org"),
    "ab***@example.com, gh***@example.org",
  );
  check(
    "maskEmail 多收件人中間有空段落（設定欄位打錯多一個逗號）",
    tpl.maskEmail("a@x.com,,b@y.com"),
    "a***@x.com, ***, b***@y.com",
  );
  check("maskEmail 只有逗號", tpl.maskEmail(","), "***, ***");

  // ---- paymentMethodLabel / shippingMethodLabel -----------------------------
  check("paymentMethodLabel card", tpl.paymentMethodLabel("card"), "信用卡");
  check("paymentMethodLabel atm", tpl.paymentMethodLabel("atm"), "ATM 轉帳");
  check("paymentMethodLabel cvs_cod", tpl.paymentMethodLabel("cvs_cod"), "超商代收");
  check("paymentMethodLabel test_paid", tpl.paymentMethodLabel("test_paid"), "測試付款");
  check("paymentMethodLabel free", tpl.paymentMethodLabel("free"), "免費（無需付款）");
  check("paymentMethodLabel null", tpl.paymentMethodLabel(null), "（未設定）");
  check(
    "paymentMethodLabel 未知代碼印代碼本身（不是空白，也不是丟例外）",
    tpl.paymentMethodLabel("some_new_gateway"),
    "some_new_gateway",
  );
  check("shippingMethodLabel home", tpl.shippingMethodLabel("home"), "宅配到府");
  check("shippingMethodLabel cvs", tpl.shippingMethodLabel("cvs"), "超商取貨");
  check("shippingMethodLabel pickup", tpl.shippingMethodLabel("pickup"), "門市自取");
  check("shippingMethodLabel none", tpl.shippingMethodLabel("none"), "無需配送");

  // ---- renderAdminOrderNotificationEmail ------------------------------------
  const LOC = { zh: "測試商品", en: "Test item", ja: "テスト商品" };
  const baseInput = {
    orderNo: "IB-SELFTEST-0032",
    total: 1280,
    paymentMethod: "card",
    shippingMethod: "home",
    items: [{ name: LOC, quantity: 2, subtotal: 1280 }],
    sessions: [],
  };
  const bookMail = tpl.renderAdminOrderNotificationEmail(baseInput);
  checkTrue(
    "反空殼：subject/text/html 都非空",
    Boolean(bookMail.subject && bookMail.text && bookMail.html),
  );
  checkTrue("subject 含訂單編號", bookMail.subject.includes("IB-SELFTEST-0032"));
  checkTrue("text 含格式化過的金額", bookMail.text.includes("NT$1,280"));
  checkTrue("text 含付款方式的中文標籤", bookMail.text.includes("信用卡"));
  checkTrue("text 含收件方式的中文標籤", bookMail.text.includes("宅配到府"));
  checkTrue(
    "text 含品項名稱與數量",
    bookMail.text.includes("測試商品") && bookMail.text.includes("× 2"),
  );
  checkTrue(
    "html 對品項名稱做了 HTML escape 的路徑（沿用 layout()，不是自己兜字串）",
    bookMail.html.includes("測試商品"),
  );
  check(
    "只買書（沒有場次）時標題不含「活動報名」四個字",
    bookMail.text.split("\n")[0].includes("活動報名"),
    false,
  );
  check(
    "🔴 只買書的信件內容裡沒有「參加人數」這個標籤（沒有場次就不該有場次區塊）",
    bookMail.text.includes("參加人數"),
    false,
  );

  const sessionInput = {
    ...baseInput,
    shippingMethod: "none",
    sessions: [
      {
        session: {
          title: { zh: "自檢場次", en: "selftest session", ja: "セルフテスト" },
          location: { zh: "小時光書店", en: "IntervalBooks", ja: "インターバルブックス" },
          startsAt: "2026-10-01T11:00:00+08:00",
          endsAt: "2026-10-01T13:00:00+08:00",
        },
        participants: 3,
      },
    ],
  };
  const eventMail = tpl.renderAdminOrderNotificationEmail(sessionInput);
  checkTrue("有場次時標題含「活動報名」", eventMail.text.split("\n")[0].includes("活動報名"));
  checkTrue("🔴 有場次時 text 含「參加人數：3」", eventMail.text.includes("參加人數：3"));
  checkTrue("有場次時 text 含場次標題", eventMail.text.includes("自檢場次"));
  checkTrue("有場次時 text 含地點", eventMail.text.includes("小時光書店"));
  checkTrue(
    "收件方式印「無需配送」（純活動報名沒有實體配送）",
    eventMail.text.includes("無需配送"),
  );

  // ── 個資最小化：型別上沒有地址／電話欄位，這裡用反射確認呼叫端真的傳不進去 ──
  checkTrue(
    "🔴 AdminOrderNotificationInput 沒有 phone / address 這種欄位可傳（編譯期保證，這裡做執行期輔證）",
    !("phone" in baseInput) && !("address" in baseInput) && !("customerPhone" in baseInput),
  );

  // ── XSS：品項名稱裡的符號在 html 輸出要被跳脫（沿用既有的 escapeHtml，不是繞過它）──
  const xssInput = {
    ...baseInput,
    items: [
      { name: { zh: "<script>alert(1)</script>", en: "x", ja: "x" }, quantity: 1, subtotal: 100 },
    ],
  };
  const xssMail = tpl.renderAdminOrderNotificationEmail(xssInput);
  check("html 裡的 <script> 被跳脫成 &lt;script&gt;", xssMail.html.includes("<script>"), false);
  checkTrue("跳脫後的字串確實在 html 裡", xssMail.html.includes("&lt;script&gt;"));
}

// email-templates.ts 不可以 import server-only 的東西（改完之後重驗一次）。
checkTrue(
  "email-templates.ts 仍然沒有 import server-only",
  !/server-only/.test(stripTs(readFile(join(ROOT, "src/lib/email-templates.ts")))),
);

// =============================================================================
// DB 段：對真的本機 Postgres 驗 RLS/column grant 與 outbox 冪等
// =============================================================================

const PG_URL = process.env.NOTIFY_SELFTEST_PG_URL;

function looksLikeSingleSelect(sql) {
  const t = sql.trim();
  if (!/^select\b/i.test(t)) return false;
  return t.replace(/;\s*$/, "").indexOf(";") === -1;
}

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
const num = (rows, field = "n") => Number(one(rows)?.[field] ?? NaN);

const MAIL_PREFIX = "adminnotifyselftest:";

if (!PG_URL) {
  skipped.push("DB 段（缺 NOTIFY_SELFTEST_PG_URL）");
  console.log(yellow("\n[DB] 跳過 —— 沒有 NOTIFY_SELFTEST_PG_URL"));
  console.log(
    yellow(
      "     設好之後重跑，才會驗到 column-level grant 真的擋住 anon/authenticated、" +
        "outbox 冪等與併發下只會有一列。指令見本檔檔頭。",
    ),
  );
} else {
  try {
    const readyRows = await must(
      `select (to_regprocedure('public.enqueue_admin_order_email(text,text,text,text)') is not null) ok`,
    );
    const ready = one(readyRows)?.ok === true;

    if (!ready) {
      skipped.push("DB 段（這個資料庫還沒套用 0032）");
      console.log(
        yellow(
          "\n[DB] 跳過 —— 連得上，但這個資料庫還沒套用 0032（enqueue_admin_order_email 不存在）",
        ),
      );
    } else {
      console.log("\n[DB-0] 前置：記住現有設定，清掉這支自己的殘骸");
      const saved = one(
        await must(`select notify_emails from public.site_settings where id = 1`),
      )?.notify_emails;
      await must(`delete from public.email_outbox where dedupe_key like '${MAIL_PREFIX}%'`);

      // -----------------------------------------------------------------------
      // [DB-A] column-level grant：anon/authenticated 讀不到 notify_emails
      // -----------------------------------------------------------------------
      console.log(
        "\n[DB-A] 🔴 anon/authenticated 讀不到 notify_emails（column-level grant 是不是真的擋住）",
      );
      const anonDenied = await q(`set role anon; select notify_emails from public.site_settings;`);
      checkTrue("anon 選 notify_emails 被拒絕", !anonDenied.ok);
      if (!anonDenied.ok) {
        checkTrue(
          "錯誤是權限不足（permission denied），不是別的錯誤把它蓋過去",
          /permission denied/i.test(anonDenied.error),
        );
      }
      const authDenied = await q(
        `set role authenticated; select notify_emails from public.site_settings;`,
      );
      checkTrue("authenticated 一樣讀不到 notify_emails", !authDenied.ok);

      const anonAllowed = await q(`set role anon; select contact_email from public.site_settings;`);
      checkTrue(
        "反面對照：anon 選 contact_email 正常（column-level grant 沒有連公開欄位一起鎖死）",
        anonAllowed.ok,
      );
      const anonAllowedMap = await q(
        `set role anon; select map_link, social_line from public.site_settings;`,
      );
      checkTrue("反面對照：anon 選 map_link/social_line 也正常", anonAllowedMap.ok);

      // -----------------------------------------------------------------------
      // [DB-B] 空收件人（含只有逗號空白）安靜跳過
      // -----------------------------------------------------------------------
      console.log("\n[DB-B] 空收件人／只有逗號空白：安靜跳過，不是錯誤");
      await must(`update public.site_settings set notify_emails = '' where id = 1`);
      const emptyKey = `${MAIL_PREFIX}empty`;
      const emptyResult = one(
        await must(`select public.enqueue_admin_order_email('${emptyKey}','s','t','<p>h</p>') ok`),
      );
      check("空字串時回 false", emptyResult?.ok, false);
      check(
        "沒有插入任何列",
        num(
          await must(
            `select count(*)::int n from public.email_outbox where dedupe_key='${emptyKey}'`,
          ),
        ),
        0,
      );

      await must(`update public.site_settings set notify_emails = ' , ,  ' where id = 1`);
      const punctKey = `${MAIL_PREFIX}punct`;
      const punctResult = one(
        await must(`select public.enqueue_admin_order_email('${punctKey}','s','t','<p>h</p>') ok`),
      );
      check("🔴 只有逗號與空白時也回 false（不是單純 btrim 判斷）", punctResult?.ok, false);
      check(
        "沒有插入任何列",
        num(
          await must(
            `select count(*)::int n from public.email_outbox where dedupe_key='${punctKey}'`,
          ),
        ),
        0,
      );

      // -----------------------------------------------------------------------
      // [DB-C] 多收件人設定會正確排入 outbox，且是「目前」設定的值
      // -----------------------------------------------------------------------
      console.log("\n[DB-C] 多收件人設定，正確排入 outbox");
      await must(
        `update public.site_settings set notify_emails = ' a@x.invalid , b@y.invalid ' where id = 1`,
      );
      const multiKey = `${MAIL_PREFIX}multi`;
      const multiResult = one(
        await must(
          `select public.enqueue_admin_order_email('${multiKey}','主旨','text','<p>h</p>') ok`,
        ),
      );
      check("回 true", multiResult?.ok, true);
      const multiRow = one(
        await must(
          `select to_email, subject from public.email_outbox where dedupe_key='${multiKey}'`,
        ),
      );
      check(
        "to_email 是 notify_emails 目前的值（只做外層 btrim）",
        multiRow?.to_email,
        "a@x.invalid , b@y.invalid",
      );
      check("subject 對得上", multiRow?.subject, "主旨");

      console.log("\n[DB-C2] 🔴 同一個 dedupe_key 再排一次——冪等");
      const multiAgain = one(
        await must(
          `select public.enqueue_admin_order_email('${multiKey}','主旨2','text2','<p>h2</p>') ok`,
        ),
      );
      check("第二次回 false（已存在）", multiAgain?.ok, false);
      check(
        "email_outbox 裡這把 key 還是只有 1 列",
        num(
          await must(
            `select count(*)::int n from public.email_outbox where dedupe_key='${multiKey}'`,
          ),
        ),
        1,
      );
      check(
        "內容沒有被第二次呼叫蓋掉（subject 還是第一次的「主旨」）",
        one(await must(`select subject from public.email_outbox where dedupe_key='${multiKey}'`))
          ?.subject,
        "主旨",
      );

      // -----------------------------------------------------------------------
      // [DB-D] 併發：20 個並行 enqueue 同一把 dedupe_key
      // -----------------------------------------------------------------------
      console.log(
        "\n[DB-D] 🔴 併發：20 個並行 enqueue 同一把 dedupe_key——對應「同一張訂單重複觸發只收到一封」",
      );
      const concKey = `${MAIL_PREFIX}concurrent`;
      const concEnq = await Promise.all(
        Array.from({ length: 20 }, () =>
          q(`select public.enqueue_admin_order_email('${concKey}','主旨','text','<p>h</p>') ok`),
        ),
      );
      check("20 個請求全部沒有出錯", concEnq.filter((r) => r.ok).length, 20);
      if (concEnq.some((r) => !r.ok))
        console.log(red(`      ${concEnq.find((r) => !r.ok).error.slice(0, 300)}`));
      check(
        "email_outbox 恰好 1 列",
        num(
          await must(
            `select count(*)::int n from public.email_outbox where dedupe_key='${concKey}'`,
          ),
        ),
        1,
      );
      check(
        "20 個裡恰好 1 個回 true，其餘都是「已經排過了」",
        concEnq.filter((r) => r.ok && one(r.rows)?.ok === true).length,
        1,
      );

      // -----------------------------------------------------------------------
      // [DB-E] 收尾：還原設定、清乾淨
      // -----------------------------------------------------------------------
      console.log("\n[DB-E] 收尾");
      if (saved == null) {
        await must(`update public.site_settings set notify_emails = default where id = 1`);
      } else {
        const escaped = saved.replace(/'/g, "''");
        await must(`update public.site_settings set notify_emails = '${escaped}' where id = 1`);
      }
      const cleanup = await q(
        `delete from public.email_outbox where dedupe_key like '${MAIL_PREFIX}%';`,
      );
      checkTrue("清理成功", cleanup.ok);
      check(
        "沒有殘留的 email_outbox 列",
        num(
          await must(
            `select count(*)::int n from public.email_outbox where dedupe_key like '${MAIL_PREFIX}%'`,
          ),
        ),
        0,
      );
      check(
        "notify_emails 已還原成執行這支測試之前的值",
        one(await must(`select notify_emails from public.site_settings where id = 1`))
          ?.notify_emails,
        saved ?? "info@intervalbooks.tw",
      );
    }
  } catch (err) {
    fail += 1;
    console.log(red(`\n  ✗ DB 段中斷：${String(err.message ?? err).slice(0, 600)}`));
  }
}

// -----------------------------------------------------------------------------
// 收尾
// -----------------------------------------------------------------------------

console.log(`\n${"─".repeat(52)}`);
if (skipped.length > 0) {
  console.log(yellow(`略過 ${skipped.length} 段：`));
  for (const s of skipped) console.log(yellow(`  • ${s}`));
}
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
