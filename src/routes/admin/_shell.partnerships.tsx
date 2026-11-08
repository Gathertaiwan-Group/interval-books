/**
 * /admin/partnerships —— 異業合作收件匣（2026-10-28，0042 之後）。
 *
 * /partnership 表單每送出一筆，src/server/partnership.ts 先存一列 partnership_inquiries 再寄
 * 通知信；這一頁就是那張表。只有 admin（server fn 掛 adminFnMiddleware；側欄 staff:false）。
 *
 * 篩選走網址參數 ?status=（new／replied／archived／all，不帶＝未處理），loader 依它重抓——
 * 從內頁按「回到列表」用 history.back()，分頁籤與捲動位置原樣回來。點一列進
 * /admin/partnerships/$id 看完整內容、回信、改狀態、寫內部備註。
 */
import { createFileRoute, Link, useRouter, useRouterState } from "@tanstack/react-router";
import { Handshake, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { rememberAdminPeek } from "@/lib/admin/list-memory";
import {
  INQUIRY_STATUS_LABEL,
  inquiryBudgetLabel,
  inquiryTypeLabel,
  parseInquiryFilter,
  type InquiryFilter,
} from "@/lib/partnership-inbox";
import { formatTaipeiDateTime } from "@/lib/taipei-time";

type ListSearch = { status?: Exclude<InquiryFilter, "new"> };

export const Route = createFileRoute("/admin/_shell/partnerships")({
  validateSearch: (search: Record<string, unknown>): ListSearch => {
    const f = parseInquiryFilter(search.status);
    return f === "new" ? {} : { status: f };
  },
  loaderDeps: ({ search }) => ({ status: parseInquiryFilter(search.status) }),
  loader: async ({ deps }) => {
    const { listPartnershipInquiries } = await import("@/lib/admin/fns/partnerships");
    const res = await listPartnershipInquiries({ data: { status: deps.status } });
    return { ...res, status: deps.status };
  },
  head: () => ({ meta: [{ title: "異業合作｜小時光書店後台" }] }),
  component: AdminPartnershipsPage,
});

function statusBadge(status: string) {
  if (status === "new") return <Badge>未處理</Badge>;
  if (status === "replied") return <Badge variant="secondary">已回覆</Badge>;
  return <Badge variant="outline">已封存</Badge>;
}

function AdminPartnershipsPage() {
  const { rows, counts, status, limit } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const loading = useRouterState({
    select: (s) => s.status === "pending" && s.location.pathname === "/admin/partnerships",
  });
  const search: ListSearch = status === "new" ? {} : { status };

  const openRow = (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (row) rememberAdminPeek("partnership", id, row);
    void navigate({ to: "/admin/partnerships/$id", params: { id }, search });
  };
  const preloadRow = (id: string) =>
    void router
      .preloadRoute({ to: "/admin/partnerships/$id", params: { id } })
      .catch(() => undefined);

  const tab = (value: InquiryFilter, label: string, n?: number) => (
    <TabsTrigger value={value}>
      {label}
      {typeof n === "number" && n > 0 ? `（${n}）` : ""}
    </TabsTrigger>
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <Handshake className="h-5 w-5" aria-hidden="true" />
          異業合作
          {counts.new > 0 ? (
            <Badge className="ml-1" aria-label={`${counts.new} 筆未處理`}>
              {counts.new}
            </Badge>
          ) : null}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          前台
          <a href="/partnership" target="_blank" rel="noreferrer" className="mx-1 underline">
            /partnership
          </a>
          表單送進來的合作邀約。每一筆也會寄一封通知信給「全站設定」的通知信收件人；這裡是不會漏的那一份。點一列看完整內容、回信、改狀態。
        </p>
      </div>

      <Tabs
        value={status}
        onValueChange={(v) => {
          const f = parseInquiryFilter(v);
          void navigate({ search: f === "new" ? {} : { status: f }, replace: true });
        }}
      >
        <TabsList className="h-auto flex-wrap">
          {tab("new", INQUIRY_STATUS_LABEL.new, counts.new)}
          {tab("replied", INQUIRY_STATUS_LABEL.replied, counts.replied)}
          {tab("archived", INQUIRY_STATUS_LABEL.archived, counts.archived)}
          {tab("all", "全部")}
        </TabsList>
      </Tabs>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-36">收到時間</TableHead>
              <TableHead>公司／品牌</TableHead>
              <TableHead>聯絡人</TableHead>
              <TableHead>合作類型</TableHead>
              <TableHead>預算</TableHead>
              <TableHead className="w-24">狀態</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-sm text-muted-foreground">
                  {status === "new" ? "目前沒有未處理的合作邀約" : "這個分類沒有資料"}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() => openRow(r.id)}
                  onMouseEnter={() => preloadRow(r.id)}
                  onFocus={() => preloadRow(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openRow(r.id);
                    }
                  }}
                >
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatTaipeiDateTime(r.created_at)}
                  </TableCell>
                  <TableCell className="max-w-[14rem] truncate font-medium">
                    <Link
                      to="/admin/partnerships/$id"
                      params={{ id: r.id }}
                      search={search}
                      className="underline-offset-2 hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        rememberAdminPeek("partnership", r.id, r);
                      }}
                    >
                      {r.company}
                    </Link>
                    {r.email_status === "failed" ? (
                      <Badge variant="destructive" className="ml-2 font-normal">
                        通知信失敗
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate">
                    {r.contact_name}
                    <span className="block truncate text-xs text-muted-foreground">{r.email}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{inquiryTypeLabel(r.type)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {inquiryBudgetLabel(r.budget)}
                  </TableCell>
                  <TableCell>{statusBadge(r.status)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {rows.length >= limit ? (
        <p className="text-xs text-muted-foreground">只顯示最新的 {limit} 筆。</p>
      ) : null}
    </div>
  );
}
