/**
 * POST /api/tasks/invoices —— 補開發票的排程入口。
 *
 * ── 為什麼需要這條路徑 ────────────────────────────────────────────────────
 * 付款成功時 webhook 會就地開一次發票（src/server/payuni-webhook.ts），但那一次可能
 * 失敗：Amego 當下掛掉、逾時、serverless instance 在回應之前被回收。那些單會停在
 * invoices.status='failed'（或過期的 'issuing'），而**沒有任何東西會自己再試一次**。
 *
 * 0006_order_expiry.sql 已經示範過這個坑：`expire_unpaid_orders()` 寫得再好，沒有
 * 排程呼叫它就是一段死碼。所以這條路徑存在的意義只有一個 —— 讓外部排程有地方打。
 *
 * 排程已經接上了：supabase/migrations/0008_invoice_cron.sql 用 pg_cron + pg_net，
 * 每 10 分鐘（分鐘 3,13,23,33,43,53）POST 這條路徑一次。密鑰存在 Supabase Vault，
 * 不在 cron.job.command 裡 —— 詳見那支 migration 的檔頭。
 *
 * ⚠️ 不用 Vercel Cron 的理由寫在這裡，免得之後有人「順手」加回去：這個 Vercel 帳號是
 * hobby 方案，**Vercel Cron 一天只能跑一次**。對「開票失敗要盡快重試」而言，一天一次
 * 等於沒有重試。
 *
 * ⚠️ 「排程有跑」不等於「打得到這裡」。pg_net 是非同步的，cron.job_run_details 只證明
 * 請求被排進佇列。真正的答案在 net._http_response 的 status_code。
 *
 * ── 安全性 ────────────────────────────────────────────────────────────────
 * 與 PayUni webhook 同一套：密鑰在 query string（`?k=`），缺密鑰 503、不符 404，
 * 常數時間比對。這條路徑會對外部 API 產生真實副作用（開稅務憑證），所以它比一般的
 * 讀取端點更需要擋住掃描式請求 —— 連 body 都不解析就先擋掉。
 */
import "@tanstack/react-start/server-only";
import { timingSafeEqual } from "node:crypto";

export const INVOICE_TASK_PATH = "/api/tasks/invoices";

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * 跑一輪補開。
 *
 * GET 也接受，因為 Vercel Cron 只會送 GET；副作用性的端點通常不該接 GET，但這裡的
 * 保護是密鑰而不是 HTTP 動詞，而且這個動作本身是冪等的（claim 擋住重複、Amego 的
 * OrderId 唯一性再擋一次），所以差別只在方便性。
 *
 * `?order=<uuid>` 只補開指定的那一張。存在的理由是人工排查：某一張卡住時，要能單獨
 * 重跑它並立刻看到結果，而不是跑一整輪 backlog 再去猜哪一行是它。它同時也是併發
 * 測試的入口 —— 對同一個 order 同時打兩次，正好驗證 claim 真的只放行一個。
 */
export async function handleInvoiceTask(req: Request): Promise<Response> {
  if (req.method !== "POST" && req.method !== "GET") return text("method not allowed", 405);

  const secret = process.env.TASKS_SECRET;
  if (!secret) return text("service unavailable", 503);

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return text("bad request", 400);
  }
  if (!secretMatches(url.searchParams.get("k"), secret)) return text("not found", 404);

  // service_role 的資料層只在通過密鑰閘門後才載入。
  const { reclaimStaleInvoices } = await import("@/server/repos/invoices");
  const { issueInvoiceForOrder, runInvoiceBacklog } = await import("@/server/invoice-issuer");

  const singleOrder = url.searchParams.get("order");
  if (singleOrder) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(singleOrder)) {
      return text("bad order id", 400);
    }
    const outcome = await issueInvoiceForOrder(singleOrder);
    return json({ ok: true, order: singleOrder, outcome });
  }

  // 先把卡在 issuing 的撥回來 —— claim 本身就會接手過期的 claim，這一步是為了讓
  // 那些單在資料庫裡的狀態是誠實的（見 0007 reclaim_stale_invoices 的註解）。
  const reclaimed = await reclaimStaleInvoices(100);
  if (reclaimed.length > 0) {
    console.warn(
      `[tasks] 撿回 ${reclaimed.length} 張卡在 issuing 的發票：${reclaimed.map((r) => r.orderNo).join(", ")}`,
    );
  }

  const result = await runInvoiceBacklog(20);

  // 補開完之後才檢查告警：這一輪剛燒到上限的單，同一輪就寄得出去（業主 2026-10-28：
  // 「只要有已付款但發票開不出來的訂單，就寄信通知管理員」）。只寄給店家
  // （site_settings.notify_emails），去重與每日一封的規則在 src/lib/invoice-alerts.ts。
  // runInvoiceAlerts() 永不 throw，告警壞掉不影響上面已經做完的補開。
  const { runInvoiceAlerts } = await import("@/server/invoice-alerts");
  const alerts = await runInvoiceAlerts();

  return json({ ok: true, reclaimed: reclaimed.length, ...result, alerts });
}

// ---------------------------------------------------------------------------
// POST /api/tasks/purge-scans —— 進貨單掃描圖的保留期限（0019 §9.2）
// ---------------------------------------------------------------------------
/**
 * 4c 交接留下的第五件事：`ocr-scans` 這個 private bucket 刻意保留原圖（辨識可疑時
 * 要調得出來對照「AI 說單價 50，單子上到底寫什麼」），但進貨單上有**廠商名稱與
 * 單價**，屬於 Phase 5 的 PII 治理範圍 —— 而在此之前**沒有任何自動清理**，圖會
 * 一直累積下去。
 *
 * 政策（保留天數寫在資料庫的 public.ocr_scan_retention_days()，預設 180 天）：
 * 辨識結果的爭議通常在當月對帳時就會浮現，一季是寬鬆的上限，半年是「連年度結算
 * 都過了」。
 *
 * ⚠️ **vendor-attachments 不在這裡，而且刻意不做自動清理。** 合約是契約文件，
 *    保留義務由稅法與契約本身決定（商業會計法五年），不該由一支排程猜。
 *
 * ⚠️ 這一支刪的是 **storage 物件**，不是資料庫的列 —— `ocr-scans` 裡的檔案沒有
 *    對應的資料表（掃描 key 只出現在進貨單的欄位上）。所以它走 Storage API 的
 *    list + remove，而不是 SQL。
 *
 * ⚠️ 冪等：重跑只會發現沒有東西可刪。可以安心讓排程每天打一次。
 *
 * 排程還沒接上 —— 這條路徑要有人打才會跑（0006 的 expire_unpaid_orders() 示範過
 * 「寫得再好，沒有排程呼叫就是死碼」）。接法與 INVOICE_TASK_PATH 一樣：
 * pg_cron + pg_net，密鑰存 Supabase Vault。一天一次就夠，所以 Vercel Cron 的
 * hobby 限制（一天一次）在這條路徑上剛好不是問題。
 */
export const PURGE_SCANS_TASK_PATH = "/api/tasks/purge-scans";

export async function handlePurgeScansTask(req: Request): Promise<Response> {
  if (req.method !== "POST" && req.method !== "GET") return text("method not allowed", 405);

  const secret = process.env.TASKS_SECRET;
  if (!secret) return text("service unavailable", 503);

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return text("bad request", 400);
  }
  if (!secretMatches(url.searchParams.get("k"), secret)) return text("not found", 404);

  const { purgeExpiredOcrScans } = await import("@/server/storage");

  // ?dry=1 只列出要刪什麼，不真的刪。第一次上線時要用它確認範圍。
  const dryRun = url.searchParams.get("dry") === "1";
  const result = await purgeExpiredOcrScans({ dryRun });
  return json({ ok: true, dryRun, ...result });
}

// ---------------------------------------------------------------------------
// POST /api/tasks/notify —— 交易信的排程入口（0022）
// ---------------------------------------------------------------------------
/**
 * 這條路徑存在的理由與 INVOICE_TASK_PATH 一模一樣，只是換一件事：
 * 付款成功時 webhook 會就地排信並試寄一次（src/server/notify.ts 的
 * triggerNotifyAfterPayment），但那一次可能失敗 —— Resend 當下掛掉、逾時、
 * serverless instance 在回應之前被回收。那些信會停在
 * `email_outbox.status='pending'`，而**沒有任何東西會自己再試一次**。
 *
 * 而且有一件事 webhook 根本做不到：**活動前 24 小時的提醒信**沒有任何使用者動作
 * 會觸發它。那件事只有排程做得到。
 *
 * 排程已經接上了：supabase/migrations/0022_email_outbox_notify.sql 用 pg_cron +
 * pg_net，每 10 分鐘（分鐘 6,16,26,36,46,56）POST 這條路徑一次。密鑰存在
 * Supabase Vault，不在 cron.job.command 裡 —— 詳見那支 migration 的檔頭。
 *
 * ⚠️ 用到的 Vault secret 是 `notify_tasks_endpoint_url`（新的）與 `tasks_secret`
 *    （沿用 0008 那一筆）。
 *
 * ── 四件事，順序是固定的 ──────────────────────────────────────────────────
 *
 *   1. notify backlog —— 把「付了錢卻沒排信」的訂單補排進 outbox
 *   2. 場次提醒       —— 把 24 小時內要開始的場次的提醒信排進 outbox
 *   3. flush outbox   —— 把 outbox 沖出去（前兩步剛排進來的也在這一批裡）
 *   4. purge          —— 清掉 30 天前已寄出的信件內文
 *
 * 前兩步都是「往 outbox 裡放東西」，第三步才是「把東西送出去」。順序顛倒的話，
 * 這一輪剛排進來的信要等下一輪（10 分鐘後）才寄得出去 —— 對「活動前 24 小時」
 * 那封信來說沒差，對「付款成功」那封補寄的信來說就是客人多等 10 分鐘。
 *
 * ⚠️ **Phase 4（自助候補）要在第 2 步與第 3 步之間插入候補遞補的 sweep**，理由
 *    同上：sweep 產生的 offer 信要在同一輪送出去，否則候補的人會晚 10 分鐘才知道
 *    自己補上了 —— 而 offer 是有時效的。
 *
 * ── 安全性 ────────────────────────────────────────────────────────────────
 * 與上面兩條完全相同：密鑰在 query string（`?k=`），缺密鑰 503、不符 404，
 * 常數時間比對，連 body 都不解析。這條路徑會**寄出真的信**給真的人，所以它跟
 * 開發票那條一樣需要擋住掃描式請求。
 */
export const NOTIFY_TASK_PATH = "/api/tasks/notify";

export async function handleNotifyTask(req: Request): Promise<Response> {
  if (req.method !== "POST" && req.method !== "GET") return text("method not allowed", 405);

  const secret = process.env.TASKS_SECRET;
  if (!secret) return text("service unavailable", 503);

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return text("bad request", 400);
  }
  if (!secretMatches(url.searchParams.get("k"), secret)) return text("not found", 404);

  // service_role 的資料層只在通過密鑰閘門後才載入。
  const {
    flushEmailOutbox,
    purgeEmailBodies,
    queueOrderNotifications,
    runNotifyBacklog,
    runSessionReminders,
  } = await import("@/server/notify");

  // `?order=<uuid>` 只補排指定的那一張，理由同 INVOICE_TASK_PATH 的同名參數：
  // 人工排查時要能單獨重跑一張並立刻看到結果，而且它同時是併發測試的入口
  // （對同一個 order 同時打兩次，正好驗證 claim 真的只放行一個）。
  const singleOrder = url.searchParams.get("order");
  if (singleOrder) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(singleOrder)) {
      return text("bad order id", 400);
    }
    const outcome = await queueOrderNotifications(singleOrder);
    const flushed = await flushEmailOutbox();
    return json({ ok: true, order: singleOrder, outcome, flushed });
  }

  const backlog = await runNotifyBacklog(20);
  const reminders = await runSessionReminders();
  const flushed = await flushEmailOutbox(20);
  const purged = await purgeEmailBodies();

  return json({ ok: true, backlog, reminders, flushed, purged });
}
