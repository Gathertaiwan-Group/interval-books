/**
 * 「MCP 申請作廢發票」的待辦判斷（純函式，有自檢：scripts/mcp-outbound-selftest.mjs）。
 *
 * ── 為什麼沒有新表 ────────────────────────────────────────────────────────
 * MCP 的 request_invoice_void **不作廢**，只在 mcp_audit_log 記一筆
 * action='invoice_void_request'（entity='order'、entity_id=訂單 id、dry_run=false、
 * changes.invoice_number／reason）。人仍然在後台訂單內頁按既有的「作廢發票」。不新增 migration。
 *
 * ── 什麼叫「待處理」（唯一的定義，就在這裡）──────────────────────────────
 * 對每一張訂單，取**最新一筆**申請（id 最大；mcp_audit_log.id 是 identity，單調遞增）。它待處理
 * 若且唯若：
 *   1. 沒有任何一筆 action='invoice_void_request_dismissed' 的列，id 比這筆申請大
 *      （後台按「不處理，關閉申請」寫的）；而且
 *   2. 那張訂單的發票**現在仍然**是 status='issued'，且號碼等於申請時的號碼。
 * 第 2 條自動涵蓋「已經在後台作廢」（status 變 voided）與「發票換了／不存在」（申請已過時）——
 * 處理完成不需要另外寫任何一列。
 */

export const VOID_REQUEST_ACTION = "invoice_void_request";
export const VOID_REQUEST_DISMISSED_ACTION = "invoice_void_request_dismissed";

export type VoidRequestLogRow = {
  id: number;
  created_at: string;
  entity_id: string;
  action: string;
  changes: unknown;
  actor_email: string | null;
  client_name: string | null;
};

export type VoidRequestInvoiceSnapshot = {
  order_id: string;
  order_no: string | null;
  status: string | null;
  invoice_number: string | null;
};

export type PendingVoidRequest = {
  request_id: number;
  order_id: string;
  order_no: string | null;
  invoice_number: string;
  reason: string;
  requested_at: string;
  /** 授權這條 MCP 連線的 admin email；靜態 token 是 null。 */
  requested_by: string | null;
  client_name: string | null;
};

function field(changes: unknown, key: string): string {
  if (!changes || typeof changes !== "object") return "";
  const v = (changes as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

export function pendingVoidRequests(
  rows: readonly VoidRequestLogRow[],
  invoices: readonly VoidRequestInvoiceSnapshot[],
): PendingVoidRequest[] {
  const latestRequest = new Map<string, VoidRequestLogRow>();
  const latestDismiss = new Map<string, number>();
  for (const r of rows) {
    if (r.action === VOID_REQUEST_ACTION) {
      const cur = latestRequest.get(r.entity_id);
      if (!cur || r.id > cur.id) latestRequest.set(r.entity_id, r);
    } else if (r.action === VOID_REQUEST_DISMISSED_ACTION) {
      latestDismiss.set(r.entity_id, Math.max(latestDismiss.get(r.entity_id) ?? 0, r.id));
    }
  }
  const byOrder = new Map(invoices.map((i) => [i.order_id, i]));
  const out: PendingVoidRequest[] = [];
  for (const [orderId, req] of latestRequest) {
    if ((latestDismiss.get(orderId) ?? 0) > req.id) continue;
    const inv = byOrder.get(orderId);
    const number = field(req.changes, "invoice_number");
    if (!inv || inv.status !== "issued" || !number || inv.invoice_number !== number) continue;
    out.push({
      request_id: req.id,
      order_id: orderId,
      order_no: inv.order_no,
      invoice_number: number,
      reason: field(req.changes, "reason"),
      requested_at: req.created_at,
      requested_by: req.actor_email,
      client_name: req.client_name,
    });
  }
  return out.sort((a, b) => b.request_id - a.request_id);
}
