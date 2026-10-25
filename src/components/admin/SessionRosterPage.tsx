/**
 * 一個場次的報名名單 —— /admin/registrations/$sessionId 的本體（2026-10-25 後台第 2 批：
 * 原本是 _shell.registrations.tsx 裡 max-w-4xl 的「報名名單」彈窗）。
 *
 * 標題（場次名、時間、商品、地點）來自 route loader（getEventSessionPageData，不含個資），
 * 一進來就畫得出來；名單本身在頁內載入。
 *
 * 🔴 名單**不可以**搬進 route loader，也不可以被滑過預載：
 *    listSessionRoster() 每呼叫一次就**先**寫一筆 pii_access_log（subject 是場次、
 *    reason='attendee_contact'），寫成功才讀明文（0021、commit 4652fbf）。loader 會在
 *    預載、30 秒過期重抓、每次 router.invalidate() 時重跑——放進 loader 就變成「沒看卻留
 *    紀錄」或「看一次留好幾筆」。所以：
 *      · 只在這個元件**掛載時呼叫一次**（跟原本打開彈窗時一樣）；呼叫端用 key={sessionId}，
 *        換一個場次＝重新掛載＝新的一筆紀錄。
 *      · startedRef 擋住同一次掛載跑第二次（開發模式 StrictMode 會把 effect 跑兩遍）。
 *      · 連到這一頁的 Link 一律 preload={false}。
 *
 * 移除單筆報名（0035）、匯出簽到表、權限判斷的行為與彈窗時一模一樣：移除成功後從本地名單
 * 過濾掉那一列（不重打 listSessionRoster、不多寫一筆紀錄），再 router.invalidate() 讓
 * 列表的報名數／名額更新。移除確認仍是 AlertDialog（SessionRosterTable.tsx）。
 *
 * ⚠️ 名單直接顯示明文電話與信箱（業主 2026-10-25），但每一條明文都留下紀錄。
 *    姓名是全名 —— 遮了現場點不了名。
 */
import { useEffect, useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Download, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AdminDetailPage } from "@/components/admin/AdminDetailPage";
import { SessionRosterTable, type RosterRow } from "@/components/admin/SessionRosterTable";
import type { ProductRow, SessionRow } from "@/components/admin/SessionForm";
import { formatTaipeiDateTime } from "@/lib/taipei-time";

type Props = {
  session: SessionRow;
  product: ProductRow | undefined;
  /** ⚠️ 只控制畫面。擋住直接呼叫的是 server fn 的 requireRosterRead()。 */
  canReadRoster: boolean;
};

export function SessionRosterPage({ session, product, canReadRoster }: Props) {
  const router = useRouter();
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterError, setRosterError] = useState<string | null>(null);
  /** 這一次打開名單寫下的 pii_access_log 編號——印在畫面上，講明白會被記錄。 */
  const [rosterLogId, setRosterLogId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        const { listSessionRoster } = await import("@/lib/admin/fns/event-registrations");
        const { rows, log_id } = await listSessionRoster({ data: { sessionId: session.id } });
        setRoster(rows);
        setRosterLogId(log_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "名單讀取失敗";
        toast.error(message);
        setRosterError(message);
      } finally {
        setRosterLoading(false);
      }
    })();
    // 刻意只跑一次（見檔頭）：sessionId 換了由呼叫端的 key 重新掛載。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 匯出簽到表。
   *
   * ⚠️ **CSV 是 server fn 回來的字串，不是一條 HTTP 路由。** 快樂手的 CSV 是
   *    route handler，踩過「權限不足時 redirect 到登入頁，瀏覽器照樣把登入頁的
   *    HTML 存成 roster.csv」。這裡的回傳型別是 { filename, csv }，沒有任何路徑
   *    可以讓它變成一份 HTML；授權失敗就是下面這個 catch，使用者看到 toast。
   *
   * ⚠️ 呼叫成功就一定留下一筆 pii_access_log（subject 是場次）。toast 把紀錄編號
   *    印出來：講明白會被記錄，比偷偷記錄有用。
   */
  async function handleExport() {
    setExporting(true);
    try {
      const { exportSessionRoster } = await import("@/lib/admin/fns/event-registrations");
      const { filename, csv, count, log_id } = await exportSessionRoster({
        data: { sessionId: session.id },
      });
      // BOM 已經在 csv 字串開頭（src/lib/csv.ts），這裡不要再加一次。
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      // ⚠️ 掛進 DOM 再點，而且 revoke 排到下一個 tick：直接 revoke 會在部分瀏覽器
      //    上讓下載在真正開始之前就失去來源，結果是一個 0 byte 的檔案。
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success(`已匯出 ${count} 位・紀錄編號 ${log_id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "名單匯出失敗");
    } finally {
      setExporting(false);
    }
  }

  const paidCount = (roster ?? []).filter((r) => r.on_roster).length;

  const actions = (
    <>
      <Button asChild variant="outline" size="sm" className="gap-1.5">
        <Link
          to="/admin/registrations/$sessionId/edit"
          params={{ sessionId: session.id }}
          preload="intent"
        >
          <Pencil className="h-4 w-4" />
          編輯場次
        </Link>
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        // ⚠️ disabled 只是畫面。擋住直接呼叫的是 server fn 的 requireRosterRead()。
        disabled={exporting || rosterLoading || !canReadRoster || paidCount === 0}
        title={canReadRoster ? undefined : "需要「查看活動報名名單」權限"}
        onClick={() => void handleExport()}
      >
        <Download className="h-4 w-4" />
        {exporting ? "匯出中…" : "匯出簽到表（CSV）"}
      </Button>
    </>
  );

  return (
    <AdminDetailPage
      backTo="/admin/registrations"
      backLabel="回場次列表"
      width="xl"
      title={`${session.title.zh} 報名名單`}
      titleExtra={
        <Badge variant={session.status === "open" ? "default" : "secondary"}>
          {session.status === "open" ? "開放報名" : "未開放"}
        </Badge>
      }
      meta={
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {/* 不可以 toLocaleString（React #418）。見 src/lib/taipei-time.ts。 */}
          <span>{formatTaipeiDateTime(session.starts_at)}</span>
          {product ? <span className="break-words">{product.title.zh}</span> : null}
          {session.location.zh ? <span className="break-words">{session.location.zh}</span> : null}
          <span>
            名額 {session.seats_taken} / {session.capacity}
          </span>
        </span>
      }
      actions={actions}
    >
      <p className="text-sm text-muted-foreground">
        打開名單與匯出簽到表都會留下一筆刪不掉的存取紀錄（誰、什麼時候、哪一場）。
        {rosterLogId ? `這次查閱的紀錄編號：${rosterLogId}` : null}
      </p>

      {/* ⚠️ 匯出只含已付款（on_roster）。未付款的人不會來，印進簽到表會讓現場
          多準備座位與講義。那個條件寫在 0021 §3 的 view 裡，畫面、CSV 與
          Phase 3 的提醒信共用同一份。 */}
      <div className="rounded-md border border-border p-3 text-sm text-muted-foreground">
        {rosterLoading ? (
          "讀取中…"
        ) : rosterError ? (
          <span className="text-destructive">名單讀取失敗：{rosterError}</span>
        ) : (
          <>
            共 {roster?.length ?? 0} 筆，其中 <strong>{paidCount}</strong>{" "}
            位已付款（＝會出現在簽到表上）；其餘是被未付款的訂單押著的位子。
          </>
        )}
      </div>

      {rosterLoading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">讀取中…</p>
      ) : rosterError ? null : (
        <SessionRosterTable
          rows={roster ?? []}
          onRemoved={async (registrationId) => {
            setRoster((prev) =>
              prev ? prev.filter((r) => r.registration_id !== registrationId) : prev,
            );
            await router.invalidate();
          }}
        />
      )}
    </AdminDetailPage>
  );
}
