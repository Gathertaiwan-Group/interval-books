/**
 * 推薦碼與分潤的規則 —— 純函式，沒有 I/O。
 *
 * 前台（推薦碼解析、cookie）、結帳（折扣）、後台月結報表（分潤、團隊獎金池、上限、
 * 扣回）全部經過這裡，scripts/referral-selftest.mjs 直接 import 這一份驗證。
 * 設計全文：docs/referral-program.md。
 *
 * ⚠️ 只 import ./taipei-time.ts（零相依），不要加 `@/` alias —— 自檢用 Node 原生
 *    型別剝離直接載入，不經 bundler。
 *
 * 金額一律是新台幣整數。中間計算可以是小數，**對外的每一個金額都經過 Math.round
 * 或 allocateProportional()**，後者保證拆開來的整數加總等於總數。
 */
import { taipeiMonthBounds, taipeiMonthOf } from "./taipei-time.ts";

// =============================================================================
// 1. 推薦碼與 cookie
// =============================================================================

/** 第一方 cookie 名稱。前台 `?ref=CODE` 寫入，結帳讀出。 */
export const REFERRAL_COOKIE = "ib_ref";
/** 30 天。最後一次點的連結蓋掉前一次（last-click wins）。 */
export const REFERRAL_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
/** 與 0039 的 CHECK 同一條規則。 */
export const REFERRAL_CODE_RE = /^[A-Z0-9]{2,20}$/;
/** 分享連結的網址（任何頁面都可以帶 ?ref=）。 */
export const REFERRAL_SITE_URL = "https://www.intervalbooks.tw";

/** 去空白、轉大寫。不驗格式 —— 格式另由 isValidReferralCode() 判斷。 */
export function normalizeReferralCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function isValidReferralCode(code: string): boolean {
  return REFERRAL_CODE_RE.test(code);
}

export function referralLink(code: string): string {
  return `${REFERRAL_SITE_URL}/?ref=${encodeURIComponent(code)}`;
}

/** 從網址的 query string 取出 ref。格式不對回 null（不寫進 cookie）。 */
export function referralCodeFromSearch(search: string): string | null {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("ref");
  } catch {
    return null;
  }
  const code = normalizeReferralCode(value);
  return isValidReferralCode(code) ? code : null;
}

/** `document.cookie = …` 用的字串。 */
export function referralCookieString(code: string, opts: { secure: boolean }): string {
  return (
    `${REFERRAL_COOKIE}=${encodeURIComponent(code)}; Max-Age=${REFERRAL_COOKIE_MAX_AGE}; ` +
    `Path=/; SameSite=Lax${opts.secure ? "; Secure" : ""}`
  );
}

/** 從 `document.cookie` 或 Cookie header 讀出推薦碼。格式不對回 null。 */
export function readReferralCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== REFERRAL_COOKIE) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    const code = normalizeReferralCode(value);
    return isValidReferralCode(code) ? code : null;
  }
  return null;
}

export type ResolvedReferral = { code: string; source: "typed" | "cookie" } | null;

/**
 * 結帳時到底用哪一個碼。
 *
 *   typed === undefined  → 舊版前台沒送這個欄位：退回 cookie。
 *   typed 是空字串       → 客人把預填的碼清掉了：**不用任何碼**（不偷偷套 cookie，
 *                          否則畫面上沒折扣、實際卻折了，兩邊對不上）。
 *   typed 有值           → 打的碼優先（typed wins），即使 cookie 是別人的。
 *
 * typed 的格式不驗：格式錯的碼一樣回傳，讓伺服器回「推薦碼無效」—— 客人看得到
 * 自己打錯，而不是默默沒折扣。cookie 的格式錯就當作沒有（客人沒看過它）。
 */
export function resolveReferralCode(input: {
  typed: string | null | undefined;
  cookie: string | null | undefined;
}): ResolvedReferral {
  if (input.typed === undefined || input.typed === null) {
    const c = normalizeReferralCode(input.cookie);
    return isValidReferralCode(c) ? { code: c, source: "cookie" } : null;
  }
  const t = normalizeReferralCode(input.typed);
  if (t === "") return null;
  return { code: t, source: "typed" };
}

// =============================================================================
// 2. 折扣（只算選品／書籍，不含活動與策旅）
// =============================================================================

/** 參與折扣與分潤的商品類型。event／journey（票券）一律排除。 */
export const SHOP_GOODS_TYPES = ["goods", "book"] as const;

export function isShopGoods(productType: string): boolean {
  return (SHOP_GOODS_TYPES as readonly string[]).includes(productType);
}

/** 百分比轉成以萬分之一為單位的整數，避開 0.1+0.2 這類浮點誤差。 */
function basisPoints(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.round(percent * 100);
}

/**
 * 一張訂單的推薦折扣（整數元）。
 *
 *   折扣 = round(選品小計 × 折扣%)，介於 0 與選品小計之間。
 *
 * 運費不打折、票券不打折。免運門檻照舊用折扣前的小計判斷（computeShippingFee 不動）。
 */
export function computeReferralDiscount(
  lines: readonly { productType: string; subtotal: number }[],
  percent: number,
): number {
  const eligible = lines
    .filter((l) => isShopGoods(l.productType))
    .reduce((n, l) => n + Math.max(0, l.subtotal), 0);
  const bp = Math.min(basisPoints(percent), 10000);
  if (eligible <= 0 || bp === 0) return 0;
  const d = Math.round((eligible * bp) / 10000);
  return Math.max(0, Math.min(eligible, d));
}

/**
 * 依權重把一個整數總額拆成整數（最大餘數法）。加總一定等於 total。
 * 權重全為 0 時平分。
 */
export function allocateProportional(weights: readonly number[], total: number): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sign = total < 0 ? -1 : 1;
  const abs = Math.round(Math.abs(total));
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const eff = sum > 0 ? w : w.map(() => 1);
  const effSum = sum > 0 ? sum : n;
  const raw = eff.map((x) => (abs * x) / effSum);
  const out = raw.map((x) => Math.floor(x));
  let rest = abs - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % n, rest -= 1) out[order[k].i] += 1;
  return out.map((x) => x * sign);
}

// =============================================================================
// 3. 成本與毛利
// =============================================================================

/**
 * 一行商品的成本。
 *
 * 進銷存的 cost_price（× units_per_sale）只有在 0 < 成本 < 售價 時才採用。正式庫
 * 實測（2026-10-20）19 個已上架品項裡有 13 個 cost_price = selling_price、1 個是 0
 * ——那是「沒填」不是「零毛利」，照用會讓分潤變成 0。所以那幾種一律改用估算：
 *
 *   估算成本 = 折後營收 × (1 − 預設毛利率)
 *
 * 報表把估算的那幾行標出來。
 */
export function lineCost(input: {
  unitPrice: number;
  quantity: number;
  netRevenue: number;
  unitCost: number | null | undefined;
  marginPercent: number;
}): { cost: number; estimated: boolean } {
  const { unitPrice, quantity, netRevenue, unitCost, marginPercent } = input;
  if (typeof unitCost === "number" && unitCost > 0 && unitCost < unitPrice) {
    return { cost: unitCost * quantity, estimated: false };
  }
  const margin = Math.min(100, Math.max(0, marginPercent));
  return { cost: netRevenue * (1 - margin / 100), estimated: true };
}

// =============================================================================
// 4. 累進分潤
// =============================================================================

export type CommissionTier = { upTo: number | null; rate: number };

export const DEFAULT_COMMISSION_TIERS: CommissionTier[] = [
  { upTo: 10000, rate: 15 },
  { upTo: 30000, rate: 20 },
  { upTo: null, rate: 25 },
];

/**
 * 驗證級距：upTo 嚴格遞增、最後一級 upTo = null、rate 介於 0–100。不合格回 null。
 */
export function parseCommissionTiers(raw: unknown): CommissionTier[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) return null;
  const tiers: CommissionTier[] = [];
  let prev = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const t = raw[i] as { upTo?: unknown; rate?: unknown } | null;
    if (!t || typeof t !== "object") return null;
    const rate = Number(t.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return null;
    const last = i === raw.length - 1;
    if (last) {
      if (t.upTo !== null && t.upTo !== undefined) return null;
      tiers.push({ upTo: null, rate });
    } else {
      const upTo = Number(t.upTo);
      if (!Number.isFinite(upTo) || !Number.isInteger(upTo) || upTo <= prev) return null;
      tiers.push({ upTo, rate });
      prev = upTo;
    }
  }
  return tiers;
}

/** 累進（像所得稅）：每一段只用自己那一段的費率。回傳未取整。 */
export function tieredCommission(amount: number, tiers: readonly CommissionTier[]): number {
  if (!(amount > 0)) return 0;
  let lower = 0;
  let total = 0;
  for (const t of tiers) {
    const upper = t.upTo === null ? Infinity : t.upTo;
    if (amount <= lower) break;
    const slice = Math.min(amount, upper) - lower;
    if (slice > 0) total += (slice * t.rate) / 100;
    lower = upper;
  }
  return total;
}

// =============================================================================
// 5. 客人身分：自購、新客
// =============================================================================

export function normalizeEmail(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/** 只留數字；+886 9xxxxxxxx 轉成 09xxxxxxxx。 */
export function normalizePhone(v: string | null | undefined): string {
  let d = (v ?? "").replace(/\D/g, "");
  if (d.startsWith("886") && d.length === 12) d = `0${d.slice(3)}`;
  return d;
}

/** 訂單的 email 或手機與推廣者登記的相同 → 自購，不計分潤（折扣照給）。 */
export function isSelfPurchase(
  order: { customerEmail: string; customerPhone: string },
  referrer: { email: string | null; phone: string | null },
): boolean {
  const re = normalizeEmail(referrer.email);
  const rp = normalizePhone(referrer.phone);
  if (re && normalizeEmail(order.customerEmail) === re) return true;
  if (rp && normalizePhone(order.customerPhone) === rp) return true;
  return false;
}

export type CustomerHistoryRow = {
  id: string;
  customerEmail: string;
  customerPhone: string;
  createdAt: string;
};

/**
 * 新客＝這張訂單之前（created_at 較早），同 email 或同手機沒有任何一張**付過款**的訂單
 * （history 由呼叫端只放 payment_status in ('paid','refunded') 的單：退款前也付過）。
 */
export function isNewCustomer(
  order: { id: string; customerEmail: string; customerPhone: string; createdAt: string },
  history: readonly CustomerHistoryRow[],
): boolean {
  const email = normalizeEmail(order.customerEmail);
  const phone = normalizePhone(order.customerPhone);
  const at = Date.parse(order.createdAt);
  return !history.some(
    (h) =>
      h.id !== order.id &&
      Date.parse(h.createdAt) < at &&
      ((email !== "" && normalizeEmail(h.customerEmail) === email) ||
        (phone !== "" && normalizePhone(h.customerPhone) === phone)),
  );
}

// =============================================================================
// 6. 月結報表
// =============================================================================

export type ReferralSettings = {
  defaultDiscountPercent: number;
  defaultMarginPercent: number;
  commissionTiers: CommissionTier[];
  newCustomerMultiplier: number;
  /** null ＝ 不計算團隊獎金池。 */
  teamPoolBaseline: number | null;
  teamPoolPercent: number;
  teamPoolEqualPercent: number;
  payoutCapPercent: number;
  clawbackDays: number;
};

export const DEFAULT_REFERRAL_SETTINGS: ReferralSettings = {
  defaultDiscountPercent: 5,
  defaultMarginPercent: 35,
  commissionTiers: DEFAULT_COMMISSION_TIERS,
  newCustomerMultiplier: 1.25,
  teamPoolBaseline: null,
  teamPoolPercent: 5,
  teamPoolEqualPercent: 50,
  payoutCapPercent: 40,
  clawbackDays: 30,
};

export type ReferrerKind = "team" | "external";

export type ReportReferrer = {
  id: string;
  name: string;
  code: string;
  kind: ReferrerKind;
  email: string | null;
  phone: string | null;
  active: boolean;
  commissionTiers: CommissionTier[] | null;
};

export type ReportOrderItem = {
  productId: string | null;
  productType: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
};

export type ReportOrder = {
  id: string;
  orderNo: string;
  createdAt: string;
  paidAt: string | null;
  status: string;
  paymentStatus: string;
  paymentMethod: string | null;
  discount: number;
  customerEmail: string;
  customerPhone: string;
  referrerId: string | null;
  referralCode: string | null;
  items: ReportOrderItem[];
};

export type SettlementSnapshot = {
  /** 這次結算裡逐筆的分潤（已套上限比例、已取整）。 */
  orders: { id: string; orderNo: string; commission: number }[];
  /** 這次結算扣回的訂單。 */
  clawedBack: { id: string; orderNo: string; amount: number }[];
  capFactor: number;
};

export type ReportSettlement = {
  referrerId: string;
  period: string;
  amount: number;
  commission: number;
  poolShare: number;
  clawback: number;
  snapshot: SettlementSnapshot;
  settledAt: string;
  settledByEmail: string | null;
};

/** 已結算訂單的現況，判斷要不要扣回。 */
export type OrderState = {
  id: string;
  orderNo: string;
  status: string;
  paymentStatus: string;
  cancelledAt: string | null;
  updatedAt: string;
};

/** 這張訂單現在還算不算數（已付款、沒取消、沒退款、不是沙盒單）。 */
export function orderCounts(o: {
  status: string;
  paymentStatus: string;
  paymentMethod?: string | null;
}): boolean {
  if (o.paymentStatus !== "paid") return false;
  if (o.status === "cancelled" || o.status === "failed") return false;
  if (o.paymentMethod === "test_paid") return false;
  return true;
}

export type OrderLineResult = {
  id: string;
  orderNo: string;
  paidAt: string | null;
  referralCode: string | null;
  customerType: "new" | "returning";
  excluded: "self" | null;
  /** 選品折扣前小計。 */
  goodsSubtotal: number;
  discount: number;
  /** 選品折後營收。 */
  netRevenue: number;
  cost: number;
  costEstimated: boolean;
  grossProfit: number;
  /** 套上限比例、取整後的分潤。 */
  commission: number;
};

export type ReferrerResult = {
  referrer: ReportReferrer;
  orders: OrderLineResult[];
  attributedRevenue: number;
  attributedGrossProfit: number;
  /** 這個月的平均級距費率（%）。 */
  averageRate: number;
  commissionBeforeCap: number;
  commission: number;
  poolShareBeforeCap: number;
  poolShare: number;
  clawback: { amount: number; orders: { id: string; orderNo: string; amount: number }[] };
  payable: number;
  settlement: ReportSettlement | null;
  /** 已結算但現在重算的應付與當時不同（例如結算後才補登的訂單）。 */
  settledDiffers: boolean;
};

export type MonthlyReport = {
  period: string;
  shop: {
    orderCount: number;
    revenue: number;
    grossProfit: number;
    estimatedLines: number;
    totalLines: number;
  };
  pool: {
    enabled: boolean;
    baseline: number | null;
    excess: number;
    amount: number;
    members: number;
    /** 沒有團隊成員時，池子算得出來但沒有人分。 */
    undistributed: boolean;
  };
  cap: { limit: number; requested: number; factor: number; applied: boolean };
  referrers: ReferrerResult[];
  totals: { commission: number; poolShare: number; clawback: number; payable: number };
};

type OrderCalc = {
  order: ReportOrder;
  goodsSubtotal: number;
  discount: number;
  netRevenue: number;
  cost: number;
  costEstimated: boolean;
  estimatedLines: number;
  totalLines: number;
  grossProfit: number;
};

function calcOrder(
  order: ReportOrder,
  unitCosts: ReadonlyMap<string, number | null>,
  marginPercent: number,
): OrderCalc {
  const goods = order.items.filter((i) => isShopGoods(i.productType));
  const goodsSubtotal = goods.reduce((n, i) => n + i.subtotal, 0);
  const discount = Math.max(0, Math.min(goodsSubtotal, order.discount));
  const shares = allocateProportional(
    goods.map((i) => i.subtotal),
    discount,
  );
  let cost = 0;
  let estimatedLines = 0;
  goods.forEach((item, idx) => {
    const net = item.subtotal - (shares[idx] ?? 0);
    const c = lineCost({
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      netRevenue: net,
      unitCost: item.productId ? (unitCosts.get(item.productId) ?? null) : null,
      marginPercent,
    });
    cost += c.cost;
    if (c.estimated) estimatedLines += 1;
  });
  const netRevenue = goodsSubtotal - discount;
  return {
    order,
    goodsSubtotal,
    discount,
    netRevenue,
    cost,
    costEstimated: estimatedLines > 0,
    estimatedLines,
    totalLines: goods.length,
    // 單筆毛利不為負：折扣吃掉毛利的那一單分潤是 0，不倒扣。
    grossProfit: Math.max(0, netRevenue - cost),
  };
}

/**
 * 某一個月（台北）的分潤報表。
 *
 * 規則（docs/referral-program.md §4）：
 *  1. 算數的訂單：paid_at 落在這個月、payment_status = paid、沒取消、不是沙盒單。
 *  2. 歸屬毛利 G = 該推廣者名下（排除自購）每單選品折後毛利之和。
 *  3. 基本分潤 = 累進級距(G)；平均費率 r = 基本分潤 / G。
 *     每單分潤 = 該單毛利 × r × (新客 ? 新客倍率 : 1)。
 *  4. 團隊獎金池 = max(0, 全站線上選品營收 − 門檻) × 池%；分給「團隊成員且啟用」的
 *     推廣者：平分 equal% ，其餘按各自歸屬毛利占比（大家都是 0 就也平分）。
 *  5. 上限：所有分潤＋獎金池 > 全站選品毛利 × cap% 時，全部等比例縮到剛好等於上限。
 *  6. 扣回：已結算月份的訂單，若在該月結束後 clawbackDays 天內被取消／退款，
 *     從還沒結算的這個月扣掉當時付出的那一筆（每筆只扣一次）。
 *  7. 應付 = 分潤 + 獎金池 − 扣回。
 *
 * 已經結算過的月份：分潤、獎金池重算後照樣顯示，扣回改用結算當時的快照（不會因為
 * 之後又有人退款而改變已付的那個月）；若重算的應付與已付不同，settledDiffers = true。
 */
export function computeMonthlyReport(input: {
  period: string;
  /** 至少要涵蓋這個月 paid_at 的所有訂單；其他月份的會被濾掉。 */
  orders: readonly ReportOrder[];
  referrers: readonly ReportReferrer[];
  settings: ReferralSettings;
  /** product_id → 單位成本（進銷存 cost_price × units_per_sale），沒有就是 null／不在表裡。 */
  unitCosts: ReadonlyMap<string, number | null>;
  /** 付過款的訂單（paid/refunded），判斷新舊客。 */
  customerHistory: readonly CustomerHistoryRow[];
  /** 所有推廣者、所有月份的結算紀錄。 */
  settlements: readonly ReportSettlement[];
  /** 出現在任何結算快照裡的訂單的現況。 */
  settledOrderStates: ReadonlyMap<string, OrderState>;
}): MonthlyReport {
  const { period, settings } = input;
  const monthOrders = input.orders.filter(
    (o) => taipeiMonthOf(o.paidAt) === period && orderCounts(o),
  );
  const calcs = monthOrders.map((o) =>
    calcOrder(o, input.unitCosts, settings.defaultMarginPercent),
  );

  // ---- 全站 ----------------------------------------------------------------
  const shopRevenue = calcs.reduce((n, c) => n + c.netRevenue, 0);
  const shopGrossProfit = calcs.reduce((n, c) => n + c.grossProfit, 0);

  // ---- 每位推廣者的基本分潤 --------------------------------------------------
  type Work = {
    referrer: ReportReferrer;
    lines: (OrderCalc & { isNew: boolean; excluded: "self" | null; raw: number })[];
    g: number;
    avgRate: number;
    commissionRaw: number;
  };
  const works: Work[] = input.referrers.map((referrer) => {
    const mine = calcs.filter((c) => c.order.referrerId === referrer.id);
    const lines = mine.map((c) => ({
      ...c,
      isNew: isNewCustomer(c.order, input.customerHistory),
      excluded: isSelfPurchase(c.order, referrer) ? ("self" as const) : null,
      raw: 0,
    }));
    const g = lines.filter((l) => !l.excluded).reduce((n, l) => n + l.grossProfit, 0);
    const tiers = referrer.commissionTiers ?? settings.commissionTiers;
    const base = tieredCommission(g, tiers);
    const avgRate = g > 0 ? base / g : 0;
    for (const l of lines) {
      if (l.excluded) continue;
      l.raw = l.grossProfit * avgRate * (l.isNew ? settings.newCustomerMultiplier : 1);
    }
    return {
      referrer,
      lines,
      g,
      avgRate,
      commissionRaw: lines.reduce((n, l) => n + l.raw, 0),
    };
  });

  // ---- 團隊獎金池 ------------------------------------------------------------
  const poolEnabled = settings.teamPoolBaseline !== null;
  const excess = poolEnabled ? Math.max(0, shopRevenue - (settings.teamPoolBaseline ?? 0)) : 0;
  const poolAmount = (excess * settings.teamPoolPercent) / 100;
  const members = works.filter((w) => w.referrer.kind === "team" && w.referrer.active);
  const poolRaw = new Map<string, number>();
  if (poolAmount > 0 && members.length > 0) {
    const equalPart = (poolAmount * settings.teamPoolEqualPercent) / 100;
    const profitPart = poolAmount - equalPart;
    const gSum = members.reduce((n, w) => n + w.g, 0);
    for (const w of members) {
      const byProfit = gSum > 0 ? (profitPart * w.g) / gSum : profitPart / members.length;
      poolRaw.set(w.referrer.id, equalPart / members.length + byProfit);
    }
  }

  // ---- 上限 ------------------------------------------------------------------
  const requested =
    works.reduce((n, w) => n + w.commissionRaw, 0) +
    [...poolRaw.values()].reduce((a, b) => a + b, 0);
  const limit = (shopGrossProfit * settings.payoutCapPercent) / 100;
  const factor = requested > limit && requested > 0 ? limit / requested : 1;

  // ---- 扣回 ------------------------------------------------------------------
  const { endIso: periodEndIso } = taipeiMonthBounds(period);
  const periodEnd = Date.parse(periodEndIso);
  const dayMs = 24 * 3600 * 1000;

  const results: ReferrerResult[] = works.map((w) => {
    const commission = Math.round(w.commissionRaw * factor);
    const perOrder = allocateProportional(
      w.lines.map((l) => l.raw),
      commission,
    );
    const poolShareBeforeCap = Math.round(poolRaw.get(w.referrer.id) ?? 0);
    const poolShare = Math.round((poolRaw.get(w.referrer.id) ?? 0) * factor);

    const mySettlements = input.settlements.filter((s) => s.referrerId === w.referrer.id);
    const settlement = mySettlements.find((s) => s.period === period) ?? null;
    let clawOrders: { id: string; orderNo: string; amount: number }[];
    if (settlement) {
      clawOrders = settlement.snapshot.clawedBack ?? [];
    } else {
      const already = new Set(
        mySettlements.flatMap((s) => (s.snapshot.clawedBack ?? []).map((c) => c.id)),
      );
      clawOrders = [];
      for (const s of mySettlements) {
        if (s.period >= period) continue;
        const windowEnd =
          Date.parse(taipeiMonthBounds(s.period).endIso) + settings.clawbackDays * dayMs;
        for (const so of s.snapshot.orders ?? []) {
          if (so.commission <= 0 || already.has(so.id)) continue;
          const st = input.settledOrderStates.get(so.id);
          if (!st || orderCounts(st)) continue;
          const when = Date.parse(st.cancelledAt ?? st.updatedAt);
          if (Number.isNaN(when) || when > windowEnd || when >= periodEnd) continue;
          clawOrders.push({ id: so.id, orderNo: so.orderNo, amount: so.commission });
          already.add(so.id);
        }
      }
    }
    const clawAmount = clawOrders.reduce((n, c) => n + c.amount, 0);
    const payable = commission + poolShare - clawAmount;

    return {
      referrer: w.referrer,
      orders: w.lines.map((l, i) => ({
        id: l.order.id,
        orderNo: l.order.orderNo,
        paidAt: l.order.paidAt,
        referralCode: l.order.referralCode,
        customerType: l.isNew ? ("new" as const) : ("returning" as const),
        excluded: l.excluded,
        goodsSubtotal: l.goodsSubtotal,
        discount: l.discount,
        netRevenue: l.netRevenue,
        cost: Math.round(l.cost),
        costEstimated: l.costEstimated,
        grossProfit: Math.round(l.grossProfit),
        commission: perOrder[i] ?? 0,
      })),
      attributedRevenue: w.lines.filter((l) => !l.excluded).reduce((n, l) => n + l.netRevenue, 0),
      attributedGrossProfit: Math.round(w.g),
      averageRate: Math.round(w.avgRate * 10000) / 100,
      commissionBeforeCap: Math.round(w.commissionRaw),
      commission,
      poolShareBeforeCap,
      poolShare,
      clawback: { amount: clawAmount, orders: clawOrders },
      payable,
      settlement,
      settledDiffers: settlement !== null && settlement.amount !== payable,
    };
  });

  return {
    period,
    shop: {
      orderCount: calcs.filter((c) => c.totalLines > 0).length,
      revenue: shopRevenue,
      grossProfit: Math.round(shopGrossProfit),
      estimatedLines: calcs.reduce((n, c) => n + c.estimatedLines, 0),
      totalLines: calcs.reduce((n, c) => n + c.totalLines, 0),
    },
    pool: {
      enabled: poolEnabled,
      baseline: settings.teamPoolBaseline,
      excess,
      amount: Math.round(poolAmount),
      members: members.length,
      undistributed: poolAmount > 0 && members.length === 0,
    },
    cap: {
      limit: Math.round(limit),
      requested: Math.round(requested),
      factor,
      applied: factor < 1,
    },
    referrers: results,
    totals: {
      commission: results.reduce((n, r) => n + r.commission, 0),
      poolShare: results.reduce((n, r) => n + r.poolShare, 0),
      clawback: results.reduce((n, r) => n + r.clawback.amount, 0),
      payable: results.reduce((n, r) => n + r.payable, 0),
    },
  };
}

/** 結算時存進 referral_settlements.snapshot 的內容。 */
export function snapshotFor(result: ReferrerResult, capFactor: number): SettlementSnapshot {
  return {
    orders: result.orders
      .filter((o) => !o.excluded)
      .map((o) => ({ id: o.id, orderNo: o.orderNo, commission: o.commission })),
    clawedBack: result.clawback.orders,
    capFactor,
  };
}
