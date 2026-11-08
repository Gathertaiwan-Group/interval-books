/**
 * /admin/inventory-vendors —— 廠商
 *
 * 廠商是這個系統裡唯一同時牽到「錢」與「個資」的主檔：一家廠商後面掛著商品、進貨、
 * 退貨、寄售抽成，還有身分證字號、統一編號與匯款帳號。所以這一頁的版面是照
 * **兩個問題**排的，不是照欄位排的：
 *
 *   1. 這家還能不能動？（商品數／進貨數／入口帳號數 → 決定刪不刪得掉）
 *   2. 完整號碼在哪裡看？（只有一扇門，而且會留下紀錄）
 *
 * ── 三件在這一頁最容易寫錯的事 ────────────────────────────────────────────
 *
 * ⚠️ **畫面上的識別碼永遠是遮罩，而且那不是 CSS 蓋住的。** inv_admin_vendor_list /
 *    inv_admin_vendor_detail 只 select 出 `*_masked`，完整值從來沒有離開資料庫。
 *    要看完整號碼只有 VendorSensitiveDialog → readVendorSensitive() 這一條路，而
 *    它一定寫一筆 pii_access_log（0019 §4：資料庫在同一個交易裡先寫紀錄再組值）。
 *    所以這一頁**不要**再開第二個顯示原值的地方 —— 稽核軌跡只要有一條旁路就等於沒有。
 *
 * ⚠️ **`canApprove` / `canApproveProducts` / `canReadPii` 只控制畫面。** 三個都只是
 *    把按鈕變灰。真正擋住直接 POST /_serverFn/… 的是 fns/inv-vendors.ts 裡的
 *    requirePermission()：approveVendor 要 approve_vendors、approveVendorSubmission
 *    要 approve_products、readVendorSensitive 要 inv.vendor.pii.read，而三個都是從
 *    staff_permissions **重讀**出來的，不信任前端送來的任何東西。這裡把按鈕做成
 *    disabled 而不是整個藏起來，是為了讓沒有權限的人看得到「有這個動作，但我不能
 *    做」，而不是以為系統壞了。
 *
 * ⚠️ **解約不是刪除。** inv_delete_vendor() 在還有往來資料的時候會擋下來，因為帳與
 *    貨的歷史不能因為刪一筆主檔就變成孤兒。不再往來的正確做法是把「往來狀態」改成
 *    「已終止」。這一頁把三個數字直接印在列上，就是為了讓人在按下刪除之前就知道。
 *
 * ── 內頁（2026-10-25 起）──────────────────────────────────────────────────
 * 詳情／編輯／新增不再是彈窗：/admin/inventory-vendors/$id、/$id/edit、/new
 * （_shell.inventory-vendors_.*.tsx）。這一頁的篩選與送審佇列狀態記在 list-memory，
 * 從內頁「← 回到列表」回來原樣還原；畫面上的清單取 loader 與自己抓的兩份裡比較新的
 * （useLoaderBackedList），背景重抓會反映在畫面上。
 *
 * ⚠️ 廠商**沒有**「重新送審」：inv_save_vendor() 的 UPDATE 分支刻意不碰
 *    approval_status，inv_approve_record() 也只吃 pending。被退回的廠商是終點。
 */
import { useCallback, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Building2, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VendorDialogs } from "@/components/inventory/VendorDialogs";
import { VendorFilterBar } from "@/components/inventory/VendorFilterBar";
import { VendorSensitiveDialog } from "@/components/inventory/VendorSensitiveDialog";
import { VendorSubmissionQueue } from "@/components/inventory/VendorSubmissionQueue";
import { VendorTable } from "@/components/inventory/VendorTable";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";
import { useLoaderBackedList } from "@/lib/admin/useLoaderBackedList";
import { useVendorActions } from "@/lib/admin/useVendorActions";
import type { VendorFilterValues } from "@/lib/admin/schemas";
import type { AdminVendorRow } from "@/server/repos/inv-vendors";

const DEFAULT_VENDOR_FILTER: VendorFilterValues = {
  keyword: null,
  entityType: "all",
  consignment: "all",
  status: "all",
  approvalStatus: "all",
  sort: "name_asc",
};

type SubmissionStatus = "all" | "pending" | "approved" | "rejected";

export const Route = createFileRoute("/admin/_shell/inventory-vendors")({
  loader: async () => {
    const { getInventoryVendorsPageData } = await import("@/lib/admin/fns/inv-vendors");
    // 一支 fn 拿齊（廠商清單、表單選項、送審佇列）。送審預設只看待審的：這一區存在的理由
    // 就是「有東西在等」，全部撈回來會把它稀釋掉。
    return await getInventoryVendorsPageData({
      data: { filter: DEFAULT_VENDOR_FILTER, approvalStatus: "pending" },
    });
  },
  head: () => ({ meta: [{ title: "廠商｜小時光書店後台" }] }),
  component: InventoryVendorsPage,
});

function InventoryVendorsPage() {
  const { vendors: loaderVendors, options, submissions: loaderSubmissions } = Route.useLoaderData();
  const loaderUpdatedAt = Route.useMatch({ select: (m) => m.updatedAt });
  const { user } = Route.useRouteContext();
  const router = useRouter();

  const vendorList = useLoaderBackedList({
    key: "inventory-vendors",
    loaderFilter: DEFAULT_VENDOR_FILTER,
    loaderData: loaderVendors,
    loaderUpdatedAt,
    errorMessage: "廠商清單讀取失敗",
    fetcher: async (next: VendorFilterValues) => {
      const { listAdminVendors } = await import("@/lib/admin/fns/inv-vendors");
      return await listAdminVendors({ data: next });
    },
  });
  const filter = vendorList.filter;
  const rows = vendorList.data;
  const loading = vendorList.loading;

  const submissionList = useLoaderBackedList({
    key: "inventory-vendors:submissions",
    loaderFilter: "pending" as SubmissionStatus,
    loaderData: loaderSubmissions,
    loaderUpdatedAt,
    errorMessage: "送審清單讀取失敗",
    fetcher: async (next: SubmissionStatus) => {
      const { listVendorSubmissions } = await import("@/lib/admin/fns/inv-vendors");
      return await listVendorSubmissions({ data: { approvalStatus: next } });
    },
  });
  const submissionStatus = submissionList.filter;
  const submissions = submissionList.data;
  const submissionsLoading = submissionList.loading;

  const [deleting, setDeleting] = useState<AdminVendorRow | null>(null);
  const [sensitive, setSensitive] = useState<AdminVendorRow | null>(null);

  // ⚠️ 三個都只控制畫面。真正的檢查在 server fn，見檔頭。
  const canApprove = user.permissions.includes("approve_vendors");
  const canApproveProducts = user.permissions.includes("approve_products");
  const canReadPii = user.permissions.includes("inv.vendor.pii.read");

  // 只拿來寫提示文字。真正的 status 是 inv.initial_approval_status() 算的。
  const approvalOn = isApprovalRequired(options.approvalSettings, "vendors");

  function changeFilter(next: VendorFilterValues) {
    vendorList.setFilter(next);
  }

  function changeSubmissionStatus(next: SubmissionStatus) {
    submissionList.setFilter(next);
  }

  /**
   * 寫入之後重抓。
   *
   * 三件事一起重抓：廠商清單、送審佇列、還有 router（類別／稅別／扣繳類別與審核設定
   * 在 loader 裡）。核准一件送審商品會同時改變佇列與那家廠商的 product_count，
   * 只重抓一半的話畫面會自相矛盾。
   */
  const reloadVendors = vendorList.reload;
  const reloadSubmissions = submissionList.reload;
  const refresh = useCallback(async () => {
    await Promise.all([reloadVendors(), reloadSubmissions()]);
    await router.invalidate();
  }, [reloadVendors, reloadSubmissions, router]);

  const { busyId, handleApprove, handleDelete, handleSubmissionDecision } =
    useVendorActions(refresh);

  function run(task: Promise<void>) {
    void task;
  }

  const pending = rows.filter((r) => r.approval_status === "pending").length;
  const consignment = rows.filter((r) => r.is_consignment).length;
  const suspended = rows.filter((r) => r.status !== "active").length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-lg font-medium">
            <Building2 className="h-5 w-5" aria-hidden="true" />
            廠商
          </h1>
          <Badge variant="secondary" className="font-normal">
            共 {rows.length.toLocaleString("zh-TW")} 家
          </Badge>
          {consignment > 0 ? (
            <Badge variant="outline" className="font-normal">
              寄售 {consignment} 家
            </Badge>
          ) : null}
          {suspended > 0 ? (
            <Badge variant="outline" className="font-normal">
              非往來中 {suspended} 家
            </Badge>
          ) : null}
          {approvalOn ? (
            <Badge variant="outline" className="font-normal">
              需審核{pending > 0 ? `・${pending} 家待審` : ""}
            </Badge>
          ) : null}
        </div>
        <Button asChild size="sm" className="gap-1.5">
          <Link to="/admin/inventory-vendors/new" preload="intent">
            <Plus className="h-4 w-4" />
            新增廠商
          </Link>
        </Button>
      </div>

      <p className="max-w-3xl text-sm text-muted-foreground">
        統一編號、身分證字號與匯款帳號在這一頁上<strong>一律是遮罩</strong>
        —— 完整號碼沒有送到瀏覽器。要看的話按每一列的「完整號碼」，
        那會問你要看哪些欄位與事由，並且留下一筆查閱紀錄（誰、什麼時候、看了什麼）。
      </p>

      <VendorSubmissionQueue
        rows={submissions}
        status={submissionStatus}
        onStatusChange={changeSubmissionStatus}
        busyId={busyId}
        loading={submissionsLoading}
        canApprove={canApproveProducts}
        onDecide={(row, approved, listing) => run(handleSubmissionDecision(row, approved, listing))}
      />

      <VendorFilterBar value={filter} onChange={changeFilter} disabled={loading} />

      {loading ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-border">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          沒有符合條件的廠商
        </div>
      ) : (
        <VendorTable
          rows={rows}
          busyId={busyId}
          canApprove={canApprove}
          canReadPii={canReadPii}
          onAskDelete={setDeleting}
          onReadSensitive={setSensitive}
          onApprove={(row) => run(handleApprove(row, true))}
          onReject={(row) => run(handleApprove(row, false))}
        />
      )}

      {!canApprove || !canReadPii ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          {!canApprove ? (
            <p>
              你可以建立與編輯廠商，但沒有審核權限（approve_vendors），所以「通過」與
              「退回」是灰的。請找管理員授權。
            </p>
          ) : null}
          {!canReadPii ? (
            <p>
              你沒有查看廠商敏感資料的權限（inv.vendor.pii.read），所以「完整號碼」是灰的。
              這個權限與各種 approve_* 是不同維度的東西：一個管收貨的店員有理由簽核進貨，
              沒有理由看到廠商的身分證字號。
            </p>
          ) : null}
        </div>
      ) : null}

      <VendorDialogs
        deleting={deleting}
        setDeleting={setDeleting}
        onConfirmDelete={(row) => run(handleDelete(row))}
      />

      <VendorSensitiveDialog
        open={sensitive !== null}
        onOpenChange={(o) => !o && setSensitive(null)}
        vendor={sensitive}
        canReadPii={canReadPii}
      />
    </div>
  );
}
