/**
 * /admin/inventory-vendors/$id —— 廠商內頁的 layout（2026-10-25 從彈窗改成內頁）。
 *
 * 詳情（index）與編輯（/edit）共用這一個 loader：getInventoryVendorPageData 一支拿齊
 * 清單那一列、詳情、三張子表與表單選項。原本詳情彈窗與編輯彈窗各打一次 getAdminVendor，
 * 「詳情 → 編輯」等於同一家廠商抓兩次；現在 layout 的資料在兩頁之間沿用，不重抓。
 *
 * 授權：getInventoryVendorPageData 掛 staffFnMiddleware()（與原本的 getAdminVendor 相同）。
 * 識別碼一律只有遮罩，完整號碼只有 VendorSensitiveDialog → readVendorSensitive() 一條路。
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ADMIN_DETAIL_PENDING, AdminDetailPending } from "@/components/admin/AdminDetailPage";
import { VendorBadges } from "@/components/inventory/VendorDetailView";
import { readAdminPeek } from "@/lib/admin/list-memory";
import { isUuid } from "@/lib/admin/order-labels";
import type { AdminVendorRow } from "@/server/repos/inv-vendors";

export const Route = createFileRoute("/admin/_shell/inventory-vendors_/$id")({
  loader: async ({ params }) => {
    if (!isUuid(params.id)) return { data: null };
    const { getInventoryVendorPageData } = await import("@/lib/admin/fns/inv-vendors");
    return { data: await getInventoryVendorPageData({ data: { vendorId: params.id } }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.data?.row
          ? `${loaderData.data.row.name}｜廠商｜小時光書店後台`
          : "廠商｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: VendorPending,
  component: Outlet,
});

function VendorPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<AdminVendorRow>("vendor", id);
  return (
    <AdminDetailPending
      backTo="/admin/inventory-vendors"
      backLabel="回廠商列表"
      width="lg"
      title={peek?.name}
      meta={peek ? <VendorBadges row={peek} /> : null}
    />
  );
}
