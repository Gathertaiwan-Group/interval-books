import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
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
import { journeySchema, type JourneyFormValues } from "@/lib/admin/schemas";
import type { listJourneys } from "@/lib/admin/fns/journeys";
import { formatUpdatedAt } from "@/lib/admin/format";

type JourneyRow = Awaited<ReturnType<typeof listJourneys>>[number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

const REGISTRATION_TYPE_LABEL: Record<JourneyRow["registration_type"], string> = {
  external: "外部連結",
  internal: "內部報名",
};

export const Route = createFileRoute("/admin/_shell/journeys")({
  loader: async () => {
    const { listJourneys } = await import("@/lib/admin/fns/journeys");
    const journeys = await listJourneys();
    return { journeys };
  },
  head: () => ({
    meta: [{ title: "策旅｜小時光書店後台" }],
  }),
  component: AdminJourneysPage,
});

function toFormValues(row: JourneyRow): JourneyFormValues {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    description: row.description,
    days: row.days,
    theme: row.theme,
    external_url: row.external_url,
    registration_type: row.registration_type,
    payment_enabled: row.payment_enabled,
    is_published: row.is_published,
    sort_order: row.sort_order,
  };
}

function AdminJourneysPage() {
  const { journeys } = Route.useLoaderData();
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<JourneyRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<JourneyRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openEdit(row: JourneyRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: JourneyFormValues) {
    setSubmitting(true);
    try {
      const { upsertJourney } = await import("@/lib/admin/fns/journeys");
      await upsertJourney({ data: editing ? { ...values, id: editing.id } : values });
      toast.success(editing ? "已更新策旅" : "已新增策旅");
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
      const { removeJourney } = await import("@/lib/admin/fns/journeys");
      await removeJourney({ data: { id: deleteTarget.id } });
      toast.success("已刪除策旅");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  const nextSortOrder = journeys.reduce((max, j) => Math.max(max, j.sort_order), 0) + 1;

  const defaultValues: JourneyFormValues = editing
    ? toFormValues(editing)
    : {
        title: { ...EMPTY_LOCALIZED },
        summary: { ...EMPTY_LOCALIZED },
        description: { ...EMPTY_LOCALIZED },
        days: { ...EMPTY_LOCALIZED },
        theme: { ...EMPTY_LOCALIZED },
        external_url: "",
        registration_type: "external",
        payment_enabled: false,
        is_published: true,
        sort_order: nextSortOrder,
      };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">策旅</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {journeys.length} 檔</p>
        </div>
        {/* 新增走「一頁新增策旅」（_shell.journeys_.new.tsx）：卡片＋報名頁＋梯次＋票種一次建好。
            下面的 Dialog 仍然負責「編輯」既有卡片的文字。 */}
        <Button asChild className="gap-1.5">
          <Link to="/admin/journeys/new">
            <Plus className="h-4 w-4" />
            新增策旅
          </Link>
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>標題</TableHead>
              <TableHead>天數</TableHead>
              <TableHead>報名方式</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="w-36">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {journeys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增策旅」開始。
                </TableCell>
              </TableRow>
            ) : (
              journeys.map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="text-muted-foreground">{j.sort_order}</TableCell>
                  <TableCell className="max-w-sm truncate font-medium">{j.title.zh}</TableCell>
                  <TableCell className="text-muted-foreground">{j.days.zh}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {REGISTRATION_TYPE_LABEL[j.registration_type]}
                    {j.payment_enabled ? "・線上付款" : ""}
                  </TableCell>
                  <TableCell>
                    <Badge variant={j.is_published ? "default" : "secondary"}>
                      {j.is_published ? "已發布" : "草稿"}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatUpdatedAt(j.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(j)}>
                        編輯
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(j)}
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
            <DialogTitle>{editing ? "編輯策旅" : "新增策旅"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。
            </DialogDescription>
          </DialogHeader>
          <JourneyForm
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
            <AlertDialogTitle>確定要刪除這檔策旅嗎？</AlertDialogTitle>
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

type JourneyFormProps = {
  defaultValues: JourneyFormValues;
  onSubmit: (values: JourneyFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function JourneyForm({ defaultValues, onSubmit, submitting, submitLabel }: JourneyFormProps) {
  const form = useForm<JourneyFormValues>({
    resolver: zodResolver(journeySchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <LocalizedField name="title" label="標題" />
        <LocalizedField name="summary" label="摘要" multiline />
        <LocalizedField name="description" label="說明" multiline />
        <LocalizedField name="days" label="天數" />
        <LocalizedField name="theme" label="主題關鍵字" />

        <FormField
          control={form.control}
          name="external_url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>報名網址</FormLabel>
              <FormControl>
                <Input placeholder="https:// 或 /events/…" {...field} />
              </FormControl>
              <FormDescription>
                外部策旅填完整網址（含 https://）；站內報名的策旅填站內路徑，例如
                /events/InntervalChishang.1023。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="registration_type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>報名方式</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="請選擇報名方式" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="external">外部連結</SelectItem>
                    <SelectItem value="internal">內部報名</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="payment_enabled"
            render={({ field }) => (
              <FormItem>
                <FormLabel>線上付款</FormLabel>
                <div className="flex h-9 items-center gap-2">
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <span className="text-sm text-muted-foreground">
                    {field.value ? "已啟用" : "未啟用"}
                  </span>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

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
