/**
 * /admin/inventory-vendors/$id/edit —— 編輯廠商（2026-10-25 從 VendorFormDialog 改成內頁）。
 *
 * 資料來自 layout 的 loader（與詳情頁共用，「詳情 → 編輯」不重抓）。表單只在掛載時從
 * loader 填一次；子表寫完 router.invalidate() 重跑 loader，不會蓋掉打到一半的欄位。
 * 有未存的變更時離開會先問（VendorForm 裡的 useUnsavedChangesGuard）。
 * 存檔成功 → 回詳情頁（寫入後 src/start.ts 已清掉列表快取；這裡再 invalidate 一次）。
 */
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { AdminDetailNotFound } from "@/components/admin/AdminDetailPage";
import { VendorForm } from "@/components/inventory/VendorForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";

const layout = getRouteApi("/admin/_shell/inventory-vendors_/$id");

export const Route = createFileRoute("/admin/_shell/inventory-vendors_/$id/edit")({
  component: VendorEditPage,
});

function VendorEditPage() {
  const { data } = layout.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  if (!data?.row || !data.vendor) {
    return (
      <AdminDetailNotFound
        backTo="/admin/inventory-vendors"
        backLabel="回廠商列表"
        message="找不到這家廠商，可能已被刪除或網址有誤。"
      />
    );
  }

  return (
    <VendorForm
      // 換一家廠商＝重新掛載，表單不會跨廠商殘留。
      key={data.row.vendor_id}
      approvalOn={isApprovalRequired(data.options.approvalSettings, "vendors")}
      editing={data.row}
      detail={data.vendor}
      contacts={data.contacts}
      bankAccounts={data.bankAccounts}
      attachments={data.attachments}
      categories={data.options.categories}
      taxTypes={data.options.taxTypes}
      withholdingCategories={data.options.withholdingCategories}
      back={{
        to: `/admin/inventory-vendors/${data.row.vendor_id}`,
        label: "返回",
        also: ["/admin/inventory-vendors"],
      }}
      onReloadChildren={async () => {
        await router.invalidate();
      }}
      onSaved={async (vendorId) => {
        await router.invalidate();
        // 從詳情頁進來 → 按上一頁回詳情（歷史紀錄不多一筆）；否則換成詳情頁。
        if (backIfPreviousIs(router.history, [`/admin/inventory-vendors/${vendorId}`])) return;
        await navigate({
          to: "/admin/inventory-vendors/$id",
          params: { id: vendorId },
          replace: true,
        });
      }}
    />
  );
}
