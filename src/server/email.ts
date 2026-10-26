/**
 * 寄信 —— Resend 的 HTTP API，裸 `fetch`，**不裝 npm 套件**。
 *
 * ── 為什麼不裝 `resend` ────────────────────────────────────────────────────
 * 與 src/server/amego.ts、src/server/payuni.ts 同一條線：核心只有一個
 * `POST /emails`，一個 Bearer header，一個 JSON body。裝一個套件換來的是多一份
 * 要跟著升級的相依、多一層看不見的重試行為（而重試這件事在這裡是 outbox 的職責，
 * 不該有第二個地方也在做），以及在 Vercel 的 bundle 裡多幾十 KB。
 * Node 內建的 fetch 就夠。快樂手也是同一個決定。
 *
 * ── 沒有 API key 時走 dry run，而且標 `'skipped'` 不是 `'sent'` ────────────
 * 本機開發、preview 部署、以及自檢，都不該把信寄到真人的信箱裡。沒有
 * `RESEND_API_KEY` 時這支函式不打任何外部請求，回 `outcome: "dry_run"`。
 *
 * ⚠️ 呼叫端（src/server/notify.ts）把 dry run 記成 `email_outbox.status =
 *    'skipped'`，**不是 'sent'**。快樂手記成 sent，理由是「本機沒有 key 時不該讓
 *    outbox 無限重試堆積」—— 那個理由成立，但代價是：一個忘了設 RESEND_API_KEY 的
 *    正式環境會顯示「全部寄出成功」，而實際上一封都沒出去。那正是這個 repo 一路在
 *    防的「綠燈但什麼都沒做」。標 skipped 一樣不會重試堆積，而且後台總覽數得出
 *    「有 N 封沒寄出去」。
 *
 * ── log 紀律 ──────────────────────────────────────────────────────────────
 * ⚠️ **這個檔案的任何 console.* 都不可以出現裸的收件地址。** 一律走
 *    maskEmail()（src/lib/email-templates.ts）。Vercel 的 log 沒有保存期限、
 *    沒有存取紀錄，也沒有任何人知道它在那裡 —— 與 0020 對 event_registrations
 *    的 log 紀律同一條理由。內文也不印，只印長度。
 *    scripts/notify-selftest.mjs 有靜態測試守著。
 *
 * ── 這個檔案不決定「要不要寄」──────────────────────────────────────────
 * 它只負責「把這一封送出去，然後誠實回報結果」。要不要寄、寄給誰、重試幾次，
 * 全部在 src/server/notify.ts 與 0022 的 email_outbox 上。
 */
import "@tanstack/react-start/server-only";
import { maskEmail, parseRecipients } from "@/lib/email-templates";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * 單次請求的上限。
 *
 * 15 秒比 amego.ts 的 15 秒同一個量級，但這裡的逾時代價低得多：一封信沒寄成會被
 * outbox 重試八次，而一張發票沒開成是法遵問題。
 */
const REQUEST_TIMEOUT_MS = 15_000;

export type SendOutcome = "sent" | "dry_run" | "failed";

export type SendResult = {
  outcome: SendOutcome;
  /** Resend 的訊息 id。dry run 與失敗時是 null。 */
  id: string | null;
  /** 失敗原因，會寫進 email_outbox.last_error 給後台看。 */
  error: string | null;
};

export type OutgoingEmail = {
  /**
   * 收件人。可以是逗號分隔的多個地址（店家的新訂單通知可能有多個收件人，見
   * src/lib/email-templates.ts 的 parseRecipients()）。單一地址時行為與過去
   * 完全相同——split(",") 在沒有逗號時就是一個元素的陣列。
   */
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * 這一封信自己的回信地址，蓋過 MAIL_REPLY_TO。目前只有異業合作表單用
   * （src/server/partnership.ts：店家按「回覆」要直接寄給填表人）。沒給就跟過去一樣。
   */
  replyTo?: string;
};

/** 寄件人。⚠️ 網域必須在 Resend 驗證過（intervalbooks.tw 已 verified）。 */
export function mailFrom(): string {
  return (process.env.MAIL_FROM ?? "").trim();
}

/**
 * 回信地址。
 *
 * 與寄件人分開是刻意的：寄件人的網域要通過 Resend 的 DKIM/SPF 驗證，而客人按
 * 「回覆」時應該寄到真人在看的信箱 —— 那兩個通常不是同一個地址。沒設就不帶
 * reply_to 欄位（Resend 會退回用 from）。
 */
export function mailReplyTo(): string {
  return (process.env.MAIL_REPLY_TO ?? "").trim();
}

/**
 * 這個環境到底寄不寄得出去。
 *
 * ⚠️ 兩個條件都要：沒有 API key 當然寄不出去，但**沒有 MAIL_FROM 也一樣** ——
 *    Resend 對空的 from 會回 422，那會讓每一封信都燒掉八次重試才被標成 failed。
 *    在這裡就判掉，走 dry run，outbox 標 skipped，一眼看得出是設定沒到位。
 */
export function emailConfigured(): boolean {
  return Boolean((process.env.RESEND_API_KEY ?? "").trim()) && Boolean(mailFrom());
}

/**
 * 送出一封信。**永不 throw** —— 呼叫端在 outbox 的流程裡，它需要的是一個結果，
 * 不是一個例外（與 amego.ts 的 issueInvoice 同一個契約）。
 */
export async function sendEmail(message: OutgoingEmail): Promise<SendResult> {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const from = mailFrom();

  if (!apiKey || !from) {
    // 內文不進 log，只印長度：內文裡有姓名、場次與訂單編號。
    console.info(
      `[email] dry run（${!apiKey ? "沒有 RESEND_API_KEY" : "沒有 MAIL_FROM"}）` +
        ` to=${maskEmail(message.to)} text=${message.text.length} html=${message.html.length}`,
    );
    return { outcome: "dry_run", id: null, error: null };
  }

  const replyTo = (message.replyTo ?? "").trim() || mailReplyTo();

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        // parseRecipients()：Resend 的 to 是陣列，每個元素要是單一地址。單一
        // 地址（沒有逗號）拆出來還是一個元素的陣列，行為與過去逐字相同。
        to: parseRecipients(message.to),
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      // AbortSignal.timeout 而不是自己接 AbortController：Node 18 起內建，
      // 而且不會留下一個要 clearTimeout 的 timer（amego.ts 那支比這裡早寫）。
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const bodyText = await response.text();

    if (!response.ok) {
      // Resend 的錯誤 body 不含收件者資料（只有錯誤碼與說明），留著協助排查。
      // 截 300 字：last_error 欄位會寫進資料庫並顯示在後台。
      const error = `HTTP ${response.status} ${bodyText.slice(0, 300)}`;
      console.error(`[email] 寄送失敗 to=${maskEmail(message.to)} ${error}`);
      return { outcome: "failed", id: null, error };
    }

    let id: string | null = null;
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (typeof parsed === "object" && parsed !== null) {
        const maybeId: unknown = (parsed as Record<string, unknown>).id;
        if (typeof maybeId === "string") id = maybeId;
      }
    } catch {
      // 寄成功但 body 解析失敗不影響結果 —— 信已經出去了，只是我們沒拿到 id。
      // 絕對不可以因此回 failed：那會讓同一封信再寄一次。
    }

    console.info(`[email] 已寄出 to=${maskEmail(message.to)} id=${id ?? "(no id)"}`);
    return { outcome: "sent", id, error: null };
  } catch (err) {
    // 逾時（TimeoutError）與網路錯誤都走這裡。**這一種是可重試的** ——
    // 而「送出去了但我們沒收到回應」也長這樣，所以重試有可能讓客人收到兩封。
    // 兩害相權：收到兩封信 < 永遠收不到信。
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[email] 寄送例外 to=${maskEmail(message.to)} ${error}`);
    return { outcome: "failed", id: null, error };
  }
}
