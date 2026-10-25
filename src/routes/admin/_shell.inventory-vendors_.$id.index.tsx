/**
 * /admin/inventory-vendors/$id —— 廠商詳情（唯讀）。資料來自 layout 的 loader
 * （_shell.inventory-vendors_.$id.tsx），這一頁不另外抓。
 *
 * 動作：編輯（內頁）、完整號碼（VendorSensitiveDialog，會留查閱紀錄，維持對話框）、
 * 待審時的通過／退回。刪除留在列表（要先看到往來數字）。
 *
 * ⚠️ canApprove／canReadPii 只控制畫面；擋人的是 fns/inv-vendors.ts 的 requirePermission()。
 */
import { useState } from "react";
import { createFileRoute, getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { Building2, KeyRound, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdminDetailNotFound, AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { ApprovalActions } from "@/components/inventory/ApprovalActions";
import { VendorBadges, VendorDetailView } from "@/components/inventory/VendorDetailView";
import { VendorSensitiveDialog } from "@/components/inventory/VendorSensitiveDialog";
import { needsPermissionHint } from "@/lib/admin/permission-labels";
import { useVendorActions } from "@/lib/admin/useVendorActions";

const layout = getRouteApi("/admin/_shell/inventory-vendors_/$id");

export const Route = createFileRoute("/admin/_shell/inventory-vendors_/$id/")({
  component: VendorDetailPage,
});

function VendorDetailPage() {
  const { data } = layout.useLoaderData();
  const { user } = layout.useRouteContext();
  const router = useRouter();
  const [sensitiveOpen, setSensitiveOpen] = useState(false);

  const { busyId, handleApprove } = useVendorActions(async () => {
    await router.invalidate({ sync: true });
  });

  if (!data?.row || !data.vendor) {
    return (
      <AdminDetailNotFound
        backTo="/admin/inventory-vendors"
        backLabel="回廠商列表"
        message="找不到這家廠商，可能已被刪除或網址有誤。"
      />
    );
  }
  const { row, vendor } = data;
  const canApprove = user.permissions.includes("approve_vendors");
  const canReadPii = user.permissions.includes("inv.vendor.pii.read");
  const busy = busyId === row.vendor_id;

  return (
    <AdminDetailPage
      backTo="/admin/inventory-vendors"
      backLabel="回廠商列表"
      width="lg"
      icon={<Building2 className="h-5 w-5" aria-hidden="true" />}
      title={row.name}
      meta={
        <div className="space-y-2">
          <p>
            {row.vendor_code ?? "（未編號）"}
            {row.short_name ? `・${row.short_name}` : ""}
            {row.category_name ? `・${row.category_name}` : ""}
          </p>
          <VendorBadges row={row} />
        </div>
      }
      actions={
        <>
          {row.approval_status === "pending" ? (
            <ApprovalActions
              status={row.approval_status}
              busy={busy}
              canApprove={canApprove}
              productName={row.name}
              permissionName="approve_vendors"
              onApprove={() => void handleApprove(row, true)}
              onReject={() => void handleApprove(row, false)}
              onResubmit={() => undefined}
            />
          ) : null}
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={!canReadPii}
            title={
              canReadPii
                ? "查看完整號碼（會留下查閱紀錄）"
                : needsPermissionHint("inv.vendor.pii.read")
            }
            onClick={() => setSensitiveOpen(true)}
          >
            <KeyRound className="h-4 w-4" />
            完整號碼
          </Button>
          <Button asChild className="gap-1.5">
            <Link to="/admin/inventory-vendors/$id/edit" params={{ id: row.vendor_id }}>
              <Pencil className="h-4 w-4" />
              編輯
            </Link>
          </Button>
        </>
      }
    >
      <VendorDetailView
        row={row}
        detail={vendor}
        contacts={data.contacts}
        bankAccounts={data.bankAccounts}
        attachments={data.attachments}
      />

      <VendorSensitiveDialog
        open={sensitiveOpen}
        onOpenChange={setSensitiveOpen}
        vendor={sensitiveOpen ? row : null}
        canReadPii={canReadPii}
      />
    </AdminDetailPage>
  );
}
