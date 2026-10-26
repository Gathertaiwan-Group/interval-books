import { useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { backOfficeTypeScaleStyles } from "@/lib/admin/type-scale";

/**
 * MCP 的 OAuth 授權同意頁 —— claude.ai／Claude 桌面版／手機「自訂連接器」按下「連接」後，
 * 老闆的瀏覽器被帶到這裡。
 *
 * 判斷全在伺服器端（src/server/mcp/oauth-consent.ts）：
 *   · 沒登入後台 → 送去 /admin/login，登入完回到這一頁（同一串參數）。
 *   · 門市人員／待開通 → 婉拒，說明要用管理員帳號。
 *   · client 或 redirect_uri 不對 → 只顯示錯誤，**不導回**（那是 open redirect）。
 *   · 管理員 → 同意畫面：允許／拒絕。按下去再交給伺服器重驗一次並簽出授權碼。
 *
 * 這一頁放在 src/routes/oauth/ 子目錄、不在 shell 底下：它不是後台模組，沒有側欄。
 * （check-meta 只稽核 src/routes/ 頂層的前台頁面，後台與這一頁都是單語、noindex。）
 * 防 iframe 的標頭（frame-ancestors 'none'）由 src/server.ts 補上。
 */
export const Route = createFileRoute("/oauth/authorize")({
  beforeLoad: async ({ location }) => {
    const query = location.searchStr ?? "";
    const { prepareOAuthAuthorize } = await import("@/lib/oauth-fns");
    const view = await prepareOAuthAuthorize({ data: { query } });
    if (view.kind === "login") throw redirect({ href: view.loginHref });
    return { view, query };
  },
  head: () => ({
    meta: [
      { title: "授權 Claude 存取｜小時光書店後台" },
      { name: "robots", content: "noindex, nofollow" },
    ],
    styles: backOfficeTypeScaleStyles(),
  }),
  component: OAuthAuthorizePage,
});

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-md space-y-5 rounded-lg border border-border bg-background p-8 shadow-sm">
        <p className="text-center text-sm text-muted-foreground">小時光書店 Interval Books</p>
        {children}
      </div>
    </div>
  );
}

function OAuthAuthorizePage() {
  const { view, query } = Route.useRouteContext();
  const [busy, setBusy] = useState<null | "allow" | "deny">(null);
  const [error, setError] = useState<string | null>(null);
  // 釣魚防線（審查 2026-10-26 #1）：別人可以在**他自己的** Claude 帳號按「連接」，再把這條
  // 授權網址寄給老闆。PKCE、CSRF 都擋不住，因為按允許的真的是老闆本人。所以要他先確認
  // 「是我自己剛剛發起的」，允許才按得下去。
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (view.kind === "redirect") window.location.replace(view.url);
  }, [view]);

  if (view.kind === "disabled") {
    return (
      <Frame>
        <h1 className="text-center text-xl font-medium">這個功能目前沒有開啟</h1>
      </Frame>
    );
  }

  if (view.kind === "redirect") {
    return (
      <Frame>
        <p className="text-center text-sm text-muted-foreground">正在返回應用程式…</p>
      </Frame>
    );
  }

  if (view.kind === "error") {
    return (
      <Frame>
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
          <ShieldAlert className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <h1 className="text-center text-xl font-medium">無法完成授權</h1>
        <p className="text-center text-sm leading-relaxed text-muted-foreground">{view.message}</p>
      </Frame>
    );
  }

  if (view.kind === "refused") {
    return (
      <Frame>
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
          <KeyRound className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="space-y-1.5 text-center">
          <h1 className="text-xl font-medium">需要管理員帳號</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            你目前以 <span className="font-medium text-foreground">{view.email}</span> 登入，
            這個帳號是{view.role === "staff" ? "門市人員" : "待開通"}帳號。
            <br />讓 Claude 存取後台需要由管理員授權，謝謝你的理解。
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="w-full">
          <a href={view.loginHref}>改用管理員帳號登入</a>
        </Button>
      </Frame>
    );
  }

  async function decide(allow: boolean) {
    if (view.kind !== "consent") return;
    setBusy(allow ? "allow" : "deny");
    setError(null);
    try {
      const { decideOAuthAuthorize } = await import("@/lib/oauth-fns");
      const r = await decideOAuthAuthorize({ data: { query, csrf: view.csrf, allow } });
      if (r.ok) {
        window.location.assign(r.url);
        return;
      }
      setError(r.message);
    } catch {
      setError("授權失敗，請稍後再試一次。");
    }
    setBusy(null);
  }

  const fromClaude = !view.loopback && /(^|\.)claude\.(ai|com)$/.test(view.redirectHost);

  return (
    <Frame>
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="space-y-1.5 text-center">
        <h1 className="text-xl font-medium">
          {fromClaude ? "Claude" : view.clientName} 想要存取小時光後台
        </h1>
        <p className="text-sm text-muted-foreground">
          以 <span className="font-medium text-foreground">{view.email}</span> 的管理員身分授權
        </p>
      </div>

      <dl className="space-y-2 rounded-md bg-muted/60 px-4 py-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">應用程式名稱</dt>
          <dd className="text-right font-medium break-all">{view.clientName}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">授權後會回到</dt>
          <dd className="text-right font-medium break-all">
            {view.redirectHost}
            {view.loopback ? "（這台電腦上的程式，例如 Claude Code）" : ""}
          </dd>
        </div>
      </dl>

      <div className="space-y-2 text-sm">
        <p className="font-medium">授權後，它可以：</p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>讀取與修改商品、活動、策旅、最新消息、刊物、講者、合作與頁面文案</li>
          <li>從網址上傳圖片到網站</li>
          <li>每一次修改前都會先預覽差異，確認後才寫入，並留下稽核紀錄</li>
        </ul>
        <p className="font-medium pt-1">它不能：</p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>查看或處理訂單、付款、發票、退款與報名名單等個人資料</li>
          <li>管理人員帳號與權限</li>
        </ul>
        <p className="text-xs text-muted-foreground pt-1">
          授權有效期最長 90 天；帳號不再是管理員時立即失效。
        </p>
      </div>

      <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-semibold">
          如果這不是你自己剛剛在 Claude 按下「連接」打開的頁面，請按「拒絕」。
        </p>
        <p className="text-xs">
          別人寄來的授權連結，按下允許會讓<strong>對方的</strong> Claude 帳號取得後台的修改權限。
        </p>
        <label className="flex items-start gap-2 pt-1">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>我確認是我自己剛剛從 Claude 發起這個連線</span>
        </label>
      </div>

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      ) : null}

      <div className="flex gap-3">
        <Button
          variant="outline"
          className="flex-1"
          disabled={busy !== null}
          onClick={() => decide(false)}
        >
          {busy === "deny" ? "處理中…" : "拒絕"}
        </Button>
        <Button
          className="flex-1"
          disabled={busy !== null || !confirmed}
          onClick={() => decide(true)}
        >
          {busy === "allow" ? "授權中…" : "允許"}
        </Button>
      </div>
    </Frame>
  );
}
