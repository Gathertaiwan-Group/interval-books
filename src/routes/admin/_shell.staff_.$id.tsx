/**
 * /admin/staff/$id —— 編輯一個人的後台身分（2026-10-26 後台第 3 批：從列表裡的編輯 Dialog 改成內頁）。
 *
 * loader 叫 listStaffAccounts（與列表同一支，GET，adminFnMiddleware；後台人員只有十幾列，沒有另開
 * 一支「單筆」fn 的必要），再挑出這一位。30 秒內從列表點進來直接沿用列表的快取。
 * 守門的不是這裡：寫入的 updateStaffRole／setStaffPermissions 都是 adminFnMiddleware，
 * 「不能改自己」「最後一位管理員不能降級」由資料庫擋（見 src/server/repos/staff-accounts.ts）。
 * 這一頁對自己的帳號只顯示說明、不給表單——與列表上「（這是你自己的帳號）」一致。
 */
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  ADMIN_DETAIL_PENDING,
  AdminDetailNotFound,
  AdminDetailPending,
} from "@/components/admin/AdminDetailPage";
import { StaffAccountForm } from "@/components/admin/StaffAccountForm";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";
import { readAdminPeek } from "@/lib/admin/list-memory";
import { isUuid } from "@/lib/admin/order-labels";
import type { StaffAccountRow } from "@/server/repos/staff-accounts";

export const Route = createFileRoute("/admin/_shell/staff_/$id")({
  loader: async ({ params }) => {
    if (!isUuid(params.id)) return { account: null };
    const { listStaffAccounts } = await import("@/lib/admin/fns/staff-accounts");
    const accounts = await listStaffAccounts();
    return { account: accounts.find((a) => a.id === params.id) ?? null };
  },
  head: () => ({ meta: [{ title: "編輯後台身分｜小時光書店後台" }] }),
  ...ADMIN_DETAIL_PENDING,
  pendingComponent: StaffPending,
  component: StaffEditPage,
});

function StaffPending() {
  const { id } = Route.useParams();
  const peek = readAdminPeek<StaffAccountRow>("staff", id);
  return (
    <AdminDetailPending
      backTo="/admin/staff"
      backLabel="回後台人員列表"
      title="編輯後台身分"
      meta={peek?.email ?? undefined}
    />
  );
}

function StaffEditPage() {
  const { account } = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const router = useRouter();
  const navigate = Route.useNavigate();

  if (!account) {
    return (
      <AdminDetailNotFound
        backTo="/admin/staff"
        backLabel="回後台人員列表"
        message="找不到這個後台身分，可能已被移除或網址有誤。"
      />
    );
  }
  if (account.id === user.userId) {
    return (
      <AdminDetailNotFound
        backTo="/admin/staff"
        backLabel="回後台人員列表"
        message="這是你自己的帳號——不能在這裡改自己的角色與權限，請另一位管理員幫你調整。"
      />
    );
  }

  return (
    <StaffAccountForm
      key={account.id}
      account={account}
      onSaved={async () => {
        await router.invalidate({ sync: true });
        if (backIfPreviousIs(router.history, ["/admin/staff"])) return;
        await navigate({ to: "/admin/staff", replace: true });
      }}
    />
  );
}
