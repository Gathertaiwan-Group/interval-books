/**
 * /admin/products/curated/new —— 新增一項選品。
 *
 * 2026-10-25 從兩個新增彈窗改成這一個內頁：/admin/products「新增商品 › 選品」（要先選主題）
 * 與 /admin/products/curated-themes 某個主題底下的「新增品項」（帶 ?theme=，主題先選好）。
 * 寫入路徑沒變：CuratedItemForm → fns/curated.ts#upsertCuratedItem。
 *
 * loader 只叫 getCuratedItemNewPageData（adminFnMiddleware，與 upsertCuratedItem 相同）：
 * 主題清單＋各品項的 (theme_id, sort_order)。sort_order 在送出時依「選的那個主題」算
 * （unified-products.ts#nextCuratedSortOrder，unique(theme_id, sort_order)）。
 *
 * 發布狀態的預設值沿用兩個舊彈窗各自的行為：從商品頁新增 → 草稿；從主題頁（?theme=）
 * 新增 → 已發布（主題頁原本的品項表單預設就是 true）。
 */
import { createFileRoute } from "@tanstack/react-router";
import { CuratedItemForm } from "@/components/admin/products/CuratedItemForm";
import { ProductFormPage } from "@/components/admin/products/ProductFormPage";
import { nextCuratedSortOrder } from "@/lib/admin/unified-products";
import type { CuratedItemFormValues } from "@/lib/admin/schemas";

export const Route = createFileRoute("/admin/_shell/products_/curated/new")({
  validateSearch: (search: Record<string, unknown>): { theme?: string } =>
    typeof search.theme === "string" && search.theme.trim() ? { theme: search.theme } : {},
  loader: async () => {
    const { getCuratedItemNewPageData } = await import("@/lib/admin/fns/products");
    return await getCuratedItemNewPageData();
  },
  head: () => ({ meta: [{ title: "新增選品｜小時光書店後台" }] }),
  component: CuratedNewPage,
});

function CuratedNewPage() {
  const { themes, itemOrders, linkSupported, linkOptions } = Route.useLoaderData();
  const { theme } = Route.useSearch();
  const fromThemes = theme !== undefined && themes.some((t) => t.id === theme);

  return (
    <ProductFormPage<CuratedItemFormValues>
      formId="curated-new-form"
      title="新增選品"
      meta="沒連結商品就只展示；連了商品，首頁那一排會優先放它。"
      backTo="/admin/products"
      backSearch={{ type: "curated" }}
      backAlso={["/admin/products/curated-themes"]}
      backLabel="回選品列表"
      submitLabel="建立選品"
      successMessage="已新增選品"
      save={async (values) => {
        const { upsertCuratedItem } = await import("@/lib/admin/fns/curated");
        await upsertCuratedItem({
          data: {
            ...values,
            id: undefined,
            sort_order: nextCuratedSortOrder(itemOrders, values.theme_id),
          },
        });
      }}
    >
      {(slot) =>
        themes.length === 0 ? (
          <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
            還沒有任何選品主題。請先到「主題與排序」頁新增一個主題。
          </p>
        ) : (
          <CuratedItemForm
            formId={slot.formId}
            defaultValues={{
              theme_id: fromThemes ? (theme as string) : (themes[0]?.id ?? ""),
              name: { zh: "", en: "", ja: "" },
              note: { zh: "", en: "", ja: "" },
              is_published: fromThemes,
              sort_order: 0,
              product_id: null,
            }}
            themes={themes}
            linkOptions={linkOptions}
            linkSupported={linkSupported}
            onSubmit={slot.onSubmit}
            onDirtyChange={slot.onDirtyChange}
          />
        )
      }
    </ProductFormPage>
  );
}
