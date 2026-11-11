/**
 * /admin/google-calendar —— 活動同步進業主自己的 Google 日曆（0060）。
 *
 * 取代 /calendar.ics 訂閱（那會出現在 Google 日曆的「其他日曆」）。連結一次之後，網站把上架
 * 活動的每個場次直接寫進選定的日曆（「我的日曆」裡），每 15 分鐘＋後台存檔後自動更新。
 * 只動網站自己建立的事件；日曆裡業主手動建立的行程一律不碰（src/lib/google-calendar-sync.ts）。
 *
 * 只有 admin（server fn 掛 adminFnMiddleware；側欄 staff:false）。
 */
import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { CalendarSync, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import type { GoogleCalendarStatus } from "@/server/google-calendar";
import type { CalendarListItem } from "@/server/google-calendar-api";

export const Route = createFileRoute("/admin/_shell/google-calendar")({
  loader: async () => {
    const { getGoogleCalendarStatus } = await import("@/lib/admin/fns/google-calendar");
    return { status: await getGoogleCalendarStatus() };
  },
  head: () => ({ meta: [{ title: "Google 日曆同步｜小時光書店後台" }] }),
  component: GoogleCalendarPage,
});

const TRIGGER: Record<string, string> = { cron: "排程", manual: "手動", save: "存檔後" };

function fns() {
  return import("@/lib/admin/fns/google-calendar");
}

function errText(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

function GoogleCalendarPage() {
  const { status } = Route.useLoaderData();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <CalendarSync className="h-5 w-5" aria-hidden="true" />
          Google 日曆同步
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          把上架活動的每個場次（含策旅、報名截止與包場場次）直接寫進書店自己的 Google
          日曆，出現在「我的日曆」。每 15
          分鐘、以及後台存檔／上下架後自動更新；只會動網站自己建立的事件，
          日曆裡手動建立的行程不會被修改或刪除。
        </p>
      </div>
      {status.configured ? <Configured status={status} /> : <NotConfigured status={status} />}
    </div>
  );
}

function NotConfigured({
  status,
}: {
  status: Extract<GoogleCalendarStatus, { configured: false }>;
}) {
  return (
    <div className="rounded-md border border-border p-4 text-sm">
      <p className="font-medium">尚未設定</p>
      <p className="mt-1 text-muted-foreground">
        需要先在 Google Cloud Console 建立 OAuth 用戶端，並在 Vercel 設定環境變數，才能連結日曆。
      </p>
      {status.missing.length > 0 && <p className="mt-2">缺少：{status.missing.join("、")}</p>}
      {status.invalid.length > 0 && (
        <p className="mt-1 text-destructive">格式不正確：{status.invalid.join("、")}</p>
      )}
    </div>
  );
}

function Configured({ status }: { status: Extract<GoogleCalendarStatus, { configured: true }> }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<CalendarListItem[] | null>(null);
  const [picked, setPicked] = useState(status.calendarId ?? "");
  const [manualId, setManualId] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [removeEvents, setRemoveEvents] = useState(true);

  async function connect() {
    setBusy("connect");
    try {
      const { url } = await (await fns()).startGoogleCalendarConnect();
      window.location.assign(url);
    } catch (err) {
      toast.error(errText(err, "無法開始連結"));
      setBusy(null);
    }
  }

  async function loadCalendars() {
    setBusy("list");
    try {
      const list = await (await fns()).listGoogleCalendars();
      setCalendars(list);
      if (!picked) setPicked(list.find((c) => c.primary)?.id ?? "");
    } catch (err) {
      toast.error(errText(err, "讀不到日曆清單"));
    } finally {
      setBusy(null);
    }
  }

  async function saveTarget(calendarId: string) {
    if (!calendarId) return;
    setBusy("target");
    try {
      const r = await (await fns()).setGoogleCalendarTarget({ data: { calendarId } });
      toast.success(
        r.purged > 0
          ? `已改寫入這個日曆，並清掉舊日曆的 ${r.purged} 筆活動事件`
          : "已設定寫入的日曆，開始同步",
      );
      await router.invalidate({ sync: true });
    } catch (err) {
      toast.error(errText(err, "設定失敗"));
    } finally {
      setBusy(null);
    }
  }

  async function syncNow() {
    setBusy("sync");
    try {
      const r = await (await fns()).syncGoogleCalendarNow();
      if (r.status === "busy") toast.message("另一輪同步正在進行，稍後重新整理看結果");
      else if (r.status === "not_connected") toast.error("還沒連結或還沒選日曆");
      else if (r.status === "disabled") toast.error("尚未設定");
      else if (r.status === "done" && r.ok) toast.success("同步完成");
      else if (r.status === "done") toast.error(r.error ?? "同步有錯誤");
      await router.invalidate({ sync: true });
    } catch (err) {
      toast.error(errText(err, "同步失敗"));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    try {
      const r = await (await fns()).disconnectGoogleCalendar({ data: { removeEvents } });
      if (r.warning) toast.warning(`已中斷連結。${r.warning}`);
      else
        toast.success(
          removeEvents ? `已中斷連結，刪除 ${r.removed} 筆網站建立的事件` : "已中斷連結",
        );
      setConfirmDisconnect(false);
      await router.invalidate({ sync: true });
    } catch (err) {
      toast.error(errText(err, "中斷連結失敗"));
    } finally {
      setBusy(null);
    }
  }

  const last = status.lastSync;
  const s = last.summary;
  const accountMismatch =
    status.connected &&
    status.expectedAccount &&
    status.account &&
    status.account.toLowerCase() !== status.expectedAccount;

  return (
    <>
      <section className="space-y-3 rounded-md border border-border p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">連結狀態</span>
          {status.connected ? <Badge>已連結</Badge> : <Badge variant="outline">未連結</Badge>}
          {status.needsReconnect && <Badge variant="destructive">授權已失效，請重新連結</Badge>}
        </div>
        {status.connected ? (
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
            <dt className="text-muted-foreground">Google 帳號</dt>
            <dd>{status.account ?? "（讀不到）"}</dd>
            <dt className="text-muted-foreground">寫入的日曆</dt>
            <dd>
              {status.calendarId ? (status.calendarSummary ?? status.calendarId) : "尚未選擇"}
            </dd>
            <dt className="text-muted-foreground">連結時間</dt>
            <dd>
              {formatTaipeiDateTime(status.connectedAt)}
              {status.connectedBy ? `（${status.connectedBy}）` : ""}
            </dd>
          </dl>
        ) : (
          <p className="text-muted-foreground">
            請用書店的 Google 帳號{status.expectedAccount ? `（${status.expectedAccount}）` : ""}
            登入並按「允許」。
          </p>
        )}
        {accountMismatch && (
          <p className="text-destructive">
            連結的帳號不是 {status.expectedAccount}，若不是刻意的，請中斷連結後用正確帳號重新連結。
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={connect}
            disabled={!!busy}
            variant={status.connected ? "outline" : "default"}
          >
            {status.connected ? "重新連結" : "連結 Google 日曆"}
          </Button>
          {status.connected && (
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmDisconnect(true)}
              disabled={!!busy}
            >
              中斷連結
            </Button>
          )}
        </div>
      </section>

      {status.connected && (
        <section className="space-y-3 rounded-md border border-border p-4 text-sm">
          <p className="font-medium">要寫入哪一個日曆</p>
          <p className="text-muted-foreground">
            選「我的日曆」裡書店的那個日曆（例如 bookstores
            interval）。換日曆時，舊日曆裡網站建立的活動事件會先被清掉。
          </p>
          {status.canListCalendars ? (
            <div className="flex flex-wrap items-center gap-2">
              {calendars === null ? (
                <Button variant="outline" onClick={loadCalendars} disabled={!!busy}>
                  讀取我的日曆清單
                </Button>
              ) : (
                <>
                  <select
                    aria-label="寫入的日曆"
                    className="h-9 rounded-md border border-input bg-background px-2"
                    value={picked}
                    onChange={(e) => setPicked(e.target.value)}
                  >
                    <option value="">請選擇…</option>
                    {calendars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.summary}
                        {c.primary ? "（主要日曆）" : ""}
                      </option>
                    ))}
                  </select>
                  <Button
                    onClick={() => saveTarget(picked)}
                    disabled={!!busy || !picked || picked === status.calendarId}
                  >
                    使用這個日曆
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="日曆 ID"
                className="h-9 min-w-[18rem] rounded-md border border-input bg-background px-2"
                placeholder="primary 或 xxx@group.calendar.google.com"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
              />
              <Button
                onClick={() => saveTarget(manualId.trim())}
                disabled={!!busy || !manualId.trim()}
              >
                使用這個日曆
              </Button>
            </div>
          )}
        </section>
      )}

      {status.connected && status.calendarId && (
        <section className="space-y-3 rounded-md border border-border p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">同步</p>
            <Button onClick={syncNow} disabled={!!busy || status.running}>
              <RefreshCw
                className={`mr-1 h-4 w-4 ${busy === "sync" ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              {busy === "sync" ? "同步中…" : "立即同步"}
            </Button>
          </div>
          {status.running && <p className="text-muted-foreground">正在同步中…</p>}
          {last.finishedAt ? (
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
              <dt className="text-muted-foreground">最後同步</dt>
              <dd>
                {formatTaipeiDateTime(last.finishedAt)}
                {last.trigger ? `（${TRIGGER[last.trigger] ?? last.trigger}）` : ""}
              </dd>
              <dt className="text-muted-foreground">結果</dt>
              <dd>
                {last.ok ? <Badge>成功</Badge> : <Badge variant="destructive">有錯誤</Badge>}
                {s && (
                  <span className="ml-2">
                    共 {s.desired} 筆：新增 {s.inserted}、更新 {s.updated}、刪除 {s.removed}、未變{" "}
                    {s.unchanged}
                    {s.kept ? `、保留歷史 ${s.kept}` : ""}
                  </span>
                )}
              </dd>
              {last.error && (
                <>
                  <dt className="text-muted-foreground">錯誤</dt>
                  <dd className="break-all text-destructive">{last.error}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="text-muted-foreground">還沒有同步過。</p>
          )}
        </section>
      )}

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>中斷 Google 日曆連結？</AlertDialogTitle>
            <AlertDialogDescription>
              網站會停止更新日曆，並向 Google 撤銷授權。之後要恢復需要重新連結。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={removeEvents}
              onChange={(e) => setRemoveEvents(e.target.checked)}
            />
            同時刪除網站建立的活動事件（手動建立的行程不受影響）
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void disconnect();
              }}
              disabled={!!busy}
            >
              中斷連結
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
