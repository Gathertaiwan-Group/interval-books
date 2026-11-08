/**
 * /vendor/login —— 廠商入口登入。
 *
 * ── 這一頁在解什麼問題 ────────────────────────────────────────────────────
 * 廠商不是店裡的同事，他不該碰到 /admin/login。兩邊是**兩套完全分開的 session**：
 * 後台是 cookie `ib_admin`，廠商是 cookie `ib_vendor`（見 server/vendor-auth.ts
 * 檔頭）。所以這不是「同一個登入頁多一個角色」，而是另一扇門 —— 一張後台的 cookie
 * 送到廠商入口會讀不到，反之亦然。
 *
 * ── 哪裡容易寫錯 ──────────────────────────────────────────────────────────
 * ⚠️ 登入成功**不代表**這個帳號綁得到廠商。signInVendor() 只驗到 profiles.role
 *    = 'vendor' 就發 cookie，刻意不驗 vendor_users —— 帳號建好但還沒綁廠商（或被
 *    停權）的人該看到一頁說明，而不是一句「密碼錯誤」。所以這裡一律導去 /vendor，
 *    再由 _shell 的 beforeLoad 去分辨 ok / unlinked，**不要**在這裡自己判斷一次。
 *    兩個地方各寫一份判斷，遲早有一份忘記更新。
 *
 * ⚠️ 「密碼錯」與「這個帳號不是廠商」在 server 端共用同一句錯誤訊息（防列舉）。
 *    這裡原樣把 err.message 印出來就好，不要試圖「翻譯得更清楚」。
 */
import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Store } from "lucide-react";
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
import { vendorSignIn } from "@/lib/admin/fns/vendor-portal";
import { backOfficeTypeScaleStyles } from "@/lib/admin/type-scale";

/**
 * 與 schemas.ts 的 vendorSignInSchema 同一組規則，但這一份多了「請輸入電子郵件」
 * 這類空值文案 —— server 那一份的訊息是給 API 看的，這一份是給人看的。真正的驗證
 * 仍然在 server（vendorSignIn 的 inputValidator）。
 */
const loginSchema = z.object({
  email: z.string().trim().min(1, "請輸入電子郵件").email("電子郵件格式不正確"),
  password: z.string().min(1, "請輸入密碼"),
});

type LoginValues = z.infer<typeof loginSchema>;

export const Route = createFileRoute("/vendor/login")({
  head: () => ({
    meta: [{ title: "廠商登入｜小時光書店" }],
    styles: backOfficeTypeScaleStyles(),
  }),
  component: VendorLoginPage,
});

function VendorLoginPage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: LoginValues) {
    setSubmitting(true);
    try {
      await vendorSignIn({ data: values });
      toast.success("登入成功");
      // 一律導去 /vendor。綁定與停權的判斷交給 _shell 的 beforeLoad，見檔頭。
      await navigate({ to: "/vendor" });
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
            <Store className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm text-muted-foreground">小時光書店 Interval Books</p>
          <h1 className="text-xl font-medium">廠商入口登入</h1>
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

        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          帳號由小時光書店配發。忘記密碼或還沒拿到帳號，請直接聯絡書店。
        </p>
      </div>
    </div>
  );
}
