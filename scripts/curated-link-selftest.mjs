#!/usr/bin/env node
/**
 * 選品連結商品（0041，2026-10-26）的自檢。
 *
 * 業主：首頁「主理人的選品」那一排要放主理人挑的那幾件。這支守四件事：
 *
 *   [1] 首頁那一排的選法（src/lib/home-shelf.ts）：選品優先（主題順序 → 品項順序）、
 *       去重、不滿再用原本的商品排序補、售完跳過、票券排除、連滿 4 件就只放選品、
 *       沒發布的主題底下的品項不算。
 *   [2] 後台「連結商品」的選擇器（unified-products.ts）：不列票券、不列已下架、
 *       自動配對只做正規化後的完全相同、後台清單上的選品列帶出商品名稱／價格／可售量。
 *   [3] 0041 還沒套用時不 500：讀取遇到 42703 退回舊行為（首頁、/shop、後台三處）。
 *   [4] migration 本身與帳本。
 *
 * 執行：node scripts/curated-link-selftest.mjs（npm test 會一起跑）
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
} from "./lib/migration-ledger.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/curated-link-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");

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
const stripSql = (sql) =>
  sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

/** 從 `export async function name(` 起到下一個頂層 `\n}\n` 為止。找不到就丟例外。 */
function fnBody(src, name) {
  const start = src.search(new RegExp(`(export )?(async )?function ${name}\\(`));
  if (start === -1) throw new Error(`找不到函式 ${name}`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end === -1 ? undefined : end);
}

const shelf = await import(pathToFileURL(join(ROOT, "src/lib/home-shelf.ts")).href);
const up = await import(pathToFileURL(join(ROOT, "src/lib/admin/unified-products.ts")).href);

// =============================================================================
console.log("\n[1] 首頁那一排：選品優先、去重、補位、售完與票券排除");
// =============================================================================
{
  const themes = [
    { id: "t-b", sort_order: 2 },
    { id: "t-a", sort_order: 1 },
  ];
  const items = [
    { id: 11, theme_id: "t-b", product_id: "p-cup", sort_order: 1 },
    { id: 3, theme_id: "t-a", product_id: "p-tea", sort_order: 2 },
    { id: 2, theme_id: "t-a", product_id: "p-book", sort_order: 1 },
    { id: 4, theme_id: "t-a", product_id: null, sort_order: 3 },
    // 同一件商品在兩個主題：只算第一次（t-a 排在前面）
    { id: 12, theme_id: "t-b", product_id: "p-tea", sort_order: 2 },
    // 主題沒發布（anon 讀不到 t-hidden）→ 不算
    { id: 20, theme_id: "t-hidden", product_id: "p-secret", sort_order: 1 },
  ];
  check(
    "選品 id：主題照 sort_order、主題內照 sort_order、去重、沒連結與未發布主題不算",
    shelf.orderedCuratedProductIds(themes, items),
    ["p-book", "p-tea", "p-cup"],
  );
  check(
    "選品 id：同分時比 id（主題 id、品項 id）",
    shelf.orderedCuratedProductIds(
      [
        { id: "z", sort_order: 0 },
        { id: "a", sort_order: 0 },
      ],
      [
        { id: 9, theme_id: "z", product_id: "z9", sort_order: 1 },
        { id: 5, theme_id: "a", product_id: "a5", sort_order: 1 },
        { id: 2, theme_id: "a", product_id: "a2", sort_order: 1 },
      ],
    ),
    ["a2", "a5", "z9"],
  );

  const P = (id, productType = "book", soldOut = false) => ({ id, productType, soldOut });
  const soldOutFn = (p) => p.soldOut;
  const pick = (curatedIds, pool, fallback, limit = 4) =>
    shelf
      .selectHomeShelf({
        curatedIds,
        productsById: new Map(pool.map((p) => [p.id, p])),
        fallback,
        limit,
        isSoldOut: soldOutFn,
      })
      .map((p) => p.id);

  const f1 = P("f1"),
    f2 = P("f2", "goods"),
    f3 = P("f3"),
    f4 = P("f4"),
    f5 = P("f5");
  const fallback = [f1, f2, f3, f4, f5];

  check("沒有任何選品連結 → 跟原本一樣，補位清單前 4 件", pick([], fallback, fallback), [
    "f1",
    "f2",
    "f3",
    "f4",
  ]);

  const c1 = P("c1"),
    c2 = P("c2", "goods");
  check("選品排前面，不滿 4 件用補位清單補", pick(["c1", "c2"], [...fallback, c1, c2], fallback), [
    "c1",
    "c2",
    "f1",
    "f2",
  ]);

  check(
    "去重：選品指到的商品也在補位清單裡，只出現一次（在選品的位置）",
    pick(["f3", "c1"], [...fallback, c1], fallback),
    ["f3", "c1", "f1", "f2"],
  );

  const cSold = P("c-sold", "book", true);
  const fSold = P("f-sold", "book", true);
  check(
    "售完的選品與售完的補位都跳過",
    pick(["c-sold", "c1"], [cSold, c1, fSold, f1, f2, f3], [fSold, f1, f2, f3]),
    ["c1", "f1", "f2", "f3"],
  );

  const ev = P("c-event", "event"),
    jr = P("c-journey", "journey"),
    fEv = P("f-event", "event");
  check(
    "票券（event/journey）不上這一排——選品連到票券、補位清單混進票券都排除",
    pick(["c-event", "c-journey", "c1"], [ev, jr, c1, fEv, f1], [fEv, f1]),
    ["c1", "f1"],
  );

  check(
    "選品指到讀不到的商品（下架＝anon 讀不到、被刪）→ 不算，照樣補位",
    pick(["gone", "c1"], [c1, ...fallback], fallback),
    ["c1", "f1", "f2", "f3"],
  );

  const many = ["m1", "m2", "m3", "m4", "m5"].map((id) => P(id));
  check(
    "連了 4 件以上 → 全部是選品，不補，照選品順序取前 4",
    pick(
      many.map((p) => p.id),
      [...many, ...fallback],
      fallback,
    ),
    ["m1", "m2", "m3", "m4"],
  );
  check(
    "連了 4 件但其中 1 件售完 → 3 件選品＋1 件補位",
    pick(["m1", "m2", "c-sold", "m3"], [many[0], many[1], cSold, many[2], ...fallback], fallback),
    ["m1", "m2", "m3", "f1"],
  );
  check("什麼都沒有 → 空（首頁退回花瓶意象圖）", pick([], [], []), []);
  check("limit 照傳入的", pick(["c1"], [c1, ...fallback], fallback, 2), ["c1", "f1"]);

  checkTrue("isMissingColumnError：42703", shelf.isMissingColumnError({ code: "42703" }));
  checkTrue(
    "isMissingColumnError：訊息寫 column … product_id does not exist",
    shelf.isMissingColumnError({ message: "column curated_items.product_id does not exist" }),
  );
  check(
    "isMissingColumnError：其他錯誤不算（不能把網路錯誤當成「沒套 migration」）",
    [
      shelf.isMissingColumnError({ code: "PGRST301", message: "JWT expired" }),
      shelf.isMissingColumnError(null),
    ],
    [false, false],
  );
}

// =============================================================================
console.log("\n[1b] 讀取端：fetchHomeShelfProducts 真的用上面那套規則，而且 42703 不會讓首頁掛掉");
// =============================================================================
{
  const shopSrc = stripTs(readFile("src/lib/shop.ts"));
  const body = fnBody(shopSrc, "fetchHomeShelfProducts");
  checkTrue("fetchHomeShelfProducts 呼叫 selectHomeShelf()", body.includes("selectHomeShelf("));
  checkTrue(
    "補位清單只查 goods/book（SHELF_PRODUCT_TYPES）",
    body.includes('.in("product_type", [...SHELF_PRODUCT_TYPES])'),
  );
  checkTrue("補位清單仍只查 status=active", body.includes('.eq("status", "active")'));
  checkTrue(
    "售完判斷用的 availability 在選之前讀（attachAvailability → selectHomeShelf）",
    body.indexOf("attachAvailability(") !== -1 &&
      body.indexOf("attachAvailability(") < body.indexOf("selectHomeShelf("),
  );
  check(
    "首頁那一排不 attachSessions/attachPlans（那是票券用的）",
    /attachSessions|attachPlans/.test(body),
    false,
  );
  const ids = fnBody(shopSrc, "fetchCuratedShelfProductIds");
  checkTrue(
    "選品連結的讀取遇到 42703 走 isMissingColumnError 分支",
    ids.includes("isMissingColumnError("),
  );
  checkTrue(
    "選品連結的讀取任何錯誤都回 []（退回舊規則，不丟例外）",
    (ids.match(/return \[\];/g) ?? []).length >= 3,
  );
  checkTrue("選品連結只讀有 product_id 的列", ids.includes('.not("product_id", "is", null)'));
  checkTrue("選品主題也要讀（擋未發布主題底下的品項）", ids.includes('.from("curated_themes")'));

  const cms = stripTs(readFile("src/lib/cms.ts"));
  const sel = fnBody(cms, "selectCuratedItems");
  checkTrue(
    "/shop 的選品讀取先帶 product_id",
    sel.includes("theme_id,name,note,sort_order,product_id"),
  );
  checkTrue(
    "/shop 的選品讀取失敗時退回不帶 product_id 的舊查詢（不整頁變內建文案）",
    sel.includes(
      'select("curated_items", "theme_id,name,note,sort_order", { order: "sort_order" })',
    ),
  );
  checkTrue(
    "fetchCuratedThemes 用 selectCuratedItems()",
    fnBody(cms, "fetchCuratedThemes").includes("selectCuratedItems()"),
  );
}

// =============================================================================
console.log("\n[1c] /shop〈主理人的選品〉：連了商品的卡片才有購買鈕");
// =============================================================================
{
  const panel = stripTs(readFile("src/components/shop/CuratedPanel.tsx"));
  checkTrue(
    "加入購物車走既有的 addItem(cartInputFor(product, 1))",
    panel.includes("addItem(cartInputFor(product, 1))"),
  );
  checkTrue(
    "只認書籍／選物（isShelfProductType），票券當成沒連結",
    panel.includes("isShelfProductType(prod.productType)"),
  );
  checkTrue("售完時按鈕停用", panel.includes("disabled={soldOut}"));
  checkTrue("商品來自 /shop 傳進來的 catalogue（不自己查）", panel.includes("catalogue.products"));
  checkTrue("有連到商品頁", panel.includes('to="/shop/$slug"'));
  const route = stripTs(readFile("src/routes/shop.index.tsx"));
  checkTrue(
    "/shop 把 catalogue 傳給 CuratedPanel",
    route.includes(
      "<CuratedPanel page={curatedPage} curatedThemes={curatedThemes} catalogue={catalogue} />",
    ),
  );
}

// =============================================================================
console.log("\n[2] 後台「連結商品」選擇器");
// =============================================================================
const L = (zh, en = zh, ja = zh) => ({ zh, en, ja });
const prod = (id, product_type, status, extra = {}) => ({
  id,
  slug: `slug-${id}`,
  product_type,
  source_type: null,
  source_id: null,
  title: L(`商品${id}`),
  price: 100,
  compare_at_price: null,
  stock: 3,
  image_key: null,
  status,
  updated_at: "2026-10-01T00:00:00Z",
  ...extra,
});
{
  const products = [
    prod("g-active", "goods", "active"),
    prod("b-draft", "book", "draft", { title: L("《城市的邊界》", "City Edges", "都市の境界") }),
    prod("g-archived", "goods", "archived"),
    prod("e-ticket", "event", "active"),
    prod("j-ticket", "journey", "active"),
    prod("pub-1", "book", "active", { stock: null, title: L("八斗子刊") }),
  ];
  const publications = [{ title: L("八斗子"), product_id: "pub-1" }];
  const listed = [{ product_id: "pub-1", inv_name: "八斗子 vol.3", available: 7 }];
  const opts = up.curatedLinkOptions({ products, publications, listed });

  check(
    "只列書籍／一般商品、上架中或草稿；不列票券、不列已下架",
    opts.map((o) => o.productId),
    ["g-active", "b-draft", "pub-1"],
  );
  const pub = opts.find((o) => o.productId === "pub-1");
  check(
    "刊物連到的那件商品：標成地方刊物、可售量走進銷存",
    [pub.kindLabel, pub.stock, pub.stockNote],
    ["地方刊物", 7, "進銷存"],
  );
  check(
    "草稿也可以先連（標示狀態）",
    opts.find((o) => o.productId === "b-draft").statusLabel,
    "草稿",
  );
  checkTrue(
    "isCuratedLinkableType：book/goods 可，event/journey 不可",
    [
      up.isCuratedLinkableType("book"),
      up.isCuratedLinkableType("goods"),
      !up.isCuratedLinkableType("event"),
      !up.isCuratedLinkableType("journey"),
    ].every(Boolean),
  );

  check("搜尋：空字串＝全部", up.filterCuratedLinkOptions(opts, "  ").length, 3);
  check(
    "搜尋：比對英文標題（不分大小寫）",
    up.filterCuratedLinkOptions(opts, "city").map((o) => o.productId),
    ["b-draft"],
  );
  check(
    "搜尋：比對進銷存品名與刊物標題",
    up.filterCuratedLinkOptions(opts, "vol.3").map((o) => o.productId),
    ["pub-1"],
  );

  check(
    "自動配對：書名號、空白不算，完全相同才建議",
    up.suggestCuratedLinks(L("城市的 邊界", "", ""), opts).map((o) => o.productId),
    ["b-draft"],
  );
  check(
    "自動配對：比對連到同一件商品的刊物標題",
    up.suggestCuratedLinks(L("八斗子", "", ""), opts).map((o) => o.productId),
    ["pub-1"],
  );
  check("自動配對：只是相近不建議（不做模糊比對）", up.suggestCuratedLinks(L("城市"), opts), []);
  check(
    "自動配對：名稱全空不建議任何東西（空字串不算相同）",
    up.suggestCuratedLinks(L("", "", "「」"), opts),
    [],
  );
  check(
    "自動配對：不會建議票券（票券根本不在選項裡）",
    up.suggestCuratedLinks(L("商品e-ticket"), opts),
    [],
  );

  // 後台商品清單的選品列
  const rows = up.buildUnifiedRows({
    products,
    publications: [],
    curatedThemes: [{ id: "t1", title: L("秋日") }],
    curatedItems: [
      {
        id: 1,
        theme_id: "t1",
        name: L("杯"),
        is_published: true,
        updated_at: "x",
        product_id: "g-active",
      },
      {
        id: 2,
        theme_id: "t1",
        name: L("沒連結"),
        is_published: true,
        updated_at: "x",
        product_id: null,
      },
      { id: 3, theme_id: "t1", name: L("舊形狀"), is_published: true, updated_at: "x" },
      {
        id: 4,
        theme_id: "t1",
        name: L("連到草稿"),
        is_published: true,
        updated_at: "x",
        product_id: "b-draft",
      },
    ],
    listed: [],
  });
  const cur = rows.filter((r) => r.kind === "curated");
  check(
    "選品列：連了商品 → 帶出商品名稱、價格、可售量，狀態「展出・可買」",
    [cur[0].subtitle, cur[0].price, cur[0].stock, cur[0].statusLabel, cur[0].productId],
    ["秋日・連結：商品g-active", 100, 3, "展出・可買", "g-active"],
  );
  check("選品列：價格不在這一列改（改商品那一列）", cur[0].priceEditable, false);
  check(
    "選品列：沒連結（null 與沒有這個 key 都一樣）→ 照舊不販售",
    [cur[1].price, cur[1].stockNote, cur[1].statusLabel, cur[2].price, cur[2].stockNote],
    [null, "不販售", "展出中", null, "不販售"],
  );
  check("選品列：連到草稿商品 → 狀態寫出商品還是草稿", cur[3].statusLabel, "展出・商品草稿");
  checkTrue(
    "選品列：可以用商品名稱搜到",
    up
      .filterUnifiedRows(rows, { tab: "curated", query: "g-active" })
      .some((r) => r.key === "curated:1"),
  );
}

// =============================================================================
console.log("\n[2b] 伺服器端與表單接線");
// =============================================================================
{
  const fns = stripTs(readFile("src/lib/admin/fns/curated.ts"));
  const up_ = fns.slice(fns.indexOf("export const upsertCuratedItem"));
  checkTrue(
    "upsertCuratedItem 仍是 adminFnMiddleware",
    up_.slice(0, 200).includes("adminFnMiddleware"),
  );
  checkTrue(
    "upsertCuratedItem 在伺服器端再查商品類型（不信任瀏覽器送來的 id）",
    up_.includes("getProductById(data.product_id)") &&
      up_.includes("isCuratedLinkableType(product.product_type)"),
  );
  const schemas = stripTs(readFile("src/lib/admin/schemas.ts"));
  checkTrue(
    "curatedItemSchema 有 product_id（nullable、optional）",
    /product_id: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)\.nullable\(\)\.optional\(\)/.test(
      schemas,
    ),
  );

  const fv = stripTs(readFile("src/components/admin/products/form-values.ts"));
  checkTrue(
    "toCuratedValues 帶上 product_id（商品頁的上下架開關整筆回寫，不可以把連結弄丟）",
    fv.includes("product_id: row.product_id ?? null"),
  );
  const form = stripTs(readFile("src/components/admin/products/CuratedItemForm.tsx"));
  checkTrue("CuratedItemForm 放了 CuratedProductPicker", form.includes("<CuratedProductPicker"));
  for (const f of ["_shell.products_.curated.$id.tsx", "_shell.products_.curated.new.tsx"]) {
    const src = stripTs(readFile(`src/routes/admin/${f}`));
    checkTrue(
      `${f} 把 linkOptions／linkSupported 傳給表單`,
      src.includes("linkOptions={linkOptions}") && src.includes("linkSupported={linkSupported}"),
    );
  }
  const picker = stripTs(readFile("src/components/admin/products/CuratedProductPicker.tsx"));
  checkTrue("選擇器有解除連結", picker.includes("onChange(null)") && picker.includes("解除連結"));
  checkTrue(
    "自動配對只是建議：按「採用」才 onChange",
    picker.includes("suggestCuratedLinks(itemName, options)") && picker.includes("採用"),
  );
}

// =============================================================================
console.log("\n[3] 0041 還沒套用時，後台讀寫不 500");
// =============================================================================
{
  const repo = stripTs(readFile("src/server/repos/curated.ts"));
  for (const name of [
    "listCuratedItemsByTheme",
    "listCuratedItemsByThemes",
    "getCuratedItemById",
  ]) {
    const body = fnBody(repo, name);
    checkTrue(
      `${name}：先帶 product_id 讀，42703 退回 BASE_ITEM_COLUMNS`,
      body.includes("run(ITEM_COLUMNS)") &&
        body.includes("isMissingLinkColumn(error)") &&
        body.includes("run(BASE_ITEM_COLUMNS)"),
    );
  }
  const upsert = fnBody(repo, "upsertCuratedItem");
  checkTrue(
    "upsertCuratedItem：沒要連結時 42703 退回不寫 product_id",
    upsert.includes("write(base, BASE_ITEM_COLUMNS)"),
  );
  checkTrue(
    "upsertCuratedItem：要連結但欄位不在 → 明講做不到（不靜默丟掉連結）",
    upsert.includes("if (input.product_id)") && upsert.includes("throw new Error"),
  );
  checkTrue(
    "upsertCuratedItem：product_id 沒給＝不動這一欄",
    upsert.includes("input.product_id === undefined ? {} :"),
  );
  checkTrue(
    "🔴 upsertCuratedItem：更新分支仍不寫 sort_order（unique(theme_id, sort_order) 只走 RPC）",
    /\.update\(payload\)/.test(upsert) &&
      upsert.includes("insert({ ...payload, sort_order: input.sort_order })") &&
      !/base = \{[^}]*sort_order/.test(upsert),
  );
  checkTrue(
    "isCuratedLinkSupported 存在（編輯頁停用那一格用）",
    repo.includes("export async function isCuratedLinkSupported("),
  );
}

// =============================================================================
console.log("\n[4] migration 0041 與帳本");
// =============================================================================
{
  const sql = stripSql(
    readFile("supabase/migrations/0041_curated_item_product_link.sql"),
  ).toLowerCase();
  checkTrue(
    "add column if not exists product_id text（products.id 是 text，不是 uuid）",
    /add column if not exists product_id text\s+references public\.products \(id\) on delete set null/.test(
      sql,
    ),
  );
  checkTrue(
    "索引 create index if not exists（冪等）",
    /create index if not exists curated_items_product_idx/.test(sql),
  );
  check("不加 unique（同一件商品可以在兩個主題）", /unique/.test(sql), false);
  check(
    "不動 grant／policy（沿用 0001）",
    /\bgrant\b|\brevoke\b|create policy|drop policy/.test(sql),
    false,
  );
  check("不 drop／不 alter products", /drop |alter table public\.products/.test(sql), false);

  assertLedgerMatchesDisk(check, MIG_DIR);
  assertLedgerDeclarationsHonest(check, MIG_DIR);
  assertMigrationDependencies(check, MIG_DIR, {
    suite: "curated-link-selftest",
    dependsOn: ["curated", "products_availability"],
    reviewedThrough: "0041_curated_item_product_link.sql",
  });
}

// -----------------------------------------------------------------------------
console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
