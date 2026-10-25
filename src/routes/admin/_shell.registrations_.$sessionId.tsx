/**
 * /admin/registrations/$sessionId —— 場次內頁的 layout（2026-10-25 後台第 2 批：名單與編輯
 * 從彈窗改成內頁）。
 *
 * 名單頁（index）與編輯頁（/edit）共用這一個 loader：getEventSessionPageData 一支拿齊場次、
 * 活動商品、這個場次的票種。「名單 → 編輯場次」不重抓。
 *
 * 授權：getEventSessionPageData 掛 staffFnMiddleware() ＋ event.roster.read，與原本彈窗的
 * 資料來源 getAdminRegistrationsPageData 相同。
 *
 * 🔴 這個 loader **只有場次的非個資資訊**。名單（listSessionRoster，每呼叫一次寫一筆
 *    pii_access_log）不可以放進來：loader 會在預載、過期重抓、每次 invalidate 時重跑。
 *    名單在 SessionRosterPage 掛載時呼叫一次；列表連到名單頁的 Link 是 preload={false}。
 *    scripts/admin-detail-registrations-selftest.mjs 守著。
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ADMIN_DETAIL_PENDING, AdminDetailPending } from "@/components/admin/AdminDetailPage";
import type { SessionRow } from "@/components/admin/SessionForm";
import { readAdminPeek } from "@/lib/admin/list-memory";
import { isUuid } from "@/lib/admin/order-labels";
import { formatTaipeiDateTime } from "@/lib/taipei-time";

export const Route = createFileRoute("/admin/_shell/registrations_/$sessionId")({
  loader: async ({ params }) => {
    if (!isUuid(params.sessionId)) return { data: null };
    const { getEventSessionPageData } = await import("@/lib/admin/fns/event-sessions");
    return { data: await getEventSessionPageData({ data: { sessionId: params.sessionId } }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.data?.session
          ? `${loaderData.data.session.title.zh}｜活動報名｜小時光書店後台`
          : "活動報名｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: SessionPending,
  component: Outlet,
});

function SessionPending() {
  const { sessionId } = Route.useParams();
  const peek = readAdminPeek<SessionRow>("event-session", sessionId);
  return (
    <AdminDetailPending
      backTo="/admin/registrations"
      backLabel="回場次列表"
      width="xl"
      title={peek?.title.zh}
      meta={peek ? formatTaipeiDateTime(peek.starts_at) : null}
    />
  );
}
