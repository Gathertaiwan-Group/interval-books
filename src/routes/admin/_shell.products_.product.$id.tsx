/**
 * /admin/products/product/$id —— 一般商品（與沒有活動頁可去的票券，例如策旅）的完整編輯表單。
 *
 * 2026-10-25 從 /admin/products 的編輯彈窗改成內頁（業主：「不要用彈窗，直接顯示內頁＆
 * 回到上一頁」）。欄位與寫入路徑沒變：ProductForm → fns/products.ts#upsertProduct。
 *
 * loader 只叫一支 getProductEditPageData（adminFnMiddleware，與 upsertProduct 相同），
 * 只抓這一件商品；原本彈窗用的是整頁 loader 在記憶體裡的那一列。
 *
 * ⚠️ 活動商品（source_type='event' 且有 source_id）是活動編輯頁投影出來的（0026／0029），
 *    清單上本來就只給「到活動頁編輯」。有人直接打這個網址也一樣轉去 /admin/events/$id，
 *    不在這裡另開一條會與活動頁互相覆蓋的編輯路徑。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { ProductForm } from "@/components/admin/products/ProductForm";
import { ProductFormPage } from "@/components/admin/products/ProductFormPage";
import { toFormValues } from "@/components/admin/products/form-values";
import { readAdminPeek } from "@/lib/admin/list-memory";
import { isProductTextId, PRODUCT_PEEK_KIND, type UnifiedRow } from "@/lib/admin/unified-products";
import type { ProductFormValues } from "@/lib/admin/schemas";

export const Route = createFileRoute("/admin/_shell/products_/product/$id")({
  loader: async ({ params }) => {
    if (!isProductTextId(params.id)) return { product: null };
    const { getProductEditPageData } = await import("@/lib/admin/fns/products");
    const { product } = await getProductEditPageData({ data: { id: params.id } });
    if (product?.source_type === "event" && product.source_id) {
      throw redirect({ to: "/admin/events/$id", params: { id: product.source_id } });
    }
    return { product };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.product
          ? `編輯「${loaderData.product.title.zh}」｜商品｜小時光書店後台`
          : "編輯商品｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: ProductEditPending,
  component: ProductEditPage,
});

/** 商品類型 → 回列表時的分頁籤（票券在「活動票券」、其餘在「一般商品」）。 */
function tabFor(type: ProductFormValues["product_type"] | undefined) {
  return type === "event" || type === "journey" ? "ticket" : "goods";
}

function ProductEditPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<UnifiedRow>(PRODUCT_PEEK_KIND, `product:${id}`);
  return (
    <AdminDetailPending
      backTo="/admin/products"
      backSearch={{ type: peek?.kind ?? "goods" }}
      backLabel="回商品列表"
      title={peek ? `編輯「${peek.name}」` : undefined}
    />
  );
}

function ProductEditPage() {
  const { product } = Route.useLoaderData();

  if (!product) {
    return (
      <AdminDetailNotFound
        backTo="/admin/products"
        backLabel="回商品列表"
        message="找不到這件商品，可能已被刪除或網址有誤。"
      />
    );
  }

  return (
    <ProductFormPage<ProductFormValues>
      // 換一件商品＝重新掛載，表單不會跨商品殘留。
      key={product.id}
      formId="product-edit-form"
      title={`編輯「${product.title.zh}」`}
      meta="中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。"
      backTo="/admin/products"
      backSearch={{ type: tabFor(product.product_type) }}
      backLabel="回商品列表"
      submitLabel="儲存變更"
      successMessage="已更新商品"
      save={async (values) => {
        const { upsertProduct } = await import("@/lib/admin/fns/products");
        await upsertProduct({ data: { ...values, id: product.id } });
      }}
    >
      {(slot) => (
        <ProductForm
          formId={slot.formId}
          // 只在掛載時填一次：存檔後 invalidate 重跑 loader 不會蓋掉打到一半的欄位。
          defaultValues={toFormValues(product)}
          onSubmit={slot.onSubmit}
          onDirtyChange={slot.onDirtyChange}
        />
      )}
    </ProductFormPage>
  );
}
