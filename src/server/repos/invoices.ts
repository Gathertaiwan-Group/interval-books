/**
 * Data layer for public.invoices —— 開發票這一步唯一被允許碰資料庫的地方。
 *
 * 這裡幾乎沒有邏輯，因為邏輯不該在這裡：claim / finish / fail 三件事的正確性靠的是
 * 0007_invoice_issue.sql 裡的 plpgsql 函式，它們把「訂單列鎖 + order_post_payment_log
 * 佔位 + invoices CAS」放在同一個交易。用兩個 PostgREST 請求依序做同樣的事，中間那個
 * 空窗就是「同一張訂單開出兩張發票」的入口，而發票開出去撤不回來。
 *
 * 所以這個檔案的規矩：**不要在這裡實作第二套鎖**，也不要「為了少一次 round trip」
 * 把 claim 拆成先 select 再 update。要改併發行為，改 0007（追加新編號的 migration），
 * 不要改這裡。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";

/** 與 0007 的 p_max_retries 預設值一致。改這裡要一起改 SQL 預設值。 */
export const INVOICE_MAX_RETRIES = 5;

/** claim 多久算過期（程序被砍掉、instance 被回收）。與 0007 的 p_stale_after 一致。 */
export const INVOICE_STALE_AFTER = "5 minutes";

/** 與 0007 的 claim_invoice_issue 回傳的 reason 一一對應，外加一個資料庫層失敗。 */
export type ClaimFailureReason =
  | "order_not_found"
  | "order_not_paid"
  | "already_issued"
  | "voided"
  | "locked"
  | "retries_exhausted"
  | "db_error";

const CLAIM_FAILURE_REASONS = new Set<string>([
  "order_not_found",
  "order_not_paid",
  "already_issued",
  "voided",
  "locked",
  "retries_exhausted",
  "db_error",
]);

export type InvoiceClaim =
  | { claimed: true; invoiceId: string; attempt: number; orderNo: string }
  | {
      claimed: false;
      reason: ClaimFailureReason;
      orderNo: string | null;
      invoiceNumber: string | null;
      attempt: number;
    };

type ClaimRow = {
  claimed: boolean;
  reason: string;
  invoice_id: string | null;
  attempt: number;
  order_no: string | null;
  invoice_number: string | null;
};

/**
 * 取得「我可以去打 Amego」的許可。
 *
 * claimed=true 之後**一定**要走到 finishInvoiceIssue 或 failInvoiceIssue 其中之一，
 * 否則這張單會停在 issuing 直到 p_stale_after 過去才被接手。呼叫端請用 try/finally
 * 或等價結構保證這件事（見 src/server/invoice-issuer.ts）。
 */
export async function claimInvoiceIssue(orderId: string): Promise<InvoiceClaim> {
  const { data, error } = await supabaseAdmin().rpc("claim_invoice_issue", {
    p_order_id: orderId,
    p_stale_after: INVOICE_STALE_AFTER,
    p_max_retries: INVOICE_MAX_RETRIES,
  });

  if (error) {
    console.error("[invoices] claim_invoice_issue failed", orderId, error);
    return { claimed: false, reason: "db_error", orderNo: null, invoiceNumber: null, attempt: 0 };
  }

  const row = (Array.isArray(data) ? data[0] : data) as ClaimRow | undefined;
  if (!row) {
    console.error("[invoices] claim_invoice_issue 沒有回傳任何列", orderId);
    return { claimed: false, reason: "db_error", orderNo: null, invoiceNumber: null, attempt: 0 };
  }

  if (row.claimed && row.invoice_id) {
    return {
      claimed: true,
      invoiceId: row.invoice_id,
      attempt: row.attempt ?? 0,
      orderNo: row.order_no ?? "",
    };
  }

  // 未知的 reason 當成 db_error：SQL 端加了新分支而這裡還沒跟上時，要停下來而不是
  // 把它當成某個已知情況繼續往下走。
  const reason: ClaimFailureReason = CLAIM_FAILURE_REASONS.has(row.reason)
    ? (row.reason as ClaimFailureReason)
    : "db_error";
  if (reason === "db_error" && row.reason !== "db_error") {
    console.error("[invoices] claim_invoice_issue 回了未知的 reason", row.reason);
  }

  return {
    claimed: false,
    reason,
    orderNo: row.order_no,
    invoiceNumber: row.invoice_number,
    attempt: row.attempt ?? 0,
  };
}

/**
 * 記錄開立成功。
 *
 * 回 false 有兩種意思：同號碼重送（無害），或資料庫層拒絕了（DOUBLE_ISSUE）。後者
 * 一定伴隨 error，而且是這整個檔案裡最嚴重的一種失敗 —— 代表同一張訂單真的產生了
 * 兩個發票號碼，需要人去 Amego 後台作廢其中一張。
 */
export async function finishInvoiceIssue(params: {
  orderId: string;
  invoiceNumber: string;
  randomCode: string | null;
  issuedAt?: string;
}): Promise<{ ok: boolean; doubleIssue: boolean }> {
  const { error } = await supabaseAdmin().rpc("finish_invoice_issue", {
    p_order_id: params.orderId,
    p_invoice_number: params.invoiceNumber,
    p_random_code: params.randomCode,
    p_issued_at: params.issuedAt ?? new Date().toISOString(),
  });

  if (!error) return { ok: true, doubleIssue: false };

  const doubleIssue = String(error.message ?? "").includes("DOUBLE_ISSUE");
  if (doubleIssue) {
    console.error(
      `[invoices] 🚨 DOUBLE ISSUE order=${params.orderId} incoming=${params.invoiceNumber} — ` +
        `同一張訂單出現第二個發票號碼，需人工到 Amego 後台作廢其中一張`,
      error,
    );
  } else {
    console.error("[invoices] finish_invoice_issue failed", params.orderId, error);
  }
  return { ok: false, doubleIssue };
}

/**
 * 記錄開立失敗並釋放 claim。
 *
 * permanent=true 代表重試沒有意義（統編格式錯、金額算錯、載具不存在）：retry_count
 * 直接推到上限，之後的 claim 一律回 retries_exhausted，等人改資料。
 */
export async function failInvoiceIssue(params: {
  orderId: string;
  error: string;
  permanent: boolean;
}): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc("fail_invoice_issue", {
    p_order_id: params.orderId,
    p_error: params.error,
    p_permanent: params.permanent,
    p_max_retries: INVOICE_MAX_RETRIES,
  });
  if (error) {
    // claim 沒還回去 —— 但 0007 的 p_stale_after 接手機制就是為了這一刻存在，
    // 這張單會在 5 分鐘後重新可被 claim，不會永久卡死。
    console.error("[invoices] fail_invoice_issue failed", params.orderId, error);
    return -1;
  }
  return typeof data === "number" ? data : -1;
}

export type InvoicePrefs = {
  invoiceType: "personal" | "company" | "donate";
  carrierType: string | null;
  carrierNumber: string | null;
  loveCode: string | null;
  taxId: string | null;
  companyTitle: string | null;
  status: string;
  invoiceNumber: string | null;
};

/** 客人在結帳時選的發票開法。沒有那一列時回 null（claim 會補建，所以這是暫態）。 */
export async function getInvoicePrefs(orderId: string): Promise<InvoicePrefs | null> {
  const { data, error } = await supabaseAdmin()
    .from("invoices")
    .select(
      "invoice_type, carrier_type, carrier_number, love_code, tax_id, company_title, status, invoice_number",
    )
    .eq("order_id", orderId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return {
    invoiceType: (row.invoice_type as InvoicePrefs["invoiceType"]) ?? "personal",
    carrierType: (row.carrier_type as string | null) ?? null,
    carrierNumber: (row.carrier_number as string | null) ?? null,
    loveCode: (row.love_code as string | null) ?? null,
    taxId: (row.tax_id as string | null) ?? null,
    companyTitle: (row.company_title as string | null) ?? null,
    status: (row.status as string) ?? "pending",
    invoiceNumber: (row.invoice_number as string | null) ?? null,
  };
}

export type InvoiceOrder = {
  id: string;
  orderNo: string;
  customerName: string;
  customerEmail: string;
  subtotal: number;
  shippingFee: number;
  discount: number;
  total: number;
  paymentStatus: string;
};

export type InvoiceOrderItem = {
  name: Record<string, string>;
  unitPrice: number;
  quantity: number;
  subtotal: number;
};

/** 開發票要用的訂單資料。品項名稱一律取中文 —— 發票是給國稅局看的。 */
export async function getOrderForInvoice(
  orderId: string,
): Promise<{ order: InvoiceOrder; items: InvoiceOrderItem[] } | null> {
  const db = supabaseAdmin();
  const [orderRes, itemsRes] = await Promise.all([
    db
      .from("orders")
      .select(
        "id, order_no, customer_name, customer_email, subtotal, shipping_fee, discount, total, payment_status",
      )
      .eq("id", orderId)
      .maybeSingle(),
    db
      .from("order_items")
      .select("name, unit_price, quantity, subtotal")
      .eq("order_id", orderId)
      .order("id", { ascending: true }),
  ]);

  if (orderRes.error || !orderRes.data) return null;
  const o = orderRes.data as Record<string, unknown>;
  const items = ((itemsRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
    name: (r.name ?? {}) as Record<string, string>,
    unitPrice: Number(r.unit_price ?? 0),
    quantity: Number(r.quantity ?? 0),
    subtotal: Number(r.subtotal ?? 0),
  }));

  return {
    order: {
      id: String(o.id),
      orderNo: String(o.order_no),
      customerName: String(o.customer_name ?? ""),
      customerEmail: String(o.customer_email ?? ""),
      subtotal: Number(o.subtotal ?? 0),
      shippingFee: Number(o.shipping_fee ?? 0),
      discount: Number(o.discount ?? 0),
      total: Number(o.total ?? 0),
      paymentStatus: String(o.payment_status ?? ""),
    },
    items,
  };
}

export type BacklogRow = {
  orderId: string;
  orderNo: string;
  status: string;
  retryCount: number;
  errorMessage: string | null;
};

/** 已付款但發票還沒開成功的訂單。worker 與人工排查共用 0007 裡的同一個定義。 */
export async function invoiceBacklog(limit = 50): Promise<BacklogRow[]> {
  const { data, error } = await supabaseAdmin().rpc("invoice_backlog", {
    p_limit: limit,
    p_max_retries: INVOICE_MAX_RETRIES,
    p_stale_after: INVOICE_STALE_AFTER,
  });
  if (error) {
    console.error("[invoices] invoice_backlog failed", error);
    return [];
  }
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    orderId: String(r.order_id),
    orderNo: String(r.order_no),
    status: String(r.status),
    retryCount: Number(r.retry_count ?? 0),
    errorMessage: (r.error_message as string | null) ?? null,
  }));
}

/** 把卡在 issuing 的撥回 failed，讓它重新出現在待處理清單裡。 */
export async function reclaimStaleInvoices(
  limit = 100,
): Promise<{ orderNo: string; stuckSince: string | null }[]> {
  const { data, error } = await supabaseAdmin().rpc("reclaim_stale_invoices", {
    p_stale_after: INVOICE_STALE_AFTER,
    p_limit: limit,
  });
  if (error) {
    console.error("[invoices] reclaim_stale_invoices failed", error);
    return [];
  }
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    orderNo: String(r.reclaimed_order_no),
    stuckSince: (r.stuck_since as string | null) ?? null,
  }));
}

export type InvoiceReissueState = {
  orderNo: string;
  paymentStatus: string;
  total: number;
  /** invoices 沒有那一列時是 'missing'（claim 會補建）。 */
  invoiceStatus: string;
  retryCount: number;
};

/** 後台重新開立前的檢查用。查無訂單回 null，資料庫錯誤回 "db_error"。 */
export async function getInvoiceStateForReissue(
  orderId: string,
): Promise<InvoiceReissueState | null | "db_error"> {
  const { data, error } = await supabaseAdmin()
    .from("orders")
    .select("order_no, payment_status, total, invoices(status, retry_count)")
    .eq("id", orderId)
    .maybeSingle();
  if (error) {
    console.error(`[invoices] reissue state 讀取失敗：${error.code} ${error.message}`);
    return "db_error";
  }
  if (!data) return null;
  const row = data as unknown as {
    order_no: string;
    payment_status: string;
    total: number | string | null;
    invoices:
      | { status: string; retry_count: number | null }
      | { status: string; retry_count: number | null }[]
      | null;
  };
  const inv = Array.isArray(row.invoices) ? row.invoices[0] : row.invoices;
  return {
    orderNo: row.order_no,
    paymentStatus: row.payment_status,
    total: Number(row.total ?? 0),
    invoiceStatus: inv?.status ?? "missing",
    retryCount: Number(inv?.retry_count ?? 0),
  };
}

/**
 * 後台「重新開立發票」：把 failed 的 retry_count 設回 1，讓 claim 重新放行。
 *
 * 只動 status = 'failed' 的那一列（conditional update），所以不會碰到已開立／正在
 * 開立的列。這**不是第二套鎖**——放不放行打 Amego 仍然只由 claim_invoice_issue()
 * 決定；這裡只是把「已經停止重試」這個狀態撥回「還可以重試」。設 1 而不是 0 的理由
 * 見 src/server/invoice-issuer.ts 的 reissueInvoiceForOrder()。
 *
 * 回 false 代表資料庫錯誤。0 列受影響（別人剛好已經把它開好或撥回）不算錯誤。
 */
export async function resetInvoiceRetriesForReissue(orderId: string): Promise<boolean> {
  const { error } = await supabaseAdmin()
    .from("invoices")
    .update({ retry_count: 1 })
    .eq("order_id", orderId)
    .eq("status", "failed");
  if (error) {
    console.error(`[invoices] reset retry_count 失敗：${error.code} ${error.message}`);
    return false;
  }
  return true;
}
