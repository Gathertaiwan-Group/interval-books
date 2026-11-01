/**
 * SEO 的純函式核心（2026-11 SEO 健檢修正）。
 *
 * ⚠️ 這支模組刻意**零 runtime import**（只有 `import type`，執行時會被剝掉），理由與
 *    src/server/cache-policy.ts 相同：
 *      1. scripts/seo-selftest.mjs 用相對路徑直接 import 這個檔案跑真的行為測試——
 *         selftest 沒有 "@/..." 別名解析能力，多 import 一個東西那支測試就會炸。
 *      2. src/server.ts 每一個請求都會呼叫 redirectFor()／robotsTagFor()，必須是
 *         便宜的純函式，不能碰 Supabase。
 *
 * 這裡放的東西：
 *   - 網址：SITE_ORIGIN、absoluteUrl()、canonicalPathname()、canonicalUrl()、redirectFor()
 *   - 索引控制：robotsTagFor()（X-Robots-Tag 標頭）、isNoindexPath()（robots meta）
 *   - 文字：seoTitle()、stripForeignBrandSuffix()、fitDescription()、hasPlaceholder()
 *   - JSON-LD：organizationLd()、websiteLd()、bookStoreLd()、eventLd()、productLd()、
 *     breadcrumbLd()——**只吃呼叫端給的資料**，沒有的欄位就不輸出，不在這裡編任何值。
 */
import type { Localized } from "../../i18n/types";

// =============================================================================
// 網址
// =============================================================================

/** 正式站的唯一網址（https + www）。canonical、og:url、og:image、sitemap 一律用它。 */
export const SITE_ORIGIN = "https://www.intervalbooks.tw";

/** 把相對路徑（/assets/…、/media/…）補成絕對網址；已經是絕對網址的原樣回傳。 */
export function absoluteUrl(urlOrPath: string | null | undefined): string {
  const v = (urlOrPath ?? "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("//")) return `https:${v}`;
  return `${SITE_ORIGIN}${v.startsWith("/") ? "" : "/"}${v}`;
}

/**
 * 站上所有「固定」的前台路徑（全小寫、無尾斜線）。大小寫不同的請求（/EVENTS）會被
 * 301 到這裡的版本。後台（/admin、/vendor）只收登入頁，其餘後台網址不碰。
 *
 * scripts/seo-selftest.mjs 會拿 src/routeTree.gen.ts 對帳：路由表裡每一條不含 `$`、
 * 不在 /admin、/vendor 底下的路徑都必須出現在這裡——新增前台頁面忘了加，測試會紅。
 */
export const STATIC_PUBLIC_PATHS: readonly string[] = [
  "/",
  "/about",
  "/account",
  "/account/forgot",
  "/account/login",
  "/account/register",
  "/account/reset",
  "/admin",
  "/admin/login",
  "/admin/pending",
  "/auth/confirm",
  "/cart",
  "/checkout",
  "/checkout/complete",
  "/contact",
  "/curated",
  "/curation",
  "/events",
  "/events/city-salon-0922",
  "/events/kungtung",
  "/events/kungtung/hosts/alice",
  "/events/kungtung/hosts/fan-yishun",
  "/events/sound-of-the-sea",
  "/journeys",
  "/news",
  "/oauth/authorize",
  "/partnership",
  "/privacy",
  "/publications",
  "/shop",
  "/vendor",
  "/vendor/login",
  "/vendor/pending",
  "/visit",
];

const STATIC_SET = new Set(STATIC_PUBLIC_PATHS);

/**
 * 只有一段動態參數的前台路由（/events/$slug、/shop/$slug）。第一段大小寫統一成小寫，
 * **slug 本身原樣保留**——活動代稱是大小寫敏感的（例：InntervalChishang.1023），
 * 把它轉小寫就是把一個活的網址轉成 404。
 */
const DYNAMIC_SINGLE_SEGMENT = ["events", "shop"];

/**
 * 路徑的標準形：去掉尾斜線、壓掉連續斜線、固定路徑轉小寫。
 * 不認得的路徑（後台、未知頁）只做前兩件事，不改大小寫。
 */
export function canonicalPathname(pathname: string): string {
  let p = pathname || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "") || "/";

  const lower = p.toLowerCase();
  if (STATIC_SET.has(lower)) return lower;

  const segs = p.split("/").filter(Boolean);
  if (segs.length === 2 && DYNAMIC_SINGLE_SEGMENT.includes(segs[0].toLowerCase())) {
    return `/${segs[0].toLowerCase()}/${segs[1]}`;
  }
  return p;
}

/** /shop 的分頁：只有這兩個值算獨立頁面（各自有 title、description 與自我 canonical）。 */
export const SHOP_INDEXABLE_TABS = ["publications", "curated"] as const;
export type ShopIndexableTab = (typeof SHOP_INDEXABLE_TABS)[number];

export function shopTabOf(search: unknown): ShopIndexableTab | null {
  const tab =
    search && typeof search === "object" ? (search as Record<string, unknown>).tab : undefined;
  return SHOP_INDEXABLE_TABS.includes(tab as ShopIndexableTab) ? (tab as ShopIndexableTab) : null;
}

/**
 * 這一頁的 canonical：絕對網址、標準路徑、去掉所有 query——唯一的例外是 /shop 的
 * `?tab=publications`／`?tab=curated`（兩個獨立內容的分頁，見 shop.index.tsx）。
 * `?tab=products` 就是 /shop 本身，所以不保留。
 */
export function canonicalUrl(pathname: string, search?: unknown): string {
  const path = canonicalPathname(pathname);
  if (path === "/shop") {
    const tab = shopTabOf(search);
    if (tab) return `${SITE_ORIGIN}/shop?tab=${tab}`;
  }
  return path === "/" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${path}`;
}

/**
 * 伺服器層的永久轉址（src/server.ts 在交給 TanStack 之前先問這裡）：
 *   - 尾斜線 → 308 到沒有尾斜線的版本（原本是框架給的 307 暫時轉址）
 *   - 固定路徑大小寫不對（/EVENTS、/Shop/pub-tw-001）→ 301 到標準形
 * query string 原樣帶過去（追蹤參數交給 canonical 處理，轉址不吃掉訪客的參數）。
 * 只處理 GET／HEAD；/_serverFn、/api、/.well-known 這類非頁面路徑一律不碰。
 */
export function redirectFor(
  pathname: string,
  search: string,
  method: string,
): { status: 301 | 308; location: string } | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (!pathname || pathname === "/") return null;
  if (/^\/(_serverFn|api|\.well-known|assets|media)(\/|$)/i.test(pathname)) return null;

  const target = canonicalPathname(pathname);
  if (target === pathname) return null;

  // 只差尾斜線 → 308；大小寫也不同 → 301（兩種都是永久轉址，搜尋引擎都會轉移訊號）
  const trimmed = pathname.replace(/\/+$/, "") || "/";
  const status: 301 | 308 = trimmed === target ? 308 : 301;
  return { status, location: `${target}${search || ""}` };
}

// =============================================================================
// 索引控制
// =============================================================================

/**
 * 不該被收錄的前綴。與 cache-policy.ts 的 SENSITIVE_PREFIXES 重疊但不相等：
 * 這裡多了 /cart、/auth、/_serverFn，因為「不該被收錄」比「不能被共用快取」範圍大。
 */
const NOINDEX_PREFIXES = [
  "/admin",
  "/vendor",
  "/account",
  "/checkout",
  "/cart",
  "/api",
  "/oauth",
  "/auth",
  "/_serverFn",
];

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** 這條路徑的頁面要不要 noindex（robots meta 與 X-Robots-Tag 共用同一份判斷）。 */
export function isNoindexPath(pathname: string): boolean {
  const p = canonicalPathname(pathname).toLowerCase();
  return NOINDEX_PREFIXES.some((prefix) => matchesPrefix(p, prefix));
}

/** X-Robots-Tag 標頭的值；null = 不加。 */
export function robotsTagFor(pathname: string): string | null {
  return isNoindexPath(pathname) ? "noindex, nofollow" : null;
}

/** robots.txt 的全文。Disallow 的清單與 NOINDEX_PREFIXES 同源。 */
export function robotsTxt(): string {
  const lines = ["User-agent: *", "Allow: /"];
  // /_serverFn 不擋：那是頁面渲染時資料請求走的 RPC，Googlebot 渲染頁面要能呼叫它
  // （Google 明講不要擋渲染需要的資源）；它本身由 X-Robots-Tag 擋收錄。
  for (const prefix of NOINDEX_PREFIXES) {
    if (prefix !== "/_serverFn") lines.push(`Disallow: ${prefix}`);
  }
  // MCP 的 OAuth discovery（/.well-known/oauth-*）是給 AI 客戶端的 JSON，不是頁面。
  lines.push("Disallow: /.well-known/oauth-");
  lines.push("", `Sitemap: ${SITE_ORIGIN}/sitemap.xml`, "");
  return lines.join("\n");
}

// =============================================================================
// 文字
// =============================================================================

export const BRAND = {
  zh: "小時光書店",
  en: "Interval Books",
  ja: "小時光書店",
} as const satisfies Localized;

/**
 * 站名標語——描述太短時補在後面用。內容全部是站上已經寫著的事實：地址（/about、
 * 頁尾）、風土誌（首頁 title）、地方刊物（/shop 分頁）、讀書會／講座／工作坊與策旅
 * （首頁入口與 /journeys）。
 */
export const SITE_BLURB: Localized = {
  zh: "小時光書店位於台北華山文創園區紅磚六合院西7-3館，以風土誌為主題選書，展售地方刊物與選物，也舉辦讀書會、講座、工作坊與策旅。",
  en: "Interval Books is a terroir-minded bookstore in the Red Brick Courtyard (West 7-3) of Huashan 1914 Creative Park, Taipei — books, local publications, curated objects, reading circles, talks, workshops and journeys.",
  ja: "小時光書店は台北・華山1914文化創意産業園区 紅煉瓦六合院 西7-3館にある、風土誌をテーマにした書店。選書、地域の刊行物、セレクト品のほか、読書会・トーク・ワークショップ・旅も企画しています。",
};

/** 「＿＿＿」「___」這類還沒填的佔位符。 */
export function hasPlaceholder(text: string | null | undefined): boolean {
  return /＿|_{3,}|\{\{|TODO|待補|待填/.test(text ?? "");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 字數（以 code point 計，中文一字算一）。 */
export function charLength(text: string): number {
  return Array.from(text).length;
}

/** 截到 max 個字；有截斷就補「…」。 */
export function truncate(text: string, max: number): string {
  const chars = Array.from(collapse(text));
  if (chars.length <= max) return chars.join("");
  return `${chars
    .slice(0, max - 1)
    .join("")
    .replace(/[\s，、。,.;；：:｜|]+$/, "")}…`;
}

const DESC_LIMITS = {
  zh: { min: 70, max: 160 },
  ja: { min: 70, max: 160 },
  en: { min: 110, max: 300 },
} as const;

/**
 * 描述的長度整理：太短補上站名標語、太長截斷。佔位符（＿＿＿）視同沒寫，由 fallback 取代。
 *
 * 純粹的字串處理，**不新增任何事實**：補上去的只有 SITE_BLURB（站上已有的事實）。
 */
export function fitDescription(primary: Localized, fallback?: Localized): Localized {
  const pick = (lang: keyof Localized): string => {
    const own = collapse(primary[lang] ?? "");
    const fb = collapse(fallback?.[lang] ?? "");
    let text = own && !hasPlaceholder(own) ? own : fb || own.replace(/＿+|_{3,}/g, "");
    const { min, max } = DESC_LIMITS[lang];
    if (charLength(text) < min) {
      const blurb = SITE_BLURB[lang];
      text = text
        ? `${text}${/[。.!?！？]$/.test(text) ? "" : lang === "en" ? "." : "。"}${lang === "en" ? " " : ""}${blurb}`
        : blurb;
    }
    return truncate(text, max);
  };
  return { zh: pick("zh"), en: pick("en"), ja: pick("ja") };
}

/** 從長文截一段摘要（給沒有專用描述欄位的商品、活動用）。 */
export function excerpt(text: string, max = 120): string {
  return truncate(text, max);
}

/**
 * 去掉標題結尾「 | 別人的品牌」那一段——例：「2026 台東池上秋收山海旅行 | 馥自然人文空間」。
 * 只認**半形** `|` 前後有空白的寫法（那是從別的網站 <title> 複製來的格式）；站上自己的
 * 標題用全形「｜」當副標分隔（「打開心流｜陶作閱讀課」），那個不動。
 */
export function stripForeignBrandSuffix(title: string): string {
  return title.replace(/\s+\|\s+[^|｜]+$/, "").trim();
}

/** 用「｜」把幾段串成 title，空的段落略過。 */
export function joinTitle(...parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join("｜");
}

/**
 * 三語 title 模板：「{名稱}｜{其他段落}｜小時光書店」（英文版品牌是 Interval Books）。
 * 名稱先去掉外來品牌後綴（見 stripForeignBrandSuffix）。
 */
export function seoTitle(name: Localized, ...middle: Array<Localized | string | null>): Localized {
  const part = (m: Localized | string | null, lang: keyof Localized): string =>
    m == null ? "" : typeof m === "string" ? m : m[lang] || m.zh;
  const build = (lang: keyof Localized) =>
    joinTitle(
      stripForeignBrandSuffix(name[lang] || name.zh),
      ...middle.map((m) => part(m, lang)),
      BRAND[lang],
    );
  return { zh: build("zh"), en: build("en"), ja: build("ja") };
}

// =============================================================================
// JSON-LD
// =============================================================================

export type JsonLd = Record<string, unknown>;

/** JSON-LD 物件 → TanStack head() 的 meta 項目（框架會輸出 <script type="application/ld+json">，並做 HTML 跳脫）。 */
export function ldMeta(data: JsonLd): { "script:ld+json": JsonLd } {
  return { "script:ld+json": data };
}

export const ORG_ID = `${SITE_ORIGIN}/#organization`;
export const STORE_ID = `${SITE_ORIGIN}/#bookstore`;
export const WEBSITE_ID = `${SITE_ORIGIN}/#website`;

/** 店家資訊的最小形狀（src/lib/cms.ts 的 SiteContent 結構上相容）。 */
export type StoreFacts = {
  site: { address: Localized; city: Localized; hours: Localized; shortDesc: Localized };
  contactEmail: string;
  phones: { label: string; display: string; tel: string }[];
  social: { instagram: string; facebook: string; line: string };
  map: { link: string; apple: string };
  meta: { siteName: string };
};

function sameAsOf(facts: StoreFacts): string[] {
  return [facts.social.instagram, facts.social.facebook, facts.social.line].filter((u) =>
    /^https?:\/\//.test(u ?? ""),
  );
}

export function organizationLd(facts: StoreFacts, logoUrl: string): JsonLd {
  const phone = facts.phones[0]?.tel;
  const sameAs = sameAsOf(facts);
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: facts.meta.siteName,
    alternateName: ["小時光書店", "Interval Books"],
    url: `${SITE_ORIGIN}/`,
    logo: absoluteUrl(logoUrl),
    ...(facts.contactEmail ? { email: facts.contactEmail } : {}),
    ...(phone ? { telephone: phone } : {}),
    ...(sameAs.length ? { sameAs } : {}),
  };
}

export function websiteLd(facts: StoreFacts): JsonLd {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: facts.meta.siteName,
    url: `${SITE_ORIGIN}/`,
    inLanguage: "zh-Hant-TW",
    publisher: { "@id": ORG_ID },
  };
}

const DAY_CODES: Record<string, number> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};
const SCHEMA_DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/**
 * 「Mon – Sun, 11:00 – 19:00」→ openingHoursSpecification。讀的是後台的英文營業時間
 * （site_settings.hours.en，格式最規律）。認不出格式就回 null（不輸出這個欄位），
 * 絕不猜。
 */
export function parseOpeningHours(hoursEn: string): JsonLd | null {
  const m =
    /^\s*([A-Za-z]{3})[a-z]*\s*[–—-]\s*([A-Za-z]{3})[a-z]*\s*,?\s*(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})\s*$/.exec(
      hoursEn ?? "",
    );
  if (!m) return null;
  const from = DAY_CODES[m[1].toLowerCase()];
  const to = DAY_CODES[m[2].toLowerCase()];
  if (from === undefined || to === undefined || to < from) return null;
  const pad = (h: string) => h.padStart(2, "0");
  return {
    "@type": "OpeningHoursSpecification",
    dayOfWeek: SCHEMA_DAYS.slice(from, to + 1).map((d) => `https://schema.org/${d}`),
    opens: `${pad(m[3])}:${m[4]}`,
    closes: `${pad(m[5])}:${m[6]}`,
  };
}

/** Apple Maps 連結上的 `ll=緯度,經度`（後台 site_settings.map_apple）。沒有就回 null。 */
export function geoFromAppleMapsLink(link: string): JsonLd | null {
  try {
    const ll = new URL(link).searchParams.get("ll");
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(ll ?? "");
    if (!m) return null;
    return { "@type": "GeoCoordinates", latitude: Number(m[1]), longitude: Number(m[2]) };
  } catch {
    return null;
  }
}

/**
 * BookStore（LocalBusiness 的子類）。地址、電話、營業時間、地圖全部來自後台的
 * site_settings／contact_phones（root loader 讀的那一份，也就是頁尾與 /about 印的那一份）。
 *
 * ⚠️ 郵遞區號與路名**不輸出**：site_settings 沒有這兩個欄位，健檢報告也註明要跟業主
 *    確認，這裡不自己補。
 */
export function bookStoreLd(facts: StoreFacts, imageUrl: string, logoUrl: string): JsonLd {
  const hours = parseOpeningHours(facts.site.hours.en);
  const geo = geoFromAppleMapsLink(facts.map.apple);
  const phone = facts.phones[0]?.tel;
  const sameAs = sameAsOf(facts);
  return {
    "@type": "BookStore",
    "@id": STORE_ID,
    name: facts.meta.siteName,
    url: `${SITE_ORIGIN}/`,
    image: absoluteUrl(imageUrl),
    logo: absoluteUrl(logoUrl),
    description: facts.site.shortDesc.zh,
    parentOrganization: { "@id": ORG_ID },
    address: {
      "@type": "PostalAddress",
      streetAddress: facts.site.address.zh,
      addressLocality: facts.site.city.zh,
      addressCountry: "TW",
    },
    ...(geo ? { geo } : {}),
    ...(phone ? { telephone: phone } : {}),
    ...(facts.contactEmail ? { email: facts.contactEmail } : {}),
    ...(hours ? { openingHoursSpecification: [hours] } : {}),
    ...(/^https?:\/\//.test(facts.map.link) ? { hasMap: facts.map.link } : {}),
    ...(sameAs.length ? { sameAs } : {}),
  };
}

export function siteGraphLd(facts: StoreFacts, imageUrl: string, logoUrl: string): JsonLd {
  return {
    "@context": "https://schema.org",
    "@graph": [
      organizationLd(facts, logoUrl),
      websiteLd(facts),
      bookStoreLd(facts, imageUrl, logoUrl),
    ],
  };
}

export type Crumb = { name: string; path: string };

export function breadcrumbLd(crumbs: Crumb[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: absoluteUrl(c.path),
    })),
  };
}

/** 活動的一個場次（呼叫端從 ShopSession 轉過來；可不可買由呼叫端用 shop.ts 的規則算好）。 */
export type LdSession = {
  location: string;
  startsAt: string;
  endsAt: string | null;
  /** 這一場還有沒有位子（remainingForSession() > 0）。 */
  available: boolean;
  /** 票種（0036）。空陣列 = 沒有票種，價格用 basePrice。 */
  plans: { name: string; price: number; available: boolean }[];
};

export type EventLdInput = {
  name: string;
  description: string;
  url: string;
  image: string | null;
  /** 售票商品的場次；空陣列 = 不知道日期地點 → 不輸出 Event（Google 必填欄位缺了就不該硬塞）。 */
  sessions: LdSession[];
  /** 沒有票種時的單一價格（products.price）。 */
  basePrice: number | null;
  performer?: string | null;
};

/** ISO 時間 → 台北時間（+08:00）的 ISO 字串。不合法回 null。 */
export function toTaipeiIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`;
}

/**
 * 一個場次一個 Event。資料全部來自售票商品（products → event_sessions →
 * event_session_plans）：日期、地點、價格、名額。
 *
 *   - eventStatus：站上沒有「取消／延期」的狀態欄位，賣得到的場次就是 EventScheduled。
 *   - eventAttendanceMode：站上沒有線上場次的欄位，所有活動都是實體（Offline）。
 *   - 地點：場次的 location 文字（後台填的「華山小時光風土誌書店（台北市中正區…）」），
 *     同時當 Place 的 name 與 address——沒有拆好的郵遞地址就不假裝有。
 */
export function eventLd(input: EventLdInput): JsonLd[] {
  const out: JsonLd[] = [];
  const availability = (ok: boolean) =>
    ok ? "https://schema.org/InStock" : "https://schema.org/SoldOut";
  for (const s of input.sessions) {
    const start = toTaipeiIso(s.startsAt);
    const where = (s.location || "").trim();
    if (!start || !where) continue;
    const end = toTaipeiIso(s.endsAt);
    const offers: JsonLd[] = s.plans.length
      ? s.plans.map((p) => ({
          "@type": "Offer",
          name: p.name,
          price: p.price,
          priceCurrency: "TWD",
          availability: availability(s.available && p.available),
          url: input.url,
        }))
      : input.basePrice != null
        ? [
            {
              "@type": "Offer",
              price: input.basePrice,
              priceCurrency: "TWD",
              availability: availability(s.available),
              url: input.url,
            },
          ]
        : [];
    out.push({
      "@context": "https://schema.org",
      "@type": "Event",
      name: input.name,
      description: input.description,
      url: input.url,
      ...(input.image ? { image: [absoluteUrl(input.image)] } : {}),
      startDate: start,
      ...(end ? { endDate: end } : {}),
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location: { "@type": "Place", name: where, address: where },
      organizer: {
        "@type": "Organization",
        "@id": ORG_ID,
        name: "小時光書店 Interval Books",
        url: `${SITE_ORIGIN}/`,
      },
      ...(input.performer ? { performer: { "@type": "Person", name: input.performer } } : {}),
      ...(offers.length ? { offers: offers.length === 1 ? offers[0] : offers } : {}),
    });
  }
  return out;
}

export type ProductLdInput = {
  name: string;
  description: string;
  url: string;
  image: string | null;
  sku: string;
  price: number;
  /** true = 買得到、false = 售完。 */
  inStock: boolean;
  isBook: boolean;
  category: string;
};

export function productLd(input: ProductLdInput): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": input.isBook ? ["Product", "Book"] : "Product",
    name: input.name,
    description: input.description,
    url: input.url,
    sku: input.sku,
    category: input.category,
    ...(input.image ? { image: [absoluteUrl(input.image)] } : {}),
    offers: {
      "@type": "Offer",
      price: input.price,
      priceCurrency: "TWD",
      availability: input.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      url: input.url,
      seller: { "@type": "Organization", "@id": ORG_ID, name: "小時光書店 Interval Books" },
    },
  };
}

// =============================================================================
// sitemap.xml
// =============================================================================

export type SitemapEntry = { path: string; lastmod?: string | null };

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** timestamptz → W3C datetime（sitemap 的 lastmod 格式）。不合法回 null。 */
export function toLastmod(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * 組 sitemap.xml。同一個網址出現多次時只留一筆、lastmod 取最新的那一個
 * （例：/events/kungtung 同時是活動列與策旅卡片指著的頁面）。
 */
export function sitemapXml(entries: SitemapEntry[]): string {
  const byLoc = new Map<string, string | null>();
  for (const e of entries) {
    const [pathOnly, query] = e.path.split("?");
    const loc = query
      ? `${SITE_ORIGIN}${canonicalPathname(pathOnly)}?${query}`
      : canonicalUrl(pathOnly);
    const lastmod = toLastmod(e.lastmod);
    const prev = byLoc.get(loc);
    if (prev === undefined || (lastmod && (!prev || lastmod > prev))) byLoc.set(loc, lastmod);
  }
  const urls = [...byLoc.entries()].map(
    ([loc, lastmod]) =>
      `  <url>\n    <loc>${xmlEscape(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}\n  </url>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
