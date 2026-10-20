/**
 * src/server.ts 呼叫的入口：先過閘門（core.ts#gateMcpRequest），通過才載入 MCP handler。
 *
 * 沒設 MCP_TOKEN（或短於 32 字）→ 404，整支關閉。這是部署後、老闆還沒設 token 時的
 * 預期狀態。
 */
import "@tanstack/react-start/server-only";
import { gateMcpRequest, notFoundResponse } from "./core";

export async function handleMcpRequest(request: Request): Promise<Response> {
  const gate = gateMcpRequest(request, process.env.MCP_TOKEN);
  if (gate) return gate;
  const { mcpHandler } = await import("./handler");
  const response = await mcpHandler()(request);
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

/** /.well-known/oauth-*：這個 server 沒有 authorization server，一律 404。 */
export function handleOAuthDiscovery(): Response {
  return notFoundResponse();
}
