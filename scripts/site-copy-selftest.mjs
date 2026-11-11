#!/usr/bin/env node
/**
 * 2026-11-10 全站文案健檢（業主核准）的自檢。
 *
 *   [1] 範例選品不露出：displayableCuratedThemes()（src/lib/home-shelf.ts）只留連了
 *       讀得到的書籍／選物的選品；/shop 首屏「店裡也有」那一排拿掉；〈主理人的選品〉
 *       分頁與首屏入口卡都走這支濾過的清單。
 *   [2] 〈主理人的選品〉的「LINE 私訊」有連結（官方帳號），SOCIAL.line 有值（頁尾 icon 才會出現）。
 *   [3] 舊文案不再出現在前台程式的後備值裡（Hourlight、前往旅程網站、策旅名額、走進選品櫥窗）。
 *
 * ⚠️ 程式裡的字串只是 CMS 讀不到時的後備。正式站實際顯示的是 ui_strings／pages／page_blocks，
 *    那邊在同一天已經改好；這支守的是「CMS 讀不到時不會退回舊文案」。
 *
 * 執行：node scripts/site-copy-selftest.mjs（npm test 會一起跑）
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/site-copy-selftest.mjs";

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
const checkFalse = (label, value) => check(label, value, false);

/** 讀不到就丟例外 —— 回空字串會讓「原始碼裡沒有 X」的否定斷言靜默通過。 */
const readFile = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};

// =============================================================================
console.log("\n[1] 範例選品不露出");
// =============================================================================
const shelf = await import(pathToFileURL(join(ROOT, "src/lib/home-shelf.ts")).href);
const L = (zh) => ({ zh, en: zh, ja: zh });
const themes = [
  {
    id: "t1",
    title: L("地方風土"),
    items: [
      { name: L("山村釀造．桂花蜜"), productId: null },
      { name: L("沒有 productId 欄位") },
      { name: L("真的選品"), productId: "p-goods" },
      { name: L("連到下架商品"), productId: "p-gone" },
      { name: L("連到票券"), productId: "p-event" },
    ],
  },
  { id: "t2", title: L("器物與陶"), items: [{ name: L("粗陶茶碗"), productId: null }] },
  { id: "t3", title: L("空主題"), items: [] },
];
const products = [
  { id: "p-goods", productType: "goods" },
  { id: "p-book", productType: "book" },
  { id: "p-event", productType: "event" },
];
const shown = shelf.displayableCuratedThemes(themes, products);
check(
  "只留下有可露出品項的主題",
  shown.map((t) => t.id),
  ["t1"],
);
check(
  "主題裡只留連了 active 書籍／選物的那一件",
  shown[0].items.map((i) => i.name.zh),
  ["真的選品"],
);
check(
  "全部都是範例（沒連商品）→ 空陣列（前台顯示「整理中」）",
  shelf.displayableCuratedThemes(
    [{ id: "x", items: [{ name: L("桂花蜜"), productId: null }] }],
    products,
  ),
  [],
);
check("不改傳進來的原陣列", themes[0].items.length, 5);

const strip = readFile("src/components/shop/ShopCategoryStrip.tsx");
checkFalse("/shop 首屏不再有「店裡也有」那一排", /shop-category-samples|alsoInStore/.test(strip));
checkTrue(
  "主理人的選品入口卡沒有可露出的選品時寫「整理中・到店看看」",
  strip.includes('zh: "整理中・到店看看"'),
);
const productsPanel = readFile("src/components/shop/ProductsPanel.tsx");
checkTrue(
  "首屏入口卡拿到的是濾過的主題（displayableCuratedThemes）",
  productsPanel.includes(
    "curatedThemes={displayableCuratedThemes(curatedThemes, catalogue.products)}",
  ),
);
const panel = readFile("src/components/shop/CuratedPanel.tsx");
checkTrue(
  "〈主理人的選品〉分頁只畫濾過的主題",
  panel.includes("displayableCuratedThemes(curatedThemes, catalogue.products)") &&
    panel.includes("shownThemes.map((theme, i) =>") &&
    !panel.includes("curatedThemes.map((theme"),
);
checkTrue(
  "沒有任何可露出的選品時顯示「整理中」段落",
  panel.includes('data-testid="curated-coming-soon"') &&
    panel.includes("主理人的選品整理中，歡迎到店看看或來信詢問。"),
);

// =============================================================================
console.log("\n[2] LINE 連結存在");
// =============================================================================
const strings = readFile("src/i18n/strings.ts");
checkTrue(
  "SOCIAL.line 是官方帳號網址（頁尾與手機抽屜的 LINE icon 靠它出現）",
  /line:\s*"https:\/\/line\.me\/R\/ti\/p\/@zta2483l"/.test(strings),
);
checkTrue(
  "「LINE 私訊」按鈕的 href：後台有值用後台，沒有用 SOCIAL.line",
  panel.includes("const lineHref = social.line || SOCIAL.line;") &&
    panel.includes("href={lineHref}"),
);
checkFalse(
  "「LINE 私訊」按鈕不再直接吃可能是空字串的 social.line",
  panel.includes("href={social.line}"),
);
checkTrue(
  "「LINE 私訊」新分頁開",
  /href=\{lineHref\}\s*target="_blank"\s*rel="noreferrer"/.test(panel),
);

// =============================================================================
console.log("\n[3] 舊文案不再當後備值");
// =============================================================================
const files = {
  strings: strings,
  shop: readFile("src/routes/shop.index.tsx"),
  index: readFile("src/routes/index.tsx"),
  partnership: readFile("src/routes/partnership.tsx"),
  curation: readFile("src/routes/curation.tsx"),
};
for (const [needle, where] of [
  ["Hourlight", "strings"],
  ["前往旅程網站", "strings"],
  ["Visit journey site", "strings"],
  ["前往活動網站", "strings"],
  ["策旅名額", "shop"],
  ["桂花蜜", "shop"],
  ["粗陶茶碗", "shop"],
  ["走進選品櫥窗", "index"],
  ['casesTitle: { zh: "合作案例"', "partnership"],
]) {
  checkFalse(`${where} 不再有「${needle}」`, files[where].includes(needle));
}
checkTrue("策旅卡按鈕：看行程與報名", strings.includes('zh: "看行程與報名"'));
checkTrue("首頁選品區標題：帶一本地方刊物回家", files.index.includes('zh: "帶一本地方刊物回家"'));
checkTrue(
  "/shop 分頁「商品」改成「書刊與好物」（2026-11-11 開始賣地方好物）",
  files.shop.includes('tabProducts: { zh: "書刊與好物"'),
);
checkTrue("/shop 頁首介紹提到地方好物", files.shop.includes("也有我們挑選的地方好物"));
{
  const strip = readFile("src/components/shop/ShopCategoryStrip.tsx");
  const panel = readFile("src/components/shop/ProductsPanel.tsx");
  checkTrue(
    "入口卡：書刊只算書，地方好物另一張卡",
    panel.includes("bookCount={books.length}") && panel.includes("goodsCount={goods.length}"),
  );
  checkTrue(
    "入口卡點了會切到對應篩選",
    panel.includes("onPickType={setFilter}") && strip.includes("onPickType?.(entry.productType)"),
  );
}
checkTrue(
  "/curation 卡片區標題與 /partnership 同一句",
  files.curation.includes('zh: "我們做過的合作類型"') &&
    files.partnership.includes('zh: "我們做過的合作類型"'),
);

// =============================================================================
console.log("\n[4] 假資料移除（業主 2026-11-10）：程式後備與 seed 不再有範例選品");
// =============================================================================
{
  const content = readFile("src/data/content.ts");
  const seed = readFile("supabase/seed.sql");
  for (const name of ["山村釀造．桂花蜜", "粗陶茶碗", "海鹽可可", "桂圓紅棗茶"]) {
    checkFalse(`src/data/content.ts 不再有「${name}」`, content.includes(name));
    checkFalse(`supabase/seed.sql 不再有「${name}」`, seed.includes(name));
  }
  const data = await import(pathToFileURL(join(ROOT, "src/data/content.ts")).href);
  check(
    "後備主題保留三個，底下沒有任何品項",
    data.curatedThemes.map((t) => t.items.length),
    [0, 0, 0],
  );
  checkFalse("seed.sql 不再 insert curated_items", /insert into public\.curated_items/.test(seed));
}

console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
console.log("");
if (fail > 0) {
  console.log(red(`✗ ${fail} failed, ${pass} passed`));
  process.exit(1);
}
console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
