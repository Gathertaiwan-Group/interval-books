/**
 * /admin/sales/$saleId —— 一筆銷售的明細（2026-10-26 後台第 3 批：從 SaleDetailDialog 改成內頁）。
 *
 * loader 只叫一支 getPosSale（GET，staffFnMiddleware() —— 與列表的 listPosSales 相同，沒有放寬）。
 * 唯讀：這一頁沒有任何寫入動作（「標記已對帳」還沒做，見 _shell.sales.tsx 檔頭）。
 */
import { createFileRoute } from "@tanstack/react-router";
import { Receipt } from "lucide-react";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPage,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { SaleDetailView } from "@/components/pos/SaleDetailView";
import { saleWhen } from "@/lib/admin/sale-when";
import { readAdminPeek } from "@/lib/admin/list-memory";
import { isUuid } from "@/lib/admin/order-labels";
import type { PosSaleListRow } from "@/server/repos/inv-sales";

export const Route = createFileRoute("/admin/_shell/sales_/$saleId")({
  loader: async ({ params }) => {
    if (!isUuid(params.saleId)) return { sale: null };
    const { getPosSale } = await import("@/lib/admin/fns/pos");
    return { sale: await getPosSale({ data: { saleId: params.saleId } }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.sale
          ? `銷售明細：${loaderData.sale.product_name ?? "（無品名）"}｜小時光書店後台`
          : "銷售紀錄｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: SalePending,
  component: SaleDetailPage,
});

function SalePending() {
  const { saleId } = Route.useParams();
  const peek = readAdminPeek<PosSaleListRow>("sale", saleId);
  return (
    <AdminDetailPending
      backTo="/admin/sales"
      backLabel="回銷售紀錄"
      title={peek ? (peek.product_name ?? "（無品名）") : undefined}
      meta={peek?.sale_date}
    />
  );
}

function SaleDetailPage() {
  const { sale } = Route.useLoaderData();

  if (!sale) {
    return (
      <AdminDetailNotFound
        backTo="/admin/sales"
        backLabel="回銷售紀錄"
        message="找不到這筆銷售紀錄，網址可能有誤。"
      />
    );
  }

  return (
    <AdminDetailPage
      backTo="/admin/sales"
      backLabel="回銷售紀錄"
      icon={<Receipt className="h-5 w-5" aria-hidden="true" />}
      title={sale.product_name ?? "（無品名）"}
      meta={saleWhen(sale)}
      width="md"
    >
      <SaleDetailView sale={sale} />
    </AdminDetailPage>
  );
}
