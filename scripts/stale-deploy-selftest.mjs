#!/usr/bin/env node
/**
 * stale-deploy-selftest.mjs —— src/lib/stale-deploy.ts 與 src/router.tsx 接線的自檢
 *
 * 2026-10-20 店主回報：《海的聲音》頁按「立即報名」，會先閃一下錯誤訊息才進結帳頁。
 * 用無頭 Chrome 重現：新開的分頁完全正常；只有「部署前就開著的舊分頁」會出事——換頁時
 * 舊的 checkout.index-*.js 回 404，先跳「網站剛更新了／剛剛的動作沒有送出」提示（換頁時這句
 * 是錯的），loader 跑完又掉進「Something went wrong」錯誤頁，約 2 秒後才自動重載進結帳頁。
 *
 * 這裡守三件事：
 *   [1] 判斷是不是程式檔過期（regex）與冷卻（不會無限重整）——直接 import 產線程式碼執行。
 *   [2] 換頁中 → 重載、不跳提示；非換頁（按鈕／表單）→ 只跳提示、絕不自動重載。
 *   [3] router.tsx 的接線（靜態）：錯誤頁在會重載時畫中性載入畫面、preloadError 會看 router 狀態。
 *
 * 執行：node scripts/stale-deploy-selftest.mjs（或 npm test）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  RELOAD_COOLDOWN_MS,
  RELOAD_KEY,
  canReloadForNewDeploy,
  claimReloadForNewDeploy,
  isStaleDeployError,
  preloadErrorAction,
} from "../src/lib/stale-deploy.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/stale-deploy-selftest.mjs";
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
const mem = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _m: m,
  };
};

console.log("\n[1] 程式檔過期判斷與冷卻");
// 實際在 prod 抓到的那一行（Chrome）
check(
  "Chrome：Failed to fetch dynamically imported module",
  isStaleDeployError(
    new TypeError(
      "Failed to fetch dynamically imported module: https://www.intervalbooks.tw/assets/checkout.index-CuyTH7-D.js",
    ),
  ),
  true,
);
check(
  "Safari：Importing a module script failed",
  isStaleDeployError(new TypeError("Importing a module script failed.")),
  true,
);
check(
  "Firefox：error loading dynamically imported module",
  isStaleDeployError("error loading dynamically imported module"),
  true,
);
check(
  "CSS 預載失敗",
  isStaleDeployError(new Error("Unable to preload CSS for /assets/x.css")),
  true,
);
check("一般錯誤不算", isStaleDeployError(new Error("Cannot read properties of undefined")), false);
check("null 不算", isStaleDeployError(null), false);

const now = 1_000_000_000;
const s1 = mem();
check("沒重載過 → 可以重載", canReloadForNewDeploy(s1, now), true);
check("canReload 只讀不寫", s1._m.has(RELOAD_KEY), false);
check(
  "claim → true 並記下時間",
  [claimReloadForNewDeploy(s1, now), s1.getItem(RELOAD_KEY)],
  [true, String(now)],
);
check(
  "冷卻內再 claim → false（不會無限重整）",
  claimReloadForNewDeploy(s1, now + RELOAD_COOLDOWN_MS - 1),
  false,
);
check("冷卻內 canReload → false（錯誤頁要畫出來）", canReloadForNewDeploy(s1, now + 1), false);
check("冷卻過後 → 可以再重載", canReloadForNewDeploy(s1, now + RELOAD_COOLDOWN_MS), true);
check(
  "沒有 sessionStorage → 不重載",
  [canReloadForNewDeploy(null, now), claimReloadForNewDeploy(null, now)],
  [false, false],
);
const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("SecurityError");
  },
};
check(
  "sessionStorage 會拋錯 → 不重載",
  [canReloadForNewDeploy(throwing, now), claimReloadForNewDeploy(throwing, now)],
  [false, false],
);
const readOnly = {
  getItem: () => null,
  setItem: () => {
    throw new Error("QuotaExceeded");
  },
};
check("寫不進去 → claim false（記不住就不冒險）", claimReloadForNewDeploy(readOnly, now), false);

console.log("\n[2] vite:preloadError 的處置");
check("換頁中＋可重載 → reload（不跳「動作沒有送出」）", preloadErrorAction(true, true), "reload");
check("換頁中但冷卻中 → announce", preloadErrorAction(true, false), "announce");
check("按鈕／表單（非換頁）→ announce，絕不自動重載", preloadErrorAction(false, true), "announce");
check("非換頁＋冷卻中 → announce", preloadErrorAction(false, false), "announce");

console.log("\n[3] router.tsx 接線（靜態）");
const src = readFileSync(join(ROOT, "src/router.tsx"), "utf8").replace(
  /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
  "",
);
check("router.tsx 不再自己定義 regex（單一來源）", /STALE_DEPLOY_ERROR\s*=/.test(src), false);
check(
  "preloadError 監聽器看 router 是否正在換頁",
  /addEventListener\(\s*"vite:preloadError"[\s\S]{0,400}state\.status\s*===\s*"pending"/.test(src),
  true,
);
check("監聽器不 preventDefault（按鈕呼叫端要看到原本的錯誤）", /preventDefault/.test(src), false);
check("getRouter 記住 router 給監聽器用", /currentRouter\s*=\s*router/.test(src), true);
const comp = src.slice(src.indexOf("function DefaultErrorComponent"));
const reloadingBranch = comp.slice(
  comp.indexOf("if (reloading)"),
  comp.indexOf("if (reloading)") + 600,
);
check(
  "錯誤頁：會重載時先 return 中性載入畫面",
  comp.indexOf("if (reloading)") > -1 &&
    comp.indexOf("if (reloading)") < comp.indexOf("Something went wrong"),
  true,
);
check(
  "中性載入畫面裡沒有錯誤字樣",
  /Something went wrong|error|錯誤|Try again/i.test(
    reloadingBranch.slice(0, reloadingBranch.indexOf("</div>\n    );")),
  ),
  false,
);
check(
  "重載被冷卻擋下 → 改畫錯誤頁",
  /reloadOnceForNewDeploy\(\)\)\s*setReloading\(false\)/.test(comp),
  true,
);
check(
  "Try again 在過期時整頁重載（不是 reset）",
  /if \(staleDeploy\)\s*\{\s*window\.location\.reload\(\)/.test(comp),
  true,
);

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
