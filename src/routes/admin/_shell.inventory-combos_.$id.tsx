/**
 * /admin/inventory-combos/$id —— 套餐內頁的 layout（2026-10-25 從彈窗改成內頁）。
 *
 * 詳情（index）與編輯（/edit）共用這一個 loader：getInventoryComboPageData 一支拿齊套餐、
 * 組成品項、最近 50 筆銷售與表單選項。原本詳情彈窗打 getAdminComboSet ∥ listComboSales
 * （兩支、各驗一次身分），編輯彈窗又打一次 getAdminComboSet；現在開詳情只打這一支，
 * 「詳情 → 編輯」沿用同一份資料，不重抓。
 *
 * 授權：getInventoryComboPageData 掛 staffFnMiddleware()（與原本那三支相同）。
 * 審核的權限檢查仍在 approveComboSet 裡（重讀 staff_permissions），畫面上的按鈕只是畫面。
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ADMIN_DETAIL_PENDING, AdminDetailPending } from "@/components/admin/AdminDetailPage";
import { ComboSetBadges } from "@/components/inventory/ComboSetDetailView";
import { readAdminPeek } from "@/lib/admin/list-memory";
import { isUuid } from "@/lib/admin/order-labels";
import type { AdminComboSetRow } from "@/server/repos/inv-combos";

export const Route = createFileRoute("/admin/_shell/inventory-combos_/$id")({
  loader: async ({ params }) => {
    if (!isUuid(params.id)) return { data: null };
    const { getInventoryComboPageData } = await import("@/lib/admin/fns/inv-combos");
    return { data: await getInventoryComboPageData({ data: { comboSetId: params.id } }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.data?.set
          ? `${loaderData.data.set.name}｜套餐｜小時光書店後台`
          : "套餐｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: ComboSetPending,
  component: Outlet,
});

function ComboSetPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<AdminComboSetRow>("combo", id);
  return (
    <AdminDetailPending
      backTo="/admin/inventory-combos"
      backLabel="回套餐列表"
      width="md"
      title={peek?.name}
      meta={peek ? <ComboSetBadges row={peek} /> : null}
    />
  );
}
