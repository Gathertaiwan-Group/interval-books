import { useMemo, useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ArrowDown, ArrowLeft, ArrowUp, Plus } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  localizedSchema,
  pageBlockSchema,
  type PageMetaFormValues,
  type PageListItemFormValues,
} from "@/lib/admin/schemas";
import type { getPageBySlug, listPageBlocks, listPageListItems } from "@/lib/admin/fns/pages";
import { storefront } from "@/lib/images";
import type { Localized } from "@/i18n/types";

type PageRow = NonNullable<Awaited<ReturnType<typeof getPageBySlug>>>;
type PageBlockRow = Awaited<ReturnType<typeof listPageBlocks>>[number];
type PageListItemRow = Awaited<ReturnType<typeof listPageListItems>>[number];

const EMPTY_LOCALIZED: Localized = { zh: "", en: "", ja: "" };

function isAllEmpty(loc: Localized): boolean {
  return !loc.zh.trim() && !loc.en.trim() && !loc.ja.trim();
}

/** Collapses a fully-blank {zh,en,ja} form value back to the DB's NULL for genuinely optional localized columns. */
function emptyToNull(loc: Localized): Localized | null {
  return isAllEmpty(loc) ? null : loc;
}

/**
 * Form-only counterpart to schemas.ts's `optionalLocalizedSchema`. The real
 * schema (localizedSchema.nullable().optional()) is correct for what the
 * server accepts — null, or all three languages filled — but LocalizedField
 * always binds a live {zh,en,ja} object (never null) so an admin can type
 * into it, so the live form value for an unset optional field is
 * {zh:"",en:"",ja:""}, not null. That value must validate as "fine, still
 * unset" while typing (not fail localizedSchema's per-language min(1)), and
 * only collapse to actual null right before the network call (see
 * emptyToNull above, used at each submit handler). This schema is what makes
 * the live "fine, still unset" state pass validation; it also blocks the
 * genuinely invalid partial state (e.g. zh filled, en/ja left blank), which
 * emptyToNull cannot fix on its own and which the real server-side schema
 * would otherwise reject with a raw, unfriendly Zod error.
 */
const optionalLocalizedFormSchema = z
  .object({ zh: z.string(), en: z.string(), ja: z.string() })
  .superRefine((val, ctx) => {
    const filledCount = [val.zh, val.en, val.ja].filter((s) => s.trim().length > 0).length;
    if (filledCount === 0 || filledCount === 3) return;
    const message = "此欄位若要填寫，中文、英文、日文須一起填寫；三者都留空則視為不使用此欄位。";
    (["zh", "en", "ja"] as const).forEach((lang) => {
      if (!val[lang].trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [lang], message });
    });
  });

/* ------------------------------------------------------------------ *
 * route
 * ------------------------------------------------------------------ */

export const Route = createFileRoute("/admin/_shell/pages/$slug")({
  loader: async ({ params }) => {
    const { getPageBySlug, listPageBlocks, listPageListItems } =
      await import("@/lib/admin/fns/pages");
    const [page, blocks, listItems] = await Promise.all([
      getPageBySlug({ data: { slug: params.slug } }),
      listPageBlocks({ data: { page_slug: params.slug } }),
      listPageListItems({ data: { page_slug: params.slug } }),
    ]);
    if (!page) throw notFound();
    return { page, blocks, listItems };
  },
  head: ({ params }) => ({
    meta: [{ title: `${params.slug}｜頁面文案｜小時光書店後台` }],
  }),
  component: AdminPageDetailPage,
});

function AdminPageDetailPage() {
  const { page: initialPage, blocks: initialBlocks, listItems } = Route.useLoaderData();
  const [page, setPage] = useState<PageRow>(initialPage);
  const [blocks, setBlocks] = useState<PageBlockRow[]>(initialBlocks);

  const displayName = page.header_title?.zh || page.meta_title.zh;

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 gap-1.5" asChild>
          <Link preload="intent" to="/admin/pages">
            <ArrowLeft className="h-4 w-4" />
            返回頁面文案列表
          </Link>
        </Button>
        <h1 className="mt-2 text-2xl font-medium">{displayName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">網址代稱：{page.slug}</p>
      </div>

      <PageMetaSection page={page} onSaved={setPage} />
      <PageBlocksSection pageSlug={page.slug} blocks={blocks} onSaved={setBlocks} />
      <PageListItemsSection pageSlug={page.slug} initialItems={listItems} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * section 1 — page meta (pages 表)
 * ------------------------------------------------------------------ */

function buildPageMetaFormSchema() {
  return z.object({
    slug: z.string(),
    meta_title: localizedSchema,
    meta_description: localizedSchema,
    og_title: optionalLocalizedFormSchema,
    og_description: optionalLocalizedFormSchema,
    og_image_key: z.string().nullable(),
    eyebrow_prefix: z.string(),
    eyebrow_suffix: optionalLocalizedFormSchema,
    header_title: optionalLocalizedFormSchema,
    header_intro: optionalLocalizedFormSchema,
  });
}
type PageMetaFormShape = z.infer<ReturnType<typeof buildPageMetaFormSchema>>;

function toMetaFormValues(row: PageRow): PageMetaFormShape {
  return {
    slug: row.slug,
    meta_title: row.meta_title,
    meta_description: row.meta_description,
    og_title: row.og_title ?? { ...EMPTY_LOCALIZED },
    og_description: row.og_description ?? { ...EMPTY_LOCALIZED },
    og_image_key: row.og_image_key,
    eyebrow_prefix: row.eyebrow_prefix ?? "",
    eyebrow_suffix: row.eyebrow_suffix ?? { ...EMPTY_LOCALIZED },
    header_title: row.header_title ?? { ...EMPTY_LOCALIZED },
    header_intro: row.header_intro ?? { ...EMPTY_LOCALIZED },
  };
}

function PageMetaSection({ page, onSaved }: { page: PageRow; onSaved: (row: PageRow) => void }) {
  const pageMetaFormSchema = useMemo(buildPageMetaFormSchema, []);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<PageMetaFormShape>({
    resolver: zodResolver(pageMetaFormSchema),
    defaultValues: toMetaFormValues(page),
  });

  async function onSubmit(values: PageMetaFormShape) {
    setSubmitting(true);
    try {
      const payload: PageMetaFormValues = {
        slug: values.slug,
        meta_title: values.meta_title,
        meta_description: values.meta_description,
        og_title: emptyToNull(values.og_title),
        og_description: emptyToNull(values.og_description),
        og_image_key: values.og_image_key,
        eyebrow_prefix: values.eyebrow_prefix,
        eyebrow_suffix: emptyToNull(values.eyebrow_suffix),
        header_title: emptyToNull(values.header_title),
        header_intro: emptyToNull(values.header_intro),
      };
      const { updatePageMeta } = await import("@/lib/admin/fns/pages");
      const updated = await updatePageMeta({ data: payload });
      onSaved(updated);
      toast.success("已儲存頁面 Meta");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-4 rounded-md border border-border p-4">
      <div>
        <h2 className="text-lg font-medium">頁面 Meta</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          網頁標題、搜尋結果摘要、社群分享卡片與頁首文字。中文、英文、日文皆為必填；標示「選填」的欄位可以整組留空，代表不覆蓋預設值——若要填寫，三語需一起填寫。
        </p>
      </div>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
          <LocalizedField name="meta_title" label="Meta 標題" />
          <LocalizedField name="meta_description" label="Meta 描述" multiline />
          <LocalizedField name="og_title" label="社群分享標題（選填）" optional />
          <LocalizedField name="og_description" label="社群分享描述（選填）" multiline optional />

          <FormField
            control={form.control}
            name="og_image_key"
            render={({ field }) => (
              <FormItem>
                <FormLabel>社群分享圖片（選填）</FormLabel>
                {/* Not wrapped in <FormControl> — ImageField is a plain composite
                    component, not a forwardRef primitive; see
                    src/routes/admin/_shell.exhibitions.tsx for the same call. */}
                <ImageField value={field.value} onChange={field.onChange} fallback={storefront} />
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="eyebrow_prefix"
            render={({ field }) => (
              <FormItem>
                <FormLabel>頁首標籤前綴（選填，英文）</FormLabel>
                <FormControl>
                  <Input placeholder="例如 Visit" {...field} />
                </FormControl>
                <FormDescription>
                  與下方「頁首標籤」並列顯示於頁首，例如「Visit｜來店資訊」的「Visit」。留空則不顯示前綴。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <LocalizedField name="eyebrow_suffix" label="頁首標籤（選填）" optional />
          <LocalizedField name="header_title" label="頁首標題（選填）" optional />
          <LocalizedField name="header_intro" label="頁首說明（選填）" multiline optional />

          <div className="flex justify-end">
            <Button type="submit" disabled={submitting}>
              {submitting ? "儲存中…" : "儲存頁面 Meta"}
            </Button>
          </div>
        </form>
      </Form>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * section 2 — 文案區塊 (page_blocks 表)
 * ------------------------------------------------------------------ */

function buildBlocksFormSchema() {
  return z.object({ blocks: z.array(pageBlockSchema) });
}
type BlocksFormShape = z.infer<ReturnType<typeof buildBlocksFormSchema>>;

type BlockGroup = { prefix: string | null; items: { block: PageBlockRow; index: number }[] };

/**
 * Groups blocks by the text before the first "." in block_key — but only
 * when at least one block on THIS page actually has a dot. Some pages (index)
 * are genuinely layered (hero.*, entries.*, sections.*); most are flat single
 * keys (address, hours, ...). Forcing every page into groups would produce a
 * pile of one-item "groups" for the flat pages, so a page with zero dotted
 * keys renders as a single ungrouped list instead. This is a per-page,
 * data-driven decision — never a hard-coded list of which slugs get grouped.
 */
function groupBlocks(blocks: PageBlockRow[]): BlockGroup[] {
  const hasDot = blocks.some((b) => b.block_key.includes("."));
  if (!hasDot) {
    return [{ prefix: null, items: blocks.map((block, index) => ({ block, index })) }];
  }

  const order: string[] = [];
  const byPrefix = new Map<string, { block: PageBlockRow; index: number }[]>();
  blocks.forEach((block, index) => {
    const dot = block.block_key.indexOf(".");
    const prefix = dot === -1 ? block.block_key : block.block_key.slice(0, dot);
    if (!byPrefix.has(prefix)) {
      byPrefix.set(prefix, []);
      order.push(prefix);
    }
    byPrefix.get(prefix)!.push({ block, index });
  });
  return order.map((prefix) => ({ prefix, items: byPrefix.get(prefix)! }));
}

function blockFieldLabel(block: PageBlockRow, prefix: string | null): string {
  if (prefix === null) return block.block_key;
  return block.block_key.slice(prefix.length + 1) || block.block_key;
}

function PageBlocksSection({
  pageSlug,
  blocks,
  onSaved,
}: {
  pageSlug: string;
  blocks: PageBlockRow[];
  onSaved: (rows: PageBlockRow[]) => void;
}) {
  const blocksFormSchema = useMemo(buildBlocksFormSchema, []);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<BlocksFormShape>({
    resolver: zodResolver(blocksFormSchema),
    defaultValues: {
      blocks: blocks.map((b) => ({ id: b.id, block_key: b.block_key, value: b.value })),
    },
  });

  const groups = groupBlocks(blocks);

  async function onSubmit(values: BlocksFormShape) {
    setSubmitting(true);
    try {
      const { updatePageBlocks } = await import("@/lib/admin/fns/pages");
      const updated = await updatePageBlocks({
        data: { page_slug: pageSlug, blocks: values.blocks },
      });
      onSaved(updated);
      toast.success("已儲存文案區塊");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-4 rounded-md border border-border p-4">
      <div>
        <h2 className="text-lg font-medium">文案區塊</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          共 {blocks.length} 個區塊。這些是畫面上固定的文字插槽，只能編輯內容，無法新增或刪除。
        </p>
      </div>

      {blocks.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          這個頁面沒有文案區塊。
        </p>
      ) : (
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {groups.map((group) => (
              <div key={group.prefix ?? "__flat__"} className="space-y-4">
                {group.prefix !== null ? (
                  <h3 className="text-sm font-semibold text-muted-foreground">{group.prefix}</h3>
                ) : null}
                <div className="space-y-4">
                  {group.items.map(({ block, index }) => (
                    <LocalizedField
                      key={block.id}
                      name={`blocks.${index}.value`}
                      label={blockFieldLabel(block, group.prefix)}
                      multiline
                    />
                  ))}
                </div>
              </div>
            ))}

            <div className="flex justify-end">
              <Button type="submit" disabled={submitting}>
                {submitting ? "儲存中…" : "儲存文案區塊"}
              </Button>
            </div>
          </form>
        </Form>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * section 3 — 清單 (page_list_items 表)
 * ------------------------------------------------------------------ */

function buildListItemFormSchema() {
  return z.object({
    id: z.number().int().optional(),
    page_slug: z.string(),
    list_key: z.string(),
    label: localizedSchema,
    note: optionalLocalizedFormSchema,
    image_key: z.string().nullable(),
    sort_order: z.number().int(),
  });
}
type ListItemFormShape = z.infer<ReturnType<typeof buildListItemFormSchema>>;

type ListItemGroup = { listKey: string; rows: PageListItemRow[] };

/**
 * Groups by list_key — every group present here already exists in the data
 * (list_key itself is never invented by this UI, only the rows within an
 * existing group are addable/removable; see task notes on page_list_items).
 * A page with zero list items renders zero groups.
 */
function groupListItems(items: PageListItemRow[]): ListItemGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, PageListItemRow[]>();
  for (const item of items) {
    if (!byKey.has(item.list_key)) {
      byKey.set(item.list_key, []);
      order.push(item.list_key);
    }
    byKey.get(item.list_key)!.push(item);
  }
  return order.map((listKey) => ({ listKey, rows: byKey.get(listKey)! }));
}

function PageListItemsSection({
  pageSlug,
  initialItems,
}: {
  pageSlug: string;
  initialItems: PageListItemRow[];
}) {
  const [items, setItems] = useState<PageListItemRow[]>(initialItems);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PageListItemRow | null>(null);
  const [activeListKey, setActiveListKey] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PageListItemRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reorderingId, setReorderingId] = useState<number | null>(null);

  const groups = groupListItems(items);

  async function refresh() {
    const { listPageListItems } = await import("@/lib/admin/fns/pages");
    const fresh = await listPageListItems({ data: { page_slug: pageSlug } });
    setItems(fresh);
  }

  function openCreate(listKey: string) {
    setEditing(null);
    setActiveListKey(listKey);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: PageListItemRow) {
    setEditing(row);
    setActiveListKey(row.list_key);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: ListItemFormShape) {
    setSubmitting(true);
    try {
      const payload: PageListItemFormValues = {
        id: values.id,
        page_slug: values.page_slug,
        list_key: values.list_key,
        label: values.label,
        note: emptyToNull(values.note),
        image_key: values.image_key,
        sort_order: values.sort_order,
      };
      const { upsertPageListItem } = await import("@/lib/admin/fns/pages");
      await upsertPageListItem({ data: payload });
      toast.success(editing ? "已更新項目" : "已新增項目");
      setDialogOpen(false);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { removePageListItem } = await import("@/lib/admin/fns/pages");
      await removePageListItem({ data: { id: deleteTarget.id } });
      toast.success("已刪除項目");
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  /**
   * Swaps the row at `index` with its neighbour and sends the WHOLE resulting
   * id order (for this one list_key group) to admin_reorder_page_list_items —
   * never a targeted per-row sort_order update. See
   * src/server/repos/pages.ts#reorderPageListItems for why: page_list_items
   * has UNIQUE(page_slug, list_key, sort_order), and a two-row swap done as
   * separate UPDATEs collides with that constraint mid-flight.
   */
  async function handleMove(
    listKey: string,
    rows: PageListItemRow[],
    index: number,
    direction: -1 | 1,
  ) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= rows.length) return;

    const reordered = [...rows];
    const moved = reordered[index];
    reordered[index] = reordered[targetIndex];
    reordered[targetIndex] = moved;

    setReorderingId(moved.id);
    try {
      const { reorderPageListItems } = await import("@/lib/admin/fns/pages");
      await reorderPageListItems({
        data: { page_slug: pageSlug, list_key: listKey, ids: reordered.map((r) => r.id) },
      });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "排序失敗，請稍後再試");
    } finally {
      setReorderingId(null);
    }
  }

  const activeRows = activeListKey
    ? (groups.find((g) => g.listKey === activeListKey)?.rows ?? [])
    : [];
  const nextSortOrder = activeRows.reduce((max, r) => Math.max(max, r.sort_order), 0) + 1;

  const dialogDefaultValues: ListItemFormShape = editing
    ? {
        id: editing.id,
        page_slug: pageSlug,
        list_key: editing.list_key,
        label: editing.label,
        note: editing.note ?? { ...EMPTY_LOCALIZED },
        image_key: editing.image_key,
        sort_order: editing.sort_order,
      }
    : {
        page_slug: pageSlug,
        list_key: activeListKey ?? "",
        label: { ...EMPTY_LOCALIZED },
        note: { ...EMPTY_LOCALIZED },
        image_key: null,
        sort_order: nextSortOrder,
      };

  return (
    <section className="space-y-4 rounded-md border border-border p-4">
      <div>
        <h2 className="text-lg font-medium">清單</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          共 {items.length} 筆，依清單分組管理，可新增／刪除／排序。
        </p>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          這個頁面沒有清單項目。
        </p>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.listKey} className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-sm font-semibold">{group.listKey}</h3>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => openCreate(group.listKey)}
                >
                  <Plus className="h-4 w-4" />
                  新增
                </Button>
              </div>
              <div className="overflow-x-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">排序</TableHead>
                      <TableHead>內容</TableHead>
                      <TableHead className="w-40 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.rows.map((row, index) => (
                      <TableRow key={row.id}>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              disabled={reorderingId !== null || index === 0}
                              onClick={() => void handleMove(group.listKey, group.rows, index, -1)}
                              aria-label="上移"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              disabled={reorderingId !== null || index === group.rows.length - 1}
                              onClick={() => void handleMove(group.listKey, group.rows, index, 1)}
                              aria-label="下移"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="max-w-md truncate">{row.label.zh}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                              編輯
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => setDeleteTarget(row)}
                            >
                              刪除
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "編輯項目" : "新增項目"}</DialogTitle>
            <DialogDescription>
              {editing
                ? `「${activeListKey}」清單項目。中文、英文、日文皆為必填。`
                : `新增到「${activeListKey}」清單，會排在最後面，請用列表上的上移／下移調整順序。`}
            </DialogDescription>
          </DialogHeader>
          <ListItemForm
            key={formKey}
            defaultValues={dialogDefaultValues}
            onSubmit={handleSubmit}
            submitting={submitting}
            submitLabel={editing ? "儲存變更" : "新增"}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要刪除這個項目嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.label.zh}」刪除後無法復原。
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
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "刪除中…" : "刪除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

type ListItemFormProps = {
  defaultValues: ListItemFormShape;
  onSubmit: (values: ListItemFormShape) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function ListItemForm({ defaultValues, onSubmit, submitting, submitLabel }: ListItemFormProps) {
  const listItemFormSchema = useMemo(buildListItemFormSchema, []);
  const form = useForm<ListItemFormShape>({
    resolver: zodResolver(listItemFormSchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <LocalizedField name="label" label="內容" multiline />
        <LocalizedField name="note" label="備註（選填）" multiline optional />

        <FormField
          control={form.control}
          name="image_key"
          render={({ field }) => (
            <FormItem>
              <FormLabel>圖片（選填）</FormLabel>
              <ImageField value={field.value} onChange={field.onChange} fallback={storefront} />
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
