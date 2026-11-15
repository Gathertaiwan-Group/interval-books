/**
 * 「包場（不開放報名）」—— 活動公開顯示，但清楚標示包場、沒有任何報名／購買入口。
 *
 * 零 @/ import（只有型別），scripts/private-booking-selftest.mjs 直接 import。
 *
 * ── 旗標存在哪裡：events.notes 這個 jsonb 物件上的保留 key `private_booking` ──────
 * 2026-11-10 做這個功能時 DDL 被擋、不能新增欄位，所以找一個「不需要 migration」的家：
 *   · events.registration_type 有 CHECK（external／internal），塞不進第三個值。
 *   · payment_enabled 已經有「需付款」的意思（一頁新增會寫它），不能挪用。
 *   · 0027 的七個清單欄位是 jsonb，CHECK 是 is_localized_list()：只要求 zh/en/ja 三個
 *     字串陣列，**不禁止多一個 key**。admin_upsert_event_with_session() 把 payload 的
 *     event.notes 原樣寫進去、沒帶就沿用舊值，anon 也讀得到 events.notes（活動頁本來就
 *     select 它）。所以 `{"zh":[…],"en":[…],"ja":[…],"private_booking":true}` 不必動資料庫
 *     就能寫、能讀、走的是後台同一支 RPC。
 *   前台所有讀 notes 的地方只取 zh/en/ja 三個陣列（cms.ts readEventLists），多出來的 key
 *   不會被印出來。
 *
 * 🔴 寫入只有一個家：src/server/repos/events.ts#upsertEventWithProduct 的
 *    `private_booking` 參數（後台活動編輯頁、MCP update_event 都走它）。送了 notes 卻沒
 *    帶 private_booking 時，repo 會讀回舊值保留旗標——不會因為改了「注意事項」就把包場洗掉。
 *
 * 🔴 包場不等於「場次關閉」，兩道門都要在：
 *    1. 場次 event_sessions.status = closed → reserve_session_seat() 回 SESSION_NOT_OPEN（資料庫）。
 *    2. 活動是包場 → priceLines 的 ticketSellable() 不給賣（sellableEventStatus()，結帳伺服器）。
 *    前台則完全不畫場次選擇器、人數、報名按鈕、票價。
 *
 * 之後真的能套 migration 時，最小草案是：events 加 `private_booking boolean not null default false`
 * （或 registration_type 的 CHECK 多一個 'private'），RPC 多收一個 key，再把這裡的讀寫換過去。
 */

/** events.notes 上的保留 key。 */
export const PRIVATE_BOOKING_KEY = "private_booking";

export type PlainLocalizedList = { zh: string[]; en: string[]; ja: string[] };

/** events.notes（任何形狀）→ 這場是不是包場。只認 `=== true`。 */
export function isPrivateBooking(notes: unknown): boolean {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) return false;
  return (notes as Record<string, unknown>)[PRIVATE_BOOKING_KEY] === true;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** notes → 只剩三個語言陣列（拿掉旗標與任何其他 key）。 */
export function stripPrivateBooking(notes: unknown): PlainLocalizedList {
  const o = (notes && typeof notes === "object" ? notes : {}) as Record<string, unknown>;
  return { zh: strings(o.zh), en: strings(o.en), ja: strings(o.ja) };
}

/**
 * 要寫進 events.notes 的值：三語清單＋（是包場才有）`private_booking: true`。
 * 不是包場時**整個 key 都不放**，而不是寫 false——資料庫裡只看得到「是」的那幾場。
 */
export function withPrivateBooking(
  notes: unknown,
  privateBooking: boolean,
): PlainLocalizedList & { private_booking?: true } {
  const base = stripPrivateBooking(notes);
  return privateBooking ? { ...base, [PRIVATE_BOOKING_KEY]: true as const } : base;
}

/**
 * 結帳第二道門（ticketSellable）看的「活動狀態」：包場一律當成不能賣。
 * 用一個不是 live 的字串頂替，ticketSellable() 的判斷式就不必改。
 */
export const PRIVATE_BOOKING_STATUS = "private_booking";
export function sellableEventStatus(status: string, notes: unknown): string {
  return isPrivateBooking(notes) ? PRIVATE_BOOKING_STATUS : status;
}

type L = { zh: string; en: string; ja: string };

/** 前台文案（三語）。 */
export const PRIVATE_BOOKING_COPY: { badge: L; notice: L; adminLabel: string; adminHint: string } =
  {
    badge: { zh: "包場", en: "Private event", ja: "貸切" },
    notice: {
      zh: "本場為包場活動，不開放對外報名。",
      en: "This is a private event and is not open to public registration.",
      ja: "本イベントは貸切のため、一般のお申し込みは受け付けておりません。",
    },
    adminLabel: "包場，不開放報名",
    adminHint:
      "打開後：活動照常出現在列表、月曆與活動頁，場次時間照列並標「包場」，報名區只顯示「本場為包場活動，不開放對外報名。」，沒有任何報名或購買入口，結帳也會拒絕。場次請維持「關閉」。",
  };

/** 包場活動的一個場次：只有時間、名稱、地點（沒有名額——包場不賣位子）。 */
export type PrivateSessionTime = {
  id: string;
  title: { zh: string; en: string; ja: string };
  location: { zh: string; en: string; ja: string };
  startsAt: string;
  endsAt: string | null;
};

// =============================================================================
// 「不開放線上報名」（2026-11-15）：活動上架、但每一個場次都是 closed
// =============================================================================
//
// 例：協會主辦、店裡只是場地的講座（/events/art-life-talk-1205）。後台把場次狀態設成
// 「未開放」（event_sessions.status = 'closed'），而 anon 的 RLS 只放行 open 場次（0020），
// 於是 fetchActiveProductForEventSlug() 拿到一件**零場次**的商品——活動頁原本把它畫成
// 「沒有公開的場次時間」＋「每一場都已額滿」，兩句都是錯的。
//
// 修法：活動頁 loader 在「商品在、但讀不到任何 open 場次」時，另用 readClosedSessionTimes
// （service role、只回 live 活動的 closed 場次時間，與月曆同一支、同一個 60 秒快取）把時間
// 讀回來；有讀到就換成「場次照列＋本場不開放線上報名」的畫面。
//
// 🔴 「已額滿」維持原樣：只要還有任何一個 open 場次（即使名額用完），就不走這裡。
//    額滿是「開放了但沒位子」，不開放是「本來就不收」，兩件事。
// 🔴 包場優先：包場活動另有 PrivateBookingPanel，呼叫端先判包場。

/**
 * 這場活動是不是「每一個場次都不收線上報名」：讀得到的 open 場次是零個，而 closed 場次至少
 * 一個。回 closed 場次（依開始時間排序）；不符合就回空陣列。
 */
export function onlineRegistrationClosedSessions(
  openSessionCount: number,
  closedSessions: readonly PrivateSessionTime[] | null | undefined,
): PrivateSessionTime[] {
  if (openSessionCount > 0) return [];
  const list = [...(closedSessions ?? [])];
  list.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return list;
}

/** 報名區文案（三語）。 */
export const ONLINE_REGISTRATION_CLOSED_COPY: { notice: L } = {
  notice: {
    zh: "本場不開放線上報名，詳情請見活動介紹。",
    en: "Online registration is not available for this event. Please see the event description for details.",
    ja: "本イベントはオンラインでのお申し込みを受け付けておりません。詳しくはイベント紹介をご覧ください。",
  },
};
