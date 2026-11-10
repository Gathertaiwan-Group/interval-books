/**
 * 賣超告警卡片 —— 後台首頁（今日待辦）的一塊，也是門市人員 /admin/stock-alerts 的本體。
 *
 * 2026-11-10 業主要求把原本獨立的「賣超告警」頁併進後台首頁：標題旁兩個件數徽章（網站付款
 * 後庫存不足／櫃檯強制放行），列出最急的前 5 筆，「看全部（N）」在卡片內展開完整清單
 * （含原頁的 待處理／已處理／全部 分頁）。沒有未處理的告警時只顯示一行「庫存帳都對得上」。
 *
 * 資料與動作全部沿用原頁：listStockAlerts（staffFnMiddleware + readOnly）與
 * resolveStockAlert（staffFnMiddleware("approve_stock_adjustments")），在 lib/admin/fns/pos.ts。
 * 一筆告警唯一能做的事是「我處理完了，這是我做了什麼」—— 系統不會自己改庫存。
 *
 * ⚠️ 標記已處理需要 approve_stock_adjustments（canResolve 只控制畫面，真正擋人的是 server fn）。
 */
import { useEffect, useRef, useState } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { needsPermissionHint } from "@/lib/admin/permission-labels";
import {
  STOCK_ALERTS_ANCHOR,
  STOCK_ALERTS_TOP_N,
  countOpenAlertsBySource,
  sortStockAlertsByUrgency,
  stockAlertSourceLabel,
} from "@/lib/admin/stock-alerts";

type Status = "open" | "resolved" | "all";

type Props = {
  /** 待處理的告警（loader 抓的）。null＝讀取失敗，畫面說讀取失敗，不當成 0。 */
  openAlerts: StockAlertRow[] | null;
  canResolve: boolean;
  /** 一進來就展開完整清單（門市人員的 /admin/stock-alerts 用）。 */
  defaultExpanded?: boolean;
};

export function StockAlertsPanel({ openAlerts, canResolve, defaultExpanded = false }: Props) {
  const router = useRouter();
  const rootRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [status, setStatus] = useState<Status>("open");
  // 展開後切到「已處理／全部」才另外抓；「待處理」一律用 loader 那一份（寫入後 invalidate 會換新）。
  // rows=null：那一籤讀取失敗（畫面說讀取失敗，不說「沒有紀錄」）。
  const [other, setOther] = useState<{ status: Status; rows: StockAlertRow[] | null } | null>(null);
  // 快速連點分頁時，只採用最後一次請求的回應（晚回來的舊請求不可以蓋掉新的）。
  const reqSeq = useRef(0);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState<StockAlertRow | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // 從舊網址 /admin/stock-alerts 轉過來、或點「未處理的賣超」待辦卡，都會帶 #stock-alerts：
  // 自動展開並捲到這張卡片（同一頁內點也算，所以看 router 的 hash 而不是只在掛載時看一次）。
  const hash = useRouterState({ select: (s) => s.location.hash });
  useEffect(() => {
    if (hash.replace(/^#/, "") === STOCK_ALERTS_ANCHOR) {
      setExpanded(true);
      rootRef.current?.scrollIntoView({ block: "start" });
    }
  }, [hash]);

  async function loadStatus(next: Status) {
    const seq = ++reqSeq.current;
    setStatus(next);
    if (next === "open") {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { listStockAlerts } = await import("@/lib/admin/fns/pos");
      const rows = await listStockAlerts({ data: { status: next } });
      if (seq === reqSeq.current) setOther({ status: next, rows });
    } catch (err) {
      if (seq === reqSeq.current) setOther({ status: next, rows: null });
      toast.error(err instanceof Error ? err.message : "告警讀取失敗");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  async function submitResolution() {
    if (!resolving) return;
    setSaving(true);
    try {
      const { resolveStockAlert } = await import("@/lib/admin/fns/pos");
      const result = await resolveStockAlert({
        data: { alert_id: resolving.alert_id, note: note.trim() },
      });
      if (result.resolved) toast.success("已標記處理完成");
      else toast.info("這一筆已經有人處理過了"); // update … .is("resolved_at", null) 回 0 列
      setResolving(null);
      setNote("");
      // 沒有樂觀更新：讓 loader 重跑換掉「待處理」那一份；其他分頁重抓。
      await router.invalidate();
      if (status !== "open") await loadStatus(status);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "標記失敗");
    } finally {
      setSaving(false);
    }
  }

  const failed = openAlerts === null;
  const open = sortStockAlertsByUrgency(openAlerts ?? []);
  const counts = countOpenAlertsBySource(open);
  const otherFailed = status !== "open" && other?.status === status && other.rows === null;
  const listed: StockAlertRow[] =
    status === "open"
      ? open
      : other?.status === status && other.rows
        ? sortStockAlertsByUrgency(other.rows)
        : [];
  const rows = expanded ? listed : open.slice(0, STOCK_ALERTS_TOP_N);
  const quiet = !failed && counts.total === 0 && !expanded;

  return (
    <section ref={rootRef} id={STOCK_ALERTS_ANCHOR} className="scroll-mt-20">
      <Card className={counts.total > 0 || failed ? "border-destructive/40" : undefined}>
        <CardHeader className="space-y-0 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <TriangleAlert className="h-4 w-4" aria-hidden="true" />
              賣超告警
            </CardTitle>
            {counts.online > 0 ? (
              <Badge variant="destructive" className="font-normal">
                網站付款 {counts.online}
              </Badge>
            ) : null}
            {counts.pos > 0 ? (
              <Badge className="border-transparent bg-amber-500 font-normal text-white hover:bg-amber-500">
                櫃檯放行 {counts.pos}
              </Badge>
            ) : null}
          </div>
          {!quiet ? (
            <p className="pt-1.5 text-sm text-muted-foreground">
              每一筆都是「賣掉了，但架上的數字不夠」。系統不會自己修庫存 ——
              請去盤點、或聯絡客人，處理完再標記並寫下做了什麼。
            </p>
          ) : null}
        </CardHeader>

        <CardContent className="space-y-3">
          {failed ? (
            <p className="text-sm text-destructive">賣超告警讀取失敗，請重新整理。</p>
          ) : quiet ? (
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                庫存帳都對得上，沒有待處理的賣超
              </p>
              <Button
                variant="ghost"
                className="min-h-11 shrink-0 text-sm"
                onClick={() => setExpanded(true)}
              >
                看紀錄
              </Button>
            </div>
          ) : (
            <>
              {expanded ? (
                <Tabs value={status} onValueChange={(v) => void loadStatus(v as Status)}>
                  <TabsList>
                    <TabsTrigger value="open" className="min-h-9">
                      待處理
                    </TabsTrigger>
                    <TabsTrigger value="resolved" className="min-h-9">
                      已處理
                    </TabsTrigger>
                    <TabsTrigger value="all" className="min-h-9">
                      全部
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              ) : null}

              {loading ? (
                <div className="flex h-24 items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : otherFailed ? (
                <p className="py-4 text-center text-sm text-destructive">
                  讀取失敗，請再切換一次分頁或重新整理。
                </p>
              ) : rows.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {status === "open" ? "沒有待處理的賣超" : "沒有符合的紀錄"}
                </p>
              ) : (
                <ul
                  className={`divide-y divide-border rounded-md border border-border ${
                    expanded ? "max-h-[32rem] overflow-y-auto" : ""
                  }`}
                >
                  {rows.map((a) => (
                    <AlertRow
                      key={a.alert_id}
                      alert={a}
                      canResolve={canResolve}
                      onResolve={() => {
                        setResolving(a);
                        setNote("");
                      }}
                    />
                  ))}
                </ul>
              )}

              {!canResolve && counts.total > 0 ? (
                <p className="text-xs text-muted-foreground">
                  你可以看到告警，但沒有「標記已處理」的權限，請找管理員授權。
                </p>
              ) : null}

              {open.length > 0 || expanded ? (
                <Button
                  variant="ghost"
                  className="min-h-11 w-full text-sm"
                  aria-expanded={expanded}
                  onClick={() => {
                    if (expanded) {
                      setExpanded(false);
                      setStatus("open");
                    } else {
                      setExpanded(true);
                    }
                  }}
                >
                  {expanded ? (
                    <>
                      收合 <ChevronUp className="ml-1 h-4 w-4" aria-hidden="true" />
                    </>
                  ) : (
                    <>
                      看全部（{open.length}）
                      <ChevronDown className="ml-1 h-4 w-4" aria-hidden="true" />
                    </>
                  )}
                </Button>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={resolving !== null} onOpenChange={(o) => !o && setResolving(null)}>
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
    </section>
  );
}

function AlertRow({
  alert: a,
  canResolve,
  onResolve,
}: {
  alert: StockAlertRow;
  canResolve: boolean;
  onResolve: () => void;
}) {
  const resolved = a.resolved_at !== null;
  return (
    <li
      className={`flex flex-col gap-2 p-3 sm:flex-row sm:items-start ${resolved ? "bg-muted/30" : ""}`}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{a.product_name}</p>
          <Badge
            variant={a.source === "pos_override" ? "outline" : "destructive"}
            className={`font-normal ${a.source === "pos_override" ? "border-amber-500 text-amber-700 dark:text-amber-400" : ""}`}
          >
            {stockAlertSourceLabel(a.source)}
          </Badge>
          {resolved ? (
            <Badge variant="outline" className="font-normal">
              已處理
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          差 <span className="font-medium text-foreground tabular-nums">{a.shortfall}</span> 件
          ／目前庫存{" "}
          <span className="font-medium text-foreground tabular-nums">{a.current_stock}</span>
          {/* 分隔符寫成字串運算式：單獨一行的全形空白會被 JSX 修掉。 */}
          {" ・ "}
          {formatTaipeiDateTime(a.created_at)}
        </p>
        {a.order_id ? (
          <p className="text-sm text-muted-foreground">
            對應訂單：{a.customer_name ?? "—"}（{a.order_status ?? "—"}）
            <span className="ml-1.5 break-all font-mono text-xs">{a.order_id}</span>
          </p>
        ) : null}
        {resolved ? (
          <p className="rounded-md bg-background px-2.5 py-1.5 text-sm">
            <span className="text-muted-foreground">
              {formatTaipeiDateTime(a.resolved_at as string)}
              {" ・ "}
              {a.resolved_by_email ?? "—"}：
            </span>{" "}
            {a.resolution_note}
          </p>
        ) : null}
      </div>
      {!resolved ? (
        <Button
          variant="outline"
          className="min-h-11 shrink-0 sm:min-h-9"
          onClick={onResolve}
          disabled={!canResolve}
          title={canResolve ? undefined : needsPermissionHint("approve_stock_adjustments")}
        >
          標記已處理
        </Button>
      ) : null}
    </li>
  );
}
