/**
 * 報名名單「編輯參加者」的 server fn（2026-11-05）。
 *
 * 權限：adminFnMiddleware —— 與「移除報名」（deleteAdminRegistration）同一層。改參加者的
 * 聯絡資料是會永久改變資料的動作，跟「查看名單」（staff＋event.roster.read）不是同一個
 * 授權層級。畫面只對 admin 顯示「編輯」按鈕，但那只是畫面；擋人的是這裡。
 *
 * 只改姓名／Email／電話三欄（規則在 src/lib/admin/registration-edit.ts，寫入在
 * src/server/repos/event-registration-contacts.ts）。訂單、付款、金額、名額、order_id、
 * session_id 一律不動。每次實際修改寫一筆 mcp_audit_log（client_name='admin_ui'，
 * changes 記前後值）。
 */
import { createServerFn } from "@tanstack/react-start";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { updateRegistrationParticipantInput } from "@/lib/admin/registration-edit";

export type { AdminEditResult as UpdateRegistrationParticipantResult } from "@/server/registration-edit";

export const updateRegistrationParticipant = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(updateRegistrationParticipantInput)
  .handler(async ({ data, context }) => {
    const { editRegistrationParticipantAsAdmin } = await import("@/server/registration-edit");
    return await editRegistrationParticipantAsAdmin(data, context.admin);
  });
