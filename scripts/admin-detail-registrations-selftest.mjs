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
 *   [3] 名單（業主 2026-10-26 撤掉查看紀錄）：listSessionRoster() 不寫 pii_access_log，
 *       放在名單頁（index route）自己的 loader（30 秒快取、Link 滑過預載）；整頁 fn（/edit 也用）
 *       仍不含個資；權限 staffFnMiddleware()＋event.roster.read 不變；移除報名後 invalidate 重抓。
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
  checkTrue("編輯頁沒有自己的 loader（共用 layout）", !/loader:/.test(src(EDIT)));
  {
    const loader = between(src(ROSTER), "loader: async", "\n  },");
    const calls = [...loader.matchAll(/await (\w+)\(\{/g)].map((m) => m[1]);
    check("名單頁的 loader 只叫 listSessionRoster", calls, ["listSessionRoster"]);
    checkTrue(
      "名單頁 loader 先檢查 isUuid",
      /if \(!isUuid\(params\.sessionId\)\) return \{ roster: null, rosterError: null \};/.test(
        loader,
      ),
    );
    checkTrue(
      "名單頁 loader 沒有自訂 staleTime（沿用後台 30 秒預設）",
      !/staleTime/.test(src(ROSTER)),
    );
  }
  for (const f of [LAYOUT, NEW])
    checkTrue(`${f}：head() 標題含「小時光書店後台」`, /小時光書店後台/.test(src(f)));
  checkTrue(
    "找不到場次 → AdminDetailNotFound",
    /AdminDetailNotFound/.test(src(ROSTER)) && /AdminDetailNotFound/.test(src(EDIT)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 名單：不寫查看紀錄、放進 loader、權限不變");
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
      `整頁 fn 不碰 ${bad}（/edit 共用的 loader 資料不含個資）`,
      decl.length > 200 && !decl.includes(bad),
    );
  }

  const routeFiles = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name)) routeFiles.push(rel);
    }
  };
  walk("src");
  check(
    "全站（fns／repo 以外）只有名單頁的 route 呼叫 listSessionRoster()",
    routeFiles
      .filter((f) => /listSessionRoster\(\{/.test(src(f)))
      .filter((f) => !f.startsWith("src/lib/admin/fns/") && !f.startsWith("src/server/")),
    [ROSTER],
  );

  const regFns = src("src/lib/admin/fns/event-registrations.ts");
  const listDecl = between(regFns, "export const listSessionRoster", "\n  });");
  checkTrue(
    "🔴 listSessionRoster：GET＋staffFnMiddleware()（只讀，不清後台快取）",
    /export const listSessionRoster = createServerFn\(\{ method: "GET" \}\)\s*\.middleware\(\[staffFnMiddleware\(\)\]\)/.test(
      regFns,
    ),
  );
  checkTrue(
    "🔴 listSessionRoster：handler 第一件事是 requireRosterRead（event.roster.read）",
    /\.handler\(async \(\{ data, context \}\) => \{\s*await requireRosterRead\(context\.staff\.permissions\);/.test(
      listDecl,
    ),
  );
  const repo = src("src/server/repos/event-registrations.ts");
  checkTrue("🔴 repo 不再呼叫 pii_log_access", !/pii_log_access/.test(repo));

  const page = src(ROSTER_PAGE);
  checkTrue(
    "名單頁元件自己不打 listSessionRoster（資料從 loader 來）",
    !/listSessionRoster/.test(page),
  );
  checkTrue("名單頁沒有掛載時讀名單的 effect", !/useEffect|startedRef/.test(page));
  checkTrue("畫面不再印紀錄編號", !/log_id|紀錄編號|存取紀錄/.test(page));
  checkTrue(
    "名單頁的 route 用 key={data.session.id}",
    /<SessionRosterPage\s+key=\{data\.session\.id\}/.test(src(ROSTER)),
  );

  const linkSources = [];
  for (const rel of routeFiles.filter((f) => f.endsWith(".tsx"))) {
    for (const m of src(rel).matchAll(
      /<Link\b[^>]*?to="\/admin\/registrations\/\$sessionId"[^>]*>/g,
    )) {
      linkSources.push([rel, m[0]]);
    }
  }
  checkTrue("找得到連到名單頁的 Link", linkSources.length >= 1);
  for (const [rel, tag] of linkSources) {
    checkTrue(
      `${rel}：連到名單頁的 Link 滑過就預載（preload="intent"）`,
      /preload="intent"/.test(tag),
    );
  }

  const onRemoved = between(page, "onRemoved={async () => {", "}}");
  checkTrue(
    "移除後 router.invalidate()（loader 重抓名單＋列表數字）",
    /await router\.invalidate\(\)/.test(onRemoved),
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
    "🔴 dirty ＝ 場次欄位（比值）或 票種對話框改到一半（存檔中也攔，成功由 allowLeave 放行）",
    /useFormDirty\(form\.watch\(\)\)/.test(form) &&
      /useUnsavedChangesGuard\(fieldsDirty \|\| planDirty\)/.test(form) &&
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
      /await router\.invalidate\(\{ sync: true \}\);\s*if \(backIfPreviousIs\(router\.history, /.test(
        saved,
      ) &&
        saved.includes(backs) &&
        /navigate\(\{ to: "\/admin\/registrations", replace: true \}\)/.test(saved),
    );
  }
  checkTrue(
    "票種寫完 router.invalidate()（票種清單更新，不重新掛載表單）",
    /onPlansChanged=\{async \(\) => \{\s*await router\.invalidate\(\{ sync: true \}\);/.test(
      src(EDIT),
    ),
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
