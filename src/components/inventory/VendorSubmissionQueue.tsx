/**
 * 廠商送審的商品佇列（店家這一側）。
 *
 * ── 這一區在解什麼問題 ────────────────────────────────────────────────────
 * 廠商從自助入口送進來的商品**不會**出現在 /admin/inventory-products 的待審清單裡：
 * 那個 view 只收店員自己建的（0019 §7.8 的 inv_admin_vendor_submissions 專門過濾
 * submitted_via = 'vendor_portal'）。兩者的審核標準本來就不同 —— 廠商送的要對照合約，
 * 店員建的要對照進貨單。沒有這一區的話，廠商送出去的東西會靜靜躺在資料庫裡：送的人
 * 以為在等，審的人根本不知道有東西要審。
 *
 * ── 核准的時候可以順便上架 ────────────────────────────────────────────────
 * 勾了「同時上架到官網」就要填三語文案，那張表單在 VendorListingDialog。
 *
 * ⚠️ `canApprove` 只控制**畫面**。這一區要的是 **approve_products**，不是
 *    approve_vendors —— 一個能簽核廠商的人不見得該決定哪本書上架。按鈕變灰不是
 *    授權，真正擋住直接 POST /_serverFn/… 的是 fns/inv-vendors.ts 裡
 *    approveVendorSubmission 那一次 requirePermission()，而它從 staff_permissions
 *    重讀權限，不看前端。
 */
import { useState } from "react";
import { CheckCircle2, Loader2, PackageCheck, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApprovalStatusBadge } from "@/components/inventory/ApprovalStatusBadge";
import { VendorListingDialog } from "@/components/inventory/VendorListingDialog";
import { money } from "@/components/inventory/VendorFormParsers";
import type { VendorSubmissionApprovalValues } from "@/lib/admin/schemas";
import type { VendorSubmissionRow } from "@/server/repos/inv-vendors";

type SubmissionStatus = "all" | "pending" | "approved" | "rejected";

type Props = {
  rows: VendorSubmissionRow[];
  status: SubmissionStatus;
  onStatusChange: (next: SubmissionStatus) => void;
  busyId: string | null;
  loading: boolean;
  canApprove: boolean;
  onDecide: (
    row: VendorSubmissionRow,
    approved: boolean,
    listing: VendorSubmissionApprovalValues["listing"],
  ) => void;
};

const STATUS_OPTIONS: { code: SubmissionStatus; label: string }[] = [
  { code: "pending", label: "待審核" },
  { code: "approved", label: "已核准" },
  { code: "rejected", label: "已退回" },
  { code: "all", label: "全部" },
];

export function VendorSubmissionQueue({
  rows,
  status,
  onStatusChange,
  busyId,
  loading,
  canApprove,
  onDecide,
}: Props) {
  const [listingFor, setListingFor] = useState<VendorSubmissionRow | null>(null);

  const blockedTitle = canApprove ? undefined : "需要「approve_products」權限";

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PackageCheck className="h-4 w-4" aria-hidden="true" />
          <p className="text-sm font-medium">廠商送審的商品</p>
          <Badge variant="secondary" className="font-normal">
            {rows.length}
          </Badge>
        </div>
        <Select
          value={status}
          disabled={loading}
          onValueChange={(v) => onStatusChange(v as SubmissionStatus)}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.code} value={o.code}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="text-sm text-muted-foreground">
        這些是廠商從自助入口送進來的商品，不會出現在商品管理的待審清單裡。核准的時候可以
        順便上架到官網，但三語文案要店員自己填。
      </p>

      {loading ? (
        <div className="flex h-24 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">目前沒有符合條件的送審商品。</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const busy = busyId === row.inv_product_id;
            return (
              <li
                key={row.inv_product_id}
                className={`flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3 ${
                  busy ? "opacity-60" : ""
                }`}
              >
                <div className="space-y-0.5">
                  {/* ⚠️ 這一層是 <div> 不是 <p>：ApprovalStatusBadge 是 <div>（Badge），<p>
                      裡放 <div> 是不合法的 HTML，瀏覽器解析 SSR 的 HTML 時會先把 <p> 關掉，
                      結構跟 React 的不一樣 → hydration 失敗（React #418，參數 HTML）。 */}
                  <div className="text-sm font-medium">
                    {row.name}
                    {row.issue_number ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {row.issue_number}
                      </span>
                    ) : null}
                    <ApprovalStatusBadge status={row.approval_status} className="ml-1.5" />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {row.vendor_name ?? "未知廠商"}
                    {row.vendor_code ? `（${row.vendor_code}）` : ""}
                    ・建議售價 {money(row.selling_price)}
                    {row.vendor_is_consignment
                      ? `・寄售抽成 ${
                          row.vendor_commission_rate === null
                            ? "未設定"
                            : `${Number((row.vendor_commission_rate * 100).toFixed(2))}%`
                        }`
                      : "・買斷"}
                  </p>
                  {row.publisher || row.series ? (
                    <p className="text-xs text-muted-foreground">
                      {[row.publisher, row.series].filter(Boolean).join("・")}
                    </p>
                  ) : null}
                  {row.notes ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{row.notes}</p>
                  ) : null}
                </div>

                {row.approval_status === "pending" ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 border-emerald-600/40 text-emerald-700 hover:bg-emerald-600/10"
                      disabled={busy || !canApprove}
                      title={blockedTitle}
                      onClick={() => onDecide(row, true, null)}
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      )}
                      核准
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={busy || !canApprove}
                      title={blockedTitle}
                      onClick={() => setListingFor(row)}
                    >
                      核准並上架
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
                      disabled={busy || !canApprove}
                      title={blockedTitle}
                      onClick={() => onDecide(row, false, null)}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      退回
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {!canApprove ? (
        <p className="text-xs text-muted-foreground">
          你沒有「approve_products」權限，所以這一區的按鈕是灰的。這與廠商本身的審核權
          （approve_vendors）是兩件事。
        </p>
      ) : null}

      <VendorListingDialog
        row={listingFor}
        onClose={() => setListingFor(null)}
        onSubmit={(row, listing) => {
          setListingFor(null);
          onDecide(row, true, listing);
        }}
      />
    </div>
  );
}
