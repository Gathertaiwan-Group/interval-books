#!/usr/bin/env node
/**
 * registration-edit-selftest.mjs —— 報名名單「編輯參加者」（2026-11-05）
 *
 *   [1] 輸入驗證：src/lib/admin/registration-edit.ts 的 zod（singleLine 清洗、長度、Email、電話字元）
 *   [2] 差異與聯絡方式規則：diffParticipantContact／contactRequiredError
 *   [3] 後台流程 editRegistrationParticipantAsAdmin（假 supabaseAdmin 跑 production 的 repo 本人）：
 *       只 update event_registrations 的 name／email／phone 三欄；不寫 orders／payments／
 *       event_sessions／event_session_plans；稽核進 mcp_audit_log（client_name=admin_ui，前後值）
 *   [4] 錯誤路徑：找不到、場次對不上、聯絡方式全空、並行（stale）、觸發器擋下 → 不寫稽核
 *   [5] 靜態：server fn 掛 adminFnMiddleware（與移除報名同一層）＋共用 zod；repo 的 update
 *       payload 只有三個鍵；名單頁只對 admin 顯示「編輯」
 *
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15（module.registerHooks）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/registration-edit-selftest.mjs";
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
const readFile = (p) => {
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};
const stripTs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── 假的 Supabase ───────────────────────────────────────────────────────────
const log = { writes: [] };
let tables = {};
let forceUpdateError = null;
function resetDb(t) {
  tables = structuredClone(t);
  log.writes = [];
  forceUpdateError = null;
}
function builder(table) {
  const st = { op: "select", payload: null, filters: [], single: null };
  const b = {
    select: () => b,
    order: () => b,
    insert: (p) => ((st.op = "insert"), (st.payload = p), b),
    update: (p) => ((st.op = "update"), (st.payload = p), b),
    upsert: (p) => ((st.op = "upsert"), (st.payload = p), b),
    delete: () => ((st.op = "delete"), b),
    eq: (c, v) => (st.filters.push((r) => r[c] === v), b),
    is: (c, v) => (st.filters.push((r) => (r[c] ?? null) === v), b),
    in: (c, vs) => (st.filters.push((r) => vs.includes(r[c])), b),
    maybeSingle: () => ((st.single = "maybe"), b),
    then(resolve, reject) {
      try {
        if (st.op === "update" && forceUpdateError) {
          resolve({ data: null, error: forceUpdateError });
          return;
        }
        const rows = (tables[table] ?? []).filter((r) => st.filters.every((f) => f(r)));
        if (st.op !== "select") log.writes.push({ table, op: st.op, payload: st.payload });
        if (st.op === "update") for (const r of rows) Object.assign(r, st.payload);
        if (st.op === "insert") {
          resolve({ data: null, error: null });
          return;
        }
        resolve({ data: st.single ? (rows[0] ?? null) : rows, error: null });
      } catch (e) {
        reject(e);
      }
    },
  };
  return b;
}
globalThis.__fakeSupabase = {
  from: (t) => builder(t),
  rpc: async (name) => {
    log.writes.push({ table: `rpc:${name}`, op: "rpc" });
    return { data: null, error: null };
  },
};

function resolveTs(base) {
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand)) return pathToFileURL(cand).href;
  }
  return null;
}
const FAKE_ADMIN =
  "data:text/javascript," +
  encodeURIComponent("export const supabaseAdmin = () => globalThis.__fakeSupabase;");
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@/server/supabase-admin") return { url: FAKE_ADMIN, shortCircuit: true };
    if (spec === "@tanstack/react-start/server-only")
      return { url: "data:text/javascript,", shortCircuit: true };
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

const infoLines = [];
const origInfo = console.info;
console.info = (l) => infoLines.push(String(l));

const LIB = await import(join(SRC, "lib/admin/registration-edit.ts"));
const FLOW = await import(join(SRC, "server/registration-edit.ts"));

console.log("═══ 報名名單「編輯參加者」自檢 ═══");

// [1] ------------------------------------------------------------------------
console.log("\n[1] 輸入驗證");
const S = LIB.participantContactSchema;
const ok = (v) => S.safeParse(v);
const msgs = (v) => {
  const r = ok(v);
  return r.success ? [] : r.error.issues.map((i) => `${i.path[0]}:${i.message}`);
};
check(
  "合法輸入：清洗控制字元、壓空白、trim",
  ok({ name: "  王\u0007小明\t ", email: " a@b.co ", phone: " (02) 2345-6789 #12 " }).data,
  { name: "王 小明", email: "a@b.co", phone: "(02) 2345-6789 #12" },
);
check("Email、電話可以留空", ok({ name: "王", email: "", phone: "" }).success, true);
check("姓名清洗後是空的 → 中文錯誤", msgs({ name: " \u0000 ", email: "", phone: "" }), [
  "name:姓名不能空白",
]);
const NONE = { name: "王", email: null, phone: null };
check(
  "Email 有改且格式錯 → 中文錯誤（與前台結帳同一條規則）",
  LIB.contactFormatErrors(NONE, { name: "王", email: "abc", phone: null }),
  { email: "Email 格式不正確" },
);
check(
  "電話有改且含英文字母 → 中文錯誤",
  LIB.contactFormatErrors(NONE, { name: "王", email: null, phone: "09ab" }),
  { phone: "電話只能填數字、空白與 + ( ) - #" },
);
check(
  "舊資料 Email（taro..yamada@docomo.ne.jp）沒改 → 不驗格式；改成這種前台收過的格式也接受",
  [
    LIB.contactFormatErrors(
      { name: "王", email: "taro..yamada@docomo.ne.jp", phone: "abc" },
      { name: "王大", email: "taro..yamada@docomo.ne.jp", phone: "abc" },
    ),
    LIB.contactFormatErrors(NONE, { name: "王", email: "taro..yamada@docomo.ne.jp", phone: null }),
  ],
  [{}, {}],
);
check(
  "Email 規則就是前台結帳那一條（CHECKOUT_EMAIL_RE）",
  /import \{ CHECKOUT_EMAIL_RE \} from "@\/lib\/checkout"/.test(
    readFile(join(SRC, "lib/admin/registration-edit.ts")),
  ) && /!CHECKOUT_EMAIL_RE\.test\(/.test(readFile(join(SRC, "lib/checkout.ts"))),
  true,
);
check(
  "電話允許 +()-# 與空白",
  ok({ name: "王", email: "", phone: "+886 (9) 12-345#6" }).success,
  true,
);
check(
  "長度上限（量清洗後）：姓名 60、電話 30、Email 254",
  [
    ok({ name: "名".repeat(60), email: "", phone: "" }).success,
    ok({ name: "名".repeat(61), email: "", phone: "" }).success,
    ok({ name: "王", email: "", phone: "1".repeat(31) }).success,
    ok({ name: "王", email: `${"a".repeat(250)}@b.co`, phone: "" }).success,
  ],
  [true, false, false, false],
);
check(
  "server fn 輸入是 strict：多帶 order_id／payment_status 直接拒絕",
  LIB.updateRegistrationParticipantInput.safeParse({
    registrationId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    expected: { name: "王", email: null, phone: null },
    name: "王",
    email: "",
    phone: "",
    order_id: "x",
    payment_status: "pending",
  }).success,
  false,
);
check(
  "server fn 輸入：沒帶 expected（開啟時的原值）→ 拒絕",
  LIB.updateRegistrationParticipantInput.safeParse({
    registrationId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    name: "王",
    email: "",
    phone: "",
  }).success,
  false,
);
check(
  "server fn 輸入：registrationId 不是 UUID → 拒絕",
  LIB.updateRegistrationParticipantInput.safeParse({
    registrationId: "abc",
    sessionId: "22222222-2222-4222-8222-222222222222",
    expected: { name: "王", email: null, phone: null },
    name: "王",
    email: "",
    phone: "",
  }).success,
  false,
);

// [2] ------------------------------------------------------------------------
console.log("\n[2] 差異與聯絡方式規則");
check(
  "diff 只列有變的欄位，空字串視同 null",
  LIB.diffParticipantContact(
    { name: "王", email: null, phone: "0912" },
    { name: "王", email: "", phone: "0922" },
  ),
  { phone: { before: "0912", after: "0922" } },
);
check(
  "contactRequiredError：前台訂單兩項都空 → 擋；電話報名 → 放行；有一項 → 放行",
  [
    typeof LIB.contactRequiredError({ name: "a", email: null, phone: null }, "web"),
    LIB.contactRequiredError({ name: "a", email: null, phone: null }, "admin_phone"),
    LIB.contactRequiredError({ name: "a", email: null, phone: "1" }, "web"),
  ],
  ["string", null, null],
);

// [3] ------------------------------------------------------------------------
const U = (n) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const REG_WEB = U(1);
const REG_PHONE2 = U(2);
const SESS = U(3);
const ORDER_WEB = U(4);
const ORDER_PHONE = U(5);
const ADMIN = { userId: U(6), email: "boss@example.com" };
const BASE = {
  orders: [
    {
      id: ORDER_WEB,
      order_no: "IB-1",
      source: "web",
      payment_status: "pending",
      total: 600,
      status: "pending",
    },
    {
      id: ORDER_PHONE,
      order_no: "IB-202600001231",
      source: "admin_phone",
      payment_status: "pending",
      total: 900,
      status: "pending",
    },
  ],
  event_registrations: [
    {
      id: REG_WEB,
      session_id: SESS,
      order_id: ORDER_WEB,
      order_item_id: 1,
      seat_no: 1,
      name: "王小明",
      email: "wang@example.com",
      phone: null,
      notice_ack_at: "2026-11-01T00:00:00Z",
    },
    {
      id: REG_PHONE2,
      session_id: SESS,
      order_id: ORDER_PHONE,
      order_item_id: 2,
      seat_no: 2,
      name: "林大同 同行者 1",
      email: null,
      phone: null,
      notice_ack_at: null,
    },
  ],
};
// expected 預設＝目前資料庫裡的值（＝店員打開 Dialog 時看到的）；測並發時另外給。
const currentOf = (id) => {
  const r = tables.event_registrations.find((x) => x.id === id);
  return r
    ? { name: r.name, email: r.email, phone: r.phone }
    : { name: "x", email: null, phone: null };
};
const edit = (data) =>
  FLOW.editRegistrationParticipantAsAdmin(
    { sessionId: SESS, expected: currentOf(data.registrationId), ...data },
    ADMIN,
  );
const dataWrites = () => log.writes.filter((w) => w.table !== "mcp_audit_log");
const auditWrites = () => log.writes.filter((w) => w.table === "mcp_audit_log");

console.log("\n[3] 後台流程：只改三欄、稽核記前後值");
resetDb(BASE);
infoLines.length = 0;
{
  const r = await edit({
    registrationId: REG_PHONE2,
    name: "陳美麗",
    email: "chen@example.com",
    phone: "0933 111 222",
  });
  check(
    "同行者補填聯絡資料＋換人 → updated",
    [r.reason, r.fields, r.audit],
    ["updated", ["name", "email", "phone"], "recorded"],
  );
  const w = dataWrites();
  check(
    "只寫 event_registrations 一次、payload 只有 name／email／phone",
    w.map((x) => [x.table, x.op, Object.keys(x.payload).sort()]),
    [["event_registrations", "update", ["email", "name", "phone"]]],
  );
  check(
    "訂單列（付款狀態、金額、狀態）原封不動",
    tables.orders.find((o) => o.id === ORDER_PHONE),
    BASE.orders[1],
  );
  const row = tables.event_registrations.find((x) => x.id === REG_PHONE2);
  check(
    "參加者列：三欄改了，order_id／session_id／seat_no／order_item_id／notice_ack_at 沒動",
    [
      row.name,
      row.email,
      row.phone,
      row.order_id,
      row.session_id,
      row.seat_no,
      row.order_item_id,
      row.notice_ack_at,
    ],
    ["陳美麗", "chen@example.com", "0933 111 222", ORDER_PHONE, SESS, 2, 2, null],
  );
  const a = auditWrites()[0]?.payload;
  check(
    "稽核：mcp_audit_log 一筆、admin_ui、actor 是那位 admin、記前後值",
    [
      auditWrites().length,
      a?.client_name,
      a?.actor_user_id,
      a?.actor_email,
      a?.actor_via,
      a?.dry_run,
      a?.tool,
      a?.entity,
      a?.entity_id,
      a?.action,
      a?.changes?.order_no,
      a?.changes?.fields,
    ],
    [
      1,
      "admin_ui",
      ADMIN.userId,
      ADMIN.email,
      null,
      false,
      "admin_update_registration_participant",
      "event_registration",
      REG_PHONE2,
      "update_participant",
      "IB-202600001231",
      {
        name: { before: "林大同 同行者 1", after: "陳美麗" },
        email: { before: null, after: "chen@example.com" },
        phone: { before: null, after: "0933 111 222" },
      },
    ],
  );
  check(
    "伺服器 log 只印欄位名，不印姓名／信箱／電話",
    [
      infoLines.length,
      infoLines.some((l) => /陳美麗|chen@example\.com|0933|林大同/.test(l)),
      infoLines.some((l) => l.includes('"fields":["name","email","phone"]')),
    ],
    [1, false, true],
  );
}
resetDb(BASE);
{
  const r = await edit({
    registrationId: REG_WEB,
    name: "王小明",
    email: "wang@example.com",
    phone: "",
  });
  check("沒有變更 → unchanged、不寫任何東西", [r.reason, log.writes.length], ["unchanged", 0]);
}
resetDb(BASE);
{
  const r = await edit({
    registrationId: REG_PHONE2,
    name: "林大同 同行者 1",
    email: "",
    phone: "",
  });
  check("電話報名的同行者：兩項都空也可以（沒變更）", r.reason, "unchanged");
}

resetDb(BASE);
{
  // 舊資料姓名結尾帶全形空白：樂觀鎖必須用資料庫原值，否則永遠 stale（審查 2026-11-05）。
  tables.event_registrations[0].name = "王小明\u3000";
  const r = await edit({
    registrationId: REG_WEB,
    name: "王大明",
    email: "wang@example.com",
    phone: "",
  });
  check(
    "姓名帶全形空白的舊資料也改得動（樂觀鎖用原值）",
    [r.reason, tables.event_registrations[0].name],
    ["updated", "王大明"],
  );
}

resetDb(BASE);
{
  // 驗收 2026-11-05：A、B 同時開 Dialog（email=wang@），B 先把 email 改成 b@ 存檔，
  // A 只改姓名後存檔 → 必須 stale，不能把 B 的 email 悄悄改回 wang@。
  const openedByA = currentOf(REG_WEB);
  const b = await edit({
    registrationId: REG_WEB,
    name: "王小明",
    email: "b@example.com",
    phone: "",
  });
  const a = await edit({
    registrationId: REG_WEB,
    expected: openedByA,
    name: "王大明",
    email: "wang@example.com",
    phone: "",
  });
  const row = tables.event_registrations.find((x) => x.id === REG_WEB);
  check(
    "開 Dialog 後別人先改 → stale（中文）、不覆蓋、只有 B 那一筆稽核",
    [
      b.reason,
      a.reason,
      /重新整理/.test(a.message ?? ""),
      row.name,
      row.email,
      auditWrites().length,
    ],
    ["updated", "stale", true, "王小明", "b@example.com", 1],
  );
}
resetDb(BASE);
{
  // 驗收 2026-11-05：舊 Email 不符合嚴格規則，也不能擋住改姓名。
  tables.event_registrations[0].email = "taro..yamada@docomo.ne.jp";
  const r = await edit({
    registrationId: REG_WEB,
    name: "山田太郎",
    email: "taro..yamada@docomo.ne.jp",
    phone: "",
  });
  check(
    "舊 Email（taro..yamada@…）只改姓名 → updated",
    [r.reason, r.fields],
    ["updated", ["name"]],
  );
}
resetDb(BASE);
{
  const r = await edit({ registrationId: REG_WEB, name: "王小明", email: "abc", phone: "" });
  check(
    "Email 改成格式錯的 → invalid（中文）、不寫",
    [r.reason, r.message, log.writes.length],
    ["invalid", "Email 格式不正確", 0],
  );
}

// [4] ------------------------------------------------------------------------
console.log("\n[4] 錯誤路徑都不寫（也不寫稽核）");
async function expectNoWrite(label, data, reason, setup) {
  resetDb(BASE);
  if (setup) setup();
  const r = await edit(data);
  check(
    label,
    [r.reason, typeof r.message, dataWrites().length, auditWrites().length],
    [
      reason,
      "string",
      reason === "stale" || reason === "contact_required" ? dataWrites().length : 0,
      0,
    ],
  );
}
await expectNoWrite(
  "找不到參加者 → not_found",
  { registrationId: U(9), name: "a", email: "", phone: "1" },
  "not_found",
);
{
  resetDb(BASE);
  const r = await FLOW.editRegistrationParticipantAsAdmin(
    { registrationId: REG_WEB, sessionId: U(8), name: "a", email: "", phone: "1" },
    ADMIN,
  );
  check("場次對不上 → wrong_session、不寫", [r.reason, log.writes.length], ["wrong_session", 0]);
}
{
  resetDb(BASE);
  const r = await edit({ registrationId: REG_WEB, name: "王小明", email: "", phone: "" });
  check(
    "前台訂單把 Email 與電話都清空 → contact_required（中文）、不寫",
    [r.reason, /至少要留一項/.test(r.message), log.writes.length],
    ["contact_required", true, 0],
  );
}
{
  resetDb(BASE);
  // 別人剛改過：資料庫裡的姓名已經不是畫面讀到的那個。plan 讀到的是新值，所以要模擬
  // 「plan 之後、update 之前」被改——直接讓 update 的條件對不上。
  const origFrom = globalThis.__fakeSupabase.from;
  globalThis.__fakeSupabase.from = (t) => {
    const b = origFrom(t);
    if (t !== "event_registrations") return b;
    const origUpdate = b.update;
    b.update = (p) => {
      tables.event_registrations[0].name = "別人改的";
      return origUpdate(p);
    };
    return b;
  };
  const r = await edit({
    registrationId: REG_WEB,
    name: "新名字",
    email: "wang@example.com",
    phone: "",
  });
  globalThis.__fakeSupabase.from = origFrom;
  check(
    "並行修改（樂觀鎖對不上）→ stale、沒有蓋掉、不寫稽核",
    [r.reason, tables.event_registrations[0].name, auditWrites().length],
    ["stale", "別人改的", 0],
  );
}
{
  resetDb(BASE);
  forceUpdateError = { code: "23514", message: "violates check constraint" };
  const r = await edit({
    registrationId: REG_WEB,
    name: "王小明",
    email: "x@example.com",
    phone: "",
  });
  check(
    "觸發器 event_registrations_contactable 擋下（23514）→ contact_required、不寫稽核",
    [r.reason, auditWrites().length],
    ["contact_required", 0],
  );
}
{
  resetDb(BASE);
  forceUpdateError = { code: "XX000", message: "boom 王小明" };
  let threw = null;
  const errLines = [];
  const origErr = console.error;
  console.error = (l) => errLines.push(String(l));
  try {
    await edit({ registrationId: REG_WEB, name: "王小明", email: "x@example.com", phone: "" });
  } catch (e) {
    threw = e.message;
  }
  console.error = origErr;
  check(
    "其他資料庫錯誤 → 丟例外（訊息只有 code）、不寫稽核",
    [typeof threw, /王小明/.test(threw ?? ""), auditWrites().length],
    ["string", false, 0],
  );
}

// [5] ------------------------------------------------------------------------
console.log("\n[5] 靜態");
const fnSrc = stripTs(readFile(join(SRC, "lib/admin/fns/registration-edit.ts")));
check(
  "server fn 掛 adminFnMiddleware（與 deleteAdminRegistration 同一層）、POST",
  /updateRegistrationParticipant = createServerFn\(\{ method: "POST" \}\)\s*\.middleware\(\[adminFnMiddleware\]\)/.test(
    fnSrc,
  ),
  true,
);
check(
  "server fn 用共用的 zod（updateRegistrationParticipantInput）",
  /\.inputValidator\(updateRegistrationParticipantInput\)/.test(fnSrc),
  true,
);
check(
  "server fn 的 actor 來自 context.admin（不看前端送什麼）",
  /editRegistrationParticipantAsAdmin\(data, context\.admin\)/.test(fnSrc),
  true,
);
const delFn = stripTs(readFile(join(SRC, "lib/admin/fns/event-registrations.ts")));
check(
  "對照：移除報名也是 adminFnMiddleware",
  /deleteAdminRegistration = createServerFn\(\{ method: "POST" \}\)\s*\.middleware\(\[adminFnMiddleware\]\)/.test(
    delFn,
  ),
  true,
);
const repoSrc = stripTs(readFile(join(SRC, "server/repos/event-registration-contacts.ts")));
check(
  "repo 的 update payload 只有 name／email／phone",
  /const payload = \{ name: after\.name, email: after\.email, phone: after\.phone \};/.test(
    repoSrc,
  ) &&
    (repoSrc.match(/\.update\(/g) ?? []).length === 1 &&
    /\.update\(payload\)/.test(repoSrc),
  true,
);
check("repo 不 delete／upsert、不呼叫 rpc", /\.(delete|upsert|rpc)\(/.test(repoSrc), false);
check(
  "repo 唯一的 insert 是 mcp_audit_log",
  (repoSrc.match(/\.insert\(/g) ?? []).length === 1 &&
    /from\("mcp_audit_log"\)\.insert\(/.test(repoSrc),
  true,
);
check(
  "repo 不寫 orders（只 select）",
  /from\("orders"\)\s*\.(update|insert|delete|upsert)/.test(repoSrc),
  false,
);
const route = readFile(join(SRC, "routes/admin/_shell.registrations_.$sessionId.index.tsx"));
check(
  "名單頁只對 admin 顯示「編輯」",
  /canEditParticipant=\{user\.role === "admin"\}/.test(route),
  true,
);

console.info = origInfo;
console.log(
  fail === 0
    ? green(`\n✓ 全部通過：${pass} passed, 0 failed`)
    : red(`\n✗ 有失敗：${pass} passed, ${fail} failed`),
);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
