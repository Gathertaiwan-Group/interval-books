/**
 * /account/register —— 客人註冊。
 *
 * ⚠️ 註冊成功**不會**自動登入——signUpCustomer() 只建帳號、發驗證信，
 *    email_confirmed_at 要等客人點過信裡連結、經 /auth/confirm 驗完
 *    token_hash 才會是 true（Supabase 專案 mailer_autoconfirm=false，見任務
 *    「已知」）。這裡刻意不導去 /account——那一頁需要真的登入；也不導去
 *    /account/login——現在拿密碼登入只會撞上 EmailNotConfirmedError，客人會
 *    以為自己打錯密碼。改成原地顯示「請收信」，而且與 signUpCustomer() 的檔頭
 *    一致：回傳值不透露這個信箱是不是已經註冊過，這裡的畫面也一樣——不管是新
 *    註冊還是重複註冊，客人看到的都是同一句話。
 *
 * ⚠️ 「密碼」與「確認密碼」是否一致，只在這裡（瀏覽器端）檢查——server 端的
 *    customerSignUpSchema 只收一個 password 欄位，見 lib/customer-account.ts。
 */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { MailCheck, UserRoundPlus } from "lucide-react";
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
import { customerSignUp } from "@/lib/customer-fns";

const registerSchema = z
  .object({
    email: z.string().trim().min(1, "請輸入電子郵件").email("電子郵件格式不正確"),
    password: z.string().min(CUSTOMER_PASSWORD_MIN, `密碼至少需要 ${CUSTOMER_PASSWORD_MIN} 個字元`),
    confirmPassword: z.string().min(1, "請再輸入一次密碼"),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "兩次輸入的密碼不一致",
    path: ["confirmPassword"],
  });
type RegisterValues = z.infer<typeof registerSchema>;

const META = {
  title: {
    zh: "註冊會員｜小時光書店",
    en: "Create Account｜Interval Books",
    ja: "新規登録｜小時光書店",
  },
  description: {
    zh: "註冊小時光書店會員帳號，訂單與活動報名都能隨時回來查詢。",
    en: "Create an Interval Books account so you can always find your way back to your orders and event registrations.",
    ja: "小時光書店の会員登録。ご注文やイベント申込みをいつでもご確認いただけます。",
  },
};

export const Route = createFileRoute("/account_/register")({
  head: () => ({
    meta: [
      { title: META.title.zh },
      { name: "description", content: META.description.zh },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountRegisterPage,
});

function AccountRegisterPage() {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  useDocumentMeta({ title: META.title, description: META.description });

  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: "", password: "", confirmPassword: "" },
  });

  async function onSubmit(values: RegisterValues) {
    setSubmitting(true);
    try {
      await customerSignUp({ data: { email: values.email, password: values.password } });
      setSent(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "註冊失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
        <div className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-background p-8 text-center shadow-sm">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <MailCheck className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-xl font-medium">請收信完成驗證</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              驗證信已經寄出。請到信箱點選信中的連結，完成驗證後就能登入帳號。
            </p>
          </div>
          <Button variant="outline" size="sm" className="w-full" asChild>
            <Link to="/account/login">前往登入</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-background p-8 shadow-sm">
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <UserRoundPlus className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm text-muted-foreground">小時光書店 Interval Books</p>
          <h1 className="text-xl font-medium">註冊會員</h1>
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
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>確認密碼</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "註冊中…" : "註冊"}
            </Button>
          </form>
        </Form>

        <p className="text-center text-xs text-muted-foreground">
          已經有帳號？{" "}
          <Link to="/account/login" className="hover-underline text-foreground">
            前往登入
          </Link>
        </p>
      </div>
    </div>
  );
}
