/**
 * /admin/inventory-adjustments —— 在庫異動
 *
 * 報廢、公關贈送、樣品領用、內部領用、盤點調整、商品組合調整 —— 六類非銷售的庫存
 * 變動。盤點（ADJ）也寫進同一張 inv.stock_adjustments，只是它另外有一頁自己的入口。
 *
 * ── 三件與來源不一樣的事 ─────────────────────────────────────────────────
 * · **統計卡的分母是篩選的日期區間**，不是「最近 100 筆」。來源拿 `.limit(100)` 的
 *   結果當分母，資料一多數字就開始說謊。
 * · **六張卡就放六欄**。來源寫 `lg:grid-cols-5` 卻 map 六個類別，CMB 永遠自己換行。
 * · **沖帳關係顯示的是單號**。來源的詳情頁直接印 UUID。
 *
 * ⚠️ `canApprove` 只控制畫面。擋住直接 POST /_serverFn/… 的是
 *    fns/inv-adjustments.ts 裡 approveRecord 那一次權限檢查，而且它重讀
 *    staff_permissions，不信任前端送來的任何東西。
 */
import { useCallback, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Loader2, Plus, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AdjustmentDialogs,
  type ConfirmKind,
  type PendingConfirm,
} from "@/components/inventory/AdjustmentDialogs";
import { AdjustmentFilterBar } from "@/components/inventory/AdjustmentFilterBar";
import { AdjustmentTable } from "@/components/inventory/AdjustmentTable";
import { ProductPagination } from "@/components/inventory/ProductPagination";
import { ADJUSTMENT_CATEGORY_OPTIONS } from "@/lib/admin/inv-adjustment-labels";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";
import { useAdjustmentActions } from "@/lib/admin/useAdjustmentActions";
import { useLoaderBackedList } from "@/lib/admin/useLoaderBackedList";
import type { AdjustmentFilterValues } from "@/lib/admin/schemas";
import type { AdminAdjustmentRow } from "@/server/repos/inv-adjustments";

const DEFAULT_FILTER: AdjustmentFilterValues = {
  keyword: null,
  category: null,
  status: "all",
  productId: null,
  // 預設不限日期。來源預設當月，於是「上個月那張報廢單去哪了」是每個月都會被問一次
  // 的問題，而畫面上沒有任何東西說得出來它被日期篩掉了。
  dateFrom: null,
  dateTo: null,
  sort: "date_desc",
  page: 0,
  pageSize: 50,
};

export const Route = createFileRoute("/admin/_shell/inventory-adjustments")({
  loader: async () => {
    const { getInventoryAdjustmentsPageData } = await import("@/lib/admin/fns/inv-adjustments");
    // 一支 fn 拿齊（清單第一頁、統計、表單選項），staffFnMiddleware 守的。
    return await getInventoryAdjustmentsPageData({
      data: { filter: DEFAULT_FILTER, summary: { dateFrom: null, dateTo: null } },
    });
  },
  head: () => ({ meta: [{ title: "在庫異動｜小時光書店後台" }] }),
  component: InventoryAdjustmentsPage,
});

function InventoryAdjustmentsPage() {
  const { page: loaderPage, summary: loaderSummary, options } = Route.useLoaderData();
  const loaderUpdatedAt = Route.useMatch({ select: (m) => m.updatedAt });
  const { user } = Route.useRouteContext();
  const router = useRouter();

  // 清單與統計卡吃同一組篩選（統計只看日期區間），合成一份交給 useLoaderBackedList：
  // 背景重抓會反映在畫面上，篩選從內頁回來會還原。
  const loaderData = useMemo(
    () => ({ page: loaderPage, summary: loaderSummary }),
    [loaderPage, loaderSummary],
  );
  const list = useLoaderBackedList({
    key: "inventory-adjustments",
    loaderFilter: DEFAULT_FILTER,
    loaderData,
    loaderUpdatedAt,
    errorMessage: "異動清單讀取失敗",
    fetcher: async (next: AdjustmentFilterValues) => {
      const { getAdjustmentSummary, listAdminAdjustments } =
        await import("@/lib/admin/fns/inv-adjustments");
      // 統計卡與清單吃同一組日期區間，所以兩支一起重抓。
      const [page, summary] = await Promise.all([
        listAdminAdjustments({ data: next }),
        getAdjustmentSummary({ data: { dateFrom: next.dateFrom, dateTo: next.dateTo } }),
      ]);
      return { page, summary };
    },
  });
  const { filter, loading } = list;
  const data = list.data.page;
  const summary = list.data.summary;

  // 對話框看的是點開那一刻那一列的副本（留在這一頁的 state），背景重抓不會把它關掉或換掉。
  const [formOpen, setFormOpen] = useState(false);
  const [detail, setDetail] = useState<AdminAdjustmentRow | null>(null);
  const [confirming, setConfirming] = useState<PendingConfirm>(null);

  const canApprove = user.permissions.includes("approve_stock_adjustments");
  // 只拿來寫提示文字。真正的 status 是 inv.stock_adjustment_initial_status() 算的。
  const approvalOn = isApprovalRequired(options.approvalSettings, "stock_adjustments");

  function changeFilter(next: AdjustmentFilterValues) {
    list.setFilter(next);
  }

  /** 寫入之後重抓這一頁；審核設定放在 loader 裡，所以也讓 router 重跑一次。 */
  const reloadList = list.reload;
  const refresh = useCallback(async () => {
    await reloadList();
    await router.invalidate();
  }, [reloadList, router]);

  const { busyId, handleSubmit, handleDelete, handleResubmit, handleApprove, handleReverse } =
    useAdjustmentActions(refresh);

  /** 動作做完就把詳情關掉 —— 留著會顯示動作前的舊狀態。 */
  function run(task: Promise<void>) {
    setDetail(null);
    void task;
  }

  function onConfirmed(kind: ConfirmKind, row: AdminAdjustmentRow) {
    if (kind === "delete") run(handleDelete(row));
    else if (kind === "reject") run(handleApprove(row, false));
    else run(handleReverse(row));
  }

  const totalPages = Math.max(1, Math.ceil(data.total / filter.pageSize));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-lg font-medium">
            <SlidersHorizontal className="h-5 w-5" aria-hidden="true" />
            在庫異動
          </h1>
          <Badge variant="secondary" className="font-normal">
            共 {data.total.toLocaleString("zh-TW")} 筆
          </Badge>
          {approvalOn ? (
            <Badge variant="outline" className="font-normal">
              異動需審核
            </Badge>
          ) : null}
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setFormOpen(true)}>
          <Plus className="h-4 w-4" />
          新增異動
        </Button>
      </div>

      <p className="max-w-3xl text-sm text-muted-foreground">
        管理報廢、贈送、領用等非銷售的庫存變動。下面六張卡只算<strong>已確認</strong>的單據
        （草稿與待審的還沒生效），範圍就是篩選列的日期區間。
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {ADJUSTMENT_CATEGORY_OPTIONS.map((o) => {
          const stat = summary[o.code] ?? { count: 0, quantity: 0, cost: 0 };
          return (
            <div key={o.code} className="rounded-md border border-border p-3">
              <p className="truncate text-xs text-muted-foreground" title={o.description}>
                {o.label}
              </p>
              <p className="text-lg font-medium tabular-nums">{stat.count} 筆</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {stat.quantity} 件・NT$ {Math.round(stat.cost).toLocaleString("zh-TW")}
              </p>
            </div>
          );
        })}
      </div>

      <AdjustmentFilterBar value={filter} onChange={changeFilter} disabled={loading} />

      {loading ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-border">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : data.rows.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          沒有符合條件的異動紀錄
        </div>
      ) : (
        <AdjustmentTable rows={data.rows} busyId={busyId} onView={setDetail} />
      )}

      <ProductPagination
        page={filter.page}
        totalPages={totalPages}
        disabled={loading}
        onPageChange={(page) => list.setFilter({ ...filter, page })}
      />

      {!canApprove ? (
        <p className="text-xs text-muted-foreground">
          你可以建立、送出與沖帳，但沒有審核權限（approve_stock_adjustments），所以看不到 「審核通過
          / 退回」那兩顆按鈕。請找管理員授權。
        </p>
      ) : null}

      <AdjustmentDialogs
        approvalOn={approvalOn}
        canApprove={canApprove}
        busyId={busyId}
        refresh={refresh}
        formOpen={formOpen}
        setFormOpen={setFormOpen}
        detail={detail}
        setDetail={setDetail}
        confirming={confirming}
        setConfirming={setConfirming}
        onSubmit={(row) => run(handleSubmit(row))}
        onApprove={(row) => run(handleApprove(row, true))}
        onResubmit={(row) => run(handleResubmit(row))}
        onConfirmed={onConfirmed}
      />
    </div>
  );
}
