/**
 * 新增一張在庫異動單。
 *
 * ⚠️ payload 裡**沒有 status**，也沒有成本。要不要進待審是
 *    inv.stock_adjustment_initial_status() 在資料庫算的；出庫的成本由 FIFO trigger 算，
 *    進庫的用商品成本。從瀏覽器送成本進來等於讓人自己填毛利。
 *
 * ⚠️ 負庫存只**軟警告**，不擋。書店真的會出現「架上明明沒有但系統說有三本」，這時候
 *    要能把帳做平；擋住只會逼店員去改商品主檔的庫存數字，那條路完全沒有紀錄。
 *
 * ⚠️ 商品清單走 server 端搜尋（listStockCountProducts 的 keyword），不是整表載進來。
 */
import { useEffect, useState } from "react";
import { CheckCircle, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AdjustmentFormFields } from "@/components/inventory/AdjustmentFormFields";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import {
  invAdjustmentSchema,
  type InvAdjustmentCategory,
  type InvAdjustmentReason,
} from "@/lib/admin/schemas";
import type { StockCountProductRow } from "@/server/repos/inv-adjustments";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  approvalOn: boolean;
  onSaved: () => Promise<void>;
};

export function AdjustmentFormDialog({ open, onOpenChange, approvalOn, onSaved }: Props) {
  const [date, setDate] = useState(todayInTaipei());
  const [category, setCategory] = useState<InvAdjustmentCategory>("EXP");
  const [keyword, setKeyword] = useState("");
  const [products, setProducts] = useState<StockCountProductRow[]>([]);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState<InvAdjustmentReason | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState<"draft" | "submit" | null>(null);

  useEffect(() => {
    if (!open) return;
    setDate(todayInTaipei());
    setCategory("EXP");
    setKeyword("");
    setProductId("");
    setQuantity("");
    setReason(null);
    setNotes("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 打字停 300ms 才問一次資料庫。
    const timer = setTimeout(async () => {
      try {
        const { listStockCountProducts } = await import("@/lib/admin/fns/inv-adjustments");
        const page = await listStockCountProducts({
          data: {
            keyword: keyword.trim() === "" ? null : keyword.trim(),
            categoryId: null,
            productType: null,
            lowStockOnly: false,
            page: 0,
            pageSize: 50,
            // 在庫異動（報損、贈送…）要選得到「不限庫存」的寄賣品；盤點才排除它。
            excludeUnlimited: false,
          },
        });
        if (!cancelled) setProducts(page.rows);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "商品清單讀取失敗");
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, keyword]);

  async function save(submit: boolean) {
    const parsed = invAdjustmentSchema.safeParse({
      product_id: productId,
      adjustment_date: date,
      category,
      quantity: quantity.trim() === "" ? Number.NaN : Number(quantity),
      reason,
      notes: notes.trim() === "" ? null : notes,
      submit,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查填寫的內容");
      return;
    }

    setSaving(submit ? "submit" : "draft");
    try {
      const { saveAdjustment } = await import("@/lib/admin/fns/inv-adjustments");
      const result = await saveAdjustment({ data: parsed.data });
      const no = result.adjustment_number ?? "";
      if (!submit) {
        toast.success(`已存為草稿 ${no}，可稍後再送出`);
      } else if (result.needs_approval) {
        toast.success(`${no} 已送出待審核，核准後庫存才會更新`);
      } else {
        toast.success(`${no} 已確認，庫存已更新`);
      }
      onOpenChange(false);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "異動單儲存失敗");
    } finally {
      setSaving(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => saving === null && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">新增在庫異動</DialogTitle>
          <DialogDescription>
            登記報廢、贈送、領用等非銷售的庫存變動。
            {approvalOn
              ? "在庫異動目前需要審核：送出之後會進入待審核，核准後庫存才會更新。"
              : "在庫異動目前不需要審核，送出後庫存立即更新。"}
          </DialogDescription>
        </DialogHeader>

        <AdjustmentFormFields
          date={date}
          setDate={setDate}
          category={category}
          setCategory={setCategory}
          keyword={keyword}
          setKeyword={setKeyword}
          products={products}
          productId={productId}
          setProductId={setProductId}
          quantity={quantity}
          setQuantity={setQuantity}
          reason={reason}
          setReason={setReason}
          notes={notes}
          setNotes={setNotes}
        />

        <DialogFooter>
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={saving !== null}
            onClick={() => void save(false)}
          >
            {saving === "draft" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            存為草稿
          </Button>
          <Button className="gap-1.5" disabled={saving !== null} onClick={() => void save(true)}>
            {saving === "submit" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle className="h-4 w-4" />
            )}
            送出
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
