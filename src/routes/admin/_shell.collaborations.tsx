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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { collaborationSchema, type CollaborationFormValues } from "@/lib/admin/schemas";
import type { listCollaborations } from "@/lib/admin/fns/collaborations";
import { formatUpdatedAt } from "@/lib/admin/format";
import { newFirstSortOrder } from "@/lib/admin/sort-order";

type CollaborationRow = Awaited<ReturnType<typeof listCollaborations>>[number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

export const Route = createFileRoute("/admin/_shell/collaborations")({
  loader: async () => {
    const { listCollaborations } = await import("@/lib/admin/fns/collaborations");
    const collaborations = await listCollaborations();
    return { collaborations };
  },
  head: () => ({
    meta: [{ title: "合作｜小時光書店後台" }],
  }),
  component: AdminCollaborationsPage,
});

function toFormValues(row: CollaborationRow): CollaborationFormValues {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    is_published: row.is_published,
    sort_order: row.sort_order,
  };
}

function AdminCollaborationsPage() {
  const { collaborations } = Route.useLoaderData();
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CollaborationRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CollaborationRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: CollaborationRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: CollaborationFormValues) {
    setSubmitting(true);
    try {
      const { upsertCollaboration } = await import("@/lib/admin/fns/collaborations");
      await upsertCollaboration({ data: editing ? { ...values, id: editing.id } : values });
      toast.success(editing ? "已更新合作夥伴" : "已新增合作夥伴");
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
      const { removeCollaboration } = await import("@/lib/admin/fns/collaborations");
      await removeCollaboration({ data: { id: deleteTarget.id } });
      toast.success("已刪除合作夥伴");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  // 新的合作案例排最前面（前台 /curation 由小到大排）。見 lib/admin/sort-order.ts。
  const nextSortOrder = newFirstSortOrder(collaborations);

  const defaultValues: CollaborationFormValues = editing
    ? toFormValues(editing)
    : {
        title: { ...EMPTY_LOCALIZED },
        description: { ...EMPTY_LOCALIZED },
        is_published: true,
        sort_order: nextSortOrder,
      };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">合作</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {collaborations.length} 個合作夥伴
          </p>
        </div>
        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新增合作
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>名稱</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="w-36">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collaborations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增合作」開始。
                </TableCell>
              </TableRow>
            ) : (
              collaborations.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="text-muted-foreground">{c.sort_order}</TableCell>
                  <TableCell className="max-w-sm truncate font-medium">{c.title.zh}</TableCell>
                  <TableCell>
                    <Badge variant={c.is_published ? "default" : "secondary"}>
                      {c.is_published ? "已發布" : "草稿"}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatUpdatedAt(c.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                        編輯
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(c)}
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
            <DialogTitle>{editing ? "編輯合作" : "新增合作"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。
            </DialogDescription>
          </DialogHeader>
          <CollaborationForm
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
            <AlertDialogTitle>確定要刪除這個合作夥伴嗎？</AlertDialogTitle>
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

type CollaborationFormProps = {
  defaultValues: CollaborationFormValues;
  onSubmit: (values: CollaborationFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function CollaborationForm({
  defaultValues,
  onSubmit,
  submitting,
  submitLabel,
}: CollaborationFormProps) {
  const form = useForm<CollaborationFormValues>({
    resolver: zodResolver(collaborationSchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <LocalizedField name="title" label="名稱" />
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
