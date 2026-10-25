/**
 * /admin/sales —— 銷售紀錄
 *
 * 門市與網站兩條路徑最後都寫進 inv.sales，所以這一頁是唯一看得到「今天總共賣了
 * 多少」的地方 —— channel 那一欄就是兩者的分野。
 *
 * ── 相對來源 Sales.tsx（1,819 行）的三個實質差異 ──────────────────────────
 * 1. 篩選與分頁下推到資料庫。來源是抓全表再前端 filter，而且沒有分頁 —— 665 筆
 *    還撐得住，但那是一條每年都會更慢一點的路。
 * 2. 毛利只算一次，在 0014 的 inv_pos_sales view 裡。來源把同一段公式抄了五份，
 *    其中兩處的營收口徑還不一樣（unit_price×quantity vs amount）。
 * 3. 排序補了 created_at 當第二鍵。來源只按 sale_date 排，同一天的順序在
 *    PostgreSQL 眼裡是不確定的 —— 重新整理就換一個順序。
 *
 * ── 沒有搬過來的（Phase 4 交接）────────────────────────────────────────────
 * · 套餐分頁：inv.sales 有 combo_set_id / combo_sale_group，資料也在，但套餐的
 *   金額分攤規則（第一件吃全額、其餘記 0）需要一頁自己的 UI 才講得清楚。
 * · 月結對帳的「標記已對帳」寫入：這一頁看得到 is_reconciled，但還不能改它。
 */
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Loader2, Receipt } from "lucide-react";
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
import { SaleDetailDialog } from "@/components/pos/SaleDetailDialog";
import { SalesFilterBar } from "@/components/pos/SalesFilterBar";
import type { PosSaleRow } from "@/server/repos/inv-sales";
import type { SalesFilterValues } from "@/lib/admin/schemas";
import { useLoaderBackedList } from "@/lib/admin/useLoaderBackedList";

const PAGE_SIZE = 50;

const DEFAULT_FILTER: SalesFilterValues = {
  from: null,
  to: null,
  channel: "all",
  keyword: null,
  reconciled: "all",
  paymentMethodId: null,
  page: 0,
  pageSize: PAGE_SIZE,
};

export const Route = createFileRoute("/admin/_shell/sales")({
  loader: async () => {
    const { listPosSales, listPosPaymentMethods } = await import("@/lib/admin/fns/pos");
    const [initial, paymentMethods] = await Promise.all([
      listPosSales({ data: DEFAULT_FILTER }),
      listPosPaymentMethods(),
    ]);
    return { initial, paymentMethods };
  },
  head: () => ({ meta: [{ title: "銷售紀錄｜小時光書店後台" }] }),
  component: SalesPage,
});

function money(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

function SalesPage() {
  const { initial: loaderSales, paymentMethods } = Route.useLoaderData();
  const loaderUpdatedAt = Route.useMatch({ select: (m) => m.updatedAt });

  // 篩選 → 重抓、背景重抓會反映在畫面上、從別頁回來篩選還原：都交給 useLoaderBackedList。
  // loader 已經用 DEFAULT_FILTER 抓過了，所以第一次不會再打一次。
  const list = useLoaderBackedList({
    key: "sales",
    loaderFilter: DEFAULT_FILTER,
    loaderData: loaderSales,
    loaderUpdatedAt,
    errorMessage: "銷售紀錄讀取失敗",
    fetcher: async (next: SalesFilterValues) => {
      const { listPosSales } = await import("@/lib/admin/fns/pos");
      return await listPosSales({ data: next });
    },
  });
  const { filter, setFilter, data, loading } = list;

  // 明細對話框看的是點開那一刻那一列的副本，背景重抓不會把它關掉或換掉（第 3 批再改內頁）。
  const [selected, setSelected] = useState<PosSaleRow | null>(null);

  const { rows, total, summary } = data;
  const lastPage = Math.max(0, Math.ceil(total / filter.pageSize) - 1);
  const grossProfit = summary.amount - summary.cost;

  return (
    <div className="space-y-5">
      <h1 className="flex items-center gap-2 text-lg font-medium">
        <Receipt className="h-5 w-5" aria-hidden="true" />
        銷售紀錄
      </h1>

      <SalesFilterBar
        value={filter}
        onChange={setFilter}
        paymentMethods={paymentMethods}
        disabled={loading}
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <SummaryCard label="筆數" value={summary.count.toLocaleString("zh-TW")} />
        <SummaryCard label="件數" value={summary.quantity.toLocaleString("zh-TW")} />
        <SummaryCard label="營收" value={`NT$ ${money(summary.amount)}`} />
        <SummaryCard
          label="毛利"
          value={`NT$ ${money(grossProfit)}`}
          hint={summary.cost === 0 ? "成本未分攤時毛利會等於營收" : undefined}
        />
      </div>

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">日期</TableHead>
              <TableHead>品項</TableHead>
              <TableHead className="w-20">通路</TableHead>
              <TableHead className="w-16 text-right">數量</TableHead>
              <TableHead className="w-24 text-right">金額</TableHead>
              <TableHead className="w-24 text-right">毛利</TableHead>
              <TableHead className="w-28">付款方式</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-sm text-muted-foreground">
                  這個條件下沒有銷售紀錄
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.sale_id}
                  onClick={() => setSelected(row)}
                  className="cursor-pointer"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(row);
                    }
                  }}
                >
                  <TableCell className="tabular-nums">{row.sale_date}</TableCell>
                  <TableCell>
                    <span className="block max-w-[22rem] truncate">
                      {row.product_name ?? "（無品名）"}
                    </span>
                    {row.override_reservation ? (
                      <Badge variant="destructive" className="mt-0.5 font-normal">
                        強制放行
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={row.channel === "online" ? "default" : "secondary"}
                      className="font-normal"
                    >
                      {row.channel === "online" ? "網站" : "門市"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.gross_profit === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      money(row.gross_profit)
                    )}
                  </TableCell>
                  <TableCell className="truncate">{row.payment_method_name ?? "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <p className="text-muted-foreground">
          第 {filter.page + 1} / {lastPage + 1} 頁，共 {total.toLocaleString("zh-TW")} 筆
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFilter({ ...filter, page: filter.page - 1 })}
            disabled={loading || filter.page <= 0}
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            上一頁
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFilter({ ...filter, page: filter.page + 1 })}
            disabled={loading || filter.page >= lastPage}
          >
            下一頁
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </div>

      <SaleDetailDialog sale={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-medium tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
