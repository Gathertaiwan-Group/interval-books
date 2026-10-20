/**
 * 「一頁新增活動」的純函式：驗證、時間換算、顯示日期、網址代稱、送出 payload。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 為什麼有這一頁
 * ═══════════════════════════════════════════════════════════════════════════
 * 原本要讓一場活動「看得到、買得到」，店家得走過三個地方：組裝器（11 段）建活動
 * → 同一頁打開「上架成商品」填售價 → 到 /admin/registrations 新增場次（新場次預設
 * 「未開放」）→ 存一次之後再打開那一場才看得到「新增方案」→ 回組裝器確認發布。
 * 一頁新增把「最常見的那一種活動」收成一張表單、一顆按鈕。
 *
 * 🔴 **這裡不寫資料庫，也不另開任何一條報名／金流路。** 這個檔只負責把表單換成
 *    既有那一套（products → event_sessions → event_session_plans）認得的形狀；
 *    真正寫入的是 src/server/event-quick-create.ts，而它只呼叫既有的三支 repo
 *    （upsertEventWithProduct / upsertEventSession / upsertEventSessionPlan）。
 *
 * ⚠️ 這個檔**沒有任何 `@/` 的值匯入**：scripts/event-quick-create-selftest.mjs 用
 *    Node 原生的型別剝離直接 import 它，`@/` 別名在那裡解不開。只准 `import type`。
 *
 * ⚠️ 時間**一律台北**。輸入是店家牆上的時鐘（日期＋時分），換成 timestamptz 時寫死
 *    +08:00（台灣沒有日光節約時間，所以固定位移是正確的，不是近似）。**不准**用
 *    `new Date("2026-11-06T14:00")` —— 那讀的是執行環境的時區（Vercel 是 UTC）。
 *    顯示也不用 toLocaleString（React #418，見 src/lib/taipei-time.ts）。
 */
import type { Localized } from "@/i18n/types";

/* ------------------------------------------------------------------ *
 * 表單形狀
 * ------------------------------------------------------------------ */

/** 報名方式三選一。 */
export type QuickRegistrationMode = "free" | "paid" | "external";

/**
 * 建的是哪一種。**同一張表單、同一支寫入**，策旅只是多兩件事：
 *   1. 梯次可以跨好幾天（出發日期 ≠ 回程日期，event_sessions 的 starts_at／ends_at
 *      本來就是兩個 timestamptz，0020 的 CHECK 只要求 ends_at ≥ starts_at）；
 *   2. 另外建一張 /journeys 的策旅卡片（public.journeys），連到這場活動的頁面。
 *
 * ⚠️ 策旅的報名與收錢**仍然掛在一場活動上**（products.product_type='event'）。這是
 *    正式庫現有策旅的真實形狀：「2026 台東池上秋收山海旅行」的 journeys 列只是一張卡片，
 *    external_url 指向 /events/InntervalChishang.1023，商品、兩個梯次、票種都掛在那場
 *    活動上。public.journeys 沒有 slug／封面／商品連結，也沒有任何 RPC 會建
 *    product_type='journey' 的商品、沒有任何前台頁面賣它 —— 另開那條路就是 CLAUDE.md
 *    最上面那條規則禁止的「另外做一套報名」。
 */
export type QuickKind = "event" | "journey";

export type QuickSessionInput = {
  /** YYYY-MM-DD（<input type="date"> 的值）。 */
  date: string;
  /** HH:mm（<input type="time"> 的值），台北時間。 */
  start: string;
  /** HH:mm，台北時間。結束（日期＋時間）必須晚於開始。 */
  end: string;
  /**
   * 結束日期 YYYY-MM-DD。空字串＝與 date 同一天（活動表單一律留空；策旅的回程日期）。
   */
  end_date: string;
  location: string;
  capacity: number;
};

export type QuickPlanInput = {
  name: string;
  price: number;
};

export type QuickCreateInput = {
  kind: QuickKind;
  title: string;
  category: string;
  speaker_id: string | null;
  image_key: string | null;
  description: string;
  sessions: QuickSessionInput[];
  mode: QuickRegistrationMode;
  plans: QuickPlanInput[];
  external_url: string;
  publish: boolean;
  /** 策旅卡片上的「主題」（一句話）。選填；留空就用分類的名稱（分類本來就有三語）。 */
  theme: string;
};

/* ------------------------------------------------------------------ *
 * 預設值
 * ------------------------------------------------------------------ */

/** 預設地點的三語。與正式庫《海的聲音》那一場場次的 location 逐字相同。 */
export const DEFAULT_LOCATION: Localized = {
  zh: "小時光書店（華山文創園區 紅磚六合院 西 7-3 館）",
  en: "Interval Books, Red Brick Six Halls West 7-3, Huashan 1914 Creative Park, Taipei",
  ja: "小時光書店（華山1914文化創意産業園区 赤レンガ六合院 西7-3館）",
};

export const DEFAULT_CAPACITY = 30;
export const DEFAULT_JOURNEY_CAPACITY = 12;
export const DEFAULT_PLAN_NAME = "一般票";

/** 長度上限。說明與 src/server/translate.ts 的 MAX_INPUT_CHARS（2000）同一個數字。 */
export const QUICK_LIMITS = {
  title: 120,
  description: 2000,
  location: 200,
  planName: 60,
  sessions: 20,
  plans: 10,
  capacity: 9999,
  price: 1_000_000,
} as const;

export function emptySession(kind: QuickKind = "event"): QuickSessionInput {
  return {
    date: "",
    start: "",
    end: "",
    end_date: "",
    // 策旅的集合地點不會是書店本店，預設留空讓人填。
    location: kind === "journey" ? "" : DEFAULT_LOCATION.zh,
    capacity: kind === "journey" ? DEFAULT_JOURNEY_CAPACITY : DEFAULT_CAPACITY,
  };
}

/**
 * 價格**刻意空白**（NaN，畫面上顯示空格），不是 0：付費報名的預設票價是 0 的話，
 * 忘了填就會上架一場「付費但 0 元」的活動，而驗證攔不下來（0 是合法價格）。
 */
export function emptyPlan(name = ""): QuickPlanInput {
  return { name, price: Number.NaN };
}

export function initialQuickCreate(kind: QuickKind = "event"): QuickCreateInput {
  return {
    kind,
    title: "",
    category: "",
    speaker_id: null,
    image_key: null,
    description: "",
    sessions: [emptySession(kind)],
    mode: "paid",
    plans: [emptyPlan(DEFAULT_PLAN_NAME)],
    external_url: "",
    publish: true,
    theme: "",
  };
}

/* ------------------------------------------------------------------ *
 * 台北時間
 * ------------------------------------------------------------------ */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidDate(date: string): boolean {
  const m = DATE_RE.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

export function isValidTime(time: string): boolean {
  return TIME_RE.test(time);
}

/**
 * 台北的「日期＋時分」→ timestamptz（UTC 的 ISO 字串）。
 * 例：("2026-11-06", "14:00") → "2026-11-06T06:00:00.000Z"。
 */
export function taipeiLocalToIso(date: string, time: string): string {
  if (!isValidDate(date) || !isValidTime(time)) {
    throw new Error(`無效的日期或時間：${date} ${time}`);
  }
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}

/** 0=週日。由日期字串直接算，與執行環境時區無關。 */
function weekdayOf(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) return 0;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];
const MONTH_EN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** 結束日期：留空＝與開始同一天。 */
export function endDateOf(s: QuickSessionInput): string {
  return s.end_date && s.end_date.trim() ? s.end_date.trim() : s.date;
}

/** 跨日？（策旅的梯次） */
export function isMultiDay(s: QuickSessionInput): boolean {
  return endDateOf(s) !== s.date;
}

/** 兩個 YYYY-MM-DD 相差幾天（b − a）。 */
export function daysBetween(a: string, b: string): number {
  const pa = DATE_RE.exec(a);
  const pb = DATE_RE.exec(b);
  if (!pa || !pb) return 0;
  const ta = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const tb = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return Math.round((tb - ta) / 86_400_000);
}

function parts(date: string) {
  const m = DATE_RE.exec(date);
  return m ? { y: m[1], mo: m[2], d: m[3] } : { y: "", mo: "", d: "" };
}

/** 依開始時間排序（同日同時再比結束），不改原陣列。 */
export function sortSessions<T extends QuickSessionInput>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) =>
    `${a.date} ${a.start} ${a.end}`.localeCompare(`${b.date} ${b.start} ${b.end}`),
  );
}

/**
 * 列表「顯示日期」欄的文字，格式照正式庫現有的寫法：
 *   一場            → 「2026.09.22 (二) 13:30–15:30」
 *   同一天好幾場    → 「2026.09.22 (二) 10:00、14:00」
 *   跨好幾天        → 「2026.10.20 (二)~11.07 (六)」（跨年就印完整年份）
 *   沒有場次        → 「即將公告」（只有外部連結報名允許沒有場次）
 */
export function deriveDisplayDate(sessions: QuickSessionInput[]): string {
  const valid = sortSessions(sessions.filter((s) => isValidDate(s.date)));
  if (valid.length === 0) return "即將公告";
  const first = valid[0];
  // 跨日的梯次：範圍要畫到「最晚的回程日」，不是最後一梯的出發日。
  const lastDate = valid
    .map(endDateOf)
    .filter(isValidDate)
    .reduce((max, d) => (d > max ? d : max), first.date);
  const f = parts(first.date);
  const head = `${f.y}.${f.mo}.${f.d} (${WEEKDAY_ZH[weekdayOf(first.date)]})`;
  if (first.date === lastDate) {
    if (valid.length === 1) return `${head} ${first.start}–${first.end}`;
    return `${head} ${valid.map((s) => s.start).join("、")}`;
  }
  const l = parts(lastDate);
  const tailDate = l.y === f.y ? `${l.mo}.${l.d}` : `${l.y}.${l.mo}.${l.d}`;
  return `${head}~${tailDate} (${WEEKDAY_ZH[weekdayOf(lastDate)]})`;
}

/**
 * events.iso_date：**最後一場**的日期。這一欄唯一的用途是判斷「已結束」
 * （src/lib/event-status.ts：隔天起算），取最後一場才不會在第二梯還沒辦之前就被
 * 掃進「已結束」。沒有場次 → null（＝判不出來，留在進行中）。
 */
export function deriveIsoDate(sessions: QuickSessionInput[]): string | null {
  const ends = sessions
    .filter((s) => isValidDate(s.date))
    .map(endDateOf)
    .filter(isValidDate)
    .sort();
  return ends.length ? ends[ends.length - 1] : null;
}

/** 場次名稱（三語），格式照正式庫既有場次：「2026.09.05（六）10:00–12:00」。 */
export function sessionTitleFor(s: QuickSessionInput): Localized {
  const p = parts(s.date);
  const wd = weekdayOf(s.date);
  const range = `${s.start}–${s.end}`;
  if (isMultiDay(s)) {
    // 跨日（策旅的梯次）：「2026.10.23（五）–10.25（日）」，與正式庫池上那兩梯同一種讀法。
    const e = endDateOf(s);
    const q = parts(e);
    const we = weekdayOf(e);
    const sameYear = q.y === p.y;
    const zhTail = sameYear ? `${q.mo}.${q.d}` : `${q.y}.${q.mo}.${q.d}`;
    const enHead = `${WEEKDAY_EN[wd]} ${Number(p.d)} ${MONTH_EN[Number(p.mo) - 1] ?? ""}`;
    const enTail = `${WEEKDAY_EN[we]} ${Number(q.d)} ${MONTH_EN[Number(q.mo) - 1] ?? ""} ${q.y}`;
    return {
      zh: `${p.y}.${p.mo}.${p.d}（${WEEKDAY_ZH[wd]}）–${zhTail}（${WEEKDAY_ZH[we]}）`,
      en: `${enHead}${sameYear ? "" : ` ${p.y}`} – ${enTail}`,
      ja: `${p.y}年${Number(p.mo)}月${Number(p.d)}日（${WEEKDAY_JA[wd]}）–${sameYear ? "" : `${q.y}年`}${Number(q.mo)}月${Number(q.d)}日（${WEEKDAY_JA[we]}）`,
    };
  }
  return {
    zh: `${p.y}.${p.mo}.${p.d}（${WEEKDAY_ZH[wd]}）${range}`,
    en: `${WEEKDAY_EN[wd]} ${Number(p.d)} ${MONTH_EN[Number(p.mo) - 1] ?? ""} ${p.y}, ${range}`,
    ja: `${p.y}年${Number(p.mo)}月${Number(p.d)}日（${WEEKDAY_JA[wd]}）${range}`,
  };
}

/* ------------------------------------------------------------------ *
 * 網址代稱與摘要
 * ------------------------------------------------------------------ */

/**
 * 網址代稱的「底」：第一場的日期 YYYYMMDD（沒有場次就用今天，台北）。
 *
 * ⚠️ **不從標題產生。** 這個站的標題是中文，slugify 只會得到空字串（見
 *    src/lib/admin/schemas.ts 的 slug 註解）。日期讀得懂、不會撞中文、也符合
 *    eventSchema 的代稱規則（英數字開頭）。撞號由 pickUniqueSlug() 加 -2、-3。
 */
export function slugBaseFor(sessions: QuickSessionInput[], todayTaipei: string): string {
  const first = sortSessions(sessions.filter((s) => isValidDate(s.date)))[0];
  const date = first ? first.date : todayTaipei;
  return date.replaceAll("-", "");
}

/** 在已被用掉的代稱裡挑第一個空的：base、base-2、base-3…（大小寫不分）。 */
export function pickUniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((s) => s.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`網址代稱 ${base} 底下已經沒有可用的編號`);
}

const SUMMARY_MAX = 120;

/**
 * 摘要（列表卡片、分享預覽、商品說明用的那一句）：說明的第一段，超過 120 字截斷。
 * 一頁新增只問一欄「活動簡介」，摘要從它來；要另外寫一句，到組裝器 §2 改。
 */
export function deriveSummary(description: string): string {
  const firstPara =
    description
      .split(/\n\s*\n|\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const chars = [...firstPara];
  return chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join("")}…` : firstPara;
}

/* ------------------------------------------------------------------ *
 * 驗證
 * ------------------------------------------------------------------ */

/**
 * 錯誤訊息，key 是欄位路徑（例："title"、"sessions.0.end"、"plans.1.price"）。
 * 空物件＝可以送出。前端與 server 用**同一支**，server 那一側在寫入前再跑一次。
 */
export type QuickCreateErrors = Record<string, string>;

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

export function validateQuickCreate(v: QuickCreateInput): QuickCreateErrors {
  const e: QuickCreateErrors = {};
  const title = v.title.trim();
  if (!title) e.title = "請填活動名稱";
  else if ([...title].length > QUICK_LIMITS.title)
    e.title = `活動名稱最多 ${QUICK_LIMITS.title} 字`;

  if (!v.category.trim()) e.category = "請選一個分類";

  const description = v.description.trim();
  if (!description) e.description = "請寫幾句活動簡介";
  else if ([...description].length > QUICK_LIMITS.description)
    e.description = `活動簡介最多 ${QUICK_LIMITS.description} 字`;

  const internal = v.mode !== "external";
  if (internal && v.sessions.length === 0) e.sessions = "站內報名至少要有一個場次";
  if (v.sessions.length > QUICK_LIMITS.sessions)
    e.sessions = `一次最多 ${QUICK_LIMITS.sessions} 個場次`;

  v.sessions.forEach((s, i) => {
    const k = `sessions.${i}`;
    if (!isValidDate(s.date)) e[`${k}.date`] = "請選日期";
    if (!isValidTime(s.start)) e[`${k}.start`] = "請填開始時間";
    const endDate = endDateOf(s);
    if (s.end_date && s.end_date.trim() && !isValidDate(endDate)) {
      e[`${k}.end_date`] = "請選回程日期";
    } else if (isValidDate(s.date) && endDate < s.date) {
      e[`${k}.end_date`] = "回程日期不能早於出發日期";
    }
    if (!isValidTime(s.end)) e[`${k}.end`] = "請填結束時間";
    else if (isValidTime(s.start) && `${endDate} ${s.end}` <= `${s.date} ${s.start}`)
      e[`${k}.end`] = "結束時間要晚於開始時間";
    if (internal) {
      const loc = s.location.trim();
      if (!loc) e[`${k}.location`] = "請填地點";
      else if ([...loc].length > QUICK_LIMITS.location)
        e[`${k}.location`] = `地點最多 ${QUICK_LIMITS.location} 字`;
      if (!isInt(s.capacity) || s.capacity < 1) e[`${k}.capacity`] = "名額至少 1 位（整數）";
      else if (s.capacity > QUICK_LIMITS.capacity)
        e[`${k}.capacity`] = `名額最多 ${QUICK_LIMITS.capacity}`;
    }
  });

  if (v.mode === "paid") {
    if (v.plans.length === 0) e.plans = "付費報名至少要有一個票種";
    if (v.plans.length > QUICK_LIMITS.plans) e.plans = `最多 ${QUICK_LIMITS.plans} 個票種`;
    const seen = new Set<string>();
    v.plans.forEach((p, i) => {
      const k = `plans.${i}`;
      const name = p.name.trim();
      if (!name) e[`${k}.name`] = "請填票種名稱";
      else if ([...name].length > QUICK_LIMITS.planName)
        e[`${k}.name`] = `票種名稱最多 ${QUICK_LIMITS.planName} 字`;
      else if (seen.has(name)) e[`${k}.name`] = "票種名稱重複了";
      seen.add(name);
      if (!isInt(p.price) || p.price < 0) e[`${k}.price`] = "價格要是 0 以上的整數";
      else if (p.price > QUICK_LIMITS.price) e[`${k}.price`] = "價格太大了";
    });
  }

  if (v.mode === "external") {
    const url = v.external_url.trim();
    if (!/^https?:\/\/\S+\.\S+/.test(url)) e.external_url = "請貼上完整網址（https:// 開頭）";
  }

  return e;
}

/* ------------------------------------------------------------------ *
 * payload：表單 → 既有三支 repo 吃的形狀
 * ------------------------------------------------------------------ */

/** 翻譯結果（中文 → 英日）。找不到的字串一律用中文頂上（見 localizedOf）。 */
export type Translations = Map<string, { en: string; ja: string }>;

/** 某段中文 → 三語。沒有翻譯就三語都放中文（is_localized 只要求三個 key 都非空）。 */
export function localizedOf(zh: string, tr: Translations): Localized {
  const t = tr.get(zh);
  return { zh, en: t?.en || zh, ja: t?.ja || zh };
}

/** 需要送去翻譯的中文字串（去重、不含預設地點——那一組三語是寫死的）。 */
export function stringsToTranslate(v: QuickCreateInput): string[] {
  const out = new Set<string>();
  out.add(v.title.trim());
  out.add(v.description.trim());
  out.add(deriveSummary(v.description));
  if (v.mode !== "external") {
    for (const s of v.sessions) {
      const loc = s.location.trim();
      if (loc && loc !== DEFAULT_LOCATION.zh) out.add(loc);
    }
  }
  if (v.mode === "paid") for (const p of v.plans) out.add(p.name.trim());
  if (v.kind === "journey") out.add(v.theme.trim());
  out.delete("");
  return [...out];
}

export type QuickEventPayload = {
  slug: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  display_date: string;
  iso_date: string | null;
  category: string;
  speaker_id: string | null;
  image_key: string | null;
  external_url: string;
  registration_type: "internal" | "external";
  payment_enabled: boolean;
  sort_order: number;
};

export type QuickSessionPayload = {
  title: Localized;
  location: Localized;
  starts_at: string;
  ends_at: string;
  capacity: number;
  sort_order: number;
};

export type QuickPlanPayload = {
  title: Localized;
  price: number;
  /** 每張票佔 1 個座位；票種名額＝場次名額，真正的上限由場次那一層管。 */
  seats_per_unit: 1;
  sort_order: number;
};

export type QuickCreatePlan = {
  event: QuickEventPayload;
  /** null ＝不建商品（外部連結報名）。 */
  product: { price: number } | null;
  sessions: QuickSessionPayload[];
  /** 每一個場次都掛這一組票種。空陣列＝免費（場次沒有方案，照 products.price=0 走）。 */
  plans: QuickPlanPayload[];
};

/**
 * 表單 → 寫入計畫。純函式：時間、三語、價格全在這裡決定，server 那一側只照順序寫。
 *
 * - 免費：registration_type=internal、payment_enabled=false、商品 price=0、**不建方案**
 *   （0028 的 settle_free_order() 會把 total=0 的訂單當場結清）。
 * - 付費：payment_enabled=true、每個場次掛同一組票種；商品 price＝最低票價（商品卡
 *   顯示用，真正結帳讀的是方案的價格）。
 * - 外部連結：registration_type=external，不建商品、不建場次（場次掛在商品上，沒有
 *   商品就掛不上去）；表單上的日期只拿來產生顯示日期。
 */
export function buildQuickCreatePlan(
  v: QuickCreateInput,
  opts: { slug: string; sortOrder: number; translations: Translations },
): QuickCreatePlan {
  const tr = opts.translations;
  const description = v.description.trim();
  const internal = v.mode !== "external";
  const sorted = sortSessions(v.sessions);

  const event: QuickEventPayload = {
    slug: opts.slug,
    title: localizedOf(v.title.trim(), tr),
    summary: localizedOf(deriveSummary(description), tr),
    description: localizedOf(description, tr),
    display_date: deriveDisplayDate(v.sessions),
    iso_date: deriveIsoDate(v.sessions),
    category: v.category.trim(),
    speaker_id: v.speaker_id && v.speaker_id.trim() ? v.speaker_id.trim() : null,
    image_key: v.image_key && v.image_key.trim() ? v.image_key.trim() : null,
    external_url: v.mode === "external" ? v.external_url.trim() : "",
    registration_type: internal ? "internal" : "external",
    payment_enabled: v.mode === "paid",
    sort_order: opts.sortOrder,
  };

  if (!internal) return { event, product: null, sessions: [], plans: [] };

  const sessions: QuickSessionPayload[] = sorted.map((s, i) => {
    const loc = s.location.trim();
    return {
      title: sessionTitleFor(s),
      location: loc === DEFAULT_LOCATION.zh ? { ...DEFAULT_LOCATION } : localizedOf(loc, tr),
      starts_at: taipeiLocalToIso(s.date, s.start),
      ends_at: taipeiLocalToIso(endDateOf(s), s.end),
      capacity: s.capacity,
      sort_order: i,
    };
  });

  const plans: QuickPlanPayload[] =
    v.mode === "paid"
      ? v.plans.map((p, i) => ({
          title: localizedOf(p.name.trim(), tr),
          price: p.price,
          seats_per_unit: 1,
          sort_order: i + 1,
        }))
      : [];

  const price = plans.length ? Math.min(...plans.map((p) => p.price)) : 0;
  return { event, product: { price }, sessions, plans };
}

/* ------------------------------------------------------------------ *
 * 策旅卡片（public.journeys）
 * ------------------------------------------------------------------ */

/**
 * 卡片上的「幾天幾夜」，從第一個梯次算：出發到回程差 N 天 → N+1 天 N 夜。
 * 當天來回 → 「1 日」。沒有梯次（外部連結、日期未定）→ 「詳見行程」。
 * 正式庫那一張寫的是「3天2夜／3 Days, 2 Nights／2泊3日」，這裡照同一個寫法。
 */
export function deriveJourneyDays(sessions: QuickSessionInput[]): Localized {
  const first = sortSessions(sessions.filter((s) => isValidDate(s.date)))[0];
  if (!first) return { zh: "詳見行程", en: "See itinerary", ja: "日程は詳細をご覧ください" };
  const nights = Math.max(0, daysBetween(first.date, endDateOf(first)));
  if (nights === 0) return { zh: "1 日", en: "1 Day", ja: "日帰り" };
  const days = nights + 1;
  return {
    zh: `${days}天${nights}夜`,
    en: `${days} Days, ${nights} Night${nights > 1 ? "s" : ""}`,
    ja: `${nights}泊${days}日`,
  };
}

export type QuickJourneyCardPayload = {
  title: Localized;
  summary: Localized;
  description: Localized;
  days: Localized;
  theme: Localized;
  external_url: string;
  registration_type: "internal" | "external";
  payment_enabled: boolean;
  sort_order: number;
};

/**
 * 策旅卡片。內容與活動共用同一份（名稱、摘要、簡介），**報名連結指向這場活動的頁面**
 * （/events/<代稱>）—— 正式庫池上那一張就是這樣接的；外部連結報名則直接連外部網址。
 */
export function buildJourneyCard(
  v: QuickCreateInput,
  event: QuickEventPayload,
  opts: { sortOrder: number; translations: Translations; categoryLabel: Localized | null },
): QuickJourneyCardPayload {
  const theme = v.theme.trim();
  return {
    title: event.title,
    summary: event.summary,
    description: event.description,
    days: deriveJourneyDays(v.sessions),
    theme: theme
      ? localizedOf(theme, opts.translations)
      : (opts.categoryLabel ?? localizedOf(v.category.trim(), opts.translations)),
    external_url: v.mode === "external" ? v.external_url.trim() : `/events/${event.slug}`,
    registration_type: event.registration_type,
    payment_enabled: event.payment_enabled,
    sort_order: opts.sortOrder,
  };
}

/**
 * 送出前依報名方式整理表單：**畫面上藏起來的欄位不能帶著無效值送出去。**
 *
 * 表單預設有一列「一般票」（價格刻意空白＝NaN），切到「免費／外部連結」時那一區被藏起來，
 * 但值還在 —— 原封不動送出，server fn 的 zod（number）會擋下 NaN，使用者只看到一句
 * 格式錯誤、卻沒有任何欄位可以改。外部連結的名額也一樣（那一欄不顯示）。
 */
export function normalizeForSubmit(v: QuickCreateInput): QuickCreateInput {
  const external = v.mode === "external";
  return {
    ...v,
    plans: v.mode === "paid" ? v.plans : [],
    external_url: external ? v.external_url : "",
    sessions: v.sessions.map((s) =>
      external && !Number.isFinite(s.capacity) ? { ...s, capacity: DEFAULT_CAPACITY } : s,
    ),
  };
}
