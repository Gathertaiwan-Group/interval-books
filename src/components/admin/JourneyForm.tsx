/**
 * 編輯策旅卡片（public.journeys）—— 表單內頁的本體（/admin/journeys/$id）。
 *
 * 2026-10-25 從 _shell.journeys.tsx 裡的編輯 Dialog 抽出來改成內頁（業主：「不要用彈窗，
 * 直接顯示內頁＆回到上一頁」）。欄位、journeySchema、upsertJourney 一行都沒改。
 *
 * ⚠️ 為什麼不是 /admin/journeys/new 那個 EventQuickCreate：新增頁是「一頁新增策旅」——
 *    卡片＋報名頁＋梯次＋票種一次建好，寫入走 createEventQuick。編輯既有策旅只改這張卡片
 *    的三語文字與報名設定（梯次、票種在活動那邊改），寫入是 upsertJourney。兩者寫的東西
 *    不一樣，硬共用一個元件只會讓其中一邊多出一堆存不進去的欄位。
 *
 * ⚠️ 中文、英文、日文皆為必填（資料庫 is_localized CHECK），zod 在送出前擋一次。
 * ⚠️ 表單只在**掛載時**用 defaultValues 填一次（react-hook-form 的行為）；loader 之後重跑
 *    不會蓋掉打到一半的欄位。換一筆由呼叫端 key={id} 重新掛載。
 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Map as MapIcon, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { journeySchema, type JourneyFormValues } from "@/lib/admin/schemas";
import type { JourneyRow } from "@/server/repos/journeys";

function journeyToFormValues(row: JourneyRow): JourneyFormValues {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    description: row.description,
    days: row.days,
    theme: row.theme,
    external_url: row.external_url,
    registration_type: row.registration_type,
    payment_enabled: row.payment_enabled,
    is_published: row.is_published,
    sort_order: row.sort_order,
  };
}

type Props = {
  journey: JourneyRow;
  /** 存檔成功（已經 allowLeave）：呼叫端負責 invalidate 與換頁。 */
  onSaved: () => Promise<void>;
};

export function JourneyForm({ journey, onSaved }: Props) {
  const form = useForm<JourneyFormValues>({
    resolver: zodResolver(journeySchema),
    defaultValues: journeyToFormValues(journey),
  });
  const [saving, setSaving] = useState(false);

  const { dirty } = useFormDirty(form.watch());
  const guard = useUnsavedChangesGuard(dirty);

  async function handleSubmit(values: JourneyFormValues) {
    setSaving(true);
    try {
      const { upsertJourney } = await import("@/lib/admin/fns/journeys");
      await upsertJourney({ data: { ...values, id: journey.id } });
      toast.success("已更新策旅");
      guard.allowLeave();
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <Button type="submit" form="journey-form" className="gap-1.5" disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {saving ? "儲存中…" : "儲存變更"}
    </Button>
  );

  return (
    <AdminDetailPage
      backTo="/admin/journeys"
      backLabel="回策旅列表"
      icon={<MapIcon className="h-5 w-5" aria-hidden="true" />}
      title={`編輯策旅：${journey.title.zh}`}
      meta="中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。梯次與票種請到活動那邊改。"
      actions={actions}
      width="md"
    >
      <Form {...form}>
        <form id="journey-form" onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
          <LocalizedField name="title" label="標題" />
          <LocalizedField name="summary" label="摘要" multiline />
          <LocalizedField name="description" label="說明" multiline />
          <LocalizedField name="days" label="天數" />
          <LocalizedField name="theme" label="主題關鍵字" />

          <FormField
            control={form.control}
            name="external_url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>報名網址</FormLabel>
                <FormControl>
                  <Input placeholder="https:// 或 /events/…" {...field} />
                </FormControl>
                <FormDescription className="break-words">
                  外部策旅填完整網址（含 https://）；站內報名的策旅填站內路徑，例如
                  /events/InntervalChishang.1023。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="registration_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>報名方式</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="請選擇報名方式" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="external">外部連結</SelectItem>
                      <SelectItem value="internal">內部報名</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="payment_enabled"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>線上付款</FormLabel>
                  <div className="flex h-9 items-center gap-2">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <span className="text-sm text-muted-foreground">
                      {field.value ? "已啟用" : "未啟用"}
                    </span>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
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
