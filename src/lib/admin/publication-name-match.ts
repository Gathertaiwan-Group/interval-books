/**
 * 「跟這本刊物同名的進銷存品項」——在程式裡算，取代每次約 1 秒的
 * `public.publication_listing_candidates` view（0015：inv_listing_candidates × publications
 * 的 cross join，兩邊每一列都跑 regexp_replace）。後台商品頁本來就已經把兩邊的資料都抓回來了，
 * 在記憶體裡比對 786 × 126 筆不到 1 ms。
 *
 * 🔴 比對規則必須跟 view 的 SQL **一字不差**（0015 檔頭：刻意不做模糊比對——猜錯的連結
 *    會讓客人買到另一本刊物）。view 的條件是：
 *
 *      regexp_replace(lower(c.name), '[^[:alnum:]]', '', 'g')
 *        = regexp_replace(lower(p.title ->> 'zh'), '[^[:alnum:]]', '', 'g')
 *      or（同上，換成 p.title ->> 'ja'）
 *
 *    逐項對應：
 *      · lower()          → String.prototype.toLowerCase()
 *      · [[:alnum:]]      → Unicode Alphabetic 或十進位數字（\p{Alphabetic}\p{Nd}）。正式庫的
 *                           Postgres 用的是 Unicode 字元分類（中日文、全形英數都算 alnum），
 *                           2026-10-25 對正式庫資料裡出現的每一個字元逐一用 `~` 驗證過分類相同
 *                           （scripts/publication-name-match-selftest.mjs 的唯讀比對段）。
 *      · NULL 規則        → 品名或該語言的標題是 NULL（沒有這個 key、或 JSON null）就不算相等；
 *                           SQL 的 `NULL = x` 是 NULL，不是 true。
 *      · 空字串           → 兩邊正規化之後都是 ''（例如整串都是標點）**算相等**——SQL 的
 *                           '' = '' 是 true。照抄，不擅自「修正」。
 *      · 已知的理論差異（正式庫現有資料裡都沒有，2026-10-25 逐字驗過）：JS 的 toLowerCase 會把字尾
 *        的 Σ 轉成 ς、Postgres 轉成 σ；Unicode「Alphabetic」與 glibc 分類若在將來的 Unicode 版本
 *        有出入（〇、羅馬數字Ⅰ、組合用附加符號這類），以 selftest 的正式庫比對段為準。
 *      · ->> 的型別       → 字串原樣；數字／布林／物件取它的 JSON 文字（->> 的行為）。標題由
 *                           zod 驗成字串，實務上只會走第一條。
 *
 * 純函式、零 import：selftest 直接 import()。
 */

export type NameMatchCandidate = {
  inv_product_id: string;
  name: string | null;
  selling_price: number;
  stock_quantity: number;
  pack_size: number;
  barcode: string | null;
};

export type NameMatchPublication = {
  id: string;
  title: unknown;
};

export type PublicationNameMatchRow = {
  publication_id: string;
  inv_product_id: string;
  name: string;
  selling_price: number;
  stock_quantity: number;
  pack_size: number;
  barcode: string | null;
};

const NON_ALNUM = /[^\p{Alphabetic}\p{Nd}]/gu;

/** `regexp_replace(lower(s), '[^[:alnum:]]', '', 'g')`；s 是 NULL 時回 null。 */
export function normalizeListingName(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  return s.toLowerCase().replace(NON_ALNUM, "");
}

/** `title ->> key`：沒有這個 key 或 JSON null → null；字串原樣；其他型別 → JSON 文字。 */
export function jsonbText(obj: unknown, key: string): string | null {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const v = (obj as Record<string, unknown>)[key];
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** 跟 view 回同一組 (publication_id, 品項) 列。順序：刊物照傳入順序，品項照傳入順序。 */
export function matchPublicationNames(
  candidates: readonly NameMatchCandidate[],
  publications: readonly NameMatchPublication[],
): PublicationNameMatchRow[] {
  const byName = new Map<string, NameMatchCandidate[]>();
  for (const c of candidates) {
    const key = normalizeListingName(c.name);
    if (key === null) continue;
    const list = byName.get(key);
    if (list) list.push(c);
    else byName.set(key, [c]);
  }
  const out: PublicationNameMatchRow[] = [];
  for (const p of publications) {
    const zh = normalizeListingName(jsonbText(p.title, "zh"));
    const ja = normalizeListingName(jsonbText(p.title, "ja"));
    // `a = zh OR a = ja`：同一個品項兩個條件都成立也只出現一次（cross join 的一列）。
    const seen = new Set<NameMatchCandidate>();
    for (const key of [zh, ja]) {
      if (key === null) continue;
      for (const c of byName.get(key) ?? []) seen.add(c);
    }
    if (seen.size === 0) continue;
    for (const c of candidates) {
      if (!seen.has(c)) continue;
      out.push({
        publication_id: p.id,
        inv_product_id: c.inv_product_id,
        name: c.name as string,
        selling_price: c.selling_price,
        stock_quantity: c.stock_quantity,
        pack_size: c.pack_size,
        barcode: c.barcode,
      });
    }
  }
  return out;
}
