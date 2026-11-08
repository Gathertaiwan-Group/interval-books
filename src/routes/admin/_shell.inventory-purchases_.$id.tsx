/**
 * /admin/inventory-purchases/$id —— 編輯一筆進貨（2026-10-26 後台第 3 批：從 PurchaseFormDialog
 * 改成內頁）。
 *
 * loader 只叫一支 getInventoryPurchaseFormPageData（GET，staffFnMiddleware() —— 與原本的
 * getAdminPurchase／listPurchaseFormOptions 相同，沒有放寬）：這一筆進貨＋供應商與審核設定。
 * 不帶商品清單：編輯時商品鎖住不能換。審核與刪除仍在列表那一列上（刪除要再確認一次）。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { PurchaseForm } from "@/components/inventory/PurchaseForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";
import { readAdminPeek } from "@/lib/admin/list-memory";
import { isUuid } from "@/lib/admin/order-labels";
import type { AdminPurchaseRow } from "@/server/repos/inv-purchases";

export const Route = createFileRoute("/admin/_shell/inventory-purchases_/$id")({
  loader: async ({ params }) => {
    if (!isUuid(params.id)) return { purchase: null, options: null };
    const { getInventoryPurchaseFormPageData } = await import("@/lib/admin/fns/inv-purchases");
    return await getInventoryPurchaseFormPageData({ data: { purchaseId: params.id } });
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.purchase
          ? `編輯進貨：${loaderData.purchase.item_name || loaderData.purchase.product_name || "（找不到商品）"}｜小時光書店後台`
          : "進貨｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: PurchasePending,
  component: PurchaseEditPage,
});

function PurchasePending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<AdminPurchaseRow>("purchase", id);
  return (
    <AdminDetailPending
      backTo="/admin/inventory-purchases"
      backLabel="回進貨列表"
      title={
        peek ? `編輯進貨：${peek.item_name || peek.product_name || "（找不到商品）"}` : undefined
      }
    />
  );
}

function PurchaseEditPage() {
  const { purchase, options } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  if (!purchase || !options) {
    return (
      <AdminDetailNotFound
        backTo="/admin/inventory-purchases"
        backLabel="回進貨列表"
        message="找不到這筆進貨，可能已被刪除或網址有誤。"
      />
    );
  }

  return (
    <PurchaseForm
      key={purchase.purchase_id}
      purchase={purchase}
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
