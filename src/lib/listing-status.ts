/**
 * 活動與策旅的「單一上架狀態」（supabase/migrations/0052_event_listing_status.sql）。
 *
 * ── 唯一真相是 events.status ───────────────────────────────────────────────
 *   draft 草稿    前台看不到（活動頁、列表、首頁、sitemap、策旅卡片都不出現），後台可編輯
 *   live  上架    前台看得到；站內報名可以報名（仍受場次時間、名額限制）
 *   archived 下架 前台看不到（舊網址 404），資料、報名紀錄、訂單都保留
 *
 * 其他三個欄位是**資料庫推導**的衍生值（0052 的 trigger），程式不要自己寫：
 *   events.is_published   = status === "live"
 *   票券商品 products.status = listingToProductStatus(status)
 *   指向它的策旅卡片       = 同 status、is_published 同上
 *
 * 改狀態只有兩條路（都是一個交易）：
 *   admin_set_event_status(event_id, status)     後台列表、MCP set_event_status、一頁新增「直接上架」
 *   admin_upsert_event_with_session(payload)     活動編輯頁的「儲存」（payload.event.status）
 */
import { isSessionClosedForBooking, isEventEnded, todayInTaipei } from "@/lib/event-status";

export const LISTING_STATUSES = ["draft", "live", "archived"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const LISTING_STATUS_LABEL: Record<ListingStatus, string> = {
  draft: "草稿",
  live: "上架",
  archived: "下架",
};

/** 後台下拉／說明用的一句話。 */
export const LISTING_STATUS_HINT: Record<ListingStatus, string> = {
  draft: "前台看不到，可以慢慢編輯。",
  live: "前台看得到；站內報名的活動可以報名（仍受場次時間與名額限制）。",
  archived: "前台看不到，舊網址會顯示找不到頁面；報名紀錄與訂單都保留。",
};

export function isListingStatus(v: unknown): v is ListingStatus {
  return typeof v === "string" && (LISTING_STATUSES as readonly string[]).includes(v);
}

/** 與 SQL public.listing_status_to_product_status() 同一張對照表。 */
export function listingToProductStatus(s: ListingStatus): "draft" | "active" | "archived" {
  return s === "live" ? "active" : s === "archived" ? "archived" : "draft";
}

/**
 * 0052 §2 的推定規則（依「客人現在實際看到的」）——只給自檢與回報用，正式推定在 SQL。
 *   is_published=true                    → live（客人看得到）
 *   is_published=false、商品 archived     → archived
 *   其他                                  → draft
 */
export function inferListingStatus(
  isPublished: boolean,
  productStatus: "draft" | "active" | "archived" | null,
): ListingStatus {
  if (isPublished) return "live";
  return productStatus === "archived" ? "archived" : "draft";
}

/** 上架中的活動，系統依時間與名額推導的報名狀況（後台列表旁的小字）。 */
export type BookingPhase = "open" | "full" | "closed" | "ended" | "no_sessions" | "external";

export const BOOKING_PHASE_LABEL: Record<BookingPhase, string> = {
  open: "報名中",
  full: "額滿",
  closed: "報名截止",
  ended: "已結束",
  no_sessions: "尚無可報名場次",
  external: "外部報名",
};

export type BookingSession = {
  starts_at: string;
  ends_at?: string | null;
  capacity: number | null;
  seats_taken: number;
  /** event_sessions.status：open／closed */
  status: string;
};

/**
 * 「報名中／額滿／已結束」。規則與前台同一套：
 *   · 已結束：isEventEnded()（活動頁與列表移到「已結束」的同一條）
 *   · 可報名的場次 = status open、還沒開始（isSessionClosedForBooking）
 *   · 有可報名場次但每一場都滿了 → 額滿
 *   · 有場次但沒有一場可報名（都已開始或被關閉）→ 報名截止；一場場次都沒有 → 尚無可報名場次
 *   · 外部報名的活動沒有場次，由外部網站決定 → 外部報名（活動已結束時仍顯示已結束）
 */
export function bookingPhase(
  input: {
    registrationType: "external" | "internal";
    isoDate: string | null;
    sessions: ReadonlyArray<BookingSession>;
  },
  now: number = Date.now(),
): BookingPhase {
  const sessions = input.sessions;
  // 「今天」也從同一個 now 推出來，不讀系統時鐘：同一次判斷裡「已結束」與「還收不收報名」
  // 必須用同一個時間點（自檢注入固定的 now 時，這兩個答案才不會隨著真實日期漂移）。
  const ended = isEventEnded(
    input.isoDate,
    sessions.map((s) => ({ startsAt: s.starts_at, endsAt: s.ends_at ?? null })),
    todayInTaipei(new Date(now)),
  );
  if (ended) return "ended";
  if (input.registrationType === "external") return "external";
  const bookable = sessions.filter(
    (s) => s.status === "open" && !isSessionClosedForBooking({ startsAt: s.starts_at }, now),
  );
  if (bookable.length === 0) return sessions.length > 0 ? "closed" : "no_sessions";
  const anySeat = bookable.some((s) => s.capacity == null || s.seats_taken < s.capacity);
  return anySeat ? "open" : "full";
}

/** 列表篩選：全部／草稿／上架／下架。 */
export const LISTING_FILTERS = ["all", ...LISTING_STATUSES] as const;
export type ListingFilter = (typeof LISTING_FILTERS)[number];
export const LISTING_FILTER_LABEL: Record<ListingFilter, string> = {
  all: "全部",
  ...LISTING_STATUS_LABEL,
};

export function parseListingFilter(v: unknown): ListingFilter {
  return v === "draft" || v === "live" || v === "archived" ? v : "all";
}

/**
 * 結帳那一層的第二道門（src/server/repos/orders.ts#priceLines）：活動票券只有在活動是
 * 「上架」時才能下單。
 *
 * 第一道是 priceLines 本來就有的 `products.status = 'active'`——0052 之後票券商品的狀態
 * 由 trigger 跟著活動推導，所以兩道應該永遠給同一個答案；這一道直接讀 events.status，
 * 不靠「trigger 一定在」這個前提。草稿、下架、或活動已經被刪掉（查不到）→ 不能賣。
 *
 * 不是活動票券的商品（書、選物；或沒有 source 的舊票券）不歸這裡管 → true。
 */
export function ticketSellable(
  product: { product_type: string; source_type?: string | null; source_id?: string | null },
  eventStatusById: ReadonlyMap<string, string>,
): boolean {
  const isBooking = product.product_type === "event" || product.product_type === "journey";
  if (!isBooking || product.source_type !== "event" || !product.source_id) return true;
  return eventStatusById.get(product.source_id) === "live";
}
