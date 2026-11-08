import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus, ShieldAlert } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CREATABLE_BACKOFFICE_ROLES,
  createStaffAccountSchema,
  type CreateStaffAccountValues,
} from "@/lib/admin/schemas";
import type { listStaffAccounts } from "@/lib/admin/fns/staff-accounts";
import { formatUpdatedAt } from "@/lib/admin/format";
import { rememberAdminPeek } from "@/lib/admin/list-memory";
import { ROLE_DESCRIPTION, ROLE_LABEL, type CreatableRole } from "@/lib/admin/staff-roles";

type StaffAccountRow = Awaited<ReturnType<typeof listStaffAccounts>>[number];

/**
 * 這一頁只有 admin 能進——但守門的不是這裡，是 fns/staff-accounts.ts 每一支都
 * 掛的 adminFnMiddleware（見該檔檔頭）。這裡不做角色判斷是這個 admin shell的
 * 既有慣例（見 src/routes/admin/_shell.tsx 的檔頭說明）：店員硬打
 * /admin/staff 會在這個 loader 呼叫 listStaffAccounts() 時被 adminFnMiddleware
 * 擋下來，看到一頁錯誤，而不是資料——跟這個後台其餘每一個 admin 專用頁面
 * （/admin/settings、/admin/strings……）行為一致。側欄用 `staff: false`
 * （見 _shell.tsx 的 NAV_GROUPS）讓店員連連結都看不到，但那只是畫面。
 *
 * 2026-10-26 起「編輯」不再是彈窗（後台第 3 批；業主：「不要用彈窗，直接顯示內頁＆回到上一頁」）：
 * 連到 /admin/staff/$id（StaffAccountForm）。「新增後台帳號」仍是對話框——三個欄位、
 * 含一組要當面交給對方的初始密碼，屬於快速動作；「移除」確認仍是 AlertDialog。
 */
export const Route = createFileRoute("/admin/_shell/staff")({
  loader: async () => {
    const { listStaffAccounts } = await import("@/lib/admin/fns/staff-accounts");
    const accounts = await listStaffAccounts();
    return { accounts };
  },
  head: () => ({ meta: [{ title: "後台人員｜小時光書店後台" }] }),
  component: AdminStaffPage,
});

function AdminStaffPage() {
  const { accounts } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const router = useRouter();

  const [createOpen, setCreateOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<StaffAccountRow | null>(null);
  const [removing, setRemoving] = useState(false);

  const adminCount = accounts.filter((a) => a.role === "admin").length;

  async function handleRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      const { removeStaffAccess } = await import("@/lib/admin/fns/staff-accounts");
      await removeStaffAccess({ data: { userId: removeTarget.id } });
      toast.success(`已移除 ${removeTarget.email ?? removeTarget.id} 的後台身分`);
      setRemoveTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "移除失敗，請稍後再試");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">後台人員</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {accounts.length} 個後台身分（管理員／門市人員／待審核）。管理員能在這裡新增帳號、
            調整角色與細權限，不必再進 Supabase Dashboard。
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新增後台帳號
        </Button>
      </div>

      {adminCount <= 1 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>
            目前只有一位管理員。系統不允許移除或降級最後一位管理員（資料庫層會擋下來），
            但建議至少指定兩位，避免那個人請假時沒有人能開帳號、改權限。
          </p>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>電子郵件</TableHead>
              <TableHead className="w-28">角色</TableHead>
              <TableHead className="w-48">細權限</TableHead>
              <TableHead className="w-36">建立時間</TableHead>
              <TableHead className="w-44 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  尚無資料。
                </TableCell>
              </TableRow>
            ) : (
              accounts.map((row) => {
                const isSelf = row.id === user.userId;
                const busy = removing && removeTarget?.id === row.id;
                return (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-xs truncate font-medium">
                      {row.email ?? "（沒有信箱）"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.role === "pending" ? "outline" : "secondary"}>
                        {ROLE_LABEL[row.role as CreatableRole] ?? row.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.role === "admin"
                        ? "全部（管理員一律全有）"
                        : row.role === "staff"
                          ? row.permissions.length > 0
                            ? `${row.permissions.length} 項`
                            : "尚未指派"
                          : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatUpdatedAt(row.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      {isSelf ? (
                        <span className="text-xs text-muted-foreground">（這是你自己的帳號）</span>
                      ) : (
                        <div className="flex justify-end gap-2">
                          <Button asChild variant="ghost" size="sm">
                            <Link
                              to="/admin/staff/$id"
                              params={{ id: row.id }}
                              preload="intent"
                              disabled={busy}
                              onClick={() => rememberAdminPeek("staff", row.id, row)}
                            >
                              編輯
                            </Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={busy}
                            onClick={() => setRemoveTarget(row)}
                          >
                            移除
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <CreateAccountDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => router.invalidate()}
      />

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要移除這個人的後台身分嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{removeTarget?.email ?? removeTarget?.id}
              」之後將無法登入後台（角色會改回一般客人）。
              帳號本身不會被刪除，之後仍可以重新指派為門市人員或管理員。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={(e) => {
                e.preventDefault();
                void handleRemove();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? "移除中…" : "移除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新增帳號
// ---------------------------------------------------------------------------

function CreateAccountDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<CreateStaffAccountValues>({
    resolver: zodResolver(createStaffAccountSchema),
    defaultValues: { email: "", password: "", role: "staff" },
  });

  async function handleSubmit(values: CreateStaffAccountValues) {
    setSubmitting(true);
    try {
      const { createStaffAccount } = await import("@/lib/admin/fns/staff-accounts");
      await createStaffAccount({ data: values });
      toast.success(`已建立 ${values.email}，請把密碼交給對方——這一頁不會寄邀請信`);
      form.reset({ email: "", password: "", role: "staff" });
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "建立失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset({ email: "", password: "", role: "staff" });
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新增後台帳號</DialogTitle>
          <DialogDescription>
            建立一個全新的帳號並設定初始密碼。密碼請當面或用電話告知對方——這一頁沒有寄邀請信的功能。
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>電子郵件</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>初始密碼</FormLabel>
                  <FormControl>
                    <Input type="text" autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>
                    至少 8 個字元。建立後請直接讀給對方或用電話告知。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>角色</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="h-auto min-h-9 min-w-0 whitespace-normal text-left [&>span]:line-clamp-none [&>span]:break-words">
                        <SelectValue placeholder="請選擇角色" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="max-w-[var(--radix-select-trigger-width)]">
                      {CREATABLE_BACKOFFICE_ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {ROLE_LABEL[role]}——{ROLE_DESCRIPTION[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={submitting}>
                {submitting ? "建立中…" : "建立帳號"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
