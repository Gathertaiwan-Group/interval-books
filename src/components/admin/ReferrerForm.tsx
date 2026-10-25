/**
 * 新增／編輯推廣者 —— /admin/referrals/new、/admin/referrals/$id 的本體。
 *
 * 2026-10-26 從 _shell.referrals.tsx 的 ReferrerDialog 改成內頁（後台第 3 批；業主：「不要用彈窗，
 * 直接顯示內頁＆回到上一頁」）。欄位、payload、createReferrerAdmin／updateReferrerAdmin 一行都沒改；
 * 授權仍是 fns/referrals.ts 每一支的 adminFnMiddleware。
 *
 * 推薦碼建立後就會印在分享連結上，之後盡量別改。不再合作請「停用」，不要刪除。
 */
import { useState } from "react";
import { Loader2, Save, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { textToTiers, tiersToText } from "@/lib/admin/referral-tiers";
import type { ReferrerRow } from "@/server/repos/referrals";

type Props = {
  /** null = 新增。 */
  referrer: ReferrerRow | null;
  defaultDiscount: number;
  /** 存檔成功（已經 allowLeave）：呼叫端負責 invalidate 與換頁。 */
  onSaved: () => Promise<void>;
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="block text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function ReferrerForm({ referrer, defaultDiscount, onSaved }: Props) {
  const [name, setName] = useState(referrer?.name ?? "");
  const [code, setCode] = useState(referrer?.code ?? "");
  const [kind, setKind] = useState<"team" | "external">(referrer?.kind ?? "external");
  const [contact, setContact] = useState(referrer?.contact ?? "");
  const [email, setEmail] = useState(referrer?.email ?? "");
  const [phone, setPhone] = useState(referrer?.phone ?? "");
  const [baseSalary, setBaseSalary] = useState(referrer?.base_salary?.toString() ?? "");
  const [discount, setDiscount] = useState(referrer?.discount_percent?.toString() ?? "");
  const [tiers, setTiers] = useState(tiersToText(referrer?.commission_tiers ?? null));
  const [active, setActive] = useState(referrer?.active ?? true);
  const [note, setNote] = useState(referrer?.note ?? "");
  const [saving, setSaving] = useState(false);

  const { dirty } = useFormDirty({
    name,
    code,
    kind,
    contact,
    email,
    phone,
    baseSalary,
    discount,
    tiers,
    active,
    note,
  });
  const guard = useUnsavedChangesGuard(dirty);

  async function save() {
    const parsedTiers = tiers.trim() ? textToTiers(tiers) : null;
    if (tiers.trim() && !parsedTiers) {
      toast.error("個人級距格式不對，例如：10000:15, 30000:20, :25");
      return;
    }
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    const payload = {
      name,
      code,
      kind,
      contact: contact || null,
      email: email || null,
      phone: phone || null,
      baseSalary: num(baseSalary),
      discountPercent: num(discount),
      commissionTiers: parsedTiers,
      active,
      note: note || null,
    };
    setSaving(true);
    try {
      const fns = await import("@/lib/admin/fns/referrals");
      const res = referrer
        ? await fns.updateReferrerAdmin({ data: { ...payload, id: referrer.id } })
        : await fns.createReferrerAdmin({ data: payload });
      if (!res.ok) {
        toast.error("這個推薦碼已經有人用了，換一個");
        return;
      }
      toast.success("已儲存");
      guard.allowLeave();
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請檢查欄位");
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <Button type="submit" form="referrer-form" className="gap-1.5" disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {saving ? "儲存中…" : "儲存"}
    </Button>
  );

  return (
    <AdminDetailPage
      backTo="/admin/referrals"
      backLabel="回推廣與分潤"
      icon={<UserPlus className="h-5 w-5" aria-hidden="true" />}
      title={referrer ? `編輯推廣者：${referrer.name}` : "新增推廣者"}
      meta="推薦碼建立後就會印在分享連結上，之後盡量別改。不再合作請「停用」，不要刪除。"
      actions={actions}
      width="md"
    >
      <form
        id="referrer-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="grid gap-3 sm:grid-cols-2"
      >
        <Field label="姓名">
          <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="推薦碼（英數 2–20 碼）">
          <Input
            value={code}
            maxLength={20}
            className="uppercase"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="類型">
          <select
            className="block h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value === "team" ? "team" : "external")}
          >
            <option value="external">外部推廣者（只有分潤）</option>
            <option value="team">團隊成員（另分團隊獎金池）</option>
          </select>
        </Field>
        <Field label="聯絡方式（備忘）">
          <Input value={contact} maxLength={200} onChange={(e) => setContact(e.target.value)} />
        </Field>
        <Field label="Email（排除自購用）">
          <Input
            type="email"
            value={email}
            maxLength={120}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="手機（排除自購用）">
          <Input value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label={`客人折扣 %（空白＝預設 ${defaultDiscount}%）`}>
          <Input
            inputMode="decimal"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
          />
        </Field>
        {kind === "team" ? (
          <Field label="底薪（只記錄，不參與計算）">
            <Input
              inputMode="numeric"
              value={baseSalary}
              onChange={(e) => setBaseSalary(e.target.value)}
            />
          </Field>
        ) : null}
        <div className="sm:col-span-2">
          <Field label="個人分潤級距（空白＝用全站級距）">
            <Input
              value={tiers}
              placeholder="10000:15, 30000:20, :25"
              onChange={(e) => setTiers(e.target.value)}
            />
          </Field>
          <p className="mt-1 text-xs text-muted-foreground">
            格式「毛利上限:費率%」，最後一級上限留空。累進計算（像所得稅）。
          </p>
        </div>
        <div className="sm:col-span-2">
          <Field label="備註">
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Switch id="ref-active" checked={active} onCheckedChange={setActive} />
          <Label htmlFor="ref-active">啟用（停用後推薦碼在結帳頁無效，歷史訂單保留）</Label>
        </div>
      </form>

      <div className="hidden justify-end md:flex">{actions}</div>
      {guard.dialog}
    </AdminDetailPage>
  );
}
