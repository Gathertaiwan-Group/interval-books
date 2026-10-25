/**
 * 廠商的匯款帳戶子表（清單 + 新增／編輯／刪除）。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。編輯表單在
 * VendorBankForm。
 *
 * ⚠️ 清單上的帳號**永遠是遮罩**。完整帳號走 VendorSensitiveDialog（會留下一筆
 *    pii_access_log），這裡不放捷徑。
 */
import { useOpenDraftDirty, useReportChildDirty } from "@/lib/admin/useChildDraftDirty";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChildPlaceholder } from "@/components/inventory/VendorChildPlaceholder";
import { VendorBankForm } from "@/components/inventory/VendorBankForm";
import { EMPTY_BANK, type BankDraft } from "@/components/inventory/VendorChildDrafts";
import { intOrNull, nz } from "@/components/inventory/VendorFormParsers";
import { vendorBankAccountSchema } from "@/lib/admin/schemas";
import type { AdminVendorBankAccount } from "@/server/repos/inv-vendors";

/**
 * 匯款帳戶。
 *
 * ⚠️ 帳號與識別碼是同一個問題：清單回來的是 `account_number_masked`，
 *    `vendorBankAccountSchema.account_number` 又是必填，所以編輯既有帳戶時必須
 *    重新輸入完整帳號。這裡沿用同一顆「更改」按鈕，理由見檔頭第 1 點。
 */
export function VendorBankSection({
  vendorId,
  rows,
  disabled,
  onReload,
  onDirtyChange,
}: {
  vendorId: string | null;
  rows: AdminVendorBankAccount[];
  disabled: boolean;
  onReload: () => Promise<void>;
  /** 有打到一半、還沒存的匯款帳戶草稿（併進內頁的未存變更防呆）。 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<BankDraft | null>(null);
  useReportChildDirty(useOpenDraftDirty(draft), onDirtyChange);
  const [busy, setBusy] = useState(false);

  if (!vendorId) {
    return <ChildPlaceholder>先把基本資料存起來，才能新增匯款帳戶。</ChildPlaceholder>;
  }

  async function save() {
    if (!draft || !vendorId) return;
    if (draft.masked !== null && !draft.changingNumber) {
      toast.error("請先按「更改」重新輸入完整帳號（系統讀不回原值，儲存會直接覆寫）");
      return;
    }

    const parsed = vendorBankAccountSchema.safeParse({
      id: draft.id,
      account_holder_name: draft.account_holder_name,
      bank_code: draft.bank_code,
      bank_name: draft.bank_name,
      branch_code: nz(draft.branch_code),
      branch_name: nz(draft.branch_name),
      account_number: draft.account_number,
      account_purpose: nz(draft.account_purpose),
      is_default: draft.is_default,
      notes: nz(draft.notes),
      sort_order: intOrNull(draft.sort_order) ?? 0,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查匯款帳戶的內容");
      return;
    }

    setBusy(true);
    try {
      const { saveVendorBankAccount } = await import("@/lib/admin/fns/inv-vendors");
      await saveVendorBankAccount({ data: { vendorId, account: parsed.data } });
      toast.success(`匯款帳戶「${parsed.data.account_holder_name}」已儲存`);
      setDraft(null);
      await onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "匯款帳戶儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: AdminVendorBankAccount) {
    if (!vendorId) return;
    setBusy(true);
    try {
      const { deleteVendorChild } = await import("@/lib/admin/fns/inv-vendors");
      await deleteVendorChild({
        data: { kind: "bank_account", vendorId, id: row.bank_account_id },
      });
      toast.success(`已刪除「${row.account_holder_name}」的匯款帳戶`);
      await onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">匯款帳戶（{rows.length}）</p>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={disabled || busy || draft !== null}
          onClick={() => setDraft(EMPTY_BANK)}
        >
          <Plus className="h-3.5 w-3.5" />
          新增帳戶
        </Button>
      </div>

      {rows.length === 0 && draft === null ? (
        <p className="text-sm text-muted-foreground">還沒有匯款帳戶。</p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.bank_account_id}
            className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3"
          >
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {row.account_holder_name}
                {row.is_default ? (
                  <Badge variant="secondary" className="ml-1.5 font-normal">
                    預設
                  </Badge>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {row.bank_code} {row.bank_name}
                {row.branch_name ? `・${row.branch_name}` : ""}
              </p>
              {/* ⚠️ 這裡永遠是遮罩。完整帳號走 VendorSensitiveDialog（會留紀錄）。 */}
              <p className="font-mono text-xs tabular-nums text-muted-foreground">
                {row.account_number_masked ?? "—"}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || busy}
                onClick={() =>
                  setDraft({
                    id: row.bank_account_id,
                    masked: row.account_number_masked,
                    changingNumber: false,
                    account_holder_name: row.account_holder_name,
                    bank_code: row.bank_code,
                    bank_name: row.bank_name,
                    branch_code: row.branch_code ?? "",
                    branch_name: row.branch_name ?? "",
                    account_number: "",
                    account_purpose: row.account_purpose ?? "",
                    is_default: row.is_default ?? false,
                    notes: row.notes ?? "",
                    sort_order: row.sort_order?.toString() ?? "0",
                  })
                }
              >
                編輯
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10"
                disabled={disabled || busy}
                onClick={() => void remove(row)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {draft ? (
        <VendorBankForm
          draft={draft}
          busy={busy}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => void save()}
        />
      ) : null}
    </div>
  );
}
