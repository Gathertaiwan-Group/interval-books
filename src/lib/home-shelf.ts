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
