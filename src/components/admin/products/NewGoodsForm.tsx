/**
 * 「＋ 新增商品 › 一般商品」的精簡表單。
 *
 * 只問開賣真正需要的幾格：書籍或商品、名稱、一句介紹、價格、庫存、圖片、要不要
 * 立刻上架。其餘欄位（網址代稱、長說明、寄送、排序…）的預設值集中在
 * src/lib/admin/unified-products.ts#buildNewGoodsPayload，送出時組成完整的
 * productSchema payload，走的是既有的 fns/products.ts#upsertProduct —— 沒有第二條
 * 寫入路徑。之後要補長說明或比價原價，在清單上按「編輯」就是完整表單。
 *
 * 2026-10-25 從彈窗改成內頁（/admin/products/product/new）：送出鈕改在內頁的動作列
 * （<Button type="submit" form={formId}>），表單本身不再帶 DialogFooter。
 */
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ImageField } from "@/components/admin/ImageField";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { useReportDirty } from "@/components/admin/products/useReportDirty";
import { localizedSchema } from "@/lib/admin/schemas";
import { curatedObjects } from "@/lib/images";

const newGoodsSchema = z.object({
  product_type: z.enum(["goods", "book"]),
  title: localizedSchema,
  summary: localizedSchema,
  // 至少 1 元：0 元在結帳、發票、金流都是特例（免費活動走活動頁，不在這裡建）。
  price: z.number().int("價格必須是整數，不接受小數").min(1, "請填入售價（至少 1 元）"),
  stock: z.number().int("庫存必須是整數，不接受小數").min(0, "庫存不可為負數").nullable(),
  image_key: z.string().trim().nullable(),
  publish: z.boolean(),
});
export type NewGoodsValues = z.infer<typeof newGoodsSchema>;

const EMPTY = { zh: "", en: "", ja: "" };

export function NewGoodsForm({
  formId,
  onSubmit,
  submitting,
  onDirtyChange,
}: {
  /** <form id>：內頁動作列的送出鈕用 form={formId} 指到這張表單。 */
  formId: string;
  onSubmit: (values: NewGoodsValues) => Promise<void>;
  submitting: boolean;
  /** 值跟第一次 render 不一樣 → true（內頁的未存變更防呆用）。 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const form = useForm<NewGoodsValues>({
    resolver: zodResolver(newGoodsSchema),
    defaultValues: {
      product_type: "goods",
      title: { ...EMPTY },
      summary: { ...EMPTY },
      price: 0,
      stock: null,
      image_key: null,
      publish: false,
    },
  });
  useReportDirty(form.control, onDirtyChange);

  return (
    <Form {...form}>
      <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="product_type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>種類</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="goods">商品（器物、茶、文具…）</SelectItem>
                  <SelectItem value="book">書籍</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <LocalizedField name="title" label="名稱" />
        <LocalizedField name="summary" label="一句介紹" multiline rows={2} />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>價格（元）</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    min={0}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value}
                    onChange={(e) =>
                      field.onChange(e.target.value === "" ? 0 : Math.trunc(Number(e.target.value)))
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="stock"
            render={({ field }) => (
              <FormItem>
                <FormLabel>庫存（選填）</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    min={0}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={(e) =>
                      field.onChange(
                        e.target.value === "" ? null : Math.trunc(Number(e.target.value)),
                      )
                    }
                  />
                </FormControl>
                <FormDescription>
                  留白＝不管理庫存。進銷存裡已有的品項請改用「從進銷存上架」。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="image_key"
          render={({ field }) => (
            <FormItem>
              <FormLabel>圖片</FormLabel>
              <ImageField
                value={field.value ?? null}
                onChange={field.onChange}
                fallback={curatedObjects}
                disabled={submitting}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="publish"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between rounded-md border border-border p-3">
              <div>
                <FormLabel>建立後立刻上架</FormLabel>
                <FormDescription>關著＝先存成草稿，前台看不到。</FormDescription>
              </div>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
}
