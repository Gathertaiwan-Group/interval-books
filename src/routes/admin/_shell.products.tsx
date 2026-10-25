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
 *
 * ── 內頁（2026-10-25 起，業主：「不要用彈窗，直接顯示內頁＆回到上一頁」）─────
 * 編輯／新增不再是彈窗：
 *   /admin/products/product/$id      一般商品／策旅票券（ProductForm）
 *   /admin/products/product/new      新增一般商品（NewGoodsForm）
 *   /admin/products/publication/$id  刊物校稿（PublicationForm）
 *   /admin/products/curated/$id      選品一項（CuratedItemForm）
 *   /admin/products/curated/new      新增選品
 * 活動票券照舊連到 /admin/events/$id。各內頁的 loader 只抓那一筆（fns/products.ts 最後）。
 * 留在這一頁的：改價、上下架、連到庫存／解除連結（上架動作）、刪除確認。
 * 搜尋字、狀態、排序記在 list-memory，從內頁「← 回到列表」回來原樣還原；分頁籤本來就在網址
 * （?type=）。這一頁的資料直接用 loader 的（沒有抄進 useState），存檔後 invalidate 就是新的。
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { ChevronDown, ExternalLink, Link2, ListOrdered, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LinkForm, type Publication } from "@/components/admin/products/PublicationForms";
import {
  formatTWD,
  NameCell,
  PriceCell,
  PublishCell,
  RowActions,
  StockCell,
  Thumb,
} from "@/components/admin/products/ProductRowCells";
import {
  toCuratedValues,
  toFormValues,
  toPublicationValues,
  type ProductRow,
} from "@/components/admin/products/form-values";
import type { ProductFormValues, PublicationLinkFormValues } from "@/lib/admin/schemas";
import { readAdminListMemory, writeAdminListMemory } from "@/lib/admin/list-memory";
import {
  CREATE_OPTIONS,
  KIND_LABEL,
  SORT_KEYS,
  SORT_LABEL,
  TAB_LABEL,
  UNIFIED_TABS,
  buildUnifiedRows,
  countByTab,
  filterUnifiedRows,
  nextProductStatus,
  parsePriceInput,
  parseUnifiedTab,
  sortUnifiedRows,
  type SortKey,
  type StatusFilter,
  type UnifiedKind,
  type UnifiedRow,
  type UnifiedTab,
} from "@/lib/admin/unified-products";
import { formatTaipeiDateTime } from "@/lib/taipei-time";

/** 搜尋字、狀態、排序：記在分頁記憶體（list-memory），從內頁回來原樣還原。 */
type ListPrefs = { query: string; status: StatusFilter; sort: SortKey };
const LIST_PREFS_KEY = "products:list-prefs";
const DEFAULT_PREFS: ListPrefs = { query: "", status: "all", sort: "default" };

export const Route = createFileRoute("/admin/_shell/products")({
  // `type` 刻意 optional：活動編輯頁的 MirrorNote 等處 <Link to="/admin/products">
  // 不帶 search，它們要去的就是「全部」。舊網址 /admin/publications、/admin/curated
  // 轉進來時帶的是對應的分頁。
  validateSearch: (search: Record<string, unknown>): { type?: UnifiedKind } => {
    const type = parseUnifiedTab(search.type);
    return type && type !== "all" ? { type } : {};
  },
  // 一支 fn 拿齊整頁（身分只驗一次、查詢在伺服器上平行跑、同名比對在程式裡算）——
  // 見 src/lib/admin/fns/products.ts 的 getAdminProductsPageData。
  loader: async () => {
    const { getAdminProductsPageData } = await import("@/lib/admin/fns/products");
    return await getAdminProductsPageData();
  },
  head: () => ({
    meta: [{ title: "商品｜小時光書店後台" }],
  }),
  component: AdminProductsPage,
});

function AdminProductsPage() {
  const data = Route.useLoaderData();
  const { type } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const tab: UnifiedTab = type ?? "all";

  const [prefs, setPrefsState] = useState<ListPrefs>(
    () => readAdminListMemory<ListPrefs>(LIST_PREFS_KEY) ?? DEFAULT_PREFS,
  );
  const { query, status, sort } = prefs;
  function setPrefs(patch: Partial<ListPrefs>) {
    setPrefsState((prev) => {
      const next = { ...prev, ...patch };
      writeAdminListMemory(LIST_PREFS_KEY, next);
      return next;
    });
  }
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [linkTarget, setLinkTarget] = useState<Publication | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<Publication | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UnifiedRow | null>(null);

  const pubById = useMemo(
    () => new Map(data.publications.map((p) => [p.id, p])),
    [data.publications],
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

  /** 「連到庫存商品」對話框的送出（上架動作，照規格留在清單上的對話框）。 */
  async function submitLink(fn: () => Promise<unknown>, ok: string) {
    setSubmitting(true);
    try {
      await fn();
      toast.success(ok);
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

  const rowProps = (row: UnifiedRow) => ({
    row,
    // 任何一列在寫入時，所有列的快速動作都先停著：兩個整列寫入同時在飛，後到的
    // 那個會蓋掉先到的。
    busy: busyKey !== null,
    onToggle: (next: boolean) => togglePublish(row, next),
    onSavePrice: (raw: string) => savePrice(row, raw),
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
        <CreateMenu />
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
            onChange={(e) => setPrefs({ query: e.target.value })}
            placeholder="搜尋名稱、代稱、地區"
            className="pl-8"
            aria-label="搜尋商品"
          />
        </div>
        <Select value={status} onValueChange={(v) => setPrefs({ status: v as StatusFilter })}>
          <SelectTrigger className="w-[7.5rem]" aria-label="上架狀態">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部狀態</SelectItem>
            <SelectItem value="published">上架中</SelectItem>
            <SelectItem value="unpublished">未上架</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setPrefs({ sort: v as SortKey })}>
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
              <Link preload="intent" to="/admin/products/curated-themes">
                <ListOrdered className="h-4 w-4" />
                主題與排序
              </Link>
            </Button>
          ) : null}
          {tab === "goods" ? (
            <Button variant="outline" size="sm" asChild className="gap-1.5">
              <Link preload="intent" to="/admin/inventory-listing">
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
                submitLink(async () => {
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

/**
 * 「＋ 新增商品」：選單（不是彈窗），每一項直接連到那一種的新增內頁。
 * 活動／策旅票券去各自的「一頁新增」；地方刊物是匯入的固定集合，不新增（灰掉並說明）。
 */
function CreateMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="gap-1.5" data-testid="create-menu">
          <Plus className="h-4 w-4" />
          新增商品
          <ChevronDown className="h-4 w-4 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(20rem,calc(100vw-2rem))]">
        {CREATE_OPTIONS.map((opt) => {
          const body = (
            <span className="min-w-0">
              <span className="flex items-center gap-1 font-medium">
                {opt.label}
                {opt.href ? <ExternalLink className="h-3 w-3" aria-hidden /> : null}
              </span>
              <span className="mt-0.5 block whitespace-normal break-words text-xs text-muted-foreground">
                {opt.hint}
              </span>
            </span>
          );
          const testid = `create-${opt.key}`;
          if (opt.href === "/admin/journeys/new") {
            return (
              <DropdownMenuItem key={opt.key} asChild data-testid={testid}>
                <Link to="/admin/journeys/new">{body}</Link>
              </DropdownMenuItem>
            );
          }
          if (opt.href === "/admin/events/new") {
            return (
              <DropdownMenuItem key={opt.key} asChild data-testid={testid}>
                <Link to="/admin/events/$id" params={{ id: "new" }}>
                  {body}
                </Link>
              </DropdownMenuItem>
            );
          }
          if (opt.kind === "goods") {
            return (
              <DropdownMenuItem key={opt.key} asChild data-testid={testid}>
                <Link to="/admin/products/product/new" preload="intent">
                  {body}
                </Link>
              </DropdownMenuItem>
            );
          }
          if (opt.kind === "curated") {
            return (
              <DropdownMenuItem key={opt.key} asChild data-testid={testid}>
                <Link to="/admin/products/curated/new" preload="intent">
                  {body}
                </Link>
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuItem key={opt.key} disabled data-testid={testid}>
              {body}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
