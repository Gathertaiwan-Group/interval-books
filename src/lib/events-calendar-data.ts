/**
 * /events 月曆檢視的資料讀取（anon，前台同一個 Supabase client）。
 * 組裝與日期計算在 src/lib/events-calendar.ts（純函式，有自檢）。
 *
 * ── 讀什麼 ─────────────────────────────────────────────────────────────────
 * 三個查詢平行打（與 loader 裡既有的 fetchEvents 等並行，不串接）：
 *   1. events：上架中的活動（含策旅那幾列 —— 月曆要標「策旅」，所以這裡不排除）
 *   2. journeys：上架中策旅卡片的 external_url（判斷哪幾列 events 是策旅）
 *   3. products（source_type = event）連同 event_sessions embed：場次時間、地點、名額。
 *      商品對活動用 products.source_id = events.id，對不上才退回 slug `event-<slug>`
 *      （eventSlugForProduct）。
 *
 * anon 的 RLS 只放行「active 商品的 open 場次」（0020）。已關閉的場次（報名截止、包場）
 * 由 server fn（fetchClosedSessionTimes → src/server/private-booking.ts#readClosedSessionTimes，
 * service role、只回 live 活動、只有時間與地點）補回來，標「報名截止」／「包場」——
 * 所以月曆與 /calendar.ics 收的是同一批場次。
 *
 * ── 🔴 額滿 ───────────────────────────────────────────────────────────────
 * 一律用 remainingForSession()（與 SessionPicker 的「已額滿」同一支）。這裡不自己
 * 拿 capacity − seats_taken。
 *
 * ── 失敗 ───────────────────────────────────────────────────────────────────
 * 任何一個查詢失敗 → `unavailable: true`、entries 空陣列。月曆顯示「暫時無法載入」，
 * 不拿內建種子資料頂替（那是過期的日期）。列表檢視不受影響。
 */
import { supabase } from "@/lib/supabase";
import { remainingForSession, type ShopSession } from "@/lib/shop";
import { isPrivateBooking } from "@/lib/private-booking";
import { fetchClosedSessionTimes } from "@/lib/private-booking-fns";
import {
  buildCalendarEntries,
  eventSlugForProduct,
  type CalLocalized,
  type CalendarEntry,
  type RawCalendarEvent,
  type RawCalendarSession,
} from "@/lib/events-calendar";

type Row = Record<string, unknown>;

export type CalendarData = { entries: CalendarEntry[]; unavailable: boolean };

function loc(v: unknown): CalLocalized | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.zh !== "string") return null;
  return {
    zh: o.zh,
    en: typeof o.en === "string" ? o.en : "",
    ja: typeof o.ja === "string" ? o.ja : "",
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function fetchCalendarEntries(nowMs: number): Promise<CalendarData> {
  const db = supabase;
  if (!db) return { entries: [], unavailable: true };
  try {
    const [eventsRes, journeysRes, productsRes] = await Promise.all([
      db
        .from("events")
        .select("id,slug,title,external_url,iso_date,notes")
        .eq("is_published", true)
        .order("sort_order", { ascending: true }),
      db.from("journeys").select("external_url").eq("is_published", true),
      db
        .from("products")
        .select(
          "id,slug,source_id,event_sessions(id,title,location,starts_at,ends_at,capacity,seats_taken)",
        )
        .eq("source_type", "event"),
    ]);
    if (eventsRes.error || journeysRes.error || productsRes.error) {
      const msg = (eventsRes.error ?? journeysRes.error ?? productsRes.error)?.message;
      console.warn(`[events-calendar] unavailable — ${msg}`);
      return { entries: [], unavailable: true };
    }

    const events: RawCalendarEvent[] = [];
    for (const r of (eventsRes.data ?? []) as Row[]) {
      const title = loc(r.title);
      const slug = str(r.slug);
      if (!title || !slug) continue;
      events.push({
        id: str(r.id) || undefined,
        slug,
        title,
        externalUrl: str(r.external_url),
        isoDate: str(r.iso_date) || null,
        privateBooking: isPrivateBooking(r.notes),
      });
    }

    const slugByEventId = new Map<string, string>();
    for (const e of events) if (e.id) slugByEventId.set(e.id, e.slug);

    const sessions: RawCalendarSession[] = [];
    for (const p of (productsRes.data ?? []) as Row[]) {
      const eventSlug = eventSlugForProduct(
        { slug: str(p.slug), sourceId: str(p.source_id) || null },
        slugByEventId,
      );
      if (!eventSlug) continue;
      const productSlug = `event-${eventSlug}`;
      const rows = Array.isArray(p.event_sessions) ? (p.event_sessions as Row[]) : [];
      for (const s of rows) {
        const id = str(s.id);
        const startsAt = str(s.starts_at);
        const capacity = num(s.capacity);
        const title = loc(s.title) ?? { zh: "", en: "", ja: "" };
        const location = loc(s.location) ?? { zh: "", en: "", ja: "" };
        if (!id || !startsAt || capacity === null) continue;
        // 只為了把列交給 remainingForSession()（它要的是 ShopSession 形狀）。
        const shopSession: ShopSession = {
          id,
          productId: str(p.id),
          title,
          location,
          startsAt,
          endsAt: str(s.ends_at) || null,
          capacity,
          seatsTaken: num(s.seats_taken) ?? 0,
          sortOrder: 0,
          plans: [],
        };
        sessions.push({
          id,
          productSlug,
          title,
          location,
          startsAt,
          endsAt: shopSession.endsAt,
          full: remainingForSession(shopSession) <= 0,
        });
      }
    }

    // 已關閉的場次（報名截止、包場）：anon 讀不到，時間另由 server fn 用 service role 讀回來
    // （只回 live 活動的 closed 場次、只有時間與地點）。包場的代稱排前面——server fn 最多收
    // MAX_PRIVATE_SLUGS 個，超過時優先保住包場（它們的場次一定是 closed）。
    const closedSlugs = [
      ...events.filter((e) => e.privateBooking).map((e) => e.slug),
      ...events.filter((e) => !e.privateBooking).map((e) => e.slug),
    ];
    if (closedSlugs.length > 0) {
      const times = await fetchClosedSessionTimes(closedSlugs);
      const seen = new Set(sessions.map((s) => s.id));
      for (const [slug, list] of Object.entries(times)) {
        for (const s of list) {
          if (seen.has(s.id)) continue;
          sessions.push({
            id: s.id,
            productSlug: `event-${slug}`,
            title: s.title,
            location: s.location,
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            full: false,
            closed: true,
          });
        }
      }
    }

    const journeyUrls = ((journeysRes.data ?? []) as Row[]).map((r) => str(r.external_url));
    return {
      entries: buildCalendarEntries({ events, sessions, journeyUrls, nowMs }),
      unavailable: false,
    };
  } catch (err) {
    console.warn(
      `[events-calendar] unavailable — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { entries: [], unavailable: true };
  }
}
