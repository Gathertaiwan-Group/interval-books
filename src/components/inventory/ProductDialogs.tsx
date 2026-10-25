/**
 * 這一頁留成對話框的三個（調價、Excel 匯入、批次修改）+ 刪除確認。
 *
 * 全部收在一起，是因為它們對 route 來說是同一件事：「某個 state 不是 null 的時候
 * 蓋一層東西上去」。route 檔留著它們只會讓真正的版面（工具列、篩選、表格、分頁）
 * 被推到 400 行以外。
 *
 * 2026-10-25 起「詳細」與「新增／編輯」不再是對話框，是內頁：
 * /admin/inventory-products/$id、/$id/edit、/new（_shell.inventory-products_.*.tsx）。
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
import { BatchUpdateDialog } from "@/components/inventory/BatchUpdateDialog";
import { ExcelImportDialog } from "@/components/inventory/ExcelImportDialog";
import { PriceChangeDialog } from "@/components/inventory/PriceChangeDialog";
import type { AdminCategory, AdminProductRow, AdminVendor } from "@/server/repos/inv-products";

type Props = {
  categories: AdminCategory[];
  vendors: AdminVendor[];
  productApprovalOn: boolean;
  priceApprovalOn: boolean;
  refresh: () => Promise<void>;

  pricing: AdminProductRow | null;
  setPricing: (v: AdminProductRow | null) => void;

  deleting: AdminProductRow | null;
  setDeleting: (v: AdminProductRow | null) => void;
  onConfirmDelete: (row: AdminProductRow) => void;

  importOpen: boolean;
  setImportOpen: (v: boolean) => void;

  batchUpdateOpen: boolean;
  setBatchUpdateOpen: (v: boolean) => void;
  selectedIds: string[];
  onBatchUpdated: () => Promise<void>;
};

export function ProductDialogs(props: Props) {
  const {
    categories,
    vendors,
    productApprovalOn,
    priceApprovalOn,
    refresh,
    pricing,
    setPricing,
    deleting,
    setDeleting,
    onConfirmDelete,
    importOpen,
    setImportOpen,
    batchUpdateOpen,
    setBatchUpdateOpen,
    selectedIds,
    onBatchUpdated,
  } = props;

  return (
    <>
      <PriceChangeDialog
        open={pricing !== null}
        onOpenChange={(o) => !o && setPricing(null)}
        product={pricing}
        priceApprovalOn={priceApprovalOn}
        onDone={refresh}
      />

      <ExcelImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        categories={categories}
        productApprovalOn={productApprovalOn}
        onImported={refresh}
      />

      <BatchUpdateDialog
        open={batchUpdateOpen}
        onOpenChange={setBatchUpdateOpen}
        selectedIds={selectedIds}
        categories={categories}
        vendors={vendors}
        priceApprovalOn={priceApprovalOn}
        onDone={onBatchUpdated}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">刪除「{deleting?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              這個動作無法復原。賣過的商品與還掛在店面型錄上的商品會被擋下來 ——
              那種情況請改用「停用」，庫存與歷史紀錄才會留著。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const row = deleting;
                setDeleting(null);
                if (row) onConfirmDelete(row);
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
