/**
 * 進貨清單表格。
 *
 * ── 效期的門檻是**每一列自己的** ──────────────────────────────────────────
 * expiry_alert_days 是 inv.purchases 的欄位（預設 7）：生鮮可能是 3 天，書可能
 * 從來不設。所以「快到期」不能用一個全域天數判斷，這裡逐列拿 row.expiry_alert_days
 * 去比。資料庫端的篩選只能用固定 30 天的上界先撈（PostgREST 不能拿一個欄位比另一
 * 個欄位），撈多了在這裡收斂，撈少了就是漏單 —— 所以那邊寧可撈多。
 *
 * ── 剩餘數量後面那一句是 consumed_quantity，不是自己減 ────────────────────
 * remaining_quantity 由 FIFO trigger 維護，consumed_quantity 是 0017 的 view 直接
 * 給的。用 quantity - remaining 自己算會在批次被修改過數量之後對不上。
 */
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock, Loader2, Pencil, Trash2, XCircle } from "lucide-react";
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
import { purchaseApprovalLabel, purchaseApprovalVariant } from "@/lib/admin/inv-adjustment-labels";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import { rememberAdminPeek } from "@/lib/admin/list-memory";
import type { AdminPurchaseRow } from "@/server/repos/inv-purchases";

type Props = {
  rows: AdminPurchaseRow[];
  selectMode: boolean;
  selectedIds: string[];
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  busyId: string | null;
  canApprove: boolean;
  onDelete: (row: AdminPurchaseRow) => void;
  onApprove: (row: AdminPurchaseRow, approved: boolean) => void;
};

function money(n: number | null) {
  if (n === null || n === undefined) return "—";
  return `NT$ ${Number(n).toLocaleString("zh-TW")}`;
}

/** 兩個 YYYY-MM-DD 相差幾天。用 UTC 分量算，不受瀏覽器時區影響。 */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function ExpiryCell({ row, today }: { row: AdminPurchaseRow; today: string }) {
  if (!row.expiry_date) return <span className="text-muted-foreground">—</span>;

  const days = daysBetween(today, row.expiry_date);
  const alertDays = row.expiry_alert_days ?? 7;

  if (days < 0) {
    return (
      <Badge variant="destructive" className="gap-1 whitespace-nowrap font-normal">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        已過期 {Math.abs(days)} 天
      </Badge>
    );
  }
  if (days <= alertDays) {
    return (
      <Badge
        variant="outline"
        className="gap-1 whitespace-nowrap border-amber-500/40 font-normal text-amber-700"
      >
        <Clock className="h-3 w-3" aria-hidden="true" />
        {days} 天後到期
      </Badge>
    );
  }
  return <span className="text-xs text-muted-foreground">{row.expiry_date}</span>;
}

export function PurchaseTable({
  rows,
  selectMode,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  busyId,
  canApprove,
  onDelete,
  onApprove,
}: Props) {
  const today = todayInTaipei();
  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.includes(r.purchase_id));

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
            <TableHead className="w-28">進貨日期</TableHead>
            <TableHead className="min-w-56">商品名稱</TableHead>
            <TableHead className="w-20">期數</TableHead>
            <TableHead className="w-28">系列</TableHead>
            <TableHead className="w-32">供應商</TableHead>
            <TableHead className="w-28">出版社</TableHead>
            <TableHead className="w-24 text-right">進貨數量</TableHead>
            <TableHead className="w-32 text-right">剩餘數量</TableHead>
            <TableHead className="w-32">效期</TableHead>
            <TableHead className="w-28 text-right">單價</TableHead>
            <TableHead className="w-28 text-right">小計</TableHead>
            <TableHead className="w-24">建立者</TableHead>
            <TableHead className="w-24">審核狀態</TableHead>
            <TableHead className="w-48 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const busy = busyId === row.purchase_id;
            const usedUp = row.remaining_quantity === 0;
            const consumed = row.consumed_quantity ?? 0;
            // item_name 與商品名稱一樣時只顯示一行 —— 兩行一模一樣的字只會讓人以為
            // 是畫面出錯。不一樣才把商品名稱補在下面。
            const title = row.item_name || row.product_name || "（找不到商品）";
            const alias =
              row.item_name && row.item_name !== row.product_name ? row.product_name : null;

            return (
              <TableRow key={row.purchase_id} className={usedUp ? "opacity-60" : undefined}>
                {selectMode ? (
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.includes(row.purchase_id)}
                      onCheckedChange={() => onToggleSelect(row.purchase_id)}
                      aria-label={`選取 ${title}`}
                    />
                  </TableCell>
                ) : null}

                <TableCell className="whitespace-nowrap text-sm text-muted-foreground tabular-nums">
                  {row.purchase_date}
                </TableCell>

                <TableCell>
                  <div className="space-y-0.5">
                    <span className="font-medium">{title}</span>
                    {alias ? <p className="text-xs text-muted-foreground">→ {alias}</p> : null}
                  </div>
                </TableCell>

                <TableCell className="tabular-nums">{row.issue_number ?? "—"}</TableCell>
                <TableCell className="text-sm">{row.series ?? "—"}</TableCell>
                <TableCell className="text-sm">
                  {row.vendor_short_name || row.vendor_name || row.vendor_text || "—"}
                </TableCell>
                <TableCell className="text-sm">{row.publisher ?? "—"}</TableCell>

                <TableCell className="text-right tabular-nums">+{row.quantity}</TableCell>

                <TableCell className="text-right">
                  <div className="flex flex-col items-end">
                    <span className="tabular-nums">{row.remaining_quantity}</span>
                    {usedUp ? (
                      <span className="text-xs text-muted-foreground">已售完</span>
                    ) : consumed > 0 ? (
                      <span className="text-xs text-muted-foreground">已用 {consumed}</span>
                    ) : null}
                  </div>
                </TableCell>

                <TableCell>
                  <ExpiryCell row={row} today={today} />
                </TableCell>

                <TableCell className="text-right tabular-nums">{money(row.unit_cost)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {money(row.subtotal)}
                </TableCell>
                <TableCell className="text-sm">{row.creator_name ?? "—"}</TableCell>

                <TableCell>
                  <Badge
                    variant={purchaseApprovalVariant(row.approval_status)}
                    className="whitespace-nowrap font-normal"
                  >
                    {purchaseApprovalLabel(row.approval_status)}
                  </Badge>
                </TableCell>

                <TableCell>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {/* 只有待審核而且有權限的人看得到審核按鈕。⚠️ 這只是畫面 ——
                        擋住直接 POST 的是 fns/inv-purchases.ts 的 approve_purchases
                        檢查，它每一次都重讀 staff_permissions。 */}
                    {row.approval_status === "pending" && canApprove ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 border-emerald-600/40 text-emerald-700 hover:bg-emerald-600/10"
                          disabled={busy}
                          onClick={() => onApprove(row, true)}
                        >
                          {busy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )}
                          通過
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
                          disabled={busy}
                          onClick={() => onApprove(row, false)}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          退回
                        </Button>
                      </>
                    ) : null}
                    {/* 編輯是內頁（2026-10-26 起不再是彈窗）。列上的動作寫入中時先停著
                        （disabled：沒有 href、不預載、aria-disabled）。 */}
                    <Button asChild size="icon" variant="ghost" className="h-8 w-8" title="編輯">
                      <Link
                        to="/admin/inventory-purchases/$id"
                        params={{ id: row.purchase_id }}
                        preload="intent"
                        disabled={busy}
                        onClick={() => rememberAdminPeek("purchase", row.purchase_id, row)}
                      >
                        <Pencil className="h-4 w-4" />
                        <span className="sr-only">編輯</span>
                      </Link>
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
