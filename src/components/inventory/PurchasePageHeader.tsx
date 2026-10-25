/**
 * 進貨頁的標題列與那排動作按鈕。
 *
 * 與商品頁的 ProductPageHeader 對稱 —— 那一頁 4b 就拆出來了，這一頁當時還放得下
 * 所以留在 route 裡。4c 把拍照辨識掛上去之後就超過 300 行了，補上這個對稱缺口。
 *
 * ⚠️ 這裡只有畫面。`selectMode`、匯入、辨識全部由 route 傳進來的 callback
 *    決定，這個元件不知道也不該知道任何一支 server fn。
 *
 * 2026-10-26 起「新增進貨」是內頁 /admin/inventory-purchases/new（不再是彈窗）。匯入與拍照辨識
 * 要對著完整商品清單比對，清單在打開時才抓（usePickerProducts）：抓的期間按鈕顯示「載入中」。
 */
import { Link } from "@tanstack/react-router";
import { FileSpreadsheet, Loader2, Plus, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PurchaseOCRLauncher } from "@/components/ocr/PurchaseOCRLauncher";
import type { VendorOption } from "@/components/inventory/VendorSelect";
import type { ProductPickerRow } from "@/server/repos/inv-purchases";

type Props = {
  total: number;
  selectMode: boolean;
  onToggleSelectMode: () => void;
  onOpenImport: () => void;
  /** 完整商品清單正在載入（匯入／拍照辨識打開前）。 */
  productsLoading: boolean;
  /** 拍照辨識要用的清單與設定 —— 見 components/ocr/PurchaseOCRLauncher。null＝還沒抓。 */
  products: ProductPickerRow[] | null;
  loadProducts: () => Promise<ProductPickerRow[] | null>;
  vendors: VendorOption[];
  categories: { category_id: string; name: string }[];
  approvalOn: boolean;
  onImported: () => void | Promise<void>;
};

export function PurchasePageHeader({
  total,
  selectMode,
  onToggleSelectMode,
  onOpenImport,
  productsLoading,
  products,
  loadProducts,
  vendors,
  categories,
  approvalOn,
  onImported,
}: Props) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Truck className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-lg font-medium">進貨</h1>
        <span className="text-sm text-muted-foreground">共 {total} 筆</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onToggleSelectMode}>
          {selectMode ? "取消批次操作" : "批次操作"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onOpenImport}
          disabled={productsLoading}
        >
          {productsLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileSpreadsheet className="h-3.5 w-3.5" />
          )}
          匯入 Excel
        </Button>
        <PurchaseOCRLauncher
          products={products}
          loadProducts={loadProducts}
          loading={productsLoading}
          vendors={vendors}
          categories={categories}
          approvalOn={approvalOn}
          onImported={onImported}
        />
        <Button asChild size="sm" className="gap-1.5">
          <Link to="/admin/inventory-purchases/new" preload="intent">
            <Plus className="h-3.5 w-3.5" />
            新增進貨
          </Link>
        </Button>
      </div>
    </div>
  );
}
