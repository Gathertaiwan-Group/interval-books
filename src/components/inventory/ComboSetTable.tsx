/**
 * 套餐清單。
 *
 * ⚠️ 「分攤口徑」那一欄不是設定值，是資料庫算出來的結果（inv_admin_combo_sets 的
 *    allocation_basis）。它決定賣掉這個套餐時，組合價會怎麼拆給每一件組成品項 ——
 *    整頁最重要的一件事，所以它排在組成品項旁邊，不是藏在詳情裡。
 *
 * ⚠️ 「還能組幾份」（max_sets）是 view 依組成品項的現有庫存算的最小值。null 代表
 *    這個套餐沒有組成品項 —— 它一份都組不出來，而不是「無限」。
 *
 * ⚠️ 組成品項一次撈完（listAllComboItems），所以這裡只是分組，不會 N+1。
 */
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApprovalStatusBadge } from "@/components/inventory/ApprovalStatusBadge";
import { ComboSetBasisBadge } from "@/components/inventory/ComboSetBasisBadge";
import { ComboSetRowActions } from "@/components/inventory/ComboSetRowActions";
import { money, productLabel } from "@/lib/admin/inv-combo-labels";
import type { AdminComboItemRow, AdminComboSetRow } from "@/server/repos/inv-combos";

type Props = {
  rows: AdminComboSetRow[];
  items: AdminComboItemRow[];
  busyId: string | null;
  canApprove: boolean;
  onToggleActive: (row: AdminComboSetRow) => void;
  onAskDelete: (row: AdminComboSetRow) => void;
  onApprove: (row: AdminComboSetRow) => void;
  onReject: (row: AdminComboSetRow) => void;
  onResubmit: (row: AdminComboSetRow) => void;
};

function groupComboItems(items: AdminComboItemRow[]): Map<string, AdminComboItemRow[]> {
  const map = new Map<string, AdminComboItemRow[]>();
  for (const item of items) {
    const list = map.get(item.combo_set_id);
    if (list) list.push(item);
    else map.set(item.combo_set_id, [item]);
  }
  return map;
}

export function ComboSetTable(props: Props) {
  const { rows, items, busyId, canApprove, ...handlers } = props;
  const grouped = useMemo(() => groupComboItems(items), [items]);

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-40">套餐</TableHead>
            <TableHead className="w-24 text-right">組合價</TableHead>
            <TableHead className="min-w-56">組成品項</TableHead>
            <TableHead className="w-32">分攤口徑</TableHead>
            <TableHead className="w-24 text-right">還能組</TableHead>
            <TableHead className="w-24 text-right">已售組數</TableHead>
            <TableHead className="w-28 text-right">累計營收</TableHead>
            <TableHead className="w-28">狀態</TableHead>
            <TableHead className="w-72 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const setItems = grouped.get(row.combo_set_id) ?? [];
            const busy = busyId === row.combo_set_id;
            return (
              <TableRow key={row.combo_set_id} className={busy ? "opacity-60" : undefined}>
                <TableCell>
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{row.name}</p>
                    {row.notes ? (
                      <p className="line-clamp-1 text-xs text-muted-foreground" title={row.notes}>
                        {row.notes}
                      </p>
                    ) : null}
                  </div>
                </TableCell>

                <TableCell className="text-right font-medium tabular-nums text-sm">
                  {money(row.selling_price)}
                </TableCell>

                <TableCell>
                  {setItems.length === 0 ? (
                    <span className="text-xs text-muted-foreground">尚未設定組成品項</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {setItems.map((item) => (
                        <li key={item.item_id} className="text-xs">
                          {productLabel(item.product_name, item.issue_number)}
                          <span className="text-muted-foreground"> × {item.quantity}</span>
                          {item.selling_price > 0 ? null : (
                            <span className="ml-1 text-amber-700" title="這件商品沒有填售價">
                              （未填售價）
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </TableCell>

                <TableCell>
                  <ComboSetBasisBadge basis={row.allocation_basis} />
                </TableCell>

                <TableCell className="text-right tabular-nums text-sm">
                  {row.max_sets === null ? (
                    <span className="text-muted-foreground" title="沒有組成品項，一份也組不出來">
                      —
                    </span>
                  ) : (
                    `${row.max_sets} 份`
                  )}
                </TableCell>

                <TableCell className="text-right tabular-nums text-sm">{row.sold_sets}</TableCell>

                <TableCell className="text-right tabular-nums text-sm">
                  {money(row.sold_revenue)}
                </TableCell>

                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge variant={row.is_active ? "default" : "outline"} className="font-normal">
                      {row.is_active ? "已上架" : "已下架"}
                    </Badge>
                    <ApprovalStatusBadge status={row.approval_status} />
                  </div>
                </TableCell>

                <TableCell className="text-right">
                  <ComboSetRowActions row={row} busy={busy} canApprove={canApprove} {...handlers} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
