/**
 * 後台列表「篩選 → 重抓」的共用狀態（2026-10-25 後台第 2 批）。
 *
 * 取代各頁原本的 `const [rows, setRows] = useState(loaderData)`，修兩件事：
 *
 * 1. **背景重抓看不到**（第 1 批留下的已知問題）：把 loader 資料抄進 useState 之後，
 *    router 在背景重跑 loader（30 秒 staleTime 過期、寫入後 invalidate）拿到的新資料
 *    永遠不會出現在畫面上。現在畫面上的資料是「loader 的」或「依目前篩選自己抓的」
 *    兩份裡**比較新的那一份**（loader 用 match.updatedAt，自己抓的記抓回來的時間），
 *    不再有一份抄出來就不會動的副本。
 *
 * 2. **回到列表時篩選不見**：彈窗改成內頁以後，列表會重新掛載。篩選條件與依篩選抓回來的
 *    資料記在 list-memory.ts（只在這個分頁的記憶體裡），回來時原樣還原，並在背景重抓一次
 *    （內頁可能剛改過東西）。
 *
 * 每一頁要把「篩選條件以外、使用者正在改的東西」（勾選、正在輸入的盤點數）留在自己的
 * useState 裡——這支只管「現在畫面上是哪一批資料」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { stableStringify } from "@/lib/admin/form-dirty";
import { readAdminListMemory, writeAdminListMemory } from "@/lib/admin/list-memory";

type Fetched<D> = { key: string; data: D; at: number };

type Options<F, D> = {
  /** list-memory 的 key，每一頁（每一張列表）不同，例如 "inventory-vendors"。 */
  key: string;
  /** loader 用的篩選條件（loader 的資料就是這個條件的結果）。 */
  loaderFilter: F;
  loaderData: D;
  /** loader 這一份資料是什麼時候拿到的（Route.useMatch().updatedAt）。 */
  loaderUpdatedAt: number;
  fetcher: (filter: F) => Promise<D>;
  errorMessage: string;
};

export function useLoaderBackedList<F, D>({
  key,
  loaderFilter,
  loaderData,
  loaderUpdatedAt,
  fetcher,
  errorMessage,
}: Options<F, D>) {
  const filterKey = `${key}:filter`;
  const dataKey = `${key}:data`;

  const [filter, setFilterState] = useState<F>(
    () => readAdminListMemory<F>(filterKey) ?? loaderFilter,
  );
  const [fetched, setFetched] = useState<Fetched<D> | null>(
    () => readAdminListMemory<Fetched<D>>(dataKey) ?? null,
  );
  const [loading, setLoading] = useState(false);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);

  const currentKey = stableStringify(filter);
  const loaderKey = stableStringify(loaderFilter);

  const fetchedMatches = fetched !== null && fetched.key === currentKey;
  const loaderMatches = currentKey === loaderKey;
  // 兩份都對得上目前的篩選 → 用比較新的那一份。
  const data: D =
    fetchedMatches && (!loaderMatches || fetched.at > loaderUpdatedAt)
      ? fetched.data
      : loaderMatches
        ? loaderData
        : // 篩選換了、新資料還沒回來：先留著舊畫面（loading 會蓋上轉圈圈）。
          (fetched?.data ?? loaderData);

  const load = useCallback(
    async (next: F, opts: { background?: boolean } = {}) => {
      const my = ++seq.current;
      if (!opts.background) setLoading(true);
      try {
        const result = await fetcherRef.current(next);
        if (my !== seq.current) return;
        const entry: Fetched<D> = { key: stableStringify(next), data: result, at: Date.now() };
        setFetched(entry);
        writeAdminListMemory(dataKey, entry);
      } catch (err) {
        if (my === seq.current) toast.error(err instanceof Error ? err.message : errorMessage);
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [dataKey, errorMessage],
  );

  const setFilter = useCallback(
    (next: F) => {
      setFilterState(next);
      writeAdminListMemory(filterKey, next);
      void load(next);
    },
    [filterKey, load],
  );

  // 回到列表時：記住的篩選不是 loader 那一份 → 背景重抓一次（內頁可能剛改過東西）。
  // 還沒有任何資料對得上（理論上不會）才顯示轉圈圈。
  const mountedFilter = useRef(filter);
  useEffect(() => {
    const f = mountedFilter.current;
    if (stableStringify(f) === loaderKey) return;
    void load(f, { background: fetchedMatches });
    // 只在掛載時跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 寫入之後：重抓目前篩選這一份（loader 由呼叫端 router.invalidate()）。 */
  const reload = useCallback(() => load(filter, { background: true }), [filter, load]);

  return { filter, setFilter, data, loading, reload };
}
