/**
 * 編輯策旅卡片（public.journeys）—— 表單內頁的本體（/admin/journeys/$id）。
 *
 * 2026-10-25 從 _shell.journeys.tsx 裡的編輯 Dialog 抽出來改成內頁（業主：「不要用彈窗，
 * 直接顯示內頁＆回到上一頁」）。欄位、journeySchema、upsertJourney 一行都沒改。
 *
 * ⚠️ 為什麼不是 /admin/journeys/new 那個 EventQuickCreate：新增頁是「一頁新增策旅」——
 *    卡片＋報名頁＋梯次＋票種一次建好，寫入走 createEventQuick。編輯既有策旅只改這張卡片
 *    的三語文字與報名設定（梯次、票種在活動那邊改），寫入是 upsertJourney。兩者寫的東西
 *    不一樣，硬共用一個元件只會讓其中一邊多出一堆存不進去的欄位。
 *
 * ⚠️ 中文、英文、日文皆為必填（資料庫 is_localized CHECK），zod 在送出前擋一次。
 * ⚠️ 表單只在**掛載時**用 defaultValues 填一次（react-hook-form 的行為）；loader 之後重跑
 *    不會蓋掉打到一半的欄位。換一筆由呼叫端 key={id} 重新掛載。
 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Map as MapIcon, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { journeySchema, type JourneyFormValues } from "@/lib/admin/schemas";
import { Link } from "@tanstack/react-router";
import { ListingStatusBadge, ListingStatusSelect } from "@/components/admin/ListingStatus";
import { LISTING_STATUS_LABEL, type ListingStatus } from "@/lib/listing-status";
import type { JourneyRow } from "@/server/repos/journeys";

function journeyToFormValues(row: JourneyRow): JourneyFormValues {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    description: row.description,
    days: row.days,
    theme: row.theme,
    external_url: row.external_url,
    registration_type: row.registration_type,
    payment_enabled: row.payment_enabled,
    sort_order: row.sort_order,
  };
}

type Props = {
  journey: JourneyRow;
  /** 0052：這張卡片跟著的活動（連得上才有）。有的話狀態只能到活動那邊改。 */
  linkedEvent: { id: string; title: string; status: ListingStatus } | null;
  /** 孤兒卡片改完狀態（已寫入）：呼叫端負責 invalidate。 */
  onStatusChanged: () => Promise<void>;
  /** 存檔成功（已經 allowLeave）：呼叫端負責 invalidate 與換頁。 */
  onSaved: () => Promise<void>;
};

export function JourneyForm({ journey, linkedEvent, onSaved, onStatusChanged }: Props) {
  const form = useForm<JourneyFormValues>({
    resolver: zodResolver(journeySchema),
    defaultValues: journeyToFormValues(journey),
  });
  const [saving, setSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);

  /** 只有孤兒卡片走得到這裡（連得上活動的卡片畫面上沒有選擇器，RPC 也會拒絕）。 */
  async function changeOrphanStatus(next: ListingStatus) {
    if (next === journey.status) return;
    setStatusSaving(true);
    try {
      const { setJourneyStatus } = await import("@/lib/admin/fns/journeys");
      await setJourneyStatus({ data: { id: journey.id, status: next } });
      toast.success(`策旅卡片已改成「${LISTING_STATUS_LABEL[next]}」`);
      await onStatusChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "改狀態失敗，請稍後再試");
    } finally {
      setStatusSaving(false);
    }
  }

  const { dirty } = useFormDirty(form.watch());
  const guard = useUnsavedChangesGuard(dirty);

  async function handleSubmit(values: JourneyFormValues) {
    setSaving(true);
    try {
      const { upsertJourney } = await import("@/lib/admin/fns/journeys");
      await upsertJourney({ data: { ...values, id: journey.id } });
      toast.success("已更新策旅");
      guard.allowLeave();
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <Button type="submit" form="journey-form" className="gap-1.5" disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {saving ? "儲存中…" : "儲存變更"}
    </Button>
  );

  return (
    <AdminDetailPage
      backTo="/admin/journeys"
      backLabel="回策旅列表"
      icon={<MapIcon className="h-5 w-5" aria-hidden="true" />}
      title={`編輯策旅：${journey.title.zh}`}
      meta="中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。梯次與票種請到活動那邊改。"
      actions={actions}
      width="md"
    >
      <Form {...form}>
        <form id="journey-form" onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
          <LocalizedField name="title" label="標題" />
          <LocalizedField name="summary" label="摘要" multiline />
          <LocalizedField name="description" label="說明" multiline />
          <LocalizedField name="days" label="天數" />
          <LocalizedField name="theme" label="主題關鍵字" />

          <FormField
            control={form.control}
            name="external_url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>報名網址</FormLabel>
                <FormControl>
                  <Input placeholder="https:// 或 /events/…" {...field} />
                </FormControl>
                <FormDescription className="break-words">
                  外部策旅填完整網址（含 https://）；站內報名的策旅填站內路徑，例如
                  /events/InntervalChishang.1023。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="registration_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>報名方式</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="請選擇報名方式" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="external">外部連結</SelectItem>
                      <SelectItem value="internal">內部報名</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="payment_enabled"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>線上付款</FormLabel>
                  <div className="flex h-9 items-center gap-2">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <span className="text-sm text-muted-foreground">
                      {field.value ? "已啟用" : "未啟用"}
                    </span>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="sort_order"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>排序（數字越小越前面）</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={field.value}
                      onChange={(e) =>
                        field.onChange(e.target.value === "" ? 0 : Number(e.target.value))
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* 0052：卡片沒有自己的發布開關。連到活動的卡片跟著活動的狀態（活動、票券、
                卡片同一個交易切換）；只有連不到任何活動的舊卡片才在這裡直接改。 */}
            <div className="space-y-2">
              <p className="text-sm font-medium">狀態</p>
              {linkedEvent ? (
                <div className="space-y-1.5 text-sm">
                  <ListingStatusBadge status={journey.status} />
                  <p className="text-xs text-muted-foreground">
                    跟著活動「{linkedEvent.title}」。要上架或下架，請到{" "}
                    <Link
                      to="/admin/events/$id"
                      params={{ id: linkedEvent.id }}
                      className="underline underline-offset-2"
                    >
                      活動頁
                    </Link>{" "}
                    最上面的「狀態」切換，卡片會一起跟著。
                  </p>
                </div>
              ) : (
                <ListingStatusSelect
                  value={journey.status}
                  onChange={(v) => void changeOrphanStatus(v)}
                  disabled={statusSaving}
                />
              )}
            </div>
          </div>
        </form>
      </Form>

      <div className="hidden justify-end md:flex">{actions}</div>
      {guard.dialog}
    </AdminDetailPage>
  );
}
