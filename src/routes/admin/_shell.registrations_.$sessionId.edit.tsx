/**
 * /admin/registrations/$sessionId/edit —— 編輯場次＋票種（2026-10-25 從「編輯場次」彈窗改成內頁）。
 *
 * 資料來自 layout 的 loader（與名單頁共用）。表單只在掛載時從 loader 填一次；票種寫完
 * router.invalidate() 重跑 loader（票種清單更新），不會蓋掉打到一半的場次欄位。
 * 有未存的變更（含票種對話框裡改到一半的方案）時離開會先問（SessionForm 的 useUnsavedChangesGuard）。
 * 存檔成功 → 回上一頁（列表或名單頁）；直接打開這個網址的 → 換成列表。
 */
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { AdminDetailNotFound } from "@/components/admin/AdminDetailPage";
import { SessionForm } from "@/components/admin/SessionForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";

const layout = getRouteApi("/admin/_shell/registrations_/$sessionId");

export const Route = createFileRoute("/admin/_shell/registrations_/$sessionId/edit")({
  component: SessionEditPage,
});

function SessionEditPage() {
  const { data } = layout.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  if (!data?.session) {
    return (
      <AdminDetailNotFound
        backTo="/admin/registrations"
        backLabel="回場次列表"
        message="找不到這個場次，可能已被刪除或網址有誤。"
      />
    );
  }
  const sessionId = data.session.id;
  const rosterPath = `/admin/registrations/${sessionId}`;

  return (
    <SessionForm
      // 換一個場次＝重新掛載，表單不會跨場次殘留。
      key={sessionId}
      session={data.session}
      products={data.products}
      plans={data.plans}
      nextSortOrder={data.nextSortOrder}
      back={{ to: "/admin/registrations", label: "回場次列表", also: [rosterPath] }}
      onPlansChanged={async () => {
        await router.invalidate();
      }}
      onSaved={async () => {
        await router.invalidate();
        // 從列表或名單頁進來 → 按上一頁回原處（列表的捲動位置原樣）；否則換成列表。
        if (backIfPreviousIs(router.history, ["/admin/registrations", rosterPath])) return;
        await navigate({ to: "/admin/registrations", replace: true });
      }}
    />
  );
}
