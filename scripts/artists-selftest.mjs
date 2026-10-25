#!/usr/bin/env node
/**
 * artists-selftest.mjs —— 講者後台（public.artists）與活動掛講者（0025）的自檢
 *
 * 分兩段，理由與 event-registration-selftest / blackcat-selftest 相同：這支測試在
 * 沒有資料庫的機器上也必須有意義。
 *
 *   [靜態] 讀 supabase/migrations/0025 與幾支 .ts / .tsx 的**原始碼字串**來斷言，
 *          守的是這一期的三個設計不變量。**沒有資料庫也一定會跑。**
 *
 *            1. events.speaker_id 的外鍵是 `on delete set null`，不是 cascade。
 *               cascade 的意思是「刪一位講者連帶刪掉他講過的每一場活動」——
 *               而那些活動底下掛著報名名單（0020）與訂單（0005）。
 *            2. vendor_id 沒有出現在講者後台的任何一條可編輯路徑上。那一欄指到
 *               inv.vendors（身分證字號、匯款帳號），與門面資料是兩個不同的授權
 *               決定，不是同一頁的兩個欄位。
 *            3. bio / long_bio / discipline 沒有被丟進 localizedSchema、
 *               <LocalizedField> 或任何三語 helper。它們在資料庫裡是 `text`，
 *               不是 jsonb —— 套三語進去會在型別上勉強過關、在畫面上悄悄壞掉。
 *
 *   [連線] 對一個真的本機 PostgreSQL 驗**行為**，不是驗字串：刪掉一位講者之後
 *          活動還在不在、speaker_id 有沒有變 NULL、slug 撞號回不回 23505、
 *          0025 能不能重複套用。
 *
 * ⚠️ **這支測試永遠不碰正式庫。** 它只認 ARTISTS_SELFTEST_PG_URL，而那個變數要
 *    自己設；沒設就整段 skip（會印出來，不會靜悄悄消失）。
 *
 * 準備一個可以跑的本機庫（PostgreSQL 14+ 即可）：
 *
 *     createdb ib_p4_test
 *     ARTISTS_SELFTEST_PG_URL=postgres:///ib_p4_test \
 *     ARTISTS_SELFTEST_APPLY=1 node scripts/artists-selftest.mjs
 *
 * `ARTISTS_SELFTEST_APPLY=1` 會先把 0001–0025 套上去（0008 需要 pg_net / vault /
 * pg_cron，本機沒有，會被跳過）。套過一次之後就不用再帶這個變數。
 *
 * 環境變數：
 *   ARTISTS_SELFTEST_PG_URL   本機測試庫的連線字串（[連線] 段的開關）
 *   ARTISTS_SELFTEST_APPLY    設成 1 時先套用 0001–0025
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/artists-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 event-registration-selftest 同一套）
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

/** 把 `--` 註解整行拿掉，免得註解裡提到的字串讓 includes() 假性通過。 */
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/**
 * 拿掉 TypeScript／TSX 的註解（`//`、`/* … *\/`、以及 JSX 的 `{/* … *\/}`）。
 *
 * ⚠️ 這一步是這整支測試的前提。這個 repo 的檔頭特別長，而底下每一條「不可以
 *    出現 X」的斷言都是在找字串 —— 沒有這一步，**檔頭裡寫著「不要用
 *    LocalizedField」這句話本身**就會讓「不可以出現 LocalizedField」那一條紅掉。
 *    同 event-registration-selftest 的 stripTs()。
 */
function stripTs(src) {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/**
 * 切出一個 zod schema 的本體：從 `export const <名字> = z.object({` 切到它自己的
 * `export type`。用意是讓「artistSchema 裡沒有 vendor_id」這種斷言只看那一段，
 * 不會被同一個檔案裡別的 schema 影響。
 */
function schemaBlock(src, name) {
  const start = src.indexOf(`export const ${name} = z.object(`);
  if (start === -1) return "";
  const end = src.indexOf("export type", start);
  return src.slice(start, end === -1 ? src.length : end);
}

/** 切出一個 TS type 宣告的本體。 */
function typeBlock(src, name) {
  const start = src.indexOf(`export type ${name} = {`);
  if (start === -1) return "";
  const end = src.indexOf("\n};", start);
  return src.slice(start, end === -1 ? src.length : end);
}

/**
 * 切出一個 <FormField name="…"> 的區塊。
 *
 * 用途是「speaker_id 這一欄是下拉不是自由輸入」這種斷言 —— 它要看的是**那一個
 * 欄位**裡有沒有 <Input>，而不是整個檔案裡有沒有 <Input>（整個檔案當然有）。
 */
function formFieldBlock(src, fieldName) {
  const chunks = src.split("<FormField");
  return chunks.find((c) => c.includes(`name="${fieldName}"`)) ?? "";
}

/** 切出 upsert 送給 PostgREST 的那個 payload 物件字面值。 */
function upsertPayload(src) {
  const start = src.indexOf(".upsert(");
  if (start === -1) return "";
  const end = src.indexOf('{ onConflict: "id" }', start);
  return src.slice(start, end === -1 ? src.length : end);
}

// =============================================================================
// [1] migration 檔案盤點
// =============================================================================
console.log("\n[1] migration 檔案盤點");

const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const MIG_0025_NAME = "0025_event_speaker.sql";
checkTrue(`${MIG_0025_NAME} 存在`, migrations.includes(MIG_0025_NAME));

/** 檔名前四碼的編號。 */
const migNumber = (f) => Number(f.slice(0, 4));

/**
 * 這裡原本是 `check("0025 是目前編號最大的一支", …)`。那是一條**快照**斷言：它只在
 * 0025 剛好是最新的那一段時間有意義，下一支 migration 一進來就必須有人手動改它，
 * 而「手動改一條斷言讓它變綠」與「這條斷言其實已經不在守任何東西」在畫面上長得
 * 一模一樣。
 *
 * 換成一條不會隨時間失效的結構斷言：編號從 0001 起連續、不重複。它抓得到兩個真的
 * 會發生的事故 —— 兩個人同時開了兩支 0026，以及跳號（0027 直接接在 0025 後面，
 * 中間那支被誰刪了）。
 *
 * 「目前最大的一支是哪一個」這條快照沒有被丟掉，它搬到了每一期自己的自檢裡
 * （現在是 scripts/event-product-selftest.mjs 的 [1]）—— 那裡本來就會隨那一期
 * 一起更新。
 */
const migNumbers = migrations.map(migNumber);
check(
  "migration 編號從 0001 起連續、不重複",
  migNumbers.join(",") || "（無）",
  migNumbers.map((_, i) => i + 1).join(",") || "（無）",
);

const sql0025raw = readFile(join(MIG_DIR, MIG_0025_NAME));
const sql0025 = stripSqlComments(sql0025raw);
checkTrue("0025 不是空檔", sql0025.trim().length > 0);

/**
 * 「加欄位要開新 migration，不可以回頭改已套用的那幾支」是這個 repo 的規約。
 * 直接驗它：0025 **之前**的每一支都不准提到 speaker_id。有任何一支提到，就代表
 * 有人回頭改了舊檔。
 *
 * ⚠️ 條件是「編號 < 25」，不是「不等於 0025」。後者會把 0026 之後每一支合法提到
 *    speaker_id 的新 migration 都算成違規（0026 的 upsert 函式就要寫這一欄），
 *    於是這條斷言會在每一期被「順手改掉」——而它真正要守的是往回改，不是往前寫。
 */
const oldMigrationsMentioningSpeaker = migrations
  .filter((f) => migNumber(f) < 25)
  .filter((f) => readFile(join(MIG_DIR, f)).includes("speaker_id"));
check(
  "0001–0024 沒有任何一支提到 speaker_id（＝沒有回頭改舊 migration）",
  oldMigrationsMentioningSpeaker.join(",") || "（無）",
  "（無）",
);

// =============================================================================
// [2] 🔴 外鍵是 set null，不是 cascade
// =============================================================================
console.log("\n[2] events.speaker_id 的外鍵行為");

checkTrue(
  "0025 有加 public.events.speaker_id 這一欄",
  /alter\s+table\s+public\.events\s+add\s+column\s+if\s+not\s+exists\s+speaker_id\s+text/i.test(
    sql0025,
  ),
);
checkTrue(
  "外鍵指到 public.artists (id)",
  /references\s+public\.artists\s*\(\s*id\s*\)/i.test(sql0025),
);
/**
 * 只看 `add constraint events_speaker_id_fkey … ;` 那一句本身。
 *
 * ⚠️ 不能對整個檔案找 "on delete set null" —— 底下的 `comment on column … is '…'`
 *    字串裡也寫著這句話，而字串不是 `--` 註解、strip 不掉。那樣的話把真正的外鍵
 *    改成 cascade，這一條還是會綠。（這不是假想：第一版就是這樣寫的，是突變測試
 *    把它抓出來的。）
 */
const fkClause = (() => {
  const start = sql0025.indexOf("add constraint events_speaker_id_fkey");
  if (start === -1) return "";
  const end = sql0025.indexOf(";", start);
  return sql0025.slice(start, end === -1 ? sql0025.length : end);
})();
checkTrue("切得出 events_speaker_id_fkey 那一句", fkClause.length > 0);
checkTrue("🔴 外鍵那一句本身寫的是 on delete set null", /on\s+delete\s+set\s+null/i.test(fkClause));
check("🔴 外鍵那一句本身沒有 cascade", /cascade/i.test(fkClause), false);

// 這一條是這一期最重要的一條。cascade 的意思是「刪一位講者連帶刪掉他講過的
// 每一場活動」，而那些活動底下掛著 event_registrations（0020）與 orders（0005）。
check("0025 全檔沒有出現 on delete cascade", /on\s+delete\s+cascade/i.test(sql0025), false);
checkTrue(
  "外鍵有具名（events_speaker_id_fkey），才能被查詢與被這支測試驗到",
  sql0025.includes("events_speaker_id_fkey"),
);

// =============================================================================
// [3] 刻意不做 join 表 + 冪等
// =============================================================================
console.log("\n[3] 0025 的形狀：不建新表、可重複執行");

check("0025 沒有 create table（＝沒有偷偷長出 join 表）", /create\s+table/i.test(sql0025), false);
check("0025 沒有 drop table", /drop\s+table/i.test(sql0025), false);
check("0025 沒有 drop column", /drop\s+column/i.test(sql0025), false);

checkTrue("欄位用 add column if not exists", /add\s+column\s+if\s+not\s+exists/i.test(sql0025));
checkTrue("索引用 create index if not exists", /create\s+index\s+if\s+not\s+exists/i.test(sql0025));
checkTrue(
  "外鍵拆成獨立的 do $$ + pg_constraint 判斷（不寫在 add column 裡）",
  /pg_constraint/i.test(sql0025) && /do\s+\$\$/i.test(sql0025),
);
// add column if not exists 在欄位已存在時會把整段跳過，連帶跳過寫在裡面的
// references。上一次只跑到一半（欄位建了、約束沒建）的話，重跑會安靜地維持那個
// 殘缺狀態 —— 所以外鍵一定要獨立。
check(
  "references 沒有寫在 add column 那一句裡",
  /add\s+column\s+if\s+not\s+exists\s+speaker_id[^;]*references/i.test(sql0025),
  false,
);
checkTrue(
  "包在 begin; / commit; 裡",
  /^\s*begin;/im.test(sql0025) && /^\s*commit;/im.test(sql0025),
);
checkTrue(
  "有 comment on column",
  /comment\s+on\s+column\s+public\.events\.speaker_id/i.test(sql0025),
);

// =============================================================================
// [4] 🔴 vendor_id 不在講者後台的任何一條可編輯路徑上
// =============================================================================
console.log("\n[4] vendor_id 是唯讀的");

const schemasSrc = stripTs(readFile(join(ROOT, "src/lib/admin/schemas.ts")));
const artistSchemaSrc = schemaBlock(schemasSrc, "artistSchema");
const repoSrcRaw = readFile(join(ROOT, "src/server/repos/artists.ts"));
const repoSrc = stripTs(repoSrcRaw);
const fnsSrc = stripTs(readFile(join(ROOT, "src/lib/admin/fns/artists.ts")));
// 2026-10-26 第 3 批：新增／編輯從彈窗改成內頁，表單本體搬到 src/components/admin/ArtistForm.tsx。
// 「講者後台」＝列表＋表單兩個檔，下面每一條規矩兩邊都要守。
const routeSrcRaw =
  readFile(join(ROOT, "src/routes/admin/_shell.artists.tsx")) +
  "\n" +
  readFile(join(ROOT, "src/components/admin/ArtistForm.tsx"));
const routeSrc = stripTs(routeSrcRaw);

checkTrue("artistSchema 存在", artistSchemaSrc.length > 0);
check("artistSchema 沒有 vendor_id", artistSchemaSrc.includes("vendor_id"), false);

const upsertInputSrc = typeBlock(repoSrc, "ArtistUpsertInput");
checkTrue("ArtistUpsertInput 存在", upsertInputSrc.length > 0);
check("ArtistUpsertInput 沒有 vendor_id", upsertInputSrc.includes("vendor_id"), false);

const payloadSrc = upsertPayload(repoSrc);
checkTrue("upsertArtist 的 payload 切得出來", payloadSrc.length > 0);
check("upsertArtist 送出的 payload 沒有 vendor_id", payloadSrc.includes("vendor_id"), false);
// payload 少一個 key 不只是「不寫」，還順帶保住既有綁定：PostgREST 的 upsert 只
// 對 payload 出現過的欄位產生 on conflict do update set。
checkTrue(
  "upsertArtist 仍然寫得到 is_active / sort_order（＝不是整包都沒送）",
  payloadSrc.includes("is_active") && payloadSrc.includes("sort_order"),
);

check(
  "講者後台沒有 vendor_id 的 <FormField>",
  formFieldBlock(routeSrc, "vendor_id").length > 0,
  false,
);
check('講者後台沒有 name="vendor_id" 的輸入框', routeSrc.includes('name="vendor_id"'), false);
// 反過來也要驗：它**有**唯讀顯示。少了這一條，把整段刪掉也會通過上面每一條。
checkTrue("講者後台仍然唯讀顯示綁定狀態（讀 vendor_id 但不寫）", routeSrc.includes("vendor_id"));

// server fn 那一層：inputValidator 掛的是 artistSchema，所以就算有人直接
// POST /_serverFn/… 塞 vendor_id，zod 也會把它剝掉。
checkTrue(
  "upsertArtist 的 inputValidator 是 artistSchema",
  fnsSrc.includes("inputValidator(artistSchema)"),
);
check("artists 的 server fn 檔案裡沒有 vendor_id", fnsSrc.includes("vendor_id"), false);
checkTrue(
  "artists 的每一支 server fn 都掛 adminFnMiddleware",
  (fnsSrc.match(/createServerFn\(/g) ?? []).length ===
    (fnsSrc.match(/\.middleware\(\[adminFnMiddleware\]\)/g) ?? []).length,
);

// =============================================================================
// [5] 🔴 bio / long_bio / discipline 是單語，不可以碰三語 helper
// =============================================================================
console.log("\n[5] 單語欄位沒有被當成三語");

const SINGLE_LANG_FIELDS = ["bio", "long_bio", "discipline", "name", "name_en"];

for (const f of SINGLE_LANG_FIELDS) {
  // schema：欄位型別必須是 z.string()，絕不可以是 localizedSchema。
  const line = artistSchemaSrc.split("\n").find((l) => new RegExp(`^\\s*${f}\\s*:`).test(l));
  checkTrue(`artistSchema 有 ${f} 這一欄`, Boolean(line));
  check(`artistSchema.${f} 不是 localizedSchema`, (line ?? "").includes("localizedSchema"), false);
  checkTrue(`artistSchema.${f} 是 z.string()`, (line ?? "").includes("z.string()"));
}

check(
  "artistSchema 整段沒有出現 localizedSchema",
  artistSchemaSrc.includes("localizedSchema"),
  false,
);

// UI：整頁不可以 import 或使用 <LocalizedField>。那個元件讀寫的是 `${name}.zh`
// 這種路徑，套在字串欄位上會把 "王小明" 寫成 {zh: …} 塞進一個 text 欄位。
check("講者後台沒有 import LocalizedField", routeSrc.includes("LocalizedField"), false);
check("講者後台沒有用三語 helper loc(", /\bloc\(/.test(routeSrc), false);
check("講者後台沒有 EMPTY_LOCALIZED 這種三語預設值", routeSrc.includes("EMPTY_LOCALIZED"), false);

for (const f of ["bio", "long_bio", "discipline"]) {
  const block = formFieldBlock(routeSrc, f);
  checkTrue(`講者後台有 ${f} 的欄位`, block.length > 0);
  check(`${f} 沒有被包進 <LocalizedField>`, block.includes("LocalizedField"), false);
  check(`${f} 沒有 .zh / .en / .ja 這種三語路徑`, /\.(zh|en|ja)\b/.test(block), false);
}

// repo 的型別必須說出「這是字串」。寫成 Localized 就是這一整條防線的破口。
checkTrue(
  "repo 的 ArtistRow 把 bio 宣告成 string | null",
  /bio:\s*string\s*\|\s*null/.test(repoSrc),
);
checkTrue(
  "repo 的 ArtistRow 把 long_bio 宣告成 string | null",
  /long_bio:\s*string\s*\|\s*null/.test(repoSrc),
);
check(
  "repo 沒有 import Localized 型別",
  /import\s+type\s*\{\s*Localized\s*\}/.test(repoSrc),
  false,
);

// 自動翻譯：人名與單語 bio 都不該被機器翻譯。
check("講者後台沒有接自動翻譯", routeSrc.includes("translate"), false);

// UI 要**明講**哪些欄位不分語言 —— 型別擋得住程式碼寫錯，擋不住店家以為自己
// 填的是中文版。這一條驗的是那句話真的在畫面上。
checkTrue("講者後台有寫出「不分語言」的欄位說明", routeSrcRaw.includes("不分語言"));
checkTrue(
  "那句說明有講清楚三種語系會顯示同一份內容",
  /三種語系都會顯示同一份內容/.test(routeSrcRaw),
);

// =============================================================================
// [6] 活動後台：主講人是下拉，不是自由輸入
// =============================================================================
console.log("\n[6] 活動後台的主講人欄位");

/**
 * 活動後台的**整個**表面 —— 列表頁與活動頁組裝器的聯集。
 *
 * 🔴 **不寫死單一檔案路徑。** D3 把活動表單從 `_shell.events.tsx` 搬到
 *    `_shell.events.$id.tsx`；原本寫死前者的版本在那次搬家之後，肯定斷言會紅
 *    （「找不到 speaker_id 這一欄」），而**否定斷言會靜默轉綠**（「這一頁沒有
 *    直接寫 products 表」——因為它讀的檔案裡本來就什麼都沒有了）。後者正是這個
 *    repo 反覆出過的那種假陽性：覆蓋消失了，畫面上是綠的。
 *
 *    所以改成掃出 `src/routes/admin/` 底下所有 `_shell.events*.tsx`，要求**至少一個**
 *    （一個都沒有 = 活動後台不見了，那是要紅的），再對它們的聯集斷言。
 */
const ADMIN_DIR = join(ROOT, "src/routes/admin");
const adminEventsFiles = readdirSync(ADMIN_DIR)
  .filter((f) => /^_shell\.events(\..+)?\.tsx$/.test(f))
  .sort();
checkTrue(
  `活動後台至少有一個路由檔（實得 ${adminEventsFiles.length}：${adminEventsFiles.join("、")}）`,
  adminEventsFiles.length >= 1,
);
const eventsRouteSrc = adminEventsFiles
  .map((f) => stripTs(readFile(join(ADMIN_DIR, f))))
  .join("\n");
const speakerField = formFieldBlock(eventsRouteSrc, "speaker_id");

checkTrue("活動表單有 speaker_id 這一欄", speakerField.length > 0);
checkTrue("speaker_id 用 <Select>", speakerField.includes("<Select"));
checkTrue("speaker_id 的選項是 <SelectItem>", speakerField.includes("<SelectItem"));
// 自由輸入就是「同一位講者散成三種寫法」的起點，而且欄位是外鍵，打錯字直接 23503。
check("speaker_id 沒有 <Input>（＝不是自由輸入）", speakerField.includes("<Input"), false);
check("speaker_id 沒有 <Textarea>", speakerField.includes("<Textarea"), false);
checkTrue("選項來自 artists 清單", speakerField.includes("artists.map("));
checkTrue("活動後台的選項來源是 listArtistOptions", eventsRouteSrc.includes("listArtistOptions"));
checkTrue("可以留空（有「不指定」這個選項）", speakerField.includes("不指定"));

// Radix 的 SelectItem 不接受 value=""，所以「不指定」要用哨兵值再換回 null。
checkTrue("空值用哨兵值換回 null", /NO_SPEAKER\s*\?\s*null\s*:/.test(eventsRouteSrc));

// 選項排序與過濾：依 sort_order、只列 is_active，但要保留這一場目前掛著的那位。
const artistsRepoOptions = repoSrc.slice(
  repoSrc.indexOf("export async function listArtistOptions"),
);
checkTrue(
  "listArtistOptions 依 sort_order 排序",
  /order\("sort_order"/.test(artistsRepoOptions.slice(0, 800)),
);
checkTrue(
  "UI 只列 is_active 的講者（外加目前這一場掛著的那位）",
  /a\.is_active\s*\|\|\s*a\.id\s*===\s*current/.test(eventsRouteSrc),
);

// events repo 要真的把這一欄讀出來、寫回去。
const eventsRepoSrc = stripTs(readFile(join(ROOT, "src/server/repos/events.ts")));
checkTrue(
  "events repo 的 COLUMNS 有 speaker_id",
  /COLUMNS\s*=\s*[\s\S]{0,400}speaker_id/.test(eventsRepoSrc),
);
checkTrue(
  "events repo 的 EventRow 有 speaker_id",
  /speaker_id:\s*string\s*\|\s*null/.test(eventsRepoSrc),
);
/**
 * 空字串 -> NULL。
 *
 * ⚠️ 0026 這一期只改了「賦值」與「物件屬性」的差別（`payload.speaker_id = …`
 *    變成 `speaker_id: …`），因為那一期把 0025 的降級程式碼刪掉之後，payload 從
 *    「先建好再視情況補欄位」的可變物件變回一個物件字面值。
 *
 *    **強度沒有下降。** 欄位名、`input.speaker_id && input.speaker_id.trim()` 這個
 *    守衛、`.trim()` 之後的值、以及 `: null` 這個 else 分支，四樣一個字都沒少，
 *    也沒有加進任何 `[\s\S]*` 之類的通配。
 *
 *    而且從「有沒有」變成「有幾條」：0026 之後 events repo 有**兩條**寫入路徑
 *    （upsertEvent 與 upsertEventWithProduct），兩條都會把 speaker_id 送進資料庫，
 *    所以兩條都要把空字串寫成 NULL。漏掉任何一條，下面的計數就對不上。
 */
const emptySpeakerToNull =
  /speaker_id:\s*input\.speaker_id\s*&&\s*input\.speaker_id\.trim\(\)\s*\?\s*input\.speaker_id\.trim\(\)\s*:\s*null/g;
check(
  "events repo 把空字串寫回 NULL（空字串不是合法的 artists.id）—— 兩條寫入路徑都要有",
  (eventsRepoSrc.match(emptySpeakerToNull) ?? []).length,
  2,
);
checkTrue(
  "eventSchema 有 speaker_id",
  schemaBlock(schemasSrc, "eventSchema").includes("speaker_id"),
);

// =============================================================================
// [7] 側欄：講者放在「內容管理」，不是「進銷存」
// =============================================================================
console.log("\n[7] 側欄分組");

const shellSrc = stripTs(readFile(join(ROOT, "src/routes/admin/_shell.tsx")));
const navStart = shellSrc.indexOf("const NAV_GROUPS");
const navSrc =
  navStart === -1 ? "" : shellSrc.slice(navStart, shellSrc.indexOf("] as const;", navStart));

checkTrue("NAV_GROUPS 切得出來", navSrc.length > 0);
checkTrue("側欄有 /admin/artists 這一項", navSrc.includes('to: "/admin/artists"'));

/** 把 NAV_GROUPS 切成「label -> 該組的原始碼片段」。 */
function navGroupSlice(label) {
  const at = navSrc.indexOf(`label: "${label}"`);
  if (at === -1) return "";
  // 下一個 `label: "…"` 之前都算這一組（items 內的鍵是 `label:` 但值不同行，
  // 所以改用 group 專用的 `\n    label: "` 縮排來切）。
  const groupHeads = [...navSrc.matchAll(/\n {4}label: "/g)].map((m) => m.index);
  const start = groupHeads.filter((i) => i <= at).pop() ?? at;
  const end = groupHeads.find((i) => i > at) ?? navSrc.length;
  return navSrc.slice(start, end);
}

const cmsGroup = navGroupSlice("內容管理");
const invGroup = navGroupSlice("進銷存");
checkTrue("切得出「內容管理」那一組", cmsGroup.length > 0);
checkTrue("切得出「進銷存」那一組", invGroup.length > 0);
checkTrue("/admin/artists 在「內容管理」組裡", cmsGroup.includes('to: "/admin/artists"'));
check("/admin/artists 不在「進銷存」組裡", invGroup.includes('to: "/admin/artists"'), false);
// 講者是 CMS，不是店員每天用的東西 —— 不放行給 staff。
checkTrue(
  "/admin/artists 這一項是 staff: false",
  /to: "\/admin\/artists",[^}]*staff: false/.test(cmsGroup),
);

// =============================================================================
// [連線] 段
// =============================================================================

const PG_URL = process.env.ARTISTS_SELFTEST_PG_URL;

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

const A = "artistselftest-a";
const A2 = "artistselftest-b";
const E1 = "artistselftest-e1";
const E2 = "artistselftest-e2";
const CAT = "artistselftest-cat";

/** FK 安全的清理順序。開頭與結尾各跑一次。 */
const CLEANUP_SQL = `
delete from public.events   where id like 'artistselftest-%';
delete from public.artists  where id like 'artistselftest-%' or slug like 'artistselftest-%';
delete from public.event_categories where id like 'artistselftest-%';
`;

const L = (s) => `'{"zh":"${s}","en":"${s}","ja":"${s}"}'::jsonb`;

if (!PG_URL) {
  skipped.push("[連線] 段（缺 ARTISTS_SELFTEST_PG_URL）");
  console.log(yellow("\n[8–11] 連線測試 —— 跳過：沒有 ARTISTS_SELFTEST_PG_URL"));
  console.log(yellow("       設好之後重跑，才會驗到「刪講者不會刪活動、speaker_id 變 NULL」、"));
  console.log(yellow("       slug 撞號回 23505、掛不存在的講者回 23503，以及 0025 的冪等。"));
  console.log(yellow("       指令見本檔檔頭。"));
} else {
  console.log("\n[8] 連線測試 —— 對本機 PostgreSQL");
  try {
    if (process.env.ARTISTS_SELFTEST_APPLY === "1") {
      console.log("  套用 0001–0025（ARTISTS_SELFTEST_APPLY=1）");
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
      checkTrue("0001–0025 套用完成（0008 跳過）", true);
    }

    // 上一次若在中途中止，最後的清理不會跑到 —— 殘留的資料會讓這一次撞唯一鍵。
    await must(CLEANUP_SQL);

    // ---- 0025 冪等：再套一次不可以報錯 -----------------------------------
    console.log("\n[9] 0025 冪等");
    const again = await q(readFile(join(MIG_DIR, MIG_0025_NAME)));
    checkTrue("0025 可以重複套用（冪等）", again.ok, again.ok ? "" : again.error.slice(0, 300));

    // ---- schema 的事實 ----------------------------------------------------
    console.log("\n[10] schema 的事實");
    check(
      "public.events 真的有 speaker_id 這一欄",
      num(
        await must(`select count(*)::int n from information_schema.columns
                     where table_schema='public' and table_name='events'
                       and column_name='speaker_id'`),
      ),
      1,
    );
    check(
      "speaker_id 可以為 NULL",
      String(
        one(
          await must(`select is_nullable from information_schema.columns
                       where table_schema='public' and table_name='events'
                         and column_name='speaker_id'`),
        )?.is_nullable,
      ),
      "YES",
    );
    // 🔴 這一條是整支測試的核心。confdeltype：'n' = SET NULL，'c' = CASCADE，
    //    'a' = NO ACTION，'r' = RESTRICT。看到 'c' 就是這一期最嚴重的錯。
    check(
      "外鍵的刪除行為是 SET NULL（confdeltype='n'，不是 'c'=CASCADE）",
      String(
        one(
          await must(`select confdeltype from pg_constraint
                       where conrelid='public.events'::regclass
                         and conname='events_speaker_id_fkey'`),
        )?.confdeltype,
      ),
      "n",
    );
    check(
      "events_speaker_idx 這個索引存在",
      num(
        await must(`select count(*)::int n from pg_indexes
                     where schemaname='public' and tablename='events'
                       and indexname='events_speaker_idx'`),
      ),
      1,
    );

    // ---- 🔴 刪掉一位講者之後，活動還在，而且 speaker_id 變 NULL -----------
    console.log("\n[11] 刪講者不會刪活動");

    await must(`
      insert into public.event_categories (id, label, sort_order)
      values ('${CAT}', ${L("自檢分類")}, 999);
      insert into public.artists (id, slug, name, sort_order, is_active)
      values ('${A}', '${A}', '自檢講者A', 900, true),
             ('${A2}', '${A2}', '自檢講者B', 901, true);
      insert into public.events
        (id, title, summary, description, display_date, category, speaker_id,
         external_url, registration_type, payment_enabled, is_published, sort_order)
      values
        ('${E1}', ${L("自檢活動一")}, ${L("摘要")}, ${L("說明")}, '2026.01.01',
         '${CAT}', '${A}', 'https://example.com/1', 'external', false, false, 900),
        ('${E2}', ${L("自檢活動二")}, ${L("摘要")}, ${L("說明")}, '2026.01.02',
         '${CAT}', '${A2}', 'https://example.com/2', 'external', false, false, 901);
    `);

    check(
      "前置：兩場活動各自掛著一位講者",
      num(
        await must(
          `select count(*)::int n from public.events where id like 'artistselftest-%' and speaker_id is not null`,
        ),
      ),
      2,
    );

    const del = await q(`delete from public.artists where id='${A}'`);
    checkTrue("刪得掉那位講者", del.ok, del.ok ? "" : del.error.slice(0, 300));

    // 這一條若紅，代表外鍵被寫成 cascade —— 活動連同它的報名與訂單一起消失。
    check(
      "🔴 講者被刪之後，那場活動還在",
      num(await must(`select count(*)::int n from public.events where id='${E1}'`)),
      1,
    );
    check(
      "🔴 那場活動的 speaker_id 變成 NULL",
      one(await must(`select speaker_id from public.events where id='${E1}'`))?.speaker_id ?? null,
      null,
    );
    // 只影響那一位。另一場不該被波及。
    check(
      "另一場活動的講者沒有被波及",
      String(one(await must(`select speaker_id from public.events where id='${E2}'`))?.speaker_id),
      A2,
    );
    check(
      "活動的其他欄位沒有被動到",
      String(
        one(await must(`select display_date from public.events where id='${E1}'`))?.display_date,
      ),
      "2026.01.01",
    );

    // ---- slug 唯一 --------------------------------------------------------
    console.log("\n[12] artists.slug 的唯一性");
    const dupSlug = await q(
      `insert into public.artists (id, slug, name, sort_order, is_active)
       values ('${A}-dup', '${A2}', '撞號的講者', 902, true)`,
    );
    checkTrue(
      "slug 重複會被擋下，而且是 23505（唯一鍵違反）",
      !dupSlug.ok && /23505|duplicate key value/.test(dupSlug.error),
      dupSlug.ok ? "居然插進去了 —— slug 的唯一索引不見了" : dupSlug.error.slice(0, 200),
    );
    // 換一個 slug 就該成功 —— 上面那條擋的是 slug，不是「不准新增」。
    const okSlug = await q(
      `insert into public.artists (id, slug, name, sort_order, is_active)
       values ('${A}-dup', '${A}-dup', '不撞號的講者', 902, true)`,
    );
    checkTrue(
      "換一個不重複的 slug 就存得進去",
      okSlug.ok,
      okSlug.ok ? "" : okSlug.error.slice(0, 200),
    );

    // ---- 掛一個不存在的講者 ------------------------------------------------
    console.log("\n[13] speaker_id 只能是真的存在的講者");
    const badFk = await q(`update public.events set speaker_id='這個講者不存在' where id='${E1}'`);
    checkTrue(
      "掛不存在的講者會被擋下，而且是 23503（外鍵違反）",
      !badFk.ok && /23503|violates foreign key/.test(badFk.error),
      badFk.ok ? "居然更新成功了 —— 外鍵不見了" : badFk.error.slice(0, 200),
    );
    // 空字串同樣不是合法的 artists.id —— 這正是 repo 要把空字串寫成 NULL 的原因。
    const emptyFk = await q(`update public.events set speaker_id='' where id='${E1}'`);
    checkTrue(
      "空字串也不是合法的 speaker_id（所以 repo 要寫回 NULL）",
      !emptyFk.ok && /23503|violates foreign key/.test(emptyFk.error),
      emptyFk.ok ? "空字串居然存進去了" : emptyFk.error.slice(0, 200),
    );
    // 明確設成 NULL 則永遠合法（＝「不指定講者」）。
    const setNull = await q(`update public.events set speaker_id=null where id='${E1}'`);
    checkTrue("設成 NULL 一律合法（＝不指定講者）", setNull.ok);

    // ---- vendor_id 在資料庫層仍然是可為 NULL 的獨立欄位 --------------------
    console.log("\n[14] vendor_id 沒有被這一期動到");
    check(
      "artists.vendor_id 仍然存在且可為 NULL",
      String(
        one(
          await must(`select is_nullable from information_schema.columns
                       where table_schema='public' and table_name='artists'
                         and column_name='vendor_id'`),
        )?.is_nullable,
      ),
      "YES",
    );
    check(
      "剛才新增的講者 vendor_id 是 NULL（後台沒有寫這一欄）",
      num(
        await must(
          `select count(*)::int n from public.artists where id like 'artistselftest-%' and vendor_id is not null`,
        ),
      ),
      0,
    );
  } catch (err) {
    // 記成一條失敗再往下走，而不是讓例外殺掉整個行程 —— 直接炸掉的話收尾的
    // ##SELFTEST## 那一行印不出來，runner 只會說「沒有印出收尾行」。
    fail += 1;
    console.log(red(`  ✗ 連線測試中止：${err instanceof Error ? err.message : String(err)}`));
  } finally {
    console.log("\n[15] 清理");
    const cleanup = await q(CLEANUP_SQL);
    checkTrue("測試資料清乾淨", cleanup.ok, cleanup.ok ? "" : cleanup.error.slice(0, 300));
    check(
      "沒有殘留的 artists",
      num(
        await q(`select count(*)::int n from public.artists where id like 'artistselftest-%'`).then(
          (r) => r.rows,
        ),
      ),
      0,
    );
    check(
      "沒有殘留的 events",
      num(
        await q(`select count(*)::int n from public.events where id like 'artistselftest-%'`).then(
          (r) => r.rows,
        ),
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
