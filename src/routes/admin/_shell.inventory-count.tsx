/**
 * /admin/inventory-count —— 庫存盤點
 *
 * 盤帳面庫存，差異透過「在庫異動」記錄（category = 'ADJ'）。盤點與在庫異動在畫面上
 * 是兩頁，在資料庫是**同一張 inv.stock_adjustments**。
 *
 * ── 這一頁修掉的兩個東西 ─────────────────────────────────────────────────
 * · **送的是實盤數量，不是差異。** 差異由 inv_record_stock_count() 用當下的
 *   stock_quantity 算。來源在瀏覽器算，而那個 stock_quantity 是頁面載入時抓的 ——
 *   對話框開著十分鐘、櫃檯中間賣掉三本，送出的差異就會多扣三本。
 * · **審核開關對盤點是有效的。** 來源把 status 硬寫成 'confirmed'，approval_settings
 *   裡的 stock_adjustments 那一列形同虛設。這一頁的 payload 裡沒有 status 這個欄位，
 *   下面那個 `countApprovalOn` 只拿來寫提示文字。
 *
 * ⚠️ 篩選與分頁都在資料庫端（repos/inv-adjustments.ts 的 range()）。來源是把 993 筆
 *    整份撈回瀏覽器再 Array.filter，而且每一次寫入都重抓一次。
 */
import { useCallback, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ClipboardCheck, ClipboardList, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BatchStockCountDialog } from "@/components/inventory/BatchStockCountDialog";
import { ProductPagination } from "@/components/inventory/ProductPagination";
import { StockCountDialog } from "@/components/inventory/StockCountDialog";
import { StockCountFilterBar, type CountFilter } from "@/components/inventory/StockCountFilterBar";
import { StockCountSummaryCards } from "@/components/inventory/StockCountSummaryCards";
import { RecentStockCounts, StockCountTable } from "@/components/inventory/StockCountTable";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";
import { useLoaderBackedList } from "@/lib/admin/useLoaderBackedList";
import type { StockCountProductRow } from "@/server/repos/inv-adjustments";

const DEFAULT_FILTER: CountFilter = {
  keyword: null,
  categoryId: null,
  productType: null,
  lowStockOnly: false,
  page: 0,
  pageSize: 50,
};

/** 最近盤點紀錄 = 六類裡的 ADJ 那一類，最新的 20 筆。 */
const RECENT_FILTER = {
  keyword: null,
  category: "ADJ" as const,
  status: "all" as const,
  productId: null,
  dateFrom: null,
  dateTo: null,
  sort: "created_at" as const,
  page: 0,
  pageSize: 20,
};

export const Route = createFileRoute("/admin/_shell/inventory-count")({
  loader: async () => {
    const { getInventoryCountPageData } = await import("@/lib/admin/fns/inv-adjustments");
    // 一支 fn 拿齊，staffFnMiddleware 守的。店員進得來、customer 進不來。
    return await getInventoryCountPageData({
      data: {
        filter: DEFAULT_FILTER,
        summary: { dateFrom: null, dateTo: null },
        recent: RECENT_FILTER,
      },
    });
  },
  head: () => ({ meta: [{ title: "庫存盤點｜小時光書店後台" }] }),
  component: InventoryCountPage,
});

function InventoryCountPage() {
  // 統計卡與最近盤點紀錄直接用 loader 的（router 重跑就會更新）；清單依篩選另外抓，
  // 交給 useLoaderBackedList 取兩份裡比較新的。
  const { page: loaderPage, options, summary, recent } = Route.useLoaderData();
  const loaderUpdatedAt = Route.useMatch({ select: (m) => m.updatedAt });
  const router = useRouter();

  const list = useLoaderBackedList({
    key: "inventory-count",
    loaderFilter: DEFAULT_FILTER,
    loaderData: loaderPage,
    loaderUpdatedAt,
    errorMessage: "商品清單讀取失敗",
    fetcher: async (next: CountFilter) => {
      const { listStockCountProducts } = await import("@/lib/admin/fns/inv-adjustments");
      return await listStockCountProducts({ data: next });
    },
  });
  const { filter, data, loading } = list;

  // ⚠️ 正在盤的那一列是點下去那一刻的副本，不從 data 用 id 反查：StockCountDialog 在
  //    product 換掉時會把打到一半的實盤數量清空，背景重抓不可以觸發它。差異本來就由
  //    資料庫用送出當下的庫存算（見檔頭），副本裡的庫存只拿來顯示。
  const [counting, setCounting] = useState<StockCountProductRow | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);

  // 只拿來寫提示文字。真正的 status 是資料庫算的。
  const countApprovalOn = isApprovalRequired(options.approvalSettings, "stock_adjustments");

  function changeFilter(patch: Partial<CountFilter>) {
    // 任何條件變動都回到第一頁 —— 停在第 5 頁再換一個只有 3 頁結果的條件，看到的會是
    // 「沒有資料」而不是「你在第 5 頁」。
    list.setFilter({ ...filter, ...patch, page: 0 });
  }

  /** 盤完之後重抓這一頁，順便讓 loader 重跑（統計卡與最近紀錄在那裡）。 */
  const reloadList = list.reload;
  const refresh = useCallback(async () => {
    await reloadList();
    await router.invalidate();
  }, [reloadList, router]);

  const totalPages = Math.max(1, Math.ceil(data.total / filter.pageSize));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-lg font-medium">
            <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
            庫存盤點
          </h1>
          {countApprovalOn ? (
            <Badge variant="outline" className="font-normal">
              盤點需審核
            </Badge>
          ) : null}
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setBatchOpen(true)}>
          <ClipboardList className="h-4 w-4" />
          批次盤點
        </Button>
      </div>

      <p className="max-w-3xl text-sm text-muted-foreground">
        盤帳面庫存，差異會透過「在庫異動」記錄。填的是<strong>實際數到的數量</strong>，差異由
        系統用送出當下的庫存算 —— 對話框開著的期間櫃檯照樣可以賣，算差異的時機因此不能在瀏覽器。
      </p>

      <StockCountSummaryCards total={data.total} summary={summary} />

      <StockCountFilterBar
        value={filter}
        disabled={loading}
        categories={options.categories}
        onFilterChange={changeFilter}
      />

      {loading ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-border">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : data.rows.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          沒有找到符合的商品
        </div>
      ) : (
        <StockCountTable rows={data.rows} busy={loading} onCount={setCounting} />
      )}

      <ProductPagination
        page={filter.page}
        totalPages={totalPages}
        disabled={loading}
        onPageChange={(page) => list.setFilter({ ...filter, page })}
      />

      <RecentStockCounts rows={recent.rows} />

      <StockCountDialog
        open={counting !== null}
        onOpenChange={(o) => !o && setCounting(null)}
        product={counting}
        approvalOn={countApprovalOn}
        onDone={refresh}
      />

      <BatchStockCountDialog
        open={batchOpen}
        onOpenChange={setBatchOpen}
        approvalOn={countApprovalOn}
        onDone={refresh}
      />
    </div>
  );
}
