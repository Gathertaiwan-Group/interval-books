import { useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { Separator } from "@/components/ui/separator";
import type { PosPaymentMethod } from "@/server/repos/inv-sales";
import type { CartLine } from "@/components/pos/CartPanel";

type Props = {
  lines: CartLine[];
  paymentMethods: PosPaymentMethod[];
  paymentMethodId: string | null;
  onPaymentMethodChange: (id: string | null) => void;
  notes: string;
  onNotesChange: (notes: string) => void;
  override: boolean;
  onOverrideChange: (on: boolean) => void;
  onSubmit: () => void;
  submitting: boolean;
  onClear: () => void;
};

export function CheckoutPanel({
  lines,
  paymentMethods,
  paymentMethodId,
  onPaymentMethodChange,
  notes,
  onNotesChange,
  override,
  onOverrideChange,
  onSubmit,
  submitting,
  onClear,
}: Props) {
  const [confirmingOverride, setConfirmingOverride] = useState(false);

  const totalQty = lines.reduce((n, l) => n + l.quantity, 0);
  const totalAmount = lines.reduce((n, l) => n + l.quantity * l.unitPrice, 0);
  const listTotal = lines.reduce(
    (n, l) => n + l.quantity * Number(l.product.selling_price ?? 0),
    0,
  );
  const discount = listTotal - totalAmount;

  /** 這一車有幾件超過可售量。決定要不要逼店員走逃生門。 */
  // 不限庫存（0062）的品項不比可售量，與 pos_checkout() 相同。
  const overLines = lines.filter(
    (l) => !l.product.unlimited_stock && l.quantity > l.product.available,
  );
  const needsOverride = overLines.length > 0;
  const blocked = needsOverride && !override;

  return (
    <div className="space-y-4 rounded-md border border-border p-4">
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">件數</span>
          <span className="tabular-nums">{totalQty}</span>
        </div>
        {discount !== 0 ? (
          <>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">定價合計</span>
              <span className="tabular-nums text-muted-foreground line-through">
                NT$ {listTotal.toLocaleString("zh-TW")}
              </span>
            </div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">折讓</span>
              <span className="tabular-nums">−NT$ {discount.toLocaleString("zh-TW")}</span>
            </div>
          </>
        ) : null}
        <Separator className="my-2" />
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">應收</span>
          <span className="text-xl font-medium tabular-nums">
            NT$ {totalAmount.toLocaleString("zh-TW")}
          </span>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pos-payment-method">付款方式</Label>
        <Select
          value={paymentMethodId ?? ""}
          onValueChange={(v) => onPaymentMethodChange(v || null)}
          disabled={submitting}
        >
          <SelectTrigger id="pos-payment-method">
            <SelectValue placeholder="選擇付款方式" />
          </SelectTrigger>
          <SelectContent>
            {paymentMethods.map((m) => (
              <SelectItem key={m.payment_method_id} value={m.payment_method_id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pos-notes">備註（選填）</Label>
        <Input
          id="pos-notes"
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="例如：華山活動、員工價"
          maxLength={500}
          disabled={submitting}
        />
      </div>

      {/*
        逃生門。
        設計上刻意「不好按」：只有真的超賣時才出現、預設關著、文字直說會發生什麼事。
        來源系統沒有這個東西 —— 它是直接讓庫存變負數，沒有人會知道。
      */}
      {needsOverride ? (
        <div className="space-y-2.5 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <div className="space-y-1 text-sm">
              <p className="font-medium text-destructive">這一車的庫存不夠</p>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {overLines.map((l) => (
                  <li key={l.product.inv_product_id}>
                    「{l.product.name}」可售 {l.product.available} 件，這一車要 {l.quantity} 件
                    {l.product.reserved > 0
                      ? `（架上有 ${l.product.stock_quantity} 個，其中 ${l.product.reserved} 個被網站訂單保留）`
                      : ""}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-md bg-background/60 p-2.5">
            <Checkbox
              checked={override}
              onCheckedChange={(v) => {
                const on = v === true;
                onOverrideChange(on);
                setConfirmingOverride(on);
              }}
              disabled={submitting}
              aria-describedby="pos-override-help"
              className="mt-0.5"
            />
            <span className="space-y-1 text-xs leading-relaxed">
              <span className="block font-medium">客人就站在櫃檯，我確認架上有貨，先賣</span>
              <span id="pos-override-help" className="block text-muted-foreground">
                勾了會照樣結帳，庫存可能變成負數。系統會把這件事記進「賣超告警」，
                包含品項、差幾件、什麼時候 —— 之後要有人去盤點對帳。
                {overLines.some((l) => l.product.reserved > 0)
                  ? "　⚠️ 這些貨有一部分是網站客人已經下單保留的，賣掉之後那張訂單會出不了貨。"
                  : ""}
              </span>
            </span>
          </label>

          {confirmingOverride ? (
            <p className="text-xs text-destructive">
              已開啟強制放行。送出後這筆會出現在「賣超告警」頁。
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onClear}
          disabled={submitting || lines.length === 0}
        >
          清空
        </Button>
        <Button
          type="button"
          className="flex-1"
          onClick={onSubmit}
          disabled={submitting || lines.length === 0 || blocked}
        >
          {submitting ? (
            <>
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              結帳中…
            </>
          ) : (
            `結帳 NT$ ${totalAmount.toLocaleString("zh-TW")}`
          )}
        </Button>
      </div>

      {blocked ? (
        <p className="text-center text-xs text-muted-foreground">
          庫存不足，請調整數量或勾選上面的強制放行
        </p>
      ) : null}
    </div>
  );
}
