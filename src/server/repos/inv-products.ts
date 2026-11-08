/**
 * 進銷存商品主檔 —— 這一頁**所有**資料庫存取的唯一出口。
 *
 * ── 這一層存在的理由（與 repos/inv-sales.ts 同一條）────────────────────────
 * inv 不在 PostgREST 的 db_schema 裡（0009 §0：inv.vendors 有身分證字號與銀行
 * 帳戶）。所以連 service_role 的 supabase-js client 都**打不到** inv.* —— 那些表
 * 根本沒被掛出來。要讀就走 0016 的四個 view，要寫就呼叫 SECURITY DEFINER 函式。
 *
 * ── 錯誤一律 throw，不吞 ──────────────────────────────────────────────────
 * 沒有任何一個 catch 會把錯誤變成空陣列或 null：呼叫端要嘛拿到資料，要嘛看到
 * 一句中文錯誤。來源系統的 Excel 匯入是 per-item try/catch 然後 toast「N 筆
 * 失敗」，失敗的那幾筆是什麼、為什麼失敗，事後查不到。
 *
 * ── 篩選與分頁都在資料庫端 ────────────────────────────────────────────────
 * 來源是「抓全表 993 筆 → 前端 Array.filter → 全部渲染」，而且每一次寫入都會
 * 重抓整張表。這裡下推到 PostgREST。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import { findIdsByNoteBarcode, normalizeScannedCode } from "@/lib/admin/note-barcode";

/** 0016 的 inv_admin_products。與 inv_pos_products 不同，這一支含待審／停用／租借。 */
export type AdminProductRow = {
  inv_product_id: string;
  name: string;
  issue_number: string | null;
  barcode: string | null;
  series: string | null;
  publisher: string | null;
  notes: string | null;
  image_key: string | null;
  product_type: string;
  selling_price: number | null;
  cost_price: number | null;
  stock_quantity: number;
  low_stock_alert: number | null;
  pack_size: number;
  is_active: boolean;
  category_id: string | null;
  category_name: string | null;
  category_icon: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_short_name: string | null;
  base_product_id: string | null;
  base_product_name: string | null;
  approval_status: string;
  approved_at: string | null;
  approved_by_name: string | null;
  pending_cost_price: number | null;
  pending_selling_price: number | null;
  price_change_status: string | null;
  price_change_requested_at: string | null;
  price_change_requested_by_name: string | null;
  user_id: string;
  creator_name: string | null;
  created_at: string;
  updated_at: string;
  reserved: number;
  available: number;
  listed_product_id: string | null;
  listed_slug: string | null;
  listed_status: string | null;
};

export type AdminCategory = {
  category_id: string;
  name: string;
  icon: string | null;
  display_order: number | null;
};

/** ⚠️ 只有六欄。inv.vendors 另外 42 欄含身分證字號與稅籍 —— 見 0016 §5c。 */
export type AdminVendor = {
  vendor_id: string;
  name: string;
  short_name: string | null;
  is_consignment: boolean | null;
  status: string | null;
  approval_status: string | null;
};

export type ApprovalSetting = { module: string; is_enabled: boolean; updated_at: string };

export type ProductFilter = {
  keyword: string | null;
  categoryId: string | null;
  productType: string | null;
  vendorId: string | null;
  approvalStatus: "all" | "pending" | "approved" | "rejected";
  activeStatus: "all" | "active" | "inactive";
  priceChange: "all" | "pending";
  sort:
    | "created_at"
    | "name_asc"
    | "name_desc"
    | "issue_asc"
    | "issue_desc"
    | "stock_asc"
    | "stock_desc";
  page: number;
  pageSize: number;
};

const COLUMNS =
  "inv_product_id, name, issue_number, barcode, series, publisher, notes, image_key, " +
  "product_type, selling_price, cost_price, stock_quantity, low_stock_alert, pack_size, is_active, " +
  "category_id, category_name, category_icon, vendor_id, vendor_name, vendor_short_name, " +
  "base_product_id, base_product_name, approval_status, approved_at, approved_by_name, " +
  "pending_cost_price, pending_selling_price, price_change_status, price_change_requested_at, " +
  "price_change_requested_by_name, user_id, creator_name, created_at, updated_at, " +
  "reserved, available, listed_product_id, listed_slug, listed_status";

/** 排序鍵 → PostgREST order()。issue_number 是 text，所以數字期數只能字典序排。 */
const SORTS: Record<ProductFilter["sort"], { column: string; ascending: boolean }> = {
  created_at: { column: "created_at", ascending: false },
  name_asc: { column: "name", ascending: true },
  name_desc: { column: "name", ascending: false },
  issue_asc: { column: "issue_number", ascending: true },
  issue_desc: { column: "issue_number", ascending: false },
  stock_asc: { column: "stock_quantity", ascending: true },
  stock_desc: { column: "stock_quantity", ascending: false },
};

export async function listAdminProducts(
  filter: ProductFilter,
): Promise<{ rows: AdminProductRow[]; total: number }> {
  const from = filter.page * filter.pageSize;
  const sort = SORTS[filter.sort] ?? SORTS.created_at;

  let query = supabaseAdmin()
    .from("inv_admin_products")
    .select(COLUMNS, { count: "exact" })
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    // 第二排序鍵：沒有它的話同名／同庫存的列在不同頁之間順序是不確定的，
    // 翻頁會看到重複或漏掉的商品。inv-sales.ts 為了同一個理由補 created_at。
    .order("inv_product_id", { ascending: true })
    .range(from, from + filter.pageSize - 1);

  if (filter.categoryId) query = query.eq("category_id", filter.categoryId);
  if (filter.productType) query = query.eq("product_type", filter.productType);
  if (filter.vendorId) query = query.eq("vendor_id", filter.vendorId);
  if (filter.approvalStatus !== "all") query = query.eq("approval_status", filter.approvalStatus);
  if (filter.activeStatus !== "all")
    query = query.eq("is_active", filter.activeStatus === "active");
  if (filter.priceChange === "pending") query = query.eq("price_change_status", "pending");

  if (filter.keyword) {
    // PostgREST 的 or() 語法：逗號分隔，值裡的逗號與括號會壞掉，所以先剝掉。
    const safe = filter.keyword.replace(/[(),]/g, " ").trim();
    if (safe) {
      // 來源只搜 name 與 issue_number。條碼搜不到是店員每天都會撞到的事
      // （手上拿著書、掃不出來、想用條碼查），所以這裡多加三個欄位。
      // 約 723 筆的條碼只寫在備註（「條碼: 636864」），barcode 欄是空的。關鍵字長得像條碼
      // （純英數）時，另外用備註比對一次，命中的 id 併進同一個 or()。備註比對是**整碼相等**
      // （見 lib/admin/note-barcode.ts），不會因為部分數字而多跑出一堆列。
      const noteIds = normalizeScannedCode(safe) ? await findInvProductIdsByNoteBarcode(safe) : [];
      const noteClause = noteIds.length ? `,inv_product_id.in.(${noteIds.join(",")})` : "";
      query = query.or(
        `name.ilike.%${safe}%,issue_number.ilike.%${safe}%,barcode.ilike.%${safe}%,` +
          `series.ilike.%${safe}%,publisher.ilike.%${safe}%` +
          noteClause,
      );
    }
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`[repo/inv-products] 商品清單讀取失敗：${error.message}`);
  return { rows: (data ?? []) as unknown as AdminProductRow[], total: count ?? 0 };
}

/**
 * 條碼寫在備註裡（「條碼: 636864」）的商品 id。全部商品都看（含停用／待審／租借），由呼叫端
 * 自己再套範圍 —— 櫃檯那一支會再過 inv_pos_products，所以賣不動的不會被掃進購物車。
 *
 * 兩段式：資料庫 ILIKE 粗篩（碼已轉義 \ % _）→ 程式端整碼相等精篩。輸入不是純英數 → 空陣列、不打資料庫。
 * 排序固定（name, inv_product_id），多筆命中時每次回來的第一筆都一樣。
 */
export async function findInvProductIdsByNoteBarcode(code: string): Promise<string[]> {
  return findIdsByNoteBarcode(code, async (pattern, limit) => {
    const { data, error } = await supabaseAdmin()
      .from("inv_admin_products")
      .select("inv_product_id, notes")
      .ilike("notes", pattern)
      .order("name", { ascending: true })
      .order("inv_product_id", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`[repo/inv-products] 備註條碼查詢失敗：${error.message}`);
    return (data ?? []) as { inv_product_id: string; notes: string | null }[];
  });
}

/** 一件商品。編輯與詳細頁用，不走清單那一份分頁快取。 */
export async function getAdminProduct(id: string): Promise<AdminProductRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_products")
    .select(COLUMNS)
    .eq("inv_product_id", id)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[repo/inv-products] 商品讀取失敗：${error.message}`);
  return (data as unknown as AdminProductRow | null) ?? null;
}

export async function listAdminCategories(): Promise<AdminCategory[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_categories")
    .select("category_id, name, icon, display_order")
    .order("display_order", { ascending: true });

  if (error) throw new Error(`[repo/inv-products] 分類讀取失敗：${error.message}`);
  return (data ?? []) as unknown as AdminCategory[];
}

export async function listAdminVendors(): Promise<AdminVendor[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_vendors")
    .select("vendor_id, name, short_name, is_consignment, status, approval_status")
    .order("name", { ascending: true });

  if (error) throw new Error(`[repo/inv-products] 供應商讀取失敗：${error.message}`);
  return (data ?? []) as unknown as AdminVendor[];
}

/**
 * 七個模組要不要審核。
 *
 * ⚠️ 這份資料是**畫面用的**（「新增後會進入待審核」那句提示）。真正決定
 *    approval_status 的是 inv.initial_approval_status()，它在資料庫裡自己查一次。
 *    來源系統把這個判斷放在瀏覽器上算完再連同 insert 一起送出去，那等於讓
 *    request body 決定自己要不要被審核。
 */
export async function listApprovalSettings(): Promise<ApprovalSetting[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_approval_settings")
    .select("module, is_enabled, updated_at")
    .order("module", { ascending: true });

  if (error) throw new Error(`[repo/inv-products] 審核設定讀取失敗：${error.message}`);
  return (data ?? []) as unknown as ApprovalSetting[];
}

/** 母品項候選：已審核、而且自己不是組合品（來源不允許多層鏈結）。 */
export async function listBaseProductCandidates(): Promise<
  { inv_product_id: string; name: string; issue_number: string | null; stock_quantity: number }[]
> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_products")
    .select("inv_product_id, name, issue_number, stock_quantity")
    .eq("approval_status", "approved")
    .is("base_product_id", null)
    .order("name", { ascending: true })
    .limit(2000);

  if (error) throw new Error(`[repo/inv-products] 母品項清單讀取失敗：${error.message}`);
  return (data ?? []) as unknown as {
    inv_product_id: string;
    name: string;
    issue_number: string | null;
    stock_quantity: number;
  }[];
}

// ---------------------------------------------------------------------------
// 寫入 —— 全部走 0016 的 SECURITY DEFINER 函式
// ---------------------------------------------------------------------------

/** 把 PL/pgSQL 的 `PREFIX: 中文訊息` 剝成給店員看的那一句。 */
function speak(message: string, fallback: string): string {
  return message.replace(/^[A-Z_]+:\s*/, "").trim() || fallback;
}

export type SaveProductInput = {
  userId: string;
  id: string | null;
  payload: Record<string, unknown>;
  purchase: Record<string, unknown> | null;
};

export async function saveProduct(input: SaveProductInput): Promise<{
  id: string;
  created: boolean;
  purchase_created: boolean;
  price_change_pending: boolean;
}> {
  const { data, error } = await supabaseAdmin().rpc("inv_save_product", {
    p_user_id: input.userId,
    p_id: input.id,
    p_payload: input.payload,
    p_purchase: input.purchase,
  });

  if (error) throw new Error(speak(error.message, "商品儲存失敗，請再試一次"));
  return data as {
    id: string;
    created: boolean;
    purchase_created: boolean;
    price_change_pending: boolean;
  };
}

/**
 * 審核／退回。
 *
 * ⚠️ module 只是一個代號。表名與狀態欄位在 0016 的 inv_approve_record() 裡面，
 *    是寫死的 CASE 分支，整支函式沒有一行動態 SQL。來源的
 *    useApprovalMutation({ table }) 是讓 client 指定要更新哪張表 —— 隔著 HTTP
 *    之後那就是 `update <任意表>`。
 */
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

export async function setProductActive(input: {
  userId: string;
  id: string;
  isActive: boolean;
}): Promise<{ id: string; name: string; is_active: boolean; listed_count: number }> {
  const { data, error } = await supabaseAdmin().rpc("inv_set_product_active", {
    p_user_id: input.userId,
    p_id: input.id,
    p_is_active: input.isActive,
  });

  if (error) throw new Error(speak(error.message, "上下架失敗，請再試一次"));
  return data as { id: string; name: string; is_active: boolean; listed_count: number };
}

export async function deleteProduct(id: string): Promise<{ id: string; name: string }> {
  const { data, error } = await supabaseAdmin().rpc("inv_delete_product", { p_id: id });
  if (error) throw new Error(speak(error.message, "刪除失敗，請再試一次"));
  return data as { id: string; name: string };
}

export async function resubmitProduct(id: string): Promise<{ id: string; name: string }> {
  const { data, error } = await supabaseAdmin().rpc("inv_resubmit_product", { p_id: id });
  if (error) throw new Error(speak(error.message, "重新送審失敗，請再試一次"));
  return data as { id: string; name: string };
}

export async function requestPriceChange(input: {
  userId: string;
  id: string;
  costPrice: number | null;
  sellingPrice: number;
}): Promise<{ id: string; name: string; pending: boolean }> {
  const { data, error } = await supabaseAdmin().rpc("inv_request_price_change", {
    p_user_id: input.userId,
    p_id: input.id,
    p_cost_price: input.costPrice,
    p_selling_price: input.sellingPrice,
  });

  if (error) throw new Error(speak(error.message, "調價送出失敗，請再試一次"));
  return data as { id: string; name: string; pending: boolean };
}

/**
 * Excel 匯入。
 *
 * xlsx 的解析在瀏覽器（純檔案處理，不需要伺服器），但**寫入一定走這裡** ——
 * 瀏覽器沒有任何一條路徑碰得到資料庫。整批一個交易：來源是前端 for 迴圈，
 * 每列各兩三次 HTTP，中途斷線就留下一半的商品與對不上的進貨。
 */
export async function importProducts(input: {
  userId: string;
  rows: Record<string, unknown>[];
  options: Record<string, unknown>;
}): Promise<{ created: number; updated: number; purchases: number; approval_status: string }> {
  const { data, error } = await supabaseAdmin().rpc("inv_import_products", {
    p_user_id: input.userId,
    p_rows: input.rows,
    p_options: input.options,
  });

  if (error) throw new Error(speak(error.message, "匯入失敗，沒有任何一列被寫入"));
  return data as { created: number; updated: number; purchases: number; approval_status: string };
}

export async function batchUpdateProducts(input: {
  userId: string;
  ids: string[];
  patch: Record<string, unknown>;
}): Promise<{ updated: number; price_change_pending: boolean }> {
  const { data, error } = await supabaseAdmin().rpc("inv_batch_update_products", {
    p_user_id: input.userId,
    p_ids: input.ids,
    p_patch: input.patch,
  });

  if (error) throw new Error(speak(error.message, "批次更新失敗，請再試一次"));
  return data as { updated: number; price_change_pending: boolean };
}
