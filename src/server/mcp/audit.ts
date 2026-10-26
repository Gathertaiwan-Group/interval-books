/**
 * MCP 寫入的稽核紀錄。
 *
 * ── 為什麼是一張新表，不是「既有的稽核機制」──────────────────────────────
 * 這個站的後台**從來沒有** CMS 寫入的稽核表（快樂手有 happyhands.audit_log，小時光
 * 沒有；public.pii_access_log 是讀個資的紀錄，語意不同，而且有 trigger 擋刪除，不該
 * 混用）。所以 MCP 的寫入記在 public.mcp_audit_log（supabase/migrations 裡那支
 * mcp_audit_log migration）。
 *
 * ── 永不 throw ────────────────────────────────────────────────────────────
 * 寫入已經成功之後才記稽核。稽核失敗不可以讓工具回「失敗」—— 那會讓模型以為沒寫進去
 * 而再寫一次。但也**不可以靜默消失**（快樂手踩過：FK 擋下、writeAudit 吞掉、操作成功
 * 而紀錄不見）。所以：
 *   · 每一筆一律先印一行 `[mcp-audit]` 到 server log（Vercel Runtime Logs 查得到）；
 *   · 再寫進資料表；寫不進去（例如 migration 還沒套上）就回 "log_only"，
 *     工具結果會把這個狀態原樣告訴呼叫端。
 *
 * ── actor ──────────────────────────────────────────────────────────────────
 * 這張表**沒有**指向 auth.users 的欄位。機器身分不是一個使用者，塞一個假 UUID 進有 FK
 * 的欄位只會被外鍵擋下（快樂手的教訓）。actor_role 固定 'mcp'，由 CHECK 釘死。
 *
 * 2026-10-26 起多了 OAuth（claude.ai 連接器）：那時是某一位 admin 授權的。沒有 DDL 權限
 * 加欄位，所以「是誰」寫進 changes 的保留鍵 `_actor`（{via, user_id, email, client}；
 * 靜態 token 是 {via:"static_token"}）。changes 只 insert、從不被程式讀回，多一個鍵不影響
 * 任何地方。之後有正式的欄位再搬。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import { currentMcpActor } from "./actor";

export const MCP_AUDIT_TABLE = "mcp_audit_log";

export type McpAuditEntry = {
  tool: string;
  entity: string;
  entity_id: string;
  action: "create" | "update" | "delete" | "upload";
  changes: unknown;
};

export type McpAuditStatus = "recorded" | "log_only";

export async function writeMcpAudit(entry: McpAuditEntry): Promise<McpAuditStatus> {
  const actor = currentMcpActor();
  const changes =
    actor && entry.changes && typeof entry.changes === "object" && !Array.isArray(entry.changes)
      ? { ...(entry.changes as Record<string, unknown>), _actor: actor }
      : actor
        ? { value: entry.changes, _actor: actor }
        : entry.changes;
  const record = { actor_role: "mcp" as const, ...entry, changes };
  try {
    console.info(`[mcp-audit] ${JSON.stringify({ at: new Date().toISOString(), ...record })}`);
  } catch {
    /* changes 序列化不了也不能讓寫入路徑失敗 */
  }

  try {
    const { error } = await supabaseAdmin().from(MCP_AUDIT_TABLE).insert(record);
    if (error) {
      console.error(`[mcp-audit] 寫入稽核表失敗（${error.code ?? "?"}）：${error.message}`);
      return "log_only";
    }
    return "recorded";
  } catch (err) {
    console.error(
      `[mcp-audit] 寫入稽核表失敗：${err instanceof Error ? err.message : String(err)}`,
    );
    return "log_only";
  }
}
