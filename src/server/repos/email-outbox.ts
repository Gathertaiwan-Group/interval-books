/**
 * Data layer for public.email_outbox / public.email_copy —— 寄信這一步唯一被允許
 * 碰資料庫的地方。
 *
 * 這裡幾乎沒有邏輯，理由與 src/server/repos/invoices.ts 完全相同：正確性靠的是
 * 0022 裡的 plpgsql 函式，它們把「挑列 + 佔位」「寫 log + 結掉 claim」放在同一個
 * 交易。用兩個 PostgREST 請求依序做同樣的事，中間那個空窗就是「同一封信寄兩次」
 * 與「claim 拿了沒還」的入口。
 *
 * **不要在這裡實作第二套鎖**，也不要「為了少一次 round trip」把 claim 拆成先
 * select 再 update —— 那正是快樂手 outbox.ts:93-127 的形狀，而 0022 §4 已經把它
 * 收成一句 SQL。要改併發行為，改 migration（追加新編號），不要改這裡。
 *
 * ── 明文 email 不經過這個檔案 ────────────────────────────────────────────
 *
 * ⚠️ **enqueue 的兩支函式都不收地址，也不回傳地址。** 呼叫端給的是
 *    order_id / registration_id 與排好版的內容，地址由 0022 §7 的 SQL 自己
 *    join（orders.customer_email / event_registrations.email）。所以「要寄信給
 *    誰」這件事的明文一步都沒有離開資料庫。
 *
 *    唯一拿得到明文的是 claimEmailBatch()，而那是寄信本身必須的 —— 那個地址
 *    要交給 Resend。它的回傳值只被 src/server/notify.ts 的 flush 迴圈用一次，
 *    不進 log、不回前端、不寫進任何別的地方。
 *
 * ── log 紀律 ─────────────────────────────────────────────────────────────
 * ⚠️ `console.error` 只印 `error.code` 與 `error.message`，**不印整包 error**。
 *    PostgREST 會把 Postgres 的 `DETAIL: Failing row contains (…)` 一路傳回來，
 *    而對 email_outbox 來說那一行裡有收件地址與整封信的內文。同 0020 對
 *    event_registrations 的規矩，scripts/notify-selftest.mjs 有靜態測試守著。
 *
 * ⚠️ 這個檔案的 log **不准出現裸的收件地址**。要印就走
 *    maskEmail()（src/lib/email-templates.ts）。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { EmailCopy } from "@/lib/email-templates";
import type { Lang, Localized } from "@/i18n/types";

/** 與 0022 §5 fail_email 的 p_max_attempts 預設值一致。改這裡要一起改 SQL。 */
export const EMAIL_MAX_ATTEMPTS = 8;

/** 一次 flush 最多處理幾封。webhook 那一次只是「順手寄一下」，主力在排程。 */
export const EMAIL_FLUSH_BATCH = 5;

/** claim 多久算過期。與 0007 / 0022 的 p_stale_after 一致。 */
export const NOTIFY_STALE_AFTER = "5 minutes";

/** 提醒信提前多久寄。0022 §11 的 p_lead 預設值。 */
export const REMINDER_LEAD = "24 hours";

/** 寄出多久之後清掉信件內文（0022 §6）。 */
export const BODY_RETENTION = "30 days";

// -----------------------------------------------------------------------------
// 文案
// -----------------------------------------------------------------------------

/**
 * 讀 public.email_copy，攤成 `${template_key}.${string_key}` → Localized。
 *
 * 失敗時回空物件而不是 throw：文案讀不到不該讓信寄不出去
 * （src/lib/email-templates.ts 有 DEFAULT_EMAIL_COPY 當 fallback，缺什麼補什麼）。
 * 這與 src/lib/cms.ts「任何失敗都退回內建常數，站不白畫面」是同一個決定。
 */
export async function loadEmailCopy(): Promise<EmailCopy> {
  const { data, error } = await supabaseAdmin()
    .from("email_copy")
    .select("template_key, string_key, value");

  if (error) {
    console.error(`[repo/email-outbox] 讀文案失敗：${error.code} ${error.message} —— 改用內建佔位`);
    return {};
  }

  const out: EmailCopy = {};
  for (const row of (data ?? []) as {
    template_key: string;
    string_key: string;
    value: unknown;
  }[]) {
    out[`${row.template_key}.${row.string_key}`] = row.value as Localized;
  }
  return out;
}

// -----------------------------------------------------------------------------
// 排信（地址由 SQL join，不從這裡傳）
// -----------------------------------------------------------------------------

/**
 * 把一封信排給訂購人。回 true 代表**這一次真的新增了一列**。
 *
 * 回 false 有兩種可能，而且刻意不分辨：dedupe_key 已存在（之前排過了），或這張
 * 訂單沒有信箱。兩種對呼叫端的意義一樣 —— 這一次不需要做任何事。
 */
export async function enqueueOrderEmail(input: {
  orderId: string;
  dedupeKey: string;
  subject: string;
  text: string;
  html: string;
}): Promise<boolean> {
  return (await enqueueOrderEmailResult(input)) === "queued";
}

/**
 * 同 enqueueOrderEmail，但**分得出「沒排」與「排失敗」**：
 *   queued     —— 這一次真的新增了一列
 *   not_queued —— dedupe_key 已存在，或這張訂單沒有信箱（同上，刻意不再細分）
 *   error      —— RPC 本身失敗（資料庫錯誤）
 *
 * 出貨通知信（後台「標記已出貨」）需要這個區分：排失敗要回一句警告給後台人員，
 * 而「之前排過了」不是失敗。既有呼叫端只要 boolean，所以 enqueueOrderEmail 照舊。
 */
export async function enqueueOrderEmailResult(input: {
  orderId: string;
  dedupeKey: string;
  subject: string;
  text: string;
  html: string;
}): Promise<"queued" | "not_queued" | "error"> {
  const { data, error } = await supabaseAdmin().rpc("enqueue_order_email", {
    p_order_id: input.orderId,
    p_dedupe_key: input.dedupeKey,
    p_subject: input.subject,
    p_body_text: input.text,
    p_body_html: input.html,
  });

  if (error) {
    console.error(
      `[repo/email-outbox] enqueue_order_email 失敗 key=${input.dedupeKey}：${error.code} ${error.message}`,
    );
    return "error";
  }
  return data === true ? "queued" : "not_queued";
}

/**
 * 把一封信排給店家（0032 §2 的 enqueue_admin_order_email）。回 true 代表這一次
 * 真的新增了一列。回 false 有兩種可能，刻意不分辨：dedupe_key 已存在（之前排過
 * 了），或 site_settings.notify_emails 是空的／只有逗號與空白——兩種對呼叫端的
 * 意義一樣，這一次不需要做任何事，也**不是錯誤**（收件信箱本來就允許留白）。
 *
 * ⚠️ 沒有收件地址參數。跟 enqueueOrderEmail 同一個理由：地址由 0032 §2 的 SQL
 *    自己從 site_settings 查，不從呼叫端傳入。
 */
export async function enqueueAdminOrderEmail(input: {
  dedupeKey: string;
  subject: string;
  text: string;
  html: string;
}): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("enqueue_admin_order_email", {
    p_dedupe_key: input.dedupeKey,
    p_subject: input.subject,
    p_body_text: input.text,
    p_body_html: input.html,
  });

  if (error) {
    console.error(
      `[repo/email-outbox] enqueue_admin_order_email 失敗 key=${input.dedupeKey}：${error.code} ${error.message}`,
    );
    return false;
  }
  return data === true;
}

/** enqueueRegistrationEmails 的一筆。**沒有地址欄位** —— 那是重點。 */
export type RegistrationMailItem = {
  registrationId: string;
  dedupeKey: string;
  subject: string;
  text: string;
  html: string;
};

/**
 * 把一批信排給參加者。回傳實際排進去幾封。
 *
 * ⚠️ 0022 §7 的 SQL 自己 `join admin_event_roster ... where on_roster`，所以
 *    「不在簽到表上的人收不到信」是結構性的，不靠呼叫端自律。回傳數字會小於
 *    items.length 是正常的：已經排過的（撞 dedupe_key）、只留電話沒留信箱的、
 *    以及訂單後來被取消的，都不會排進去。
 */
export async function enqueueRegistrationEmails(items: RegistrationMailItem[]): Promise<number> {
  if (items.length === 0) return 0;

  const { data, error } = await supabaseAdmin().rpc("enqueue_registration_emails", {
    p_items: items.map((i) => ({
      registration_id: i.registrationId,
      dedupe_key: i.dedupeKey,
      subject: i.subject,
      body_text: i.text,
      body_html: i.html,
    })),
  });

  if (error) {
    console.error(
      `[repo/email-outbox] enqueue_registration_emails 失敗 n=${items.length}：${error.code} ${error.message}`,
    );
    return 0;
  }
  return Number(data ?? 0);
}

// -----------------------------------------------------------------------------
// 寄送
// -----------------------------------------------------------------------------

/** claimEmailBatch() 回的一列。⚠️ toEmail 是明文，只能交給 Resend。 */
export type ClaimedEmail = {
  id: string;
  dedupeKey: string;
  toEmail: string;
  subject: string;
  text: string;
  html: string;
  attempts: number;
};

/**
 * 原子地佔住最多 limit 封待寄信。
 *
 * 拿到之後**一定**要對每一封走到 finishEmail 或 failEmail 其中之一。沒走到的
 * 最壞結果是這封信晚 2^n 分鐘再試（claim 已經把 next_attempt_at 推到未來了）——
 * 這是刻意的設計，見 0022 §4：不加 'sending' 中間狀態就不會有卡住沒人接手的列。
 */
export async function claimEmailBatch(limit = EMAIL_FLUSH_BATCH): Promise<ClaimedEmail[]> {
  const { data, error } = await supabaseAdmin().rpc("claim_email_batch", { p_limit: limit });

  if (error) {
    console.error(`[repo/email-outbox] claim_email_batch 失敗：${error.code} ${error.message}`);
    return [];
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    dedupeKey: String(r.dedupe_key ?? ""),
    toEmail: String(r.to_email ?? ""),
    subject: String(r.subject ?? ""),
    text: String(r.body_text ?? ""),
    html: String(r.body_html ?? ""),
    attempts: Number(r.attempts ?? 0),
  }));
}

/**
 * 標記一封信已處理完。
 *
 * ⚠️ `skipped: true` 是 dry run（沒有 RESEND_API_KEY / MAIL_FROM），**不是 sent**。
 *    見 src/server/email.ts 檔頭那一段：標成 sent 會讓一個忘了設金鑰的正式環境
 *    顯示「全部寄出成功」。
 */
export async function finishEmail(input: {
  id: string;
  providerId: string | null;
  skipped: boolean;
}): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("finish_email", {
    p_id: input.id,
    p_provider_id: input.providerId,
    p_skipped: input.skipped,
  });

  if (error) {
    console.error(
      `[repo/email-outbox] finish_email 失敗 id=${input.id}：${error.code} ${error.message}`,
    );
    return false;
  }
  return data === true;
}

/** 記錄一次寄送失敗。回傳這一列的新狀態（'pending' 還會再試，'failed' 放棄了）。 */
export async function failEmail(id: string, message: string): Promise<string> {
  const { data, error } = await supabaseAdmin().rpc("fail_email", {
    p_id: id,
    p_error: message,
    p_max_attempts: EMAIL_MAX_ATTEMPTS,
  });

  if (error) {
    console.error(`[repo/email-outbox] fail_email 失敗 id=${id}：${error.code} ${error.message}`);
    return "db_error";
  }
  return String(data ?? "unknown");
}

/** 寄出 30 天後清掉信件內文（0022 §6）。回傳清了幾列。冪等。 */
export async function purgeSentEmailBodies(olderThan = BODY_RETENTION): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc("purge_sent_email_bodies", {
    p_older_than: olderThan,
  });

  if (error) {
    console.error(`[repo/email-outbox] purge 失敗：${error.code} ${error.message}`);
    return 0;
  }
  return Number(data ?? 0);
}

// -----------------------------------------------------------------------------
// notify claim（0022 §8，形狀對應 0007）
// -----------------------------------------------------------------------------

export type NotifyClaimReason =
  | "order_not_found"
  | "order_not_paid"
  | "already_sent"
  | "locked"
  | "db_error";

export type NotifyClaim =
  | { claimed: true; orderNo: string }
  | { claimed: false; reason: NotifyClaimReason; orderNo: string | null };

const NOTIFY_CLAIM_REASONS = new Set<string>([
  "order_not_found",
  "order_not_paid",
  "already_sent",
  "locked",
  "db_error",
]);

/**
 * 取得「這張訂單的通知由我來排」的許可。
 *
 * claimed=true 之後**一定**要走到 finishOrderNotify 或 failOrderNotify 其中之一，
 * 否則這張單的 notify 步驟會停在 claimed 直到 p_stale_after 過去才被接手。
 */
export async function claimOrderNotify(orderId: string): Promise<NotifyClaim> {
  const { data, error } = await supabaseAdmin().rpc("claim_order_notify", {
    p_order_id: orderId,
    p_stale_after: NOTIFY_STALE_AFTER,
  });

  if (error) {
    console.error(
      `[repo/email-outbox] claim_order_notify 失敗 order=${orderId}：${error.code} ${error.message}`,
    );
    return { claimed: false, reason: "db_error", orderNo: null };
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) return { claimed: false, reason: "db_error", orderNo: null };

  const orderNo = row.order_no == null ? null : String(row.order_no);
  if (row.claimed === true) return { claimed: true, orderNo: orderNo ?? "" };

  const reason = String(row.reason ?? "db_error");
  return {
    claimed: false,
    reason: (NOTIFY_CLAIM_REASONS.has(reason) ? reason : "db_error") as NotifyClaimReason,
    orderNo,
  };
}

/** 結掉 claim。「完成」＝信已經排進 outbox，不是已經送達。 */
export async function finishOrderNotify(orderId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("finish_order_notify", { p_order_id: orderId });

  if (error) {
    console.error(
      `[repo/email-outbox] finish_order_notify 失敗 order=${orderId}：${error.code} ${error.message}`,
    );
    return false;
  }
  return data === true;
}

/** 記錄排信失敗並釋放 claim（留下 error_message 當待處理標記）。 */
export async function failOrderNotify(orderId: string, message: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("fail_order_notify", {
    p_order_id: orderId,
    p_error: message,
  });

  if (error) {
    console.error(
      `[repo/email-outbox] fail_order_notify 失敗 order=${orderId}：${error.code} ${error.message}`,
    );
    return false;
  }
  return data === true;
}

export type NotifyBacklogRow = {
  orderId: string;
  orderNo: string;
  errorMessage: string | null;
};

/** 已付款但還沒排出通知信的訂單（0022 §9）。 */
export async function notifyBacklog(limit = 20): Promise<NotifyBacklogRow[]> {
  const { data, error } = await supabaseAdmin().rpc("notify_backlog", {
    p_limit: limit,
    p_stale_after: NOTIFY_STALE_AFTER,
  });

  if (error) {
    console.error(`[repo/email-outbox] notify_backlog 失敗：${error.code} ${error.message}`);
    return [];
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    orderId: String(r.order_id),
    orderNo: String(r.order_no ?? ""),
    errorMessage: r.error_message == null ? null : String(r.error_message),
  }));
}

// -----------------------------------------------------------------------------
// 提醒信要掃哪幾場
// -----------------------------------------------------------------------------

export type SessionDueRow = {
  sessionId: string;
  productId: string;
  title: Localized;
  location: Localized;
  startsAt: string;
  endsAt: string | null;
};

/**
 * 未來 lead 之內要開始的場次（0022 §11）。**不含任何個資。**
 *
 * 誰要收信由 loadPaidRosterByOrder / loadPaidRoster 決定（0021 §3 的 on_roster），
 * 地址由 enqueueRegistrationEmails 的 SQL join。
 */
export async function sessionsDueForReminder(
  lead = REMINDER_LEAD,
  limit = 50,
): Promise<SessionDueRow[]> {
  const { data, error } = await supabaseAdmin().rpc("sessions_due_for_reminder", {
    p_lead: lead,
    p_limit: limit,
  });

  if (error) {
    console.error(
      `[repo/email-outbox] sessions_due_for_reminder 失敗：${error.code} ${error.message}`,
    );
    return [];
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    sessionId: String(r.session_id),
    productId: String(r.product_id ?? ""),
    title: (r.title ?? {}) as Localized,
    location: (r.location ?? {}) as Localized,
    startsAt: String(r.starts_at),
    endsAt: r.ends_at == null ? null : String(r.ends_at),
  }));
}

// -----------------------------------------------------------------------------
// 付款成功信要用的訂單資料
// -----------------------------------------------------------------------------

export type NotifyOrder = {
  id: string;
  orderNo: string;
  customerName: string;
  total: number;
  /** 客人結帳時用的語言（0005 的 orders.locale）。信就用這個語言寫。 */
  locale: Lang;
  /** public.orders.payment_method（0005:88，0028 加了 'free'）。店家通知信要用。 */
  paymentMethod: string | null;
  /** public.orders.shipping_method（0005:86）。店家通知信要用。 */
  shippingMethod: string;
  /**
   * public.orders.created_at（ISO）。0034 加的：匯款期限是「下單 + 3 天」，
   * 而算它的地方只有一份（src/lib/checkout.ts 的 remittanceDueAt()）。
   * 用訂單自己的建立時間、不是 `new Date()` —— backlog 補跑時信裡的期限必須與
   * expire_unpaid_orders() 算出來的是同一個時間點。
   */
  createdAt: string;
};

export type NotifyOrderItem = {
  name: Localized;
  quantity: number;
  subtotal: number;
  /** 活動／策旅的明細才有；賣書的是 null（0020 的 order_items_session_shape）。 */
  sessionId: string | null;
};

/**
 * 付款成功信（客人）與新訂單通知信（店家，0032）共用的資料。
 *
 * ⚠️ **刻意不 select customer_email。** 地址由 0022 §7 的
 *    enqueue_order_email() 自己從 orders join，所以它不需要經過 Node。
 *    （發票那一條路不同：Amego 的 API 要求把買方信箱送過去，所以
 *    getOrderForInvoice() 有那一欄。兩條路各自只拿自己需要的。）
 *
 * payment_method / shipping_method 是 0032 加的：店家通知信要印「付款方式」
 * 「收件方式」，但兩欄都只是分類代碼（'card' / 'home' 這種），不是
 * order_addresses 裡的完整地址或電話——選這兩欄進來不算多拿個資。
 */
export async function getOrderForNotify(
  orderId: string,
): Promise<{ order: NotifyOrder; items: NotifyOrderItem[] } | null> {
  const db = supabaseAdmin();
  const [orderRes, itemsRes] = await Promise.all([
    db
      .from("orders")
      .select(
        "id, order_no, customer_name, total, locale, payment_method, shipping_method, created_at",
      )
      .eq("id", orderId)
      .maybeSingle(),
    db
      .from("order_items")
      .select("name, quantity, subtotal, session_id")
      .eq("order_id", orderId)
      .order("id", { ascending: true }),
  ]);

  if (orderRes.error) {
    console.error(
      `[repo/email-outbox] 讀訂單失敗 order=${orderId}：${orderRes.error.code} ${orderRes.error.message}`,
    );
    return null;
  }
  if (!orderRes.data) return null;
  if (itemsRes.error) {
    console.error(
      `[repo/email-outbox] 讀訂單明細失敗 order=${orderId}：${itemsRes.error.code} ${itemsRes.error.message}`,
    );
    return null;
  }

  const o = orderRes.data as Record<string, unknown>;
  const rawLocale = String(o.locale ?? "zh");
  const locale: Lang = rawLocale === "en" || rawLocale === "ja" ? rawLocale : "zh";

  return {
    order: {
      id: String(o.id),
      orderNo: String(o.order_no ?? ""),
      customerName: String(o.customer_name ?? ""),
      total: Number(o.total ?? 0),
      locale,
      paymentMethod: o.payment_method == null ? null : String(o.payment_method),
      shippingMethod: String(o.shipping_method ?? "none"),
      createdAt: String(o.created_at ?? ""),
    },
    items: ((itemsRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
      name: (r.name ?? {}) as Localized,
      quantity: Number(r.quantity ?? 0),
      subtotal: Number(r.subtotal ?? 0),
      sessionId: r.session_id == null ? null : String(r.session_id),
    })),
  };
}

/**
 * 一批訂單各自是用什麼語言下的。
 *
 * 提醒信要用**下單時的語言**寫（一個用日文結帳的客人收到中文提醒信等於沒收到），
 * 而名單那個 view 沒有 locale —— 它是 0021 建的，加欄位就得改那一支 migration。
 * 這裡另外查一次 orders 換來的是不動 0021。
 *
 * ⚠️ 只 select id 與 locale。orders 那一列還有訂購人的姓名、電話與信箱，
 *    `select("*")` 會把它們全部拉進 Node 的記憶體 —— 而這支函式只需要一個語言碼。
 */
export async function loadOrderLocales(orderIds: string[]): Promise<Map<string, Lang>> {
  const out = new Map<string, Lang>();
  if (orderIds.length === 0) return out;

  const { data, error } = await supabaseAdmin()
    .from("orders")
    .select("id, locale")
    .in("id", orderIds);

  if (error) {
    console.error(`[repo/email-outbox] 讀訂單語言失敗：${error.code} ${error.message}`);
    return out;
  }

  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const raw = String(row.locale ?? "zh");
    out.set(String(row.id), raw === "en" || raw === "ja" ? raw : "zh");
  }
  return out;
}

/**
 * 一張訂單的 public_token（0034）。
 *
 * ⚠️ 刻意**不**併進 getOrderForNotify()：那支的回傳值同時餵給客人的信與**店家的**
 *    通知信，而 public_token 是那張訂單的鑰匙（0005：「Unguessable order lookup key
 *    for guests」）。把它放進共用的 NotifyOrder 裡，等於讓每一條用得到那支函式的
 *    路徑都拿得到它——包括店家那封信的組裝程式碼。型別上拿不到，就不會有人不小心
 *    把它印進一封寄給別人的信裡。
 *
 * 只有匯款資訊信用得到它（信裡那條「回訂單頁填末五碼」的連結）。
 *
 * 讀不到就回 null（不 throw）：呼叫端跑在結帳的成功路徑上，規約是絕不拖垮訂單成立。
 */
export async function getOrderPublicToken(orderId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("orders")
    .select("public_token")
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error(
      `[repo/email-outbox] 讀 public_token 失敗 order=${orderId}：${error.code} ${error.message}`,
    );
    return null;
  }
  const token = (data as { public_token?: unknown } | null)?.public_token;
  return typeof token === "string" && token !== "" ? token : null;
}

// -----------------------------------------------------------------------------
// 出貨通知信要用的訂單資料
// -----------------------------------------------------------------------------

export type ShippedOrderAddress = {
  recipient: string;
  postalCode: string;
  city: string;
  district: string;
  street: string;
  cvsStoreName: string;
  cvsStoreId: string;
  cvsAddress: string;
};

/**
 * 出貨通知信（客人）要的資料：訂單基本欄位、明細、shipping 地址那一列。
 *
 * ⚠️ 與 getOrderForNotify() 一樣**不 select customer_email**（地址由
 *    enqueue_order_email() 自己 join）。order_addresses 的 phone 也不選——信裡
 *    不印電話。地址本身會進這封信（寄給填它的那個人自己），30 天後隨內文被
 *    purge_sent_email_bodies() 清掉。
 *
 * 讀不到訂單回 null；讀不到地址只讓 address 是 null（信照寄，少一區）。
 */
export async function getOrderForShippedEmail(orderId: string): Promise<{
  order: { orderNo: string; customerName: string; locale: Lang; shippingMethod: string };
  items: { name: Localized; quantity: number; subtotal: number }[];
  address: ShippedOrderAddress | null;
} | null> {
  const db = supabaseAdmin();
  const [orderRes, itemsRes, addrRes] = await Promise.all([
    db
      .from("orders")
      .select("id, order_no, customer_name, locale, shipping_method")
      .eq("id", orderId)
      .maybeSingle(),
    db
      .from("order_items")
      .select("name, quantity, subtotal")
      .eq("order_id", orderId)
      .order("id", { ascending: true }),
    db
      .from("order_addresses")
      .select(
        "recipient, postal_code, city, district, street, cvs_store_id, cvs_store_name, cvs_address",
      )
      .eq("order_id", orderId)
      .eq("type", "shipping")
      .maybeSingle(),
  ]);

  if (orderRes.error) {
    console.error(
      `[repo/email-outbox] 出貨信讀訂單失敗 order=${orderId}：${orderRes.error.code} ${orderRes.error.message}`,
    );
    return null;
  }
  if (!orderRes.data) return null;
  if (itemsRes.error) {
    console.error(
      `[repo/email-outbox] 出貨信讀明細失敗 order=${orderId}：${itemsRes.error.code} ${itemsRes.error.message}`,
    );
    return null;
  }
  if (addrRes.error) {
    console.error(
      `[repo/email-outbox] 出貨信讀地址失敗 order=${orderId}：${addrRes.error.code} ${addrRes.error.message}`,
    );
  }

  const o = orderRes.data as Record<string, unknown>;
  const rawLocale = String(o.locale ?? "zh");
  const locale: Lang = rawLocale === "en" || rawLocale === "ja" ? rawLocale : "zh";
  const a = (addrRes.error ? null : addrRes.data) as Record<string, unknown> | null;
  const str = (v: unknown) => (v == null ? "" : String(v).trim());

  return {
    order: {
      orderNo: String(o.order_no ?? ""),
      customerName: String(o.customer_name ?? ""),
      locale,
      shippingMethod: String(o.shipping_method ?? "none"),
    },
    items: ((itemsRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
      name: (r.name ?? {}) as Localized,
      quantity: Number(r.quantity ?? 0),
      subtotal: Number(r.subtotal ?? 0),
    })),
    address: a
      ? {
          recipient: str(a.recipient),
          postalCode: str(a.postal_code),
          city: str(a.city),
          district: str(a.district),
          street: str(a.street),
          cvsStoreName: str(a.cvs_store_name),
          cvsStoreId: str(a.cvs_store_id),
          cvsAddress: str(a.cvs_address),
        }
      : null,
  };
}

/**
 * site_settings.contact_email（給出貨通知信的「聯絡我們」）。**不 throw**，讀不到回
 * null——那只讓信裡少一列，不該讓信排不進去。
 */
export async function getShopContactEmail(): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("site_settings")
    .select("contact_email")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.error(`[repo/email-outbox] 讀 contact_email 失敗：${error.code} ${error.message}`);
    return null;
  }
  const v = (data as { contact_email?: unknown } | null)?.contact_email;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
