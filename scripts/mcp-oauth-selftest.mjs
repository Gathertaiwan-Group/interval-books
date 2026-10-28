#!/usr/bin/env node
/**
 * mcp-oauth-selftest.mjs —— MCP 的 OAuth authorization server（src/server/mcp/oauth*.ts）自檢
 *
 * **直接 import production 的模組本人**（oauth-core.ts、core.ts、oauth.ts、http.ts），不碰資料庫：
 * 角色查詢（profiles）一律由測試注入替身。
 *
 *   [1] metadata 形狀（PRM／AS）、沒開 OAuth 時 404、openid-configuration 永遠 404
 *   [2] 動態註冊：白名單 redirect_uri、拒絕其他、client_id 簽章、竄改即失效
 *   [3] /authorize 參數：client／redirect_uri 錯 → 不導回；PKCE 必填且只收 S256（擋降級）
 *   [4] PKCE、授權碼：簽發／驗證／到期／竄改／跨 client／redirect_uri 不符／重放
 *   [5] refresh 輪替、絕對壽命、角色閘門（不再是 admin → 拒絕）
 *   [6] /api/mcp 兩種身分：靜態 MCP_TOKEN 與 OAuth access token；401 帶 resource_metadata；
 *       每次呼叫重查角色；查不到 → 503 不放行
 *   [7] 同意頁 CSRF token、HTTP 端點（register／token／revoke）的狀態碼與標頭、限流
 *   [8] 掛載與原始碼守門（不記 token、frame-ancestors、/admin/login 的 redirect 只收授權頁）
 *   [9] 0043 的狀態層（OAuthStore，記憶體版替身）：授權碼跨 instance 只能用一次、refresh
 *       重用 → 整條鏈撤銷、/oauth/revoke 真的撤銷、access token 查鏈與 epoch、升級前簽發的
 *       舊 token（沒有 gid）向下相容（舊 refresh 用一次就搬進新鏈）、store 出錯 fail closed
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";
import { createHash, randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/mcp-oauth-selftest.mjs";
const SRC = join(ROOT, "src");

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
const checkTrue = (label, v) => check(label, v === true, true);

const readFile = (p) => {
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};

console.log("═══ MCP OAuth 自檢 ═══");

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

const oc = await import(join(SRC, "server/mcp/oauth-core.ts"));
const core = await import(join(SRC, "server/mcp/core.ts"));
const oauth = await import(join(SRC, "server/mcp/oauth.ts"));
const http = await import(join(SRC, "server/mcp/http.ts"));
const paths = await import(join(SRC, "server/mcp/oauth-paths.ts"));
const loginRedirect = await import(join(SRC, "lib/admin/login-redirect.ts"));

const SECRET = randomBytes(48).toString("base64url");
const OTHER_SECRET = randomBytes(48).toString("base64url");
const BASE = "https://www.intervalbooks.tw";
const RESOURCE = `${BASE}/api/mcp`;
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";
const admins = new Set([ADMIN]);
const isAdmin = async (id) => admins.has(id);

const verifier = () => randomBytes(32).toString("base64url");
const challengeOf = (v) => createHash("sha256").update(v).digest("base64url");

async function rejectsWith(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e?.code ?? e?.message ?? String(e);
  }
}

// -----------------------------------------------------------------------------
console.log("\n[1] metadata");
{
  const prm = oc.protectedResourceMetadata(BASE);
  check("PRM resource", prm.resource, RESOURCE);
  check("PRM authorization_servers", prm.authorization_servers, [BASE]);
  const as = oc.authorizationServerMetadata(BASE);
  check("AS issuer", as.issuer, BASE);
  check("AS authorization_endpoint", as.authorization_endpoint, `${BASE}/oauth/authorize`);
  check("AS token_endpoint", as.token_endpoint, `${BASE}/oauth/token`);
  check("AS registration_endpoint", as.registration_endpoint, `${BASE}/oauth/register`);
  check("AS revocation_endpoint", as.revocation_endpoint, `${BASE}/oauth/revoke`);
  check("AS response_types", as.response_types_supported, ["code"]);
  check("AS grant_types", as.grant_types_supported, ["authorization_code", "refresh_token"]);
  check("🔴 AS code_challenge_methods 只有 S256", as.code_challenge_methods_supported, ["S256"]);
  checkTrue(
    "AS token auth methods 含 none",
    as.token_endpoint_auth_methods_supported.includes("none"),
  );
  check("AS scopes", as.scopes_supported, ["mcp"]);

  check("正式站 base 不信任 Host header", oc.oauthBaseUrl("https://evil.example/x"), BASE);
  check(
    "本機 dev 用請求的 origin",
    oc.oauthBaseUrl("http://localhost:8080/x"),
    "http://localhost:8080",
  );
  check("https://localhost 不算本機 dev", oc.oauthBaseUrl("https://localhost:8080/x"), BASE);

  const saved = process.env.MCP_OAUTH_SECRET;
  delete process.env.MCP_OAUTH_SECRET;
  const off = oauth.handleOAuthDiscovery(
    new Request(`${BASE}/.well-known/oauth-protected-resource`),
    "/.well-known/oauth-protected-resource",
  );
  check("沒設 MCP_OAUTH_SECRET → discovery 404", off.status, 404);
  process.env.MCP_OAUTH_SECRET = "short";
  check(
    "MCP_OAUTH_SECRET 短於 32 字 → 視同沒設",
    oauth.handleOAuthDiscovery(
      new Request(`${BASE}/.well-known/oauth-authorization-server`),
      "/.well-known/oauth-authorization-server",
    ).status,
    404,
  );
  process.env.MCP_OAUTH_SECRET = SECRET;
  for (const p of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
    "/api/mcp/.well-known/oauth-protected-resource",
  ]) {
    const r = oauth.handleOAuthDiscovery(new Request(`${BASE}${p}`), p);
    const j = await r.json();
    check(`${p} → 200 + resource`, [r.status, j.resource], [200, RESOURCE]);
    check(`${p} 不可快取`, r.headers.get("cache-control"), "no-store");
  }
  for (const p of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/mcp",
  ]) {
    const r = oauth.handleOAuthDiscovery(new Request(`${BASE}${p}`), p);
    const j = await r.json();
    check(`${p} → 200 + issuer`, [r.status, j.issuer], [200, BASE]);
  }
  check(
    "openid-configuration 永遠 404（不是 OIDC）",
    oauth.handleOAuthDiscovery(
      new Request(`${BASE}/.well-known/openid-configuration`),
      "/.well-known/openid-configuration",
    ).status,
    404,
  );
  checkTrue(
    "isOAuthDiscoveryPath 認得 PRM",
    core.isOAuthDiscoveryPath("/.well-known/oauth-protected-resource"),
  );
  if (saved === undefined) delete process.env.MCP_OAUTH_SECRET;
  else process.env.MCP_OAUTH_SECRET = saved;
}

// -----------------------------------------------------------------------------
console.log("\n[2] 動態註冊");
let claudeClient;
let localClient;
{
  claudeClient = oc.registerClient({ client_name: "Claude", redirect_uris: [CLAUDE_CB] }, SECRET);
  checkTrue("claude.ai callback 可以註冊", claudeClient.client_id.startsWith("ibc1."));
  check("預設 token_endpoint_auth_method=none", claudeClient.token_endpoint_auth_method, "none");
  check("none 不發 client_secret", claudeClient.client_secret, undefined);
  checkTrue(
    "claude.com callback 可以註冊",
    Boolean(
      oc.registerClient({ redirect_uris: ["https://claude.com/api/mcp/auth_callback"] }, SECRET)
        .client_id,
    ),
  );
  localClient = oc.registerClient(
    { client_name: "Claude Code", redirect_uris: ["http://localhost:53682/callback"] },
    SECRET,
  );
  checkTrue("http://localhost:port/callback 可以註冊", Boolean(localClient.client_id));
  checkTrue(
    "http://127.0.0.1:port/ 可以註冊",
    Boolean(oc.registerClient({ redirect_uris: ["http://127.0.0.1:9999/cb"] }, SECRET).client_id),
  );

  for (const bad of [
    "https://evil.example/cb",
    "https://claude.ai/api/mcp/auth_callback/../../x",
    "https://claude.ai.evil.example/api/mcp/auth_callback",
    "http://claude.ai/api/mcp/auth_callback",
    "https://localhost:3000/cb",
    "http://localhost.evil.example/cb",
    "http://localhost:1234@evil.example/cb",
    "http://localhost:1234/cb#frag",
    "javascript:alert(1)",
    "http://[::1]:1234/cb",
    "",
  ]) {
    check(
      `拒絕註冊 ${JSON.stringify(bad)}`,
      await rejectsWith(() => oc.registerClient({ redirect_uris: [bad] }, SECRET)),
      "invalid_redirect_uri",
    );
  }
  check(
    "redirect_uris 缺 → 拒絕",
    await rejectsWith(() => oc.registerClient({}, SECRET)),
    "invalid_redirect_uri",
  );
  check(
    "body 不是物件 → 拒絕",
    await rejectsWith(() => oc.registerClient("x", SECRET)),
    "invalid_client_metadata",
  );
  check(
    "不支援的 grant_types → 拒絕",
    await rejectsWith(() =>
      oc.registerClient(
        { redirect_uris: [CLAUDE_CB], grant_types: ["client_credentials"] },
        SECRET,
      ),
    ),
    "invalid_client_metadata",
  );
  check(
    "client_name 的控制字元／雙向覆寫被拿掉",
    oc.registerClient({ client_name: "Cl‮aude\u0007", redirect_uris: [CLAUDE_CB] }, SECRET)
      .client_name,
    "Claude",
  );

  const verified = oc.verifyClientId(claudeClient.client_id, SECRET);
  check("client_id 驗得回來", verified?.redirect_uris, [CLAUDE_CB]);
  check(
    "換 secret 後 client_id 失效（總開關）",
    oc.verifyClientId(claudeClient.client_id, OTHER_SECRET),
    null,
  );
  const [pre, body, sig] = [
    claudeClient.client_id.slice(0, 5),
    ...claudeClient.client_id.slice(5).split("."),
  ];
  const forgedBody = Buffer.from(
    JSON.stringify({ v: 1, n: "Claude", r: ["https://evil.example/cb"], m: "none", t: 1 }),
  ).toString("base64url");
  check(
    "竄改 client_id 的 redirect_uris → 簽章不符",
    oc.verifyClientId(`${pre}${forgedBody}.${sig}`, SECRET),
    null,
  );
  check(
    "client_id 簽章少一個字 → 失效",
    oc.verifyClientId(`${pre}${body}.${sig.slice(0, -1)}`, SECRET),
    null,
  );

  const sec = oc.registerClient(
    { redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: "client_secret_post" },
    SECRET,
  );
  checkTrue(
    "client_secret_post 會發 client_secret",
    typeof sec.client_secret === "string" && sec.client_secret.length >= 40,
  );
  const p = new URLSearchParams({ client_id: sec.client_id, client_secret: "wrong" });
  check(
    "client_secret 錯 → invalid_client",
    await rejectsWith(() => oc.authenticateClient(p, null, SECRET)),
    "invalid_client",
  );
  p.set("client_secret", sec.client_secret);
  check("client_secret 對 → 通過", oc.authenticateClient(p, null, SECRET).client_id, sec.client_id);
  check(
    "未知 client_id → invalid_client",
    await rejectsWith(() =>
      oc.authenticateClient(new URLSearchParams({ client_id: "ibc1.x.y" }), null, SECRET),
    ),
    "invalid_client",
  );
}

// -----------------------------------------------------------------------------
console.log("\n[3] /authorize 參數");
const authQuery = (over = {}) => {
  const v = over.__verifier ?? verifier();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: claudeClient.client_id,
    redirect_uri: CLAUDE_CB,
    code_challenge: challengeOf(v),
    code_challenge_method: "S256",
    state: "st-123",
    scope: "mcp",
    resource: RESOURCE,
  });
  for (const [k, val] of Object.entries(over)) {
    if (k === "__verifier") continue;
    if (val === null) q.delete(k);
    else q.set(k, val);
  }
  return { query: q.toString(), verifier: v };
};
{
  const ok = oc.checkAuthorizeParams(authQuery().query, SECRET, BASE);
  checkTrue("正常參數 → ok", ok.ok);
  check("scope 一律 mcp", ok.req?.scope, "mcp");

  const badClient = oc.checkAuthorizeParams(
    authQuery({ client_id: "ibc1.nope.nope" }).query,
    SECRET,
    BASE,
  );
  check("🔴 未知 client → fatal（不導回）", [badClient.ok, badClient.fatal], [false, true]);
  const badRedirect = oc.checkAuthorizeParams(
    authQuery({ redirect_uri: "https://evil.example/cb" }).query,
    SECRET,
    BASE,
  );
  check(
    "🔴 redirect_uri 不是註冊的 → fatal（不導回，擋 open redirect）",
    [badRedirect.ok, badRedirect.fatal],
    [false, true],
  );
  const otherAllowed = oc.checkAuthorizeParams(
    authQuery({ redirect_uri: "https://claude.com/api/mcp/auth_callback" }).query,
    SECRET,
    BASE,
  );
  check("白名單內但不是這個 client 註冊的 → fatal", otherAllowed.fatal, true);
  const noRedirect = oc.checkAuthorizeParams(authQuery({ redirect_uri: null }).query, SECRET, BASE);
  check("只註冊一個 redirect_uri 時可以省略", noRedirect.req?.redirectUri, CLAUDE_CB);
  const dupClient = `${authQuery().query}&client_id=${encodeURIComponent(localClient.client_id)}`;
  check("client_id 重複 → fatal", oc.checkAuthorizeParams(dupClient, SECRET, BASE).fatal, true);

  const back = (over) => {
    const r = oc.checkAuthorizeParams(authQuery(over).query, SECRET, BASE);
    if (r.ok || r.fatal) return null;
    const u = new URL(r.redirectUrl);
    return [u.origin + u.pathname, u.searchParams.get("error"), u.searchParams.get("state")];
  };
  check(
    "🔴 沒帶 code_challenge_method → 導回 invalid_request（不降級成 plain）",
    back({ code_challenge_method: null }),
    [CLAUDE_CB, "invalid_request", "st-123"],
  );
  check(
    "🔴 code_challenge_method=plain → invalid_request",
    back({ code_challenge_method: "plain" }),
    [CLAUDE_CB, "invalid_request", "st-123"],
  );
  check("沒帶 code_challenge → invalid_request", back({ code_challenge: null }), [
    CLAUDE_CB,
    "invalid_request",
    "st-123",
  ]);
  check("response_type=token → unsupported_response_type", back({ response_type: "token" }), [
    CLAUDE_CB,
    "unsupported_response_type",
    "st-123",
  ]);
  check("resource 指向別處 → invalid_target", back({ resource: "https://evil.example/api/mcp" }), [
    CLAUDE_CB,
    "invalid_target",
    "st-123",
  ]);
  check("scope 不含 mcp → invalid_scope", back({ scope: "admin" }), [
    CLAUDE_CB,
    "invalid_scope",
    "st-123",
  ]);
  checkTrue(
    "沒帶 resource、沒帶 scope 也可以",
    oc.checkAuthorizeParams(authQuery({ resource: null, scope: null }).query, SECRET, BASE).ok,
  );
}

// -----------------------------------------------------------------------------
console.log("\n[4] PKCE 與授權碼");
oc.__TEST_ONLY__.resetUsedCodes();
const tokenParams = (o) => new URLSearchParams(o);
async function codeFor(client, redirectUri, userId = ADMIN, now) {
  const v = verifier();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challengeOf(v),
    code_challenge_method: "S256",
    state: "s",
  }).toString();
  const chk = oc.checkAuthorizeParams(q, SECRET, BASE);
  const code = oc.mintCode(chk.req, userId, SECRET, now);
  return { code, verifier: v, req: chk.req };
}
{
  const v = verifier();
  checkTrue("PKCE：正確 verifier 通過", oc.verifyPkce(v, challengeOf(v)));
  check("PKCE：錯的 verifier", oc.verifyPkce(verifier(), challengeOf(v)), false);
  check("PKCE：太短的 verifier", oc.verifyPkce("abc", challengeOf("abc")), false);
  check(
    "PKCE：verifier 直接等於 challenge（plain 攻擊）",
    oc.verifyPkce(challengeOf(v), challengeOf(v)),
    false,
  );

  const { code, verifier: cv, req } = await codeFor(claudeClient, CLAUDE_CB);
  checkTrue("授權碼前綴", code.startsWith("ibcode1."));
  const redirect = new URL(oc.approvalRedirect(req, code, BASE));
  check(
    "導回網址帶 code、state、iss",
    [
      redirect.searchParams.get("code") === code,
      redirect.searchParams.get("state"),
      redirect.searchParams.get("iss"),
    ],
    [true, "s", BASE],
  );
  checkTrue(
    "授權碼裡看不到 user id（加密的）",
    !code.includes(ADMIN) &&
      !Buffer.from(code.slice(8), "base64url").toString("latin1").includes(ADMIN),
  );

  const base = {
    grant_type: "authorization_code",
    client_id: claudeClient.client_id,
    redirect_uri: CLAUDE_CB,
  };
  check(
    "錯的 verifier → invalid_grant",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({ ...base, code, code_verifier: verifier() }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );
  check(
    "沒帶 verifier → invalid_grant",
    await rejectsWith(() =>
      oc.exchangeToken(tokenParams({ ...base, code }), null, SECRET, BASE, isAdmin),
    ),
    "invalid_grant",
  );
  check(
    "redirect_uri 不符 → invalid_grant",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({
          ...base,
          redirect_uri: "https://claude.com/api/mcp/auth_callback",
          code,
          code_verifier: cv,
        }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );
  check(
    "別的 client 拿這張碼 → invalid_grant",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({ ...base, client_id: localClient.client_id, code, code_verifier: cv }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );
  const tampered = code.slice(0, -3) + (code.endsWith("A") ? "BBB" : "AAA");
  check(
    "竄改授權碼 → invalid_grant",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({ ...base, code: tampered, code_verifier: cv }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );
  check(
    "換 secret → 授權碼失效",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({
          ...base,
          client_id: oc.registerClient({ redirect_uris: [CLAUDE_CB] }, OTHER_SECRET).client_id,
          code,
          code_verifier: cv,
        }),
        null,
        OTHER_SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );
  check(
    "授權碼不能當 access token 用",
    core.authenticateMcpRequest(
      new Request(RESOURCE, { method: "POST", headers: { authorization: `Bearer ${code}` } }),
      undefined,
      SECRET,
    ).kind,
    "deny",
  );

  const tok = await oc.exchangeToken(
    tokenParams({ ...base, code, code_verifier: cv }),
    null,
    SECRET,
    BASE,
    isAdmin,
  );
  check(
    "換到 token：token_type／expires_in／scope",
    [tok.token_type, tok.expires_in, tok.scope],
    ["Bearer", 3600, "mcp"],
  );
  checkTrue(
    "access／refresh 前綴",
    tok.access_token.startsWith("ibat1.") && tok.refresh_token.startsWith("ibrt1."),
  );
  check(
    "🔴 同一張碼第二次 → invalid_grant（同一 instance 內防重放）",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({ ...base, code, code_verifier: cv }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );

  const old = await codeFor(claudeClient, CLAUDE_CB, ADMIN, oc.nowSeconds() - 301);
  check(
    "超過 5 分鐘的授權碼 → invalid_grant",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({ ...base, code: old.code, code_verifier: old.verifier }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );

  const staffCode = await codeFor(claudeClient, CLAUDE_CB, STAFF);
  check(
    "🔴 授權者已不是 admin → invalid_grant",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({ ...base, code: staffCode.code, code_verifier: staffCode.verifier }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );

  const local = await codeFor(localClient, "http://localhost:53682/callback");
  const lt = await oc.exchangeToken(
    tokenParams({
      grant_type: "authorization_code",
      client_id: localClient.client_id,
      redirect_uri: "http://localhost:53682/callback",
      code: local.code,
      code_verifier: local.verifier,
    }),
    null,
    SECRET,
    BASE,
    isAdmin,
  );
  checkTrue("localhost client 也能換到 token", lt.access_token.startsWith("ibat1."));
  check(
    "不支援的 grant_type",
    await rejectsWith(() =>
      oc.exchangeToken(tokenParams({ grant_type: "password" }), null, SECRET, BASE, isAdmin),
    ),
    "unsupported_grant_type",
  );

  // ---- [5] refresh
  console.log("\n[5] refresh 輪替與角色閘門");
  const r1 = await oc.exchangeToken(
    tokenParams({
      grant_type: "refresh_token",
      client_id: claudeClient.client_id,
      refresh_token: tok.refresh_token,
    }),
    null,
    SECRET,
    BASE,
    isAdmin,
  );
  checkTrue(
    "refresh → 新的 access",
    r1.access_token.startsWith("ibat1.") && r1.access_token !== tok.access_token,
  );
  checkTrue("refresh 輪替（發新的 refresh_token）", r1.refresh_token !== tok.refresh_token);
  check(
    "refresh 不能給別的 client 用",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({
          grant_type: "refresh_token",
          client_id: localClient.client_id,
          refresh_token: r1.refresh_token,
        }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );
  check(
    "access token 不能拿去 refresh",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({
          grant_type: "refresh_token",
          client_id: claudeClient.client_id,
          refresh_token: r1.access_token,
        }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );
  const later = oc.nowSeconds() + 91 * 24 * 3600;
  check(
    "🔴 超過 90 天絕對壽命 → invalid_grant",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({
          grant_type: "refresh_token",
          client_id: claudeClient.client_id,
          refresh_token: r1.refresh_token,
        }),
        null,
        SECRET,
        BASE,
        isAdmin,
        later,
      ),
    ),
    "invalid_grant",
  );
  admins.delete(ADMIN);
  check(
    "🔴 被降成非 admin 後 refresh → invalid_grant",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({
          grant_type: "refresh_token",
          client_id: claudeClient.client_id,
          refresh_token: r1.refresh_token,
        }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );
  admins.add(ADMIN);

  const at = oc.verifyAccessToken(r1.access_token, SECRET, BASE);
  check("access token 綁 user 與 audience", [at?.sub, at?.aud], [ADMIN, RESOURCE]);
  check(
    "access token 換 audience（本機簽的拿到正式站）→ 失效",
    oc.verifyAccessToken(r1.access_token, SECRET, "http://localhost:8080"),
    null,
  );
  check(
    "access token 到期 → 失效",
    oc.verifyAccessToken(r1.access_token, SECRET, BASE, oc.nowSeconds() + 3601),
    null,
  );

  // ---- [6] /api/mcp
  console.log("\n[6] /api/mcp 兩種身分");
  const STATIC = "s".repeat(10) + "0123456789abcdef0123456789abcdef";
  const mcpReq = (auth, extra = {}) =>
    new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(auth ? { authorization: auth } : {}),
        ...extra,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  const a1 = core.authenticateMcpRequest(mcpReq(null), STATIC, SECRET);
  check("沒帶 token → 401", a1.response?.status, 401);
  check(
    "🔴 開了 OAuth：401 帶 resource_metadata",
    a1.response?.headers.get("www-authenticate"),
    `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
  );
  const a2 = core.authenticateMcpRequest(mcpReq("Bearer ibat1.garbage"), STATIC, SECRET);
  checkTrue(
    "壞掉的 OAuth token → 401 invalid_token + resource_metadata",
    a2.response?.status === 401 &&
      /error="invalid_token"/.test(a2.response.headers.get("www-authenticate")) &&
      /resource_metadata=/.test(a2.response.headers.get("www-authenticate")),
  );
  check(
    "靜態 token 仍然有效",
    core.authenticateMcpRequest(mcpReq(`Bearer ${STATIC}`), STATIC, SECRET).kind,
    "static",
  );
  check(
    "OAuth access token 有效",
    core.authenticateMcpRequest(mcpReq(`Bearer ${r1.access_token}`), STATIC, SECRET).kind,
    "oauth",
  );
  check(
    "只開 OAuth（沒有 MCP_TOKEN）也能用",
    core.authenticateMcpRequest(mcpReq(`Bearer ${r1.access_token}`), undefined, SECRET).kind,
    "oauth",
  );
  check(
    "沒開 OAuth 時 OAuth token 無效",
    core.authenticateMcpRequest(mcpReq(`Bearer ${r1.access_token}`), STATIC, undefined).kind,
    "deny",
  );
  check(
    "兩個都沒設 → 404",
    core.authenticateMcpRequest(mcpReq(`Bearer ${STATIC}`), undefined, undefined).response?.status,
    404,
  );
  check(
    "Origin 不在清單 → 403",
    core.authenticateMcpRequest(
      mcpReq(`Bearer ${r1.access_token}`, { origin: "https://evil.example" }),
      STATIC,
      SECRET,
    ).response?.status,
    403,
  );
  check(
    "refresh token 不能當 access token",
    core.authenticateMcpRequest(mcpReq(`Bearer ${r1.refresh_token}`), STATIC, SECRET).kind,
    "deny",
  );

  const savedTok = process.env.MCP_TOKEN;
  const savedSec = process.env.MCP_OAUTH_SECRET;
  process.env.MCP_TOKEN = STATIC;
  process.env.MCP_OAUTH_SECRET = SECRET;
  const toolsCount = async (res) => {
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    try {
      return JSON.parse(line ? line.slice(5) : text)?.result?.tools?.length ?? null;
    } catch {
      return null;
    }
  };
  const lookups = [];
  const fakeAdmin = async (id) => {
    lookups.push(id);
    return admins.has(id) ? { userId: id, email: "owner@example.com" } : null;
  };
  const viaStatic = await http.handleMcpRequest(
    mcpReq(`Bearer ${STATIC}`, { "mcp-protocol-version": "2025-11-25" }),
    { isActiveAdmin: fakeAdmin, oauthStore: oc.__TEST_ONLY__.defaultStore() },
  );
  check(
    "handleMcpRequest：靜態 token → tools/list 30 支",
    [viaStatic.status, await toolsCount(viaStatic)],
    [200, 30],
  );
  check("靜態 token 不查 profiles", lookups.length, 0);
  const viaOauth = await http.handleMcpRequest(
    mcpReq(`Bearer ${r1.access_token}`, { "mcp-protocol-version": "2025-11-25" }),
    { isActiveAdmin: fakeAdmin, oauthStore: oc.__TEST_ONLY__.defaultStore() },
  );
  check(
    "handleMcpRequest：OAuth token → tools/list 30 支",
    [viaOauth.status, await toolsCount(viaOauth)],
    [200, 30],
  );
  check("🔴 OAuth 每次呼叫都查一次 profiles（用 token 裡的 user id）", lookups, [ADMIN]);
  admins.delete(ADMIN);
  const revoked = await http.handleMcpRequest(mcpReq(`Bearer ${r1.access_token}`), {
    isActiveAdmin: fakeAdmin,
    oauthStore: oc.__TEST_ONLY__.defaultStore(),
  });
  check("🔴 被降成非 admin → 下一次呼叫就 401（token 還沒到期）", revoked.status, 401);
  checkTrue(
    "那個 401 帶 resource_metadata",
    /resource_metadata=/.test(revoked.headers.get("www-authenticate") ?? ""),
  );
  admins.add(ADMIN);
  const dbDown = await http.handleMcpRequest(mcpReq(`Bearer ${r1.access_token}`), {
    isActiveAdmin: async () => {
      throw new Error("db down");
    },
    oauthStore: oc.__TEST_ONLY__.defaultStore(),
  });
  check("🔴 查不到 profiles → 503（fail closed，不放行）", dbDown.status, 503);
  if (savedTok === undefined) delete process.env.MCP_TOKEN;
  else process.env.MCP_TOKEN = savedTok;
  if (savedSec === undefined) delete process.env.MCP_OAUTH_SECRET;
  else process.env.MCP_OAUTH_SECRET = savedSec;
}

// -----------------------------------------------------------------------------
console.log("\n[7] 同意頁 CSRF、HTTP 端點、限流");
{
  const { query } = authQuery();
  const t = oc.consentToken(ADMIN, query, SECRET);
  checkTrue("CSRF：同一人同一組參數 → 通過", oc.verifyConsentToken(t, ADMIN, query, SECRET));
  check("CSRF：換一個人 → 失敗", oc.verifyConsentToken(t, STAFF, query, SECRET), false);
  check(
    "CSRF：參數被換掉（redirect_uri）→ 失敗",
    oc.verifyConsentToken(
      t,
      ADMIN,
      authQuery({ redirect_uri: "https://claude.com/api/mcp/auth_callback" }).query,
      SECRET,
    ),
    false,
  );
  check(
    "CSRF：15 分鐘後 → 失敗",
    oc.verifyConsentToken(t, ADMIN, query, SECRET, oc.nowSeconds() + 901),
    false,
  );
  check("CSRF：空字串 → 失敗", oc.verifyConsentToken("", ADMIN, query, SECRET), false);

  const saved = process.env.MCP_OAUTH_SECRET;
  process.env.MCP_OAUTH_SECRET = SECRET;
  oc.__TEST_ONLY__.resetRateLimits();
  const post = (path, body, headers = {}) =>
    oauth.handleOAuthEndpoint(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "x-real-ip": "203.0.113.9", ...headers },
        body,
      }),
      path,
    );
  const reg = await post(
    "/oauth/register",
    JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_CB] }),
    { "content-type": "application/json" },
  );
  const regJson = await reg.json();
  check("POST /oauth/register → 201", reg.status, 201);
  checkTrue("register 回 client_id", typeof regJson.client_id === "string");
  check("register 不可快取", reg.headers.get("cache-control"), "no-store");
  const regBad = await post(
    "/oauth/register",
    JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }),
    { "content-type": "application/json" },
  );
  check(
    "register 壞 redirect → 400 invalid_redirect_uri",
    [regBad.status, (await regBad.json()).error],
    [400, "invalid_redirect_uri"],
  );
  const tokBad = await post("/oauth/token", "grant_type=authorization_code&code=x", {
    "content-type": "application/x-www-form-urlencoded",
  });
  check(
    "token 沒有 client → 401 invalid_client",
    [tokBad.status, (await tokBad.json()).error],
    [401, "invalid_client"],
  );
  const rev = await post(
    "/oauth/revoke",
    `token=whatever&client_id=${encodeURIComponent(regJson.client_id)}`,
    { "content-type": "application/x-www-form-urlencoded" },
  );
  check("revoke → 200（RFC 7009）", rev.status, 200);
  const getTok = await oauth.handleOAuthEndpoint(
    new Request(`${BASE}/oauth/token`),
    "/oauth/token",
  );
  check("GET /oauth/token → 405", getTok.status, 405);
  const opt = await oauth.handleOAuthEndpoint(
    new Request(`${BASE}/oauth/token`, { method: "OPTIONS" }),
    "/oauth/token",
  );
  check(
    "OPTIONS → 204 + CORS",
    [opt.status, opt.headers.get("access-control-allow-origin")],
    [204, "*"],
  );

  let last = 0;
  for (let i = 0; i < 25; i++) {
    const r = await post("/oauth/register", JSON.stringify({ redirect_uris: [CLAUDE_CB] }), {
      "content-type": "application/json",
      "x-real-ip": "198.51.100.7",
    });
    last = r.status;
  }
  check("🔴 register 限流（同 IP 第 25 次 → 429）", last, 429);
  const otherIp = await post("/oauth/register", JSON.stringify({ redirect_uris: [CLAUDE_CB] }), {
    "content-type": "application/json",
    "x-real-ip": "198.51.100.8",
  });
  check("別的 IP 不受影響", otherIp.status, 201);
  for (let i = 0; i < 70; i++) {
    last = (
      await post("/oauth/token", "grant_type=x", {
        "content-type": "application/x-www-form-urlencoded",
        "x-real-ip": "198.51.100.9",
      })
    ).status;
  }
  check("🔴 token 限流（同 IP 一分鐘第 70 次 → 429）", last, 429);

  delete process.env.MCP_OAUTH_SECRET;
  const offReg = await post("/oauth/register", "{}", { "content-type": "application/json" });
  check("沒設 MCP_OAUTH_SECRET → /oauth/register 404", offReg.status, 404);
  if (saved !== undefined) process.env.MCP_OAUTH_SECRET = saved;
}

// -----------------------------------------------------------------------------
console.log("\n[8] 掛載與原始碼守門");
{
  check(
    "oauth-paths 與 oauth-core 的路徑一致",
    [...paths.OAUTH_ENDPOINT_PATHS],
    [oc.OAUTH_REGISTER_PATH, oc.OAUTH_TOKEN_PATH, oc.OAUTH_REVOKE_PATH],
  );
  const serverSrc = readFile(join(SRC, "server.ts"));
  const startIdx = serverSrc.indexOf("await (startFetch");
  const epIdx = serverSrc.indexOf("OAUTH_ENDPOINT_PATHS.includes(pathname)");
  checkTrue(
    "server.ts 在 startFetch 之前攔 /oauth/register|token|revoke",
    epIdx > 0 && epIdx < startIdx,
  );
  checkTrue(
    "🔴 同意頁補 frame-ancestors 'none'（防 clickjacking）",
    serverSrc.includes(`"content-security-policy", "frame-ancestors 'none'"`),
  );
  checkTrue("同意頁補 X-Frame-Options DENY", serverSrc.includes(`"x-frame-options", "DENY"`));

  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const f of [
    "server/mcp/oauth.ts",
    "server/mcp/oauth-core.ts",
    "server/mcp/oauth-consent.ts",
    "server/mcp/http.ts",
    "server/mcp/core.ts",
  ]) {
    const code = strip(readFile(join(SRC, f)));
    // 每一個 console.* 裡的 ${…} 插值都不可以碰到敏感變數。允許的只有 err.code（錯誤代碼）
    // 與 params.get("grant_type")（授權類型名稱）。
    const logs = code.match(/console\.(log|info|warn|error)\([^;]*;/g) ?? [];
    const SENSITIVE =
      /\b(code|token|tokens|access_token|refresh_token|secret|verifier|csrf|query|rawQuery|params|authorization|header|got|request)\b/;
    const leaky = logs.flatMap((l) =>
      [...l.matchAll(/\$\{([^}]*)\}/g)]
        .map((m) => m[1].trim())
        .filter((e) => e !== "err.code" && e !== 'params.get("grant_type")')
        .filter((e) => SENSITIVE.test(e)),
    );
    check(`🔴 ${f}：log 不印 token／code／secret`, leaky, []);
  }

  const consentSrc = strip(readFile(join(SRC, "server/mcp/oauth-consent.ts")));
  check(
    "🔴 同意頁 prepare 與 decide 都檢查 role === admin",
    (consentSrc.match(/role !== "admin"/g) ?? []).length,
    2,
  );
  checkTrue("🔴 同意頁不用 requireAdmin（會把門市人員登出）", !/requireAdmin\(/.test(consentSrc));
  checkTrue("decide 驗 CSRF token", /verifyConsentToken\(/.test(consentSrc));

  check(
    "login redirect：授權頁 → 收",
    loginRedirect.safeLoginRedirect("/oauth/authorize?client_id=x"),
    "/oauth/authorize?client_id=x",
  );
  for (const bad of [
    "https://evil.example",
    "//evil.example",
    "/admin",
    "/oauth/authorizeX",
    "/oauth/authorize/../../x",
    "/oauth/authorize?\\x",
    5,
  ]) {
    check(
      `🔴 login redirect 拒絕 ${JSON.stringify(bad)}`,
      loginRedirect.safeLoginRedirect(bad),
      undefined,
    );
  }
  const route = readFile(join(SRC, "routes/oauth/authorize.tsx"));
  checkTrue("同意頁 noindex", route.includes("noindex"));
}

// -----------------------------------------------------------------------------
console.log("\n[9] 安全審查（2026-10-26）的修正");
{
  const savedEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "preview";
  check("🔴 Vercel Preview 部署：OAuth 一律關閉", oc.oauthEnabled(SECRET), false);
  process.env.VERCEL_ENV = "production";
  check("Vercel Production：開啟", oc.oauthEnabled(SECRET), true);
  if (savedEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = savedEnv;

  oc.__TEST_ONLY__.resetUsedCodes();
  const c1 = await codeFor(claudeClient, CLAUDE_CB);
  const p1 = {
    grant_type: "authorization_code",
    client_id: claudeClient.client_id,
    redirect_uri: CLAUDE_CB,
    code: c1.code,
    code_verifier: c1.verifier,
  };
  const boom = async () => {
    throw new Error("db down");
  };
  check(
    "查角色出錯 → 丟例外（不發 token）",
    await rejectsWith(() => oc.exchangeToken(tokenParams(p1), null, SECRET, BASE, boom)),
    "db down",
  );
  const retry = await oc.exchangeToken(tokenParams(p1), null, SECRET, BASE, isAdmin);
  checkTrue("查角色出錯時授權碼沒被燒掉，可以重試", retry.access_token.startsWith("ibat1."));

  // authorize 時省略 redirect_uri（只註冊一個）：token 端點可以不帶，帶了就必須相同。
  const v = verifier();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: claudeClient.client_id,
    code_challenge: challengeOf(v),
    code_challenge_method: "S256",
  }).toString();
  const req = oc.checkAuthorizeParams(q, SECRET, BASE).req;
  const code = oc.mintCode(req, ADMIN, SECRET);
  check(
    "authorize 省略 redirect_uri、token 帶別的 → invalid_grant",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({
          grant_type: "authorization_code",
          client_id: claudeClient.client_id,
          redirect_uri: "https://claude.com/api/mcp/auth_callback",
          code,
          code_verifier: v,
        }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );
  const noRu = await oc.exchangeToken(
    tokenParams({
      grant_type: "authorization_code",
      client_id: claudeClient.client_id,
      code,
      code_verifier: v,
    }),
    null,
    SECRET,
    BASE,
    isAdmin,
  );
  checkTrue(
    "authorize 省略 redirect_uri、token 也省略 → 可以",
    noRu.access_token.startsWith("ibat1."),
  );
  const c2 = await codeFor(claudeClient, CLAUDE_CB);
  check(
    "authorize 有帶 redirect_uri、token 省略 → invalid_grant",
    await rejectsWith(() =>
      oc.exchangeToken(
        tokenParams({
          grant_type: "authorization_code",
          client_id: claudeClient.client_id,
          code: c2.code,
          code_verifier: c2.verifier,
        }),
        null,
        SECRET,
        BASE,
        isAdmin,
      ),
    ),
    "invalid_grant",
  );

  const saved = process.env.MCP_OAUTH_SECRET;
  process.env.MCP_OAUTH_SECRET = SECRET;
  oc.__TEST_ONLY__.resetRateLimits();
  const dup = await oauth.handleOAuthEndpoint(
    new Request(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&code=a&code=b&client_id=${encodeURIComponent(claudeClient.client_id)}`,
    }),
    "/oauth/token",
  );
  check(
    "token 端點重複參數 → 400 invalid_request",
    [dup.status, (await dup.json()).error],
    [400, "invalid_request"],
  );
  if (saved === undefined) delete process.env.MCP_OAUTH_SECRET;
  else process.env.MCP_OAUTH_SECRET = saved;

  const route = readFile(join(SRC, "routes/oauth/authorize.tsx"));
  checkTrue(
    "🔴 同意頁：沒勾「是我自己發起的」，允許按不下去",
    route.includes("disabled={busy !== null || !confirmed}"),
  );
  const auditSrc = readFile(join(SRC, "server/mcp/audit.ts"));
  checkTrue("稽核 _actor 放最後（不會被同名欄位蓋掉）", auditSrc.includes("_actor: actor }"));
}

// -----------------------------------------------------------------------------
console.log("\n[9] 0043 狀態層：單次授權碼、refresh 重用偵測、撤銷、舊 token 相容");
{
  const store = oc.createMemoryOAuthStore();
  const ex = (p, now) => oc.exchangeToken(tokenParams(p), null, SECRET, BASE, isAdmin, now, store);
  const codeParams = (c) => ({
    grant_type: "authorization_code",
    client_id: claudeClient.client_id,
    redirect_uri: CLAUDE_CB,
    code: c.code,
    code_verifier: c.verifier,
  });
  const refreshParams = (rt, client = claudeClient) => ({
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: rt,
  });

  // ---- 授權碼
  const c1 = await codeFor(claudeClient, CLAUDE_CB);
  const t1 = await ex(codeParams(c1));
  const a1 = oc.verifyAccessToken(t1.access_token, SECRET, BASE);
  checkTrue("換碼 → access token 帶 gid（uuid）", oc.isGrantId(a1?.gid));
  check("換碼 → 建一條授權鏈", store.grants.size, 1);
  const g1 = store.grants.get(a1.gid);
  check(
    "授權鏈記下 user、client 名稱、redirect_uri、封頂＝at0+90 天",
    [
      g1.userId,
      g1.clientName,
      g1.redirectUri,
      g1.expiresAt - oc.unseal("code", c1.code, SECRET).at0,
    ],
    [ADMIN, claudeClient.client_name, CLAUDE_CB, oc.REFRESH_ABSOLUTE_MAX_SECONDS],
  );
  check(
    "同一個 instance 重放授權碼 → invalid_grant",
    await rejectsWith(() => ex(codeParams(c1))),
    "invalid_grant",
  );
  oc.__TEST_ONLY__.resetLocalUsedCodes();
  check(
    "🔴 換了 instance（記憶體清空）重放授權碼 → 仍然 invalid_grant（store 擋）",
    await rejectsWith(() => ex(codeParams(c1))),
    "invalid_grant",
  );
  check("重放不會多建授權鏈", store.grants.size, 1);

  // ---- store 出錯 → fail closed，碼沒被燒掉
  const c2 = await codeFor(claudeClient, CLAUDE_CB);
  const broken = {
    ...store,
    consumeOnce: async () => {
      throw new Error("db down");
    },
  };
  let threw = false;
  try {
    await oc.exchangeToken(
      tokenParams(codeParams(c2)),
      null,
      SECRET,
      BASE,
      isAdmin,
      undefined,
      broken,
    );
  } catch (e) {
    threw = !(e instanceof oc.OAuthError);
  }
  checkTrue("🔴 store 寫不進去 → 丟例外（500），不發 token", threw);
  const t2 = await ex(codeParams(c2));
  checkTrue("store 恢復後同一張碼可以重試成功", t2.access_token.startsWith("ibat1."));

  // ---- refresh 輪替 + 重用偵測
  const r1 = await ex(refreshParams(t1.refresh_token));
  const r1a = oc.verifyAccessToken(r1.access_token, SECRET, BASE);
  check("refresh → 同一條鏈（gid 不變）", r1a.gid, a1.gid);
  check(
    "拿錯 client 試 refresh → invalid_grant，但**不**撤銷正牌的鏈",
    [
      await rejectsWith(() => ex(refreshParams(r1.refresh_token, localClient))),
      store.grants.get(a1.gid).revokedAt,
    ],
    ["invalid_grant", null],
  );
  const r2 = await ex(refreshParams(r1.refresh_token));
  checkTrue("新的那張 refresh 可以繼續輪替", r2.refresh_token.startsWith("ibrt1."));
  check(
    "剛被換掉（寬限期內）的那張重送 → invalid_grant，但**不**撤銷（網路重送／併發 refresh）",
    [
      await rejectsWith(() => ex(refreshParams(r1.refresh_token))),
      store.grants.get(a1.gid).revokedAt,
    ],
    ["invalid_grant", null],
  );
  check(
    "🔴 同一張過了寬限期才又出現 → 視為重用",
    await rejectsWith(() =>
      ex(refreshParams(r1.refresh_token), oc.nowSeconds() + oc.REFRESH_REUSE_GRACE_SECONDS + 5),
    ),
    "invalid_grant",
  );
  checkTrue("🔴 過了寬限期的重用 → 整條鏈撤銷", store.grants.get(a1.gid).revokedAt !== null);
  store.grants.get(a1.gid).revokedAt = null; // 復原，繼續測「更舊的那張」
  check(
    "🔴 用已被換掉的舊 refresh → invalid_grant",
    await rejectsWith(() => ex(refreshParams(t1.refresh_token))),
    "invalid_grant",
  );
  checkTrue("🔴 重用 → 整條鏈撤銷", store.grants.get(a1.gid).revokedAt !== null);
  check(
    "🔴 撤銷之後，連最新那張 refresh 也不能用",
    await rejectsWith(() => ex(refreshParams(r2.refresh_token))),
    "invalid_grant",
  );
  check(
    "🔴 撤銷之後，access token 立刻不能用（accessTokenActive=false）",
    await oc.accessTokenActive(oc.verifyAccessToken(r2.access_token, SECRET, BASE), store),
    false,
  );
  check(
    "另一條鏈不受影響",
    await oc.accessTokenActive(oc.verifyAccessToken(t2.access_token, SECRET, BASE), store),
    true,
  );

  // ---- /oauth/revoke（revokeToken）
  check(
    "revoke 別的 client 的 token → ignored",
    await oc.revokeToken(t2.refresh_token, localClient.client_id, SECRET, store),
    "ignored",
  );
  check(
    "revoke 解不開的字串 → ignored",
    await oc.revokeToken("ibrt1.garbage", claudeClient.client_id, SECRET, store),
    "ignored",
  );
  check(
    "revoke 自己的 access token → 撤銷整條鏈",
    await oc.revokeToken(t2.access_token, claudeClient.client_id, SECRET, store),
    "revoked",
  );
  check(
    "被 revoke 的鏈：refresh → invalid_grant",
    await rejectsWith(() => ex(refreshParams(t2.refresh_token))),
    "invalid_grant",
  );

  // ---- epoch（全部撤銷）
  const c3 = await codeFor(claudeClient, CLAUDE_CB);
  const t3 = await ex(codeParams(c3));
  const a3 = oc.verifyAccessToken(t3.access_token, SECRET, BASE);
  check("新 token 帶 ep＝目前 epoch（0）", a3.ep, 0);
  store.epochs.set(ADMIN, { epoch: 1, since: 0 });
  check("🔴 epoch 加一 → access 失效", await oc.accessTokenActive(a3, store), false);
  check(
    "🔴 epoch 加一 → refresh 失效",
    await rejectsWith(() => ex(refreshParams(t3.refresh_token))),
    "invalid_grant",
  );
  const c4 = await codeFor(claudeClient, CLAUDE_CB);
  const t4 = await ex(codeParams(c4));
  check(
    "epoch 加一之後重新授權 → 新 token 帶 ep=1 且有效",
    [
      oc.verifyAccessToken(t4.access_token, SECRET, BASE).ep,
      await oc.accessTokenActive(oc.verifyAccessToken(t4.access_token, SECRET, BASE), store),
    ],
    [1, true],
  );
  // 審查 2026-10-28 #4：「全部撤銷」之前簽出、還沒兌換的授權碼也作廢。
  const c5 = await codeFor(claudeClient, CLAUDE_CB, ADMIN, oc.nowSeconds() - 10);
  store.epochs.set(ADMIN, { epoch: 2, since: oc.nowSeconds() - 5 });
  check(
    "🔴 全部撤銷之前簽出的授權碼 → invalid_grant",
    await rejectsWith(() => ex(codeParams(c5))),
    "invalid_grant",
  );
  store.epochs.delete(ADMIN);

  // ---- 升級前簽發的舊 token（沒有 gid、沒有 ep）：老闆現在連著的那一條
  const now = oc.nowSeconds();
  const cid = oc.clientHash(claudeClient.client_id);
  const legacyAccess = oc.seal(
    "access",
    { exp: now + 3000, iat: now - 600, sub: ADMIN, cid, sc: "mcp", aud: RESOURCE },
    SECRET,
  );
  const legacyRefresh = oc.seal(
    "refresh",
    {
      exp: now + 20 * 86400,
      iat: now - 600,
      sub: ADMIN,
      cid,
      sc: "mcp",
      aud: RESOURCE,
      at0: now - 2 * 86400,
      jti: "legacyJti123456",
    },
    SECRET,
  );
  const la = oc.verifyAccessToken(legacyAccess, SECRET, BASE);
  checkTrue("舊 access token（沒有 gid）仍通過密碼學驗證", la !== null && la.gid === undefined);
  check(
    "🔴 舊 access token 在到期前照常可用（向下相容）",
    await oc.accessTokenActive(la, store),
    true,
  );
  const before = store.grants.size;
  const mig = await ex(refreshParams(legacyRefresh));
  const ma = oc.verifyAccessToken(mig.access_token, SECRET, BASE);
  checkTrue(
    "🔴 舊 refresh token 第一次 refresh → 成功（連接器不會被踢掉）",
    mig.refresh_token.startsWith("ibrt1."),
  );
  check(
    "舊 refresh → 搬進一條新的授權鏈",
    [store.grants.size - before, oc.isGrantId(ma.gid)],
    [1, true],
  );
  const mg = store.grants.get(ma.gid);
  check(
    "搬進來的鏈：at0 沿用（90 天封頂不延長）、redirect_uri 取 client 註冊的",
    [mg.expiresAt, mg.redirectUri, oc.unseal("refresh", mig.refresh_token, SECRET).at0],
    [
      now - 2 * 86400 + oc.REFRESH_ABSOLUTE_MAX_SECONDS,
      claudeClient.redirect_uris[0],
      now - 2 * 86400,
    ],
  );
  check(
    "🔴 同一張舊 refresh 再用一次 → invalid_grant",
    await rejectsWith(() => ex(refreshParams(legacyRefresh))),
    "invalid_grant",
  );
  check("（寬限期內的重送不撤銷搬進來的新鏈）", store.grants.get(ma.gid).revokedAt, null);
  const mig2 = await ex(refreshParams(mig.refresh_token));
  checkTrue("搬進來之後照新規則繼續輪替", mig2.refresh_token !== mig.refresh_token);
  // 審查 2026-10-28 #1：同一條舊鏈裡**早就被輪替掉的另一張**（同 at0、不同 jti）不能再開第二條鏈。
  const olderSibling = oc.seal(
    "refresh",
    {
      exp: now + 10 * 86400,
      iat: now - 20 * 86400,
      sub: ADMIN,
      cid,
      sc: "mcp",
      aud: RESOURCE,
      at0: now - 2 * 86400,
      jti: "legacySibling0001",
    },
    SECRET,
  );
  const grantsBefore = store.grants.size;
  check(
    "🔴 同一條舊鏈的另一張舊 refresh（被輪替掉的那種）→ invalid_grant、不另開新鏈",
    [
      await rejectsWith(() => ex(refreshParams(olderSibling), now + 60)),
      store.grants.size - grantsBefore,
    ],
    ["invalid_grant", 0],
  );
  checkTrue(
    "🔴 過了寬限期 → 視為重用，撤銷搬進來的那條鏈",
    store.grants.get(ma.gid).revokedAt !== null,
  );
  check(
    "撤銷之後，搬進來那條鏈最新的 refresh 也不能用",
    await rejectsWith(() => ex(refreshParams(mig2.refresh_token))),
    "invalid_grant",
  );
  check(
    "legacyChainKey 長度在 used_codes 的 CHECK（8–80）之內",
    oc.legacyChainKey(ADMIN, cid, now).length <= 80,
    true,
  );
  const legacyRefresh2 = oc.seal(
    "refresh",
    {
      exp: now + 20 * 86400,
      iat: now - 600,
      sub: ADMIN,
      cid,
      sc: "mcp",
      aud: RESOURCE,
      at0: now - 86400,
      jti: "legacyJtiABCDEFG",
    },
    SECRET,
  );
  check(
    "revoke 舊 refresh → burned",
    await oc.revokeToken(legacyRefresh2, claudeClient.client_id, SECRET, store),
    "burned",
  );
  check(
    "被 burned 的舊 refresh → invalid_grant",
    await rejectsWith(() => ex(refreshParams(legacyRefresh2))),
    "invalid_grant",
  );
  store.epochs.set(ADMIN, { epoch: 1, since: 0 });
  check(
    "🔴「全部撤銷」（epoch+1）連舊 access token 也失效",
    await oc.accessTokenActive(la, store),
    false,
  );
  store.epochs.delete(ADMIN);

  // ---- 原始碼守門：正式路徑一律注入資料庫版 store
  const oauthSrc = readFile(join(SRC, "server/mcp/oauth.ts"));
  check(
    "🔴 /oauth/token 注入 dbOAuthStore（不是預設的記憶體版）",
    (oauthSrc.match(/dbOAuthStore,\n/g) ?? []).length,
    2,
  );
  const httpSrc = readFile(join(SRC, "server/mcp/http.ts"));
  checkTrue(
    "🔴 /api/mcp 驗 access token 走 accessTokenActive（查鏈與 epoch）",
    httpSrc.includes("accessTokenActive(auth.token, store)") &&
      httpSrc.includes("!admin || !active"),
  );
  const storeSrc = readFile(join(SRC, "server/mcp/oauth-store.ts"));
  checkTrue(
    "store：主鍵衝突（23505）＝看過，其他錯誤丟例外",
    storeSrc.includes('error.code === "23505"') && storeSrc.includes('fail("consumeOnce"'),
  );
  checkTrue(
    "store：輪替是以 current_refresh_jti 為條件的 compare-and-swap",
    storeSrc.includes('.eq("current_refresh_jti", oldJti)'),
  );
  checkTrue("🔴 store 不印 jti／token", !/console\./.test(storeSrc));
}

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
