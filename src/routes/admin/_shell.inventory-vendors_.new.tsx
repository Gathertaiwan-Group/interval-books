/**
 * /admin/inventory-vendors/new —— 新增廠商（2026-10-25 從 VendorFormDialog 改成內頁）。
 *
 * 表單選項（類別、稅別、扣繳類別、審核設定）由 loader 給，授權是 listVendorFormOptions 的
 * staffFnMiddleware()。存檔成功 → 換成那家廠商的詳情頁（replace：按上一頁回列表，不回空白表單）。
 * 聯絡人／匯款帳戶／附件要先有廠商才能存，所以新增頁那三區顯示「先儲存基本資料」。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { VendorForm } from "@/components/inventory/VendorForm";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";

export const Route = createFileRoute("/admin/_shell/inventory-vendors_/new")({
  loader: async () => {
    const { listVendorFormOptions } = await import("@/lib/admin/fns/inv-vendors");
    return { options: await listVendorFormOptions() };
  },
  head: () => ({ meta: [{ title: "新增廠商｜小時光書店後台" }] }),
  component: VendorNewPage,
});

function VendorNewPage() {
  const { options } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  return (
    <VendorForm
      approvalOn={isApprovalRequired(options.approvalSettings, "vendors")}
      editing={null}
      detail={null}
      contacts={[]}
      bankAccounts={[]}
      attachments={[]}
      categories={options.categories}
      taxTypes={options.taxTypes}
      withholdingCategories={options.withholdingCategories}
      back={{ to: "/admin/inventory-vendors", label: "回廠商列表" }}
      onReloadChildren={async () => undefined}
      onSaved={async (vendorId) => {
        await router.invalidate({ sync: true });
        await navigate({
          to: "/admin/inventory-vendors/$id",
          params: { id: vendorId },
          replace: true,
        });
      }}
    />
  );
}
