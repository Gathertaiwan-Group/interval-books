/**
 * src/server.ts 呼叫的入口：先過閘門（core.ts#authenticateMcpRequest），通過才載入 MCP handler。
 *
 * 兩種身分：
 *   · 靜態 MCP_TOKEN（Claude Code 的 header 設定）—— 與之前一模一樣。
 *   · OAuth access token（claude.ai／桌面版／手機的自訂連接器，見 oauth-core.ts）——
 *     解密驗證通過後**每一次請求都再查一次 profiles**：那個人被降成門市人員或移除，
 *     下一個請求就 401（token 還沒到期也一樣）。
 *
 * MCP_TOKEN 與 MCP_OAUTH_SECRET 都沒設（或短於 32 字）→ 404，整支關閉。
 */
import "@tanstack/react-start/server-only";
import { authenticateMcpRequest, unauthorizedOAuthResponse } from "./core";
import type { McpActor } from "./actor";

type AdminLookup = (userId: string) => Promise<{ userId: string; email: string } | null>;

/**
 * @param deps 只給自檢注入「查 profiles」的替身（scripts/mcp-oauth-selftest.mjs）。正式路徑
 *             （src/server.ts）不帶，一律走 @/server/auth 的 isActiveAdmin。
 */
export async function handleMcpRequest(
  request: Request,
  deps: { isActiveAdmin?: AdminLookup } = {},
): Promise<Response> {
  const auth = authenticateMcpRequest(request, process.env.MCP_TOKEN, process.env.MCP_OAUTH_SECRET);
  if (auth.kind === "deny") return auth.response;

  let actor: McpActor = { via: "static_token" };
  if (auth.kind === "oauth") {
    const isActiveAdmin = deps.isActiveAdmin ?? (await import("@/server/auth")).isActiveAdmin;
    let admin: Awaited<ReturnType<AdminLookup>>;
    try {
      admin = await isActiveAdmin(auth.token.sub);
    } catch {
      // 查不到 profiles 不等於「不是 admin」，但也絕不放行；回 503 讓客戶端稍後重試，
      // 不要讓它以為 token 壞了而把老闆踢去重新授權。
      return new Response("temporarily_unavailable", {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": "5",
        },
      });
    }
    if (!admin) return unauthorizedOAuthResponse(request);
    actor = { via: "oauth", user_id: admin.userId, email: admin.email, client: auth.token.cid };
  }

  const { mcpHandler } = await import("./handler");
  const { runAsMcpActor } = await import("./actor");
  const response = await runAsMcpActor(actor, () => mcpHandler()(request));
  // 回應是工具結果，不可以被任何一層快取。
  if (!response.headers.has("cache-control")) {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
}
