#!/usr/bin/env node
/**
 * admin-order-registration-cleanup-selftest.mjs —— 0035 的自檢
 * （後台訂單刪除／封存、報名名單移除單筆）
 *
 * 動機：後台到 0034 為止沒有任何一種「移除」——測試訂單清不掉、客人臨時說不來的
 * 報名也改不了，唯一的解法是進 Supabase Dashboard 手改，而手改最容易漏掉的正是
 * 「把名額還回去」（0020 §2 的不變量：`event_registrations` 上一個 trigger 都沒有，
 * `event_sessions.seats_taken` 只由 reserve_session_seat() / release_session_seat() /
 * expire_unpaid_orders() 維護）。0035 把這條路徑收進資料庫本身：
 *
 *   admin_delete_order()         未付款／已取消的訂單，真的刪（擋已付款、擋已進
 *                                 inv.sales）
 *   admin_archive_order()        已付款訂單的可逆替身，只設／清 archived_at
 *   admin_delete_registration()  名單單筆移除，seats_taken 自動還 1
 *
 * 分三段，理由與 remittance-selftest / admin-orders-selftest 相同：這支測試在沒有
 * 資料庫的機器上也必須有意義。
 *
 *   [靜態]  讀 0035 的 SQL 原始碼、_shell.tsx（電商排在內容管理前面）、
 *           名單頁（2026-10-25 從 _shell.registrations.tsx 的彈窗搬成內頁：
 *           SessionRosterTable.tsx 的每一列「移除」與確認對話框、SessionRosterPage.tsx
 *           移除成功後的本地過濾＋invalidate）、
 *           event-registrations.ts 的檔頭（指向合法的新刪除路徑）。**永遠會跑。**
 *
 *   [連線]  對一個真的 PostgreSQL 跑三支 SQL 函式本人（不經過 TypeScript），驗的是
 *           任務驗收條件裡那五條「名額」與兩條「拒絕路徑」——包含**逐表 md5 比對**
 *           證明封存／拒絕路徑真的一個位元組都沒動，不是只看回傳值。另外用同一套
 *           shim 技巧（同 admin-orders-selftest.mjs）驅動
 *           deleteAdminRegistration() 這個 TypeScript 包裝本人一次，確認參數名稱與
 *           回傳值解析正確——deleteAdminOrder()／archiveAdminOrder() 這兩個包裝則是
 *           admin-orders-selftest.mjs 既有 shim 的自然延伸（它已經在驅動同一個
 *           repo 檔案裡的 markOrderPaidByAdmin()），這裡不重複建第二套 shim。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它只認 ADMIN_CLEANUP_SELFTEST_PG_URL，而那個
 *    變數要自己設；沒設就整段 skip（會印出來，不會靜悄悄消失）。假設那個資料庫已經
 *    套到 0034（跑 remittance-selftest.mjs 的 REMITTANCE_SELFTEST_APPLY=1 一次就會
 *    有——同一個 ib_0034_test，不是另外建一個），這裡的 APPLY 旗標只補套 0035 這
 *    一支：
 *
 *     ADMIN_CLEANUP_SELFTEST_PG_URL=postgres:///ib_0034_test \
 *     ADMIN_CLEANUP_SELFTEST_APPLY=1 node scripts/admin-order-registration-cleanup-selftest.mjs
 *
 * 測試資料一律用 idempotency_key like 'a35-%' 做記號，執行前後各清一次，不會撞到
 * 'rmt34-%'／'ao-selftest-%' 這兩支既有測試的前綴。
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
} from "./lib/migration-ledger.mjs";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-order-registration-cleanup-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");
const MIG_0035 = join(MIG_DIR, "0035_admin_order_registration_cleanup.sql");
const SHELL_PATH = join(ROOT, "src/routes/admin/_shell.tsx");
// 2026-10-25 後台第 2 批：名單從 _shell.registrations.tsx 的彈窗改成內頁
// /admin/registrations/$sessionId。移除按鈕＋確認框在 SessionRosterTable.tsx，
// 「成功後 invalidate」在 SessionRosterPage.tsx（2026-10-26 名單改由 loader 讀、不寫查閱
// 紀錄，invalidate 會連名單一起重抓，不再需要本地濾掉）。
const REG_ROUTE_PATH = join(ROOT, "src/components/admin/SessionRosterTable.tsx");
const REG_PAGE_PATH = join(ROOT, "src/components/admin/SessionRosterPage.tsx");
const REG_REPO_PATH = join(ROOT, "src/server/repos/event-registrations.ts");
const REG_ADMIN_REPO_PATH = join(ROOT, "src/server/repos/event-registrations-admin.ts");
const REG_FNS_PATH = join(ROOT, "src/lib/admin/fns/event-registrations.ts");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 remittance-selftest.mjs / admin-orders-selftest.mjs 同一套，
// 逐檔各自一份是這個 repo 的慣例）
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
const checkTrue = (label, value, hint) => check(label, value === true, true, hint);
const checkFalse = (label, value, hint) => check(label, value === false, true, hint);

/** 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串（見 run-selftests.mjs 守門 4）。 */
function readFile(p) {
  if (!existsSync(p)) {
    throw new Error(
      `selftest 讀不到檔案：${p}（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串——` +
        `回空字串會讓所有「確認原始碼裡沒有 X」的否定斷言靜默通過。）`,
    );
  }
  return readFileSync(p, "utf8");
}

/** 拿掉 TypeScript／SQL 的行內與區塊註解（同 remittance-selftest.mjs 的 stripTs）。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/** 從 startMarker 切到下一個 endMarker（找不到 endMarker 就切到檔尾）。 */
function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) return "";
  const end = src.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? src.slice(start) : src.slice(start, end);
}

console.log("═══ 0035 自檢（訂單刪除／封存、名單移除單筆）═══");

// =============================================================================
// [1] 反空殼：檔案都在，都不是空檔
// =============================================================================
console.log("\n[1] 檔案盤點");
for (const [label, p] of [
  ["migration 0035", MIG_0035],
  ["_shell.tsx", SHELL_PATH],
  ["SessionRosterTable.tsx", REG_ROUTE_PATH],
  ["SessionRosterPage.tsx", REG_PAGE_PATH],
  ["repo/event-registrations.ts", REG_REPO_PATH],
  ["repo/event-registrations-admin.ts", REG_ADMIN_REPO_PATH],
  ["fns/event-registrations.ts", REG_FNS_PATH],
]) {
  checkTrue(`${label} 存在`, existsSync(p));
}
const sql0035Raw = readFile(MIG_0035);
const shellSrcRaw = readFile(SHELL_PATH);
const regRouteSrcRaw = readFile(REG_ROUTE_PATH);
const regPageSrcRaw = readFile(REG_PAGE_PATH);
const regRepoSrcRaw = readFile(REG_REPO_PATH);
const regAdminRepoSrcRaw = readFile(REG_ADMIN_REPO_PATH);
const regFnsSrcRaw = readFile(REG_FNS_PATH);

checkTrue("migration 0035 不是空檔", sql0035Raw.length > 3000);
checkTrue("SessionRosterTable.tsx 不是空檔", regRouteSrcRaw.length > 2000);
checkTrue("SessionRosterPage.tsx 不是空檔", regPageSrcRaw.length > 2000);
checkTrue("repo/event-registrations-admin.ts 不是空檔", regAdminRepoSrcRaw.length > 500);

const sql0035 = stripTs(sql0035Raw);
const shellSrc = stripTs(shellSrcRaw);
const regRouteSrc = stripTs(regRouteSrcRaw);
const regPageSrc = stripTs(regPageSrcRaw);
const regRepoSrc = stripTs(regRepoSrcRaw);
const regAdminRepoSrc = stripTs(regAdminRepoSrcRaw);
const regFnsSrc = stripTs(regFnsSrcRaw);

// =============================================================================
// [2] migration 帳本
// =============================================================================
console.log("\n[2] migration 帳本");
assertLedgerMatchesDisk(check, MIG_DIR);
assertLedgerDeclarationsHonest(check, MIG_DIR);
// 這支自檢本來就是為 0035 寫的，所以跟其他六支「後來的 migration 動到我在乎的
// 東西，我要回頭確認」不一樣：dependsOn 列的就是這支 migration touches 的六個區域
// 本身（見 migration-ledger.mjs 的那一列），reviewedThrough 因此指向自己——只要
// 之後有 0036 動到這六個區域，這條會轉紅，逼下一個人回來重讀。
assertMigrationDependencies(check, MIG_DIR, {
  suite: "admin-order-registration-cleanup-selftest",
  dependsOn: [
    "orders_payments",
    "order_expiry",
    "products_availability",
    "session_seats",
    "event_registrations",
    "inventory",
  ],
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
// [3] 🔴 三支函式的簽章、security definer、search_path、grants
// =============================================================================
console.log("\n[3] 🔴 三支函式的簽章與安全設定");
{
  checkTrue(
    "orders.archived_at 是 nullable 的 timestamptz（沒有 not null）",
    /add column if not exists archived_at timestamptz;/.test(sql0035),
  );
  checkTrue(
    "部分索引 orders_not_archived_idx where archived_at is null",
    /create index if not exists orders_not_archived_idx[\s\S]{0,80}where archived_at is null;/.test(
      sql0035,
    ),
  );

  const fnSpecs = [
    {
      name: "admin_delete_order",
      sig: "public.admin_delete_order(uuid, uuid)",
      declStart: "create or replace function public.admin_delete_order(",
      params: ["p_order_id uuid", "p_actor_id uuid"],
      returnsCols: ["deleted", "reason", "order_no"],
    },
    {
      name: "admin_archive_order",
      sig: "public.admin_archive_order(uuid, uuid, boolean)",
      declStart: "create or replace function public.admin_archive_order(",
      params: ["p_order_id  uuid", "p_actor_id  uuid", "p_archived  boolean"],
      returnsCols: ["updated", "reason", "order_no"],
    },
    {
      name: "admin_delete_registration",
      sig: "public.admin_delete_registration(uuid, uuid)",
      declStart: "create or replace function public.admin_delete_registration(",
      params: ["p_registration_id uuid", "p_actor_id        uuid"],
      returnsCols: ["deleted", "reason", "freed"],
    },
  ];

  for (const spec of fnSpecs) {
    const fnSrc = sliceBetween(sql0035, spec.declStart, "\n$$;");
    checkTrue(`抓得到 ${spec.name} 的函式本體`, fnSrc.length > 100);
    for (const p of spec.params) {
      checkTrue(`${spec.name} 有參數 \`${p.trim()}\``, fnSrc.includes(p));
    }
    for (const col of spec.returnsCols) {
      checkTrue(
        `${spec.name} 的 RETURNS TABLE 有欄位 ${col}`,
        new RegExp(`\\b${col}\\b`).test(fnSrc),
      );
    }
    checkTrue(`🔴 ${spec.name} 是 security definer`, /security definer/.test(fnSrc));
    checkTrue(`🔴 ${spec.name} 的 search_path 是空字串`, /set search_path = ''/.test(fnSrc));
    checkTrue(`${spec.name} 是 plpgsql`, /language plpgsql/.test(fnSrc));
  }

  // 權限：revoke from public/anon/authenticated、只 grant service_role，同 0020 §11／
  // 0034 §5 的 do-block 手法。
  const grantBlock = sliceBetween(sql0035, "foreach sig in array array[", "end $$;");
  checkTrue("抓得到權限 do-block", grantBlock.length > 100);
  for (const sig of [
    "public.admin_delete_order(uuid, uuid)",
    "public.admin_archive_order(uuid, uuid, boolean)",
    "public.admin_delete_registration(uuid, uuid)",
  ]) {
    checkTrue(`🔴 權限清單裡有 ${sig}`, grantBlock.includes(`'${sig}'`));
  }
  checkTrue("🔴 revoke from public", /revoke execute on function %s from public/.test(grantBlock));
  checkTrue(
    "🔴 revoke from anon, authenticated",
    /revoke execute on function %s from anon, authenticated/.test(grantBlock),
  );
  checkTrue(
    "🔴 只 grant service_role",
    /grant\s+execute on function %s to service_role/.test(grantBlock),
  );
}

// =============================================================================
// [4] 🔴 reason 值域逐字比對任務書給的清單
// =============================================================================
console.log("\n[4] 🔴 reason 值域");
{
  const deleteOrderFnSrc = sliceBetween(
    sql0035,
    "create or replace function public.admin_delete_order(",
    "\n$$;",
  );
  for (const reason of ["order_not_found", "order_is_paid", "has_inventory_sale", "deleted"]) {
    checkTrue(`admin_delete_order 回得出 '${reason}'`, deleteOrderFnSrc.includes(`'${reason}'`));
  }
  checkTrue(
    "🔴 admin_delete_order 剛好四種 reason 字面值（沒有多也沒有少）",
    (deleteOrderFnSrc.match(/'(order_not_found|order_is_paid|has_inventory_sale|deleted)'/g) ?? [])
      .length >= 4,
  );

  const archiveOrderFnSrc = sliceBetween(
    sql0035,
    "create or replace function public.admin_archive_order(",
    "\n$$;",
  );
  for (const reason of ["order_not_found", "archived", "unarchived"]) {
    checkTrue(`admin_archive_order 回得出 '${reason}'`, archiveOrderFnSrc.includes(`'${reason}'`));
  }

  const deleteRegFnSrc = sliceBetween(
    sql0035,
    "create or replace function public.admin_delete_registration(",
    "\n$$;",
  );
  for (const reason of ["registration_not_found", "deleted"]) {
    checkTrue(
      `admin_delete_registration 回得出 '${reason}'`,
      deleteRegFnSrc.includes(`'${reason}'`),
    );
  }
}

// =============================================================================
// [5] 🔴 admin_delete_order：閘門順序、鎖順序、release-before-delete
// =============================================================================
console.log("\n[5] 🔴 admin_delete_order 的閘門與順序");
{
  const fnSrc = sliceBetween(
    sql0035,
    "create or replace function public.admin_delete_order(",
    "\n$$;",
  );
  const orderLockIdx = fnSrc.indexOf("for update;");
  const paidGateIdx = fnSrc.indexOf("payment_status = 'paid'");
  const salesGateIdx = fnSrc.indexOf("inv.sales");
  const releaseInvIdx = fnSrc.indexOf("release_inventory_reservations(p_order_id)");
  const releaseSeatLoopIdx = fnSrc.indexOf("release_session_seat(v_item.id)");
  const deleteIdx = fnSrc.indexOf("delete from public.orders");

  checkTrue(
    "反空殼：五個標記都找得到",
    [orderLockIdx, paidGateIdx, salesGateIdx, releaseInvIdx, releaseSeatLoopIdx, deleteIdx].every(
      (i) => i > -1,
    ),
  );
  checkTrue("🔴 先鎖訂單列，再檢查 payment_status", orderLockIdx < paidGateIdx);
  checkTrue("🔴 payment_status 閘在 inv.sales 閘之前", paidGateIdx < salesGateIdx);
  checkTrue(
    "🔴 兩道閘都在真的 DELETE 之前（不會讓 FK 違規冒出來給使用者）",
    salesGateIdx < deleteIdx,
  );
  checkTrue(
    "🔴 release_inventory_reservations 在刪除之前",
    releaseInvIdx > -1 && releaseInvIdx < deleteIdx,
  );
  checkTrue(
    "🔴 release_session_seat 迴圈在刪除之前（0020:115-120 的規矩：先還、後刪）",
    releaseSeatLoopIdx > -1 && releaseSeatLoopIdx < deleteIdx,
  );
  checkTrue(
    "🔴 release_inventory_reservations 在 release_session_seat 之前（鎖順序 products → inv.products → event_sessions，同 0020 §4）",
    releaseInvIdx < releaseSeatLoopIdx,
  );

  // 型錄庫存還原：只在 status = 'pending' 時做，避免對已 cancelled 的訂單重複入帳
  // （這支自己發現的第五個坑，見 migration §1.5）。
  checkTrue(
    "🔴 型錄庫存還原被 `if v_order.status = 'pending' then` 包住",
    /if v_order\.status = 'pending' then[\s\S]{0,600}set stock = p\.stock \+ agg\.qty/.test(fnSrc),
  );
  const pendingGateIdx = fnSrc.indexOf("if v_order.status = 'pending' then");
  checkTrue(
    "🔴 pending 閘門在 release_inventory_reservations 之前（型錄庫存也照 products → inv.products → event_sessions 排）",
    pendingGateIdx > -1 && pendingGateIdx < releaseInvIdx,
  );

  checkTrue(
    "迴圈對每一個 order_item 呼叫（不自己判斷 product_type——release_session_seat 對沒有報名的 item 是 no-op）",
    /for v_item in select id from public\.order_items where order_id = p_order_id loop/.test(fnSrc),
  );
}

// =============================================================================
// [6] admin_archive_order：可逆、不動名額、保留第一次封存時間
// =============================================================================
console.log("\n[6] admin_archive_order 的可逆設計");
{
  const fnSrc = sliceBetween(
    sql0035,
    "create or replace function public.admin_archive_order(",
    "\n$$;",
  );
  checkFalse(
    "🔴 沒有呼叫 release_session_seat 或 release_inventory_reservations（不動名額）",
    /release_session_seat|release_inventory_reservations/.test(fnSrc),
  );
  checkFalse("🔴 沒有 delete from（不刪任何東西）", /delete from/.test(fnSrc));
  checkTrue(
    "封存用 coalesce(archived_at, now())，保留第一次封存的時間",
    /coalesce\(o\.archived_at, now\(\)\)/.test(fnSrc),
  );
  checkTrue("取消封存設回 null", /else null end/.test(fnSrc));
}

// =============================================================================
// [7] admin_delete_registration：形狀照抄 release_session_seat，但只刪一列
// =============================================================================
console.log("\n[7] admin_delete_registration 的粒度");
{
  const fnSrc = sliceBetween(
    sql0035,
    "create or replace function public.admin_delete_registration(",
    "\n$$;",
  );
  checkTrue(
    "🔴 用 for no key update 鎖場次（同 release_session_seat，不與 order_items 外鍵的 FOR KEY SHARE 升級死鎖）",
    /for no key update/.test(fnSrc),
  );
  checkTrue(
    "🔴 delete 用 r.id = p_registration_id（單一列），不是 order_item_id（整批）",
    /delete from public\.event_registrations r where r\.id = p_registration_id/.test(fnSrc),
  );
  checkFalse(
    "🔴 沒有用 order_item_id 當刪除條件（那會連坐同一個 order_item 的其他人）",
    /delete from public\.event_registrations r where r\.order_item_id/.test(fnSrc),
  );
  checkTrue(
    "🔴 seats_taken 用 greatest(0, …) 兜底，不會變負數",
    /seats_taken = greatest\(0, s\.seats_taken - 1\)/.test(fnSrc),
  );
  checkTrue(
    "沒有檢查 payment_status（已付款的也允許刪，UI 端示警）",
    !/payment_status/.test(fnSrc),
  );
}

// =============================================================================
// [8] 🔴 側欄：電商排在內容管理前面
// =============================================================================
console.log("\n[8] 🔴 側欄分組順序");
{
  const navStart = shellSrc.indexOf("const NAV_GROUPS");
  const navSrc =
    navStart === -1 ? "" : shellSrc.slice(navStart, shellSrc.indexOf("] as const;", navStart));
  checkTrue("NAV_GROUPS 切得出來", navSrc.length > 0);

  const groupHeads = [...navSrc.matchAll(/\n {2}\{\s*\n(?:[\s\S]{0,400}?)label: "([^"]+)"/g)].map(
    (m) => ({ index: m.index, label: m[1] }),
  );
  checkTrue(
    "反空殼：切得出至少兩組 label",
    groupHeads.length >= 2,
    `實得：${groupHeads.map((g) => g.label).join(", ")}`,
  );
  const ecommerceIdx = groupHeads.find((g) => g.label === "電商")?.index;
  const cmsIdx = groupHeads.find((g) => g.label === "內容管理")?.index;
  checkTrue(
    "🔴 找得到「電商」與「內容管理」兩組",
    typeof ecommerceIdx === "number" && typeof cmsIdx === "number",
  );
  checkTrue(
    "🔴 「電商」排在「內容管理」前面（0035 的要求）",
    typeof ecommerceIdx === "number" && typeof cmsIdx === "number" && ecommerceIdx < cmsIdx,
  );

  // 反面對照：如果順序反過來，上面那條斷言應該要抓到——用一段假資料證明偵測邏輯
  // 本身分得出前後。
  const fakeNav =
    '{\n    label: "內容管理",\n    items: [],\n  },\n  {\n    label: "電商",\n    items: [],\n  },';
  const fakeHeads = [...fakeNav.matchAll(/\n {2}\{\s*\n(?:[\s\S]{0,400}?)label: "([^"]+)"/g)].map(
    (m) => ({ index: m.index, label: m[1] }),
  );
  const fakeEc = fakeHeads.find((g) => g.label === "電商")?.index;
  const fakeCms = fakeHeads.find((g) => g.label === "內容管理")?.index;
  check(
    "反面對照：順序反過來時偵測邏輯回 false（不是永遠 true 的空殼）",
    typeof fakeEc === "number" && typeof fakeCms === "number" && fakeEc < fakeCms,
    false,
  );
}

// =============================================================================
// [9] event-registrations.ts 檔頭指向合法的新刪除路徑；仍然零寫入
// =============================================================================
console.log("\n[9] event-registrations.ts 檔頭與零寫入");
{
  checkFalse("registrations 主 repo 沒有 insert", /\.insert\(/.test(regRepoSrc));
  checkFalse("registrations 主 repo 沒有 delete", /\.delete\(/.test(regRepoSrc));
  checkFalse("registrations 主 repo 沒有 update", /\.update\(/.test(regRepoSrc));
  checkTrue(
    "🔴 檔頭指名新的合法刪除路徑是 event-registrations-admin.ts",
    /event-registrations-admin\.ts/.test(regRepoSrcRaw),
  );
  checkTrue("🔴 檔頭提到 deleteAdminRegistration", /deleteAdminRegistration/.test(regRepoSrcRaw));

  checkFalse(
    "🔴 新的 admin repo 檔案也不是 insert（唯一的寫入是 delete，且只透過 RPC）",
    /\.insert\(/.test(regAdminRepoSrc),
  );
  checkFalse(
    "🔴 新的 admin repo 檔案沒有裸的 .delete(（只透過 admin_delete_registration RPC）",
    /\.delete\(/.test(regAdminRepoSrc),
  );
  checkTrue(
    "呼叫的 RPC 名稱是 admin_delete_registration",
    /supabaseAdmin\(\)\.rpc\(\s*"admin_delete_registration"/.test(regAdminRepoSrc),
  );
  const rpcCallSrc = sliceBetween(
    regAdminRepoSrc,
    'supabaseAdmin().rpc("admin_delete_registration"',
    ");",
  );
  for (const p of ["p_registration_id", "p_actor_id"]) {
    checkTrue(`RPC 呼叫帶了具名參數 ${p}`, rpcCallSrc.includes(`${p}:`));
  }
}

// =============================================================================
// [10] 🔴 fns/event-registrations.ts：deleteAdminRegistration 掛 adminFnMiddleware
// =============================================================================
console.log("\n[10] 🔴 deleteAdminRegistration 的授權邊界");
{
  checkTrue(
    "import 了 adminFnMiddleware",
    /import \{ adminFnMiddleware, staffFnMiddleware \} from "@\/lib\/admin\/middleware"/.test(
      regFnsSrcRaw,
    ),
  );
  const fnSrc = sliceBetween(regFnsSrc, "export const deleteAdminRegistration", "});");
  checkTrue("抓得到 deleteAdminRegistration 的宣告", fnSrc.length > 50);
  checkTrue("🔴 掛 adminFnMiddleware", /\.middleware\(\[adminFnMiddleware\]\)/.test(fnSrc));
  checkFalse("沒有掛 staffFnMiddleware", /staffFnMiddleware/.test(fnSrc));
  checkTrue(
    "🔴 actorId 讀自 context.admin.userId（呼叫端不能宣稱是誰做的）",
    /actorId: context\.admin\.userId/.test(fnSrc),
  );
  checkFalse(
    "🔴 inputValidator 沒有 actorId 欄位",
    /z\.object\(\{\s*registrationId[\s\S]{0,100}actorId/.test(fnSrc),
  );
}

// =============================================================================
// [11] 🔴 名單頁：每一列有「移除」，二次確認，已付款的示警
// =============================================================================
console.log("\n[11] 🔴 名單頁的移除按鈕與確認對話框");
{
  checkTrue(
    "import 了 deleteAdminRegistration",
    /deleteAdminRegistration/.test(regRouteSrc) &&
      /from "@\/lib\/admin\/fns\/event-registrations"/.test(regRouteSrc),
  );
  checkTrue(
    "有 removeTarget／removing 兩個 state",
    /removeTarget/.test(regRouteSrc) && /removing/.test(regRouteSrc),
  );

  const handlerSrc = sliceBetween(
    regRouteSrc,
    "async function handleRemoveRegistration",
    "return (",
  );
  checkTrue("抓得到 handleRemoveRegistration 的函式本體", handlerSrc.length > 100);
  const deletedBranch = sliceBetween(handlerSrc, 'if (result.reason === "deleted")', "} else {");
  checkTrue(
    "成功（reason === deleted）時才通知名單頁 onRemoved(這一列)",
    /await onRemoved\(removeTarget\.registration_id\)/.test(deletedBranch),
  );
  const onRemovedSrc = sliceBetween(regPageSrc, "onRemoved={async () => {", "}}");
  checkTrue("抓得到名單頁的 onRemoved", onRemovedSrc.length > 10);
  checkTrue(
    "🔴 成功時 router.invalidate()（名單 loader 與外層場次表的名額／報名數一起重抓）",
    /await router\.invalidate\(\)/.test(onRemovedSrc),
  );

  const alertSrc = sliceBetween(regRouteSrc, "open={removeTarget !== null}", "</AlertDialog>");
  checkTrue("抓得到移除確認對話框", alertSrc.length > 100);
  checkTrue(
    "🔴 已付款（on_roster）時明確警告「已經付過錢」",
    /removeTarget\?\.on_roster/.test(alertSrc) && /已經付過錢/.test(alertSrc),
  );
  checkTrue("🔴 對話框說明名額會還回去", /名額會立即還給場次|名額/.test(alertSrc));
  checkTrue(
    "確認按鈕呼叫 handleRemoveRegistration",
    /void handleRemoveRegistration\(\)/.test(alertSrc),
  );

  // 表格：「移除」按鈕在每一列裡，且與「顯示」放在同一個操作欄。
  checkTrue(
    "表格標題欄有「操作」（原本叫「聯絡方式」，見 0035 對這個檔案的改動）",
    // 2026-10-25 拿掉「顯示」鈕（名單直接是明文）後欄寬從 w-40 縮成 w-24。
    /<TableHead className="w-\d+ text-right">操作<\/TableHead>/.test(regRouteSrc),
  );
  checkTrue(
    "每一列有一顆呼叫 setRemoveTarget(r) 的按鈕",
    /onClick=\{\(\) => setRemoveTarget\(r\)\}/.test(regRouteSrc),
  );
}

// =============================================================================
// [連線] 段
// =============================================================================
const PG_URL = process.env.ADMIN_CLEANUP_SELFTEST_PG_URL;

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
    throw new Error(`SQL 失敗：${r.error.slice(0, 500)}\n--- SQL ---\n${sql.slice(0, 700)}`);
  return r.rows;
}
const one = (rows) => (Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
const num = (rows) => Number(one(rows)?.n ?? -1);
/** 一組表的「現在長什麼樣」快照，用 md5 濃縮成一個字串，前後比對用。 */
async function snapshot(orderId) {
  const rows = await must(`
    select 'orders_row' k, md5(t::text) v from (select * from public.orders where id='${orderId}') t
    union all select 'order_items', md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from public.order_items t where order_id='${orderId}'
    union all select 'payments', md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from public.payments t where order_id='${orderId}'
    union all select 'invoices', md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from public.invoices t where order_id='${orderId}'
    union all select 'event_registrations', md5(coalesce(string_agg(t::text,'|' order by t.id),'')) from public.event_registrations t where order_id='${orderId}'
  `);
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}
function snapshotsEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff = [];
  for (const k of keys) if (a[k] !== b[k]) diff.push(k);
  return diff;
}

const KEY_PREFIX = "a35-";
const CLEANUP_SQL = `
delete from public.event_registrations r
 where r.order_id in (select o.id from public.orders o where o.idempotency_key like '${KEY_PREFIX}%')
    or r.session_id in (select s.id from public.event_sessions s where s.product_id like '${KEY_PREFIX}%');
delete from public.stock_reservations where order_id in (select id from public.orders where idempotency_key like '${KEY_PREFIX}%');
delete from inv.sales where web_order_id in (select id from public.orders where idempotency_key like '${KEY_PREFIX}%');
delete from public.payments where order_id in (select id from public.orders where idempotency_key like '${KEY_PREFIX}%');
delete from public.invoices where order_id in (select id from public.orders where idempotency_key like '${KEY_PREFIX}%');
delete from public.orders where idempotency_key like '${KEY_PREFIX}%';
delete from public.event_sessions where product_id like '${KEY_PREFIX}%';
delete from public.product_inventory_links where product_id like '${KEY_PREFIX}%';
delete from public.products where id like '${KEY_PREFIX}%';
delete from inv.products where name like '${KEY_PREFIX}%';
`;
const LOC = `'{"zh":"自檢","en":"selftest","ja":"セルフテスト"}'::jsonb`;

if (!PG_URL) {
  skipped.push("連線段（缺 ADMIN_CLEANUP_SELFTEST_PG_URL）");
  console.log(yellow("\n[12+] 連線段 —— 跳過：沒有 ADMIN_CLEANUP_SELFTEST_PG_URL"));
  console.log(
    yellow("       設好之後重跑，才會驗到名額精準度、封存零變動、拒絕路徑零變動這五＋二條。"),
  );
  console.log(yellow("       指令見本檔檔頭。"));
} else {
  try {
    if (process.env.ADMIN_CLEANUP_SELFTEST_APPLY === "1") {
      console.log("\n[12] 套用 0035（假設 0001–0034 已經在這個資料庫上）");
      const r = await q(readFile(MIG_0035));
      if (!r.ok) throw new Error(`套用 0035 失敗：${r.error.slice(0, 800)}`);
      checkTrue("0035 套用完成", true);
      const again = await q(readFile(MIG_0035));
      checkTrue("0035 套第二次零錯誤（冪等）", again.ok);
      if (!again.ok) console.log(red(`      ${again.error.slice(0, 400)}`));
    }

    checkTrue(
      "前置：資料庫已經套到 0035（三支函式都存在）",
      Boolean(
        one(
          await must(`select
            to_regprocedure('public.admin_delete_order(uuid,uuid)') is not null
            and to_regprocedure('public.admin_archive_order(uuid,uuid,boolean)') is not null
            and to_regprocedure('public.admin_delete_registration(uuid,uuid)') is not null
            ok`),
        )?.ok,
      ),
      "沒有的話先照本檔檔頭設 ADMIN_CLEANUP_SELFTEST_APPLY=1 套一次。",
    );

    console.log("\n[13] 前置：建立測試資料");
    await must(CLEANUP_SQL);
    // 一個 admin 角色的 profile，永遠不刪——0033 的 profiles_keep_last_admin 是
    // AFTER STATEMENT trigger：這個資料庫上如果一個 admin 都沒有，任何一句碰
    // public.profiles 的 delete/update（包含跟這支測試完全無關的）都會被那個
    // 「保底至少一位 admin」的守衛擋下來。用固定 id、on conflict 不動它，永遠留著。
    const ACTOR_ID = "a3550000-0000-4000-8000-00000000ad11";
    await must(`
      insert into auth.users (id, email) values ('${ACTOR_ID}', 'a35-actor@example.invalid')
        on conflict (id) do nothing;
      insert into public.profiles (id, email, role) values ('${ACTOR_ID}', 'a35-actor@example.invalid', 'admin')
        on conflict (id) do update set role = 'admin';
    `);

    const EV_PRODUCT = `${KEY_PREFIX}ev`;
    const BOOK_PRODUCT = `${KEY_PREFIX}book`;
    const INVLINK_PRODUCT = `${KEY_PREFIX}invgood`;
    const SESSION_A = "a3550000-0000-4000-8000-000000000001"; // 3 registrations
    const SESSION_B = "a3550000-0000-4000-8000-000000000002"; // 1 registration, floor test
    const INV_ITEM = "a3550000-0000-4000-8000-0000000000aa";
    const INV_OWNER = "a3550000-0000-4000-8000-000000000099";

    await must(`
      insert into auth.users (id, email) values ('${INV_OWNER}', 'a35-owner@example.invalid')
        on conflict (id) do nothing;
      insert into public.products (id, slug, product_type, title, summary, description, price, status)
      values ('${EV_PRODUCT}','${EV_PRODUCT}','event', ${LOC}, ${LOC}, ${LOC}, 500, 'active');
      insert into public.event_sessions (id, product_id, title, location, starts_at, capacity, status)
      values ('${SESSION_A}','${EV_PRODUCT}', ${LOC}, ${LOC}, now() + interval '10 days', 5, 'open'),
             ('${SESSION_B}','${EV_PRODUCT}', ${LOC}, ${LOC}, now() + interval '11 days', 5, 'open');
      insert into public.products (id, slug, product_type, title, summary, description, price, stock, status)
      values ('${BOOK_PRODUCT}','${BOOK_PRODUCT}','book', ${LOC}, ${LOC}, ${LOC}, 380, 10, 'active');
      insert into public.products (id, slug, product_type, title, summary, description, price, status)
      values ('${INVLINK_PRODUCT}','${INVLINK_PRODUCT}','goods', ${LOC}, ${LOC}, ${LOC}, 300, 'active');
      insert into inv.products (id, user_id, name, stock_quantity, selling_price, cost_price)
      values ('${INV_ITEM}','${INV_OWNER}','${KEY_PREFIX}inv-item',50,300,150);
      insert into public.product_inventory_links (product_id, inv_product_id, units_per_sale)
      values ('${INVLINK_PRODUCT}','${INV_ITEM}',1);
    `);

    // ---- order X：3 位登記在 session A ------------------------------------
    await must(`
      insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
      values ('自檢','a35x@example.invalid','0900000001',1500,1500,'${KEY_PREFIX}x');
      insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
      select o.id, '${EV_PRODUCT}', '${SESSION_A}', ${LOC}, 500, 3, 1500, 'event'
        from public.orders o where o.idempotency_key = '${KEY_PREFIX}x';
    `);
    await must(`
      do $$
      declare it record;
      begin
        for it in select oi.id, oi.order_id from public.order_items oi
                   join public.orders o on o.id = oi.order_id
                  where o.idempotency_key = '${KEY_PREFIX}x'
        loop
          perform public.reserve_session_seat(it.order_id, it.id, '${SESSION_A}', 3,
            '[{"name":"P1","email":"p1@example.invalid","phone":null,"noticeAck":"true"},
              {"name":"P2","email":"p2@example.invalid","phone":null,"noticeAck":"true"},
              {"name":"P3","email":"p3@example.invalid","phone":null,"noticeAck":"true"}]'::jsonb);
        end loop;
      end $$;
    `);
    check(
      "前置：session A seats_taken = 3",
      num(await must(`select seats_taken n from public.event_sessions where id='${SESSION_A}'`)),
      3,
    );

    // =========================================================================
    // [14] 🔴 刪一筆報名：seats_taken 恰好減 1，另外 2 位還在
    // =========================================================================
    console.log("\n[14] 🔴 刪一筆報名（3 選 1）：seats_taken 恰好減 1，不是減 3");
    const p2Id = one(
      await must(
        `select registration_id id from public.event_registrations r
                   join public.order_items oi on oi.id = r.order_item_id
                  where r.session_id='${SESSION_A}' and r.name='P2'`.replace(
          "registration_id id",
          "r.id id",
        ),
      ),
    )?.id;
    checkTrue("前置：抓得到 P2 的 registration id", Boolean(p2Id));
    const del1 = one(
      await must(
        `select * from public.admin_delete_registration('${p2Id}'::uuid, '${ACTOR_ID}'::uuid)`,
      ),
    );
    check("🔴 reason = 'deleted'", del1?.reason, "deleted");
    check("🔴 freed = 1", Number(del1?.freed), 1);
    check(
      "🔴 session A 的 seats_taken：3 → 2（恰好減 1，不是減 3）",
      num(await must(`select seats_taken n from public.event_sessions where id='${SESSION_A}'`)),
      2,
    );
    check(
      "🔴 另外 2 位（P1／P3）還在",
      (
        await must(
          `select name from public.event_registrations where session_id='${SESSION_A}' order by seat_no`,
        )
      )
        .map((r) => r.name)
        .sort(),
      ["P1", "P3"],
    );
    check(
      // ⚠️ session B 這時候還沒有任何報名（[15] 才會第一次寫它）——0 才是「完全
      //    沒被動到」的正確期望值，不是 1。
      "對照組：session B 完全沒被動到（這時候還是初始值 0，尚未被 [15] 寫入）",
      num(await must(`select seats_taken n from public.event_sessions where id='${SESSION_B}'`)),
      0,
    );

    // =========================================================================
    // [15] 🔴 seats_taken 已是 0：再刪不會變負數
    // =========================================================================
    console.log("\n[15] 🔴 seats_taken 已是 0 時再刪 —— 不會變負數");
    await must(`
      insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
      values ('自檢','a35x2@example.invalid','0900000002',500,500,'${KEY_PREFIX}x2');
      insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
      select o.id, '${EV_PRODUCT}', '${SESSION_B}', ${LOC}, 500, 1, 500, 'event'
        from public.orders o where o.idempotency_key = '${KEY_PREFIX}x2';
      do $$
      declare it record;
      begin
        for it in select oi.id, oi.order_id from public.order_items oi
                   join public.orders o on o.id = oi.order_id
                  where o.idempotency_key = '${KEY_PREFIX}x2'
        loop
          perform public.reserve_session_seat(it.order_id, it.id, '${SESSION_B}', 1,
            '[{"name":"Q1","email":"q1@example.invalid","phone":null,"noticeAck":"true"}]'::jsonb);
        end loop;
      end $$;
      -- 手動把 seats_taken 撥回 0，模擬「這一列已經算過帳、但登記還在」的邊界狀態。
      update public.event_sessions set seats_taken = 0 where id='${SESSION_B}';
    `);
    const q1Id = one(
      await must(
        `select id from public.event_registrations where session_id='${SESSION_B}' and name='Q1'`,
      ),
    )?.id;
    checkTrue("前置：抓得到 Q1 的 registration id", Boolean(q1Id));
    const del2 = one(
      await must(
        `select * from public.admin_delete_registration('${q1Id}'::uuid, '${ACTOR_ID}'::uuid)`,
      ),
    );
    check("reason = 'deleted'（列真的被刪了）", del2?.reason, "deleted");
    check(
      "🔴 seats_taken 停在 0（沒有變成 -1）",
      num(await must(`select seats_taken n from public.event_sessions where id='${SESSION_B}'`)),
      0,
    );
    const del2Again = one(
      await must(
        `select * from public.admin_delete_registration('${q1Id}'::uuid, '${ACTOR_ID}'::uuid)`,
      ),
    );
    check(
      "再刪一次同一筆：reason = 'registration_not_found'（冪等）",
      del2Again?.reason,
      "registration_not_found",
    );
    check("freed = 0", Number(del2Again?.freed), 0);

    // =========================================================================
    // [16] 🔴 刪一筆未付款訂單：報名消失、seats_taken 回沖、庫存還回去
    //      （兩種庫存都測：型錄庫存 public.products.stock，與 inv 保留）
    // =========================================================================
    console.log("\n[16] 🔴 刪未付款訂單：名額、型錄庫存、inv 保留全部還回去");
    await must(`
      insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
      values ('自檢','a35y@example.invalid','0900000003',1140,1140,'${KEY_PREFIX}y');
      insert into public.order_items (order_id, product_id, name, unit_price, quantity, subtotal, product_type)
      select o.id, '${BOOK_PRODUCT}', ${LOC}, 380, 3, 1140, 'book'
        from public.orders o where o.idempotency_key = '${KEY_PREFIX}y';
      update public.products set stock = stock - 3 where id = '${BOOK_PRODUCT}';

      insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
      values ('自檢','a35z@example.invalid','0900000004',1500,1500,'${KEY_PREFIX}z');
      insert into public.order_items (order_id, product_id, name, unit_price, quantity, subtotal, product_type)
      select o.id, '${INVLINK_PRODUCT}', ${LOC}, 300, 5, 1500, 'goods'
        from public.orders o where o.idempotency_key = '${KEY_PREFIX}z';
    `);
    await must(`
      do $$ declare oid uuid; begin
        select id into oid from public.orders where idempotency_key = '${KEY_PREFIX}z';
        perform public.reserve_inventory_stock(oid, jsonb_build_array(jsonb_build_object('product_id','${INVLINK_PRODUCT}','quantity',5)));
      end $$;
    `);
    check(
      "前置：book 庫存扣到 7",
      num(await must(`select stock n from public.products where id='${BOOK_PRODUCT}'`)),
      7,
    );
    check(
      "前置：Z 訂單有一列 stock_reservations",
      num(
        await must(
          `select count(*)::int n from public.stock_reservations r join public.orders o on o.id=r.order_id where o.idempotency_key='${KEY_PREFIX}z'`,
        ),
      ),
      1,
    );

    const orderYId = one(
      await must(`select id from public.orders where idempotency_key='${KEY_PREFIX}y'`),
    )?.id;
    const orderZId = one(
      await must(`select id from public.orders where idempotency_key='${KEY_PREFIX}z'`),
    )?.id;
    const delY = one(
      await must(
        `select * from public.admin_delete_order('${orderYId}'::uuid, '${ACTOR_ID}'::uuid)`,
      ),
    );
    check("🔴 刪 Y（型錄庫存）reason = 'deleted'", delY?.reason, "deleted");
    check(
      "🔴 book 庫存還回 10",
      num(await must(`select stock n from public.products where id='${BOOK_PRODUCT}'`)),
      10,
    );
    check(
      "訂單 Y 真的不見了",
      num(await must(`select count(*)::int n from public.orders where id='${orderYId}'`)),
      0,
    );

    const delZ = one(
      await must(
        `select * from public.admin_delete_order('${orderZId}'::uuid, '${ACTOR_ID}'::uuid)`,
      ),
    );
    check("🔴 刪 Z（inv 保留）reason = 'deleted'", delZ?.reason, "deleted");
    check(
      "🔴 stock_reservations 的那一列被釋放",
      num(
        await must(
          `select count(*)::int n from public.stock_reservations where order_id='${orderZId}'`,
        ),
      ),
      0,
    );

    // ── 額外：已經被 expire_unpaid_orders() 處理過的訂單，型錄庫存不會被雙重入帳 ──
    console.log("\n[16b] 🔴 已取消（已被 expire 處理過）的訂單再刪一次：型錄庫存不重複入帳");
    await must(`
      insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key, created_at)
      values ('自檢','a35y2@example.invalid','0900000005',760,760,'${KEY_PREFIX}y2', now() - interval '2 hours');
      insert into public.order_items (order_id, product_id, name, unit_price, quantity, subtotal, product_type)
      select o.id, '${BOOK_PRODUCT}', ${LOC}, 380, 2, 760, 'book'
        from public.orders o where o.idempotency_key = '${KEY_PREFIX}y2';
      update public.products set stock = stock - 2 where id = '${BOOK_PRODUCT}';
    `);
    await must(`select public.expire_unpaid_orders(interval '30 minutes')`);
    check(
      "前置：expire 已經把 book 庫存還回 10",
      num(await must(`select stock n from public.products where id='${BOOK_PRODUCT}'`)),
      10,
    );
    const orderY2Id = one(
      await must(`select id from public.orders where idempotency_key='${KEY_PREFIX}y2'`),
    )?.id;
    const delY2 = one(
      await must(
        `select * from public.admin_delete_order('${orderY2Id}'::uuid, '${ACTOR_ID}'::uuid)`,
      ),
    );
    check("已取消的訂單一樣能刪（payment_status 不是 paid）", delY2?.reason, "deleted");
    check(
      "🔴 book 庫存維持 10（不是 12——沒有被 admin_delete_order 二次入帳）",
      num(await must(`select stock n from public.products where id='${BOOK_PRODUCT}'`)),
      10,
    );

    // =========================================================================
    // [17] 🔴 對照組：封存已付款訂單 —— seats_taken／registrations／payments／
    //      invoices 逐表比對，一個位元組都沒變
    // =========================================================================
    console.log("\n[17] 🔴 對照組：封存已付款訂單，逐表 md5 比對零變動");
    await must(`
      insert into public.event_sessions (id, product_id, title, location, starts_at, capacity, status)
      values ('a3550000-0000-4000-8000-000000000003','${EV_PRODUCT}', ${LOC}, ${LOC}, now() + interval '12 days', 5, 'open');
      insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
      values ('自檢','a35w@example.invalid','0900000006',500,500,'${KEY_PREFIX}w');
      insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
      select o.id, '${EV_PRODUCT}', 'a3550000-0000-4000-8000-000000000003', ${LOC}, 500, 1, 500, 'event'
        from public.orders o where o.idempotency_key = '${KEY_PREFIX}w';
      do $$ declare it record; begin
        for it in select oi.id, oi.order_id from public.order_items oi
                   join public.orders o on o.id = oi.order_id
                  where o.idempotency_key = '${KEY_PREFIX}w'
        loop
          perform public.reserve_session_seat(it.order_id, it.id, 'a3550000-0000-4000-8000-000000000003', 1,
            '[{"name":"W1","email":"w1@example.invalid","phone":null,"noticeAck":"true"}]'::jsonb);
        end loop;
      end $$;
      update public.orders set payment_method='transfer', remittance_last5='12345', remittance_reported_at=now()
       where idempotency_key='${KEY_PREFIX}w';
      select public.admin_mark_order_paid(
        (select id from public.orders where idempotency_key='${KEY_PREFIX}w'), '${ACTOR_ID}'::uuid, 'selftest');
      insert into public.invoices (order_id, invoice_type)
      select id, 'personal' from public.orders where idempotency_key='${KEY_PREFIX}w';
    `);
    const orderWId = one(
      await must(`select id from public.orders where idempotency_key='${KEY_PREFIX}w'`),
    )?.id;
    const beforeArchive = await snapshot(orderWId);
    checkTrue(
      "前置：訂單 W 有 order_items／payments／invoices／event_registrations 各一列",
      Object.values(beforeArchive).every((v) => v !== ""),
    );
    const archiveResult = one(
      await must(
        `select * from public.admin_archive_order('${orderWId}'::uuid, '${ACTOR_ID}'::uuid, true)`,
      ),
    );
    check("reason = 'archived'", archiveResult?.reason, "archived");
    checkTrue(
      "archived_at 真的被設了",
      Boolean(
        one(
          await must(`select archived_at is not null ok from public.orders where id='${orderWId}'`),
        )?.ok,
      ),
    );
    const afterArchive = await snapshot(orderWId);
    check(
      "🔴 orders_row 這個雜湊值一定不同（archived_at 變了）",
      beforeArchive.orders_row !== afterArchive.orders_row,
      true,
    );
    check(
      "🔴 order_items／payments／invoices／event_registrations 四張表逐表 md5 完全相同",
      snapshotsEqual(
        { ...beforeArchive, orders_row: "IGNORE" },
        { ...afterArchive, orders_row: "IGNORE" },
      ),
      [],
    );

    // =========================================================================
    // [18] 🔴 拒絕路徑 1：已付款訂單呼叫 admin_delete_order → order_is_paid，
    //      逐表零變動（不是只看回傳值）
    // =========================================================================
    console.log("\n[18] 🔴 拒絕路徑：已付款訂單不准刪，且真的完全沒變");
    const beforeDeleteReject = await snapshot(orderWId);
    const rejectPaid = one(
      await must(
        `select * from public.admin_delete_order('${orderWId}'::uuid, '${ACTOR_ID}'::uuid)`,
      ),
    );
    check("🔴 reason = 'order_is_paid'", rejectPaid?.reason, "order_is_paid");
    check("deleted = false", rejectPaid?.deleted, false);
    const afterDeleteReject = await snapshot(orderWId);
    check(
      "🔴 五張表（含 orders 本人）逐表 md5 完全相同——真的什麼都沒變",
      snapshotsEqual(beforeDeleteReject, afterDeleteReject),
      [],
    );

    // =========================================================================
    // [19] 🔴 拒絕路徑 2：已進 inv.sales（但 payment_status 不是 paid，例如已退款）
    //      → has_inventory_sale，不是裸的 FK 錯誤
    // =========================================================================
    console.log("\n[19] 🔴 拒絕路徑：已進 inv.sales → has_inventory_sale（不是裸 FK 錯誤）");
    await must(`
      insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
      values ('自檢','a35v@example.invalid','0900000007',300,300,'${KEY_PREFIX}v');
      insert into public.order_items (order_id, product_id, name, unit_price, quantity, subtotal, product_type)
      select o.id, '${INVLINK_PRODUCT}', ${LOC}, 300, 1, 300, 'goods'
        from public.orders o where o.idempotency_key = '${KEY_PREFIX}v';
      do $$ declare oid uuid; begin
        select id into oid from public.orders where idempotency_key = '${KEY_PREFIX}v';
        perform public.reserve_inventory_stock(oid, jsonb_build_array(jsonb_build_object('product_id','${INVLINK_PRODUCT}','quantity',1)));
      end $$;
      select public.admin_mark_order_paid((select id from public.orders where idempotency_key='${KEY_PREFIX}v'), '${ACTOR_ID}'::uuid, 'x');
      select public.commit_inventory_reservations((select id from public.orders where idempotency_key='${KEY_PREFIX}v'), null);
      -- 模擬退款：payment_status 離開 'paid'，但 inv.sales 那一列沒有被清掉
      -- （這個 repo 目前沒有退款流程會清掉它——這正是這道閘存在的理由）。
      update public.orders set payment_status='refunded' where idempotency_key='${KEY_PREFIX}v';
    `);
    const orderVId = one(
      await must(`select id from public.orders where idempotency_key='${KEY_PREFIX}v'`),
    )?.id;
    check(
      "前置：V 的 payment_status 是 'refunded'，不是 'paid'（確保命中的是第二道閘不是第一道）",
      one(await must(`select payment_status p from public.orders where id='${orderVId}'`))?.p,
      "refunded",
    );
    check(
      "前置：V 有一列 inv.sales",
      num(await must(`select count(*)::int n from inv.sales where web_order_id='${orderVId}'`)),
      1,
    );
    const beforeReject2 = await snapshot(orderVId);
    const rejectSales = one(
      await must(
        `select * from public.admin_delete_order('${orderVId}'::uuid, '${ACTOR_ID}'::uuid)`,
      ),
    );
    check(
      "🔴 reason = 'has_inventory_sale'（不是拋錯，是乾淨的回傳值）",
      rejectSales?.reason,
      "has_inventory_sale",
    );
    const afterReject2 = await snapshot(orderVId);
    check("🔴 逐表零變動", snapshotsEqual(beforeReject2, afterReject2), []);
    // 對照：真的沒有這道閘會發生什麼事——直接對資料庫送裸 DELETE，證明 NO ACTION
    // 外鍵確實會炸，而 admin_delete_order() 剛好把這件事擋在前面。
    const rawDelete = await q(`delete from public.orders where id='${orderVId}'`);
    checkFalse("裸 DELETE 會被 NO ACTION 外鍵擋下來（證明這道閘不是多餘的）", rawDelete.ok);
    checkTrue(
      "裸 DELETE 的錯誤訊息就是 FK violation（admin_delete_order 存在的理由）",
      /foreign key constraint/i.test(rawDelete.error ?? ""),
      rawDelete.error,
    );

    // =========================================================================
    // [20] 四支函式：anon／authenticated 真的沒有 EXECUTE
    // =========================================================================
    console.log("\n[20] anon／authenticated 無執行權（問資料庫本人）");
    for (const sig of [
      "admin_delete_order(uuid,uuid)",
      "admin_archive_order(uuid,uuid,boolean)",
      "admin_delete_registration(uuid,uuid)",
    ]) {
      for (const role of ["anon", "authenticated"]) {
        const denied = one(
          await must(`select has_function_privilege('${role}', 'public.${sig}', 'EXECUTE') ok`),
        )?.ok;
        check(`${role} 對 public.${sig} 沒有 EXECUTE`, denied, false);
      }
      const allowed = one(
        await must(`select has_function_privilege('service_role', 'public.${sig}', 'EXECUTE') ok`),
      )?.ok;
      check(`service_role 對 public.${sig} 有 EXECUTE`, allowed, true);
    }

    // =========================================================================
    // [21] TypeScript 包裝：deleteAdminRegistration()（透過 shim 驅動產線程式碼本人）
    // =========================================================================
    console.log("\n[21] deleteAdminRegistration()（TypeScript 包裝，驅動產線程式碼）");
    {
      const SHIM = { runSql: (sql) => q(sql) };
      globalThis.__ADMIN_CLEANUP_SELFTEST__ = SHIM;
      const sqlLit = (v) => {
        if (v === null || v === undefined) return "null";
        return `'${String(v).replace(/'/g, "''")}'`;
      };
      SHIM.rpc = async (name, args) => {
        const params = Object.entries(args ?? {})
          .map(([k, v]) => `${k} => ${sqlLit(v)}`)
          .join(", ");
        const r = await SHIM.runSql(`select public.${name}(${params}) as v`);
        if (!r.ok) return { data: null, error: { code: "SHIM", message: r.error.slice(0, 300) } };
        return { data: r.rows[0]?.v ?? null, error: null };
      };
      const SHIM_SRC = [
        "const mk = globalThis.__ADMIN_CLEANUP_SELFTEST__;",
        "export const supabaseAdmin = () => ({ rpc: (n, a) => mk.rpc(n, a) });",
      ].join("\n");
      registerHooks({
        resolve(spec, ctx, next) {
          if (spec === "@/server/supabase-admin")
            return { url: "stub:admin-cleanup", shortCircuit: true };
          if (spec.startsWith("@/"))
            return {
              url: pathToFileURL(join(ROOT, "src", `${spec.slice(2)}.ts`)).href,
              shortCircuit: true,
            };
          return next(spec, ctx);
        },
        load(url, ctx, next) {
          if (url === "stub:admin-cleanup")
            return { format: "module", source: SHIM_SRC, shortCircuit: true };
          return next(url, ctx);
        },
      });

      // 再建一筆新的報名，專門給這段用（前面的都已經刪光了）。
      await must(`
        insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
        values ('自檢','a35ts@example.invalid','0900000008',500,500,'${KEY_PREFIX}ts');
        insert into public.order_items (order_id, product_id, session_id, name, unit_price, quantity, subtotal, product_type)
        select o.id, '${EV_PRODUCT}', 'a3550000-0000-4000-8000-000000000003', ${LOC}, 500, 1, 500, 'event'
          from public.orders o where o.idempotency_key = '${KEY_PREFIX}ts';
        do $$ declare it record; begin
          for it in select oi.id, oi.order_id from public.order_items oi
                     join public.orders o on o.id = oi.order_id
                    where o.idempotency_key = '${KEY_PREFIX}ts'
          loop
            perform public.reserve_session_seat(it.order_id, it.id, 'a3550000-0000-4000-8000-000000000003', 1,
              '[{"name":"TS1","email":"ts1@example.invalid","phone":null,"noticeAck":"true"}]'::jsonb);
          end loop;
        end $$;
      `);
      const tsRegId = one(
        await must(
          `select id from public.event_registrations where order_id=(select id from public.orders where idempotency_key='${KEY_PREFIX}ts')`,
        ),
      )?.id;

      const regAdmin = await import(pathToFileURL(REG_ADMIN_REPO_PATH).href);
      checkTrue(
        "反空殼：載得動產線的 deleteAdminRegistration",
        typeof regAdmin.deleteAdminRegistration === "function",
      );
      const tsResult = await regAdmin.deleteAdminRegistration({
        registrationId: tsRegId,
        actorId: ACTOR_ID,
      });
      check("🔴 透過 TS 包裝呼叫：deleted === true", tsResult.deleted, true);
      check("reason === 'deleted'", tsResult.reason, "deleted");
      check("freed === 1", tsResult.freed, 1);
      check(
        "資料庫真的少了一列",
        num(
          await must(
            `select count(*)::int n from public.event_registrations where id='${tsRegId}'`,
          ),
        ),
        0,
      );

      const notFoundResult = await regAdmin.deleteAdminRegistration({
        registrationId: "00000000-0000-0000-0000-000000000000",
        actorId: ACTOR_ID,
      });
      check(
        "不存在的 id：reason === 'registration_not_found'",
        notFoundResult.reason,
        "registration_not_found",
      );
      check("deleted === false", notFoundResult.deleted, false);
    }

    await must(CLEANUP_SQL);
    checkTrue(
      "收尾：測試訂單清乾淨了",
      Number(
        one(
          await must(
            `select count(*)::int n from public.orders where idempotency_key like '${KEY_PREFIX}%'`,
          ),
        )?.n,
      ) === 0,
    );
  } catch (err) {
    fail += 1;
    console.log(red(`\n  ✗ 連線段中斷：${String(err.message ?? err).slice(0, 1000)}`));
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
