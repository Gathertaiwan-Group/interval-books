import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
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
import { signIn } from "@/lib/admin/fns/auth";
import { backOfficeTypeScaleStyles } from "@/lib/admin/type-scale";
import { safeLoginRedirect } from "@/lib/admin/login-redirect";

const loginSchema = z.object({
  email: z.string().trim().min(1, "請輸入電子郵件").email("電子郵件格式不正確"),
  password: z.string().min(1, "請輸入密碼"),
});

type LoginValues = z.infer<typeof loginSchema>;

export const Route = createFileRoute("/admin/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const redirect = safeLoginRedirect(search.redirect);
    return redirect ? { redirect } : {};
  },
  head: () => ({
    meta: [{ title: "管理員登入｜小時光書店後台" }],
    styles: backOfficeTypeScaleStyles(),
  }),
  component: AdminLoginPage,
});

function AdminLoginPage() {
  const navigate = useNavigate();
  const { redirect: returnTo } = Route.useSearch();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: LoginValues) {
    setSubmitting(true);
    try {
      const { role } = await signIn({ data: values });
      // 換了一個人登入：前一個人的側欄快取與看過的頁面資料都不可以沿用
      // （見 shell-user-cache.ts、route-cache.ts；其他分頁也一起清）。
      const { noteAdminIdentityChange } = await import("@/lib/admin/route-cache");
      noteAdminIdentityChange();
      toast.success("登入成功");
      // 從 MCP 連接器授權頁過來的：不論角色都送回去（門市人員會在那裡看到婉拒說明）。
      // 整頁導覽而不是 navigate，讓授權頁在伺服器端用新的 cookie 重新判斷一次。
      const back = safeLoginRedirect(returnTo);
      if (back) {
        window.location.assign(back);
        return;
      }
      // 每個角色送去他真的看得到的第一頁。店員被送去儀表板會撞上
      // adminFnMiddleware —— 擋得對，但不該是他每天上班第一眼看到的東西。
      if (role === "pending") {
        await navigate({ to: "/admin/pending" });
      } else if (role === "staff") {
        await navigate({ to: "/admin/pos" });
      } else {
        await navigate({ to: "/admin" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "登入失敗，請稍後再試";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-background p-8 shadow-sm">
        <div className="space-y-1 text-center">
          <p className="text-sm text-muted-foreground">小時光書店 Interval Books</p>
          <h1 className="text-xl font-medium">管理後台登入</h1>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>電子郵件</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="username" {...field} />
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
                  <FormLabel>密碼</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="current-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "登入中…" : "登入"}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}
