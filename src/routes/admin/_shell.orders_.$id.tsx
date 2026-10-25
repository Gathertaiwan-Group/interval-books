/**
 * /admin/orders/$id —— 訂單內頁：詳情、標記已收款、出貨／取貨／完成、刪除／封存。
 *
 * 2026-10-25 從列表頁的 Dialog 搬出來（業主要「不用彈窗、直接進訂單內頁」，見
 * _shell.orders.tsx 檔頭）。動作與判斷**一行都沒改**，只是換了容器：
 *
 *   · 資料由 route loader 一次拿齊（getAdminOrderDetail 是一次巢狀查詢，見
 *     src/server/repos/orders-admin.ts 檔頭「速度」），動作做完用
 *     router.invalidate() 重跑同一個 loader，不再自己管一份 detail state。
 *   · 「回訂單列表」帶回原本的分頁與「顯示已封存」（網址參數原樣帶著，
 *     parseOrderListSearch）。
 *
 * ── 個資 ────────────────────────────────────────────────────────────────
 * 業主決定訂單在後台直接顯示明文、不留查閱紀錄：訂購人姓名／電話／信箱、收件人與
 * 電話、完整地址含門牌、超商門市、統編／抬頭、客人備註。只有 admin 看得到（每一支
 * server fn 掛 adminFnMiddleware，見 src/lib/admin/fns/orders.ts）。
 *
 * ── 刪除／封存（0035）─────────────────────────────────────────────────────
 *   payment_status !== 'paid' → 「刪除」。呼叫 admin_delete_order()（0035 §3），
 *     資料庫那一支會先還掉場次名額與庫存保留才刪。成功後回到列表。
 *   payment_status === 'paid' → 「封存」／「取消封存」。呼叫
 *     admin_archive_order()（0035 §4），只是設／清 orders.archived_at。
 * 分界是 payment_status，與資料庫那兩支函式的閘門一致——UI 這裡的判斷只是不要讓
 * 使用者點出一個注定會被資料庫拒絕的按鈕，真正的邊界仍然在資料庫那一層。
 *
 * ── 出貨／取貨／完成 ─────────────────────────────────────────────────────
 * 條件只定義一次，在 src/lib/admin/order-fulfillment.ts；寫入是一句 conditional
 * update（src/server/repos/order-fulfillment.ts）。只有「標記已出貨」會寄出貨
 * 通知信給客人（業主 2026-10-22 核准）。
 */
import { useState, type ReactNode } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Archive, ArchiveRestore, ArrowLeft, Landmark, PackageCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
// 時間一律走這一支（SSR 與瀏覽器印出來的字要一樣，見該檔檔頭）。
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import {
  ACTION_BUTTON_LABEL,
  availableFulfillmentAction,
  confirmDescription,
  type FulfillmentAction,
} from "@/lib/admin/order-fulfillment";
import {
  carrierTypeLabel,
  formatHomeAddress,
  invoiceTypeLabel,
  isUuid,
  money,
  parseOrderListSearch,
  PAYMENT_STATUS_LABEL,
  paymentMethodLabel,
  paymentStatusBadgeVariant,
  shippingMethodLabel,
  STATUS_LABEL,
  statusBadgeVariant,
  type OrderListSearch,
} from "@/lib/admin/order-labels";
// ⚠️ type-only：編譯後整行消失，不會把 server-only 的 repo 模組拉進瀏覽器 bundle。
import type { AdminOrderDetail } from "@/server/repos/orders-admin";

export const Route = createFileRoute("/admin/_shell/orders_/$id")({
  // 列表的篩選條件原樣帶著，「回訂單列表」才回得到原本的分頁。
  validateSearch: (search: Record<string, unknown>): OrderListSearch =>
    parseOrderListSearch(search),
  // 列表滑過就預載（_shell.orders.tsx）；30 秒內點進來直接用預載的資料，不重抓。
  // 動作做完一律 invalidate，不會看到動作前的舊狀態。
  preloadStaleTime: 30_000,
  loader: async ({ params }) => {
    // 不是 uuid 的網址直接當「找不到」，不打一趟注定被 zod 擋下的請求。
    if (!isUuid(params.id)) return { detail: null };
    const { getAdminOrderDetail } = await import("@/lib/admin/fns/orders");
    const detail = await getAdminOrderDetail({ data: { orderId: params.id } });
    return { detail };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.detail
          ? `訂單 ${loaderData.detail.order_no}｜小時光書店後台`
          : "訂單｜小時光書店後台",
      },
    ],
  }),
  component: AdminOrderDetailRoute,
});

function BackToList() {
  const search = Route.useSearch();
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 gap-1.5">
      <Link preload="intent" to="/admin/orders" search={search}>
        <ArrowLeft className="h-4 w-4" />
        回訂單列表
      </Link>
    </Button>
  );
}

function AdminOrderDetailRoute() {
  const { detail } = Route.useLoaderData();
  if (!detail) {
    return (
      <div className="space-y-4">
        <BackToList />
        <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
          找不到這張訂單，可能已被刪除或網址有誤。
        </p>
      </div>
    );
  }
  // 換一張訂單＝重新掛載，確認框與備註不會跨訂單殘留。
  return <AdminOrderDetailPage key={detail.id} detail={detail} />;
}

function AdminOrderDetailPage({ detail }: { detail: AdminOrderDetail }) {
  const router = useRouter();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();

  const [note, setNote] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [marking, setMarking] = useState(false);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const [fulfillAction, setFulfillAction] = useState<FulfillmentAction | null>(null);
  const [fulfilling, setFulfilling] = useState(false);

  /** 動作做完之後重跑 loader。失敗只代表畫面沒跟上，不是動作失敗。 */
  async function refresh() {
    try {
      // sync：等新資料真的回來才結束，按鈕才不會在舊狀態下先恢復可按。
      await router.invalidate({ sync: true });
    } catch {
      toast.error("已處理，但畫面更新失敗，請重新整理頁面確認最新狀態");
    }
  }

  /**
   * 標記已出貨／已取貨／已完成。already_done 是冪等成功（toast.info），不是錯誤。
   * 動作結果與畫面刷新分兩段：刷新失敗不可以被說成動作失敗。
   */
  async function submitFulfillment(action: FulfillmentAction) {
    setFulfilling(true);
    try {
      const { advanceOrderFulfillmentAdmin } = await import("@/lib/admin/fns/orders");
      const result = await advanceOrderFulfillmentAdmin({
        data: { orderId: detail.id, action },
      });
      const doneLabel = ACTION_BUTTON_LABEL[action].replace("標記", "");

      if (result.reason === "updated") {
        toast.success(`訂單 ${result.order_no} 已標記為${doneLabel}`);
        // 排信失敗不影響狀態（已經寫進去了），只提示。
        if (result.notify_warning) toast.warning(result.notify_warning);
      } else if (result.reason === "already_done") {
        toast.info(`訂單 ${result.order_no} 已經是${doneLabel}狀態，沒有重複處理`);
      } else if (result.reason === "ineligible") {
        toast.error(
          `訂單 ${result.order_no ?? ""} 目前不符合條件（狀態：${
            STATUS_LABEL[result.status ?? ""] ?? result.status ?? "—"
          }），無法${ACTION_BUTTON_LABEL[action]}`,
        );
      } else {
        toast.error("找不到這張訂單，可能已被刪除");
      }
      setFulfillAction(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失敗，請稍後再試");
      return;
    } finally {
      setFulfilling(false);
    }
    await refresh();
  }

  /**
   * 呼叫 admin_mark_order_paid()，四種 reason 各自對應一句清楚的話。already_paid
   * 用 toast.info：那是冪等成功（同一張單被標記了兩次），不是一次失敗。
   */
  async function submitMarkPaid() {
    setMarking(true);
    try {
      const { markOrderPaidAdmin } = await import("@/lib/admin/fns/orders");
      const result = await markOrderPaidAdmin({
        data: { orderId: detail.id, note: note.trim() || null },
      });

      if (result.reason === "marked") {
        toast.success(`已標記為已收款（訂單 ${result.order_no}）`);
      } else if (result.reason === "already_paid") {
        toast.info(`訂單 ${result.order_no} 已經是已收款狀態，沒有重複處理`);
      } else if (result.reason === "order_not_pending") {
        toast.error(
          `訂單 ${result.order_no ?? ""} 目前不是待處理狀態（可能已出貨、取消或付款失敗），` +
            "無法標記為已收款",
        );
      } else {
        toast.error("找不到這張訂單，可能已被刪除或編號有誤");
      }

      setConfirmOpen(false);
      setNote("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "標記失敗，請稍後再試");
      return;
    } finally {
      setMarking(false);
    }
    await refresh();
  }

  /**
   * 刪除未付款／已取消的訂單（0035，admin_delete_order()）。成功之後回到列表：
   * 這張訂單已經不存在了，留在內頁只會顯示「找不到」。
   */
  async function submitDelete() {
    setDeleting(true);
    try {
      const { deleteAdminOrder } = await import("@/lib/admin/fns/orders");
      const result = await deleteAdminOrder({ data: { orderId: detail.id } });

      if (result.reason === "deleted") {
        toast.success(`已刪除訂單 ${result.order_no}`);
        setDeleteConfirmOpen(false);
        // 列表的快取裡還有這一張，清掉才不會回去時先閃一下已刪的單。
        router.clearCache({ filter: (m) => m.routeId === "/admin/_shell/orders" });
        await navigate({ to: "/admin/orders", search });
      } else if (result.reason === "order_is_paid") {
        toast.error(`訂單 ${result.order_no ?? ""} 已經收到款項，不能刪除——請改用「封存」`);
      } else if (result.reason === "has_inventory_sale") {
        toast.error(`訂單 ${result.order_no ?? ""} 已轉入銷售紀錄，不能刪除，請改用封存`);
      } else {
        toast.error("找不到這張訂單，可能已經被刪除");
        await navigate({ to: "/admin/orders", search });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  /** 封存／取消封存一張已付款訂單（0035，admin_archive_order()）。 */
  async function submitArchive(archived: boolean) {
    setArchiving(true);
    try {
      const { archiveAdminOrder } = await import("@/lib/admin/fns/orders");
      const result = await archiveAdminOrder({ data: { orderId: detail.id, archived } });

      if (result.reason === "order_not_found") {
        toast.error("找不到這張訂單，可能已經被刪除");
        await navigate({ to: "/admin/orders", search });
        return;
      }

      toast.success(
        archived ? `已封存訂單 ${result.order_no}` : `已取消封存訂單 ${result.order_no}`,
      );
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失敗，請稍後再試");
    } finally {
      setArchiving(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <BackToList />
        <h1 className="flex flex-wrap items-center gap-2 text-lg font-medium">
          <Landmark className="h-5 w-5" aria-hidden="true" />
          <span className="font-mono">{detail.order_no}</span>
          {detail.archived_at ? (
            <Badge variant="outline" className="font-normal">
              已封存
            </Badge>
          ) : null}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusBadgeVariant(detail.status)}>
            {STATUS_LABEL[detail.status] ?? detail.status}
          </Badge>
          <Badge variant={paymentStatusBadgeVariant(detail.payment_status)}>
            {PAYMENT_STATUS_LABEL[detail.payment_status] ?? detail.payment_status}
          </Badge>
          <span className="text-sm text-muted-foreground">
            下單於 {formatTaipeiDateTime(detail.created_at)}
            {detail.paid_at ? `・付款於 ${formatTaipeiDateTime(detail.paid_at)}` : ""}
            {detail.shipped_at ? `・出貨於 ${formatTaipeiDateTime(detail.shipped_at)}` : ""}
            {detail.completed_at ? `・完成於 ${formatTaipeiDateTime(detail.completed_at)}` : ""}
          </span>
        </div>
      </div>

      <Section title="訂購人">
        <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">姓名</dt>
          <dd>{detail.customer_name}</dd>
          <dt className="text-muted-foreground">電話</dt>
          <dd>
            {detail.customer_phone ? (
              <a
                className="underline-offset-2 hover:underline"
                href={telHref(detail.customer_phone)}
              >
                {detail.customer_phone}
              </a>
            ) : (
              "（未填）"
            )}
          </dd>
          <dt className="text-muted-foreground">信箱</dt>
          <dd className="break-all">
            {detail.customer_email ? (
              <a
                className="underline-offset-2 hover:underline"
                href={`mailto:${detail.customer_email}`}
              >
                {detail.customer_email}
              </a>
            ) : (
              "（未填）"
            )}
          </dd>
          {detail.note ? (
            <>
              <dt className="text-muted-foreground">客人備註</dt>
              <dd className="whitespace-pre-wrap">{detail.note}</dd>
            </>
          ) : null}
        </dl>
      </Section>

      <Section title="收件方式">
        <p className="text-sm">{shippingMethodLabel(detail.shipping_method)}</p>
        {detail.addresses.map((a) => (
          <dl
            key={a.type}
            className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1 rounded-md border border-border p-3 text-sm"
          >
            <dt className="text-muted-foreground">收件人</dt>
            <dd>{a.recipient}</dd>
            <dt className="text-muted-foreground">收件人電話</dt>
            <dd>
              {a.phone ? (
                <a className="underline-offset-2 hover:underline" href={telHref(a.phone)}>
                  {a.phone}
                </a>
              ) : (
                "—"
              )}
            </dd>
            {a.cvs_store_name || a.cvs_store_id ? (
              <>
                <dt className="text-muted-foreground">取貨門市</dt>
                <dd>
                  {a.cvs_store_name ?? ""}
                  {a.cvs_store_id ? `（${a.cvs_store_id}）` : ""}
                </dd>
                {a.cvs_address ? (
                  <>
                    <dt className="text-muted-foreground">門市地址</dt>
                    <dd>{a.cvs_address}</dd>
                  </>
                ) : null}
              </>
            ) : formatHomeAddress(a) ? (
              <>
                <dt className="text-muted-foreground">地址</dt>
                <dd>{formatHomeAddress(a)}</dd>
              </>
            ) : null}
          </dl>
        ))}
      </Section>

      <Section title="發票">
        {detail.invoice ? (
          <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">類型</dt>
            <dd>{invoiceTypeLabel(detail.invoice.invoice_type)}</dd>
            {detail.invoice.tax_id ? (
              <>
                <dt className="text-muted-foreground">統一編號</dt>
                <dd className="font-mono">{detail.invoice.tax_id}</dd>
              </>
            ) : null}
            {detail.invoice.company_title ? (
              <>
                <dt className="text-muted-foreground">抬頭</dt>
                <dd>{detail.invoice.company_title}</dd>
              </>
            ) : null}
            {detail.invoice.carrier_number ? (
              <>
                <dt className="text-muted-foreground">載具</dt>
                <dd className="font-mono">
                  {detail.invoice.carrier_type
                    ? `${carrierTypeLabel(detail.invoice.carrier_type)} `
                    : ""}
                  {detail.invoice.carrier_number}
                </dd>
              </>
            ) : null}
            {detail.invoice.love_code ? (
              <>
                <dt className="text-muted-foreground">捐贈碼</dt>
                <dd className="font-mono">{detail.invoice.love_code}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">這張訂單沒有發票資料。</p>
        )}
      </Section>

      <Section title="品項">
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>品項</TableHead>
                <TableHead className="w-16 text-right">數量</TableHead>
                <TableHead className="w-24 text-right">單價</TableHead>
                <TableHead className="w-24 text-right">小計</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <span>{item.name.zh}</span>
                    {item.session_title ? (
                      <span className="block text-xs text-muted-foreground">
                        場次：{item.session_title.zh}
                        {item.session_starts_at
                          ? `・${formatTaipeiDateTime(item.session_starts_at)}`
                          : ""}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(item.unit_price)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(item.subtotal)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      <div className="grid gap-6 sm:grid-cols-2">
        <Section title="金額">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
            <dt className="text-muted-foreground">小計</dt>
            <dd className="text-right">{money(detail.subtotal)}</dd>
            <dt className="text-muted-foreground">運費</dt>
            <dd className="text-right">{money(detail.shipping_fee)}</dd>
            <dt className="text-muted-foreground">折扣</dt>
            <dd className="text-right">−{money(detail.discount)}</dd>
            <dt className="text-muted-foreground">推薦碼</dt>
            <dd className="text-right">
              {detail.referral_code
                ? `${detail.referral_code}（${detail.referral_discount_percent ?? "—"}%）`
                : "—"}
            </dd>
            <dt className="font-medium">總計</dt>
            <dd className="text-right font-medium">{money(detail.total)}</dd>
          </dl>
        </Section>

        <Section title="付款">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">付款方式</dt>
            <dd>{paymentMethodLabel(detail.payment_method)}</dd>
            {detail.payment_method === "transfer" ? (
              <>
                <dt className="text-muted-foreground">回報末五碼</dt>
                <dd className="font-mono">{detail.remittance_last5 ?? "（尚未回報）"}</dd>
                <dt className="text-muted-foreground">回報時間</dt>
                <dd>{formatTaipeiDateTime(detail.remittance_reported_at)}</dd>
              </>
            ) : null}
          </dl>
        </Section>
      </div>

      {detail.payment_status === "paid" ? (
        <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          這張訂單已經是已收款狀態。
        </p>
      ) : detail.payment_method === "transfer" || detail.payment_method === null ? (
        <section className="space-y-2 rounded-md border border-border p-3">
          <h2 className="text-sm font-medium">標記已收款</h2>
          <p className="text-xs text-muted-foreground">
            {detail.payment_method === "transfer"
              ? "對過銀行對帳單、確認這筆款項真的入帳之後才按下面這顆按鈕。"
              : "這張訂單由店家另行聯繫付款——確認款項已經用約定的方式收到之後才按下面這顆按鈕。"}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="mark-paid-note">備註（選填）</Label>
            <Textarea
              id="mark-paid-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：對到 9/3 01:15 那筆"
              rows={2}
            />
          </div>
          <Button onClick={() => setConfirmOpen(true)} disabled={marking}>
            標記已收款
          </Button>
        </section>
      ) : (
        // payment_method 是 card／atm／cvs_cod／test_paid／free 卻還卡在待付款：
        // 正常情況下這幾種一律由金流商 webhook 自動結清，卡住多半代表 webhook
        // 沒送到或送失敗。這裡不給「標記已收款」的入口——按下去等於在沒有金流商
        // 佐證的情況下宣稱收到錢。
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          這張訂單透過線上金流付款，但還沒收到付款成功的通知。請到金流商後台核對，
          不建議在這裡手動標記——這一頁的「標記已收款」只服務匯款與店家另行聯繫付款 這兩種情況。
        </p>
      )}

      <FulfillmentSection
        detail={detail}
        busy={fulfilling}
        onRequest={(action) => setFulfillAction(action)}
      />

      {/* 刪除／封存（0035）。分界是 payment_status，與 admin_delete_order()
          在資料庫那一層擋已付款訂單的條件一致。 */}
      {detail.payment_status === "paid" ? (
        <section className="space-y-2 rounded-md border border-border p-3">
          <h2 className="text-sm font-medium">{detail.archived_at ? "取消封存" : "封存"}</h2>
          <p className="text-xs text-muted-foreground">
            已付款訂單不能刪除，封存是唯一的「從列表移掉」方式——不動名額、
            不動任何紀錄，隨時可以取消封存復原。
          </p>
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={archiving}
            onClick={() => void submitArchive(!detail.archived_at)}
          >
            {detail.archived_at ? (
              <ArchiveRestore className="h-4 w-4" />
            ) : (
              <Archive className="h-4 w-4" />
            )}
            {archiving ? "處理中…" : detail.archived_at ? "取消封存" : "封存"}
          </Button>
        </section>
      ) : (
        <section className="space-y-2 rounded-md border border-destructive/40 p-3">
          <h2 className="text-sm font-medium text-destructive">刪除訂單</h2>
          <p className="text-xs text-muted-foreground">
            會連同這張訂單的報名一起移除，並釋放場次名額與庫存保留——這個動作
            無法復原。已經轉入銷售紀錄的訂單無法刪除（改用封存）。
          </p>
          <Button
            variant="destructive"
            className="gap-1.5"
            disabled={deleting}
            onClick={() => setDeleteConfirmOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            刪除訂單
          </Button>
        </section>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要標記已收款？</AlertDialogTitle>
            <AlertDialogDescription>
              {`訂單 ${detail.order_no}，金額 ${money(detail.total)}` +
                (detail.remittance_last5 ? `，客人回報末五碼 ${detail.remittance_last5}` : "") +
                "。" +
                (detail.payment_method === "transfer"
                  ? "請先確認銀行對帳單上真的有這一筆"
                  : "請先確認款項真的已經用約定的方式收到") +
                "——這個動作無法在這一頁復原。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={marking}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={marking}
              onClick={(e) => {
                e.preventDefault();
                void submitMarkPaid();
              }}
            >
              {marking ? "標記中…" : "確定標記已收款"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={fulfillAction !== null}
        onOpenChange={(open) => {
          if (!open && !fulfilling) setFulfillAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {fulfillAction ? `確定要${ACTION_BUTTON_LABEL[fulfillAction]}？` : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {fulfillAction
                ? confirmDescription(fulfillAction, detail.order_no, detail.customer_email)
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={fulfilling}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={fulfilling}
              onClick={(e) => {
                e.preventDefault();
                if (fulfillAction) void submitFulfillment(fulfillAction);
              }}
            >
              {fulfilling
                ? "處理中…"
                : fulfillAction
                  ? `確定${ACTION_BUTTON_LABEL[fulfillAction]}`
                  : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要刪除這張訂單嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              {`訂單 ${detail.order_no}，金額 ${money(detail.total)}。`}
              刪除後會連同這張訂單的所有報名一起移除，場次名額與庫存保留會自動釋放
              ——這個動作無法復原。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void submitDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "刪除中…" : "確定刪除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

const FULFILLMENT_HINT: Record<FulfillmentAction, string> = {
  ship: "包裹交給物流或超商之後再按。會改訂單狀態、記下出貨時間，並自動寄出貨通知信給客人。",
  pickup: "客人到門市取走之後再按。訂單會直接變成「已完成」，不會寄信通知客人。",
  complete: "確認客人已經收到包裹之後再按。不會寄信通知客人。",
};

/**
 * 出貨／取貨／完成的區塊。只在 availableFulfillmentAction() 有答案時出現——
 * 未付款、純票券、已完成、已取消都不顯示（同一個判斷，伺服器那句 conditional
 * update 會再擋一次）。
 */
function FulfillmentSection({
  detail,
  busy,
  onRequest,
}: {
  detail: AdminOrderDetail;
  busy: boolean;
  onRequest: (action: FulfillmentAction) => void;
}) {
  const action = availableFulfillmentAction(detail);
  if (!action) return null;
  return (
    <section className="space-y-2 rounded-md border border-border p-3">
      <h2 className="text-sm font-medium">{ACTION_BUTTON_LABEL[action]}</h2>
      <p className="text-xs text-muted-foreground">{FULFILLMENT_HINT[action]}</p>
      <Button className="gap-1.5" disabled={busy} onClick={() => onRequest(action)}>
        <PackageCheck className="h-4 w-4" />
        {ACTION_BUTTON_LABEL[action]}
      </Button>
    </section>
  );
}
