/**
 * /events 月曆檢視的資料讀取（anon，前台同一個 Supabase client）。
 * 組裝與日期計算在 src/lib/events-calendar.ts（純函式，有自檢）。
 *
 * ── 讀什麼 ─────────────────────────────────────────────────────────────────
 * 三個查詢平行打（與 loader 裡既有的 fetchEvents 等並行，不串接）：
 *   1. events：上架中的活動（含策旅那幾列 —— 月曆要標「策旅」，所以這裡不排除）
 *   2. journeys：上架中策旅卡片的 external_url（判斷哪幾列 events 是策旅）
 *   3. products（slug 以 `event-` 開頭）連同 event_sessions embed：場次時間、地點、名額
 *
 * anon 的 RLS 只放行「active 商品的 open 場次」（0020），所以後台關掉的場次不會出現在
 * 月曆上——與活動詳情頁看到的一致。/calendar.ics 用 service role 另讀，是不同的需求。
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
import { fetchPrivateSessionTimes } from "@/lib/private-booking-fns";
import {
  buildCalendarEntries,
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
        .select("slug,title,external_url,iso_date,notes")
        .eq("is_published", true)
        .order("sort_order", { ascending: true }),
      db.from("journeys").select("external_url").eq("is_published", true),
      db
        .from("products")
        .select("id,slug,event_sessions(id,title,location,starts_at,ends_at,capacity,seats_taken)")
        .like("slug", "event-%"),
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
        slug,
        title,
        externalUrl: str(r.external_url),
        isoDate: str(r.iso_date) || null,
        privateBooking: isPrivateBooking(r.notes),
      });
    }

    const sessions: RawCalendarSession[] = [];
    for (const p of (productsRes.data ?? []) as Row[]) {
      const productSlug = str(p.slug);
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

    // 包場：場次維持 closed（anon 讀不到），時間另由 server fn 用 service role 讀回來
    // （只回包場活動、只有時間與地點）。沒有包場活動就不多這一趟。
    const privateSlugs = events.filter((e) => e.privateBooking).map((e) => e.slug);
    if (privateSlugs.length > 0) {
      const times = await fetchPrivateSessionTimes(privateSlugs);
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
