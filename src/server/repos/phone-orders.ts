/**
 * 後台「新增電話報名」（0050）表單的選項：上架中的活動／策旅 → 還沒開始、開放報名的
 * 場次 → 販售中的票種。只讀。
 *
 * 只有 src/lib/admin/fns/phone-orders.ts（adminFnMiddleware）會呼叫這裡。
 *
 * 篩選條件刻意與 createOrder() 的 priceLines() 相同（商品 active、場次 open 且屬於這件
 * 商品、場次還沒開始、票種 open 且在販售期間內）：列得出來的選項就一定能建單，列不
 * 出來的建單也會被擋。名額是當下的快照，真正的檢查在 reserve_session_seat()。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";
import type {
  PhoneOrderContactEditInput,
  PhoneOrderContacts,
  PhoneOrderPlanOption,
  PhoneOrderProductOption,
  PhoneOrderSessionOption,
} from "@/lib/admin/phone-order";

type ProductRaw = {
  id: string;
  title: Localized;
  product_type: "event" | "journey";
  price: number;
};
type SessionRaw = {
  id: string;
  product_id: string;
  title: Localized | null;
  starts_at: string;
  ends_at: string | null;
  capacity: number;
  seats_taken: number;
  sort_order: number | null;
};
type PlanRaw = {
  id: string;
  session_id: string;
  title: Localized;
  price: number;
  seats_per_unit: number;
  capacity: number;
  units_taken: number;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  sort_order: number | null;
};

export async function listPhoneOrderOptions(now = new Date()): Promise<PhoneOrderProductOption[]> {
  const db = supabaseAdmin();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const { data: sessData, error: sessError } = await db
    .from("event_sessions")
    .select("id, product_id, title, starts_at, ends_at, capacity, seats_taken, sort_order")
    .eq("status", "open")
    .gt("starts_at", nowIso)
    .order("starts_at", { ascending: true });
  if (sessError) {
    console.error(`[repo/phone-orders] 讀場次失敗：${sessError.code} ${sessError.message}`);
    throw new Error(`[repo/phone-orders] 場次讀取失敗：${sessError.code}`);
  }
  const sessions = (sessData ?? []) as unknown as SessionRaw[];
  if (sessions.length === 0) return [];

  const productIds = [...new Set(sessions.map((s) => s.product_id))];
  const sessionIds = sessions.map((s) => s.id);
  const [prodRes, planRes] = await Promise.all([
    db
      .from("products")
      .select("id, title, product_type, price")
      .eq("status", "active")
      .in("product_type", ["event", "journey"])
      .in("id", productIds),
    db
      .from("event_session_plans")
      .select(
        "id, session_id, title, price, seats_per_unit, capacity, units_taken, sale_starts_at, sale_ends_at, sort_order",
      )
      .eq("status", "open")
      .in("session_id", sessionIds)
      .order("sort_order", { ascending: true }),
  ]);
  if (prodRes.error) {
    console.error(`[repo/phone-orders] 讀商品失敗：${prodRes.error.code} ${prodRes.error.message}`);
    throw new Error(`[repo/phone-orders] 商品讀取失敗：${prodRes.error.code}`);
  }
  if (planRes.error) {
    console.error(`[repo/phone-orders] 讀票種失敗：${planRes.error.code} ${planRes.error.message}`);
    throw new Error(`[repo/phone-orders] 票種讀取失敗：${planRes.error.code}`);
  }

  const plansBySession = new Map<string, { hasPlans: boolean; onSale: PhoneOrderPlanOption[] }>();
  for (const p of (planRes.data ?? []) as unknown as PlanRaw[]) {
    const entry = plansBySession.get(p.session_id) ?? { hasPlans: false, onSale: [] };
    entry.hasPlans = true;
    const opens = p.sale_starts_at ? Date.parse(p.sale_starts_at) : null;
    const closes = p.sale_ends_at ? Date.parse(p.sale_ends_at) : null;
    const onSale =
      (opens === null || Number.isNaN(opens) || nowMs >= opens) &&
      (closes === null || Number.isNaN(closes) || nowMs <= closes);
    if (onSale) {
      entry.onSale.push({
        id: p.id,
        title: p.title,
        price: p.price,
        seatsPerUnit: p.seats_per_unit,
        unitsLeft: Math.max(0, p.capacity - p.units_taken),
      });
    }
    plansBySession.set(p.session_id, entry);
  }

  const out: PhoneOrderProductOption[] = [];
  for (const prod of (prodRes.data ?? []) as unknown as ProductRaw[]) {
    const own: PhoneOrderSessionOption[] = sessions
      .filter((s) => s.product_id === prod.id)
      .map((s) => {
        const plans = plansBySession.get(s.id);
        return {
          id: s.id,
          title: s.title,
          startsAt: s.starts_at,
          endsAt: s.ends_at,
          capacity: s.capacity,
          seatsLeft: Math.max(0, s.capacity - s.seats_taken),
          plans: plans?.onSale ?? [],
          hasPlans: plans?.hasPlans ?? false,
        };
      });
    if (own.length === 0) continue;
    out.push({
      id: prod.id,
      title: prod.title,
      productType: prod.product_type,
      price: prod.price,
      sessions: own,
    });
  }
  // 最近開始的活動排前面。
  out.sort((a, b) => (a.sessions[0]!.startsAt < b.sessions[0]!.startsAt ? -1 : 1));
  return out;
}

/**
 * 建立者（orders.created_by）的 email，給訂單內頁與店家通知信顯示。讀不到回 null，
 * 不丟例外——少一個名字不該讓整頁掛掉。
 */
export async function loadAdminEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error(`[repo/phone-orders] 讀建立者失敗：${error.code} ${error.message}`);
    return null;
  }
  const email = (data as { email?: unknown } | null)?.email;
  return typeof email === "string" && email.trim() ? email.trim() : null;
}

/**
 * 這張訂單已經寫進去幾位參加者。createAdminPhoneOrder() 用它確認「重送讀回來的那張單
 * 已經建好」（見那裡的說明）。讀失敗回 -1（＝不確定）。
 */
export async function countOrderRegistrations(orderId: string): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from("event_registrations")
    .select("id")
    .eq("order_id", orderId);
  if (error) {
    console.error(`[repo/phone-orders] 讀報名列失敗：${error.code} ${error.message}`);
    return -1;
  }
  return (data ?? []).length;
}

// ---------------------------------------------------------------------------
// 0051：事後補資料
// ---------------------------------------------------------------------------

/**
 * 電話報名訂單目前的訂購人與參加者聯絡資料（明文）。不是 admin_phone 或找不到 → null。
 * 只有 fns/phone-orders.ts 的 getPhoneOrderContacts（adminFnMiddleware）呼叫。
 */
export async function loadPhoneOrderContacts(orderId: string): Promise<PhoneOrderContacts | null> {
  const db = supabaseAdmin();
  const { data: o, error } = await db
    .from("orders")
    .select("id, source, notify_customer, customer_name, customer_email, customer_phone")
    .eq("id", orderId)
    .maybeSingle();
  if (error) {
    console.error(`[repo/phone-orders] 讀訂單聯絡資料失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/phone-orders] 訂單讀取失敗：${error.code}`);
  }
  const order = o as {
    source?: string;
    notify_customer?: boolean;
    customer_name?: string | null;
    customer_email?: string | null;
    customer_phone?: string | null;
  } | null;
  if (!order || order.source !== "admin_phone") return null;

  const { data: regs, error: regError } = await db
    .from("event_registrations")
    .select("id, seat_no, name, email, phone, created_at")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true })
    .order("seat_no", { ascending: true });
  if (regError) {
    console.error(`[repo/phone-orders] 讀參加者失敗：${regError.code} ${regError.message}`);
    throw new Error(`[repo/phone-orders] 參加者讀取失敗：${regError.code}`);
  }
  const blank = (v: string | null | undefined) => (v ?? "").trim();
  return {
    customer: {
      name: blank(order.customer_name),
      email: blank(order.customer_email),
      phone: blank(order.customer_phone),
    },
    notifyCustomer: order.notify_customer === true,
    participants: (
      (regs ?? []) as unknown as {
        id: string;
        seat_no: number;
        name: string;
        email: string | null;
        phone: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      seatNo: r.seat_no,
      name: r.name,
      email: blank(r.email) || null,
      phone: blank(r.phone) || null,
    })),
  };
}

/**
 * 寫入＋稽核是同一支 RPC（admin_update_phone_order_contacts，0051 §3）：鎖訂單 → 驗全部
 * 輸入 → 才寫 → 有變動才記一列 order_contact_edit_log（誰、何時、哪幾個欄位，不存值）。
 * 回 { updated, reason }：updated=false 時 reason 是給呼叫端對照文案的碼。
 */
export async function updatePhoneOrderContacts(args: {
  orderId: string;
  actorId: string;
  customer: PhoneOrderContactEditInput["customer"];
  participants: PhoneOrderContactEditInput["participants"];
}): Promise<{ updated: boolean; reason: string }> {
  const { data, error } = await supabaseAdmin().rpc("admin_update_phone_order_contacts", {
    p_order_id: args.orderId,
    p_actor_id: args.actorId,
    p_customer: {
      name: args.customer.name,
      email: args.customer.email,
      phone: args.customer.phone,
    },
    p_participants: args.participants.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email || null,
      phone: p.phone || null,
    })),
  });
  if (error) {
    console.error(`[repo/phone-orders] 更新聯絡資料失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/phone-orders] 更新聯絡資料失敗：${error.code}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { updated?: boolean; reason?: string }
    | null
    | undefined;
  return { updated: row?.updated === true, reason: String(row?.reason ?? "unknown") };
}
