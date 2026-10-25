/**
 * /admin/referrals/$id —— 編輯推廣者（2026-10-26 後台第 3 批：從推廣與分潤頁的 ReferrerDialog
 * 改成內頁）。
 *
 * loader 叫 listReferrersAdmin（與列表同一支，GET，adminFnMiddleware；推廣者只有幾十位、而且要
 * 全站預設折扣當提示），再挑出這一位。30 秒內從列表點進來直接沿用列表的快取。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { ReferrerForm } from "@/components/admin/ReferrerForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";
import { readAdminPeek } from "@/lib/admin/list-memory";
import { isUuid } from "@/lib/admin/order-labels";
import type { ReferrerRow } from "@/server/repos/referrals";

export const Route = createFileRoute("/admin/_shell/referrals_/$id")({
  loader: async ({ params }) => {
    if (!isUuid(params.id)) return { referrer: null, defaultDiscount: 0 };
    const { listReferrersAdmin } = await import("@/lib/admin/fns/referrals");
    const { referrers, settings } = await listReferrersAdmin();
    return {
      referrer: referrers.find((r) => r.id === params.id) ?? null,
      defaultDiscount: settings.defaultDiscountPercent,
    };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.referrer
          ? `編輯推廣者：${loaderData.referrer.name}｜小時光書店後台`
          : "推廣與分潤｜小時光書店後台",
      },
    ],
  }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: ReferrerPending,
  component: ReferrerEditPage,
});

function ReferrerPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<ReferrerRow>("referrer", id);
  return (
    <AdminDetailPending
      backTo="/admin/referrals"
      backLabel="回推廣與分潤"
      title={peek ? `編輯推廣者：${peek.name}` : undefined}
    />
  );
}

function ReferrerEditPage() {
  const { referrer, defaultDiscount } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  if (!referrer) {
    return (
      <AdminDetailNotFound
        backTo="/admin/referrals"
        backLabel="回推廣與分潤"
        message="找不到這位推廣者，網址可能有誤。"
      />
    );
  }

  return (
    <ReferrerForm
      key={referrer.id}
      referrer={referrer}
      defaultDiscount={defaultDiscount}
      onSaved={async () => {
        await router.invalidate({ sync: true });
        if (backIfPreviousIs(router.history, ["/admin/referrals"])) return;
        await navigate({ to: "/admin/referrals", replace: true });
      }}
    />
  );
}
