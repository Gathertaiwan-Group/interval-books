#!/usr/bin/env node
/**
 * note-barcode-selftest.mjs —— 「條碼寫在備註裡」的比對（src/lib/admin/note-barcode.ts）自檢
 *
 * 正式庫 993 筆商品只有 27 筆 barcode 欄有值，約 723 筆的條碼寫在 notes（「條碼: 636864」）。
 * 櫃檯掃碼（inv-sales.ts findPosProductByBarcode）與後台商品搜尋（inv-products.ts
 * listAdminProducts）都要找得到。
 *
 *   [1] 純函式（直接 import 產線程式碼）：輸入正規化、ILIKE 轉義、備註解析（半形／全形冒號、
 *       有無空白、多行）、整碼相等（部分數字不誤中）。
 *   [2] 兩段式流程：用一個「照 Postgres ILIKE 語意（含 \ 跳脫）」實作的假資料庫跑
 *       findIdsByNoteBarcode，證明粗篩 + 精篩的結果正確、萬用字元輸入不會打到資料庫。
 *   [3] 靜態：兩個 repo 真的接上了這支 lib，而且櫃檯那一段最後一定回到 inv_pos_products
 *       （賣不動的品項不能因為備註比對而被掃進購物車）。
 *   [4] 正式庫唯讀（選用）：NOTE_BARCODE_LIVE=1 且有 VITE_SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY
 *       （或 NOTE_BARCODE_ENV_FILE 指向 env 檔）時，挑 3 筆「條碼只在備註、櫃檯賣得動」的商品，
 *       用與 repo 同樣的兩段查詢確認找得到。只有 GET，不寫任何東西。
 *
 * 執行：node scripts/note-barcode-selftest.mjs（或 npm test；[4] 沒設環境變數就略過）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/note-barcode-selftest.mjs";
const M = await import(pathToFileURL(join(ROOT, "src/lib/admin/note-barcode.ts")).href);

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
const skip = (label) => console.log(`  \x1b[33m- 略過：${label}\x1b[0m`);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] 純函式");
const N = M.normalizeScannedCode;
check("trim 前後空白", N("  636864 \n"), "636864");
check("13 碼 ISBN", N("9789861234567"), "9789861234567");
check("英數混合", N("ABC123"), "ABC123");
check("全形數字 → 半形（NFKC）", N("６３６８６４"), "636864");
check("空字串 → null", N("   "), null);
check("非字串 → null", N(undefined), null);
check("含 % → null（不組 ILIKE）", N("63%"), null);
check("含 _ → null", N("6_6"), null);
check("含 \\ → null", N("6\\6"), null);
check("含連字號 → null（備註比對只收純英數）", N("978-986"), null);
check("中間有空白 → null", N("636 864"), null);
check("超過 64 碼 → null", N("1".repeat(65)), null);

const E = M.escapeLikePattern;
check("escape %", E("a%b"), "a\\%b");
check("escape _", E("a_b"), "a\\_b");
check("escape \\", E("a\\b"), "a\\\\b");
check("純英數不變", E("636864"), "636864");
check("pattern 形狀", M.noteBarcodeIlikePattern("636864"), "%條碼%636864%");

const X = M.extractNoteBarcodes;
check("半形冒號 + 空白（正式庫的主流格式）", X("條碼: 636864\n系列: 2024.08"), ["636864"]);
check("全形冒號", X("條碼：636864"), ["636864"]);
check("全形冒號 + 空白", X("條碼： 636864"), ["636864"]);
check("沒有空白", X("條碼:636864"), ["636864"]);
check("冒號前有空白", X("條碼 : 636864"), ["636864"]);
check("沒有冒號", X("條碼 636864"), ["636864"]);
check("冒號後換行", X("條碼:\n636864"), ["636864"]);
check("多行，條碼在中間", X("系列: 2021.12\n條碼: 631956\n出版: MS-72173"), ["631956"]);
check("Windows 換行", X("條碼: 631956\r\n系列: 2021.12"), ["631956"]);
check("尾巴標點去掉", X("條碼: 636864。"), ["636864"]);
check("同一行逗號分隔", X("條碼: 636864，系列: x"), ["636864"]);
check("全形數字", X("條碼：６３６８６４"), ["636864"]);
check("沒有條碼字樣", X("系列: 636864"), []);
check("null / 空字串", [X(null), X("")], [[], []]);
check("科學記號保持原樣（讓它對不上，不切成 9）", X("條碼: 9.78986E+12"), ["9.78986E+12"]);

const H = M.noteHasBarcode;
check("整碼相等命中", H("條碼: 636864\n系列: 2024.08", "636864"), true);
check("部分數字不中：掃到的是備註碼的前綴", H("條碼: 6368641", "636864"), false);
check("部分數字不中：掃到的是備註碼的後綴", H("條碼: 1636864", "636864"), false);
check("部分數字不中：備註碼是掃到碼的前綴", H("條碼: 63686", "636864"), false);
check("碼出現在別的欄位不中", H("條碼: 111111\n系列: 636864", "636864"), false);
check("科學記號不會被 9 命中", H("條碼: 9.78986E+12", "9"), false);
check("英文字母不分大小寫", H("條碼: abc123", "ABC123"), true);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] 兩段式流程（假資料庫，照 Postgres ILIKE + \\ 跳脫語意）");

/** Postgres ILIKE（預設 ESCAPE '\'）→ JS RegExp。 */
function ilikeToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    } else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}
check("假 ILIKE 自檢：% 萬用", ilikeToRegExp("%a%").test("xxaxx"), true);
check("假 ILIKE 自檢：\\% 是字面 %", ilikeToRegExp("a\\%").test("ab"), false);

const DB = [
  { inv_product_id: "p-plain", notes: "條碼: 636864\n系列: 2024.08" },
  { inv_product_id: "p-fullwidth", notes: "條碼：777001" },
  { inv_product_id: "p-nospace", notes: "條碼:888002\n出版: X" },
  { inv_product_id: "p-multiline", notes: "系列: 2021.12\n條碼: 9789861234567\n出版: MS-72173" },
  { inv_product_id: "p-longer", notes: "條碼: 6368641" },
  { inv_product_id: "p-other-field", notes: "條碼: 111111\n系列: 636864" },
  { inv_product_id: "p-null", notes: null },
  { inv_product_id: "p-percent", notes: "條碼: 50%off" },
];
const calls = [];
async function fakeFetch(pattern, limit) {
  calls.push(pattern);
  const re = ilikeToRegExp(pattern);
  return DB.filter((r) => r.notes != null && re.test(r.notes)).slice(0, limit);
}
const F = (code) => M.findIdsByNoteBarcode(code, fakeFetch);

check("備註命中（半形冒號）", await F("636864"), ["p-plain"]);
check(
  "粗篩撈到 3 列、精篩只留整碼相等的那一列",
  DB.filter((r) => r.notes && ilikeToRegExp("%條碼%636864%").test(r.notes)).length,
  3,
);
check("備註命中（全形冒號）", await F("777001"), ["p-fullwidth"]);
check("備註命中（沒有空白）", await F("888002"), ["p-nospace"]);
check("備註命中（多行、條碼在中間）", await F("9789861234567"), ["p-multiline"]);
check("掃碼前後空白照樣命中", await F("  636864\n"), ["p-plain"]);
check("部分數字不誤中", await F("63686"), []);
check("沒有的碼", await F("000000"), []);
calls.length = 0;
check("輸入 % → 空陣列", await F("%"), []);
check("輸入 _ → 空陣列", await F("_"), []);
check("輸入 50%off → 空陣列", await F("50%off"), []);
check("輸入 \\ → 空陣列", await F("\\"), []);
check("輸入 %條碼% → 空陣列", await F("%條碼%"), []);
check("萬用字元輸入一次都沒有打資料庫", calls, []);
// 即使有人繞過 normalizeScannedCode 直接組 pattern，轉義後也不會變成萬用字元
check(
  "轉義後的 % 只比對字面 %",
  DB.filter(
    (r) => r.notes && ilikeToRegExp(`%條碼%${M.escapeLikePattern("%")}%`).test(r.notes),
  ).map((r) => r.inv_product_id),
  ["p-percent"],
);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 靜態：repo 接線");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sales = strip(readFileSync(join(ROOT, "src/server/repos/inv-sales.ts"), "utf8"));
const products = strip(readFileSync(join(ROOT, "src/server/repos/inv-products.ts"), "utf8"));
const fnBody = (src, name) => {
  const i = src.indexOf(`export async function ${name}`);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + 1);
  return src.slice(i, j < 0 ? undefined : j);
};
const pos = fnBody(sales, "findPosProductByBarcode");
check("findPosProductByBarcode 先比 barcode 欄", /\.eq\("barcode", code\)/.test(pos), true);
check(
  "找不到才走備註",
  pos.indexOf('.eq("barcode"') < pos.indexOf("findInvProductIdsByNoteBarcode("),
  true,
);
check(
  "備註命中後回到 inv_pos_products 取資料（賣不動的濾掉）",
  /findInvProductIdsByNoteBarcode\([\s\S]*from\("inv_pos_products"\)[\s\S]*\.in\("inv_product_id", ids\)/.test(
    pos,
  ),
  true,
);
const lookup = fnBody(products, "findInvProductIdsByNoteBarcode");
check("備註查詢走 lib 的 findIdsByNoteBarcode", /findIdsByNoteBarcode\(code,/.test(lookup), true);
check(
  '備註查詢用 .ilike("notes", pattern)（pattern 由 lib 轉義）',
  /\.ilike\("notes", pattern\)/.test(lookup),
  true,
);
check(
  "備註查詢讀的是有 notes 欄的 inv_admin_products",
  /from\("inv_admin_products"\)/.test(lookup),
  true,
);
check(
  "備註查詢有固定排序（多筆命中時結果穩定）",
  /\.order\("name"[\s\S]*\.order\("inv_product_id"/.test(lookup),
  true,
);
const list = fnBody(products, "listAdminProducts");
check(
  "商品清單關鍵字搜尋併入備註條碼命中的 id",
  /inv_product_id\.in\.\(\$\{noteIds\.join\(","\)\}\)/.test(list),
  true,
);
check("商品清單只在關鍵字是純英數時才查備註", /normalizeScannedCode\(safe\)/.test(list), true);
const mig = readFileSync(
  join(ROOT, "supabase/migrations/0016_inventory_products_admin.sql"),
  "utf8",
);
const view = mig.slice(mig.indexOf("create or replace view public.inv_admin_products"));
check(
  "inv_admin_products view 有 notes 欄（0016）",
  /p\.notes\s+as notes/.test(view.slice(0, 3000)),
  true,
);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] 正式庫唯讀驗證");
if (process.env.NOTE_BARCODE_LIVE !== "1") {
  skip("NOTE_BARCODE_LIVE 未設");
} else {
  const env = { ...process.env };
  if (process.env.NOTE_BARCODE_ENV_FILE) {
    for (const line of readFileSync(process.env.NOTE_BARCODE_ENV_FILE, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && !env[line.slice(0, i)])
        env[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, "");
    }
  }
  const U = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  const K = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!U || !K) {
    skip("沒有 SUPABASE URL／service key");
  } else {
    const get = async (path) => {
      const r = await fetch(`${U}/rest/v1/${path}`, {
        headers: { apikey: K, Authorization: `Bearer ${K}` },
      });
      if (!r.ok) throw new Error(`GET ${path.split("?")[0]} → ${r.status}`);
      return r.json();
    };
    // 與 inv-products.ts findInvProductIdsByNoteBarcode 同一句查詢
    const liveFetch = (pattern, limit) =>
      get(
        `inv_admin_products?select=inv_product_id,notes&notes=ilike.${encodeURIComponent(pattern)}` +
          `&order=name.asc,inv_product_id.asc&limit=${limit}`,
      );
    const sellable = await get("inv_pos_products?select=inv_product_id,barcode&limit=5000");
    const sellableNoBarcode = new Set(
      sellable.filter((r) => !r.barcode).map((r) => r.inv_product_id),
    );
    const noted = await get(
      "inv_admin_products?select=inv_product_id,name,notes,barcode&notes=ilike.*%E6%A2%9D%E7%A2%BC*&limit=2000",
    );
    const all = noted
      .filter((r) => !r.barcode && sellableNoBarcode.has(r.inv_product_id))
      .map((r) => ({ ...r, code: M.extractNoteBarcodes(r.notes)[0] }))
      .filter((r) => r.code && M.normalizeScannedCode(r.code));
    console.log(`  （條碼只在備註、櫃檯賣得動、碼是純英數：${all.length} 筆）`);
    // 挑 3 筆：一筆 6 碼、一筆 13 碼、一筆隨便
    const picks = [
      all.find((r) => r.code.length === 6),
      all.find((r) => r.code.length === 13),
      all[Math.floor(all.length / 2)],
    ].filter(Boolean);
    check("挑得到 3 筆樣本", picks.length, 3);
    for (const p of picks) {
      const ids = await M.findIdsByNoteBarcode(p.code, liveFetch);
      check(
        `備註碼 ${p.code}（${p.code.length} 碼）→ 找到 ${p.inv_product_id.slice(0, 8)}`,
        ids.includes(p.inv_product_id),
        true,
      );
      const posRows = await get(
        `inv_pos_products?select=inv_product_id,name,available&inv_product_id=in.(${ids.join(",")})`,
      );
      check(
        `  第二段 inv_pos_products 取得到（櫃檯會加進購物車）`,
        posRows.some((r) => r.inv_product_id === p.inv_product_id),
        true,
      );
      const partial = await M.findIdsByNoteBarcode(p.code.slice(0, -1), liveFetch);
      check(
        `  少一位數 ${p.code.slice(0, -1)} 不會命中同一筆`,
        partial.includes(p.inv_product_id),
        false,
      );
    }
  }
}

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
