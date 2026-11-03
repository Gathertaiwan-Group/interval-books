/**
 * 「MCP 申請作廢發票」待辦的讀寫（mcp_audit_log，不新增表）。判斷規則在
 * src/lib/mcp-void-requests.ts 的 pendingVoidRequests()，這裡只負責撈資料與寫「關閉申請」。
 *
 * 呼叫端：MCP 的 request_invoice_void（src/server/mcp/outbound-tools.ts，查重複申請）、
 * 後台首頁與訂單內頁（src/lib/admin/fns/invoices.ts，adminFnMiddleware）。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import {
  pendingVoidRequests,
  VOID_REQUEST_ACTION,
  VOID_REQUEST_DISMISSED_ACTION,
  type PendingVoidRequest,
  type VoidRequestLogRow,
} from "@/lib/mcp-void-requests";

const LOG_LIMIT = 500;

/** 讀失敗丟例外（呼叫端決定要顯示「讀取失敗」還是回錯誤），絕不把「讀不到」當成「沒有待辦」。 */
export async function loadPendingVoidRequests(
  opts: { orderId?: string } = {},
): Promise<PendingVoidRequest[]> {
  const db = supabaseAdmin();
  let q = db
    .from("mcp_audit_log")
    .select("id, created_at, entity_id, action, changes, actor_email, client_name")
    .eq("entity", "order")
    .eq("dry_run", false)
    .in("action", [VOID_REQUEST_ACTION, VOID_REQUEST_DISMISSED_ACTION]);
  if (opts.orderId) q = q.eq("entity_id", opts.orderId);
  const { data, error } = await q.order("id", { ascending: false }).limit(LOG_LIMIT);
  if (error) throw new Error(`[repo/mcp-void-requests] 讀申請失敗：${error.code ?? "error"}`);
  const rows = (data ?? []) as VoidRequestLogRow[];
  const orderIds = [
    ...new Set(rows.filter((r) => r.action === VOID_REQUEST_ACTION).map((r) => r.entity_id)),
  ].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (orderIds.length === 0) return [];

  const { data: orders, error: e2 } = await db
    .from("orders")
    .select("id, order_no, invoices(status, invoice_number)")
    .in("id", orderIds);
  if (e2) throw new Error(`[repo/mcp-void-requests] 讀發票失敗：${e2.code ?? "error"}`);
  const snapshots = ((orders ?? []) as Record<string, unknown>[]).map((o) => {
    const raw = o.invoices as
      | { status: string; invoice_number: string | null }
      | { status: string; invoice_number: string | null }[]
      | null;
    const inv = Array.isArray(raw) ? raw[0] : raw;
    return {
      order_id: String(o.id),
      order_no: o.order_no == null ? null : String(o.order_no),
      status: inv?.status ?? null,
      invoice_number: inv?.invoice_number ?? null,
    };
  });
  return pendingVoidRequests(rows, snapshots);
}

/**
 * 後台「不處理，關閉申請」：寫一筆 action='invoice_void_request_dismissed'。
 *
 * mcp_audit_log 的 actor_role 被 CHECK 釘死成 'mcp'（0039），所以這一列的 actor_role 也是 'mcp'；
 * 「是後台人員關的」由 tool='admin_dismiss_void_request'、actor_via=null、client_name='admin'
 * 與 actor_user_id／actor_email（按下去的那位 admin）表達。append-only，沒有刪改。
 */
export async function dismissVoidRequest(input: {
  orderId: string;
  adminUserId: string;
  adminEmail: string;
}): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("mcp_audit_log")
    .insert({
      actor_role: "mcp",
      tool: "admin_dismiss_void_request",
      entity: "order",
      entity_id: input.orderId,
      action: VOID_REQUEST_DISMISSED_ACTION,
      changes: { dismissed_by: input.adminEmail },
      dry_run: false,
      actor_via: null,
      actor_user_id: input.adminUserId,
      actor_email: input.adminEmail,
      client_name: "admin",
    });
  if (error) throw new Error(`[repo/mcp-void-requests] 關閉申請失敗：${error.code ?? "error"}`);
}
