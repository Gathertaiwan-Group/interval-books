/**
 * /vendor/products —— 我的商品：送審、修改、撤回。
 *
 * ── 這一頁在解什麼問題 ────────────────────────────────────────────────────
 * 廠商把新書交給書店，這一頁是那件事的數位版：填一張表送出去，書店那邊會看到一筆
 * 待審核。核准之前廠商都還能改或撤回；核准之後那件商品就變成書店的庫存主檔（有
 * 成本、有庫存異動、可能已經上架、可能已經賣掉幾本），這裡就只剩檢視。
 *
 * 「還能不能改」這條規則的唯一出處是 components/vendor/VendorProductTable.tsx 的
 * canVendorEdit() —— 兩個條件（pending + submitted_via='vendor_portal'），不要在
 * 這裡再寫一份。
 *
 * ── 哪裡容易寫錯 ──────────────────────────────────────────────────────────
 * ⚠️ 這一頁的每一支 server fn 呼叫都不含 vendorId：myProducts() 無參數、
 *    withdrawProduct 只送 id。哪一家由 sealed cookie 決定 —— 見
 *    routes/vendor/_shell.tsx 檔頭第一條。撤回時送別家的 id 進去不會回「無權限」，
 *    會回「找不到」（回「無權限」等於確認那個 id 存在，是一條列舉管道）。
 *
 * ⚠️ 畫面上有沒有「修改／撤回」按鈕**不是授權**。真正擋住直接 POST /_serverFn/…
 *    的是 vendorFnMiddleware() 加上資料庫函式 WHERE 裡的
 *    `vendor_id = vendor_my_id(p_user_id)`。把 canVendorEdit() 改成永遠回 true，
 *    廠商仍然改不動別人的、也改不動已核准的商品，只會拿到一個錯誤。
 *
 * ⚠️ 這個專案**沒有 react-query**。寫入之後靠 router.invalidate() 讓 loader 重跑，
 *    與 /admin/_shell.inventory-combos.tsx 同一套做法。
 */
import { useCallback, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Package, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { VendorProductFormDialog } from "@/components/vendor/VendorProductFormDialog";
import { VendorProductTable } from "@/components/vendor/VendorProductTable";
import type { VendorPortalProduct } from "@/server/repos/inv-vendors";

export const Route = createFileRoute("/vendor/_shell/products")({
  loader: async () => {
    const { myProducts } = await import("@/lib/admin/fns/vendor-portal");
    // ⚠️ 無參數。過濾條件在資料庫函式裡，用 cookie 推導出來的 vendor_id。
    return { products: await myProducts() };
  },
  head: () => ({ meta: [{ title: "我的商品｜小時光書店廠商入口" }] }),
  component: VendorProductsPage,
});

function VendorProductsPage() {
  const { products } = Route.useLoaderData();
  const router = useRouter();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<VendorPortalProduct | null>(null);
  const [withdrawing, setWithdrawing] = useState<VendorPortalProduct | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /** 寫入之後重抓這一頁。沒有 react-query，所以就是讓 router 把 loader 再跑一次。 */
  const refresh = useCallback(async () => {
    await router.invalidate();
  }, [router]);

  function openForm(row: VendorPortalProduct | null) {
    setEditing(row);
    setFormOpen(true);
  }

  async function confirmWithdraw(row: VendorPortalProduct) {
    setWithdrawing(null);
    setBusyId(row.inv_product_id);
    try {
      const { withdrawProduct } = await import("@/lib/admin/fns/vendor-portal");
      // ⚠️ 只送 id，沒有 vendorId。見檔頭。
      const result = await withdrawProduct({ data: { id: row.inv_product_id } });
      toast.success(`已撤回「${result.name}」`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "撤回失敗，請再試一次");
    } finally {
      setBusyId(null);
    }
  }

  const pending = products.filter((p) => p.approval_status === "pending").length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-lg font-medium">
            <Package className="h-5 w-5" aria-hidden="true" />
            我的商品
          </h1>
          <Badge variant="secondary" className="font-normal">
            共 {products.length.toLocaleString("zh-TW")} 件
          </Badge>
          {pending > 0 ? (
            <Badge variant="outline" className="font-normal">
              {pending} 件待審核
            </Badge>
          ) : null}
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => openForm(null)}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          送審新商品
        </Button>
      </div>

      <p className="max-w-3xl text-sm text-muted-foreground">
        送出的商品會進入書店的待審核清單。<strong>核准之前</strong>
        你都可以回來修改或撤回；核准之後，這件商品就由書店維護庫存與售價，這裡只能檢視。
        庫存與售出數量都是書店端的實際數字，不是你送出的內容。
      </p>

      {products.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border text-sm text-muted-foreground">
          <p>還沒有送審過任何商品。</p>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openForm(null)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            送審第一件商品
          </Button>
        </div>
      ) : (
        <VendorProductTable
          rows={products}
          busyId={busyId}
          onEdit={openForm}
          onWithdraw={setWithdrawing}
        />
      )}

      <VendorProductFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onSaved={refresh}
      />

      <AlertDialog
        open={withdrawing !== null}
        onOpenChange={(open) => !open && setWithdrawing(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>要撤回這件商品嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{withdrawing?.name}」會從書店的待審核清單移除，書店就不會再看到它。
              你之後仍然可以重新送審一次。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (withdrawing) void confirmWithdraw(withdrawing);
              }}
            >
              撤回
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
