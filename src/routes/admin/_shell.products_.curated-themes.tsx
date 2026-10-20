/**
 * /admin/products/curated-themes —— 選品的「主題」與品項排序。
 *
 * 2026-10-20 前這一頁是 /admin/curated（側欄 › 內容管理 › 選品）。選品一項一項的
 * 上下架與編輯併進後台「商品」單一頁的「選品」分頁之後，只剩兩件事那一頁做不到：
 * 主題本身的增刪改，以及同一主題內品項的上下順序（unique(theme_id, sort_order)，
 * 必須走 admin_reorder_curated_items RPC）。這一頁就是做那兩件事的，從商品頁的
 * 選品分頁點「主題與排序」進來；/admin/curated 舊網址轉去商品頁的選品分頁。
 *
 * 檔名的 `products_` 是 TanStack Router 的「不巢狀」寫法：網址在 /admin/products
 * 底下（側欄的「商品」會亮），但不需要商品頁渲染 <Outlet />，也不會先跑商品頁的
 * loader。
 */
import { useEffect, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { CuratedItemForm } from "@/components/admin/products/CuratedItemForm";
import {
  curatedThemeSchema,
  type CuratedThemeFormValues,
  type CuratedItemFormValues,
} from "@/lib/admin/schemas";
import type { listCuratedThemes, listCuratedItems } from "@/lib/admin/fns/curated";
import { formatUpdatedAt } from "@/lib/admin/format";

type CuratedThemeRow = Awaited<ReturnType<typeof listCuratedThemes>>[number];
type CuratedItemRow = Awaited<ReturnType<typeof listCuratedItems>>[number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

/**
 * Selection lives here (module scope is wrong — it's per-mount state) as a
 * single page, not a sub-route: curated_items only ever makes sense in the
 * context of its parent theme (theme_id is a required FK), so there is no
 * "/admin/curated/items" nav entry — picking a theme row below reveals an
 * items panel for that theme on the same page.
 */
export const Route = createFileRoute("/admin/_shell/products_/curated-themes")({
  loader: async () => {
    const { listCuratedThemes } = await import("@/lib/admin/fns/curated");
    const themes = await listCuratedThemes();
    return { themes };
  },
  head: () => ({
    meta: [{ title: "選品主題｜小時光書店後台" }],
  }),
  component: AdminCuratedPage,
});

function toThemeFormValues(row: CuratedThemeRow): CuratedThemeFormValues {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    is_published: row.is_published,
    sort_order: row.sort_order,
  };
}

function toItemFormValues(row: CuratedItemRow): CuratedItemFormValues {
  return {
    id: row.id,
    theme_id: row.theme_id,
    name: row.name,
    note: row.note,
    is_published: row.is_published,
    sort_order: row.sort_order,
  };
}

function AdminCuratedPage() {
  const { themes } = Route.useLoaderData();
  const router = useRouter();

  // ---- theme dialog / delete state ----
  const [themeDialogOpen, setThemeDialogOpen] = useState(false);
  const [editingTheme, setEditingTheme] = useState<CuratedThemeRow | null>(null);
  const [themeFormKey, setThemeFormKey] = useState(0);
  const [themeSubmitting, setThemeSubmitting] = useState(false);
  const [deleteThemeTarget, setDeleteThemeTarget] = useState<CuratedThemeRow | null>(null);
  const [deletingTheme, setDeletingTheme] = useState(false);

  // ---- selected theme + its items ----
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
  const [items, setItems] = useState<CuratedItemRow[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [reorderingId, setReorderingId] = useState<number | null>(null);

  // ---- item dialog / delete state ----
  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<CuratedItemRow | null>(null);
  const [itemFormKey, setItemFormKey] = useState(0);
  const [itemSubmitting, setItemSubmitting] = useState(false);
  const [deleteItemTarget, setDeleteItemTarget] = useState<CuratedItemRow | null>(null);
  const [deletingItem, setDeletingItem] = useState(false);

  const selectedTheme = themes.find((t) => t.id === selectedThemeId) ?? null;

  async function loadItems(themeId: string) {
    setItemsLoading(true);
    try {
      const { listCuratedItems } = await import("@/lib/admin/fns/curated");
      const rows = await listCuratedItems({ data: { theme_id: themeId } });
      setItems(rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "載入品項失敗，請稍後再試");
    } finally {
      setItemsLoading(false);
    }
  }

  useEffect(() => {
    if (selectedThemeId) {
      void loadItems(selectedThemeId);
    } else {
      setItems([]);
    }
  }, [selectedThemeId]);

  // ---- theme handlers ----
  function openCreateTheme() {
    setEditingTheme(null);
    setThemeFormKey((k) => k + 1);
    setThemeDialogOpen(true);
  }

  function openEditTheme(row: CuratedThemeRow) {
    setEditingTheme(row);
    setThemeFormKey((k) => k + 1);
    setThemeDialogOpen(true);
  }

  async function handleThemeSubmit(values: CuratedThemeFormValues) {
    setThemeSubmitting(true);
    try {
      const { upsertCuratedTheme } = await import("@/lib/admin/fns/curated");
      await upsertCuratedTheme({
        data: editingTheme ? { ...values, id: editingTheme.id } : values,
      });
      toast.success(editingTheme ? "已更新主題" : "已新增主題");
      setThemeDialogOpen(false);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setThemeSubmitting(false);
    }
  }

  async function handleThemeDelete() {
    if (!deleteThemeTarget) return;
    setDeletingTheme(true);
    try {
      const { removeCuratedTheme } = await import("@/lib/admin/fns/curated");
      await removeCuratedTheme({ data: { id: deleteThemeTarget.id } });
      toast.success("已刪除主題（底下品項已一併刪除）");
      if (selectedThemeId === deleteThemeTarget.id) {
        setSelectedThemeId(null);
      }
      setDeleteThemeTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeletingTheme(false);
    }
  }

  // ---- item handlers ----
  function openCreateItem() {
    setEditingItem(null);
    setItemFormKey((k) => k + 1);
    setItemDialogOpen(true);
  }

  function openEditItem(row: CuratedItemRow) {
    setEditingItem(row);
    setItemFormKey((k) => k + 1);
    setItemDialogOpen(true);
  }

  async function handleItemSubmit(values: CuratedItemFormValues) {
    if (!selectedThemeId) return;
    setItemSubmitting(true);
    try {
      const { upsertCuratedItem } = await import("@/lib/admin/fns/curated");
      await upsertCuratedItem({
        data: editingItem
          ? {
              ...values,
              id: editingItem.id,
              theme_id: selectedThemeId,
              sort_order: editingItem.sort_order,
            }
          : { ...values, theme_id: selectedThemeId, sort_order: nextItemSortOrder },
      });
      toast.success(editingItem ? "已更新品項" : "已新增品項");
      setItemDialogOpen(false);
      await loadItems(selectedThemeId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setItemSubmitting(false);
    }
  }

  async function handleItemDelete() {
    if (!deleteItemTarget || !selectedThemeId) return;
    setDeletingItem(true);
    try {
      const { removeCuratedItem } = await import("@/lib/admin/fns/curated");
      await removeCuratedItem({ data: { id: deleteItemTarget.id } });
      toast.success("已刪除品項");
      setDeleteItemTarget(null);
      await loadItems(selectedThemeId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeletingItem(false);
    }
  }

  /**
   * Swaps the item at `index` with its neighbour and sends the WHOLE
   * resulting id order to admin_reorder_curated_items — never a targeted
   * per-row sort_order update (see src/server/repos/curated.ts#reorderCuratedItems
   * for why: curated_items has UNIQUE(theme_id, sort_order), and a two-row
   * swap done as separate UPDATEs collides with that constraint mid-flight).
   */
  async function handleMove(index: number, direction: -1 | 1) {
    if (!selectedThemeId) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= items.length) return;

    const reordered = [...items];
    const moved = reordered[index];
    reordered[index] = reordered[targetIndex];
    reordered[targetIndex] = moved;

    setReorderingId(moved.id);
    try {
      const { reorderCuratedItems } = await import("@/lib/admin/fns/curated");
      await reorderCuratedItems({
        data: { theme_id: selectedThemeId, ids: reordered.map((row) => row.id) },
      });
      await loadItems(selectedThemeId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "排序失敗，請稍後再試");
    } finally {
      setReorderingId(null);
    }
  }

  const nextThemeSortOrder = themes.reduce((max, t) => Math.max(max, t.sort_order), 0) + 1;
  const nextItemSortOrder = items.reduce((max, i) => Math.max(max, i.sort_order), 0) + 1;

  const themeDefaultValues: CuratedThemeFormValues = editingTheme
    ? toThemeFormValues(editingTheme)
    : {
        title: { ...EMPTY_LOCALIZED },
        description: { ...EMPTY_LOCALIZED },
        is_published: true,
        sort_order: nextThemeSortOrder,
      };

  const itemDefaultValues: CuratedItemFormValues = editingItem
    ? toItemFormValues(editingItem)
    : {
        theme_id: selectedThemeId ?? "",
        name: { ...EMPTY_LOCALIZED },
        note: { ...EMPTY_LOCALIZED },
        is_published: true,
        sort_order: nextItemSortOrder,
      };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link
            to="/admin/products"
            search={{ type: "curated" }}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← 回到商品・選品
          </Link>
          <h1 className="text-2xl font-medium">選品主題與排序</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {themes.length} 個主題。點「管理品項」展開下方面板，編輯該主題底下的品項。
          </p>
        </div>
        <Button onClick={openCreateTheme} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新增主題
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>主題名稱</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="w-36">最後更新</TableHead>
              <TableHead className="w-64 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {themes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增主題」開始。
                </TableCell>
              </TableRow>
            ) : (
              themes.map((t) => (
                <TableRow
                  key={t.id}
                  className={selectedThemeId === t.id ? "bg-muted/50" : undefined}
                >
                  <TableCell className="text-muted-foreground">{t.sort_order}</TableCell>
                  <TableCell className="max-w-sm truncate font-medium">{t.title.zh}</TableCell>
                  <TableCell>
                    <Badge variant={t.is_published ? "default" : "secondary"}>
                      {t.is_published ? "已發布" : "草稿"}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatUpdatedAt(t.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant={selectedThemeId === t.id ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => setSelectedThemeId(t.id)}
                      >
                        管理品項
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEditTheme(t)}>
                        編輯
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteThemeTarget(t)}
                      >
                        刪除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {selectedTheme ? (
        <div className="space-y-4 rounded-md border border-border p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium">「{selectedTheme.title.zh}」的品項</h2>
              <p className="mt-1 text-sm text-muted-foreground">共 {items.length} 項</p>
            </div>
            <Button onClick={openCreateItem} size="sm" className="gap-1.5">
              <Plus className="h-4 w-4" />
              新增品項
            </Button>
          </div>

          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">排序</TableHead>
                  <TableHead>品項名稱</TableHead>
                  <TableHead className="w-24">狀態</TableHead>
                  <TableHead className="w-36">最後更新</TableHead>
                  <TableHead className="w-40 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {itemsLoading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      載入中…
                    </TableCell>
                  </TableRow>
                ) : items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      這個主題底下尚無品項，點右上角「新增品項」開始。
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((item, index) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            disabled={reorderingId !== null || index === 0}
                            onClick={() => void handleMove(index, -1)}
                            aria-label="上移"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            disabled={reorderingId !== null || index === items.length - 1}
                            onClick={() => void handleMove(index, 1)}
                            aria-label="下移"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="max-w-sm truncate font-medium">
                        {item.name.zh}
                      </TableCell>
                      <TableCell>
                        <Badge variant={item.is_published ? "default" : "secondary"}>
                          {item.is_published ? "已發布" : "草稿"}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatUpdatedAt(item.updated_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => openEditItem(item)}>
                            編輯
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleteItemTarget(item)}
                          >
                            刪除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          點選上方主題列的「管理品項」，以編輯該主題底下的品項。
        </p>
      )}

      {/* Theme create/edit dialog */}
      <Dialog open={themeDialogOpen} onOpenChange={setThemeDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingTheme ? "編輯主題" : "新增主題"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。
            </DialogDescription>
          </DialogHeader>
          <ThemeForm
            key={themeFormKey}
            defaultValues={themeDefaultValues}
            onSubmit={handleThemeSubmit}
            submitting={themeSubmitting}
            submitLabel={editingTheme ? "儲存變更" : "新增"}
          />
        </DialogContent>
      </Dialog>

      {/* Item create/edit dialog */}
      <Dialog open={itemDialogOpen} onOpenChange={setItemDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingItem ? "編輯品項" : "新增品項"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。新增的品項會排在這個主題的最後面，順序請用列表上的上移／下移調整。
            </DialogDescription>
          </DialogHeader>
          <CuratedItemForm
            key={itemFormKey}
            defaultValues={itemDefaultValues}
            onSubmit={handleItemSubmit}
            submitting={itemSubmitting}
            submitLabel={editingItem ? "儲存變更" : "新增"}
          />
        </DialogContent>
      </Dialog>

      {/* Delete theme confirmation */}
      <AlertDialog
        open={deleteThemeTarget !== null}
        onOpenChange={(open) => !open && setDeleteThemeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要刪除這個主題嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteThemeTarget?.title.zh}」刪除後無法復原，底下所有品項也會一併刪除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingTheme}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingTheme}
              onClick={(e) => {
                e.preventDefault();
                void handleThemeDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingTheme ? "刪除中…" : "刪除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete item confirmation */}
      <AlertDialog
        open={deleteItemTarget !== null}
        onOpenChange={(open) => !open && setDeleteItemTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要刪除這個品項嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteItemTarget?.name.zh}」刪除後無法復原。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingItem}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingItem}
              onClick={(e) => {
                e.preventDefault();
                void handleItemDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingItem ? "刪除中…" : "刪除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type ThemeFormProps = {
  defaultValues: CuratedThemeFormValues;
  onSubmit: (values: CuratedThemeFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function ThemeForm({ defaultValues, onSubmit, submitting, submitLabel }: ThemeFormProps) {
  const form = useForm<CuratedThemeFormValues>({
    resolver: zodResolver(curatedThemeSchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <LocalizedField name="title" label="主題名稱" />
        <LocalizedField name="description" label="說明" multiline />

        <div className="grid grid-cols-2 gap-4">
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
        </div>

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "儲存中…" : submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
