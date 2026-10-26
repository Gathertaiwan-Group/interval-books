/**
 * event_sessions server functions — the only way the admin UI is allowed to
 * touch public.event_sessions. Every export chains a middleware: that
 * middleware, not the /admin/_shell route guard, is the real authorization
 * boundary (see src/lib/admin/middleware.ts).
 *
 * ── 寫是 admin，讀是 event.roster.read ───────────────────────────────────
 *
 * **寫**（upsert / remove）維持 adminFnMiddleware。開／關一個場次、改名額，決定的
 * 是「這場活動今天收不收得了報名」與「收多少人」。那與 CMS 的其他內容是同一類
 * 決定，不是門市每天的操作。
 *
 * **讀**（listEventSessions / listBookableProducts）在 0021 放寬到
 * staffFnMiddleware() + event.roster.read。Phase 1 的檔頭說「要放寬到店員的時候，
 * 那是一次獨立的決定，應該有自己的一行理由」—— 這就是那一行：
 *
 *   1. 名單頁需要場次列表才畫得出來。一個被授權看簽到表的人，如果連「有哪幾場」
 *      都讀不到，那個權限等於沒發。
 *   2. 名額的**寫入**仍然只有 admin 與那三支 SQL 函式碰得到，所以「誰能改名額」
 *      一個字都沒變。
 *
 * ⚠️ **這個放寬確實多送出了一點東西，不要說它沒有。**
 *
 *    這兩支的過濾條件比 anon 寬：`listEventSessions()` 回**全部**場次（含
 *    `status='closed'`），而 anon 的 policy 是 `status='open'` 且商品已上架；
 *    `listBookableProducts()` 回**全部** status 的 event／journey 商品（那支 repo
 *    自己的註解就寫著 "Every status, not just active"，因為場次通常要在商品上架
 *    之前就先建好），而 anon 只看得到 `status='active'`。
 *
 *    所以拿到 event.roster.read 的人會看到「還沒公開的活動叫什麼名字、預計開幾
 *    梯」。判斷是：這些人是店主明確授權去現場點名的內部同事，而洩漏面是**未上架
 *    活動的標題**，不是任何人的個資 —— 可以接受。但如果哪天這個權限要發給更外圍
 *    的人（工讀生、場地方、講師），這一段就是要重讀的地方：那時候正確的做法是把
 *    `listBookableProducts` 收回 adminFnMiddleware（建場次的下拉選單本來就只有
 *    admin 會用），畫面上的商品名稱改由場次自己帶。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware, staffFnMiddleware } from "@/lib/admin/middleware";
import { eventSessionPlanSchema, eventSessionSchema } from "@/lib/admin/schemas";

/** 與 fns/event-registrations.ts 同一支，刻意各寫一份 —— 兩個檔案的訊息各自演進。 */
async function requireRosterRead(permissions: readonly string[]): Promise<void> {
  if (permissions.includes("event.roster.read")) return;
  const { NotAuthorizedError } = await import("@/server/auth");
  throw new NotAuthorizedError("需要「查看活動報名名單」權限");
}

export const listEventSessions = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async ({ context }) => {
    await requireRosterRead(context.staff.permissions);
    const { listEventSessions } = await import("@/server/repos/event-sessions");
    return await listEventSessions();
  });

/**
 * The event/journey products a session can hang off. Feeds the form's dropdown,
 * which is a dropdown rather than free text so a typo cannot violate
 * event_sessions.product_id's foreign key after submit.
 */
export const listBookableProducts = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async ({ context }) => {
    await requireRosterRead(context.staff.permissions);
    const { listBookableProducts } = await import("@/server/repos/event-sessions");
    return await listBookableProducts();
  });

export const upsertEventSession = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(eventSessionSchema)
  .handler(async ({ data }) => {
    const { upsertEventSession } = await import("@/server/repos/event-sessions");
    return await upsertEventSession(data);
  });

/**
 * Deletes a sitting.
 *
 * Fails loudly when anyone has ever booked it (both event_registrations and
 * order_items reference it `on delete restrict`). The repo passes the Postgres
 * message straight through and the page shows it in a toast — see the repo for
 * why that is better than a friendlier invented sentence.
 */
export const removeEventSession = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeEventSession } = await import("@/server/repos/event-sessions");
    await removeEventSession(data.id);
    return { ok: true };
  });

// -----------------------------------------------------------------------------
// event_session_plans（0036）—— 場次底下的多個票種
// -----------------------------------------------------------------------------
// 授權形狀與上面的場次照抄：讀走 staffFnMiddleware() + event.roster.read
// （名單頁要顯示方案，看得到名單的人本來就要看得到方案），寫走 adminFnMiddleware。
//
// 這個檔案頂層對 eventSessionPlanSchema 的 import 是**靜態**的，跟
// eventSessionSchema 那一行一樣，而且理由也一樣：這整支 fns 檔案本身只被呼叫端
// 用 `await import("@/lib/admin/fns/event-sessions")` 動態載入（見
// _shell.registrations.tsx），schemas.ts 的真值 import 因此已經站在一個動態
// 邊界之後，不會流進訪客 bundle。schemas.ts 上那句「必須動態匯入」講的是
// **表單元件**（route 檔案裡的 sibling component）要怎麼拿到這個 schema 去餵
// zodResolver——那才是還沒有動態邊界保護的地方。
export const listEventSessionPlans = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async ({ context }) => {
    await requireRosterRead(context.staff.permissions);
    const { listEventSessionPlans } = await import("@/server/repos/event-sessions");
    return await listEventSessionPlans();
  });

export const upsertEventSessionPlan = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(eventSessionPlanSchema)
  .handler(async ({ data }) => {
    const { upsertEventSessionPlan } = await import("@/server/repos/event-sessions");
    return await upsertEventSessionPlan(data);
  });

/**
 * Deletes a plan.
 *
 * Unlike removeEventSession() above, this does NOT let a raw foreign-key
 * error surface — the repo pre-checks and returns a `reason` the page can show
 * as a sentence (see removeEventSessionPlan() in the repo for why: a plan's FK
 * violation, unlike a session's, does not read as a usable error string).
 */
export const removeEventSessionPlan = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeEventSessionPlan } = await import("@/server/repos/event-sessions");
    return await removeEventSessionPlan(data.id);
  });

// ---------------------------------------------------------------------------
// 整頁的資料（2026-10-25 後台提速）
// ---------------------------------------------------------------------------

/**
 * 「這個錯誤是不是『表／view 還不存在』」（原本在 _shell.registrations.tsx 的 loader 裡，2026-10-25
 * 隨整頁資料搬到伺服器）。
 *
 * PostgREST 對「表不存在」回的是 PGRST205（schema cache 找不到），直連 Postgres
 * 則是 42P01。兩個字串都認，因為這一段的重點是訊息本身。
 *
 * ⚠️ 刻意**沒有**收 `/does not exist/i`。那個字串太寬：`function … does not exist`
 *    （RPC 簽名打錯）與 `column … does not exist`（COLUMNS 漏改）也會命中，而那
 *    兩件事都是真的 bug，被說成「還沒套 migration」就會被藏起來，直到有人納悶
 *    為什麼套完了畫面還是那句話。
 */
function isSchemaMissingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /PGRST205|42P01|schema cache/i.test(message);
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/**
 * /admin/registrations 進場要的全部資料，一支 fn。
 *
 * 原本 loader 在瀏覽器端分**三輪**打 4 支 fn（場次＋商品 → 方案 → 報名人數），每一支都各自驗一次
 * 身分。現在身分只驗一次、4 個查詢同時跑。
 *
 * 權限與原本那 4 支**完全一樣**：staffFnMiddleware() ＋ requireRosterRead（event.roster.read）。
 *
 * 「migration 還沒套」的退化規則照搬 route 檔頭的說明，判斷順序也照原本的三輪：
 *   場次／商品任一個不是「表不存在」的錯 → 照丟；是 → schemaMissing。
 *   方案：不是「表不存在」→ 照丟；是 → 空的。
 *   報名人數：不是「表不存在」→ 照丟；是 → rosterReady: false。
 */
export const getAdminRegistrationsPageData = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .handler(async ({ context }) => {
    await requireRosterRead(context.staff.permissions);
    const repo = await import("@/server/repos/event-sessions");
    const { countRegistrationsBySession } = await import("@/server/repos/event-registrations");
    const [sessionsR, productsR, plansR, countsR] = await Promise.all([
      settle(repo.listEventSessions()),
      settle(repo.listBookableProducts()),
      settle(repo.listEventSessionPlans()),
      settle(countRegistrationsBySession()),
    ]);
    type Counts = Awaited<ReturnType<typeof countRegistrationsBySession>>;
    const empty = {
      sessions: [] as Awaited<ReturnType<typeof repo.listEventSessions>>,
      products: [] as Awaited<ReturnType<typeof repo.listBookableProducts>>,
      plans: [] as Awaited<ReturnType<typeof repo.listEventSessionPlans>>,
      counts: {} as Counts,
    };

    for (const r of [sessionsR, productsR]) {
      if (!r.ok && !isSchemaMissingError(r.error)) throw r.error;
    }
    if (!sessionsR.ok || !productsR.ok) {
      return { ...empty, schemaMissing: true, rosterReady: false };
    }
    const sessions = sessionsR.value;
    const products = productsR.value;

    let plans = empty.plans;
    if (plansR.ok) plans = plansR.value;
    else if (!isSchemaMissingError(plansR.error)) throw plansR.error;

    if (!countsR.ok) {
      if (!isSchemaMissingError(countsR.error)) throw countsR.error;
      return { ...empty, sessions, products, plans, schemaMissing: false, rosterReady: false };
    }
    return {
      sessions,
      products,
      plans,
      counts: countsR.value,
      schemaMissing: false,
      rosterReady: true,
    };
  });

/**
 * 場次內頁的資料，一支 fn（2026-10-25 後台第 2 批：名單／編輯從彈窗改成內頁）：
 *
 *   /admin/registrations/$sessionId（名單頁與 /edit 共用的 layout loader）→ sessionId
 *   /admin/registrations/new                                               → sessionId: null
 *
 * 回傳場次本身、可選的活動商品（表單下拉選單＋名單頁標題的商品名）、這個場次的票種、
 * 新場次的預設排序。
 *
 * 這裡沒有參加者的個資：/edit 也共用這個 loader，不需要名單。名單（姓名、電話、信箱）
 *    走 fns/event-registrations.ts 的 listSessionRoster()，由名單頁（index route）自己的
 *    loader 呼叫（業主 2026-10-26 起不寫查閱紀錄，所以可以放進 loader）。
 *
 * 權限與 getAdminRegistrationsPageData（原本彈窗的資料來源）**完全一樣**：
 * staffFnMiddleware() ＋ requireRosterRead（event.roster.read）。存檔仍是 adminFnMiddleware
 * 的 upsertEventSession／upsertEventSessionPlan，這支只讀。
 */
export const getEventSessionPageData = createServerFn({ method: "GET" })
  .middleware([staffFnMiddleware()])
  .inputValidator(z.object({ sessionId: z.string().trim().min(1).nullable() }))
  .handler(async ({ data, context }) => {
    await requireRosterRead(context.staff.permissions);
    const repo = await import("@/server/repos/event-sessions");
    if (data.sessionId === null) {
      const [sessions, products] = await Promise.all([
        repo.listEventSessions(),
        repo.listBookableProducts(),
      ]);
      const nextSortOrder = sessions.reduce((max, s) => Math.max(max, s.sort_order), 0) + 1;
      return {
        session: null,
        products,
        plans: [] as Awaited<ReturnType<typeof repo.listEventSessionPlans>>,
        nextSortOrder,
      };
    }
    const sessionId = data.sessionId;
    const [session, products, plans] = await Promise.all([
      repo.getEventSessionById(sessionId),
      repo.listBookableProducts(),
      repo.listEventSessionPlans(),
    ]);
    return {
      session,
      products,
      plans: session ? plans.filter((p) => p.session_id === sessionId) : [],
      nextSortOrder: session?.sort_order ?? 0,
    };
  });
