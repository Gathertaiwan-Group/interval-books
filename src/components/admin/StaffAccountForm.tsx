/**
 * 編輯後台身分：改角色＋（角色是 staff 時）細權限 —— /admin/staff/$id 的本體。
 *
 * 2026-10-26 從 _shell.staff.tsx 的 EditAccountDialog 改成內頁（後台第 3 批；業主：「不要用彈窗，
 * 直接顯示內頁＆回到上一頁」）。送出邏輯一行沒改：
 *
 *   兩件事同一次送出，是為了操作方便——底層仍是兩支獨立的 server fn（updateStaffRole／
 *   setStaffPermissions）。角色不是 staff 時完全不呼叫 setStaffPermissions：既有的
 *   staff_permissions 列原樣保留，不會被清空——見 src/server/repos/staff-accounts.ts。
 *
 * 2026-10-21 那次對話框版面修正（1eae85b）的用意照樣保留：角色下拉的觸發鈕允許換行、選單寬度
 * 不超過觸發鈕，長說明在選單內換行；「儲存變更」永遠看得到——內頁的主要動作在 md 以上放右上角、
 * 手機黏在畫面底部（AdminDetailPage），不會再被撐出框外。
 */
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Save, UserCog } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { PERMISSION_LABELS } from "@/lib/admin/permission-labels";
import { CREATABLE_BACKOFFICE_ROLES, STAFF_PERMISSIONS } from "@/lib/admin/schemas";
import {
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  VISIBLE_PERMISSIONS,
  type CreatableRole,
} from "@/lib/admin/staff-roles";
import type { StaffAccountRow } from "@/server/repos/staff-accounts";

function buildEditAccountFormSchema() {
  return z.object({
    role: z.enum(CREATABLE_BACKOFFICE_ROLES, { errorMap: () => ({ message: "請選擇角色" }) }),
    permissions: z.array(z.enum(STAFF_PERMISSIONS)),
  });
}

type EditAccountFormValues = z.infer<ReturnType<typeof buildEditAccountFormSchema>>;

type Props = {
  account: StaffAccountRow;
  /** 存檔成功（已經 allowLeave）：呼叫端負責 invalidate 與換頁。 */
  onSaved: () => Promise<void>;
};

export function StaffAccountForm({ account, onSaved }: Props) {
  const editAccountFormSchema = useMemo(buildEditAccountFormSchema, []);
  const [saving, setSaving] = useState(false);
  const form = useForm<EditAccountFormValues>({
    resolver: zodResolver(editAccountFormSchema),
    defaultValues: {
      role: (account.role as CreatableRole) ?? "staff",
      permissions: account.permissions ?? [],
    },
  });

  const { dirty } = useFormDirty(form.watch());
  const guard = useUnsavedChangesGuard(dirty);
  const selectedRole = form.watch("role");

  async function handleSubmit(values: EditAccountFormValues) {
    setSaving(true);
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
      guard.allowLeave();
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失敗，請稍後再試");
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <Button type="submit" form="staff-account-form" className="gap-1.5" disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {saving ? "儲存中…" : "儲存變更"}
    </Button>
  );

  return (
    <AdminDetailPage
      backTo="/admin/staff"
      backLabel="回後台人員列表"
      icon={<UserCog className="h-5 w-5" aria-hidden="true" />}
      title="編輯後台身分"
      meta={<span className="break-words">{account.email ?? account.id}</span>}
      actions={actions}
      width="md"
    >
      <Form {...form}>
        <form
          id="staff-account-form"
          onSubmit={form.handleSubmit(handleSubmit)}
          className="min-w-0 space-y-5"
        >
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
        </form>
      </Form>

      <div className="hidden justify-end md:flex">{actions}</div>
      {guard.dialog}
    </AdminDetailPage>
  );
}
