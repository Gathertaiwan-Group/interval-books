/**
 * 新增／編輯活動場次 —— /admin/registrations/new 與 /admin/registrations/$sessionId/edit 的本體
 * （2026-10-25 後台第 2 批：原本是 _shell.registrations.tsx 裡的「新增／編輯場次」彈窗）。
 *
 * 欄位、驗證（eventSessionSchema）、送出的 payload（toIso 轉回 ISO、ends_at 空字串＝null）
 * 一行都沒改，只是外框從 Dialog 換成 AdminDetailPage。
 *
 * ⚠️ 表單只在掛載時從 loader 填一次（react-hook-form 的 defaultValues）：票種寫完會
 *    router.invalidate() 重跑 loader，那時 plans 會更新，但打到一半的場次欄位不可以被蓋掉。
 *    換一個場次＝呼叫端用 key={session.id} 重新掛載。
 *
 * ⚠️ 未存變更防呆算兩份：場次欄位（useFormDirty 比值）＋票種編輯器裡開著、改過的方案表單
 *    （SessionPlansEditor 的 onDirtyChange）。票種本身的新增／編輯／刪除是各自的 RPC、當場就存，
 *    不算「沒存」。
 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { SessionPlansEditor, type PlanRow } from "@/components/admin/SessionPlansEditor";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { eventSessionSchema, type EventSessionFormValues } from "@/lib/admin/schemas";
import type { getEventSessionPageData } from "@/lib/admin/fns/event-sessions";

type PageData = Awaited<ReturnType<typeof getEventSessionPageData>>;
export type SessionRow = NonNullable<PageData["session"]>;
export type ProductRow = PageData["products"][number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

/**
 * timestamptz → `<input type="datetime-local">` 吃得下的字串。
 *
 * 用本地時間的欄位而不是 UTC：店員填的是「這場活動幾點開始」，那是牆上時鐘的
 * 時間。轉回 ISO 由 toIso() 負責，兩支必須成對修改。
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(local: string): string {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function toFormValues(row: SessionRow): EventSessionFormValues {
  return {
    id: row.id,
    product_id: row.product_id,
    title: row.title,
    location: row.location,
    starts_at: toLocalInput(row.starts_at),
    ends_at: toLocalInput(row.ends_at),
    capacity: row.capacity,
    status: row.status,
    sort_order: row.sort_order,
  };
}

type Props = {
  /** null = 新增。 */
  session: SessionRow | null;
  products: ProductRow[];
  /** 已經按這個場次篩過的方案；新增時永遠是空陣列。 */
  plans: PlanRow[];
  nextSortOrder: number;
  /** 「← 回到…」 */
  back: { to: string; label: string; also?: readonly string[] };
  /** 票種的任何一次新增／編輯／刪除之後（router.invalidate()）。 */
  onPlansChanged: () => Promise<void>;
  /** 存檔成功（已經 allowLeave）：呼叫端負責 invalidate 與換頁。 */
  onSaved: () => Promise<void>;
};

const FORM_ID = "admin-session-form";

export function SessionForm({
  session,
  products,
  plans,
  nextSortOrder,
  back,
  onPlansChanged,
  onSaved,
}: Props) {
  const form = useForm<EventSessionFormValues>({
    resolver: zodResolver(eventSessionSchema),
    // 只在掛載時算一次（見檔頭）。
    defaultValues: session
      ? toFormValues(session)
      : {
          product_id: products[0]?.id ?? "",
          title: { ...EMPTY_LOCALIZED },
          location: { ...EMPTY_LOCALIZED },
          starts_at: "",
          ends_at: "",
          capacity: 20,
          // 新場次預設「未開放」，與 0020 回填的場次同一個立場：先建好、確認日期
          // 與名額之後再手動打開。fail-closed。
          status: "closed",
          sort_order: nextSortOrder,
        },
  });
  const [submitting, setSubmitting] = useState(false);
  const [planDirty, setPlanDirty] = useState(false);

  const { dirty: fieldsDirty } = useFormDirty(form.watch());
  const guard = useUnsavedChangesGuard(fieldsDirty || planDirty);

  async function handleSubmit(values: EventSessionFormValues) {
    setSubmitting(true);
    try {
      const { upsertEventSession } = await import("@/lib/admin/fns/event-sessions");
      await upsertEventSession({
        data: {
          ...values,
          id: session ? session.id : undefined,
          starts_at: toIso(values.starts_at),
          ends_at: (values.ends_at ?? "").trim() ? toIso(values.ends_at!) : null,
        },
      });
      toast.success(session ? "已更新場次" : "已新增場次");
      guard.allowLeave();
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  const actions = (
    <Button type="submit" form={FORM_ID} className="gap-1.5" disabled={submitting}>
      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {submitting ? "儲存中…" : session ? "儲存變更" : "新增"}
    </Button>
  );

  return (
    <AdminDetailPage
      backTo={back.to}
      backLabel={back.label}
      backAlso={back.also}
      title={session ? `編輯場次：${session.title.zh}` : "新增場次"}
      meta="中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。名額只能調整上限，已報名人數由系統維護。"
      actions={actions}
    >
      {products.length === 0 ? (
        <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
          目前沒有活動或策旅類型的商品。請先到「商品」新增一件 event／journey
          商品，才能為它建立場次。
        </p>
      ) : null}

      <Form {...form}>
        <form id={FORM_ID} onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
          <FormField
            control={form.control}
            name="product_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>活動商品</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="請選擇活動商品" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.title.zh}
                        {p.status === "active" ? "" : "（未上架）"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <LocalizedField name="title" label="場次名稱" />
          <LocalizedField name="location" label="地點" />

          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="starts_at"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>開始時間</FormLabel>
                  <FormControl>
                    <Input type="datetime-local" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="ends_at"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>結束時間（選填）</FormLabel>
                  <FormControl>
                    <Input type="datetime-local" {...field} value={field.value ?? ""} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="capacity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>名額上限</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={field.value}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormDescription>
                    {session
                      ? `目前已佔用 ${session.seats_taken} 個位子。調降到低於這個數字會被資料庫擋下來。`
                      : "已報名人數由系統維護，不能在這裡填。"}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>狀態</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="closed">未開放</SelectItem>
                      <SelectItem value="open">開放報名</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    只有「開放報名」的場次會出現在前台，也只有它收得了報名。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* 0036：價格方案（票種）。只在編輯既有場次時出現——方案掛在 event_sessions.id 上，
              新建場次那一刻還沒有 id 可以掛。新增場次時這裡完全不畫：存一次場次、再從列表
              按「編輯」，才會看到「新增方案」。 */}
          {session ? (
            <SessionPlansEditor
              sessionId={session.id}
              plans={plans}
              onChanged={onPlansChanged}
              onDirtyChange={setPlanDirty}
            />
          ) : null}

          <FormField
            control={form.control}
            name="sort_order"
            render={({ field }) => (
              <FormItem>
                <FormLabel>排序</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step={1}
                    value={field.value}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </form>
      </Form>

      <div className="hidden justify-end md:flex">{actions}</div>
      {guard.dialog}
    </AdminDetailPage>
  );
}
