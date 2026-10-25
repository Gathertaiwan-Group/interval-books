/**
 * /admin/inventory-combos —— 套餐
 *
 * 一個套餐只有**一個組合價**，賣出去的時候要拆成每一件組成品項各自的營收。拆法有
 * 兩種，而店員選不了：0018 §4 看的是「有沒有哪一件組成品項沒填售價」，缺一件整組
 * 就從「依定價比例分攤」退回「按數量均分」。正式庫現在上架中的套餐**全部**都是後者，
 * 所以這是常態不是邊角案例 —— 這一頁把口徑印在清單上、把分攤結果印在表單裡，理由
 * 就是「為什麼這本書這個月的營收長這樣」必須有地方答得出來。
 *
 * ⚠️ 畫面上的分攤是**預覽**。真正寫進 inv.sales.amount 的金額由
 *    inv.allocate_combo_amounts() 在資料庫算，見 lib/admin/combo-allocation.ts 檔頭。
 *
 * ⚠️ 送出去的 payload 沒有 approval_status，也沒有 amount / unit_price / cost_price
 *    —— 那四個全部是資料庫算的。見 ComboSetForm 的檔頭。
 *
 * ⚠️ `canApprove` 只控制畫面。擋住直接 POST /_serverFn/… 的是 fns/inv-combos.ts 裡
 *    approveComboSet 那一次權限檢查，而且它重讀 staff_permissions，不信任前端。
 *
 * ── 內頁（2026-10-25 起）──────────────────────────────────────────────────
 * 詳情／編輯／新增不再是彈窗：/admin/inventory-combos/$id、/$id/edit、/new
 * （_shell.inventory-combos_.*.tsx）。這一頁的篩選記在 list-memory，從內頁「← 回到列表」
 * 回來原樣還原；畫面上的清單取 loader 與自己抓的兩份裡比較新的（useLoaderBackedList），
 * 背景重抓會反映在畫面上。上下架／審核／刪除確認仍在列上。
 *
 * ⚠️ loader 只抓清單＋審核設定（getInventoryCombosPageData）。可選商品清單（約 496 KB）
 *    只有表單要用，跟著表單搬到內頁的 loader 去了。
 */
import { useCallback, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Info, Loader2, Package2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ComboSetDialogs } from "@/components/inventory/ComboSetDialogs";
import { ComboSetFilterBar } from "@/components/inventory/ComboSetFilterBar";
import { ComboSetTable } from "@/components/inventory/ComboSetTable";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";
import { useComboActions } from "@/lib/admin/useComboActions";
import { useLoaderBackedList } from "@/lib/admin/useLoaderBackedList";
import type { ComboFilterValues } from "@/lib/admin/schemas";
import type { AdminComboSetRow } from "@/server/repos/inv-combos";

const DEFAULT_FILTER: ComboFilterValues = {
  keyword: null,
  activeStatus: "all",
  approvalStatus: "all",
  sort: "name_asc",
};

export const Route = createFileRoute("/admin/_shell/inventory-combos")({
  loader: async () => {
    const { getInventoryCombosPageData } = await import("@/lib/admin/fns/inv-combos");
    return await getInventoryCombosPageData({ data: DEFAULT_FILTER });
  },
  head: () => ({ meta: [{ title: "套餐｜小時光書店後台" }] }),
  component: InventoryCombosPage,
});

function InventoryCombosPage() {
  const { list: loaderList, approvalSettings } = Route.useLoaderData();
  const loaderUpdatedAt = Route.useMatch({ select: (m) => m.updatedAt });
  const { user } = Route.useRouteContext();
  const router = useRouter();

  const comboList = useLoaderBackedList({
    key: "inventory-combos",
    loaderFilter: DEFAULT_FILTER,
    loaderData: loaderList,
    loaderUpdatedAt,
    errorMessage: "套餐清單讀取失敗",
    fetcher: async (next: ComboFilterValues) => {
      const { listAdminComboSets } = await import("@/lib/admin/fns/inv-combos");
      return await listAdminComboSets({ data: next });
    },
  });
  const filter = comboList.filter;
  const data = comboList.data;
  const loading = comboList.loading;

  const [deleting, setDeleting] = useState<AdminComboSetRow | null>(null);

  const canApprove = user.permissions.includes("approve_combo_sets");
  // 只拿來寫提示文字。真正的 status 是 inv.initial_approval_status() 算的。
  const approvalOn = isApprovalRequired(approvalSettings, "combo_sets");

  function changeFilter(next: ComboFilterValues) {
    comboList.setFilter(next);
  }

  /** 寫入之後重抓這一頁；審核設定放在 loader 裡，所以也讓 router 重跑一次。 */
  const reloadList = comboList.reload;
  const refresh = useCallback(async () => {
    await reloadList();
    await router.invalidate();
  }, [reloadList, router]);

  const { busyId, handleToggleActive, handleDelete, handleResubmit, handleApprove } =
    useComboActions(refresh);

  function run(task: Promise<void>) {
    void task;
  }

  const pending = data.sets.filter((s) => s.approval_status === "pending").length;
  // 按數量均分的套餐。正式庫現在全部都是這一種，所以這句話不是邊角提示，是常態。
  const evenSplit = data.sets.filter((s) => s.allocation_basis === "quantity");
  const zeroPriced = evenSplit.reduce((sum, s) => sum + s.zero_priced_items, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-lg font-medium">
            <Package2 className="h-5 w-5" aria-hidden="true" />
            套餐
          </h1>
          <Badge variant="secondary" className="font-normal">
            共 {data.sets.length.toLocaleString("zh-TW")} 個
          </Badge>
          {approvalOn ? (
            <Badge variant="outline" className="font-normal">
              需審核{pending > 0 ? `・${pending} 個待審` : ""}
            </Badge>
          ) : null}
        </div>
        <Button asChild size="sm" className="gap-1.5">
          <Link to="/admin/inventory-combos/new" preload="intent">
            <Plus className="h-4 w-4" />
            新增套餐
          </Link>
        </Button>
      </div>

      <p className="max-w-3xl text-sm text-muted-foreground">
        套餐是一個組合價賣一組商品。賣掉的時候，組合價會依<strong>分攤口徑</strong>
        拆成每一件組成品項各自的營收 —— 口徑是資料庫依「組成品項有沒有填售價」決定的，
        只要缺一件，整組就退回按數量均分。
      </p>

      {evenSplit.length > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span>
            有 {evenSplit.length} 個套餐目前是<strong>按數量均分</strong>，因為裡面共有 {zeroPriced}{" "}
            件組成品項沒有填售價。到商品管理把這些商品的售價補齊，
            它們就會自動改成依定價比例分攤，營收也才會落在正確的商品上。
          </span>
        </div>
      ) : null}

      <ComboSetFilterBar value={filter} onChange={changeFilter} disabled={loading} />

      {loading ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-border">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : data.sets.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          沒有符合條件的套餐
        </div>
      ) : (
        <ComboSetTable
          rows={data.sets}
          items={data.items}
          busyId={busyId}
          canApprove={canApprove}
          onToggleActive={(row) => run(handleToggleActive(row))}
          onAskDelete={setDeleting}
          onApprove={(row) => run(handleApprove(row, true))}
          onReject={(row) => run(handleApprove(row, false))}
          onResubmit={(row) => run(handleResubmit(row))}
        />
      )}

      {!canApprove ? (
        <p className="text-xs text-muted-foreground">
          你可以建立、編輯與上下架套餐，但沒有審核權限（approve_combo_sets），
          所以「通過」與「退回」那兩顆按鈕是灰的。請找管理員授權。
        </p>
      ) : null}

      <ComboSetDialogs
        deleting={deleting}
        setDeleting={setDeleting}
        onConfirmDelete={(row) => run(handleDelete(row))}
      />
    </div>
  );
}
