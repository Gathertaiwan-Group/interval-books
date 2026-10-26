/**
 * 異業合作表單（/partnership）的伺服器端：發 token、驗證、限流、寄信給店家。
 *
 * ── 送出的流程 ────────────────────────────────────────────────────────────
 *   蜜罐有填        → 假裝成功（回 ok，不寄、不告訴機器人哪裡露餡），log 一行
 *   token 不對／太舊 → expired（請重新整理）
 *   不到 3 秒       → too_fast
 *   同 IP 10 分鐘內第 4 次 → rate_limited；整個 instance 一小時第 31 次也是
 *   欄位不合格      → invalid（只回欄位名稱）
 *   沒有收件人／寄失敗／這個環境沒設 Resend → send_failed，log `[partnership]`
 *   寄出            → ok
 *
 * ⚠️ 只有「Resend 回 2xx」才算成功。dry run（沒有 RESEND_API_KEY 或 MAIL_FROM）在
 *    這裡算**失敗**——交易信走 outbox，dry run 記成 skipped 之後還看得到；這裡不落地，
 *    回 ok 就等於告訴客人「已收到」而店家什麼都沒收到。
 *
 * ── 收件人 ───────────────────────────────────────────────────────────────
 * site_settings.notify_emails（後台 /admin/settings「通知信收件人」，逗號分隔），與
 * 新訂單通知同一欄。**客人的信箱只出現在 reply_to，永遠不是收件人**——這個端點不寄
 * 確認信給填表人，否則任何人都能拿它寄信給任意地址。
 *
 * 測試用：環境變數 PARTNERSHIP_TEST_RECIPIENT 有值、而且**每一個地址都是
 * `@resend.dev`**（Resend 的測試信箱）時，改寄給它，不寄店家。不是 @resend.dev 的值
 * 一律忽略——這個開關不能被拿來把表單導去別的真實信箱。
 *
 * ── 之後要加後台收件匣 ────────────────────────────────────────────────────
 * 有 DDL 權限時：建一張 partnership_inquiries（RLS 開、anon 全關），在寄信**之前**
 * insert，寄信結果寫回同一列；/admin 加一頁列表。寄信失敗時仍可回 ok（資料已落地）。
 */
import "@tanstack/react-start/server-only";
import { getRequestHeader } from "@tanstack/react-start/server";
import { adminSessionSecret } from "@/server/env";
import { emailConfigured, sendEmail } from "@/server/email";
import { getSiteSettings } from "@/server/repos/site-settings";
import { maskEmail } from "@/lib/email-templates";
import { partnershipSchema, type PartnershipSubmitResult } from "@/lib/partnership";
import { renderPartnershipEmail } from "@/lib/partnership-email";
import type { Lang } from "@/i18n/types";
import {
  SlidingWindowLimiter,
  checkFormToken,
  clientIpFrom,
  honeypotTripped,
  issueFormToken,
  resolvePartnershipRecipients,
} from "./partnership-guard";

/** 同一個 IP：10 分鐘 3 次。 */
const perIp = new SlidingWindowLimiter(3, 10 * 60 * 1000);
/** 整個 instance：1 小時 30 次（分散來源的灌信也要有個天花板）。 */
const perInstance = new SlidingWindowLimiter(30, 60 * 60 * 1000);

export function issuePartnershipToken(): { token: string } {
  return { token: issueFormToken(adminSessionSecret()) };
}

export type RawPartnershipInput = {
  form: Record<string, unknown>;
  token: string;
  honeypot: string;
  lang: Lang;
  pageUrl: string;
};

export async function submitPartnership(
  input: RawPartnershipInput,
): Promise<PartnershipSubmitResult> {
  if (honeypotTripped(input.honeypot)) {
    console.info("[partnership] 蜜罐欄位有值，當作機器人，不寄信");
    return { ok: true };
  }

  const token = checkFormToken(input.token, adminSessionSecret());
  if (token === "too_fast") return { ok: false, error: "too_fast" };
  if (token !== "ok") return { ok: false, error: "expired" };

  const parsed = partnershipSchema.safeParse(input.form);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")))].filter(
      Boolean,
    );
    return { ok: false, error: "invalid", fields };
  }
  const values = parsed.data;

  // 限流放在欄位驗證之後：填錯重送不該把客人自己的額度吃掉。
  const ip = clientIpFrom((name) => getRequestHeader(name as never));
  if (!perIp.take(ip) || !perInstance.take("*")) {
    console.warn("[partnership] 觸發限流");
    return { ok: false, error: "rate_limited" };
  }

  if (!emailConfigured()) {
    console.error("[partnership] 這個環境沒有設定 RESEND_API_KEY／MAIL_FROM，無法寄出");
    return { ok: false, error: "send_failed" };
  }

  let notifyEmails = "";
  try {
    notifyEmails = (await getSiteSettings()).notify_emails ?? "";
  } catch (err) {
    console.error(
      `[partnership] 讀不到 site_settings：${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, error: "send_failed" };
  }

  const { to, test } = resolvePartnershipRecipients(
    notifyEmails,
    process.env.PARTNERSHIP_TEST_RECIPIENT,
  );
  if (to.length === 0) {
    console.error("[partnership] site_settings.notify_emails 是空的，沒有人可以收信");
    return { ok: false, error: "send_failed" };
  }

  const mail = renderPartnershipEmail(values, {
    submittedAt: new Date().toISOString(),
    lang: input.lang,
    pageUrl: input.pageUrl,
  });

  const result = await sendEmail({
    to: to.join(", "),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    replyTo: values.email,
  });

  if (result.outcome !== "sent") {
    console.error(
      `[partnership] 寄送失敗 outcome=${result.outcome} to=${maskEmail(to.join(", "))} ${result.error ?? ""}`,
    );
    return { ok: false, error: "send_failed" };
  }

  console.info(
    `[partnership] 已寄出 id=${result.id ?? "(no id)"} recipients=${to.length}${test ? "（測試收件人）" : ""}`,
  );
  return { ok: true };
}
