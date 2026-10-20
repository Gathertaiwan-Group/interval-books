/**
 * 查看廠商的完整識別碼／匯款帳號 —— 整個後台唯一看得到原值的地方。
 *
 * ── 這個對話框在解什麼問題 ────────────────────────────────────────────────
 * 全站其他每一個地方拿到的都是 `*_masked`：view 根本沒有把完整號碼送到瀏覽器
 * （0019 §3.1/§3.2 只 select 遮罩欄）。真的要看的時候 —— 對帳、匯款、報稅、廠商
 * 打電話來問 —— 走這一扇門，而這扇門會記下「誰、什麼時候、看了哪些欄位、為什麼」。
 *
 * ⚠️ **呼叫成功就一定留下一筆 pii_access_log。** 那不是副作用，是它一半的工作：
 *    0019 §4 的函式在同一個交易裡先寫紀錄再組值，所以「拿到值但沒留下紀錄」在結構
 *    上不可能發生。使用者看得到這句話，是因為知道會被記錄本身就是這個設計的一部分
 *    —— 偷偷記錄只能事後追究，講明白才會讓人在按下去之前想一秒。
 *
 * ⚠️ **事由列表刻意少一個。** PII_ACCESS_REASONS 有五個值，這裡只列四個 ——
 *    `self_service` 是廠商自助入口那一側專用的（廠商查自己的資料）。店員用它會讓
 *    稽核紀錄看起來像是廠商自己查的，所以這裡不列，而 fns/inv-vendors.ts 的
 *    handler 也會擋。兩層都擋，因為少列一個選項只是畫面。
 *
 * ⚠️ 沒有 `inv.vendor.pii.read` 的人：這個對話框的送出鈕是 disabled。
 *    **disabled 不是授權** —— 真正擋住直接 POST /_serverFn/… 的是
 *    fns/inv-vendors.ts#readVendorSensitive 裡那一次 requirePermission()，
 *    而它是從 staff_permissions 重讀出來的，不看前端送什麼。
 *
 * ⚠️ 讀回來的值只活在這個對話框的 state 裡：關掉就清掉，不寫進表單、不塞進
 *    localStorage、也不放進網址。要再看一次就再查一次，而那會是新的一筆紀錄 ——
 *    這正是想要的形狀。
 */
import { useEffect, useState } from "react";
import { Eye, Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  PII_ACCESS_REASONS,
  PII_ACCESS_REASON_LABELS,
  VENDOR_SENSITIVE_FIELDS,
  VENDOR_SENSITIVE_FIELD_LABELS,
} from "@/lib/admin/schemas";
import type { AdminVendorRow, VendorSensitiveResult } from "@/server/repos/inv-vendors";
import { PERMISSION_LABELS, needsPermissionHint } from "@/lib/admin/permission-labels";

type SensitiveField = (typeof VENDOR_SENSITIVE_FIELDS)[number];
type AccessReason = (typeof PII_ACCESS_REASONS)[number];

/** 店員選得到的事由。`self_service` 被排除，理由見檔頭。 */
const STAFF_REASONS: AccessReason[] = PII_ACCESS_REASONS.filter((r) => r !== "self_service");

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 沒有選中任何廠商，對話框不畫。 */
  vendor: AdminVendorRow | null;
  canReadPii: boolean;
};

export function VendorSensitiveDialog({ open, onOpenChange, vendor, canReadPii }: Props) {
  const [fields, setFields] = useState<SensitiveField[]>([]);
  const [reason, setReason] = useState<AccessReason>("reconciliation");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VendorSensitiveResult | null>(null);

  // 每次開啟都從零開始。上一家的號碼留在畫面上是這一頁最不該發生的事。
  useEffect(() => {
    if (open) return;
    setFields([]);
    setReason("reconciliation");
    setResult(null);
    setLoading(false);
  }, [open]);

  function toggle(field: SensitiveField, checked: boolean) {
    setFields((prev) => (checked ? [...prev, field] : prev.filter((f) => f !== field)));
  }

  async function read() {
    if (!vendor) return;
    if (fields.length === 0) {
      toast.error("請選擇要查看哪些欄位");
      return;
    }

    setLoading(true);
    try {
      const { readVendorSensitive } = await import("@/lib/admin/fns/inv-vendors");
      const data = await readVendorSensitive({
        data: { vendor_id: vendor.vendor_id, fields, reason },
      });
      setResult(data);
    } catch (err) {
      // 沒有權限的人（或直接打 API 的人）在這裡拿到 NotAuthorizedError。
      toast.error(err instanceof Error ? err.message : "敏感欄位讀取失敗");
    } finally {
      setLoading(false);
    }
  }

  if (!vendor) return null;

  const values = result?.values;

  return (
    <Dialog open={open} onOpenChange={(o) => !loading && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">查看「{vendor.name}」的完整號碼</DialogTitle>
          <DialogDescription>
            {vendor.vendor_code ?? "（未編號）"}
            ・平常畫面上顯示的都是遮罩，完整號碼只有這裡看得到。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span>
            <strong>這次查閱會留下紀錄</strong>：你的帳號、查閱時間、看了哪些欄位、以及下面選的
            事由，都會寫進稽核軌跡，而且刪不掉。有正當理由再查 —— 稽核紀錄是拿來保護廠商的，
            不是拿來嚇人的。
          </span>
        </div>

        <div className="space-y-2">
          <Label className="text-xs">要看哪些欄位</Label>
          {/* 沒有「全選」按鈕：一次勾五個就代表這筆紀錄長成「這個人一次看了五個欄位」，
              那是稽核要看見的形狀，不該用一顆按鈕變得毫不費力。 */}
          <div className="grid gap-2 sm:grid-cols-2">
            {VENDOR_SENSITIVE_FIELDS.map((field) => (
              <label
                key={field}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2.5 text-sm"
              >
                <Checkbox
                  checked={fields.includes(field)}
                  disabled={loading}
                  onCheckedChange={(v) => toggle(field, v === true)}
                />
                {VENDOR_SENSITIVE_FIELD_LABELS[field]}
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">查閱事由</Label>
          <Select
            value={reason}
            disabled={loading}
            onValueChange={(v) => setReason(v as AccessReason)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STAFF_REASONS.map((code) => (
                <SelectItem key={code} value={code}>
                  {PII_ACCESS_REASON_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            事由是列舉不是自由文字 —— 自由文字最後一定會變成空字串。
          </p>
        </div>

        {result ? (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-sm font-medium">查閱結果</p>
              <dl className="space-y-1.5">
                {values?.tax_id !== undefined ? (
                  <SensitiveRow label="統一編號" value={values.tax_id} />
                ) : null}
                {values?.id_number !== undefined ? (
                  <SensitiveRow label="身分證字號" value={values.id_number} />
                ) : null}
                {values?.foreign_id !== undefined ? (
                  <SensitiveRow label="國外識別碼" value={values.foreign_id} />
                ) : null}
                {values?.residence_permit_number !== undefined ? (
                  <SensitiveRow label="居留證號碼" value={values.residence_permit_number} />
                ) : null}
              </dl>

              {values?.bank_accounts ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">匯款帳戶</p>
                  {values.bank_accounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">這家廠商沒有匯款帳戶</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {values.bank_accounts.map((account) => (
                        <li
                          key={account.bank_account_id}
                          className="rounded-md border border-border p-2.5 text-sm"
                        >
                          <p className="font-medium">
                            {account.account_holder_name}
                            {account.is_default ? (
                              <span className="ml-1.5 text-xs text-muted-foreground">（預設）</span>
                            ) : null}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {account.bank_code} {account.bank_name}
                            {account.branch_name ? `・${account.branch_name}` : ""}
                          </p>
                          <p className="font-mono text-sm tabular-nums">{account.account_number}</p>
                          {account.account_purpose ? (
                            <p className="text-xs text-muted-foreground">
                              {account.account_purpose}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}

              <p className="text-xs text-muted-foreground">
                紀錄編號 {result.log_id}
                ・關掉這個視窗，上面的號碼就從畫面上消失（沒有存在任何地方）。
              </p>
            </div>
          </>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>
            關閉
          </Button>
          <Button
            className="gap-1.5"
            // ⚠️ disabled 只是畫面。擋住直接呼叫的是 server fn 那一次 requirePermission()。
            disabled={loading || !canReadPii || fields.length === 0}
            title={canReadPii ? undefined : needsPermissionHint("inv.vendor.pii.read")}
            onClick={() => void read()}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            查看並留下紀錄
          </Button>
        </DialogFooter>

        {!canReadPii ? (
          <p className="text-xs text-muted-foreground">
            你還沒有「{PERMISSION_LABELS["inv.vendor.pii.read"]}」權限，所以看不到完整號碼，
            請找店長開通。這一項和「審核進貨」這類簽核權限是分開的：管收貨的店員有理由簽核
            進貨，不一定有理由看到廠商的身分證字號。
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SensitiveRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-md border border-border p-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm tabular-nums">{value ?? "（未填）"}</dd>
    </div>
  );
}
