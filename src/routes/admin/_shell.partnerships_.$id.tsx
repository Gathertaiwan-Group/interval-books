/**
 * /admin/partnerships/$id —— 一筆合作邀約（2026-10-28）。
 *
 * 完整聯絡方式與內容（業主已拿掉後台的個資遮罩）、「回信」＝ mailto:（主旨預填
 * 「Re: 【異業合作】類型｜公司」，用店家自己的信箱寄，不經過這個站）、狀態
 * 未處理 → 已回覆 → 已封存、內部備註。loader 叫 getPartnershipInquiry（GET，
 * adminFnMiddleware）；存檔走 updatePartnershipInquiry 後 router.invalidate({ sync: true })，
 * 列表的數字與這一頁一起更新，留在這一頁。
 */
import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Handshake, Loader2, Mail, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPage,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { readAdminPeek } from "@/lib/admin/list-memory";
import {
  EMAIL_STATUS_LABEL,
  INQUIRY_STATUSES,
  INQUIRY_STATUS_LABEL,
  inquiryBudgetLabel,
  inquiryTypeLabel,
  isInquiryStatus,
  replyMailto,
  type InquiryStatus,
} from "@/lib/partnership-inbox";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import { isUuid } from "@/lib/admin/order-labels";
import type { InquiryDetailRow, InquiryListRow } from "@/server/repos/partnership-inquiries";

const LANG_LABEL: Record<string, string> = { zh: "中文", en: "English", ja: "日本語" };

export const Route = createFileRoute("/admin/_shell/partnerships_/$id")({
  loader: async ({ params }) => {
    if (!isUuid(params.id)) return { inquiry: null };
    const { getPartnershipInquiry } = await import("@/lib/admin/fns/partnerships");
    return { inquiry: await getPartnershipInquiry({ data: { id: params.id } }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.inquiry
          ? `合作邀約：${loaderData.inquiry.company}｜小時光書店後台`
          : "異業合作｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: InquiryPending,
  component: InquiryPage,
});

function InquiryPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<InquiryListRow>("partnership", id);
  return (
    <AdminDetailPending
      backTo="/admin/partnerships"
      backLabel="回異業合作"
      title={peek ? `合作邀約：${peek.company}` : undefined}
      width="lg"
    />
  );
}

function InquiryPage() {
  const { inquiry } = Route.useLoaderData();
  if (!inquiry) {
    return (
      <AdminDetailNotFound
        backTo="/admin/partnerships"
        backLabel="回異業合作"
        message="找不到這筆合作邀約，可能網址有誤。"
      />
    );
  }
  return <InquiryEditor key={`${inquiry.id}:${inquiry.updated_at}`} inquiry={inquiry} />;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function InquiryEditor({ inquiry }: { inquiry: InquiryDetailRow }) {
  const router = useRouter();
  const [status, setStatus] = useState<InquiryStatus>(inquiry.status);
  const [note, setNote] = useState(inquiry.admin_note ?? "");
  const [saving, setSaving] = useState(false);
  const { dirty, markClean } = useFormDirty({ status, note });
  const guard = useUnsavedChangesGuard(dirty);
  const mailto = replyMailto(inquiry);

  async function save(next?: InquiryStatus) {
    const s = next ?? status;
    setSaving(true);
    try {
      const { updatePartnershipInquiry } = await import("@/lib/admin/fns/partnerships");
      await updatePartnershipInquiry({ data: { id: inquiry.id, status: s, admin_note: note } });
      setStatus(s);
      markClean({ status: s, note });
      toast.success(`已儲存（${INQUIRY_STATUS_LABEL[s]}）`);
      guard.allowLeave();
      await router.invalidate({ sync: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <>
      {mailto ? (
        <Button asChild variant="outline" className="gap-1.5">
          <a href={mailto}>
            <Mail className="h-4 w-4" />
            回信
          </a>
        </Button>
      ) : null}
      <Button className="gap-1.5" disabled={saving || !dirty} onClick={() => void save()}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {saving ? "儲存中…" : "儲存"}
      </Button>
    </>
  );

  return (
    <AdminDetailPage
      backTo="/admin/partnerships"
      backLabel="回異業合作"
      icon={<Handshake className="h-5 w-5" aria-hidden="true" />}
      title={`合作邀約：${inquiry.company}`}
      titleExtra={
        <Badge variant={inquiry.status === "new" ? "default" : "secondary"}>
          {INQUIRY_STATUS_LABEL[inquiry.status]}
        </Badge>
      }
      meta={`收到時間 ${formatTaipeiDateTime(inquiry.created_at)}・${inquiryTypeLabel(inquiry.type)}`}
      actions={actions}
      width="lg"
    >
      {guard.dialog}
      <section className="rounded-md border border-border p-4">
        <h2 className="mb-3 text-sm font-medium">聯絡資料</h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label="公司／品牌">{inquiry.company}</Field>
          <Field label="聯絡人">{inquiry.contact_name}</Field>
          <Field label="Email">
            {mailto ? (
              <a href={mailto} className="underline underline-offset-2">
                {inquiry.email}
              </a>
            ) : (
              inquiry.email
            )}
          </Field>
          <Field label="電話">
            {inquiry.phone ? (
              <a
                href={`tel:${inquiry.phone.replace(/[^0-9+#]/g, "")}`}
                className="underline underline-offset-2"
              >
                {inquiry.phone}
              </a>
            ) : (
              "—"
            )}
          </Field>
          <Field label="官網／社群">
            {/^https?:\/\//i.test(inquiry.website) ? (
              <a
                href={inquiry.website}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="break-all underline underline-offset-2"
              >
                {inquiry.website}
              </a>
            ) : (
              inquiry.website || "—"
            )}
          </Field>
          <Field label="填表語言">{LANG_LABEL[inquiry.lang] ?? inquiry.lang}</Field>
        </dl>
      </section>

      <section className="rounded-md border border-border p-4">
        <h2 className="mb-3 text-sm font-medium">合作內容</h2>
        <dl className="mb-4 grid gap-3 sm:grid-cols-3">
          <Field label="合作類型">{inquiryTypeLabel(inquiry.type)}</Field>
          <Field label="預計時間">{inquiry.timeframe || "—"}</Field>
          <Field label="預算">{inquiryBudgetLabel(inquiry.budget)}</Field>
        </dl>
        <p className="whitespace-pre-wrap break-words rounded bg-muted/50 p-3 text-sm leading-relaxed">
          {inquiry.message}
        </p>
      </section>

      <section className="space-y-4 rounded-md border border-border p-4">
        <h2 className="text-sm font-medium">處理</h2>
        <div className="space-y-2">
          <Label>狀態</Label>
          <RadioGroup
            value={status}
            onValueChange={(v) => isInquiryStatus(v) && setStatus(v)}
            className="flex flex-wrap gap-4"
          >
            {INQUIRY_STATUSES.map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem value={s} />
                {INQUIRY_STATUS_LABEL[s]}
              </label>
            ))}
          </RadioGroup>
        </div>
        <div className="space-y-2">
          <Label htmlFor="admin-note">內部備註（只有後台看得到）</Label>
          <Textarea
            id="admin-note"
            value={note}
            maxLength={2000}
            rows={4}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：已約 11/5 下午看場地；報價寄出待回覆"
          />
        </div>
        {inquiry.status === "new" && !dirty ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={saving}
            onClick={() => void save("replied")}
          >
            標成已回覆
          </Button>
        ) : null}
      </section>

      <p className="text-xs text-muted-foreground">
        通知信：{EMAIL_STATUS_LABEL[inquiry.email_status] ?? inquiry.email_status}
        {inquiry.email_status === "failed" && inquiry.email_error
          ? `（${inquiry.email_error}）`
          : ""}
        {inquiry.page_url ? `・來源頁面 ${inquiry.page_url}` : ""}
      </p>
    </AdminDetailPage>
  );
}
