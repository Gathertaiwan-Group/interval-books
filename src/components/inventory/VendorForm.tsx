/**
 * 新增／編輯廠商 —— 四個分頁：基本／識別、聯絡、財務／寄售、附件／合約。
 *
 * 2026-10-25 從 VendorFormDialog 改成內頁的本體（/admin/inventory-vendors/new 與
 * /admin/inventory-vendors/$id/edit）。資料由 route loader 給（與詳情頁共用同一個
 * loader，「詳情 → 編輯」不再重抓一次 getAdminVendor），存檔、閘門、分頁一行都沒改。
 *
 * inv.vendors 有四十幾欄，來源系統把它攤成十個分頁，於是「一家新廠商要填什麼」沒有人
 * 答得出來。這裡收斂成四個，分法是**依誰會來填**：門市建檔的人填第一頁，採購填第二頁，
 * 會計填第三頁，簽約的人填第四頁。同一個人不需要一次走完四頁。
 *
 * ⚠️ **遮罩值絕對不可以當成輸入框的預設值**（見 VendorIdentityField）。由此推出一件
 *    使用者一定會問的事：**編輯既有廠商時，識別碼必須重新輸入**，不然儲存會被下面的
 *    lockedKeys 擋下來。
 *
 * ⚠️ **子表要先有廠商才能存。** 聯絡人／匯款帳戶／附件都是掛在 vendor_id 底下的獨立
 *    RPC，新增模式下還沒有 id，所以那三區會顯示「先儲存基本資料」。子表各自的 RPC 寫完
 *    之後呼叫 onReloadChildren（router.invalidate()），表單裡打到一半的欄位不受影響。
 *
 * ⚠️ payload 裡**沒有** approval_status / approved_by / created_by / vendor_code。四個
 *    都由資料庫決定（0019 §5.1）。見 toVendorPayload。
 */
import { useState } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { VendorAttachmentSection } from "@/components/inventory/VendorAttachmentSection";
import { VendorBasicTab } from "@/components/inventory/VendorBasicTab";
import { VendorContactTab } from "@/components/inventory/VendorContactTab";
import { VendorFinanceTab } from "@/components/inventory/VendorFinanceTab";
import {
  SENSITIVE_KEYS,
  SENSITIVE_LABELS,
  type SensitiveKey,
} from "@/components/inventory/VendorFieldLabels";
import {
  EMPTY_FORM,
  formFromDetail,
  toVendorPayload,
  type FormState,
} from "@/components/inventory/VendorFormState";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { vendorSchema } from "@/lib/admin/schemas";
import type {
  AdminVendorAttachment,
  AdminVendorBankAccount,
  AdminVendorContact,
  AdminVendorDetail,
  AdminVendorRow,
  TaxTypeRow,
  VendorCategoryRow,
  WithholdingRow,
} from "@/server/repos/inv-vendors";

type Props = {
  approvalOn: boolean;
  /** null = 新增。 */
  editing: AdminVendorRow | null;
  detail: AdminVendorDetail | null;
  contacts: AdminVendorContact[];
  bankAccounts: AdminVendorBankAccount[];
  attachments: AdminVendorAttachment[];
  categories: VendorCategoryRow[];
  taxTypes: TaxTypeRow[];
  withholdingCategories: WithholdingRow[];
  /** 「← 回到…」：編輯回詳情頁、新增回列表。 */
  back: { to: string; label: string; also?: readonly string[] };
  /** 子表寫完之後重跑 loader。 */
  onReloadChildren: () => Promise<void>;
  /** 存檔成功（已經 allowLeave）：呼叫端負責換頁。 */
  onSaved: (vendorId: string) => Promise<void>;
};

export function VendorForm({
  approvalOn,
  editing,
  detail,
  contacts,
  bankAccounts,
  attachments,
  categories,
  taxTypes,
  withholdingCategories,
  back,
  onReloadChildren,
  onSaved,
}: Props) {
  // 只在掛載時從 detail 填一次：loader 之後重跑（子表寫完）不可以蓋掉打到一半的欄位。
  const [form, setForm] = useState<FormState>(() => (detail ? formFromDetail(detail) : EMPTY_FORM));
  const [changing, setChanging] = useState<Record<SensitiveKey, boolean>>({
    tax_id: false,
    id_number: false,
    foreign_id: false,
    residence_permit_number: false,
  });
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("basic");

  const vendorId = editing?.vendor_id ?? null;

  const { dirty } = useFormDirty({ form, changing });
  const guard = useUnsavedChangesGuard(dirty && !saving);

  function patch(next: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...next }));
  }

  const masks: Record<SensitiveKey, string | null> = {
    tax_id: detail?.tax_id_masked ?? null,
    id_number: detail?.id_number_masked ?? null,
    foreign_id: detail?.foreign_id_masked ?? null,
    residence_permit_number: detail?.residence_permit_number_masked ?? null,
  };

  /** 還沒按「更改」、卻已經有值的識別碼。有任何一個就不讓存 —— 理由見檔頭第 1 點。 */
  const lockedKeys = SENSITIVE_KEYS.filter((key) => masks[key] !== null && !changing[key]);

  async function save() {
    if (lockedKeys.length > 0) {
      toast.error(
        `請先按「更改」重新輸入完整的${lockedKeys.map((k) => SENSITIVE_LABELS[k]).join("、")}` +
          "（系統讀不回原值，儲存會直接覆寫資料庫）",
      );
      setTab("basic");
      return;
    }

    const parsed = vendorSchema.safeParse(toVendorPayload(form, vendorId));

    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查填寫的內容");
      return;
    }

    setSaving(true);
    try {
      const { saveVendor } = await import("@/lib/admin/fns/inv-vendors");
      const result = await saveVendor({ data: parsed.data });
      toast.success(
        result.approval_status === "approved"
          ? `「${parsed.data.name}」已儲存（${result.vendor_code}）`
          : `「${parsed.data.name}」已儲存待審核（${result.vendor_code}），核准後才能開始往來`,
      );
      guard.allowLeave();
      await onSaved(result.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "廠商儲存失敗");
    } finally {
      setSaving(false);
    }
  }

  const busy = saving;

  const actions = (
    <Button className="gap-1.5" disabled={busy} onClick={() => void save()}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      儲存
    </Button>
  );

  return (
    <AdminDetailPage
      backTo={back.to}
      backLabel={back.label}
      backAlso={back.also}
      title={editing ? `編輯廠商：${editing.name}` : "新增廠商"}
      meta={
        editing
          ? `${editing.vendor_code ?? "（未編號）"}・編輯不會改變審核狀態。`
          : approvalOn
            ? "廠商目前需要審核：儲存之後會進入待審核，核准後才能開始往來。"
            : "廠商目前不需要審核，儲存後即可開始往來。"
      }
      actions={actions}
      width="lg"
    >
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full flex-wrap">
          <TabsTrigger value="basic">基本／識別</TabsTrigger>
          <TabsTrigger value="contact">聯絡</TabsTrigger>
          <TabsTrigger value="finance">財務／寄售</TabsTrigger>
          <TabsTrigger value="files">附件／合約</TabsTrigger>
        </TabsList>

        <VendorBasicTab
          form={form}
          busy={busy}
          editing={editing}
          categories={categories}
          masks={masks}
          changing={changing}
          onPatch={patch}
          setChanging={setChanging}
        />

        <VendorContactTab
          form={form}
          busy={busy}
          vendorId={vendorId}
          contacts={contacts}
          onPatch={patch}
          onReload={onReloadChildren}
        />

        <VendorFinanceTab
          form={form}
          busy={busy}
          taxTypes={taxTypes}
          withholdingCategories={withholdingCategories}
          vendorId={vendorId}
          bankAccounts={bankAccounts}
          onPatch={patch}
          onReload={onReloadChildren}
        />

        <TabsContent value="files" className="space-y-4 pt-4">
          <VendorAttachmentSection
            vendorId={vendorId}
            rows={attachments}
            disabled={busy}
            onReload={onReloadChildren}
          />
        </TabsContent>
      </Tabs>

      <div className="hidden justify-end md:flex">{actions}</div>
      {guard.dialog}
    </AdminDetailPage>
  );
}
