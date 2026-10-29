/**
 * 後台「旅程願望」收件匣（/admin/journey-wishes）的純邏輯：狀態標籤、篩選參數、回信的 mailto。
 * 零副作用，自檢直接 import。照 src/lib/partnership-inbox.ts。
 */
import { wishSourceLabel } from "./journey-wish.ts";

export const WISH_STATUSES = ["new", "reviewed", "archived"] as const;
export type WishStatus = (typeof WISH_STATUSES)[number];

export const WISH_STATUS_LABEL: Record<WishStatus, string> = {
  new: "未處理",
  reviewed: "已看過",
  archived: "已封存",
};

export type WishFilter = WishStatus | "all";

/** ?status= 只收認得的值；不帶＝未處理。 */
export function parseWishFilter(v: unknown): WishFilter {
  return v === "reviewed" || v === "archived" || v === "all" ? v : "new";
}

export function isWishStatus(v: unknown): v is WishStatus {
  return typeof v === "string" && (WISH_STATUSES as readonly string[]).includes(v);
}

export const WISH_EMAIL_STATUS_LABEL: Record<string, string> = {
  pending: "寄送中斷",
  sent: "已通知",
  failed: "通知信寄送失敗",
};

const SAFE_ADDR = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** 「回信」的 mailto:。沒留信箱或地址不合格 → null。 */
export function wishReplyMailto(row: { email: string; source: string }): string | null {
  if (!row.email || !SAFE_ADDR.test(row.email)) return null;
  const page = wishSourceLabel(row.source).split("｜")[0] ?? "";
  const subject = `Re: 【旅程願望】${page}`;
  return `mailto:${row.email}?subject=${encodeURIComponent(subject)}`;
}

/** 列表上的一行摘要：願望前 40 字，沒寫願望就列勾選的項目。 */
export function wishSummary(row: { wish: string; interests: string[] }): string {
  const text = row.wish.trim() || row.interests.join("、");
  const chars = Array.from(text.replace(/\s+/g, " "));
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : text;
}
