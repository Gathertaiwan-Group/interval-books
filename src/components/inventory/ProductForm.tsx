/**
 * 新增／編輯商品 —— 表單內頁的本體（/admin/inventory-products/new 與 /$id/edit）。
 *
 * 2026-10-25 從 ProductFormDialog 改成內頁（業主：「不要用彈窗，直接顯示內頁＆回到上一頁」）。
 * 欄位（ProductFormFields）、初次進貨（InitialPurchaseFields）、送出前的轉型與 zod、
 * saveProduct() 一行都沒改；改的是外殼：AdminDetailPage + 未存變更防呆。
 *
 * ── 幾件刻意與來源不同的事 ────────────────────────────────────────────────
 * · **沒有 LocalizedField**。進銷存的 name 是單語 text；三語只出現在「上架」那一頁，
 *   因為那裡才是庫存與型錄的分界線（見 repos/inventory-listing.ts 檔頭）。
 * · **庫存不是欄位**。來源的新增表單也沒有，但這裡連編輯時都沒有 —— 庫存只能由
 *   進貨與盤點改，開一個輸入框給人打數字就是開一條繞過 FIFO 的路。
 * · **審核狀態不是欄位**。它由資料庫算（inv.initial_approval_status()，fail-closed）。
 *
 * 送出前不查 approval_settings 再自己決定 approval_status —— 來源就是那樣做的，
 * 而那份設定在瀏覽器裡還沒載完時會 fallback 成 pending，於是「關掉審核」有時候
 * 有效有時候沒效。這裡表單只負責顯示「送出後會怎樣」，真正的值由 server 決定。
 *
 * ⚠️ 表單只在**掛載時**從 product 填一次（useState 初始值）。loader 之後重跑不可以蓋掉
 *    打到一半的欄位；換一件商品由呼叫端 key={id} 重新掛載。
 */
import { useState } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { InitialPurchaseFields } from "@/components/inventory/InitialPurchaseFields";
import { ProductFormFields } from "@/components/inventory/ProductFormFields";
import {
  EMPTY_PRODUCT_FORM,
  type ProductFormState,
} from "@/components/inventory/product-form-state";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { invProductSchema, INV_PRODUCT_TYPES } from "@/lib/admin/schemas";
import { extractIssueFromName, todayInTaipei } from "@/lib/admin/inv-product-utils";
import type { AdminCategory, AdminProductRow, AdminVendor } from "@/server/repos/inv-products";

type Props = {
  /** null = 新增。 */
  product: AdminProductRow | null;
  categories: AdminCategory[];
  vendors: AdminVendor[];
  baseProducts: { inv_product_id: string; name: string; issue_number: string | null }[];
  /** 只影響提示文字。真正的 approval_status 由 server 算。 */
  productApprovalOn: boolean;
  priceApprovalOn: boolean;
  /** 「← 回到…」：編輯回詳情頁、新增回列表。 */
  back: { to: string; label: string; also?: readonly string[] };
  /** 存檔成功（已經 allowLeave）：呼叫端負責 invalidate 與換頁。 */
  onSaved: (productId: string) => Promise<void>;
};

function formFromProduct(product: AdminProductRow): ProductFormState {
  return {
    name: product.name,
    issue_number: product.issue_number ?? "",
    barcode: product.barcode ?? "",
    category_id: product.category_id ?? "",
    product_type: (INV_PRODUCT_TYPES as readonly string[]).includes(product.product_type)
      ? (product.product_type as ProductFormState["product_type"])
      : "outright",
    series: product.series ?? "",
    publisher: product.publisher ?? "",
    vendor_id: product.vendor_id ?? "",
    selling_price: product.selling_price === null ? "" : String(product.selling_price),
    cost_price: product.cost_price === null ? "" : String(product.cost_price),
    low_stock_alert: String(product.low_stock_alert ?? 5),
    pack_size: String(product.pack_size ?? 1),
    base_product_id: product.base_product_id ?? "",
    image_key: product.image_key,
    notes: product.notes ?? "",
  };
}

export function ProductForm({
  product,
  categories,
  vendors,
  baseProducts,
  productApprovalOn,
  priceApprovalOn,
  back,
  onSaved,
}: Props) {
  const isEdit = product !== null;
  // 只在掛載時填一次 —— 理由見檔頭。
  const [form, setForm] = useState<ProductFormState>(() =>
    product ? formFromProduct(product) : EMPTY_PRODUCT_FORM,
  );
  const [withPurchase, setWithPurchase] = useState(!isEdit);
  const [purchase, setPurchase] = useState(() => ({
    quantity: "1",
    cost_price: "",
    vendor: "",
    purchase_date: todayInTaipei(),
  }));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { dirty } = useFormDirty({ form, withPurchase, purchase });
  const guard = useUnsavedChangesGuard(dirty);

  /** 名稱打完自動把期數拆出來 —— 只在期數還是空的時候，不要蓋掉手動輸入。 */
  function handleNameBlur() {
    if (form.issue_number.trim() !== "") return;
    const { baseName, issueNumber } = extractIssueFromName(form.name);
    if (issueNumber) setForm((f) => ({ ...f, name: baseName, issue_number: issueNumber }));
  }

  async function submit() {
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    const candidate = {
      id: product?.inv_product_id ?? null,
      name: form.name,
      issue_number: form.issue_number.trim() || null,
      barcode: form.barcode.trim() || null,
      category_id: form.category_id || null,
      product_type: form.product_type,
      series: form.series.trim() || null,
      publisher: form.publisher.trim() || null,
      vendor_id: form.vendor_id || null,
      selling_price: num(form.selling_price) ?? 0,
      cost_price: num(form.cost_price),
      low_stock_alert: Number(form.low_stock_alert || 0),
      pack_size: Number(form.pack_size || 1),
      base_product_id: form.base_product_id || null,
      image_key: form.image_key,
      notes: form.notes.trim() || null,
      purchase:
        !isEdit && withPurchase
          ? {
              quantity: Number(purchase.quantity || 0),
              cost_price: num(purchase.cost_price),
              vendor: purchase.vendor.trim() || null,
              purchase_date: purchase.purchase_date,
            }
          : null,
    };

    const parsed = invProductSchema.safeParse(candidate);
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const issue of parsed.error.issues) map[String(issue.path[0])] = issue.message;
      setErrors(map);
      toast.error(parsed.error.issues[0]?.message ?? "請檢查輸入的內容");
      return;
    }

    setSaving(true);
    try {
      const { saveProduct } = await import("@/lib/admin/fns/inv-products");
      const result = await saveProduct({ data: parsed.data });
      if (result.price_change_pending) {
        toast.warning("商品已更新，但價格變更需要審核 —— 核准後才會生效");
      } else if (result.created) {
        toast.success(
          result.purchase_created ? "商品已新增，並建立了一筆待審核的進貨" : "商品已新增",
        );
      } else {
        toast.success("商品已更新");
      }
      guard.allowLeave();
      await onSaved(result.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請再試一次");
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <Button className="gap-1.5" onClick={() => void submit()} disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {isEdit ? "儲存" : "新增"}
    </Button>
  );

  return (
    <AdminDetailPage
      backTo={back.to}
      backLabel={back.label}
      backAlso={back.also}
      title={isEdit ? `編輯商品：${product.name}` : "新增商品"}
      meta={
        isEdit
          ? priceApprovalOn
            ? "改到售價或成本會送出調價待審，核准後才生效；其他欄位立即生效。"
            : "所有欄位立即生效。"
          : productApprovalOn
            ? "新增的商品會進入待審核，核准之後才會出現在櫃檯。"
            : "審核已關閉，新增的商品會直接生效。"
      }
      actions={actions}
      width="md"
    >
      <ProductFormFields
        form={form}
        setForm={setForm}
        errors={errors}
        saving={saving}
        categories={categories}
        vendors={vendors}
        baseProducts={baseProducts}
        currentProductId={product?.inv_product_id ?? null}
        onNameBlur={handleNameBlur}
      />

      {!isEdit ? (
        <InitialPurchaseFields
          enabled={withPurchase}
          onEnabledChange={setWithPurchase}
          purchase={purchase}
          onPurchaseChange={setPurchase}
        />
      ) : null}

      <div className="hidden justify-end md:flex">{actions}</div>
      {guard.dialog}
    </AdminDetailPage>
  );
}
