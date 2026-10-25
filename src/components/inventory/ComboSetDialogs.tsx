/**
 * 套餐這一頁剩下的對話框：刪除的二次確認。
 *
 * 2026-10-25 起詳情與新增／編輯是內頁（/admin/inventory-combos/$id、/$id/edit、/new），
 * 不再是彈窗；確認類的小框照舊留在列表上。
 *
 * ⚠️ 只有刪除要按兩次。上下架按錯了再按一次就回來了；審核通過不問（那是這一頁最常
 *    做的事，每次都跳對話框只會訓練出「看到就按確定」），退回由 ApprovalActions
 *    自己問。
 */
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
import type { AdminComboSetRow } from "@/server/repos/inv-combos";

type Props = {
  deleting: AdminComboSetRow | null;
  setDeleting: (v: AdminComboSetRow | null) => void;
  onConfirmDelete: (row: AdminComboSetRow) => void;
};

export function ComboSetDialogs({ deleting, setDeleting, onConfirmDelete }: Props) {
  return (
    <>
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              刪除套餐「{deleting?.name}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              這個動作無法復原。已經賣出過的套餐刪不掉 —— 資料庫會擋下來並告訴你賣了幾份，
              那種情況請改成下架，銷售紀錄才留得住。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const pending = deleting;
                setDeleting(null);
                if (pending) onConfirmDelete(pending);
              }}
            >
              確認刪除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
