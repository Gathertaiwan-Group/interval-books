/**
 * /admin/inventory-combos/$id —— 套餐詳情（唯讀）。資料來自 layout 的 loader
 * （_shell.inventory-combos_.$id.tsx），這一頁不另外抓。
 *
 * 動作：編輯（內頁）、上架／下架、待審時的通過／退回、被退回時的重新送審。
 * 刪除留在列表（AlertDialog 二次確認）。
 *
 * ⚠️ 動作做完 router.invalidate({ sync: true }) 等 layout loader 重抓完；useComboActions 再放掉
 *    busy，所以畫面不會停在動作前的舊狀態。
 * ⚠️ canApprove 只控制畫面；擋人的是 fns/inv-combos.ts#approveComboSet 的權限檢查。
 */
import { createFileRoute, getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { Loader2, Package2, Pencil, Power, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdminDetailNotFound, AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { ApprovalActions } from "@/components/inventory/ApprovalActions";
import { ComboSetBadges, ComboSetDetailView } from "@/components/inventory/ComboSetDetailView";
import { money } from "@/lib/admin/inv-combo-labels";
import { useComboActions } from "@/lib/admin/useComboActions";

const layout = getRouteApi("/admin/_shell/inventory-combos_/$id");

export const Route = createFileRoute("/admin/_shell/inventory-combos_/$id/")({
  component: ComboSetDetailPage,
});

function ComboSetDetailPage() {
  const { data } = layout.useLoaderData();
  const { user } = layout.useRouteContext();
  const router = useRouter();

  const { busyId, handleToggleActive, handleResubmit, handleApprove } = useComboActions(
    async () => {
      await router.invalidate({ sync: true });
    },
  );

  if (!data?.set) {
    return (
      <AdminDetailNotFound
        backTo="/admin/inventory-combos"
        backLabel="回套餐列表"
        message="找不到這個套餐，可能已被刪除或網址有誤。"
      />
    );
  }
  const { set } = data;
  const canApprove = user.permissions.includes("approve_combo_sets");
  const busy = busyId === set.combo_set_id;

  return (
    <AdminDetailPage
      backTo="/admin/inventory-combos"
      backLabel="回套餐列表"
      width="md"
      icon={<Package2 className="h-5 w-5" aria-hidden="true" />}
      title={set.name}
      meta={
        <div className="space-y-2">
          <p>
            組合價 {money(set.selling_price)}・共 {set.item_count} 件組成品項
          </p>
          <ComboSetBadges row={set} />
        </div>
      }
      actions={
        <>
          <ApprovalActions
            status={set.approval_status}
            canApprove={canApprove}
            busy={busy}
            productName={set.name}
            permissionName="approve_combo_sets"
            onApprove={() => void handleApprove(set, true)}
            onReject={() => void handleApprove(set, false)}
            onResubmit={() => void handleResubmit(set)}
          />
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={busy}
            onClick={() => void handleToggleActive(set)}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : set.is_active ? (
              <PowerOff className="h-4 w-4" />
            ) : (
              <Power className="h-4 w-4" />
            )}
            {set.is_active ? "下架" : "上架"}
          </Button>
          <Button asChild className="gap-1.5">
            <Link to="/admin/inventory-combos/$id/edit" params={{ id: set.combo_set_id }}>
              <Pencil className="h-4 w-4" />
              編輯
            </Link>
          </Button>
        </>
      }
    >
      <ComboSetDetailView set={set} items={data.items} sales={data.sales} />

      {!canApprove && set.approval_status === "pending" ? (
        <p className="text-xs text-muted-foreground">
          你沒有審核權限（approve_combo_sets），所以「通過」與「退回」是灰的。請找管理員授權。
        </p>
      ) : null}
    </AdminDetailPage>
  );
}
