/**
 * 套餐結帳的右欄。與單品的 CheckoutPanel.tsx 同一套規矩：
 *
 * · 強制放行**只在真的不夠組時才出現**，預設關著，文字直說會發生什麼事。
 * · 這裡顯示的應收是 `組合價 × 份數`，只是給人看的預覽 —— 真正寫進資料庫的金額
 *   是 inv_combo_checkout() 算的，這個元件不送任何金額欄位。
 */
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
import { basisLabel } from "@/components/pos/combo-basis";
import type { PosPaymentMethod } from "@/server/repos/inv-sales";
import type { AdminComboSetRow } from "@/server/repos/inv-combos";

type Props = {
  set: AdminComboSetRow | null;
  sets: number;
  onSetsChange: (sets: number) => void;
  paymentMethods: PosPaymentMethod[];
  paymentMethodId: string | null;
  onPaymentMethodChange: (id: string | null) => void;
  notes: string;
  onNotesChange: (notes: string) => void;
  override: boolean;
  onOverrideChange: (on: boolean) => void;
  onSubmit: () => void;
  submitting: boolean;
};

export function ComboCheckoutPanel({
  set,
  sets,
  onSetsChange,
  paymentMethods,
  paymentMethodId,
  onPaymentMethodChange,
  notes,
  onNotesChange,
  override,
  onOverrideChange,
  onSubmit,
  submitting,
}: Props) {
  const preview = set ? Number(set.selling_price) * sets : 0;
  // max_sets 是 null 代表這組沒有組成品項 —— 那不是「無限」，是根本賣不了，
  // 資料庫端會直接擋下來。
  const maxSets = set?.max_sets ?? null;
  const shortfall = maxSets !== null && sets > maxSets ? sets - maxSets : 0;
  const blocked = !set || sets < 1 || (shortfall > 0 && !override);

  return (
    <div className="space-y-4 rounded-md border border-border p-4">
      {set ? (
        <div className="space-y-1.5">
          <p className="truncate text-sm font-medium">{set.name}</p>
          <p className="text-xs text-muted-foreground">
            組合價 NT$ {Number(set.selling_price).toLocaleString("zh-TW")}・
            {basisLabel(set.allocation_basis)}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">先在左邊選一組套餐</p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="combo-sets">份數</Label>
        <Input
          id="combo-sets"
          type="number"
          min={1}
          max={100}
          value={sets}
          onChange={(e) => {
            const next = Number.parseInt(e.target.value, 10);
            onSetsChange(Number.isFinite(next) ? next : 1);
          }}
          className="tabular-nums"
          disabled={submitting || !set}
        />
        {set && set.item_count > 0 && set.unlimited_items === set.item_count ? (
          // 0062：組成品項全部是不限庫存，max_sets 只是單次上限（100），不是庫存。
          <p className="text-xs text-muted-foreground">組成品項皆為不限庫存</p>
        ) : maxSets !== null ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            以現在的庫存還能組 {maxSets} 份
          </p>
        ) : null}
      </div>

      <Separator />

      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">應收</span>
        <span className="text-xl font-medium tabular-nums">
          NT$ {preview.toLocaleString("zh-TW")}
        </span>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="combo-payment-method">付款方式</Label>
        <Select
          value={paymentMethodId ?? ""}
          onValueChange={(v) => onPaymentMethodChange(v || null)}
          disabled={submitting}
        >
          <SelectTrigger id="combo-payment-method">
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
        <Label htmlFor="combo-notes">備註（選填）</Label>
        <Input
          id="combo-notes"
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="例如：華山活動、員工價"
          maxLength={500}
          disabled={submitting}
        />
      </div>

      {shortfall > 0 ? (
        <div className="space-y-2.5 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <div className="space-y-1 text-sm">
              <p className="font-medium text-destructive">組成品項的庫存不夠</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                現在只組得出 {maxSets} 份，這一單要 {sets} 份，差 {shortfall} 份。
              </p>
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-md bg-background/60 p-2.5">
            <Checkbox
              checked={override}
              onCheckedChange={(v) => onOverrideChange(v === true)}
              disabled={submitting}
              aria-describedby="combo-override-help"
              className="mt-0.5"
            />
            <span className="space-y-1 text-xs leading-relaxed">
              <span className="block font-medium">客人就站在櫃檯，我確認架上有貨，先賣</span>
              <span id="combo-override-help" className="block text-muted-foreground">
                勾了會照樣結帳，組成品項的庫存可能變成負數。系統會把這件事記進「賣超告警」，
                之後要有人去盤點對帳。如果那些貨有一部分是網站客人已經下單保留的，
                賣掉之後那張訂單會出不了貨。
              </span>
            </span>
          </label>
        </div>
      ) : null}

      <Button type="button" className="w-full" onClick={onSubmit} disabled={submitting || blocked}>
        {submitting ? (
          <>
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            結帳中…
          </>
        ) : (
          `結帳 NT$ ${preview.toLocaleString("zh-TW")}`
        )}
      </Button>

      {blocked && set ? (
        <p className="text-center text-xs text-muted-foreground">
          {shortfall > 0 ? "庫存不足，請調整份數或勾選上面的強制放行" : "份數至少 1 份"}
        </p>
      ) : null}
    </div>
  );
}
