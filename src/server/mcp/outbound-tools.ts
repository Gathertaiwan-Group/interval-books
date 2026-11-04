/**
 * MCP 工具 —— 「對外動作」（階段 C）：重寄訂單信、重新開立發票、申請作廢發票。
 *
 * ── 三條共通規矩 ───────────────────────────────────────────────────────────
 *   1. 每一支都預設 dry_run=true；預覽與實際都 writeMcpAudit（預覽記 dry_run=true）。
 *   2. 走後台／排程**同一支**既有函式，不自己打外部服務：
 *        寄信  → src/lib/email-templates 的 render*Email ＋ src/server/repos/email-outbox 的 enqueue_*
 *                （0022／0032 的 SQL 自己 join 收件地址）→ src/server/notify 的 flushEmailOutbox()
 *        發票  → src/server/invoice-issuer 的 reissueInvoiceForOrder()（後台「重新開立發票」那一支，
 *                Amego 經固定 IP 中繼）
 *        作廢  → **不呼叫**。只在 mcp_audit_log 記一筆申請，後台首頁與訂單內頁顯示待辦，人按既有的
 *                「作廢發票」（src/lib/mcp-void-requests.ts 寫著「待處理」的唯一定義）。
 *   3. 不回任何收件地址。預覽只回「幾位收件人」。
 *
 * ── 寄給客人：兩步確認 ─────────────────────────────────────────────────────
 * send_to_customer=true 時，第一次呼叫（不論 dry_run）**不寄**，只回收件人數、主旨與摘要、以及一次性
 * confirm_token。第二次帶同樣參數＋confirm_token＋dry_run=false 才寄。token 是
 * HMAC-SHA256（金鑰由 env.ts#mcpConfirmSecret() 以固定標籤派生），綁定：工具名、參數雜湊、
 * 信件內容雜湊、收件人集合雜湊（明文地址排序後雜湊，地址本身不出現在 token 裡）、10 分鐘到期。
 * 一次性：驗過之後先 consumeOnce（mcp_oauth_used_codes，主鍵衝突＝用過）才排信；排信的 dedupe_key
 * 也含 jti，所以就算同一個 token 被併發送兩次，email_outbox 的 unique 仍只會留一封。
 *
 * ── 不做 ──────────────────────────────────────────────────────────────────
 * cancel_order：這個站沒有「取消單一訂單並釋放名額／庫存」的既有 RPC（orders.status='cancelled' 唯一
 * 入口是排程的 expire_unpaid_orders()，0035 §1.6 已確認；admin_delete_order 是刪除不是取消）。規格是
 * 「沒有就不要自建」，所以這裡沒有這支。
 *
 * 模組載入時不碰 Supabase：所有 repo 都在 handler 裡 dynamic import（同 admin-read-tools.ts）。
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod4";
import { jsonText, McpInputError, stableStringify, type TextResult } from "./core";

/* ------------------------------------------------------------------ 確認碼 */

export const CONFIRM_TTL_SECONDS = 10 * 60;
const CONFIRM_LABEL = "interval-books/mcp-outbound-confirm/v1";

export type ConfirmClaims = {
  v: 1;
  /** 工具名 */
  t: string;
  /** 參數雜湊 */
  a: string;
  /** 信件內容雜湊 */
  c: string;
  /** 收件人集合雜湊 */
  r: string;
  exp: number;
  jti: string;
};

export type ConfirmBinding = Pick<ConfirmClaims, "t" | "a" | "c" | "r">;

export type ConfirmVerify =
  | { ok: true; jti: string; exp: number }
  | {
      ok: false;
      reason:
        | "malformed"
        | "bad_signature"
        | "expired"
        | "wrong_tool"
        | "params_changed"
        | "content_changed"
        | "recipients_changed";
    };

const b64url = (b: Buffer) => b.toString("base64url");

function confirmKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(CONFIRM_LABEL).digest();
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 收件人集合雜湊：小寫、去空白、去重、排序。空集合也有固定的雜湊。 */
export function recipientsHash(emails: readonly string[]): string {
  const norm = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].sort();
  return sha256Hex(`recipients|${norm.join("\n")}`);
}

export function signConfirmToken(
  secret: string,
  binding: ConfirmBinding,
  nowSec: number,
): { token: string; exp: number; jti: string } {
  const exp = nowSec + CONFIRM_TTL_SECONDS;
  const jti = randomUUID();
  const claims: ConfirmClaims = { v: 1, ...binding, exp, jti };
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = b64url(createHmac("sha256", confirmKey(secret)).update(payload).digest());
  return { token: `${payload}.${sig}`, exp, jti };
}

export function verifyConfirmToken(
  secret: string,
  token: string,
  expected: ConfirmBinding,
  nowSec: number,
): ConfirmVerify {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts;
  const want = createHmac("sha256", confirmKey(secret)).update(payload).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return { ok: false, reason: "bad_signature" };
  }
  let claims: ConfirmClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ConfirmClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (claims?.v !== 1 || typeof claims.jti !== "string" || typeof claims.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp <= nowSec) return { ok: false, reason: "expired" };
  if (claims.t !== expected.t) return { ok: false, reason: "wrong_tool" };
  if (claims.a !== expected.a) return { ok: false, reason: "params_changed" };
  if (claims.c !== expected.c) return { ok: false, reason: "content_changed" };
  if (claims.r !== expected.r) return { ok: false, reason: "recipients_changed" };
  return { ok: true, jti: claims.jti, exp: claims.exp };
}

const REJECT_TEXT: Record<Exclude<ConfirmVerify, { ok: true }>["reason"] | "replayed", string> = {
  malformed: "confirm_token 格式不正確。",
  bad_signature: "confirm_token 不是這個伺服器簽發的（或被改過）。",
  expired: "confirm_token 已過期（10 分鐘）。",
  wrong_tool: "confirm_token 不是給這支工具的。",
  params_changed: "參數和取得 confirm_token 時不一樣（訂單、信件種類或場次被改了）。",
  content_changed: "信件內容在預覽之後變了。",
  recipients_changed: "收件人在預覽之後變了。",
  replayed: "這個 confirm_token 已經用過了（一次性）。",
};

/* ------------------------------------------------------------------ 共用 */

const OUTBOUND: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const dryRunArg = z
  .boolean()
  .default(true)
  .describe("預設 true：只預覽、不做任何事。確認後以 false 再呼叫一次才會真的執行。");

const orderArg = z.string().trim().min(1).max(64).describe("訂單 id（uuid）或訂單編號（order_no）");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EMAIL_KINDS = ["order_paid", "remittance", "session_reminder"] as const;
type EmailKind = (typeof EMAIL_KINDS)[number];

const KIND_LABEL: Record<EmailKind, string> = {
  order_paid: "付款成功／訂單確認信",
  remittance: "匯款付款通知信（匯款資訊）",
  session_reminder: "活動行前通知信（場次提醒）",
};

export const OUTBOUND_TOOL_INPUTS = {
  resend_order_email: z.object({
    order: orderArg,
    kind: z
      .enum(EMAIL_KINDS)
      .describe(
        "order_paid 付款成功／訂單確認信（訂單須已付款）／remittance 匯款資訊信（匯款且尚未付款）／" +
          "session_reminder 活動行前通知（寄給這張訂單在簽到表上、有留信箱的每位參加者）",
      ),
    session_id: z
      .string()
      .trim()
      .uuid()
      .optional()
      .describe("只給 session_reminder：只寄這個場次的參加者；省略＝這張訂單的所有場次"),
    send_to_customer: z
      .boolean()
      .default(false)
      .describe(
        "預設 false：只寄一份副本到管理員信箱（site_settings.notify_emails）。true＝寄給客人，必須兩步確認。",
      ),
    confirm_token: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe("寄給客人的第二步：帶上第一步回傳的 confirm_token（一次性、10 分鐘內有效）"),
    dry_run: dryRunArg,
  }),
  reissue_invoice: z.object({ order: orderArg, dry_run: dryRunArg }),
  request_invoice_void: z.object({
    order: orderArg,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .describe("作廢原因（1–20 字，同後台「作廢發票」的規則）"),
    dry_run: dryRunArg,
  }),
} as const;

export type OutboundToolName = keyof typeof OUTBOUND_TOOL_INPUTS;
type Args<N extends OutboundToolName> = z.output<(typeof OUTBOUND_TOOL_INPUTS)[N]>;

export const OUTBOUND_TOOL_META: Record<
  OutboundToolName,
  { title: string; description: string; annotations: ToolAnnotations }
> = {
  resend_order_email: {
    title: "重寄訂單信",
    description:
      "重寄一封既有的訂單信（付款成功／訂單確認、匯款資訊、活動行前通知），用的是站上同一套信件模板。" +
      "預設只寄一份副本到管理員信箱；send_to_customer=true 才寄給客人，而且要兩步：" +
      "第一次呼叫只回收件人數、主旨與摘要、confirm_token（不寄）；確認後帶同樣參數＋confirm_token＋dry_run=false 再呼叫一次才寄。" +
      "不會回傳任何收件地址。預設 dry_run=true。",
    annotations: OUTBOUND,
  },
  reissue_invoice: {
    title: "重新開立發票",
    description:
      "與後台訂單內頁「重新開立發票」同一支流程（先向光貿查詢是否已開過，開過就補登號碼、不重開；沒開過才開）。" +
      "dry_run=true（預設）只回目前發票狀態與「後台按鈕此刻會不會出現」的判斷，不打光貿。" +
      "只有後台按鈕會出現的訂單（已付款、金額 > 0、開立失敗或付款超過 24 小時仍未開出）才會真的執行。",
    annotations: { ...OUTBOUND, idempotentHint: true },
  },
  request_invoice_void: {
    title: "申請作廢發票",
    description:
      "**不會作廢發票。** 只在後台留一筆「MCP 申請作廢待處理」（後台首頁與訂單內頁看得到），由人到訂單內頁按既有的「作廢發票」。" +
      "發票必須是已開立、有號碼。同一張已有待處理的申請時不會重複建立。預設 dry_run=true。",
    annotations: { ...OUTBOUND, openWorldHint: false, idempotentHint: true },
  },
};

/* ------------------------------------------------------------------ 內部 */

type OrderRow = {
  id: string;
  order_no: string;
  status: string;
  payment_status: string;
  payment_method: string | null;
  total: number;
  paid_at: string | null;
  notify_customer: boolean;
  /** 只拿來算收件人雜湊，**絕不回傳**。 */
  customer_email: string | null;
};

async function loadOrder(ref: string): Promise<OrderRow> {
  const { supabaseAdmin } = await import("@/server/supabase-admin");
  const q = supabaseAdmin()
    .from("orders")
    .select(
      "id, order_no, status, payment_status, payment_method, total, paid_at, notify_customer, customer_email",
    );
  const { data, error } = await (UUID_RE.test(ref) ? q.eq("id", ref) : q.eq("order_no", ref))
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`讀訂單失敗：${error.code ?? "error"}`);
  if (!data) throw new McpInputError(`找不到訂單「${ref}」。請先用 list_orders／get_order 查。`);
  const r = data as Record<string, unknown>;
  return {
    id: String(r.id),
    order_no: String(r.order_no ?? ""),
    status: String(r.status ?? ""),
    payment_status: String(r.payment_status ?? ""),
    payment_method: r.payment_method == null ? null : String(r.payment_method),
    total: Number(r.total ?? 0),
    paid_at: r.paid_at == null ? null : String(r.paid_at),
    notify_customer: r.notify_customer !== false,
    customer_email: typeof r.customer_email === "string" ? r.customer_email : null,
  };
}

async function audit(entry: {
  tool: OutboundToolName;
  entity_id: string;
  action: string;
  changes: Record<string, unknown>;
  dry_run: boolean;
}): Promise<"recorded" | "log_only"> {
  const { writeMcpAudit } = await import("./audit");
  return writeMcpAudit({ entity: "order", ...entry });
}

async function actorLabel(): Promise<string> {
  const { currentMcpActor } = await import("./actor");
  const a = currentMcpActor();
  if (!a) return "mcp";
  return a.via === "oauth" ? `mcp:${a.email}` : `mcp:${a.via}`;
}

/**
 * 給 AI 看的預覽摘要：**只有**信件的開頭段落（標題另外回）。
 *
 * 🔴 匯款資訊信的內文有店家匯款帳戶（戶名／銀行／代號／帳號），那些不能回給 AI
 *    （2026-11-03 審查）。所以：只取第一段、再把 redact 裡的值（建信時登記的帳戶欄位）
 *    與任何 6 位以上的連續數字一律遮掉——開頭段落理論上不含帳戶，這兩道是保險。
 */
function summaryOf(text: string, redact: readonly string[] = []): string {
  const first = (text.split(/\n\s*\n/).find((p) => p.trim()) ?? "").replace(/\s+/g, " ").trim();
  let s = first;
  for (const v of redact) {
    const t = v.trim();
    if (t) s = s.split(t).join("＊＊＊");
  }
  s = s.replace(/\d[\d\s-]{5,}\d/g, "＊＊＊");
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

type BuiltMail = {
  /** order＝寄給訂購人（enqueue_order_email）；registration＝寄給參加者（enqueue_registration_emails）。 */
  target: { type: "order" } | { type: "registration"; registrationId: string };
  subject: string;
  text: string;
  html: string;
  /** 不可出現在預覽摘要裡的值（匯款帳戶欄位）。 */
  redact?: string[];
};

/**
 * 依信件種類組出要寄的信，以及「寄給客人時」的收件地址（只用來算雜湊與人數）。
 * 渲染與資料來源逐字對應 src/server/notify.ts 的同一封信。
 */
async function buildMails(
  order: OrderRow,
  kind: EmailKind,
  sessionId: string | undefined,
): Promise<{ mails: BuiltMail[]; customerEmails: string[] }> {
  const outbox = await import("@/server/repos/email-outbox");
  const tpl = await import("@/lib/email-templates");
  const { getEventSessionById } = await import("@/server/repos/event-sessions");

  if (sessionId && kind !== "session_reminder") {
    throw new McpInputError("session_id 只給 session_reminder 用。");
  }
  const loaded = await outbox.getOrderForNotify(order.id);
  if (!loaded) throw new Error("讀不到訂單明細（getOrderForNotify）。");
  const { order: n, items } = loaded;
  const copy = await outbox.loadEmailCopy();

  const sessionIds = [...new Set(items.map((i) => i.sessionId).filter((s): s is string => !!s))];
  const briefs = new Map<string, import("@/lib/email-templates").SessionBrief>();
  for (const id of sessionIds) {
    const s = await getEventSessionById(id);
    if (s) {
      briefs.set(id, {
        title: s.title,
        location: s.location,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
      });
    }
  }
  const sessionList = sessionIds
    .map((id) => briefs.get(id))
    .filter((s): s is import("@/lib/email-templates").SessionBrief => !!s);
  const orderEmails =
    order.notify_customer && order.customer_email?.trim() ? [order.customer_email] : [];

  if (kind === "order_paid") {
    if (order.payment_status !== "paid") {
      throw new McpInputError(`訂單 ${order.order_no} 尚未付款，沒有「付款成功」信可以重寄。`);
    }
    const m = tpl.renderOrderPaidEmail(
      {
        orderNo: n.orderNo,
        customerName: n.customerName,
        total: n.total,
        items: items.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: i.subtotal })),
        sessions: sessionList,
      },
      copy,
      n.locale,
    );
    return { mails: [{ target: { type: "order" }, ...m }], customerEmails: orderEmails };
  }

  if (kind === "remittance") {
    if (order.payment_method !== "transfer") {
      throw new McpInputError(`訂單 ${order.order_no} 不是匯款訂單，沒有匯款資訊信。`);
    }
    if (order.payment_status === "paid" || order.status === "cancelled") {
      throw new McpInputError(`訂單 ${order.order_no} 已付款或已取消，不寄匯款資訊信。`);
    }
    const { getRemittanceAccount } = await import("@/server/repos/site-settings");
    const { publicUrlFor } = await import("@/server/public-url");
    const { remittanceConfigured, remittanceDueAt } = await import("@/lib/checkout");
    const account = await getRemittanceAccount();
    if (!remittanceConfigured(account) || !account) {
      throw new McpInputError("店家沒有設定匯款帳戶，匯款資訊信不能寄。");
    }
    const token = await outbox.getOrderPublicToken(order.id);
    const orderUrl = token ? publicUrlFor("/checkout/complete", { token }) : null;
    if (!orderUrl) {
      throw new McpInputError(
        "組不出可用的訂單頁網址（SITE_URL 未設定或讀不到 public_token），匯款資訊信不寄（同 notify.ts 的規則）。",
      );
    }
    const m = tpl.renderRemittanceEmail(
      {
        orderNo: n.orderNo,
        customerName: n.customerName,
        total: n.total,
        bankName: account.bankName,
        bankCode: account.bankCode,
        bankAccount: account.bankAccount,
        accountName: account.accountName,
        dueAt: n.phoneOrder ? null : remittanceDueAt(n.createdAt),
        orderUrl,
        items: items.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: i.subtotal })),
        sessions: sessionList,
        needsContact: n.needsContact,
      },
      copy,
      n.locale,
    );
    return {
      mails: [
        {
          target: { type: "order" },
          ...m,
          redact: [account.bankName, account.bankCode, account.bankAccount, account.accountName]
            .map((v) => String(v ?? ""))
            .filter((v) => v.trim().length >= 2),
        },
      ],
      customerEmails: orderEmails,
    };
  }

  // session_reminder —— 名單一律 loadPaidRosterByOrder()（簽到表的唯一定義），同 notify.ts。
  const { loadPaidRosterByOrder, onsiteDueFor } =
    await import("@/server/repos/event-registrations");
  const roster = (await loadPaidRosterByOrder(order.id)).filter(
    (r) => r.has_email && (!sessionId || r.session_id === sessionId) && briefs.has(r.session_id),
  );
  if (roster.length === 0) {
    throw new McpInputError(
      `訂單 ${order.order_no} 沒有在簽到表上、留了信箱的參加者${sessionId ? "（這個場次）" : ""}，沒有行前通知可寄。`,
    );
  }
  const mails: BuiltMail[] = roster.map((row) => {
    const m = tpl.renderSessionReminderEmail(
      {
        participantName: row.name,
        seatNo: row.seat_no,
        orderNo: row.order_no,
        session: briefs.get(row.session_id)!,
        // 0059：與排程寄的行前提醒同一個規則——現場付款未收款的人印這位的票價＋該場次合計。
        onsiteDue: onsiteDueFor(row, "session"),
      },
      copy,
      n.locale,
    );
    return { target: { type: "registration", registrationId: row.registration_id }, ...m };
  });
  let customerEmails: string[] = [];
  if (order.notify_customer) {
    const { loadRegistrationEmails } = await import("@/server/repos/registration-emails");
    customerEmails = await loadRegistrationEmails(roster.map((r) => r.registration_id));
  }
  return { mails, customerEmails };
}

function contentHash(mails: readonly BuiltMail[]): string {
  return sha256Hex(
    stableStringify(
      mails.map((m) => ({ target: m.target, subject: m.subject, text: m.text, html: m.html })),
    ),
  );
}

function previewOf(mails: readonly BuiltMail[]) {
  return {
    mail_count: mails.length,
    subject: mails[0]?.subject ?? null,
    summary: mails[0] ? summaryOf(mails[0].text, mails[0].redact) : null,
  };
}

async function flushBestEffort(): Promise<void> {
  try {
    const { flushEmailOutbox } = await import("@/server/notify");
    await flushEmailOutbox();
  } catch (err) {
    // 信已經在 email_outbox 裡，排程（/api/tasks/notify）會寄出；這裡失敗不算工具失敗。
    console.error(`[mcp-outbound] flush 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ------------------------------------------------------------------ 實作 */

type Handlers = { [N in OutboundToolName]: (args: Args<N>) => Promise<TextResult> };

export const OUTBOUND_HANDLERS: Handlers = {
  /* ============================================================ 重寄訂單信 */
  async resend_order_email(args) {
    const tool = "resend_order_email" as const;
    const order = await loadOrder(args.order);
    const { mails, customerEmails } = await buildMails(order, args.kind, args.session_id);
    const preview = previewOf(mails);
    const base = {
      order_id: order.id,
      order_no: order.order_no,
      kind: args.kind,
      kind_label: KIND_LABEL[args.kind],
    };

    /* ---------- 只寄管理員 ---------- */
    if (!args.send_to_customer) {
      if (args.confirm_token) {
        throw new McpInputError("confirm_token 只用在 send_to_customer=true。");
      }
      const { supabaseAdmin } = await import("@/server/supabase-admin");
      const { parseRecipients } = await import("@/lib/email-templates");
      const { data: s, error } = await supabaseAdmin()
        .from("site_settings")
        .select("notify_emails")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw new Error(`讀管理員信箱設定失敗：${error.code ?? "error"}`);
      const adminCount = parseRecipients(
        (s as { notify_emails?: string } | null)?.notify_emails,
      ).length;
      const changes = {
        target: "admin",
        kind: args.kind,
        order_no: order.order_no,
        recipient_count: adminCount,
        subject: preview.subject,
      };
      if (args.dry_run) {
        const a = await audit({
          tool,
          entity_id: order.id,
          action: "email_resend_preview",
          changes,
          dry_run: true,
        });
        return jsonText({
          ...base,
          dry_run: true,
          sent: false,
          recipients: "管理員信箱（site_settings.notify_emails）",
          recipient_count: adminCount,
          customer_recipient_count: customerEmails.length,
          preview,
          audit: a,
          next_step:
            adminCount === 0
              ? "管理員信箱沒有設定（後台 設定 → 通知信箱），寄不出去。"
              : "這只是預覽。用同樣參數加 dry_run=false 再呼叫一次，會寄一份副本到管理員信箱（客人收不到）。",
        });
      }
      if (adminCount === 0) {
        throw new McpInputError("管理員信箱（site_settings.notify_emails）是空的，沒有地方可寄。");
      }
      const tpl = await import("@/lib/email-templates");
      const first = mails[0];
      const note = `這是用 MCP 重寄的副本，只寄到管理員信箱，客人沒有收到。原本會寄給 ${customerEmails.length} 位收件人${mails.length > 1 ? `（共 ${mails.length} 封，這是第 1 封）` : ""}。`;
      const { enqueueAdminOrderEmail } = await import("@/server/repos/email-outbox");
      const queued = await enqueueAdminOrderEmail({
        dedupeKey: `mcp_resend_admin:${args.kind}:${order.id}:${randomUUID()}`,
        subject: `[重寄副本・管理員] ${first.subject}`,
        text: `${note}\n\n${first.text}`,
        html: `<p>${tpl.escapeHtml(note)}</p><hr>${first.html}`,
      });
      if (queued) await flushBestEffort();
      const a = await audit({
        tool,
        entity_id: order.id,
        action: "email_resend",
        changes: { ...changes, queued: queued ? 1 : 0 },
        dry_run: false,
      });
      return jsonText({
        ...base,
        dry_run: false,
        sent: queued,
        recipients: "管理員信箱（site_settings.notify_emails）",
        recipient_count: adminCount,
        audit: a,
        message: queued
          ? "已排入寄件匣並嘗試立即寄出（若沒立刻寄出，排程會在幾分鐘內補寄）。"
          : "沒有排進寄件匣（管理員信箱為空或資料庫錯誤），請看伺服器 log。",
      });
    }

    /* ---------- 寄給客人：兩步確認 ---------- */
    if (customerEmails.length === 0) {
      throw new McpInputError(
        "這封信沒有可寄的客人收件人（沒有留信箱，或後台電話報名設定為不寄信給客人）。",
      );
    }
    const { mcpConfirmSecret } = await import("@/server/env");
    const secret = mcpConfirmSecret();
    if (!secret) {
      throw new McpInputError(
        "伺服器沒有設定確認碼用的祕密（MCP_OAUTH_SECRET 或 MCP_TOKEN），不能寄信給客人。",
      );
    }
    const binding: ConfirmBinding = {
      t: tool,
      a: sha256Hex(
        stableStringify({
          order_id: order.id,
          kind: args.kind,
          session_id: args.session_id ?? null,
          send_to_customer: true,
        }),
      ),
      c: contentHash(mails),
      r: recipientsHash(customerEmails),
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const changesBase = {
      target: "customer",
      kind: args.kind,
      order_no: order.order_no,
      recipient_count: customerEmails.length,
      subject: preview.subject,
    };

    if (args.dry_run || !args.confirm_token) {
      const issued = signConfirmToken(secret, binding, nowSec);
      const a = await audit({
        tool,
        entity_id: order.id,
        action: "email_resend_preview",
        changes: changesBase,
        dry_run: true,
      });
      return jsonText({
        ...base,
        dry_run: true,
        sent: false,
        recipients: "客人",
        recipient_count: customerEmails.length,
        preview,
        confirm_token: issued.token,
        confirm_token_expires_at: new Date(issued.exp * 1000).toISOString(),
        audit: a,
        next_step:
          "還沒有寄。請把收件人數與內容給使用者確認；確認後用**完全相同的參數**加上 confirm_token 與 dry_run=false 再呼叫一次才會寄出。" +
          "confirm_token 一次性、10 分鐘內有效。",
      });
    }

    const v = verifyConfirmToken(secret, args.confirm_token, binding, nowSec);
    let reject: keyof typeof REJECT_TEXT | null = v.ok ? null : v.reason;
    if (v.ok) {
      const { dbOAuthStore } = await import("./oauth-store");
      const fresh = await dbOAuthStore.consumeOnce(`mcp_confirm:${v.jti}`, v.exp);
      if (!fresh) reject = "replayed";
    }
    if (reject || !v.ok) {
      const why = reject ?? "malformed";
      await audit({
        tool,
        entity_id: order.id,
        action: "email_resend_rejected",
        changes: { ...changesBase, reason: why },
        dry_run: false,
      });
      throw new McpInputError(
        `沒有寄出：${REJECT_TEXT[why]}請重新用 dry_run=true 取得新的 confirm_token。`,
      );
    }

    const outbox = await import("@/server/repos/email-outbox");
    let queued = 0;
    let failed = 0;
    const orderMails = mails.filter((m) => m.target.type === "order");
    for (const m of orderMails) {
      const r = await outbox.enqueueOrderEmailResult({
        orderId: order.id,
        dedupeKey: `mcp_resend:${args.kind}:${order.id}:${v.jti}`,
        subject: m.subject,
        text: m.text,
        html: m.html,
      });
      if (r === "queued") queued += 1;
      else if (r === "error") failed += 1;
    }
    const regItems = mails.flatMap((m) =>
      m.target.type === "registration"
        ? [
            {
              registrationId: m.target.registrationId,
              dedupeKey: `mcp_resend:${args.kind}:${m.target.registrationId}:${v.jti}`,
              subject: m.subject,
              text: m.text,
              html: m.html,
            },
          ]
        : [],
    );
    if (regItems.length > 0) queued += await outbox.enqueueRegistrationEmails(regItems);
    if (queued > 0) await flushBestEffort();
    const a = await audit({
      tool,
      entity_id: order.id,
      action: "email_resend",
      changes: { ...changesBase, queued, failed },
      dry_run: false,
    });
    return jsonText({
      ...base,
      dry_run: false,
      sent: queued > 0,
      queued,
      recipients: "客人",
      recipient_count: customerEmails.length,
      audit: a,
      message:
        queued === mails.length
          ? "已排入寄件匣並嘗試立即寄出（若沒立刻寄出，排程會在幾分鐘內補寄）。"
          : `只排進 ${queued} / ${mails.length} 封（其餘可能是收件人已移除或資料庫錯誤），請到後台確認。`,
    });
  },

  /* ============================================================ 重新開立發票 */
  async reissue_invoice(args) {
    const tool = "reissue_invoice" as const;
    const order = await loadOrder(args.order);
    const { supabaseAdmin } = await import("@/server/supabase-admin");
    const { data, error } = await supabaseAdmin()
      .from("invoices")
      .select("status, retry_count, updated_at, invoice_number, error_message")
      .eq("order_id", order.id)
      .maybeSingle();
    if (error) throw new Error(`讀發票失敗：${error.code ?? "error"}`);
    const inv = data as {
      status: string;
      retry_count: number | null;
      updated_at: string | null;
      invoice_number: string | null;
      error_message: string | null;
    } | null;
    const { canReissueInvoice, invoiceStatusLabel } = await import("@/lib/invoice-alerts");
    const { INVOICE_MAX_RETRIES } = await import("@/server/repos/invoices");
    const { amegoConfigured } = await import("@/server/amego");
    const status = inv?.status ?? "missing";
    const retry = Number(inv?.retry_count ?? 0);
    const can = canReissueInvoice(
      { paymentStatus: order.payment_status, total: order.total, paidAt: order.paid_at },
      inv ? { status, retryCount: retry, updatedAt: inv.updated_at } : null,
      new Date(),
      INVOICE_MAX_RETRIES,
    );
    const current = {
      payment_status: order.payment_status,
      total: order.total,
      paid_at: order.paid_at,
      invoice_status: status,
      invoice_status_label: invoiceStatusLabel(status, retry, INVOICE_MAX_RETRIES),
      invoice_number: inv?.invoice_number ?? null,
      retry_count: retry,
      last_error: inv?.error_message ?? null,
    };
    const base = { order_id: order.id, order_no: order.order_no, current, can_reissue: can };
    const why = can
      ? null
      : order.payment_status !== "paid"
        ? "訂單尚未付款"
        : !(order.total > 0)
          ? "金額為 0，不開發票"
          : status === "issued"
            ? "發票已開立"
            : status === "voided"
              ? "發票已作廢，不會自動重開"
              : status === "issuing"
                ? "正在開立中"
                : "還在自動重試期間（付款未滿 24 小時且未停止重試），後台按鈕不會出現";

    if (args.dry_run) {
      const a = await audit({
        tool,
        entity_id: order.id,
        action: "invoice_reissue",
        changes: { order_no: order.order_no, can_reissue: can, invoice_status: status },
        dry_run: true,
      });
      return jsonText({
        ...base,
        dry_run: true,
        invoice_service_configured: amegoConfigured(),
        would: can
          ? (status === "failed" ? "把重試次數設回 1，然後" : "") +
            "先向光貿查詢這張訂單是否已開過：開過就補登號碼、不重開；沒開過才開一張新的（經固定 IP 中繼）。"
          : `不會執行：${why}。`,
        audit: a,
        next_step: can ? "確認後用 dry_run=false 再呼叫一次。" : undefined,
      });
    }

    if (!can) throw new McpInputError(`不重新開立：${why}。`);
    const { reissueInvoiceForOrder } = await import("@/server/invoice-issuer");
    const result = await reissueInvoiceForOrder(order.id, await actorLabel());
    const a = await audit({
      tool,
      entity_id: order.id,
      action: "invoice_reissue",
      changes: { order_no: order.order_no, result },
      dry_run: false,
    });
    return jsonText({ ...base, dry_run: false, result, audit: a });
  },

  /* ============================================================ 申請作廢發票 */
  async request_invoice_void(args) {
    const tool = "request_invoice_void" as const;
    const { normalizeVoidReason, canVoidInvoice } = await import("@/lib/invoice-void");
    const reason = normalizeVoidReason(args.reason);
    if (!reason.ok) throw new McpInputError(reason.message);
    const order = await loadOrder(args.order);
    const { supabaseAdmin } = await import("@/server/supabase-admin");
    const { data, error } = await supabaseAdmin()
      .from("invoices")
      .select("status, invoice_number")
      .eq("order_id", order.id)
      .maybeSingle();
    if (error) throw new Error(`讀發票失敗：${error.code ?? "error"}`);
    const inv = data as { status: string; invoice_number: string | null } | null;
    if (!canVoidInvoice(inv)) {
      throw new McpInputError(
        `訂單 ${order.order_no} 的發票不是「已開立且有號碼」（目前：${inv?.status ?? "沒有發票"}），不能申請作廢。`,
      );
    }
    const invoiceNumber = inv!.invoice_number!;
    const { loadPendingVoidRequests } = await import("@/server/repos/mcp-void-requests");
    const existing = (await loadPendingVoidRequests({ orderId: order.id }))[0] ?? null;
    const changes = {
      order_no: order.order_no,
      invoice_number: invoiceNumber,
      reason: reason.reason,
    };
    const base = {
      order_id: order.id,
      order_no: order.order_no,
      invoice_number: invoiceNumber,
      reason: reason.reason,
      voided: false,
      note: "這支工具不會作廢發票；作廢要由人到後台訂單內頁按「作廢發票」。",
    };

    if (args.dry_run) {
      const a = await audit({
        tool,
        entity_id: order.id,
        action: "invoice_void_request",
        changes,
        dry_run: true,
      });
      return jsonText({
        ...base,
        dry_run: true,
        already_pending: existing
          ? { requested_at: existing.requested_at, reason: existing.reason }
          : null,
        would: existing
          ? "已經有一筆待處理的申請，不會再建立。"
          : "在後台留一筆「MCP 申請作廢待處理」（首頁與訂單內頁顯示），不呼叫任何作廢。",
        audit: a,
        next_step: existing ? undefined : "確認後用 dry_run=false 再呼叫一次。",
      });
    }

    if (existing) {
      return jsonText({
        ...base,
        dry_run: false,
        requested: false,
        message: "這張發票已經有一筆待處理的作廢申請，沒有重複建立。",
        already_pending: { requested_at: existing.requested_at, reason: existing.reason },
      });
    }
    const a = await audit({
      tool,
      entity_id: order.id,
      action: "invoice_void_request",
      changes,
      dry_run: false,
    });
    return jsonText({
      ...base,
      dry_run: false,
      requested: a === "recorded",
      audit: a,
      message:
        a === "recorded"
          ? "已在後台留下作廢申請（後台首頁與訂單內頁會顯示），請通知管理員處理。"
          : "⚠️ 申請沒有寫進資料表（只在伺服器 log），後台看不到這筆申請。請直接通知管理員到後台作廢。",
    });
  },
};
