#!/usr/bin/env node
/**
 * partnership-selftest.mjs —— 異業合作表單（/partnership）的自檢
 *
 *   [1] 欄位驗證（src/lib/partnership.ts 的 partnershipSchema，前後台同一份）
 *   [2] 清理：控制字元／CRLF、多行欄位
 *   [3] 信件：主旨清理與截斷、HTML 跳脫、沒有可點的連結、台北時間
 *   [4] token：簽章、最短填寫時間、過期、竄改
 *   [5] 蜜罐、限流、取 IP
 *   [6] 收件人：notify_emails 拆解（parseRecipients）、測試開關只認 @resend.dev
 *   [7] 接線（靜態）：server fn、reply_to、不寄給填表人、dry run 不算成功、連結入口
 *
 * 執行：node scripts/partnership-selftest.mjs（或 npm test）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LIMITS,
  isHttpUrl,
  multiLine,
  partnershipSchema,
  singleLine,
  fieldErrorText,
  PARTNERSHIP_TYPES,
  PARTNERSHIP_BUDGETS,
} from "../src/lib/partnership.ts";
import { partnershipSubject, renderPartnershipEmail } from "../src/lib/partnership-email.ts";
import {
  MAX_AGE_MS,
  MIN_FILL_MS,
  SlidingWindowLimiter,
  checkFormToken,
  clientIpFrom,
  honeypotTripped,
  issueFormToken,
  resolvePartnershipRecipients,
} from "../src/server/partnership-guard.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/partnership-selftest.mjs";
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

const VALID = {
  type: "cobrand",
  company: "山與海文創",
  contactName: "王小明",
  email: "ming@example.com",
  phone: "+886 2-1234-5678 #12",
  website: "https://example.com/brand",
  timeframe: "2027 年 3 月",
  budget: "50k-150k",
  message: "我們想在小時光辦一場品牌聯名的選書活動，約 30 人。",
  consent: true,
};
const parse = (patch) => partnershipSchema.safeParse({ ...VALID, ...patch });
const codesOf = (r) => (r.success ? [] : r.error.issues.map((i) => `${i.path[0]}:${i.message}`));

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] 欄位驗證");
check("完整合法的一份 → 通過", parse({}).success, true);
check(
  "選填欄位全空 → 通過",
  parse({ phone: "", website: "", timeframe: "", budget: "" }).success,
  true,
);
check("合作類型空白 → type", codesOf(parse({ type: "" })), ["type:type"]);
check("合作類型不在清單 → type", codesOf(parse({ type: "hack" })), ["type:type"]);
check(
  "七種合作類型（含其他）都收",
  PARTNERSHIP_TYPES.every((type) => parse({ type }).success),
  true,
);
check("公司名稱只有空白 → required", codesOf(parse({ company: "   " })), ["company:required"]);
check("聯絡人空白 → required", codesOf(parse({ contactName: "" })), ["contactName:required"]);
check("公司名稱超過上限 → tooLong", codesOf(parse({ company: "字".repeat(LIMITS.company + 1) })), [
  "company:tooLong",
]);
check("Email 空白 → required", codesOf(parse({ email: "" }))[0], "email:required");
check("Email 格式錯 → email", codesOf(parse({ email: "not-an-email" })), ["email:email"]);
check("Email 夾換行注入 → 不通過", parse({ email: "a@b.com\r\nBcc: x@y.com" }).success, false);
check(
  "Email 前後空白會被去掉",
  parse({ email: "  ming@example.com " }).data?.email,
  "ming@example.com",
);
check("電話含字母 → phone", codesOf(parse({ phone: "02-1234 abc" })), ["phone:phone"]);
check("網址不是 http(s) → url", codesOf(parse({ website: "javascript:alert(1)" })), [
  "website:url",
]);
check("網址沒有協定 → url", codesOf(parse({ website: "example.com" })), ["website:url"]);
check("預算不在清單 → budget", codesOf(parse({ budget: "1億" })), ["budget:budget"]);
check("說明 19 字 → messageMin", codesOf(parse({ message: "一".repeat(19) })), [
  "message:messageMin",
]);
check("說明 20 字 → 通過", parse({ message: "一".repeat(20) }).success, true);
check("說明 2000 字 → 通過", parse({ message: "一".repeat(2000) }).success, true);
check("說明 2001 字 → messageMax", codesOf(parse({ message: "一".repeat(2001) })), [
  "message:messageMax",
]);
check(
  "說明的長度量清理後（空白灌水不算）",
  codesOf(parse({ message: `  ${"一".repeat(10)}\n\n\n\n\n\n\n\n\n\n  ` })),
  ["message:messageMin"],
);
check("沒勾隱私權 → consent", codesOf(parse({ consent: false })), ["consent:consent"]);
check("consent 是字串 'true' → 不算", parse({ consent: "true" }).success, false);
check(
  "錯誤代碼可翻成三語",
  [
    fieldErrorText("email", "zh"),
    fieldErrorText("email", "en").length > 0,
    fieldErrorText("email", "ja").length > 0,
  ],
  ["電子郵件格式不正確", true, true],
);
check("未知代碼退回 required", fieldErrorText("???", "zh"), "這一欄必填");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] 清理");
check("singleLine：CRLF／TAB 變空白並壓縮", singleLine("A\r\nBcc: x\t\tY  "), "A Bcc: x Y");
check("singleLine：NUL、DEL、C1 控制字元", singleLine("a\u0000b\u007fc\u0085d"), "a b c d");
check(
  "multiLine：保留換行、CRLF→LF",
  multiLine("第一行\r\n第二行\r第三行"),
  "第一行\n第二行\n第三行",
);
check("multiLine：連續空行壓成一個空行", multiLine("a\n\n\n\n\nb"), "a\n\nb");
check("multiLine：拿掉控制字元", multiLine("a\u0000b\u0007c"), "abc");
check(
  "清理後的公司名稱沒有換行",
  parse({ company: "壞公司\r\nX-Header: 1" }).data?.company,
  "壞公司 X-Header: 1",
);
check("isHttpUrl：https 可以", isHttpUrl("https://a.tw/x?y=1"), true);
check("isHttpUrl：data: 不行", isHttpUrl("data:text/html,hi"), false);
check("isHttpUrl：http:// 但沒有主機不行", isHttpUrl("http://"), false);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 信件");
const values = parse({}).data;
check("主旨格式", partnershipSubject(values), "【異業合作】品牌聯名｜山與海文創｜王小明");
const longSubject = partnershipSubject({
  type: "event",
  company: "長".repeat(80),
  contactName: "名".repeat(40),
});
check(
  "主旨：公司截 40 字、姓名截 20 字",
  longSubject,
  `【異業合作】活動合作｜${"長".repeat(40)}…｜${"名".repeat(20)}…`,
);
const injected = partnershipSubject({
  type: "talk",
  company: "A\r\nBcc: evil@x.com",
  contactName: "B\nC",
});
check("主旨：沒有任何 CR／LF", /[\r\n]/.test(injected), false);
check("主旨：注入字串被壓成一行", injected, "【異業合作】講座／工作坊｜A Bcc: evil@x.com｜B C");
check(
  "主旨：其他",
  partnershipSubject({ type: "other", company: "x", contactName: "y" }),
  "【異業合作】其他｜x｜y",
);

const evil = parse({
  company: `<script>alert(1)</script>&"'`,
  contactName: "<b>粗</b>",
  website: "https://evil.example/<img src=x onerror=alert(1)>",
  message: '請看 <a href="https://phish.example">這裡</a>\n第二行 & 第三段',
}).data;
const mail = renderPartnershipEmail(evil, {
  submittedAt: "2026-10-26T04:05:00.000Z",
  lang: "en",
  pageUrl: "https://www.intervalbooks.tw/partnership?x=<y>",
});
check(
  "HTML：script 被跳脫",
  mail.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;"),
  true,
);
check("HTML：沒有原樣的 <script", mail.html.includes("<script"), false);
check(
  "HTML：說明裡的 <a> 被跳脫",
  mail.html.includes("&lt;a href=&quot;https://phish.example&quot;&gt;"),
  true,
);
check("HTML：整封信一個 <a 都沒有（不做可點連結）", /<a[\s>]/i.test(mail.html), false);
check('HTML：沒有真正的 href="（說明裡的只以跳脫後的文字出現）', /href="/i.test(mail.html), false);
check(
  "HTML：官網以純文字出現（已跳脫）",
  mail.html.includes("https://evil.example/&lt;img src=x onerror=alert(1)&gt;"),
  true,
);
check("HTML：沒有原樣的 <img", mail.html.includes("<img"), false);
check("HTML：說明保留換行（pre-wrap）", mail.html.includes("white-space:pre-wrap"), true);
check("HTML：送出時間是台北時間", mail.html.includes("2026/10/26 12:05（台北）"), true);
check("純文字：送出時間是台北時間", mail.text.includes("送出時間：2026/10/26 12:05（台北）"), true);
check("純文字：填表語言", mail.text.includes("填表語言：English"), true);
check(
  "純文字：來源頁面",
  mail.text.includes("來源頁面：https://www.intervalbooks.tw/partnership?x=<y>"),
  true,
);
check("純文字：Email 在信裡", mail.text.includes("Email：ming@example.com"), true);
check("純文字：預算用中文標籤", mail.text.includes("預算範圍：NT$5–15 萬"), true);
check("純文字：說明原文（未跳脫）", mail.text.includes("第二行 & 第三段"), true);
const sparse = renderPartnershipEmail(
  parse({ phone: "", website: "", timeframe: "", budget: "" }).data,
  {
    submittedAt: "2026-10-26T04:05:00.000Z",
    lang: "zh",
    pageUrl: "",
  },
);
check(
  "選填空白印「—」",
  ["電話：—", "官網／社群：—", "預計時間：—", "預算範圍：—", "來源頁面：—"].every((s) =>
    sparse.text.includes(s),
  ),
  true,
);
check(
  "壞掉的時間原樣印出，不是 Invalid Date",
  renderPartnershipEmail(values, { submittedAt: "nope", lang: "zh", pageUrl: "" }).text.includes(
    "Invalid Date",
  ),
  false,
);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] 表單 token");
const SECRET = "test-secret-0123456789";
const t0 = 1_800_000_000_000;
const tok = issueFormToken(SECRET, t0);
check("token 形狀", /^\d+\.[A-Za-z0-9_-]+$/.test(tok), true);
check("剛發 → too_fast", checkFormToken(tok, SECRET, t0), "too_fast");
check(
  `${MIN_FILL_MS - 1}ms → too_fast`,
  checkFormToken(tok, SECRET, t0 + MIN_FILL_MS - 1),
  "too_fast",
);
check(`${MIN_FILL_MS}ms → ok`, checkFormToken(tok, SECRET, t0 + MIN_FILL_MS), "ok");
check("一天內 → ok", checkFormToken(tok, SECRET, t0 + MAX_AGE_MS), "ok");
check("超過一天 → expired", checkFormToken(tok, SECRET, t0 + MAX_AGE_MS + 1), "expired");
check("換一把 secret → invalid", checkFormToken(tok, "other-secret", t0 + 10_000), "invalid");
const [ts, sig] = tok.split(".");
check(
  "竄改時間（往前推）→ invalid",
  checkFormToken(`${Number(ts) - 60_000}.${sig}`, SECRET, t0 + 10_000),
  "invalid",
);
check(
  "竄改簽章 → invalid",
  checkFormToken(`${ts}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, SECRET, t0 + 10_000),
  "invalid",
);
check(
  "來自未來的 token → invalid",
  checkFormToken(issueFormToken(SECRET, t0 + 60_000), SECRET, t0),
  "invalid",
);
check("空字串 → invalid", checkFormToken("", SECRET, t0), "invalid");
check("非字串 → invalid", checkFormToken(12345, SECRET, t0), "invalid");
check("超長 → invalid", checkFormToken("1".repeat(300), SECRET, t0), "invalid");
check("沒有 secret → invalid（不是 ok）", checkFormToken(tok, "", t0 + 10_000), "invalid");
let threw = false;
try {
  issueFormToken("");
} catch {
  threw = true;
}
check("沒有 secret 時發不出 token", threw, true);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] 蜜罐、限流、IP");
check("蜜罐空字串 → 沒中", honeypotTripped(""), false);
check("蜜罐只有空白 → 沒中", honeypotTripped("   "), false);
check("蜜罐有字 → 中", honeypotTripped("http://spam"), true);
check("蜜罐 undefined → 沒中", honeypotTripped(undefined), false);
const lim = new SlidingWindowLimiter(3, 10_000);
check(
  "限流：前三次放行",
  [lim.take("a", 0), lim.take("a", 1), lim.take("a", 2)],
  [true, true, true],
);
check("限流：第四次擋", lim.take("a", 3), false);
check("限流：別的 key 不受影響", lim.take("b", 3), true);
check("限流：視窗過了再放行", lim.take("a", 10_001), true);
const small = new SlidingWindowLimiter(1, 10_000, 2);
small.take("x", 0);
small.take("y", 0);
small.take("z", 0);
check("限流：key 數有上限（最舊的被丟掉，x 又能送）", small.take("x", 1), true);
const hdr = (h) => (n) => h[n];
check(
  "IP：優先 x-vercel-forwarded-for",
  clientIpFrom(hdr({ "x-vercel-forwarded-for": "1.1.1.1", "x-forwarded-for": "9.9.9.9" })),
  "1.1.1.1",
);
check(
  "IP：其次 x-real-ip",
  clientIpFrom(hdr({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "9.9.9.9" })),
  "2.2.2.2",
);
check(
  "IP：x-forwarded-for 取第一段",
  clientIpFrom(hdr({ "x-forwarded-for": "3.3.3.3, 10.0.0.1" })),
  "3.3.3.3",
);
check("IP：都沒有 → unknown（共用一個桶）", clientIpFrom(hdr({})), "unknown");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[6] 收件人");
const NOTIFY = " a@gmail.com, b@gmail.com ,, c@gmail.com ,";
check("notify_emails 拆成三個地址", resolvePartnershipRecipients(NOTIFY, undefined), {
  to: ["a@gmail.com", "b@gmail.com", "c@gmail.com"],
  test: false,
});
check("空的 notify_emails → 沒有收件人", resolvePartnershipRecipients("", undefined).to, []);
check("null → 沒有收件人", resolvePartnershipRecipients(null, null).to, []);
check("不像 email 的段落被丟掉", resolvePartnershipRecipients("a@gmail.com, 店長, x@", "").to, [
  "a@gmail.com",
]);
check(
  "測試開關：@resend.dev → 改寄測試信箱",
  resolvePartnershipRecipients(NOTIFY, "delivered@resend.dev"),
  { to: ["delivered@resend.dev"], test: true },
);
const origWarn = console.warn;
console.warn = () => {};
check(
  "測試開關：不是 @resend.dev → 忽略，照寄店家",
  resolvePartnershipRecipients(NOTIFY, "attacker@evil.com").test,
  false,
);
check(
  "測試開關：混一個真實地址 → 整個忽略",
  resolvePartnershipRecipients(NOTIFY, "delivered@resend.dev, x@evil.com").to.length,
  3,
);
check(
  "測試開關：resend.dev.evil.com 不算",
  resolvePartnershipRecipients(NOTIFY, "a@resend.dev.evil.com").test,
  false,
);
console.warn = origWarn;

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[7] 接線（靜態）");
const server = read("src/server/partnership.ts");
const fns = read("src/lib/partnership-fns.ts");
const route = read("src/routes/partnership.tsx");
const emailTs = read("src/server/email.ts");
checkTrue("server：server-only", server.includes('import "@tanstack/react-start/server-only"'));
checkTrue("server：reply_to 設成填表人", /replyTo:\s*values\.email/.test(server));
checkTrue(
  "server：收件人來自 notify_emails",
  server.includes("getSiteSettings()") && server.includes("notify_emails"),
);
check(
  "server：to 只來自 resolvePartnershipRecipients（不含 values.email）",
  /to:\s*[^,\n]*values\.email/.test(server),
  false,
);
checkTrue("server：只有 outcome === sent 才算成功", server.includes('result.outcome !== "sent"'));
checkTrue("server：沒設定 Resend 直接失敗", server.includes("emailConfigured()"));
checkTrue(
  "server：失敗 log 帶 [partnership]",
  (server.match(/console\.error\(\s*[`"]\[partnership\]/g) ?? []).length >= 3,
);
check(
  "server：log 不印裸收件地址（to= 一律 maskEmail）",
  /to=\$\{(?!maskEmail)/.test(server),
  false,
);
checkTrue(
  "server：蜜罐、token、限流都有",
  ["honeypotTripped(", "checkFormToken(", "perIp.take("].every((s) => server.includes(s)),
);
checkTrue(
  "fns：送出是 POST",
  /submitPartnershipForm = createServerFn\(\{ method: "POST" \}\)/.test(fns),
);
checkTrue(
  "fns：server 模組在 handler 裡動態 import",
  fns.includes('await import("@/server/partnership")'),
);
check("fns：沒有靜態 import server 模組", /^import .*@\/server\//m.test(fns), false);
checkTrue("email.ts：每封信可帶自己的 replyTo", emailTs.includes("message.replyTo"));
checkTrue("route：有蜜罐欄位", route.includes("honeypotRef") && route.includes("tabIndex={-1}"));
checkTrue("route：隱私權連到 /privacy", route.includes('to="/privacy"'));
checkTrue("route：成功文案", route.includes("已收到，我們會在 3 個工作天內回覆。"));
checkTrue("route：用同一份 schema", route.includes("zodResolver(partnershipSchema)"));
checkTrue("footer 有入口", read("src/components/SiteFooter.tsx").includes('to="/partnership"'));
checkTrue("/about 有入口", read("src/routes/about.tsx").includes('to="/partnership"'));
checkTrue("/curation 有入口", read("src/routes/curation.tsx").includes('to="/partnership"'));
checkTrue("/partnership 連回 /curation", route.includes('to="/curation"'));

console.log("\n[8] 收件匣（0042 partnership_inquiries、/admin/partnerships）");
{
  const inbox = await import(join(ROOT, "src/lib/partnership-inbox.ts"));
  const mig = read("supabase/migrations/0042_partnership_inquiries.sql");
  const repo = read("src/server/repos/partnership-inquiries.ts");
  const adminFns = read("src/lib/admin/fns/partnerships.ts");
  const typeList = (mig.match(/type in \(([^)]*)\)/) ?? [])[1] ?? "";
  check(
    "migration 的 type CHECK 與 PARTNERSHIP_TYPES 一致",
    [...typeList.matchAll(/'([^']+)'/g)].map((m) => m[1]),
    [...PARTNERSHIP_TYPES],
  );
  const budgetList = (mig.match(/budget in \(([^)]*)\)/) ?? [])[1] ?? "";
  check(
    "migration 的 budget CHECK 與 '' ＋ PARTNERSHIP_BUDGETS 一致",
    [...budgetList.matchAll(/'([^']*)'/g)].map((m) => m[1]),
    ["", ...PARTNERSHIP_BUDGETS],
  );
  for (const [col, max] of [
    ["company", LIMITS.company],
    ["contact_name", LIMITS.name],
    ["phone", LIMITS.phone],
    ["website", LIMITS.website],
    ["timeframe", LIMITS.timeframe],
  ]) {
    checkTrue(
      `migration 的 ${col} 長度上限 = LIMITS（${max}）`,
      new RegExp(`char_length\\(${col}\\) (between 1 and|<=) ${max}\\s*\\)`).test(mig),
    );
  }
  checkTrue(
    "migration：message 上限 2000、下限放寬成 1（見檔頭）",
    mig.includes("char_length(message) between 1 and 2000"),
  );
  checkTrue(
    "migration：RLS 開、anon/authenticated 全收回",
    mig.includes("enable row level security") && mig.includes("from anon, authenticated"),
  );
  check("migration：沒有任何 policy", /create policy/i.test(mig), false);

  // 送出流程：先存、再寄、寄信結果寫回；任一個成功就回 ok。
  const iInsert = server.indexOf("insertInquiry(values");
  const iSend = server.indexOf("const sent = await notifyStore(");
  const iRecord = server.indexOf("recordEmailResult(inquiryId");
  checkTrue("server：先 insert 再寄信再寫回", iInsert > 0 && iInsert < iSend && iSend < iRecord);
  checkTrue(
    "server：資料落地或信寄出任一個成功就回 ok",
    server.includes("if (sent.ok || inquiryId) return { ok: true };"),
  );
  checkTrue("server：insert 失敗只記 log、照樣寄信", /存進收件匣失敗，改為只寄信/.test(server));
  checkTrue(
    "server：蜜罐在 insert 之前就 return（機器人不落地）",
    server.indexOf("honeypotTripped(") < iInsert,
  );
  checkTrue(
    "repo：admin_note／status 只由後台更新",
    repo.includes("export async function updateInquiry("),
  );
  check(
    "admin fns：每一支都掛 adminFnMiddleware",
    (adminFns.match(/createServerFn\(/g) ?? []).length,
    (adminFns.match(/\.middleware\(\[adminFnMiddleware\]\)/g) ?? []).length,
  );

  check("篩選：不帶 → 未處理", inbox.parseInquiryFilter(undefined), "new");
  check("篩選：亂值 → 未處理", inbox.parseInquiryFilter("drop table"), "new");
  check("篩選：all", inbox.parseInquiryFilter("all"), "all");
  check(
    "回信 mailto：主旨預填且編碼",
    inbox.replyMailto({ email: "a.b+c@example.com", type: "event", company: "山與海" }),
    `mailto:a.b+c@example.com?subject=${encodeURIComponent("Re: 【異業合作】活動合作｜山與海")}`,
  );
  check(
    "回信 mailto：地址帶 ? & 之類會改寫參數的字元 → 不產生",
    inbox.replyMailto({ email: "x@example.com?cc=evil@example.com", type: "event", company: "a" }),
    null,
  );
  check("預算標籤：空字串＝未填", inbox.inquiryBudgetLabel(""), "未填");
}

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
