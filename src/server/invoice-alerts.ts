/**
 * 「已付款但發票開不出來」→ 寄信給店家。由 /api/tasks/invoices（每 10 分鐘，
 * 見 src/server/task-endpoints.ts）在補開完一輪之後呼叫。
 *
 * 判斷與去重全部在 src/lib/invoice-alerts.ts（純函式，有自檢）；這裡只負責讀資料、
 * 組信、排進 email_outbox。信由 /api/tasks/notify 的 flushEmailOutbox() 送出（同一套
 * outbox，不另接 Resend）。
 *
 * 🔴 這個檔案**不開發票、不改 invoices**。它只讀 invoices／orders／email_outbox，
 *    唯一的寫入是 enqueue_admin_order_email()（0032）往 outbox 排一封給店家的信。
 *
 * 🔴 永不 throw：它跑在開發票的排程裡，告警壞掉不可以讓補開發票那一步跟著失敗。
 *
 * 🔴 讀「已經寄過哪些」失敗時**這一輪不寄**——寧可晚 10 分鐘，不要在讀不到去重紀錄
 *    的時候每 10 分鐘寄一次。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import { INVOICE_MAX_RETRIES } from "@/server/repos/invoices";
import { enqueueAdminOrderEmail } from "@/server/repos/email-outbox";
import { publicUrlFor } from "@/server/public-url";
import {
  FAILED_ALERT_KEY_PREFIX,
  isTerminalInvoiceFailure,
  needsInvoiceAttention,
  planDigest,
  planTerminalAlert,
  type InvoiceProblemRow,
  type SentAlert,
} from "@/lib/invoice-alerts";
import {
  renderInvoiceDigestAdminEmail,
  renderInvoiceFailedAdminEmail,
  type InvoiceAlertOrder,
} from "@/lib/email-templates";

type OrderEmbed = {
  order_no: string;
  paid_at: string | null;
  total: number | string | null;
  payment_status: string;
};

/**
 * 所有「已付款、金額 > 0、發票不是 issued／voided」的訂單。
 *
 * 兩段查詢：有 invoices 列的（inner join），與完全沒有 invoices 列的（claim 會補建，
 * 所以是暫態，但它同樣沒有發票）。條件與 invoice_backlog()（0028 §3）的前三行相同，
 * **差別是不看 retry_count 上限**——backlog 刻意排除已經停止重試的，而那正是這裡
 * 要找的。
 *
 * 讀失敗回 null（不是空陣列）：「查不到」不等於「沒事」。
 */
export async function loadInvoiceProblemRows(): Promise<InvoiceProblemRow[] | null> {
  const db = supabaseAdmin();
  try {
    const [withRow, withoutRow] = await Promise.all([
      db
        .from("invoices")
        .select(
          "order_id, status, retry_count, error_message, updated_at, orders!inner(order_no, paid_at, total, payment_status)",
        )
        .not("status", "in", "(issued,voided)")
        .eq("orders.payment_status", "paid")
        .gt("orders.total", 0)
        // 新的在前：真的累積到上限時，被截掉的是最舊的，剛停止重試的那幾張一定在。
        .order("updated_at", { ascending: false })
        .limit(1000),
      db
        .from("orders")
        .select("id, order_no, paid_at, total, invoices(id)")
        .eq("payment_status", "paid")
        .gt("total", 0)
        .is("invoices", null)
        .limit(1000),
    ]);
    if (withRow.error) {
      console.error(
        `[invoice-alerts] invoices 讀取失敗：${withRow.error.code} ${withRow.error.message}`,
      );
      return null;
    }
    if (withoutRow.error) {
      console.error(
        `[invoice-alerts] 無發票列訂單讀取失敗：${withoutRow.error.code} ${withoutRow.error.message}`,
      );
      return null;
    }

    const rows: InvoiceProblemRow[] = [];
    for (const r of (withRow.data ?? []) as unknown as Array<{
      order_id: string;
      status: string;
      retry_count: number | null;
      error_message: string | null;
      updated_at: string | null;
      orders: OrderEmbed | OrderEmbed[] | null;
    }>) {
      const o = Array.isArray(r.orders) ? r.orders[0] : r.orders;
      if (!o) continue;
      rows.push({
        orderId: r.order_id,
        orderNo: o.order_no,
        paidAt: o.paid_at,
        total: Number(o.total ?? 0),
        status: r.status,
        retryCount: Number(r.retry_count ?? 0),
        errorMessage: r.error_message,
        updatedAt: r.updated_at,
      });
    }
    for (const o of (withoutRow.data ?? []) as unknown as Array<{
      id: string;
      order_no: string;
      paid_at: string | null;
      total: number | string | null;
    }>) {
      rows.push({
        orderId: o.id,
        orderNo: o.order_no,
        paidAt: o.paid_at,
        total: Number(o.total ?? 0),
        status: "missing",
        retryCount: 0,
        errorMessage: null,
        updatedAt: null,
      });
    }
    return rows;
  } catch (err) {
    console.error(`[invoice-alerts] 讀取例外：${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** 後台橫幅與篩選列表用：需要人看的那一組（與每日彙整同一個定義）。讀失敗回 null。 */
export async function loadInvoiceAttentionRows(
  now: Date = new Date(),
): Promise<InvoiceProblemRow[] | null> {
  const rows = await loadInvoiceProblemRows();
  if (rows === null) return null;
  return rows
    .filter((r) => needsInvoiceAttention(r, now, INVOICE_MAX_RETRIES))
    .sort((a, b) => a.orderNo.localeCompare(b.orderNo));
}

/** email_outbox 裡已經排過的開立失敗信（只讀 dedupe_key 與時間，不讀收件人）。 */
async function loadSentFailedAlerts(): Promise<SentAlert[] | null> {
  const { data, error } = await supabaseAdmin()
    .from("email_outbox")
    .select("dedupe_key, created_at")
    .like("dedupe_key", `${FAILED_ALERT_KEY_PREFIX}%`)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) {
    console.error(`[invoice-alerts] 讀取已寄告警失敗：${error.code} ${error.message}`);
    return null;
  }
  return ((data ?? []) as { dedupe_key: string; created_at: string }[]).map((r) => ({
    dedupeKey: r.dedupe_key,
    createdAt: r.created_at,
  }));
}

export function toAlertOrder(r: InvoiceProblemRow): InvoiceAlertOrder {
  return {
    orderNo: r.orderNo,
    paidAt: r.paidAt,
    total: r.total,
    status: r.status,
    retryCount: r.retryCount,
    errorMessage: r.errorMessage,
    adminUrl: publicUrlFor(`/admin/orders/${encodeURIComponent(r.orderId)}`),
  };
}

export function invoiceProblemListUrl(): string | null {
  return publicUrlFor("/admin/orders", { scope: "invoice_problem" });
}

export type InvoiceAlertRunResult = {
  /** 讀不到資料（這一輪什麼都沒做）。 */
  skipped?: string;
  failedAlert: { queued: boolean; orders: number; remaining: number } | null;
  digest: { queued: boolean; orders: number } | null;
};

/**
 * 跑一輪告警。永不 throw。
 *
 * 回傳的 queued=false 有兩種意思：dedupe_key 已經存在（這一封已經排過——正常），
 * 或 notify_emails 是空的（enqueue_admin_order_email() 安靜跳過）。兩者都不是錯誤。
 */
export async function runInvoiceAlerts(now: Date = new Date()): Promise<InvoiceAlertRunResult> {
  try {
    const rows = await loadInvoiceProblemRows();
    if (rows === null)
      return { skipped: "problem_rows_unreadable", failedAlert: null, digest: null };

    const result: InvoiceAlertRunResult = { failedAlert: null, digest: null };
    const listUrl = invoiceProblemListUrl();

    // ---- 1. 剛停止自動重試的 → 開立失敗信（一輪最多一封）--------------------
    const hasTerminal = rows.some((r) => isTerminalInvoiceFailure(r, INVOICE_MAX_RETRIES));
    if (hasTerminal) {
      const sent = await loadSentFailedAlerts();
      if (sent === null) {
        result.skipped = "sent_alerts_unreadable";
      } else {
        const plan = planTerminalAlert(rows, sent, now, INVOICE_MAX_RETRIES);
        if (plan) {
          const mail = renderInvoiceFailedAdminEmail({
            orders: plan.rows.map(toAlertOrder),
            maxRetries: INVOICE_MAX_RETRIES,
            remaining: plan.remaining,
            listUrl,
          });
          const queued = await enqueueAdminOrderEmail({
            dedupeKey: plan.dedupeKey,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
          });
          result.failedAlert = { queued, orders: plan.rows.length, remaining: plan.remaining };
          if (queued) {
            console.warn(
              `[invoice-alerts] 已排開立失敗信：${plan.rows.map((r) => r.orderNo).join(", ")}` +
                (plan.remaining > 0 ? `（另有 ${plan.remaining} 張下一輪）` : ""),
            );
          }
        }
      }
    }

    // ---- 2. 每日彙整（台北 09:00 之後，一天一封）-----------------------------
    const digest = planDigest(rows, now, INVOICE_MAX_RETRIES);
    if (digest) {
      const mail = renderInvoiceDigestAdminEmail({
        orders: digest.rows.map(toAlertOrder),
        maxRetries: INVOICE_MAX_RETRIES,
        listUrl,
      });
      const queued = await enqueueAdminOrderEmail({
        dedupeKey: digest.dedupeKey,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      result.digest = { queued, orders: digest.rows.length };
      if (queued) console.warn(`[invoice-alerts] 已排每日彙整：${digest.rows.length} 張`);
    }

    return result;
  } catch (err) {
    console.error(`[invoice-alerts] 例外：${err instanceof Error ? err.message : err}`);
    return { skipped: "unexpected_error", failedAlert: null, digest: null };
  }
}
