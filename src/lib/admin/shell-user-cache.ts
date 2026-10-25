/**
 * /admin/_shell 的 beforeLoad「現在誰登入」在瀏覽器端的短暫快取。
 *
 * ── 為什麼 ─────────────────────────────────────────────────────────────────
 * TanStack Router 每一次在後台裡換頁都會重跑 _shell 的 beforeLoad，而它呼叫
 * getCurrentBackOfficeUser()——一趟 server fn（瀏覽器 → Vercel → Supabase 讀
 * profiles／staff_permissions）。那一趟必須跑完，該頁的 loader 才開始跑，所以
 * 每次換頁都多一段依序的等待。後台裡點來點去，這段等待大部分是在重問同一個答案。
 *
 * ── 為什麼這樣做是安全的 ─────────────────────────────────────────────────
 * beforeLoad 的回傳值**不是授權**（見 _shell.tsx 與 fns/auth.ts 檔頭）：它只決定
 * 側欄長什麼樣、要不要導去登入頁。真正擋人的是每一支 server fn 的
 * adminFnMiddleware／staffFnMiddleware，它們每次都重讀 profiles。快取最壞的情況是
 * 「權限剛被收回的人，在 TTL 內還看得到側欄」——他點下去的每一頁 loader 一樣會被
 * middleware 擋下來。
 *
 * 規則：
 *   · 只在瀏覽器端用（SSR 每一個請求都重問，伺服器上沒有跨請求的模組狀態可以共用）。
 *   · 只快取「已登入、不是 pending」的結果；沒登入／pending 一律重問。
 *   · TTL 短（預設 60 秒）。登出（_shell.tsx、pending.tsx）與登入成功（login.tsx）
 *     時立刻清掉——沒按登出就換帳號，也不會沿用前一個人的側欄。
 *
 * 純邏輯、零 import：selftest 可以直接 import() 這個檔案本人。
 *
 * ⚠️ 模組層的單例 shellUserCache 只會在瀏覽器端被寫入（呼叫端自己判斷
 *    typeof window）。伺服器上同一個模組實例會被所有請求共用，寫進去就會串號。
 */

export const SHELL_USER_TTL_MS = 60_000;

export type ShellUserCache<T> = {
  /** 還在 TTL 內就回快取值，否則 null。 */
  get(now: number): T | null;
  set(value: T, now: number): void;
  clear(): void;
};

export function createShellUserCache<T>(ttlMs: number = SHELL_USER_TTL_MS): ShellUserCache<T> {
  let value: T | null = null;
  let storedAt = 0;
  return {
    get(now) {
      if (value === null) return null;
      if (now - storedAt >= ttlMs || now < storedAt) {
        value = null;
        return null;
      }
      return value;
    },
    set(v, now) {
      value = v;
      storedAt = now;
    },
    clear() {
      value = null;
      storedAt = 0;
    },
  };
}

/**
 * 整個瀏覽器分頁共用的那一份。值的形狀由 _shell.tsx 決定（getCurrentBackOfficeUser
 * 的回傳），這裡不 import 它的型別，保持零 import。
 */
export const shellUserCache: ShellUserCache<object> = createShellUserCache<object>();

/** 登入、登出時呼叫。 */
export function clearShellUserCache(): void {
  shellUserCache.clear();
}
