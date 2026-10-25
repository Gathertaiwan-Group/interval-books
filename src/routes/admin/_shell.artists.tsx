import { useState } from "react";
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
import type { listArtists } from "@/lib/admin/fns/artists";
import { formatUpdatedAt } from "@/lib/admin/format";
import { rememberAdminPeek } from "@/lib/admin/list-memory";

type ArtistRow = Awaited<ReturnType<typeof listArtists>>[number];

/**
 * 講者後台（public.artists）。
 *
 * 2026-10-26 起新增／編輯不再是彈窗（後台第 3 批；業主：「不要用彈窗，直接顯示內頁＆回到上一頁」）：
 * 「新增講者」連到 /admin/artists/new、「編輯」連到 /admin/artists/$id（表單本體 ArtistForm，
 * 下面兩段的規矩都搬過去了）。刪除確認仍是 AlertDialog（它要看這位講者掛在幾場活動上）。
 * 這一頁沒有篩選，畫面直接讀 loader 資料，背景重抓與寫入後 invalidate 都看得到。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 語言：這一頁**沒有** <LocalizedField>，而那是故意的
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * public.artists 的 bio / long_bio / discipline 在資料庫裡是 `text`，不是三語
 * jsonb（0019_vendors_pii_portal.sql:2146-2160）。整張表唯一的第二語言是 name 與
 * name_en，而那是兩個各自獨立的欄位，不是一個 {zh,en,ja} 物件。
 *
 * 所以這一頁用的是普通的 <Input> / <Textarea>，而且每一個單語欄位底下都寫著
 * 「此欄不分語言，三種語系都會顯示同一份內容」。那句話不是客套，是這一頁唯一
 * 會被人讀到的地方：型別擋得住程式碼寫錯，擋不住店家以為自己填的是中文版。
 *
 * ⚠️ 不要「為了跟其他頁一致」就把 bio 換成 <LocalizedField>。那個元件讀寫的是
 *    `bio.zh` 這種路徑，套在字串欄位上會把資料寫成 {zh: …} 存進一個 text 欄位。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ vendor_id：看得到，改不動
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 表格裡有一欄「廠商」，但它只顯示「已綁定／未綁定」，而且表單裡**沒有**這個
 * 欄位。artists.vendor_id 指到 inv.vendors —— 那張表有身分證字號與匯款帳號。
 * 「這位講者的介紹長怎樣」與「這家廠商的錢匯到哪」是兩個不同的授權決定。
 *
 * 這件事不是靠這一頁少放一個輸入框來保證的（那只是畫面）：artistSchema 沒有
 * vendor_id 這個 key，repo 的 upsert payload 也沒有。見
 * src/server/repos/artists.ts 的檔頭。
 */
export const Route = createFileRoute("/admin/_shell/artists")({
  loader: async () => {
    const { listArtists, countEventsBySpeaker } = await import("@/lib/admin/fns/artists");
    const [artists, eventCounts] = await Promise.all([listArtists(), countEventsBySpeaker()]);
    return { artists, eventCounts };
  },
  head: () => ({
    meta: [{ title: "講者｜小時光書店後台" }],
  }),
  component: AdminArtistsPage,
});

function AdminArtistsPage() {
  const { artists, eventCounts } = Route.useLoaderData();
  const router = useRouter();

  const [deleteTarget, setDeleteTarget] = useState<ArtistRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { removeArtist } = await import("@/lib/admin/fns/artists");
      await removeArtist({ data: { id: deleteTarget.id } });
      toast.success("已刪除講者");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  const deleteTargetEventCount = deleteTarget ? (eventCounts[deleteTarget.id] ?? 0) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">講者</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {artists.length} 位</p>
        </div>
        <Button asChild className="gap-1.5">
          <Link preload="intent" to="/admin/artists/new">
            <Plus className="h-4 w-4" />
            新增講者
          </Link>
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>姓名</TableHead>
              <TableHead>領域</TableHead>
              <TableHead className="w-24">活動</TableHead>
              <TableHead className="w-28">廠商</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="hidden w-36 lg:table-cell">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {artists.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增講者」開始。
                </TableCell>
              </TableRow>
            ) : (
              artists.map((a) => {
                const busy = deleting && deleteTarget?.id === a.id;
                return (
                  <TableRow key={a.id}>
                    <TableCell className="text-muted-foreground">{a.sort_order}</TableCell>
                    <TableCell className="max-w-sm font-medium">
                      <span className="block truncate">{a.name}</span>
                      {a.name_en ? (
                        <span className="block truncate text-xs font-normal text-muted-foreground">
                          {a.name_en}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.discipline ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {eventCounts[a.id] ? `${eventCounts[a.id]} 場` : "—"}
                    </TableCell>
                    <TableCell>
                      {/* 唯讀。這裡刻意只說「有沒有綁」，不顯示是哪一家、更不能改 ——
                        inv.vendors 是會計面，見本檔檔頭。 */}
                      <Badge variant={a.vendor_id ? "outline" : "secondary"}>
                        {a.vendor_id ? "已綁定" : "未綁定"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={a.is_active ? "default" : "secondary"}>
                        {a.is_active ? "啟用中" : "已停用"}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                      {formatUpdatedAt(a.updated_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button asChild variant="ghost" size="sm">
                          <Link
                            to="/admin/artists/$id"
                            params={{ id: a.id }}
                            preload="intent"
                            disabled={busy}
                            onClick={() => rememberAdminPeek("artist", a.id, a)}
                          >
                            編輯
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={busy}
                          onClick={() => setDeleteTarget(a)}
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
            <AlertDialogTitle>確定要刪除這位講者嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.name}」刪除後無法復原。
              {deleteTargetEventCount > 0 ? (
                <>
                  {" "}
                  這位講者目前掛在 {deleteTargetEventCount} 場活動上——
                  <strong>那些活動不會被刪除</strong>
                  ，只會變成沒有指定講者，之後可以再掛上別人。
                </>
              ) : (
                " 目前沒有任何活動掛著這位講者。"
              )}
              {deleteTarget?.vendor_id ? (
                <>
                  {" "}
                  另外，這位講者有綁定的廠商資料；刪除只會影響這裡的介紹資料，進銷存那一側的廠商不受影響。
                </>
              ) : null}
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
