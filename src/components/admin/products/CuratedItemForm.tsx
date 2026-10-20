/**
 * 選品（curated_items）一項的表單。
 *
 * 原本住在 src/routes/admin/_shell.curated.tsx。2026-10-20 選品併進後台「商品」
 * 單一頁之後，清單上的「編輯／新增」與主題管理頁（_shell.products_.curated-themes.tsx）
 * 共用這一份；寫入一律走 fns/curated.ts 的 upsertCuratedItem。
 *
 * `themes` 有傳時多一格「所屬主題」——從商品單一頁新增選品時要先選主題；主題管理頁
 * 是在某一個主題底下新增，不需要它。
 */
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { curatedItemSchema, type CuratedItemFormValues } from "@/lib/admin/schemas";

export type CuratedItemFormProps = {
  defaultValues: CuratedItemFormValues;
  onSubmit: (values: CuratedItemFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
  /** 有傳才顯示「所屬主題」下拉。 */
  themes?: { id: string; title: { zh: string } }[];
};

export function CuratedItemForm({
  defaultValues,
  onSubmit,
  submitting,
  submitLabel,
  themes,
}: CuratedItemFormProps) {
  const form = useForm<CuratedItemFormValues>({
    resolver: zodResolver(curatedItemSchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        {themes ? (
          <FormField
            control={form.control}
            name="theme_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>所屬主題</FormLabel>
                <Select value={field.value || undefined} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="選一個主題" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {themes.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.title.zh}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

        <LocalizedField name="name" label="品項名稱" />
        <LocalizedField name="note" label="備註" multiline />

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

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "儲存中…" : submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
