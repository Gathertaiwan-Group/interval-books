/**
 * 策旅願望表單 → 寄給店家的那一封通知信。**純函式**，自檢直接 import
 * （scripts/journey-wish-selftest.mjs）。規則與異業合作那封相同（src/lib/partnership-email.ts）：
 *   1. 每一個值都過 escapeHtml()；
 *   2. 信裡一條可以點的連結都沒有（來源頁面印成文字）；
 *   3. 主旨每一段先 singleLine() 再截斷。
 */
import { escapeHtml } from "./email-templates.ts";
import { formatTaipeiDateTime } from "./taipei-time.ts";
import { singleLine } from "./partnership.ts";
import { wishSourceLabel, type WishFormValues } from "./journey-wish.ts";

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : value;
}

/** 「【旅程願望】范毅舜公東教堂文化之旅｜王小明」（沒填稱呼就只有頁面名稱）。 */
export function wishSubject(v: Pick<WishFormValues, "source" | "name">): string {
  const page = clip(singleLine(wishSourceLabel(v.source)).split("｜")[0] ?? "", 30);
  const name = clip(singleLine(v.name), 20);
  return name ? `【旅程願望】${page}｜${name}` : `【旅程願望】${page}`;
}

export type WishEmailMeta = { submittedAt: string; pageUrl: string };

type Row = { label: string; value: string };

export function wishRows(v: WishFormValues, meta: WishEmailMeta): Row[] {
  const dash = (s: string) => (s ? s : "—");
  const yesNo = (b: boolean) => (b ? "是" : "否");
  return [
    { label: "來源頁面", value: wishSourceLabel(v.source) },
    { label: "最想體驗", value: v.interests.length ? v.interests.join("、") : "（未選）" },
    { label: "怎麼稱呼", value: dash(v.name) },
    { label: "電子信箱", value: dash(v.email) },
    { label: "免費加入小時光知友", value: yesNo(v.joinFriends) },
    { label: "同意接收未來策旅通知", value: yesNo(v.notifyOptIn) },
    { label: "送出時間", value: `${formatTaipeiDateTime(meta.submittedAt)}（台北）` },
    { label: "網址", value: dash(meta.pageUrl) },
  ];
}

export function renderWishEmail(
  v: WishFormValues,
  meta: WishEmailMeta,
): { subject: string; text: string; html: string } {
  const subject = wishSubject(v);
  const rows = wishRows(v, meta);
  const heading = "新的旅程願望";
  const hint = v.email
    ? "直接按「回覆」就會寄給填表人（reply-to 已設為對方的電子信箱）。後台「旅程願望」也看得到這一筆。"
    : "填表人沒有留電子信箱。後台「旅程願望」看得到這一筆。";
  const wish = v.wish || "（未填）";

  const text = [
    heading,
    "",
    ...rows.map((r) => `${r.label}：${r.value}`),
    "",
    "旅行願望：",
    wish,
    "",
    "──",
    hint,
    "這封信由小時光書店官網的旅程願望表單自動寄出。",
  ].join("\n");

  const tr = (r: Row) =>
    `<tr>` +
    `<td style="padding:4px 12px 4px 0;color:#6b6257;white-space:nowrap;vertical-align:top">${escapeHtml(r.label)}</td>` +
    `<td style="padding:4px 0;color:#2b2621;word-break:break-all">${escapeHtml(r.value)}</td>` +
    `</tr>`;

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC',sans-serif;` +
    `max-width:600px;margin:0 auto;padding:24px;color:#2b2621;background:#ffffff">` +
    `<h1 style="font-size:20px;line-height:1.5;margin:0 0 16px">${escapeHtml(heading)}</h1>` +
    `<table style="border-collapse:collapse;font-size:14px;line-height:1.7">${rows.map(tr).join("")}</table>` +
    `<div style="margin-top:16px;padding:12px 14px;background:#f6f2ec;border-left:3px solid #2b2621">` +
    `<p style="font-size:14px;font-weight:600;margin:0 0 6px">旅行願望</p>` +
    `<p style="font-size:14px;line-height:1.8;margin:0;white-space:pre-wrap;word-break:break-word">${escapeHtml(wish)}</p>` +
    `</div>` +
    `<p style="font-size:12px;line-height:1.7;color:#8a8175;margin:24px 0 0;padding-top:12px;border-top:1px solid #e7e1d8">` +
    `${escapeHtml(hint)}<br>這封信由小時光書店官網的旅程願望表單自動寄出。</p>` +
    `</div>`;

  return { subject, text, html };
}
