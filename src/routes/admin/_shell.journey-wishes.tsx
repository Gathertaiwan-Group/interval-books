/**
 * /admin/journey-wishes —— 旅程願望收件匣（0046 之後）。
 *
 * 策旅頁「下次，我想這樣玩」表單（目前是 /events/kungtung）每送出一筆，
 * src/server/journey-wish.ts 先存一列 journey_wishes 再寄通知信；這一頁就是那張表。
 * 只有 admin（server fn 掛 adminFnMiddleware；側欄 staff:false）。排版照 /admin/partnerships：
 * 篩選走網址參數 ?status=（new／reviewed／archived／all，不帶＝未處理），點一列進
 * /admin/journey-wishes/$id 看完整內容、回信、改狀態、寫內部備註。
 */
import { createFileRoute, Link, useRouter, useRouterState } from "@tanstack/react-router";
import { Loader2, Sparkles } from "lucide-react";
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
import { wishSourceLabel } from "@/lib/journey-wish";
import {
  WISH_STATUS_LABEL,
  parseWishFilter,
  wishSummary,
  type WishFilter,
} from "@/lib/journey-wish-inbox";
import { formatTaipeiDateTime } from "@/lib/taipei-time";

type ListSearch = { status?: Exclude<WishFilter, "new"> };

export const Route = createFileRoute("/admin/_shell/journey-wishes")({
  validateSearch: (search: Record<string, unknown>): ListSearch => {
    const f = parseWishFilter(search.status);
    return f === "new" ? {} : { status: f };
  },
  loaderDeps: ({ search }) => ({ status: parseWishFilter(search.status) }),
  loader: async ({ deps }) => {
    const { listJourneyWishes } = await import("@/lib/admin/fns/journey-wishes");
    const res = await listJourneyWishes({ data: { status: deps.status } });
    return { ...res, status: deps.status };
  },
  head: () => ({ meta: [{ title: "旅程願望｜小時光書店後台" }] }),
  component: AdminJourneyWishesPage,
});

function statusBadge(status: string) {
  if (status === "new") return <Badge>未處理</Badge>;
  if (status === "reviewed") return <Badge variant="secondary">已看過</Badge>;
  return <Badge variant="outline">已封存</Badge>;
}

function AdminJourneyWishesPage() {
  const { rows, counts, status, limit } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const loading = useRouterState({
    select: (s) => s.status === "pending" && s.location.pathname === "/admin/journey-wishes",
  });
  const search: ListSearch = status === "new" ? {} : { status };

  const openRow = (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (row) rememberAdminPeek("journey-wish", id, row);
    void navigate({ to: "/admin/journey-wishes/$id", params: { id }, search });
  };
  const preloadRow = (id: string) =>
    void router
      .preloadRoute({ to: "/admin/journey-wishes/$id", params: { id } })
      .catch(() => undefined);

  const tab = (value: WishFilter, label: string, n?: number) => (
    <TabsTrigger value={value}>
      {label}
      {typeof n === "number" && n > 0 ? `（${n}）` : ""}
    </TabsTrigger>
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
          旅程願望
          {counts.new > 0 ? (
            <Badge className="ml-1" aria-label={`${counts.new} 筆未處理`}>
              {counts.new}
            </Badge>
          ) : null}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          策旅頁「下次，我想這樣玩」表單送進來的旅行願望（目前是
          <a href="/events/kungtung" target="_blank" rel="noreferrer" className="mx-1 underline">
            /events/kungtung
          </a>
          ）。每一筆也會寄一封通知信給「全站設定」的通知信收件人；這裡是不會漏的那一份。點一列看完整內容、改狀態、寫備註。
        </p>
      </div>

      <Tabs
        value={status}
        onValueChange={(v) => {
          const f = parseWishFilter(v);
          void navigate({ search: f === "new" ? {} : { status: f }, replace: true });
        }}
      >
        <TabsList className="h-auto flex-wrap">
          {tab("new", WISH_STATUS_LABEL.new, counts.new)}
          {tab("reviewed", WISH_STATUS_LABEL.reviewed, counts.reviewed)}
          {tab("archived", WISH_STATUS_LABEL.archived, counts.archived)}
          {tab("all", "全部")}
        </TabsList>
      </Tabs>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-36">收到時間</TableHead>
              <TableHead>願望</TableHead>
              <TableHead>稱呼</TableHead>
              <TableHead>來源頁面</TableHead>
              <TableHead className="w-24">狀態</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-sm text-muted-foreground">
                  {status === "new" ? "目前沒有未處理的旅程願望" : "這個分類沒有資料"}
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
                  <TableCell className="max-w-[20rem] truncate font-medium">
                    <Link
                      to="/admin/journey-wishes/$id"
                      params={{ id: r.id }}
                      search={search}
                      className="underline-offset-2 hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        rememberAdminPeek("journey-wish", r.id, r);
                      }}
                    >
                      {wishSummary(r)}
                    </Link>
                    {r.email_status === "failed" ? (
                      <Badge variant="destructive" className="ml-2 font-normal">
                        通知信失敗
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate">
                    {r.name || <span className="text-muted-foreground">未留</span>}
                    {r.email ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {r.email}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[14rem] truncate text-muted-foreground">
                    {wishSourceLabel(r.source).split("｜")[0]}
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
