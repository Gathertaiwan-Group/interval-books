#!/usr/bin/env node
/**
 * 後台 SSR hydration 的自檢（React #418）。
 *
 * ── 為什麼這一支存在 ──────────────────────────────────────────────────────
 * 2026-10-09 用正式建置逐頁載入後台，有四頁的 console 出現 React #418：伺服器
 * render 的 HTML 跟瀏覽器第一次 render 的不一樣，React 丟掉伺服器那一段整棵重畫。
 * 頁面最後還是畫得出來，所以**沒有人會從畫面上發現它** —— 只會覺得閃了一下。
 *
 * 兩種成因，各有一段守著：
 *
 *   [1]–[4] 時間字串。/admin/events/$id、/admin/registrations 的 toLocaleString 沒給
 *           timeZone（Vercel 是 UTC，伺服器印出晚 8 小時的時間）；/admin/orders 有給
 *           timeZone 卻還是不一樣 —— Node（ICU 78.2）在日期與「下午」之間放的是
 *           U+2009 THIN SPACE，Chrome 是一般空白。三頁改用 src/lib/taipei-time.ts 的
 *           formatTaipeiDateTime()：只向 Intl 拿數字、自己拼字，與時區、ICU 都無關。
 *
 *   [5]     HTML 巢狀。/admin/inventory-vendors 把 <Badge>（render 成 <div>）放在
 *           <p> 裡。<p> 裡不能有 <div>：瀏覽器解析 SSR 的 HTML 時會先把 <p> 關掉，
 *           DOM 跟 React 預期的結構對不上（#418 的參數是 HTML 而不是 text）。
 *
 * [2] 是這一支的重點：**真的開子行程**，在 TZ=UTC、TZ=Asia/Taipei 等環境各跑一次同一
 * 批時間，逐字比對。同一個子行程也跑一次舊寫法（不帶 timeZone 的 toLocaleString），
 * 證明這個比對抓得到「跟環境有關」—— 不然全綠可能只是環境根本沒換成功。
 *
 * 執行：node scripts/admin-hydration-selftest.mjs（或 npm test）
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseJs } from "@babel/parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-hydration-selftest.mjs";
const HELPER = "src/lib/taipei-time.ts";

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

/** 讀不到就丟例外（帶路徑）—— 見 run-selftests.mjs 的守門 4。 */
function readSource(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch (err) {
    throw new Error(`讀不到 ${rel}：${err.message}`);
  }
}

function finish() {
  console.log(`\n${"─".repeat(52)}`);
  console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
  if (fail === 0) {
    console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
    process.exit(0);
  }
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}

console.log("═══ 後台 SSR hydration 自檢 ═══");

// -----------------------------------------------------------------------------
console.log(`\n[0] 載入產線模組 ${HELPER}`);
// -----------------------------------------------------------------------------
let T;
try {
  T = await import(pathToFileURL(join(ROOT, HELPER)).href);
  pass += 1;
  console.log(green(`  ✓ 載入 ${HELPER}`));
} catch (err) {
  fail += 1;
  console.log(red(`  ✗ 無法載入 ${HELPER}：${err}`));
  finish();
}
const f = T.formatTaipeiDateTime;

// -----------------------------------------------------------------------------
console.log("\n[1] 台北時間、24 小時制、沒有「上午／下午」");
// -----------------------------------------------------------------------------
check("UTC 11:05 → 台北 19:05", f("2026-10-09T11:05:00Z"), "2026/10/09 19:05");
check(
  "UTC 16:07 → 台北隔天 00:07（跨日；午夜是 00 不是 24）",
  f("2026-10-08T16:07:00+00:00"),
  "2026/10/09 00:07",
);
check("UTC 15:59 → 台北 23:59（日界前一分鐘）", f("2026-10-08T15:59:00Z"), "2026/10/08 23:59");
check("PostgREST 的微秒字串照樣解得開", f("2026-10-09T04:07:00.123456+00:00"), "2026/10/09 12:07");
check("跨年", f("2026-12-31T16:00:00Z"), "2027/01/01 00:00");
check("+08:00 的字串原樣對到台北", f("2026-10-09T19:05:00+08:00"), "2026/10/09 19:05");
check("null → —", f(null), "—");
check("undefined → —", f(undefined), "—");
check("空字串 → —", f(""), "—");
check("解不開的字串原樣回傳（不是 Invalid Date）", f("not-a-date"), "not-a-date");

// -----------------------------------------------------------------------------
console.log("\n[2] 🔴 同一批時間在不同 TZ 的行程裡逐字相同（模擬 Vercel UTC vs 台灣瀏覽器）");
// -----------------------------------------------------------------------------
const SAMPLES = [
  ...Array.from({ length: 24 }, (_, h) => `2026-10-08T${String(h).padStart(2, "0")}:07:00Z`),
  "2026-10-09T04:07:00.123456+00:00",
  "2026-12-31T16:00:00Z",
  "2026-03-08T10:30:00Z", // 美國夏令時間開始那一天
  "2026-11-01T09:30:00Z", // 美國夏令時間結束那一天
];
const CHILD = `
  const T = await import(${JSON.stringify(pathToFileURL(join(ROOT, HELPER)).href)});
  const samples = ${JSON.stringify(SAMPLES)};
  const legacy = (iso) => new Date(iso).toLocaleString("zh-TW", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  process.stdout.write(JSON.stringify({
    envHour: new Date("2026-10-09T11:05:00Z").getHours(),
    out: samples.map((s) => T.formatTaipeiDateTime(s)),
    legacy: samples.map(legacy),
  }));
`;
const ZONES = ["UTC", "Asia/Taipei", "America/Los_Angeles", "Pacific/Kiritimati"];
const byZone = {};
for (const tz of ZONES) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TZ: tz },
  });
  if (r.status !== 0) {
    check(`TZ=${tz} 的子行程跑得起來`, r.stderr.trim().split("\n").slice(-3).join(" | "), "");
    continue;
  }
  byZone[tz] = JSON.parse(r.stdout);
}
checkTrue(
  "四個 TZ 的子行程都有結果",
  ZONES.every((tz) => byZone[tz]),
);
if (ZONES.every((tz) => byZone[tz])) {
  // 反空轉：TZ 真的有換到（getHours 讀的是行程的時區）。沒換到的話下面全綠也沒有意義。
  check(
    "反空轉：子行程的本地時間真的不同（UTC 11 / 台北 19 / 洛杉磯 4 / 基里巴斯 1）",
    ZONES.map((tz) => byZone[tz].envHour),
    [11, 19, 4, 1],
  );
  // 反空轉：舊寫法在這個比對裡**會**被抓到。
  check(
    "反空轉：舊寫法（toLocaleString 不帶 timeZone）在 UTC 與台北印出不同的字",
    byZone.UTC.legacy[11] === byZone["Asia/Taipei"].legacy[11],
    false,
    "如果舊寫法也一樣，代表這個比對根本測不到時區問題",
  );
  console.log(`      例：UTC 子行程 ${JSON.stringify(byZone.UTC.legacy[11])}`);
  console.log(`          台北子行程 ${JSON.stringify(byZone["Asia/Taipei"].legacy[11])}`);

  for (const tz of ZONES.slice(1)) {
    check(
      `TZ=${tz} 與 TZ=UTC 逐字相同（${SAMPLES.length} 個時間）`,
      byZone[tz].out,
      byZone.UTC.out,
    );
  }
  console.log(`      例：${SAMPLES[11]} → UTC ${JSON.stringify(byZone.UTC.out[11])}`);
  console.log(
    `          ${" ".repeat(SAMPLES[11].length)}   台北 ${JSON.stringify(byZone["Asia/Taipei"].out[11])}`,
  );
  check("UTC 子行程算出來的也是台北時間（11:07Z → 19:07）", byZone.UTC.out[11], "2026/10/08 19:07");
}

// -----------------------------------------------------------------------------
console.log("\n[3] 🔴 輸出只有 ASCII 數字與 / : 空白 —— 沒有任何一個字由 ICU 決定");
// -----------------------------------------------------------------------------
// Node（ICU 78.2）的 toLocaleString 在「下午」前面放 U+2009，Chrome 放 U+0020；
// 「上午／下午／晚上」本身 CLDR 也改過。這裡只允許固定的形狀。
const SHAPE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/;
const all = [...SAMPLES.map(f), ...(byZone.UTC ? byZone.UTC.out : [])];
check(
  `每一個輸出都是 YYYY/MM/DD HH:mm（${all.length} 個）`,
  all.filter((s) => !SHAPE.test(s)),
  [],
);
check(
  "沒有 U+2009／U+202F／U+00A0 這類 ICU 的空白",
  all.filter((s) => /[\u2009\u202f\u00a0]/.test(s)),
  [],
);
check(
  "時一律 00–23（沒有 24，也沒有 12 小時制）",
  all.map((s) => Number(s.slice(11, 13))).filter((h) => h > 23),
  [],
);

// -----------------------------------------------------------------------------
console.log("\n[4] 三頁的時間都改走 formatTaipeiDateTime()，沒有自己的 toLocaleString");
// -----------------------------------------------------------------------------
const TIME_PAGES = [
  "src/routes/admin/_shell.events.$id.tsx",
  "src/routes/admin/_shell.registrations.tsx",
  "src/routes/admin/_shell.orders.tsx",
];

/** 不靠 grep：註解裡提到 toLocaleString 不算數，數字的 toLocaleString 也不算。 */
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    walk(node[key], visit);
  }
}
const parseTsx = (src) => parseJs(src, { sourceType: "module", plugins: ["typescript", "jsx"] });
const TIME_KEYS = new Set(["hour", "minute", "timeStyle", "dateStyle"]);

for (const rel of TIME_PAGES) {
  const src = readSource(rel);
  const ast = parseTsx(src);
  const dateTimeLocaleCalls = [];
  let helperCalls = 0;
  let importsHelper = false;
  walk(ast.program, (n) => {
    if (n.type === "ImportDeclaration" && n.source.value === "@/lib/taipei-time") {
      importsHelper = n.specifiers.some((s) => s.imported?.name === "formatTaipeiDateTime");
    }
    if (n.type !== "CallExpression") return;
    if (n.callee.type === "Identifier" && n.callee.name === "formatTaipeiDateTime")
      helperCalls += 1;
    const prop = n.callee.type === "MemberExpression" ? n.callee.property?.name : null;
    if (
      prop === "toLocaleString" ||
      prop === "toLocaleDateString" ||
      prop === "toLocaleTimeString"
    ) {
      const opts = n.arguments[1];
      const keys = opts?.type === "ObjectExpression" ? opts.properties.map((p) => p.key?.name) : [];
      // 不帶選項的 toLocaleTimeString／toLocaleDateString 一定是日期；toLocaleString 只有
      // 帶時間欄位時才是（數字的 toLocaleString("zh-TW", { maximumFractionDigits }) 不算）。
      if (prop !== "toLocaleString" || keys.some((k) => TIME_KEYS.has(k))) {
        dateTimeLocaleCalls.push(n.loc.start.line);
      }
    }
    if (
      n.callee.type === "MemberExpression" &&
      n.callee.object?.name === "Intl" &&
      n.callee.property?.name === "DateTimeFormat"
    ) {
      dateTimeLocaleCalls.push(n.loc.start.line);
    }
  });
  walk(ast.program, (n) => {
    if (n.type === "NewExpression" && n.callee.type === "MemberExpression") {
      if (n.callee.object?.name === "Intl" && n.callee.property?.name === "DateTimeFormat") {
        dateTimeLocaleCalls.push(n.loc.start.line);
      }
    }
  });
  checkTrue(`${rel}：從 @/lib/taipei-time import formatTaipeiDateTime`, importsHelper);
  checkTrue(`${rel}：至少呼叫一次 formatTaipeiDateTime()`, helperCalls > 0);
  check(
    `${rel}：沒有自己格式化日期時間（toLocale*String／Intl.DateTimeFormat）`,
    dateTimeLocaleCalls,
    [],
  );
}

// -----------------------------------------------------------------------------
console.log("\n[5] 🔴 SSR 會畫的地方，<p> 裡沒有 <div>（含 render 成 <div> 的 Badge 家族）");
// -----------------------------------------------------------------------------
// 只掃首屏會被 SSR 的檔案。對話框（Radix Dialog 關著時不 render）只在瀏覽器裡畫，
// 不經過 HTML parser，所以不會 hydration 失敗 —— 那是另一件事，不在這一支的範圍。
const NESTING_FILES = [
  "src/routes/admin/_shell.events.$id.tsx",
  "src/routes/admin/_shell.registrations.tsx",
  "src/routes/admin/_shell.orders.tsx",
  "src/routes/admin/_shell.inventory-vendors.tsx",
  "src/components/inventory/VendorTable.tsx",
  "src/components/inventory/VendorSubmissionQueue.tsx",
];
/** render 出來是 <p> 的容器。 */
const P_LIKE = new Set(["p", "FormDescription", "FormMessage"]);
/** 會讓 HTML parser 提早關掉 <p> 的元素，加上 render 成 <div> 的元件。 */
const BLOCKS = new Set([
  "div",
  "p",
  "ul",
  "ol",
  "li",
  "dl",
  "table",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "nav",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "pre",
  "blockquote",
  "figure",
  "details",
  "fieldset",
  "main",
  "menu",
  "Badge",
  "ApprovalStatusBadge",
  "PriceChangeBadge",
  "Table",
  "FormItem",
]);
const jsxName = (n) => (n?.type === "JSXIdentifier" ? n.name : null);

function nestingViolations(node, insideP, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) nestingViolations(n, insideP, out);
    return;
  }
  if (typeof node.type !== "string") return;
  let inside = insideP;
  if (node.type === "JSXElement") {
    const name = jsxName(node.openingElement.name);
    if (insideP && BLOCKS.has(name))
      out.push(`<${name}> 在第 ${node.loc.start.line} 行，位於 <${insideP}> 裡`);
    if (P_LIKE.has(name)) inside = name;
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    nestingViolations(node[key], inside, out);
  }
}

// 反空轉：同一支掃描器要抓得到修好之前的寫法。
{
  const before = parseTsx(
    `const X = () => <div><p className="text-sm font-medium">{name}<ApprovalStatusBadge status="pending" /></p></div>;`,
  );
  const out = [];
  nestingViolations(before.program, null, out);
  check("反空轉：修好之前的寫法會被抓到", out.length, 1);
}
for (const rel of NESTING_FILES) {
  const out = [];
  nestingViolations(parseTsx(readSource(rel)).program, null, out);
  check(`${rel}：<p> 裡沒有區塊元素`, out, []);
}

finish();
