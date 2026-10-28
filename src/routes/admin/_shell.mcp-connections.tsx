/**
 * /admin/mcp-connections —— Claude 連線授權（2026-10-28，0043 之後）。
 *
 * 每一次在 Claude（claude.ai／桌面版／手機的自訂連接器）按「允許」，就是這裡的一列
 * （public.mcp_oauth_grants）。「撤銷」之後那條連線的 refresh 立刻不能用、access token
 * 最多 60 秒內失效（src/server/mcp/oauth-store.ts 的快取），Claude 那邊要重新連接。
 *
 * 「全部撤銷」另外把每位管理員的撤銷 epoch 加一：連 0043 上線前簽發、還沒被搬進授權鏈的
 * 舊 token 也一起失效。靜態 MCP_TOKEN（Claude Code 的 header 設定）不受這一頁影響。
 *
 * 只有 admin（server fn 掛 adminFnMiddleware；側欄 staff:false）。
 */
import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import type { McpGrantRow } from "@/server/repos/mcp-oauth-grants";

export const Route = createFileRoute("/admin/_shell/mcp-connections")({
  loader: async () => {
    const { listMcpConnections } = await import("@/lib/admin/fns/mcp-connections");
    return { grants: await listMcpConnections() };
  },
  head: () => ({ meta: [{ title: "Claude 連線授權｜小時光書店後台" }] }),
  component: McpConnectionsPage,
});

const REASON: Record<string, string> = {
  admin: "後台撤銷",
  client: "Claude 端中斷連線",
  refresh_reuse: "偵測到舊憑證被重複使用，自動撤銷",
  revoke_all: "全部撤銷",
};

function grantState(g: McpGrantRow): "active" | "revoked" | "expired" {
  if (g.revoked_at) return "revoked";
  if (Date.parse(g.expires_at) <= Date.now()) return "expired";
  return "active";
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

function McpConnectionsPage() {
  const { grants } = Route.useLoaderData();
  const router = useRouter();
  const [target, setTarget] = useState<McpGrantRow | "all" | null>(null);
  const [busy, setBusy] = useState(false);
  const active = grants.filter((g) => grantState(g) === "active");

  async function confirm() {
    if (!target) return;
    setBusy(true);
    try {
      const fns = await import("@/lib/admin/fns/mcp-connections");
      if (target === "all") {
        const r = await fns.revokeAllMcpConnections({ data: { confirm: true } });
        toast.success(`已全部撤銷（${r.grants} 條連線）`);
      } else {
        await fns.revokeMcpConnection({ data: { id: target.id } });
        toast.success("已撤銷這條連線");
      }
      setTarget(null);
      await router.invalidate({ sync: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "撤銷失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-medium">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
            Claude 連線授權
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            在 Claude 新增「小時光」自訂連接器並按下「允許」的每一次授權。不認得、或裝置遺失時按
            「撤銷」，那邊就得重新登入授權。Claude Code 用的固定金鑰（MCP_TOKEN）不在這裡。
          </p>
        </div>
        <Button
          variant="outline"
          className="text-destructive hover:text-destructive"
          onClick={() => setTarget("all")}
        >
          全部撤銷
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>授權的管理員</TableHead>
              <TableHead>應用程式</TableHead>
              <TableHead className="whitespace-nowrap">授權時間</TableHead>
              <TableHead className="whitespace-nowrap">最後使用</TableHead>
              <TableHead className="whitespace-nowrap">最晚到期</TableHead>
              <TableHead>狀態</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">
                  還沒有任何授權紀錄。0043
                  上線前就連著的連接器，會在下一次自動更新憑證時出現在這裡。
                </TableCell>
              </TableRow>
            ) : (
              grants.map((g) => {
                const st = grantState(g);
                return (
                  <TableRow key={g.id}>
                    <TableCell className="max-w-[14rem] truncate">{g.email ?? g.user_id}</TableCell>
                    <TableCell className="max-w-[14rem]">
                      <span className="block truncate">{g.client_name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        回到 {hostOf(g.redirect_uri)}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatTaipeiDateTime(g.created_at)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatTaipeiDateTime(g.last_used_at)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatTaipeiDateTime(g.expires_at)}
                    </TableCell>
                    <TableCell>
                      {st === "active" ? (
                        <Badge>使用中</Badge>
                      ) : st === "expired" ? (
                        <Badge variant="outline">已到期</Badge>
                      ) : (
                        <span className="flex flex-col gap-0.5">
                          <Badge variant="secondary" className="w-fit">
                            已撤銷
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {REASON[g.revoked_reason ?? ""] ?? ""}
                            {g.revoked_at ? `・${formatTaipeiDateTime(g.revoked_at)}` : ""}
                          </span>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {st === "active" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setTarget(g)}
                        >
                          撤銷
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        使用中 {active.length} 條。撤銷後 Claude 那邊最多 1 分鐘內就無法再讀寫後台。
      </p>

      <AlertDialog open={target !== null} onOpenChange={(o) => !o && !busy && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target === "all" ? "全部撤銷所有 Claude 連線？" : "撤銷這條連線？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {target === "all"
                ? "所有管理員在 Claude 裡的「小時光」連接器都會被中斷（包含升級前就連著的），要用的人得重新連接並登入授權。Claude Code 的固定金鑰不受影響。"
                : target
                  ? `「${target.client_name}」（${target.email ?? "管理員"}）會被中斷，之後要在 Claude 重新連接並登入授權。`
                  : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? "撤銷中…" : "撤銷"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
