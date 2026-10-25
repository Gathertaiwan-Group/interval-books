/**
 * /admin/registrations/new —— 新增場次（2026-10-25 從「新增場次」彈窗改成內頁）。
 *
 * 活動商品清單與新場次的預設排序由 loader 給（getEventSessionPageData，sessionId: null；
 * staffFnMiddleware() ＋ event.roster.read，與原本列表的資料來源相同；存檔仍是
 * adminFnMiddleware 的 upsertEventSession）。
 * 票種要先有場次才能掛，所以新增頁沒有票種區：存好之後從列表按「編輯」再加。
 * 存檔成功 → 回列表（從列表進來就按上一頁，否則 replace 成列表：按上一頁不會回到空白表單）。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { SessionForm } from "@/components/admin/SessionForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";

export const Route = createFileRoute("/admin/_shell/registrations_/new")({
  loader: async () => {
    const { getEventSessionPageData } = await import("@/lib/admin/fns/event-sessions");
    return { data: await getEventSessionPageData({ data: { sessionId: null } }) };
  },
  head: () => ({ meta: [{ title: "新增場次｜活動報名｜小時光書店後台" }] }),
  component: SessionNewPage,
});

function SessionNewPage() {
  const { data } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  return (
    <SessionForm
      session={null}
      products={data.products}
      plans={[]}
      nextSortOrder={data.nextSortOrder}
      back={{ to: "/admin/registrations", label: "回場次列表" }}
      onPlansChanged={async () => undefined}
      onSaved={async () => {
        await router.invalidate();
        if (backIfPreviousIs(router.history, ["/admin/registrations"])) return;
        await navigate({ to: "/admin/registrations", replace: true });
      }}
    />
  );
}
