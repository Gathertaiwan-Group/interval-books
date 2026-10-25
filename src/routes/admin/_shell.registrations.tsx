import { useMemo, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import type { EventSessionFormValues } from "@/lib/admin/schemas";
import { rememberAdminPeek } from "@/lib/admin/list-memory";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import type { listBookableProducts, listEventSessions } from "@/lib/admin/fns/event-sessions";

type SessionRow = Awaited<ReturnType<typeof listEventSessions>>[number];
type ProductRow = Awaited<ReturnType<typeof listBookableProducts>>[number];

const STATUS_LABEL: Record<EventSessionFormValues["status"], string> = {
  open: "開放報名",
  closed: "未開放",
};

/**
 * /admin/registrations —— 活動場次與報名名單。
 *
 * 這一頁做兩件事，而它們是同一件事的兩面：**維護場次**（名額的唯一真相，
 * migration 0020 §1）與**看名單**（誰報名了）。分成兩頁的話，「這個梯次為什麼還有
 * 位子卻報不了名」就得在兩頁之間來回比對。
 *
 * 2026-10-25 後台第 2 批（業主「不要用彈窗，直接顯示內頁＆回到上一頁」）：
 *   · 名單      → /admin/registrations/$sessionId（SessionRosterPage）
 *   · 編輯場次  → /admin/registrations/$sessionId/edit（SessionForm＋票種）
 *   · 新增場次  → /admin/registrations/new
 *   刪除場次的確認仍是這一頁的 AlertDialog。列表本身全靠 loader、沒有篩選，所以不需要
 *   useLoaderBackedList；從內頁回來靠 history.back()（捲動位置原樣）。
 *
 * ⚠️ 名單直接顯示明文電話與信箱（業主 2026-10-25），但每一條明文都留下紀錄：
 *    - 打開一個場次的名單 → listSessionRoster() **先**寫一筆 pii_access_log
 *      （subject 是場次、reason='attendee_contact'），寫成功才讀明文。一次開名單
 *      一筆，不是每位參加者一筆——名單頁一次 30 個人，逐人寫會讓那張表失去
 *      「有沒有人在亂查」這個用途（0019 §1.1）。
 *    - 🔴 所以連到名單頁的 Link 是 preload={false}，名單也不在任何 route loader 裡
 *      （預載、過期重抓、invalidate 都會重跑 loader，見 SessionRosterPage.tsx 檔頭）。
 *    - 「匯出簽到表」→ export_event_roster()，寫**一筆** reason='roster_export'。
 *    - 姓名是全名 —— 遮了現場點不了名。
 *
 * 名額不在 /admin/products 上了：0020 把 products.capacity 綁成 null，所以那個
 * 欄位已經從商品表單移除，改由這裡按場次維護。
 *
 * 移除單筆報名（0035）在名單頁，見 src/components/admin/SessionRosterTable.tsx。
 */
export const Route = createFileRoute("/admin/_shell/registrations")({
  /**
   * ⚠️ 這一頁是唯一**需要 migration 已經套用**才看得到東西的地方，而且它現在有
   *    **兩個**階段要接：0020（場次與報名兩張表）與 0021（名單的 view 與兩支
   *    明文函式）。程式碼先上線、migration 後套用，所以「0020 套了但 0021 還沒」
   *    是真的會發生的中間狀態。
   *
   * 兩個旗標分開，是為了讓那個中間狀態仍然有用：
   *
   *   schemaMissing —— 0020 還沒套。場次表不存在，整頁沒有東西可以顯示。
   *   rosterReady   —— 0021 已經套。false 的時候場次列表照常顯示（名額、狀態、
   *                    新增與編輯全部可用），只有「報名人數」與名單那幾顆按鈕
   *                    收起來。
   *
   * 如果把兩件事併成一個旗標，0020 套完當天整頁會變成一張「請先套 migration」的
   * 說明 —— 而那時候場次明明已經維護得動了。
   *
   * **只接「表／view 不存在」這一種**：其餘的錯誤照樣往上丟（連線壞了、權限不對，
   * 那些不該被說成「還沒套 migration」）。
   *
   * 前台不需要這種處理：purchase 路徑的每一支查詢都有「購物車裡真的有活動才查」
   * 的前置判斷，全是書的購物車一次都不會碰到 event_sessions。
   */
  // 上面兩個旗標的退化規則現在在伺服器上算（一支 fn、4 個查詢同時跑、身分只驗一次），
  // 規則與判斷順序照舊——見 src/lib/admin/fns/event-sessions.ts 的 getAdminRegistrationsPageData。
  //
  // 舊網址參數：這一頁原本沒有任何會打開名單／編輯彈窗的網址參數（彈窗只靠按鈕開；
  // 首頁、活動編輯頁、側欄的連結都只連到列表本身），所以沒有 beforeLoad redirect。
  loader: async () => {
    const { getAdminRegistrationsPageData } = await import("@/lib/admin/fns/event-sessions");
    return await getAdminRegistrationsPageData();
  },
  head: () => ({
    meta: [{ title: "活動報名｜小時光書店後台" }],
  }),
  component: AdminRegistrationsPage,
});

function AdminRegistrationsPage() {
  const { sessions, products, counts, schemaMissing, rosterReady } = Route.useLoaderData();
  const router = useRouter();

  const [deleteTarget, setDeleteTarget] = useState<SessionRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const productById = useMemo(
    () => new Map(products.map((p: ProductRow) => [p.id, p])),
    [products],
  );

  function productLabel(id: string): string {
    return productById.get(id)?.title.zh ?? id;
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { removeEventSession } = await import("@/lib/admin/fns/event-sessions");
      await removeEventSession({ data: { id: deleteTarget.id } });
      toast.success("已刪除場次");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      // 有人報名過的場次刪不掉（兩條 on delete restrict 外鍵）。原文往上丟，
      // 因為那句話正是店員需要知道的事。
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-medium">活動報名</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {sessions.length} 個場次。名額在這裡維護——商品頁不再有名額欄位。
          </p>
        </div>
        {products.length === 0 ? (
          <Button className="gap-1.5" disabled>
            <Plus className="h-4 w-4" />
            新增場次
          </Button>
        ) : (
          <Button asChild className="gap-1.5">
            <Link to="/admin/registrations/new" preload="intent">
              <Plus className="h-4 w-4" />
              新增場次
            </Link>
          </Button>
        )}
      </div>

      {/* 0020／0021 早已套用到正式庫，「migration 尚未套用」的兩段工程說明已拿掉。
          loader 的 schemaMissing／rosterReady 退化邏輯仍保留（表不存在時頁面不會整頁掛掉）。 */}
      {!schemaMissing && products.length === 0 && (
        <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
          目前沒有活動或策旅類型的商品。請先到「商品」新增一件 event／journey
          商品，才能為它建立場次。
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>活動商品</TableHead>
              <TableHead>場次</TableHead>
              <TableHead>時間</TableHead>
              <TableHead className="w-28">名額</TableHead>
              <TableHead className="w-32">報名</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="w-44 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  尚無場次。
                </TableCell>
              </TableRow>
            ) : (
              sessions.map((s) => {
                const count = counts[s.id] ?? { total: 0, paid: 0 };
                // ⚠️ 三個數字，不是兩個。seats_taken 是「押住了幾個位子」，
                //    count.total 是「有幾位登錄了姓名」。0020 §4.4 回填的舊場次
                //    只補一位參加者（捏造另外兩位是說謊），所以那些場次上這兩個
                //    數字本來就不一樣，而現場點名的人必須看得出來。
                const unnamed = Math.max(0, s.seats_taken - count.total);
                return (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-xs truncate">
                      {productLabel(s.product_id)}
                    </TableCell>
                    <TableCell className="max-w-xs truncate font-medium">{s.title.zh}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {/* 不可以 toLocaleString：伺服器（UTC、Node 的 ICU）與瀏覽器印出來的
                          字不一樣 → React #418。見 src/lib/taipei-time.ts。 */}
                      {formatTaipeiDateTime(s.starts_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.seats_taken} / {s.capacity}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {!rosterReady ? (
                        "—"
                      ) : (
                        <>
                          {count.paid} 已付款
                          {count.total !== count.paid ? `／${count.total} 筆` : ""}
                          {unnamed > 0 ? (
                            <span className="block text-xs text-amber-600">
                              另有 {unnamed} 位未登錄姓名
                            </span>
                          ) : null}
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={s.status === "open" ? "default" : "secondary"}>
                        {STATUS_LABEL[s.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {rosterReady ? (
                          <Button asChild variant="ghost" size="sm">
                            {/* 🔴 preload={false}：名單頁一打開就寫一筆查閱紀錄（listSessionRoster），
                                滑過不可以預先跑任何東西。 */}
                            <Link
                              to="/admin/registrations/$sessionId"
                              params={{ sessionId: s.id }}
                              preload={false}
                              onClick={() => rememberAdminPeek("event-session", s.id, s)}
                            >
                              名單
                            </Link>
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" disabled>
                            名單
                          </Button>
                        )}
                        <Button asChild variant="ghost" size="sm">
                          <Link
                            to="/admin/registrations/$sessionId/edit"
                            params={{ sessionId: s.id }}
                            preload="intent"
                            onClick={() => rememberAdminPeek("event-session", s.id, s)}
                          >
                            編輯
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(s)}
                        >
                          刪除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要刪除這個場次嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.title.zh}」刪除後無法復原。已經有人報名或下過單的場次
              會被資料庫擋下來，那時請先處理那些訂單。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "刪除中…" : "刪除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
