/**
 * /admin/artists/$id —— 編輯講者（2026-10-26 後台第 3 批：從列表裡的編輯 Dialog 改成內頁）。
 *
 * loader 只叫一支 getArtistById（GET，adminFnMiddleware —— 與列表的 listArtists、寫入的
 * upsertArtist 相同）。存檔成功 → allowLeave → invalidate → 從列表進來就按上一頁回列表，
 * 否則 replace 到列表。刪除（要看這位講者掛在幾場活動上）留在列表的 AlertDialog。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { ArtistForm } from "@/components/admin/ArtistForm";
import { backIfPreviousIs, TEXT_ROW_ID } from "@/lib/admin/detail-nav";
import { readAdminPeek } from "@/lib/admin/list-memory";
import type { ArtistRow } from "@/server/repos/artists";

export const Route = createFileRoute("/admin/_shell/artists_/$id")({
  loader: async ({ params }) => {
    if (!TEXT_ROW_ID.test(params.id)) return { artist: null };
    const { getArtistById } = await import("@/lib/admin/fns/artists");
    return { artist: await getArtistById({ data: { id: params.id } }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.artist
          ? `編輯講者：${loaderData.artist.name}｜小時光書店後台`
          : "講者｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: ArtistPending,
  component: ArtistEditPage,
});

function ArtistPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<ArtistRow>("artist", id);
  return (
    <AdminDetailPending
      backTo="/admin/artists"
      backLabel="回講者列表"
      title={peek ? `編輯講者：${peek.name}` : undefined}
    />
  );
}

function ArtistEditPage() {
  const { artist } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  if (!artist) {
    return (
      <AdminDetailNotFound
        backTo="/admin/artists"
        backLabel="回講者列表"
        message="找不到這位講者，可能已被刪除或網址有誤。"
      />
    );
  }

  return (
    <ArtistForm
      key={artist.id}
      artist={artist}
      onSaved={async () => {
        await router.invalidate({ sync: true });
        if (backIfPreviousIs(router.history, ["/admin/artists"])) return;
        await navigate({ to: "/admin/artists", replace: true });
      }}
    />
  );
}
