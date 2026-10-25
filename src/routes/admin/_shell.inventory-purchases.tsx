/**
 * /admin/inventory-purchases —— 進貨
 *
 * 店員記錄「這批貨進來了」的地方。庫存不是在這一頁用手打進去的：進貨寫進
 * inv.purchases，0017 的 trigger 再去把 products.stock_quantity 與 FIFO 的
 * remaining_quantity 對齊。這是庫存唯一會往上加的路。
 *
 * ── 授權：兩層，而且兩層都在 server ───────────────────────────────────────
 * 日常作業 = staffFnMiddleware()；審核進貨再多一層 module→approve_purchases 對照。
 * ⚠️ 這一頁的 canApprove 旗標**只控制畫面**，把按鈕藏起來不是授權 —— 擋住
 * `curl -X POST /_serverFn/…` 的是 fns/inv-purchases.ts 每一支上面的 middleware，
 * 而它每一次都重讀 profiles 與 staff_permissions。
 *
 * ⚠️ **AI 拍照辨識已經接回來了**（4c）：不再打來源那支 Lovable AI Gateway 的
 *    recognize-purchase-order edge function（這個專案沒有 edge function），改走
 *    fns/ocr.ts 的 server fn 到 Gemini —— 瀏覽器只送壓縮過的圖與 storage key，辨識
 *    結果是**建議**，逐列改完才走既有的 importPurchases()。「匯出 Excel」還沒做。
 */
import { useCallback, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { FileSpreadsheet, Loader2, Plus, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProductPagination } from "@/components/inventory/ProductPagination";
import { PurchaseBatchBar } from "@/components/inventory/PurchaseBatchBar";
import { PurchaseDialogs } from "@/components/inventory/PurchaseDialogs";
import { PurchaseFilterBar } from "@/components/inventory/PurchaseFilterBar";
import { PurchaseTable } from "@/components/inventory/PurchaseTable";
import { PurchasePageHeader } from "@/components/inventory/PurchasePageHeader";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";
import { stableStringify } from "@/lib/admin/form-dirty";
import { usePurchaseActions } from "@/lib/admin/usePurchaseActions";
import { useLoaderBackedList } from "@/lib/admin/useLoaderBackedList";
import { usePruneVanishedSelection } from "@/lib/admin/usePruneVanishedSelection";
import type { PurchaseFilterValues } from "@/lib/admin/schemas";
import type { AdminPurchaseRow } from "@/server/repos/inv-purchases";

const DEFAULT_FILTER: PurchaseFilterValues = {
  keyword: null,
  categoryId: null,
  vendorId: null,
  productType: null,
  approvalStatus: "all",
  expiryStatus: "all",
  stockStatus: "all",
  dateFrom: null,
  dateTo: null,
  sort: "purchase_date_desc",
  page: 0,
  pageSize: 50,
};

export const Route = createFileRoute("/admin/_shell/inventory-purchases")({
  loader: async () => {
    const { getInventoryPurchasesPageData } = await import("@/lib/admin/fns/inv-purchases");
    // 一支 fn 拿齊，staffFnMiddleware 守的。擋人的是 middleware 重讀 profiles 那一下，
    // 不是側欄。商品清單整份撈是刻意的 —— 表單與匯入比對都要對著完整清單。
    return await getInventoryPurchasesPageData({ data: { filter: DEFAULT_FILTER } });
  },
  head: () => ({ meta: [{ title: "進貨｜小時光書店後台" }] }),
  component: InventoryPurchasesPage,
});

function InventoryPurchasesPage() {
  const { page: loaderPage, summary: loaderSummary, options, products } = Route.useLoaderData();
  const loaderUpdatedAt = Route.useMatch({ select: (m) => m.updatedAt });
  const { user } = Route.useRouteContext();
  const router = useRouter();

  // 清單與統計卡是同一組篩選抓的兩份，合成一份交給 useLoaderBackedList：背景重抓
  // （staleTime 過期、寫入後 invalidate）會反映在畫面上，篩選從內頁回來會還原。
  const loaderData = useMemo(
    () => ({ page: loaderPage, summary: loaderSummary }),
    [loaderPage, loaderSummary],
  );
  const list = useLoaderBackedList({
    key: "inventory-purchases",
    loaderFilter: DEFAULT_FILTER,
    loaderData,
    loaderUpdatedAt,
    errorMessage: "進貨清單讀取失敗",
    fetcher: async (next: PurchaseFilterValues) => {
      const { listAdminPurchases, getPurchaseSummary } =
        await import("@/lib/admin/fns/inv-purchases");
      const [page, summary] = await Promise.all([
        listAdminPurchases({ data: next }),
        getPurchaseSummary({ data: next }),
      ]);
      return { page, summary };
    },
  });
  const { filter, loading } = list;
  const data = list.data.page;
  const summary = list.data.summary;

  // ⚠️ 勾選是使用者正在做的事，留在這一頁自己的 state；背景更新只拿掉剛剛消失的那幾列。
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const rowIds = useMemo(() => data.rows.map((r) => r.purchase_id), [data.rows]);
  usePruneVanishedSelection(rowIds, stableStringify(filter), loading, setSelectedIds);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AdminPurchaseRow | null>(null);
  const [deleting, setDeleting] = useState<AdminPurchaseRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [batchUpdateOpen, setBatchUpdateOpen] = useState(false);

  const canApprove = user.permissions.includes("approve_purchases");
  const approvalOn = isApprovalRequired(options.approvalSettings, "purchases");

  function changeFilter(next: PurchaseFilterValues) {
    setSelectedIds([]);
    list.setFilter(next);
  }

  /** 寫入之後重抓這一頁。這個 repo 沒有 react-query，重抓就是唯一的同步方式。 */
  const reloadList = list.reload;
  const refresh = useCallback(async () => {
    await reloadList();
    // 商品清單與審核設定在 loader 裡，匯入可能剛剛建了新商品 —— 一起重跑。
    await router.invalidate();
  }, [reloadList, router]);

  const rowsById = useMemo(() => {
    const map = new Map<string, AdminPurchaseRow>();
    for (const r of data.rows) map.set(r.purchase_id, r);
    return map;
  }, [data.rows]);

  const selectedPending = selectedIds.filter(
    (id) => rowsById.get(id)?.approval_status === "pending",
  );

  const { busyId, batchBusy, handleApprove, handleDelete, handleBatchApprove } =
    usePurchaseActions(refresh);

  function toggleSelectMode() {
    setSelectMode((v) => !v);
    setSelectedIds([]);
  }

  /** 空白的新增進貨表單。拍照辨識失敗時的「改用手動輸入」也走這一支。 */
  function openCreateForm() {
    setEditing(null);
    setFormOpen(true);
  }

  const cards = [
    { label: "批次數", value: summary.batches.toLocaleString("zh-TW") },
    { label: "進貨總量", value: summary.quantity.toLocaleString("zh-TW") },
    { label: "剩餘量", value: summary.remaining.toLocaleString("zh-TW") },
    { label: "進貨金額", value: `NT$ ${Math.round(summary.amount).toLocaleString("zh-TW")}` },
    { label: "待審數", value: summary.pending.toLocaleString("zh-TW") },
  ];

  return (
    <div className="space-y-5">
      <PurchasePageHeader
        total={data.total}
        selectMode={selectMode}
        onToggleSelectMode={toggleSelectMode}
        onOpenImport={() => setImportOpen(true)}
        onCreate={openCreateForm}
        products={products}
        vendors={options.vendors}
        categories={options.categories}
        approvalOn={approvalOn}
        onImported={refresh}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.label} className="rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className="text-lg font-medium tabular-nums">{c.value}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        ⚠️ 上面五張卡只吃「進貨日期起／迄」這兩個條件（見 repos/inv-purchases.ts 的
        getPurchaseSummary），其他篩選只影響下面的清單。
      </p>

      <PurchaseFilterBar
        value={filter}
        onChange={changeFilter}
        categories={options.categories}
        vendors={options.vendors}
        disabled={loading}
        defaults={DEFAULT_FILTER}
      />

      {selectMode ? (
        <PurchaseBatchBar
          selectedCount={selectedIds.length}
          pendingCount={selectedPending.length}
          totalOnPage={data.rows.length}
          canApprove={canApprove}
          busy={batchBusy}
          onSelectAll={() => setSelectedIds(data.rows.map((r) => r.purchase_id))}
          onClear={() => setSelectedIds([])}
          onBatchApprove={(approved) => {
            void handleBatchApprove(approved, selectedPending).then(() => setSelectedIds([]));
          }}
          onOpenBatchUpdate={() => setBatchUpdateOpen(true)}
        />
      ) : null}

      {loading ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-border">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : data.rows.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border">
          <Truck className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">沒有符合條件的進貨紀錄</p>
        </div>
      ) : (
        <PurchaseTable
          rows={data.rows}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={(id) =>
            setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
          }
          onToggleSelectAll={() =>
            setSelectedIds((cur) =>
              cur.length === data.rows.length ? [] : data.rows.map((r) => r.purchase_id),
            )
          }
          busyId={busyId}
          canApprove={canApprove}
          onEdit={(row) => {
            setEditing(row);
            setFormOpen(true);
          }}
          onDelete={setDeleting}
          onApprove={handleApprove}
        />
      )}

      <ProductPagination
        page={filter.page}
        totalPages={Math.max(1, Math.ceil(data.total / filter.pageSize))}
        disabled={loading}
        onPageChange={(page) => list.setFilter({ ...filter, page })}
      />

      {!canApprove ? (
        <p className="text-xs text-muted-foreground">
          你可以新增、編輯與匯入進貨，但沒有審核權限（approve_purchases），所以看不到審核按鈕。
          請找管理員授權。
        </p>
      ) : null}

      <PurchaseDialogs
        products={products}
        vendors={options.vendors}
        categories={options.categories}
        approvalOn={approvalOn}
        refresh={refresh}
        formOpen={formOpen}
        setFormOpen={setFormOpen}
        editing={editing}
        deleting={deleting}
        setDeleting={setDeleting}
        onConfirmDelete={(row) => void handleDelete(row)}
        importOpen={importOpen}
        setImportOpen={setImportOpen}
        batchUpdateOpen={batchUpdateOpen}
        setBatchUpdateOpen={setBatchUpdateOpen}
        selectedIds={selectedIds}
        onBatchUpdated={async () => {
          setSelectedIds([]);
          await refresh();
        }}
      />
    </div>
  );
}
