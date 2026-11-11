/**
 * journeys server functions — the only way the admin UI is allowed to touch
 * public.journeys. Every export chains adminFnMiddleware: that middleware,
 * not the /admin/_shell route guard, is the real authorization boundary (see
 * src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { journeySchema, listingStatusSchema } from "@/lib/admin/schemas";

export const listJourneys = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listJourneys } = await import("@/server/repos/journeys");
    return await listJourneys();
  });

export const getJourneyById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getJourneyById } = await import("@/server/repos/journeys");
    return await getJourneyById(data.id);
  });

export const upsertJourney = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(journeySchema)
  .handler(async ({ data }) => {
    const { upsertJourney } = await import("@/server/repos/journeys");
    const result = await upsertJourney(data);
    // 活動內容變了 → 請 Google 日曆同步跟上（非阻塞、永不 throw；見 src/server/google-calendar.ts）。
    await (await import("@/server/google-calendar")).nudgeGoogleCalendarSync();
    return result;
  });

export const removeJourney = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeJourney } = await import("@/server/repos/journeys");
    await removeJourney(data.id);
    const result = { ok: true };
    // 活動內容變了 → 請 Google 日曆同步跟上（非阻塞、永不 throw；見 src/server/google-calendar.ts）。
    await (await import("@/server/google-calendar")).nudgeGoogleCalendarSync();
    return result;
  });

/**
 * 0052：策旅列表一次拿齊——卡片、每張卡片跟著哪一場活動（與 SQL journey_linked_event_id
 * 同一套判準）、那場活動的狀態與「報名中／額滿／已結束」要用的場次。
 */
export const getAdminJourneysPageData = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listJourneys } = await import("@/server/repos/journeys");
    const { listEvents, listEventProducts } = await import("@/server/repos/events");
    const { linkedEventIdFor } = await import("@/lib/journey-events");
    const [journeys, events, products] = await Promise.all([
      listJourneys(),
      listEvents(),
      listEventProducts(),
    ]);
    const byId = new Map(events.map((e) => [e.id, e]));
    return {
      journeys: journeys.map((j) => {
        const eventId = linkedEventIdFor(j.external_url, events);
        const ev = eventId ? byId.get(eventId) : undefined;
        return {
          ...j,
          linkedEvent: ev
            ? {
                id: ev.id,
                title: ev.title.zh,
                status: ev.status,
                registration_type: ev.registration_type,
                iso_date: ev.iso_date,
                sessions: products[ev.id]?.sessions ?? [],
              }
            : null,
        };
      }),
    };
  });

/** 0052：只給孤兒卡片（連不上任何活動）。連得上活動的卡片請改活動的狀態。 */
export const setJourneyStatus = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1), status: listingStatusSchema }))
  .handler(async ({ data }) => {
    const { setJourneyStatus } = await import("@/server/repos/journeys");
    const result = await setJourneyStatus(data.id, data.status);
    // 活動內容變了 → 請 Google 日曆同步跟上（非阻塞、永不 throw；見 src/server/google-calendar.ts）。
    await (await import("@/server/google-calendar")).nudgeGoogleCalendarSync();
    return result;
  });

/** 0052：策旅編輯頁——卡片本身，加上它跟著哪一場活動（顯示「狀態跟著活動」用）。 */
export const getAdminJourneyEditData = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getJourneyById } = await import("@/server/repos/journeys");
    const { listEvents } = await import("@/server/repos/events");
    const { linkedEventIdFor } = await import("@/lib/journey-events");
    const [journey, events] = await Promise.all([getJourneyById(data.id), listEvents()]);
    if (!journey) return { journey: null, linkedEvent: null };
    const eventId = linkedEventIdFor(journey.external_url, events);
    const ev = eventId ? events.find((e) => e.id === eventId) : undefined;
    return {
      journey,
      linkedEvent: ev ? { id: ev.id, title: ev.title.zh, status: ev.status } : null,
    };
  });
