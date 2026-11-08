/**
 * /admin/pos —— 櫃檯結帳
 *
 * ── 這一頁是「門市 × 網站扣同一個數字」真的被人用到的地方 ──────────────────
 * 0011 讓網站下單走 public.stock_reservations 保留、付款成功寫一列
 * inv.sales(channel='online')。這一頁做的是同一件事的另一半：櫃檯賣一本，寫一列
 * inv.sales(channel='pos')，扣的是同一個 inv.products.stock_quantity。
 *
 * 兩條路徑的交會點在 inv.update_stock_on_sale() 那個 trigger 上，不在這個檔案裡。
 * 這一頁只負責把店員的意圖翻成一次結帳函式呼叫。
 *
 * ── 三條結帳路徑 ──────────────────────────────────────────────────────────
 * · **單品**（SingleSaleTab）→ pos_checkout()。掃碼／搜尋 → 購物車 → 結帳。
 * · **套餐**（ComboCheckoutTab）→ inv_combo_checkout()。組合價由資料庫分攤到每個
 *   組成品項，結帳後把分攤結果攤開給人看 —— 那是寄賣廠商的拆帳基礎，看不到就等於
 *   沒有人驗證過。見 0018 檔頭問題一。
 * · **二手書**（SecondhandDialog）→ inv_secondhand_checkout()。不進商品主檔、沒有
 *   庫存也沒有成本，所以它是一個對話框而不是一條購物車。見 0018 檔頭問題三。
 *
 * ── 為什麼拆這麼多元件 ────────────────────────────────────────────────────
 * 來源的 QuickSaleScanner.tsx 是 2,135 行、一個檔案裡有 30 個 useState。三條結帳
 * 路徑各有一整包狀態，擠回同一個 function 就是回到那裡。這一頁只留「共用的東西」：
 * loader 的資料、預設付款方式、分頁切換。components/pos/ 底下每一個檔案都在 250
 * 行以內。
 *
 * ── 還是沒有搬過來的東西 ──────────────────────────────────────────────────
 * · AI 拍照辨識（來源 QuickSaleScanner 的 recognize-book edge function）——
 *   這個專案沒有那支 edge function，硬搬會是一顆永遠 500 的按鈕。
 */
import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { BookMarked, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ComboCheckoutTab } from "@/components/pos/ComboCheckoutTab";
import { SecondhandDialog } from "@/components/pos/SecondhandDialog";
import { SingleSaleTab } from "@/components/pos/SingleSaleTab";

export const Route = createFileRoute("/admin/_shell/pos")({
  loader: async () => {
    const { listPosProducts, listPosPaymentMethods } = await import("@/lib/admin/fns/pos");
    const { listAdminComboSets } = await import("@/lib/admin/fns/inv-combos");
    // 三支都是 staffFnMiddleware 守的。店員進得來、customer 進不來，而且擋人的
    // 是 middleware 重讀 profiles 那一下，不是側欄。
    const [products, paymentMethods, combos] = await Promise.all([
      listPosProducts(),
      listPosPaymentMethods(),
      // 櫃檯只要賣得動的套餐。同樣的條件 inv_combo_checkout() 在資料庫端還會擋
      // 一次 —— 這裡篩是為了不要畫一顆按下去必定跳錯誤的按鈕。
      listAdminComboSets({
        data: {
          keyword: null,
          activeStatus: "active",
          approvalStatus: "approved",
          sort: "name_asc",
        },
      }),
    ]);
    return {
      products,
      paymentMethods,
      comboSets: combos.sets,
      comboItems: combos.items,
    };
  },
  head: () => ({ meta: [{ title: "櫃檯結帳｜小時光書店後台" }] }),
  component: PosPage,
});

function PosPage() {
  const { products, paymentMethods, comboSets, comboItems } = Route.useLoaderData();
  const router = useRouter();

  const [secondhandOpen, setSecondhandOpen] = useState(false);

  /** 三條路徑共用同一個預設付款方式。 */
  const defaultPaymentMethodId =
    paymentMethods.find((m) => m.is_default)?.payment_method_id ??
    paymentMethods[0]?.payment_method_id ??
    null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <ScanLine className="h-5 w-5" aria-hidden="true" />
          櫃檯結帳
        </h1>
        <Button
          type="button"
          variant="outline"
          className="ml-auto gap-1.5"
          onClick={() => setSecondhandOpen(true)}
        >
          <BookMarked className="h-4 w-4" aria-hidden="true" />
          二手書入帳
        </Button>
      </div>

      <Tabs defaultValue="single">
        <TabsList>
          <TabsTrigger value="single">單品結帳</TabsTrigger>
          <TabsTrigger value="combo">套餐結帳</TabsTrigger>
        </TabsList>

        {/* 兩個 TabsContent 各自持有自己的狀態。切分頁時 Radix 會把沒選中的那個
            卸載 —— 購物車裡有東西時切過去再切回來會清空，這是刻意的：兩條路徑
            共用一車只會做出「結完帳發現多賣了一本套餐」那種帳。 */}
        <TabsContent value="single" className="mt-4">
          <SingleSaleTab
            products={products}
            paymentMethods={paymentMethods}
            defaultPaymentMethodId={defaultPaymentMethodId}
          />
        </TabsContent>

        <TabsContent value="combo" className="mt-4">
          <ComboCheckoutTab
            comboSets={comboSets}
            comboItems={comboItems}
            paymentMethods={paymentMethods}
            defaultPaymentMethodId={defaultPaymentMethodId}
          />
        </TabsContent>
      </Tabs>

      <SecondhandDialog
        open={secondhandOpen}
        onOpenChange={setSecondhandOpen}
        paymentMethods={paymentMethods}
        defaultPaymentMethodId={defaultPaymentMethodId}
        // 二手書動不到庫存，但銷售紀錄與當日統計要跟上，所以還是重跑一次 loader。
        onSaved={() => router.invalidate()}
      />
    </div>
  );
}
