/**
 * 廠商的附件／合約子表（已上傳清單 + 檢視 + 刪除 + 上傳）。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。上傳那張表單在
 * VendorAttachmentForm，真正的三步驟（上傳檔案 → 拿 key → 寫子表）留在這裡的 upload()。
 */
import { stableStringify } from "@/lib/admin/form-dirty";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import { useReportChildDirty } from "@/lib/admin/useChildDraftDirty";
import { useRef, useState } from "react";
import { Loader2, Paperclip, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ChildPlaceholder } from "@/components/inventory/VendorChildPlaceholder";
import { VendorAttachmentForm } from "@/components/inventory/VendorAttachmentForm";
import { EMPTY_ATTACHMENT, type AttachmentDraft } from "@/components/inventory/VendorChildDrafts";
import {
  ATTACHMENT_TYPE_LABELS,
  type AttachmentType,
} from "@/components/inventory/VendorFieldLabels";
import { nz } from "@/components/inventory/VendorFormParsers";
import { vendorAttachmentSchema } from "@/lib/admin/schemas";
import type { AdminVendorAttachment } from "@/server/repos/inv-vendors";

/**
 * 附件。
 *
 * ⚠️ 流程是 **先填完再上傳**：選檔案只是記在 state 裡，按下「上傳並儲存」才真的
 *    `uploadVendorAttachmentFile`（FormData）→ 拿到 key → `saveVendorAttachment`。
 *    反過來（選完就上傳）的話，使用者中途放棄會在 storage 留下一個沒有人指得到的
 *    孤兒檔案。
 *
 * ⚠️ 看檔案要走 `signVendorAttachment` 拿短效網址再開新分頁 —— bucket 是 private，
 *    沒有永久網址這種東西。網址有時效，所以每次點都重新簽一次，不快取。
 */
export function VendorAttachmentSection({
  vendorId,
  rows,
  disabled,
  onReload,
  onDirtyChange,
}: {
  vendorId: string | null;
  rows: AdminVendorAttachment[];
  disabled: boolean;
  onReload: () => Promise<void>;
  /** 選了檔案或填了說明、還沒上傳（併進內頁的未存變更防呆）。 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<AttachmentDraft>(EMPTY_ATTACHMENT);
  useReportChildDirty(stableStringify(draft) !== stableStringify(EMPTY_ATTACHMENT), onDirtyChange);
  const [busy, setBusy] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!vendorId) {
    return (
      <ChildPlaceholder>
        先把基本資料存起來，才能上傳附件與合約 —— 檔案是存在以 vendor_id 為第一段路徑的 私有 bucket
        裡，沒有 id 就沒有路徑。
      </ChildPlaceholder>
    );
  }

  async function upload() {
    if (!vendorId) return;
    if (!draft.file) {
      toast.error("請選擇檔案");
      return;
    }

    setBusy(true);
    try {
      const { uploadVendorAttachmentFile, saveVendorAttachment } =
        await import("@/lib/admin/fns/inv-vendors");

      const formData = new FormData();
      formData.append("file", draft.file);
      formData.append("vendorId", vendorId);
      const uploaded = await uploadVendorAttachmentFile({ data: formData });

      const parsed = vendorAttachmentSchema.safeParse({
        file_name: draft.file_name.trim() === "" ? draft.file.name : draft.file_name,
        file_path: uploaded.key,
        file_type: uploaded.fileType,
        file_size: uploaded.fileSize,
        description: nz(draft.description),
        attachment_type: draft.attachment_type,
        contract_start_date: nz(draft.contract_start_date),
        contract_end_date: nz(draft.contract_end_date),
        contract_version: nz(draft.contract_version),
        is_current: draft.is_current,
      });
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message ?? "請檢查附件的內容");
        return;
      }

      await saveVendorAttachment({ data: { vendorId, attachment: parsed.data } });
      toast.success(`附件「${parsed.data.file_name}」已上傳`);
      setDraft(EMPTY_ATTACHMENT);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "附件上傳失敗");
    } finally {
      setBusy(false);
    }
  }

  async function view(row: AdminVendorAttachment) {
    if (!vendorId) return;
    setOpeningId(row.attachment_id);
    try {
      const { signVendorAttachment } = await import("@/lib/admin/fns/inv-vendors");
      const { url } = await signVendorAttachment({
        data: { vendorId, filePath: row.file_path },
      });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "附件網址產生失敗");
    } finally {
      setOpeningId(null);
    }
  }

  async function remove(row: AdminVendorAttachment) {
    if (!vendorId) return;
    setBusy(true);
    try {
      const { deleteVendorChild } = await import("@/lib/admin/fns/inv-vendors");
      await deleteVendorChild({
        data: { kind: "attachment", vendorId, id: row.attachment_id },
      });
      toast.success(`已刪除附件「${row.file_name}」`);
      await onReload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-medium">已上傳（{rows.length}）</p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">還沒有附件。</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.attachment_id}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3"
              >
                <div className="space-y-0.5">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                    {row.file_name}
                    <Badge variant="outline" className="font-normal">
                      {ATTACHMENT_TYPE_LABELS[row.attachment_type as AttachmentType] ??
                        row.attachment_type}
                    </Badge>
                    {row.attachment_type === "contract" && row.is_current ? (
                      <Badge variant="secondary" className="font-normal">
                        現行版本
                      </Badge>
                    ) : null}
                  </p>
                  {row.attachment_type === "contract" ? (
                    <p className="text-xs text-muted-foreground">
                      {row.contract_start_date ?? "—"} ~ {row.contract_end_date ?? "—"}
                      {row.contract_version ? `・版本 ${row.contract_version}` : ""}
                    </p>
                  ) : null}
                  {row.description ? (
                    <p className="text-xs text-muted-foreground">{row.description}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {row.uploaded_by_name ?? "未知上傳者"}・{formatTaipeiDateTime(row.created_at)}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || busy || openingId === row.attachment_id}
                    onClick={() => void view(row)}
                  >
                    {openingId === row.attachment_id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "檢視"
                    )}
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
        )}
      </div>

      <Separator />

      <VendorAttachmentForm
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        disabled={disabled}
        fileInputRef={fileInputRef}
        onUpload={() => void upload()}
      />
    </div>
  );
}
