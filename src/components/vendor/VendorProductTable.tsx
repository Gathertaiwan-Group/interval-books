/**
 * 廠商自己的商品清單。
 *
 * ── 這張表在解什麼問題 ────────────────────────────────────────────────────
 * 廠商送出一件商品之後只有三個問題，而三個問題的答案落在不同的欄位：
 *   1.「我送的那件現在怎麼樣了」→ 狀態徽章（待審核／已核准／已退回）
 *   2.「核准的那些賣掉幾本、還剩幾本」→ 已售／庫存
 *   3.「客人在網站上找得到嗎」→ 上架（listed_slug / listed_status）
 *
 * 第 2、3 兩欄**只有 approved 的列才有意義**：待審核的商品庫存一定是 0（0019
 * §7.7 寫死的），把 0 印在待審核那一列旁邊，廠商會讀成「我的書賣完了」。所以那兩
 * 欄在非 approved 的列印「—」，不印數字。
 *
 * ── 哪裡容易寫錯 ──────────────────────────────────────────────────────────
 * ⚠️ 「可以改」的條件是**兩個**，不是一個：approval_status === 'pending' **而且**
 *    submitted_via === 'vendor_portal'。少檢查第二個的話，店員在後台代廠商建立、
 *    還沒審完的那一件也會長出「修改」按鈕 —— 那件的欄位是店員填的，廠商改掉會把
 *    店員的輸入蓋掉，而且沒有人會知道。canVendorEdit() 是這條規則的唯一出處，
 *    表格與頁面都從這裡拿，不要在呼叫端各寫一次。
 *
 * ⚠️ 已核准之後一律唯讀，而且畫面上要**寫出理由**。一件商品被核准就變成書店的庫存
 *    主檔：有成本、有庫存異動、可能已經上架、可能已經賣掉幾本。按鈕默默消失的話
 *    廠商只會打電話來問「為什麼不能改了」，所以那一格印的是一句話而不是空白。
 *
 * ⚠️ 這張表**不是授權**。canVendorEdit() 只決定畫面上有沒有那顆按鈕。真正擋住直接
 *    POST /_serverFn/… 的是 vendorFnMiddleware()，加上資料庫函式 WHERE 裡的
 *    `vendor_id = vendor_my_id(p_user_id)` —— 見 lib/admin/fns/vendor-portal.ts 檔頭。
 */
import { CheckCircle2, Clock, HelpCircle, Loader2, Pencil, Undo2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { VendorPortalProduct } from "@/server/repos/inv-vendors";

/**
 * 廠商還能不能動這一件。**兩個條件缺一不可**，理由見檔頭。
 *
 * 這是畫面規則，不是授權規則 —— 資料庫那一支 inv_vendor_submit_product 自己也會
 * 再判一次，改到別人的或已核准的會打不中任何列。
 */
function canVendorEdit(row: VendorPortalProduct): boolean {
  return row.approval_status === "pending" && row.submitted_via === "vendor_portal";
}

/** 不能改的時候，把「為什麼」講出來。空白會變成客服電話。 */
function readOnlyReason(row: VendorPortalProduct): string {
  if (row.approval_status === "approved") return "已核准，由書店維護";
  if (row.approval_status === "rejected") return "已退回，請聯絡書店";
  if (row.submitted_via !== "vendor_portal") return "由書店代為建立";
  return "目前無法修改";
}

/**
 * 狀態徽章。
 *
 * 認不出來的值**照樣印出來**（灰底），不要 return null —— 一個 approval_status 打錯
 * 的商品如果什麼都不顯示，看起來會跟「已核准」一模一樣。這與
 * components/inventory/ApprovalStatusBadge.tsx 是同一條理由，但文案不同：廠商這一
 * 側講「已核准」（店家核准了你送的東西），後台那一側講「已審核」。
 */
function VendorApprovalBadge({ status }: { status: string }) {
  if (status === "approved") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-600/30 font-normal text-emerald-700">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        已核准
      </Badge>
    );
  }
  if (status === "rejected") {
    return (
      <Badge variant="destructive" className="gap-1 font-normal">
        <XCircle className="h-3 w-3" aria-hidden="true" />
        已退回
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge variant="secondary" className="gap-1 font-normal">
        <Clock className="h-3 w-3" aria-hidden="true" />
        待審核
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
      <HelpCircle className="h-3 w-3" aria-hidden="true" />
      {status}
    </Badge>
  );
}

/** 上架狀態。listed_slug 是 null 就是還沒上架 —— 那是常態，不是錯誤。 */
function ListedCell({ row }: { row: VendorPortalProduct }) {
  if (row.approval_status !== "approved") {
    return <span className="text-muted-foreground">—</span>;
  }
  if (!row.listed_slug) {
    return <span className="text-xs text-muted-foreground">未上架</span>;
  }
  const active = row.listed_status === "active";
  return (
    <div className="space-y-1">
      <Badge variant={active ? "outline" : "secondary"} className="font-normal">
        {active ? "已上架" : (row.listed_status ?? "未知狀態")}
      </Badge>
      <p className="truncate font-mono text-xs text-muted-foreground">{row.listed_slug}</p>
    </div>
  );
}

function priceText(value: number | null): string {
  if (value === null) return "—";
  return `NT$ ${Number(value).toLocaleString("zh-TW")}`;
}

type Props = {
  rows: VendorPortalProduct[];
  /** 正在送出的那一列（撤回中）。null = 沒有動作在跑。 */
  busyId: string | null;
  onEdit: (row: VendorPortalProduct) => void;
  onWithdraw: (row: VendorPortalProduct) => void;
};

export function VendorProductTable({ rows, busyId, onEdit, onWithdraw }: Props) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-56">商品</TableHead>
            <TableHead className="w-40">系列 / 期數</TableHead>
            <TableHead className="w-28">狀態</TableHead>
            <TableHead className="w-32 text-right">建議售價</TableHead>
            <TableHead className="w-24 text-right">庫存</TableHead>
            <TableHead className="w-24 text-right">已售</TableHead>
            <TableHead className="w-32">上架</TableHead>
            <TableHead className="w-44 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const editable = canVendorEdit(row);
            const busy = busyId === row.inv_product_id;
            const approved = row.approval_status === "approved";
            return (
              <TableRow key={row.inv_product_id}>
                <TableCell>
                  <div className="space-y-1">
                    <p className="font-medium">{row.name}</p>
                    {row.publisher ? (
                      <p className="text-xs text-muted-foreground">{row.publisher}</p>
                    ) : null}
                    {row.barcode ? (
                      <p className="font-mono text-xs text-muted-foreground">{row.barcode}</p>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  {[row.series, row.issue_number ? `NO.${row.issue_number}` : null]
                    .filter(Boolean)
                    .join(" ・ ") || "—"}
                </TableCell>
                <TableCell>
                  <VendorApprovalBadge status={row.approval_status} />
                </TableCell>
                <TableCell className="text-right text-sm">{priceText(row.selling_price)}</TableCell>
                {/* 庫存與已售只有核准之後才是真的數字，見檔頭。 */}
                <TableCell className="text-right text-sm">
                  {/* 不限庫存（0063）：賣出照扣會變負數，數字沒有意義，顯示「不限量」。 */}
                  {!approved
                    ? "—"
                    : row.unlimited_stock
                      ? "不限量"
                      : row.stock_quantity.toLocaleString("zh-TW")}
                </TableCell>
                <TableCell className="text-right text-sm">
                  {approved ? row.sold_quantity.toLocaleString("zh-TW") : "—"}
                </TableCell>
                <TableCell>
                  <ListedCell row={row} />
                </TableCell>
                <TableCell className="text-right">
                  {editable ? (
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={busy}
                        onClick={() => onEdit(row)}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        修改
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5"
                        disabled={busy}
                        onClick={() => onWithdraw(row)}
                      >
                        {busy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        撤回
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">{readOnlyReason(row)}</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
