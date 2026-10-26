/**
 * Data layer for public.event_registrations — the attendee list.
 *
 * ⚠️ 這張表是這個專案第一張「非訂購人的第三人個資」。
 * ------------------------------------------------------
 * 0020 §2 讓它跟 0005 的電商表一樣：**RLS 開著、零 policy、anon 與 authenticated
 * 零 grant**。瀏覽器沒有任何一條查詢打得到它，唯一的入口是 service_role，也就是
 * 這個檔案。所以這裡漏掉什麼，就沒有第二道門會擋。
 *
 * 四條規矩，每一條都對應一個具體的失敗：
 *
 *   1. **遮罩做在 SQL。** loadPaidRoster() / countRegistrationsBySession() 讀的是
 *      0021 §3 的 public.admin_event_roster，遮罩寫在那個 view 的 select list 裡
 *      （inv.mask_email / inv.mask_tail）。
 *
 *      （順帶：Phase 1 那份 TS 遮罩有一個真 bug。`v.slice(-keepTail)` 在
 *      keepTail=0 時等於 `v.slice(0)`，`ab@x.com` 會遮成 `a*ab@x.com`。0021 §2 有寫。）
 *
 *   2. **名單頁與 CSV 匯出直接讀明文，不寫查閱紀錄。**（業主 2026-10-26：「報名名單每打開
 *      一次就記一筆查看紀錄 >> 這功能移除」）
 *      listSessionRoster()  → 直接讀 admin_event_roster＋event_registrations 的 email／phone
 *      loadRosterExport()   → 同上，只取 on_roster 的列，給 CSV 匯出
 *      授權（staffFnMiddleware＋event.roster.read）仍在 src/lib/admin/fns/event-registrations.ts。
 *
 *      ⚠️ 資料庫裡的 public.export_event_roster() 與 public.reveal_registration_contact()
 *         還在（沒有 DDL 權限、也不需要 drop），只是程式不再呼叫——**不要接回來**，
 *         接回來就又會每匯出一次寫一筆 pii_access_log。
 *      ⚠️ 廠商那一側（repos/inv-vendors.ts 的身分證／匯款帳戶「完整號碼」）**照舊**先寫
 *         pii_access_log 再讀，業主這次只撤了報名名單。
 *
 *      店家通知信 loadOrderAttendeesForAdminNotify() 本來就不寫紀錄（業主 2026-10-25）。
 *
 *   3. **console.error 只印 error.code 與 error.message，不印整包 error。**
 *      PostgREST 會把 Postgres 的 `DETAIL: Failing row contains (…)` 一路傳回來，
 *      而對這張表來說那一行就是某個人的姓名與電話。整包記下去就是把參加者的個資
 *      寫進 Vercel 的 log —— 一個沒有保存期限、沒有存取紀錄、也沒有任何人知道它在
 *      那裡的地方。scripts/event-registration-selftest.mjs 有靜態測試守著這一條。
 *
 *   4. **這個檔案不寫入。** 報名資料只由 reserve_session_seat() 寫、只由
 *      release_session_seat() 與 expire_unpaid_orders() 刪，因為「佔了 N 個位子」
 *      與「有 N 位參加者」必須是同一句 SQL 的兩個面向（0020 §2）。這裡多一條
 *      insert 或 delete，那個不變量就沒了。
 *
 *      0035 加了第五個、也是目前唯一的例外：admin 移除單筆報名。合法路徑是
 *      src/server/repos/event-registrations-admin.ts 的 deleteAdminRegistration()
 *      （呼叫 public.admin_delete_registration()）——它跟 release_session_seat()
 *      一樣，刪一列與扣 1 個 seats_taken 是同一句 SQL，只是粒度改成單一列而不是
 *      整個 order_item。**不要把它加進這個檔案**，理由同上：這個檔案的角色就是
 *      「只讀」，那句話一旦有例外就會有人以為多加一個 delete 也沒關係。
 *
 * ── 「誰在簽到表上」只定義一次 ─────────────────────────────────────────────
 *
 * `on_roster` 這個欄位在 0021 §3 的 view 裡算出來（`payment_status = 'paid'`），
 * 這個檔案只是 `.eq("on_roster", true)`。快樂手在 queries.ts:117-125 用一段紅字
 * 註解要求「簽到表與提醒信必須用同一個條件」，靠的是下一個人會讀到那段註解；
 * 這裡讓那個條件只存在一份，所以沒有第二個地方可以寫錯。
 *
 * 三個消費端，各自走哪裡（**不要寫成「三邊都走 loadPaidRoster」，那不是實話**）：
 *
 *   名單頁     → listSessionRoster()：回**全部**報名（明文），畫面自己用 on_roster 分。
 *   CSV 匯出   → loadRosterExport()：`.eq("on_roster", true)`。
 *   Phase 3    → loadPaidRoster()：目前**零呼叫端**，是為提醒信預留的。
 *   店家通知信 → loadOrderAttendeesForAdminNotify()：一張訂單的**全部**報名（明文），
 *               不篩 on_roster（待收款那封寄出時還沒付款）。不是簽到表。
 *
 * 三邊共用的是那個 `on_roster` 欄位，不是同一支 TypeScript 函式 —— 而共用欄位
 * 比共用函式更硬，因為 SQL 那一側也繞不過去。
 *
 * ⚠️ **Phase 3 的提醒信要用 loadPaidRoster()，不要自己另外寫一次條件。** 否則
 *    會出現「有人收到提醒卻不在簽到表上」—— 那正是快樂手那段註解在防的事。
 *
 * 保留期限：**不做自動清除**，與 orders 一致（業務紀錄，商業會計法五年）。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";
import type { AdminOrderAttendee } from "@/lib/email-templates";

/**
 * 0021 §3 的 public.admin_event_roster。名單的中繼資料（訂單、付款狀態、on_roster）
 * 從這裡讀；明文 email／phone 另外從 event_registrations 讀（見 listSessionRoster）。
 */
const ROSTER_COLUMNS =
  "registration_id, session_id, order_id, order_item_id, seat_no, name, email_masked, phone_masked, has_email, has_phone, notice_ack_at, created_at, order_no, payment_status, paid_at, on_roster";

/** view 的一列（遮罩值）。只在這個檔案內部用；loadPaidRoster*() 回這個形狀。 */
export type RosterViewRow = {
  registration_id: string;
  session_id: string;
  order_id: string;
  order_item_id: number;
  seat_no: number;
  name: string;
  email_masked: string | null;
  phone_masked: string | null;
  has_email: boolean;
  has_phone: boolean;
  notice_ack_at: string | null;
  created_at: string;
  order_no: string;
  payment_status: string;
  paid_at: string | null;
  on_roster: boolean;
};

/** 名單頁看得到的一列。**email／phone 是明文**（業主 2026-10-25；2026-10-26 起不寫紀錄）。 */
export type RegistrationRosterRow = {
  registration_id: string;
  session_id: string;
  order_id: string;
  order_item_id: number;
  seat_no: number;
  /** 全名。 */
  name: string;
  /** 明文。null＝沒填。 */
  email: string | null;
  /** 明文。null＝沒填。 */
  phone: string | null;
  /** 只回「有沒有同意」與「什麼時候」，那不是敏感值。 */
  notice_ack_at: string | null;
  created_at: string;
  /** 這一列屬於哪一張訂單，讓店員對得回去。 */
  order_no: string;
  payment_status: string;
  paid_at: string | null;
  /** 「這一列算不算在簽到表上」的唯一定義（0021 §3）。 */
  on_roster: boolean;
};

/** CSV 匯出的一列（欄位與舊的 SQL export_event_roster() 相同）。**這裡面是明文。** */
export type RosterExportRow = {
  registration_id: string;
  seat_no: number;
  name: string;
  email: string | null;
  phone: string | null;
  notice_ack_at: string | null;
  order_no: string;
  paid_at: string | null;
  created_at: string;
};

/** loadRosterExport() 的整包回傳。 */
export type RosterExport = {
  session_id: string;
  session_title: Localized;
  starts_at: string;
  capacity: number;
  seats_taken: number;
  rows: RosterExportRow[];
};

/**
 * 一個場次的名單，**明文**聯絡方式。不寫 pii_access_log（業主 2026-10-26）。
 *
 * ⚠️ 回的是**所有**報名，包含未付款與已取消的訂單，而且每一列都帶著
 *    `payment_status` 與 `on_roster` 讓畫面自己分 —— 後台需要看得到「有 3 個位子
 *    被未付款的訂單押著」。
 *
 * 權限檢查不在這裡，在 src/lib/admin/fns/event-registrations.ts（那一層才拿得到
 * session）。
 */
export async function listSessionRoster(sessionId: string): Promise<RegistrationRosterRow[]> {
  const db = supabaseAdmin();
  const [viewRes, plainRes] = await Promise.all([
    db
      .from("admin_event_roster")
      .select(ROSTER_COLUMNS)
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .order("seat_no", { ascending: true }),
    db.from("event_registrations").select("id, email, phone").eq("session_id", sessionId),
  ]);

  if (viewRes.error) {
    console.error(
      `[repo/event-registrations] roster 失敗：${viewRes.error.code} ${viewRes.error.message}`,
    );
    throw new Error(`[repo/event-registrations] roster 失敗：${viewRes.error.code}`);
  }
  if (plainRes.error) {
    console.error(
      `[repo/event-registrations] roster 聯絡方式失敗：${plainRes.error.code} ${plainRes.error.message}`,
    );
    throw new Error(`[repo/event-registrations] roster 聯絡方式失敗：${plainRes.error.code}`);
  }

  const contact = new Map<string, { email: string | null; phone: string | null }>();
  for (const r of (plainRes.data ?? []) as {
    id: string;
    email: string | null;
    phone: string | null;
  }[]) {
    contact.set(r.id, { email: blankToNull(r.email), phone: blankToNull(r.phone) });
  }

  return ((viewRes.data ?? []) as unknown as RosterViewRow[]).map((v) => {
    const c = contact.get(v.registration_id);
    return {
      registration_id: v.registration_id,
      session_id: v.session_id,
      order_id: v.order_id,
      order_item_id: v.order_item_id,
      seat_no: v.seat_no,
      name: v.name,
      email: c?.email ?? null,
      phone: c?.phone ?? null,
      notice_ack_at: v.notice_ack_at,
      created_at: v.created_at,
      order_no: v.order_no,
      payment_status: v.payment_status,
      paid_at: v.paid_at,
      on_roster: v.on_roster,
    };
  });
}

function blankToNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * 簽到表的那一句查詢。**整個檔案只有這裡過濾 on_roster。**
 *
 * 兩個公開入口（依場次、依訂單）共用它，所以「誰在簽到表上」在 TypeScript 這一側
 * 也只寫了一次 —— 條件本身仍然只定義在 0021 §3 的 view 裡（`payment_status =
 * 'paid'`），這裡連那個字面值都沒有。
 *
 * 快樂手 apps/web/app/admin/sessions/queries.ts:117-125 的原話：
 * 「apps/worker/src/jobs/workshop-reminders.ts 寄開課提醒用的是同一個條件，
 *   兩邊一致才不會發生『有人收到提醒卻不在簽到表上』。」
 * 那句話在那邊是註解，在這裡是結構。
 *
 * 回的仍然是**遮罩過的**列：知道「有誰」不需要看到聯絡方式。
 *
 * ⚠️ Phase 3 的信**不需要**明文 —— 排信只送 registration_id 進去，地址由
 *    0022 §7 的 enqueue_registration_emails() 在資料庫裡 join。所以「寄信」這件事
 *    完全不必經過名單頁或 CSV 匯出。
 */
async function queryPaidRoster(
  column: "session_id" | "order_id",
  value: string,
): Promise<RosterViewRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("admin_event_roster")
    .select(ROSTER_COLUMNS)
    .eq(column, value)
    .eq("on_roster", true)
    .order("created_at", { ascending: true })
    .order("seat_no", { ascending: true });

  if (error) {
    console.error(`[repo/event-registrations] paid roster 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/event-registrations] paid roster 失敗：${error.code}`);
  }
  return (data ?? []) as unknown as RosterViewRow[];
}

/**
 * 簽到表：這一場**會來的人**。活動前 24 小時的提醒信用這一支決定寄給誰
 * （src/server/notify.ts 的 runSessionReminders）。
 *
 * 畫面走 listSessionRoster()（它要看得到未付款的列），CSV 走 loadRosterExport()
 * （`.eq("on_roster", true)`）。三邊共用的是 view 上那個 on_roster 欄位。
 */
export async function loadPaidRoster(sessionId: string): Promise<RosterViewRow[]> {
  return queryPaidRoster("session_id", sessionId);
}

/**
 * 同一張簽到表，換一把鑰匙：**這一張訂單**上會來的人。
 *
 * 付款成功的當下要寄「報名成功」給每一位參加者，而那時候手上的是 order_id 不是
 * session_id（一張訂單可以買到兩個不同場次的位子）。用 session 去查會撈到別人的
 * 報名，所以需要這一把。
 *
 * 它與 loadPaidRoster() 是同一句 SQL 的兩個入口，不是第二份條件。
 */
export async function loadPaidRosterByOrder(orderId: string): Promise<RosterViewRow[]> {
  return queryPaidRoster("order_id", orderId);
}

/**
 * 這張訂單上的每一位參加者，依場次分組——店家通知信用。
 *
 * **明文**，直接讀 event_registrations 本表，**不寫** pii_access_log：業主
 * 2026-10-25 決定店家通知信不遮罩、不留紀錄。這是系統把資料寫進店家自己的信，
 * 不是有人在後台查這個人（0019 §1.1 的線）。收件人是 site_settings.notify_emails。
 *
 * ⚠️ **不篩 on_roster**：匯款待收款那封（atOrderTime）寄出時訂單還沒付款，篩了就
 *    一個人都拿不到。這是「這張訂單填了誰」，不是「誰在簽到表上」——簽到表、提醒信
 *    與報名成功信仍然走 loadPaidRoster*()。
 *
 * 不 throw；讀失敗回空 Map（信照寄，只印人數）。
 */
export async function loadOrderAttendeesForAdminNotify(
  orderId: string,
): Promise<Map<string, AdminOrderAttendee[]>> {
  const out = new Map<string, AdminOrderAttendee[]>();
  try {
    const { data, error } = await supabaseAdmin()
      .from("event_registrations")
      .select("session_id, name, phone, email, seat_no, created_at")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true })
      .order("seat_no", { ascending: true });
    if (error) {
      console.error(
        `[repo/event-registrations] 店家信讀參加者失敗 order=${orderId}：${error.code} ${error.message}`,
      );
      return out;
    }
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const sid = String(r.session_id ?? "");
      if (!sid) continue;
      const list = out.get(sid) ?? [];
      list.push({
        name: String(r.name ?? "").trim(),
        phone: blankToNull(r.phone),
        email: blankToNull(r.email),
      });
      out.set(sid, list);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[repo/event-registrations] 店家信讀參加者發生例外 order=${orderId}：${message}`);
  }
  return out;
}

/**
 * 每個場次有幾位報名、其中幾位在簽到表上。
 *
 * 場次列表要顯示這兩個數字，而 `event_sessions.seats_taken` 是**第三個**數字 ——
 * 它回答的是「押住了幾個位子」，不是「有幾個人」。0020 §4.4 回填的舊場次只補
 * 一位參加者（捏造另外兩位是說謊），所以那些場次上三個數字本來就不一樣，畫面必須
 * 看得出來（「另有 N 位未登錄姓名」）。
 *
 * 沒有 group by 就自己數：PostgREST 沒有便宜的 group by，而場次是幾十列的量級。
 * 同 src/server/repos/events.ts 的 countEventsByCategory()。
 */
export async function countRegistrationsBySession(): Promise<
  Record<string, { total: number; paid: number }>
> {
  const { data, error } = await supabaseAdmin()
    .from("admin_event_roster")
    .select("session_id, on_roster");

  if (error) {
    console.error(`[repo/event-registrations] count 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/event-registrations] count 失敗：${error.code}`);
  }

  const rows = (data ?? []) as unknown as { session_id: string; on_roster: boolean }[];
  const counts: Record<string, { total: number; paid: number }> = {};
  for (const r of rows) {
    const entry = (counts[r.session_id] ??= { total: 0, paid: 0 });
    entry.total += 1;
    if (r.on_roster) entry.paid += 1;
  }
  return counts;
}

/**
 * 整場的明文名單（只含 on_roster 的列），給 CSV 匯出用。不寫 pii_access_log
 * （業主 2026-10-26）。
 *
 * 欄位、排序（created_at, seat_no）、只取 on_roster、姓名取 event_registrations 本表，
 * 都與資料庫裡那支已經不用的 public.export_event_roster() 一致，CSV 一欄都沒變。
 *
 * ⚠️ 整份名單會進到這個 Node 行程的記憶體。那是「CSV 做成 server fn 而不是 HTTP
 *    路由」的代價，而書店一場 20–60 人可以忽略。
 */
export async function loadRosterExport(sessionId: string): Promise<RosterExport> {
  const db = supabaseAdmin();
  const [sessionRes, viewRes, plainRes] = await Promise.all([
    db
      .from("event_sessions")
      .select("id, title, starts_at, capacity, seats_taken")
      .eq("id", sessionId)
      .maybeSingle(),
    db
      .from("admin_event_roster")
      .select("registration_id, seat_no, notice_ack_at, order_no, paid_at, created_at")
      .eq("session_id", sessionId)
      .eq("on_roster", true)
      .order("created_at", { ascending: true })
      .order("seat_no", { ascending: true }),
    db.from("event_registrations").select("id, name, email, phone").eq("session_id", sessionId),
  ]);

  for (const [label, res] of [
    ["場次", sessionRes],
    ["名單", viewRes],
    ["聯絡方式", plainRes],
  ] as const) {
    if (res.error) {
      console.error(
        `[repo/event-registrations] export ${label}失敗：${res.error.code} ${res.error.message}`,
      );
      throw new Error("名單匯出失敗");
    }
  }
  const session = sessionRes.data as {
    id: string;
    title: Localized;
    starts_at: string;
    capacity: number;
    seats_taken: number;
  } | null;
  if (!session) throw new Error("找不到這個場次");

  const plain = new Map<string, { name: string; email: string | null; phone: string | null }>();
  for (const r of (plainRes.data ?? []) as {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
  }[]) {
    plain.set(r.id, { name: r.name, email: r.email, phone: r.phone });
  }

  const rows: RosterExportRow[] = [];
  for (const v of (viewRes.data ?? []) as unknown as {
    registration_id: string;
    seat_no: number;
    notice_ack_at: string | null;
    order_no: string;
    paid_at: string | null;
    created_at: string;
  }[]) {
    // SQL 版是 inner join：event_registrations 沒有對應的列就不出現。
    const p = plain.get(v.registration_id);
    if (!p) continue;
    rows.push({
      registration_id: v.registration_id,
      seat_no: v.seat_no,
      name: p.name,
      email: p.email,
      phone: p.phone,
      notice_ack_at: v.notice_ack_at,
      order_no: v.order_no,
      paid_at: v.paid_at,
      created_at: v.created_at,
    });
  }

  return {
    session_id: session.id,
    session_title: session.title,
    starts_at: session.starts_at,
    capacity: session.capacity,
    seats_taken: session.seats_taken,
    rows,
  };
}
