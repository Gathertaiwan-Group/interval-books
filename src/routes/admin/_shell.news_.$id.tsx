/**
 * /admin/news/$id —— 編輯一則最新消息（2026-10-26 後台第 3 批：從列表裡的編輯 Dialog 改成內頁）。
 *
 * loader 只叫一支 getNewsById（GET，adminFnMiddleware —— 與列表的 listNews、寫入的 upsertNews
 * 相同）。存檔成功 → allowLeave → invalidate → 從列表進來就按上一頁回列表，否則 replace 到列表。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { NewsForm } from "@/components/admin/NewsForm";
import { backIfPreviousIs, TEXT_ROW_ID } from "@/lib/admin/detail-nav";
import { readAdminPeek } from "@/lib/admin/list-memory";
import type { NewsRow } from "@/server/repos/news";

export const Route = createFileRoute("/admin/_shell/news_/$id")({
  loader: async ({ params }) => {
    if (!TEXT_ROW_ID.test(params.id)) return { news: null };
    const { getNewsById } = await import("@/lib/admin/fns/news");
    return { news: await getNewsById({ data: { id: params.id } }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.news
          ? `編輯消息：${loaderData.news.title.zh}｜小時光書店後台`
          : "最新消息｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: NewsPending,
  component: NewsEditPage,
});

function NewsPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<NewsRow>("news", id);
  return (
    <AdminDetailPending
      backTo="/admin/news"
      backLabel="回最新消息列表"
      title={peek ? `編輯消息：${peek.title.zh}` : undefined}
    />
  );
}

function NewsEditPage() {
  const { news } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  if (!news) {
    return (
      <AdminDetailNotFound
        backTo="/admin/news"
        backLabel="回最新消息列表"
        message="找不到這則消息，可能已被刪除或網址有誤。"
      />
    );
  }

  return (
    <NewsForm
      // 換一則＝重新掛載，表單不會跨筆殘留。
      key={news.id}
      news={news}
      onSaved={async () => {
        await router.invalidate({ sync: true });
        if (backIfPreviousIs(router.history, ["/admin/news"])) return;
        await navigate({ to: "/admin/news", replace: true });
      }}
    />
  );
}
