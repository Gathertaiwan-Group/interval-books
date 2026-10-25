/**
 * 商品表單的欄位群。
 *
 * 從 ProductFormDialog（2026-10-25 起是內頁 ProductForm）抽出來，因為那個檔案原本是「對話框外殼 + 提交邏輯 + 15 個
 * 欄位 + 進貨區塊」四件事擠在一起。欄位長什麼樣與「送出之後會發生什麼」是兩種
 * 會各自變動的東西，混在一個檔案裡改一個就要重讀另一個。
 *
 * ⚠️ 這裡**沒有**庫存欄位、沒有審核狀態欄位。不是漏了，見 ProductForm 檔頭。
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ImageField } from "@/components/admin/ImageField";
import { BarcodeInput } from "@/components/inventory/BarcodeInput";
import { INV_PRODUCT_TYPES, INV_PRODUCT_TYPE_LABELS } from "@/lib/admin/schemas";
import bookstoreInterior from "@/assets/bookstore-interior.jpg";
import type { AdminCategory, AdminVendor } from "@/server/repos/inv-products";
import type { ProductFormState } from "@/components/inventory/product-form-state";

const NONE = "__none__";

type Props = {
  form: ProductFormState;
  setForm: (next: ProductFormState) => void;
  errors: Record<string, string>;
  saving: boolean;
  categories: AdminCategory[];
  vendors: AdminVendor[];
  baseProducts: { inv_product_id: string; name: string; issue_number: string | null }[];
  currentProductId: string | null;
  onNameBlur: () => void;
};

export function ProductFormFields({
  form,
  setForm,
  errors,
  saving,
  categories,
  vendors,
  baseProducts,
  currentProductId,
  onNameBlur,
}: Props) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="p-name">商品名稱 *</Label>
        <Input
          id="p-name"
          value={form.name}
          maxLength={200}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          onBlur={onNameBlur}
          placeholder="例如：地味手帖 NO.15"
        />
        {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
        <p className="text-xs text-muted-foreground">
          名稱裡的期數（NO.15、#15、第15期、Vol.15）會在離開欄位時自動拆到期數欄。
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="p-issue">期數</Label>
        <Input
          id="p-issue"
          value={form.issue_number}
          maxLength={50}
          onChange={(e) => setForm({ ...form, issue_number: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="p-barcode">條碼</Label>
        <BarcodeInput
          id="p-barcode"
          value={form.barcode}
          disabled={saving}
          onChange={(v) => setForm({ ...form, barcode: v })}
        />
      </div>

      <div className="space-y-1.5">
        <Label>分類</Label>
        <Select
          value={form.category_id || NONE}
          onValueChange={(v) => setForm({ ...form, category_id: v === NONE ? "" : v })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>不指定</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.category_id} value={c.category_id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>商品類型 *</Label>
        <Select
          value={form.product_type}
          onValueChange={(v) =>
            setForm({
              ...form,
              product_type: v as ProductFormState["product_type"],
              // 租借品沒有「賣完」這件事，低庫存警示對它沒有意義。來源也這樣做。
              low_stock_alert: v === "rental" ? "0" : form.low_stock_alert,
            })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INV_PRODUCT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {INV_PRODUCT_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="p-series">系列</Label>
        <Input
          id="p-series"
          value={form.series}
          maxLength={200}
          onChange={(e) => setForm({ ...form, series: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="p-publisher">出版社</Label>
        <Input
          id="p-publisher"
          value={form.publisher}
          maxLength={200}
          onChange={(e) => setForm({ ...form, publisher: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label>供應商</Label>
        <Select
          value={form.vendor_id || NONE}
          onValueChange={(v) => setForm({ ...form, vendor_id: v === NONE ? "" : v })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>不指定</SelectItem>
            {vendors.map((v) => (
              <SelectItem key={v.vendor_id} value={v.vendor_id}>
                {v.short_name || v.name}
                {v.is_consignment ? "（寄售）" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="p-price">售價</Label>
        <Input
          id="p-price"
          type="number"
          min={0}
          step="0.01"
          value={form.selling_price}
          onChange={(e) => setForm({ ...form, selling_price: e.target.value })}
        />
        {errors.selling_price ? (
          <p className="text-xs text-destructive">{errors.selling_price}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="p-cost">成本</Label>
        <Input
          id="p-cost"
          type="number"
          min={0}
          step="0.01"
          value={form.cost_price}
          onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
        />
        {errors.cost_price ? <p className="text-xs text-destructive">{errors.cost_price}</p> : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="p-low">低庫存警示</Label>
        <Input
          id="p-low"
          type="number"
          min={0}
          value={form.low_stock_alert}
          onChange={(e) => setForm({ ...form, low_stock_alert: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="p-pack">每組數量（pack_size）</Label>
        <Input
          id="p-pack"
          type="number"
          min={1}
          value={form.pack_size}
          onChange={(e) => setForm({ ...form, pack_size: e.target.value })}
        />
      </div>

      <div className="space-y-1.5 sm:col-span-2">
        <Label>庫存來源（母品項）</Label>
        <Select
          value={form.base_product_id || NONE}
          onValueChange={(v) => setForm({ ...form, base_product_id: v === NONE ? "" : v })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>沒有（這件商品有自己的庫存）</SelectItem>
            {baseProducts
              .filter((b) => b.inv_product_id !== currentProductId)
              .map((b) => (
                <SelectItem key={b.inv_product_id} value={b.inv_product_id}>
                  {b.name}
                  {b.issue_number ? ` NO.${b.issue_number}` : ""}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          設了母品項之後，這件商品賣一個 = 從母品項扣 pack_size 個。母品項只能選已審核、
          而且自己沒有母品項的商品（不允許多層鏈結）。
        </p>
      </div>

      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="p-notes">備註</Label>
        <Textarea
          id="p-notes"
          rows={3}
          maxLength={2000}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </div>

      <div className="sm:col-span-2">
        <ImageField
          label="商品照片"
          value={form.image_key}
          fallback={bookstoreInterior}
          disabled={saving}
          onChange={(key) => setForm({ ...form, image_key: key })}
        />
      </div>
    </div>
  );
}
