/**
 * Data layer for the back-office order list / detail / manual payment
 * reconciliation page (src/routes/admin/_shell.orders.tsx).
 *
 * ── 為什麼是一個新檔案，不是加進 src/server/repos/orders.ts ──────────────────
 * orders.ts 的檔頭是結帳那條路徑：建立訂單、預留座位／庫存、呼叫金流，每一支函式
 * 都假設「這是客人結帳流程的一部分」。這裡要做的是完全不同的事 —— 後台**讀**既有
 * 訂單、以及**手動核銷匯款**。混進同一個檔案會讓那份檔頭的假設不再成立（下一個要
 * 改結帳邏輯的人，得先搞清楚裡面幾支跟結帳無關的函式）。分開之後，orders.ts 那條
 * 「金流在走的路徑」一行都不用碰，這個檔案也完全不 import 它 —— 兩邊各自獨立可讀，
 * scripts/admin-orders-selftest.mjs 有靜態測試守著「這個檔案不 import orders.ts」
 * 與「orders.ts 一個位元組都沒被這一期改到」。
 *
 * ── 個資：後台看明文（業主 2026-10-25 決定）────────────────────────────────
 * 業主決定訂單在後台**直接顯示明文、不留查閱紀錄**（「不用紀錄」）：訂購人姓名／
 * 電話／信箱、收件人與電話、完整地址含門牌、超商門市、統編／抬頭、客人備註。理由是
 * 出貨與聯絡本來就要用到這些，遮罩只是讓店員每次都得另外翻信件。
 *
 * 所以這一支**不需要 migration**：pii_access_log 的白名單沒有 'public.orders'，
 * 也不必有——這條路徑刻意不寫紀錄。與報名名單（event-registrations.ts，會先寫一筆
 * pii_log_access 再讀明文）不同，那是業主另外的決定，兩者不要混為一談。
 *
 * 只有 adminFnMiddleware（role='admin'）的 server fn 會呼叫這裡，門市人員看不到。
 *
 * ⚠️ console.error 仍然只印 error.code 與 error.message：PostgREST 的 DETAIL 會帶
 *    整列值，那一列就是客人的個資，不該進 Vercel log。
 *
 * ── 速度 ──────────────────────────────────────────────────────────────────
 * 詳情原本是三次**依序**查詢（orders → order_items → order_addresses），函式在
 * iad1、資料庫在東京時每一次都是一趟跨太平洋。現在改成**一次** PostgREST 巢狀
 * select（orders + order_items(event_sessions) + order_addresses + invoices），
 * 一趟就回來。order_items／order_addresses／invoices 都有 order_id 外鍵指向
 * orders，invoices 另有 unique(order_id)，所以它以物件（to-one）形式嵌入。
 *
 * ── 標記已收款 ────────────────────────────────────────────────────────────
 * markOrderPaidByAdmin() 呼叫 public.admin_mark_order_paid()（0034 §5）。
 *
 * 🔴 不要改叫 src/server/repos/payments.ts 的 markOrderPaid()。那一支是金流
 *    webhook 專用，會把 payment_method 硬寫成 'card'（payments.ts:301）——用來
 *    標記匯款訂單，會讓資料庫從此說謊：後台的付款方式欄位變成假的，對帳報表把它
 *    算進刷卡手續費。admin_mark_order_paid() 存在的唯一理由就是保留原本的
 *    payment_method（0034 §5 檔頭），這個檔案呼叫的是它，不是 markOrderPaid()。
 *
 * ── 刪除／封存（0035）─────────────────────────────────────────────────────
 * deleteAdminOrder() 呼叫 public.admin_delete_order()、archiveAdminOrder() 呼叫
 * public.admin_archive_order()（見 supabase/migrations/0035_admin_order_registration_cleanup.sql
 * §3／§4）。兩支都跟 markOrderPaidByAdmin() 一樣，只是把 RPC 的參數包起來、把
 * `returns table` 的單例陣列拆開——**判斷本身在資料庫那一層**，這裡不重複判斷一次
 * 「這張訂單能不能刪」，因為那個判斷需要鎖那一列（for update）才做得對，搬到這裡
 * 會變成 read-then-write 的競態視窗。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";
import { TO_SHIP_FILTER } from "@/lib/admin/order-fulfillment";

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

export type AdminOrderListScope = "transfer_pending" | "to_ship" | "all";

export type AdminOrderListFilter = {
  scope: AdminOrderListScope;
  /**
   * 顯示已封存（0035）。預設 false／undefined——列表照舊只看
   * `archived_at is null`，吃 0035 §3 的 orders_not_archived_idx。設成 true 時
   * 不加那個條件，讓已封存的訂單也一起回來（不是切成第三個 scope：封存是一個
   * 可以疊加在任一個 scope 上的顯示開關，不是另一種篩選維度）。
   */
  includeArchived?: boolean;
};

/**
 * 列表欄位。列表只需要訂單編號＋金額＋末五碼＋姓名就能核對匯款，聯絡方式與地址
 * 在詳情頁（/admin/orders/$id）才讀——不是為了遮，是列表最多 300 列，沒必要每一列
 * 都多帶一包資料回來。
 */
const LIST_COLUMNS =
  "id, order_no, created_at, total, payment_method, payment_status, status, shipping_method, remittance_last5, customer_name, archived_at";

export type AdminOrderListRow = {
  id: string;
  order_no: string;
  created_at: string;
  total: number;
  payment_method: string | null;
  payment_status: string;
  status: string;
  /** home／cvs／pickup／none（0005 CHECK）。 */
  shipping_method: string;
  remittance_last5: string | null;
  customer_name: string;
  /** 非 null＝已封存（0035）。列表預設濾掉，見 AdminOrderListFilter.includeArchived。 */
  archived_at: string | null;
};

/**
 * 這一頁不是報表，不需要無上限撈全表 —— 待對帳的匯款訂單天生是全表的極小子集
 * （0034 §2 的 orders_remittance_pending_idx 註解語），scope='all' 瀏覽用一樣夠。
 */
const LIST_LIMIT = 300;

/**
 * 後台訂單列表。
 *
 * scope='transfer_pending'（預設、這一頁存在的理由）：只回「匯款、還沒收到錢」的
 * 訂單，條件與 0034 §2 的 orders_remittance_pending_idx **逐字相同**
 * （payment_method = 'transfer' and payment_status <> 'paid'），查詢會吃到那個
 * partial index。
 *
 * scope='all'：不加上面那個條件，其餘（排序、上限）相同，給瀏覽全部訂單用。
 *
 * includeArchived 沒開時另外加 `archived_at is null`（0035），吃
 * orders_not_archived_idx——已封存的訂單是已付款訂單裡刻意被使用者從列表移掉的
 * 那一批，兩個 scope 都不該把它們找回來，除非明確打開這個開關。
 */
export async function listAdminOrders(filter: AdminOrderListFilter): Promise<AdminOrderListRow[]> {
  let query = supabaseAdmin().from("orders").select(LIST_COLUMNS);

  if (filter.scope === "transfer_pending") {
    query = query.eq("payment_method", "transfer").neq("payment_status", "paid");
  } else if (filter.scope === "to_ship") {
    // 待出貨：與 admin-todo.ts 的 toShip 計數、src/lib/admin/order-fulfillment.ts 的
    // canApply("ship") 同一組條件（TO_SHIP_FILTER）。
    query = query
      .eq("status", TO_SHIP_FILTER.status)
      .eq("payment_status", TO_SHIP_FILTER.payment_status)
      .not("paid_at", "is", null)
      .in("shipping_method", [...TO_SHIP_FILTER.shipping_methods]);
  }
  if (!filter.includeArchived) {
    query = query.is("archived_at", null);
  }

  const { data, error } = await query.order("created_at", { ascending: false }).limit(LIST_LIMIT);

  if (error) {
    // code + message，不印整包 error —— 同 event-registrations.ts 的理由：
    // PostgREST 會把 `DETAIL: Failing row contains (…)` 帶上來，那一列是客人的個資。
    console.error(`[repo/orders-admin] list 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/orders-admin] 訂單列表讀取失敗：${error.code}`);
  }
  return (data ?? []) as unknown as AdminOrderListRow[];
}

// ---------------------------------------------------------------------------
// 詳情
// ---------------------------------------------------------------------------

const ORDER_COLUMNS =
  "id, order_no, created_at, paid_at, shipped_at, completed_at, status, payment_status, payment_method, " +
  "subtotal, shipping_fee, discount, total, shipping_method, note, " +
  "remittance_last5, remittance_reported_at, customer_name, customer_email, customer_phone, archived_at, " +
  // 0040：推薦碼與當時的折扣%。
  "referral_code, referral_discount_percent";

/** 一次查完：訂單本身＋品項（含場次）＋收件資料＋發票資料。見檔頭「速度」。 */
const DETAIL_SELECT =
  ORDER_COLUMNS +
  ", order_items(id, name, unit_price, quantity, subtotal, product_type, session_id, event_sessions(title, starts_at))" +
  ", order_addresses(type, recipient, phone, postal_code, city, district, street, cvs_store_id, cvs_store_name, cvs_address, cvs_sub_type)" +
  ", invoices(invoice_type, tax_id, company_title, carrier_type, carrier_number, love_code)";

export type AdminOrderItemRow = {
  id: number;
  name: Localized;
  unit_price: number;
  quantity: number;
  subtotal: number;
  product_type: string;
  session_id: string | null;
  /** goods／book 是 null；event／journey 從 event_sessions 帶出來。 */
  session_title: Localized | null;
  session_starts_at: string | null;
};

export type AdminOrderAddress = {
  type: string;
  recipient: string;
  phone: string | null;
  postal_code: string | null;
  city: string | null;
  district: string | null;
  /** 街路門牌（宅配才有）。 */
  street: string | null;
  cvs_store_id: string | null;
  cvs_store_name: string | null;
  cvs_address: string | null;
  cvs_sub_type: string | null;
};

/** invoices 那一列（結帳時客人填的發票資料）。沒有那一列就是 null。 */
export type AdminOrderInvoice = {
  /** personal／company／donate（0005 CHECK）。 */
  invoice_type: string;
  /** 統一編號。 */
  tax_id: string | null;
  /** 發票抬頭。 */
  company_title: string | null;
  carrier_type: string | null;
  carrier_number: string | null;
  love_code: string | null;
};

export type AdminOrderDetail = {
  id: string;
  order_no: string;
  created_at: string;
  paid_at: string | null;
  /** 標記已出貨的時間。 */
  shipped_at: string | null;
  /** 標記已取貨／已完成的時間。 */
  completed_at: string | null;
  status: string;
  payment_status: string;
  payment_method: string | null;
  subtotal: number;
  shipping_fee: number;
  discount: number;
  total: number;
  shipping_method: string;
  remittance_last5: string | null;
  remittance_reported_at: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  /** 客人在結帳頁填的備註（orders.note）。 */
  note: string | null;
  items: AdminOrderItemRow[];
  addresses: AdminOrderAddress[];
  invoice: AdminOrderInvoice | null;
  /** 非 null＝已封存（0035）。 */
  archived_at: string | null;
  /** 推薦碼（0040）。null＝沒有推薦人。 */
  referral_code: string | null;
  referral_discount_percent: number | null;
};

/** PostgREST 對 to-one embed 可能回物件或單元素陣列，兩種都吃（同 customer-orders.ts）。 */
function firstOf<T>(v: T | T[] | null | undefined): T | null {
  if (v === null || v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function blankToNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

type ItemRawRow = {
  id: number;
  name: Localized;
  unit_price: number;
  quantity: number;
  subtotal: number;
  product_type: string;
  session_id: string | null;
  event_sessions:
    | { title: Localized; starts_at: string }
    | { title: Localized; starts_at: string }[]
    | null;
};

type AddrRawRow = {
  type: string;
  recipient: string;
  phone: string | null;
  postal_code: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
  cvs_store_id: string | null;
  cvs_store_name: string | null;
  cvs_address: string | null;
  cvs_sub_type: string | null;
};

type InvoiceRawRow = {
  invoice_type: string;
  tax_id: string | null;
  company_title: string | null;
  carrier_type: string | null;
  carrier_number: string | null;
  love_code: string | null;
};

type OrderDetailRawRow = {
  id: string;
  order_no: string;
  created_at: string;
  paid_at: string | null;
  shipped_at: string | null;
  completed_at: string | null;
  status: string;
  payment_status: string;
  payment_method: string | null;
  subtotal: number;
  shipping_fee: number;
  discount: number;
  total: number;
  shipping_method: string;
  note: string | null;
  remittance_last5: string | null;
  remittance_reported_at: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  archived_at: string | null;
  referral_code: string | null;
  referral_discount_percent: number | string | null;
  order_items: ItemRawRow[] | null;
  order_addresses: AddrRawRow[] | null;
  invoices: InvoiceRawRow | InvoiceRawRow[] | null;
};

/**
 * 一張訂單的詳情：品項（含場次）、金額拆解、收件資訊、聯絡資訊、發票資料——全部
 * 明文（見檔頭）。一次查詢（見檔頭「速度」）。
 *
 * 查無回 `null`（不是 throw）——呼叫端（fns/orders.ts）已經過 adminFnMiddleware，
 * 「這個 id 存不存在」是正常會發生的畫面狀態，不是授權問題。
 */
export async function getAdminOrderDetail(orderId: string): Promise<AdminOrderDetail | null> {
  if (!orderId) return null;

  const { data, error } = await supabaseAdmin()
    .from("orders")
    .select(DETAIL_SELECT)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error(`[repo/orders-admin] detail 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/orders-admin] 訂單讀取失敗：${error.code}`);
  }
  if (!data) return null;
  const o = data as unknown as OrderDetailRawRow;

  const items: AdminOrderItemRow[] = [...(o.order_items ?? [])]
    .sort((a, b) => a.id - b.id)
    .map((r) => {
      const session = firstOf(r.event_sessions);
      return {
        id: r.id,
        name: r.name,
        unit_price: r.unit_price,
        quantity: r.quantity,
        subtotal: r.subtotal,
        product_type: r.product_type,
        session_id: r.session_id,
        session_title: session?.title ?? null,
        session_starts_at: session?.starts_at ?? null,
      };
    });

  const addresses: AdminOrderAddress[] = (o.order_addresses ?? []).map((r) => ({
    type: r.type,
    recipient: r.recipient,
    phone: blankToNull(r.phone),
    postal_code: r.postal_code,
    city: r.city,
    district: r.district,
    street: blankToNull(r.street),
    cvs_store_id: blankToNull(r.cvs_store_id),
    cvs_store_name: r.cvs_store_name,
    cvs_address: r.cvs_address,
    cvs_sub_type: r.cvs_sub_type,
  }));

  const inv = firstOf(o.invoices);
  const invoice: AdminOrderInvoice | null = inv
    ? {
        invoice_type: inv.invoice_type,
        tax_id: blankToNull(inv.tax_id),
        company_title: blankToNull(inv.company_title),
        carrier_type: blankToNull(inv.carrier_type),
        carrier_number: blankToNull(inv.carrier_number),
        love_code: blankToNull(inv.love_code),
      }
    : null;

  return {
    archived_at: o.archived_at,
    id: o.id,
    order_no: o.order_no,
    created_at: o.created_at,
    paid_at: o.paid_at,
    shipped_at: o.shipped_at,
    completed_at: o.completed_at,
    status: o.status,
    payment_status: o.payment_status,
    payment_method: o.payment_method,
    subtotal: o.subtotal,
    shipping_fee: o.shipping_fee,
    discount: o.discount,
    total: o.total,
    shipping_method: o.shipping_method,
    remittance_last5: o.remittance_last5,
    remittance_reported_at: o.remittance_reported_at,
    customer_name: o.customer_name,
    customer_email: blankToNull(o.customer_email),
    customer_phone: blankToNull(o.customer_phone),
    note: blankToNull(o.note),
    items,
    addresses,
    invoice,
    referral_code: o.referral_code ?? null,
    referral_discount_percent:
      o.referral_discount_percent === null || o.referral_discount_percent === undefined
        ? null
        : Number(o.referral_discount_percent),
  };
}

// ---------------------------------------------------------------------------
// 標記已收款
// ---------------------------------------------------------------------------

export type MarkOrderPaidReason =
  | "marked"
  | "already_paid"
  | "order_not_pending"
  | "order_not_found";

export type MarkOrderPaidOutcome = {
  marked: boolean;
  reason: MarkOrderPaidReason;
  order_no: string | null;
};

/**
 * 呼叫 public.admin_mark_order_paid(p_order_id, p_actor_id, p_note)（0034 §5）。
 * 保留原本的 payment_method —— 見檔頭「不要改叫 markOrderPaid()」那一段。
 *
 * RPC 是 `returns table`，PostgREST 一律包成陣列 —— 即使只有一列。單例讀法同
 * src/server/repos/orders.ts 呼叫 settle_free_order() 的寫法
 * （`Array.isArray(data) ? data[0] : data`），不是這個檔案發明的新慣例。
 */
export async function markOrderPaidByAdmin(input: {
  orderId: string;
  actorId: string;
  note: string | null;
}): Promise<MarkOrderPaidOutcome> {
  const { data, error } = await supabaseAdmin().rpc("admin_mark_order_paid", {
    p_order_id: input.orderId,
    p_actor_id: input.actorId,
    p_note: input.note,
  });

  if (error) {
    console.error(`[repo/orders-admin] mark paid 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/orders-admin] 標記已收款失敗：${error.code}`);
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { marked?: boolean; reason?: string; order_no?: string | null }
    | undefined;

  if (!row || !row.reason) {
    throw new Error("[repo/orders-admin] 標記已收款沒有回傳結果");
  }

  return {
    marked: row.marked === true,
    reason: row.reason as MarkOrderPaidReason,
    order_no: row.order_no ?? null,
  };
}

// ---------------------------------------------------------------------------
// 刪除（0035）
// ---------------------------------------------------------------------------

export type DeleteOrderReason =
  | "deleted"
  | "order_not_found"
  | "order_is_paid"
  | "has_inventory_sale";

export type DeleteOrderOutcome = {
  deleted: boolean;
  reason: DeleteOrderReason;
  order_no: string | null;
};

/**
 * 呼叫 public.admin_delete_order(p_order_id, p_actor_id)（0035 §3）。
 *
 * 未付款／已取消的訂單才刪得掉——已付款回 order_is_paid、已經進了 inv.sales 回
 * has_inventory_sale，兩種都不是這裡判斷的，資料庫那一支已經鎖著訂單列做完了。
 * 這裡只是把參數包起來、把 `returns table` 的單例陣列拆開，同
 * markOrderPaidByAdmin() 的形狀。
 */
export async function deleteAdminOrder(input: {
  orderId: string;
  actorId: string;
}): Promise<DeleteOrderOutcome> {
  const { data, error } = await supabaseAdmin().rpc("admin_delete_order", {
    p_order_id: input.orderId,
    p_actor_id: input.actorId,
  });

  if (error) {
    console.error(`[repo/orders-admin] delete 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/orders-admin] 刪除訂單失敗：${error.code}`);
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { deleted?: boolean; reason?: string; order_no?: string | null }
    | undefined;

  if (!row || !row.reason) {
    throw new Error("[repo/orders-admin] 刪除訂單沒有回傳結果");
  }

  return {
    deleted: row.deleted === true,
    reason: row.reason as DeleteOrderReason,
    order_no: row.order_no ?? null,
  };
}

// ---------------------------------------------------------------------------
// 封存（0035）
// ---------------------------------------------------------------------------

export type ArchiveOrderReason = "archived" | "unarchived" | "order_not_found";

export type ArchiveOrderOutcome = {
  updated: boolean;
  reason: ArchiveOrderReason;
  order_no: string | null;
};

/**
 * 呼叫 public.admin_archive_order(p_order_id, p_actor_id, p_archived)（0035 §4）。
 *
 * 已付款訂單唯一的「從列表移掉」路徑——不動名額、不動任何紀錄，隨時可以再呼叫一次
 * （archived=false）復原。任何存在的訂單都能封存／取消封存，不像 deleteAdminOrder()
 * 有 payment_status 的限制。
 */
export async function archiveAdminOrder(input: {
  orderId: string;
  actorId: string;
  archived: boolean;
}): Promise<ArchiveOrderOutcome> {
  const { data, error } = await supabaseAdmin().rpc("admin_archive_order", {
    p_order_id: input.orderId,
    p_actor_id: input.actorId,
    p_archived: input.archived,
  });

  if (error) {
    console.error(`[repo/orders-admin] archive 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/orders-admin] 封存訂單失敗：${error.code}`);
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { updated?: boolean; reason?: string; order_no?: string | null }
    | undefined;

  if (!row || !row.reason) {
    throw new Error("[repo/orders-admin] 封存訂單沒有回傳結果");
  }

  return {
    updated: row.updated === true,
    reason: row.reason as ArchiveOrderReason,
    order_no: row.order_no ?? null,
  };
}
