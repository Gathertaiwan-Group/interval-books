import { Link } from "@tanstack/react-router";
import { Ban, ChevronRight } from "lucide-react";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import type { PendingVoidRequest } from "@/lib/mcp-void-requests";

/**
 * 後台首頁：「MCP 申請作廢待處理」。MCP 的 request_invoice_void 只記申請、不作廢；
 * 人點進訂單內頁按既有的「作廢發票」，或按「不處理，關閉申請」。待處理的定義在
 * src/lib/mcp-void-requests.ts。null＝讀取失敗；空陣列＝不顯示。
 */
export function McpVoidRequestBanner({ requests }: { requests: PendingVoidRequest[] | null }) {
  if (requests !== null && requests.length === 0) return null;
  if (requests === null) {
    return (
      <p
        role="status"
        className="rounded-md border border-amber-500/50 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
      >
        MCP 作廢申請讀取失敗，請重新整理；仍失敗請聯絡技術人員。
      </p>
    );
  }
  return (
    <section
      role="alert"
      className="space-y-2 rounded-md border border-destructive/60 bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <p className="flex items-center gap-2 font-medium">
        <Ban className="h-4 w-4 shrink-0" aria-hidden="true" />
        MCP 申請作廢待處理：{requests.length} 張發票
      </p>
      <p className="text-xs opacity-90">
        AI
        連接器只能「申請」，不會自己作廢。請點進訂單確認後按「作廢發票」，或按「不處理，關閉申請」。
      </p>
      <ul className="space-y-1">
        {requests.map((r) => (
          <li key={r.request_id}>
            <Link
              to="/admin/orders/$id"
              params={{ id: r.order_id }}
              className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-destructive/15"
            >
              <span className="min-w-0 flex-1">
                <span className="font-mono">{r.order_no ?? r.order_id}</span>
                {" ・ "}
                <span className="font-mono">{r.invoice_number}</span>
                {" ・ "}
                {r.reason}
                <span className="block text-xs opacity-80">
                  {formatTaipeiDateTime(r.requested_at)}
                  {r.requested_by ? ` ・ ${r.requested_by}` : ""}
                  {r.client_name ? `（${r.client_name}）` : ""}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
