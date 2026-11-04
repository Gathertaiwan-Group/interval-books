/**
 * /calendar.ics 的資料讀取與回應（由 src/server.ts 攔截後 dynamic import）。
 * 輸出格式與規則全部在 src/lib/calendar-ics.ts（純函式，有自檢）。
 *
 * ── 資料來源：重用後台既有的 repo，不另寫「上架」判斷 ───────────────────────
 * listEvents／listEventProducts／listEventSessions／listEventSessionPlans／listJourneys／
 * getSiteSettings。上架與否只看 events.status === "live"（0052 唯一真相），策旅卡片同理。
 * 用 service role 讀，是因為 anon 的 RLS 只放行 status='open' 的場次——報名截止但活動照常舉辦
 * 的場次也該在日曆上。只取非個資欄位（沒有碰報名名單／訂單）。
 *
 * ── 快取 ───────────────────────────────────────────────────────────────────
 * 不能每次請求都打資料庫（Vercel 函式 CPU 曾超量被暫停）。回應帶 CDN 快取
 * s-maxage=900（15 分鐘）＋ swr=3600；沒有任何應用層快取（模組變數、Data Cache），所以
 * 後台改完最久 15 分鐘後訂閱端就拿得到新內容，不會被長期存住。
 * 讀取失敗 → 503 + no-store（不快取、不回殘缺的日曆）。
 */
import { listEvents, listEventProducts } from "@/server/repos/events";
import { listEventSessions, listEventSessionPlans } from "@/server/repos/event-sessions";
import { listJourneys } from "@/server/repos/journeys";
import { getSiteSettings } from "@/server/repos/site-settings";
import { buildCalendarIcs, type CalendarInput } from "@/lib/calendar-ics";

export const CALENDAR_CACHE = "public, max-age=0, s-maxage=900, stale-while-revalidate=3600";

/** site_settings 讀不到時的最後退路（華山小時光風土誌書店）。 */
const FALLBACK_STORE_ADDRESS = "小時光風土誌書店";

export async function collectCalendarInput(now: Date = new Date()): Promise<CalendarInput> {
  const [events, products, sessions, plans, journeys, settings] = await Promise.all([
    listEvents(),
    listEventProducts(),
    listEventSessions(),
    listEventSessionPlans(),
    listJourneys(),
    getSiteSettings().catch(() => null),
  ]);
  const storeAddress = settings?.address?.zh?.trim() || FALLBACK_STORE_ADDRESS;
  return {
    events: events.map((e) => {
      const product = products[e.id];
      return {
        id: e.id,
        slug: e.slug,
        status: e.status,
        titleZh: e.title?.zh ?? "",
        summaryZh: e.summary?.zh ?? "",
        displayDate: e.display_date ?? "",
        externalUrl: e.external_url ?? "",
        registrationType: e.registration_type,
        updatedAt: e.updated_at,
        productId: product?.id ?? null,
        price: product?.price ?? null,
      };
    }),
    sessions: sessions.map((s) => ({
      id: s.id,
      productId: s.product_id,
      titleZh: s.title?.zh ?? "",
      locationZh: s.location?.zh ?? "",
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      capacity: s.capacity,
      seatsTaken: s.seats_taken,
      updatedAt: s.updated_at,
    })),
    plans: plans.map((p) => ({
      sessionId: p.session_id,
      titleZh: p.title?.zh ?? "",
      price: p.price,
      status: p.status,
      updatedAt: p.updated_at,
    })),
    journeyUrls: journeys.filter((j) => j.status === "live").map((j) => j.external_url),
    storeAddress,
    now,
  };
}

export async function handleCalendarIcs(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  try {
    const body = buildCalendarIcs(await collectCalendarInput());
    return new Response(request.method === "HEAD" ? null : body, {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'inline; filename="calendar.ics"',
        "cache-control": CALENDAR_CACHE,
        "x-robots-tag": "noindex",
      },
    });
  } catch (err) {
    console.warn(`[calendar] unavailable — ${err instanceof Error ? err.message : String(err)}`);
    return new Response("calendar temporarily unavailable\n", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "300",
      },
    });
  }
}
