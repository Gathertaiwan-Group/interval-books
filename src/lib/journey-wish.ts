/**
 * 策旅頁「下次，我想這樣玩」願望表單 —— 前後台共用的欄位定義與驗證。
 *
 * 純函式、只依賴 zod 與 partnership.ts 的清理函式：瀏覽器與伺服器跑同一份 schema，
 * scripts/journey-wish-selftest.mjs 直接 import 這一支。
 *
 * ── 通用 ─────────────────────────────────────────────────────────────────
 * 資料表 public.journey_wishes（0046）給所有策旅頁共用，靠 `source` 分辨是哪一頁。
 * 新的策旅頁要用這張表單：在 WISH_SOURCES 加一個 key（小寫英數與 -，對得上 0046 的
 * source CHECK）與那一頁的「最想體驗」選項，不必跑 migration。
 *
 * ── 驗證（照 220baaa 的前台設計） ────────────────────────────────────────────
 *   · 「最想體驗」可複選，只收那一頁白名單裡的字；
 *   · 旅行願望選填、最多 1000 字；
 *   · 至少要選一項、或寫一段願望；
 *   · 稱呼與電子信箱完全選填；信箱有填就要像信箱；
 *   · 兩個勾選（加入知友／接收策旅通知）自由勾選。
 */
import { z } from "zod";
import { multiLine, singleLine } from "./partnership.ts";

export const WISH_LIMITS = {
  wish: 1000,
  name: 100,
  email: 254,
  interests: 20,
} as const;

export type WishSourceConfig = {
  /** 後台與通知信上顯示的頁面名稱。 */
  label: string;
  /** 送出時的頁面路徑（後台「來源頁面」連結用）。 */
  path: string;
  /** 「下一次，你最想體驗什麼？」的選項。 */
  interests: readonly string[];
};

export const WISH_SOURCES = {
  kungtung: {
    label: "范毅舜公東教堂文化之旅｜台東三天兩夜",
    path: "/events/kungtung",
    interests: [
      "秘境建築與文化",
      "攝影與藝術旅行",
      "名人作家同行",
      "山海風土美食",
      "音樂與生活沙龍",
      "自然療癒與慢旅",
      "地方職人深度交流",
      "一個人的自在旅行",
    ],
  },
} as const satisfies Record<string, WishSourceConfig>;

export type WishSource = keyof typeof WISH_SOURCES;
export const WISH_SOURCE_KEYS = Object.keys(WISH_SOURCES) as WishSource[];

export function isWishSource(v: unknown): v is WishSource {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(WISH_SOURCES, v);
}

/** 後台顯示用：認得就給頁面名稱，不認得原樣顯示 key。 */
export function wishSourceLabel(source: string): string {
  return isWishSource(source) ? WISH_SOURCES[source].label : source;
}

/** 欄位錯誤代碼 → 畫面上的句子（這一張表單目前只有中文頁在用）。 */
export const WISH_FIELD_ERROR_TEXT: Record<string, string> = {
  empty: "請至少選一項，或寫下你的旅行願望。",
  email: "電子信箱格式不正確",
  tooLong: "字數超過上限",
  interests: "選項不正確，請重新整理頁面後再選",
  source: "表單來源不正確，請重新整理頁面",
};

const line = (max: number) => z.string().transform(singleLine).pipe(z.string().max(max, "tooLong"));

/**
 * 表單本體。**瀏覽器與伺服器同一份。** 字串先清理（控制字元、CRLF）再量長度。
 */
export const wishSchema = z
  .object({
    source: z.string().refine(isWishSource, "source"),
    interests: z.array(z.string()).max(WISH_LIMITS.interests, "interests"),
    wish: z.string().transform(multiLine).pipe(z.string().max(WISH_LIMITS.wish, "tooLong")),
    name: line(WISH_LIMITS.name),
    email: line(WISH_LIMITS.email).refine(
      (v) => v === "" || z.string().email().safeParse(v).success,
      "email",
    ),
    joinFriends: z.boolean(),
    notifyOptIn: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (isWishSource(v.source)) {
      const allowed: readonly string[] = WISH_SOURCES[v.source].interests;
      if (v.interests.some((i) => !allowed.includes(i))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["interests"], message: "interests" });
      }
    }
    if (v.interests.length === 0 && v.wish === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["wish"], message: "empty" });
    }
  })
  .transform((v) => ({
    ...v,
    source: v.source as WishSource,
    // 去重、照那一頁的選項順序排（後台與信上看起來一致）。
    interests: isWishSource(v.source)
      ? WISH_SOURCES[v.source].interests.filter((i) => v.interests.includes(i))
      : [],
  }));

export type WishFormInput = z.input<typeof wishSchema>;
export type WishFormValues = z.output<typeof wishSchema>;

// -----------------------------------------------------------------------------
// 送出結果（server fn 的回傳形狀）
// -----------------------------------------------------------------------------

export type WishSubmitError = "invalid" | "expired" | "too_fast" | "rate_limited" | "send_failed";

export type WishSubmitResult =
  | { ok: true }
  | { ok: false; error: WishSubmitError; fields?: string[] };

export const WISH_SUBMIT_ERROR_TEXT: Record<WishSubmitError, string> = {
  invalid: "有欄位還沒填好，請檢查後再送出。",
  expired: "表單已逾時，請重新整理頁面後再送出（填好的內容請先複製保存）。",
  too_fast: "送出得有點快，請稍候幾秒再試一次。",
  rate_limited: "短時間內送出太多次了，請稍後再試，或直接來信與我們聯繫。",
  send_failed: "很抱歉，願望暫時無法送出。請稍後再試，或直接來信與我們聯繫。",
};
