#!/usr/bin/env node
/**
 * invoice-alerts-selftest.mjs —— 「已付款但發票開不出來就通知店家」的自檢
 * （業主 2026-10-28 核准）
 *
 *   [1] 停止重試的判斷、需要人看的判斷（橫幅／篩選列表／每日彙整共用）
 *   [2] 開立失敗信的去重：同一次停止只寄一次、合併成一封、冷卻、上限、新世代
 *   [3] 每日彙整：台北 09:00 之後、一天一把 key、跨日
 *   [4] 「重新開立發票」按鈕何時出現
 *   [5] 信件排版：主旨、欄位、跳脫、不含客人聯絡資料
 *   [6] 接線：排程有呼叫、只寄店家、告警模組不開發票、兩支 server fn 掛 admin、
 *       重新開立一律先查 Amego、retry 設回 1、橫幅與列表用同一個定義
 *
 * [1]–[5] 直接 import 產線的 .ts（Node 原生型別剝離），驗的是真的那份程式。
 *
 * 執行：node scripts/invoice-alerts-selftest.mjs（或 npm test）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/invoice-alerts-selftest.mjs";

let pass = 0;
let fail = 0;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
  }
}
const checkTrue = (label, v) => check(label, v === true, true);

/** 讀不到就丟例外，不回空字串（run-selftests.mjs 守門 4）。 */
function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
/** 剝掉 // 與 /* *\/ 註解，避免斷言被檔頭的說明文字餵飽。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

const A = await import(pathToFileURL(join(ROOT, "src/lib/invoice-alerts.ts")).href);
const E = await import(pathToFileURL(join(ROOT, "src/lib/email-templates.ts")).href);

const MAX = 5;
const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-28T01:03:00Z"); // 台北 09:03

/** 2026-09 那 5 張的形狀（金額與錯誤訊息照實，id 是假的）。 */
const SEPT = [
  [
    "IB-202600001191",
    "amego code=transport msg=",
    "2026-09-02T05:14:21Z",
    "2026-09-10T14:40:26.903Z",
  ],
  [
    "IB-202600001192",
    "amego code=14 msg=IP 錯誤：100.58.234.199 未被允許",
    "2026-09-02T07:21:26Z",
    "2026-09-02T07:21:28.806Z",
  ],
  [
    "IB-202600001193",
    "amego code=14 msg=IP 錯誤：44.212.38.92 未被允許",
    "2026-09-03T04:49:07Z",
    "2026-09-03T04:53:04.064Z",
  ],
  [
    "IB-202600001196",
    "amego code=14 msg=IP 錯誤：3.92.182.125 未被允許",
    "2026-09-03T12:45:24Z",
    "2026-09-03T12:45:28.031Z",
  ],
  [
    "IB-202600001197",
    "amego code=14 msg=IP 錯誤：54.90.68.139 未被允許",
    "2026-09-05T00:36:23Z",
    "2026-09-05T00:36:26.162Z",
  ],
].map(([orderNo, err, paidAt, updatedAt], i) => ({
  orderId: `00000000-0000-4000-8000-00000000000${i}`,
  orderNo,
  paidAt,
  total: 1800,
  status: "failed",
  retryCount: 5,
  errorMessage: err,
  updatedAt,
}));

const row = (over) => ({
  orderId: "11111111-1111-4111-8111-111111111111",
  orderNo: "IB-X",
  paidAt: new Date(NOW.getTime() - HOUR).toISOString(),
  total: 500,
  status: "pending",
  retryCount: 0,
  errorMessage: null,
  updatedAt: new Date(NOW.getTime() - HOUR).toISOString(),
  ...over,
});

// -----------------------------------------------------------------------------
console.log("\n[1] 停止重試／需要人看");
check(
  "failed + 5 次 → 停止重試",
  A.isTerminalInvoiceFailure({ status: "failed", retryCount: 5 }, MAX),
  true,
);
check(
  "failed + 7 次（permanent 推過頭）→ 停止重試",
  A.isTerminalInvoiceFailure({ status: "failed", retryCount: 7 }, MAX),
  true,
);
check(
  "failed + 4 次 → 還在重試",
  A.isTerminalInvoiceFailure({ status: "failed", retryCount: 4 }, MAX),
  false,
);
check(
  "pending + 5 次 → 不是 failed 就不算停止",
  A.isTerminalInvoiceFailure({ status: "pending", retryCount: 5 }, MAX),
  false,
);
check(
  "9 月那 5 張全部需要人看",
  SEPT.filter((r) => A.needsInvoiceAttention(r, NOW, MAX)).length,
  5,
);
check(
  "金額 0（免費訂單，0028 不開發票）→ 不算",
  A.needsInvoiceAttention(row({ total: 0, paidAt: "2026-09-10T01:18:50Z" }), NOW, MAX),
  false,
);
check(
  "issued → 不算",
  A.needsInvoiceAttention(row({ status: "issued", paidAt: "2026-01-01T00:00:00Z" }), NOW, MAX),
  false,
);
check(
  "voided → 不算",
  A.needsInvoiceAttention(row({ status: "voided", retryCount: 9 }), NOW, MAX),
  false,
);
check(
  "付款 1 小時、pending → 還不算（排程還在補）",
  A.needsInvoiceAttention(row({}), NOW, MAX),
  false,
);
check(
  "付款 1 小時、failed 2 次 → 還不算",
  A.needsInvoiceAttention(row({ status: "failed", retryCount: 2 }), NOW, MAX),
  false,
);
check(
  "付款 1 小時、但已停止重試 → 算",
  A.needsInvoiceAttention(row({ status: "failed", retryCount: 5 }), NOW, MAX),
  true,
);
check(
  "付款 24 小時整、pending → 算",
  A.needsInvoiceAttention(
    row({ paidAt: new Date(NOW.getTime() - 24 * HOUR).toISOString() }),
    NOW,
    MAX,
  ),
  true,
);
check(
  "付款 23 小時、pending → 不算",
  A.needsInvoiceAttention(
    row({ paidAt: new Date(NOW.getTime() - 23 * HOUR).toISOString() }),
    NOW,
    MAX,
  ),
  false,
);
check(
  "沒有 invoices 列（missing）且付款 2 天 → 算",
  A.needsInvoiceAttention(
    row({ status: "missing", paidAt: "2026-10-26T00:00:00Z", updatedAt: null }),
    NOW,
    MAX,
  ),
  true,
);
check(
  "卡在 issuing 2 天 → 算",
  A.needsInvoiceAttention(row({ status: "issuing", paidAt: "2026-10-26T00:00:00Z" }), NOW, MAX),
  true,
);
check(
  "paid_at 是 null 的已付款單（資料異常）→ 算",
  A.needsInvoiceAttention(row({ paidAt: null }), NOW, MAX),
  true,
);

// -----------------------------------------------------------------------------
console.log("\n[2] 開立失敗信的去重");
const plan1 = A.planTerminalAlert(SEPT, [], NOW, MAX);
checkTrue("第一輪：有信要寄", plan1 !== null);
check("第一輪：5 張合成一封", plan1.rows.length, 5);
check(
  "第一輪：依訂單編號排序",
  plan1.rows.map((r) => r.orderNo),
  SEPT.map((r) => r.orderNo).sort(),
);
check("第一輪：remaining = 0", plan1.remaining, 0);
checkTrue("key 前綴 invoice_failed_admin:", plan1.dedupeKey.startsWith("invoice_failed_admin:"));
check("key 拆得回 5 個 token", A.tokensFromAlertKey(plan1.dedupeKey).length, 5);
check(
  "token = <order_id>@<updated_at 毫秒>",
  A.alertToken(SEPT[0]),
  `${SEPT[0].orderId}@${Date.parse(SEPT[0].updatedAt)}`,
);
check(
  "key 與輸入順序無關（排序過）",
  A.failedAlertKey(["b@1", "a@2"]),
  A.failedAlertKey(["a@2", "b@1"]),
);
const sent1 = [{ dedupeKey: plan1.dedupeKey, createdAt: NOW.toISOString() }];
check(
  "第二輪（10 分鐘後）：同一次停止不再寄",
  A.planTerminalAlert(SEPT, sent1, new Date(NOW.getTime() + 10 * 60 * 1000), MAX),
  null,
);
check(
  "一週後：同一次停止仍然不再寄（token 相同）",
  A.planTerminalAlert(SEPT, sent1, new Date(NOW.getTime() + 7 * 24 * HOUR), MAX),
  null,
);
check("不是這個前綴的 key 不會被拆", A.tokensFromAlertKey("order_notify_admin:abc"), []);

// 業主按了重新開立又失敗到上限 → updated_at 變了 = 新世代
const regen = SEPT.map((r, i) =>
  i === 0 ? { ...r, updatedAt: new Date(NOW.getTime() + 2 * HOUR).toISOString() } : r,
);
check(
  "新世代但在 6 小時冷卻內 → 不寄（防洗版）",
  A.planTerminalAlert(regen, sent1, new Date(NOW.getTime() + 3 * HOUR), MAX),
  null,
);
const regenPlan = A.planTerminalAlert(regen, sent1, new Date(NOW.getTime() + 7 * HOUR), MAX);
check(
  "新世代、冷卻過了 → 只寄那一張",
  regenPlan?.rows.map((r) => r.orderNo),
  ["IB-202600001191"],
);

// 系統性故障：25 張同時停止
const many = Array.from({ length: 25 }, (_, i) =>
  row({
    orderId: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
    orderNo: `IB-9${String(i).padStart(3, "0")}`,
    status: "failed",
    retryCount: 5,
  }),
);
const mp = A.planTerminalAlert(many, [], NOW, MAX);
check("25 張：一封最多列 10 張", mp.rows.length, A.MAX_ORDERS_PER_ALERT);
check("25 張：remaining = 15", mp.remaining, 15);
const mp2 = A.planTerminalAlert(
  many,
  [{ dedupeKey: mp.dedupeKey, createdAt: NOW.toISOString() }],
  new Date(NOW.getTime() + 10 * 60 * 1000),
  MAX,
);
check(
  "下一輪列的是另外 10 張",
  mp2.rows.some((r) => mp.rows.some((x) => x.orderId === r.orderId)),
  false,
);
check(
  "還在重試、pending、金額 0 的都不會進開立失敗信",
  A.planTerminalAlert(
    [
      row({ status: "failed", retryCount: 3 }),
      row({ status: "pending" }),
      row({ status: "failed", retryCount: 5, total: 0 }),
    ],
    [],
    NOW,
    MAX,
  ),
  null,
);

// -----------------------------------------------------------------------------
console.log("\n[3] 每日彙整");
check("台北 08:59 → 不排", A.planDigest(SEPT, new Date("2026-10-28T00:59:00Z"), MAX), null);
const d1 = A.planDigest(SEPT, NOW, MAX);
check("台北 09:03 → 排，5 張", d1?.rows.length, 5);
check("key = invoice_digest_admin:<台北日期>", d1?.dedupeKey, "invoice_digest_admin:2026-10-28");
check(
  "同一天 09:53 → 同一把 key（撞 unique 就不寄第二封）",
  A.planDigest(SEPT, new Date("2026-10-28T01:53:00Z"), MAX)?.dedupeKey,
  "invoice_digest_admin:2026-10-28",
);
check(
  "台北 10:00 → 不排（只開 09 點這一小時）",
  A.planDigest(SEPT, new Date("2026-10-28T02:00:00Z"), MAX),
  null,
);
check(
  "台北 16:30（上線當下）→ 不排彙整，只會有開立失敗信",
  A.planDigest(SEPT, new Date("2026-10-28T08:30:00Z"), MAX),
  null,
);
check(
  "UTC 16:00 = 台北隔天 00:00 → 還沒到 9 點，不排",
  A.planDigest(SEPT, new Date("2026-10-28T16:00:00Z"), MAX),
  null,
);
check(
  "台北隔天 09:13 → 新的一把 key",
  A.planDigest(SEPT, new Date("2026-10-29T01:13:00Z"), MAX)?.dedupeKey,
  "invoice_digest_admin:2026-10-29",
);
check("沒有需要人看的單 → 不排", A.planDigest([row({})], NOW, MAX), null);
check("taipeiDateKey 跨日", A.taipeiDateKey(new Date("2026-12-31T16:30:00Z")), "2027-01-01");

// -----------------------------------------------------------------------------
console.log("\n[4] 重新開立按鈕");
const paidOld = { paymentStatus: "paid", total: 1800, paidAt: "2026-09-02T05:14:21Z" };
check(
  "failed 停止重試 → 有按鈕",
  A.canReissueInvoice(paidOld, { status: "failed", retryCount: 5, updatedAt: null }, NOW, MAX),
  true,
);
check(
  "failed 還在重試 → 也有按鈕",
  A.canReissueInvoice(
    { ...paidOld, paidAt: NOW.toISOString() },
    { status: "failed", retryCount: 1, updatedAt: null },
    NOW,
    MAX,
  ),
  true,
);
check(
  "issued → 沒有",
  A.canReissueInvoice(paidOld, { status: "issued", retryCount: 0, updatedAt: null }, NOW, MAX),
  false,
);
check(
  "voided → 沒有",
  A.canReissueInvoice(paidOld, { status: "voided", retryCount: 0, updatedAt: null }, NOW, MAX),
  false,
);
check(
  "未付款 → 沒有",
  A.canReissueInvoice(
    { ...paidOld, paymentStatus: "pending" },
    { status: "failed", retryCount: 5, updatedAt: null },
    NOW,
    MAX,
  ),
  false,
);
check(
  "金額 0 → 沒有",
  A.canReissueInvoice(
    { ...paidOld, total: 0 },
    { status: "pending", retryCount: 0, updatedAt: null },
    NOW,
    MAX,
  ),
  false,
);
check(
  "剛付款、pending → 沒有（排程會開）",
  A.canReissueInvoice(
    { ...paidOld, paidAt: NOW.toISOString() },
    { status: "pending", retryCount: 0, updatedAt: null },
    NOW,
    MAX,
  ),
  false,
);
check("付款 2 天、沒有 invoices 列 → 有", A.canReissueInvoice(paidOld, null, NOW, MAX), true);
check("狀態文字：停止重試", A.invoiceStatusLabel("failed", 5, MAX), "開立失敗（已停止自動重試）");
check("狀態文字：重試中", A.invoiceStatusLabel("failed", 2, MAX), "開立失敗（自動重試中）");

// -----------------------------------------------------------------------------
console.log("\n[5] 信件排版");
const toOrder = (r) => ({
  orderNo: r.orderNo,
  paidAt: r.paidAt,
  total: r.total,
  status: r.status,
  retryCount: r.retryCount,
  errorMessage: r.errorMessage,
  adminUrl: `https://interval-books.vercel.app/admin/orders/${r.orderId}`,
});
const one = E.renderInvoiceFailedAdminEmail({
  orders: [toOrder(SEPT[1])],
  maxRetries: MAX,
  listUrl: "https://interval-books.vercel.app/admin/orders?scope=invoice_problem",
});
check("單張主旨", one.subject, "【小時光書店】發票開立失敗：IB-202600001192");
for (const [label, needle] of [
  ["訂單編號", "IB-202600001192"],
  ["付款時間（台北）", "2026/09/02 15:21"],
  ["金額", "1,800"],
  ["最後錯誤", "IP 錯誤：100.58.234.199"],
  ["嘗試次數", "5 / 5 次"],
  ["後台連結", `/admin/orders/${SEPT[1].orderId}`],
  ["處理方式", "重新開立發票"],
]) {
  checkTrue(`單張 text 含${label}`, one.text.includes(needle));
  checkTrue(`單張 html 含${label}`, one.html.includes(needle));
}
const five = E.renderInvoiceFailedAdminEmail({
  orders: SEPT.map(toOrder),
  maxRetries: MAX,
  remaining: 0,
  listUrl: "https://interval-books.vercel.app/admin/orders?scope=invoice_problem",
});
check("多張主旨", five.subject, "【小時光書店】發票開立失敗：IB-202600001191 等 5 張");
check(
  "多張：每張都有自己的後台連結",
  SEPT.every((r) => five.text.includes(`/admin/orders/${r.orderId}`)),
  true,
);
checkTrue("多張：連到篩選列表", five.html.includes("scope=invoice_problem"));
const spill = E.renderInvoiceFailedAdminEmail({
  orders: [toOrder(SEPT[0])],
  maxRetries: MAX,
  remaining: 3,
  listUrl: null,
});
checkTrue("remaining > 0 時提到下一封", spill.text.includes("另外還有 3 張"));
const evil = E.renderInvoiceFailedAdminEmail({
  orders: [toOrder({ ...SEPT[0], errorMessage: "<script>alert(1)</script>" })],
  maxRetries: MAX,
  listUrl: null,
});
check("錯誤訊息會被 HTML 跳脫", evil.html.includes("<script>"), false);
const empty = E.renderInvoiceFailedAdminEmail({
  orders: [toOrder({ ...SEPT[0], errorMessage: null })],
  maxRetries: MAX,
  listUrl: null,
});
checkTrue("沒有錯誤訊息時寫明", empty.text.includes("（沒有錯誤訊息）"));
const noUrl = E.renderInvoiceFailedAdminEmail({
  orders: [{ ...toOrder(SEPT[0]), adminUrl: null }],
  maxRetries: MAX,
  listUrl: null,
});
check("SITE_URL 組不出來時不放按鈕連結", noUrl.html.includes("<a href"), false);
const dg = E.renderInvoiceDigestAdminEmail({
  orders: SEPT.map(toOrder),
  maxRetries: MAX,
  listUrl: "https://interval-books.vercel.app/admin/orders?scope=invoice_problem",
});
check("彙整主旨", dg.subject, "【小時光書店】每日提醒：5 張已付款訂單的發票尚未開立");
check(
  "彙整列出 5 張",
  SEPT.every((r) => dg.text.includes(r.orderNo)),
  true,
);
check(
  "信裡沒有「姓名／電話／Email」欄位（不帶客人聯絡資料）",
  /姓名|電話|Email/.test(one.text + five.text + dg.text),
  false,
);

// -----------------------------------------------------------------------------
console.log("\n[6] 接線");
const task = stripComments(read("src/server/task-endpoints.ts"));
const invTask = task.slice(
  task.indexOf("export async function handleInvoiceTask"),
  task.indexOf("export const PURGE_SCANS_TASK_PATH"),
);
checkTrue("/api/tasks/invoices 呼叫 runInvoiceAlerts()", invTask.includes("runInvoiceAlerts()"));
checkTrue(
  "告警在補開（runInvoiceBacklog）之後才跑",
  invTask.indexOf("runInvoiceAlerts()") > invTask.indexOf("runInvoiceBacklog(20)"),
);
checkTrue(
  "單張 ?order= 路徑不觸發告警（只有整輪排程）",
  invTask.slice(0, invTask.indexOf("reclaimStaleInvoices(100)")).includes("runInvoiceAlerts") ===
    false,
);

const srv = stripComments(read("src/server/invoice-alerts.ts"));
check("告警模組沒有 throw（永不拖垮開票排程）", /\bthrow\b/.test(srv), false);
check(
  "告警模組不 import 開票（amego／invoice-issuer）",
  /@\/server\/(amego|invoice-issuer)/.test(srv),
  false,
);
check(
  "告警模組不寫 invoices（沒有 .update／.insert／.upsert／.delete）",
  /\.(update|insert|upsert|delete)\(/.test(srv),
  false,
);
checkTrue("只排給店家：enqueueAdminOrderEmail", srv.includes("enqueueAdminOrderEmail("));
check(
  "不排給客人：沒有 enqueueOrderEmail／enqueueRegistrationEmails",
  /enqueueOrderEmail\(|enqueueRegistrationEmails\(/.test(srv),
  false,
);
checkTrue(
  "讀不到已寄紀錄 → 這一輪不寄",
  /sent === null[\s\S]{0,80}sent_alerts_unreadable/.test(srv),
);
checkTrue(
  "去重查詢用前綴 like，只 select dedupe_key 與 created_at",
  /select\("dedupe_key, created_at"\)[\s\S]{0,40}\.like\("dedupe_key"/.test(srv),
);

const fns = stripComments(read("src/lib/admin/fns/invoices.ts"));
// 0047 起多了第三支 voidInvoiceAdmin（作廢發票，scripts/invoice-void-selftest.mjs 另有細驗）。
check(
  "fns/invoices.ts 三支 server fn 都掛 adminFnMiddleware",
  (fns.match(/\.middleware\(\[adminFnMiddleware\]\)/g) ?? []).length,
  3,
);
check("fns/invoices.ts 沒有 createServerFn 漏掛", (fns.match(/createServerFn\(/g) ?? []).length, 3);
checkTrue("actorId 只認 context.admin.userId", fns.includes("context.admin.userId"));
check(
  "data 裡沒有 actorId（每一段 inputValidator(…) 到 .handler 之間都沒有）",
  (fns.match(/\.inputValidator\([\s\S]*?\.handler\(/g) ?? []).some((seg) => /actorId/.test(seg)),
  false,
);
check(
  "handler 裡的 actorId 都來自 context.admin.userId",
  (fns.match(/actorId\s*:[^,\n]*/g) ?? []).every((m) => /context\.admin\.userId/.test(m)),
  true,
);

const issuer = stripComments(read("src/server/invoice-issuer.ts"));
const reissue = issuer.slice(issuer.indexOf("export async function reissueInvoiceForOrder"));
checkTrue(
  "重新開立走 issueInvoiceForOrder(..., { requireLookup: true })",
  reissue.includes("issueInvoiceForOrder(orderId, { requireLookup: true })"),
);
checkTrue(
  "重新開立先擋未付款／金額 0／已開立／已作廢",
  ["not_paid", "zero_total", "already_issued", "voided"].every((r) => reissue.includes(`"${r}"`)),
);
check(
  "重新開立不直接呼叫 issueInvoice（不繞過 claim）",
  /[^.]\bissueInvoice\(/.test(reissue),
  false,
);
checkTrue(
  "requireLookup 讓 attempt=0 也先查",
  issuer.includes("attempt > 0 || options.requireLookup"),
);
checkTrue(
  "requireLookup 時查詢失敗就不開",
  /!found\.ok && options\.requireLookup[\s\S]{0,400}return \{ ok: false/.test(issuer),
);

const repo = stripComments(read("src/server/repos/invoices.ts"));
const reset = repo.slice(repo.indexOf("export async function resetInvoiceRetriesForReissue"));
checkTrue("重設 retry_count 為 1（不是 0）", reset.includes(".update({ retry_count: 1 })"));
checkTrue("重設只動 status = failed 的列", reset.includes('.eq("status", "failed")'));

const listRepo = stripComments(read("src/server/repos/orders-admin.ts"));
checkTrue(
  "篩選列表用同一個 loadInvoiceAttentionRows",
  /scope === "invoice_problem"[\s\S]{0,300}loadInvoiceAttentionRows/.test(listRepo),
);
checkTrue(
  "首頁橫幅用同一個 loadInvoiceAttentionRows",
  stripComments(read("src/lib/admin/fns/dashboard.ts")).includes("loadInvoiceAttentionRows()"),
);
checkTrue(
  "橫幅 server fn 用同一個 loadInvoiceAttentionRows",
  fns.includes("loadInvoiceAttentionRows()"),
);
checkTrue(
  "橫幅連到 ?scope=invoice_problem",
  stripComments(read("src/components/admin/InvoiceProblemBanner.tsx")).includes(
    'search={{ scope: "invoice_problem" }}',
  ),
);
checkTrue(
  "首頁放了橫幅",
  read("src/routes/admin/_shell.index.tsx").includes(
    "<InvoiceProblemBanner count={invoiceProblems} />",
  ),
);
checkTrue(
  "訂單列表放了橫幅",
  read("src/routes/admin/_shell.orders.tsx").includes(
    "<InvoiceProblemBanner count={invoiceProblems} />",
  ),
);
const labels = await import(pathToFileURL(join(ROOT, "src/lib/admin/order-labels.ts")).href);
check(
  "網址 ?scope=invoice_problem 解得出來",
  labels.parseOrderListSearch({ scope: "invoice_problem" }),
  { scope: "invoice_problem" },
);
check(
  "scopeOf 認得 invoice_problem",
  labels.scopeOf({ scope: "invoice_problem" }),
  "invoice_problem",
);
checkTrue(
  "server fn 的 zod scope 收 invoice_problem",
  read("src/lib/admin/fns/orders.ts").includes('"invoice_problem"'),
);
const detail = read("src/routes/admin/_shell.orders_.$id.tsx");
checkTrue(
  "內頁有確認框才送出重新開立",
  /reissueConfirmOpen[\s\S]*AlertDialogAction[\s\S]*submitReissue\(\)/.test(detail),
);
const detailCode = stripComments(detail);
check(
  "內頁 render 裡不 new Date()（按鈕由伺服器算，避免 hydration mismatch）",
  /new Date\(\)/.test(detailCode.slice(detailCode.indexOf("function InvoiceStatusBlock"))),
  false,
);
checkTrue(
  "內頁按鈕用伺服器算好的 invoice_can_reissue",
  detailCode.includes("detail.invoice_can_reissue"),
);
checkTrue(
  "伺服器用 canReissueInvoice + INVOICE_MAX_RETRIES 算按鈕",
  /invoice_can_reissue: canReissueInvoice\([\s\S]{0,400}INVOICE_MAX_RETRIES/.test(listRepo),
);
checkTrue(
  "「已開出但沒寫回」單獨回報，不說成開立失敗",
  reissue.includes('"issued_but_not_recorded"') && reissue.includes('reason: "issued_unrecorded"'),
);
checkTrue(
  "內頁對 issued_unrecorded 提醒不要手動重開",
  /case "issued_unrecorded"[\s\S]{0,300}請不要到光貿後台手動再開一張/.test(detailCode),
);

// -----------------------------------------------------------------------------
console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
