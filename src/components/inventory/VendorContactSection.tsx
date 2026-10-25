/**
 * 廠商的聯絡人子表（清單 + 新增／編輯／刪除）。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。
 *
 * ⚠️ 聯絡人是掛在 vendor_id 底下的**獨立 RPC**，新增模式下還沒有 id，所以那時候整個
 *    換成 ChildPlaceholder。這比先在前端存一份草稿再一次送出好：草稿送出到一半失敗的
 *    話，使用者看不出來哪幾筆存進去了。
 *
 * ⚠️ 寫完只重抓（onReload），不猜結果 —— 排序與 is_primary 的互斥都是資料庫在管。
 */
import { useOpenDraftDirty, useReportChildDirty } from "@/lib/admin/useChildDraftDirty";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChildPlaceholder } from "@/components/inventory/VendorChildPlaceholder";
import { VendorContactForm } from "@/components/inventory/VendorContactForm";
import { EMPTY_CONTACT, type ContactDraft } from "@/components/inventory/VendorChildDrafts";
import { intOrNull, nz } from "@/components/inventory/VendorFormParsers";
import { vendorContactSchema } from "@/lib/admin/schemas";
import type { AdminVendorContact } from "@/server/repos/inv-vendors";

export function VendorContactSection({
  vendorId,
  rows,
  disabled,
  onReload,
  onDirtyChange,
}: {
  vendorId: string | null;
  rows: AdminVendorContact[];
  disabled: boolean;
  onReload: () => Promise<void>;
  /** 有打到一半、還沒存的聯絡人草稿（併進內頁的未存變更防呆）。 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  useReportChildDirty(useOpenDraftDirty(draft), onDirtyChange);
  const [busy, setBusy] = useState(false);

  if (!vendorId) {
    return (
      <ChildPlaceholder>
        先把基本資料存起來，才能新增聯絡人 —— 聯絡人是掛在廠商底下的獨立資料。
      </ChildPlaceholder>
    );
  }

  async function save() {
    if (!draft || !vendorId) return;
    const parsed = vendorContactSchema.safeParse({
      id: draft.id,
      name: draft.name,
      job_title: nz(draft.job_title),
      phone: nz(draft.phone),
      mobile: nz(draft.mobile),
      email: nz(draft.email),
      is_primary: draft.is_primary,
      is_finance_contact: draft.is_finance_contact,
      notes: nz(draft.notes),
      sort_order: intOrNull(draft.sort_order) ?? 0,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查聯絡人的內容");
      return;
    }

    setBusy(true);
    try {
      const { saveVendorContact } = await import("@/lib/admin/fns/inv-vendors");
      await saveVendorContact({ data: { vendorId, contact: parsed.data } });
      toast.success(`聯絡人「${parsed.data.name}」已儲存`);
      setDraft(null);
      await onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "聯絡人儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: AdminVendorContact) {
    if (!vendorId) return;
    setBusy(true);
    try {
      const { deleteVendorChild } = await import("@/lib/admin/fns/inv-vendors");
      await deleteVendorChild({ data: { kind: "contact", vendorId, id: row.contact_id } });
      toast.success(`已刪除聯絡人「${row.name}」`);
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
        <p className="text-sm font-medium">聯絡人（{rows.length}）</p>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={disabled || busy || draft !== null}
          onClick={() => setDraft(EMPTY_CONTACT)}
        >
          <Plus className="h-3.5 w-3.5" />
          新增聯絡人
        </Button>
      </div>

      {rows.length === 0 && draft === null ? (
        <p className="text-sm text-muted-foreground">還沒有聯絡人。</p>
      ) : null}

      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.contact_id}
            className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3"
          >
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {row.name}
                {row.job_title ? (
                  <span className="ml-1.5 text-xs text-muted-foreground">{row.job_title}</span>
                ) : null}
                {row.is_primary ? (
                  <Badge variant="secondary" className="ml-1.5 font-normal">
                    主要
                  </Badge>
                ) : null}
                {row.is_finance_contact ? (
                  <Badge variant="outline" className="ml-1.5 font-normal">
                    財務
                  </Badge>
                ) : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {[row.phone, row.mobile, row.email].filter(Boolean).join("・") || "沒有留聯絡方式"}
              </p>
              {row.notes ? <p className="text-xs text-muted-foreground">{row.notes}</p> : null}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || busy}
                onClick={() =>
                  setDraft({
                    id: row.contact_id,
                    name: row.name,
                    job_title: row.job_title ?? "",
                    phone: row.phone ?? "",
                    mobile: row.mobile ?? "",
                    email: row.email ?? "",
                    is_primary: row.is_primary ?? false,
                    is_finance_contact: row.is_finance_contact ?? false,
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
        <VendorContactForm
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
