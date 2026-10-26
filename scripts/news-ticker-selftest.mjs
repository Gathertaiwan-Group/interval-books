#!/usr/bin/env node
/**
 * news-ticker-selftest.mjs —— 首頁「最新消息」改成頁首下方的單行輪播列（2026-10-26）
 *
 * 業主：「這塊移除，最新消息改成用跑馬燈的形式」。原本首頁底部是三張長卡片（含摘要全文）
 * ＋「查看全部 →」；現在改成頁首下方一條 42px 的單行淡入淡出輪播（src/components/NewsTicker.tsx）。
 *
 *   [靜態] 首頁：不再有那三張卡片；loader 平行讀 fetchNewsTicker(6)；<NewsTicker> 是頁面第一塊
 *   [靜態] fetchNewsTicker 只 select 標題與日期（摘要／內文不搬到首頁）
 *   [靜態] 元件：沒消息不出現、非當前則 aria-hidden＋tabIndex -1、有暫停鈕、
 *          不用 toLocale*（SSR 一致）、減少動態時不啟動計時
 *   [靜態] /news 每張卡有錨點 id（跑馬燈連 /news#news-<id>），且 /news 仍讀 fetchNews()
 *   [靜態] styles.css：固定高度、reduced-motion 分支存在
 *
 * 不碰任何資料庫。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/news-ticker-selftest.mjs";

let pass = 0;
let fail = 0;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
function checkTrue(label, cond) {
  if (cond) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
  }
}
function readFile(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`selftest 讀不到檔案：${rel}`);
  return readFileSync(abs, "utf8");
}
/** 剝掉註解，避免說明文字裡提到的字串讓檢查誤判。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const home = stripComments(readFile("src/routes/index.tsx"));
const ticker = stripComments(readFile("src/components/NewsTicker.tsx"));
const news = stripComments(readFile("src/routes/news.tsx"));
const cms = stripComments(readFile("src/lib/cms.ts"));
const css = readFile("src/styles.css");

console.log("\n[1] 首頁：卡片區拿掉、改放輪播列");
checkTrue("首頁不再用 fetchNews()（三張長卡片的資料來源）", !/fetchNews\(\)/.test(home));
checkTrue("首頁不再印 latestNews 區塊標題", !home.includes("ui.sections.latestNews"));
checkTrue("首頁不再印消息摘要 n.summary", !home.includes("n.summary"));
checkTrue("首頁 loader 讀 fetchNewsTicker(6)", home.includes("fetchNewsTicker(6)"));
const loader = home.slice(home.indexOf("loader:"), home.indexOf("head:"));
checkTrue(
  "fetchNewsTicker 與其他讀取一起放在 Promise.all 裡（平行，不多一段等待）",
  /Promise\.all\(\[[\s\S]*fetchNewsTicker\(6\)[\s\S]*\]\)/.test(loader),
);
const shellOpen = home.indexOf("<PageShell>");
const firstSection = home.indexOf("<section", shellOpen);
const tickerAt = home.indexOf("<NewsTicker", shellOpen);
checkTrue(
  "<NewsTicker> 是 PageShell 裡第一塊（緊貼頁首、在 hero 之上）",
  tickerAt > shellOpen && tickerAt < firstSection,
);

console.log("\n[2] fetchNewsTicker 只讀標題與日期");
const fnStart = cms.indexOf("export async function fetchNewsTicker");
const fn = cms.slice(fnStart, cms.indexOf("\nexport ", fnStart + 10));
checkTrue("cms.ts 有 fetchNewsTicker", fnStart >= 0);
checkTrue(
  'select 欄位是 "id,title,display_date,sort_order"',
  fn.includes('select("news", "id,title,display_date,sort_order"'),
);
checkTrue(
  "不 select summary / description",
  !/summary|description/.test(fn.split("FALLBACK_NEWS")[0]),
);

console.log("\n[3] NewsTicker 元件");
checkTrue(
  "沒有消息整條不出現（if (!count) return null）",
  /if \(!count\) return null/.test(ticker),
);
checkTrue("非當前那幾則 aria-hidden", /aria-hidden=\{exposed \? undefined : true\}/.test(ticker));
checkTrue("非當前那幾則連結 tabIndex -1", /tabIndex=\{exposed \? undefined : -1\}/.test(ticker));
checkTrue(
  "整條是有標籤的 region（aria-label）",
  /<section[\s\S]*?aria-label=\{label\}/.test(ticker),
);
checkTrue("不設 aria-live（換則不會一直被念）", !ticker.includes("aria-live"));
checkTrue(
  "有暫停／繼續鈕（WCAG 2.2.2）",
  ticker.includes("COPY.pause") && ticker.includes("COPY.play"),
);
checkTrue("hover 與 focus 都會暫停", /onMouseEnter/.test(ticker) && /onFocus/.test(ticker));
checkTrue(
  "減少動態時不啟動計時",
  /if \(!rotating \|\| paused \|\| reducedMotion\) return;/.test(ticker),
);
checkTrue("SSR 與 hydration 都從第 0 則開始（useState(0)）", ticker.includes("useState(0)"));
checkTrue("不用 toLocale*（日期字串照後台原樣，SSR 一致）", !/toLocale/.test(ticker));
checkTrue("每則連到 /news 的錨點（newsAnchorId）", ticker.includes("hash={newsAnchorId(n.id)}"));
checkTrue("「查看全部」連 /news", /to="\/news" className="news-ticker-all/.test(ticker));
for (const lang of ["zh", "en", "ja"]) {
  const ok = ["pause", "play", "prev", "next"].every((k) =>
    new RegExp(`${k}: \\{[^}]*\\b${lang}: "[^"]+"`).test(ticker),
  );
  checkTrue(`控制鈕文字 ${lang} 齊全`, ok);
}

console.log("\n[4] /news 頁");
checkTrue("/news 仍讀 fetchNews()", news.includes("fetchNews()"));
checkTrue("/news 每張卡有錨點 id={newsAnchorId(n.id)}", news.includes("id={newsAnchorId(n.id)}"));
checkTrue(
  "/news 仍印摘要與內文",
  news.includes("t(n.summary)") && news.includes("t(n.description)"),
);

console.log("\n[5] styles.css");
const block = css.slice(css.indexOf(".news-ticker {"));
checkTrue(
  "列高固定 42px（不會推動下面的版面）",
  /\.news-ticker-row \{[^}]*height: 42px;/.test(block),
);
checkTrue(
  "有 prefers-reduced-motion 分支",
  block.includes("@media (prefers-reduced-motion: reduce)"),
);
checkTrue("減少動態時改成可左右滑的一排", /overflow-x: auto/.test(block));
checkTrue("長標題省略號截斷", /\.news-ticker-title \{[^}]*text-overflow: ellipsis/.test(block));

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
