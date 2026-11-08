#!/usr/bin/env node
/**
 * 地方刊物獨立頁（2026-11 SEO 健檢 M4）的行為測試。
 *
 *   /publications           總覽頁（不再 301）
 *   /publications/$slug     一本刊物一頁：SSR 介紹、canonical、hreflang、JSON-LD、同地區推薦
 *   /shop/pub-*             canonical 指向刊物頁、不進 sitemap
 *   /shop?tab=publications  舊網址照常顯示，canonical 指向 /publications、不進 sitemap
 *
 * 純函式（src/lib/seo/publication.ts、head.ts、core.ts、sitemap-entries.ts、cache-policy.ts）
 * 直接 import 跑真的行為；路由檔（loader 的 404／301 形狀）用原始碼比對守住。
 * 真的 HTTP 狀態碼（404、301、SSR 內容）由 scripts/check-seo.mjs 對本機／正式站驗。
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/publication-page-selftest.mjs";

// "@/x" → src/x.ts；src 底下不帶副檔名的相對 import（head.ts 的 "./core"）→ 補 .ts。
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      return {
        url: pathToFileURL(join(ROOT, "src", `${spec.slice(2)}.ts`)).href,
        shortCircuit: true,
      };
    }
    if (
      spec.startsWith(".") &&
      !/\.[a-z]+$/i.test(spec) &&
      ctx.parentURL?.startsWith(pathToFileURL(join(ROOT, "src")).href)
    ) {
      return { url: new URL(`${spec}.ts`, ctx.parentURL).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

let pass = 0;
let fail = 0;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? green("✓") : red("✗")} ${name}${ok ? "" : `\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`}`,
  );
}
const checkTrue = (name, v) => check(name, v === true, true);
const checkFalse = (name, v) => check(name, v === false, true);
const readFile = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${rel}`);
  return readFileSync(p, "utf8");
};
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const pub = await imp("src/lib/seo/publication.ts");
const core = await imp("src/lib/seo/core.ts");
const head = await imp("src/lib/seo/head.ts");
const { buildSitemapEntries } = await imp("src/lib/seo/sitemap-entries.ts");
const cache = await imp("src/server/cache-policy.ts");
const regions = await imp("src/lib/publication-regions.ts");

const O = "https://www.intervalbooks.tw";
const L = (zh, en, ja) => ({ zh, en, ja });

// 正式庫實際的兩筆（2026-11 讀取，介紹截短）。
const TW001 = {
  slug: "tw-001",
  sheet: "tw",
  title: L("東北風", "Dongbeifeng", "東北風"),
  publisher: L(
    "許焜山／八斗子漁村文物館",
    "Hsu Kun-shan / Badouzi Fishing Village Museum",
    "許焜山／八斗子漁村文物館",
  ),
  intro: L(
    "許焜山先生有感於家鄉漁村記憶不斷流失，希望以自己的筆「說八斗子的故事、寫八斗子的歷史」，從漁村生活、信仰、產業到人物，一期一期記下基隆八斗子的樣子。這是一份由在地居民親手編寫的刊物。",
    "Moved by the way the memories of his home fishing village were steadily disappearing, and wanting to tell Badouzi's stories and write its history in his own hand, Hsu Kun-shan records the life, faith, industry and people of Badouzi in Keelung, issue after issue.",
    "故郷である漁村の記憶が絶えず失われていくことに心を痛め、自らの筆で「八斗子の物語を語り、八斗子の歴史を書く」ことを願った許焜山氏が、漁村の暮らし・信仰・産業・人物を一号ずつ記録した、地元の人の手による刊行物です。",
  ),
  region: "基隆-八斗子",
  issues: null,
  externalUrl: "https://example.org/dongbeifeng",
};
const SHORT = {
  ...TW001,
  slug: "tw-085",
  title: L("短介紹", "Short intro", "短い紹介"),
  intro: L("一份很短的介紹。", "A short intro.", "短い紹介です。"),
  region: "台灣各地",
  externalUrl: null,
};

// =============================================================================
console.log("\n[1] title：「刊名｜地區・出版單位｜地方刊物｜店名」，太長就拿掉出版單位");
const t1 = pub.publicationTitle(TW001);
check("tw-001 中文 title", t1.zh, "東北風｜基隆・八斗子漁村文物館｜地方刊物｜小時光書店");
checkTrue("中文 title ≤ 40 字", core.charLength(t1.zh) <= 40);
checkTrue("英文 title ≤ 70 字元", t1.en.length <= 70);
const longEn = {
  ...TW001,
  title: L("東北風", "The Very Long English Title Of A Local Magazine From Keelung", "東北風"),
};
check(
  "英文刊名很長 → 再拿掉 Local Publications（刊名｜地區｜店名）",
  pub.publicationTitle(longEn).en,
  "The Very Long English Title Of A Local Magazine From Keelung｜Keelung｜Interval Books",
);
checkTrue(
  "英文 title 以刊名開頭、以 Interval Books 結尾",
  /^Dongbeifeng｜.*Interval Books$/.test(t1.en),
);
check("日文 title 用日文品牌", t1.ja.endsWith("小時光書店"), true);
const longPub = {
  ...TW001,
  publisher: L(
    "某某某某某某某某某某某某某某某某某某某某某某某某某協會",
    "X",
    "某某某某某某某某某某某某某某某某某某某某某某某某某協會",
  ),
};
check(
  "出版單位太長 → 只留地區",
  pub.publicationTitle(longPub).zh,
  "東北風｜基隆｜地方刊物｜小時光書店",
);
check(
  "publisherShort 取最後一段",
  pub.publisherShort("許焜山／八斗子漁村文物館"),
  "八斗子漁村文物館",
);
check(
  "publisherShort 半形斜線也認",
  pub.publisherShort("林思駿/台北市政府文化局"),
  "台北市政府文化局",
);
check("地區落在「其他」：中文用原文", pub.publicationRegionLabel(SHORT).zh, "台灣各地");
check(
  "地區落在「其他」：英文用國家名（不放中文進英文 title）",
  pub.publicationRegionLabel(SHORT).en,
  "Taiwan",
);
check(
  "日本刊物的地區",
  pub.publicationRegionLabel({ sheet: "jp", region: "山形県-最上町" }),
  L("山形", "Yamagata", "山形"),
);

// =============================================================================
console.log("\n[2] description：介紹截到 70–160 字（英文 110–300）");
const d1 = pub.publicationDescription(TW001);
for (const lang of ["zh", "ja"]) {
  const n = core.charLength(d1[lang]);
  checkTrue(`tw-001 ${lang} 描述 70–160 字（實際 ${n}）`, n >= 70 && n <= 160);
}
checkTrue("tw-001 英文描述 110–300 字元", d1.en.length >= 110 && d1.en.length <= 300);
checkTrue(
  "描述是「介紹……——《刊名》」（取自 intro，結尾帶刊名）",
  d1.zh.startsWith("許焜山先生有感於家鄉漁村記憶不斷流失") &&
    d1.zh.endsWith(`——《${TW001.title.zh}》`),
);
const d2 = pub.publicationDescription(SHORT);
checkTrue(
  "介紹太短 → 補這一本的地區、製作單位（不是全站同一句站名標語）",
  d2.zh.startsWith("一份很短的介紹。") &&
    d2.zh.endsWith(`——《${SHORT.title.zh}》`) &&
    d2.zh.includes("地方刊物") &&
    !d2.zh.includes("華山文創園區"),
  d2.zh,
);
const twin = pub.publicationDescription({
  ...TW001,
  slug: "tw-twin",
  title: { zh: "西北雨", en: "Xibeiyu", ja: "西北雨" },
});
checkTrue(
  "介紹逐字相同、刊名一樣長的兩本刊物，描述結尾仍不同（結尾帶刊名）",
  twin.zh.slice(-20) !== d1.zh.slice(-20) && twin.en.slice(-20) !== d1.en.slice(-20),
);

// =============================================================================
console.log("\n[3] JSON-LD：Book（有商品 → Book+Product+offers）＋ BreadcrumbList");
const ldPlain = pub.publicationLd({
  entry: TW001,
  lang: "zh",
  image: "/media/site-images/publications/tw-001.jpg",
  offer: null,
});
const book = ldPlain[0];
check("沒商品：@type = Book", book["@type"], "Book");
check("url 是刊物頁的絕對網址", book.url, `${O}/publications/tw-001`);
check("name", book.name, "東北風");
checkTrue(
  "description 有值",
  typeof book.description === "string" && book.description.length >= 70,
);
check("image 是絕對網址", book.image, [`${O}/media/site-images/publications/tw-001.jpg`]);
check("publisher 是 Organization", book.publisher, {
  "@type": "Organization",
  name: "許焜山／八斗子漁村文物館",
});
check("spatialCoverage 是地區原文", book.spatialCoverage, {
  "@type": "Place",
  name: "基隆-八斗子",
});
check("sameAs 是刊物網站", book.sameAs, ["https://example.org/dongbeifeng"]);
checkFalse("沒商品：沒有 offers", "offers" in book);
const crumbs = ldPlain[1];
check("BreadcrumbList", crumbs["@type"], "BreadcrumbList");
check(
  "麵包屑：首頁 › 地方刊物 › 刊名",
  crumbs.itemListElement.map((i) => [i.position, i.name, i.item]),
  [
    [1, "首頁", `${O}/`],
    [2, "地方刊物", `${O}/publications`],
    [3, "東北風", `${O}/publications/tw-001`],
  ],
);
const ldOffer = pub.publicationLd({
  entry: TW001,
  lang: "en",
  image: null,
  offer: { slug: "pub-tw-001", price: 150, inStock: true },
});
check("有商品：@type = [Book, Product]", ldOffer[0]["@type"], ["Book", "Product"]);
check(
  "offers.price／幣別",
  [ldOffer[0].offers.price, ldOffer[0].offers.priceCurrency],
  [150, "TWD"],
);
check("offers.availability InStock", ldOffer[0].offers.availability, "https://schema.org/InStock");
check(
  "offers.url 指向（同語言的）刊物頁本身（canonical，不指向 canonical 指回來的商品頁）",
  ldOffer[0].offers.url,
  `${O}/en/publications/tw-001`,
);
check("英文版 url 帶 /en", ldOffer[0].url, `${O}/en/publications/tw-001`);
checkFalse("沒封面就不輸出 image", "image" in ldOffer[0]);
check(
  "英文麵包屑",
  ldOffer[1].itemListElement.map((i) => i.item),
  [`${O}/en`, `${O}/en/publications`, `${O}/en/publications/tw-001`],
);
const sold = pub.publicationLd({
  entry: TW001,
  lang: "zh",
  image: null,
  offer: { slug: "pub-tw-001", price: 150, inStock: false },
});
check("售完 → OutOfStock", sold[0].offers.availability, "https://schema.org/OutOfStock");
check(
  "總覽頁麵包屑",
  pub.publicationsIndexLd("ja")[0].itemListElement.map((i) => i.item),
  [`${O}/ja`, `${O}/ja/publications`],
);

// =============================================================================
console.log("\n[4] 三語 head：canonical、hreflang、og:image、noindex 規則");
const ctx = (lang, pathname) => ({ matches: [{ loaderData: { lang } }], match: { pathname } });
function headFor(lang, entry, offer = null) {
  return head.pageHead(ctx(lang, "/publications/tw-001"), {
    translation: pub.publicationTranslation(entry),
    title: pub.publicationTitle(entry),
    description: pub.publicationDescription(entry),
    image: "/media/site-images/publications/tw-001.jpg",
    type: "book",
    jsonLd: pub.publicationLd({
      entry,
      lang,
      image: "/media/site-images/publications/tw-001.jpg",
      offer,
    }),
  });
}
const linkOf = (h, rel, hl) =>
  h.links.find((l) => l.rel === rel && (hl === undefined || l.hrefLang === hl))?.href ?? null;
const metaOf = (h, key) =>
  h.meta.find((m) => m.property === key || m.name === key)?.content ?? null;
for (const [lang, prefix] of [
  ["zh", ""],
  ["en", "/en"],
  ["ja", "/ja"],
]) {
  const h = headFor(lang, TW001);
  check(`${lang}：canonical`, linkOf(h, "canonical"), `${O}${prefix}/publications/tw-001`);
  check(`${lang}：title`, h.meta[0].title, pub.publicationTitle(TW001)[lang]);
  check(
    `${lang}：hreflang 三語＋x-default`,
    ["zh-Hant", "en", "ja", "x-default"].map((hl) => linkOf(h, "alternate", hl)),
    [
      `${O}/publications/tw-001`,
      `${O}/en/publications/tw-001`,
      `${O}/ja/publications/tw-001`,
      `${O}/publications/tw-001`,
    ],
  );
  check(
    `${lang}：og:image 絕對網址`,
    metaOf(h, "og:image"),
    `${O}/media/site-images/publications/tw-001.jpg`,
  );
  check(`${lang}：og:type book`, metaOf(h, "og:type"), "book");
  check(`${lang}：沒有 robots noindex`, metaOf(h, "robots"), null);
  const lds = h.meta.filter((m) => m["script:ld+json"]).map((m) => m["script:ld+json"]);
  const bookLd = lds.find((d) => d["@type"] === "Book");
  check(
    `${lang}：Book 帶 inLanguage`,
    bookLd?.inLanguage,
    { zh: "zh-Hant-TW", en: "en", ja: "ja" }[lang],
  );
  checkTrue(
    `${lang}：有 BreadcrumbList 與 WebPage`,
    lds.some((d) => d["@type"] === "BreadcrumbList") && lds.some((d) => d["@type"] === "WebPage"),
  );
}
// 英文介紹沒翻（中文原文貼進英文欄）→ 英文版 noindex、不出現在 hreflang。
const untranslatedEn = { ...TW001, intro: { ...TW001.intro, en: TW001.intro.zh } };
const hEn = headFor("en", untranslatedEn);
check("英文介紹沒翻 → /en 版 noindex, follow", metaOf(hEn, "robots"), "noindex, follow");
check("英文介紹沒翻 → /en 版沒有 canonical", linkOf(hEn, "canonical"), null);
const hZh = headFor("zh", untranslatedEn);
check("英文介紹沒翻 → 中文版 hreflang 不列 en", linkOf(hZh, "alternate", "en"), null);
check(
  "英文介紹沒翻 → 中文版 hreflang 仍列 ja",
  linkOf(hZh, "alternate", "ja"),
  `${O}/ja/publications/tw-001`,
);
// 日文刊名與中文一樣（短刊名用漢字本來就相同）→ 仍算有翻譯（既有規則：>15 字且一字不差才算沒翻）。
checkTrue(
  "日文刊名＝中文（短）不算沒翻",
  head
    .pageHead(ctx("ja", "/publications/tw-001"), {
      translation: pub.publicationTranslation(TW001),
      title: pub.publicationTitle(TW001),
      description: pub.publicationDescription(TW001),
    })
    .links.some((l) => l.rel === "canonical"),
);

// =============================================================================
// jp-022「TOKYO COFFEE FESTIVAL」：英文專有名詞刊名三語相同、>15 字，介紹有翻 → 日文版仍可收錄。
const latinTitle = {
  ...TW001,
  title: L("TOKYO COFFEE FESTIVAL", "TOKYO COFFEE FESTIVAL", "TOKYO COFFEE FESTIVAL"),
};
check(
  "不含漢字的刊名不拿來判斷（只看介紹）",
  pub.publicationTranslationFields(latinTitle).title,
  null,
);
checkTrue(
  "jp-022 型：日文版可收錄",
  head
    .pageHead(ctx("ja", "/publications/jp-022"), {
      translation: pub.publicationTranslation(latinTitle),
      title: pub.publicationTitle(latinTitle),
      description: pub.publicationDescription(latinTitle),
    })
    .links.some((l) => l.rel === "canonical"),
);
const hanSame = {
  ...TW001,
  title: L(
    "這是一個超過十五個字的很長很長的中文刊名喔",
    "A long title",
    "這是一個超過十五個字的很長很長的中文刊名喔",
  ),
};
check(
  "含漢字、>15 字且日文與中文相同 → 仍照既有規則判沒翻（日文 noindex）",
  metaOf(
    head.pageHead(ctx("ja", "/publications/x"), {
      translation: pub.publicationTranslation(hanSame),
      title: pub.publicationTitle(hanSame),
      description: pub.publicationDescription(hanSame),
    }),
    "robots",
  ),
  "noindex, follow",
);

console.log("\n[5] canonical 收斂：/shop/pub-*、/shop?tab=publications 指向刊物頁");
const hProduct = head.pageHead(ctx("en", "/shop/pub-tw-001"), {
  title: L("a", "b", "c"),
  description: L("a", "b", "c"),
  translation: pub.publicationTranslation(TW001),
  canonicalPath: pub.publicationPath("tw-001"),
});
check(
  "商品頁 canonical → 同語言的刊物頁",
  linkOf(hProduct, "canonical"),
  `${O}/en/publications/tw-001`,
);
check("商品頁 og:url 同上", metaOf(hProduct, "og:url"), `${O}/en/publications/tw-001`);
check("商品頁不輸出 hreflang", hProduct.links.filter((l) => l.rel === "alternate").length, 0);
checkFalse(
  "商品頁不輸出 WebPage（那是刊物頁自己的）",
  hProduct.meta.some((m) => m["script:ld+json"]?.["@type"] === "WebPage"),
);
const hProductUntranslated = head.pageHead(ctx("en", "/shop/pub-tw-001"), {
  title: L("a", "b", "c"),
  description: L("a", "b", "c"),
  translation: pub.publicationTranslation(untranslatedEn),
  canonicalPath: pub.publicationPath("tw-001"),
});
check(
  "刊物頁 /en noindex → 商品頁 /en 也 noindex（不指向 noindex 頁）",
  metaOf(hProductUntranslated, "robots"),
  "noindex, follow",
);
check("…而且沒有 canonical", linkOf(hProductUntranslated, "canonical"), null);
const hTab = head.pageHead(
  {
    matches: [{ loaderData: { lang: "zh" } }],
    match: { pathname: "/shop", search: { tab: "publications" } },
  },
  { title: L("a", "b", "c"), description: L("a", "b", "c"), canonicalPath: "/publications" },
);
check(
  "/shop?tab=publications canonical → /publications",
  linkOf(hTab, "canonical"),
  `${O}/publications`,
);

const shopSlugSrc = readFile("src/routes/shop.$slug.tsx");
checkTrue(
  "shop.$slug.tsx：有對應刊物時 canonicalPath = publicationPath(slug)",
  /canonicalPath: publication \? publicationPath\(publication\.slug\) : undefined/.test(
    shopSlugSrc,
  ),
);
checkTrue(
  "shop.$slug.tsx：有對應刊物時不輸出第二份 Product JSON-LD",
  /jsonLd: publication \? \[\] : seo\.jsonLd/.test(shopSlugSrc),
);
checkTrue("shop.$slug.tsx：頁面連到刊物頁", /to="\/publications\/\$slug"/.test(shopSlugSrc));
const shopIndexSrc = readFile("src/routes/shop.index.tsx");
checkTrue(
  'shop.index.tsx：?tab=publications 的 canonicalPath 是 "/publications"',
  /canonicalPath: tab === "publications" \? "\/publications" : undefined/.test(shopIndexSrc),
);
checkTrue(
  "shop.index.tsx：分頁列「地方刊物」連到 /publications",
  /to="\/publications"/.test(shopIndexSrc),
);

// =============================================================================
console.log("\n[6] 路由：slug 找不到 404、大小寫 301、總覽頁不轉址");
const slugRoute = readFile("src/routes/publications.$slug.tsx");
checkTrue(
  '宣告成 "/publications/$slug"',
  slugRoute.includes('createFileRoute("/publications/$slug")'),
);
checkTrue(
  "查無此刊物且不是讀取失敗 → 先不分大小寫找，找不到 throw notFound()",
  /if \(!publication && !unavailable\) \{[\s\S]{0,400}findPublicationSlugIgnoringCase\(params\.slug\)[\s\S]{0,300}statusCode: 301[\s\S]{0,120}throw notFound\(\);/.test(
    slugRoute,
  ),
);
checkTrue("讀取失敗 → 503（unavailableHeaders）", /unavailableHeaders\(/.test(slugRoute));
checkTrue(
  "介紹在 SSR（loader 讀 fetchPublicationBySlug、元件畫 t(pub.intro)）",
  /fetchPublicationBySlug\(params\.slug\)/.test(slugRoute) && /\{t\(pub\.intro\)\}/.test(slugRoute),
);
checkTrue(
  "有商品：購買這本連到 /shop/$slug",
  /to="\/shop\/\$slug"[\s\S]{0,80}params=\{\{ slug: offer\.slug \}\}/.test(slugRoute),
);
checkTrue(
  "沒商品：歡迎到店翻閱＋來訪資訊連結 /about",
  /PAGE\.inStore/.test(slugRoute) && /to="\/about"/.test(slugRoute),
);
checkTrue(
  "同地區推薦最多 6 本",
  /relatedPublications\(list\.publications, publication, 6\)/.test(slugRoute),
);
const indexRoute = readFile("src/routes/publications.index.tsx");
checkTrue(
  '總覽頁宣告成 "/publications/"',
  indexRoute.includes('createFileRoute("/publications/")'),
);
checkFalse("總覽頁不再 throw redirect", /throw redirect\(/.test(indexRoute));
checkFalse(
  "舊的 src/routes/publications.tsx（301）已移除",
  existsSync(join(ROOT, "src/routes/publications.tsx")),
);
check(
  "/PUBLICATIONS/tw-001 → 第一段轉小寫、slug 原樣",
  core.canonicalPathname("/PUBLICATIONS/tw-001"),
  "/publications/tw-001",
);
check(
  "/Publications/TW-001 → 只轉第一段（slug 交給 loader 查資料庫）",
  core.canonicalPathname("/Publications/TW-001"),
  "/publications/TW-001",
);
check(
  "/en/Publications/tw-001",
  core.canonicalPathname("/EN/Publications/tw-001"),
  "/en/publications/tw-001",
);
check("redirectFor：大小寫 → 301", core.redirectFor("/Publications/tw-001", "", "GET"), {
  status: 301,
  location: "/publications/tw-001",
});
check("redirectFor：尾斜線 → 308", core.redirectFor("/publications/tw-001/", "", "GET"), {
  status: 308,
  location: "/publications/tw-001",
});
check("redirectFor：/publications 本身不轉", core.redirectFor("/publications", "", "GET"), null);
check(
  "caseInsensitiveMatch：TW-001 → tw-001",
  core.caseInsensitiveMatch("TW-001", ["tw-001"]),
  "tw-001",
);
check(
  "caseInsensitiveMatch：已經正確 → null（不轉）",
  core.caseInsensitiveMatch("tw-001", ["tw-001"]),
  null,
);

// =============================================================================
console.log("\n[7] 同地區推薦");
const ALL = [
  { slug: "tw-001", sheet: "tw", region: "基隆-八斗子" },
  { slug: "tw-002", sheet: "tw", region: "基隆-全區" },
  { slug: "tw-003", sheet: "tw", region: "基隆" },
  { slug: "tw-010", sheet: "tw", region: "台南" },
  { slug: "tw-011", sheet: "tw", region: "基隆" },
  { slug: "tw-012", sheet: "tw", region: "基隆" },
  { slug: "tw-013", sheet: "tw", region: "基隆" },
  { slug: "tw-014", sheet: "tw", region: "基隆" },
  { slug: "tw-015", sheet: "tw", region: "基隆" },
  { slug: "jp-001", sheet: "jp", region: "基隆" }, // 不同國家，不算同地區
];
const rel = pub.relatedPublications(ALL, ALL[2], 6).map((e) => e.slug);
check("tw-003：從下一本開始、繞回前面、最多 6 本、不含自己與別區", rel, [
  "tw-011",
  "tw-012",
  "tw-013",
  "tw-014",
  "tw-015",
  "tw-001",
]);
check("只有自己一本的地區 → 空", pub.relatedPublications(ALL, ALL[3], 6), []);
checkFalse("不含不同國家的同名地區", rel.includes("jp-001"));
check(
  "regionGroupOf（從 publication-regions.ts）",
  regions.regionGroupOf({ sheet: "tw", region: "綠島" }),
  "taitung",
);

// =============================================================================
console.log("\n[8] sitemap：刊物頁三語、/publications 取代 /shop?tab=publications、pub 商品頁不列");
const src = {
  pages: [],
  pageParts: [],
  events: [],
  products: [
    { id: "p1", slug: "pub-tw-001", productType: "book", updatedAt: "2026-10-05T00:00:00Z" },
    { id: "p2", slug: "linen-bag", productType: "goods", updatedAt: "2026-10-01T00:00:00Z" },
  ],
  journeys: [],
  publicationsLatest: "2026-09-01T00:00:00Z",
  curatedLatest: null,
  publications: [
    {
      slug: "tw-001",
      productId: "p1",
      updatedAt: "2026-09-01T00:00:00Z",
      content: { title: TW001.title, body: [TW001.intro] },
    },
    {
      slug: "tw-002",
      productId: null,
      updatedAt: "2026-08-01T00:00:00Z",
      content: { title: TW001.title, body: [untranslatedEn.intro] },
    },
  ],
};
const entries = buildSitemapEntries(src, "2026-11-01");
const paths = entries.map((e) => e.path);
checkTrue("列出 /publications", paths.includes("/publications"));
checkFalse("不再列 /shop?tab=publications", paths.includes("/shop?tab=publications"));
check(
  "刊物頁兩筆",
  paths.filter((p) => p.startsWith("/publications/")),
  ["/publications/tw-001", "/publications/tw-002"],
);
check("tw-001 三語", entries.find((e) => e.path === "/publications/tw-001").langs, [
  "zh",
  "en",
  "ja",
]);
check("tw-002 英文沒翻 → 只有中日", entries.find((e) => e.path === "/publications/tw-002").langs, [
  "zh",
  "ja",
]);
check(
  "tw-001 lastmod 算進商品（較新）",
  entries.find((e) => e.path === "/publications/tw-001").lastmod,
  "2026-10-05T00:00:00Z",
);
checkFalse("對應刊物的 /shop/pub-tw-001 不列", paths.includes("/shop/pub-tw-001"));
checkTrue("一般商品照列", paths.includes("/shop/linen-bag"));
const xml = core.sitemapXml(entries);
const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
check("XML：刊物頁 <url> 數（3 + 2）", locs.filter((l) => /\/publications\/tw-/.test(l)).length, 5);
checkFalse("XML：沒有 /en/publications/tw-002", locs.includes(`${O}/en/publications/tw-002`));
const legacy = buildSitemapEntries({ ...src, publications: undefined }, "2026-11-01");
checkTrue(
  "舊呼叫端（沒給 publications）→ pub 商品頁照列",
  legacy.some((e) => e.path === "/shop/pub-tw-001"),
);

// =============================================================================
console.log("\n[9] 快取：刊物頁走 CDN（s-maxage），404 不快取");
for (const p of ["/publications", "/publications/tw-001"]) {
  check(
    `${p} 200 → 共用快取`,
    cache.cacheControlFor(p, "GET", 200),
    "public, max-age=0, s-maxage=60, stale-while-revalidate=600",
  );
}
check(
  "/publications/nope 404 → 不覆寫（不進 CDN）",
  cache.cacheControlFor("/publications/nope", "GET", 404),
  null,
);

// =============================================================================
console.log("\n[10] 封面走 /media/site-images 代理");
const images = readFile("src/lib/images.ts");
const coverRe = new RegExp(images.match(/MEDIA_PUBLICATION_COVER_RE = \/(.+)\/i;/)[1], "i");
checkTrue("publications/tw-001.jpg 允許", coverRe.test("publications/tw-001.jpg"));
checkFalse("不允許跳出目錄", coverRe.test("publications/../secret.jpg"));
checkFalse("不允許其他資料夾", coverRe.test("ocr/tw-001.jpg"));
const proxy = readFile("src/server/media-proxy.ts");
checkTrue(
  "刊物封面不給 immutable（可能被原地換圖）",
  /MEDIA_OBJECT_NAME_RE\.test\(name\) \? IMMUTABLE : LONG/.test(proxy),
);
const panel = readFile("src/components/shop/PublicationsPanel.tsx");
checkTrue(
  "總覽頁封面 lazy＋async＋尺寸",
  /loading="lazy"\s+decoding="async"/.test(panel) && /width=\{480\}/.test(panel),
);

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
