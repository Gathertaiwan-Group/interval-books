/**
 * 「新增的一筆要排在哪裡」—— 後台幾張以 sort_order 排序的清單共用。
 *
 * 前台（src/lib/cms.ts 的 select(..., { order: "sort_order" })）一律**由小到大**排。
 * 以前新增時給的是 max + 1，於是剛新增的最新消息永遠落在網站最底下，店長以為沒有
 * 發布成功。改成 min − 1：新的一筆自動排到最前面，不需要店長去改排序數字。
 *
 * 會變成負數是預期中的事 —— news／collaborations 的 sort_order 是一般 integer，
 * 沒有 CHECK、沒有 unique（只有 curated_items 與 page_list_items 有 unique，那兩張
 * 不走這支）。zod 那一側也只要求整數（src/lib/admin/schemas.ts）。
 *
 * 空清單回 0：與資料庫欄位的 default 一致。
 */
export function newFirstSortOrder(rows: readonly { sort_order: number }[]): number {
  if (rows.length === 0) return 0;
  let min = rows[0].sort_order;
  for (const r of rows) if (r.sort_order < min) min = r.sort_order;
  return min - 1;
}
