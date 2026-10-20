/**
 * /admin/products —— 「商品」：前台看得到的每一種品項，一頁管完。
 *
 * 2026-10-20 店家：「商品部分也簡化，在一個頁面就可以管理全部的商品」。這一頁把原本
 * 散在側欄三個地方的東西收在一起，用上面的分頁切換：
 *
 *   一般商品  public.products（goods/book，沒有刊物指向它的）   原本就在這一頁
 *   地方刊物  public.publications（＋連到的那件 book 商品）      原本 /admin/publications
 *   選品      public.curated_items                              原本 /admin/curated
 *   活動票券  public.products（event/journey）                   原本就在這一頁
 *
 * 怎麼攤成一張清單、哪一件不重複列、上下架開關對應到哪一欄，全部在
 * src/lib/admin/unified-products.ts（純函式，scripts/unified-products-selftest.mjs
 * 直接 import 那一份來驗）。
 *
 * ⚠️ 這一頁**沒有自己的寫入路徑**。每一個動作都是呼叫既有的 server fn：
 *    商品 → fns/products.ts、刊物 → fns/publications.ts、選品 → fns/curated.ts。
 *    表單也是同一份（刊物與選品的表單搬到 src/components/admin/products/）。
 *
 * ⚠️ 活動商品（source_type='event'）是活動編輯頁投影出來的（0026／0029）：價格、
 *    上下架在活動頁改，這裡只顯示並連過去。在這裡改會跟活動頁互相覆蓋。
 *
 * 名額與日期不在商品上——由「活動報名」頁按場次維護（0020）。
 */
import { useMemo, useState, type ReactNode } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
  ExternalLink,
  ImageOff,
  Link2,
  Link2Off,
  ListOrdered,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { CuratedItemForm } from "@/components/admin/products/CuratedItemForm";
import { NewGoodsForm, type NewGoodsValues } from "@/components/admin/products/NewGoodsForm";
import {
  LinkForm,
  PublicationForm,
  type Publication,
} from "@/components/admin/products/PublicationForms";
import {
  productSchema,
  type CuratedItemFormValues,
  type ProductFormValues,
  type PublicationFormValues,
  type PublicationLinkFormValues,
} from "@/lib/admin/schemas";
import type { listProducts } from "@/lib/admin/fns/products";
import type { listCuratedItems } from "@/lib/admin/fns/curated";
import {
  CREATE_OPTIONS,
  KIND_LABEL,
  SORT_KEYS,
  SORT_LABEL,
  TAB_LABEL,
  UNIFIED_TABS,
  buildNewGoodsPayload,
  buildUnifiedRows,
  countByTab,
  filterUnifiedRows,
  nextCuratedSortOrder,
  nextProductStatus,
  parsePriceInput,
  parseUnifiedTab,
  slugFromTitle,
  sortUnifiedRows,
  type SortKey,
  type StatusFilter,
  type UnifiedKind,
  type UnifiedRow,
  type UnifiedTab,
} from "@/lib/admin/unified-products";
import { imageFor, curatedObjects } from "@/lib/images";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import bookstoreImg from "@/assets/bookstore-interior.jpg";

type ProductRow = Awaited<ReturnType<typeof listProducts>>[number];
type CuratedItemRow = Awaited<ReturnType<typeof listCuratedItems>>[number];
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

function formatTWD(n: number): string {
  return `NT$${n.toLocaleString("zh-Hant-TW")}`;
}

export const Route = createFileRoute("/admin/_shell/products")({
  // `type` 刻意 optional：活動編輯頁的 MirrorNote 等處 <Link to="/admin/products">
  // 不帶 search，它們要去的就是「全部」。舊網址 /admin/publications、/admin/curated
  // 轉進來時帶的是對應的分頁。
  validateSearch: (search: Record<string, unknown>): { type?: UnifiedKind } => {
    const type = parseUnifiedTab(search.type);
    return type && type !== "all" ? { type } : {};
  },
  loader: async () => {
    const { listProducts } = await import("@/lib/admin/fns/products");
    const { listPublications, listPublicationNameMatches } =
      await import("@/lib/admin/fns/publications");
    const { listInventoryCandidates, listListedInventoryProducts } =
      await import("@/lib/admin/fns/inventory-listing");
    const { listCuratedThemes, listCuratedItems } = await import("@/lib/admin/fns/curated");
    const [products, publications, nameMatches, candidates, listed, curatedThemes] =
      await Promise.all([
        listProducts(),
        listPublications(),
        listPublicationNameMatches(),
        listInventoryCandidates(),
        listListedInventoryProducts(),
        listCuratedThemes(),
      ]);
    // 選品按主題讀（既有的 fn 就是這個形狀）。主題只有個位數，平行讀即可。
    const curatedItems = (
      await Promise.all(curatedThemes.map((t) => listCuratedItems({ data: { theme_id: t.id } })))
    ).flat();
    return {
      products,
      publications,
      nameMatches,
      candidates,
      listed,
      curatedThemes,
      curatedItems,
    };
  },
  head: () => ({
    meta: [{ title: "商品｜小時光書店後台" }],
  }),
  component: AdminProductsPage,
});

function toFormValues(row: ProductRow): ProductFormValues {
  return {
    id: row.id,
    slug: row.slug,
    product_type: row.product_type,
    source_type: row.source_type,
    source_id: row.source_id,
    title: row.title,
    summary: row.summary,
    description: row.description,
    price: row.price,
    compare_at_price: row.compare_at_price,
    stock: row.stock,
    image_key: row.image_key,
    requires_shipping: row.requires_shipping,
    status: row.status,
    sort_order: row.sort_order,
  };
}

function toPublicationValues(p: Publication): PublicationFormValues {
  // 原樣帶回（null 保持 null），開關只改 is_published 一欄。
  return {
    id: p.id,
    title: p.title,
    publisher: p.publisher,
    intro: p.intro,
    region: p.region,
    issues: p.issues,
    external_url: p.external_url,
    cover_image_key: p.cover_image_key,
    is_published: p.is_published,
    sort_order: p.sort_order,
  };
}

function toCuratedValues(row: CuratedItemRow): CuratedItemFormValues {
  return {
    id: row.id,
    theme_id: row.theme_id,
    name: row.name,
    note: row.note,
    is_published: row.is_published,
    sort_order: row.sort_order,
  };
}

function rowImage(row: UnifiedRow): string | null {
  if (row.kind === "curated") return null;
  return imageFor(row.imageKey, row.kind === "publication" ? bookstoreImg : curatedObjects);
}

type EditTarget =
  | { kind: "product"; row: ProductRow }
  | { kind: "publication"; row: Publication }
  | { kind: "curated"; row: CuratedItemRow };

type CreateStep = null | "pick" | UnifiedKind;

function AdminProductsPage() {
  const data = Route.useLoaderData();
  const { type } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const tab: UnifiedTab = type ?? "all";

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("default");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [linkTarget, setLinkTarget] = useState<Publication | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<Publication | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UnifiedRow | null>(null);
  const [create, setCreate] = useState<CreateStep>(null);

  const productById = useMemo(() => new Map(data.products.map((p) => [p.id, p])), [data.products]);
  const pubById = useMemo(
    () => new Map(data.publications.map((p) => [p.id, p])),
    [data.publications],
  );
  const curatedById = useMemo(
    () => new Map(data.curatedItems.map((c) => [c.id, c])),
    [data.curatedItems],
  );
  const nameMatches = data.nameMatches;
  const matchesByPublication = useMemo(() => {
    const m = new Map<string, (typeof nameMatches)[number][]>();
    for (const row of nameMatches) {
      const list = m.get(row.publication_id) ?? [];
      list.push(row);
      m.set(row.publication_id, list);
    }
    return m;
  }, [nameMatches]);

  const allRows = useMemo(
    () =>
      buildUnifiedRows({
        products: data.products,
        publications: data.publications,
        curatedThemes: data.curatedThemes,
        curatedItems: data.curatedItems,
        listed: data.listed,
      }),
    [data],
  );
  const counts = useMemo(() => countByTab(allRows), [allRows]);
  const rows = useMemo(
    () => sortUnifiedRows(filterUnifiedRows(allRows, { tab, query, status }), sort),
    [allRows, tab, query, status, sort],
  );

  function setTab(next: UnifiedTab) {
    void navigate({ search: next === "all" ? {} : { type: next }, replace: true });
  }

  async function run(key: string, ok: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusyKey(key);
    try {
      await fn();
      await router.invalidate();
      toast.success(ok);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  async function saveProduct(values: ProductFormValues) {
    const { upsertProduct } = await import("@/lib/admin/fns/products");
    await upsertProduct({ data: values });
  }

  /*
   * 列上的快速動作（上下架、改價）一律「先讀最新的那一列、只改一欄、再整列寫回」。
   * 既有的 upsert fn 都是整列寫入；拿畫面上的快照去寫，會把這段時間裡別人（或自己
   * 剛按的另一個動作、loader 還沒重跑完）存進去的值蓋回舊的 —— 本機實測過：改完價
   * 立刻按上架，價格被寫回原價。讀一次 by id 很便宜，換到的是不會互相覆蓋。
   */
  async function patchProduct(
    id: string,
    patch: (fresh: ProductRow) => Partial<ProductFormValues>,
  ) {
    const { getProductById } = await import("@/lib/admin/fns/products");
    const fresh = await getProductById({ data: { id } });
    if (!fresh) throw new Error("找不到這件商品，可能已被刪除，請重新整理");
    await saveProduct({ ...toFormValues(fresh), ...patch(fresh) });
  }

  function togglePublish(row: UnifiedRow, next: boolean) {
    const label = next ? "已上架" : "已下架";
    if (row.kind === "publication") {
      void run(row.key, label, async () => {
        const { getPublicationById, updatePublication } =
          await import("@/lib/admin/fns/publications");
        const fresh = await getPublicationById({ data: { id: String(row.id) } });
        if (!fresh) throw new Error("找不到這本刊物，請重新整理");
        await updatePublication({ data: { ...toPublicationValues(fresh), is_published: next } });
      });
    } else if (row.kind === "curated") {
      void run(row.key, label, async () => {
        const { getCuratedItemById, upsertCuratedItem } = await import("@/lib/admin/fns/curated");
        const fresh = await getCuratedItemById({ data: { id: Number(row.id) } });
        if (!fresh) throw new Error("找不到這個選品，請重新整理");
        await upsertCuratedItem({ data: { ...toCuratedValues(fresh), is_published: next } });
      });
    } else {
      if (!row.editable) return;
      void run(row.key, label, () =>
        patchProduct(String(row.id), (fresh) => ({
          status: nextProductStatus(fresh.status, next),
        })),
      );
    }
  }

  async function savePrice(row: UnifiedRow, raw: string): Promise<boolean> {
    if (!row.productId || !row.priceEditable) return false;
    const parsed = parsePriceInput(raw, { min: row.kind === "publication" ? 1 : 0 });
    if (!parsed.ok) {
      toast.error(parsed.message);
      return false;
    }
    if (parsed.value === row.price) return true;
    return run(row.key, `價格已改為 ${formatTWD(parsed.value)}`, () =>
      patchProduct(row.productId as string, () => ({ price: parsed.value })),
    );
  }

  function openEdit(row: UnifiedRow) {
    if (row.kind === "publication") {
      const pub = pubById.get(String(row.id));
      if (pub) setEdit({ kind: "publication", row: pub });
    } else if (row.kind === "curated") {
      const item = curatedById.get(Number(row.id));
      if (item) setEdit({ kind: "curated", row: item });
    } else {
      const p = productById.get(String(row.id));
      if (p) setEdit({ kind: "product", row: p });
    }
  }

  async function submitEdit(fn: () => Promise<unknown>, ok: string) {
    setSubmitting(true);
    try {
      await fn();
      toast.success(ok);
      setEdit(null);
      setCreate(null);
      setLinkTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    const row = deleteTarget;
    if (!row) return;
    const ok = await run(row.key, "已刪除", async () => {
      if (row.kind === "curated") {
        const { removeCuratedItem } = await import("@/lib/admin/fns/curated");
        await removeCuratedItem({ data: { id: Number(row.id) } });
      } else {
        const { removeProduct } = await import("@/lib/admin/fns/products");
        await removeProduct({ data: { id: String(row.id) } });
      }
    });
    if (ok) setDeleteTarget(null);
  }

  async function handleUnlink() {
    const pub = unlinkTarget;
    if (!pub) return;
    const ok = await run(
      `publication:${pub.id}`,
      "已解除連結（進銷存的庫存與紀錄不受影響）",
      async () => {
        const { unlinkPublication } = await import("@/lib/admin/fns/publications");
        await unlinkPublication({ data: { publication_id: pub.id } });
      },
    );
    if (ok) setUnlinkTarget(null);
  }

  const nextSortOrder = data.products.reduce((max, p) => Math.max(max, p.sort_order), 0) + 1;

  function createGoods(values: NewGoodsValues) {
    // 亂數尾巴只是避免代稱撞名；之後在「編輯」裡可以改成好記的代稱。
    const suffix = Math.random().toString(36).slice(2, 7);
    const payload = buildNewGoodsPayload({
      ...values,
      slug: slugFromTitle(values.title.en, suffix),
      sort_order: nextSortOrder,
    });
    return submitEdit(() => saveProduct(payload), "已新增商品");
  }

  function createCurated(values: CuratedItemFormValues) {
    return submitEdit(async () => {
      const { upsertCuratedItem } = await import("@/lib/admin/fns/curated");
      await upsertCuratedItem({
        data: {
          ...values,
          id: undefined,
          sort_order: nextCuratedSortOrder(data.curatedItems, values.theme_id),
        },
      });
    }, "已新增選品");
  }

  const rowProps = (row: UnifiedRow) => ({
    row,
    // 任何一列在寫入時，所有列的快速動作都先停著：兩個整列寫入同時在飛，後到的
    // 那個會蓋掉先到的。
    busy: busyKey !== null,
    onToggle: (next: boolean) => togglePublish(row, next),
    onSavePrice: (raw: string) => savePrice(row, raw),
    onEdit: () => openEdit(row),
    onLink: () => {
      const pub = pubById.get(String(row.id));
      if (pub) setLinkTarget(pub);
    },
    onUnlink: () => {
      const pub = pubById.get(String(row.id));
      if (pub) setUnlinkTarget(pub);
    },
    onDelete: () => setDeleteTarget(row),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium">商品</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            前台看得到的一般商品、地方刊物、選品與活動票券，都在這一頁。共 {counts.all} 項。
          </p>
        </div>
        <Button onClick={() => setCreate("pick")} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新增商品
        </Button>
      </div>

      <div
        role="tablist"
        aria-label="商品種類"
        className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1"
      >
        {UNIFIED_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            data-testid={`products-tab-${t}`}
            onClick={() => setTab(t)}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 pb-2 pt-1 text-sm transition-colors ${
              tab === t
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {TAB_LABEL[t]}
            <span className="ml-1 tabular-nums text-xs text-muted-foreground">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋名稱、代稱、地區"
            className="pl-8"
            aria-label="搜尋商品"
          />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-[7.5rem]" aria-label="上架狀態">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部狀態</SelectItem>
            <SelectItem value="published">上架中</SelectItem>
            <SelectItem value="unpublished">未上架</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="w-[8.5rem]" aria-label="排序">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_KEYS.map((k) => (
              <SelectItem key={k} value={k}>
                {SORT_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground tabular-nums">顯示 {rows.length} 項</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {tab === "curated" ? (
            <Button variant="outline" size="sm" asChild className="gap-1.5">
              <Link to="/admin/products/curated-themes">
                <ListOrdered className="h-4 w-4" />
                主題與排序
              </Link>
            </Button>
          ) : null}
          {tab === "goods" ? (
            <Button variant="outline" size="sm" asChild className="gap-1.5">
              <Link to="/admin/inventory-listing">
                <Link2 className="h-4 w-4" />
                從進銷存上架
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      {/* 桌機：表格 */}
      <div className="hidden overflow-x-auto rounded-md border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">圖片</TableHead>
              <TableHead>名稱</TableHead>
              <TableHead className="w-24">種類</TableHead>
              <TableHead className="w-40">價格</TableHead>
              <TableHead className="w-40">上架</TableHead>
              <TableHead className="w-24 text-right">可售</TableHead>
              <TableHead className="hidden w-36 lg:table-cell">最後更新</TableHead>
              <TableHead className="w-40 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  沒有符合條件的品項。
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const p = rowProps(row);
                return (
                  <TableRow key={row.key} data-testid="products-row" data-kind={row.kind}>
                    <TableCell>
                      <Thumb row={row} />
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <NameCell row={row} />
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="whitespace-nowrap">
                        {KIND_LABEL[row.kind]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <PriceCell {...p} />
                    </TableCell>
                    <TableCell>
                      <PublishCell {...p} />
                    </TableCell>
                    <TableCell className="text-right">
                      <StockCell row={row} />
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                      {formatTaipeiDateTime(row.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActions {...p} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* 手機：卡片 */}
      <ul className="space-y-3 md:hidden">
        {rows.length === 0 ? (
          <li className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
            沒有符合條件的品項。
          </li>
        ) : (
          rows.map((row) => {
            const p = rowProps(row);
            return (
              <li
                key={row.key}
                data-testid="products-card"
                data-kind={row.kind}
                className="rounded-md border border-border p-3"
              >
                <div className="flex gap-3">
                  <Thumb row={row} />
                  <div className="min-w-0 flex-1">
                    <NameCell row={row} />
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <Badge variant="outline">{KIND_LABEL[row.kind]}</Badge>
                      <span>
                        可售 <StockCell row={row} />
                      </span>
                      <span>{formatTaipeiDateTime(row.updatedAt)}</span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <PriceCell {...p} />
                  <PublishCell {...p} />
                </div>
                <div className="mt-2 flex justify-end border-t border-border pt-2">
                  <RowActions {...p} />
                </div>
              </li>
            );
          })
        )}
      </ul>

      {/* 編輯：依種類開對應的那一張既有表單 */}
      <Dialog open={edit !== null} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {edit?.kind === "product" ? (
            <>
              <DialogHeader>
                <DialogTitle>編輯「{edit.row.title.zh}」</DialogTitle>
                <DialogDescription>
                  中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。
                </DialogDescription>
              </DialogHeader>
              <ProductForm
                key={edit.row.id}
                defaultValues={toFormValues(edit.row)}
                onSubmit={(values) =>
                  submitEdit(() => saveProduct({ ...values, id: edit.row.id }), "已更新商品")
                }
                submitting={submitting}
                submitLabel="儲存變更"
              />
            </>
          ) : edit?.kind === "publication" ? (
            <>
              <DialogHeader>
                <DialogTitle>編輯「{edit.row.title.zh}」</DialogTitle>
                <DialogDescription>
                  刊名、製作單位與介紹都是三語，缺一語前台那一語就會是空白。代稱與原始序號不開放修改——
                  它們是回頭對照原始清單的憑據。
                  {edit.row.product_id ? " 售價在清單上直接改。" : ""}
                </DialogDescription>
              </DialogHeader>
              <PublicationForm
                key={edit.row.id}
                publication={edit.row}
                onSubmit={(values) =>
                  submitEdit(async () => {
                    const { updatePublication } = await import("@/lib/admin/fns/publications");
                    await updatePublication({ data: values });
                  }, "已儲存")
                }
                submitting={submitting}
              />
            </>
          ) : edit?.kind === "curated" ? (
            <>
              <DialogHeader>
                <DialogTitle>編輯選品「{edit.row.name.zh}」</DialogTitle>
                <DialogDescription>
                  選品只展示、不販售。主題本身與排序在「主題與排序」頁調整。
                </DialogDescription>
              </DialogHeader>
              <CuratedItemForm
                key={edit.row.id}
                // 編輯時不給主題下拉：換主題要連 sort_order 一起換（unique(theme_id,
                // sort_order)），而 upsertCuratedItem 的更新分支刻意不寫 sort_order。
                defaultValues={toCuratedValues(edit.row)}
                onSubmit={(values) =>
                  submitEdit(async () => {
                    const { upsertCuratedItem } = await import("@/lib/admin/fns/curated");
                    await upsertCuratedItem({ data: { ...values, id: edit.row.id } });
                  }, "已更新選品")
                }
                submitting={submitting}
                submitLabel="儲存變更"
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* 新增：先選種類，再填那一種的必要欄位 */}
      <Dialog open={create !== null} onOpenChange={(o) => !o && setCreate(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {create === "pick" || create === null ? "新增商品" : `新增${KIND_LABEL[create]}`}
            </DialogTitle>
            <DialogDescription>
              {create === "pick" || create === null
                ? "先選要新增哪一種。"
                : create === "goods"
                  ? "只填開賣需要的幾格；長說明、原價、網址代稱之後在「編輯」補。"
                  : "選品只展示、不販售。"}
            </DialogDescription>
          </DialogHeader>
          {create === "pick" ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {CREATE_OPTIONS.map((opt) => {
                const body = (
                  <>
                    <span className="font-medium">{opt.label}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{opt.hint}</span>
                  </>
                );
                const cls =
                  "rounded-md border border-border p-3 text-left text-sm transition-colors hover:bg-muted";
                if (opt.href) {
                  const go = (
                    <>
                      {body}
                      <span className="mt-1 inline-flex items-center gap-1 text-xs">
                        前往 <ExternalLink className="h-3 w-3" />
                      </span>
                    </>
                  );
                  return opt.href === "/admin/journeys/new" ? (
                    <Link key={opt.key} to="/admin/journeys/new" className={cls}>
                      {go}
                    </Link>
                  ) : (
                    <Link
                      key={opt.key}
                      to="/admin/events/$id"
                      params={{ id: "new" }}
                      className={cls}
                    >
                      {go}
                    </Link>
                  );
                }
                const disabled = opt.kind === "publication";
                return (
                  <button
                    key={opt.key}
                    type="button"
                    disabled={disabled}
                    data-testid={`create-${opt.key}`}
                    onClick={() => setCreate(opt.kind)}
                    className={`${cls} disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent`}
                  >
                    {body}
                  </button>
                );
              })}
            </div>
          ) : create === "goods" ? (
            <NewGoodsForm onSubmit={createGoods} submitting={submitting} />
          ) : create === "curated" ? (
            <CuratedItemForm
              defaultValues={{
                theme_id: data.curatedThemes[0]?.id ?? "",
                name: { zh: "", en: "", ja: "" },
                note: { zh: "", en: "", ja: "" },
                is_published: false,
                sort_order: 0,
              }}
              themes={data.curatedThemes}
              onSubmit={createCurated}
              submitting={submitting}
              submitLabel="建立選品"
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={linkTarget !== null} onOpenChange={(o) => !o && setLinkTarget(null)}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>把「{linkTarget?.title.zh}」連到庫存商品</DialogTitle>
            <DialogDescription>
              挑一個進銷存品項、填上售價，前台立刻長出購買鈕。三語文案與封面直接沿用
              這本刊物的，不用重打。
            </DialogDescription>
          </DialogHeader>
          {linkTarget && (
            <LinkForm
              key={linkTarget.id}
              publication={linkTarget}
              suggested={matchesByPublication.get(linkTarget.id) ?? []}
              candidates={data.candidates}
              onSubmit={(values: PublicationLinkFormValues) =>
                submitEdit(async () => {
                  const { linkPublicationToInventory } =
                    await import("@/lib/admin/fns/publications");
                  await linkPublicationToInventory({ data: values });
                }, "已連結，前台立刻可以買")
              }
              submitting={submitting}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={unlinkTarget !== null} onOpenChange={(o) => !o && setUnlinkTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>解除「{unlinkTarget?.title.zh}」的商品連結？</AlertDialogTitle>
            <AlertDialogDescription>
              前台的購買鈕會消失，這本刊物仍留在展覽頁上。進銷存那一側的庫存、銷售
              紀錄與成本完全不受影響。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyKey !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyKey !== null}
              onClick={(e) => {
                e.preventDefault();
                void handleUnlink();
              }}
            >
              {busyKey !== null ? "處理中…" : "確定解除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要刪除「{deleteTarget?.name}」嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              刪除後無法復原。只是暫時不賣的話，用「上架」開關關掉就好。
              {deleteTarget?.kind === "ticket" ? (
                <span className="mt-2 block font-medium text-destructive">
                  這是活動類商品。刪除會連帶刪掉它的所有場次——只要任何一個場次有人
                  報名或下過單，資料庫會擋下整筆刪除（場次與訂單明細之間是 on delete
                  restrict）。請先到「活動報名」處理那些場次。
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyKey !== null}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyKey !== null}
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busyKey !== null ? "刪除中…" : "刪除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 一列的各個格子（表格與手機卡片共用）
// ---------------------------------------------------------------------------

type RowProps = {
  row: UnifiedRow;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onSavePrice: (raw: string) => Promise<boolean>;
  onEdit: () => void;
  onLink: () => void;
  onUnlink: () => void;
  onDelete: () => void;
};

function Thumb({ row }: { row: UnifiedRow }) {
  const src = rowImage(row);
  if (!src) {
    return (
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
        <ImageOff className="h-4 w-4" aria-hidden />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className="h-12 w-12 shrink-0 rounded border border-border object-cover"
    />
  );
}

function NameCell({ row }: { row: UnifiedRow }) {
  return (
    <div className="min-w-0">
      <p className="truncate font-medium" title={row.name}>
        {row.name}
      </p>
      {row.subtitle ? (
        <p className="truncate text-xs text-muted-foreground">{row.subtitle}</p>
      ) : null}
    </div>
  );
}

function StockCell({ row }: { row: UnifiedRow }) {
  if (row.stock == null) {
    return <span className="text-muted-foreground">{row.stockNote || "—"}</span>;
  }
  const body = <span className="font-medium tabular-nums">{row.stock}</span>;
  if (row.invName) {
    // 可售量是進銷存算的（inv_listed_products）。點過去看那個品項的庫存與進貨。
    return (
      <Link
        to="/admin/inventory-listing"
        title={`進銷存品項：${row.invName}`}
        className="underline-offset-2 hover:underline"
      >
        {body}
      </Link>
    );
  }
  return body;
}

function PriceCell({ row, busy, onSavePrice }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (row.price == null) {
    return (
      <span className="text-sm text-muted-foreground">
        {row.kind === "curated" ? "不販售" : "未定價"}
      </span>
    );
  }

  if (editing) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onSavePrice(draft)) setEditing(false);
        }}
      >
        <Input
          autoFocus
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
          className="h-8 w-20"
          aria-label={`${row.name} 的價格`}
          disabled={busy}
        />
        <Button type="submit" size="sm" className="h-8 px-2" disabled={busy}>
          {busy ? "…" : "存"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 px-2"
          onClick={() => setEditing(false)}
          disabled={busy}
        >
          取消
        </Button>
      </form>
    );
  }

  const text: ReactNode = (
    <>
      {row.comparePrice != null && row.comparePrice > row.price ? (
        <span className="mr-1 text-xs line-through opacity-60">{formatTWD(row.comparePrice)}</span>
      ) : null}
      <span className="tabular-nums">{formatTWD(row.price)}</span>
    </>
  );

  if (!row.priceEditable) return <span className="text-sm">{text}</span>;
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(String(row.price));
        setEditing(true);
      }}
      className="group inline-flex items-center gap-1 rounded px-1 text-sm hover:bg-muted"
      aria-label={`修改 ${row.name} 的價格`}
      data-testid="price-edit"
    >
      {text}
      <Pencil className="h-3 w-3 text-muted-foreground opacity-60 group-hover:opacity-100" />
    </button>
  );
}

function PublishCell({ row, busy, onToggle }: RowProps) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <Switch
        checked={row.published}
        onCheckedChange={onToggle}
        disabled={busy || !row.editable}
        aria-label={`${row.name} 上架`}
        data-testid="publish-toggle"
      />
      <span className={`whitespace-nowrap ${row.published ? "" : "text-muted-foreground"}`}>
        {row.statusLabel}
      </span>
    </label>
  );
}

function RowActions({ row, busy, onEdit, onLink, onUnlink, onDelete }: RowProps) {
  if (row.eventId) {
    return (
      <Button variant="ghost" size="sm" asChild className="gap-1">
        <Link to="/admin/events/$id" params={{ id: row.eventId }}>
          到活動頁編輯
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </Button>
    );
  }
  return (
    <div className="flex justify-end gap-1">
      <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy} data-testid="row-edit">
        編輯
      </Button>
      {row.kind === "publication" ? (
        row.productId ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`解除連結 ${row.name}`}
            title="解除商品連結"
            onClick={onUnlink}
            disabled={busy}
          >
            <Link2Off className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`連到庫存商品 ${row.name}`}
            title="連到庫存商品（開賣）"
            onClick={onLink}
            disabled={busy}
          >
            <Link2 className="h-4 w-4" />
          </Button>
        )
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="text-destructive hover:text-destructive"
          aria-label={`刪除 ${row.name}`}
          onClick={onDelete}
          disabled={busy}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 一般商品／活動票券的完整表單（原本就在這一頁；名額改由「活動報名」按場次維護）
// ---------------------------------------------------------------------------

type ProductFormProps = {
  defaultValues: ProductFormValues;
  onSubmit: (values: ProductFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function ProductForm({ defaultValues, onSubmit, submitting, submitLabel }: ProductFormProps) {
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues,
  });

  const productType = useWatch({ control: form.control, name: "product_type" });
  const bookable = isBookableType(productType);
  const shippable = isShippableType(productType);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
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

        <div className="grid grid-cols-2 gap-4">
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
          <div className="grid grid-cols-2 gap-4 rounded-md border border-border p-4">
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

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "儲存中…" : submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
