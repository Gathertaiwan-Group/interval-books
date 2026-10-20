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
 * ── 🔴 個資：這裡是遮罩版，不是明文版 ──────────────────────────────────────
 * 0021 §0.1／§3 對報名名單的姿態是「遮罩做在 SQL（inv.mask_email／inv.mask_tail），
 * 明文只有一個會先寫 pii_access_log 才組值的出口（reveal_registration_contact）」。
 * 這個檔案**做不到同一個姿態**，理由是兩個既有的、與這一期無關的資料庫事實：
 *
 *   1. inv schema 沒有進 PostgREST 的 db_schema（0021 §2 檔頭）。這個專案的任何
 *      server fn 都呼叫不到 inv.mask_email／inv.mask_tail —— 那兩支是給**其他 SQL
 *      函式**呼叫的，不是給 PostgREST／supabase-js 呼叫的。要在 SQL 那一層遮
 *      orders 的聯絡方式，需要一支新的 public.admin_orders_* view（比照 0021 §3
 *      的 admin_event_roster），把遮罩留在資料庫裡。
 *   2. public.pii_access_log 對**所有** role 都是零權限，包含 service_role
 *      （0019 §1.3：「連 service_role 都不給。寫走 §1.4，讀走 §1.5」）。寫入唯一
 *      的路是 security definer 的 public.pii_log_access()，而它的
 *      subject_table／reason 兩欄各自是白名單 CHECK（0019 §1.2、0021 §1 加了
 *      'public.event_registrations' 與 'public.event_sessions' 兩個值）。目前的
 *      值域裡**沒有** 'public.orders'。要讓「查閱聯絡方式」在留下稽核紀錄，需要
 *      一支新 migration：放寬那兩條 CHECK，並比照 0021 §5
 *      reveal_registration_contact() 的形狀新增一支 security definer 函式。
 *
 * 這一期任務書明講「不需要新的 migration」，並要求「範圍過大就先做遮罩版、明文
 * 一律不給」——上面兩點正是判斷「範圍過大」的具體理由，所以這個檔案選擇：
 *
 *   customer_email / customer_phone / order_addresses.phone 一路到瀏覽器只有
 *   src/lib/admin/pii-mask.ts 算出來的遮罩值；order_addresses.street（門牌）
 *   完全不查詢、不回傳；**沒有「顯示完整聯絡方式」這顆按鈕**，因為結構上沒有一個
 *   會留下稽核紀錄的出口可以接。
 *
 * 姓名（customer_name／order_addresses.recipient）不遮罩 —— 與 0021 對報名者姓名
 * 的處置同一個理由：核對匯款需要看得出「這是不是銀行對帳單上那個人」，遮了就對不
 * 了帳，而姓名單獨一項的識別風險遠低於信箱／電話。
 *
 * 街路門牌完全不回傳（不是遮罩後回傳）：這一頁的任務是核對匯款有沒有入帳，不是
 * 出貨；縣市／區與收件方式（宅配／超商／自取）已經足夠核對用，門牌號碼是這一頁不
 * 需要、但客人最容易被拿去對照現實身分的欄位，寧可少給。
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
import { maskEmail, maskTail } from "@/lib/admin/pii-mask";
import type { Localized } from "@/i18n/types";

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

export type AdminOrderListScope = "transfer_pending" | "all";

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
 * 列表欄位。**沒有 customer_email／customer_phone，也沒有 order_addresses 任何
 * 一欄** —— 這一頁的列表只需要訂單編號＋金額＋末五碼＋姓名就能核對匯款，刻意不多
 * 要（同 src/server/repos/customer-orders.ts 檔頭「先給最小集合，要用的時候再加」
 * 的理由）。scripts/admin-orders-selftest.mjs 有靜態測試守著這一條：這個字串裡
 * 不准出現 'email' 或 'phone'，也不准查詢 order_addresses。
 */
const LIST_COLUMNS =
  "id, order_no, created_at, total, payment_method, payment_status, status, remittance_last5, customer_name, archived_at";

export type AdminOrderListRow = {
  id: string;
  order_no: string;
  created_at: string;
  total: number;
  payment_method: string | null;
  payment_status: string;
  status: string;
  remittance_last5: string | null;
  /** 全名，不遮罩 —— 見檔頭。 */
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

const DETAIL_COLUMNS =
  "id, order_no, created_at, paid_at, status, payment_status, payment_method, " +
  "subtotal, shipping_fee, discount, total, shipping_method, " +
  "remittance_last5, remittance_reported_at, customer_name, customer_email, customer_phone, archived_at, " +
  // 0040：推薦碼與當時的折扣%。⚠️ 這兩欄要等 0040 套上正式庫之後才存在。
  "referral_code, referral_discount_percent";

type OrderDetailRawRow = {
  id: string;
  order_no: string;
  created_at: string;
  paid_at: string | null;
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
  archived_at: string | null;
  referral_code: string | null;
  referral_discount_percent: number | string | null;
  /** 明文。只在這個函式內部活過 —— 回傳前一定被 maskEmail() 換掉，見下方。 */
  customer_email: string;
  /** 明文。理由同上，回傳前被 maskTail() 換掉。 */
  customer_phone: string;
};

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
  /** 全名，不遮罩 —— 見檔頭。 */
  recipient: string;
  /** 遮罩，見檔頭。 */
  phone_masked: string | null;
  postal_code: string | null;
  city: string | null;
  district: string | null;
  /** ⚠️ 沒有 street：門牌完全不查詢、不回傳，見檔頭。 */
  cvs_store_name: string | null;
  /** 超商本身的營業地址（公開資訊，不是客人的個資），原樣回傳。 */
  cvs_address: string | null;
  cvs_sub_type: string | null;
};

export type AdminOrderDetail = {
  id: string;
  order_no: string;
  created_at: string;
  paid_at: string | null;
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
  /** 全名，不遮罩 —— 見檔頭。 */
  customer_name: string;
  customer_email_masked: string | null;
  customer_phone_masked: string | null;
  items: AdminOrderItemRow[];
  addresses: AdminOrderAddress[];
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

/**
 * 一張訂單的詳情：品項（含場次）、金額拆解、收件資訊（遮罩）、聯絡資訊（遮罩）。
 *
 * 查無回 `null`（不是 throw）——呼叫端（fns/orders.ts）已經過 adminFnMiddleware，
 * 「這個 id 存不存在」是正常會發生的畫面狀態，不是授權問題，不需要比照
 * customer-orders.ts 那種「查無與不是你的回同一個 null」的防列舉考量（後台沒有
 * 「這是不是我的」這個問題）。
 */
export async function getAdminOrderDetail(orderId: string): Promise<AdminOrderDetail | null> {
  if (!orderId) return null;
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("orders")
    .select(DETAIL_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    console.error(`[repo/orders-admin] detail 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/orders-admin] 訂單讀取失敗：${error.code}`);
  }
  if (!data) return null;
  const o = data as unknown as OrderDetailRawRow;

  const { data: itemRows, error: itemError } = await db
    .from("order_items")
    .select(
      "id, name, unit_price, quantity, subtotal, product_type, session_id, event_sessions(title, starts_at)",
    )
    .eq("order_id", orderId)
    .order("id", { ascending: true });

  if (itemError) {
    console.error(`[repo/orders-admin] items 失敗：${itemError.code} ${itemError.message}`);
    throw new Error(`[repo/orders-admin] 訂單品項讀取失敗：${itemError.code}`);
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

  const items: AdminOrderItemRow[] = ((itemRows ?? []) as unknown as ItemRawRow[]).map((r) => {
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

  // ⚠️ 沒有 street：門牌完全不查詢，見檔頭。cvs_store_id 也不查 —— 那是給 ECPay
  // 用的內部代碼，這一頁沒有用途。
  const { data: addrRows, error: addrError } = await db
    .from("order_addresses")
    .select(
      "type, recipient, phone, postal_code, city, district, cvs_store_name, cvs_address, cvs_sub_type",
    )
    .eq("order_id", orderId);

  if (addrError) {
    console.error(`[repo/orders-admin] addresses 失敗：${addrError.code} ${addrError.message}`);
    throw new Error(`[repo/orders-admin] 收件資訊讀取失敗：${addrError.code}`);
  }

  type AddrRawRow = {
    type: string;
    recipient: string;
    phone: string;
    postal_code: string | null;
    city: string | null;
    district: string | null;
    cvs_store_name: string | null;
    cvs_address: string | null;
    cvs_sub_type: string | null;
  };

  const addresses: AdminOrderAddress[] = ((addrRows ?? []) as unknown as AddrRawRow[]).map((r) => ({
    type: r.type,
    recipient: r.recipient,
    phone_masked: maskTail(r.phone, 4),
    postal_code: r.postal_code,
    city: r.city,
    district: r.district,
    cvs_store_name: r.cvs_store_name,
    cvs_address: r.cvs_address,
    cvs_sub_type: r.cvs_sub_type,
  }));

  return {
    archived_at: o.archived_at,
    id: o.id,
    order_no: o.order_no,
    created_at: o.created_at,
    paid_at: o.paid_at,
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
    customer_email_masked: maskEmail(o.customer_email),
    customer_phone_masked: maskTail(o.customer_phone, 4),
    items,
    addresses,
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
