/**
 * 在庫異動單的欄位群。
 *
 * 從 AdjustmentFormDialog 抽出來，理由與 ProductFormFields 相同：那個檔案原本是
 * 「對話框外殼 ＋ 搜尋 ＋ 提交邏輯 ＋ 六個欄位」擠在一起，長到剛好卡在自檢的
 * 300 行上限，連 prettier 都套不上去（折行會讓它超過）。
 *
 * ⚠️ 回傳的是 Fragment 不是 <div>。這幾塊本來就是 DialogContent 的直接子元素，
 *    包一層容器會改掉 DialogContent 的間距。
 *
 * ⚠️ 負庫存只**軟警告**，不擋 —— 判斷用的 `after` 只是給人看的預估值，真正的
 *    庫存加減在資料庫的 trigger 裡。理由見 AdjustmentFormDialog 檔頭。
 */
import { AlertTriangle } from "lucide-react";
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
import {
  ADJUSTMENT_CATEGORY_OPTIONS,
  ADJUSTMENT_REASON_OPTIONS,
} from "@/lib/admin/inv-adjustment-labels";
import {
  INV_PRODUCT_TYPE_LABELS,
  type InvAdjustmentCategory,
  type InvAdjustmentReason,
} from "@/lib/admin/schemas";
import type { StockCountProductRow } from "@/server/repos/inv-adjustments";

/** Radix Select 不接受空字串當 SelectItem 的 value，所以「不指定」用這個哨兵值。 */
const NONE = "__none__";

type Props = {
  date: string;
  setDate: (value: string) => void;
  category: InvAdjustmentCategory;
  setCategory: (value: InvAdjustmentCategory) => void;
  keyword: string;
  setKeyword: (value: string) => void;
  products: StockCountProductRow[];
  productId: string;
  setProductId: (value: string) => void;
  quantity: string;
  setQuantity: (value: string) => void;
  reason: InvAdjustmentReason | null;
  setReason: (value: InvAdjustmentReason | null) => void;
  notes: string;
  setNotes: (value: string) => void;
};

export function AdjustmentFormFields({
  date,
  setDate,
  category,
  setCategory,
  keyword,
  setKeyword,
  products,
  productId,
  setProductId,
  quantity,
  setQuantity,
  reason,
  setReason,
  notes,
  setNotes,
}: Props) {
  const selected = products.find((p) => p.inv_product_id === productId) ?? null;
  const qty = quantity.trim() === "" ? null : Number(quantity);
  // 不限庫存的品項帳上數字沒有意義，不預告「異動後為負值」。
  const after =
    selected && !selected.unlimited_stock && qty !== null && !Number.isNaN(qty)
      ? selected.stock_quantity + qty
      : null;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="adjf-date">異動日期</Label>
          <Input
            id="adjf-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label>異動類別</Label>
          <Select value={category} onValueChange={(v) => setCategory(v as InvAdjustmentCategory)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ADJUSTMENT_CATEGORY_OPTIONS.map((o) => (
                <SelectItem key={o.code} value={o.code}>
                  {o.label}
                  <span className="ml-2 text-xs text-muted-foreground">— {o.description}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="adjf-search">商品</Label>
        <Input
          id="adjf-search"
          placeholder="先搜尋：商品名稱、期數、系列、條碼"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Select value={productId} onValueChange={setProductId}>
          <SelectTrigger>
            <SelectValue placeholder="從搜尋結果裡選一件商品" />
          </SelectTrigger>
          <SelectContent>
            {products.map((p) => (
              <SelectItem key={p.inv_product_id} value={p.inv_product_id}>
                {p.name}
                {p.issue_number ? ` #${p.issue_number}` : ""}
                {p.unlimited_stock ? "（不限量）" : `（庫存 ${p.stock_quantity}）`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected ? (
          <p className="text-xs text-muted-foreground">
            {selected.unlimited_stock
              ? "不限庫存（寄賣不限量）・"
              : `現有庫存 ${selected.stock_quantity} 件・`}
            {INV_PRODUCT_TYPE_LABELS[
              selected.product_type as keyof typeof INV_PRODUCT_TYPE_LABELS
            ] ?? selected.product_type}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="adjf-qty">異動數量</Label>
          <Input
            id="adjf-qty"
            type="number"
            step={1}
            placeholder="負值＝扣帳，正值＝回補"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label>原因（選填）</Label>
          <Select
            value={reason ?? NONE}
            onValueChange={(v) => setReason(v === NONE ? null : (v as InvAdjustmentReason))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>不指定</SelectItem>
              {ADJUSTMENT_REASON_OPTIONS.map((o) => (
                <SelectItem key={o.code} value={o.code}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {after !== null && after < 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span>
            注意：異動後庫存將為負值（{after}）。這張單還是可以送出 —— 帳做平比擋住重要，
            但請確認數量沒有打錯。
          </span>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="adjf-notes">備註</Label>
        <Textarea
          id="adjf-notes"
          rows={2}
          placeholder="補充說明（選填）"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
    </>
  );
}
