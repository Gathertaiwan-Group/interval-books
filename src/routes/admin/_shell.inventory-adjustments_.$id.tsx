/**
 * /admin/inventory-adjustments/$id —— 一張在庫異動單（2026-10-26 後台第 3 批：從 AdjustmentDetailDialog
 * 改成內頁；業主：「不要用彈窗，直接顯示內頁＆回到上一頁」）。
 *
 * loader 只叫一支 getInventoryAdjustmentPageData（GET，staffFnMiddleware() —— 與原本的
 * getAdminAdjustment 相同，沒有放寬）。動作（送出、審核、退回、重新送審、沖帳、刪除草稿）與原本
 * 對話框上的一模一樣，走同一支 useAdjustmentActions；三個破壞性動作仍要在 AlertDialog 再按一次。
 * 動作完成 → router.invalidate({ sync: true })：等這張單重抓完才放掉按鈕，畫面不會先停在動作前的狀態。
 * 刪除草稿成功 → 回列表（這張單已經不存在了）。
 *
 * ⚠️ canApprove 只控制畫面。擋住直接 POST /_serverFn/… 的是 approveRecord 那一次權限檢查。
 */
import { useRef, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { SlidersHorizontal } from "lucide-react";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPage,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import {
  AdjustmentConfirmDialog,
  type ConfirmKind,
  type PendingConfirm,
} from "@/components/inventory/AdjustmentConfirmDialog";
import {
  AdjustmentActions,
  AdjustmentBadges,
  AdjustmentDetailView,
} from "@/components/inventory/AdjustmentDetailView";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";
import { adjustmentHasActions } from "@/lib/admin/inv-adjustment-labels";
import { readAdminPeek } from "@/lib/admin/list-memory";
import { isUuid } from "@/lib/admin/order-labels";
import { useAdjustmentActions } from "@/lib/admin/useAdjustmentActions";
import type { AdminAdjustmentRow } from "@/server/repos/inv-adjustments";

export const Route = createFileRoute("/admin/_shell/inventory-adjustments_/$id")({
  loader: async ({ params }) => {
    if (!isUuid(params.id)) return { adjustment: null };
    const { getInventoryAdjustmentPageData } = await import("@/lib/admin/fns/inv-adjustments");
    return await getInventoryAdjustmentPageData({ data: { adjustmentId: params.id } });
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.adjustment
          ? `異動單 ${loaderData.adjustment.adjustment_number ?? "（無單號）"}｜小時光書店後台`
          : "在庫異動｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: AdjustmentPending,
  component: AdjustmentPage,
});

const BACK = { backTo: "/admin/inventory-adjustments", backLabel: "回在庫異動" } as const;

function AdjustmentPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<AdminAdjustmentRow>("adjustment", id);
  return (
    <AdminDetailPending
      {...BACK}
      width="lg"
      title={peek ? (peek.adjustment_number ?? "（無單號）") : undefined}
      titleExtra={peek ? <AdjustmentBadges row={peek} /> : undefined}
    />
  );
}

function AdjustmentPage() {
  const { adjustment } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const router = useRouter();
  const navigate = Route.useNavigate();
  const [confirming, setConfirming] = useState<PendingConfirm>(null);
  // 刪除草稿時不要重抓這一頁（這張單已經沒了，重抓只會先閃一下「找不到」），直接回列表。
  // 列表不在畫面上，src/start.ts 已經在寫入後把它的快取清掉，回去一定是新的。
  const leaving = useRef(false);

  const { busyId, handleSubmit, handleDelete, handleResubmit, handleApprove, handleReverse } =
    useAdjustmentActions(async () => {
      if (leaving.current) return;
      await router.invalidate({ sync: true });
    });

  if (!adjustment) {
    return <AdminDetailNotFound {...BACK} message="找不到這張異動單，可能已被刪除或網址有誤。" />;
  }
  const row = adjustment;
  const canApprove = user.permissions.includes("approve_stock_adjustments");
  const busy = busyId === row.adjustment_id;

  async function onConfirmed(kind: ConfirmKind, target: AdminAdjustmentRow) {
    if (kind === "delete") {
      leaving.current = true;
      const ok = await handleDelete(target);
      if (!ok) {
        leaving.current = false;
        return;
      }
      if (backIfPreviousIs(router.history, [BACK.backTo])) return;
      await navigate({ to: BACK.backTo, replace: true });
      return;
    }
    if (kind === "reject") await handleApprove(target, false);
    else await handleReverse(target);
  }

  const actions = adjustmentHasActions(row, canApprove) ? (
    <AdjustmentActions
      row={row}
      canApprove={canApprove}
      busy={busy}
      onSubmit={(r) => void handleSubmit(r)}
      onApprove={(r) => void handleApprove(r, true)}
      onResubmit={(r) => void handleResubmit(r)}
      onAskDelete={(r) => setConfirming({ kind: "delete", row: r })}
      onAskReject={(r) => setConfirming({ kind: "reject", row: r })}
      onAskReverse={(r) => setConfirming({ kind: "reverse", row: r })}
    />
  ) : null;

  return (
    <AdminDetailPage
      {...BACK}
      width="lg"
      icon={<SlidersHorizontal className="h-5 w-5" aria-hidden="true" />}
      title={<span className="font-mono">{row.adjustment_number ?? "（無單號）"}</span>}
      titleExtra={<AdjustmentBadges row={row} />}
      actions={actions}
    >
      <AdjustmentDetailView row={row} canApprove={canApprove} />
      <AdjustmentConfirmDialog
        confirming={confirming}
        setConfirming={setConfirming}
        onConfirmed={(kind, target) => void onConfirmed(kind, target)}
      />
    </AdminDetailPage>
  );
}
