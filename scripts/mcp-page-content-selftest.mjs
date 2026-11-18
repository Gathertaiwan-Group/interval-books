#!/usr/bin/env node
/**
 * mcp-page-content-selftest.mjs —— MCP 頁面設定／清單項目（src/server/mcp/page-content-tools.ts）
 *
 *   [1] 形狀：三份匯出一致、annotations、dry_run 預設 true、不與既有工具撞名、get_page 說明提到兩支
 *   [2] OAuth：靜態 token 一律拒絕（含預覽），經 tools.ts 註冊路徑還會記 rejected 稽核
 *   [3] update_page_meta：預覽不寫（只記 dry_run=true 稽核）、只改送的欄位、confirm_args 帶回不重譯、
 *       正式寫入走 repo updatePageMeta、沒變不寫、必填欄位不能清空、找不到頁面
 *   [4] update_page_list_item：預覽不寫、帶回不重譯、走 repo upsertPageListItem 的修改分支
 *       （不 insert、不寫 sort_order、list_key 不變）、page_slug 不符拒絕、label 不能清空
 *   [5] 靜態：這個檔案不寫 update／insert／delete／upsert／rpc，tools.ts 有註冊
 *
 * 用假的 supabaseAdmin（記錄寫入）跑 production 的 handler 與 repo 本人；翻譯是假的，不打 Gemini。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SELF = "scripts/mcp-page-content-selftest.mjs";
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
const checkTrue = (label, cond) => check(label, Boolean(cond), true);
const readFile = (p) => {
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};

delete process.env.GEMINI_API_KEY;

// ── 假的 Supabase ───────────────────────────────────────────────────────────
const log = { rpc: [], writes: [] };
let tables = {};
let rpcData = {};
let nextId = 1000;
function resetDb(t, r) {
  tables = structuredClone(t);
  rpcData = structuredClone(r);
  log.rpc = [];
  log.writes = [];
}
function builder(table) {
  const st = { op: "select", payload: null, filters: [], single: null };
  const pass_ = () => b;
  const b = {
    select: pass_,
    order: pass_,
    limit: pass_,
    range: pass_,
    insert: (p) => ((st.op = "insert"), (st.payload = p), b),
    update: (p) => ((st.op = "update"), (st.payload = p), b),
    upsert: (p) => ((st.op = "upsert"), (st.payload = p), b),
    delete: () => ((st.op = "delete"), b),
    eq: (c, v) => (st.filters.push((r) => r[c] === v), b),
    in: (c, vs) => (st.filters.push((r) => vs.includes(r[c])), b),
    maybeSingle: () => ((st.single = "maybe"), b),
    single: () => ((st.single = "one"), b),
    then(resolve, reject) {
      try {
        const all = (tables[table] ??= []);
        if (st.op !== "select") log.writes.push({ table, op: st.op, payload: st.payload });
        if (st.op === "insert") {
          if (table === "mcp_oauth_used_codes" && all.some((r) => r.jti === st.payload.jti)) {
            resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
            return;
          }
          const row = { id: nextId++, ...st.payload };
          all.push(row);
          resolve({ data: st.single ? row : [row], error: null });
          return;
        }
        if (st.op === "upsert") {
          const i = all.findIndex((r) => r.id === st.payload.id);
          const row = i >= 0 ? Object.assign(all[i], st.payload) : { ...st.payload };
          if (i < 0) all.push(row);
          resolve({ data: st.single ? row : [row], error: null });
          return;
        }
        const rows = all.filter((r) => st.filters.every((f) => f(r)));
        if (st.op === "update") for (const r of rows) Object.assign(r, st.payload);
        const data = st.single ? (rows[0] ?? null) : rows;
        resolve({ data, error: null, count: rows.length });
      } catch (e) {
        reject(e);
      }
    },
  };
  return b;
}
globalThis.__fakeSupabase = {
  from: (t) => builder(t),
  rpc: async (name, args) => {
    log.rpc.push({ name, args });
    return { data: rpcData[name] ?? null, error: null };
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
// 假的翻譯（🔴 不打真的 Gemini）：只有 [6b] 暫時設 GEMINI_API_KEY 時才會被用到。
globalThis.__translateCalls = [];
const FAKE_TRANSLATE =
  "data:text/javascript," +
  encodeURIComponent(`
    export async function translateToEnJa({ text }) {
      globalThis.__translateCalls.push(text);
      return { en: "EN" + globalThis.__translateCalls.length + " " + text, ja: "JA " + text };
    }
  `);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@/server/supabase-admin") return { url: FAKE_ADMIN, shortCircuit: true };
    if (spec === "@/server/translate" || spec === "./translate")
      return { url: FAKE_TRANSLATE, shortCircuit: true };
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

const origInfo = console.info;
console.info = () => {};
const origError = console.error;

const MOD = await import(join(SRC, "server/mcp/page-content-tools.ts"));
const {
  PAGE_CONTENT_TOOL_INPUTS: INPUTS,
  PAGE_CONTENT_TOOL_META: META,
  PAGE_CONTENT_HANDLERS: H,
} = MOD;
const { runAsMcpActor } = await import(join(SRC, "server/mcp/actor.ts"));
const { z } = await import("zod4");

const OAUTH = {
  via: "oauth",
  user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "admin@example.com",
  client: "c",
  client_name: "Claude",
  access: "write",
};
const STATIC = { via: "static_token", access: "write" };
const asOAuth = (fn) => runAsMcpActor(OAUTH, fn);
const asStatic = (fn) => runAsMcpActor(STATIC, fn);
const parseOut = (r) => {
  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return r.content[0].text;
  }
};
const audits = () => log.writes.filter((w) => w.table === "mcp_audit_log").map((w) => w.payload);
const dataWrites = () =>
  log.writes.filter((w) => w.table !== "mcp_audit_log" && w.table !== "mcp_oauth_used_codes");

const L = (zh, en, ja) => ({ zh, en, ja });
const ABOUT = {
  slug: "about",
  meta_title: L("關於", "About", "について"),
  meta_description: L("每月一場讀書會。", "A reading circle every month.", "毎月の読書会。"),
  og_title: null,
  og_description: null,
  og_image_key: null,
  eyebrow_prefix: "About",
  eyebrow_suffix: L("關於", "About", "について"),
  header_title: L("標題", "Title", "タイトル"),
  header_intro: null,
  sort_order: 2,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
};
const INSIDE = {
  id: 17,
  page_slug: "visit",
  list_key: "inside",
  label: L("不定期舉辦讀書會", "Occasional reading circles", "読書会を随時開催"),
  note: null,
  image_key: null,
  sort_order: 3,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
};
const SEED = {
  pages: [ABOUT, { ...ABOUT, slug: "visit", sort_order: 3 }],
  page_list_items: [INSIDE, { ...INSIDE, id: 16, label: L("座位", "Seats", "席"), sort_order: 2 }],
};

console.log("═══ MCP 頁面設定／清單項目 自檢 ═══");

// [1] ------------------------------------------------------------------------
console.log("\n[1] 形狀");
const names = Object.keys(INPUTS).sort();
check("工具名單", names, ["update_page_list_item", "update_page_meta"]);
check(
  "INPUTS／META／HANDLERS 名單一致",
  [Object.keys(META).sort(), Object.keys(H).sort()],
  [names, names],
);
check(
  "都是寫入、非 destructive、idempotent",
  names.map((n) => [
    META[n].annotations.readOnlyHint,
    META[n].annotations.destructiveHint,
    META[n].annotations.idempotentHint,
  ]),
  [
    [false, false, true],
    [false, false, true],
  ],
);
check(
  "dry_run 預設 true",
  names.filter(
    (n) => z.toJSONSchema(INPUTS[n], { io: "input" }).properties?.dry_run?.default !== true,
  ),
  [],
);
check(
  "清單項目工具沒有新增／刪除／排序／list_key 參數",
  Object.keys(INPUTS.update_page_list_item.shape).filter((k) =>
    /sort|list_key|delete|remove|create|confirm/.test(k),
  ),
  [],
);
const existing = new Set();
for (const f of [
  "tools.ts",
  "admin-read-tools.ts",
  "create-tools.ts",
  "image-upload.ts",
  "ops-write-tools.ts",
  "outbound-tools.ts",
  "report-tools.ts",
  "pos-stock-tools.ts",
  "orders-events-tools.ts",
  "partners-content-tools.ts",
  "catalog-inventory-tools.ts",
]) {
  for (const m of readFile(join(SRC, "server/mcp", f)).matchAll(/^ {2}([a-z_]+): z/gm))
    existing.add(m[1]);
}
check(
  "不與既有 MCP 工具撞名",
  names.filter((n) => existing.has(n)),
  [],
);

// 經 tools.ts 的註冊路徑（add() 的讀寫分級與 rejected 稽核）
const registered = new Map();
const tools = await import(join(SRC, "server/mcp/tools.ts"));
tools.registerContentTools({
  registerTool: (name, meta, cb) => registered.set(name, { meta, cb }),
});
check(
  "tools.ts 註冊了兩支",
  names.map((n) => registered.has(n)),
  [true, true],
);
const getPageDesc = registered.get("get_page")?.meta.description ?? "";
checkTrue(
  "get_page 說明提到 update_page_meta 與 update_page_list_item",
  getPageDesc.includes("update_page_meta") && getPageDesc.includes("update_page_list_item"),
);

// [2] ------------------------------------------------------------------------
console.log("\n[2] OAuth");
for (const [n, args] of [
  ["update_page_meta", { slug: "about", meta_title: L("新", "New", "新しい") }],
  ["update_page_list_item", { page_slug: "visit", id: 17, label: L("新", "New", "新しい") }],
]) {
  resetDb(SEED, {});
  const r = await asStatic(() => H[n](args));
  checkTrue(`${n}：靜態 token 預覽 → 拒絕`, r.isError && /OAuth/.test(r.content[0].text));
  check(`${n}：靜態 token 沒寫任何東西`, log.writes.length, 0);
  resetDb(SEED, {});
  const r2 = await asStatic(() => registered.get(n).cb({ ...args, dry_run: false }));
  checkTrue(`${n}：經 tools.ts 正式送出 → 拒絕`, r2.isError);
  check(`${n}：沒有寫資料表`, dataWrites().length, 0);
  check(
    `${n}：記一筆 rejected 稽核`,
    audits().map((a) => [a.tool, a.action, a.actor_via]),
    [[n, "rejected", "static_token"]],
  );
}

// [3] ------------------------------------------------------------------------
console.log("\n[3] update_page_meta");
{
  resetDb(SEED, {});
  const desc = L("每月至少四場讀書會。", ABOUT.meta_description.en, ABOUT.meta_description.ja);
  const args = { slug: "about", meta_description: desc };
  const out = parseOut(await asOAuth(() => H.update_page_meta(args)));
  check("預覽：dry_run=true、written=false", [out.dry_run, out.written], [true, false]);
  check("預覽：只列出 meta_description 的差異", Object.keys(out.changes), ["meta_description"]);
  check("預覽：差異的前後值", out.changes.meta_description, {
    before: ABOUT.meta_description,
    after: desc,
  });
  check("預覽：沒寫資料表", dataWrites().length, 0);
  check(
    "預覽：記一筆 dry_run=true 稽核",
    audits().map((a) => [a.tool, a.entity, a.entity_id, a.dry_run]),
    [["update_page_meta", "pages", "about", true]],
  );
  check("預覽：confirm_args = 原參數＋dry_run=false", out.confirm_args, {
    ...args,
    dry_run: false,
  });

  resetDb(SEED, {});
  const w = parseOut(await asOAuth(() => H.update_page_meta(out.confirm_args)));
  check("寫入：written=true", [w.dry_run, w.written], [false, true]);
  const upd = dataWrites();
  check(
    "寫入：只 update pages 一次",
    upd.map((x) => [x.table, x.op]),
    [["pages", "update"]],
  );
  check("寫入：meta_description 換成新值", upd[0].payload.meta_description, desc);
  check(
    "寫入：其他欄位維持原值",
    [
      upd[0].payload.meta_title,
      upd[0].payload.header_title,
      upd[0].payload.eyebrow_suffix,
      upd[0].payload.eyebrow_prefix,
      upd[0].payload.og_title,
    ],
    [ABOUT.meta_title, ABOUT.header_title, ABOUT.eyebrow_suffix, "About", null],
  );
  check(
    "寫入：沒有寫 sort_order／slug",
    ["sort_order", "slug"].filter((k) => k in upd[0].payload),
    [],
  );
  check(
    "寫入：記一筆 dry_run=false 稽核（OAuth 身分）",
    audits().map((a) => [a.tool, a.action, a.dry_run, a.actor_via]),
    [["update_page_meta", "update", false, "oauth"]],
  );

  // 沒變
  resetDb(SEED, {});
  const same = parseOut(
    await asOAuth(() =>
      H.update_page_meta({ slug: "about", meta_title: ABOUT.meta_title, dry_run: false }),
    ),
  );
  check("值相同：written=false、不寫", [same.written, dataWrites().length], [false, 0]);

  // 錯誤
  resetDb(SEED, {});
  const e1 = await asOAuth(() => H.update_page_meta({ slug: "about", meta_title: null }));
  checkTrue(
    "meta_title 不能清空（schema 不收 null）",
    e1.isError && /欄位驗證失敗/.test(e1.content[0].text),
  );
  const e2 = await asOAuth(() => H.update_page_meta({ slug: "nope", meta_title: "x" }));
  checkTrue("找不到頁面", e2.isError && /找不到頁面/.test(e2.content[0].text));
  const e3 = await asOAuth(() => H.update_page_meta({ slug: "about" }));
  checkTrue("沒送欄位 → 拒絕", e3.isError && /沒有要改的欄位/.test(e3.content[0].text));
  check("以上錯誤都沒寫資料表", dataWrites().length, 0);

  // 清空可清空欄位
  resetDb(SEED, {});
  const clr = parseOut(
    await asOAuth(() => H.update_page_meta({ slug: "about", header_title: null })),
  );
  check("header_title=null：預覽差異 after=null", clr.changes.header_title?.after, null);
  check("清空的 confirm_args 帶 null", clr.confirm_args.header_title, null);

  // 圖片 key 必須是上傳過的
  const img = await asOAuth(() =>
    H.update_page_meta({ slug: "about", og_image_key: "https://evil.example.com/a.jpg" }),
  );
  checkTrue(
    "og_image_key 不是上傳 key → 拒絕",
    img.isError && /上傳工具/.test(img.content[0].text),
  );

  // 自動翻譯 → confirm_args 帶回不重譯
  process.env.GEMINI_API_KEY = "fake";
  globalThis.__translateCalls = [];
  resetDb(SEED, {});
  const tp = parseOut(
    await asOAuth(() => H.update_page_meta({ slug: "about", header_intro: "新的引言" })),
  );
  check("只給中文：翻譯一次", globalThis.__translateCalls.length, 1);
  check("auto_translated", tp.auto_translated, ["header_intro"]);
  const filledIntro = tp.confirm_args.header_intro;
  checkTrue(
    "confirm_args 的 header_intro 是完整三語",
    filledIntro?.zh === "新的引言" && filledIntro.en && filledIntro.ja,
  );
  resetDb(SEED, {});
  const tw = parseOut(await asOAuth(() => H.update_page_meta(tp.confirm_args)));
  check("帶回 confirm_args 寫入：沒有再翻譯", globalThis.__translateCalls.length, 1);
  check("寫入的就是預覽那一份", dataWrites()[0]?.payload.header_intro, filledIntro);
  check("帶回後沒有 write_note", tw.write_note, undefined);
  delete process.env.GEMINI_API_KEY;
  const noKey = await asOAuth(() => H.update_page_meta({ slug: "about", header_intro: "x" }));
  checkTrue("沒有翻譯金鑰、只給中文 → 拒絕（請給 en/ja）", noKey.isError);
}

// [4] ------------------------------------------------------------------------
console.log("\n[4] update_page_list_item");
{
  const label = L(
    "定期舉辦讀書會，不定期舉辦講座與身心靈活動",
    "Regular reading circles, plus occasional talks",
    "読書会を定期開催",
  );
  resetDb(SEED, {});
  const args = { page_slug: "visit", id: 17, label };
  const out = parseOut(await asOAuth(() => H.update_page_list_item(args)));
  check("預覽：dry_run=true、written=false", [out.dry_run, out.written], [true, false]);
  check("預覽：差異只有 label", Object.keys(out.changes), ["label"]);
  check("預覽：沒寫資料表", dataWrites().length, 0);
  check(
    "預覽：記一筆 dry_run=true 稽核",
    audits().map((a) => [a.tool, a.entity, a.entity_id, a.dry_run]),
    [["update_page_list_item", "page_list_items", "17", true]],
  );
  check("預覽：confirm_args", out.confirm_args, { ...args, dry_run: false });

  resetDb(SEED, {});
  const w = parseOut(await asOAuth(() => H.update_page_list_item(out.confirm_args)));
  check("寫入：written=true", w.written, true);
  const upd = dataWrites();
  check(
    "寫入：只 update page_list_items 一次（沒有 insert）",
    upd.map((x) => [x.table, x.op]),
    [["page_list_items", "update"]],
  );
  check(
    "寫入：label 新值、list_key 不變、note／image_key 原值、沒寫 sort_order",
    [
      upd[0].payload.label,
      upd[0].payload.list_key,
      upd[0].payload.note,
      upd[0].payload.image_key,
      "sort_order" in upd[0].payload,
    ],
    [label, "inside", null, null, false],
  );
  check(
    "寫入：其他項目沒被動到",
    tables.page_list_items.find((r) => r.id === 16).label,
    SEED.page_list_items[1].label,
  );
  check(
    "寫入：記一筆 dry_run=false 稽核",
    audits().map((a) => [a.tool, a.action, a.dry_run]),
    [["update_page_list_item", "update", false]],
  );

  resetDb(SEED, {});
  const e1 = await asOAuth(() =>
    H.update_page_list_item({ page_slug: "about", id: 17, label, dry_run: false }),
  );
  checkTrue("page_slug 不符 → 找不到", e1.isError && /找不到/.test(e1.content[0].text));
  const e2 = await asOAuth(() =>
    H.update_page_list_item({ page_slug: "visit", id: 17, label: null }),
  );
  checkTrue(
    "label 不能清空（schema 不收 null）",
    e2.isError && /欄位驗證失敗/.test(e2.content[0].text),
  );
  const e3 = await asOAuth(() => H.update_page_list_item({ page_slug: "visit", id: 17 }));
  checkTrue("沒送欄位 → 拒絕", e3.isError && /沒有要改的欄位/.test(e3.content[0].text));
  const e4 = await asOAuth(() =>
    H.update_page_list_item({ page_slug: "visit", id: 99999, label, dry_run: false }),
  );
  checkTrue("不存在的 id → 找不到（不會新增）", e4.isError);
  check("以上錯誤都沒寫資料表", dataWrites().length, 0);

  // 自動翻譯帶回
  process.env.GEMINI_API_KEY = "fake";
  globalThis.__translateCalls = [];
  resetDb(SEED, {});
  const tp = parseOut(
    await asOAuth(() => H.update_page_list_item({ page_slug: "visit", id: 17, note: "補充" })),
  );
  check("note 只給中文：翻譯一次", globalThis.__translateCalls.length, 1);
  resetDb(SEED, {});
  await asOAuth(() => H.update_page_list_item(tp.confirm_args));
  check("帶回 confirm_args：沒有再翻譯", globalThis.__translateCalls.length, 1);
  check("寫入的 note 就是預覽那一份", dataWrites()[0]?.payload.note, tp.confirm_args.note);
  delete process.env.GEMINI_API_KEY;
}

// [5] ------------------------------------------------------------------------
console.log("\n[5] 靜態");
const srcText = readFile(join(SRC, "server/mcp/page-content-tools.ts"));
const code = srcText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
check(
  "自己不寫 .update(/.insert(/.delete(/.upsert(/.rpc(",
  /\.(update|insert|delete|upsert|rpc)\(/.test(code),
  false,
);
check(
  "只呼叫 repo 的 updatePageMeta／upsertPageListItem，不碰 removePageListItem／reorderPageListItems",
  [
    code.includes("updatePageMeta("),
    code.includes("upsertPageListItem("),
    /removePageListItem|reorderPageListItems|bulkUpdatePageBlocks/.test(code),
  ],
  [true, true, false],
);
const toolsSrc = readFile(join(SRC, "server/mcp/tools.ts"));
check(
  "tools.ts 有註冊這一組（import＋INPUTS＋handler）",
  [
    toolsSrc.includes('from "./page-content-tools"'),
    toolsSrc.includes("...PAGE_CONTENT_TOOL_INPUTS"),
    toolsSrc.includes("[PAGE_CONTENT_TOOL_META, PAGE_CONTENT_HANDLERS as never]"),
  ],
  [true, true, true],
);

console.info = origInfo;
console.error = origError;
console.log(
  fail === 0
    ? green(`\n✓ 全部通過：${pass} passed, 0 failed`)
    : red(`\n✗ 有失敗：${pass} passed, ${fail} failed`),
);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
