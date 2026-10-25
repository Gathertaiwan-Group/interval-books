/**
 * 書封辨識的確認欄位。
 *
 * 這裡刻意**不重用** ProductFormFields：那一份是完整的商品主檔表單（含圖庫、母
 * 品項、低庫存警示、每組數量共 15 個欄位），辨識回來只會填到其中五個。把辨識結果
 * 塞進一張什麼都有的表單，店員要一路捲過去找哪幾格被填了。
 *
 * 這一份只留「辨識填得到的 + 建檔一定要有的」：書名、期數、系列、出版社、條碼、
 * 分類、類型、售價、成本，再加上「一併建立第一筆進貨」。送出走的仍然是同一支
 * saveProduct()，同一個 invProductSchema。
 *
 * ⚠️ 沒有庫存欄位。庫存只能由進貨與盤點改（見 ProductForm 檔頭）。
 */
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { INV_PRODUCT_TYPES, INV_PRODUCT_TYPE_LABELS } from "@/lib/admin/schemas";
import type { AdminCategory, AdminVendor } from "@/server/repos/inv-products";

/** Radix Select 不收空字串當 value。 */
const NONE = "__none__";

export type OcrProductForm = {
  name: string;
  issue_number: string;
  series: string;
  publisher: string;
  barcode: string;
  category_id: string;
  vendor_id: string;
  product_type: (typeof INV_PRODUCT_TYPES)[number];
  selling_price: string;
  cost_price: string;
  with_purchase: boolean;
  quantity: string;
  purchase_date: string;
};

type Props = {
  form: OcrProductForm;
  onFormChange: (next: OcrProductForm) => void;
  errors: Record<string, string>;
  categories: AdminCategory[];
  vendors: AdminVendor[];
};

export function ProductOCRFields({ form, onFormChange, errors, categories, vendors }: Props) {
  const set = (patch: Partial<OcrProductForm>) => onFormChange({ ...form, ...patch });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="oc-name">商品名稱 *</Label>
          <Input
            id="oc-name"
            value={form.name}
            maxLength={200}
            onChange={(e) => set({ name: e.target.value })}
          />
          {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="oc-issue">期數</Label>
          <Input
            id="oc-issue"
            value={form.issue_number}
            maxLength={50}
            onChange={(e) => set({ issue_number: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="oc-series">系列</Label>
          <Input
            id="oc-series"
            value={form.series}
            maxLength={200}
            onChange={(e) => set({ series: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="oc-publisher">出版社</Label>
          <Input
            id="oc-publisher"
            value={form.publisher}
            maxLength={200}
            onChange={(e) => set({ publisher: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="oc-barcode">條碼 / ISBN</Label>
          <Input
            id="oc-barcode"
            value={form.barcode}
            maxLength={64}
            inputMode="numeric"
            onChange={(e) => set({ barcode: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            條碼是櫃檯結帳的依據 —— 辨識到的數字請與書背對一次。
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>分類</Label>
          <Select
            value={form.category_id || NONE}
            onValueChange={(v) => set({ category_id: v === NONE ? "" : v })}
          >
            <SelectTrigger aria-label="分類">
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
          <Label>商品類型</Label>
          <Select
            value={form.product_type}
            onValueChange={(v) => set({ product_type: v as OcrProductForm["product_type"] })}
          >
            <SelectTrigger aria-label="商品類型">
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
          <Label>供應商</Label>
          <Select
            value={form.vendor_id || NONE}
            onValueChange={(v) => set({ vendor_id: v === NONE ? "" : v })}
          >
            <SelectTrigger aria-label="供應商">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不指定</SelectItem>
              {vendors.map((v) => (
                <SelectItem key={v.vendor_id} value={v.vendor_id}>
                  {v.short_name || v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="oc-price">售價 *</Label>
          <Input
            id="oc-price"
            type="number"
            min={0}
            step="1"
            value={form.selling_price}
            onChange={(e) => set({ selling_price: e.target.value })}
          />
          {errors.selling_price ? (
            <p className="text-xs text-destructive">{errors.selling_price}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">封面上通常沒有售價，這一格要自己填。</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="oc-cost">成本</Label>
          <Input
            id="oc-cost"
            type="number"
            min={0}
            step="0.01"
            value={form.cost_price}
            onChange={(e) => set({ cost_price: e.target.value })}
          />
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="oc-with-purchase"
            checked={form.with_purchase}
            onCheckedChange={(v) => set({ with_purchase: v === true })}
          />
          <Label htmlFor="oc-with-purchase" className="font-normal">
            同時建立一筆進貨記錄
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          庫存不是直接填的數字 —— 它由進貨加上去，而且與商品在同一個交易裡建立。
        </p>
        {form.with_purchase ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="oc-qty" className="text-xs">
                數量
              </Label>
              <Input
                id="oc-qty"
                type="number"
                min={1}
                value={form.quantity}
                onChange={(e) => set({ quantity: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="oc-pdate" className="text-xs">
                進貨日期
              </Label>
              <Input
                id="oc-pdate"
                type="date"
                value={form.purchase_date}
                onChange={(e) => set({ purchase_date: e.target.value })}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
