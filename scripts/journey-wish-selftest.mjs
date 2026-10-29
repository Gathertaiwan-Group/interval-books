#!/usr/bin/env node
/**
 * journey-wish-selftest.mjs —— 策旅願望表單（/events/kungtung「下次，我想這樣玩」）的自檢
 *
 *   [1] 欄位驗證（src/lib/journey-wish.ts 的 wishSchema，前後台同一份）
 *   [2] 通知信：主旨清理、HTML 跳脫、沒有可點的連結
 *   [3] token：願望表單與異業合作表單的 token 不能互用
 *   [4] migration 0046 與應用層一致、權限
 *   [5] 接線（靜態）：server 流程、admin fns、側欄、著陸頁不再 mailto／不印匯款帳號
 *   [6] 收件匣純邏輯
 *
 * 執行：node scripts/journey-wish-selftest.mjs（或 npm test）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  WISH_LIMITS,
  WISH_SOURCES,
  WISH_SOURCE_KEYS,
  isWishSource,
  wishSchema,
  wishSourceLabel,
} from "../src/lib/journey-wish.ts";
import { renderWishEmail, wishSubject } from "../src/lib/journey-wish-email.ts";
import { checkFormToken, issueFormToken } from "../src/server/partnership-guard.ts";
import * as inbox from "../src/lib/journey-wish-inbox.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/journey-wish-selftest.mjs";
let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    fail += 1;
    console.log(
      `  \x1b[31m✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}\x1b[0m`,
    );
  }
}
const checkTrue = (label, v) => check(label, Boolean(v), true);
function read(rel) {
  // 讀不到就丟例外（run-selftests 守門 4：不准靜默回空字串）。
  return readFileSync(join(ROOT, rel), "utf8");
}
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const base = {
  source: "kungtung",
  interests: [],
  wish: "",
  name: "",
  email: "",
  joinFriends: false,
  notifyOptIn: false,
};
const parse = (patch) => wishSchema.safeParse({ ...base, ...patch });
const codes = (r) => (r.success ? [] : r.error.issues.map((i) => i.message));

// =============================================================================
console.log("\n[1] 欄位驗證");
// =============================================================================
check("全空 → empty", codes(parse({})), ["empty"]);
check("只選一項 → 通過", parse({ interests: ["山海風土美食"] }).success, true);
check("只寫願望 → 通過", parse({ wish: "想去有老建築的小鎮" }).success, true);
check("願望只有空白 → empty", codes(parse({ wish: "   \n  " })), ["empty"]);
check("白名單以外的選項 → interests", codes(parse({ interests: ["<script>"], wish: "x" })), [
  "interests",
]);
check(
  "選項去重、照頁面順序排",
  parse({ interests: ["一個人的自在旅行", "秘境建築與文化", "秘境建築與文化"] }).data?.interests,
  ["秘境建築與文化", "一個人的自在旅行"],
);
check(
  "不認得的 source → source",
  codes(parse({ source: "nope", wish: "x" })).includes("source"),
  true,
);
check("信箱有填但格式錯 → email", codes(parse({ wish: "x", email: "not-an-email" })), ["email"]);
check("信箱空白 → 通過（選填）", parse({ wish: "x", email: "  " }).success, true);
check("願望超過上限 → tooLong", codes(parse({ wish: "字".repeat(WISH_LIMITS.wish + 1) })), [
  "tooLong",
]);
check("願望剛好上限 → 通過", parse({ wish: "字".repeat(WISH_LIMITS.wish) }).success, true);
check(
  "稱呼的換行／控制字元被清掉",
  parse({ wish: "x", name: "王\r\n小明\u0007" }).data?.name,
  "王 小明",
);
check("勾選必須是 boolean", parse({ wish: "x", joinFriends: "true" }).success, false);
check(
  "interests 超過 20 項 → 擋",
  parse({ interests: Array(21).fill("秘境建築與文化") }).success,
  false,
);
check(
  "WISH_SOURCES 的 key 都是小寫英數與 -（對得上 0046 的 CHECK）",
  WISH_SOURCE_KEYS.every((k) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(k)),
  true,
);
check("isWishSource 不吃原型鏈上的 key", isWishSource("toString"), false);
check("kungtung 有 8 個選項", WISH_SOURCES.kungtung.interests.length, 8);

// =============================================================================
console.log("\n[2] 通知信");
// =============================================================================
{
  const v = parse({
    interests: ["攝影與藝術旅行"],
    wish: '<a href="https://evil.example">點我</a>',
    name: "王\r\nBcc: x@y.z",
    email: "guest@example.com",
    joinFriends: true,
  }).data;
  const mail = renderWishEmail(v, {
    submittedAt: "2026-10-29T08:00:00.000Z",
    pageUrl: "https://www.intervalbooks.tw/events/kungtung",
  });
  check("主旨沒有 CR/LF", /[\r\n]/.test(mail.subject), false);
  checkTrue(
    "主旨以【旅程願望】開頭、帶頁面名稱",
    mail.subject.startsWith("【旅程願望】范毅舜公東教堂文化之旅"),
  );
  check("HTML 沒有可點的 <a", /<a\s/i.test(mail.html), false);
  checkTrue("HTML 跳脫了願望內容", mail.html.includes("&lt;a href="));
  checkTrue("台北時間", mail.text.includes("2026/10/29 16:00"));
  checkTrue("勾選照實印出", mail.text.includes("免費加入小時光知友：是"));
  check(
    "沒填稱呼 → 主旨只有頁面名稱",
    wishSubject({ source: "kungtung", name: "" }),
    "【旅程願望】范毅舜公東教堂文化之旅",
  );
}

// =============================================================================
console.log("\n[3] token 用途分開");
// =============================================================================
{
  const SECRET = "selftest-secret-0123456789";
  const t0 = 1_800_000_000_000;
  const wishTok = issueFormToken(SECRET, t0, "ib-journey-wish-form-v1");
  check(
    "願望 token 拿去願望表單驗 → ok",
    checkFormToken(wishTok, SECRET, t0 + 10_000, "ib-journey-wish-form-v1"),
    "ok",
  );
  check(
    "願望 token 拿去異業合作（預設用途）→ invalid",
    checkFormToken(wishTok, SECRET, t0 + 10_000),
    "invalid",
  );
  const pTok = issueFormToken(SECRET, t0);
  check(
    "異業合作 token 拿去願望表單 → invalid",
    checkFormToken(pTok, SECRET, t0 + 10_000, "ib-journey-wish-form-v1"),
    "invalid",
  );
  check(
    "願望 token 不到 3 秒 → too_fast",
    checkFormToken(wishTok, SECRET, t0 + 1_000, "ib-journey-wish-form-v1"),
    "too_fast",
  );
  const server = read("src/server/journey-wish.ts");
  checkTrue(
    "server 用自己的用途標籤",
    server.includes('WISH_TOKEN_PURPOSE = "ib-journey-wish-form-v1"'),
  );
  checkTrue(
    "server 驗 token 時帶用途標籤",
    server.includes(
      "checkFormToken(input.token, adminSessionSecret(), Date.now(), WISH_TOKEN_PURPOSE)",
    ),
  );
}

// =============================================================================
console.log("\n[4] migration 0046");
// =============================================================================
{
  const mig = stripComments(
    read("supabase/migrations/0046_journey_wishes.sql").replace(/^--.*$/gm, ""),
  );
  checkTrue(
    "建表 journey_wishes",
    mig.includes("create table if not exists public.journey_wishes"),
  );
  for (const [col, max] of [
    ["wish", WISH_LIMITS.wish],
    ["name", WISH_LIMITS.name],
    ["email", WISH_LIMITS.email],
  ]) {
    checkTrue(
      `${col} 長度上限 = WISH_LIMITS（${max}）`,
      mig.includes(`char_length(${col}) <= ${max}`),
    );
  }
  checkTrue(
    "interests 上限 = WISH_LIMITS",
    mig.includes(`cardinality(interests) <= ${WISH_LIMITS.interests}`),
  );
  checkTrue(
    "至少一項 interests 或 wish",
    mig.includes("cardinality(interests) > 0 or char_length(wish) > 0"),
  );
  const statusList = (mig.match(/status in \(([^)]*)\)/) ?? [])[1] ?? "";
  check(
    "status CHECK 與 WISH_STATUSES 一致",
    [...statusList.matchAll(/'([^']+)'/g)].map((m) => m[1]),
    [...inbox.WISH_STATUSES],
  );
  checkTrue("RLS 開", mig.includes("alter table public.journey_wishes enable row level security"));
  checkTrue(
    "anon/authenticated 全收回",
    mig.includes("revoke all on table public.journey_wishes from anon, authenticated"),
  );
  check("沒有任何 policy", /create policy/i.test(mig), false);
  check(
    "uuid 主鍵、沒有 identity/serial（沒有 sequence 要收權限）",
    /identity|serial/i.test(mig),
    false,
  );
}

// =============================================================================
console.log("\n[5] 接線（靜態）");
// =============================================================================
{
  const server = read("src/server/journey-wish.ts");
  const iHoney = server.indexOf("honeypotTripped(");
  const iInsert = server.indexOf("insertWish(values");
  const iRate = server.indexOf("perIp.take(ip)");
  const iSend = server.indexOf("const sent = await notifyStore(");
  const iRecord = server.indexOf("recordWishEmailResult(wishId");
  checkTrue(
    "server：蜜罐 → 限流 → insert → 寄信 → 寫回",
    iHoney > 0 && iHoney < iRate && iRate < iInsert && iInsert < iSend && iSend < iRecord,
  );
  checkTrue(
    "server：資料落地或信寄出任一個成功就回 ok",
    server.includes("if (sent.ok || wishId) return { ok: true };"),
  );
  checkTrue(
    "server：收件人＝notify_emails（與異業合作同一支解析）",
    server.includes("resolvePartnershipRecipients(") && server.includes("notify_emails"),
  );
  checkTrue(
    "server：只有填表人留了信箱才設 reply_to",
    server.includes("...(values.email ? { replyTo: values.email } : {})"),
  );
  check(
    "server：不寄給填表人（to 只來自 resolve 的結果）",
    /to:\s*values\.email/.test(server),
    false,
  );

  const fns = read("src/lib/journey-wish-fns.ts");
  checkTrue("公開 fn：送出走 POST", fns.includes('createServerFn({ method: "POST" })'));

  const adminFns = read("src/lib/admin/fns/journey-wishes.ts");
  check(
    "admin fns：每一支都掛 adminFnMiddleware",
    (adminFns.match(/createServerFn\(/g) ?? []).length,
    (adminFns.match(/\.middleware\(\[adminFnMiddleware\]\)/g) ?? []).length,
  );
  checkTrue(
    "admin fns 至少三支（列表／詳情／更新）",
    (adminFns.match(/createServerFn\(/g) ?? []).length >= 3,
  );

  const shell = stripComments(read("src/routes/admin/_shell.tsx"));
  checkTrue(
    "側欄：旅程願望在「策旅」後面、staff: false",
    /to: "\/admin\/journeys", label: "策旅"[^\n]*\n\s*\{ to: "\/admin\/journey-wishes", label: "旅程願望", icon: Sparkles, staff: false \}/.test(
      shell,
    ),
  );

  const page = stripComments(read("src/routes/events.kungtung.tsx"));
  const nj = page.slice(
    page.indexOf("function NextJourney("),
    page.indexOf("function MobileReserve("),
  );
  checkTrue("著陸頁：NextJourney 切得出來", nj.length > 500);
  check("著陸頁：願望表單不再開 mailto:", /mailto:/.test(nj), false);
  checkTrue("著陸頁：送出走 submitWishForm", nj.includes("submitWishForm("));
  checkTrue("著陸頁：有蜜罐欄位", nj.includes("honeypotRef") && nj.includes("tabIndex={-1}"));
  checkTrue(
    "著陸頁：source 是 kungtung",
    page.includes('const WISH_SOURCE = "kungtung" as const;'),
  );

  // 匯款帳號不出現在公開著陸頁（站上的帳戶只在結帳完成頁與匯款資訊信）。
  const kt = [
    "src/routes/events.kungtung.tsx",
    "src/components/kungtung/MainSections.tsx",
    "src/components/kungtung/HostSections.tsx",
  ]
    .map(read)
    .join("\n");
  // 外部報導連結的網址裡本來就有長數字（文章編號），先拿掉網址再找。
  const ktNoUrls = kt.replace(/https?:\/\/[^\s"'`]+/g, "");
  check("著陸頁：網址以外沒有任何 12 位以上的數字串（帳號）", /\d{12,}/.test(ktNoUrls), false);
  check("著陸頁：沒有銀行代號 822／收款戶名", /822|好日子股份有限公司|中國信託/.test(kt), false);
  checkTrue("著陸頁：寫明匯款資訊於結帳完成後提供", kt.includes("匯款資訊會在結帳完成後提供"));
  checkTrue(
    "著陸頁：三種付款方式都還在",
    ["信用卡", "銀行匯款", "由我們聯繫"].every((s) => kt.includes(s)),
  );
}

// =============================================================================
console.log("\n[6] 收件匣純邏輯");
// =============================================================================
check("篩選：不帶 → 未處理", inbox.parseWishFilter(undefined), "new");
check("篩選：亂值 → 未處理", inbox.parseWishFilter("drop table"), "new");
check("篩選：reviewed", inbox.parseWishFilter("reviewed"), "reviewed");
check("篩選：all", inbox.parseWishFilter("all"), "all");
check("沒留信箱 → 沒有回信 mailto", inbox.wishReplyMailto({ email: "", source: "kungtung" }), null);
check(
  "回信 mailto：主旨預填且編碼",
  inbox.wishReplyMailto({ email: "a.b+c@example.com", source: "kungtung" }),
  `mailto:a.b+c@example.com?subject=${encodeURIComponent("Re: 【旅程願望】范毅舜公東教堂文化之旅")}`,
);
check(
  "回信 mailto：會改寫參數的字元 → 不產生",
  inbox.wishReplyMailto({ email: "x@example.com?cc=evil@example.com", source: "kungtung" }),
  null,
);
check("摘要：沒寫願望就列選項", inbox.wishSummary({ wish: "", interests: ["甲", "乙"] }), "甲、乙");
check(
  "摘要：超過 40 字截斷",
  Array.from(inbox.wishSummary({ wish: "字".repeat(50), interests: [] })).length,
  41,
);
check("來源標籤：不認得的 key 原樣顯示", wishSourceLabel("other-page"), "other-page");

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
