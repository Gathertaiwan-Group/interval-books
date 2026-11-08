/**
 * /vendor —— 廠商首頁：我的資料 + 商品概況。
 *
 * ── 這一頁在解什麼問題 ────────────────────────────────────────────────────
 * 廠商登入之後的第一個問題是「你們手上關於我的資料對不對」，第二個才是「我的書
 * 怎麼樣了」。所以這一頁是**對帳**用的，不是儀表板：基本資料、匯款帳戶、以及商品
 * 依狀態的數量。要改任何一項都得聯絡書店 —— 廠商能自己改的只有送審中的商品。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 匯款帳號預設是遮罩，而且「查看完整帳號」真的會留下紀錄
 * ══════════════════════════════════════════════════════════════════════════
 *
 * myVendorProfile() 回的 bank_accounts 只有 account_number_masked。要看完整帳號
 * 必須另外按一顆按鈕呼叫 myBankAccountDetails()，而那一支走的是**和店員一模一樣**
 * 的那扇門（0019 §4）：server 端先寫 pii_access_log 再組值，兩件事在同一個交易裡，
 * 所以「拿到值但沒留下紀錄」在結構上不可能發生。差別只在 access_kind='self'、
 * reason='self_service'。
 *
 * ⚠️ 按鈕旁邊那句「查看完整帳號會留下一筆查閱紀錄」不是嚇人的免責聲明，是事實，
 *    而且必須留著。「是自己的資料所以不用記」聽起來合理，但入口帳號是書店配發的，
 *    配發之後是誰在用是另一件事 —— 帳號被冒用時，那批 self 紀錄是唯一查得出「什麼
 *    時候開始不對勁」的東西。使用者有權知道自己按下去會發生什麼。
 *
 * ⚠️ 揭露的結果**只放在 component state**，不寫回 loader data、不快取。重新整理就
 *    回到遮罩，要再看一次就要再留一筆紀錄 —— 那正是我們要的。
 *
 * ── 哪裡容易寫錯 ──────────────────────────────────────────────────────────
 * ⚠️ 這一頁的兩支 loader 呼叫都**沒有參數**。哪一家由 sealed cookie 決定，見
 *    routes/vendor/_shell.tsx 檔頭第一條。
 *
 * ⚠️ vendor 可能是 null（帳號綁到一家後來被刪掉的廠商）。_shell 的 guard 擋掉的是
 *    「沒綁定」，不保證 profile 一定查得到，所以這裡要自己處理 null 而不是 `!`。
 */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Eye, Loader2, Package, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export const Route = createFileRoute("/vendor/_shell/")({
  loader: async () => {
    const { myProducts, myVendorProfile } = await import("@/lib/admin/fns/vendor-portal");
    // ⚠️ 兩支都沒有參數。廠商身分來自 cookie，不是網址、也不是 payload。
    const [profile, products] = await Promise.all([myVendorProfile(), myProducts()]);
    return { profile, products };
  },
  head: () => ({ meta: [{ title: "我的資料｜小時光書店廠商入口" }] }),
  component: VendorHomePage,
});

function VendorHomePage() {
  const { profile, products } = Route.useLoaderData();
  const { vendor, bank_accounts: bankAccounts } = profile;

  /** bank_account_id → 完整帳號。只活在記憶體裡，重整就消失，見檔頭。 */
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState(false);

  async function revealAccounts() {
    setRevealing(true);
    try {
      const { myBankAccountDetails } = await import("@/lib/admin/fns/vendor-portal");
      const result = await myBankAccountDetails();
      const map: Record<string, string> = {};
      for (const account of result.values.bank_accounts ?? []) {
        map[account.bank_account_id] = account.account_number;
      }
      setRevealed(map);
      toast.success("已顯示完整帳號，並留下一筆查閱紀錄");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "讀取失敗，請再試一次");
    } finally {
      setRevealing(false);
    }
  }

  const pending = products.filter((p) => p.approval_status === "pending").length;
  const approved = products.filter((p) => p.approval_status === "approved").length;
  const rejected = products.filter((p) => p.approval_status === "rejected").length;
  const listed = products.filter((p) => p.listed_slug !== null).length;
  const sold = products.reduce((sum, p) => sum + p.sold_quantity, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-medium">我的資料</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          以下是小時光書店目前登記的資料。需要更正請直接聯絡書店 —— 這一頁不能編輯。
        </p>
      </div>

      {vendor === null ? (
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          目前查不到你的廠商基本資料，請聯絡小時光書店確認。
        </div>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{vendor.name}</CardTitle>
            <CardDescription>
              {vendor.vendor_code ? `廠商代號 ${vendor.vendor_code}・` : ""}
              {vendor.is_consignment ? "寄售" : "買斷"}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <InfoRow label="負責人" value={vendor.representative} />
            <InfoRow label="聯絡電話" value={vendor.phone} />
            <InfoRow label="電子郵件" value={vendor.email} />
            <InfoRow label="傳真" value={vendor.fax} />
            <InfoRow label="地址" value={vendor.address} className="sm:col-span-2" />
            {/* 統編／身分證號同樣只有遮罩版，而且這一頁不提供揭露 —— 廠商要核對的是
                匯款帳號，識別碼給遮罩足夠確認「你們記的是不是我」。 */}
            <InfoRow label="統一編號" value={vendor.tax_id_masked} />
            <InfoRow label="身分證字號" value={vendor.id_number_masked} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">匯款帳戶</CardTitle>
          <CardDescription>書店結算貨款時會匯到這裡。帳號預設只顯示末幾碼。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {bankAccounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              目前沒有登記匯款帳戶，請聯絡小時光書店補登。
            </p>
          ) : (
            <>
              <div className="space-y-3">
                {bankAccounts.map((account) => (
                  <div
                    key={account.bank_account_id}
                    className="rounded-md border border-border p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{account.bank_name}</span>
                      {account.bank_code ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {account.bank_code}
                        </span>
                      ) : null}
                      {account.is_default ? (
                        <Badge variant="secondary" className="font-normal">
                          預設
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      戶名：{account.account_holder_name}
                      {account.branch_name ? `・${account.branch_name}` : ""}
                    </p>
                    <p className="mt-1.5 font-mono text-sm">
                      {revealed[account.bank_account_id] ?? account.account_number_masked ?? "—"}
                    </p>
                  </div>
                ))}
              </div>

              <Separator />

              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={revealing}
                  onClick={revealAccounts}
                >
                  {revealing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  查看完整帳號
                </Button>
                {/* 這句是事實，不是免責聲明，見檔頭。 */}
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  查看完整帳號會留下一筆查閱紀錄（含時間與帳號）。
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">商品概況</CardTitle>
          <CardDescription>你透過這個入口送出、以及書店已經收下的商品。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="待審核" value={pending} />
            <Stat label="已核准" value={approved} />
            <Stat label="已退回" value={rejected} />
            <Stat label="已上架" value={listed} />
            <Stat label="累計售出" value={sold} />
          </div>
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link to="/vendor/products">
              <Package className="h-4 w-4" aria-hidden="true" />
              查看我的商品
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function InfoRow({
  label,
  value,
  className,
}: {
  label: string;
  value: string | null;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm">{value?.trim() ? value : "—"}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xl font-medium">{value.toLocaleString("zh-TW")}</p>
    </div>
  );
}
