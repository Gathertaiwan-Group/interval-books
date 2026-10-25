/**
 * 廠商主檔 —— 這一頁**所有**資料庫存取的唯一出口，以及這個專案的 PII 治理規則。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 這個檔案的治理規則（下一個人打開檔案就該看到的四條）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── §1  一律列明欄位，禁止 select *  ─────────────────────────────────────
 *
 * inv.vendors 有 48 欄，其中五個是身分證字號、統一編號、國外識別碼、居留證號碼
 * 與銀行帳號。`select *` 在這張表上的意思是「把那五個欄位送進瀏覽器」，而它會在
 * JSON response、React props、devtools、以及任何一個 error reporting SDK 的
 * breadcrumb 裡各留一份。
 *
 * 來源系統就是這樣做的（VendorManagement.tsx:73 是 `.select('*')`），然後在畫面上
 * 補一句 `id_number.slice(0, 3) + '***'`。那是**純視覺遮罩，零防護價值** ——
 * 完整值早就到了。
 *
 * 所以這個檔案裡每一支查詢都有一個具名的欄位常數（LIST_COLUMNS、DETAIL_COLUMNS…），
 * 而且那些常數對到的 view 本身就送不出原值（0019 §3）。兩層都不靠自律。
 *
 * ── §2  敏感欄位走 readVendorSensitive()，而且一定留痕 ──────────────────
 *
 * 完整值只有一個出口：readVendorSensitive()，它呼叫 0019 §4 的
 * public.inv_vendor_sensitive()。那支函式在回傳之前**先寫一筆
 * public.pii_access_log**，兩件事在同一個交易 —— 讀成功 ⇔ 有紀錄，兩者不可能
 * 分開。
 *
 * 呼叫它需要 `inv.vendor.pii.read`，而那個檢查在 fns/inv-vendors.ts 裡重讀
 * context.staff.permissions（不信任前端）。
 *
 * ⚠️ **不要**在這個檔案裡加第二支讀原值的函式。加了就等於多一條不留痕的路，
 *    而稽核軌跡只要有一條旁路就等於沒有。
 *
 * ── §3  廠商自助入口：vendor_id 只從 session 來 ─────────────────────────
 *
 * 這個檔案的 vendor* 系列函式（vendorProfile / vendorProducts / …）簽名裡
 * **沒有 vendorId 參數**，只有 userId。過濾條件住在資料庫函式裡（0019 §7 的
 * public.vendor_my_id()），呼叫端沒有地方可以指定要看哪一家。
 *
 * 這不是「我們有檢查」，是那個參數不存在。要偽造成別家廠商得先偽造 userId，而
 * 那個值來自 sealed httpOnly cookie（src/server/vendor-auth.ts），不是 request
 * body。
 *
 * ── §4  附件的檔案內容永遠是短效 signed URL ─────────────────────────────
 *
 * vendor-attachments 是 private bucket（0019 §9.1）。這個檔案不回傳任何可以直接
 * 打開的網址；要看檔案得走 src/server/storage.ts#signedVendorAttachmentUrl，
 * 那裡簽出來的 URL 有效期以分鐘計。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── 這一層存在的理由（與 repos/inv-products.ts 同一條）────────────────────
 * inv 不在 PostgREST 的 db_schema 裡。所以連 service_role 的 supabase-js client
 * 都**打不到** inv.* —— 要讀就走 0019 的 view，要寫就呼叫 SECURITY DEFINER 函式。
 *
 * ── 錯誤一律 throw，不吞 ──────────────────────────────────────────────────
 * 沒有任何一個 catch 會把錯誤變成空陣列或 null。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";

// ---------------------------------------------------------------------------
// 型別
// ---------------------------------------------------------------------------

/** 0019 §3.1 的 inv_admin_vendor_list。⚠️ 識別碼一律是 *_masked。 */
export type AdminVendorRow = {
  vendor_id: string;
  vendor_code: string | null;
  name: string;
  short_name: string | null;
  name_en: string | null;
  entity_type: string;
  category_id: string | null;
  category_name: string | null;
  is_consignment: boolean;
  is_preferred: boolean | null;
  status: string;
  approval_status: string;
  approved_at: string | null;
  approved_by_name: string | null;
  phone: string | null;
  email: string | null;
  tax_id_masked: string | null;
  id_number_masked: string | null;
  has_tax_id: boolean;
  has_id_number: boolean;
  has_foreign_id: boolean;
  commission_rate: number | null;
  payment_terms: string | null;
  created_at: string;
  updated_at: string;
  product_count: number;
  active_product_count: number;
  stock_units: number;
  purchase_count: number;
  bank_account_count: number;
  attachment_count: number;
  contract_end_date: string | null;
  portal_account_count: number;
};

/** 0019 §3.2 的 inv_admin_vendor_detail。⚠️ 四個識別碼只有 *_masked 版本。 */
export type AdminVendorDetail = {
  vendor_id: string;
  vendor_code: string | null;
  entity_type: string;
  category_id: string | null;
  name: string;
  name_en: string | null;
  short_name: string | null;
  representative: string | null;
  is_preferred: boolean | null;
  notes: string | null;
  tax_id_masked: string | null;
  id_number_masked: string | null;
  foreign_id_masked: string | null;
  residence_permit_number_masked: string | null;
  foreign_id_type: string | null;
  taiwan_residency_status: string | null;
  country_code: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  address: string | null;
  address_en: string | null;
  invoice_address: string | null;
  default_tax_type_id: string | null;
  default_withholding_category_id: string | null;
  is_nhi_applicable: boolean | null;
  voucher_category: string | null;
  einvoice_type: string | null;
  payment_terms: string | null;
  payment_terms_note: string | null;
  settlement_type: string | null;
  settlement_start_day: number | null;
  settlement_interval_days: number | null;
  bill_due_day: number | null;
  is_consignment: boolean;
  cash_fee_rate: number | null;
  domestic_card_fee_rate: number | null;
  foreign_card_fee_rate: number | null;
  commission_rate: number | null;
  status: string;
  approval_status: string;
  approved_at: string | null;
  approved_by_name: string | null;
  created_at: string;
  updated_at: string;
  creator_name: string | null;
};

export type AdminVendorContact = {
  contact_id: string;
  vendor_id: string;
  name: string;
  job_title: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  is_primary: boolean | null;
  is_finance_contact: boolean | null;
  notes: string | null;
  sort_order: number | null;
  created_at: string;
};

/** ⚠️ account_number 只有遮罩版。完整值走 readVendorSensitive()。 */
export type AdminVendorBankAccount = {
  bank_account_id: string;
  vendor_id: string;
  account_holder_name: string;
  bank_code: string;
  bank_name: string;
  branch_code: string | null;
  branch_name: string | null;
  account_number_masked: string | null;
  account_purpose: string | null;
  is_default: boolean | null;
  notes: string | null;
  sort_order: number | null;
  created_at: string;
};

export type AdminVendorAttachment = {
  attachment_id: string;
  vendor_id: string;
  file_name: string;
  file_path: string;
  file_type: string;
  file_size: number | null;
  description: string | null;
  attachment_type: string;
  contract_start_date: string | null;
  contract_end_date: string | null;
  contract_version: string | null;
  is_current: boolean | null;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
};

export type VendorLookupRow = { id: string; code: string; name: string };
export type TaxTypeRow = { tax_type_id: string; code: string; name: string; rate: number };
export type WithholdingRow = { withholding_category_id: string; code: string; name: string };
export type VendorCategoryRow = { category_id: string; name: string; is_active: boolean };

/** 0019 §1.5 的 inv_admin_pii_access_log。 */
export type PiiAccessLogRow = {
  log_id: string;
  accessed_at: string;
  actor_user_id: string;
  actor_email: string;
  access_kind: string;
  subject_table: string;
  subject_id: string;
  subject_label: string | null;
  fields: string[];
  reason: string;
};

// ---------------------------------------------------------------------------
// 欄位清單 —— §1：一律列明，禁止 select *
// ---------------------------------------------------------------------------

const LIST_COLUMNS =
  "vendor_id, vendor_code, name, short_name, name_en, entity_type, category_id, category_name, " +
  "is_consignment, is_preferred, status, approval_status, approved_at, approved_by_name, " +
  "phone, email, tax_id_masked, id_number_masked, has_tax_id, has_id_number, has_foreign_id, " +
  "commission_rate, payment_terms, created_at, updated_at, product_count, active_product_count, " +
  "stock_units, purchase_count, bank_account_count, attachment_count, contract_end_date, " +
  "portal_account_count";

const DETAIL_COLUMNS =
  "vendor_id, vendor_code, entity_type, category_id, name, name_en, short_name, representative, " +
  "is_preferred, notes, tax_id_masked, id_number_masked, foreign_id_masked, " +
  "residence_permit_number_masked, foreign_id_type, taiwan_residency_status, country_code, " +
  "phone, fax, email, address, address_en, invoice_address, default_tax_type_id, " +
  "default_withholding_category_id, is_nhi_applicable, voucher_category, einvoice_type, " +
  "payment_terms, payment_terms_note, settlement_type, settlement_start_day, " +
  "settlement_interval_days, bill_due_day, is_consignment, cash_fee_rate, " +
  "domestic_card_fee_rate, foreign_card_fee_rate, commission_rate, status, approval_status, " +
  "approved_at, approved_by_name, created_at, updated_at, creator_name";

const CONTACT_COLUMNS =
  "contact_id, vendor_id, name, job_title, phone, mobile, email, is_primary, " +
  "is_finance_contact, notes, sort_order, created_at";

const BANK_COLUMNS =
  "bank_account_id, vendor_id, account_holder_name, bank_code, bank_name, branch_code, " +
  "branch_name, account_number_masked, account_purpose, is_default, notes, sort_order, created_at";

const ATTACHMENT_COLUMNS =
  "attachment_id, vendor_id, file_name, file_path, file_type, file_size, description, " +
  "attachment_type, contract_start_date, contract_end_date, contract_version, is_current, " +
  "uploaded_by, uploaded_by_name, created_at";

const PII_LOG_COLUMNS =
  "log_id, accessed_at, actor_user_id, actor_email, access_kind, subject_table, subject_id, " +
  "subject_label, fields, reason";

// ---------------------------------------------------------------------------
// 讀
// ---------------------------------------------------------------------------

export type VendorFilter = {
  keyword: string | null;
  entityType: "all" | "domestic_company" | "domestic_individual" | "foreign" | "foreign_individual";
  consignment: "all" | "yes" | "no";
  status: "all" | "active" | "suspended" | "inactive";
  approvalStatus: "all" | "pending" | "approved" | "rejected";
  sort: "name_asc" | "name_desc" | "code_asc" | "created_desc" | "products_desc";
};

const SORTS: Record<VendorFilter["sort"], { column: string; ascending: boolean }> = {
  name_asc: { column: "name", ascending: true },
  name_desc: { column: "name", ascending: false },
  code_asc: { column: "vendor_code", ascending: true },
  created_desc: { column: "created_at", ascending: false },
  products_desc: { column: "product_count", ascending: false },
};

/**
 * 廠商清單。
 *
 * 沒有分頁：正式庫 14 家，這是一家獨立書店的往來對象數量，不會變成 1,400 家。
 * limit 500 是防呆不是分頁（與 inv-combos.ts#listAdminComboSets 同一條）。
 */
export async function listAdminVendors(filter: VendorFilter): Promise<AdminVendorRow[]> {
  const sort = SORTS[filter.sort] ?? SORTS.name_asc;

  let query = supabaseAdmin()
    .from("inv_admin_vendor_list")
    .select(LIST_COLUMNS)
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    // 第二排序鍵：沒有它的話同名的列順序是不確定的。
    .order("vendor_id", { ascending: true })
    .limit(500);

  if (filter.entityType !== "all") query = query.eq("entity_type", filter.entityType);
  if (filter.consignment !== "all")
    query = query.eq("is_consignment", filter.consignment === "yes");
  if (filter.status !== "all") query = query.eq("status", filter.status);
  if (filter.approvalStatus !== "all") query = query.eq("approval_status", filter.approvalStatus);
  if (filter.keyword) {
    // PostgREST 的 or() 用逗號與括號當分隔符，所以那兩個字元要先拿掉
    // （與 inv-combos.ts / inv-products.ts 同一支）。
    const safe = filter.keyword.replace(/[(),]/g, " ").trim();
    if (safe) {
      // ⚠️ 搜尋範圍刻意**不含**任何識別碼欄位。允許用統編搜尋等於做出一個
      //    「輸入一個號碼、回答這個號碼在不在庫裡」的預言機 —— 那是一條不留痕
      //    的資訊外洩管道，即使它一個字元都沒有回傳。
      query = query.or(
        `name.ilike.%${safe}%,short_name.ilike.%${safe}%,name_en.ilike.%${safe}%,` +
          `vendor_code.ilike.%${safe}%,phone.ilike.%${safe}%,email.ilike.%${safe}%`,
      );
    }
  }

  const { data, error } = await query;
  if (error) throw new Error(`[repo/inv-vendors] 廠商清單讀取失敗：${error.message}`);
  return (data ?? []) as unknown as AdminVendorRow[];
}

/** 清單 view 的單一列（內頁標題列與統計數字用；欄位與 listAdminVendors 相同）。 */
export async function getAdminVendorRow(vendorId: string): Promise<AdminVendorRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_vendor_list")
    .select(LIST_COLUMNS)
    .eq("vendor_id", vendorId)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[repo/inv-vendors] 廠商讀取失敗：${error.message}`);
  return (data as unknown as AdminVendorRow | null) ?? null;
}

export async function getAdminVendor(vendorId: string): Promise<AdminVendorDetail | null> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_vendor_detail")
    .select(DETAIL_COLUMNS)
    .eq("vendor_id", vendorId)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[repo/inv-vendors] 廠商讀取失敗：${error.message}`);
  return (data as unknown as AdminVendorDetail | null) ?? null;
}

export async function listVendorContacts(vendorId: string): Promise<AdminVendorContact[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_vendor_contacts")
    .select(CONTACT_COLUMNS)
    .eq("vendor_id", vendorId)
    .order("is_primary", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw new Error(`[repo/inv-vendors] 聯絡人讀取失敗：${error.message}`);
  return (data ?? []) as unknown as AdminVendorContact[];
}

export async function listVendorBankAccounts(vendorId: string): Promise<AdminVendorBankAccount[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_vendor_bank_accounts")
    .select(BANK_COLUMNS)
    .eq("vendor_id", vendorId)
    .order("is_default", { ascending: false })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw new Error(`[repo/inv-vendors] 匯款帳戶讀取失敗：${error.message}`);
  return (data ?? []) as unknown as AdminVendorBankAccount[];
}

export async function listVendorAttachments(vendorId: string): Promise<AdminVendorAttachment[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_admin_vendor_attachments")
    .select(ATTACHMENT_COLUMNS)
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`[repo/inv-vendors] 附件讀取失敗：${error.message}`);
  return (data ?? []) as unknown as AdminVendorAttachment[];
}

export async function listVendorFormOptions(): Promise<{
  categories: VendorCategoryRow[];
  taxTypes: TaxTypeRow[];
  withholdingCategories: WithholdingRow[];
}> {
  const db = supabaseAdmin();
  const [categories, taxTypes, withholding] = await Promise.all([
    db
      .from("inv_admin_vendor_categories")
      .select("category_id, name, is_active")
      .order("sort_order", { ascending: true }),
    db
      .from("inv_admin_tax_types")
      .select("tax_type_id, code, name, rate")
      .order("sort_order", { ascending: true }),
    db
      .from("inv_admin_withholding_categories")
      .select("withholding_category_id, code, name")
      .order("sort_order", { ascending: true }),
  ]);

  if (categories.error)
    throw new Error(`[repo/inv-vendors] 廠商類別讀取失敗：${categories.error.message}`);
  if (taxTypes.error) throw new Error(`[repo/inv-vendors] 稅別讀取失敗：${taxTypes.error.message}`);
  if (withholding.error)
    throw new Error(`[repo/inv-vendors] 扣繳類別讀取失敗：${withholding.error.message}`);

  return {
    categories: (categories.data ?? []) as unknown as VendorCategoryRow[],
    taxTypes: (taxTypes.data ?? []) as unknown as TaxTypeRow[],
    withholdingCategories: (withholding.data ?? []) as unknown as WithholdingRow[],
  };
}

// ---------------------------------------------------------------------------
// §2  敏感欄位 —— 唯一的出口，而且一定留痕
// ---------------------------------------------------------------------------

/** 白名單。與 0019 §4 的 v_allowed 逐字對齊。 */
export const VENDOR_SENSITIVE_FIELDS = [
  "tax_id",
  "id_number",
  "foreign_id",
  "residence_permit_number",
  "bank_accounts",
] as const;
export type VendorSensitiveField = (typeof VENDOR_SENSITIVE_FIELDS)[number];

export const PII_ACCESS_REASONS = [
  "reconciliation",
  "payment",
  "tax_filing",
  "vendor_enquiry",
  "self_service",
] as const;
export type PiiAccessReason = (typeof PII_ACCESS_REASONS)[number];

export type VendorSensitiveResult = {
  vendor_id: string;
  log_id: string;
  fields: string[];
  values: {
    tax_id?: string | null;
    id_number?: string | null;
    foreign_id?: string | null;
    residence_permit_number?: string | null;
    bank_accounts?: {
      bank_account_id: string;
      account_holder_name: string;
      bank_code: string;
      bank_name: string;
      branch_code: string | null;
      branch_name: string | null;
      account_number: string;
      account_purpose: string | null;
      is_default: boolean;
    }[];
  };
};

/**
 * 讀廠商的完整識別碼／銀行帳號。
 *
 * ⚠️ **這是整個 codebase 裡唯一讀得到那些原值的地方。** 不要再加第二支 —— 稽核
 *    軌跡只要有一條旁路就等於沒有。
 *
 * ⚠️ 呼叫這一支就等於留下一筆 pii_access_log。那不是副作用，是它的一半工作：
 *    0019 §4 的函式先寫紀錄再組值，兩件事在同一個交易裡，所以「拿到值但沒留下
 *    紀錄」在結構上不可能發生。
 *
 * ⚠️ 權限檢查不在這裡，在 fns/inv-vendors.ts（那一層才拿得到 session）。這一層
 *    假設呼叫端已經檢查過 —— 與 src/server/repos/** 的整體約定一致
 *    （見 lib/admin/middleware.ts 檔頭）。
 */
export async function readVendorSensitive(input: {
  actorUserId: string;
  actorEmail: string;
  vendorId: string;
  fields: VendorSensitiveField[];
  reason: PiiAccessReason;
  accessKind?: "staff" | "self";
}): Promise<VendorSensitiveResult> {
  const { data, error } = await supabaseAdmin().rpc("inv_vendor_sensitive", {
    p_actor_user_id: input.actorUserId,
    p_actor_email: input.actorEmail,
    p_vendor_id: input.vendorId,
    p_fields: input.fields,
    p_reason: input.reason,
    p_access_kind: input.accessKind ?? "staff",
  });

  if (error) throw new Error(speak(error.message, "敏感欄位讀取失敗"));
  return data as unknown as VendorSensitiveResult;
}

/**
 * 稽核軌跡。
 *
 * ⚠️ 讀這一支需要 role='admin'，**不是** inv.vendor.pii.read。看得到別人的查閱
 *    紀錄跟看得到廠商資料是兩種權限：把它們綁在一起等於讓每一個查得到身分證的人
 *    同時查得到同事的查閱習慣。檢查在 fns/inv-vendors.ts。
 */
export async function listPiiAccessLog(input: {
  vendorId: string | null;
  actorUserId: string | null;
  limit: number;
}): Promise<PiiAccessLogRow[]> {
  let query = supabaseAdmin()
    .from("inv_admin_pii_access_log")
    .select(PII_LOG_COLUMNS)
    .order("accessed_at", { ascending: false })
    .limit(input.limit);

  if (input.vendorId) query = query.eq("subject_id", input.vendorId);
  if (input.actorUserId) query = query.eq("actor_user_id", input.actorUserId);

  const { data, error } = await query;
  if (error) throw new Error(`[repo/inv-vendors] 稽核紀錄讀取失敗：${error.message}`);
  return (data ?? []) as unknown as PiiAccessLogRow[];
}

// ---------------------------------------------------------------------------
// 寫 —— 全部走 0019 的 SECURITY DEFINER 函式
// ---------------------------------------------------------------------------

/** 把 PL/pgSQL 的 `PREFIX: 中文訊息` 剝成給店員看的那一句（與 inv-combos.ts 同一支）。 */
function speak(message: string, fallback: string): string {
  return message.replace(/^[A-Z_]+:\s*/, "").trim() || fallback;
}

export async function saveVendor(input: {
  userId: string;
  id: string | null;
  payload: Record<string, unknown>;
}): Promise<{ id: string; created: boolean; vendor_code: string; approval_status: string }> {
  const { data, error } = await supabaseAdmin().rpc("inv_save_vendor", {
    p_user_id: input.userId,
    p_id: input.id,
    p_payload: input.payload,
  });

  if (error) throw new Error(speak(error.message, "廠商儲存失敗，請再試一次"));
  return data as { id: string; created: boolean; vendor_code: string; approval_status: string };
}

export async function saveVendorBankAccount(input: {
  userId: string;
  vendorId: string;
  id: string | null;
  payload: Record<string, unknown>;
}): Promise<{ id: string; created: boolean }> {
  const { data, error } = await supabaseAdmin().rpc("inv_save_vendor_bank_account", {
    p_user_id: input.userId,
    p_vendor_id: input.vendorId,
    p_id: input.id,
    p_payload: input.payload,
  });

  if (error) throw new Error(speak(error.message, "匯款帳戶儲存失敗，請再試一次"));
  return data as { id: string; created: boolean };
}

export async function saveVendorContact(input: {
  userId: string;
  vendorId: string;
  id: string | null;
  payload: Record<string, unknown>;
}): Promise<{ id: string; created: boolean }> {
  const { data, error } = await supabaseAdmin().rpc("inv_save_vendor_contact", {
    p_user_id: input.userId,
    p_vendor_id: input.vendorId,
    p_id: input.id,
    p_payload: input.payload,
  });

  if (error) throw new Error(speak(error.message, "聯絡人儲存失敗，請再試一次"));
  return data as { id: string; created: boolean };
}

export async function saveVendorAttachment(input: {
  userId: string;
  vendorId: string;
  payload: Record<string, unknown>;
}): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin().rpc("inv_save_vendor_attachment", {
    p_user_id: input.userId,
    p_vendor_id: input.vendorId,
    p_payload: input.payload,
  });

  if (error) throw new Error(speak(error.message, "附件儲存失敗，請再試一次"));
  return data as { id: string };
}

/**
 * 刪一筆子項目。
 *
 * ⚠️ vendorId 一定要傳，而且資料庫那一支會用它當 WHERE 條件的一部分：「刪掉一個
 *    id」與「刪掉這家的一個 id」是兩件事，只有後者擋得住「猜一個 uuid 去刪別家的
 *    東西」。
 */
export async function deleteVendorChild(input: {
  kind: "bank_account" | "contact" | "attachment";
  vendorId: string;
  id: string;
}): Promise<{ deleted: number; file_path: string | null }> {
  const { data, error } = await supabaseAdmin().rpc("inv_delete_vendor_child", {
    p_kind: input.kind,
    p_vendor_id: input.vendorId,
    p_id: input.id,
  });

  if (error) throw new Error(speak(error.message, "刪除失敗，請再試一次"));
  return data as { deleted: number; file_path: string | null };
}

export async function deleteVendor(vendorId: string): Promise<{ id: string; name: string }> {
  const { data, error } = await supabaseAdmin().rpc("inv_delete_vendor", { p_id: vendorId });
  if (error) throw new Error(speak(error.message, "刪除失敗，請再試一次"));
  return data as { id: string; name: string };
}

// ---------------------------------------------------------------------------
// 廠商自助入口的帳號管理（店家這一側）
// ---------------------------------------------------------------------------

export type VendorPortalAccount = {
  user_id: string;
  vendor_id: string;
  is_active: boolean;
  created_at: string;
  email: string | null;
};

export async function listVendorPortalAccounts(vendorId: string): Promise<VendorPortalAccount[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("vendor_users")
    .select("user_id, vendor_id, is_active, created_at")
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`[repo/inv-vendors] 入口帳號讀取失敗：${error.message}`);
  const rows = (data ?? []) as {
    user_id: string;
    vendor_id: string;
    is_active: boolean;
    created_at: string;
  }[];
  if (rows.length === 0) return [];

  const { data: profiles, error: profileError } = await db
    .from("profiles")
    .select("id, email")
    .in(
      "id",
      rows.map((r) => r.user_id),
    );

  if (profileError) throw new Error(`[repo/inv-vendors] 入口帳號讀取失敗：${profileError.message}`);
  const emails = new Map((profiles ?? []).map((p) => [p.id as string, p.email as string | null]));

  return rows.map((r) => ({ ...r, email: emails.get(r.user_id) ?? null }));
}

/**
 * 停權／復權一個入口帳號。
 *
 * ⚠️ 這裡**不建帳號**。auth.users 一律在 Supabase dashboard 手動建立（與整個
 *    後台同一條規矩，見 auth.ts 檔頭「there is no public sign-up」）。這一支只
 *    負責把一個已經存在的帳號綁到一家廠商，或把綁定關掉。
 */
export async function setVendorPortalAccountActive(input: {
  vendorId: string;
  userId: string;
  isActive: boolean;
}): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("vendor_users")
    .update({ is_active: input.isActive, updated_at: new Date().toISOString() })
    .eq("user_id", input.userId)
    // ⚠️ vendor_id 也進 WHERE：只有「這家的帳號」才停得掉。
    .eq("vendor_id", input.vendorId);

  if (error) throw new Error(`[repo/inv-vendors] 入口帳號更新失敗：${error.message}`);
}

// ---------------------------------------------------------------------------
// §3  廠商自助入口 —— 每一支都只收 userId，沒有 vendorId
// ---------------------------------------------------------------------------

export type VendorPortalProduct = {
  inv_product_id: string;
  name: string;
  issue_number: string | null;
  series: string | null;
  publisher: string | null;
  barcode: string | null;
  notes: string | null;
  image_key: string | null;
  product_type: string;
  selling_price: number | null;
  stock_quantity: number;
  pack_size: number;
  is_active: boolean;
  approval_status: string;
  approved_at: string | null;
  submitted_via: string;
  created_at: string;
  updated_at: string;
  sold_quantity: number;
  listed_slug: string | null;
  listed_status: string | null;
};

/**
 * 廠商看自己的基本資料。
 *
 * ⚠️ 簽名裡沒有 vendorId。哪一家由 0019 §7.4 的 vendor_my_id() 從 userId 推導。
 * ⚠️ 回傳的銀行帳號是**遮罩版**。廠商要看自己的完整帳號，走 readVendorSensitive()
 *    並帶 accessKind='self' —— 和店員同一條路、同一份稽核軌跡。
 */
export async function vendorPortalProfile(userId: string): Promise<{
  vendor: AdminVendorDetail | null;
  bank_accounts: AdminVendorBankAccount[];
}> {
  const { data, error } = await supabaseAdmin().rpc("inv_vendor_profile", { p_user_id: userId });
  if (error) throw new Error(speak(error.message, "廠商資料讀取失敗"));
  return data as unknown as {
    vendor: AdminVendorDetail | null;
    bank_accounts: AdminVendorBankAccount[];
  };
}

/** 廠商看自己的商品。⚠️ 過濾條件在資料庫函式裡，不在這裡。 */
export async function vendorPortalProducts(userId: string): Promise<VendorPortalProduct[]> {
  const { data, error } = await supabaseAdmin().rpc("inv_vendor_products", { p_user_id: userId });
  if (error) throw new Error(speak(error.message, "商品清單讀取失敗"));
  return (data ?? []) as unknown as VendorPortalProduct[];
}

/**
 * 廠商送審一件商品（或修改自己還在待審核的那一件）。
 *
 * ⚠️ approval_status 由資料庫寫死成 'pending'，**不看 approval_settings**
 *    （0019 §0.2）。廠商送的是外部投稿，跟「店家信不信自己的店員」無關。
 * ⚠️ 庫存、成本、product_type、vendor_id 全部由資料庫決定，payload 送了也不會被讀。
 */
export async function vendorPortalSubmitProduct(input: {
  userId: string;
  id: string | null;
  payload: Record<string, unknown>;
}): Promise<{ id: string; created: boolean; approval_status: string }> {
  const { data, error } = await supabaseAdmin().rpc("inv_vendor_submit_product", {
    p_user_id: input.userId,
    p_id: input.id,
    p_payload: input.payload,
  });

  if (error) throw new Error(speak(error.message, "送審失敗，請再試一次"));
  return data as { id: string; created: boolean; approval_status: string };
}

export async function vendorPortalWithdrawProduct(input: {
  userId: string;
  id: string;
}): Promise<{ id: string; name: string }> {
  const { data, error } = await supabaseAdmin().rpc("inv_vendor_withdraw_product", {
    p_user_id: input.userId,
    p_id: input.id,
  });

  if (error) throw new Error(speak(error.message, "撤回失敗，請再試一次"));
  return data as { id: string; name: string };
}

/**
 * 店家核准廠商送審的商品，可選同時上架。
 *
 * ⚠️ 三語文案是**店員**在核准對話框裡填的。廠商送不進來（0011 §「兩邊的資料形狀
 *    不一樣」：沒有人能從「紅烏龍茶餅」自動生出可以放在英文站上的商品名）。
 * ⚠️ 上架的兩個 insert 在同一個資料庫交易裡 —— 這與
 *    repos/inventory-listing.ts#createInventoryListing 的兩個獨立 insert 加手動
 *    回捲不同，那個回捲自己也可能失敗。
 */
export async function approveVendorProduct(input: {
  userId: string;
  id: string;
  approved: boolean;
  listing: Record<string, unknown> | null;
}): Promise<{
  changed: boolean;
  previous_status: string | null;
  listed: boolean;
  product_id?: string;
  slug?: string;
}> {
  const { data, error } = await supabaseAdmin().rpc("inv_approve_vendor_product", {
    p_user_id: input.userId,
    p_id: input.id,
    p_approved: input.approved,
    p_listing: input.listing,
  });

  if (error) {
    if (error.code === "23505") {
      throw new Error("上架失敗：這個網址代稱已經被用掉了，請換一個");
    }
    throw new Error(speak(error.message, "審核失敗，請再試一次"));
  }
  return data as {
    changed: boolean;
    previous_status: string | null;
    listed: boolean;
    product_id?: string;
    slug?: string;
  };
}

/** 0019 §7.8 的 inv_admin_vendor_submissions。 */
export type VendorSubmissionRow = {
  inv_product_id: string;
  name: string;
  issue_number: string | null;
  series: string | null;
  publisher: string | null;
  barcode: string | null;
  notes: string | null;
  image_key: string | null;
  selling_price: number | null;
  approval_status: string;
  submitted_via: string;
  created_at: string;
  updated_at: string;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_code: string | null;
  vendor_is_consignment: boolean | null;
  vendor_commission_rate: number | null;
};

const SUBMISSION_COLUMNS =
  "inv_product_id, name, issue_number, series, publisher, barcode, notes, image_key, " +
  "selling_price, approval_status, submitted_via, created_at, updated_at, vendor_id, " +
  "vendor_name, vendor_code, vendor_is_consignment, vendor_commission_rate";

/**
 * 後台的「廠商送審」佇列。
 *
 * ⚠️ 這個 view 只有 submitted_via = 'vendor_portal' 的商品 —— 店員自己建的走
 *    /admin/inventory-products，兩者的審核標準不同（廠商送的要對照合約）。
 */
export async function listVendorSubmissions(
  approvalStatus: "all" | "pending" | "approved" | "rejected",
): Promise<VendorSubmissionRow[]> {
  let query = supabaseAdmin()
    .from("inv_admin_vendor_submissions")
    .select(SUBMISSION_COLUMNS)
    .order("created_at", { ascending: true })
    .limit(500);

  if (approvalStatus !== "all") query = query.eq("approval_status", approvalStatus);

  const { data, error } = await query;
  if (error) throw new Error(`[repo/inv-vendors] 待審清單讀取失敗：${error.message}`);
  return (data ?? []) as unknown as VendorSubmissionRow[];
}
