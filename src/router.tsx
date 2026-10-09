import { useEffect } from "react";
import { createRouter, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { toast } from "sonner";
import { routeTree } from "./routeTree.gen";

/**
 * 部署之後還開著的分頁會壞：頁面記得的是上一版的程式檔名，而 Vercel 每次部署都是一整組新的
 * /assets（幾乎每個檔名都會變），舊檔名回 404。之後只要要載入還沒載過的程式檔就會失敗——
 * 2026-10-09 後台按「新增活動」就是這樣掉進錯誤頁，按「Try again」也沒用。
 *
 * 兩種情況分開處理：
 * - **換頁**（loader／route 元件）：錯誤會掉進下面的 DefaultErrorComponent，那裡自動整頁重載一次。
 *   換頁本來就要離開這一頁，沒有東西會不見；10 秒內不重複，真的壞掉時才不會無限重整。
 * - **按鈕、表單送出、開對話框**（後台約 130 處在事件裡才 `await import()`）：**不能**自動重載——
 *   表單裡打的字、POS 購物車會全部不見。這時動作在送到伺服器之前就失敗了（沒有寫入任何資料），
 *   錯誤照常交給呼叫端的 catch，另外跳一個不會自己消失的提示，請使用者先保留內容再重新整理。
 *   所以 vite:preloadError 監聽器**不** preventDefault：攔下來的話那次 import 會回傳 undefined，
 *   呼叫端只會看到一個莫名其妙的 TypeError。
 */
const STALE_DEPLOY_ERROR =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading chunk .+ failed/i;
const RELOAD_KEY = "ib:stale-deploy-reload-at";

function reloadOnceForNewDeploy(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOAD_KEY) || 0) < 10_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false; // 沒有 sessionStorage 就記不住重載過沒——寧可停在錯誤頁，也不要冒無限重整的險
  }
  window.location.reload();
  return true;
}

function announceNewDeploy() {
  toast("網站剛更新了", {
    id: "new-deploy", // 同一次失敗會連發好幾個事件（每個程式檔一個），用同一個 id 只顯示一則
    description: "剛剛的動作沒有送出。請先複製還沒存的內容，再重新整理頁面。",
    duration: Infinity,
    action: { label: "重新整理", onClick: () => window.location.reload() },
  });
}

if (typeof window !== "undefined") {
  // Vite 載入程式檔失敗時發的事件（Vite 文件「Load Error Handling」）。換頁的情況錯誤頁會自動重載，
  // 提示只是一閃；按鈕的情況就靠這則提示。
  window.addEventListener("vite:preloadError", announceNewDeploy);
}

function DefaultErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  // @tanstack/react-router 1.170 起 error 的型別是 unknown（被 throw 的不一定是 Error 物件）
  const message = error instanceof Error ? error.message : error == null ? "" : String(error);
  const staleDeploy = STALE_DEPLOY_ERROR.test(message);

  // 換頁時載不到程式檔：自動重載一次就會拿到新版（見檔頭）
  useEffect(() => {
    if (staleDeploy) reloadOnceForNewDeploy();
  }, [staleDeploy]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-8 w-8 text-destructive"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An unexpected error occurred. Please try again.
        </p>
        {import.meta.env.DEV && message && (
          <pre className="mt-4 max-h-40 overflow-auto rounded-md bg-muted p-3 text-left font-mono text-xs text-destructive">
            {message}
          </pre>
        )}
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            onClick={() => {
              // 程式檔過期時 reset() 只會再 import 同一個 404 的檔名，要整頁重載才拿得到新版
              if (staleDeploy) {
                window.location.reload();
                return;
              }
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const getRouter = () => {
  const router = createRouter({
    routeTree,
    context: {},
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorComponent,
  });

  return router;
};
