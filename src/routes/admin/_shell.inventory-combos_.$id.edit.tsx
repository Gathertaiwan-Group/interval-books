/**
 * /admin/inventory-combos/$id/edit —— 編輯套餐（2026-10-25 從 ComboSetFormDialog 改成內頁）。
 *
 * 套餐本身來自 layout 的 loader（與詳情頁共用，「詳情 → 編輯」不重抓套餐）；可選商品清單
 * （約 496 KB，只有表單要用）由這一頁自己的 loader 叫 listComboFormOptions（staffFnMiddleware，
 * GET，滑過「編輯」就預載）。表單只在掛載時從
 * loader 填一次；有未存的變更時離開會先問（ComboSetForm 裡的 useUnsavedChangesGuard）。
 * 存檔成功 → 回詳情頁（寫入後 src/start.ts 已清掉列表快取；這裡再 invalidate 一次）。
 */
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { AdminDetailNotFound } from "@/components/admin/AdminDetailPage";
import { ComboSetForm } from "@/components/inventory/ComboSetForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";

const layout = getRouteApi("/admin/_shell/inventory-combos_/$id");

export const Route = createFileRoute("/admin/_shell/inventory-combos_/$id/edit")({
  loader: async () => {
    const { listComboFormOptions } = await import("@/lib/admin/fns/inv-combos");
    return { options: await listComboFormOptions() };
  },
  component: ComboSetEditPage,
});

function ComboSetEditPage() {
  const { data } = layout.useLoaderData();
  const { options } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  if (!data?.set) {
    return (
      <AdminDetailNotFound
        backTo="/admin/inventory-combos"
        backLabel="回套餐列表"
        message="找不到這個套餐，可能已被刪除或網址有誤。"
      />
    );
  }

  return (
    <ComboSetForm
      // 換一個套餐＝重新掛載，表單不會跨套餐殘留。
      key={data.set.combo_set_id}
      approvalOn={isApprovalRequired(data.approvalSettings, "combo_sets")}
      editing={data.set}
      initialItems={data.items}
      products={options.products}
      back={{
        to: `/admin/inventory-combos/${data.set.combo_set_id}`,
        label: "返回",
        also: ["/admin/inventory-combos"],
      }}
      onSaved={async (comboSetId) => {
        await router.invalidate({ sync: true });
        // 從詳情頁進來 → 按上一頁回詳情（歷史紀錄不多一筆）；否則換成詳情頁。
        if (backIfPreviousIs(router.history, [`/admin/inventory-combos/${comboSetId}`])) return;
        await navigate({
          to: "/admin/inventory-combos/$id",
          params: { id: comboSetId },
          replace: true,
        });
      }}
    />
  );
}
