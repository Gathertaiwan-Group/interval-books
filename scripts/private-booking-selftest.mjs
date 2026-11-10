#!/usr/bin/env node
/**
 * private-booking-selftest.mjs —— 「包場（不開放報名）」（src/lib/private-booking.ts）
 *
 *   [1] 旗標：events.notes 上的保留 key `private_booking`；讀、寫、拿掉都只認 === true
 *   [2] 🔴 不可購買：結帳第二道門 ticketSellable(sellableEventStatus(...)) 拒絕包場；
 *       priceLines 真的讀 notes、真的經過 sellableEventStatus
 *   [3] 文案：三語的「包場」與「本場為包場活動，不開放對外報名。」
 *   [4] 月曆：包場的場次有正確時間（不是全天）、不標額滿、標包場
 *   [5] 列表／首頁卡片：listingFactsForCard 蓋掉票價與「額滿／最後 N 位」，ListingBadge 印「包場」
 *   [6] 活動頁：包場分支在報名面板之前、沒有任何 /checkout 入口
 *   [7] 寫入：repo 合併 notes（不洗掉注意事項／不洗掉旗標）、後台與 MCP 都接上；
 *       server 讀場次只回 live 且是包場的活動
 *   [8] 策旅主題留空：不再拿分類名稱補；卡片只印天數
 *
 * 不碰資料庫（@/lib/supabase 換成 null 的替身）。
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/private-booking-selftest.mjs";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@/lib/supabase") {
      return { url: "data:text/javascript,export const supabase = null;", shortCircuit: true };
    }
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
const checkTrue = (name, v) => check(name, Boolean(v), true);
const readFile = (rel) => readFileSync(join(ROOT, rel), "utf8");
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const pb = await imp("src/lib/private-booking.ts");
const ls = await imp("src/lib/listing-status.ts");
const cal = await imp("src/lib/events-calendar.ts");
const hl = await imp("src/lib/home-listing.ts");
const je = await imp("src/lib/journey-events.ts");

// ── [1] 旗標 ────────────────────────────────────────────────────────────
console.log("\n[1] 旗標（events.notes 的保留 key）");
const EMPTY = { zh: [], en: [], ja: [] };
check("保留 key 名稱", pb.PRIVATE_BOOKING_KEY, "private_booking");
check("空清單 → 不是包場", pb.isPrivateBooking(EMPTY), false);
check(
  "private_booking: true → 包場",
  pb.isPrivateBooking({ ...EMPTY, private_booking: true }),
  true,
);
check(
  "只認 true（字串 'true' 不算）",
  pb.isPrivateBooking({ ...EMPTY, private_booking: "true" }),
  false,
);
check(
  "null／陣列 → 不是包場",
  [pb.isPrivateBooking(null), pb.isPrivateBooking([])],
  [false, false],
);
check(
  "withPrivateBooking(true) 保留注意事項＋加旗標",
  pb.withPrivateBooking({ zh: ["a"], en: ["b"], ja: ["c"] }, true),
  { zh: ["a"], en: ["b"], ja: ["c"], private_booking: true },
);
check(
  "withPrivateBooking(false) 拿掉旗標（整個 key 不放）",
  pb.withPrivateBooking({ zh: ["a"], en: [], ja: [], private_booking: true }, false),
  { zh: ["a"], en: [], ja: [] },
);
check("壞形狀 → 三個空陣列", pb.stripPrivateBooking("x"), EMPTY);
// 與 0027 的 CHECK（is_localized_list）相容：zh/en/ja 都是字串陣列，多一個 key 不違規。
const withFlag = pb.withPrivateBooking(EMPTY, true);
checkTrue(
  "寫進去的值仍是 {zh,en,ja} 字串陣列（is_localized_list 允許多一個 key）",
  ["zh", "en", "ja"].every((k) => Array.isArray(withFlag[k])),
);
const mig27 = readFile("supabase/migrations/0027_event_blocks.sql");
checkTrue(
  "is_localized_list() 只檢查 zh/en/ja，不禁止多的 key（所以不需要 migration）",
  /coalesce\(jsonb_typeof\(v -> 'ja'\), ''\) <> 'array'/.test(mig27) &&
    !/jsonb_object_keys/.test(mig27),
);

// ── [2] 不可購買 ─────────────────────────────────────────────────────────
console.log("\n[2] 🔴 包場活動不可購買");
const tk = (id) => ({ product_type: "event", source_type: "event", source_id: id });
const statuses = new Map([
  ["ev-normal", pb.sellableEventStatus("live", EMPTY)],
  ["ev-private", pb.sellableEventStatus("live", { ...EMPTY, private_booking: true })],
]);
check("一般上架活動 → 可以賣", ls.ticketSellable(tk("ev-normal"), statuses), true);
check("🔴 包場（即使上架）→ 不能賣", ls.ticketSellable(tk("ev-private"), statuses), false);
check("包場的狀態字不是 live", pb.sellableEventStatus("live", withFlag) !== "live", true);
const orders = readFile("src/server/repos/orders.ts");
checkTrue(
  "🔴 priceLines 讀 events.notes 並經過 sellableEventStatus",
  /\.select\("id, status, notes"\)/.test(orders) &&
    orders.includes("eventStatusById.set(e.id, sellableEventStatus(e.status, e.notes))"),
);
checkTrue(
  "第二道門在場次檢查之前（場次 closed → reserve_session_seat 仍是第一道）",
  orders.indexOf("if (!ticketSellable(p, eventStatusById))") > 0 &&
    orders.indexOf("if (!ticketSellable(p, eventStatusById))") <
      orders.indexOf("if (w.sessionId === null)"),
);

// ── [3] 文案 ────────────────────────────────────────────────────────────
console.log("\n[3] 文案（三語）");
check("報名區文案", pb.PRIVATE_BOOKING_COPY.notice, {
  zh: "本場為包場活動，不開放對外報名。",
  en: "This is a private event and is not open to public registration.",
  ja: "本イベントは貸切のため、一般のお申し込みは受け付けておりません。",
});
check("標籤", pb.PRIVATE_BOOKING_COPY.badge, { zh: "包場", en: "Private event", ja: "貸切" });

// ── [4] 月曆 ────────────────────────────────────────────────────────────
console.log("\n[4] 月曆：時間正確、不是全天、不是額滿");
const L = (zh) => ({ zh, en: zh, ja: zh });
const NOW = Date.parse("2026-11-10T04:00:00Z");
const entries = cal.buildCalendarEntries({
  events: [
    {
      slug: "muzha-tea-1117",
      title: L("留一段小時光｜品一盞木柵茶"),
      externalUrl: "",
      isoDate: "2026-11-17",
      privateBooking: true,
    },
    { slug: "normal", title: L("一般"), externalUrl: "", isoDate: "2026-11-18" },
  ],
  sessions: [
    {
      id: "s-private",
      productSlug: "event-muzha-tea-1117",
      title: L("2026.11.17（二）15:30–17:00"),
      location: L("小時光書店"),
      startsAt: "2026-11-17T07:30:00+00:00",
      endsAt: "2026-11-17T09:00:00+00:00",
      // 名額是佔位（capacity=1）——呼叫端就算傳了 full，包場也不標額滿。
      full: true,
    },
    {
      id: "s-normal",
      productSlug: "event-normal",
      title: L("一般場"),
      location: L("小時光書店"),
      startsAt: "2026-11-18T07:30:00+00:00",
      endsAt: null,
      full: true,
    },
  ],
  journeyUrls: [],
  nowMs: NOW,
});
const p = entries.find((e) => e.slug === "muzha-tea-1117");
check(
  "包場：11/17 15:30–17:00（台北時間），不是全天",
  [p?.startDate, p?.startTime, p?.endTime],
  ["2026-11-17", "15:30", "17:00"],
);
check("包場：不標額滿、標包場", [p?.full, p?.privateBooking], [false, true]);
const n = entries.find((e) => e.slug === "normal");
check("一般活動：額滿照舊、不是包場", [n?.full, n?.privateBooking], [true, false]);
const calData = readFile("src/lib/events-calendar-data.ts");
checkTrue(
  "月曆資料：讀 notes、包場才呼叫 server fn 補場次時間",
  calData.includes('.select("slug,title,external_url,iso_date,notes")') &&
    calData.includes("privateBooking: isPrivateBooking(r.notes)") &&
    /if \(privateSlugs\.length > 0\)[\s\S]*fetchPrivateSessionTimes\(privateSlugs\)/.test(calData),
);
const calUi = readFile("src/components/events/EventsCalendar.tsx");
checkTrue(
  "月曆畫面：格子與議程都畫「包場」",
  (calUi.match(/<Badge tone="ink">\{t\(COPY\.privateBooking\)\}<\/Badge>/g) ?? []).length === 2,
);

// ── [5] 卡片 ────────────────────────────────────────────────────────────
console.log("\n[5] 列表／首頁卡片");
const normalFacts = { price: 0, soldOut: true, fewLeft: null };
check("包場 → 蓋掉票價與額滿", hl.listingFactsForCard({ privateBooking: true }, normalFacts), {
  price: 0,
  soldOut: false,
  fewLeft: null,
  privateBooking: true,
});
check(
  "包場且商品讀不到 → 仍然標包場",
  hl.listingFactsForCard({ privateBooking: true }, undefined)?.privateBooking,
  true,
);
check(
  "一般活動 → 原樣",
  hl.listingFactsForCard({ privateBooking: false }, normalFacts),
  normalFacts,
);
const bits = readFile("src/components/ListingBits.tsx");
checkTrue(
  "ListingBadge：包場先判（在額滿／最後 N 位之前）",
  bits.indexOf("if (facts.privateBooking) return <PrivateBookingBadge />;") > 0 &&
    bits.indexOf("if (facts.privateBooking) return <PrivateBookingBadge />;") <
      bits.indexOf("if (facts.soldOut)"),
);
checkTrue(
  "ListingFooter：包場不印票價",
  bits.includes("const priced = facts && !facts.privateBooking ? facts : undefined;"),
);
const home = readFile("src/routes/index.tsx");
checkTrue(
  "首頁活動卡：badge 與 footer 都走 listingFactsForCard",
  (home.match(/listingFactsForCard\(e, listing\[eventProductSlug\(e\.slug\)\]\)/g) ?? []).length ===
    2,
);
const evIndex = readFile("src/routes/events.index.tsx");
checkTrue(
  "/events 活動卡：標「包場」",
  evIndex.includes("{e.privateBooking ? <PrivateBookingBadge /> : null}"),
);
const cms = readFile("src/lib/cms.ts");
checkTrue(
  "cms：列表與活動頁都讀 notes → privateBooking",
  cms.includes("image_key,sort_order,notes") &&
    (cms.match(/privateBooking: isPrivateBooking\(r\.notes\)/g) ?? []).length === 3,
);

// ── [6] 活動頁 ──────────────────────────────────────────────────────────
console.log("\n[6] 活動頁：沒有任何報名入口");
const page = readFile("src/routes/events.$slug.tsx");
const panelSrc = readFile("src/components/shop/PrivateBookingPanel.tsx");
checkTrue("有 PrivateBookingPanel", panelSrc.length > 100);
checkTrue(
  "🔴 包場面板裡沒有 /checkout、SessionPicker、PlanPicker、QuantityStepper、票價",
  !/\/checkout|<SessionPicker|<PlanPicker|<QuantityStepper|directCheckoutSearch|<Link\b/.test(
    panelSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
  ) &&
    panelSrc.includes("basePrice={null}") &&
    panelSrc.includes("showSeatsRemaining={false}"),
);
checkTrue(
  "面板印「本場為包場活動，不開放對外報名。」、場次標包場",
  panelSrc.includes("t(PRIVATE_BOOKING_COPY.notice)") &&
    /<SessionList[\s\S]*?privateBooking\s/.test(panelSrc),
);
checkTrue(
  "🔴 包場分支排在 RegistrationPanel／已結束之前（包場優先）",
  page.includes("<PrivateBookingPanel") &&
    page.indexOf("{event.privateBooking ? (") > 0 &&
    page.indexOf("{event.privateBooking ? (") < page.indexOf("<RegistrationPanel product="),
);
checkTrue(
  "loader：包場才呼叫 server fn 讀場次時間",
  page.includes("event?.privateBooking ? fetchPrivateSessionTimes([event.slug])"),
);
const picker = readFile("src/components/shop/SessionPicker.tsx");
checkTrue(
  "SessionList：包場的每一場標「包場」，不印名額／額滿（已結束仍優先）",
  /closed\s*\?\s*t\(COPY\.sessionEnded\)\s*:\s*privateBooking\s*\?\s*t\(PRIVATE_BOOKING_COPY\.badge\)/.test(
    picker,
  ),
);

// ── [7] 寫入與讀取 ─────────────────────────────────────────────────────
console.log("\n[7] 寫入（後台／MCP 同一支 RPC）與 server 讀取");
const repo = readFile("src/server/repos/events.ts");
checkTrue(
  "repo：notes 由 withPrivateBooking 合併，缺的一半讀回舊值",
  repo.includes("notesPayload = withPrivateBooking(") &&
    repo.includes("input.private_booking ?? isPrivateBooking(prevNotes)") &&
    repo.includes("...(notesPayload === undefined ? {} : { notes: notesPayload })"),
);
checkTrue(
  "repo：走 admin_upsert_event_with_session（不另寫 events）",
  /upsertEventWithProduct[\s\S]*rpc\("admin_upsert_event_with_session"/.test(repo),
);
const schemas = readFile("src/lib/admin/schemas.ts");
checkTrue(
  "eventSchema 收 private_booking（選填）",
  schemas.includes("private_booking: z.boolean().optional(),"),
);
const admin = readFile("src/routes/admin/_shell.events.$id.tsx");
checkTrue(
  "後台活動編輯頁：有開關、預設值從 notes 讀",
  admin.includes('name="private_booking"') &&
    admin.includes("private_booking: isPrivateBooking(row?.notes)"),
);
const mcp = readFile("src/server/mcp/tools.ts");
checkTrue(
  "MCP update_event：收 private_booking、有帶才送",
  /update_event: z\.object\(\{[\s\S]*?private_booking: z/.test(mcp) &&
    mcp.includes("...(privateBookingArg !== undefined ? { private_booking } : {})") &&
    mcp.includes('args.private_booking === true || args.private_booking === "true"'),
);
const reader = readFile("src/server/private-booking.ts");
checkTrue(
  "🔴 server 讀場次：只有 live、只有包場、不讀名額",
  reader.includes('.eq("status", "live")') &&
    reader.includes("isPrivateBooking(e.notes)") &&
    !/capacity|seats_taken/.test(reader.replace(/\/\*[\s\S]*?\*\//g, "")),
);

// ── [8] 策旅主題 ───────────────────────────────────────────────────────
console.log("\n[8] 策旅主題留空");
check("主題空 → 只印天數", je.journeyKicker("3天2夜", ""), "3天2夜");
check("有主題 → 天數 ／ 主題", je.journeyKicker("3天2夜", "池上秋收"), "3天2夜 ／ 池上秋收");
const qc = readFile("src/lib/admin/event-quick-create.ts");
checkTrue("一頁新增不再拿分類名稱補主題", !/categoryLabel/.test(qc));
checkTrue(
  "server 不再查分類來補主題",
  !/getEventCategoryById/.test(readFile("src/server/event-quick-create.ts")),
);

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
