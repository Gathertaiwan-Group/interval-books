/**
 * 廠商表單分頁三：財務／寄售。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。這一頁是會計填的。
 * 這個檔案只留「開什麼單」那半段（稅別、扣繳、憑證、電子發票、二代健保），另外三塊各自
 * 成檔：
 *   VendorSettlementFields  ← 什麼時候付錢（付款條件、結算、請款截止日）
 *   VendorFeeRateFields     ← 寄售與四個費率（畫面填百分比，送出前才 ÷100）
 *   VendorBankSection       ← 匯款帳戶（獨立的子表 RPC，新增模式下存不了）
 */
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { TabsContent } from "@/components/ui/tabs";
import { VendorBankSection } from "@/components/inventory/VendorBankSection";
import { VendorFeeRateFields } from "@/components/inventory/VendorFeeRateFields";
import { VendorSettlementFields } from "@/components/inventory/VendorSettlementFields";
import {
  EINVOICE_LABELS,
  NONE,
  VOUCHER_LABELS,
  type EinvoiceType,
  type VoucherCategory,
} from "@/components/inventory/VendorFieldLabels";
import type { FormState } from "@/components/inventory/VendorFormState";
import { VENDOR_EINVOICE_TYPES, VENDOR_VOUCHER_CATEGORIES } from "@/lib/admin/schemas";
import type {
  AdminVendorBankAccount,
  TaxTypeRow,
  WithholdingRow,
} from "@/server/repos/inv-vendors";

type Props = {
  form: FormState;
  busy: boolean;
  taxTypes: TaxTypeRow[];
  withholdingCategories: WithholdingRow[];
  /** null = 還沒儲存過，匯款帳戶整個換成提示。 */
  vendorId: string | null;
  bankAccounts: AdminVendorBankAccount[];
  onPatch: (next: Partial<FormState>) => void;
  onReload: () => Promise<void>;
  onDraftDirtyChange?: (dirty: boolean) => void;
};

export function VendorFinanceTab({
  form,
  busy,
  taxTypes,
  withholdingCategories,
  vendorId,
  bankAccounts,
  onPatch,
  onReload,
  onDraftDirtyChange,
}: Props) {
  return (
    <TabsContent value="finance" className="space-y-4 pt-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="vendor-tax-type">預設稅別</Label>
          <Select
            value={form.default_tax_type_id ?? NONE}
            disabled={busy}
            onValueChange={(v) => onPatch({ default_tax_type_id: v === NONE ? null : v })}
          >
            <SelectTrigger id="vendor-tax-type">
              <SelectValue placeholder="未指定" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>未指定</SelectItem>
              {taxTypes.map((t) => (
                <SelectItem key={t.tax_type_id} value={t.tax_type_id}>
                  {t.code}・{t.name}（{Number((t.rate * 100).toFixed(2))}%）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vendor-withholding">預設扣繳類別</Label>
          <Select
            value={form.default_withholding_category_id ?? NONE}
            disabled={busy}
            onValueChange={(v) =>
              onPatch({ default_withholding_category_id: v === NONE ? null : v })
            }
          >
            <SelectTrigger id="vendor-withholding">
              <SelectValue placeholder="未指定" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>未指定</SelectItem>
              {withholdingCategories.map((w) => (
                <SelectItem key={w.withholding_category_id} value={w.withholding_category_id}>
                  {w.code}・{w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vendor-voucher">憑證種類</Label>
          <Select
            value={form.voucher_category}
            disabled={busy}
            onValueChange={(v) => onPatch({ voucher_category: v as VoucherCategory })}
          >
            <SelectTrigger id="vendor-voucher">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VENDOR_VOUCHER_CATEGORIES.map((code) => (
                <SelectItem key={code} value={code}>
                  {VOUCHER_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vendor-einvoice">電子發票</Label>
          <Select
            value={form.einvoice_type}
            disabled={busy}
            onValueChange={(v) => onPatch({ einvoice_type: v as EinvoiceType })}
          >
            <SelectTrigger id="vendor-einvoice">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VENDOR_EINVOICE_TYPES.map((code) => (
                <SelectItem key={code} value={code}>
                  {EINVOICE_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 rounded-md border border-border p-3 sm:col-span-2">
          <Switch
            id="vendor-nhi"
            checked={form.is_nhi_applicable}
            disabled={busy}
            onCheckedChange={(v) => onPatch({ is_nhi_applicable: v })}
          />
          <Label htmlFor="vendor-nhi" className="cursor-pointer">
            需扣二代健保補充保費
          </Label>
        </div>

        <VendorSettlementFields form={form} busy={busy} onPatch={onPatch} />
      </div>

      <VendorFeeRateFields form={form} busy={busy} onPatch={onPatch} />

      <Separator />

      <VendorBankSection
        vendorId={vendorId}
        rows={bankAccounts}
        disabled={busy}
        onReload={onReload}
        onDirtyChange={onDraftDirtyChange}
      />
    </TabsContent>
  );
}
