/**
 * 「過往活動」「過往策旅」卡片區用的純函式（2026-10-28 店長：「這邊下方，幫我多一區，
 * 用卡片的形式，去展現已經辦過的活動」「策旅的部分也是」）。
 *
 * 「已結束」的判準不在這裡重寫 —— 一律問 src/lib/event-status.ts 的 isEventPast()，
 * 與 /events「已結束」分頁、首頁精選活動同一條規則。這裡只負責兩件事：
 *
 *   1. 排序：最近結束的排最前面（以 max(iso_date, 最晚場次結束日) 為準）。
 *   2. 策旅的「已結束」：journeys 表沒有日期欄位，一趟策旅的日期與場次都在它指向的
 *      那一列 events 上（見 src/lib/journey-events.ts 檔頭）。所以「策旅已結束」＝
 *      「卡片指著的那場活動已結束」。指不到任何活動（外部網址、還沒設連結）→ 不算結束，
 *      理由與 isPastEvent() 對 null 日期回 false 相同：判不出來就留在進行中。
 */
import { isEventPast, todayInTaipei } from "@/lib/event-status";
import { journeyEventMatcher } from "@/lib/journey-events";

/** 卡片區最多幾張。 */
export const PAST_SHELF_LIMIT = 8;

type Dated = { isoDate: string | null | undefined; lastSessionDate?: string | null };

/** max(iso_date, 最晚場次結束日)。iso_date 為 null → ""（排到最後）。 */
export function effectiveEndDate(e: Dated): string {
  if (!e.isoDate) return "";
  const last = e.lastSessionDate;
  return last && last > e.isoDate ? last : e.isoDate;
}

/**
 * 已結束的那幾筆，最近結束的在前，最多 limit 筆。不改動傳入的陣列。
 * 同一天結束的維持原本的順序（Array#sort 是穩定排序）。
 */
export function newestEndedFirst<T extends Dated>(
  items: ReadonlyArray<T>,
  limit = PAST_SHELF_LIMIT,
  today = todayInTaipei(),
): T[] {
  return items
    .filter((e) => isEventPast(e, today))
    .sort((a, b) =>
      effectiveEndDate(b) < effectiveEndDate(a)
        ? -1
        : effectiveEndDate(b) > effectiveEndDate(a)
          ? 1
          : 0,
    )
    .slice(0, limit);
}

export type JourneyEventDate = Dated & {
  slug: string;
  externalUrl?: string | null;
  /** 顯示用日期（events.display_date）。 */
  date: string;
  imageKey: string | null;
};

/** 一趟策旅卡片指著的那場活動。指不到 → null。 */
export function linkedEventFor<E extends { slug: string; externalUrl?: string | null }>(
  journeyUrl: string | null | undefined,
  events: ReadonlyArray<E>,
): E | null {
  const isLinked = journeyEventMatcher([journeyUrl]);
  return events.find((e) => isLinked(e)) ?? null;
}

/**
 * 把策旅分成「進行中」與「已結束」兩組。
 *
 *   · open：原本的順序不變（sort_order）。
 *   · ended：最近結束的在前，最多 limit 筆；每一筆帶著它指著的活動（日期、封面圖要用）。
 */
export function splitJourneys<J extends { externalUrl: string }, E extends JourneyEventDate>(
  journeys: ReadonlyArray<J>,
  events: ReadonlyArray<E>,
  limit = PAST_SHELF_LIMIT,
  today = todayInTaipei(),
): { open: J[]; ended: { journey: J; event: E }[] } {
  const open: J[] = [];
  const ended: { journey: J; event: E }[] = [];
  for (const journey of journeys) {
    const event = linkedEventFor(journey.externalUrl, events);
    if (event && isEventPast(event, today)) ended.push({ journey, event });
    else open.push(journey);
  }
  const order = newestEndedFirst(
    ended.map((x) => x.event),
    ended.length,
    today,
  );
  ended.sort((a, b) => order.indexOf(a.event) - order.indexOf(b.event));
  return { open, ended: ended.slice(0, limit) };
}
