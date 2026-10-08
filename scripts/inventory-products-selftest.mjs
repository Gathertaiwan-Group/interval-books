#!/usr/bin/env node
/**
 * inventory-products-selftest.mjs —— 商品主檔 CRUD 與審核流程（0016）的自檢
 *
 * 兩段，理由與 pos-counter-selftest 相同：沒有金鑰的機器上也要有意義。
 *
 *   [靜態] 讀 supabase/migrations/0016 與八個 TypeScript 檔，守的是**設計不變量**：
 *          審核的模組白名單有沒有真的寫死在 CASE 裡（而不是拼字串）、白名單外的
 *          module 會不會 RAISE、approval_status 有沒有真的由資料庫算、新 view 有
 *          沒有先 revoke 再 grant、供應商 view 有沒有漏出身分證字號、
 *          fns/inv-products.ts 有沒有誤掛 adminFnMiddleware、xlsx 是不是 dynamic
 *          import。答案都寫在檔案裡。永遠會跑。
 *
 *   [實測] 對目標資料庫真的建一件商品、審核、調價、停用、刪除，並且用一個
 *          **不在白名單**的 module 打一次 inv_approve_record()，證明它被拒。
 *          需要 SUPABASE_ACCESS_TOKEN；沒有就整段 skip（會印出來）。
 *
 * ⚠️ 實測段會在**正式資料庫**建資料再刪掉。所有測試資料都帶固定前綴（見 MARK），
 *    而且開頭與結尾各清一次 —— 開頭那次是為了讓上一輪中途掛掉的殘骸不會累積。
 *
 * ⚠️ 清理順序：purchases 一定要在 products 之前刪（外鍵），而 sales 又要在
 *    purchases 之前（rollback_fifo_on_sale_delete 會去 UPDATE purchases）。
 *
 * 執行：
 *   node scripts/inventory-products-selftest.mjs                         # 只跑靜態
 *   SUPABASE_ACCESS_TOKEN=sbp_… node scripts/inventory-products-selftest.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/inventory-products-selftest.mjs";

const MIG_0016 = join(ROOT, "supabase/migrations/0016_inventory_products_admin.sql");
const SRC_FNS = join(ROOT, "src/lib/admin/fns/inv-products.ts");
const SRC_REPO = join(ROOT, "src/server/repos/inv-products.ts");
const SRC_SCHEMAS = join(ROOT, "src/lib/admin/schemas.ts");
const SRC_MIDDLEWARE = join(ROOT, "src/lib/admin/middleware.ts");
const SRC_AUTH = join(ROOT, "src/server/auth.ts");
const SRC_EXCEL = join(ROOT, "src/lib/admin/excel-import.ts");
const SRC_IMPORT_DIALOG = join(ROOT, "src/components/inventory/ExcelImportDialog.tsx");

/** 測試資料的固定標記。刪除全靠它，所以要夠特別。 */
const MARK = "__invprodselftest__";

// -----------------------------------------------------------------------------
// 迷你測試框架
// -----------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const skipped = [];

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function check(label, actual, expected, note) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
    if (note) console.log(red(`      ${note}`));
  }
}

const checkTrue = (label, value, note) => check(label, Boolean(value), true, note);

/** 把 `--` 註解整行拿掉，免得註解裡提到的字串讓斷言假性通過。 */
function strip(sql) {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
}

/**
 * TypeScript 版的同一件事。
 *
 * 這不是防禦性的多餘程式碼：這一期的檔頭註解裡本來就寫著「沒有搬 LocalizedField」
 * 「解析在 client 不碰 supabase」「AI 拍照辨識沒有搬」—— 也就是說，用整檔
 * includes() 去斷言「這個字沒有出現」的話，**寫得越清楚的註解越會讓測試變紅**。
 * 那會逼下一個人去刪註解來讓 CI 綠，而不是去修程式。
 */
function stripTs(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // 區塊註解（含 JSDoc）
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1"); // 行註解，但不要吃掉網址裡的 //
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
function read(path) {
  if (!existsSync(path)) {
    throw new Error(
      `selftest 讀不到檔案：${path}` +
        "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串 —— 回空字串會讓所有" +
        "「確認原始碼裡沒有 X」的否定斷言靜默通過。）",
    );
  }
  return readFileSync(path, "utf8");
}

// 守著 read() 自己：路徑打錯時它必須炸掉，而不是回空字串讓否定斷言靜默通過。
{
  const ghost = join(ROOT, "__selftest-missing-file-probe__");
  let thrown = null;
  try {
    read(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 read() 讀不到檔案時丟例外，訊息指出是哪個路徑（不是靜默回空字串）",
    thrown !== null && String(thrown.message).includes(ghost),
  );
}

// -----------------------------------------------------------------------------
// [1] 檔案盤點，而且 0001–0015 一個都沒有被動過
// -----------------------------------------------------------------------------

console.log("\n[1] 檔案盤點");
check("0016 存在", existsSync(MIG_0016), true);
for (let n = 1; n <= 15; n += 1) {
  const prefix = String(n).padStart(4, "0");
  const dir = join(ROOT, "supabase/migrations");
  const { readdirSync } = await import("node:fs");
  const found = readdirSync(dir).some((f) => f.startsWith(`${prefix}_`));
  check(`migration ${prefix} 仍在`, found, true);
}

const sql = read(MIG_0016);
const exec = strip(sql);
// 反空殼：先證明檔案真的有內容，否則下面每一條 includes() 都是假性結果。
checkTrue("0016 不是空檔（> 8000 字）", exec.length > 8000);

// -----------------------------------------------------------------------------
// [2] 審核白名單 —— 這一期最重要的一件事
// -----------------------------------------------------------------------------
// 來源的 useApprovalMutation({ table, statusField }) 讓呼叫端自己傳表名。搬到
// client/server 之後那個 table 會從瀏覽器送進來。修法不是「小心一點」，是讓
// 表名根本不會出現在網路上。

console.log("\n[2] 審核：模組白名單");
checkTrue("建了 public.inv_approve_record", exec.includes("function public.inv_approve_record("));
checkTrue(
  "security definer",
  /create or replace function public\.inv_approve_record[\s\S]{0,600}?security definer/i.test(exec),
);

const MODULES = [
  "products",
  "purchases",
  "stock_adjustments",
  "inventory_adjustments",
  "combo_sets",
  "vendors",
  "price_changes",
];
for (const m of MODULES) {
  checkTrue(`白名單有 '${m}' 這個分支`, new RegExp(`WHEN '${m}' THEN`).test(exec));
}
checkTrue(
  "白名單外一律 RAISE（不是靜默 no-op —— 靜默的話呼叫端會以為審核成功了）",
  /ELSE\s+RAISE EXCEPTION 'APPROVAL_UNKNOWN_MODULE/i.test(exec),
);

// 動態 SQL 是這一支函式唯一真正的失敗模式。三種寫法一次擋掉。
const approveBody = exec.slice(
  exec.indexOf("function public.inv_approve_record("),
  exec.indexOf("comment on function public.inv_approve_record"),
);
checkTrue("inv_approve_record 內沒有 EXECUTE（沒有動態 SQL）", !/\bEXECUTE\b/i.test(approveBody));
checkTrue("內沒有 format()", !/\bformat\s*\(/i.test(approveBody));
checkTrue("內沒有 quote_ident()", !/quote_ident/i.test(approveBody));
checkTrue(
  "stock_adjustments 用 status 欄位並寫 'confirmed'（不是 approval_status/'approved'）",
  /WHEN 'stock_adjustments' THEN[\s\S]{0,400}?SET status\s+= CASE WHEN p_approved THEN 'confirmed'/.test(
    exec,
  ),
);
checkTrue(
  "price_changes 核准時把 pending_* 搬進正式欄位",
  /WHEN 'price_changes' THEN[\s\S]{0,900}?selling_price\s+= CASE WHEN p_approved[\s\S]{0,120}?pending_selling_price/.test(
    exec,
  ),
);
checkTrue(
  "只受理 pending → approved/rejected（已入庫的進貨不能被改回退回）",
  /WHEN 'purchases' THEN[\s\S]{0,400}?WHERE id = p_id AND approval_status = 'pending'/.test(exec),
);

// -----------------------------------------------------------------------------
// [3] approval_status 由資料庫算，而且 fail-closed
// -----------------------------------------------------------------------------

console.log("\n[3] initial_approval_status：fail-closed 且在 server 端");
checkTrue(
  "建了 inv.initial_approval_status()",
  exec.includes("function inv.initial_approval_status(p_module text)"),
);
checkTrue(
  "查不到設定一律回 pending（coalesce(..., true)）",
  /coalesce\(\(select s\.is_enabled from inv\.approval_settings s where s\.module = p_module\), true\)/i.test(
    exec,
  ),
);
checkTrue(
  "新增商品的 approval_status 是呼叫這支函式，不是從 payload 拿",
  exec.includes("inv.initial_approval_status('products')"),
);
checkTrue("一起建的進貨也一樣", exec.includes("inv.initial_approval_status('purchases')"));
// payload 裡的 approval_status 必須完全沒有被讀到。
const saveBody = exec.slice(
  exec.indexOf("function public.inv_save_product("),
  exec.indexOf("comment on function public.inv_save_product"),
);
checkTrue(
  "inv_save_product 從來沒有讀 payload 的 approval_status",
  !/p_payload->>'approval_status'/.test(saveBody),
);
checkTrue(
  "也沒有讀 payload 的 stock_quantity（庫存只能由進貨／盤點改）",
  !/p_payload->>'stock_quantity'/.test(saveBody),
);
checkTrue(
  "也沒有讀 payload 的 user_id（操作人員取自 middleware）",
  !/p_payload->>'user_id'/.test(saveBody),
);

// -----------------------------------------------------------------------------
// [4] 新 view 的權限 —— 0013 修過的那個坑
// -----------------------------------------------------------------------------
// Supabase 對 public schema 有 ALTER DEFAULT PRIVILEGES，新建的 view 一出生就對
// anon/authenticated 是 ALL。只下 grant select 會留下那個 ALL。

console.log("\n[4] 新 view 的權限");
const VIEWS = [
  "inv_admin_products",
  "inv_admin_categories",
  "inv_admin_vendors",
  "inv_admin_approval_settings",
];
for (const v of VIEWS) {
  checkTrue(`${v} 建了`, exec.includes(`create or replace view public.${v}`));
  checkTrue(
    `${v} 先 revoke all from anon, authenticated`,
    new RegExp(`revoke all on public\\.${v}\\s+from anon, authenticated`).test(exec),
  );
  checkTrue(
    `${v} 明確 grant select 給 service_role`,
    new RegExp(`grant select on public\\.${v}\\s+to service_role`).test(exec),
  );
  checkTrue(
    `${v} 是 security_invoker = false`,
    new RegExp(
      `create or replace view public\\.${v}\\s*\\n\\s*with \\(security_invoker = false\\)`,
    ).test(exec),
  );
}
// revoke 必須排在 grant 前面 —— 反過來會把剛給的權限一起收掉。
checkTrue(
  "revoke 區段整個排在 grant 區段前面",
  exec.lastIndexOf("revoke all on public.inv_admin_approval_settings") <
    exec.indexOf("grant select on public.inv_admin_products"),
);

console.log("\n[4b] 供應商 view 不能漏出敏感欄位");
// inv.vendors 有 48 欄，其中這幾欄就是 0009 決定不把 inv 掛上 PostgREST 的原因。
const vendorView = exec.slice(
  exec.indexOf("create or replace view public.inv_admin_vendors"),
  exec.indexOf("comment on view public.inv_admin_vendors"),
);
for (const col of [
  "id_number",
  "tax_id",
  "foreign_id",
  "residence_permit_number",
  "phone",
  "email",
  "address",
  "cash_fee_rate",
  "commission_rate",
]) {
  checkTrue(`inv_admin_vendors 沒有暴露 ${col}`, !new RegExp(`\\b${col}\\b`).test(vendorView));
}

console.log("\n[4c] 新函式對 anon/authenticated revoke execute");
const FUNCS = [
  "public.inv_approve_record(uuid, text, uuid, boolean)",
  "public.inv_save_product(uuid, uuid, jsonb, jsonb)",
  "public.inv_set_product_active(uuid, uuid, boolean)",
  "public.inv_resubmit_product(uuid)",
  "public.inv_delete_product(uuid)",
  "public.inv_request_price_change(uuid, uuid, numeric, numeric)",
  "public.inv_import_products(uuid, jsonb, jsonb)",
  "public.inv_batch_update_products(uuid, uuid[], jsonb)",
  "inv.initial_approval_status(text)",
  "inv.apply_price_op(numeric, jsonb)",
];
for (const f of FUNCS) {
  const esc = f.replace(/[.()[\]]/g, (c) => `\\${c}`);
  checkTrue(
    `${f} 對 anon/authenticated revoke`,
    new RegExp(`revoke execute on function ${esc} from anon, authenticated`).test(exec),
  );
  checkTrue(
    `${f} grant 給 service_role`,
    new RegExp(`grant\\s+execute on function ${esc} to service_role`).test(exec),
  );
}

// -----------------------------------------------------------------------------
// [5] 授權層 —— 側欄隱藏不是授權
// -----------------------------------------------------------------------------

console.log("\n[5] fns/inv-products.ts 掛對 middleware");
const fns = stripTs(read(SRC_FNS));
checkTrue("檔案存在且有內容", fns.length > 2000);
checkTrue("一支都沒有誤掛 adminFnMiddleware", !/\.middleware\(\[\s*adminFnMiddleware/.test(fns));
checkTrue("也沒有把 adminFnMiddleware import 進來", !/^import .*adminFnMiddleware/m.test(fns));
checkTrue(
  "每一支 server fn 都有 middleware（數量 = createServerFn 的數量）",
  (fns.match(/createServerFn\(/g) ?? []).length ===
    (fns.match(/\.middleware\(\[staffFnMiddleware/g) ?? []).length,
  `createServerFn=${(fns.match(/createServerFn\(/g) ?? []).length} middleware=${(fns.match(/\.middleware\(\[staffFnMiddleware/g) ?? []).length}`,
);
checkTrue(
  "審核會查 approve_<module> 細權限",
  /const permission = `approve_\$\{data\.module\}`/.test(fns),
);
checkTrue(
  "沒有權限就丟 NotAuthorizedError",
  /throw new NotAuthorizedError\(`需要「\$\{permission\}」權限`\)/.test(fns),
);
checkTrue(
  "user_id 取自 middleware context，不從 request body 拿",
  /userId: context\.staff\.userId/.test(fns),
);
checkTrue(
  "server fn 收的是 module 代號，不是表名",
  fns.includes("module: data.module") && !/table:\s*['"]/.test(fns),
);

console.log("\n[5b] adminFnMiddleware 與 requireAdmin 一個字都沒有動");
const middleware = read(SRC_MIDDLEWARE);
const auth = read(SRC_AUTH);
checkTrue(
  "adminFnMiddleware 仍然呼叫 requireAdmin()",
  /export const adminFnMiddleware[\s\S]{0,400}?const admin = await requireAdmin\(\);/.test(
    middleware,
  ),
);
checkTrue(
  "requireAdmin() 仍然要求 role === 'admin'（透過 loadAdminProfile）",
  /export async function requireAdmin\(\)[\s\S]{0,500}?loadAdminProfile\(session\.userId\)/.test(
    auth,
  ),
);
checkTrue(
  "loadAdminProfile 仍然擋非 admin",
  /if \(!profile \|\| profile\.role !== "admin"\) return null;/.test(auth),
);

console.log("\n[5c] zod 端的 module enum");
const schemas = read(SRC_SCHEMAS);
checkTrue(
  "APPROVAL_MODULES 有七個",
  (schemas.match(/APPROVAL_MODULES = \[([\s\S]*?)\]/)?.[1].match(/"/g)?.length ?? 0) / 2 === 7,
);
for (const m of MODULES) {
  checkTrue(`APPROVAL_MODULES 含 ${m}`, new RegExp(`"${m}"`).test(schemas));
}
checkTrue(
  "approveRecordSchema 用 z.enum(APPROVAL_MODULES)",
  /module: z\.enum\(APPROVAL_MODULES\)/.test(schemas),
);
checkTrue(
  "商品類型 zod 只有三個值（鏡射 DB CHECK，不是來源那六個）",
  /INV_PRODUCT_TYPES = \["outright", "consignment", "rental"\] as const/.test(schemas),
);
checkTrue(
  "沒有把型錄的 PRODUCT_TYPES 改掉（inv.products 與 public.products 是兩件事）",
  /const PRODUCT_TYPES = \["goods", "book", "event", "journey"\] as const/.test(schemas),
);

// -----------------------------------------------------------------------------
// [6] 前端的硬規矩
// -----------------------------------------------------------------------------

console.log("\n[6] 前端：SSR、toast、LocalizedField、supabase");
const FRONT = [
  "src/routes/admin/_shell.inventory-products.tsx",
  "src/lib/admin/useProductActions.ts",
  "src/lib/admin/excel-import.ts",
  "src/lib/admin/inv-product-utils.ts",
  "src/components/inventory/ApprovalActions.tsx",
  "src/components/inventory/ApprovalStatusBadge.tsx",
  "src/components/inventory/BarcodeInput.tsx",
  "src/components/inventory/BatchActionBar.tsx",
  "src/components/inventory/BatchUpdateDialog.tsx",
  "src/components/inventory/ExcelImportDialog.tsx",
  "src/components/inventory/ExcelMappingStep.tsx",
  "src/components/inventory/ExcelPreviewStep.tsx",
  "src/components/inventory/InitialPurchaseFields.tsx",
  "src/components/inventory/PriceChangeDialog.tsx",
  "src/components/inventory/PriceChangeQueue.tsx",
  "src/components/inventory/ProductDetailDialog.tsx",
  "src/components/inventory/ProductDialogs.tsx",
  "src/components/inventory/ProductFilterBar.tsx",
  "src/components/inventory/ProductFormDialog.tsx",
  "src/components/inventory/ProductFormFields.tsx",
  "src/components/inventory/ProductPageHeader.tsx",
  "src/components/inventory/ProductPagination.tsx",
  "src/components/inventory/ProductTable.tsx",
  "src/components/inventory/product-form-state.ts",
];
for (const f of FRONT) check(`${f} 存在`, existsSync(join(ROOT, f)), true);
const allFront = FRONT.map((f) => read(join(ROOT, f))).join("\n");
// 註解裡本來就會提到這些名字（「沒有搬 LocalizedField」）。斷言要看的是程式碼。
const codeFront = stripTs(allFront);

const importDialog = stripTs(read(SRC_IMPORT_DIALOG));
checkTrue(
  "xlsx 是 dynamic import（靜態 import 會在 SSR 端炸）",
  /await import\("xlsx"\)/.test(importDialog),
);
checkTrue("沒有 xlsx 的靜態 import", !/^import .*["']xlsx["']/m.test(codeFront));
checkTrue(
  "html5-qrcode 也是 dynamic import",
  /await import\("html5-qrcode"\)/.test(
    read(join(ROOT, "src/components/inventory/BarcodeInput.tsx")),
  ),
);
checkTrue("沒有 html5-qrcode 的靜態 import", !/^import .*html5-qrcode/m.test(codeFront));

checkTrue("沒有搬進 use-toast / toaster", !/use-toast|useToast/.test(codeFront));
checkTrue("要用 toast 的地方走 sonner", /from "sonner"/.test(allFront));
checkTrue("LocalizedField 沒有出現（進銷存是單語 text）", !/LocalizedField/.test(codeFront));
checkTrue("ImageField 有被重用（商品照片）", /ImageField/.test(codeFront));

// 這一期的硬要求：來源 6,100 行拆成一堆 300 行以內的檔案。沒有這一條的話，
// 下一次「順手加一點」會讓它慢慢長回 1,745 行。
console.log("\n[6d] 每個新檔案都在 300 行以內");
for (const f of FRONT) {
  // 與 `wc -l` 同一種數法：檔尾那個換行不算一行，否則每個檔案都會多算一行，
  // 而「300 行以內」這條線就會變成實際上的 299。
  const text = read(join(ROOT, f));
  const n = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  checkTrue(`${f}（${n} 行）`, n <= 300, "超過 300 行，請再拆");
}
checkTrue(
  "前端沒有直接碰 supabase",
  !/supabaseAdmin|createClient|@supabase\/supabase-js/.test(codeFront),
);
// ⚠️ 這一條在 4a 是「AI 拍照辨識沒有被搬進來（入口按鈕也沒留）」—— 當時它打的是
//    Lovable AI Gateway，離開那個平台就是一顆按了必定 500 的按鈕。
//    0018 把它接上 Gemini 了，所以斷言換成**它必須走 server fn**。
//    直接刪掉的話，「前端自己拿金鑰打 Gemini」會靜默通過。
checkTrue(
  "拍照辨識的入口回來了（0018 接上 Gemini）",
  /ProductOCR|拍照辨識/.test(codeFront),
  "4a/4b 刻意拿掉，4c 接回來。找不到入口代表整合掉了",
);
checkTrue(
  "但它是走 server fn，不是 client 直連 Gemini",
  !/generativelanguage|GEMINI_API_KEY|x-goog-api-key/.test(codeFront),
  "client 直連 = 金鑰在瀏覽器裡。辨識要走 src/lib/admin/fns/ocr.ts",
);
checkTrue(
  "而且沒有把 base64 塞進 server fn（Vercel body 上限 4.5MB）",
  !/(imageBase64|dataUrl|data_url)/.test(codeFront) &&
    !/base64[\s\S]{0,80}(recogniseBook|recognisePurchaseOrder)/.test(codeFront),
  "server fn 只收私有 bucket 的 storage key，見 src/lib/admin/fns/ocr.ts 檔頭",
);
checkTrue(
  "沒有留著已失效的 Lovable edge function 名稱",
  !/recognize-purchase-order|recognize-book|recognize-product|lovable/i.test(codeFront),
);

console.log("\n[6b] repo 層：錯誤一律 throw，不吞");
const repo = read(SRC_REPO);
const repoCode = stripTs(repo);
checkTrue("錯誤沒有被吞成空陣列", !/catch\s*\{\s*return \[\]/.test(repoCode));
checkTrue("錯誤沒有被吞成 null", !/catch\s*\{\s*return null/.test(repoCode));
checkTrue(
  "每一個 supabase 呼叫都檢查 error",
  (repo.match(/if \(error\) throw new Error/g) ?? []).length >= 14,
);
checkTrue(
  "寫入全部走 rpc（不是直接 from('products')）",
  !/\.from\("products"\)/.test(repoCode) && (repoCode.match(/\.rpc\(/g) ?? []).length >= 8,
);

console.log("\n[6c] Excel：解析在 client，寫入走 server fn");
const excel = read(SRC_EXCEL);
checkTrue("excel-import.ts 只做解析，沒有任何 supabase", !/supabase|rpc\(/.test(stripTs(excel)));
checkTrue("五級去重規則搬過來了", /sameItem/.test(excel) && /barcode/.test(excel));
checkTrue(
  "匯入寫入只有 importProducts 這一條路",
  /await import\("@\/lib\/admin\/fns\/inv-products"\)[\s\S]{0,200}?importProducts/.test(
    importDialog,
  ),
);
checkTrue(
  "條碼寫進 barcode 欄位（來源塞進 notes，所以下次匯入永遠比對不到自己）",
  /nullif\(btrim\(coalesce\(v_row->>'barcode', ''\)\), ''\)/.test(exec),
);

// -----------------------------------------------------------------------------
// [7]–[10] 實測
// -----------------------------------------------------------------------------

const REF = process.env.SUPABASE_PROJECT_REF ?? "noijrmhdfbfvjyvchvzj";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

async function q(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: text, rows: [] };
  try {
    return { ok: true, error: null, rows: JSON.parse(text) };
  } catch {
    return { ok: true, error: null, rows: [] };
  }
}

/**
 * 清乾淨。
 *
 * ⚠️ 順序不能換：sales → purchases → products。BEFORE DELETE 的
 *    rollback_fifo_cost() 會去 UPDATE inv.purchases，商品先沒了 trigger 就補不回去。
 */
async function cleanup() {
  await q(
    `delete from inv.sales     where product_id in (select id from inv.products where name like '${MARK}%');`,
  );
  await q(
    `delete from inv.purchases where product_id in (select id from inv.products where name like '${MARK}%');`,
  );
  await q(`delete from inv.products  where name like '${MARK}%';`);
}

if (!TOKEN) {
  skipped.push("實測（缺 SUPABASE_ACCESS_TOKEN）");
  console.log(yellow("\n[7]–[10] 跳過實測：沒有 SUPABASE_ACCESS_TOKEN"));
} else {
  console.log("\n[7] 實測：建立商品 → 待審核");
  await cleanup();

  const operator = await q(`select user_id from inv.profiles limit 1;`);
  const uid = operator.rows[0]?.user_id;
  checkTrue("拿得到一個操作人員 uuid", Boolean(uid));

  // 這段測試假設 approval_settings.products 是開著的。先讀，不改 —— 這是正式
  // 資料庫，測試不該改變它的設定。
  const setting = await q(
    `select is_enabled from inv.approval_settings where module = 'products';`,
  );
  const productsApprovalOn = setting.rows[0]?.is_enabled === true;
  check("approval_settings.products 是開著的（這一段的前提）", productsApprovalOn, true);

  const created = await q(`
    select public.inv_save_product(
      '${uid}'::uuid, null,
      '{"name":"${MARK}測試刊物","selling_price":"350","barcode":"${MARK}BC","issue_number":"99","pack_size":"1","low_stock_alert":"3"}'::jsonb,
      '{"quantity":5,"cost_price":"200","purchase_date":"2026-01-01"}'::jsonb
    ) as r;`);
  checkTrue("建立成功", created.ok, created.error ?? "");

  const after = await q(`
    select approval_status, selling_price::float8 as selling_price, cost_price::float8 as cost_price,
           stock_quantity, barcode, low_stock_alert, is_active
      from inv.products where name = '${MARK}測試刊物';`);
  const p = after.rows[0] ?? {};
  check("新商品 approval_status = pending（fail-closed 生效）", p.approval_status, "pending");
  check("售價逐欄正確", p.selling_price, 350);
  check("成本從一起建的進貨帶過來", p.cost_price, 200);
  check("庫存從 0 開始（進貨還沒核准）", p.stock_quantity, 0);
  check("條碼寫進 barcode 欄位", p.barcode, `${MARK}BC`);
  check("低庫存警示逐欄正確", p.low_stock_alert, 3);
  check("預設是上架中", p.is_active, true);

  const pur = await q(`
    select quantity, unit_cost::float8 as unit_cost, approval_status from inv.purchases
     where product_id = (select id from inv.products where name = '${MARK}測試刊物');`);
  check("一起建的進貨也是 pending", pur.rows[0]?.approval_status, "pending");
  check("進貨數量正確", pur.rows[0]?.quantity, 5);

  console.log("\n[8] 實測：白名單以外的 module 一定被拒");
  const pid = (await q(`select id from inv.products where name = '${MARK}測試刊物';`)).rows[0]?.id;
  for (const bad of [
    "profiles",
    "auth.users",
    "inv.vendors",
    "products; drop table inv.products",
    "",
  ]) {
    const attempt = await q(
      `select public.inv_approve_record('${uid}'::uuid, '${bad.replace(/'/g, "''")}', '${pid}'::uuid, true);`,
    );
    checkTrue(
      `module='${bad || "(空字串)"}' 被拒`,
      !attempt.ok && String(attempt.error).includes("APPROVAL_UNKNOWN_MODULE"),
      String(attempt.error).slice(0, 120),
    );
  }
  // 對照組：白名單內的一定要成功，否則上面五條「被拒」是假性通過。
  const good = await q(
    `select public.inv_approve_record('${uid}'::uuid, 'products', '${pid}'::uuid, true) as r;`,
  );
  checkTrue("對照組：module='products' 是通的", good.ok, String(good.error).slice(0, 160));
  check(
    "商品變成 approved",
    (await q(`select approval_status from inv.products where id = '${pid}';`)).rows[0]
      ?.approval_status,
    "approved",
  );

  console.log("\n[9] 實測：調價 → 待審 → 核准後才生效");
  const priceSetting = await q(
    `select is_enabled from inv.approval_settings where module = 'price_changes';`,
  );
  check(
    "approval_settings.price_changes 是開著的（這一段的前提）",
    priceSetting.rows[0]?.is_enabled,
    true,
  );

  await q(`select public.inv_request_price_change('${uid}'::uuid, '${pid}'::uuid, 210, 420);`);
  const pending =
    (
      await q(`
    select selling_price::float8 as selling_price, pending_selling_price::float8 as pending_selling_price,
           pending_cost_price::float8 as pending_cost_price, price_change_status
      from inv.products where id = '${pid}';`)
    ).rows[0] ?? {};
  check("送出後正式售價不動", pending.selling_price, 350);
  check("新售價進 pending_selling_price", pending.pending_selling_price, 420);
  check("新成本進 pending_cost_price", pending.pending_cost_price, 210);
  check("price_change_status = pending", pending.price_change_status, "pending");

  await q(
    `select public.inv_approve_record('${uid}'::uuid, 'price_changes', '${pid}'::uuid, true);`,
  );
  const applied =
    (
      await q(`
    select selling_price::float8 as selling_price, cost_price::float8 as cost_price,
           pending_selling_price, price_change_status
      from inv.products where id = '${pid}';`)
    ).rows[0] ?? {};
  check("核准後售價生效", applied.selling_price, 420);
  check("核准後成本生效", applied.cost_price, 210);
  check("pending_selling_price 被清掉", applied.pending_selling_price, null);
  check("price_change_status = approved", applied.price_change_status, "approved");

  console.log("\n[10] 實測：停用、重新送審、匯入、刪除");
  await q(`select public.inv_set_product_active('${uid}'::uuid, '${pid}'::uuid, false);`);
  check(
    "停用生效",
    (await q(`select is_active from inv.products where id = '${pid}';`)).rows[0]?.is_active,
    false,
  );

  // 退回 → 重新送審。先把它打回 pending 才退得掉（只受理 pending → rejected）。
  await q(`update inv.products set approval_status = 'pending' where id = '${pid}';`);
  await q(`select public.inv_approve_record('${uid}'::uuid, 'products', '${pid}'::uuid, false);`);
  check(
    "退回生效",
    (await q(`select approval_status from inv.products where id = '${pid}';`)).rows[0]
      ?.approval_status,
    "rejected",
  );
  await q(`select public.inv_resubmit_product('${pid}'::uuid);`);
  const resub =
    (await q(`select approval_status, approved_at from inv.products where id = '${pid}';`))
      .rows[0] ?? {};
  check("重新送審後回到 pending", resub.approval_status, "pending");
  check("上一輪的 approved_at 被清掉", resub.approved_at, null);

  // 匯入：三列，一列對到既有商品。
  const imported = await q(`
    select public.inv_import_products('${uid}'::uuid,
      '[{"name":"${MARK}匯入A","barcode":"${MARK}IA","selling_price":"120","cost_price":"60","quantity":3},
        {"name":"${MARK}匯入B","selling_price":"200","cost_price":"90","quantity":2}]'::jsonb,
      '{"create_purchase_record":true,"product_type":"outright","vendor":"${MARK}供應商","purchase_date":"2026-01-01"}'::jsonb
    ) as r;`);
  checkTrue("匯入成功", imported.ok, String(imported.error).slice(0, 160));
  check(
    "匯入建了 2 件",
    (await q(`select count(*)::int as n from inv.products where name like '${MARK}匯入%';`)).rows[0]
      ?.n,
    2,
  );
  check(
    "匯入的條碼寫進 barcode 欄位",
    (await q(`select barcode from inv.products where name = '${MARK}匯入A';`)).rows[0]?.barcode,
    `${MARK}IA`,
  );
  check(
    "匯入一起建了 2 筆進貨",
    (
      await q(
        `select count(*)::int as n from inv.purchases p join inv.products pr on pr.id = p.product_id where pr.name like '${MARK}匯入%';`,
      )
    ).rows[0]?.n,
    2,
  );

  // 匯入的交易性：一列壞掉整批都不寫。
  const beforeBad = (
    await q(`select count(*)::int as n from inv.products where name like '${MARK}%';`)
  ).rows[0]?.n;
  const bad = await q(`
    select public.inv_import_products('${uid}'::uuid,
      '[{"name":"${MARK}好的一列","selling_price":"100","quantity":1},
        {"name":"","selling_price":"100","quantity":1}]'::jsonb, '{}'::jsonb) as r;`);
  checkTrue("有一列沒有名稱 → 整批失敗", !bad.ok);
  check(
    "整批失敗時前面那一列也沒有被寫進去（一個交易）",
    (await q(`select count(*)::int as n from inv.products where name like '${MARK}%';`)).rows[0]?.n,
    beforeBad,
  );

  // 刪除守門：先讓它有一筆銷售。
  //
  // ⚠️ 這裡的每一步都要斷言成功。第一版沒斷言，而且 `select id from inv.purchases p
  //    join inv.products pr` 的 id 是**有歧義的**（兩張表都有 id），所以進貨從來
  //    沒被核准、庫存是 0、銷售寫不進去 —— 於是「賣過的不能刪」那一條測到的是
  //    「沒賣過的可以刪」。前置條件不斷言的話，測試會安靜地測到別的東西。
  const approvePurchase = await q(
    `select public.inv_approve_record('${uid}'::uuid, 'purchases',
       (select p.id from inv.purchases p join inv.products pr on pr.id = p.product_id
         where pr.name = '${MARK}匯入A'), true);`,
  );
  checkTrue(
    "前置：匯入A 的進貨核准成功",
    approvePurchase.ok,
    String(approvePurchase.error).slice(0, 160),
  );
  const aid = (await q(`select id from inv.products where name = '${MARK}匯入A';`)).rows[0]?.id;
  check(
    "前置：核准進貨後庫存變成 3",
    (await q(`select stock_quantity from inv.products where id = '${aid}';`)).rows[0]
      ?.stock_quantity,
    3,
  );
  const sale =
    await q(`insert into inv.sales (user_id, product_id, sale_date, quantity, unit_price, amount, cost_price)
           values ('${uid}'::uuid, '${aid}'::uuid, current_date, 1, 100, 100, 10);`);
  checkTrue("前置：銷售寫得進去", sale.ok, String(sale.error).slice(0, 160));
  check(
    "前置：這件商品現在有 1 筆銷售",
    (await q(`select count(*)::int as n from inv.sales where product_id = '${aid}';`)).rows[0]?.n,
    1,
  );
  const delSold = await q(`select public.inv_delete_product('${aid}'::uuid);`);
  checkTrue(
    "賣過的商品不能刪（外鍵是 SET NULL，不會替你擋）",
    !delSold.ok && String(delSold.error).includes("PRODUCT_HAS_SALES"),
    String(delSold.error).slice(0, 120),
  );
  const bid = (await q(`select id from inv.products where name = '${MARK}匯入B';`)).rows[0]?.id;
  const delOk = await q(`select public.inv_delete_product('${bid}'::uuid);`);
  checkTrue("沒賣過的可以刪", delOk.ok, String(delOk.error).slice(0, 120));

  console.log("\n[11] 清理：測試資料全部刪掉，2,864 筆一筆不少");
  await cleanup();
  check(
    "測試商品全部刪光",
    (await q(`select count(*)::int as n from inv.products where name like '${MARK}%';`)).rows[0]?.n,
    0,
  );
  check(
    "測試進貨全部刪光",
    (await q(`select count(*)::int as n from inv.purchases where notes like '%${MARK}%';`)).rows[0]
      ?.n,
    0,
  );
  check(
    "inv.products 回到 993 筆",
    (await q(`select count(*)::int as n from inv.products;`)).rows[0]?.n,
    993,
  );
  check(
    "public.publications 仍是 126 筆",
    (await q(`select count(*)::int as n from public.publications;`)).rows[0]?.n,
    126,
  );

  console.log("\n[12] 實測：anon 打不到新 view");
  const grants = await q(`
    select count(*)::int as n from information_schema.role_table_grants
     where grantee in ('anon','authenticated') and table_name like 'inv_admin_%';`);
  check("anon/authenticated 對 inv_admin_* 一個權限都沒有", grants.rows[0]?.n, 0);
}

// ── 結果 ────────────────────────────────────────────────────────────────────

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
