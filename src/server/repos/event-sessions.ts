/**
 * Data layer for public.event_sessions — used exclusively by admin server
 * functions (src/lib/admin/fns/event-sessions.ts).
 *
 * Mirrors src/server/repos/events.ts: every Supabase error is thrown, never
 * swallowed. A back office that silently returns null/empty on a permission or
 * connection error looks indistinguishable from "there is no data", and an
 * admin could believe a write succeeded when it never reached the database.
 *
 * Rows are returned exactly as Supabase returns them — snake_case columns, no
 * camelCase renaming — so what you see here matches
 * supabase/migrations/0020_event_sessions_registrations.sql §1 column-for-column.
 *
 * WHAT THIS FILE MAY NOT WRITE
 * ----------------------------
 * `seats_taken`. It is not in SessionUpsertInput and must never be added to it.
 * That counter has exactly three writers, all of them SQL functions that hold
 * the session's row lock while they work: reserve_session_seat(),
 * release_session_seat() and expire_unpaid_orders(). A PATCH from here would be
 * a read-modify-write against a number two shoppers can be moving at the same
 * moment — the oversell bug the whole 0020 design exists to make impossible.
 * Same rule, same reason, as products.seats_taken in src/server/repos/products.ts.
 *
 * `capacity` IS writable, because lowering it is a legitimate back-office act.
 * The database refuses to let it go below seats_taken
 * (`event_sessions_seats_within_capacity`), so "cut the room down to 10 when 12
 * have already booked" fails loudly instead of producing a session that is
 * over its own limit.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import { readAllPages } from "@/server/repos/read-all-pages";
import type { Localized } from "@/i18n/types";

const COLUMNS =
  "id, product_id, title, location, starts_at, ends_at, capacity, seats_taken, status, sort_order, created_at, updated_at";

export type EventSessionStatus = "open" | "closed";

export type EventSessionRow = {
  id: string;
  product_id: string;
  title: Localized;
  location: Localized;
  starts_at: string;
  ends_at: string | null;
  capacity: number;
  /** Read-only here. See the file header. */
  seats_taken: number;
  status: EventSessionStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** `id` omitted (or empty) means "create". */
export type SessionUpsertInput = {
  id?: string;
  product_id: string;
  title: Localized;
  location: Localized;
  starts_at: string;
  ends_at?: string | null;
  capacity: number;
  status: EventSessionStatus;
  sort_order: number;
};

/**
 * Every session, newest activity first, for the back-office list.
 *
 * Deliberately not filtered by product: the page this feeds answers "what is
 * coming up and who has signed up", which is a question about the calendar, not
 * about one product. The product's title is joined in by the caller
 * (src/lib/admin/fns/event-sessions.ts) rather than here, so this file stays a
 * plain one-table repo like every other repo in this directory.
 */
export async function listEventSessions(): Promise<EventSessionRow[]> {
  // 分段讀完：PostgREST 的 db-max-rows（1000）會靜默截斷整表讀取（2026-11-03 審查）。
  return await readAllPages(
    (from, to) =>
      supabaseAdmin()
        .from("event_sessions")
        .select(COLUMNS)
        .order("starts_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: EventSessionRow[] | null;
        error: { code?: string; message: string } | null;
      }>,
    { label: "[repo/event-sessions] list" },
  );
}

export async function getEventSessionById(id: string): Promise<EventSessionRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("event_sessions")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/event-sessions] getById 失敗：${error.message}`);
  return (data as EventSessionRow | null) ?? null;
}

/**
 * Creates or updates one session.
 *
 * `id` absent → insert (the column has a `gen_random_uuid()` default, so unlike
 * events.id there is nothing to generate here). `id` present → update, and the
 * update deliberately does NOT send seats_taken, so a stale form cannot write
 * back a count read minutes ago.
 */
export async function upsertEventSession(input: SessionUpsertInput): Promise<EventSessionRow> {
  const payload = {
    product_id: input.product_id,
    title: input.title,
    location: input.location,
    starts_at: input.starts_at,
    ends_at: input.ends_at && input.ends_at.trim() ? input.ends_at : null,
    capacity: input.capacity,
    status: input.status,
    sort_order: input.sort_order,
  };

  const id = input.id && input.id.trim() ? input.id.trim() : null;
  const query = id
    ? supabaseAdmin().from("event_sessions").update(payload).eq("id", id)
    : supabaseAdmin().from("event_sessions").insert(payload);

  const { data, error } = await query.select(COLUMNS).single();
  if (error) throw new Error(`[repo/event-sessions] upsert 失敗：${error.message}`);
  return data as EventSessionRow;
}

/**
 * Deletes a session.
 *
 * Will fail with a foreign-key violation when anyone has ever booked it —
 * event_registrations.session_id and order_items.session_id are both
 * `on delete restrict` (0020 §1–§3). That is the intended behaviour and the
 * error is passed through rather than translated: "this sitting has people in
 * it" is exactly what the admin needs to hear, and inventing a friendlier
 * sentence here would mean guessing which of the two constraints fired.
 */
export async function removeEventSession(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("event_sessions").delete().eq("id", id);
  if (error) throw new Error(`[repo/event-sessions] remove 失敗：${error.message}`);
}

/**
 * The event/journey products a session can be attached to.
 *
 * Every status, not just `active`: a session usually has to exist before its
 * product is published, and 0020's backfill deliberately creates sessions as
 * `closed` precisely so the back office can fill in the real date first.
 */
export async function listBookableProducts(): Promise<
  { id: string; slug: string; title: Localized; product_type: string; status: string }[]
> {
  const { data, error } = await supabaseAdmin()
    .from("products")
    .select("id, slug, title, product_type, status")
    .in("product_type", ["event", "journey"])
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/event-sessions] listBookableProducts 失敗：${error.message}`);
  return (data ?? []) as {
    id: string;
    slug: string;
    title: Localized;
    product_type: string;
    status: string;
  }[];
}

// -----------------------------------------------------------------------------
// event_session_plans（0036）—— 一個場次底下的多個價格方案（票種）
// -----------------------------------------------------------------------------
// 住在同一個檔案裡，不是獨立的 repo：方案永遠是場次的子項，兩者在後台是同一頁
// （/admin/registrations）、同一個表單群組編輯，拆開反而要在兩個檔案之間對照
// session_id。跟 listBookableProducts()（管的是 products，不是 event_sessions）
// 已經住在這個檔案是同一種務實考量。
//
// WHAT THIS FILE MAY NOT WRITE
// -----------------------------
// `units_taken`。它不在 PlanUpsertInput 裡，而且不可以加。理由與檔頭那段對
// `seats_taken` 的說明逐字相同：這個計數器只有三個寫者——
// reserve_plan_units() / release_plan_units() / release_session_seat() /
// expire_unpaid_orders()（0036），全部持著列鎖工作。從這裡 PATCH 會是一個
// read-modify-write，跟兩個購物中的客人同時搶最後一個名額——那正是 0036 整套
// 設計要防的事。

const PLAN_COLUMNS =
  "id, session_id, title, price, seats_per_unit, capacity, units_taken, sale_starts_at, sale_ends_at, status, sort_order, created_at, updated_at";

export type EventSessionPlanStatus = "open" | "closed";

export type EventSessionPlanRow = {
  id: string;
  session_id: string;
  title: Localized;
  price: number;
  seats_per_unit: number;
  capacity: number;
  /** Read-only here. See the file header. */
  units_taken: number;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  status: EventSessionPlanStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** `id` omitted (or empty) means "create". */
export type PlanUpsertInput = {
  id?: string;
  session_id: string;
  title: Localized;
  price: number;
  seats_per_unit: number;
  capacity: number;
  sale_starts_at?: string | null;
  sale_ends_at?: string | null;
  status: EventSessionPlanStatus;
  sort_order: number;
};

/**
 * Every plan, across every session, for the back-office list.
 *
 * Not filtered by session — same reasoning as listEventSessions(): the page
 * this feeds groups plans by `session_id` client-side once it already has the
 * session list loaded, so one round trip here is enough regardless of how many
 * sessions are on screen.
 */
export async function listEventSessionPlans(): Promise<EventSessionPlanRow[]> {
  // 分段讀完（同 listEventSessions）。
  return await readAllPages(
    (from, to) =>
      supabaseAdmin()
        .from("event_session_plans")
        .select(PLAN_COLUMNS)
        .order("session_id", { ascending: true })
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: EventSessionPlanRow[] | null;
        error: { code?: string; message: string } | null;
      }>,
    { label: "[repo/event-sessions] listPlans" },
  );
}

/**
 * Creates or updates one plan.
 *
 * `id` absent → insert. `id` present → update, and the update deliberately does
 * NOT send `units_taken` — same discipline as upsertEventSession() not sending
 * `seats_taken`, so a stale form can never write back a count read minutes ago.
 */
export async function upsertEventSessionPlan(input: PlanUpsertInput): Promise<EventSessionPlanRow> {
  const payload = {
    session_id: input.session_id,
    title: input.title,
    price: input.price,
    seats_per_unit: input.seats_per_unit,
    capacity: input.capacity,
    sale_starts_at:
      input.sale_starts_at && input.sale_starts_at.trim() ? input.sale_starts_at : null,
    sale_ends_at: input.sale_ends_at && input.sale_ends_at.trim() ? input.sale_ends_at : null,
    status: input.status,
    sort_order: input.sort_order,
  };

  const id = input.id && input.id.trim() ? input.id.trim() : null;
  const query = id
    ? supabaseAdmin().from("event_session_plans").update(payload).eq("id", id)
    : supabaseAdmin().from("event_session_plans").insert(payload);

  const { data, error } = await query.select(PLAN_COLUMNS).single();
  if (error) throw new Error(`[repo/event-sessions] upsertPlan 失敗：${error.message}`);
  return data as EventSessionPlanRow;
}

export type RemovePlanResult =
  | { deleted: true }
  | { deleted: false; reason: "plan_not_found" | "plan_has_orders" };

/**
 * Deletes a plan — but only after checking whether anyone has ever bought it.
 *
 * ⚠️ Unlike removeEventSession() above (which lets a raw foreign-key violation
 * surface, because "this sitting has people in it" already reads fine as an
 * error string), a plan's `on delete restrict` FK error does NOT read fine —
 * it is a bare `update or delete on table "event_session_plans" violates
 * foreign key constraint …` with no mention of orders. This is the exact
 * lesson 0035 wrote down for admin_delete_order()/admin_delete_registration():
 * check first, return a human reason, don't let the bare FK error reach the
 * admin screen.
 *
 * The check-then-delete here is not perfectly atomic against a checkout that
 * completes in the gap between the two statements — but this is an admin-only,
 * human-paced action, not the checkout hot path, and the FK constraint is
 * still the backstop of last resort if that race is ever actually hit (the
 * delete would then fail with the raw error rather than the friendly one,
 * which is a worse message but never a wrong result — the plan still does not
 * get deleted out from under a real order).
 */
export async function removeEventSessionPlan(id: string): Promise<RemovePlanResult> {
  const { count, error: countError } = await supabaseAdmin()
    .from("order_items")
    .select("id", { count: "exact", head: true })
    .eq("plan_id", id);
  if (countError) {
    throw new Error(`[repo/event-sessions] removePlan 檢查失敗：${countError.message}`);
  }
  if ((count ?? 0) > 0) {
    return { deleted: false, reason: "plan_has_orders" };
  }

  const { error, count: deletedCount } = await supabaseAdmin()
    .from("event_session_plans")
    .delete({ count: "exact" })
    .eq("id", id);
  if (error) throw new Error(`[repo/event-sessions] removePlan 失敗：${error.message}`);
  if ((deletedCount ?? 0) === 0) return { deleted: false, reason: "plan_not_found" };
  return { deleted: true };
}
