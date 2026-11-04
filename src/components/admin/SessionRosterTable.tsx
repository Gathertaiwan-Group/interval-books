/**
 * 報名名單的表格＋「移除單筆報名」確認框（0035）。SessionRosterPage.tsx 的下半部
 * （2026-10-25 從 _shell.registrations.tsx 的名單彈窗搬出來，行為不變）。
 *
 * ── 移除單筆報名（0035）───────────────────────────────────────────────────
 * 每一列一顆「移除」，呼叫 deleteAdminRegistration()（admin_delete_registration()，
 * 掛 adminFnMiddleware——見 src/lib/admin/fns/event-registrations.ts 的說明）。名額由
 * 資料庫那一支自動還回去，這裡不用另外算。已付款的列也允許移除（user 決定），確認
 * 對話框用這一列既有的 payment_status／on_roster（listSessionRoster() 早就回傳了）
 * 明確示警「這位已經付過錢」，不需要等 RPC 回來才知道。
 *
 * ── 現場付款（0056）────────────────────────────────────────────────────────
 * 現場付款、還沒收到錢的列標「現場付款・未收款」，並給一顆「標記已收款」（admin，或有
 * event.onsite.collect 的門市人員，0057）。呼叫 markOnsiteOrderPaidStaff()——它在 server 端
 * 驗權限與「只限 onsite」，收款本身仍是 admin_mark_order_paid()，一張訂單一次；
 * 同一張單的其他參加者會在重抓之後一起變成已付款。
 * 活動結束後仍未付款的不會被自動取消（業主決定），名單上會一直標「未收款（現場付款）」，
 * 由店員手動標記已收款或請 admin 刪除訂單。
 *
 * 成功後呼叫 onRemoved：呼叫端 router.invalidate()，名單頁的 loader 重抓名單（2026-10-26
 * 起不寫查閱紀錄，重抓沒有副作用），列表的「報名」「名額」欄也是新的數字。
 */
import { useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import type { listSessionRoster } from "@/lib/admin/fns/event-registrations";
import { money, ONSITE_UNPAID_LABEL, showOnsiteUnpaid } from "@/lib/admin/order-labels";

export type RosterRow = Awaited<ReturnType<typeof listSessionRoster>>[number];

type Props = {
  rows: RosterRow[];
  /** 移除成功（reason === "deleted"）之後。 */
  onRemoved: (registrationId: string) => Promise<void>;
  /**
   * 0056／0057：顯示現場付款的「標記已收款」。admin 或有 event.onsite.collect 的 staff。
   * 只控制畫面；擋人的是 markOnsiteOrderPaidStaff 的 staffFnMiddleware＋onsite 檢查。
   */
  canMarkPaid?: boolean;
  /** 0056：標記已收款成功（或發現早就付過）之後。 */
  onMarkedPaid?: () => Promise<void>;
};

/** 0056：這一列要不要標「現場付款・未收款」。 */
function rowOnsiteUnpaid(r: RosterRow): boolean {
  // 0058：view 的 onsite_unpaid 是第一來源；訂單層那三欄是同一件事的備援（讀不到 view 欄位時）。
  if (r.onsite_unpaid) return true;
  return showOnsiteUnpaid({
    payment_method: r.payment_method,
    payment_status: r.payment_status,
    status: r.order_status ?? "",
  });
}

export function SessionRosterTable({ rows, onRemoved, canMarkPaid = false, onMarkedPaid }: Props) {
  const [removeTarget, setRemoveTarget] = useState<RosterRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [payTarget, setPayTarget] = useState<RosterRow | null>(null);
  const [marking, setMarking] = useState(false);

  async function handleMarkPaid() {
    if (!payTarget) return;
    setMarking(true);
    try {
      // 0057：走 staff 版（event.onsite.collect；admin 自動有），server 端再驗一次是 onsite。
      const { markOnsiteOrderPaidStaff } = await import("@/lib/admin/fns/onsite-collect");
      const result = await markOnsiteOrderPaidStaff({
        data: { orderId: payTarget.order_id, note: "現場付款（報名名單標記）" },
      });
      if (result.reason === "marked") {
        toast.success(`訂單 ${payTarget.order_no} 已標記為已收款，發票會接著開立`);
      } else if (result.reason === "already_paid") {
        toast.info("這張訂單已經是已收款狀態");
      } else if (result.reason === "not_onsite") {
        toast.error("這張訂單不是現場付款，請由店長在訂單頁處理");
      } else {
        toast.error("這張訂單無法標記（可能已取消或不存在）");
      }
      setPayTarget(null);
      await onMarkedPaid?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "標記失敗，請稍後再試");
    } finally {
      setMarking(false);
    }
  }

  async function handleRemoveRegistration() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      const { deleteAdminRegistration } = await import("@/lib/admin/fns/event-registrations");
      const result = await deleteAdminRegistration({
        data: { registrationId: removeTarget.registration_id },
      });
      if (result.reason === "deleted") {
        toast.success("已移除這筆報名，名額已還原");
        setRemoveTarget(null);
        await onRemoved(removeTarget.registration_id);
      } else {
        toast.error("找不到這筆報名，可能已經被移除");
        setRemoveTarget(null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "移除失敗，請稍後再試");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">尚無報名。</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>姓名</TableHead>
                <TableHead>信箱</TableHead>
                <TableHead>電話</TableHead>
                <TableHead>訂單</TableHead>
                <TableHead className="w-32">付款</TableHead>
                <TableHead className="w-24">注意事項</TableHead>
                <TableHead className="w-24 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={r.registration_id}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="break-all">
                    {r.email ? (
                      <a className="underline-offset-2 hover:underline" href={`mailto:${r.email}`}>
                        {r.email}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">（未填）</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {r.phone ? (
                      <a
                        className="underline-offset-2 hover:underline"
                        href={`tel:${r.phone.replace(/[^\d+]/g, "")}`}
                      >
                        {r.phone}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">（未填）</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {r.order_no}
                  </TableCell>
                  <TableCell>
                    {rowOnsiteUnpaid(r) ? (
                      <Badge className="whitespace-nowrap bg-amber-600 text-white hover:bg-amber-600">
                        {ONSITE_UNPAID_LABEL}
                      </Badge>
                    ) : (
                      <Badge variant={r.payment_status === "paid" ? "default" : "secondary"}>
                        {r.payment_status === "paid" ? "已付款" : r.payment_status}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.notice_ack_at ? "已同意" : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {canMarkPaid && rowOnsiteUnpaid(r) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="whitespace-nowrap"
                          onClick={() => setPayTarget(r)}
                        >
                          標記已收款
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 text-destructive hover:text-destructive"
                        onClick={() => setRemoveTarget(r)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        移除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 0056：現場付款標記已收款。整張訂單一次（同單的其他參加者一起變已付款）。 */}
      <AlertDialog open={payTarget !== null} onOpenChange={(open) => !open && setPayTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定已在現場收到「{payTarget?.name}」的款項？</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block">
                {`訂單 ${payTarget?.order_no ?? ""}，金額 ${money(payTarget?.order_total ?? 0)}。`}
                整張訂單會一起標記為已收款（同一張單的其他參加者也是），接著寄出付款成功信與報名成功信，並開立發票。這個動作無法在這一頁復原。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={marking}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={marking}
              onClick={(e) => {
                e.preventDefault();
                void handleMarkPaid();
              }}
            >
              {marking ? "標記中…" : "確定已收款"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 移除單筆報名（0035）。已付款的列（on_roster）在這裡明確示警——這一列的
          payment_status／on_roster 從 listSessionRoster() 就有了，不用等 RPC
          回來才知道要不要警告。 */}
      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要移除「{removeTarget?.name}」的報名嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              {/* 0059：用實際的付款狀態判斷——現場付款未收款的人在簽到表上（on_roster），
                  但沒付過錢，不該跳退款警告。 */}
              {removeTarget?.payment_status === "paid" ? (
                <span className="block font-medium text-destructive">
                  警告：這位已經付過錢（訂單 {removeTarget?.order_no}）。移除只會刪掉報名
                  紀錄並還原名額，不會辦理退款——退款要另外處理。
                </span>
              ) : null}
              <span className="block">
                移除後這個位子的名額會立即還給場次，其他人就報得到名。這個動作無法復原。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={(e) => {
                e.preventDefault();
                void handleRemoveRegistration();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? "移除中…" : "確定移除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
