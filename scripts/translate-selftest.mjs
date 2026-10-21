#!/usr/bin/env node
/**
 * translate-selftest.mjs —— 三語欄位「自動翻譯」（Phase A）的自檢
 *
 * 分兩段，理由與 notify-selftest / event-registration-selftest 相同：這支測試在沒有
 * 金鑰的機器上也必須有意義。
 *
 *   [靜態] **直接 import src/server/translate.ts 本人**，然後真的去呼叫
 *          buildTranslateRequest() 與 normaliseTranslation()。也就是說它驗到的是
 *          production 真正送出去的那個物件、真正跑的那段收斂邏輯，不是原始碼裡
 *          有沒有出現某幾個字 —— 註解裡也會出現 `thinkingBudget` 這幾個字，grep
 *          過得了但什麼都沒證明。**永遠會跑。**
 *
 *          需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15
 *          （module.registerHooks，用來把 `./env` 解析成 `./env.ts` —— Node 不會
 *          自己補副檔名，而 repo 的 import 慣例是不寫副檔名）。CI 用的是 24。
 *
 *          只有 fns/translate.ts 與 LocalizedField.tsx 走原始碼比對：前者有 `@/`
 *          alias 載不起來，後者是 TSX。它們要守的也剛好是「有沒有寫某一行」這種
 *          問題（掛的是不是 adminFnMiddleware、失敗時有沒有偷偷 setValue）。
 *
 *   [連線] 真的打一次 Gemini，用的是 buildTranslateRequest() 產出的**同一個 body**。
 *          守的是這一期最貴的那個教訓：3.5-flash 預設會思考，思考的 token 算在
 *          maxOutputTokens 裡，於是輸出被截斷成漏出思考碎片 —— 而 HTTP 是 200。
 *          斷言 usageMetadata.thoughtsTokenCount 為 0、finishReason 是 STOP 而**不是**
 *          MAX_TOKENS。
 *
 * ⚠️ 這支測試不碰任何資料庫，也不寫任何一張表。翻譯結果是塞回表單的兩個 input，
 *    人按下儲存才會進資料庫，走的是既有那條路。
 *
 * 環境變數：
 *   GEMINI_API_KEY           [連線] 段的開關。沒設就整段 skip（會印出來，不會靜悄悄消失）
 *   GEMINI_TRANSLATE_MODEL   要打哪一個模型；沒設就是 gemini-3.5-flash（本檔會驗這個預設）
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/translate-selftest.mjs";

const SERVER_TRANSLATE = join(ROOT, "src/server/translate.ts");
const SERVER_ENV = join(ROOT, "src/server/env.ts");
const FN_TRANSLATE = join(ROOT, "src/lib/admin/fns/translate.ts");
const LOCALIZED_FIELD = join(ROOT, "src/components/admin/LocalizedField.tsx");
const SCHEMAS = join(ROOT, "src/lib/admin/schemas.ts");

// -----------------------------------------------------------------------------
// 迷你測試框架（與 notify-selftest 同一套）
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
 * 呼叫一個應該要丟 TranslateError 的東西，回 { kind, message }；沒丟就回 null。
 * 丟了別的型別也回 null —— 「丟了某個東西」不等於「丟了對的東西」。
 */
function catchTranslateError(TranslateError, run) {
  try {
    run();
    return null;
  } catch (err) {
    if (!(err instanceof TranslateError)) return null;
    return { kind: err.kind, message: err.message };
  }
}

console.log("═══ 三語欄位自動翻譯自檢（Phase A）═══");

// =============================================================================
// [0] 載入 production 的模組本人
// =============================================================================
// Node 不會把 `./env` 自己補成 `./env.ts`，而 repo 的 import 慣例是不寫副檔名。
// 補一個 resolve hook，讓下面 import 到的是**真的那一份**，不是一份長得很像的複本。
console.log("\n[0] 載入 src/server/translate.ts");

if (typeof registerHooks !== "function") {
  console.log(red("  ✗ 這個 Node 沒有 module.registerHooks（需要 ≥ 22.15）"));
  console.log(red("      → 靜態段整段無法執行。CI 用的是 Node 24。"));
  console.log(`##SELFTEST## file=${SELF} pass=0 fail=1`);
  process.exit(1);
}

registerHooks({
  resolve(spec, ctx, next) {
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

check("src/server/translate.ts 存在", existsSync(SERVER_TRANSLATE), true);
check("src/lib/admin/fns/translate.ts 存在", existsSync(FN_TRANSLATE), true);

const mod = await import(SERVER_TRANSLATE);
const env = await import(SERVER_ENV);
const { buildTranslateRequest, normaliseTranslation, translateToEnJa, TranslateError } = mod;

check(
  "translate.ts 匯出四樣東西",
  [
    typeof buildTranslateRequest,
    typeof normaliseTranslation,
    typeof translateToEnJa,
    typeof TranslateError,
  ],
  ["function", "function", "function", "function"],
);
check("TRANSLATE_EMPTY 是一句人話（不是代碼字串）", typeof mod.TRANSLATE_EMPTY, "string");

// =============================================================================
// [1] 模型：預設值與「一個旋鈕管一件事」
// =============================================================================
console.log("\n[1] 模型設定");

const savedTranslateModel = process.env.GEMINI_TRANSLATE_MODEL;
const savedOcrModel = process.env.GEMINI_OCR_MODEL;

delete process.env.GEMINI_TRANSLATE_MODEL;
delete process.env.GEMINI_OCR_MODEL;

// ⚠️ 這一條在守一個踩過的坑：gemini-2.5-flash 對新申請的金鑰已經 404
//    （"no longer available to new users"），**但它仍然留在 models.list 的回傳裡**。
//    也就是說「列表查得到」不等於「打得通」。
check("預設模型是 gemini-3.5-flash", env.geminiTranslateModel(), "gemini-3.5-flash");
checkTrue(
  "預設模型不是已經對新金鑰關閉的 gemini-2.5-flash",
  env.geminiTranslateModel() !== "gemini-2.5-flash",
);

process.env.GEMINI_OCR_MODEL = "gemini-ocr-only-knob";
check(
  "改 GEMINI_OCR_MODEL 不會改到翻譯的模型（一個旋鈕管一件事）",
  env.geminiTranslateModel(),
  "gemini-3.5-flash",
  "兩支共用同一個環境變數的話，為了調辨識品質動的那一下會順手改掉翻譯。",
);
check("GEMINI_OCR_MODEL 本人仍然吃得到覆寫", env.geminiOcrModel(), "gemini-ocr-only-knob");

process.env.GEMINI_TRANSLATE_MODEL = "gemini-translate-only-knob";
check(
  "GEMINI_TRANSLATE_MODEL 吃得到覆寫",
  env.geminiTranslateModel(),
  "gemini-translate-only-knob",
);
check(
  "改 GEMINI_TRANSLATE_MODEL 不會改到 OCR 的模型",
  env.geminiOcrModel(),
  "gemini-ocr-only-knob",
);

delete process.env.GEMINI_TRANSLATE_MODEL;
delete process.env.GEMINI_OCR_MODEL;
if (savedTranslateModel !== undefined) process.env.GEMINI_TRANSLATE_MODEL = savedTranslateModel;
if (savedOcrModel !== undefined) process.env.GEMINI_OCR_MODEL = savedOcrModel;

// =============================================================================
// [2] request body —— production 真的送出去的那一個物件
// =============================================================================
console.log("\n[2] request body（buildTranslateRequest 的實際輸出）");

const body = buildTranslateRequest("自由生成美學");
const gen = body.generationConfig ?? {};

// ⚠️ 這一段是整個 Phase A 最重要的斷言。3.5-flash 預設會思考，而思考的 token 算在
//    maxOutputTokens 裡：實測「用三句話回答一個問題」配 maxOutputTokens: 600，思考
//    吃掉 572、只剩 24 給輸出，回覆被截斷成漏出思考過程的英文碎片 —— 而 HTTP 是 200。
checkTrue("有 generationConfig.thinkingConfig", typeof gen.thinkingConfig === "object");
check("thinkingBudget 是 0", gen.thinkingConfig?.thinkingBudget, 0);
check('thinkingBudget 是數字 0，不是字串 "0"', typeof gen.thinkingConfig?.thinkingBudget, "number");

check("temperature 是 0", gen.temperature, 0);
check("temperature 是數字 0，不是字串", typeof gen.temperature, "number");
check("responseMimeType 是 application/json", gen.responseMimeType, "application/json");

const schema = gen.responseSchema;
checkTrue("有 responseSchema", typeof schema === "object" && schema !== null);
check("responseSchema 是 OBJECT", schema?.type, "OBJECT");
check("responseSchema 要求 en 與 ja 兩個 key", schema?.required, ["en", "ja"]);
check("en 是 STRING", schema?.properties?.en?.type, "STRING");
check("ja 是 STRING", schema?.properties?.ja?.type, "STRING");
// 與 OCR 的取捨刻意相反：辨識不出廠商時回 null 是誠實，但「這段中文翻不出英文」
// 不是一個合理的答案 —— 那時我們要的是看得見的失敗，不是一個安靜的 null。
check("en 不是 nullable", schema?.properties?.en?.nullable, undefined);
check("ja 不是 nullable", schema?.properties?.ja?.nullable, undefined);

// 設一個猜出來的上限只會在最長的那幾筆介紹文上安靜地截斷。thinkingBudget 已經歸零，
// 不會再有思考跟輸出搶額度的問題。
check("刻意沒有設 maxOutputTokens", gen.maxOutputTokens, undefined);

check("中文原文有進到 contents", body.contents?.[0]?.parts?.[0]?.text, "自由生成美學");
check("contents 的 role 是 user", body.contents?.[0]?.role, "user");
checkTrue(
  "systemInstruction 交代了「只回譯文本身」",
  String(body.systemInstruction?.parts?.[0]?.text ?? "").includes("只回譯文本身"),
);

// =============================================================================
// [3] normaliseTranslation —— 空字串必須是失敗，不是「翻不出來就算了」
// =============================================================================
console.log("\n[3] 回傳收斂（trim 與空值）");

// ⚠️ 為什麼空字串不能過：資料庫的 is_localized() CHECK（0001_init.sql:56-68）只檢查
//    三個 key **存在**，空字串完全過得了，然後前台就渲染出一塊空白 —— 一個沒有人會
//    收到告警的錯誤。所以在這一層就擋掉，讓前端根本拿不到空字串可以寫。
check("正常翻譯回 { en, ja }", normaliseTranslation({ en: "Aesthetics", ja: "美学" }), {
  en: "Aesthetics",
  ja: "美学",
});
check("兩邊都 trim 過", normaliseTranslation({ en: "  A  \n", ja: "\t美学 " }), {
  en: "A",
  ja: "美学",
});

const emptyEn = catchTranslateError(TranslateError, () =>
  normaliseTranslation({ en: "", ja: "美学" }),
);
checkTrue("en 是空字串 → throw TranslateError", emptyEn !== null);
check("空翻譯的 kind 是 no_content", emptyEn?.kind, "no_content");
check("空翻譯丟的是 TRANSLATE_EMPTY 那一句", emptyEn?.message, mod.TRANSLATE_EMPTY);

const blankEn = catchTranslateError(TranslateError, () =>
  normaliseTranslation({ en: "   \n\t ", ja: "美学" }),
);
checkTrue("en 只有空白字元（trim 後為空）→ throw", blankEn !== null);
check("只有空白字元的 kind 也是 no_content", blankEn?.kind, "no_content");

checkTrue(
  "ja 是空字串 → throw",
  catchTranslateError(TranslateError, () => normaliseTranslation({ en: "A", ja: "" })) !== null,
);
checkTrue(
  "ja 只有空白字元 → throw",
  catchTranslateError(TranslateError, () => normaliseTranslation({ en: "A", ja: "  " })) !== null,
);
checkTrue(
  "兩種語言都空 → throw",
  catchTranslateError(TranslateError, () => normaliseTranslation({ en: "", ja: "" })) !== null,
);
checkTrue(
  "缺 ja 這個 key → throw",
  catchTranslateError(TranslateError, () => normaliseTranslation({ en: "A" })) !== null,
);
checkTrue(
  "空物件 → throw",
  catchTranslateError(TranslateError, () => normaliseTranslation({})) !== null,
);
checkTrue(
  "null → throw（不是 TypeError）",
  catchTranslateError(TranslateError, () => normaliseTranslation(null)) !== null,
);
checkTrue(
  "字串而不是物件 → throw",
  catchTranslateError(TranslateError, () => normaliseTranslation("Aesthetics")) !== null,
);
checkTrue(
  "en 是數字（模型回了非字串）→ throw",
  catchTranslateError(TranslateError, () => normaliseTranslation({ en: 42, ja: "美学" })) !== null,
);

const capped = normaliseTranslation({ en: "a".repeat(20000), ja: "あ".repeat(20000) });
check("超長輸出被截到上限", [capped.en.length, capped.ja.length], [6000, 6000]);

// 2026-10-21《海的聲音》：模型把【】寫成 JSON 陣列 `["..."]` 上了站。
console.log("\n[3b] 英文譯文的【】殘留");
const { cleanEnglishBrackets } = mod;
check(
  '正式庫實例：開頭 ["主標"] → 主標 — 副標',
  normaliseTranslation({
    en: '["Have You Heard the Voice of the Sea?"] Hu Hai-Yin Handmade Picture Book Talk',
    ja: "【海の声】トーク",
  }),
  {
    en: "Have You Heard the Voice of the Sea? — Hu Hai-Yin Handmade Picture Book Talk",
    ja: "【海の声】トーク",
  },
);
check(
  "全形引號 [“…”] 也認",
  cleanEnglishBrackets("[“Quiet Hours”] A Reading Night"),
  "Quiet Hours — A Reading Night",
);
check(
  "英文裡殘留的【】",
  cleanEnglishBrackets("【Quiet Hours】 A Reading Night"),
  "Quiet Hours — A Reading Night",
);
check("整句只有括號 → 只拿掉括號", cleanEnglishBrackets('["Quiet Hours"]'), "Quiet Hours");
check(
  '句中的 ["…"] 只拿掉括號',
  cleanEnglishBrackets('Talk on ["Quiet Hours"] tonight'),
  "Talk on Quiet Hours tonight",
);
check(
  "一般方括號 [Online] 原樣保留",
  cleanEnglishBrackets("[Online] Workshop"),
  "[Online] Workshop",
);
check("多行逐行處理、保留換行", cleanEnglishBrackets('["A"] b\nline two'), "A — b\nline two");
checkTrue(
  "prompt 有教模型英文不要用括號包【】",
  JSON.stringify(buildTranslateRequest("x")).includes("英文不要用任何括號或引號包起來"),
);

// =============================================================================
// [4] 中文是空的就不打 API
// =============================================================================
console.log("\n[4] 空中文不打 API");

// 把 fetch 換掉。如果 translateToEnJa 在中文是空的時候還是送了請求，這裡會丟一個
// 不是 TranslateError 的東西出來 —— 也就是說這一條驗的是「真的沒有發出去」，
// 不是「原始碼裡有一個 if」。
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error("SELFTEST: 不應該打 API");
};

for (const [label, text] of [
  ["空字串", ""],
  ["只有空白", "   "],
  ["只有換行與 tab", "\n\t \n"],
]) {
  let kind = null;
  try {
    await translateToEnJa({ text });
  } catch (err) {
    kind = err instanceof TranslateError ? err.kind : `非 TranslateError：${err.message}`;
  }
  check(`${label} → 丟 no_content 而不是送出請求`, kind, "no_content");
}
check("整段一次 fetch 都沒有發生", fetchCalls, 0);

globalThis.fetch = realFetch;

// =============================================================================
// [5] server fn：授權與金鑰邊界
// =============================================================================
console.log("\n[5] server fn（src/lib/admin/fns/translate.ts）");

const fnSrc = stripTs(readFile(FN_TRANSLATE));

checkTrue("掛的是 adminFnMiddleware", fnSrc.includes(".middleware([adminFnMiddleware])"));
checkTrue(
  "沒有掛 staffFnMiddleware",
  !fnSrc.includes("staffFnMiddleware"),
  "翻譯燒的是全站共用的 AI 額度，放寬給店員是一個獨立的決定。",
);
checkTrue("沒有掛 vendorFnMiddleware", !fnSrc.includes("vendorFnMiddleware"));
checkTrue("有 inputValidator（不是直接吃 client 送的東西）", fnSrc.includes(".inputValidator("));
checkTrue("走 translateSchema", fnSrc.includes("translateSchema"));
checkTrue(
  "server 模組是動態 import（module graph 不往 client 靠）",
  /await import\("@\/server\/translate"\)/.test(fnSrc),
);
checkTrue(
  "沒有把 model 開放給 client 指定",
  !/model/i.test(fnSrc.replace(/TranslateError/g, "")),
  "讓瀏覽器挑模型等於讓人挑一個貴的來燒額度。",
);

// ── 金鑰不進瀏覽器 ──────────────────────────────────────────────────────────
// 任何 client 端讀得到的東西都等於公開，而 Gemini 的金鑰是一張可以被別人拿去刷的
// 帳單。守的是兩條：
//   1. src/server/** 以外**一行都不准出現** GEMINI_API_KEY（註解不算 —— 註解裡寫
//      「缺 GEMINI_API_KEY 時會怎樣」是說明，不是讀取）。
//   2. src/server/** 之內也只有 env.ts 真的去讀它。
// 只比對「拿掉註解之後」的原始碼，否則這條規則會變成「不准在註解裡解釋這件事」。
const { readdirSync } = await import("node:fs");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const srcFiles = walk(join(ROOT, "src"));
const rel = (p) => p.slice(ROOT.length + 1);

const keyMentions = srcFiles
  .filter((p) => /GEMINI_API_KEY/.test(stripTs(readFile(p))))
  .map(rel)
  .sort();
check(
  "src/server/** 以外沒有任何一行程式碼出現 GEMINI_API_KEY",
  keyMentions.filter((p) => !p.startsWith("src/server/")),
  [],
);
const keyReaders = srcFiles
  .filter((p) =>
    /(process\.env\.GEMINI_API_KEY|required\("GEMINI_API_KEY"\))/.test(stripTs(readFile(p))),
  )
  .map(rel)
  .sort();
check("全 src/ 只有 env.ts 真的去讀 GEMINI_API_KEY", keyReaders, ["src/server/env.ts"]);

// VITE_ 前綴會被 loadEnv 變成 compile-time define，套用到 client **與** SSR 兩個
// bundle —— 一個 VITE_GEMINI_… 就是把金鑰印成瀏覽器裡的字串字面值。
const vitePrefixed = srcFiles.filter((p) => /VITE_[A-Z_]*GEMINI/.test(readFile(p))).map(rel);
check("沒有任何 VITE_ 前綴的 Gemini 變數", vitePrefixed, []);

// 除了 server fn 那一支，沒有別人 import 得到 src/server/translate.ts。
//
// 唯一的例外是「一頁新增活動」的寫入端 src/server/event-quick-create.ts：它也是
// server-only，而且唯一的呼叫端 fns/events.ts#createEventQuick 掛的是同一支
// adminFnMiddleware —— 「誰可以燒站台的 AI 額度」一個字都沒有放寬。下面另外守這兩件事。
const translateImporters = srcFiles
  .filter((p) => rel(p) !== "src/server/translate.ts")
  .filter((p) => /["']@\/server\/translate["']/.test(stripTs(readFile(p))))
  .map(rel)
  .sort();
// 第二個例外是遠端 MCP server 的寫入工具 src/server/mcp/tools.ts（三語欄位只給中文時
// 自動補英日文）。同樣 server-only；能呼叫它的只有通過 MCP_TOKEN 閘門的請求
// （src/server/mcp/core.ts#gateMcpRequest，沒設 token 整支 404）—— 那把 token 由老闆
// 自己設、自己持有，等同後台 admin，額度的決定權沒有交給任何新的人。
check(
  "只有 fns/translate.ts、一頁新增活動、MCP 寫入工具匯入 @/server/translate",
  translateImporters,
  ["src/lib/admin/fns/translate.ts", "src/server/event-quick-create.ts", "src/server/mcp/tools.ts"],
);
{
  const quickSrc = readFile(join(ROOT, "src/server/event-quick-create.ts"));
  checkTrue(
    "event-quick-create.ts 有 server-only 標記",
    quickSrc.includes('import "@tanstack/react-start/server-only"'),
  );
  const fnsEvents = stripTs(readFile(join(ROOT, "src/lib/admin/fns/events.ts")));
  checkTrue(
    "它唯一的呼叫端 createEventQuick 掛 adminFnMiddleware",
    /createEventQuick = createServerFn\(\{ method: "POST" \}\)\s*\.middleware\(\[adminFnMiddleware\]\)/.test(
      fnsEvents,
    ),
  );
  const quickImporters = srcFiles
    .filter((p) => /["']@\/server\/event-quick-create["']/.test(stripTs(readFile(p))))
    .map(rel);
  check("只有 fns/events.ts 匯入 event-quick-create", quickImporters, [
    "src/lib/admin/fns/events.ts",
  ]);
}

const translateSrc = readFile(SERVER_TRANSLATE);
checkTrue(
  "translate.ts 有 server-only 標記",
  translateSrc.includes('import "@tanstack/react-start/server-only"'),
);
checkTrue(
  "金鑰走 header 不走 query string（網址會進 log）",
  translateSrc.includes('"x-goog-api-key"') && !/[?&]key=/.test(translateSrc),
);

// ── 逾時 ────────────────────────────────────────────────────────────────────
const noComments = stripTs(translateSrc);
checkTrue("用 AbortController + AbortSignal 做逾時", noComments.includes("new AbortController()"));
checkTrue("逾時設在 30 秒", /const TIMEOUT_MS = 30_000;/.test(noComments));
checkTrue("signal 有真的掛到 fetch 上", noComments.includes("signal: controller.signal"));
checkTrue("有 clearTimeout（不留下吊著的計時器）", noComments.includes("clearTimeout(timer)"));

// ⚠️ 金鑰要在 try **外面**取。geminiApiKey() 缺變數時丟的是一個講得很清楚的設定
//    錯誤，一旦在 try 裡面被求值就會被收成 TranslateError("service", "無法連線…")，
//    於是「環境變數沒設」長得跟「Google 掛了」一模一樣。實測踩過這一條。
checkTrue(
  "金鑰在 try 外面就取好（設定錯誤不會被偽裝成連線失敗）",
  /const apiKey = geminiApiKey\(\);[\s\S]*?\n  try \{/.test(noComments) &&
    !/try \{[\s\S]*?geminiApiKey\(\)/.test(noComments),
);

// ── 五種失敗分類 ────────────────────────────────────────────────────────────
// 額度用完（等一下就好）與服務掛掉（等多久都沒用）在人眼裡不可以是同一句話。
for (const kind of ["quota", "timeout", "bad_response", "no_content", "service"]) {
  // 換行容忍：prettier 會把長的 throw 拆成多行，`new TranslateError("quota"` 這種
  // 連續字串比對會整排假性失敗。
  checkTrue(
    `失敗分類有 ${kind}`,
    new RegExp(`new TranslateError\\(\\s*"${kind}"`).test(noComments),
  );
}
checkTrue(
  "429 歸到 quota",
  /response\.status === 429[\s\S]{0,240}new TranslateError\(\s*"quota"/.test(noComments),
);
checkTrue(
  "逾時（AbortError）歸到 timeout",
  /AbortError[\s\S]{0,240}new TranslateError\(\s*"timeout"/.test(noComments),
);
checkTrue(
  "MAX_TOKENS 有單獨認出來（不是掉到 JSON.parse 去講「格式不正確」）",
  noComments.includes('finishReason === "MAX_TOKENS"'),
);

// =============================================================================
// [6] LocalizedField：只加一顆按鈕，失敗時什麼都不寫
// =============================================================================
console.log("\n[6] LocalizedField.tsx");

const fieldSrc = readFile(LOCALIZED_FIELD);
const field = stripTs(fieldSrc);

checkTrue("有「自動翻譯」按鈕", fieldSrc.includes("自動翻譯"));
checkTrue("既有的「複製中文到英日」還在", fieldSrc.includes("複製中文到英日"));
checkTrue("既有的拒絕摺疊邏輯還在", field.includes("if (missing && !next) return;"));
checkTrue(
  "仍然用 useFormContext（沒有改成用 props 傳 control）",
  field.includes("useFormContext()"),
);
checkTrue(
  "呼叫的是 server fn，不是直接打 Gemini",
  field.includes('await import("@/lib/admin/fns/translate")'),
);
checkTrue("元件裡沒有出現任何 Gemini 端點", !/generativelanguage\.googleapis\.com/.test(fieldSrc));

// 中文空的就不呼叫，連 server fn 都不打。
checkTrue("中文是空的就直接提示、不呼叫", /if \(!zh\) \{[\s\S]{0,120}toast\.warning/.test(field));

// 失敗時**什麼都不寫**：ok:false 那個分支裡只有 toast 跟 return，沒有 setValue。
const failureBranch = /if \(!result\.ok\) \{([\s\S]*?)\}/.exec(field)?.[1] ?? "";
checkTrue("翻譯失敗分支存在", failureBranch.length > 0);
checkTrue("失敗分支有跳 toast", failureBranch.includes("toast.error"));
checkTrue("失敗分支沒有 setValue（維持空白比寫進半套翻譯好）", !failureBranch.includes("setValue"));
checkTrue(
  "送出前先把英日區攤開（失敗之後人要看得見那兩個框）",
  /setManuallyOpen\(true\);\s*setTranslating\(true\)/.test(field),
);
checkTrue(
  "有 catch 接授權／設定錯誤，不留 unhandled rejection",
  /catch \(err\)[\s\S]{0,300}toast\.error/.test(field),
);
checkTrue("翻譯中會 disable 按鈕", field.includes("disabled={translating"));
checkTrue("寫進去的兩個值有 shouldDirty", (field.match(/shouldDirty: true/g) ?? []).length >= 4);

// =============================================================================
// [7] schema
// =============================================================================
console.log("\n[7] schemas.ts");

const schemasSrc = stripTs(readFile(SCHEMAS));
checkTrue("有 translateSchema", schemasSrc.includes("export const translateSchema"));
checkTrue(
  "有 TRANSLATE_FAILURE_KINDS",
  schemasSrc.includes("export const TRANSLATE_FAILURE_KINDS"),
);
checkTrue(
  "translateSchema 只收 text 一個欄位",
  /export const translateSchema = z\.object\(\{\s*text:[\s\S]*?\n\}\);/.test(schemasSrc) &&
    !/export const translateSchema[\s\S]*?\n\}\);/.exec(schemasSrc)?.[0]?.includes("model"),
);
checkTrue("有下限（空字串進不來）", /\.min\(1,/.test(schemasSrc.split("translateSchema")[1] ?? ""));
checkTrue(
  "有上限 2000（與 translate.ts 的 MAX_INPUT_CHARS 同一個數字）",
  /\.max\(2000,/.test(schemasSrc.split("translateSchema")[1] ?? "") &&
    /const MAX_INPUT_CHARS = 2000;/.test(noComments),
);

// =============================================================================
// [8] 連線段：真的打一次 Gemini
// =============================================================================
console.log("\n[8] 連線（真的打一次 Gemini）");

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  skipped.push("[8] 連線段 —— 沒有 GEMINI_API_KEY，整段跳過（設了就會跑）");
  console.log(yellow("  ⤼ 沒有 GEMINI_API_KEY，跳過。"));
  console.log(yellow("     GEMINI_API_KEY=… node scripts/translate-selftest.mjs"));
} else {
  const ZH = "自由生成美學：作品如何成為場";
  const model = env.geminiTranslateModel();
  console.log(`  · 模型 ${model}，原文「${ZH}」`);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        // ⚠️ 用的是 production 那一支 buildTranslateRequest 的輸出本人。這裡如果自己
        //    另外拼一個 body，這一整段驗到的就會是「測試自己寫的設定」。
        body: JSON.stringify(buildTranslateRequest(ZH)),
      },
    );

    check("HTTP 200", res.status, 200);
    const payload = await res.json();

    if (res.status !== 200) {
      console.log(red(`      ${JSON.stringify(payload).slice(0, 400)}`));
    } else {
      const usage = payload.usageMetadata ?? {};
      const candidate = payload.candidates?.[0] ?? {};

      console.log(
        `  · usageMetadata: prompt=${usage.promptTokenCount} ` +
          `thoughts=${JSON.stringify(usage.thoughtsTokenCount)} ` +
          `candidates=${usage.candidatesTokenCount} total=${usage.totalTokenCount}`,
      );
      console.log(`  · finishReason: ${candidate.finishReason}`);

      // ⚠️ 這是這一期最貴的那個教訓的驗收點。thinkingBudget 沒歸零時，思考的 token
      //    會去搶 maxOutputTokens，輸出被截斷成漏出思考過程的碎片 —— HTTP 仍然是 200。
      //    欄位在思考關掉時可能整個不出現，所以正規化成 0 再比；原始值印在上面。
      check("thoughtsTokenCount 是 0（思考真的關掉了）", usage.thoughtsTokenCount ?? 0, 0);
      check("finishReason 是 STOP", candidate.finishReason, "STOP");
      checkTrue(
        "finishReason 不是 MAX_TOKENS（輸出沒有被截斷）",
        candidate.finishReason !== "MAX_TOKENS",
      );

      const text = candidate.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* 下面那條會紅 */
      }
      checkTrue("回的是合法 JSON", parsed !== null, `實得：${text.slice(0, 200)}`);

      if (parsed) {
        const out = normaliseTranslation(parsed);
        console.log(`  · en: ${out.en}`);
        console.log(`  · ja: ${out.ja}`);
        checkTrue("en 非空", out.en.length > 0);
        checkTrue("ja 非空", out.ja.length > 0);
        checkTrue("en 不等於原文", out.en !== ZH);
        checkTrue("ja 不等於原文", out.ja !== ZH);
        checkTrue("en 與 ja 不是同一串（不是把中文複製兩份）", out.en !== out.ja);
        checkTrue(
          "en 裡沒有中文字（不是原封不動照抄）",
          !/[一-鿿]/.test(out.en),
          `實得：${out.en}`,
        );
        checkTrue("ja 含有日文或漢字", /[぀-ヿ一-鿿]/.test(out.ja));
        checkTrue(
          "沒有夾帶思考碎片（回的只有譯文，沒有 JSON 以外的東西）",
          Object.keys(parsed).sort().join(",") === "en,ja",
          `實得 keys：${Object.keys(parsed).join(",")}`,
        );
      }
    }

    // ── 對照組（不計 case，只印出來當證據）────────────────────────────────
    // 把 thinkingConfig 拿掉、maxOutputTokens 設成 600，重現當初那個症狀。
    // 不做成斷言是因為模型要不要思考不是我們能保證的事；能保證的是**我們關掉它**。
    console.log("\n  對照組：拿掉 thinkingConfig、maxOutputTokens=600");
    const naive = buildTranslateRequest(ZH);
    delete naive.generationConfig.thinkingConfig;
    naive.generationConfig.maxOutputTokens = 600;
    const res2 = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(naive),
      },
    );
    const p2 = await res2.json();
    console.log(
      yellow(
        `  · 對照組 thoughts=${JSON.stringify(p2.usageMetadata?.thoughtsTokenCount)} ` +
          `finishReason=${p2.candidates?.[0]?.finishReason}`,
      ),
    );
  } catch (err) {
    fail += 1;
    console.log(red(`\n  ✗ 連線段中斷：${String(err.message ?? err).slice(0, 600)}`));
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
