#!/usr/bin/env node
/**
 * localized-list-selftest.mjs —— 「一行一項」清單欄位（D2 期）的自檢
 *
 * 分三段，優先順序也是這個順序：
 *
 *   [執行] **直接 import src/lib/admin/localized-list.ts 與 schemas.ts 本人**，
 *          然後真的去呼叫 linesToList()／splitLines()／listToLines()、真的把資料
 *          丟進 localizedLinesFormSchema.safeParse()。手法照抄
 *          scripts/translate-selftest.mjs：用 node:module 的 registerHooks 補上
 *          Node 不會自己做的兩件事 —— 把 `@/…` 解析到 src/、把沒有副檔名的相對
 *          路徑補成 .ts。驗到的是產線真正跑的那一份，不是一份長得很像的複本。
 *
 *          需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15
 *          （module.registerHooks）。CI 用的是 24。
 *
 *   [對帳] 2000 這個數字寫在三個地方（localized-list.ts、schemas.ts 的
 *          translateSchema、src/server/translate.ts 的 MAX_INPUT_CHARS）。三個一起
 *          讀出來比，改一個沒改另外兩個就紅。
 *
 *   [原始碼] LocalizedListField.tsx 是 TSX，載不起來，只能讀原始碼比對。它要守的
 *          剛好也是「有沒有寫某一段」這種問題：失敗路徑到 return 之間有沒有偷偷
 *          setValue、有沒有行數比對、2000 字檢查是不是在打 API 之前。
 *
 *          ⚠️ 這一段的每一條都做過突變測試（把產線那一行改壞、確認斷言真的轉紅、
 *             再改回來）。上一期有一條原始碼斷言是假陽性 —— 它比對的是整個檔案，
 *             結果被字串**內容**餵飽，程式碼改壞了它照樣綠。所以這裡一律先把註解
 *             剝掉、再用位置切出一小段來比，不對整個檔案做 includes()。
 *
 * ⚠️ 這支測試不碰任何資料庫、不讀任何環境變數、不發任何網路請求。D2 期的產出就是
 *    純函式、schema、元件三樣，一行資料層都沒有 —— [4] 段會把這件事釘住。
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
} from "./lib/migration-ledger.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/localized-list-selftest.mjs";

const LOCALIZED_LIST = join(ROOT, "src/lib/admin/localized-list.ts");
const SCHEMAS = join(ROOT, "src/lib/admin/schemas.ts");
const LIST_FIELD = join(ROOT, "src/components/admin/LocalizedListField.tsx");
const SERVER_TRANSLATE = join(ROOT, "src/server/translate.ts");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 translate-selftest 同一套）
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

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

/** 拿掉 TypeScript／TSX 的註解。這個 repo 的檔頭特別長，少了這一步斷言會全紅。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * 呼叫一個**應該要丟 LocalizedListError** 的東西。
 *   · 沒丟          → { threw: false, returned: … }   ← slice() 靜默截斷長這樣
 *   · 丟了別的型別  → { threw: true, wrongType: true }
 *   · 丟對了        → { threw: true, kind, message }
 *
 * 「有丟東西」不等於「丟了對的東西」，所以型別要分開記。
 */
function catchListError(LocalizedListError, run) {
  try {
    const returned = run();
    return { threw: false, returned };
  } catch (err) {
    if (!(err instanceof LocalizedListError)) {
      return { threw: true, wrongType: true, message: String(err?.message ?? err) };
    }
    return { threw: true, wrongType: false, kind: err.kind, message: err.message };
  }
}

console.log("═══ 一行一項清單欄位自檢（D2）═══");

// =============================================================================
// [0] 載入 production 的模組本人
// =============================================================================
console.log("\n[0] 載入產線模組");

if (typeof registerHooks !== "function") {
  console.log(red("  ✗ 這個 Node 沒有 module.registerHooks（需要 ≥ 22.15）"));
  console.log(`##SELFTEST## file=${SELF} pass=0 fail=1`);
  process.exit(1);
}

// Node 不認得 tsconfig 的 `@/` alias，也不會把 `./x` 補成 `./x.ts`。補這兩條 resolve
// 之後，下面 import 到的就是**真的那一份**產線程式碼。
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

check("src/lib/admin/localized-list.ts 存在", existsSync(LOCALIZED_LIST), true);
check("src/components/admin/LocalizedListField.tsx 存在", existsSync(LIST_FIELD), true);

const mod = await import(pathToFileURL(LOCALIZED_LIST).href);
const {
  linesToList,
  listToLines,
  splitLines,
  LocalizedListError,
  LIST_MAX_ITEMS,
  LIST_MAX_ITEM_CHARS,
  TRANSLATE_MAX_CHARS,
} = mod;

check(
  "localized-list.ts 匯出四個函式／類別",
  [typeof linesToList, typeof listToLines, typeof splitLines, typeof LocalizedListError],
  ["function", "function", "function", "function"],
);
check("上限常數是數字", [typeof LIST_MAX_ITEMS, typeof LIST_MAX_ITEM_CHARS], ["number", "number"]);
check("LIST_MAX_ITEMS 是 40", LIST_MAX_ITEMS, 40);
check("LIST_MAX_ITEM_CHARS 是 200", LIST_MAX_ITEM_CHARS, 200);

// 零 import 是這個檔案的硬性條件：一旦出現 `@/…`，上面那個 await import 就要靠
// bundler 才跑得起來，這支測試就只剩「讀原始碼比對字串」可以做。
const listSrcRaw = readFile(LOCALIZED_LIST);
const listSrc = stripTs(listSrcRaw);
check(
  "localized-list.ts 一行 import 都沒有（自檢才載得起產線本人）",
  listSrc.split("\n").filter((l) => /^\s*import\s/.test(l)),
  [],
);

// =============================================================================
// [1] splitLines / linesToList：換行正規化與清洗
// =============================================================================
console.log("\n[1] 換行正規化");

// ⚠️ 這一條守的是 CRLF。Windows 記事本、Word、Google 文件複製過來的都是 \r\n，
//    少了正規化就會每一行結尾掛一個 \r；單獨的 \r（老 Mac）更慘，整篇擠成一項 ——
//    而且完全不報錯，只是安靜地變成一行超長的東西。
check("CRLF 與空行（題目指定的那一條）", linesToList("a\r\nb\r\n\r\nc"), ["a", "b", "c"]);
check("純 LF", linesToList("a\nb\nc"), ["a", "b", "c"]);
check("單獨的 \\r（老 Mac 換行）也切得開", linesToList("a\rb\rc"), ["a", "b", "c"]);
check("CRLF / LF / CR 混在一起", linesToList("a\r\nb\nc\rd"), ["a", "b", "c", "d"]);
check("每一行都 trim 過", linesToList("  a  \n\tb\t\n c "), ["a", "b", "c"]);
check(
  "行尾的 \\r 沒有殘留",
  linesToList("a\r\nb").map((s) => s.length),
  [1, 1],
);
check("中間的空行被濾掉", linesToList("a\n\n\n\nb"), ["a", "b"]);
check("只有空白的行也被濾掉", linesToList("a\n   \n\t\nb"), ["a", "b"]);
check("結尾多一個換行不會多出一項", linesToList("a\nb\n"), ["a", "b"]);
check("開頭多一個換行不會多出一項", linesToList("\na\nb"), ["a", "b"]);

console.log("\n[1b] 空輸入");
check("空字串 → []", linesToList(""), []);
check("只有空白 → []", linesToList("     "), []);
check("只有空行 → []", linesToList("\n\n\n"), []);
check("只有 CRLF 空行 → []", linesToList("\r\n\r\n"), []);
check("空白與空行混合 → []", linesToList("  \n\t\n \r\n  "), []);

console.log("\n[1c] splitLines 不丟錯（畫面要顯示得出超標的行數）");
// splitLines 存在的唯一理由：超過上限的當下，畫面還要顯示得出「你打了 45 行」。
// 如果數行數這件事會丟錯，那一刻畫面就只能顯示「壞了」。
const over = Array.from({ length: 45 }, (_, i) => `第 ${i + 1} 行`).join("\n");
check("45 行 → splitLines 回 45 個，不丟錯", splitLines(over).length, 45);
check("201 字單行 → splitLines 不丟錯", splitLines("x".repeat(201)).length, 1);
check(
  "splitLines 與 linesToList 在合法範圍內結果相同",
  splitLines("a\r\nb"),
  linesToList("a\r\nb"),
);

// =============================================================================
// [2] 上限：丟錯，不是靜默截斷
// =============================================================================
console.log("\n[2] 上限（🔴 不准 slice 靜默截斷）");

const exactly40 = Array.from({ length: 40 }, (_, i) => `亮點 ${i + 1}`).join("\n");
const fortyOne = Array.from({ length: 41 }, (_, i) => `亮點 ${i + 1}`).join("\n");

check("剛好 40 行 → 過，且回 40 個", linesToList(exactly40).length, 40);

const tooMany = catchListError(LocalizedListError, () => linesToList(fortyOne));
// ⚠️ 這一條是整支測試最重要的斷言。slice(0, 40) 的話 threw 會是 false、returned
//    會是 40 個元素 —— 那正是「店家填了 41 行、上線只有 40 行，沒有人發現」。
checkTrue(
  "41 行 → 真的 throw（不是回傳 40 個元素）",
  tooMany.threw,
  `實得 ${JSON.stringify(tooMany).slice(0, 200)}`,
);
check("41 行沒有被靜默截斷成 40 個", tooMany.returned, undefined);
checkTrue(
  "41 行丟的是 LocalizedListError（不是隨便一個 TypeError）",
  tooMany.threw && !tooMany.wrongType,
);
check("41 行的 kind 是 too_many_items", tooMany.kind, "too_many_items");
checkTrue("訊息說得出「共幾行」（41）", String(tooMany.message).includes("41"));
checkTrue("訊息說得出上限（40）", String(tooMany.message).includes("40"));

const way = catchListError(LocalizedListError, () =>
  linesToList(Array.from({ length: 400 }, (_, i) => `x${i}`).join("\n")),
);
checkTrue("400 行也是 throw", way.threw && !way.wrongType);
checkTrue("400 行的訊息說得出 400", String(way.message).includes("400"));

console.log("\n[2b] 單行字數上限");
check("剛好 200 字 → 過", linesToList("x".repeat(200)), ["x".repeat(200)]);
check(
  "剛好 200 字（前後有空白，trim 後剛好 200）→ 過",
  linesToList(`  ${"x".repeat(200)}  `).length,
  1,
);

const tooLong = catchListError(LocalizedListError, () => linesToList("x".repeat(201)));
checkTrue(
  "單行 201 字 → 真的 throw",
  tooLong.threw,
  `實得 ${JSON.stringify(tooLong).slice(0, 200)}`,
);
check("單行 201 字沒有被靜默截斷", tooLong.returned, undefined);
checkTrue("單行 201 字丟的是 LocalizedListError", tooLong.threw && !tooLong.wrongType);
check("單行 201 字的 kind 是 item_too_long", tooLong.kind, "item_too_long");

// 錯誤訊息要指得出是哪一行，否則 40 行的 textarea 裡「有一行太長」等於沒說。
const thirdLong = catchListError(LocalizedListError, () =>
  linesToList(`短\n短\n${"x".repeat(250)}\n短`),
);
checkTrue("第 3 行太長 → throw", thirdLong.threw && !thirdLong.wrongType);
checkTrue(
  "訊息指得出「第 3 行」",
  String(thirdLong.message).includes("第 3 行"),
  `實得：${thirdLong.message}`,
);
checkTrue(
  "訊息說得出「共 4 行」",
  String(thirdLong.message).includes("共 4 行"),
  `實得：${thirdLong.message}`,
);
checkTrue("訊息說得出實際字數 250", String(thirdLong.message).includes("250"));
checkTrue("訊息說得出上限 200", String(thirdLong.message).includes("200"));

// 行號是**清洗後**的行號 —— 使用者看到的清單就是清洗後那一份，用原始行號只會指錯。
const afterBlank = catchListError(LocalizedListError, () =>
  linesToList(`短\n\n\n${"x".repeat(201)}`),
);
checkTrue(
  "空行不算行號（清洗後的第 2 行，不是原始的第 4 行）",
  String(afterBlank.message).includes("第 2 行"),
  `實得：${afterBlank.message}`,
);

// 兩種都超標時先報項數 —— 先刪到 40 行，第二次才輪得到哪一行太長。
const both = catchListError(LocalizedListError, () =>
  linesToList([...Array.from({ length: 41 }, (_, i) => `x${i}`), "y".repeat(300)].join("\n")),
);
check("項數與字數同時超標 → 先報項數", both.kind, "too_many_items");

// =============================================================================
// [3] listToLines 與 round-trip
// =============================================================================
console.log("\n[3] listToLines 與 round-trip");

check("listToLines 用 \\n 接起來", listToLines(["a", "b", "c"]), "a\nb\nc");
check("空陣列 → 空字串", listToLines([]), "");
check("單一項目 → 沒有多餘換行", listToLines(["只有一項"]), "只有一項");
check("不會在結尾多一個換行", listToLines(["a", "b"]).endsWith("\n"), false);

for (const [label, normalised] of [
  ["一般三行", "a\nb\nc"],
  ["中文", "手作課程\n可自備材料\n現場備有工具"],
  ["單行", "只有一項"],
  ["空", ""],
  ["剛好 40 行", exactly40],
  ["單行剛好 200 字", "x".repeat(200)],
]) {
  check(`round-trip：${label}`, listToLines(linesToList(normalised)), normalised);
}

// 沒有正規化的輸入不保證等於自己（本來就不該保證），但**再跑一次一定穩定**。
const messy = "  a  \r\n\r\n b \r\n";
const once = listToLines(linesToList(messy));
check("未正規化的輸入：第一次清洗結果", once, "a\nb");
check("清洗過的結果再跑一次不會再變（冪等）", listToLines(linesToList(once)), once);

// =============================================================================
// [4] 這一期不准碰資料層
// =============================================================================
console.log("\n[4] D2 的三個產出都不碰資料層");

const fieldSrcRaw = readFile(LIST_FIELD);
const fieldSrc = stripTs(fieldSrcRaw);

for (const [label, src] of [
  ["localized-list.ts", listSrc],
  ["LocalizedListField.tsx", fieldSrc],
]) {
  checkTrue(`${label} 沒有 import supabase`, !/supabase/i.test(src));
  checkTrue(`${label} 沒有碰 repos/`, !/@\/server\/repos/.test(src));
  checkTrue(`${label} 沒有出現 .select(`, !/\.select\(/.test(src));
  checkTrue(`${label} 沒有出現 .insert(／.update(`, !/\.(insert|update|upsert)\(/.test(src));
}
// 元件唯一准打的後端是翻譯那一支 server fn（既有的，D1 就有了）。
const fnImports = [...fieldSrc.matchAll(/await import\(\s*"([^"]+)"/g)].map((m) => m[1]);
check("元件只動態 import 翻譯那一支 server fn", fnImports, ["@/lib/admin/fns/translate"]);

// =============================================================================
// [5] 2000 這個數字的三處對帳
// =============================================================================
console.log("\n[5] 2000 字上限的三處對帳");

const schemasSrcRaw = readFile(SCHEMAS);
const schemasSrc = stripTs(schemasSrcRaw);
const translateSrc = stripTs(readFile(SERVER_TRANSLATE));

check("localized-list.ts 的 TRANSLATE_MAX_CHARS 是 2000", TRANSLATE_MAX_CHARS, 2000);
const schemaMax = /translateSchema[\s\S]*?\.max\((\d+),/.exec(schemasSrc)?.[1];
const serverMax = /const MAX_INPUT_CHARS = (\d+);/.exec(translateSrc)?.[1];
check("schemas.ts 的 translateSchema .max() 讀得到", typeof schemaMax, "string");
check("translate.ts 的 MAX_INPUT_CHARS 讀得到", typeof serverMax, "string");
check(
  "三個地方是同一個數字",
  [TRANSLATE_MAX_CHARS, Number(schemaMax), Number(serverMax)],
  [2000, 2000, 2000],
  "改一個沒改另外兩個，前端會擋在 2000、server fn 擋在別的數字，或反過來悄悄截斷。",
);

// =============================================================================
// [6] zod：表單端與送出端明著配對
// =============================================================================
console.log("\n[6] zod schema（真的跑 safeParse，不是比對原始碼）");

const schemas = await import(pathToFileURL(SCHEMAS).href);
const { localizedLinesFormSchema, localizedListSchema } = schemas;

check(
  "兩支都匯出了",
  [typeof localizedLinesFormSchema, typeof localizedListSchema],
  ["object", "object"],
);

const okForm = { zh: "亮點一\n亮點二", en: "One\nTwo", ja: "一つ\n二つ" };
checkTrue("表單端：正常三語 → 過", localizedLinesFormSchema.safeParse(okForm).success);
checkTrue(
  "表單端：CRLF 也過（正規化在 splitLines 裡，不是靠使用者）",
  localizedLinesFormSchema.safeParse({ zh: "a\r\nb", en: "a\r\nb", ja: "a\r\nb" }).success,
);
checkTrue(
  "表單端：中文空白 → 不過",
  !localizedLinesFormSchema.safeParse({ ...okForm, zh: "   \n\n" }).success,
);
checkTrue(
  "表單端：英文整個空 → 不過（三語都要）",
  !localizedLinesFormSchema.safeParse({ ...okForm, en: "" }).success,
);
checkTrue(
  "表單端：41 行 → 不過",
  !localizedLinesFormSchema.safeParse({ ...okForm, zh: fortyOne }).success,
);
checkTrue(
  "表單端：剛好 40 行 → 過",
  localizedLinesFormSchema.safeParse({ ...okForm, zh: exactly40 }).success,
);
checkTrue(
  "表單端：單行 201 字 → 不過",
  !localizedLinesFormSchema.safeParse({ ...okForm, zh: "x".repeat(201) }).success,
);
const issue41 = localizedLinesFormSchema.safeParse({ ...okForm, zh: fortyOne });
checkTrue(
  "表單端：41 行的錯誤訊息說得出 41",
  !issue41.success && issue41.error.issues.some((i) => i.message.includes("41")),
);
checkTrue(
  "表單端：值型別是原始字串，不是陣列（送出前才換）",
  typeof localizedLinesFormSchema.safeParse(okForm).data?.zh === "string",
);

console.log("\n[6b] 送出端");
const okList = { zh: ["亮點一", "亮點二"], en: ["One", "Two"], ja: ["一つ", "二つ"] };
checkTrue("送出端：正常三語 string[] → 過", localizedListSchema.safeParse(okList).success);
checkTrue("送出端：吃的是陣列，字串不過", !localizedListSchema.safeParse(okForm).success);
checkTrue("送出端：空陣列 → 不過", !localizedListSchema.safeParse({ ...okList, zh: [] }).success);
checkTrue(
  "送出端：陣列裡有空字串 → 不過（jsonb 存得進去、前台會渲染出一塊空白）",
  !localizedListSchema.safeParse({ ...okList, zh: ["亮點一", "  "] }).success,
);
checkTrue(
  "送出端：41 項 → 不過",
  !localizedListSchema.safeParse({ ...okList, zh: Array.from({ length: 41 }, (_, i) => `x${i}`) })
    .success,
);
checkTrue(
  "送出端：剛好 40 項 → 過",
  localizedListSchema.safeParse({ ...okList, zh: Array.from({ length: 40 }, (_, i) => `x${i}`) })
    .success,
);
checkTrue(
  "送出端：單項 201 字 → 不過",
  !localizedListSchema.safeParse({ ...okList, zh: ["x".repeat(201)] }).success,
);

// 兩支必須真的是配對：表單端過得了的東西，經過 linesToList 之後送出端也要過得了。
const bridged = {
  zh: linesToList(okForm.zh),
  en: linesToList(okForm.en),
  ja: linesToList(okForm.ja),
};
checkTrue(
  "配對成立：表單端 → linesToList → 送出端，一路過得去",
  localizedLinesFormSchema.safeParse(okForm).success &&
    localizedListSchema.safeParse(bridged).success,
);

// =============================================================================
// [7] LocalizedListField.tsx 原始碼比對
// =============================================================================
// ⚠️ 這一段全部是「切一小段出來比」，不對整個檔案 includes()。上一期的假陽性就是
//    對整個檔案比對，結果被字串**內容**餵飽。每一條都做過突變測試。
console.log("\n[7] LocalizedListField.tsx");

checkTrue(
  "是 LocalizedField 的兄弟，不是改造它",
  existsSync(join(ROOT, "src/components/admin/LocalizedField.tsx")),
);
checkTrue(
  "沒有去動 LocalizedField（沒有 import 它、沒有包裝它）",
  !fieldSrc.includes("LocalizedField"),
  "要求是做成兄弟，不是加一個 prop 開關去改造既有元件。",
);
checkTrue("用 useFormContext（與兄弟同一個約定）", fieldSrc.includes("useFormContext()"));
checkTrue("有「自動翻譯」按鈕", fieldSrcRaw.includes("自動翻譯"));
checkTrue("翻譯中會 disable 按鈕", fieldSrc.includes("disabled={translating"));
checkTrue(
  "元件裡沒有出現任何 Gemini 端點",
  !/generativelanguage\.googleapis\.com/.test(fieldSrcRaw),
);

// ── 7a：中文框即時顯示行數 ──────────────────────────────────────────────────
console.log("\n[7a] 即時行數");
checkTrue("有算中文行數", fieldSrc.includes("const zhLines = splitLines("));

// ⚠️ 這裡刻意**切出中文框那一段**才比對，不對整個檔案 test()。行數不一致的警告那
//    一行也寫著 {zhLines.length}，對整個檔案比對的話，就算把中文框底下的即時行數
//    整個拿掉，斷言照樣綠 —— 突變測試 M11 抓到的正是這一條。
const zhFieldStart = fieldSrcRaw.indexOf("name={`${name}.zh`}");
const collapsibleStart = fieldSrcRaw.indexOf("<Collapsible", zhFieldStart);
checkTrue("找得到中文框那一段 JSX", zhFieldStart > 0 && collapsibleStart > zhFieldStart);
const zhBlock = fieldSrcRaw.slice(zhFieldStart, collapsibleStart);
checkTrue(
  "中文框底下就印著即時行數（不是只算不顯示、也不是只在別處顯示）",
  /\{zhLines\.length\}\s*行/.test(zhBlock),
  "算了但沒顯示在中文框旁邊等於沒做 —— 那是編輯時唯一重要的數字。",
);
checkTrue("中文框底下也印得出總字數", /\{zhChars\}/.test(zhBlock));
checkTrue("超過上限時走的是警示樣式", /overItems[\s\S]{0,120}text-destructive/.test(zhBlock));
checkTrue("超過項數上限時當場說「系統不會替你截斷」", /overItems[\s\S]{0,200}截斷/.test(zhBlock));
checkTrue(
  "數行數用的是不會丟錯的 splitLines（超標時畫面還要顯示得出 45 行）",
  !/const zhLines = linesToList\(/.test(fieldSrc),
);

// ── 7b：打 API 之前先量 2000 字 ────────────────────────────────────────────
console.log("\n[7b] 2000 字檢查在打 API 之前");

const fnStart = fieldSrc.indexOf("async function handleAutoTranslate");
const guardEnd = fieldSrc.indexOf("setTranslating(true)", fnStart);
const apiCall = fieldSrc.indexOf("await import(", fnStart);
checkTrue("找得到 handleAutoTranslate", fnStart >= 0);
checkTrue("找得到 setTranslating(true)", guardEnd > fnStart);
checkTrue("找得到動態 import 那一行", apiCall > fnStart);

// pre-flight = 函式開頭 → setTranslating(true)。2000 字檢查必須落在這一段裡。
const preflight = fieldSrc.slice(fnStart, guardEnd);
checkTrue(
  "2000 字上限的檢查在 pre-flight 段裡（打 API 之前）",
  preflight.includes("TRANSLATE_MAX_CHARS"),
  "檢查寫在 API 回來之後等於沒有先量 —— 額度已經燒掉了。",
);
checkTrue(
  "2000 字檢查真的是一個比較，不是只提到常數",
  /payload\.length > TRANSLATE_MAX_CHARS/.test(preflight),
);
checkTrue(
  "超過 2000 字就 return（不是只跳 toast 然後照送）",
  /TRANSLATE_MAX_CHARS[\s\S]{0,400}?return;/.test(preflight),
);
checkTrue(
  "超過 2000 字有跟人說明",
  /TRANSLATE_MAX_CHARS[\s\S]{0,200}?toast\.error/.test(preflight),
);
checkTrue("2000 這個數字沒有在元件裡重打一次", !/\b2000\b/.test(fieldSrc));
checkTrue("pre-flight 也擋行數上限", preflight.includes("LIST_MAX_ITEMS"));
checkTrue("pre-flight 也擋單行字數上限", preflight.includes("LIST_MAX_ITEM_CHARS"));
checkTrue(
  "中文是空的就不打 API",
  /source\.length === 0[\s\S]{0,120}toast\.warning/.test(preflight),
);

// ── 7c：失敗路徑不准 setValue ──────────────────────────────────────────────
console.log("\n[7c] 翻譯失敗什麼都不寫");

// 🔴 切法刻意是「從 if (!result.ok) { 到**它後面第一個** return;」——
//    這正好是題目說的「失敗路徑到 return 之間」。附帶好處：如果那個 return 被拿掉，
//    這一段就會一路吃到後面真正的 setValue，斷言照樣轉紅。
const FAIL_HEAD = "if (!result.ok) {";
const failStart = fieldSrc.indexOf(FAIL_HEAD);
const failReturn = fieldSrc.indexOf("return;", failStart);
checkTrue("找得到 ok:false 的失敗分支", failStart > 0);
checkTrue("失敗分支後面找得到 return;", failReturn > failStart);
const failureBranch = fieldSrc.slice(failStart, failReturn + "return;".length);
checkTrue("失敗分支有跳 toast", failureBranch.includes("toast.error"));
checkTrue(
  "🔴 失敗路徑到 return 之間沒有任何 setValue",
  !failureBranch.includes("setValue"),
  "維持空白比寫進半套翻譯好 —— 空白擋得住儲存，而且看得見。",
);
checkTrue(
  "失敗分支短小（沒有夾帶其他邏輯）",
  failureBranch.length < 200,
  `實得 ${failureBranch.length} 字：${failureBranch.slice(0, 200)}`,
);
checkTrue(
  "有 catch 接授權／設定錯誤，不留 unhandled rejection",
  /catch \(err\)[\s\S]{0,300}toast\.error/.test(fieldSrc),
);

// ── 7d：行數不一致 → 照樣寫入 + 警告 + 強制攤開 ────────────────────────────
console.log("\n[7d] 行數比對");

const successStart = fieldSrc.indexOf("const enResult", failReturn);
const catchStart = fieldSrc.indexOf("} catch (err)", successStart);
checkTrue("找得到成功路徑", successStart > failReturn);
checkTrue("找得到 catch", catchStart > successStart);
const successPath = fieldSrc.slice(successStart, catchStart);

checkTrue(
  "🔴 成功路徑有行數比對（英文 vs 中文）",
  successPath.includes("enResult.length !== source.length"),
);
checkTrue(
  "🔴 成功路徑有行數比對（日文 vs 中文）",
  successPath.includes("jaResult.length !== source.length"),
);
// 「照樣寫入」：兩個 setValue 必須在行數比對**之前**。
const setValueAt = successPath.indexOf("setValue(");
const compareAt = successPath.indexOf("!== source.length");
checkTrue("成功路徑有寫入英日兩格", (successPath.match(/setValue\(/g) ?? []).length === 2);
checkTrue(
  "行數對不上也照樣寫入（setValue 在比對之前）",
  setValueAt >= 0 && compareAt > setValueAt,
  "不寫進去人就看不到模型回了什麼，也就改不動。",
);

// 不一致的那個分支：警告 + 強制攤開，兩個都要。
const mismatchAt = successPath.indexOf("!== source.length");
const mismatchEnd = successPath.indexOf("toast.success", mismatchAt);
checkTrue("找得到不一致分支的結尾（toast.success 之前）", mismatchEnd > mismatchAt);
const mismatchBranch = successPath.slice(mismatchAt, mismatchEnd);
checkTrue("🔴 行數不一致會跳警告 toast", mismatchBranch.includes("toast.warning"));
checkTrue("🔴 行數不一致會強制把英日攤開", mismatchBranch.includes("setManuallyOpen(true)"));
checkTrue(
  "警告訊息說得出三邊各幾行",
  /source\.length[\s\S]{0,200}enResult\.length[\s\S]{0,200}jaResult\.length/.test(mismatchBranch),
);
checkTrue(
  "不一致時不會再跳一個「成功」蓋掉警告",
  /toast\.warning[\s\S]{0,300}?return;/.test(mismatchBranch),
);
checkTrue("行數一致才報成功", successPath.includes("toast.success"));

// 摺疊不可以藏住問題 —— 缺語言或行數對不上，兩種都拒絕摺疊。
checkTrue(
  "缺語言或行數對不上時拒絕摺疊",
  fieldSrc.includes("if ((missing || mismatched) && !next) return;"),
);
checkTrue(
  "mismatched 會讓 Collapsible 保持攤開",
  /const open = missing \|\| mismatched \|\| manuallyOpen;/.test(fieldSrc),
);
checkTrue("寫進去的兩個值有 shouldDirty", (fieldSrc.match(/shouldDirty: true/g) ?? []).length >= 4);

// =============================================================================
// [8] 最新的 migration 是哪一支
// =============================================================================
console.log("\n[8] migration 編號");

// 這裡原本是「D2 這一期不准新增 migration」的凍結宣告（0024／0025 當時都還沒能套上
// 正式庫，不該再疊第三支）。那個凍結在 0026 這一期解除了。
//
// 留下的是同一條斷言的另一半用途：**它是一個提醒**。這一支驗的是三語清單欄位
// （jsonb {"zh":[…],"en":[…],"ja":[…]}）與它的表單／送出兩段 schema，而任何一支新
// migration 都可能改到那個 jsonb 的形狀。所以新增 migration 的人一定會在這裡紅一次，
// 被迫回答「我這一支有沒有動到三語清單」。
//
// 0026_event_product_link.sql 的答案是沒有：它加 events.slug / events.image_key
// （兩個都是純 text，不是 jsonb）、一個唯一索引，以及
// admin_upsert_event_with_session()。那支函式**原樣搬運**三語 jsonb（title /
// summary / description / 場次的 title / location），沒有拆開、沒有重組、也沒有
// 碰任何一個 *_list 欄位。
// 0027_event_blocks.sql 的答案是**有，而且這一支就是為了三語清單而開的** —— 它是
// D2 這一層的資料層另一半（D1）：在 public.events 上加那七個清單欄位
// （highlights / suitable_for / not_suitable_for / takeaways / outline / includes /
// notes），全部是 jsonb {"zh":[…],"en":[…],"ja":[…]}，並新開
// public.is_localized_list() 去守那個形狀。
//
// 🔴 關鍵是它**沒有改變這一支在驗的那個形狀**，只是把它寫進資料庫：
//    · 三個 key 仍然是 zh / en / ja，值仍然是 string[]（送出端 localizedListSchema
//      產出的那個形狀原樣進 DB，不需要任何轉換）。
//    · 40 / 200 / 2000 三個數字一個都沒有進 SQL —— 那是**刻意**的分工（資料庫管
//      形狀、zod 管內容，見 schemas.ts 檔頭與 0027 檔頭），所以下面對帳那三個
//      數字的斷言仍然只有 TS 這一個家。
//    · 0001 的 is_localized() 一個字都沒動（0027 是新開一支，不是改嚴舊的）。
// ── 這條提醒從「最高編號快照」換成帳本依賴 ───────────────────────────────
// 原本是 `check("migration 最高編號是 0027（…要回來確認沒動到三語清單）", highest, 27)`。
// 那條的標籤是誠實的，但它的**觸發條件**跟它問的問題對不上：它問「你有沒有動到
// 三語清單」，卻對**每一支**新 migration 都轉紅，不管那支碰的是發票、POS 還是
// 廠商主檔。於是絕大多數時候作者被叫回來、看了、把 27 改成 28 —— 沒有產生任何
// 資訊。問題問對了，鬧鐘裝錯了地方。
//
// 換成宣告依賴：這一支在乎的是三語 jsonb 的形狀守衛（localized_list：
// is_localized / is_localized_list）與 public.events 上那七個清單欄位
// （events_shape）。帳本裡只要出現一支排在 0027 之後、又動到這兩區的 migration，
// 這裡就轉紅，並且**指名是哪一支動到哪一區** —— 比原來那條「最高編號變了」更
// 接近作者真正需要回答的問題。動到別的地方的 migration 不再叫這一支回來。
//
// 上面那幾段 0026 / 0027 的逐條重讀保留下來當紀錄；新的 migration 不要再往上面
// 加散文，改成到 scripts/lib/migration-ledger.mjs 的 MIGRATION_LEDGER 補一列。
assertLedgerMatchesDisk(check, join(ROOT, "supabase/migrations"));
assertLedgerDeclarationsHonest(check, join(ROOT, "supabase/migrations"));
assertMigrationDependencies(check, join(ROOT, "supabase/migrations"), {
  suite: "localized-list-selftest",
  dependsOn: ["localized_list", "events_shape"],
  // ── 0029_event_seats_visibility.sql 的重讀結論 ───────────────────────────
  // 0029 讓「尚餘名額 N」變成逐場活動可以關掉：public.events 與 public.products 各加
  // 一個 show_seats_remaining（boolean not null default true ＝ 維持既有行為），加兩個
  // trigger 讓兩邊不分岔（events→products 推、products 寫入時反向拉），並用
  // create or replace 讓 admin_upsert_event_with_session() 多讀一個 payload key。
  // **沒有 ALTER 任何一張既有欄位、沒有 drop 任何函式、沒有動到任何一支 RPC 的邏輯**
  // ——那支函式的本體是 0027 那一份逐字照抄，只多了三處 show_seats_remaining
  // （0029 §5 寫了差異清單，scripts/event-blocks-selftest.mjs [7] 現在改成驗
  //   **最後一支重新定義它的 migration**，所以那份抄寫走樣會轉紅）。
  // ⚠️ reviewedThrough 從 0027 一路推到 0029，中間跳過的 0028_free_order_settlement.sql
  //    也重讀過：它只碰 orders / payments / invoice_backlog（帳本標的五個區域裡沒有
  //    localized_list 或 events_shape），一個 jsonb 欄位、一個 is_localized 呼叫都沒有。
  // 逐條重讀之後：0029 沒有重新定義 is_localized() 或 is_localized_list()，也沒有新增
  // 任何 jsonb 欄位 —— 它加的兩欄都是 boolean。函式本體裡出現的 is_localized 呼叫是
  // 0027 那一份照抄過來的驗證，形狀與呼叫點都沒變。三語清單的欄位清單與 CHECK 不受影響。
  // 原樣成立。
  // ── 0031_event_gallery.sql 的重讀結論 ─────────────────────────────────────
  // ⚠️ reviewedThrough 從 0029 推到 0031，中間跳過的 0030_customer_accounts.sql
  //    也重讀過：帳本標它只碰 orders_payments，它唯一寫到的欄位是
  //    public.orders.user_id，一個 jsonb 欄位、一個 is_localized 呼叫都沒有，
  //    也沒有重新定義 admin_upsert_event_with_session()。
  // 0031 用 create or replace 又重寫了一次 admin_upsert_event_with_session()
  // ——這正是這支自檢依賴 events_shape 的理由。但那份重寫是 0029 那一份**逐字
  // 照抄**：is_localized() 與 is_localized_list() 的呼叫（title/summary/
  // description 三語物件的檢查、七個清單欄位的形狀檢查）一個字都沒動，呼叫點
  // 也沒搬過家。0031 新增的兩處改動——gallery_keys（型別是 text[]，不是
  // jsonb，所以完全不經過 is_localized_list()）與 external_url 的驗證放寬
  // ——都不是三語 jsonb 欄位，不受這支自檢守的任何一條規則管轄。它也沒有新增
  // 任何 jsonb 欄位或 CHECK 約束。三語清單的欄位清單與 CHECK 不受影響。
  // 原樣成立。
  // 2026-11-02 0052_event_listing_status.sql：帳本標了 events_shape／localized_list——它加了
  // events.status、重寫 admin_upsert_event_with_session（取自正式庫本體，只加 status 三處；七個
  // 清單欄位的驗證與 coalesce 逐字沿用）。中間的 0037–0050 沒有動到這兩區。本檔斷言重跑全綠。
  reviewedThrough: "0052_event_listing_status.sql",
});

// -----------------------------------------------------------------------------
// 收尾
// -----------------------------------------------------------------------------

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
