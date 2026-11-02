#!/usr/bin/env node
/**
 * event-blocks-selftest.mjs —— 活動頁組裝器資料層（D1 / 0027）的自檢
 *
 * 分三段，優先順序也是這個順序：
 *
 *   [執行] **直接 import src/lib/event-blocks.ts 本人**（手法照抄
 *          scripts/localized-list-selftest.mjs），拿到 EVENT_BLOCK_KINDS 與
 *          EVENT_LIST_FIELDS 這兩份名單，再用它們去對帳 0027 的 SQL。驗到的是產線
 *          真正跑的那一份，不是一份長得很像的複本。
 *
 *          ⚠️ 那個檔案的位置**不寫死**。這裡是掃 src/ 找「誰 export 了
 *             EVENT_BLOCK_KINDS」，而且要求**剛好一個檔**。寫死路徑的斷言在程式碼
 *             搬家之後會靜默失去覆蓋（讀不到檔就丟例外只擋得住「檔不見了」，擋不住
 *             「有人在別的地方又定義了第二份」）。
 *
 *   [靜態] 讀 supabase/migrations/0027 的原始碼。這一段永遠會跑，它守的是**形狀與
 *          安全模型**：七個欄位每一個是不是都同時有 default 與 CHECK、revoke 有沒有
 *          排在 grant 前面、SQL 認得的 kind 與 TS 認得的是不是同一組、有沒有偷偷冒出
 *          pricing／feature／meta。
 *
 *          ⚠️ 這一段一律先把 `--` 註解剝掉；需要驗識別字（欄位名、函式名）的地方
 *             **連單引號字串一起剝掉**。理由是這個 repo 出過的假陽性：斷言被
 *             `comment on column … is '…'` 的**內容**餵飽，程式碼改壞了它照樣綠。
 *             `kind in ('faq', …)` 那一條例外——它要驗的就是字串本身，所以只剝註解。
 *
 *   [連線] 對一個真的本機 PostgreSQL 驗**行為**，不是驗字串：形狀不對的清單會不會
 *          真的回 23514、同一個 (event_id, kind, sort_order) 會不會回 23505、重排之後
 *          id 有沒有變、anon 讀不讀得到草稿活動的段落。
 *
 * 🔴 **這一段刻意不會自己套 migration。** 「測試開頭先把要驗的東西重套一次」是這個
 *    repo 出過的假陽性形狀之一：那樣連「把索引從 migration 裡刪掉」都照樣綠，因為
 *    測試自己剛剛把它建回來了。這裡的規則相反 —— 連上去之後如果找不到 0027 建的
 *    東西，就**紅**（不是 skip），並且告訴你這個庫沒套過 0027。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它只認 EVENT_BLOCKS_SELFTEST_PG_URL，那個變數要
 *    自己設；沒設就整段 skip（會印出來，不會靜悄悄消失）。
 *
 * 準備一個可以跑的本機庫（PostgreSQL 14+ 即可，連線的角色要能 set role anon）：
 *
 *     createdb ib_d1_test
 *     EVENT_PRODUCT_SELFTEST_PG_URL=postgres:///ib_d1_test \
 *     EVENT_PRODUCT_SELFTEST_APPLY=1 node scripts/event-product-selftest.mjs
 *     psql -d ib_d1_test -v ON_ERROR_STOP=1 -f supabase/migrations/0027_event_blocks.sql
 *     EVENT_BLOCKS_SELFTEST_PG_URL=postgres:///ib_d1_test node scripts/event-blocks-selftest.mjs
 *
 * （第二行借 event-product-selftest 的 APPLY 開關把 0001–0026 套上去；0008 需要
 *   pg_net / vault / pg_cron，本機沒有，那一支會被跳過。）
 *
 * 環境變數：
 *   EVENT_BLOCKS_SELFTEST_PG_URL   本機測試庫的連線字串（[連線] 段的開關）
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { registerHooks } from "node:module";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
} from "./lib/migration-ledger.mjs";
import { latestDefinition } from "./lib/live-definition.mjs";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/event-blocks-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");
const MIG_0027_NAME = "0027_event_blocks.sql";
const PG_URL = process.env.EVENT_BLOCKS_SELFTEST_PG_URL ?? "";

// -----------------------------------------------------------------------------
// 迷你測試框架（與 event-product-selftest 同一套）
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

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
 * 從此永遠是綠的。見 run-selftests.mjs 的「守門 4」。
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
  const ghost = join(ROOT, "__event-blocks-selftest-missing-probe__");
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

/** 把 `--` 註解整行拿掉。註解裡提到的字不該餵飽任何斷言。 */
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/**
 * 在剝掉註解之外，**再把單引號字串的內容換成空字串**。
 *
 * 這一支專門對付這個 repo 出過的那種假陽性：`comment on column … is '…七個欄位每一個
 * 都有 default 與 CHECK…'` 裡面寫著你要找的那句話，於是斷言被**文件**餵飽，而不是
 * 被**程式碼**餵飽。驗識別字的斷言一律用這一份。
 */
function stripSqlStrings(sql) {
  return stripSqlComments(sql).replace(/'(?:[^']|'')*'/g, "''");
}

/** 切出一段 SQL：從 `from` 開始到 `to` 為止（不含）。找不到起點就回空字串。 */
function sliceBetween(src, from, to) {
  const start = src.indexOf(from);
  if (start === -1) return "";
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end === -1 ? src.length : end);
}

/** 遞迴列出 src/ 底下所有 .ts / .tsx。 */
function walkSrc(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walkSrc(abs, out);
    else if (/\.tsx?$/.test(abs)) out.push(abs);
  }
  return out;
}

console.log("═══ 活動頁組裝器資料層自檢（D1 / 0027）═══");

// =============================================================================
// [0] 找到並載入產線模組本人
// =============================================================================
console.log("\n[0] 產線模組");

if (typeof registerHooks !== "function") {
  console.log(red("  ✗ 這個 Node 沒有 module.registerHooks（需要 ≥ 22.15）"));
  console.log(`##SELFTEST## file=${SELF} pass=0 fail=1`);
  process.exit(1);
}

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      const base = join(ROOT, "src", spec.slice(2));
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    if (spec.startsWith(".") && !/\.[a-zA-Z]+$/.test(spec)) {
      try {
        const url = new URL(`${spec}.ts`, ctx.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      } catch {
        /* 落回預設解析 */
      }
    }
    return next(spec, ctx);
  },
});

// 🔴 不寫死路徑：掃出「誰 export 了 EVENT_BLOCK_KINDS」。剛好一個才算數。
//    ‧ 0 個 → 這一期的字彙表根本不存在（或被改名），下面所有對帳都失去意義。
//    ‧ ≥2 個 → 有第二份名單了，而「SQL 與 TS 一致」這句話立刻變得沒有意義。
const kindDefiners = walkSrc(join(ROOT, "src")).filter((f) =>
  /export\s+const\s+EVENT_BLOCK_KINDS\b/.test(readFileSync(f, "utf8")),
);
check(
  "src/ 底下剛好一個檔 export EVENT_BLOCK_KINDS",
  kindDefiners.map((f) => relative(ROOT, f)).sort(),
  kindDefiners.length === 1 ? [relative(ROOT, kindDefiners[0])] : ["（剛好一個）"],
);

if (kindDefiners.length !== 1) {
  console.log(red("  ✗ 找不到唯一的字彙表檔案，後面的對帳無法進行"));
  console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail + 1}`);
  process.exit(1);
}

const VOCAB_PATH = kindDefiners[0];
console.log(`      字彙表：${relative(ROOT, VOCAB_PATH)}`);

const vocab = await import(pathToFileURL(VOCAB_PATH).href);
const { EVENT_BLOCK_KINDS, EVENT_LIST_FIELDS, EMPTY_LOCALIZED_LIST } = vocab;

checkTrue("EVENT_BLOCK_KINDS 是陣列", Array.isArray(EVENT_BLOCK_KINDS));
checkTrue("EVENT_LIST_FIELDS 是陣列", Array.isArray(EVENT_LIST_FIELDS));
check(
  "三種 kind：faq / info_row / agenda",
  [...(EVENT_BLOCK_KINDS ?? [])],
  ["faq", "info_row", "agenda"],
);
check(
  "七個清單欄位，順序就是前台由上到下",
  [...(EVENT_LIST_FIELDS ?? [])],
  ["highlights", "suitable_for", "not_suitable_for", "takeaways", "outline", "includes", "notes"],
);
check("EMPTY_LOCALIZED_LIST 是三個空陣列", EMPTY_LOCALIZED_LIST, { zh: [], en: [], ja: [] });

// 這個檔案要能被上面那個 await import 直接載起來，所以不可以有 import。
const vocabSrc = readFile(VOCAB_PATH);
checkFalse(
  "字彙表檔案一行 import 都沒有（自檢才載得起產線本人）",
  /^\s*import\s/m.test(vocabSrc.replace(/\/\*[\s\S]*?\*\//g, "")),
  "一旦出現 `@/…`，這支測試就只剩讀原始碼比對字串可以做。",
);

// =============================================================================
// [1] migration 檔案盤點
// =============================================================================
console.log("\n[1] migration 檔案盤點");

const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

checkTrue(`${MIG_0027_NAME} 存在`, migrations.includes(MIG_0027_NAME));

// ── 這裡原本是 `check("0027 是目前編號最大的一支", migrations.at(-1), MIG_0027_NAME)` ──
//
// 那一條是真的會轉紅的（不像 0023 那幾條假的位置快照），它的用意是「有人加了新的
// migration，回來看一眼這支自檢」。問題是它對**每一支**新 migration 都轉紅，而且
// 轉紅之後唯一的修法是把它改成新的檔名 —— 作者沒有被問到任何問題，只是把一個字串
// 換掉。0028 進來的時候它就是這樣紅的。
//
// 換成 scripts/lib/migration-ledger.mjs 那一套，這支自檢從「編號快照」升級成兩件事：
//
//   · assertLedgerMatchesDisk() —— 比對**完整的有序檔名清單**與連續編號。比原來那條
//     強：少一支、多一支、改名、跳號、重號、順序不對全都抓得到，而原來那條只看
//     最後一個元素。新增 migration 而沒在帳本補一列，這裡照樣轉紅。
//   · assertMigrationDependencies() —— 只有「動到 events_shape / localized_list」的
//     migration 才把這支叫回來，而且訊息會直接寫出是哪一支動到哪一區。
//
// 0028（免費訂單結算）碰的是 orders_payments / order_expiry / event_registrations /
// session_seats / invoice，與這一支要守的東西沒有交集 —— 它一個字都沒有動
// events / event_blocks / is_localized_list。所以底下每一條斷言原樣成立。
assertLedgerMatchesDisk(check, MIG_DIR);
assertLedgerDeclarationsHonest(check, MIG_DIR);
assertMigrationDependencies(check, MIG_DIR, {
  suite: "event-blocks-selftest",
  // 這支自檢從頭到尾在驗的就是 0027 建的那一套：events 的七個三語清單欄位
  // （events_shape）與守著它們形狀的 is_localized_list（localized_list）。
  dependsOn: ["events_shape", "localized_list"],
  // ── 0029_event_seats_visibility.sql 的重讀結論 ───────────────────────────
  // 0029 讓「尚餘名額 N」變成逐場活動可以關掉：public.events 與 public.products 各加
  // 一個 show_seats_remaining（boolean not null default true ＝ 維持既有行為），加兩個
  // trigger 讓兩邊不分岔（events→products 推、products 寫入時反向拉），並用
  // create or replace 讓 admin_upsert_event_with_session() 多讀一個 payload key。
  // **沒有 ALTER 任何一張既有欄位、沒有 drop 任何函式、沒有動到任何一支 RPC 的邏輯**
  // ——那支函式的本體是 0027 那一份逐字照抄，只多了三處 show_seats_remaining
  // （0029 §5 寫了差異清單，scripts/event-blocks-selftest.mjs [7] 現在改成驗
  //   **最後一支重新定義它的 migration**，所以那份抄寫走樣會轉紅）。
  // 逐條重讀之後：0027 的七個清單欄位（insert 欄位清單／on conflict／coalesce 到 v_prev）
  // 三組斷言原樣成立 —— 0029 只是在同一份清單後面多接一欄，七欄一個都沒被移動或改寫。
  // is_localized_list() 的形狀守衛與 v_prev 的讀取也原樣照抄。event_blocks 那張表與
  // admin_reorder_event_blocks() 0029 一個字都沒提到。原樣成立。
  // ── 0031_event_gallery.sql 的重讀結論 ─────────────────────────────────────
  // ⚠️ reviewedThrough 從 0029 推到 0031，中間跳過的 0030_customer_accounts.sql
  //    也重讀過：帳本標它只碰 orders_payments，它沒有重新定義
  //    admin_upsert_event_with_session()，也沒有動 events / event_blocks /
  //    is_localized_list 任何一個字。
  // 0031 用 create or replace 又重寫了一次 admin_upsert_event_with_session()
  // ——上面 [7] 的 liveUpsert / upsertFn 從這一刻起讀到的就是 0031 那一份，
  // 這正是這支自檢逐條核對過的（見上面 [7] 每一條斷言，特別是
  // EVENT_LIST_FIELDS 那個迴圈）。0031 對 0027 的七個清單欄位（insert 欄位
  // 清單／on conflict／coalesce 到 v_prev）三組斷言一個字都沒動——七欄一個都
  // 沒被移動或改寫，新增的 gallery_keys 與 external_url 兩處改動插在它們
  // **後面**，不影響任何一欄的位置。is_localized_list() 的形狀守衛與 v_prev
  // 的讀取也原樣照抄。event_blocks 那張表與 admin_reorder_event_blocks()
  // 0031 一個字都沒提到（它連 event_blocks 這個字都沒出現過）。原樣成立。
  // 2026-11-02 0052_event_listing_status.sql：帳本標了 events_shape／localized_list——它加了
  // events.status、重寫 admin_upsert_event_with_session（取自正式庫本體，只加 status 三處；七個
  // 清單欄位的驗證與 coalesce 逐字沿用）。中間的 0037–0050 沒有動到這兩區。本檔斷言重跑全綠。
  reviewedThrough: "0052_event_listing_status.sql",
});

check(
  "0027 緊接在 0026 之後（沒有跳號、沒有被插隊）",
  migrations[migrations.indexOf(MIG_0027_NAME) - 1],
  "0026_event_product_link.sql",
);

const sql27raw = readFile(join(MIG_DIR, MIG_0027_NAME));
const sql27 = stripSqlComments(sql27raw);
const sql27id = stripSqlStrings(sql27raw); // 識別字用：註解與字串都剝掉
checkTrue("0027 不是空檔", sql27.trim().length > 0);
checkTrue("0027 有 begin; / commit;", /\bbegin;/.test(sql27) && /\bcommit;\s*$/.test(sql27.trim()));

/**
 * 「加東西要開新 migration，不可以回頭改已套用的那幾支」是這個 repo 的規約。
 * 要驗就要用**只可能屬於 0027** 的名字（不能用 "outline"、"notes" 這種字 —— 別的
 * migration 的註解裡本來就可能出現）。
 */
const NAMES_ONLY_IN_0027 = [
  "is_localized_list",
  "event_blocks",
  "admin_reorder_event_blocks",
  "events_highlights_localized_list",
];
for (const name of NAMES_ONLY_IN_0027) {
  const offenders = migrations
    .filter((f) => f < MIG_0027_NAME)
    .filter((f) => readFile(join(MIG_DIR, f)).includes(name));
  check(
    `0001–0026 沒有任何一支提到 ${name}（＝沒有回頭改舊 migration）`,
    offenders.join(",") || "（無）",
    "（無）",
  );
}

// =============================================================================
// [2] is_localized_list()：新開一支，不動 0001 的 is_localized()
// =============================================================================
console.log("\n[2] is_localized_list()");

checkTrue(
  "0027 建了 public.is_localized_list(jsonb)",
  /create\s+or\s+replace\s+function\s+public\.is_localized_list\s*\(\s*v\s+jsonb\s*\)/i.test(
    sql27id,
  ),
);

const isListBody = sliceBetween(
  sql27id,
  "create or replace function public.is_localized_list",
  "$$;",
);
checkTrue("is_localized_list 是 immutable", /\bimmutable\b/i.test(isListBody));
checkTrue(
  "is_localized_list 三個語言的 key 都驗了",
  /'zh'/.test(sliceBetween(sql27, "create or replace function public.is_localized_list", "$$;")) &&
    /'en'/.test(
      sliceBetween(sql27, "create or replace function public.is_localized_list", "$$;"),
    ) &&
    /'ja'/.test(sliceBetween(sql27, "create or replace function public.is_localized_list", "$$;")),
);
checkTrue(
  "🔴 每一條路都回 true/false（有 coalesce 包住 jsonb_typeof，CHECK 把 NULL 當通過）",
  (isListBody.match(/coalesce\s*\(\s*jsonb_typeof/gi) ?? []).length === 3,
  "少一個 coalesce，那個 key 不存在時函式回 NULL，CHECK 就變成放行。",
);
checkTrue(
  "用 CASE 而不是一串 AND（先確定是陣列才展開，否則 jsonb_array_elements 會丟 22023）",
  /\bcase\b/i.test(isListBody) && (isListBody.match(/\bwhen\b/gi) ?? []).length >= 5,
);
checkTrue("有驗每個元素都是 string", /jsonb_typeof\s*\(\s*e\.item\s*\)/i.test(isListBody));

// 0001 的那一支一個字都不能動。
checkFalse(
  "🔴 0027 沒有重新定義 0001 的 is_localized()",
  /create\s+or\s+replace\s+function\s+public\.is_localized\s*\(/i.test(sql27id),
);
checkFalse("0027 沒有 drop function", /\bdrop\s+function\b/i.test(sql27id));
checkTrue(
  "0001 的 is_localized() 還在原地（沒有被改成清單版）",
  /create\s+or\s+replace\s+function\s+public\.is_localized\s*\(\s*v\s+jsonb\s*\)/i.test(
    readFile(join(MIG_DIR, "0001_init.sql")),
  ),
);

// =============================================================================
// [3] 🔴 七個清單欄位 —— 逐欄比對，不是數個數
// =============================================================================
console.log("\n[3] events 的七個清單欄位（逐欄）");

const EMPTY_DEFAULT_RE = /'\{"zh":\s*\[\],\s*"en":\s*\[\],\s*"ja":\s*\[\]\}'::jsonb/;

for (const col of EVENT_LIST_FIELDS) {
  // default：註解與字串都剝掉的版本裡找不到 default 值本身（它是字串），所以這一條
  // 用只剝註解的版本 —— 但正則把「add column if not exists <col> jsonb not null default」
  // 綁死在一起，`comment on column … is '…'` 不可能長成這樣。
  const addRe = new RegExp(
    `add\\s+column\\s+if\\s+not\\s+exists\\s+${col}\\s+jsonb\\s+not\\s+null\\s+default\\s+('\\{[^']*\\}'::jsonb)`,
    "i",
  );
  const m = addRe.exec(sql27);
  checkTrue(`${col}：not null 且有 default`, m !== null);
  checkTrue(
    `${col}：default 就是三個空陣列`,
    m !== null && EMPTY_DEFAULT_RE.test(m[1]),
    m ? `實得 ${m[1]}` : "",
  );

  // CHECK：識別字層級，用剝掉字串的版本，comment 餵不進來。
  const checkRe = new RegExp(
    `add\\s+constraint\\s+events_${col}_localized_list\\s+check\\s*\\(\\s*public\\.is_localized_list\\s*\\(\\s*${col}\\s*\\)\\s*\\)`,
    "i",
  );
  checkTrue(`${col}：有自己的 CHECK（public.is_localized_list(${col})）`, checkRe.test(sql27id));

  // 冪等：每一條 CHECK 都要先問過 pg_constraint。
  const guardRe = new RegExp(`conname\\s*=\\s*'events_${col}_localized_list'`);
  checkTrue(`${col}：加 CHECK 前先問過 pg_constraint（可以重複套用）`, guardRe.test(sql27));
}

checkFalse(
  "沒有第八個欄位（線上／實體大綱沒有被拆成兩欄）",
  /add\s+column\s+if\s+not\s+exists\s+(online_outline|offline_outline|outline_online|outline_offline|tags)\b/i.test(
    sql27id,
  ),
);
check(
  "0027 一共加了七個欄位到 events",
  (sql27id.match(/add\s+column\s+if\s+not\s+exists\s+\w+\s+jsonb/gi) ?? []).length,
  7,
);

// =============================================================================
// [4] event_blocks —— 掛在 events，三種 kind，沒有 meta
// =============================================================================
console.log("\n[4] event_blocks");

const createTable = sliceBetween(sql27, "create table if not exists public.event_blocks", ");");
const createTableId = sliceBetween(sql27id, "create table if not exists public.event_blocks", ");");
checkTrue("0027 建了 public.event_blocks（if not exists）", createTable.length > 0);

checkTrue(
  "🔴 event_id 掛在 public.events 上",
  /event_id\s+text\s+not\s+null\s+references\s+public\.events\s*\(\s*id\s*\)/i.test(createTableId),
);
checkFalse(
  "🔴 沒有掛在 public.products 上（活動可以先有內容再有商品）",
  /references\s+public\.products/i.test(createTableId),
);
checkTrue("event_id 是 on delete cascade", /on\s+delete\s+cascade/i.test(createTableId));

// kind CHECK 要驗的就是字串本身，所以這一條只剝註解、不剝字串。
const kindCheck =
  /constraint\s+event_blocks_kind_valid\s+check\s*\(\s*kind\s+in\s*\(([^)]*)\)\s*\)/i.exec(
    createTable,
  );
checkTrue("event_blocks 有 kind 的 CHECK", kindCheck !== null);
const kindsInSql = kindCheck ? [...kindCheck[1].matchAll(/'([^']*)'/g)].map((m) => m[1]) : [];
check("🔴 SQL 的 kind CHECK 與 TS 的 EVENT_BLOCK_KINDS 逐字相等", kindsInSql, [
  ...(EVENT_BLOCK_KINDS ?? []),
]);

checkFalse("沒有 pricing（金額的唯一真相是 products.price）", kindsInSql.includes("pricing"));
checkFalse("沒有 feature（形狀與 info_row 相同，只差 CSS 欄數）", kindsInSql.includes("feature"));

checkFalse(
  "🔴 沒有 meta jsonb（三語化之後唯一 CHECK 保護不到的地方）",
  /^\s*meta\s+jsonb/im.test(createTableId),
);
checkTrue("title 是 not null", /\btitle\s+jsonb\s+not\s+null/i.test(createTableId));
checkTrue("body 是 not null", /\bbody\s+jsonb\s+not\s+null/i.test(createTableId));
checkTrue(
  "title / body 都過 is_localized()（不是清單版）",
  /check\s*\(\s*public\.is_localized\s*\(\s*title\s*\)\s*\)/i.test(createTableId) &&
    /check\s*\(\s*public\.is_localized\s*\(\s*body\s*\)\s*\)/i.test(createTableId),
);
checkTrue(
  "唯一約束是 (event_id, kind, sort_order)",
  /unique\s*\(\s*event_id\s*,\s*kind\s*,\s*sort_order\s*\)/i.test(createTableId),
);

// ── RLS ────────────────────────────────────────────────────────────────────
checkTrue(
  "event_blocks 開了 RLS",
  /alter\s+table\s+public\.event_blocks\s+enable\s+row\s+level\s+security/i.test(sql27id),
);
for (const cmd of ["insert", "update", "delete"]) {
  checkTrue(
    `event_blocks 有 ${cmd} 的 restrictive deny policy`,
    new RegExp(
      `create\\s+policy\\s+event_blocks_deny_${cmd}\\s+on\\s+public\\.event_blocks\\s+as\\s+restrictive\\s+for\\s+${cmd}`,
      "i",
    ).test(sql27id),
  );
}
checkTrue(
  "select policy 用 exists(...) 擋掉草稿活動的段落",
  /create\s+policy\s+event_blocks_select_public[\s\S]{0,400}?exists\s*\([\s\S]{0,200}?public\.events[\s\S]{0,120}?is_published/i.test(
    sql27id,
  ),
);
for (const p of ["select_public", "deny_insert", "deny_update", "deny_delete"]) {
  checkTrue(
    `event_blocks_${p} 先 drop policy if exists（可以重複套用）`,
    new RegExp(
      `drop\\s+policy\\s+if\\s+exists\\s+event_blocks_${p}\\s+on\\s+public\\.event_blocks`,
      "i",
    ).test(sql27id),
  );
}

// =============================================================================
// [5] 🔴 revoke 一定排在 grant 前面
// =============================================================================
console.log("\n[5] revoke / grant 的順序");

/** 回傳 [revokeIndex, grantIndex]，找不到就是 -1。 */
function revokeGrantOrder(objectRe) {
  const rev = new RegExp(`revoke[^;]*?${objectRe}[^;]*;`, "i").exec(sql27id);
  const gra = new RegExp(`grant[^;]*?${objectRe}[^;]*;`, "i").exec(sql27id);
  return [rev ? rev.index : -1, gra ? gra.index : -1];
}

for (const [label, objectRe] of [
  ["public.event_blocks（table）", "on\\s+table\\s+public\\.event_blocks"],
  ["admin_reorder_event_blocks", "public\\.admin_reorder_event_blocks"],
  ["admin_upsert_event_with_session", "public\\.admin_upsert_event_with_session"],
]) {
  const [r, g] = revokeGrantOrder(objectRe);
  checkTrue(`${label}：revoke 與 grant 都在`, r !== -1 && g !== -1);
  checkTrue(
    `${label}：revoke 排在 grant 前面`,
    r !== -1 && g !== -1 && r < g,
    `revoke@${r} / grant@${g}`,
  );
}

checkTrue(
  "event_blocks 的 grant 只給 anon/authenticated SELECT",
  /grant\s+select\s+on\s+table\s+public\.event_blocks\s+to\s+anon,\s*authenticated/i.test(sql27id),
);
checkFalse(
  "沒有給 anon/authenticated 任何寫入權限",
  /grant\s+(all|insert|update|delete)[^;]*on\s+table\s+public\.event_blocks[^;]*\b(anon|authenticated)\b/i.test(
    sql27id,
  ),
);
for (const fn of ["admin_reorder_event_blocks", "admin_upsert_event_with_session"]) {
  checkTrue(
    `${fn}：從 public / anon / authenticated 收回 execute`,
    new RegExp(
      `revoke\\s+execute\\s+on\\s+function\\s+public\\.${fn}[^;]*from\\s+public,\\s*anon,\\s*authenticated`,
      "i",
    ).test(sql27id),
  );
  checkTrue(
    `${fn}：只 grant 給 service_role`,
    new RegExp(
      `grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}[^;]*to\\s+service_role`,
      "i",
    ).test(sql27id),
  );
}

// =============================================================================
// [6] admin_reorder_event_blocks —— 形狀照 0002，不是 client 驅動的四步
// =============================================================================
console.log("\n[6] admin_reorder_event_blocks");

const reorderFn = sliceBetween(
  sql27id,
  "create or replace function public.admin_reorder_event_blocks",
  "$$;",
);
checkTrue("0027 建了 admin_reorder_event_blocks", reorderFn.length > 0);
checkTrue(
  "簽名是 (p_event_id text, p_kind text, p_ids bigint[])",
  /p_event_id\s+text[\s\S]*?p_kind\s+text[\s\S]*?p_ids\s+bigint\[\]/i.test(reorderFn),
);
checkTrue(
  "security definer + set search_path = public",
  /security\s+definer/i.test(reorderFn) && /set\s+search_path\s*=\s*public/i.test(reorderFn),
);

// 🔴 「照 0002 的形狀」這句話要對著 0002 本人驗，不是對著一個抄在這裡的字面量驗。
//    0002 哪天改了寫法，這兩條會一起紅，而不是留下一個過期的抄本繼續綠。
const sql02 = stripSqlStrings(readFile(join(MIG_DIR, "0002_admin.sql")));
const PARK_RE = /set\s+sort_order\s*=\s*-\s*sort_order\s*-\s*1/i;
const ORDINALITY_RE =
  /unnest\s*\(\s*p_ids\s*\)\s+with\s+ordinality\s+as\s+pos\s*\(\s*id\s*,\s*ord\s*\)/i;
checkTrue(
  "0002 的 reorder 仍然是「停到負數」的寫法（這一條是下面兩條的前提）",
  PARK_RE.test(sql02) && ORDINALITY_RE.test(sql02),
);
checkTrue("先停到負數（-sort_order - 1），與 0002 逐字同形", PARK_RE.test(reorderFn));
checkTrue("再用 unnest(p_ids) with ordinality 寫最終值", ORDINALITY_RE.test(reorderFn));
checkTrue(
  "兩個 update 都綁住 event_id 與 kind（不會動到別場活動、別種段落）",
  (reorderFn.match(/event_id\s*=\s*p_event_id/gi) ?? []).length === 2 &&
    (reorderFn.match(/kind\s*=\s*p_kind/gi) ?? []).length === 2,
);

// =============================================================================
// [7] admin_upsert_event_with_session 吃這七個欄位（create or replace，不 drop）
// =============================================================================
console.log("\n[7] admin_upsert_event_with_session");

/**
 * 🔴 **從「現在生效的那一份」切，不是從 0027 切。**
 *
 * 這一段原本寫的是 `sliceBetween(sql27id, "create or replace function …")`，也就是
 * 0027 檔案裡的那一份。0027 是已套用的 migration，規約禁止再改它一個字 —— 所以那
 * 條斷言從此**永遠是綠的**，而且在 0029 用 create or replace 又重寫一次這支函式
 * 之後，它驗的已經是一份沒有任何資料庫在跑的死定義。畫面全綠，覆蓋是零。
 * （event-product-selftest 更早就掉進同一個坑：它切的是 0026 的那一份。）
 *
 * latestDefinition() 去找**最後一支**重新定義它的 migration，所以下一期再重寫一次
 * 時，底下每一條斷言會自動改去驗那一份新的；重寫時漏抄了哪一條，這裡就紅。
 * 找不到定義會丟例外（不是回空字串）—— 空字串會讓下面的否定斷言靜默通過。
 */
const liveUpsert = latestDefinition(MIG_DIR, "admin_upsert_event_with_session", stripSqlStrings);
const upsertFn = liveUpsert.body;
checkTrue("切得到現在生效的那一份 admin_upsert_event_with_session", upsertFn.length > 1000);
checkTrue(
  "現在生效的那一份不早於 0027（0027 是七個清單欄位進來的那一支）",
  liveUpsert.file >= MIG_0027_NAME,
  `最後一支重新定義它的是 ${liveUpsert.file}`,
);
checkTrue(
  "用 create or replace 重寫（不是 drop 再建）",
  /^create or replace function/.test(upsertFn),
);
checkTrue(
  "🔴 簽名沒變，還是吃一個 payload jsonb（所以不需要 drop function）",
  /admin_upsert_event_with_session\s*\(\s*payload\s+jsonb\s*\)/i.test(upsertFn),
);

const insertCols = sliceBetween(upsertFn, "insert into public.events (", ")");
const conflictSet = sliceBetween(upsertFn, "on conflict (id) do update set", "returning");
for (const col of EVENT_LIST_FIELDS) {
  checkTrue(`${col}：出現在 insert 的欄位清單裡`, new RegExp(`\\b${col}\\b`).test(insertCols));
  checkTrue(
    `${col}：on conflict 時也會被更新`,
    new RegExp(`${col}\\s*=\\s*excluded\\.${col}`, "i").test(conflictSet),
  );
  checkTrue(
    `${col}：payload 沒帶就沿用舊值（coalesce 到 v_prev，不是蓋成空清單）`,
    new RegExp(`coalesce\\s*\\(\\s*v_ev\\s*->\\s*''\\s*,\\s*v_prev\\.${col}\\s*,`, "i").test(
      upsertFn,
    ),
  );
}
checkTrue(
  "帶了但形狀不對會被點名擋下來（不是讓 CHECK 丟一串約束名）",
  /v_ev\s*\?\s*v_key[\s\S]{0,120}?not\s+public\.is_localized_list\s*\(\s*v_ev\s*->\s*v_key\s*\)/i.test(
    upsertFn,
  ),
);
checkTrue(
  "有先把舊的那一列讀進 v_prev",
  /select\s+e\.\*\s+into\s+v_prev\s+from\s+public\.events\s+e/i.test(upsertFn),
);

// 0026 訂下的兩條規則不可以在這次重寫時走鐘。
checkTrue(
  "products.description 仍然取 events.summary（0026 訂的規則沒有在重寫時走鐘）",
  // 同樣改讀現在生效的那一份 —— 這條規則要守的就是「每一次重寫都不准走鐘」，
  // 從一支再也不會變的舊檔案裡讀它，等於只驗了它第一次沒走鐘。
  /v_event\.summary,?\s*\n\s*v_event\.summary/.test(
    sliceBetween(upsertFn, "insert into public.products (", "on conflict"),
  ),
);
checkFalse("session 的 seats_taken 仍然不在這支函式裡被寫", /seats_taken\s*=/.test(upsertFn));

// =============================================================================
// [8] 連線測試 —— 對一個真的本機 PostgreSQL
// =============================================================================
console.log("\n[8] 連線測試");

/**
 * 一次 psql，一個 session。輸出是 `k|v` 逐行。
 *
 * 🔴 這裡**不套任何 migration**。連上去之後找不到 0027 建的東西就紅 —— 見檔頭。
 */
const PROBE_SQL = `
begin;

create temp table _p(k text, v text);
grant insert, select on _p to anon;

insert into public.event_categories (id, label)
values ('evblk-cat', '{"zh":"講座","en":"Talk","ja":"トーク"}'::jsonb);

insert into public.events (id, slug, title, summary, description, display_date, category, external_url, is_published)
values
  ('evblk-pub', 'evblk-pub',
   '{"zh":"公開","en":"Pub","ja":"公開"}'::jsonb,
   '{"zh":"s","en":"s","ja":"s"}'::jsonb,
   '{"zh":"d","en":"d","ja":"d"}'::jsonb,
   '2026.05.24', 'evblk-cat', 'https://example.com/a', true),
  ('evblk-draft', 'evblk-draft',
   '{"zh":"草稿","en":"Draft","ja":"下書き"}'::jsonb,
   '{"zh":"s","en":"s","ja":"s"}'::jsonb,
   '{"zh":"d","en":"d","ja":"d"}'::jsonb,
   '2026.05.25', 'evblk-cat', 'https://example.com/b', false);

do $$
declare
  v_cases text[][] := array[
    ['zh_is_string',      '{"zh":"x"}'],
    ['zh_is_string_full', '{"zh":"x","en":[],"ja":[]}'],
    ['missing_zh',        '{"en":[],"ja":[]}'],
    ['missing_en',        '{"zh":[],"ja":[]}'],
    ['missing_ja',        '{"zh":[],"en":[]}'],
    ['element_is_number', '{"zh":[1],"en":[],"ja":[]}'],
    ['zh_is_json_null',   '{"zh":null,"en":[],"ja":[]}'],
    ['valid_empty',       '{"zh":[],"en":[],"ja":[]}'],
    ['valid_filled',      '{"zh":["一"],"en":["one"],"ja":["ひとつ"]}']
  ];
  i int;
begin
  for i in 1 .. array_length(v_cases, 1) loop
    begin
      update public.events set highlights = v_cases[i][2]::jsonb where id = 'evblk-pub';
      insert into _p values ('check_' || v_cases[i][1], '00000');
      update public.events set highlights = '{"zh":[],"en":[],"ja":[]}'::jsonb where id = 'evblk-pub';
    exception when others then
      insert into _p values ('check_' || v_cases[i][1], sqlstate);
    end;
  end loop;
end $$;

insert into public.event_blocks (event_id, kind, title, body, sort_order) values
  ('evblk-pub', 'agenda', '{"zh":"19:30","en":"19:30","ja":"19:30"}'::jsonb, '{"zh":"入場","en":"Doors","ja":"開場"}'::jsonb, 1),
  ('evblk-pub', 'agenda', '{"zh":"19:40","en":"19:40","ja":"19:40"}'::jsonb, '{"zh":"開場","en":"Start","ja":"開始"}'::jsonb, 2),
  ('evblk-pub', 'agenda', '{"zh":"21:00","en":"21:00","ja":"21:00"}'::jsonb, '{"zh":"散場","en":"End","ja":"終了"}'::jsonb, 3);

do $$
declare
  v_bad text[][] := array[
    ['dup_sort_order', 'agenda',  '1'],
    ['kind_pricing',   'pricing', '9'],
    ['kind_feature',   'feature', '9']
  ];
  i int;
begin
  for i in 1 .. array_length(v_bad, 1) loop
    begin
      insert into public.event_blocks (event_id, kind, title, body, sort_order)
      values ('evblk-pub', v_bad[i][2],
              '{"zh":"x","en":"x","ja":"x"}'::jsonb,
              '{"zh":"y","en":"y","ja":"y"}'::jsonb,
              v_bad[i][3]::int);
      insert into _p values (v_bad[i][1], '00000');
    exception when others then
      insert into _p values (v_bad[i][1], sqlstate);
    end;
  end loop;

  begin
    insert into public.event_blocks (event_id, kind, title, body, sort_order)
    values ('evblk-pub', 'faq', '{"zh":"x","en":"x","ja":"x"}'::jsonb, null, 9);
    insert into _p values ('body_null', '00000');
  exception when others then
    insert into _p values ('body_null', sqlstate);
  end;
end $$;

insert into _p
select 'before_ids', string_agg(id::text, ',' order by sort_order)
  from public.event_blocks where event_id='evblk-pub' and kind='agenda';

do $$
declare v_ids bigint[];
begin
  select array_agg(id order by sort_order desc) into v_ids
    from public.event_blocks where event_id='evblk-pub' and kind='agenda';
  perform public.admin_reorder_event_blocks('evblk-pub', 'agenda', v_ids);
end $$;

insert into _p
select 'after_ids', string_agg(id::text, ',' order by sort_order)
  from public.event_blocks where event_id='evblk-pub' and kind='agenda';
insert into _p
select 'after_orders', string_agg(sort_order::text, ',' order by id)
  from public.event_blocks where event_id='evblk-pub' and kind='agenda';

insert into public.event_blocks (event_id, kind, title, body, sort_order) values
  ('evblk-draft', 'faq', '{"zh":"q","en":"q","ja":"q"}'::jsonb, '{"zh":"a","en":"a","ja":"a"}'::jsonb, 1),
  ('evblk-draft', 'faq', '{"zh":"q2","en":"q2","ja":"q2"}'::jsonb, '{"zh":"a2","en":"a2","ja":"a2"}'::jsonb, 2);

set local role anon;
insert into _p select 'anon_draft_rows', count(*)::text from public.event_blocks where event_id='evblk-draft';
insert into _p select 'anon_pub_rows',   count(*)::text from public.event_blocks where event_id='evblk-pub';
do $$
begin
  begin
    insert into public.event_blocks (event_id, kind, title, body, sort_order)
    values ('evblk-pub', 'faq', '{"zh":"x","en":"x","ja":"x"}'::jsonb, '{"zh":"y","en":"y","ja":"y"}'::jsonb, 77);
    insert into _p values ('anon_insert', '00000');
  exception when others then
    insert into _p values ('anon_insert', sqlstate);
  end;
  begin
    perform public.admin_reorder_event_blocks('evblk-pub', 'agenda', array[]::bigint[]);
    insert into _p values ('anon_reorder', '00000');
  exception when others then
    insert into _p values ('anon_reorder', sqlstate);
  end;
end $$;
reset role;

select k || '|' || v from _p order by k;

rollback;
`;

const PRECONDITION_SQL = `
select 'table|'      || (to_regclass('public.event_blocks') is not null)::text
union all
select 'fn_islist|'  || (to_regprocedure('public.is_localized_list(jsonb)') is not null)::text
union all
select 'fn_reorder|' || (to_regprocedure('public.admin_reorder_event_blocks(text,text,bigint[])') is not null)::text
union all
select 'cols|'       || count(*)::text
  from information_schema.columns
 where table_schema='public' and table_name='events'
   and column_name in ('highlights','suitable_for','not_suitable_for','takeaways','outline','includes','notes')
union all
select 'checks|'     || count(*)::text
  from pg_constraint
 where conrelid='public.events'::regclass and conname like 'events\\_%\\_localized\\_list'
union all
select 'uniq|'       || coalesce((
    select string_agg(a.attname, ',' order by k.ord)
      from pg_constraint c
      cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
     where c.conrelid = to_regclass('public.event_blocks') and c.contype = 'u'
  ), '(沒有唯一約束)')
`;

async function psql(text) {
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

if (!PG_URL) {
  skipped.push("[8] 連線段（缺 EVENT_BLOCKS_SELFTEST_PG_URL）");
  console.log(yellow("  跳過：沒有 EVENT_BLOCKS_SELFTEST_PG_URL"));
  console.log(yellow("  設好之後重跑，才會驗到形狀不對的清單真的回 23514、同一個"));
  console.log(yellow("  (event_id, kind, sort_order) 真的回 23505、重排之後 id 沒變、"));
  console.log(yellow("  以及 anon 讀不到草稿活動的段落。指令見本檔檔頭。"));
} else {
  let r = null;
  try {
    // ── 前置條件：這個庫**必須已經套過 0027**。找不到就紅，不是 skip，也不是
    //    「那我幫你套一下」——後者正是這個 repo 出過的假陽性：測試自己先把要驗的
    //    東西建好，於是從 migration 裡刪掉它也照樣綠。
    const pre = await psql(PRECONDITION_SQL);
    checkTrue(
      "這個庫已經套過 0027：public.event_blocks 在",
      pre.table === "true",
      JSON.stringify(pre),
    );
    checkTrue("public.is_localized_list(jsonb) 在", pre.fn_islist === "true");
    checkTrue(
      "public.admin_reorder_event_blocks(text,text,bigint[]) 在",
      pre.fn_reorder === "true",
    );
    check("events 上七個清單欄位都在", pre.cols, "7");
    check("events 上七條 CHECK 都在", pre.checks, "7");
    check("唯一約束就是 (event_id, kind, sort_order)", pre.uniq, "event_id,kind,sort_order");

    // 前置條件沒過就不要再跑行為探針 —— 那只會噴一個看不懂的 SQL 錯誤，把「這個庫
    // 沒套過 0027」這個真正的答案埋掉。
    if (pre.table !== "true") {
      fail += 1;
      console.log(red("  ✗ 這個庫沒有 public.event_blocks —— 行為探針不跑"));
      console.log(red("      這一支**不會**幫你套 migration（那樣連 0027 被刪光都照樣綠）。"));
      console.log(
        red(
          "      先跑：psql -d <db> -v ON_ERROR_STOP=1 -f supabase/migrations/0027_event_blocks.sql",
        ),
      );
    } else {
      r = await psql(PROBE_SQL);
    }
  } catch (err) {
    fail += 1;
    console.log(red("  ✗ 連線測試跑不起來"));
    console.log(red(`      ${String(err.stderr ?? err.message ?? err).slice(0, 800)}`));
  }

  if (r) {
    console.log("  ── CHECK：清單欄位的形狀 ──");
    check('🔴 {"zh":"x"}（字串不是陣列）→ 23514', r.check_zh_is_string, "23514");
    check(
      '{"zh":"x","en":[],"ja":[]}（三個 key 都在，但 zh 是字串）→ 23514',
      r.check_zh_is_string_full,
      "23514",
    );
    // 🔴 三個語言各缺一次。少的那一個 key 會讓 jsonb_typeof() 回 SQL NULL，而 CHECK
    //    把 NULL 當成通過 —— 少一個 coalesce 就會有一個語言完全沒有防守，而且只有
    //    「剛好缺那一個」的資料看得出來。三條都要有，缺一條就會有一個 coalesce 沒被驗到。
    check('{"en":[],"ja":[]}（缺 zh）→ 23514', r.check_missing_zh, "23514");
    check('{"zh":[],"ja":[]}（缺 en）→ 23514', r.check_missing_en, "23514");
    check('{"zh":[],"en":[]}（缺 ja）→ 23514', r.check_missing_ja, "23514");
    check('{"zh":[1],…}（元素不是字串）→ 23514', r.check_element_is_number, "23514");
    check('{"zh":null,…}（JSON null）→ 23514', r.check_zh_is_json_null, "23514");
    check("三個空陣列 → 過（空清單＝這一塊關掉，不是錯誤）", r.check_valid_empty, "00000");
    check("三個都填 → 過", r.check_valid_filled, "00000");

    console.log("  ── 唯一性與 kind ──");
    check("🔴 同一組 (event_id, kind, sort_order) → 23505", r.dup_sort_order, "23505");
    check("kind='pricing' → 23514（不承認這一種）", r.kind_pricing, "23514");
    check("kind='feature' → 23514（不承認這一種）", r.kind_feature, "23514");
    check("body = null → 23502（not null，不能用留白當刪除）", r.body_null, "23502");

    console.log("  ── 重排 ──");
    checkTrue("重排前有三列", (r.before_ids ?? "").split(",").length === 3, r.before_ids);
    check(
      "🔴 [1,2,3] → [3,2,1] 之後 id 全不變（是換順序，不是刪掉重建）",
      r.after_ids,
      (r.before_ids ?? "").split(",").reverse().join(","),
    );
    check("重排後 sort_order 依 id 排是 3,2,1", r.after_orders, "3,2,1");
    check(
      "重排後沒有任何一列停在負數",
      (r.after_orders ?? "").split(",").every((n) => Number(n) > 0),
      true,
    );

    console.log("  ── RLS ──");
    check("🔴 anon 讀「未發布活動」的段落 → 0 列", r.anon_draft_rows, "0");
    check(
      "（對照組）anon 讀已發布活動的段落 → 3 列（證明上一條不是因為 anon 什麼都讀不到）",
      r.anon_pub_rows,
      "3",
    );
    check("anon 寫入 event_blocks → 42501", r.anon_insert, "42501");
    check("anon 呼叫 admin_reorder_event_blocks → 42501", r.anon_reorder, "42501");
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
