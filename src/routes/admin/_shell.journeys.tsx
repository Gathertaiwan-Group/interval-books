/**
 * /admin/journeys —— 策旅列表。
 *
 * 2026-10-25 起編輯不再是彈窗（業主：「不要用彈窗，直接顯示內頁＆回到上一頁」）：
 * 「編輯」連到 /admin/journeys/$id（_shell.journeys_.$id.tsx，表單本體 JourneyForm）；
 * 新增一直是 /admin/journeys/new（一頁新增策旅）。刪除確認仍是 AlertDialog。
 * 這一頁沒有篩選，也沒有會打開彈窗的網址參數，所以沒有列表記憶要還原、沒有舊深連結要轉。
 * 畫面直接讀 loader 資料（沒有抄進 useState），背景重抓與寫入後 invalidate 都看得到。
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
import type { listJourneys } from "@/lib/admin/fns/journeys";
import { formatUpdatedAt } from "@/lib/admin/format";
import { rememberAdminPeek } from "@/lib/admin/list-memory";

type JourneyRow = Awaited<ReturnType<typeof listJourneys>>[number];

const REGISTRATION_TYPE_LABEL: Record<JourneyRow["registration_type"], string> = {
  external: "外部連結",
  internal: "內部報名",
};

export const Route = createFileRoute("/admin/_shell/journeys")({
  loader: async () => {
    const { listJourneys } = await import("@/lib/admin/fns/journeys");
    const journeys = await listJourneys();
    return { journeys };
  },
  head: () => ({
    meta: [{ title: "策旅｜小時光書店後台" }],
  }),
  component: AdminJourneysPage,
});

function AdminJourneysPage() {
  const { journeys } = Route.useLoaderData();
  const router = useRouter();

  const [deleteTarget, setDeleteTarget] = useState<JourneyRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { removeJourney } = await import("@/lib/admin/fns/journeys");
      await removeJourney({ data: { id: deleteTarget.id } });
      toast.success("已刪除策旅");
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
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">策旅</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {journeys.length} 檔</p>
        </div>
        {/* 新增走「一頁新增策旅」（_shell.journeys_.new.tsx）：卡片＋報名頁＋梯次＋票種一次建好。
            編輯既有卡片的文字是內頁 /admin/journeys/$id（_shell.journeys_.$id.tsx）。 */}
        <Button asChild className="gap-1.5">
          <Link preload="intent" to="/admin/journeys/new">
            <Plus className="h-4 w-4" />
            新增策旅
          </Link>
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>標題</TableHead>
              <TableHead>天數</TableHead>
              <TableHead>報名方式</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="w-36">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {journeys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增策旅」開始。
                </TableCell>
              </TableRow>
            ) : (
              journeys.map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="text-muted-foreground">{j.sort_order}</TableCell>
                  <TableCell className="max-w-sm truncate font-medium">{j.title.zh}</TableCell>
                  <TableCell className="text-muted-foreground">{j.days.zh}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {REGISTRATION_TYPE_LABEL[j.registration_type]}
                    {j.payment_enabled ? "・線上付款" : ""}
                  </TableCell>
                  <TableCell>
                    <Badge variant={j.is_published ? "default" : "secondary"}>
                      {j.is_published ? "已發布" : "草稿"}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatUpdatedAt(j.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button asChild variant="ghost" size="sm">
                        <Link
                          to="/admin/journeys/$id"
                          params={{ id: j.id }}
                          preload="intent"
                          onClick={() => rememberAdminPeek("journey", j.id, j)}
                        >
                          編輯
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(j)}
                      >
                        刪除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
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
            <AlertDialogTitle>確定要刪除這檔策旅嗎？</AlertDialogTitle>
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
