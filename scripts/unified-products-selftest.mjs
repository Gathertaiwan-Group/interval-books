#!/usr/bin/env node
/**
 * unified-products-selftest.mjs —— 後台「商品」單一頁（2026-10-20）的自檢
 *
 *   [執行] 直接 `await import()` src/lib/admin/unified-products.ts（產線上跑的那一份，
 *          沒有任何 import，所以不需要 hook），驗：四種品項怎麼攤成一張清單、刊物連到的
 *          商品不重複列、活動商品只讀、分頁／搜尋／狀態篩選、排序穩定、上下架開關對應的
 *          status、列上改價的輸入檢查、新增一般商品的完整 payload、選品 sort_order。
 *
 *   [靜態] 讀原始碼守住幾條「改錯了不會有人發現」的線：
 *          · 側欄不再有「地方刊物展」「選品」兩項，「商品」還在、仍是 staff:false
 *          · /admin/publications、/admin/curated 兩支舊路由只剩轉址，目標與
 *            LEGACY_ADMIN_REDIRECTS 一致
 *          · 單一頁沒有自己的寫入路徑：只呼叫既有的 fns/products、publications、curated
 *          · 刊物／選品表單只有一份（搬到 components/admin/products/），舊路由裡沒有殘留
 *          · 時間只經過 lib/taipei-time.ts（hydration #418）
 *
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）。CI 用的是 24。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/unified-products-selftest.mjs";

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
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
  }
}
const checkTrue = (label, value) => check(label, value === true, true);

/** 讀不到就丟例外 —— 回空字串會讓「原始碼裡沒有 X」的否定斷言靜默通過。 */
const readFile = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};
{
  let thrown = null;
  try {
    readFile("__selftest-missing-file-probe__");
  } catch (e) {
    thrown = e;
  }
  checkTrue("readFile() 讀不到檔案時丟例外", thrown !== null);
}

function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const up = await import(pathToFileURL(join(ROOT, "src/lib/admin/unified-products.ts")).href);

// -----------------------------------------------------------------------------
console.log("\n[執行] 攤平四張表");
// -----------------------------------------------------------------------------

const L = (zh, en = zh, ja = zh) => ({ zh, en, ja });
const products = [
  {
    id: "g1",
    slug: "tea",
    product_type: "goods",
    source_type: null,
    source_id: null,
    title: L("紅烏龍", "Red Oolong"),
    price: 480,
    compare_at_price: 520,
    stock: 7,
    image_key: null,
    status: "active",
    updated_at: "2026-10-01T00:00:00Z",
  },
  {
    id: "g2",
    slug: "mug",
    product_type: "goods",
    source_type: null,
    source_id: null,
    title: L("馬克杯", "Mug"),
    price: 350,
    compare_at_price: null,
    stock: null,
    image_key: null,
    status: "draft",
    updated_at: "2026-10-05T00:00:00Z",
  },
  {
    id: "b-pub",
    slug: "pub-kl",
    product_type: "book",
    source_type: null,
    source_id: null,
    title: L("基隆刊物"),
    price: 200,
    compare_at_price: null,
    stock: null,
    image_key: "storage:x",
    status: "active",
    updated_at: "2026-10-09T00:00:00Z",
  },
  {
    id: "e1",
    slug: "event-sea",
    product_type: "event",
    source_type: "event",
    source_id: "ev-uuid",
    title: L("海的聲音"),
    price: 600,
    compare_at_price: null,
    stock: null,
    image_key: null,
    status: "active",
    updated_at: "2026-10-02T00:00:00Z",
  },
  {
    id: "j1",
    slug: "journey-x",
    product_type: "journey",
    source_type: null,
    source_id: null,
    title: L("策旅"),
    price: 3000,
    compare_at_price: null,
    stock: null,
    image_key: null,
    status: "archived",
    updated_at: "2026-09-01T00:00:00Z",
  },
];
const publications = [
  {
    id: "p1",
    slug: "kl",
    sheet: "tw",
    title: L("基隆刊物"),
    region: "基隆",
    cover_image_key: "storage:x",
    product_id: "b-pub",
    is_published: true,
    updated_at: "2026-10-03T00:00:00Z",
  },
  {
    id: "p2",
    slug: "ok",
    sheet: "jp",
    title: L("沖繩誌"),
    region: "沖繩",
    cover_image_key: null,
    product_id: null,
    is_published: false,
    updated_at: "2026-10-04T00:00:00Z",
  },
];
const curatedThemes = [{ id: "t1", title: L("茶與器") }];
const curatedItems = [
  {
    id: 11,
    theme_id: "t1",
    name: L("小茶杯"),
    is_published: true,
    updated_at: "2026-10-06T00:00:00Z",
  },
];
const listed = [{ product_id: "b-pub", inv_name: "基隆刊物 第3期", available: 4 }];

const rows = up.buildUnifiedRows({ products, publications, curatedThemes, curatedItems, listed });

check(
  "順序：一般商品 → 地方刊物 → 選品 → 活動票券",
  rows.map((r) => r.key),
  [
    "goods:g1",
    "goods:g2",
    "publication:p1",
    "publication:p2",
    "curated:11",
    "ticket:e1",
    "ticket:j1",
  ],
);
check(
  "🔴 刊物連到的那件 book 商品不在「一般商品」重複出現",
  rows.filter((r) => r.id === "b-pub").length,
  0,
);
check("每一列的 key 都不重複", new Set(rows.map((r) => r.key)).size, rows.length);
check("計數", up.countByTab(rows), { all: 7, goods: 2, publication: 2, curated: 1, ticket: 2 });

const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
check(
  "刊物連了商品：價格與可售量從商品／進銷存帶過來",
  [byKey["publication:p1"].price, byKey["publication:p1"].stock, byKey["publication:p1"].invName],
  [200, 4, "基隆刊物 第3期"],
);
check("刊物連了商品：可以列上改價", byKey["publication:p1"].priceEditable, true);
check(
  "刊物連了商品：最後更新取刊物與商品較晚者",
  byKey["publication:p1"].updatedAt,
  "2026-10-09T00:00:00Z",
);
check(
  "刊物沒連商品：沒有價格、不能改價、只展示",
  [
    byKey["publication:p2"].price,
    byKey["publication:p2"].priceEditable,
    byKey["publication:p2"].stockNote,
  ],
  [null, false, "只展示"],
);
check(
  "刊物的上架＝is_published",
  [byKey["publication:p1"].published, byKey["publication:p2"].published],
  [true, false],
);
check(
  "選品：不販售、沒有圖、可編輯",
  [
    byKey["curated:11"].price,
    byKey["curated:11"].imageKey,
    byKey["curated:11"].editable,
    byKey["curated:11"].subtitle,
  ],
  [null, null, true, "茶與器"],
);
check(
  "一般商品：products.stock 直接顯示，null＝不管理",
  [byKey["goods:g1"].stock, byKey["goods:g2"].stock, byKey["goods:g2"].stockNote],
  [7, null, "不管理"],
);
check(
  "一般商品：上架＝status active",
  [byKey["goods:g1"].published, byKey["goods:g2"].published],
  [true, false],
);
check(
  "🔴 活動來源的票券：唯讀、指去活動編輯頁",
  [
    byKey["ticket:e1"].editable,
    byKey["ticket:e1"].priceEditable,
    byKey["ticket:e1"].externalEditHref,
    byKey["ticket:e1"].eventId,
  ],
  [false, false, "/admin/events/ev-uuid", "ev-uuid"],
);
check(
  "沒有活動來源的策旅票券：在這一頁編輯",
  [byKey["ticket:j1"].editable, byKey["ticket:j1"].externalEditHref],
  [true, null],
);
check(
  "票券的可售量寫「按場次」（名額在 event_sessions，不在商品）",
  [byKey["ticket:e1"].stock, byKey["ticket:e1"].stockNote],
  [null, "按場次"],
);

// -----------------------------------------------------------------------------
console.log("\n[執行] 分頁／搜尋／狀態／排序");
// -----------------------------------------------------------------------------

check(
  "分頁：選品",
  up.filterUnifiedRows(rows, { tab: "curated", query: "" }).map((r) => r.key),
  ["curated:11"],
);
check("分頁：全部", up.filterUnifiedRows(rows, { tab: "all", query: "" }).length, 7);
check(
  "搜尋：英文標題、不分大小寫",
  up.filterUnifiedRows(rows, { tab: "all", query: "OOLONG" }).map((r) => r.key),
  ["goods:g1"],
);
check(
  "搜尋：刊物的地區",
  up.filterUnifiedRows(rows, { tab: "all", query: "沖繩" }).map((r) => r.key),
  ["publication:p2"],
);
check(
  "搜尋：進銷存品名也找得到刊物",
  up.filterUnifiedRows(rows, { tab: "all", query: "第3期" }).map((r) => r.key),
  ["publication:p1"],
);
check(
  "狀態：未上架",
  up.filterUnifiedRows(rows, { tab: "all", query: "", status: "unpublished" }).map((r) => r.key),
  ["goods:g2", "publication:p2", "ticket:j1"],
);
check("搜尋＋分頁一起作用", up.filterUnifiedRows(rows, { tab: "goods", query: "基隆" }).length, 0);

check(
  "排序：最近更新",
  up
    .sortUnifiedRows(rows, "updated")
    .map((r) => r.key)
    .slice(0, 3),
  ["publication:p1", "curated:11", "goods:g2"],
);
check(
  "排序：價格高→低，沒價格的排最後且維持原順序",
  up.sortUnifiedRows(rows, "price").map((r) => r.key),
  [
    "ticket:j1",
    "ticket:e1",
    "goods:g1",
    "goods:g2",
    "publication:p1",
    "publication:p2",
    "curated:11",
  ],
);
check(
  "排序：預設＝原順序（不改動輸入）",
  up.sortUnifiedRows(rows, "default").map((r) => r.key),
  rows.map((r) => r.key),
);

check("?type= 解析：認得的", up.parseUnifiedTab("publication"), "publication");
check("?type= 解析：all 視同沒帶", up.parseUnifiedTab("all"), undefined);
check("?type= 解析：亂寫的不丟錯", up.parseUnifiedTab("<script>"), undefined);

// -----------------------------------------------------------------------------
console.log("\n[執行] 寫入 payload");
// -----------------------------------------------------------------------------

check(
  "上下架：打開一律 active",
  [up.nextProductStatus("draft", true), up.nextProductStatus("archived", true)],
  ["active", "active"],
);
check("上下架：active 關掉→archived", up.nextProductStatus("active", false), "archived");
check("上下架：草稿關掉維持草稿（不會被標成封存）", up.nextProductStatus("draft", false), "draft");

check("改價：整數", up.parsePriceInput(" 1,280 "), { ok: true, value: 1280 });
check("改價：允許 NT$ 前綴", up.parsePriceInput("NT$450"), { ok: true, value: 450 });
check("改價：0 元一般商品可以", up.parsePriceInput("0"), { ok: true, value: 0 });
check("改價：刊物商品至少 1 元", up.parsePriceInput("0", { min: 1 }).ok, false);
check("改價：小數擋下", up.parsePriceInput("12.5").ok, false);
check("改價：負數擋下", up.parsePriceInput("-3").ok, false);
check("改價：空字串擋下", up.parsePriceInput("  ").ok, false);

check(
  "代稱：英文標題轉半形＋亂數尾巴",
  up.slugFromTitle("Red Oolong Tea!", "Ab12x"),
  "red-oolong-tea-ab12x",
);
check("代稱：英文標題是空的", up.slugFromTitle("", "k9"), "item-k9");
check("代稱：去掉重音符號", up.slugFromTitle("Café Crème", "z"), "cafe-creme-z");

const payload = up.buildNewGoodsPayload({
  product_type: "book",
  title: L("書"),
  summary: L("一句話"),
  price: 300,
  stock: null,
  image_key: null,
  publish: false,
  slug: "book-x",
  sort_order: 9,
});
check("新增一般商品：完整 payload（description 沿用 summary、草稿、要寄送、不關聯）", payload, {
  slug: "book-x",
  product_type: "book",
  source_type: null,
  source_id: null,
  title: L("書"),
  summary: L("一句話"),
  description: L("一句話"),
  price: 300,
  compare_at_price: null,
  stock: null,
  image_key: null,
  requires_shipping: true,
  status: "draft",
  sort_order: 9,
});
check(
  "新增一般商品：立刻上架＝active",
  up.buildNewGoodsPayload({ ...payload, publish: true, summary: L("x") }).status,
  "active",
);
check(
  "🔴 新增的 payload 沒有 capacity／seats_taken（0020 之後寫進去只會 23514）",
  ["capacity", "seats_taken"].some((k) => k in payload),
  false,
);

check(
  "選品 sort_order：該主題最大值＋1，別的主題不算",
  up.nextCuratedSortOrder(
    [
      { theme_id: "t1", sort_order: 3 },
      { theme_id: "t1", sort_order: 7 },
      { theme_id: "t2", sort_order: 99 },
    ],
    "t1",
  ),
  8,
);
check("選品 sort_order：空主題從 1 開始", up.nextCuratedSortOrder([], "t9"), 1);
check(
  "新增選單：活動／策旅票券導去各自的「一頁新增」、刊物不在這裡新增",
  up.CREATE_OPTIONS.map((o) => [o.key, o.kind, o.href]),
  [
    ["goods", "goods", null],
    ["curated", "curated", null],
    ["event", "ticket", "/admin/events/new"],
    ["journey", "ticket", "/admin/journeys/new"],
    ["publication", "publication", null],
  ],
);

// -----------------------------------------------------------------------------
console.log("\n[靜態] 側欄、轉址、寫入路徑");
// -----------------------------------------------------------------------------

const shell = stripTs(readFile("src/routes/admin/_shell.tsx"));
checkTrue(
  "側欄：「商品」還在且 staff:false",
  /to: "\/admin\/products", label: "商品", icon: Package, staff: false/.test(shell),
);
check("側欄：「地方刊物展」拿掉了", shell.includes('"/admin/publications"'), false);
check("側欄：「選品」拿掉了", shell.includes('"/admin/curated"'), false);
checkTrue("側欄：「合作」不是商品，留在原處", shell.includes('to: "/admin/collaborations"'));
checkTrue("側欄：進銷存的「商品管理」不動", shell.includes('to: "/admin/inventory-products"'));

for (const [from, tab] of Object.entries(up.LEGACY_ADMIN_REDIRECTS)) {
  const file = `src/routes/admin/_shell.${from.split("/").pop()}.tsx`;
  const src = stripTs(readFile(file));
  checkTrue(
    `${from} 只剩轉址到 /admin/products?type=${tab}`,
    new RegExp(`throw redirect\\(\\{ to: "/admin/products", search: \\{ type: "${tab}" \\}`).test(
      src,
    ),
  );
  check(`${from} 沒有 component（不會畫出舊頁）`, /component:/.test(src), false);
}

const nav = await import(pathToFileURL(join(ROOT, "src/lib/admin/nav-active.ts")).href);
const navTargets = [...shell.matchAll(/to:\s*"([^"]+)"/g)].map((m) => m[1]);
check(
  "主題與排序頁（/admin/products/curated-themes）只讓側欄的「商品」亮",
  navTargets.filter((to) => nav.isNavItemActive("/admin/products/curated-themes", to)),
  ["/admin/products"],
);

const page = stripTs(readFile("src/routes/admin/_shell.products.tsx"));
const fnImports = [...page.matchAll(/import\("(@\/lib\/admin\/fns\/[^"]+)"\)/g)].map((m) => m[1]);
// 2026-10-25：進場資料改成 fns/products 的整頁 fn（getAdminProductsPageData），頁面本身
// 不再 import fns/inventory-listing（那幾支只剩 loader 在用）。
check("🔴 單一頁只呼叫既有的 server fn（沒有自己的寫入路徑）", [...new Set(fnImports)].sort(), [
  "@/lib/admin/fns/curated",
  "@/lib/admin/fns/products",
  "@/lib/admin/fns/publications",
]);
check("單一頁不直接碰 supabase", /supabase/i.test(page), false);
checkTrue("單一頁的時間只經過 lib/taipei-time", page.includes('from "@/lib/taipei-time"'));
check(
  "單一頁沒有 toLocaleString 日期／getHours（#418）",
  /toLocale(Date|Time)String|getHours\(|getDate\(/.test(page),
  false,
);
checkTrue(
  "validateSearch 用 parseUnifiedTab 解析 ?type=",
  /validateSearch[\s\S]{0,200}parseUnifiedTab\(search\.type\)/.test(page),
);
check("單一頁的表單沒有 capacity 輸入框", /name="capacity"/.test(page), false);
// 2026-10-25：完整商品表單從彈窗搬成內頁 /admin/products/product/$id 的本體（ProductForm.tsx）。
const productForm = stripTs(readFile("src/components/admin/products/ProductForm.tsx"));
check("商品完整表單（內頁）沒有 capacity 輸入框", /name="capacity"/.test(productForm), false);
// 編輯／新增內頁：寫入一樣只走既有的 server fn（沒有第二條寫入路徑）。
const DETAIL_PAGES = {
  "_shell.products_.product.$id.tsx": ["@/lib/admin/fns/products"],
  "_shell.products_.product.new.tsx": ["@/lib/admin/fns/products"],
  "_shell.products_.publication.$id.tsx": [
    "@/lib/admin/fns/products",
    "@/lib/admin/fns/publications",
  ],
  "_shell.products_.curated.$id.tsx": ["@/lib/admin/fns/curated", "@/lib/admin/fns/products"],
  "_shell.products_.curated.new.tsx": ["@/lib/admin/fns/curated", "@/lib/admin/fns/products"],
};
for (const [file, expected] of Object.entries(DETAIL_PAGES)) {
  const src = stripTs(readFile(`src/routes/admin/${file}`));
  const used = [...src.matchAll(/import\("(@\/lib\/admin\/fns\/[^"]+)"\)/g)].map((m) => m[1]);
  check(`🔴 ${file} 只呼叫既有的 server fn`, [...new Set(used)].sort(), expected);
  check(`${file} 不直接碰 supabase`, /supabase/i.test(src), false);
}

checkTrue(
  "🔴 列上快速動作先讀最新一列再寫（getProductById／getPublicationById／getCuratedItemById），不拿畫面快照整列寫回",
  /async function patchProduct[\s\S]{0,400}getProductById/.test(page) &&
    /function togglePublish[\s\S]{0,1500}getPublicationById[\s\S]{0,1200}getCuratedItemById/.test(
      page,
    ),
);
{
  // 2026-10-25：選品編輯從彈窗搬成內頁 /admin/products/curated/$id（商品頁與主題頁共用）。
  const curatedEdit = stripTs(readFile("src/routes/admin/_shell.products_.curated.$id.tsx"));
  const editForm = curatedEdit.match(/<CuratedItemForm\s[\s\S]*?\/>/)?.[0] ?? "";
  checkTrue("找得到選品的編輯表單", editForm.length > 0);
  check(
    "🔴 選品編輯不給換主題（換主題要連 sort_order 一起換，更新分支不寫 sort_order）",
    /themes=/.test(editForm),
    false,
  );
}
checkTrue("任何一列在寫入時，所有列的快速動作都停著", /busy: busyKey !== null/.test(page));
const pubFns = stripTs(readFile("src/lib/admin/fns/publications.ts"));
checkTrue(
  "新加的 getPublicationById 一樣掛 adminFnMiddleware",
  /export const getPublicationById = createServerFn\(\{ method: "GET" \}\)\s*\.middleware\(\[adminFnMiddleware\]\)/.test(
    pubFns,
  ),
);

const pubForms = readFile("src/components/admin/products/PublicationForms.tsx");
checkTrue(
  "刊物表單搬到 components（校稿＋連結兩張）",
  /export function PublicationForm\(/.test(pubForms) && /export function LinkForm\(/.test(pubForms),
);
check(
  "舊的 _shell.publications.tsx 沒有殘留表單",
  /function (PublicationForm|LinkForm)\(/.test(
    readFile("src/routes/admin/_shell.publications.tsx"),
  ),
  false,
);
const themesPage = stripTs(readFile("src/routes/admin/_shell.products_.curated-themes.tsx"));
// 2026-10-25：主題頁的品項新增／編輯改成連到共用的選品內頁（同一張 CuratedItemForm），
// 不再自己開表單彈窗。
checkTrue(
  "選品主題頁的品項編輯／新增連到共用的選品內頁",
  themesPage.includes('to="/admin/products/curated/$id"') &&
    themesPage.includes('to="/admin/products/curated/new"'),
);
check("選品主題頁不再自己放 CuratedItemForm", themesPage.includes("<CuratedItemForm"), false);
checkTrue(
  "選品內頁（編輯、新增）用共用的 CuratedItemForm",
  stripTs(readFile("src/routes/admin/_shell.products_.curated.$id.tsx")).includes(
    "<CuratedItemForm",
  ) &&
    stripTs(readFile("src/routes/admin/_shell.products_.curated.new.tsx")).includes(
      "<CuratedItemForm",
    ),
);
check("選品主題頁沒有自己的 ItemForm", /function ItemForm\(/.test(themesPage), false);
checkTrue(
  "🔴 選品排序仍走 reorderCuratedItems（RPC），不是逐列寫 sort_order",
  themesPage.includes("reorderCuratedItems"),
);

// -----------------------------------------------------------------------------
console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
