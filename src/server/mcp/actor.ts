/**
 * 這一次 MCP 請求是「誰」在呼叫 —— 給稽核（audit.ts）用。
 *
 * 靜態 MCP_TOKEN：沒有人，只知道是那把 token（via=static_token）。
 * OAuth：token 綁的那位 admin（via=oauth、user_id、email），http.ts 每次都重查 profiles 後
 * 才放進來。用 AsyncLocalStorage，因為工具 handler 是 mcp-handler 呼叫的，參數裡帶不到
 * 請求層的資訊。
 */
import "@tanstack/react-start/server-only";
import { AsyncLocalStorage } from "node:async_hooks";

export type McpActor =
  | { via: "static_token" }
  | { via: "oauth"; user_id: string; email: string; client: string };

const store = new AsyncLocalStorage<McpActor>();

export function runAsMcpActor<T>(actor: McpActor, fn: () => Promise<T>): Promise<T> {
  return store.run(actor, fn);
}

export function currentMcpActor(): McpActor | null {
  return store.getStore() ?? null;
}
