#!/usr/bin/env node
/**
 * lang-autodetect-selftest.mjs —— 依瀏覽器語系自動導向（2026-11）的行為測試。
 *
 * 測的是**上線的那一份原始碼**：src/lib/lang-autodetect.ts 的 DECIDE_AUTO_LANG_SRC（純函式）
 * 與 LANG_AUTODETECT_SCRIPT（<head> 的 inline script，在 vm 裡用假的 window／document 跑）。
 *
 *   [1] 純函式：各種 UA（爬蟲／預覽／一般瀏覽器）、語系、已有偏好、私密頁、中文限定頁、
 *       沒有翻譯（沒有 hreflang）、已在對應語言
 *   [2] inline script：會導就 location.replace（保留 query／hash）、寫下自動判斷結果；
 *       只導一次；手動選擇優先；localStorage 丟例外時用 cookie
 *   [3] 靜態守門：root head 輸出 script、伺服器不看 Accept-Language、切換鈕仍是 <a href>
 *
 * 執行：node scripts/lang-autodetect-selftest.mjs（或 npm test）
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/lang-autodetect-selftest.mjs";

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

const { DECIDE_AUTO_LANG_SRC, LANG_AUTODETECT_SCRIPT, LANG_CHOICE_KEY, LANG_AUTO_KEY } =
  await import("@/lib/lang-autodetect");
const { UNLOCALIZED_PREFIXES, ZH_ONLY_PATHS } = await import("@/lib/seo/i18n");

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
    console.log(
      red(
        `  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`,
      ),
    );
  }
}
const readFile = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${rel}`);
  const s = readFileSync(p, "utf8");
  if (!s) throw new Error(`selftest 讀到空檔：${rel}`);
  return s;
};

const decide = new Function(`${DECIDE_AUTO_LANG_SRC}\nreturn decideAutoLang;`)();

const UA = {
  chrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  safariIOS:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  googleApp:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/330.0.0 Mobile/15E148 Safari/604.1",
  googlebotSmartphone:
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  googlebotDesktop:
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/130.0.0.0 Safari/537.36",
  inspectionTool:
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Google-InspectionTool/1.0;)",
  adsbot: "AdsBot-Google (+http://www.google.com/adsbot.html)",
  bingbot:
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
  facebook: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  linePreview: "facebookexternalhit/1.1;line-poker/1.0",
  lineInApp:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.17.0",
  twitterbot: "Twitterbot/1.0",
  slackbot: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  discordbot: "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  crawler: "SomeCrawler/1.0",
  spider: "Baiduspider+(+http://www.baidu.com/search/spider.htm)",
  headless:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
};

const ALTS = (path) => ({
  "zh-Hant": `https://www.intervalbooks.tw${path}`,
  en: `https://www.intervalbooks.tw/en${path === "/" ? "" : path}`,
  ja: `https://www.intervalbooks.tw/ja${path === "/" ? "" : path}`,
  "x-default": `https://www.intervalbooks.tw${path}`,
});
const base = (over = {}) => ({
  ua: UA.chrome,
  languages: ["en-US", "en"],
  manual: null,
  auto: null,
  pathname: "/events",
  alternates: ALTS("/events"),
  privatePrefixes: UNLOCALIZED_PREFIXES,
  zhOnly: ZH_ONLY_PATHS,
  ...over,
});

console.log("[1] 純函式 decideAutoLang");
check("en-US Chrome 開 /events → /en/events", decide(base()), { lang: "en", path: "/en/events" });
check("en-GB → /en", decide(base({ languages: ["en-GB"] }))?.path, "/en/events");
check("ja-JP → /ja/events", decide(base({ languages: ["ja-JP", "ja", "en"] })), {
  lang: "ja",
  path: "/ja/events",
});
check("ja（無地區）→ /ja", decide(base({ languages: ["ja"] }))?.path, "/ja/events");
check("首頁 / → /en", decide(base({ pathname: "/", alternates: ALTS("/") }))?.path, "/en");
check(
  "首頁 / ja → /ja",
  decide(base({ pathname: "/", alternates: ALTS("/"), languages: ["ja-JP"] }))?.path,
  "/ja",
);
for (const zh of ["zh-TW", "zh-CN", "zh-HK", "zh-Hant-TW", "zh"]) {
  check(`${zh} 開中文頁 → 不導`, decide(base({ languages: [zh, "en-US"] })), null);
}
check(
  "zh-TW 開 /en/events → 導回中文 /events",
  decide(base({ languages: ["zh-TW"], pathname: "/en/events" })),
  { lang: "zh", path: "/events" },
);
check(
  "ja-JP 開 /en/events → /ja/events",
  decide(base({ languages: ["ja-JP"], pathname: "/en/events" }))?.path,
  "/ja/events",
);
check("en-US 開 /en/events（已對應）→ 不導", decide(base({ pathname: "/en/events" })), null);
check("第一偏好是韓文（ko-KR, en）→ 不導", decide(base({ languages: ["ko-KR", "en-US"] })), null);
check("第二偏好才是英文（zh-TW, en）→ 不導", decide(base({ languages: ["zh-TW", "en"] })), null);
check("languages 空 → 不導", decide(base({ languages: [] })), null);
check("'eng' 不是 en → 不導", decide(base({ languages: ["eng"] })), null);

for (const [name, ua] of Object.entries(UA)) {
  if (["chrome", "safariIOS", "androidChrome", "googleApp"].includes(name)) {
    check(`一般瀏覽器 ${name} → 導`, decide(base({ ua }))?.path, "/en/events");
  } else {
    check(`爬蟲／預覽 ${name} → 不導`, decide(base({ ua })), null);
  }
}
check("UA 空字串 → 不導", decide(base({ ua: "" })), null);

for (const m of ["zh", "en", "ja"]) {
  check(`手動選過 ${m} → 不導`, decide(base({ manual: m })), null);
}
check("手動值不合法（xx）→ 照常判斷", decide(base({ manual: "xx" }))?.path, "/en/events");
check("自動導過（auto=en）→ 不導", decide(base({ auto: "en" })), null);
check("自動導過（auto=zh）→ 不導", decide(base({ auto: "zh" })), null);

for (const p of [
  "/cart",
  "/checkout",
  "/checkout/complete",
  "/account",
  "/account/login",
  "/admin",
  "/admin/orders",
  "/Admin",
  "/vendor",
  "/auth/callback",
  "/oauth/authorize",
]) {
  check(
    `私密頁 ${p} → 不導（即使 head 有 hreflang）`,
    decide(base({ pathname: p, alternates: ALTS(p) })),
    null,
  );
}
for (const p of ZH_ONLY_PATHS) {
  check(`中文限定頁 ${p} → 不導`, decide(base({ pathname: p, alternates: ALTS(p) })), null);
  check(
    `中文限定頁 ${p}/（尾斜線）→ 不導`,
    decide(base({ pathname: `${p}/`, alternates: ALTS(p) })),
    null,
  );
}
check(
  "這一頁沒有英文 hreflang（翻譯不完整、不可收錄）→ 不導",
  decide(
    base({
      alternates: {
        "zh-Hant": "https://www.intervalbooks.tw/events",
        "x-default": "https://www.intervalbooks.tw/events",
      },
    }),
  ),
  null,
);
check("完全沒有 hreflang（404、私密頁）→ 不導", decide(base({ alternates: {} })), null);
check(
  "hreflang 指到的網址語言不對（防呆）→ 不導",
  decide(base({ alternates: { en: "https://www.intervalbooks.tw/events" } })),
  null,
);
check(
  "hreflang 是相對網址也可以",
  decide(base({ alternates: { en: "/en/events" } }))?.path,
  "/en/events",
);
check(
  "活動詳情頁 /events/abc → /en/events/abc",
  decide(base({ pathname: "/events/abc", alternates: ALTS("/events/abc") }))?.path,
  "/en/events/abc",
);

check(
  "舊版切換鈕記下的中文（interval-books-lang=zh）→ 當作手動、不導",
  decide(base({ legacy: "zh" })),
  null,
);
check(
  "舊 key 是 en（開 /en 頁也會寫）→ 照常判斷",
  decide(base({ legacy: "en" }))?.path,
  "/en/events",
);
check("從站內點過來（同源 referrer）→ 不導", decide(base({ sameOriginReferrer: true })), null);

console.log("\n[2] inline script（vm 模擬瀏覽器）");

function makeEnv({
  ua = UA.chrome,
  languages = ["en-US", "en"],
  href = "https://www.intervalbooks.tw/events?category=talk#list",
  alternates,
  storage = {},
  cookie = "",
  storageThrows = false,
  referrer = "",
  readyState = "loading",
} = {}) {
  const url = new URL(href);
  const alts = alternates ?? ALTS(url.pathname);
  const store = { ...storage };
  const replaced = [];
  let cookieJar = cookie;
  const localStorage = {
    getItem(k) {
      if (storageThrows) throw new Error("SecurityError");
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem(k, v) {
      if (storageThrows) throw new Error("SecurityError");
      store[k] = String(v);
    },
  };
  const links = Object.entries(alts).map(([hreflang, h]) => ({
    getAttribute: (a) => (a === "hreflang" ? hreflang : a === "href" ? h : null),
  }));
  const document = {
    readyState,
    referrer,
    querySelectorAll: (sel) => (sel === 'link[rel="alternate"][hreflang]' ? links : []),
    get cookie() {
      return cookieJar;
    },
    set cookie(v) {
      const [pair] = v.split(";");
      const name = pair.split("=")[0];
      const rest = cookieJar.split("; ").filter((c) => c && !c.startsWith(`${name}=`));
      cookieJar = [...rest, pair].join("; ");
    },
  };
  const location = {
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    protocol: url.protocol,
    host: url.host,
    replace: (to) => replaced.push(to),
  };
  const window = { localStorage, navigator: { userAgent: ua, languages, language: languages[0] } };
  const ctx = vm.createContext({ window, document, location, URL, RegExp, String });
  return {
    run: () => vm.runInContext(LANG_AUTODETECT_SCRIPT, ctx),
    window,
    replaced,
    store,
    cookie: () => cookieJar,
  };
}

{
  const env = makeEnv();
  env.run();
  check(
    "en-US 開 /events?category=talk#list → replace 到 /en/events 並保留 query／hash",
    env.replaced,
    ["/en/events?category=talk#list"],
  );
  check("記下自動判斷結果（localStorage）", env.store[LANG_AUTO_KEY], "en");
  check("記下自動判斷結果（cookie）", env.cookie().includes(`${LANG_AUTO_KEY}=en`), true);
  check("自動導向不算手動選擇", env.store[LANG_CHOICE_KEY], undefined);
}
{
  // 同一位訪客：導過一次後，又打開中文連結
  const env = makeEnv({ storage: { [LANG_AUTO_KEY]: "en" } });
  env.run();
  check("只導一次：已自動導過 → 不再導", env.replaced, []);
}
{
  // 自動導去 /en 之後手動切回中文 → 重新整理不再導
  const env = makeEnv({ storage: { [LANG_AUTO_KEY]: "en", [LANG_CHOICE_KEY]: "zh" } });
  env.run();
  check("手動切回中文後重新整理 → 不導", env.replaced, []);
}
{
  const env = makeEnv({ storage: { [LANG_CHOICE_KEY]: "zh" } });
  env.run();
  check("手動選過中文（沒有自動紀錄）→ 不導", env.replaced, []);
}
{
  const env = makeEnv({ storageThrows: true, cookie: `${LANG_CHOICE_KEY}=zh` });
  env.run();
  check("localStorage 不能用、cookie 有手動選擇 → 不導", env.replaced, []);
}
{
  const env = makeEnv({ storageThrows: true });
  env.run();
  check("localStorage 不能用 → 仍會導", env.replaced, ["/en/events?category=talk#list"]);
  check(
    "localStorage 不能用 → 自動紀錄寫進 cookie",
    env.cookie().includes(`${LANG_AUTO_KEY}=en`),
    true,
  );
  // 下一頁：cookie 已有紀錄
  const env2 = makeEnv({ storageThrows: true, cookie: env.cookie() });
  env2.run();
  check("localStorage 不能用 → 靠 cookie 只導一次", env2.replaced, []);
}
{
  const env = makeEnv({ ua: UA.googlebotSmartphone });
  env.run();
  check("Googlebot（en-US）→ 不導、不寫任何紀錄", [env.replaced, env.store], [[], {}]);
}
{
  const env = makeEnv({ languages: ["ja-JP", "ja"], href: "https://www.intervalbooks.tw/" });
  env.run();
  check("ja-JP 開首頁 → /ja", env.replaced, ["/ja"]);
}
{
  const env = makeEnv({ href: "https://www.intervalbooks.tw/cart", alternates: {} });
  env.run();
  check("購物車 → 不導", env.replaced, []);
}
{
  const env = makeEnv({ href: "http://localhost:5173/events" });
  env.run();
  check("本機：只取 hreflang 的路徑，留在同一個網域", env.replaced, ["/en/events"]);
}
{
  const env = makeEnv();
  env.run();
  env.run();
  check("同一個 document 重跑（TanStack 換頁時重插 script）→ 只導一次", env.replaced.length, 1);
  check("決定導向時設 __ibLangRedirecting", env.window.__ibLangRedirecting, 1);
}
{
  const env = makeEnv({ readyState: "complete" });
  env.run();
  check("hydration 之後才插入的 script（readyState≠loading）→ 不判斷", env.replaced, []);
}
{
  const env = makeEnv({ referrer: "https://www.intervalbooks.tw/en/events" });
  env.run();
  check("從站內頁點過來（中鍵開新分頁、封鎖 storage 時按「中」）→ 不導", env.replaced, []);
}
{
  const env = makeEnv({ referrer: "https://www.intervalbooks.tw.evil.example/" });
  env.run();
  check("referrer 是長得像的外站 → 仍照常判斷", env.replaced.length, 1);
}
{
  const env = makeEnv({ referrer: "https://www.google.com/" });
  env.run();
  check("從 Google 搜尋結果進站 → 導", env.replaced, ["/en/events?category=talk#list"]);
}
{
  const env = makeEnv({ storage: { "interval-books-lang": "zh" } });
  env.run();
  check("舊版切換鈕選過中文的老訪客 → 不導", env.replaced, []);
}
{
  const env = makeEnv({ ua: UA.googlebotSmartphone });
  env.run();
  check("Googlebot 不設 __ibLangRedirecting", env.window.__ibLangRedirecting, undefined);
}
{
  // script 自己出錯也不能讓頁面掛掉
  const ctx = vm.createContext({});
  let threw = false;
  try {
    vm.runInContext(LANG_AUTODETECT_SCRIPT, ctx);
  } catch {
    threw = true;
  }
  check("沒有 window／document 也不丟例外（整段 try/catch）", threw, false);
}
check("script 不含 </script", /<\/script/i.test(LANG_AUTODETECT_SCRIPT), false);

console.log("\n[3] 靜態守門");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const rootSrc = strip(readFile("src/routes/__root.tsx"));
check(
  "root head() 每一頁都輸出 LANG_AUTODETECT_SCRIPT（不加條件）",
  /scripts: \[\s*\{ children: LANG_AUTODETECT_SCRIPT \},/.test(rootSrc),
  true,
);
const serverSrc = strip(readFile("src/server.ts"));
check("伺服器不讀 Accept-Language", /accept-language/i.test(serverSrc), false);
check("伺服器不讀自動導向的 cookie", /interval-books-lang/.test(serverSrc), false);
const headerSrc = strip(readFile("src/components/SiteHeader.tsx"));
check(
  "語言切換仍是 <a href>（含 hrefLang、lang、aria-current）",
  /<a\s[^>]*href=\{switchLangHref\(/.test(headerSrc) &&
    /hrefLang=\{HTML_LANG\[code\]\}/.test(headerSrc) &&
    /lang=\{HTML_LANG\[code\]\}/.test(headerSrc) &&
    /aria-current=\{current \? "true" : undefined\}/.test(headerSrc),
  true,
);
check(
  "按切換鈕 = 手動選擇（writeLangChoice）",
  (headerSrc.match(/writeLangChoice\(code\)/g) ?? []).length,
  2,
);
check("切換鈕高度 ≥ 40px（h-10）", /SEGMENT_BASE =[\s\S]*?h-10/.test(headerSrc), true);
check("切換鈕有鍵盤焦點樣式", /focus-visible:outline/.test(headerSrc), true);
const hintSrc = strip(readFile("src/components/LanguageHint.tsx"));
check("「View in English」也算手動選擇", /writeLangChoice\(stored\)/.test(hintSrc), true);
const ctxSrc = strip(readFile("src/i18n/LanguageContext.tsx"));
check("LanguageProvider 不讀 navigator（SSR／hydration 一致）", /navigator\./.test(ctxSrc), false);

const ctxSrc2 = strip(readFile("src/i18n/LanguageContext.tsx"));
check("被自動導走的頁不寫記住的語言", /if \(isAutoRedirecting\(\)\) return;/.test(ctxSrc2), true);
const gaSrc = strip(readFile("src/lib/analytics.ts"));
check("被自動導走的頁不送 page_view", /if \(isAutoRedirecting\(\)\) return;/.test(gaSrc), true);

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
