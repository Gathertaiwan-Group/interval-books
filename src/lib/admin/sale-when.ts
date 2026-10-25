/**
 * 銷售明細內頁標題下面那一行：銷售日期＋建立時間（台北時間 HH:mm）。
 * 用 taipei-time：內頁會 SSR，toLocaleTimeString 在 Node 與瀏覽器印出來的字不一樣（React #418）。
 */
import { formatTaipeiDateTime } from "@/lib/taipei-time";

export function saleWhen(sale: { sale_date: string; created_at: string | null }): string {
  const time = sale.created_at ? formatTaipeiDateTime(sale.created_at).slice(11) : "";
  return time ? `${sale.sale_date}　${time}` : sale.sale_date;
}
