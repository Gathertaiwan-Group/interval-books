/**
 * 後台「異業合作」收件匣（/admin/partnerships）的純邏輯：狀態標籤、篩選參數、回信的 mailto。
 * 零副作用、只 import 型別與 partnership.ts 的常數，自檢直接 import。
 */
import {
  PARTNERSHIP_BUDGET_LABEL,
  PARTNERSHIP_TYPE_LABEL,
  type PartnershipBudget,
  type PartnershipType,
} from "./partnership.ts";

export const INQUIRY_STATUSES = ["new", "replied", "archived"] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export const INQUIRY_STATUS_LABEL: Record<InquiryStatus, string> = {
  new: "未處理",
  replied: "已回覆",
  archived: "已封存",
};

export type InquiryFilter = InquiryStatus | "all";

/** ?status= 只收認得的值；不帶＝未處理（打開就看到要處理的）。 */
export function parseInquiryFilter(v: unknown): InquiryFilter {
  return v === "replied" || v === "archived" || v === "all" ? v : "new";
}

export function isInquiryStatus(v: unknown): v is InquiryStatus {
  return typeof v === "string" && (INQUIRY_STATUSES as readonly string[]).includes(v);
}

export function inquiryTypeLabel(type: string): string {
  return PARTNERSHIP_TYPE_LABEL[type as PartnershipType]?.zh ?? type;
}

export function inquiryBudgetLabel(budget: string): string {
  if (!budget) return "未填";
  return PARTNERSHIP_BUDGET_LABEL[budget as PartnershipBudget]?.zh ?? budget;
}

export const EMAIL_STATUS_LABEL: Record<string, string> = {
  pending: "寄送中斷",
  sent: "已通知",
  failed: "通知信寄送失敗",
};

/** 寄件人的 Email 長得像正常地址才產生 mailto（擋 ?、&、#、空白等會改寫 mailto 參數的字元）。 */
const SAFE_ADDR = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * 「回信」按鈕的 mailto:。主旨＝「Re: 【異業合作】類型｜公司」，與通知信主旨同一個開頭，
 * 店家的信箱裡會串在一起。地址不合格 → null（畫面改成只顯示地址讓人複製）。
 */
export function replyMailto(row: { email: string; type: string; company: string }): string | null {
  if (!SAFE_ADDR.test(row.email)) return null;
  const subject = `Re: 【異業合作】${inquiryTypeLabel(row.type)}｜${row.company}`;
  return `mailto:${row.email}?subject=${encodeURIComponent(subject)}`;
}
