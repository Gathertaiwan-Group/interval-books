/**
 * /admin/inventory-purchases/new —— 新增進貨（2026-10-26 後台第 3 批：從 PurchaseFormDialog 改成內頁）。
 *
 * loader：getInventoryPurchaseFormPageData（GET，staffFnMiddleware()）只拿供應商與審核設定；
 * 商品選擇器在表單裡打字時問 searchPurchaseProducts（最多 30 筆），不再整份清單搬到瀏覽器。
 * 拍照辨識失敗時的「改用手動輸入」也導到這一頁。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PurchaseForm } from "@/components/inventory/PurchaseForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";

export const Route = createFileRoute("/admin/_shell/inventory-purchases_/new")({
  loader: async () => {
    const { getInventoryPurchaseFormPageData } = await import("@/lib/admin/fns/inv-purchases");
    const { options } = await getInventoryPurchaseFormPageData({ data: { purchaseId: null } });
    return { options };
  },
  head: () => ({ meta: [{ title: "新增進貨｜小時光書店後台" }] }),
  component: PurchaseNewPage,
});

function PurchaseNewPage() {
  const { options } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  return (
    <PurchaseForm
      purchase={null}
      vendors={options.vendors}
      approvalOn={isApprovalRequired(options.approvalSettings, "purchases")}
      onSaved={async () => {
        await router.invalidate({ sync: true });
        if (backIfPreviousIs(router.history, ["/admin/inventory-purchases"])) return;
        await navigate({ to: "/admin/inventory-purchases", replace: true });
      }}
    />
  );
}
