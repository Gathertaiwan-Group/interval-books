#!/usr/bin/env node
/**
 * needs-contact-selftest.mjs —— 「銀行匯款」與「由我們與你聯繫付款」合併（0048，業主方案 A）
 *
 * 守四件事，全部驅動**產線的程式碼本人**（直接 import src/lib/*.ts），不重寫一份邏輯：
 *
 *   1. 結帳頁只剩兩個付款選項（card、transfer）；offline 只在兩者都沒設定時出現。
 *   2. 勾選「我需要專人聯繫協助付款」→ 訂單帶 needs_contact = true（payload → 伺服器決策 →
 *      orders insert 那一行）。
 *   3. 店家通知信與客人匯款資訊信都寫出需聯繫。
 *   4. 新請求送來 offline（payment_method NULL）→ 店家設好匯款帳戶時自動轉成
 *      transfer + needs_contact；沒設時照舊 NULL（理由見 src/lib/checkout.ts
 *      resolveOrderPaymentChoice）。
 *
 * 以及：對客人顯示的檔案裡不再出現「由我們與你聯繫付款」（剝掉註解後比對）、
 * 後台列表與詳情有需聯繫標示、0048 的形狀（not null default false）。
 *
 * 不連資料庫、不寄信、不下單。執行：node scripts/needs-contact-selftest.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { registerHooks } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/needs-contact-selftest.mjs";

let pass = 0;
let fail = 0;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function check(label, actual, expected) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
  }
}
const checkTrue = (label, v) => check(label, Boolean(v), true);
const checkFalse = (label, v) => check(label, Boolean(v), false);

/** 檔案不存在＝丟例外，不回空字串（否則否定斷言會靜默通過；見 run-selftests.mjs 守門 4）。 */
const readFile = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`selftest 讀不到檔案：${p}`);
  return readFileSync(p, "utf8");
};
/** 剝掉 // 與 /* *\/ 與 JSX {/* *\/} 註解，只留程式碼與字串。 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      const base = join(ROOT, "src", spec.slice(2));
      for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
    return next(spec, ctx);
  },
});

const checkout = await import(pathToFileURL(join(ROOT, "src/lib/checkout.ts")).href);
const tpl = await import(pathToFileURL(join(ROOT, "src/lib/email-templates.ts")).href);
const labels = await import(pathToFileURL(join(ROOT, "src/lib/admin/order-labels.ts")).href);

// =============================================================================
console.log("\n[1] 結帳頁只剩兩個付款選項");
const both = checkout.checkoutMethodOptions({ cardAvailable: true, transferAvailable: true });
check(
  "card + transfer 都設定 → 兩個選項",
  JSON.stringify(both),
  JSON.stringify(["card", "transfer"]),
);
checkFalse("兩個選項裡沒有 offline", both.includes("offline"));
check(
  "只有匯款帳戶 → 只有 transfer（不再補 offline）",
  JSON.stringify(checkout.checkoutMethodOptions({ cardAvailable: false, transferAvailable: true })),
  JSON.stringify(["transfer"]),
);
check(
  "只有金流 → 只有 card",
  JSON.stringify(checkout.checkoutMethodOptions({ cardAvailable: true, transferAvailable: false })),
  JSON.stringify(["card"]),
);
check(
  "兩者都沒設定 → 只剩 offline 降級（不畫 radio）",
  JSON.stringify(
    checkout.checkoutMethodOptions({ cardAvailable: false, transferAvailable: false }),
  ),
  JSON.stringify(["offline"]),
);

const page = readFile("src/routes/checkout.index.tsx");
const pageCode = stripComments(page);
checkTrue("結帳頁用 checkoutMethodOptions() 算選項", /checkoutMethodOptions\(\{/.test(pageCode));
checkFalse("結帳頁不再把 offline 永遠塞進清單", /"offline" as const,\s*\]/.test(pageCode));
checkTrue(
  '結帳頁有 name="needsContact" 的勾選框',
  /type="checkbox"\s+name="needsContact"/.test(pageCode),
);
checkTrue("勾選框文案：我需要專人聯繫協助付款", pageCode.includes('zh: "我需要專人聯繫協助付款"'));
checkTrue(
  "勾選框預設不勾（useState(false)）",
  /\[needsContact, setNeedsContact\] = useState\(false\)/.test(pageCode),
);
checkTrue(
  "勾選框只在選匯款時出現",
  /payWith === "transfer" && methodOptions\.includes\("transfer"\) && \(/.test(pageCode),
);
checkTrue(
  "送出時只有匯款才帶 needsContact",
  /needsContact: payWith === "transfer" && needsContact/.test(pageCode),
);

// =============================================================================
console.log("\n[2] 勾選 → 訂單帶需聯繫標記");
const schema = checkout.checkoutPayloadSchema;
checkTrue("payload schema 有 needsContact", schema.shape.needsContact);
const base = {
  items: [{ productId: "00000000-0000-4000-8000-000000000000", quantity: 1 }],
  customerName: "測試",
  customerEmail: "delivered@resend.dev",
  customerPhone: "0912345678",
  shippingMethod: "pickup",
  address: null,
  locale: "zh",
  idempotencyKey: "6f1d7c2e-0b4a-4c1e-9a55-0d0e5c3b4a21",
};
const parsedPlain = schema.safeParse({ ...base, paymentMethod: "transfer" });
if (parsedPlain.success) {
  check("沒送 needsContact → 預設 false", parsedPlain.data.needsContact, false);
} else {
  fail += 1;
  console.log(
    red(`  ✗ payload 解析失敗：${JSON.stringify(parsedPlain.error.issues).slice(0, 300)}`),
  );
}
const parsedTick = schema.safeParse({ ...base, paymentMethod: "transfer", needsContact: true });
check(
  "送 needsContact: true → 解析後是 true",
  parsedTick.success && parsedTick.data.needsContact,
  true,
);

const r = checkout.resolveOrderPaymentChoice;
check(
  "transfer + 勾選 → transfer / needs_contact=true",
  JSON.stringify(r({ paymentMethod: "transfer", needsContact: true, transferAvailable: true })),
  JSON.stringify({ paymentMethod: "transfer", needsContact: true }),
);
check(
  "transfer 不勾 → transfer / false",
  JSON.stringify(r({ paymentMethod: "transfer", needsContact: false, transferAvailable: true })),
  JSON.stringify({ paymentMethod: "transfer", needsContact: false }),
);
check(
  "card + true（竄改／殘留）→ card / false",
  JSON.stringify(r({ paymentMethod: "card", needsContact: true, transferAvailable: true })),
  JSON.stringify({ paymentMethod: "card", needsContact: false }),
);

const orders = stripComments(readFile("src/server/repos/orders.ts"));
checkTrue(
  "createOrder 經 resolveOrderPaymentChoice() 決定付款欄位",
  /resolveOrderPaymentChoice\(\{/.test(orders),
);
checkTrue(
  "orders insert 寫 needs_contact: choice.needsContact",
  /needs_contact: choice\.needsContact && total > 0,/.test(orders),
);
checkTrue(
  "payment_method 由 choice 決定（不是直接讀 payload）",
  /const wantsCard = choice\.paymentMethod === "card"/.test(orders) &&
    /const wantsTransfer = choice\.paymentMethod === "transfer"/.test(orders),
);

const mig = readFile("supabase/migrations/0048_order_needs_contact.sql");
checkTrue(
  "0048：needs_contact boolean not null default false",
  /add column if not exists needs_contact boolean not null default false/.test(mig),
);
checkFalse(
  "0048 沒有改 expire_unpaid_orders",
  mig.replace(/--[^\n]*/g, "").includes("expire_unpaid_orders"),
);

// =============================================================================
console.log("\n[3] 通知信寫出需聯繫");
const adminInput = {
  stage: "atOrderTime",
  orderNo: "IB-TEST-0001",
  total: 1800,
  contact: null,
  adminUrl: null,
  paymentMethod: "transfer",
  shippingMethod: "none",
  items: [{ name: { zh: "測試品項", en: "Item", ja: "品" }, quantity: 1, subtotal: 1800 }],
  sessions: [],
};
const adminYes = tpl.renderAdminOrderNotificationEmail({ ...adminInput, needsContact: true });
checkTrue("店家信主旨有「需聯繫」", adminYes.subject.includes("需聯繫"));
checkTrue("店家信內文有「需聯繫」", adminYes.text.includes("需聯繫"));
checkTrue("店家信 HTML 有「需聯繫」", adminYes.html.includes("需聯繫"));
checkTrue("店家信寫出客人勾選的那句", adminYes.text.includes("我需要專人聯繫協助付款"));
const adminNo = tpl.renderAdminOrderNotificationEmail({ ...adminInput, needsContact: false });
checkFalse("沒勾 → 主旨沒有「需聯繫」", adminNo.subject.includes("需聯繫"));
checkFalse("沒勾 → 內文沒有「需聯繫」", adminNo.text.includes("需聯繫"));

const remitInput = {
  orderNo: "IB-TEST-0001",
  customerName: "測試",
  total: 1800,
  bankName: "測試銀行",
  bankCode: "000",
  bankAccount: "0000000000",
  accountName: "測試戶名",
  dueAt: "2026-11-02T00:00:00.000Z",
  orderUrl: "https://www.intervalbooks.tw/checkout/complete?token=selftest",
  items: [{ name: { zh: "測試品項", en: "Item", ja: "品" }, quantity: 1, subtotal: 1800 }],
  sessions: [],
};
const remitYes = tpl.renderRemittanceEmail({ ...remitInput, needsContact: true }, undefined, "zh");
checkTrue("客人匯款信（中）有「我們會盡快與你聯繫」", remitYes.text.includes("我們會盡快與你聯繫"));
checkTrue("客人匯款信仍印匯款帳號", remitYes.text.includes("0000000000"));
const remitEn = tpl.renderRemittanceEmail({ ...remitInput, needsContact: true }, undefined, "en");
checkTrue("客人匯款信（英）有 contact you", remitEn.text.includes("we will contact you"));
const remitNo = tpl.renderRemittanceEmail({ ...remitInput, needsContact: false }, undefined, "zh");
checkFalse("沒勾 → 匯款信沒有那一句", remitNo.text.includes("我們會盡快與你聯繫"));

const notify = readFile("src/server/notify.ts");
check(
  "notify.ts 下單當下兩封信都把 order.needsContact 傳進去",
  (notify.match(/needsContact: order\.needsContact,/g) ?? []).length,
  2,
);
checkTrue(
  "getOrderForNotify 讀 needs_contact",
  /created_at, needs_contact"/.test(readFile("src/server/repos/email-outbox.ts")),
);

// =============================================================================
console.log("\n[4] 新請求送來 offline（NULL）");
check(
  "offline + 店家有匯款帳戶 → 自動轉 transfer + needs_contact",
  JSON.stringify(r({ paymentMethod: "offline", needsContact: false, transferAvailable: true })),
  JSON.stringify({ paymentMethod: "transfer", needsContact: true }),
);
check(
  "offline + 沒有匯款帳戶 → 照舊 NULL（那種部署唯一的路）",
  JSON.stringify(r({ paymentMethod: "offline", needsContact: true, transferAvailable: false })),
  JSON.stringify({ paymentMethod: null, needsContact: false }),
);
const oldClient = schema.safeParse(base);
check(
  "舊前台沒送 paymentMethod → 預設 offline（再由伺服器轉成 transfer）",
  oldClient.success && oldClient.data.paymentMethod,
  "offline",
);
checkTrue(
  "createOrder 只在 offline 時讀匯款帳戶",
  /if \(payload\.paymentMethod === "offline"\) \{\s*try \{\s*transferAvailable = remittanceConfigured\(await getRemittanceAccount\(\)\)/.test(
    orders,
  ),
);

// =============================================================================
console.log("\n[5] 對客人顯示的文字不再寫「由我們與你聯繫付款」");
for (const f of [
  "src/routes/checkout.index.tsx",
  "src/routes/cart.tsx",
  "src/routes/events.kungtung.tsx",
  "src/components/kungtung/MainSections.tsx",
  "src/routes/events.sound-of-the-sea.tsx",
]) {
  const code = stripComments(readFile(f));
  // 反空殼：剝註解沒有把檔案剝光（否則下面兩條否定斷言會靜默通過）。
  checkTrue(`${f} 剝註解後仍有「銀行匯款」`, code.includes("銀行匯款"));
  checkFalse(`${f} 沒有「由我們與你聯繫付款」`, code.includes("由我們與你聯繫付款"));
  checkFalse(`${f} 沒有「或由我們與你聯繫」`, code.includes("或由我們與你聯繫"));
}
checkFalse(
  "結帳頁英文不再有 Arrange payment with us",
  pageCode.includes("Arrange payment with us"),
);

// =============================================================================
console.log("\n[6] 後台列表與詳情的需聯繫標示");
check("標示文字", labels.NEEDS_CONTACT_LABEL, "需聯繫");
checkTrue(
  "未付款、未取消、勾了 → 亮",
  labels.showNeedsContact({ needs_contact: true, payment_status: "pending", status: "pending" }),
);
checkFalse(
  "已付款 → 不亮",
  labels.showNeedsContact({ needs_contact: true, payment_status: "paid", status: "processing" }),
);
checkFalse(
  "已取消 → 不亮",
  labels.showNeedsContact({ needs_contact: true, payment_status: "pending", status: "cancelled" }),
);
checkFalse(
  "沒勾 → 不亮",
  labels.showNeedsContact({ needs_contact: false, payment_status: "pending", status: "pending" }),
);
check(
  "?scope=needs_contact 解析得出來",
  labels.parseOrderListSearch({ scope: "needs_contact" }).scope,
  "needs_contact",
);
const list = stripComments(readFile("src/routes/admin/_shell.orders.tsx"));
checkTrue("列表有「需聯繫」分頁", /<TabsTrigger value="needs_contact">/.test(list));
checkTrue("列表每一列用 showNeedsContact(o) 標示", /showNeedsContact\(o\)/.test(list));
const detail = stripComments(readFile("src/routes/admin/_shell.orders_.$id.tsx"));
checkTrue("詳情頁頂端用 showNeedsContact(detail) 標示", /showNeedsContact\(detail\)/.test(detail));
check(
  "詳情頁頂端與付款區塊都用 showNeedsContact(detail)（已付款／已取消／免費單不亮）",
  (detail.match(/showNeedsContact\(detail\) \?/g) ?? []).length,
  2,
);
const repo = stripComments(readFile("src/server/repos/orders-admin.ts"));
checkTrue("列表欄位有 needs_contact", /archived_at, needs_contact";/.test(repo));
checkTrue(
  "needs_contact 篩選：勾了、未付款、未取消",
  /\.eq\("needs_contact", true\)\s*\.neq\("payment_status", "paid"\)\s*\.neq\("status", "cancelled"\)/.test(
    repo,
  ),
);
checkTrue(
  "server fn 的 scope 白名單收 needs_contact",
  /"transfer_pending", "needs_contact"/.test(readFile("src/lib/admin/fns/orders.ts")),
);

// =============================================================================
console.log("\n" + "─".repeat(52));
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exit(1);
}
console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
