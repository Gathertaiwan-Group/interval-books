/**
 * /admin/collaborations/$id —— 編輯合作夥伴（2026-10-26 後台第 3 批：從列表裡的編輯 Dialog 改成內頁）。
 *
 * loader 只叫一支 getCollaborationById（GET，adminFnMiddleware —— 與列表的 listCollaborations、
 * 寫入的 upsertCollaboration 相同）。存檔成功 → allowLeave → invalidate → 從列表進來就按上一頁
 * 回列表，否則 replace 到列表。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { CollaborationForm } from "@/components/admin/CollaborationForm";
import { backIfPreviousIs, TEXT_ROW_ID } from "@/lib/admin/detail-nav";
import { readAdminPeek } from "@/lib/admin/list-memory";
import type { CollaborationRow } from "@/server/repos/collaborations";

export const Route = createFileRoute("/admin/_shell/collaborations_/$id")({
  loader: async ({ params }) => {
    if (!TEXT_ROW_ID.test(params.id)) return { collaboration: null };
    const { getCollaborationById } = await import("@/lib/admin/fns/collaborations");
    return { collaboration: await getCollaborationById({ data: { id: params.id } }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.collaboration
          ? `編輯合作：${loaderData.collaboration.title.zh}｜小時光書店後台`
          : "合作｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: CollaborationPending,
  component: CollaborationEditPage,
});

function CollaborationPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<CollaborationRow>("collaboration", id);
  return (
    <AdminDetailPending
      backTo="/admin/collaborations"
      backLabel="回合作列表"
      title={peek ? `編輯合作：${peek.title.zh}` : undefined}
    />
  );
}

function CollaborationEditPage() {
  const { collaboration } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  if (!collaboration) {
    return (
      <AdminDetailNotFound
        backTo="/admin/collaborations"
        backLabel="回合作列表"
        message="找不到這個合作夥伴，可能已被刪除或網址有誤。"
      />
    );
  }

  return (
    <CollaborationForm
      key={collaboration.id}
      collaboration={collaboration}
      onSaved={async () => {
        await router.invalidate({ sync: true });
        if (backIfPreviousIs(router.history, ["/admin/collaborations"])) return;
        await navigate({ to: "/admin/collaborations", replace: true });
      }}
    />
  );
}
