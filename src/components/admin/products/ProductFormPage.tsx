/**
 * 商品頁的編輯／新增內頁共用外框（2026-10-25 後台第 2 批：業主「不要用彈窗，直接顯示
 * 內頁＆回到上一頁」）。一般商品、刊物、選品五個內頁都是同一個流程：
 *
 *   表單（react-hook-form，各自那一張）→ 按「儲存」→ 既有的存檔 fn → 成功：
 *   guard.allowLeave() → router.invalidate() → 回上一頁（上一筆就是列表／主題頁時
 *   history.back()，篩選、分頁籤、捲動原樣），否則換成列表（replace）。
 *
 * 未存變更防呆掛在這一層（useUnsavedChangesGuard）：表單用 onDirtyChange 往上報
 * （useReportDirty：值比對，改回原樣不算；圖片上傳完成會改到 image_key，算改過）。
 *
 * 送出鈕在 AdminDetailPage 的動作列（md 以上右上、手機黏底部）＋內容底部一份，
 * 兩個都是 <Button type="submit" form={formId}>，送的是同一張 <form id={formId}>；
 * 驗證失敗時錯誤訊息照舊顯示在欄位底下（FormMessage）。
 */
import { useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";

export type ProductFormSlot<V> = {
  formId: string;
  submitting: boolean;
  onSubmit: (values: V) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
};

type Props<V> = {
  formId: string;
  title: ReactNode;
  meta?: ReactNode;
  /** 「← 回到列表」與存檔後要回去的列表（帶分頁籤）。 */
  backTo: string;
  backSearch?: Record<string, unknown>;
  backLabel: string;
  /** 上一筆是這些頁面時，「回到列表」與存檔後都直接按上一頁（例如選品主題頁）。 */
  backAlso?: readonly string[];
  submitLabel: string;
  successMessage: string;
  /** 呼叫既有的存檔 fn；丟錯 → 留在原頁、toast 錯誤訊息，打好的欄位不動。 */
  save: (values: V) => Promise<void>;
  children: (slot: ProductFormSlot<V>) => ReactNode;
};

export function ProductFormPage<V>({
  formId,
  title,
  meta,
  backTo,
  backSearch,
  backLabel,
  backAlso = [],
  submitLabel,
  successMessage,
  save,
  children,
}: Props<V>) {
  const router = useRouter();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const guard = useUnsavedChangesGuard(dirty);

  async function onSubmit(values: V) {
    setSaving(true);
    try {
      await save(values);
      toast.success(successMessage);
      guard.allowLeave();
      // 寫入後 src/start.ts 已清掉後台路由快取；這裡再 invalidate 一次讓列表是新的。
      await router.invalidate({ sync: true });
      if (backIfPreviousIs(router.history, [backTo, ...backAlso])) return;
      // 型別上 navigate 只收已註冊的路徑；backTo 是呼叫端給的列表路徑字串（同 BackToListLink）。
      await router.navigate({
        to: backTo as never,
        search: (backSearch ?? {}) as never,
        replace: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <Button type="submit" form={formId} className="gap-1.5" disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {saving ? "儲存中…" : submitLabel}
    </Button>
  );

  return (
    <AdminDetailPage
      backTo={backTo}
      backSearch={backSearch}
      backLabel={backLabel}
      backAlso={backAlso}
      title={title}
      meta={meta}
      actions={actions}
      width="md"
    >
      {children({ formId, submitting: saving, onSubmit, onDirtyChange: setDirty })}
      <div className="hidden justify-end md:flex">{actions}</div>
      {guard.dialog}
    </AdminDetailPage>
  );
}
