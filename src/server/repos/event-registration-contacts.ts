/**
 * 報名名單「編輯參加者」的資料層：改一位參加者的姓名／Email／電話（2026-11-05）。
 *
 * ── 為什麼是一個新檔案 ──────────────────────────────────────────────────────
 * src/server/repos/event-registrations.ts 的規矩是「這個檔案不寫入」；
 * event-registrations-admin.ts 的規矩是「只做移除單筆這一件事」。改聯絡資料不碰名額
 * （seats_taken／units_taken 與「有幾位參加者」的不變量只跟 insert／delete 有關，update 三個
 * 文字欄位不影響它），所以不需要加鎖 RPC，也不該混進那兩個檔案讓它們的那句話變成假的。
 *
 * ── 只改三個欄位 ────────────────────────────────────────────────────────────
 * updateRegistrationContact() 的 update payload **只有** name／email／phone 三個鍵：
 * order_id、session_id、order_item_id、seat_no、notice_ack_at 與訂單／付款／金額相關的任何
 * 東西都不會被寫到（scripts/registration-edit-selftest.mjs 守著）。
 *
 * ── 並行保護（兩層）────────────────────────────────────────────────────────
 *   1. src/server/registration-edit.ts 的 planRegistrationEdit()：呼叫端帶「看到的原值」
 *      （後台＝打開 Dialog 時、MCP＝預覽回傳的 expected），跟資料庫現值對不上 → stale。
 *      這一層擋「A、B 同時開 Dialog，B 先存、A 後存」把 B 改的欄位蓋回去。
 *   2. 這裡的 update 帶資料庫原值三欄當條件：擋「比對之後、寫入之前」被改的那一瞬間。
 *      0 列更新 → stale，請店員重新整理。
 *
 * ── 稽核 ────────────────────────────────────────────────────────────────────
 * 這個站沒有後台寫入的稽核表，唯一的寫入稽核表是 mcp_audit_log（0039／0054，append-only）。
 * 後台這一條也記進那張表：actor_user_id／actor_email＝那位 admin、client_name='admin_ui'、
 * tool='admin_update_registration_participant'。actor_role 被 0039 的 CHECK 釘死成 'mcp'
 * （沒有 DDL 權限放寬），查詢時請用 client_name='admin_ui' 分辨。
 * changes 存 { 欄位: {before, after} }（業主 2026-11-05 要求記前後值）。
 * 伺服器 log 只印欄位名，不印值（log 規矩同 event-registrations.ts 第 3 條）。
 *
 * ⚠️ console.error 只印 error.code 與 error.message，不印整包 error（PostgREST 的 DETAIL
 *    可能帶著參加者姓名與電話）。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { ParticipantContact, ParticipantDiff } from "@/lib/admin/registration-edit";

export type RegistrationForEdit = {
  id: string;
  session_id: string;
  order_id: string;
  seat_no: number;
  name: string;
  email: string | null;
  phone: string | null;
  order_no: string | null;
  /** orders.source（'web'／'admin_phone'…）。決定 Email 與電話能不能都空（0051 觸發器）。 */
  order_source: string | null;
};

const REG_COLUMNS = "id, session_id, order_id, seat_no, name, email, phone";

type RegRow = Omit<RegistrationForEdit, "order_no" | "order_source">;

function fail(what: string, error: { code?: string; message?: string }): never {
  console.error(
    `[repo/event-registration-contacts] ${what}失敗：${error.code ?? "?"} ${error.message ?? ""}`,
  );
  throw new Error(`[repo/event-registration-contacts] ${what}失敗：${error.code ?? "?"}`);
}

async function withOrder(rows: RegRow[]): Promise<RegistrationForEdit[]> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.order_id))];
  const { data, error } = await supabaseAdmin()
    .from("orders")
    .select("id, order_no, source")
    .in("id", ids);
  if (error) fail("讀訂單", error);
  const byId = new Map(
    ((data ?? []) as { id: string; order_no: string | null; source: string | null }[]).map((o) => [
      o.id,
      o,
    ]),
  );
  return rows.map((r) => ({
    ...r,
    order_no: byId.get(r.order_id)?.order_no ?? null,
    order_source: byId.get(r.order_id)?.source ?? null,
  }));
}

/** 一位參加者（含所屬訂單編號與來源）。找不到 → null。 */
export async function loadRegistrationForEdit(
  registrationId: string,
): Promise<RegistrationForEdit | null> {
  const { data, error } = await supabaseAdmin()
    .from("event_registrations")
    .select(REG_COLUMNS)
    .eq("id", registrationId)
    .maybeSingle();
  if (error) fail("讀參加者", error);
  if (!data) return null;
  const [row] = await withOrder([data as unknown as RegRow]);
  return row ?? null;
}

/** 用訂單編號＋目前姓名找參加者（MCP 定位用）。可能 0、1 或多位。 */
export async function findRegistrationsByOrderNoAndName(
  orderNo: string,
  name: string,
): Promise<RegistrationForEdit[]> {
  const db = supabaseAdmin();
  const { data: order, error: oErr } = await db
    .from("orders")
    .select("id")
    .eq("order_no", orderNo)
    .maybeSingle();
  if (oErr) fail("讀訂單", oErr);
  if (!order) return [];
  const { data, error } = await db
    .from("event_registrations")
    .select(REG_COLUMNS)
    .eq("order_id", (order as { id: string }).id);
  if (error) fail("讀參加者", error);
  const target = name.trim();
  const rows = ((data ?? []) as unknown as RegRow[]).filter((r) => r.name.trim() === target);
  return withOrder(rows);
}

export type UpdateContactResult = "updated" | "stale" | "contact_required";

/**
 * 寫入：只改 name／email／phone 三欄，條件帶改前值（樂觀鎖）。
 * contact_required＝觸發器 event_registrations_contactable 擋下（Email 與電話都空、不是電話報名）。
 */
export async function updateRegistrationContact(input: {
  registrationId: string;
  /**
   * 樂觀鎖條件：**資料庫讀出來的原值**（loadRegistrationForEdit 的 name／email／phone，未經
   * trim／normalize）。用正規化過的值會對不上帶全形空白等字元的舊資料，永遠回 stale。
   */
  match: { name: string; email: string | null; phone: string | null };
  after: ParticipantContact;
}): Promise<UpdateContactResult> {
  const { match: before, after } = input;
  // ⚠️ payload 只有這三個鍵。不要在這裡加任何欄位。
  const payload = { name: after.name, email: after.email, phone: after.phone };
  let q = supabaseAdmin()
    .from("event_registrations")
    .update(payload)
    .eq("id", input.registrationId)
    .eq("name", before.name);
  q = before.email === null ? q.is("email", null) : q.eq("email", before.email);
  q = before.phone === null ? q.is("phone", null) : q.eq("phone", before.phone);
  const { data, error } = await q.select("id");
  if (error) {
    if (error.code === "23514") return "contact_required";
    fail("更新參加者", error);
  }
  return Array.isArray(data) && data.length > 0 ? "updated" : "stale";
}

/**
 * 後台（不是 MCP）改參加者的稽核：寫進 mcp_audit_log，client_name='admin_ui'。
 * 永不 throw：寫入已經成功，稽核失敗只回 "log_only"（同 src/server/mcp/audit.ts 的立場）。
 */
export async function writeAdminRegistrationEditAudit(entry: {
  actor: { userId: string; email: string };
  registrationId: string;
  orderNo: string | null;
  sessionId: string;
  action: string;
  changes: ParticipantDiff;
  extra?: Record<string, unknown>;
}): Promise<"recorded" | "log_only"> {
  const record = {
    actor_role: "mcp" as const,
    tool: "admin_update_registration_participant",
    entity: "event_registration",
    entity_id: entry.registrationId,
    action: entry.action,
    changes: {
      registration_id: entry.registrationId,
      order_no: entry.orderNo,
      session_id: entry.sessionId,
      fields: entry.changes,
      ...(entry.extra ?? {}),
    },
    dry_run: false,
    actor_via: null,
    actor_user_id: entry.actor.userId,
    actor_email: entry.actor.email,
    client_name: "admin_ui",
  };
  try {
    // 伺服器 log 只印欄位名，不印值（個資不進 Vercel log）。
    console.info(
      `[admin-audit] ${JSON.stringify({
        at: new Date().toISOString(),
        tool: record.tool,
        action: record.action,
        entity_id: record.entity_id,
        order_no: entry.orderNo,
        fields: Object.keys(entry.changes),
        actor_user_id: entry.actor.userId,
      })}`,
    );
  } catch {
    /* 不可以讓寫入路徑失敗 */
  }
  try {
    const { error } = await supabaseAdmin().from("mcp_audit_log").insert(record);
    if (error) {
      console.error(`[admin-audit] 寫入稽核表失敗（${error.code ?? "?"}）：${error.message}`);
      return "log_only";
    }
    return "recorded";
  } catch (err) {
    console.error(
      `[admin-audit] 寫入稽核表失敗：${err instanceof Error ? err.message : String(err)}`,
    );
    return "log_only";
  }
}
