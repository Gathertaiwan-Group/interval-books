/**
 * 自訂 server entry —— 這個專案唯一一條「非 createServerFn」的伺服器路徑。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * 全站的伺服器邏輯都走 createServerFn（src/lib/checkout-fns.ts、src/lib/admin/fns/*），
 * 那是刻意的，不要因為這個檔案存在就開始在這裡加業務邏輯。這裡只有一個理由：
 * PayUni 的背景通知（NotifyURL）是外部系統對一個我們指定的網址送
 * `application/x-www-form-urlencoded` POST。createServerFn 的端點是框架自己的
 * RPC 協定（固定路徑前綴 + 固定序列化格式），金流商沒有辦法照著打。
 *
 * TanStack Start 1.167 沒有 file-based API routes —— @tanstack/react-start 與
 * router-core 都查不到 createServerFileRoute / route `server.handlers`。可用的
 * 掛載點是自訂 server entry：start-plugin-core 的 resolveStartEntryPlan() 會把
 * `src/server.ts` 當成 server entry（見 node_modules/@tanstack/start-plugin-core/
 * dist/esm/planning.js），沒有這個檔案時才退回框架的預設 entry。
 *
 * 所以這裡的規矩是：
 *   * 只攔下面那張表列出的路徑，其他一律原封不動交回 startFetch。
 *   * 每條路徑的實作都用 dynamic import 載入，service_role client 不會在這個模組
 *     載入時就被拉進來。
 *   * 要再加路徑時，先確認它真的不能用 createServerFn 表達。
 *
 * 目前掛在這裡的八條，理由各自不同：
 *   BLACKCAT_APN_PATH      黑貓 PAY（統一客樂得 COCS）的 APN 主動通知。**這是這家店
 *                          實際在跑的那條刷卡路線。** 金流商的伺服器對我們指定的網址送
 *                          application/json POST，同樣打不到框架的 RPC 協定。
 *   BLACKCAT_RETURN_PATH   黑貓刷完卡之後的瀏覽器導回。呼叫者是**客人的瀏覽器**，
 *                          被 302 過來帶一串 query string —— 它連我們的 JS 都還沒載入，
 *                          更不可能照 createServerFn 的序列化格式打。
 *                          ⚠️ 這一條**不碰任何付款狀態**，只負責把人送到確認頁；
 *                             錢的真相只來自上面那條 APN。見 blackcat-webhook.ts。
 *   PAYUNI_WEBHOOK_PATH    外部金流商送 form-urlencoded POST，打不到框架的 RPC 協定。
 *                          （PayUni 直連 UPP 這條路留著但沒有憑證，見 blackcat.ts 檔頭。）
 *   INVOICE_TASK_PATH      外部排程（Vercel Cron / Railway worker）要有地方定時打，
 *                          用來補開失敗的發票。同樣不是瀏覽器發起的請求。
 *   PURGE_SCANS_TASK_PATH  進貨單掃描圖的保留期限（0019 §9.2）。一樣是排程要打的，
 *                          而且它會刪 storage 上的檔案 —— 那不是瀏覽器該發起的動作。
 *   NOTIFY_TASK_PATH       交易信的排程（0022）。**發起者是資料庫**：pg_cron 每 10
 *                          分鐘用 pg_net 打一次，用來補寄失敗的信，以及送出活動前
 *                          24 小時的提醒。createServerFn 表達不了它，理由有兩個 ——
 *                          (a) 那是框架的 RPC 協定，pg_net 只會送一個普通的 POST；
 *                          (b) createServerFn 的授權靠 cookie（readAdminSession），
 *                          而排程沒有 cookie，它帶的是共享密鑰。這四條路徑全都是
 *                          「沒有瀏覽器 session 的呼叫者」，那正是它們不能走
 *                          createServerFn 的共同原因。
 *   MCP_PATH               遠端 MCP server（/api/mcp，src/server/mcp/）。呼叫者是 AI 客戶端
 *                          （Claude Code／claude.ai），說的是 MCP 的 JSON-RPC over HTTP，
 *                          帶的是 Bearer token 不是 cookie —— 同樣是「沒有瀏覽器 session 的
 *                          呼叫者」。沒設 MCP_TOKEN 時回 404（整支關閉）。
 *   /.well-known/oauth-*   一律 404。MCP 走靜態 token、沒有 authorization server；有客戶端
 *                          看到 OAuth discovery 就會忽略設定的 header 硬走 OAuth。
 */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { BLACKCAT_APN_PATH, BLACKCAT_RETURN_PATH } from "@/server/blackcat";
import { cacheControlFor } from "@/server/cache-policy";
import { isOAuthDiscoveryPath, MCP_PATH } from "@/server/mcp/core";
import { PAYUNI_WEBHOOK_PATH } from "@/server/payuni";
import {
  INVOICE_TASK_PATH,
  NOTIFY_TASK_PATH,
  PURGE_SCANS_TASK_PATH,
} from "@/server/task-endpoints";

const startFetch = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request, ...rest: unknown[]): Promise<Response> {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      pathname = "";
    }

    if (pathname === BLACKCAT_APN_PATH) {
      const { handleBlackcatApn } = await import("@/server/blackcat-webhook");
      return handleBlackcatApn(request);
    }

    if (pathname === BLACKCAT_RETURN_PATH) {
      const { handleBlackcatReturn } = await import("@/server/blackcat-webhook");
      return handleBlackcatReturn(request);
    }

    if (pathname === PAYUNI_WEBHOOK_PATH) {
      const { handlePayuniWebhook } = await import("@/server/payuni-webhook");
      return handlePayuniWebhook(request);
    }

    if (pathname === INVOICE_TASK_PATH) {
      const { handleInvoiceTask } = await import("@/server/task-endpoints");
      return handleInvoiceTask(request);
    }

    if (pathname === PURGE_SCANS_TASK_PATH) {
      const { handlePurgeScansTask } = await import("@/server/task-endpoints");
      return handlePurgeScansTask(request);
    }

    if (pathname === MCP_PATH) {
      const { handleMcpRequest } = await import("@/server/mcp/http");
      return handleMcpRequest(request);
    }

    if (isOAuthDiscoveryPath(pathname)) {
      const { handleOAuthDiscovery } = await import("@/server/mcp/http");
      return handleOAuthDiscovery();
    }

    if (pathname === NOTIFY_TASK_PATH) {
      const { handleNotifyTask } = await import("@/server/task-endpoints");
      return handleNotifyTask(request);
    }

    const response = await (startFetch as (req: Request, ...a: unknown[]) => Promise<Response>)(
      request,
      ...rest,
    );

    // HTML 快取（2026-09 前台載入速度優化）：白名單制的 Cache-Control 覆寫，見
    // src/server/cache-policy.ts 檔頭——這裡不是新加一條攔截路徑（上面那六條的
    // 規矩不適用），是在 startFetch 已經算出真正的回應之後，只換掉 Cache-Control
    // 這一個標頭。body 直接原封傳遞（不 buffer、不解析），SSR streaming 不受影響。
    const cacheControl = cacheControlFor(pathname, request.method, response.status);
    if (cacheControl === null) return response;
    const headers = new Headers(response.headers);
    headers.set("cache-control", cacheControl);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
