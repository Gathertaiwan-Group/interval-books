/**
 * 新增／編輯合作夥伴（public.collaborations）—— 表單內頁的本體
 * （/admin/collaborations/new、/admin/collaborations/$id）。
 *
 * 2026-10-26 從 _shell.collaborations.tsx 裡的 Dialog 抽出來改成內頁（後台第 3 批；業主：「不要用
 * 彈窗，直接顯示內頁＆回到上一頁」）。欄位、collaborationSchema、upsertCollaboration 一行都沒改。
 *
 * ⚠️ 中文、英文、日文皆為必填（資料庫 is_localized CHECK），zod 在送出前擋一次。
 * ⚠️ 表單只在**掛載時**用 defaultValues 填一次；換一筆由呼叫端 key={id} 重新掛載。
 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Handshake, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { collaborationSchema, type CollaborationFormValues } from "@/lib/admin/schemas";
import type { CollaborationRow } from "@/server/repos/collaborations";

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

function toFormValues(
  row: CollaborationRow | null,
  nextSortOrder: number,
): CollaborationFormValues {
  if (!row) {
    return {
      title: { ...EMPTY_LOCALIZED },
      description: { ...EMPTY_LOCALIZED },
      is_published: true,
      sort_order: nextSortOrder,
    };
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    is_published: row.is_published,
    sort_order: row.sort_order,
  };
}

type Props = {
  /** null = 新增。 */
  collaboration: CollaborationRow | null;
  /** 新增時的預設排序（新的排最前面，見 lib/admin/sort-order.ts）。 */
  nextSortOrder?: number;
  /** 存檔成功（已經 allowLeave）：呼叫端負責 invalidate 與換頁。 */
  onSaved: () => Promise<void>;
};

export function CollaborationForm({ collaboration, nextSortOrder = 0, onSaved }: Props) {
  const form = useForm<CollaborationFormValues>({
    resolver: zodResolver(collaborationSchema),
    defaultValues: toFormValues(collaboration, nextSortOrder),
  });
  const [saving, setSaving] = useState(false);

  const { dirty } = useFormDirty(form.watch());
  const guard = useUnsavedChangesGuard(dirty);

  async function handleSubmit(values: CollaborationFormValues) {
    setSaving(true);
    try {
      const { upsertCollaboration } = await import("@/lib/admin/fns/collaborations");
      await upsertCollaboration({
        data: collaboration ? { ...values, id: collaboration.id } : values,
      });
      toast.success(collaboration ? "已更新合作夥伴" : "已新增合作夥伴");
      guard.allowLeave();
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <Button type="submit" form="collaboration-form" className="gap-1.5" disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {saving ? "儲存中…" : collaboration ? "儲存變更" : "新增"}
    </Button>
  );

  return (
    <AdminDetailPage
      backTo="/admin/collaborations"
      backLabel="回合作列表"
      icon={<Handshake className="h-5 w-5" aria-hidden="true" />}
      title={collaboration ? `編輯合作：${collaboration.title.zh}` : "新增合作"}
      meta="中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。"
      actions={actions}
      width="md"
    >
      <Form {...form}>
        <form
          id="collaboration-form"
          onSubmit={form.handleSubmit(handleSubmit)}
          className="space-y-5"
        >
          <LocalizedField name="title" label="名稱" />
          <LocalizedField name="description" label="說明" multiline />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="sort_order"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>排序（數字越小越前面）</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={field.value}
                      onChange={(e) =>
                        field.onChange(e.target.value === "" ? 0 : Number(e.target.value))
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="is_published"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>發布狀態</FormLabel>
                  <div className="flex h-9 items-center gap-2">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <span className="text-sm text-muted-foreground">
                      {field.value ? "已發布" : "草稿"}
                    </span>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </form>
      </Form>

      <div className="hidden justify-end md:flex">{actions}</div>
      {guard.dialog}
    </AdminDetailPage>
  );
}
