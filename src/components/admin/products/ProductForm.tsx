/**
 * 一般商品／票券的完整表單（2026-10-25 從 _shell.products.tsx 的編輯彈窗搬成
 * /admin/products/product/$id 內頁的本體）。欄位、驗證（productSchema）、寫入路徑
 * （fns/products.ts#upsertProduct）一個都沒改；送出鈕改成在內頁的動作列
 * （<Button type="submit" form={formId}>），表單本身不再帶 DialogFooter。
 *
 * 名額不在這裡：0020 把它搬到 public.event_sessions（由「活動報名」頁按場次維護），
 * 並且用一條 CHECK 強制 products.capacity 是 null。
 */
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { LocalizedField } from "@/components/admin/LocalizedField";
import { ImageField } from "@/components/admin/ImageField";
import { useReportDirty } from "@/components/admin/products/useReportDirty";
import { productSchema, type ProductFormValues } from "@/lib/admin/schemas";
import { curatedObjects } from "@/lib/images";

type ProductType = ProductFormValues["product_type"];
type ProductStatus = ProductFormValues["status"];
type ProductSourceType = NonNullable<ProductFormValues["source_type"]>;

/** goods/book ship physically; event/journey are bookings with capacity —
 * mirrors the comment on products.product_type in
 * supabase/migrations/0004_commerce_products.sql. */
const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  goods: "商品（實體）",
  book: "書籍",
  event: "活動",
  journey: "策旅",
};

const PRODUCT_STATUS_LABEL: Record<ProductStatus, string> = {
  draft: "草稿",
  active: "上架",
  archived: "下架封存",
};

const PRODUCT_SOURCE_TYPE_LABEL: Record<ProductSourceType, string> = {
  event: "活動",
  journey: "策旅",
  curated_item: "選品",
};

/** Sentinel for the "不關聯" option — Radix <Select.Item> rejects an empty-string value. */
const NONE_SOURCE_TYPE = "__none__";

function isBookableType(type: ProductType): boolean {
  return type === "event" || type === "journey";
}

function isShippableType(type: ProductType): boolean {
  return type === "goods" || type === "book";
}

type ProductFormProps = {
  /** <form id>：內頁動作列的送出鈕用 form={formId} 指到這張表單。 */
  formId: string;
  defaultValues: ProductFormValues;
  onSubmit: (values: ProductFormValues) => Promise<void>;
  /** 值跟第一次 render 不一樣 → true（內頁的未存變更防呆用）。 */
  onDirtyChange?: (dirty: boolean) => void;
};

export function ProductForm({ formId, defaultValues, onSubmit, onDirtyChange }: ProductFormProps) {
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues,
  });
  useReportDirty(form.control, onDirtyChange);

  const productType = useWatch({ control: form.control, name: "product_type" });
  const bookable = isBookableType(productType);
  const shippable = isShippableType(productType);

  return (
    <Form {...form}>
      <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="product_type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>商品類型</FormLabel>
                <Select
                  value={field.value}
                  onValueChange={(next) => {
                    field.onChange(next);
                    // Switching to a booking clears the leftover stock number,
                    // otherwise an "event" product rides along carrying the
                    // figure it had while it was "goods". There is no capacity
                    // field to clear in the other direction any more — 0020
                    // moved that number to public.event_sessions.
                    if (isBookableType(next as ProductType)) {
                      form.setValue("stock", null, { shouldValidate: true });
                    }
                  }}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {(Object.keys(PRODUCT_TYPE_LABEL) as ProductType[]).map((v) => (
                      <SelectItem key={v} value={v}>
                        {PRODUCT_TYPE_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>決定下面顯示「庫存」還是「名額」欄位。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>狀態</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {(Object.keys(PRODUCT_STATUS_LABEL) as ProductStatus[]).map((v) => (
                      <SelectItem key={v} value={v}>
                        {PRODUCT_STATUS_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>網址代稱</FormLabel>
              <FormControl>
                <Input placeholder="例如 spring-tea-set" {...field} />
              </FormControl>
              <FormDescription>建議使用半形英數字與連字號，且不能與其他商品重複。</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <LocalizedField name="title" label="標題" />
        <LocalizedField name="summary" label="摘要" multiline />
        <LocalizedField name="description" label="說明" multiline />

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
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value}
                    onChange={(e) =>
                      field.onChange(e.target.value === "" ? 0 : Math.trunc(Number(e.target.value)))
                    }
                  />
                </FormControl>
                <FormDescription>新台幣整數，不接受小數。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="compare_at_price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>原價（選填）</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
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
                <FormDescription>要顯示劃線比價時才填，單位同為元。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {shippable ? (
          <div className="grid gap-4 rounded-md border border-border p-4 sm:grid-cols-2">
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
                  <FormDescription>留白表示不管理庫存（可持續下單）。</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="requires_shipping"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>需要寄送</FormLabel>
                  <div className="flex h-9 items-center gap-2">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <span className="text-sm text-muted-foreground">
                      {field.value ? "是" : "否（例如電子憑證）"}
                    </span>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        ) : null}

        {/* 名額不在這裡了。0020 把它搬到 public.event_sessions，並且用一條 CHECK
            強制 products.capacity 是 null —— 留一個會被資料庫拒收的輸入框，比沒有
            這個輸入框更糟。一件活動也可能有兩個梯次、兩個名額，本來就放不進單一
            欄位。 */}
        {bookable ? (
          <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">
            名額與日期改由「活動報名」頁按場次維護。先在這裡把商品存起來，再到那一頁
            為它新增場次——沒有開放中的場次，前台就報不了名。
          </div>
        ) : null}

        <FormField
          control={form.control}
          name="image_key"
          render={({ field }) => (
            <FormItem>
              <FormLabel>商品圖片</FormLabel>
              {/* Not wrapped in <FormControl> (a Radix Slot): ImageField is a plain
                  composite component, not a forwardRef primitive like Input/Switch,
                  so Slot's ref-cloning would warn in the console for no benefit. */}
              <ImageField
                value={field.value ?? null}
                onChange={field.onChange}
                fallback={curatedObjects}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="source_type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>關聯來源類型（選填）</FormLabel>
              <Select
                value={field.value ?? NONE_SOURCE_TYPE}
                onValueChange={(next) => field.onChange(next === NONE_SOURCE_TYPE ? null : next)}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={NONE_SOURCE_TYPE}>不關聯</SelectItem>
                  {(Object.keys(PRODUCT_SOURCE_TYPE_LABEL) as ProductSourceType[]).map((v) => (
                    <SelectItem key={v} value={v}>
                      {PRODUCT_SOURCE_TYPE_LABEL[v]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                用來把商品連回既有的活動或選品內容（例如賣一場活動的票）。與下方 ID
                請一起填寫或一起留白；留白表示這是獨立商品。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="source_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>關聯來源 ID（選填）</FormLabel>
              <FormControl>
                <Input
                  placeholder="對應活動／策旅／選品項目的 id"
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value === "" ? null : e.target.value)}
                />
              </FormControl>
              <FormDescription>
                純文字，不會檢查是否存在——請自行從對應頁面複製正確的 id。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

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
      </form>
    </Form>
  );
}
