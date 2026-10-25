/**
 * /admin/products/publication/$id —— 地方刊物校稿（刊名、製作單位、介紹三語、封面…）。
 *
 * 2026-10-25 從 /admin/products 的編輯彈窗改成內頁（業主：「不要用彈窗，直接顯示內頁＆
 * 回到上一頁」）。表單與寫入路徑沒變：PublicationForm → fns/publications.ts#updatePublication。
 *
 * loader 只叫 getPublicationEditPageData（adminFnMiddleware，與 updatePublication 相同），
 * 只抓這一本。售價在清單上直接改；「連到庫存商品／解除連結」是上架動作，留在清單的對話框。
 * 地方刊物是匯入的固定集合（126 本），沒有「新增」頁。
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { PublicationForm } from "@/components/admin/products/PublicationForms";
import { ProductFormPage } from "@/components/admin/products/ProductFormPage";
import { readAdminPeek } from "@/lib/admin/list-memory";
import { isProductTextId, PRODUCT_PEEK_KIND, type UnifiedRow } from "@/lib/admin/unified-products";
import type { PublicationFormValues } from "@/lib/admin/schemas";

export const Route = createFileRoute("/admin/_shell/products_/publication/$id")({
  loader: async ({ params }) => {
    if (!isProductTextId(params.id)) return { publication: null };
    const { getPublicationEditPageData } = await import("@/lib/admin/fns/products");
    return await getPublicationEditPageData({ data: { id: params.id } });
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.publication
          ? `編輯「${loaderData.publication.title.zh}」｜地方刊物｜小時光書店後台`
          : "編輯地方刊物｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: PublicationEditPending,
  component: PublicationEditPage,
});

const BACK = { backTo: "/admin/products", backSearch: { type: "publication" } } as const;

function PublicationEditPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<UnifiedRow>(PRODUCT_PEEK_KIND, `publication:${id}`);
  return (
    <AdminDetailPending
      {...BACK}
      backLabel="回地方刊物"
      title={peek ? `編輯「${peek.name}」` : undefined}
      meta={peek?.subtitle}
    />
  );
}

function PublicationEditPage() {
  const { publication } = Route.useLoaderData();

  if (!publication) {
    return (
      <AdminDetailNotFound
        {...BACK}
        backLabel="回地方刊物"
        message="找不到這本刊物，可能網址有誤。"
      />
    );
  }

  return (
    <ProductFormPage<PublicationFormValues>
      key={publication.id}
      formId="publication-edit-form"
      title={`編輯「${publication.title.zh}」`}
      meta={
        <>
          刊名、製作單位與介紹都是三語，缺一語前台那一語就會是空白。代稱與原始序號不開放修改——
          它們是回頭對照原始清單的憑據。
          {publication.product_id ? " 售價在清單上直接改。" : ""}
        </>
      }
      {...BACK}
      backLabel="回地方刊物"
      submitLabel="儲存"
      successMessage="已儲存"
      save={async (values) => {
        const { updatePublication } = await import("@/lib/admin/fns/publications");
        await updatePublication({ data: values });
      }}
    >
      {(slot) => (
        <PublicationForm
          formId={slot.formId}
          // 只在掛載時填一次：存檔後 invalidate 重跑 loader 不會蓋掉打到一半的欄位。
          publication={publication}
          onSubmit={slot.onSubmit}
          submitting={slot.submitting}
          onDirtyChange={slot.onDirtyChange}
        />
      )}
    </ProductFormPage>
  );
}
