/**
 * 進貨頁的「完整商品清單」——只有 Excel 匯入與拍照辨識要用，打開那兩個入口時才抓
 * （2026-10-26 後台第 3 批：不再隨列表頁的 loader 一起載入，約 385 KB）。
 *
 * 每次打開都重抓一次：匯入可能剛建了新商品、別的店員可能剛新增品項，比對要對著最新的清單。
 * 🔴 呼叫端要等 load() 回來（拿到清單）才打開對話框：清單還沒到就拿空陣列去比對，每一列都會被
 *    當成新商品，匯入時就多建一堆重複的品項。
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import type { ProductPickerRow } from "@/server/repos/inv-purchases";

export function usePickerProducts() {
  const [products, setProducts] = useState<ProductPickerRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef<Promise<ProductPickerRow[] | null> | null>(null);

  const load = useCallback(async (): Promise<ProductPickerRow[] | null> => {
    if (inflight.current) return inflight.current;
    setLoading(true);
    const run = (async () => {
      try {
        const { listProductPickerRows } = await import("@/lib/admin/fns/inv-purchases");
        const rows = await listProductPickerRows();
        setProducts(rows);
        return rows;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "商品清單讀取失敗，請再試一次");
        return null;
      } finally {
        setLoading(false);
        inflight.current = null;
      }
    })();
    inflight.current = run;
    return run;
  }, []);

  return { products, loading, load };
}
