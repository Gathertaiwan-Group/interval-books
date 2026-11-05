/**
 * 報名名單「編輯參加者」的規則（後台名單頁的 Dialog、server fn、MCP
 * update_registration_participant 三邊共用）。純模組：只 import zod 與 partnership.ts 的
 * singleLine()，瀏覽器與伺服器都可以用。
 *
 * ── 能改什麼 ────────────────────────────────────────────────────────────────
 * 只有參加者本人的三個欄位：姓名、Email、電話（event_registrations.name／email／phone）。
 * 「換人」就是在同一列改這三欄。訂單、付款狀態、金額、名額、order_id、session_id、
 * seat_no、notice_ack_at 一律不動——寫入那一句的 payload 只有這三個鍵（見
 * src/server/repos/event-registration-contacts.ts，自檢守著）。
 *
 * 名單上「注意事項」那一欄是 notice_ack_at（客人結帳時勾「已閱讀活動注意事項」的時間），
 * 是同意紀錄、不是一段文字，這裡**不提供修改**：改它等於替客人補簽同意。
 *
 * ── 清洗與格式 ──────────────────────────────────────────────────────────────
 * 比照 src/lib/partnership.ts 的 line()：先 singleLine()（控制字元換空白、連續空白壓成一個、
 * trim），再驗長度與格式。長度量的是清洗後真正會存進去的值。
 *   · 姓名：必填，最多 60 字（與電話報名 PARTICIPANT_NAME_MAX 相同）
 *   · Email：可留空；有填要是合法 Email，最多 254 字
 *   · 電話：可留空；只允許數字、空白與 + ( ) - #，最多 30 字
 * 留空存成 null（與 0051 admin_update_phone_order_contacts 相同）。
 *
 * ── 聯絡方式至少一項 ────────────────────────────────────────────────────────
 * 資料庫觸發器 event_registrations_contactable（0051）：Email 與電話都空，只有電話報名
 * （orders.source = 'admin_phone'）的參加者放行，其餘一律拒絕。這裡先用同一條規則給一句
 * 中文（contactRequiredError），觸發器是最後一道。
 */
import { z } from "zod";
import { singleLine } from "@/lib/partnership";

export const PARTICIPANT_EDIT_LIMITS = { name: 60, email: 254, phone: 30 } as const;

/** 與 partnership.ts 的 phone 同一條：數字、空白與 + ( ) - #。 */
export const PARTICIPANT_PHONE_RE = /^[0-9+()\-#\s]*$/;

const isEmail = (v: string) => z.string().email().safeParse(v).success;

const line = (max: number, label: string) =>
  z
    .string({ invalid_type_error: `${label}格式不正確` })
    .transform(singleLine)
    .pipe(z.string().max(max, `${label}最多 ${max} 字`));

export const participantNameSchema = line(PARTICIPANT_EDIT_LIMITS.name, "姓名").pipe(
  z.string().min(1, "姓名不能空白"),
);
export const participantEmailSchema = line(PARTICIPANT_EDIT_LIMITS.email, "Email").refine(
  (v) => v === "" || isEmail(v),
  "Email 格式不正確",
);
export const participantPhoneSchema = line(PARTICIPANT_EDIT_LIMITS.phone, "電話").refine(
  (v) => PARTICIPANT_PHONE_RE.test(v),
  "電話只能填數字、空白與 + ( ) - #",
);

/** 後台 Dialog 送出的完整內容（三欄都帶，空字串＝留空）。 */
export const participantContactSchema = z.object({
  name: participantNameSchema,
  email: participantEmailSchema,
  phone: participantPhoneSchema,
});

/** server fn 的輸入：哪一位（registrationId＋所屬場次）＋三欄新值。 */
export const updateRegistrationParticipantInput = z
  .object({
    registrationId: z.string().trim().uuid("參加者 id 格式不正確"),
    sessionId: z.string().trim().uuid("場次 id 格式不正確"),
  })
  .merge(participantContactSchema)
  .strict();

export type ParticipantContact = { name: string; email: string | null; phone: string | null };
export const PARTICIPANT_FIELDS = ["name", "email", "phone"] as const;
export type ParticipantField = (typeof PARTICIPANT_FIELDS)[number];
export type ParticipantDiff = Partial<
  Record<ParticipantField, { before: string | null; after: string | null }>
>;

const blankToNull = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/** 存進資料庫的樣子：姓名 trim、Email／電話空白 → null。 */
export function normalizeParticipantContact(c: {
  name: string;
  email?: string | null;
  phone?: string | null;
}): ParticipantContact {
  return { name: c.name.trim(), email: blankToNull(c.email), phone: blankToNull(c.phone) };
}

/** 只列出真的有變的欄位。 */
export function diffParticipantContact(
  before: ParticipantContact,
  after: ParticipantContact,
): ParticipantDiff {
  const b = normalizeParticipantContact(before);
  const a = normalizeParticipantContact(after);
  const out: ParticipantDiff = {};
  for (const k of PARTICIPANT_FIELDS) {
    if (b[k] !== a[k]) out[k] = { before: b[k], after: a[k] };
  }
  return out;
}

export const CONTACT_REQUIRED_MESSAGE =
  "這位參加者不是電話報名的，Email 與電話至少要留一項（只有電話報名的同行者可以兩項都空）。";

/** Email 與電話都空、而且不是電話報名的訂單 → 回錯誤訊息；可以存 → null。 */
export function contactRequiredError(
  after: ParticipantContact,
  orderSource: string | null,
): string | null {
  if (after.email || after.phone) return null;
  return orderSource === "admin_phone" ? null : CONTACT_REQUIRED_MESSAGE;
}
