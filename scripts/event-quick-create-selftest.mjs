#!/usr/bin/env node
/**
 * event-quick-create-selftest.mjs —— 「一頁新增活動」的自檢
 *
 *   [純函式] 直接 import src/lib/admin/event-quick-create.ts（Node 原生型別剝離，需
 *            Node ≥ 22.18；CI 是 24），驗的是 production 真正用的那一份：
 *              · 台北時間 → timestamptz（寫死 +08:00，與執行環境時區無關）
 *              · 顯示日期／iso_date／場次名稱的格式
 *              · 網址代稱（日期為底、撞號加 -2、不從中文標題產生）
 *              · 摘要擷取
 *              · 驗證（結束晚於開始、價格 ≥ 0、站內報名至少一場…）
 *              · payload：免費／付費／外部連結三種各自建出什麼
 *
 *   [靜態] 讀原始碼，守設計不變量：
 *              · server fn 掛 adminFnMiddleware
 *              · 寫入端只呼叫既有三支 repo，不自己 .from(...) 寫表、不碰 seats_taken／units_taken
 *              · 先存草稿、最後才發布；失敗會清掉這一次建立的列
 *              · 元件不用 toLocaleString（React #418）
 *              · /admin/events/new 真的接到這一頁，列表的「新增」仍然連到 id=new
 *
 * 不碰任何資料庫。
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/event-quick-create-selftest.mjs";

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
const checkTrue = (label, v) => check(label, Boolean(v), true);
const checkFalse = (label, v) => check(label, Boolean(v), false);

/** 讀原始碼。檔案不存在＝丟例外，不是回空字串（run-selftests.mjs 守門 4）。 */
function readFile(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`selftest 讀不到檔案：${rel}`);
  return readFileSync(abs, "utf8");
}

/** 拿掉 TS 註解，免得註解裡提到的字串讓斷言假性通過。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

const lib = await import(pathToFileURL(join(ROOT, "src/lib/admin/event-quick-create.ts")).href);
const {
  DEFAULT_LOCATION,
  buildJourneyCard,
  buildQuickCreatePlan,
  deriveDisplayDate,
  deriveIsoDate,
  deriveJourneyDays,
  deriveSummary,
  initialQuickCreate,
  normalizeForSubmit,
  pickUniqueSlug,
  sessionTitleFor,
  slugBaseFor,
  stringsToTranslate,
  taipeiLocalToIso,
  validateQuickCreate,
} = lib;

const S = (date, start, end, extra = {}) => ({
  date,
  start,
  end,
  end_date: "",
  location: DEFAULT_LOCATION.zh,
  capacity: 30,
  ...extra,
});

// =============================================================================
console.log("\n[1] 台北時間 → timestamptz");
check("14:00 台北 = 06:00Z", taipeiLocalToIso("2026-11-06", "14:00"), "2026-11-06T06:00:00.000Z");
check(
  "早上 07:30 台北 = 前一天 23:30Z",
  taipeiLocalToIso("2026-11-06", "07:30"),
  "2026-11-05T23:30:00.000Z",
);
check(
  "午夜 00:00 台北 = 前一天 16:00Z",
  taipeiLocalToIso("2027-01-01", "00:00"),
  "2026-12-31T16:00:00.000Z",
);
{
  let threw = false;
  try {
    taipeiLocalToIso("2026-02-30", "10:00");
  } catch {
    threw = true;
  }
  checkTrue("不存在的日期（2/30）丟錯，不會悄悄滾到 3/2", threw);
}
{
  const prevTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  check(
    "執行環境時區改成洛杉磯，結果不變（不讀執行環境時區）",
    taipeiLocalToIso("2026-11-06", "14:00"),
    "2026-11-06T06:00:00.000Z",
  );
  process.env.TZ = prevTz;
}

// =============================================================================
console.log("\n[2] 顯示日期 / iso_date / 場次名稱");
check(
  "一場：2026.09.22 (二) 13:30–15:30（與正式庫既有格式一致）",
  deriveDisplayDate([S("2026-09-22", "13:30", "15:30")]),
  "2026.09.22 (二) 13:30–15:30",
);
check(
  "同一天兩場：列開始時間",
  deriveDisplayDate([S("2026-11-07", "14:00", "16:00"), S("2026-11-07", "10:00", "12:00")]),
  "2026.11.07 (六) 10:00、14:00",
);
check(
  "跨好幾天（亂序輸入）：首日~末日",
  deriveDisplayDate([S("2026-11-07", "10:00", "12:00"), S("2026-10-20", "10:00", "12:00")]),
  "2026.10.20 (二)~11.07 (六)",
);
check(
  "跨年：末日印完整年份",
  deriveDisplayDate([S("2026-12-30", "10:00", "12:00"), S("2027-01-02", "10:00", "12:00")]),
  "2026.12.30 (三)~2027.01.02 (六)",
);
check("沒有場次：即將公告", deriveDisplayDate([]), "即將公告");
check(
  "iso_date 取最後一場（第二梯還沒辦之前不會被判成已結束）",
  deriveIsoDate([S("2026-10-20", "10:00", "12:00"), S("2026-11-07", "10:00", "12:00")]),
  "2026-11-07",
);
check("沒有場次的 iso_date 是 null", deriveIsoDate([]), null);
check("場次名稱三語", sessionTitleFor(S("2026-09-05", "10:00", "12:00")), {
  zh: "2026.09.05（六）10:00–12:00",
  en: "Sat 5 Sep 2026, 10:00–12:00",
  ja: "2026年9月5日（土）10:00–12:00",
});

// =============================================================================
console.log("\n[3] 網址代稱與摘要");
check(
  "代稱底＝第一場日期",
  slugBaseFor([S("2026-11-07", "10:00", "12:00"), S("2026-11-06", "10:00", "12:00")], "2026-10-20"),
  "20261106",
);
check("沒有場次就用今天（台北）", slugBaseFor([], "2026-10-20"), "20261020");
check("沒撞號就用原樣", pickUniqueSlug("20261106", ["20261105"]), "20261106");
check("撞號加 -2", pickUniqueSlug("20261106", ["20261106"]), "20261106-2");
check(
  "-2 也被用了就 -3（大小寫不分）",
  pickUniqueSlug("20261106", ["20261106", "20261106-2"]),
  "20261106-3",
);
checkTrue(
  "代稱符合 eventSchema 的規則（英數字開頭）",
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pickUniqueSlug("20261106", ["20261106"])),
);
check("摘要＝第一段", deriveSummary("\n  第一段。\n\n第二段。"), "第一段。");
check("摘要超過 120 字截斷加…", [...deriveSummary("字".repeat(300))].length, 120);

// =============================================================================
console.log("\n[4] 驗證");
const ok = {
  ...initialQuickCreate(),
  title: "測試活動",
  category: "好書交流",
  description: "簡介",
  sessions: [S("2026-11-06", "14:00", "16:00")],
  plans: [{ name: "一般票", price: 300 }],
};
check("合法的付費表單沒有錯誤", validateQuickCreate(ok), {});
check(
  "預設值：付費、一個場次（名額 30、預設地點）、一般票、立即發布",
  {
    mode: initialQuickCreate().mode,
    sessions: initialQuickCreate().sessions.length,
    cap: initialQuickCreate().sessions[0].capacity,
    loc: initialQuickCreate().sessions[0].location,
    plan: initialQuickCreate().plans[0].name,
    publish: initialQuickCreate().publish,
  },
  { mode: "paid", sessions: 1, cap: 30, loc: DEFAULT_LOCATION.zh, plan: "一般票", publish: true },
);
{
  const e = validateQuickCreate({ ...ok, title: " ", category: "", description: "" });
  checkTrue("必填：名稱", e.title);
  checkTrue("必填：分類", e.category);
  checkTrue("必填：簡介", e.description);
}
check(
  "結束不晚於開始 → sessions.0.end",
  validateQuickCreate({ ...ok, sessions: [S("2026-11-06", "16:00", "16:00")] })["sessions.0.end"],
  "結束時間要晚於開始時間",
);
checkTrue(
  "價格負數 → plans.0.price",
  validateQuickCreate({ ...ok, plans: [{ name: "一般票", price: -1 }] })["plans.0.price"],
);
checkTrue(
  "價格小數 → plans.0.price",
  validateQuickCreate({ ...ok, plans: [{ name: "一般票", price: 1.5 }] })["plans.0.price"],
);
check(
  "價格 0 是合法的（price ≥ 0）",
  validateQuickCreate({ ...ok, plans: [{ name: "一般票", price: 0 }] }),
  {},
);
checkTrue(
  "預設票價是空白（忘了填會被擋），不是 0",
  validateQuickCreate({ ...ok, plans: initialQuickCreate().plans })["plans.0.price"],
);
checkTrue("站內報名沒有場次 → sessions", validateQuickCreate({ ...ok, sessions: [] }).sessions);
checkTrue("付費沒有票種 → plans", validateQuickCreate({ ...ok, plans: [] }).plans);
checkTrue(
  "票種名稱重複",
  validateQuickCreate({
    ...ok,
    plans: [
      { name: "一般票", price: 1 },
      { name: "一般票", price: 2 },
    ],
  })["plans.1.name"],
);
checkTrue(
  "名額 0 不行",
  validateQuickCreate({ ...ok, sessions: [S("2026-11-06", "14:00", "16:00", { capacity: 0 })] })[
    "sessions.0.capacity"
  ],
);
checkTrue(
  "名額空白（NaN）不行",
  validateQuickCreate({ ...ok, sessions: [S("2026-11-06", "14:00", "16:00", { capacity: NaN })] })[
    "sessions.0.capacity"
  ],
);
check(
  "外部連結可以沒有場次，但要有網址",
  Object.keys(validateQuickCreate({ ...ok, mode: "external", sessions: [], external_url: "" })),
  ["external_url"],
);
check(
  "外部連結不檢查地點／名額",
  validateQuickCreate({
    ...ok,
    mode: "external",
    external_url: "https://forms.gle/abc",
    sessions: [S("2026-11-06", "14:00", "16:00", { location: "", capacity: NaN })],
  }),
  {},
);

// =============================================================================
console.log("\n[5] payload");
const tr = new Map([["測試活動", { en: "Test Event", ja: "テストイベント" }]]);
{
  const plan = buildQuickCreatePlan(
    {
      ...ok,
      plans: [
        { name: "一般票", price: 300 },
        { name: "學生票", price: 250 },
      ],
      sessions: [S("2026-11-07", "10:00", "12:00"), S("2026-11-06", "14:00", "16:00")],
    },
    { slug: "20261106", sortOrder: 5, translations: tr },
  );
  check(
    "付費：payment_enabled=true、internal",
    [plan.event.payment_enabled, plan.event.registration_type],
    [true, "internal"],
  );
  check("付費：商品價格＝最低票價", plan.product, { price: 250 });
  check(
    "付費：票種兩個、每張佔 1 位、sort_order 從 1",
    plan.plans.map((p) => [p.price, p.seats_per_unit, p.sort_order]),
    [
      [300, 1, 1],
      [250, 1, 2],
    ],
  );
  check(
    "場次依時間排序、轉成 UTC",
    plan.sessions.map((s) => s.starts_at),
    ["2026-11-06T06:00:00.000Z", "2026-11-07T02:00:00.000Z"],
  );
  check("預設地點用寫死的三語", plan.sessions[0].location, DEFAULT_LOCATION);
  check("有翻譯就用翻譯", plan.event.title, {
    zh: "測試活動",
    en: "Test Event",
    ja: "テストイベント",
  });
  check("沒翻譯的用中文頂上（三語都非空）", plan.event.description, {
    zh: "簡介",
    en: "簡介",
    ja: "簡介",
  });
  check(
    "顯示日期與 iso_date 從場次來",
    [plan.event.display_date, plan.event.iso_date],
    ["2026.11.06 (五)~11.07 (六)", "2026-11-07"],
  );
  check("slug 與排序照傳入", [plan.event.slug, plan.event.sort_order], ["20261106", 5]);
  check("付費時 external_url 是空的", plan.event.external_url, "");
}
{
  const plan = buildQuickCreatePlan(
    { ...ok, mode: "free" },
    { slug: "x", sortOrder: 1, translations: new Map() },
  );
  check(
    "免費：payment_enabled=false、商品 price 0、不建票種",
    [plan.event.payment_enabled, plan.product, plan.plans.length, plan.sessions.length],
    [false, { price: 0 }, 0, 1],
  );
}
{
  const plan = buildQuickCreatePlan(
    { ...ok, mode: "external", external_url: " https://forms.gle/abc " },
    { slug: "x", sortOrder: 1, translations: new Map() },
  );
  check(
    "外部連結：external、不建商品／場次／票種",
    [plan.event.registration_type, plan.product, plan.sessions.length, plan.plans.length],
    ["external", null, 0, 0],
  );
  check("外部連結：網址去頭尾空白", plan.event.external_url, "https://forms.gle/abc");
  check(
    "外部連結：日期仍然拿來產生顯示日期",
    plan.event.display_date,
    "2026.11.06 (五) 14:00–16:00",
  );
}
check(
  "要翻譯的字串：名稱、簡介、摘要、自訂地點、票種名稱（不含預設地點、去重）",
  stringsToTranslate({
    ...ok,
    sessions: [
      S("2026-11-06", "14:00", "16:00"),
      S("2026-11-07", "14:00", "16:00", { location: "台東池上" }),
    ],
  }),
  ["測試活動", "簡介", "台東池上", "一般票"],
);

// =============================================================================
console.log("\n[5b] 策旅：跨日梯次與策旅卡片");
{
  const trip1 = S("2026-10-23", "14:00", "12:00", { end_date: "2026-10-25", capacity: 12 });
  const trip2 = S("2026-10-25", "14:00", "12:00", { end_date: "2026-10-27", capacity: 12 });
  check("跨日梯次的場次名稱（與池上那兩梯同一種讀法）", sessionTitleFor(trip1), {
    zh: "2026.10.23（五）–10.25（日）",
    en: "Fri 23 Oct – Sun 25 Oct 2026",
    ja: "2026年10月23日（金）–10月25日（日）",
  });
  check(
    "跨年的跨日梯次印完整年份",
    sessionTitleFor(S("2026-12-31", "09:00", "18:00", { end_date: "2027-01-02" })).zh,
    "2026.12.31（四）–2027.01.02（六）",
  );
  check(
    "顯示日期畫到最晚的回程日",
    deriveDisplayDate([trip1, trip2]),
    "2026.10.23 (五)~10.27 (二)",
  );
  check("一個跨日梯次也是範圍", deriveDisplayDate([trip1]), "2026.10.23 (五)~10.25 (日)");
  check("iso_date 取最晚的回程日", deriveIsoDate([trip1, trip2]), "2026-10-27");
  const journey = {
    ...initialQuickCreate("journey"),
    title: "測試策旅",
    category: "策旅說明會",
    description: "簡介",
    sessions: [trip1, trip2],
    plans: [{ name: "每人（兩人一房）", price: 21800 }],
  };
  check("回程時間早於出發時間但隔天回程：合法", validateQuickCreate(journey), {});
  check(
    "回程日期早於出發日期 → end_date 錯誤",
    validateQuickCreate({ ...journey, sessions: [{ ...trip1, end_date: "2026-10-22" }] })[
      "sessions.0.end_date"
    ],
    "回程日期不能早於出發日期",
  );
  check(
    "當天來回、回程時間不晚於出發 → end 錯誤",
    validateQuickCreate({ ...journey, sessions: [{ ...trip1, end_date: "2026-10-23" }] })[
      "sessions.0.end"
    ],
    "結束時間要晚於開始時間",
  );
  check(
    "策旅預設：梯次名額 12、集合地點空白（要自己填）",
    [
      initialQuickCreate("journey").sessions[0].capacity,
      initialQuickCreate("journey").sessions[0].location,
    ],
    [12, ""],
  );
  check("幾天幾夜：3天2夜", deriveJourneyDays([trip1]), {
    zh: "3天2夜",
    en: "3 Days, 2 Nights",
    ja: "2泊3日",
  });
  check("當天來回：1 日", deriveJourneyDays([S("2026-10-23", "08:00", "18:00")]).zh, "1 日");
  check("沒有梯次：詳見行程", deriveJourneyDays([]).zh, "詳見行程");

  const plan = buildQuickCreatePlan(journey, {
    slug: "20261023",
    sortOrder: 3,
    translations: new Map(),
  });
  check(
    "梯次的 ends_at 用回程日期（台北 10/25 12:00 = 04:00Z）",
    plan.sessions[0].ends_at,
    "2026-10-25T04:00:00.000Z",
  );
  check(
    "策旅的報名仍是活動商品（internal＋付費）",
    [plan.event.registration_type, plan.event.payment_enabled, plan.product],
    ["internal", true, { price: 21800 }],
  );
  const label = { zh: "策旅說明會", en: "Journey Briefings", ja: "旅の説明会" };
  const card = buildJourneyCard(journey, plan.event, {
    sortOrder: 2,
    translations: new Map(),
    categoryLabel: label,
  });
  check("卡片連到這場活動的頁面", card.external_url, "/events/20261023");
  check(
    "卡片內容與活動共用",
    [card.title, card.summary, card.description],
    [plan.event.title, plan.event.summary, plan.event.description],
  );
  check("卡片主題留空 → 用分類名稱（三語）", card.theme, label);
  check("卡片的幾天幾夜", card.days.zh, "3天2夜");
  check(
    "卡片的報名方式跟著活動",
    [card.registration_type, card.payment_enabled, card.sort_order],
    ["internal", true, 2],
  );
  const card2 = buildJourneyCard({ ...journey, theme: "池上秋收" }, plan.event, {
    sortOrder: 2,
    translations: new Map([["池上秋收", { en: "Chishang Harvest", ja: "池上の収穫" }]]),
    categoryLabel: null,
  });
  check("有填主題就用主題（含翻譯）", card2.theme, {
    zh: "池上秋收",
    en: "Chishang Harvest",
    ja: "池上の収穫",
  });
  const extInput = { ...journey, mode: "external", external_url: "https://forms.gle/x" };
  const extEvent = buildQuickCreatePlan(extInput, {
    slug: "x",
    sortOrder: 1,
    translations: new Map(),
  }).event;
  const ext = buildJourneyCard(extInput, extEvent, {
    sortOrder: 1,
    translations: new Map(),
    categoryLabel: label,
  });
  check(
    "外部連結的策旅：卡片直接連外部網址",
    [ext.external_url, ext.registration_type],
    ["https://forms.gle/x", "external"],
  );
  checkTrue(
    "主題會送去翻譯",
    stringsToTranslate({ ...journey, theme: "池上秋收" }).includes("池上秋收"),
  );
}

// =============================================================================
console.log("\n[6] 靜態：寫入端只走既有那一套");
const fnsSrc = stripTs(readFile("src/lib/admin/fns/events.ts"));
const fnBlock = fnsSrc.slice(fnsSrc.indexOf("export const createEventQuick"));
checkTrue("createEventQuick 存在", fnsSrc.includes("export const createEventQuick"));
checkTrue(
  "🔴 createEventQuick 掛 adminFnMiddleware",
  /createEventQuick = createServerFn\(\{ method: "POST" \}\)\s*\.middleware\(\[adminFnMiddleware\]\)/.test(
    fnBlock,
  ),
);
checkTrue(
  "createEventQuick 有 inputValidator",
  fnBlock.slice(0, 400).includes(".inputValidator(eventQuickCreateSchema)"),
);

const serverSrc = stripTs(readFile("src/server/event-quick-create.ts"));
checkTrue("server-only", serverSrc.includes('import "@tanstack/react-start/server-only"'));
for (const fn of ["upsertEventWithProduct", "upsertEventSession", "upsertEventSessionPlan"]) {
  checkTrue(`呼叫既有的 ${fn}()`, serverSrc.includes(`await ${fn}(`));
}
checkFalse("🔴 不自己 .from(...) 寫任何表", /\.from\(/.test(serverSrc));
checkFalse("🔴 不自己 .rpc(...)", /\.rpc\(/.test(serverSrc));
checkFalse("🔴 不碰 seats_taken", serverSrc.includes("seats_taken"));
checkFalse("🔴 不碰 units_taken", serverSrc.includes("units_taken"));
checkTrue("寫入前在 server 端再驗一次", serverSrc.includes("validateQuickCreate(input)"));
{
  const firstWrite = serverSrc.indexOf("await upsertEventWithProduct(");
  const draftFlag = serverSrc.indexOf("is_published: false", firstWrite);
  const publishWrite = serverSrc.indexOf("is_published: true");
  const sessionWrite = serverSrc.indexOf("await upsertEventSession(");
  checkTrue(
    "第一次寫入是草稿（is_published: false）",
    firstWrite >= 0 && draftFlag > firstWrite && draftFlag < sessionWrite,
  );
  checkTrue("發布（is_published: true）排在建場次之後", publishWrite > sessionWrite);
  checkTrue("草稿時商品是 draft", /status: "draft"/.test(serverSrc));
}
checkTrue("失敗時刪掉這一次建立的場次", serverSrc.includes("await removeEventSession(id)"));
checkTrue("失敗時刪掉這一次建立的商品", serverSrc.includes("await removeProduct(productId)"));
checkTrue("失敗時刪掉這一次建立的活動", serverSrc.includes("await removeEvent(eventId)"));
checkTrue("策旅卡片走既有的 upsertJourney()", serverSrc.includes("await upsertJourney("));
checkTrue("失敗時刪掉這一次建立的策旅卡片", serverSrc.includes("await removeJourney(journeyId)"));
{
  const cardDraft = serverSrc.indexOf("is_published: false });");
  const cardPublish = serverSrc.indexOf("id: journeyId, is_published: true");
  checkTrue("策旅卡片先存草稿、發布排在最後", cardDraft > 0 && cardPublish > cardDraft);
}

// =============================================================================
console.log("\n[7] 靜態：畫面");
const uiSrc = stripTs(readFile("src/components/admin/EventQuickCreate.tsx"));
checkFalse("🔴 元件不用 toLocaleString（React #418）", uiSrc.includes("toLocaleString"));
checkFalse("元件不靜態匯入 schemas.ts（訪客 bundle 洩漏）", uiSrc.includes("@/lib/admin/schemas"));
checkTrue("送出走動態匯入的 server fn", uiSrc.includes('await import("@/lib/admin/fns/events")'));
checkTrue("前端用同一支 validateQuickCreate", uiSrc.includes("validateQuickCreate(payload)"));
checkTrue("封面圖沿用 ImageField", uiSrc.includes("<ImageField"));
checkTrue("封面圖提示建議橫式 4:3", uiSrc.includes("建議橫式 4:3"));
for (const link of [
  "查看前台頁面",
  "進階編輯（組裝器）",
  "回活動列表",
  "再加一個場次",
  "再加一個票種",
]) {
  checkTrue(`畫面上有「${link}」`, uiSrc.includes(link));
}
const routeSrc = stripTs(readFile("src/routes/admin/_shell.events.$id.tsx"));
checkTrue("/admin/events/new 接到一頁新增", /if \(isNew\) return <EventQuickCreate/.test(routeSrc));
checkTrue("既有活動仍然是組裝器", routeSrc.includes("return <AdminEventAssemblerPage />"));
checkTrue(
  "列表的「新增」仍然連到 id=new",
  readFile("src/routes/admin/_shell.events.tsx").includes('params={{ id: "new" }}'),
);

console.log("\n[7b] 送出前整理：藏起來的欄位不帶無效值");
{
  const { eventQuickCreateSchema } = await import(
    pathToFileURL(join(ROOT, "src/lib/admin/schemas.ts")).href
  );
  const freeForm = {
    ...initialQuickCreate(),
    title: "t",
    category: "c",
    description: "d",
    mode: "free",
    sessions: [S("2026-11-06", "14:00", "16:00")],
  };
  checkFalse(
    "預設的空白票價（NaN）原樣送出會被 server 的 zod 擋下",
    eventQuickCreateSchema.safeParse(freeForm).success,
  );
  const n = normalizeForSubmit(freeForm);
  check("免費：票種清空", n.plans, []);
  checkTrue("免費：整理後通過 server 的 zod", eventQuickCreateSchema.safeParse(n).success);
  const extForm = {
    ...freeForm,
    mode: "external",
    external_url: "https://forms.gle/x",
    sessions: [S("2026-11-06", "14:00", "16:00", { capacity: NaN })],
  };
  const ne = normalizeForSubmit(extForm);
  check("外部連結：藏起來的名額空白 → 預設值", ne.sessions[0].capacity, 30);
  checkTrue("外部連結：整理後通過 server 的 zod", eventQuickCreateSchema.safeParse(ne).success);
  check(
    "付費：票種原樣保留",
    normalizeForSubmit({ ...freeForm, mode: "paid", plans: [{ name: "a", price: 5 }] }).plans,
    [{ name: "a", price: 5 }],
  );
  check(
    "非外部連結：external_url 清空",
    normalizeForSubmit({ ...freeForm, external_url: "https://x.y" }).external_url,
    "",
  );
  checkTrue(
    "元件送出前呼叫 normalizeForSubmit",
    uiSrc.includes("normalizeForSubmit(values)") &&
      uiSrc.includes("createEventQuick({ data: payload })"),
  );
}

console.log("\n[8] 策旅：同一個元件、同一支寫入");
const journeyRoute = stripTs(readFile("src/routes/admin/_shell.journeys_.new.tsx"));
checkTrue(
  "/admin/journeys/new 路由存在",
  journeyRoute.includes('createFileRoute("/admin/_shell/journeys_/new")'),
);
checkTrue(
  "🔴 策旅用同一個元件（kind=journey），沒有另寫一份表單",
  journeyRoute.includes('<EventQuickCreate kind="journey"'),
);
checkTrue(
  "策旅 loader 動態匯入 fns",
  journeyRoute.includes('await import("@/lib/admin/fns/event-categories")'),
);
const journeysList = stripTs(readFile("src/routes/admin/_shell.journeys.tsx"));
checkTrue("策旅列表的「新增策旅」連到一頁新增", journeysList.includes('to="/admin/journeys/new"'));
// 2026-10-25 編輯從 Dialog（openEdit）改成內頁 /admin/journeys/$id：不變量仍是「列表保留編輯」。
checkTrue(
  "策旅列表仍保留編輯（連到 /admin/journeys/$id 內頁）",
  journeysList.includes('to="/admin/journeys/$id"') &&
    existsSync(join(ROOT, "src/routes/admin/_shell.journeys_.$id.tsx")),
);
checkTrue(
  "元件以 kind 切換文案（COPY.event／COPY.journey）",
  /COPY = \{\s*event:/.test(uiSrc) && uiSrc.includes("journey: {"),
);
checkTrue("策旅有回程日期欄位", uiSrc.includes('label="回程日期"'));
checkTrue(
  "routeTree 有 /admin/journeys/new",
  readFile("src/routeTree.gen.ts").includes("'/admin/journeys/new'"),
);

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
