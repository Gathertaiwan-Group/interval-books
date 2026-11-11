#!/usr/bin/env node
/**
 * motion-selftest.mjs —— 前台動效（2026-11）：捲動浮現＋換頁過場
 *
 *   [純函式] src/lib/motion.ts
 *              · revealDelay：70ms 一階、最多錯開前 6 張
 *              · shouldPageTransition：第一次載入／只改 query／減少動態效果／後台、廠商、結帳 都不播
 *   [靜態]   🔴 SSR 一定看得見：隱藏規則只在 html[data-motion="on"] 底下、而且包在
 *            prefers-reduced-motion: no-preference 裡；標記元素不帶 inline opacity
 *            router 在 onBeforeNavigate 決定 defaultViewTransition；頁首有獨立 view-transition-name
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/motion-selftest.mjs";

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
function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(green("  ✓ ") + name);
  } else {
    fail++;
    console.log(
      red("  ✗ ") +
        name +
        `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`,
    );
  }
}
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const { revealDelay, shouldPageTransition, isMotionExcludedPath } = await import("@/lib/motion");

console.log("\n[純函式] revealDelay");
eq("第 1 張不延遲", revealDelay(0), 0);
eq("第 2 張 70ms", revealDelay(1), 70);
eq("第 6 張 350ms", revealDelay(5), 350);
eq("第 7 張之後不再加", revealDelay(6), 350);
eq("第 20 張之後不再加", revealDelay(19), 350);
eq("負數當 0", revealDelay(-3), 0);

console.log("\n[純函式] shouldPageTransition");
const go = (fromPath, toPath, reducedMotion = false) =>
  shouldPageTransition({ fromPath, toPath, reducedMotion });
eq("首頁 → /events 播", go("/", "/events"), true);
eq("/events → /events/xxx 播", go("/events", "/events/abc"), true);
eq("/en/about → /en/shop 播", go("/en/about", "/en/shop"), true);
eq("第一次載入不播", go(undefined, "/"), false);
eq("同一頁只改 query 不播", go("/events", "/events"), false);
eq("減少動態效果不播", go("/", "/events", true), false);
eq("進結帳不播", go("/cart", "/checkout"), false);
eq("結帳完成頁不播", go("/checkout", "/checkout/complete"), false);
eq("離開結帳不播", go("/checkout/complete", "/"), false);
eq("進後台不播", go("/", "/admin"), false);
eq("後台內換頁不播", go("/admin/orders", "/admin/events"), false);
eq("廠商後台不播", go("/vendor", "/vendor/x"), false);
eq("/en/checkout 也算結帳", isMotionExcludedPath("/en/checkout"), true);
eq("/vendors-story 不是廠商後台（只比對整段路徑）", isMotionExcludedPath("/vendors-story"), false);
eq("/administrator 不是後台", isMotionExcludedPath("/administrator"), false);

console.log("\n[靜態] SSR 一定看得見");
const css = read("src/styles.css");
const hideRules = [
  ...css.matchAll(/([^{}]*)\{\s*opacity:\s*0;\s*transform:\s*translateY\(14px\);\s*\}/g),
]
  .map((m) => m[1].trim())
  .filter((sel) => sel !== "from"); // @keyframes 的起始格不算
eq(
  '隱藏規則恰好一條，且掛在 html[data-motion="on"] 底下',
  hideRules.length === 1 && hideRules[0].startsWith('html[data-motion="on"]'),
  true,
);
const blockStart = css.indexOf("@media screen and (prefers-reduced-motion: no-preference)");
const hideAt = css.indexOf('html[data-motion="on"] :is([data-reveal]');
eq(
  "隱藏規則包在 screen + no-preference 的 @media 裡（列印與減少動態效果都看得到）",
  blockStart >= 0 && hideAt > blockStart,
  true,
);
const motionLib = read("src/lib/motion.ts");
eq(
  "data-motion 只在瀏覽器端由 startScrollReveal 打開",
  /root\.setAttribute\("data-motion", "on"\)/.test(motionLib),
  true,
);
eq(
  "打開開關之前先處理首屏元素",
  motionLib.indexOf("querySelectorAll(TARGETS).forEach(register)") <
    motionLib.indexOf('setAttribute("data-motion"'),
  true,
);
const marked = [
  "src/routes/index.tsx",
  "src/routes/events.index.tsx",
  "src/routes/about.tsx",
  "src/routes/partnership.tsx",
  "src/components/PastShelf.tsx",
  "src/components/SwipeRail.tsx",
  "src/components/shop/ProductsPanel.tsx",
];
for (const f of marked) {
  const src = read(f);
  eq(`${f} 有標記`, /data-reveal/.test(src), true);
  eq(`${f} 沒有 inline opacity:0`, /opacity:\s*0[,}\s]/.test(src), false);
}

console.log("\n[靜態] 換頁過場接線");
const router = read("src/router.tsx");
eq(
  "router 在 onBeforeNavigate 設 defaultViewTransition",
  /subscribe\("onBeforeNavigate"[\s\S]*defaultViewTransition = shouldPageTransition/.test(router),
  true,
);
eq(
  "頁首有獨立 view-transition-name",
  /site-header-vt/.test(read("src/components/SiteHeader.tsx")) &&
    /view-transition-name:\s*site-header/.test(css),
  true,
);
eq("根層掛了 MotionController", /<MotionController \/>/.test(read("src/routes/__root.tsx")), true);

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
