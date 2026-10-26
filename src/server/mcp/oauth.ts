/**
 * MCP OAuth 的 HTTP 端點（src/server.ts 攔下來交給這裡）：
 *
 *   GET  /.well-known/oauth-protected-resource[/api/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server[/api/mcp] RFC 8414
 *   POST /oauth/register                                   RFC 7591（公開、限流）
 *   POST /oauth/token                                      authorization_code／refresh_token
 *   POST /oauth/revoke                                     RFC 7009（無狀態，見 oauth-core.ts 檔頭）
 *
 * /oauth/authorize 不在這裡：它要讀後台的 session cookie、要畫同意頁，所以是一般的
 * TanStack 頁面（src/routes/oauth/authorize.tsx）＋ server fn（src/lib/oauth-fns.ts）。
 *
 * 沒設 MCP_OAUTH_SECRET（或短於 32 字）→ 這些路徑一律 404，與加這個功能之前一模一樣。
 *
 * 🔴 不記 log 任何 token／code／secret／client_secret。錯誤只記 error code。
 */
import "@tanstack/react-start/server-only";
import {
  AS_METADATA_PATH,
  authorizationServerMetadata,
  clientIp,
  exchangeToken,
  OAUTH_REGISTER_PATH,
  OAUTH_REVOKE_PATH,
  OAUTH_TOKEN_PATH,
  OAuthError,
  oauthBaseUrl,
  oauthEnabled,
  authenticateClient,
  PRM_PATH,
  protectedResourceMetadata,
  rateLimit,
  registerClient,
} from "./oauth-core";
import { MCP_PATH } from "./core";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "600",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function oauthError(err: OAuthError): Response {
  const extra: Record<string, string> = {};
  if (err.status === 401) extra["www-authenticate"] = 'Basic realm="intervalbooks-oauth"';
  return json(err.status, { error: err.code, error_description: err.message }, extra);
}

export function isPrmPath(pathname: string): boolean {
  return (
    pathname === PRM_PATH ||
    pathname === `${PRM_PATH}${MCP_PATH}` ||
    pathname === `${MCP_PATH}${PRM_PATH}`
  );
}

export function isAsMetadataPath(pathname: string): boolean {
  return pathname === AS_METADATA_PATH || pathname === `${AS_METADATA_PATH}${MCP_PATH}`;
}

/** /.well-known/oauth-*（以及 openid-configuration，一律 404）。 */
export function handleOAuthDiscovery(request: Request, pathname: string): Response {
  const secret = process.env.MCP_OAUTH_SECRET;
  if (!oauthEnabled(secret)) return notFound();
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "GET" && request.method !== "HEAD")
    return json(405, { error: "method_not_allowed" });
  const base = oauthBaseUrl(request.url);
  if (isPrmPath(pathname)) return json(200, protectedResourceMetadata(base));
  if (isAsMetadataPath(pathname)) return json(200, authorizationServerMetadata(base));
  return notFound();
}

/** RFC 6749 §3.2：參數不得重複。重複就整個拒絕，不猜要用哪一個。 */
function rejectDuplicates(p: URLSearchParams): URLSearchParams {
  for (const k of new Set(p.keys())) {
    if (p.getAll(k).length > 1)
      throw new OAuthError("invalid_request", `duplicate parameter: ${k}`);
  }
  return p;
}

async function readParams(request: Request): Promise<URLSearchParams> {
  return rejectDuplicates(await readParamsRaw(request));
}

async function readParamsRaw(request: Request): Promise<URLSearchParams> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await request.text();
  if (text.length > 16_384) throw new OAuthError("invalid_request", "request body too large");
  if (type.includes("application/json")) {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_request", "malformed JSON");
    }
    const p = new URLSearchParams();
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === "string") p.set(k, v);
      }
    }
    return p;
  }
  return new URLSearchParams(text);
}

/** /oauth/register、/oauth/token、/oauth/revoke。 */
export async function handleOAuthEndpoint(request: Request, pathname: string): Promise<Response> {
  const secret = process.env.MCP_OAUTH_SECRET;
  if (!oauthEnabled(secret)) return notFound();
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST")
    return json(405, { error: "invalid_request", error_description: "POST only" });

  const ip = clientIp(request.headers);
  const base = oauthBaseUrl(request.url);

  try {
    if (pathname === OAUTH_REGISTER_PATH) {
      // 公開端點：每個 IP 10 分鐘 20 次。正常使用一個人一輩子註冊沒幾次。
      if (!rateLimit(`register:${ip}`, 20, 600)) {
        return json(
          429,
          { error: "rate_limited", error_description: "too many registrations" },
          { "retry-after": "600" },
        );
      }
      const text = await request.text();
      if (text.length > 8192) throw new OAuthError("invalid_client_metadata", "body too large");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new OAuthError("invalid_client_metadata", "body must be JSON");
      }
      const client = registerClient(body, secret);
      console.info(
        `[mcp-oauth] register ok name=${JSON.stringify(client.client_name)} method=${client.token_endpoint_auth_method} redirects=${JSON.stringify(client.redirect_uris)}`,
      );
      return json(201, {
        ...client,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "mcp",
      });
    }

    if (pathname === OAUTH_TOKEN_PATH) {
      if (!rateLimit(`token:${ip}`, 60, 60)) {
        return json(
          429,
          { error: "rate_limited", error_description: "too many requests" },
          { "retry-after": "60" },
        );
      }
      const params = await readParams(request);
      const { isActiveAdmin } = await import("@/server/auth");
      const tokens = await exchangeToken(
        params,
        request.headers.get("authorization"),
        secret,
        base,
        async (userId) => (await isActiveAdmin(userId)) !== null,
      );
      console.info(`[mcp-oauth] token ok grant=${params.get("grant_type")}`);
      return json(200, tokens);
    }

    if (pathname === OAUTH_REVOKE_PATH) {
      if (!rateLimit(`revoke:${ip}`, 60, 60)) return json(429, { error: "rate_limited" });
      const params = await readParams(request);
      authenticateClient(params, request.headers.get("authorization"), secret);
      // RFC 7009 §2.2：不論 token 存不存在都回 200。無狀態設計下這裡撤不掉任何東西 ——
      // 撤銷個人＝改 profiles.role；全部撤銷＝換 MCP_OAUTH_SECRET（見 oauth-core.ts 檔頭）。
      return json(200, {});
    }
  } catch (err) {
    if (err instanceof OAuthError) {
      console.warn(`[mcp-oauth] ${pathname} rejected: ${err.code}`);
      return oauthError(err);
    }
    console.error(`[mcp-oauth] ${pathname} failed: ${err instanceof Error ? err.name : "error"}`);
    return json(500, { error: "server_error" });
  }
  return notFound();
}
