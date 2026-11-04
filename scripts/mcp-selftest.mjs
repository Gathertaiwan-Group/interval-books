#!/usr/bin/env node
/**
 * mcp-selftest.mjs —— 遠端 MCP server（/api/mcp，src/server/mcp/）的自檢
 *
 * **直接 import production 的模組本人**（core.ts、tools.ts、http.ts、handler.ts），
 * 真的呼叫閘門、真的跑一次 MCP 協定的 initialize → tools/list。不碰資料庫、不打翻譯：
 * tools.ts 的 repo 都是在 handler 裡 dynamic import，列工具時不會載入。
 *
 *   [1] 閘門：沒設 token＝404、Origin 不對＝403、token 缺／錯＝401（沒開 OAuth 時只有裸
 *       Bearer，沒有 resource_metadata）、沒開 OAuth 時 /.well-known/oauth-* 一律 404
 *       （開了 OAuth 之後的行為在 mcp-oauth-selftest.mjs）
 *   [2] 輸出截斷：超過 200k 字截斷並明講
 *   [3] 差異：只列真的有變的欄位、三語物件 key 順序不影響
 *   [4] 三語補齊：齊全不翻、缺的才翻、沒金鑰明講、長文不自動翻
 *   [5] 圖片：尺寸解析、內網位址、image_key 換算
 *   [6] 工具 schema：寫入工具全部預設 dry_run=true、刪除要 confirm、白名單外的欄位一個都沒有
 *   [7] 協定：initialize → tools/list，列出的工具與 TOOL_INPUTS 一致
 *   [8] 掛載與 migration 帳本
 *
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15（module.registerHooks）。
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
} from "./lib/migration-ledger.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/mcp-selftest.mjs";
const SRC = join(ROOT, "src");
const MIG_DIR = join(ROOT, "supabase/migrations");

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

function checkTrue(label, value, hint) {
  check(label, value === true, true, hint);
}

/** 讀原始碼。檔案不存在＝丟例外（不回空字串，否則否定斷言會靜默通過）。 */
const readFile = (p) => {
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};

{
  const ghost = join(ROOT, "__selftest-missing-file-probe__");
  let thrown = null;
  try {
    readFile(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue("🔴 readFile() 讀不到檔案時丟例外（不是靜默回空字串）", thrown !== null);
}

async function rejects(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

console.log("═══ 遠端 MCP server 自檢 ═══");

// -----------------------------------------------------------------------------
// [0] 載入：`./x` → `./x.ts`、`@/x` → `src/x(.ts|/index.ts)`
// -----------------------------------------------------------------------------
if (typeof registerHooks !== "function") {
  console.log(red("  ✗ 這個 Node 沒有 module.registerHooks（需要 ≥ 22.15）"));
  console.log(`##SELFTEST## file=${SELF} pass=0 fail=1`);
  process.exit(1);
}

function resolveTs(base) {
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand)) return pathToFileURL(cand).href;
  }
  return null;
}

registerHooks({
  resolve(spec, ctx, next) {
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

const core = await import(join(SRC, "server/mcp/core.ts"));
const tools = await import(join(SRC, "server/mcp/tools.ts"));
const http = await import(join(SRC, "server/mcp/http.ts"));
const handlerMod = await import(join(SRC, "server/mcp/handler.ts"));
const oauthMod = await import(join(SRC, "server/mcp/oauth.ts"));

// -----------------------------------------------------------------------------
// [1] 閘門
// -----------------------------------------------------------------------------
console.log("\n[1] 驗證閘門");

const TOKEN = "t".repeat(20) + "0123456789abcdef0123456789";
const req = (headers = {}, path = "/api/mcp") =>
  new Request(`https://www.intervalbooks.tw${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });

{
  const r = core.gateMcpRequest(req({ authorization: `Bearer ${TOKEN}` }), undefined);
  check("🔴 沒設 MCP_TOKEN → 404（整支關閉，不是放行）", r?.status, 404);
  const r2 = core.gateMcpRequest(req({ authorization: "Bearer short" }), "short");
  check("token 短於 32 字視同沒設 → 404", r2?.status, 404);
  const r3 = core.gateMcpRequest(req({ authorization: "Bearer " }), "");
  check("MCP_TOKEN 是空字串 → 404", r3?.status, 404);
}
{
  const r = core.gateMcpRequest(
    req({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" }),
    TOKEN,
  );
  check("Origin 不在清單 → 403", r?.status, 403);
  check(
    "claude.ai 的 Origin 放行",
    core.gateMcpRequest(
      req({ authorization: `Bearer ${TOKEN}`, origin: "https://claude.ai" }),
      TOKEN,
    ),
    null,
  );
  check("本機 Inspector 的 Origin 放行", core.originAllowed("http://localhost:6274"), true);
  check("沒帶 Origin 放行（伺服器對伺服器）", core.originAllowed(null), true);
  check(
    "http://intervalbooks.tw（非 https）不放行",
    core.originAllowed("http://intervalbooks.tw"),
    false,
  );
}
{
  const missing = core.gateMcpRequest(req(), TOKEN);
  check("沒帶 Authorization → 401", missing?.status, 401);
  check(
    "🔴 沒開 OAuth 時，401 的 WWW-Authenticate 只有裸 Bearer（沒有 resource_metadata）",
    missing?.headers.get("www-authenticate"),
    "Bearer",
  );
  const wrong = core.gateMcpRequest(req({ authorization: `Bearer ${TOKEN.slice(0, -1)}x` }), TOKEN);
  check("token 錯一個字 → 401", wrong?.status, 401);
  const longer = core.gateMcpRequest(req({ authorization: `Bearer ${TOKEN}x` }), TOKEN);
  check("token 多一個字 → 401（長度不同不丟例外）", longer?.status, 401);
  const basic = core.gateMcpRequest(req({ authorization: `Basic ${TOKEN}` }), TOKEN);
  check("不是 Bearer → 401", basic?.status, 401);
  check(
    "正確 token → 放行（null）",
    core.gateMcpRequest(req({ authorization: `Bearer ${TOKEN}` }), TOKEN),
    null,
  );
}
{
  for (const p of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
    "/.well-known/openid-configuration",
  ]) {
    check(`OAuth discovery 路徑被攔下：${p}`, core.isOAuthDiscoveryPath(p), true);
  }
  check("一般頁面不被攔", core.isOAuthDiscoveryPath("/events"), false);
  check(
    "/.well-known/ 其他檔案不被攔（例如 security.txt）",
    core.isOAuthDiscoveryPath("/.well-known/security.txt"),
    false,
  );
  // 2026-10-26 起 discovery 交給 oauth.ts：**沒設 MCP_OAUTH_SECRET 時**仍然 404（OAuth 那一半
  // 的行為在 scripts/mcp-oauth-selftest.mjs）。
  const savedSecret = process.env.MCP_OAUTH_SECRET;
  delete process.env.MCP_OAUTH_SECRET;
  for (const p of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
  ]) {
    check(
      `沒設 MCP_OAUTH_SECRET：handleOAuthDiscovery(${p}) 回 404`,
      oauthMod.handleOAuthDiscovery(new Request(`https://www.intervalbooks.tw${p}`), p).status,
      404,
    );
  }
  if (savedSecret !== undefined) process.env.MCP_OAUTH_SECRET = savedSecret;
}
{
  const saved = process.env.MCP_TOKEN;
  delete process.env.MCP_TOKEN;
  const r = await http.handleMcpRequest(req({ authorization: `Bearer ${TOKEN}` }));
  check("🔴 handleMcpRequest()：環境沒有 MCP_TOKEN → 404", r.status, 404);
  if (saved !== undefined) process.env.MCP_TOKEN = saved;
}

// -----------------------------------------------------------------------------
// [2] 輸出截斷
// -----------------------------------------------------------------------------
console.log("\n[2] 輸出截斷");
{
  const small = core.jsonText({ a: 1 });
  check("小輸出不截斷", small.content[0].text.includes("截斷"), false);
  const big = core.jsonText({ rows: "x".repeat(core.MAX_TEXT + 5000) });
  const text = big.content[0].text;
  checkTrue("大輸出被截斷且明講", text.endsWith(core.TRUNCATION_NOTE));
  check("截斷後長度 = 上限 + 說明", text.length, core.MAX_TEXT + 2 + core.TRUNCATION_NOTE.length);
  check("上限是 200k 字", core.MAX_TEXT, 200000);
  check("errText 帶 isError", core.errText("x").isError, true);
}

// -----------------------------------------------------------------------------
// [3] 差異
// -----------------------------------------------------------------------------
console.log("\n[3] dry-run 差異");
{
  const before = { title: { zh: "甲", en: "A", ja: "ア" }, is_published: false, sort_order: 1 };
  check(
    "沒有變 → 空差異（三語物件 key 順序不同也算一樣）",
    core.diffFields(
      before,
      { title: { ja: "ア", en: "A", zh: "甲" }, is_published: false, sort_order: 1 },
      ["title", "is_published", "sort_order"],
    ),
    {},
  );
  check(
    "只列有變的欄位",
    core.diffFields(before, { ...before, is_published: true }, [
      "title",
      "is_published",
      "sort_order",
    ]),
    { is_published: { before: false, after: true } },
  );
  check(
    "新建（before=null）→ 每一欄都列，before 記 null",
    Object.keys(core.diffFields(null, { a: 1, b: 2 }, ["a", "b"])),
    ["a", "b"],
  );
  check("沒在 fields 裡的欄位不列", core.diffFields({ x: 1 }, { x: 2 }, []), {});
  check("undefined 與 null 視為相同", core.diffFields({ a: null }, {}, ["a"]), {});
}

// -----------------------------------------------------------------------------
// [4] 三語補齊
// -----------------------------------------------------------------------------
console.log("\n[4] 三語補齊");
{
  let calls = 0;
  const fake = async (zh) => {
    calls += 1;
    return { en: `EN:${zh}`, ja: `JA:${zh}` };
  };
  const full = await core.fillLocalized("title", { zh: "書", en: "Book", ja: "本" }, fake);
  check(
    "三語齊全 → 不呼叫翻譯",
    [calls, full.translated, full.value],
    [0, false, { zh: "書", en: "Book", ja: "本" }],
  );
  const zhOnly = await core.fillLocalized("title", "  書店  ", fake);
  check(
    "只給中文字串 → 翻譯補齊、trim",
    [calls, zhOnly.translated, zhOnly.value],
    [1, true, { zh: "書店", en: "EN:書店", ja: "JA:書店" }],
  );
  const partial = await core.fillLocalized("title", { zh: "書", en: "My Book" }, fake);
  check("給了 en 沒給 ja → 只補 ja，不覆寫 en", partial.value, {
    zh: "書",
    en: "My Book",
    ja: "JA:書",
  });
  const noKey = await rejects(() => core.fillLocalized("title", "書", null));
  checkTrue(
    "沒有翻譯金鑰 → McpInputError 要求提供 en/ja",
    noKey instanceof core.McpInputError && noKey.message.includes("en 與 ja"),
  );
  const empty = await rejects(() => core.fillLocalized("title", "   ", fake));
  checkTrue("中文空白 → 擋下", empty instanceof core.McpInputError);
  const long = await rejects(() => core.fillLocalized("description", "字".repeat(2001), fake));
  checkTrue(
    "🔴 中文超過 2000 字不自動翻（翻譯會被切斷）",
    long instanceof core.McpInputError && long.message.includes("2000"),
  );
  const longFull = await core.fillLocalized(
    "description",
    { zh: "字".repeat(3000), en: "e", ja: "j" },
    null,
  );
  check("長文自己給齊三語 → 不需要翻譯", longFull.translated, false);
  const broken = await rejects(() =>
    core.fillLocalized("t", "書", async () => {
      throw new Error("quota");
    }),
  );
  checkTrue(
    "翻譯失敗 → McpInputError（不是丟原始例外）",
    broken instanceof core.McpInputError && broken.message.includes("quota"),
  );
  const blank = await rejects(() =>
    core.fillLocalized("t", "書", async () => ({ en: "", ja: "x" })),
  );
  checkTrue("翻譯回空字串 → 擋下（is_localized 不擋空字串）", blank instanceof core.McpInputError);

  const translateSrc = readFile(join(SRC, "server/translate.ts"));
  const m = translateSrc.match(/const MAX_INPUT_CHARS = (\d[\d_]*);/);
  check(
    "TRANSLATE_MAX_CHARS 與 translate.ts 的 MAX_INPUT_CHARS 一致",
    m ? Number(m[1].replace(/_/g, "")) : null,
    core.TRANSLATE_MAX_CHARS,
  );
}

// -----------------------------------------------------------------------------
// [5] 圖片
// -----------------------------------------------------------------------------
console.log("\n[5] 圖片");
{
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(png.buffer).setUint32(16, 2400);
  new DataView(png.buffer).setUint32(20, 1600);
  check("PNG 尺寸", core.imageInfo(png), { format: "png", width: 2400, height: 1600 });

  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x06,
    0x40, 0x03, 0, 0, 0, 0,
  ]);
  check("JPEG 尺寸（略過 APP0 找 SOF0）", core.imageInfo(jpeg), {
    format: "jpeg",
    width: 1600,
    height: 800,
  });

  const webp = new Uint8Array(30);
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  // VP8X：寬高各 24 bit、存 (值-1)
  webp.set([0x3f, 0x06, 0x00], 24); // 1599 → 1600
  webp.set([0x83, 0x03, 0x00], 27); // 899 → 900
  check("WebP（VP8X）尺寸", core.imageInfo(webp), { format: "webp", width: 1600, height: 900 });
  check("不是圖片 → null", core.imageInfo(new TextEncoder().encode("<html>hello</html>")), null);

  for (const a of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    check(`內網位址被擋：${a}`, core.isPrivateAddress(a), true);
  }
  for (const a of ["8.8.8.8", "104.18.0.1", "2606:4700::1111"]) {
    check(`公開位址放行：${a}`, core.isPrivateAddress(a), false);
  }
  for (const h of [
    "localhost",
    "foo.localhost",
    "nas.local",
    "metadata.google.internal",
    "127.0.0.1",
    "[::1]",
  ]) {
    check(`主機名被擋：${h}`, core.isBlockedHostname(h), true);
  }
  check(
    "一般網域不在主機名階段被擋（之後還要過 DNS 檢查）",
    core.isBlockedHostname("images.example.com"),
    false,
  );

  const remoteSrcPre = readFile(join(SRC, "server/mcp/remote-image.ts"));
  // 把 IPv4 包進 IPv6 的各種寫法（審查指出的繞道）
  for (const a of [
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "::7f00:1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::127.0.0.1",
    "64:ff9b:1::1",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1",
    "fec0::1",
    "fe80::1%en0",
    "0:0:0:0:0:0:0:1",
  ]) {
    check(`IPv6 繞道被擋：${a}`, core.isPrivateAddress(a), true);
  }
  for (const h of [
    "[::ffff:7f00:1]",
    "[::ffff:127.0.0.1]",
    "[64:ff9b::7f00:1]",
    "[2002:7f00:1::]",
  ]) {
    check(`主機名（IPv6 字面量）被擋：${h}`, core.isBlockedHostname(h), true);
  }
  check(
    "IPv4-mapped 的公開位址放行：::ffff:8.8.8.8",
    core.isPrivateAddress("::ffff:8.8.8.8"),
    false,
  );
  check("6to4 包公開位址放行：2002:808:808::1", core.isPrivateAddress("2002:808:808::1"), false);
  check(
    "parseIPv6：::ffff:127.0.0.1 → 結尾 ff,ff,7f,00,00,01",
    core.parseIPv6("::ffff:127.0.0.1")?.slice(10).join(","),
    "255,255,127,0,0,1",
  );
  check(
    "parseIPv6：壞格式回 null",
    [core.parseIPv6("1::2::3"), core.parseIPv6("12345::1"), core.parseIPv6("1:2:3")],
    [null, null, null],
  );
  checkTrue(
    "遠端抓圖連線釘在驗過的 IP（https.request + lookup）",
    remoteSrcPre.includes("lookup: (") && remoteSrcPre.includes("pinned.address"),
  );
  checkTrue(
    "遠端抓圖不再用全域 fetch（它會自己再解析一次 DNS）",
    !/\bawait fetch\(/.test(remoteSrcPre),
  );
  checkTrue(
    "每一跳 redirect 都重新 resolvePublic",
    /for \(let i = 0;[\s\S]{0,200}resolvePublic\(url\.hostname\)/.test(remoteSrcPre),
  );

  const key = "storage:3f1c9c1e-1111-2222-3333-444455556666.webp";
  check("image_key：storage key 原樣", core.imageKeyFromArg(key), key);
  check(
    "image_key：site-images 公開網址換回 storage key",
    core.imageKeyFromArg(
      "https://abc.supabase.co/storage/v1/object/public/site-images/3f1c9c1e-1111-2222-3333-444455556666.webp",
    ),
    key,
  );
  check(
    "image_key：null／空字串＝清掉",
    [core.imageKeyFromArg(null), core.imageKeyFromArg("")],
    [null, null],
  );
  check(
    "image_key：這一列原本的舊檔名可以原樣送回",
    core.imageKeyFromArg("cover-old.jpg", ["cover-old.jpg"]),
    "cover-old.jpg",
  );
  checkTrue(
    "image_key：外部網址被拒（要先 upload_image_from_url）",
    (await rejects(async () => core.imageKeyFromArg("https://example.com/a.jpg"))) instanceof
      core.McpInputError,
  );
  const storageSrc = readFile(join(SRC, "server/storage.ts"));
  checkTrue(
    "SITE_IMAGES_BUCKET_NAME 與 storage.ts 的 SITE_IMAGES_BUCKET 一致",
    storageSrc.includes(`export const SITE_IMAGES_BUCKET = "${core.SITE_IMAGES_BUCKET_NAME}";`),
  );
  const remoteSrc = readFile(join(SRC, "server/mcp/remote-image.ts"));
  checkTrue(
    "遠端抓圖入庫走 storage.ts 的 uploadSiteImage（不抄第二份）",
    remoteSrc.includes("uploadSiteImage") ||
      readFile(join(SRC, "server/mcp/tools.ts")).includes("uploadSiteImage("),
  );
  checkTrue(
    "遠端抓圖 redirect 自己跟（3xx 不自動跟）",
    remoteSrc.includes("hop.status >= 300 && hop.status < 400"),
  );
  checkTrue("遠端抓圖只收 https", remoteSrc.includes('url.protocol !== "https:"'));
}

// -----------------------------------------------------------------------------
// [6] 工具 schema
// -----------------------------------------------------------------------------
console.log("\n[6] 工具輸入 schema");
const EXPECTED_TOOLS = [
  "list_news",
  "get_news",
  "list_events",
  "get_event",
  "list_journeys",
  "get_journey",
  "list_shop_products",
  "get_shop_product",
  "list_publications",
  "get_publication",
  "list_curated",
  "list_speakers",
  "get_speaker",
  "list_collaborations",
  "get_collaboration",
  "list_pages",
  "get_page",
  "get_site_info",
  "list_event_categories",
  "create_news",
  "update_news",
  "delete_news",
  "update_event",
  "update_journey",
  // 2026-11-02 0052：活動／策旅單一上架狀態（行為測試在 listing-status-selftest.mjs）
  "set_event_status",
  "update_shop_product",
  "update_publication",
  "update_speaker",
  "update_collaboration",
  "update_page_blocks",
  "upload_image_from_url",
  // 2026-11-02 新增（src/server/mcp/create-tools.ts；行為測試在 mcp-create-selftest.mjs）
  "create_event",
  "create_journey",
  "create_shop_product",
  // 2026-11-02 直接上傳圖片（src/server/mcp/image-upload.ts；行為測試在下面 [9]）
  "create_image_upload_url",
  "finalize_image_upload",
  "upload_image_base64",
  "upload_image_file",
];
// 2026-11-03 後台資料唯讀查詢（src/server/mcp/admin-read-tools.ts）。訂單、名單、銷售、進銷存
// 這些「排除領域」只准出現在這份清單，而且全部 READ_ONLY、沒有任何寫入參數（下面逐條守）。
const ADMIN_READ_EXPECTED = [
  "get_admin_dashboard",
  "list_orders",
  "get_order",
  "list_registrations",
  "get_session_roster",
  "list_journey_wishes",
  "get_journey_wish",
  "list_sales",
  "get_sale",
  "get_sales_summary",
  "list_inventory",
  "get_inventory_product",
  "list_stock_alerts",
  "list_purchases",
  "get_purchase",
  "list_vendors",
  "get_vendor",
  "list_referrers",
  "get_referral_report",
  "list_partnership_inquiries",
  "get_partnership_inquiry",
];
EXPECTED_TOOLS.push(...ADMIN_READ_EXPECTED);
// 2026-11-03 營運寫入／對外動作／報表（ops-write-tools.ts、outbound-tools.ts、report-tools.ts；
// 各自的行為測試在 mcp-ops-write／mcp-outbound／mcp-report-selftest）。寫入的那幾支必須預設
// dry_run=true、不是 readOnlyHint（唯讀連線在 add() 被擋），下面守。
const OPS_WRITE_EXPECTED = [
  "update_order_fulfillment",
  "mark_order_paid",
  "create_phone_order",
  "update_phone_order_contacts",
  "remove_registration",
  "update_journey_wish",
  "update_partnership_inquiry",
  "create_stock_adjustment",
  "record_stock_count",
  "create_purchase",
  "update_ui_string",
  "update_site_settings",
  "resend_order_email",
  "reissue_invoice",
  "request_invoice_void",
];
const OPS_READ_EXPECTED = [
  "list_phone_order_options",
  "get_ui_strings",
  "get_site_settings",
  "get_email_copy",
  "export_roster_csv",
  "export_orders_csv",
  "export_sales_csv",
  "get_top_products",
  "get_event_fill_rates",
  "get_repurchase_rate",
];
EXPECTED_TOOLS.push(...OPS_WRITE_EXPECTED, ...OPS_READ_EXPECTED);
{
  const names = Object.keys(tools.TOOL_INPUTS).sort();
  check("工具清單（白名單）與預期一致", names, [...EXPECTED_TOOLS].sort());
  check(
    "後台唯讀查詢清單（ADMIN_READ_TOOLS）與預期一致",
    [...tools.ADMIN_READ_TOOLS].sort(),
    [...ADMIN_READ_EXPECTED].sort(),
  );
  // 排除領域的名稱／欄位檢查只套在內容工具上；後台查詢與營運工具另有各自的規則（下面）。
  const adminRead = new Set([
    ...tools.ADMIN_READ_TOOLS,
    ...OPS_WRITE_EXPECTED,
    ...OPS_READ_EXPECTED,
  ]);
  for (const n of OPS_WRITE_EXPECTED) {
    const parsed = tools.TOOL_INPUTS[n]?.shape?.dry_run?.safeParse(undefined);
    check(`🔴 ${n}：沒送 dry_run → 預設 true`, parsed?.success && parsed.data, true);
  }
  check(
    "🔴 後台唯讀查詢沒有任何一支在 WRITE_TOOLS／UPLOAD_TOOLS",
    [...tools.WRITE_TOOLS, ...tools.UPLOAD_TOOLS].filter((n) => tools.ADMIN_READ_TOOLS.includes(n)),
    [],
  );
  // 寫入意味的參數一個都不准有（dry_run、confirm、status 以外的「改成什麼」都算）。
  const WRITE_ISH =
    /^(dry_run|confirm|publish|note|admin_note|amount|price|reason|void|refund|mark|resolve|settle|delete|remove)/;
  const writeIshFields = [];
  for (const n of tools.ADMIN_READ_TOOLS) {
    for (const f of Object.keys(tools.TOOL_INPUTS[n].shape)) {
      if (WRITE_ISH.test(f)) writeIshFields.push(`${n}.${f}`);
    }
  }
  check("🔴 後台唯讀查詢沒有任何寫入意味的參數", writeIshFields, []);
  const listNoLimit = tools.ADMIN_READ_TOOLS.filter((n) => n.startsWith("list_")).filter((n) => {
    const d = tools.TOOL_INPUTS[n].safeParse({}).data;
    const over = tools.TOOL_INPUTS[n].safeParse({ limit: 101 }).success;
    return !(d && d.limit === 20 && d.page === 1 && over === false);
  });
  check("list_* 後台查詢：limit 預設 20、上限 100、page 從 1", listNoLimit, []);
  const adminReadSrc = readFile(join(SRC, "server/mcp/admin-read-tools.ts"));
  check(
    "🔴 admin-read-tools.ts 沒有任何寫入呼叫（insert／update／upsert／delete／rpc）",
    adminReadSrc.match(/\.(insert|update|upsert|delete|rpc)\(/g) ?? [],
    [],
  );
  checkTrue(
    "🔴 付款紀錄不 select raw_response、不讀 webhook_events",
    !/raw_response|webhook_events/.test(adminReadSrc.replace(/^\s*(\/\/|\*).*$/gm, "")),
  );
  checkTrue(
    "🔴 廠商：識別碼遮罩版本也拿掉，不讀匯款帳戶／敏感欄位",
    adminReadSrc.includes("tax_id_masked: _tax") &&
      adminReadSrc.includes("id_number_masked: _idn") &&
      !/listVendorBankAccounts|readVendorSensitive/.test(adminReadSrc),
  );

  // 用「底線切開後的整個字」比對；sort_order（排序）的 order 不是訂單，先換掉。
  const BANNED_WORDS = new Set([
    "order",
    "orders",
    "payment",
    "payments",
    "invoice",
    "invoices",
    "refund",
    "registration",
    "registrations",
    "roster",
    "staff",
    "permission",
    "permissions",
    "inventory",
    "inv",
    "vendor",
    "vendors",
    "stock",
    "session",
    "sessions",
    "plan",
    "plans",
    "seat",
    "seats",
    "capacity",
    "notify",
    "bank",
    "email",
    "emails",
    "pii",
  ]);
  const banned = {
    test: (s) =>
      s
        .toLowerCase()
        .replace(/sort_order/g, "sort")
        .split("_")
        .some((w) => BANNED_WORDS.has(w)),
  };
  check(
    "沒有任何一支工具的名字碰到排除的領域（後台唯讀查詢除外）",
    names.filter((n) => banned.test(n) && !adminRead.has(n)),
    [],
  );
  check(
    "比對器自己：list_orders 會被抓到、sort_order 不會",
    [banned.test("list_orders"), banned.test("sort_order")],
    [true, false],
  );
  // 唯一的例外：新增活動／策旅要連同場次與報名方式一起建（走後台一頁新增同一支
  // src/server/event-quick-create.ts）。名單寫死在這裡，多一個欄位、或出現在別支工具上都會紅。
  const ALLOWED_FIELDS = new Set([
    "create_event.sessions",
    "create_event.registration_mode",
    "create_journey.sessions",
    "create_journey.registration_mode",
  ]);
  const bannedFields = [];
  const allowedHit = [];
  for (const [n, s] of Object.entries(tools.TOOL_INPUTS)) {
    if (adminRead.has(n)) continue;
    for (const f of Object.keys(s.shape)) {
      if (!banned.test(f)) continue;
      if (ALLOWED_FIELDS.has(`${n}.${f}`)) allowedHit.push(`${n}.${f}`);
      else bannedFields.push(`${n}.${f}`);
    }
  }
  check("沒有任何一支工具收排除領域的欄位（庫存、場次、名額、金流…）", bannedFields, []);
  check(
    "例外只有 create_event／create_journey 的 sessions、registration_mode（名單逐字）",
    allowedHit.sort(),
    [...ALLOWED_FIELDS].sort(),
  );
  check(
    "🔴 create_shop_product 沒有任何庫存欄位",
    Object.keys(tools.TOOL_INPUTS.create_shop_product.shape).filter((f) =>
      /stock|inventory|inv_|quantity/.test(f),
    ),
    [],
  );

  for (const n of tools.WRITE_TOOLS) {
    const shape = tools.TOOL_INPUTS[n].shape;
    checkTrue(`${n}：有 dry_run`, "dry_run" in shape);
  }
  const minimal = {
    create_news: { title: "t", summary: "s", description: "d", display_date: "2026.10.20" },
    update_news: { id: "x" },
    delete_news: { id: "x" },
    update_event: { id: "x" },
    update_journey: { id: "x" },
    set_event_status: { id: "x", status: "live" },
    update_shop_product: { id: "x" },
    update_publication: { id: "x" },
    update_speaker: { id: "x" },
    update_collaboration: { id: "x" },
    update_page_blocks: { page_slug: "index", blocks: [{ block_key: "k", value: "v" }] },
    upload_image_from_url: { url: "https://example.com/a.jpg" },
    create_event: { title: "t", category: "c", description: "d" },
    create_journey: { title: "t", category: "c", description: "d" },
    create_shop_product: { product_type: "book", title: "t", summary: "s", price: 100 },
  };
  check(
    "每一支寫入工具都有最小輸入樣本",
    Object.keys(minimal).sort(),
    [...tools.WRITE_TOOLS].sort(),
  );
  for (const [n, input] of Object.entries(minimal)) {
    const parsed = tools.TOOL_INPUTS[n].safeParse(input);
    check(
      `🔴 ${n}：沒送 dry_run → 預設 true（不會意外寫入）`,
      parsed.success && parsed.data.dry_run,
      true,
    );
  }
  for (const n of ["create_event", "create_journey", "create_shop_product"]) {
    check(
      `🔴 ${n}：沒送 publish → 預設 false（草稿）`,
      tools.TOOL_INPUTS[n].safeParse(minimal[n]).data?.publish,
      false,
    );
  }
  const del = tools.TOOL_INPUTS.delete_news.safeParse({ id: "x", dry_run: false });
  check("delete_news：沒送 confirm → 預設 false", del.success && del.data.confirm, false);
  check(
    "create_news：沒送 is_published → 預設 false（草稿）",
    tools.TOOL_INPUTS.create_news.safeParse(minimal.create_news).data?.is_published,
    false,
  );
  check(
    "三語參數收 {zh,en,ja}",
    tools.TOOL_INPUTS.update_news.safeParse({ id: "x", title: { zh: "a", en: "b", ja: "c" } })
      .success,
    true,
  );
  check(
    "三語參數不收多餘的語言 key",
    tools.TOOL_INPUTS.update_news.safeParse({ id: "x", title: { zh: "a", ko: "b" } }).success,
    false,
  );
  check(
    "update_shop_product：負價格被擋",
    tools.TOOL_INPUTS.update_shop_product.safeParse({ id: "x", price: -1 }).success,
    false,
  );
  check(
    "update_shop_product：小數價格被擋",
    tools.TOOL_INPUTS.update_shop_product.safeParse({ id: "x", price: 1.5 }).success,
    false,
  );
  check(
    "update_page_blocks：一次最多 50 塊",
    tools.TOOL_INPUTS.update_page_blocks.safeParse({
      page_slug: "a",
      blocks: Array.from({ length: 51 }, () => ({ block_key: "k", value: "v" })),
    }).success,
    false,
  );

  const toolsSrc = readFile(join(SRC, "server/mcp/tools.ts"));
  checkTrue(
    "update_event 走 upsertEventWithProduct（與後台同一支 RPC），product 傳 null",
    /upsertEventWithProduct\(\s*\{[\s\S]*?lists: \{\}[\s\S]*?\},\s*null,?\s*\)/.test(toolsSrc),
  );
  {
    const patch = core.productContentPatch({
      id: "p1",
      slug: "s",
      product_type: "goods",
      source_type: null,
      source_id: null,
      title: { zh: "a", en: "a", ja: "a" },
      summary: { zh: "a", en: "a", ja: "a" },
      description: { zh: "a", en: "a", ja: "a" },
      price: 100,
      compare_at_price: null,
      stock: 3,
      capacity: null,
      image_key: null,
      requires_shipping: true,
      status: "active",
      sort_order: 1,
    });
    check(
      "🔴 update_shop_product 的寫入 payload 只有門面七欄（沒有 stock／slug／product_type／source_*）",
      Object.keys(patch).sort(),
      ["compare_at_price", "description", "image_key", "price", "status", "summary", "title"],
    );
    check("payload 沒有 stock", "stock" in patch, false);
    const repoSrc = readFile(join(SRC, "server/repos/products.ts"));
    const fn = repoSrc.slice(repoSrc.indexOf("export async function updateProductContent"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    checkTrue(
      "updateProductContent 用 .update() 不是 .upsert()",
      body.includes(".update({") && !body.includes(".upsert("),
    );
    checkTrue("updateProductContent 不寫 stock／slug", !/\bstock:|\bslug:/.test(body));
    checkTrue(
      "MCP 改商品走 updateProductContent，不走 upsertProduct",
      toolsSrc.includes("updateProductContent(") && !toolsSrc.includes("upsertProduct("),
    );
  }
  checkTrue(
    "update_shop_product 擋票券商品（只限 goods／book）",
    toolsSrc.includes('const SHOP_PRODUCT_TYPES = ["goods", "book"] as const;'),
  );
  checkTrue("delete_news 真的刪除前要 confirm", toolsSrc.includes("args.confirm !== true"));
  checkTrue("講者輸出拿掉 vendor_id", toolsSrc.includes("vendor_id: _vendor"));
  checkTrue("店家資訊白名單不含 notify_emails／bank_", !/"notify_emails"|"bank_/.test(toolsSrc));
}

// -----------------------------------------------------------------------------
// [7] 協定：initialize → tools/list
// -----------------------------------------------------------------------------
console.log("\n[7] MCP 協定");
{
  const saved = process.env.MCP_TOKEN;
  process.env.MCP_TOKEN = TOKEN;

  async function rpc(body, extra = {}) {
    const res = await http.handleMcpRequest(
      new Request("https://www.intervalbooks.tw/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          ...extra,
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    let json = null;
    try {
      json = JSON.parse(dataLine ? dataLine.slice(5) : text);
    } catch {
      /* 留 null */
    }
    return { status: res.status, json, cacheControl: res.headers.get("cache-control") };
  }

  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "selftest", version: "0" },
    },
  });
  check("initialize → 200", init.status, 200);
  check("serverInfo.name = intervalbooks", init.json?.result?.serverInfo?.name, "intervalbooks");
  checkTrue(
    "instructions 有中英文、講到 dry_run 與排除範圍",
    ["dry_run", "訂單", "報名", "進銷存", "權限", "Not available"].every((w) =>
      (init.json?.result?.instructions ?? "").includes(w),
    ),
  );
  checkTrue("回應不快取（no-store／no-cache）", /no-store|no-cache/.test(init.cacheControl ?? ""));

  const list = await rpc(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { "mcp-protocol-version": "2025-11-25" },
  );
  const listed = (list.json?.result?.tools ?? []).map((t) => t.name).sort();
  check("tools/list 列出的工具與 TOOL_INPUTS 一致", listed, [...EXPECTED_TOOLS].sort());
  const upd = (list.json?.result?.tools ?? []).find((t) => t.name === "update_news");
  check(
    "update_news 的 JSON Schema 有 dry_run 且預設 true",
    upd?.inputSchema?.properties?.dry_run?.default,
    true,
  );
  check("update_news 只要求 id", upd?.inputSchema?.required, ["id"]);
  for (const n of ["create_event", "create_journey", "create_shop_product"]) {
    const t = (list.json?.result?.tools ?? []).find((x) => x.name === n);
    const d = t?.description ?? "";
    checkTrue(
      `${n} 的說明寫清楚「預設草稿」「dry_run 預設 true」`,
      (d.includes("預設建成草稿") || d.includes("一律建成草稿")) && d.includes("預設 dry_run=true"),
    );
    check(
      `${n} 的 JSON Schema：dry_run 預設 true`,
      t?.inputSchema?.properties?.dry_run?.default,
      true,
    );
    check(
      `${n} 的 JSON Schema：publish 預設 false`,
      t?.inputSchema?.properties?.publish?.default,
      false,
    );
    check(`${n} 標 idempotentHint=false`, t?.annotations?.idempotentHint, false);
  }
  checkTrue(
    "create_shop_product 的說明寫清楚「不設庫存」",
    (
      (list.json?.result?.tools ?? []).find((x) => x.name === "create_shop_product")?.description ??
      ""
    ).includes("不設庫存"),
  );
  const listNews = (list.json?.result?.tools ?? []).find((t) => t.name === "list_news");
  check("讀取工具標 readOnlyHint", listNews?.annotations?.readOnlyHint, true);
  check(
    "🔴 後台唯讀查詢全部標 readOnlyHint=true、destructiveHint=false",
    (list.json?.result?.tools ?? [])
      .filter((t) => [...ADMIN_READ_EXPECTED, ...OPS_READ_EXPECTED].includes(t.name))
      .filter(
        (t) => t.annotations?.readOnlyHint !== true || t.annotations?.destructiveHint !== false,
      )
      .map((t) => t.name),
    [],
  );
  const delNews = (list.json?.result?.tools ?? []).find((t) => t.name === "delete_news");
  check("delete_news 標 destructiveHint", delNews?.annotations?.destructiveHint, true);

  const badArgs = await rpc(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "update_shop_product", arguments: { id: "x", price: -5 } },
    },
    { "mcp-protocol-version": "2025-11-25" },
  );
  checkTrue(
    "不合法的參數在進 handler 前就被擋（不碰資料庫）",
    Boolean(badArgs.json?.error) || badArgs.json?.result?.isError === true,
  );

  check("MCP_INSTRUCTIONS 匯出", typeof handlerMod.MCP_INSTRUCTIONS, "string");

  // ── 寫入工具被業務規則擋下 → 也記一筆 action=rejected（審查 2026-11-03）────────
  {
    const seen = [];
    const origInfo = console.info;
    console.info = (line, ...rest) => {
      if (typeof line === "string" && line.startsWith("[mcp-audit] ")) {
        seen.push(JSON.parse(line.slice("[mcp-audit] ".length)));
      } else origInfo(line, ...rest);
    };
    const rej = await rpc(
      {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "set_event_status",
          arguments: { id: "ev-x", journey_id: "jo-x", status: "archived" },
        },
      },
      { "mcp-protocol-version": "2025-11-25" },
    );
    // 營運工具的 handler 自己把錯誤轉成 isError 文字（不丟例外）——也要記（2026-11-05 正式站實測）。
    const rej2 = await rpc(
      {
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: {
          name: "update_journey_wish",
          arguments: { id: "00000000-0000-4000-8000-000000000009", status: "reviewed" },
        },
      },
      { "mcp-protocol-version": "2025-11-25" },
    );
    console.info = origInfo;
    checkTrue("營運工具回 isError（selftest 沒有資料庫）", rej2.json?.result?.isError === true);
    check(
      "🔴 營運工具回傳的 isError 也記一筆 rejected（只一筆，不重複）",
      seen.filter((r) => r.tool === "update_journey_wish").map((r) => [r.action, r.dry_run]),
      [["rejected", true]],
    );
    checkTrue("業務規則拒絕 → 回 isError", rej.json?.result?.isError === true);
    check(
      "🔴 業務規則拒絕也記稽核（action=rejected、dry_run=true、帶原因、只記 id 類參數）",
      seen
        .filter((r) => r.tool === "set_event_status")
        .map((r) => [r.tool, r.action, r.dry_run, typeof r.changes?.reason, r.entity_id]),
      [["set_event_status", "rejected", true, "string", "id=ev-x"]],
    );
  }

  // ── 0054 讀寫分級：MCP_READONLY_TOKEN ─────────────────────────────────────
  const RO = "r".repeat(20) + "fedcba9876543210fedcba98";
  process.env.MCP_READONLY_TOKEN = RO;
  const roCall = async (name, args) => {
    const res = await http.handleMcpRequest(
      new Request("https://www.intervalbooks.tw/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${RO}`,
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
    );
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return { status: res.status, json: JSON.parse(line ? line.slice(5) : text) };
  };
  const roWrite = await roCall("update_news", { id: "x", is_published: false });
  check("唯讀 token 通過閘門（200）", roWrite.status, 200);
  checkTrue(
    "🔴 唯讀 token 呼叫寫入工具（dry_run 預設）→ 被拒、訊息講清楚",
    roWrite.json?.result?.isError === true &&
      (roWrite.json?.result?.content?.[0]?.text ?? "").includes("唯讀"),
  );
  const ROW = {
    mark_order_paid: { order_id: "00000000-0000-4000-8000-000000000001" },
    remove_registration: {
      session_id: "00000000-0000-4000-8000-000000000001",
      registration_id: "00000000-0000-4000-8000-000000000001",
    },
    resend_order_email: { order: "00000000-0000-4000-8000-000000000001", kind: "order_paid" },
    request_invoice_void: { order: "00000000-0000-4000-8000-000000000001", reason: "測試" },
  };
  check(
    "含個資的 CSV 匯出列在 REQUIRE_WRITE_ACCESS（唯讀連線不可用）",
    [...tools.REQUIRE_WRITE_ACCESS].sort(),
    ["export_orders_csv", "export_roster_csv", "export_sales_csv"],
  );
  const EXPORT_ROW = {
    export_roster_csv: { session_id: "00000000-0000-4000-8000-000000000001" },
    export_orders_csv: { date_from: "2026-10-01", date_to: "2026-10-31" },
    export_sales_csv: { date_from: "2026-10-01", date_to: "2026-10-31" },
  };
  for (const [n, args] of Object.entries(EXPORT_ROW)) {
    const r = await roCall(n, args);
    checkTrue(
      `🔴 唯讀 token 呼叫 ${n}（合法參數）→ 被拒，不產生下載連結`,
      r.json?.result?.isError === true &&
        (r.json?.result?.content?.[0]?.text ?? "").includes("唯讀"),
    );
  }
  for (const [n, args] of Object.entries(ROW)) {
    const r = await roCall(n, args);
    checkTrue(
      `🔴 唯讀 token 呼叫 ${n}（合法參數）→ 被拒，不碰資料庫`,
      r.json?.result?.isError === true &&
        (r.json?.result?.content?.[0]?.text ?? "").includes("唯讀"),
    );
  }
  const roCreate = await roCall("create_event", { title: "t", category: "c", description: "d" });
  checkTrue(
    "🔴 唯讀 token 呼叫新增工具 → 被拒",
    roCreate.json?.result?.isError === true &&
      (roCreate.json?.result?.content?.[0]?.text ?? "").includes("唯讀"),
  );
  const roBad = core.authenticateMcpRequest(
    new Request("https://www.intervalbooks.tw/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${RO}x` },
    }),
    undefined,
    undefined,
    undefined,
    RO,
  );
  check("唯讀 token 打錯一個字 → 401", roBad.kind === "deny" && roBad.response.status, 401);
  const roOnly = core.authenticateMcpRequest(
    new Request("https://www.intervalbooks.tw/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${RO}` },
    }),
    undefined,
    undefined,
    undefined,
    RO,
  );
  check("只設 MCP_READONLY_TOKEN 也能通過（kind=static_readonly）", roOnly.kind, "static_readonly");
  delete process.env.MCP_READONLY_TOKEN;

  if (saved === undefined) delete process.env.MCP_TOKEN;
  else process.env.MCP_TOKEN = saved;
}

// -----------------------------------------------------------------------------
// [8] 掛載與 migration
// -----------------------------------------------------------------------------
console.log("\n[8] 掛載與 migration");
{
  const serverSrc = readFile(join(SRC, "server.ts"));
  const mcpIdx = serverSrc.indexOf("pathname === MCP_PATH");
  const oauthIdx = serverSrc.indexOf("isOAuthDiscoveryPath(pathname)");
  const startIdx = serverSrc.indexOf("await (startFetch");
  checkTrue("src/server.ts 在交給 startFetch 之前攔下 /api/mcp", mcpIdx > 0 && mcpIdx < startIdx);
  checkTrue(
    "src/server.ts 在交給 startFetch 之前攔下 OAuth discovery",
    oauthIdx > 0 && oauthIdx < startIdx,
  );
  checkTrue(
    "MCP handler 是 dynamic import（service_role 不在 entry 載入時被拉進來）",
    serverSrc.includes('await import("@/server/mcp/http")'),
  );

  const handlerSrc = readFile(join(SRC, "server/mcp/handler.ts"));
  checkTrue(
    "🔴 不用 withMcpAuth（會吐 OAuth challenge）",
    !handlerSrc.includes("withMcpAuth") &&
      !readFile(join(SRC, "server/mcp/http.ts")).includes("withMcpAuth"),
  );
  const coreSrc = readFile(join(SRC, "server/mcp/core.ts"));
  checkTrue("token 比對用 timingSafeEqual", coreSrc.includes("timingSafeEqual(a, b)"));

  const auditSrc = readFile(join(SRC, "server/mcp/audit.ts"));
  checkTrue(
    "稽核寫 mcp_audit_log、actor_role 固定 mcp",
    auditSrc.includes('"mcp_audit_log"') && auditSrc.includes('actor_role: "mcp"'),
  );
  checkTrue(
    "稽核不寫 actor_id（避免外鍵擋下後靜默消失）",
    !/actor_id/.test(auditSrc.replace(/\/\*[\s\S]*?\*\//g, "")),
  );
  checkTrue(
    "稽核只 insert、從不 select（migration 晚到不會弄壞頁面）",
    !/\.select\(/.test(auditSrc),
  );

  const mig = readFile(join(MIG_DIR, "0039_mcp_audit_log.sql"));
  checkTrue(
    "0039：RLS 開著",
    mig.includes("alter table public.mcp_audit_log enable row level security;"),
  );
  checkTrue(
    "0039：anon／authenticated 全收回",
    mig.includes("revoke all on table public.mcp_audit_log from anon, authenticated;"),
  );
  checkTrue(
    "0039：service_role 只有 select、insert（append-only）",
    mig.includes("grant select, insert on table public.mcp_audit_log to service_role;"),
  );
  checkTrue("0039：actor_role CHECK 釘死 mcp", mig.includes("check (actor_role = 'mcp')"));
  // 0054：加 actor／client／dry_run 欄位、action CHECK 改格式檢查；仍 append-only（不給 update／delete）。
  const mig54 = readFile(join(MIG_DIR, "0054_mcp_access_level_audit_actor.sql"));
  checkTrue(
    "0054：mcp_audit_log 補 actor_via／actor_user_id／actor_email／client_name／dry_run",
    ["actor_via", "actor_user_id", "actor_email", "client_name", "dry_run"].every((c) =>
      mig54.includes(`add column if not exists ${c}`),
    ),
  );
  checkTrue(
    "🔴 0054：沒有對 mcp_audit_log 授權 update／delete（仍 append-only）",
    !/grant[^;]*(update|delete)[^;]*mcp_audit_log/i.test(mig54),
  );
  checkTrue(
    "🔴 0054：access_level 預設 write（既有與新連線都可寫入），而且沒有改成 read",
    mig54.includes("default 'write'") && !/set default 'read'/.test(mig54),
  );

  assertLedgerMatchesDisk(check, MIG_DIR);
  assertLedgerDeclarationsHonest(check, MIG_DIR);
  assertMigrationDependencies(check, MIG_DIR, {
    suite: SELF,
    dependsOn: ["mcp_audit"],
    reviewedThrough: "0054_mcp_access_level_audit_actor.sql",
  });
}

// -----------------------------------------------------------------------------
// 收尾
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
