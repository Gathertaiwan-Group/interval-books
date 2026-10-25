/**
 * 進貨頁工具列上的「拍照辨識」按鈕 + 它的對話框。
 *
 * 按鈕與對話框綁在同一個元件裡，是因為 route 只在乎「有這個入口」，不在乎它自己
 * 的開關狀態。route 檔已經在 300 行的線上，多一顆按鈕就要多一個 useState、一個
 * import、一段 JSX —— 那三樣東西沒有一樣是那個檔案該關心的。
 *
 * 辨識結果要對著完整商品清單比對；清單在按下按鈕時才抓（2026-10-26 起不再跟著列表頁載入），
 * 🔴 抓到了才打開對話框——拿空清單去比對，每一列都會被當成新商品。
 * 辨識失敗時的「改用手動輸入」導到新增進貨內頁 /admin/inventory-purchases/new。
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PurchaseOCRDialog } from "@/components/ocr/PurchaseOCRDialog";
import type { VendorOption } from "@/components/inventory/VendorSelect";
import type { ProductPickerRow } from "@/server/repos/inv-purchases";

type Props = {
  /** null＝還沒抓（按下按鈕時才抓）。 */
  products: ProductPickerRow[] | null;
  loadProducts: () => Promise<ProductPickerRow[] | null>;
  loading: boolean;
  vendors: VendorOption[];
  categories: { category_id: string; name: string }[];
  approvalOn: boolean;
  onImported: () => void | Promise<void>;
};

export function PurchaseOCRLauncher({
  products,
  loadProducts,
  loading,
  vendors,
  categories,
  approvalOn,
  onImported,
}: Props) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  async function openDialog() {
    if (await loadProducts()) setOpen(true);
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => void openDialog()}
        disabled={loading}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Camera className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        拍照辨識
      </Button>
      <PurchaseOCRDialog
        open={open && products !== null}
        onOpenChange={setOpen}
        products={products ?? []}
        vendors={vendors}
        categories={categories}
        approvalOn={approvalOn}
        onImported={onImported}
        // 辨識失敗時的退路：關掉辨識、到新增進貨內頁手動輸入。
        onManualEntry={() => void navigate({ to: "/admin/inventory-purchases/new" })}
      />
    </>
  );
}
