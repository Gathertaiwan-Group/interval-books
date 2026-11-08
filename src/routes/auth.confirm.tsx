/**
 * /auth/confirm —— 信件連結的落地點：token_hash + verifyOtp。
 *
 * 🔴 這是這個站唯一該讓信件連結指向的路徑，不是 /auth/callback。`?code=` 是
 *    PKCE，code_verifier 綁在**發起請求的那個瀏覽器**；客人常在 Gmail App 的
 *    內建瀏覽器點信件連結，換了瀏覽器就一定失敗，而且錯誤訊息還會顯示「連結已
 *    失效」——那句話是錯的，會把客服帶往錯誤方向。`?token_hash=` 沒有這個問題：
 *    驗證是伺服器直接拿 token_hash 去問 Supabase，跟是哪一台瀏覽器點的無關。
 *    見 server/customer-auth.ts 的 customerAuthRedirectUrl()——signUpCustomer /
 *    requestCustomerPasswordReset 都只會產生指向這裡的連結。
 *
 * ── 驗證放在 loader，不是 component 的 useEffect ────────────────────────
 *
 * verifyOtp 是一次性的：同一個 token_hash 第二次呼叫一定失敗（見
 * server/customer-auth-links.ts 檔頭）。loader 在伺服器端、每次真正的導覽只會
 * 跑一次，不會像 component 的 effect 那樣在 React 的重渲染／StrictMode 下有
 * 重複呼叫的疑慮。這個頁面永遠是從信件連結整頁導覽過來的（沒有任何站內
 * `<Link to="/auth/confirm">`），不會被 router 的 hover-preload 提早觸發。
 *
 * ── 失敗時做什麼 ──────────────────────────────────────────────────────────
 *
 * 🔴 不導去 /account/login——客人看到登入頁配紅字，第一反應是「我是不是打錯
 *    密碼」，而這裡的失敗跟密碼完全無關（可能只是連結過期，或已經點過一次）。
 *    改成原地顯示一個專屬的中文說明頁，並提供「重新申請」的路徑。
 */
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";

type LinkType = "signup" | "recovery" | "";

const META = {
  title: {
    zh: "帳號驗證｜小時光書店",
    en: "Verifying｜Interval Books",
    ja: "認証確認｜小時光書店",
  },
  description: {
    zh: "正在確認你的小時光書店帳號驗證連結。",
    en: "Confirming your Interval Books account verification link.",
    ja: "小時光書店のアカウント確認リンクを確認しています。",
  },
};

export const Route = createFileRoute("/auth/confirm")({
  validateSearch: (search: Record<string, unknown>) => ({
    token_hash: typeof search.token_hash === "string" ? search.token_hash : "",
    type: typeof search.type === "string" ? search.type : "",
  }),
  loaderDeps: ({ search }) => ({ tokenHash: search.token_hash, type: search.type }),
  loader: async ({ deps }) => {
    if (!deps.tokenHash || (deps.type !== "signup" && deps.type !== "recovery")) {
      return {
        confirmError: "這個連結缺少必要的驗證參數，請確認你點的是信件裡完整的連結。",
        type: (deps.type as LinkType) || "",
      };
    }

    const type = deps.type;
    let result: { type: "signup" | "recovery" } | null = null;
    let confirmError: string | null = null;
    try {
      const { confirmAuthLink } = await import("@/lib/customer-fns");
      result = await confirmAuthLink({ data: { tokenHash: deps.tokenHash, type } });
    } catch (err) {
      confirmError =
        err instanceof Error ? err.message : "這個連結無法使用，可能已經過期或已經使用過";
    }

    // ⚠️ throw redirect() 刻意放在 try/catch 之外——放在 try 區塊裡的話，
    //    TanStack Router 拿來實作 redirect 的那個 throw 會被上面的 catch 攔截，
    //    誤判成一次失敗的驗證。
    if (result) {
      throw redirect({ to: result.type === "recovery" ? "/account/reset" : "/account" });
    }
    return { confirmError, type };
  },
  head: () => ({
    meta: [
      { title: META.title.zh },
      { name: "description", content: META.description.zh },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthConfirmPage,
});

function AuthConfirmPage() {
  const { confirmError, type } = Route.useLoaderData();

  useDocumentMeta({ title: META.title, description: META.description });

  if (!confirmError) {
    // 正常情況下到不了這裡——loader 驗證成功就會 throw redirect()。留一個安靜的
    // 畫面只是防禦式的過渡狀態，比起顯示一句「你不應該看到這個」更誠實。
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
        <p className="text-sm text-muted-foreground">驗證中…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-background p-8 text-center shadow-sm">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
          <TriangleAlert className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-xl font-medium">這個連結無法使用</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{confirmError}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            連結可能已經過期，或是已經使用過。這與帳號密碼無關，重新申請一次即可。
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {type !== "signup" && (
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link to="/account/forgot">重新申請重設密碼</Link>
            </Button>
          )}
          {type !== "recovery" && (
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link to="/account/register">重新註冊</Link>
            </Button>
          )}
          <Button variant="ghost" size="sm" className="w-full" asChild>
            <Link to="/account/login">回到登入</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
