#!/usr/bin/env node
/**
 * staff-schedule-selftest.mjs —— 後台「門市排班」（/admin/staff-schedule）的自檢
 *
 *   [1] 資料檔 src/lib/admin/staff-schedule.ts：範例週班表算出來的每人時數與週末班
 *       跟規劃一致（A/B 18、C/D 21.5），每天都有早晚兩班、早晚不是同一人
 *   [2] 接線：路由把 staff 導回櫃檯、側欄有入口且 staff: false
 *
 * [1] 直接 import 產線的 .ts（Node 原生型別剝離），驗的是真的那份資料。
 *
 * 執行：node scripts/staff-schedule-selftest.mjs（或 npm test）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/staff-schedule-selftest.mjs";

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
const checkTrue = (label, v) => check(label, v === true, true);

/** 讀不到就丟例外，不回空字串（run-selftests.mjs 守門 4）。 */
function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

const S = await import(pathToFileURL(join(ROOT, "src/lib/admin/staff-schedule.ts")).href);

console.log("\n[1] 範例週班表算出來的時數");
const summary = S.staffWeeklyHours();
check(
  "每人每週時數：A 18、B 18、C 21.5、D 21.5",
  summary.map((s) => [s.code, s.hours]),
  [
    ["A", 18],
    ["B", 18],
    ["C", 21.5],
    ["D", 21.5],
  ],
);
check(
  "週末班：A 週日晚班、B 週日早班、C 週六早班＋週日加強、D 週六晚班＋週六加強",
  summary.map((s) => s.weekendShifts),
  ["週日晚班", "週日早班", "週六早班＋週日加強", "週六晚班＋週六加強"],
);
check("一週 7 天、一到日", S.WEEK.map((d) => d.day).join(""), "一二三四五六日");
checkTrue(
  "每天早班與晚班不是同一人",
  S.WEEK.every((d) => d.early !== d.late),
);
checkTrue(
  "週末才有加強班、平日才有整理班",
  S.WEEK.every((d) => !d.extra || (d.extra.shift === "weekend") === d.weekend),
);
check(
  "早晚兩班一週 63 小時",
  S.WEEK.length * (S.shiftByKey("early").hours + S.shiftByKey("late").hours),
  63,
);
checkTrue(
  "每人每週都有休息日（7 天內至少 2 天沒排班）",
  S.STAFF.every((m) => {
    const worked = S.WEEK.filter(
      (d) => d.early === m.code || d.late === m.code || d.extra?.staff === m.code,
    ).length;
    return worked <= 5;
  }),
);
checkTrue(
  "STAFF 有 name 欄位可填真名",
  S.STAFF.every((m) => typeof m.name === "string" && m.name.length > 0),
);

console.log("\n[2] 接線");
const route = stripComments(read("src/routes/admin/_shell.staff-schedule.tsx"));
checkTrue(
  "路由掛在 /admin/_shell/staff-schedule",
  route.includes('"/admin/_shell/staff-schedule"'),
);
checkTrue(
  "staff 導回 /admin/pos",
  /role === "staff"[\s\S]{0,80}redirect\(\{ to: "\/admin\/pos" \}\)/.test(route),
);
checkTrue("頁面資料來自資料檔", route.includes('from "@/lib/admin/staff-schedule"'));
const shell = read("src/routes/admin/_shell.tsx");
checkTrue(
  "側欄有「門市排班」入口且 staff: false",
  /to: "\/admin\/staff-schedule", label: "門市排班", icon: \w+, staff: false/.test(shell),
);

console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
