#!/usr/bin/env node
/**
 * mcp-create-selftest.mjs —— MCP 新增工具（create_event／create_journey／create_shop_product）的自檢
 *
 * **走真正的 MCP 協定**（src/server/mcp/http.ts#handleMcpRequest → tools/call），只把「碰資料庫
 * 與翻譯」的模組換成記錄呼叫的替身：repos（events、event-sessions、products、journeys、
 * event-categories、artists）、@/server/translate、@/server/env、@/server/supabase-admin（稽核）。
 * 驗證、寫入計畫、寫入順序、稽核內容全部是 production 的程式碼本人。
 *
 *   [1] dry_run：預設 true、回傳完整預覽、不呼叫任何寫入、照樣記稽核
 *   [2] 正常建立：寫入順序（草稿 → 場次 → 票種 → 〔發布〕）與內容；策旅多一張卡片；外部報名
 *   [3] 驗證錯誤：時間不合理、已過去、名稱重複、代稱重複／格式、分類／講者不存在、票種…
 *   [4] 權限：沒過閘門（沒有 MCP 身分）一律拒絕；token 錯 401
 *   [5] 稽核：預覽／擋下／成功／失敗都記，失敗時清掉這次建立的列
 *   [6] 一般商品：走後台新增商品同一條 payload、stock 一律 null、預設草稿
 *   [7] 後台一頁新增（createEventQuick）行為不變
 *
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15（module.registerHooks）。
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/mcp-create-selftest.mjs";
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

console.log("═══ MCP 新增工具自檢 ═══");

if (typeof registerHooks !== "function") {
  console.log(red("  ✗ 這個 Node 沒有 module.registerHooks（需要 ≥ 22.15）"));
  console.log(`##SELFTEST## file=${SELF} pass=0 fail=1`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 替身：每一支被換掉的函式都經過 globalThis.__mock.call()，依序記下呼叫
// -----------------------------------------------------------------------------
const MOCKED = {
  "@/server/repos/events": [
    "listEvents",
    "listTakenEventSlugs",
    "upsertEventWithProduct",
    "removeEvent",
    "setEventStatus",
  ],
  "@/server/repos/event-sessions": [
    "upsertEventSession",
    "upsertEventSessionPlan",
    "removeEventSession",
  ],
  "@/server/repos/products": [
    "listProducts",
    "findProductConflicts",
    "upsertProduct",
    "removeProduct",
  ],
  "@/server/repos/journeys": ["listJourneys", "upsertJourney", "removeJourney"],
  "@/server/repos/event-categories": ["getEventCategoryById", "listEventCategories"],
  "@/server/repos/artists": ["getArtistById"],
  "@/server/translate": ["translateToEnJa"],
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

const L = (zh) => ({ zh, en: zh, ja: zh });
const WRITE_FNS = new Set([
  "upsertEventWithProduct",
  "setEventStatus",
  "upsertEventSession",
  "upsertEventSessionPlan",
  "upsertJourney",
  "upsertProduct",
  "removeEvent",
  "removeEventSession",
  "removeProduct",
  "removeJourney",
]);

function freshMock() {
  let seq = 0;
  const m = {
    calls: [],
    audits: [],
    auditError: null,
    translateFails: false,
    failOn: null,
    state: {
      events: [{ id: "ev-old", slug: "20991101", title: L("既有的讀書會"), sort_order: 5 }],
      journeys: [{ id: "jo-old", title: L("既有的策旅"), sort_order: 2 }],
      takenSlugs: ["20991101", "taken-slug"],
      products: [
        {
          id: "p-old",
          slug: "old-book",
          product_type: "book",
          title: L("既有的書"),
          status: "active",
          sort_order: 7,
        },
        {
          id: "p-ev",
          slug: "event-20991101",
          product_type: "event",
          title: L("活動票"),
          status: "active",
          sort_order: 9,
        },
      ],
      categories: [
        { id: "reading", label: { zh: "讀書會", en: "Reading", ja: "読書会" }, sort_order: 1 },
        { id: "travel", label: { zh: "旅行", en: "Travel", ja: "旅" }, sort_order: 2 },
      ],
      artists: [{ id: "a1", name: "講者一" }],
    },
    call(name, args) {
      m.calls.push({ name, args: JSON.parse(JSON.stringify(args ?? [])) });
      if (m.failOn === name) throw new Error(`替身：${name} 故意失敗`);
      const s = m.state;
      switch (name) {
        case "listEvents":
          return Promise.resolve(s.events);
        case "listTakenEventSlugs": {
          const p = String(args[0]).toLowerCase();
          return Promise.resolve(s.takenSlugs.filter((x) => x.toLowerCase().startsWith(p)));
        }
        case "listJourneys":
          return Promise.resolve(s.journeys);
        case "listProducts":
          return Promise.resolve(s.products);
        case "findProductConflicts": {
          const { titleZh, slug } = args[0];
          return Promise.resolve({
            sameTitle: s.products.filter((p) => p.title.zh === titleZh.trim()),
            sameSlug: slug
              ? s.products.filter((p) => p.slug.toLowerCase() === slug.toLowerCase())
              : [],
          });
        }
        case "getEventCategoryById":
          return Promise.resolve(s.categories.find((c) => c.id === args[0]) ?? null);
        case "listEventCategories":
          return Promise.resolve(s.categories);
        case "getArtistById":
          return Promise.resolve(s.artists.find((a) => a.id === args[0]) ?? null);
        case "upsertEventWithProduct":
          return Promise.resolve({
            event: { id: args[0].id ?? "ev-new" },
            product: args[1] ? { id: "prod-new" } : null,
          });
        case "upsertEventSession":
          return Promise.resolve({ id: `ses-${++seq}` });
        case "upsertEventSessionPlan":
          return Promise.resolve({ id: `plan-${++seq}` });
        case "upsertJourney":
          return Promise.resolve({ id: args[0].id ?? "jo-new" });
        case "setEventStatus":
          // 0052 admin_set_event_status 的回傳形狀（一致性快照）。
          return Promise.resolve({
            event_id: args[0],
            status: args[1],
            is_published: args[1] === "live",
            consistent: true,
            status_before: "draft",
            changed: true,
          });
        case "upsertProduct":
          return Promise.resolve({ ...args[0], id: "goods-new" });
        case "removeEvent":
        case "removeEventSession":
        case "removeProduct":
        case "removeJourney":
          return Promise.resolve();
        case "translateToEnJa":
          if (m.translateFails) return Promise.reject(new Error("quota"));
          return Promise.resolve({ en: `EN:${args[0].text}`, ja: `JA:${args[0].text}` });
        case "geminiApiKey":
          return "test-key";
        case "supabaseAdmin":
          return {
            from: (table) => ({
              insert: async (record) => {
                m.audits.push({ table, record: JSON.parse(JSON.stringify(record)) });
                return { error: m.auditError };
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

globalThis.__mock = freshMock();
const reset = () => {
  globalThis.__mock = freshMock();
  return globalThis.__mock;
};

const http = await import(join(SRC, "server/mcp/http.ts"));
const createTools = await import(join(SRC, "server/mcp/create-tools.ts"));
const quickServer = await import(join(SRC, "server/event-quick-create.ts"));

const TOKEN = "s".repeat(20) + "0123456789abcdef0123456789";
process.env.MCP_TOKEN = TOKEN;
delete process.env.MCP_OAUTH_SECRET;

async function call(name, args, token = TOKEN) {
  const res = await http.handleMcpRequest(
    new Request("https://www.intervalbooks.tw/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  let json = null;
  try {
    json = JSON.parse(line ? line.slice(5) : text);
  } catch {
    /* null */
  }
  const result = json?.result;
  const body = result?.content?.[0]?.text ?? "";
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    /* 錯誤是純文字 */
  }
  return { status: res.status, isError: result?.isError === true, text: body, data, json };
}

const writes = (m) => m.calls.filter((c) => WRITE_FNS.has(c.name));
const names = (m) => writes(m).map((c) => c.name);

const EVENT_ARGS = {
  title: { zh: "十二月讀書會", en: "December Book Club", ja: "12月の読書会" },
  category: "reading",
  description: "一起讀《海的聲音》。\n第二段。",
  sessions: [
    { date: "2099-12-20", start: "14:00", end: "16:00", capacity: 30 },
    { date: "2099-12-21", start: "14:00", end: "16:00" },
  ],
  ticket_types: [
    { name: "一般票", price: 350 },
    { name: { zh: "雙人票", en: "Pair", ja: "ペア" }, price: 600, seats_per_unit: 2 },
  ],
};

// =============================================================================
console.log("\n[1] dry_run");
{
  const m = reset();
  const r = await call("create_event", EVENT_ARGS);
  check("HTTP 200、不是錯誤", [r.status, r.isError], [200, false], r.text.slice(0, 300));
  check(
    "🔴 沒送 dry_run → dry_run=true、written=false",
    [r.data?.dry_run, r.data?.written],
    [true, false],
  );
  check("🔴 沒有呼叫任何寫入函式", names(m), []);
  const ev = r.data?.will_create?.event;
  check("預覽：代稱用第一場日期", ev?.slug, "20991220");
  check("預覽：網址", ev?.url, "https://www.intervalbooks.tw/events/20991220");
  check("預覽：呼叫端給的英日文原樣使用", ev?.title, EVENT_ARGS.title);
  check("預覽：摘要取介紹第一段（自動翻譯補英日）", ev?.summary, {
    zh: "一起讀《海的聲音》。",
    en: "EN:一起讀《海的聲音》。",
    ja: "JA:一起讀《海的聲音》。",
  });
  check("預覽：預設草稿", ev?.status, "draft");
  check(
    "預覽：票券商品 draft、價格＝最低票價",
    r.data?.will_create?.ticket_product?.status === "draft" &&
      r.data?.will_create?.ticket_product?.price,
    350,
  );
  const ses = r.data?.will_create?.sessions ?? [];
  check("預覽：兩個場次", ses.length, 2);
  check(
    "預覽：時間是台北時間",
    [ses[0]?.starts_at, ses[0]?.ends_at],
    ["2099-12-20 14:00（台北）", "2099-12-20 16:00（台北）"],
  );
  check("預覽：沒給名額 → 活動預設 30", ses[1]?.capacity, 30);
  check(
    "預覽：沒給地點 → 書店預設地點",
    ses[0]?.location?.zh,
    "小時光風土誌書店（華山文創園區 紅磚六合院 西 7-3 館）",
  );
  check(
    "預覽：雙人票每張 2 人、可售 15 張（30 ÷ 2）",
    ses[0]?.ticket_types?.map((p) => [p.title.zh, p.price, p.seats_per_unit, p.capacity]),
    [
      ["一般票", 350, 1, 30],
      ["雙人票", 600, 2, 15],
    ],
  );
  checkTrue(
    "呼叫端給齊英日文的字串不送翻譯",
    !m.calls.some(
      (c) => c.name === "translateToEnJa" && ["十二月讀書會", "雙人票"].includes(c.args[0].text),
    ),
  );
  check("🔴 dry_run 也記一筆稽核", m.audits.length, 1);
  const a = m.audits[0]?.record;
  check(
    "稽核：表、工具、動作、actor_role",
    [m.audits[0]?.table, a?.tool, a?.action, a?.actor_role],
    ["mcp_audit_log", "create_event", "create", "mcp"],
  );
  check(
    "稽核：changes 記 dry_run=true、outcome=preview、身分",
    [a?.changes?.dry_run, a?.changes?.outcome, a?.changes?._actor],
    [true, "preview", { via: "static_token" }],
  );
  check("結果帶 audit 狀態", r.data?.audit, "recorded");

  const m2 = reset();
  m2.auditError = { code: "42P01", message: "relation does not exist" };
  const r2 = await call("create_event", EVENT_ARGS);
  check(
    "稽核表寫不進去 → 照樣回預覽，並講明 log_only",
    [r2.isError, /^log_only/.test(r2.data?.audit ?? "")],
    [false, true],
  );
}

// =============================================================================
console.log("\n[2] 正常建立");
{
  const m = reset();
  const r = await call("create_event", { ...EVENT_ARGS, dry_run: false });
  check(
    "建立成功",
    [r.isError, r.data?.written, r.data?.published],
    [false, true, false],
    r.text.slice(0, 400),
  );
  check("🔴 寫入順序：活動＋商品（草稿）→ 場次 → 票種 → 場次 → 票種（沒有發布那一步）", names(m), [
    "upsertEventWithProduct",
    "upsertEventSession",
    "upsertEventSessionPlan",
    "upsertEventSessionPlan",
    "upsertEventSession",
    "upsertEventSessionPlan",
    "upsertEventSessionPlan",
  ]);
  const first = writes(m)[0].args;
  check(
    "活動先存草稿（status=draft；0052 商品狀態跟著活動，不另送）、價格 350",
    [first[0].status, "is_published" in first[0], first[1]?.status, first[1]?.price],
    ["draft", false, undefined, 350],
  );
  check(
    "活動內容：slug／分類／付費／站內報名",
    [first[0].slug, first[0].category, first[0].payment_enabled, first[0].registration_type],
    ["20991220", "reading", true, "internal"],
  );
  check("排序：排在既有最後一場後面（5 + 1）", first[0].sort_order, 6);
  const s1 = writes(m)[1].args[0];
  check(
    "場次：掛在剛建的商品、開放、UTC 時間正確",
    [s1.product_id, s1.status, s1.starts_at, s1.ends_at, s1.capacity],
    ["prod-new", "open", "2099-12-20T06:00:00.000Z", "2099-12-20T08:00:00.000Z", 30],
  );
  const p2 = writes(m)[3].args[0];
  check(
    "票種：雙人票 seats_per_unit=2、可售張數 15、掛在第一個場次",
    [p2.title.zh, p2.seats_per_unit, p2.capacity, p2.session_id, p2.status],
    ["雙人票", 2, 15, "ses-1", "open"],
  );
  check(
    "結果帶回各個 id",
    [
      r.data?.event_id,
      r.data?.product_id,
      r.data?.session_ids?.length,
      r.data?.ticket_type_ids?.length,
    ],
    ["ev-new", "prod-new", 2, 4],
  );
  const a = m.audits.at(-1)?.record;
  check(
    "稽核：outcome=created、entity_id＝活動 id、記下所有 id",
    [a?.changes?.outcome, a?.entity_id, a?.changes?.session_ids?.length, a?.changes?.dry_run],
    ["created", "ev-new", 2, false],
  );
  check("稽核只有一筆", m.audits.length, 1);
}
{
  const m = reset();
  const r = await call("create_event", { ...EVENT_ARGS, publish: true, dry_run: false });
  const ws = writes(m);
  check(
    "publish=true：最後一步才上架，一支 setEventStatus（0052 一個交易：活動＋票券＋卡片）",
    [ws.at(-1)?.name, ws.at(-1)?.args[0], ws.at(-1)?.args[1], ws.length],
    ["setEventStatus", "ev-new", "live", 8],
  );
  check("結果 published=true", r.data?.published, true);
}
{
  const m = reset();
  const r = await call("create_journey", {
    title: "公東山海之旅",
    category: "travel",
    description: "三天兩夜的台東旅行。",
    location: "台東火車站",
    sessions: [
      { date: "2099-12-04", start: "16:30", end: "16:55", end_date: "2099-12-06", capacity: 20 },
    ],
    ticket_types: [{ name: "雙人房（每人）", price: 18800 }],
    theme: "山海與建築",
    dry_run: false,
  });
  check("策旅建立成功", [r.isError, r.data?.journey_id], [false, "jo-new"], r.text.slice(0, 300));
  check("策旅寫入順序：活動 → 梯次 → 票種 → 策旅卡片（草稿）", names(m), [
    "upsertEventWithProduct",
    "upsertEventSession",
    "upsertEventSessionPlan",
    "upsertJourney",
  ]);
  const card = writes(m)[3].args[0];
  check(
    "策旅卡片：不自己帶狀態（跟著活動）、連到活動頁、3天2夜、主題",
    ["is_published" in card || "status" in card, card.external_url, card.days.zh, card.theme.zh],
    [false, "/events/20991204", "3天2夜", "山海與建築"],
  );
  const ses = writes(m)[1].args[0];
  check("梯次跨日：回程 12/6 16:55（台北）", ses.ends_at, "2099-12-06T08:55:00.000Z");
  check("梯次地點用 location", ses.location.zh, "台東火車站");
  check(
    "稽核 tool=create_journey、entity=journey",
    [m.audits[0]?.record?.tool, m.audits[0]?.record?.entity],
    ["create_journey", "journey"],
  );
}
{
  const m = reset();
  const r = await call("create_event", {
    title: "外部報名講座",
    category: "reading",
    description: "在別的平台報名。",
    registration_mode: "external",
    external_url: "https://example.com/signup",
    sessions: [{ date: "2099-12-22", start: "19:00", end: "21:00" }],
    dry_run: false,
  });
  check(
    "外部報名：只建活動、不建商品／場次",
    [r.isError, names(m)],
    [false, ["upsertEventWithProduct"]],
    r.text.slice(0, 300),
  );
  check(
    "外部報名：product=null、registration_type=external",
    [writes(m)[0].args[1], writes(m)[0].args[0].registration_type],
    [null, "external"],
  );
}
{
  const m = reset();
  const r = await call("create_event", {
    ...EVENT_ARGS,
    registration_mode: "free",
    ticket_types: [],
    slug: "my-salon",
    image_key: "storage:12345678-1234-4123-8123-123456789abc.webp",
    speaker_id: "a1",
    dry_run: false,
  });
  check("免費＋指定代稱＋封面＋講者：建立成功", r.isError, false, r.text.slice(0, 300));
  const ev = writes(m)[0].args;
  check(
    "免費：商品 price 0、payment_enabled false、不建票種",
    [ev[1]?.price, ev[0].payment_enabled, names(m).includes("upsertEventSessionPlan")],
    [0, false, false],
  );
  check(
    "指定的代稱、封面、講者原樣寫入",
    [ev[0].slug, ev[0].image_key, ev[0].speaker_id],
    ["my-salon", "storage:12345678-1234-4123-8123-123456789abc.webp", "a1"],
  );
}
{
  const m = reset();
  m.state.takenSlugs.push("20991220");
  const r = await call("create_event", EVENT_ARGS);
  check("自動代稱撞號 → 加 -2", r.data?.will_create?.event?.slug, "20991220-2");
}
{
  const m = reset();
  m.translateFails = true;
  const r = await call("create_event", { ...EVENT_ARGS, title: "只有中文的名稱" });
  check(
    "翻譯失敗 → 英日暫用中文（照後台規則），並明講",
    [r.isError, r.data?.will_create?.event?.title?.en, typeof r.data?.translation_note],
    [false, "只有中文的名稱", "string"],
  );
}

// =============================================================================
console.log("\n[3] 驗證錯誤（都不寫入、都記稽核）");
async function rejected(label, tool, args, expectText, setup) {
  const m = reset();
  if (setup) setup(m);
  const r = await call(tool, { ...args, dry_run: false });
  const ok =
    r.isError &&
    names(m).length === 0 &&
    m.audits.length === 1 &&
    m.audits[0].record.changes.outcome === "rejected" &&
    r.text.includes(expectText);
  checkTrue(
    label,
    ok,
    `isError=${r.isError} writes=${names(m)} audits=${m.audits.length} text=${r.text.slice(0, 300)}`,
  );
  return r;
}
const S = (o) => ({ ...EVENT_ARGS, sessions: [{ ...EVENT_ARGS.sessions[0], ...o }] });
await rejected(
  "結束早於開始 → 擋",
  "create_event",
  S({ start: "16:00", end: "14:00" }),
  "第 1 個場次的結束時間（end）：結束時間要晚於開始時間",
);
await rejected("結束等於開始 → 擋", "create_event", S({ end: "14:00" }), "結束時間要晚於開始時間");
await rejected(
  "回程早於出發 → 擋",
  "create_journey",
  { ...S({ end_date: "2099-12-19" }), location: "台東" },
  "回程日期不能早於出發日期",
);
await rejected("場次已經過去 → 擋", "create_event", S({ date: "2020-01-01" }), "已經過去");
await rejected(
  "活動名稱重複 → 擋",
  "create_event",
  { ...EVENT_ARGS, title: "既有的讀書會" },
  "已經有一場同名的活動",
);
await rejected(
  "策旅名稱與既有策旅重複 → 擋",
  "create_journey",
  { ...EVENT_ARGS, title: "既有的策旅", location: "台東" },
  "已經有一個同名的策旅",
);
await rejected(
  "指定的代稱已被使用 → 擋",
  "create_event",
  { ...EVENT_ARGS, slug: "Taken-Slug" },
  "已經被使用",
);
await rejected(
  "代稱格式不對（中文）→ 在 zod 層擋、照樣記稽核",
  "create_event",
  { ...EVENT_ARGS, slug: "讀書會" },
  "網址代稱只能用英數字",
);
await rejected(
  "日期格式不對 → 中文訊息",
  "create_event",
  S({ date: "2099/12/20" }),
  "格式要是 YYYY-MM-DD",
);
await rejected(
  "沒給分類 → 中文訊息",
  "create_event",
  { title: "x", description: "y" },
  "請填分類 id",
);
await rejected(
  "分類不存在 → 列出可用分類",
  "create_event",
  { ...EVENT_ARGS, category: "nope" },
  "可用的分類：reading（讀書會）",
);
await rejected(
  "講者不存在 → 擋",
  "create_event",
  { ...EVENT_ARGS, speaker_id: "ghost" },
  "找不到講者",
);
await rejected(
  "付費報名沒有票種 → 擋",
  "create_event",
  { ...EVENT_ARGS, ticket_types: [] },
  "付費報名至少要有一個票種",
);
await rejected(
  "站內報名沒有場次 → 擋",
  "create_event",
  { ...EVENT_ARGS, sessions: [] },
  "站內報名至少要有一個場次",
);
await rejected(
  "票種名稱重複 → 擋",
  "create_event",
  {
    ...EVENT_ARGS,
    ticket_types: [
      { name: "A", price: 1 },
      { name: "A", price: 2 },
    ],
  },
  "票種名稱重複了",
);
await rejected(
  "負票價 → 擋",
  "create_event",
  { ...EVENT_ARGS, ticket_types: [{ name: "A", price: -1 }] },
  "票價不可為負數",
);
await rejected(
  "每張票人數大於名額 → 擋",
  "create_event",
  { ...S({ capacity: 1 }), ticket_types: [{ name: "雙人", price: 1, seats_per_unit: 2 }] },
  "每張票的人數不能超過場次名額",
);
await rejected(
  "策旅沒給集合地點 → 擋",
  "create_journey",
  EVENT_ARGS,
  "第 1 個梯次的地點（location）：請填地點",
);
await rejected(
  "外部報名沒給網址 → 擋",
  "create_event",
  { ...EVENT_ARGS, registration_mode: "external" },
  "請貼上完整網址",
);
await rejected(
  "封面圖不是站內圖 → 擋",
  "create_event",
  { ...EVENT_ARGS, image_key: "https://evil.example/a.jpg" },
  "upload_image_from_url",
);
{
  const r = await rejected(
    "多個錯誤一次列出",
    "create_event",
    { ...S({ start: "16:00", end: "14:00" }), category: "nope", title: "既有的讀書會" },
    "參數有 3 個問題",
  );
  checkTrue("錯誤訊息說明沒有寫入", r.text.includes("沒有寫入任何資料"));
}
{
  const m = reset();
  const r = await call("create_event", { ...S({ date: "2020-01-01" }) });
  check(
    "dry_run 被擋也記稽核（dry_run=true）",
    [r.isError, m.audits[0]?.record?.changes?.dry_run, m.audits[0]?.record?.changes?.outcome],
    [true, true, "rejected"],
  );
}

// =============================================================================
console.log("\n[4] 權限");
{
  const m = reset();
  const r = await call("create_event", EVENT_ARGS, "w".repeat(46));
  check("token 錯 → 401、不碰資料庫、不記稽核", [r.status, m.calls.length], [401, 0]);
  const m2 = reset();
  const direct = await createTools.runCreateEvent("event", {
    ...EVENT_ARGS,
    dry_run: false,
    publish: false,
    registration_mode: "paid",
  });
  const repoCalls = (m) => m.calls.filter((c) => c.name !== "supabaseAdmin").length;
  check(
    "🔴 沒經過 MCP 閘門（沒有身分）直接呼叫 → 拒絕、不碰任何 repo",
    [direct.isError, repoCalls(m2)],
    [true, 0],
  );
  check(
    "被拒絕的那一次也記稽核（rejected、沒有 _actor）",
    [
      m2.audits.length,
      m2.audits[0]?.record?.changes?.outcome,
      "_actor" in (m2.audits[0]?.record?.changes ?? {}),
    ],
    [1, "rejected", false],
  );
  checkTrue("拒絕訊息講出需要認證", direct.content[0].text.includes("沒有通過 MCP 認證"));
  const direct2 = await createTools.runCreateShopProduct(
    { product_type: "book", title: "x", summary: "y", price: 100, dry_run: false, publish: false },
    { translator: async () => null },
  );
  check("🔴 商品也一樣", [direct2.isError, repoCalls(m2), m2.audits.length], [true, 0, 2]);
}

// =============================================================================
console.log("\n[5] 寫入失敗：清掉這一次建立的列、記稽核");
{
  const m = reset();
  m.failOn = "upsertEventSessionPlan";
  const r = await call("create_event", { ...EVENT_ARGS, dry_run: false });
  check("回錯誤", r.isError, true);
  check(
    "清掉場次 → 商品 → 活動（相反順序）",
    names(m).filter((n) => n.startsWith("remove")),
    ["removeEventSession", "removeProduct", "removeEvent"],
  );
  checkTrue("錯誤訊息說已復原", r.text.includes("已復原"), r.text);
  check("稽核 outcome=failed", m.audits[0]?.record?.changes?.outcome, "failed");
}

// =============================================================================
console.log("\n[6] 一般商品");
const GOODS = { product_type: "book", title: "海的聲音", summary: "一本關於海的書。", price: 420 };
{
  const m = reset();
  const r = await call("create_shop_product", GOODS);
  check(
    "dry_run 預設 true、不寫入",
    [r.isError, r.data?.dry_run, names(m)],
    [false, true, []],
    r.text.slice(0, 300),
  );
  const p = r.data?.will_create?.product;
  check("預覽：草稿、價格、分類", [p?.status, p?.price, p?.product_type], ["draft", 420, "book"]);
  check("預覽：自動翻譯英日", p?.title, { zh: "海的聲音", en: "EN:海的聲音", ja: "JA:海的聲音" });
  checkTrue(
    "預覽：代稱由英文名產生＋5 碼亂數",
    /^[a-z0-9]+(-[a-z0-9]+)*-[a-z0-9]{1,5}$/.test(p?.slug ?? ""),
    p?.slug,
  );
  check("預覽：description 沒給就沿用 summary", p?.description?.zh, "一本關於海的書。");
  checkTrue(
    "預覽：講明不設庫存",
    (p?.stock ?? "").includes("不設定") && (r.data?.stock_note ?? "").includes("MCP 不碰庫存"),
  );
  check(
    "dry_run 記稽核",
    [m.audits.length, m.audits[0]?.record?.changes?.outcome, m.audits[0]?.record?.tool],
    [1, "preview", "create_shop_product"],
  );
}
{
  const m = reset();
  const r = await call("create_shop_product", {
    ...GOODS,
    title: { zh: "海的聲音", en: "Sound of the Sea", ja: "海の声" },
    summary: { zh: "一本關於海的書。", en: "A book about the sea.", ja: "海の本。" },
    description: { zh: "長說明。", en: "Long.", ja: "長い。" },
    slug: "sound-of-the-sea",
    image_key: "storage:12345678-1234-4123-8123-123456789abc.webp",
    dry_run: false,
  });
  check(
    "建立成功、只呼叫一次 upsertProduct",
    [r.isError, names(m)],
    [false, ["upsertProduct"]],
    r.text.slice(0, 300),
  );
  const w = writes(m)[0].args[0];
  check("🔴 stock 是 null（不設庫存）、沒有 id（新建）", [w.stock, "id" in w], [null, false]);
  check(
    "寫入內容：代稱、分類、草稿、需寄送、排序 max+1、description",
    [w.slug, w.product_type, w.status, w.requires_shipping, w.sort_order, w.description.en],
    ["sound-of-the-sea", "book", "draft", true, 10, "Long."],
  );
  check("不關聯來源（與後台新增一般商品相同）", [w.source_type, w.source_id], [null, null]);
  checkTrue("給齊英日文就不呼叫翻譯", !m.calls.some((c) => c.name === "translateToEnJa"));
  check(
    "稽核 created、entity_id",
    [m.audits[0]?.record?.changes?.outcome, m.audits[0]?.record?.entity_id],
    ["created", "goods-new"],
  );
}
{
  const m = reset();
  const r = await call("create_shop_product", {
    ...GOODS,
    product_type: "goods",
    publish: true,
    dry_run: false,
  });
  check(
    "🔴 publish=true → 擋下（沒有庫存不能直接上架）、不寫入",
    [r.isError, names(m), r.text.includes("新增商品不能直接上架")],
    [true, [], true],
  );
  check("擋下也記稽核", m.audits[0]?.record?.changes?.outcome, "rejected");
}
async function rejectedP(label, args, expectText, setup) {
  return rejected(label, "create_shop_product", args, expectText, setup);
}
await rejectedP("商品名稱重複 → 擋", { ...GOODS, title: "既有的書" }, "已經有同名的商品");
await rejectedP("商品代稱重複 → 擋", { ...GOODS, slug: "OLD-BOOK" }, "已經被使用");
await rejectedP("售價 0 → 擋（至少 1 元）", { ...GOODS, price: 0 }, "售價至少 1 元");
await rejectedP("小數售價 → 擋", { ...GOODS, price: 1.5 }, "售價要是整數");
await rejectedP(
  "分類不是 book／goods → 擋",
  { ...GOODS, product_type: "event" },
  "商品分類只能是 book（書）或 goods（選物）",
);
await rejectedP(
  "不收庫存欄位（多送的 stock 被忽略也不會寫）",
  { ...GOODS, title: "既有的書", stock: 5 },
  "已經有同名的商品",
);
{
  const m = reset();
  const r = await call("create_shop_product", { ...GOODS, stock: 99, dry_run: false });
  check(
    "多送 stock=99 → 寫入的仍是 null",
    [r.isError, writes(m)[0]?.args[0]?.stock],
    [false, null],
  );
}

// =============================================================================
console.log("\n[6b] zod 內建英文訊息換成中文、稽核參數有上限");
await rejected(
  "沒送 description → 「必填」",
  "create_event",
  { title: "x", category: "reading" },
  "介紹（description）：必填",
);
await rejected(
  "三語多送 fr → 中文說明",
  "create_event",
  { ...EVENT_ARGS, title: { zh: "x", fr: "y" } },
  "不認得的欄位：fr",
);
await rejected(
  "publish 給字串 → 型別不對",
  "create_event",
  { ...EVENT_ARGS, publish: "yes" },
  "型別不對",
);
await rejected("名額給字串 → 自訂中文訊息", "create_event", S({ capacity: "30" }), "名額要是整數");
{
  const m = reset();
  const r = await call("create_event", { ...EVENT_ARGS, description: "長".repeat(30000) });
  const input = m.audits[0]?.record?.changes?.input;
  check(
    "格式錯的超長參數：稽核只存前 16000 字並記原長度",
    [r.isError, input?.truncated, input?.head?.length, input?.original_chars > 30000],
    [true, true, 16000, true],
  );
  checkTrue("zh 字串上限的錯誤是中文", r.text.includes("最多 2000 字"));
}
check(
  "zhIssueMessage：自訂中文訊息原樣保留",
  createTools.zhIssueMessage({ code: "too_big", message: "名稱最多 120 字" }),
  "名稱最多 120 字",
);

// =============================================================================
console.log("\n[7] 後台一頁新增（createEventQuick）行為不變");
{
  const m = reset();
  const res = await quickServer.createEventQuick({
    kind: "event",
    title: "後台建立",
    category: "reading",
    speaker_id: null,
    image_key: null,
    description: "簡介。",
    sessions: [
      {
        date: "2099-12-30",
        start: "10:00",
        end: "12:00",
        end_date: "",
        location: "小時光風土誌書店（華山文創園區 紅磚六合院 西 7-3 館）",
        capacity: 25,
      },
    ],
    mode: "paid",
    plans: [{ name: "一般票", price: 300 }],
    external_url: "",
    publish: true,
    theme: "",
  });
  check("寫入順序：草稿 → 場次 → 票種 → 上架（setEventStatus）", names(m), [
    "upsertEventWithProduct",
    "upsertEventSession",
    "upsertEventSessionPlan",
    "setEventStatus",
  ]);
  const plan = writes(m)[2].args[0];
  check("票種 seats_per_unit=1、名額＝場次名額", [plan.seats_per_unit, plan.capacity], [1, 25]);
  check("回傳形狀不變", Object.keys(res).sort(), [
    "eventId",
    "journeyId",
    "planIds",
    "productId",
    "published",
    "sessionIds",
    "slug",
    "untranslated",
  ]);
  check("不記 MCP 稽核", m.audits.length, 0);
}

// -----------------------------------------------------------------------------
console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
