#!/usr/bin/env node
/**
 * blackcat-selftest.mjs —— 黑貓 PAY（統一客樂得 COCS）線上刷卡串接的自檢
 *
 * 規格依據：多元支付平台-WEBAPI介面規格 V1.28.2（頁碼都以那一份為準）。
 *
 * ── 這支測試**永遠不會對真實 gateway 做任何事** ──────────────────────────
 * 它一次 `fetch` 都不會發到 4128888card.com.tw：所有對外呼叫都被
 * __setQueryCocsOrderForTests() 換掉，建單那條路徑則完全不進入（handler 不建單）。
 * 沒有憑證也跑得完，而且**就算有憑證也不會建立任何訂單或付款**。
 *
 * ── 分兩段 ───────────────────────────────────────────────────────────────
 *   [靜態] 直接 import **產線的** src/server/blackcat.ts 與 src/server/blackcat-webhook.ts
 *          本人（不是複本），驗兩套驗簽、APN handler 的決策、降級行為。
 *          **永遠會跑。**
 *
 *          blackcat.ts 只 import node:crypto，所以 Node 的原生 type stripping
 *          直接載得動。blackcat-webhook.ts 有 `@/` 別名與 service_role 的資料層，
 *          所以用 node:module 的 registerHooks 把 `@/` 指回 src/、把資料層換成
 *          記憶體 stub —— **被測的仍然是產線那一支 .ts 檔本人**，只有它的鄰居是假的。
 *          需要 Node ≥ 22.18（type stripping）與 ≥ 22.15（registerHooks）。CI 用 24。
 *
 *   [連線] 對一個真的 PostgreSQL **同時發請求**驗去重與狀態轉移。每一次 q() 都是
 *          一個獨立的 psql 子行程 = 一條獨立連線 = 一個獨立交易，所以 Promise.all
 *          出來的是真正的併發。缺 BLACKCAT_SELFTEST_PG_URL 就整段 skip（會印出來）。
 *
 *     createdb ib_p3_test   # 若還沒有
 *     BLACKCAT_SELFTEST_PG_URL=postgres:///ib_p3_test \
 *     BLACKCAT_SELFTEST_APPLY=1 node scripts/blackcat-selftest.mjs
 *
 * ── ⚠️ 斷言的命名紀律 ────────────────────────────────────────────────────
 * 產線那邊有一個刻意的命名決定：驗 checksum 的函式**不叫** verifyApnSignature，
 * 叫 apnChecksumMatches()，因為它證明的是完整性、不是身分。同樣的紀律套用在
 * 這裡的斷言名稱上：名字要讓人一眼看出**它證明了什麼、以及它不證明什麼**。
 * 所以下面會看到「…—— 這證明它擋不住偽造」這種寫法，那不是囉嗦，那是重點。
 *
 * 環境變數：
 *   BLACKCAT_SELFTEST_PG_URL   本機測試庫的連線字串（[連線] 段的開關）
 *   BLACKCAT_SELFTEST_APPLY    設成 1 時先套用 0001–0024
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  assertLedgerMatchesDisk,
  assertLedgerDeclarationsHonest,
  assertMigrationDependencies,
  readMigrationFiles,
} from "./lib/migration-ledger.mjs";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/blackcat-selftest.mjs";
const MIG_DIR = join(ROOT, "supabase/migrations");

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

let pass = 0;
let fail = 0;
const skipped = [];

function check(name, actual, expected, note = "") {
  const ok = Object.is(actual, expected);
  if (ok) {
    pass++;
    console.log(green(`  ✓ ${name}`));
  } else {
    fail++;
    console.log(red(`  ✗ ${name}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，得到 ${JSON.stringify(actual)}`));
    if (note) console.log(red(`      ${note}`));
  }
}
const checkTrue = (name, cond, note = "") => check(name, Boolean(cond), true, note);
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const sha256File = (rel) =>
  createHash("sha256")
    .update(readFileSync(join(ROOT, rel)))
    .digest("hex");
const readFile = (p) => readFileSync(p, "utf8");

// 產線憑證絕不可能出現在這支測試裡；下面所有值都是自己編的。
const FIXTURE = {
  custId: "SELFTEST_CUST",
  password: "SELFTEST_PASSWORD",
  hashBase: "SELFTEST_HASH_BASE",
  secret: "selftest-webhook-secret-0123456789abcdef",
};

function setEnv(overrides = {}) {
  const base = {
    SITE_URL: "https://selftest.example.invalid",
    BLACKCAT_CUST_ID: FIXTURE.custId,
    BLACKCAT_API_PASSWORD: FIXTURE.password,
    BLACKCAT_HASH_BASE: FIXTURE.hashBase,
    BLACKCAT_WEBHOOK_SECRET: FIXTURE.secret,
    BLACKCAT_SANDBOX: "true",
  };
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
}
setEnv();

console.log("══════════════════════════════════════════════════════");
console.log(" 黑貓 PAY (統一客樂得 COCS) 線上刷卡自檢");
console.log(" 規格 V1.28.2 — 這支測試不會對真實 gateway 做任何事");
console.log("══════════════════════════════════════════════════════");

// =============================================================================
// 載入產線模組
// =============================================================================
const STUB_STATE = {
  order: null,
  queryCalls: [],
  claimResult: "claimed",
  markPaidResult: { ok: true, changed: true },
  paidCalls: [],
  failedCalls: [],
  annotations: [],
  released: [],
  claims: [],
};

const STUBS = new Map([
  [
    "@/server/repos/payments",
    `import { S } from "stub:state";
export const findOrderByOrderNo = async (no) => S.order;
export const claimWebhookEvent = async (key, payload, gateway) => { S.claims.push({ key, gateway }); return S.claimResult; };
export const releaseWebhookClaim = async (key, gateway) => { S.released.push({ key, gateway }); };
export const annotateWebhookEvent = async (key, payload, gateway) => { S.annotations.push({ key, payload, gateway }); };
export const eventKeyForBlackcat = (b) => \`\${b.order_no ?? "-"}:\${b.trans_id ?? "-"}:\${b.status ?? "-"}\`;
export const markOrderPaid = async (order, detail) => { S.paidCalls.push({ order, detail }); return S.markPaidResult; };
export const markPaymentFailed = async (order, detail) => { S.failedCalls.push({ order, detail }); return "changed"; };`,
  ],
  ["@/server/repos/orders", `export const commitInventoryForOrder = async () => {};`],
  [
    "@/server/invoice-issuer",
    `export const triggerInvoiceAfterPayment = async () => ({ ok: true });`,
  ],
  ["@/server/notify", `export const triggerNotifyAfterPayment = async () => ({ ok: true });`],
]);

globalThis.__BLACKCAT_SELFTEST_STATE__ = STUB_STATE;

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "stub:state") return { url: "stub:state", shortCircuit: true };
    if (STUBS.has(spec)) return { url: `stub:${spec}`, shortCircuit: true };
    if (spec.startsWith("@/")) {
      return {
        url: pathToFileURL(join(ROOT, "src", `${spec.slice(2)}.ts`)).href,
        shortCircuit: true,
      };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url === "stub:state") {
      return {
        format: "module",
        source: "export const S = globalThis.__BLACKCAT_SELFTEST_STATE__;",
        shortCircuit: true,
      };
    }
    if (url.startsWith("stub:")) {
      return { format: "module", source: STUBS.get(url.slice(5)), shortCircuit: true };
    }
    return next(url, ctx);
  },
});

const BC_PATH = join(ROOT, "src/server/blackcat.ts");
const WH_PATH = join(ROOT, "src/server/blackcat-webhook.ts");
const bc = await import(pathToFileURL(BC_PATH).href);
const wh = await import(pathToFileURL(WH_PATH).href);
const BC_SRC = readFile(BC_PATH);
const WH_SRC = readFile(WH_PATH);

// =============================================================================
// [1] 驗簽（一）：APN 的 checksum —— 用規格書的範例值當 known-answer 測資
// =============================================================================
console.log("\n[1] APN checksum —— 規格 P89/P90 的公式與範例");

// 規格 P90 的完整範例。這是規格書自己印出來的摘要，不是我們算出來再拿去對自己。
const SPEC_COCS_APN = {
  api_id: "CC0000000001",
  trans_id: "550e8400e29b41d4a716446655440000",
  amount: 1250,
  status: "B",
  nonce: "1234569999",
  checksum: "d09d5532767453ad4c6ba9b649034187",
};
check(
  "規格 P90 的 COCS APN 範例算得出規格書印的那個 checksum（known-answer）",
  bc.apnChecksum({
    apiId: SPEC_COCS_APN.api_id,
    transId: SPEC_COCS_APN.trans_id,
    amount: SPEC_COCS_APN.amount,
    status: SPEC_COCS_APN.status,
    nonce: SPEC_COCS_APN.nonce,
  }),
  SPEC_COCS_APN.checksum,
);

// 規格 P38 的 CVS 範例。這一輪不接代收代付，但公式完全相同 —— 對得上就證明
// 我們實作的是「那一條公式」，而不是「剛好讓 COCS 那一組數字通過的東西」。
check(
  "規格 P38 的 CVS APN 範例用同一條公式也算得出來（證明公式對，不是湊出來的）",
  bc.apnChecksum({
    apiId: "CV0000000000",
    transId: "550e8400e29b41d4a716446655440000",
    amount: 1250,
    status: "D",
    nonce: "1234569999",
  }),
  "3579609ba3914a49441e98cb7e8a55de",
);

check(
  '分隔符號是冒號（規格 P89 的 api_id +":"+ trans_id +…）',
  bc.apnChecksum({ apiId: "A", transId: "B", amount: 1, status: "S", nonce: "N" }),
  md5("A:B:1:S:N"),
);

check(
  "只有 5 個欄位參與，多帶的欄位不影響結果",
  bc.apnChecksum({ apiId: "A", transId: "B", amount: 1, status: "S", nonce: "N", extra: "x" }),
  md5("A:B:1:S:N"),
);

// 🔴 這一條是整個串接最重要的斷言之一。
{
  const before = bc.apnChecksum({ apiId: "A", transId: "B", amount: 1, status: "S", nonce: "N" });
  setEnv({ BLACKCAT_HASH_BASE: "COMPLETELY_DIFFERENT_HASH_BASE" });
  const after = bc.apnChecksum({ apiId: "A", transId: "B", amount: 1, status: "S", nonce: "N" });
  setEnv();
  check(
    "🔴 換掉 hash_base 完全不影響 APN checksum —— 這證明它「不含祕密」，也就證明它擋不住偽造，不是證明它安全",
    after,
    before,
  );
}

check(
  'amount 用收到的原樣去算：1250 與 "1250" 同值，所以兩者算出來一樣',
  bc.apnChecksum({ apiId: "A", transId: "B", amount: 1250, status: "S", nonce: "N" }),
  bc.apnChecksum({ apiId: "A", transId: "B", amount: "1250", status: "S", nonce: "N" }),
);

checkTrue(
  "apnChecksumMatches 對規格範例回 true（它只證明五個欄位彼此一致，不證明來源可信）",
  bc.apnChecksumMatches({
    apiId: SPEC_COCS_APN.api_id,
    transId: SPEC_COCS_APN.trans_id,
    amount: SPEC_COCS_APN.amount,
    status: SPEC_COCS_APN.status,
    nonce: SPEC_COCS_APN.nonce,
    checksum: SPEC_COCS_APN.checksum,
  }),
);

checkTrue(
  "改掉 amount 之後 apnChecksumMatches 回 false（證明它擋得住「傳輸中被改」這一種，僅此而已）",
  !bc.apnChecksumMatches({
    ...SPEC_COCS_APN,
    apiId: SPEC_COCS_APN.api_id,
    transId: SPEC_COCS_APN.trans_id,
    amount: 9999,
    status: SPEC_COCS_APN.status,
    nonce: SPEC_COCS_APN.nonce,
    checksum: SPEC_COCS_APN.checksum,
  }),
);

checkTrue(
  "checksum 長度不是 32 就直接 false（規格 P89 明寫 32），不進到比對",
  !bc.apnChecksumMatches({
    apiId: "A",
    transId: "B",
    amount: 1,
    status: "S",
    nonce: "N",
    checksum: "abc",
  }),
);

checkTrue(
  "🔴 偽造者用公開欄位就能算出合法 checksum —— 這一條刻意證明「checksum 通過」不等於「通知是真的」",
  bc.apnChecksumMatches({
    apiId: "CC0000000001",
    transId: "forged-trans-id",
    amount: 999999,
    status: "B",
    nonce: "0000000000",
    checksum: md5("CC0000000001:forged-trans-id:999999:B:0000000000"),
  }),
);

// =============================================================================
// [2] 驗簽（二）：導回的 chk —— 兩條公式、都含 hash_base、絕不可混用
// =============================================================================
console.log("\n[2] 導回 chk —— 規格 P46（成功 9 段）／P48（失敗 6 段）");

// 規格 P47 的 sample 欄位值。hash_base 是配發的祕密，規格書沒印，所以這裡用
// 自己的 fixture，驗的是**被雜湊的那個字串長什麼樣**，而不是規格書的摘要值。
const RET = {
  ret: "OK",
  cust_order_no: "C201709141001",
  order_amount: "2",
  send_time: "2017-09-14 10:31:25",
  acquire_time: "2017-09-14 10:36:38",
  auth_code: "951294",
  card_no: "1849",
  notify_time: "2017-09-14 10:37:08",
};

const expectSuccess = md5(
  [
    FIXTURE.hashBase,
    RET.order_amount,
    RET.send_time,
    RET.ret,
    RET.acquire_time,
    RET.auth_code,
    RET.card_no,
    RET.notify_time,
    RET.cust_order_no,
  ].join("$"),
);
const expectFail = md5(
  [
    FIXTURE.hashBase,
    RET.order_amount,
    RET.send_time,
    "FAIL",
    RET.notify_time,
    RET.cust_order_no,
  ].join("$"),
);

check(
  "成功公式：'$' 分隔、含 hash_base、順序是 P46 那個順序（send_time 在 ret 之前，不是欄位表順序）",
  bc.returnChkSuccess({
    orderAmount: RET.order_amount,
    sendTime: RET.send_time,
    ret: RET.ret,
    acquireTime: RET.acquire_time,
    authCode: RET.auth_code,
    cardNo: RET.card_no,
    notifyTime: RET.notify_time,
    custOrderNo: RET.cust_order_no,
  }),
  expectSuccess,
);

check(
  "失敗公式：只有 6 段，沒有 acquire_time / auth_code / card_no（授權沒成功，那三個不存在）",
  bc.returnChkFail({
    orderAmount: RET.order_amount,
    sendTime: RET.send_time,
    ret: "FAIL",
    notifyTime: RET.notify_time,
    custOrderNo: RET.cust_order_no,
  }),
  expectFail,
);

checkTrue(
  "🔴 成功與失敗兩條公式產生不同摘要 —— 這是「不可混用」的可執行證據",
  expectSuccess !== expectFail,
);

{
  // 🔴 與 APN 相反的那一條：導回的 chk **含**祕密，所以它真的擋得住偽造。
  const before = bc.returnChkSuccess({
    orderAmount: "2",
    sendTime: "t",
    ret: "OK",
    acquireTime: "a",
    authCode: "c",
    cardNo: "n",
    notifyTime: "m",
    custOrderNo: "o",
  });
  setEnv({ BLACKCAT_HASH_BASE: "ANOTHER_HASH_BASE" });
  const after = bc.returnChkSuccess({
    orderAmount: "2",
    sendTime: "t",
    ret: "OK",
    acquireTime: "a",
    authCode: "c",
    cardNo: "n",
    notifyTime: "m",
    custOrderNo: "o",
  });
  setEnv();
  checkTrue(
    "🔴 換掉 hash_base 會改變導回 chk —— 這證明它「含祕密」，與 APN 的 checksum 是相反的性質",
    before !== after,
  );
}

const okParams = new URLSearchParams({ ...RET, chk: expectSuccess });
checkTrue("verifyReturnChk 接受一份正確的成功導回", bc.verifyReturnChk(okParams));

const failParams = new URLSearchParams({
  ret: "FAIL",
  cust_order_no: RET.cust_order_no,
  order_amount: RET.order_amount,
  send_time: RET.send_time,
  notify_time: RET.notify_time,
  chk: expectFail,
});
checkTrue(
  "verifyReturnChk 接受一份正確的失敗導回（走的是 6 段那條公式）",
  bc.verifyReturnChk(failParams),
);

checkTrue(
  "🔴 把成功導回的 chk 貼到失敗導回上會被拒絕 —— 兩套公式混用會被抓到",
  !bc.verifyReturnChk(
    new URLSearchParams({
      ret: "FAIL",
      cust_order_no: RET.cust_order_no,
      order_amount: RET.order_amount,
      send_time: RET.send_time,
      notify_time: RET.notify_time,
      chk: expectSuccess,
    }),
  ),
);

checkTrue(
  "🔴 把 APN 的 checksum 拿來當導回的 chk 會被拒絕 —— 兩套驗簽不是同一件事",
  !bc.verifyReturnChk(new URLSearchParams({ ...RET, chk: SPEC_COCS_APN.checksum })),
);

{
  setEnv({ BLACKCAT_HASH_BASE: null });
  const got = bc.verifyReturnChk(okParams);
  setEnv();
  check(
    "缺 hash_base 時 verifyReturnChk 回 false（驗不了就是驗不過，不是「跳過檢查」）",
    got,
    false,
  );
}

// =============================================================================
// [3] APN handler —— 跑的是產線的 src/server/blackcat-webhook.ts 本人
// =============================================================================
console.log("\n[3] APN handler —— 權威來源是回查，不是通知內容");

const ORDER = {
  id: "00000000-0000-4000-8000-000000000001",
  order_no: "IB-202600000001",
  public_token: "selftest-public-token-0123456789",
  total: 500,
  status: "pending",
  payment_status: "pending",
  paid_at: null,
};

/** 一份「長得完全正確」的 APN 通知；checksum 會依內容重算，除非呼叫端自己指定。 */
function apnBody(over = {}) {
  const b = {
    api_id: FIXTURE.custId,
    trans_id: "trans-0001",
    order_no: ORDER.order_no,
    amount: 500,
    status: "B",
    payment_code: 1,
    payment_detail: {
      auth_code: "000000",
      auth_card_no: "000000******0000",
      pay_date: "2026-08-31 10:00:00",
      pay_amount: 500,
      fee: null,
      mer_trade_no: "900000000000000",
    },
    memo: "",
    expire_time: "2026-08-31 12:00:00",
    create_time: "2026-08-31 09:00:00",
    modify_time: "2026-08-31 10:00:00",
    nonce: "1234569999",
    ...over,
  };
  if (!("checksum" in over)) {
    b.checksum = md5(`${b.api_id}:${b.trans_id}:${b.amount}:${b.status}:${b.nonce}`);
  }
  return b;
}

function resetState({
  order = ORDER,
  claimResult = "claimed",
  markPaidResult = { ok: true, changed: true },
} = {}) {
  STUB_STATE.order = order;
  STUB_STATE.queryCalls = [];
  STUB_STATE.claimResult = claimResult;
  STUB_STATE.markPaidResult = markPaidResult;
  STUB_STATE.paidCalls = [];
  STUB_STATE.failedCalls = [];
  STUB_STATE.annotations = [];
  STUB_STATE.released = [];
  STUB_STATE.claims = [];
  setEnv();
}

/** 換掉回查。**產線路徑上沒有第二條路**，所以換掉它就等於攔住了唯一的權威來源。 */
function stubQuery(result) {
  wh.__setQueryCocsOrderForTests(async (orderNo) => {
    STUB_STATE.queryCalls.push(orderNo);
    return result;
  });
}
const queryOk = (processCode, extra = {}) => ({
  ok: true,
  result: {
    processCode,
    orderAmount: 500,
    acquirerType: "統一金流",
    raw: { process_code: processCode, ...extra },
  },
});

async function postApn(
  body,
  { secret = FIXTURE.secret, rawBody = null, contentType = "application/json" } = {},
) {
  const qs = secret === null ? "" : `?k=${encodeURIComponent(secret)}`;
  const req = new Request(`https://selftest.example.invalid/api/webhooks/blackcat${qs}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: rawBody ?? JSON.stringify(body),
  });
  const res = await wh.handleBlackcatApn(req);
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get("content-type"),
  };
}

// ---- 一定會回查 -------------------------------------------------------------
resetState();
stubQuery(queryOk(15));
{
  const r = await postApn(apnBody());
  check(
    "🔴 收到合法 APN 之後，handler 確實呼叫了訂單查詢（回查次數）",
    STUB_STATE.queryCalls.length,
    1,
  );
  check("回查帶的是通知裡的 order_no", STUB_STATE.queryCalls[0], ORDER.order_no);
  check("process_code=15（授權完成）→ 標記付款", STUB_STATE.paidCalls.length, 1);
  check("APN 回應是 HTTP 200", r.status, 200);
  check(
    "🔴 APN 回應的 body 逐字元是純文字 OK（規格 P87：否則每 15 分鐘重送、最多 3 次）",
    r.body,
    "OK",
  );
  checkTrue(
    "APN 回應的 content-type 是 text/plain",
    (r.contentType ?? "").startsWith("text/plain"),
  );
}

// ---- 🔴 只信回查結果，不信通知內容 -----------------------------------------
resetState();
stubQuery(queryOk(16)); // 16 = 授權失敗
{
  // 這一份通知的 checksum **完全正確**，status 卻是偽造的 "B"（授權完成）。
  // 任何人都算得出這個 checksum（見 [1] 最後一條），所以這正是真實的攻擊形狀。
  const forged = apnBody({ status: "B" });
  checkTrue(
    "（前提）這份造假通知的 checksum 是對的 —— 否則下面那條斷言就不成立了",
    bc.apnChecksumMatches({
      apiId: forged.api_id,
      transId: forged.trans_id,
      amount: forged.amount,
      status: forged.status,
      nonce: forged.nonce,
      checksum: forged.checksum,
    }),
  );
  const r = await postApn(forged);
  check(
    "🔴 checksum 正確但狀態造假、回查說授權失敗 → **不標記付款**",
    STUB_STATE.paidCalls.length,
    0,
  );
  check("而且它被當成失敗處理（回查說 16）", STUB_STATE.failedCalls.length, 1);
  check("仍然回 200 OK（重送不會讓結果變好）", r.status, 200);
}

resetState();
stubQuery(queryOk(13)); // 13 = 刷卡確認頁：客人走到頁面了，銀行還沒授權
{
  await postApn(apnBody({ status: "B" }));
  check(
    "🔴 通知說 B（授權完成）但回查只到 13（刷卡確認頁）→ 不標記付款",
    STUB_STATE.paidCalls.length,
    0,
  );
  check("也不標記失敗 —— 這是「還在路上」，不是「錢沒了」", STUB_STATE.failedCalls.length, 0);
}

// ---- 回查失敗 = fail-closed -------------------------------------------------
resetState();
stubQuery({ ok: false, reason: "connection reset" });
{
  const r = await postApn(apnBody());
  check("🔴 回查失敗 → 回 500 逼對方重送（fail-closed），絕不靜默 ack", r.status, 500);
  check("而且沒有標記付款", STUB_STATE.paidCalls.length, 0);
  check("回查失敗發生在 claim 之前，所以沒有佔走任何 event_key", STUB_STATE.claims.length, 0);
}

resetState();
stubQuery(queryOk(15));
setEnv({ BLACKCAT_CUST_ID: null });
{
  const r = await postApn(apnBody());
  check("缺憑證無法回查 → 503（而不是拿通知內容湊合著用）", r.status, 503);
  check("而且沒有標記付款", STUB_STATE.paidCalls.length, 0);
}
setEnv();

// ---- 第 ① 層：密鑰閘門 -----------------------------------------------------
resetState();
stubQuery(queryOk(15));
{
  const r = await postApn(null, { secret: "wrong-secret", rawBody: "{ this is not json" });
  check("?k= 不符 → 404", r.status, 404);
  check("🔴 而且 body 是壞掉的 JSON 也一樣回 404 —— 證明閘門在 body 解析**之前**", r.status, 404);
  check("沒有呼叫回查", STUB_STATE.queryCalls.length, 0);
}

resetState();
stubQuery(queryOk(15));
{
  const r = await postApn(apnBody(), { secret: null });
  check("完全沒帶 ?k= → 404", r.status, 404);
}

resetState();
stubQuery(queryOk(15));
setEnv({ BLACKCAT_WEBHOOK_SECRET: null });
{
  const r = await postApn(apnBody(), { secret: "anything" });
  check("伺服器端沒設 BLACKCAT_WEBHOOK_SECRET → 503（不是放行）", r.status, 503);
}
setEnv();

resetState();
stubQuery(queryOk(15));
{
  const r = await postApn(apnBody(), { rawBody: "not json at all" });
  check("通過閘門但 body 不是 JSON → 400", r.status, 400);
  check("沒有呼叫回查", STUB_STATE.queryCalls.length, 0);
}

// ---- 完整性預篩 -------------------------------------------------------------
resetState();
stubQuery(queryOk(15));
{
  const r = await postApn(apnBody({ checksum: "00000000000000000000000000000000" }));
  check("checksum 不符 → 400", r.status, 400);
  check("而且沒有呼叫回查（壞掉的東西不值得一次外呼）", STUB_STATE.queryCalls.length, 0);
}

// ---- 找不到訂單：不回查（防放大攻擊）---------------------------------------
resetState({ order: null });
stubQuery(queryOk(15));
{
  const r = await postApn(apnBody({ order_no: "IB-999999999999" }));
  check("找不到訂單 → 200 OK（不讓對方無止盡重送）", r.status, 200);
  check(
    "🔴 而且**沒有**呼叫回查 —— 否則未經認證的 POST 就能把我們變成打黑貓的放大器",
    STUB_STATE.queryCalls.length,
    0,
  );
}

// =============================================================================
// [4] 金額：pay_amount 才算數，amount 不算
// =============================================================================
console.log("\n[4] 金額比對 —— 規格 P35 注意事項 2：以實際繳款金額判別");

check(
  "apnPaidAmount 讀 payment_detail.pay_amount（COCS，規格 P88）",
  bc.apnPaidAmount({ payment_detail: { pay_amount: 888 } }),
  888,
);
check(
  "apnPaidAmount 也讀頂層 pay_amount（CVS，規格 P37；為第二條路預留）",
  bc.apnPaidAmount({ pay_amount: "1250" }),
  1250,
);
check(
  "payment_detail 優先於頂層",
  bc.apnPaidAmount({ pay_amount: 1, payment_detail: { pay_amount: 2 } }),
  2,
);
check(
  "🔴 讀不到就回 null，**不是 0** —— 那是兩件完全不同的事",
  bc.apnPaidAmount({ amount: 500 }),
  null,
);
check(
  "pay_amount 為 null（規格 P88 的「刷卡失敗或尚未授權」範例）也回 null",
  bc.apnPaidAmount({ payment_detail: { pay_amount: null } }),
  null,
);

resetState();
stubQuery(queryOk(15));
{
  // amount 說 1250、實收只有 500。checksum 是照 amount 算的，所以它會通過。
  const body = apnBody({ amount: 1250, payment_detail: { pay_amount: 500 } });
  const r = await postApn(body);
  check(
    "🔴 amount=1250 但 pay_amount=500 而訂單是 500 → 以 pay_amount 為準，標記付款",
    STUB_STATE.paidCalls.length,
    1,
  );
  check("寫進 payments 的金額是訂單金額 500", STUB_STATE.paidCalls[0]?.detail?.amount, 500);
  check("回 200 OK", r.status, 200);
}

resetState();
stubQuery(queryOk(15));
{
  // 反過來：amount 剛好等於訂單金額，但實收只有 1 元。
  // 這正是「checksum 通過不代表客人付對了錢」的樣子 —— 只看 amount 會直接放行。
  const body = apnBody({ amount: 500, payment_detail: { pay_amount: 1 } });
  const r = await postApn(body);
  check(
    "🔴 amount=500（與訂單相符）但 pay_amount=1 → **拒絕標記付款**",
    STUB_STATE.paidCalls.length,
    0,
  );
  check("回 200 OK（金額不符不是重試能解決的）", r.status, 200);
  check(
    "拒絕理由記進 webhook_events",
    STUB_STATE.annotations[0]?.payload?.refused,
    "amount_mismatch",
  );
  check("而且記下實收多少", STUB_STATE.annotations[0]?.payload?.collected, 1);
  check("以及應收多少", STUB_STATE.annotations[0]?.payload?.expected, 500);
}

resetState();
stubQuery(queryOk(15));
{
  // 快樂手那一版在這裡有 `payAmount ?? remoteAmount` 的 fallback，而 remoteAmount
  // 是回查的 order_amount ——它永遠等於 orders.total，所以比對會退化成 total===total
  // 恆真。這一條測試就是那個 fallback 的守門員。
  const body = apnBody({ payment_detail: { auth_code: "000000", pay_amount: null } });
  const r = await postApn(body);
  check(
    "🔴 授權完成但通知沒有 pay_amount → **拒絕標記付款**（絕不 fallback 到 amount / order_amount）",
    STUB_STATE.paidCalls.length,
    0,
  );
  check(
    "拒絕理由是 missing_pay_amount",
    STUB_STATE.annotations[0]?.payload?.refused,
    "missing_pay_amount",
  );
  check("回 200 OK", r.status, 200);
  checkTrue(
    "（回歸守門）回查的 order_amount 剛好等於訂單金額 —— 所以「拿它當 fallback」會恆真通過",
    500 === ORDER.total,
  );
}

// =============================================================================
// [5] 去重與重試
// =============================================================================
console.log("\n[5] 去重 claim 的三態，以及 claim 的歸還");

resetState({ claimResult: "duplicate" });
stubQuery(queryOk(15));
{
  const r = await postApn(apnBody());
  check("重複通知 → 200", r.status, 200);
  check("重複通知的 body 也是純文字 OK（否則對方會繼續重送）", r.body, "OK");
  check("重複通知不會再標記一次付款", STUB_STATE.paidCalls.length, 0);
}

resetState({ claimResult: "error" });
stubQuery(queryOk(15));
{
  const r = await postApn(apnBody());
  check(
    "🔴 claim 回 error（資料庫真的壞了）→ 500 逼重送，**不可以**當成 duplicate 靜默 ack",
    r.status,
    500,
  );
  check("而且沒有標記付款", STUB_STATE.paidCalls.length, 0);
}

resetState({ markPaidResult: { ok: false, reason: "db_error" } });
stubQuery(queryOk(15));
{
  const r = await postApn(apnBody());
  check("markOrderPaid 遇到 db_error → 500", r.status, 500);
  check(
    "🔴 而且把 claim 還回去，否則重送會被自己的去重鎖擋成重複、永久掉單",
    STUB_STATE.released.length,
    1,
  );
  check(
    "還回去的是同一個 event_key",
    STUB_STATE.released[0]?.key,
    `${ORDER.order_no}:trans-0001:B`,
  );
  check("還回去時帶的 gateway 是 blackcat", STUB_STATE.released[0]?.gateway, "blackcat");
}

resetState({ markPaidResult: { ok: false, reason: "paid_after_cancel" } });
stubQuery(queryOk(15));
{
  const r = await postApn(apnBody());
  check("paid_after_cancel → 200（重送不會變好，需要人看）", r.status, 200);
  check(
    "🔴 但 claim 刻意**不**歸還 —— 重送只會把同一則告警再記三次",
    STUB_STATE.released.length,
    0,
  );
  check(
    "拒絕理由記進 webhook_events",
    STUB_STATE.annotations[0]?.payload?.refused,
    "paid_after_cancel",
  );
}

resetState();
stubQuery(queryOk(15));
{
  await postApn(apnBody());
  check(
    "claim 用的 gateway 是 blackcat（不可與 PayUni 共用同一個鍵空間）",
    STUB_STATE.claims[0]?.gateway,
    "blackcat",
  );
  check(
    "event_key 是 order_no:trans_id:status",
    STUB_STATE.claims[0]?.key,
    `${ORDER.order_no}:trans-0001:B`,
  );
  checkTrue(
    "🔴 event_key 不含 nonce —— 含了的話每一次重送都會長得像新事件，去重完全失效",
    !STUB_STATE.claims[0]?.key.includes("1234569999"),
  );
  checkTrue(
    "event_key 也不含 amount —— 否則偽造者改一個數字就繞過去重",
    !STUB_STATE.claims[0]?.key.includes("500"),
  );
}

// =============================================================================
// [6] 狀態碼對照（規格附件 1，P94-95）
// =============================================================================
console.log("\n[6] process_code / APN status 的分類");

check("15 授權完成 → 視為已授權", bc.AUTHORIZED_PROCESS_CODES.has(15), true);
check("20 請求請款 → 視為已授權", bc.AUTHORIZED_PROCESS_CODES.has(20), true);
check("21 請款作業中 → 視為已授權", bc.AUTHORIZED_PROCESS_CODES.has(21), true);
check("22 請款完成 → 視為已授權", bc.AUTHORIZED_PROCESS_CODES.has(22), true);
check(
  "🔴 13 刷卡確認頁 → **不算**授權（客人只是走到頁面上，銀行還沒授權）",
  bc.AUTHORIZED_PROCESS_CODES.has(13),
  false,
);
check("🔴 14 繳款人確認 → **不算**授權", bc.AUTHORIZED_PROCESS_CODES.has(14), false);
check(
  "🔴 23 請款失敗 → **不算**授權，但也不在失敗清單（授權還在、錢還在，需要人看）",
  bc.AUTHORIZED_PROCESS_CODES.has(23),
  false,
);
check("16 授權失敗 → 失敗", bc.FAILED_PROCESS_CODES.has(16), true);
check("6 繳款單逾期 → 失敗", bc.FAILED_PROCESS_CODES.has(6), true);
check("17 取消授權完成 → 失敗", bc.FAILED_PROCESS_CODES.has(17), true);
check("F 授權失敗 → 終局失敗", bc.APN_TERMINAL_FAILURES.has("F"), true);
check("D 訂單逾期 → 終局失敗", bc.APN_TERMINAL_FAILURES.has("D"), true);
check("Q 取消授權完成 → 終局失敗", bc.APN_TERMINAL_FAILURES.has("Q"), true);
check(
  "🔴 P 請款失敗 → **不是**終局失敗（授權還在，標成 failed 會讓客人重刷一次）",
  bc.APN_TERMINAL_FAILURES.has("P"),
  false,
);
check("🔴 N 取消交易失敗 → **不是**終局失敗（同上）", bc.APN_TERMINAL_FAILURES.has("N"), false);
check(
  "APN_STATUS 收齊了規格 P87-88 的 12 個狀態碼（含 I / J 兩個發票通知）",
  Object.keys(bc.APN_STATUS).length,
  12,
);
check("I（開立發票通知）在", bc.APN_STATUS.INVOICE_ISSUED, "I");
check("J（開立發票折讓單號通知）在", bc.APN_STATUS.INVOICE_ALLOWANCE, "J");

// =============================================================================
// [7] 設定、網址、時間格式
// =============================================================================
console.log("\n[7] 設定與降級 —— 缺憑證要長成「沒有這個選項」，不是「選了會壞」");

setEnv();
check("四個必要變數都在時 blackcatConfigured() 為 true", bc.blackcatConfigured(), true);

for (const missing of [
  "BLACKCAT_CUST_ID",
  "BLACKCAT_API_PASSWORD",
  "BLACKCAT_HASH_BASE",
  "BLACKCAT_WEBHOOK_SECRET",
]) {
  setEnv({ [missing]: null });
  check(
    `缺 ${missing} → blackcatConfigured() 為 false（結帳頁就不顯示刷卡）`,
    bc.blackcatConfigured(),
    false,
  );
  setEnv();
}

{
  // apn_url 上限 250 字（規格 P40）。SITE_URL 太長會讓網址超標，對方會靜默截斷，
  // 通知就永遠送不到 —— 而那等於「錢收了、訂單卡在 pending、庫存被排程收回去」。
  setEnv({ SITE_URL: `https://${"a".repeat(240)}.example.invalid` });
  check("🔴 apn_url 超過規格上限 250 字 → blackcatApnUrl() 回 null", bc.blackcatApnUrl(), null);
  check(
    "🔴 進而讓 blackcatConfigured() 為 false —— 寧可不顯示刷卡，也不要收得到錢卻收不到通知",
    bc.blackcatConfigured(),
    false,
  );
  setEnv();
}

// ── 🔴 金流商連不到的網址一律不算設定完成（2026-09-02 掉單事故的防線）──────
//
// 這一組守的是一個**真的發生過**的失敗：SITE_URL 從來沒有設在 Vercel 上，
// siteUrl() 因此退回預設值 http://localhost:8080，而 blackcatApnUrl() 與
// blackcatReturnUrl() 共用它。結果是客人刷卡成功被導到 localhost，而我們送給
// 黑貓的 APN 網址也是 localhost —— 通知永遠不會到，訂單卡在 pending，兩小時後
// 被 expire_unpaid_orders() 取消、座位還回去，而錢已經收了（IB-202600001191，
// NT$1,800，靠人工向黑貓回查才救回來）。
//
// 當時 blackcatApnUrl() 的註解已經預測到這件事，但把責任交給「部署設定」——
// 而那是一個沒有人在檢查的地方。現在擋在程式裡。
//
// 判準不是「哪個環境」而是「金流商連得到嗎」：loopback 與非 https 在任何環境下
// 都不是有效的 APN 目的地。
{
  const unreachable = [
    ["http://localhost:8080", "就是這次出事的那個預設值"],
    ["http://127.0.0.1:3000", "loopback 的另一種寫法"],
    ["https://localhost:8080", "https 但仍然是 loopback"],
    ["http://www.intervalbooks.tw", "正式網域但是 http —— 金流商不會打明文"],
    ["https://shop.local", ".local 是區網名稱"],
  ];
  for (const [site, why] of unreachable) {
    setEnv({ SITE_URL: site });
    check(`🔴 SITE_URL=${site} → blackcatApnUrl() 回 null（${why}）`, bc.blackcatApnUrl(), null);
    check(`🔴 進而讓 blackcatConfigured() 為 false（${site}）`, bc.blackcatConfigured(), false);
  }
  // 對照組：真的連得到的網址必須通過，否則上面那五條可能只是因為函式壞了。
  setEnv({ SITE_URL: "https://www.intervalbooks.tw" });
  checkTrue(
    "對照組：https 的正式網域通得過（證明上面不是因為函式整支壞掉）",
    (bc.blackcatApnUrl() ?? "").startsWith("https://www.intervalbooks.tw/"),
  );
  checkTrue("對照組：此時 blackcatConfigured() 為 true", bc.blackcatConfigured());
  setEnv();
}

checkTrue("APN 網址帶著 ?k= 密鑰閘門", (bc.blackcatApnUrl() ?? "").includes(`k=${FIXTURE.secret}`));
check(
  "APN 路徑與 src/server.ts 攔截的常數是同一個",
  bc.BLACKCAT_APN_PATH,
  "/api/webhooks/blackcat",
);
check("導回路徑同上", bc.BLACKCAT_RETURN_PATH, "/api/payments/blackcat/return");
checkTrue(
  "導回網址在建單當下就把 public_token 組進去（?t=）",
  bc.blackcatReturnUrl("tok123").includes("t=tok123"),
);

check(
  "測試環境 BaseUrl **含 /app 路徑**（規格 P9；當成「換個 host」會 404）",
  bc.blackcatBaseUrl(),
  "https://test.4128888card.com.tw/app",
);
setEnv({ BLACKCAT_SANDBOX: "false" });
check('只有明確寫 "false" 才切正式機', bc.blackcatBaseUrl(), "https://cocs.4128888card.com.tw");
setEnv({ BLACKCAT_SANDBOX: "no" });
check(
  '🔴 寫成 "no" 這種模稜兩可的值仍然走測試機 —— 忘了設的後果是付不了錢，不是拿測試憑證收真錢',
  bc.blackcatBaseUrl(),
  "https://test.4128888card.com.tw/app",
);
setEnv();
check("預設（未設定）走測試機", bc.blackcatBaseUrl(), "https://test.4128888card.com.tw/app");
check("預設收單行是統一金流 payuni（這家店合約開通的那一家）", bc.blackcatAcquirerType(), "payuni");
check("金額上限 100,000（規格 P40）", bc.MAX_ORDER_AMOUNT, 100000);

{
  const ts = bc.taipeiTimestamp(new Date("2026-08-31T02:03:04Z"));
  check(
    "send_time 是台北時間（UTC 02:03:04 → 10:03:04），不是 toISOString 的 UTC",
    ts,
    "2026-08-31 10:03:04",
  );
  checkTrue(
    "格式是 yyyy-MM-dd HH:mm:ss（規格範例 19 碼，欄位表寫 10 是筆誤）",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts),
  );
  check(
    "跨日邊界：UTC 16:00 → 台北隔天 00:00（不是 24:00）",
    bc.taipeiTimestamp(new Date("2026-08-31T16:00:00Z")),
    "2026-09-01 00:00:00",
  );
}

check("toInt 吃 number", bc.toInt(888), 888);
check("toInt 吃字串（CVS 的 pay_amount 是字串）", bc.toInt("1250"), 1250);
check("toInt 對空字串回 null", bc.toInt(""), null);
check("toInt 對 null 回 null", bc.toInt(null), null);

// =============================================================================
// [8] 導回 handler —— 它不碰付款狀態
// =============================================================================
console.log("\n[8] 導回 handler");

async function getReturn(qs) {
  const req = new Request(`https://selftest.example.invalid/api/payments/blackcat/return?${qs}`, {
    method: "GET",
  });
  const res = await wh.handleBlackcatReturn(req);
  return { status: res.status, location: res.headers.get("location") };
}

resetState();
{
  const r = await getReturn(
    new URLSearchParams({ ...RET, chk: expectSuccess, t: ORDER.public_token }).toString(),
  );
  check("成功導回 → 303 導去確認頁", r.status, 303);
  checkTrue("帶著 public_token", (r.location ?? "").includes(`token=${ORDER.public_token}`));
  checkTrue("成功時不加 payment=failed", !(r.location ?? "").includes("payment=failed"));
  check("🔴 導回**完全不碰**付款狀態 —— 錢的真相只來自 APN", STUB_STATE.paidCalls.length, 0);
}

resetState();
{
  // ⚠️ chk 必須用**同一組欄位值**算出來，包含 cust_order_no。這裡沿用 [2] 段算
  //    expectFail 時用的 RET.cust_order_no，否則驗簽當然過不了（而那會是測試自己
  //    的 bug，不是產線的）。
  const r = await getReturn(
    new URLSearchParams({
      ret: "FAIL",
      cust_order_no: RET.cust_order_no,
      order_amount: RET.order_amount,
      send_time: RET.send_time,
      notify_time: RET.notify_time,
      chk: expectFail,
      t: ORDER.public_token,
    }).toString(),
  );
  checkTrue(
    "失敗導回（驗簽通過）→ 帶 payment=failed 讓確認頁提示",
    (r.location ?? "").includes("payment=failed"),
  );
  check("而且仍然不標記任何付款狀態", STUB_STATE.failedCalls.length, 0);
}

resetState();
{
  const r = await getReturn(
    new URLSearchParams({
      ret: "FAIL",
      cust_order_no: ORDER.order_no,
      chk: "00000000000000000000000000000000",
      t: ORDER.public_token,
    }).toString(),
  );
  checkTrue(
    "🔴 chk 驗不過的失敗導回**不顯示失敗** —— 顯示假的失敗會讓已付款的客人跑去重刷一次",
    !(r.location ?? "").includes("payment=failed"),
  );
}

resetState();
{
  // 黑貓 PAY 後台那兩格「重新導向契客網址」是靜態設定，填不進每張訂單的 token。
  const r = await getReturn(new URLSearchParams({ ...RET, chk: expectSuccess }).toString());
  checkTrue(
    "沒有 ?t= 時用 cust_order_no 找回訂單（後台靜態設定過來的導回一定沒有 t）",
    (r.location ?? "").includes(`token=${ORDER.public_token}`),
  );
}

resetState({ order: null });
{
  const r = await getReturn("ret=OK&cust_order_no=IB-999999999999");
  check("查不到訂單 → 導回首頁，不外洩任何資訊", r.location, "https://selftest.example.invalid/");
}

// =============================================================================
// [9] payuni.ts 一個字都沒被改
// =============================================================================
console.log("\n[9] PayUni 那條路原封不動");

// ⚠️ 基準值在 2026-09-01 換過一次，原因與內容無關：那一期把整個 repo 套上
//    prettier（`npm run lint` 之前從來不綠，見 eslint.config.js 的說明），
//    payuni.ts 只有排版被動到 —— 行數 475 → 475，用 @babel/parser 比對過
//    改動前後的 AST 完全相同（剝掉位置資訊、JSX 空白依 React 語意正規化）。
//    舊值：b89388061672d281afdea2fdd84dc2dfb207995c71c3db8781727beece63d019
//    這條斷言的強度沒有變：它仍然是逐位元組的釘樁，之後任何一個字被動到都會紅。
check(
  "🔴 src/server/payuni.ts 的 SHA-256 與基準一致（這一期一個字都沒動它）",
  sha256File("src/server/payuni.ts"),
  "65c3d5f84bce1dae52578f67c5dd70b4fb0a35e4e407a18a1365cf5943c7dee8",
  "黑貓是另一套協定（MD5 + Bearer token），與 PayUni 直連 UPP（AES-256-GCM）沒有交集。要動 payuni.ts 之前先確認你不是在把兩件事混在一起。",
);
check(
  "🔴 scripts/payuni-selftest.mjs 的 SHA-256 與基準一致（49 個 case 原封不動）",
  sha256File("scripts/payuni-selftest.mjs"),
  "debd9aeccaae7c42450d9c12d43f33931e0760cb94baad8c3c2c87a6d9f4d6da",
);

// =============================================================================
// [10] 原始碼結構 —— 註解與順序也是驗收對象
// =============================================================================
console.log("\n[10] 原始碼結構不變量");

{
  // 🔴 這一條守的是「這支測試驗得到**產線那一份**」。判準不是「只准 import 一個
  //    模組」，而是「Node 的原生 type stripping 載得動」—— 也就是不可以出現 `@/`
  //    別名（vite 才解得開）或任何會把 server-only 拖進來的東西。
  //
  //    0034 把 localhost/https 那條判斷抽成 src/server/public-url.ts（同一條規則
  //    本來被抄了三份，見那個檔案的檔頭），blackcat.ts 因此多了第二個 import。
  //    這裡不是放寬——底下把清單釘成**逐字相等**，而且加驗了兩件新的事：
  //      · public-url.ts 用相對路徑 + `.ts` 副檔名（別名解不開，副檔名 Node 才吃）
  //      · public-url.ts 自己**一個 import 都沒有**（所以載得動是傳遞性成立的）
  //    最後再真的把 blackcat.ts 載進來跑一次（本檔開頭的 import 就是），
  //    那是這一整組斷言的反空殼：載不動的話這支測試根本跑不到這裡。
  const imports = [...BC_SRC.matchAll(/^import\s.*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  check("blackcat.ts 的 import 清單逐字相符", imports.join(","), "node:crypto,./public-url.ts");
  check(
    "🔴 blackcat.ts 不 import 任何 `@/` 別名（vite 才解得開，Node 載不動）",
    imports.some((i) => i.startsWith("@/")),
    false,
  );

  const PU_PATH = join(ROOT, "src/server/public-url.ts");
  const PU_SRC = readFile(PU_PATH);
  checkTrue("反空殼：public-url.ts 不是空檔", PU_SRC.length > 500);
  const puImports = [...PU_SRC.matchAll(/^import\s/gm)];
  check(
    "🔴 public-url.ts 一個 import 都沒有（blackcat.ts 的可載入性是傳遞性的）",
    puImports.length,
    0,
  );
  // 那條規則本身。抄第四份的人會在這裡被抓到。
  const pu = await import(pathToFileURL(PU_PATH).href);
  const savedSiteUrl = process.env.SITE_URL;
  for (const [value, expected, label] of [
    [undefined, null, "SITE_URL 沒設（就是那次事故的狀態）"],
    ["http://localhost:8080", null, "siteUrl() 的預設值 http://localhost:8080"],
    ["https://localhost", null, "https 但 localhost"],
    ["https://127.0.0.1", null, "https 但 loopback"],
    ["https://[::1]", null, "https 但 IPv6 loopback"],
    ["https://0.0.0.0", null, "https 但 0.0.0.0"],
    ["https://shop.local", null, "https 但 *.local（mDNS，外面解析不到）"],
    ["http://intervalbooks.tw", null, "正式網域但不是 https"],
    ["https://intervalbooks.tw", "https://intervalbooks.tw", "正式網域 + https"],
    ["https://intervalbooks.tw/", "https://intervalbooks.tw", "結尾斜線會被去掉"],
  ]) {
    if (value === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = value;
    check(`publicSiteUrl()：${label}`, pu.publicSiteUrl(), expected);
    // blackcatApnUrl() 必須與它一致 —— 這是「兩邊真的用同一份判斷」的證據，
    // 而不是「兩份長得很像」。
    process.env.BLACKCAT_WEBHOOK_SECRET = "selftest-secret";
    check(
      `blackcatApnUrl() 與 publicSiteUrl() 一致：${label}`,
      bc.blackcatApnUrl() === null,
      expected === null,
    );
  }
  delete process.env.BLACKCAT_WEBHOOK_SECRET;
  if (savedSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = savedSiteUrl;
}

{
  const iQuery = WH_SRC.indexOf("await queryAuthoritative(");
  const iClaim = WH_SRC.indexOf("await claimWebhookEvent(");
  const iPaid = WH_SRC.indexOf("await markOrderPaid(");
  checkTrue("webhook 有回查", iQuery > 0);
  checkTrue(
    "🔴 回查在 claim **之前** —— 未經認證的內容絕不可以先在 webhook_events 佔走 event_key",
    iQuery < iClaim,
  );
  checkTrue("🔴 claim 在標記付款之前", iClaim < iPaid);
}

checkTrue(
  "🔴 webhook 標記付款的判準只讀回查的 processCode，原始碼裡沒有 `body.status` 直接推導 authorized 的路徑",
  /const authorized =\s*processCode !== null && AUTHORIZED_PROCESS_CODES\.has\(processCode\);/.test(
    WH_SRC,
  ),
);

checkTrue(
  "🔴 apnPaidAmount 的回傳沒有被 ?? 接上任何 fallback（快樂手就是在這裡把檢查變成恆真的）",
  !/apnPaidAmount\([^)]*\)\s*\?\?/.test(WH_SRC),
);

checkTrue(
  "webhook 檔頭記著「規格 P48：統一金流授權失敗後不會轉址」——下一個人才不會把那條分支當死碼刪掉",
  WH_SRC.includes("統一金流授權失敗後不會") && WH_SRC.includes("P48"),
);

checkTrue("blackcat.ts 檔頭寫著「這不是身分驗證」", BC_SRC.includes("這不是身分驗證"));

{
  // ⚠️ 判準是「有沒有這個**宣告**」，不是「這個字串有沒有出現過」——
  //    blackcat.ts 的註解本來就寫著「函式名字刻意不叫 verifyApnSignature」。
  const declared =
    /(?:export\s+)?(?:async\s+)?function\s+verifyApnSignature\b|(?:export\s+)?const\s+verifyApnSignature\b/;
  checkTrue(
    "🔴 沒有任何一支**叫做** verifyApnSignature 的函式 —— 那個名字會讓人以為它做了它沒做的事",
    !declared.test(BC_SRC) && !declared.test(WH_SRC),
  );
  checkTrue(
    "而且原始碼裡明白寫下了「刻意不叫那個名字」的理由（命名決定要留得住）",
    BC_SRC.includes("刻意不叫 verifyApnSignature"),
  );
}

checkTrue(
  "blackcat.ts 檔尾寫了「第二條路（代收代付）之後怎麼加」",
  BC_SRC.includes("代收代付") && BC_SRC.includes("CvsOrderAppend"),
);

for (const [label, src] of [
  ["blackcat.ts", BC_SRC],
  ["blackcat-webhook.ts", WH_SRC],
]) {
  checkTrue(
    `${label} 沒有把整包金流回應丟進 log（回應含卡號後四碼與授權碼）`,
    !/console\.(log|error|warn|info)\([^)]*JSON\.stringify\(\s*(res|json|body|data|raw)/.test(src),
  );
}

{
  const mig = readFile(join(MIG_DIR, "0024_blackcat_payment.sql"));
  checkTrue(
    "0024 檔頭寫明前一支是 0023、既有 0001–0023 不動",
    mig.includes("0023") && mig.includes("0001–0023 一律不動"),
  );
  checkTrue("0024 有 payment_url 欄位", mig.includes("add column if not exists payment_url"));
  checkTrue(
    "0024 有 gateway_trans_id 欄位",
    mig.includes("add column if not exists gateway_trans_id"),
  );
  checkTrue(
    "0024 的 security definer 函式先 revoke 再 grant service_role",
    /revoke execute on function public\.payment_alerts[\s\S]*grant\s+execute on function public\.payment_alerts\(integer\) to service_role/.test(
      mig,
    ),
  );
  checkTrue(
    "0024 寫下了日後要改 payment_method CHECK 的確切 SQL",
    mig.includes("drop constraint orders_payment_method_check"),
  );
  const nums = readMigrationFiles(MIG_DIR);
  // 0025_event_speaker.sql（活動掛講者）與 0026_event_product_link.sql（活動與商品的
  // 真連結）是後來加的。兩支都只碰 public.events / products / event_sessions，
  // 沒有碰 orders / payments / webhook_events，所以這一支的其他斷言原樣成立。
  // 0027_event_blocks.sql（活動頁組裝器的資料層）同樣如此：它在 public.events 上加
  // 七個 jsonb 清單欄位、建 public.event_blocks、加一支 reorder RPC，並用
  // create or replace 讓 admin_upsert_event_with_session() 多吃那七欄。整支檔案裡
  // orders / payments / webhook_events 出現 0 次，金流那一半一個字都沒動。
  // ── 從這一期起，逐支點名搬到共用帳本 ───────────────────────────────────
  // 上面那幾段散文是 0025–0027 進來時逐條重讀的結論，保留下來當紀錄。但新的
  // migration 不要再往上面加一段散文 —— 註解沒有任何東西在驗。改成到
  // scripts/lib/migration-ledger.mjs 的 MIGRATION_LEDGER 補一列。
  assertLedgerMatchesDisk(check, MIG_DIR);
  assertLedgerDeclarationsHonest(check, MIG_DIR);
  // 🔴 這一條原本是 `check("migration 編號連續且 0027 是最後一支",
  //    nums[nums.length - 1], "0027_event_blocks.sql")`。標籤撒了半個謊：
  //    「0027 是最後一支」是真的，「編號連續」則從來沒被檢查過 —— 有人插一支
  //    0027a 或跳號到 0029，這條照樣是綠的，而輸出印著「✓ migration 編號連續」。
  //
  //    兩半都換掉了，而且是往上換：
  //    · 「編號連續」→ 上面的 assertLedgerMatchesDisk() 真的在檢查（它比對完整的
  //      有序清單，抓得到插隊、跳號、重號、改名）。
  //    · 「0027 是最後一支」→ **這一條在這裡是多餘的第二份**。「最新的一支是誰」
  //      這個快照本來就該由**最新那一期**的自檢守著，每開一支新 migration 就換一
  //      個地方更新（見 event-product-selftest [1] 的註解，現在是
  //      event-blocks-selftest [1]）。放一份在金流自檢裡，只是讓每一支跟金流無關
  //      的 migration 都要來這裡改一次數字 —— 那正是這一期在拆的機械性重複。
  //
  //    換成這一支**自己**真正在乎的那條：0024 沒有被改號或插隊。它跟上面那堆
  //    「0024 的 SQL 長什麼樣」的斷言是同一個主題，而且不會隨著別人開新 migration
  //    而失效。
  check("0024 仍在第 24 個位置（沒有被改號或插隊）", nums[23], "0024_blackcat_payment.sql");
  // 這支自檢的金流那一半（orders / payments / webhook_events / SHA 釘樁）只在乎
  // orders_payments 這一個區域。帳本裡只要出現一支排在 reviewedThrough 之後、
  // 又動到它的 migration，這條就轉紅並指名是哪一支。
  assertMigrationDependencies(check, MIG_DIR, {
    suite: "blackcat-selftest",
    dependsOn: ["orders_payments"],
    // ── 0028_free_order_settlement.sql 的重讀結論 ─────────────────────────────
    // 0028 讓 total = 0 的訂單在結帳當下就結清（settle_free_order()：status='processing'
    // / payment_status='paid' / payment_method='free' / paid_at=now()），並給
    // invoice_backlog() 加上 total > 0。它**沒有**重寫 expire_unpaid_orders()，也沒有
    // ALTER 任何一張表 —— 唯一的 DDL 是 orders_payment_method_check 的 drop + add
    // （多一個允許值 'free'，既有四個原樣保留；那正是 0024 檔頭寫下的規定做法）。
    // 逐條重讀之後：這一支的斷言都在 0024 的檔案內容、payuni/blackcat 的簽章與 APN 流程上，沒有任何一條窮舉 payment_method 的允許值（1198 那條驗的是 0024 **寫下了**改法，不是目前有哪些值），也沒有一條碰 invoice_backlog。原樣成立。
    // ── 0029_event_seats_visibility.sql：不必重讀 ─────────────────────────────
    // 0029 在帳本上標的是 products_availability / session_seats / events_shape /
    // localized_list —— 沒有 orders_payments，所以這條從來沒有為它轉紅。跳過它是
    // 機制本身允許的（localized-list-selftest 對 0028 也是同一個情況，它的註解寫了
    // 同一件事）：reviewedThrough 記的是「審到哪裡」，中間沒動到我在乎的區域的那幾支
    // 本來就不需要我回來看。
    // ── 0030_customer_accounts.sql 的重讀結論 ────────────────────────────────
    // 0030 加客人帳號的資料層：一支新函式 claim_guest_orders(uuid)（security definer、
    // 只 grant execute 給 service_role），把 customer_email 對得上、而且 user_id 仍是
    // null 的訪客訂單指給註冊並驗證過信箱的帳號；外加一支 partial index。
    // **沒有 ALTER 任何一張表、沒有 create or replace 任何既有函式、沒有動任何 CHECK／
    // trigger／排程，也沒有開任何 RLS policy 或對 anon / authenticated 的 grant**
    // （0005:318-336 的姿態原樣保留）。它唯一寫到的欄位是 public.orders.user_id ——
    // 那一欄 0005:65 就存在，而且到 0029 為止沒有任何程式碼讀或寫過它。
    // 逐條重讀之後：付款狀態機（status / payment_status / payment_method / paid_at /
    // payment_url / gateway_trans_id）與 payment_alerts()、webhook_events 這一支全部
    // 的斷言對象，0030 一個字都沒提到。user_id 不出現在這支自檢的任何一條斷言裡。
    // 「0024 仍在第 24 個位置」也不受影響（0030 是往後接的第 30 支）。原樣成立。
    // ── 0031_event_gallery.sql：不必重讀 ─────────────────────────────────────
    // 0031 在帳本上標的是 events_shape / localized_list / products_availability /
    // session_seats —— 沒有 orders_payments，所以這條從來沒有為它轉紅。它加的是
    // events.gallery_keys 與放寬 external_url 驗證，跟金流無關。
    // ── 0032_admin_order_notify.sql 的重讀結論 ───────────────────────────────
    // 0032 加店家的新訂單／新報名通知：site_settings.notify_emails ＋
    // enqueue_admin_order_email()，把摘要信排進既有的 email_outbox。它的 SQL 本體
    // 裡沒有任何一行碰 orders / payments / webhook_events / payment_alerts /
    // order_post_payment_log（這五個是 orders_payments 這一區的識別字）——0032 的
    // `enqueue_admin_order_email()` 只查 site_settings，一行 `from public.orders`
    // 都沒有。帳本上標了 orders_payments，是因為**呼叫端**（notify.ts 用來組信件
    // 摘要的 getOrderForNotify()，src/server/repos/email-outbox.ts）多讀了
    // public.orders 的 payment_method / shipping_method 兩欄——這兩欄不是 0032
    // 新開的：payment_method 是 0005:88 就存在、0028 只多加了一個允許值 'free'
    // 進它的 CHECK；shipping_method 是 0005:86～87 就存在，CHECK 允許值
    // ('home','cvs','pickup','none') 0032 一個字都沒動。
    // 逐條重讀之後：這一支的斷言都在 0024 的檔案內容、payuni/blackcat 的簽章與
    // APN 流程、payment_alerts()、webhook_events、orders_payment_method_check 上，
    // 0032 沒有 ALTER 這張表、沒有 create or replace 任何既有函式、沒有動任何
    // CHECK／trigger／排程，也沒有改 orders / payments 對任何角色的 grant（0032
    // 唯一動到的 grant 是 site_settings 那一張表，跟這支自檢的斷言對象是兩張不同
    // 的表）。「0024 仍在第 24 個位置」不受影響（0032 是往後接的第 32 支）。原樣成立。
    // ── 0034_transfer_payment.sql 的重讀結論 ─────────────────────────────────
    // 0034 加匯款（'transfer'）付款方式。它在帳本上標了 orders_payments，所以這條
    // 為它轉紅。逐條對過：
    //   · 這支自檢的斷言集中在 0024 的檔案內容、payuni/blackcat 的簽章與 APN 流程。
    //     0034 **完全沒有碰** src/server/blackcat.ts、blackcat-webhook.ts、payuni.ts、
    //     payuni-webhook.ts、markOrderPaid() 任何一個字。
    //   · orders_payment_method_check 多一個 'transfer'（drop + add，同一交易，
    //     既有六個值原樣保留）——正是 0024 檔頭寫下的規定做法，而 1198 那條驗的是
    //     0024 **寫下了**改法，不是目前有哪些值。
    //   · 真正與這支自檢相交的是 fetchPaymentOptions() 與結帳頁的付款選項：0034 讓
    //     它多回一個 transferAvailable，並把結帳頁的兩個選項變成三個。上面那幾條
    //     斷言因此改寫成對新形狀比對**同一件事**（fail-closed、只回布林、card 掛在
    //     cardAvailable 上、預設退回不含 card 的第一個選項），並新增兩條更強的：
    //     送出前的白名單改用 methodOptions，以及「舊的 cardAvailable 三元式沒有殘留」
    //     ——那個舊寫法在三個選項的世界裡會把選了匯款的客人靜靜改成 offline。
    // 原樣成立。
    // ── 0035_admin_order_registration_cleanup.sql 的重讀結論 ─────────────────
    // 0035 是後台訂單刪除／封存＋名單刪除單筆。它在帳本上標了 orders_payments
    // （新增 orders.archived_at 一個 nullable 欄位、admin_delete_order() /
    // admin_archive_order() 兩支新函式都收 p_order_id 查 public.orders），所以這條
    // 為它轉紅。逐條對過：
    //   · 一樣**完全沒有碰** src/server/blackcat.ts、blackcat-webhook.ts、
    //     payuni.ts、payuni-webhook.ts、markOrderPaid() 任何一個字，也沒有動
    //     orders_payment_method_check（payment_method 的允許值域一個字都沒改）。
    //   · admin_delete_order() 會擋已付款訂單（payment_status = 'paid' →
    //     order_is_paid），只對未付款／已取消的訂單生效，而這支自檢的斷言全部圍繞
    //     著「刷卡訂單怎麼走到 paid」這條路徑——被 0035 擋下來的訂單本來就不會是
    //     這支自檢建的那些已付款測試資料。
    //   · fetchPaymentOptions() 與結帳頁的三個付款選項（card／transfer／offline）
    //     0035 一個字都沒動，只在後台訂單頁加了刪除／封存兩顆按鈕，不影響結帳頁。
    // 原樣成立。
    // 0040_referral_program.sql（推薦碼與分潤）對 orders 只做了三件事：加三個 nullable
    // 欄位 referrer_id／referral_code／referral_discount_percent（舊訂單全是 NULL）、
    // 一個部分索引、一個指向新表 referrers 的 FK（on delete restrict，限制的是刪推廣者，
    // 不是刪訂單）。既有欄位、CHECK、函式、policy、grant 一個字都沒改。唯一的語意變化
    // 是 orders.discount 從恆為 0 變成「推薦折扣」（只對選品／書籍、最多 50%），而
    // total = subtotal + shipping_fee − discount 仍是金流、信件、發票唯一使用的金額
    // （發票本來就把 discount 開成負數列）。這支自檢的斷言重讀過，原樣成立。
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
}

{
  // 「缺憑證 → 結帳頁不顯示刷卡」的完整接線：blackcatConfigured() 只是第一段，
  // 要真的走到 UI 還得經過 fetchPaymentOptions → cardAvailable → 那個 radio。
  // 上面 [7] 驗了第一段，這裡驗剩下的兩段接得上。
  const fnsSrc = readFile(join(ROOT, "src/lib/checkout-fns.ts"));
  checkTrue(
    "fetchPaymentOptions 的 cardAvailable 由 blackcatConfigured() 決定（黑貓沒設就不是 true）",
    /cardAvailable:\s*blackcatConfigured\(\)\s*\|\|\s*payuniConfigured\(\)/.test(fnsSrc),
  );
  checkTrue(
    "🔴 fetchPaymentOptions 出錯時回 false（fail-closed：寧可不顯示，也不要顯示一個會壞的選項）",
    /catch[\s\S]{0,300}return \{[\s\S]{0,200}cardAvailable: false/.test(fnsSrc),
  );
  checkTrue(
    "cardAvailable 只是一個布林 —— 瀏覽器永遠拿不到任何憑證的形狀",
    /Promise<\{ cardAvailable: boolean; transferAvailable: boolean \}>/.test(fnsSrc),
  );
  // 反面對照：回傳型別裡不可以出現任何「憑證形狀」的欄位名。上面那條是正面
  // 比對一個寫死的字串，改一個字就轉紅；這一條擋的是「多回了一個欄位」。
  check(
    "fetchPaymentOptions 的回傳裡沒有任何憑證欄位",
    /Promise<\{[^}]*(merchant|MerID|key|Key|secret|hash)[^}]*\}>/.test(fnsSrc),
    false,
  );
  const checkoutSrc = readFile(join(ROOT, "src/routes/checkout.index.tsx"));
  // 0034 把兩個選項變成三個，所以「刷卡選項出不出現」不再是一個 `{cardAvailable ?`
  // 三元式，而是 card 進不進得了 methodOptions 這份清單。守的事情沒變。
  checkTrue(
    "結帳頁的刷卡選項掛在 cardAvailable 上（false 就不進 methodOptions）",
    /cardAvailable \? \(\["card"\] as const\) : \[\]/.test(checkoutSrc),
  );
  checkTrue(
    "offline 永遠在 methodOptions 裡（不需要任何設定的那條退路）",
    /"offline" as const,/.test(checkoutSrc),
  );
  checkTrue(
    "cardAvailable 為 false 時預設付款方式退回清單的第一個（card 不在裡面）",
    /useState<PaymentMethodChoice>\(methodOptions\[0\]\)/.test(checkoutSrc),
  );
  // 🔴 0034 新增：送出前的白名單。這一條比它取代的那一條強 —— 舊的
  //    `cardAvailable ? payWith : "offline"` 在三個選項的世界裡會把一個選了匯款的
  //    客人靜靜改寫成 offline（訂單 payment_method = NULL、匯款信不寄、完成頁不顯示
  //    帳號），而畫面上沒有任何地方看得出來。
  checkTrue(
    "🔴 送出前的白名單是「這個方式有沒有提供」，不是「card 有沒有開」",
    /paymentMethod: methodOptions\.includes\(payWith\) \? payWith : "offline"/.test(checkoutSrc),
  );
  check(
    "🔴 舊的 cardAvailable 三元式 fallback 沒有殘留（它會吃掉匯款的選擇）",
    /paymentMethod: cardAvailable \? payWith/.test(checkoutSrc),
    false,
  );

  const ordersSrc = readFile(join(ROOT, "src/server/repos/orders.ts"));
  checkTrue(
    "orders.ts step 7 走的是 buildCardHandoff（唯一入口）",
    ordersSrc.includes("await buildCardHandoff(order) : null;"),
  );
  checkTrue(
    "buildCardHandoff 黑貓優先",
    /buildCardHandoff[\s\S]{0,400}buildBlackcatHandoff[\s\S]{0,200}buildPayuniHandoff/.test(
      ordersSrc,
    ),
  );
  checkTrue(
    "三個呼叫端都改成 buildCardHandoff（沒有殘留的直呼 buildPayuniHandoff）",
    (ordersSrc.match(/await buildPayuniHandoff\(/g) ?? []).length === 1,
  );
  const serverSrc = readFile(join(ROOT, "src/server.ts"));
  checkTrue("src/server.ts 掛了 APN 路徑", serverSrc.includes("BLACKCAT_APN_PATH"));
  checkTrue("src/server.ts 掛了導回路徑", serverSrc.includes("BLACKCAT_RETURN_PATH"));
}

// =============================================================================
// [11] 併發段 —— 對真的 PostgreSQL 驗去重與狀態轉移
// =============================================================================
const PG_URL = process.env.BLACKCAT_SELFTEST_PG_URL;

function looksLikeSingleSelect(sql) {
  const t = sql.trim();
  if (!/^select\b/i.test(t)) return false;
  return t.replace(/;\s*$/, "").indexOf(";") === -1;
}

/** 送一句 SQL，一次一條**獨立連線**。**不 throw** —— 併發測試需要知道誰失敗了。 */
async function q(sql) {
  const single = looksLikeSingleSelect(sql);
  const text = single
    ? `select coalesce(json_agg(t), '[]'::json)::text from (\n${sql.trim().replace(/;\s*$/, "")}\n) t`
    : sql;
  try {
    const { stdout } = await execFileAsync(
      "psql",
      ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", PG_URL, "-c", text],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    if (!single) return { ok: true, error: null, rows: [] };
    return { ok: true, error: null, rows: JSON.parse(stdout.trim() || "[]") };
  } catch (err) {
    return { ok: false, error: String(err.stderr ?? err.message ?? err), rows: [] };
  }
}
/**
 * 送一句**不包裝**的 SQL，回傳 psql 的原始輸出（-t -A 之下就是一個純量）。
 *
 * ⚠️ 為什麼 CAS 不能走 q()：q() 會把單句 select 包成
 *    `select json_agg(t) from ( <你的 SQL> ) t`，而 PostgreSQL 規定
 *    **WITH 裡的資料修改語句只能掛在最上層的語句上**，包進子查詢就是語法錯誤。
 *    CAS 一定要是 `with u as (update … returning …) select count(*) from u`
 *    才能在**同一個交易**裡知道自己有沒有搶到那一列 —— 拆成兩句就不是 CAS 了。
 */
async function qScalar(sql) {
  try {
    const { stdout } = await execFileAsync(
      "psql",
      ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", PG_URL, "-c", sql],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return { ok: true, error: null, value: stdout.trim() };
  } catch (err) {
    return { ok: false, error: String(err.stderr ?? err.message ?? err), value: null };
  }
}

async function must(sql) {
  const r = await q(sql);
  if (!r.ok)
    throw new Error(`SQL 失敗：${r.error.slice(0, 400)}\n--- SQL ---\n${sql.slice(0, 600)}`);
  return r.rows;
}
const one = (rows) => (Array.isArray(rows) && rows.length > 0 ? rows[0] : null);
const num = (rows, field = "n") => Number(one(rows)?.[field] ?? NaN);

const KEY_PREFIX = "blackcatselftest-";
const EVENT_PREFIX = "blackcatselftest:";
const CLEANUP_SQL = `
delete from public.webhook_events where event_key like '${EVENT_PREFIX}%';
delete from public.payments where order_id in (select id from public.orders where idempotency_key like '${KEY_PREFIX}%');
delete from public.order_post_payment_log where order_id in (select id from public.orders where idempotency_key like '${KEY_PREFIX}%');
delete from public.orders where idempotency_key like '${KEY_PREFIX}%';
`;

if (!PG_URL) {
  skipped.push("併發測試（缺 BLACKCAT_SELFTEST_PG_URL）");
  console.log(yellow("\n[11] 併發測試 —— 跳過：沒有 BLACKCAT_SELFTEST_PG_URL"));
  console.log(yellow("     設好之後重跑，才會驗到 APN 重送 20 次的去重、狀態轉移的 CAS、"));
  console.log(yellow("     claim 歸還之後可重新 claim，以及 0024 的冪等。指令見本檔檔頭。"));
} else {
  console.log("\n[11] 併發測試 —— 對本機 PostgreSQL");
  try {
    if (process.env.BLACKCAT_SELFTEST_APPLY === "1") {
      console.log("  套用 0001–0024（BLACKCAT_SELFTEST_APPLY=1）");
      await must(`
        create extension if not exists pgcrypto;
        do $$ begin
          if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
          if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
          if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
        end $$;
        create schema if not exists auth;
        create table if not exists auth.users (
          id uuid primary key default gen_random_uuid(), email text,
          raw_user_meta_data jsonb, created_at timestamptz not null default now());
        create schema if not exists storage;
        create table if not exists storage.buckets (
          id text primary key, name text, public boolean default false,
          file_size_limit bigint, allowed_mime_types text[], owner uuid,
          created_at timestamptz default now());
        create table if not exists storage.objects (
          id uuid primary key default gen_random_uuid(), bucket_id text, name text,
          owner uuid, metadata jsonb, created_at timestamptz default now());
        alter table storage.objects enable row level security;
        grant usage on schema public to anon, authenticated, service_role;
      `);
      for (const f of readdirSync(MIG_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        // 0008 要 pg_net + vault + pg_cron，本機沒有。跳過它不影響這一期要驗的東西。
        if (f.startsWith("0008_")) continue;
        const r = await q(readFile(join(MIG_DIR, f)));
        if (!r.ok) throw new Error(`套用 ${f} 失敗：${r.error.slice(0, 600)}`);
      }
      checkTrue("0001–0024 套用完成（0008 跳過）", true);
    }

    // 開頭先清一次：上一次若在中途中止，最後的清理不會跑到，殘留的
    // (gateway, gateway_tx_id) 會讓這一次的 insert 撞唯一鍵。
    await must(CLEANUP_SQL);
    await must(`delete from public.payments where gateway_tx_id='BLACKCAT-SELFTEST-1'`);

    // 0024 冪等：再套一次不可以報錯。
    const again = await q(readFile(join(MIG_DIR, "0024_blackcat_payment.sql")));
    checkTrue("0024 可以重複套用（冪等）", again.ok, again.ok ? "" : again.error.slice(0, 300));

    check(
      "payment_alerts 不給 anon 執行",
      String(
        one(
          await must(
            "select has_function_privilege('anon','public.payment_alerts(integer)','execute') ok",
          ),
        )?.ok,
      ),
      "false",
    );
    check(
      "payment_alerts 不給 authenticated 執行",
      String(
        one(
          await must(
            "select has_function_privilege('authenticated','public.payment_alerts(integer)','execute') ok",
          ),
        )?.ok,
      ),
      "false",
    );
    check(
      "payment_alerts 給 service_role 執行",
      String(
        one(
          await must(
            "select has_function_privilege('service_role','public.payment_alerts(integer)','execute') ok",
          ),
        )?.ok,
      ),
      "true",
    );

    // ---- 一張真的待付款訂單 ------------------------------------------------
    const OID = "aaaa0000-0000-4000-8000-0000000000b1";
    await must(`
      insert into public.orders (id, customer_name, customer_email, customer_phone,
                                 subtotal, total, idempotency_key, payment_method)
      values ('${OID}','自檢客人','blackcat-selftest@example.invalid','0900000000',
              500, 500, '${KEY_PREFIX}order1', 'card');
      insert into public.payments (order_id, gateway, gateway_tx_id, status, amount)
      values ('${OID}', 'blackcat', 'BLACKCAT-SELFTEST-1', 'pending', 500);
    `);

    // ---- 同一則 APN 重送 20 次 ---------------------------------------------
    // 每一次 q() 是一個獨立的 psql 子行程 = 獨立連線 = 獨立交易，
    // 所以 Promise.all 出來的是真正的併發，不是排隊。
    const EVENT_KEY = `${EVENT_PREFIX}IB-1:trans-0001:B`;
    const inserts = await Promise.all(
      Array.from({ length: 20 }, () =>
        q(`insert into public.webhook_events (gateway, event_key, payload)
           values ('blackcat', '${EVENT_KEY}', '{"apn":"selftest"}'::jsonb)`),
      ),
    );
    const won = inserts.filter((r) => r.ok).length;
    check("🔴 同一則 APN 併發重送 20 次，只有 1 次搶到 insert", won, 1);
    check(
      "🔴 webhook_events 裡**恰好 1 列**",
      num(
        await must(
          `select count(*)::int n from public.webhook_events where event_key = '${EVENT_KEY}'`,
        ),
      ),
      1,
    );
    checkTrue(
      "其餘 19 次全部撞唯一鍵（unique_violation 23505），不是別的錯",
      inserts.filter((r) => !r.ok).every((r) => /duplicate key|23505/i.test(r.error)),
    );

    // ---- 同一個 event_key 在另一個 gateway 底下不衝突 ----------------------
    const other = await q(`insert into public.webhook_events (gateway, event_key, payload)
                           values ('payuni', '${EVENT_KEY}', '{}'::jsonb)`);
    checkTrue("同一個 event_key 在 payuni 底下可以另外存在（鍵是 (gateway, event_key)）", other.ok);

    // ---- claim 歸還之後可以重新 claim --------------------------------------
    await must(
      `delete from public.webhook_events where gateway='blackcat' and event_key = '${EVENT_KEY}'`,
    );
    const reclaim = await q(`insert into public.webhook_events (gateway, event_key, payload)
                             values ('blackcat', '${EVENT_KEY}', '{"retry":true}'::jsonb)`);
    checkTrue(
      "🔴 releaseWebhookClaim 之後，同一則通知可以重新 claim（否則 transient 失敗 = 永久掉單）",
      reclaim.ok,
    );

    // ---- 狀態轉移：20 次併發 CAS，只有一次命中 ------------------------------
    const updates = await Promise.all(
      Array.from({ length: 20 }, () =>
        qScalar(`with u as (
             update public.orders set payment_status='paid', status='processing',
                    payment_method='card', paid_at=now()
              where id='${OID}' and status='pending' and payment_status='pending'
              returning id) select count(*)::int from u`),
      ),
    );
    const hits = updates.filter((r) => r.ok && Number(r.value) === 1).length;
    checkTrue(
      "（前提）20 條連線全部都順利跑完，沒有一條是因為錯誤才「沒改到」",
      updates.every((r) => r.ok),
    );
    check("🔴 20 次併發的 compare-and-swap 只有 1 次真的改到列 —— 訂單只被標記一次", hits, 1);

    const fresh = one(
      await must(
        `select payment_status, status, (paid_at is not null) paid from public.orders where id='${OID}'`,
      ),
    );
    check("訂單最終是 paid", fresh?.payment_status, "paid");
    check("訂單狀態推進到 processing", fresh?.status, "processing");
    check("paid_at 有值", String(fresh?.paid), "true");

    // ---- 遲到的失敗通知不可以覆蓋已付款 -------------------------------------
    const late = await qScalar(`with u as (
        update public.orders set payment_status='failed'
         where id='${OID}' and status='pending' and payment_status='pending'
         returning id) select count(*)::int from u`);
    check("🔴 遲到的失敗通知打不到已付款的訂單（CAS 未命中）", Number(late.value), 0);
    check(
      "訂單仍然是 paid",
      one(await must(`select payment_status ps from public.orders where id='${OID}'`))?.ps,
      "paid",
    );

    // ---- 0024 的新欄位真的可以寫 -------------------------------------------
    await must(`update public.orders set payment_url='https://example.invalid/pay/abc' where id='${OID}';
                update public.payments set gateway_trans_id='trans-0001' where gateway='blackcat' and gateway_tx_id='BLACKCAT-SELFTEST-1';`);
    check(
      "orders.payment_url 可寫（0024 §1）",
      one(await must(`select payment_url u from public.orders where id='${OID}'`))?.u,
      "https://example.invalid/pay/abc",
    );
    // ⚠️ 欄位別名不可以叫 t —— q() 會把單句 select 包成 `select json_agg(t) from (…) t`，
    //    內層有同名欄位時 json_agg(t) 會取到那個欄位而不是整列，而且**不會報錯**。
    check(
      "payments.gateway_trans_id 可寫（0024 §2）",
      one(
        await must(
          `select gateway_trans_id gtid from public.payments where gateway='blackcat' and gateway_tx_id='BLACKCAT-SELFTEST-1'`,
        ),
      )?.gtid,
      "trans-0001",
    );

    // ---- payment_alerts 撈得到被拒絕的事件 ----------------------------------
    await must(`insert into public.webhook_events (gateway, event_key, payload) values
      ('blackcat','${EVENT_PREFIX}refused1','{"refused":"amount_mismatch","collected":1,"expected":500,"apn":{"order_no":"IB-1"}}'::jsonb)`);
    const alerts = await must(
      `select refused, order_no, collected, expected from public.payment_alerts(30) where order_no='IB-1'`,
    );
    check("payment_alerts 撈得到 amount_mismatch", one(alerts)?.refused, "amount_mismatch");
    check("而且撈得出訂單編號", one(alerts)?.order_no, "IB-1");
    check("以及實收金額", Number(one(alerts)?.collected), 1);

    await must(CLEANUP_SQL);
    await must(`delete from public.payments where gateway_tx_id='BLACKCAT-SELFTEST-1'`);
  } catch (err) {
    fail++;
    console.log(red(`  ✗ 併發段中止：${String(err.message ?? err).slice(0, 500)}`));
  }
}

// =============================================================================
// 收尾
// =============================================================================
console.log("\n══════════════════════════════════════════════════════");
if (skipped.length > 0) {
  console.log(yellow(`跳過：${skipped.join("、")}`));
}
console.log(`${pass + fail} cases：${pass} passed, ${fail} failed`);
console.log(fail === 0 ? green("✓ 全部通過") : red("✗ 有失敗"));
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
