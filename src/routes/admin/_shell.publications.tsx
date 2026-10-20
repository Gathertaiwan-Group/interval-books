/**
 * /admin/publications —— 只剩轉址。
 *
 * 2026-10-20 地方刊物展併進後台「商品」單一頁（src/routes/admin/_shell.products.tsx）
 * 的「地方刊物」分頁：校稿、換封面、上下架、連到庫存商品／解除連結都在那裡，表單本身
 * 搬到 src/components/admin/products/PublicationForms.tsx。舊網址留一個轉址，書籤與
 * 對話紀錄裡的連結照樣到得了。對應表在
 * src/lib/admin/unified-products.ts#LEGACY_ADMIN_REDIRECTS，自檢守著兩者一致。
 *
 * 沒有 component —— beforeLoad 先丟出去，元件永遠不會被畫出來。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/_shell/publications")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/products", search: { type: "publication" }, replace: true });
  },
});
