#!/usr/bin/env node
/**
 * event-product-selftest.mjs —— 活動與商品的真連結（0026）的自檢
 *
 * 分兩段，理由與 artists-selftest / event-registration-selftest 相同：這支測試在
 * 沒有資料庫的機器上也必須有意義。
 *
 *   [靜態] 讀 supabase/migrations/0026 與幾支 .ts / .tsx 的**原始碼字串**來斷言，
 *          守的是這一期的五個設計不變量。**沒有資料庫也一定會跑。**
 *
 *            1. 🔴 products.description 取 events.summary，**不是** events.description。
 *               後者是頁面級的引言，整段塞進購物車的品項說明就是一面牆。這條規則
 *               只能有一個家（那支 SQL 函式），所以這裡同時守「SQL 裡投影對了」與
 *               「後台沒有自己再開一個商品說明欄位」。
 *            2. 🔴 admin_upsert_event_with_session() 吃的是**一個 payload jsonb**，
 *               不是二十個具名參數。`create or replace function` 不能改參數名或型別，
 *               改了就會留下兩支同名 overload 讓 PostgREST 挑錯 —— 挑錯的症狀是
 *               「舊那支被呼叫、新欄位被安靜丟掉」，沒有錯誤訊息。回傳同理不能是
 *               `returns table`。
 *            3. 🔴 events.slug 回填成 **id**，不是從 title 產生。中文標題 slugify
 *               會得到空字串，六場活動會得到六個一樣的空 slug；而且回填成 id 才能
 *               讓已經發出去的網址繼續有效。
 *            4. 🔴 `'event-'` 這個前綴在 SQL 與 TS 兩邊各有一份實作，這裡把兩邊的
 *               字面值釘在一起。分岔的症狀是**前台查不到商品**，而查不到商品在畫面上
 *               長成「報名尚未開放」—— 一句看起來完全正常、沒有錯誤訊息的句子。
 *            5. 0025 那套「欄位不存在就降級」的過渡程式碼**已經刪乾淨**，而且不會被
 *               複製回來。
 *
 *   [連線] 對一個真的本機 PostgreSQL 驗**行為**，不是驗字串：0026 能不能重複套用、
 *          slug 是不是真的回填成 id、一場活動能不能被塞第二件商品、RPC 寫出來的
 *          products.description 到底是哪一欄、改代稱之後 products.slug 有沒有跟著改、
 *          以及 anon 能不能呼叫那支 RPC。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它只認 EVENT_PRODUCT_SELFTEST_PG_URL，而那個變數
 *    要自己設；沒設就整段 skip（會印出來，不會靜悄悄消失）。
 *
 * 準備一個可以跑的本機庫（PostgreSQL 14+ 即可）：
 *
 *     createdb ib_p5_test
 *     EVENT_PRODUCT_SELFTEST_PG_URL=postgres:///ib_p5_test \
 *     EVENT_PRODUCT_SELFTEST_APPLY=1 node scripts/event-product-selftest.mjs
 *
 * `EVENT_PRODUCT_SELFTEST_APPLY=1` 會先把 0001–0026 套上去（0008 需要 pg_net /
 * vault / pg_cron，本機沒有，會被跳過）。套過一次之後就不用再帶這個變數。
 *
 * 環境變數：
 *   EVENT_PRODUCT_SELFTEST_PG_URL   本機測試庫的連線字串（[連線] 段的開關）
 *   EVENT_PRODUCT_SELFTEST_APPLY    設成 1 時先套用 0001–0026
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { latestDefinition } from "./lib/live-definition.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/event-product-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 artists-selftest 同一套）
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

function checkTrue(label, value, extra = "") {
  if (value) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    if (extra) console.log(red(`      ${extra}`));
  }
}

const checkFalse = (label, value, extra = "") => checkTrue(label, !value, extra);

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串。
 *
 * 這一支底下大量的斷言長成 `checkFalse("…沒有 X", src.includes("X"))` —— 路徑一打錯
 * （或檔案被改名、搬走），`"".includes("X")` 就是 `false`，那條斷言**靜默通過**，
 * 從此永遠是綠的，而且再也沒有在檢查任何東西。正面斷言會轉紅所以是安全的；只有
 * 否定斷言會這樣壞掉。見 run-selftests.mjs 的「守門 4」。
 */
const readFile = (p) => {
  const abs = p.startsWith("/") ? p : join(ROOT, p);
  if (!existsSync(abs)) {
    throw new Error(
      `selftest 讀不到檔案：${abs}` +
        "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串 —— 回空字串會讓所有" +
        "「確認原始碼裡沒有 X」的否定斷言靜默通過。）",
    );
  }
  return readFileSync(abs, "utf8");
};

// 守著 readFile() 自己：路徑打錯時它必須炸掉，而不是回空字串讓否定斷言靜默通過。
{
  const ghost = join(ROOT, "__event-product-selftest-missing-probe__");
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

/** 把 `--` 註解整行拿掉，免得註解裡提到的字串讓 includes() 假性通過。 */
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/** 拿掉 TypeScript／TSX 的註解（`//`、`/* … *\/`、以及 JSX 的 `{/* … *\/}`）。 */
function stripTs(src) {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/**
 * 切出一段 SQL：從 `from` 這個字串開始，到 `to` 為止（不含）。
 * 用途是「products 的 insert 裡投影的是哪一欄」這種斷言 —— 它要看的是**那一段**，
 * 不是整個檔案（整個檔案當然兩欄都提到，檔頭就在解釋為什麼不用另一欄）。
 */
function sliceBetween(src, from, to) {
  const start = src.indexOf(from);
  if (start === -1) return "";
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end === -1 ? src.length : end);
}

/** 切出一個 TS 函式的本體（從 `export ... function <名字>` 到下一個頂層 `\n}`）。 */
function fnBody(src, name) {
  const re = new RegExp(`export (?:async )?function ${name}\\b`);
  const m = re.exec(src);
  if (!m) return "";
  const start = m.index;
  const end = src.indexOf("\n}", start);
  return src.slice(start, end === -1 ? src.length : end);
}

// =============================================================================
// [1] migration 檔案盤點
// =============================================================================
console.log("\n[1] migration 檔案盤點");

const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const MIG_0026_NAME = "0026_event_product_link.sql";
checkTrue(`${MIG_0026_NAME} 存在`, migrations.includes(MIG_0026_NAME));
// 0027 起 0026 不再是最大的一支。「最新的一支是誰」這個斷言搬到
// scripts/event-blocks-selftest.mjs —— 那一條本來就該由**最新那一期**的自檢守著，
// 每開一支新 migration 就換一個地方更新。這裡改成守「0026 沒有被改號、也沒有被
// 別人插隊到 0025 與它之間」，強度與原來那條相當，而且不會因為加了新的一期就過期。
check(
  "0026 緊接在 0025 之後（沒有被改號或插隊）",
  migrations[migrations.indexOf(MIG_0026_NAME) - 1],
  "0025_event_speaker.sql",
);

const sql0026raw = readFile(join(MIG_DIR, MIG_0026_NAME));
const sql0026 = stripSqlComments(sql0026raw);
checkTrue("0026 不是空檔", sql0026.trim().length > 0);

/**
 * 「加東西要開新 migration，不可以回頭改已套用的那幾支」是這個 repo 的規約。
 *
 * ⚠️ 不能用 "slug" 或 "image_key" 這種字去驗 —— 0001 建 products.slug、
 *    exhibitions.slug、pages.og_image_key 的時候就寫過它們，那不是違規。要驗就要用
 *    **只可能屬於 0026** 的名字。
 */
const NAMES_ONLY_IN_0026 = [
  "admin_upsert_event_with_session",
  "event_product_slug",
  "events_slug_sync_product",
  "events_sync_product_slug",
  "products_event_source_unique_idx",
  "events_slug_key",
];
// ⚠️ 比對範圍是**編號比 0026 小的那幾支**，不是「除了 0026 以外的全部」。這條斷言
//    的標籤從第一天起就寫著「0001–0025」，而規約禁止的也只有「回頭改已套用的
//    migration」。0027 用 create or replace 重寫 admin_upsert_event_with_session 是
//    這個 repo 唯一被認可的加欄位方式（0026 檔尾的 comment 就是這樣寫的），把它算成
//    違規會逼著下一期的人去放寬這條斷言 —— 而那才是真的失去防守。
for (const name of NAMES_ONLY_IN_0026) {
  const offenders = migrations
    .filter((f) => f < MIG_0026_NAME)
    .filter((f) => readFile(join(MIG_DIR, f)).includes(name));
  check(
    `0001–0025 沒有任何一支提到 ${name}（＝沒有回頭改舊 migration）`,
    offenders.join(",") || "（無）",
    "（無）",
  );
}

// =============================================================================
// [2] 🔴 events.slug 回填成 id，不是從 title 產生
// =============================================================================
console.log("\n[2] slug 的回填規則");

checkTrue(
  "0026 有加 public.events.slug 這一欄",
  /alter\s+table\s+public\.events\s+add\s+column\s+if\s+not\s+exists\s+slug\s+text/i.test(sql0026),
);

// 回填那一句本身。切出來單獨看 —— 整個檔案當然提到 title（活動有標題），
// 要驗的是**回填那一句**沒有碰 title。
const backfill = sliceBetween(sql0026, "update public.events", ";");
checkTrue("切得出回填那一句", backfill.length > 0);
checkTrue("回填是 set slug = id", /set\s+slug\s*=\s*id/i.test(backfill));
checkTrue("回填只補還沒有 slug 的列（重跑是 0 列）", /where\s+slug\s+is\s+null/i.test(backfill));
// 🔴 中文標題 slugify 會得到空字串。從 title 產 slug 的每一種寫法都不可以出現。
checkFalse("回填沒有碰 title", /title/i.test(backfill));
checkFalse("回填沒有用 regexp_replace（＝沒有在做 slugify）", /regexp_replace/i.test(backfill));
checkFalse("回填沒有用 lower()", /lower\s*\(/i.test(backfill));

checkTrue(
  "events.slug 有唯一索引",
  /create\s+unique\s+index\s+if\s+not\s+exists\s+events_slug_key\s+on\s+public\.events\s*\(\s*slug\s*\)/i.test(
    sql0026,
  ),
);
checkTrue(
  "events.slug 是 not null（回填之後才設）",
  /alter\s+column\s+slug\s+set\s+not\s+null/i.test(sql0026),
);
// 順序要對：先回填、再 set not null。反過來會在有資料的庫上直接失敗。
checkTrue(
  "回填寫在 set not null 之前",
  sql0026.indexOf("set slug = id") < sql0026.search(/alter\s+column\s+slug\s+set\s+not\s+null/i),
);

// 「改代稱會讓已經發出去的連結 404」這句警告要寫在 migration 檔頭。
checkTrue(
  "0026 檔頭寫了「改代稱會讓已經發出去的連結 404」",
  sql0026raw.includes("404") && sql0026raw.includes("已經發出去"),
);

// =============================================================================
// [3] events.image_key
// =============================================================================
console.log("\n[3] events.image_key");

checkTrue(
  "0026 有加 public.events.image_key 這一欄",
  /alter\s+table\s+public\.events\s+add\s+column\s+if\s+not\s+exists\s+image_key\s+text/i.test(
    sql0026,
  ),
);
// 可為 NULL：不可以有 not null，也不可以有 default。NULL 是有意義的值（＝沒設圖）。
checkFalse(
  "image_key 沒有被設成 not null",
  /add\s+column\s+if\s+not\s+exists\s+image_key[^;]*not\s+null/i.test(sql0026),
);

// =============================================================================
// [4] 🔴 一場活動最多一件商品，是資料庫層級的事實
// =============================================================================
console.log("\n[4] products 對活動來源的唯一索引");

const uniqIdx = sliceBetween(
  sql0026,
  "create unique index if not exists products_event_source",
  ";",
);
checkTrue("切得出那個唯一索引", uniqIdx.length > 0);
checkTrue("索引建在 public.products 上", /on\s+public\.products/i.test(uniqIdx));
checkTrue("索引的鍵是 source_id", /\(\s*source_id\s*\)/i.test(uniqIdx));
checkTrue(
  "是部分索引，只管 source_type = 'event'",
  /where\s+source_type\s*=\s*'event'/i.test(uniqIdx),
);
// 建索引之前先點名既有的重複，否則拿到的只有 "could not create unique index"。
checkTrue(
  "建索引前先查有沒有既存重複，並且用點名 source_id 的訊息中止",
  /having\s+count\(\*\)\s*>\s*1/i.test(sql0026) &&
    /raise\s+exception[^;]*0026\s*中止/i.test(sql0026),
);

// =============================================================================
// [5] 🔴 admin_upsert_event_with_session 吃一個 payload jsonb
// =============================================================================
console.log("\n[5] RPC 的簽名");

const fnSig = sliceBetween(
  sql0026,
  "create or replace function public.admin_upsert_event_with_session",
  "as $$",
);
checkTrue("切得出那支函式的簽名", fnSig.length > 0);
// 🔴 一個參數，名字叫 payload，型別是 jsonb。加欄位就改簽名 = 留下第二支 overload。
checkTrue(
  "🔴 參數是單一的 (payload jsonb)",
  /admin_upsert_event_with_session\s*\(\s*payload\s+jsonb\s*\)/i.test(fnSig),
);
checkFalse(
  "🔴 沒有寫成一堆 p_xxx 具名參數（那會讓每加一欄就多一支同名 overload）",
  /\bp_[a-z_]+\s+(text|integer|boolean|jsonb|uuid|date|timestamptz)\b/i.test(fnSig),
);
// 🔴 回傳也是 jsonb。`returns table (...)` 的形狀同樣不能被 create or replace 改掉。
checkTrue("🔴 回傳是 jsonb", /returns\s+jsonb/i.test(fnSig));
checkFalse("🔴 不是 returns table（形狀改不動，要 drop function）", /returns\s+table/i.test(fnSig));
checkTrue("security definer", /security\s+definer/i.test(fnSig));
checkTrue("set search_path = public", /set\s+search_path\s*=\s*public/i.test(fnSig));

// 授權：revoke 之後一定要補 grant to service_role，否則後台呼叫拿到 42501。
checkTrue(
  "revoke execute from public, anon, authenticated",
  /revoke\s+execute\s+on\s+function\s+public\.admin_upsert_event_with_session\(jsonb\)\s*\n?\s*from\s+public,\s*anon,\s*authenticated/i.test(
    sql0026,
  ),
);
checkTrue(
  "🔴 grant execute to service_role（revoke from public 會把它一起收走）",
  /grant\s+execute\s+on\s+function\s+public\.admin_upsert_event_with_session\(jsonb\)\s*\n?\s*to\s+service_role/i.test(
    sql0026,
  ),
);

// =============================================================================
// [6] 🔴 products.description 取 events.summary，不是 events.description
// =============================================================================
console.log("\n[6] 投影規則：description ← summary");

// 切出 products 的 insert 那一段（欄位清單 + values），只看它。
const prodInsert = sliceBetween(
  sql0026,
  "insert into public.products (",
  "on conflict (id) do update",
);
checkTrue("切得出 products 的 insert", prodInsert.length > 200);
checkTrue("insert 有 description 這一欄", /\bdescription\b/.test(prodInsert));
// 🔴 values 裡出現的是 v_event.summary，而**完全沒有** v_event.description。
checkTrue("insert 投影的是 v_event.summary", /v_event\.summary/.test(prodInsert));
checkFalse(
  "🔴 insert 完全沒有出現 v_event.description（那是頁面級引言，塞進購物車就是一面牆）",
  /v_event\.description/.test(prodInsert),
);
// summary 要出現兩次：products.summary 一次、products.description 一次。
check(
  "v_event.summary 在 insert 裡出現兩次（products.summary 與 products.description）",
  (prodInsert.match(/v_event\.summary/g) ?? []).length,
  2,
);

// payload 沒帶 product 時的那條 update 也要照同一條規則。
const prodSync = sliceBetween(
  sql0026,
  "update public.products p\n       set slug",
  "returning * into v_product",
);
checkTrue("切得出「只同步文案」那條 update", prodSync.length > 0);
checkTrue(
  "同步 update 也用 v_event.summary 當 description",
  /description\s*=\s*v_event\.summary/.test(prodSync),
);
checkFalse("🔴 同步 update 沒有出現 v_event.description", /v_event\.description/.test(prodSync));
// 價格與上下架狀態是商品自己的決定，不該被活動的儲存動作蓋掉。
checkFalse("同步 update 不動 price", /\bprice\s*=/.test(prodSync));
checkFalse("同步 update 不動 status", /\bstatus\s*=/.test(prodSync));

// 後台不准自己開一個「商品說明」欄位 —— 那是替這條規則開第二個家。
/**
 * 活動後台的**整個**表面 —— 列表頁與活動頁組裝器的聯集。
 *
 * 🔴 **不寫死單一檔案路徑。** D3 把活動表單從 `_shell.events.tsx` 搬到
 *    `_shell.events.$id.tsx`。寫死前者的版本在那次搬家之後，下面那條
 *    `checkFalse("後台沒有直接寫 products 表")` 會**靜默轉綠** —— 它讀的檔案裡
 *    本來就什麼都沒有了，覆蓋消失而畫面是綠的。這正是這個 repo 反覆出過的假陽性。
 *
 *    掃出 `src/routes/admin/` 底下所有 `_shell.events*.tsx`，要求至少一個，
 *    再對它們的聯集斷言。否定斷言因此變**強**（整個表面都不准出現），肯定斷言則
 *    不再綁在某一支檔名上。
 */
const ADMIN_ROUTES_DIR = join(ROOT, "src/routes/admin");
const adminEventsFiles = readdirSync(ADMIN_ROUTES_DIR)
  .filter((f) => /^_shell\.events(\..+)?\.tsx$/.test(f))
  .sort();
checkTrue(
  `活動後台至少有一個路由檔（實得 ${adminEventsFiles.length}：${adminEventsFiles.join("、")}）`,
  adminEventsFiles.length >= 1,
);
const adminEventsRaw = adminEventsFiles.map((f) => readFile(join(ADMIN_ROUTES_DIR, f))).join("\n");
const adminEventsSrc = adminEventsFiles
  .map((f) => stripTs(readFile(join(ADMIN_ROUTES_DIR, f))))
  .join("\n");
for (const forbidden of [
  "product.description",
  "product.summary",
  "product.title",
  "product.slug",
]) {
  checkFalse(
    `🔴 後台表單沒有 ${forbidden} 欄位（那五樣是從活動投影過去的）`,
    adminEventsSrc.includes(`name="${forbidden}"`),
  );
}

// =============================================================================
// [7] 🔴 'event-' 這個前綴：SQL 與 TS 兩邊釘在一起
// =============================================================================
console.log("\n[7] 跨語言的前綴");

const EVENT_PRODUCT_PREFIX = "event-";

const slugFn = sliceBetween(sql0026, "create or replace function public.event_product_slug", "$$;");
checkTrue("切得出 event_product_slug()", slugFn.length > 0);
checkTrue("它是 immutable 的純字串運算", /immutable/i.test(slugFn));
checkTrue(
  `🔴 SQL 側的前綴是 '${EVENT_PRODUCT_PREFIX}'`,
  slugFn.includes(`'${EVENT_PRODUCT_PREFIX}' || p_event_slug`),
);

const shopSrc = readFile("src/lib/shop.ts");
const shopStripped = stripTs(shopSrc);
checkTrue("shop.ts 有 eventProductSlug()", /export function eventProductSlug\(/.test(shopStripped));
const tsSlugFn = fnBody(shopStripped, "eventProductSlug");
checkTrue("切得出 eventProductSlug() 的本體", tsSlugFn.length > 0);
checkTrue(
  `🔴 TS 側的前綴也是 \`${EVENT_PRODUCT_PREFIX}\``,
  tsSlugFn.includes(`\`${EVENT_PRODUCT_PREFIX}\${eventSlug}\``),
);
// 商品的 slug 只准由那支函式算出來，不准在 RPC 裡就地拼字串。
checkTrue(
  "RPC 用 event_product_slug() 算 products.slug",
  /slug\s*=\s*public\.event_product_slug\(/.test(sql0026) ||
    /public\.event_product_slug\(v_event\.slug\)/.test(sql0026),
);
// 前台不准自己拼前綴 —— 拼了就是第三個家。
const forEventSlugBody = fnBody(shopStripped, "fetchActiveProductForEventSlug");
checkTrue("切得出 fetchActiveProductForEventSlug() 的本體", forEventSlugBody.length > 0);
checkTrue(
  "前台反查走 eventProductSlug()，不是就地拼字串",
  /eventProductSlug\(eventSlug\)/.test(forEventSlugBody),
);
checkFalse(
  "前台沒有第二處寫死 `event-` 前綴",
  new RegExp(`\`${EVENT_PRODUCT_PREFIX}\\$\\{`).test(forEventSlugBody),
);

// 改了 events.slug，products.slug 要跟著改 —— 否則前台反查會查不到，
// 而查不到在畫面上長成「報名尚未開放」。
checkTrue(
  "有 events_slug_sync_product 這個 trigger",
  /create\s+trigger\s+events_slug_sync_product\s*\n?\s*after\s+update\s+of\s+slug\s+on\s+public\.events/i.test(
    sql0026,
  ),
);

// =============================================================================
// [8] 🔴 RPC 不准寫 seats_taken
// =============================================================================
console.log("\n[8] seats_taken 是誰的");

// 0020 §7：seats_taken 只由 reserve_session_seat / release_session_seat /
// expire_unpaid_orders 在持有列鎖時維護。從表單寫回一個幾分鐘前讀到的計數器，
// 就是與那三支 RPC 對撞 —— 而對撞的結果是超賣，不是錯誤訊息。
/**
 * 🔴 **從「現在生效的那一份」切，不是從 0026 切。**
 *
 * 這一行原本是 `sliceBetween(sql0026, …)`。0026 是已套用的 migration，規約禁止再改
 * 它一個字 —— 所以從 0027 用 create or replace 重寫這支函式的那一刻起，這條斷言驗
 * 的就是一份**沒有任何資料庫在跑的死定義**，而且它會永遠是綠的。0029 又重寫了一次。
 * 這正是這個 repo 反覆出現的「釘死單一檔案路徑，搬家後靜默失去覆蓋」。
 *
 * latestDefinition() 去找最後一支重新定義它的 migration；找不到就丟例外（回空字串
 * 會讓底下那條 checkFalse 靜默通過）。
 */
const liveRpc = latestDefinition(MIG_DIR, "admin_upsert_event_with_session", stripSqlComments);
const fnBodySql = liveRpc.body;
checkTrue("切得出**現在生效的**那一份 RPC 本體", fnBodySql.length > 1000);
checkTrue(
  "現在生效的那一份不早於 0026（它是這支函式的出生地）",
  liveRpc.file >= MIG_0026_NAME,
  `最後一支重新定義它的是 ${liveRpc.file}`,
);
checkFalse("🔴 RPC 完全沒有寫 seats_taken", /seats_taken\s*=/.test(fnBodySql));
// capacity 同理：0020 的 CHECK 要求 products.capacity is null，名額在場次上。
checkTrue(
  "products 的 insert 把 capacity 寫成 null（名額在場次上）",
  /null,\s*--\s*capacity/.test(prodInsert) || /capacity/.test(prodInsert),
);
// 報名不寄東西。
checkTrue(
  "products.requires_shipping 是 false",
  /false,\s*--\s*requires_shipping/.test(prodInsert),
);

// =============================================================================
// [9] 過渡程式碼刪乾淨了
// =============================================================================
console.log("\n[9] 0025 的降級程式碼");

const repoSrc = readFile("src/server/repos/events.ts");
// 這五樣是 0025 那一期留下的過渡程式碼，0026 套上正式庫之後要一起刪掉。
// ⚠️ 用**原始檔**不是 stripTs 過的：連註解裡都不該再提到它們，否則下一個人會
//    以為那套東西還在。
for (const gone of [
  "COLUMNS_BASE",
  "speakerColumnPresent",
  "isMissingSpeakerColumn",
  "selectEvents",
  "stripSpeaker",
]) {
  checkFalse(`repos/events.ts 已經沒有 ${gone}`, repoSrc.includes(gone));
}
// COLUMNS 回到直接的一串，而且含 0026 的兩欄。
const columnsLine = sliceBetween(stripTs(repoSrc), "const COLUMNS =", ";");
checkTrue("切得出 COLUMNS", columnsLine.length > 0);
for (const col of ["id", "slug", "speaker_id", "image_key"]) {
  checkTrue(`COLUMNS 有 ${col}`, new RegExp(`\\b${col}\\b`).test(columnsLine));
}
// 三個呼叫點回到直接查詢的形狀。
checkTrue(
  "listEvents 直接 .select(COLUMNS)",
  /\.select\(COLUMNS\)/.test(fnBody(repoSrc, "listEvents")),
);
checkTrue(
  "getEventById 直接 .select(COLUMNS)",
  /\.select\(COLUMNS\)/.test(fnBody(repoSrc, "getEventById")),
);
checkTrue(
  "upsertEvent 直接 .select(COLUMNS)",
  /\.select\(COLUMNS\)/.test(fnBody(repoSrc, "upsertEvent")),
);

// =============================================================================
// [10] countSessionsForEvent()
// =============================================================================
console.log("\n[10] countSessionsForEvent");

const countBody = fnBody(stripTs(repoSrc), "countSessionsForEvent");
checkTrue("repos/events.ts 有 countSessionsForEvent()", countBody.length > 0);
// 場次掛在 products.id 上（0020），不是 events.id —— 所以一定是兩跳。
checkTrue('先用 source_type = "event" 找商品', /\.eq\("source_type", "event"\)/.test(countBody));
checkTrue("再用 product_id 數場次", /\.eq\("product_id"/.test(countBody));
checkTrue("從 event_sessions 數", /from\("event_sessions"\)/.test(countBody));
// 0026 的唯一索引之後 maybeSingle() 才是安全的（在那之前可能吃 PGRST116）。
checkTrue("找商品用 maybeSingle()（唯一索引保證最多一列）", /maybeSingle\(\)/.test(countBody));
// 沒有商品 = 0 個場次，不是錯誤。
checkTrue("沒有商品時回 0", /if \(!product\) return 0;/.test(countBody));

// =============================================================================
// [11] 後台與前台接上這條線
// =============================================================================
console.log("\n[11] 後台與前台");

// 後台：slug 欄位在，而且說明文字帶著那句 404 警告。
checkTrue("後台表單有 slug 欄位", adminEventsSrc.includes('name="slug"'));
const adminRaw = adminEventsRaw;
checkTrue(
  "🔴 後台 slug 欄位的說明寫了「改代稱會讓舊網址 404」",
  adminRaw.includes("404") && adminRaw.includes("已經發出去"),
);
checkTrue("後台表單有 image_key 欄位", adminEventsSrc.includes('name="image_key"'));
// 上架走 RPC，不是後台自己組 products 的 payload。
checkTrue("後台會呼叫 upsertEventWithProduct", adminEventsSrc.includes("upsertEventWithProduct("));
checkFalse(
  "🔴 後台沒有直接寫 products 表（投影規則只住在 SQL 裡）",
  /from\("products"\)/.test(adminEventsSrc),
);
// 後台列表顯示「這場活動的商品」狀態。
// 2026-10-25 起列表頁的 loader 改成一支整頁 fn（getAdminEventsPageData），由它在伺服器上呼叫
// listEventProducts()——仍然是一次撈完，不是一場一場問。
{
  const eventFnsSrc = stripTs(readFile(join(ROOT, "src/lib/admin/fns/events.ts")));
  const pageFn = eventFnsSrc.slice(
    eventFnsSrc.indexOf("export const getAdminEventsPageData"),
    eventFnsSrc.indexOf("export const getAdminEventEditorPageData"),
  );
  checkTrue(
    "後台會載入 listEventProducts()（經由整頁 fn getAdminEventsPageData）",
    adminEventsSrc.includes("getAdminEventsPageData()") &&
      /adminFnMiddleware/.test(pageFn) &&
      pageFn.includes("listEventProducts()"),
  );
}
checkTrue("後台列表顯示場次數", adminEventsSrc.includes("session_count"));

// repo 的 RPC wrapper。
const rpcBody = fnBody(stripTs(repoSrc), "upsertEventWithProduct");
checkTrue("repos/events.ts 有 upsertEventWithProduct()", rpcBody.length > 0);
checkTrue(
  "它呼叫 admin_upsert_event_with_session",
  /rpc\("admin_upsert_event_with_session"/.test(rpcBody),
);
checkTrue(
  "送出去的是一個 payload",
  /\{\s*\n?\s*payload,?\s*\n?\s*\}/.test(rpcBody) || /payload,/.test(rpcBody),
);
// 空字串 -> NULL 這條規則兩條寫入路徑都要有（artists-selftest 也在守，這裡守它
// 在 RPC 那條路徑上同樣成立）。
checkTrue(
  "RPC 路徑也把 speaker_id 的空字串寫成 null",
  /speaker_id:\s*input\.speaker_id\s*&&\s*input\.speaker_id\.trim\(\)\s*\?\s*input\.speaker_id\.trim\(\)\s*:\s*null/.test(
    rpcBody,
  ),
);

// 前台：/events/$slug 用 event.slug 反查。
const detailSrc = stripTs(readFile("src/routes/events.$slug.tsx"));
checkTrue(
  "詳情頁用 fetchActiveProductForEventSlug(event.slug)",
  /fetchActiveProductForEventSlug\(event\.slug\)/.test(detailSrc),
);
// cms.ts 改用 slug 查活動。
const cmsBySlug = fnBody(stripTs(readFile("src/lib/cms.ts")), "fetchEventBySlug");
checkTrue('fetchEventBySlug 改用 .eq("slug", slug)', /\.eq\("slug", slug\)/.test(cmsBySlug));
checkFalse('fetchEventBySlug 沒有留著 .eq("id", slug)', /\.eq\("id", slug\)/.test(cmsBySlug));

// =============================================================================
// [連線] 段
// =============================================================================

const PG_URL = process.env.EVENT_PRODUCT_SELFTEST_PG_URL;

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
const num = (rows, field = "n") => Number(one(rows)?.[field] ?? NaN);

const E1 = "evprod-e1";
const E2 = "evprod-e2";
const CAT = "evprod-cat";

/** FK 安全的清理順序。開頭與結尾各跑一次。 */
const CLEANUP_SQL = `
delete from public.event_sessions where product_id in (
  select id from public.products where source_type='event' and source_id like 'evprod-%');
delete from public.products where id like 'evprod-%' or slug like 'event-evprod-%';
delete from public.events where id like 'evprod-%';
delete from public.event_categories where id like 'evprod-%';
`;

const L = (s) => `'{"zh":"${s}","en":"${s}","ja":"${s}"}'::jsonb`;

/** 一份最小可用的 event payload，給 RPC 用。 */
/**
 * @param extra      **payload 頂層**的額外 key（"product" / "session" 就是從這裡進來的）
 * @param eventExtra **event 物件裡面**的額外 key（0029 的 show_seats_remaining 用這個）
 *
 * ⚠️ 兩個位置不可以搞混，而且搞混**不會有任何錯誤訊息**：這支 RPC 對它不認得的
 *    key 是完全沉默的，所以把 event 的欄位放到頂層去，結果會是「那個欄位被安靜地
 *    忽略」——寫這段測試時就先踩過一次（assertion 紅了才發現）。
 */
const eventPayload = (id, extra = "", eventExtra = "") => `{
  "event": {
    "id": "${id}",
    "title":       {"zh":"標題","en":"Title","ja":"タイトル"},
    "summary":     {"zh":"一句話摘要","en":"One line","ja":"一行"},
    "description": {"zh":"整段的活動介紹","en":"Long body","ja":"長い本文"},
    "display_date": "2026.05.24  Sat  19:30",
    "category": "${CAT}",
    "speaker_id": "",
    "image_key": "storage:cover.webp",
    "external_url": "https://example.com/e",
    "registration_type": "internal",
    "payment_enabled": true,
    "is_published": true,
    "sort_order": 3${eventExtra}
  }${extra}
}`;

// =============================================================================
// [11b] 0029：名額顯示旗標的投影，以及擋分岔的兩個 trigger
// =============================================================================
console.log("\n[11b] 名額顯示旗標（0029）");

// 前台的讀取層（src/lib/shop.ts）只讀 public.products 與 public.event_sessions，
// 一個字都沒讀過 public.events —— 所以「這場活動要不要印尚餘名額」這個決定要能到
// 得了前台，就必須從 events 投影到 products。投影 = 兩份會分岔的資料，0029 用兩個
// trigger 把兩個方向都堵起來。這一段守的就是那兩個 trigger 還在、方向沒有寫反。
const MIG_0029_NAME = "0029_event_seats_visibility.sql";
checkTrue(`${MIG_0029_NAME} 存在`, migrations.includes(MIG_0029_NAME));
const sql0029 = stripSqlComments(readFile(join(MIG_DIR, MIG_0029_NAME)));
checkTrue("0029 不是空檔", sql0029.trim().length > 500);
checkTrue("0029 有 begin; / commit;", /\bbegin;/.test(sql0029) && /\bcommit;/.test(sql0029));

// 兩張表都要有這一欄，而且**都是 not null default true** —— default false 會讓套用
// 的那一秒起所有既有活動的名額安靜地消失，而那不是任何人做過的決定。
for (const table of ["events", "products"]) {
  checkTrue(
    `public.${table} 加了 show_seats_remaining`,
    new RegExp(
      `alter table public\\.${table}\\s*\\n\\s*add column if not exists show_seats_remaining boolean not null default true`,
      "i",
    ).test(sql0029),
  );
}
checkFalse(
  "🔴 沒有任何一處把預設寫成 false（那會讓既有活動的名額在套用當下就消失）",
  /show_seats_remaining boolean not null default false/i.test(sql0029),
);

// trigger A：events → products。與 0026 的 events_slug_sync_product 同一個形狀、
// 同一個理由（活動後台有一條只寫 public.events 的儲存路徑）。
checkTrue(
  "有 events → products 的同步 trigger",
  /create\s+trigger\s+events_seats_visibility_sync_product\s*\n?\s*after\s+update\s+of\s+show_seats_remaining\s+on\s+public\.events/i.test(
    sql0029,
  ),
);
// trigger B：products 被寫入時反向拉回。/admin/products 可以直接建立或編輯一件
// source_type='event' 的商品，那條路不經過 RPC 也不碰 events。
checkTrue(
  "有 products 寫入時反向拉回的 trigger",
  /create\s+trigger\s+products_pull_seats_visibility\s*\n?\s*before\s+insert\s+or\s+update\s+of\s+source_type,\s*source_id,\s*show_seats_remaining/i.test(
    sql0029,
  ),
);
checkTrue(
  "🔴 反向那一支是 before（after 改不動 NEW，等於沒攔）",
  /before\s+insert\s+or\s+update\s+of[\s\S]{0,80}?on\s+public\.products/i.test(sql0029),
);
// 兩支 trigger 函式都不可以留給前台的 key。
for (const fn of ["events_sync_product_seats_visibility", "products_pull_seats_visibility"]) {
  checkTrue(
    `${fn}() 對 public/anon/authenticated revoke execute`,
    new RegExp(
      `revoke execute on function public\\.${fn}\\(\\)\\s*\\n?\\s*from public, anon, authenticated`,
      "i",
    ).test(sql0029),
  );
}

// RPC 也要投影這一欄（沒有它，「上架成商品」那一步會讓商品拿到欄位預設而不是活動
// 的決定）。這裡對的是**現在生效的那一份**，不是 0029 這個檔案本身。
//
// 🔴 0031_event_gallery.sql 用 create or replace 又重寫了一次這支函式（多吃
//    gallery_keys、放寬 external_url），所以「現在生效的那一份」從這一刻起
//    是 0031，不再是 0029——這正是 live-definition.mjs 檔頭警告過的「下一支
//    重寫它的 migration 會再踩一次」。這一條斷言的職責就是在那一刻把作者
//    叫回來：上面 0029 那一段的每一條斷言都已經逐條核對過，在 0031 逐字照抄
//    的那一份裡原樣成立（0031 對 show_seats_remaining 一個字都沒動）。
const MIG_0031_NAME = "0031_event_gallery.sql";
checkTrue(`${MIG_0031_NAME} 存在`, migrations.includes(MIG_0031_NAME));
checkTrue(
  "現在生效的 RPC 就是 0031 那一份",
  liveRpc.file === MIG_0031_NAME,
  `實際是 ${liveRpc.file}`,
);
checkTrue(
  "RPC 把活動的旗標寫進 products（v_event.show_seats_remaining）",
  /v_event\.show_seats_remaining/.test(fnBodySql),
);
checkTrue(
  "🔴 payload 沒帶那個 key 時沿用舊值（coalesce 到 v_prev，不是蓋成 true）",
  /coalesce\(\(v_ev ->> 'show_seats_remaining'\)::boolean, v_prev\.show_seats_remaining, true\)/.test(
    fnBodySql,
  ),
);
checkTrue(
  "on conflict 時 events 那一欄也會被更新",
  /show_seats_remaining = excluded\.show_seats_remaining/.test(fnBodySql),
);
// 「payload 沒帶 product、但活動已經有商品」那條分支也要跟著投影，否則改了旗標
// 又剛好走那條路，商品那一份就停在舊值上（trigger A 會補，但兩邊都對才是規則）。
checkTrue(
  "沒帶 product 的那條 update 分支也投影了旗標",
  /update public\.products p[\s\S]{0,400}?show_seats_remaining = v_event\.show_seats_remaining/.test(
    fnBodySql,
  ),
);

// 0026 的規約：加東西要開新 migration。這幾個名字只可能屬於 0029。
for (const name of [
  "show_seats_remaining",
  "events_seats_visibility_sync_product",
  "products_pull_seats_visibility",
]) {
  const older = migrations
    .filter((f) => f < MIG_0029_NAME)
    .filter((f) => readFile(join(MIG_DIR, f)).includes(name));
  check(
    `"${name}" 沒有出現在 0029 之前的任何一支 migration`,
    older.join(",") || "（無）",
    "（無）",
  );
}

if (!PG_URL) {
  skipped.push("[連線] 段（缺 EVENT_PRODUCT_SELFTEST_PG_URL）");
  console.log(yellow("\n[12–18] 連線測試 —— 跳過：沒有 EVENT_PRODUCT_SELFTEST_PG_URL"));
  console.log(yellow("       設好之後重跑，才會驗到 0026 的冪等、slug 真的回填成 id、"));
  console.log(yellow("       一場活動塞不進第二件商品、RPC 寫出來的 description 是哪一欄、"));
  console.log(yellow("       改代稱之後 products.slug 有沒有跟著改，以及 anon 不能呼叫那支 RPC。"));
  console.log(yellow("       指令見本檔檔頭。"));
} else {
  console.log("\n[12] 連線測試 —— 對本機 PostgreSQL");
  try {
    if (process.env.EVENT_PRODUCT_SELFTEST_APPLY === "1") {
      console.log("  套用 0001–0026（EVENT_PRODUCT_SELFTEST_APPLY=1）");
      // Supabase 特有的東西本機沒有：auth.users / storage.* 是 0001–0003 要的，
      // 三個 role 是每一支 migration 的 grant 要的。建成最小可用的樣子。
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
        // 0008 要 pg_net + vault + pg_cron，本機沒有。跳過它不影響這一期要驗的東西。
        if (f.startsWith("0008_")) continue;
        const r = await q(readFile(join(MIG_DIR, f)));
        if (!r.ok) throw new Error(`套用 ${f} 失敗：${r.error.slice(0, 600)}`);
      }
      checkTrue("0001–0026 套用完成（0008 跳過）", true);
    }

    // 上一次若在中途中止，最後的清理不會跑到 —— 殘留的資料會讓這一次撞唯一鍵。
    await must(CLEANUP_SQL);
    // 🔴 ⚠️ **schema 的事實一定要排在任何一次「重新套用 0026」之前。**
    //
    //    這一段原本排在冪等測試（現在的 [17]）後面，而那一段會把整支 0026 再套一次
    //    —— 也就是說，就算有人手動 drop 掉那個唯一索引或那個 trigger，測試會先把它們
    //    建回來，再去斷言「它們在」。**永遠綠燈，而且再也沒有在檢查任何東西。**
    //    這不是假設：實際做過那個突變（drop index + drop trigger），139 條全綠。
    //
    //    所以順序是硬性的：先看資料庫現在長什麼樣，之後才准動它。
    console.log("\n[13] schema 的事實");
    check(
      "public.events 有 slug 這一欄，而且是 not null",
      String(
        one(
          await must(`select is_nullable from information_schema.columns
                       where table_schema='public' and table_name='events' and column_name='slug'`),
        )?.is_nullable,
      ),
      "NO",
    );
    check(
      "public.events 有 image_key 這一欄，而且可為 NULL",
      String(
        one(
          await must(`select is_nullable from information_schema.columns
                       where table_schema='public' and table_name='events' and column_name='image_key'`),
        )?.is_nullable,
      ),
      "YES",
    );
    check(
      "events_slug_key 是唯一索引",
      String(
        one(
          await must(`select indexdef from pg_indexes
                       where schemaname='public' and tablename='events' and indexname='events_slug_key'`),
        )?.indexdef,
      ).includes("CREATE UNIQUE INDEX"),
      true,
    );
    check(
      "products_event_source_unique_idx 是部分唯一索引",
      String(
        one(
          await must(`select indexdef from pg_indexes
                       where schemaname='public' and tablename='products'
                         and indexname='products_event_source_unique_idx'`),
        )?.indexdef,
      ).includes("WHERE"),
      true,
    );
    // 改了代稱、products.slug 要跟著改，靠的是這個 trigger。它不在，前台反查就
    // 查不到商品，而查不到在畫面上長成「報名尚未開放」——沒有錯誤訊息的那種壞法。
    check(
      "events_slug_sync_product 這個 trigger 在",
      num(
        await must(`select count(*)::int n from pg_trigger
                     where tgrelid = 'public.events'::regclass
                       and tgname = 'events_slug_sync_product'
                       and not tgisinternal`),
      ),
      1,
    );
    // 🔴 同名函式只准有一支。兩支就是 overload 事故 —— PostgREST 會挑錯，而挑錯
    //    的症狀是「新欄位被安靜丟掉」。
    check(
      "admin_upsert_event_with_session 只有一支（沒有 overload）",
      num(
        await must(`select count(*)::int n from pg_proc p
                     join pg_namespace ns on ns.oid = p.pronamespace
                    where ns.nspname='public' and p.proname='admin_upsert_event_with_session'`),
      ),
      1,
    );
    check(
      "anon 不能執行那支 RPC",
      String(
        one(
          await must(
            `select has_function_privilege('anon','public.admin_upsert_event_with_session(jsonb)','execute')::text v`,
          ),
        )?.v,
      ),
      "false",
    );
    check(
      "authenticated 不能執行那支 RPC",
      String(
        one(
          await must(
            `select has_function_privilege('authenticated','public.admin_upsert_event_with_session(jsonb)','execute')::text v`,
          ),
        )?.v,
      ),
      "false",
    );
    check(
      "🔴 service_role 可以執行那支 RPC（revoke from public 會把它一起收走）",
      String(
        one(
          await must(
            `select has_function_privilege('service_role','public.admin_upsert_event_with_session(jsonb)','execute')::text v`,
          ),
        )?.v,
      ),
      "true",
    );

    // ---- 🔴 回填真的把 slug 寫成 id ---------------------------------------
    console.log("\n[14] slug 回填成 id");
    await must(`
      insert into public.event_categories (id, label, sort_order)
      values ('${CAT}', ${L("自檢分類")}, 998)
      on conflict (id) do nothing;
      insert into public.events
        (id, slug, title, summary, description, display_date, category,
         external_url, registration_type, payment_enabled, is_published, sort_order)
      values
        ('${E1}', '${E1}', ${L("自檢活動一")}, ${L("摘要一")}, ${L("整段說明一")},
         '2026.01.01', '${CAT}', 'https://example.com/1', 'internal', true, true, 990),
        ('${E2}', '${E2}', ${L("自檢活動二")}, ${L("摘要二")}, ${L("整段說明二")},
         '2026.02.02', '${CAT}', 'https://example.com/2', 'external', false, true, 991);
    `);

    // 把這兩列的 slug 清成 NULL（模擬「0026 還沒套上的舊資料」），再套一次 0026。
    // 這是唯一能真的驗到回填那一句的方法 —— 光看字串證明不了它跑起來會做什麼。
    await must(`
      alter table public.events alter column slug drop not null;
      update public.events set slug = null where id like 'evprod-%';
    `);
    check(
      "前置：兩列的 slug 已經是 NULL",
      num(
        await must(
          `select count(*)::int n from public.events where id like 'evprod-%' and slug is null`,
        ),
      ),
      2,
    );
    const refill = await q(readFile(join(MIG_DIR, MIG_0026_NAME)));
    checkTrue("重跑 0026 成功", refill.ok, refill.ok ? "" : refill.error.slice(0, 300));
    check(
      "🔴 回填之後 slug 全部等於 id（＝已經發出去的網址仍然有效）",
      num(
        await must(
          `select count(*)::int n from public.events where id like 'evprod-%' and slug is distinct from id`,
        ),
      ),
      0,
    );
    check(
      "回填之後 slug 又變回 not null",
      String(
        one(
          await must(`select is_nullable from information_schema.columns
                       where table_schema='public' and table_name='events' and column_name='slug'`),
        )?.is_nullable,
      ),
      "NO",
    );

    // ---- 🔴 RPC 的投影 ----------------------------------------------------
    // ---- 0026 冪等：再套兩次都不可以報錯 ---------------------------------
    // 上面 [14] 已經套過一次（為了驗回填），這裡再兩次 —— 加起來這一支 run 裡
    // 0026 至少被套用三次，每一次都必須成功。
    console.log("\n[15] 0026 冪等");
    const again1 = await q(readFile(join(MIG_DIR, MIG_0026_NAME)));
    checkTrue(
      "0026 可以重複套用（第二次）",
      again1.ok,
      again1.ok ? "" : again1.error.slice(0, 300),
    );
    const again2 = await q(readFile(join(MIG_DIR, MIG_0026_NAME)));
    checkTrue(
      "0026 可以重複套用（第三次）",
      again2.ok,
      again2.ok ? "" : again2.error.slice(0, 300),
    );

    // 🔴 **把 0026 之後的每一支再套一次，把測試庫還原成「現在生效」的狀態。**
    //
    //    上面那三次重套 0026 有一個沒人注意到的副作用：0026 用 create or replace
    //    重建 admin_upsert_event_with_session()，於是**測試庫裡那支函式被降級回
    //    0026 那一版**。0027 加的七個清單欄位、0029 加的 show_seats_remaining，
    //    從這一行之後就都不在了 —— 而 [16] 與 [18] 都排在後面，也就是說它們從
    //    0027 上線那天起驗的一直是一支舊函式。畫面全綠。
    //
    //    這是寫 [18b] 時才被撞出來的（那一段需要 0029 的行為，於是紅了）。修法不是
    //    把 [18b] 挪到前面 —— 那只會把同一顆地雷留給下一個人。修法是重套之後把後面
    //    每一支都再跑一遍，讓測試庫回到跟正式庫同一個狀態。
    for (const f of migrations.filter((f) => f > MIG_0026_NAME && !f.startsWith("0008_"))) {
      const r = await q(readFile(join(MIG_DIR, f)));
      checkTrue(`重套 0026 之後把 ${f} 補回來（否則後面驗的是被降級的函式）`, r.ok);
      if (!r.ok) console.log(red(`      ${r.error.slice(0, 300)}`));
    }
    check(
      "🔴 還原之後，測試庫裡的 RPC 認得最新的欄位（0027 的清單 + 0029 的旗標）",
      Boolean(
        one(
          await must(`select (prosrc like '%show_seats_remaining%'
                          and prosrc like '%v_prev.highlights%')::text v
                        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where n.nspname='public' and p.proname='admin_upsert_event_with_session'`),
        )?.v === "true",
      ),
      true,
    );

    // ---- 🔴 RPC 的投影 ----------------------------------------------------
    console.log("\n[16] RPC 寫出來的商品");
    const created = one(
      await must(
        `select public.admin_upsert_event_with_session('${eventPayload(
          E1,
          `,\n  "product": { "price": 500, "status": "active" }`,
        )}'::jsonb) r`,
      ),
    )?.r;
    checkTrue("RPC 回傳了東西", Boolean(created));
    const prod = created?.product ?? null;
    checkTrue("RPC 回傳了 product", prod !== null);
    // 🔴 這一條是整支測試的核心。
    check("🔴 products.description === events.summary（zh）", prod?.description?.zh, "一句話摘要");
    check(
      "🔴 products.description 不是 events.description",
      prod?.description?.zh === "整段的活動介紹",
      false,
    );
    check("products.summary 也是 events.summary", prod?.summary?.zh, "一句話摘要");
    check("products.slug = event-<events.slug>", prod?.slug, `event-${E1}`);
    check("products.source_type = event", prod?.source_type, "event");
    check("products.source_id = events.id", prod?.source_id, E1);
    check("products.product_type = event", prod?.product_type, "event");
    check("products.image_key 來自 events.image_key", prod?.image_key, "storage:cover.webp");
    check("products.requires_shipping = false（報名不寄東西）", prod?.requires_shipping, false);
    check("products.capacity = null（名額在場次上）", prod?.capacity, null);
    check("products.seats_taken = 0", prod?.seats_taken, 0);
    // 空字串的 speaker_id 要寫成 NULL，不是吃 23503。
    check(
      "speaker_id 的空字串寫成 NULL",
      one(await must(`select speaker_id from public.events where id='${E1}'`))?.speaker_id ?? null,
      null,
    );

    // ---- 🔴 一場活動塞不進第二件商品 --------------------------------------
    console.log("\n[17] 一場活動最多一件商品");
    const dup = await q(`
      insert into public.products (id, slug, product_type, source_type, source_id,
                                   title, summary, description, price)
      values ('evprod-dup', 'evprod-dup', 'event', 'event', '${E1}',
              ${L("重複")}, ${L("重複")}, ${L("重複")}, 1);
    `);
    checkTrue(
      "🔴 第二件商品被唯一索引擋下（23505）",
      !dup.ok && /products_event_source_unique_idx/.test(dup.error),
      dup.ok ? "居然插進去了" : dup.error.slice(0, 200),
    );
    // 別的來源不受影響 —— 這是部分索引，只管 source_type='event'。
    const otherSource = await q(`
      insert into public.products (id, slug, product_type, source_type, source_id,
                                   title, summary, description, price)
      values ('evprod-j1', 'evprod-j1', 'journey', 'journey', '${E1}',
              ${L("策旅")}, ${L("策旅")}, ${L("策旅")}, 1),
             ('evprod-j2', 'evprod-j2', 'journey', 'journey', '${E1}',
              ${L("策旅")}, ${L("策旅")}, ${L("策旅")}, 1);
    `);
    checkTrue(
      "同一個 source_id 但 source_type='journey' 不受限制（部分索引只管 event）",
      otherSource.ok,
      otherSource.ok ? "" : otherSource.error.slice(0, 200),
    );

    // ---- 🔴 改代稱，products.slug 跟著改 -----------------------------------
    console.log("\n[18] 改代稱與場次");
    await must(`update public.events set slug='evprod-renamed' where id='${E1}'`);
    check(
      "🔴 改了 events.slug，products.slug 跟著變成 event-<新代稱>",
      String(
        one(
          await must(
            `select slug from public.products where source_type='event' and source_id='${E1}'`,
          ),
        )?.slug,
      ),
      "event-evprod-renamed",
    );
    // 改回去，後面的斷言才好讀。
    await must(`update public.events set slug='${E1}' where id='${E1}'`);

    // 場次：RPC 建得出來，而且 seats_taken 不被它碰。
    const withSession = one(
      await must(
        `select public.admin_upsert_event_with_session('${eventPayload(
          E1,
          `,\n  "product": { "price": 500, "status": "active" },\n  "session": {\n    "title": {"zh":"第一場","en":"S1","ja":"第一回"},\n    "location": {"zh":"店內","en":"In store","ja":"店内"},\n    "starts_at": "2026-05-24T19:30:00+08:00",\n    "capacity": 20,\n    "status": "open"\n  }`,
        )}'::jsonb) r`,
      ),
    )?.r;
    check("RPC 建出一個場次", withSession?.session_count, 1);
    check("場次的 capacity 是 20", withSession?.session?.capacity, 20);

    // 手動把 seats_taken 推到 3，再跑一次 RPC —— 它不可以把那個計數器蓋掉。
    await must(`
      update public.event_sessions set seats_taken = 3
       where product_id = (select id from public.products where source_type='event' and source_id='${E1}');
    `);
    const sessionId = String(
      one(
        await must(`select s.id from public.event_sessions s
                     join public.products p on p.id = s.product_id
                    where p.source_type='event' and p.source_id='${E1}'`),
      )?.id,
    );
    await must(
      `select public.admin_upsert_event_with_session('${eventPayload(
        E1,
        `,\n  "product": { "price": 600, "status": "active" },\n  "session": {\n    "id": "${sessionId}",\n    "title": {"zh":"第一場改名","en":"S1","ja":"第一回"},\n    "location": {"zh":"店內","en":"In store","ja":"店内"},\n    "starts_at": "2026-05-24T19:30:00+08:00",\n    "capacity": 30,\n    "status": "open"\n  }`,
      )}'::jsonb)`,
    );
    check(
      "🔴 RPC 更新場次時沒有動 seats_taken（那一欄只由 reserve/release 維護）",
      num(
        await must(`select s.seats_taken::int n from public.event_sessions s
                     join public.products p on p.id = s.product_id
                    where p.source_type='event' and p.source_id='${E1}'`),
      ),
      3,
    );
    check(
      "場次的 capacity 有被更新成 30",
      num(
        await must(`select s.capacity::int n from public.event_sessions s
                     join public.products p on p.id = s.product_id
                    where p.source_type='event' and p.source_id='${E1}'`),
      ),
      30,
    );

    // payload 沒帶 product：不建商品，但文案要跟著活動走。
    const noProduct = one(
      await must(`select public.admin_upsert_event_with_session('${eventPayload(E2)}'::jsonb) r`),
    )?.r;
    check("payload 沒帶 product 時不建商品", noProduct?.product ?? null, null);
    check(
      "E2 沒有商品",
      num(
        await must(
          `select count(*)::int n from public.products where source_type='event' and source_id='${E2}'`,
        ),
      ),
      0,
    );

    // -------------------------------------------------------------------
    console.log("\n[18b] 名額顯示旗標不會分岔（0029）");
    // 這一段是 [11b] 的行為版：那邊驗 SQL 長什麼樣子，這邊驗它**真的**做到了。
    const flagOf = async (what) =>
      String(
        one(
          await must(
            what === "event"
              ? `select show_seats_remaining::text v from public.events where id='${E1}'`
              : `select show_seats_remaining::text v from public.products where source_type='event' and source_id='${E1}'`,
          ),
        )?.v,
      );

    check("新建的活動預設顯示名額（欄位預設 true）", await flagOf("event"), "true");
    check("它的商品也是 true（RPC 投影過去的）", await flagOf("product"), "true");

    // ① 只寫 events（＝ repos/events.ts#upsertEvent 那條不碰商品的路徑）。
    await must(`update public.events set show_seats_remaining = false where id='${E1}'`);
    check("🔴 只改活動，商品那一份也跟著變 false（trigger A）", await flagOf("product"), "false");

    // ② 從商品那一側寫回 true（＝ /admin/products 那條不碰 events 的路徑）。
    await must(
      `update public.products set show_seats_remaining = true where source_type='event' and source_id='${E1}'`,
    );
    check(
      "🔴 從商品那一側改不動 —— 被拉回活動說的答案（trigger B）",
      await flagOf("product"),
      "false",
    );
    check("活動那一份沒有被反向汙染", await flagOf("event"), "false");

    // ③ payload 沒帶那個 key：沿用舊值，不會被蓋回 true。
    await must(
      `select public.admin_upsert_event_with_session('${eventPayload(E1, `,\n  "product": { "price": 500, "status": "active" }`)}'::jsonb)`,
    );
    check("payload 沒帶 key → 活動仍是 false", await flagOf("event"), "false");
    check("payload 沒帶 key → 商品仍是 false", await flagOf("product"), "false");

    // ④ payload 帶 true：兩邊一起變回來。
    await must(
      `select public.admin_upsert_event_with_session('${eventPayload(
        E1,
        `,\n  "product": { "price": 500, "status": "active" }`,
        // ⚠️ 這個 key 要放在 **event 物件裡面**。放到頂層去的話 RPC 會安靜地忽略它，
        //    而畫面上的症狀是「後台的開關按了沒有用」——沒有任何錯誤訊息。
        `,\n    "show_seats_remaining": true`,
      )}'::jsonb)`,
    );
    check("payload 帶 true → 活動變 true", await flagOf("event"), "true");
    check("payload 帶 true → 商品跟著變 true", await flagOf("product"), "true");

    // ⑤ 不變式：全表掃一次，一列都不可以分岔。
    check(
      "🔴 全表沒有任何一件 event 商品與它的活動不一致",
      num(
        await must(`select count(*)::int n
                      from public.products p
                      join public.events e on e.id = p.source_id
                     where p.source_type='event'
                       and p.show_seats_remaining is distinct from e.show_seats_remaining`),
      ),
      0,
    );

    // ⑥ 對照組：**不是** event 來源的商品，trigger B 管不到它（journey 也有場次，
    //    但它沒有 events 列 —— 這正是「反查 events」那條路做不到的事）。
    await must(`
      insert into public.products (id, slug, product_type, title, summary, description,
                                   price, status, show_seats_remaining)
      values ('evprod-journey', 'evprod-journey', 'journey',
              '{"zh":"策旅","en":"Journey","ja":"旅"}', '{"zh":"a","en":"a","ja":"a"}',
              '{"zh":"b","en":"b","ja":"b"}', 5000, 'active', false)
      on conflict (id) do update set show_seats_remaining = excluded.show_seats_remaining;
    `);
    check(
      "非 event 來源的商品保有自己的值（trigger B 只管 source_type='event'）",
      String(
        one(
          await must(
            `select show_seats_remaining::text v from public.products where id='evprod-journey'`,
          ),
        )?.v,
      ),
      "false",
    );
    await must(`delete from public.products where id='evprod-journey'`);
  } catch (err) {
    // 記成一條失敗再往下走，而不是讓例外殺掉整個行程 —— 直接炸掉的話收尾的
    // ##SELFTEST## 那一行印不出來，runner 只會說「沒有印出收尾行」。
    fail += 1;
    console.log(red(`  ✗ 連線測試中止：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    console.log("\n[19] 清理");
    const cleanup = await q(CLEANUP_SQL);
    checkTrue("測試資料清乾淨", cleanup.ok, cleanup.ok ? "" : cleanup.error.slice(0, 300));
    check(
      "沒有殘留的 events",
      num(
        await q(`select count(*)::int n from public.events where id like 'evprod-%'`).then(
          (r) => r.rows,
        ),
      ),
      0,
    );
    check(
      "沒有殘留的 products",
      num(
        await q(
          `select count(*)::int n from public.products where id like 'evprod-%' or slug like 'event-evprod-%'`,
        ).then((r) => r.rows),
      ),
      0,
    );
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
