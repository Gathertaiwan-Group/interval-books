/**
 * Shopping cart — zustand + persist(localStorage).
 *
 * Ported from the same team's Realreal storefront
 * (apps/web/src/lib/cart.ts), keeping its two hard-won behaviours:
 *
 *   1. every mutation clamps against the latest known purchase limit, so a
 *      quantity that exceeds stock can never enter the cart in the first
 *      place; and
 *   2. `skipHydration: true` — the store starts empty on both the server and
 *      the first client render, and is only rehydrated from localStorage
 *      inside an effect. Without this, SSR renders an empty cart, the client
 *      immediately renders a full one, and React reports a hydration mismatch.
 *
 * Four deliberate departures from the Realreal original:
 *
 *   - **No toast() inside the store.** Realreal calls sonner from inside the
 *     `set()` updater, which hardcodes Traditional Chinese strings into a state
 *     reducer. This site is zh/en/ja, so the mutations instead return a result
 *     code and the calling component renders the localized toast. This also
 *     keeps the module free of browser-only imports, so importing it during SSR
 *     is harmless.
 *   - **`partialize`** — Realreal persists the whole state and relies on
 *     JSON.stringify dropping the functions. Naming `items` explicitly means a
 *     future derived field cannot accidentally start being written to disk.
 *   - **`version` + `migrate`** — Realreal has neither, so a shape change would
 *     silently merge stale localStorage into the new code. Anything not written
 *     by the current version is discarded rather than trusted.
 *   - **`syncFromCatalogue`** — a cart line is a snapshot taken at add time.
 *     Realreal patches only the price (updatePrice) and leaves stock stale,
 *     which means a limit enforced against a week-old snapshot. Here the cart
 *     route reconciles every line against the live catalogue on load, so
 *     price, copy and the remaining-quantity cap are current, and products that
 *     have since been de-listed or sold out are visibly flagged rather than
 *     silently carried forward.
 *
 * Checkout and payment are explicitly out of scope for this module; nothing
 * here talks to the server, and the cart is browser-local only.
 *
 * ⚠️ 參加者姓名／聯絡方式**不在這裡**，而且不可以搬進來。
 * ------------------------------------------------------
 * 0020 之後活動報名要逐位填寫參加者，最順手的做法是把那幾筆資料掛在 CartLine 上
 * 一路帶到結帳。**不要這樣做。** 這個 store 會被 persist() 寫進 localStorage，
 * 那等於把第三人的姓名與電話留在瀏覽器裡，沒有到期時間，也沒有任何一頁告訴使用者
 * 它在那裡。參加者資料只在 /checkout 的表單狀態裡活著，送出之後就交給伺服器 ——
 * 一次結帳一次，不落地。
 *
 * 購物車只記「哪一場、幾個位子」（sessionId + qty），那是報價需要的全部。
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Localized } from "@/i18n/types";
import type {
  ShopPlan,
  ShopProduct,
  ShopProductCard,
  ShopProductType,
  ShopSession,
} from "@/lib/shop";
import { isPlanAvailable, remainingFor, remainingForPlan, remainingForSession } from "@/lib/shop";
import { isSessionClosedForBooking } from "@/lib/event-status";

/**
 * Why a line can no longer be bought. Kept as a reason rather than a boolean so
 * the UI can tell the shopper which of the two happened — they are not the same
 * news, and "sold out" is the one worth waiting for.
 */
export type CartUnavailableReason = "delisted" | "sold_out" | "session_ended";

/**
 * One line in the cart.
 *
 * `title` is kept as the full {zh,en,ja} object rather than a rendered string
 * so that switching language re-renders the cart in the new language. A cart
 * that lives only in localStorage has no server read to fall back on, so
 * whatever is stored here IS the copy.
 */
export type CartLine = {
  productId: string;
  /**
   * Which sitting this line books. `null` for goods/book — and the two are not
   * interchangeable: migration 0020 puts a CHECK on order_items that refuses a
   * booking without a session and a book with one.
   *
   * ⚠️ This is why the line key stopped being `productId`. One activity with a
   * morning and an evening sitting is two different things to buy, and keying
   * on the product alone would have merged them into one line with one quantity
   * — silently sending the shopper to whichever sitting was added first.
   */
  sessionId: string | null;
  /**
   * Snapshot of the sitting's name, for the cart and checkout summaries. Kept
   * as {zh,en,ja} for the same reason `title` is: localStorage is the only copy
   * the cart page has, so switching language has to re-render from it.
   *
   * Refreshed by syncFromCatalogue like every other snapshot field. Null for
   * non-bookings.
   */
  sessionTitle: Localized | null;
  /** ISO 8601. Snapshot, same treatment as sessionTitle. */
  sessionStartsAt: string | null;
  /**
   * 選了哪個價格方案（票種，0036）。`null` 代表這個場次沒有方案，或這一行沒選
   * ——那時 `price` 直接來自 products.price、`qty` 就是座位數，與 0020 之後的
   * 行為逐字相同。
   *
   * ⚠️ 這是繼 sessionId 之後第二次讓行的身分（cartLineKey）納入一個新欄位：
   * 同一場次的「單人票」與「雙人房」是兩個不同的東西要買，合併成一行就會讓其中
   * 一種方案的數量被另一種吃掉。理由與 sessionId 那段完全對稱。
   */
  planId: string | null;
  /** 方案名稱快照，同 sessionTitle 的理由。null 代表沒有方案。 */
  planTitle: Localized | null;
  /**
   * 一個購買單位佔用場次的幾個座位。沒有方案（或方案為 null）時恆為 1。
   * `qty × planSeatsPerUnit` 才是這一行真正要佔用的座位數，也是結帳頁參加者
   * 表單要收的份數——見 src/routes/checkout.index.tsx 的 participantSlots。
   */
  planSeatsPerUnit: number;
  slug: string;
  title: Localized;
  productType: ShopProductType;
  /** TWD, whole dollars. 有方案時是方案的單價；沒有方案時是 products.price。 */
  price: number;
  compareAtPrice: number | null;
  /**
   * 買了幾個「單位」，不是幾個座位——見 planSeatsPerUnit。沒有方案（或商品不是
   * 預約類）的行，單位就是座位／件數本身，0020 之後的行為逐字相同。
   */
  qty: number;
  /**
   * Maximum purchasable quantity as of the last catalogue read; null means
   * genuinely unlimited (a product with stock = NULL, i.e. not stock-managed).
   * Unifies `stock` for goods/book and remaining seats for event/journey —
   * see remainingFor() in src/lib/shop.ts.
   *
   * 0036：選了方案時，這個數字是**單位**的上限——
   * `min(方案剩餘單位, floor(場次剩餘位子 / planSeatsPerUnit))`，見
   * cartInputFor() 與 syncFromCatalogue()。
   */
  limit: number | null;
  imageKey: string | null;
  /**
   * Set by syncFromCatalogue. The line is kept so the shopper is told what
   * happened, but it is excluded from the count and subtotal and its only
   * available action is removal.
   */
  unavailable?: CartUnavailableReason;
};

/**
 * Outcome of a mutation, so the caller can show the right localized message.
 *   added        — the cart changed as asked
 *   capped       — clamped to the limit; nothing more could be added
 *   out_of_stock — nothing was added at all
 */
export type CartResult = "added" | "capped" | "out_of_stock";

export type CartInput = Omit<CartLine, "qty" | "unavailable"> & { qty: number };

type CartStore = {
  items: CartLine[];
  addItem: (line: CartInput) => CartResult;
  /** `key` is a cartLineKey(), NOT a product id — see that function. */
  setQty: (key: string, qty: number) => CartResult;
  removeItem: (key: string) => void;
  clear: () => void;
  syncFromCatalogue: (products: ShopProduct[]) => void;
};

/**
 * What makes two cart lines the same line.
 *
 * Was `productId` alone until migration 0020 introduced sittings. An activity
 * with two sittings is two distinct things to buy, so the identity of a line is
 * (product, sitting) — otherwise adding the evening sitting to a cart that
 * already holds the morning one just increments the morning one's quantity and
 * the shopper is booked into the wrong session with no way to tell.
 *
 * 0036 adds `planId` to the same key for the same reason: 早鳥票與雙人房是同一個
 * 場次底下兩個不同的東西要買，合併成一行就會讓其中一種方案的數量被另一種吃掉，
 * 而且兩者的 seatsPerUnit 可能不同——攤平成一行之後 qty 該乘哪個 seatsPerUnit
 * 會變成一個算不出來的問題。
 *
 * goods/book always pass `null`/`null`, so their key is `"<id>::"` — stable, and
 * it can never collide with a uuid-suffixed booking key.
 */
export function cartLineKey(
  productId: string,
  sessionId: string | null,
  planId: string | null = null,
): string {
  return `${productId}:${sessionId ?? ""}:${planId ?? ""}`;
}

/** The key of an existing line. */
export function keyOfLine(line: {
  productId: string;
  sessionId: string | null;
  planId: string | null;
}): string {
  return cartLineKey(line.productId, line.sessionId, line.planId);
}

/** Namespaced like the language key in src/i18n/LanguageContext.tsx. */
const STORAGE_KEY = "interval-books-cart";

/**
 * Bump whenever CartLine changes shape; older payloads are dropped, not merged.
 *
 * 1 → 2 (migration 0020): lines gained `sessionId`, and the line key changed
 * from `productId` to `productId:sessionId`. A version-1 payload has no session
 * id on any line, so a booking carried across would reach the checkout with
 * `sessionId: null` — which the server refuses, and which the CHECK on
 * order_items refuses again. **Throwing one cart away is far better than
 * submitting an order that cannot say which sitting it is for**, so the
 * migrate() below keeps discarding rather than trying to patch.
 *
 * 2 → 3（0036）：行加了 planId／planTitle／planSeatsPerUnit，key 從
 * `productId:sessionId` 換成 `productId:sessionId:planId`。同一個理由：version-2
 * 的舊資料完全沒有這三欄，`qty` 在舊資料裡的意思是「座位數」，在新程式碼裡
 * 「沒有方案時 qty 仍然是座位數」剛好逐字相容——**除非**那個場次剛好在客人
 * 離開又回來的這段時間被後台加上了方案，那時候一筆沒有 planSeatsPerUnit 的舊
 * 資料會被當成 seatsPerUnit=1 處理，可能低估真正要收的參加者人數。丟掉舊購物車
 * 比帶著一個算錯份數的購物車進結帳安全，跟 1→2 那次是同一個判斷。
 */
const STORAGE_VERSION = 3;

function clampToLimit(qty: number, limit: number | null): number {
  if (limit === null) return Math.max(0, qty);
  return Math.max(0, Math.min(qty, limit));
}

export const useCart = create<CartStore>()(
  persist(
    (set, get) => ({
      items: [],

      addItem: (line) => {
        const items = get().items;
        const key = keyOfLine(line);
        const existing = items.find((i) => keyOfLine(i) === key);
        // Trust the incoming limit over the stored one: it came from the page
        // the shopper is looking at, which is newer than the snapshot.
        const limit = line.limit;

        if (existing) {
          const next = clampToLimit(existing.qty + line.qty, limit);
          if (next <= existing.qty) return next <= 0 ? "out_of_stock" : "capped";
          set({
            items: items.map((i) =>
              keyOfLine(i) === key ? { ...i, ...line, qty: next, unavailable: undefined } : i,
            ),
          });
          return "added";
        }

        const next = clampToLimit(line.qty, limit);
        if (next <= 0) return "out_of_stock";
        set({ items: [...items, { ...line, qty: next, unavailable: undefined }] });
        return "added";
      },

      setQty: (key, qty) => {
        const items = get().items;
        const existing = items.find((i) => keyOfLine(i) === key);
        if (!existing) return "out_of_stock";

        // Matching Realreal: decrementing past zero removes the line rather
        // than leaving a 0-quantity row behind.
        if (qty <= 0) {
          set({ items: items.filter((i) => keyOfLine(i) !== key) });
          return "added";
        }

        const next = clampToLimit(qty, existing.limit);
        if (next <= 0) {
          set({ items: items.filter((i) => keyOfLine(i) !== key) });
          return "out_of_stock";
        }
        if (next !== existing.qty) {
          set({
            items: items.map((i) => (keyOfLine(i) === key ? { ...i, qty: next } : i)),
          });
        }
        return next < qty ? "capped" : "added";
      },

      removeItem: (key) =>
        set((state) => ({ items: state.items.filter((i) => keyOfLine(i) !== key) })),

      clear: () => set({ items: [] }),

      /**
       * Refresh every line against the live catalogue.
       *
       * A line whose product has vanished from the active list is flagged
       * `delisted`; one whose remaining quantity has fallen to zero is flagged
       * `sold_out` and its qty is clamped to 0, so the invariant "qty never
       * exceeds limit" holds for every line, not just the ones last touched by
       * a mutation. Neither case deletes the line — the shopper is told.
       *
       * Skips the write entirely when nothing changed, so calling this from an
       * effect cannot loop.
       */
      syncFromCatalogue: (products) => {
        const byId = new Map(products.map((p) => [p.id, p]));
        let changed = false;

        const items = get().items.map((line) => {
          const p = byId.get(line.productId);
          if (!p) {
            if (line.unavailable === "delisted") return line;
            changed = true;
            return { ...line, unavailable: "delisted" as const };
          }

          // A booking's limit is its OWN sitting's remaining places, not the
          // product-wide maximum remainingFor() reports. Two sittings of 5
          // would otherwise let one line reach 5 while the picked sitting had
          // only 1 left. A sitting that has vanished from the catalogue (closed
          // by the back office, or its date passed) is `delisted` rather than
          // `sold_out`: waiting will not bring it back.
          const session =
            line.sessionId === null
              ? null
              : (p.sessions.find((s) => s.id === line.sessionId) ?? null);
          if (line.sessionId !== null && session === null) {
            if (line.unavailable === "delisted") return line;
            changed = true;
            return { ...line, unavailable: "delisted" as const };
          }

          // 0036：這一行選了方案——在目前的場次資料裡重新找它。跟 session 一樣，
          // 「這個方案在目錄裡完全不見了」（被後台刪掉、或整個場次都不見了）算
          // delisted；「還在，但名額用完或不在販售期間」算 sold_out（不像
          // delisted 那樣永久沒救——早鳥結束前買不到，不代表它一直買不到）。
          const plan =
            line.planId === null
              ? null
              : (session?.plans.find((pl) => pl.id === line.planId) ?? null);
          if (line.planId !== null && plan === null) {
            if (line.unavailable === "delisted") return line;
            changed = true;
            return { ...line, unavailable: "delisted" as const };
          }

          // 數量上限＝min(方案剩餘單位, floor(場次剩餘位子 / seatsPerUnit))。
          // 沒有方案的行（plan 為 null）行為與 0020 之後逐字相同。
          const limit = plan
            ? isPlanAvailable(plan)
              ? Math.min(
                  remainingForPlan(plan),
                  Math.floor(remainingForSession(session!) / plan.seatsPerUnit),
                )
              : 0
            : session
              ? remainingForSession(session)
              : remainingFor(p);
          // 場次已經開始（或結束）：放進購物車之後才開始的那一種。不清掉這一行、也不
          // 動數量（客人要看得到是哪一場），只標成 session_ended —— 跟 sold_out 不同，
          // 等待不會讓它回來。規則與伺服器 priceLines() 同一支 isSessionClosedForBooking()；
          // 這裡用的是瀏覽器的時間，只是提示，伺服器那一道才算數。
          const ended = session !== null && isSessionClosedForBooking(session);
          const qty = ended ? line.qty : clampToLimit(line.qty, limit);
          const next: CartLine = {
            ...line,
            slug: p.slug,
            title: p.title,
            productType: p.productType,
            // 有方案時單價是方案的，沒有方案時是商品的——與 orders.ts 的
            // priceLines() 同一條規則。
            price: plan ? plan.price : p.price,
            compareAtPrice: p.compareAtPrice,
            imageKey: p.imageKey,
            sessionTitle: session ? session.title : null,
            sessionStartsAt: session ? session.startsAt : null,
            planTitle: plan ? plan.title : null,
            planSeatsPerUnit: plan ? plan.seatsPerUnit : 1,
            limit,
            qty,
            unavailable: ended ? "session_ended" : qty <= 0 ? "sold_out" : undefined,
          };

          const same =
            line.slug === next.slug &&
            line.title === next.title &&
            line.productType === next.productType &&
            line.price === next.price &&
            line.compareAtPrice === next.compareAtPrice &&
            line.imageKey === next.imageKey &&
            line.sessionTitle === next.sessionTitle &&
            line.sessionStartsAt === next.sessionStartsAt &&
            line.planTitle === next.planTitle &&
            line.planSeatsPerUnit === next.planSeatsPerUnit &&
            line.limit === next.limit &&
            line.qty === next.qty &&
            line.unavailable === next.unavailable;
          if (same) return line;
          changed = true;
          return next;
        });

        if (changed) set({ items });
      },
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ items: state.items }),
      migrate: (persisted, version) =>
        version === STORAGE_VERSION ? (persisted as { items: CartLine[] }) : { items: [] },
      // See the file header: nothing is read from localStorage until an effect
      // calls persist.rehydrate(), which is what keeps SSR and the first client
      // render identical.
      skipHydration: true,
    },
  ),
);

/**
 * True once localStorage has been read. Every component that renders cart
 * contents must gate on this and show the empty state until it flips, or the
 * SSR HTML and the first client render will disagree.
 *
 * Realreal repeats this three-line effect in three separate components; it is a
 * hook here so there is one place for it to be right.
 */
export function useCartHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    void useCart.persist.rehydrate();
    setHydrated(true);
  }, []);
  return hydrated;
}

/**
 * Total number of units in the cart, for the header badge.
 *
 * Derived inside the selector rather than exposed as a `total()` method on the
 * store: a method has to be paired with a separate `items` subscription to
 * re-render (a trap the Realreal drawer only avoids by accident), whereas this
 * subscribes to exactly what it reads. It returns a number, so zustand's
 * default reference equality is the correct comparison.
 */
export function useCartCount(): number {
  return useCart((s) => s.items.reduce((sum, i) => (i.unavailable ? sum : sum + i.qty), 0));
}

/** Cart subtotal in whole TWD. Unavailable lines are excluded. */
export function useCartSubtotal(): number {
  return useCart((s) =>
    s.items.reduce((sum, i) => (i.unavailable ? sum : sum + i.price * i.qty), 0),
  );
}

/**
 * Builds a cart line from a catalogue product. Single source of the mapping.
 *
 * `session` is required for event/journey and must be null for goods/book —
 * the caller decides, because only it knows which sitting the shopper picked.
 * Passing null for a booking is not rejected here (the store has no business
 * throwing), but it produces a line the checkout will refuse, so the product
 * page must never offer an "add" button before a sitting is chosen.
 *
 * `p: ShopProductCard` (2026-09, was `ShopProduct`) — nothing below reads
 * `.description`, and widening to the card shape lets /shop's publications
 * tab call this directly with its (description-less) card products instead
 * of re-deriving an "add to cart" input by hand. ShopProduct still satisfies
 * this type (it has every ShopProductCard field plus one), so every existing
 * caller (shop.$slug.tsx's detail page) is unaffected.
 *
 * `plan`（0036，選填）：這一場選了哪個價格方案。傳了就必須也傳 `session`——一個
 * 方案永遠屬於某個場次，這裡不驗證兩者是否真的對得上（那是伺服器端
 * priceLines() 的工作），呼叫端本來就是從 `session.plans` 裡挑出來的，不會對
 * 不上。沒傳（或傳 null）時行為與 0020 之後逐字相同：單價是 products.price、
 * 上限是場次剩餘座位數。
 */
export function cartInputFor(
  p: ShopProductCard,
  qty: number,
  session: ShopSession | null = null,
  plan: ShopPlan | null = null,
): CartInput {
  const limit = plan
    ? isPlanAvailable(plan)
      ? Math.min(
          remainingForPlan(plan),
          Math.floor((session ? remainingForSession(session) : 0) / plan.seatsPerUnit),
        )
      : 0
    : session
      ? remainingForSession(session)
      : remainingFor(p);
  return {
    productId: p.id,
    sessionId: session ? session.id : null,
    sessionTitle: session ? session.title : null,
    sessionStartsAt: session ? session.startsAt : null,
    planId: plan ? plan.id : null,
    planTitle: plan ? plan.title : null,
    planSeatsPerUnit: plan ? plan.seatsPerUnit : 1,
    slug: p.slug,
    title: p.title,
    productType: p.productType,
    price: plan ? plan.price : p.price,
    compareAtPrice: p.compareAtPrice,
    imageKey: p.imageKey,
    limit,
    qty,
  };
}
