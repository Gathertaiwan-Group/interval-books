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
