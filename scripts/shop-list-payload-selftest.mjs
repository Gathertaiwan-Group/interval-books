#!/usr/bin/env node
/**
 * shop-list-payload-selftest.mjs —— /shop 的 SSR payload 瘦身自檢（2026-09 前台
 * 載入速度優化）
 *
 * ── 背景：428KB 從哪裡來 ──────────────────────────────────────────────────
 * 正式站量到 /shop 的 HTML 是 428KB，最大一段是 254KB 的 SSR 序列化資料，裡面
 * 43 個 `description`、40 個 `summary`、65,771 個中日文字元——完整三語商品描述
 * 被送給每個訪客，而列表頁（ProductsPanel）一個字都不畫。往下查發現 loader 其實
 * 把商品目錄讀了兩次：fetchActiveProducts()（商品分頁）與
 * fetchActiveProductsByIds()（地方刊物分頁核對可購買狀態），而後者的 id 集合
 * 必然是前者的子集（兩邊都只挑 status='active'），所以有大量重疊商品被完整序列化
 * 兩次。頁面文案也是三次 fetchPage() 各打三個查詢，九次網路往返。
 *
 * 這支自檢守的是修法本身的形狀，不是量測 KB 數字（那需要真的跑一次 SSR，不是
 * 這個 repo 的 selftest 慣例——見 scripts/nav-consolidation-selftest.mjs 檔頭：
 * 全部靜態、不連資料庫、不發網路請求）。KB 數字改在交付回報裡用實跑的方式附上。
 *
 * ── 這支自檢在防哪幾種假性通過 ────────────────────────────────────────────
 * 1. **改了函式名但邏輯沒變。** 只檢查「/shop 有沒有 import 一個叫
 *    fetchActiveProductsForList 的東西」不夠——那個函式本身也可能還是照抄
 *    COLUMNS（含 description）。所以 [1] 段直接檢查 CARD_COLUMNS 這個字串常數
 *    本身不含 "description"，而且 COLUMNS（給 /shop/$slug 詳情頁與購物車／結帳
 *    用的那份）**仍然含** description——瘦身不能瘦到把詳情頁需要的欄位也拿掉。
 * 2. **列表頁的 catalogue 型別換了，但畫面偷偷加回 .description。** [3]/[4]
 *    段直接掃 ProductsPanel.tsx／PublicationsPanel.tsx 的原始碼（stripTs 之後）
 *    找 `.description` 這個成員存取——這兩個檔案目前完全沒有出現過
 *    "description" 這個字（連註解都沒有），所以文字比對在這裡是安全的，不需要
 *    上 AST。同時用正面控制組確認 `.summary`／`.title` 還在，證明「查不到」
 *    不是因為檔案被清空。
 * 3. **loader 兩個分頁傳了兩份不同的 catalogue，看起來像是接對了但其實各自
 *    另外撈了一次。** [2] 段直接比對 <ProductsPanel> 與 <PublicationsPanel>
 *    的 catalogue prop 是不是同一個 identifier（catalogue），而且整個檔案裡
 *    fetchActiveProducts / fetchActiveProductsByIds 這兩個名字**只能出現在
 *    註解裡**（解釋歷史用的），不能是真的 import 或呼叫。
 *
 * ⚠️ 每一條斷言都做過突變測試（把產線那一行改壞、確認轉紅、再改回來），結果寫在
 *    交付回報裡。
 *
 * 這支測試不碰資料庫、不讀環境變數、不發網路請求。
 *
 * 執行：node scripts/shop-list-payload-selftest.mjs（或 npm test）
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/shop-list-payload-selftest.mjs";

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

/** 拿掉 TypeScript 的註解——見 event-detail-page-selftest.mjs 檔頭的假陽性說明。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const FILES = {
  shop: "src/lib/shop.ts",
  cart: "src/lib/cart.ts",
  cms: "src/lib/cms.ts",
  shopIndex: "src/routes/shop.index.tsx",
  productsPanel: "src/components/shop/ProductsPanel.tsx",
  publicationsPanel: "src/components/shop/PublicationsPanel.tsx",
};

const raw = {};
const src = {};
for (const [key, rel] of Object.entries(FILES)) {
  raw[key] = readFile(join(ROOT, rel));
  src[key] = stripTs(raw[key]);
}

// =============================================================================
// [0] 反空殼
// =============================================================================
console.log("\n[0] 反空殼 —— 每個受檢檔案都真的讀得到程式碼");
for (const [key, rel] of Object.entries(FILES)) {
  checkTrue(`${rel} 長度 > 500`, src[key].length > 500);
}

// =============================================================================
// [1] 欄位層級——CARD_COLUMNS 不含 description，COLUMNS（詳情頁／購物車／結帳
//     用的那份）仍然含 description
// =============================================================================
console.log("\n[1] src/lib/shop.ts —— 欄位清單");

const columnsMatch = src.shop.match(/const COLUMNS\s*=\s*"([^"]+)"/);
const cardColumnsMatch = src.shop.match(/const CARD_COLUMNS\s*=\s*"([^"]+)"/);
checkTrue("找得到 COLUMNS 字串常數", columnsMatch !== null);
checkTrue("找得到 CARD_COLUMNS 字串常數", cardColumnsMatch !== null);

const columns = columnsMatch?.[1] ?? "";
const cardColumns = cardColumnsMatch?.[1] ?? "";

checkTrue(
  "COLUMNS（給 /shop/$slug、/cart、/checkout 用）含 description —— 詳情頁需要它",
  columns
    .split(",")
    .map((c) => c.trim())
    .includes("description"),
);
checkFalse(
  "CARD_COLUMNS（給 /shop 列表頁用）不含 description —— 列表頁一個字都不畫它",
  cardColumns
    .split(",")
    .map((c) => c.trim())
    .includes("description"),
);
// 正面控制組：CARD_COLUMNS 不是「COLUMNS 打錯成空字串」——它仍然有列表卡片
// 需要的欄位，只是少了 description 這一個。
for (const mustHave of ["id", "slug", "product_type", "title", "summary", "price", "image_key"]) {
  checkTrue(
    `CARD_COLUMNS 仍然含 ${mustHave}（瘦身不是清空）`,
    cardColumns
      .split(",")
      .map((c) => c.trim())
      .includes(mustHave),
  );
}
// CARD_COLUMNS 剛好比 COLUMNS 少一個欄位（description），不是意外多刪了別的。
const columnSet = new Set(columns.split(",").map((c) => c.trim()));
const cardColumnSet = new Set(cardColumns.split(",").map((c) => c.trim()));
const missingFromCard = [...columnSet].filter((c) => !cardColumnSet.has(c));
check("COLUMNS 相對 CARD_COLUMNS 剛好多一個欄位：description", missingFromCard, ["description"]);

checkTrue(
  "fetchActiveProductsForList() 存在，回傳型別是 ShopListCardResult",
  /export async function fetchActiveProductsForList\(\): Promise<ShopListCardResult>/.test(
    src.shop,
  ),
);
checkTrue(
  "fetchActiveProductsForList() 查詢用的是 CARD_COLUMNS，不是 COLUMNS",
  /fetchActiveProductsForList[\s\S]{0,600}?\.select\(CARD_COLUMNS\)/.test(src.shop),
);
checkTrue(
  "既有的 fetchActiveProducts()（給 /cart、/checkout、/shop/\\$slug 用）沒有被改動，仍然用 COLUMNS",
  /export async function fetchActiveProducts\(\): Promise<ShopListResult>[\s\S]{0,600}?\.select\(COLUMNS\)/.test(
    src.shop,
  ),
);
checkTrue(
  "既有的 fetchActiveProductBySlug()（給 /shop/\\$slug 詳情頁用）沒有被改動，仍然用 COLUMNS",
  /export async function fetchActiveProductBySlug[\s\S]{0,400}?\.select\(COLUMNS\)/.test(src.shop),
);

// =============================================================================
// [2] src/routes/shop.index.tsx —— loader 接線
// =============================================================================
console.log("\n[2] shop.index.tsx —— loader 用瘦身過的讀取，兩個分頁共用同一份 catalogue");

checkTrue(
  "import 了 fetchActiveProductsForList",
  /import \{[^}]*\bfetchActiveProductsForList\b[^}]*\} from "@\/lib\/shop";/.test(src.shopIndex),
);
checkFalse(
  "沒有 import fetchActiveProducts（不帶 ForList 的那個）",
  /import \{[^}]*[^F]\bfetchActiveProducts\b[^F][^}]*\} from "@\/lib\/shop";|import \{\s*fetchActiveProducts\s*[,}]/.test(
    src.shopIndex,
  ),
);
checkFalse(
  "沒有 import fetchActiveProductsByIds —— 第二次讀取已經拿掉",
  /fetchActiveProductsByIds/.test(src.shopIndex),
);
checkFalse(
  "沒有 publicationProducts 這個變數了 —— 兩個分頁共用同一份 catalogue",
  /publicationProducts/.test(src.shopIndex),
);
checkTrue(
  "import 了 fetchPages（批次版）",
  /import \{[^}]*\bfetchPages\b[^}]*\} from "@\/lib\/cms";/.test(src.shopIndex),
);
checkFalse(
  "沒有 import fetchPage（單一版，不帶 s）",
  /import \{[^}]*[^s]\bfetchPage\b[^}]*\} from "@\/lib\/cms";/.test(src.shopIndex) &&
    !/fetchPages/.test(src.shopIndex.match(/import \{[^}]*\bfetchPage\b[^}]*\}/)?.[0] ?? ""),
);
checkTrue(
  'loader 呼叫 fetchPages(["shop", "publications", "curated"])',
  /fetchPages\(\s*\[\s*"shop"\s*,\s*"publications"\s*,\s*"curated"\s*\]\s*\)/.test(src.shopIndex),
);

// <ProductsPanel> 與 <PublicationsPanel> 的 catalogue prop 必須是同一個
// identifier（catalogue），不是兩個分頁各自對到不同的資料來源。
const productsPanelTag = src.shopIndex.match(/<ProductsPanel\b[^>]*\/>/)?.[0] ?? "";
const publicationsPanelTag = src.shopIndex.match(/<PublicationsPanel\b[^>]*\/>/)?.[0] ?? "";
checkTrue("找得到 <ProductsPanel ... /> 標籤", productsPanelTag.length > 0);
checkTrue("找得到 <PublicationsPanel ... /> 標籤", publicationsPanelTag.length > 0);
checkTrue(
  "<ProductsPanel> 的 catalogue prop 是 catalogue={catalogue}",
  /catalogue=\{catalogue\}/.test(productsPanelTag),
);
checkTrue(
  "<PublicationsPanel> 的 catalogue prop 也是 catalogue={catalogue}（同一份，不是另一個變數）",
  /catalogue=\{catalogue\}/.test(publicationsPanelTag),
);

// =============================================================================
// [3] ProductsPanel.tsx —— 不讀 .description，仍然讀 .summary/.title
// =============================================================================
console.log("\n[3] ProductsPanel.tsx —— 列表卡片不畫 description");
checkFalse(
  '"description" 這個字完全沒出現在 ProductsPanel.tsx（連註解都沒有）',
  /description/.test(src.productsPanel),
);
checkTrue(
  "正面控制組：仍然畫 prod.summary（卡片的簡介文字）",
  /\{t\(prod\.summary\)\}/.test(src.productsPanel),
);
checkTrue(
  "正面控制組：仍然畫 prod.title（卡片標題）",
  /\{t\(prod\.title\)\}/.test(src.productsPanel),
);
checkTrue(
  "型別已經改成 ShopListCardResult",
  /catalogue:\s*ShopListCardResult/.test(src.productsPanel),
);
checkFalse("型別不再是 ShopListResult", /catalogue:\s*ShopListResult\b/.test(src.productsPanel));

// =============================================================================
// [4] PublicationsPanel.tsx —— 同上，且產品卡片型別改成 ShopProductCard
// =============================================================================
console.log("\n[4] PublicationsPanel.tsx —— 刊物分頁掛的商品卡片也不畫 description");
checkFalse(
  '"description" 這個字完全沒出現在 PublicationsPanel.tsx（連註解都沒有）',
  /description/.test(src.publicationsPanel),
);
checkTrue(
  "型別已經改成 ShopListCardResult",
  /catalogue:\s*ShopListCardResult/.test(src.publicationsPanel),
);
checkTrue(
  "PublicationCard 的 product prop 型別是 ShopProductCard",
  /product:\s*ShopProductCard\s*\|\s*null/.test(src.publicationsPanel),
);
checkFalse(
  "product prop 不再是完整的 ShopProduct",
  /product:\s*ShopProduct\s*\|\s*null/.test(src.publicationsPanel),
);

// =============================================================================
// [4b] 刊物的 intro——跟商品的 description 是同一類問題，同一種修法
// =============================================================================
// 126 本刊物每本都帶完整三語 intro，量到佔了 /shop 頁面 ~330KB 裡的 ~227KB，而
// intro 只有點開某一本的「刊物介紹」才會顯示（預設全部收合，跟商品的
// description 只在 /shop/$slug 詳情頁才顯示是同一類問題）。修法是 list 版讀取
// 不含 intro/externalUrl，點開哪一本才現查那一本——見
// src/lib/publications.ts#fetchPublicationDetail 檔頭。
console.log("\n[4b] PublicationsPanel.tsx／publications.ts —— intro 不隨列表預載（在刊物頁 SSR）");

checkFalse(
  "entry.intro 不再被直接讀取（entry 是 list 版，沒有這個欄位）",
  /entry\.intro\b/.test(src.publicationsPanel),
);
checkFalse(
  "entry.externalUrl 也不再被直接讀取",
  /entry\.externalUrl\b/.test(src.publicationsPanel),
);
// 2026-11 M4：「點開卡片才現查介紹」的展開區拿掉了——介紹文改到每一本自己的頁面
// /publications/$slug 在 SSR 輸出（那一頁才讀 intro，見 fetchPublicationBySlug()）。
// 列表仍然不帶 intro：下面守「卡片連到刊物頁」，以及 PublicationsPanel 不再自己讀資料。
checkTrue(
  "正面控制組：卡片連到 /publications/$slug（介紹在那一頁）",
  /to="\/publications\/\$slug"/.test(src.publicationsPanel),
);
checkFalse(
  "PublicationsPanel 不再 import／呼叫 fetchPublicationDetail（展開現查拿掉了）",
  /fetchPublicationDetail/.test(src.publicationsPanel),
);
checkFalse("PublicationsPanel 不再有 useEffect 現查", /useEffect\(/.test(src.publicationsPanel));

const publicationsSrc = stripTs(readFile(join(ROOT, "src/lib/publications.ts")));
checkTrue(
  'publications.ts 匯出 PublicationListEntry = Omit<PublicationEntry, "intro" | "externalUrl">',
  /export type PublicationListEntry = Omit<PublicationEntry, "intro" \| "externalUrl">/.test(
    publicationsSrc,
  ),
);
const pubCardColumnsMatch = publicationsSrc.match(/const CARD_COLUMNS\s*=\s*"([^"]+)"/);
checkTrue("找得到 publications.ts 的 CARD_COLUMNS", pubCardColumnsMatch !== null);
const pubCardColumns = (pubCardColumnsMatch?.[1] ?? "").split(",").map((c) => c.trim());
checkFalse("CARD_COLUMNS 不含 intro", pubCardColumns.includes("intro"));
checkFalse("CARD_COLUMNS 不含 external_url", pubCardColumns.includes("external_url"));
for (const mustHave of ["id", "slug", "title", "publisher", "region", "cover_image_key"]) {
  checkTrue(`CARD_COLUMNS 仍然含 ${mustHave}（瘦身不是清空）`, pubCardColumns.includes(mustHave));
}
checkTrue(
  "fetchPublicationBySlug() 存在，單一本用完整 COLUMNS（含 intro）",
  /export async function fetchPublicationBySlug[\s\S]{0,600}?\.select\(COLUMNS\)/.test(
    publicationsSrc,
  ),
);
checkFalse(
  "fetchPublicationDetail() 已移除（沒有呼叫端）",
  /export async function fetchPublicationDetail/.test(publicationsSrc),
);
checkTrue(
  "fetchPublicationsForList() 存在，查詢用 CARD_COLUMNS",
  /export async function fetchPublicationsForList[\s\S]{0,600}?\.select\(CARD_COLUMNS\)/.test(
    publicationsSrc,
  ),
);
checkTrue(
  "既有的 fetchPublications()（尚未有其他呼叫端，保留未動）沒有被改動，仍然用 COLUMNS",
  /export async function fetchPublications\(\): Promise<PublicationsResult>[\s\S]{0,600}?\.select\(COLUMNS\)/.test(
    publicationsSrc,
  ),
);

// =============================================================================
// [5] cart.ts / shop.ts —— 共用 helper 被改成接受卡片型別，不是列表頁自己算
// =============================================================================
console.log("\n[5] 共用 helper（remainingFor／isSoldOut／cartInputFor）——型別放寬，邏輯沒變");
checkTrue(
  "remainingFor() 參數型別是 ShopProductCard",
  /export function remainingFor\(p: ShopProductCard\)/.test(src.shop),
);
checkTrue(
  "isSoldOut() 參數型別是 ShopProductCard",
  /export function isSoldOut\(p: ShopProductCard\)/.test(src.shop),
);
checkTrue(
  "cartInputFor() 參數型別是 ShopProductCard",
  /export function cartInputFor\(\s*p: ShopProductCard,/.test(src.cart),
);
// ProductsPanel／PublicationsPanel 真的呼叫這些共用 helper，不是自己另外算
// 「還剩幾件」「是否售完」——這是「該問共用 helper 的還是要問」那條規矩。
checkTrue("ProductsPanel 呼叫 remainingFor()", /remainingFor\(/.test(src.productsPanel));
checkTrue("ProductsPanel 呼叫 isSoldOut()", /isSoldOut\(/.test(src.productsPanel));
checkTrue("PublicationsPanel 呼叫 remainingFor()", /remainingFor\(/.test(src.publicationsPanel));
checkTrue("PublicationsPanel 呼叫 isSoldOut()", /isSoldOut\(/.test(src.publicationsPanel));
checkTrue("PublicationsPanel 呼叫 cartInputFor()", /cartInputFor\(/.test(src.publicationsPanel));

// =============================================================================
// [6] cms.ts —— fetchPages 批次查詢
// =============================================================================
console.log("\n[6] cms.ts —— fetchPages() 批次讀取");
checkTrue(
  "fetchPages() 存在，接受 slugs 陣列",
  /export async function fetchPages\(slugs: string\[\]\): Promise<Record<string, PageContent \| null>>/.test(
    src.cms,
  ),
);
checkTrue(
  "select() 的 SelectOptions 多了 in 選項",
  /in\?:\s*\[column: string, values: string\[\]\]/.test(src.cms),
);
checkTrue(
  "select() 真的把 options.in 接到 query.in(...)",
  /if \(options\.in\) query = query\.in\(options\.in\[0\], options\.in\[1\]\);/.test(src.cms),
);
checkTrue(
  "既有的 fetchPage()（單一 slug，給其餘二十幾條路由用）完全沒被改動——仍然是三個 eq 查詢",
  /export async function fetchPage\(slug: string\): Promise<PageContent \| null>[\s\S]{0,700}?eq: \["slug", slug\][\s\S]{0,400}?eq: \["page_slug", slug\][\s\S]{0,400}?eq: \["page_slug", slug\]/.test(
    src.cms,
  ),
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
