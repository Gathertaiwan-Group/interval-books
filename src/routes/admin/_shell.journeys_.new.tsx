/**
 * /admin/journeys/new —— 「一頁新增策旅」。
 *
 * 檔名的 `journeys_`（底線結尾）是 TanStack Router 的「不巢狀」寫法：網址仍然是
 * /admin/journeys/new，但不掛在 _shell.journeys.tsx（列表）底下，列表頁因此不必學
 * _shell.events.tsx 那套 <Outlet /> 與 isListView 判斷。
 *
 * 表單本身與「一頁新增活動」是**同一個元件**（kind="journey"），寫入也是同一支
 * server fn —— 理由見 src/lib/admin/event-quick-create.ts 的 QuickKind。
 */
import { createFileRoute } from "@tanstack/react-router";
import { EventQuickCreate } from "@/components/admin/EventQuickCreate";

export const Route = createFileRoute("/admin/_shell/journeys_/new")({
  loader: async () => {
    const { listEventCategories } = await import("@/lib/admin/fns/event-categories");
    const { listArtistOptions } = await import("@/lib/admin/fns/artists");
    const [categories, artists] = await Promise.all([listEventCategories(), listArtistOptions()]);
    return { categories, artists };
  },
  head: () => ({
    meta: [{ title: "新增策旅｜小時光書店後台" }],
  }),
  component: AdminJourneyNewPage,
});

function AdminJourneyNewPage() {
  const { categories, artists } = Route.useLoaderData();
  return <EventQuickCreate kind="journey" categories={categories} artists={artists} />;
}
