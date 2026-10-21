import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { AlertTriangle, CalendarDays, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildTodoCards, sortTodoCards, type TodoCard } from "@/lib/admin/todo";
import { formatTaipeiDateTime } from "@/lib/taipei-time";

export const Route = createFileRoute("/admin/_shell/")({
  /**
   * 店員不落在這一頁。
   *
   * 這**不是**授權 —— 下面 loader 的 getAdminTodo() 掛著 adminFnMiddleware，店員硬打
   * /admin 本來就拿不到資料。這裡導開是為了不要在店員的 router 裡留下一個**永遠
   * 載不起來的 match**：留著的話，他之後在 POS 結完帳呼叫 router.invalidate()，
   * 這個 match 會跟著重跑、丟出 401，然後 error boundary 會把已經結完帳的畫面
   * 換成一頁「Something went wrong」。錢收了、庫存扣了，畫面卻在報錯。
   */
  beforeLoad: ({ context }) => {
    if (context.user?.role === "staff") {
      throw redirect({ to: "/admin/pos" });
    }
  },
  loader: async () => {
    const { getAdminTodo } = await import("@/lib/admin/fns/dashboard");
    return await getAdminTodo();
  },
  head: () => ({
    meta: [{ title: "今日待辦｜小時光書店後台" }],
  }),
  component: AdminDashboard,
});

function AdminDashboard() {
  const { admin } = Route.useRouteContext();
  const { counts, sessions } = Route.useLoaderData();
  const cards = sortTodoCards(buildTodoCards(counts));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-medium">今日待辦</h1>
        <p className="mt-1 text-sm text-muted-foreground">{admin.email}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">需要處理的事</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <TodoCardLink key={card.key} card={card} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <CalendarDays className="h-4 w-4" aria-hidden="true" />7 天內的場次
          </h2>
          <Link to="/admin/registrations" className="text-sm underline-offset-4 hover:underline">
            看全部場次
          </Link>
        </div>

        {sessions === null ? (
          <p className="rounded-md border border-destructive/40 p-4 text-sm text-destructive">
            場次讀取失敗，請重新整理；仍失敗請到「活動報名」頁查看。
          </p>
        ) : sessions.length === 0 ? (
          <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
            接下來 7 天沒有場次。
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link
                  to="/admin/registrations"
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {s.productTitle || s.title}
                      {s.productTitle && s.title && s.title !== s.productTitle ? (
                        <span className="font-normal text-muted-foreground">｜{s.title}</span>
                      ) : null}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {/* 不可以 toLocaleString（React #418）。見 src/lib/taipei-time.ts。 */}
                      {formatTaipeiDateTime(s.starts_at)}
                      {s.status === "closed" ? "・已關閉報名" : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-sm">
                    <p className="font-medium">{s.paid === null ? "—" : `${s.paid} 人已付款`}</p>
                    <p className="text-muted-foreground">
                      名額 {s.seats_taken} / {s.capacity}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TodoCardLink({ card }: { card: TodoCard }) {
  const failed = card.count === null;
  const active = failed || (card.count ?? 0) > 0;

  const body = (
    <Card
      className={
        active
          ? "h-full border-amber-500/50 transition-colors hover:border-amber-600"
          : "h-full transition-colors hover:border-foreground/40"
      }
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
        {active ? (
          <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
      </CardHeader>
      <CardContent>
        {failed ? (
          <p className="text-sm text-destructive">讀取失敗，點進去查看</p>
        ) : card.count === 0 ? (
          <p className="text-sm text-muted-foreground">{card.emptyText}</p>
        ) : (
          <>
            <div className="text-2xl font-semibold">{card.count}</div>
            <p className="text-sm text-muted-foreground">{card.unit}</p>
            {card.hint ? <p className="mt-1 text-xs text-muted-foreground">{card.hint}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );

  // 「待出貨」要帶 ?scope=to_ship 才會落在那個分頁；其餘卡片照舊只連到頁面本身。
  if (card.search) {
    return (
      <Link to="/admin/orders" search={card.search} className="block">
        {body}
      </Link>
    );
  }
  return (
    <Link to={card.href} className="block">
      {body}
    </Link>
  );
}
