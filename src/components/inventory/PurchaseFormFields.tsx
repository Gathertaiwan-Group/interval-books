/**
 * 進貨表單的欄位群 —— 商品選擇器 + 其餘九個欄位。
 *
 * 從 PurchaseFormDialog 抽出來的理由與 ProductFormFields 一樣：對話框那一層要留給
 * 狀態、驗證與送出，欄位長什麼樣是另一件事。
 *
 * ⚠️ 商品選擇器只在**新增**時出現。編輯時商品是唯讀的 —— 換商品等於整批貨連同
 *    FIFO 批次一起搬家，要換就刪掉重開。
 */
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VendorSelect, type VendorOption } from "@/components/inventory/VendorSelect";
import type { PurchaseFormState } from "@/components/inventory/purchase-form-state";
import type { ProductPickerRow } from "@/server/repos/inv-purchases";

type Props = {
  form: PurchaseFormState;
  setForm: (next: PurchaseFormState) => void;
  onPickProduct: (product: ProductPickerRow) => void;
  matches: ProductPickerRow[];
  /** 新增時的資料庫端搜尋還沒回來（清單是空的時候顯示「搜尋中」，不閃「找不到」）。 */
  searching?: boolean;
  keyword: string;
  onKeywordChange: (next: string) => void;
  vendors: VendorOption[];
  saving: boolean;
  /** 編輯時傳進來，商品那一格改成唯讀。 */
  lockedProduct: { name: string | null; issue_number: string | null } | null;
};

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

export function PurchaseFormFields({
  form,
  setForm,
  onPickProduct,
  matches,
  searching = false,
  keyword,
  onKeywordChange,
  vendors,
  saving,
  lockedProduct,
}: Props) {
  return (
    <div className="space-y-4">
      {lockedProduct ? (
        <div className="space-y-1.5">
          <Label className="text-xs">商品（不可更改）</Label>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            {lockedProduct.name ?? "（找不到商品）"}
            {lockedProduct.issue_number ? (
              <span className="text-muted-foreground"> ・第 {lockedProduct.issue_number} 期</span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="purchase-product" className="text-xs">
            商品 *
          </Label>
          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="purchase-product"
              className="pl-8"
              placeholder="搜尋商品名稱、期數、系列、條碼"
              value={keyword}
              disabled={saving}
              onChange={(e) => onKeywordChange(e.target.value)}
            />
          </div>
          <div className="max-h-44 overflow-y-auto rounded-md border border-border">
            {matches.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground" aria-live="polite">
                {searching ? "搜尋中…" : "找不到商品"}
              </p>
            ) : (
              matches.map((p) => (
                <button
                  key={p.inv_product_id}
                  type="button"
                  disabled={saving}
                  onClick={() => onPickProduct(p)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted ${
                    p.inv_product_id === form.product_id ? "bg-muted" : ""
                  }`}
                >
                  <span>
                    {p.name}
                    {p.issue_number ? (
                      <span className="text-muted-foreground"> ・第 {p.issue_number} 期</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    庫存 {p.stock_quantity}
                  </span>
                </button>
              ))
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {form.product_id ? "已選好商品。" : "從上面挑一件商品。"}清單最多顯示 30
            筆，打字縮小範圍。
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="purchase-item-name" label="進貨品名">
          <Input
            id="purchase-item-name"
            value={form.item_name}
            maxLength={200}
            disabled={saving}
            placeholder="進貨單上的寫法，可以與商品名稱不同"
            onChange={(e) => setForm({ ...form, item_name: e.target.value })}
          />
        </Field>

        <Field id="purchase-date" label="進貨日期 *">
          <Input
            id="purchase-date"
            type="date"
            value={form.purchase_date}
            disabled={saving}
            onChange={(e) => setForm({ ...form, purchase_date: e.target.value })}
          />
        </Field>

        <Field id="purchase-qty" label="數量 *">
          <Input
            id="purchase-qty"
            type="number"
            min={1}
            value={form.quantity}
            disabled={saving}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
          />
        </Field>

        <Field id="purchase-cost" label="單價成本">
          <Input
            id="purchase-cost"
            type="number"
            min={0}
            step="0.01"
            value={form.unit_cost}
            disabled={saving}
            onChange={(e) => setForm({ ...form, unit_cost: e.target.value })}
          />
        </Field>

        <VendorSelect
          value={form.vendor}
          onChange={(v) => setForm({ ...form, vendor: v })}
          vendors={vendors}
          disabled={saving}
          idPrefix="purchase-vendor"
        />

        <Field id="purchase-publisher" label="出版社">
          <Input
            id="purchase-publisher"
            value={form.publisher}
            maxLength={200}
            disabled={saving}
            onChange={(e) => setForm({ ...form, publisher: e.target.value })}
          />
        </Field>

        <Field id="purchase-expiry" label="保存期限">
          <Input
            id="purchase-expiry"
            type="date"
            value={form.expiry_date}
            disabled={saving}
            onChange={(e) => setForm({ ...form, expiry_date: e.target.value })}
          />
        </Field>

        <Field id="purchase-alert" label="效期警示天數">
          <Input
            id="purchase-alert"
            type="number"
            min={1}
            max={365}
            placeholder="留空 = 7 天"
            value={form.expiry_alert_days}
            disabled={saving || form.expiry_date === ""}
            onChange={(e) => setForm({ ...form, expiry_alert_days: e.target.value })}
          />
        </Field>
      </div>

      <Field id="purchase-notes" label="備註">
        <Textarea
          id="purchase-notes"
          rows={2}
          maxLength={2000}
          value={form.notes}
          disabled={saving}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </Field>
    </div>
  );
}
