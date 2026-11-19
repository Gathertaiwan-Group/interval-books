import { Minus, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PosProduct } from "@/server/repos/inv-sales";

/**
 * 一件在車上的商品。
 *
 * unit_price 是**成交價**，不是定價。這個專案的櫃檯折扣就是改這個數字 ——
 * inv.sales 沒有 discount 欄位，來源系統也是直接覆寫單價。所以「打折」在這裡
 * 不是一個獨立概念，是「原價幾元、實收幾元」兩個數字的差。
 */
export type CartLine = {
  product: PosProduct;
  quantity: number;
  unitPrice: number;
};

type Props = {
  lines: CartLine[];
  onQuantityChange: (invProductId: string, quantity: number) => void;
  onPriceChange: (invProductId: string, unitPrice: number) => void;
  onRemove: (invProductId: string) => void;
  disabled?: boolean;
};

export function CartPanel({ lines, onQuantityChange, onPriceChange, onRemove, disabled }: Props) {
  if (lines.length === 0) {
    return (
      <div className="flex h-full min-h-48 items-center justify-center rounded-md border border-dashed border-border">
        <p className="text-sm text-muted-foreground">掃描條碼或搜尋商品，加入這一車</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-[26rem] rounded-md border border-border">
      <ul className="divide-y divide-border">
        {lines.map((line) => {
          const { product: p } = line;
          // 這一車已經超過可售量。不擋，但要讓店員看見 —— 送出時他還要再確認
          // 一次逃生門（見 CheckoutPanel）。
          // 不限庫存（0062）沒有「超過可售量」這件事。
          const over = !p.unlimited_stock && line.quantity > p.available;
          const listPrice = Number(p.selling_price ?? 0);
          const discounted = line.unitPrice !== listPrice;

          return (
            <li key={p.inv_product_id} className="space-y-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[p.series, p.issue_number].filter(Boolean).join("　") || "—"}
                    {p.units_per_item > 1 ? `　（1 件扣 ${p.units_per_item} 個）` : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => onRemove(p.inv_product_id)}
                  disabled={disabled}
                  aria-label={`從清單移除 ${p.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center rounded-md border border-border">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-r-none"
                    onClick={() => onQuantityChange(p.inv_product_id, line.quantity - 1)}
                    disabled={disabled || line.quantity <= 1}
                    aria-label="減少數量"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <Input
                    type="number"
                    min={1}
                    value={line.quantity}
                    onChange={(e) => {
                      // 空字串 → NaN → 寫進資料庫。來源系統就是這樣讓 NaN 進到
                      // unit_price 的，這裡把它擋在最前面。
                      const next = Number.parseInt(e.target.value, 10);
                      onQuantityChange(p.inv_product_id, Number.isFinite(next) ? next : 1);
                    }}
                    className="h-8 w-14 rounded-none border-x-0 border-y-0 text-center tabular-nums [appearance:textfield] focus-visible:ring-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    disabled={disabled}
                    aria-label={`${p.name} 的數量`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-l-none"
                    onClick={() => onQuantityChange(p.inv_product_id, line.quantity + 1)}
                    disabled={disabled}
                    aria-label="增加數量"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">單價</span>
                  <Input
                    type="number"
                    min={0}
                    step="1"
                    value={line.unitPrice}
                    onChange={(e) => {
                      const next = Number.parseFloat(e.target.value);
                      onPriceChange(p.inv_product_id, Number.isFinite(next) ? next : 0);
                    }}
                    className="h-8 w-24 tabular-nums"
                    disabled={disabled}
                    aria-label={`${p.name} 的單價`}
                  />
                </div>

                <span className="ml-auto text-sm font-medium tabular-nums">
                  NT$ {(line.quantity * line.unitPrice).toLocaleString("zh-TW")}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant={over ? "destructive" : "secondary"}
                  className="font-normal tabular-nums"
                >
                  {p.unlimited_stock ? "不限量" : `可售 ${p.available}`}
                </Badge>
                {discounted ? (
                  <Badge variant="outline" className="font-normal tabular-nums">
                    定價 NT$ {listPrice.toLocaleString("zh-TW")}
                  </Badge>
                ) : null}
                {over ? (
                  <span className="flex items-center gap-1 text-xs text-destructive">
                    <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                    超過可售量 {line.quantity - p.available} 件
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}
