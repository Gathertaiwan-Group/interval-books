/**
 * 廠商自助入口的 pathless layout（/vendor 底下除了 login 與 pending 以外的全部）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 第一條規矩：這一整段 UI 沒有任何一個 server fn 呼叫會傳 vendorId
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 不是「有傳但 server 會檢查」，是**根本沒有這個欄位**。廠商身分完全由 sealed
 * httpOnly cookie（`ib_vendor`）決定：
 *
 *     myVendorProfile()        ← 無參數
 *     myProducts()             ← 無參數
 *     myBankAccountDetails()   ← 無參數
 *     submitProduct({ data })  ← data 裡沒有 vendor_id（schemas.ts §廠商自助入口）
 *     withdrawProduct({ data })← data 只有 id
 *
 * 三層各自獨立擋一次：UI 不送、zod schema 沒有這個 key、資料庫函式簽名也沒有
 * p_vendor_id（vendor_id 是函式體內用 p_user_id 查 vendor_users 得到的）。要偽裝成
 * 別家廠商，得先偽造 sealed cookie 裡的 userId。
 *
 * ⚠️ 所以下面 beforeLoad 回傳的 context **刻意不含 vendorId**，只留顯示用的名稱與
 *    代號。getCurrentVendor() 其實回得出 vendorId，但只要它進了 route context，遲早
 *    有人會「順手」把它塞進某一支 server fn 的 payload —— 那一刻上面那條規矩就從
 *    「結構上做不到」退化成「大家記得不要這樣做」。UI 拿不到，就沒得傳。
 *
 * ── 第二條規矩：beforeLoad 只決定畫面，不是授權 ───────────────────────────
 *
 * 這裡的 redirect 只控制「這個瀏覽器現在該看到哪一頁」。它**不是安全邊界** ——
 * 真正擋住直接 POST /_serverFn/… 的是每一支 server fn 上掛的 vendorFnMiddleware()
 * （見 lib/admin/middleware.ts 與 lib/admin/fns/vendor-portal.ts 檔頭），那一支每個
 * 請求都重讀 profiles.role、重問 public.vendor_my_id()。把這個 beforeLoad 整段刪掉，
 * 廠商拿不到的資料還是一筆都拿不到；差別只在他會看到一頁錯誤而不是被導去登入頁。
 *
 * 反過來講也成立，而且這才是它存在的理由：沒有它，已登出的訪客會先看到頁首閃一下
 * 再被彈走，而未綁定的廠商會看到一頁 401 而不是一句「請聯絡書店」。
 *
 * ── 第三條：三種狀態要分開處理 ────────────────────────────────────────────
 *
 *     signed_out → /vendor/login    沒有 cookie，或 cookie 對應的身分已被撤銷
 *     unlinked   → /vendor/pending  登入成功，但沒綁廠商／被停權（三個開關之一）
 *     ok         → 放行
 *
 * 把 unlinked 併進 signed_out 是最常見的寫法，也是錯的：廠商會被丟回登入頁，然後
 * 一直重打密碼（因為密碼是對的），最後打電話來問帳號是不是壞了。/vendor/login 與
 * /vendor/pending 兩頁都在這個 _shell **之外** —— 走到那兩頁的人一頁都還看不到，
 * 不該先渲染一整排導覽連結。
 */
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { LayoutDashboard, LogOut, Package, Store } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { vendorSignOut } from "@/lib/admin/fns/vendor-portal";
import { backOfficeTypeScaleStyles } from "@/lib/admin/type-scale";

/** 廠商只有兩頁，所以是頁首導覽而不是側欄 —— 側欄撐不起兩個連結。 */
const NAV_ITEMS = [
  { to: "/vendor", label: "首頁", icon: LayoutDashboard },
  { to: "/vendor/products", label: "我的商品", icon: Package },
] as const;

export const Route = createFileRoute("/vendor/_shell")({
  beforeLoad: async () => {
    const { getCurrentVendor } = await import("@/lib/admin/fns/vendor-portal");
    const result = await getCurrentVendor();

    if (result.state === "signed_out") throw redirect({ to: "/vendor/login" });
    if (result.state === "unlinked") throw redirect({ to: "/vendor/pending" });

    // ⚠️ 只留顯示用的欄位。vendorId 刻意不進 context，理由見檔頭。
    return {
      vendor: {
        name: result.vendor.vendorName,
        code: result.vendor.vendorCode,
        email: result.vendor.email,
      },
    };
  },
  head: () => ({ styles: backOfficeTypeScaleStyles() }),
  component: VendorShell,
});

function VendorShell() {
  const { vendor } = Route.useRouteContext();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  async function handleSignOut() {
    try {
      await vendorSignOut();
      toast.success("已登出");
      await navigate({ to: "/vendor/login" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "登出失敗，請再試一次");
    }
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <Store className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <div className="leading-tight">
              <p className="text-sm font-medium">{vendor.name || "廠商入口"}</p>
              <p className="text-xs text-muted-foreground">
                小時光書店{vendor.code ? `・${vendor.code}` : ""}
              </p>
            </div>
          </div>

          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.to;
              return (
                <Button
                  key={item.to}
                  asChild
                  variant={active ? "secondary" : "ghost"}
                  size="sm"
                  className="gap-1.5"
                >
                  <Link to={item.to}>
                    <item.icon className="h-4 w-4" aria-hidden="true" />
                    {item.label}
                  </Link>
                </Button>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              {vendor.email}
            </span>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleSignOut}>
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              登出
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
