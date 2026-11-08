/**
 * /admin/collaborations —— 合作夥伴列表。
 *
 * 2026-10-26 起新增／編輯不再是彈窗（後台第 3 批；業主：「不要用彈窗，直接顯示內頁＆回到上一頁」）：
 * 「新增合作」連到 /admin/collaborations/new、「編輯」連到 /admin/collaborations/$id（表單本體
 * CollaborationForm）。刪除確認仍是 AlertDialog。這一頁沒有篩選，畫面直接讀 loader 資料。
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
import type { listCollaborations } from "@/lib/admin/fns/collaborations";
import { formatUpdatedAt } from "@/lib/admin/format";
import { rememberAdminPeek } from "@/lib/admin/list-memory";

type CollaborationRow = Awaited<ReturnType<typeof listCollaborations>>[number];

export const Route = createFileRoute("/admin/_shell/collaborations")({
  loader: async () => {
    const { listCollaborations } = await import("@/lib/admin/fns/collaborations");
    const collaborations = await listCollaborations();
    return { collaborations };
  },
  head: () => ({
    meta: [{ title: "合作｜小時光書店後台" }],
  }),
  component: AdminCollaborationsPage,
});

function AdminCollaborationsPage() {
  const { collaborations } = Route.useLoaderData();
  const router = useRouter();

  const [deleteTarget, setDeleteTarget] = useState<CollaborationRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { removeCollaboration } = await import("@/lib/admin/fns/collaborations");
      await removeCollaboration({ data: { id: deleteTarget.id } });
      toast.success("已刪除合作夥伴");
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
          <h1 className="text-2xl font-medium">合作</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {collaborations.length} 個合作夥伴
          </p>
        </div>
        <Button asChild className="gap-1.5">
          <Link preload="intent" to="/admin/collaborations/new">
            <Plus className="h-4 w-4" />
            新增合作
          </Link>
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>名稱</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="w-36">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collaborations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增合作」開始。
                </TableCell>
              </TableRow>
            ) : (
              collaborations.map((c) => {
                const busy = deleting && deleteTarget?.id === c.id;
                return (
                  <TableRow key={c.id}>
                    <TableCell className="text-muted-foreground">{c.sort_order}</TableCell>
                    <TableCell className="max-w-sm truncate font-medium">{c.title.zh}</TableCell>
                    <TableCell>
                      <Badge variant={c.is_published ? "default" : "secondary"}>
                        {c.is_published ? "已發布" : "草稿"}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatUpdatedAt(c.updated_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button asChild variant="ghost" size="sm">
                          <Link
                            to="/admin/collaborations/$id"
                            params={{ id: c.id }}
                            preload="intent"
                            disabled={busy}
                            onClick={() => rememberAdminPeek("collaboration", c.id, c)}
                          >
                            編輯
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={busy}
                          onClick={() => setDeleteTarget(c)}
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
            <AlertDialogTitle>確定要刪除這個合作夥伴嗎？</AlertDialogTitle>
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
