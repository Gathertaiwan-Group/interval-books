/**
 * 一個場次的報名名單 —— /admin/registrations/$sessionId 的本體（2026-10-25 後台第 2 批：
 * 原本是 _shell.registrations.tsx 裡 max-w-4xl 的「報名名單」彈窗）。
 *
 * 標題（場次名、時間、商品、地點）來自 layout 的 loader（getEventSessionPageData，不含個資），
 * 名單來自 index route 的 loader（listSessionRoster）。業主 2026-10-26 撤掉「每打開一次就記
 * 一筆查看紀錄」之後，名單是一般只讀資料：30 秒快取、列表滑過就預載，不再寫 pii_access_log。
 *
 * 移除單筆報名（0035）之後 router.invalidate()：loader 重抓名單與列表的報名數／名額。
 * 移除確認仍是 AlertDialog（SessionRosterTable.tsx）。
 *
 * 名單直接顯示明文電話與信箱（業主 2026-10-25）。姓名是全名 —— 遮了現場點不了名。
 */
import { useState } from "react";
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
  /** index route loader 讀回來的名單；null＝讀取失敗（見 rosterError）。 */
  roster: RosterRow[] | null;
  rosterError: string | null;
  /** ⚠️ 只控制畫面。擋住直接呼叫的是 server fn 的 requireRosterRead()。 */
  canReadRoster: boolean;
};

export function SessionRosterPage({ session, product, roster, rosterError, canReadRoster }: Props) {
  const router = useRouter();
  const [exporting, setExporting] = useState(false);

  /**
   * 匯出簽到表。
   *
   * ⚠️ **CSV 是 server fn 回來的字串，不是一條 HTTP 路由。** 快樂手的 CSV 是
   *    route handler，踩過「權限不足時 redirect 到登入頁，瀏覽器照樣把登入頁的
   *    HTML 存成 roster.csv」。這裡的回傳型別是 { filename, csv }，沒有任何路徑
   *    可以讓它變成一份 HTML；授權失敗就是下面這個 catch，使用者看到 toast。
   *
   * 不寫查閱紀錄（業主 2026-10-26）。
   */
  async function handleExport() {
    setExporting(true);
    try {
      const { exportSessionRoster } = await import("@/lib/admin/fns/event-registrations");
      const { filename, csv, count } = await exportSessionRoster({
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
      toast.success(`已匯出 ${count} 位`);
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
        disabled={exporting || !roster || !canReadRoster || paidCount === 0}
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
      {/* ⚠️ 匯出只含已付款（on_roster）。未付款的人不會來，印進簽到表會讓現場
          多準備座位與講義。那個條件寫在 0021 §3 的 view 裡，畫面、CSV 與
          Phase 3 的提醒信共用同一份。 */}
      <div className="rounded-md border border-border p-3 text-sm text-muted-foreground">
        {rosterError ? (
          <span className="text-destructive">名單讀取失敗：{rosterError}</span>
        ) : (
          <>
            共 {roster?.length ?? 0} 筆，其中 <strong>{paidCount}</strong>{" "}
            位已付款（＝會出現在簽到表上）；其餘是被未付款的訂單押著的位子。
          </>
        )}
      </div>

      {roster ? (
        <SessionRosterTable
          rows={roster}
          // 移除成功後重跑 loader：名單與列表的報名數／名額一起更新。
          onRemoved={async () => {
            await router.invalidate();
          }}
        />
      ) : null}
    </AdminDetailPage>
  );
}
