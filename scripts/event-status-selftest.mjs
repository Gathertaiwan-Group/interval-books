#!/usr/bin/env node
/**
 * event-status-selftest.mjs —— 「已結束」要看場次，不能只看 iso_date
 *
 * 2026-10-21《海的聲音》從 /events「報名中」消失：iso_date 填的是顯示區間
 * 「2026.10.20~11.7」的開頭 2026-10-20，唯一的場次在 11/6、票還在賣。
 *
 *   [純函式] src/lib/event-status.ts：
 *              · latestSessionEndDate()：取最晚場次的結束日（台北日期），沒填 ends_at 退回 starts_at
 *              · isEventPast()：iso_date 過了但還有未來場次 → 報名中；沒場次 → 舊規則；
 *                iso_date null → 不算結束
 *   [靜態]   fetchEvents() 補上 lastSessionDate；/events 與首頁都用 isEventPast(e)
 *
 * 不碰任何資料庫。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/event-status-selftest.mjs";

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
function readFile(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`selftest 讀不到檔案：${rel}`);
  return readFileSync(abs, "utf8");
}

const S = await import(join(ROOT, "src/lib/event-status.ts"));
const TODAY = "2026-10-21";

console.log("\n[1] latestSessionEndDate");
check("沒有場次 → null", S.latestSessionEndDate([]), null);
check(
  "正式庫《海的聲音》：11/6 14:00–16:00（UTC 06:00–08:00）→ 2026-11-06",
  S.latestSessionEndDate([
    { startsAt: "2026-11-06T06:00:00+00:00", endsAt: "2026-11-06T08:00:00+00:00" },
  ]),
  "2026-11-06",
);
check(
  "多場取最晚（池上兩梯 10/23–10/25、10/25–10/27）",
  S.latestSessionEndDate([
    { startsAt: "2026-10-25T06:00:00+00:00", endsAt: "2026-10-27T04:00:00+00:00" },
    { startsAt: "2026-10-23T06:00:00+00:00", endsAt: "2026-10-25T04:00:00+00:00" },
  ]),
  "2026-10-27",
);
check(
  "以台北日期算：UTC 10/31 17:00 = 台北 11/1 01:00",
  S.latestSessionEndDate([{ startsAt: "2026-10-31T15:00:00Z", endsAt: "2026-10-31T17:00:00Z" }]),
  "2026-11-01",
);
check(
  "ends_at 沒填 → 退回 starts_at",
  S.latestSessionEndDate([{ startsAt: "2026-11-06T06:00:00Z", endsAt: null }]),
  "2026-11-06",
);
check("讀不懂的時間略過", S.latestSessionEndDate([{ startsAt: "nope", endsAt: "" }]), null);

console.log("\n[2] isEventPast");
check(
  "iso_date 已過、但有未來場次 → 報名中（《海的聲音》修資料前的狀態）",
  S.isEventPast({ isoDate: "2026-10-20", lastSessionDate: "2026-11-06" }, TODAY),
  false,
);
check(
  "場次就在今天 → 報名中",
  S.isEventPast({ isoDate: "2026-10-01", lastSessionDate: TODAY }, TODAY),
  false,
);
check(
  "iso_date 與場次都過了 → 已結束",
  S.isEventPast({ isoDate: "2026-09-22", lastSessionDate: "2026-09-22" }, TODAY),
  true,
);
check(
  "沒有場次 → 舊規則：iso_date 昨天 → 已結束",
  S.isEventPast({ isoDate: "2026-10-20", lastSessionDate: null }, TODAY),
  true,
);
check(
  "沒有場次 → 舊規則：iso_date 今天 → 報名中",
  S.isEventPast({ isoDate: TODAY, lastSessionDate: null }, TODAY),
  false,
);
check("沒有 lastSessionDate 欄位也照舊規則", S.isEventPast({ isoDate: "2026-10-20" }, TODAY), true);
check(
  "場次早於 iso_date 不會讓活動提早結束",
  S.isEventPast({ isoDate: "2026-11-30", lastSessionDate: "2026-10-01" }, TODAY),
  false,
);
check(
  "iso_date null → 不算結束（即使場次都過了）",
  S.isEventPast({ isoDate: null, lastSessionDate: "2026-01-01" }, TODAY),
  false,
);
check("isPastEvent 舊介面不變", S.isPastEvent("2026-10-20", TODAY), true);

console.log("\n[3] 呼叫端");
const cms = readFile("src/lib/cms.ts");
const fetchAll = cms.slice(cms.indexOf("async function fetchAllEventRows"));
check(
  "fetchAllEventRows 回傳前補 lastSessionDate",
  fetchAll.slice(0, fetchAll.indexOf("\n}\n")).includes("attachLastSessionDates(mapped)"),
  true,
);
check(
  "lastSessionDate 用售票商品 slug 一次 embed 場次查回來",
  /select\("products", "slug,event_sessions\(starts_at,ends_at\)"/.test(cms),
  true,
);
for (const [rel, label] of [
  ["src/routes/events.index.tsx", "/events"],
  ["src/routes/index.tsx", "首頁精選活動"],
]) {
  const src = readFile(rel);
  check(`${label} 用 isEventPast(e)`, src.includes("isEventPast(e)"), true);
  check(
    `${label} 不再直接用 isPastEvent(e.isoDate)`,
    src.includes("isPastEvent(e.isoDate)"),
    false,
  );
}

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
