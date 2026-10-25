/**
 * 套餐詳情（唯讀）的本體：組成品項與庫存、分攤預覽、最近的套餐銷售。
 *
 * 2026-10-25 從 ComboSetDetailDialog 改成內頁（/admin/inventory-combos/$id）。資料由 layout
 * 的 loader 一次給齊（getInventoryComboPageData），這裡不另外抓。
 *
 * ⚠️ 分攤預覽是預覽。實際入帳金額由資料庫在結帳當下算，見
 *    lib/admin/combo-allocation.ts 的檔頭。
 */
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ApprovalStatusBadge } from "@/components/inventory/ApprovalStatusBadge";
import { ComboSetAllocationPreview } from "@/components/inventory/ComboSetAllocationPreview";
import { ComboSetBasisHint } from "@/components/inventory/ComboSetBasisBadge";
import { ComboSetSalesList } from "@/components/inventory/ComboSetSalesList";
import { money, productLabel } from "@/lib/admin/inv-combo-labels";
import type {
  AdminComboItemRow,
  AdminComboSaleRow,
  AdminComboSetRow,
} from "@/server/repos/inv-combos";

function when(iso: string | null) {
  // SSR 與瀏覽器要印出一樣的字（toLocaleString 在 Node 會多一個 THIN SPACE → React #418）。
  return iso ? formatTaipeiDateTime(iso) : "—";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="break-words text-sm">{children}</div>
    </div>
  );
}

/** 上架／審核狀態兩個徽章（詳情頁標題列與 pending 畫面共用）。 */
export function ComboSetBadges({ row }: { row: AdminComboSetRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant={row.is_active ? "default" : "outline"} className="font-normal">
        {row.is_active ? "已上架" : "已下架"}
      </Badge>
      <ApprovalStatusBadge status={row.approval_status} />
    </div>
  );
}

type Props = {
  set: AdminComboSetRow;
  items: AdminComboItemRow[];
  sales: AdminComboSaleRow[];
};

export function ComboSetDetailView({ set, items, sales }: Props) {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="還能組幾份">
          {set.max_sets === null ? "—（沒有組成品項）" : `${set.max_sets} 份`}
        </Field>
        <Field label="已售組數">{set.sold_sets} 組</Field>
        <Field label="累計營收">{money(set.sold_revenue)}</Field>
        <Field label="建立者">{set.creator_name ?? "—"}</Field>
        <Field label="審核者">{set.approved_by_name ?? "—"}</Field>
        <Field label="審核時間">{when(set.approved_at)}</Field>
      </div>

      {set.notes ? (
        <Field label="備註">
          <p className="whitespace-pre-wrap">{set.notes}</p>
        </Field>
      ) : null}

      <ComboSetBasisHint basis={set.allocation_basis} zeroPricedItems={set.zero_priced_items} />

      <Separator />

      <div className="space-y-2">
        <p className="text-sm font-medium">組成品項與庫存</p>
        {items.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            這個套餐沒有組成品項，資料庫會擋下販售（COMBO_NO_ITEMS）。
          </p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li
                key={item.item_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm"
              >
                <span className="min-w-0 break-words">
                  {productLabel(item.product_name, item.issue_number)}
                  <span className="text-muted-foreground"> × {item.quantity}</span>
                  {item.product_active ? null : (
                    <Badge variant="destructive" className="ml-1.5 font-normal">
                      已停用
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  定價 {item.selling_price > 0 ? money(item.selling_price) : "未填"}・庫存{" "}
                  {item.stock_quantity}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ComboSetAllocationPreview
        sellingPrice={set.selling_price}
        items={items.map((item) => ({
          product_id: item.product_id,
          quantity: item.quantity,
          selling_price: item.selling_price,
          name: item.product_name,
          issue_number: item.issue_number,
        }))}
      />

      <Separator />

      <div className="space-y-2">
        <p className="text-sm font-medium">套餐銷售（最近 50 筆）</p>
        <ComboSetSalesList rows={sales} loading={false} />
      </div>
    </div>
  );
}
