/**
 * 交易信的排版 —— **純函式，三語，不 import 任何 server-only 模組。**
 *
 * ── 為什麼這個檔案不能碰伺服器的東西 ──────────────────────────────────────
 * 排版是這一期最容易寫錯、也最容易看不出寫錯的部分：一個少填的變數、一個沒跳脫
 * 的 `<`、一個時區算錯的日期，寄出去之前沒有人會發現。所以它必須能被自檢**直接
 * import 起來跑**（scripts/notify-selftest.mjs 用 Node 的原生 TypeScript
 * type stripping 載入這一支），而那要求它不依賴 bundler、不依賴 tsconfig paths、
 * 也不能碰到 `@tanstack/react-start/server-only`。
 *
 * 同一個理由讓 src/server/amego.ts 與 src/server/payuni.ts 只依賴 node:crypto：
 * 驗一份複製品等於沒驗。
 *
 * ── 文案從哪裡來 ──────────────────────────────────────────────────────────
 * 三語文案存在 `public.email_copy`（0022 §2，形狀同 ui_strings），由
 * src/server/repos/email-outbox.ts 讀進來，以 `EmailCopy` 傳給這裡的函式。
 * 這個檔案內建一份 `DEFAULT_EMAIL_COPY` 當 fallback，關係與 src/lib/cms.ts 對
 * src/i18n/strings.ts 一樣：DB 有值就用 DB 的，缺的 key 用內建值補。
 *
 * ⚠️ **內建的文案全部是佔位**，正式文案 user 還沒給。每一段都以「（待補：…）」
 *    開頭，所以在信裡、在後台、在測試輸出裡都一眼看得出來還沒填。0022 §2 種進
 *    資料庫的是同樣的字串。
 *
 * ── 一封信的三個部分 ──────────────────────────────────────────────────────
 * subject / text / html。三個都要有：
 *   * 只給 html 的信在純文字客戶端（以及大部分垃圾信評分器）那邊是空的。
 *   * 只給 text 的信在手機上很難讀。
 * Resend 兩個欄位都收，所以兩份都產。
 *
 * ── 時區 ──────────────────────────────────────────────────────────────────
 * 一律 Asia/Taipei。這是一間台北的書店，活動時間寫錯一小時的後果是有人白跑一趟。
 * 不用 toLocaleString 的預設時區 —— Vercel 的機器是 UTC，那會讓「晚上 7 點的活動」
 * 在信裡變成「上午 11 點」。
 */
import type { Lang, Localized } from "@/i18n/types";

// -----------------------------------------------------------------------------
// 型別
// -----------------------------------------------------------------------------

/** 一封排好版的信。 */
export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

/**
 * 文案查表：`${template_key}.${string_key}` → Localized。
 *
 * 扁平的字串鍵而不是巢狀物件，是為了跟 `public.email_copy` 的
 * (template_key, string_key) 主鍵一對一 —— 少一層轉換就少一個對不上的地方。
 */
export type EmailCopy = Record<string, Localized>;

export type SessionBrief = {
  title: Localized;
  location: Localized;
  /** ISO 字串。 */
  startsAt: string;
  endsAt: string | null;
};

export type OrderPaidInput = {
  orderNo: string;
  customerName: string;
  total: number;
  items: { name: Localized; quantity: number; subtotal: number }[];
  /** 這張訂單買到的場次（可能 0 個 —— 只買書的訂單就是空陣列）。 */
  sessions: SessionBrief[];
};

/**
 * 匯款資訊信（renderRemittanceEmail 的輸入）。
 *
 * ⚠️ 這封信是**下單當下**寄的，錢還沒進來 —— 它是這個站第一封不在「付款成功之後」
 *    寄出的信。所以它刻意**不含**任何「我們收到您的付款了」的語氣，也不含發票資訊
 *    （還沒有發票可開）。
 */
export type RemittanceEmailInput = {
  orderNo: string;
  customerName: string;
  total: number;
  /** 匯款帳戶。四個欄位由 site_settings 提供（0034 §1）。 */
  bankName: string;
  bankCode: string;
  bankAccount: string;
  accountName: string;
  /** 匯款期限的 ISO 字串。null＝算不出來（不該發生），信裡就不印這一列。 */
  dueAt: string | null;
  /**
   * 回到訂單頁（填末五碼）的完整網址。
   *
   * 🔴 **型別上是必填的 string，不是 `string | null`，而且這是刻意的。**
   *    這封信的存在意義有一半是「匯完款回來填末五碼」——沒有可用的網址時，正確的
   *    行為是**不寄這封信**（並留下錯誤紀錄），不是寄一封連結壞掉的信。把它做成
   *    必填，等於在編譯期就讓「先組出一封信、再想辦法塞一個 fallback 網址進去」
   *    這條路走不通。呼叫端（src/server/notify.ts）必須先拿到
   *    publicSiteUrl() 的答案才組得出這個物件。
   */
  orderUrl: string;
  items: { name: Localized; quantity: number; subtotal: number }[];
  /** 這張訂單買到的場次（可能 0 個）。 */
  sessions: SessionBrief[];
};

export type RegistrationEmailInput = {
  /** 這一位參加者的姓名（0021 §0.1：姓名不遮罩）。 */
  participantName: string;
  /** 第幾個位子（1..quantity）。 */
  seatNo: number;
  orderNo: string;
  session: SessionBrief;
};

/**
 * 店家的新訂單／新報名通知（renderAdminOrderNotificationEmail 的輸入）。
 *
 * ⚠️ **刻意沒有 customer_name / phone / 完整地址欄位。** 這封信只是「有新單，
 *    去後台看」的提醒，店家點進後台本來就看得到完整資料；信件內文 30 天後會被
 *    purge_sent_email_bodies() 清掉（0022 §6），但清掉前那 30 天內文都躺在
 *    email_outbox 與 Resend 的紀錄裡——這是原始個資的副本，能不放就不放
 *    （同 0022 §0.4.2 的理由）。型別上沒有這幾個欄位，notify.ts 想傳也傳不了，
 *    這是編譯期就擋住的保證，不是「記得不要傳」這種約定。
 */
export type AdminOrderNotificationInput = {
  orderNo: string;
  total: number;
  /**
   * 這封信是什麼時候排的（0034）。
   *
   * `afterPayment` ＝ 付款成功之後（0022／0032 那條路，dedupe_key
   * `order_notify_admin:`）；`atOrderTime` ＝ 下單當下，錢還沒進來（0034 那條路，
   * dedupe_key `order_placed_admin:`）。
   *
   * 🔴 兩者是**兩封不同的信**，不是同一封的兩個版本。一張匯款訂單會先收到
   *    atOrderTime 那封（「有一張待收款的單」），店家對完帳把它標成已付款之後再收到
   *    afterPayment 那封（「錢收到了」）。dedupe_key 也必須分開，否則第二封會撞
   *    第一封的 key 變成 no-op —— 見 0034 §0.6。
   *
   * ⚠️ 值刻意叫 afterPayment 而不是 "paid"：scripts/notify-selftest.mjs 有一條
   *    「src/server/notify.ts 裡不可以出現 'paid' 字面值」的守衛（要判斷付款狀態
   *    就用 on_roster，那個條件只定義在 0021 §3 的 view 裡）。那條守衛是對的，
   *    這裡不去放寬它——換個名字就好，而且「什麼時候寄」本來就比「paid」精確。
   */
  stage: "afterPayment" | "atOrderTime";
  /** public.orders.payment_method（0005:88）。null＝webhook 還沒填（理論上不會發生——排這封信的前提是訂單已經 paid）。 */
  paymentMethod: string | null;
  /** public.orders.shipping_method（0005:86）。 */
  shippingMethod: string;
  items: { name: Localized; quantity: number; subtotal: number }[];
  /** 這張訂單買到的場次，附這個場次總共幾位參加者（不是逐位名單——名單要登入後台看）。 */
  sessions: { session: SessionBrief; participants: number }[];
};

// -----------------------------------------------------------------------------
// 佔位文案（fallback）
// -----------------------------------------------------------------------------

/**
 * ⚠️ 全部是佔位。與 0022 §2 種進 `public.email_copy` 的字串**逐字相同** ——
 *    兩邊不同步的話，一個沒有那張表的環境（例如本機測試庫）會寄出跟正式環境
 *    不一樣的信，而那種差異沒有任何地方看得出來。
 *
 * scripts/notify-selftest.mjs 會把這裡的每一把 key 拿去 0022 的 SQL 裡對，
 * 少一把或多一把都紅。
 */
export const DEFAULT_EMAIL_COPY: EmailCopy = {
  "common.signature": {
    zh: "（待補：信末署名）小時光書店",
    en: "（待補：信末署名）小時光書店",
    ja: "（待補：信末署名）小時光書店",
  },
  "common.footerNote": {
    zh: "（待補：頁尾說明，例如「本信件由系統自動發送，回信將寄至小時光團隊」）",
    en: "（待補：頁尾說明）",
    ja: "（待補：頁尾說明）",
  },

  "order_paid.subject": {
    zh: "（待補：付款成功信主旨）訂單 {orderNo} 付款完成",
    en: "（待補：付款成功信主旨）Order {orderNo} paid",
    ja: "（待補：付款成功信主旨）ご注文 {orderNo} のお支払い完了",
  },
  "order_paid.heading": {
    zh: "（待補：付款成功信標題）我們收到您的付款了",
    en: "（待補：付款成功信標題）We have received your payment",
    ja: "（待補：付款成功信標題）お支払いを確認しました",
  },
  "order_paid.intro": {
    zh: "（待補：付款成功信開頭段落）",
    en: "（待補：付款成功信開頭段落）",
    ja: "（待補：付款成功信開頭段落）",
  },
  "order_paid.outro": {
    zh: "（待補：付款成功信結尾段落，例如出貨與取件說明）",
    en: "（待補：付款成功信結尾段落）",
    ja: "（待補：付款成功信結尾段落）",
  },

  "registration_ticket.subject": {
    zh: "（待補：報名成功信主旨）報名完成：{sessionTitle}",
    en: "（待補：報名成功信主旨）Registered: {sessionTitle}",
    ja: "（待補：報名成功信主旨）お申し込み完了：{sessionTitle}",
  },
  "registration_ticket.heading": {
    zh: "（待補：報名成功信標題）您的報名已完成",
    en: "（待補：報名成功信標題）Your registration is confirmed",
    ja: "（待補：報名成功信標題）お申し込みが完了しました",
  },
  "registration_ticket.intro": {
    zh: "（待補：報名成功信開頭段落）",
    en: "（待補：報名成功信開頭段落）",
    ja: "（待補：報名成功信開頭段落）",
  },
  "registration_ticket.outro": {
    zh: "（待補：報名成功信結尾段落，例如當天報到方式與注意事項）",
    en: "（待補：報名成功信結尾段落）",
    ja: "（待補：報名成功信結尾段落）",
  },

  "session_reminder.subject": {
    zh: "（待補：活動提醒信主旨）明天見：{sessionTitle}",
    en: "（待補：活動提醒信主旨）See you tomorrow: {sessionTitle}",
    ja: "（待補：活動提醒信主旨）明日開催：{sessionTitle}",
  },
  "session_reminder.heading": {
    zh: "（待補：活動提醒信標題）活動就在明天",
    en: "（待補：活動提醒信標題）Your event is tomorrow",
    ja: "（待補：活動提醒信標題）イベントは明日です",
  },
  "session_reminder.intro": {
    zh: "（待補：活動提醒信開頭段落）",
    en: "（待補：活動提醒信開頭段落）",
    ja: "（待補：活動提醒信開頭段落）",
  },
  "session_reminder.outro": {
    zh: "（待補：活動提醒信結尾段落，例如交通與聯絡方式）",
    en: "（待補：活動提醒信結尾段落）",
    ja: "（待補：活動提醒信結尾段落）",
  },

  // 匯款資訊信（0034）。⚠️ 這四把 key 種在 supabase/migrations/0034，不是 0022 ——
  // scripts/notify-selftest.mjs 的反空殼比對因此改成掃**所有**種 email_copy 的
  // migration，見那一段的註解。
  "remittance.subject": {
    zh: "（待補：匯款資訊信主旨）訂單 {orderNo} 的匯款資訊",
    en: "（待補：匯款資訊信主旨）Bank transfer details for order {orderNo}",
    ja: "（待補：匯款資訊信主旨）ご注文 {orderNo} のお振込のご案内",
  },
  "remittance.heading": {
    zh: "（待補：匯款資訊信標題）訂單已成立，請於期限前完成匯款",
    en: "（待補：匯款資訊信標題）Your order is placed — please transfer by the due date",
    ja: "（待補：匯款資訊信標題）ご注文を承りました。期日までにお振込ください",
  },
  "remittance.intro": {
    zh: "（待補：匯款資訊信開頭段落）",
    en: "（待補：匯款資訊信開頭段落）",
    ja: "（待補：匯款資訊信開頭段落）",
  },
  "remittance.outro": {
    zh: "（待補：匯款資訊信結尾段落，例如「匯款後請回訂單頁填寫帳號末五碼，我們核對後會再通知你」）",
    en: "（待補：匯款資訊信結尾段落）",
    ja: "（待補：匯款資訊信結尾段落）",
  },
};

/**
 * 欄位標籤。**刻意不進 CMS。**
 *
 * 「訂單編號」「時間」「地點」這幾個字改動的機率趨近於零，而每多一列可編輯的
 * 文案就多一個可以被改成空字串的地方 —— 一封標籤全空的信比一封標籤寫得不夠好的
 * 信糟得多。CMS 管的是句子（開頭段落、結尾段落、署名），標籤留在程式碼裡。
 */
const LABELS: Record<string, Localized> = {
  orderNo: { zh: "訂單編號", en: "Order number", ja: "ご注文番号" },
  total: { zh: "應付金額", en: "Total", ja: "お支払い金額" },
  items: { zh: "訂單內容", en: "Items", ja: "ご注文内容" },
  sessionTitle: { zh: "活動場次", en: "Session", ja: "イベント" },
  startsAt: { zh: "時間", en: "When", ja: "日時" },
  location: { zh: "地點", en: "Where", ja: "場所" },
  attendee: { zh: "參加者", en: "Attendee", ja: "参加者" },
  seatNo: { zh: "座位序號", en: "Seat", ja: "座席番号" },
  paymentMethod: { zh: "付款方式", en: "Payment method", ja: "お支払い方法" },
  shippingMethod: { zh: "收件方式", en: "Delivery method", ja: "受け取り方法" },
  participants: { zh: "參加人數", en: "Participants", ja: "参加人数" },
  // 匯款（0034）
  bankAccountName: { zh: "戶名", en: "Account name", ja: "口座名義" },
  bankName: { zh: "銀行", en: "Bank", ja: "銀行" },
  bankCode: { zh: "銀行代號", en: "Bank code", ja: "銀行コード" },
  bankAccount: { zh: "帳號", en: "Account number", ja: "口座番号" },
  remittanceDue: { zh: "匯款期限", en: "Transfer by", ja: "お振込期限" },
  remittanceAccount: { zh: "匯款帳戶", en: "Bank account", ja: "お振込先" },
  remittanceReportLink: {
    zh: "匯款後請回訂單頁填寫帳號末五碼",
    en: "After transferring, tell us your last five digits",
    ja: "お振込後、ご注文ページで下 5 桁をご入力ください",
  },
};

/**
 * 店家通知信專用的兩張對照表——刻意寫死在這裡，不進 email_copy CMS。
 *
 * 理由同上面 LABELS 那一段的檔頭：這是「payment_method 這個資料庫值該印成什麼
 * 中文」的對照，不是一句可以有不同寫法的文案，改動機率趨近於零。CMS 管的是
 * 句子，這種值域固定的代碼表留在程式碼裡——多一個能被後台清空存檔的地方，
 * 換來的風險（「付款方式：」後面空白一片）比它省下的彈性貴。
 *
 * 值域抄自 supabase/migrations/0005_commerce_orders.sql 的兩條 CHECK
 * （payment_method 另外含 0028 加的 'free'）；不在表裡的值（理論上不會發生，
 * 兩欄都是 DB CHECK 鎖住的）印代碼本身，不是空字串——「看到一個沒翻譯過的
 * 代碼」好過「看到一片空白，以為是資料遺失」。
 */
const PAYMENT_METHOD_LABEL_ZH: Record<string, string> = {
  card: "信用卡",
  atm: "ATM 轉帳",
  cvs_cod: "超商代收",
  test_paid: "測試付款",
  free: "免費（無需付款）",
  // 0034。⚠️ 與上面的 'atm' 刻意用不同的字：'atm' 是金流商動態產生虛擬帳號、
  //         自動核帳；'transfer' 是客人匯到店家的固定帳戶、人工對帳。店家看到
  //         這兩個字要能立刻知道「這張單要不要我自己去看銀行對帳單」。
  transfer: "匯款（人工對帳）",
};

const SHIPPING_METHOD_LABEL_ZH: Record<string, string> = {
  home: "宅配到府",
  cvs: "超商取貨",
  pickup: "門市自取",
  none: "無需配送",
};

/** payment_method → 中文顯示字串。null（理論上不會發生）與未知值印代碼本身。 */
export function paymentMethodLabel(code: string | null | undefined): string {
  if (!code) return "（未設定）";
  return PAYMENT_METHOD_LABEL_ZH[code] ?? code;
}

/** shipping_method → 中文顯示字串。未知值印代碼本身。 */
export function shippingMethodLabel(code: string | null | undefined): string {
  if (!code) return "（未設定）";
  return SHIPPING_METHOD_LABEL_ZH[code] ?? code;
}

// -----------------------------------------------------------------------------
// 小工具
// -----------------------------------------------------------------------------

/**
 * 遮罩 Email，給 log 用。
 *
 * ⚠️ **log 裡不准出現裸的收件地址。** src/server/email.ts 與
 *    src/server/notify.ts 的每一行 console.* 都走這一支，靜態測試守著。
 *
 * 它放在這個「排版」檔案裡而不是 server 側，理由只有一個：這樣自檢 import 得到，
 * 遮罩規則才驗得到。它是純字串處理，沒有伺服器相依。
 *
 * 星號數量固定，不跟著原本的長度走 —— 長度本身也是一點資訊。
 *
 * ⚠️ **支援逗號分隔的多個地址**（店家通知信 to 可能是好幾個人，見
 *    parseRecipients()）。這不是為了對稱加的：舊版只找第一個 `@`，
 *    `"a@x.com, b@y.com"` 會被切成 name="a"、domain="@x.com, b@y.com"，
 *    第二個地址整段原樣印在 domain 裡 —— 遮罩了頭，沒遮罩尾，log 紀律照樣被
 *    違反。逐段遞迴遮罩才不會漏。單一地址（沒有逗號）的輸出與舊版逐字元相同。
 */
export function maskEmail(email: string | null | undefined): string {
  const v = (email ?? "").trim();
  if (v.includes(",")) {
    return v
      .split(",")
      .map((part) => maskEmail(part))
      .join(", ");
  }
  const at = v.indexOf("@");
  if (at <= 0) return "***";
  const name = v.slice(0, at);
  const domain = v.slice(at);
  const head = name.slice(0, name.length > 1 ? 2 : 1);
  return `${head}***${domain}`;
}

/**
 * 把「逗號分隔的信箱字串」拆成乾淨的地址陣列。
 *
 * 每一段先 trim，空字串（含只有空白的字串）整段丟棄——後台的收件人欄位打錯多一個
 * 逗號、留了頭尾空白，都不該讓通知信整批失敗。用途：
 *
 *   1. src/server/email.ts 送給 Resend 之前，把 email_outbox.to_email 這一欄
 *      拆成 `to: string[]`（Resend 的 `to` 是陣列，每個元素要是單一地址）。
 *   2. src/lib/admin/schemas.ts 驗證後台「通知信收件人」欄位時，判斷「拆出來
 *      至少一個看起來像 email 的地址」。
 *
 * 空輸入（null / undefined / 空字串 / 只有逗號與空白）回傳空陣列，不是丟錯——
 * 「沒有收件人」在這兩個呼叫端都是合法狀態，不是例外。
 */
export function parseRecipients(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 取一個語言的字串，缺了就退回中文（zh 是這個站的主語言）。 */
export function pick(value: Localized | undefined, lang: Lang): string {
  if (!value) return "";
  return (value[lang] || value.zh || value.en || value.ja || "").trim();
}

/**
 * 查一段文案：DB 給的優先，缺了用內建的佔位補。
 *
 * 「缺了」包含 key 不存在**與 值是空字串**兩種。後者是真的會發生的：後台把某一段
 * 清空存檔，`is_localized()` 只檢查三個 key 在不在，不檢查非空。
 */
export function copyText(copy: EmailCopy | undefined, key: string, lang: Lang): string {
  const fromDb = pick(copy?.[key], lang);
  if (fromDb) return fromDb;
  return pick(DEFAULT_EMAIL_COPY[key], lang);
}

/** `{orderNo}` 這種佔位換成實際值。找不到的變數原樣留著（比印出 undefined 好）。 */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  );
}

/**
 * HTML 跳脫。
 *
 * 姓名、活動名稱、地點全部是使用者或店員輸入的。少了這一步，一個叫做
 * `<script>` 的活動名稱就會讓信件在某些客戶端裡變成一個奇怪的東西 —— 而且
 * 那封信已經寄出去了，改不回來。
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 台幣整數。與站上其他地方一致（0005 起金額全是 TWD 整數元）。 */
export function formatMoney(amount: number): string {
  return `NT$${Math.round(amount).toLocaleString("en-US")}`;
}

const TIME_ZONE = "Asia/Taipei";

/**
 * 場次時間，一律台北時區。
 *
 * ⚠️ 不用 `toLocaleString()` 的預設時區。Vercel 的機器跑在 UTC，那會讓一場
 *    晚上 7 點的活動在信裡變成上午 11 點 —— 而收信的人會照著信上的時間出門。
 *
 * 壞掉的 ISO 字串回原字串而不是 "Invalid Date"：信裡出現一個看得懂的原始值，
 * 遠好過出現一個所有人都看不懂的錯誤字。
 */
export function formatDateTime(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const locale = lang === "ja" ? "ja-JP" : lang === "en" ? "en-US" : "zh-TW";
  return new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** 開始～結束。沒有結束時間就只印開始（0020：ends_at 是選填的）。 */
function formatRange(session: SessionBrief, lang: Lang): string {
  const start = formatDateTime(session.startsAt, lang);
  if (!session.endsAt) return start;
  return `${start} – ${formatDateTime(session.endsAt, lang)}`;
}

// -----------------------------------------------------------------------------
// 版型
// -----------------------------------------------------------------------------

type Row = { label: string; value: string };

/**
 * 一封信的骨架。三封信共用，所以版型只有一份。
 *
 * HTML 刻意樸素：沒有外部 CSS、沒有圖片、沒有 web font。信件客戶端對 CSS 的支援
 * 差異極大，而一封在 Outlook 裡整個散掉的漂亮信，比一封到處都長一樣的樸素信糟。
 * 全部用 inline style。
 */
function layout(input: {
  heading: string;
  intro: string;
  rows: Row[];
  blocks: { title: string; rows: Row[] }[];
  outro: string;
  signature: string;
  footerNote: string;
  /**
   * 一條「回到訂單頁」的連結（0034 的匯款信是第一個用到的）。
   *
   * ⚠️ **url 必須是一條已經驗證過連得到的網址。** 這一層不驗 —— 驗在
   *    src/server/public-url.ts 的 publicSiteUrl()，而 src/server/notify.ts 在
   *    組不出來時**根本不寄這封信**。理由見那一段：一封連結指向 localhost 的信在
   *    我們這一側完全沒有錯誤（寄出成功、log 乾淨），只有客人點下去打不開。
   *
   * 純文字版把網址整條印出來（不是「點這裡」）——純文字信裡沒有可以點的東西，
   * 藏起來的網址等於沒有網址。
   */
  link?: { label: string; url: string };
}): { text: string; html: string } {
  const textLines: string[] = [input.heading, ""];
  if (input.intro) textLines.push(input.intro, "");
  for (const r of input.rows) textLines.push(`${r.label}：${r.value}`);
  for (const b of input.blocks) {
    textLines.push("", b.title);
    for (const r of b.rows) textLines.push(`  ${r.label}：${r.value}`);
  }
  if (input.link) textLines.push("", `${input.link.label}：`, input.link.url);
  if (input.outro) textLines.push("", input.outro);
  textLines.push("", input.signature, "", input.footerNote);

  const row = (r: Row) =>
    `<tr>` +
    `<td style="padding:4px 12px 4px 0;color:#6b6257;white-space:nowrap;vertical-align:top">${escapeHtml(r.label)}</td>` +
    `<td style="padding:4px 0;color:#2b2621;white-space:pre-line">${escapeHtml(r.value)}</td>` +
    `</tr>`;

  const table = (rows: Row[]) =>
    rows.length === 0
      ? ""
      : `<table style="border-collapse:collapse;font-size:14px;line-height:1.7">${rows.map(row).join("")}</table>`;

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC',sans-serif;` +
    `max-width:560px;margin:0 auto;padding:24px;color:#2b2621;background:#ffffff">` +
    `<h1 style="font-size:20px;line-height:1.5;margin:0 0 16px">${escapeHtml(input.heading)}</h1>` +
    (input.intro
      ? `<p style="font-size:14px;line-height:1.8;margin:0 0 16px">${escapeHtml(input.intro)}</p>`
      : "") +
    table(input.rows) +
    input.blocks
      .map(
        (b) =>
          `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e7e1d8">` +
          `<p style="font-size:14px;font-weight:600;margin:0 0 6px">${escapeHtml(b.title)}</p>` +
          table(b.rows) +
          `</div>`,
      )
      .join("") +
    (input.link
      ? `<p style="margin:20px 0 0">` +
        `<a href="${escapeHtml(input.link.url)}" ` +
        `style="display:inline-block;font-size:14px;line-height:1.5;padding:10px 18px;` +
        `border:1px solid #2b2621;color:#2b2621;text-decoration:none">` +
        `${escapeHtml(input.link.label)}</a></p>` +
        // 有些信件客戶端不讓按鈕可點（或客人想複製）。網址本身也印一次。
        `<p style="font-size:12px;line-height:1.7;color:#8a8175;margin:8px 0 0;word-break:break-all">` +
        `${escapeHtml(input.link.url)}</p>`
      : "") +
    (input.outro
      ? `<p style="font-size:14px;line-height:1.8;margin:20px 0 0">${escapeHtml(input.outro)}</p>`
      : "") +
    `<p style="font-size:14px;line-height:1.8;margin:20px 0 0">${escapeHtml(input.signature)}</p>` +
    `<p style="font-size:12px;line-height:1.7;color:#8a8175;margin:24px 0 0;` +
    `padding-top:12px;border-top:1px solid #e7e1d8">${escapeHtml(input.footerNote)}</p>` +
    `</div>`;

  return { text: textLines.join("\n"), html };
}

function sessionRows(session: SessionBrief, lang: Lang): Row[] {
  return [
    { label: pick(LABELS.sessionTitle, lang), value: pick(session.title, lang) },
    { label: pick(LABELS.startsAt, lang), value: formatRange(session, lang) },
    { label: pick(LABELS.location, lang), value: pick(session.location, lang) },
  ];
}

// -----------------------------------------------------------------------------
// 三封信
// -----------------------------------------------------------------------------

/**
 * 付款成功（寄給訂購人）。dedupe_key = `order_paid:<order_id>`。
 *
 * ⚠️ **不含發票號碼**，理由見 0022 檔頭 §0.3：發票有 8 秒逾時保護，等它就等於
 *    讓 Amego 慢的時候信也不寄。
 */
export function renderOrderPaidEmail(
  input: OrderPaidInput,
  copy: EmailCopy | undefined,
  lang: Lang,
): RenderedEmail {
  const subject = fill(copyText(copy, "order_paid.subject", lang), {
    orderNo: input.orderNo,
    customerName: input.customerName,
  });

  const itemLines = input.items
    .map((it) => `${pick(it.name, lang)} × ${it.quantity}　${formatMoney(it.subtotal)}`)
    .join("\n");

  const rows: Row[] = [
    { label: pick(LABELS.orderNo, lang), value: input.orderNo },
    { label: pick(LABELS.total, lang), value: formatMoney(input.total) },
  ];
  if (itemLines) rows.push({ label: pick(LABELS.items, lang), value: itemLines });

  const { text, html } = layout({
    heading: fill(copyText(copy, "order_paid.heading", lang), {
      customerName: input.customerName,
    }),
    intro: fill(copyText(copy, "order_paid.intro", lang), { customerName: input.customerName }),
    rows,
    blocks: input.sessions.map((s) => ({
      title: pick(LABELS.sessionTitle, lang),
      rows: sessionRows(s, lang),
    })),
    outro: copyText(copy, "order_paid.outro", lang),
    signature: copyText(copy, "common.signature", lang),
    footerNote: copyText(copy, "common.footerNote", lang),
  });

  return { subject, text, html };
}

/**
 * 匯款資訊（寄給訂購人，**下單當下**，錢還沒進來）。
 * dedupe_key = `remittance:<order_id>`。
 *
 * 🔴 這是這個站第一封不在「付款成功之後」寄的信。它不走 claim_order_notify()
 *    ——那道閘門的第一句就是 `payment_status <> 'paid' → order_not_paid`，而那是
 *    對的（沒收到錢不要告訴客人收到錢了）。這封信走的是 orders.ts step 7 之後的
 *    新路徑，見 0034 §0.5 與 src/server/notify.ts 的 queueOrderPlacedNotifications()。
 *
 * ⚠️ 帳號印在信裡是刻意的：客人要拿著它去銀行，而完成頁那個連結（帶 public_token）
 *    是他唯一能回來的路，信是備份。帳號本身不是秘密——它印在店家的每一張報價單上。
 */
export function renderRemittanceEmail(
  input: RemittanceEmailInput,
  copy: EmailCopy | undefined,
  lang: Lang,
): RenderedEmail {
  const vars = { orderNo: input.orderNo, customerName: input.customerName };

  const itemLines = input.items
    .map((it) => `${pick(it.name, lang)} × ${it.quantity}　${formatMoney(it.subtotal)}`)
    .join("\n");

  const rows: Row[] = [
    { label: pick(LABELS.orderNo, lang), value: input.orderNo },
    { label: pick(LABELS.total, lang), value: formatMoney(input.total) },
  ];
  // 算不出期限就整列不印。印一列「匯款期限：Invalid Date」比不印那一列糟得多。
  if (input.dueAt) {
    rows.push({
      label: pick(LABELS.remittanceDue, lang),
      value: formatDateTime(input.dueAt, lang),
    });
  }
  if (itemLines) rows.push({ label: pick(LABELS.items, lang), value: itemLines });

  // 匯款帳戶自成一個 block（layout 會用一條分隔線把它跟訂單摘要分開）。空欄位不印
  // ——一個「銀行代號：」後面空白的欄位會讓人以為資料掉了。
  const accountRows: Row[] = [];
  if (input.accountName)
    accountRows.push({ label: pick(LABELS.bankAccountName, lang), value: input.accountName });
  if (input.bankName)
    accountRows.push({ label: pick(LABELS.bankName, lang), value: input.bankName });
  if (input.bankCode)
    accountRows.push({ label: pick(LABELS.bankCode, lang), value: input.bankCode });
  if (input.bankAccount)
    accountRows.push({ label: pick(LABELS.bankAccount, lang), value: input.bankAccount });

  const blocks = [
    ...(accountRows.length > 0
      ? [{ title: pick(LABELS.remittanceAccount, lang), rows: accountRows }]
      : []),
    ...input.sessions.map((s) => ({
      title: pick(LABELS.sessionTitle, lang),
      rows: sessionRows(s, lang),
    })),
  ];

  const { text, html } = layout({
    heading: fill(copyText(copy, "remittance.heading", lang), vars),
    intro: fill(copyText(copy, "remittance.intro", lang), vars),
    rows,
    blocks,
    link: { label: pick(LABELS.remittanceReportLink, lang), url: input.orderUrl },
    outro: fill(copyText(copy, "remittance.outro", lang), vars),
    signature: copyText(copy, "common.signature", lang),
    footerNote: copyText(copy, "common.footerNote", lang),
  });

  return { subject: fill(copyText(copy, "remittance.subject", lang), vars), text, html };
}

/**
 * 報名成功（寄給**每一位**參加者，不是訂購人）。
 * dedupe_key = `registration_ticket:<registration_id>`。
 */
export function renderRegistrationTicketEmail(
  input: RegistrationEmailInput,
  copy: EmailCopy | undefined,
  lang: Lang,
): RenderedEmail {
  const vars = {
    sessionTitle: pick(input.session.title, lang),
    participantName: input.participantName,
    orderNo: input.orderNo,
  };

  const { text, html } = layout({
    heading: fill(copyText(copy, "registration_ticket.heading", lang), vars),
    intro: fill(copyText(copy, "registration_ticket.intro", lang), vars),
    rows: [
      { label: pick(LABELS.attendee, lang), value: input.participantName },
      { label: pick(LABELS.seatNo, lang), value: String(input.seatNo) },
      { label: pick(LABELS.orderNo, lang), value: input.orderNo },
    ],
    blocks: [{ title: pick(LABELS.sessionTitle, lang), rows: sessionRows(input.session, lang) }],
    outro: copyText(copy, "registration_ticket.outro", lang),
    signature: copyText(copy, "common.signature", lang),
    footerNote: copyText(copy, "common.footerNote", lang),
  });

  return {
    subject: fill(copyText(copy, "registration_ticket.subject", lang), vars),
    text,
    html,
  };
}

/**
 * 活動前 24 小時的提醒（寄給每一位參加者）。
 * dedupe_key = `session_reminder:<session_id>:<registration_id>`。
 */
export function renderSessionReminderEmail(
  input: RegistrationEmailInput,
  copy: EmailCopy | undefined,
  lang: Lang,
): RenderedEmail {
  const vars = {
    sessionTitle: pick(input.session.title, lang),
    participantName: input.participantName,
    orderNo: input.orderNo,
  };

  const { text, html } = layout({
    heading: fill(copyText(copy, "session_reminder.heading", lang), vars),
    intro: fill(copyText(copy, "session_reminder.intro", lang), vars),
    rows: [
      { label: pick(LABELS.attendee, lang), value: input.participantName },
      { label: pick(LABELS.seatNo, lang), value: String(input.seatNo) },
      { label: pick(LABELS.orderNo, lang), value: input.orderNo },
    ],
    blocks: [{ title: pick(LABELS.sessionTitle, lang), rows: sessionRows(input.session, lang) }],
    outro: copyText(copy, "session_reminder.outro", lang),
    signature: copyText(copy, "common.signature", lang),
    footerNote: copyText(copy, "common.footerNote", lang),
  });

  return {
    subject: fill(copyText(copy, "session_reminder.subject", lang), vars),
    text,
    html,
  };
}

/**
 * 新訂單／新報名通知（寄給**店家**，不是客人）。
 * dedupe_key = `order_notify_admin:<order_id>`（src/server/notify.ts 的 dedupeKeys）。
 *
 * ── 為什麼只有中文，不進 email_copy CMS ─────────────────────────────────────
 * 上面三支信是寄給客人的，客人結帳時選了語言（orders.locale），三語是必要的。
 * 這封信只有店家自己會看，而店家是台北的中文使用者——三語文案要維護三份、
 * DEFAULT_EMAIL_COPY 要多 12 把 key（4 段 × 3 語言）、0022 §2 的種子資料也要
 * 跟著加，換來的是**永遠只會被拿掉 zh 那一份來看**的 en/ja 文案。這是這個檔案
 * 檔頭說的「不要為了對稱硬做三語」的具體案例：DEFAULT_EMAIL_COPY 那三個模板
 * 三語，是因為收件人真的會切換語言；這裡收件人固定，切換的理由不存在。
 *
 * 同一個理由也適用「進不進 CMS」：LABELS 已經示範過「改動機率趨近於零的文案
 * 留在程式碼裡」，這封信的標題／段落跟 LABELS 是同一種東西（操作型提示，不是
 * 要打動客人的行銷文案），所以整封信——不只是欄位標籤——都直接寫在這裡，不查
 * email_copy、不接受 copy 參數。文案要改就是改這支函式，跟改 LABELS 一樣。
 *
 * ── 為什麼不含客人的完整地址與電話 ──────────────────────────────────────────
 * AdminOrderNotificationInput 的型別上就沒有這兩個欄位（見該型別的檔頭）：
 * 店家點進後台看得到完整資料，這封信只負責「有新單，去後台看」。少放一份
 * 個資副本進 Resend 與 email_outbox 的紀錄裡。
 */
export function renderAdminOrderNotificationEmail(
  input: AdminOrderNotificationInput,
): RenderedEmail {
  const hasSessions = input.sessions.length > 0;
  const placed = input.stage === "atOrderTime";
  // 兩個 stage 的標題與主旨刻意長得不一樣。店家收到的是兩封信，而它們要做的事完全
  // 不同（一封是「錢收到了，去出貨」，一封是「還沒收到錢，去追」）——主旨一樣的話
  // 收件匣裡分不出來，而分不出來的後果是有人去出一張沒收到錢的貨。
  const heading = placed
    ? hasSessions
      ? "有一筆待收款的新訂單／活動報名"
      : "有一筆待收款的新訂單"
    : hasSessions
      ? "有新的訂單／活動報名"
      : "有新的訂單";
  const subject = placed
    ? `【小時光書店】待收款訂單 ${input.orderNo}`
    : `【小時光書店】新訂單 ${input.orderNo}`;

  const itemLines = input.items
    .map((it) => `${pick(it.name, "zh")} × ${it.quantity}　${formatMoney(it.subtotal)}`)
    .join("\n");

  // payment_method = NULL 在 placed 這條路上是**正常值**（＝客人選了「由我們與你
  // 聯繫付款」），不是「webhook 還沒填」。paymentMethodLabel() 對 null 回
  // 「（未設定）」——那在 paid 那條路上是對的（那裡 null 代表資料異常），在這裡會
  // 讓店家以為系統壞了。所以只有這一條路自己翻譯 null。
  const paymentLabel =
    placed && input.paymentMethod === null
      ? "由我們與客人聯繫付款"
      : paymentMethodLabel(input.paymentMethod);

  const rows: Row[] = [
    { label: pick(LABELS.orderNo, "zh"), value: input.orderNo },
    { label: pick(LABELS.total, "zh"), value: formatMoney(input.total) },
    { label: pick(LABELS.paymentMethod, "zh"), value: paymentLabel },
    { label: pick(LABELS.shippingMethod, "zh"), value: shippingMethodLabel(input.shippingMethod) },
  ];
  if (itemLines) rows.push({ label: pick(LABELS.items, "zh"), value: itemLines });

  const { text, html } = layout({
    heading,
    // ⚠️ 純文字，不要用 **粗體** 這類 markdown —— layout() 會把它逐字跳脫之後印出來
    //    （信裡就會出現兩個星號），它沒有 markdown 轉換那一步。
    intro: placed
      ? "後台收到一筆新訂單，款項尚未入帳。品項與座位已經先保留起來，完整資料請登入後台查看。"
      : "後台收到一筆新訂單，摘要如下，完整資料請登入後台查看。",
    rows,
    blocks: input.sessions.map(({ session, participants }) => ({
      title: pick(LABELS.sessionTitle, "zh"),
      rows: [
        ...sessionRows(session, "zh"),
        { label: pick(LABELS.participants, "zh"), value: String(participants) },
      ],
    })),
    outro: placed
      ? "收到款項之後，請到後台把這張訂單標記為已付款——標記之後才會寄出付款成功信與報名成功信，發票也才會開立。"
      : "",
    signature: "小時光書店後台系統",
    footerNote: "本信件由系統自動發送，收件人於後台「全站設定」設定。",
  });

  return { subject, text, html };
}

// -----------------------------------------------------------------------------
// 出貨通知（寄給訂購人，後台按下「標記已出貨」那一刻）
// -----------------------------------------------------------------------------

/**
 * renderOrderShippedEmail 的輸入。
 *
 * ⚠️ 沒有物流單號：orders 沒有那一欄（這一期不加 DDL），所以信裡只說「包裹已經
 *    寄出」，不假裝有一個可以查件的號碼。
 *
 * 收件資訊是**客人自己填的、寄給客人自己**，所以這裡印完整地址／門市（不遮罩）
 * ——那正是這封信要讓他核對的東西。電話刻意不印：核對寄送不需要它，少一份副本。
 */
export type OrderShippedInput = {
  orderNo: string;
  customerName: string;
  /** 只會是 'home' 或 'cvs'（出貨這個動作只對這兩種成立）。 */
  shippingMethod: string;
  items: { name: Localized; quantity: number; subtotal: number }[];
  /** order_addresses 的 shipping 那一列。讀不到就是 null，信裡整區不印。 */
  address: {
    recipient: string;
    postalCode: string;
    city: string;
    district: string;
    street: string;
    cvsStoreName: string;
    cvsStoreId: string;
    cvsAddress: string;
  } | null;
  /** 回到訂單頁的完整網址（/checkout/complete?token=…）。組不出來就是 null，不印連結。 */
  orderUrl: string | null;
  /** site_settings.contact_email。空的就不印「聯絡我們」那一列。 */
  contactEmail: string | null;
};

/**
 * 出貨通知信的句子。**刻意不進 email_copy CMS**：DEFAULT_EMAIL_COPY 的每一把 key
 * 必須與 migration 的 seed 逐字一致（scripts/notify-selftest.mjs 守著），而這一期
 * 不加 migration。署名與頁尾仍然走 CMS（common.signature／common.footerNote），
 * 與其他交易信一致。
 */
export const ORDER_SHIPPED_TEXT = {
  subject: {
    zh: "【小時光書店】訂單 {orderNo} 已出貨",
    en: "Interval Books: your order {orderNo} has shipped",
    ja: "【小時光書店】ご注文 {orderNo} を発送しました",
  },
  heading: {
    zh: "你的訂單已經出貨了",
    en: "Your order is on its way",
    ja: "ご注文の商品を発送しました",
  },
  introHome: {
    zh: "{customerName} 你好，你在小時光書店訂購的商品已經交給宅配寄出，將送到下方地址，請留意收件。",
    en: "Hi {customerName}, your Interval Books order has been handed to the courier and is on its way to the address below.",
    ja: "{customerName} 様、小時光書店でご注文の商品を宅配便で発送しました。下記のご住所へお届けしますので、お受け取りをお願いいたします。",
  },
  introCvs: {
    zh: "{customerName} 你好，你在小時光書店訂購的商品已經寄往下方的超商門市。包裹到店後會再通知你取貨，請於期限內前往取件。",
    en: "Hi {customerName}, your Interval Books order has been sent to the convenience store below. You will be notified when it arrives — please pick it up before the deadline.",
    ja: "{customerName} 様、小時光書店でご注文の商品を下記のコンビニ店舗へ発送しました。到着後にお知らせが届きますので、期限内にお受け取りください。",
  },
  outro: {
    zh: "收到商品後若有任何問題，歡迎與我們聯繫。",
    en: "If anything is wrong with your parcel, please get in touch with us.",
    ja: "商品について何かございましたら、お気軽にお問い合わせください。",
  },
  shippingBlock: { zh: "寄送資訊", en: "Delivery", ja: "お届け先" },
  recipient: { zh: "收件人", en: "Recipient", ja: "お受取人" },
  address: { zh: "地址", en: "Address", ja: "ご住所" },
  store: { zh: "取貨門市", en: "Pick-up store", ja: "受取店舗" },
  storeAddress: { zh: "門市地址", en: "Store address", ja: "店舗住所" },
  methodHome: { zh: "宅配到府", en: "Home delivery", ja: "宅配" },
  methodCvs: { zh: "超商取貨", en: "Convenience store pick-up", ja: "コンビニ受取" },
  contact: { zh: "聯絡我們", en: "Contact us", ja: "お問い合わせ" },
  orderLink: { zh: "查看訂單明細", en: "View your order", ja: "ご注文内容を確認する" },
} satisfies Record<string, Localized>;

/**
 * 出貨通知（寄給訂購人）。dedupe_key = `order_shipped:<order_id>`。
 *
 * 宅配與超商兩種寫法不同：宅配講「送到下方地址」，超商講「到店後超商會再通知取貨」。
 */
export function renderOrderShippedEmail(
  input: OrderShippedInput,
  copy: EmailCopy | undefined,
  lang: Lang,
): RenderedEmail {
  const T = ORDER_SHIPPED_TEXT;
  const isCvs = input.shippingMethod === "cvs";
  const vars = { orderNo: input.orderNo, customerName: input.customerName };

  const itemLines = input.items.map((it) => `${pick(it.name, lang)} × ${it.quantity}`).join("\n");

  const rows: Row[] = [
    { label: pick(LABELS.orderNo, lang), value: input.orderNo },
    {
      label: pick(LABELS.shippingMethod, lang),
      value: pick(isCvs ? T.methodCvs : T.methodHome, lang),
    },
  ];
  if (itemLines) rows.push({ label: pick(LABELS.items, lang), value: itemLines });

  const a = input.address;
  const shipRows: Row[] = [];
  if (a) {
    if (a.recipient) shipRows.push({ label: pick(T.recipient, lang), value: a.recipient });
    if (isCvs) {
      const store = [a.cvsStoreName, a.cvsStoreId ? `(${a.cvsStoreId})` : ""]
        .filter(Boolean)
        .join(" ");
      if (store) shipRows.push({ label: pick(T.store, lang), value: store });
      if (a.cvsAddress) shipRows.push({ label: pick(T.storeAddress, lang), value: a.cvsAddress });
    } else {
      const line = [a.postalCode, `${a.city}${a.district}${a.street}`].filter(Boolean).join(" ");
      if (line.trim()) shipRows.push({ label: pick(T.address, lang), value: line.trim() });
    }
  }

  const blocks: { title: string; rows: Row[] }[] = [];
  if (shipRows.length > 0) blocks.push({ title: pick(T.shippingBlock, lang), rows: shipRows });
  if (input.contactEmail) {
    blocks.push({
      title: pick(T.contact, lang),
      rows: [{ label: "Email", value: input.contactEmail }],
    });
  }

  const { text, html } = layout({
    heading: fill(pick(T.heading, lang), vars),
    intro: fill(pick(isCvs ? T.introCvs : T.introHome, lang), vars),
    rows,
    blocks,
    ...(input.orderUrl ? { link: { label: pick(T.orderLink, lang), url: input.orderUrl } } : {}),
    outro: pick(T.outro, lang),
    signature: copyText(copy, "common.signature", lang),
    footerNote: copyText(copy, "common.footerNote", lang),
  });

  return { subject: fill(pick(T.subject, lang), vars), text, html };
}
