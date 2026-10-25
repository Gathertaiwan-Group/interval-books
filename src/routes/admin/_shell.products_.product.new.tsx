/**
 * /admin/products/product/new —— 「新增商品 › 一般商品」的精簡表單。
 *
 * 2026-10-25 從 /admin/products 的新增彈窗改成內頁。表單與 payload 沒變：
 * NewGoodsForm → unified-products.ts#buildNewGoodsPayload → fns/products.ts#upsertProduct。
 *
 * loader 只叫 getNewGoodsPageData（adminFnMiddleware，與 upsertProduct 相同），拿
 * 「下一個排序值」——原本是商品頁拿記憶體裡整份 products 算的同一條規則。
 * 存檔成功 → 回列表的「一般商品」分頁（從列表點進來就是按上一頁）。
 */
import { createFileRoute } from "@tanstack/react-router";
import { NewGoodsForm, type NewGoodsValues } from "@/components/admin/products/NewGoodsForm";
import { ProductFormPage } from "@/components/admin/products/ProductFormPage";
import { buildNewGoodsPayload, slugFromTitle } from "@/lib/admin/unified-products";

export const Route = createFileRoute("/admin/_shell/products_/product/new")({
  loader: async () => {
    const { getNewGoodsPageData } = await import("@/lib/admin/fns/products");
    return await getNewGoodsPageData();
  },
  head: () => ({ meta: [{ title: "新增商品｜小時光書店後台" }] }),
  component: NewGoodsPage,
});

function NewGoodsPage() {
  const { nextSortOrder } = Route.useLoaderData();

  return (
    <ProductFormPage<NewGoodsValues>
      formId="new-goods-form"
      title="新增一般商品"
      meta="只填開賣需要的幾格；長說明、原價、網址代稱之後在「編輯」補。"
      backTo="/admin/products"
      backSearch={{ type: "goods" }}
      backLabel="回商品列表"
      submitLabel="建立商品"
      successMessage="已新增商品"
      save={async (values) => {
        // 亂數尾巴只是避免代稱撞名；之後在「編輯」裡可以改成好記的代稱。
        const suffix = Math.random().toString(36).slice(2, 7);
        const payload = buildNewGoodsPayload({
          ...values,
          slug: slugFromTitle(values.title.en, suffix),
          sort_order: nextSortOrder,
        });
        const { upsertProduct } = await import("@/lib/admin/fns/products");
        await upsertProduct({ data: payload });
      }}
    >
      {(slot) => (
        <NewGoodsForm
          formId={slot.formId}
          onSubmit={slot.onSubmit}
          submitting={slot.submitting}
          onDirtyChange={slot.onDirtyChange}
        />
      )}
    </ProductFormPage>
  );
}
