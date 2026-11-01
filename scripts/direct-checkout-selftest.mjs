#!/usr/bin/env node
/**
 * direct-checkout-selftest.mjs —— 直接結帳（活動頁 →「我要報名」→ /checkout）的自檢
 *
 * ── 這一支守的是什麼 ───────────────────────────────────────────────────────
 * 這一期讓活動頁多了一個結帳入口。src/routes/events.$slug.tsx 原本有一段註解明確反對
 * 這件事，理由是「第二個入口就是第二份那段邏輯，兩份遲早會長歪成『活動頁讓你買 5 個
 * 位子、那一場只剩 1 個』」。那個擔心是對的，所以這一支要證明的是**那兩份沒有出現**：
 *
 *   · 數量上限只有一份 —— 一律是 cartInputFor().limit（src/lib/cart.ts:395），
 *     直接結帳這一側沒有第二個算式；
 *   · 下單管線只有一條 —— 仍然走 placeOrder() → createOrder()，這一側不建立訂單；
 *   · 🔴 而且直接結帳的訂單**不可以清購物車** —— clear() 是清空整個購物車、不分辨訂單
 *     從哪裡來，所以一個購物車裡放著兩本書的客人跑完直接報名並付款成功，那兩本書會
 *     一起消失。
 *
 * ── 為什麼這一支大部分是「真的跑」而不是「讀原始碼」───────────────────────
 * 上面三條的錯法**全部都是靜默的**：數量被夾錯不會丟例外、購物車被清掉不會有錯誤畫面。
 * 讀原始碼比對字串證明不了「夾出來的數字是 1 還是 5」，所以這一支：
 *
 *   [執行] `await import()` **產線上真正跑的那兩個模組**（src/lib/direct-checkout.ts 與
 *          src/lib/cart.ts，含 zustand store 本人），拿真的商品／場次餵進去看它回什麼。
 *          購物車那一段是真的把兩本書放進 store，再跑一次「該不該清」的判斷，然後數
 *          store 裡還剩幾本。
 *
 *   [靜態] 只留給「執行證明不了的形狀」：路由有沒有接上、有沒有人偷加第二個算式、
 *          /checkout/complete 有沒有繞過那個判斷。
 *
 * ⚠️ 這一支不連任何資料庫，也不需要任何憑證，所以在任何機器上都會整支跑完。
 *
 * ── 🔴 這個 repo 出過十一次假陽性，所以 ────────────────────────────────────
 * · readFile 讀不到檔案就丟例外（不回空字串 —— 見 run-selftests.mjs 的「守門 4」）；
 * · 每一條「A 不可以出現」旁邊都配一條「B 真的出現了」的對照組，否則整組斷言會在
 *   被測目標被改名／搬走之後靜默轉綠；
 * · 上限那一組刻意用**兩個名額不同的場次**，而且斷言「跨場次最大值真的是 5」——
 *   沒有那一條的話，「夾出來是 1」在單場次的假資料上是自動成立的，測不到那個 bug。
 *
 * 執行：node scripts/direct-checkout-selftest.mjs（或 npm test）
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/direct-checkout-selftest.mjs";

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

let pass = 0;
let fail = 0;

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

const checkTrue = (label, value) => check(label, Boolean(value), true);
const checkFalse = (label, value) => check(label, Boolean(value), false);

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串。
 *
 * 這一支底下有大量 `checkFalse("…沒有 X", src.includes("X"))` 的否定斷言。路徑一打錯
 * （或檔案被改名、搬走），`"".includes("X")` 就是 false，那條斷言**靜默通過**，從此永遠
 * 是綠的而且再也沒有在檢查任何東西。見 run-selftests.mjs 的「守門 4」。
 */
const readFile = (p) => {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) {
    throw new Error(
      `selftest 讀不到檔案：${abs}` +
        "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串 —— 回空字串會讓所有" +
        "「確認原始碼裡沒有 X」的否定斷言靜默通過。）",
    );
  }
  return readFileSync(abs, "utf8");
};

// 守著 readFile() 自己。
{
  const ghost = "__selftest-missing-file-probe__";
  let thrown = null;
  try {
    readFile(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 readFile() 讀不到檔案時丟例外，訊息指出是哪個路徑",
    thrown instanceof Error && thrown.message.includes(ghost),
  );
}

/** 把註解與字串剝掉，斷言才不會被檔頭那幾百行說明餵飽。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

/** 剝註解但**留字串**：要驗「這句話還在」的時候用這一支。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walkSrc(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkSrc(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}
const SRC_FILES = walkSrc(join(ROOT, "src"));

/**
 * 🔴 **不寫死路徑**：掃 src/ 找「誰 export 了這個名字」，而且要求剛好一個檔。
 *   · 0 個 → 被改名或刪掉了，底下的執行段全部失去意義；
 *   · ≥2 個 → 有第二份了，「產線上跑的是這一份」立刻不成立 —— 而這一支整支的主題
 *     就是「不可以有第二份」。
 */
function findSoleDefiner(exportName) {
  const hits = SRC_FILES.filter((f) =>
    new RegExp(`export\\s+(?:const|function|type)\\s+${exportName}\\b`).test(
      readFileSync(f, "utf8"),
    ),
  );
  check(
    `src/ 底下剛好一個檔 export ${exportName}`,
    hits.map((f) => relative(ROOT, f)),
    hits.length === 1 ? [relative(ROOT, hits[0])] : ["（剛好一個）"],
  );
  return hits.length === 1 ? hits[0] : null;
}

// =============================================================================
// [1] 載得起產線本人
// =============================================================================
console.log("\n[1] 載得起產線本人（不是複製品）");

const DIRECT_PATH = findSoleDefiner("buildDirectLine");
const CART_PATH = findSoleDefiner("cartInputFor");
if (!DIRECT_PATH || !CART_PATH) {
  console.log(red("  ✗ 找不到唯一的產線模組，後面的執行段無法進行"));
  console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail + 1}`);
  process.exit(1);
}
check(
  "直接結帳的規則住在 src/lib/direct-checkout.ts",
  relative(ROOT, DIRECT_PATH),
  "src/lib/direct-checkout.ts",
);
check("上限的來源住在 src/lib/cart.ts", relative(ROOT, CART_PATH), "src/lib/cart.ts");

/**
 * `@/` 是 tsconfig 的 alias，Node 不認得，所以用 module.registerHooks 補上
 * （與 scripts/event-assembler-selftest.mjs 同一招）。
 *
 * ⚠️ 另外 stub 掉 src/lib/supabase.ts，理由**只有一個**：那個模組在 import 的當下就讀
 *    `import.meta.env.VITE_SUPABASE_URL`，而 import.meta.env 是 Vite 的東西，在 Node
 *    底下是 undefined，一讀就 TypeError。被 stub 掉的是一個「建立資料庫連線」的模組，
 *    **不是任何一條被測邏輯** —— 下面 [2] 有一條斷言守著這件事（direct-checkout.ts
 *    不可以自己 import supabase），所以 stub 不可能把被測的東西一起換掉。
 */
if (typeof registerHooks !== "function") {
  console.log(red("  ✗ 這個 Node 沒有 module.registerHooks（需要 ≥ 22.15）"));
  console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail + 1}`);
  process.exit(1);
}
const SUPABASE_SRC = join(ROOT, "src/lib/supabase.ts");
checkTrue(
  "stub 的理由成立：supabase.ts 在 import 當下就讀 import.meta.env",
  /import\.meta\.env/.test(readFile("src/lib/supabase.ts")),
);
const SUPABASE_URL = pathToFileURL(SUPABASE_SRC).href;
let supabaseStubUsed = 0;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      const base = join(ROOT, "src", spec.slice(2));
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === SUPABASE_URL) {
      supabaseStubUsed += 1;
      return {
        format: "module",
        source: "export const supabase = null;\nexport const isSupabaseConfigured = false;\n",
        shortCircuit: true,
      };
    }
    return next(url, ctx);
  },
});

/**
 * 瀏覽器儲存的替身。真的存得進去、讀得回來，而且可以被切成「一碰就丟例外」——
 * 無痕模式與「封鎖網站資料」就是那個樣子，而那時候的正確行為是**退回舊行為**
 * （清購物車），不是整頁炸掉。
 */
function makeStorage() {
  const map = new Map();
  return {
    throws: false,
    getItem(k) {
      if (this.throws) throw new Error("storage blocked");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (this.throws) throw new Error("storage blocked");
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
}
// 必須在 import 之前掛上：cart.ts 的 createJSONStorage(() => localStorage) 在模組初始化
// 那一刻就會去拿它。
globalThis.localStorage = makeStorage();
globalThis.sessionStorage = makeStorage();

const direct = await import(pathToFileURL(DIRECT_PATH).href);
const cart = await import(pathToFileURL(CART_PATH).href);
const {
  buildDirectLine,
  resolveDirectCheckout,
  parseDirectCheckoutSearch,
  isDirectCheckout,
  directSeatLimit,
  directAnySeatsLeft,
  directSoleSession,
  directCheckoutSearch,
  rememberCartKept,
  cartKeptForOrder,
  shouldClearCartAfterOrder,
  DIRECT_MAX_QTY,
} = direct;
const { cartInputFor, keyOfLine, cartLineKey, useCart } = cart;

checkTrue("直接結帳模組載起來了", typeof buildDirectLine === "function");
checkTrue("購物車模組載起來了（含 zustand store 本人）", typeof useCart?.getState === "function");
check("supabase 只被 stub 過一次（沒有被拿來換掉別的模組）", supabaseStubUsed, 1);

// -----------------------------------------------------------------------------
// 假資料。**兩個場次、名額不同** —— 這是這一支最重要的一組資料，見檔頭。
// -----------------------------------------------------------------------------
const L = (s) => ({ zh: s, en: s, ja: s });
// ⚠️ startsAt 預設在很遠的未來：場次開始後不收新訂單（isSessionClosedForBooking），
//    寫死一個會過去的日期，這一支會在那一天自己轉紅。測「已開始」的地方另外傳。
const FUTURE_START = "2099-09-05T02:00:00.000Z";
function session(id, capacity, seatsTaken, sortOrder = 0, plans = [], startsAt = FUTURE_START) {
  return {
    id,
    productId: "prod-event",
    title: L(id),
    location: L("台北"),
    startsAt,
    endsAt: null,
    capacity,
    seatsTaken,
    sortOrder,
    // 0036：真正的 ShopSession 一定帶著 plans（toSession() 在 shop.ts 裡永遠會
    // 填這一欄），這裡補上預設空陣列讓假資料跟型別對得上。大部分測資不需要
    // 方案，用得到的地方另外傳。
    plans,
  };
}
function product(over = {}) {
  return {
    id: "prod-event",
    slug: "event-yokky-flow-0905",
    productType: "event",
    title: L("陶藝工作坊"),
    summary: L(""),
    description: L(""),
    price: 1800,
    compareAtPrice: null,
    stock: null,
    capacity: null,
    seatsTaken: 0,
    sessions: [],
    imageKey: null,
    requiresShipping: false,
    sortOrder: 0,
    availableCapped: null,
    ...over,
  };
}

// 早上那一場只剩 1 位，晚上那一場還有 5 位。
const MORNING = session("s-morning", 5, 4, 0);
const EVENING = session("s-evening", 5, 0, 1);
const EVENT = product({ sessions: [MORNING, EVENING] });
const BOOK = product({
  id: "prod-book",
  slug: "a-book",
  productType: "book",
  stock: 7,
  requiresShipping: true,
  sessions: [],
});

// =============================================================================
// [2] 上限只有一份
// =============================================================================
console.log("\n[2] 數量上限只有一份（cartInputFor）");

const directCode = stripTs(readFile("src/lib/direct-checkout.ts"));
checkTrue("直接結帳這一側真的呼叫 cartInputFor()", /cartInputFor\(/.test(directCode));
// 🔴 一出現就是第二份。四個名字都要守：算式可以長成任何一種。
for (const forbidden of ["remainingForSession", "remainingFor", "seatsTaken", "capacity"]) {
  checkFalse(
    `direct-checkout.ts 沒有自己算名額（${forbidden}）`,
    new RegExp(`\\b${forbidden}\\b`).test(directCode),
  );
}
// 對照組：那四個名字**真的**存在於 shop.ts，而且 cartInputFor 真的在用它們 ——
// 少了這一組，上面四條會在 shop.ts 改名之後靜默轉綠。
const cartCode = stripTs(readFile("src/lib/cart.ts"));
checkTrue(
  // 0036：cartInputFor() 多了方案分支（見 cart.ts 的 limit 算式），但沒有方案時
  // 落回的仍然是 remainingForSession(session) : remainingFor(p) 這兩個函式，
  // 一個字沒變——這裡改成分開驗證兩個子字串，不要求它們在同一行同一個位置。
  "對照組：cartInputFor 沒有方案時的 limit 仍然是 remainingForSession / remainingFor",
  /:\s*session\s*\?\s*remainingForSession\(session\)\s*:\s*remainingFor\(p\)/.test(cartCode),
);
checkTrue(
  "對照組：remainingForSession 真的定義在 shop.ts",
  /export function remainingForSession/.test(readFile("src/lib/shop.ts")),
);
// 這一側不建立訂單、不碰資料庫 —— 下單管線只有一條。
for (const forbidden of ["placeOrder", "createOrder", "supabase", "createServerFn"]) {
  checkFalse(
    `direct-checkout.ts 沒有第二條下單管線（${forbidden}）`,
    new RegExp(`\\b${forbidden}\\b`).test(directCode),
  );
}
// ⚠️ 參加者資料不可以搬進這個模組（會被寫進網址與 sessionStorage）。
for (const forbidden of ["participant", "Participant"]) {
  checkFalse(
    `direct-checkout.ts 不經手參加者資料（${forbidden}）`,
    new RegExp(forbidden).test(directCode),
  );
}
checkFalse("直接結帳不寫 localStorage（只用 sessionStorage）", /localStorage/.test(directCode));
checkTrue("直接結帳用的是 sessionStorage", /sessionStorage/.test(directCode));

// =============================================================================
// [3] 🔴 執行：上限是「選中那一場」的剩餘，不是跨場次最大值
// =============================================================================
console.log("\n[3] 執行：上限是選中那一場的剩餘");

// 對照組先立起來：跨場次最大值真的是 5。沒有這一條，「夾出來是 1」在只有一場的
// 假資料上是自動成立的 —— 那正是「只測一個案例，同組其他守衛沒人守」那種假陽性。
check("對照組：跨場次最大值是 5（拿它當上限就是那個 bug）", cartInputFor(EVENT, 1, null).limit, 5);
check("早上那一場的剩餘是 1", directSeatLimit(EVENT, MORNING), 1);
check("晚上那一場的剩餘是 5", directSeatLimit(EVENT, EVENING), 5);

const morning5 = buildDirectLine(EVENT, MORNING, 5);
checkTrue("早上那一場要 5 位 → 仍然組得出品項", morning5.ok);
check("🔴 早上那一場要 5 位 → 只給 1（不是跨場次的 5）", morning5.line.qty, 1);
check("而且會說「夾過了」", morning5.clamped, true);
check("記得原本要求的數量", morning5.requestedQty, 5);

const evening5 = buildDirectLine(EVENT, EVENING, 5);
check("晚上那一場要 5 位 → 真的給 5", evening5.line.qty, 5);
check("沒有被夾就不會謊稱夾過", evening5.clamped, false);

// =============================================================================
// [4] 執行：數量 0／負數／不是數字／超過剩餘
// =============================================================================
console.log("\n[4] 執行：亂七八糟的數量");

check("qty=0 → 1", buildDirectLine(EVENT, EVENING, 0).line.qty, 1);
check("qty=0 會說夾過了", buildDirectLine(EVENT, EVENING, 0).clamped, true);
check("qty=-3 → 1", buildDirectLine(EVENT, EVENING, -3).line.qty, 1);
check("沒帶 qty → 1", buildDirectLine(EVENT, EVENING, undefined).line.qty, 1);
check("沒帶 qty 不算被夾", buildDirectLine(EVENT, EVENING, undefined).clamped, false);
check("qty=NaN → 1（不是 NaN 個位子）", buildDirectLine(EVENT, EVENING, NaN).line.qty, 1);
check("qty=3 且還有 5 位 → 3", buildDirectLine(EVENT, EVENING, 3).line.qty, 3);
// 不管數量的商品（stock=null、availableCapped=null）也不可以讓網址開到天上去。
const looseBook = product({ id: "p-loose", slug: "loose", productType: "book", stock: null });
check("對照組：不管數量的商品沒有上限", cartInputFor(looseBook, 1, null).limit, null);
check(
  "沒有上限也夾在伺服器自己的 99 上",
  buildDirectLine(looseBook, null, 999999).line.qty,
  DIRECT_MAX_QTY,
);
check("DIRECT_MAX_QTY 與 checkoutPayloadSchema 的 max(99) 同一個數字", DIRECT_MAX_QTY, 99);
checkTrue(
  "對照組：伺服器端真的是 max(99)",
  /quantity:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\(99\)/.test(readFile("src/lib/checkout.ts")),
);
check("有庫存的書夾在庫存上", buildDirectLine(BOOK, null, 99).line.qty, 7);

// =============================================================================
// [5] 執行：網址參數什麼都不能相信
// =============================================================================
console.log("\n[5] 執行：網址參數的解析");

check("字串會 trim", parseDirectCheckoutSearch({ product: "  x  " }).product, "x");
check("空字串等於沒帶", parseDirectCheckoutSearch({ product: "   " }).product, undefined);
check("不是字串就當沒帶", parseDirectCheckoutSearch({ product: 42 }).product, undefined);
check("qty 是字串也讀得出來", parseDirectCheckoutSearch({ qty: "3" }).qty, 3);
check("qty 有小數就截斷", parseDirectCheckoutSearch({ qty: "2.7" }).qty, 2);
check(
  "qty 不是數字 → undefined（不是 NaN）",
  parseDirectCheckoutSearch({ qty: "abc" }).qty,
  undefined,
);
check("qty=Infinity → undefined", parseDirectCheckoutSearch({ qty: Infinity }).qty, undefined);
check("什麼都沒帶就不是直接結帳", isDirectCheckout(parseDirectCheckoutSearch({})), false);
check(
  "只帶 session 也不是直接結帳",
  isDirectCheckout(parseDirectCheckoutSearch({ session: "s-morning" })),
  false,
);
check(
  "帶了 product 才是",
  isDirectCheckout(parseDirectCheckoutSearch({ product: "event-yokky-flow-0905" })),
  true,
);
// 連結那一端與解析這一端用同一份組法。
check("按鈕帶的參數就是解析認得的那三個", directCheckoutSearch(EVENT, EVENING, 2), {
  product: "event-yokky-flow-0905",
  session: "s-evening",
  qty: 2,
});

// =============================================================================
// [6] 執行：網址被亂改的每一種，都有一個講得出名字的結果
// =============================================================================
console.log("\n[6] 執行：網址被亂改");

const CATALOGUE = [EVENT, BOOK];
const resolve = (search) => resolveDirectCheckout(CATALOGUE, parseDirectCheckoutSearch(search));

check("沒有 product → null（走原本的購物車路徑）", resolve({}), null);
check("不存在的商品 → product_gone", resolve({ product: "no-such-thing" }).reason, "product_gone");
check(
  "活動但沒帶場次 → session_required",
  resolve({ product: "event-yokky-flow-0905", qty: "2" }).reason,
  "session_required",
);
check(
  "不存在的場次 → session_gone",
  resolve({ product: "event-yokky-flow-0905", session: "s-ghost" }).reason,
  "session_gone",
);
// 別人家的場次也是 session_gone：場次是掛在 product.sessions 上比對的。
check(
  "別件商品的場次 → session_gone",
  resolveDirectCheckout([product({ id: "other", slug: "other-event", sessions: [] }), EVENT], {
    product: "other-event",
    session: "s-morning",
  }).reason,
  "session_gone",
);
const FULL = session("s-full", 3, 3, 0);
check(
  "額滿的場次 → sold_out",
  resolveDirectCheckout([product({ sessions: [FULL] })], {
    product: "event-yokky-flow-0905",
    session: "s-full",
  }).reason,
  "sold_out",
);
const okDirect = resolve({ product: "event-yokky-flow-0905", session: "s-evening", qty: "2" });
checkTrue("正常的網址 → 組得出品項", okDirect.ok);
check("數量正確", okDirect.line.qty, 2);
check("金額正確（單價來自目錄）", okDirect.line.price, 1800);
check("名稱正確", okDirect.line.title.zh, "陶藝工作坊");
check("場次名稱正確", okDirect.line.sessionTitle.zh, "s-evening");

// 🔴 書身上不可以帶場次：0020 的 order_items CHECK 不接受，帶過去會變成 23514。
const bookWithSession = resolve({ product: "a-book", session: "s-evening", qty: "2" });
checkTrue("書也走得通（同一條路，不是特例分支）", bookWithSession.ok);
check("🔴 書的 sessionId 一定是 null（網址上的場次被丟掉）", bookWithSession.line.sessionId, null);
// ⚠️ 上面那一條是**經過 resolveDirectCheckout** 的結果，而那一支對非活動商品本來就傳
//    null 進去 —— 所以它證明不了 buildDirectLine 自己會不會把場次丟掉。直接餵一次：
check(
  "🔴 直接餵 buildDirectLine 一本帶場次的書，場次照樣被丟掉",
  buildDirectLine(BOOK, EVENING, 1).line.sessionId,
  null,
);
check("而且仍然組得出品項", buildDirectLine(BOOK, EVENING, 1).ok, true);
check("書的數量照樣夾在庫存上", resolve({ product: "a-book", qty: "99" }).line.qty, 7);

// =============================================================================
// [6c] 🔴 執行：場次已經開始／結束 → session_ended（手動組網址的那個漏洞）
// =============================================================================
console.log("\n[6c] 🔴 執行：已開始的場次不能直接結帳");
{
  const START = "2026-09-05T02:00:00.000Z"; // 台北 9/5 10:00
  const t = Date.parse(START);
  const STARTED = session("s-started", 30, 3, 0, [], START);
  const cat = [product({ sessions: [STARTED, EVENING] }), BOOK];
  const go = (sessionId, now) =>
    resolveDirectCheckout(
      cat,
      { product: "event-yokky-flow-0905", session: sessionId, qty: 1 },
      now,
    );
  check("開始 1 秒後 → session_ended", go("s-started", t + 1000).reason, "session_ended");
  check("開始的那一刻（等於）→ session_ended", go("s-started", t).reason, "session_ended");
  check("開始後兩個月 → session_ended", go("s-started", t + 60 * 86400000).reason, "session_ended");
  checkTrue("開始前 1 秒 → 照常組得出品項", go("s-started", t - 1000).ok);
  checkTrue(
    "同一件商品的另一場（還沒開始）→ 照常組得出品項（逐場次判，不是整個活動）",
    go("s-evening", t + 1000).ok,
  );
  checkTrue(
    "書不受影響（就算網址帶了已開始的場次）",
    resolveDirectCheckout(cat, { product: "a-book", session: "s-started", qty: 1 }, t + 1000).ok,
  );
  // 已開始又額滿：講「已結束」，不講「滿了」（等待不會讓它回來）。
  const STARTED_FULL = session("s-started-full", 3, 3, 0, [], START);
  check(
    "已開始＋額滿 → session_ended（先判時間）",
    resolveDirectCheckout(
      [product({ sessions: [STARTED_FULL] })],
      { product: "event-yokky-flow-0905", session: "s-started-full" },
      t + 1000,
    ).reason,
    "session_ended",
  );
  // 不傳 now ＝ 現在時間。2026-09-05 已經過去，這一條證明預設值真的接上了時鐘。
  check(
    "不傳 now 時用現在時間（2026-09-05 的場次已開始）",
    resolveDirectCheckout(cat, { product: "event-yokky-flow-0905", session: "s-started" }).reason,
    "session_ended",
  );
}

// =============================================================================
// [7] 執行：sessionId / lineKey / productType 三樣都帶到底
// =============================================================================
console.log("\n[7] 執行：品項與購物車行完全等價");

const line = okDirect.line;
// (a) sessionId —— priceLines() 對 booking 且 sessionId === null 直接丟
//     product_unavailable（src/server/repos/orders.ts:334-336）。
check("sessionId 帶到底", line.sessionId, "s-evening");
checkTrue(
  "對照組：伺服器真的會拒絕沒有場次的 booking",
  /if \(w\.sessionId === null\) throw new CheckoutError\("product_unavailable"\);/.test(
    readFile("src/server/repos/orders.ts"),
  ),
);
// (b) productType —— /checkout 靠它決定要不要收參加者（字面值比較，兩處）。
check("productType 帶到底", line.productType, "event");
// (c) lineKey —— 參加者攤平陣列靠它對回所屬品項。
check("keyOfLine() 對這筆品項有效", keyOfLine(line), cartLineKey("prod-event", "s-evening"));
// 0036：key 多了第三段 planId，這一筆沒有方案所以是空字串——
// <productId>:<sessionId>:<planId ?? "">。
check("而且它長成 <productId>:<sessionId>:<planId>", keyOfLine(line), "prod-event:s-evening:");
checkTrue("lineKey 不是空字串（schema 要求 min(1)）", keyOfLine(line).length > 0);
checkTrue(
  "對照組：schema 真的要求 lineKey 至少一個字",
  /lineKey: z\.string\(\)\.trim\(\)\.min\(1\)/.test(readFile("src/lib/checkout.ts")),
);

// (e) 拿合成出來的 lineKey 去餵**真正的那個 zod schema**：欄位數要等於人數，
//     少一位就送不出去。這一條在瀏覽器上驗不到 —— 要驗它就得把整張表填到只差一格，
//     而那一格填下去就是在正式庫開一張真訂單、佔一個真座位。
const checkoutSchemaMod = await import(pathToFileURL(join(ROOT, "src/lib/checkout.ts")).href);
const zhOnly = (l) => (l && typeof l === "object" ? l.zh : String(l));
const schema = checkoutSchemaMod.checkoutFormSchemaWithParticipants({
  t: zhOnly,
  requireAddress: false,
  participantSlots: [{ lineKey: keyOfLine(line), count: 2 }],
});
const baseForm = {
  customerName: "王小明",
  customerEmail: "a@b.co",
  customerPhone: "0912345678",
  shippingMethod: "none",
  address: {},
  note: "",
  invoice: { type: "personal" },
};
const person = (name) => ({
  lineKey: keyOfLine(line),
  name,
  email: "x@y.co",
  phone: "",
  noticeAck: true,
});
checkTrue(
  "兩位都填 → 過得了 schema",
  schema.safeParse({ ...baseForm, participants: [person("甲"), person("乙")] }).success,
);
checkFalse(
  "🔴 少填一位 → 送不出去",
  schema.safeParse({ ...baseForm, participants: [person("甲")] }).success,
);
checkFalse("🔴 一位都沒填 → 送不出去", schema.safeParse({ ...baseForm, participants: [] }).success);
checkFalse(
  "🔴 有名字但沒勾同意 → 送不出去",
  schema.safeParse({
    ...baseForm,
    participants: [person("甲"), { ...person("乙"), noticeAck: false }],
  }).success,
);
checkFalse(
  "🔴 lineKey 對不上（貼到別行）→ 送不出去",
  schema.safeParse({
    ...baseForm,
    participants: [person("甲"), { ...person("乙"), lineKey: "prod-event:s-morning" }],
  }).success,
);
// (d) 欄位形狀 —— 與 cartInputFor 產出的購物車行**逐個欄位**相同，所以結帳頁那一側
//     不需要任何 if (直接結帳) 的分支。
check(
  "欄位集合與購物車行一模一樣",
  Object.keys(line).sort(),
  Object.keys(cartInputFor(EVENT, 2, EVENING)).sort(),
);
check("不帶 unavailable 旗標（那是購物車 sync 出來的東西）", "unavailable" in line, false);

// 整體還有沒有位子（拿來決定要不要畫報名區，不是數量上限）。
check("兩場中還有一場有位子 → true", directAnySeatsLeft(EVENT), true);
check("每一場都滿了 → false", directAnySeatsLeft(product({ sessions: [FULL] })), false);
check("一場都沒有 → false", directAnySeatsLeft(product({ sessions: [] })), false);

// =============================================================================
// [8] 🔴 執行：直接結帳的訂單不可以清購物車
// =============================================================================
console.log("\n[8] 🔴 執行：購物車裡的兩本書要活下來");

const store = useCart.getState();
store.clear();
// 真的把兩本書放進**產線上那個 zustand store**。
store.addItem(
  cartInputFor(product({ id: "b1", slug: "book-1", productType: "book", stock: 3 }), 1),
);
store.addItem(
  cartInputFor(product({ id: "b2", slug: "book-2", productType: "book", stock: 3 }), 1),
);
check("購物車裡有兩本書", useCart.getState().items.length, 2);

const DIRECT_TOKEN = "tok-direct-" + "a".repeat(20);
const CART_TOKEN = "tok-cart-" + "b".repeat(20);
rememberCartKept(DIRECT_TOKEN);
check("記得住「這張單不要動購物車」", cartKeptForOrder(DIRECT_TOKEN), true);
check("別張單不受影響", cartKeptForOrder(CART_TOKEN), false);

// /checkout/complete 那一下的判斷，逐字照跑一次。
const settled = { awaitingPayment: false };
check(
  "🔴 直接結帳 + 付款完成 → 不清購物車",
  shouldClearCartAfterOrder(settled, DIRECT_TOKEN),
  false,
);
if (shouldClearCartAfterOrder(settled, DIRECT_TOKEN)) useCart.getState().clear();
check("🔴 那兩本書還在", useCart.getState().items.length, 2);
check(
  "🔴 而且是原來那兩本",
  useCart
    .getState()
    .items.map((i) => i.slug)
    .sort(),
  ["book-1", "book-2"],
);

// 既有行為必須原封不動：購物車結帳付款完成 → 照樣清空。
check("購物車結帳 + 付款完成 → 清", shouldClearCartAfterOrder(settled, CART_TOKEN), true);
// 金流還沒回覆／刷卡失敗 → 不清（Realreal 把人丟在空購物車前的那個 bug 的修補）。
check(
  "還在等金流 → 不清（就算不是直接結帳）",
  shouldClearCartAfterOrder({ awaitingPayment: true }, CART_TOKEN),
  false,
);
check("找不到訂單 → 不清", shouldClearCartAfterOrder(null, CART_TOKEN), false);
check(
  "直接結帳的單也一樣要等金流",
  shouldClearCartAfterOrder({ awaitingPayment: true }, DIRECT_TOKEN),
  false,
);
// 真的清一次，證明上面那條 false 不是因為 clear 根本壞了。
if (shouldClearCartAfterOrder(settled, CART_TOKEN)) useCart.getState().clear();
check("對照組：購物車結帳那一條真的清得掉", useCart.getState().items.length, 0);

// =============================================================================
// [8b] 🔴 執行：購物車裡的場次之後開始了 → syncFromCatalogue 標 session_ended
// =============================================================================
console.log("\n[8b] 🔴 執行：購物車裡的過期場次");
{
  const PAST = session("s-past", 30, 3, 0, [], "2026-09-05T02:00:00.000Z");
  const SOON = session("s-soon", 30, 3, 0, [], FUTURE_START);
  // 放進購物車的那一刻場次還沒開始（目錄裡的 startsAt 是未來）……
  const before = product({ sessions: [session("s-past", 30, 3), SOON] });
  const BOOK2 = product({ id: "b9", slug: "book-9", productType: "book", stock: 5 });
  useCart.getState().clear();
  useCart.getState().addItem(cartInputFor(before, 1, before.sessions[0]));
  useCart.getState().addItem(cartInputFor(before, 2, SOON));
  useCart.getState().addItem(cartInputFor(BOOK2, 1));
  useCart.getState().syncFromCatalogue([before, BOOK2]);
  check(
    "放進去時三行都買得到",
    useCart.getState().items.map((i) => i.unavailable ?? "ok"),
    ["ok", "ok", "ok"],
  );
  // ……之後那一場開始了（目錄重讀，startsAt 已經過去）。
  const after = product({ sessions: [PAST, SOON] });
  useCart.getState().syncFromCatalogue([after, BOOK2]);
  const byKey = new Map(useCart.getState().items.map((i) => [i.sessionId ?? i.productId, i]));
  check("🔴 已開始的那一場 → session_ended", byKey.get("s-past")?.unavailable, "session_ended");
  check("那一行沒有被刪掉（客人要看得到是哪一場）", useCart.getState().items.length, 3);
  check("數量沒被改成 0", byKey.get("s-past")?.qty, 1);
  check("同一活動還沒開始的另一場照常可買", byKey.get("s-soon")?.unavailable, undefined);
  check("書照常可買", byKey.get("b9")?.unavailable, undefined);
  // 結帳頁與購物車頁的「能不能結帳」都看 unavailable（buyable／canCheckout）。
  check(
    "可結帳的行剩兩行（已開始的被排除在小計之外）",
    useCart.getState().items.filter((i) => !i.unavailable).length,
    2,
  );
  useCart.getState().clear();
}

// 旗標的邊界。
check("空 token 不會被當成「不要清」", cartKeptForOrder(""), false);
rememberCartKept(DIRECT_TOKEN);
rememberCartKept(DIRECT_TOKEN);
check("重複記同一張單不會變成兩筆", cartKeptForOrder(DIRECT_TOKEN), true);
for (let i = 0; i < 25; i++) rememberCartKept(`filler-${i}`);
check("記太多筆之後最舊的會被擠掉（清單不會無限長）", cartKeptForOrder(DIRECT_TOKEN), false);
check("最近的那幾筆還在", cartKeptForOrder("filler-24"), true);

// 儲存壞掉（無痕、封鎖網站資料）→ 退回舊行為，不是丟例外。
globalThis.sessionStorage.throws = true;
let threw = null;
try {
  rememberCartKept("tok-while-blocked");
  check(
    "儲存壞掉時 cartKeptForOrder 回 false（退回舊行為）",
    cartKeptForOrder(DIRECT_TOKEN),
    false,
  );
  check(
    "儲存壞掉時仍然清購物車（＝改動前的行為）",
    shouldClearCartAfterOrder(settled, DIRECT_TOKEN),
    true,
  );
} catch (e) {
  threw = e;
}
check("🔴 儲存壞掉不會把整頁炸掉", threw, null);
globalThis.sessionStorage.throws = false;

// =============================================================================
// [9] 結帳頁真的接上了這個模式
// =============================================================================
console.log("\n[9] /checkout 接上直接結帳");

const checkoutCode = stripTs(readFile("src/routes/checkout.index.tsx"));
checkTrue("路由有 validateSearch", /validateSearch:/.test(checkoutCode));
checkTrue(
  "解析走共用的 parseDirectCheckoutSearch",
  /parseDirectCheckoutSearch\(search\)/.test(checkoutCode),
);
checkTrue(
  "品項走共用的 resolveDirectCheckout",
  /resolveDirectCheckout\(\s*catalogue\.products/.test(checkoutCode),
);
// 🔴 上面那一條只看得到「有呼叫」，看不到**傳了什麼**。0036 加了 plan，而結帳頁的
//    解構與傳入各漏了一個，這條照樣全綠 —— 代價是正式庫只要有任何一個場次開了票種，
//    站內的「我要報名」就會撞 plan_required 錯誤頁。所以這裡改成逐欄比對。
//
//    欄位名單是從 DirectCheckoutSearch 的**型別本體**解出來的，不在這裡抄第二份：
//    日後型別多一個參數而呼叫端沒接上，這一組會自己轉紅。切不出來一律 throw ——
//    回一個空陣列會讓底下的迴圈一條都不跑，而「一條都不跑」跟「全部通過」在畫面上
//    長得一模一樣。
//    （解構漏欄位不必另外守：那會讓傳入的變數變成未定義，tsc 會先擋下來。）
const searchTypeBlock = /type DirectCheckoutSearch = \{([\s\S]*?)\n\};/.exec(directCode);
if (!searchTypeBlock) {
  throw new Error(
    "切不出 DirectCheckoutSearch 的型別本體 —— direct-checkout.ts 換了寫法就要一起改這支自檢",
  );
}
const searchFields = [...searchTypeBlock[1].matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]).sort();
// 對照組：確認解出來的真的是那四個，免得哪天 regex 改壞了還一路綠。
check("DirectCheckoutSearch 的欄位", searchFields.join(","), "plan,product,qty,session");

// 第三個參數是 loader 帶下來的判斷時間（場次是否已開始，見 session-ended-checkout-selftest）。
const directCallArg =
  /resolveDirectCheckout\(\s*catalogue\.products,\s*\{([\s\S]*?)\},\s*loadedAt,?\s*\)/.exec(
    checkoutCode,
  );
if (!directCallArg) {
  throw new Error(
    "切不出 resolveDirectCheckout 的第二個參數 —— checkout.index.tsx 換了寫法就要一起改這支自檢",
  );
}
for (const field of searchFields) {
  checkTrue(
    `resolveDirectCheckout 真的把 ${field} 傳下去（0036 漏掉的就是 plan）`,
    new RegExp(`(^|[\\s{,])${field}\\s*:`).test(directCallArg[1]),
  );
}
checkFalse("結帳頁沒有自己算名額", /\bremainingForSession\b|\bremainingFor\(/.test(checkoutCode));
// 🔴 直接結帳的訂單要留下「不要清購物車」的旗標，而且是在拿得到 token 的那一刻。
checkTrue(
  "🔴 建單成功後記下 rememberCartKept(result.publicToken)",
  /if \(directMode\) rememberCartKept\(result\.publicToken\);/.test(checkoutCode),
);
// 直接結帳不可以寫回購物車（syncFromCatalogue 會 set 進 store → localStorage）。
checkTrue(
  "直接結帳時不跑 syncFromCatalogue",
  /if \(directMode\) return;[\s\S]{0,200}syncFromCatalogue\(catalogue\.products\)/.test(
    checkoutCode,
  ),
);
// 四種失敗都要有畫面。switch 的四個 case 一個都不能少。
// ⚠️ 這一段要對 stripComments（**留字串**）跑：stripTs 會把 case 的字面值也剝成 ""，
//    那樣四條會全部假性轉紅。註解已經剝掉了，所以餵不飽它。
const checkoutWithStrings = stripComments(readFile("src/routes/checkout.index.tsx"));
const problemFn = /function directProblemText\([\s\S]*?\n\}/.exec(checkoutWithStrings)?.[0] ?? "";
checkTrue("切得出 directProblemText", problemFn.length > 80);
// 🔴 對到**自己**那一句，不是「對到某一句 PAGE.direct*」——後者會讓「四種原因指到同
//    一句話」靜默通過，而那正是「同一字面值在別處出現而餵飽斷言」那種假陽性。
const REASON_COPY = {
  product_gone: "directProductGone",
  session_required: "directSessionRequired",
  session_gone: "directSessionGone",
  // 0036：第五種原因——這一場開了方案但網址沒帶（或帶的不屬於這一場）。
  plan_required: "directPlanRequired",
  sold_out: "directSoldOut",
  // 第六種：場次已經開始／結束（isSessionClosedForBooking）。
  session_ended: "directSessionEnded",
};
for (const [reason, key] of Object.entries(REASON_COPY)) {
  checkTrue(
    `${reason} 對到自己那一句（PAGE.${key}）`,
    new RegExp(`case "${reason}":\\s*return PAGE\\.${key};`).test(problemFn),
  );
  // 那一句真的存在，而且三語都有 —— 不然上面那條對到的是一個 undefined。
  checkTrue(
    `PAGE.${key} 三語都有`,
    new RegExp(`${key}: \\{[\\s\\S]{0,400}?zh:[\\s\\S]{0,400}?en:[\\s\\S]{0,400}?ja:`).test(
      checkoutWithStrings,
    ),
  );
}
// 六種原因不可以共用同一句話（0036 加了 plan_required，從四種變五種；session_ended 第六種）。
check("六句文案互不相同", new Set(Object.values(REASON_COPY)).size, 6);
// 這幾種失敗要有自己的畫面，不可以掉回「購物車是空的」那個空狀態。
checkTrue(
  "🔴 直接結帳失敗時渲染自己的畫面",
  /if \(directMode && !direct\.ok\) \{[\s\S]{0,900}PAGE\.directProblemTitle/.test(checkoutCode),
);
checkTrue(
  "而且那個畫面有回得去的路",
  /if \(directMode && !direct\.ok\) \{[\s\S]{0,1600}PAGE\.backToEvents/.test(checkoutCode),
);
checkTrue(
  "目錄整個讀不到時另外講（不會謊稱找不到這件商品）",
  /catalogue\.unavailable \? t\(PAGE\.catalogueDown\)/.test(checkoutCode),
);
checkTrue(
  // 0036：多了 plan_required 這第五種——這一場開了方案但網址沒帶（或帶的不
  // 屬於這一場）。型別現在寫成多行 union（見 direct-checkout.ts），這裡改成
  // 逐個比對五個字面值都在，而不是釘死單行的排版。
  "對照組：六種原因就是 DirectFailureReason 的全部",
  (() => {
    const src = stripComments(readFile("src/lib/direct-checkout.ts"));
    const start = src.indexOf("export type DirectFailureReason =");
    const end = src.indexOf(";", start);
    const block = src.slice(start, end);
    const reasons = [
      "product_gone",
      "session_required",
      "session_gone",
      "plan_required",
      "sold_out",
      "session_ended",
    ];
    return (
      reasons.every((r) => block.includes(`"${r}"`)) &&
      (block.match(/"/g) ?? []).length === reasons.length * 2
    );
  })(),
);
// 下單管線仍然只有一條。
check(
  "結帳頁呼叫 placeOrder 剛好一次",
  (checkoutCode.match(/await placeOrder\(/g) ?? []).length,
  1,
);
checkTrue("送出時仍然帶 sessionId", /sessionId: l\.sessionId,/.test(checkoutCode));
checkTrue("參加者仍然靠 keyOfLine 分組", /const key = keyOfLine\(l\);/.test(checkoutCode));
// 參加者欄位數 = 這一行的座位數（quantity × planSeatsPerUnit，0036）。直接結帳
// 只有一行，沒有方案時 planSeatsPerUnit 恆為 1，所以「欄位數 = 網址帶的人數」這句
// 話對現有的直接結帳連結（陶作閱讀課那類）逐字成立；帶了方案的連結欄位數會是
// qty 的倍數，那正是雙人房這類方案存在的理由。
checkTrue(
  "🔴 參加者欄位數是座位數（quantity × planSeatsPerUnit），不是單位數本身",
  /\.map\(\(l\) => \(\{ line: l, lineKey: keyOfLine\(l\), count: l\.qty \* l\.planSeatsPerUnit \}\)\)/.test(
    checkoutCode,
  ),
);
checkTrue(
  "仍然照 productType 決定要不要收參加者",
  /l\.productType === "event" \|\| l\.productType === "journey"/.test(
    stripComments(readFile("src/routes/checkout.index.tsx")),
  ),
);

// ── 既有的「購物車 → 結帳」那條路沒有被動到 ──────────────────────────────
console.log("\n[9b] 購物車那條路原封不動");
checkTrue(
  "品項來源是二選一的三元式",
  /directMode \? directItems : hydrated \? storedItems : NO_ITEMS/.test(checkoutCode),
);
checkTrue(
  "非直接結帳時仍然 syncFromCatalogue",
  /syncFromCatalogue\(catalogue\.products\)/.test(checkoutCode),
);
checkTrue("購物車空的時候仍然有空狀態", /PAGE\.empty/.test(checkoutCode));
checkTrue(
  "空狀態只在非直接結帳時出現",
  /if \(!directMode && hydrated && buyable\.length === 0\)/.test(checkoutCode),
);
checkTrue(
  "仍然有「回到購物車」的連結",
  /to="\/cart"/.test(readFile("src/routes/checkout.index.tsx")),
);
// 這幾段是既有表單的骨架，一段都不可以在這一期消失。
for (const key of [
  "contactSection",
  "participantsSection",
  "shippingSection",
  "addressSection",
  "invoiceSection",
  "noteSection",
  "paymentSection",
  "summary",
]) {
  checkTrue(`既有表單仍然有 ${key} 這一段`, checkoutCode.includes(`PAGE.${key}`));
}

// =============================================================================
// [10] /checkout/complete 沒有繞過那個判斷
// =============================================================================
console.log("\n[10] /checkout/complete");

const completeRaw = readFile("src/routes/checkout.complete.tsx");
const completeCode = stripTs(completeRaw);
checkTrue(
  "清購物車前先問 shouldClearCartAfterOrder",
  /if \(!shouldClearCartAfterOrder\(order, token\)\) return;/.test(completeCode),
);
check("整頁只呼叫一次 clear()", (completeCode.match(/\bclear\(\);/g) ?? []).length, 1);
checkFalse(
  "沒有留著舊的無條件寫法",
  /if \(!order \|\| order\.awaitingPayment \|\| cleared\.current\) return;/.test(completeCode),
);
checkFalse(
  "沒有繞過判斷直接清",
  /cleared\.current = true;\s*clear\(\);\s*\}, \[order, clear\]/.test(completeCode),
);
// awaitingPayment 那一條（Realreal 的修補）必須還在，只是搬進了純函式裡。
checkTrue(
  "awaitingPayment 仍然是不清的理由之一",
  /if \(order\.awaitingPayment\) return false;/.test(
    stripComments(readFile("src/lib/direct-checkout.ts")),
  ),
);
checkTrue("重試付款的路還在（另一半修補）", /retryPayment/.test(completeCode));

// =============================================================================
// [11] 活動頁：報名入口在，但沒有第二份邏輯
// =============================================================================
console.log("\n[11] 活動頁的報名入口");

const eventCode = stripTs(readFile("src/routes/events.$slug.tsx"));
checkTrue(
  "報名按鈕連到 /checkout",
  /to="\/checkout"/.test(readFile("src/routes/events.$slug.tsx")),
);
checkTrue(
  // 0036：多了第四個參數 selectedPlan（沒有方案的場次它是 null，directCheckoutSearch()
  // 自己會決定網址要不要帶 plan 這個 key——呼叫端仍然只是把選中的方案原樣傳過去，
  // 不是自己組網址參數）。
  "參數走共用的 directCheckoutSearch()",
  /search=\{directCheckoutSearch\(product, selectedSession, qty, selectedPlan\)\}/.test(eventCode),
);
checkTrue(
  "上限問 directSeatLimit()",
  /directSeatLimit\(product, selectedSession, selectedPlan\)/.test(eventCode),
);
checkFalse("活動頁沒有自己算名額", /\bremainingForSession\b|\bremainingFor\(/.test(eventCode));
checkFalse("活動頁沒有碰購物車 store", /\buseCart\b|\baddItem\b/.test(eventCode));
checkFalse(
  "活動頁沒有 import @/lib/cart",
  /from "@\/lib\/cart"/.test(readFile("src/routes/events.$slug.tsx")),
);
checkFalse("活動頁沒有自己下單", /placeOrder|createOrder/.test(eventCode));
// 🔴 沒選場次就不可以有一條進得了結帳的路：那時候畫的是 <button disabled>，不是 <Link>。
checkTrue("沒選場次時渲染的是不能按的 button", /<button[\s\S]{0,80}disabled/.test(eventCode));
checkTrue("只有選了場次才畫 <Link to=/checkout>", /selectedSession \? \(\s*<Link/.test(eventCode));
// 沒選場次時數量也不可以被跨場次最大值撐開。
checkTrue(
  "沒選場次時上限鎖成 1",
  /selectedSession \? directSeatLimit\(product, selectedSession, selectedPlan\) : 1/.test(
    eventCode,
  ),
);

// -----------------------------------------------------------------------------
// 收尾
// -----------------------------------------------------------------------------
console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);

// =============================================================================
// [12] 只有一場就預選 —— directSoleSession()
// =============================================================================
// 由來：活動頁只有一場時，客人還要先點一下那唯一的選項才能按報名，多一道沒有意義的關卡。
// 但「幫客人選」在收錢前一步是敏感的，所以條件收得很緊：**剛好一場、而且沒額滿**。
console.log("\n[12] 只有一場就預選（directSoleSession）");

const SOLO_OPEN = session("s-solo", 10, 3, 0);
const SOLO_FULL = session("s-full", 5, 5, 0);

check(
  "剛好一場又有位子 → 回那一場",
  directSoleSession(product({ sessions: [SOLO_OPEN] }))?.id,
  "s-solo",
);
// 🔴 這一條是重點：兩場以上絕不預選。從多場裡挑一場，會讓「我選過了」與「系統幫我選了」
//    在畫面上長得一樣，而下一步就是收錢。
check("兩場 → 不預選", directSoleSession(EVENT), null);
// 🔴 額滿那一場預選了也按不下去，畫面會變成「已經選好卻不能報名」，比沒選更難懂。
check("剛好一場但額滿 → 不預選", directSoleSession(product({ sessions: [SOLO_FULL] })), null);
check("沒有場次 → 不預選", directSoleSession(product({ sessions: [] })), null);
check("書（本來就沒有場次）→ 不預選", directSoleSession(BOOK), null);
// 🔴 capacity 是壞資料（null）時不預選。機制是 `> 0`，不是 `?? 0`：JS 裡 `null - 0`
//    等於 0（不是 NaN），所以 remainingForSession() 回 0 就被擋下來了。
//    （這一條做過突變測試：拿掉 `> 0` 判斷它會轉紅；動 `?? 0` 不會——因為那段執行時
//    走不到，它只是型別需要。）
check(
  "capacity 是壞資料 → 不預選",
  directSoleSession(product({ sessions: [session("s-bad", null, 0, 0)] })),
  null,
);
// 回傳的是**那一場物件本人**，不是複製品：呼叫端會拿它去 directSeatLimit()，
// 拿到不同的物件會讓上限算在錯的場次上。
checkTrue(
  "回傳的是場次物件本人（同一個參考）",
  directSoleSession(product({ sessions: [SOLO_OPEN] })) === SOLO_OPEN,
);

// 路由真的用了它 —— 不是宣告了一支沒人呼叫的函式。
const detailSrc = readFile("src/routes/events.$slug.tsx");
checkTrue(
  "活動頁的 sessionId 初始值來自 directSoleSession()",
  /useState<string \| null>\(\s*\(\) => directSoleSession\(product\)\?\.id \?\? null,?\s*\)/.test(
    detailSrc,
  ),
);

if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
