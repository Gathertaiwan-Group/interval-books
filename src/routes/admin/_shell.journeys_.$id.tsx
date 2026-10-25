/**
 * /admin/journeys/$id —— 編輯策旅卡片（2026-10-25 從列表裡的編輯 Dialog 改成內頁）。
 *
 * 只有編輯一頁（策旅卡片沒有另外的唯讀詳情），所以是單一 route，不是 layout + index + edit。
 * loader 只叫一支 getJourneyById（GET，adminFnMiddleware —— 與列表的 listJourneys、寫入的
 * upsertJourney 相同）。
 *
 * ⚠️ journeys.id 是 **text** 主鍵（0001_init.sql），不是 uuid：後台建的是 randomUUID，但資料庫
 *    不保證。所以這裡不用 isUuid（那會把合法的舊 id 判成找不到），只擋形狀明顯不對的字串，
 *    其餘交給 getJourneyById 的 zod 與查詢（查不到 → null → 找不到）。
 *
 * 存檔成功 → allowLeave → invalidate → 從列表進來就按上一頁回列表，否則 replace 到列表。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { JourneyForm } from "@/components/admin/JourneyForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";
import { readAdminPeek } from "@/lib/admin/list-memory";
import type { JourneyRow } from "@/server/repos/journeys";

/** text 主鍵的形狀檢查：英數、底線、連字號、句點，1–128 字。 */
const JOURNEY_ID = /^[A-Za-z0-9._-]{1,128}$/;

export const Route = createFileRoute("/admin/_shell/journeys_/$id")({
  loader: async ({ params }) => {
    if (!JOURNEY_ID.test(params.id)) return { journey: null };
    const { getJourneyById } = await import("@/lib/admin/fns/journeys");
    return { journey: await getJourneyById({ data: { id: params.id } }) };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.journey
          ? `編輯策旅：${loaderData.journey.title.zh}｜小時光書店後台`
          : "策旅｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: JourneyPending,
  component: JourneyEditPage,
});

function JourneyPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<JourneyRow>("journey", id);
  return (
    <AdminDetailPending
      backTo="/admin/journeys"
      backLabel="回策旅列表"
      title={peek ? `編輯策旅：${peek.title.zh}` : undefined}
    />
  );
}

function JourneyEditPage() {
  const { journey } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  if (!journey) {
    return (
      <AdminDetailNotFound
        backTo="/admin/journeys"
        backLabel="回策旅列表"
        message="找不到這檔策旅，可能已被刪除或網址有誤。"
      />
    );
  }

  return (
    <JourneyForm
      // 換一檔策旅＝重新掛載，表單不會跨筆殘留。
      key={journey.id}
      journey={journey}
      onSaved={async () => {
        await router.invalidate();
        if (backIfPreviousIs(router.history, ["/admin/journeys"])) return;
        await navigate({ to: "/admin/journeys", replace: true });
      }}
    />
  );
}
