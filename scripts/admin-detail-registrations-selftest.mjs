#!/usr/bin/env node
/**
 * 後台第 2 批（2026-10-25）：「活動報名」的名單彈窗與場次新增／編輯彈窗改成內頁的自檢。
 * 業主：「不要用彈窗，直接顯示內頁＆回到上一頁」。
 *
 *   /admin/registrations/$sessionId        報名名單（SessionRosterPage）
 *   /admin/registrations/$sessionId/edit   編輯場次＋票種（SessionForm＋SessionPlansEditor）
 *   /admin/registrations/new               新增場次
 *
 *   [1] 三個網址都在、列表連得進去。
 *   [2] loader：每個 route 只叫一支 fn（getEventSessionPageData），GET＋staffFnMiddleware()
 *       ＋event.roster.read（與原本彈窗的資料來源 getAdminRegistrationsPageData 相同）。
 *   [3] 🔴 個資紀錄：listSessionRoster()（每呼叫一次先寫一筆 pii_access_log）不在任何 loader、
 *       不在整頁 fn 裡；只在名單頁元件掛載時呼叫一次；連到名單頁的 Link 一律 preload={false}；
 *       移除報名之後不重打名單。
 *   [4] 表單：useUnsavedChangesGuard＋guard.dialog＋allowLeave；票種對話框改到一半也算 dirty；
 *       只在掛載時初始化（key={sessionId}）；存檔後 invalidate 再回上一頁／列表。
 *   [5] 舊彈窗拆乾淨；列表沒有 loader 資料的 useState 副本；刪除確認仍是 AlertDialog。
 *   [6] 現在會被 SSR 的地方不自己格式化日期（React #418）。
 *
 * 全部是靜態原始碼檢查，不連資料庫。執行：node scripts/admin-detail-registrations-selftest.mjs
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-detail-registrations-selftest.mjs";
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
const checkTrue = (label, v) => check(label, !!v, true);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const src = (rel) => stripComments(read(rel));
function between(s, start, end) {
  const a = s.indexOf(start);
  if (a === -1) return "";
  const b = s.indexOf(end, a + start.length);
  return b === -1 ? s.slice(a) : s.slice(a, b);
}

const R = "src/routes/admin/";
const LIST = `${R}_shell.registrations.tsx`;
const LAYOUT = `${R}_shell.registrations_.$sessionId.tsx`;
const ROSTER = `${R}_shell.registrations_.$sessionId.index.tsx`;
const EDIT = `${R}_shell.registrations_.$sessionId.edit.tsx`;
const NEW = `${R}_shell.registrations_.new.tsx`;
const ROSTER_PAGE = "src/components/admin/SessionRosterPage.tsx";
const ROSTER_TABLE = "src/components/admin/SessionRosterTable.tsx";
const FORM = "src/components/admin/SessionForm.tsx";
const PLANS = "src/components/admin/SessionPlansEditor.tsx";
const FNS = "src/lib/admin/fns/event-sessions.ts";

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] 三個網址都在、列表連得進去");
{
  for (const f of [LAYOUT, ROSTER, EDIT, NEW, ROSTER_PAGE, ROSTER_TABLE, FORM]) {
    checkTrue(`檔案存在：${f}`, existsSync(join(ROOT, f)));
  }
  const tree = read("src/routeTree.gen.ts");
  for (const p of [
    "/admin/registrations/$sessionId",
    "/admin/registrations/$sessionId/edit",
    "/admin/registrations/new",
  ]) {
    checkTrue(`routeTree 有 ${p}`, tree.includes(`'${p}'`));
  }
  check(
    "route id 照慣例（_ 讓它不巢在列表底下）",
    [
      /createFileRoute\("\/admin\/_shell\/registrations_\/\$sessionId"\)/.test(src(LAYOUT)),
      /createFileRoute\("\/admin\/_shell\/registrations_\/\$sessionId\/"\)/.test(src(ROSTER)),
      /createFileRoute\("\/admin\/_shell\/registrations_\/\$sessionId\/edit"\)/.test(src(EDIT)),
      /createFileRoute\("\/admin\/_shell\/registrations_\/new"\)/.test(src(NEW)),
    ],
    [true, true, true, true],
  );
  const list = src(LIST);
  checkTrue("列表 → 名單頁", /to="\/admin\/registrations\/\$sessionId"\s/.test(list));
  checkTrue("列表 → 編輯頁", /to="\/admin\/registrations\/\$sessionId\/edit"/.test(list));
  checkTrue("列表 → 新增頁", /to="\/admin\/registrations\/new"/.test(list));
  checkTrue(
    "列表點進去前記下那一列（pendingComponent 先畫標題）",
    (list.match(/rememberAdminPeek\("event-session", s\.id, s\)/g) ?? []).length === 2 &&
      /readAdminPeek<SessionRow>\("event-session", sessionId\)/.test(src(LAYOUT)),
  );
  checkTrue(
    "名單頁 → 編輯場次",
    /to="\/admin\/registrations\/\$sessionId\/edit"/.test(src(ROSTER_PAGE)),
  );
  // 名單頁的標題（場次名、時間）由 loader 資料畫：session 是 prop，不等名單回來。
  const page = src(ROSTER_PAGE);
  checkTrue(
    "名單頁標題用 loader 給的場次名與時間",
    /title=\{`\$\{session\.title\.zh\} 報名名單`\}/.test(page) &&
      /formatTaipeiDateTime\(session\.starts_at\)/.test(page),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] loader：一支 fn、授權與原本相同");
{
  const fns = src(FNS);
  const decl = between(fns, "export const getEventSessionPageData", "\n  });");
  checkTrue(
    "🔴 getEventSessionPageData：GET＋staffFnMiddleware()",
    /export const getEventSessionPageData = createServerFn\(\{ method: "GET" \}\)\s*\.middleware\(\[staffFnMiddleware\(\)\]\)/.test(
      fns,
    ),
  );
  checkTrue(
    "🔴 getEventSessionPageData：handler 第一件事是 requireRosterRead（event.roster.read）",
    /\.handler\(async \(\{ data, context \}\) => \{\s*await requireRosterRead\(context\.staff\.permissions\);/.test(
      decl,
    ),
  );
  checkTrue(
    "原本的 getAdminRegistrationsPageData 也是同一組授權（沒有放寬）",
    /export const getAdminRegistrationsPageData = createServerFn\(\{ method: "GET" \}\)\s*\.middleware\(\[staffFnMiddleware\(\)\]\)/.test(
      fns,
    ),
  );
  const decls = [...fns.matchAll(/export const (\w+) = createServerFn\([^)]*\)\s*(\.\w+)/g)];
  check(
    "🔴 fns/event-sessions.ts：每一支 server fn 都先掛 middleware",
    decls.filter((m) => m[2] !== ".middleware").map((m) => m[1]),
    [],
  );
  checkTrue(
    "寫入仍是 adminFnMiddleware（upsertEventSession）",
    /export const upsertEventSession = createServerFn\(\{ method: "POST" \}\)\s*\.middleware\(\[adminFnMiddleware\]\)/.test(
      fns,
    ),
  );

  for (const [f, expectArg] of [
    [LAYOUT, "{ data: { sessionId: params.sessionId } }"],
    [NEW, "{ data: { sessionId: null } }"],
  ]) {
    const s = src(f);
    const loader = between(s, "loader: async", "\n  },");
    checkTrue(
      `${f}：loader 叫 getEventSessionPageData(${expectArg})`,
      loader.includes(`getEventSessionPageData(${expectArg})`),
    );
    const calls = [...loader.matchAll(/await (\w+)\(\{/g)].map((m) => m[1]);
    check(`${f}：loader 只叫一支 server fn`, calls, ["getEventSessionPageData"]);
  }
  checkTrue(
    "layout loader 先檢查 isUuid，不是就回 { data: null }",
    /if \(!isUuid\(params\.sessionId\)\) return \{ data: null \};/.test(src(LAYOUT)),
  );
  checkTrue(
    "名單頁與編輯頁沒有自己的 loader（共用 layout）",
    !/loader:/.test(src(ROSTER)) && !/loader:/.test(src(EDIT)),
  );
  for (const f of [LAYOUT, NEW])
    checkTrue(`${f}：head() 標題含「小時光書店後台」`, /小時光書店後台/.test(src(f)));
  checkTrue(
    "找不到場次 → AdminDetailNotFound",
    /AdminDetailNotFound/.test(src(ROSTER)) && /AdminDetailNotFound/.test(src(EDIT)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 🔴 個資紀錄：名單每次打開寫一筆，不被預載／重抓／invalidate 觸發");
{
  const fns = src(FNS);
  const decl = between(fns, "export const getEventSessionPageData", "\n  });");
  for (const bad of [
    "listSessionRoster",
    "pii_log_access",
    "event-registrations",
    "admin_event_roster",
    "event_registrations",
  ]) {
    checkTrue(
      `🔴 整頁 fn 不碰 ${bad}（loader 資料不含個資）`,
      decl.length > 200 && !decl.includes(bad),
    );
  }

  // 整個 src/routes 底下沒有任何地方呼叫 listSessionRoster（loader、beforeLoad、元件都不行）。
  const routeFiles = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name)) routeFiles.push(rel);
    }
  };
  walk("src/routes");
  check(
    "🔴 src/routes 底下沒有任何檔案呼叫 listSessionRoster",
    routeFiles.filter((f) => /listSessionRoster/.test(src(f))),
    [],
  );
  const callers = [];
  const walkAll = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walkAll(rel);
      else if (/\.tsx?$/.test(e.name) && /listSessionRoster\(\{/.test(src(rel))) callers.push(rel);
    }
  };
  walkAll("src");
  // fns 與 repo 本身（定義與轉呼叫）不算「畫面上的呼叫端」。
  check(
    "🔴 全站（fns／repo 以外）只有名單頁呼叫 listSessionRoster()",
    callers.filter((f) => !f.startsWith("src/lib/admin/fns/") && !f.startsWith("src/server/")),
    [ROSTER_PAGE],
  );

  const page = src(ROSTER_PAGE);
  check("名單頁只呼叫一次", (page.match(/listSessionRoster\(\{/g) ?? []).length, 1);
  const effect = between(page, "const startedRef = useRef(false);", "}, []);");
  checkTrue(
    "🔴 名單在掛載時的 effect 裡讀（deps 是 []）",
    effect.includes("listSessionRoster({") && page.includes("}, []);"),
  );
  checkTrue(
    "🔴 startedRef 擋住同一次掛載跑第二次（StrictMode）",
    /if \(startedRef\.current\) return;\s*startedRef\.current = true;/.test(effect),
  );
  checkTrue(
    "名單頁的 route 用 key={data.session.id}：換場次＝重新掛載＝新的一筆；invalidate 不重新掛載",
    /<SessionRosterPage\s+key=\{data\.session\.id\}/.test(src(ROSTER)),
  );
  checkTrue(
    "畫面印出這次的紀錄編號",
    /setRosterLogId\(log_id\)/.test(page) && /這次查閱的紀錄編號/.test(page),
  );

  // 連到名單頁（不是 /edit）的每一個 Link 都要 preload={false}。
  const linkSources = [];
  walkAll2("src");
  function walkAll2(dir) {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walkAll2(rel);
      else if (/\.tsx$/.test(e.name)) {
        const s = src(rel);
        for (const m of s.matchAll(
          /<Link\b[^>]*?to="\/admin\/registrations\/\$sessionId"[^>]*>/g,
        )) {
          linkSources.push([rel, m[0]]);
        }
      }
    }
  }
  checkTrue("找得到連到名單頁的 Link", linkSources.length >= 1);
  for (const [rel, tag] of linkSources) {
    checkTrue(`🔴 ${rel}：連到名單頁的 Link 是 preload={false}`, /preload=\{false\}/.test(tag));
  }
  checkTrue(
    "沒有用 navigate／redirect 自動帶進名單頁（只有人點才開）",
    !routeFiles.some((f) =>
      /(navigate|redirect)\(\{\s*to: "\/admin\/registrations\/\$sessionId",/.test(src(f)),
    ),
  );

  // 移除報名之後：本地濾掉＋invalidate，不重打名單。
  const onRemoved = between(page, "onRemoved={async (registrationId) => {", "}}");
  checkTrue(
    "移除後本地濾掉那一列",
    /prev\.filter\(\(r\) => r\.registration_id !== registrationId\)/.test(onRemoved),
  );
  checkTrue(
    "移除後 router.invalidate()（列表數字更新）",
    /await router\.invalidate\(\)/.test(onRemoved),
  );
  checkTrue(
    "🔴 移除後不重打 listSessionRoster",
    onRemoved.length > 30 && !/listSessionRoster/.test(onRemoved),
  );
  checkTrue(
    "移除確認仍是 AlertDialog",
    /<AlertDialog\s+open=\{removeTarget !== null\}/.test(src(ROSTER_TABLE)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] 表單：未存變更防呆、只在掛載時初始化、存檔後回去");
{
  const form = src(FORM);
  checkTrue("🔴 SessionForm：掛 useUnsavedChangesGuard", /useUnsavedChangesGuard\(/.test(form));
  checkTrue("SessionForm：渲染 guard.dialog", /\{guard\.dialog\}/.test(form));
  checkTrue(
    "SessionForm：存檔成功先 allowLeave 再交給呼叫端換頁",
    /guard\.allowLeave\(\);\s*await onSaved\(\);/.test(form),
  );
  checkTrue(
    "🔴 dirty ＝ 場次欄位（比值）或 票種對話框改到一半，存檔中不攔",
    /useFormDirty\(form\.watch\(\)\)/.test(form) &&
      /useUnsavedChangesGuard\(\(fieldsDirty \|\| planDirty\) && !submitting\)/.test(form) &&
      /onDirtyChange=\{setPlanDirty\}/.test(form),
  );
  const plans = src(PLANS);
  checkTrue(
    "SessionPlansEditor 有 onDirtyChange",
    /onDirtyChange\?: \(dirty: boolean\) => void;/.test(plans),
  );
  checkTrue(
    "方案表單用 useFormDirty 比值並往上回報，卸載時歸零",
    /useFormDirty\(form\.watch\(\)\)/.test(plans) &&
      /reportRef\.current\?\.\(dirty\)/.test(plans) &&
      /useEffect\(\(\) => \(\) => reportRef\.current\?\.\(false\), \[\]\)/.test(plans),
  );
  checkTrue(
    "送出鈕在 form 外（頁首／手機底部）也送得出去",
    /form=\{FORM_ID\}/.test(form) && /<form id=\{FORM_ID\}/.test(form),
  );
  checkTrue(
    "表單內容底部另放一份動作（md 以上）",
    /<div className="hidden justify-end md:flex">\{actions\}<\/div>/.test(form),
  );
  checkTrue(
    "只在掛載時從 loader 初始化（useForm 的 defaultValues）",
    /useForm<EventSessionFormValues>\(\{[\s\S]{0,200}defaultValues: session/.test(form),
  );
  checkTrue(
    "編輯頁 key={sessionId}（換場次重新掛載）",
    /<SessionForm\s+key=\{sessionId\}/.test(src(EDIT)),
  );

  for (const [f, backs] of [
    [EDIT, '["/admin/registrations", rosterPath]'],
    [NEW, '["/admin/registrations"]'],
  ]) {
    const s = src(f);
    const saved = between(s, "onSaved={async () => {", "}}");
    checkTrue(
      `${f}：存檔後 invalidate → backIfPreviousIs → 否則 replace 回列表`,
      /await router\.invalidate\(\);\s*if \(backIfPreviousIs\(router\.history, /.test(saved) &&
        saved.includes(backs) &&
        /navigate\(\{ to: "\/admin\/registrations", replace: true \}\)/.test(saved),
    );
  }
  checkTrue(
    "票種寫完 router.invalidate()（票種清單更新，不重新掛載表單）",
    /onPlansChanged=\{async \(\) => \{\s*await router\.invalidate\(\);/.test(src(EDIT)),
  );
  checkTrue(
    "新增頁沒有票種區（還沒有場次 id 可以掛）",
    /\{session \? \(\s*<SessionPlansEditor/.test(form),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] 舊彈窗拆乾淨、列表形狀");
{
  const list = src(LIST);
  check(
    "列表沒有 Dialog（只剩 AlertDialog）",
    /<Dialog\b|(?<!Alert)DialogContent\b|from "@\/components\/ui\/dialog"/.test(list),
    false,
  );
  check(
    "列表不再有 SessionForm／名單 state",
    /function SessionForm|openRoster|setRosterOf|listSessionRoster|SessionPlansEditor/.test(list),
    false,
  );
  checkTrue(
    "刪除場次確認仍是 AlertDialog",
    /<AlertDialog\s+open=\{deleteTarget !== null\}/.test(list),
  );
  check(
    "列表沒有 useState(loader 資料) 的副本",
    /useState(<[^>]*>)?\((initial\w*|loader\w*)\)/.test(list),
    false,
  );
  checkTrue(
    "列表資料直接用 loader（沒有本地篩選，不需要 useLoaderBackedList）",
    /Route\.useLoaderData\(\)/.test(list) && !/useState<[^>]*>\(\s*sessions/.test(list),
  );
  checkTrue(
    "列表 loader 仍只叫 getAdminRegistrationsPageData",
    /getAdminRegistrationsPageData\(\)/.test(list),
  );
  checkTrue(
    "rosterReady=false 時名單鈕停用",
    /rosterReady \? \(/.test(list) &&
      /<Button variant="ghost" size="sm" disabled>\s*名單/.test(list),
  );
  checkTrue(
    "表格包 overflow-x-auto（手機不水平捲動整頁）",
    /overflow-x-auto/.test(list) && /overflow-x-auto/.test(src(ROSTER_TABLE)),
  );
  checkTrue("標題列 flex-wrap", /flex flex-wrap items-center justify-between/.test(list));
  for (const f of [LAYOUT, ROSTER, EDIT, NEW, ROSTER_PAGE, ROSTER_TABLE, FORM]) {
    const n = read(f).split("\n").length;
    checkTrue(`${f} 不超過 400 行（${n}）`, n <= 400);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6] 現在會被 SSR 的地方不自己格式化日期（React #418）");
{
  for (const f of [ROSTER_PAGE, PLANS, LAYOUT]) {
    const s = src(f);
    checkTrue(`${f}：用 formatTaipeiDateTime`, /formatTaipeiDateTime\(/.test(s));
    check(
      `${f}：沒有日期的 toLocaleString(…hour/minute…)`,
      /toLocale(Date|Time)String\(|toLocaleString\("zh-TW", \{\s*year/.test(s),
      false,
    );
  }
}

console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m`);
