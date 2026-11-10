/**
 * 首頁「主理人的選品」那一排要放哪幾件——純邏輯。
 *
 * 規則（業主 2026-10-26：「首頁要放主理人挑的那幾件」）：
 *
 *   1. 先放**主理人的選品**裡有連結商品（curated_items.product_id，0041）的那幾件：
 *      主題照主題排序（sort_order，同分比 id），主題內照品項排序（sort_order，同分比 id）。
 *      只有「現在買得到」的才算：商品是 active（anon 的 RLS 本來就只看得到 active，
 *      讀不到＝不算）、是書籍或選物（活動／策旅票券要先選場次，不能從這裡加購物車）、
 *      沒有售完。同一件商品出現在兩個主題只放一次。
 *   2. 不滿 limit 件，再用原本的規則補：後台商品排序最前面、買得到的書籍／選物，
 *      已經放過的跳過。
 *   3. 主理人連了 limit 件以上 → 全部是選品，不補。
 *
 * 只吃已經發布的主題：curated_items 的 RLS 只看品項自己的 is_published，**不看**
 * 主題（0001 curated_items_select_public）。所以「主題下架、品項沒下架」的那幾件，
 * anon 仍讀得到品項列，但讀不到它的主題——這裡用「主題清單裡有沒有它」擋掉，
 * 跟 /shop〈主理人的選品〉分頁（只畫讀得到的主題）同一條線。
 *
 * 純函式、零 import：scripts/curated-link-selftest.mjs 直接 import() 這一份。
 */

export const SHELF_PRODUCT_TYPES = ["goods", "book"] as const;

/** 只有書籍與選物能上首頁那一排（票券要先選場次）。 */
export function isShelfProductType(t: unknown): boolean {
  return t === "goods" || t === "book";
}

export type CuratedShelfTheme = { id: string; sort_order: number };
export type CuratedShelfItem = {
  id: number;
  theme_id: string;
  product_id: string | null;
  sort_order: number;
};

function byOrderThenId<T extends { sort_order: number; id: string | number }>(a: T, b: T): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 有連結商品的選品，照前台順序攤成商品 id 清單（已去重，保留第一次出現的位置）。
 * 主題不在 themes 裡（沒發布／讀不到）的品項不算。
 */
export function orderedCuratedProductIds(
  themes: readonly CuratedShelfTheme[],
  items: readonly CuratedShelfItem[],
): string[] {
  const sortedThemes = [...themes].sort(byOrderThenId);
  const byTheme = new Map<string, CuratedShelfItem[]>();
  for (const it of items) {
    if (typeof it.product_id !== "string" || it.product_id.length === 0) continue;
    const list = byTheme.get(it.theme_id);
    if (list) list.push(it);
    else byTheme.set(it.theme_id, [it]);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const theme of sortedThemes) {
    const list = byTheme.get(theme.id);
    if (!list) continue;
    for (const it of [...list].sort(byOrderThenId)) {
      const pid = it.product_id as string;
      if (seen.has(pid)) continue;
      seen.add(pid);
      out.push(pid);
    }
  }
  return out;
}

/**
 * 組出最後那一排。
 *
 * @param curatedIds   orderedCuratedProductIds() 的結果
 * @param productsById 讀得到的商品（只有 active 的讀得到）；選品指到的商品不在這裡＝不算
 * @param fallback     原本的補位清單（已照後台排序排好）
 * @param isSoldOut    售完判斷（shop.ts#isSoldOut；要先 attachAvailability()）
 */
export function selectHomeShelf<T extends { id: string; productType: string }>(opts: {
  curatedIds: readonly string[];
  productsById: ReadonlyMap<string, T>;
  fallback: readonly T[];
  limit: number;
  isSoldOut: (p: T) => boolean;
}): T[] {
  const { curatedIds, productsById, fallback, limit, isSoldOut } = opts;
  const out: T[] = [];
  const seen = new Set<string>();
  const take = (p: T | undefined) => {
    if (!p || out.length >= limit) return;
    if (seen.has(p.id)) return;
    if (!isShelfProductType(p.productType)) return;
    if (isSoldOut(p)) return;
    seen.add(p.id);
    out.push(p);
  };
  for (const id of curatedIds) take(productsById.get(id));
  for (const p of fallback) take(p);
  return out;
}

/** PostgREST 回 42703（undefined_column）——0041 還沒套用到這個資料庫。 */
export function isMissingColumnError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "42703") return true;
  return (
    typeof e.message === "string" &&
    /product_id/.test(e.message) &&
    /does not exist/.test(e.message)
  );
}

/**
 * 前台〈主理人的選品〉能露出哪幾件（2026-11-10 文案健檢 S2／S3／S5，業主核准）。
 *
 * curated_items 原本的 18 件是種子範例（桂花蜜、粗陶茶碗……），**不是真的商品**。業主先要求
 * 不再露出，同日再要求移除假資料：正式庫的 18 列已刪除（備份在當日工作紀錄），
 * src/data/content.ts 與 supabase/seed.sql 的範例也拿掉了。這支濾網留著當規則：之後主理人
 * 新增選品時，在後台把它「連結商品」才會上架，不需要再改程式。
 *
 * 判準：品項有 product_id，而且那件商品在前台讀得到（active）、是書籍或選物。
 *   · 沒連商品                → 不露出（範例就是這一類）
 *   · 連了但商品下架／讀不到   → 不露出（點進去會是死路）
 *   · 連到票券                 → 不露出（票券要先選場次，不能從櫥窗買）
 * 售完的照樣露出（卡片上會標「已售完」）——那是真的商品，只是暫時沒貨。
 *
 * 沒有任何一件可露出的主題整個拿掉；全部都拿掉時回空陣列，由呼叫端顯示「整理中」。
 * 不另加旗標欄位：不新增 migration，而「連了商品」本來就是「這是真的選品」的意思。
 */
export function displayableCuratedThemes<
  Th extends { items: readonly { productId?: string | null }[] },
>(themes: readonly Th[], products: readonly { id: string; productType: string }[]): Th[] {
  const shelfIds = new Set(
    products.filter((p) => isShelfProductType(p.productType)).map((p) => p.id),
  );
  const out: Th[] = [];
  for (const theme of themes) {
    const items = theme.items.filter(
      (it) => typeof it.productId === "string" && shelfIds.has(it.productId),
    );
    if (items.length > 0) out.push({ ...theme, items });
  }
  return out;
}
