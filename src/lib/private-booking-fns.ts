/**
 * 包場活動的場次時間：公開的 server fn（不用登入）。實作在 src/server/private-booking.ts。
 *
 * 只在頁面上真的有包場活動時才呼叫（活動頁、/events 月曆），一般活動不多一趟往返。
 * 讀取失敗回空物件：頁面退回「沒有場次時間」的樣子，報名入口一樣不會出現。
 */
import { createServerFn } from "@tanstack/react-start";
import type { PrivateSessionTime } from "@/lib/private-booking";

export const getPrivateSessionTimes = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown) => {
    const o = (raw && typeof raw === "object" ? raw : {}) as { slugs?: unknown };
    return { slugs: Array.isArray(o.slugs) ? o.slugs.slice(0, 50) : [] };
  })
  .handler(async ({ data }): Promise<Record<string, PrivateSessionTime[]>> => {
    const { readPrivateSessionTimes, sanitizePrivateSlugs } =
      await import("@/server/private-booking");
    try {
      return await readPrivateSessionTimes(sanitizePrivateSlugs(data.slugs));
    } catch (err) {
      console.warn(err instanceof Error ? err.message : String(err));
      return {};
    }
  });

/** loader 用：沒有包場代稱就不呼叫；任何錯誤 → 空物件。 */
export async function fetchPrivateSessionTimes(
  slugs: string[],
): Promise<Record<string, PrivateSessionTime[]>> {
  if (slugs.length === 0) return {};
  try {
    return await getPrivateSessionTimes({ data: { slugs } });
  } catch (err) {
    console.warn(`[private-booking] ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/**
 * /events 月曆：上架中活動的已關閉場次時間（報名截止／包場）。實作在
 * src/server/private-booking.ts#readClosedSessionTimes。輸入驗證與數量上限同上。
 */
export const getClosedSessionTimes = createServerFn({ method: "GET" })
  .inputValidator((raw: unknown) => {
    const o = (raw && typeof raw === "object" ? raw : {}) as { slugs?: unknown };
    return { slugs: Array.isArray(o.slugs) ? o.slugs.slice(0, 50) : [] };
  })
  .handler(async ({ data }): Promise<Record<string, PrivateSessionTime[]>> => {
    const { readClosedSessionTimes, sanitizePrivateSlugs } =
      await import("@/server/private-booking");
    try {
      return await readClosedSessionTimes(sanitizePrivateSlugs(data.slugs));
    } catch (err) {
      console.warn(err instanceof Error ? err.message : String(err));
      return {};
    }
  });

/** 月曆 loader 用：沒有代稱就不呼叫；任何錯誤 → 空物件（月曆只是少了關閉場次，不壞）。 */
export async function fetchClosedSessionTimes(
  slugs: string[],
): Promise<Record<string, PrivateSessionTime[]>> {
  if (slugs.length === 0) return {};
  try {
    return await getClosedSessionTimes({ data: { slugs } });
  } catch (err) {
    console.warn(`[calendar-closed] ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
