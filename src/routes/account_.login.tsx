/**
 * /account/login —— 客人登入。
 *
 * 與 vendor/login.tsx 同一個模板（見那個檔案檔頭「哪裡容易寫錯」，這裡原樣適
 * 用）：「密碼錯」與「沒有這個帳號」在 server 端共用同一句錯誤訊息（防列舉），
 * 這裡原樣把 err.message 顯示出來就好，不要試圖「翻譯得更清楚」。
 *
 * ⚠️ EmailNotConfirmedError 是唯一的例外——那句話（「請先收信完成信箱驗證」）不是
 *    列舉管道：GoTrue 先驗密碼，密碼對了才會回 email_not_confirmed，所以看得到
 *    這句話的人本來就已經知道那組密碼。這裡與其它錯誤一樣原樣顯示，不用特別分流。
 *
 * ⚠️ 登入成功後一律導去 /account，不在這裡自己判斷「有沒有訂單」之類的——那是
 *    /account 自己的事（與 vendor/login.tsx 導去 /vendor、交給 _shell 判斷同一個
 *    分工）。
 */
import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { UserRound } from "lucide-react";
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
import { customerSignIn } from "@/lib/customer-fns";

const loginSchema = z.object({
  email: z.string().trim().min(1, "請輸入電子郵件").email("電子郵件格式不正確"),
  password: z.string().min(1, "請輸入密碼"),
});
type LoginValues = z.infer<typeof loginSchema>;

const META = {
  title: {
    zh: "會員登入｜小時光書店",
    en: "Sign In｜Interval Books",
    ja: "ログイン｜小時光書店",
  },
  description: {
    zh: "登入小時光書店會員帳號，查看你的訂單與活動報名紀錄。",
    en: "Sign in to your Interval Books account to view your orders and event registrations.",
    ja: "小時光書店の会員アカウントにログインし、ご注文とイベント申込みをご確認いただけます。",
  },
};

export const Route = createFileRoute("/account_/login")({
  head: () => ({
    meta: [
      { title: META.title.zh },
      { name: "description", content: META.description.zh },
      // 帳號頁面是私人、逐裝置的內容，與 /cart 同一個判準——見 cart.tsx。
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountLoginPage,
});

function AccountLoginPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);

  useDocumentMeta({ title: META.title, description: META.description });

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: LoginValues) {
    setSubmitting(true);
    try {
      await customerSignIn({ data: values });
      toast.success("登入成功");
      await navigate({ to: "/account" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "登入失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-background p-8 shadow-sm">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <UserRound className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm text-muted-foreground">小時光書店 Interval Books</p>
          <h1 className="text-xl font-medium">會員登入</h1>
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

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <Link to="/account/forgot" className="hover-underline">
            忘記密碼？
          </Link>
          <Link to="/account/register" className="hover-underline">
            還沒有帳號？註冊
          </Link>
        </div>
      </div>
    </div>
  );
}
