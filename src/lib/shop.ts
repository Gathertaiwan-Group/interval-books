/**
 * Public storefront read layer for public.products.
 *
 * WHY THIS USES THE ANON CLIENT RATHER THAN src/server/repos/products.ts
 * ---------------------------------------------------------------------
 * There were two existing patterns to choose from and they are not
 * interchangeable:
 *
 *   - src/server/repos/*.ts run on supabaseAdmin() (service_role). service_role
 *     **bypasses RLS entirely**. Reaching for it here would mean the only thing
 *     standing between the storefront and every draft/archived product is a
 *     `.eq("status", "active")` that a future refactor can drop without any
 *     test noticing. Those repos are also `import "@tanstack/react-start/server-only"`
 *     and belong to the back office.
 *
 *   - src/lib/cms.ts runs on the anon client from src/lib/supabase.ts. The anon
 *     key can only ever see what RLS lets it see, and
 *     supabase/migrations/0004_commerce_products.sql already encodes exactly the
 *     rule this file needs:
 *         create policy products_select_public ... using (status = 'active')
 *     so non-active rows are unreachable at the database level, not merely
 *     unselected here. The same migration revokes every write, and
 *     0005_commerce_orders.sql gives anon *no* grants at all on
 *     orders/payments/etc — so this client is structurally incapable of leaking
 *     order data even if someone later asks it to.
 *
 * This file therefore follows the cms.ts pattern. The `.eq("status", "active")`
 * below is defence in depth on top of the policy, not the primary control.
 *
 * Note also that no createServerFn is involved: like every other public read in
 * this app, these run from TanStack Router loaders, which execute on the server
 * during SSR (so crawlers get real HTML) and in the browser on client-side
 * navigation (so no extra round-trip). That is the established convention here
 * — see src/routes/curated.tsx.
 *
 * ONE DELIBERATE DEPARTURE FROM cms.ts
 * ------------------------------------
 * cms.ts swallows every error and substitutes bundled copy, because site copy
 * has a sensible in-repo fallback. Products do not: there is no bundled
 * catalogue, so "the query failed" and "nothing is for sale" would collapse
 * into the same empty list and the shop would quietly look closed during a DB
 * hiccup. These functions therefore still never throw, but they report the
 * distinction via `unavailable` so the UI can say "temporarily unavailable"
 * instead of "no products".
 */
import { supabase } from "@/lib/supabase";
import type { Localized } from "@/i18n/types";

/** Mirrors the product_type CHECK in 0004_commerce_products.sql. */
export type ShopProductType = "goods" | "book" | "event" | "journey";

export const SHOP_PRODUCT_TYPES: ShopProductType[] = ["goods", "book", "event", "journey"];

/**
 * A single sellable item, camelCased for the components (the admin repo keeps
 * snake_case on purpose; the public site has always used camelCase — see the
 * cms.ts header).
 *
 * `status` is intentionally absent: every row that reaches this type is active
 * by construction, so there is no value a component could usefully branch on
 * and no way for a non-active row to be mistaken for a sellable one.
 */
export type ShopSession = {
  id: string;
  productId: string;
  title: Localized;
  location: Localized;
  /** ISO 8601 from timestamptz. */
  startsAt: string;
  endsAt: string | null;
  capacity: number;
  seatsTaken: number;
  sortOrder: number;
  /**
   * 這個場次底下的價格方案（票種，0036）。空陣列＝這個場次沒有開任何方案——那時
   * 價格與座位數照 0020 之前的行為，取 products.price、quantity 就是座位數。
   * 只包含 status='open' 的方案（0036 的 event_session_plans_select_public
   * policy 本來就只讓 anon 讀得到這些）。
   */
  plans: ShopPlan[];
};

/**
 * 一個場次底下的一個價格方案（票種，0036）。
 *
 * 名額以「單位」計，不是座位——一個單位可能佔用場次的多個座位
 * （見 seatsPerUnit）。沒有方案的場次不會有這個型別的任何實例。
 */
export type ShopPlan = {
  id: string;
  sessionId: string;
  title: Localized;
  /** TWD，每「單位」的價格。 */
  price: number;
  /** 一個購買單位佔用場次的幾個座位。1＝一單位一位；雙人房這類是 2。 */
  seatsPerUnit: number;
  /** 這個方案自己的單位上限。 */
  capacity: number;
  /** 已經賣出幾個單位——不是座位數。 */
  unitsTaken: number;
  /** ISO 8601，或 null＝現在就能買（早鳥的起點）。 */
  saleStartsAt: string | null;
  /** ISO 8601，或 null＝不設販售期限（早鳥的迄點）。 */
  saleEndsAt: string | null;
  sortOrder: number;
};

export type ShopProduct = {
  id: string;
  slug: string;
  productType: ShopProductType;
  title: Localized;
  summary: Localized;
  description: Localized;
  /** TWD, whole dollars — never cents (see the 0004 migration comment). */
  price: number;
  /** Struck-through "was" price when present. */
  compareAtPrice: number | null;
  /** goods/book only. NULL = not stock-managed, i.e. always purchasable. */
  stock: number | null;
  /**
   * ⚠️ 0020 之後這兩欄**一律是 null / 0** —— 名額搬到 public.event_sessions，
   * `products_capacity_moved_to_sessions` 這條 CHECK 強制的。欄位還讀著是因為
   * 那個 CHECK 是 migration 帶來的，而程式碼先上線：套用之前它們還有舊值，
   * 套用之後變成 null。兩種情況下 remainingFor() 都不看它們（見下面），所以
   * 這裡留著純粹是為了讓 COLUMNS 字串在 migration 套用前後都查得到欄位。
   */
  capacity: number | null;
  seatsTaken: number;
  /**
   * 這件商品的**可報名梯次**，只有 event/journey 會有。空陣列的意思是「現在
   * 沒有任何一場開放報名」，不是「不限名額」——  remainingFor() 據此回 0。
   */
  sessions: ShopSession[];
  imageKey: string | null;
  requiresShipping: boolean;
  sortOrder: number;
  /**
   * How many of this product can actually be bought right now, read from
   * public.product_availability (migration 0011) and **capped at 10**.
   *
   * This is the only number the storefront gets for a product whose stock lives
   * in the shop's inventory system: those rows have products.stock = NULL by
   * construction, so `stock` above cannot answer the question. The cap is
   * deliberate — exact stock is commercial information, and "10" here means
   * "10 or more", which is all a shopper needs.
   *
   * null when the availability read failed or was not attempted; callers must
   * fall back to `stock` rather than treating null as "sold out".
   */
  availableCapped: number | null;
  /**
   * 前台要不要印出「尚餘名額 N」（supabase/migrations/0029_event_seats_visibility.sql）。
   *
   * ⚠️ **這一欄不是名額本身，也不影響任何上限。** remainingForSession() 照算，
   *    購物車上限照夾，reserve_session_seat() 照擋 —— 關掉的只有那一句字。
   *
   * 🔴 **「已額滿」不受它影響。** 那是「你報不了名」，跟「還剩幾位」不是同一件事：
   *    關掉名額顯示的活動額滿時，客人仍然必須看得出來，否則他會一直按一顆按不動
   *    的按鈕。三個渲染點（SessionPicker / SessionList / shop.$slug 的 StockBadge）
   *    都是先判額滿、再判這一欄。
   *
   * 編輯的位置在**活動後台**（events.show_seats_remaining）。這裡讀到的是它投影到
   * products 的那一份：前台的讀取層從來沒有讀過 public.events（那張表的 RLS 是
   * `using (is_published)`，而且 journey 型商品根本沒有 events 列），所以旗標要能
   * 到得了前台就必須住在 products 上。兩邊由 0029 的兩個 trigger 保證不分岔。
   *
   * default true：0029 之前的行為就是一律顯示，既有的活動套用之後一個字都不會變。
   */
  showSeatsRemaining: boolean;
};

/**
 * 卡片形狀的商品——`ShopProduct` 拿掉 `description`。
 *
 * 為什麼要有這個型別：/shop 三個分頁（商品／地方刊物／主理人的選品）沒有一處會
 * 印出商品的 description——那是 /shop/$slug 詳情頁專屬的長文（見該路由
 * `{t(product.description)}` 那一段）。但 2026-09 之前 /shop 的 loader 仍然用
 * `fetchActiveProducts()` 撈整份 ShopProduct，於是 43 件商品 × 三語
 * description（一次還撈兩份，見 fetchActiveProductsForList 檔頭）全部被塞進
 * SSR payload，一個字都沒有畫出來。
 *
 * `Omit<ShopProduct, "description">` 而不是獨立重寫一個型別：欄位清單永遠跟著
 * ShopProduct 走，日後 ShopProduct 加欄位不會漏掉這裡。
 */
export type ShopProductCard = Omit<ShopProduct, "description">;

export type ShopListResult = {
  products: ShopProduct[];
  /**
   * True only when the read itself failed (network down, Supabase not
   * configured, permission error). An empty `products` with `unavailable:false`
   * genuinely means "nothing is on sale".
   */
  unavailable: boolean;
};

export type ShopProductResult = {
  product: ShopProduct | null;
  unavailable: boolean;
};

/** Card-shaped counterpart of ShopListResult — see ShopProductCard. */
export type ShopListCardResult = {
  products: ShopProductCard[];
  unavailable: boolean;
};

/**
 * Every column the storefront needs — and nothing else. Deliberately does not
 * include `status` (see ShopProduct) or `source_type`/`source_id`, which are a
 * CMS bookkeeping detail the shop has no use for.
 */
const COLUMNS =
  "id, slug, product_type, title, summary, description, price, compare_at_price, stock, capacity, seats_taken, image_key, requires_shipping, sort_order, show_seats_remaining";

/** Same as COLUMNS, minus `description` — see ShopProductCard. */
const CARD_COLUMNS =
  "id, slug, product_type, title, summary, price, compare_at_price, stock, capacity, seats_taken, image_key, requires_shipping, sort_order, show_seats_remaining";

// -----------------------------------------------------------------------------
// Row mapping
// -----------------------------------------------------------------------------

type Row = Record<string, unknown>;

function isLocalized(v: unknown): v is Localized {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.zh === "string" && typeof o.en === "string" && typeof o.ja === "string";
}

function loc(v: unknown): Localized | null {
  return isLocalized(v) ? { zh: v.zh, en: v.en, ja: v.ja } : null;
}

function int(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function nullableInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function nullableStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function isProductType(v: unknown): v is ShopProductType {
  return typeof v === "string" && (SHOP_PRODUCT_TYPES as string[]).includes(v);
}

/**
 * Returns null for any row that cannot be trusted — a missing slug or a jsonb
 * column that is not {zh,en,ja} would otherwise render as `undefined` in the
 * page. Same defensive posture as cms.ts, which skips malformed rows rather
 * than crashing the route.
 */
function toProduct(r: Row): ShopProduct | null {
  const id = typeof r.id === "string" ? r.id : null;
  const slug = typeof r.slug === "string" ? r.slug : null;
  const title = loc(r.title);
  const summary = loc(r.summary);
  const description = loc(r.description);
  if (!id || !slug || !title || !summary || !description) return null;
  if (!isProductType(r.product_type)) return null;

  return {
    id,
    slug,
    productType: r.product_type,
    title,
    summary,
    description,
    price: int(r.price, 0),
    compareAtPrice: nullableInt(r.compare_at_price),
    stock: nullableInt(r.stock),
    capacity: nullableInt(r.capacity),
    seatsTaken: int(r.seats_taken, 0),
    sessions: [],
    imageKey: nullableStr(r.image_key),
    requiresShipping: r.requires_shipping !== false,
    sortOrder: int(r.sort_order, 0),
    availableCapped: null,
    // 只有明著是 false 才關掉。0029 那一欄是 NOT NULL DEFAULT true，所以任何
    // 「讀不到／型別不對」都該回到「顯示」——那是這一支之前的行為，而讓一個讀
    // 失敗靜默地把名額藏起來，會讓「後台關過」與「查詢壞了」在畫面上長得一樣。
    showSeatsRemaining: r.show_seats_remaining !== false,
  };
}

/**
 * Card-shaped counterpart of toProduct() — same validation, minus
 * `description`. Deliberately NOT implemented by calling toProduct() and
 * dropping a field: toProduct() is on the checkout/cart read path
 * (fetchActiveProducts/fetchActiveProductsByIds/fetchActiveProductBySlug,
 * consumed by /cart, /checkout and /shop/$slug) and this file's own header
 * says price/seat correctness has exactly one source of truth — this function
 * stays a self-contained sibling so nothing on that path is touched by the
 * /shop list-page slimming.
 */
function toProductCard(r: Row): ShopProductCard | null {
  const id = typeof r.id === "string" ? r.id : null;
  const slug = typeof r.slug === "string" ? r.slug : null;
  const title = loc(r.title);
  const summary = loc(r.summary);
  if (!id || !slug || !title || !summary) return null;
  if (!isProductType(r.product_type)) return null;

  return {
    id,
    slug,
    productType: r.product_type,
    title,
    summary,
    price: int(r.price, 0),
    compareAtPrice: nullableInt(r.compare_at_price),
    stock: nullableInt(r.stock),
    capacity: nullableInt(r.capacity),
    seatsTaken: int(r.seats_taken, 0),
    sessions: [],
    imageKey: nullableStr(r.image_key),
    requiresShipping: r.requires_shipping !== false,
    sortOrder: int(r.sort_order, 0),
    availableCapped: null,
    showSeatsRemaining: r.show_seats_remaining !== false,
  };
}

function logFailure(what: string, message: string) {
  console.warn(`[shop] ${what} unavailable — ${message}`);
}

/**
 * Reads public.product_availability for the given ids and writes the answer
 * onto the products in place.
 *
 * Best effort on purpose. A failure here leaves `availableCapped` at null and
 * remainingFor() falls back to products.stock — which for an inventory-backed
 * product means "not stock-managed", i.e. the shop stays open rather than
 * showing everything as sold out because one extra read blinked. The real
 * guard is reserve_inventory_stock() at checkout; this is display only.
 *
 * The view is readable by anon and exposes exactly three columns. It has no
 * path to inv.products — anon does not even hold USAGE on that schema.
 *
 * 參數型別是 ShopProductCard 不是 ShopProduct（2026-09）：這支函式只讀寫
 * id/productType/availableCapped/sessions，不碰 description，所以縮成兩者共同
 * 的形狀讓 /shop 列表頁的卡片型別也能直接呼叫它——不必為了拿到「可售量」另外
 * 兜一份邏輯。ShopProduct 仍然可以照舊傳進來（它是 ShopProductCard 多一個欄位），
 * 既有呼叫端一行都不用改。
 */
async function attachAvailability(products: ShopProductCard[]): Promise<void> {
  const db = supabase;
  if (!db || products.length === 0) return;
  try {
    const { data, error } = await db
      .from("product_availability")
      .select("product_id, available_capped")
      .in(
        "product_id",
        products.map((p) => p.id),
      );
    if (error || !Array.isArray(data)) {
      logFailure("availability", error?.message ?? "unexpected response shape");
      return;
    }
    const byId = new Map<string, number>();
    for (const row of data as unknown as Row[]) {
      const id = typeof row.product_id === "string" ? row.product_id : null;
      const cap = nullableInt(row.available_capped);
      if (id !== null && cap !== null) byId.set(id, cap);
    }
    for (const p of products) {
      const cap = byId.get(p.id);
      if (cap !== undefined) p.availableCapped = cap;
    }
  } catch (err) {
    logFailure("availability", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Every column the storefront needs from public.event_sessions.
 *
 * `capacity` / `seats_taken` are in here for the same reason products used to
 * carry them: the shopper has to be told how many places are left. Migration
 * 0020 moved those two numbers from public.products to this table without
 * changing who may read them — event_sessions has anon SELECT plus a policy
 * (`status='open'` and the product is active), exactly like products.
 */
const SESSION_COLUMNS =
  "id, product_id, title, location, starts_at, ends_at, capacity, seats_taken, sort_order";

function toSession(r: Row): ShopSession | null {
  const id = typeof r.id === "string" ? r.id : null;
  const productId = typeof r.product_id === "string" ? r.product_id : null;
  const title = loc(r.title);
  const location = loc(r.location);
  const startsAt = typeof r.starts_at === "string" ? r.starts_at : null;
  const capacity = nullableInt(r.capacity);
  if (!id || !productId || !title || !location || !startsAt || capacity === null) return null;
  return {
    id,
    productId,
    title,
    location,
    startsAt,
    endsAt: nullableStr(r.ends_at),
    capacity,
    seatsTaken: int(r.seats_taken, 0),
    sortOrder: int(r.sort_order, 0),
    // 由 attachPlans() 事後填入——這裡先給空陣列，理由與 ShopProduct.sessions
    // 一開始是 [] 相同：讀取分成好幾支查詢，型別在中間狀態也要站得住。
    plans: [],
  };
}

/**
 * Reads the open sessions for whichever of these products are bookings, and
 * writes them onto the products in place.
 *
 * ⚠️ Unlike attachAvailability() this one is NOT best effort in its effect: a
 * failed read leaves `sessions` empty, and an empty session list means
 * remainingFor() reports 0 — sold out. That is deliberate and it is the
 * opposite direction from the availability read, because the two answer
 * different questions. "How many books are left" has a safe fallback
 * (products.stock); "which sitting is this shopper booking" does not, and a
 * booking without a session id is an order the checkout must refuse. Failing
 * closed here costs a sale; failing open would create bookings nobody can seat.
 *
 * Only queried for event/journey products, so an all-books catalogue makes no
 * extra round trip at all.
 *
 * ShopProductCard parameter type — same reasoning as attachAvailability()
 * above: only id/productType/sessions are touched, description is never
 * read, existing ShopProduct[] callers stay valid unchanged.
 */
async function attachSessions(products: ShopProductCard[]): Promise<void> {
  const db = supabase;
  const bookings = products.filter((p) => p.productType === "event" || p.productType === "journey");
  if (!db || bookings.length === 0) return;
  try {
    const { data, error } = await db
      .from("event_sessions")
      .select(SESSION_COLUMNS)
      .in(
        "product_id",
        bookings.map((p) => p.id),
      )
      .order("sort_order", { ascending: true })
      .order("starts_at", { ascending: true })
      .order("id", { ascending: true });

    if (error || !Array.isArray(data)) {
      logFailure("sessions", error?.message ?? "unexpected response shape");
      return;
    }
    const byProduct = new Map<string, ShopSession[]>();
    for (const row of data as unknown as Row[]) {
      const session = toSession(row);
      if (!session) continue;
      const list = byProduct.get(session.productId);
      if (list) list.push(session);
      else byProduct.set(session.productId, [session]);
    }
    for (const p of bookings) p.sessions = byProduct.get(p.id) ?? [];
  } catch (err) {
    logFailure("sessions", err instanceof Error ? err.message : String(err));
  }
}

/**
 * 每個場次底下的價格方案（票種，0036）——只有 event/journey 商品的場次會有。
 *
 * ⚠️ 必須在 attachSessions() **之後**呼叫，不是平行呼叫：方案要按 session_id
 * 查，而 session_id 是 attachSessions() 填進去的。呼叫端（下面四個 fetch*
 * 函式）都遵守這個順序。
 *
 * 失敗時的方向跟 attachSessions() 一致（fail-closed，不是 best effort）：讀不到
 * 就讓每個場次的 plans 維持空陣列——那正是「這個場次沒有方案」的畫面，客人看到
 * 的是照 0020 行為的直接報名，不是一個看起來壞掉的空白方案清單。漏掉方案不會讓
 * 客人多付錢或少付錢（沒有方案時價格照舊取 products.price），只是讓房型定價
 * 暫時不見了——比讓結帳頁的邏輯対不上（有方案卻挑不到）安全。
 */
const PLAN_COLUMNS =
  "id, session_id, title, price, seats_per_unit, capacity, units_taken, sale_starts_at, sale_ends_at, sort_order";

function toPlan(r: Row): ShopPlan | null {
  const id = typeof r.id === "string" ? r.id : null;
  const sessionId = typeof r.session_id === "string" ? r.session_id : null;
  const title = loc(r.title);
  const price = nullableInt(r.price);
  const seatsPerUnit = nullableInt(r.seats_per_unit);
  const capacity = nullableInt(r.capacity);
  if (!id || !sessionId || !title || price === null || seatsPerUnit === null || capacity === null) {
    return null;
  }
  return {
    id,
    sessionId,
    title,
    price,
    seatsPerUnit,
    capacity,
    unitsTaken: int(r.units_taken, 0),
    saleStartsAt: nullableStr(r.sale_starts_at),
    saleEndsAt: nullableStr(r.sale_ends_at),
    sortOrder: int(r.sort_order, 0),
  };
}

async function attachPlans(products: ShopProductCard[]): Promise<void> {
  const db = supabase;
  const sessionIds = products
    .filter((p) => p.productType === "event" || p.productType === "journey")
    .flatMap((p) => p.sessions.map((s) => s.id));
  if (!db || sessionIds.length === 0) return;
  try {
    const { data, error } = await db
      .from("event_session_plans")
      .select(PLAN_COLUMNS)
      .in("session_id", sessionIds)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (error || !Array.isArray(data)) {
      logFailure("plans", error?.message ?? "unexpected response shape");
      return;
    }
    const bySession = new Map<string, ShopPlan[]>();
    for (const row of data as unknown as Row[]) {
      const plan = toPlan(row);
      if (!plan) continue;
      const list = bySession.get(plan.sessionId);
      if (list) list.push(plan);
      else bySession.set(plan.sessionId, [plan]);
    }
    for (const p of products) {
      for (const s of p.sessions) s.plans = bySession.get(s.id) ?? [];
    }
  } catch (err) {
    logFailure("plans", err instanceof Error ? err.message : String(err));
  }
}

// -----------------------------------------------------------------------------
// Availability
// -----------------------------------------------------------------------------

/**
 * How many places are left in one sitting. Never null — a session always has a
 * capacity (`event_sessions.capacity` is NOT NULL), so "unlimited" is not a
 * state a booking can be in.
 *
 * This is the number every booking-related limit in the app comes from: the
 * cart line's `limit`, the quantity stepper's max, and the pre-check in
 * src/server/repos/orders.ts. The authoritative one is still
 * reserve_session_seat()'s step ⑤, which holds a row lock; this one is a
 * display value read a moment earlier and may already be stale.
 */
export function remainingForSession(s: ShopSession): number {
  return Math.max(0, s.capacity - s.seatsTaken);
}

/**
 * How many units are left in one plan（0036）. 單位，不是座位——見 ShopPlan 的
 * 檔頭。跟 remainingForSession() 同一個立場：這是顯示值，真正握著列鎖的是
 * reserve_plan_units()，這裡讀到的可能已經過時。
 */
export function remainingForPlan(plan: ShopPlan): number {
  return Math.max(0, plan.capacity - plan.unitsTaken);
}

/**
 * 這個方案現在買不買得到——名額之外的第二個限制：販售期間。
 *
 * `now` 可以外部傳入是為了讓這支純函式測得起來（不用等真的時間到）；呼叫端不傳
 * 就是「現在」。兩端都可以是 null（不限起點／不限迄點），對應 0036 的
 * sale_starts_at／sale_ends_at 兩欄皆可為 null。
 */
export function planInSaleWindow(plan: ShopPlan, now: number = Date.now()): boolean {
  if (plan.saleStartsAt) {
    const opensAt = Date.parse(plan.saleStartsAt);
    if (!Number.isNaN(opensAt) && now < opensAt) return false;
  }
  if (plan.saleEndsAt) {
    const closesAt = Date.parse(plan.saleEndsAt);
    if (!Number.isNaN(closesAt) && now > closesAt) return false;
  }
  return true;
}

/**
 * 這個方案現在真的買得到嗎——把名額與販售期間兩個限制合成一句。
 */
export function isPlanAvailable(plan: ShopPlan, now: number = Date.now()): boolean {
  return remainingForPlan(plan) > 0 && planInSaleWindow(plan, now);
}

/**
 * How many units may still be added, or null when the product is not
 * quantity-limited at all.
 *
 * ⚠️ event/journey no longer read `p.capacity` / `p.seatsTaken`. Migration 0020
 * moved the seat count to public.event_sessions and pinned those two columns to
 * null / 0 with a CHECK, so reading them would report every activity as
 * "no limit known" — the fail-OPEN direction. The answer here is instead "does
 * any open sitting still have room", i.e. the largest remaining count across
 * this product's sessions. A booking with no open sessions returns 0 (sold out
 * / not open yet), never null.
 *
 * Note this is the *product-level* number, used for the sold-out badge on the
 * list page. What actually caps a cart line is remainingForSession() for the
 * one sitting the shopper picked — a product with two sessions of 5 places is
 * not a product you can buy 10 seats of in one line.
 *
 * goods/book have two sources and the order between them is load-bearing:
 *
 *   `stock` wins when it is set. Those products are managed entirely by
 *   public.products and atomic_deduct_stock(), exactly as before 0011 — reading
 *   the capped view for them would silently turn a stock of 40 into "10 left".
 *
 *   `availableCapped` is used only when `stock` is NULL. That covers products
 *   sold out of the shop's real inventory (0011 forces their catalog stock to
 *   NULL so the two numbers can never disagree) and products that are not
 *   stock-managed at all, for which the view reports the cap — i.e. "plenty",
 *   which is the same thing the old `null` return meant to a shopper.
 *
 * 參數型別是 ShopProductCard（2026-09）：這裡只讀 productType/sessions/stock/
 * availableCapped，description 從來沒被用過。/shop 的卡片與詳情頁的完整商品都
 * 能直接傳進來（ShopProduct 是 ShopProductCard 多一欄），呼叫端不必轉型。
 */
export function remainingFor(p: ShopProductCard): number | null {
  if (p.productType === "event" || p.productType === "journey") {
    if (p.sessions.length === 0) return 0;
    return p.sessions.reduce((max, s) => Math.max(max, remainingForSession(s)), 0);
  }
  if (p.stock !== null) return p.stock;
  return p.availableCapped;
}

/** True when nothing more can be added. `remaining === null` is never sold out. */
export function isSoldOut(p: ShopProductCard): boolean {
  const remaining = remainingFor(p);
  return remaining !== null && remaining <= 0;
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/**
 * All purchasable products, in the order the back office arranged them
 * (`sort_order`, then `id` so ties are stable across page loads rather than
 * left to PostgREST).
 */
export async function fetchActiveProducts(): Promise<ShopListResult> {
  const db = supabase;
  if (!db) {
    logFailure("products", "Supabase is not configured");
    return { products: [], unavailable: true };
  }
  try {
    const { data, error } = await db
      .from("products")
      .select(COLUMNS)
      .eq("status", "active")
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (error || !Array.isArray(data)) {
      logFailure("products", error?.message ?? "unexpected response shape");
      return { products: [], unavailable: true };
    }

    const products: ShopProduct[] = [];
    for (const row of data as unknown as Row[]) {
      const p = toProduct(row);
      if (p) products.push(p);
    }
    // attachPlans() 必須排在 attachSessions() 之後——它要用 attachSessions()
    // 填進去的 session id 去查方案，兩者不能平行（見 attachPlans() 的檔頭）。
    // attachAvailability() 跟這兩者互不相依，維持平行。
    await Promise.all([attachAvailability(products), attachSessions(products)]);
    await attachPlans(products);
    return { products, unavailable: false };
  } catch (err) {
    logFailure("products", err instanceof Error ? err.message : String(err));
    return { products: [], unavailable: true };
  }
}

/**
 * Card-shaped counterpart of fetchActiveProducts() — same query, minus
 * `description` (CARD_COLUMNS vs COLUMNS). Written for `/shop`
 * (src/routes/shop.index.tsx), whose loader used to call
 * fetchActiveProducts() for the "products" tab's card grid *and*
 * fetchActiveProductsByIds() a second time for the "local publications" tab
 * — even though the second call's ids are always a subset of the first call's
 * results (both filter on `status = 'active'`; fetchActiveProductsByIds just
 * adds an `id IN (...)`). Every product referenced by a publication was
 * therefore serialized into the SSR payload *twice*, full description
 * included both times — measured at 43 `description` + 40 `summary` blocks,
 * 65,771 CJK characters, on the live site (2026-09).
 *
 * The fix here is column-level (this function); src/routes/shop.index.tsx
 * additionally stopped calling fetchActiveProductsByIds() at all and now
 * hands this same result to both the products tab and the publications tab —
 * see that route's loader comment.
 *
 * Never call this for /shop/$slug or anything checkout/cart-adjacent — those
 * need the full ShopProduct (description) or already have their own
 * unmodified read (fetchActiveProducts/fetchActiveProductsByIds/
 * fetchActiveProductBySlug, all untouched by this addition).
 */
export async function fetchActiveProductsForList(): Promise<ShopListCardResult> {
  const db = supabase;
  if (!db) {
    logFailure("products", "Supabase is not configured");
    return { products: [], unavailable: true };
  }
  try {
    const { data, error } = await db
      .from("products")
      .select(CARD_COLUMNS)
      .eq("status", "active")
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (error || !Array.isArray(data)) {
      logFailure("products", error?.message ?? "unexpected response shape");
      return { products: [], unavailable: true };
    }

    const products: ShopProductCard[] = [];
    for (const row of data as unknown as Row[]) {
      const p = toProductCard(row);
      if (p) products.push(p);
    }
    // attachPlans() 必須排在 attachSessions() 之後——它要用 attachSessions()
    // 填進去的 session id 去查方案，兩者不能平行（見 attachPlans() 的檔頭）。
    // attachAvailability() 跟這兩者互不相依，維持平行。
    await Promise.all([attachAvailability(products), attachSessions(products)]);
    await attachPlans(products);
    return { products, unavailable: false };
  } catch (err) {
    logFailure("products", err instanceof Error ? err.message : String(err));
    return { products: [], unavailable: true };
  }
}

/**
 * 首頁「主理人的選品」那一排商品卡（src/components/shop/HomeProductShelf.tsx）。
 *
 * 選哪幾件：跟 /shop〈商品〉分頁**同一個排序**——後台商品的「排序（數字越小越
 * 前面）」，同分再比 id——取前面幾件**現在買得到**的書籍／選物。所以店主想讓哪一
 * 本上首頁，就在後台把那件商品的排序調小；下架（status 不是 active）或售完的會
 * 自動讓位給下一件，不需要另一個「精選」欄位（也沒有 DDL 權限加）。
 *
 * 為什麼不直接用 fetchActiveProductsForList() 再 slice：
 *   - 那一支撈整份目錄（含 23+ 件的三語 summary）塞進首頁的 SSR payload，首頁只
 *     畫 4 張；
 *   - 它還要 attachSessions() → attachPlans() 兩段**序列**查詢，那是給
 *     event/journey 用的，書與選物用不到——首頁 loader 會被多拖一段往返。
 * 這裡只查 goods/book、limit 一個小量，然後只做 attachAvailability()（判斷售完要用）。
 *
 * 活動／策旅不在這裡：它們在首頁上面各有自己的一區，而且要先選場次才能加購物車。
 *
 * 失敗語意同 fetchActiveProductsForList()：讀壞回 unavailable:true，首頁那一區
 * 會退回原本的單張意象圖，不會開天窗。
 */
export async function fetchHomeShelfProducts(limit = 4): Promise<ShopListCardResult> {
  const db = supabase;
  if (!db) {
    logFailure("home shelf", "Supabase is not configured");
    return { products: [], unavailable: true };
  }
  try {
    // 多撈幾件當備胎：售完的要跳過，但「售完」要等 attachAvailability() 才知道。
    const { data, error } = await db
      .from("products")
      .select(CARD_COLUMNS)
      .eq("status", "active")
      .in("product_type", ["goods", "book"])
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit * 4);

    if (error || !Array.isArray(data)) {
      logFailure("home shelf", error?.message ?? "unexpected response shape");
      return { products: [], unavailable: true };
    }

    const candidates: ShopProductCard[] = [];
    for (const row of data as unknown as Row[]) {
      const p = toProductCard(row);
      if (p) candidates.push(p);
    }
    await attachAvailability(candidates);
    return {
      products: candidates.filter((p) => !isSoldOut(p)).slice(0, limit),
      unavailable: false,
    };
  } catch (err) {
    logFailure("home shelf", err instanceof Error ? err.message : String(err));
    return { products: [], unavailable: true };
  }
}

/**
 * The subset of the catalogue referenced by a specific set of ids.
 *
 * Exists for /publications, where 126 exhibits are on the page but only the
 * handful that carry a publications.product_id are purchasable. Pulling the
 * whole catalogue there would grow with the shop rather than with the exhibit
 * list, and re-mapping rows by hand at the call site would fork toProduct() —
 * which is the one place that decides what a malformed row means.
 *
 * An empty `ids` is not a query: PostgREST would happily return the empty set,
 * but a round-trip to learn nothing is still a round-trip on every page load.
 */
export async function fetchActiveProductsByIds(ids: string[]): Promise<ShopListResult> {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  if (unique.length === 0) return { products: [], unavailable: false };

  const db = supabase;
  if (!db) {
    logFailure("products", "Supabase is not configured");
    return { products: [], unavailable: true };
  }
  try {
    const { data, error } = await db
      .from("products")
      .select(COLUMNS)
      .eq("status", "active")
      .in("id", unique)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (error || !Array.isArray(data)) {
      logFailure("products", error?.message ?? "unexpected response shape");
      return { products: [], unavailable: true };
    }

    const products: ShopProduct[] = [];
    for (const row of data as unknown as Row[]) {
      const p = toProduct(row);
      if (p) products.push(p);
    }
    // attachPlans() 必須排在 attachSessions() 之後——它要用 attachSessions()
    // 填進去的 session id 去查方案，兩者不能平行（見 attachPlans() 的檔頭）。
    // attachAvailability() 跟這兩者互不相依，維持平行。
    await Promise.all([attachAvailability(products), attachSessions(products)]);
    await attachPlans(products);
    return { products, unavailable: false };
  } catch (err) {
    logFailure("products", err instanceof Error ? err.message : String(err));
    return { products: [], unavailable: true };
  }
}

/**
 * One product by its public slug. `product: null` with `unavailable: false`
 * means the slug really does not exist (or is not active) and the caller should
 * render a 404; `unavailable: true` means we could not tell.
 */
export async function fetchActiveProductBySlug(slug: string): Promise<ShopProductResult> {
  const db = supabase;
  if (!db) {
    logFailure(`products/${slug}`, "Supabase is not configured");
    return { product: null, unavailable: true };
  }
  try {
    const { data, error } = await db
      .from("products")
      .select(COLUMNS)
      .eq("status", "active")
      .eq("slug", slug)
      .maybeSingle();

    if (error) {
      logFailure(`products/${slug}`, error.message);
      return { product: null, unavailable: true };
    }
    if (!data) return { product: null, unavailable: false };
    const product = toProduct(data as unknown as Row);
    if (product) {
      await Promise.all([attachAvailability([product]), attachSessions([product])]);
      await attachPlans([product]);
    }
    return { product, unavailable: false };
  } catch (err) {
    logFailure(`products/${slug}`, err instanceof Error ? err.message : String(err));
    return { product: null, unavailable: true };
  }
}

/**
 * 活動商品的 slug 規則：`event-<events.slug>`。
 *
 * 🔴 **這個前綴在 SQL 那邊也有一份** —— supabase/migrations/0026 的
 *    `public.event_product_slug(text)`，那是**寫**的那一側（活動上架時就是它算出
 *    products.slug）。這裡是**讀**的那一側。跨語言沒辦法共用一份實作，所以兩邊的
 *    前綴字面值由 scripts/event-product-selftest.mjs 釘在一起：改了一邊沒改另一邊，
 *    那條斷言會紅。
 *
 *    為什麼一定要釘：兩邊分岔的症狀是**前台查不到商品**，而查不到商品在畫面上
 *    長成「報名尚未開放」—— 一句看起來完全正常、沒有任何錯誤訊息的句子。
 */
export function eventProductSlug(eventSlug: string): string {
  return `event-${eventSlug}`;
}

/**
 * 一場活動賣出去的那件商品，用 **slug 這條真連結**查。
 *
 * ── 為什麼不是 (source_type, source_id) ─────────────────────────────────────
 * 這裡原本是 fetchActiveProductForEvent(eventId)，用 0004 的
 * (source_type='event', source_id=events.id) 反查。那一組能用，但它是**靠慣例維持
 * 的**：0026 之前資料庫不保證一場活動只有一件商品，所以那一支得用 `.limit(1)` 取
 * 排序上的第一件 —— 也就是說「賣哪一件」取決於 sort_order 與 id 的排序運氣，
 * 而不是取決於任何人的決定。
 *
 * 0026 之後改走 products.slug：那一欄從 0004 起就有唯一索引，而
 * `event-<events.slug>` 是從活動推導出來的**唯一**字串，所以這是一次 unique 索引
 * 上的等值查詢，沒有「取第一件」這回事。events.slug 被改掉時 products.slug 由
 * 0026 的 events_slug_sync_product trigger 跟著改，兩邊不會分岔。
 *
 * （後台那一側仍然用 (source_type, source_id) —— 見
 * src/server/repos/events.ts#listEventProducts。那裡要問的是反方向的問題「這件商品
 * 是哪一場活動的」，而 0026 的 products_event_source_unique_idx 讓它也不再需要
 * limit(1)。）
 *
 * 用途：場次（0020 掛在 products.id 上）與報名按鈕的目的地。
 *
 * `unavailable: true` 的意思一如本檔其他函式：**問不到**，不是「沒有」。呼叫端要
 * 據此顯示「暫時無法載入」，而不是「報名尚未開放」——後者是一句它還不知道真假的話。
 */
export async function fetchActiveProductForEventSlug(
  eventSlug: string,
): Promise<ShopProductResult> {
  if (!eventSlug) return { product: null, unavailable: false };
  return await fetchActiveProductBySlug(eventProductSlug(eventSlug));
}

/** NT$1,280 — the site shows whole dollars everywhere. */
export function formatPrice(twd: number): string {
  return `NT$${twd.toLocaleString("en-US")}`;
}
