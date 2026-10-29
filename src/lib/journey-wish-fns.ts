/**
 * 策旅願望表單的兩支公開 server functions。實作在 src/server/journey-wish.ts。
 *
 * 不用登入。防濫用（蜜罐、最短填寫時間、限流）全部在伺服器那一側做；CSRF 由
 * src/start.ts 的全域 middleware 擋（server fn 一律要 same-origin）。照
 * src/lib/partnership-fns.ts。
 */
import { createServerFn } from "@tanstack/react-start";
import type { Lang } from "@/i18n/types";
import { singleLine } from "@/lib/partnership";
import { WISH_LIMITS, type WishSubmitResult } from "@/lib/journey-wish";

/** 畫面出現時拿一張表單 token（發行時間＋簽章）。 */
export const getWishFormToken = createServerFn({ method: "GET" }).handler(async () => {
  const { issueWishToken } = await import("@/server/journey-wish");
  return issueWishToken();
});

/** 任何一個字串欄位的硬上限——真正的長度規則在 wishSchema，這裡只擋超大 payload。 */
const RAW_MAX = 5_000;

const str = (v: unknown, max = RAW_MAX): string => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * 只收認得的 key：字串欄位只收字串、勾選只收 boolean、interests 只收字串陣列（最多
 * 上限＋1 項，讓 schema 回「太多」而不是被這裡默默截斷）。嚴格驗證在 handler 裡用同一份
 * wishSchema 做，不在這裡丟例外。
 */
function coerceInput(raw: unknown) {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const f = (typeof o.form === "object" && o.form !== null ? o.form : {}) as Record<
    string,
    unknown
  >;
  const interests = Array.isArray(f.interests)
    ? f.interests
        .slice(0, WISH_LIMITS.interests + 1)
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.slice(0, 100))
    : [];
  const form: Record<string, unknown> = {
    source: str(f.source, 64),
    interests,
    wish: str(f.wish),
    name: str(f.name),
    email: str(f.email),
    joinFriends: f.joinFriends === true,
    notifyOptIn: f.notifyOptIn === true,
  };
  const lang: Lang = o.lang === "en" || o.lang === "ja" ? o.lang : "zh";
  return {
    form,
    token: str(o.token, 200),
    honeypot: str(o.honeypot, 500),
    lang,
    pageUrl: singleLine(str(o.pageUrl, 300)),
  };
}

export const submitWishForm = createServerFn({ method: "POST" })
  .inputValidator(coerceInput)
  .handler(async ({ data }): Promise<WishSubmitResult> => {
    const { submitWish } = await import("@/server/journey-wish");
    try {
      return await submitWish(data);
    } catch (err) {
      console.error(
        `[journey-wish] 未預期的錯誤：${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, error: "send_failed" };
    }
  });
