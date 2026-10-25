/**
 * /admin/inventory-products —— 進銷存商品主檔
 *
 * 0014 讓店員在櫃檯**賣**進銷存的商品；這一頁讓店員**維護**那些商品：新增、編輯、
 * 停用、審核、調價、Excel 匯入、批次修改。993 筆商品的來源就在這裡。
 *
 * ── 授權：三層，而且每一層都在 server ─────────────────────────────────────
 *   檢視／編輯      staffFnMiddleware()
 *   審核商品        staffFnMiddleware() + module→approve_products 對照
 *   審核調價        同上，但要 approve_price_changes
 *
 * ⚠️ 這一頁的 canApproveProducts / canApprovePrices 兩個旗標**只控制畫面**。
 *    把按鈕變灰不是授權 —— 擋住 `curl -X POST /_serverFn/…` 的是
 *    lib/admin/fns/inv-products.ts 每一支上面的 middleware，而它每次都重讀
 *    profiles 與 staff_permissions。
 *
 * ── AI 拍照辨識（4c 接上了）───────────────────────────────────────────────
 * 4b 把入口整個拿掉，因為來源打的是 Lovable AI Gateway 的 edge function，這個
 * 專案沒有那支函式，硬搬會是一顆按了必定 500 的按鈕。0018 改接 Gemini：走
 * createServerFn + staffFnMiddleware（沒有新增任何 edge function），前端只送
 * 私有 bucket 的 storage key，金鑰留在 src/server/env.ts。
 * ⚠️ 辨識結果是**建議**，不會自己寫入 —— 店員在確認畫面改完才走 inv_save_product()。
 *
 * ── 沒有搬過來的東西（4b 交接）────────────────────────────────────────────
 * · **盤點與在庫異動**（來源 InventoryAdjustmentDialog / BatchInventoryAdjustmentDialog）
 *   —— 它們寫 inv.stock_adjustments 與 inv.inventory_adjustments，那是 4b。
 *   0016 的 inv_approve_record() 已經先把這兩個 module 的審核路徑接好了。
 */
import { useCallback, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Loader2, Package } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { BatchActionBar } from "@/components/inventory/BatchActionBar";
import { ProductFilterBar } from "@/components/inventory/ProductFilterBar";
import { ProductDialogs } from "@/components/inventory/ProductDialogs";
import { PriceChangeQueue } from "@/components/inventory/PriceChangeQueue";
import { ProductPageHeader } from "@/components/inventory/ProductPageHeader";
import { ProductOCRLauncher } from "@/components/ocr/ProductOCRLauncher";
import { ProductPagination } from "@/components/inventory/ProductPagination";
import { ProductTable } from "@/components/inventory/ProductTable";
import { useProductActions } from "@/lib/admin/useProductActions";
import { useProductListState } from "@/lib/admin/useProductListState";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";
import type { ProductFilterValues } from "@/lib/admin/schemas";
import type { AdminProductRow } from "@/server/repos/inv-products";

const DEFAULT_FILTER: ProductFilterValues = {
  keyword: null,
  categoryId: null,
  productType: null,
  vendorId: null,
  approvalStatus: "all",
  // 停用的商品平常不該擋在路中間。與來源的預設一致。
  activeStatus: "active",
  priceChange: "all",
  sort: "created_at",
  page: 0,
  pageSize: 50,
};

export const Route = createFileRoute("/admin/_shell/inventory-products")({
  loader: async () => {
    const { getInventoryProductsPageData } = await import("@/lib/admin/fns/inv-products");
    // 一支 fn 拿齊（清單第一頁＋表單選項），staffFnMiddleware 守的。店員進得來、customer
    // 進不來，而且擋人的是 middleware 重讀 profiles 那一下，不是側欄。
    return await getInventoryProductsPageData({ data: { filter: DEFAULT_FILTER } });
  },
  head: () => ({ meta: [{ title: "商品管理｜小時光書店後台" }] }),
  component: InventoryProductsPage,
});

function InventoryProductsPage() {
  const { page: initialPage, options } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const router = useRouter();

  const {
    filter,
    data,
    loading,
    selectedIds,
    setSelectedIds,
    changeFilter,
    changePage,
    refresh,
    rowsById,
    selectedPending,
    totalPages,
  } = useProductListState(initialPage, DEFAULT_FILTER);

  const [selectMode, setSelectMode] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AdminProductRow | null>(null);
  const [detail, setDetail] = useState<AdminProductRow | null>(null);
  const [pricing, setPricing] = useState<AdminProductRow | null>(null);
  const [deleting, setDeleting] = useState<AdminProductRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [batchUpdateOpen, setBatchUpdateOpen] = useState(false);

  const canApproveProducts = user.permissions.includes("approve_products");
  const canApprovePrices = user.permissions.includes("approve_price_changes");
  const productApprovalOn = isApprovalRequired(options.approvalSettings, "products");
  const priceApprovalOn = isApprovalRequired(options.approvalSettings, "price_changes");

  const {
    busyId,
    batchBusy,
    handleApprove,
    handleApprovePrice,
    handleResubmit,
    handleToggleActive,
    handleDelete,
    handleBatchApprove,
  } = useProductActions(refresh);

  return (
    <div className="space-y-5">
      <ProductPageHeader
        total={data.total}
        selectMode={selectMode}
        productApprovalOn={productApprovalOn}
        priceApprovalOn={priceApprovalOn}
        onToggleSelectMode={() => {
          setSelectMode((v) => !v);
          setSelectedIds([]);
        }}
        onOpenImport={() => setImportOpen(true)}
        onCreate={() => {
          setEditing(null);
          setFormOpen(true);
        }}
      />

      <p className="max-w-3xl text-sm text-muted-foreground">
        這裡的商品是<strong>庫存主檔</strong>（inv.products），不是店面型錄。改這裡不會動到
        網站上的商品名稱與售價 —— 那是「上架」那一頁的事，兩邊靠 product_inventory_links 連著。
      </p>

      <ProductOCRLauncher
        categories={options.categories}
        vendors={options.vendors}
        productApprovalOn={productApprovalOn}
        onSaved={refresh}
        onManualEntry={() => {
          setEditing(null);
          setFormOpen(true);
        }}
      />

      <ProductFilterBar
        value={filter}
        onChange={changeFilter}
        categories={options.categories}
        vendors={options.vendors}
        disabled={loading}
        pendingCount={0}
      />

      {selectMode ? (
        <BatchActionBar
          selectedCount={selectedIds.length}
          pendingCount={selectedPending.length}
          totalOnPage={data.rows.length}
          canApprove={canApproveProducts}
          busy={batchBusy}
          onSelectAll={() => setSelectedIds(data.rows.map((r) => r.inv_product_id))}
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
          <Package className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">沒有符合條件的商品</p>
        </div>
      ) : (
        <ProductTable
          rows={data.rows}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelect={(id) =>
            setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
          }
          onToggleSelectAll={() =>
            setSelectedIds((cur) =>
              cur.length === data.rows.length ? [] : data.rows.map((r) => r.inv_product_id),
            )
          }
          busyId={busyId}
          canApproveProducts={canApproveProducts}
          onView={setDetail}
          onEdit={(row) => {
            setEditing(row);
            setFormOpen(true);
          }}
          onPrice={setPricing}
          onToggleActive={handleToggleActive}
          onDelete={setDeleting}
          onApprove={handleApprove}
          onResubmit={handleResubmit}
        />
      )}
      <PriceChangeQueue
        rows={data.rows}
        busyId={busyId}
        canApprove={canApprovePrices}
        onDecide={handleApprovePrice}
      />

      <ProductPagination
        page={filter.page}
        totalPages={totalPages}
        disabled={loading}
        onPageChange={changePage}
      />

      {!canApproveProducts ? (
        <p className="text-xs text-muted-foreground">
          你可以新增與編輯商品，但沒有審核權限（approve_products）。請找管理員授權。
        </p>
      ) : null}

      <ProductDialogs
        categories={options.categories}
        vendors={options.vendors}
        baseProducts={options.baseProducts}
        productApprovalOn={productApprovalOn}
        priceApprovalOn={priceApprovalOn}
        refresh={refresh}
        formOpen={formOpen}
        setFormOpen={setFormOpen}
        editing={editing}
        setEditing={setEditing}
        detail={detail}
        setDetail={setDetail}
        pricing={pricing}
        setPricing={setPricing}
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
