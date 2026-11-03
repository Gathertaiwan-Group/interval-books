/**
 * 把一個 PostgREST 查詢分段讀完。
 *
 * Supabase 的 db-max-rows（預設 1000）會**靜默**蓋過 .limit()：寫 .limit(20000) 只會拿回
 * 前 1000 列，合計少算也不會有任何錯誤（2026-11-03 審查 49be28a 抓到：銷售合計、網站訂單
 * 營收、報名人數都中過）。這裡用 .range() 一段一段讀，直到某一段不足一頁為止。
 *
 * 🔴 呼叫端的查詢一定要有**唯一**的排序鍵（例如 id），否則段與段之間的順序不固定，
 *    會重複或漏列。
 *
 * 純函式、不 import Supabase：scripts/read-all-pages-selftest.mjs 用假的查詢模擬
 * 「每次最多回 1000 列」直接測這一支。
 */

/** Supabase PostgREST 的 db-max-rows 預設值。 */
export const POSTGREST_MAX_ROWS = 1000;

type PageResult<T> = PromiseLike<{
  data: T[] | null;
  error: { code?: string; message: string } | null;
}>;

/**
 * @param page   給 [from, to]（含）回一段查詢的函式，例如
 *               `(from, to) => db.from("x").select("a").order("id").range(from, to)`
 * @param opts.pageSize  每段幾列，預設 1000（不要大於 db-max-rows，否則會被截成 1000
 *                       而誤判成「最後一段」）
 * @param opts.maxRows   安全上限，超過就丟例外（不靜默截斷）。預設 200,000。
 */
export async function readAllPages<T>(
  page: (from: number, to: number) => PageResult<T>,
  opts: { pageSize?: number; maxRows?: number; label?: string } = {},
): Promise<T[]> {
  const size = Math.min(opts.pageSize ?? POSTGREST_MAX_ROWS, POSTGREST_MAX_ROWS);
  const maxRows = opts.maxRows ?? 200_000;
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) {
      throw new Error(
        `${opts.label ?? "readAllPages"} 讀取失敗：${error.code ?? ""} ${error.message}`,
      );
    }
    const rows = data ?? [];
    out.push(...rows);
    if (out.length > maxRows) {
      throw new Error(`${opts.label ?? "readAllPages"} 超過 ${maxRows} 列，請縮小查詢範圍`);
    }
    if (rows.length < size) return out;
  }
}
