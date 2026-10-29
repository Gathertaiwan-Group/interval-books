/**
 * /admin/journey-wishes/$id —— 一筆旅程願望（0046 之後）。
 *
 * 照 /admin/partnerships/$id：完整內容、「回信」＝ mailto:（有留信箱才有）、狀態
 * 未處理 → 已看過 → 已封存、內部備註。loader 叫 getJourneyWish（GET，adminFnMiddleware）；
 * 存檔走 updateJourneyWish 後 router.invalidate({ sync: true })，留在這一頁。
 */
import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Loader2, Mail, Save, Sparkles } from "lucide-react";
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
import { wishSourceLabel } from "@/lib/journey-wish";
import {
  WISH_EMAIL_STATUS_LABEL,
  WISH_STATUSES,
  WISH_STATUS_LABEL,
  isWishStatus,
  wishReplyMailto,
  wishSummary,
  type WishStatus,
} from "@/lib/journey-wish-inbox";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import { isUuid } from "@/lib/admin/order-labels";
import type { WishDetailRow, WishListRow } from "@/server/repos/journey-wishes";

export const Route = createFileRoute("/admin/_shell/journey-wishes_/$id")({
  loader: async ({ params }) => {
    if (!isUuid(params.id)) return { wish: null };
    const { getJourneyWish } = await import("@/lib/admin/fns/journey-wishes");
    return { wish: await getJourneyWish({ data: { id: params.id } }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.wish
          ? `旅程願望：${loaderData.wish.name || "未留稱呼"}｜小時光書店後台`
          : "旅程願望｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: WishPending,
  component: WishPage,
});

function WishPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<WishListRow>("journey-wish", id);
  return (
    <AdminDetailPending
      backTo="/admin/journey-wishes"
      backLabel="回旅程願望"
      title={peek ? `旅程願望：${peek.name || wishSummary(peek)}` : undefined}
      width="lg"
    />
  );
}

function WishPage() {
  const { wish } = Route.useLoaderData();
  if (!wish) {
    return (
      <AdminDetailNotFound
        backTo="/admin/journey-wishes"
        backLabel="回旅程願望"
        message="找不到這筆旅程願望，可能網址有誤。"
      />
    );
  }
  return <WishEditor key={`${wish.id}:${wish.updated_at}`} wish={wish} />;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function WishEditor({ wish }: { wish: WishDetailRow }) {
  const router = useRouter();
  const [status, setStatus] = useState<WishStatus>(wish.status);
  const [note, setNote] = useState(wish.admin_note ?? "");
  const [saving, setSaving] = useState(false);
  const { dirty, markClean } = useFormDirty({ status, note });
  const guard = useUnsavedChangesGuard(dirty);
  const mailto = wishReplyMailto(wish);

  async function save(next?: WishStatus) {
    const s = next ?? status;
    setSaving(true);
    try {
      const { updateJourneyWish } = await import("@/lib/admin/fns/journey-wishes");
      await updateJourneyWish({ data: { id: wish.id, status: s, admin_note: note } });
      setStatus(s);
      markClean({ status: s, note });
      toast.success(`已儲存（${WISH_STATUS_LABEL[s]}）`);
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
      backTo="/admin/journey-wishes"
      backLabel="回旅程願望"
      icon={<Sparkles className="h-5 w-5" aria-hidden="true" />}
      title={`旅程願望：${wish.name || "未留稱呼"}`}
      titleExtra={
        <Badge variant={wish.status === "new" ? "default" : "secondary"}>
          {WISH_STATUS_LABEL[wish.status]}
        </Badge>
      }
      meta={`收到時間 ${formatTaipeiDateTime(wish.created_at)}・${wishSourceLabel(wish.source)}`}
      actions={actions}
      width="lg"
    >
      {guard.dialog}
      <section className="rounded-md border border-border p-4">
        <h2 className="mb-3 text-sm font-medium">願望</h2>
        <dl className="mb-4 grid gap-3">
          <Field label="下一次最想體驗">
            {wish.interests.length ? (
              <span className="flex flex-wrap gap-1.5">
                {wish.interests.map((i) => (
                  <Badge key={i} variant="outline" className="font-normal">
                    {i}
                  </Badge>
                ))}
              </span>
            ) : (
              "（未選）"
            )}
          </Field>
        </dl>
        <p className="whitespace-pre-wrap break-words rounded bg-muted/50 p-3 text-sm leading-relaxed">
          {wish.wish || "（沒有寫願望）"}
        </p>
      </section>

      <section className="rounded-md border border-border p-4">
        <h2 className="mb-3 text-sm font-medium">聯絡資料（選填）</h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Field label="怎麼稱呼">{wish.name || "—"}</Field>
          <Field label="電子信箱">
            {mailto ? (
              <a href={mailto} className="underline underline-offset-2">
                {wish.email}
              </a>
            ) : (
              wish.email || "—"
            )}
          </Field>
          <Field label="免費加入小時光知友">{wish.join_friends ? "是" : "否"}</Field>
          <Field label="同意接收未來策旅通知">{wish.notify_opt_in ? "是" : "否"}</Field>
        </dl>
      </section>

      <section className="space-y-4 rounded-md border border-border p-4">
        <h2 className="text-sm font-medium">處理</h2>
        <div className="space-y-2">
          <Label>狀態</Label>
          <RadioGroup
            value={status}
            onValueChange={(v) => isWishStatus(v) && setStatus(v)}
            className="flex flex-wrap gap-4"
          >
            {WISH_STATUSES.map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-2 text-sm">
                <RadioGroupItem value={s} />
                {WISH_STATUS_LABEL[s]}
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
            placeholder="例如：已加入知友名單；明年春天的建築走讀可以參考"
          />
        </div>
        {wish.status === "new" && !dirty ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={saving}
            onClick={() => void save("reviewed")}
          >
            標成已看過
          </Button>
        ) : null}
      </section>

      <p className="text-xs text-muted-foreground">
        通知信：{WISH_EMAIL_STATUS_LABEL[wish.email_status] ?? wish.email_status}
        {wish.email_status === "failed" && wish.email_error ? `（${wish.email_error}）` : ""}
        {wish.page_url ? `・來源頁面 ${wish.page_url}` : ""}
      </p>
    </AdminDetailPage>
  );
}
