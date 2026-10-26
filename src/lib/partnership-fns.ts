/**
 * /partnership 的兩支公開 server functions。實作在 src/server/partnership.ts。
 *
 * 不用登入：這是給任何人填的表單。防濫用（蜜罐、最短填寫時間、限流）全部在伺服器
 * 那一側做，見 src/server/partnership-guard.ts。CSRF 由 src/start.ts 的全域
 * middleware 擋（server fn 一律要 same-origin）。
 */
import { createServerFn } from "@tanstack/react-start";
import type { Lang } from "@/i18n/types";
import { singleLine, type PartnershipSubmitResult } from "@/lib/partnership";

/** 畫面出現時拿一張表單 token（發行時間＋簽章）。 */
export const getPartnershipFormToken = createServerFn({ method: "GET" }).handler(async () => {
  const { issuePartnershipToken } = await import("@/server/partnership");
  return issuePartnershipToken();
});

const FORM_KEYS = [
  "type",
  "company",
  "contactName",
  "email",
  "phone",
  "website",
  "timeframe",
  "budget",
  "message",
  "consent",
] as const;

/** 任何一個字串欄位的硬上限——真正的長度規則在 partnershipSchema，這裡只擋超大 payload。 */
const RAW_MAX = 5_000;

const str = (v: unknown, max = RAW_MAX): string => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * 只收認得的 key、只收字串（consent 只收 boolean），其餘丟掉。嚴格驗證在 handler 裡
 * 用同一份 partnershipSchema 做，**不在這裡丟例外**：丟例外的話客人看到的是框架的錯誤
 * 字串，而不是「哪一欄沒填好」。
 */
function coerceInput(raw: unknown) {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const f = (typeof o.form === "object" && o.form !== null ? o.form : {}) as Record<
    string,
    unknown
  >;
  const form: Record<string, unknown> = {};
  for (const k of FORM_KEYS) form[k] = k === "consent" ? f[k] === true : str(f[k]);
  const lang: Lang = o.lang === "en" || o.lang === "ja" ? o.lang : "zh";
  return {
    form,
    token: str(o.token, 200),
    honeypot: str(o.honeypot, 500),
    lang,
    pageUrl: singleLine(str(o.pageUrl, 300)),
  };
}

export const submitPartnershipForm = createServerFn({ method: "POST" })
  .inputValidator(coerceInput)
  .handler(async ({ data }): Promise<PartnershipSubmitResult> => {
    const { submitPartnership } = await import("@/server/partnership");
    try {
      return await submitPartnership(data);
    } catch (err) {
      console.error(
        `[partnership] 未預期的錯誤：${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, error: "send_failed" };
    }
  });
