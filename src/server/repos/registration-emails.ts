/**
 * 參加者的明文信箱，**只給 MCP 寄信的兩步確認算「收件人集合雜湊」用**
 * （src/server/mcp/outbound-tools.ts）。結果不回給呼叫端、不進 log、不進稽核。
 *
 * 誰在簽到表上不在這裡判斷：呼叫端傳進來的 id 已經是 loadPaidRosterByOrder()（on_roster）的結果；
 * 真正排信時 enqueue_registration_emails() 在資料庫裡再 join 一次 on_roster。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";

export async function loadRegistrationEmails(registrationIds: string[]): Promise<string[]> {
  if (registrationIds.length === 0) return [];
  const { data, error } = await supabaseAdmin()
    .from("event_registrations")
    .select("id, email")
    .in("id", registrationIds);
  if (error) throw new Error(`[repo/registration-emails] 讀信箱失敗：${error.code ?? "error"}`);
  return ((data ?? []) as { email: string | null }[])
    .map((r) => r.email ?? "")
    .filter((e) => e.trim() !== "");
}
