/**
 * /admin/inventory-products/$id —— 商品內頁的 layout（2026-10-25 從彈窗改成內頁）。
 *
 * 詳情（index）與編輯（/edit）共用這一個 loader：getInventoryProductPageData 一支拿齊
 * 商品那一列、最近 50 筆異動紀錄與表單選項。「詳情 → 編輯」沿用 layout 的資料，不重抓。
 *
 * 授權：getInventoryProductPageData 掛 staffFnMiddleware()（與原本的 getAdminProduct、
 * listProductMovements、listProductFormOptions 相同，不帶細權限）。
 */
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ADMIN_DETAIL_PENDING, AdminDetailPending } from "@/components/admin/AdminDetailPage";
import { ProductBadges } from "@/components/inventory/ProductDetailView";
import { readAdminPeek } from "@/lib/admin/list-memory";
import { isUuid } from "@/lib/admin/order-labels";
import type { AdminProductRow } from "@/server/repos/inv-products";

export const Route = createFileRoute("/admin/_shell/inventory-products_/$id")({
  loader: async ({ params }) => {
    if (!isUuid(params.id)) return { data: null };
    const { getInventoryProductPageData } = await import("@/lib/admin/fns/inv-products");
    return { data: await getInventoryProductPageData({ data: { productId: params.id } }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.data?.product
          ? `${loaderData.data.product.name}｜商品管理｜小時光書店後台`
          : "商品管理｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: ProductPending,
  component: Outlet,
});

function ProductPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<AdminProductRow>("inv-product", id);
  return (
    <AdminDetailPending
      backTo="/admin/inventory-products"
      backLabel="回商品列表"
      width="lg"
      title={peek?.name}
      meta={peek ? <ProductBadges product={peek} /> : null}
    />
  );
}
