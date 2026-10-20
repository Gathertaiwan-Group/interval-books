import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { newsSchema, type NewsFormValues } from "@/lib/admin/schemas";
import type { listNews } from "@/lib/admin/fns/news";
import { formatUpdatedAt } from "@/lib/admin/format";
import { newFirstSortOrder } from "@/lib/admin/sort-order";
import { AdvancedSection } from "@/components/admin/AdvancedSection";

type NewsRow = Awaited<ReturnType<typeof listNews>>[number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

export const Route = createFileRoute("/admin/_shell/news")({
  loader: async () => {
    const { listNews } = await import("@/lib/admin/fns/news");
    const news = await listNews();
    return { news };
  },
  head: () => ({
    meta: [{ title: "最新消息｜小時光書店後台" }],
  }),
  component: AdminNewsPage,
});

function toFormValues(row: NewsRow): NewsFormValues {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    description: row.description,
    display_date: row.display_date,
    is_published: row.is_published,
    sort_order: row.sort_order,
  };
}

function AdminNewsPage() {
  const { news } = Route.useLoaderData();
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<NewsRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NewsRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: NewsRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: NewsFormValues) {
    setSubmitting(true);
    try {
      const { upsertNews } = await import("@/lib/admin/fns/news");
      await upsertNews({ data: editing ? { ...values, id: editing.id } : values });
      toast.success(editing ? "已更新消息" : "已新增消息");
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
      const { removeNews } = await import("@/lib/admin/fns/news");
      await removeNews({ data: { id: deleteTarget.id } });
      toast.success("已刪除消息");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  // 新的一則排最前面（前台由小到大排）。見 lib/admin/sort-order.ts。
  const nextSortOrder = newFirstSortOrder(news);

  const defaultValues: NewsFormValues = editing
    ? toFormValues(editing)
    : {
        title: { ...EMPTY_LOCALIZED },
        summary: { ...EMPTY_LOCALIZED },
        description: { ...EMPTY_LOCALIZED },
        display_date: "",
        is_published: true,
        sort_order: nextSortOrder,
      };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">最新消息</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {news.length} 則</p>
        </div>
        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新增消息
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>標題</TableHead>
              <TableHead>顯示日期</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="w-36">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {news.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增消息」開始。
                </TableCell>
              </TableRow>
            ) : (
              news.map((n) => (
                <TableRow key={n.id}>
                  <TableCell className="text-muted-foreground">{n.sort_order}</TableCell>
                  <TableCell className="max-w-sm truncate font-medium">{n.title.zh}</TableCell>
                  <TableCell className="text-muted-foreground">{n.display_date}</TableCell>
                  <TableCell>
                    <Badge variant={n.is_published ? "default" : "secondary"}>
                      {n.is_published ? "已發布" : "草稿"}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatUpdatedAt(n.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(n)}>
                        編輯
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(n)}
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "編輯消息" : "新增消息"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。
            </DialogDescription>
          </DialogHeader>
          <NewsForm
            key={formKey}
            defaultValues={defaultValues}
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
            <AlertDialogTitle>確定要刪除這則消息嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.title.zh}」刪除後無法復原。
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

type NewsFormProps = {
  defaultValues: NewsFormValues;
  onSubmit: (values: NewsFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function NewsForm({ defaultValues, onSubmit, submitting, submitLabel }: NewsFormProps) {
  const form = useForm<NewsFormValues>({
    resolver: zodResolver(newsSchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <LocalizedField name="title" label="標題" />
        <LocalizedField name="summary" label="摘要" multiline />
        <LocalizedField name="description" label="說明" multiline />

        <FormField
          control={form.control}
          name="display_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>顯示用日期文字</FormLabel>
              <FormControl>
                <Input placeholder="例如 2026.05.22–05.24" {...field} />
              </FormControl>
              <FormDescription>自由文字，不會被當成日期解析，直接顯示在網站上。</FormDescription>
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

        <AdvancedSection
          hint="排序（通常不用改，新的一則會自動排在最前面）"
          forceOpen={Boolean(form.formState.errors.sort_order)}
        >
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
        </AdvancedSection>

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "儲存中…" : submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
