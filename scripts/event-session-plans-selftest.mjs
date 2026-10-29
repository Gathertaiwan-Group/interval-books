#!/usr/bin/env node
/**
 * event-session-plans-selftest.mjs —— 一個場次多個價格方案／票種（0036）的自檢
 *
 * 分兩段，跟 event-registration-selftest.mjs（0020）同一個理由：
 *
 *   [靜態] 讀 supabase/migrations/0036 與幾支 .ts 的原始碼，守的是**設計不變量**：
 *          鎖序固定「場次→方案」、release_session_seat()／expire_unpaid_orders()
 *          一併回沖 units_taken、createOrder() 的呼叫順序是「先方案後座位」且
 *          失敗會補救、四種方案驗證失敗收斂成同一句錯誤、schema 沒有金額欄位、
 *          新 schema 值走動態匯入。這些答案就寫在檔案裡，不連線也回答得出來。
 *          **永遠會跑。**
 *
 *   [併發] 對一個真的資料庫**同時發請求**，逐一驗收驗收條件裡那五條名額斷言、
 *          防竄改／授權四條、並發兩條。每一次 q() 都是一個獨立的 psql 子行程
 *          （一條獨立連線、一個獨立交易）——這一點跟 orders.ts 的真實架構一樣：
 *          reserve_plan_units() 與 reserve_session_seat() 是**兩次獨立的
 *          PostgREST 呼叫，兩個獨立的交易**，不是包在同一個 begin/commit 裡。
 *          底下的 bookPlan() 就是照這個真實邊界切的，見它自己的文件註解。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它只認 PLAN_SELFTEST_PG_URL，那個變數要自己設；
 *    沒設就整段 skip（會印出來，不會靜悄悄消失）。
 *
 * 準備一個可以跑的本機庫（沿用其他幾支自檢共用的 ib_0034_test，那個庫已經套到
 * 0035——見 admin-order-registration-cleanup-selftest.mjs／remittance-selftest.mjs
 * 的檔頭）：
 *
 *     PLAN_SELFTEST_PG_URL=postgres:///ib_0034_test \
 *     PLAN_SELFTEST_APPLY=1 node scripts/event-session-plans-selftest.mjs
 *
 * `PLAN_SELFTEST_APPLY=1` 只套用 0036 本身（假設 0001–0035 已經在這個資料庫上，
 * 跟 admin-order-registration-cleanup-selftest.mjs 對 0035 的處理完全同一個模式）。
 * 套過一次之後就不用再帶這個變數。
 *
 * 環境變數：
 *   PLAN_SELFTEST_PG_URL   本機測試庫的連線字串（併發段的開關）
 *   PLAN_SELFTEST_APPLY    設成 1 時先套用 0036
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
const SELF = "scripts/event-session-plans-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");
const MIG_0036 = join(MIG_DIR, "0036_event_session_plans.sql");
const MIG_0011 = join(MIG_DIR, "0011_inventory_single_source.sql");

/**
 * `@/…` → `src/….ts` 解析鉤子，跟 remittance-selftest.mjs（scripts/remittance-selftest.mjs:236-255）
 * 同一支——真正呼叫 `import(...)` 載入一支用了 `@/` 路徑別名的 .ts 檔時，Node 自己的
 * ESM 解析器不認得 tsconfig 的 `paths`，得靠這個鉤子手動把它翻回相對路徑。這裡只需要
 * 最小的那一半（沒有 remittance-selftest.mjs 那個 supabaseAdmin() 的 SQL shim）——
 * [9] 只匯入 src/lib/checkout.ts 測純函式／zod schema，那個檔案完全不碰資料庫。
 */
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      return {
        url: pathToFileURL(join(ROOT, "src", `${spec.slice(2)}.ts`)).href,
        shortCircuit: true,
      };
    }
    return next(spec, ctx);
  },
});

// -----------------------------------------------------------------------------
// 迷你測試框架（與 event-registration-selftest.mjs 同一套）
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

/** 讀原始碼。檔案不存在＝丟例外，不是回空字串（同 event-registration-selftest.mjs 的理由）。 */
const readFile = (p) => {
  if (!existsSync(p)) {
    throw new Error(`selftest 讀不到檔案：${p}（路徑打錯，或檔案被改名／搬走了。）`);
  }
  return readFileSync(p, "utf8");
};

/** 拿掉 `--` 註解整行，免得註解裡提到的字串讓 includes()／regex 假性通過。 */
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/** 拿掉 TS 的 `//` 與 `/* … *\/` 註解，理由同上。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** 切出單一函式的本體：從宣告切到它自己的 comment on。 */
function functionBody(sql, signature) {
  const start = sql.indexOf(`create or replace function ${signature}`);
  if (start === -1) return "";
  const end = sql.indexOf(`comment on function ${signature}`, start);
  return sql.slice(start, end === -1 ? sql.length : end);
}

const sql0036 = stripSqlComments(readFile(MIG_0036));
const exec0011 = stripSqlComments(readFile(MIG_0011));

// =============================================================================
// [1] migration 帳本：0036 有沒有登記、有沒有少報
// =============================================================================
console.log("\n[1] migration 帳本");
checkTrue("0036 存在", existsSync(MIG_0036));
assertLedgerMatchesDisk(check, MIG_DIR);
assertLedgerDeclarationsHonest(check, MIG_DIR);
// 這支自己也要表態依賴哪些區域、審到哪一支——見 migration-ledger.mjs 檔頭
// §「強迫表態的那一條」。session_plans 是這一期新開的區域，其餘六個是 0036
// 實際掃出來會碰到的（見 migration-ledger.mjs 裡 0036 那一列的長註解）。
assertMigrationDependencies(check, MIG_DIR, {
  suite: "event-session-plans-selftest",
  dependsOn: [
    "session_plans",
    "session_seats",
    "order_expiry",
    "event_registrations",
    "orders_payments",
    "products_availability",
    "inventory",
  ],
  // 0040_referral_program.sql（推薦碼與分潤）對 orders 只做了三件事：加三個 nullable
  // 欄位 referrer_id／referral_code／referral_discount_percent（舊訂單全是 NULL）、
  // 一個部分索引、一個指向新表 referrers 的 FK（on delete restrict，限制的是刪推廣者，
  // 不是刪訂單）。既有欄位、CHECK、函式、policy、grant 一個字都沒改。唯一的語意變化
  // 是 orders.discount 從恆為 0 變成「推薦折扣」（只對選品／書籍、最多 50%），而
  // total = subtotal + shipping_fee − discount 仍是金流、信件、發票唯一使用的金額
  // （發票本來就把 discount 開成負數列）。這支自檢的斷言重讀過，原樣成立。
  // 0041（選品連結商品）只在 curated_items 加一個 references public.products(id) on delete
  // set null 的 nullable 欄位——帳本因此標了 products_availability。它不改 products 的任何
  // 欄位、約束、函式或 RLS，不碰庫存、名額、訂單或報名；這支自檢的斷言重讀過，原樣成立。
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
// [2] event_session_plans —— 表的形狀
// =============================================================================
console.log("\n[2] event_session_plans 表的形狀");
checkTrue(
  "session_id 是 event_sessions 的外鍵、on delete cascade",
  /session_id\s+uuid not null references public\.event_sessions \(id\) on delete cascade/.test(
    sql0036,
  ),
);
checkTrue(
  "title 用 is_localized() 守三語形狀",
  /title\s+jsonb not null check \(public\.is_localized\(title\)\)/.test(sql0036),
);
checkTrue("price 不可為負", /price\s+integer not null check \(price >= 0\)/.test(sql0036));
{
  const planTableStart = sql0036.indexOf("create table if not exists public.event_session_plans");
  const planTableEnd = sql0036.indexOf(
    "comment on table public.event_session_plans",
    planTableStart,
  );
  const planTableBlock = sql0036.slice(planTableStart, planTableEnd);
  checkTrue(
    "🔴 欄位叫 units_taken 不是 seats_taken（避免跟場次的 seats_taken 被誤當同一個量相加）",
    /units_taken\s+integer not null default 0 check \(units_taken >= 0\)/.test(planTableBlock) &&
      !planTableBlock.includes("seats_taken"),
  );
}
checkTrue(
  "seats_per_unit 至少 1（預設 1）",
  /seats_per_unit\s+integer not null default 1 check \(seats_per_unit >= 1\)/.test(sql0036),
);
checkTrue(
  "units_taken 不可超過 capacity（CHECK）",
  /constraint event_session_plans_units_within_capacity check \(units_taken <= capacity\)/.test(
    sql0036,
  ),
);
checkTrue(
  "販售期間的 CHECK：迄不早於始",
  /constraint event_session_plans_sale_window check \(\s*sale_starts_at is null or sale_ends_at is null or sale_ends_at >= sale_starts_at\s*\)/.test(
    sql0036,
  ),
);
checkTrue(
  "status 只有 open/closed",
  /status\s+text not null default 'open' check \(status in \('open', 'closed'\)\)/.test(sql0036),
);
checkTrue(
  "RLS 開著、姿勢跟 event_sessions 一樣（公開可讀 open 且場次／商品可見）",
  /alter table public\.event_session_plans enable row level security/.test(sql0036) &&
    /grant select on table public\.event_session_plans to anon, authenticated/.test(sql0036),
);
checkTrue(
  "公開讀取 policy 穿過 event_sessions 再穿到 products",
  /create policy event_session_plans_select_public on public\.event_session_plans[\s\S]{0,400}status = 'open'[\s\S]{0,400}from public\.event_sessions s[\s\S]{0,200}join public\.products p on p\.id = s\.product_id/.test(
    sql0036,
  ),
);

// =============================================================================
// [3] order_items —— 兩個新欄位與它們的形狀 CHECK
// =============================================================================
console.log("\n[3] order_items 的 plan_id／plan_title");
checkTrue(
  "plan_id 是 event_session_plans 的外鍵、on delete restrict（賣過的方案刪不掉）",
  /add column if not exists plan_id uuid\s*\n\s*references public\.event_session_plans \(id\) on delete restrict/.test(
    sql0036,
  ),
);
checkTrue("plan_title 是 jsonb", /add column if not exists plan_title jsonb/.test(sql0036));
checkTrue(
  "plan_id／plan_title 同進同出，且非 null 時必須是三語物件",
  /order_items_plan_title_shape check \(\s*\(plan_id is null and plan_title is null\)\s*\n\s*or \(plan_id is not null and plan_title is not null and public\.is_localized\(plan_title\)\)/.test(
    sql0036,
  ),
);
checkTrue(
  "有方案就一定有場次（plan 不能脫離 session 單獨存在）",
  /order_items_plan_requires_session check \(\s*plan_id is null or session_id is not null\s*\)/.test(
    sql0036,
  ),
);

// =============================================================================
// [4] reserve_plan_units —— 鎖序、驗證、相對更新
// =============================================================================
console.log("\n[4] reserve_plan_units()");
const reservePlanBody = functionBody(sql0036, "public.reserve_plan_units");
checkTrue("切得出 reserve_plan_units 的函式本體", reservePlanBody.length > 400);
checkTrue(
  "🔴 先鎖這張訂單會碰到的所有場次（依 id 排序、for no key update）",
  /from public\.event_sessions s\s*\n\s*where s\.id in \(\s*\n\s*select oi\.session_id[\s\S]{0,200}order by s\.id\s*\n\s*for no key update/.test(
    reservePlanBody,
  ),
);
{
  const sessionsLockIdx = reservePlanBody.indexOf("from public.event_sessions s");
  const plansLockIdx = reservePlanBody.indexOf(
    "from public.event_session_plans p\n   where p.id in",
  );
  checkTrue(
    "🔴 場次的鎖在方案的鎖之前（固定順序，避免與 release_session_seat／expire_unpaid_orders 形成環）",
    sessionsLockIdx !== -1 && plansLockIdx !== -1 && sessionsLockIdx < plansLockIdx,
  );
}
checkTrue(
  "方案的鎖也是依 id 排序、for no key update",
  /from public\.event_session_plans p\s*\n\s*where p\.id in \([\s\S]{0,200}order by p\.id\s*\n\s*for no key update/.test(
    reservePlanBody,
  ),
);
checkTrue(
  "找不到方案 → PLAN_NOT_FOUND",
  /raise exception 'PLAN_NOT_FOUND:%'/.test(reservePlanBody),
);
checkTrue(
  "這個方案不屬於這張訂單／這個場次 → PLAN_ORDER_ITEM_NOT_FOUND",
  /raise exception 'PLAN_ORDER_ITEM_NOT_FOUND:%'/.test(reservePlanBody),
);
checkTrue("已下架 → PLAN_NOT_OPEN", /raise exception 'PLAN_NOT_OPEN:%'/.test(reservePlanBody));
checkTrue(
  "還沒開賣 → PLAN_NOT_ON_SALE_YET",
  /raise exception 'PLAN_NOT_ON_SALE_YET:%'/.test(reservePlanBody),
);
checkTrue(
  "已經過了販售期間 → PLAN_SALE_ENDED",
  /raise exception 'PLAN_SALE_ENDED:%'/.test(reservePlanBody),
);
checkTrue(
  "超額 → NO_PLAN_UNITS_LEFT",
  /raise exception 'NO_PLAN_UNITS_LEFT:%'/.test(reservePlanBody),
);
checkTrue(
  "🔴 相對更新（units_taken = units_taken + p_units），不是寫回讀到的值",
  /set units_taken = units_taken \+ p_units/.test(reservePlanBody),
);
checkTrue(
  "security definer，且只 grant service_role",
  /security definer/.test(reservePlanBody) &&
    /grant\s+execute on function %s to service_role/.test(sql0036) &&
    /'public\.reserve_plan_units\(uuid, uuid, integer\)'/.test(sql0036),
);

// =============================================================================
// [5] release_plan_units —— 🔴 計畫之外新增的窄窗口補救函式
// =============================================================================
console.log("\n[5] release_plan_units()（0036 檔頭 §3 那個額外的函式）");
const releasePlanBody = functionBody(sql0036, "public.release_plan_units");
checkTrue("切得出 release_plan_units 的函式本體", releasePlanBody.length > 200);
checkTrue(
  "只鎖方案，不鎖場次（從不讀寫 event_sessions，兩個資源沒有互相等待的環）",
  !releasePlanBody.includes("event_sessions"),
);
checkTrue(
  "扣回去用 greatest(0, …)，不會扣成負的",
  /greatest\(0, p\.units_taken - p_units\)/.test(releasePlanBody),
);
checkTrue(
  "best effort：有 exception when others then return 0",
  /exception\s+when others then\s*\n\s*return 0;/.test(releasePlanBody),
);
checkTrue(
  "一句 raise 都沒有（絕不 throw）",
  (releasePlanBody.match(/raise exception/gi) ?? []).length === 0,
);
checkTrue("只 grant service_role", /'public\.release_plan_units\(uuid, integer\)'/.test(sql0036));

// =============================================================================
// [6] release_session_seat —— 一併回沖 units_taken，冪等性沒有被破壞
// =============================================================================
console.log("\n[6] release_session_seat() 加了方案回沖之後，原本的契約還在");
const releaseSeatBody = functionBody(sql0036, "public.release_session_seat");
checkTrue("切得出 release_session_seat 的函式本體", releaseSeatBody.length > 400);
checkTrue(
  "簽章逐字未變：public.release_session_seat(bigint)",
  sql0036.includes(
    "create or replace function public.release_session_seat(p_order_item_id bigint)",
  ),
);
checkTrue(
  "還是用 DELETE…RETURNING 當冪等 claim",
  /delete from public\.event_registrations r\s*\n\s*where r\.order_item_id = p_order_item_id\s*\n\s*returning 1/.test(
    releaseSeatBody,
  ),
);
checkTrue(
  "還是有 exception when others（絕不 throw）",
  /exception\s+when others then/.test(releaseSeatBody),
);
checkTrue(
  "null 參數還是回 0",
  /if p_order_item_id is null then\s*\n\s*return 0;/.test(releaseSeatBody),
);
checkTrue(
  "場次的位子還是用 greatest(0, …) 扣回去",
  /greatest\(0, s\.seats_taken - v_freed\)/.test(releaseSeatBody),
);
checkTrue(
  "🔴 方案的名額也一併回沖，用 greatest(0, …) 扣",
  /greatest\(0, p\.units_taken - coalesce\(v_quantity, 0\)\)/.test(releaseSeatBody),
);
checkTrue(
  "🔴 還原量是 order_item 自己的 quantity，不是從 v_freed 換算（見 0036 檔頭 §4）",
  releaseSeatBody.includes("select oi.plan_id, oi.quantity into v_plan_id, v_quantity") &&
    !/v_freed\s*\/\s*/.test(releaseSeatBody),
);
checkTrue(
  "方案回沖包在 `if v_freed > 0` 裡——第二次呼叫（v_freed=0）兩個回沖都自然是 no-op",
  /if v_freed > 0 then[\s\S]*?greatest\(0, p\.units_taken - coalesce\(v_quantity, 0\)\)[\s\S]*?end if;/.test(
    releaseSeatBody,
  ),
);
{
  const sessLockIdx = releaseSeatBody.indexOf(
    "perform 1 from public.event_sessions s where s.id = v_session for no key update;",
  );
  const planLockIdx = releaseSeatBody.indexOf(
    "perform 1 from public.event_session_plans p where p.id = v_plan_id for no key update;",
  );
  checkTrue(
    "🔴 場次先鎖、方案後鎖（同一個固定順序）",
    sessLockIdx !== -1 && planLockIdx !== -1 && sessLockIdx < planLockIdx,
  );
}

// =============================================================================
// [7] expire_unpaid_orders —— RETURNS TABLE 形狀逐字不變，第 4d 步存在
// =============================================================================
console.log("\n[7] expire_unpaid_orders() 的回傳形狀與新增的第 4d 步");

function returnsTableBlock(sql) {
  const i = sql.indexOf("create or replace function public.expire_unpaid_orders");
  if (i === -1) return "";
  const start = sql.indexOf("returns table", i);
  const end = sql.indexOf(")", sql.indexOf("restored_seats", start));
  if (start === -1 || end === -1) return "";
  return sql
    .slice(start, end + 1)
    .replace(/\s+/g, " ")
    .trim();
}

const shape0011 = returnsTableBlock(exec0011);
const shape0036 = returnsTableBlock(sql0036);
checkTrue("抽得出 0011 的 returns table 區塊", shape0011.length > 60);
checkTrue("抽得出 0036 的 returns table 區塊", shape0036.length > 60);
check("🔴 0036 的回傳形狀與 0011 逐字相同", shape0036, shape0011);
checkTrue(
  "參數簽章逐字未變",
  /p_older_than interval default '30 minutes',\s*\n?\s*p_limit\s+integer\s+default 200/.test(
    sql0036,
  ),
);

const expireBody = functionBody(sql0036, "public.expire_unpaid_orders");
checkTrue("4b 保留列刪除還在", expireBody.includes("delete from public.stock_reservations"));
checkTrue(
  "4c（放掉場次名額）還在，data-modifying CTE",
  /with freed as \([\s\S]{0,300}returning r\.session_id[\s\S]{0,300}update public\.event_sessions/.test(
    expireBody,
  ),
);
checkTrue(
  "🔴 匯款訂單的過期門檻至少 3 天（0034，沒有被這一支動到）",
  /payment_method = 'transfer'[\s\S]{0,160}greatest\(p_older_than, interval '3 days'\)/.test(
    expireBody,
  ),
);
checkTrue(
  "非匯款訂單仍是 else p_older_than end)（0034 逐字保留）",
  /else p_older_than end\)/.test(expireBody),
);
checkTrue(
  "🔴 新增第 4d 步：放掉方案名額，鎖序在 4c（場次）之後",
  (() => {
    // ⚠️ 用未剝註解的原始檔找章節標記——sql0036／expireBody 已經被
    // stripSqlComments() 拿掉所有 `--` 開頭的行，「-- ---- 4c.」這種章節註解
    // 本身也會被剝掉，用它們當 marker 只能查原始檔。
    const raw = readFile(MIG_0036);
    const c4Idx = raw.indexOf("-- ---- 4c.");
    const d4Idx = raw.indexOf("-- ---- 4d.");
    return c4Idx !== -1 && d4Idx !== -1 && c4Idx < d4Idx;
  })(),
);
checkTrue(
  "4d 用 order_items.quantity 當還原基準（不是從 event_registrations 反推）",
  /select oi\.plan_id as pid, sum\(oi\.quantity\)::integer as qty\s*\n\s*from public\.order_items oi\s*\n\s*where oi\.order_id = any\(v_ids\)\s*\n\s*and oi\.plan_id is not null/.test(
    stripSqlComments(sql0036),
  ),
);
checkTrue(
  "4d 也用 greatest(0, …) 扣、也鎖方案（for no key update）",
  /update public\.event_session_plans p\s*\n\s*set units_taken = greatest\(0, p\.units_taken - agg\.qty\)/.test(
    stripSqlComments(sql0036),
  ) &&
    /from public\.event_session_plans p\s*\n\s*where p\.id in \(/.test(stripSqlComments(sql0036)),
);
checkTrue(
  "重跑一次 revoke/grant，避免 create or replace 之後權限漂移",
  /revoke execute on function public\.release_session_seat\(bigint\) from public/.test(sql0036) &&
    /revoke execute on function public\.expire_unpaid_orders\(interval, integer\) from public/.test(
      sql0036,
    ),
);

// =============================================================================
// [8] checkoutItemSchema —— planId 有，金額欄位沒有
// =============================================================================
console.log("\n[8] src/lib/checkout.ts：planId 加了、沒有加任何金額欄位");
const checkoutTs = readFile(join(ROOT, "src/lib/checkout.ts"));
const checkoutItemBlock = checkoutTs.slice(
  checkoutTs.indexOf("export const checkoutItemSchema"),
  checkoutTs.indexOf("export const checkoutPayloadSchema"),
);
checkTrue(
  "checkoutItemSchema 有 planId，選填、uuid",
  /planId:\s*z\.string\(\)\.uuid\(\)\.nullable\(\)\.optional\(\)/.test(checkoutItemBlock),
);
checkTrue(
  "🔴 checkoutItemSchema 整段沒有任何 price／amount／subtotal／total 欄位",
  !/\b(price|amount|subtotal|total)\s*:/.test(stripTs(checkoutItemBlock)),
);

// -----------------------------------------------------------------------------
// [9] 真的呼叫 zod：payload 塞 price／subtotal 會被剝掉
// -----------------------------------------------------------------------------
console.log("\n[9] 真的呼叫 checkoutItemSchema.parse() —— 不是讀原始碼，是真的解析");
{
  const checkoutModule = await import(pathToFileURL(join(ROOT, "src/lib/checkout.ts")).href);
  const tampered = {
    productId: "some-product",
    quantity: 2,
    sessionId: "11111111-1111-4111-8111-111111111111",
    planId: "22222222-2222-4222-8222-222222222222",
    // 🔴 攻擊者塞進來的金額欄位——zod 的預設行為是剝掉未知的 key，不是報錯。
    price: 1,
    unitPrice: 1,
    subtotal: 1,
    total: 1,
    amount: 1,
  };
  const parsed = checkoutModule.checkoutItemSchema.parse(tampered);
  checkTrue("planId 有被留下來", parsed.planId === tampered.planId);
  checkTrue(
    "🔴 price／unitPrice／subtotal／total／amount 全部被剝掉，一個都不在解析結果裡",
    !("price" in parsed) &&
      !("unitPrice" in parsed) &&
      !("subtotal" in parsed) &&
      !("total" in parsed) &&
      !("amount" in parsed),
  );
}

// =============================================================================
// [10] src/server/repos/orders.ts —— priceLines() 的方案驗證
// =============================================================================
console.log("\n[10] priceLines()：方案的四種失敗收斂成同一句錯誤");
const ordersTs = readFile(join(ROOT, "src/server/repos/orders.ts"));
const ordersTsStripped = stripTs(ordersTs);
{
  const start = ordersTsStripped.indexOf("if (w.planId !== null) {");
  const end = ordersTsStripped.indexOf("const seatsNeeded = w.quantity * seatsPerUnit;");
  const block = ordersTsStripped.slice(start, end);
  checkTrue("找得到方案驗證那個區塊", start !== -1 && end !== -1 && block.length > 100);
  checkTrue(
    "四個子條件都在（不存在、不屬於這個場次、已下架、超出販售期間兩端）",
    /!plan/.test(block) &&
      /plan\.session_id !== session\.id/.test(block) &&
      /plan\.status !== "open"/.test(block) &&
      /opensAt/.test(block) &&
      /closesAt/.test(block),
  );
  checkTrue(
    "🔴 這個區塊只有一個 throw，而且是 product_unavailable——四種失敗因此天生同一句話",
    (block.match(/throw new CheckoutError/g) ?? []).length === 1 &&
      block.includes('throw new CheckoutError("product_unavailable")'),
  );
}
checkTrue(
  "🔴 座位需求改成 quantity × seatsPerUnit，不是只有 quantity",
  ordersTsStripped.includes("const seatsNeeded = w.quantity * seatsPerUnit;") &&
    ordersTsStripped.includes("if (w.participants.length !== seatsNeeded)"),
);
checkTrue(
  "沒有方案時 seatsPerUnit 恆為 1（let seatsPerUnit = 1 的初始值，不在 if 分支裡才會改）",
  /let seatsPerUnit = 1;/.test(ordersTsStripped),
);
checkTrue(
  "非活動商品帶 planId 也視為竄改（同 sessionId 的判斷）",
  ordersTsStripped.includes(
    "} else if (w.sessionId !== null || w.planId !== null || w.participants.length > 0) {",
  ),
);
checkTrue(
  "wanted 這個 Map 的 key 也把 planId 算進去（同一場次不同方案要分成不同行）",
  ordersTsStripped.includes('const key = `${item.productId}:${sessionId ?? ""}:${planId ?? ""}`;'),
);
checkTrue(
  "「便宜、不寫入」的提早拒絕也檢查方案的名額",
  /if \(line\.planId !== null\) \{\s*\n\s*const plan = planById\.get\(line\.planId\)!;\s*\n\s*if \(plan\.units_taken \+ line\.quantity > plan\.capacity\)/.test(
    ordersTsStripped,
  ),
);

// =============================================================================
// [11] src/server/repos/orders.ts —— createOrder() 的呼叫順序與補救
// =============================================================================
console.log("\n[11] createOrder()：先方案後座位，座位失敗要補救方案");
{
  const anyPlanIdx = ordersTsStripped.indexOf(
    "const anyPlan = lines.some((l) => l.planId !== null);",
  );
  // ⚠️ 用 regex 不用 indexOf 字面值——prettier 會依行寬決定 itemIdByKey.set(...)
  // 這一句要不要換行，鎖死單行字面值等於鎖死格式化工具的輸出，跟著它的心情變紅。
  const itemIdKeyMatch =
    /itemIdByKey\.set\(\s*`\$\{row\.product_id \?\? ""\}:\$\{row\.session_id \?\? ""\}:\$\{row\.plan_id \?\? ""\}`,\s*row\.id,?\s*\);/.test(
      ordersTsStripped,
    );
  checkTrue("order_items 的 insert 有 anyPlan 這個布林", anyPlanIdx !== -1);
  checkTrue("itemIdByKey 的 key 也把 plan_id 算進去", itemIdKeyMatch);

  const reservePlanCallIdx = ordersTsStripped.indexOf('db.rpc("reserve_plan_units"');
  const reserveSeatCallIdx = ordersTsStripped.indexOf(
    'db.rpc("reserve_session_seat"',
    reservePlanCallIdx,
  );
  checkTrue(
    "🔴 reserve_plan_units() 的呼叫在 reserve_session_seat() 之前（見 0036 檔頭 §3）",
    reservePlanCallIdx !== -1 &&
      reserveSeatCallIdx !== -1 &&
      reservePlanCallIdx < reserveSeatCallIdx,
  );

  const releasePlanUnitsCallIdx = ordersTsStripped.indexOf(
    "await releasePlanUnits(line.planId, line.quantity);",
  );
  checkTrue(
    "🔴 座位保留失敗時會呼叫 releasePlanUnits() 補救——不是靠 release_session_seat 反推",
    releasePlanUnitsCallIdx !== -1 &&
      releasePlanUnitsCallIdx > reserveSeatCallIdx &&
      releasePlanUnitsCallIdx <
        ordersTsStripped.indexOf("reservedItemIds.push(orderItemId);", reserveSeatCallIdx),
  );

  const seatsNeededCreateOrderIdx = ordersTsStripped.indexOf(
    "const seatsNeeded = line.quantity * line.seatsPerUnit;",
    reservePlanCallIdx,
  );
  checkTrue(
    "p_quantity 傳給 reserve_session_seat 的是座位數（quantity × seatsPerUnit）",
    seatsNeededCreateOrderIdx !== -1 && seatsNeededCreateOrderIdx < reserveSeatCallIdx,
  );
}
checkTrue(
  "releasePlanUnits() 自己是 best effort（catch 吞掉，不 throw）",
  /async function releasePlanUnits[\s\S]{0,400}\} catch \{/.test(ordersTsStripped),
);

// =============================================================================
// [12] 後台：removeEventSessionPlan() 先查再刪（0035 的教訓）
// =============================================================================
console.log("\n[12] 後台刪方案：先查 order_items，不讓裸的 FK 錯誤冒出來");
const eventSessionsRepoTs = readFile(join(ROOT, "src/server/repos/event-sessions.ts"));
const eventSessionsRepoStripped = stripTs(eventSessionsRepoTs);
{
  const fnStart = eventSessionsRepoStripped.indexOf("export async function removeEventSessionPlan");
  checkTrue("removeEventSessionPlan() 存在", fnStart !== -1);
  const fnBody = eventSessionsRepoStripped.slice(fnStart, fnStart + 1500);
  const countCheckIdx = fnBody.indexOf('.eq("plan_id", id)');
  const deleteIdx = fnBody.indexOf('.from("event_session_plans")\n    .delete');
  checkTrue(
    "🔴 檢查 order_items 是不是有這個 plan_id 在真的 delete 之前",
    countCheckIdx !== -1 && deleteIdx !== -1 && countCheckIdx < deleteIdx,
  );
  checkTrue(
    "有訂單就回一個人話 reason，不往下執行 delete",
    fnBody.includes('return { deleted: false, reason: "plan_has_orders" };'),
  );
}

// =============================================================================
// [13] 後台：授權掛對了 middleware
// =============================================================================
console.log("\n[13] 後台 server fn：讀走 event.roster.read，寫走 adminFnMiddleware");
const eventSessionsFnsTs = readFile(join(ROOT, "src/lib/admin/fns/event-sessions.ts"));
const eventSessionsFnsStripped = stripTs(eventSessionsFnsTs);
checkTrue(
  "listEventSessionPlans 掛 staffFnMiddleware + requireRosterRead",
  /export const listEventSessionPlans = createServerFn\(\{ method: "GET" \}\)\s*\n\s*\.middleware\(\[staffFnMiddleware\(\)\]\)\s*\n\s*\.handler\(async \(\{ context \}\) => \{\s*\n\s*await requireRosterRead\(context\.staff\.permissions\);/.test(
    eventSessionsFnsStripped,
  ),
);
checkTrue(
  "upsertEventSessionPlan 掛 adminFnMiddleware",
  /export const upsertEventSessionPlan = createServerFn\(\{ method: "POST" \}\)\s*\n\s*\.middleware\(\[adminFnMiddleware\]\)/.test(
    eventSessionsFnsStripped,
  ),
);
checkTrue(
  "removeEventSessionPlan 掛 adminFnMiddleware",
  /export const removeEventSessionPlan = createServerFn\(\{ method: "POST" \}\)\s*\n\s*\.middleware\(\[adminFnMiddleware\]\)/.test(
    eventSessionsFnsStripped,
  ),
);

// =============================================================================
// [14] 後台表單：eventSessionPlanSchema 的值必須動態匯入
// =============================================================================
console.log("\n[14] SessionPlansEditor.tsx：schema 值走動態匯入（bundle-admin-leak 的紀律）");
const editorTs = readFile(join(ROOT, "src/components/admin/SessionPlansEditor.tsx"));
const editorStripped = stripTs(editorTs);
checkTrue(
  "🔴 檔案頂層沒有把 eventSessionPlanSchema 當值靜態匯入",
  !/^import\s*\{[^}]*\beventSessionPlanSchema\b[^}]*\}\s*from\s*"@\/lib\/admin\/schemas"/m.test(
    editorStripped,
  ),
);
checkTrue(
  "型別是用 import type 拿的（編譯期會被整段擦除）",
  /import type \{ EventSessionPlanFormValues \} from "@\/lib\/admin\/schemas";/.test(
    editorStripped,
  ),
);
checkTrue(
  "真的有動態 import() 去拿 eventSessionPlanSchema 這個值",
  /import\("@\/lib\/admin\/schemas"\)/.test(editorStripped) &&
    /mod\.eventSessionPlanSchema/.test(editorStripped),
);

// =============================================================================
// [15] admin/schemas.ts —— eventSessionPlanSchema 本身
// =============================================================================
console.log("\n[15] eventSessionPlanSchema：沒有 units_taken");
const schemasTs = readFile(join(ROOT, "src/lib/admin/schemas.ts"));
{
  const start = schemasTs.indexOf("export const eventSessionPlanSchema");
  const end = schemasTs.indexOf("export type EventSessionPlanFormValues");
  const block = schemasTs.slice(start, end);
  checkTrue("找得到 eventSessionPlanSchema", start !== -1 && block.length > 100);
  checkTrue(
    "沒有 units_taken 欄位——那個計數器只由持有列鎖的 SQL 函式維護",
    !/units_taken/.test(block),
  );
}

console.log(`\n[靜態段] ${pass} passed so far, ${fail} failed so far`);

// =============================================================================
// 併發段
// =============================================================================

const PG_URL = process.env.PLAN_SELFTEST_PG_URL;

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

// 🔴 刻意跟 event-registration-selftest.mjs 的 evtselftest- 用不同前綴，兩支自檢
// 各自的 CLEANUP_SQL 才不會互相踩到對方的測試資料。
const SLUG_PREFIX = "planselftest-";
const KEY_PREFIX = "planselftest-";

const CLEANUP_SQL = `
delete from public.event_registrations r
 where r.order_id in (select o.id from public.orders o where o.idempotency_key like '${KEY_PREFIX}%')
    or r.session_id in (select s.id from public.event_sessions s
                         where s.product_id like '${SLUG_PREFIX}%');
delete from public.orders where idempotency_key like '${KEY_PREFIX}%';
delete from public.event_session_plans p
 where p.session_id in (select s.id from public.event_sessions s where s.product_id like '${SLUG_PREFIX}%');
delete from public.event_sessions where product_id like '${SLUG_PREFIX}%';
delete from public.products where id like '${SLUG_PREFIX}%';
`;

if (!PG_URL) {
  skipped.push("併發測試（缺 PLAN_SELFTEST_PG_URL）");
  console.log(yellow("\n[16+] 併發測試 —— 跳過：沒有 PLAN_SELFTEST_PG_URL"));
  console.log(
    yellow("       設好之後重跑，才會驗到名額五條、防竄改四條、並發兩條。指令見本檔檔頭。"),
  );
} else {
  try {
    if (process.env.PLAN_SELFTEST_APPLY === "1") {
      console.log("\n[16] 套用 0036（假設 0001–0035 已經在這個資料庫上）");
      const r = await q(readFile(MIG_0036));
      if (!r.ok) throw new Error(`套用 0036 失敗：${r.error.slice(0, 800)}`);
      checkTrue("0036 套用完成", true);
      const again = await q(readFile(MIG_0036));
      checkTrue("0036 套第二次零錯誤（冪等）", again.ok);
      if (!again.ok) console.log(red(`      ${again.error.slice(0, 400)}`));
    }

    checkTrue(
      "前置：資料庫已經套到 0036（新表與兩支新函式都存在）",
      Boolean(
        one(
          await must(`select
            to_regclass('public.event_session_plans') is not null
            and to_regprocedure('public.reserve_plan_units(uuid,uuid,integer)') is not null
            and to_regprocedure('public.release_plan_units(uuid,integer)') is not null
            ok`),
        )?.ok,
      ),
      "沒有的話先照本檔檔頭設 PLAN_SELFTEST_APPLY=1 套一次。",
    );

    console.log("\n[17] 前置：清理殘骸並建立測試資料");
    await must(CLEANUP_SQL);

    const LOC = `'{"zh":"自檢","en":"selftest","ja":"セルフテスト"}'::jsonb`;
    const S = { a: `${SLUG_PREFIX}a`, b: `${SLUG_PREFIX}b` };
    // 場次：各自的 capacity 配合不同測試組的需要。
    const SESS = {
      plenty: "eeee0000-0000-4000-8000-000000000001", // 位子很多，測方案自己的名額擋不擋得住
      tight3: "eeee0000-0000-4000-8000-000000000002", // 只剩 3 位，測雙人房需要 4 位會被拒
      control: "eeee0000-0000-4000-8000-000000000003", // 沒有任何方案，對照組
      race: "eeee0000-0000-4000-8000-000000000004", // 專給 [22] 併發超賣用
      lockA: "eeee0000-0000-4000-8000-000000000005", // 死鎖測試：同一場次
    };
    // 方案：single（一單位一位）、double（一單位兩位＝雙人房）各自配一組。
    const PLAN = {
      double: "ffff0000-0000-4000-8000-000000000001", // 掛在 SESS.plenty，capacity 10
      almostFull: "ffff0000-0000-4000-8000-000000000002", // 掛在 SESS.plenty，capacity 3／units_taken 2（剩 1）
      doubleTight: "ffff0000-0000-4000-8000-000000000003", // 掛在 SESS.tight3
      otherSession: "ffff0000-0000-4000-8000-000000000004", // 掛在 SESS.control，用來測「方案不屬於這個場次」
      closed: "ffff0000-0000-4000-8000-000000000005", // status='closed'
      notYet: "ffff0000-0000-4000-8000-000000000006", // sale_starts_at 在未來
      ended: "ffff0000-0000-4000-8000-000000000007", // sale_ends_at 在過去
      raceOne: "ffff0000-0000-4000-8000-000000000008", // capacity 1，給 [22] 併發用
      lockP1: "ffff0000-0000-4000-8000-000000000009", // 死鎖測試用，掛 SESS.lockA
      lockP2: "ffff0000-0000-4000-8000-00000000000a", // 死鎖測試用，掛 SESS.lockA
    };

    await must(`
      insert into public.products (id, slug, product_type, title, summary, description, price, requires_shipping, status) values
        ('${S.a}','${S.a}','event',${LOC},${LOC},${LOC},1000,false,'active'),
        ('${S.b}','${S.b}','event',${LOC},${LOC},${LOC},1000,false,'active');
      insert into public.event_sessions (id, product_id, title, location, starts_at, capacity, status) values
        ('${SESS.plenty}',  '${S.a}',${LOC},${LOC}, now() + interval '30 days', 999, 'open'),
        ('${SESS.tight3}',  '${S.a}',${LOC},${LOC}, now() + interval '30 days', 3,   'open'),
        ('${SESS.control}', '${S.b}',${LOC},${LOC}, now() + interval '30 days', 999, 'open'),
        ('${SESS.race}',    '${S.a}',${LOC},${LOC}, now() + interval '30 days', 999, 'open'),
        ('${SESS.lockA}',   '${S.a}',${LOC},${LOC}, now() + interval '30 days', 999, 'open');
      insert into public.event_session_plans
        (id, session_id, title, price, seats_per_unit, capacity, units_taken, status, sale_starts_at, sale_ends_at) values
        -- units_taken 從 5 開始（不是 0）：這是刻意的，不是隨便選的數字——見
        -- [18]／[21] 對 release_session_seat() 的還原量斷言。如果從 0 開始，
        -- 「用 v_freed（座位數）換算」與「用 order_item.quantity（單位數）換算」
        -- 這兩種寫法在 units_taken <= 0 時都會被 greatest(0, …) 夾成同一個答案
        -- （0），突變測試會測不出兩者的差異。從 5 開始，兩種寫法會給出不同的
        -- 非零答案，斷言才真的驗得到「用對了哪一個」。
        ('${PLAN.double}',       '${SESS.plenty}',  ${LOC}, 3000, 2, 10, 5, 'open', null, null),
        ('${PLAN.almostFull}',   '${SESS.plenty}',  ${LOC}, 1000, 1, 3,  2, 'open', null, null),
        ('${PLAN.doubleTight}',  '${SESS.tight3}',  ${LOC}, 3000, 2, 10, 0, 'open', null, null),
        ('${PLAN.otherSession}', '${SESS.control}', ${LOC}, 1000, 1, 10, 0, 'open', null, null),
        ('${PLAN.closed}',       '${SESS.plenty}',  ${LOC}, 1000, 1, 10, 0, 'closed', null, null),
        ('${PLAN.notYet}',       '${SESS.plenty}',  ${LOC}, 1000, 1, 10, 0, 'open', now() + interval '7 days', null),
        ('${PLAN.ended}',        '${SESS.plenty}',  ${LOC}, 1000, 1, 10, 0, 'open', null, now() - interval '7 days'),
        ('${PLAN.raceOne}',      '${SESS.race}',    ${LOC}, 1000, 1, 1,  0, 'open', null, null),
        ('${PLAN.lockP1}',       '${SESS.lockA}',   ${LOC}, 1000, 1, 99, 0, 'open', null, null),
        ('${PLAN.lockP2}',       '${SESS.lockA}',   ${LOC}, 1000, 1, 99, 0, 'open', null, null);
    `);
    checkTrue("fixture 建立完成", true);

    const people = (n) =>
      JSON.stringify(
        Array.from({ length: n }, (_, i) => ({
          name: `自檢${i + 1}`,
          email: `p${i + 1}@example.invalid`,
          noticeAck: "true",
        })),
      );

    /**
     * 幾乎逐字照抄 src/server/repos/orders.ts 現在的順序（見那個檔案 createOrder()
     * 的 step 5）：先 reserve_plan_units()（如果這一行有方案），再
     * reserve_session_seat()；後者失敗的話呼叫 release_plan_units() 補救掉前者剛
     * 保留的份。跟 event-registration-selftest.mjs 的 book() 一樣，刻意分成好幾個
     * **獨立**的 q() 呼叫（各自一條新連線、一個新交易），不是包成一句方便測試——
     * 那樣就不是在測 orders.ts 真正在跑的東西了。
     *
     * `plan` 為 null 時完全跳過方案那兩步，行為等於 0020 之前的 book()——這是對照組
     * （[21]）要用的路徑。
     */
    async function bookPlan(key, { product, session, plan, units, seatsPerUnit, peopleCount }) {
      const setup = await q(`
        do $$
        declare v_order uuid;
        begin
          insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
          values ('自檢','selftest@example.invalid','0900000000', ${units * 1000}, ${units * 1000}, '${key}')
          returning id into v_order;

          insert into public.order_items
            (order_id, product_id, session_id, plan_id, plan_title, name, unit_price, quantity, subtotal, product_type)
          values
            (v_order, '${product}', '${session}', ${plan ? `'${plan}'::uuid` : "null"},
             ${plan ? LOC : "null"}, ${LOC}, 1000, ${units}, ${units * 1000}, 'event');
        end $$;
      `);
      if (!setup.ok) return setup;

      const orderRow = one(
        await must(`select id from public.orders where idempotency_key = '${key}'`),
      );
      const itemRow = one(
        await must(`select id from public.order_items where order_id = '${orderRow.id}'`),
      );

      if (plan) {
        const planResult = await q(
          `select public.reserve_plan_units('${orderRow.id}'::uuid, '${plan}'::uuid, ${units})`,
        );
        if (!planResult.ok) {
          // 跟 orders.ts 的 createOrder() 一樣：這一行任何一步失敗，整張訂單都會
          // 被 deleteOrder() 刪掉，不會留著。這裡照做——不留殘骸訂單是刻意的，
          // 不是可省的一步：留著的話，之後任何一段呼叫 expire_unpaid_orders()
          // 的測試都可能意外把它掃進去（它是真的 status='pending' 的訂單）。
          await q(`delete from public.orders where id = '${orderRow.id}'`);
          return { ...planResult, orderId: orderRow.id, itemId: itemRow.id };
        }
      }

      const seatsNeeded = units * (seatsPerUnit ?? 1);
      const seatResult = await q(
        `select public.reserve_session_seat('${orderRow.id}'::uuid, ${itemRow.id}::bigint, '${session}'::uuid, ${seatsNeeded}, '${people(peopleCount ?? seatsNeeded)}'::jsonb)`,
      );
      if (!seatResult.ok) {
        if (plan) await q(`select public.release_plan_units('${plan}'::uuid, ${units})`);
        await q(`delete from public.orders where id = '${orderRow.id}'`);
        return { ...seatResult, orderId: orderRow.id, itemId: itemRow.id };
      }
      return { ok: true, error: null, rows: [], orderId: orderRow.id, itemId: itemRow.id };
    }

    const planCounters = async (planId) =>
      one(
        await must(
          `select units_taken, capacity from public.event_session_plans where id = '${planId}'`,
        ),
      );
    const sessionCounters = async (sessionId) =>
      one(
        await must(
          `select seats_taken, capacity from public.event_sessions where id = '${sessionId}'`,
        ),
      );
    const regCount = async (itemId) =>
      Number(
        one(
          await must(
            `select count(*)::int n from public.event_registrations where order_item_id = ${itemId}`,
          ),
        ).n,
      );

    // ===========================================================================
    // [18] 驗收條件①：買 2 個雙人房 → 場次 +4、方案 +2、registrations 4 列、seat_no 1-4
    // ===========================================================================
    console.log("\n[18] 驗收①：買 2 個雙人房");
    {
      const before = await sessionCounters(SESS.plenty);
      const beforePlan = await planCounters(PLAN.double);
      const r = await bookPlan(`${KEY_PREFIX}c1-double`, {
        product: S.a,
        session: SESS.plenty,
        plan: PLAN.double,
        units: 2,
        seatsPerUnit: 2,
      });
      checkTrue("下單成功", r.ok);
      const after = await sessionCounters(SESS.plenty);
      const afterPlan = await planCounters(PLAN.double);
      check("場次 seats_taken +4", after.seats_taken - before.seats_taken, 4);
      check("方案 units_taken +2", afterPlan.units_taken - beforePlan.units_taken, 2);
      check("event_registrations 4 列", await regCount(r.itemId), 4);
      const seatNos = (
        await must(
          `select seat_no from public.event_registrations where order_item_id = ${r.itemId} order by seat_no`,
        )
      ).map((row) => row.seat_no);
      check("seat_no 是 1..4", seatNos.join(","), "1,2,3,4");

      // 收尾：這裡故意不留著讓它變成後面幾段的隱性殘骸——SESS.plenty／PLAN.double
      // 接下來還會被 [21]／[21b] 重用，[21b] 更是會呼叫全域的
      // expire_unpaid_orders()，一張沒清乾淨的 pending 訂單會被那句意外掃到，
      // 讓那一段的「回到原值」斷言對錯全看巧合。
      await must(`select public.release_session_seat(${r.itemId})`);
      const afterCleanup = await planCounters(PLAN.double);
      // 🔴 這條順便也是突變測試會用到的那一條：units_taken 從非零基準值（5）
      // 開始，所以「用 order_item.quantity（2）換算」與「用 v_freed（4，座位數）
      // 換算」在這裡會給出不同答案（5 vs 3），不會被 greatest(0,…) 夾成一樣。
      check(
        "清場後方案 units_taken 回到清場前的基準值",
        afterCleanup.units_taken,
        beforePlan.units_taken,
      );
      await must(`delete from public.orders where idempotency_key = '${KEY_PREFIX}c1-double'`);
    }

    // ===========================================================================
    // [19] 驗收條件②：方案名額剩 1、場次位子很多 → 買 2 單位被拒，兩個計數器都沒變
    // ===========================================================================
    console.log("\n[19] 驗收②：方案剩 1，買 2 單位被拒");
    {
      const before = await sessionCounters(SESS.plenty);
      const beforePlan = await planCounters(PLAN.almostFull);
      check(
        "前置：方案確實只剩 1（capacity 3 − units_taken 2）",
        beforePlan.capacity - beforePlan.units_taken,
        1,
      );
      const r = await bookPlan(`${KEY_PREFIX}c2-shortplan`, {
        product: S.a,
        session: SESS.plenty,
        plan: PLAN.almostFull,
        units: 2,
        seatsPerUnit: 1,
      });
      checkTrue("被拒絕", !r.ok);
      checkTrue("錯誤是 NO_PLAN_UNITS_LEFT", /NO_PLAN_UNITS_LEFT/.test(r.error ?? ""));
      const after = await sessionCounters(SESS.plenty);
      const afterPlan = await planCounters(PLAN.almostFull);
      check("場次 seats_taken 沒變", after.seats_taken, before.seats_taken);
      check("方案 units_taken 沒變", afterPlan.units_taken, beforePlan.units_taken);
      check("沒有殘骸 registrations", await regCount(r.itemId), 0);
    }

    // ===========================================================================
    // [20] 驗收條件③：場次位子剩 3、雙人房→買 2 單位（要 4 位）被拒，兩個計數器都沒變
    // ===========================================================================
    console.log("\n[20] 驗收③：場次只剩 3 位，雙人房買 2 單位（要 4 位）被拒");
    console.log("       這是 0036 檔頭 §3 那個窄窗口的真正測試——方案會先保留成功，");
    console.log("       接著座位保留失敗，靠 release_plan_units() 補救回去。");
    {
      const before = await sessionCounters(SESS.tight3);
      const beforePlan = await planCounters(PLAN.doubleTight);
      const r = await bookPlan(`${KEY_PREFIX}c3-tightsession`, {
        product: S.a,
        session: SESS.tight3,
        plan: PLAN.doubleTight,
        units: 2,
        seatsPerUnit: 2,
      });
      checkTrue("被拒絕", !r.ok);
      checkTrue(
        "錯誤是 NO_SEATS_LEFT（場次的位子不夠，不是方案的單位不夠）",
        /NO_SEATS_LEFT/.test(r.error ?? ""),
      );
      const after = await sessionCounters(SESS.tight3);
      const afterPlan = await planCounters(PLAN.doubleTight);
      check("場次 seats_taken 沒變", after.seats_taken, before.seats_taken);
      check(
        "🔴 方案 units_taken 也沒變（靠 releasePlanUnits() 補救，不是靠 release_session_seat 反推）",
        afterPlan.units_taken,
        beforePlan.units_taken,
      );
      check("沒有殘骸 registrations", await regCount(r.itemId), 0);
    }

    // ===========================================================================
    // [21] 驗收條件④：取消／過期一筆有方案的訂單 → 兩個計數器都回沖
    // ===========================================================================
    console.log("\n[21] 驗收④a：release_session_seat() 直接回收（模擬完整回滾／admin 刪單）");
    {
      const before = await sessionCounters(SESS.plenty);
      const beforePlan = await planCounters(PLAN.double);
      const r = await bookPlan(`${KEY_PREFIX}c4a-release`, {
        product: S.a,
        session: SESS.plenty,
        plan: PLAN.double,
        units: 1,
        seatsPerUnit: 2,
      });
      checkTrue("先訂成功（前置）", r.ok);
      const mid = await sessionCounters(SESS.plenty);
      const midPlan = await planCounters(PLAN.double);
      check("訂成功後：場次 +2", mid.seats_taken - before.seats_taken, 2);
      check("訂成功後：方案 +1", midPlan.units_taken - beforePlan.units_taken, 1);

      const freed = one(await must(`select public.release_session_seat(${r.itemId}) freed`));
      check("release_session_seat 回報釋放 2 個位子", Number(freed.freed), 2);

      const after = await sessionCounters(SESS.plenty);
      const afterPlan = await planCounters(PLAN.double);
      check("🔴 場次 seats_taken 回到原值", after.seats_taken, before.seats_taken);
      check("🔴 方案 units_taken 也回到原值", afterPlan.units_taken, beforePlan.units_taken);
      check("registrations 清空", await regCount(r.itemId), 0);

      const freedAgain = one(await must(`select public.release_session_seat(${r.itemId}) freed`));
      check("第二次呼叫是冪等的（回 0，不會扣兩次）", Number(freedAgain.freed), 0);
    }

    console.log("\n[21b] 驗收④b：expire_unpaid_orders() 批次過期回收");
    {
      // 🔴 expire_unpaid_orders() 掃的是**全域**的 pending 訂單，不是只掃這一段
      // 自己建的那一張。前面幾段（尤其 [21]）故意留下已經被 release 過、但訂單
      // 列本身還在的 pending 訂單（release_session_seat() 只還名額，不刪訂單）
      // ——那正是這一支自己在測的「訂單真的完整回滾要照順序」那件事的另一面。
      // 這裡先把它們掃乾淨，讓底下的「回到原值」只跟這一段自己建的那張訂單有關，
      // 不會被其他段落的正常殘留污染。
      await must(`delete from public.orders where idempotency_key like '${KEY_PREFIX}%'`);

      const before = await sessionCounters(SESS.plenty);
      const beforePlan = await planCounters(PLAN.double);
      const r = await bookPlan(`${KEY_PREFIX}c4b-expire`, {
        product: S.a,
        session: SESS.plenty,
        plan: PLAN.double,
        units: 3,
        seatsPerUnit: 2,
      });
      checkTrue("先訂成功（前置）", r.ok);
      // 讓它看起來像一張很久以前建立、還沒付款的訂單。
      await must(
        `update public.orders set created_at = now() - interval '1 day' where idempotency_key = '${KEY_PREFIX}c4b-expire'`,
      );
      const expired = await must(
        `select * from public.expire_unpaid_orders('0 seconds'::interval, 500)`,
      );
      const mine = expired.find((row) => row.expired_order_no && row.expired_id === r.orderId);
      checkTrue("這張訂單真的被過期回收了", Boolean(mine));
      if (mine)
        check(
          "🔴 RETURNS TABLE 回報 restored_seats = 6（quantity 3 × seats_per_unit 2，不是 quantity 本身）",
          Number(mine.restored_seats),
          6,
        );

      const after = await sessionCounters(SESS.plenty);
      const afterPlan = await planCounters(PLAN.double);
      check(
        "🔴 場次 seats_taken 回到原值（過期回收也一併還了方案）",
        after.seats_taken,
        before.seats_taken,
      );
      check("🔴 方案 units_taken 也回到原值", afterPlan.units_taken, beforePlan.units_taken);
      check("registrations 清空", await regCount(r.itemId), 0);
      const orderStatus = one(
        await must(
          `select status from public.orders where idempotency_key = '${KEY_PREFIX}c4b-expire'`,
        ),
      );
      check("訂單狀態變成 cancelled", orderStatus.status, "cancelled");
    }

    // ===========================================================================
    // [22] 驗收條件⑤：對照組——沒有方案的場次，行為與現在逐字相同
    // ===========================================================================
    console.log("\n[22] 驗收⑤：對照組，沒有方案的場次一個字都不變");
    {
      const before = await sessionCounters(SESS.control);
      // plan: null → bookPlan() 完全跳過方案那兩步，quantity 直接當座位數——
      // 這正是 0020 之後、0036 之前的行為。
      const r = await bookPlan(`${KEY_PREFIX}c5-control`, {
        product: S.b,
        session: SESS.control,
        plan: null,
        units: 3,
        seatsPerUnit: 1,
      });
      checkTrue("下單成功", r.ok);
      const after = await sessionCounters(SESS.control);
      check(
        "場次 seats_taken +3（quantity 直接等於座位數）",
        after.seats_taken - before.seats_taken,
        3,
      );
      check(
        "event_registrations 3 列（不是 3×seats_per_unit，因為根本沒有 seats_per_unit 這回事）",
        await regCount(r.itemId),
        3,
      );
      const itemRow = one(
        await must(`select plan_id, plan_title from public.order_items where id = ${r.itemId}`),
      );
      check("order_items.plan_id 是 null", itemRow.plan_id, null);
      check("order_items.plan_title 是 null", itemRow.plan_title, null);

      const freed = one(await must(`select public.release_session_seat(${r.itemId}) freed`));
      check("release 正常運作（跟 0020 之前逐字相同）", Number(freed.freed), 3);
      const afterRelease = await sessionCounters(SESS.control);
      check("回沖之後場次回到原值", afterRelease.seats_taken, before.seats_taken);
    }

    // ===========================================================================
    // [23] 驗收條件⑦：planId 指向別場次的方案 → 拒絕，錯誤與「方案不存在」同一種
    // ===========================================================================
    console.log("\n[23] 驗收⑦：planId 指向別的場次");
    {
      const beforeOther = await planCounters(PLAN.otherSession);
      // PLAN.otherSession 掛在 SESS.control，這裡卻拿去配 SESS.plenty 的訂單——
      // reserve_plan_units() 第 ⑤ 步會發現 order_items 那一行的 session_id
      // （SESS.plenty）跟方案的 session_id（SESS.control）對不上。
      const r = await bookPlan(`${KEY_PREFIX}c7-wrongsession`, {
        product: S.a,
        session: SESS.plenty,
        plan: PLAN.otherSession,
        units: 1,
        seatsPerUnit: 1,
      });
      checkTrue("被拒絕", !r.ok);
      checkTrue(
        "SQL 層是 PLAN_ORDER_ITEM_NOT_FOUND（給 log 用的內部代號，不是給客人看的字）",
        /PLAN_ORDER_ITEM_NOT_FOUND/.test(r.error ?? ""),
      );
      const afterOther = await planCounters(PLAN.otherSession);
      check("被冒用的那個方案 units_taken 沒變", afterOther.units_taken, beforeOther.units_taken);

      // 找一個真的不存在的 planId 當對照——orders.ts 對這兩種情況丟出的
      // CheckoutError 必須是同一個 "order_failed"（見 [11] 的靜態斷言：
      // 只有 NO_PLAN_UNITS_LEFT 特殊處理，其餘一律 order_failed）。這裡直接
      // 驗 SQL 層兩者都不是 NO_PLAN_UNITS_LEFT，所以在 orders.ts 那一層
      // 會落到同一個分支。
      const notFound = await q(
        `select public.reserve_plan_units('${r.orderId}'::uuid, '99999999-9999-4999-8999-999999999999'::uuid, 1)`,
      );
      checkTrue("完全不存在的 planId 也被拒絕", !notFound.ok);
      checkTrue("SQL 層是 PLAN_NOT_FOUND", /PLAN_NOT_FOUND/.test(notFound.error ?? ""));
      checkTrue(
        "🔴 兩種失敗在 orders.ts 那一層會落到同一個分支（都不含 NO_PLAN_UNITS_LEFT）",
        !/NO_PLAN_UNITS_LEFT/.test(r.error ?? "") &&
          !/NO_PLAN_UNITS_LEFT/.test(notFound.error ?? ""),
      );
    }

    // ===========================================================================
    // [24] 驗收條件⑧：已下架／超出販售期間 → 同一種失敗
    // ===========================================================================
    console.log("\n[24] 驗收⑧：已下架、還沒開賣、已經過期");
    for (const [label, planId, expectPattern] of [
      ["已下架（status='closed'）", PLAN.closed, /PLAN_NOT_OPEN/],
      ["還沒到開賣時間", PLAN.notYet, /PLAN_NOT_ON_SALE_YET/],
      ["已經過了販售期間", PLAN.ended, /PLAN_SALE_ENDED/],
    ]) {
      const before = await planCounters(planId);
      const orderKey = `${KEY_PREFIX}c8-${planId.slice(-4)}`;
      const setup = await q(`
        do $$
        declare v_order uuid;
        begin
          insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
          values ('自檢','selftest@example.invalid','0900000000',1000,1000,'${orderKey}')
          returning id into v_order;
          insert into public.order_items
            (order_id, product_id, session_id, plan_id, plan_title, name, unit_price, quantity, subtotal, product_type)
          values (v_order, '${S.a}', '${SESS.plenty}', '${planId}'::uuid, ${LOC}, ${LOC}, 1000, 1, 1000, 'event');
        end $$;
      `);
      checkTrue(`${label}：前置 order_item 建立成功`, setup.ok);
      const orderRow = one(
        await must(`select id from public.orders where idempotency_key = '${orderKey}'`),
      );
      const r = await q(
        `select public.reserve_plan_units('${orderRow.id}'::uuid, '${planId}'::uuid, 1)`,
      );
      checkTrue(`${label}：被拒絕`, !r.ok);
      checkTrue(`${label}：錯誤字串符合預期`, expectPattern.test(r.error ?? ""));
      const after = await planCounters(planId);
      check(`${label}：units_taken 沒變`, after.units_taken, before.units_taken);
    }

    // ===========================================================================
    // [25] 驗收條件⑨：reserve_plan_units()／release_plan_units()：anon／authenticated 無執行權
    // ===========================================================================
    console.log("\n[25] 驗收⑨：anon／authenticated 叫不動 reserve_plan_units／release_plan_units");
    for (const role of ["anon", "authenticated"]) {
      for (const [fn, sig] of [
        ["reserve_plan_units", "uuid,uuid,integer"],
        ["release_plan_units", "uuid,integer"],
      ]) {
        const priv = one(
          await must(
            `select has_function_privilege('${role}','public.${fn}(${sig})','execute') ok`,
          ),
        );
        check(`${role} 對 ${fn}() 沒有 execute 權限`, priv.ok, false);
      }
    }
    {
      const priv = one(
        await must(
          `select has_function_privilege('service_role','public.reserve_plan_units(uuid,uuid,integer)','execute') ok`,
        ),
      );
      check("反面對照：service_role 有 execute 權限", priv.ok, true);
    }

    // ===========================================================================
    // [26] 驗收條件⑩：方案名額剩 1，20 個併發請求 → 恰好 1 個成功
    // ===========================================================================
    console.log("\n[26] 併發①：方案 capacity=1，同時發 20 個請求");
    {
      const race = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          bookPlan(`${KEY_PREFIX}race-${i}`, {
            product: S.a,
            session: SESS.race,
            plan: PLAN.raceOne,
            units: 1,
            seatsPerUnit: 1,
          }),
        ),
      );
      const won = race.filter((r) => r.ok);
      const lost = race.filter((r) => !r.ok);
      check("恰好 1 個成功", won.length, 1);
      check("其餘 19 個失敗", lost.length, 19);
      check(
        "19 個失敗全部是 NO_PLAN_UNITS_LEFT",
        lost.filter((r) => /NO_PLAN_UNITS_LEFT/.test(r.error ?? "")).length,
        19,
      );
      const finalPlan = await planCounters(PLAN.raceOne);
      check("🔴 units_taken 最終恰好是 1（不多不少）", finalPlan.units_taken, 1);
      const finalSession = await sessionCounters(SESS.race);
      check("場次 seats_taken 也恰好 +1（沒有殘骸多扣或少扣）", finalSession.seats_taken, 1);
      // 🔴 沒有殘骸訂單：bookPlan() 在任何一步失敗時都會刪掉整張訂單（照
      // orders.ts 的 deleteOrder() 逐字照抄），所以 20 個請求打完，資料庫裡應該
      // 只剩下**那 1 張成功的**——19 張失敗的訂單連同它們的 order_items 必須
      // 完全消失，不是「還在但沒有 registrations」。
      const survivingOrders = Number(
        one(
          await must(
            `select count(*)::int n from public.orders where idempotency_key like '${KEY_PREFIX}race-%'`,
          ),
        ).n,
      );
      check(
        "🔴 20 個請求打完，資料庫裡只剩 1 張訂單（19 張失敗的都被整個刪掉，沒有殘骸）",
        survivingOrders,
        1,
      );
    }

    // ===========================================================================
    // [27] 驗收條件⑪：多個併發訂單同時碰同一場次的不同方案 → 零死鎖
    // ===========================================================================
    console.log("\n[27] 併發②：同一場次、兩個不同方案、順序交替、零死鎖");
    console.log("       模式對應 event-registration-selftest.mjs 的 [24b]（同一交易內、逆序）：");
    console.log("       這裡改成「同一場次、兩個方案」而不是「兩個場次」，因為要測的正是");
    console.log("       reserve_plan_units() 自己鎖住的那批方案彼此之間、以及與場次之間的順序。");
    {
      /**
       * 跟 orders.ts 的 createOrder() 一樣，把「這張訂單的所有 RPC 呼叫」包在
       * 同一個 psql 呼叫裡（一個 do $$ ... $$ 區塊＝一個交易），但一次處理兩個
       * order_item（各自一個方案）——這是刻意在製造「同一個交易內要連續鎖兩個
       * 方案」的情境，逆序測的是 reserve_plan_units() 自己對「這張訂單會碰到的
       * 所有方案」依 id 排序鎖起來那件事有沒有真的生效。
       */
      const lockOneTxnSql = (key, planFirst, planSecond) => `
        do $$
        declare v_order uuid; v_item1 bigint; v_item2 bigint;
        begin
          insert into public.orders (customer_name, customer_email, customer_phone, subtotal, total, idempotency_key)
          values ('自檢','selftest@example.invalid','0900000000',2000,2000,'${key}')
          returning id into v_order;

          insert into public.order_items
            (order_id, product_id, session_id, plan_id, plan_title, name, unit_price, quantity, subtotal, product_type)
          values (v_order, '${S.a}', '${SESS.lockA}', '${planFirst}'::uuid, ${LOC}, ${LOC}, 1000, 1, 1000, 'event')
          returning id into v_item1;
          insert into public.order_items
            (order_id, product_id, session_id, plan_id, plan_title, name, unit_price, quantity, subtotal, product_type)
          values (v_order, '${S.a}', '${SESS.lockA}', '${planSecond}'::uuid, ${LOC}, ${LOC}, 1000, 1, 1000, 'event')
          returning id into v_item2;

          perform public.reserve_plan_units(v_order, '${planFirst}'::uuid, 1);
          perform public.reserve_plan_units(v_order, '${planSecond}'::uuid, 1);
          perform public.reserve_session_seat(v_order, v_item1, '${SESS.lockA}'::uuid, 1, '${people(1)}'::jsonb);
          perform public.reserve_session_seat(v_order, v_item2, '${SESS.lockA}'::uuid, 1, '${people(1)}'::jsonb);
        end $$;
      `;

      const runs = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          q(
            i % 2 === 0
              ? lockOneTxnSql(`${KEY_PREFIX}lock-${i}`, PLAN.lockP1, PLAN.lockP2)
              : lockOneTxnSql(`${KEY_PREFIX}lock-${i}`, PLAN.lockP2, PLAN.lockP1),
          ),
        ),
      );
      const deadlocks = runs.filter((r) => !r.ok && /deadlock detected/i.test(r.error ?? ""));
      const okRuns = runs.filter((r) => r.ok);
      checkTrue("🔴 沒有任何一筆 deadlock detected", deadlocks.length === 0);
      if (deadlocks.length > 0) console.log(red(`      ${deadlocks[0].error.slice(0, 300)}`));
      check("16 筆全部完成（兩個方案的名額都很寬裕）", okRuns.length, 16);
      const finalP1 = await planCounters(PLAN.lockP1);
      const finalP2 = await planCounters(PLAN.lockP2);
      check("PLAN.lockP1 units_taken = 16", finalP1.units_taken, 16);
      check("PLAN.lockP2 units_taken = 16", finalP2.units_taken, 16);
    }
  } catch (err) {
    fail += 1;
    console.log(red(`  ✗ 併發測試中止：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    console.log("\n[28] 清理");
    const cleanup = await q(CLEANUP_SQL);
    checkTrue("測試資料清乾淨", cleanup.ok);
    check(
      "沒有殘留的 event_session_plans",
      Number(
        one(
          (
            await q(`
              select count(*)::int n from public.event_session_plans p
               where p.session_id in (select s.id from public.event_sessions s where s.product_id like '${SLUG_PREFIX}%')
            `)
          ).rows,
        )?.n ?? -1,
      ),
      0,
    );
    check(
      "沒有殘留的 event_sessions",
      Number(
        one(
          (
            await q(
              `select count(*)::int n from public.event_sessions where product_id like '${SLUG_PREFIX}%'`,
            )
          ).rows,
        )?.n ?? -1,
      ),
      0,
    );
    check(
      "沒有殘留的 orders",
      Number(
        one(
          (
            await q(
              `select count(*)::int n from public.orders where idempotency_key like '${KEY_PREFIX}%'`,
            )
          ).rows,
        )?.n ?? -1,
      ),
      0,
    );
  }
}

// =============================================================================
// 收尾
// =============================================================================
console.log(`\n${"─".repeat(52)}`);
if (skipped.length > 0) {
  console.log(yellow(`略過 ${skipped.length} 段：`));
  for (const s of skipped) console.log(yellow(`  • ${s}`));
}
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`\n✓ 全部通過：${pass} passed, ${fail} failed\n`));
  process.exit(0);
} else {
  console.log(red(`\n✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
