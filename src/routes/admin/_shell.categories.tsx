import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { eventCategorySchema, type EventCategoryFormValues } from "@/lib/admin/schemas";
import type { listEventCategories } from "@/lib/admin/fns/event-categories";
import { formatUpdatedAt } from "@/lib/admin/format";

type EventCategoryRow = Awaited<ReturnType<typeof listEventCategories>>[number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

/**
 * Pathless-layout child route for /admin/categories. Loads per-category
 * event counts alongside the categories themselves (not just categories) so
 * the table can disable "刪除" up front on any category still referenced by
 * an event — events.category is `on delete restrict`
 * (supabase/migrations/0001_init.sql:182-183), so deleting a category still
 * in use would otherwise fail with a raw Postgres 23503 error.
 */
export const Route = createFileRoute("/admin/_shell/categories")({
  loader: async () => {
    const { listEventCategories } = await import("@/lib/admin/fns/event-categories");
    const { countEventsByCategory } = await import("@/lib/admin/fns/events");
    const [categories, counts] = await Promise.all([
      listEventCategories(),
      countEventsByCategory(),
    ]);
    return { categories, counts };
  },
  head: () => ({
    meta: [{ title: "活動分類｜小時光書店後台" }],
  }),
  component: AdminEventCategoriesPage,
});

function toFormValues(row: EventCategoryRow): EventCategoryFormValues {
  return {
    id: row.id,
    label: row.label,
    sort_order: row.sort_order,
  };
}

function AdminEventCategoriesPage() {
  const { categories, counts } = Route.useLoaderData();
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EventCategoryRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EventCategoryRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: EventCategoryRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: EventCategoryFormValues) {
    setSubmitting(true);
    try {
      const { upsertEventCategory } = await import("@/lib/admin/fns/event-categories");
      // Editing keeps the original id no matter what the (disabled) field
      // holds — see the "id" FormField below for why it is locked on edit.
      await upsertEventCategory({ data: editing ? { ...values, id: editing.id } : values });
      toast.success(editing ? "已更新分類" : "已新增分類");
      setDialogOpen(false);
      await router.invalidate();
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
      const { removeEventCategory } = await import("@/lib/admin/fns/event-categories");
      await removeEventCategory({ data: { id: deleteTarget.id } });
      toast.success("已刪除分類");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  const nextSortOrder = categories.reduce((max, c) => Math.max(max, c.sort_order), 0) + 1;

  const defaultValues: EventCategoryFormValues = editing
    ? toFormValues(editing)
    : {
        id: "",
        label: { ...EMPTY_LOCALIZED },
        sort_order: nextSortOrder,
      };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">活動分類</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {categories.length} 個分類</p>
        </div>
        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新增分類
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>分類代碼</TableHead>
              <TableHead>名稱</TableHead>
              <TableHead className="w-28">使用中活動數</TableHead>
              <TableHead className="w-36">最後更新</TableHead>
              <TableHead className="w-44 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增分類」開始。
                </TableCell>
              </TableRow>
            ) : (
              categories.map((c) => {
                const inUse = counts[c.id] ?? 0;
                return (
                  <TableRow key={c.id}>
                    <TableCell className="text-muted-foreground">{c.sort_order}</TableCell>
                    <TableCell className="max-w-xs truncate font-mono text-sm">{c.id}</TableCell>
                    <TableCell className="max-w-sm truncate font-medium">{c.label.zh}</TableCell>
                    <TableCell>
                      <Badge variant={inUse > 0 ? "outline" : "secondary"}>{inUse} 場</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatUpdatedAt(c.updated_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                            編輯
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={inUse > 0}
                            onClick={() => setDeleteTarget(c)}
                          >
                            刪除
                          </Button>
                        </div>
                        {inUse > 0 && (
                          <p className="text-xs text-muted-foreground">
                            尚有 {inUse} 場活動使用此分類
                          </p>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "編輯分類" : "新增分類"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。
            </DialogDescription>
          </DialogHeader>
          <CategoryForm
            key={formKey}
            defaultValues={defaultValues}
            editing={editing !== null}
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
            <AlertDialogTitle>確定要刪除這個分類嗎？</AlertDialogTitle>
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
    </div>
  );
}

type CategoryFormProps = {
  defaultValues: EventCategoryFormValues;
  /** True when editing an existing row — locks the "id" field (see below). */
  editing: boolean;
  onSubmit: (values: EventCategoryFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function CategoryForm({
  defaultValues,
  editing,
  onSubmit,
  submitting,
  submitLabel,
}: CategoryFormProps) {
  const form = useForm<EventCategoryFormValues>({
    resolver: zodResolver(eventCategorySchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>分類代碼</FormLabel>
              <FormControl>
                <Input placeholder="例如 讀書會" {...field} disabled={editing} />
              </FormControl>
              <FormDescription>
                {editing
                  ? "建立後無法修改代碼，避免影響目前已使用此分類的活動。"
                  : "活動會以這個代碼關聯到本分類（events.category 外鍵），建議直接使用中文名稱，例如「讀書會」；建立後無法修改。"}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <LocalizedField name="label" label="名稱" />

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
