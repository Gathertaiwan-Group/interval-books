/**
 * /admin/inventory-products/new —— 新增商品（2026-10-25 從 ProductFormDialog 改成內頁）。
 *
 * 表單選項（分類、供應商、母品項候選、審核設定）由 loader 給，授權是
 * listProductFormOptions 的 staffFnMiddleware()（與列表的整頁 fn 相同）。
 * 拍照辨識的「改用手動輸入」也導到這一頁（辨識失敗時表單本來就是空的，沒有草稿要帶）。
 * 存檔成功 → 換成那件商品的詳情頁（replace：按上一頁回列表，不回空白表單）。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ProductForm } from "@/components/inventory/ProductForm";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";

export const Route = createFileRoute("/admin/_shell/inventory-products_/new")({
  loader: async () => {
    const { listProductFormOptions } = await import("@/lib/admin/fns/inv-products");
    return { options: await listProductFormOptions() };
  },
  head: () => ({ meta: [{ title: "新增商品｜小時光書店後台" }] }),
  component: ProductNewPage,
});

function ProductNewPage() {
  const { options } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  return (
    <ProductForm
      product={null}
      categories={options.categories}
      vendors={options.vendors}
      baseProducts={options.baseProducts}
      productApprovalOn={isApprovalRequired(options.approvalSettings, "products")}
      priceApprovalOn={isApprovalRequired(options.approvalSettings, "price_changes")}
      back={{ to: "/admin/inventory-products", label: "回商品列表" }}
      onSaved={async (productId) => {
        await router.invalidate({ sync: true });
        await navigate({
          to: "/admin/inventory-products/$id",
          params: { id: productId },
          replace: true,
        });
      }}
    />
  );
}
