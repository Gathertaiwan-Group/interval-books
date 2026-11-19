#!/usr/bin/env node
/**
 * product-variants-selftest.mjs —— 商品頁「規格切換」（2026-11，參虎爆紅薏仁大小罐 × 口味）
 *
 *   [純函式] src/lib/product-variants.ts
 *              · parseVariantSpec：全形／半形分隔、有無軸名前綴、單段不算規格、空段不算
 *              · buildVariantGroup：正常兩軸、軸數不一致略過、無分組／只有一件不顯示、
 *                軸名取目前這件或兄弟的前綴、預設軸名
 *              · variantOptions／variantTarget：小罐沒有辣香鮮燒 → 小罐頁停用、
 *                從大罐辣香鮮燒按「小罐」跳小罐第一個口味；其他軸維持不變優先
 *   [靜態]   伺服器讀取只回已上架＋啟用、以 series 完全相等分組；商品頁接上元件；
 *            元件 a11y（group＋aria-labelledby、aria-current、aria-disabled、≥44px）
 *
 * 不碰任何資料庫。
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/product-variants-selftest.mjs";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      return {
        url: pathToFileURL(join(ROOT, "src", `${spec.slice(2)}.ts`)).href,
        shortCircuit: true,
      };
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
const readFile = (rel) => readFileSync(join(ROOT, rel), "utf8");

const { parseVariantSpec, buildVariantGroup, variantOptions, variantTarget, DEFAULT_AXIS_NAMES } =
  await import(pathToFileURL(join(ROOT, "src/lib/product-variants.ts")).href);

// ── parseVariantSpec ──────────────────────────────────────────────────────
console.log("\n[parseVariantSpec]");
check("全形｜＋半形冒號前綴", parseVariantSpec("罐別:大罐 150g｜口味:焦糖"), {
  names: ["罐別", "口味"],
  values: ["大罐 150g", "焦糖"],
});
check("半形 | 分隔、全形冒號前綴", parseVariantSpec("罐別：小罐 | 口味：可可"), {
  names: ["罐別", "口味"],
  values: ["小罐", "可可"],
});
check("沒有前綴 → 軸名 null", parseVariantSpec("大罐｜焦糖"), {
  names: [null, null],
  values: ["大罐", "焦糖"],
});
check("單段（一般期數）不算規格", parseVariantSpec("12"), null);
check("null 不算規格", parseVariantSpec(null), null);
check("有空段不算規格", parseVariantSpec("大罐｜"), null);
check("前綴後面沒有值不算規格", parseVariantSpec("罐別:｜口味:焦糖"), null);

// ── 測試資料：大罐 4 口味（含辣香鮮燒）、小罐 3 口味（沒有辣香鮮燒）──────────
const L = (flavor, slug) => ({
  productId: `L-${slug}`,
  slug: `large-${slug}`,
  spec: `罐別:大罐 150g｜口味:${flavor}`,
});
const S = (flavor, slug) => ({
  productId: `S-${slug}`,
  slug: `small-${slug}`,
  spec: `罐別:小罐 60g×8入｜口味:${flavor}`,
});
const SOURCES = [
  L("焦糖", "caramel"),
  L("可可", "cocoa"),
  L("辣香鮮燒", "spicy"),
  L("起司", "cheese"),
  S("可可", "cocoa"),
  S("焦糖", "caramel"),
  S("起司", "cheese"),
];

console.log("\n[buildVariantGroup]");
const g = buildVariantGroup("L-caramel", SOURCES);
check(
  "正常兩軸：軸名取前綴",
  g.axes.map((a) => a.name),
  ["罐別", "口味"],
);
check("罐別的值依品項順序去重", g.axes[0].values, ["大罐 150g", "小罐 60g×8入"]);
check("口味的值依品項順序去重", g.axes[1].values, ["焦糖", "可可", "辣香鮮燒", "起司"]);
check("目前這件", g.current.slug, "large-caramel");

check("無分組（只有自己）→ 不顯示", buildVariantGroup("L-caramel", [SOURCES[0]]), null);
check("清單是空的 → 不顯示", buildVariantGroup("L-caramel", []), null);
check("目前這件不在清單 → 不顯示", buildVariantGroup("X", SOURCES), null);
check(
  "目前這件不是規格（單段期數）→ 不顯示",
  buildVariantGroup("A", [
    { productId: "A", slug: "a", spec: "3" },
    { productId: "B", slug: "b", spec: "大罐｜焦糖" },
  ]),
  null,
);
const mixed = buildVariantGroup("L-caramel", [
  ...SOURCES,
  { productId: "W", slug: "weird", spec: "罐別:大罐｜口味:焦糖｜包裝:禮盒" },
  { productId: "N", slug: "nospec", spec: null },
]);
check(
  "軸數不一致、沒規格的兄弟品項被略過",
  mixed.items.map((i) => i.slug).includes("weird") ||
    mixed.items.map((i) => i.slug).includes("nospec"),
  false,
);
check("軸數不一致不影響其他品項", mixed.items.length, 7);
check(
  "軸數不一致到只剩自己 → 不顯示",
  buildVariantGroup("A", [
    { productId: "A", slug: "a", spec: "大｜焦糖" },
    { productId: "B", slug: "b", spec: "大｜焦糖｜禮盒" },
  ]),
  null,
);
const plain = buildVariantGroup("A", [
  { productId: "A", slug: "a", spec: "大｜焦糖" },
  { productId: "B", slug: "b", spec: "小|焦糖" },
]);
check(
  "沒有前綴 → 預設軸名",
  plain.axes.map((a) => a.name),
  [DEFAULT_AXIS_NAMES[0], DEFAULT_AXIS_NAMES[1]],
);
check("半形 | 分隔的兄弟也算同組", plain.items.length, 2);
const borrowed = buildVariantGroup("A", [
  { productId: "A", slug: "a", spec: "大｜焦糖" },
  { productId: "B", slug: "b", spec: "罐別:小｜口味:焦糖" },
]);
check(
  "目前這件沒前綴時借兄弟的軸名",
  borrowed.axes.map((a) => a.name),
  ["罐別", "口味"],
);
const dup = buildVariantGroup("B", [
  { productId: "A", slug: "a", spec: "大｜焦糖" },
  { productId: "B", slug: "b", spec: "大｜焦糖" },
  { productId: "C", slug: "c", spec: "小｜焦糖" },
]);
check(
  "規格完全相同的兩件只留一件，目前這件優先",
  dup.items.map((i) => i.slug),
  ["b", "c"],
);

// ── variantOptions／variantTarget ────────────────────────────────────────
console.log("\n[variantOptions / variantTarget]");
const states = (group, axis) =>
  variantOptions(group, axis).map((o) => [o.value, o.selected, o.disabled, o.slug]);

check("大罐焦糖頁：罐別鈕（切小罐維持焦糖）", states(g, 0), [
  ["大罐 150g", true, false, "large-caramel"],
  ["小罐 60g×8入", false, false, "small-caramel"],
]);
check("大罐焦糖頁：口味鈕全部可選", states(g, 1), [
  ["焦糖", true, false, "large-caramel"],
  ["可可", false, false, "large-cocoa"],
  ["辣香鮮燒", false, false, "large-spicy"],
  ["起司", false, false, "large-cheese"],
]);

const small = buildVariantGroup("S-cheese", SOURCES);
check("小罐頁：辣香鮮燒停用、其餘可選", states(small, 1), [
  ["焦糖", false, false, "small-caramel"],
  ["可可", false, false, "small-cocoa"],
  ["辣香鮮燒", false, true, null],
  ["起司", true, false, "small-cheese"],
]);
check("小罐頁：罐別鈕切大罐維持起司", states(small, 0)[0], [
  "大罐 150g",
  false,
  false,
  "large-cheese",
]);

const spicy = buildVariantGroup("L-spicy", SOURCES);
check(
  "大罐辣香鮮燒頁：按小罐 → 小罐第一個口味（品項順序）",
  variantTarget(spicy, 0, "小罐 60g×8入")?.slug,
  "small-cocoa",
);
check("大罐辣香鮮燒頁：小罐鈕不停用", states(spicy, 0)[1][2], false);
check("不存在的值 → null", variantTarget(g, 1, "不存在"), null);
check("不存在的軸 → 沒有鈕", variantOptions(g, 5), []);

// ── 靜態：伺服器讀取、商品頁接線、元件 a11y ───────────────────────────────
console.log("\n[靜態]");
const server = readFile("src/server/product-variants.ts");
check(
  "伺服器讀取是 server-only",
  server.includes('import "@tanstack/react-start/server-only"'),
  true,
);
check("以 series 完全相等分組", server.includes('.eq("series", series)'), true);
check("只回已上架", server.includes('.eq("listed_status", "active")'), true);
check("只回進銷存啟用中", server.includes('.eq("is_active", true)'), true);
check("讀不到要 console.warn", (server.match(/warn\(/g) ?? []).length >= 3, true);
check("不讀價格／成本／庫存", /cost_price|selling_price|stock_quantity/.test(server), false);
check("不靠名稱比對", /\.ilike\(|\.like\(|"name"/.test(server), false);

const route = readFile("src/routes/shop.$slug.tsx");
check(
  "商品頁 loader 呼叫 getProductVariants",
  route.includes("getProductVariants({ data: { productId: product.id } })"),
  true,
);
check("商品頁畫 VariantSwitcher", route.includes("<VariantSwitcher group={variantGroup} />"), true);
check("換商品時數量收回 1", route.includes("setQtyFor("), true);

const comp = readFile("src/components/shop/VariantSwitcher.tsx");
check(
  "每排 role=group＋aria-labelledby",
  comp.includes('role="group" aria-labelledby={labelId}'),
  true,
);
check(
  "目前這件 aria-current=page",
  comp.includes('aria-current={opt.selected ? "page" : undefined}'),
  true,
);
check("停用鈕 aria-disabled 的 span（不可聚焦）", comp.includes('aria-disabled="true"'), true);
check("觸控目標 ≥ 44px（min-h-11 min-w-11）", comp.includes("min-h-11 min-w-11"), true);
check("手機版自動換行", comp.includes("flex flex-wrap"), true);
check("鈕是連到 /shop/$slug 的 Link", comp.includes('to="/shop/$slug"'), true);

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
