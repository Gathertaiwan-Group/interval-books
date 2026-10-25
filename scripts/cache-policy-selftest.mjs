#!/usr/bin/env node
/**
 * cache-policy-selftest.mjs —— src/server/cache-policy.ts 的自檢（2026-09 前台
 * 載入速度優化：HTML 快取）
 *
 * ── 為什麼這支可以直接 import 產線程式碼，不像其他 selftest 大多掃原始碼文字 ──
 * 這個 repo 的 selftest 沒有 tsconfig paths 別名解析能力（純 `node
 * scripts/xxx.mjs`，沒有任何 loader），所以一般沒辦法直接 import 會用到
 * "@/..." 的模組。src/server/cache-policy.ts 刻意寫成**零 import**的純函式
 * 模組正是為了讓這支測試可以繞過那個限制——直接 import 真正的程式碼、呼叫真正
 * 的函式、斷言真正的回傳值，而不是用正則猜原始碼文字長什麼樣子。這是這個 repo
 * 目前唯一一支「執行受測程式碼」而非「靜態分析受測程式碼」的 selftest；能這樣
 * 做純粹是因為 cache-policy.ts 的 zero-import 限制，不是這裡引入了新的測試手法。
 *
 * ── 白名單制的核心風險，以及這支測試怎麼守 ──────────────────────────────────
 * /checkout/complete 帶 public_token、/account 是登入後的個人訂單——這兩類網址
 * 一旦被共用（s-maxage）快取存住，就是把 A 的訂單發給 B。這支測試因此不只測
 * 「白名單裡的路徑會被快取」，更重要的是測「敏感路徑不會被快取」，而且是兩層都
 * 測：
 *
 *   [2] 黑盒——直接呼叫 cacheControlFor()，對每一條敏感路徑斷言結果字面等於
 *       "no-store"，不管方法或狀態碼。
 *   [3] 白盒——直接檢查白名單陣列本身（cache-policy.ts 匯出的 __TEST_ONLY__）
 *       有沒有任何一條命中敏感關鍵字。這一段才是真正回應「有測試守著白名單：
 *       把一條敏感路由加進可快取清單，測試要變紅」——因為 cacheControlFor() 的
 *       敏感前綴判斷永遠贏（見 cache-policy.ts 的判斷順序），黑盒測試就算白名單
 *       被改壞也可能看不出來（敏感前綴那層會把結果救回 "no-store"）。白盒測試
 *       直接看資料本身，不會被那層防禦網擋住視線。
 *
 * ⚠️ 每一條斷言都做過突變測試（把產線那一行改壞、確認轉紅、再改回來），結果寫在
 *    交付回報裡。
 *
 * 這支測試不碰資料庫、不讀環境變數、不發網路請求。
 *
 * 執行：node scripts/cache-policy-selftest.mjs（或 npm test）
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  cacheControlFor,
  isSensitivePath,
  isWhitelistedPath,
  __TEST_ONLY__,
} from "../src/server/cache-policy.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/cache-policy-selftest.mjs";

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

const checkTrue = (label, value, hint) => check(label, value === true, true, hint);
const checkFalse = (label, value, hint) => check(label, value === false, true, hint);

/** 讀原始碼。檔案不存在 = 丟例外，不是回空字串（見 run-selftests.mjs 守門 4）。 */
const readFile = (p) => {
  if (!existsSync(p)) {
    throw new Error(`selftest 讀不到檔案：${p} —— 路徑打錯或檔案被搬走了，不是「檔案是空的」。`);
  }
  return readFileSync(p, "utf8");
};

// =============================================================================
// [0] 反空殼
// =============================================================================
console.log("\n[0] 反空殼 —— 模組真的 import 得到、匯出的東西都在");
checkTrue(
  "src/server/cache-policy.ts 讀得到",
  readFile(join(ROOT, "src/server/cache-policy.ts")).length > 500,
);
checkTrue("cacheControlFor 是函式", typeof cacheControlFor === "function");
checkTrue("isWhitelistedPath 是函式", typeof isWhitelistedPath === "function");
checkTrue("isSensitivePath 是函式", typeof isSensitivePath === "function");
checkTrue("__TEST_ONLY__ 有東西可測", typeof __TEST_ONLY__ === "object" && __TEST_ONLY__ !== null);

// =============================================================================
// [1] 白名單命中 —— 需求文字列出的九條，逐條測
// =============================================================================
console.log("\n[1] 白名單命中 —— GET + 200 一律回共用快取標頭");

const CACHEABLE_HEADER = __TEST_ONLY__.CACHEABLE_HEADER;
checkTrue("CACHEABLE_HEADER 含 s-maxage=60", CACHEABLE_HEADER.includes("s-maxage=60"));
checkTrue(
  "CACHEABLE_HEADER 含 stale-while-revalidate=600",
  CACHEABLE_HEADER.includes("stale-while-revalidate=600"),
);

const WHITELISTED_GET_200 = [
  "/",
  "/events",
  "/events/yokky-flow-0905",
  "/shop",
  "/shop/some-product-slug",
  "/about",
  "/privacy",
  "/news",
  "/journeys",
  "/journeys/some-journey-slug",
  "/publications",
  "/publications/tw-001",
];
for (const p of WHITELISTED_GET_200) {
  check(
    `cacheControlFor(${JSON.stringify(p)}, "GET", 200) 回共用快取標頭`,
    cacheControlFor(p, "GET", 200),
    CACHEABLE_HEADER,
  );
  checkTrue(`isWhitelistedPath(${JSON.stringify(p)}) 為 true`, isWhitelistedPath(p));
}

// 結尾斜線正規化：/shop/ 等同 /shop（純斜線，沒有 slug）。
check(
  'cacheControlFor("/shop/", "GET", 200) 等同 "/shop"（結尾斜線正規化）',
  cacheControlFor("/shop/", "GET", 200),
  CACHEABLE_HEADER,
);
check(
  'cacheControlFor("/events/", "GET", 200) 等同 "/events"',
  cacheControlFor("/events/", "GET", 200),
  CACHEABLE_HEADER,
);

// =============================================================================
// [2] 黑盒——敏感路徑永遠 no-store，不管方法、不管狀態碼、不管白名單長怎樣
// =============================================================================
console.log('\n[2] 敏感路徑——cacheControlFor() 永遠回 "no-store"');

const NO_STORE_HEADER = __TEST_ONLY__.NO_STORE_HEADER;
check('NO_STORE_HEADER 字面等於 "no-store"', NO_STORE_HEADER, "no-store");

// 🔴 驗收條件逐一列出的六條，加上需求文字點名的 /api/*，以及這個 TanStack Start
// 版本 createServerFn 實際的 RPC 掛載點 /_serverFn（見 cache-policy.ts 檔頭）。
const SENSITIVE_ROUTES = [
  "/checkout",
  "/checkout/complete",
  "/account",
  "/account/login",
  "/admin/orders",
  "/vendor",
  "/api/whatever",
  "/_serverFn/someRpc",
];
for (const p of SENSITIVE_ROUTES) {
  check(
    `cacheControlFor(${JSON.stringify(p)}, "GET", 200) 回 "no-store"`,
    cacheControlFor(p, "GET", 200),
    NO_STORE_HEADER,
  );
  checkTrue(`isSensitivePath(${JSON.stringify(p)}) 為 true`, isSensitivePath(p));
  // 敏感路徑不管方法／狀態碼——連 POST、連 404，都不該被任何東西誤判成可以共用快取。
  check(
    `cacheControlFor(${JSON.stringify(p)}, "POST", 200) 仍是 "no-store"`,
    cacheControlFor(p, "POST", 200),
    NO_STORE_HEADER,
  );
  check(
    `cacheControlFor(${JSON.stringify(p)}, "GET", 404) 仍是 "no-store"`,
    cacheControlFor(p, "GET", 404),
    NO_STORE_HEADER,
  );
}

// 邊界：/accountability 不該被 "/account" 前綴誤傷（字首相符但不是同一個路徑家族）。
checkFalse(
  'isSensitivePath("/accountability") 為 false（不是 /account 的子路徑）',
  isSensitivePath("/accountability"),
);
check(
  'cacheControlFor("/accountability", "GET", 200) 不是 "no-store"（它也不在白名單，所以是 null）',
  cacheControlFor("/accountability", "GET", 200),
  null,
);

// =============================================================================
// [3] 白盒——白名單資料本身不能混進敏感關鍵字
// =============================================================================
console.log("\n[3] 白名單資料本身——不管 cacheControlFor() 的敏感前綴那層有沒有救回來");
// 這一段直接看 __TEST_ONLY__ 匯出的陣列，不透過 cacheControlFor()——見檔頭「為
// 什麼要兩層」。SENSITIVE_KEYWORDS 刻意比 SENSITIVE_PREFIXES 本身還寬（多了
// "public_token"、"login"、"order" 這些不是路徑前綴、但只要出現在白名單裡就代表
// 有問題的字），這樣「加了一條看起來人畜無害但其實是敏感頁的路徑」也抓得到。
const SENSITIVE_KEYWORDS = [
  "checkout",
  "account",
  "admin",
  "vendor",
  "/api",
  "_serverfn",
  "login",
  "public_token",
  "order",
];

const whitelistArrays = {
  CACHEABLE_EXACT_PATHS: __TEST_ONLY__.CACHEABLE_EXACT_PATHS,
  CACHEABLE_SINGLE_SEGMENT_PREFIXES: __TEST_ONLY__.CACHEABLE_SINGLE_SEGMENT_PREFIXES,
  CACHEABLE_OPEN_PREFIXES: __TEST_ONLY__.CACHEABLE_OPEN_PREFIXES,
};

for (const [arrName, arr] of Object.entries(whitelistArrays)) {
  checkTrue(`${arrName} 是陣列且非空`, Array.isArray(arr) && arr.length > 0);
  for (const entry of arr) {
    const lower = entry.toLowerCase();
    const hit = SENSITIVE_KEYWORDS.find((kw) => lower.includes(kw));
    checkTrue(
      `${arrName} 裡的 ${JSON.stringify(entry)} 不含敏感關鍵字`,
      hit === undefined,
      hit ? `命中關鍵字 "${hit}" —— 這一條看起來像是把敏感路徑加進了可快取白名單。` : undefined,
    );
  }
}

// 白名單九條，逐字比對——多一條、少一條、或字面被改掉，都要能看出來。
check(
  "CACHEABLE_EXACT_PATHS 逐字等於需求文字列出的五條＋/news（2026-10-26）",
  [...__TEST_ONLY__.CACHEABLE_EXACT_PATHS].sort(),
  ["/", "/about", "/events", "/news", "/privacy", "/shop"].sort(),
);
check(
  "CACHEABLE_SINGLE_SEGMENT_PREFIXES 逐字等於 /events/、/shop/",
  [...__TEST_ONLY__.CACHEABLE_SINGLE_SEGMENT_PREFIXES].sort(),
  ["/events/", "/shop/"].sort(),
);
check(
  "CACHEABLE_OPEN_PREFIXES 逐字等於 /journeys、/publications",
  [...__TEST_ONLY__.CACHEABLE_OPEN_PREFIXES].sort(),
  ["/journeys", "/publications"].sort(),
);
check(
  "SENSITIVE_PREFIXES 逐字等於 checkout/account/admin/vendor/api/_serverFn 六條",
  [...__TEST_ONLY__.SENSITIVE_PREFIXES].sort(),
  ["/_serverFn", "/account", "/admin", "/api", "/checkout", "/vendor"].sort(),
);

// =============================================================================
// [4] 不在白名單、也不是敏感路徑的一般頁面——完全不覆寫（回 null）
// =============================================================================
console.log("\n[4] 不認得的路徑——不動它，交回 Nitro/TanStack Start 的預設值");
const UNLISTED_PATHS = [
  "/news/anything",
  "/cart",
  "/contact",
  "/curated",
  "/curation",
  "/visit",
  "/random-nonsense",
];
for (const p of UNLISTED_PATHS) {
  check(
    `cacheControlFor(${JSON.stringify(p)}, "GET", 200) 回 null（不覆寫）`,
    cacheControlFor(p, "GET", 200),
    null,
  );
  checkFalse(`isWhitelistedPath(${JSON.stringify(p)}) 為 false`, isWhitelistedPath(p));
}

// =============================================================================
// [5] 方法／狀態碼把關——白名單路徑但不是安全的 GET/HEAD、或不是 200，一律不覆寫
// =============================================================================
console.log("\n[5] 白名單路徑，但方法或狀態碼不對——不給共用快取標頭");
check(
  'cacheControlFor("/shop", "POST", 200) 回 null（POST 不是安全方法）',
  cacheControlFor("/shop", "POST", 200),
  null,
);
check(
  'cacheControlFor("/shop", "GET", 404) 回 null（商品不存在的 404 不該被快取放大成一分鐘）',
  cacheControlFor("/shop", "GET", 404),
  null,
);
check(
  'cacheControlFor("/shop", "GET", 500) 回 null（暫時性錯誤不該被快取放大）',
  cacheControlFor("/shop", "GET", 500),
  null,
);
check(
  'cacheControlFor("/shop", "GET", 301) 回 null（轉址不快取）',
  cacheControlFor("/shop", "GET", 301),
  null,
);
check(
  'cacheControlFor("/shop", "HEAD", 200) 回共用快取標頭（HEAD 跟 GET 同樣安全）',
  cacheControlFor("/shop", "HEAD", 200),
  CACHEABLE_HEADER,
);

// =============================================================================
// [6] $slug 只准剛好多一段——比對到路由檔的實際形狀（events.$slug.tsx／shop.$slug.tsx）
// =============================================================================
console.log("\n[6] /events/$slug、/shop/$slug——剛好一段，不是任意深度");
check(
  'cacheControlFor("/events/a/b", "GET", 200) 回 null（兩段，不是 $slug）',
  cacheControlFor("/events/a/b", "GET", 200),
  null,
);
check(
  'cacheControlFor("/shop/a/b/c", "GET", 200) 回 null（三段）',
  cacheControlFor("/shop/a/b/c", "GET", 200),
  null,
);
checkFalse(
  'isWhitelistedPath("/events/") 為 false（斜線後面沒有東西不算 $slug，但它會被正規化成 /events 而在 [1] 命中——這裡改測真的多一段空字串的形狀）',
  isWhitelistedPath("/events//"),
);

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
