/**
 * 報名名單「編輯」一位參加者（2026-11-05）。SessionRosterTable 每一列「移除」旁的「編輯」。
 *
 * 只改姓名、Email、電話（「換人」＝在同一列改這三欄）。訂單、付款、金額、名額都不動——
 * 那件事由 server fn 保證（updateRegistrationParticipant，adminFnMiddleware），不是靠這個畫面。
 * 名單上的「注意事項」是同意紀錄的時間（notice_ack_at），不在這裡改。
 *
 * 樂觀鎖：送出時帶「打開 Dialog 時看到的原值」（expected）。別人在這之間改過 → 伺服器回
 * stale、顯示「請重新整理」，不會把別人改的欄位蓋回去。
 *
 * 規則與 server 同一份 zod（src/lib/admin/registration-edit.ts），送出前先在瀏覽器驗一次，
 * 讓錯誤訊息是中文、而且就在欄位下面。儲存成功 → onSaved()（呼叫端 router.invalidate()）。
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  contactFormatErrors,
  normalizeParticipantContact,
  PARTICIPANT_EDIT_LIMITS,
  participantContactSchema,
  type ParticipantField,
} from "@/lib/admin/registration-edit";

export type RegistrationEditTarget = {
  registration_id: string;
  session_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  order_no: string;
  seat_no: number;
};

type Props = {
  target: RegistrationEditTarget | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
};

type FieldErrors = Partial<Record<ParticipantField, string>>;

export function RegistrationEditDialog({ target, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 每次打開（換一位）都重新預填現值。
  useEffect(() => {
    if (!target) return;
    setName(target.name);
    setEmail(target.email ?? "");
    setPhone(target.phone ?? "");
    setErrors({});
    setFormError(null);
  }, [target]);

  async function handleSave() {
    if (!target) return;
    setFormError(null);
    const parsed = participantContactSchema.safeParse({ name, email, phone });
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const k = issue.path[0] as ParticipantField;
        if (!next[k]) next[k] = issue.message;
      }
      setErrors(next);
      return;
    }
    // 開啟時的原值：Email／電話格式只驗有改的欄位（舊資料不擋），也一起送給伺服器當樂觀鎖。
    const expected = { name: target.name, email: target.email, phone: target.phone };
    const fmt = contactFormatErrors(
      normalizeParticipantContact(expected),
      normalizeParticipantContact(parsed.data),
    );
    if (fmt.email || fmt.phone) {
      setErrors(fmt);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const { updateRegistrationParticipant } = await import("@/lib/admin/fns/registration-edit");
      const result = await updateRegistrationParticipant({
        data: {
          registrationId: target.registration_id,
          sessionId: target.session_id,
          expected,
          ...parsed.data,
        },
      });
      if (result.reason === "updated") {
        toast.success("已更新參加者資料");
        onClose();
        await onSaved();
      } else if (result.reason === "unchanged") {
        toast.info("沒有任何欄位改變");
        onClose();
      } else {
        setFormError(result.message);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSaving(false);
    }
  }

  const field = (
    id: ParticipantField,
    label: string,
    value: string,
    set: (v: string) => void,
    extra: { type?: string; inputMode?: "email" | "tel"; placeholder?: string; max: number },
  ) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`reg-edit-${id}`}>{label}</Label>
      <Input
        id={`reg-edit-${id}`}
        type={extra.type ?? "text"}
        inputMode={extra.inputMode}
        autoComplete="off"
        maxLength={extra.max + 20}
        placeholder={extra.placeholder}
        value={value}
        disabled={saving}
        aria-invalid={errors[id] ? true : undefined}
        aria-describedby={errors[id] ? `reg-edit-${id}-err` : undefined}
        onChange={(e) => set(e.target.value)}
      />
      {errors[id] ? (
        <p id={`reg-edit-${id}-err`} className="text-sm text-destructive">
          {errors[id]}
        </p>
      ) : null}
    </div>
  );

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>編輯參加者</DialogTitle>
          <DialogDescription>
            訂單 {target?.order_no}・第 {target?.seat_no} 位。換人就直接改姓名與聯絡方式；
            訂單、付款與名額不會變動。
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          {field("name", "姓名", name, setName, { max: PARTICIPANT_EDIT_LIMITS.name })}
          {field("email", "Email（可留空）", email, setEmail, {
            type: "email",
            inputMode: "email",
            placeholder: "name@example.com",
            max: PARTICIPANT_EDIT_LIMITS.email,
          })}
          {field("phone", "電話（可留空）", phone, setPhone, {
            type: "tel",
            inputMode: "tel",
            placeholder: "0912345678",
            max: PARTICIPANT_EDIT_LIMITS.phone,
          })}
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "儲存中…" : "儲存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
