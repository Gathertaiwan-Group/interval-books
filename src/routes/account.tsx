/**
 * /account —— 我的帳號：訂單 + 活動報名。
 *
 * beforeLoad 只決定畫面（未登入 → 導去登入頁），不是授權邊界——見
 * vendor/_shell.tsx 檔頭同一條規矩。真正擋著別人資料的是 fetchMyAccountData()
 * 掛的 customerFnMiddleware()（= requireCustomer()），與再往下一層、
 * server/repos/customer-orders.ts 那唯一的歸屬過濾。
 *
 * ⚠️ 這一頁**不**直接查 orders / event_registrations，一律經
 *    lib/customer-fns.ts 的 fetchMyAccountData()——它底下呼叫的是
 *    server/repos/customer-orders.ts 的 fetchMyOrders / fetchMyRegistrations，
 *    那是唯一的授權邊界（見那個檔案檔頭）。scripts/account-pages-selftest.mjs
 *    掃這個檔案守住這一條：只要這裡出現 supabaseAdmin 或
 *    `.from("orders"` / `.from("event_registrations"` 字樣就會變紅。
 */
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { CalendarDays, LogOut, PackageSearch, ShieldCheck } from "lucide-react";
import { PageShell, PageHeader } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import type { MyOrderSummary, MyRegistration } from "@/server/repos/customer-orders";
// 時間一律台北、輸出與執行環境無關：這頁是 SSR，伺服器（Vercel UTC）與瀏覽器印的字要一樣（見 lib/taipei-time.ts）
import { formatTaipeiDate, formatTaipeiDateTime } from "@/lib/taipei-time";

const META = {
  title: {
    zh: "我的帳號｜小時光書店",
    en: "My Account｜Interval Books",
    ja: "マイページ｜小時光書店",
  },
  description: {
    zh: "查看你在小時光書店的訂單與活動報名紀錄。",
    en: "View your orders and event registrations at Interval Books.",
    ja: "小時光書店でのご注文とイベント申込みの履歴をご確認いただけます。",
  },
};

const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "待處理",
  processing: "處理中",
  shipped: "已出貨",
  completed: "已完成",
  cancelled: "已取消",
};

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  unpaid: "未付款",
  paid: "已付款",
  refunded: "已退款",
};

export const Route = createFileRoute("/account")({
  beforeLoad: async () => {
    const { getCurrentCustomer } = await import("@/lib/customer-fns");
    const result = await getCurrentCustomer();
    if (result.state === "signed_out") throw redirect({ to: "/account/login" });
    return { customer: result.customer };
  },
  loader: async () => {
    const { fetchMyAccountData } = await import("@/lib/customer-fns");
    return { data: await fetchMyAccountData() };
  },
  head: () => ({
    meta: [
      { title: META.title.zh },
      { name: "description", content: META.description.zh },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountPage,
});

function AccountPage() {
  const { customer } = Route.useRouteContext();
  const { data } = Route.useLoaderData();
  const t = useT();
  const navigate = useNavigate();

  useDocumentMeta({ title: META.title, description: META.description });

  async function handleSignOut() {
    try {
      const { customerSignOut } = await import("@/lib/customer-fns");
      await customerSignOut();
      toast.success("已登出");
      await navigate({ to: "/account/login" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "登出失敗，請再試一次");
    }
  }

  return (
    <PageShell>
      <PageHeader eyebrow="Account" title="我的帳號" intro={customer.email} />
      <section className="container-editorial pb-32 space-y-12">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
            <Link to="/account/reset">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              修改密碼
            </Link>
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleSignOut}>
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            登出
          </Button>
        </div>

        <div>
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <PackageSearch className="h-5 w-5" aria-hidden="true" />
            我的訂單
          </h2>
          {data.orders.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">還沒有任何訂單。</p>
          ) : (
            <div className="mt-4 divide-y divide-border rounded-lg border border-border">
              {data.orders.map((o: MyOrderSummary) => (
                <div
                  key={o.orderNo}
                  className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"
                >
                  <div>
                    <p className="font-medium">{o.orderNo}</p>
                    <p className="text-muted-foreground">{formatTaipeiDate(o.createdAt)}</p>
                  </div>
                  <div className="text-right">
                    <p>
                      {ORDER_STATUS_LABEL[o.status] ?? o.status} ·{" "}
                      {PAYMENT_STATUS_LABEL[o.paymentStatus] ?? o.paymentStatus}
                    </p>
                    <p className="text-muted-foreground">NT$ {o.total.toLocaleString("en-US")}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="flex items-center gap-2 text-lg font-medium">
            <CalendarDays className="h-5 w-5" aria-hidden="true" />
            我的活動報名
          </h2>
          {data.registrations.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">還沒有任何活動報名。</p>
          ) : (
            <div className="mt-4 divide-y divide-border rounded-lg border border-border">
              {data.registrations.map((r: MyRegistration, i: number) => (
                <div
                  key={`${r.orderNo}-${r.seatNo}-${i}`}
                  className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"
                >
                  <div>
                    <p className="font-medium">{t(r.sessionTitle)}</p>
                    <p className="text-muted-foreground">
                      {r.name} · {t(r.sessionLocation)}
                    </p>
                  </div>
                  <div className="text-right text-muted-foreground">
                    <p>{formatTaipeiDateTime(r.startsAt)}</p>
                    <p>{r.orderNo}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </PageShell>
  );
}
