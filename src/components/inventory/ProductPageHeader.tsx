/**
 * 商品頁頂端的標題列與三顆動作鈕。
 *
 * 「新增需審核 / 調價需審核」兩個徽章讀的是 inv.approval_settings。它們只是**告示**：
 * 真正決定新商品是不是 pending 的是資料庫裡的 inv.initial_approval_status()。
 * 來源系統把那個判斷放在瀏覽器算完再連同 insert 送出去，於是設定還沒載完時
 * 「關掉審核」有時有效有時沒效。
 */
import { Link } from "@tanstack/react-router";
import { FileSpreadsheet, ListChecks, Package, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Props = {
  total: number;
  selectMode: boolean;
  productApprovalOn: boolean;
  priceApprovalOn: boolean;
  onToggleSelectMode: () => void;
  onOpenImport: () => void;
};

export function ProductPageHeader({
  total,
  selectMode,
  productApprovalOn,
  priceApprovalOn,
  onToggleSelectMode,
  onOpenImport,
}: Props) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <Package className="h-5 w-5" aria-hidden="true" />
          商品管理
        </h1>
        <Badge variant="secondary" className="font-normal">
          共 {total.toLocaleString("zh-TW")} 件
        </Badge>
        {productApprovalOn ? (
          <Badge variant="outline" className="font-normal">
            新增需審核
          </Badge>
        ) : null}
        {priceApprovalOn ? (
          <Badge variant="outline" className="font-normal">
            調價需審核
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onToggleSelectMode}>
          <ListChecks className="h-4 w-4" />
          {selectMode ? "結束批次操作" : "批次操作"}
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onOpenImport}>
          <FileSpreadsheet className="h-4 w-4" />
          Excel 匯入
        </Button>
        {/* 新增是內頁（2026-10-25 起不再是彈窗）。 */}
        <Button asChild size="sm" className="gap-1.5">
          <Link to="/admin/inventory-products/new" preload="intent">
            <Plus className="h-4 w-4" />
            新增商品
          </Link>
        </Button>
      </div>
    </div>
  );
}
