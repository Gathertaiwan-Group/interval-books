/**
 * /admin/inventory-products/$id/edit —— 編輯商品（2026-10-25 從 ProductFormDialog 改成內頁）。
 *
 * 資料來自 layout 的 loader（與詳情頁共用，「詳情 → 編輯」不重抓）。表單只在掛載時從
 * loader 填一次，loader 之後重跑不會蓋掉打到一半的欄位；有未存的變更時離開會先問
 * （ProductForm 裡的 useUnsavedChangesGuard）。
 * 存檔成功 → 從詳情或列表進來就按上一頁回原處，否則換成詳情頁（replace）。
 */
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { AdminDetailNotFound } from "@/components/admin/AdminDetailPage";
import { ProductForm } from "@/components/inventory/ProductForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";

const layout = getRouteApi("/admin/_shell/inventory-products_/$id");

export const Route = createFileRoute("/admin/_shell/inventory-products_/$id/edit")({
  component: ProductEditPage,
});

function ProductEditPage() {
  const { data } = layout.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  if (!data?.product) {
    return (
      <AdminDetailNotFound
        backTo="/admin/inventory-products"
        backLabel="回商品列表"
        message="找不到這件商品，可能已被刪除或網址有誤。"
      />
    );
  }
  const { product, options } = data;
  const detailPath = `/admin/inventory-products/${product.inv_product_id}`;

  return (
    <ProductForm
      // 換一件商品＝重新掛載，表單不會跨商品殘留。
      key={product.inv_product_id}
      product={product}
      categories={options.categories}
      vendors={options.vendors}
      baseProducts={options.baseProducts}
      productApprovalOn={isApprovalRequired(options.approvalSettings, "products")}
      priceApprovalOn={isApprovalRequired(options.approvalSettings, "price_changes")}
      back={{ to: detailPath, label: "返回", also: ["/admin/inventory-products"] }}
      onSaved={async (productId) => {
        await router.invalidate({ sync: true });
        // 從詳情頁或列表進來 → 按上一頁回原處（歷史紀錄不多一筆）；否則換成詳情頁。
        if (backIfPreviousIs(router.history, [detailPath, "/admin/inventory-products"])) return;
        await navigate({
          to: "/admin/inventory-products/$id",
          params: { id: productId },
          replace: true,
        });
      }}
    />
  );
}
