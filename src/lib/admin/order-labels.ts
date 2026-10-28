/**
 * 後台訂單頁共用的中文對照與格式化——列表（_shell.orders.tsx）與詳情頁
 * （_shell.orders_.$id.tsx）兩支 route 都用。
 *
 * **刻意與 src/lib/email-templates.ts 的 PAYMENT_METHOD_LABEL_ZH／
 * SHIPPING_METHOD_LABEL_ZH 各自維護一份**，不是共用 import：那個檔案是給寄信用的，
 * 一千多行信件樣板字串，只為了幾個對照表把它整包拉進後台的瀏覽器 bundle 不划算。
 * 值域鎖在資料庫的 CHECK 裡，改動機率趨近於零，兩份保持同樣的中文字即可。
 *
 * 純函式、零 import：selftest 可以直接 import() 這個檔案本人。
 */

export type OrderListScope = "transfer_pending" | "to_ship" | "all" | "invoice_problem";

/**
 * 列表頁的篩選條件，也是詳情頁「回訂單列表」要帶回去的網址參數。
 * transfer_pending 是預設分頁，網址上不寫；archived 只在打開時寫 `archived=1`。
 */
export type OrderListSearch = { scope?: "to_ship" | "all" | "invoice_problem"; archived?: 1 };

export function parseOrderListSearch(search: Record<string, unknown>): OrderListSearch {
  const out: OrderListSearch = {};
  if (search.scope === "to_ship" || search.scope === "all" || search.scope === "invoice_problem") {
    out.scope = search.scope;
  }
  const a = search.archived;
  if (a === 1 || a === "1" || a === true || a === "true") out.archived = 1;
  return out;
}

export function scopeOf(search: OrderListSearch): OrderListScope {
  return search.scope ?? "transfer_pending";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  card: "信用卡",
  atm: "ATM 轉帳",
  cvs_cod: "超商代收",
  test_paid: "測試付款",
  free: "免費（無需付款）",
  // 0034。與 'atm' 刻意用不同的字：'atm' 是金流商動態虛擬帳號、自動核帳；
  // 'transfer' 是客人匯到店家固定帳戶、人工對帳。
  transfer: "匯款（人工對帳）",
};
export function paymentMethodLabel(code: string | null): string {
  if (!code) return "由店家聯繫付款";
  return PAYMENT_METHOD_LABEL[code] ?? code;
}

const SHIPPING_METHOD_LABEL: Record<string, string> = {
  home: "宅配到府",
  cvs: "超商取貨",
  pickup: "門市自取",
  none: "無需配送",
};
export function shippingMethodLabel(code: string): string {
  return SHIPPING_METHOD_LABEL[code] ?? code;
}

export const STATUS_LABEL: Record<string, string> = {
  pending: "待處理",
  processing: "處理中",
  shipped: "已出貨",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失敗",
};

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending: "待付款",
  paid: "已付款",
  failed: "付款失敗",
  refunded: "已退款",
};

const INVOICE_TYPE_LABEL: Record<string, string> = {
  personal: "個人",
  company: "公司（三聯式）",
  donate: "捐贈",
};
export function invoiceTypeLabel(code: string): string {
  return INVOICE_TYPE_LABEL[code] ?? code;
}

/** 0005 的 carrier_type 代碼。 */
const CARRIER_TYPE_LABEL: Record<string, string> = {
  "3J0002": "手機條碼",
  CQ0001: "自然人憑證",
};
export function carrierTypeLabel(code: string): string {
  return CARRIER_TYPE_LABEL[code] ?? code;
}

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export function statusBadgeVariant(status: string): BadgeVariant {
  if (status === "cancelled" || status === "failed") return "destructive";
  if (status === "processing" || status === "shipped" || status === "completed") return "default";
  return "secondary";
}

export function paymentStatusBadgeVariant(status: string): BadgeVariant {
  if (status === "paid") return "default";
  if (status === "failed" || status === "refunded") return "destructive";
  return "secondary";
}

export function money(n: number): string {
  return `NT$ ${n.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`;
}

/** 宅配地址一行：郵遞區號 縣市區門牌。 */
export function formatHomeAddress(a: {
  postal_code: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
}): string {
  const line = `${a.city ?? ""}${a.district ?? ""}${a.street ?? ""}`.trim();
  return [a.postal_code?.trim() ?? "", line].filter(Boolean).join(" ");
}
