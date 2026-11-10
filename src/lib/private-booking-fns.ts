/**
 * 已關閉場次的時間（包場、報名截止）——前台 loader 用。實作在 src/server/private-booking.ts。
 *
 * ── 兩條路 ──────────────────────────────────────────────────────────────────
 * loader 是同構的：SSR 時在伺服器跑，客端換頁（月曆換月、從首頁點進 /events、點進活動頁）
 * 時在瀏覽器跑。所以：
 *   · 伺服器端（createIsomorphicFn 的 .server）：直接呼叫 readXxxSessionTimesCached，
 *     不經過公開的 server fn、不多一趟 HTTP。
 *   · 瀏覽器端（.client）：只能走公開的 server fn（getPrivateSessionTimes／getClosedSessionTimes）。
 *     客端換頁還需要它，所以保留；伺服器那一側同樣經過 60 秒記憶體快取。
 * 兩條路都先截 MAX_PRIVATE_SLUGS 個、再過 sanitizePrivateSlugs（格式白名單）。
 *
 * 讀取失敗回空物件：頁面退回「沒有場次時間」的樣子，報名入口一樣不會出現。
 */
import { createIsomorphicFn, createServerFn } from "@tanstack/react-start";
import type { PrivateSessionTime } from "@/lib/private-booking";

type Times = Record<string, PrivateSessionTime[]>;

/** 與 src/server/private-booking.ts 的 MAX_PRIVATE_SLUGS 相同（這裡不能 import server 模組）。 */
export const MAX_SLUGS_PER_CALL = 50;

function validateSlugs(raw: unknown): { slugs: unknown[] } {
  const o = (raw && typeof raw === "object" ? raw : {}) as { slugs?: unknown };
  return { slugs: Array.isArray(o.slugs) ? o.slugs.slice(0, MAX_SLUGS_PER_CALL) : [] };
}

/** 公開 server fn：包場活動的場次時間（活動頁客端換頁用）。 */
export const getPrivateSessionTimes = createServerFn({ method: "GET" })
  .inputValidator(validateSlugs)
  .handler(async ({ data }): Promise<Times> => {
    const { readPrivateSessionTimesCached, sanitizePrivateSlugs } =
      await import("@/server/private-booking");
    try {
      return await readPrivateSessionTimesCached(sanitizePrivateSlugs(data.slugs));
    } catch (err) {
      console.warn(err instanceof Error ? err.message : String(err));
      return {};
    }
  });

/** 公開 server fn：上架中活動的已關閉場次時間（月曆客端換月、從別頁點進來用）。 */
export const getClosedSessionTimes = createServerFn({ method: "GET" })
  .inputValidator(validateSlugs)
  .handler(async ({ data }): Promise<Times> => {
    const { readClosedSessionTimesCached, sanitizePrivateSlugs } =
      await import("@/server/private-booking");
    try {
      return await readClosedSessionTimesCached(sanitizePrivateSlugs(data.slugs));
    } catch (err) {
      console.warn(err instanceof Error ? err.message : String(err));
      return {};
    }
  });

const readPrivateTimes = createIsomorphicFn()
  .server(async (slugs: string[]): Promise<Times> => {
    const { readPrivateSessionTimesCached, sanitizePrivateSlugs } =
      await import("@/server/private-booking");
    return await readPrivateSessionTimesCached(sanitizePrivateSlugs(slugs));
  })
  .client(async (slugs: string[]): Promise<Times> => {
    return await getPrivateSessionTimes({ data: { slugs } });
  });

const readClosedTimes = createIsomorphicFn()
  .server(async (slugs: string[]): Promise<Times> => {
    const { readClosedSessionTimesCached, sanitizePrivateSlugs } =
      await import("@/server/private-booking");
    return await readClosedSessionTimesCached(sanitizePrivateSlugs(slugs));
  })
  .client(async (slugs: string[]): Promise<Times> => {
    return await getClosedSessionTimes({ data: { slugs } });
  });

/** 切成每批最多 MAX_SLUGS_PER_CALL 個（去重、保留順序）。 */
export function chunkSlugs(slugs: string[], size: number = MAX_SLUGS_PER_CALL): string[][] {
  const uniq = [...new Set(slugs)];
  const out: string[][] = [];
  for (let i = 0; i < uniq.length; i += size) out.push(uniq.slice(i, i + size));
  return out;
}

async function readInBatches(
  slugs: string[],
  read: (slugs: string[]) => Promise<Times>,
  label: string,
): Promise<Times> {
  if (slugs.length === 0) return {};
  const parts = await Promise.all(
    chunkSlugs(slugs).map(async (batch) => {
      try {
        return await read(batch);
      } catch (err) {
        console.warn(`[${label}] ${err instanceof Error ? err.message : String(err)}`);
        return {} as Times;
      }
    }),
  );
  return Object.assign({}, ...parts) as Times;
}

/** 活動頁 loader 用：沒有包場代稱就不呼叫；任何錯誤 → 空物件。 */
export async function fetchPrivateSessionTimes(slugs: string[]): Promise<Times> {
  return await readInBatches(slugs, readPrivateTimes, "private-booking");
}

/**
 * 月曆 loader 用：上架中活動的已關閉場次（報名截止／包場）。超過 MAX_SLUGS_PER_CALL 個
 * 代稱時分批（平行）；任何一批失敗只少那一批（月曆只是少了關閉場次，不壞）。
 */
export async function fetchClosedSessionTimes(slugs: string[]): Promise<Times> {
  return await readInBatches(slugs, readClosedTimes, "calendar-closed");
}
