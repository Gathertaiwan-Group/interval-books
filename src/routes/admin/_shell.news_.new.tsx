/**
 * /admin/news/new —— 新增一則最新消息（2026-10-26 後台第 3 批：從列表裡的新增 Dialog 改成內頁）。
 *
 * loader 叫 listNews（與列表同一支，GET，adminFnMiddleware）只為了算「新的一則排最前面」的
 * 排序數字（lib/admin/sort-order.ts）；30 秒內從列表點進來會直接沿用列表的快取。
 * 存檔成功 → 回列表（從列表進來就按上一頁，否則 replace）。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { NewsForm } from "@/components/admin/NewsForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";
import { newFirstSortOrder } from "@/lib/admin/sort-order";

export const Route = createFileRoute("/admin/_shell/news_/new")({
  loader: async () => {
    const { listNews } = await import("@/lib/admin/fns/news");
    return { nextSortOrder: newFirstSortOrder(await listNews()) };
  },
  head: () => ({ meta: [{ title: "新增消息｜小時光書店後台" }] }),
  component: NewsNewPage,
});

function NewsNewPage() {
  const { nextSortOrder } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  return (
    <NewsForm
      news={null}
      nextSortOrder={nextSortOrder}
      onSaved={async () => {
        await router.invalidate({ sync: true });
        if (backIfPreviousIs(router.history, ["/admin/news"])) return;
        await navigate({ to: "/admin/news", replace: true });
      }}
    />
  );
}
