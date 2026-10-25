/**
 * /admin/inventory-products/$id —— 商品詳情（唯讀）＋異動紀錄。資料來自 layout 的 loader
 * （_shell.inventory-products_.$id.tsx），這一頁不另外抓。
 *
 * 動作：編輯（內頁）、調價（PriceChangeDialog，維持對話框）。審核、停用、刪除留在列表。
 *
 * ⚠️ 調價**送出**不需要 approve_price_changes（見 fns/inv-products.ts 的 requestPriceChange）；
 *    要不要進待審是資料庫算的，這裡的 priceApprovalOn 只影響提示文字。
 */
import { useState } from "react";
import { createFileRoute, getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { Package, Pencil, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdminDetailNotFound, AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { PriceChangeDialog } from "@/components/inventory/PriceChangeDialog";
import { ProductBadges, ProductDetailView } from "@/components/inventory/ProductDetailView";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";

const layout = getRouteApi("/admin/_shell/inventory-products_/$id");

export const Route = createFileRoute("/admin/_shell/inventory-products_/$id/")({
  component: ProductDetailPage,
});

function ProductDetailPage() {
  const { data } = layout.useLoaderData();
  const router = useRouter();
  const [pricing, setPricing] = useState(false);

  if (!data?.product) {
    return (
      <AdminDetailNotFound
        backTo="/admin/inventory-products"
        backLabel="回商品列表"
        message="找不到這件商品，可能已被刪除或網址有誤。"
      />
    );
  }
  const { product, movements, options } = data;
  const priceApprovalOn = isApprovalRequired(options.approvalSettings, "price_changes");

  return (
    <AdminDetailPage
      backTo="/admin/inventory-products"
      backLabel="回商品列表"
      width="lg"
      icon={<Package className="h-5 w-5" aria-hidden="true" />}
      title={product.name}
      meta={<ProductBadges product={product} />}
      actions={
        <>
          <Button variant="outline" className="gap-1.5" onClick={() => setPricing(true)}>
            <Tag className="h-4 w-4" />
            調價
          </Button>
          <Button asChild className="gap-1.5">
            <Link
              to="/admin/inventory-products/$id/edit"
              params={{ id: product.inv_product_id }}
              preload="intent"
            >
              <Pencil className="h-4 w-4" />
              編輯
            </Link>
          </Button>
        </>
      }
    >
      <ProductDetailView product={product} movements={movements} />

      <PriceChangeDialog
        open={pricing}
        onOpenChange={setPricing}
        product={pricing ? product : null}
        priceApprovalOn={priceApprovalOn}
        onDone={async () => {
          await router.invalidate({ sync: true });
        }}
      />
    </AdminDetailPage>
  );
}
