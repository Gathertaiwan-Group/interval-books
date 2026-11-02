/**
 * 訂單內頁「編輯訂購人／參加者聯絡資料」（0051）。**只**放在 source = 'admin_phone' 的訂單上：
 * 接電話時沒要到的資料，事後在這裡補。
 *
 * 只能改姓名、手機、Email。按「編輯」才去讀明文（getPhoneOrderContacts），存檔走
 * updatePhoneOrderContactsAdmin → admin_update_phone_order_contacts()：同一個交易裡寫入並
 * 記稽核（誰、什麼時候、改了哪幾個欄位）。兩支 server fn 都掛 adminFnMiddleware，CSRF
 * 由全域 createCsrfMiddleware 擋。
 *
 * 補了 Email **不會**補寄報名成功信或發票通知（這張單的「寄信給客人」維持建單時的選擇）。
 */
import { useState } from "react";
import { Loader2, Pencil, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { phoneOrderContactEditSchema, type PhoneOrderContacts } from "@/lib/admin/phone-order";

type Row = { id: string; seatNo: number; name: string; email: string; phone: string };

export function PhoneOrderContactEditor({
  orderId,
  onSaved,
}: {
  orderId: string;
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notify, setNotify] = useState(false);
  const [buyer, setBuyer] = useState({ name: "", email: "", phone: "" });
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  async function start() {
    setLoading(true);
    setErrors([]);
    try {
      const { getPhoneOrderContacts } = await import("@/lib/admin/fns/phone-orders");
      const data: PhoneOrderContacts | null = await getPhoneOrderContacts({ data: { orderId } });
      if (!data) {
        toast.error("這張訂單不是後台電話報名，不能在這裡編輯。");
        return;
      }
      setBuyer({ ...data.customer });
      setNotify(data.notifyCustomer);
      setRows(
        data.participants.map((p) => ({
          id: p.id,
          seatNo: p.seatNo,
          name: p.name,
          email: p.email ?? "",
          phone: p.phone ?? "",
        })),
      );
      setOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "讀取失敗，請再試一次");
    } finally {
      setLoading(false);
    }
  }

  function setRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function save() {
    if (saving) return;
    const parsed = phoneOrderContactEditSchema.safeParse({
      orderId,
      customer: buyer,
      participants: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone })),
    });
    if (!parsed.success) {
      setErrors(
        parsed.error.issues.map((i) => {
          const where =
            i.path[0] === "participants"
              ? `第 ${rows[Number(i.path[1])]?.seatNo ?? Number(i.path[1]) + 1} 位參加者：`
              : i.path[0] === "customer"
                ? "訂購人："
                : "";
          return `${where}${i.message}`;
        }),
      );
      return;
    }
    if (notify && parsed.data.customer.email === "") {
      setErrors(["這張單有勾「寄信給客人」，訂購人 Email 不能清空。"]);
      return;
    }
    setSaving(true);
    try {
      const { updatePhoneOrderContactsAdmin } = await import("@/lib/admin/fns/phone-orders");
      const res = await updatePhoneOrderContactsAdmin({ data: parsed.data });
      if (!res.ok) {
        setErrors([res.message]);
        toast.error(res.message);
        return;
      }
      toast.success(res.changed ? "聯絡資料已更新" : "沒有變更");
      setOpen(false);
      setErrors([]);
      await onSaved();
    } catch (err) {
      const message = err instanceof Error ? err.message : "儲存失敗，請再試一次";
      setErrors([message]);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={start}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Pencil className="h-4 w-4" aria-hidden />
          )}
          編輯訂購人／參加者聯絡資料
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">
        只能改姓名、手機、Email，會留下修改紀錄。訂購人手機或 Email
        至少一項；參加者的聯絡方式可以空著。 補上 Email 不會補寄先前沒寄的信。
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <EditField label="訂購人姓名" id="pc-buyer-name">
          <Input
            id="pc-buyer-name"
            value={buyer.name}
            maxLength={60}
            onChange={(e) => setBuyer({ ...buyer, name: e.target.value })}
          />
        </EditField>
        <EditField label="手機（09 開頭 10 碼）" id="pc-buyer-phone">
          <Input
            id="pc-buyer-phone"
            inputMode="tel"
            value={buyer.phone}
            maxLength={10}
            onChange={(e) => setBuyer({ ...buyer, phone: e.target.value.trim() })}
          />
        </EditField>
        <EditField label="Email" id="pc-buyer-email">
          <Input
            id="pc-buyer-email"
            type="email"
            value={buyer.email}
            maxLength={120}
            onChange={(e) => setBuyer({ ...buyer, email: e.target.value.trim() })}
          />
        </EditField>
      </div>
      {rows.map((r, i) => (
        <div key={r.id} className="grid gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-3">
          <span className="text-xs font-medium sm:col-span-3">第 {r.seatNo} 位參加者</span>
          <EditField label="姓名" id={`pc-p${i}-name`}>
            <Input
              id={`pc-p${i}-name`}
              value={r.name}
              maxLength={60}
              onChange={(e) => setRow(i, { name: e.target.value })}
            />
          </EditField>
          <EditField label="手機" id={`pc-p${i}-phone`}>
            <Input
              id={`pc-p${i}-phone`}
              inputMode="tel"
              placeholder="可留空"
              value={r.phone}
              maxLength={10}
              onChange={(e) => setRow(i, { phone: e.target.value.trim() })}
            />
          </EditField>
          <EditField label="Email" id={`pc-p${i}-email`}>
            <Input
              id={`pc-p${i}-email`}
              type="email"
              placeholder="可留空"
              value={r.email}
              maxLength={120}
              onChange={(e) => setRow(i, { email: e.target.value.trim() })}
            />
          </EditField>
        </div>
      ))}
      {errors.length > 0 ? (
        <ul
          className="space-y-1 rounded-md border border-destructive/40 p-3 text-sm text-destructive"
          role="alert"
        >
          {errors.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => {
            setOpen(false);
            setErrors([]);
          }}
        >
          取消
        </Button>
        <Button type="button" size="sm" className="gap-1.5" disabled={saving} onClick={save}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Save className="h-4 w-4" aria-hidden />
          )}
          儲存聯絡資料
        </Button>
      </div>
    </div>
  );
}

function EditField({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1 text-sm">
      <Label htmlFor={id} className="block text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
