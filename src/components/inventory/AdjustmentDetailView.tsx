/**
 * 在庫異動單詳情（唯讀）＋ 依狀態出現的動作 —— /admin/inventory-adjustments/$id 的內容。
 *
 * 2026-10-26 從 AdjustmentDetailDialog 改成內頁（後台第 3 批；業主：「不要用彈窗，直接顯示內頁＆
 * 回到上一頁」）。欄位與按鈕出現的條件一個都沒變。
 *
 * ⚠️ 沖帳關係印的是**單號**不是 UUID。來源的詳情頁直接印 `reversal_of`，店員看到的是
 *    一串 36 個字的亂碼。0017 的 view 已經把它 join 成 reversal_of_number 了。
 *
 * ⚠️ 沒有 approve_stock_adjustments 的人看不到審核按鈕，但那**只是畫面**。真正擋住
 *    直接 POST /_serverFn/… 的是 fns/inv-adjustments.ts 裡 approveRecord 那一次權限
 *    檢查（而且它重讀 staff_permissions，不信任前端送來的任何東西）。
 *
 * ⚠️ 三個破壞性動作（刪除草稿、退回、沖帳）不在這裡直接執行 —— 它們往上丟給頁面的
 *    AdjustmentConfirmDialog 再問一次。
 *
 * 時間用 taipei-time：內頁會 SSR，toLocaleString 在 Node 多一個 THIN SPACE（React #418）。
 */
import type { ReactNode } from "react";
import { CheckCircle2, Loader2, RefreshCw, RotateCcw, Send, Trash2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  adjustmentIsReversible,
  categoryLabel,
  categoryVariant,
  reasonLabel,
  statusLabel,
  statusVariant,
} from "@/lib/admin/inv-adjustment-labels";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import type { AdminAdjustmentRow } from "@/server/repos/inv-adjustments";

function money(n: number | null) {
  return n === null || n === undefined ? "—" : `NT$ ${Number(n).toLocaleString("zh-TW")}`;
}

function when(iso: string | null) {
  return iso ? formatTaipeiDateTime(iso) : "—";
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/** 標題旁的徽章：類別、狀態、沖帳關係。 */
export function AdjustmentBadges({ row }: { row: AdminAdjustmentRow }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-sm font-normal">
      <Badge variant={categoryVariant(row.category)} className="font-normal">
        {categoryLabel(row.category)}
      </Badge>
      <Badge variant={statusVariant(row.status)} className="font-normal">
        {statusLabel(row.status)}
      </Badge>
      {row.reversal_of ? (
        <Badge variant="outline" className="font-normal">
          沖帳單
        </Badge>
      ) : null}
      {row.reversed_by_id ? (
        <Badge variant="outline" className="font-normal">
          已被沖帳
        </Badge>
      ) : null}
    </span>
  );
}

type ActionProps = {
  row: AdminAdjustmentRow;
  canApprove: boolean;
  busy: boolean;
  onSubmit: (row: AdminAdjustmentRow) => void;
  onApprove: (row: AdminAdjustmentRow) => void;
  onResubmit: (row: AdminAdjustmentRow) => void;
  /** 破壞性動作：交給頁面開 AlertDialog 再問一次。 */
  onAskDelete: (row: AdminAdjustmentRow) => void;
  onAskReject: (row: AdminAdjustmentRow) => void;
  onAskReverse: (row: AdminAdjustmentRow) => void;
};

/**
 * 依狀態出現的動作（AdminDetailPage 的 actions：md 以上在右上，手機黏在底部）。
 * 呼叫端先用 adjustmentHasActions() 判斷有沒有任何一顆，沒有就不要畫（手機底部會多一條空的列）。
 */
export function AdjustmentActions({
  row,
  canApprove,
  busy,
  onSubmit,
  onApprove,
  onResubmit,
  onAskDelete,
  onAskReject,
  onAskReverse,
}: ActionProps) {
  const reversible = adjustmentIsReversible(row);

  return (
    <>
      {row.status === "draft" ? (
        <>
          <Button
            variant="outline"
            className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
            disabled={busy}
            onClick={() => onAskDelete(row)}
          >
            <Trash2 className="h-4 w-4" />
            刪除草稿
          </Button>
          <Button className="gap-1.5" disabled={busy} onClick={() => onSubmit(row)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            送出
          </Button>
        </>
      ) : null}

      {row.status === "pending_approval" && canApprove ? (
        <>
          <Button
            variant="outline"
            className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
            disabled={busy}
            onClick={() => onAskReject(row)}
          >
            <XCircle className="h-4 w-4" />
            退回
          </Button>
          <Button
            variant="outline"
            className="gap-1.5 border-emerald-600/40 text-emerald-700 hover:bg-emerald-600/10"
            disabled={busy}
            onClick={() => onApprove(row)}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            審核通過
          </Button>
        </>
      ) : null}

      {row.status === "rejected" ? (
        <Button
          variant="outline"
          className="gap-1.5"
          disabled={busy}
          onClick={() => onResubmit(row)}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          重新送審
        </Button>
      ) : null}

      {reversible ? (
        <Button
          variant="outline"
          className="gap-1.5"
          disabled={busy}
          onClick={() => onAskReverse(row)}
        >
          <RotateCcw className="h-4 w-4" />
          沖帳
        </Button>
      ) : null}
    </>
  );
}

export function AdjustmentDetailView({
  row,
  canApprove,
}: {
  row: AdminAdjustmentRow;
  canApprove: boolean;
}) {
  return (
    <div className="space-y-4 rounded-md border border-border p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="異動日期">{row.adjustment_date}</Field>
        <Field label="商品">
          {row.product_name ?? "未知商品"}
          {row.issue_number ? ` #${row.issue_number}` : ""}
        </Field>
        <Field label="系列 / 分類">
          {[row.series, row.category_name].filter(Boolean).join(" ・ ") || "—"}
        </Field>
        <Field label="異動數量">
          <span
            className={
              row.quantity < 0 ? "font-medium text-destructive" : "font-medium text-emerald-700"
            }
          >
            {row.quantity > 0 ? "+" : ""}
            {row.quantity}
          </span>
        </Field>
        <Field label="異動前庫存">
          {row.stock_before === null ? "—" : `${row.stock_before} 件`}
        </Field>
        <Field label="目前庫存">
          {row.product_stock_quantity === null ? "—" : `${row.product_stock_quantity} 件`}
        </Field>
        <Field label="單位成本">{money(row.unit_cost)}</Field>
        <Field label="異動總成本">{money(row.total_cost)}</Field>
        <Field label="原因">{reasonLabel(row.reason)}</Field>
      </div>

      {row.notes ? (
        <>
          <Separator />
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">備註</p>
            <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-sm">{row.notes}</p>
          </div>
        </>
      ) : null}

      <Separator />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="建立者">
          {row.creator_name ?? "—"}・{when(row.created_at)}
        </Field>
        <Field label="審核">
          {row.approved_at
            ? `${row.approved_by_name ?? "—"}・${when(row.approved_at)}`
            : "尚未審核"}
        </Field>
        <Field label="沖帳原單">
          {row.reversal_of_number ? (
            <span className="font-mono">{row.reversal_of_number}</span>
          ) : (
            "—"
          )}
        </Field>
        <Field label="已被哪一張沖掉">
          {row.reversed_by_number ? (
            <span className="font-mono">{row.reversed_by_number}</span>
          ) : (
            "—"
          )}
        </Field>
      </div>

      {row.status === "pending_approval" && !canApprove ? (
        <p className="text-xs text-muted-foreground">
          這張單在等審核，但你沒有審核權限（approve_stock_adjustments）。請找管理員授權，
          或請有權限的同事處理。
        </p>
      ) : null}
    </div>
  );
}
