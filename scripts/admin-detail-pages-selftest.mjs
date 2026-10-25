#!/usr/bin/env node
/**
 * 後台第 2 批（2026-10-25）：彈窗改內頁的自檢。業主：「不要用彈窗，直接顯示內頁＆回到上一頁」。
 *
 *   [1] detail-nav.ts：「← 回到列表」什麼時候可以直接 history.back()（push／replace／上一頁）。
 *   [2] form-dirty.ts：改過才算 dirty（key 順序不影響、改回原樣不算）。
 *   [3] list-memory.ts：只在瀏覽器端寫；換人登入（route-cache.ts）一定清掉。
 *   [4] 接線（靜態）：每一個內頁 route 的 loader 叫的 fn 有授權 middleware；表單頁都掛
 *       useUnsavedChangesGuard；改成內頁的舊彈窗檔案已刪；列表不再把 loader 資料抄進 useState。
 *
 * 執行：node scripts/admin-detail-pages-selftest.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-detail-pages-selftest.mjs";
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
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] detail-nav：回到列表能不能直接按上一頁");
{
  const N = await imp("src/lib/admin/detail-nav.ts");
  const loc = (pathname, i) => ({ pathname, state: { __TSR_index: i } });
  N.resetAdminDetailNavForTests();

  N.noteAdminNavigation(undefined, loc("/admin/inventory-vendors", 0)); // 整頁載入
  N.noteAdminNavigation(loc("/admin/inventory-vendors", 0), loc("/admin/inventory-vendors/a", 1)); // push
  checkTrue(
    "列表 → 內頁（push）：上一筆是列表",
    N.previousEntryIsList(1, "/admin/inventory-vendors"),
  );
  check("尾斜線不影響", N.previousEntryIsList(1, "/admin/inventory-vendors/"), true);
  check("別的列表不算", N.previousEntryIsList(1, "/admin/orders"), false);

  N.noteAdminNavigation(
    loc("/admin/inventory-vendors/a", 1),
    loc("/admin/inventory-vendors/a/edit", 2),
  );
  check(
    "內頁 → 編輯：編輯頁的上一筆是內頁",
    N.previousEntryIsList(2, "/admin/inventory-vendors/a"),
    true,
  );
  check("編輯頁的上一筆不是列表", N.previousEntryIsList(2, "/admin/inventory-vendors"), false);

  // 按上一頁回內頁（pop）：不改記錄，內頁的上一筆仍是列表
  N.noteAdminNavigation(
    loc("/admin/inventory-vendors/a/edit", 2),
    loc("/admin/inventory-vendors/a", 1),
  );
  check("pop 回內頁：上一筆仍是列表", N.previousEntryIsList(1, "/admin/inventory-vendors"), true);

  // replace（同一筆換網址）：沿用原記錄
  N.noteAdminNavigation(loc("/admin/inventory-vendors/a", 1), loc("/admin/inventory-vendors/b", 1));
  check("replace：沿用前一筆", N.previousEntryIsList(1, "/admin/inventory-vendors"), true);

  // 從別的頁 push 到第 1 筆：覆蓋，而且第 2 筆以後的記錄作廢
  N.noteAdminNavigation(loc("/admin/news", 0), loc("/admin/inventory-vendors/a", 1));
  check(
    "從別頁 push 進來：上一筆不是列表",
    N.previousEntryIsList(1, "/admin/inventory-vendors"),
    false,
  );
  check(
    "push 之後「下一頁」那些記錄作廢",
    N.previousEntryIsList(2, "/admin/inventory-vendors/a"),
    false,
  );

  // A → 內頁 → 列表（push）→ 上一頁回內頁：內頁前一筆是 A，不是列表（不可以 back）
  N.resetAdminDetailNavForTests();
  N.noteAdminNavigation(loc("/admin/news", 0), loc("/admin/inventory-vendors/a", 1));
  N.noteAdminNavigation(loc("/admin/inventory-vendors/a", 1), loc("/admin/inventory-vendors", 2));
  N.noteAdminNavigation(loc("/admin/inventory-vendors", 2), loc("/admin/inventory-vendors/a", 1));
  check(
    "🔴 來源是列表但它在後面（pop 回來）：不可以 back（會跑到 A）",
    N.previousEntryIsList(1, "/admin/inventory-vendors"),
    false,
  );
  check("沒有 index（舊瀏覽器狀態）：不 back", N.previousEntryIsList(undefined, "/admin/x"), false);

  let backs = 0;
  const hist = (i) => ({ location: { state: { __TSR_index: i } }, back: () => (backs += 1) });
  N.resetAdminDetailNavForTests();
  N.noteAdminNavigation(loc("/admin/orders", 3), loc("/admin/orders/x", 4));
  check(
    "backIfPreviousIs：是 → true 並按上一頁",
    [N.backIfPreviousIs(hist(4), ["/admin/orders"]), backs],
    [true, 1],
  );
  check(
    "backIfPreviousIs：不是 → false、不動",
    [N.backIfPreviousIs(hist(4), ["/admin/news"]), backs],
    [false, 1],
  );
  check(
    "backIfPreviousIs：多個候選其中一個是",
    N.backIfPreviousIs(hist(4), ["/admin/news", "/admin/orders"]),
    true,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] form-dirty：改過才算");
{
  const { stableStringify } = await imp("src/lib/admin/form-dirty.ts");
  check(
    "key 順序不影響",
    stableStringify({ a: 1, b: { c: 2, d: [1, 2] } }),
    stableStringify({ b: { d: [1, 2], c: 2 }, a: 1 }),
  );
  checkTrue("值不同就不同", stableStringify({ a: 1 }) !== stableStringify({ a: 2 }));
  checkTrue("陣列順序算數（票種順序是內容）", stableStringify([1, 2]) !== stableStringify([2, 1]));
  checkTrue("null 與空字串不同", stableStringify({ a: null }) !== stableStringify({ a: "" }));
  check("undefined 也能序列化", stableStringify(undefined), "undefined");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] list-memory：只在瀏覽器端、換人一定清");
{
  const M = await imp("src/lib/admin/list-memory.ts");
  M.writeAdminListMemory("k", 1);
  check(
    "🔴 沒有 window（伺服器）：不寫（模組狀態被所有請求共用）",
    M.readAdminListMemory("k"),
    undefined,
  );
  globalThis.window = globalThis.window ?? {};
  M.writeAdminListMemory("k", 1);
  M.rememberAdminPeek("vendor", "id1", { name: "x" });
  check("瀏覽器端：寫得進去", M.readAdminListMemory("k"), 1);
  check("peek 讀得到", M.readAdminPeek("vendor", "id1"), { name: "x" });
  const C = await imp("src/lib/admin/route-cache.ts");
  C.resetAdminRouteCacheForTests();
  C.clearAdminRouteCacheOnIdentityChange("u1");
  M.writeAdminListMemory("k", 2);
  C.clearAdminRouteCacheOnIdentityChange("u1");
  check("同一個人：不清", M.readAdminListMemory("k"), 2);
  C.clearAdminRouteCacheOnIdentityChange("u2");
  check("🔴 換人：列表記憶清掉", M.readAdminListMemory("k"), undefined);
  M.writeAdminListMemory("k", 3);
  C.clearAdminRouteCacheOnIdentityChange(null);
  check("🔴 登入／登出（null）：清掉", M.readAdminListMemory("k"), undefined);
  C.resetAdminRouteCacheForTests();
  delete globalThis.window;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] 接線（靜態）");
{
  // [route 檔, loader 叫的 fn, fn 所在檔, 授權 middleware]
  const DETAIL_ROUTES = [
    ["_shell.orders_.$id.tsx", "getAdminOrderDetail", "orders", "adminFnMiddleware"],
    [
      "_shell.inventory-vendors_.$id.tsx",
      "getInventoryVendorPageData",
      "inv-vendors",
      "staffFnMiddleware()",
    ],
    [
      "_shell.inventory-vendors_.new.tsx",
      "listVendorFormOptions",
      "inv-vendors",
      "staffFnMiddleware()",
    ],
  ];
  for (const [route, fn, fnFile, mw] of DETAIL_ROUTES) {
    const rsrc = stripComments(read(`src/routes/admin/${route}`));
    checkTrue(`${route}：loader 叫 ${fn}`, rsrc.includes(`${fn}(`));
    const fsrc = stripComments(read(`src/lib/admin/fns/${fnFile}.ts`));
    const esc = mw.replace(/[()]/g, "\\$&");
    checkTrue(
      `🔴 ${fn} 掛 ${mw}`,
      new RegExp(
        `export const ${fn} = createServerFn\\(\\{ method: "(GET|POST)" \\}\\)\\s*\\.middleware\\(\\[${esc}`,
      ).test(fsrc),
    );
  }

  // 表單內頁：一定掛未存變更防呆
  const FORM_FILES = ["src/components/inventory/VendorForm.tsx"];
  for (const f of FORM_FILES) {
    const src = stripComments(read(f));
    checkTrue(`🔴 ${f}：掛 useUnsavedChangesGuard`, /useUnsavedChangesGuard\(/.test(src));
    checkTrue(`${f}：渲染 guard.dialog`, /\{guard\.dialog\}/.test(src));
    checkTrue(`${f}：存檔成功先 allowLeave 再換頁`, /guard\.allowLeave\(\)/.test(src));
  }

  // 改成內頁的舊彈窗不可以留著（留著就會有人再接回去）
  for (const f of [
    "src/components/inventory/VendorDetailDialog.tsx",
    "src/components/inventory/VendorFormDialog.tsx",
  ]) {
    check(`舊彈窗已刪：${f}`, existsSync(join(ROOT, f)), false);
  }

  // 列表不再把 loader 資料抄進 useState（背景重抓才看得到）
  for (const route of ["_shell.inventory-vendors.tsx"]) {
    const src = stripComments(read(`src/routes/admin/${route}`));
    check(
      `${route}：沒有 useState(loader 資料) 的副本`,
      /useState(<[^>]*>)?\((initial\w*|loader\w*)\)/.test(src),
      false,
    );
    checkTrue(`${route}：用 useLoaderBackedList`, /useLoaderBackedList\(/.test(src));
  }

  // ── 第 2 批審查後的修正 ──────────────────────────────────────────────────
  const { readdirSync } = await import("node:fs");
  const detailRoutes = readdirSync(join(ROOT, "src/routes/admin")).filter((f) =>
    /^_shell\.[\w-]+_\./.test(f),
  );
  checkTrue(`掃得到內頁 route（${detailRoutes.length} 個）`, detailRoutes.length >= 15);
  check(
    "🔴 內頁 route 寫入後一律 router.invalidate({ sync: true })（不等的話動作後會先畫舊資料）",
    detailRoutes.filter((f) =>
      /router\.invalidate\(\)/.test(stripComments(read(`src/routes/admin/${f}`))),
    ),
    [],
  );
  const FORM_PAGES = [
    "src/components/inventory/VendorForm.tsx",
    "src/components/inventory/ComboSetForm.tsx",
    "src/components/inventory/ProductForm.tsx",
    "src/components/admin/JourneyForm.tsx",
    "src/components/admin/SessionForm.tsx",
    "src/components/admin/products/ProductFormPage.tsx",
  ];
  for (const f of FORM_PAGES) {
    const src = stripComments(read(f));
    checkTrue(`${f}：掛 useUnsavedChangesGuard`, /useUnsavedChangesGuard\(/.test(src));
    check(
      `🔴 ${f}：存檔中也要攔（不可以 && !saving／!submitting，成功由 allowLeave 放行）`,
      /useUnsavedChangesGuard\([^)]*!(saving|submitting)/.test(src),
      false,
    );
  }
  const SSR_VIEWS = [
    "src/components/inventory/VendorDetailView.tsx",
    "src/components/inventory/ComboSetDetailView.tsx",
    "src/components/inventory/ProductDetailView.tsx",
    "src/components/inventory/ProductMovementList.tsx",
    "src/components/inventory/VendorAttachmentSection.tsx",
  ];
  for (const f of SSR_VIEWS) {
    check(
      `🔴 ${f}：日期不用 toLocale*String（SSR 會多 THIN SPACE → React #418），用 taipei-time`,
      /new Date\([^)]*\)\.toLocale(Date|Time)?String\(/.test(stripComments(read(f))),
      false,
    );
  }
  const plans = stripComments(read("src/components/admin/SessionPlansEditor.tsx"));
  checkTrue(
    "🔴 票種對話框的 form submit 一定 stopPropagation（否則冒泡到場次表單：存了場次並離開）",
    /<form\s+onSubmit=\{\(e\) => \{\s*e\.stopPropagation\(\);/.test(plans),
  );
  const vform = stripComments(read("src/components/inventory/VendorForm.tsx"));
  checkTrue(
    "廠商表單：子表草稿（聯絡人／匯款帳戶／附件）併進 dirty",
    /onDraftDirtyChange=\{onContactDirty\}/.test(vform) &&
      /onDraftDirtyChange=\{onBankDirty\}/.test(vform) &&
      /onDirtyChange=\{onFilesDirty\}/.test(vform) &&
      /childDirty\.contact \|\| childDirty\.bank \|\| childDirty\.files/.test(vform),
  );
  for (const f of ["VendorContactSection", "VendorBankSection", "VendorAttachmentSection"]) {
    checkTrue(
      `${f}：往上報草稿 dirty`,
      /useReportChildDirty\(/.test(stripComments(read(`src/components/inventory/${f}.tsx`))),
    );
  }

  const guard = stripComments(read("src/components/admin/UnsavedChangesGuard.tsx"));
  checkTrue("防呆：useBlocker withResolver", /useBlocker\(\{[^}]*withResolver: true/.test(guard));
  checkTrue("防呆：beforeunload（關分頁、重新整理）", /enableBeforeUnload/.test(guard));
  checkTrue("防呆：只在 pathname 改變時攔", /current\.pathname !== next\.pathname/.test(guard));

  const router = stripComments(read("src/router.tsx"));
  checkTrue(
    "router.tsx 接上 registerAdminDetailNav",
    /registerAdminDetailNav\(router\)/.test(router),
  );
}

console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m`);
