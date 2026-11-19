/**
 * 套餐（combo sets）—— 這一頁**所有**資料庫存取的唯一出口。
 *
 * ── 這一層存在的理由（與 repos/inv-products.ts 同一條）────────────────────
 * inv 不在 PostgREST 的 db_schema 裡（0009 §0：inv.vendors 有身分證字號與銀行
 * 帳戶）。所以連 service_role 的 supabase-js client 都**打不到** inv.* —— 那些表
 * 根本沒被掛出來。要讀就走 0018 的三個 view，要寫就呼叫 SECURITY DEFINER 函式。
 *
 * ── 錯誤一律 throw，不吞 ──────────────────────────────────────────────────
 * 沒有任何一個 catch 會把錯誤變成空陣列或 null。
 *
 * ── 這裡沒有「賣一份套餐」的組裝邏輯 ──────────────────────────────────────
 * 分攤、鎖序、扣庫存全部在 inv_combo_checkout() 裡。這一層只是把參數轉過去 ——
 * 在這裡先查一次庫存再送出，中間就有一個網站訂單可以插進來的窗口（與
 * inv-sales.ts#posCheckout 同一條理由）。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";

/** 0018 的 inv_admin_combo_sets。 */
export type AdminComboSetRow = {
  combo_set_id: string;
  name: string;
  selling_price: number;
  is_active: boolean;
  notes: string | null;
  approval_status: string;
  approved_at: string | null;
  approved_by_name: string | null;
  user_id: string;
  creator_name: string | null;
  created_at: string;
  updated_at: string;
  item_count: number;
  total_list_price: number;
  /** 'list_price' = 依定價比例分攤；'quantity' = 有品項沒定價，整組按數量均分。 */
  allocation_basis: "list_price" | "quantity" | null;
  zero_priced_items: number;
  max_sets: number | null;
  sold_sets: number;
  sold_revenue: number;
  /**
   * 0062：組成品項裡有幾件是不限庫存。不限庫存的品項不參與 max_sets 的最小值；全部都不限時
   * max_sets＝100（inv_combo_checkout 單次上限）。
   */
  unlimited_items: number;
};

export type AdminComboItemRow = {
  item_id: string;
  combo_set_id: string;
  product_id: string;
  quantity: number;
  product_name: string;
  issue_number: string | null;
  series: string | null;
  product_type: string;
  selling_price: number;
  product_active: boolean;
  base_product_id: string | null;
  pack_size: number;
  stock_quantity: number;
  /** 0062：庫存目標（母品項或自己）是不限庫存。 */
  unlimited_stock: boolean;
};

export type AdminComboSaleRow = {
  sale_group: string;
  combo_set_id: string;
  combo_name: string;
  sale_date: string;
  created_at: string;
  row_count: number;
  revenue: number;
  cost: number;
  gross_profit: number;
  user_id: string;
  operator_name: string | null;
  payment_method_name: string | null;
};

const SET_COLUMNS =
  "combo_set_id, name, selling_price, is_active, notes, approval_status, approved_at, " +
  "approved_by_name, user_id, creator_name, created_at, updated_at, item_count, " +
  "total_list_price, allocation_basis, zero_priced_items, max_sets, sold_sets, sold_revenue, " +
  "unlimited_items";

const ITEM_COLUMNS =
  "item_id, combo_set_id, product_id, quantity, product_name, issue_number, series, " +
  "product_type, selling_price, product_active, base_product_id, pack_size, stock_quantity, " +
  "unlimited_stock";

const SALE_COLUMNS =
  "sale_group, combo_set_id, combo_name, sale_date, created_at, row_count, revenue, cost, " +
  "gross_profit, user_id, operator_name, payment_method_name";

export type ComboFilter = {
  keyword: string | null;
  activeStatus: "all" | "active" | "inactive";
  approvalStatus: "all" | "pending" | "approved" | "rejected";
  sort: "name_asc" | "name_desc" | "created_desc" | "sold_desc" | "price_desc";
};

const SORTS: Record<ComboFilter["sort"], { column: string; ascending: boolean }> = {
  name_asc: { column: "name", ascending: true },
  name_desc: { column: "name", ascending: false },
  created_desc: { column: "created_at", ascending: false },
  sold_desc: { column: "sold_sets", ascending: false },
  price_desc: { column: "selling_price", ascending: false },
};

/**
 * 套餐清單。
 *
 * 沒有分頁：正式庫 6 個，這輩子也不會變成 600 個（套餐是人手工排的菜單）。
 * limit 500 是防呆不是分頁 —— 真的爆到 500 就該回來加分頁，而不是靜默截斷。
 */
export async function listAdminComboSets(filter: ComboFilter): Promise<AdminComboSetRow[]> {
  const sort = SORTS[filter.sort] ?? SORTS.name_asc;

  let query = supabaseAdmin()
    .from("inv_admin_combo_sets")
    .select(SET_COLUMNS)
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    // 第二排序鍵：沒有它的話同名／同銷量的列順序是不確定的（與 inv-products.ts
    // 補 inv_product_id 是同一個理由）。
    .order("combo_set_id", { ascending: true })
    .limit(500);

  if (filter.activeStatus !== "all")
    query = query.eq("is_active", filter.activeStatus === "active");
  if (filter.approvalStatus !== "all") query = query.eq("approval_status", filter.approvalStatus);
  if (filter.keyword) {
    const safe = filter.keyword.replace(/[(),]/g, " ").trim();
    if (safe) query = query.or(`name.ilike.%${safe}%,notes.ilike.%${safe}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`[repo/inv-combos] 套餐清單讀取失敗：${error.message}`);
  return (data ?? []) as unknown as AdminComboSetRow[];
}

export async function getAdminComboSet(id: string): Promise<AdminComboSetRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_combo_sets")
    .select(SET_COLUMNS)
    .eq("combo_set_id", id)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[repo/inv-combos] 套餐讀取失敗：${error.message}`);
  return (data as unknown as AdminComboSetRow | null) ?? null;
}

/** 一個套餐的組成品項。依 product_id 排序 —— 與 inv_combo_checkout() 的分攤順序同一把尺。 */
export async function listComboItems(comboSetId: string): Promise<AdminComboItemRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_combo_set_items")
    .select(ITEM_COLUMNS)
    .eq("combo_set_id", comboSetId)
    .order("product_id", { ascending: true });

  if (error) throw new Error(`[repo/inv-combos] 組成品項讀取失敗：${error.message}`);
  return (data ?? []) as unknown as AdminComboItemRow[];
}

/** 全部套餐的組成品項，一次撈完。清單頁要顯示每個套餐的內容，逐個查會是 N+1。 */
export async function listAllComboItems(): Promise<AdminComboItemRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_combo_set_items")
    .select(ITEM_COLUMNS)
    .order("combo_set_id", { ascending: true })
    .order("product_id", { ascending: true })
    .limit(5000);

  if (error) throw new Error(`[repo/inv-combos] 組成品項讀取失敗：${error.message}`);
  return (data ?? []) as unknown as AdminComboItemRow[];
}

/**
 * 套餐銷售明細，一個 combo_sale_group 一列。
 *
 * ⚠️ 這個 view 的加總跨越了兩種分攤口徑：2026-08 之前是來源的「第一件吃全額」，
 *    之後是 0018 的比例分攤。**group 層級的合計兩者相同**，所以這張表可以直接
 *    加總；會不一樣的是逐品項的營收歸屬（那要等 Phase 6 的報表）。
 */
export async function listComboSales(input: {
  comboSetId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  limit: number;
}): Promise<AdminComboSaleRow[]> {
  let query = supabaseAdmin()
    .from("inv_admin_combo_sales")
    .select(SALE_COLUMNS)
    .order("sale_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(input.limit);

  if (input.comboSetId) query = query.eq("combo_set_id", input.comboSetId);
  if (input.dateFrom) query = query.gte("sale_date", input.dateFrom);
  if (input.dateTo) query = query.lte("sale_date", input.dateTo);

  const { data, error } = await query;
  if (error) throw new Error(`[repo/inv-combos] 套餐銷售讀取失敗：${error.message}`);
  return (data ?? []) as unknown as AdminComboSaleRow[];
}

// ---------------------------------------------------------------------------
// 寫入 —— 全部走 0018 的 SECURITY DEFINER 函式
// ---------------------------------------------------------------------------

/** 把 PL/pgSQL 的 `PREFIX: 中文訊息` 剝成給店員看的那一句（與 inv-products.ts 同一支）。 */
function speak(message: string, fallback: string): string {
  return message.replace(/^[A-Z_]+:\s*/, "").trim() || fallback;
}

export async function saveComboSet(input: {
  userId: string;
  id: string | null;
  payload: Record<string, unknown>;
  items: { product_id: string; quantity: number }[];
}): Promise<{ id: string; created: boolean; approval_status: string; item_count: number }> {
  const { data, error } = await supabaseAdmin().rpc("inv_save_combo_set", {
    p_user_id: input.userId,
    p_id: input.id,
    p_payload: input.payload,
    p_items: input.items,
  });

  if (error) throw new Error(speak(error.message, "套餐儲存失敗，請再試一次"));
  return data as { id: string; created: boolean; approval_status: string; item_count: number };
}

export async function setComboSetActive(input: {
  id: string;
  isActive: boolean;
}): Promise<{ id: string; name: string; is_active: boolean }> {
  const { data, error } = await supabaseAdmin().rpc("inv_set_combo_set_active", {
    p_id: input.id,
    p_is_active: input.isActive,
  });

  if (error) throw new Error(speak(error.message, "上下架失敗，請再試一次"));
  return data as { id: string; name: string; is_active: boolean };
}

export async function deleteComboSet(id: string): Promise<{ id: string; name: string }> {
  const { data, error } = await supabaseAdmin().rpc("inv_delete_combo_set", { p_id: id });
  if (error) throw new Error(speak(error.message, "刪除失敗，請再試一次"));
  return data as { id: string; name: string };
}

export async function resubmitComboSet(id: string): Promise<{ id: string; name: string }> {
  const { data, error } = await supabaseAdmin().rpc("inv_resubmit_combo_set", { p_id: id });
  if (error) throw new Error(speak(error.message, "重新送審失敗，請再試一次"));
  return data as { id: string; name: string };
}

export type ComboCheckoutResult = {
  combo_set_id: string;
  combo_name: string;
  sets: number;
  sale_ids: string[];
  sale_groups: string[];
  total_amount: number;
  total_cost: number;
  basis: "list_price" | "quantity";
  allocation: { product_id: string; quantity: number; amount: number }[];
};

/**
 * 賣一份（或幾份）套餐。
 *
 * ⚠️ 這裡**不做**任何庫存判斷、不算金額。兩件事都在資料庫裡，因為只有那裡拿得到
 *    列鎖 —— 見 0018 §問題二。來源是在瀏覽器裡跑三層迴圈、每件商品兩次 HTTP。
 */
export async function comboCheckout(input: {
  userId: string;
  comboSetId: string;
  quantity: number;
  saleDate: string;
  paymentMethodId: string | null;
  notes: string | null;
  overrideReservation: boolean;
}): Promise<ComboCheckoutResult> {
  const { data, error } = await supabaseAdmin().rpc("inv_combo_checkout", {
    p_user_id: input.userId,
    p_combo_set_id: input.comboSetId,
    p_quantity: input.quantity,
    p_sale_date: input.saleDate,
    p_payment_method_id: input.paymentMethodId,
    p_notes: input.notes,
    p_override_reservation: input.overrideReservation,
  });

  if (error) {
    // INSUFFICIENT_STOCK 是 trigger 丟的，訊息裡只有 uuid；其餘是
    // inv_combo_checkout 自己丟的中文句子。
    if (error.message.includes("INSUFFICIENT_STOCK")) {
      throw new Error("組成品項的庫存不足，無法賣出這份套餐");
    }
    throw new Error(speak(error.message, "套餐結帳失敗，請再試一次"));
  }

  return data as unknown as ComboCheckoutResult;
}

export type SecondhandCheckoutResult = {
  sale_id: string;
  item_name: string;
  quantity: number;
  amount: number;
};

/**
 * 二手書入帳。
 *
 * ⚠️ 二手書不進 inv.products —— 一本一件、沒有批次、沒有庫存。所以這一支動不到
 *    任何庫存數字，那是刻意的，不是漏掉。見 0018 §問題三。
 */
export async function secondhandCheckout(input: {
  userId: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  saleDate: string;
  paymentMethodId: string | null;
  notes: string | null;
}): Promise<SecondhandCheckoutResult> {
  const { data, error } = await supabaseAdmin().rpc("inv_secondhand_checkout", {
    p_user_id: input.userId,
    p_item_name: input.itemName,
    p_quantity: input.quantity,
    p_unit_price: input.unitPrice,
    p_sale_date: input.saleDate,
    p_payment_method_id: input.paymentMethodId,
    p_notes: input.notes,
  });

  if (error) throw new Error(speak(error.message, "二手書入帳失敗，請再試一次"));
  return data as unknown as SecondhandCheckoutResult;
}
