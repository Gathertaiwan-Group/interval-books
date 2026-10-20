/**
 * events server functions — the only way the admin UI is allowed to touch
 * public.events. Every export chains adminFnMiddleware: that middleware, not
 * the /admin/_shell route guard, is the real authorization boundary (see
 * src/lib/admin/middleware.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { eventQuickCreateSchema, eventSchema, eventWithProductSchema } from "@/lib/admin/schemas";

export const listEvents = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listEvents } = await import("@/server/repos/events");
    return await listEvents();
  });

export const getEventById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getEventById } = await import("@/server/repos/events");
    return await getEventById(data.id);
  });

export const upsertEvent = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(eventSchema)
  .handler(async ({ data }) => {
    const { upsertEvent } = await import("@/server/repos/events");
    return await upsertEvent(data);
  });

/**
 * 建立／更新活動**並且**上架成商品，一個交易。
 *
 * 與上面的 upsertEvent 是兩條路，不是同一條的兩種寫法：這一支走
 * supabase/migrations/0026 的 admin_upsert_event_with_session()，所以
 * 「products.description 取 events.summary」「products.slug = event-<events.slug>」
 * 這兩條投影規則只住在 SQL 那一支函式裡，後台不會有第二份會分岔的抄本。
 */
export const upsertEventWithProduct = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(eventWithProductSchema)
  .handler(async ({ data }) => {
    const { upsertEventWithProduct } = await import("@/server/repos/events");
    const { EVENT_LIST_FIELDS } = await import("@/lib/event-blocks");
    const { product, ...rest } = data;

    // 0027 的七個清單欄位在 payload 上是**平的**（highlights、suitable_for…），
    // 但 repo 要的是一個 lists 物件 —— 那一層是刻意的：repo 的 EventUpsertInput 上，
    // 「這一欄不動」與「把這一欄清空」是靠 key 在不在來分辨的，攤平在一堆固定欄位
    // 中間會讓那個區別很容易被下一個人 `?? EMPTY` 掉。
    //
    // ⚠️ 名單用 EVENT_LIST_FIELDS，不是在這裡再抄一次七個字串。抄一次就是第二個家。
    const lists = Object.fromEntries(
      EVENT_LIST_FIELDS.filter((f) => rest[f] !== undefined).map((f) => [f, rest[f]]),
    );
    const event = { ...rest, lists };
    return await upsertEventWithProduct(event, product ?? null);
  });

/**
 * 「一頁新增活動」：活動＋商品＋場次＋票種，一顆按鈕。
 *
 * 只組裝既有的三支 repo 寫入（見 src/server/event-quick-create.ts 的檔頭），先存草稿、
 * 最後才發布；任何一步失敗就把這一次建立的列刪掉。
 */
export const createEventQuick = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(eventQuickCreateSchema)
  .handler(async ({ data }) => {
    const { createEventQuick } = await import("@/server/event-quick-create");
    return await createEventQuick(data);
  });

/**
 * 這場活動排了哪幾場場次（最近的在前）。
 *
 * 活動頁組裝器用它顯示「活動地點」那一塊 —— 地點不是 events 的欄位，而是
 * event_sessions.location，所以那一塊在組裝器上是**唯讀的鏡子**。
 *
 * ⚠️ 走 adminFnMiddleware（不是 fns/event-sessions.ts 那一支的 staff + roster.read）：
 *    這裡回的是場次本身（時間、地點、名額），不是任何一位報名者的個資。名單仍然只有
 *    fns/event-registrations.ts 那幾支拿得到，而那幾支照舊要 event.roster.read。
 */
export const listSessionsForEvent = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { listSessionsForEvent } = await import("@/server/repos/events");
    return await listSessionsForEvent(data.id);
  });

/**
 * 每一場活動對應到的那件商品（＋場次數），keyed by events.id。活動列表用它顯示
 * 「已上架／草稿／未上架」，不必一場一場問。
 */
export const listEventProducts = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listEventProducts } = await import("@/server/repos/events");
    return await listEventProducts();
  });

/**
 * 這場活動有幾個場次。場次掛在 products.id 上（0020），不是 events.id ——
 * 所以「沒有商品」與「有商品但還沒排場次」都會是 0，那兩件事在 UI 上分別由
 * listEventProducts() 的 null 與這個 0 表示。
 */
export const countSessionsForEvent = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { countSessionsForEvent } = await import("@/server/repos/events");
    return await countSessionsForEvent(data.id);
  });

export const removeEvent = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeEvent } = await import("@/server/repos/events");
    await removeEvent(data.id);
    return { ok: true };
  });

/**
 * Event counts keyed by category id. events.category has `on delete
 * restrict`, so the event-categories admin page (src/routes/admin/_shell.categories.tsx)
 * uses this to disable deleting a category that still has events attached
 * instead of letting the admin hit a raw Postgres 23503 error.
 */
export const countEventsByCategory = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { countEventsByCategory } = await import("@/server/repos/events");
    return await countEventsByCategory();
  });
