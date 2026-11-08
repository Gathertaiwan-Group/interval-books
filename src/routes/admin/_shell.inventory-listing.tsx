/**
 * /admin/inventory-listing —— 上架
 *
 * 把進銷存裡的一個品項，變成店面型錄上的一件商品。
 *
 * ── 這一頁為什麼是庫存與型錄的分界線 ──────────────────────────────────────
 * 進銷存的資料是**單語**的：`name` 就是一個 text 欄位，「紅烏龍茶餅」。型錄是
 * **三語** jsonb，因為這個站有中英日三個版本。這中間沒有任何自動轉換的可能 ——
 * 沒有人能從進貨單上的品名生出一句可以放在英文站商品頁上的文案。
 *
 * 所以上架必然是「人坐下來補資料」的動作，不是同步任務。這也是為什麼
 * LocalizedField 只出現在這一頁：它標記的正是「從這裡開始，資料要變成三語」。
 *
 * ── 沒有庫存欄位，這是刻意的 ──────────────────────────────────────────────
 * 上架之後這件商品的庫存只有一份，在 inv.products.stock_quantity。
 * public.products.stock 必須是 NULL，0011 有 trigger 擋著。表單裡不放那個欄位，
 * 是要讓「這個數字不存在」在 UI 上就成立，而不是等送出才被資料庫拒絕。
 */
import { useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { inventoryListingSchema, type InventoryListingFormValues } from "@/lib/admin/schemas";
import type {
  listInventoryCandidates,
  listListedInventoryProducts,
} from "@/lib/admin/fns/inventory-listing";

export const Route = createFileRoute("/admin/_shell/inventory-listing")({
  loader: async () => {
    const { listInventoryCandidates, listListedInventoryProducts } =
      await import("@/lib/admin/fns/inventory-listing");
    const [candidates, listed] = await Promise.all([
      listInventoryCandidates(),
      listListedInventoryProducts(),
    ]);
    return { candidates, listed };
  },
  head: () => ({
    meta: [{ title: "上架｜小時光書店後台" }],
  }),
  component: AdminInventoryListingPage,
});

type Candidate = Awaited<ReturnType<typeof listInventoryCandidates>>[number];
type Listed = Awaited<ReturnType<typeof listListedInventoryProducts>>[number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

const formatTWD = (n: number) => `NT$${n.toLocaleString("zh-Hant-TW")}`;

/**
 * 進銷存的品名 → 網址代稱的第一版草稿。
 *
 * 中文字在 slug 裡不好用，所以中文品名多半會被剝成空字串 —— 那時候就回傳空字串，
 * 讓店員自己填。**刻意不做音譯**：猜錯的網址代稱會被搜尋引擎記住，而且改網址代稱
 * 等於讓舊連結全部失效。寧可留白也不要猜。
 */
function slugDraft(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function AdminInventoryListingPage() {
  const { candidates, listed } = Route.useLoaderData();
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Listed | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: InventoryListingFormValues) {
    setSubmitting(true);
    try {
      const { createInventoryListing } = await import("@/lib/admin/fns/inventory-listing");
      await createInventoryListing({ data: values });
      toast.success("已上架");
      setDialogOpen(false);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上架失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { removeInventoryListing } = await import("@/lib/admin/fns/inventory-listing");
      await removeInventoryListing({ data: { product_id: deleteTarget.product_id } });
      toast.success("已下架（進銷存的庫存與紀錄不受影響）");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "下架失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">上架</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            已上架 {listed.length} 件，進銷存裡還有 {candidates.length} 個品項可以上架
          </p>
        </div>
        <Button onClick={openCreate} className="gap-1.5" disabled={candidates.length === 0}>
          <Plus className="h-4 w-4" />
          上架商品
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>網址代稱</TableHead>
              <TableHead>標題</TableHead>
              <TableHead>進銷存品項</TableHead>
              <TableHead className="text-right">售價</TableHead>
              <TableHead className="text-right">每件出貨</TableHead>
              <TableHead className="text-right">實體庫存</TableHead>
              <TableHead className="text-right">保留中</TableHead>
              <TableHead className="text-right">可售</TableHead>
              <TableHead>狀態</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {listed.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                  還沒有商品是從進銷存上架的，點右上角「上架商品」開始。
                </TableCell>
              </TableRow>
            ) : (
              listed.map((row) => (
                <TableRow key={row.product_id}>
                  <TableCell className="font-mono text-xs">{row.slug}</TableCell>
                  <TableCell>{row.title.zh}</TableCell>
                  <TableCell className="text-muted-foreground">{row.inv_name}</TableCell>
                  <TableCell className="text-right">{formatTWD(row.price)}</TableCell>
                  <TableCell className="text-right">{row.units_per_sale}</TableCell>
                  <TableCell className="text-right">{row.stock_quantity}</TableCell>
                  <TableCell className="text-right">{row.reserved}</TableCell>
                  <TableCell className="text-right font-medium">{row.available}</TableCell>
                  <TableCell>
                    <Badge variant={row.status === "active" ? "default" : "secondary"}>
                      {row.status === "active"
                        ? "已上架"
                        : row.status === "draft"
                          ? "草稿"
                          : "封存"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="下架"
                      onClick={() => setDeleteTarget(row)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>上架商品</DialogTitle>
            <DialogDescription>
              從進銷存挑一個品項，補上三語文案與網址代稱。庫存不用填 ——
              上架之後這件商品的庫存只有進銷存那一份。
            </DialogDescription>
          </DialogHeader>
          <ListingForm
            key={formKey}
            candidates={candidates}
            onSubmit={handleSubmit}
            submitting={submitting}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>下架「{deleteTarget?.title.zh}」？</AlertDialogTitle>
            <AlertDialogDescription>
              這只會把商品從網站上移除。進銷存那一側的庫存、銷售紀錄與成本都不受影響。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? "下架中…" : "確定下架"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type ListingFormProps = {
  candidates: Candidate[];
  onSubmit: (values: InventoryListingFormValues) => void | Promise<void>;
  submitting: boolean;
};

function ListingForm({ candidates, onSubmit, submitting }: ListingFormProps) {
  const form = useForm<InventoryListingFormValues>({
    resolver: zodResolver(inventoryListingSchema),
    defaultValues: {
      inv_product_id: "",
      slug: "",
      title: { ...EMPTY_LOCALIZED },
      summary: { ...EMPTY_LOCALIZED },
      description: { ...EMPTY_LOCALIZED },
      price: 0,
      units_per_sale: 1,
      product_type: "goods",
      status: "draft",
    },
  });

  const selectedId = useWatch({ control: form.control, name: "inv_product_id" });
  const selected = useMemo(
    () => candidates.find((c) => c.inv_product_id === selectedId) ?? null,
    [candidates, selectedId],
  );

  /**
   * 挑了品項之後，把進銷存已經知道的東西帶進表單：售價、中文標題、網址代稱草稿。
   *
   * 只填**空白的**欄位。店員改過的字不該因為換了一次下拉選單就被蓋掉。
   */
  function applyCandidate(id: string) {
    form.setValue("inv_product_id", id, { shouldDirty: true, shouldValidate: true });
    const c = candidates.find((x) => x.inv_product_id === id);
    if (!c) return;
    if (!form.getValues("title.zh")) {
      form.setValue("title.zh", c.name, { shouldDirty: true });
    }
    if (!form.getValues("price")) {
      // 進銷存的 selling_price 是 numeric，型錄是整數元。四捨五入而不是無條件捨去：
      // 199.5 進位成 200 是店裡本來就會做的事，捨成 199 會少收錢。
      form.setValue("price", Math.round(Number(c.selling_price)), { shouldDirty: true });
    }
    if (!form.getValues("slug")) {
      form.setValue("slug", slugDraft(c.name), { shouldDirty: true });
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
              <Select value={field.value || undefined} onValueChange={applyCandidate}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="選一個品項" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className="max-h-72">
                  {candidates.map((c) => (
                    <SelectItem key={c.inv_product_id} value={c.inv_product_id}>
                      {c.name}（庫存 {c.stock_quantity}
                      {c.pack_size > 1 ? `，一組 ${c.pack_size}` : ""}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                只列出已核准、未停用、有庫存，而且還沒上架過的品項。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {selected !== null && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p className="text-muted-foreground">
              進銷存售價 {formatTWD(Math.round(Number(selected.selling_price)))}
              ｜現有庫存 {selected.stock_quantity}
              {selected.pack_size > 1 ? `｜一組 ${selected.pack_size} 個` : ""}
            </p>
          </div>
        )}

        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>網址代稱</FormLabel>
              <FormControl>
                <Input placeholder="例如 red-oolong-cake" {...field} />
              </FormControl>
              <FormDescription>
                建議使用半形英數字與連字號，且不能與其他商品重複。上線後不要再改 ——
                改了等於讓舊連結全部失效。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <LocalizedField name="title" label="標題" />
        <LocalizedField name="summary" label="摘要" multiline />
        <LocalizedField name="description" label="說明" multiline />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>售價（元）</FormLabel>
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
                      field.onChange(e.target.value === "" ? 0 : Math.trunc(Number(e.target.value)))
                    }
                  />
                </FormControl>
                <FormDescription>網站上的售價，與進銷存的售價可以不同。</FormDescription>
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
                <FormDescription>
                  網站賣出 1 件要從進銷存出幾個。一般是 1；若這一件是「三入組」就填 3。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="product_type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>類型</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="goods">商品</SelectItem>
                    <SelectItem value="book">書籍</SelectItem>
                  </SelectContent>
                </Select>
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
                    <SelectItem value="draft">草稿（前台看不到）</SelectItem>
                    <SelectItem value="active">上架（前台立刻可買）</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "上架中…" : "上架"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
