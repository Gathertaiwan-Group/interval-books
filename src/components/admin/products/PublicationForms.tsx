/**
 * 地方刊物的兩張表單：校稿（PublicationForm）與「連到庫存商品」（LinkForm）。
 *
 * 原本住在 src/routes/admin/_shell.publications.tsx 裡。2026-10-20 地方刊物展併進
 * 後台「商品」單一頁（src/routes/admin/_shell.products.tsx），舊網址只剩轉址，
 * 表單原封不動搬到這裡給新頁用 —— 寫入仍然走 fns/publications.ts 的
 * updatePublication / linkPublicationToInventory，沒有第二條路徑。
 *
 * 2026-10-25：校稿（PublicationForm）從彈窗改成內頁 /admin/products/publication/$id，
 * 送出鈕改在內頁的動作列（<Button type="submit" form={formId}>）。「連到庫存商品」
 * （LinkForm）是上架動作，照規格留在清單上的對話框裡，仍然自帶 DialogFooter。
 */
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
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
import {
  publicationLinkSchema,
  publicationSchema,
  type PublicationFormValues,
  type PublicationLinkFormValues,
} from "@/lib/admin/schemas";
import type { listPublicationNameMatches, listPublications } from "@/lib/admin/fns/publications";
import type { listInventoryCandidates } from "@/lib/admin/fns/inventory-listing";
import bookstoreImg from "@/assets/bookstore-interior.jpg";

export type Publication = Awaited<ReturnType<typeof listPublications>>[number];
export type NameMatch = Awaited<ReturnType<typeof listPublicationNameMatches>>[number];
export type Candidate = Awaited<ReturnType<typeof listInventoryCandidates>>[number];

const formatTWD = (n: number) => `NT$${n.toLocaleString("zh-Hant-TW")}`;

export function PublicationForm({
  formId,
  publication,
  onSubmit,
  submitting,
  onDirtyChange,
}: {
  /** <form id>：內頁動作列的送出鈕用 form={formId} 指到這張表單。 */
  formId: string;
  publication: Publication;
  onSubmit: (values: PublicationFormValues) => void | Promise<void>;
  submitting: boolean;
  /** 值跟第一次 render 不一樣 → true（內頁的未存變更防呆用）。 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const form = useForm<PublicationFormValues>({
    resolver: zodResolver(publicationSchema),
    defaultValues: {
      id: publication.id,
      title: publication.title,
      publisher: publication.publisher,
      intro: publication.intro,
      region: publication.region,
      issues: publication.issues ?? "",
      external_url: publication.external_url ?? "",
      cover_image_key: publication.cover_image_key ?? "",
      is_published: publication.is_published,
      sort_order: publication.sort_order,
    },
  });
  useReportDirty(form.control, onDirtyChange);

  return (
    <Form {...form}>
      <form id={formId} onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="cover_image_key"
          render={({ field }) => (
            <FormItem>
              {/* 不包在 <FormControl>（Radix Slot）裡：ImageField 是複合元件，
                  不是 forwardRef 的原生元件，Slot 的 ref cloning 只會噴 warning。
                  與 _shell.exhibitions.tsx、_shell.pages.$slug.tsx 同一個寫法；
                  scripts/event-assembler-selftest.mjs 用 AST 掃整個 src/ 守著它。 */}
              <ImageField
                label="封面"
                value={field.value}
                onChange={(key) => field.onChange(key ?? "")}
                fallback={bookstoreImg}
                disabled={submitting}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <LocalizedField name="title" label="刊名" />
        <LocalizedField name="publisher" label="製作單位" />
        <LocalizedField name="intro" label="刊物介紹" multiline rows={6} />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="region"
            render={({ field }) => (
              <FormItem>
                <FormLabel>關注地域</FormLabel>
                <FormControl>
                  <Input placeholder="例如 基隆-八斗子" {...field} />
                </FormControl>
                <FormDescription>
                  原文照抄的自由文字。前台的地域篩選會把它歸到粗分類，改這裡就會換組。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="issues"
            render={({ field }) => (
              <FormItem>
                <FormLabel>集數</FormLabel>
                <FormControl>
                  <Input placeholder="例如 2016 秋、2017 秋" {...field} value={field.value ?? ""} />
                </FormControl>
                <FormDescription>留空代表原始資料沒有這一欄。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="external_url"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>刊物網址</FormLabel>
                <FormControl>
                  <Input placeholder="https://…" {...field} value={field.value ?? ""} />
                </FormControl>
                <FormDescription>留空則前台不顯示連結。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="sort_order"
            render={({ field }) => (
              <FormItem>
                <FormLabel>排序</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? 0}
                    onChange={(e) =>
                      field.onChange(e.target.value === "" ? 0 : Math.trunc(Number(e.target.value)))
                    }
                  />
                </FormControl>
                <FormDescription>數字小的排前面，同組內再照原始序號。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="is_published"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-md border border-border p-3">
                <div>
                  <FormLabel>在展覽頁顯示</FormLabel>
                  <FormDescription>關掉之後前台看不到這一本。</FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>
      </form>
    </Form>
  );
}

export function LinkForm({
  publication,
  suggested,
  candidates,
  onSubmit,
  submitting,
}: {
  publication: Publication;
  suggested: NameMatch[];
  candidates: Candidate[];
  onSubmit: (values: PublicationLinkFormValues) => void | Promise<void>;
  submitting: boolean;
}) {
  const form = useForm<PublicationLinkFormValues>({
    resolver: zodResolver(publicationLinkSchema),
    defaultValues: {
      publication_id: publication.id,
      inv_product_id: "",
      price: 0,
      units_per_sale: 1,
    },
  });

  // 同名的排最前面，其餘照原順序接在後面。刻意不把「其餘」藏起來 ——
  // 原始清單的刊名與進貨時打的品名常常差一個副標，同名比對找不到很正常。
  const suggestedIds = new Set(suggested.map((s) => s.inv_product_id));
  const rest = candidates.filter((c) => !suggestedIds.has(c.inv_product_id));

  function pick(id: string) {
    form.setValue("inv_product_id", id, { shouldDirty: true, shouldValidate: true });
    const hit =
      suggested.find((s) => s.inv_product_id === id) ??
      candidates.find((c) => c.inv_product_id === id);
    // 進銷存的 selling_price 是 numeric、型錄是整數元。四捨五入而不是捨去，
    // 與上架頁同一條規則（見 _shell.inventory-listing.tsx#applyCandidate）。
    if (hit && !form.getValues("price")) {
      form.setValue("price", Math.round(Number(hit.selling_price)), { shouldDirty: true });
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="inv_product_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>進銷存品項</FormLabel>
              <Select value={field.value || undefined} onValueChange={pick}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="選一個品項" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className="max-h-72">
                  {suggested.map((s) => (
                    <SelectItem key={s.inv_product_id} value={s.inv_product_id}>
                      ★ {s.name}（庫存 {s.stock_quantity}／
                      {formatTWD(Math.round(Number(s.selling_price)))}）
                    </SelectItem>
                  ))}
                  {rest.map((c) => (
                    <SelectItem key={c.inv_product_id} value={c.inv_product_id}>
                      {c.name}（庫存 {c.stock_quantity}／
                      {formatTWD(Math.round(Number(c.selling_price)))}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                ★ 是與這本刊名相同的品項。只列出已核准、未停用、有庫存，而且還沒被別的
                商品佔用的品項。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>網站售價（元）</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    min={1}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={(e) =>
                      field.onChange(e.target.value === "" ? 0 : Math.trunc(Number(e.target.value)))
                    }
                  />
                </FormControl>
                <FormDescription>
                  進銷存售價是 0 的品項要在這裡填真正的價格，不然不能賣。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="units_per_sale"
            render={({ field }) => (
              <FormItem>
                <FormLabel>每件出貨數</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    min={1}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? 1}
                    onChange={(e) =>
                      field.onChange(e.target.value === "" ? 1 : Math.trunc(Number(e.target.value)))
                    }
                  />
                </FormControl>
                <FormDescription>一般是 1。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "連結中…" : "連結並上架"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
