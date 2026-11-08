/**
 * /account/reset —— 設定新密碼。
 *
 * 兩條路都會走到這一頁：
 *   1. 點了忘記密碼信裡的連結：/auth/confirm 驗完 token_hash 後把人導來這裡
 *      （見 auth.confirm.tsx、server/customer-auth-links.ts 檔頭）。
 *   2. 已登入的客人自己想改密碼（從 /account 點「修改密碼」進來）。
 *
 * 兩條路用的是**同一道**授權邊界：requireCustomer()。這裡不再收、也不再驗
 * token_hash——那是一次性的，已經在 auth.confirm.tsx 落地時用掉了。也因為這樣，
 * 這一頁與 account.tsx 一樣需要 beforeLoad guard：不是這個流程走過來的人（沒有
 * ib_customer cookie）會被導去登入頁，而不是看到一個他填了也送不出去的表單。
 *
 * ⚠️ beforeLoad 只決定畫面，不是授權邊界——真正擋著的是 setNewPassword() 掛的
 *    customerFnMiddleware()（= requireCustomer()）。見 vendor/_shell.tsx 檔頭
 *    同一條規矩。
 */
import { useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { CUSTOMER_PASSWORD_MIN } from "@/lib/customer-account";

const resetSchema = z
  .object({
    newPassword: z
      .string()
      .min(CUSTOMER_PASSWORD_MIN, `密碼至少需要 ${CUSTOMER_PASSWORD_MIN} 個字元`),
    confirmNewPassword: z.string().min(1, "請再輸入一次密碼"),
  })
  .refine((v) => v.newPassword === v.confirmNewPassword, {
    message: "兩次輸入的密碼不一致",
    path: ["confirmNewPassword"],
  });
type ResetValues = z.infer<typeof resetSchema>;

const META = {
  title: {
    zh: "設定新密碼｜小時光書店",
    en: "Set New Password｜Interval Books",
    ja: "新しいパスワードの設定｜小時光書店",
  },
  description: {
    zh: "為你的小時光書店會員帳號設定一組新密碼。",
    en: "Set a new password for your Interval Books account.",
    ja: "小時光書店の会員アカウントに新しいパスワードを設定します。",
  },
};

export const Route = createFileRoute("/account_/reset")({
  beforeLoad: async () => {
    const { getCurrentCustomer } = await import("@/lib/customer-fns");
    const result = await getCurrentCustomer();
    if (result.state === "signed_out") throw redirect({ to: "/account/login" });
    return { customer: result.customer };
  },
  head: () => ({
    meta: [
      { title: META.title.zh },
      { name: "description", content: META.description.zh },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountResetPage,
});

function AccountResetPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);

  useDocumentMeta({ title: META.title, description: META.description });

  const form = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { newPassword: "", confirmNewPassword: "" },
  });

  async function onSubmit(values: ResetValues) {
    setSubmitting(true);
    try {
      const { setNewPassword } = await import("@/lib/customer-fns");
      await setNewPassword({ data: { newPassword: values.newPassword } });
      toast.success("密碼已更新");
      await navigate({ to: "/account" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-background p-8 shadow-sm">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm text-muted-foreground">小時光書店 Interval Books</p>
          <h1 className="text-xl font-medium">設定新密碼</h1>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>新密碼</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirmNewPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>確認新密碼</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "更新中…" : "更新密碼"}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}
