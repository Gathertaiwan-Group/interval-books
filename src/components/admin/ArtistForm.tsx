/**
 * 新增／編輯講者（public.artists）—— 表單內頁的本體（/admin/artists/new、/admin/artists/$id）。
 *
 * 2026-10-26 從 _shell.artists.tsx 裡的 Dialog 抽出來改成內頁（後台第 3 批；業主：「不要用彈窗，
 * 直接顯示內頁＆回到上一頁」）。欄位、artistSchema、upsertArtist 一行都沒改。
 *
 * 🔴 語言：這一頁**沒有** <LocalizedField>，而那是故意的。public.artists 的 bio／long_bio／
 *    discipline 在資料庫裡是 `text`，不是三語 jsonb（0019_vendors_pii_portal.sql）。整張表唯一的
 *    第二語言是 name 與 name_en 兩個獨立欄位。所以這裡用普通的 <Input>／<Textarea>，每一個單語
 *    欄位底下都寫著「此欄不分語言」。不要「為了跟其他頁一致」就把 bio 換成 <LocalizedField>：
 *    那個元件讀寫 `bio.zh`，套在字串欄位上會把 {zh: …} 存進一個 text 欄位。
 *
 * ⚠️ vendor_id：看得到，改不動。表單裡**沒有**這個欄位，artistSchema 沒有這個 key，repo 的
 *    upsert payload 也沒有（見 src/server/repos/artists.ts 的檔頭）。inv.vendors 有身分證字號與
 *    匯款帳號，「講者介紹長怎樣」與「廠商的錢匯到哪」是兩個不同的授權決定。
 *
 * ⚠️ 表單只在**掛載時**用 defaultValues 填一次；換一筆由呼叫端 key={id} 重新掛載。
 */
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Mic, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
import { ImageField } from "@/components/admin/ImageField";
import { useUnsavedChangesGuard } from "@/components/admin/UnsavedChangesGuard";
import { useFormDirty } from "@/lib/admin/form-dirty";
import { artistSchema, type ArtistFormValues } from "@/lib/admin/schemas";
import { eventReading } from "@/lib/images";
import type { ArtistRow } from "@/server/repos/artists";

function toFormValues(row: ArtistRow | null, nextSortOrder: number): ArtistFormValues {
  if (!row) {
    return {
      slug: "",
      name: "",
      name_en: "",
      discipline: "",
      bio: "",
      long_bio: "",
      image_key: null,
      portal_url: "",
      sort_order: nextSortOrder,
      is_active: true,
    };
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    name_en: row.name_en ?? "",
    discipline: row.discipline ?? "",
    bio: row.bio ?? "",
    long_bio: row.long_bio ?? "",
    image_key: row.image_key,
    portal_url: row.portal_url ?? "",
    sort_order: row.sort_order,
    is_active: row.is_active,
  };
}

/** 每一個單語欄位底下都掛這一句，理由見本檔檔頭的「語言」那一段。 */
const SINGLE_LANGUAGE_NOTE = "此欄目前不分語言，中／英／日三種語系都會顯示同一份內容。";

type Props = {
  artist: ArtistRow | null; // null = 新增
  /** 新增時的預設排序（max + 1，與原本的彈窗相同）。 */
  nextSortOrder?: number;
  /** 存檔成功（已經 allowLeave）：呼叫端負責 invalidate 與換頁。 */
  onSaved: () => Promise<void>;
};

export function ArtistForm({ artist, nextSortOrder = 1, onSaved }: Props) {
  const form = useForm<ArtistFormValues>({
    resolver: zodResolver(artistSchema),
    defaultValues: toFormValues(artist, nextSortOrder),
  });
  const [saving, setSaving] = useState(false);
  /** 唯讀顯示用。表單永遠不寫這個值，見本檔檔頭。 */
  const vendorLinked = Boolean(artist?.vendor_id);

  const { dirty } = useFormDirty(form.watch());
  const guard = useUnsavedChangesGuard(dirty);

  async function handleSubmit(values: ArtistFormValues) {
    setSaving(true);
    try {
      const { upsertArtist } = await import("@/lib/admin/fns/artists");
      await upsertArtist({ data: artist ? { ...values, id: artist.id } : values });
      toast.success(artist ? "已更新講者" : "已新增講者");
      guard.allowLeave();
      await onSaved();
    } catch (err) {
      // 不吞掉：upsertArtist（src/server/repos/artists.ts）在 slug 撞唯一鍵時會丟
      // 一個指名那個代稱的訊息，那個訊息就是這裡要顯示的東西。
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <Button type="submit" form="artist-form" className="gap-1.5" disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {saving ? "儲存中…" : artist ? "儲存變更" : "新增"}
    </Button>
  );

  return (
    <AdminDetailPage
      backTo="/admin/artists"
      backLabel="回講者列表"
      icon={<Mic className="h-5 w-5" aria-hidden="true" />}
      title={artist ? `編輯講者：${artist.name}` : "新增講者"}
      meta="這一頁的欄位除了「姓名（英文）」之外都不分語言，中／英／日三種語系會顯示同一份內容。"
      actions={actions}
      width="md"
    >
      <Form {...form}>
        <form id="artist-form" onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
          <FormField
            control={form.control}
            name="slug"
            render={({ field }) => (
              <FormItem>
                <FormLabel>網址代稱</FormLabel>
                <FormControl>
                  <Input placeholder="例如 wang-xiaoming" {...field} />
                </FormControl>
                <FormDescription>
                  建議使用半形英數字與連字號，且不能與其他講者重複。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>姓名</FormLabel>
                  <FormControl>
                    <Input placeholder="例如 王小明" {...field} />
                  </FormControl>
                  <FormDescription>
                    {SINGLE_LANGUAGE_NOTE}人名不會被自動翻譯，右邊的英文名要自己填。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="name_en"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>姓名（英文，選填）</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="例如 Wang Xiaoming"
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                    />
                  </FormControl>
                  <FormDescription>
                    這是整張表唯一有第二語言的欄位。留空就三種語系都顯示左邊的姓名。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="discipline"
            render={({ field }) => (
              <FormItem>
                <FormLabel>領域／頭銜（選填）</FormLabel>
                <FormControl>
                  <Input
                    placeholder="例如 作家、攝影師、獨立書店店主"
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                  />
                </FormControl>
                <FormDescription>{SINGLE_LANGUAGE_NOTE}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="bio"
            render={({ field }) => (
              <FormItem>
                <FormLabel>短介紹（選填）</FormLabel>
                <FormControl>
                  <Textarea
                    rows={3}
                    placeholder="一兩句話，列表與卡片上會用到"
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                  />
                </FormControl>
                <FormDescription>{SINGLE_LANGUAGE_NOTE}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="long_bio"
            render={({ field }) => (
              <FormItem>
                <FormLabel>完整介紹（選填）</FormLabel>
                <FormControl>
                  <Textarea
                    rows={8}
                    placeholder="活動頁「講者介紹」那一塊會顯示的完整經歷"
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                  />
                </FormControl>
                <FormDescription>{SINGLE_LANGUAGE_NOTE}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="portal_url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>個人網站／社群連結（選填）</FormLabel>
                <FormControl>
                  <Input
                    type="url"
                    placeholder="https://example.com"
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                  />
                </FormControl>
                <FormDescription>留空代表沒有；有填的話必須是完整網址。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="image_key"
            render={({ field }) => (
              <FormItem>
                <FormLabel>講者照片</FormLabel>
                {/* 不包在 <FormControl>（Radix Slot）裡：ImageField 是一個複合元件，
                    不是 Input/Switch 那種 forwardRef 原生元件，Slot 的 ref 複製只會
                    在 console 噴警告，沒有任何好處。同 _shell.exhibitions.tsx。 */}
                <ImageField
                  value={field.value ?? null}
                  onChange={field.onChange}
                  fallback={eventReading}
                />
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
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

            <FormField
              control={form.control}
              name="is_active"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>啟用狀態</FormLabel>
                  <div className="flex h-9 items-center gap-2">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <span className="text-sm text-muted-foreground">
                      {field.value ? "啟用中" : "已停用"}
                    </span>
                  </div>
                  <FormDescription>
                    停用之後前台不再顯示，活動後台的「主講人」下拉也不再列出——但已經掛上的活動不受影響。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* 唯讀的一列。**沒有輸入框，也沒有註冊到表單裡** —— 見本檔檔頭。 */}
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
            <p className="text-sm font-medium">
              進銷存廠商綁定：
              <span className="font-normal text-muted-foreground">
                {vendorLinked ? "已綁定" : "未綁定"}
              </span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              唯讀。廠商資料裡有統編、身分證字號與匯款帳號，屬於進銷存那一側的授權範圍，不能從這一頁修改。要調整綁定請到「廠商」頁。
            </p>
          </div>
        </form>
      </Form>

      <div className="hidden justify-end md:flex">{actions}</div>
      {guard.dialog}
    </AdminDetailPage>
  );
}
