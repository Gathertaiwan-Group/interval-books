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
 * 成功後呼叫 onRemoved：呼叫端從本地名單過濾掉這一列——不整個重打 listSessionRoster()
 * （那會多寫一筆查閱紀錄），再 router.invalidate() 讓列表的「報名」「名額」欄是新的數字。
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

export type RosterRow = Awaited<ReturnType<typeof listSessionRoster>>["rows"][number];

type Props = {
  rows: RosterRow[];
  /** 移除成功（reason === "deleted"）之後。 */
  onRemoved: (registrationId: string) => Promise<void>;
};

export function SessionRosterTable({ rows, onRemoved }: Props) {
  const [removeTarget, setRemoveTarget] = useState<RosterRow | null>(null);
  const [removing, setRemoving] = useState(false);

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
                <TableHead className="w-24">付款</TableHead>
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
                    <Badge variant={r.on_roster ? "default" : "secondary"}>
                      {r.on_roster ? "已付款" : r.payment_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.notice_ack_at ? "已同意" : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
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
              {removeTarget?.on_roster ? (
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
