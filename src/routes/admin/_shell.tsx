import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  Boxes,
  Building2,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  FileText,
  Handshake,
  Landmark,
  LayoutDashboard,
  LogOut,
  Mic,
  Newspaper,
  Package,
  Package2,
  PackageSearch,
  Phone,
  Receipt,
  ScanLine,
  SlidersHorizontal,
  TruckIcon,
  Settings,
  Tags,
  Tent,
  TriangleAlert,
  Type,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { signOut } from "@/lib/admin/fns/auth";
import { isNavItemActive } from "@/lib/admin/nav-active";
import { backOfficeTypeScaleStyles } from "@/lib/admin/type-scale";

/**
 * Pathless layout for the whole /admin back office (except /admin/login and
 * /admin/pending, which live outside this layout on purpose — a signed-out or
 * not-yet-approved visitor has no business seeing a sidebar).
 *
 * beforeLoad is the ROUTE GUARD: it only controls what the UI shows/redirects
 * to. It is not the security boundary — adminFnMiddleware / staffFnMiddleware
 * are (see src/lib/admin/middleware.ts) — but it's still what keeps a
 * signed-out visitor from ever seeing the shell flash before bouncing to
 * /login.
 *
 * ⚠️ 這裡**不做**「這個角色能不能看這個模組」的判斷。理由是 v3 那套踩過的坑：
 *    側欄把模組藏起來、RLS 沒擋，於是手打網址就繞過去了。這一版的規矩是每一支
 *    server fn 自己擋 —— 店員硬打 /admin/products 會看到一頁錯誤（因為它的
 *    loader 會被 adminFnMiddleware 擋下來），而不是一頁資料。側欄只負責不要
 *    給他一個一按就壞掉的連結。
 */
export const Route = createFileRoute("/admin/_shell")({
  beforeLoad: async () => {
    const { getCurrentBackOfficeUser } = await import("@/lib/admin/fns/auth");
    const user = await getCurrentBackOfficeUser();
    if (!user) {
      throw redirect({ to: "/admin/login" });
    }
    if (user.role === "pending") {
      throw redirect({ to: "/admin/pending" });
    }
    // `admin` 這個名字保留給既有的 15 個 route，它們都在讀 context.admin.email。
    return { admin: { userId: user.userId, email: user.email }, user };
  },
  head: () => ({ styles: backOfficeTypeScaleStyles() }),
  component: AdminShell,
});

/**
 * The sidebar, in four groups.
 *
 * Splitting what used to be one thirteen-item list is not decoration: the
 * groups are different systems with different sources of truth. 內容管理 edits
 * CMS tables, 電商 edits public.products and the orders that come out of it,
 * and 門市／進銷存 edits inv.* — the shop's real inventory, which came from a
 * separate application in migration 0009. Someone looking for "why does the
 * site say sold out" needs to know which of them to open, and a flat list does
 * not tell them.
 *
 * `staff: true` 的項目是店員看得到的。**這只是畫面** —— 每一支 server fn 自己
 * 會再擋一次，見檔頭。
 *
 * `permission` 是 staff 那一半的第二個條件：`staff: true, permission: "…"` 的意思
 * 是「店員只有拿到這個細權限才看得到這個連結」。admin 不受影響（他一律全有）。
 * 這一樣**只是畫面** —— 不加這個欄位的話，沒有權限的店員會看到一個一按就跳錯誤
 * 頁的連結，那不是漏洞，只是很難用。
 */
const NAV_GROUPS = [
  {
    label: "門市",
    items: [
      { to: "/admin/pos", label: "櫃檯結帳", icon: ScanLine, staff: true },
      { to: "/admin/sales", label: "銷售紀錄", icon: Receipt, staff: true },
      { to: "/admin/stock-alerts", label: "賣超告警", icon: TriangleAlert, staff: true },
    ],
  },
  {
    // 0035：「電商」搬到「內容管理」前面——訂單／報名是每天要盯的營運頁面，內容
    // 管理多半是上架前才動一次。群組內部的項目與各自的 staff/permission 一個字
    // 都沒動，純粹是這一個陣列裡兩個 group 物件的先後順序（NAV_GROUPS 沒有 sort
    // 欄位，順序就是畫面順序）。scripts/artists-selftest.mjs 只用群組標籤定位、
    // scripts/event-assembler-selftest.mjs 只抓扁平的 `to:` 清單，兩者都不看
    // group 的排列順序，換位置不會動到它們的斷言。
    label: "電商",
    items: [
      // 2026-10-20 起「商品」是單一頁：一般商品、地方刊物、選品、活動票券都在這裡，
      // 用頁內分頁切換（src/routes/admin/_shell.products.tsx）。原本「內容管理」組裡
      // 的「地方刊物展」與「選品」兩項因此拿掉，舊網址轉址到對應分頁。
      { to: "/admin/products", label: "商品", icon: Package, staff: false },
      // 訂單列表／詳情／標記已收款／刪除／封存（0034 的匯款付款方式；0035 加刪除
      // 與封存）。staff: false——這一頁看得到客人的姓名與遮罩後的聯絡方式，而且
      // 標記已收款／刪除／封存都動到錢或紀錄本身，src/lib/admin/fns/orders.ts
      // 每一支都掛 adminFnMiddleware，門市人員打不進來。這裡只是不要給他一個
      // 一按就跳錯誤頁的連結。
      { to: "/admin/orders", label: "訂單", icon: Landmark, staff: false },
      // 活動場次與報名名單（0020／0021；0035 加移除單筆報名）。名額搬離 products
      // 之後，「這場還剩幾個位子」只有這裡答得出來。
      //
      // 名單是第三人的個資，所以它不跟著 staff 一起放行，而是掛在 0021 §4 的
      // event.roster.read 上：一個負責活動現場的工讀生可以被授權看簽到表，而不必
      // 連帶拿到整個 CMS。admin 一律看得到（他全有）。移除報名比查看更敏感，掛的
      // 是 adminFnMiddleware（見 fns/event-registrations.ts 的
      // deleteAdminRegistration），店員看得到名單、但看不到移除按鈕能成功執行的
      // 權限——這裡的 staff/permission 一樣**只是畫面**。
      {
        to: "/admin/registrations",
        label: "活動報名",
        icon: ClipboardCheck,
        staff: true,
        permission: "event.roster.read" as const,
      },
    ],
  },
  {
    label: "內容管理",
    items: [
      { to: "/admin", label: "儀表板", icon: LayoutDashboard, staff: false },
      { to: "/admin/news", label: "最新消息", icon: Newspaper, staff: false },
      { to: "/admin/events", label: "活動", icon: CalendarDays, staff: false },
      // 講者（public.artists）緊接在活動後面，因為它就是活動的一部分：一場講座
      // 的主體是「誰來講」。放在內容管理而不是進銷存，是因為這一頁編的是門面
      // 資料 —— 同一張表的 vendor_id 那一半（統編、匯款）在「廠商」頁，
      // 那是另一個授權面，見 src/server/repos/artists.ts 檔頭。
      { to: "/admin/artists", label: "講者", icon: Mic, staff: false },
      // lucide's `Route` icon would collide with this file's `export const Route`.
      { to: "/admin/journeys", label: "策旅", icon: Tent, staff: false },
      { to: "/admin/collaborations", label: "合作", icon: Handshake, staff: false },
      { to: "/admin/categories", label: "活動分類", icon: Tags, staff: false },
      { to: "/admin/pages", label: "頁面文案", icon: FileText, staff: false },
    ],
  },
  {
    label: "進銷存",
    items: [
      // 商品主檔是店員每天用得最重的一塊，所以 staff: true。看得到不等於改得動：
      // 審核那幾顆按鈕還要 approve_products / approve_price_changes，而那是
      // lib/admin/fns/inv-products.ts 在 server 端擋的，不是這一行。
      { to: "/admin/inventory-products", label: "商品管理", icon: PackageSearch, staff: true },
      // 進貨、盤點、在庫異動同樣是店員每天的工作，所以 staff: true。看得到不等於
      // 改得動：審核那幾顆按鈕還要 approve_purchases / approve_stock_adjustments，
      // 而那是 lib/admin/fns/inv-purchases.ts 與 inv-adjustments.ts 在 server 端擋的。
      { to: "/admin/inventory-purchases", label: "進貨", icon: TruckIcon, staff: true },
      { to: "/admin/inventory-count", label: "庫存盤點", icon: ClipboardList, staff: true },
      {
        to: "/admin/inventory-adjustments",
        label: "在庫異動",
        icon: SlidersHorizontal,
        staff: true,
      },
      // 套餐同樣是店員每天的工作（櫃檯要賣），所以 staff: true。審核那兩顆按鈕還要
      // approve_combo_sets，而那是 lib/admin/fns/inv-combos.ts 在 server 端擋的。
      { to: "/admin/inventory-combos", label: "套餐", icon: Package2, staff: true },
      // 廠商同樣是店員每天的工作（進貨要選供應商、寄賣要對窗口），所以 staff: true。
      // 看得到不等於看得到全部：完整的身分證字號／統編／匯款帳號要
      // inv.vendor.pii.read，而那是 lib/admin/fns/inv-vendors.ts 在 server 端擋的，
      // 不是這一行。稽核軌跡那一頁再更嚴一級（要 admin）。
      { to: "/admin/inventory-vendors", label: "廠商", icon: Building2, staff: true },
      { to: "/admin/inventory-listing", label: "上架", icon: Boxes, staff: false },
    ],
  },
  {
    label: "站台設定",
    items: [
      { to: "/admin/settings", label: "全站設定", icon: Settings, staff: false },
      { to: "/admin/strings", label: "介面文字", icon: Type, staff: false },
      { to: "/admin/phones", label: "聯絡電話", icon: Phone, staff: false },
    ],
  },
  {
    label: "系統管理",
    items: [
      // 獨立成一組而不是塞進「站台設定」：那一組管的是網站內容長什麼樣
      // （site_settings／ui_strings／聯絡電話），這裡管的是「誰能用這個
      // 後台」——來源不一樣（public.profiles／public.staff_permissions，
      // 見 supabase/migrations/0033_admin_staff_management.sql），跟本檔
      // 開頭「不同系統分開成不同群組」的原則一致。
      //
      // staff: false —— 這一頁只有 admin 看得到連結。真正擋人的不是這一行，
      // 是 src/lib/admin/fns/staff-accounts.ts 每一支都掛的 adminFnMiddleware
      // （見 _shell.staff.tsx 檔頭）；這裡只是不要給店員一個一按就跳錯誤頁
      // 的連結。
      { to: "/admin/staff", label: "後台人員", icon: Users, staff: false },
    ],
  },
] as const;

const ROLE_LABEL: Record<string, string> = { admin: "管理員", staff: "門市人員" };

function AdminShell() {
  const { admin, user } = Route.useRouteContext();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const isAdmin = user.role === "admin";
  const groups = NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.filter((item) => {
      if (isAdmin) return true;
      if (!item.staff) return false;
      const needed = "permission" in item ? item.permission : null;
      return !needed || user.permissions.includes(needed);
    }),
  })).filter((group) => group.items.length > 0);

  async function handleSignOut() {
    await signOut();
    toast.success("已登出");
    await navigate({ to: "/admin/login" });
  }

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader className="px-3 py-3">
          <p className="text-sm font-medium leading-tight">小時光書店</p>
          <p className="text-xs leading-tight text-muted-foreground">管理後台</p>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      {/* 亮不亮由 isNavItemActive() 決定，不是 `pathname === item.to`。
                          完全相符的那個寫法在有子頁的模組（/admin/pages/$slug、
                          /admin/events/$id）會讓**整條側欄都不亮**；直接換成
                          startsWith 又會讓「儀表板」在每一個子頁跟著亮，因為 /admin
                          是所有後台網址的前綴。兩件事的處理都在那支純函式裡，
                          scripts/event-assembler-selftest.mjs 拿真的路徑餵它。 */}
                      <SidebarMenuButton
                        asChild
                        tooltip={item.label}
                        isActive={isNavItemActive(pathname, item.to)}
                      >
                        <Link to={item.to}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter className="gap-2 px-3 py-3">
          <p className="truncate text-xs text-muted-foreground">{admin.email}</p>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleSignOut}>
            <LogOut className="h-3.5 w-3.5" />
            登出
          </Button>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <SidebarTrigger />
          <p className="text-sm text-muted-foreground">管理後台</p>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
