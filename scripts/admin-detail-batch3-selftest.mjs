#!/usr/bin/env node
/**
 * 後台第 3 批（2026-10-26）的自檢（靜態）。業主：「不要用彈窗，直接顯示內頁＆回到上一頁」。
 *
 *   [1] 八個模組的新內頁：檔案在、loader 只叫指定的 fn、那支 fn 的授權與原本相同（不放寬）、
 *       $id 頁有 pendingComponent、存檔後 router.invalidate({ sync: true })。
 *   [2] 表單：未存變更防呆（不寫成 dirty && !saving）、成功先 allowLeave 再換頁。
 *   [3] 列表：記錄詳情／編輯的對話框都拿掉了；留下來的只有確認／快速動作。
 *   [4] 列上的「詳情／編輯」連結在那一列有動作進行中時停用（<Link disabled>＋Button 的 aria-disabled 樣式）。
 *   [5] 瘦身：銷售清單不再 select *、櫃檯商品少三欄、套餐表單只帶七欄、進貨頁不帶整份商品清單、
 *       新增進貨的選擇器是資料庫端搜尋（最多 30 筆）。
 *   [6] 沒人用的彈窗時代 fn 已移除。
 *   [7] CSRF：start.ts 掛了框架的 createCsrfMiddleware（只認 server fn）；webhook 在 server.ts 先被攔下。
 *   [8] 新內頁沒有 toLocaleString／toLocaleTimeString（SSR 與瀏覽器字不一樣 → React #418）。
 *
 * 🔴 是安全或資料正確性的規矩（授權不放寬、匯入不拿空清單比對、webhook 不經 CSRF）。
 *
 * 執行：node scripts/admin-detail-batch3-selftest.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-detail-batch3-selftest.mjs";
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
const code = (rel) => stripComments(read(rel));

function middlewareOf(src, name) {
  const i = src.indexOf(`export const ${name} = createServerFn`);
  if (i < 0) return null;
  const m = src
    .slice(i)
    .match(
      /^export const \w+ = createServerFn\(\{ method: "(\w+)" \}\)\s*\.middleware\(\[([^\]]*)\]\)/,
    );
  return m ? `${m[1]} ${m[2].trim()}` : null;
}
/** loader: async (...) => { ... } 的本體（到 head: 為止）。 */
function loaderBody(src) {
  const i = src.indexOf("loader:");
  const j = src.indexOf("head:", i);
  return i < 0 ? "" : src.slice(i, j < 0 ? undefined : j);
}
function fnsCalledIn(body) {
  return [...body.matchAll(/await (\w+)\(\{|await (\w+)\(\)/g)].map((m) => m[1] ?? m[2]);
}

const R = (f) => `src/routes/admin/${f}`;

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] 新內頁：loader 一支 fn、授權不放寬、pending、存檔後等新資料");
const PAGES = [
  // [route 檔, fns 檔, loader 要叫的 fn, 期望的 method+middleware, 是不是 $id 頁]
  [R("_shell.news_.$id.tsx"), "news", "getNewsById", "GET adminFnMiddleware", true],
  [R("_shell.news_.new.tsx"), "news", "listNews", "GET adminFnMiddleware", false],
  [R("_shell.artists_.$id.tsx"), "artists", "getArtistById", "GET adminFnMiddleware", true],
  [R("_shell.artists_.new.tsx"), "artists", "listArtists", "GET adminFnMiddleware", false],
  [
    R("_shell.collaborations_.$id.tsx"),
    "collaborations",
    "getCollaborationById",
    "GET adminFnMiddleware",
    true,
  ],
  [
    R("_shell.collaborations_.new.tsx"),
    "collaborations",
    "listCollaborations",
    "GET adminFnMiddleware",
    false,
  ],
  [
    R("_shell.staff_.$id.tsx"),
    "staff-accounts",
    "listStaffAccounts",
    "GET adminFnMiddleware",
    true,
  ],
  [
    R("_shell.referrals_.$id.tsx"),
    "referrals",
    "listReferrersAdmin",
    "GET adminFnMiddleware",
    true,
  ],
  [
    R("_shell.referrals_.new.tsx"),
    "referrals",
    "listReferrersAdmin",
    "GET adminFnMiddleware",
    false,
  ],
  [R("_shell.sales_.$saleId.tsx"), "pos", "getPosSale", "GET staffFnMiddleware()", true],
  [
    R("_shell.inventory-purchases_.$id.tsx"),
    "inv-purchases",
    "getInventoryPurchaseFormPageData",
    "GET staffFnMiddleware()",
    true,
  ],
  [
    R("_shell.inventory-purchases_.new.tsx"),
    "inv-purchases",
    "getInventoryPurchaseFormPageData",
    "GET staffFnMiddleware()",
    false,
  ],
  [
    R("_shell.inventory-adjustments_.$id.tsx"),
    "inv-adjustments",
    "getInventoryAdjustmentPageData",
    "GET staffFnMiddleware()",
    true,
  ],
];
for (const [route, fnsFile, fn, mw, isDetail] of PAGES) {
  checkTrue(`${route} 存在`, existsSync(join(ROOT, route)));
  if (!existsSync(join(ROOT, route))) continue;
  const src = code(route);
  check(`${route}：loader 只叫 ${fn}`, fnsCalledIn(loaderBody(src)), [fn]);
  const fns = code(`src/lib/admin/fns/${fnsFile}.ts`);
  check(`🔴 ${fn}：${mw}`, middlewareOf(fns, fn), mw);
  if (isDetail) {
    checkTrue(
      `${route}：有 pendingComponent（標題先用列表那一列畫）`,
      /pendingComponent:/.test(src),
    );
    checkTrue(`${route}：有 ...ADMIN_DETAIL_PENDING`, /\.\.\.ADMIN_DETAIL_PENDING/.test(src));
  }
  if (/onSaved=|useAdjustmentActions/.test(src)) {
    checkTrue(
      `${route}：動作後 router.invalidate({ sync: true })（等新資料才放掉按鈕／回上一頁）`,
      /router\.invalidate\(\{ sync: true \}\)/.test(src),
    );
    checkTrue(
      `${route}：沒有不等新資料的 router.invalidate()`,
      !/router\.invalidate\(\)/.test(src),
    );
  }
}
// 所有新 fn 都先掛 middleware（沒有漏網的）。
for (const f of ["news", "artists", "collaborations", "staff-accounts", "referrals", "pos"]) {
  const fns = code(`src/lib/admin/fns/${f}.ts`);
  const decls = [...fns.matchAll(/export const (\w+) = createServerFn\([^)]*\)\s*(\.\w+)/g)];
  check(
    `🔴 fns/${f}.ts：每一支 server fn 都先掛 middleware`,
    decls.filter((m) => m[2] !== ".middleware").map((m) => m[1]),
    [],
  );
}
{
  const fns = code("src/lib/admin/fns/pos.ts");
  checkTrue(
    "getPosSale 驗 uuid",
    /getPosSale[\s\S]{0,200}saleId: z\.string\(\)\.uuid\(\)/.test(fns),
  );
  const staff = code(R("_shell.staff_.$id.tsx"));
  checkTrue(
    "🔴 人員內頁：自己的帳號不給表單（與列表「這是你自己的帳號」一致）",
    /account\.id === user\.userId[\s\S]{0,200}AdminDetailNotFound/.test(staff),
  );
  // 反向：拿掉那個判斷，上面的 regex 會失敗。
  checkTrue(
    "（反向）拿掉自己帳號的判斷時，上一條會紅",
    !/account\.id === user\.userId[\s\S]{0,200}AdminDetailNotFound/.test(
      staff.replace("account.id === user.userId", "false"),
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] 表單：未存變更防呆、成功先 allowLeave");
const FORMS = [
  "src/components/admin/NewsForm.tsx",
  "src/components/admin/ArtistForm.tsx",
  "src/components/admin/CollaborationForm.tsx",
  "src/components/admin/StaffAccountForm.tsx",
  "src/components/admin/ReferrerForm.tsx",
  "src/components/inventory/PurchaseForm.tsx",
];
for (const f of FORMS) {
  const src = code(f);
  checkTrue(`${f}：useUnsavedChangesGuard(dirty)`, /useUnsavedChangesGuard\(dirty\)/.test(src));
  checkTrue(`🔴 ${f}：不是 dirty && !saving（存檔途中也要問）`, !/dirty && !saving/.test(src));
  checkTrue(`${f}：有畫出防呆的確認框（guard.dialog）`, /\{guard\.dialog\}/.test(src));
  checkTrue(
    `🔴 ${f}：成功時先 allowLeave() 再 onSaved()`,
    /guard\.allowLeave\(\);\s*await onSaved\(\)/.test(src),
  );
  checkTrue(`${f}：外框是 AdminDetailPage`, /<AdminDetailPage/.test(src));
  checkTrue(`${f}：沒有 Dialog`, !/DialogContent|from "@\/components\/ui\/dialog"/.test(src));
}
{
  const p = code("src/components/inventory/PurchaseForm.tsx");
  checkTrue(
    "進貨表單：搜尋關鍵字不算「改過」（useFormDirty 只看 form）",
    /useFormDirty\(form\)/.test(p),
  );
  checkTrue("進貨表單：編輯時不搜尋（商品鎖住）", /useProductSearch\(!isEdit, keyword\)/.test(p));
  checkTrue(
    "進貨表單：舊的搜尋回應晚到不蓋掉新的（序號比對）",
    /my === seq\.current\) setMatches/.test(p),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 列表：詳情／編輯的對話框拿掉了，確認與快速動作留著");
const LISTS = {
  [R("_shell.news.tsx")]: { link: "/admin/news/$id", keepAlert: true },
  [R("_shell.artists.tsx")]: { link: "/admin/artists/$id", keepAlert: true },
  [R("_shell.collaborations.tsx")]: { link: "/admin/collaborations/$id", keepAlert: true },
  [R("_shell.referrals.tsx")]: { link: "/admin/referrals/$id", keepAlert: false },
  [R("_shell.sales.tsx")]: { link: "/admin/sales/$saleId", keepAlert: false },
};
for (const [f, { link, keepAlert }] of Object.entries(LISTS)) {
  const src = code(f);
  checkTrue(
    `${f}：沒有 Dialog（記錄的詳情／編輯不再是彈窗）`,
    !/<Dialog\b|(?<!Alert)DialogContent/.test(src),
  );
  checkTrue(`${f}：連到 ${link}`, src.includes(`to="${link}"`));
  checkTrue(`${f}：連結 preload="intent"`, /preload="intent"/.test(src));
  checkTrue(`${f}：點下去之前記住那一列（peek）`, /rememberAdminPeek\(/.test(src));
  if (keepAlert) checkTrue(`${f}：刪除確認仍是 AlertDialog`, /<AlertDialog\b/.test(src));
}
{
  const staff = code(R("_shell.staff.tsx"));
  checkTrue(
    "人員列表：「新增後台帳號」仍是對話框（快速動作、含初始密碼）",
    /CreateAccountDialog/.test(staff),
  );
  checkTrue("🔴 人員列表：編輯身分的對話框拿掉了", !/EditAccountDialog/.test(staff));
  checkTrue("人員列表：編輯連到 /admin/staff/$id", staff.includes('to="/admin/staff/$id"'));

  const ref = code(R("_shell.referrals.tsx"));
  checkTrue("推廣：ReferrerDialog 拿掉了", !/ReferrerDialog/.test(ref));
  checkTrue(
    "推廣：月份交給 useLoaderBackedList（不抄 loader 進 useState）",
    /useLoaderBackedList\(/.test(ref),
  );
  checkTrue("推廣：沒有 useState(loaded.…) 副本", !/useState[^(]*\(loaded\./.test(ref));

  const pur = code(R("_shell.inventory-purchases.tsx"));
  checkTrue("進貨列表：PurchaseFormDialog 拿掉了", !/PurchaseFormDialog/.test(pur));
  checkTrue(
    "進貨：PurchaseFormDialog.tsx 已刪除",
    !existsSync(join(ROOT, "src/components/inventory/PurchaseFormDialog.tsx")),
  );
  const dialogs = code("src/components/inventory/PurchaseDialogs.tsx");
  checkTrue(
    "🔴 Excel 匯入：商品清單還沒抓到（null）就不打開（空清單比對會把每一列當新商品）",
    /open=\{importOpen && products !== null\}/.test(dialogs),
  );
  const ocr = code("src/components/ocr/PurchaseOCRLauncher.tsx");
  checkTrue(
    "🔴 拍照辨識：抓到清單才打開",
    /if \(await loadProducts\(\)\) setOpen\(true\)/.test(ocr) &&
      /open=\{open && products !== null\}/.test(ocr),
  );
  checkTrue(
    "拍照辨識失敗的「改用手動輸入」導到新增進貨內頁",
    /onManualEntry=\{\(\) => void navigate\(\{ to: "\/admin\/inventory-purchases\/new" \}\)\}/.test(
      ocr,
    ),
  );

  const adj = code(R("_shell.inventory-adjustments.tsx"));
  checkTrue("異動列表：詳情對話框拿掉了", !/AdjustmentDetailDialog|setDetail/.test(adj));
  checkTrue("異動列表：新增異動仍是對話框（小表單）", /<AdjustmentFormDialog/.test(adj));
  checkTrue(
    "異動：AdjustmentDetailDialog.tsx 已刪除",
    !existsSync(join(ROOT, "src/components/inventory/AdjustmentDetailDialog.tsx")),
  );
  const adjPage = code(R("_shell.inventory-adjustments_.$id.tsx"));
  checkTrue(
    "異動內頁：三個破壞性動作仍要再確認（AdjustmentConfirmDialog）",
    /<AdjustmentConfirmDialog/.test(adjPage),
  );
  checkTrue(
    "異動內頁：刪除草稿成功才回列表，失敗留在原頁",
    /const ok = await handleDelete\(target\);\s*if \(!ok\)/.test(adjPage),
  );
  const view = code("src/components/inventory/AdjustmentDetailView.tsx");
  const labels = code("src/lib/admin/inv-adjustment-labels.ts");
  checkTrue(
    "沖帳條件只寫一次（adjustmentIsReversible）",
    /adjustmentIsReversible\(row\)/.test(view) &&
      /export function adjustmentIsReversible/.test(labels),
  );
  checkTrue(
    "沒有任何動作時不畫動作列（adjustmentHasActions）",
    /adjustmentHasActions\(row, canApprove\) \?/.test(adjPage),
  );

  const sales = code(R("_shell.sales.tsx"));
  checkTrue("銷售：SaleDetailDialog 拿掉了", !/SaleDetailDialog/.test(sales));
  checkTrue(
    "銷售：SaleDetailDialog.tsx 已刪除",
    !existsSync(join(ROOT, "src/components/pos/SaleDetailDialog.tsx")),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] 列上的詳情／編輯連結：那一列有動作進行中時停用");
{
  const btn = read("src/components/ui/button.tsx");
  checkTrue(
    "Button 有 aria-disabled 的樣式（<Link disabled> 會標 aria-disabled，沒有 :disabled）",
    /aria-disabled:pointer-events-none aria-disabled:opacity-50/.test(btn),
  );
  const ROW_LINKS = {
    "src/components/inventory/VendorTable.tsx": 2,
    "src/components/inventory/ComboSetRowActions.tsx": 2,
    "src/components/inventory/ProductTable.tsx": 2,
    "src/components/inventory/PurchaseTable.tsx": 1,
    [R("_shell.news.tsx")]: 1,
    [R("_shell.artists.tsx")]: 1,
    [R("_shell.collaborations.tsx")]: 1,
    [R("_shell.staff.tsx")]: 1,
    [R("_shell.journeys.tsx")]: 1,
    [R("_shell.registrations.tsx")]: 2,
  };
  for (const [f, n] of Object.entries(ROW_LINKS)) {
    const src = code(f);
    const links = [...src.matchAll(/<Link\b[\s\S]*?>/g)].map((m) => m[0]);
    const disabled = links.filter((l) => /disabled=\{(busy|rowBusy)\}/.test(l)).length;
    check(`${f}：${n} 個列上連結帶 disabled={busy}`, disabled, n);
  }
  // 反向：Slot 上的 disabled（<Button asChild disabled>）不算——那是舊寫法，要直接寫在 Link 上。
  checkTrue(
    "廠商表格不再把 disabled 寫在 <Button asChild> 上（改寫在 Link）",
    !/<Button asChild[^>]*disabled=\{busy\}/.test(code("src/components/inventory/VendorTable.tsx")),
  );
  checkTrue(
    "商品表格不再手寫 pointer-events-none（交給 Button 的 aria-disabled 樣式）",
    !/className=\{busy \? "pointer-events-none opacity-50"/.test(
      code("src/components/inventory/ProductTable.tsx"),
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] 瘦身");
{
  const sales = code("src/server/repos/inv-sales.ts");
  const list = sales.slice(sales.indexOf("export async function listPosSales"));
  checkTrue(
    "🔴 銷售清單不再 select *（只帶 POS_SALE_LIST_COLUMNS）",
    /\.select\(POS_SALE_LIST_COLUMNS\.join\(", "\), \{ count: "exact" \}\)/.test(
      list.slice(0, 600),
    ),
  );
  checkTrue(
    "銷售明細內頁另外依 sale_id 抓完整一筆",
    /export async function getPosSale[\s\S]{0,300}\.eq\("sale_id", saleId\)/.test(sales),
  );
  const cols = sales.match(/const POS_PRODUCT_COLUMNS =\s*"([^"]+)"/)?.[1] ?? "";
  for (const c of ["product_type", "base_product_id", "stock_target_id"]) {
    checkTrue(`櫃檯商品清單不帶 ${c}（櫃檯畫面沒讀過）`, cols && !cols.split(/,\s*/).includes(c));
  }
  for (const c of [
    "inv_product_id",
    "name",
    "barcode",
    "selling_price",
    "units_per_item",
    "available",
    "reserved",
  ]) {
    checkTrue(`櫃檯商品清單仍帶 ${c}`, cols.split(/,\s*/).includes(c));
  }
  checkTrue(
    "listPosProducts 與條碼查詢用同一份欄位",
    (sales.match(/\.select\(POS_PRODUCT_COLUMNS\)/g) ?? []).length === 2,
  );

  const combos = code("src/lib/admin/fns/inv-combos.ts");
  checkTrue(
    "🔴 套餐表單選項改用 listComboPickerProducts（七欄），不再整份 listPosProducts",
    /listComboPickerProducts\(\)/.test(combos) && !/listPosProducts/.test(combos),
  );

  const pur = code("src/lib/admin/fns/inv-purchases.ts");
  const listPage = pur.slice(
    pur.indexOf("export const getInventoryPurchasesPageData"),
    pur.indexOf("export const getInventoryPurchaseFormPageData"),
  );
  checkTrue(
    "🔴 進貨列表的整頁 fn 不帶整份商品清單（約 385 KB）",
    !/listProductPickerRows/.test(listPage),
  );
  const formPage = pur.slice(pur.indexOf("export const getInventoryPurchaseFormPageData"));
  checkTrue("進貨內頁的整頁 fn 也不帶整份商品清單", !/listProductPickerRows/.test(formPage));
  checkTrue(
    "新增進貨的商品搜尋：POST＋只讀標記（關鍵字不進網址、不清快取）",
    middlewareOf(pur, "searchPurchaseProducts") ===
      "POST staffFnMiddleware(), readOnlyFnMiddleware",
  );
  const repo = code("src/server/repos/inv-purchases.ts");
  checkTrue(
    "搜尋最多 30 筆（與原本 matches.slice(0, 30) 相同）",
    /PRODUCT_PICKER_SEARCH_LIMIT = 30/.test(repo) &&
      /\.limit\(PRODUCT_PICKER_SEARCH_LIMIT\)/.test(repo),
  );
  checkTrue(
    "🔴 搜尋只看上架中的商品（與原本整份清單相同）",
    /searchProductPickerRows[\s\S]{0,500}\.eq\("is_active", true\)/.test(repo),
  );
  checkTrue(
    "搜尋剝掉 PostgREST or() 會壞掉的字元與 ilike 萬用字元",
    /keyword\.replace\(\/\[\(\),%_\*\\\\\]\/g, " "\)/.test(repo),
  );
  const route = code(R("_shell.inventory-purchases.tsx"));
  checkTrue(
    "進貨列表 loader 不再從 loader 拿 products",
    !/products \} = Route\.useLoaderData/.test(route) &&
      !/, products\b[^:]*= Route\.useLoaderData/.test(route),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6] 沒人用的彈窗時代 fn 已移除");
{
  const REMOVED = {
    "inv-combos": ["getAdminComboSet", "listComboSales"],
    "inv-products": ["getAdminProduct"],
    "inv-vendors": ["getAdminVendor"],
    "inv-adjustments": ["getAdminAdjustment", "listAdjustmentFormOptions"],
    "inv-purchases": ["getAdminPurchase", "listPurchaseFormOptions"],
  };
  for (const [f, names] of Object.entries(REMOVED)) {
    const fns = code(`src/lib/admin/fns/${f}.ts`);
    for (const n of names) {
      checkTrue(
        `fns/${f}.ts：${n} 已移除`,
        !new RegExp(`export const ${n} = createServerFn`).test(fns),
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[7] CSRF");
{
  const start = code("src/start.ts");
  checkTrue("start.ts 用框架的 createCsrfMiddleware", /createCsrfMiddleware\(\{/.test(start));
  checkTrue(
    "🔴 只檢查 server fn 請求（一般頁面不擋）",
    /filter: \(ctx\) => ctx\.handlerType === "serverFn"/.test(start),
  );
  checkTrue("掛在 requestMiddleware", /requestMiddleware: \[csrfMiddleware\]/.test(start));
  checkTrue(
    "原本的寫入後清快取 middleware 還在",
    /functionMiddleware: \[adminCacheInvalidation\]/.test(start),
  );
  const server = code("src/server.ts");
  const startAt = server.indexOf("await (startFetch");
  for (const p of [
    "BLACKCAT_APN_PATH",
    "BLACKCAT_RETURN_PATH",
    "PAYUNI_WEBHOOK_PATH",
    "INVOICE_TASK_PATH",
    "PURGE_SCANS_TASK_PATH",
    "MCP_PATH",
    "NOTIFY_TASK_PATH",
  ]) {
    const at = server.indexOf(`pathname === ${p}`);
    checkTrue(`🔴 ${p} 在進 startFetch（CSRF）之前就被 server.ts 攔下`, at > 0 && at < startAt);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[8] 新內頁不用 toLocaleString 印時間（SSR 與瀏覽器不一致 → React #418）");
for (const f of [
  "src/components/pos/SaleDetailView.tsx",
  "src/components/inventory/AdjustmentDetailView.tsx",
  "src/lib/admin/sale-when.ts",
  R("_shell.sales_.$saleId.tsx"),
  R("_shell.inventory-adjustments_.$id.tsx"),
]) {
  const src = code(f);
  checkTrue(
    `${f}：沒有 new Date(…).toLocale…String`,
    !/new Date\([^)]*\)\.toLocale\w*String/.test(src),
  );
}

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m`);
