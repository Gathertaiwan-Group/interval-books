#!/usr/bin/env node
/**
 * 後台移除報名（0044，2026-10-29）的自檢。
 *
 * 0035 的 admin_delete_registration() 只退場次的 seats_taken，不退票種（0036）的
 * units_taken，而且只用 raise log 記誰刪的。0044 補上這兩件事，並校正正式庫上已經
 * 多算的那 1 張。這支守：
 *
 *   [1] migration 帳本（0044 有登記、touches 誠實、這支自檢審到 0044）。
 *   [2] 函式簽章與安全姿勢沒變：create or replace（不 drop）、RETURNS TABLE 形狀與 0035
 *       逐字相同、security definer、search_path = ''、只 grant service_role。
 *   [3] 票種名額：從 order_items 讀 plan_id；鎖序場次先、票種後（for no key update）；
 *       greatest(0, …) 下限；DELETE … RETURNING 沒真的刪到就不扣。
 *   [4] 退幾個單位的公式（純 JS 模型）：spu=1 每刪一位退 1；spu>1 時逐位刪光，
 *       退的總數恰好等於原本佔的單位數，不多不少。
 *   [5] 稽核表 registration_removal_log：RLS 開、anon/authenticated 收回、不存全名／
 *       Email／電話；函式在同一交易寫一列，actor = coalesce(p_actor_id, auth.uid())。
 *   [6] 一次性校正只動 81fc86e3 那一個票種，用重算、不寫死數字；整支 migration 不寫
 *       訂單／付款／發票、不刪報名以外的東西。
 *   [7] 最新的 admin_delete_registration 定義就是 0044（之後有人再改，這條會轉紅）；
 *       TypeScript 包裝的 RPC 參數與回傳欄位沒變（所以這一期不用改呼叫端）。
 *
 * 實際資料庫行為的證據不在這裡：0044 套用前後都在正式庫上用「begin; … rollback;」跑過
 * 一次真的移除（座位 −1、票種 −1、稽核 +1，rollback 後零痕跡），見 commit message。
 *
 * 執行：node scripts/registration-removal-selftest.mjs（npm test 會一起跑）
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
} from "./lib/migration-ledger.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/registration-removal-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");
const MIG_0035 = join(MIG_DIR, "0035_admin_order_registration_cleanup.sql");
const MIG_0044 = join(MIG_DIR, "0044_registration_removal_plan_units_audit.sql");
const REG_ADMIN_REPO_PATH = join(ROOT, "src/server/repos/event-registrations-admin.ts");

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
const checkTrue = (label, value) => check(label, Boolean(value), true);
const checkFalse = (label, value) => check(label, Boolean(value), false);

/** 讀原始碼。檔案不存在＝丟例外，不是回空字串（見 run-selftests.mjs 守門 4）。 */
const readFile = (p) => {
  if (!existsSync(p)) {
    throw new Error(`selftest 讀不到檔案：${p}（路徑打錯，或檔案被改名／搬走了。）`);
  }
  return readFileSync(p, "utf8");
};

/** 拿掉 `--` 註解（整行與行尾），免得註解裡的字讓 regex 假性通過。 */
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .map((l) => l.replace(/\s--\s.*$/, ""))
    .join("\n");
}

/** 拿掉 TS 註解，理由同上。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** 切出 admin_delete_registration 的本體（宣告到 $$; 為止）。 */
function fnBody(sql) {
  const start = sql.indexOf("create or replace function public.admin_delete_registration(");
  if (start === -1) return "";
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end === -1 ? sql.length : end);
}

/** RETURNS TABLE (...) 的欄位，正規化空白。 */
function returnsShape(body) {
  const m = body.match(/returns table \(([\s\S]*?)\)/);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

const raw0044 = readFile(MIG_0044);
const sql0044 = stripSqlComments(raw0044);
const sql0035 = stripSqlComments(readFile(MIG_0035));
const body44 = fnBody(sql0044);
const body35 = fnBody(sql0035);

checkTrue("0044 不是空檔", raw0044.length > 3000);
checkTrue("0044 裡找得到 admin_delete_registration 的本體", body44.length > 500);

// =============================================================================
// [1] migration 帳本
// =============================================================================
console.log("\n[1] migration 帳本");
assertLedgerMatchesDisk(check, MIG_DIR);
assertLedgerDeclarationsHonest(check, MIG_DIR);
assertMigrationDependencies(check, MIG_DIR, {
  suite: "registration-removal-selftest",
  dependsOn: [
    "registration_removal",
    "event_registrations",
    "session_seats",
    "session_plans",
    "order_expiry",
  ],
  reviewedThrough: "0044_registration_removal_plan_units_audit.sql",
});
checkTrue("0044 有 begin; / commit;", /^begin;$/m.test(sql0044) && /^commit;$/m.test(sql0044));

// =============================================================================
// [2] 簽章與安全姿勢
// =============================================================================
console.log("\n[2] 簽章與安全姿勢沒變");
checkFalse(
  "沒有 drop function（形狀沒變，不需要 drop；drop 會連 grant 一起掉）",
  /drop function/i.test(sql0044),
);
check("RETURNS TABLE 形狀與 0035 逐字相同", returnsShape(body44), returnsShape(body35));
check(
  "RETURNS TABLE 是 deleted boolean, reason text, freed integer",
  returnsShape(body44),
  "deleted boolean, reason text, freed integer",
);
checkTrue(
  "參數仍是 (p_registration_id uuid, p_actor_id uuid)",
  /admin_delete_registration\(\s*p_registration_id uuid,\s*p_actor_id\s+uuid\s*\)/.test(body44),
);
checkTrue("security definer", /\bsecurity definer\b/.test(body44));
checkTrue("set search_path = ''（與 0035 相同）", /set search_path = ''/.test(body44));
checkTrue(
  "revoke execute from public",
  /revoke execute on function public\.admin_delete_registration\(uuid, uuid\) from public;/.test(
    sql0044,
  ),
);
checkTrue(
  "revoke execute from anon, authenticated",
  /revoke execute on function public\.admin_delete_registration\(uuid, uuid\) from anon, authenticated;/.test(
    sql0044,
  ),
);
checkTrue(
  "grant execute to service_role",
  /grant\s+execute on function public\.admin_delete_registration\(uuid, uuid\) to service_role;/.test(
    sql0044,
  ),
);
checkFalse(
  "沒有把 execute grant 給 anon／authenticated",
  /grant\s+execute[^;]*admin_delete_registration[^;]*to[^;]*(anon|authenticated)/.test(sql0044),
);

// =============================================================================
// [3] 票種名額
// =============================================================================
console.log("\n[3] 票種名額一併退回");
checkTrue(
  "plan_id 從 order_items 讀（event_registrations 沒有 plan_id 欄位）",
  /select oi\.plan_id into v_plan_id\s+from public\.order_items oi/.test(body44),
);
const lockSession = body44.indexOf(
  "from public.event_sessions s where s.id = v_session for no key update",
);
const lockPlan = body44.search(
  /from public\.event_session_plans p\s+where p\.id = v_plan_id\s+for no key update/,
);
const delAt = body44.indexOf("delete from public.event_registrations");
checkTrue("場次用 for no key update 鎖", lockSession > 0);
checkTrue("票種用 for no key update 鎖", lockPlan > 0);
checkTrue(
  "🔴 鎖序：場次先、票種後（與 release_session_seat／reserve_plan_units 同一個全站順序）",
  lockSession > 0 && lockPlan > lockSession,
);
checkTrue("兩個鎖都在 delete 之前拿", delAt > lockPlan && lockPlan > 0);
checkTrue(
  "delete 只刪 r.id = p_registration_id 那一列",
  /delete from public\.event_registrations r\s+where r\.id = p_registration_id\s+returning/.test(
    body44,
  ),
);
checkFalse(
  "沒有用 order_item_id 當刪除條件（會連坐同一張單的其他人）",
  /delete from public\.event_registrations r\s+where r\.order_item_id/.test(body44),
);
checkTrue(
  "🔴 沒真的刪到（併發第二次）就回 registration_not_found、不扣",
  /if v_gone_id is null then\s+return query select false, 'registration_not_found', 0;/.test(
    body44,
  ),
);
checkTrue(
  "seats_taken 用 greatest(0, …) 兜底",
  /seats_taken = greatest\(0, s\.seats_taken - 1\)/.test(body44),
);
checkTrue(
  "units_taken 用 greatest(0, …) 兜底",
  /units_taken = greatest\(0, p\.units_taken - v_units\)/.test(body44),
);
checkTrue(
  "只在有 plan_id 時才動票種",
  /if v_plan_id is not null then[\s\S]*update public\.event_session_plans p/.test(body44),
);
checkTrue(
  "退的單位數 = ceil(n_before/spu) − ceil(n_after/spu)",
  /v_units := ceil\(\(v_n_after \+ 1\)::numeric \/ v_spu\)::integer\s+- ceil\(v_n_after::numeric \/ v_spu\)::integer;/.test(
    body44,
  ),
);
checkTrue(
  "n_after 數的是同一個 order_item 剩下的報名",
  /select count\(\*\)::integer into v_n_after\s+from public\.event_registrations r\s+where r\.order_item_id = v_item;/.test(
    body44,
  ),
);
checkTrue(
  "回傳仍是 (true, 'deleted', 1)——freed 數的是位子，呼叫端不用改",
  /return query select true, 'deleted', 1;/.test(body44),
);
checkFalse("沒有檢查 payment_status（已付款也允許刪，同 0035）", /payment_status/.test(body44));

// =============================================================================
// [4] 退單位公式的純 JS 模型
// =============================================================================
console.log("\n[4] 退單位公式");
{
  const unitsFreed = (nAfter, spu) => Math.ceil((nAfter + 1) / spu) - Math.ceil(nAfter / spu);
  // 一個 order_item 買了 q 個單位、每單位 spu 位 → 有 q*spu 列報名，逐位刪光。
  const drain = (q, spu) => {
    const seq = [];
    for (let n = q * spu; n > 0; n -= 1) seq.push(unitsFreed(n - 1, spu));
    return seq;
  };
  check("spu=1、3 位：每刪一位退 1", drain(3, 1), [1, 1, 1]);
  check("spu=2、1 間雙人房：第一位不退、第二位退 1", drain(1, 2), [0, 1]);
  check("spu=2、2 間：0,1,0,1", drain(2, 2), [0, 1, 0, 1]);
  let ok = true;
  for (let spu = 1; spu <= 4; spu += 1) {
    for (let q = 1; q <= 5; q += 1) {
      const s = drain(q, spu);
      if (s.reduce((a, b) => a + b, 0) !== q || s.some((x) => x < 0 || x > 1)) ok = false;
    }
  }
  checkTrue("spu 1–4 × 單位 1–5：刪光時退的總數恰好等於買的單位數，每次只退 0 或 1", ok);
}

// =============================================================================
// [5] 稽核表
// =============================================================================
console.log("\n[5] 稽核表 registration_removal_log");
{
  const tbl =
    (sql0044.match(
      /create table if not exists public\.registration_removal_log \(([\s\S]*?)\n\);/,
    ) ?? [])[1] ?? "";
  checkTrue("建了 registration_removal_log", tbl.length > 100);
  for (const col of [
    "actor_id",
    "removed_at",
    "registration_id",
    "order_id",
    "order_item_id",
    "session_id",
    "plan_id",
    "name_initial",
  ]) {
    checkTrue(`有欄位 ${col}`, new RegExp(`\\b${col}\\b`).test(tbl));
  }
  checkFalse("🔴 不存 email／phone", /\b(email|phone)\b/.test(tbl));
  checkFalse("🔴 不存完整姓名欄（只有 name_initial）", /^\s*name\s/m.test(tbl));
  checkFalse("沒有外鍵（報名已刪；訂單日後被刪也不能被擋或 cascade）", /references/i.test(tbl));
  checkTrue(
    "RLS 開",
    /alter table public\.registration_removal_log enable row level security;/.test(sql0044),
  );
  checkTrue(
    "revoke all from anon, authenticated",
    /revoke all on table public\.registration_removal_log from anon, authenticated;/.test(sql0044),
  );
  checkFalse(
    "沒有任何 policy（零 policy＝只有 service_role／definer 進得去）",
    /create policy/i.test(sql0044),
  );
  checkFalse(
    "沒有把表 grant 給 anon／authenticated",
    /grant[^;]*registration_removal_log[^;]*to[^;]*(anon|authenticated)/.test(sql0044),
  );
  checkTrue(
    "service_role 只有 select",
    /grant select on table public\.registration_removal_log to service_role;/.test(sql0044),
  );
  checkTrue(
    "函式在同一交易寫一列稽核",
    /insert into public\.registration_removal_log \(/.test(body44),
  );
  checkTrue(
    "actor = coalesce(p_actor_id, auth.uid())",
    /coalesce\(p_actor_id, auth\.uid\(\)\)/.test(body44),
  );
  checkTrue("姓名只取第一個字", /left\(btrim\(r\.name\), 1\)/.test(body44));
  const insAt = body44.indexOf("insert into public.registration_removal_log");
  const guardAt = body44.indexOf("if v_gone_id is null then");
  checkTrue("稽核寫在「確定刪到了」之後（沒刪到就不記）", insAt > guardAt && guardAt > 0);
  checkFalse("不再只靠 raise log", /raise log/.test(body44));
}

// =============================================================================
// [6] 一次性校正與範圍
// =============================================================================
console.log("\n[6] 一次性校正只動一個票種、不碰金流");
{
  const doStart = sql0044.lastIndexOf("do $$");
  const fix = doStart === -1 ? "" : sql0044.slice(doStart);
  checkTrue("校正區塊存在", fix.includes("81fc86e3-2be5-4c62-a724-35399be3e052"));
  const ids = fix.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
  check(
    "校正區塊裡只出現一個 uuid（81fc86e3…）",
    [...new Set(ids)],
    ["81fc86e3-2be5-4c62-a724-35399be3e052"],
  );
  checkTrue(
    "update 有 where p.id = v_plan",
    /update public\.event_session_plans p\s+set units_taken = v_actual\s+where p\.id = v_plan/.test(
      fix,
    ),
  );
  checkFalse("🔴 不寫死數字（units_taken = 3 之類）", /units_taken\s*=\s*\d/.test(fix));
  checkTrue(
    "用重算：每個 order_item 的報名數換算成單位再加總",
    /sum\(ceil\(x\.n::numeric \/ v_spu\)\)/.test(fix),
  );
  checkTrue(
    "校正也是場次先、票種後加鎖",
    fix.indexOf("event_sessions s where s.id = v_session for no key update") > 0 &&
      fix.indexOf("for no key update", fix.indexOf("event_session_plans p where p.id = v_plan")) >
        fix.indexOf("event_sessions s where s.id = v_session"),
  );
  checkFalse(
    "🔴 整支 migration 不寫 orders／payments／invoices",
    /(insert into|update|delete from)\s+public\.(orders|payments|invoices)\b/.test(sql0044),
  );
  const deletes = sql0044.match(/delete from [a-z_.]+/g) ?? [];
  check("整支 migration 只有一個 delete：event_registrations（在函式裡、單列）", deletes, [
    "delete from public.event_registrations",
  ]);
  checkFalse("不碰 happyhands／gooddays schema", /\b(happyhands|gooddays)\./.test(sql0044));
}

// =============================================================================
// [7] 最新定義＝0044；TypeScript 呼叫端沒變
// =============================================================================
console.log("\n[7] 最新定義與呼叫端");
{
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const definers = files.filter((f) =>
    stripSqlComments(readFile(join(MIG_DIR, f))).includes(
      "create or replace function public.admin_delete_registration(",
    ),
  );
  check(
    "定義 admin_delete_registration 的 migration 依序是 0035、0044（之後再有人改，回來重讀這支）",
    definers,
    ["0035_admin_order_registration_cleanup.sql", "0044_registration_removal_plan_units_audit.sql"],
  );
  const repo = stripTs(readFile(REG_ADMIN_REPO_PATH));
  checkTrue(
    '呼叫端仍是 rpc("admin_delete_registration", { p_registration_id, p_actor_id })',
    /rpc\("admin_delete_registration", \{\s*p_registration_id: input\.registrationId,\s*p_actor_id: input\.actorId,\s*\}\)/.test(
      repo,
    ),
  );
  checkTrue(
    "呼叫端解析的仍是 deleted／reason／freed",
    /deleted\?: boolean; reason\?: string; freed\?: number/.test(repo),
  );
}

// -----------------------------------------------------------------------------
console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
