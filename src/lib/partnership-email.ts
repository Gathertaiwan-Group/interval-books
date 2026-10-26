/**
 * 異業合作表單 → 寄給店家的那一封信。**純函式**，自檢直接 import
 * （scripts/partnership-selftest.mjs）。
 *
 * ⚠️ 信裡的每一個值都是陌生人填的。規則：
 *   1. 全部過 escapeHtml()（與交易信同一支，src/lib/email-templates.ts）。
 *   2. **一條可以點的連結都沒有。** 客人填的官網照原樣印成文字——店裡的人要去看，自己
 *      複製；不讓一封「表單通知信」變成一封帶著陌生連結、看起來是店家自己寄的信。
 *      回覆客人靠 reply_to（見 src/server/partnership.ts），不靠信裡的 mailto:。
 *   3. 主旨的每一段先 singleLine()（拿掉 CR／LF 與控制字元）再截斷。
 */
import { escapeHtml } from "./email-templates.ts";
import { formatTaipeiDateTime } from "./taipei-time.ts";
import {
  PARTNERSHIP_BUDGET_LABEL,
  PARTNERSHIP_TYPE_LABEL,
  singleLine,
  type PartnershipFormValues,
} from "./partnership.ts";
import type { Lang } from "@/i18n/types";

const LANG_LABEL: Record<Lang, string> = { zh: "中文", en: "English", ja: "日本語" };

/** 截斷成最多 max 個字（以 code point 計，不切壞 emoji），超過補「…」。 */
function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : value;
}

/** 「【異業合作】品牌聯名｜某某公司｜王小明」 */
export function partnershipSubject(
  v: Pick<PartnershipFormValues, "type" | "company" | "contactName">,
): string {
  const type = PARTNERSHIP_TYPE_LABEL[v.type]?.zh ?? "其他";
  const company = clip(singleLine(v.company), 40);
  const name = clip(singleLine(v.contactName), 20);
  return `【異業合作】${type}｜${company}｜${name}`;
}

export type PartnershipEmailMeta = {
  /** 送出時間（ISO）。信裡一律印台北時間。 */
  submittedAt: string;
  /** 客人當下的介面語言。 */
  lang: Lang;
  /** 送出時的頁面網址（純文字印出，不做成連結）。 */
  pageUrl: string;
};

type Row = { label: string; value: string };

export function partnershipRows(v: PartnershipFormValues, meta: PartnershipEmailMeta): Row[] {
  const dash = (s: string) => (s ? s : "—");
  return [
    { label: "合作類型", value: PARTNERSHIP_TYPE_LABEL[v.type]?.zh ?? v.type },
    { label: "公司／品牌", value: v.company },
    { label: "聯絡人", value: v.contactName },
    { label: "Email", value: v.email },
    { label: "電話", value: dash(v.phone) },
    { label: "官網／社群", value: dash(v.website) },
    { label: "預計時間", value: dash(v.timeframe) },
    {
      label: "預算範圍",
      value: v.budget ? (PARTNERSHIP_BUDGET_LABEL[v.budget]?.zh ?? v.budget) : "—",
    },
    { label: "送出時間", value: `${formatTaipeiDateTime(meta.submittedAt)}（台北）` },
    { label: "填表語言", value: LANG_LABEL[meta.lang] ?? meta.lang },
    { label: "來源頁面", value: dash(meta.pageUrl) },
  ];
}

export function renderPartnershipEmail(
  v: PartnershipFormValues,
  meta: PartnershipEmailMeta,
): { subject: string; text: string; html: string } {
  const subject = partnershipSubject(v);
  const rows = partnershipRows(v, meta);
  const heading = "新的異業合作洽詢";
  const hint = "直接按「回覆」就會寄給填表人（reply-to 已設為對方的 Email）。";

  const text = [
    heading,
    "",
    ...rows.map((r) => `${r.label}：${r.value}`),
    "",
    "合作內容說明：",
    v.message,
    "",
    "──",
    hint,
    "這封信由小時光書店官網的異業合作表單自動寄出。",
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
    `<p style="font-size:14px;font-weight:600;margin:0 0 6px">合作內容說明</p>` +
    `<p style="font-size:14px;line-height:1.8;margin:0;white-space:pre-wrap;word-break:break-word">${escapeHtml(v.message)}</p>` +
    `</div>` +
    `<p style="font-size:12px;line-height:1.7;color:#8a8175;margin:24px 0 0;padding-top:12px;border-top:1px solid #e7e1d8">` +
    `${escapeHtml(hint)}<br>這封信由小時光書店官網的異業合作表單自動寄出。</p>` +
    `</div>`;

  return { subject, text, html };
}
