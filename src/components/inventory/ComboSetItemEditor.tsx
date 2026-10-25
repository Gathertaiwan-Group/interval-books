/**
 * 套餐的組成品項編輯器：挑商品、設數量、刪掉一列。
 *
 * ⚠️ 同一件商品不可以在套餐裡出現兩次（要多份請改數量）。這裡擋一次是為了當場說得
 *    出原因，**但它不是防線** —— comboSetSchema 的 refine 擋一次，0018 的
 *    COMBO_DUP_ITEM 再擋一次，那兩層才是。
 *
 * ⚠️ 商品清單是 listComboFormOptions() 一次載進來的（與櫃檯同一個 inv_pos_products 範圍，
 *    已審核、上架、不是組合子品項）。這裡的搜尋只是在這份清單上過濾，最多畫 50 筆 ——
 *    Radix Select 一次塞一千個 item 會卡住整個對話框。
 */
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { money, productLabel } from "@/lib/admin/inv-combo-labels";
import type { ComboItemValues } from "@/lib/admin/schemas";
import type { ComboPickerProduct } from "@/server/repos/inv-sales";

const MAX_OPTIONS = 50;

type Props = {
  items: ComboItemValues[];
  products: ComboPickerProduct[];
  disabled?: boolean;
  onChange: (next: ComboItemValues[]) => void;
};

export function ComboSetItemEditor({ items, products, disabled, onChange }: Props) {
  const [keyword, setKeyword] = useState("");
  const [picked, setPicked] = useState("");

  const chosen = new Set(items.map((i) => i.product_id));
  const kw = keyword.trim().toLowerCase();
  const matched = products.filter((p) => {
    if (kw === "") return true;
    return (
      p.name.toLowerCase().includes(kw) ||
      (p.issue_number ?? "").toLowerCase().includes(kw) ||
      (p.series ?? "").toLowerCase().includes(kw) ||
      (p.barcode ?? "").toLowerCase().includes(kw)
    );
  });
  const options = matched.slice(0, MAX_OPTIONS);

  function add() {
    if (picked === "") {
      toast.error("請先從清單裡選一件商品");
      return;
    }
    if (chosen.has(picked)) {
      const dup = products.find((p) => p.inv_product_id === picked);
      toast.error(
        `「${dup ? productLabel(dup.name, dup.issue_number) : "這件商品"}」已經在這個套餐裡了。同一件商品不能加兩次，請改上面那一列的數量。`,
      );
      return;
    }
    onChange([...items, { product_id: picked, quantity: 1 }]);
    setPicked("");
  }

  function setQuantity(productId: string, raw: string) {
    const n = raw.trim() === "" ? Number.NaN : Number(raw);
    onChange(
      items.map((i) =>
        i.product_id === productId ? { ...i, quantity: Number.isNaN(n) ? 1 : n } : i,
      ),
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="combo-item-search" className="text-xs">
            加入組成品項
          </Label>
          <Input
            id="combo-item-search"
            placeholder="搜尋：商品名稱、期數、系列、條碼"
            value={keyword}
            disabled={disabled}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className="min-w-56 flex-1 space-y-1.5">
          <Select value={picked} disabled={disabled} onValueChange={setPicked}>
            <SelectTrigger>
              <SelectValue placeholder="從搜尋結果裡選一件商品" />
            </SelectTrigger>
            <SelectContent>
              {options.map((p) => (
                <SelectItem key={p.inv_product_id} value={p.inv_product_id}>
                  {productLabel(p.name, p.issue_number)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {p.selling_price ? money(p.selling_price) : "未填售價"}・庫存 {p.stock_quantity}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" className="gap-1.5" disabled={disabled} onClick={add}>
          <Plus className="h-4 w-4" />
          加入
        </Button>
      </div>

      {matched.length > MAX_OPTIONS ? (
        <p className="text-xs text-muted-foreground">
          符合的商品有 {matched.length} 件，清單只列出前 {MAX_OPTIONS} 件。請再打幾個字縮小範圍。
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          還沒有組成品項。套餐至少要有一件 —— 沒有組成品項的套餐等於收錢不出貨，資料庫會擋下販售。
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const product = products.find((p) => p.inv_product_id === item.product_id);
            return (
              <li
                key={item.product_id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
              >
                <div className="min-w-40 flex-1">
                  <p className="text-sm">
                    {product ? productLabel(product.name, product.issue_number) : "未知商品"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {product?.selling_price ? (
                      `定價 ${money(product.selling_price)}・庫存 ${product.stock_quantity}`
                    ) : (
                      <span className="text-amber-700">沒有填售價 —— 整組會改成按數量均分</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Label htmlFor={`combo-qty-${item.product_id}`} className="text-xs">
                    數量
                  </Label>
                  <Input
                    id={`combo-qty-${item.product_id}`}
                    type="number"
                    min={1}
                    step={1}
                    className="w-20"
                    value={item.quantity}
                    disabled={disabled}
                    onChange={(e) => setQuantity(item.product_id, e.target.value)}
                  />
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  title="移除這一件"
                  disabled={disabled}
                  onClick={() => onChange(items.filter((i) => i.product_id !== item.product_id))}
                >
                  <Trash2 className="h-4 w-4" />
                  <span className="sr-only">移除</span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
