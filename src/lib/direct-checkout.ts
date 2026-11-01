/**
 * 直接結帳（活動頁 →「我要報名」→ /checkout）的那一份規則，全部在這裡。
 *
 * ── 這個模式在解什麼 ───────────────────────────────────────────────────────
 * 報名一場活動原本要走四頁：活動頁 → 商品頁 → 購物車 → 結帳頁。中間兩頁對「報名」
 * 這件事沒有貢獻任何決定 —— 客人在活動頁就已經決定了「哪一場、幾個人」。這個模組
 * 讓那兩頁可以跳過去：品項改由網址參數帶進 /checkout，由結帳頁的 loader 用**既有的
 * 目錄資料**組回一個與購物車行完全等價的品項。
 *
 * ── 🔴 第二個入口為什麼這次是安全的 ─────────────────────────────────────────
 * src/routes/events.$slug.tsx 原本有一段註解明確反對「活動頁自己做結帳入口」，理由是
 * 「第二個入口就是第二份那段邏輯，兩份遲早會長歪成『活動頁讓你買 5 個位子、那一場只
 * 剩 1 個』」。那個擔心是對的，所以這個模組的形狀就是為了讓它不再成立：
 *
 *   1. **上限只有一份。** 這個檔案自己不算任何名額 —— 它一律呼叫 src/lib/cart.ts 的
 *      `cartInputFor()`，而那支的 `limit` 欄位（cart.ts:395）是 `session ?
 *      remainingForSession(session) : remainingFor(p)`。也就是說直接結帳的數量上限與
 *      購物車行的數量上限**是同一行程式碼算出來的**，不可能長歪。
 *      ⚠️ 這個檔案裡不可以出現 remainingForSession / remainingFor / capacity /
 *         seatsTaken —— 一出現就是第二份。scripts/direct-checkout-selftest.mjs 守這條。
 *
 *   2. **下單管線只有一條。** 這裡不建立訂單、不碰資料庫、不呼叫任何 server function。
 *      它產出的是一個 CartLine，交給既有的 /checkout 表單，最後仍然走
 *      placeOrder() → createOrder() 那八步（座位預留、免費訂單結清、庫存、發票、
 *      idempotency）。任何自製捷徑都會漏掉其中一項，而漏掉的症狀是靜默的。
 *
 * ── ⚠️ 參加者資料不在這裡，也不可以搬進來 ──────────────────────────────────
 * 與 src/lib/cart.ts 檔頭同一條規矩：參加者姓名／電話只活在 /checkout 的表單狀態裡。
 * 這個模組經手的是網址參數（商品代稱、場次 id、數量），**三樣都不是個資**，所以它可以
 * 出現在網址、瀏覽紀錄與分享出去的連結裡。姓名與電話不行，所以它們不在這裡。
 */
import { cartInputFor, type CartLine } from "@/lib/cart";
import type { ShopPlan, ShopProduct, ShopSession } from "@/lib/shop";
import { isSessionClosedForBooking } from "@/lib/event-status";

/**
 * 數量上限的天花板，與伺服器端 checkoutPayloadSchema 的
 * `quantity: z.number().int().min(1).max(99)`（src/lib/checkout.ts:656）同一個數字。
 *
 * 為什麼需要它：`limit` 為 null 的意思是「沒有數量管制」（不管庫存的商品），而網址是
 * 客人打得出來的 —— `?qty=999999` 在購物車那一側要按九十九萬次 +，在這裡只要改一個字。
 * 夾在伺服器自己的上限上，這種網址得到的是一張 99 的訂單明細，而不是一個 400。
 */
export const DIRECT_MAX_QTY = 99;

/**
 * /checkout 認得的四個網址參數。四個都是選填 —— 一個都沒帶就是原本的「購物車 → 結帳」。
 *
 * `product` 是 products.slug（不是 id）：slug 是後台看得懂、也是站上其他連結在用的
 * 那一個字串，而且 0004 就有唯一索引。`session` 是 event_sessions.id，因為場次沒有
 * slug。`plan` 是 event_session_plans.id（0036），只有場次真的開了方案才會有。`qty`
 * 允許任何整數進來，夾在 buildDirectLine() 裡做。
 */
export type DirectCheckoutSearch = {
  product?: string;
  session?: string;
  plan?: string;
  qty?: number;
};

/**
 * 把 TanStack 交來的 raw search 轉成上面那個形狀。
 *
 * 網址參數永遠是字串（或什麼都不是），所以這裡什麼都不相信：非字串一律變 undefined，
 * qty 解不出整數也是 undefined（而不是 NaN —— NaN 會一路流進 Math.min 變成 NaN 數量）。
 * 空字串等於沒帶，否則 `?product=` 會變成「有一個叫空字串的商品找不到」的錯誤畫面。
 */
export function parseDirectCheckoutSearch(search: Record<string, unknown>): DirectCheckoutSearch {
  const str = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const rawQty = search.qty;
  const qtyNumber =
    typeof rawQty === "number" ? rawQty : typeof rawQty === "string" ? Number(rawQty) : NaN;
  return {
    product: str(search.product),
    session: str(search.session),
    plan: str(search.plan),
    qty: Number.isFinite(qtyNumber) ? Math.trunc(qtyNumber) : undefined,
  };
}

/** 這一次進 /checkout 是不是直接結帳。只認 `product` —— 沒有品項就沒有直接結帳。 */
export function isDirectCheckout(search: DirectCheckoutSearch): boolean {
  return typeof search.product === "string" && search.product.length > 0;
}

/**
 * 直接結帳失敗的五種原因。五種都要有畫面（見 /checkout 的 directProblemText），
 * 沒有一種是白畫面或 500 —— 這些網址是客人手上會存起來、會轉貼、會過期的東西。
 *
 *   product_gone     找不到這件商品（下架了，或網址被改過）
 *   session_required 是活動但網址沒帶場次 —— 沒有場次的 booking 會被
 *                    priceLines() 直接丟 product_unavailable（orders.ts:334-336），
 *                    所以在這裡就攔下來，而不是讓客人填完整張表才失敗
 *   session_gone     帶了場次但這件商品沒有那一場（結束了、被取消了，或不是它的場次）
 *   plan_required    0036：這一場開了方案，但網址沒帶（或帶的那個 id 不屬於這一場）——
 *                    跟 session_required 同一個理由，priceLines() 會用同一句
 *                    product_unavailable 拒絕，這裡先攔下來給一句看得懂的話
 *   sold_out         這一場（或選中的那個方案）已經沒有名額
 *   session_ended    這一場已經開始或結束（isSessionClosedForBooking）。網址是客人手上
 *                    會存起來、會轉貼的東西，活動頁拿掉報名入口之後它還在 —— 這裡在
 *                    畫面上先擋，伺服器 priceLines() 與 reserve_session_seat() 再擋兩次
 */
export type DirectFailureReason =
  | "product_gone"
  | "session_required"
  | "session_gone"
  | "plan_required"
  | "sold_out"
  | "session_ended";

export type DirectResolution =
  | {
      ok: true;
      /** 與購物車行完全等價的一筆品項；keyOfLine() 對它有效。 */
      line: CartLine;
      /** 網址原本要求的數量（夾之前）。 */
      requestedQty: number;
      /** 真的被夾過才是 true —— 畫面據此顯示「數量已調整」。 */
      clamped: boolean;
    }
  | { ok: false; reason: DirectFailureReason };

/** event/journey 要選場次，goods/book 不能有場次（0020 的 order_items CHECK）。 */
function isBooking(product: ShopProduct): boolean {
  return product.productType === "event" || product.productType === "journey";
}

/**
 * 數量上限 = **選中那一場**的剩餘。
 *
 * 🔴 這支不自己算，一律問 cartInputFor() —— 見檔頭第 1 點。傳 null 時它給的是商品層級
 *    的跨場次最大值，那個數字**不可以拿來當數量上限**（兩場各 5 位會變成單行可選 10），
 *    所以呼叫端只在真的選定一場之後才拿它去夾數量。
 */
export function directSeatLimit(
  product: ShopProduct,
  session: ShopSession | null,
  plan: ShopPlan | null = null,
): number | null {
  return cartInputFor(product, 1, session, plan).limit;
}

/**
 * 這件商品**整體**還有沒有位子（跨場次最大值 > 0）。
 *
 * ⚠️ 只拿來決定「要不要畫報名區」，**不是數量上限**。名字裡沒有 limit 就是為了讓
 *    「拿它去夾數量」看起來是錯的 —— 因為那正是這一期在防的那個 bug。
 */
export function directAnySeatsLeft(product: ShopProduct, now: number): boolean {
  const limit = directSeatLimit(directOpenProduct(product, now), null);
  return limit === null || limit > 0;
}

/**
 * 只留下**還收報名**的場次（isSessionClosedForBooking，與結帳、資料庫同一條規則）的
 * 同一件商品。已開始的場次在活動頁上照列、標「已結束」，但不能算進「還有沒有位子」——
 * 否則早場已開始、晚場額滿時，頁面會因為早場還有空位而畫出一個什麼都選不了的選擇器。
 *
 * `now` **必填**：活動頁一律傳 loader 帶下來、再由 useBookingNow() 推進的那個時間，
 * SSR 與第一次 hydrate 才會是同一個答案（見 src/hooks/use-booking-now.ts）。
 */
export function directOpenProduct(product: ShopProduct, now: number): ShopProduct {
  const open = product.sessions.filter((s) => !isSessionClosedForBooking(s, now));
  return open.length === product.sessions.length ? product : { ...product, sessions: open };
}

/**
 * 整件商品都不能再報名了：**有場次、而且每一場都已開始。** 活動頁拿它決定要不要換成
 * EventEndedNotice（報名按鈕停用、文案改「活動已結束」）。
 *
 * 沒有場次 → false：那是「還沒公布」或「名額已滿」的畫面，不是「已結束」。
 */
export function directBookingClosed(product: ShopProduct, now: number): boolean {
  return (
    product.sessions.length > 0 && product.sessions.every((s) => isSessionClosedForBooking(s, now))
  );
}

/**
 * 客人選中的那一場——**只回還收報名的場次。** 選中之後場次剛好開始（頁面開著、時間
 * 走過 starts_at），回 null，報名按鈕就回到 <button disabled>，DOM 裡不再有去結帳的
 * <Link>。不必清掉 state：時間只會往前走，那一場不會再變回可選。
 */
export function directSelectedSession(
  product: ShopProduct,
  sessionId: string | null,
  now: number,
): ShopSession | null {
  if (sessionId === null) return null;
  const s = product.sessions.find((x) => x.id === sessionId) ?? null;
  return s && !isSessionClosedForBooking(s, now) ? s : null;
}

/**
 * 「這件商品剛好只有一場、而且那一場還有位子」時回傳那一場，否則回 null。
 *
 * 給活動頁拿來決定要不要**預選**場次用。兩個條件都是必要的：
 *
 *  · **剛好一場**：多場之中幫客人挑一場，會讓「我選過了」與「系統幫我選了」在畫面上
 *    長得一樣，而下一步就是收錢。只有一場時沒有第二個選項，那個歧義不成立。
 *  · **那一場沒額滿**：預選一個按不下去的場次，畫面會變成「已經選好了卻不能報名」，
 *    比沒選更難懂。額滿就回 null，讓客人看到場次上的「已額滿」。
 *
 * 🔴 放在這裡而不是寫進路由：`events.$slug.tsx` 不准出現 remainingForSession /
 *    seatsTaken / capacity（event-detail-page-selftest 有斷言在守），名額怎麼算只能有
 *    一份。而這個檔案自己也不准算（見檔頭第 1 點），所以「還有沒有位子」是問
 *    directSeatLimit() —— 跟 directAnySeatsLeft() 同一條路，只是問的是指定的那一場。
 *
 * ⚠️ `?? 0` 只是為了滿足型別（directSeatLimit 宣告回 number | null），**執行時走不到**：
 *    傳了場次進去時 cart.ts:395 走的是 remainingForSession()，那支一定回數字。所以不要
 *    照 directAnySeatsLeft() 寫成 `limit === null || limit > 0` —— 那個 fail-open 分支在
 *    這條路上沒有意義，而且方向是錯的（算不出名額時不該替客人選）。
 *
 *    真正擋住壞資料的是 `> 0` 本身：capacity 是 null 時 `null - 0` 在 JS 裡等於 0（不是
 *    NaN），remainingForSession() 回 0，於是不預選。這條有測試守著，也做過突變測試。
 */
export function directSoleSession(product: ShopProduct, now: number): ShopSession | null {
  if (product.sessions.length !== 1) return null;
  const only = product.sessions[0];
  // 已開始的那一場不預選：與額滿同一個理由（預選一個按不下去的場次比沒選更難懂）。
  if (isSessionClosedForBooking(only, now)) return null;
  return (directSeatLimit(product, only) ?? 0) > 0 ? only : null;
}

/**
 * 把「商品 + 場次 + 數量」變成一筆可以送進 /checkout 的品項。
 *
 * 數量的處理是**夾**不是拒絕，與購物車的 clampToLimit() 同一個決定：客人打 0、打負數、
 * 或打了超過剩餘的數字，得到的是一張數量正確的訂單明細加一句「數量已調整」，而不是一個
 * 錯誤畫面。真正不能成立的四種情況（見 DirectFailureReason）才回 ok: false。
 */
export function buildDirectLine(
  product: ShopProduct,
  session: ShopSession | null,
  qty: number | undefined,
  plan: ShopPlan | null = null,
): DirectResolution {
  // 非活動商品身上的場次參數一律丟掉：order_items 的 CHECK 不接受帶場次的書，
  // 而 cartInputFor() 對 null 場次的處理就是這件事的唯一定義。
  const picked = isBooking(product) ? session : null;
  if (isBooking(product) && picked === null) return { ok: false, reason: "session_required" };

  // 0036：這一場如果開了方案，plan 必須是其中之一——呼叫端（resolveDirectCheckout）
  // 已經做過這個查找，這裡再驗一次是防呆，不是第二份邏輯（判斷式本身沒有算任何
  // 名額，只是比對 id 在不在陣列裡）。
  const pickedPlan = picked && plan && picked.plans.some((p) => p.id === plan.id) ? plan : null;
  if (picked !== null && picked.plans.length > 0 && pickedPlan === null) {
    return { ok: false, reason: "plan_required" };
  }

  const input = cartInputFor(product, 1, picked, pickedPlan);
  const limit = input.limit;
  if (limit !== null && limit <= 0) return { ok: false, reason: "sold_out" };

  const requestedQty = Number.isFinite(qty) ? Math.trunc(qty as number) : 1;
  const ceiling = limit === null ? DIRECT_MAX_QTY : Math.min(limit, DIRECT_MAX_QTY);
  const finalQty = Math.max(1, Math.min(requestedQty, ceiling));

  return {
    ok: true,
    line: { ...input, qty: finalQty },
    requestedQty,
    clamped: finalQty !== requestedQty,
  };
}

/**
 * 網址參數 → 品項，用的是結帳頁 loader **已經讀進來的**那份目錄
 * （fetchActiveProducts()，它會一併掛上場次）。不多打一次資料庫，也不會因為多一次讀取
 * 而看到與畫面上不同的名額。
 *
 * 回 null 的意思是「這不是直接結帳」，呼叫端要走原本的購物車路徑。
 */
export function resolveDirectCheckout(
  products: ShopProduct[],
  search: DirectCheckoutSearch,
  now: number = Date.now(),
): DirectResolution | null {
  if (!isDirectCheckout(search)) return null;

  const product = products.find((p) => p.slug === search.product) ?? null;
  if (!product) return { ok: false, reason: "product_gone" };

  if (!isBooking(product)) return buildDirectLine(product, null, search.qty);

  if (!search.session) return { ok: false, reason: "session_required" };
  const session = product.sessions.find((s) => s.id === search.session) ?? null;
  if (!session) return { ok: false, reason: "session_gone" };
  // 在方案與名額之前判：已經開始的場次，「方案沒指定」或「滿了」都不是客人該聽到的話。
  if (isSessionClosedForBooking(session, now)) return { ok: false, reason: "session_ended" };

  // 0036：這一場有沒有方案要先問場次自己（session.plans），不是問網址參數存不存在
  // ——沒有方案的場次即使網址帶了 plan 也不需要它，buildDirectLine() 會忽略掉。
  const plan = search.plan ? (session.plans.find((p) => p.id === search.plan) ?? null) : null;

  return buildDirectLine(product, session, search.qty, plan);
}

/**
 * 「我要報名」按鈕要帶的網址參數。組法只有這一份，連結與解析才不會分岔。
 *
 * `plan` 選填——沒有方案的場次傳 null，網址就不帶那個 key（與 0020 之後的連結
 * 逐字相同）。有方案時必須傳，否則 resolveDirectCheckout() 會在對面用
 * `plan_required` 拒絕這個連結。
 */
export function directCheckoutSearch(
  product: ShopProduct,
  session: ShopSession,
  qty: number,
  plan: ShopPlan | null = null,
): DirectCheckoutSearch {
  return {
    product: product.slug,
    session: session.id,
    qty,
    ...(plan ? { plan: plan.id } : {}),
  };
}

// -----------------------------------------------------------------------------
// 🔴 直接結帳的訂單不可以清購物車
// -----------------------------------------------------------------------------

/**
 * /checkout/complete 在付款結清之後會呼叫 cart 的 `clear()`，而 `clear()` 是**清空整個
 * 購物車**、不分辨訂單是哪裡來的。
 *
 * 直接結帳的訂單從來沒有經過購物車，所以那一下清掉的會是**別的東西**：一個購物車裡放
 * 著三本書的客人，從活動頁跑完直接報名並付款成功，回來會發現那三本書不見了 —— 而且沒有
 * 任何畫面告訴他發生過這件事。
 *
 * ── 為什麼是 sessionStorage 而不是別的做法 ─────────────────────────────────
 * 這個決定要在**付款回來的那一頁**做，而那一頁的網址是伺服器在建單當下就組好的
 * （payuniReturnUrl()，src/server/payuni.ts:235），只帶 token，不帶我們的旗標；黑貓那條
 * 也一樣（blackcat-webhook.ts:407）。所以旗標沒辦法靠網址傳過去。
 *
 *   · 不改資料庫：這一期不新增 migration，而且「這張單是不是從活動頁下的」是瀏覽器端的
 *     一件事，不值得為它加一個欄位。
 *   · 不用 localStorage：那會把一串訂單 token 無到期地留在硬碟上。sessionStorage 是
 *     **這一個分頁**的，分頁關掉就沒了，而金流的兩條路（form POST 與 location.assign，
 *     見 src/lib/payment-redirect.ts）都在同一個分頁裡來回，所以它活得夠久。
 *   · 存的是 public_token，不是個資：那串東西本來就在同一個分頁的網址列與瀏覽紀錄裡。
 *
 * 讀寫全部包 try/catch：Safari 無痕、關掉站台資料、SSR 都會讓這裡丟例外，而**丟例外的
 * 代價是退回舊行為（清掉購物車）**，所以它必須是「盡力而為」，不能是「壞掉就整頁炸掉」。
 */
const KEEP_CART_KEY = "interval-books-keep-cart";

/** 只留最近幾筆：這是一個分頁裡的清單，長度沒有理由成長。 */
const KEEP_CART_MAX = 20;

function readKeptTokens(): string[] {
  try {
    if (typeof sessionStorage === "undefined") return [];
    const raw = sessionStorage.getItem(KEEP_CART_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/** 記下「這張單不要動購物車」。在 placeOrder() 成功之後、離開結帳頁之前呼叫。 */
export function rememberCartKept(publicToken: string): void {
  if (!publicToken) return;
  try {
    if (typeof sessionStorage === "undefined") return;
    const next = [publicToken, ...readKeptTokens().filter((t) => t !== publicToken)].slice(
      0,
      KEEP_CART_MAX,
    );
    sessionStorage.setItem(KEEP_CART_KEY, JSON.stringify(next));
  } catch {
    /* 存不下來就退回舊行為，見上面的長註解 */
  }
}

/** 這張單是不是直接結帳來的（→ 不要碰購物車）。 */
export function cartKeptForOrder(publicToken: string): boolean {
  if (!publicToken) return false;
  return readKeptTokens().includes(publicToken);
}

/**
 * /checkout/complete 那一下到底要不要清購物車。
 *
 * 抽成純函式是為了讓它**跑得起來**：這條規則的兩個錯法（清了不該清的、或該清的沒清）
 * 都是靜默的，靠讀 useEffect 的原始碼證明不了。scripts/direct-checkout-selftest.mjs
 * 真的呼叫它，也真的對 src/lib/cart.ts 的 store 放兩本書進去再驗一次。
 *
 * 兩個 false 的理由完全不同，不可以合併：
 *   · awaitingPayment —— 金流還欠我們一個答案（客人還在刷卡頁，或刷卡失敗要重試）。
 *     這一條是 Realreal 把人丟在空購物車前的那個 bug 的修補，見 checkout.complete.tsx。
 *   · cartKeptForOrder —— 這張單根本沒有經過購物車。
 */
export function shouldClearCartAfterOrder(
  order: { awaitingPayment: boolean } | null,
  publicToken: string,
): boolean {
  if (!order) return false;
  if (order.awaitingPayment) return false;
  return !cartKeptForOrder(publicToken);
}
