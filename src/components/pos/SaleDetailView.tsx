/**
 * 一筆銷售的明細（/admin/sales/$saleId 的內容）。
 *
 * 2026-10-26 從 SaleDetailDialog 改成內頁（後台第 3 批；業主：「不要用彈窗，直接顯示內頁＆回到
 * 上一頁」）。顯示的欄位一個都沒變。原本對話框直接拿列表那一列來畫；列表瘦身之後只帶畫面用得到
 * 的欄位，所以內頁的 loader 依 sale_id 另抓完整的一筆（getPosSale，inv_pos_sales 一次給齊）。
 *
 * 時間用 taipei-time：內頁會 SSR，toLocaleTimeString 在 Node 與瀏覽器印出來的字不一樣（React #418）。
 */
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { PosSaleRow } from "@/server/repos/inv-sales";

function money(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  return `NT$ ${Number(n).toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;
}

export function SaleBadges({ sale }: { sale: PosSaleRow }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge variant={sale.channel === "online" ? "default" : "secondary"} className="font-normal">
        {sale.channel === "online" ? "網站訂單" : "門市"}
      </Badge>
      {sale.override_reservation ? (
        <Badge variant="destructive" className="font-normal">
          強制放行
        </Badge>
      ) : null}
      {sale.is_secondhand ? (
        <Badge variant="outline" className="font-normal">
          二手
        </Badge>
      ) : null}
      {sale.is_reconciled ? (
        <Badge variant="outline" className="font-normal">
          已對帳
        </Badge>
      ) : null}
    </div>
  );
}

export function SaleDetailView({ sale }: { sale: PosSaleRow }) {
  return (
    <div className="space-y-4 rounded-md border border-border p-4">
      <SaleBadges sale={sale} />
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">系列／期數</dt>
        <dd>{[sale.series, sale.issue_number].filter(Boolean).join("　") || "—"}</dd>

        <dt className="text-muted-foreground">數量</dt>
        <dd className="tabular-nums">{sale.quantity}</dd>

        <dt className="text-muted-foreground">單價</dt>
        <dd className="tabular-nums">{money(sale.unit_price)}</dd>

        <dt className="text-muted-foreground">小計</dt>
        <dd className="tabular-nums font-medium">{money(sale.amount)}</dd>

        <Separator className="col-span-2 my-1" />

        <dt className="text-muted-foreground">單位成本</dt>
        <dd className="tabular-nums">
          {sale.cost_price === null ? (
            <span className="text-muted-foreground">未分攤（搬遷前的資料）</span>
          ) : (
            money(sale.cost_price)
          )}
        </dd>

        <dt className="text-muted-foreground">毛利</dt>
        <dd className="tabular-nums">
          {sale.gross_profit === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            money(sale.gross_profit)
          )}
        </dd>

        <Separator className="col-span-2 my-1" />

        <dt className="text-muted-foreground">付款方式</dt>
        <dd>{sale.payment_method_name ?? "—"}</dd>

        <dt className="text-muted-foreground">操作人員</dt>
        <dd>{sale.operator_name ?? "—"}</dd>

        {sale.web_order_id ? (
          <>
            <dt className="text-muted-foreground">網站訂單</dt>
            <dd className="break-all font-mono text-xs">{sale.web_order_id}</dd>
          </>
        ) : null}

        <dt className="text-muted-foreground">備註</dt>
        <dd className="whitespace-pre-wrap">{sale.notes || "—"}</dd>
      </dl>
    </div>
  );
}
