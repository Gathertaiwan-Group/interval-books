/**
 * 「N 張已付款訂單的發票尚未開立」橫幅——後台首頁與訂單列表頂端（業主 2026-10-28）。
 *
 * 2026-09 有 5 張已付款訂單的發票停止自動重試，兩個月沒有人發現：資料一直都在
 * invoices 裡，只是後台沒有任何地方會把它攤在眼前。這一條就是那個「眼前」。
 *
 * count 的定義只有一份（src/lib/invoice-alerts.ts 的 needsInvoiceAttention），點下去的
 * /admin/orders?scope=invoice_problem 用的是同一份，所以數字對得起來。
 *
 * count === 0 不顯示；null（讀取失敗）顯示「讀取失敗」——查不到不等於沒事。
 */
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight } from "lucide-react";

export function InvoiceProblemBanner({ count }: { count: number | null }) {
  if (count === 0) return null;
  if (count === null) {
    return (
      <p
        role="status"
        className="rounded-md border border-amber-500/50 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
      >
        發票開立狀態讀取失敗，請重新整理；仍失敗請聯絡技術人員。
      </p>
    );
  }
  return (
    <Link
      to="/admin/orders"
      search={{ scope: "invoice_problem" }}
      role="alert"
      className="flex items-center gap-3 rounded-md border border-destructive/60 bg-destructive/10 px-4 py-3 text-sm text-destructive transition-colors hover:bg-destructive/15"
    >
      <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{count} 張已付款訂單的發票尚未開立</span>
        <span className="block text-xs opacity-90">
          自動重試已停止或付款超過 24 小時。點這裡查看，到訂單內頁按「重新開立發票」。
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
    </Link>
  );
}
