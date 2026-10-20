/**
 * 部署之後還開著的舊分頁：判斷「這是不是程式檔過期」、以及「可不可以自動重載」。
 *
 * 刻意寫成**零 import**的純函式模組，讓 scripts/stale-deploy-selftest.mjs 可以直接 import
 * 真正的程式碼來測（同 src/server/cache-policy.ts 的理由）。怎麼用見 src/router.tsx 檔頭。
 */

export const STALE_DEPLOY_ERROR =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading chunk .+ failed/i;

export const RELOAD_KEY = "ib:stale-deploy-reload-at";
/** 這段時間內重載過就不再自動重載——新版真的壞掉時才不會無限重整。 */
export const RELOAD_COOLDOWN_MS = 10_000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : error == null ? "" : String(error);
}

export function isStaleDeployError(error: unknown): boolean {
  return STALE_DEPLOY_ERROR.test(errorMessage(error));
}

/** 只讀不寫：現在自動重載的話，會不會被冷卻擋下來。沒有 storage 一律 false。 */
export function canReloadForNewDeploy(storage: StorageLike | null, now: number): boolean {
  if (!storage) return false;
  try {
    return now - Number(storage.getItem(RELOAD_KEY) || 0) >= RELOAD_COOLDOWN_MS;
  } catch {
    return false; // 記不住重載過沒——寧可停在錯誤頁，也不要冒無限重整的險
  }
}

/** 讀＋寫：可以重載就記下時間並回 true（呼叫端接著 location.reload()）。 */
export function claimReloadForNewDeploy(storage: StorageLike | null, now: number): boolean {
  if (!canReloadForNewDeploy(storage, now)) return false;
  try {
    storage!.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

/**
 * vite:preloadError 發生時該怎麼做。
 *
 * - **換頁中**（router 正在載入下一頁）：直接整頁重載到新網址。換頁本來就要離開這一頁，
 *   沒有東西會不見；不跳「剛剛的動作沒有送出」的提示——那句話在換頁時是錯的，而且會跟著
 *   錯誤頁一起閃一下（2026-10-20《海的聲音》按「立即報名」就是這樣）。
 * - **其他**（按鈕、表單送出、開對話框裡的 `await import()`）：不能重載，跳提示。
 */
export function preloadErrorAction(navigating: boolean, mayReload: boolean): "reload" | "announce" {
  return navigating && mayReload ? "reload" : "announce";
}
