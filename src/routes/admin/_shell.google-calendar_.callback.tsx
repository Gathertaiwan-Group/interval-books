/**
 * /admin/google-calendar/callback —— Google OAuth 同意畫面按完「允許」後導回這裡。
 *
 * 必須與 Google Cloud Console 裡登記的「已授權的重新導向 URI」逐字相同
 * （src/server/google-calendar-config.ts 的 DEFAULT_REDIRECT_URI）。
 *
 * 在 _shell 底下，所以沒登入後台會先被導去登入；真正的授權檢查在
 * completeGoogleCalendarConnect（adminFnMiddleware＋state cookie＋同一位管理員）。
 * code 只在掛載後由瀏覽器送一次（ref 擋 StrictMode 的第二次），用完把網址換掉。
 */
import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";

const searchSchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

export const Route = createFileRoute("/admin/_shell/google-calendar_/callback")({
  validateSearch: (s) => searchSchema.parse(s),
  head: () => ({ meta: [{ title: "連結 Google 日曆｜小時光書店後台" }] }),
  component: GoogleCalendarCallback,
});

function GoogleCalendarCallback() {
  const { code, state, error } = Route.useSearch();
  const navigate = useNavigate();
  const started = useRef(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(
    error
      ? {
          ok: false,
          text:
            error === "access_denied" ? "已取消授權，日曆沒有連結。" : `Google 回傳錯誤：${error}`,
        }
      : !code || !state
        ? { ok: false, text: "缺少授權參數，請回到 Google 日曆頁重新連結。" }
        : null,
  );

  useEffect(() => {
    if (started.current || !code || !state || error) return;
    started.current = true;
    (async () => {
      try {
        const fns = await import("@/lib/admin/fns/google-calendar");
        const r = await fns.completeGoogleCalendarConnect({ data: { code, state } });
        setMsg({
          ok: true,
          text: `已連結 ${r.account ?? "Google 帳號"}。下一步：選擇要寫入的日曆。`,
        });
        await navigate({ to: "/admin/google-calendar", replace: true });
      } catch (err) {
        setMsg({ ok: false, text: err instanceof Error ? err.message : "連結失敗，請重試。" });
        // 把 code／state 從網址拿掉，重新整理不會再送一次。
        await navigate({ to: "/admin/google-calendar/callback", search: {}, replace: true });
      }
    })();
  }, [code, state, error, navigate]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-medium">連結 Google 日曆</h1>
      <p className={msg && !msg.ok ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {msg ? msg.text : "正在完成連結…"}
      </p>
      {msg && !msg.ok && (
        <Button asChild variant="outline">
          <Link to="/admin/google-calendar">回 Google 日曆同步</Link>
        </Button>
      )}
    </div>
  );
}
