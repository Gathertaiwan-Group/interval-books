/**
 * 後台「商品」單一頁的純邏輯 —— 把四種「前台看得到的品項」攤成同一張清單。
 *
 * ── 為什麼要有這一頁 ────────────────────────────────────────────────────────
 * 店家（2026-10-20）：「商品部分也簡化，在一個頁面就可以管理全部的商品」。在這之前
 * 側欄有三個入口各管一塊：電商 › 商品（public.products）、內容管理 › 地方刊物展
 * （public.publications）、內容管理 › 選品（public.curated_themes/curated_items）。
 * 前台 /shop 是一頁三分頁，後台卻是三個不同群組裡的三頁。
 *
 * ── 四種品項，四張表，一條規則：不重複列 ────────────────────────────────────
 *   goods        一般商品  products.product_type ∈ goods/book，**且沒有刊物指向它**
 *   publication  地方刊物  publications 每一本一列；連到商品的那本，價格／可售量跟著帶過來
 *   curated      選品      curated_items 每一項一列（只有名稱與備註，**不販售**）
 *   ticket       活動票券  products.product_type ∈ event/journey
 *
 * 刊物連上庫存後，publications.product_id 指向一件 slug 為 `pub-…` 的 book 商品。
 * 那件商品**只出現在刊物那一列**，不再在「一般商品」重複一次 —— 否則同一本書在
 * 「全部」裡會有兩列、兩個上下架開關，而兩個開關管的是不同的東西。
 *
 * ── 這個檔案為什麼一行 import 都沒有 ────────────────────────────────────────
 * 與 src/lib/admin/nav-active.ts 同一個理由：scripts/unified-products-selftest.mjs
 * 可以不經過 bundler 直接 `await import()` 產線上跑的這一份。
 */

// ---------------------------------------------------------------------------
// 分頁
// ---------------------------------------------------------------------------

export const UNIFIED_KINDS = ["goods", "publication", "curated", "ticket"] as const;
export type UnifiedKind = (typeof UNIFIED_KINDS)[number];
export type UnifiedTab = "all" | UnifiedKind;
export const UNIFIED_TABS: readonly UnifiedTab[] = ["all", ...UNIFIED_KINDS];

export const KIND_LABEL: Record<UnifiedKind, string> = {
  goods: "一般商品",
  publication: "地方刊物",
  curated: "選品",
  ticket: "活動票券",
};

export const TAB_LABEL: Record<UnifiedTab, string> = { all: "全部", ...KIND_LABEL };

/** ?type= 的解析。不認得的值一律當成沒帶（＝全部），不丟錯。 */
export function parseUnifiedTab(value: unknown): UnifiedTab | undefined {
  return UNIFIED_TABS.includes(value as UnifiedTab) && value !== "all"
    ? (value as UnifiedTab)
    : undefined;
}

/**
 * 舊網址 → 新分頁。/admin/publications 與 /admin/curated 收進這一頁之後，檔案保留
 * 成轉址（書籤、對話紀錄裡的連結照樣到得了）。
 */
export const LEGACY_ADMIN_REDIRECTS = {
  "/admin/publications": "publication",
  "/admin/curated": "curated",
} as const satisfies Record<string, UnifiedKind>;

// ---------------------------------------------------------------------------
// 輸入的形狀（只列這一頁用得到的欄位；與 src/server/repos/** 的 Row 相容）
// ---------------------------------------------------------------------------

type L = { zh: string; en: string; ja: string };

export type UPProduct = {
  id: string;
  slug: string;
  product_type: "goods" | "book" | "event" | "journey";
  source_type: "event" | "journey" | "curated_item" | null;
  source_id: string | null;
  title: L;
  price: number;
  compare_at_price: number | null;
  stock: number | null;
  image_key: string | null;
  status: "draft" | "active" | "archived";
  updated_at: string;
};

export type UPPublication = {
  id: string;
  slug: string;
  sheet: string;
  title: L;
  region: string;
  cover_image_key: string | null;
  product_id: string | null;
  is_published: boolean;
  updated_at: string;
};

export type UPCuratedTheme = { id: string; title: L };
export type UPCuratedItem = {
  id: number;
  theme_id: string;
  name: L;
  is_published: boolean;
  updated_at: string;
};

/** inv_listed_products 的一列：連到進銷存的商品，可售量由 view 算好。 */
export type UPListed = { product_id: string; inv_name: string; available: number };

// ---------------------------------------------------------------------------
// 一列
// ---------------------------------------------------------------------------

export type UnifiedRow = {
  /** React key，跨四張表不會撞：`goods:<id>`、`curated:<id>`… */
  key: string;
  kind: UnifiedKind;
  /** 這一列自己那張表的 id（curated_items 是數字）。 */
  id: string | number;
  name: string;
  /** 名稱下面那一行小字：刊物的地區、選品的主題、票券的類型… */
  subtitle: string;
  imageKey: string | null;
  /** 這一列「被賣的」那件商品；沒有商品（未連結的刊物、選品）是 null。 */
  productId: string | null;
  /** null = 這一列沒有售價（只展示／不販售）。 */
  price: number | null;
  comparePrice: number | null;
  /** 前台看不看得到（products: status='active'；刊物／選品: is_published）。 */
  published: boolean;
  statusLabel: string;
  /** 可售量。null = 不管理庫存或不適用；stockNote 說明為什麼。 */
  stock: number | null;
  stockNote: string;
  /** 連到進銷存品項時，那個品項的名稱（顯示用 + 連到進銷存頁）。 */
  invName: string | null;
  updatedAt: string;
  /**
   * 這一列在這一頁能不能動。活動商品是活動編輯頁投影出來的（0026/0029），在這裡改
   * 價格或上下架會與活動頁互相覆蓋，所以只給一個「去活動頁」的連結。
   */
  editable: boolean;
  /** 能不能在列上直接改價格。 */
  priceEditable: boolean;
  /** 不能在這一頁編輯時，要去哪裡編。 */
  externalEditHref: string | null;
  /** externalEditHref 指向活動編輯頁時，那場活動的 events.id。 */
  eventId: string | null;
  searchText: string;
};

const PRODUCT_STATUS_LABEL: Record<UPProduct["status"], string> = {
  draft: "草稿",
  active: "上架中",
  archived: "已下架",
};

function lower(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ")
    .toLowerCase();
}

function ticketHref(p: UPProduct): string | null {
  if (p.source_type === "event" && p.source_id) return `/admin/events/${p.source_id}`;
  return null;
}

function productStock(p: UPProduct, listed: UPListed | undefined) {
  if (p.product_type === "event" || p.product_type === "journey") {
    return { stock: null, stockNote: "按場次" };
  }
  if (listed) return { stock: listed.available, stockNote: "進銷存" };
  if (p.stock != null) return { stock: p.stock, stockNote: "" };
  return { stock: null, stockNote: "不管理" };
}

/**
 * 把四張表攤成一張清單。順序：一般商品 → 地方刊物 → 選品 → 活動票券，每一種內部
 * 保留各自 repo 的順序（那就是前台的順序）。
 */
export function buildUnifiedRows(input: {
  products: UPProduct[];
  publications: UPPublication[];
  curatedThemes: UPCuratedTheme[];
  curatedItems: UPCuratedItem[];
  listed: UPListed[];
}): UnifiedRow[] {
  const productById = new Map(input.products.map((p) => [p.id, p]));
  const listedByProduct = new Map(input.listed.map((l) => [l.product_id, l]));
  const pubProductIds = new Set(
    input.publications.map((p) => p.product_id).filter((id): id is string => !!id),
  );
  const themeTitle = new Map(input.curatedThemes.map((t) => [t.id, t.title.zh]));

  const goods: UnifiedRow[] = [];
  const tickets: UnifiedRow[] = [];
  for (const p of input.products) {
    const isTicket = p.product_type === "event" || p.product_type === "journey";
    if (!isTicket && pubProductIds.has(p.id)) continue; // 在刊物那一列
    const listed = listedByProduct.get(p.id);
    const href = isTicket ? ticketHref(p) : null;
    const editable = href === null;
    const row: UnifiedRow = {
      key: `${isTicket ? "ticket" : "goods"}:${p.id}`,
      kind: isTicket ? "ticket" : "goods",
      id: p.id,
      name: p.title.zh,
      subtitle: isTicket
        ? p.product_type === "event"
          ? "活動"
          : "策旅"
        : p.product_type === "book"
          ? "書籍"
          : "商品",
      imageKey: p.image_key,
      productId: p.id,
      price: p.price,
      comparePrice: p.compare_at_price,
      published: p.status === "active",
      statusLabel: PRODUCT_STATUS_LABEL[p.status],
      ...productStock(p, listed),
      invName: listed?.inv_name ?? null,
      updatedAt: p.updated_at,
      editable,
      priceEditable: editable,
      externalEditHref: href,
      eventId: href ? p.source_id : null,
      searchText: lower(p.title.zh, p.title.en, p.title.ja, p.slug, listed?.inv_name),
    };
    (isTicket ? tickets : goods).push(row);
  }

  const publications: UnifiedRow[] = input.publications.map((pub) => {
    const product = pub.product_id ? productById.get(pub.product_id) : undefined;
    const listed = pub.product_id ? listedByProduct.get(pub.product_id) : undefined;
    const stock = product ? productStock(product, listed) : { stock: null, stockNote: "只展示" };
    return {
      key: `publication:${pub.id}`,
      kind: "publication",
      id: pub.id,
      name: pub.title.zh,
      subtitle: [pub.sheet === "jp" ? "日本" : pub.sheet === "tw" ? "台灣" : pub.sheet, pub.region]
        .filter(Boolean)
        .join("・"),
      imageKey: pub.cover_image_key,
      productId: pub.product_id,
      price: product ? product.price : null,
      comparePrice: product ? product.compare_at_price : null,
      published: pub.is_published,
      statusLabel: pub.is_published ? (product ? "展出・可買" : "展出・只展示") : "已下架",
      ...stock,
      invName: listed?.inv_name ?? null,
      // 價格改的是那件商品，所以「最後更新」取兩者較晚的那個。
      updatedAt:
        product && product.updated_at > pub.updated_at ? product.updated_at : pub.updated_at,
      editable: true,
      priceEditable: !!product,
      externalEditHref: null,
      eventId: null,
      searchText: lower(
        pub.title.zh,
        pub.title.en,
        pub.title.ja,
        pub.region,
        pub.slug,
        listed?.inv_name,
      ),
    };
  });

  const curated: UnifiedRow[] = input.curatedItems.map((item) => ({
    key: `curated:${item.id}`,
    kind: "curated",
    id: item.id,
    name: item.name.zh,
    subtitle: themeTitle.get(item.theme_id) ?? "",
    imageKey: null,
    productId: null,
    price: null,
    comparePrice: null,
    published: item.is_published,
    statusLabel: item.is_published ? "展出中" : "已下架",
    stock: null,
    stockNote: "不販售",
    invName: null,
    updatedAt: item.updated_at,
    editable: true,
    priceEditable: false,
    externalEditHref: null,
    eventId: null,
    searchText: lower(item.name.zh, item.name.en, item.name.ja, themeTitle.get(item.theme_id)),
  }));

  return [...goods, ...publications, ...curated, ...tickets];
}

// ---------------------------------------------------------------------------
// 篩選、排序、計數
// ---------------------------------------------------------------------------

export const SORT_KEYS = ["default", "updated", "name", "price"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const SORT_LABEL: Record<SortKey, string> = {
  default: "預設順序",
  updated: "最近更新",
  name: "名稱",
  price: "價格（高→低）",
};

export type StatusFilter = "all" | "published" | "unpublished";

export function filterUnifiedRows(
  rows: UnifiedRow[],
  opts: { tab: UnifiedTab; query: string; status?: StatusFilter },
): UnifiedRow[] {
  const q = opts.query.trim().toLowerCase();
  const status = opts.status ?? "all";
  return rows.filter((r) => {
    if (opts.tab !== "all" && r.kind !== opts.tab) return false;
    if (status === "published" && !r.published) return false;
    if (status === "unpublished" && r.published) return false;
    return !q || r.searchText.includes(q);
  });
}

/** 穩定排序：同值時維持原本（前台）的順序。 */
export function sortUnifiedRows(rows: UnifiedRow[], key: SortKey): UnifiedRow[] {
  if (key === "default") return rows.slice();
  const indexed = rows.map((r, i) => [r, i] as const);
  indexed.sort(([a, ai], [b, bi]) => {
    let d = 0;
    if (key === "updated") d = a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
    else if (key === "name") d = a.name.localeCompare(b.name, "zh-Hant-TW");
    else if (key === "price") d = (b.price ?? -1) - (a.price ?? -1);
    return d !== 0 ? d : ai - bi;
  });
  return indexed.map(([r]) => r);
}

export function countByTab(rows: UnifiedRow[]): Record<UnifiedTab, number> {
  const counts: Record<UnifiedTab, number> = {
    all: rows.length,
    goods: 0,
    publication: 0,
    curated: 0,
    ticket: 0,
  };
  for (const r of rows) counts[r.kind] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// 寫入的 payload（給既有的 server fn，不是新的寫入路徑）
// ---------------------------------------------------------------------------

/**
 * 上下架開關 → products.status。
 *
 * 打開一律是 active。關掉時：原本是 active 就變 archived（「已下架」），原本是
 * draft 就維持 draft —— 一件從沒上過架的草稿，不該因為有人按了一下開關就被標成
 * 「下架封存」。
 */
export function nextProductStatus(
  current: UPProduct["status"],
  wantPublished: boolean,
): UPProduct["status"] {
  if (wantPublished) return "active";
  return current === "active" ? "archived" : current;
}

/**
 * 列上直接改價格的輸入檢查。回傳整數元，或一句給人看的錯誤。
 * 規則與 productSchema.price 相同（整數、不可為負）；刊物連結的商品另外要 ≥1，
 * 與 publicationLinkSchema 同一條理由（0 元在結帳／發票／金流都是特例）。
 */
export function parsePriceInput(
  raw: string,
  opts: { min?: number } = {},
): { ok: true; value: number } | { ok: false; message: string } {
  const s = raw
    .trim()
    .replace(/[,，\s]/g, "")
    .replace(/^NT\$/i, "");
  if (s === "") return { ok: false, message: "請輸入價格" };
  if (!/^\d+$/.test(s)) return { ok: false, message: "價格必須是整數元（不接受小數或負數）" };
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return { ok: false, message: "價格太大" };
  const min = opts.min ?? 0;
  if (n < min) return { ok: false, message: `價格至少 ${min} 元` };
  return { ok: true, value: n };
}

/**
 * 從標題生網址代稱：英文標題的半形英數字，接一段短亂數避免撞名。英文標題是空的
 * 或全是非拉丁字時只剩前綴 + 亂數，一樣合法（products.slug 只要求唯一）。
 */
export function slugFromTitle(titleEn: string, suffix: string, prefix = "item"): string {
  const base = titleEn
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const tail = suffix.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [base || prefix, tail].filter(Boolean).join("-");
}

export type NewGoodsInput = {
  product_type: "goods" | "book";
  title: L;
  summary: L;
  price: number;
  stock: number | null;
  image_key: string | null;
  publish: boolean;
  slug: string;
  sort_order: number;
};

/**
 * 「新增商品 › 一般商品」那一張精簡表單 → productSchema 的完整 payload。
 *
 * 精簡表單只問必要的幾格；其餘欄位的預設值寫在這裡一次：
 *   · description 沿用 summary（DB 要求三語齊備，商品頁的長說明之後在「編輯」補）
 *   · requires_shipping true（goods/book 都是實體）
 *   · 不關聯任何來源（source_type/source_id null）
 */
export function buildNewGoodsPayload(input: NewGoodsInput) {
  return {
    slug: input.slug,
    product_type: input.product_type,
    source_type: null,
    source_id: null,
    title: input.title,
    summary: input.summary,
    description: input.summary,
    price: input.price,
    compare_at_price: null,
    stock: input.stock,
    image_key: input.image_key,
    requires_shipping: true,
    status: input.publish ? ("active" as const) : ("draft" as const),
    sort_order: input.sort_order,
  };
}

/** 選品新增時的 sort_order：那個主題目前最大值 + 1（curated_items 有 unique(theme_id, sort_order)）。 */
export function nextCuratedSortOrder(
  items: { theme_id: string; sort_order: number }[],
  themeId: string,
): number {
  let max = 0;
  for (const it of items) if (it.theme_id === themeId) max = Math.max(max, it.sort_order);
  return max + 1;
}

/**
 * 「新增」時可以選的種類。活動與策旅的票不在這一頁建：2026-10-20 起活動頁與策旅頁
 * 各有「一頁新增」（/admin/events/new、/admin/journeys/new），活動＋商品＋場次＋票種
 * 一次建好 —— 在這裡另做一份就是第二條建立路徑。地方刊物是匯入的固定集合，不新增。
 */
export const CREATE_OPTIONS: readonly {
  key: string;
  kind: UnifiedKind;
  label: string;
  hint: string;
  /** 不在這裡建立 → 要去的地方（null = 就在這裡建）。 */
  href: "/admin/events/new" | "/admin/journeys/new" | null;
}[] = [
  {
    key: "goods",
    kind: "goods",
    label: "一般商品",
    hint: "書、器物、茶…可以直接結帳的實體商品。",
    href: null,
  },
  {
    key: "curated",
    kind: "curated",
    label: "選品",
    hint: "主理人選品清單上的一項（只展示、不販售）。",
    href: null,
  },
  {
    key: "event",
    kind: "ticket",
    label: "活動票券",
    hint: "到「新增活動」一頁建好活動、商品、場次與票種。",
    href: "/admin/events/new",
  },
  {
    key: "journey",
    kind: "ticket",
    label: "策旅票券",
    hint: "到「新增策旅」一頁建好策旅、商品與梯次。",
    href: "/admin/journeys/new",
  },
  {
    key: "publication",
    kind: "publication",
    label: "地方刊物",
    hint: "126 本是從原始清單匯入的固定集合，不在這裡新增；要賣某一本，請在清單上按「連到庫存」。",
    href: null,
  },
];
