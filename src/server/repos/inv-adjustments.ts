/**
 * 在庫異動與庫存盤點 —— 這兩頁**所有**資料庫存取的唯一出口。
 *
 * ── 一張表，不是兩張 ──────────────────────────────────────────────────────
 * 「盤點」與「在庫異動」在畫面上是兩頁，在資料庫是**同一張 inv.stock_adjustments**，
 * 靠 category 區分（盤點固定 'ADJ'）。0009 一起搬進來的 inv.inventory_adjustments
 * 是已凍結的舊表（30 筆，最後一筆 2026-03-02），這一層**一個字都不寫進去**。
 * 完整理由在 0017 的檔頭；一句話版本：兩張都寫等於同一次盤點扣兩次庫存。
 *
 * 那 30 筆歷史還看得到 —— 走 listProductMovements()，它讀的是把兩張表 union
 * 起來的 inv_admin_product_movements。
 *
 * ── status 這一層決定不了 ─────────────────────────────────────────────────
 * 要不要進待審是 inv.stock_adjustment_initial_status() 在資料庫算的。來源的兩支
 * 盤點對話框把它硬寫成 'confirmed'，所以審核開關對盤點完全無效。這裡連一個
 * status 參數都沒有。
 *
 * ── 庫存這一層也不動 ──────────────────────────────────────────────────────
 * stock_quantity 只由 trigger 加減（0009 的兩支 + 0017 改寫的那支）。這個檔案裡
 * 沒有一行 UPDATE inv.products。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import { readAllPages } from "@/server/repos/read-all-pages";
import { isLowStock } from "@/lib/admin/low-stock";

/** 0017 的 inv_admin_stock_adjustments。 */
export type AdminAdjustmentRow = {
  adjustment_id: string;
  adjustment_number: string | null;
  product_id: string;
  product_name: string | null;
  issue_number: string | null;
  series: string | null;
  product_stock_quantity: number | null;
  category_id: string | null;
  category_name: string | null;
  adjustment_date: string;
  category: string;
  quantity: number;
  unit_cost: number | null;
  total_cost: number | null;
  status: string;
  reason: string | null;
  notes: string | null;
  stock_before: number | null;
  reversal_of: string | null;
  /** 已經 join 成單號。來源的詳情頁直接印 UUID，店員看到一串亂碼。 */
  reversal_of_number: string | null;
  reversed_by_id: string | null;
  reversed_by_number: string | null;
  approved_at: string | null;
  approved_by_name: string | null;
  user_id: string;
  creator_name: string | null;
  created_at: string;
};

/** 0017 的 inv_admin_product_movements —— 兩張表 union，商品詳細頁用。 */
export type ProductMovementRow = {
  source: "stock_adjustment" | "inventory_adjustment";
  movement_id: string;
  product_id: string;
  document_number: string | null;
  movement_date: string;
  code: string;
  quantity: number;
  status: string;
  reason: string | null;
  notes: string | null;
  unit_cost: number | null;
  total_cost: number | null;
  stock_before: number | null;
  created_at: string;
  creator_name: string | null;
};

export type AdjustmentFilter = {
  keyword: string | null;
  category: "EXP" | "PR" | "SMP" | "INT" | "ADJ" | "CMB" | null;
  status: "all" | "draft" | "pending_approval" | "confirmed" | "rejected";
  productId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  sort: "date_desc" | "date_asc" | "created_at" | "quantity_desc";
  page: number;
  pageSize: number;
};

const COLUMNS =
  "adjustment_id, adjustment_number, product_id, product_name, issue_number, series, " +
  "product_stock_quantity, category_id, category_name, adjustment_date, category, quantity, " +
  "unit_cost, total_cost, status, reason, notes, stock_before, reversal_of, reversal_of_number, " +
  "reversed_by_id, reversed_by_number, approved_at, approved_by_name, user_id, creator_name, created_at";

const SORTS: Record<AdjustmentFilter["sort"], { column: string; ascending: boolean }> = {
  date_desc: { column: "adjustment_date", ascending: false },
  date_asc: { column: "adjustment_date", ascending: true },
  created_at: { column: "created_at", ascending: false },
  quantity_desc: { column: "quantity", ascending: false },
};

export async function listAdminAdjustments(
  filter: AdjustmentFilter,
): Promise<{ rows: AdminAdjustmentRow[]; total: number }> {
  const from = filter.page * filter.pageSize;
  const sort = SORTS[filter.sort] ?? SORTS.date_desc;

  let query = supabaseAdmin()
    .from("inv_admin_stock_adjustments")
    .select(COLUMNS, { count: "exact" })
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    // 第二排序鍵。同一天的異動單在翻頁之間順序要是穩定的。
    .order("adjustment_id", { ascending: true })
    .range(from, from + filter.pageSize - 1);

  if (filter.category) query = query.eq("category", filter.category);
  if (filter.status !== "all") query = query.eq("status", filter.status);
  if (filter.productId) query = query.eq("product_id", filter.productId);
  if (filter.dateFrom) query = query.gte("adjustment_date", filter.dateFrom);
  if (filter.dateTo) query = query.lte("adjustment_date", filter.dateTo);

  if (filter.keyword) {
    const safe = filter.keyword.replace(/[(),]/g, " ").trim();
    if (safe) {
      query = query.or(
        `adjustment_number.ilike.%${safe}%,product_name.ilike.%${safe}%,` +
          `issue_number.ilike.%${safe}%,notes.ilike.%${safe}%`,
      );
    }
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`[repo/inv-adjustments] 異動清單讀取失敗：${error.message}`);
  return { rows: (data ?? []) as unknown as AdminAdjustmentRow[], total: count ?? 0 };
}

export async function getAdminAdjustment(id: string): Promise<AdminAdjustmentRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_stock_adjustments")
    .select(COLUMNS)
    .eq("adjustment_id", id)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[repo/inv-adjustments] 異動單讀取失敗：${error.message}`);
  return (data as unknown as AdminAdjustmentRow | null) ?? null;
}

/**
 * 六類的統計。
 *
 * ⚠️ 只算 confirmed —— 草稿與待審的還沒生效，把它們算進「這個月報廢了多少錢」
 *    會讓數字比實際大。來源也是這個語意。
 * ⚠️ 統計的範圍是**篩選的日期區間**，不是「最近 100 筆」。來源的盤點頁把
 *    `.limit(100)` 的結果拿來當統計分母，資料一多數字就開始說謊。
 */
export async function getAdjustmentSummary(filter: {
  dateFrom: string | null;
  dateTo: string | null;
}): Promise<Record<string, { count: number; quantity: number; cost: number }>> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_stock_adjustments")
    .select("category, quantity, total_cost")
    .eq("status", "confirmed")
    .gte("adjustment_date", filter.dateFrom ?? "1900-01-01")
    .lte("adjustment_date", filter.dateTo ?? "2999-12-31")
    .limit(20000);

  if (error) throw new Error(`[repo/inv-adjustments] 異動統計讀取失敗：${error.message}`);

  const out: Record<string, { count: number; quantity: number; cost: number }> = {};
  for (const row of (data ?? []) as {
    category: string;
    quantity: number;
    total_cost: number | null;
  }[]) {
    const bucket = (out[row.category] ??= { count: 0, quantity: 0, cost: 0 });
    bucket.count += 1;
    bucket.quantity += Math.abs(row.quantity ?? 0);
    bucket.cost += Number(row.total_cost ?? 0);
  }
  return out;
}

/**
 * 一件商品的異動紀錄 —— **這就是「剛做完的盤點在商品詳細頁看不到」的修法**。
 *
 * 讀的是 union view，所以現役的 stock_adjustments 與凍結的 inventory_adjustments
 * 都在裡面。來源的 ProductDetailDialog 只讀舊表，於是 2026-03 之後做的每一次盤點
 * 在商品詳細頁都是空的。
 */
export async function listProductMovements(
  productId: string,
  limit = 50,
): Promise<ProductMovementRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_product_movements")
    .select(
      "source, movement_id, product_id, document_number, movement_date, code, quantity, " +
        "status, reason, notes, unit_cost, total_cost, stock_before, created_at, creator_name",
    )
    .eq("product_id", productId)
    .order("movement_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`[repo/inv-adjustments] 異動紀錄讀取失敗：${error.message}`);
  return (data ?? []) as unknown as ProductMovementRow[];
}

/** 盤點頁的商品清單。篩選與分頁都下推 —— 來源是把 993 筆全撈回來再 filter。 */
export type StockCountProductRow = {
  inv_product_id: string;
  name: string;
  issue_number: string | null;
  series: string | null;
  barcode: string | null;
  product_type: string;
  stock_quantity: number;
  low_stock_alert: number | null;
  cost_price: number | null;
  category_id: string | null;
  category_name: string | null;
};

export async function listStockCountProducts(filter: {
  keyword: string | null;
  categoryId: string | null;
  productType: "outright" | "consignment" | "rental" | null;
  lowStockOnly: boolean;
  page: number;
  pageSize: number;
}): Promise<{ rows: StockCountProductRow[]; total: number }> {
  const from = filter.page * filter.pageSize;

  const build = () => {
    let query = supabaseAdmin()
      .from("inv_admin_products")
      .select(
        "inv_product_id, name, issue_number, series, barcode, product_type, stock_quantity, " +
          "low_stock_alert, cost_price, category_id, category_name",
        { count: "exact" },
      )
      .eq("is_active", true)
      .eq("approval_status", "approved")
      .order("name", { ascending: true })
      .order("inv_product_id", { ascending: true });

    if (filter.categoryId) query = query.eq("category_id", filter.categoryId);
    if (filter.productType) query = query.eq("product_type", filter.productType);
    if (filter.keyword) {
      const safe = filter.keyword.replace(/[(),]/g, " ").trim();
      if (safe) {
        query = query.or(
          `name.ilike.%${safe}%,issue_number.ilike.%${safe}%,series.ilike.%${safe}%,barcode.ilike.%${safe}%`,
        );
      }
    }
    return query;
  };

  if (filter.lowStockOnly) {
    // 低庫存門檻是 per-row 的（low_stock_alert，預設 5），PostgREST 沒辦法比較兩個欄位。
    // 原本在資料庫端粗篩「庫存 <= 5」，會漏掉警示值設得比 5 大的品項（2026-11-03 審查）。
    // 改成把符合其他條件的品項分段讀完，用 isLowStock（唯一定義）在記憶體篩，再分頁。
    // 啟用＋已審核的品項約幾千列，分段讀幾趟可以接受。
    const all = await readAllPages(
      (a, b) =>
        build().range(a, b) as unknown as PromiseLike<{
          data: StockCountProductRow[] | null;
          error: { code?: string; message: string } | null;
        }>,
      { label: "[repo/inv-adjustments] 盤點商品（低庫存）" },
    );
    const low = all.filter(isLowStock);
    return { rows: low.slice(from, from + filter.pageSize), total: low.length };
  }

  const { data, error, count } = await build().range(from, from + filter.pageSize - 1);
  if (error) throw new Error(`[repo/inv-adjustments] 盤點商品清單讀取失敗：${error.message}`);
  return { rows: (data ?? []) as unknown as StockCountProductRow[], total: count ?? 0 };
}

// ---------------------------------------------------------------------------
// 寫入 —— 全部走 0017 的 SECURITY DEFINER 函式
// ---------------------------------------------------------------------------

/** 把 PL/pgSQL 的 `PREFIX: 中文訊息` 剝成給店員看的那一句。 */
function speak(message: string, fallback: string): string {
  return message.replace(/^[A-Z_]+:\s*/, "").trim() || fallback;
}

export async function saveAdjustment(input: {
  userId: string;
  payload: Record<string, unknown>;
  submit: boolean;
}): Promise<{
  id: string;
  adjustment_number: string | null;
  status: string;
  needs_approval: boolean;
  stock_before: number;
}> {
  const { data, error } = await supabaseAdmin().rpc("inv_save_stock_adjustment", {
    p_user_id: input.userId,
    p_payload: input.payload,
    p_submit: input.submit,
  });

  if (error) throw new Error(speak(error.message, "異動單儲存失敗，請再試一次"));
  return data as {
    id: string;
    adjustment_number: string | null;
    status: string;
    needs_approval: boolean;
    stock_before: number;
  };
}

/**
 * 盤點（單筆與批次同一支）。
 *
 * ⚠️ rows 送的是**實盤數量**，不是差異。差異由 inv_record_stock_count() 用當下的
 *    stock_quantity 算。
 */
export async function recordStockCount(input: {
  userId: string;
  rows: { product_id: string; actual_quantity: number }[];
  options: Record<string, unknown>;
}): Promise<{
  created: number;
  skipped: number;
  shrinkage: number;
  surplus: number;
  status: string;
  needs_approval: boolean;
  ids: string[];
}> {
  const { data, error } = await supabaseAdmin().rpc("inv_record_stock_count", {
    p_user_id: input.userId,
    p_rows: input.rows,
    p_options: input.options,
  });

  if (error) throw new Error(speak(error.message, "盤點失敗，整批都沒有寫進去"));
  return data as {
    created: number;
    skipped: number;
    shrinkage: number;
    surplus: number;
    status: string;
    needs_approval: boolean;
    ids: string[];
  };
}

export async function submitAdjustment(input: { userId: string; id: string }): Promise<{
  changed: boolean;
  previous_status: string;
  status: string;
  needs_approval: boolean;
}> {
  const { data, error } = await supabaseAdmin().rpc("inv_submit_stock_adjustment", {
    p_user_id: input.userId,
    p_id: input.id,
  });

  if (error) throw new Error(speak(error.message, "送出失敗，請再試一次"));
  return data as {
    changed: boolean;
    previous_status: string;
    status: string;
    needs_approval: boolean;
  };
}

export async function deleteAdjustment(id: string): Promise<{
  deleted: boolean;
  adjustment_number: string | null;
}> {
  const { data, error } = await supabaseAdmin().rpc("inv_delete_stock_adjustment", { p_id: id });

  // 「已確認的不可刪除，請改用沖帳」是寫給店員看的整句中文，原樣往上丟。
  if (error) throw new Error(speak(error.message, "刪除失敗"));
  return data as { deleted: boolean; adjustment_number: string | null };
}

export async function reverseAdjustment(input: { userId: string; id: string }): Promise<{
  id: string;
  adjustment_number: string | null;
  quantity: number;
  reversal_of: string;
}> {
  const { data, error } = await supabaseAdmin().rpc("inv_reverse_stock_adjustment", {
    p_user_id: input.userId,
    p_id: input.id,
  });

  if (error) throw new Error(speak(error.message, "沖帳失敗"));
  return data as {
    id: string;
    adjustment_number: string | null;
    quantity: number;
    reversal_of: string;
  };
}

export async function resubmitAdjustment(
  id: string,
): Promise<{ changed: boolean; previous_status: string }> {
  const { data, error } = await supabaseAdmin().rpc("inv_resubmit_stock_adjustment", { p_id: id });

  if (error) throw new Error(speak(error.message, "重新送審失敗"));
  return data as { changed: boolean; previous_status: string };
}

/** 與 inv-purchases.ts 那一支是同一個 RPC；兩邊各有一份 wrapper 只是為了不互相 import。 */
export async function approveRecord(input: {
  userId: string;
  module: string;
  id: string;
  approved: boolean;
}): Promise<{ changed: boolean; module: string; previous_status: string | null }> {
  const { data, error } = await supabaseAdmin().rpc("inv_approve_record", {
    p_user_id: input.userId,
    p_module: input.module,
    p_id: input.id,
    p_approved: input.approved,
  });

  if (error) throw new Error(speak(error.message, "審核失敗，請再試一次"));
  return data as { changed: boolean; module: string; previous_status: string | null };
}

/** 異動表單要的參考資料：分類、審核設定。商品清單走 listStockCountProducts。 */
export async function listAdjustmentFormOptions(): Promise<{
  categories: { category_id: string; name: string; icon: string | null }[];
  approvalSettings: { module: string; is_enabled: boolean }[];
}> {
  const [cats, settings] = await Promise.all([
    supabaseAdmin()
      .from("inv_admin_categories")
      .select("category_id, name, icon")
      .order("display_order"),
    supabaseAdmin().from("inv_admin_approval_settings").select("module, is_enabled"),
  ]);

  if (cats.error) throw new Error(`[repo/inv-adjustments] 分類讀取失敗：${cats.error.message}`);
  if (settings.error)
    throw new Error(`[repo/inv-adjustments] 審核設定讀取失敗：${settings.error.message}`);

  return {
    categories: (cats.data ?? []) as { category_id: string; name: string; icon: string | null }[],
    approvalSettings: (settings.data ?? []) as { module: string; is_enabled: boolean }[],
  };
}
