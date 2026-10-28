/**
 * /admin/orders —— 訂單列表。點一列進 /admin/orders/$id（獨立的訂單內頁，見
 * _shell.orders_.$id.tsx）。
 *
 * 站上有「匯款」這個付款方式（0034）：客人下單後自己匯款到店家固定帳戶，匯完回報
 * 末五碼，店家對帳之後手動標成已收款。這一頁的預設分頁（「待收款的匯款訂單」）就
 * 是為了讓這件事有地方做——逾期未標記的匯款訂單會在 3 天後被自動取消。
 *
 * ── 為什麼詳情從 Dialog 改成獨立頁（業主 2026-10-25）────────────────────────
 * 業主要「不用彈窗、直接進訂單內頁」。好處：每張訂單有自己的網址（通知信、LINE
 * 直接貼）、上一頁／下一頁正常運作、內頁的 loader 一次就把資料拿齊（不是先開空的
 * Dialog 再等第二次請求）。
 *
 * ── 篩選就是網址 ──────────────────────────────────────────────────────────
 * 分頁（?scope=）與「顯示已封存」（?archived=1）都在網址上，所以從內頁按「回訂單
 * 列表」會回到原本那個分頁與開關——內頁把同一組參數原樣帶著（parseOrderListSearch）。
 *
 * ── 舊連結 ?order=<uuid> ─────────────────────────────────────────────────
 * 已經寄出去的店家通知信裡，「到後台查看這張訂單」是 /admin/orders?order=<id>。
 * beforeLoad 看到這個參數就直接轉址到 /admin/orders/<id>，舊信照樣點得開。新信的
 * 連結已經是 /admin/orders/<id>（src/server/notify.ts）。
 *
 * ── 個資 ────────────────────────────────────────────────────────────────
 * 業主決定訂單在後台直接顯示明文、不留查閱紀錄（見 src/server/repos/orders-admin.ts
 * 檔頭）。列表只列姓名；電話／信箱／地址在內頁。
 */
import { createFileRoute, Link, redirect, useRouter, useRouterState } from "@tanstack/react-router";
import { Landmark, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InvoiceProblemBanner } from "@/components/admin/InvoiceProblemBanner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
// 時間一律走這一支，不要再寫 toLocaleString：就算帶了 timeZone，Node 與 Chrome 的
// ICU 印出來的字也不一樣（空白字元），SSR 會 React #418。見該檔檔頭。
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import {
  isUuid,
  money,
  parseOrderListSearch,
  PAYMENT_STATUS_LABEL,
  paymentMethodLabel,
  paymentStatusBadgeVariant,
  scopeOf,
  STATUS_LABEL,
  statusBadgeVariant,
  type OrderListScope,
  type OrderListSearch,
} from "@/lib/admin/order-labels";

/**
 * 這一頁不是報表，單次讀取有上限 —— 必須與
 * src/server/repos/orders-admin.ts 的 LIST_LIMIT 保持一致（那裡是查詢的
 * `.limit()`，這裡只是「是不是可能被截斷了」的畫面提示）。
 */
const LIST_LIMIT_HINT = 300;

type ListSearch = OrderListSearch & { order?: string };

export const Route = createFileRoute("/admin/_shell/orders")({
  // ?scope=to_ship 讓首頁「待出貨」卡片可以直接落在那個分頁；不帶就是預設分頁。
  validateSearch: (search: Record<string, unknown>): ListSearch => {
    const out: ListSearch = parseOrderListSearch(search);
    if (isUuid(search.order)) out.order = search.order;
    return out;
  },
  beforeLoad: ({ search }) => {
    // 舊通知信的 /admin/orders?order=<id> → /admin/orders/<id>（見檔頭）。
    if (search.order) {
      const { order, ...rest } = search;
      throw redirect({
        to: "/admin/orders/$id",
        params: { id: order },
        search: rest,
        replace: true,
      });
    }
  },
  loaderDeps: ({ search }) => ({ scope: scopeOf(search), archived: search.archived === 1 }),
  loader: async ({ deps }) => {
    const { listAdminOrders } = await import("@/lib/admin/fns/orders");
    const { getInvoiceProblemSummary } = await import("@/lib/admin/fns/invoices");
    const [orders, invoiceSummary] = await Promise.all([
      listAdminOrders({ data: { scope: deps.scope, includeArchived: deps.archived } }),
      // 橫幅讀失敗不讓整個列表掛掉：回 null，橫幅顯示「讀取失敗」。
      getInvoiceProblemSummary().catch(() => ({ count: null })),
    ]);
    return {
      orders,
      scope: deps.scope,
      archived: deps.archived,
      invoiceProblems: invoiceSummary.count,
    };
  },
  head: () => ({ meta: [{ title: "訂單｜小時光書店後台" }] }),
  component: AdminOrdersPage,
});

function AdminOrdersPage() {
  const { orders, scope, archived, invoiceProblems } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const router = useRouter();
  // 換分頁／切開關時，loader 正在跑的那一段顯示讀取中。
  const loading = useRouterState({
    select: (s) => s.status === "pending" && s.location.pathname === "/admin/orders",
  });

  const listSearch = (next: { scope?: OrderListScope; archived?: boolean }): OrderListSearch => {
    const s = next.scope ?? scope;
    const a = next.archived ?? archived;
    return {
      ...(s === "transfer_pending" ? {} : { scope: s }),
      ...(a ? { archived: 1 as const } : {}),
    };
  };
  const currentSearch = listSearch({});

  const openOrder = (id: string) =>
    void navigate({ to: "/admin/orders/$id", params: { id }, search: currentSearch });

  // 滑過／聚焦就先把內頁的資料抓下來，點下去幾乎是立刻出現。
  const preloadOrder = (id: string) => {
    void router
      .preloadRoute({ to: "/admin/orders/$id", params: { id }, search: currentSearch })
      .catch(() => undefined);
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <Landmark className="h-5 w-5" aria-hidden="true" />
          訂單
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          客人匯款後要有人核對入帳、手動標成已收款——逾期未標記的匯款訂單會在 3
          天後被自動取消。點一列進入訂單內頁，看完整的聯絡方式、收件地址與發票資料。
        </p>
      </div>

      {/* 已經在「發票尚未開立」分頁上就不再重複一條指向自己的橫幅。 */}
      {scope === "invoice_problem" ? null : <InvoiceProblemBanner count={invoiceProblems} />}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <Tabs
          value={scope}
          onValueChange={(v) =>
            void navigate({ search: listSearch({ scope: v as OrderListScope }), replace: true })
          }
        >
          <TabsList>
            <TabsTrigger value="transfer_pending">待收款的匯款訂單</TabsTrigger>
            <TabsTrigger value="to_ship">待出貨</TabsTrigger>
            <TabsTrigger value="all">全部訂單</TabsTrigger>
            <TabsTrigger value="invoice_problem">
              發票尚未開立{invoiceProblems ? `（${invoiceProblems}）` : ""}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {/* 「發票尚未開立」本來就不看封存（發票照樣得開），開關在那一頁沒有作用，不顯示。 */}
        <label
          className={
            scope === "invoice_problem"
              ? "hidden"
              : "flex items-center gap-2 text-sm text-muted-foreground"
          }
        >
          <Switch
            checked={archived}
            onCheckedChange={(v) =>
              void navigate({ search: listSearch({ archived: v }), replace: true })
            }
          />
          顯示已封存
        </label>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>訂單編號</TableHead>
              <TableHead>客戶</TableHead>
              <TableHead>日期</TableHead>
              <TableHead className="text-right">金額</TableHead>
              <TableHead>付款方式</TableHead>
              <TableHead>付款狀態</TableHead>
              <TableHead>訂單狀態</TableHead>
              <TableHead>末五碼</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="h-32 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : orders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-32 text-center text-sm text-muted-foreground">
                  {scope === "transfer_pending"
                    ? "目前沒有待收款的匯款訂單"
                    : scope === "to_ship"
                      ? "目前沒有待出貨的訂單"
                      : scope === "invoice_problem"
                        ? "目前沒有發票尚未開立的已付款訂單"
                        : "目前沒有訂單"}
                </TableCell>
              </TableRow>
            ) : (
              orders.map((o) => (
                <TableRow
                  key={o.id}
                  onClick={() => openOrder(o.id)}
                  onMouseEnter={() => preloadOrder(o.id)}
                  onFocus={() => preloadOrder(o.id)}
                  className="cursor-pointer"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openOrder(o.id);
                    }
                  }}
                >
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {/* 真的 <a>：cmd／中鍵點擊可以開新分頁。整列的 onClick 管一般點擊，
                        這裡攔住冒泡，免得同一次點擊導覽兩次。 */}
                    <Link
                      to="/admin/orders/$id"
                      params={{ id: o.id }}
                      search={currentSearch}
                      className="underline-offset-2 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {o.order_no}
                    </Link>
                    {o.archived_at ? (
                      <Badge variant="outline" className="ml-2 font-normal">
                        已封存
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[10rem] truncate">{o.customer_name}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatTaipeiDateTime(o.created_at)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(o.total)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {paymentMethodLabel(o.payment_method)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={paymentStatusBadgeVariant(o.payment_status)}
                      className="font-normal"
                    >
                      {PAYMENT_STATUS_LABEL[o.payment_status] ?? o.payment_status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(o.status)} className="font-normal">
                      {STATUS_LABEL[o.status] ?? o.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{o.remittance_last5 ?? "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {!loading && orders.length >= LIST_LIMIT_HINT ? (
        <p className="text-xs text-muted-foreground">
          已達到單次讀取上限（{LIST_LIMIT_HINT} 筆），可能還有更早的訂單沒有顯示。
        </p>
      ) : null}
    </div>
  );
}
