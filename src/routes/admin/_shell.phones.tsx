import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { contactPhoneSchema, type ContactPhoneFormValues } from "@/lib/admin/schemas";
import type { listContactPhones } from "@/lib/admin/fns/contact-phones";
import { formatUpdatedAt } from "@/lib/admin/format";

type ContactPhoneRow = Awaited<ReturnType<typeof listContactPhones>>[number];

export const Route = createFileRoute("/admin/_shell/phones")({
  loader: async () => {
    const { listContactPhones } = await import("@/lib/admin/fns/contact-phones");
    const phones = await listContactPhones();
    return { phones };
  },
  head: () => ({
    meta: [{ title: "聯絡電話｜小時光書店後台" }],
  }),
  component: AdminPhonesPage,
});

function toFormValues(row: ContactPhoneRow): ContactPhoneFormValues {
  return {
    id: row.id,
    label: row.label,
    display_text: row.display_text,
    tel: row.tel,
    sort_order: row.sort_order,
  };
}

function AdminPhonesPage() {
  const { phones } = Route.useLoaderData();
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ContactPhoneRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ContactPhoneRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: ContactPhoneRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: ContactPhoneFormValues) {
    setSubmitting(true);
    try {
      const { upsertContactPhone } = await import("@/lib/admin/fns/contact-phones");
      await upsertContactPhone({ data: editing ? { ...values, id: editing.id } : values });
      toast.success(editing ? "已更新電話" : "已新增電話");
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
      const { removeContactPhone } = await import("@/lib/admin/fns/contact-phones");
      await removeContactPhone({ data: { id: deleteTarget.id } });
      toast.success("已刪除電話");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  const nextSortOrder = phones.reduce((max, p) => Math.max(max, p.sort_order), 0) + 1;

  const defaultValues: ContactPhoneFormValues = editing
    ? toFormValues(editing)
    : {
        label: "",
        display_text: "",
        tel: "",
        sort_order: nextSortOrder,
      };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">聯絡電話</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {phones.length} 筆</p>
        </div>
        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新增電話
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>標籤</TableHead>
              <TableHead>顯示文字</TableHead>
              <TableHead>撥號用號碼</TableHead>
              <TableHead className="w-36">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {phones.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增電話」開始。
                </TableCell>
              </TableRow>
            ) : (
              phones.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-muted-foreground">{p.sort_order}</TableCell>
                  <TableCell className="font-medium">{p.label}</TableCell>
                  <TableCell>{p.display_text}</TableCell>
                  <TableCell className="text-muted-foreground">{p.tel}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatUpdatedAt(p.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                        編輯
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(p)}
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
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "編輯電話" : "新增電話"}</DialogTitle>
            <DialogDescription>純文字欄位，不需要多語系翻譯。</DialogDescription>
          </DialogHeader>
          <PhoneForm
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
            <AlertDialogTitle>確定要刪除這筆電話嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.label}」刪除後無法復原。
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

type PhoneFormProps = {
  defaultValues: ContactPhoneFormValues;
  onSubmit: (values: ContactPhoneFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function PhoneForm({ defaultValues, onSubmit, submitting, submitLabel }: PhoneFormProps) {
  const form = useForm<ContactPhoneFormValues>({
    resolver: zodResolver(contactPhoneSchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="label"
          render={({ field }) => (
            <FormItem>
              <FormLabel>標籤</FormLabel>
              <FormControl>
                <Input placeholder="例如 Tel、Mobile" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="display_text"
          render={({ field }) => (
            <FormItem>
              <FormLabel>顯示文字</FormLabel>
              <FormControl>
                <Input placeholder="例如 +886 2 2341 6800" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="tel"
          render={({ field }) => (
            <FormItem>
              <FormLabel>撥號用號碼</FormLabel>
              <FormControl>
                <Input placeholder="例如 +886223416800" {...field} />
              </FormControl>
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
