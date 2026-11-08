/**
 * /admin/news —— 最新消息列表。
 *
 * 2026-10-26 起新增／編輯不再是彈窗（後台第 3 批；業主：「不要用彈窗，直接顯示內頁＆回到上一頁」）：
 * 「新增消息」連到 /admin/news/new、「編輯」連到 /admin/news/$id（表單本體 NewsForm）。
 * 刪除確認仍是 AlertDialog。這一頁沒有篩選，畫面直接讀 loader 資料（沒有抄進 useState），
 * 背景重抓與寫入後 invalidate 都看得到。
 */
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
import type { listNews } from "@/lib/admin/fns/news";
import { formatUpdatedAt } from "@/lib/admin/format";
import { rememberAdminPeek } from "@/lib/admin/list-memory";
import { isNewsExpired } from "@/lib/news-expiry";
import { taipeiToday } from "@/lib/taipei-time";

type NewsRow = Awaited<ReturnType<typeof listNews>>[number];

export const Route = createFileRoute("/admin/_shell/news")({
  loader: async () => {
    const { listNews } = await import("@/lib/admin/fns/news");
    const news = await listNews();
    return { news };
  },
  head: () => ({
    meta: [{ title: "最新消息｜小時光書店後台" }],
  }),
  component: AdminNewsPage,
});

function AdminNewsPage() {
  const { news } = Route.useLoaderData();
  const router = useRouter();
  // 後台照樣列出全部；過期的（前台已自動隱藏）只多一個標記。規則見 src/lib/news-expiry.ts。
  const today = taipeiToday();

  const [deleteTarget, setDeleteTarget] = useState<NewsRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { removeNews } = await import("@/lib/admin/fns/news");
      await removeNews({ data: { id: deleteTarget.id } });
      toast.success("已刪除消息");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">最新消息</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {news.length} 則</p>
        </div>
        <Button asChild className="gap-1.5">
          <Link preload="intent" to="/admin/news/new">
            <Plus className="h-4 w-4" />
            新增消息
          </Link>
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>標題</TableHead>
              <TableHead>顯示日期</TableHead>
              <TableHead className="w-40">狀態</TableHead>
              <TableHead className="w-36">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {news.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增消息」開始。
                </TableCell>
              </TableRow>
            ) : (
              news.map((n) => {
                const busy = deleting && deleteTarget?.id === n.id;
                return (
                  <TableRow key={n.id}>
                    <TableCell className="text-muted-foreground">{n.sort_order}</TableCell>
                    <TableCell className="max-w-sm truncate font-medium">{n.title.zh}</TableCell>
                    <TableCell className="text-muted-foreground">{n.display_date}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={n.is_published ? "default" : "secondary"}>
                          {n.is_published ? "已發布" : "草稿"}
                        </Badge>
                        {isNewsExpired(n.display_date, today) && (
                          <Badge
                            variant="outline"
                            className="whitespace-nowrap text-muted-foreground"
                            title="顯示日期的結束日已過，前台自動隱藏"
                          >
                            已過期・前台不顯示
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatUpdatedAt(n.updated_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button asChild variant="ghost" size="sm">
                          <Link
                            to="/admin/news/$id"
                            params={{ id: n.id }}
                            preload="intent"
                            disabled={busy}
                            onClick={() => rememberAdminPeek("news", n.id, n)}
                          >
                            編輯
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={busy}
                          onClick={() => setDeleteTarget(n)}
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
            <AlertDialogTitle>確定要刪除這則消息嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.title.zh}」刪除後無法復原。
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
