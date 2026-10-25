/**
 * /admin/collaborations/new —— 新增合作夥伴（2026-10-26 後台第 3 批：從列表裡的新增 Dialog 改成內頁）。
 *
 * loader 叫 listCollaborations（與列表同一支，GET，adminFnMiddleware）只為了算「新的排最前面」
 * 的排序數字（lib/admin/sort-order.ts）；30 秒內從列表點進來會直接沿用列表的快取。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CollaborationForm } from "@/components/admin/CollaborationForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";
import { newFirstSortOrder } from "@/lib/admin/sort-order";

export const Route = createFileRoute("/admin/_shell/collaborations_/new")({
  loader: async () => {
    const { listCollaborations } = await import("@/lib/admin/fns/collaborations");
    return { nextSortOrder: newFirstSortOrder(await listCollaborations()) };
  },
  head: () => ({ meta: [{ title: "新增合作｜小時光書店後台" }] }),
  component: CollaborationNewPage,
});

function CollaborationNewPage() {
  const { nextSortOrder } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  return (
    <CollaborationForm
      collaboration={null}
      nextSortOrder={nextSortOrder}
      onSaved={async () => {
        await router.invalidate({ sync: true });
        if (backIfPreviousIs(router.history, ["/admin/collaborations"])) return;
        await navigate({ to: "/admin/collaborations", replace: true });
      }}
    />
  );
}
