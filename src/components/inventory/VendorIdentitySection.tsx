/**
 * 基本／識別分頁裡的「識別碼」那一區。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。這一區與旁邊的
 * 基本欄位是兩種東西：那些是誰都能改的文字，這幾格改一次就會覆寫資料庫裡的 PII。
 *
 * ⚠️ 顯示條件（visible）是兩個來源的**聯集**，第二條不能省 —— 理由寫在下面。
 *
 * ⚠️ 這裡只決定「畫不畫、星號標在哪」。四條必填規則在 vendorSchema 與
 *    inv_save_vendor() 各守一次，遮罩不可寫回的那條線在 VendorIdentityField。
 */
import type { Dispatch, SetStateAction } from "react";
import { ShieldAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IdentityField } from "@/components/inventory/VendorIdentityField";
import {
  NONE,
  RESIDENCY_LABELS,
  SENSITIVE_LABELS,
  type EntityType,
  type ResidencyStatus,
  type SensitiveKey,
} from "@/components/inventory/VendorFieldLabels";
import type { FormState } from "@/components/inventory/VendorFormState";
import { VENDOR_RESIDENCY_STATUSES } from "@/lib/admin/schemas";
import type { AdminVendorRow } from "@/server/repos/inv-vendors";

type Props = {
  /** null = 新增。有值才會出現「遮罩不可寫回」那段警告。 */
  editing: AdminVendorRow | null;
  entity: EntityType;
  form: FormState;
  busy: boolean;
  masks: Record<SensitiveKey, string | null>;
  changing: Record<SensitiveKey, boolean>;
  onPatch: (next: Partial<FormState>) => void;
  setChanging: Dispatch<SetStateAction<Record<SensitiveKey, boolean>>>;
};

export function VendorIdentitySection({
  editing,
  entity,
  form,
  busy,
  masks,
  changing,
  onPatch,
  setChanging,
}: Props) {
  /**
   * 哪幾個識別碼要畫出來 —— 兩個來源的**聯集**：
   *   ① 這個 entity_type 用得到的（新增時只有這一條）
   *   ② 這家**已經有值**的，不管現在的 entity_type 是什麼
   *
   * ⚠️ 第二條不能省。inv.vendors 的 CHECK 只管「該填的有沒有填」，沒有禁止一家
   *    domestic_company 同時留著 id_number（0009 從舊系統搬進來的資料就可能這樣）。
   *    如果只照 entity_type 顯示，那個有值卻沒被畫出來的欄位會永遠停在「還沒按更改」
   *    的狀態 —— 於是 lockedKeys 擋住儲存，而使用者在畫面上根本找不到要按哪一顆。
   *    畫出來，他才有辦法重新輸入或清掉它。
   */
  const visible: Record<SensitiveKey, boolean> = {
    tax_id: form.entity_type === "domestic_company" || masks.tax_id !== null,
    id_number: form.entity_type === "domestic_individual" || masks.id_number !== null,
    foreign_id:
      form.entity_type === "foreign" ||
      form.entity_type === "foreign_individual" ||
      masks.foreign_id !== null,
    residence_permit_number:
      form.entity_type === "foreign_individual" || masks.residence_permit_number !== null,
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />
        <p className="text-sm font-medium">識別碼</p>
      </div>

      {editing ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          畫面上顯示的是<strong>遮罩</strong>，完整號碼沒有送到瀏覽器。
          <strong>更改識別碼需要重新輸入完整號碼</strong> —— 儲存是直接覆寫，
          把遮罩存回去等於毀掉這家廠商的統編。要查原值請用清單上的「完整號碼」，
          那會留下一筆查閱紀錄。
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* 顯示條件見上面的 visible：entity_type 用得到的 ∪ 這家已經有值的。
            必填規則在 vendorSchema 與 inv_save_vendor() 各守一次（國內個人的身分證字號自 0061 起選填），
            這裡的 required 只是把星號畫在對的地方。 */}
        {visible.tax_id ? (
          <IdentityField
            id="vendor-tax-id"
            label={SENSITIVE_LABELS.tax_id}
            masked={masks.tax_id}
            changing={changing.tax_id}
            value={form.tax_id}
            disabled={busy}
            required={entity === "domestic_company"}
            onStartChange={() => setChanging((p) => ({ ...p, tax_id: true }))}
            onCancelChange={() => {
              setChanging((p) => ({ ...p, tax_id: false }));
              onPatch({ tax_id: "" });
            }}
            onChange={(v) => onPatch({ tax_id: v })}
          />
        ) : null}

        {visible.id_number ? (
          <IdentityField
            id="vendor-id-number"
            label={
              entity === "domestic_individual"
                ? `${SENSITIVE_LABELS.id_number}（選填）`
                : SENSITIVE_LABELS.id_number
            }
            masked={masks.id_number}
            changing={changing.id_number}
            value={form.id_number}
            disabled={busy}
            // 國內個人的身分證字號選填（0061）：個人戶可能不方便提供。
            required={false}
            hint={
              entity === "domestic_individual"
                ? "個人戶可不填，日後需開立扣繳憑單時再補"
                : undefined
            }
            onStartChange={() => setChanging((p) => ({ ...p, id_number: true }))}
            onCancelChange={() => {
              setChanging((p) => ({ ...p, id_number: false }));
              onPatch({ id_number: "" });
            }}
            onChange={(v) => onPatch({ id_number: v })}
          />
        ) : null}

        {visible.foreign_id ? (
          <IdentityField
            id="vendor-foreign-id"
            label={SENSITIVE_LABELS.foreign_id}
            masked={masks.foreign_id}
            changing={changing.foreign_id}
            value={form.foreign_id}
            disabled={busy}
            required={entity === "foreign"}
            onStartChange={() => setChanging((p) => ({ ...p, foreign_id: true }))}
            onCancelChange={() => {
              setChanging((p) => ({ ...p, foreign_id: false }));
              onPatch({ foreign_id: "" });
            }}
            onChange={(v) => onPatch({ foreign_id: v })}
          />
        ) : null}

        {entity === "foreign" || entity === "foreign_individual" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="vendor-foreign-id-type">識別碼種類</Label>
              <Input
                id="vendor-foreign-id-type"
                placeholder="例：護照號碼、稅籍編號"
                value={form.foreign_id_type}
                disabled={busy}
                onChange={(e) => onPatch({ foreign_id_type: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="vendor-country">國別代碼</Label>
              <Input
                id="vendor-country"
                placeholder="例：JP、US（三碼以內）"
                maxLength={3}
                value={form.country_code}
                disabled={busy}
                onChange={(e) => onPatch({ country_code: e.target.value })}
              />
            </div>
          </>
        ) : null}

        {visible.residence_permit_number ? (
          <IdentityField
            id="vendor-permit"
            label={SENSITIVE_LABELS.residence_permit_number}
            masked={masks.residence_permit_number}
            changing={changing.residence_permit_number}
            value={form.residence_permit_number}
            disabled={busy}
            // 居留證號碼永遠不是單獨必填的：foreign_individual 只要求
            // 「國外識別碼或居留證號碼至少一個」，那條規則由 zod 的 refine 判。
            required={false}
            onStartChange={() => setChanging((p) => ({ ...p, residence_permit_number: true }))}
            onCancelChange={() => {
              setChanging((p) => ({ ...p, residence_permit_number: false }));
              onPatch({ residence_permit_number: "" });
            }}
            onChange={(v) => onPatch({ residence_permit_number: v })}
          />
        ) : null}

        {entity === "foreign_individual" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="vendor-residency">在台居留狀態</Label>
              <Select
                value={form.taiwan_residency_status ?? NONE}
                disabled={busy}
                onValueChange={(v) =>
                  onPatch({
                    taiwan_residency_status: v === NONE ? null : (v as ResidencyStatus),
                  })
                }
              >
                <SelectTrigger id="vendor-residency">
                  <SelectValue placeholder="未指定" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>未指定</SelectItem>
                  {VENDOR_RESIDENCY_STATUSES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {RESIDENCY_LABELS[code]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">影響扣繳稅率，會計要看。</p>
            </div>
          </>
        ) : null}

        {entity === "foreign_individual" ? (
          <p className="text-xs text-muted-foreground sm:col-span-2">
            國外個人：國外識別碼與居留證號碼<strong>至少要填一個</strong>。
          </p>
        ) : null}
      </div>
    </div>
  );
}
