/**
 * 異業合作表單（/partnership）—— 前後台共用的欄位定義與驗證。
 *
 * ── 這個檔案的規矩 ────────────────────────────────────────────────────────
 * 純函式、只依賴 zod：瀏覽器（react-hook-form 的 zodResolver）與伺服器（server fn
 * 收到之後再驗一次）跑的是**同一份 schema**，不是兩份「應該長得一樣」的規則。
 * scripts/partnership-selftest.mjs 直接 import 這一支。
 *
 * ── 錯誤訊息是「代碼」，不是句子 ───────────────────────────────────────────
 * 這個站是三語的，而 zod 的訊息只有一種語言。所以 schema 裡的 message 一律是
 * FIELD_ERROR 的 key（"required"、"email"…），畫面再用 FIELD_ERROR_TEXT 翻成當下
 * 的語言。伺服器那一側根本不回傳訊息內容，只回「哪幾個欄位不合格」。
 *
 * ── 為什麼沒有資料表 ───────────────────────────────────────────────────────
 * 2026-10-26 這一期沒有 DDL 權限：送出 = 寄一封信給 site_settings.notify_emails
 * 的每一個地址，不落地。之後要加「後台收件匣」時，見 src/server/partnership.ts 檔頭。
 */
import { z } from "zod";
import type { Lang, Localized } from "@/i18n/types";

// -----------------------------------------------------------------------------
// 選項
// -----------------------------------------------------------------------------

/**
 * 合作類型。前六個與頁面上的「合作形式」卡片一一對應；`other` 只出現在下拉選單。
 *
 * 送到伺服器的是 code，不是顯示文字 —— 信件主旨一律用中文標籤（收信的是店裡的人），
 * 與客人當下用哪個語言填表無關。
 */
export const PARTNERSHIP_TYPES = [
  "event",
  "exhibition",
  "consignment",
  "cobrand",
  "private",
  "talk",
  "other",
] as const;
export type PartnershipType = (typeof PARTNERSHIP_TYPES)[number];

export const PARTNERSHIP_TYPE_LABEL: Record<PartnershipType, Localized> = {
  event: { zh: "活動合作", en: "Events", ja: "イベント協働" },
  exhibition: { zh: "展覽", en: "Exhibitions", ja: "展示" },
  consignment: { zh: "選物寄賣", en: "Consignment", ja: "委託販売" },
  cobrand: { zh: "品牌聯名", en: "Brand Collaboration", ja: "ブランドコラボ" },
  private: { zh: "企業包場", en: "Private Booking", ja: "貸切・法人利用" },
  talk: { zh: "講座／工作坊", en: "Talks & Workshops", ja: "講座・ワークショップ" },
  other: { zh: "其他", en: "Other", ja: "その他" },
};

/** 預算範圍（選填）。空字串 = 沒選。 */
export const PARTNERSHIP_BUDGETS = [
  "undecided",
  "under50k",
  "50k-150k",
  "150k-300k",
  "over300k",
] as const;
export type PartnershipBudget = (typeof PARTNERSHIP_BUDGETS)[number];

export const PARTNERSHIP_BUDGET_LABEL: Record<PartnershipBudget, Localized> = {
  undecided: { zh: "尚未確定", en: "Not decided yet", ja: "未定" },
  under50k: { zh: "NT$5 萬以下", en: "Under NT$50,000", ja: "NT$5万未満" },
  "50k-150k": { zh: "NT$5–15 萬", en: "NT$50,000–150,000", ja: "NT$5万〜15万" },
  "150k-300k": { zh: "NT$15–30 萬", en: "NT$150,000–300,000", ja: "NT$15万〜30万" },
  over300k: { zh: "NT$30 萬以上", en: "Over NT$300,000", ja: "NT$30万以上" },
};

// -----------------------------------------------------------------------------
// 長度上限（前後台共用；伺服器的 raw 收件也用它們擋超大 payload）
// -----------------------------------------------------------------------------

export const LIMITS = {
  company: 100,
  name: 50,
  email: 254,
  phone: 30,
  website: 300,
  timeframe: 100,
  messageMin: 20,
  messageMax: 2000,
} as const;

// -----------------------------------------------------------------------------
// 清理
// -----------------------------------------------------------------------------

/**
 * 單行欄位：所有控制字元（含 CR／LF／TAB／DEL）換成空白、連續空白壓成一個、頭尾去空白。
 *
 * 這是 header injection 的那一道：公司名稱與姓名會進信件主旨，主旨裡出現一個 `\r\n`
 * 在某些寄信管線裡就是一個新的 header。Resend 走 JSON API，理論上不受影響——但這一層
 * 不賭下游的實作。
 */
export function singleLine(value: string): string {
  return Array.from(value, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 多行欄位（合作內容說明）：保留換行，其餘控制字元拿掉，CRLF 統一成 LF，三個以上
 * 連續空行壓成兩個。
 */
export function multiLine(value: string): string {
  return Array.from(value.replace(/\r\n?/g, "\n"), (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n") return ch;
    if (ch === "\t") return " ";
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "" : ch;
  })
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 只接受 http(s) 網址。`javascript:`、`data:` 之類一律不合格。 */
export function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && Boolean(u.hostname);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

/** 欄位錯誤代碼 → 畫面上的句子（三語）。 */
export const FIELD_ERROR_TEXT: Record<string, Localized> = {
  required: { zh: "這一欄必填", en: "This field is required", ja: "必須項目です" },
  type: { zh: "請選擇合作類型", en: "Please choose a type", ja: "種類を選んでください" },
  email: {
    zh: "電子郵件格式不正確",
    en: "Please enter a valid email",
    ja: "メールアドレスの形式が正しくありません",
  },
  phone: {
    zh: "電話只能包含數字、空白與 + - ( ) #",
    en: "Phone may contain digits, spaces and + - ( ) # only",
    ja: "電話番号は数字・スペース・+ - ( ) # のみ使用できます",
  },
  url: {
    zh: "請輸入 http:// 或 https:// 開頭的網址",
    en: "Please enter a URL starting with http:// or https://",
    ja: "http:// または https:// で始まるURLを入力してください",
  },
  check: {
    zh: "請再檢查這一欄",
    en: "Please check this field",
    ja: "この項目をご確認ください",
  },
  tooLong: { zh: "字數超過上限", en: "Too long", ja: "文字数が上限を超えています" },
  messageMin: {
    zh: `請至少寫 ${LIMITS.messageMin} 個字，讓我們更了解你的想法`,
    en: `Please write at least ${LIMITS.messageMin} characters`,
    ja: `${LIMITS.messageMin}文字以上でご記入ください`,
  },
  messageMax: {
    zh: `最多 ${LIMITS.messageMax} 字`,
    en: `Up to ${LIMITS.messageMax} characters`,
    ja: `${LIMITS.messageMax}文字以内でご記入ください`,
  },
  budget: { zh: "請從選單中選擇", en: "Please choose from the list", ja: "一覧から選んでください" },
  consent: {
    zh: "請勾選同意隱私權政策",
    en: "Please agree to the privacy policy",
    ja: "プライバシーポリシーへの同意が必要です",
  },
};

export function fieldErrorText(code: string | undefined, lang: Lang): string {
  if (!code) return "";
  const v = FIELD_ERROR_TEXT[code] ?? FIELD_ERROR_TEXT.required;
  return v[lang] || v.zh;
}

const line = (max: number) => z.string().transform(singleLine).pipe(z.string().max(max, "tooLong"));

const requiredLine = (max: number) =>
  z.string().transform(singleLine).pipe(z.string().min(1, "required").max(max, "tooLong"));

/**
 * 表單本體。**瀏覽器與伺服器同一份。**
 *
 * 所有字串欄位先過 singleLine()／multiLine() 再驗長度：長度量的是清理後真正會寄出去的
 * 內容，不是客人貼進來、夾著一堆控制字元的原文。
 */
export const partnershipSchema = z.object({
  type: z.enum(PARTNERSHIP_TYPES, { errorMap: () => ({ message: "type" }) }),
  company: requiredLine(LIMITS.company),
  contactName: requiredLine(LIMITS.name),
  email: z
    .string()
    .transform(singleLine)
    .pipe(z.string().min(1, "required").max(LIMITS.email, "tooLong").email("email")),
  phone: line(LIMITS.phone).pipe(z.string().regex(/^[0-9+()\-#\s]*$/, "phone")),
  website: line(LIMITS.website).refine((v) => v === "" || isHttpUrl(v), "url"),
  timeframe: line(LIMITS.timeframe),
  budget: z.union([z.literal(""), z.enum(PARTNERSHIP_BUDGETS)], {
    errorMap: () => ({ message: "budget" }),
  }),
  message: z
    .string()
    .transform(multiLine)
    .pipe(z.string().min(LIMITS.messageMin, "messageMin").max(LIMITS.messageMax, "messageMax")),
  consent: z.literal(true, { errorMap: () => ({ message: "consent" }) }),
});

/** 表單上的原始值（送出前）。 */
export type PartnershipFormInput = z.input<typeof partnershipSchema>;
/** 驗過、清理過的值（寄信用的就是這一份）。 */
export type PartnershipFormValues = z.output<typeof partnershipSchema>;

export const EMPTY_PARTNERSHIP_FORM: PartnershipFormInput = {
  type: "" as PartnershipType,
  company: "",
  contactName: "",
  email: "",
  phone: "",
  website: "",
  timeframe: "",
  budget: "",
  message: "",
  // 型別上是 true（z.literal），畫面初始值必須是沒勾。
  consent: false as unknown as true,
};

// -----------------------------------------------------------------------------
// 送出結果（server fn 的回傳形狀）
// -----------------------------------------------------------------------------

export type PartnershipSubmitError =
  | "invalid" // 欄位驗證沒過（伺服器那一側）
  | "expired" // 表單 token 缺少／簽章不對／太舊 → 請重新整理
  | "too_fast" // 從畫面出現到送出不到最短秒數
  | "rate_limited" // 同一個來源短時間送太多次
  | "send_failed"; // 信沒寄出去（含沒有收件人、Resend 失敗）

export type PartnershipSubmitResult =
  | { ok: true }
  | { ok: false; error: PartnershipSubmitError; fields?: string[] };

export const SUBMIT_ERROR_TEXT: Record<PartnershipSubmitError, Localized> = {
  invalid: {
    zh: "有欄位還沒填好，請檢查標示的欄位。",
    en: "Some fields need attention — please check the highlighted fields.",
    ja: "入力内容に不備があります。表示された項目をご確認ください。",
  },
  expired: {
    zh: "表單已逾時，請重新整理頁面後再送出（填好的內容請先複製保存）。",
    en: "This form has expired. Please copy your text, reload the page and try again.",
    ja: "フォームの有効期限が切れました。内容をコピーしてから再読み込みしてください。",
  },
  too_fast: {
    zh: "送出得有點快，請稍候幾秒再試一次。",
    en: "That was a little fast — please wait a few seconds and try again.",
    ja: "送信が早すぎます。数秒おいてからもう一度お試しください。",
  },
  rate_limited: {
    zh: "短時間內送出太多次了，請稍後再試，或直接來信與我們聯繫。",
    en: "Too many submissions in a short time. Please try again later or email us directly.",
    ja: "短時間に送信が集中しています。しばらくしてから再度お試しいただくか、メールでご連絡ください。",
  },
  send_failed: {
    zh: "很抱歉，表單暫時無法送出。請稍後再試，或直接來信與我們聯繫。",
    en: "Sorry, we couldn't send your form. Please try again later or email us directly.",
    ja: "申し訳ありません。送信できませんでした。しばらくしてから再度お試しいただくか、メールでご連絡ください。",
  },
};
