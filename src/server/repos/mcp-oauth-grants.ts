/**
 * 後台「Claude 連線授權」（/admin/mcp-connections）讀寫 public.mcp_oauth_grants／
 * mcp_oauth_user_epochs（0043）。呼叫端一律是 adminFnMiddleware 後面的 server fn。
 *
 * 撤銷之後呼叫 forgetOAuthCaches()：同一個 instance 內立刻生效；其他 instance 的
 * access token 快取最多晚 60 秒（src/server/mcp/oauth-store.ts）。refresh 一律即時查庫。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import { forgetOAuthCaches } from "@/server/mcp/oauth-store";

export type McpGrantRow = {
  id: string;
  user_id: string;
  email: string | null;
  client_name: string;
  redirect_uri: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
};

const LIMIT = 200;

export async function listMcpGrants(): Promise<McpGrantRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("mcp_oauth_grants")
    .select(
      "id, user_id, client_name, redirect_uri, created_at, last_used_at, expires_at, revoked_at, revoked_reason",
    )
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (error) throw new Error(`[repo/mcp-oauth] list 失敗：${error.message}`);
  const rows = (data ?? []) as Omit<McpGrantRow, "email">[];
  const ids = [...new Set(rows.map((r) => r.user_id))];
  const emails = new Map<string, string>();
  if (ids.length > 0) {
    const { data: ps, error: pe } = await supabaseAdmin()
      .from("profiles")
      .select("id, email")
      .in("id", ids);
    if (pe) throw new Error(`[repo/mcp-oauth] 讀 profiles 失敗：${pe.message}`);
    for (const p of ps ?? []) emails.set(p.id as string, (p.email as string) ?? "");
  }
  return rows.map((r) => ({ ...r, email: emails.get(r.user_id) ?? null }));
}

export async function revokeMcpGrant(id: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("mcp_oauth_grants")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: "admin" })
    .eq("id", id)
    .is("revoked_at", null);
  if (error) throw new Error(`[repo/mcp-oauth] 撤銷失敗：${error.message}`);
  forgetOAuthCaches({ grantId: id });
}

/**
 * 全部撤銷：所有還有效的授權鏈 revoked_at=now()，**而且**每一位後台人員的 epoch 加一——
 * 後者才撤得掉升級前簽發、沒有授權鏈的舊 token。回傳撤了幾條鏈。
 */
export async function revokeAllMcpGrants(): Promise<{ grants: number; users: number }> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin()
    .from("mcp_oauth_grants")
    .update({ revoked_at: now, revoked_reason: "revoke_all" })
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error(`[repo/mcp-oauth] 全部撤銷失敗：${error.message}`);

  // 對象＝所有後台身分（admin／staff／pending）＋曾經有過授權鏈的人：被降級的人日後若被升回
  // admin，手上的舊 token 也不能復活（審查 2026-10-28 #3）。
  const { data: staff, error: ae } = await supabaseAdmin()
    .from("profiles")
    .select("id")
    .in("role", ["admin", "staff", "pending"]);
  if (ae) throw new Error(`[repo/mcp-oauth] 讀後台人員失敗：${ae.message}`);
  const { data: holders, error: he } = await supabaseAdmin()
    .from("mcp_oauth_grants")
    .select("user_id")
    .limit(1000);
  if (he) throw new Error(`[repo/mcp-oauth] 讀授權鏈使用者失敗：${he.message}`);
  const ids = [
    ...new Set([
      ...(staff ?? []).map((a) => a.id as string),
      ...(holders ?? []).map((h) => h.user_id as string),
    ]),
  ];
  if (ids.length > 0) {
    const { data: cur, error: ce } = await supabaseAdmin()
      .from("mcp_oauth_user_epochs")
      .select("user_id, epoch")
      .in("user_id", ids);
    if (ce) throw new Error(`[repo/mcp-oauth] 讀 epoch 失敗：${ce.message}`);
    const have = new Map((cur ?? []).map((r) => [r.user_id as string, r.epoch as number]));
    const { error: ue } = await supabaseAdmin()
      .from("mcp_oauth_user_epochs")
      .upsert(
        ids.map((id) => ({ user_id: id, epoch: (have.get(id) ?? 0) + 1, updated_at: now })),
        { onConflict: "user_id" },
      );
    if (ue) throw new Error(`[repo/mcp-oauth] 更新 epoch 失敗：${ue.message}`);
  }
  forgetOAuthCaches();
  return { grants: (data ?? []).length, users: ids.length };
}
