/**
 * 廠商清單。
 *
 * ── 這張表在解什麼問題 ────────────────────────────────────────────────────
 * 廠商是這個系統裡唯一同時牽到「錢」與「個資」的主檔：一家廠商後面掛著商品、進貨、
 * 退貨、寄售抽成，還有身分證字號與匯款帳號。所以這張表要在一眼之內回答兩件事：
 *
 *   1. **這家能不能刪？** product_count / purchase_count / portal_account_count
 *      三個數字直接印在列上，而不是等按下刪除才被資料庫擋回來。inv_delete_vendor()
 *      會擋，但「按了才知道不行」是最差的順序 —— 解約要改往來狀態，不是刪除。
 *   2. **這家的識別碼有沒有填？** 有填就顯示遮罩（tax_id_masked / id_number_masked）。
 *
 * ⚠️ **這裡顯示的識別碼永遠是遮罩，而且它不是「密碼被星號蓋住」那種遮罩** ——
 *    view 那一層根本沒有把完整值送到瀏覽器（0019 §3.1 只 select 出 *_masked）。
 *    要看完整號碼只有一條路：VendorSensitiveDialog → readVendorSensitive()，
 *    而那一條路一定留下 pii_access_log。
 *
 * ⚠️ `canApprove` / `canReadPii` 只控制**畫面**。按鈕變灰不是授權 —— 擋住直接
 *    POST /_serverFn/… 的是 fns/inv-vendors.ts 裡的 requirePermission()，它從
 *    staff_permissions 重讀權限，不信任前端送來的任何東西。這裡把按鈕做成
 *    disabled 而不是整個拿掉，是為了讓沒有權限的人看得到「有這個動作，但我不能
 *    做」，而不是以為系統壞了。
 *
 * ⚠️ 廠商沒有「重新送審」：inv_save_vendor() 的 UPDATE 分支不碰 approval_status，
 *    inv_approve_record() 也只吃 pending。所以 ApprovalActions 只在 pending 時
 *    才渲染，onResubmit 是一個永遠不會被呼叫到的 no-op（見下面那一行註解）。
 */
import { Eye, KeyRound, Pencil, Trash2 } from "lucide-react";
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
import { ApprovalActions } from "@/components/inventory/ApprovalActions";
import { ApprovalStatusBadge } from "@/components/inventory/ApprovalStatusBadge";
import {
  VENDOR_ENTITY_TYPES,
  VENDOR_ENTITY_TYPE_LABELS,
  VENDOR_STATUSES,
  VENDOR_STATUS_LABELS,
} from "@/lib/admin/schemas";
import type { AdminVendorRow } from "@/server/repos/inv-vendors";

// view 回傳的是 text，schemas 那邊的 enum 才是值域。認不出來的值原樣印出去 ——
// 與 ApprovalStatusBadge 同一條規矩：看到奇怪的字會有人來問，看不到東西不會。
type VendorEntityType = (typeof VENDOR_ENTITY_TYPES)[number];
type VendorStatus = (typeof VENDOR_STATUSES)[number];

type Props = {
  rows: AdminVendorRow[];
  busyId: string | null;
  canApprove: boolean;
  canReadPii: boolean;
  onView: (row: AdminVendorRow) => void;
  onEdit: (row: AdminVendorRow) => void;
  onAskDelete: (row: AdminVendorRow) => void;
  onReadSensitive: (row: AdminVendorRow) => void;
  onApprove: (row: AdminVendorRow) => void;
  onReject: (row: AdminVendorRow) => void;
};

/**
 * 0–1 的小數 → 給人看的百分比。
 *
 * DB 存的是 0.08，畫面要寫 8%。乘 100 之後用 toFixed(2) 再把尾巴的零去掉，
 * 是因為 0.1115 × 100 在 IEEE 754 下會變成 11.150000000000002。
 */
function percent(rate: number | null): string {
  if (rate === null) return "—";
  return `${Number((rate * 100).toFixed(2))}%`;
}

/** 清單只拿得到遮罩版。哪一個有值就顯示哪一個 —— 一家廠商依實體類型只會填一種。 */
function maskedIdentity(row: AdminVendorRow): string {
  if (row.tax_id_masked) return row.tax_id_masked;
  if (row.id_number_masked) return row.id_number_masked;
  if (row.has_foreign_id) return "已填國外識別碼";
  return "—";
}

function entityLabel(value: string): string {
  return VENDOR_ENTITY_TYPE_LABELS[value as VendorEntityType] ?? value;
}

function statusLabel(value: string): string {
  return VENDOR_STATUS_LABELS[value as VendorStatus] ?? value;
}

export function VendorTable({
  rows,
  busyId,
  canApprove,
  canReadPii,
  onView,
  onEdit,
  onAskDelete,
  onReadSensitive,
  onApprove,
  onReject,
}: Props) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-48">廠商</TableHead>
            <TableHead className="w-28">類型</TableHead>
            <TableHead className="w-32">識別碼</TableHead>
            <TableHead className="w-28">寄售／抽成</TableHead>
            <TableHead className="min-w-36">往來資料</TableHead>
            <TableHead className="w-40">狀態</TableHead>
            <TableHead className="w-80 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const busy = busyId === row.vendor_id;
            // 有任何一種往來資料就刪不掉（inv_delete_vendor 會擋）。先在畫面上講。
            const linked = row.product_count + row.purchase_count + row.portal_account_count > 0;

            return (
              <TableRow key={row.vendor_id} className={busy ? "opacity-60" : undefined}>
                <TableCell>
                  <div className="space-y-0.5">
                    {/* ⚠️ 這一層是 <div> 不是 <p>：Badge 是 <div>，<p> 裡放 <div> 是不合法的
                        HTML，瀏覽器解析 SSR 的 HTML 時會先把 <p> 關掉，結構跟 React 的不一樣
                        → hydration 失敗（React #418，參數 HTML）。 */}
                    <div className="text-sm font-medium">
                      {row.name}
                      {row.is_preferred ? (
                        <Badge variant="secondary" className="ml-1.5 font-normal">
                          優先
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {row.vendor_code ?? "（未編號）"}
                      {row.short_name ? `・${row.short_name}` : ""}
                      {row.category_name ? `・${row.category_name}` : ""}
                    </p>
                    {row.name_en ? (
                      <p className="line-clamp-1 text-xs text-muted-foreground">{row.name_en}</p>
                    ) : null}
                  </div>
                </TableCell>

                <TableCell>
                  <Badge variant="outline" className="font-normal">
                    {entityLabel(row.entity_type)}
                  </Badge>
                </TableCell>

                <TableCell>
                  <span
                    className="text-xs tabular-nums text-muted-foreground"
                    title="遮罩值。完整號碼要走「查看完整號碼」，而且會留下紀錄"
                  >
                    {maskedIdentity(row)}
                  </span>
                </TableCell>

                <TableCell>
                  <div className="space-y-0.5">
                    <Badge
                      variant={row.is_consignment ? "default" : "outline"}
                      className="font-normal"
                    >
                      {row.is_consignment ? "寄售" : "買斷"}
                    </Badge>
                    {row.is_consignment ? (
                      <p className="text-xs tabular-nums text-muted-foreground">
                        抽成 {percent(row.commission_rate)}
                      </p>
                    ) : null}
                  </div>
                </TableCell>

                <TableCell>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    商品 {row.product_count}・進貨 {row.purchase_count}
                  </p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    入口帳號 {row.portal_account_count}・附件 {row.attachment_count}
                  </p>
                </TableCell>

                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge
                      variant={row.status === "active" ? "default" : "outline"}
                      className="font-normal"
                    >
                      {statusLabel(row.status)}
                    </Badge>
                    <ApprovalStatusBadge status={row.approval_status} />
                  </div>
                </TableCell>

                <TableCell>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {row.approval_status === "pending" ? (
                      <ApprovalActions
                        status={row.approval_status}
                        canApprove={canApprove}
                        busy={busy}
                        productName={row.name}
                        permissionName="approve_vendors"
                        onApprove={() => onApprove(row)}
                        onReject={() => onReject(row)}
                        // 廠商沒有 resubmit server fn，而外層已經用 pending 擋住，
                        // 所以 ApprovalActions 的 rejected 分支不可能被走到。
                        onResubmit={() => undefined}
                      />
                    ) : null}

                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={busy}
                      onClick={() => onView(row)}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      詳情
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={busy || !canReadPii}
                      // ⚠️ disabled 不是授權。真正擋住的是 readVendorSensitive 那一支
                      //    server fn 的 inv.vendor.pii.read 檢查（fns/inv-vendors.ts）。
                      title={
                        canReadPii
                          ? "查看完整號碼（會留下查閱紀錄）"
                          : "需要「inv.vendor.pii.read」權限"
                      }
                      onClick={() => onReadSensitive(row)}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      完整號碼
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={busy}
                      onClick={() => onEdit(row)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      編輯
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
                      disabled={busy}
                      title={
                        linked
                          ? "這家還有往來資料，資料庫會擋下刪除 —— 解約請改往來狀態"
                          : undefined
                      }
                      onClick={() => onAskDelete(row)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      刪除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
