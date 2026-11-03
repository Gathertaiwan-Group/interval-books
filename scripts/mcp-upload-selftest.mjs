#!/usr/bin/env node
/**
 * mcp-upload-selftest.mjs —— MCP「直接上傳圖片」四支工具的自檢
 * （create_image_upload_url／finalize_image_upload／upload_image_base64／upload_image_file，
 *  src/server/mcp/image-upload.ts）
 *
 * **走真正的 MCP 協定**（http.ts#handleMcpRequest → tools/call），而且 src/server/storage.ts
 * 的 uploadSiteImage() 是**本人**（magic bytes 嗅探、2MB、uuid 物件名都是真的跑）。只換掉：
 *   · src/server/supabase-admin.ts → 記錄呼叫的假 client（storage 與稽核表）
 *   · src/server/mcp/remote-image.ts 的 fetchRemoteImage → 不連網的替身（但照樣執行工具傳進來的
 *     allowHost／hostError，所以「只放行 OpenAI 網域」這一條測的是 tools.ts 本人傳的選項）
 *
 *   [1] base64：合法上傳、data URL 前綴、格式不符、偽裝副檔名（.png 內容是 HTML）、SVG、超過大小、
 *       壞掉的 base64
 *   [2] 直傳：申請網址（路徑由伺服器產生、大小上限）、finalize 成功／重複／偽裝內容／過期／壞 id
 *   [3] ChatGPT 檔案：openai/fileParams、只放行 OpenAI 網域、mime_type 不收 SVG、驗內容
 *   [4] 稽核：不含 base64、不含 download_url、不含 signed URL
 *   [5] key 能被 update_event 等工具接受（core.imageKeyFromArg）
 *   [6] 權限：沒有 token／token 錯 → 401，handler 不會跑
 *   [7] tools/list：四支都在、描述寫清楚三種情境（中英）、沒有 dry_run
 *
 * 需要 Node ≥ 22.18（原生 TypeScript type stripping）＋ ≥ 22.15（module.registerHooks）。
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/mcp-upload-selftest.mjs";
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

console.log("═══ MCP 直接上傳圖片自檢 ═══");

if (typeof registerHooks !== "function") {
  console.log(red("  ✗ 這個 Node 沒有 module.registerHooks（需要 ≥ 22.15）"));
  console.log(`##SELFTEST## file=${SELF} pass=0 fail=1`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 替身
// -----------------------------------------------------------------------------
const SUPABASE_ADMIN = join(SRC, "server/supabase-admin.ts");
const REMOTE_IMAGE = join(SRC, "server/mcp/remote-image.ts");

const supabaseAdminMock = `data:text/javascript,${encodeURIComponent(
  "export const supabaseAdmin = () => globalThis.__mock.client;",
)}`;
// 真的 remote-image.ts 全部照用，只把 fetchRemoteImage 換成不連網的版本。
const remoteImageMock = `data:text/javascript,${encodeURIComponent(
  `export * from ${JSON.stringify(pathToFileURL(REMOTE_IMAGE).href + "?real")};
   export const fetchRemoteImage = (...a) => globalThis.__mock.fetchRemoteImage(...a);`,
)}`;

function resolveTs(base) {
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand)) return pathToFileURL(cand).href;
  }
  return null;
}
function swap(url) {
  if (!url) return null;
  if (url === pathToFileURL(SUPABASE_ADMIN).href) return supabaseAdminMock;
  if (url === pathToFileURL(REMOTE_IMAGE).href) return remoteImageMock;
  return url;
}
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.endsWith("?real")) return next(spec, ctx);
    if (spec.startsWith("@/")) {
      const url = swap(resolveTs(join(SRC, spec.slice(2))));
      if (url) return { url, shortCircuit: true };
    }
    if (spec.startsWith(".") && ctx.parentURL && !ctx.parentURL.startsWith("data:")) {
      const abs = fileURLToPath(new URL(spec, ctx.parentURL));
      const url = /\.[a-zA-Z]+$/.test(spec) ? swap(pathToFileURL(abs).href) : swap(resolveTs(abs));
      if (url) return { url, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const HTML = Buffer.from("<html><body><script>alert(document.cookie)</script></body></html>");
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>',
);

function freshMock() {
  const m = {
    storage: [], // { bucket, op, args }
    audits: [],
    staging: new Map(), // path → Buffer
    fetchCalls: [],
    fetchBytes: PNG_1x1,
    client: {
      from(table) {
        return {
          insert: async (row) => {
            m.audits.push({ table, row: JSON.parse(JSON.stringify(row)) });
            return { error: null };
          },
        };
      },
      storage: {
        from(bucket) {
          return {
            upload: async (name, bytes, opts) => {
              m.storage.push({ bucket, op: "upload", name, opts, size: bytes.byteLength });
              if (bucket === "mcp-image-uploads") {
                if (m.staging.has(name) && !opts?.upsert) {
                  return {
                    data: null,
                    error: { statusCode: "409", message: "The resource already exists" },
                  };
                }
                m.staging.set(name, Buffer.from(bytes));
              }
              return { data: { path: name }, error: null };
            },
            createSignedUploadUrl: async (name) => {
              m.storage.push({ bucket, op: "createSignedUploadUrl", name });
              return {
                data: {
                  signedUrl: `https://kmpwughmwpdzsizrxhms.supabase.co/storage/v1/object/upload/sign/${bucket}/${name}?token=SECRET-TOKEN`,
                  token: "SECRET-TOKEN",
                  path: name,
                },
                error: null,
              };
            },
            download: async (name) => {
              m.storage.push({ bucket, op: "download", name });
              const b = m.staging.get(name);
              if (!b) return { data: null, error: { message: "Object not found" } };
              return { data: new Blob([b]), error: null };
            },
            remove: async (names) => {
              m.storage.push({ bucket, op: "remove", names });
              for (const n of names) m.staging.delete(n);
              return { data: [], error: null };
            },
          };
        },
      },
    },
    async fetchRemoteImage(raw, opts = {}) {
      m.fetchCalls.push(raw);
      const url = new URL(raw);
      if (opts.allowHost && !opts.allowHost(url.hostname.toLowerCase())) {
        const { McpInputError } = await import(pathToFileURL(join(SRC, "server/mcp/core.ts")).href);
        throw new McpInputError(opts.hostError ? opts.hostError(url.hostname) : "host");
      }
      return { bytes: new Uint8Array(m.fetchBytes), info: null, finalUrl: raw };
    },
  };
  return m;
}
function reset() {
  globalThis.__mock = freshMock();
  return globalThis.__mock;
}
reset();

process.env.SUPABASE_URL = "https://kmpwughmwpdzsizrxhms.supabase.co";
const TOKEN = "u".repeat(20) + "0123456789abcdef0123456789";
process.env.MCP_TOKEN = TOKEN;

const http = await import(join(SRC, "server/mcp/http.ts"));
const core = await import(join(SRC, "server/mcp/core.ts"));
const up = await import(join(SRC, "server/mcp/image-upload.ts"));

let rpcId = 0;
async function rpc(method, params, token = TOKEN) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-11-25",
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await http.handleMcpRequest(
    new Request("https://www.intervalbooks.tw/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
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
  return { status: res.status, json };
}
async function call(name, args, token) {
  const r = await rpc("tools/call", { name, arguments: args }, token);
  const result = r.json?.result;
  const text = result?.content?.[0]?.text ?? "";
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 錯誤是純文字 */
  }
  return { status: r.status, isError: result?.isError === true, text, body };
}
const KEY_RE = /^storage:[0-9a-f-]{36}\.(webp|jpg|png)$/;
const siteUploads = (m) => m.storage.filter((s) => s.bucket === "site-images" && s.op === "upload");
/** finalize 處理完之後：原路徑是 0 byte 墓碑（signed URL 之後只會 409）、有認領標記。 */
const tombstoned = (m, id) => m.staging.get(id)?.length === 0 && m.staging.has(`used/${id}`);

// -----------------------------------------------------------------------------
console.log("\n[1] upload_image_base64");
// -----------------------------------------------------------------------------
const B64 = PNG_1x1.toString("base64");
{
  const m = reset();
  const r = await call("upload_image_base64", {
    file_name: "cover.png",
    content_type: "image/png",
    data: B64,
  });
  check("合法 PNG → 成功", r.isError, false, r.text);
  checkTrue(
    "回傳 key 是 storage:<uuid>.png",
    KEY_RE.test(r.body?.key ?? "") && r.body.key.endsWith(".png"),
  );
  checkTrue(
    "回傳公開網址指向 site-images",
    (r.body?.url ?? "").includes("/storage/v1/object/public/site-images/"),
  );
  check("寬高", [r.body?.width, r.body?.height], [1, 1]);
  check(
    "存進 site-images 一次、型別由 magic bytes 決定",
    siteUploads(m).map((s) => s.opts.contentType),
    ["image/png"],
  );
  checkTrue("next_step 提醒要再填進 image_key", (r.body?.next_step ?? "").includes("image_key"));
  checkTrue("非 WebP 會警告（伺服器不轉檔）", Array.isArray(r.body?.warnings));
  checkTrue("沒有 dry_run 欄位", !("dry_run" in (r.body ?? {})));
}
{
  const m = reset();
  const r = await call("upload_image_base64", {
    file_name: "cover.png",
    content_type: "image/png",
    data: `data:image/png;base64,${B64.replace(/(.{20})/g, "$1\n")}`,
  });
  check("data URL 前綴＋換行 → 成功", [r.isError, siteUploads(m).length], [false, 1], r.text);
}
{
  const m = reset();
  const r = await call("upload_image_base64", {
    file_name: "cover.jpg",
    content_type: "image/jpeg",
    data: B64,
  });
  check("宣告 jpeg、內容是 png → 擋下、不存", [r.isError, siteUploads(m).length], [true, 0]);
  checkTrue("錯誤訊息講出實際格式", r.text.includes("image/png"), r.text);
}
{
  const m = reset();
  const r = await call("upload_image_base64", {
    file_name: "innocent.png",
    content_type: "image/png",
    data: HTML.toString("base64"),
  });
  check(
    "🔴 偽裝副檔名：.png 但內容是 HTML → 擋下、不存",
    [r.isError, siteUploads(m).length],
    [true, 0],
  );
  checkTrue("錯誤訊息講 magic bytes", r.text.includes("magic bytes"), r.text);
}
{
  const m = reset();
  const r1 = await call("upload_image_base64", {
    file_name: "logo.svg",
    content_type: "image/png",
    data: SVG.toString("base64"),
  });
  check("🔴 SVG 檔名 → 擋下", [r1.isError, siteUploads(m).length], [true, 0]);
  checkTrue("錯誤訊息講 SVG 不收", r1.text.includes("SVG"), r1.text);
  const r2 = await call("upload_image_base64", {
    file_name: "logo.png",
    content_type: "image/svg+xml",
    data: SVG.toString("base64"),
  });
  check(
    "🔴 content_type=image/svg+xml → schema 擋下",
    [r2.isError, siteUploads(m).length],
    [true, 0],
  );
  const r3 = await call("upload_image_base64", {
    file_name: "logo.png",
    content_type: "image/png",
    data: SVG.toString("base64"),
  });
  check("🔴 SVG 內容偽裝成 .png → 擋下", [r3.isError, siteUploads(m).length], [true, 0]);
  const r4 = await call("upload_image_base64", {
    file_name: "page.html",
    content_type: "image/png",
    data: PNG_1x1.toString("base64"),
  });
  check("🔴 .html 檔名 → 擋下", [r4.isError, siteUploads(m).length], [true, 0]);
}
{
  const m = reset();
  const big = Buffer.alloc(2 * 1024 * 1024 + 1);
  PNG_1x1.copy(big);
  const r = await call("upload_image_base64", {
    file_name: "huge.png",
    content_type: "image/png",
    data: big.toString("base64"),
  });
  check("🔴 超過 2MB → 擋下、不存", [r.isError, siteUploads(m).length], [true, 0]);
  checkTrue(
    "錯誤訊息是中文、建議壓縮或改用 create_image_upload_url",
    r.text.includes("壓縮") && r.text.includes("create_image_upload_url"),
    r.text,
  );
  const exact = Buffer.alloc(2 * 1024 * 1024);
  PNG_1x1.copy(exact);
  check(
    "剛好 2MB 的 base64 長度 = MCP_BASE64_MAX_CHARS（2,796,204）",
    [exact.toString("base64").length, up.MCP_BASE64_MAX_CHARS],
    [2796204, 2796204],
  );
  checkTrue(
    "2MB 的 base64 加 JSON 外框遠低於 Vercel 4.5MB body 上限",
    up.MCP_BASE64_MAX_CHARS + 2000 < 4.5 * 1000 * 1000,
  );
}
{
  const m = reset();
  const r = await call("upload_image_base64", {
    file_name: "a.png",
    content_type: "image/png",
    data: "這不是base64!!",
  });
  check("壞掉的 base64 → 擋下", [r.isError, siteUploads(m).length], [true, 0]);
}

// -----------------------------------------------------------------------------
console.log("\n[2] create_image_upload_url＋finalize_image_upload");
// -----------------------------------------------------------------------------
let issued = null;
{
  const m = reset();
  const r = await call("create_image_upload_url", {
    file_name: "../../../etc/passwd.png",
    content_type: "image/png",
    size: PNG_1x1.length,
  });
  check("申請成功", r.isError, false, r.text);
  issued = r.body;
  checkTrue(
    "🔴 upload_id 由伺服器產生（<秒數>-<uuid>.png），不含呼叫端給的檔名",
    /^\d{10}-[0-9a-f-]{36}\.png$/.test(issued?.upload_id ?? "") &&
      !issued.upload_id.includes("passwd"),
    issued?.upload_id,
  );
  const signs = m.storage.filter((s) => s.op === "createSignedUploadUrl");
  check(
    "🔴 signed URL 指向私有暫存 bucket，不是公開的 site-images",
    signs.map((s) => [s.bucket, s.name]),
    [["mcp-image-uploads", issued?.upload_id]],
  );
  check(
    "方法 PUT、header 帶 Content-Type",
    [issued?.method, issued?.headers?.["Content-Type"]],
    ["PUT", "image/png"],
  );
  checkTrue("curl 一行可照抄", /^curl .*-X PUT .*--data-binary @/.test(issued?.curl ?? ""));
  check("有效 10 分鐘、上限 2MB", [issued?.expires_in_seconds, issued?.max_bytes], [600, 2097152]);
  checkTrue(
    "next_step 提醒要 finalize 與填 image_key",
    /finalize_image_upload/.test(issued?.next_step) && /image_key/.test(issued?.next_step),
  );
  check("申請網址時不碰 site-images", siteUploads(m).length, 0);

  const r2 = await call("create_image_upload_url", {
    file_name: "big.jpg",
    content_type: "image/jpeg",
    size: 2 * 1024 * 1024 + 1,
  });
  check(
    "🔴 宣告超過 2MB → 不發網址",
    [r2.isError, m.storage.filter((s) => s.op === "createSignedUploadUrl").length],
    [true, 1],
  );
  const r3 = await call("create_image_upload_url", {
    file_name: "a.svg",
    content_type: "image/png",
    size: 100,
  });
  check("🔴 .svg 檔名 → 不發網址", r3.isError, true);
  const r4 = await call("create_image_upload_url", {
    file_name: "a.avif",
    content_type: "image/avif",
    size: 100,
  });
  check("image/avif → schema 擋下（網站只認 JPEG／PNG／WebP）", r4.isError, true);
}
{
  const m = reset();
  m.staging.set(issued.upload_id, PNG_1x1);
  const r = await call("finalize_image_upload", { upload_id: issued.upload_id });
  check("finalize：合格 PNG → 成功", r.isError, false, r.text);
  checkTrue(
    "回傳 key 是 storage:<uuid>.png（新的 uuid）",
    KEY_RE.test(r.body?.key ?? "") && !r.body.key.includes(issued.upload_id),
  );
  check("存進 site-images 一次", siteUploads(m).length, 1);
  checkTrue(
    "🔴 暫存檔換成 0 byte 墓碑＋認領標記（大檔不留、同一張 URL 之後只會 409）",
    tombstoned(m, issued.upload_id),
  );
  const again = await call("finalize_image_upload", { upload_id: issued.upload_id });
  check(
    "🔴 同一個 upload_id 第二次 finalize → 擋下（只能用一次）",
    [again.isError, siteUploads(m).length],
    [true, 1],
  );
}
{
  const m = reset();
  const id = up.newUploadId("image/png");
  const early = await call("finalize_image_upload", { upload_id: id });
  check("還沒傳就 finalize → 回錯、不存", [early.isError, siteUploads(m).length], [true, 0]);
  check("認領標記收回了（傳好之後可以再 finalize）", m.staging.has(`used/${id}`), false);
  m.staging.set(id, PNG_1x1);
  const later = await call("finalize_image_upload", { upload_id: id });
  check(
    "傳好之後再 finalize → 成功",
    [later.isError, siteUploads(m).length],
    [false, 1],
    later.text,
  );
}
{
  const m = reset();
  const id = up.newUploadId("image/png");
  m.staging.set(id, PNG_1x1);
  const [a, b] = await Promise.all([
    call("finalize_image_upload", { upload_id: id }),
    call("finalize_image_upload", { upload_id: id }),
  ]);
  check(
    "🔴 同時 finalize 兩次 → 只有一次成功、只存一份",
    [[a.isError, b.isError].filter((x) => !x).length, siteUploads(m).length],
    [1, 1],
  );
}
{
  const m = reset();
  const id = up.newUploadId("image/png");
  m.staging.set(id, HTML);
  const r = await call("finalize_image_upload", { upload_id: id });
  check("🔴 直傳了 HTML（假裝 png）→ 擋下、不存", [r.isError, siteUploads(m).length], [true, 0]);
  checkTrue("不合格的暫存檔也換成墓碑", tombstoned(m, id));
}
{
  const m = reset();
  const id = up.newUploadId("image/png");
  m.staging.set(id, Buffer.from(SVG));
  const r = await call("finalize_image_upload", { upload_id: id });
  check(
    "🔴 直傳了 SVG → 擋下、換成墓碑",
    [r.isError, siteUploads(m).length, tombstoned(m, id)],
    [true, 0, true],
  );
}
{
  const m = reset();
  const id = up.newUploadId("image/jpeg");
  m.staging.set(id, PNG_1x1);
  const r = await call("finalize_image_upload", { upload_id: id });
  check("申請 jpeg、傳 png → 擋下（與宣告不符）", [r.isError, siteUploads(m).length], [true, 0]);
}
{
  const m = reset();
  const id = up.newUploadId("image/png", Date.now() - 11 * 60 * 1000);
  m.staging.set(id, PNG_1x1);
  const r = await call("finalize_image_upload", { upload_id: id });
  check(
    "🔴 超過 10 分鐘 → 擋下、換成墓碑、不存",
    [r.isError, siteUploads(m).length, m.staging.get(id)?.length],
    [true, 0, 0],
  );
  checkTrue("錯誤訊息叫你重新申請", r.text.includes("create_image_upload_url"), r.text);
}
{
  const m = reset();
  for (const bad of [
    "../site-images/x.png",
    "1700000000-x.png",
    "abc",
    "1700000000-00000000-0000-0000-0000-000000000000.svg",
  ]) {
    const r = await call("finalize_image_upload", { upload_id: bad });
    check(`🔴 upload_id「${bad}」→ 格式錯、不碰 storage`, [r.isError, m.storage.length], [true, 0]);
  }
}

// -----------------------------------------------------------------------------
console.log("\n[3] upload_image_file（ChatGPT 檔案）");
// -----------------------------------------------------------------------------
const FILE = (url, extra = {}) => ({
  file: { download_url: url, file_id: "file_abc123", ...extra },
});
{
  const m = reset();
  const r = await call(
    "upload_image_file",
    FILE("https://files.oaiusercontent.com/file-abc?se=2026&sig=SIGNATURE", {
      mime_type: "image/png",
      file_name: "generated.png",
    }),
  );
  check("OpenAI 網域、PNG → 成功", r.isError, false, r.text);
  checkTrue("回傳 key", KEY_RE.test(r.body?.key ?? ""));
  check("存進 site-images 一次", siteUploads(m).length, 1);
  check(
    "只帶必填兩欄（mime_type／file_name 省略）也行",
    (await call("upload_image_file", FILE("https://sdmntprwestus.oaiusercontent.com/x"))).isError,
    false,
  );
}
{
  for (const url of [
    "https://evil.example.com/a.png",
    "https://oaiusercontent.com.evil.com/a.png",
    "https://evil-oaiusercontent.com/a.png",
    "https://169.254.169.254/latest/meta-data",
  ]) {
    const m = reset();
    const r = await call("upload_image_file", FILE(url));
    check(
      `🔴 非 OpenAI 網域 ${new URL(url).hostname} → 擋下、不存`,
      [r.isError, siteUploads(m).length],
      [true, 0],
    );
  }
  const m = reset();
  const r = await call("upload_image_file", FILE("https://evil.example.com/a.png"));
  checkTrue(
    "錯誤訊息叫你一般網址改用 upload_image_from_url",
    r.text.includes("upload_image_from_url"),
    r.text,
  );
  check("擋在下載之前就拒絕的不會存", siteUploads(m).length, 0);
}
{
  check(
    "OpenAI 網域判斷（含子網域、拒絕仿冒）",
    [
      "files.oaiusercontent.com",
      "oaiusercontent.com",
      "cdn.openai.com",
      "chatgpt.com",
      "oaiusercontent.com.evil.com",
      "evil-openai.com",
      "openai.com.cn",
    ].map(up.isOpenAIFileHost),
    [true, true, true, true, false, false, false],
  );
  const remoteSrc = readFileSync(join(SRC, "server/mcp/remote-image.ts"), "utf8");
  checkTrue(
    "🔴 轉址目的地也要過白名單（每一跳都 checkHost）",
    /url = checkHost\(assertUrlShape\(new URL\(hop\.location, url\)\.href\)\)/.test(remoteSrc),
  );
}
{
  const m = reset();
  m.fetchBytes = HTML;
  const r = await call(
    "upload_image_file",
    FILE("https://files.oaiusercontent.com/x", { mime_type: "image/png" }),
  );
  check("🔴 OpenAI 網域但內容是 HTML → 擋下", [r.isError, siteUploads(m).length], [true, 0]);
  const m2 = reset();
  const r2 = await call(
    "upload_image_file",
    FILE("https://files.oaiusercontent.com/x", { mime_type: "image/svg+xml" }),
  );
  check("🔴 mime_type=image/svg+xml → 擋下", [r2.isError, siteUploads(m2).length], [true, 0]);
  const m3 = reset();
  const r3 = await call("upload_image_file", { file: "chat_upload" });
  check(
    "ChatGPT 手機版的已知 bug（file 變成字串）→ 回錯、不當機",
    [r3.isError, siteUploads(m3).length],
    [true, 0],
  );
}

// -----------------------------------------------------------------------------
console.log("\n[4] 稽核");
// -----------------------------------------------------------------------------
{
  const m = reset();
  await call("upload_image_base64", {
    file_name: "cover.png",
    content_type: "image/png",
    data: B64,
  });
  await call(
    "upload_image_file",
    FILE("https://files.oaiusercontent.com/f?sig=SIGNATURE-XYZ", { file_name: "g.png" }),
  );
  const c = await call("create_image_upload_url", {
    file_name: "c.png",
    content_type: "image/png",
    size: 100,
  });
  m.staging.set(c.body.upload_id, PNG_1x1);
  await call("finalize_image_upload", { upload_id: c.body.upload_id });
  const rows = m.audits.filter((a) => a.table === "mcp_audit_log").map((a) => a.row);
  check(
    "四次呼叫都記了稽核",
    rows.map((r) => r.tool),
    [
      "upload_image_base64",
      "upload_image_file",
      "create_image_upload_url",
      "finalize_image_upload",
    ],
  );
  const all = JSON.stringify(rows);
  checkTrue("🔴 稽核不含 base64 內容", !all.includes(B64) && !all.includes(B64.slice(0, 40)));
  checkTrue(
    "🔴 稽核不含 ChatGPT 的 download_url／簽章",
    !all.includes("SIGNATURE-XYZ") && !all.includes("download_url"),
  );
  checkTrue("🔴 稽核不含 signed URL 的 token", !all.includes("SECRET-TOKEN"));
  const b = rows[0].changes;
  check(
    "base64 稽核只記檔名、大小、格式、key",
    [b.file_name, b.bytes, b.content_type, KEY_RE.test(b.key)],
    ["cover.png", PNG_1x1.length, "image/png", true],
  );
  check(
    "稽核 action",
    rows.map((r) => r.action),
    ["upload", "upload", "create", "upload"],
  );
  check("稽核帶呼叫者身分（靜態 token）", rows[0].changes._actor, {
    via: "static_token",
    access: "write",
  });
  check(
    "稽核正式欄位（0054）：actor_via／client_name／dry_run",
    [rows[0].actor_via, rows[0].client_name, rows[0].dry_run],
    ["static_token", "static_token", false],
  );
}

// -----------------------------------------------------------------------------
console.log("\n[5] key 能被 update_event 等工具接受");
// -----------------------------------------------------------------------------
{
  const m = reset();
  const r = await call("upload_image_base64", {
    file_name: "cover.png",
    content_type: "image/png",
    data: B64,
  });
  check(
    "imageKeyFromArg(key) 原樣接受（update_event／create_event 的 image_key 走這支）",
    core.imageKeyFromArg(r.body.key),
    r.body.key,
  );
  check("公開網址也換得回 key", core.imageKeyFromArg(r.body.url), r.body.key);
  void m;
}

// -----------------------------------------------------------------------------
console.log("\n[6] 權限");
// -----------------------------------------------------------------------------
for (const [name, args] of [
  ["upload_image_base64", { file_name: "a.png", content_type: "image/png", data: B64 }],
  ["create_image_upload_url", { file_name: "a.png", content_type: "image/png", size: 100 }],
  ["finalize_image_upload", { upload_id: up.newUploadId("image/png") }],
  ["upload_image_file", FILE("https://files.oaiusercontent.com/x")],
]) {
  const m = reset();
  const noToken = await call(name, args, null);
  const wrong = await call(name, args, "w".repeat(46));
  check(
    `🔴 ${name}：沒 token／token 錯 → 401，不碰 storage、不記稽核`,
    [noToken.status, wrong.status, m.storage.length, m.audits.length],
    [401, 401, 0, 0],
  );
}

// -----------------------------------------------------------------------------
console.log("\n[7] tools/list");
// -----------------------------------------------------------------------------
{
  reset();
  const list = await rpc("tools/list", {});
  const tools = list.json?.result?.tools ?? [];
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of [
    "create_image_upload_url",
    "finalize_image_upload",
    "upload_image_base64",
    "upload_image_file",
  ]) {
    checkTrue(`${n} 在 tools/list`, !!by[n]);
    checkTrue(`${n} 沒有 dry_run`, !("dry_run" in (by[n]?.inputSchema?.properties ?? {})));
    checkTrue(`${n} 說明提醒要再填進 image_key`, (by[n]?.description ?? "").includes("image_key"));
  }
  for (const n of [
    "upload_image_from_url",
    "create_image_upload_url",
    "upload_image_base64",
    "upload_image_file",
  ]) {
    const d = by[n]?.description ?? "";
    checkTrue(
      `${n} 說明有三種情境（中英）`,
      [
        "upload_image_from_url",
        "create_image_upload_url",
        "upload_image_base64",
        "upload_image_file",
        "Which upload tool",
        "curl",
      ].every((w) => d.includes(w)),
    );
  }
  check(
    "🔴 upload_image_file 的 _meta 有 openai/fileParams",
    by.upload_image_file?._meta?.["openai/fileParams"],
    ["file"],
  );
  const fileSchema = by.upload_image_file?.inputSchema?.properties?.file;
  check("file 物件宣告四個欄位", Object.keys(fileSchema?.properties ?? {}).sort(), [
    "download_url",
    "file_id",
    "file_name",
    "mime_type",
  ]);
  check("file 物件只要求 download_url、file_id", [...(fileSchema?.required ?? [])].sort(), [
    "download_url",
    "file_id",
  ]);
  checkTrue(
    "upload_image_file 說明寫「ChatGPT 生成或使用者貼上的圖片，請用這支」",
    (by.upload_image_file?.description ?? "").includes("ChatGPT 生成或使用者貼上的圖片，請用這支"),
  );
  check(
    "content_type 只收三種",
    by.upload_image_base64?.inputSchema?.properties?.content_type?.enum,
    ["image/jpeg", "image/png", "image/webp"],
  );

  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "selftest", version: "0" },
  });
  const ins = init.json?.result?.instructions ?? "";
  checkTrue(
    "instructions 中英文都講三種情境",
    [
      "upload_image_from_url",
      "create_image_upload_url",
      "finalize_image_upload",
      "upload_image_file",
      "upload_image_base64",
      "Pick by situation",
      "依情境選一支",
    ].every((w) => ins.includes(w)),
  );
}

console.log(`\n##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exit(1);
}
console.log(green(`✓ 全部通過：${pass} passed`));
