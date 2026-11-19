/**
 * 商品表單的「不限庫存」勾選（0062）。
 *
 * 只給寄賣母品項：非寄賣不顯示；子品項顯示但停用（庫存掛在母品項上，旗標也要開在母品項）。
 * 開啟後下單／櫃檯／套餐不因庫存不足擋下、不進低庫存與盤點，銷貨成本在沒有進貨批次時
 * 用表單上的「成本」。真正的守門在資料庫（CHECK＋inv_save_product()），這裡只負責講清楚。
 */
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { ProductFormState } from "@/components/inventory/product-form-state";

export function UnlimitedStockField({
  form,
  setForm,
  error,
}: {
  form: ProductFormState;
  setForm: (next: ProductFormState) => void;
  error?: string;
}) {
  if (form.product_type !== "consignment") return null;
  const isChild = Boolean(form.base_product_id);
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <div className="flex items-center gap-2">
        <Checkbox
          id="p-unlimited"
          checked={form.unlimited_stock}
          disabled={isChild}
          onCheckedChange={(v) => setForm({ ...form, unlimited_stock: v === true })}
        />
        <Label htmlFor="p-unlimited" className="font-normal">
          不限庫存（寄賣不限量）
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {isChild
          ? "子品項跟著母品項的設定，要在母品項開啟。"
          : "開啟後不需要進貨也能上架與販售，不會顯示庫存數字、不進低庫存與盤點；銷貨成本用上面的「成本」。"}
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
