/**
 * /admin/products/curated/$id —— 選品一項（名稱、備註三語、發布狀態、連結商品〔0041〕）。
 *
 * 2026-10-25 從兩個彈窗改成這一個內頁（業主：「不要用彈窗，直接顯示內頁＆回到上一頁」）：
 * /admin/products 選品分頁的「編輯」，與 /admin/products/curated-themes 主題頁品項的
 * 「編輯」都連到這裡。表單與寫入路徑沒變：CuratedItemForm → fns/curated.ts#upsertCuratedItem。
 *
 * loader 只叫 getCuratedItemEditPageData（adminFnMiddleware，與 upsertCuratedItem 相同）。
 * 「← 回到…」與存檔後：從哪一頁進來就按上一頁回哪一頁（商品列表或主題頁）。
 *
 * ⚠️ 編輯不給換主題（CuratedItemForm 不傳 themes）：換主題要連 sort_order 一起換
 *    （unique(theme_id, sort_order)），而 upsertCuratedItem 的更新分支刻意不寫 sort_order。
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { CuratedItemForm } from "@/components/admin/products/CuratedItemForm";
import { ProductFormPage } from "@/components/admin/products/ProductFormPage";
import { toCuratedValues } from "@/components/admin/products/form-values";
import { readAdminPeek } from "@/lib/admin/list-memory";
import {
  parseCuratedItemId,
  PRODUCT_PEEK_KIND,
  type UnifiedRow,
} from "@/lib/admin/unified-products";
import type { CuratedItemFormValues } from "@/lib/admin/schemas";

export const Route = createFileRoute("/admin/_shell/products_/curated/$id")({
  loader: async ({ params }) => {
    const id = parseCuratedItemId(params.id);
    if (id === null) return { item: null, themeTitle: null, linkSupported: false, linkOptions: [] };
    const { getCuratedItemEditPageData } = await import("@/lib/admin/fns/products");
    return await getCuratedItemEditPageData({ data: { id } });
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.item
          ? `編輯選品「${loaderData.item.name.zh}」｜小時光書店後台`
          : "編輯選品｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: CuratedEditPending,
  component: CuratedEditPage,
});

const BACK = {
  backTo: "/admin/products",
  backSearch: { type: "curated" },
  backAlso: ["/admin/products/curated-themes"],
  backLabel: "回選品列表",
} as const;

function CuratedEditPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<Pick<UnifiedRow, "name" | "subtitle">>(
    PRODUCT_PEEK_KIND,
    `curated:${id}`,
  );
  return (
    <AdminDetailPending
      {...BACK}
      title={peek ? `編輯選品「${peek.name}」` : undefined}
      meta={peek?.subtitle}
    />
  );
}

function CuratedEditPage() {
  const { item, themeTitle, linkSupported, linkOptions } = Route.useLoaderData();

  if (!item) {
    return <AdminDetailNotFound {...BACK} message="找不到這個選品，可能已被刪除或網址有誤。" />;
  }

  return (
    <ProductFormPage<CuratedItemFormValues>
      key={item.id}
      formId="curated-edit-form"
      title={`編輯選品「${item.name.zh}」`}
      meta={
        <>
          {themeTitle ? `主題：${themeTitle}・` : ""}
          連結商品之後，首頁那一排會優先放它、/shop
          選品卡可以直接買；沒連結就只展示。主題本身與排序在「主題與排序」頁調整。
        </>
      }
      {...BACK}
      submitLabel="儲存變更"
      successMessage="已更新選品"
      save={async (values) => {
        const { upsertCuratedItem } = await import("@/lib/admin/fns/curated");
        await upsertCuratedItem({ data: { ...values, id: item.id } });
      }}
    >
      {(slot) => (
        <CuratedItemForm
          formId={slot.formId}
          // 只在掛載時填一次。不傳 themes：編輯不給換主題（理由見檔頭）。
          defaultValues={toCuratedValues(item)}
          onSubmit={slot.onSubmit}
          onDirtyChange={slot.onDirtyChange}
          linkOptions={linkOptions}
          linkSupported={linkSupported}
        />
      )}
    </ProductFormPage>
  );
}
