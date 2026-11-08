/**
 * /vendor/pending —— 「你登入成功了，但這個帳號現在沒有可用的廠商入口權限」。
 *
 * ── 這一頁在解什麼問題 ────────────────────────────────────────────────────
 * signInVendor() 只驗到 profiles.role = 'vendor' 就發 cookie，**刻意不驗
 * vendor_users**。所以「登入成功」與「看得到自己的商品」是兩件事，中間差了三個
 * 開關（server/vendor-auth.ts 檔頭）：
 *
 *     vendor_users 那一列還沒建     → 帳號建好了但還沒綁到哪一家
 *     vendor_users.is_active=false  → 這個聯絡人被停用
 *     vendors.status ≠ 'active'     → 整家廠商被停權／終止往來
 *
 * 三個都會走到這一頁。**畫面上不區分是哪一個** —— 那是 0019 §7.4 的決定：不同的
 * 訊息可以拿來反查「這個帳號有沒有綁定」，是一條列舉管道。所以這裡只講「請聯絡
 * 書店」，不講「你被停權了」。
 *
 * ── 為什麼在 _shell 外面 ──────────────────────────────────────────────────
 * 與 /admin/pending 同一條理由：shell 會渲染頁首導覽，而走到這一頁的人一頁都還
 * 看不到。放在 shell 外面，他看到的就只有這一句話。
 *
 * ── 哪裡容易寫錯 ──────────────────────────────────────────────────────────
 * ⚠️ 這一頁自己也要 guard，而且要導**兩個**方向：沒登入的人不該看到這一頁（導去
 *    /vendor/login），已經綁好的人更不該卡在這裡（導去 /vendor）。少了後者，廠商
 *    被書店補綁定之後會一直停在這一頁，直到他自己想到要改網址。
 */
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ShieldQuestion } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { vendorSignOut } from "@/lib/admin/fns/vendor-portal";
import { backOfficeTypeScaleStyles } from "@/lib/admin/type-scale";

export const Route = createFileRoute("/vendor/pending")({
  beforeLoad: async () => {
    const { getCurrentVendor } = await import("@/lib/admin/fns/vendor-portal");
    const result = await getCurrentVendor();
    if (result.state === "signed_out") throw redirect({ to: "/vendor/login" });
    // 已經綁好的人不該卡在這一頁，見檔頭。
    if (result.state === "ok") throw redirect({ to: "/vendor" });
    return { email: result.email };
  },
  head: () => ({
    meta: [{ title: "帳號尚未開通｜小時光書店廠商入口" }],
    styles: backOfficeTypeScaleStyles(),
  }),
  component: VendorPendingPage,
});

function VendorPendingPage() {
  const { email } = Route.useRouteContext();
  const navigate = useNavigate();

  async function handleSignOut() {
    try {
      await vendorSignOut();
      await navigate({ to: "/vendor/login" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "登出失敗，請再試一次");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-md space-y-5 rounded-lg border border-border bg-background p-8 text-center shadow-sm">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
          <ShieldQuestion className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-xl font-medium">帳號尚未開通</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            你的登入是成功的 —— 帳號與密碼都正確。
            <br />
            只是這個帳號目前還沒有對應到一家可用的廠商，所以看不到任何商品資料。
          </p>
        </div>
        <p className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          請聯絡小時光書店，告訴他們你的登入帳號是{" "}
          <span className="font-medium text-foreground">{email}</span>，
          請書店確認廠商入口權限是否已開通。
        </p>
        <Button variant="outline" size="sm" className="w-full" onClick={handleSignOut}>
          登出
        </Button>
      </div>
    </div>
  );
}
