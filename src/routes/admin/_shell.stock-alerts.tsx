/**
 * /admin/stock-alerts —— 賣超告警
 *
 * 0011 建了 public.stock_oversold_alerts，但沒有給它出口：告警寫進去之後沒有任何
 * 地方看得到。一張沒有人看的告警表跟沒有告警是一樣的，所以這一頁把它接出來。
 *
 * 兩個來源，都是**刻意放行**的結果，不是 bug：
 *   online_commit —— 網站付款成功時庫存不夠。錢已經收了，這條路徑不能失敗
 *                    （0011 §7），所以允許負庫存並留一列在這裡。
 *   pos_override  —— 店員在櫃檯按了「客人就站在這裡，先賣」。
 *
 * 兩者的共同點是：架上的數字與資料庫的數字對不起來，而且**只有人能把它們對回去**。
 * 所以這一頁能做的唯一動作是「我處理完了，這是我做了什麼」—— 系統不會自己改庫存，
 * 那要走進銷存的盤點流程。
 *
 * ⚠️ 標記已處理需要 approve_stock_adjustments 權限（見 lib/admin/fns/pos.ts）。
 *    看得到不等於改得動：宣告「帳現在對了」是一個需要授權的動作。
 */
import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { StockAlertRow } from "@/server/repos/inv-sales";
import { formatTaipeiDateTime } from "@/lib/taipei-time";

type Status = "open" | "resolved" | "all";

export const Route = createFileRoute("/admin/_shell/stock-alerts")({
  loader: async () => {
    const { listStockAlerts } = await import("@/lib/admin/fns/pos");
    return { alerts: await listStockAlerts({ data: { status: "open" } }) };
  },
  head: () => ({ meta: [{ title: "賣超告警｜小時光書店後台" }] }),
  component: StockAlertsPage,
});

function StockAlertsPage() {
  const { alerts: initial } = Route.useLoaderData();
  const { user } = Route.useRouteContext();

  const [status, setStatus] = useState<Status>("open");
  const [alerts, setAlerts] = useState<StockAlertRow[]>(initial);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState<StockAlertRow | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // 側欄看得到這一頁不代表按鈕按得下去。這個旗標只控制畫面 —— 真正擋人的是
  // staffFnMiddleware("approve_stock_adjustments")，它會重讀一次 staff_permissions。
  const canResolve = user.permissions.includes("approve_stock_adjustments");

  const load = useCallback(async (next: Status) => {
    setLoading(true);
    try {
      const { listStockAlerts } = await import("@/lib/admin/fns/pos");
      setAlerts(await listStockAlerts({ data: { status: next } }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "告警讀取失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  const isInitial = status === "open" && alerts === initial;
  useEffect(() => {
    if (isInitial) return;
    void load(status);
  }, [status, isInitial, load]);

  async function submitResolution() {
    if (!resolving) return;
    setSaving(true);
    try {
      const { resolveStockAlert } = await import("@/lib/admin/fns/pos");
      const result = await resolveStockAlert({
        data: { alert_id: resolving.alert_id, note: note.trim() },
      });
      if (result.resolved) {
        toast.success("已標記處理完成");
      } else {
        // update … .is("resolved_at", null) 回 0 列 = 別人先按了。
        toast.info("這一筆已經有人處理過了");
      }
      setResolving(null);
      setNote("");
      await load(status);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "標記失敗");
    } finally {
      setSaving(false);
    }
  }

  const openCount = alerts.filter((a) => a.resolved_at === null).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <TriangleAlert className="h-5 w-5" aria-hidden="true" />
          賣超告警
        </h1>
        {status !== "resolved" && openCount > 0 ? (
          <Badge variant="destructive" className="font-normal">
            {openCount} 筆待處理
          </Badge>
        ) : null}
      </div>

      <p className="max-w-3xl text-sm text-muted-foreground">
        這裡的每一筆都是「賣掉了，但架上的數字不夠」。系統不會自己修庫存 ——
        請去盤點、或聯絡客人，處理完再回來標記，並寫下你做了什麼。
      </p>

      <Tabs value={status} onValueChange={(v) => setStatus(v as Status)}>
        <TabsList>
          <TabsTrigger value="open">待處理</TabsTrigger>
          <TabsTrigger value="resolved">已處理</TabsTrigger>
          <TabsTrigger value="all">全部</TabsTrigger>
        </TabsList>
      </Tabs>

      {loading ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-border">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : alerts.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border">
          <CheckCircle2 className="h-6 w-6 text-emerald-600" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            {status === "open" ? "沒有待處理的賣超" : "沒有符合的紀錄"}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {alerts.map((a) => (
            <li
              key={a.alert_id}
              className={`rounded-md border p-4 ${
                a.resolved_at ? "border-border bg-muted/30" : "border-destructive/40"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{a.product_name}</p>
                    <Badge
                      variant={a.source === "pos_override" ? "destructive" : "default"}
                      className="font-normal"
                    >
                      {a.source === "pos_override" ? "櫃檯強制放行" : "網站付款後庫存不足"}
                    </Badge>
                    {a.resolved_at ? (
                      <Badge variant="outline" className="font-normal">
                        已處理
                      </Badge>
                    ) : null}
                  </div>

                  <p className="text-sm text-muted-foreground">
                    差{" "}
                    <span className="font-medium text-foreground tabular-nums">{a.shortfall}</span>{" "}
                    件 ／目前庫存{" "}
                    <span className="font-medium text-foreground tabular-nums">
                      {a.current_stock}
                    </span>
                    {/* 分隔符要寫成字串運算式：單獨一行的全形空白會被 JSX 當成
                        純空白節點修掉，庫存數字就會直接黏在時間戳上（「庫存 02026/8/15」）。 */}
                    {" ・ "}
                    {formatTaipeiDateTime(a.created_at)}
                  </p>

                  {a.order_id ? (
                    <p className="text-sm text-muted-foreground">
                      對應訂單：{a.customer_name ?? "—"}（{a.order_status ?? "—"}）
                      <span className="ml-1.5 font-mono text-xs">{a.order_id}</span>
                    </p>
                  ) : null}

                  {a.resolved_at ? (
                    <p className="rounded-md bg-background px-2.5 py-1.5 text-sm">
                      <span className="text-muted-foreground">
                        {formatTaipeiDateTime(a.resolved_at)}
                        {/* 同上：行首的全形空白會被 JSX 修掉，時間戳會黏住 email。 */}
                        {" ・ "}
                        {a.resolved_by_email ?? "—"}：
                      </span>{" "}
                      {a.resolution_note}
                    </p>
                  ) : null}
                </div>

                {a.resolved_at === null ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setResolving(a);
                      setNote("");
                    }}
                    disabled={!canResolve}
                    title={canResolve ? undefined : "需要 approve_stock_adjustments 權限"}
                  >
                    標記已處理
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!canResolve ? (
        <p className="text-xs text-muted-foreground">
          你可以看到告警，但沒有「標記已處理」的權限（approve_stock_adjustments）。 請找管理員授權。
        </p>
      ) : null}

      <Dialog open={resolving !== null} onOpenChange={(open) => !open && setResolving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-base">標記已處理</DialogTitle>
            <DialogDescription>
              {resolving
                ? `「${resolving.product_name}」差 ${resolving.shortfall} 件。寫下你怎麼處理的 —— 之後對帳的人只看得到這一句話。`
                : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="alert-note">處理說明</Label>
            <Textarea
              id="alert-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：已盤點，庫存數字補正為 3；或：已聯絡客人改期，訂單取消退款"
              rows={3}
              maxLength={500}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setResolving(null)} disabled={saving}>
              取消
            </Button>
            <Button onClick={submitResolution} disabled={saving || note.trim().length === 0}>
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              確認已處理
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
