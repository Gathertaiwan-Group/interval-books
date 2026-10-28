#!/usr/bin/env node
/**
 * news-expiry-selftest.mjs —— 過期的最新消息不在前台顯示（2026-10-28）
 *
 * 業主：「過期的最新消息，就不顯示了」。news 表沒有結束日欄位，從 display_date 推：
 *
 *   [純函式] src/lib/news-expiry.ts：parseNewsEndDate / isNewsExpired / liveNews
 *            · 三種分隔、區間五種寫法、省略年／年月、跨年、取最後一個日期
 *            · 不合法日期、讀不懂、空白 → null（永不過期）
 *            · 台北日界：結束日當天 23:59:59 仍顯示，隔天 00:00 隱藏
 *   [純函式] src/lib/taipei-time.ts：taipeiToday
 *   [靜態]   fetchNews／fetchNewsTicker 套用 liveNews，且過濾在退回內建消息之後；
 *            /news 有三語空狀態；後台列表有「已過期・前台不顯示」、表單有規則說明與即時預覽
 *
 * 不碰任何資料庫。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/news-expiry-selftest.mjs";

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
function readFile(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`selftest 讀不到檔案：${rel}`);
  return readFileSync(abs, "utf8");
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const N = await import(join(ROOT, "src/lib/news-expiry.ts"));
const T = await import(join(ROOT, "src/lib/taipei-time.ts"));
const P = N.parseNewsEndDate;

console.log("\n[1] parseNewsEndDate：單一日期");
check("YYYY.MM.DD", P("2026.04.28"), "2026-04-28");
check("YYYY/MM/DD", P("2026/05/02"), "2026-05-02");
check("YYYY-MM-DD", P("2026-05-02"), "2026-05-02");
check("一位數月日 2026.5.2", P("2026.5.2"), "2026-05-02");
check("前後有字（週六 2026.05.02 14:00）", P("週六 2026.05.02 14:00"), "2026-05-02");
check("全形數字與符號 ２０２６．０５．０２", P("２０２６．０５．０２"), "2026-05-02");

console.log("\n[2] parseNewsEndDate：區間（取結尾）");
check("《海的聲音》2026.10.20~11.7 → 省略年", P("2026.10.20~11.7"), "2026-11-07");
check("en dash 2026.05.22–05.24", P("2026.05.22–05.24"), "2026-05-24");
check("em dash 2026.05.22—05.24", P("2026.05.22—05.24"), "2026-05-24");
check("hyphen 2026.05.22-05.24", P("2026.05.22-05.24"), "2026-05-24");
check("全形波浪 2026.05.22～05.24", P("2026.05.22～05.24"), "2026-05-24");
check("至 2026/05/22 至 06/01", P("2026/05/22 至 06/01"), "2026-06-01");
check("到 2026.05.22到5.24", P("2026.05.22到5.24"), "2026-05-24");
check("dash 格式 2026-05-22-05-24", P("2026-05-22-05-24"), "2026-05-24");
check("省略年月 2026.05.22–24", P("2026.05.22–24"), "2026-05-24");
check("省略年月且跨月 2026.10.30–2", P("2026.10.30–2"), "2026-11-02");
check("跨年 2026.12.28~1.3 → 隔年", P("2026.12.28~1.3"), "2027-01-03");
check("結尾寫完整年 2026.12.28 ~ 2027.01.03", P("2026.12.28 ~ 2027.01.03"), "2027-01-03");
check("多個日期取最後一個", P("2026.04.01、2026.04.15、2026.05.01"), "2026-05-01");
check("區間後面是時間（~ 14:00）不當成日", P("2026.05.22 ~ 14:00"), "2026-05-22");
check("時間區間 2026.05.22 14:00-16:00 → 當天", P("2026.05.22 14:00-16:00"), "2026-05-22");

console.log("\n[3] parseNewsEndDate：讀不懂 → null（永不過期）");
check("2026.13.40", P("2026.13.40"), null);
check("2026.02.30", P("2026.02.30"), null);
check("2028.02.29 閏年合法", P("2028.02.29"), "2028-02-29");
check("2027.02.29 非閏年", P("2027.02.29"), null);
check("區間結尾不合法 2026.10.20~13.40", P("2026.10.20~13.40"), null);
check("區間結尾不合法 2026.02.20–31", P("2026.02.20–31"), null);
check("即將公告", P("即將公告"), null);
check("只有月日 05.22–05.24（缺年）", P("05.22–05.24"), null);
check("空字串", P(""), null);
check("null", P(null), null);
check("undefined", P(undefined), null);
check("長串數字不切出日期 120260502", P("120260502"), null);

console.log("\n[4] isNewsExpired 與台北日界");
check("結束日早於今天 → 過期", N.isNewsExpired("2026.04.28", "2026-10-28"), true);
check("結束日就是今天 → 不過期（整天都顯示）", N.isNewsExpired("2026.10.28", "2026-10-28"), false);
check("結束日在未來 → 不過期", N.isNewsExpired("2026.10.20~11.7", "2026-10-28"), false);
check("讀不懂 → 不過期", N.isNewsExpired("即將公告", "2099-01-01"), false);
check(
  "台北 11/7 23:59:59（UTC 15:59:59）",
  T.taipeiToday(new Date("2026-11-07T15:59:59Z")),
  "2026-11-07",
);
check(
  "台北 11/8 00:00（UTC 11/7 16:00）",
  T.taipeiToday(new Date("2026-11-07T16:00:00Z")),
  "2026-11-08",
);
check(
  "11.7 結束：台北 11/7 23:59:59 仍顯示",
  N.isNewsExpired("2026.10.20~11.7", T.taipeiToday(new Date("2026-11-07T15:59:59Z"))),
  false,
);
check(
  "11.7 結束：台北 11/8 00:00 隱藏（UTC 還是 11/7）",
  N.isNewsExpired("2026.10.20~11.7", T.taipeiToday(new Date("2026-11-07T16:00:00Z"))),
  true,
);

console.log("\n[5] liveNews（正式庫 2026-10-28 的四則）");
const prod = [
  { id: "b51ec822", date: "2026.10.20~11.7" },
  { id: "n-1", date: "2026.04.28" },
  { id: "n-2", date: "2026.05.02" },
  { id: "n-3", date: "2026.05.22–05.24" },
];
check(
  "2026-10-28 只剩《海的聲音》",
  N.liveNews(prod, "2026-10-28").map((n) => n.id),
  ["b51ec822"],
);
check("2026-11-08 全部過期 → []", N.liveNews(prod, "2026-11-08"), []);
check(
  "讀不懂的保留、順序不變",
  N.liveNews(
    [
      { id: "a", date: "即將公告" },
      { id: "b", date: "2020.01.01" },
      { id: "c", date: "" },
    ],
    "2026-10-28",
  ).map((n) => n.id),
  ["a", "c"],
);

console.log("\n[6] 呼叫端");
const cms = stripComments(readFile("src/lib/cms.ts"));
const fn = (name) => {
  const at = cms.indexOf(`export async function ${name}(`);
  return cms.slice(at, cms.indexOf("\n}\n", at));
};
check(
  "fetchNews 回傳 liveNews(...)",
  /return liveNews\(await fetchAllNews\(\), taipeiToday\(now\)\)/.test(fn("fetchNews")),
  true,
);
const allNews = cms.slice(cms.indexOf("async function fetchAllNews("));
check(
  "fetchAllNews 裡面不過濾（過濾在退回內建消息之後）",
  allNews.slice(0, allNews.indexOf("\n}\n")).includes("liveNews"),
  false,
);
const ticker = fn("fetchNewsTicker");
check(
  "fetchNewsTicker 先 liveNews 再取前 limit 則",
  /liveNews\(mapped, taipeiToday\(now\)\)\.slice\(0, limit\)/.test(ticker),
  true,
);
check("fetchNewsTicker 過濾後不再退回內建消息", /liveNews[\s\S]*fallback\(\)/.test(ticker), false);
const newsPage = readFile("src/routes/news.tsx");
check("/news 空狀態：news.length === 0", newsPage.includes("news.length === 0"), true);
check(
  "/news 空狀態三語齊備",
  /empty: \{\s*zh: "[^"]+",\s*en: "[^"]+",\s*ja: "[^"]+"/.test(newsPage),
  true,
);
const adminList = readFile("src/routes/admin/_shell.news.tsx");
check(
  "後台列表用 isNewsExpired 標記",
  adminList.includes("isNewsExpired(n.display_date, today)"),
  true,
);
check("後台列表徽章文字", adminList.includes("已過期・前台不顯示"), true);
check(
  "後台列表 loader 不過濾（仍是 listNews 全部）",
  stripComments(adminList).includes("liveNews"),
  false,
);
const form = readFile("src/components/admin/NewsForm.tsx");
check("表單規則說明", form.includes("結束日期過後，前台自動隱藏；日期無法辨識時一律顯示"), true);
check(
  "表單即時預覽用 parseNewsEndDate(text)",
  form.includes("parseNewsEndDate(text)") && form.includes("<EndDatePreview text={field.value} />"),
  true,
);
const mcp = readFile("src/server/mcp/tools.ts");
check("MCP 讀取不套用過期過濾", mcp.includes("news-expiry"), false);

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
