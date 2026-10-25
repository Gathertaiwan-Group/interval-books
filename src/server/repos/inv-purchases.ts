/**
 * 進貨 —— 這一頁**所有**資料庫存取的唯一出口。
 *
 * ── 這一層存在的理由（與 repos/inv-products.ts 同一條）────────────────────
 * inv 不在 PostgREST 的 db_schema 裡（0009 §0：inv.vendors 有身分證字號與銀行
 * 帳戶）。所以連 service_role 的 supabase-js client 都**打不到** inv.*。要讀就走
 * 0017 的 view，要寫就呼叫 SECURITY DEFINER 函式。
 *
 * ── remaining_quantity 這一層一個字都不寫 ─────────────────────────────────
 * 它是 FIFO 的消耗欄位（inv.allocate_fifo_cost 從最舊的批次往下扣）。0017 把
 * 「數量被改了」與「進貨被刪了」這兩條路徑補進 trigger，所以這裡只要送 quantity
 * 進去，remaining_quantity 與 products.stock_quantity 會自己對齊。硬要在這一層
 * 算，就會有兩份算法，而兩份總有一天會不一樣。
 *
 * ── 錯誤一律 throw，不吞 ──────────────────────────────────────────────────
 * 來源的 Excel 匯入是 per-item try/catch 然後 toast「N 筆失敗」，失敗的那幾筆是
 * 什麼、為什麼，事後查不到。這裡整批在同一個交易裡，錯就整批回滾並丟出原因。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";

/** 0017 的 inv_admin_purchases。 */
export type AdminPurchaseRow = {
  purchase_id: string;
  product_id: string;
  product_name: string | null;
  issue_number: string | null;
  series: string | null;
  product_type: string | null;
  category_id: string | null;
  category_name: string | null;
  item_name: string | null;
  purchase_date: string;
  quantity: number;
  remaining_quantity: number;
  /** FIFO 已經從這一批吃掉的件數。編輯與刪除的守衛都是對著它。 */
  consumed_quantity: number;
  unit_cost: number | null;
  subtotal: number;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_short_name: string | null;
  vendor_text: string | null;
  publisher: string | null;
  notes: string | null;
  expiry_date: string | null;
  expiry_alert_days: number | null;
  approval_status: string;
  approved_at: string | null;
  approved_by_name: string | null;
  user_id: string;
  creator_name: string | null;
  created_at: string;
};

export type PurchaseFilter = {
  keyword: string | null;
  categoryId: string | null;
  vendorId: string | null;
  productType: "outright" | "consignment" | "rental" | null;
  approvalStatus: "all" | "pending" | "approved" | "rejected";
  expiryStatus: "all" | "expiring" | "expired" | "warning" | "no_expiry";
  stockStatus: "all" | "in_stock" | "used_up";
  dateFrom: string | null;
  dateTo: string | null;
  sort:
    | "purchase_date_desc"
    | "purchase_date_asc"
    | "created_at"
    | "quantity_desc"
    | "remaining_asc";
  page: number;
  pageSize: number;
};

const COLUMNS =
  "purchase_id, product_id, product_name, issue_number, series, product_type, " +
  "category_id, category_name, item_name, purchase_date, quantity, remaining_quantity, " +
  "consumed_quantity, unit_cost, subtotal, vendor_id, vendor_name, vendor_short_name, " +
  "vendor_text, publisher, notes, expiry_date, expiry_alert_days, approval_status, " +
  "approved_at, approved_by_name, user_id, creator_name, created_at";

const SORTS: Record<PurchaseFilter["sort"], { column: string; ascending: boolean }> = {
  purchase_date_desc: { column: "purchase_date", ascending: false },
  purchase_date_asc: { column: "purchase_date", ascending: true },
  created_at: { column: "created_at", ascending: false },
  quantity_desc: { column: "quantity", ascending: false },
  remaining_asc: { column: "remaining_quantity", ascending: true },
};

/** 台北的今天。expiry_date 是 date，用 toISOString() 晚上八點之後會差一天。 */
function todayInTaipei(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function listAdminPurchases(
  filter: PurchaseFilter,
): Promise<{ rows: AdminPurchaseRow[]; total: number }> {
  const from = filter.page * filter.pageSize;
  const sort = SORTS[filter.sort] ?? SORTS.purchase_date_desc;

  let query = supabaseAdmin()
    .from("inv_admin_purchases")
    .select(COLUMNS, { count: "exact" })
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    // 第二排序鍵。來源只排 purchase_date desc，所以同一天的進貨在翻頁之間順序
    // 是不定的 —— 第 2 頁會看到第 1 頁出現過的列。
    .order("purchase_id", { ascending: true })
    .range(from, from + filter.pageSize - 1);

  if (filter.categoryId) query = query.eq("category_id", filter.categoryId);
  if (filter.vendorId) query = query.eq("vendor_id", filter.vendorId);
  if (filter.productType) query = query.eq("product_type", filter.productType);
  if (filter.approvalStatus !== "all") query = query.eq("approval_status", filter.approvalStatus);
  if (filter.dateFrom) query = query.gte("purchase_date", filter.dateFrom);
  if (filter.dateTo) query = query.lte("purchase_date", filter.dateTo);

  if (filter.stockStatus === "in_stock") query = query.gt("remaining_quantity", 0);
  if (filter.stockStatus === "used_up") query = query.eq("remaining_quantity", 0);

  // 效期。來源是把全表撈回來在瀏覽器算 differenceInDays，這裡改成日期比較下推。
  //
  // ⚠️ expiry_alert_days 是**每一列自己的**（預設 7），所以「快到期」嚴格說是
  //    per-row 的門檻。PostgREST 沒辦法比較兩個欄位，這裡用 30 天當上界先撈，
  //    真正的 per-row 判斷留給前端顯示層 —— 撈多了是慢一點，撈少了是漏單。
  if (filter.expiryStatus !== "all") {
    const today = todayInTaipei();
    if (filter.expiryStatus === "no_expiry") {
      query = query.is("expiry_date", null);
    } else if (filter.expiryStatus === "expired") {
      query = query
        .not("expiry_date", "is", null)
        .lt("expiry_date", today)
        .gt("remaining_quantity", 0);
    } else if (filter.expiryStatus === "warning") {
      query = query
        .not("expiry_date", "is", null)
        .gte("expiry_date", today)
        .lte("expiry_date", addDays(today, 30))
        .gt("remaining_quantity", 0);
    } else {
      // expiring = 含已過期
      query = query
        .not("expiry_date", "is", null)
        .lte("expiry_date", addDays(today, 30))
        .gt("remaining_quantity", 0);
    }
  }

  if (filter.keyword) {
    // PostgREST 的 or() 語法：逗號分隔，值裡的逗號與括號會壞掉，所以先剝掉。
    const safe = filter.keyword.replace(/[(),]/g, " ").trim();
    if (safe) {
      query = query.or(
        `product_name.ilike.%${safe}%,item_name.ilike.%${safe}%,issue_number.ilike.%${safe}%,` +
          `series.ilike.%${safe}%,vendor_name.ilike.%${safe}%,vendor_text.ilike.%${safe}%,` +
          `publisher.ilike.%${safe}%`,
      );
    }
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`[repo/inv-purchases] 進貨清單讀取失敗：${error.message}`);
  return { rows: (data ?? []) as unknown as AdminPurchaseRow[], total: count ?? 0 };
}

export async function getAdminPurchase(id: string): Promise<AdminPurchaseRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_purchases")
    .select(COLUMNS)
    .eq("purchase_id", id)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[repo/inv-purchases] 進貨讀取失敗：${error.message}`);
  return (data as unknown as AdminPurchaseRow | null) ?? null;
}

/** 頁面上方那五張統計卡。整批算在資料庫端，不要把全表撈回來 reduce。 */
export async function getPurchaseSummary(filter: PurchaseFilter): Promise<{
  batches: number;
  quantity: number;
  remaining: number;
  amount: number;
  pending: number;
}> {
  // count 走 head，數字走一次全欄位。資料量到六位數之前這樣夠用，而且比在
  // 瀏覽器 reduce 誠實：使用者看到的是**篩選條件下的**總計，不是這一頁的。
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_purchases")
    .select("quantity, remaining_quantity, subtotal, approval_status")
    .gte("purchase_date", filter.dateFrom ?? "1900-01-01")
    .lte("purchase_date", filter.dateTo ?? "2999-12-31")
    .limit(20000);

  if (error) throw new Error(`[repo/inv-purchases] 進貨統計讀取失敗：${error.message}`);

  const rows = (data ?? []) as {
    quantity: number;
    remaining_quantity: number;
    subtotal: number;
    approval_status: string;
  }[];
  return {
    batches: rows.length,
    quantity: rows.reduce((s, r) => s + (r.quantity ?? 0), 0),
    remaining: rows.reduce((s, r) => s + (r.remaining_quantity ?? 0), 0),
    amount: rows.reduce((s, r) => s + Number(r.subtotal ?? 0), 0),
    pending: rows.filter((r) => r.approval_status === "pending").length,
  };
}

/** 進貨表單要的三份參考資料。 */
export async function listPurchaseFormOptions(): Promise<{
  categories: { category_id: string; name: string; icon: string | null }[];
  vendors: { vendor_id: string; name: string; short_name: string | null }[];
  approvalSettings: { module: string; is_enabled: boolean }[];
}> {
  const [cats, vendors, settings] = await Promise.all([
    supabaseAdmin()
      .from("inv_admin_categories")
      .select("category_id, name, icon")
      .order("display_order"),
    supabaseAdmin()
      .from("inv_admin_vendors")
      .select("vendor_id, name, short_name")
      .eq("status", "active")
      .order("name"),
    supabaseAdmin().from("inv_admin_approval_settings").select("module, is_enabled"),
  ]);

  if (cats.error) throw new Error(`[repo/inv-purchases] 分類讀取失敗：${cats.error.message}`);
  if (vendors.error)
    throw new Error(`[repo/inv-purchases] 供應商讀取失敗：${vendors.error.message}`);
  if (settings.error)
    throw new Error(`[repo/inv-purchases] 審核設定讀取失敗：${settings.error.message}`);

  return {
    categories: (cats.data ?? []) as { category_id: string; name: string; icon: string | null }[],
    vendors: (vendors.data ?? []) as {
      vendor_id: string;
      name: string;
      short_name: string | null;
    }[],
    approvalSettings: (settings.data ?? []) as { module: string; is_enabled: boolean }[],
  };
}

export type ProductPickerRow = {
  inv_product_id: string;
  name: string;
  issue_number: string | null;
  series: string | null;
  barcode: string | null;
  cost_price: number | null;
  stock_quantity: number;
  product_type: string;
  category_id: string | null;
};

/**
 * 商品下拉選單。翻頁拿完，只給進貨表單與 Excel 匯入比對用。
 *
 * 一般清單頁**不該**呼叫這個 —— 篩選與分頁都在資料庫端做，正是為了不要把整張
 * 表搬到瀏覽器。這裡例外，是因為「選一件商品」與「這一列是不是既有商品」都要
 * 對著完整清單。
 */
export async function listProductPickerRows(): Promise<ProductPickerRow[]> {
  const PAGE = 1000;
  const out: ProductPickerRow[] = [];

  for (let page = 0; page < 20; page += 1) {
    const { data, error } = await supabaseAdmin()
      .from("inv_admin_products")
      .select(
        "inv_product_id, name, issue_number, series, barcode, cost_price, stock_quantity, product_type, category_id",
      )
      .eq("is_active", true)
      .order("name", { ascending: true })
      .order("inv_product_id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);

    if (error) throw new Error(`[repo/inv-purchases] 商品清單讀取失敗：${error.message}`);
    const rows = (data ?? []) as unknown as ProductPickerRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }

  return out;
}

/** searchProductPickerRows 一次最多回幾列（與原本表單裡 matches.slice(0, 30) 相同）。 */
export const PRODUCT_PICKER_SEARCH_LIMIT = 30;

/**
 * 新增進貨表單的商品選擇器（2026-10-26 後台第 3 批瘦身）：依關鍵字在資料庫端找，最多回 30 列。
 *
 * 原本表單拿到的是整份清單（listProductPickerRows，約 3,000 列、385 KB），再在瀏覽器裡
 * `name issue_number series barcode` 串起來 includes 比對、取前 30 筆。這裡做同一件事，只是搬到
 * 資料庫：四個欄位任一個 ilike 命中就算、依名稱排序。空字串＝依名稱排序的前 30 筆（與原本一樣）。
 *
 * ⚠️ Excel 匯入與拍照辨識的比對仍然要對著**完整清單**（「這一列是不是既有商品」不能只看 30 筆），
 *    那兩個入口打開時才另外抓 listProductPickerRows，見 _shell.inventory-purchases.tsx。
 */
export async function searchProductPickerRows(keyword: string): Promise<ProductPickerRow[]> {
  let query = supabaseAdmin()
    .from("inv_admin_products")
    .select(
      "inv_product_id, name, issue_number, series, barcode, cost_price, stock_quantity, product_type, category_id",
    )
    .eq("is_active", true)
    .order("name", { ascending: true })
    .order("inv_product_id", { ascending: true })
    .limit(PRODUCT_PICKER_SEARCH_LIMIT);

  // PostgREST 的 or() 語法：逗號與括號會壞掉，先剝掉（同 listAdminPurchases）。% 與 _ 是 ilike 的
  // 萬用字元，原本的 includes 比對是字面比對，所以也一起剝掉，不讓它們變成「任意字元」。
  const safe = keyword.replace(/[(),%_*\\]/g, " ").trim();
  if (safe) {
    query = query.or(
      `name.ilike.%${safe}%,issue_number.ilike.%${safe}%,series.ilike.%${safe}%,barcode.ilike.%${safe}%`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(`[repo/inv-purchases] 商品搜尋失敗：${error.message}`);
  return (data ?? []) as unknown as ProductPickerRow[];
}

// ---------------------------------------------------------------------------
// 寫入 —— 全部走 0017 的 SECURITY DEFINER 函式
// ---------------------------------------------------------------------------

/** 把 PL/pgSQL 的 `PREFIX: 中文訊息` 剝成給店員看的那一句。 */
function speak(message: string, fallback: string): string {
  return message.replace(/^[A-Z_]+:\s*/, "").trim() || fallback;
}

export async function savePurchase(input: {
  userId: string;
  id: string | null;
  payload: Record<string, unknown>;
}): Promise<{ id: string; created: boolean; approval_status: string; needs_approval: boolean }> {
  const { data, error } = await supabaseAdmin().rpc("inv_save_purchase", {
    p_user_id: input.userId,
    p_id: input.id,
    p_payload: input.payload,
  });

  if (error) throw new Error(speak(error.message, "進貨儲存失敗，請再試一次"));
  return data as { id: string; created: boolean; approval_status: string; needs_approval: boolean };
}

export async function deletePurchase(id: string): Promise<{
  deleted: boolean;
  quantity: number;
  stock_rolled_back: boolean;
  product_id: string;
}> {
  const { data, error } = await supabaseAdmin().rpc("inv_delete_purchase", { p_id: id });

  // 已經被 FIFO 消耗過的批次會被 rollback_stock_on_purchase_delete() 擋下來，
  // 訊息是寫給店員看的整句中文（含「請開一張在庫異動單」），原樣往上丟。
  if (error) throw new Error(speak(error.message, "進貨刪除失敗"));
  return data as {
    deleted: boolean;
    quantity: number;
    stock_rolled_back: boolean;
    product_id: string;
  };
}

export async function batchUpdatePurchases(input: {
  userId: string;
  ids: string[];
  patch: Record<string, unknown>;
}): Promise<{ updated: number }> {
  const { data, error } = await supabaseAdmin().rpc("inv_batch_update_purchases", {
    p_user_id: input.userId,
    p_ids: input.ids,
    p_patch: input.patch,
  });

  if (error) throw new Error(speak(error.message, "批次更新失敗"));
  return data as { updated: number };
}

export async function importPurchases(input: {
  userId: string;
  rows: Record<string, unknown>[];
  options: Record<string, unknown>;
}): Promise<{
  purchases_created: number;
  products_created: number;
  approval_status: string;
  needs_approval: boolean;
}> {
  const { data, error } = await supabaseAdmin().rpc("inv_import_purchases", {
    p_user_id: input.userId,
    p_rows: input.rows,
    p_options: input.options,
  });

  if (error) throw new Error(speak(error.message, "匯入失敗，整批都沒有寫進去"));
  return data as {
    purchases_created: number;
    products_created: number;
    approval_status: string;
    needs_approval: boolean;
  };
}

/**
 * 審核／退回。
 *
 * ⚠️ module 只是一個代號。表名與狀態欄位在 inv_approve_record() 裡面，是寫死的
 *    CASE 分支，整支函式沒有一行動態 SQL。
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
