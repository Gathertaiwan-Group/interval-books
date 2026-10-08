#!/usr/bin/env node
/**
 * inventory-vendors-selftest.mjs —— 廠商、PII 治理、廠商自助入口（0019）的自檢
 *
 * 兩段，理由與另外三支進銷存自檢相同：沒有金鑰的機器上也要有意義。
 *
 *   [靜態] 讀 supabase/migrations/0019 與新增的 TypeScript 檔，守的是**設計不變量**：
 *          · 沒有任何一個 view 送得出完整的身分證字號／統編／銀行帳號
 *          · 完整值只有一個出口，而且它一定先寫 pii_access_log
 *          · pii_access_log 對所有 role 零 DML 權限，而且 UPDATE/DELETE 有 trigger
 *            擋（連 table owner 都擋），且**沒有留任何繞道開關**
 *          · 廠商可呼叫的每一支，簽名裡都沒有 vendor_id（DB、repo、server fn 三層）
 *          · 廠商送審的商品寫死 pending，不看 approval_settings
 *          · 四條外鍵從 SET NULL/CASCADE 改成 RESTRICT
 *          · inv_admin_vendors 那個六欄 view **一欄都沒有多**
 *          · inv 對 anon/authenticated 零 grant
 *          答案都寫在檔案裡。永遠會跑。
 *
 *   [實測] 對目標資料庫真的跑一輪：建兩家廠商 → 遮罩 → 讀敏感欄位並驗稽核紀錄 →
 *          稽核紀錄改不動也刪不掉 → 兩個入口帳號互打對方的 id → 送審一律 pending
 *          → 外鍵 RESTRICT → 全部刪掉並證明基準線一筆不差。
 *          需要 SUPABASE_ACCESS_TOKEN；沒有就整段 skip。
 *
 * ⚠️ 實測段會在**正式資料庫**建資料再刪掉。所有測試資料都帶固定前綴（見 MARK），
 *    開頭與結尾各清一次。
 *
 * ⚠️ pii_access_log **刪不掉**（那正是它的重點）。所以實測段寫進去的稽核紀錄會
 *    留在正式庫裡 —— 那是刻意的，也是唯一一種「測試資料不清乾淨」被允許的情況。
 *    收尾的基準線比對因此**不包含** pii_access_log 的列數，改成比對「這一輪多出
 *    來的筆數正好等於預期」。
 *
 * 執行：
 *   node scripts/inventory-vendors-selftest.mjs                         # 只跑靜態
 *   SUPABASE_ACCESS_TOKEN=sbp_… node scripts/inventory-vendors-selftest.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/inventory-vendors-selftest.mjs";

const MIG_0019 = join(ROOT, "supabase/migrations/0019_vendors_pii_portal.sql");
const MIG_0016 = join(ROOT, "supabase/migrations/0016_inventory_products_admin.sql");
const SRC_REPO = join(ROOT, "src/server/repos/inv-vendors.ts");
const SRC_FNS_ADMIN = join(ROOT, "src/lib/admin/fns/inv-vendors.ts");
const SRC_FNS_PORTAL = join(ROOT, "src/lib/admin/fns/vendor-portal.ts");
const SRC_VENDOR_AUTH = join(ROOT, "src/server/vendor-auth.ts");
const SRC_MIDDLEWARE = join(ROOT, "src/lib/admin/middleware.ts");
const SRC_AUTH = join(ROOT, "src/server/auth.ts");
const SRC_SESSION = join(ROOT, "src/server/session.ts");
const SRC_SCHEMAS = join(ROOT, "src/lib/admin/schemas.ts");
const SRC_STORAGE = join(ROOT, "src/server/storage.ts");
const SRC_TASKS = join(ROOT, "src/server/task-endpoints.ts");
const SRC_SHELL = join(ROOT, "src/routes/admin/_shell.tsx");

/** 測試資料的固定標記。刪除全靠它，所以要夠特別。 */
const MARK = "__invvendorselftest__";

// -----------------------------------------------------------------------------
// 迷你測試框架（與另外三支進銷存自檢逐字相同）
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function check(label, actual, expected, note) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
    if (note) console.log(red(`      ${note}`));
  }
}

const checkTrue = (label, value, note) => check(label, Boolean(value), true, note);

/** 把 `--` 註解整行拿掉，免得註解裡提到的字串讓斷言假性通過。 */
function strip(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/**
 * TypeScript 版的同一件事。
 *
 * 0019 與新的 TS 檔在註解裡**大量**引用來源與 v3 的錯誤寫法（`select('*')`、
 * `is_admin()`、`LIMIT 1`、`p_vendor_id`…）。用整檔 includes() 去斷言「這個字沒有
 * 出現」的話，**寫得越清楚的註解越會讓測試變紅**，那會逼下一個人去刪註解而不是
 * 去修程式。
 */
function stripTs(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
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
function read(path) {
  if (!existsSync(path)) {
    throw new Error(
      `selftest 讀不到檔案：${path}` +
        "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串 —— 回空字串會讓所有" +
        "「確認原始碼裡沒有 X」的否定斷言靜默通過。）",
    );
  }
  return readFileSync(path, "utf8");
}

// 守著 read() 自己：路徑打錯時它必須炸掉，而不是回空字串讓否定斷言靜默通過。
{
  const ghost = join(ROOT, "__selftest-missing-file-probe__");
  let thrown = null;
  try {
    read(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 read() 讀不到檔案時丟例外，訊息指出是哪個路徑（不是靜默回空字串）",
    thrown !== null && String(thrown.message).includes(ghost),
  );
}

/** 抓出 0019 裡某一支函式的本體（去掉註解）。整檔搜會被檔頭的說明汙染。 */
function fnBody(sql, name) {
  const re = new RegExp(
    `create or replace function ${name.replace(/\./g, "\\.")}\\s*\\([\\s\\S]*?\\n\\$\\$;`,
    "m",
  );
  const m = re.exec(sql);
  return m ? m[0] : "";
}

/** 抓出某個 view 的 select list（到 comment on view 為止）。 */
function viewBody(sql, name) {
  const start = sql.indexOf(`create or replace view ${name}`);
  if (start < 0) return "";
  const end = sql.indexOf(`comment on view ${name}`, start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end);
}

// -----------------------------------------------------------------------------
// [1] 檔案盤點，而且 0001–0018 一個都沒有被動過
// -----------------------------------------------------------------------------

console.log("\n[1] 檔案盤點");
check("0019 存在", existsSync(MIG_0019), true);

const MIG_DIR = join(ROOT, "supabase/migrations");
const migFiles = readdirSync(MIG_DIR);
for (let n = 1; n <= 18; n += 1) {
  const prefix = String(n).padStart(4, "0");
  check(
    `migration ${prefix} 仍在`,
    migFiles.some((f) => f.startsWith(`${prefix}_`)),
    true,
  );
}
// 0020 加了 public.event_registrations —— 這個專案第二張放 PII 的表。它**不動**
// pii_access_log 的 subject_table / reason CHECK，也不動 inv_vendor_sensitive()，
// 所以這支測試的斷言全部原樣成立。名單的明文揭露與 CSV 匯出（會用到 pii_access_log
// 的新 reason）留到 0021，那一期要回來重讀 §1 那幾條。
check(
  "0020 在（場次名額）",
  migFiles.some((f) => f.startsWith("0020_")),
  true,
);
check(
  "0021 在（名單 PII）",
  migFiles.some((f) => f.startsWith("0021_")),
  true,
);
// 0022（交易信 outbox 與付款通知）把人叫回來重讀 §1 第二次。答案是：**它完全
// 沒有碰 pii_access_log。** 這是刻意的決定，寫在 0022 檔頭 §0.5 —— 寄信需要地址，
// 但「系統為了寄信而使用地址」與「有人在查這個人的資料」不是同一件事（0019 §1.1
// 的線）。每寄一封提醒信就寫一列 log，三個月後那張表 99% 是機器寫的，
// 「有沒有人在亂查」這個唯一的用途就沒了。
//
// 所以 0022 改用另一個形狀：TypeScript 送進去的是 registration_id，地址由
// enqueue_registration_emails() 在資料庫裡 join —— 明文一步都沒有離開資料庫，
// 也就沒有「誰查閱了」這件事需要記。下面每一條關於 pii_access_log、
// inv_vendor_sensitive()、staff_permissions 與那個不可竄改 trigger 的斷言，
// 全部原樣成立。notify-selftest [2] 用兩條 grep 守著「0022 沒有出現
// pii_access_log 與 pii_log_access 這兩個字」。
check(
  "0022 在（交易信 outbox）",
  migFiles.some((f) => f.startsWith("0022_")),
  true,
);
// 0024 是黑貓 PAY 線上刷卡加的（見 supabase/migrations/0024_blackcat_payment.sql）。
// 它沒有碰進銷存的任何一張表，所以這一支測試的其他斷言原樣成立。
check(
  "0024 在（黑貓 PAY 金流欄位）",
  migFiles.some((f) => f.startsWith("0024_")),
  true,
);
// 0025_event_speaker.sql（活動掛講者：public.events.speaker_id -> public.artists.id）
// 是這一期加的。它只在 public.events 上加一欄與一個索引，**inv 的任何一張表、
// 任何一支函式都沒有被碰到**，也沒有任何 drop。下面的斷言全部原樣成立。
// 0025 自己的內容由 artists-selftest 驗。
check(
  "0025 在（活動掛講者）",
  migFiles.some((f) => f.startsWith("0025_")),
  true,
);
// 0026_event_product_link.sql（活動與商品的真連結：events.slug / events.image_key、
// products 對活動來源的唯一索引、admin_upsert_event_with_session()）是這一期加的。
// 它只碰 public.events / public.products / public.event_sessions，**inv 的任何一張表、
// 任何一支函式都沒有被碰到**，也沒有任何 drop。下面的斷言全部原樣成立。
// 0026 自己的內容由 event-product-selftest 驗。
check(
  "0026 在（活動與商品的真連結）",
  migFiles.some((f) => f.startsWith("0026_")),
  true,
);

// ── 0021 真的回來重讀 §1 了，而且它動了那兩條 CHECK ──────────────────────
//
// 上面那段註解要求 0021 回來重讀 §1。它照做了，而且**確實動了 §1**：
// subject_table 與 reason 兩條 CHECK 各多收兩個值（名單的揭露與匯出）。所以這裡
// 不能只寫一句「原樣成立」，要驗它動的方式是安全的。三條，各對應一個具體的破法：
//
//   1. 放寬 CHECK 不可以把 0019 的舊值弄丟 —— 掉一個 'tax_filing'，正式庫上所有
//      既有的報稅查閱紀錄都會讓那條 add constraint 失敗，migration 直接卡住。
//   2. **不可以 drop function pii_log_access** —— 0019 §1.4 那三行 revoke/grant 是
//      照著 (uuid, text, text, uuid, text, text[], text, text) 這串簽名寫的。改簽名
//      就得先 drop，而 drop 之後 0019 重跑會指向一個不存在的東西。
//   3. **不可以碰不可竄改的那道門** —— pii_access_log_immutable 的 trigger 與
//      「連 service_role 都 revoke」是 §1.3 的兩道門，少一道稽核軌跡就刪得掉。
const sql0021 = read(join(MIG_DIR, "0021_roster_pii.sql"));
const exec0021 = strip(sql0021);
checkTrue(
  "反空殼：0021 不是空檔（> 8000 字）",
  exec0021.length > 8000,
  `實際 ${exec0021.length} 字`,
);
checkTrue(
  "0021 放寬 subject_table 時沒有弄丟 0019 的兩個值",
  ["inv.vendors", "inv.vendor_bank_accounts"].every((t) => exec0021.includes(`'${t}'`)),
);
checkTrue(
  "0021 放寬 reason 時沒有弄丟 0019 的五種事由",
  ["reconciliation", "payment", "tax_filing", "vendor_enquiry", "self_service"].every((r) =>
    exec0021.includes(`'${r}'`),
  ),
);
checkTrue(
  "0021 沒有 drop function pii_log_access（簽名一動，0019 的 revoke/grant 就指空）",
  !/drop\s+function[^;]*pii_log_access/i.test(exec0021),
);
checkTrue(
  "0021 沒有重新定義 pii_log_access",
  !/create\s+or\s+replace\s+function\s+public\.pii_log_access/i.test(exec0021),
);
checkTrue(
  "0021 沒有碰 pii_access_log 的不可竄改 trigger",
  !/drop\s+trigger[^;]*pii_access_log_immutable/i.test(exec0021) &&
    !/pii_access_log_immutable\(\)/i.test(exec0021),
);
checkTrue(
  "0021 沒有把 pii_access_log 的直接 DML 權限發回去",
  !/grant[^;]*on\s+table\s+public\.pii_access_log/i.test(exec0021),
);
// 第九種權限：0021 放寬 staff_permissions 的 CHECK 時，八種舊值一個都不能掉。
checkTrue(
  "0021 放寬 staff_permissions 時沒有弄丟 inv.vendor.pii.read",
  /'inv\.vendor\.pii\.read'/.test(exec0021),
);
checkTrue(
  "0021 放寬 staff_permissions 時沒有弄丟七種 approve_*",
  [
    "approve_products",
    "approve_purchases",
    "approve_price_changes",
    "approve_vendors",
    "approve_combo_sets",
    "approve_stock_adjustments",
    "approve_inventory_adjustments",
  ].every((p) => exec0021.includes(`'${p}'`)),
);

const sql = read(MIG_0019);
const exec = strip(sql);
// 反空殼：先證明檔案真的有內容，否則下面每一條 includes() 都是假性結果。
checkTrue("0019 不是空檔（> 15000 字）", exec.length > 15000, `實際 ${exec.length} 字`);

for (const f of [
  SRC_REPO,
  SRC_FNS_ADMIN,
  SRC_FNS_PORTAL,
  SRC_VENDOR_AUTH,
  SRC_MIDDLEWARE,
  SRC_SCHEMAS,
  SRC_STORAGE,
]) {
  checkTrue(`${f.replace(ROOT + "/", "")} 存在`, existsSync(f));
}

// -----------------------------------------------------------------------------
// [2] 沒有任何一個 view 送得出完整號碼
// -----------------------------------------------------------------------------

console.log("\n[2] PII 遮罩：view 層送不出原值");

/** 五個原始欄位名。它們只准出現在 §4 的那一支函式與 §5 的寫入函式裡。 */
const RAW_PII = ["tax_id", "id_number", "foreign_id", "residence_permit_number", "account_number"];

const READ_VIEWS = [
  "public.inv_admin_vendor_list",
  "public.inv_admin_vendor_detail",
  "public.inv_admin_vendor_bank_accounts",
  "public.inv_admin_vendor_contacts",
  "public.inv_admin_vendor_attachments",
  "public.inv_admin_vendor_submissions",
  "public.inv_admin_artists",
];

for (const view of READ_VIEWS) {
  const body = viewBody(exec, view);
  checkTrue(`${view} 有定義`, body.length > 50);
  for (const col of RAW_PII) {
    // 判準是**輸出欄位**，不是「這個字有沒有出現」：leak 的形狀是
    // `v.tax_id as tax_id`（原欄位直通）。被 inv.mask_tail() 包起來的、或只拿去做
    // `... is not null` 判斷的，後面接的不是 `as`，所以不會誤判。
    const passthrough = new RegExp(`\\b[a-z]\\.${col}\\s+as\\s`, "i");
    const hit = passthrough.exec(body);
    check(
      `${view} 沒有把 ${col} 原值當輸出欄位`,
      hit ? hit[0] : null,
      null,
      "leak 的形狀是「原欄位直通輸出」",
    );
  }
}

// 對照組：遮罩版**必須**在，否則上面那幾條就只是「把欄位整個拿掉」。
const listBody = viewBody(exec, "public.inv_admin_vendor_list");
checkTrue("對照組：list 有 tax_id_masked", /tax_id_masked/.test(listBody));
checkTrue("對照組：list 有 id_number_masked", /id_number_masked/.test(listBody));
const bankBody = viewBody(exec, "public.inv_admin_vendor_bank_accounts");
checkTrue("對照組：銀行帳戶有 account_number_masked", /account_number_masked/.test(bankBody));
checkTrue(
  "對照組：遮罩是在 SQL 裡做的（inv.mask_tail）",
  /inv\.mask_tail\(\s*b\.account_number/.test(bankBody),
  "來源是 select('*') 之後在瀏覽器 slice(0,3)+'***' —— 完整值早就到了",
);

// -----------------------------------------------------------------------------
// [3] 0016 的六欄 view 一欄都沒有多
// -----------------------------------------------------------------------------

console.log("\n[3] inv_admin_vendors 仍然只有六欄（4c 交接第一件）");

const mig0016 = strip(read(MIG_0016));
const view0016 = viewBody(mig0016, "public.inv_admin_vendors");
checkTrue("0016 的 inv_admin_vendors 還在", view0016.length > 50);
for (const col of RAW_PII) {
  checkTrue(`inv_admin_vendors 仍然沒有 ${col}`, !new RegExp(`\\b${col}\\b`).test(view0016));
}
checkTrue(
  "0019 沒有重新定義 inv_admin_vendors（依用途各開一個 view，不擴充舊的）",
  !/create or replace view public\.inv_admin_vendors\b/.test(exec),
);

// -----------------------------------------------------------------------------
// [4] 稽核軌跡
// -----------------------------------------------------------------------------

console.log("\n[4] pii_access_log：append-only 且沒有繞道");

checkTrue(
  "有建 public.pii_access_log",
  /create table if not exists public\.pii_access_log/.test(exec),
);
checkTrue(
  "連 service_role 的直接 DML 權限都 revoke 掉",
  /revoke all on table public\.pii_access_log from service_role/.test(exec),
  "表對所有 role 零權限，寫入只能經 pii_log_access()",
);
checkTrue(
  "anon / authenticated 也 revoke",
  /revoke all on table public\.pii_access_log from anon, authenticated/.test(exec),
);
checkTrue("RLS 有開", /alter table public\.pii_access_log enable row level security/.test(exec));

const immutable = fnBody(exec, "public.pii_access_log_immutable");
checkTrue("有 immutability trigger 函式", immutable.length > 50);
checkTrue("它無條件 RAISE（沒有 IF 分支可以走過去）", !/\bIF\b/i.test(immutable));
checkTrue(
  "沒有任何 current_setting 的繞道開關",
  !/current_setting/i.test(immutable),
  "留一個開關等於留一把任何拿得到 service_role 的人都撿得到的鑰匙",
);
checkTrue(
  "UPDATE 與 DELETE 都掛上 trigger",
  /create trigger pii_access_log_immutable\s+before update or delete on public\.pii_access_log/.test(
    exec,
  ),
);
checkTrue("TRUNCATE 也掛上", /before truncate on public\.pii_access_log/.test(exec));

// 稽核軌跡的 view 只有 select，沒有任何寫入 grant。
checkTrue(
  "inv_admin_pii_access_log 只 grant select",
  /grant\s+select on public\.inv_admin_pii_access_log to service_role/.test(exec) &&
    !/grant all on public\.inv_admin_pii_access_log/.test(exec),
);

// -----------------------------------------------------------------------------
// [5] 完整值只有一個出口，而且它一定先留痕
// -----------------------------------------------------------------------------

console.log("\n[5] inv_vendor_sensitive：讀成功 ⇔ 有紀錄");

const sensitive = fnBody(exec, "public.inv_vendor_sensitive");
checkTrue("有 inv_vendor_sensitive", sensitive.length > 500);
checkTrue(
  "它呼叫 pii_log_access()",
  /public\.pii_log_access\(/.test(sensitive),
  "0019 §4.1：先寫紀錄再組值，同一個交易 —— 讀成功⇔有紀錄",
);

// log 的呼叫要在第一個 v_result 組裝之前。用字串位置比對。
const logAt = sensitive.indexOf("v_log_id := public.pii_log_access(");
const firstValueAt = sensitive.indexOf("v_result := v_result ||");
checkTrue("有 v_log_id := public.pii_log_access(...)", logAt > 0);
checkTrue(
  "留痕寫在組值之前",
  logAt > 0 && firstValueAt > logAt,
  "順序在同一個交易裡不影響結果，但寫在前面讓「一定會 log」讀第一眼就看得出來",
);

checkTrue("欄位是白名單（v_allowed）", /v_allowed\s+text\[\]\s*:=\s*array\[/.test(sensitive));
checkTrue(
  "白名單裡沒有 '*' 或 'all'",
  !/'\*'/.test(sensitive) && !/'all'/.test(sensitive),
  "想一次看全部就得把五個名字都列出來，稽核紀錄才會長成該有的形狀",
);
checkTrue(
  "白名單五個欄位齊全",
  ["'tax_id'", "'id_number'", "'foreign_id'", "'residence_permit_number'", "'bank_accounts'"].every(
    (f) => sensitive.includes(f),
  ),
);
checkTrue("銀行帳號另外記一筆 subject_table", /'inv\.vendor_bank_accounts'/.test(sensitive));

// 對照組：這是**唯一**一支會回傳原值的 public 函式。
const rawReturners = [...exec.matchAll(/create or replace function (public\.[a-z_]+)\s*\(/g)]
  .map((m) => m[1])
  .filter((name) => {
    const body = fnBody(exec, name);
    // 「回傳」的判準：把原始欄位放進 jsonb_build_object / RETURN QUERY 的 select list
    return /jsonb_build_object\([^)]*'(tax_id|id_number|foreign_id|residence_permit_number|account_number)'/s.test(
      body,
    );
  });
check(
  "整份 0019 裡只有一支函式會把原值放進回傳值",
  rawReturners.join(","),
  "public.inv_vendor_sensitive",
  "多一條不留痕的路，稽核軌跡就等於沒有",
);

// -----------------------------------------------------------------------------
// [6] 廠商自助入口：三層都沒有 vendor_id 這個參數
// -----------------------------------------------------------------------------

console.log("\n[6] 跨廠商隔離：vendor_id 只能從 session 推導");

const VENDOR_FNS = [
  "public.inv_vendor_profile",
  "public.inv_vendor_products",
  "public.inv_vendor_submit_product",
  "public.inv_vendor_withdraw_product",
];

for (const name of VENDOR_FNS) {
  const body = fnBody(exec, name);
  checkTrue(`${name} 有定義`, body.length > 100);
  // 只看簽名那一段（到第一個 `)` 為止的參數列）
  const sig = body.slice(0, body.indexOf("\n)") > 0 ? body.indexOf("\n)") : body.indexOf(")"));
  checkTrue(
    `${name} 的簽名沒有 p_vendor_id`,
    !/p_vendor_id/.test(sig),
    "不是「我們有檢查」，是那個參數不存在",
  );
  checkTrue(
    `${name} 用 vendor_my_id(p_user_id) 推導`,
    /public\.vendor_my_id\(p_user_id\)/.test(body),
  );
}

const myId = fnBody(exec, "public.vendor_my_id");
checkTrue("vendor_my_id 有定義", myId.length > 100);
checkTrue(
  "vendor_my_id 沒有 LIMIT 1（v3 洞二的修法）",
  !/limit\s+1/i.test(myId),
  "vendor_users 的主鍵就是 user_id，一個帳號結構上只會有一列",
);
checkTrue(
  "vendor_users 的主鍵是 user_id（結構上一個帳號只能對到一家）",
  /user_id\s+uuid\s+primary key references auth\.users/.test(exec),
);
checkTrue(
  "vendor_users 沒有 role 欄位（身分與權限分開，v3 洞一的成因）",
  !/create table if not exists public\.vendor_users[\s\S]{0,600}?\brole\s+text/.test(exec),
);
checkTrue(
  "vendor_my_id 同時檢查 is_active / status / approval_status",
  /u\.is_active/.test(myId) &&
    /v\.status\s*=\s*'active'/.test(myId) &&
    /v\.approval_status\s*=\s*'approved'/.test(myId),
);

// server fn 那一層
const portal = read(SRC_FNS_PORTAL);
const portalCode = stripTs(portal);
checkTrue("vendor-portal.ts 存在且有內容", portalCode.length > 1000);
checkTrue(
  "vendor-portal.ts 的 inputValidator 沒有任何 vendorId 欄位",
  !/inputValidator\([\s\S]{0,600}?vendorId/.test(portalCode),
  "過濾用的 vendor_id 一律來自 session（context.vendor.vendorId）",
);
checkTrue("對照組：它確實從 context.vendor 拿 userId", /context\.vendor\.userId/.test(portalCode));
checkTrue(
  "每一支（除登入/登出/guard 外）都掛 vendorFnMiddleware",
  (portalCode.match(/vendorFnMiddleware\(\)/g) ?? []).length >= 5,
);

// UI 那一層 —— 拿不到 vendorId 就沒得傳
const vendorShell = read(join(ROOT, "src/routes/vendor/_shell.tsx"));
const vendorShellCode = stripTs(vendorShell);
checkTrue("廠商入口的 _shell.tsx 存在", vendorShell.length > 500);
checkTrue(
  "beforeLoad 回傳的 route context 不含 vendorId",
  !/vendorId/.test(
    vendorShellCode.slice(
      vendorShellCode.indexOf("beforeLoad"),
      vendorShellCode.indexOf("component:"),
    ),
  ),
  "context 裡有它，遲早有人會順手塞進某一支 payload —— UI 拿不到就沒得傳",
);
checkTrue(
  "三種 guard 狀態各自導去不同的地方",
  /signed_out[\s\S]{0,120}?\/vendor\/login/.test(vendorShellCode) &&
    /unlinked[\s\S]{0,120}?\/vendor\/pending/.test(vendorShellCode),
  "把 unlinked 併進 signed_out，廠商會被丟回登入頁然後一直重打對的密碼",
);
checkTrue("_shell.tsx 檔頭寫明 beforeLoad 不是安全邊界", /不是安全邊界/.test(vendorShell));

for (const f of ["_shell.index.tsx", "_shell.products.tsx"]) {
  const page = stripTs(read(join(ROOT, "src/routes/vendor", f)));
  checkTrue(`routes/vendor/${f} 沒有出現 vendorId`, !/vendorId/.test(page));
}
const portalForm = stripTs(read(join(ROOT, "src/components/vendor/VendorProductFormDialog.tsx")));
checkTrue("廠商送審表單存在", portalForm.length > 500);
for (const forbidden of ["vendor_id", "approval_status", "stock_quantity", "cost_price"]) {
  checkTrue(`廠商送審表單送不出 ${forbidden}`, !new RegExp(`${forbidden}:`).test(portalForm));
}

// repo 那一層
const repo = read(SRC_REPO);
const repoCode = stripTs(repo);
checkTrue(
  "repo 的 vendorPortal* 系列只收 userId",
  !/vendorPortal(Profile|Products|SubmitProduct|WithdrawProduct)[\s\S]{0,300}?vendorId/.test(
    repoCode,
  ),
);

// -----------------------------------------------------------------------------
// [7] repo 層：禁止 select *
// -----------------------------------------------------------------------------

console.log("\n[7] repo 層：一律列明欄位");

checkTrue(
  'repos/inv-vendors.ts 沒有 select("*")',
  !/\.select\(\s*["'`]\*/.test(repoCode),
  "來源 VendorManagement.tsx:73 是 select('*')，然後在畫面上補一句 slice(0,3)+'***'",
);
for (const constant of [
  "LIST_COLUMNS",
  "DETAIL_COLUMNS",
  "CONTACT_COLUMNS",
  "BANK_COLUMNS",
  "ATTACHMENT_COLUMNS",
  "PII_LOG_COLUMNS",
]) {
  checkTrue(`具名欄位常數 ${constant} 存在`, new RegExp(`const ${constant}\\s*=`).test(repoCode));
}
checkTrue(
  "治理規則寫在檔頭（下一個人打開就看得到）",
  /一律列明欄位，禁止 select \*/.test(repo) &&
    /readVendorSensitive\(\)/.test(repo) &&
    /vendor_id 只從 session 來/.test(repo),
);
checkTrue(
  "檔頭有寫「不要加第二支讀原值的函式」",
  /不要.{0,10}在這個檔案裡加第二支讀原值的函式/.test(repo),
);
checkTrue(
  "搜尋不含任何識別碼欄位（避免做出一個號碼預言機）",
  !/or\(`?[^`]*tax_id\.ilike/.test(repoCode) && !/id_number\.ilike/.test(repoCode),
);

// -----------------------------------------------------------------------------
// [8] 授權：pii.read、稽核軌跡要 admin、adminFnMiddleware 沒被動
// -----------------------------------------------------------------------------

console.log("\n[8] 授權矩陣");

const fnsAdmin = read(SRC_FNS_ADMIN);
const fnsAdminCode = stripTs(fnsAdmin);
const middleware = read(SRC_MIDDLEWARE);
const middlewareCode = stripTs(middleware);
const auth = read(SRC_AUTH);

checkTrue(
  "staff_permissions 的 CHECK 收了 inv.vendor.pii.read",
  /'inv\.vendor\.pii\.read'/.test(exec),
);
checkTrue(
  "auth.ts 的 STAFF_PERMISSIONS 也有（兩邊逐字對齊）",
  /"inv\.vendor\.pii\.read"/.test(stripTs(auth)),
);
checkTrue(
  "0019 沒有把原本七種 approve_* 弄丟",
  [
    "approve_products",
    "approve_purchases",
    "approve_price_changes",
    "approve_vendors",
    "approve_combo_sets",
    "approve_stock_adjustments",
    "approve_inventory_adjustments",
  ].every((p) => exec.includes(`'${p}'`)),
);

checkTrue(
  "readVendorSensitive 要求 inv.vendor.pii.read",
  /requirePermission\(\s*context\.staff\.permissions,\s*"inv\.vendor\.pii\.read"/.test(
    fnsAdminCode,
  ),
);
checkTrue(
  "而且權限是從 context 重讀的，不是前端送的",
  /context\.staff\.permissions/.test(fnsAdminCode) && !/data\.permissions/.test(fnsAdminCode),
);
checkTrue(
  "店員不能用 self_service 當查閱事由",
  /data\.reason === "self_service"/.test(fnsAdminCode),
);
checkTrue(
  "稽核軌跡要 adminFnMiddleware，不是 staff + pii.read",
  /listPiiAccessLog[\s\S]{0,200}?middleware\(\[adminFnMiddleware\]\)/.test(fnsAdminCode),
  "看得到別人的查閱紀錄跟看得到廠商資料是兩種權限",
);
checkTrue(
  "入口帳號管理要 adminFnMiddleware",
  /setVendorPortalAccountActive[\s\S]{0,200}?middleware\(\[adminFnMiddleware\]\)/.test(
    fnsAdminCode,
  ),
);
checkTrue("approveVendor 要 approve_vendors", /"approve_vendors"/.test(fnsAdminCode));
checkTrue("approveVendorSubmission 要 approve_products", /"approve_products"/.test(fnsAdminCode));

// adminFnMiddleware 一個字都沒有被動
checkTrue(
  "adminFnMiddleware 的定義沒有被改（仍然是 requireAdmin()）",
  /export const adminFnMiddleware = createMiddleware\(\{ type: "function" \}\)\.server\([\s\S]{0,300}?requireAdmin\(\)/.test(
    middlewareCode,
  ),
);
checkTrue("有 vendorFnMiddleware", /export function vendorFnMiddleware\(\)/.test(middlewareCode));
checkTrue("vendorFnMiddleware 走 requireVendor()", /requireVendor\(\)/.test(middlewareCode));

// cookie 名字必須不同
const vendorAuth = read(SRC_VENDOR_AUTH);
const session = read(SRC_SESSION);
checkTrue('後台 cookie 是 "ib_admin"', /name:\s*"ib_admin"/.test(session));
checkTrue('廠商 cookie 是 "ib_vendor"', /name:\s*"ib_vendor"/.test(vendorAuth));
checkTrue("廠商 session 另外驗一個 kind='vendor'", /kind !== "vendor"/.test(stripTs(vendorAuth)));
checkTrue(
  "requireVendor 每次都重讀 profiles（cookie 是身分，權限每次重問）",
  /export async function requireVendor[\s\S]{0,600}?loadVendorProfile\(session\.userId\)/.test(
    stripTs(vendorAuth),
  ),
);

// -----------------------------------------------------------------------------
// [9] 廠商送審一律 pending
// -----------------------------------------------------------------------------

console.log("\n[9] 廠商送審不看 approval_settings（4c 交接第二件）");

const submit = fnBody(exec, "public.inv_vendor_submit_product");
checkTrue("inv_vendor_submit_product 有定義", submit.length > 500);
checkTrue(
  "approval_status 寫死 'pending'",
  /'pending',\s*$/m.test(submit) || /'pending'/.test(submit),
);
checkTrue(
  "它**不呼叫** inv.initial_approval_status()",
  !/inv\.initial_approval_status\(/.test(submit),
  "approval_settings 回答的是「我信不信我自己的店員」，跟外部投稿無關",
);
checkTrue("product_type 寫死 consignment（不從 payload 拿）", /'consignment',/.test(submit));
checkTrue("submitted_via 寫死 vendor_portal", /'vendor_portal'/.test(submit));
checkTrue(
  "編輯時的 WHERE 有 vendor_id + pending + vendor_portal 三個條件",
  /vendor_id = v_vendor_id[\s\S]{0,200}?submitted_via = 'vendor_portal'[\s\S]{0,120}?approval_status = 'pending'/.test(
    submit,
  ),
);

// 對照組：店員那一支**仍然**走 initial_approval_status（沒有被順手改掉）
const saveProduct = fnBody(strip(read(MIG_0016)), "public.inv_save_product");
checkTrue(
  "對照組：店員建商品仍走 inv.initial_approval_status('products')",
  /initial_approval_status\('products'\)/.test(saveProduct),
);

checkTrue(
  "submitted_via 有 CHECK",
  /check \(submitted_via in \('staff', 'vendor_portal'\)\)/.test(exec),
);

// -----------------------------------------------------------------------------
// [10] 四條外鍵（4c 交接第三、四件）
// -----------------------------------------------------------------------------

console.log("\n[10] 外鍵：從「安靜地弄壞」改成「擋下來」");

const FK_RESTRICT = [
  ["inv.sales", "sales_product_id_fkey", "inv.products"],
  ["inv.combo_set_items", "combo_set_items_product_id_fkey", "inv.products"],
  ["inv.products", "products_vendor_id_fkey", "inv.vendors"],
  ["inv.purchases", "purchases_vendor_id_fkey", "inv.vendors"],
];

for (const [table, name, target] of FK_RESTRICT) {
  const re = new RegExp(
    `add constraint ${name}\\s+foreign key \\([a-z_]+\\) references ${target.replace(
      ".",
      "\\.",
    )} \\(id\\) on delete restrict`,
    "i",
  );
  checkTrue(`${table}.${name} 改成 RESTRICT`, re.test(exec));
  checkTrue(
    `${name} 先 drop 再 add（不改既有 migration）`,
    new RegExp(`alter table ${table.replace(".", "\\.")} drop constraint if exists ${name}`).test(
      exec,
    ),
  );
}

// §6.5：0016 的 inv_delete_product 沒有擋套餐（在 CASCADE 的年代不需要擋）。
// 改成 RESTRICT 之後不補這一段，店員會看到一句英文的 23503。
const delProduct = fnBody(exec, "public.inv_delete_product");
checkTrue("0019 有重寫 inv_delete_product", delProduct.length > 500);
checkTrue(
  "它補上了套餐檢查",
  /PRODUCT_IN_COMBO/.test(delProduct) && /inv\.combo_set_items/.test(delProduct),
);
checkTrue("而且訊息裡列得出是哪一個套餐", /string_agg\(cs\.name/.test(delProduct));
for (const kept of ["PRODUCT_HAS_SALES", "PRODUCT_IS_LISTED", "PRODUCT_NOT_FOUND"]) {
  checkTrue(`對照組：0016 原本的 ${kept} 一個字都沒有放寬`, delProduct.includes(kept));
}

checkTrue(
  "刻意沒動的兩條有寫下來（purchases.product_id / base_product_id）",
  /purchases\.product_id 維持 CASCADE/.test(sql) &&
    /products\.base_product_id 維持 SET NULL/.test(sql),
);

const deleteVendor = fnBody(exec, "public.inv_delete_vendor");
checkTrue("inv_delete_vendor 有定義", deleteVendor.length > 300);
checkTrue(
  "它會擋下有商品／進貨／退貨單／入口帳號的廠商",
  /VENDOR_IN_USE/.test(deleteVendor) &&
    /v_products > 0 OR v_purchases > 0 OR v_returns > 0 OR v_portal > 0/.test(deleteVendor),
);
checkTrue("而且訊息裡有數量與正確做法", /解約請把往來狀態改成/.test(deleteVendor));

// -----------------------------------------------------------------------------
// [11] 唯一性 index（來源靠前端兩步 UPDATE 維持）
// -----------------------------------------------------------------------------

console.log("\n[11] is_default / is_primary / is_current 的唯一性");

checkTrue(
  "匯款帳戶：一家只能有一個預設",
  /create unique index if not exists vendor_bank_accounts_one_default_idx[\s\S]{0,120}?where is_default/.test(
    exec,
  ),
);
checkTrue(
  "聯絡人：一家只能有一個主要窗口",
  /create unique index if not exists vendor_contacts_one_primary_idx[\s\S]{0,120}?where is_primary/.test(
    exec,
  ),
);
checkTrue(
  "合約：一家只能有一份現行合約",
  /create unique index if not exists vendor_attachments_one_current_contract_idx/.test(exec),
);
checkTrue(
  "建 index 之前先正規化既有資料（否則 index 建不起來）",
  /update inv\.vendor_bank_accounts b\s*\n\s*set is_default = false/.test(exec),
);

// -----------------------------------------------------------------------------
// [12] v3 artists 併入
// -----------------------------------------------------------------------------

console.log("\n[12] v3 artists：三個洞都不存在");

checkTrue("有建 public.artists", /create table if not exists public\.artists/.test(exec));
checkTrue(
  "artists.vendor_id 是 UNIQUE（v3 洞二的修法）",
  /vendor_id\s+uuid unique references inv\.vendors/.test(exec),
);
const artistsDdl = (() => {
  const i = exec.indexOf("create table if not exists public.artists");
  return i < 0 ? "" : exec.slice(i, exec.indexOf("\n);", i));
})();
checkTrue("artists 的 CREATE TABLE 抓得到", artistsDdl.length > 200);
checkTrue("artists 沒有 user_id 欄位（身分對照在 vendor_users）", !/\buser_id\b/.test(artistsDdl));
checkTrue(
  "artist_products 沒有被建出來（已廢除）",
  !/create table[\s\S]{0,40}artist_products/i.test(exec),
);
checkTrue(
  "artists 對 anon 只有 select",
  /grant\s+select on table public\.artists to anon, authenticated/.test(exec) &&
    !/grant all on table public\.artists to anon/.test(exec),
);
checkTrue(
  "三條 RESTRICTIVE deny（v3 洞三：PERMISSIVE 是 OR 合併，擋不住）",
  /as restrictive for insert to anon, authenticated with check \(false\)/.test(exec) &&
    /as restrictive for update to anon, authenticated using \(false\)/.test(exec) &&
    /as restrictive for delete to anon, authenticated using \(false\)/.test(exec),
);
checkTrue(
  "整份 0019 沒有任何 `USING (is_admin())` 這種全表 policy",
  !/using\s*\(\s*[a-z_.]*is_admin\(\)\s*\)/i.test(exec),
  "v3 的 admin_all 就是這個形狀，而它蓋過了所有 owner-scoped policy",
);

// -----------------------------------------------------------------------------
// [13] 私有 bucket 與保留期限（4c 交接第五件）
// -----------------------------------------------------------------------------

console.log("\n[13] vendor-attachments 與 ocr-scans 的保留期限");

checkTrue(
  "vendor-attachments 是 private",
  /'vendor-attachments',\s*\n?\s*'vendor-attachments',\s*\n?\s*false/.test(exec),
);
checkTrue(
  "而且 do update 也把 public 釘回 false",
  /on conflict \(id\) do update[\s\S]{0,200}?set public\s*=\s*false/.test(exec),
);
checkTrue(
  "補上 allowed_mime_types（來源只在瀏覽器擋副檔名）",
  /array\['application\/pdf', 'image\/jpeg', 'image\/png', 'image\/webp'\]/.test(exec),
);

const storage = read(SRC_STORAGE);
const storageCode = stripTs(storage);
checkTrue(
  "storage.ts 沒有給 vendor-attachments 產永久網址",
  !/public\/\$\{VENDOR_ATTACHMENTS_BUCKET\}/.test(storageCode) &&
    !/publicUrlFor[A-Za-z]*Attachment/.test(storageCode),
);
checkTrue(
  "只有 createSignedUrl",
  /signedVendorAttachmentUrl[\s\S]{0,400}?createSignedUrl/.test(storageCode),
);
checkTrue(
  "簽名有效期比 OCR 短",
  /VENDOR_ATTACHMENT_SIGNED_URL_SECONDS = 5 \* 60/.test(storageCode),
);
checkTrue(
  "附件路徑有形狀驗證（路徑穿越防線）",
  /vendorAttachmentObjectName[\s\S]{0,400}?\/\^\[0-9a-f-\]\{36\}\\\//.test(storageCode),
);
checkTrue(
  "上傳只看 magic bytes，不信 file.type",
  /sniffAttachmentFormat\(bytes\)/.test(storageCode),
);

checkTrue(
  "ocr-scans 有保留天數政策（寫在資料庫）",
  /create or replace function public\.ocr_scan_retention_days/.test(exec),
);
const tasks = stripTs(read(SRC_TASKS));
checkTrue("有 purge-scans 的排程入口", /PURGE_SCANS_TASK_PATH/.test(tasks));
checkTrue("而且有密鑰閘門", /secretMatches\(url\.searchParams\.get\("k"\), secret\)/.test(tasks));
checkTrue("有 dry-run", /searchParams\.get\("dry"\)/.test(tasks));
checkTrue(
  "vendor-attachments 刻意不自動清理，理由有寫下來",
  /vendor-attachments 不在這裡，而且刻意不做自動清理/.test(read(SRC_TASKS)),
);

// -----------------------------------------------------------------------------
// [14] zod 鏡射 DB 的 CHECK
// -----------------------------------------------------------------------------

console.log("\n[14] schemas.ts 鏡射 DB 的 CHECK");

const schemas = read(SRC_SCHEMAS);
const schemasCode = stripTs(schemas);

const ENUM_MIRRORS = [
  [
    "VENDOR_ENTITY_TYPES",
    ["domestic_company", "domestic_individual", "foreign", "foreign_individual"],
  ],
  ["VENDOR_STATUSES", ["active", "suspended", "inactive"]],
  [
    "VENDOR_VOUCHER_CATEGORIES",
    ["invoice", "receipt", "official_document", "labor_payment", "none"],
  ],
  ["VENDOR_EINVOICE_TYPES", ["none", "b2b", "b2c"]],
  ["VENDOR_PAYMENT_TERMS", ["immediate", "monthly", "negotiated"]],
  ["VENDOR_SETTLEMENT_TYPES", ["invoice_date", "end_of_month", "monthly"]],
];

const mig0009 = read(join(ROOT, "supabase/migrations/0009_inventory_schema.sql"));
for (const [name, values] of ENUM_MIRRORS) {
  const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(schemasCode);
  const got = m ? [...m[1].matchAll(/"([a-z_0-9]+)"/g)].map((x) => x[1]) : [];
  check(`${name} 與 DB 的 CHECK 一致`, got.join(","), values.join(","));
  // 而且那些值真的在 0009 的 CHECK 裡
  for (const v of values) {
    checkTrue(`  ${v} 出現在 0009 的 CHECK 裡`, mig0009.includes(`'${v}'`));
  }
}

checkTrue(
  "vendorSchema 沒有 approval_status",
  !/approval_status/.test(
    schemasCode.slice(
      schemasCode.indexOf("export const vendorSchema"),
      schemasCode.indexOf("export const vendorFilterSchema"),
    ),
  ),
);
for (const forbidden of ["approved_by", "created_by", "vendor_code"]) {
  checkTrue(
    `vendorSchema 沒有 ${forbidden}`,
    !new RegExp(`\\b${forbidden}\\b`).test(
      schemasCode.slice(
        schemasCode.indexOf("export const vendorSchema"),
        schemasCode.indexOf("export const vendorFilterSchema"),
      ),
    ),
  );
}

const submitSchema = schemasCode.slice(
  schemasCode.indexOf("export const vendorProductSubmitSchema"),
  schemasCode.indexOf("export type VendorProductSubmitValues"),
);
for (const forbidden of [
  "approval_status",
  "vendor_id",
  "stock_quantity",
  "cost_price",
  "product_type",
]) {
  checkTrue(`vendorProductSubmitSchema 沒有 ${forbidden}`, !submitSchema.includes(forbidden));
}

// 編譯期的 PII 型別斷言。它靠 tsc 生效，這裡只確認**它還在、而且還有牙齒** ——
// 檔案被刪掉或斷言被註解掉的話，tsc 會繼續是綠的，沒有任何東西會叫。
const piiTypes = read(join(ROOT, "src/server/repos/inv-vendors.pii-types.ts"));
checkTrue("inv-vendors.pii-types.ts 存在", piiTypes.length > 500);
const piiTypesCode = stripTs(piiTypes);
checkTrue("它偵測 any（IsAny）", /type IsAny<T> = 0 extends 1 & T/.test(piiTypesCode));
for (const [label, expr] of [
  ["AdminVendorDetail 沒有 tax_id", 'AssertFalse<HasKey<AdminVendorDetail, "tax_id">>'],
  ["AdminVendorDetail 沒有 id_number", 'AssertFalse<HasKey<AdminVendorDetail, "id_number">>'],
  ["AdminVendorDetail 沒有 foreign_id", 'AssertFalse<HasKey<AdminVendorDetail, "foreign_id">>'],
  [
    "AdminVendorDetail 沒有 residence_permit_number",
    'AssertFalse<HasKey<AdminVendorDetail, "residence_permit_number">>',
  ],
  [
    "AdminVendorBankAccount 沒有 account_number",
    'AssertFalse<HasKey<AdminVendorBankAccount, "account_number">>',
  ],
  ["AdminVendorRow 沒有 tax_id", 'AssertFalse<HasKey<AdminVendorRow, "tax_id">>'],
  ["VendorPortalProduct 沒有 cost_price", 'AssertFalse<HasKey<VendorPortalProduct, "cost_price">>'],
]) {
  checkTrue(`型別斷言：${label}`, piiTypesCode.includes(expr));
}
// 對照組的對照組：少了這幾行，上面那些就只是在驗證「型別是空的」。
for (const positive of [
  'AssertTrue<HasKey<AdminVendorDetail, "tax_id_masked">>',
  'AssertTrue<HasKey<AdminVendorBankAccount, "account_number_masked">>',
]) {
  checkTrue(`型別斷言有對照組：${positive.slice(0, 46)}…`, piiTypesCode.includes(positive));
}
checkTrue(
  "沒有任何地方 import 它（不進 bundle，但 tsc 會檢查）",
  !/from "@\/server\/repos\/inv-vendors\.pii-types"/.test(
    read(join(ROOT, "src/server/repos/inv-vendors.ts")) +
      read(SRC_FNS_ADMIN) +
      read(SRC_FNS_PORTAL),
  ),
);

checkTrue(
  "費率 schema 上限是 1（0–1 的小數）",
  /max\(1, "費率不可超過 100%"\)/.test(schemasCode),
  "來源前端輸入百分比、存檔 ÷100，少除一次會存進 8.0（800%）而 DB 沒有 CHECK",
);
checkTrue("結算日 schema 是 1–31", /min\(1, "日期必須介於 1 與 31"\)/.test(schemasCode));
checkTrue("查閱事由是列舉不是自由文字", /export const PII_ACCESS_REASONS = \[/.test(schemasCode));
checkTrue(
  "PII 欄位白名單與 0019 §4 一致",
  ["tax_id", "id_number", "foreign_id", "residence_permit_number", "bank_accounts"].every((f) =>
    new RegExp(`"${f}"`).test(
      schemasCode.slice(schemasCode.indexOf("export const VENDOR_SENSITIVE_FIELDS")),
    ),
  ),
);

// -----------------------------------------------------------------------------
// [15] inv 對 anon / authenticated 零 grant，以及側欄不是授權
// -----------------------------------------------------------------------------

console.log("\n[15] grants 與側欄");

const newObjects = [
  "public.inv_admin_vendor_list",
  "public.inv_admin_vendor_detail",
  "public.inv_admin_vendor_contacts",
  "public.inv_admin_vendor_bank_accounts",
  "public.inv_admin_vendor_attachments",
  "public.inv_admin_vendor_categories",
  "public.inv_admin_tax_types",
  "public.inv_admin_withholding_categories",
  "public.inv_admin_vendor_submissions",
  "public.inv_admin_pii_access_log",
  "public.inv_admin_artists",
];
for (const obj of newObjects) {
  checkTrue(
    `${obj} 有 revoke anon/authenticated`,
    new RegExp(`revoke all\\s+on ${obj.replace(/\./g, "\\.")}\\s+from anon, authenticated`).test(
      exec,
    ),
    "Supabase 的 ALTER DEFAULT PRIVILEGES 讓新 view 一出生就是 ALL —— revoke 才是生效的那一半",
  );
}
checkTrue(
  "收尾再掃一次整個 inv schema",
  /revoke all on all tables\s+in schema inv from anon, authenticated/.test(exec) &&
    /revoke all on all functions in schema inv from anon, authenticated/.test(exec),
);

// 每一支新函式都要 revoke public / anon / authenticated
const publicFns = [...exec.matchAll(/create or replace function (public\.[a-z_]+)\s*\(/g)].map(
  (m) => m[1],
);
const uniqueFns = [...new Set(publicFns)];
checkTrue(`0019 建了 ${uniqueFns.length} 支 public 函式`, uniqueFns.length >= 10);
for (const fn of uniqueFns) {
  const short = fn.replace("public.", "");
  const revoked =
    new RegExp(`revoke execute on function ${fn.replace(/\./g, "\\.")}\\b`).test(exec) ||
    new RegExp(`'${fn.replace(/\./g, "\\.")}\\(`).test(exec); // 走 do $grants$ 迴圈的
  checkTrue(`${short} 有 revoke/grant 處理`, revoked);
}

const shell = read(SRC_SHELL);
checkTrue(
  "側欄有「廠商」且 staff: true",
  /to:\s*"\/admin\/inventory-vendors",[^{}]*label:\s*"廠商",[^{}]*staff:\s*true/.test(shell),
);
checkTrue(
  "_shell.tsx 沒有被改成用 approve_* 或 pii.read 做側欄過濾",
  !/inv\.vendor\.pii\.read/.test(stripTs(shell)) && !/approve_vendors/.test(stripTs(shell)),
  "側欄把模組藏起來不是授權。真正的擋在每一支 server fn 的 middleware",
);

// -----------------------------------------------------------------------------
// [16]–[20] 實測
// -----------------------------------------------------------------------------

const REF = process.env.SUPABASE_PROJECT_REF ?? "noijrmhdfbfvjyvchvzj";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

async function q(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: text, rows: [] };
  try {
    return { ok: true, error: null, rows: JSON.parse(text) };
  } catch {
    return { ok: true, error: null, rows: [] };
  }
}

/**
 * 清乾淨。
 *
 * ⚠️ 順序不能換：§6 之後 sales / combo_set_items / products / purchases 對
 *    products 與 vendors 都是 RESTRICT，倒過來一定被擋。
 * ⚠️ vendor_users 要在 vendors 之前刪（vendor_users_vendor_id_fkey 也是 RESTRICT）。
 * ⚠️ pii_access_log **不刪，也刪不掉**。那是它的重點。
 */
async function cleanup() {
  const vids = `(select id from inv.vendors where name like '${MARK}%')`;
  const pids = `(select id from inv.products where name like '${MARK}%')`;
  await q(`delete from inv.sales where product_id in ${pids};`);
  await q(`delete from inv.combo_set_items where product_id in ${pids};`);
  await q(`update inv.purchases set remaining_quantity = quantity where product_id in ${pids};`);
  await q(`delete from inv.purchases where product_id in ${pids};`);
  await q(`delete from inv.purchases where vendor_id in ${vids};`);
  await q(`delete from inv.products where name like '${MARK}%';`);
  await q(`delete from public.vendor_users where vendor_id in ${vids};`);
  await q(`delete from inv.vendor_bank_accounts where vendor_id in ${vids};`);
  await q(`delete from inv.vendor_contacts where vendor_id in ${vids};`);
  await q(`delete from inv.vendor_attachments where vendor_id in ${vids};`);
  await q(`delete from public.artists where name like '${MARK}%';`);
  await q(`delete from inv.vendors where name like '${MARK}%';`);
}

if (!TOKEN) {
  skipped.push("實測段（缺 SUPABASE_ACCESS_TOKEN）");
  console.log(yellow("\n[16]–[20] 跳過實測：沒有 SUPABASE_ACCESS_TOKEN"));
} else {
  await cleanup();

  const operator = await q(`select user_id from inv.profiles limit 1;`);
  const uid = operator.rows[0]?.user_id;
  checkTrue("拿得到一個操作人員 uuid", Boolean(uid));

  const baselineQ = await q(`
    select (select count(*)::int from inv.products) p,
           (select count(*)::int from inv.purchases) pu,
           (select count(*)::int from inv.sales) s,
           (select count(*)::int from inv.stock_adjustments) sa,
           (select count(*)::int from inv.inventory_adjustments) ia,
           (select count(*)::int from inv.combo_sets) cs,
           (select count(*)::int from inv.combo_set_items) ci,
           (select count(*)::int from public.publications) pub,
           (select count(*)::int from public.products) pp,
           (select count(*)::int from inv.vendors) v,
           (select count(*)::int from public.pii_access_log) log,
           (select coalesce(sum(stock_quantity), 0)::int from inv.products) stock;`);
  const base = baselineQ.rows[0] ?? {};
  checkTrue("讀得到基準線", Boolean(base.p));

  // ── [16] 遮罩與稽核軌跡 ────────────────────────────────────────────────
  console.log("\n[16] 實測：遮罩、敏感欄位、稽核軌跡");

  const setup = await q(`
    do $selftest$
    declare v_a uuid; v_b uuid; v_uid uuid;
    begin
      select user_id into v_uid from inv.profiles limit 1;
      select (public.inv_save_vendor(v_uid, null, jsonb_build_object(
        'name', '${MARK}甲', 'entity_type', 'domestic_company', 'tax_id', '12345678',
        'approval_status', 'approved', 'vendor_code', 'HACK', 'created_by', gen_random_uuid()
      ))->>'id')::uuid into v_a;
      select (public.inv_save_vendor(v_uid, null, jsonb_build_object(
        'name', '${MARK}乙', 'entity_type', 'domestic_individual', 'id_number', 'a123456789'
      ))->>'id')::uuid into v_b;
      insert into inv.vendor_bank_accounts (vendor_id, account_holder_name, bank_code, bank_name, account_number, is_default)
      values (v_a, '${MARK}甲', '013', '測試銀行', '1234567890', true);
      update inv.vendors set approval_status = 'approved', status = 'active'
       where name like '${MARK}%';
    end;
    $selftest$;`);
  checkTrue("測試廠商建立成功", setup.ok, setup.error ?? "");

  const masked = await q(`
    select name, tax_id_masked, id_number_masked, has_tax_id, has_id_number
      from public.inv_admin_vendor_list where name like '${MARK}%' order by name;`);
  check("遮罩：統編只剩後兩碼", masked.rows[0]?.tax_id_masked, "******78");
  check("遮罩：身分證留首碼與後兩碼", masked.rows[1]?.id_number_masked, "A*******89");
  check("對照組：has_tax_id 仍然答得出「有沒有填」", masked.rows[0]?.has_tax_id, true);

  const bank = await q(`
    select account_number_masked from public.inv_admin_vendor_bank_accounts
     where account_holder_name = '${MARK}甲';`);
  check("遮罩：銀行帳號只剩後四碼", bank.rows[0]?.account_number_masked, "******7890");

  // 讀敏感欄位 → 一定留痕
  const before = await q(`select count(*)::int n from public.pii_access_log;`);
  const sens = await q(`
    select public.inv_vendor_sensitive(
      (select user_id from inv.profiles limit 1), 'selftest@local',
      (select id from inv.vendors where name = '${MARK}乙'),
      array['id_number'], 'tax_filing') r;`);
  checkTrue("讀得到完整身分證字號", /A123456789/i.test(JSON.stringify(sens.rows[0]?.r ?? {})));
  const after = await q(`select count(*)::int n from public.pii_access_log;`);
  check("而且正好多一筆稽核紀錄", after.rows[0]?.n - before.rows[0]?.n, 1);

  const logRow = await q(`
    select actor_email, access_kind, subject_table, fields::text, reason
      from public.pii_access_log order by accessed_at desc limit 1;`);
  check("紀錄的 actor 對", logRow.rows[0]?.actor_email, "selftest@local");
  check("紀錄的欄位對", logRow.rows[0]?.fields, "{id_number}");
  check("紀錄的事由對", logRow.rows[0]?.reason, "tax_filing");

  // 白名單以外一個都不給
  const bogus = await q(`
    select public.inv_vendor_sensitive(
      (select user_id from inv.profiles limit 1), 'selftest@local',
      (select id from inv.vendors where name = '${MARK}乙'),
      array['*', 'all', 'notes'], 'tax_filing');`);
  checkTrue("白名單以外的欄位名一個都不給", !bogus.ok, "應該 VENDOR_PII_NO_FIELDS");

  // ── [17] 稽核軌跡改不動也刪不掉 ────────────────────────────────────────
  console.log("\n[17] 實測：稽核軌跡 append-only");

  const upd = await q(
    `update public.pii_access_log set actor_email = 'x' where actor_email = 'selftest@local';`,
  );
  checkTrue("UPDATE 被擋", !upd.ok && /PII_LOG_IMMUTABLE/.test(upd.error ?? ""));
  const del = await q(`delete from public.pii_access_log where actor_email = 'selftest@local';`);
  checkTrue("DELETE 被擋", !del.ok && /PII_LOG_IMMUTABLE/.test(del.error ?? ""));
  const tru = await q(`truncate public.pii_access_log;`);
  checkTrue("TRUNCATE 被擋", !tru.ok && /PII_LOG_IMMUTABLE/.test(tru.error ?? ""));

  const grants = await q(`
    select coalesce(string_agg(distinct grantee, ','), '') g
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'pii_access_log'
       and grantee in ('anon', 'authenticated', 'service_role');`);
  check("anon / authenticated / service_role 對稽核表零權限", grants.rows[0]?.g, "");

  // ── [18] 跨廠商隔離 ────────────────────────────────────────────────────
  console.log("\n[18] 實測：跨廠商隔離（A 帶著 B 的 id 去打）");

  const link = await q(`
    do $selftest$
    declare v_users uuid[]; v_a uuid; v_b uuid;
    begin
      select id into v_a from inv.vendors where name = '${MARK}甲';
      select id into v_b from inv.vendors where name = '${MARK}乙';
      select array_agg(id) into v_users from (select id from auth.users order by created_at limit 2) x;
      insert into public.vendor_users (user_id, vendor_id) values (v_users[1], v_a)
        on conflict (user_id) do update set vendor_id = excluded.vendor_id, is_active = true;
      insert into public.vendor_users (user_id, vendor_id) values (v_users[2], v_b)
        on conflict (user_id) do update set vendor_id = excluded.vendor_id, is_active = true;
    end;
    $selftest$;`);
  checkTrue("兩個入口帳號綁定成功", link.ok, link.error ?? "");

  const users = await q(`
    select u.user_id, v.name
      from public.vendor_users u join inv.vendors v on v.id = u.vendor_id
     where v.name like '${MARK}%' order by v.name;`);
  const userA = users.rows[0]?.user_id;
  const userB = users.rows[1]?.user_id;
  checkTrue("拿得到兩個入口帳號", Boolean(userA && userB && userA !== userB));

  const submitA = await q(`
    select public.inv_vendor_submit_product('${userA}'::uuid, null, jsonb_build_object(
      'name', '${MARK}甲的商品', 'selling_price', '300',
      'approval_status', 'approved', 'stock_quantity', '999', 'cost_price', '1')) r;`);
  const submitB = await q(`
    select public.inv_vendor_submit_product('${userB}'::uuid, null, jsonb_build_object(
      'name', '${MARK}乙的商品', 'selling_price', '500')) r;`);
  checkTrue("A 送審成功", submitA.ok, submitA.error ?? "");
  checkTrue("B 送審成功", submitB.ok, submitB.error ?? "");

  const shape = await q(`
    select approval_status, submitted_via, product_type, stock_quantity, cost_price::int c, is_active
      from inv.products where name = '${MARK}甲的商品';`);
  check("payload 想指定 approved 也沒用", shape.rows[0]?.approval_status, "pending");
  check("payload 想灌庫存也沒用", shape.rows[0]?.stock_quantity, 0);
  check("payload 想指定成本也沒用", shape.rows[0]?.c, 0);
  check("product_type 一律 consignment", shape.rows[0]?.product_type, "consignment");
  check("submitted_via 記下來了", shape.rows[0]?.submitted_via, "vendor_portal");

  const seeA = await q(`select count(*)::int n from public.inv_vendor_products('${userA}'::uuid);`);
  const seeB = await q(`select count(*)::int n from public.inv_vendor_products('${userB}'::uuid);`);
  check("A 只看得到自己的 1 件", seeA.rows[0]?.n, 1);
  check("B 只看得到自己的 1 件", seeB.rows[0]?.n, 1);

  const bProduct = await q(`select id from inv.products where name = '${MARK}乙的商品';`);
  const bId = bProduct.rows[0]?.id;

  const crossEdit = await q(`
    select public.inv_vendor_submit_product('${userA}'::uuid, '${bId}'::uuid,
      jsonb_build_object('name', '${MARK}被A改掉了', 'selling_price', '1'));`);
  checkTrue(
    "A 拿 B 的 product_id 去改 → 被擋（而且是錯誤，不是靜默的空結果）",
    !crossEdit.ok && /VENDOR_PRODUCT_NOT_EDITABLE/.test(crossEdit.error ?? ""),
  );

  const crossWithdraw = await q(`
    select public.inv_vendor_withdraw_product('${userA}'::uuid, '${bId}'::uuid);`);
  checkTrue(
    "A 拿 B 的 product_id 去撤回 → 被擋",
    !crossWithdraw.ok && /VENDOR_PRODUCT_NOT_WITHDRAWABLE/.test(crossWithdraw.error ?? ""),
  );

  const bStill = await q(`
    select name, selling_price::int p, approval_status from inv.products where id = '${bId}';`);
  check("B 的商品名稱沒有被改", bStill.rows[0]?.name, `${MARK}乙的商品`);
  check("B 的商品售價沒有被改", bStill.rows[0]?.p, 500);
  check("B 的商品還在（沒有被撤回）", bStill.rows[0]?.approval_status, "pending");

  const profA = await q(`
    select (public.inv_vendor_profile('${userA}'::uuid)->'vendor'->>'name') n;`);
  const profB = await q(`
    select (public.inv_vendor_profile('${userB}'::uuid)->'vendor'->>'name') n;`);
  check("A 的 profile 是甲", profA.rows[0]?.n, `${MARK}甲`);
  check("B 的 profile 是乙", profB.rows[0]?.n, `${MARK}乙`);

  const selfBank = await q(`
    select (public.inv_vendor_profile('${userA}'::uuid)->'bank_accounts'->0->>'account_number_masked') m,
           (public.inv_vendor_profile('${userA}'::uuid)->'bank_accounts'->0->>'account_number') raw;`);
  check("廠商看自己的帳號也是遮罩版", selfBank.rows[0]?.m, "******7890");
  check("而且 profile 裡沒有原值", selfBank.rows[0]?.raw, null);

  // 停權立刻生效
  await q(`update public.vendor_users set is_active = false where user_id = '${userA}';`);
  const suspended = await q(`select * from public.inv_vendor_products('${userA}'::uuid);`);
  checkTrue(
    "停權之後下一個請求就被擋（不等 cookie 過期）",
    !suspended.ok && /VENDOR_PORTAL_NOT_LINKED/.test(suspended.error ?? ""),
  );
  await q(`update public.vendor_users set is_active = true where user_id = '${userA}';`);

  // 廠商已終止往來 → 也擋
  await q(`update inv.vendors set status = 'inactive' where name = '${MARK}甲';`);
  const inactive = await q(`select * from public.inv_vendor_products('${userA}'::uuid);`);
  checkTrue(
    "廠商狀態改成已終止 → 入口也擋",
    !inactive.ok && /VENDOR_PORTAL_NOT_LINKED/.test(inactive.error ?? ""),
  );
  await q(`update inv.vendors set status = 'active' where name = '${MARK}甲';`);

  // ── [19] approval_settings 關掉也一樣 pending ─────────────────────────
  console.log("\n[19] 實測：approval_settings.products 關掉，廠商送審仍是 pending");

  const wasOn = await q(`select is_enabled from inv.approval_settings where module = 'products';`);
  await q(`update inv.approval_settings set is_enabled = false where module = 'products';`);
  const submitOff = await q(`
    select (public.inv_vendor_submit_product('${userB}'::uuid, null, jsonb_build_object(
      'name', '${MARK}關審核也要審', 'selling_price', '100'))->>'approval_status') s;`);
  check("仍然是 pending", submitOff.rows[0]?.s, "pending");
  // 對照組：店員那一條路**會**受 approval_settings 影響
  const staffSave = await q(`
    select (public.inv_save_product((select user_id from inv.profiles limit 1), null,
      jsonb_build_object('name', '${MARK}店員建的', 'selling_price', '100'))->>'approval_status') s;`);
  check(
    "對照組：店員建的商品確實變成 approved（證明開關真的關著）",
    staffSave.rows[0]?.s,
    "approved",
  );
  await q(
    `update inv.approval_settings set is_enabled = ${wasOn.rows[0]?.is_enabled} where module = 'products';`,
  );

  // ── [20] 外鍵 RESTRICT ────────────────────────────────────────────────
  console.log("\n[20] 實測：外鍵 RESTRICT");

  const fkTypes = await q(`
    select conname, confdeltype from pg_constraint
     where conname in ('sales_product_id_fkey','combo_set_items_product_id_fkey',
                       'products_vendor_id_fkey','purchases_vendor_id_fkey')
     order by conname;`);
  check(
    "四條外鍵都是 RESTRICT",
    (fkTypes.rows ?? []).map((r) => `${r.conname}=${r.confdeltype}`).join(","),
    "combo_set_items_product_id_fkey=r,products_vendor_id_fkey=r," +
      "purchases_vendor_id_fkey=r,sales_product_id_fkey=r",
  );

  const soldProduct = await q(`
    do $selftest$
    declare v_p uuid; v_uid uuid;
    begin
      select user_id into v_uid from inv.profiles limit 1;
      insert into inv.products (user_id, name, selling_price, approval_status, stock_quantity)
      values (v_uid, '${MARK}賣過的', 300, 'approved', 10) returning id into v_p;
      insert into inv.sales (user_id, product_id, quantity, unit_price, amount, sale_date)
      values (v_uid, v_p, 1, 300, 300, current_date);
    end;
    $selftest$;`);
  checkTrue("建了一件賣過的商品", soldProduct.ok, soldProduct.error ?? "");

  const delSold = await q(`delete from inv.products where name = '${MARK}賣過的';`);
  checkTrue(
    "賣過的商品刪不掉（不會再製造 product_id IS NULL 的孤兒）",
    !delSold.ok && /violates RESTRICT|foreign key/i.test(delSold.error ?? ""),
  );

  const delVendor = await q(`
    select public.inv_delete_vendor((select id from inv.vendors where name = '${MARK}甲'));`);
  checkTrue(
    "有往來資料的廠商刪不掉，而且訊息說得出原因",
    !delVendor.ok && /VENDOR_IN_USE/.test(delVendor.error ?? ""),
  );

  const orphan = await q(`
    select count(*)::int n from inv.sales where product_id is null and is_secondhand = false;`);
  check("歷史孤兒銷售列仍然只有 1 筆（不改寫歷史、也不再產生新的）", orphan.rows[0]?.n, 1);

  // ── 收尾：基準線一筆不差 ──────────────────────────────────────────────
  console.log("\n[21] 收尾：清乾淨並比對基準線");

  await cleanup();

  const afterQ = await q(`
    select (select count(*)::int from inv.products) p,
           (select count(*)::int from inv.purchases) pu,
           (select count(*)::int from inv.sales) s,
           (select count(*)::int from inv.stock_adjustments) sa,
           (select count(*)::int from inv.inventory_adjustments) ia,
           (select count(*)::int from inv.combo_sets) cs,
           (select count(*)::int from inv.combo_set_items) ci,
           (select count(*)::int from public.publications) pub,
           (select count(*)::int from public.products) pp,
           (select count(*)::int from inv.vendors) v,
           (select count(*)::int from public.vendor_users) vu,
           (select coalesce(sum(stock_quantity), 0)::int from inv.products) stock,
           (select count(*)::int from inv.products where stock_quantity < 0) neg;`);
  const a = afterQ.rows[0] ?? {};

  check("inv.products = 993", a.p, 993);
  check("inv.purchases = 1029", a.pu, 1029);
  check("inv.sales = 665", a.s, 665);
  check("inv.stock_adjustments = 50", a.sa, 50);
  check("inv.inventory_adjustments = 30", a.ia, 30);
  check("inv.combo_sets = 6", a.cs, 6);
  check("inv.combo_set_items = 6", a.ci, 6);
  check("public.publications = 126", a.pub, 126);
  check("public.products = 19", a.pp, 19);
  check("inv.vendors = 14", a.v, 14);
  check("sum(stock_quantity) = 3508", a.stock, 3508);
  check("負庫存 = 0", a.neg, 0);
  check("測試用的入口帳號也清乾淨了", a.vu, 0);
  check("廠商數與開始時一致", a.v, base.v);

  const anonGrants = await q(`
    select count(*)::int n from information_schema.role_table_grants
     where table_schema = 'inv' and grantee in ('anon', 'authenticated');`);
  check("anon / authenticated 對 inv 的 grant = 0", anonGrants.rows[0]?.n, 0);

  // pii_access_log 刻意不清 —— 它刪不掉，那就是重點。
  const logAfter = await q(`select count(*)::int n from public.pii_access_log;`);
  checkTrue(
    "稽核紀錄留下來了（刪不掉是設計，不是漏掉）",
    logAfter.rows[0]?.n > base.log,
    `實測前 ${base.log} 筆，實測後 ${logAfter.rows[0]?.n} 筆`,
  );
}

// =============================================================================
// [PII] 🔴 「沒按更改就儲存」的閘門
// =============================================================================
//
// 這一段守的是整個廠商後台最貴的一條不變量，而它先前**沒有任何測試在守**
// （實測：把那個 if 整段拿掉，這支自檢 310 個 case 照樣全綠）。
//
// 機制：inv.vendors 的四個識別碼是 PII，view 只送遮罩出來，所以
// formFromDetail() 刻意讓它們留空 —— 系統讀不回原值。於是「開啟一家已經有
// 身分證字號的廠商 → 改個電話 → 按儲存」如果沒有被擋下來，送出去的 payload
// 會拿**空字串**覆蓋掉資料庫裡真正的身分證字號、統編、國外識別碼與居留證號碼。
// 靜默、不可復原，而且沒有任何一層會報錯。
//
// 擋住它的只有 save() 開頭那個 lockedKeys 閘門，而且它**必須在 safeParse
// 之前**：跑到 schema 驗證那一步就代表 payload 已經組好了。
console.log("\n[PII] 沒按更改就儲存的閘門");

const vendorFormCode = stripTs(read(join(ROOT, "src/components/inventory/VendorFormDialog.tsx")));
const saveStart = vendorFormCode.indexOf("async function save()");
const saveBody = saveStart === -1 ? "" : vendorFormCode.slice(saveStart);

checkTrue("切得出 save() 的本體", saveBody.length > 0);

const gateAt = saveBody.indexOf("lockedKeys.length > 0");
const parseAt = saveBody.indexOf("safeParse");

checkTrue(
  "🔴 save() 裡有 lockedKeys 閘門（沒有它，儲存會用空字串覆蓋掉真正的身分證字號）",
  gateAt !== -1,
);
checkTrue("save() 裡有 safeParse（切點正確的前提）", parseAt !== -1);
checkTrue(
  "🔴 閘門在 safeParse **之前** —— 跑到驗證那一步代表 payload 已經組好了",
  gateAt !== -1 && parseAt !== -1 && gateAt < parseAt,
  `lockedKeys 在 +${gateAt}，safeParse 在 +${parseAt}`,
);
// ⚠️ 只看閘門**自己那一個大括號區塊**，用括號配對切出來。
//    第一版寫成「`lockedKeys.length > 0)` 之後 400 字內找得到 return;」，
//    結果把 return 拿掉之後它照樣綠 —— 因為它抓到了閘門後面別處的 return。
//    這個 repo 已經出過好幾次同一種假陽性，這裡是第 N 次，突變測試抓出來的。
const gateBlock = (() => {
  const at = saveBody.indexOf("lockedKeys.length > 0");
  if (at === -1) return "";
  const open = saveBody.indexOf("{", at);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < saveBody.length; i++) {
    if (saveBody[i] === "{") depth += 1;
    else if (saveBody[i] === "}") {
      depth -= 1;
      if (depth === 0) return saveBody.slice(open, i + 1);
    }
  }
  return "";
})();
checkTrue("切得出閘門自己的區塊", gateBlock.length > 0);
checkTrue(
  "🔴 閘門是 early return，不是只跳個 toast 就繼續往下走",
  /\breturn;/.test(gateBlock),
  "閘門區塊裡沒有 return; —— 擋不住任何東西",
);
checkTrue(
  "lockedKeys 是由「有遮罩且沒按更改」算出來的，不是寫死的空陣列",
  /lockedKeys\s*=\s*SENSITIVE_KEYS\.filter\([\s\S]{0,120}?masks\[[\s\S]{0,40}?\]\s*!==\s*null\s*&&\s*!changing\[/.test(
    vendorFormCode,
  ),
);
// ⚠️ 掃**整批** Vendor 元件，不是只掃 VendorFormDialog。
//    這一期把 2,353 行的對話框拆成 28 個檔案，遮罩的渲染就搬去了
//    VendorIdentityField / VendorBankSection。只釘一個檔案的斷言，會在
//    程式碼搬家的那一刻靜默失去覆蓋 —— 突變測試抓到的正是這一點。
const vendorComponentFiles = readdirSync(join(ROOT, "src/components/inventory"))
  .filter((f) => /^Vendor.*\.tsx?$/.test(f))
  .sort();
checkTrue(
  `掃得到整批 Vendor 元件（${vendorComponentFiles.length} 個）`,
  vendorComponentFiles.length >= 20,
);

const maskedIntoInput = vendorComponentFiles.filter((f) =>
  /(value|defaultValue)=\{[^}]*mask/i.test(
    stripTs(read(join(ROOT, "src/components/inventory", f))),
  ),
);
check(
  "🔴 整批 Vendor 元件都沒有把遮罩值餵進 input（value= / defaultValue=）",
  maskedIntoInput.join(",") || "（無）",
  "（無）",
  "遮罩值進了 input，按下儲存就會把「A12****789」這種字串寫回資料庫",
);

// ── 結果 ────────────────────────────────────────────────────────────────────

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
