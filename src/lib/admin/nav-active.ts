/**
 * 後台側欄「哪一項要亮」的判斷。
 *
 * ── 為什麼這是一個檔案，而不是側欄裡的一行 ──────────────────────────────────
 * 原本的寫法是 `isActive={pathname === item.to}`：完全相符才亮。那條規則在每一個
 * 模組都只有一頁的時候是對的，但只要有一個模組長出子頁（當年是
 * /admin/pages/$slug——2026-10-29 已移除，現在是 /admin/events/$id、/admin/news/$id），它就會**整條側欄都不亮** —— 使用者站在一個深層
 * 編輯頁裡，側欄看起來像「不在任何模組內」。
 *
 * 換成 `pathname.startsWith(item.to)` 會換到另一個更糟的 bug：`/admin` 是每一個
 * 後台網址的前綴，所以**每一個子頁都會讓「儀表板」跟著亮**，於是同時亮兩項。
 *
 * 所以規則是「前綴比對 ＋ /admin 特例」，而且前綴比對要看**路徑分隔線**：
 * `/admin/inventory-count` 不可以因為 `/admin/inventory-counting` 而亮。
 *
 * ── 這個檔案為什麼一行 import 都沒有 ────────────────────────────────────────
 * 與 src/lib/admin/localized-list.ts、src/lib/event-blocks.ts 同一個理由：
 * scripts/event-assembler-selftest.mjs 才能不經過 bundler、不經過 tsconfig 的 `@/`
 * alias，直接 `await import()` **產線上真正跑的這一份**，拿真的路徑餵進去看它回什麼。
 * 「讀 _shell.tsx 的原始碼確認裡面有 startsWith」證明不了 /admin 不會跟著亮。
 */

/** 儀表板。它是每一個後台網址的前綴，所以是唯一一個只認完全相符的項目。 */
export const ADMIN_ROOT_PATH = "/admin";

/** 去掉結尾的斜線（"/" 本身除外）。/admin/ 與 /admin 是同一頁。 */
function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "");
  return pathname;
}

/**
 * 目前這個網址，該不該讓側欄的 `to` 這一項亮起來。
 *
 * · `/admin`（儀表板）—— **只有**完全相符才亮。它是所有後台網址的前綴，用前綴比對
 *   會讓它在每一個子頁跟著亮，於是側欄同時有兩項亮著。
 * · 其他項目 —— 自己那一頁，以及它底下的子頁（`/admin/events/abc` 讓「活動」亮）。
 *   比對到 `${to}/` 而不是 `to`，是為了不讓 `/admin/news` 因為 `/admin/news-x`
 *   這種**別的模組**而亮。
 */
export function isNavItemActive(pathname: string, to: string): boolean {
  const here = normalize(pathname);
  if (to === ADMIN_ROOT_PATH) return here === ADMIN_ROOT_PATH;
  return here === to || here.startsWith(`${to}/`);
}
