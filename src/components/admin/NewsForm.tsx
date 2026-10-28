/**
 * 新增／編輯一則最新消息（public.news）—— 表單內頁的本體（/admin/news/new、/admin/news/$id）。
 *
 * 2026-10-26 從 _shell.news.tsx 裡的 Dialog 抽出來改成內頁（後台第 3 批；業主：「不要用彈窗，
 * 直接顯示內頁＆回到上一頁」）。欄位、newsSchema、upsertNews 一行都沒改。
 *
 * ⚠️ 中文、英文、日文皆為必填（資料庫 is_localized CHECK），zod 在送出前擋一次。
 * ⚠️ 表單只在**掛載時**用 defaultValues 填一次（react-hook-form 的行為）；loader 之後重跑
 *    不會蓋掉打到一半的欄位。換一筆由呼叫端 key={id} 重新掛載。
 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Newspaper, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { AdvancedSection } from "@/components/admin/AdvancedSection";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { newsSchema, type NewsFormValues } from "@/lib/admin/schemas";
import type { NewsRow } from "@/server/repos/news";
import { parseNewsEndDate } from "@/lib/news-expiry";
import { taipeiToday } from "@/lib/taipei-time";

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

function toFormValues(row: NewsRow | null, nextSortOrder: number): NewsFormValues {
  if (!row) {
    return {
      title: { ...EMPTY_LOCALIZED },
      summary: { ...EMPTY_LOCALIZED },
      description: { ...EMPTY_LOCALIZED },
      display_date: "",
      is_published: true,
      sort_order: nextSortOrder,
    };
  }
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    description: row.description,
    display_date: row.display_date,
    is_published: row.is_published,
    sort_order: row.sort_order,
  };
}

type Props = {
  /** null = 新增。 */
  news: NewsRow | null;
  /** 新增時的預設排序（新的一則排最前面，見 lib/admin/sort-order.ts）。編輯時不用。 */
  nextSortOrder?: number;
  /** 存檔成功（已經 allowLeave）：呼叫端負責 invalidate 與換頁。 */
  onSaved: () => Promise<void>;
};

export function NewsForm({ news, nextSortOrder = 0, onSaved }: Props) {
  const form = useForm<NewsFormValues>({
    resolver: zodResolver(newsSchema),
    defaultValues: toFormValues(news, nextSortOrder),
  });
  const [saving, setSaving] = useState(false);

  const { dirty } = useFormDirty(form.watch());
  const guard = useUnsavedChangesGuard(dirty);

  async function handleSubmit(values: NewsFormValues) {
    setSaving(true);
    try {
      const { upsertNews } = await import("@/lib/admin/fns/news");
      await upsertNews({ data: news ? { ...values, id: news.id } : values });
      toast.success(news ? "已更新消息" : "已新增消息");
      guard.allowLeave();
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <Button type="submit" form="news-form" className="gap-1.5" disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {saving ? "儲存中…" : news ? "儲存變更" : "新增"}
    </Button>
  );

  return (
    <AdminDetailPage
      backTo="/admin/news"
      backLabel="回最新消息列表"
      icon={<Newspaper className="h-5 w-5" aria-hidden="true" />}
      title={news ? `編輯消息：${news.title.zh}` : "新增消息"}
      meta="中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。"
      actions={actions}
      width="md"
    >
      <Form {...form}>
        <form id="news-form" onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
          <LocalizedField name="title" label="標題" />
          <LocalizedField name="summary" label="摘要" multiline />
          <LocalizedField name="description" label="說明" multiline />

          <FormField
            control={form.control}
            name="display_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>顯示用日期文字</FormLabel>
                <FormControl>
                  <Input placeholder="例如 2026.05.22–05.24" {...field} />
                </FormControl>
                <FormDescription>
                  照原樣顯示在網站上。結束日期過後，前台自動隱藏；日期無法辨識時一律顯示。
                </FormDescription>
                <EndDatePreview text={field.value} />
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

          <AdvancedSection
            hint="排序（通常不用改，新的一則會自動排在最前面）"
            forceOpen={Boolean(form.formState.errors.sort_order)}
          >
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
          </AdvancedSection>
        </form>
      </Form>

      <div className="hidden justify-end md:flex">{actions}</div>
      {guard.dialog}
    </AdminDetailPage>
  );
}

/**
 * 「顯示用日期文字」底下的即時預覽：店員一邊打，一邊看到系統讀出來的結束日
 * （與前台過期隱藏同一支 parseNewsEndDate，src/lib/news-expiry.ts）。
 */
function EndDatePreview({ text }: { text: string }) {
  if (!text.trim()) return null;
  const end = parseNewsEndDate(text);
  if (!end) {
    return (
      <p className="text-xs text-muted-foreground">讀不出日期 → 前台會一直顯示（不會自動隱藏）。</p>
    );
  }
  const shown = end.replaceAll("-", "/");
  if (end < taipeiToday()) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-400">
        結束日期：{shown} → 已過期・前台不顯示
      </p>
    );
  }
  return <p className="text-xs text-muted-foreground">結束日期：{shown}（這天過後前台自動隱藏）</p>;
}
