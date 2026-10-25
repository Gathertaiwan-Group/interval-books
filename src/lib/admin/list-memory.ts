/**
 * 後台列表的「離開再回來還記得」（2026-10-25 後台第 2 批：彈窗改內頁）。
 *
 * 詳情／編輯從彈窗改成內頁之後，點進一筆再「← 回到列表」，列表元件會重新掛載——
 * 篩選條件、分頁、送審佇列的狀態如果只放在 useState，就會全部回到預設值。
 * 這裡用模組層的 Map 記住它們，回到列表時原樣還原（捲動位置由 router 的
 * scrollRestoration 處理）。
 *
 * 規則：
 *   · 只在瀏覽器端寫（伺服器上模組狀態被所有請求共用，寫了會串號）。
 *   · 只活在這個分頁的記憶體裡：重新整理就回到預設，跟 SSR 畫出來的一致（不會 hydration 不合）。
 *   · 換人登入／登出時整個清掉（route-cache.ts 的 noteAdminIdentityChange／
 *     clearAdminRouteCacheOnIdentityChange 呼叫 clearAdminListMemory）。
 *   · 篩選條件刻意**不放進網址**：關鍵字可能是廠商（個人）的名字，見 read-only-fn.ts 檔頭。
 *
 * 純邏輯、零 import：selftest 與 route-cache.ts 直接 import。
 */
const memory = new Map<string, unknown>();

export function readAdminListMemory<T>(key: string): T | undefined {
  return memory.get(key) as T | undefined;
}

export function writeAdminListMemory(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  memory.set(key, value);
}

export function clearAdminListMemory(): void {
  memory.clear();
}

/**
 * 「點進內頁之前，列表上那一列長什麼樣」：內頁的 loader 還在跑的時候，標題列先用這一份
 * 畫出來（pendingComponent），不用等整頁資料回來才換畫面。只拿來畫標題，不拿來做決定——
 * loader 回來之後一律以 loader 的資料為準。
 */
export function rememberAdminPeek(kind: string, id: string, row: unknown): void {
  writeAdminListMemory(`peek:${kind}:${id}`, row);
}

export function readAdminPeek<T>(kind: string, id: string): T | undefined {
  return readAdminListMemory<T>(`peek:${kind}:${id}`);
}
