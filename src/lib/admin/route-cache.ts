/**
 * 後台路由資料的瀏覽器端快取規則（2026-10-25 後台提速第 1 批）。
 *
 * ── 做了什麼 ────────────────────────────────────────────────────────────────
 * 1. /admin/_shell 底下每一個 route：staleTime ＝ preloadStaleTime ＝ 30 秒。
 *    「回上一頁」或 30 秒內再點同一頁 → 直接用記憶體裡的 loader 資料，不再打 server fn；
 *    超過 30 秒 → 先畫舊資料、背景重抓（TanStack Router 的 stale-while-revalidate）。
 *    側欄連結 preload="intent"：滑過就開始抓，preloadStaleTime 讓點下去時直接沿用。
 *    前台的 route 一個都不動（staleTime 仍是 0）——前台有名額、庫存這類一直在變的數字。
 *
 * 2. **寫入之後一定看得到自己剛改的東西**：src/start.ts 掛了一支全域的 client
 *    middleware，瀏覽器每送出一次 POST server fn（這個專案的寫入全部是 POST；
 *    讀取大多是 GET，少數 POST 的讀取只會造成多清一次快取，不會錯）就呼叫
 *    {@link noteAdminMutation}：
 *      · 立刻丟掉「不在畫面上的」後台 route 快取與預載 → 之後再進去一定重抓（會等新資料，
 *        不會先閃一下舊的）。
 *      · 畫面上那一頁由它自己處理（各頁寫入後本來就 router.invalidate() 或自己重抓）；
 *        等下一次換頁完成（onResolved），剛離開的那一頁被搬進快取時再清一次——
 *        有些頁面（進銷存）寫入後只重抓自己的 state，loader 的資料還是舊的，
 *        不清的話 30 秒內按「上一頁」會看到改之前的樣子。
 *
 * 3. **換人登入不可以看到上一個人的資料**：登入成功、登出、以及 _shell 發現
 *    「現在登入的 userId 跟上次不一樣」時，整個 router 快取清掉（{@link clearAdminRouteCacheOnIdentityChange}）。
 *    門市人員接手管理員沒登出的分頁，不會從快取看到只有 admin 能看的頁面。
 *
 * ⚠️ 這裡只是畫面快取，**不是授權**。每一支 server fn 仍然各自掛 adminFnMiddleware／
 *    staffFnMiddleware，每次都重讀 profiles。
 *
 *    同一個瀏覽器的其他分頁也要跟著清（cookie 是整個瀏覽器共用的）：登入／登出時用
 *    BroadcastChannel 廣播，其他分頁收到就把「誰登入」快取與 router 快取一起清掉。
 *
 * 沒有 import 任何 router 或 React（只 import 零依賴的 shell-user-cache）：selftest 可以直接
 * import() 這個檔案。
 */
import { clearShellUserCache } from "./shell-user-cache.ts";
import { isBackOfficePath } from "./back-office-path.ts";
import { clearAdminListMemory } from "./list-memory.ts";

export const ADMIN_STALE_TIME_MS = 30_000;

/** /admin/_shell 底下的 route id 前綴（_shell 本身沒有 loader，不需要快取規則）。 */
export const ADMIN_SHELL_ROUTE_PREFIX = "/admin/_shell/";

export function isAdminShellRouteId(routeId: string): boolean {
  return routeId.startsWith(ADMIN_SHELL_ROUTE_PREFIX);
}

type RouteOptionsLike = { staleTime?: number; preloadStaleTime?: number };
type RouteLike = { id: string; options: RouteOptionsLike };

/**
 * 在 router 建好之後呼叫一次：替每一個後台 route 補上 30 秒的 staleTime／preloadStaleTime。
 * route 自己有寫的值優先（例如訂單內頁已經寫了 preloadStaleTime）。
 * 回傳補了幾個，selftest 用。
 */
export function applyAdminRouteCacheDefaults(routesById: object): number {
  let applied = 0;
  for (const route of Object.values(routesById) as RouteLike[]) {
    if (!isAdminShellRouteId(route.id)) continue;
    route.options.staleTime ??= ADMIN_STALE_TIME_MS;
    route.options.preloadStaleTime ??= ADMIN_STALE_TIME_MS;
    applied++;
  }
  return applied;
}

/** router 裡我們用到的那一小塊（不綁 TanStack 的泛型）。 */
export type AdminCacheRouter = {
  clearCache: (opts?: { filter?: (match: { routeId: string }) => boolean }) => void;
  subscribe: (event: "onResolved", fn: () => void) => () => void;
};

let registered: AdminCacheRouter | null = null;
let unsubscribe: (() => void) | null = null;
/** 有寫入發生、還沒等到下一次換頁完成。 */
let mutationPending = false;
/** 上一次 _shell 看到的登入者；換人就整個清快取。 */
let lastUserId: string | null = null;

let channel: { close(): void; postMessage(m: unknown): void } | null = null;

function isOnBackOffice(): boolean {
  return typeof window !== "undefined" && isBackOfficePath(window.location.pathname);
}
let reloadPage: () => void = () => window.location.reload();

/** selftest 用：換掉整頁重載。 */
export function setReloadPageForTests(fn: () => void): void {
  reloadPage = fn;
}

const adminOnly = (match: { routeId: string }) => isAdminShellRouteId(match.routeId);

const IDENTITY_CHANNEL = "ib-admin-identity";

function openChannel(onMessage: () => void) {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    const ch = new BroadcastChannel(IDENTITY_CHANNEL);
    ch.onmessage = onMessage;
    return ch;
  } catch {
    return null;
  }
}

/** src/router.tsx 在瀏覽器端建好 router 之後呼叫。 */
export function registerAdminCacheRouter(router: AdminCacheRouter): void {
  unsubscribe?.();
  channel?.close();
  registered = router;
  mutationPending = false;
  // 別的分頁登入／登出了：這個分頁記得的「誰登入」與頁面資料都不可以再用。
  channel = openChannel(() => {
    clearShellUserCache();
    clearAdminListMemory();
    registered?.clearCache();
    // 只清快取不夠：畫面上那一頁（例如前一位 admin 的訂單內頁）不在快取裡，下一次換頁時
    // 還會被搬進快取、30 秒內按「上一頁」就原樣畫出來。換人了就整頁重載，記憶體裡的
    // router 狀態全部丟掉，重新用新的 cookie 走一次 SSR。前台分頁不受影響，不重載。
    if (isOnBackOffice()) reloadPage();
  });
  unsubscribe = router.subscribe("onResolved", () => {
    if (!mutationPending) return;
    mutationPending = false;
    // 剛離開的那一頁在這時已經被搬進快取（帶著寫入前的 loader 資料）→ 丟掉。
    registered?.clearCache({ filter: adminOnly });
  });
}

/** 掛了 readOnlyFnMiddleware 的 POST fn（src/lib/admin/read-only-fn.ts）：只讀，不清快取。 */
const readOnlyServerFnIds = new Set<string>();

export function markReadOnlyServerFn(id: string): void {
  readOnlyServerFnIds.add(id);
}

export function isReadOnlyServerFn(id: string | undefined): boolean {
  return !!id && readOnlyServerFnIds.has(id);
}

/** 瀏覽器送出一次 POST server fn 之後呼叫（src/start.ts）。 */
export function noteAdminMutation(): void {
  if (!registered) return;
  mutationPending = true;
  registered.clearCache({ filter: adminOnly });
}

/**
 * 登入成功、登出時呼叫：清這個分頁的「誰登入」快取與 router 快取，並通知同一個瀏覽器的其他分頁。
 */
export function noteAdminIdentityChange(): void {
  clearShellUserCache();
  clearAdminRouteCacheOnIdentityChange(null);
  try {
    channel?.postMessage("changed");
  } catch {
    // 廣播失敗只代表其他分頁要等 60 秒的「誰登入」快取過期；授權仍在每支 server fn。
  }
}

/**
 * 登入、登出時呼叫（userId 傳 null），以及 _shell 每次拿到登入者時呼叫（傳 userId）。
 * userId 跟上一次不一樣 → 整個 router 快取清掉。回傳是否清了，selftest 用。
 */
export function clearAdminRouteCacheOnIdentityChange(userId: string | null): boolean {
  // 回傳 true 時（userId 不是 null）呼叫端要整頁重載：見 _shell.tsx 的 beforeLoad。
  const changed = userId === null || (lastUserId !== null && lastUserId !== userId);
  lastUserId = userId;
  if (changed) {
    registered?.clearCache();
    // 列表記住的篩選與資料（list-memory.ts）也是上一個人的。
    clearAdminListMemory();
  }
  return changed;
}

/** selftest 用：回到初始狀態。 */
export function resetAdminRouteCacheForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  channel?.close();
  channel = null;
  registered = null;
  mutationPending = false;
  lastUserId = null;
  readOnlyServerFnIds.clear();
  reloadPage = () => window.location.reload();
}
