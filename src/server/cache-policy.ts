/**
 * HTML 回應的 Cache-Control 決策——2026-09 前台載入速度優化。
 *
 * ⚠️ 白名單制，不是黑名單。這支函式只對**明確列在 CACHEABLE_EXACT_PATHS /
 *    CACHEABLE_PREFIXES 裡的路徑**加上 s-maxage；任何不認得的路徑一律不動（交回
 *    Nitro/TanStack Start 原本的預設標頭，也就是 `public, max-age=0,
 *    must-revalidate`——不會被共用快取存住，安全）。新加一個可快取路徑，永遠是
 *    「往白名單裡加一條」，不是「把某條擋掉」——這樣漏寫一條的後果是「這頁沒有
 *    變快」，不是「這頁的個資被發給別人」。
 *
 * SENSITIVE_PREFIXES 是白名單之外**再加一層**的明確保險：即使白名單未來被改壞
 * （例如有人手滑把 /checkout 加進白名單），這裡仍然強制回 "no-store"——見
 * cacheControlFor() 的判斷順序，敏感前綴永遠先判、永遠贏。
 *
 * 這支模組刻意**零 import**：
 *   1. scripts/cache-policy-selftest.mjs 用相對路徑直接 import 這個檔案來跑真的
 *      行為測試（不是掃原始碼文字）——這個 repo 的 selftest 沒有 tsconfig paths
 *      別名解析能力，只要這裡多 import 一個 "@/..." 的東西，那支測試就會在
 *      import 那一行直接炸掉。
 *   2. src/server.ts 是全站唯一的自訂 fetch 入口（見該檔檔頭），每一個請求都會
 *      經過它——這裡的邏輯必須是純函式，不能有副作用、不能碰 Supabase，才能在
 *      熱路徑上便宜地跑。
 *
 * /checkout/complete 帶著 public_token、/account 是登入後的個人訂單——這兩個字
 * 都不能出現在共用（s-maxage）快取裡，否則就是把 A 的訂單發給 B。
 */

/**
 * 逐字精確比對的路徑（不含結尾斜線、不含 query string）。
 *
 * /news（2026-10-26 加入）：最新消息只有一頁列表、沒有 /news/$slug，內容是後台發布的公開文字
 * （fetchNews 用 anon 公開讀取），不帶任何登入態或個資——與 /about、/privacy 同一類。後台改完
 * 最多一分鐘反映（s-maxage=60），與其他白名單頁相同；這個專案沒有主動清 CDN 的機制，失效就是
 * 那 60 秒。沒列進來之前每一次都要整頁 SSR（正式站量到 1 秒上下）。
 */
const CACHEABLE_EXACT_PATHS = ["/", "/events", "/shop", "/about", "/privacy", "/news"];

/**
 * `/events/$slug` 與 `/shop/$slug`——只有這兩個路由真的有單一動態區段
 * （src/routes/events.$slug.tsx、src/routes/shop.$slug.tsx），所以比對到「剛好
 * 多一段、且那一段不能再帶斜線」，不是任意深度的前綴。
 */
const CACHEABLE_SINGLE_SEGMENT_PREFIXES = ["/events/", "/shop/"];

/**
 * `/journeys*`、`/publications*`——這兩個允許任意深度／子路徑，字面照抄需求裡
 * 帶星號的那兩條。
 */
const CACHEABLE_OPEN_PREFIXES = ["/journeys", "/publications"];

/**
 * 一定要 no-store 的路徑前綴。/checkout、/account、/admin、/vendor 是帶個資或
 * 登入態的頁面；/api 是需求文字裡點名的類別；/_serverFn 是這個 TanStack Start
 * 版本 createServerFn 的實際 RPC 掛載點（node_modules/@tanstack/start-plugin-core
 * 的 schema.js 預設值是 "/_serverFn"，不是 "/api"）——兩個都擋，字面需求與這個
 * 框架的實際路徑都不漏。
 */
const SENSITIVE_PREFIXES = ["/checkout", "/account", "/admin", "/vendor", "/api", "/_serverFn"];

/** s-maxage=60（後台改完最多一分鐘才反映）+ swr=600（過期後 10 分鐘內仍可先吐舊的，背景重新整理）。 */
const CACHEABLE_HEADER = "public, max-age=0, s-maxage=60, stale-while-revalidate=600";

const NO_STORE_HEADER = "no-store";

/** 去掉結尾斜線（根路徑 "/" 除外），讓 "/shop/" 與 "/shop" 判成同一條路徑。 */
function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

function matchesSensitivePrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** 是否命中敏感前綴（無論方法、無論這個路徑在不在白名單裡）。 */
export function isSensitivePath(pathname: string): boolean {
  const p = normalize(pathname);
  return SENSITIVE_PREFIXES.some((prefix) => matchesSensitivePrefix(p, prefix));
}

/**
 * 是否命中可快取白名單。這支函式只看路徑本身，不看方法／狀態碼——那兩層由
 * cacheControlFor() 另外把關，這裡維持單一職責，方便 selftest 直接測「白名單
 * 裡到底有什麼」。
 */
export function isWhitelistedPath(pathname: string): boolean {
  const p = normalize(pathname);
  if (CACHEABLE_EXACT_PATHS.includes(p)) return true;

  // /events/$slug、/shop/$slug——剛好多一段、那一段不得再帶斜線。
  for (const prefix of CACHEABLE_SINGLE_SEGMENT_PREFIXES) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest.length > 0 && !rest.includes("/")) return true;
  }

  // /journeys*、/publications*——任意深度都算。
  if (CACHEABLE_OPEN_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`)))
    return true;

  return false;
}

/**
 * 這次請求的 Cache-Control 應該是什麼。
 *
 * 回傳 null 代表「不要動這個回應的標頭」——交給 Nitro/TanStack Start 自己的預設值
 * （目前量到的是 `public, max-age=0, must-revalidate`，本來就不會被共用快取存住）。
 *
 * 判斷順序（由上而下，第一個命中就回傳，後面不再看）：
 *   1. 敏感前綴 -> 永遠 no-store，不管方法、不管狀態碼、不管白名單怎麼寫。
 *   2. GET/HEAD + 200 + 白名單命中 -> 60 秒共用快取。
 *   3. 其他 -> null（不覆寫，維持安全預設）。
 *
 * status 只在第 2 步生效：非 200（404／500／redirect…）一律不做共用快取，避免
 * 把一次暫時性的資料庫錯誤在邊緣快取裡放大成一分鐘的全站故障。
 */
export function cacheControlFor(pathname: string, method: string, status: number): string | null {
  if (isSensitivePath(pathname)) return NO_STORE_HEADER;
  const isSafeMethod = method === "GET" || method === "HEAD";
  if (isSafeMethod && status === 200 && isWhitelistedPath(pathname)) return CACHEABLE_HEADER;
  return null;
}

export const __TEST_ONLY__ = {
  CACHEABLE_EXACT_PATHS,
  CACHEABLE_SINGLE_SEGMENT_PREFIXES,
  CACHEABLE_OPEN_PREFIXES,
  SENSITIVE_PREFIXES,
  CACHEABLE_HEADER,
  NO_STORE_HEADER,
};
