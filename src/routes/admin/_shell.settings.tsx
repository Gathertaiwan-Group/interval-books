import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { AdvancedSection } from "@/components/admin/AdvancedSection";
import { siteSettingsSchema, type SiteSettingsFormValues } from "@/lib/admin/schemas";
import type { getSiteSettings } from "@/lib/admin/fns/site-settings";

type SiteSettingsData = Awaited<ReturnType<typeof getSiteSettings>>;

/**
 * site_settings is a DB-enforced singleton (check (id = 1) — see
 * src/server/repos/site-settings.ts), so this page is a plain "load the one
 * row, edit, save" form rather than a list + dialog like every other admin
 * resource: there is nothing to create or delete.
 */
export const Route = createFileRoute("/admin/_shell/settings")({
  loader: async () => {
    const { getSiteSettings } = await import("@/lib/admin/fns/site-settings");
    const settings = await getSiteSettings();
    return { settings };
  },
  head: () => ({
    meta: [{ title: "全站設定｜小時光書店後台" }],
  }),
  component: AdminSettingsPage,
});

function toFormValues(settings: SiteSettingsData): SiteSettingsFormValues {
  return {
    short_desc: settings.short_desc,
    address: settings.address,
    city: settings.city,
    hours: settings.hours,
    closed: settings.closed,
    contact_email: settings.contact_email,
    site_url: settings.site_url,
    social_instagram: settings.social_instagram,
    social_facebook: settings.social_facebook,
    social_line: settings.social_line,
    map_embed: settings.map_embed,
    map_link: settings.map_link,
    map_apple: settings.map_apple,
    meta_site_name: settings.meta_site_name,
    meta_author: settings.meta_author,
    meta_twitter_card: settings.meta_twitter_card,
    meta_og_type: settings.meta_og_type,
    default_meta_title: settings.default_meta_title,
    default_meta_description: settings.default_meta_description,
    notify_emails: settings.notify_emails,
  };
}

function AdminSettingsPage() {
  const { settings } = Route.useLoaderData();
  const router = useRouter();

  const form = useForm<SiteSettingsFormValues>({
    resolver: zodResolver(siteSettingsSchema),
    defaultValues: toFormValues(settings),
  });

  async function handleSubmit(values: SiteSettingsFormValues) {
    try {
      const { updateSiteSettings } = await import("@/lib/admin/fns/site-settings");
      await updateSiteSettings({ data: values });
      toast.success("已儲存全站設定");
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    }
  }

  const submitting = form.formState.isSubmitting;
  const errors = form.formState.errors;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium">全站設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          單一設定頁，修改後點下方「儲存變更」一次套用到全站。
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>基本資訊</CardTitle>
              <CardDescription>店家簡介、地址、營業時間與聯絡信箱。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <LocalizedField name="short_desc" label="店家簡介" multiline />
              <LocalizedField name="address" label="地址" />
              <LocalizedField name="city" label="所在城市" />
              <LocalizedField name="hours" label="營業時間" />
              <LocalizedField name="closed" label="公休說明" />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="contact_email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>聯絡信箱</FormLabel>
                      <FormControl>
                        <Input type="email" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="site_url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>網站網址</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>訂單通知</CardTitle>
              <CardDescription>
                有新訂單或新報名、且付款成功時，系統會寄一封通知信到這裡——內容是訂單摘要，不含客人的完整地址與電話，完整資料請登入後台查看。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="notify_emails"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>通知信收件人</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="例如 info@intervalbooks.tw, owner@intervalbooks.tw"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      多個信箱請用逗號分隔。留空即代表暫時不寄送新訂單通知信。
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>社群連結</CardTitle>
              <CardDescription>
                留空即可隱藏該項連結——前台頁尾會自動略過空白的社群連結，不算必填。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="social_instagram"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Instagram 網址</FormLabel>
                    <FormControl>
                      <Input placeholder="留空可隱藏頁尾的 Instagram 連結" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="social_facebook"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Facebook 網址</FormLabel>
                    <FormControl>
                      <Input placeholder="留空可隱藏頁尾的 Facebook 連結" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="social_line"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>LINE 連結</FormLabel>
                    <FormControl>
                      <Input placeholder="留空可隱藏頁尾的 LINE 連結" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>地圖</CardTitle>
              <CardDescription>
                來店資訊頁的導航連結。嵌入地圖用的網址在最下方「進階」。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="map_link"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Google 地圖連結</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="map_apple"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Apple 地圖連結</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>SEO 預設值</CardTitle>
              <CardDescription>各頁未個別設定 meta 時，網站層級使用的預設值。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="meta_site_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>網站名稱（meta）</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="default_meta_title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>預設頁面標題</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="default_meta_description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>預設頁面描述</FormLabel>
                    <FormControl>
                      <Textarea rows={3} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <AdvancedSection
            title="進階（通常不用改）"
            hint="地圖嵌入網址、分享卡片類型、作者"
            forceOpen={Boolean(
              errors.map_embed ||
              errors.meta_author ||
              errors.meta_twitter_card ||
              errors.meta_og_type,
            )}
          >
            <FormField
              control={form.control}
              name="map_embed"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>地圖嵌入網址</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                  <FormDescription>Google 地圖 embed 用網址，貼在頁面中顯示地圖。</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="meta_author"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>作者（meta）</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="meta_twitter_card"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Twitter Card 類型</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="meta_og_type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Open Graph 類型</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </AdvancedSection>

          <div className="flex justify-end">
            <Button type="submit" disabled={submitting}>
              {submitting ? "儲存中…" : "儲存變更"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
