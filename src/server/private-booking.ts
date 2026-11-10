/**
 * 包場活動的場次時間（只讀、只給前台顯示）。由 src/lib/private-booking-fns.ts 的 server fn 呼叫。
 *
 * 為什麼要用 service role：包場的場次維持 event_sessions.status = 'closed'（讓
 * reserve_session_seat() 回 SESSION_NOT_OPEN），而 anon 的 RLS 只放行 open 場次（0020）——
 * 前台用 anon 讀，就會變成「這場活動目前沒有公開的場次時間」、月曆變「全天」。
 * 與 /calendar.ics（src/server/calendar.ts）同一個理由、同一個做法。
 *
 * 範圍刻意收得很窄：
 *   · 只回 events.status = 'live' **且** notes 上有包場旗標的活動（isPrivateBooking）。
 *     一般活動的關閉場次不會從這裡漏出去——它們在前台本來就不該出現。
 *   · 只取時間、名稱、地點（沒有 capacity／seats_taken、沒有名單、沒有訂單）。
 *   · 最多 MAX_PRIVATE_SLUGS 個代稱，格式不對的直接丟掉。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import { isPrivateBooking, type PrivateSessionTime } from "@/lib/private-booking";

export const MAX_PRIVATE_SLUGS = 50;
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;

type Loc = { zh: string; en: string; ja: string };

function loc(v: unknown): Loc {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  return { zh: s(o.zh), en: s(o.en), ja: s(o.ja) };
}

export function sanitizePrivateSlugs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v === "string" && SLUG_RE.test(v)) out.add(v);
    if (out.size >= MAX_PRIVATE_SLUGS) break;
  }
  return [...out];
}

/** 代稱 → 那場包場活動的場次時間（依開始時間排序）。不是包場／沒上架的代稱不會出現。 */
export async function readPrivateSessionTimes(
  slugs: string[],
): Promise<Record<string, PrivateSessionTime[]>> {
  if (slugs.length === 0) return {};
  const db = supabaseAdmin();
  const { data: events, error } = await db
    .from("events")
    .select("id, slug, notes")
    .in("slug", slugs)
    .eq("status", "live");
  if (error) throw new Error(`[private-booking] events：${error.message}`);
  const privateEvents = ((events ?? []) as { id: string; slug: string; notes: unknown }[]).filter(
    (e) => isPrivateBooking(e.notes),
  );
  if (privateEvents.length === 0) return {};

  const slugById = new Map(privateEvents.map((e) => [e.id, e.slug]));
  const { data: products, error: productError } = await db
    .from("products")
    .select("source_id, event_sessions(id, title, location, starts_at, ends_at)")
    .eq("source_type", "event")
    // 加固：只讀上架中（active）的票券商品。活動 live 時 trigger 會讓商品是 active（0052），
    // 這一條讓兩邊萬一不同步時也不會讀到下架商品的場次。
    .eq("status", "active")
    .in("source_id", [...slugById.keys()]);
  if (productError) throw new Error(`[private-booking] products：${productError.message}`);

  const out: Record<string, PrivateSessionTime[]> = {};
  for (const p of (products ?? []) as { source_id: string; event_sessions?: unknown }[]) {
    const slug = slugById.get(p.source_id);
    if (!slug) continue;
    const rows = Array.isArray(p.event_sessions)
      ? (p.event_sessions as Record<string, unknown>[])
      : [];
    const list: PrivateSessionTime[] = [];
    for (const s of rows) {
      if (typeof s.id !== "string" || typeof s.starts_at !== "string") continue;
      list.push({
        id: s.id,
        title: loc(s.title),
        location: loc(s.location),
        startsAt: s.starts_at,
        endsAt: typeof s.ends_at === "string" ? s.ends_at : null,
      });
    }
    list.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    out[slug] = list;
  }
  return out;
}

/**
 * /events 月曆用：上架中活動（包場與一般活動都算）的**已關閉**場次時間。
 *
 * 為什麼：anon 的 RLS 只放行 open 場次（0020），報名截止（後台把場次關掉）但活動照常舉辦
 * 的場次在月曆上會消失，而 /calendar.ics（service role）照樣列著——兩處對不起來
 * （2026-11-10 業主決定：月曆繼續顯示，標「報名截止」）。open 場次前台本來就讀得到，
 * 這裡只補 closed 的，呼叫端以場次 id 去重。
 *
 * 範圍與 readPrivateSessionTimes 一樣窄：
 *   · 只回 events.status = 'live' 的活動（草稿、下架的場次不會漏出去）。
 *   · 只回 event_sessions.status = 'closed' 的場次。
 *   · 只取 id、名稱、地點、開始、結束（沒有 capacity／seats_taken、沒有名單、沒有訂單）。
 *   · 代稱先過 sanitizePrivateSlugs（格式、最多 MAX_PRIVATE_SLUGS 個）——由呼叫端的 server fn 做。
 */
export async function readClosedSessionTimes(
  slugs: string[],
): Promise<Record<string, PrivateSessionTime[]>> {
  if (slugs.length === 0) return {};
  const db = supabaseAdmin();
  const { data: events, error } = await db
    .from("events")
    .select("id, slug")
    .in("slug", slugs)
    .eq("status", "live");
  if (error) throw new Error(`[calendar-closed] events：${error.message}`);
  const liveEvents = (events ?? []) as { id: string; slug: string }[];
  if (liveEvents.length === 0) return {};

  const slugById = new Map(liveEvents.map((e) => [e.id, e.slug]));
  const { data: products, error: productError } = await db
    .from("products")
    .select("source_id, event_sessions(id, title, location, starts_at, ends_at, status)")
    .eq("source_type", "event")
    // 加固：只讀上架中（active）的票券商品。活動 live 時 trigger 會讓商品是 active（0052），
    // 這一條讓兩邊萬一不同步時也不會讀到下架商品的場次。
    .eq("status", "active")
    .in("source_id", [...slugById.keys()]);
  if (productError) throw new Error(`[calendar-closed] products：${productError.message}`);

  const out: Record<string, PrivateSessionTime[]> = {};
  for (const p of (products ?? []) as { source_id: string; event_sessions?: unknown }[]) {
    const slug = slugById.get(p.source_id);
    if (!slug) continue;
    const rows = Array.isArray(p.event_sessions)
      ? (p.event_sessions as Record<string, unknown>[])
      : [];
    const list: PrivateSessionTime[] = [];
    for (const s of rows) {
      if (s.status !== "closed") continue;
      if (typeof s.id !== "string" || typeof s.starts_at !== "string") continue;
      list.push({
        id: s.id,
        title: loc(s.title),
        location: loc(s.location),
        startsAt: s.starts_at,
        endsAt: typeof s.ends_at === "string" ? s.ends_at : null,
      });
    }
    if (list.length === 0) continue;
    list.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    out[slug] = list;
  }
  return out;
}

// =============================================================================
// 60 秒記憶體快取（伺服器端、每個 instance 各自一份）
// =============================================================================
//
// 月曆／首頁／活動頁的 loader 在 SSR 直接呼叫（不經公開 server fn）；客端換頁（換月、
// 從首頁點進 /events）時 loader 在瀏覽器跑，才走公開的 server fn。兩條路都經過這裡，
// 同一組代稱 60 秒內只打一次資料庫（Vercel 函式 CPU 曾超量被暫停）。
// key = 種類 + 排序後的代稱列表；存的是 Promise（同時進來的請求共用一趟），失敗立刻丟掉。
// 最多 CACHE_MAX 個 key，滿了先清過期的、再不夠就清掉最舊的。

export const SESSION_TIMES_CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
type CacheEntry = { at: number; value: Promise<Record<string, PrivateSessionTime[]>> };
const sessionTimesCache = new Map<string, CacheEntry>();

export function sessionTimesCacheKey(kind: string, slugs: string[]): string {
  return `${kind}:${[...new Set(slugs)].sort().join(",")}`;
}

function cachedRead(
  kind: string,
  slugs: string[],
  load: (slugs: string[]) => Promise<Record<string, PrivateSessionTime[]>>,
  now: number = Date.now(),
): Promise<Record<string, PrivateSessionTime[]>> {
  if (slugs.length === 0) return Promise.resolve({});
  const key = sessionTimesCacheKey(kind, slugs);
  const hit = sessionTimesCache.get(key);
  if (hit && now - hit.at < SESSION_TIMES_CACHE_TTL_MS) return hit.value;
  if (sessionTimesCache.size >= CACHE_MAX) {
    for (const [k, v] of sessionTimesCache) {
      if (now - v.at >= SESSION_TIMES_CACHE_TTL_MS) sessionTimesCache.delete(k);
    }
    while (sessionTimesCache.size >= CACHE_MAX) {
      const oldest = sessionTimesCache.keys().next().value;
      if (oldest === undefined) break;
      sessionTimesCache.delete(oldest);
    }
  }
  const value = load(slugs);
  sessionTimesCache.set(key, { at: now, value });
  value.catch(() => {
    if (sessionTimesCache.get(key)?.value === value) sessionTimesCache.delete(key);
  });
  return value;
}

/** readClosedSessionTimes 加 60 秒快取。代稱請先過 sanitizePrivateSlugs。 */
export function readClosedSessionTimesCached(
  slugs: string[],
): Promise<Record<string, PrivateSessionTime[]>> {
  return cachedRead("closed", slugs, readClosedSessionTimes);
}

/** readPrivateSessionTimes 加 60 秒快取。代稱請先過 sanitizePrivateSlugs。 */
export function readPrivateSessionTimesCached(
  slugs: string[],
): Promise<Record<string, PrivateSessionTime[]>> {
  return cachedRead("private", slugs, readPrivateSessionTimes);
}
