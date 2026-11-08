/**
 * /account/forgot —— 忘記密碼。
 *
 * ⚠️ 不管這個信箱有沒有註冊過，畫面上都顯示同一句話——與
 *    requestCustomerPasswordReset() 的姿態一致（見 customer-auth.ts 檔頭：
 *    「其餘錯誤（含查無此人）一律吞掉」）。這裡唯一會走到 catch 分支的是寄送
 *    次數超限（over_email_send_rate_limit / over_request_rate_limit），那句話
 *    本身與帳號存不存在無關，可以照樣顯示成錯誤。
 */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { KeyRound, MailCheck } from "lucide-react";
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
import { requestPasswordReset } from "@/lib/customer-fns";

const forgotSchema = z.object({
  email: z.string().trim().min(1, "請輸入電子郵件").email("電子郵件格式不正確"),
});
type ForgotValues = z.infer<typeof forgotSchema>;

const META = {
  title: {
    zh: "忘記密碼｜小時光書店",
    en: "Forgot Password｜Interval Books",
    ja: "パスワードをお忘れの方｜小時光書店",
  },
  description: {
    zh: "重設小時光書店會員帳號的密碼。",
    en: "Reset the password for your Interval Books account.",
    ja: "小時光書店の会員アカウントのパスワードを再設定します。",
  },
};

export const Route = createFileRoute("/account_/forgot")({
  head: () => ({
    meta: [
      { title: META.title.zh },
      { name: "description", content: META.description.zh },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountForgotPage,
});

function AccountForgotPage() {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  useDocumentMeta({ title: META.title, description: META.description });

  const form = useForm<ForgotValues>({
    resolver: zodResolver(forgotSchema),
    defaultValues: { email: "" },
  });

  async function onSubmit(values: ForgotValues) {
    setSubmitting(true);
    try {
      await requestPasswordReset({ data: values });
      // 不管查有沒有這個帳號，一律顯示同一句——見檔頭。
      setSent(true);
    } catch (err) {
      // 唯一會走到這裡的是寄送次數超限（見 requestCustomerPasswordReset 檔頭），
      // 那句話本身不透露帳號是否存在，可以照樣顯示。
      toast.error(err instanceof Error ? err.message : "請稍後再試");
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
            <h1 className="text-xl font-medium">請收信</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              如果這個信箱有註冊過，我們已經寄出重設密碼的連結，請到信箱查收。
            </p>
          </div>
          <Button variant="outline" size="sm" className="w-full" asChild>
            <Link to="/account/login">回到登入</Link>
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
            <KeyRound className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm text-muted-foreground">小時光書店 Interval Books</p>
          <h1 className="text-xl font-medium">忘記密碼</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            輸入註冊時使用的電子郵件，我們會寄送重設密碼的連結給你。
          </p>
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
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "寄送中…" : "寄送重設連結"}
            </Button>
          </form>
        </Form>

        <p className="text-center text-xs text-muted-foreground">
          想起密碼了？{" "}
          <Link to="/account/login" className="hover-underline text-foreground">
            回到登入
          </Link>
        </p>
      </div>
    </div>
  );
}
