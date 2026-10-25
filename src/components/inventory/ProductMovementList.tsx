/**
 * 商品詳細頁的「異動紀錄」（最近 50 筆）。
 *
 * 資料來自 inv_admin_product_movements（0017 的 union view）：現役的 stock_adjustments 與
 * 已凍結的 inventory_adjustments 都在裡面。來源的商品詳細頁只讀舊表，於是 2026-03 之後做的
 * 每一次盤點在那裡都是空的 —— 這裡兩張都讀，而且**只讀**（寫入只走在庫異動／盤點頁）。
 *
 * ⚠️ code 要分 source 解讀：舊表只有 shrinkage／surplus（legacyTypeLabel），新表是六類代碼。
 */
import { Badge } from "@/components/ui/badge";
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
  categoryVariant,
  legacyTypeLabel,
  reasonLabel,
  statusLabel,
} from "@/lib/admin/inv-adjustment-labels";
import { formatTaipeiDate } from "@/lib/taipei-time";
import type { ProductMovementRow } from "@/server/repos/inv-adjustments";

/** SSR 與瀏覽器要一樣（不用 toLocaleDateString，見 src/lib/taipei-time.ts）。 */
function day(iso: string) {
  return formatTaipeiDate(iso);
}

export function ProductMovementList({ rows }: { rows: ProductMovementRow[] }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">異動紀錄（最近 {rows.length} 筆）</h2>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          這件商品還沒有盤點或在庫異動。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">日期</TableHead>
                <TableHead className="whitespace-nowrap">類別</TableHead>
                <TableHead className="whitespace-nowrap text-right">數量</TableHead>
                <TableHead className="whitespace-nowrap">狀態</TableHead>
                <TableHead>原因／備註</TableHead>
                <TableHead className="whitespace-nowrap">建立者</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => {
                const legacy = m.source === "inventory_adjustment";
                return (
                  <TableRow key={`${m.source}:${m.movement_id}`}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {day(m.movement_date)}
                      {m.document_number ? (
                        <div className="font-mono text-xs text-muted-foreground">
                          {m.document_number}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge
                        variant={legacy ? "outline" : categoryVariant(m.code)}
                        className="font-normal"
                      >
                        {legacy ? legacyTypeLabel(m.code) : categoryLabel(m.code)}
                      </Badge>
                      {legacy ? (
                        <div className="text-xs text-muted-foreground">舊系統紀錄</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {statusLabel(m.status)}
                    </TableCell>
                    <TableCell className="min-w-40 break-words text-sm">
                      {legacy ? (m.reason ?? "—") : reasonLabel(m.reason)}
                      {m.notes ? (
                        <div className="text-xs text-muted-foreground">{m.notes}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {m.creator_name ?? "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
