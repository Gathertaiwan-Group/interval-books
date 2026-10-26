/**
 * /admin/registrations/$sessionId —— 一個場次的報名名單（2026-10-25 從名單彈窗改成內頁）。
 *
 * 標題由 layout 的 loader 畫出來；名單由這個 route 自己的 loader 讀（listSessionRoster）。
 * 業主 2026-10-26 撤掉「每打開一次寫一筆查看紀錄」之後，名單就是一般的只讀資料：跟其他
 * 後台頁一樣走 30 秒快取（src/lib/admin/route-cache.ts）、列表滑過「名單」就預載；移除
 * 報名之後 router.invalidate() 重抓。/edit 不經過這裡，不會順便讀名單。
 *
 * 授權仍在 server fn：staffFnMiddleware ＋ requireRosterRead（event.roster.read）。
 */
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { AdminDetailNotFound } from "@/components/admin/AdminDetailPage";
import { SessionRosterPage } from "@/components/admin/SessionRosterPage";
import { isUuid } from "@/lib/admin/order-labels";

const layout = getRouteApi("/admin/_shell/registrations_/$sessionId");

export const Route = createFileRoute("/admin/_shell/registrations_/$sessionId/")({
  loader: async ({ params }) => {
    if (!isUuid(params.sessionId)) return { roster: null, rosterError: null };
    const { listSessionRoster } = await import("@/lib/admin/fns/event-registrations");
    try {
      return {
        roster: await listSessionRoster({ data: { sessionId: params.sessionId } }),
        rosterError: null,
      };
    } catch (err) {
      // 標題（layout loader）照樣畫得出來，名單那一塊顯示錯誤——與原本頁內載入時一樣。
      return {
        roster: null,
        rosterError: err instanceof Error ? err.message : "名單讀取失敗",
      };
    }
  },
  component: SessionRosterRoute,
});

function SessionRosterRoute() {
  const { data } = layout.useLoaderData();
  const { user } = layout.useRouteContext();
  const { roster, rosterError } = Route.useLoaderData();

  if (!data?.session) {
    return (
      <AdminDetailNotFound
        backTo="/admin/registrations"
        backLabel="回場次列表"
        message="找不到這個場次，可能已被刪除或網址有誤。"
      />
    );
  }

  return (
    <SessionRosterPage
      key={data.session.id}
      session={data.session}
      product={data.products.find((p) => p.id === data.session?.product_id)}
      roster={roster}
      rosterError={rosterError}
      // ⚠️ 只控制畫面。真正擋住直接呼叫 /_serverFn/… 的是 fns 那一層的
      //    requireRosterRead()，而它是從 staff_permissions 重讀出來的。
      canReadRoster={user.permissions.includes("event.roster.read")}
    />
  );
}
