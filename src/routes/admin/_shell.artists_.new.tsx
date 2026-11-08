/**
 * /admin/artists/new —— 新增講者（2026-10-26 後台第 3 批：從列表裡的新增 Dialog 改成內頁）。
 *
 * loader 叫 listArtists（與列表同一支，GET，adminFnMiddleware）只為了算預設排序（max + 1，
 * 與原本的彈窗相同）；30 秒內從列表點進來會直接沿用列表的快取。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ArtistForm } from "@/components/admin/ArtistForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";

export const Route = createFileRoute("/admin/_shell/artists_/new")({
  loader: async () => {
    const { listArtists } = await import("@/lib/admin/fns/artists");
    const artists = await listArtists();
    return { nextSortOrder: artists.reduce((max, a) => Math.max(max, a.sort_order), 0) + 1 };
  },
  head: () => ({ meta: [{ title: "新增講者｜小時光書店後台" }] }),
  component: ArtistNewPage,
});

function ArtistNewPage() {
  const { nextSortOrder } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  return (
    <ArtistForm
      artist={null}
      nextSortOrder={nextSortOrder}
      onSaved={async () => {
        await router.invalidate({ sync: true });
        if (backIfPreviousIs(router.history, ["/admin/artists"])) return;
        await navigate({ to: "/admin/artists", replace: true });
      }}
    />
  );
}
