/**
 * 商品頁「規格切換」的純函式（2026-11，參虎爆紅薏仁大小罐 × 口味）。
 *
 * ── 資料從哪來 ───────────────────────────────────────────────────────────
 * 不加欄位（正式庫沒有 DDL 權限），用進銷存既有的兩欄：
 *
 *   · inv.products.series        ＝ 分組依據。trim 後**完全相等**且非空的品項是同一組。
 *                                   不比對名稱字串。
 *   · inv.products.issue_number  ＝ 這件在組裡的規格值，格式「值1｜值2」（全形｜，
 *                                   也接受半形 |）。每段可以帶軸名前綴「軸名:值」或
 *                                   「軸名：值」，例如「罐別:大罐 150g｜口味:焦糖」。
 *                                   沒前綴的軸用 DEFAULT_AXIS_NAMES。
 *
 * 讀取在 src/server/product-variants.ts（service role，anon 讀不到 inv schema），
 * 這裡只負責把那份清單變成畫面要的東西，不碰資料庫，自檢見
 * scripts/product-variants-selftest.mjs。
 *
 * ── 規則 ────────────────────────────────────────────────────────────────
 *   · 只有一段（沒有分隔）的 issue_number 不算規格 —— 一般刊物的期數就是那樣。
 *   · 軸數以「目前這件」為準；軸數不同的兄弟品項略過，不讓頁面壞。
 *   · 有效品項少於 2 件 → 不顯示（null）。
 *   · 第 i 軸的某個值「可選」＝存在一件品項，前 i 軸（0..i-1）與目前相同、第 i 軸是
 *     這個值。第 0 軸永遠可選（只要有人有這個值）。所以「小罐沒有辣香鮮燒」時，在小罐
 *     頁面上「辣香鮮燒」是停用的；但在大罐辣香鮮燒的頁面上按「小罐」仍然可以按。
 *   · 點選後去哪：先找「其他軸全部維持不變」的那件；沒有就找「前 i 軸相同、第 i 軸是
 *     這個值」的第一件（品項順序＝伺服器給的順序）。
 */
import type { Localized } from "@/i18n/types";

/** 規格切換的一件兄弟品項（只含公開資訊）。 */
export type VariantSource = {
  /** public.products.id */
  productId: string;
  /** public.products.slug —— 導頁用 */
  slug: string;
  /** inv.products.issue_number 原文 */
  spec: string | null;
};

export type ParsedSpec = {
  /** 每一軸的軸名；沒前綴的是 null。 */
  names: (string | null)[];
  values: string[];
};

export type VariantAxis = {
  /** 軸名：issue_number 前綴給的字串，或預設的三語名稱。 */
  name: string | Localized;
  /** 這一軸出現過的值，依品項順序去重。 */
  values: string[];
};

export type VariantItem = {
  productId: string;
  slug: string;
  values: string[];
};

export type VariantGroup = {
  axes: VariantAxis[];
  items: VariantItem[];
  current: VariantItem;
};

export type VariantOption = {
  value: string;
  selected: boolean;
  disabled: boolean;
  /** 點下去要去的 slug；停用時是 null。選中的那顆是目前這件的 slug。 */
  slug: string | null;
};

export const DEFAULT_AXIS_NAMES: Localized[] = [
  { zh: "規格", en: "Option", ja: "仕様" },
  { zh: "款式", en: "Style", ja: "タイプ" },
];

function defaultAxisName(index: number): Localized {
  return (
    DEFAULT_AXIS_NAMES[index] ?? {
      zh: `規格 ${index + 1}`,
      en: `Option ${index + 1}`,
      ja: `仕様 ${index + 1}`,
    }
  );
}

/** 軸名前綴：第一個半形或全形冒號之前（兩邊都要有字）。 */
const PREFIX_RE = /^([^:：]+)[:：](.+)$/;

/**
 * 「罐別:大罐 150g｜口味:焦糖」→ { names: ["罐別","口味"], values: ["大罐 150g","焦糖"] }。
 * 少於兩段、或任何一段是空的 → null（不是規格）。
 */
export function parseVariantSpec(spec: string | null | undefined): ParsedSpec | null {
  if (typeof spec !== "string") return null;
  const parts = spec.split(/[｜|]/).map((s) => s.trim());
  if (parts.length < 2) return null;
  const names: (string | null)[] = [];
  const values: string[] = [];
  for (const part of parts) {
    // 空段、或「軸名:」後面沒有值 → 不是規格。
    if (!part || /[:：]$/.test(part)) return null;
    const m = PREFIX_RE.exec(part);
    const name = m ? m[1].trim() : "";
    const value = m ? m[2].trim() : part;
    if (!value) return null;
    names.push(name || null);
    values.push(value);
  }
  return { names, values };
}

/**
 * 把同一組（series 相同）的品項清單整理成規格切換要的資料。
 * 目前這件不在清單裡、目前這件不是規格、或有效品項少於 2 件 → null（不顯示）。
 */
export function buildVariantGroup(
  currentProductId: string,
  sources: VariantSource[],
): VariantGroup | null {
  const parsed = sources
    .map((s) => ({ source: s, spec: parseVariantSpec(s.spec) }))
    .filter((x): x is { source: VariantSource; spec: ParsedSpec } => x.spec !== null);
  const mine = parsed.find((x) => x.source.productId === currentProductId);
  if (!mine) return null;
  const width = mine.spec.values.length;

  const seen = new Set<string>();
  const kept: { source: VariantSource; spec: ParsedSpec }[] = [];
  for (const x of parsed) {
    if (x.spec.values.length !== width) continue;
    // 兩件規格值完全相同：只留第一件（不然兩顆鈕會指向同一個組合）。目前這件優先。
    const key = JSON.stringify(x.spec.values);
    const isMine = x.source.productId === currentProductId;
    if (seen.has(key)) {
      // 原位取代，品項順序不變。
      if (isMine) kept[kept.findIndex((k) => JSON.stringify(k.spec.values) === key)] = x;
      continue;
    }
    seen.add(key);
    kept.push(x);
  }
  if (kept.length < 2) return null;

  const items: VariantItem[] = kept.map((x) => ({
    productId: x.source.productId,
    slug: x.source.slug,
    values: x.spec.values,
  }));
  const axes: VariantAxis[] = [];
  for (let i = 0; i < width; i++) {
    const named =
      mine.spec.names[i] ?? kept.map((x) => x.spec.names[i]).find((n) => n !== null) ?? null;
    const values: string[] = [];
    for (const it of items) if (!values.includes(it.values[i])) values.push(it.values[i]);
    axes.push({ name: named ?? defaultAxisName(i), values });
  }
  const current = items.find((it) => it.productId === currentProductId);
  if (!current) return null;
  return { axes, items, current };
}

function samePrefix(a: string[], b: string[], upTo: number): boolean {
  for (let i = 0; i < upTo; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 在第 axisIndex 軸點選 value 之後要去的那件；沒有可去的 → null。 */
export function variantTarget(
  group: VariantGroup,
  axisIndex: number,
  value: string,
): VariantItem | null {
  const want = group.current.values.map((v, i) => (i === axisIndex ? value : v));
  const exact = group.items.find((it) => it.values.every((v, i) => v === want[i]));
  if (exact) return exact;
  return (
    group.items.find(
      (it) => it.values[axisIndex] === value && samePrefix(it.values, want, axisIndex),
    ) ?? null
  );
}

/** 第 axisIndex 軸每一顆鈕的狀態（選中／停用／去哪）。 */
export function variantOptions(group: VariantGroup, axisIndex: number): VariantOption[] {
  const axis = group.axes[axisIndex];
  if (!axis) return [];
  return axis.values.map((value) => {
    const selected = group.current.values[axisIndex] === value;
    const target = selected ? group.current : variantTarget(group, axisIndex, value);
    return { value, selected, disabled: target === null, slug: target?.slug ?? null };
  });
}
