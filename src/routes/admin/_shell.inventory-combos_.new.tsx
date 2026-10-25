/**
 * /admin/inventory-combos/new —— 新增套餐（2026-10-25 從 ComboSetFormDialog 改成內頁）。
 *
 * 表單選項（可選商品、審核設定）由 loader 給，授權是 listComboFormOptions 的
 * staffFnMiddleware()。存檔成功 → 換成那個套餐的詳情頁（replace：按上一頁回列表，不回空白表單）。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ComboSetForm } from "@/components/inventory/ComboSetForm";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";

export const Route = createFileRoute("/admin/_shell/inventory-combos_/new")({
  loader: async () => {
    const { listComboFormOptions } = await import("@/lib/admin/fns/inv-combos");
    return { options: await listComboFormOptions() };
  },
  head: () => ({ meta: [{ title: "新增套餐｜小時光書店後台" }] }),
  component: ComboSetNewPage,
});

function ComboSetNewPage() {
  const { options } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  return (
    <ComboSetForm
      approvalOn={isApprovalRequired(options.approvalSettings, "combo_sets")}
      editing={null}
      initialItems={[]}
      products={options.products}
      back={{ to: "/admin/inventory-combos", label: "回套餐列表" }}
      onSaved={async (comboSetId) => {
        await router.invalidate();
        await navigate({
          to: "/admin/inventory-combos/$id",
          params: { id: comboSetId },
          replace: true,
        });
      }}
    />
  );
}
