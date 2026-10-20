/**
 * 「一頁新增活動」的寫入端。呼叫端（src/lib/admin/fns/events.ts#createEventQuick）
 * 已經掛了 adminFnMiddleware —— 與 src/server/repos/** 同一個假設。
 *
 * ── 🔴 只組裝既有的寫入，不自己寫任何一張表 ─────────────────────────────
 *   活動＋商品  → repos/events.ts#upsertEventWithProduct（0027 的 RPC，一個交易，
 *                  商品的標題／摘要／代稱／圖片投影規則只住在那支 SQL 裡）
 *   場次        → repos/event-sessions.ts#upsertEventSession
 *   票種        → repos/event-sessions.ts#upsertEventSessionPlan
 * 與組裝器、/admin/registrations 走的是同三支。seats_taken／units_taken 一個都不碰。
 *
 * ── 寫入順序：任何一步失敗，最多留下一份「沒發布的草稿」，而且會被清掉 ─────
 *   1. 活動＋商品，**一律先存成草稿**（events.is_published=false、商品 draft）
 *   2. 場次 → 3. 票種
 *   4. 要「立即發布」才再存一次活動＋商品，翻成 is_published=true／商品 active
 * 第 1–3 步之間不是一個資料庫交易（三支 repo 各自一個請求），所以失敗時照相反順序
 * 刪掉**這一次建立的那幾列**（票種隨場次 on delete cascade）。因為發布是最後一步，
 * 清理失敗的最壞情況也只是一份前台看不到的草稿，錯誤訊息會講出它的 id。
 */
import "@tanstack/react-start/server-only";
import {
  buildJourneyCard,
  buildQuickCreatePlan,
  pickUniqueSlug,
  slugBaseFor,
  stringsToTranslate,
  validateQuickCreate,
  type QuickCreateInput,
  type Translations,
} from "@/lib/admin/event-quick-create";
import { todayInTaipei } from "@/lib/event-status";

/** 單一字串的翻譯最多等這麼久；逾時就用中文頂上，不讓整張表單卡住。 */
const TRANSLATE_BUDGET_MS = 20_000;

export type QuickCreateResult = {
  eventId: string;
  slug: string;
  published: boolean;
  productId: string | null;
  sessionIds: string[];
  planIds: string[];
  /** 策旅卡片（public.journeys）的 id；建的是活動時是 null。 */
  journeyId: string | null;
  /** 沒翻成功、英日文暫用中文的字串數（0 ＝ 全部翻好了）。 */
  untranslated: number;
};

async function translateAll(texts: string[]): Promise<{ map: Translations; failed: number }> {
  const map: Translations = new Map();
  if (texts.length === 0) return { map, failed: 0 };
  const { translateToEnJa } = await import("@/server/translate");
  let failed = 0;
  await Promise.all(
    texts.map(async (text) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          translateToEnJa({ text: text.slice(0, 2000) }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), TRANSLATE_BUDGET_MS);
          }),
        ]);
        map.set(text, result);
      } catch (err) {
        // 翻譯是錦上添花：失敗（額度、逾時、沒設金鑰）就用中文頂上，記一筆讓畫面說得出口。
        failed += 1;
        console.warn(
          "[event-quick-create] 翻譯失敗，英日文暫用中文：",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  return { map, failed };
}

export async function createEventQuick(input: QuickCreateInput): Promise<QuickCreateResult> {
  const errors = validateQuickCreate(input);
  const firstError = Object.values(errors)[0];
  if (firstError) throw new Error(`表單有欄位需要修正：${firstError}`);

  const { listEvents, listTakenEventSlugs, upsertEventWithProduct, removeEvent } =
    await import("@/server/repos/events");
  const { upsertEventSession, upsertEventSessionPlan, removeEventSession } =
    await import("@/server/repos/event-sessions");
  const { removeProduct } = await import("@/server/repos/products");
  const { listJourneys, upsertJourney, removeJourney } = await import("@/server/repos/journeys");
  const { getEventCategoryById } = await import("@/server/repos/event-categories");
  const isJourney = input.kind === "journey";

  const base = slugBaseFor(input.sessions, todayInTaipei());
  const [events, taken, translated] = await Promise.all([
    listEvents(),
    listTakenEventSlugs(base),
    translateAll(stringsToTranslate(input)),
  ]);
  // 與組裝器「新增」同一個規則：排在目前最後一場的後面。
  const sortOrder = events.reduce((max, e) => Math.max(max, e.sort_order), 0) + 1;
  const slug = pickUniqueSlug(base, taken);
  const plan = buildQuickCreatePlan(input, {
    slug,
    sortOrder,
    translations: translated.map,
  });

  // 策旅卡片：排在目前最後一張後面；主題留空就用分類名稱（分類本來就有三語）。
  const journeyCard = isJourney
    ? buildJourneyCard(input, plan.event, {
        sortOrder: (await listJourneys()).reduce((max, j) => Math.max(max, j.sort_order), 0) + 1,
        translations: translated.map,
        categoryLabel: input.theme.trim()
          ? null
          : ((await getEventCategoryById(input.category))?.label ?? null),
      })
    : null;

  let eventId: string | null = null;
  let journeyId: string | null = null;
  let productId: string | null = null;
  const sessionIds: string[] = [];
  const planIds: string[] = [];

  try {
    // 1. 活動＋商品，先存成草稿。
    const draft = await upsertEventWithProduct(
      { ...plan.event, is_published: false },
      plan.product ? { price: plan.product.price, status: "draft" } : null,
    );
    eventId = draft.event.id;
    productId = draft.product?.id ?? null;
    if (plan.product && !productId) {
      throw new Error("建立活動商品失敗：RPC 沒有回傳商品");
    }

    // 2. 場次 → 3. 票種。場次一律 open：前台買不買得到由「活動發布＋商品上架」決定，
    //    這樣之後在組裝器把草稿發布時，不必再到另一頁一場一場打開。
    for (const s of plan.sessions) {
      const session = await upsertEventSession({
        product_id: productId!,
        title: s.title,
        location: s.location,
        starts_at: s.starts_at,
        ends_at: s.ends_at,
        capacity: s.capacity,
        status: "open",
        sort_order: s.sort_order,
      });
      sessionIds.push(session.id);
      for (const p of plan.plans) {
        const row = await upsertEventSessionPlan({
          session_id: session.id,
          title: p.title,
          price: p.price,
          seats_per_unit: p.seats_per_unit,
          capacity: s.capacity,
          status: "open",
          sort_order: p.sort_order,
        });
        planIds.push(row.id);
      }
    }

    // 3b. 策旅：/journeys 的卡片，同樣先存成草稿。
    if (journeyCard) {
      const card = await upsertJourney({ ...journeyCard, is_published: false });
      journeyId = card.id;
    }

    // 4. 發布是最後一步。
    if (input.publish) {
      await upsertEventWithProduct(
        { ...plan.event, id: eventId, is_published: true },
        plan.product ? { price: plan.product.price, status: "active" } : null,
      );
      if (journeyCard && journeyId) {
        await upsertJourney({ ...journeyCard, id: journeyId, is_published: true });
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const leftovers: string[] = [];
    if (journeyId) {
      try {
        await removeJourney(journeyId);
      } catch {
        leftovers.push(`策旅卡片 ${journeyId}`);
      }
    }
    // 相反順序清掉這一次建立的列。票種隨場次 cascade。
    for (const id of [...sessionIds].reverse()) {
      try {
        await removeEventSession(id);
      } catch {
        leftovers.push(`場次 ${id}`);
      }
    }
    if (productId) {
      try {
        await removeProduct(productId);
      } catch {
        leftovers.push(`商品 ${productId}`);
      }
    }
    if (eventId) {
      try {
        await removeEvent(eventId);
      } catch {
        leftovers.push(`活動 ${eventId}（草稿）`);
      }
    }
    throw new Error(
      leftovers.length
        ? `新增失敗：${reason}。另外有幾筆沒清乾淨，請到後台手動刪除：${leftovers.join("、")}`
        : `新增失敗，已復原，沒有留下任何資料：${reason}`,
    );
  }

  return {
    eventId: eventId!,
    slug,
    published: input.publish,
    productId,
    sessionIds,
    planIds,
    journeyId,
    untranslated: translated.failed,
  };
}
