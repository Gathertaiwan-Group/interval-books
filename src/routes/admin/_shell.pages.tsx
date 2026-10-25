import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { formatUpdatedAt } from "@/lib/admin/format";

/**
 * List view for /admin/pages, and — because TanStack Router's flat-routes
 * nests any file whose routeId is a longer prefix match under the closest
 * existing route — also the structural PARENT of
 * src/routes/admin/_shell.pages.$slug.tsx ("/admin/_shell/pages/$slug" is a
 * longer prefix match against this route's "/admin/_shell/pages" than
 * against "/admin/_shell", so the generator parents it here, not directly
 * under _shell). That makes this file responsible for rendering an <Outlet />
 * for the per-page editor.
 *
 * Without the isListView guard below, visiting /admin/pages/$slug would stack
 * this file's own list table ABOVE the editor (both routes are simultaneously
 * "active" in a nested match) instead of the dedicated single-page editor view
 * the spec calls for. So: show the list only at the exact /admin/pages path;
 * hand off entirely to the Outlet (the $slug editor) for anything deeper.
 */
export const Route = createFileRoute("/admin/_shell/pages")({
  loader: async () => {
    const { listPages } = await import("@/lib/admin/fns/pages");
    const pages = await listPages();
    return { pages };
  },
  head: () => ({
    meta: [{ title: "頁面文案｜小時光書店後台" }],
  }),
  component: AdminPagesListPage,
});

function AdminPagesListPage() {
  const { pages } = Route.useLoaderData();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isListView = pathname === "/admin/pages";

  if (!isListView) {
    return <Outlet />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium">頁面文案</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          共 {pages.length}{" "}
          個頁面。頁面由程式碼的路由決定，這裡只能編輯既有頁面的文案，不能新增或刪除頁面。
        </p>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>頁面</TableHead>
              <TableHead>網址代稱</TableHead>
              <TableHead className="w-36">最後更新</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pages.map((p) => {
              const displayName = p.header_title?.zh || p.meta_title.zh;
              return (
                <TableRow key={p.slug}>
                  <TableCell className="text-muted-foreground">{p.sort_order}</TableCell>
                  <TableCell className="max-w-sm truncate font-medium">{displayName}</TableCell>
                  <TableCell className="text-muted-foreground">{p.slug}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatUpdatedAt(p.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <Link preload="intent" to="/admin/pages/$slug" params={{ slug: p.slug }}>
                        編輯
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
