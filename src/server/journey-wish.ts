/**
 * 策旅願望表單（目前是 /events/kungtung 的「下次，我想這樣玩」）的伺服器端。
 * 流程與防濫用逐項照異業合作（src/server/partnership.ts）：
 *
 *   蜜罐有填        → 假裝成功（回 ok，不存、不寄），log 一行
 *   token 不對／太舊 → expired；不到 3 秒 → too_fast
 *                     （token 的 HMAC 用途標籤與異業合作不同，兩張表單的 token 不能互用）
 *   欄位不合格      → invalid（只回欄位名稱）
 *   同 IP 10 分鐘內第 4 次 → rate_limited；整個 instance 一小時第 31 次也是
 *   通過            → 先存進 journey_wishes（0046），再寄通知信給
 *                     site_settings.notify_emails，寄信結果寫回同一列
 *
 *   回 ok 的條件：資料落地了，或信寄出去了（任一個）。兩個都失敗 → send_failed。
 *   dry run（沒有 RESEND_API_KEY／MAIL_FROM）算**沒寄出**。
 *
 * 收件人永遠是店家；填表人的信箱（有填才有）只出現在 reply_to。不寄確認信給填表人。
 * 測試開關 JOURNEY_WISH_TEST_RECIPIENT：每一個地址都是 @resend.dev 才生效。
 * CSRF：server fn 一律 same-origin，由 src/start.ts 的全域 middleware 擋。
 */
import "@tanstack/react-start/server-only";
import { getRequestHeader } from "@tanstack/react-start/server";
import { adminSessionSecret } from "@/server/env";
import { emailConfigured, sendEmail } from "@/server/email";
import { getSiteSettings } from "@/server/repos/site-settings";
import { maskEmail } from "@/lib/email-templates";
import { wishSchema, type WishFormValues, type WishSubmitResult } from "@/lib/journey-wish";
import { renderWishEmail } from "@/lib/journey-wish-email";
import type { Lang } from "@/i18n/types";
import {
  SlidingWindowLimiter,
  checkFormToken,
  clientIpFrom,
  honeypotTripped,
  issueFormToken,
  resolvePartnershipRecipients,
} from "./partnership-guard";

/** HMAC 用途標籤：與異業合作表單分開。 */
export const WISH_TOKEN_PURPOSE = "ib-journey-wish-form-v1";

/** 同一個 IP：10 分鐘 3 次。 */
const perIp = new SlidingWindowLimiter(3, 10 * 60 * 1000);
/** 整個 instance：1 小時 30 次。 */
const perInstance = new SlidingWindowLimiter(30, 60 * 60 * 1000);

export function issueWishToken(): { token: string } {
  return { token: issueFormToken(adminSessionSecret(), Date.now(), WISH_TOKEN_PURPOSE) };
}

export type RawWishInput = {
  form: Record<string, unknown>;
  token: string;
  honeypot: string;
  lang: Lang;
  pageUrl: string;
};

export async function submitWish(input: RawWishInput): Promise<WishSubmitResult> {
  if (honeypotTripped(input.honeypot)) {
    console.info("[journey-wish] 蜜罐欄位有值，當作機器人，不存不寄");
    return { ok: true };
  }

  const token = checkFormToken(input.token, adminSessionSecret(), Date.now(), WISH_TOKEN_PURPOSE);
  if (token === "too_fast") return { ok: false, error: "too_fast" };
  if (token !== "ok") return { ok: false, error: "expired" };

  const parsed = wishSchema.safeParse(input.form);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")))].filter(
      Boolean,
    );
    return { ok: false, error: "invalid", fields };
  }
  const values = parsed.data;

  // 限流放在欄位驗證之後：填錯重送不該吃掉客人自己的額度。
  const ip = clientIpFrom((name) => getRequestHeader(name as never));
  if (!perIp.take(ip) || !perInstance.take("*")) {
    console.warn("[journey-wish] 觸發限流");
    return { ok: false, error: "rate_limited" };
  }

  let wishId: string | null = null;
  try {
    const { insertWish } = await import("@/server/repos/journey-wishes");
    wishId = await insertWish(values, { lang: input.lang, pageUrl: input.pageUrl });
  } catch (err) {
    console.error(
      `[journey-wish] 存進收件匣失敗，改為只寄信：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const sent = await notifyStore(values, input);

  if (wishId) {
    try {
      const { recordWishEmailResult } = await import("@/server/repos/journey-wishes");
      await recordWishEmailResult(wishId, {
        status: sent.ok ? "sent" : "failed",
        emailId: sent.ok ? sent.id : null,
        error: sent.ok ? null : sent.reason,
      });
    } catch (err) {
      console.error(
        `[journey-wish] 寫回寄信結果失敗 id=${wishId}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (sent.ok || wishId) return { ok: true };
  return { ok: false, error: "send_failed" };
}

type NotifyResult = { ok: true; id: string | null } | { ok: false; reason: string };

async function notifyStore(values: WishFormValues, input: RawWishInput): Promise<NotifyResult> {
  if (!emailConfigured()) {
    console.error("[journey-wish] 這個環境沒有設定 RESEND_API_KEY／MAIL_FROM，無法寄出");
    return { ok: false, reason: "email_not_configured" };
  }

  let notifyEmails = "";
  try {
    notifyEmails = (await getSiteSettings()).notify_emails ?? "";
  } catch (err) {
    console.error(
      `[journey-wish] 讀不到 site_settings：${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, reason: "site_settings_unavailable" };
  }

  const { to, test } = resolvePartnershipRecipients(
    notifyEmails,
    process.env.JOURNEY_WISH_TEST_RECIPIENT,
  );
  if (to.length === 0) {
    console.error("[journey-wish] site_settings.notify_emails 是空的，沒有人可以收信");
    return { ok: false, reason: "no_recipients" };
  }

  const mail = renderWishEmail(values, {
    submittedAt: new Date().toISOString(),
    pageUrl: input.pageUrl,
  });

  let result: Awaited<ReturnType<typeof sendEmail>>;
  try {
    result = await sendEmail({
      to: to.join(", "),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      // 有留信箱才設 reply_to；沒留就用站上預設的 reply-to。
      ...(values.email ? { replyTo: values.email } : {}),
    });
  } catch (err) {
    console.error(
      `[journey-wish] 寄送丟出例外：${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, reason: "send_threw" };
  }

  if (result.outcome !== "sent") {
    console.error(
      `[journey-wish] 寄送失敗 outcome=${result.outcome} to=${maskEmail(to.join(", "))} ${result.error ?? ""}`,
    );
    return { ok: false, reason: `${result.outcome}${result.error ? `: ${result.error}` : ""}` };
  }

  console.info(
    `[journey-wish] 已寄出 id=${result.id ?? "(no id)"} recipients=${to.length}${test ? "（測試收件人）" : ""}`,
  );
  return { ok: true, id: result.id ?? null };
}
