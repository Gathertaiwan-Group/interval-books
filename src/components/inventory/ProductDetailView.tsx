/**
 * 商品詳細（唯讀）的內容本體 —— /admin/inventory-products/$id 用。
 *
 * 2026-10-25 從 ProductDetailDialog 改成內頁（業主：「不要用彈窗，直接顯示內頁＆回到上一頁」）。
 * 欄位與文字一個沒改，另外把**異動紀錄**接上（ProductMovementList）。
 *
 * 這一頁的價值在於把四個分散的事實放在同一個畫面上：庫存／網站保留／可售、
 * 審核狀態與是誰核准的、調價待審的話待審的是哪個數字、以及**它有沒有掛在店面
 * 型錄上**。最後那一項是來源沒有的 —— 來源的進銷存不知道網站的存在，所以停用一件
 * 還在網站上賣的商品時沒有任何地方會提醒。
 */
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ApprovalStatusBadge, PriceChangeBadge } from "@/components/inventory/ApprovalStatusBadge";
import { ProductMovementList } from "@/components/inventory/ProductMovementList";
import { INV_PRODUCT_TYPE_LABELS } from "@/lib/admin/schemas";
import { imageFor } from "@/lib/images";
import bookstoreInterior from "@/assets/bookstore-interior.jpg";
import type { AdminProductRow } from "@/server/repos/inv-products";
import type { ProductMovementRow } from "@/server/repos/inv-adjustments";

function money(n: number | null) {
  return n === null || n === undefined ? "—" : `NT$ ${Number(n).toLocaleString("zh-TW")}`;
}

function when(iso: string | null) {
  // SSR 與瀏覽器要印出一樣的字（toLocaleString 在 Node 會多一個 THIN SPACE → React #418）。
  return iso ? formatTaipeiDateTime(iso) : "—";
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="break-words text-sm">{children}</p>
    </div>
  );
}

/** 標題旁的徽章（詳情頁與 pendingComponent 共用：loader 還沒回來時先用列表那一列畫）。 */
export function ProductBadges({ product }: { product: AdminProductRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {product.issue_number ? (
        <Badge variant="outline" className="font-normal">
          NO.{product.issue_number}
        </Badge>
      ) : null}
      <Badge variant="outline" className="font-normal">
        {INV_PRODUCT_TYPE_LABELS[product.product_type as keyof typeof INV_PRODUCT_TYPE_LABELS] ??
          product.product_type}
      </Badge>
      <ApprovalStatusBadge status={product.approval_status} />
      <PriceChangeBadge
        status={product.price_change_status}
        pendingPrice={product.pending_selling_price}
      />
      {product.is_active ? null : (
        <Badge variant="outline" className="font-normal">
          已停用
        </Badge>
      )}
    </div>
  );
}

export function ProductDetailView({
  product,
  movements,
}: {
  product: AdminProductRow;
  movements: ProductMovementRow[];
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="aspect-video w-full shrink-0 overflow-hidden rounded-md border border-border bg-muted sm:w-56">
          <img
            src={imageFor(product.image_key, bookstoreInterior)}
            alt={`${product.name} 的商品照片`}
            className="h-full w-full object-cover"
          />
        </div>

        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="售價">{money(product.selling_price)}</Field>
          <Field label="成本">{money(product.cost_price)}</Field>
          <Field label="每組數量">{product.pack_size}</Field>
          <Field label="庫存">{product.stock_quantity} 件</Field>
          <Field label="網站保留">{product.reserved} 件</Field>
          <Field label="可售">{product.available} 件</Field>
        </div>
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="條碼">
          {product.barcode ? <span className="font-mono">{product.barcode}</span> : "—"}
        </Field>
        <Field label="分類">{product.category_name ?? "—"}</Field>
        <Field label="供應商">{product.vendor_name ?? "—"}</Field>
        <Field label="系列">{product.series ?? "—"}</Field>
        <Field label="出版社">{product.publisher ?? "—"}</Field>
        <Field label="低庫存警示">{product.low_stock_alert ?? "—"}</Field>
        <Field label="庫存來源（母品項）">{product.base_product_name ?? "無"}</Field>
        <Field label="建立者">{product.creator_name ?? "—"}</Field>
        <Field label="建立時間">{when(product.created_at)}</Field>
      </div>

      {product.notes ? (
        <>
          <Separator />
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">備註</p>
            <p className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-sm">
              {product.notes}
            </p>
          </div>
        </>
      ) : null}

      <Separator />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="審核">
          {product.approval_status === "approved" || product.approval_status === "rejected"
            ? `${product.approved_by_name ?? "—"}・${when(product.approved_at)}`
            : "尚未審核"}
        </Field>
        <Field label="調價">
          {product.price_change_status === "pending"
            ? `${product.price_change_requested_by_name ?? "—"} 送出 ${money(
                product.pending_selling_price,
              )}・${when(product.price_change_requested_at)}`
            : product.price_change_status === null
              ? "沒有送過調價"
              : `${product.price_change_status}・${when(product.price_change_requested_at)}`}
        </Field>
      </div>

      <div className="rounded-md border border-border p-3 text-sm">
        {product.listed_slug ? (
          <>
            <p className="font-medium">已在店面型錄上架</p>
            <p className="break-words text-muted-foreground">
              網址代稱 <span className="font-mono">{product.listed_slug}</span>
              （狀態：{product.listed_status ?? "—"}）。停用這件庫存商品會讓網站那一頁
              買得下去但櫃檯出不了貨 —— 要下架請去「上架」那一頁。
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">沒有掛在店面型錄上。這件商品只在櫃檯賣得到。</p>
        )}
      </div>

      <ProductMovementList rows={movements} />
    </div>
  );
}
