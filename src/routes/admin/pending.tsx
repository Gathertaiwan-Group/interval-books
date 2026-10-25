import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/admin/fns/auth";
import { backOfficeTypeScaleStyles } from "@/lib/admin/type-scale";

/**
 * 「等一下，還沒有人放行你」。
 *
 * 這一頁刻意**不在 /admin/_shell 底下** —— shell 會渲染整個側欄，而 pending 的人
 * 一個模組都還不能看。放在 shell 外面，他看到的就只有這一句話。
 *
 * 來源進銷存系統有一支 PendingApproval.tsx 做同一件事。搬過來的理由跟當初寫它的
 * 理由一樣：內部同事拿到的 401 長得跟「密碼打錯」一模一樣，於是他會一直重打密碼，
 * 然後來問帳號是不是壞了。這一頁把「你的帳號是好的，只是還沒開通」講出來。
 */
export const Route = createFileRoute("/admin/pending")({
  beforeLoad: async () => {
    const { getCurrentBackOfficeUser } = await import("@/lib/admin/fns/auth");
    const user = await getCurrentBackOfficeUser();
    if (!user) throw redirect({ to: "/admin/login" });
    // 已經被放行的人不該卡在這一頁。
    if (user.role !== "pending") throw redirect({ to: "/admin" });
    return { user };
  },
  head: () => ({
    meta: [{ title: "帳號待開通｜小時光書店後台" }],
    styles: backOfficeTypeScaleStyles(),
  }),
  component: PendingApprovalPage,
});

function PendingApprovalPage() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();

  async function handleSignOut() {
    const { clearShellUserCache } = await import("@/lib/admin/shell-user-cache");
    clearShellUserCache();
    await signOut();
    await navigate({ to: "/admin/login" });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-md space-y-5 rounded-lg border border-border bg-background p-8 text-center shadow-sm">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
          <Clock className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-xl font-medium">帳號尚未開通</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            你的登入是成功的 —— 帳號與密碼都正確。
            <br />
            只是還沒有管理員把你設為門市人員，所以目前還看不到任何模組。
          </p>
        </div>
        <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          請聯絡管理員，把 <span className="font-medium text-foreground">{user.email}</span>{" "}
          的角色改成「staff」。
        </p>
        <Button variant="outline" size="sm" className="w-full" onClick={handleSignOut}>
          登出
        </Button>
      </div>
    </div>
  );
}
