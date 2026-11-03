/**
 * 盤點頁的兩張表：要盤的商品清單，與最近的盤點紀錄。
 *
 * ── 低庫存是 per-row 的 ───────────────────────────────────────────────────
 * 門檻是每件商品自己的 low_stock_alert（預設 5），不是全站一個數字。repo 那一層
 * 的「只看低庫存」只能做 `stock_quantity <= 5` 的粗篩（PostgREST 沒辦法比較兩個
 * 欄位），所以**精確的判斷在這裡**，標色也在這裡。
 *
 * 最近盤點紀錄放在同一個檔案，是因為它就是同一件事的另一半：左邊是「還沒盤的」，
 * 下面是「剛盤完的」。店員盤完一輪之後第一個問題永遠是「我剛剛盤了什麼」。
 */
import { AlertTriangle, ClipboardCheck, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  categoryLabel,
  reasonLabel,
  statusLabel,
  statusVariant,
} from "@/lib/admin/inv-adjustment-labels";
import { INV_PRODUCT_TYPE_LABELS } from "@/lib/admin/schemas";
import type { AdminAdjustmentRow, StockCountProductRow } from "@/server/repos/inv-adjustments";
import { isLowStock } from "@/lib/admin/low-stock";

// 低庫存的唯一定義在 src/lib/admin/low-stock.ts（repo 的篩選與 MCP 共用）。
export { isLowStock };

function typeLabel(code: string) {
  return INV_PRODUCT_TYPE_LABELS[code as keyof typeof INV_PRODUCT_TYPE_LABELS] ?? code;
}

type Props = {
  rows: StockCountProductRow[];
  busy: boolean;
  onCount: (row: StockCountProductRow) => void;
};

export function StockCountTable({ rows, busy, onCount }: Props) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-56">商品</TableHead>
            <TableHead className="w-40">系列 / 期數</TableHead>
            <TableHead className="w-24">分類</TableHead>
            <TableHead className="w-24">類型</TableHead>
            <TableHead className="w-28 text-right">目前庫存</TableHead>
            <TableHead className="w-28 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const low = isLowStock(row);
            return (
              <TableRow key={row.inv_product_id}>
                <TableCell>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{row.name}</span>
                      {low ? (
                        <Badge variant="destructive" className="gap-1 font-normal">
                          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                          低庫存
                        </Badge>
                      ) : null}
                    </div>
                    {row.barcode ? (
                      <p className="font-mono text-xs text-muted-foreground">{row.barcode}</p>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  {[row.series, row.issue_number ? `NO.${row.issue_number}` : null]
                    .filter(Boolean)
                    .join(" ・ ") || "—"}
                </TableCell>
                <TableCell className="text-sm">{row.category_name ?? "—"}</TableCell>
                <TableCell className="text-sm">{typeLabel(row.product_type)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-col items-end">
                    <span
                      className={low ? "font-medium tabular-nums text-destructive" : "tabular-nums"}
                    >
                      {row.stock_quantity} 件
                    </span>
                    {row.low_stock_alert !== null ? (
                      <span className="text-xs text-muted-foreground">
                        警示 {row.low_stock_alert}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={busy}
                    onClick={() => onCount(row)}
                  >
                    <ClipboardCheck className="h-3.5 w-3.5" />
                    盤點
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * 最近的盤點紀錄（category = 'ADJ'）。
 *
 * 數量是**差異**，正的是盤盈、負的是盤虧。那個數字是資料庫用當下的 stock_quantity
 * 算出來的，不是瀏覽器送上去的 —— 這一頁只負責把它顯示出來。
 */
export function RecentStockCounts({ rows }: { rows: AdminAdjustmentRow[] }) {
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <History className="h-4 w-4" aria-hidden="true" />
        最近盤點紀錄
      </h2>
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          還沒有任何盤點紀錄。
        </div>
      ) : (
        <RecentTable rows={rows} />
      )}
    </div>
  );
}

function RecentTable({ rows }: { rows: AdminAdjustmentRow[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-32">單號</TableHead>
            <TableHead className="w-28">日期</TableHead>
            <TableHead className="min-w-48">商品</TableHead>
            <TableHead className="w-24">原因</TableHead>
            <TableHead className="w-24 text-right">差異</TableHead>
            <TableHead className="w-24">狀態</TableHead>
            <TableHead className="w-28">建立者</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.adjustment_id}>
              <TableCell className="font-mono text-xs">{row.adjustment_number ?? "—"}</TableCell>
              <TableCell className="tabular-nums text-sm">{row.adjustment_date}</TableCell>
              <TableCell className="text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span>{row.product_name ?? "—"}</span>
                  {row.category === "ADJ" ? null : (
                    <Badge variant="outline" className="font-normal">
                      {categoryLabel(row.category)}
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-sm">{reasonLabel(row.reason)}</TableCell>
              <TableCell className="text-right">
                <span
                  className={
                    row.quantity < 0
                      ? "font-medium tabular-nums text-destructive"
                      : "font-medium tabular-nums text-emerald-700"
                  }
                >
                  {row.quantity > 0 ? "+" : ""}
                  {row.quantity}
                </span>
              </TableCell>
              <TableCell>
                <Badge variant={statusVariant(row.status)} className="font-normal">
                  {statusLabel(row.status)}
                </Badge>
              </TableCell>
              <TableCell className="text-sm">{row.creator_name ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
