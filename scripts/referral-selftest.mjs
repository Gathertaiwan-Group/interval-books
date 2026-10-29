#!/usr/bin/env node
/**
 * 推薦碼與分潤的自檢（0040）。
 *
 * 直接 import 產線的 src/lib/referral.ts 與 src/lib/taipei-time.ts（Node 原生型別剝離），
 * 驗的是真的那份程式：推薦碼解析與 cookie 優先序、折扣取整、累進分潤、新客倍率、
 * 團隊獎金池、發放上限、扣回、自購與退款排除、台北月界。另外掃原始碼確認：
 * 後台 server fn 每一支都掛 adminFnMiddleware、結帳的折扣是伺服器算的、側欄有入口。
 *
 * 執行：node scripts/referral-selftest.mjs（或 npm test）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
} from "./lib/migration-ledger.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/referral-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");

let pass = 0;
let fail = 0;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function check(label, actual, expected, hint) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
    if (hint) console.log(red(`      ${hint}`));
  }
}
const checkTrue = (label, v, hint) => check(label, v === true, true, hint);
const read = (rel) => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch (err) {
    throw new Error(
      `讀不到 ${rel}：${err.code ?? err.message}（不回空字串，否則否定斷言會靜默通過）`,
    );
  }
};

console.log("═══ 推薦碼與分潤自檢 ═══");

let R;
let T;
try {
  R = await import(join(ROOT, "src/lib/referral.ts"));
  T = await import(join(ROOT, "src/lib/taipei-time.ts"));
  pass += 1;
  console.log(green("  ✓ 載入 src/lib/referral.ts 與 taipei-time.ts"));
} catch (err) {
  fail += 1;
  console.log(red(`  ✗ 無法載入：${err}`));
  console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
console.log("\n[1] 推薦碼解析與 cookie 優先序");
// -----------------------------------------------------------------------------
check("轉大寫、去空白", R.normalizeReferralCode("  am y "), "AMY");
check("非字串 → 空字串", R.normalizeReferralCode(null), "");
checkTrue("AMY 合法", R.isValidReferralCode("AMY"));
check("A 太短", R.isValidReferralCode("A"), false);
check("含符號不合法", R.isValidReferralCode("AMY!"), false);
check("21 碼太長", R.isValidReferralCode("A".repeat(21)), false);
check("?ref=amy → AMY", R.referralCodeFromSearch("?ref=amy"), "AMY");
check("沒有 ref → null", R.referralCodeFromSearch("?x=1"), null);
check("ref 格式錯 → null（不寫 cookie）", R.referralCodeFromSearch("?ref=<script>"), null);
check("讀 cookie", R.readReferralCookie("a=1; ib_ref=AMY; b=2"), "AMY");
check("cookie 小寫也轉大寫", R.readReferralCookie("ib_ref=amy"), "AMY");
check("沒有 cookie", R.readReferralCookie("a=1"), null);
check("cookie 格式錯 → null", R.readReferralCookie("ib_ref=%E4%BD%A0"), null);
check("空 header", R.readReferralCookie(""), null);
const ck = R.referralCookieString("AMY", { secure: true });
checkTrue("cookie 30 天", ck.includes(`Max-Age=${30 * 86400}`));
checkTrue("cookie Path=/ SameSite=Lax Secure", /Path=\/; SameSite=Lax; Secure$/.test(ck));
check("分享連結", R.referralLink("AMY"), "https://www.intervalbooks.tw/?ref=AMY");
check(
  "沒送 typed（舊前台）→ 用 cookie",
  R.resolveReferralCode({ typed: undefined, cookie: "AMY" }),
  { code: "AMY", source: "cookie" },
);
check("打的碼優先於 cookie（typed wins）", R.resolveReferralCode({ typed: "bob", cookie: "AMY" }), {
  code: "BOB",
  source: "typed",
});
check(
  "客人清空欄位 → 不用任何碼（不偷偷套 cookie）",
  R.resolveReferralCode({ typed: "  ", cookie: "AMY" }),
  null,
);
check(
  "typed 格式錯也回傳（讓伺服器回無效，而不是默默沒折扣）",
  R.resolveReferralCode({ typed: "a!", cookie: null }),
  { code: "A!", source: "typed" },
);
check("cookie 格式錯 → null", R.resolveReferralCode({ typed: undefined, cookie: "x" }), null);

// -----------------------------------------------------------------------------
console.log("\n[2] 折扣：只算選品、取整到元、不會為負、不超過小計");
// -----------------------------------------------------------------------------
const L = (productType, subtotal) => ({ productType, subtotal });
check("95 折：1000 → 50", R.computeReferralDiscount([L("book", 1000)], 5), 50);
check("1234 × 5% = 61.7 → 62", R.computeReferralDiscount([L("goods", 1234)], 5), 62);
check("1230 × 5% = 61.5 → 62（四捨五入）", R.computeReferralDiscount([L("goods", 1230)], 5), 62);
check("1229 × 5% = 61.45 → 61", R.computeReferralDiscount([L("goods", 1229)], 5), 61);
check(
  "活動、策旅票券不打折",
  R.computeReferralDiscount([L("event", 1800), L("journey", 5000), L("book", 300)], 5),
  15,
);
check("全是票券 → 0", R.computeReferralDiscount([L("event", 1800)], 10), 0);
check("0% → 0", R.computeReferralDiscount([L("book", 300)], 0), 0);
check("負的 % → 0", R.computeReferralDiscount([L("book", 300)], -5), 0);
check("NaN % → 0", R.computeReferralDiscount([L("book", 300)], NaN), 0);
check("超過 100% 也不超過小計", R.computeReferralDiscount([L("book", 300)], 150), 300);
check("小數 %：7.5% of 999 = 74.925 → 75", R.computeReferralDiscount([L("book", 999)], 7.5), 75);
check(
  "allocate 加總等於總額",
  R.allocateProportional([100, 200, 300], 31).reduce((a, b) => a + b, 0),
  31,
);
check("allocate 依比例", R.allocateProportional([100, 300], 40), [10, 30]);
check("allocate 權重全 0 → 平分", R.allocateProportional([0, 0], 3), [2, 1]);
check("allocate 空陣列", R.allocateProportional([], 5), []);

// -----------------------------------------------------------------------------
console.log("\n[3] 成本與毛利");
// -----------------------------------------------------------------------------
check(
  "進價可信（0<成本<售價）→ 用進價",
  R.lineCost({ unitPrice: 200, quantity: 2, netRevenue: 380, unitCost: 150, marginPercent: 35 }),
  { cost: 300, estimated: false },
);
check(
  "成本 = 售價（沒填）→ 估算",
  R.lineCost({ unitPrice: 200, quantity: 1, netRevenue: 200, unitCost: 200, marginPercent: 35 }),
  { cost: 130, estimated: true },
);
check(
  "成本 0 → 估算",
  R.lineCost({ unitPrice: 200, quantity: 1, netRevenue: 200, unitCost: 0, marginPercent: 35 }),
  { cost: 130, estimated: true },
);
check(
  "沒有連結進銷存 → 估算",
  R.lineCost({ unitPrice: 100, quantity: 1, netRevenue: 100, unitCost: null, marginPercent: 40 }),
  { cost: 60, estimated: true },
);

// -----------------------------------------------------------------------------
console.log("\n[4] 累進分潤（像所得稅，不是跳級）");
// -----------------------------------------------------------------------------
const tiers = R.DEFAULT_COMMISSION_TIERS;
check("0 → 0", R.tieredCommission(0, tiers), 0);
check("10,000 → 1,500", R.tieredCommission(10000, tiers), 1500);
check("20,000 → 1,500 + 2,000", R.tieredCommission(20000, tiers), 3500);
check("40,000 → 1,500 + 4,000 + 2,500", R.tieredCommission(40000, tiers), 8000);
check("負數 → 0", R.tieredCommission(-5, tiers), 0);
check(
  "合法級距",
  R.parseCommissionTiers([
    { upTo: 100, rate: 10 },
    { upTo: null, rate: 20 },
  ]),
  [
    { upTo: 100, rate: 10 },
    { upTo: null, rate: 20 },
  ],
);
check("最後一級不是 null → 不合法", R.parseCommissionTiers([{ upTo: 100, rate: 10 }]), null);
check(
  "upTo 沒遞增 → 不合法",
  R.parseCommissionTiers([
    { upTo: 100, rate: 1 },
    { upTo: 50, rate: 2 },
    { upTo: null, rate: 3 },
  ]),
  null,
);
check("rate > 100 → 不合法", R.parseCommissionTiers([{ upTo: null, rate: 101 }]), null);
check("空陣列 → 不合法", R.parseCommissionTiers([]), null);

// -----------------------------------------------------------------------------
console.log("\n[5] 自購與新客");
// -----------------------------------------------------------------------------
const amyRef = { email: "Amy@Example.com ", phone: "+886 912-345-678" };
checkTrue(
  "email 相同（不分大小寫）→ 自購",
  R.isSelfPurchase({ customerEmail: "amy@example.com", customerPhone: "0900000000" }, amyRef),
);
checkTrue(
  "手機相同（+886 格式）→ 自購",
  R.isSelfPurchase({ customerEmail: "x@y.z", customerPhone: "0912345678" }, amyRef),
);
check(
  "都不同 → 不是自購",
  R.isSelfPurchase({ customerEmail: "x@y.z", customerPhone: "0900000000" }, amyRef),
  false,
);
check(
  "推廣者沒登記聯絡方式 → 不是自購",
  R.isSelfPurchase({ customerEmail: "", customerPhone: "" }, { email: null, phone: null }),
  false,
);
const hist = [
  {
    id: "h1",
    customerEmail: "old@x.com",
    customerPhone: "0911111111",
    createdAt: "2026-08-01T00:00:00Z",
  },
];
checkTrue(
  "沒有之前付款的單 → 新客",
  R.isNewCustomer(
    {
      id: "o",
      customerEmail: "new@x.com",
      customerPhone: "0922222222",
      createdAt: "2026-10-01T00:00:00Z",
    },
    hist,
  ),
);
check(
  "同 email 之前付過 → 舊客",
  R.isNewCustomer(
    {
      id: "o",
      customerEmail: "OLD@x.com",
      customerPhone: "0922222222",
      createdAt: "2026-10-01T00:00:00Z",
    },
    hist,
  ),
  false,
);
check(
  "同手機之前付過 → 舊客",
  R.isNewCustomer(
    {
      id: "o",
      customerEmail: "a@b.c",
      customerPhone: "0911-111-111",
      createdAt: "2026-10-01T00:00:00Z",
    },
    hist,
  ),
  false,
);
checkTrue(
  "之後才付的那張不算「之前」",
  R.isNewCustomer(
    { id: "o", customerEmail: "old@x.com", customerPhone: "", createdAt: "2026-07-01T00:00:00Z" },
    hist,
  ),
);

// -----------------------------------------------------------------------------
console.log("\n[6] 台北月界");
// -----------------------------------------------------------------------------
check("UTC 9/30 16:00 → 台北 10 月", T.taipeiMonthOf("2026-09-30T16:00:00Z"), "2026-10");
check("UTC 9/30 15:59 → 台北 9 月", T.taipeiMonthOf("2026-09-30T15:59:59Z"), "2026-09");
check("跨年 UTC 12/31 16:00 → 2027-01", T.taipeiMonthOf("2026-12-31T16:00:00Z"), "2027-01");
check("bounds 10 月", T.taipeiMonthBounds("2026-10"), {
  startIso: "2026-09-30T16:00:00.000Z",
  endIso: "2026-10-31T16:00:00.000Z",
});
check("bounds 12 月跨年", T.taipeiMonthBounds("2026-12").endIso, "2026-12-31T16:00:00.000Z");
check("shiftPeriod 往前跨年", T.shiftPeriod("2026-01", -1), "2025-12");
check("shiftPeriod 往後跨年", T.shiftPeriod("2026-12", 1), "2027-01");
check("null → null", T.taipeiMonthOf(null), null);
check("非法 period", T.isValidPeriod("2026-13"), false);

// -----------------------------------------------------------------------------
console.log("\n[7] 月結報表");
// -----------------------------------------------------------------------------
const S = { ...R.DEFAULT_REFERRAL_SETTINGS, defaultMarginPercent: 50 };
const amy = {
  id: "r-amy",
  name: "Amy",
  code: "AMY",
  kind: "team",
  email: "amy@x.com",
  phone: null,
  active: true,
  commissionTiers: null,
};
const kol = {
  id: "r-kol",
  name: "KOL",
  code: "KOL",
  kind: "external",
  email: null,
  phone: null,
  active: true,
  commissionTiers: [{ upTo: null, rate: 10 }],
};
let seq = 0;
function order(over = {}) {
  seq += 1;
  return {
    id: `o${seq}`,
    orderNo: `IB-${seq}`,
    createdAt: "2026-10-05T02:00:00Z",
    paidAt: "2026-10-05T02:00:00Z",
    status: "processing",
    paymentStatus: "paid",
    paymentMethod: "card",
    discount: 0,
    customerEmail: `c${seq}@x.com`,
    customerPhone: `09000000${String(seq).padStart(2, "0")}`,
    referrerId: null,
    referralCode: null,
    items: [{ productId: null, productType: "book", unitPrice: 1000, quantity: 1, subtotal: 1000 }],
    ...over,
  };
}
const base = (over) => ({
  period: "2026-10",
  orders: [],
  referrers: [amy, kol],
  settings: S,
  unitCosts: new Map(),
  customerHistory: [],
  settlements: [],
  settledOrderStates: new Map(),
  ...over,
});

{
  // 一張 Amy 的單：1000 選品、50 折扣、估算毛利 50% → 475；15% → 71.25；新客 ×1.25 → 89.06 → 89
  const o = order({ referrerId: "r-amy", referralCode: "AMY", discount: 50 });
  const rep = R.computeMonthlyReport(base({ orders: [o] }));
  const a = rep.referrers.find((r) => r.referrer.id === "r-amy");
  check("折後營收 950", a.orders[0].netRevenue, 950);
  check("估算毛利 475", a.orders[0].grossProfit, 475);
  check("新客", a.orders[0].customerType, "new");
  check("分潤 = 475 × 15% × 1.25 = 89", a.commission, 89);
  check("沒有獎金池（門檻未設）", a.poolShare, 0);
  check("應付 89", a.payable, 89);
  check("全站營收 950", rep.shop.revenue, 950);
  check("估算行數 1/1", [rep.shop.estimatedLines, rep.shop.totalLines], [1, 1]);
  check("上限沒觸發（475 × 40% = 190 > 89）", rep.cap.applied, false);
}
{
  const hist2 = [
    {
      id: "old",
      customerEmail: "repeat@x.com",
      customerPhone: "",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const o = order({ referrerId: "r-amy", customerEmail: "repeat@x.com" });
  const rep = R.computeMonthlyReport(base({ orders: [o], customerHistory: hist2 }));
  const a = rep.referrers.find((r) => r.referrer.id === "r-amy");
  check("舊客", a.orders[0].customerType, "returning");
  check("舊客分潤 = 500 × 15% = 75", a.commission, 75);
}
{
  const self = order({ referrerId: "r-amy", customerEmail: "AMY@x.com" });
  const rep = R.computeMonthlyReport(base({ orders: [self] }));
  const a = rep.referrers.find((r) => r.referrer.id === "r-amy");
  check("自購 → 標記 self", a.orders[0].excluded, "self");
  check("自購 → 分潤 0", a.commission, 0);
  check("自購 → 不算進歸屬毛利", a.attributedGrossProfit, 0);
  check("自購仍算全站營收", rep.shop.revenue, 1000);
}
{
  const refunded = order({ referrerId: "r-amy", paymentStatus: "refunded" });
  const cancelled = order({ referrerId: "r-amy", status: "cancelled" });
  const unpaid = order({ referrerId: "r-amy", paymentStatus: "pending", paidAt: null });
  const sandbox = order({ referrerId: "r-amy", paymentMethod: "test_paid" });
  const rep = R.computeMonthlyReport(base({ orders: [refunded, cancelled, unpaid, sandbox] }));
  const a = rep.referrers.find((r) => r.referrer.id === "r-amy");
  check("已退款／已取消／未付款／沙盒單都不算", a.orders.length, 0);
  check("全站營收 0", rep.shop.revenue, 0);
}
{
  const ticket = order({
    referrerId: "r-amy",
    items: [
      { productId: null, productType: "event", unitPrice: 1800, quantity: 1, subtotal: 1800 },
      { productId: "p1", productType: "book", unitPrice: 400, quantity: 1, subtotal: 400 },
    ],
  });
  const rep = R.computeMonthlyReport(base({ orders: [ticket], unitCosts: new Map([["p1", 300]]) }));
  const a = rep.referrers.find((r) => r.referrer.id === "r-amy");
  check("票券不算營收（只算 400 的書）", a.orders[0].netRevenue, 400);
  check("可信進價 300 → 毛利 100", a.orders[0].grossProfit, 100);
  check("用的是進價不是估算", a.orders[0].costEstimated, false);
}
{
  // 月界：台北 11/1 00:30 付款的單不算 10 月
  const nov = order({ referrerId: "r-amy", paidAt: "2026-10-31T16:30:00Z" });
  const oct = order({ referrerId: "r-amy", paidAt: "2026-10-31T15:59:00Z" });
  const rep = R.computeMonthlyReport(base({ orders: [nov, oct] }));
  const a = rep.referrers.find((r) => r.referrer.id === "r-amy");
  check(
    "月界：只有台北 10/31 23:59 那張算 10 月",
    a.orders.map((o) => o.id),
    [oct.id],
  );
}
{
  // 累進 + 個人覆寫：KOL 用 10% 平費率
  const big = order({
    referrerId: "r-kol",
    items: [
      { productId: null, productType: "goods", unitPrice: 60000, quantity: 1, subtotal: 60000 },
    ],
  });
  const rep = R.computeMonthlyReport(
    base({ orders: [big], settings: { ...S, payoutCapPercent: 100 } }),
  );
  const k = rep.referrers.find((r) => r.referrer.id === "r-kol");
  check("個人級距覆寫：30000 × 10% × 1.25 = 3750", k.commission, 3750);
  const rep2 = R.computeMonthlyReport(
    base({
      orders: [{ ...big, referrerId: "r-amy" }],
      settings: { ...S, payoutCapPercent: 100, newCustomerMultiplier: 1 },
    }),
  );
  const a2 = rep2.referrers.find((r) => r.referrer.id === "r-amy");
  check("全站級距：毛利 30000 → 1500 + 4000 = 5500", a2.commission, 5500);
  check("平均費率 18.33%", a2.averageRate, 18.33);
}
{
  // 團隊獎金池：全站選品營收 20000，門檻 10000，5% → 500
  // Amy（團隊）、Ben（團隊，沒有業績）、KOL（外部，不分池）
  const ben = {
    id: "r-ben",
    name: "Ben",
    code: "BEN",
    kind: "team",
    email: null,
    phone: null,
    active: true,
    commissionTiers: null,
  };
  const off = {
    id: "r-off",
    name: "Off",
    code: "OFF",
    kind: "team",
    email: null,
    phone: null,
    active: false,
    commissionTiers: null,
  };
  const o1 = order({
    referrerId: "r-amy",
    items: [
      { productId: null, productType: "book", unitPrice: 10000, quantity: 1, subtotal: 10000 },
    ],
  });
  const o2 = order({
    items: [
      { productId: null, productType: "book", unitPrice: 10000, quantity: 1, subtotal: 10000 },
    ],
  });
  const rep = R.computeMonthlyReport(
    base({
      orders: [o1, o2],
      referrers: [amy, ben, kol, off],
      settings: { ...S, teamPoolBaseline: 10000, payoutCapPercent: 100 },
    }),
  );
  check("池子 = (20000 − 10000) × 5% = 500", rep.pool.amount, 500);
  check("池子成員 2 位（停用的不算、外部不算）", rep.pool.members, 2);
  const get = (id) => rep.referrers.find((r) => r.referrer.id === id);
  check("Amy：平分 125 + 毛利占比 250 = 375", get("r-amy").poolShare, 375);
  check("Ben：平分 125", get("r-ben").poolShare, 125);
  check("KOL 不分池", get("r-kol").poolShare, 0);
  check("停用的成員不分池", get("r-off").poolShare, 0);
  const rep2 = R.computeMonthlyReport(
    base({
      orders: [o2],
      referrers: [amy, ben],
      settings: { ...S, teamPoolBaseline: 0, payoutCapPercent: 100 },
    }),
  );
  check(
    "沒有人有歸屬毛利 → 整池平分",
    rep2.referrers.map((r) => r.poolShare),
    [250, 250],
  );
  const rep3 = R.computeMonthlyReport(
    base({ orders: [o2], referrers: [kol], settings: { ...S, teamPoolBaseline: 0 } }),
  );
  check("沒有團隊成員 → 標記未分配", rep3.pool.undistributed, true);
  const rep4 = R.computeMonthlyReport(
    base({ orders: [o2], referrers: [amy], settings: { ...S, teamPoolBaseline: 50000 } }),
  );
  check("沒超過門檻 → 池子 0", rep4.pool.amount, 0);
}
{
  // 上限：毛利 500，cap 40% → 200；分潤要 500 × 25%... 用 100% 平費率讓它超過
  const greedy = { ...amy, commissionTiers: [{ upTo: null, rate: 100 }] };
  const o = order({ referrerId: "r-amy" });
  const rep = R.computeMonthlyReport(
    base({ orders: [o], referrers: [greedy], settings: { ...S, newCustomerMultiplier: 1 } }),
  );
  check("上限觸發", rep.cap.applied, true);
  check("上限 = 500 × 40% = 200", rep.cap.limit, 200);
  check("分潤被等比例縮到 200", rep.referrers[0].commission, 200);
  check("縮減前 500", rep.referrers[0].commissionBeforeCap, 500);
  check(
    "逐筆分潤加總 = 總分潤",
    rep.referrers[0].orders.reduce((n, x) => n + x.commission, 0),
    200,
  );
}
{
  // 扣回：9 月結算的單在 10/10 被取消 → 10 月扣回當時付的 60
  const settled = {
    referrerId: "r-amy",
    period: "2026-09",
    amount: 60,
    commission: 60,
    poolShare: 0,
    clawback: 0,
    snapshot: {
      orders: [{ id: "old1", orderNo: "IB-OLD1", commission: 60 }],
      clawedBack: [],
      capFactor: 1,
    },
    settledAt: "2026-10-02T00:00:00Z",
    settledByEmail: "a@b.c",
  };
  const states = new Map([
    [
      "old1",
      {
        id: "old1",
        orderNo: "IB-OLD1",
        status: "cancelled",
        paymentStatus: "refunded",
        cancelledAt: "2026-10-10T00:00:00Z",
        updatedAt: "2026-10-10T00:00:00Z",
      },
    ],
  ]);
  const rep = R.computeMonthlyReport(base({ settlements: [settled], settledOrderStates: states }));
  const a = rep.referrers.find((r) => r.referrer.id === "r-amy");
  check("扣回 60", a.clawback.amount, 60);
  check("應付 −60（顯示成負數）", a.payable, -60);
  check(
    "扣回列出訂單",
    a.clawback.orders.map((c) => c.orderNo),
    ["IB-OLD1"],
  );

  const late = new Map([["old1", { ...states.get("old1"), cancelledAt: "2026-11-15T00:00:00Z" }]]);
  const repLate = R.computeMonthlyReport(
    base({ period: "2026-11", settlements: [settled], settledOrderStates: late }),
  );
  check(
    "超過 30 天才退款 → 不扣回",
    repLate.referrers.find((r) => r.referrer.id === "r-amy").clawback.amount,
    0,
  );

  const already = {
    ...settled,
    period: "2026-10",
    snapshot: {
      orders: [],
      clawedBack: [{ id: "old1", orderNo: "IB-OLD1", amount: 60 }],
      capFactor: 1,
    },
  };
  const repNext = R.computeMonthlyReport(
    base({ period: "2026-11", settlements: [settled, already], settledOrderStates: states }),
  );
  check(
    "已經扣過一次的不再扣",
    repNext.referrers.find((r) => r.referrer.id === "r-amy").clawback.amount,
    0,
  );

  const repSettled = R.computeMonthlyReport(
    base({ settlements: [settled, already], settledOrderStates: states }),
  );
  const s10 = repSettled.referrers.find((r) => r.referrer.id === "r-amy");
  check("已結算的月份：扣回用結算快照", s10.clawback.amount, 60);
  checkTrue("已結算月份帶出結算紀錄", s10.settlement !== null);

  const stillPaid = new Map([
    [
      "old1",
      { ...states.get("old1"), status: "processing", paymentStatus: "paid", cancelledAt: null },
    ],
  ]);
  const repOk = R.computeMonthlyReport(
    base({ settlements: [settled], settledOrderStates: stillPaid }),
  );
  check(
    "沒退款 → 不扣回",
    repOk.referrers.find((r) => r.referrer.id === "r-amy").clawback.amount,
    0,
  );
}
{
  const o = order({ referrerId: "r-amy" });
  const rep = R.computeMonthlyReport(base({ orders: [o] }));
  const a = rep.referrers.find((r) => r.referrer.id === "r-amy");
  const snap = R.snapshotFor(a, rep.cap.factor);
  check("快照存逐筆分潤", snap.orders, [
    { id: o.id, orderNo: o.orderNo, commission: a.commission },
  ]);
}

// -----------------------------------------------------------------------------
console.log("\n[8] 原始碼：授權、伺服器端折扣、側欄");
// -----------------------------------------------------------------------------
const fns = read("src/lib/admin/fns/referrals.ts");
const exportsCount = (fns.match(/export const \w+ = createServerFn/g) ?? []).length;
const guarded = (fns.match(/\.middleware\(\[adminFnMiddleware\]\)/g) ?? []).length;
checkTrue("後台 fns 有 server fn", exportsCount >= 5);
check("後台 fns 每一支都掛 adminFnMiddleware", guarded, exportsCount);
check("後台 fns 沒有 staffFnMiddleware（只限 admin）", fns.includes("staffFnMiddleware"), false);
const ordersRepo = read("src/server/repos/orders.ts");
checkTrue(
  "createOrder 用 computeReferralDiscount 算折扣",
  ordersRepo.includes("computeReferralDiscount("),
);
check("不再是寫死的 discount = 0", /const discount = 0;/.test(ordersRepo), false);
const checkoutLib = read("src/lib/checkout.ts");
checkTrue(
  "payload 只多一個 referralCode 字串欄位",
  /referralCode: z\s*\.string\(\)/.test(checkoutLib),
);
check("payload 沒有任何折扣金額欄位", /discount\w*:\s*z\./.test(checkoutLib), false);
const shell = read("src/routes/admin/_shell.tsx");
checkTrue("側欄有 /admin/referrals", shell.includes('to: "/admin/referrals"'));
const root = read("src/routes/__root.tsx");
checkTrue("__root 掛了 ReferralCapture", root.includes("<ReferralCapture"));

// -----------------------------------------------------------------------------
console.log("\n[8b] 只有票券時不顯示推薦碼欄位（2026-10-21《海的聲音》立即報名）");
// -----------------------------------------------------------------------------
check("只有活動票 → 不顯示", R.hasReferralEligibleLine([{ productType: "event" }]), false);
check(
  "活動＋策旅 → 不顯示",
  R.hasReferralEligibleLine([{ productType: "event" }, { productType: "journey" }]),
  false,
);
check("空車 → 不顯示", R.hasReferralEligibleLine([]), false);
check("一本書 → 顯示", R.hasReferralEligibleLine([{ productType: "book" }]), true);
check(
  "票券＋選品混買 → 顯示",
  R.hasReferralEligibleLine([{ productType: "event" }, { productType: "goods" }]),
  true,
);
const checkoutPage = read("src/routes/checkout.index.tsx");
checkTrue(
  "結帳頁用 hasReferralEligibleLine(buyable) 決定顯示",
  checkoutPage.includes("const showReferral = hasReferralEligibleLine(buyable)"),
);
checkTrue(
  "推薦碼 fieldset 包在 showReferral 裡",
  /\{showReferral && \(\s*<fieldset[^>]*>\s*<legend[^>]*>\{t\(PAGE\.referralSection\)\}/.test(
    checkoutPage,
  ),
);
checkTrue(
  "欄位隱藏時不拿推薦碼擋送出（showReferral && typedReferral && …）",
  /showReferral\s*&&\s*typedReferral\s*&&/.test(checkoutPage),
);
check("隱藏時不清 ib_ref cookie", /document\.cookie\s*=/.test(checkoutPage), false);

// -----------------------------------------------------------------------------
console.log("\n[9] migration 帳本");
// -----------------------------------------------------------------------------
assertLedgerMatchesDisk(check, MIG_DIR);
assertLedgerDeclarationsHonest(check, MIG_DIR);
assertMigrationDependencies(check, MIG_DIR, {
  suite: SELF,
  dependsOn: ["referrals", "orders_payments"],
  // 0045（票種改依實際刪掉的報名列數退）：create or replace 了 release_session_seat() 與
  // expire_unpaid_orders()，簽章、回傳形狀、security definer、grant 都不變。唯一的行為差異是
  // event_session_plans.units_taken 退 ceil(實際刪掉列數/spu) 而不是 order_items.quantity（沒人
  // 被單筆移除過時兩者相等）；expire 的 4c／4d 合成一句，認領條件（含 0034 匯款 3 天）、商品
  // 庫存、products.seats_taken、inv 保留、取消訂單、付款嘗試、回傳值逐字沿用 0036。另 revoke
  // registration_removal_log 的 sequence 權限。這支自檢的斷言重讀過，原樣成立。
  // 0047（後台作廢發票）：invoices 只加三個 nullable 欄位與 CHECK，新增 claim／finish／release_invoice_void
  // 三支函式；public.orders 只被 claim 唯讀 select order_no／total。0007 的開立函式、invoice_backlog、
  // orders／payments 的欄位、約束、grant 一個都沒動。這支自檢的斷言重讀過，原樣成立。
  reviewedThrough: "0047_invoice_void.sql",
});
const mig = read("supabase/migrations/0040_referral_program.sql");
for (const t of ["referrers", "referral_settings", "referral_settlements"]) {
  checkTrue(`${t} 開 RLS`, mig.includes(`alter table public.${t} enable row level security`));
  checkTrue(
    `${t} revoke anon/authenticated`,
    mig.includes(`revoke all on table public.${t} from anon, authenticated`),
  );
}
check(
  "migration 沒有 drop",
  /\bdrop\s+(table|column|function)/i.test(mig.replace(/^\s*--.*$/gm, "")),
  false,
);
checkTrue("unique(referrer_id, period) 防重複結算", mig.includes("unique (referrer_id, period)"));

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
