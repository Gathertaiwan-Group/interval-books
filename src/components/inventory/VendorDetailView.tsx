/**
 * 廠商詳情的內容（唯讀）——/admin/inventory-vendors/$id 內頁的本體。
 *
 * 2026-10-25 從 VendorDetailDialog 改成內頁：不再自己 fetch，資料由 route loader 給
 * （與編輯頁共用同一個 loader）。詳情是拿來做決定的地方（要不要核准、要不要匯款），
 * loader 每次進來都會重抓（30 秒快取，寫入後立刻清），看得到別人剛改的內容。
 *
 * ⚠️ 這裡的識別碼與匯款帳號**永遠是遮罩**。完整號碼只有 VendorSensitiveDialog 那一條
 *    路，而那一條路會留下 pii_access_log。這裡不放「顯示完整號碼」的捷徑 —— 稽核軌跡
 *    只要有一條旁路就等於沒有。
 */
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ApprovalStatusBadge } from "@/components/inventory/ApprovalStatusBadge";
import { VendorDetailChildLists } from "@/components/inventory/VendorDetailChildLists";
import {
  VENDOR_ENTITY_TYPES,
  VENDOR_ENTITY_TYPE_LABELS,
  VENDOR_STATUSES,
  VENDOR_STATUS_LABELS,
} from "@/lib/admin/schemas";
import type {
  AdminVendorAttachment,
  AdminVendorBankAccount,
  AdminVendorContact,
  AdminVendorDetail,
  AdminVendorRow,
} from "@/server/repos/inv-vendors";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function when(iso: string | null) {
  // SSR 與瀏覽器要印出一樣的字（toLocaleString 在 Node 會多一個 THIN SPACE → React #418）。
  return iso ? formatTaipeiDateTime(iso) : "—";
}

/** 0–1 小數 → 百分比字串。toFixed 是為了躲 0.1115 × 100 = 11.150000000000002。 */
function percent(rate: number | null): string {
  if (rate === null) return "—";
  return `${Number((rate * 100).toFixed(2))}%`;
}

function label<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
  value: string | null,
): string {
  if (value === null) return "—";
  const found = values.find((v) => v === value);
  // 認不出來就原樣印出去（與 ApprovalStatusBadge 同一條規矩）。
  return found ? labels[found] : value;
}

/** 標題下面那一排徽章（內頁標題列與 loader 還在跑時的 pendingComponent 共用）。 */
export function VendorBadges({ row }: { row: AdminVendorRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline" className="font-normal">
        {label(VENDOR_ENTITY_TYPES, VENDOR_ENTITY_TYPE_LABELS, row.entity_type)}
      </Badge>
      <Badge variant={row.status === "active" ? "default" : "outline"} className="font-normal">
        {label(VENDOR_STATUSES, VENDOR_STATUS_LABELS, row.status)}
      </Badge>
      <ApprovalStatusBadge status={row.approval_status} />
      <Badge variant={row.is_consignment ? "default" : "outline"} className="font-normal">
        {row.is_consignment ? "寄售" : "買斷"}
      </Badge>
    </div>
  );
}

export function VendorDetailView({
  row,
  detail,
  contacts,
  bankAccounts,
  attachments,
}: {
  row: AdminVendorRow;
  detail: AdminVendorDetail;
  contacts: AdminVendorContact[];
  bankAccounts: AdminVendorBankAccount[];
  attachments: AdminVendorAttachment[];
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="英文名稱">{detail.name_en ?? "—"}</Field>
        <Field label="負責人">{detail.representative ?? "—"}</Field>
        <Field label="建立者">{detail.creator_name ?? "—"}</Field>
        {/* ⚠️ 全部是遮罩。完整號碼走「完整號碼」按鈕，那會留下紀錄。 */}
        <Field label="統一編號">{detail.tax_id_masked ?? "—"}</Field>
        <Field label="身分證字號">{detail.id_number_masked ?? "—"}</Field>
        <Field label="國外識別碼">{detail.foreign_id_masked ?? "—"}</Field>
        <Field label="居留證號碼">{detail.residence_permit_number_masked ?? "—"}</Field>
        <Field label="審核者">{detail.approved_by_name ?? "—"}</Field>
        <Field label="審核時間">{when(detail.approved_at)}</Field>
      </div>

      <Separator />

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="電話">{detail.phone ?? "—"}</Field>
        <Field label="傳真">{detail.fax ?? "—"}</Field>
        <Field label="電子郵件">{detail.email ?? "—"}</Field>
        <Field label="地址">{detail.address ?? "—"}</Field>
        <Field label="發票寄送地址">{detail.invoice_address ?? "—"}</Field>
        <Field label="英文地址">{detail.address_en ?? "—"}</Field>
      </div>

      <Separator />

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="現金手續費">{percent(detail.cash_fee_rate)}</Field>
        <Field label="國內刷卡">{percent(detail.domestic_card_fee_rate)}</Field>
        <Field label="國外刷卡">{percent(detail.foreign_card_fee_rate)}</Field>
        <Field label="寄售抽成">{percent(detail.commission_rate)}</Field>
        <Field label="結算起算日">{detail.settlement_start_day ?? "—"}</Field>
        <Field label="結算週期">
          {detail.settlement_interval_days === null ? "—" : `${detail.settlement_interval_days} 天`}
        </Field>
        <Field label="請款截止日">{detail.bill_due_day ?? "—"}</Field>
        <Field label="二代健保">{detail.is_nhi_applicable ? "需扣繳" : "不需"}</Field>
      </div>

      <Separator />

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="商品數">{row.product_count}</Field>
        <Field label="進貨筆數">{row.purchase_count}</Field>
        <Field label="自助入口帳號">{row.portal_account_count}</Field>
        <Field label="庫存件數">{row.stock_units}</Field>
      </div>

      <Separator />

      <VendorDetailChildLists
        contacts={contacts}
        bankAccounts={bankAccounts}
        attachments={attachments}
      />
    </div>
  );
}
