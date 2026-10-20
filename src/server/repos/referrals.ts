/**
 * 推薦碼與分潤的資料層（0039）。
 *
 * 三張表（referrers / referral_settings / referral_settlements）與 orders 都是 RLS 開、
 * 零 policy、只 grant service_role —— 這裡是唯一的入口。
 *
 *   · findReferrerForCheckout() 由結帳（公開、未登入）呼叫：只回 id／碼／折扣%。
 *   · 其餘全部只由 src/lib/admin/fns/referrals.ts 呼叫，那裡每一支都掛 adminFnMiddleware；
 *     這個檔案假設呼叫端已授權（與 src/server/repos/** 其他檔案同一個約定）。
 *
 * 計算規則全部在 src/lib/referral.ts（純函式、有自檢）；這裡只負責把資料讀齊。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import {
  computeMonthlyReport,
  DEFAULT_REFERRAL_SETTINGS,
  normalizeReferralCode,
  parseCommissionTiers,
  snapshotFor,
  type CommissionTier,
  type MonthlyReport,
  type OrderState,
  type ReferralSettings,
  type ReferrerKind,
  type ReportOrder,
  type ReportReferrer,
  type ReportSettlement,
  type SettlementSnapshot,
} from "@/lib/referral";
import { currentTaipeiMonth, isValidPeriod, taipeiMonthBounds } from "@/lib/taipei-time";

// -----------------------------------------------------------------------------
// 設定
// -----------------------------------------------------------------------------

const SETTINGS_COLUMNS =
  "default_discount_percent, default_margin_percent, commission_tiers, new_customer_multiplier, " +
  "team_pool_baseline, team_pool_percent, team_pool_equal_percent, payout_cap_percent, clawback_days";

type SettingsRow = {
  default_discount_percent: number | string;
  default_margin_percent: number | string;
  commission_tiers: unknown;
  new_customer_multiplier: number | string;
  team_pool_baseline: number | null;
  team_pool_percent: number | string;
  team_pool_equal_percent: number | string;
  payout_cap_percent: number | string;
  clawback_days: number;
};

function settingsFromRow(row: SettingsRow | null): ReferralSettings {
  if (!row) return DEFAULT_REFERRAL_SETTINGS;
  return {
    defaultDiscountPercent: Number(row.default_discount_percent),
    defaultMarginPercent: Number(row.default_margin_percent),
    commissionTiers:
      parseCommissionTiers(row.commission_tiers) ?? DEFAULT_REFERRAL_SETTINGS.commissionTiers,
    newCustomerMultiplier: Number(row.new_customer_multiplier),
    teamPoolBaseline: row.team_pool_baseline === null ? null : Number(row.team_pool_baseline),
    teamPoolPercent: Number(row.team_pool_percent),
    teamPoolEqualPercent: Number(row.team_pool_equal_percent),
    payoutCapPercent: Number(row.payout_cap_percent),
    clawbackDays: Number(row.clawback_days),
  };
}

export async function getReferralSettings(): Promise<ReferralSettings> {
  const { data, error } = await supabaseAdmin()
    .from("referral_settings")
    .select(SETTINGS_COLUMNS)
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`讀取分潤設定失敗：${error.message}`);
  return settingsFromRow(data as unknown as SettingsRow | null);
}

export async function updateReferralSettings(s: ReferralSettings): Promise<void> {
  const { error } = await supabaseAdmin().from("referral_settings").upsert({
    id: 1,
    default_discount_percent: s.defaultDiscountPercent,
    default_margin_percent: s.defaultMarginPercent,
    commission_tiers: s.commissionTiers,
    new_customer_multiplier: s.newCustomerMultiplier,
    team_pool_baseline: s.teamPoolBaseline,
    team_pool_percent: s.teamPoolPercent,
    team_pool_equal_percent: s.teamPoolEqualPercent,
    payout_cap_percent: s.payoutCapPercent,
    clawback_days: s.clawbackDays,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`儲存分潤設定失敗：${error.message}`);
}

// -----------------------------------------------------------------------------
// 結帳用
// -----------------------------------------------------------------------------

/**
 * 結帳時查推薦碼：只回啟用中的推廣者，且只回 id／碼／折扣%。
 * 查不到、停用、表還不存在（0039 未套用）一律回 null —— 呼叫端決定要不要拒絕。
 */
export async function findReferrerForCheckout(
  rawCode: string,
): Promise<{ id: string; code: string; discountPercent: number } | null> {
  const code = normalizeReferralCode(rawCode);
  if (!code) return null;
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("referrers")
    .select("id, code, discount_percent")
    .eq("code", code)
    .eq("active", true)
    .maybeSingle();
  if (error) {
    console.error("[referral] findReferrerForCheckout failed", error.code, error.message);
    return null;
  }
  if (!data) return null;
  const row = data as unknown as { id: string; code: string; discount_percent: number | null };
  let pct = row.discount_percent === null ? null : Number(row.discount_percent);
  if (pct === null) {
    try {
      pct = (await getReferralSettings()).defaultDiscountPercent;
    } catch {
      pct = DEFAULT_REFERRAL_SETTINGS.defaultDiscountPercent;
    }
  }
  return { id: row.id, code: row.code, discountPercent: pct };
}

// -----------------------------------------------------------------------------
// 推廣者
// -----------------------------------------------------------------------------

export type ReferrerRow = {
  id: string;
  name: string;
  code: string;
  kind: ReferrerKind;
  contact: string | null;
  email: string | null;
  phone: string | null;
  base_salary: number | null;
  discount_percent: number | null;
  commission_tiers: CommissionTier[] | null;
  active: boolean;
  note: string | null;
  created_at: string;
};

const REFERRER_COLUMNS =
  "id, name, code, kind, contact, email, phone, base_salary, discount_percent, commission_tiers, active, note, created_at";

function referrerFromRow(r: Record<string, unknown>): ReferrerRow {
  return {
    id: String(r.id),
    name: String(r.name),
    code: String(r.code),
    kind: r.kind === "team" ? "team" : "external",
    contact: (r.contact as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    base_salary:
      r.base_salary === null || r.base_salary === undefined ? null : Number(r.base_salary),
    discount_percent:
      r.discount_percent === null || r.discount_percent === undefined
        ? null
        : Number(r.discount_percent),
    commission_tiers: parseCommissionTiers(r.commission_tiers),
    active: r.active === true,
    note: (r.note as string | null) ?? null,
    created_at: String(r.created_at),
  };
}

export async function listReferrers(): Promise<ReferrerRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("referrers")
    .select(REFERRER_COLUMNS)
    .order("active", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`讀取推廣者失敗：${error.message}`);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(referrerFromRow);
}

export type ReferrerInput = {
  name: string;
  code: string;
  kind: ReferrerKind;
  contact: string | null;
  email: string | null;
  phone: string | null;
  baseSalary: number | null;
  discountPercent: number | null;
  commissionTiers: CommissionTier[] | null;
  active: boolean;
  note: string | null;
};

export type SaveReferrerResult = { ok: true; id: string } | { ok: false; reason: "code_taken" };

function rowFromInput(input: ReferrerInput) {
  return {
    name: input.name.trim(),
    code: normalizeReferralCode(input.code),
    kind: input.kind,
    contact: input.contact?.trim() || null,
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    base_salary: input.baseSalary,
    discount_percent: input.discountPercent,
    commission_tiers: input.commissionTiers,
    active: input.active,
    note: input.note?.trim() || null,
  };
}

export async function createReferrer(input: ReferrerInput): Promise<SaveReferrerResult> {
  const { data, error } = await supabaseAdmin()
    .from("referrers")
    .insert(rowFromInput(input))
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { ok: false, reason: "code_taken" };
    throw new Error(`新增推廣者失敗：${error.message}`);
  }
  return { ok: true, id: String((data as { id: string }).id) };
}

export async function updateReferrer(
  id: string,
  input: ReferrerInput,
): Promise<SaveReferrerResult> {
  const { error } = await supabaseAdmin()
    .from("referrers")
    .update({ ...rowFromInput(input), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    if (error.code === "23505") return { ok: false, reason: "code_taken" };
    throw new Error(`更新推廣者失敗：${error.message}`);
  }
  return { ok: true, id };
}

// -----------------------------------------------------------------------------
// 月結報表
// -----------------------------------------------------------------------------

const ORDER_COLUMNS =
  "id, order_no, created_at, paid_at, status, payment_status, payment_method, discount, " +
  "customer_email, customer_phone, referrer_id, referral_code, " +
  "order_items(product_id, product_type, unit_price, quantity, subtotal)";

type OrderRaw = {
  id: string;
  order_no: string;
  created_at: string;
  paid_at: string | null;
  status: string;
  payment_status: string;
  payment_method: string | null;
  discount: number;
  customer_email: string;
  customer_phone: string;
  referrer_id: string | null;
  referral_code: string | null;
  order_items:
    | {
        product_id: string | null;
        product_type: string;
        unit_price: number;
        quantity: number;
        subtotal: number;
      }[]
    | null;
};

function toReportOrder(o: OrderRaw): ReportOrder {
  return {
    id: o.id,
    orderNo: o.order_no,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    status: o.status,
    paymentStatus: o.payment_status,
    paymentMethod: o.payment_method,
    discount: o.discount,
    customerEmail: o.customer_email,
    customerPhone: o.customer_phone,
    referrerId: o.referrer_id,
    referralCode: o.referral_code,
    items: (o.order_items ?? []).map((i) => ({
      productId: i.product_id,
      productType: i.product_type,
      unitPrice: i.unit_price,
      quantity: i.quantity,
      subtotal: i.subtotal,
    })),
  };
}

/** product_id → 單位成本（進銷存 cost_price × units_per_sale）。 */
async function loadUnitCosts(productIds: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (productIds.length === 0) return out;
  const db = supabaseAdmin();
  const { data: links, error } = await db
    .from("product_inventory_links")
    .select("product_id, inv_product_id, units_per_sale")
    .in("product_id", productIds);
  if (error) throw new Error(`讀取進銷存連結失敗：${error.message}`);
  const linkRows = (links ?? []) as unknown as {
    product_id: string;
    inv_product_id: string;
    units_per_sale: number;
  }[];
  if (linkRows.length === 0) return out;
  const { data: costs, error: costError } = await db
    .from("inv_admin_products")
    .select("inv_product_id, cost_price")
    .in(
      "inv_product_id",
      linkRows.map((l) => l.inv_product_id),
    );
  if (costError) throw new Error(`讀取進價失敗：${costError.message}`);
  const costById = new Map(
    (
      (costs ?? []) as unknown as { inv_product_id: string; cost_price: number | string | null }[]
    ).map((c) => [c.inv_product_id, c.cost_price === null ? null : Number(c.cost_price)]),
  );
  for (const l of linkRows) {
    const c = costById.get(l.inv_product_id);
    out.set(l.product_id, c === null || c === undefined ? null : c * (l.units_per_sale || 1));
  }
  return out;
}

function settlementFromRow(r: Record<string, unknown>): ReportSettlement {
  const snap = (r.snapshot ?? {}) as Partial<SettlementSnapshot>;
  return {
    referrerId: String(r.referrer_id),
    period: String(r.period),
    amount: Number(r.amount),
    commission: Number(r.commission),
    poolShare: Number(r.pool_share),
    clawback: Number(r.clawback),
    snapshot: {
      orders: Array.isArray(snap.orders) ? snap.orders : [],
      clawedBack: Array.isArray(snap.clawedBack) ? snap.clawedBack : [],
      capFactor: typeof snap.capFactor === "number" ? snap.capFactor : 1,
    },
    settledAt: String(r.settled_at),
    settledByEmail: (r.settled_by_email as string | null) ?? null,
  };
}

export async function getMonthlyReport(period: string): Promise<MonthlyReport> {
  if (!isValidPeriod(period)) throw new Error("月份格式錯誤");
  const db = supabaseAdmin();
  const { startIso, endIso } = taipeiMonthBounds(period);

  const [settings, referrers, ordersRes, settlementsRes] = await Promise.all([
    getReferralSettings(),
    listReferrers(),
    db
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("payment_status", "paid")
      .gte("paid_at", startIso)
      .lt("paid_at", endIso)
      .limit(5000),
    db
      .from("referral_settlements")
      .select(
        "referrer_id, period, amount, commission, pool_share, clawback, snapshot, settled_at, settled_by_email",
      ),
  ]);
  if (ordersRes.error) throw new Error(`讀取訂單失敗：${ordersRes.error.message}`);
  if (settlementsRes.error) throw new Error(`讀取結算紀錄失敗：${settlementsRes.error.message}`);

  const orders = ((ordersRes.data ?? []) as unknown as OrderRaw[]).map(toReportOrder);
  const settlements = ((settlementsRes.data ?? []) as unknown as Record<string, unknown>[]).map(
    settlementFromRow,
  );

  // 新舊客：只查有推薦人的那幾張單的客人。
  const attributed = orders.filter((o) => o.referrerId !== null);
  const emails = [...new Set(attributed.map((o) => o.customerEmail).filter(Boolean))];
  const phones = [...new Set(attributed.map((o) => o.customerPhone).filter(Boolean))];
  const historyMap = new Map<
    string,
    { id: string; customerEmail: string; customerPhone: string; createdAt: string }
  >();
  const addHistory = (rows: unknown) => {
    for (const h of (rows ?? []) as {
      id: string;
      customer_email: string;
      customer_phone: string;
      created_at: string;
    }[]) {
      historyMap.set(h.id, {
        id: h.id,
        customerEmail: h.customer_email,
        customerPhone: h.customer_phone,
        createdAt: h.created_at,
      });
    }
  };
  for (const [col, values] of [
    ["customer_email", emails],
    ["customer_phone", phones],
  ] as const) {
    if (values.length === 0) continue;
    const { data, error } = await db
      .from("orders")
      .select("id, customer_email, customer_phone, created_at")
      .in("payment_status", ["paid", "refunded"])
      .lt("created_at", endIso)
      .in(col, values);
    if (error) throw new Error(`讀取客人歷史訂單失敗：${error.message}`);
    addHistory(data);
  }

  const productIds = [
    ...new Set(
      orders.flatMap((o) =>
        o.items.map((i) => i.productId).filter((id): id is string => typeof id === "string"),
      ),
    ),
  ];
  const unitCosts = await loadUnitCosts(productIds);

  // 扣回：已結算快照裡的訂單現況。
  const settledIds = [...new Set(settlements.flatMap((s) => s.snapshot.orders.map((o) => o.id)))];
  const settledOrderStates = new Map<string, OrderState>();
  for (let i = 0; i < settledIds.length; i += 200) {
    const chunk = settledIds.slice(i, i + 200);
    const { data, error } = await db
      .from("orders")
      .select("id, order_no, status, payment_status, cancelled_at, updated_at")
      .in("id", chunk);
    if (error) throw new Error(`讀取已結算訂單失敗：${error.message}`);
    for (const r of (data ?? []) as {
      id: string;
      order_no: string;
      status: string;
      payment_status: string;
      cancelled_at: string | null;
      updated_at: string;
    }[]) {
      settledOrderStates.set(r.id, {
        id: r.id,
        orderNo: r.order_no,
        status: r.status,
        paymentStatus: r.payment_status,
        cancelledAt: r.cancelled_at,
        updatedAt: r.updated_at,
      });
    }
  }

  const reportReferrers: ReportReferrer[] = referrers.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    kind: r.kind,
    email: r.email,
    phone: r.phone,
    active: r.active,
    commissionTiers: r.commission_tiers,
  }));

  return computeMonthlyReport({
    period,
    orders,
    referrers: reportReferrers,
    settings,
    unitCosts,
    customerHistory: [...historyMap.values()],
    settlements,
    settledOrderStates,
  });
}

export type SettleResult =
  | { ok: true; amount: number }
  | { ok: false; reason: "month_not_over" | "already_settled" | "not_found" };

/**
 * 標記某位推廣者某個月已結算。金額由伺服器重算（不接受呼叫端送金額），
 * unique(referrer_id, period) 讓同一個月不可能結兩次。
 * 只能結「已經過完」的月份（台北時間）。
 */
export async function settleReferrerMonth(input: {
  referrerId: string;
  period: string;
  actorId: string;
  actorEmail: string;
  note: string | null;
}): Promise<SettleResult> {
  if (!isValidPeriod(input.period) || input.period >= currentTaipeiMonth()) {
    return { ok: false, reason: "month_not_over" };
  }
  const report = await getMonthlyReport(input.period);
  const r = report.referrers.find((x) => x.referrer.id === input.referrerId);
  if (!r) return { ok: false, reason: "not_found" };
  if (r.settlement) return { ok: false, reason: "already_settled" };

  const { error } = await supabaseAdmin()
    .from("referral_settlements")
    .insert({
      referrer_id: input.referrerId,
      period: input.period,
      amount: r.payable,
      commission: r.commission,
      pool_share: r.poolShare,
      clawback: r.clawback.amount,
      snapshot: snapshotFor(r, report.cap.factor),
      settled_by: input.actorId,
      settled_by_email: input.actorEmail,
      note: input.note,
    });
  if (error) {
    if (error.code === "23505") return { ok: false, reason: "already_settled" };
    throw new Error(`結算失敗：${error.message}`);
  }
  return { ok: true, amount: r.payable };
}
