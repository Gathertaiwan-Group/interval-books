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

/**
 * access：這一次請求能不能用寫入工具（0054 讀寫分級）。static_token＝write；
 * readonly_token（MCP_READONLY_TOKEN）＝read；OAuth＝那條授權鏈的 access_level。
 * 擋在 tools.ts 的 add()：readOnlyHint 不是 true 的工具，read 一律拒絕（含 dry_run 預覽）。
 */
export type McpAccess = "read" | "write";

export type McpActor =
  | { via: "static_token"; access: "write" }
  | { via: "readonly_token"; access: "read" }
  | {
      via: "oauth";
      user_id: string;
      email: string;
      /** client_id 的雜湊（token 裡的 cid）。 */
      client: string;
      /** 授權時 client 自報的名稱（mcp_oauth_grants.client_name，例如 Claude／ChatGPT）。 */
      client_name: string | null;
      access: McpAccess;
    };

const store = new AsyncLocalStorage<McpActor>();

export function runAsMcpActor<T>(actor: McpActor, fn: () => Promise<T>): Promise<T> {
  return store.run(actor, fn);
}

export function currentMcpActor(): McpActor | null {
  return store.getStore() ?? null;
}
