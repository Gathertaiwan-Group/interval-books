/**
 * 「編輯參加者」的伺服器流程（後台 server fn 與 MCP update_registration_participant 共用前半段）。
 *
 *   planRegistrationEdit()               讀現值 → 驗聯絡方式規則 → 算出改了哪些欄位（不寫）
 *   editRegistrationParticipantAsAdmin() 後台：plan → 寫入 → 稽核（client_name='admin_ui'）
 *
 * MCP 那邊的寫入與稽核在 src/server/mcp/ops-write-tools.ts（走 writeMcpAudit，帶 MCP actor）。
 * 授權不在這裡：後台由 adminFnMiddleware、MCP 由 tools.ts 的 add()（唯讀連線擋寫入）負責。
 */
import "@tanstack/react-start/server-only";
import {
  contactFormatErrors,
  contactRequiredError,
  diffParticipantContact,
  normalizeParticipantContact,
  sameParticipantContact,
  type ParticipantContact,
  type ParticipantDiff,
} from "@/lib/admin/registration-edit";
import type { RegistrationForEdit } from "@/server/repos/event-registration-contacts";

export type RegistrationEditPlan =
  | {
      ok: true;
      registration: RegistrationForEdit;
      before: ParticipantContact;
      after: ParticipantContact;
      changes: ParticipantDiff;
    }
  | {
      ok: false;
      reason: "not_found" | "wrong_session" | "stale" | "invalid" | "contact_required";
      message: string;
    };

export const REGISTRATION_EDIT_ERROR_TEXT = {
  not_found: "找不到這位參加者，可能已經被移除。請重新整理名單。",
  wrong_session: "這位參加者不在這個場次的名單上。請重新整理名單。",
  stale: "這位參加者的資料剛被別人改過，請重新整理名單後再改一次。",
} as const;

/**
 * patch 只給要改的欄位（MCP）或三欄全給（後台）。email／phone 給空字串＝清空。
 * sessionId 有給就要對得上（防止拿 A 場次的頁面改到 B 場次的人）。
 *
 * expected＝呼叫端「看到的原值」（後台：打開 Dialog 時；MCP：預覽回傳的 expected）。有給就
 * 先跟資料庫現值比，對不上＝別人在這之間改過 → stale，不會把別人改的欄位蓋回去。
 * 寫入那一句另外再用資料庫原值當條件（repo 的樂觀鎖），擋「比對之後、寫入之前」的那一瞬間。
 */
export async function planRegistrationEdit(input: {
  registrationId: string;
  sessionId?: string;
  expected?: ParticipantContact;
  patch: { name?: string; email?: string; phone?: string };
}): Promise<RegistrationEditPlan> {
  const { loadRegistrationForEdit } = await import("@/server/repos/event-registration-contacts");
  const reg = await loadRegistrationForEdit(input.registrationId);
  if (!reg)
    return { ok: false, reason: "not_found", message: REGISTRATION_EDIT_ERROR_TEXT.not_found };
  if (input.sessionId && reg.session_id !== input.sessionId) {
    return {
      ok: false,
      reason: "wrong_session",
      message: REGISTRATION_EDIT_ERROR_TEXT.wrong_session,
    };
  }
  const before = normalizeParticipantContact(reg);
  if (input.expected && !sameParticipantContact(input.expected, before)) {
    return { ok: false, reason: "stale", message: REGISTRATION_EDIT_ERROR_TEXT.stale };
  }
  const after = normalizeParticipantContact({
    name: input.patch.name ?? before.name,
    email: input.patch.email !== undefined ? input.patch.email : before.email,
    phone: input.patch.phone !== undefined ? input.patch.phone : before.phone,
  });
  // 格式只驗有改的欄位（舊資料不擋）。
  const fmt = contactFormatErrors(before, after);
  const fmtMsg = [fmt.email, fmt.phone].filter(Boolean).join("；");
  if (fmtMsg) return { ok: false, reason: "invalid", message: fmtMsg };
  const contactErr = contactRequiredError(after, reg.order_source);
  if (contactErr) return { ok: false, reason: "contact_required", message: contactErr };
  return {
    ok: true,
    registration: reg,
    before,
    after,
    changes: diffParticipantContact(before, after),
  };
}

export type AdminEditResult =
  | { reason: "updated"; fields: string[]; audit: "recorded" | "log_only" }
  | { reason: "unchanged" }
  | {
      reason: "not_found" | "wrong_session" | "contact_required" | "stale" | "invalid";
      message: string;
    };

export async function editRegistrationParticipantAsAdmin(
  data: {
    registrationId: string;
    sessionId: string;
    expected: ParticipantContact;
    name: string;
    email: string;
    phone: string;
  },
  admin: { userId: string; email: string },
): Promise<AdminEditResult> {
  const plan = await planRegistrationEdit({
    registrationId: data.registrationId,
    sessionId: data.sessionId,
    expected: data.expected,
    patch: { name: data.name, email: data.email, phone: data.phone },
  });
  if (!plan.ok) return { reason: plan.reason, message: plan.message };
  const fields = Object.keys(plan.changes);
  if (fields.length === 0) return { reason: "unchanged" };

  const { updateRegistrationContact, writeAdminRegistrationEditAudit } =
    await import("@/server/repos/event-registration-contacts");
  const res = await updateRegistrationContact({
    registrationId: plan.registration.id,
    match: {
      name: plan.registration.name,
      email: plan.registration.email,
      phone: plan.registration.phone,
    },
    after: plan.after,
  });
  if (res === "stale") return { reason: "stale", message: REGISTRATION_EDIT_ERROR_TEXT.stale };
  if (res === "contact_required") {
    return { reason: "contact_required", message: contactRequiredError(plan.after, null) ?? "" };
  }
  const audit = await writeAdminRegistrationEditAudit({
    actor: admin,
    registrationId: plan.registration.id,
    orderNo: plan.registration.order_no,
    sessionId: plan.registration.session_id,
    action: "update_participant",
    changes: plan.changes,
  });
  return { reason: "updated", fields, audit };
}
