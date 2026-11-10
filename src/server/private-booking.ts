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
