/**
 * 首頁「近期活動與策旅」卡片上的價格與報名狀態（2026-11 首頁手機版改版）。
 *
 * 只給首頁卡片**顯示**用：票價、是否額滿、名額是否所剩不多。真正的數量上限仍然只問
 * directSeatLimit()（見 CLAUDE.md「不要自己算座位數字」），這裡讀到的數字是 SSR 當下的
 * 快照，跟 remainingFor() 給 /shop 售完標籤的立場一樣：可能已經過時，只拿來標示。
 *
 * ── 為什麼另開一支查詢，不併進 cms.ts 的 attachLastSessionDates() ────────────────
 * 那支的 select 決定「已結束」判斷（event-status-selftest 釘死了它的欄位）。把票價、
 * 名額塞進同一支 embed，一旦其中一欄讀不到，整支回 null，首頁與 /events 的「已結束」
 * 就退回 iso_date 舊規則。這裡獨立查、失敗回空物件 → 卡片只是不印價格與狀態，
 * 其他一切照舊。
 */
import { supabase } from "@/lib/supabase";

/** 名額顯示門檻：剩這麼多（含）以下才印「最後 N 位」，免得每張卡都在倒數。 */
export const LOW_SEATS_THRESHOLD = 5;

export type ListingFacts = {
  /** products.price；0 = 免費。 */
  price: number;
  /** 所有尚未開始、開放中的場次都沒有名額。沒有未來場次時為 false（不判斷）。 */
  soldOut: boolean;
  /**
   * 「最後 N 位」：只有商品勾了 show_seats_remaining、還沒額滿、且最多名額的那一場
   * 也只剩 LOW_SEATS_THRESHOLD 以下時才有值，其他情況 null（不印）。
   */
  fewLeft: number | null;
  /**
   * 包場，不開放報名（src/lib/private-booking.ts）。true 時卡片只標「包場」，不印票價、
   * 不印「已額滿／最後 N 位」。由 listingFactsForCard() 依活動的旗標蓋上去。
   */
  privateBooking?: boolean;
  /**
   * 報名截止：活動的下一個尚未結束的場次是關閉的（非包場，見 upcoming-order.ts
   * nextSessionClosedSlugs）。true 時卡片只標「報名截止」，不印票價、不印名額狀態（比照包場）。
   */
  registrationClosed?: boolean;
};

/** 包場活動的卡片：沒有票價、沒有名額狀態，只有「包場」。 */
export const PRIVATE_BOOKING_FACTS: ListingFacts = {
  price: 0,
  soldOut: false,
  fewLeft: null,
  privateBooking: true,
};

/** 報名截止的卡片：沒有票價、沒有名額狀態，只有「報名截止」。 */
export const REGISTRATION_CLOSED_FACTS: ListingFacts = {
  price: 0,
  soldOut: false,
  fewLeft: null,
  registrationClosed: true,
};

/**
 * 卡片要用的 facts：活動是包場 → 一律 PRIVATE_BOOKING_FACTS（蓋過商品讀到的票價與名額）；
 * 下一個未結束場次報名截止（registrationClosed，呼叫端用 nextSessionClosedSlugs 算）→
 * REGISTRATION_CLOSED_FACTS；否則照 fetchListingFacts() 的結果。
 */
export function listingFactsForCard(
  event: { privateBooking?: boolean } | null | undefined,
  facts: ListingFacts | undefined,
  registrationClosed: boolean = false,
): ListingFacts | undefined {
  if (event?.privateBooking) return PRIVATE_BOOKING_FACTS;
  if (event && registrationClosed) return REGISTRATION_CLOSED_FACTS;
  return facts;
}

type SessionRow = {
  starts_at?: unknown;
  capacity?: unknown;
  seats_taken?: unknown;
  status?: unknown;
};

type ProductRow = {
  slug?: unknown;
  price?: unknown;
  show_seats_remaining?: unknown;
  event_sessions?: unknown;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 純函式：一列商品（含 embed 的場次）→ 卡片要印的東西。讀不懂 → null。 */
export function listingFactsFor(row: ProductRow, now: number = Date.now()): ListingFacts | null {
  const price = num(row.price);
  if (price === null || price < 0) return null;
  const sessions = Array.isArray(row.event_sessions) ? (row.event_sessions as SessionRow[]) : [];
  const upcoming = sessions.filter((s) => {
    if (s.status !== "open") return false;
    const t = typeof s.starts_at === "string" ? Date.parse(s.starts_at) : NaN;
    return !Number.isNaN(t) && t > now;
  });
  if (upcoming.length === 0) return { price, soldOut: false, fewLeft: null };
  // 與 remainingFor() 同一個定義：商品層級的剩餘＝各場次剩餘的最大值。
  const best = upcoming.reduce((max, s) => {
    const cap = num(s.capacity) ?? 0;
    const taken = num(s.seats_taken) ?? 0;
    return Math.max(max, Math.max(0, cap - taken));
  }, 0);
  const soldOut = best <= 0;
  const fewLeft =
    !soldOut && row.show_seats_remaining === true && best <= LOW_SEATS_THRESHOLD ? best : null;
  return { price, soldOut, fewLeft };
}

/**
 * 所有上架中的活動／策旅票券商品 → 卡片資訊，key 是**商品 slug**（`event-<活動 slug>`，
 * 呼叫端用 eventProductSlug(e.slug) 取）。不帶 slug 條件，是為了能和首頁其他查詢放在
 * 同一個 Promise.all 平行跑，不必等活動列表回來再查第二輪。
 * 任何失敗 → 空物件（卡片退回不印價格／狀態）。
 */
export async function fetchListingFacts(): Promise<Record<string, ListingFacts>> {
  const db = supabase;
  if (!db) return {};
  try {
    const { data, error } = await db
      .from("products")
      .select(
        "slug,price,show_seats_remaining,event_sessions(starts_at,capacity,seats_taken,status)",
      )
      .in("product_type", ["event", "journey"])
      .eq("status", "active");
    if (error || !Array.isArray(data)) {
      if (error) console.warn(`[home-listing] products unavailable — ${error.message}`);
      return {};
    }
    const out: Record<string, ListingFacts> = {};
    for (const row of data as ProductRow[]) {
      if (typeof row.slug !== "string" || !row.slug) continue;
      const facts = listingFactsFor(row);
      if (facts) out[row.slug] = facts;
    }
    return out;
  } catch (err) {
    console.warn(`[home-listing] ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
