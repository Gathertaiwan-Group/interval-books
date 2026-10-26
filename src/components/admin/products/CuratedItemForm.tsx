/**
 * 選品（curated_items）一項的表單。
 *
 * 原本住在 src/routes/admin/_shell.curated.tsx。2026-10-20 選品併進後台「商品」
 * 單一頁之後，清單上的「編輯／新增」與主題管理頁（_shell.products_.curated-themes.tsx）
 * 共用這一份；寫入一律走 fns/curated.ts 的 upsertCuratedItem。
 *
 * `themes` 有傳時多一格「所屬主題」——只有新增時給（/admin/products/curated/new）。
 * 編輯時不給：換主題要連 sort_order 一起換（unique(theme_id, sort_order)），而
 * upsertCuratedItem 的更新分支刻意不寫 sort_order。
 *
 * 2026-10-25 從彈窗改成內頁（/admin/products/curated/$id、/new）：送出鈕改在內頁的
 * 動作列（<Button type="submit" form={formId}>），表單本身不再帶 DialogFooter。
 *
 * 2026-10-26 多一格「連結商品」（curated_items.product_id，0041）：`linkOptions` 有傳才顯示，
 * 見 CuratedProductPicker。`linkSupported=false`（0041 還沒套用）時那一格停用並說明。
 */
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormDescription,
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
import { CuratedProductPicker } from "@/components/admin/products/CuratedProductPicker";
import { useReportDirty } from "@/components/admin/products/useReportDirty";
import { curatedItemSchema, type CuratedItemFormValues } from "@/lib/admin/schemas";
import type { CuratedLinkOption } from "@/lib/admin/unified-products";

export type CuratedItemFormProps = {
  /** <form id>：內頁動作列的送出鈕用 form={formId} 指到這張表單。 */
  formId: string;
  defaultValues: CuratedItemFormValues;
  onSubmit: (values: CuratedItemFormValues) => Promise<void>;
  /** 值跟第一次 render 不一樣 → true（內頁的未存變更防呆用）。 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 有傳才顯示「所屬主題」下拉。 */
  themes?: { id: string; title: { zh: string } }[];
  /** 有傳才顯示「連結商品」。 */
  linkOptions?: CuratedLinkOption[];
  /** 0041 的欄位在不在；false 時「連結商品」停用並說明。 */
  linkSupported?: boolean;
};

export function CuratedItemForm({
  formId,
  defaultValues,
  onSubmit,
  onDirtyChange,
  themes,
  linkOptions,
  linkSupported = true,
}: CuratedItemFormProps) {
  const form = useForm<CuratedItemFormValues>({
    resolver: zodResolver(curatedItemSchema),
    defaultValues,
  });
  useReportDirty(form.control, onDirtyChange);
  const name = useWatch({ control: form.control, name: "name" });

  return (
    <Form {...form}>
      <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
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

        {linkOptions ? (
          <FormField
            control={form.control}
            name="product_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>連結商品</FormLabel>
                <FormDescription>
                  連了商品的選品，會優先出現在首頁「主理人的選品」那一排，/shop
                  的選品卡也會出現價格與加入購物車。
                </FormDescription>
                <CuratedProductPicker
                  value={field.value}
                  onChange={(id) => field.onChange(id)}
                  options={linkOptions}
                  supported={linkSupported}
                  itemName={name ?? { zh: "", en: "", ja: "" }}
                />
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

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
      </form>
    </Form>
  );
}
