/**
 * 廠商這一頁剩下的對話框：刪除的二次確認。
 *
 * 2026-10-25 起詳情與編輯是內頁（/admin/inventory-vendors/$id、/$id/edit、/new），
 * 不再是彈窗；確認類的小框照舊留在列表上。
 *
 * ⚠️ **刪除的對話框要把話講完。** inv_delete_vendor() 會在還有商品／進貨／退貨單／
 *    入口帳號的時候擋下來，並回一句「解約請把往來狀態改成『已終止』」。這裡把同一件
 *    事先講在前面，而且把那四個數字印出來 —— 「按了才知道不行」是最差的順序，尤其
 *    當正確做法（改往來狀態）根本不在同一個按鈕底下的時候。
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
import type { AdminVendorRow } from "@/server/repos/inv-vendors";

type Props = {
  deleting: AdminVendorRow | null;
  setDeleting: (v: AdminVendorRow | null) => void;
  onConfirmDelete: (row: AdminVendorRow) => void;
};

export function VendorDialogs({ deleting, setDeleting, onConfirmDelete }: Props) {
  const linkedCount =
    (deleting?.product_count ?? 0) +
    (deleting?.purchase_count ?? 0) +
    (deleting?.portal_account_count ?? 0);

  return (
    <>
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">
              刪除廠商「{deleting?.name}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              這個動作無法復原。
              {linkedCount > 0 ? (
                <>
                  <strong>
                    這家還有 {deleting?.product_count ?? 0} 件商品、
                    {deleting?.purchase_count ?? 0} 筆進貨、
                    {deleting?.portal_account_count ?? 0} 個自助入口帳號
                  </strong>
                  ，資料庫會擋下來 —— 帳與貨的歷史要留著，不能因為刪一筆主檔就變成孤兒。
                  不再往來請改成「編輯 → 往來狀態 → 已終止」，那才是解約的做法。
                </>
              ) : (
                "只有完全沒有往來資料（商品、進貨、退貨單、自助入口帳號）的廠商刪得掉。有任何一種，資料庫都會擋下來並告訴你各有幾筆 —— 那種情況請把往來狀態改成「已終止」。"
              )}
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
