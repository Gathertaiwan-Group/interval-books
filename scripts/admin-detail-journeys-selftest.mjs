#!/usr/bin/env node
/**
 * 後台第 2 批（2026-10-25）：策旅「編輯」從列表裡的 Dialog 改成內頁的自檢（靜態）。
 * 業主：「不要用彈窗，直接顯示內頁＆回到上一頁」。
 *
 *   [1] /admin/journeys/$id 的 loader 只叫一支 fn（getJourneyById），授權與原本的
 *       listJourneys／upsertJourney 相同（adminFnMiddleware）；有 pendingComponent。
 *   [2] JourneyForm：未存變更防呆、存檔成功 allowLeave → invalidate → 回上一頁或列表。
 *   [3] 列表：Dialog 與表單已移走；編輯是 Link preload="intent" + peek；不抄 loader 進 useState。
 *
 * 執行：node scripts/admin-detail-journeys-selftest.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/admin-detail-journeys-selftest.mjs";
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
const code = (rel) => stripComments(read(rel));

const EDIT = "src/routes/admin/_shell.journeys_.$id.tsx";
const LIST = "src/routes/admin/_shell.journeys.tsx";
const FORM = "src/components/admin/JourneyForm.tsx";
const FNS = "src/lib/admin/fns/journeys.ts";

function middlewareOf(src, name) {
  const i = src.indexOf(`export const ${name} = createServerFn`);
  if (i < 0) return null;
  const m = src
    .slice(i)
    .match(
      /^export const \w+ = createServerFn\(\{ method: "(\w+)" \}\)\s*\.middleware\(\[([^\]]*)\]\)/,
    );
  return m ? `${m[1]} ${m[2].trim()}` : null;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] 編輯內頁：loader 一支 fn、授權不放寬、pending");
{
  check(`${EDIT} 存在`, existsSync(join(ROOT, EDIT)), true);
  const fns = code(FNS);
  check(
    "🔴 getJourneyById：GET＋adminFnMiddleware",
    middlewareOf(fns, "getJourneyById"),
    "GET adminFnMiddleware",
  );
  check(
    "原本列表的 listJourneys：GET＋adminFnMiddleware",
    middlewareOf(fns, "listJourneys"),
    "GET adminFnMiddleware",
  );
  check(
    "寫入 upsertJourney：POST＋adminFnMiddleware",
    middlewareOf(fns, "upsertJourney"),
    "POST adminFnMiddleware",
  );
  const decls = [...fns.matchAll(/export const (\w+) = createServerFn\([^)]*\)\s*(\.\w+)/g)];
  check(
    "🔴 fns/journeys.ts：每一支 server fn 都先掛 middleware",
    decls.filter((m) => m[2] !== ".middleware").map((m) => m[1]),
    [],
  );

  const edit = code(EDIT);
  checkTrue(
    "route id 是 /admin/_shell/journeys_/$id",
    edit.includes('createFileRoute("/admin/_shell/journeys_/$id")'),
  );
  const loader = edit.slice(edit.indexOf("loader:"), edit.indexOf("head:"));
  checkTrue(
    "loader 叫 getJourneyById",
    loader.includes("getJourneyById({ data: { id: params.id } })"),
  );
  check("loader 只叫一支 server fn", (loader.match(/await \w+\(\{ data:/g) ?? []).length, 1);
  checkTrue(
    "🔴 loader 先擋形狀不對的 id（text 主鍵，不用 isUuid）",
    /if \(!JOURNEY_ID\.test\(params\.id\)\) return \{ journey: null \};[\s\S]*getJourneyById/.test(
      loader,
    ),
  );
  const re = new RegExp(edit.match(/const JOURNEY_ID = \/(.+)\/;/)?.[1] ?? "^$");
  check("id 形狀：randomUUID 通過", re.test("3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"), true);
  check("id 形狀：舊式 jo-1 通過", re.test("jo-1"), true);
  check(
    "id 形狀：帶斜線／空白的擋掉",
    [re.test("a/b"), re.test("a b"), re.test("")],
    [false, false, false],
  );
  checkTrue(
    "有 pendingComponent＋ADMIN_DETAIL_PENDING",
    /pendingComponent: \w+/.test(edit) && /\.\.\.ADMIN_DETAIL_PENDING/.test(edit),
  );
  checkTrue(
    "pending 先用列表那一列（readAdminPeek journey）",
    /readAdminPeek<JourneyRow>\("journey", id\)/.test(edit),
  );
  checkTrue("找不到 → AdminDetailNotFound", /AdminDetailNotFound/.test(edit));
  checkTrue("head 標題「…｜小時光書店後台」", /｜小時光書店後台/.test(read(EDIT)));
  checkTrue("key={journey.id}（換一筆重新掛載）", /key=\{journey\.id\}/.test(edit));
  checkTrue(
    "存檔 → invalidate → 回上一頁（列表），否則 replace 到列表",
    /await router\.invalidate\(\{ sync: true \}\);\s*if \(backIfPreviousIs\(router\.history, \["\/admin\/journeys"\]\)\) return;\s*await navigate\(\{ to: "\/admin\/journeys", replace: true \}\)/.test(
      edit,
    ),
  );
  checkTrue(
    "routeTree 有 /admin/journeys/$id",
    read("src/routeTree.gen.ts").includes("'/admin/journeys/$id'"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] JourneyForm：防呆與寫入");
{
  const form = code(FORM);
  checkTrue(
    "🔴 掛 useUnsavedChangesGuard(dirty)（存檔中也攔，成功由 allowLeave 放行）",
    /useUnsavedChangesGuard\(dirty\)/.test(form),
  );
  checkTrue(
    "dirty 比的是整張表單的值（useFormDirty(form.watch())）",
    /useFormDirty\(form\.watch\(\)\)/.test(form),
  );
  checkTrue("渲染 guard.dialog", /\{guard\.dialog\}/.test(form));
  checkTrue(
    "🔴 存檔成功先 allowLeave 再交給 onSaved 換頁",
    /guard\.allowLeave\(\);\s*await onSaved\(\)/.test(form),
  );
  checkTrue(
    "寫入仍只走 upsertJourney（帶原 id）",
    /upsertJourney\(\{ data: \{ \.\.\.values, id: journey\.id \} \}\)/.test(form),
  );
  checkTrue("驗證仍是 journeySchema（zodResolver）", /zodResolver\(journeySchema\)/.test(form));
  checkTrue(
    "三語欄位五個都在",
    ["title", "summary", "description", "days", "theme"].every((n) => form.includes(`name="${n}"`)),
  );
  checkTrue("用 AdminDetailPage 外框", /<AdminDetailPage/.test(form));
  checkTrue(
    "手機黏底部的儲存鈕綁同一張表單（form=journey-form）",
    /form="journey-form"/.test(form) && /id="journey-form"/.test(form),
  );
  checkTrue("沒有 Dialog", !/Dialog/.test(form));
  checkTrue(
    "並排欄位在手機上改單欄（sm:grid-cols-2）",
    !/"grid grid-cols-2/.test(form) && /sm:grid-cols-2/.test(form),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 列表");
{
  const list = code(LIST);
  checkTrue("🔴 列表沒有編輯 Dialog 了", !/<Dialog[\s>]|<DialogContent|useForm\(/.test(list));
  checkTrue("列表沒有 openEdit／JourneyForm", !/openEdit|JourneyForm/.test(list));
  checkTrue(
    "編輯是 Link 到 /admin/journeys/$id（preload=intent＋rememberAdminPeek）",
    /to="\/admin\/journeys\/\$id"[\s\S]{0,120}preload="intent"[\s\S]{0,120}rememberAdminPeek\("journey", j\.id, j\)/.test(
      list,
    ),
  );
  checkTrue("新增仍連到一頁新增", /to="\/admin\/journeys\/new"/.test(list));
  checkTrue("刪除確認仍是 AlertDialog", /<AlertDialog\b/.test(list) && /removeJourney/.test(list));
  check(
    "沒有 useState(loader 資料) 的副本",
    /useState(<[^>]*>)?\((initial\w*|loader\w*|journeys)\)/.test(list),
    false,
  );
  checkTrue("列表 loader 仍是 listJourneys", /listJourneys\(\)/.test(list));
  checkTrue(
    "沒有 beforeLoad redirect（原本就沒有會開彈窗的網址參數）",
    !/validateSearch|beforeLoad/.test(list),
  );
}

console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(`\x1b[31m✗ 有失敗：${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✓ 全部通過：${pass} passed, 0 failed\x1b[0m`);
