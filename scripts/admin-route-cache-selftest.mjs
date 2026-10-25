#!/usr/bin/env node
/**
 * admin-route-cache-selftest.mjs —— 後台提速第 1 批（2026-10-25）的自檢
 *
 * 守四件事：
 *   [1] src/lib/admin/route-cache.ts（直接 import 產線程式碼執行）
 *       · 只有 /admin/_shell 底下的 route 拿到 30 秒 staleTime／preloadStaleTime，前台一個都不動。
 *       · 寫入（POST）之後：不在畫面上的後台快取立刻清掉；下一次換頁完成時再清一次
 *         （剛離開的那一頁帶著寫入前的 loader 資料被搬進快取）。前台的快取不碰。
 *       · 換人登入：登入／登出、或 _shell 看到不一樣的 userId → 整個 router 快取清掉；
 *         同一個瀏覽器的其他分頁（BroadcastChannel）也跟著清。
 *   [2] 接線（靜態）：router.tsx、start.ts、_shell.tsx、login.tsx、pending.tsx、__root.tsx。
 *   [3] 整頁 fn：每一支都是 GET、都掛著跟原本那幾支一樣的 middleware；route 的 loader 用它們。
 *   [4] isBackOfficePath()：root loader 只在後台跳過前台的站台文案。
 *
 * 執行：node scripts/admin-route-cache-selftest.mjs（或 npm test）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-route-cache-selftest.mjs";
let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    fail += 1;
    console.log(
      `  \x1b[31m✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}\x1b[0m`,
    );
  }
}
const checkTrue = (label, v) => check(label, !!v, true);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const modUrl = pathToFileURL(join(ROOT, "src/lib/admin/route-cache.ts")).href;
const C = await import(modUrl);
const shellCache = await import(
  pathToFileURL(join(ROOT, "src/lib/admin/shell-user-cache.ts")).href
);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1a] staleTime 只給後台");
{
  const routes = {
    __root__: { id: "__root__", options: {} },
    "/": { id: "/", options: {} },
    "/events/$slug": { id: "/events/$slug", options: {} },
    "/admin/login": { id: "/admin/login", options: {} },
    "/admin/_shell": { id: "/admin/_shell", options: {} },
    "/admin/_shell/products": { id: "/admin/_shell/products", options: {} },
    "/admin/_shell/orders_/$id": {
      id: "/admin/_shell/orders_/$id",
      options: { preloadStaleTime: 12345 },
    },
  };
  const n = C.applyAdminRouteCacheDefaults(routes);
  check("補了 2 個（_shell 本身與前台不算）", n, 2);
  check("後台頁 staleTime 30 秒", routes["/admin/_shell/products"].options.staleTime, 30000);
  check(
    "後台頁 preloadStaleTime 30 秒",
    routes["/admin/_shell/products"].options.preloadStaleTime,
    30000,
  );
  check(
    "route 自己寫的值優先（訂單內頁）",
    routes["/admin/_shell/orders_/$id"].options.preloadStaleTime,
    12345,
  );
  check("🔴 前台 route 不動（名額、庫存一直在變）", routes["/events/$slug"].options, {});
  check("root 不動", routes.__root__.options, {});
  check("登入頁不動", routes["/admin/login"].options, {});
  check("_shell 本身不動（它沒有 loader）", routes["/admin/_shell"].options, {});
  check("再跑一次不會覆蓋", C.applyAdminRouteCacheDefaults(routes), 2);
}

// 假 router：記下 clearCache 被怎麼叫、讓測試自己觸發 onResolved。
function fakeRouter(cachedRouteIds) {
  const r = {
    cache: [...cachedRouteIds],
    calls: [],
    listeners: [],
    clearCache(opts) {
      r.calls.push(opts?.filter ? "filtered" : "all");
      r.cache = opts?.filter ? r.cache.filter((id) => !opts.filter({ routeId: id })) : [];
    },
    subscribe(event, fn) {
      if (event === "onResolved") r.listeners.push(fn);
      return () => {
        r.listeners = r.listeners.filter((f) => f !== fn);
      };
    },
    resolve() {
      for (const f of r.listeners) f();
    },
  };
  return r;
}

console.log("\n[1b] 寫入之後一定看得到自己剛改的");
{
  C.resetAdminRouteCacheForTests();
  C.noteAdminMutation(); // 還沒註冊 router：不可以炸
  const r = fakeRouter(["/admin/_shell/products", "/admin/_shell/events", "/events/$slug", "/"]);
  C.registerAdminCacheRouter(r);
  r.resolve();
  check("沒有寫入時，換頁完成不清快取", r.calls, []);
  C.noteAdminMutation();
  check("🔴 POST 之後立刻清後台快取", r.cache, ["/events/$slug", "/"]);
  // 剛離開的頁面被搬進快取（帶著寫入前的資料）
  r.cache.push("/admin/_shell/inventory-products");
  r.resolve();
  check("🔴 下一次換頁完成時再清一次（剛離開的那一頁）", r.cache, ["/events/$slug", "/"]);
  r.cache.push("/admin/_shell/news");
  r.resolve();
  check("清過一次就不再清（不是每次換頁都清）", r.cache, [
    "/events/$slug",
    "/",
    "/admin/_shell/news",
  ]);
  check(
    "前台快取從頭到尾沒被動過",
    r.cache.includes("/events/$slug") && r.cache.includes("/"),
    true,
  );
}

console.log("\n[1c] 換人登入不可以看到上一個人的資料");
{
  C.resetAdminRouteCacheForTests();
  const r = fakeRouter(["/admin/_shell/staff", "/"]);
  C.registerAdminCacheRouter(r);
  check("第一次看到登入者：不清", C.clearAdminRouteCacheOnIdentityChange("user-a"), false);
  check("同一個人：不清", C.clearAdminRouteCacheOnIdentityChange("user-a"), false);
  check("快取還在", r.cache.length, 2);
  check(
    "🔴 換了一個人（cookie 被別的分頁換掉）：整個清掉",
    C.clearAdminRouteCacheOnIdentityChange("user-b"),
    true,
  );
  check("清的是整個 router 快取", r.calls.at(-1), "all");
  r.cache = ["/admin/_shell/staff"];
  shellCache.shellUserCache.set({ userId: "user-b" }, Date.now());
  C.noteAdminIdentityChange();
  check("🔴 登入／登出：router 快取清掉", r.cache, []);
  check("🔴 登入／登出：「誰登入」快取也清掉", shellCache.shellUserCache.get(Date.now()), null);
}

console.log("\n[1d] 同一個瀏覽器的其他分頁也跟著清（BroadcastChannel）");
if (typeof BroadcastChannel === "undefined") {
  check("這個 Node 沒有 BroadcastChannel（略過）", true, true);
} else {
  C.resetAdminRouteCacheForTests();
  // 另一個「分頁」＝同一支程式的另一個模組實例
  const other = await import(`${modUrl}?tab=2`);
  const mine = fakeRouter(["/admin/_shell/orders"]);
  const theirs = fakeRouter(["/admin/_shell/orders", "/admin/_shell/staff"]);
  C.registerAdminCacheRouter(mine);
  other.registerAdminCacheRouter(theirs);
  let reloads = 0;
  other.setReloadPageForTests(() => reloads++);
  // 另一個分頁停在後台頁面上
  globalThis.window = { location: { pathname: "/admin/orders/123" } };
  C.noteAdminIdentityChange();
  await new Promise((r) => setTimeout(r, 50));
  check("🔴 另一個分頁的 router 快取被清掉", theirs.cache, []);
  check("🔴 另一個分頁停在後台 → 整頁重載（畫面上那一頁不在快取裡，只清快取擋不住）", reloads, 1);
  check("發出廣播的這個分頁自己不重載（它正在走登入／登出流程）", mine.calls.includes("all"), true);
  globalThis.window = { location: { pathname: "/events" } };
  C.noteAdminIdentityChange();
  await new Promise((r) => setTimeout(r, 50));
  check("另一個分頁停在前台 → 不重載", reloads, 1);
  delete globalThis.window;
  C.resetAdminRouteCacheForTests();
  other.resetAdminRouteCacheForTests();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] 接線");
{
  const router = stripComments(read("src/router.tsx"));
  checkTrue(
    "router.tsx 套用後台快取規則",
    /applyAdminRouteCacheDefaults\(router\.routesById\)/.test(router),
  );
  checkTrue(
    "router.tsx 只在瀏覽器端註冊",
    /typeof window !== "undefined"\)\s*\{[\s\S]{0,120}registerAdminCacheRouter\(router\)/.test(
      router,
    ),
  );
  checkTrue(
    "前台的預設值沒動（defaultPreloadStaleTime: 0）",
    /defaultPreloadStaleTime: 0/.test(router),
  );
  checkTrue("沒有全站 defaultPreload（前台不預載）", !/defaultPreload:/.test(router));
  checkTrue("沒有全站 defaultStaleTime（前台不快取）", !/defaultStaleTime:/.test(router));

  const start = stripComments(read("src/start.ts"));
  checkTrue(
    "start.ts 掛全域 function middleware",
    /functionMiddleware:\s*\[adminCacheInvalidation\]/.test(start),
  );
  checkTrue("只看 POST", /method !== "POST"/.test(start));
  checkTrue(
    "🔴 成功或失敗都通知（finally），只略過標成只讀的",
    /finally\s*\{\s*if \(!isReadOnlyServerFn\(serverFnMeta\?\.id\)\) noteAdminMutation\(\);/.test(
      start,
    ),
  );
  checkTrue(
    "只有 client 那一半（不是授權）",
    /\.client\(/.test(start) && !/\.server\(/.test(start),
  );

  const shell = stripComments(read("src/routes/admin/_shell.tsx"));
  checkTrue('側欄連結 preload="intent"', /<Link to=\{item\.to\} preload="intent">/.test(shell));
  checkTrue(
    "🔴 _shell 每次拿到登入者都比對 userId，換人就整頁重載到要去的網址",
    /clearAdminRouteCacheOnIdentityChange\(user\.userId\)\)\s*\{\s*window\.location\.assign\(location\.href\);/.test(
      shell,
    ),
  );
  checkTrue(
    "🔴 登出清「誰登入」與 router 快取",
    /noteAdminIdentityChange\(\);\s*router\.clearCache\(\);\s*await signOut\(\)/.test(shell),
  );
  checkTrue(
    "🔴 登入成功清快取",
    /signIn\(\{ data: values \}\);[\s\S]{0,300}noteAdminIdentityChange\(\);/.test(
      stripComments(read("src/routes/admin/login.tsx")),
    ),
  );
  checkTrue(
    "pending 頁登出清快取",
    /noteAdminIdentityChange\(\);\s*await signOut\(\)/.test(
      stripComments(read("src/routes/admin/pending.tsx")),
    ),
  );
  const root = stripComments(read("src/routes/__root.tsx"));
  checkTrue(
    "🔴 從後台換頁到前台時 root 重跑（不會一直掛著預設文案）",
    /shouldReload:[\s\S]{0,160}rootDataIsBackOfficeFallback &&\s*!isBackOfficePath\(location\.pathname\)/.test(
      root,
    ),
  );
  checkTrue(
    "root loader 在後台不查站台文案",
    /const backOffice = isBackOfficePath\(location\.pathname\);[\s\S]{0,200}site: backOffice \? FALLBACK_SITE_CONTENT : await fetchSiteContent\(\)/.test(
      root,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 整頁 fn：GET、middleware 跟原本那幾支一樣、route 的 loader 用它們");
{
  const PAGE_FNS = [
    [
      "src/lib/admin/fns/products.ts",
      "getAdminProductsPageData",
      "adminFnMiddleware",
      "_shell.products.tsx",
    ],
    [
      "src/lib/admin/fns/events.ts",
      "getAdminEventsPageData",
      "adminFnMiddleware",
      "_shell.events.tsx",
    ],
    [
      "src/lib/admin/fns/events.ts",
      "getAdminEventEditorPageData",
      "adminFnMiddleware",
      "_shell.events.$id.tsx",
    ],
    [
      "src/lib/admin/fns/event-sessions.ts",
      "getAdminRegistrationsPageData",
      "staffFnMiddleware()",
      "_shell.registrations.tsx",
    ],
    // 2026-10-25 名單／場次編輯改成內頁：layout（名單＋編輯共用）與新增頁各叫這一支。
    [
      "src/lib/admin/fns/event-sessions.ts",
      "getEventSessionPageData",
      "staffFnMiddleware()",
      "_shell.registrations_.$sessionId.tsx",
    ],
    [
      "src/lib/admin/fns/event-sessions.ts",
      "getEventSessionPageData",
      "staffFnMiddleware()",
      "_shell.registrations_.new.tsx",
    ],
    [
      "src/lib/admin/fns/inv-products.ts",
      "getInventoryProductsPageData",
      "staffFnMiddleware()",
      "_shell.inventory-products.tsx",
    ],
    [
      "src/lib/admin/fns/inv-products.ts",
      "getInventoryProductPageData",
      "staffFnMiddleware()",
      "_shell.inventory-products_.$id.tsx",
    ],
    [
      "src/lib/admin/fns/inv-vendors.ts",
      "getInventoryVendorsPageData",
      "staffFnMiddleware()",
      "_shell.inventory-vendors.tsx",
    ],
    [
      "src/lib/admin/fns/inv-combos.ts",
      "getInventoryCombosPageData",
      "staffFnMiddleware()",
      "_shell.inventory-combos.tsx",
    ],
    [
      "src/lib/admin/fns/inv-combos.ts",
      "getInventoryComboPageData",
      "staffFnMiddleware()",
      "_shell.inventory-combos_.$id.tsx",
    ],
    [
      "src/lib/admin/fns/inv-purchases.ts",
      "getInventoryPurchasesPageData",
      "staffFnMiddleware()",
      "_shell.inventory-purchases.tsx",
    ],
    [
      "src/lib/admin/fns/inv-adjustments.ts",
      "getInventoryCountPageData",
      "staffFnMiddleware()",
      "_shell.inventory-count.tsx",
    ],
    [
      "src/lib/admin/fns/inv-adjustments.ts",
      "getInventoryAdjustmentsPageData",
      "staffFnMiddleware()",
      "_shell.inventory-adjustments.tsx",
    ],
  ];
  for (const [file, name, mw, route] of PAGE_FNS) {
    const src = stripComments(read(file));
    const esc = mw.replace(/[()]/g, "\\$&");
    checkTrue(
      `${name}：GET＋${mw}`,
      new RegExp(
        `export const ${name} = createServerFn\\(\\{ method: "GET" \\}\\)\\s*\\.middleware\\(\\[${esc}\\]\\)`,
      ).test(src),
    );
    checkTrue(
      `${route} 的 loader 呼叫 ${name}`,
      stripComments(read(`src/routes/admin/${route}`)).includes(`${name}(`),
    );
  }
  const reg = stripComments(read("src/lib/admin/fns/event-sessions.ts"));
  const regFn = reg.slice(reg.indexOf("export const getAdminRegistrationsPageData"));
  checkTrue(
    "🔴 報名整頁 fn 仍要 event.roster.read",
    /await requireRosterRead\(context\.staff\.permissions\);/.test(regFn),
  );
  const sessFn = reg.slice(reg.indexOf("export const getEventSessionPageData"));
  checkTrue(
    "🔴 場次內頁 fn 也要 event.roster.read",
    sessFn.length > 0 && /await requireRosterRead\(context\.staff\.permissions\);/.test(sessFn),
  );

  // 每一支後台 fn 都要掛 middleware（新加的整頁 fn 不可以漏）。
  for (const f of [
    "products",
    "events",
    "event-sessions",
    "inv-products",
    "inv-vendors",
    "inv-combos",
    "inv-purchases",
    "inv-adjustments",
  ]) {
    const src = stripComments(read(`src/lib/admin/fns/${f}.ts`));
    const decls = [...src.matchAll(/export const (\w+) = createServerFn\([^)]*\)\s*(\.\w+)/g)];
    const missing = decls.filter((m) => m[2] !== ".middleware").map((m) => m[1]);
    check(`🔴 fns/${f}.ts：每一支 server fn 都先掛 middleware`, missing, []);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3b] 只讀的 POST fn 標記（readOnlyFnMiddleware）");
{
  const READ_ONLY = {
    "inv-products": ["listAdminProducts", "getAdminProduct"],
    "inv-vendors": [
      "listAdminVendors",
      "getAdminVendor",
      "listVendorSubmissions",
      "listVendorPortalAccounts",
    ],
    "inv-adjustments": [
      "listAdminAdjustments",
      "getAdjustmentSummary",
      "getAdminAdjustment",
      "listStockCountProducts",
      "listProductMovements",
    ],
    "inv-combos": ["listAdminComboSets", "getAdminComboSet", "listComboSales"],
    "inv-purchases": ["listAdminPurchases", "getPurchaseSummary", "getAdminPurchase"],
    pos: ["findPosProductByBarcode", "listPosSales", "listStockAlerts"],
  };
  const all = [];
  for (const f of [
    "artists",
    "auth",
    "event-registrations",
    "event-sessions",
    "events",
    "inv-adjustments",
    "inv-combos",
    "inv-products",
    "inv-purchases",
    "inv-vendors",
    "orders",
    "pos",
    "products",
    "publications",
    "staff-accounts",
    "vendor-portal",
  ]) {
    const src = stripComments(read(`src/lib/admin/fns/${f}.ts`));
    for (const m of src.matchAll(
      /export const (\w+) = createServerFn\(\{ method: "(\w+)" \}\)\s*\.middleware\(\[([^\]]*)\]\)/g,
    )) {
      if (m[3].includes("readOnlyFnMiddleware"))
        all.push(
          `${f}:${m[1]}:${m[2]}:${m[3].trim().startsWith("readOnlyFnMiddleware") ? "first" : "after-auth"}`,
        );
    }
  }
  const expected = Object.entries(READ_ONLY)
    .flatMap(([f, ns]) => ns.map((n) => `${f}:${n}:POST:after-auth`))
    .sort();
  check("🔴 只有這 20 支只讀 fn 掛了標記（放在授權 middleware 後面）", all.sort(), expected);
  for (const n of ["listSessionRoster", "readVendorSensitive"]) {
    checkTrue(`🔴 ${n}（會寫查閱紀錄）沒有標成只讀`, !all.some((x) => x.includes(`:${n}:`)));
  }
  C.resetAdminRouteCacheForTests();
  check("沒登記過的 fn 不算只讀", C.isReadOnlyServerFn("abc"), false);
  C.markReadOnlyServerFn("abc");
  check("登記過的 fn 算只讀", C.isReadOnlyServerFn("abc"), true);
  check("沒有 id 不算只讀", C.isReadOnlyServerFn(undefined), false);
}

console.log("\n[4] isBackOfficePath()");
{
  const { isBackOfficePath } = await import(
    pathToFileURL(join(ROOT, "src/lib/admin/back-office-path.ts")).href
  );
  check("/admin", isBackOfficePath("/admin"), true);
  check("/admin/", isBackOfficePath("/admin/"), true);
  check("/admin/products", isBackOfficePath("/admin/products"), true);
  check("/admin/login", isBackOfficePath("/admin/login"), true);
  check("/ 不是", isBackOfficePath("/"), false);
  check("/administration 不是（只認完整的路徑段）", isBackOfficePath("/administration"), false);
  check("/events/admin 不是", isBackOfficePath("/events/admin"), false);
  check("/vendor 不是（廠商入口照舊）", isBackOfficePath("/vendor/products"), false);
}

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
