/**
 * /admin/referrals/new —— 新增推廣者（2026-10-26 後台第 3 批：從 ReferrerDialog 改成內頁）。
 *
 * loader 叫 listReferrersAdmin（與列表同一支，GET，adminFnMiddleware）只為了拿全站預設折扣當提示。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ReferrerForm } from "@/components/admin/ReferrerForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";

export const Route = createFileRoute("/admin/_shell/referrals_/new")({
  loader: async () => {
    const { listReferrersAdmin } = await import("@/lib/admin/fns/referrals");
    const { settings } = await listReferrersAdmin();
    return { defaultDiscount: settings.defaultDiscountPercent };
  },
  head: () => ({ meta: [{ title: "新增推廣者｜小時光書店後台" }] }),
  component: ReferrerNewPage,
});

function ReferrerNewPage() {
  const { defaultDiscount } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();

  return (
    <ReferrerForm
      referrer={null}
      defaultDiscount={defaultDiscount}
      onSaved={async () => {
        await router.invalidate({ sync: true });
        if (backIfPreviousIs(router.history, ["/admin/referrals"])) return;
        await navigate({ to: "/admin/referrals", replace: true });
      }}
    />
  );
}
