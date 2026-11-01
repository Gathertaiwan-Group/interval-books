#!/usr/bin/env node
/**
 * 活動頁的報名入口：**場次開始的那一刻就停用，逐場次判斷**（2026-11）。
 *
 * a61488a 讓結帳伺服器、資料庫、結帳頁、購物車都依 isSessionClosedForBooking()
 * （src/lib/event-status.ts）擋下已開始的場次；但活動頁的場次選擇器與著陸頁報名區
 * 仍用「以日為單位」的 isEventEnded()，當天開始後按鈕還在，客人點進結帳頁才看到
 * 「已結束」。這支守的是頁面那一側：
 *
 *   [1] 邊界：開始前 1 秒可報名、開始當秒不可（同一條 isSessionClosedForBooking）
 *   [2] direct-checkout 的活動頁 helper：全部已開始 / 全部未開始 / 混合場次
 *   [3] 真的渲染 SessionPicker / SessionList（esbuild 打包產線元件，不是讀字串）：
 *       已開始的那一場 disabled、標「已結束」、不印尚餘名額；其他場次照常
 *   [4] useBookingNow：SSR 輸出用 loader 帶下來的時間（不是 Date.now()），
 *       與 hydrate 第一次 render 同一個值；計時器排在下一個 starts_at
 *   [5] 結構：頁面上每一個選場次／報名的地方都接上同一條規則，沒有第二套判斷
 *
 * 執行：node scripts/session-start-booking-selftest.mjs（npm test 會跑）
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/session-start-booking-selftest.mjs";

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
const checkTrue = (name, cond) => check(name, Boolean(cond), true);
function readFile(rel) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  if (!src) throw new Error(`${rel} 讀到空字串`);
  return src;
}

// cart.ts（direct-checkout 的相依）在模組初始化時就拿 localStorage。
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// ── 打包產線模組 ──────────────────────────────────────────────────────────
// supabase.ts 在 import 當下讀 import.meta.env（Vite 的東西），換成空殼；它是建立連線的
// 模組，不是任何一條被測邏輯（[5] 守著被測的檔案沒有自己 import supabase）。
let mod = null;
let buildErr = null;
try {
  const { build } = await import("esbuild");
  const cacheDir = join(ROOT, "node_modules/.cache/session-start-booking-selftest");
  mkdirSync(cacheDir, { recursive: true });
  const outfile = join(cacheDir, "bundle.mjs");
  const supabasePath = join(ROOT, "src/lib/supabase.ts");
  await build({
    stdin: {
      contents: `
        import { renderToStaticMarkup } from "react-dom/server";
        import { LanguageProvider } from "@/i18n/LanguageContext";
        import { SessionPicker, SessionList, EventEndedNotice } from "@/components/shop/SessionPicker";
        import { SEATS_LEFT_LABEL } from "@/components/shop/labels";
        import { isSessionClosedForBooking } from "@/lib/event-status";
        import {
          directAnySeatsLeft, directBookingClosed, directOpenProduct,
          directSelectedSession, directSoleSession,
        } from "@/lib/direct-checkout";
        import {
          useBookingNow, nextBookingCutoff, bookingTimerDelay, bookingClockOffset,
          MAX_TIMER_DELAY_MS,
        } from "@/hooks/use-booking-now";
        export const render = (node) =>
          renderToStaticMarkup(<LanguageProvider>{node}</LanguageProvider>);
        export function Probe({ loadedAt, sessions }) {
          const now = useBookingNow(loadedAt, sessions);
          return <span data-now={String(now)} />;
        }
        export {
          SessionPicker, SessionList, EventEndedNotice, SEATS_LEFT_LABEL,
          isSessionClosedForBooking, directAnySeatsLeft, directBookingClosed,
          directOpenProduct, directSelectedSession, directSoleSession,
          useBookingNow, nextBookingCutoff, bookingTimerDelay, bookingClockOffset,
          MAX_TIMER_DELAY_MS,
        };`,
      resolveDir: ROOT,
      loader: "tsx",
      sourcefile: "session-start-booking-selftest-entry.tsx",
    },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    target: "node22",
    logLevel: "silent",
    absWorkingDir: ROOT,
    alias: { "@": join(ROOT, "src") },
    define: { "process.env.NODE_ENV": '"production"' },
    external: ["react", "react-dom", "react/jsx-runtime", "react-dom/server"],
    plugins: [
      {
        name: "stub-supabase",
        setup(b) {
          b.onLoad({ filter: /src[\\/]lib[\\/]supabase\.ts$/ }, (args) =>
            args.path === supabasePath
              ? {
                  contents:
                    "export const supabase = null;\nexport const isSupabaseConfigured = false;\n",
                  loader: "ts",
                }
              : undefined,
          );
        },
      },
    ],
  });
  mod = await import(pathToFileURL(outfile).href);
} catch (err) {
  buildErr = err;
}
checkTrue("🔴 產線模組打包＋載入得起來（打不起來是紅，不是 skip）", mod !== null);
if (buildErr) console.log(red(`    ${String(buildErr).slice(0, 600)}`));
if (!mod) {
  console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
  process.exit(1);
}
const { createElement: h } = await import("react");

// ── 假資料：時間全部相對一個固定的 T，不依賴跑測試的那一刻 ──────────────────────
const T = Date.parse("2026-11-06T06:00:00.000Z"); // 台北 11/6 14:00（海的聲音那一場）
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600_000;
const mkSession = (id, startsAt, capacity = 20, seatsTaken = 3) => ({
  id,
  productId: "p-sessions",
  title: { zh: `場次${id}`, en: `Sitting ${id}`, ja: `回${id}` },
  location: { zh: "店內", en: "In store", ja: "店内" },
  startsAt,
  endsAt: null,
  capacity,
  seatsTaken,
  sortOrder: 0,
  plans: [],
});
const mkProduct = (sessions) => ({
  id: "p-sessions",
  slug: "event-sessions",
  productType: "event",
  title: { zh: "測試活動", en: "Test event", ja: "テスト" },
  summary: { zh: "", en: "", ja: "" },
  description: { zh: "", en: "", ja: "" },
  price: 300,
  compareAtPrice: null,
  imageKey: null,
  stock: null,
  availableCapped: null,
  showSeatsRemaining: true,
  sessions,
});
const EARLY = mkSession("early", iso(T)); // 14:00
const LATE = mkSession("late", iso(T + 4 * HOUR)); // 18:00
const MIXED = mkProduct([EARLY, LATE]);
const SOLO = mkProduct([mkSession("solo", iso(T))]);

// ── [1] 邊界 ─────────────────────────────────────────────────────────────
console.log("\n[1] 邊界：開始前 1 秒可報名、開始當秒不可");
check("開始前 1 秒 → 還收報名", mod.isSessionClosedForBooking(EARLY, T - 1000), false);
check("開始前 1 毫秒 → 還收報名", mod.isSessionClosedForBooking(EARLY, T - 1), false);
check("開始當秒（starts_at === now）→ 不收", mod.isSessionClosedForBooking(EARLY, T), true);
check("開始後 → 不收", mod.isSessionClosedForBooking(EARLY, T + 1000), true);

// ── [2] 活動頁 helper ────────────────────────────────────────────────────
console.log("\n[2] direct-checkout 的活動頁 helper（全部／沒有／混合）");
check("全部未開始 → 不算關閉", mod.directBookingClosed(MIXED, T - 1000), false);
check("混合（早場開始、晚場未開始）→ 不算關閉", mod.directBookingClosed(MIXED, T), false);
check("全部已開始 → 關閉", mod.directBookingClosed(MIXED, T + 4 * HOUR), true);
check("唯一一場開始前 1 秒 → 不關閉", mod.directBookingClosed(SOLO, T - 1000), false);
check("唯一一場開始當秒 → 關閉", mod.directBookingClosed(SOLO, T), true);
check(
  "沒有場次 → 不算關閉（那是未公布／額滿的畫面）",
  mod.directBookingClosed(mkProduct([]), T),
  false,
);
check(
  "混合：可報名的只剩晚場",
  mod.directOpenProduct(MIXED, T).sessions.map((s) => s.id),
  ["late"],
);
check("混合：早場不能是選中的場次", mod.directSelectedSession(MIXED, "early", T), null);
check("混合：晚場照常可以選", mod.directSelectedSession(MIXED, "late", T)?.id, "late");
check("早場開始前 1 秒還可以選", mod.directSelectedSession(MIXED, "early", T - 1000)?.id, "early");
check("唯一一場開始前 1 秒 → 預選", mod.directSoleSession(SOLO, T - 1000)?.id, "solo");
check("唯一一場開始當秒 → 不預選", mod.directSoleSession(SOLO, T), null);
const EARLY_OPEN_LATE_FULL = mkProduct([EARLY, mkSession("late-full", iso(T + 4 * HOUR), 5, 5)]);
check(
  "早場有空位但已開始、晚場額滿 → 沒有位子可報（已開始的不算位子）",
  mod.directAnySeatsLeft(EARLY_OPEN_LATE_FULL, T),
  false,
);
check("同一組在早場開始前 → 有位子", mod.directAnySeatsLeft(EARLY_OPEN_LATE_FULL, T - 1000), true);

// ── [3] 真的渲染 ─────────────────────────────────────────────────────────
console.log("\n[3] 渲染 SessionPicker / SessionList");
const seatsLabel = mod.SEATS_LEFT_LABEL.zh;
const picker = (product, now) =>
  mod.render(
    h(mod.SessionPicker, {
      sessions: product.sessions,
      selectedId: null,
      onSelect: () => {},
      showSeatsRemaining: true,
      basePrice: product.price,
      now,
    }),
  );
/** 把 <button>…</button> 依序切出來，回傳每一張卡片的 { disabled, closed, text }。 */
function cards(html, tag = "button") {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "g");
  return [...html.matchAll(re)].map(([, attrs, inner]) => ({
    disabled: /\sdisabled(=|\s|$)/.test(attrs),
    closed: /data-session-closed="true"/.test(attrs),
    text: inner.replace(/<[^>]+>/g, " "),
  }));
}

const before = cards(picker(MIXED, T - 1000));
check("反空殼：開場前畫出兩張場次卡片", before.length, 2);
check(
  "開場前 1 秒：兩場都可以點",
  before.map((c) => c.disabled),
  [false, false],
);
checkTrue("開場前 1 秒：早場印尚餘名額", before[0]?.text.includes(seatsLabel));
check(
  "開場前 1 秒：沒有任何一場標已結束",
  before.some((c) => c.text.includes("已結束")),
  false,
);

const atStart = cards(picker(MIXED, T));
check(
  "🔴 開場當秒：只有早場 disabled，晚場照常",
  atStart.map((c) => c.disabled),
  [true, false],
);
check(
  "開場當秒：早場標記 data-session-closed",
  atStart.map((c) => c.closed),
  [true, false],
);
checkTrue("開場當秒：早場標「已結束」", atStart[0]?.text.includes("已結束"));
check("開場當秒：早場不印尚餘名額", atStart[0]?.text.includes(seatsLabel), false);
checkTrue("開場當秒：晚場照常印尚餘名額", atStart[1]?.text.includes(seatsLabel));
check("開場當秒：晚場沒有標已結束", atStart[1]?.text.includes("已結束"), false);

const allStarted = cards(picker(MIXED, T + 4 * HOUR));
check(
  "兩場都開始了：兩張都 disabled",
  allStarted.map((c) => c.disabled),
  [true, true],
);

// 已開始的場次即使 selectedId 指著它，也不畫成選中。
const selectedClosed = mod.render(
  h(mod.SessionPicker, {
    sessions: SOLO.sessions,
    selectedId: "solo",
    onSelect: () => {},
    showSeatsRemaining: true,
    now: T,
  }),
);
checkTrue("已開始的場次不會畫成 aria-pressed=true", /aria-pressed="false"/.test(selectedClosed));

// SessionList（唯讀清單，額滿與外部報名的分支用）
const listHtml = mod.render(
  h(mod.SessionList, { sessions: MIXED.sessions, showSeatsRemaining: true, now: T }),
);
const listCards = cards(listHtml, "li");
check(
  "SessionList 開場當秒：只有早場標記已結束",
  listCards.map((c) => c.closed),
  [true, false],
);
checkTrue("SessionList 開場當秒：早場文字是已結束", listCards[0]?.text.includes("已結束"));
checkTrue("SessionList 開場當秒：晚場照常印尚餘名額", listCards[1]?.text.includes(seatsLabel));

// 整個活動結束時的畫面：沒有任何通往 /checkout 的連結，按鈕 disabled。
const notice = mod.render(h(mod.EventEndedNotice, { product: MIXED }));
check("EventEndedNotice 沒有 /checkout 連結", /href="\/checkout/.test(notice), false);
checkTrue(
  "EventEndedNotice 按鈕停用、文案「活動已結束」",
  /<button[^>]*disabled[^>]*>活動已結束/.test(notice),
);

// ── [4] useBookingNow ───────────────────────────────────────────────────
console.log("\n[4] useBookingNow：SSR／hydrate 同一個值、計時器排在下一個 starts_at");
const LOADED = T - 5 * 60_000;
const probe = mod.render(h(mod.Probe, { loadedAt: LOADED, sessions: MIXED.sessions }));
check(
  "🔴 第一次 render 回 loader 的時間（不是 Date.now()）——SSR 與 hydrate 一致",
  probe.match(/data-now="(\d+)"/)?.[1],
  String(LOADED),
);
check("下一個截止點：開場前 → 早場", mod.nextBookingCutoff(MIXED.sessions, T - 1000), T);
check(
  "下一個截止點：開場當秒（早場已關）→ 晚場",
  mod.nextBookingCutoff(MIXED.sessions, T),
  T + 4 * HOUR,
);
check(
  "下一個截止點：全部開始 → null（不排計時器）",
  mod.nextBookingCutoff(MIXED.sessions, T + 4 * HOUR),
  null,
);
check("計時器：開場前 1 秒 → 1000ms 後醒來", mod.bookingTimerDelay(MIXED.sessions, T - 1000), 1000);
check(
  "計時器：遠在一個月後 → 只睡 MAX_TIMER_DELAY_MS（避開 setTimeout 溢位）",
  mod.bookingTimerDelay([mkSession("far", iso(T + 30 * 24 * HOUR))], T),
  mod.MAX_TIMER_DELAY_MS,
);
checkTrue("MAX_TIMER_DELAY_MS 小於 setTimeout 上限 2^31-1", mod.MAX_TIMER_DELAY_MS < 2 ** 31 - 1);
check(
  "讀不懂的 startsAt 不排計時器（isSessionClosedForBooking 已當它關閉）",
  mod.nextBookingCutoff([mkSession("bad", "not-a-date")], T),
  null,
);
check("時鐘校正：客人時鐘慢 5 分鐘 → 補 5 分鐘", mod.bookingClockOffset(T, T - 300_000), 300_000);
check(
  "時鐘校正：快取的舊 HTML（loader 時間較早）→ 0，用客人時鐘",
  mod.bookingClockOffset(T - 600_000, T),
  0,
);

// ── [5] 結構：每一個入口都接上同一條規則 ─────────────────────────────────
console.log("\n[5] 結構：頁面入口都走 isSessionClosedForBooking，沒有第二套判斷");
const pickerSrc = readFile("src/components/shop/SessionPicker.tsx");
checkTrue(
  "SessionPicker 用 isSessionClosedForBooking",
  /isSessionClosedForBooking\(session, now\)/.test(pickerSrc),
);
checkTrue("SessionPicker 的 now 是必填（沒有預設值）", /\n  now: number;\n/.test(pickerSrc));
const directSrc = readFile("src/lib/direct-checkout.ts");
check(
  "direct-checkout.ts 不自己 import supabase",
  /from "@\/lib\/supabase"/.test(directSrc),
  false,
);
const hookSrc = readFile("src/hooks/use-booking-now.ts");
checkTrue("hook 初始值是 loadedAt", /useState\(loadedAt\)/.test(hookSrc));
checkTrue("hook 背景分頁回來會重算", /visibilitychange/.test(hookSrc) && /"focus"/.test(hookSrc));

const PAGES = [
  "src/routes/events.$slug.tsx",
  "src/routes/events.kungtung.tsx",
  "src/routes/events.sound-of-the-sea.tsx",
  "src/routes/events.city-salon-0922.tsx",
  "src/routes/shop.$slug.tsx",
];
for (const rel of PAGES) {
  const src = readFile(rel);
  checkTrue(`${rel}：loader 帶 now: Date.now()`, /now: Date\.now\(\)/.test(src));
  checkTrue(`${rel}：用 useBookingNow`, /useBookingNow\(loadedAt,/.test(src));
  checkTrue(`${rel}：用 directBookingClosed 判斷整個活動`, /directBookingClosed\(/.test(src));
  checkTrue(
    `${rel}：選中場次走 directSelectedSession`,
    /directSelectedSession\(product, sessionId, now\)/.test(src),
  );
  // 每一個 <SessionPicker> 都帶 now
  const pickers = src.match(/<SessionPicker\b[\s\S]*?\/>/g) ?? [];
  checkTrue(`${rel}：有 SessionPicker`, pickers.length > 0);
  checkTrue(
    `${rel}：每一個 SessionPicker 都帶 now`,
    pickers.every((p) => /now=\{now\}/.test(p)),
  );
  const lists = src.match(/<SessionList\b[\s\S]*?\/>/g) ?? [];
  checkTrue(
    `${rel}：每一個 SessionList 都帶 now`,
    lists.every((p) => /now=\{now\}/.test(p)),
  );
  check(`${rel}：沒有自己拿 starts_at 跟時間比`, /Date\.parse\([^)]*startsAt/.test(src), false);
  check(
    `${rel}：沒有用 Date.now() 判斷場次（只有 loader 那一處）`,
    (src.match(/Date\.now\(\)/g) ?? []).length,
    1,
  );
}
// 著陸頁英雄區的錨點：全部場次開始後改寫「活動已結束」
for (const [rel, labels] of [
  ["src/routes/events.sound-of-the-sea.tsx", ["立即報名"]],
  ["src/routes/events.city-salon-0922.tsx", ["專屬邀請席位確認", "確認出席 / 預約席位"]],
  ["src/components/kungtung/MainSections.tsx", ["預約旅程", "預約這趟文化旅程"]],
]) {
  const src = readFile(rel);
  for (const label of labels) {
    checkTrue(
      `${rel}：「${label}」在 bookingClosed 時改寫`,
      src.includes(`bookingClosed ? RESERVE_ENDED_LABEL : "${label}"`),
    );
  }
}
const kt = readFile("src/routes/events.kungtung.tsx");
checkTrue(
  "kungtung 手機底部列也改寫",
  /bookingClosed \? RESERVE_ENDED_LABEL : "預約這趟文化旅程"/.test(kt),
);
checkTrue(
  "kungtung 英雄區拿到 bookingClosed",
  /<Hero bookingClosed=\{bookingClosed\} \/>/.test(kt),
);
check(
  "RESERVE_ENDED_LABEL 與 EventEndedNotice 的按鈕同一句",
  existsSync(join(ROOT, "src/components/kungtung/MainSections.tsx")) &&
    /RESERVE_ENDED_LABEL = "活動已結束"/.test(readFile("src/components/kungtung/MainSections.tsx")),
  true,
);

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
