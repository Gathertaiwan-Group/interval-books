#!/usr/bin/env node
/**
 * 活動與策旅的「單一上架狀態」自檢（supabase/migrations/0052_event_listing_status.sql、
 * src/lib/listing-status.ts）。
 *
 *   [1] 對照表與推定規則（遷移時依客人現況推定、狀態 → 票券商品 status）
 *   [2] 報名狀況（報名中／額滿／報名截止／已結束／外部報名）
 *   [3] 結帳第二道門 ticketSellable：草稿、下架、查不到的活動一律不能賣
 *   [4] 卡片 → 活動的判準（與 SQL journey_linked_event_id 同一套）
 *   [5] 靜態：migration（trigger、RPC、權限、推定、對齊）
 *   [6] 靜態：前台讀取都只看上架（列表、首頁、策旅、sitemap、詳情頁、寫死版面的著陸頁）
 *   [7] 靜態：結帳 priceLines 先擋活動狀態；後台不再有分散的開關
 *   [8] MCP：set_event_status（dry_run 預設 true、預覽、寫入、稽核、策旅卡片、孤兒卡片）、
 *       update_event／update_journey 不再收 is_published
 *
 * 真正的交易內測試（三種狀態切換、繞路寫衍生欄位被拉回、商品那一步失敗整筆回滾）在正式庫
 * 用 BEGIN … RAISE 回滾跑過，結果附在 commit 的驗收紀錄；這支是不連資料庫的那一半。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/listing-status-selftest.mjs";
const SRC = join(ROOT, "src");

let pass = 0;
let fail = 0;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
function check(label, actual, expected, hint) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
    if (hint) console.log(red(`      ${hint}`));
  }
}
const checkTrue = (label, v, hint) => check(label, v === true, true, hint);
const checkFalse = (label, v, hint) => check(label, v === true, false, hint);
const readFile = (rel) => readFileSync(join(ROOT, rel), "utf8");

console.log("═══ 單一上架狀態自檢（0052）═══");

if (typeof registerHooks !== "function") {
  console.log(red("  ✗ 這個 Node 沒有 module.registerHooks（需要 ≥ 22.15）"));
  console.log(`##SELFTEST## file=${SELF} pass=0 fail=1`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 替身（只在 [8] 用）：每一支被換掉的函式都經過 globalThis.__mock.call()
// -----------------------------------------------------------------------------
const MOCKED = {
  "@/server/repos/events": ["listEvents", "getEventListingSnapshot", "setEventStatus"],
  "@/server/repos/journeys": ["getJourneyById", "setJourneyStatus", "listJourneys"],
  "@/server/env": ["geminiApiKey"],
  "@/server/supabase-admin": ["supabaseAdmin"],
};
const mockUrl = (names) =>
  `data:text/javascript,${encodeURIComponent(
    names
      .map((n) => `export const ${n} = (...a) => globalThis.__mock.call(${JSON.stringify(n)}, a);`)
      .join("\n"),
  )}`;
function resolveTs(base) {
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand)) return pathToFileURL(cand).href;
  }
  return null;
}
registerHooks({
  resolve(spec, ctx, next) {
    if (MOCKED[spec]) return { url: mockUrl(MOCKED[spec]), shortCircuit: true };
    if (spec.startsWith("@/")) {
      const url = resolveTs(join(SRC, spec.slice(2)));
      if (url) return { url, shortCircuit: true };
    }
    if (spec.startsWith(".") && !/\.[a-zA-Z]+$/.test(spec) && ctx.parentURL) {
      const url = resolveTs(fileURLToPath(new URL(spec, ctx.parentURL)));
      if (url) return { url, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const ls = await import(join(SRC, "lib/listing-status.ts"));
const je = await import(join(SRC, "lib/journey-events.ts"));

// =============================================================================
console.log("\n[1] 對照表與推定規則");
check(
  "狀態 → 票券商品 status（live→active、archived→archived、draft→draft）",
  ["draft", "live", "archived"].map(ls.listingToProductStatus),
  ["draft", "active", "archived"],
);
check(
  "三個狀態、三個中文",
  ls.LISTING_STATUSES.map((s) => ls.LISTING_STATUS_LABEL[s]),
  ["草稿", "上架", "下架"],
);
check(
  "推定：已發布（不論商品）→ live（客人看得到）",
  [
    ls.inferListingStatus(true, "active"),
    ls.inferListingStatus(true, null),
    // 2026-11-02「植生布植生牆」：活動已發布、商品草稿（明顯不一致）→ 上架（業主已用 MCP 發布）
    ls.inferListingStatus(true, "draft"),
  ],
  ["live", "live", "live"],
);
check(
  "推定：未發布 → 商品 archived 才是下架，其他都是草稿",
  [
    ls.inferListingStatus(false, "archived"),
    ls.inferListingStatus(false, "draft"),
    ls.inferListingStatus(false, "active"),
    ls.inferListingStatus(false, null),
  ],
  ["archived", "draft", "draft", "draft"],
);
check(
  "篩選參數：只認三個狀態，其他一律「全部」",
  ["draft", "live", "archived", "x", undefined, 1].map(ls.parseListingFilter),
  ["draft", "live", "archived", "all", "all", "all"],
);

// =============================================================================
console.log("\n[2] 報名狀況（上架中的活動旁邊那行小字）");
const NOW = Date.parse("2026-11-02T04:00:00Z");
const s = (iso, cap, taken, status = "open") => ({
  starts_at: iso,
  ends_at: null,
  capacity: cap,
  seats_taken: taken,
  status,
});
const phase = (rt, iso, sessions) =>
  ls.bookingPhase({ registrationType: rt, isoDate: iso, sessions }, NOW);
check(
  "有位子的未來場次 → 報名中",
  phase("internal", "2026-12-20", [s("2026-12-20T05:00:00Z", 30, 0)]),
  "open",
);
check(
  "未來場次全滿 → 額滿",
  phase("internal", "2026-12-20", [
    s("2026-12-20T05:00:00Z", 30, 30),
    s("2026-12-21T05:00:00Z", 10, 10),
  ]),
  "full",
);
check(
  "一場滿、一場有位 → 報名中",
  phase("internal", "2026-12-20", [
    s("2026-12-20T05:00:00Z", 30, 30),
    s("2026-12-21T05:00:00Z", 10, 9),
  ]),
  "open",
);
check(
  "最後一場在昨天之前 → 已結束",
  phase("internal", "2026-10-25", [s("2026-10-25T06:00:00Z", 12, 0)]),
  "ended",
);
check(
  "場次被關閉（closed）→ 報名截止",
  phase("internal", "2026-12-20", [s("2026-12-20T05:00:00Z", 30, 0, "closed")]),
  "closed",
);
check(
  "多日策旅已開始、還沒結束 → 報名截止（不是報名中）",
  phase("internal", "2026-11-03", [
    { ...s("2026-11-01T08:00:00Z", 20, 3), ends_at: "2026-11-03T08:00:00Z" },
  ]),
  "closed",
);
check("站內報名但沒有場次 → 尚無可報名場次", phase("internal", "2026-12-20", []), "no_sessions");
check("外部報名 → 外部報名", phase("external", "2026-12-20", []), "external");
check("外部報名但日期已過 → 已結束", phase("external", "2026-10-01", []), "ended");
// 守著「now 是唯一的時間來源」：同一組輸入，注入的 now 換到活動結束之後，答案就跟著變成
// 已結束——不看跑測試那天的系統日期。
check(
  "注入的 now 在多日策旅結束之後 → 已結束（「今天」從 now 推，不讀系統時鐘）",
  ls.bookingPhase(
    {
      registrationType: "internal",
      isoDate: "2026-11-03",
      sessions: [{ ...s("2026-11-01T08:00:00Z", 20, 3), ends_at: "2026-11-03T08:00:00Z" }],
    },
    Date.parse("2026-11-05T04:00:00Z"),
  ),
  "ended",
);
check(
  "注入的 now 在活動很久以前 → 報名中（與系統日期無關）",
  ls.bookingPhase(
    {
      registrationType: "internal",
      isoDate: "2026-12-20",
      sessions: [s("2026-12-20T05:00:00Z", 30, 0)],
    },
    Date.parse("2020-01-01T00:00:00Z"),
  ),
  "open",
);

// =============================================================================
console.log("\n[3] 結帳第二道門 ticketSellable");
const statuses = new Map([
  ["ev-live", "live"],
  ["ev-draft", "draft"],
  ["ev-arch", "archived"],
]);
const tk = (id, type = "event") => ({ product_type: type, source_type: "event", source_id: id });
checkTrue("上架活動的票 → 可以賣", ls.ticketSellable(tk("ev-live"), statuses));
checkFalse(
  "🔴 草稿活動的票 → 不能賣（自己組結帳網址也一樣）",
  ls.ticketSellable(tk("ev-draft"), statuses),
);
checkFalse("🔴 下架活動的票 → 不能賣", ls.ticketSellable(tk("ev-arch"), statuses));
checkFalse("🔴 活動查不到（被刪掉）→ 不能賣", ls.ticketSellable(tk("ev-gone"), statuses));
checkFalse("journey 型票券同一條規則", ls.ticketSellable(tk("ev-draft", "journey"), statuses));
checkTrue(
  "書／選物不歸這裡管",
  ls.ticketSellable({ product_type: "book", source_type: null, source_id: null }, statuses),
);

// =============================================================================
console.log("\n[4] 卡片 → 活動（與 SQL journey_linked_event_id 同一套）");
const EVENTS = [
  { id: "e1", slug: "kungtung", external_url: "", sort_order: 1 },
  { id: "e2", slug: "InntervalChishang.1023", external_url: "", sort_order: 2 },
  { id: "e3", slug: "outside", external_url: "https://example.org/signup/", sort_order: 3 },
  { id: "e4", slug: "outside-2", external_url: "https://example.org/signup", sort_order: 4 },
];
check(
  "站內路徑、本站完整網址、外部網址相同、孤兒、空字串",
  [
    je.linkedEventIdFor("/events/kungtung", EVENTS),
    je.linkedEventIdFor("https://www.intervalbooks.tw/events/InntervalChishang.1023?x=1", EVENTS),
    je.linkedEventIdFor("https://intervalbooks.tw/events/kungtung/", EVENTS),
    je.linkedEventIdFor("https://example.org/signup", EVENTS),
    je.linkedEventIdFor("https://other.example.org/", EVENTS),
    je.linkedEventIdFor("/events/no-such-slug", EVENTS),
    je.linkedEventIdFor("", EVENTS),
  ],
  ["e1", "e2", "e1", "e3", null, null, null],
);
check(
  "代稱大小寫要完全相同（與 SQL 的 = 一致）",
  je.linkedEventIdFor("/events/KUNGTUNG", EVENTS),
  null,
);

// =============================================================================
console.log("\n[5] 靜態：migration 0052");
const migFiles = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
checkTrue("0052_event_listing_status.sql 存在", migFiles.includes("0052_event_listing_status.sql"));
const mig = readFile("supabase/migrations/0052_event_listing_status.sql");
const code = mig.replace(/^[ \t]*--.*$/gm, " ");
checkTrue("有 begin; / commit;", /^begin;$/m.test(mig) && /^commit;$/m.test(mig));
checkTrue(
  "events.status 與 journeys.status：not null default 'draft'",
  /alter table public\.events\s+add column if not exists status text not null default 'draft'/.test(
    code,
  ) &&
    /alter table public\.journeys\s+add column if not exists status text not null default 'draft'/.test(
      code,
    ),
);
checkTrue(
  "CHECK 只收 draft／live／archived（兩張表）",
  (code.match(/check \(status in \('draft', 'live', 'archived'\)\)/g) ?? []).length === 2,
);
for (const [trg, when] of [
  ["events_derive_published", /before insert or update on public\.events/],
  [
    "events_sync_listing_status",
    /after insert or update of status, slug, external_url on public\.events/,
  ],
  ["products_pull_listing_status", /before insert or update on public\.products/],
  ["journeys_pull_listing_status", /before insert or update on public\.journeys/],
]) {
  const re = new RegExp(`create trigger ${trg}\\s+${when.source}`);
  checkTrue(`trigger ${trg}`, re.test(code));
}
checkTrue(
  "is_published 由 status 推導",
  /new\.is_published := \(new\.status = 'live'\)/.test(code),
);
checkTrue(
  "推定在 trigger 建立之前（才不會被拉回）",
  code.indexOf("update public.events e\n   set status = case") > 0 &&
    code.indexOf("update public.events e\n   set status = case") <
      code.indexOf("create trigger events_derive_published"),
);
checkTrue(
  "推定規則：is_published → live；商品 archived → archived；其他 draft",
  /when e\.is_published then 'live'[\s\S]{0,300}p\.status = 'archived'[\s\S]{0,40}then 'archived'[\s\S]{0,40}else 'draft'/.test(
    code,
  ),
);
checkTrue(
  "改狀態的 RPC 先鎖活動列（for update）",
  /where e\.id = p_event_id for update/.test(code),
);
checkTrue(
  "連得上活動的卡片不能單獨改（admin_set_journey_status 拒絕）",
  /if v_event is not null then\s+raise exception 'admin_set_journey_status: 這張卡片跟著活動/.test(
    code,
  ),
);
for (const fn of [
  "event_listing_snapshot(text)",
  "admin_set_event_status(text, text)",
  "admin_set_journey_status(text, text)",
  "admin_upsert_event_with_session(jsonb)",
  "journey_linked_event_id(text)",
]) {
  checkTrue(
    `${fn}：revoke public／anon／authenticated、只 grant service_role`,
    new RegExp(
      `revoke execute on function public\\.${fn.replace(/[()]/g, "\\$&")}\\s+from public, anon, authenticated;`,
    ).test(code) &&
      new RegExp(
        `grant execute on function public\\.${fn.replace(/[()]/g, "\\$&")}\\s+to service_role;`,
      ).test(code),
  );
}
checkTrue(
  "🔴 安全閥：推定會改變客人看到的東西（除了已發布＋商品草稿）就整支停下",
  /raise exception '0052 推定會改變客人目前看到的東西/.test(code) &&
    /where e\.is_published and p\.status = 'archived'/.test(code) &&
    /where not e\.is_published and p\.status = 'active'/.test(code),
);
checkTrue(
  "活動改代稱／外部網址／刪除 → 連不上的卡片收成草稿（不帶著上架變孤兒）",
  /create trigger events_orphan_journeys\s+after update of slug, external_url or delete on public\.events/.test(
    code,
  ) && /public\.journey_linked_event_id\(j\.external_url\) is null/.test(code),
);
for (const fn of ["journey_url_slug(text)", "journey_url_external(text)"]) {
  checkTrue(
    `${fn}：不給 anon／authenticated`,
    new RegExp(
      `revoke execute on function public\\.${fn.replace(/[()]/g, "\\$&")}\\s+from public, anon, authenticated;`,
    ).test(code),
  );
}
checkFalse("🔴 沒有 grant 給 anon／authenticated", /grant [^;]*to (anon|authenticated)/.test(code));
checkFalse("🔴 不碰 RLS policy", /create policy|alter policy|drop policy/i.test(code));
checkFalse(
  "🔴 不碰訂單、付款、發票、報名資料",
  /\b(insert into|update|delete from)\s+public\.(orders|order_items|payments|invoices|event_registrations)\b/.test(
    code,
  ),
);
checkFalse("🔴 不改場次的 open／closed", /update public\.event_sessions\s+set status/.test(code));

// =============================================================================
console.log("\n[6] 靜態：前台讀取只看上架");
const cms = readFile("src/lib/cms.ts");
checkTrue(
  "活動列表 select 帶 is_published",
  /"id,slug,title,summary,description,display_date,iso_date,category,external_url,image_key,sort_order",\s*\/\/[\s\S]*?\{ order: "sort_order", eq: \["is_published", true\] \}/.test(
    cms,
  ),
);
checkTrue(
  "策旅列表 select 帶 is_published",
  /"id,title,summary,description,days,theme,external_url,sort_order",[\s\S]{0,200}eq: \["is_published", true\]/.test(
    cms,
  ),
);
checkTrue(
  "🔴 讀到零筆就是零筆（全部下架時不拿內建種子資料頂上）",
  /if \(!rows\) return FALLBACK_EVENTS;\s*if \(!rows\.length\) return \[\];/.test(cms) &&
    /if \(!rows\) return FALLBACK_JOURNEYS;\s*if \(!rows\.length\) return \[\];/.test(cms),
);
checkTrue(
  "詳情頁 fetchEventBySlug 帶 is_published",
  /\.eq\("slug", slug\)\s*\/\/[^\n]*\n\s*\.eq\("is_published", true\)\s*\.maybeSingle\(\)/.test(
    cms,
  ),
);
checkTrue(
  "大小寫 301 只找上架中的活動",
  /\.select\("slug"\)\s*\.eq\("is_published", true\)\s*\.ilike/.test(cms),
);
for (const f of [
  "src/routes/events.city-salon-0922.tsx",
  "src/routes/events.kungtung.tsx",
  "src/routes/events.sound-of-the-sea.tsx",
  "src/routes/events.kungtung_.hosts.alice.tsx",
  "src/routes/events.kungtung_.hosts.fan-yishun.tsx",
]) {
  const src = readFile(f);
  checkTrue(
    `${f.replace("src/routes/", "")}：不是上架就 404（讀取失敗照常渲染）`,
    /fetchEventVisibility\(/.test(src) &&
      /if \(!visibility\.visible && !visibility\.unavailable\) throw notFound\(\);/.test(src),
  );
}
const sitemap = readFile("src/server/sitemap.ts");
checkTrue(
  "sitemap：活動與策旅卡片都只列上架",
  /rows\("events", [^)]*\{\s*eq: \["is_published", true\],?\s*\}\)/.test(sitemap) &&
    /rows\("journeys", "external_url,updated_at", \{ eq: \["is_published", true\] \}\)/.test(
      sitemap,
    ),
);
const entries = readFile("src/lib/seo/sitemap-entries.ts");
checkTrue(
  "sitemap：著陸頁子頁跟著所屬活動",
  /if \(!eventLangs\.has\(parent\)\) continue;/.test(entries),
);

// =============================================================================
console.log("\n[7] 靜態：結帳與後台");
const orders = readFile("src/server/repos/orders.ts");
checkTrue(
  "priceLines 讀票券的 source_type／source_id",
  /requires_shipping, status, source_type, source_id"/.test(orders),
);
checkTrue(
  "🔴 priceLines 讀活動本身的 status，並在場次檢查前擋下",
  /\.from\("events"\)\s*\.select\("id, status"\)/.test(orders) &&
    orders.indexOf("if (!ticketSellable(p, eventStatusById))") > 0 &&
    orders.indexOf("if (!ticketSellable(p, eventStatusById))") <
      orders.indexOf("if (w.sessionId === null)"),
);
checkTrue(
  "priceLines 仍然先過 status='active'（第一道）",
  /\.select\(PRODUCT_COLUMNS\)\s*\.eq\("status", "active"\)/.test(orders),
);
for (const f of [
  "src/routes/admin/_shell.events.$id.tsx",
  "src/components/admin/JourneyForm.tsx",
  "src/server/event-quick-create.ts",
  "src/server/repos/journeys.ts",
]) {
  checkFalse(
    `🔴 ${f} 不再寫 is_published`,
    /is_published:\s*(true|false|input|row|values)/.test(readFile(f)),
  );
}
checkFalse(
  "🔴 活動編輯頁沒有商品狀態下拉",
  /name="product\.status"/.test(readFile("src/routes/admin/_shell.events.$id.tsx")),
);
checkTrue(
  "活動編輯頁有唯一的狀態選擇器",
  /name="status"[\s\S]{0,400}<ListingStatusSelect/.test(
    readFile("src/routes/admin/_shell.events.$id.tsx"),
  ),
);
for (const f of ["src/routes/admin/_shell.events.tsx", "src/routes/admin/_shell.journeys.tsx"]) {
  const src = readFile(f);
  checkTrue(
    `${f.replace("src/routes/admin/", "")}：狀態徽章＋篩選`,
    /<ListingStatusBadge/.test(src) && /<ListingFilterTabs/.test(src),
  );
}
const qc = readFile("src/components/admin/EventQuickCreate.tsx");
checkTrue(
  "一頁新增：存成草稿／直接上架",
  /label: "存成草稿"/.test(qc) && /label: "直接上架"/.test(qc),
);
checkFalse(
  "一頁新增：舊提示（到進階編輯打開發布狀態、把商品改成已上架）已移除",
  /打開「發布狀態」/.test(qc),
);
const up = readFile("src/lib/admin/unified-products.ts");
checkTrue("商品列表：活動票券標「跟著活動」", /（跟著活動）/.test(up));

// =============================================================================
console.log("\n[8] MCP set_event_status");
const L = (zh) => ({ zh, en: zh, ja: zh });
function freshMock() {
  const m = {
    calls: [],
    audits: [],
    state: {
      events: [
        {
          id: "ev-k",
          slug: "kungtung",
          title: L("公東"),
          registration_type: "internal",
          status: "live",
          sort_order: 1,
          external_url: "",
        },
        {
          id: "ev-x",
          slug: "outside",
          title: L("外部"),
          registration_type: "external",
          status: "draft",
          sort_order: 2,
          external_url: "https://example.org/a",
        },
      ],
      snapshots: {
        "ev-k": {
          event_id: "ev-k",
          slug: "kungtung",
          status: "live",
          is_published: true,
          registration_type: "internal",
          product: { id: "p-k", status: "active" },
          journeys: [{ id: "jo-k", status: "live", is_published: true }],
          consistent: true,
        },
        "ev-x": {
          event_id: "ev-x",
          slug: "outside",
          status: "draft",
          is_published: false,
          registration_type: "external",
          product: null,
          journeys: [],
          consistent: true,
        },
      },
      journeys: {
        "jo-k": {
          id: "jo-k",
          title: L("公東卡片"),
          external_url: "/events/kungtung",
          status: "live",
          is_published: true,
        },
        "jo-orphan": {
          id: "jo-orphan",
          title: L("舊卡片"),
          external_url: "https://elsewhere.example/",
          status: "draft",
          is_published: false,
        },
      },
    },
    call(name, args) {
      m.calls.push({ name, args: JSON.parse(JSON.stringify(args ?? [])) });
      const s = m.state;
      switch (name) {
        case "listEvents":
          return Promise.resolve(s.events);
        case "getEventListingSnapshot":
          return Promise.resolve(s.snapshots[args[0]] ?? null);
        case "setEventStatus": {
          const snap = s.snapshots[args[0]];
          const st = args[1];
          return Promise.resolve({
            ...snap,
            status: st,
            is_published: st === "live",
            product: snap.product
              ? { ...snap.product, status: ls.listingToProductStatus(st) }
              : null,
            journeys: snap.journeys.map((j) => ({ ...j, status: st, is_published: st === "live" })),
            status_before: snap.status,
            changed: snap.status !== st,
            consistent: true,
          });
        }
        case "getJourneyById":
          return Promise.resolve(s.journeys[args[0]] ?? null);
        case "setJourneyStatus":
          return Promise.resolve({
            journey_id: args[0],
            status: args[1],
            is_published: args[1] === "live",
            status_before: "draft",
            changed: true,
          });
        case "listJourneys":
          return Promise.resolve(Object.values(s.journeys));
        case "geminiApiKey":
          return "";
        case "supabaseAdmin":
          return {
            from: (table) => ({
              insert: async (record) => {
                m.audits.push({ table, record: JSON.parse(JSON.stringify(record)) });
                return { error: null };
              },
            }),
          };
        default:
          throw new Error(`替身沒有實作 ${name}`);
      }
    },
  };
  return m;
}
const reset = () => (globalThis.__mock = freshMock());
reset();

const http = await import(join(SRC, "server/mcp/http.ts"));
const tools = await import(join(SRC, "server/mcp/tools.ts"));
const TOKEN = "s".repeat(20) + "0123456789abcdef0123456789";
process.env.MCP_TOKEN = TOKEN;
delete process.env.MCP_OAUTH_SECRET;

async function rpc(method, params) {
  const res = await http.handleMcpRequest(
    new Request("https://www.intervalbooks.tw/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : text);
}
async function call(name, args) {
  const json = await rpc("tools/call", { name, arguments: args });
  const body = json?.result?.content?.[0]?.text ?? "";
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    /* 錯誤是純文字 */
  }
  return { isError: json?.result?.isError === true, text: body, data };
}
const writes = (m) =>
  m.calls.filter((c) => c.name === "setEventStatus" || c.name === "setJourneyStatus");

{
  const list = await rpc("tools/list", {});
  const t = list?.result?.tools?.find((x) => x.name === "set_event_status");
  checkTrue("tools/list 有 set_event_status", Boolean(t));
  checkTrue(
    "描述講清楚三個狀態與一起切換",
    /draft 草稿／live 上架／archived 下架/.test(t?.description ?? "") &&
      /同一個資料庫交易/.test(t?.description ?? ""),
  );
  check("status 只收三個值", t?.inputSchema?.properties?.status?.enum, [
    "draft",
    "live",
    "archived",
  ]);
  checkTrue("set_event_status 是寫入工具", tools.WRITE_TOOLS.includes("set_event_status"));
  check(
    "🔴 沒送 dry_run → 預設 true",
    tools.TOOL_INPUTS.set_event_status.safeParse({ id: "x", status: "live" }).data?.dry_run,
    true,
  );
}
{
  const m = reset();
  const r = await call("set_event_status", { id: "kungtung", status: "archived" });
  check(
    "dry_run 預覽：沒有寫入",
    [r.isError, r.data?.dry_run, r.data?.written, writes(m).length],
    [false, true, false, 0],
    r.text.slice(0, 300),
  );
  check(
    "預覽列出活動、票券商品、策旅卡片三者的改前改後",
    [
      r.data?.changes?.status,
      r.data?.changes?.is_published,
      r.data?.changes?.ticket_product_status,
      r.data?.changes?.journey_cards?.after,
    ],
    [
      { before: "live", after: "archived" },
      { before: true, after: false },
      { before: "active", after: "archived" },
      [{ id: "jo-k", status: "archived", is_published: false }],
    ],
  );
  checkTrue("代稱也能指定活動（slug → id）", r.data?.id === "ev-k");
  checkTrue(
    "下架有提醒（客人看不到、訂單保留）",
    (r.data?.warnings ?? []).some((w) => /訂單與報名紀錄都保留/.test(w)),
  );
  check("預覽不寫稽核（與其他 update 工具一致：寫入才記）", m.audits.length, 0);
}
{
  const m = reset();
  const r = await call("set_event_status", { id: "ev-k", status: "draft", dry_run: false });
  check(
    "寫入：一支 setEventStatus（一個交易）",
    writes(m).map((c) => [c.name, ...c.args]),
    [["setEventStatus", "ev-k", "draft"]],
  );
  check(
    "寫入結果",
    [r.data?.written, r.data?.saved?.status, r.data?.saved?.ticket_product_status],
    [true, "draft", "draft"],
  );
  const a = m.audits.find((x) => x.table === "mcp_audit_log")?.record;
  check(
    "稽核：tool／entity／id／改了 status",
    [a?.tool, a?.entity, a?.entity_id, a?.changes?.status?.after],
    ["set_event_status", "event", "ev-k", "draft"],
  );
}
{
  const m = reset();
  await call("set_event_status", { journey_id: "jo-k", status: "archived", dry_run: false });
  check(
    "用 journey_id 指定：改它連到的那場活動",
    writes(m).map((c) => [c.name, ...c.args]),
    [["setEventStatus", "ev-k", "archived"]],
  );
  const m2 = reset();
  const same = await call("set_event_status", { id: "ev-k", status: "live", dry_run: false });
  check(
    "狀態沒變 → 不寫入、不記稽核",
    [writes(m2).length, m2.audits.length, same.data?.written],
    [0, 0, false],
  );
}
{
  const m = reset();
  const r = await call("set_event_status", {
    journey_id: "jo-orphan",
    status: "live",
    dry_run: false,
  });
  check(
    "孤兒卡片：只改卡片本身",
    writes(m).map((c) => [c.name, ...c.args]),
    [["setJourneyStatus", "jo-orphan", "live"]],
  );
  check("孤兒卡片：稽核 entity=journey", m.audits.at(-1)?.record?.entity, "journey");
  checkTrue("孤兒卡片：回應說明只改卡片", /沒有連到任何活動/.test(r.data?.note ?? ""));
}
{
  const m = reset();
  const r = await call("set_event_status", { id: "ev-x", status: "live" });
  check(
    "外部報名活動：沒有票券商品 → 預覽不出現商品變動",
    r.data?.changes?.ticket_product_status,
    undefined,
  );
  check("外部報名活動：沒有警告「還不能報名」", r.data?.warnings, undefined);
  check("（沒有寫入）", writes(m).length, 0);
}
{
  reset();
  const both = await call("set_event_status", { id: "ev-k", journey_id: "jo-k", status: "live" });
  const none = await call("set_event_status", { status: "live" });
  checkTrue(
    "id 與 journey_id 要剛好一個",
    both.isError && none.isError && /剛好給一個/.test(both.text),
  );
  const bad = await call("set_event_status", { id: "ev-k", status: "published" });
  checkTrue("🔴 不認得的狀態被擋下", bad.isError);
  const missing = await call("set_event_status", { id: "nope", status: "live" });
  checkTrue("查不到的活動 → 錯誤", missing.isError && /找不到活動/.test(missing.text));
}
{
  const m = reset();
  const r1 = await call("update_event", { id: "ev-k", is_published: true, dry_run: false });
  const r2 = await call("update_journey", { id: "jo-k", is_published: true, dry_run: false });
  checkTrue(
    "🔴 update_event 帶 is_published → 拒絕並指向 set_event_status",
    r1.isError && /set_event_status/.test(r1.text),
  );
  checkTrue(
    "🔴 update_journey 帶 is_published → 拒絕並指向 set_event_status",
    r2.isError && /set_event_status/.test(r2.text),
  );
  check("（都沒有寫入）", writes(m).length, 0);
}
checkTrue(
  "update_event 的 status 走同一支 RPC（admin_upsert_event_with_session，一個交易）",
  /\.\.\.\(args\.status !== undefined \? \{ status \} : \{\}\)/.test(
    readFile("src/server/mcp/tools.ts"),
  ),
);

console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exit(1);
}
console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
