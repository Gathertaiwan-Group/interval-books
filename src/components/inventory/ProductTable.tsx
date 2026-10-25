/**
 * 商品清單表格。
 *
 * ── 組合品的庫存是算出來的，不是存起來的 ──────────────────────────────────
 * 一件「三入組」自己的 stock_quantity 永遠是 0：它的貨在母品項身上。來源在**前端**
 * 用 `products.find(p => p.id === base_product_id)` 去撈母品項再除 pack_size ——
 * 那在「整張表都載進瀏覽器」的前提下才成立，一分頁就會撈不到（母品項在別頁）。
 *
 * 這裡改成資料庫算：0016 的 inv_admin_products 就有 base_product_name，可售量
 * 由 0014 那條同樣的規則負責（POS 那一側才是真的要算得準的地方）。這一頁顯示
 * 「來源：某某」而不是自己除一次，因為除錯的兩個數字要在同一個地方算。
 */
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Eye, PowerOff, Pencil, Tag, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApprovalActions } from "@/components/inventory/ApprovalActions";
import { ApprovalStatusBadge, PriceChangeBadge } from "@/components/inventory/ApprovalStatusBadge";
import { INV_PRODUCT_TYPE_LABELS } from "@/lib/admin/schemas";
import { rememberAdminPeek } from "@/lib/admin/list-memory";
import type { AdminProductRow } from "@/server/repos/inv-products";

type Props = {
  rows: AdminProductRow[];
  selectMode: boolean;
  selectedIds: string[];
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  busyId: string | null;
  canApproveProducts: boolean;
  onPrice: (row: AdminProductRow) => void;
  onToggleActive: (row: AdminProductRow) => void;
  onDelete: (row: AdminProductRow) => void;
  onApprove: (row: AdminProductRow, approved: boolean) => void;
  onResubmit: (row: AdminProductRow) => void;
};

function money(n: number | null) {
  if (n === null || n === undefined) return "—";
  return `NT$ ${Number(n).toLocaleString("zh-TW")}`;
}

export function ProductTable({
  rows,
  selectMode,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  busyId,
  canApproveProducts,
  onPrice,
  onToggleActive,
  onDelete,
  onApprove,
  onResubmit,
}: Props) {
  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.includes(r.inv_product_id));

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {selectMode ? (
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={onToggleSelectAll}
                  aria-label="全選本頁"
                />
              </TableHead>
            ) : null}
            <TableHead className="min-w-56">商品</TableHead>
            <TableHead className="w-20">期數</TableHead>
            <TableHead className="w-24">分類</TableHead>
            <TableHead className="w-24">類型</TableHead>
            <TableHead className="w-32">供應商</TableHead>
            <TableHead className="w-28 text-right">售價</TableHead>
            <TableHead className="w-28 text-right">庫存</TableHead>
            <TableHead className="w-40">狀態</TableHead>
            <TableHead className="w-64 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const lowStock =
              row.low_stock_alert !== null &&
              row.low_stock_alert > 0 &&
              row.stock_quantity <= row.low_stock_alert;
            const busy = busyId === row.inv_product_id;

            return (
              <TableRow
                key={row.inv_product_id}
                className={row.is_active ? undefined : "opacity-60"}
              >
                {selectMode ? (
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.includes(row.inv_product_id)}
                      onCheckedChange={() => onToggleSelect(row.inv_product_id)}
                      aria-label={`選取 ${row.name}`}
                    />
                  </TableCell>
                ) : null}

                <TableCell>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{row.name}</span>
                      {row.is_active ? null : (
                        <Badge variant="outline" className="gap-1 font-normal">
                          <PowerOff className="h-3 w-3" aria-hidden="true" />
                          已停用
                        </Badge>
                      )}
                      {lowStock ? (
                        <Badge variant="destructive" className="gap-1 font-normal">
                          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                          低庫存
                        </Badge>
                      ) : null}
                      {row.listed_slug ? (
                        <Badge variant="secondary" className="font-normal">
                          網站上架中
                        </Badge>
                      ) : null}
                    </div>
                    {row.barcode ? (
                      <p className="font-mono text-xs text-muted-foreground">{row.barcode}</p>
                    ) : null}
                    {row.series || row.publisher ? (
                      <p className="text-xs text-muted-foreground">
                        {[row.series, row.publisher].filter(Boolean).join(" ・ ")}
                      </p>
                    ) : null}
                  </div>
                </TableCell>

                <TableCell className="tabular-nums">{row.issue_number ?? "—"}</TableCell>
                <TableCell className="text-sm">{row.category_name ?? "—"}</TableCell>
                <TableCell className="text-sm">
                  {INV_PRODUCT_TYPE_LABELS[
                    row.product_type as keyof typeof INV_PRODUCT_TYPE_LABELS
                  ] ?? row.product_type}
                </TableCell>
                <TableCell className="text-sm">
                  {row.vendor_short_name || row.vendor_name || "—"}
                </TableCell>

                <TableCell className="text-right tabular-nums">
                  <div>{money(row.selling_price)}</div>
                  {row.price_change_status === "pending" && row.pending_selling_price !== null ? (
                    <div className="text-xs text-amber-700">
                      待審 {money(row.pending_selling_price)}
                    </div>
                  ) : null}
                </TableCell>

                <TableCell className="text-right">
                  {row.base_product_id ? (
                    <div className="flex flex-col items-end">
                      <span className="tabular-nums">{row.available} 組</span>
                      <span className="text-xs text-muted-foreground">
                        來源：{row.base_product_name ?? "未知"}
                      </span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-end">
                      <span className="tabular-nums">{row.stock_quantity} 件</span>
                      {row.reserved > 0 ? (
                        <span className="text-xs text-muted-foreground">
                          網站保留 {row.reserved}
                        </span>
                      ) : null}
                    </div>
                  )}
                </TableCell>

                <TableCell>
                  <div className="flex flex-col items-start gap-1">
                    <ApprovalStatusBadge status={row.approval_status} />
                    <PriceChangeBadge
                      status={row.price_change_status}
                      pendingPrice={row.pending_selling_price}
                    />
                  </div>
                </TableCell>

                <TableCell>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <ApprovalActions
                      status={row.approval_status}
                      canApprove={canApproveProducts}
                      busy={busy}
                      productName={row.name}
                      onApprove={() => onApprove(row, true)}
                      onReject={() => onApprove(row, false)}
                      onResubmit={() => onResubmit(row)}
                    />
                    {/* 詳細／編輯是內頁（2026-10-25 起不再是彈窗）。滑過就預載。列上的動作寫入中時停用
                        （<Link disabled>：沒有 href、不預載、aria-disabled）。 */}
                    <Button asChild size="icon" variant="ghost" className="h-8 w-8">
                      <Link
                        to="/admin/inventory-products/$id"
                        params={{ id: row.inv_product_id }}
                        preload="intent"
                        title="查看詳細"
                        disabled={busy}
                        onClick={() => rememberAdminPeek("inv-product", row.inv_product_id, row)}
                      >
                        <Eye className="h-4 w-4" />
                        <span className="sr-only">查看詳細</span>
                      </Link>
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      title="調價"
                      disabled={busy}
                      onClick={() => onPrice(row)}
                    >
                      <Tag className="h-4 w-4" />
                      <span className="sr-only">調價</span>
                    </Button>
                    <Button asChild size="icon" variant="ghost" className="h-8 w-8">
                      <Link
                        to="/admin/inventory-products/$id/edit"
                        params={{ id: row.inv_product_id }}
                        preload="intent"
                        title="編輯"
                        disabled={busy}
                        onClick={() => rememberAdminPeek("inv-product", row.inv_product_id, row)}
                      >
                        <Pencil className="h-4 w-4" />
                        <span className="sr-only">編輯</span>
                      </Link>
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      title={row.is_active ? "停用" : "恢復上架"}
                      disabled={busy}
                      onClick={() => onToggleActive(row)}
                    >
                      <PowerOff className="h-4 w-4" />
                      <span className="sr-only">{row.is_active ? "停用" : "恢復上架"}</span>
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      title="刪除"
                      disabled={busy}
                      onClick={() => onDelete(row)}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="sr-only">刪除</span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
