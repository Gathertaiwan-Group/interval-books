/**
 * /admin/registrations/$sessionId —— 一個場次的報名名單（2026-10-25 從名單彈窗改成內頁）。
 *
 * 標題由 layout 的 loader 立刻畫出來；名單在 SessionRosterPage 掛載時才讀（每次打開寫一筆
 * pii_access_log，理由見那個檔頭與 layout 的檔頭）。key={sessionId}：換一個場次＝重新掛載＝
 * 新的一筆紀錄；同一頁 router.invalidate()（移除報名之後）不會重新掛載、不會再讀一次名單。
 */
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { AdminDetailNotFound } from "@/components/admin/AdminDetailPage";
import { SessionRosterPage } from "@/components/admin/SessionRosterPage";

const layout = getRouteApi("/admin/_shell/registrations_/$sessionId");

export const Route = createFileRoute("/admin/_shell/registrations_/$sessionId/")({
  component: SessionRosterRoute,
});

function SessionRosterRoute() {
  const { data } = layout.useLoaderData();
  const { user } = layout.useRouteContext();

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
      // ⚠️ 只控制畫面。真正擋住直接 POST /_serverFn/… 的是 fns 那一層的
      //    requireRosterRead()，而它是從 staff_permissions 重讀出來的。
      canReadRoster={user.permissions.includes("event.roster.read")}
    />
  );
}
