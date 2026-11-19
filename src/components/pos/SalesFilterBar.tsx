import { RotateCcw } from "lucide-react";
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
import type { PosPaymentMethod, SalesSellerOption } from "@/server/repos/inv-sales";
import type { SalesFilterValues } from "@/lib/admin/schemas";

/**
 * 銷售紀錄的篩選列。
 *
 * ⚠️ 這裡只負責收集條件，**不做任何過濾**。條件會原封不動送到 server fn，由
 *    資料庫去 where。來源系統是抓全表再前端 Array.filter，665 筆時看不出差別，
 *    但那條路走下去每一次篩選都要重抓整張表。
 */
type Props = {
  value: SalesFilterValues;
  onChange: (next: SalesFilterValues) => void;
  paymentMethods: PosPaymentMethod[];
  /** 經手人下拉：有銷售紀錄的人員（＋「網站」）。見 listSalesSellers()。 */
  sellers: SalesSellerOption[];
  disabled?: boolean;
};

const ALL = "__all__";

export function SalesFilterBar({ value, onChange, paymentMethods, sellers, disabled }: Props) {
  /** 改任何條件都要回到第 1 頁 —— 停在第 5 頁然後看到空白是最容易誤會的畫面。 */
  function set(patch: Partial<SalesFilterValues>) {
    onChange({ ...value, ...patch, page: 0 });
  }

  return (
    <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
      <div className="space-y-1.5">
        <Label htmlFor="sales-from" className="text-xs">
          起始日
        </Label>
        <Input
          id="sales-from"
          type="date"
          value={value.from ?? ""}
          onChange={(e) => set({ from: e.target.value || null })}
          disabled={disabled}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sales-to" className="text-xs">
          結束日
        </Label>
        <Input
          id="sales-to"
          type="date"
          value={value.to ?? ""}
          onChange={(e) => set({ to: e.target.value || null })}
          disabled={disabled}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sales-channel" className="text-xs">
          通路
        </Label>
        <Select
          value={value.channel}
          onValueChange={(v) => set({ channel: v as SalesFilterValues["channel"] })}
          disabled={disabled}
        >
          <SelectTrigger id="sales-channel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="pos">門市</SelectItem>
            <SelectItem value="online">網站</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sales-payment" className="text-xs">
          付款方式
        </Label>
        <Select
          value={value.paymentMethodId ?? ALL}
          onValueChange={(v) => set({ paymentMethodId: v === ALL ? null : v })}
          disabled={disabled}
        >
          <SelectTrigger id="sales-payment">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部</SelectItem>
            {paymentMethods.map((m) => (
              <SelectItem key={m.payment_method_id} value={m.payment_method_id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sales-seller" className="text-xs">
          經手人
        </Label>
        <Select
          value={value.seller ?? ALL}
          onValueChange={(v) => set({ seller: v === ALL ? null : v })}
          disabled={disabled}
        >
          <SelectTrigger id="sales-seller">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部</SelectItem>
            {sellers.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.name}（{s.count.toLocaleString("zh-TW")}）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sales-reconciled" className="text-xs">
          對帳狀態
        </Label>
        <Select
          value={value.reconciled}
          onValueChange={(v) => set({ reconciled: v as SalesFilterValues["reconciled"] })}
          disabled={disabled}
        >
          <SelectTrigger id="sales-reconciled">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="no">未對帳</SelectItem>
            <SelectItem value="yes">已對帳</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sales-keyword" className="text-xs">
          關鍵字
        </Label>
        <div className="flex gap-1.5">
          <Input
            id="sales-keyword"
            value={value.keyword ?? ""}
            onChange={(e) => set({ keyword: e.target.value || null })}
            placeholder="書名、期數、備註"
            disabled={disabled}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() =>
              onChange({
                from: null,
                to: null,
                channel: "all",
                keyword: null,
                reconciled: "all",
                paymentMethodId: null,
                seller: null,
                page: 0,
                pageSize: value.pageSize,
              })
            }
            disabled={disabled}
            aria-label="清除所有篩選"
            title="清除所有篩選"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
