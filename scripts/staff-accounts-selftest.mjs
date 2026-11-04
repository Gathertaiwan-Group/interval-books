#!/usr/bin/env node
/**
 * staff-accounts-selftest.mjs —— 後台人員管理頁（/admin/staff，0033）的自檢
 *
 * user 問「哪邊可以設定管理員與操作人員」——答案曾經是「沒有地方，只能進
 * Supabase Dashboard 手改 profiles 表」（src/routes/admin/pending.tsx 卡在待審
 * 頁面，畫面上沒有任何按鈕）。這支測試守的是補上那個功能之後，四條最容易被
 * 破壞、後果也最嚴重的規則：
 *
 *   1. 這一頁與它所有 server fn 只接受 admin，staff 打進來要被拒。
 *   2. 不能改自己的角色。
 *   3. 不能移除／降級最後一位 admin —— 資料庫層與應用層兩層都要擋。
 *   4. 建帳號時只能設 pending/staff/admin，不能設 vendor 或 customer。
 *
 * 分兩段，理由與這個 repo 其他 DB 相關自檢一致：
 *
 *   [靜態] 讀 supabase/migrations/0033、src/server/repos/staff-accounts.ts、
 *          src/lib/admin/fns/staff-accounts.ts、src/lib/admin/schemas.ts、
 *          src/routes/admin/_shell.staff.tsx、src/routes/admin/_shell.tsx 的
 *          原始碼，核對上面四條規則在**每一層**都真的寫著該寫的檢查。
 *          不連線也回答得出來，永遠會跑。
 *
 *   [DB]   對一個真的本機 Postgres 實際 update／delete 最後一位 admin，確認
 *          真的被 profiles_keep_last_admin trigger 擋下來；也實測
 *          admin_update_profile_role() 的自我檢查、角色值域，以及
 *          admin_replace_staff_permissions() 的原子性，並確認兩支 RPC 對
 *          anon/authenticated 真的被撤權。沿用這個 repo既有的手法（見
 *          notify-selftest.mjs）：每一次 q() 是一個獨立的 psql 子行程。
 *
 *          需要 STAFF_SELFTEST_PG_URL 才會跑；缺少時整段清楚 skip（會印出來，
 *          不算失敗）。STAFF_SELFTEST_APPLY=1 會先套用 0001–0033（0008 跳過，
 *          理由與 notify-selftest.mjs 相同：需要 pg_net/vault/pg_cron，本機
 *          沒有）。
 *
 *              createdb ib_0033_test
 *              STAFF_SELFTEST_PG_URL=postgres:///ib_0033_test \
 *              STAFF_SELFTEST_APPLY=1 node scripts/staff-accounts-selftest.mjs
 *
 * ── 這支測試不會呼叫 GoTrue Admin API ───────────────────────────────────
 * createStaffAccount() 的「GoTrue 建帳號 → 設角色 → 失敗就刪帳號」流程沒有
 * 對應的 DB 段：GoTrue Admin API 是 HTTP 服務，不是 SQL，本機 psql 連不到它，
 * 這個 repo 目前也沒有任何一支測試在做這件事（全 repo 搜尋
 * auth.admin.createUser 只有這一支新增的 createStaffAccount 用到）。這一段
 * 只能用 [靜態] 核對「失敗時真的呼叫 deleteUser」的程式碼形狀，這是這支測試
 * 誠實的邊界，不是漏測。
 */

import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
} from "./lib/migration-ledger.mjs";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/staff-accounts-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");
const MIG_0033 = join(MIG_DIR, "0033_admin_staff_management.sql");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 notify-selftest.mjs / admin-order-notify-selftest.mjs 同一套）
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

/** 讀原始碼。檔案不存在就丟例外，不回空字串（見 run-selftests.mjs 守門 4）。 */
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
function stripSqlLineComments(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/** 拿掉 TypeScript 的註解（block 與 line）。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

console.log("═══ 後台人員管理頁自檢（0033）═══");

// =============================================================================
// [1] migration 0033 檔案盤點
// =============================================================================
console.log("\n[1] migration 0033 檔案盤點");
check("0033 存在", existsSync(MIG_0033), true);

const sql0033raw = readFile(MIG_0033);
const sql0033 = stripSqlLineComments(sql0033raw);

checkTrue("反空殼：0033 不是空檔", sql0033raw.length > 2000);
checkTrue("有 begin; … commit;", /^begin;/m.test(sql0033) && /^commit;/m.test(sql0033));
check("沒有 drop table（這支只新增）", /drop\s+table/i.test(sql0033), false);
check("沒有 drop constraint（沒有動既有 CHECK）", /drop\s+constraint/i.test(sql0033), false);
check("沒有 drop view", /drop\s+view/i.test(sql0033), false);
// drop function 只允許緊接在同一支 create or replace function 前面（rerun 慣例），
// 這支完全沒有——三個新函式都是全新名字，不需要先 drop 舊簽名。
check(
  "沒有 drop function（三個都是全新函式，不必先 drop 舊簽名）",
  /drop\s+function/i.test(sql0033),
  false,
);

assertLedgerMatchesDisk(check, MIG_DIR);
assertLedgerDeclarationsHonest(check, MIG_DIR);
// 這支自檢是為 0033 寫的（跟 admin-order-notify-selftest.mjs 對 0032 的關係一樣）：
// 不是「後來的 migration 動到我在乎的東西」，而是「我在乎的東西就是這支
// migration 本身」。往前看：0033 唯一命中的區域是 admin_auth（識別字
// staff_permissions／profiles，見 scripts/lib/migration-ledger.mjs 的帳本列）。
// 往後看：往後任何動到 admin_auth 的 migration 都應該讓這支自檢被叫回來重讀
// ——這正是 reviewedThrough 設成 0033 自己的用意。
assertMigrationDependencies(check, MIG_DIR, {
  suite: "staff-accounts-selftest",
  dependsOn: ["admin_auth"],
  // 0057 重審：只換 staff_permissions 的 CHECK 值域（九種＋event.onsite.collect），沒有碰
  // profiles、保底 trigger 或任何 RPC——這支的斷言照樣成立。
  reviewedThrough: "0057_staff_onsite_collect_permission.sql",
});

// =============================================================================
// [2] profiles_keep_last_admin —— 保底 trigger 的形狀
// =============================================================================
console.log("\n[2] profiles_keep_last_admin：AFTER STATEMENT，delete 與 update 都擋");

const triggerFnBody = sql0033.slice(
  sql0033.indexOf("create or replace function public.profiles_keep_last_admin()"),
  sql0033.indexOf("create trigger profiles_keep_last_admin"),
);
checkTrue("函式本體抓得到", triggerFnBody.length > 50);
checkTrue(
  "count(*) where role = 'admin' = 0 才 raise",
  /count\(\*\)[\s\S]{0,40}role\s*=\s*'admin'/.test(triggerFnBody) &&
    /=\s*0\s+then/.test(triggerFnBody),
);
checkTrue("raise exception 'LAST_ADMIN'", /raise exception 'LAST_ADMIN'/.test(triggerFnBody));
checkTrue("函式是 SECURITY DEFINER", /security definer/i.test(triggerFnBody));

const triggerDecl = sql0033.slice(
  sql0033.indexOf("create trigger profiles_keep_last_admin"),
  sql0033.indexOf("create trigger profiles_keep_last_admin") + 250,
);
checkTrue("🔴 掛在 public.profiles 上", /on public\.profiles/.test(triggerDecl));
checkTrue(
  "🔴 AFTER（不是 BEFORE）——BEFORE 看不到整句做完之後的狀態",
  /after delete or update/.test(triggerDecl),
);
check("🔴 不是 BEFORE", /before\s+delete\s+or\s+update/i.test(triggerDecl), false);
checkTrue(
  "🔴 FOR EACH STATEMENT（不是 FOR EACH ROW）——ROW 會在刪光多列時的中間態誤判成安全",
  /for each statement/.test(triggerDecl),
);
check("不是 FOR EACH ROW", /for each row/i.test(triggerDecl), false);
checkTrue("🔴 同時掛 delete 與 update（降級跟刪除後果一樣）", /delete or update/.test(triggerDecl));
check(
  "insert 不在事件清單裡（正常註冊、建立新帳號不受影響）",
  /after\s+insert[\s\S]{0,30}profiles_keep_last_admin/i.test(sql0033),
  false,
);

// =============================================================================
// [3] admin_update_profile_role —— 角色值域、自我檢查
// =============================================================================
console.log("\n[3] admin_update_profile_role：角色值域排除 vendor、擋自我修改");

const roleFnStart = sql0033.indexOf("create or replace function public.admin_update_profile_role(");
const roleFnEnd = sql0033.indexOf(
  "create or replace function public.admin_replace_staff_permissions(",
);
const roleFnBody = sql0033.slice(roleFnStart, roleFnEnd);
checkTrue("函式本體抓得到", roleFnBody.length > 100);
checkTrue("函式是 SECURITY DEFINER", /security definer/i.test(roleFnBody.slice(0, 400)));

const notInMatch = roleFnBody.match(/p_new_role\s+not\s+in\s*\(([^)]*)\)/i);
checkTrue("抓得到 p_new_role 的值域檢查", Boolean(notInMatch));
const roleDomain = notInMatch ? notInMatch[1] : "";
check("🔴 值域含 pending", /'pending'/.test(roleDomain), true);
check("🔴 值域含 staff", /'staff'/.test(roleDomain), true);
check("🔴 值域含 admin", /'admin'/.test(roleDomain), true);
check("🔴 值域含 customer（移除後台身分要用）", /'customer'/.test(roleDomain), true);
check(
  "🚨 值域不含 vendor——這是「建帳號/改角色不可以設出 vendor」的資料庫層防線",
  /vendor/i.test(roleDomain),
  false,
  "vendor 是廠商自助入口（0019）的身分，不是後台人員；一旦被加進這個值域，這支 RPC 就能把任何帳號設成 vendor。",
);
checkTrue("值域不符時 raise 'INVALID_ROLE'", /raise exception 'INVALID_ROLE'/.test(roleFnBody));

checkTrue(
  "🔴 p_actor_id = p_target_id 時 raise 'CANNOT_CHANGE_OWN_ROLE'",
  /if\s+p_actor_id\s*=\s*p_target_id\s+then[\s\S]{0,80}raise exception 'CANNOT_CHANGE_OWN_ROLE'/.test(
    roleFnBody,
  ),
);
checkTrue(
  "自我檢查在值域檢查之後、update 之前（讀起來像順序執行，不是死碼）",
  roleFnBody.indexOf("CANNOT_CHANGE_OWN_ROLE") > roleFnBody.indexOf("INVALID_ROLE") &&
    roleFnBody.indexOf("CANNOT_CHANGE_OWN_ROLE") < roleFnBody.indexOf("update public.profiles"),
);
checkTrue(
  "找不到列時 raise 'PROFILE_NOT_FOUND'",
  /raise exception 'PROFILE_NOT_FOUND'/.test(roleFnBody),
);
checkTrue(
  "這支本身不重複「最後一位 admin」的邏輯——交給 §1 的 trigger 在同一個交易裡處理",
  !/LAST_ADMIN/.test(roleFnBody),
);

// =============================================================================
// [4] admin_replace_staff_permissions —— 先刪光再插入，同一個函式（同一個交易）
// =============================================================================
console.log("\n[4] admin_replace_staff_permissions：delete 與 insert 在同一個交易");

const permFnStart = sql0033.indexOf(
  "create or replace function public.admin_replace_staff_permissions(",
);
const permFnEnd = sql0033.indexOf("§4", permFnStart);
const permFnBody = sql0033.slice(permFnStart, permFnEnd === -1 ? sql0033.length : permFnEnd);
checkTrue("函式本體抓得到", permFnBody.length > 100);
checkTrue("函式是 SECURITY DEFINER", /security definer/i.test(permFnBody.slice(0, 400)));
checkTrue(
  "delete from public.staff_permissions",
  /delete from public\.staff_permissions/.test(permFnBody),
);
checkTrue(
  "insert into public.staff_permissions",
  /insert into public\.staff_permissions/.test(permFnBody),
);
checkTrue(
  "delete 在 insert 之前（跟 migration 註解描述的順序一致——⚠️ 這條只驗文字順序，" +
    "不是原子性本身：兩個陳述式只要都在同一支 plpgsql 函式內，不管先後順序，" +
    "Postgres 都會把整支函式當一個交易執行。真正保證原子性、且被 mutation 測試過" +
    "真的會轉紅的是 [6] 的「setStaffPermissions 只呼叫這一支 RPC，不自己分兩次" +
    "呼叫」與 [DB-6] 對真的資料庫送一個非法權限字串觀察舊資料是否被清空）",
  permFnBody.indexOf("delete from public.staff_permissions") <
    permFnBody.indexOf("insert into public.staff_permissions"),
);
checkTrue("granted_by 有寫入", /granted_by/.test(permFnBody));

// =============================================================================
// [5] 權限：兩支 RPC 都從 public/anon/authenticated 撤權，只留 service_role
// =============================================================================
console.log("\n[5] 兩支 RPC 都不對 anon/authenticated 開放（PostgREST 會把它們當端點暴露）");

const grantBlock = sql0033.slice(sql0033.indexOf("foreach sig in array array["));
checkTrue(
  "🔴 陣列裡有 admin_update_profile_role(uuid, uuid, text)",
  /admin_update_profile_role\(uuid, uuid, text\)/.test(grantBlock),
);
checkTrue(
  "🔴 陣列裡有 admin_replace_staff_permissions(uuid, text[], uuid)",
  /admin_replace_staff_permissions\(uuid, text\[\], uuid\)/.test(grantBlock),
);
checkTrue("revoke from public", /revoke execute on function %s from public/.test(grantBlock));
checkTrue(
  "revoke from anon, authenticated",
  /revoke execute on function %s from anon, authenticated/.test(grantBlock),
);
checkTrue(
  "grant 給 service_role",
  /grant\s+execute on function %s to service_role/.test(grantBlock),
);

// =============================================================================
// [6] repo/staff-accounts.ts —— 自我檢查最先做、建帳號失敗會回滾、角色值域正確
// =============================================================================
console.log("\n[6] src/server/repos/staff-accounts.ts");

const repoPath = join(ROOT, "src/server/repos/staff-accounts.ts");
const repoSrcRaw = readFile(repoPath);
const repoSrc = stripTs(repoSrcRaw);

checkTrue(
  "server-only guard 在最前面",
  /^import "@tanstack\/react-start\/server-only";/m.test(repoSrc),
);

const updateRoleFn = repoSrc.slice(
  repoSrc.indexOf("export async function updateStaffRole"),
  repoSrc.indexOf("export async function updateStaffRole") + 700,
);
checkTrue("updateStaffRole 抓得到", updateRoleFn.length > 100);
checkTrue(
  "🔴 自我檢查（actorUserId === targetUserId）是函式本體的第一句判斷，不是事後補的",
  /\{\s*\n\s*if \(input\.actorUserId === input\.targetUserId\)/.test(updateRoleFn),
);
checkTrue(
  "自我檢查在任何 await（網路呼叫）之前——不必連線就能擋",
  updateRoleFn.indexOf("input.actorUserId === input.targetUserId") <
    updateRoleFn.indexOf("await supabaseAdmin"),
);
checkTrue(
  "自我檢查會丟出錯誤（不是靜默 return）",
  /throw new Error/.test(updateRoleFn.slice(0, 300)),
);

checkTrue(
  "updateStaffRole 呼叫 admin_update_profile_role RPC（而不是自己組 .update()，讓資料庫層的檢查一定會被跑到）",
  /\.rpc\(\s*"admin_update_profile_role"/.test(updateRoleFn),
);

const createFn = repoSrc.slice(
  repoSrc.indexOf("export async function createStaffAccount"),
  repoSrc.indexOf("export async function updateStaffRole"),
);
checkTrue("createStaffAccount 抓得到", createFn.length > 200);
checkTrue("呼叫 auth.admin.createUser", /auth\.admin\.createUser/.test(createFn));
checkTrue(
  "email_confirm: true（沒有邀請信流程，不確認就永遠登不進）",
  /email_confirm:\s*true/.test(createFn),
);
checkTrue(
  "🔴 設角色失敗時呼叫 auth.admin.deleteUser 回滾——不留孤兒帳號",
  /roleError[\s\S]{0,200}auth\.admin\.deleteUser\(newUserId\)/.test(createFn),
);
checkTrue(
  "回滾也失敗時訊息裡有提示，不是吞掉",
  /rollbackError[\s\S]{0,200}請聯絡開發者/.test(createFn),
);

const creatableRoleLine = repoSrc.slice(
  repoSrc.indexOf("export type CreatableRole"),
  repoSrc.indexOf("export type CreatableRole") + 150,
);
checkTrue(
  '🚨 CreatableRole 只有 "pending" | "staff" | "admin"，不含 vendor/customer',
  /Extract<BackOfficeRole, "pending" \| "staff" \| "admin">/.test(creatableRoleLine),
);

const listFn = repoSrc.slice(
  repoSrc.indexOf("export async function listStaffAccounts"),
  repoSrc.indexOf("export async function createStaffAccount"),
);
checkTrue(
  "🔴 清單只撈 admin/staff/pending，不含 vendor/customer",
  /\.in\("role",\s*\["admin",\s*"staff",\s*"pending"\]\)/.test(listFn),
);

const removeFn = repoSrc.slice(
  repoSrc.indexOf("export async function removeStaffAccess"),
  repoSrc.indexOf("async function getPermissionsForUser"),
);
checkTrue(
  '移除後台身分固定設成 "customer"，不吃呼叫端傳入的角色',
  /role:\s*"customer"/.test(removeFn),
);
checkTrue(
  "removeStaffAccess 的參數型別裡沒有 role 欄位（協定層面就不能夾帶角色）",
  !/targetUserId:\s*string;\s*\n\s*role/.test(
    repoSrc.slice(
      repoSrc.indexOf("export async function removeStaffAccess") - 10,
      repoSrc.indexOf("export async function removeStaffAccess") + 300,
    ),
  ),
);

const setPermsFn = repoSrc.slice(
  repoSrc.indexOf("export async function setStaffPermissions"),
  repoSrc.indexOf("export { STAFF_PERMISSIONS }"),
);
checkTrue("setStaffPermissions 抓得到", setPermsFn.length > 50);
checkTrue(
  "🔴🔴 setStaffPermissions 呼叫 admin_replace_staff_permissions 這**一支** RPC，" +
    "不是自己在這裡分兩次呼叫 .delete() 再 .insert()——兩次獨立呼叫＝兩個獨立交易，" +
    "第二次失敗會把權限靜默留空；真正的原子性來自兩個操作都在同一個 plpgsql 函式" +
    "本體裡（見 0033 §3），這裡驗的是「呼叫端真的只發一次請求把這件事交給資料庫」，" +
    "不是「delete 寫在 insert 前面」這種文字順序（那個順序只是可讀性，不是原子性" +
    "本身——實際 mutation 測試過：把 0033 §3 的 delete/insert 順序對調，兩者依然在" +
    "同一個函式裡，[DB-6] 的原子性斷言不會轉紅，只有這裡跟下面的文字順序斷言會）。",
  /\.rpc\(\s*"admin_replace_staff_permissions"/.test(setPermsFn),
);
check(
  'setStaffPermissions 沒有自己呼叫 .from("staff_permissions").delete(',
  /\.from\("staff_permissions"\)[\s\S]{0,20}\.delete\(/.test(setPermsFn),
  false,
);

// =============================================================================
// [7] fns/staff-accounts.ts —— 每一支都 adminFnMiddleware，actor 只從 context 拿
// =============================================================================
console.log("\n[7] src/lib/admin/fns/staff-accounts.ts：全部 adminFnMiddleware，staff 打不進來");

const fnsPath = join(ROOT, "src/lib/admin/fns/staff-accounts.ts");
const fnsSrcRaw = readFile(fnsPath);
const fnsSrc = stripTs(fnsSrcRaw);

const exportedFns = [...fnsSrc.matchAll(/export const (\w+) = createServerFn/g)].map((m) => m[1]);
check(
  "五支 server fn 都在（list/create/updateRole/removeAccess/setPermissions）",
  exportedFns.sort(),
  [
    "createStaffAccount",
    "listStaffAccounts",
    "removeStaffAccess",
    "setStaffPermissions",
    "updateStaffRole",
  ].sort(),
);

const middlewareCount = (fnsSrc.match(/\.middleware\(\[adminFnMiddleware\]\)/g) ?? []).length;
check(
  "🔴 adminFnMiddleware 出現次數＝匯出的 server fn 數（沒有漏掛任何一支）",
  middlewareCount,
  exportedFns.length,
);
check(
  "🚨 這一支完全沒有用到 staffFnMiddleware——staff 進得來就是漏洞",
  /staffFnMiddleware/.test(fnsSrc),
  false,
);

// context.admin.userId 是唯一的 actor 來源：四支會寫入的 fn 都要用它，
// 且沒有任何 inputValidator 讓瀏覽器自己填「操作者是誰」。
checkTrue(
  "🔴 至少四處使用 context.admin.userId 當作操作者（create/updateRole/removeAccess/setPermissions）",
  (fnsSrc.match(/context\.admin\.userId/g) ?? []).length >= 4,
);
check(
  "沒有任何 inputValidator 欄位叫 actorUserId（操作者身分不可能由呼叫端提供）",
  /actorUserId:\s*z\./.test(fnsSrc),
  false,
);

// adminFnMiddleware 與 requireAdmin 本身一個字都沒有被動——與這個 repo 其他每一支
// 使用它的自檢同一個規矩（pos-counter-selftest.mjs、inventory-products-selftest.mjs…）。
const middlewareSrc = readFile(join(ROOT, "src/lib/admin/middleware.ts"));
checkTrue(
  "middleware.ts 仍有 adminFnMiddleware",
  /export const adminFnMiddleware/.test(middlewareSrc),
);
checkTrue(
  "adminFnMiddleware 仍然呼叫 requireAdmin()（沒有被偷偷放寬成 requireStaff）",
  /adminFnMiddleware = createMiddleware\(\{ type: "function" \}\)\.server\(\s*async \(\{ next \}\) => \{[\s\S]*?requireAdmin\(\)/.test(
    middlewareSrc,
  ),
);
const authSrc = readFile(join(ROOT, "src/server/auth.ts"));
checkTrue(
  "requireAdmin() 仍然只認 loadAdminProfile（role === 'admin'）",
  /export async function requireAdmin\(\)[\s\S]{0,400}?loadAdminProfile\(session\.userId\)/.test(
    authSrc,
  ),
);
checkTrue(
  "loadAdminProfile 仍然要求 role === 'admin'",
  /async function loadAdminProfile[\s\S]{0,200}?profile\.role !== "admin"/.test(authSrc),
);

// =============================================================================
// [8] schemas.ts —— 建帳號角色值域三值、密碼下限 8、移除動作沒有 role 欄位
// =============================================================================
console.log("\n[8] src/lib/admin/schemas.ts：三個新 schema 的形狀");

const schemasPath = join(ROOT, "src/lib/admin/schemas.ts");
const schemasSrcRaw = readFile(schemasPath);
const schemasSrc = stripTs(schemasSrcRaw);

checkTrue(
  '🚨 CREATABLE_BACKOFFICE_ROLES 恰好是 ["pending", "staff", "admin"]（不含 vendor/customer）',
  /CREATABLE_BACKOFFICE_ROLES = \["pending", "staff", "admin"\] as const;/.test(schemasSrc),
);
checkTrue(
  "createStaffAccountSchema 的 role 用 CREATABLE_BACKOFFICE_ROLES",
  /createStaffAccountSchema = z\.object\(\{[\s\S]{0,400}?role: z\.enum\(CREATABLE_BACKOFFICE_ROLES/.test(
    schemasSrc,
  ),
);
checkTrue(
  "🔴 密碼欄位有 .min(8, …)（Supabase 專案設定的下限）",
  /password: z\s*\n?\s*\.string\(\)\s*\n?\s*\.min\(8,/.test(schemasSrc),
);

checkTrue(
  "updateStaffRoleSchema 的 role 也用 CREATABLE_BACKOFFICE_ROLES（升降級只能是這三種）",
  /updateStaffRoleSchema = z\.object\(\{[\s\S]{0,300}?role: z\.enum\(CREATABLE_BACKOFFICE_ROLES/.test(
    schemasSrc,
  ),
);

const removeSchemaSlice = schemasSrc.slice(
  schemasSrc.indexOf("export const removeStaffAccessSchema"),
  schemasSrc.indexOf("export const removeStaffAccessSchema") + 200,
);
checkTrue("removeStaffAccessSchema 抓得到", removeSchemaSlice.length > 20);
check(
  "🔴 removeStaffAccessSchema 沒有 role 欄位——協定層面就不能夾帶角色值",
  /role\s*:/.test(removeSchemaSlice),
  false,
);
checkTrue(
  "removeStaffAccessSchema 有 userId",
  /userId:\s*z\.string\(\)\.trim\(\)\.uuid\(\)/.test(removeSchemaSlice),
);

checkTrue(
  "staffPermissionsSchema 的 permissions 是 STAFF_PERMISSIONS 的陣列",
  /staffPermissionsSchema = z\.object\(\{[\s\S]{0,300}?permissions: z\.array\(z\.enum\(STAFF_PERMISSIONS\)\)/.test(
    schemasSrc,
  ),
);

// schemas.ts 自己的 STAFF_PERMISSIONS 副本必須跟 src/server/auth.ts 那份逐字一致
// ——這是 VENDOR_SENSITIVE_FIELDS 已經在用的既有跨界手法（server-only 檔案不能被
// 瀏覽器端的 schemas.ts import），這裡多驗一步：兩份清單不能悄悄漂移。
function extractStringArray(src, constName) {
  const start = src.indexOf(`${constName} = [`);
  if (start === -1) return null;
  const end = src.indexOf("] as const;", start);
  const slice = src.slice(start, end);
  return [...slice.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
const schemasPermissions = extractStringArray(schemasSrc, "STAFF_PERMISSIONS");
const authSrcForPermissions = stripTs(authSrc);
const authPermissions = extractStringArray(authSrcForPermissions, "STAFF_PERMISSIONS");
// 0057 加了第十種 event.onsite.collect（現場付款收款）。
checkTrue(
  "schemas.ts 的 STAFF_PERMISSIONS 抓得到 10 個值",
  (schemasPermissions ?? []).length === 10,
);
checkTrue(
  "src/server/auth.ts 的 STAFF_PERMISSIONS 抓得到 10 個值",
  (authPermissions ?? []).length === 10,
);
check(
  "🔴 兩份 STAFF_PERMISSIONS 清單逐字一致（schemas.ts 不能悄悄漂移離 auth.ts 的真正值域）",
  JSON.stringify(schemasPermissions),
  JSON.stringify(authPermissions),
);

// =============================================================================
// [9] 路由與側欄：只有 admin 看得到連結，自己的帳號不能點編輯/移除
// =============================================================================
console.log("\n[9] 路由與側欄");

const routePath = join(ROOT, "src/routes/admin/_shell.staff.tsx");
const routeSrcRaw = readFile(routePath);
const routeSrc = stripTs(routeSrcRaw);
checkTrue(
  'Route 路徑是 "/admin/_shell/staff"',
  /createFileRoute\("\/admin\/_shell\/staff"\)/.test(routeSrc),
);
checkTrue(
  "loader 呼叫 listStaffAccounts()——非 admin 會在這裡被 adminFnMiddleware 擋下",
  /loader:\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,120}listStaffAccounts\(\)/.test(routeSrc),
);
checkTrue(
  "🔴 isSelf 判斷用 row.id === user.userId（來自 route context，不是猜的）",
  /const isSelf = row\.id === user\.userId;/.test(routeSrc),
);
checkTrue(
  "isSelf 為真時不渲染編輯/移除按鈕",
  /isSelf \? \(/.test(routeSrc) && /這是你自己的帳號/.test(routeSrc),
);
checkTrue(
  "編輯對話框角色下拉只列 CREATABLE_BACKOFFICE_ROLES（不會意外出現 vendor/customer 選項）",
  /CREATABLE_BACKOFFICE_ROLES\.map\(\(role\) =>/.test(routeSrc),
);

const shellPath = join(ROOT, "src/routes/admin/_shell.tsx");
const shellSrcRaw = readFile(shellPath);
const shellSrc = stripTs(shellSrcRaw);
const staffNavItem = shellSrc.slice(
  shellSrc.indexOf('{ to: "/admin/staff"'),
  shellSrc.indexOf('{ to: "/admin/staff"') + 120,
);
checkTrue("側欄有「後台人員」連結指到 /admin/staff", staffNavItem.length > 20);
check(
  "🔴 側欄項目是 staff: false（店員連結接不到——真正的門仍是 adminFnMiddleware）",
  /staff:\s*false/.test(staffNavItem),
  true,
);
check("不是 staff: true", /staff:\s*true/.test(staffNavItem), false);

const routeTreeSrc = readFile(join(ROOT, "src/routeTree.gen.ts"));
checkTrue(
  "routeTree.gen.ts 已經重新產生，含 /admin/_shell/staff（不是憑印象手改的孤兒路由）",
  routeTreeSrc.includes("/admin/_shell/staff"),
);

// =============================================================================
// DB 段：對真的本機 Postgres 實測 trigger、兩支 RPC 與撤權
// =============================================================================

const PG_URL = process.env.STAFF_SELFTEST_PG_URL;

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
    throw new Error(`SQL 失敗：${r.error.slice(0, 500)}\n--- SQL ---\n${sql.slice(0, 600)}`);
  return r.rows;
}

const one = (rows) => (Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
const num = (rows, field = "n") => Number(one(rows)?.[field] ?? NaN);

const EMAIL_PREFIX = "staffselftest-";
// ffff0000 區塊——避免跟 notify-selftest.mjs（eeee0000）或其他 agent 手上的
// scratch id 撞在一起。
const UID = {
  admin1: "ffff0000-0000-4000-8000-000000000001",
  admin2: "ffff0000-0000-4000-8000-000000000002",
  staff1: "ffff0000-0000-4000-8000-000000000003",
};

/** staff_permissions 沒有保護 trigger，任何時候盲刪都安全。 */
const PERMISSIONS_CLEANUP_SQL = `
delete from public.staff_permissions where user_id in ('${UID.admin1}','${UID.admin2}','${UID.staff1}');
`;

/**
 * 🔴 這裡刻意不是一支「先刪光再重建」的 CLEANUP_SQL——這是這支測試自己撞出來、
 * 值得記下來的事：一個真正從零開始、從來沒有任何一位 admin 的資料庫，
 * profiles_keep_last_admin 的檢查在任何 update／delete *之前* 就已經是
 * 「目前 admin 數 = 0」，所以**任何**一次 update／delete（即使影響 0 列、
 * 即使跟 admin 完全無關）都會被 AFTER STATEMENT trigger 擋下來——Postgres
 * 的 statement-level trigger 不管實際改了幾列都會觸發一次檢查，不是「有動到
 * admin 才觸發」。拿一個「先盲刪這三個 id」當清理的第一步，在全新資料庫上
 * 就會被自己要測的 trigger 擋下來（這支測試第一次跑就是這樣失敗的）。
 *
 * 正確作法：**第一次寫入一定要是「讓 admin 數變多」的方向**（0 → 2），而
 * insert 完全不受這支 trigger 影響（事件清單只有 delete/update，見 §1 的
 * migration 檔），所以流程分兩步：
 *
 *   1. insert auth.users（on conflict do nothing——對重跑安全）。
 *      handle_new_user()（0002）會自動幫每個人建一列 role='customer' 的
 *      profiles。
 *   2. update profiles 把 admin1／admin2 設成 admin、staff1 設成 staff。
 *      這個 update 做完之後一定有 ≥ 2 個 admin（不可能是 0），所以無論套用
 *      之前這個資料庫是全新的、還是帶著上一次沒清乾淨的殘骸，這一步永遠會
 *      成功——它只會讓 admin 數變多或不變，從來不會讓它變少。
 *
 * 這也是為什麼 [DB-8] 收尾不會、也不可能把 admin1 這一列刪掉：一旦這支
 * trigger 生效過，這個資料庫就再也不可能回到「零個 admin」的狀態——那正是
 * 這個功能存在的理由，收尾清理沒有特殊待遇，也不應該有。
 */
async function ensureFixtures() {
  await must(`
    insert into auth.users (id, email) values
      ('${UID.admin1}', '${EMAIL_PREFIX}admin1@example.invalid'),
      ('${UID.admin2}', '${EMAIL_PREFIX}admin2@example.invalid'),
      ('${UID.staff1}', '${EMAIL_PREFIX}staff1@example.invalid')
    on conflict (id) do nothing;
  `);
  await must(`
    update public.profiles set role = 'admin' where id in ('${UID.admin1}', '${UID.admin2}');
    update public.profiles set role = 'staff' where id = '${UID.staff1}';
  `);
}

if (!PG_URL) {
  skipped.push("DB 段（缺 STAFF_SELFTEST_PG_URL）");
  console.log(yellow("\n[DB] 跳過 —— 沒有 STAFF_SELFTEST_PG_URL"));
  console.log(
    yellow(
      "     設好之後重跑，才會對真的 Postgres 驗到「最後一位 admin」的保護、兩支 RPC 的" +
        "值域與自我檢查、staff_permissions 的原子性替換，以及 anon/authenticated 真的被撤權。指令見本檔檔頭。",
    ),
  );
} else {
  try {
    if (process.env.STAFF_SELFTEST_APPLY === "1") {
      console.log("\n[DB-0] 套用 0001–0033（STAFF_SELFTEST_APPLY=1，0008 跳過）");
      // Supabase 特有的東西本機沒有：auth.users / storage.* 是 0001–0003 要的，
      // 三個 role 是每一支 migration 的 grant 要的。做法與 notify-selftest.mjs 的
      // NOTIFY_SELFTEST_APPLY 完全一致（同一個 repo 的既有手法，這裡不重新發明）。
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
          raw_user_meta_data jsonb, created_at timestamptz not null default now(),
          -- 0030_customer_accounts.sql §0 的前置檢查要這兩欄才套得過去
          -- （claim_guest_orders 的兩道閘：未驗證信箱、已刪除帳號）。
          -- notify-selftest.mjs 的原始 stub（寫於 0022 那一期）沒有這兩欄，
          -- 這裡是為了讓 apply 迴圈走到 0033 而補的，兩份 stub 目前因此有差異。
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
      `);

      const { readdirSync } = await import("node:fs");
      const migFiles = readdirSync(MIG_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of migFiles) {
        // 0008 要 pg_net + vault + pg_cron，本機沒有——與 notify-selftest.mjs 同一個
        // 理由跳過。0001–0007、0009–0033 全部照磁碟順序套用。
        if (f.startsWith("0008_")) continue;
        const r = await q(readFileSync(join(MIG_DIR, f), "utf8"));
        if (!r.ok) throw new Error(`套用 ${f} 失敗：${r.error.slice(0, 800)}`);
      }
      checkTrue("0001–0033 套用完成（0008 跳過）", true);

      const ready = one(
        await must(
          `select (to_regprocedure('public.admin_update_profile_role(uuid,uuid,text)') is not null) ok`,
        ),
      );
      checkTrue("套用後 admin_update_profile_role 存在", ready?.ok === true);
    }

    const readyCheck = one(
      await must(
        `select (to_regprocedure('public.admin_update_profile_role(uuid,uuid,text)') is not null) ok`,
      ),
    );
    const ready = readyCheck?.ok === true;

    if (!ready) {
      skipped.push("DB 段（這個資料庫還沒套用 0033）");
      console.log(
        yellow(
          "\n[DB] 跳過 —— 連得上，但這個資料庫還沒套用 0033（admin_update_profile_role 不存在）。" +
            "加 STAFF_SELFTEST_APPLY=1 重跑會先套用。",
        ),
      );
    } else {
      console.log(
        "\n[DB-1] 前置：清掉舊的細權限殘骸，用「insert 再 update」的安全順序建立三個測試身分",
      );
      // 為什麼不是一支盲刪的 CLEANUP_SQL——見 ensureFixtures() 上面那一大段
      // 註解，這是這支測試自己在第一次執行時撞出來的真實教訓。
      await must(PERMISSIONS_CLEANUP_SQL);
      await ensureFixtures();
      // ensureFixtures() 內部故意用原生 SQL 而不是走 admin_update_profile_role
      // RPC——這一步是「布置場景」，不是「測試那支 RPC」，先讓兩個人是 admin、
      // 一個是 staff，後面 [DB-2] 起才開始真正測 RPC 本身的行為。
      check(
        "布置完成：目前恰好 2 位 admin",
        num(await must(`select count(*)::int n from public.profiles where role='admin'`)),
        2,
        "下面的測試假設場景是 2 admin + 1 staff；不是 2 代表清理或種子沒做對，後面的斷言都不可信",
      );

      // -----------------------------------------------------------------------
      // [DB-2] 🔴 admin_update_profile_role：值域排除 vendor（真的打一次）
      // -----------------------------------------------------------------------
      console.log("\n[DB-2] 🚨 角色值域：vendor 被拒，customer 允許（對照組，證明不是隨便擋）");
      const vendorAttempt = await q(
        `select * from public.admin_update_profile_role('${UID.admin1}', '${UID.staff1}', 'vendor')`,
      );
      checkTrue("設成 vendor 被拒絕", !vendorAttempt.ok);
      if (!vendorAttempt.ok) {
        checkTrue("錯誤是 INVALID_ROLE", /INVALID_ROLE/.test(vendorAttempt.error));
      }
      check(
        "staff1 的角色沒有被改動",
        one(await must(`select role from public.profiles where id='${UID.staff1}'`))?.role,
        "staff",
      );

      const customerAttempt = one(
        await must(
          `select * from public.admin_update_profile_role('${UID.admin1}', '${UID.staff1}', 'customer')`,
        ),
      );
      check("對照組：設成 customer 成功（customer 在值域內）", customerAttempt?.role, "customer");
      // 改回 staff，後面的測試還要用到這個身分。
      await must(
        `select public.admin_update_profile_role('${UID.admin1}', '${UID.staff1}', 'staff')`,
      );

      // -----------------------------------------------------------------------
      // [DB-3] 🔴 admin_update_profile_role：不能改自己
      // -----------------------------------------------------------------------
      console.log("\n[DB-3] 🔴 不能改自己的角色（p_actor_id = p_target_id）");
      const selfAttempt = await q(
        `select * from public.admin_update_profile_role('${UID.admin1}', '${UID.admin1}', 'staff')`,
      );
      checkTrue("actor 與 target 相同時被拒絕", !selfAttempt.ok);
      if (!selfAttempt.ok) {
        checkTrue(
          "錯誤是 CANNOT_CHANGE_OWN_ROLE",
          /CANNOT_CHANGE_OWN_ROLE/.test(selfAttempt.error),
        );
      }
      check(
        "admin1 的角色沒有被改動（還是 admin）",
        one(await must(`select role from public.profiles where id='${UID.admin1}'`))?.role,
        "admin",
      );

      // -----------------------------------------------------------------------
      // [DB-4] 🔴🔴 最後一位 admin：UPDATE 會被 trigger 擋下來
      // -----------------------------------------------------------------------
      console.log("\n[DB-4] 🔴🔴 最後一位 admin：降級被 profiles_keep_last_admin 擋下來（UPDATE）");
      // 目前 2 個 admin（admin1、admin2）。先降 admin2（還剩 admin1）：應該成功。
      const demoteNotLast = one(
        await must(
          `select * from public.admin_update_profile_role('${UID.staff1}', '${UID.admin2}', 'staff')`,
        ),
      );
      check("還有另一位 admin 在，降級成功", demoteNotLast?.role, "staff");
      check(
        "目前恰好 1 位 admin",
        num(await must(`select count(*)::int n from public.profiles where role='admin'`)),
        1,
      );

      // 現在只剩 admin1 一位 admin。再降它 —— 必須被擋。
      const demoteLast = await q(
        `select * from public.admin_update_profile_role('${UID.staff1}', '${UID.admin1}', 'staff')`,
      );
      checkTrue("🚨 降級最後一位 admin 被拒絕", !demoteLast.ok);
      if (!demoteLast.ok) {
        checkTrue("錯誤是 LAST_ADMIN", /LAST_ADMIN/.test(demoteLast.error));
      }
      check(
        "admin1 的角色沒有被改動（還是 admin）——擋下來不是先改了才回滾",
        one(await must(`select role from public.profiles where id='${UID.admin1}'`))?.role,
        "admin",
      );
      check(
        "🔴 admin 人數還是 1，不是 0——trigger 真的擋住了，不是誤判成功",
        num(await must(`select count(*)::int n from public.profiles where role='admin'`)),
        1,
      );

      // -----------------------------------------------------------------------
      // [DB-5] 🔴🔴 最後一位 admin：DELETE 也會被擋下來
      // -----------------------------------------------------------------------
      console.log("\n[DB-5] 🔴🔴 最後一位 admin：直接 DELETE 那一列也被擋下來");
      const deleteLast = await q(`delete from public.profiles where id = '${UID.admin1}'`);
      checkTrue("🚨 刪除最後一位 admin 的 profiles 列被拒絕", !deleteLast.ok);
      if (!deleteLast.ok) {
        checkTrue("錯誤是 LAST_ADMIN", /LAST_ADMIN/.test(deleteLast.error));
      }
      check(
        "那一列還在（沒有先刪了才回滾成空）",
        num(await must(`select count(*)::int n from public.profiles where id='${UID.admin1}'`)),
        1,
      );

      // 反面對照：把 admin2 再升回 admin（現在 2 位），這時候刪掉 admin2 應該成功
      // ——證明 trigger 擋的是「歸零」，不是無差別擋住所有 admin 的 delete/update。
      await must(
        `select public.admin_update_profile_role('${UID.staff1}', '${UID.admin2}', 'admin')`,
      );
      check(
        "反面對照前置：現在有 2 位 admin",
        num(await must(`select count(*)::int n from public.profiles where role='admin'`)),
        2,
      );
      const deleteNotLast = await q(`delete from public.profiles where id = '${UID.admin2}'`);
      checkTrue("反面對照：還有另一位 admin 在時，刪除成功", deleteNotLast.ok);
      check(
        "🔴 反面對照：admin 人數回到 1（真的刪掉了，trigger 沒有無差別擋住）",
        num(await must(`select count(*)::int n from public.profiles where role='admin'`)),
        1,
      );
      // admin2 的 auth.users 列也在這裡一併清掉——它的 profiles 列已經在上面
      // 被刪了，[DB-8] 收尾不會再處理它。
      await must(`delete from auth.users where id = '${UID.admin2}'`);

      // -----------------------------------------------------------------------
      // [DB-6] 🔴 admin_replace_staff_permissions：原子性——插入失敗不會清空舊資料
      // -----------------------------------------------------------------------
      console.log(
        "\n[DB-6] 🔴 staff_permissions 原子替換：非法權限字串讓整個呼叫失敗，舊資料原封不動",
      );
      await must(`delete from public.staff_permissions where user_id = '${UID.staff1}'`);
      await must(
        `select public.admin_replace_staff_permissions('${UID.staff1}', array['approve_products','approve_purchases'], '${UID.admin1}')`,
      );
      check(
        "前置：staff1 現在有 2 筆權限",
        num(
          await must(
            `select count(*)::int n from public.staff_permissions where user_id='${UID.staff1}'`,
          ),
        ),
        2,
      );

      const badReplace = await q(
        `select public.admin_replace_staff_permissions('${UID.staff1}', array['approve_vendors','not_a_real_permission'], '${UID.admin1}')`,
      );
      checkTrue("含一個非法權限字串的整批替換失敗（CHECK constraint）", !badReplace.ok);
      check(
        "🔴🔴 舊的 2 筆權限原封不動——delete 沒有先偷跑，證明 delete+insert 真的在同一個交易",
        num(
          await must(
            `select count(*)::int n from public.staff_permissions where user_id='${UID.staff1}'`,
          ),
        ),
        2,
      );
      check(
        "而且內容真的是原本那兩筆，不是巧合湊出 2 這個數字",
        (
          await must(
            `select permission from public.staff_permissions where user_id='${UID.staff1}' order by permission`,
          )
        )
          .map((r) => r.permission)
          .sort(),
        ["approve_products", "approve_purchases"],
      );

      console.log("\n[DB-6b] 反面對照：全部合法的替換會成功，而且是「替換」不是「疊加」");
      const goodReplace = await q(
        `select public.admin_replace_staff_permissions('${UID.staff1}', array['event.roster.read'], '${UID.admin1}')`,
      );
      checkTrue("全部合法時替換成功", goodReplace.ok);
      check(
        "現在恰好 1 筆，而且是新的那個值——舊的兩筆被換掉了，不是疊加",
        (
          await must(
            `select permission from public.staff_permissions where user_id='${UID.staff1}'`,
          )
        ).map((r) => r.permission),
        ["event.roster.read"],
      );

      console.log("\n[DB-6c] 空陣列＝把權限全部收回");
      await must(
        `select public.admin_replace_staff_permissions('${UID.staff1}', array[]::text[], '${UID.admin1}')`,
      );
      check(
        "空陣列後 0 筆",
        num(
          await must(
            `select count(*)::int n from public.staff_permissions where user_id='${UID.staff1}'`,
          ),
        ),
        0,
      );

      // -----------------------------------------------------------------------
      // [DB-7] 🚨 anon / authenticated 呼叫兩支 RPC 都要被拒絕（PostgREST 端點）
      // -----------------------------------------------------------------------
      console.log("\n[DB-7] 🚨 anon/authenticated 直接呼叫這兩支 RPC 必須被拒絕");
      // 🔴 目標刻意是 staff1、新角色是它自己已經有的 'staff'（等同 no-op 的內容，
      // 但 SQL 執行上仍是一次真的 UPDATE），actor 是 admin1——不是「把 admin1
      // 降級」。這是 mutation 測試自己撞出來的教訓：第一版這裡用的是「把 admin1
      // 降成 staff」，那個呼叫**不管有沒有權限都會失敗**——因為 admin1 是目前
      // 唯一的 admin，會被 profiles_keep_last_admin 擋下來，LAST_ADMIN 這個
      // 「別的原因」的失敗把「權限被拒絕」這件事蓋過去了。用 M6（不小心多
      // grant 給 authenticated）驗證時就看到假陰性：authenticated 那一條照樣
      // 顯示「被拒絕」，因為呼叫本來就會因為別的理由失敗，不是因為它真的沒有
      // 權限。換成 staff1（不影響 admin 人數、不會撞任何業務規則）之後，
      // 「呼叫失敗」才只可能是權限不足，重跑同一個 M6 mutation 才真的抓到了洩漏。
      const anonRole = await q(
        `set role anon; select public.admin_update_profile_role('${UID.admin1}', '${UID.staff1}', 'staff');`,
      );
      checkTrue("anon 呼叫 admin_update_profile_role 被拒絕", !anonRole.ok);
      if (!anonRole.ok)
        checkTrue("是權限不足，不是別的錯誤蓋過去", /permission denied/i.test(anonRole.error));

      const authRole = await q(
        `set role authenticated; select public.admin_update_profile_role('${UID.admin1}', '${UID.staff1}', 'staff');`,
      );
      checkTrue("authenticated 呼叫 admin_update_profile_role 也被拒絕", !authRole.ok);
      if (!authRole.ok)
        checkTrue(
          "🔴 也是權限不足，不是撞到 LAST_ADMIN 之類的業務規則把假陰性蓋過去",
          /permission denied/i.test(authRole.error),
        );

      const anonPerm = await q(
        `set role anon; select public.admin_replace_staff_permissions('${UID.staff1}', array[]::text[], '${UID.admin1}');`,
      );
      checkTrue("anon 呼叫 admin_replace_staff_permissions 被拒絕", !anonPerm.ok);

      const authPerm = await q(
        `set role authenticated; select public.admin_replace_staff_permissions('${UID.staff1}', array[]::text[], '${UID.admin1}');`,
      );
      checkTrue("authenticated 呼叫 admin_replace_staff_permissions 也被拒絕", !authPerm.ok);

      // 反面對照：admin1 目前還是唯一的 admin，這件事本身沒有被上面任何一次
      // 「應該失敗」的呼叫意外改掉。
      check(
        "收尾前對照：admin 人數依然是 1（前面每一次「應該失敗」的呼叫都真的沒有生效）",
        num(await must(`select count(*)::int n from public.profiles where role='admin'`)),
        1,
      );

      console.log("\n[DB-8] 收尾：清掉 staff1（admin2 在 [DB-5] 已經刪過了）");
      // 🔴 刻意不刪 admin1：見 ensureFixtures() 上面那段註解——這個資料庫現在
      // 已經有過 admin，profiles_keep_last_admin 從此不允許它回到零個 admin，
      // 收尾清理也不例外。留著它、角色仍是 admin，正是這支 trigger 應該有的
      // 效果，不是清理沒做乾淨。
      await must(PERMISSIONS_CLEANUP_SQL);
      await must(`delete from public.profiles where id = '${UID.staff1}'`);
      await must(`delete from auth.users where id in ('${UID.staff1}', '${UID.admin2}')`);
      check(
        "staff1／admin2 清乾淨了",
        num(
          await must(
            `select count(*)::int n from public.profiles where id in ('${UID.admin2}','${UID.staff1}')`,
          ),
        ),
        0,
      );
      checkTrue(
        "🔴 admin1 依然存在、角色依然是 admin——不是漏清，是這支 trigger 生效之後" +
          "唯一可能的收尾狀態；下次重跑 ensureFixtures() 會直接沿用這一列",
        one(await must(`select role from public.profiles where id='${UID.admin1}'`))?.role ===
          "admin",
      );
    }
  } catch (err) {
    fail += 1;
    console.log(red(`\n  ✗ DB 段中斷：${String(err.message ?? err).slice(0, 800)}`));
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
