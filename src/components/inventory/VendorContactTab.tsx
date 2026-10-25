/**
 * 廠商表單分頁二：聯絡。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。上半是廠商主檔上的
 * 聯絡欄位（跟著 vendorSchema 一起存），下半是**獨立的**聯絡人子表 —— 那是掛在
 * vendor_id 底下的另一支 RPC，所以新增模式下會顯示「先儲存基本資料」。
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { TabsContent } from "@/components/ui/tabs";
import { VendorContactSection } from "@/components/inventory/VendorContactSection";
import type { FormState } from "@/components/inventory/VendorFormState";
import type { AdminVendorContact } from "@/server/repos/inv-vendors";

type Props = {
  form: FormState;
  busy: boolean;
  /** null = 還沒儲存過，子表整個換成提示。 */
  vendorId: string | null;
  contacts: AdminVendorContact[];
  onPatch: (next: Partial<FormState>) => void;
  onReload: () => Promise<void>;
  onDraftDirtyChange?: (dirty: boolean) => void;
};

export function VendorContactTab({
  form,
  busy,
  vendorId,
  contacts,
  onPatch,
  onReload,
  onDraftDirtyChange,
}: Props) {
  return (
    <TabsContent value="contact" className="space-y-4 pt-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="vendor-phone">電話</Label>
          <Input
            id="vendor-phone"
            value={form.phone}
            disabled={busy}
            onChange={(e) => onPatch({ phone: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="vendor-fax">傳真</Label>
          <Input
            id="vendor-fax"
            value={form.fax}
            disabled={busy}
            onChange={(e) => onPatch({ fax: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="vendor-email">電子郵件</Label>
          <Input
            id="vendor-email"
            type="email"
            value={form.email}
            disabled={busy}
            onChange={(e) => onPatch({ email: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="vendor-address">地址</Label>
          <Input
            id="vendor-address"
            value={form.address}
            disabled={busy}
            onChange={(e) => onPatch({ address: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="vendor-address-en">英文地址</Label>
          <Input
            id="vendor-address-en"
            value={form.address_en}
            disabled={busy}
            onChange={(e) => onPatch({ address_en: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="vendor-invoice-address">發票寄送地址</Label>
          <Input
            id="vendor-invoice-address"
            placeholder="與公司地址不同時才填"
            value={form.invoice_address}
            disabled={busy}
            onChange={(e) => onPatch({ invoice_address: e.target.value })}
          />
        </div>
      </div>

      <Separator />

      <VendorContactSection
        vendorId={vendorId}
        rows={contacts}
        disabled={busy}
        onReload={onReload}
        onDirtyChange={onDraftDirtyChange}
      />
    </TabsContent>
  );
}
