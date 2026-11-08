import { createFileRoute, Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
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
import type { listEvents } from "@/lib/admin/fns/events";
import { formatUpdatedAt } from "@/lib/admin/format";
import {
  countByStatus,
  ListingFilterTabs,
  ListingStatusBadge,
} from "@/components/admin/ListingStatus";
import { bookingPhase, parseListingFilter, type ListingFilter } from "@/lib/listing-status";

type EventRow = Awaited<ReturnType<typeof listEvents>>[number];

/**
 * /admin/events 的**列表**，並且——與當年的「頁面文案」列表（已移除）同一個
 * 理由——也是 src/routes/admin/_shell.events.$id.tsx 的結構性父層：TanStack Router 的
 * flat-routes 會把 routeId 前綴更長的檔案掛在最近的既有路由底下，而
 * "/admin/_shell/events/$id" 對 "/admin/_shell/events" 的前綴比對比對 "/admin/_shell"
 * 更長，所以產生器把它掛在這裡，不是直接掛在 _shell 底下。這一頁因此要負責渲染
 * <Outlet />。
 *
 * 沒有下面那個 isListView 判斷的話，進 /admin/events/$id 會把這一頁的列表**疊在**
 * 組裝器上面（巢狀 match 裡兩支路由同時是 active），而不是換成組裝器。
 *
 * ── 這一頁為什麼不再有表單 ────────────────────────────────────────────────
 * 這裡原本有一個十一欄的 Dialog。活動的內容從 0027 起是「一頁由上到下組出來的東西」
 * （某一段留空前台那一塊就消失），Dialog 沒有「上下順序」這個概念，塞不下那個形狀。
 *
 * 🔴 所以表單**整個搬走了，不是複製一份**。新增與編輯都走 _shell.events.$id.tsx ——
 *    活動的固定欄位只有一個家。這一頁只剩「有哪些活動、去編哪一場、刪掉哪一場」。
 */
export const Route = createFileRoute("/admin/_shell/events")({
  // 0052：列表篩選（全部／草稿／上架／下架）放在網址上，重新整理、回上一頁都還在。
  validateSearch: (search: Record<string, unknown>): { status?: ListingFilter } => {
    const f = parseListingFilter(search.status);
    return f === "all" ? {} : { status: f };
  },
  // 一支 fn 拿齊（活動、分類、講者、「這場活動的商品」那一欄——一次撈完，不要一場一場問）。
  // 見 src/lib/admin/fns/events.ts 的 getAdminEventsPageData。
  loader: async () => {
    const { getAdminEventsPageData } = await import("@/lib/admin/fns/events");
    // now 跟著 loader 資料序列化：SSR 與 hydrate 算出同一個「報名中／額滿」（不會 #418）。
    return { ...(await getAdminEventsPageData()), now: Date.now() };
  },
  head: () => ({
    meta: [{ title: "活動｜小時光書店後台" }],
  }),
  component: AdminEventsPage,
});

const REGISTRATION_TYPE_LABEL: Record<"external" | "internal", string> = {
  external: "外部連結報名",
  internal: "站內報名",
};

function AdminEventsPage() {
  const { events, categories, artists, products, now } = Route.useLoaderData();
  const filter = parseListingFilter(Route.useSearch().status);
  const navigate = Route.useNavigate();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isListView = pathname === "/admin/events";

  const [deleteTarget, setDeleteTarget] = useState<EventRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { removeEvent } = await import("@/lib/admin/fns/events");
      await removeEvent({ data: { id: deleteTarget.id } });
      toast.success("已刪除活動");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  if (!isListView) {
    return <Outlet />;
  }

  function categoryLabel(id: string): string {
    return categories.find((c) => c.id === id)?.label.zh ?? id;
  }

  const counts = countByStatus(events);
  const shown = filter === "all" ? events : events.filter((e) => e.status === filter);

  function speakerLabel(id: string | null): string {
    if (!id) return "—";
    return artists.find((a) => a.id === id)?.name ?? id;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">活動</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {events.length} 場。每場活動只有一個狀態：<strong>草稿</strong>（前台看不到）、
            <strong>上架</strong>（看得到、可報名）、<strong>下架</strong>（看不到，報名紀錄保留）。
            點「編輯」在活動頁最上面切換；票券商品與策旅卡片會一起跟著。
          </p>
        </div>
        <Button asChild className="gap-1.5">
          <Link preload="intent" to="/admin/events/$id" params={{ id: "new" }}>
            <Plus className="h-4 w-4" />
            新增活動
          </Link>
        </Button>
      </div>

      <ListingFilterTabs
        value={filter}
        counts={counts}
        onChange={(next) =>
          void navigate({ search: next === "all" ? {} : { status: next }, replace: true })
        }
      />

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>標題</TableHead>
              <TableHead>分類</TableHead>
              <TableHead>主講人</TableHead>
              <TableHead>顯示日期</TableHead>
              <TableHead>報名方式</TableHead>
              <TableHead>票券</TableHead>
              <TableHead className="w-40">狀態</TableHead>
              <TableHead className="hidden w-36 lg:table-cell">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                  {events.length === 0
                    ? "尚無資料，點右上角「新增活動」開始。"
                    : "這個狀態下沒有活動。"}
                </TableCell>
              </TableRow>
            ) : (
              shown.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-muted-foreground">{e.sort_order}</TableCell>
                  <TableCell className="max-w-sm truncate font-medium">{e.title.zh}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{categoryLabel(e.category)}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {speakerLabel(e.speaker_id)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{e.display_date}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {REGISTRATION_TYPE_LABEL[e.registration_type]}
                    {e.payment_enabled ? "・需付款" : ""}
                  </TableCell>
                  {/* 「這場活動的票券」：價格與場次數。上下架**不在這裡**——0052 起票券
                      商品跟著活動的狀態走（右邊那一欄）。「尚無場次」是站內報名最常見的
                      半成品：上架了、按鈕會出現、但點進去一場都選不到。 */}
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {products[e.id] ? (
                      <span className="flex items-center gap-1.5">
                        <span className="text-xs">
                          NT${products[e.id].price.toLocaleString("en-US")}
                          {" ・ "}
                          {products[e.id].session_count > 0
                            ? `${products[e.id].session_count} 個場次`
                            : "尚無場次"}
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs">
                        {e.registration_type === "external" ? "外部報名，無票券" : "未開啟販售"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <ListingStatusBadge
                      status={e.status}
                      phase={bookingPhase(
                        {
                          registrationType: e.registration_type,
                          isoDate: e.iso_date,
                          sessions: products[e.id]?.sessions ?? [],
                        },
                        now,
                      )}
                    />
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                    {formatUpdatedAt(e.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" asChild>
                        <Link preload="intent" to="/admin/events/$id" params={{ id: e.id }}>
                          編輯
                        </Link>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(e)}
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
            <AlertDialogTitle>確定要刪除這場活動嗎？</AlertDialogTitle>
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
