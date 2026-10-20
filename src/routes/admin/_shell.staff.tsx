import { useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Plus, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
  STAFF_PERMISSIONS,
  createStaffAccountSchema,
  type CreateStaffAccountValues,
} from "@/lib/admin/schemas";
import type { listStaffAccounts } from "@/lib/admin/fns/staff-accounts";
import { formatUpdatedAt } from "@/lib/admin/format";
import { HIDDEN_PERMISSIONS, PERMISSION_LABELS } from "@/lib/admin/permission-labels";

type StaffAccountRow = Awaited<ReturnType<typeof listStaffAccounts>>[number];
type CreatableRole = (typeof CREATABLE_BACKOFFICE_ROLES)[number];

/**
 * 這一頁只有 admin 能進——但守門的不是這裡，是 fns/staff-accounts.ts 每一支都
 * 掛的 adminFnMiddleware（見該檔檔頭）。這裡不做角色判斷是這個 admin shell的
 * 既有慣例（見 src/routes/admin/_shell.tsx 的檔頭說明）：店員硬打
 * /admin/staff 會在這個 loader 呼叫 listStaffAccounts() 時被 adminFnMiddleware
 * 擋下來，看到一頁錯誤，而不是資料——跟這個後台其餘每一個 admin 專用頁面
 * （/admin/settings、/admin/strings……）行為一致。側欄用 `staff: false`
 * （見 _shell.tsx 的 NAV_GROUPS）讓店員連連結都看不到，但那只是畫面。
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

const ROLE_LABEL: Record<CreatableRole, string> = {
  admin: "管理員",
  staff: "門市人員",
  pending: "待審核",
};

const ROLE_DESCRIPTION: Record<CreatableRole, string> = {
  admin: "能進所有模組、能管理後台人員",
  staff: "能進「門市」與勾選的細權限對應模組，看不到這一頁",
  pending: "已登入但尚未開通任何模組，看到的是待開通說明頁",
};

// 九個細權限的中文名稱搬到 src/lib/admin/permission-labels.ts，與各頁「需要店長開通
// 『○○』權限」的提示共用。approve_inventory_adjustments 在那裡標成 HIDDEN_PERMISSIONS：
// 沒有任何程式在檢查它，所以這一頁不再列出來（帳號身上既有的值照樣保留，不會被清掉）。
const VISIBLE_PERMISSIONS = STAFF_PERMISSIONS.filter((p) => !HIDDEN_PERMISSIONS.has(p));

function AdminStaffPage() {
  const { accounts } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const router = useRouter();

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<StaffAccountRow | null>(null);
  const [editFormKey, setEditFormKey] = useState(0);
  const [removeTarget, setRemoveTarget] = useState<StaffAccountRow | null>(null);
  const [removing, setRemoving] = useState(false);

  const adminCount = accounts.filter((a) => a.role === "admin").length;

  function openEdit(row: StaffAccountRow) {
    setEditing(row);
    setEditFormKey((k) => k + 1);
  }

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
                          <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                            編輯
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
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

      <EditAccountDialog
        key={editFormKey}
        account={editing}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void router.invalidate();
        }}
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
                      <SelectTrigger>
                        <SelectValue placeholder="請選擇角色" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
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

// ---------------------------------------------------------------------------
// 編輯：改角色＋（角色是 staff 時）細權限
// ---------------------------------------------------------------------------
// 兩件事包在同一個對話框、同一次送出，是為了操作方便——底層仍是兩支獨立的
// server fn（updateStaffRole／setStaffPermissions），不是一支揉在一起的函式。
// 角色不是 staff 時完全不呼叫 setStaffPermissions：既有的 staff_permissions
// 列原樣保留，不會被清空——見 src/server/repos/staff-accounts.ts 的說明。

function buildEditAccountFormSchema() {
  return z.object({
    role: z.enum(CREATABLE_BACKOFFICE_ROLES, { errorMap: () => ({ message: "請選擇角色" }) }),
    permissions: z.array(z.enum(STAFF_PERMISSIONS)),
  });
}

type EditAccountFormValues = z.infer<ReturnType<typeof buildEditAccountFormSchema>>;

function EditAccountDialog({
  account,
  onOpenChange,
  onSaved,
}: {
  account: StaffAccountRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const editAccountFormSchema = useMemo(buildEditAccountFormSchema, []);
  const [submitting, setSubmitting] = useState(false);
  const form = useForm<EditAccountFormValues>({
    resolver: zodResolver(editAccountFormSchema),
    defaultValues: {
      role: (account?.role as CreatableRole) ?? "staff",
      permissions: account?.permissions ?? [],
    },
  });

  const selectedRole = form.watch("role");

  async function handleSubmit(values: EditAccountFormValues) {
    if (!account) return;
    setSubmitting(true);
    try {
      const { updateStaffRole, setStaffPermissions } =
        await import("@/lib/admin/fns/staff-accounts");
      if (values.role !== account.role) {
        await updateStaffRole({ data: { userId: account.id, role: values.role } });
      }
      if (values.role === "staff") {
        await setStaffPermissions({
          data: { userId: account.id, permissions: values.permissions },
        });
      }
      toast.success(`已更新 ${account.email ?? account.id}`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={account !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>編輯後台身分</DialogTitle>
          <DialogDescription>{account?.email ?? account?.id}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>角色</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="請選擇角色" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
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

            {selectedRole === "staff" && (
              <FormField
                control={form.control}
                name="permissions"
                render={() => (
                  <FormItem>
                    <FormLabel>細權限</FormLabel>
                    <FormDescription>
                      只勾選的項目會生效；管理員一律視為全有，不受這裡影響。
                    </FormDescription>
                    <div className="space-y-2 rounded-md border border-border p-3">
                      {VISIBLE_PERMISSIONS.map((permission) => (
                        <FormField
                          key={permission}
                          control={form.control}
                          name="permissions"
                          render={({ field }) => {
                            const checked = field.value.includes(permission);
                            return (
                              <FormItem className="flex flex-row items-start space-x-2 space-y-0">
                                <FormControl>
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={(next) => {
                                      field.onChange(
                                        next
                                          ? [...field.value, permission]
                                          : field.value.filter((p) => p !== permission),
                                      );
                                    }}
                                  />
                                </FormControl>
                                <FormLabel className="text-sm font-normal leading-tight">
                                  {PERMISSION_LABELS[permission]}
                                </FormLabel>
                              </FormItem>
                            );
                          }}
                        />
                      ))}
                    </div>
                  </FormItem>
                )}
              />
            )}

            <DialogFooter>
              <Button type="submit" disabled={submitting}>
                {submitting ? "儲存中…" : "儲存變更"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
