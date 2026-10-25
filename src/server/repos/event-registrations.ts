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
 *   1. **遮罩做在 SQL，不在這裡。** listSessionRoster() / loadPaidRoster() 讀的是
 *      0021 §3 的 public.admin_event_roster，遮罩寫在那個 view 的 select list 裡
 *      （inv.mask_email / inv.mask_tail）。這個檔案從此**看不到明文**，除非走
 *      下面第 2 條那兩支。
 *
 *      Phase 1 曾經把遮罩做在這裡（maskTail / maskEmail 兩個函式），那是當時寫明
 *      的折衷：明文會進到 Node 行程的記憶體，只是沒有離開它。0021 建好 view 之後
 *      那兩支已經整段刪掉 —— 兩份實作同時存在的期間只有一期。
 *
 *      （順帶：那份 TS 有一個真 bug。`v.slice(-keepTail)` 在 keepTail=0 時等於
 *      `v.slice(0)`，整個 local part 又被接回去一次，`ab@x.com` 會遮成
 *      `a*ab@x.com`。SQL 的 `right(v, 0)` 沒有這個坑。0021 §2 有寫。）
 *
 *   2. **明文只有兩個出口，而且兩個都一定留下紀錄。**
 *      revealRegistrationContact() → public.reveal_registration_contact()
 *      exportEventRoster()         → public.export_event_roster()
 *      兩支 SQL 函式都在同一個交易裡**先寫一筆 public.pii_access_log 再組值**
 *      （0019 §4.1 的形狀），所以「拿到值但沒留下紀錄」在結構上不可能發生。
 *
 *      ⚠️ **不要在這個檔案裡加第三支讀明文的函式。** 加了就等於多一條不留痕的路，
 *         而稽核軌跡只要有一條旁路就等於沒有（0019 對 repos/inv-vendors.ts 的
 *         原話）。
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
 *   名單頁     → listSessionRoster()：回**全部**報名，畫面自己用 on_roster 分。
 *   CSV 匯出   → SQL 的 export_event_roster()：它自己 `where v.on_roster`。
 *   Phase 3    → loadPaidRoster()：目前**零呼叫端**，是為提醒信預留的。
 *   店家通知信 → loadOrderAttendeesForAdminNotify()：一張訂單的**全部**報名（遮罩值），
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
 * 0021 §3 的 public.admin_event_roster。
 *
 * ⚠️ 這個字串裡**沒有** `email` 與 `phone`。那兩個名字在 view 裡根本不存在
 *    （view 只 select 出 email_masked / phone_masked），所以就算有人手滑加進來，
 *    PostgREST 回的是 400 而不是明文。
 */
const ROSTER_COLUMNS =
  "registration_id, session_id, order_id, order_item_id, seat_no, name, email_masked, phone_masked, has_email, has_phone, notice_ack_at, created_at, order_no, payment_status, paid_at, on_roster";

/** 名單頁看得到的一列。沒有明文 email / phone。 */
export type RegistrationRosterRow = {
  registration_id: string;
  session_id: string;
  order_id: string;
  order_item_id: number;
  seat_no: number;
  /** 全名，不遮罩 —— 遮了現場點不了名（同 0019 對廠商名稱的處置）。 */
  name: string;
  email_masked: string | null;
  phone_masked: string | null;
  /** 「沒填」與「填了但你看不到」在畫面上要長得不一樣。 */
  has_email: boolean;
  has_phone: boolean;
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

/** reveal_registration_contact() 的回傳。**這裡面是明文。** */
export type RegistrationContact = {
  registration_id: string;
  session_id: string;
  seat_no: number;
  /** 這一次查閱的 pii_access_log id。畫面會把它印出來。 */
  log_id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

/** export_event_roster() 回的一列。**這裡面是明文。** */
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

/** export_event_roster() 的整包回傳。 */
export type RosterExport = {
  session_id: string;
  session_title: Localized;
  starts_at: string;
  capacity: number;
  seats_taken: number;
  log_id: string;
  rows: RosterExportRow[];
};

/**
 * 一個場次的名單，遮罩過。
 *
 * ⚠️ 回的是**所有**報名，包含未付款與已取消的訂單，而且每一列都帶著
 *    `payment_status` 與 `on_roster` 讓畫面自己分。簽到表只算 on_roster，但那是
 *    簽到表的規則，不是這支查詢的規則 —— 後台需要看得到「有 3 個位子被未付款的
 *    訂單押著」，否則「為什麼還有 3 個位子卻報不了名」這個問題沒有地方可以回答。
 *
 * 0021 之後這裡只有一次查詢：訂單編號與付款狀態已經 join 在 view 裡了。Phase 1
 * 分兩次查是為了避開 PostgREST 巢狀 select 會把 orders 整列（含訂購人姓名電話）
 * 拉回來的問題，view 沒有那個問題 —— 它只 select 了 order_no 與 payment_status。
 */
export async function listSessionRoster(sessionId: string): Promise<RegistrationRosterRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("admin_event_roster")
    .select(ROSTER_COLUMNS)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .order("seat_no", { ascending: true });

  if (error) {
    console.error(`[repo/event-registrations] roster 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/event-registrations] roster 失敗：${error.code}`);
  }
  return (data ?? []) as unknown as RegistrationRosterRow[];
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
 * 回的仍然是**遮罩過的**列：知道「有誰」不需要看到聯絡方式。要明文就走
 * exportEventRoster()，而那會留下一筆紀錄。
 *
 * ⚠️ Phase 3 的信**不需要**明文 —— 排信只送 registration_id 進去，地址由
 *    0022 §7 的 enqueue_registration_emails() 在資料庫裡 join。所以「寄信」這件事
 *    完全不必經過那兩個會寫 pii_access_log 的出口，而那是對的：系統為了寄信而
 *    使用地址，與「有人在查這個人的資料」不是同一件事（0019 §1.1 的線）。
 */
async function queryPaidRoster(
  column: "session_id" | "order_id",
  value: string,
): Promise<RegistrationRosterRow[]> {
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
  return (data ?? []) as unknown as RegistrationRosterRow[];
}

/**
 * 簽到表：這一場**會來的人**。活動前 24 小時的提醒信用這一支決定寄給誰
 * （src/server/notify.ts 的 runSessionReminders）。
 *
 * 畫面走 listSessionRoster()（它要看得到未付款的列），CSV 走 SQL 的
 * export_event_roster()（它自己 `where v.on_roster`）。三邊共用的是 view 上那個
 * on_roster 欄位。
 */
export async function loadPaidRoster(sessionId: string): Promise<RegistrationRosterRow[]> {
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
export async function loadPaidRosterByOrder(orderId: string): Promise<RegistrationRosterRow[]> {
  return queryPaidRoster("order_id", orderId);
}

/**
 * 這張訂單上的每一位參加者，依場次分組——店家通知信用。
 *
 * 讀的是 0021 §3 的 public.admin_event_roster（**遮罩過的** view），不是
 * event_registrations 本表：明文的出口只有 reveal_registration_contact()／
 * export_event_roster()，而那兩支一定寫 pii_access_log（0021 §0.1）。這裡不開第三條
 * 不留痕的路，所以信裡的參加者電話／信箱是遮罩值、姓名是全名（同名單頁）。
 *
 * ⚠️ **不篩 on_roster**：匯款待收款那封（atOrderTime）寄出時訂單還沒付款，篩了就
 *    一個人都拿不到。這是「這張訂單填了誰」，不是「誰在簽到表上」——簽到表、提醒信
 *    與報名成功信仍然走 event-registrations.ts 的 loadPaidRoster*()。
 *
 * 不 throw；讀失敗回空 Map（信照寄，只印人數）。
 */
export async function loadOrderAttendeesForAdminNotify(
  orderId: string,
): Promise<Map<string, AdminOrderAttendee[]>> {
  const out = new Map<string, AdminOrderAttendee[]>();
  try {
    const { data, error } = await supabaseAdmin()
      .from("admin_event_roster")
      .select("session_id, name, phone_masked, email_masked, seat_no, created_at")
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
        phoneMasked: r.phone_masked == null ? null : String(r.phone_masked),
        emailMasked: r.email_masked == null ? null : String(r.email_masked),
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
 * 一位參加者的完整聯絡方式。
 *
 * ⚠️ **呼叫這一支就等於留下一筆 pii_access_log。** 那不是副作用，是它一半的工作：
 *    0021 §5 的函式先寫紀錄再組值，兩件事在同一個交易裡。
 *
 * ⚠️ 權限檢查不在這裡，在 src/lib/admin/fns/event-registrations.ts（那一層才拿得到
 *    session）。這一層假設呼叫端已經檢查過 —— 與 src/server/repos/** 的整體約定
 *    一致（見 lib/admin/middleware.ts 檔頭）。
 *
 * ⚠️ 錯誤訊息**不轉譯也不吞**，但也不印回傳值：這支函式回的東西就是個資本身。
 */
export async function revealRegistrationContact(input: {
  actorUserId: string;
  actorEmail: string;
  registrationId: string;
}): Promise<RegistrationContact> {
  const { data, error } = await supabaseAdmin().rpc("reveal_registration_contact", {
    p_actor_user_id: input.actorUserId,
    p_actor_email: input.actorEmail,
    p_registration_id: input.registrationId,
    p_reason: "attendee_contact",
  });

  if (error) {
    console.error(`[repo/event-registrations] reveal 失敗：${error.code} ${error.message}`);
    throw new Error(speak(error.message, "聯絡方式讀取失敗"));
  }
  return data as unknown as RegistrationContact;
}

/**
 * 整場的明文名單（只含 on_roster 的列），給 CSV 匯出用。
 *
 * ⚠️ 一次呼叫 = **一筆** pii_access_log，subject 是**場次**不是每一位參加者
 *    （0021 §0.1）。拆成每人一筆會讓「有人一次帶走了整場名單」這個真正重要的
 *    資訊在稽核畫面上看不見。
 *
 * ⚠️ 整份名單會進到這個 Node 行程的記憶體。那是「CSV 做成 server fn 而不是 HTTP
 *    路由」的代價，而書店一場 20–60 人可以忽略。換來的是
 *    src/lib/admin/fns/event-registrations.ts 檔頭那一段：登入頁的 HTML 被存成
 *    roster.csv 這件事在結構上不可能發生。
 */
export async function exportEventRoster(input: {
  actorUserId: string;
  actorEmail: string;
  sessionId: string;
}): Promise<RosterExport> {
  const { data, error } = await supabaseAdmin().rpc("export_event_roster", {
    p_actor_user_id: input.actorUserId,
    p_actor_email: input.actorEmail,
    p_session_id: input.sessionId,
    p_reason: "roster_export",
  });

  if (error) {
    console.error(`[repo/event-registrations] export 失敗：${error.code} ${error.message}`);
    throw new Error(speak(error.message, "名單匯出失敗"));
  }
  return data as unknown as RosterExport;
}

/**
 * 把 PL/pgSQL 的 `PREFIX: 中文訊息` 剝成給店員看的那一句（與 repos/inv-vendors.ts
 * 的同名函式一模一樣，刻意沒有共用 —— 兩個檔案的錯誤前綴各自演進）。
 */
function speak(message: string, fallback: string): string {
  const m = /[A-Z_]+:\s*(.+)/.exec(message ?? "");
  return m ? m[1].trim() : fallback;
}
