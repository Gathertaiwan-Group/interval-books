/**
 * 商品清單的「篩選 → 重抓 → 同步」那一組狀態。
 *
 * 與 useProductActions（寫入動作）並排：那一支管「按下去會發生什麼」，這一支管
 * 「畫面上現在是哪一頁」。拆開的理由與 4b 拆 usePurchaseActions 相同 —— route 檔
 * 的 300 行上限不是為了好看，是為了讓下一次「順手加一點」不會把它長回來源那種
 * 1,597 行的樣子。
 *
 * 2026-10-25 後台第 2 批（詳細／編輯改成內頁）：資料與篩選改走共用的 useLoaderBackedList，
 * 不再把 loader 那一頁抄進 useState —— 抄出來的副本看不到背景重抓（30 秒 staleTime、
 * 寫入後 invalidate），而且從內頁「← 回到列表」時篩選與頁碼會回到預設值。現在兩者都記在
 * list-memory（只在這個分頁的記憶體裡），回來原樣還原。
 * **勾選**不是篩選，留在這裡的 useState：它是「使用者正在做的事」，不該跨頁記住。
 *
 * ⚠️ 這個專案**沒有 react-query**。寫入之後重抓就是唯一的同步方式，而且要兩段：
 *    reload() 重抓這一頁的資料，router.invalidate() 重跑 loader（母品項候選與
 *    審核設定放在那裡）。少做第二段的話，改完審核設定畫面上的提示不會更新。
 */
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useLoaderBackedList } from "@/lib/admin/useLoaderBackedList";
import type { ProductFilterValues } from "@/lib/admin/schemas";
import type { AdminProductRow } from "@/server/repos/inv-products";

type Page = { rows: AdminProductRow[]; total: number };

type Options = {
  /** loader 拿到的第一頁（defaultFilter 的結果）。 */
  loaderPage: Page;
  /** Route.useMatch({ select: (m) => m.updatedAt })。 */
  loaderUpdatedAt: number;
  defaultFilter: ProductFilterValues;
};

export function useProductListState({ loaderPage, loaderUpdatedAt, defaultFilter }: Options) {
  const router = useRouter();

  const list = useLoaderBackedList({
    key: "inventory-products",
    loaderFilter: defaultFilter,
    loaderData: loaderPage,
    loaderUpdatedAt,
    errorMessage: "商品清單讀取失敗",
    fetcher: async (next: ProductFilterValues) => {
      const { listAdminProducts } = await import("@/lib/admin/fns/inv-products");
      return await listAdminProducts({ data: next });
    },
  });
  const { filter, data, loading, setFilter, reload } = list;

  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  /** 換篩選條件時把勾選清掉 —— 留著會讓「已選 3 筆」指向看不見的列。 */
  const changeFilter = useCallback(
    (next: ProductFilterValues) => {
      setFilter(next);
      setSelectedIds([]);
    },
    [setFilter],
  );

  const changePage = useCallback(
    (page: number) => {
      setFilter({ ...filter, page });
    },
    [filter, setFilter],
  );

  /** 寫入之後重抓目前這一頁，並讓 loader 重跑。 */
  const refresh = useCallback(async () => {
    await reload();
    await router.invalidate();
  }, [reload, router]);

  const rowsById = useMemo(() => {
    const map = new Map<string, AdminProductRow>();
    for (const r of data.rows) map.set(r.inv_product_id, r);
    return map;
  }, [data.rows]);

  const selectedPending = useMemo(
    () => selectedIds.filter((id) => rowsById.get(id)?.approval_status === "pending"),
    [selectedIds, rowsById],
  );

  const totalPages = Math.max(1, Math.ceil(data.total / filter.pageSize));

  return {
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
  };
}
