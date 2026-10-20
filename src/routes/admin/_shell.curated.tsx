/**
 * /admin/curated —— 只剩轉址。
 *
 * 2026-10-20 選品併進後台「商品」單一頁（src/routes/admin/_shell.products.tsx）的
 * 「選品」分頁；主題的增刪改與品項排序搬到 /admin/products/curated-themes。
 * 舊網址留一個轉址，書籤與對話紀錄裡的連結照樣到得了。對應表在
 * src/lib/admin/unified-products.ts#LEGACY_ADMIN_REDIRECTS，自檢守著兩者一致。
 *
 * 沒有 component —— beforeLoad 先丟出去，元件永遠不會被畫出來。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/_shell/curated")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/products", search: { type: "curated" }, replace: true });
  },
});
