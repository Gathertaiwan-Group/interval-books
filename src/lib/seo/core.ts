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
import type { Lang, Localized } from "../../i18n/types";
import { HREFLANG as HREFLANG_CODES, isLocalizablePath, localizeHref, SITE_LANGS } from "./i18n.ts";

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

  // 語言前綴（/en、/ja；大小寫不分）：前綴轉小寫、後面照中文的規則正規化。
  // 剝掉前綴之後是私密路徑（/en/admin）→ 那不是一條有頁面的網址，只做上面兩件事。
  const prefix = /^\/(en|ja)(?=\/|$)/i.exec(p);
  if (prefix) {
    const rest = canonicalPathname(p.slice(prefix[0].length) || "/");
    if (isLocalizablePath(rest)) {
      const lang = prefix[1].toLowerCase();
      return rest === "/" ? `/${lang}` : `/${lang}${rest}`;
    }
    return p;
  }

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
export function canonicalUrl(pathname: string, search?: unknown, lang: Lang = "zh"): string {
  const path = canonicalPathname(pathname);
  if (path === "/shop") {
    const tab = shopTabOf(search);
    if (tab) return `${SITE_ORIGIN}${localizeHref(`/shop?tab=${tab}`, lang)}`;
  }
  const localized = localizeHref(path, lang);
  return localized === "/" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${localized}`;
}

/**
 * hreflang 用的一組網址（2026-11 /en /ja）：每個可收錄的語言一筆，外加 x-default 指向中文。
 * pathname 是**不含前綴**的路徑；langs 只放可收錄的語言（見 i18n.ts 的 isLangIndexable）。
 */
export function alternateUrls(
  pathname: string,
  search: unknown,
  langs: readonly Lang[],
): Array<{ lang: Lang | "x-default"; href: string }> {
  const out: Array<{ lang: Lang | "x-default"; href: string }> = SITE_LANGS.filter((l) =>
    langs.includes(l),
  ).map((l) => ({ lang: l, href: canonicalUrl(pathname, search, l) }));
  if (langs.includes("zh")) out.push({ lang: "x-default", href: canonicalUrl(pathname, search) });
  return out;
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

/**
 * 活動／商品代稱的「不分大小寫」查找（2026-11 SEO 驗收 #5）。
 *
 * 代稱本身就可能有大寫（InntervalChishang.1023），所以不能一律轉小寫——要先拿
 * 網址上的代稱不分大小寫去資料庫找，找到**剛好一筆**、而且大小寫跟網址不同，
 * 才 301 到資料庫裡的正確寫法。路由的 loader 在「查無此代稱」時才走這一步。
 *
 * PostgREST 的 ilike：`%` `_` 是 LIKE 萬用字元、`*` 也會被 PostgREST 換成 `%`。
 * 前兩個用反斜線跳脫；含 `*` 的代稱直接不查（真的代稱不會有 `*`）。
 */
export function exactIlikePattern(slug: string): string | null {
  if (!slug || slug.includes("*")) return null;
  return slug.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 候選代稱裡，跟網址只差大小寫的那一個（剛好一個才算）。完全相同或找不到 → null。 */
export function caseInsensitiveMatch(requested: string, candidates: string[]): string | null {
  const lower = requested.toLowerCase();
  const hits = [...new Set(candidates)].filter((c) => c.toLowerCase() === lower);
  if (hits.length !== 1 || hits[0] === requested) return null;
  return hits[0];
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
  // /en/checkout 這種（私密頁不加前綴）本來就是 404；仍照前綴後面那段判斷，回應一律帶 noindex。
  const p =
    canonicalPathname(pathname)
      .toLowerCase()
      .replace(/^\/(en|ja)(?=\/|$)/, "") || "/";
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

/**
 * 結構化資料（JSON-LD）用的店名。2026-11 起品牌統一為「小時光風土誌書店」；舊名「小時光書店」
 * 是 Google 商家檔案上的名稱，放在 alternateName 讓搜尋引擎對得起來。不讀 site_settings 的
 * meta_site_name（那是 og:site_name 用的顯示字串，後台可改）。
 */
export const STORE_NAME = "小時光風土誌書店";
export const STORE_ALTERNATE_NAMES = ["小時光書店", "Interval Books"];

export const BRAND = {
  zh: "小時光風土誌書店",
  en: "Interval Books",
  ja: "小時光 風土誌書店",
} as const satisfies Localized;

/**
 * 站名標語——描述太短時補在後面用。內容全部是站上已經寫著的事實：地址（/about、
 * 頁尾）、風土誌（首頁 title）、地方刊物（/shop 分頁）、讀書會／講座／工作坊與策旅
 * （首頁入口與 /journeys）。
 */
export const SITE_BLURB: Localized = {
  zh: "小時光風土誌書店位於台北華山文創園區紅磚六合院西7-3館，以土地為線索選書，展售地方刊物與選物，也舉辦讀書會、講座、工作坊與策旅。",
  en: "Interval Books is a terroir-minded bookstore in the Red Brick Courtyard (West 7-3) of Huashan 1914 Creative Park, Taipei — books, local publications, curated objects, reading circles, talks, workshops and journeys.",
  ja: "小時光 風土誌書店は台北・華山1914文化創意産業園区 紅煉瓦六合院 西7-3館にある、土地を手がかりに本を選ぶ書店。選書、地域の刊行物、セレクト品のほか、読書会・トーク・ワークショップ・旅も企画しています。",
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
 * 三語 title 模板：「{名稱}｜{其他段落}｜小時光風土誌書店」（英文版品牌是 Interval Books）。
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
    name: STORE_NAME,
    alternateName: STORE_ALTERNATE_NAMES,
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
    name: STORE_NAME,
    alternateName: STORE_ALTERNATE_NAMES,
    url: `${SITE_ORIGIN}/`,
    // 2026-11 起有 /en、/ja 版本（src/lib/seo/i18n.ts）。
    inLanguage: ["zh-Hant-TW", "en", "ja"],
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
    name: STORE_NAME,
    alternateName: STORE_ALTERNATE_NAMES,
    url: `${SITE_ORIGIN}/`,
    image: absoluteUrl(imageUrl),
    logo: absoluteUrl(logoUrl),
    description: facts.site.shortDesc.zh,
    parentOrganization: { "@id": ORG_ID },
    address: storePostalAddress({ address: facts.site.address.zh, city: facts.site.city.zh }),
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
  /** event_sessions.id —— 多場次時拿來組 `@id`（`<url>#session-<id>`）。 */
  id: string;
  location: string;
  startsAt: string;
  endsAt: string | null;
  /** 這一場還有沒有位子（remainingForSession() > 0）。 */
  available: boolean;
  /** 票種（0036）。空陣列 = 沒有票種，價格用 basePrice。 */
  plans: { name: string; price: number; available: boolean }[];
};

/** 書店自己的地址（site_settings.address／city 的中文，頁尾與 /about 印的那一份）。 */
export type StoreAddress = { address: string; city: string };

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
  /**
   * 最後一個場次已經結束（呼叫端用 src/lib/event-status.ts 的 isEventEnded() 算，
   * 與 /events「已結束」分頁同一條規則）。true → 每個 Offer 都標 SoldOut。
   */
  ended?: boolean;
  /** 書店地址；場次在書店辦時拿來組 PostalAddress。null → 只輸出 addressCountry。 */
  store?: StoreAddress | null;
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
 * 場次的日期標籤（台北）：同一天「2026.09.05」、跨日「2026.10.23–10.25」、跨年寫全。
 * 多場次活動拿來接在 Event.name 後面，讓每一場的名稱不一樣。
 */
export function sessionDateLabel(startsAt: string, endsAt: string | null): string | null {
  const s = toTaipeiIso(startsAt);
  if (!s) return null;
  const e = toTaipeiIso(endsAt);
  const [sy, sm, sd] = s.slice(0, 10).split("-");
  const startLabel = `${sy}.${sm}.${sd}`;
  if (!e || e.slice(0, 10) === s.slice(0, 10)) return startLabel;
  const [ey, em, ed] = e.slice(0, 10).split("-");
  return ey === sy ? `${startLabel}–${em}.${ed}` : `${startLabel}–${ey}.${em}.${ed}`;
}

// ── 地址 ─────────────────────────────────────────────────────────────────────
/**
 * 台灣 22 個縣市，以及在場次地點文字裡認得出它的寫法。「新竹」「嘉義」市縣同名，
 * 只認寫全的（新竹市／新竹縣）——光寫「新竹」判不出是哪一個，就不輸出。
 * 輸出用站上慣用的「台」字（頁尾印的是「台北市中正區」）。
 */
const TW_REGIONS: Array<[string, string[]]> = [
  ["台北市", ["台北", "臺北"]],
  ["新北市", ["新北"]],
  ["桃園市", ["桃園"]],
  ["台中市", ["台中", "臺中"]],
  ["台南市", ["台南", "臺南"]],
  ["高雄市", ["高雄"]],
  ["基隆市", ["基隆"]],
  ["新竹市", ["新竹市"]],
  ["新竹縣", ["新竹縣"]],
  ["嘉義市", ["嘉義市"]],
  ["嘉義縣", ["嘉義縣"]],
  ["苗栗縣", ["苗栗"]],
  ["彰化縣", ["彰化"]],
  ["南投縣", ["南投"]],
  ["雲林縣", ["雲林"]],
  ["屏東縣", ["屏東"]],
  ["宜蘭縣", ["宜蘭"]],
  ["花蓮縣", ["花蓮"]],
  ["台東縣", ["台東", "臺東"]],
  ["澎湖縣", ["澎湖"]],
  ["金門縣", ["金門"]],
  ["連江縣", ["連江"]],
];

/** 地點文字裡提到的縣市。沒提到或提到兩個以上（判不出是哪裡）→ null。 */
export function regionOf(text: string): string | null {
  const hits = TW_REGIONS.filter(([, aliases]) => aliases.some((a) => text.includes(a))).map(
    ([name]) => name,
  );
  return hits.length === 1 ? hits[0] : null;
}

/** 「台北市中正區」→ { region: "台北市", locality: "中正區" }。拆不開就整串當 locality。 */
function splitCity(city: string): { region: string | null; locality: string | null } {
  const c = city.trim();
  if (!c) return { region: null, locality: null };
  const m = /^(.{2}[市縣])(.{1,4}[區鄉鎮市])$/.exec(c);
  if (m) return { region: m[1].replace(/^臺/, "台"), locality: m[2] };
  return { region: regionOf(c), locality: c };
}

/** 書店的 PostalAddress：全部欄位都來自 site_settings，沒有的欄位（郵遞區號）不輸出。 */
export function storePostalAddress(store: StoreAddress): JsonLd {
  const { region, locality } = splitCity(store.city);
  const street = store.address.trim();
  return {
    "@type": "PostalAddress",
    ...(street ? { streetAddress: street } : {}),
    ...(locality ? { addressLocality: locality } : {}),
    ...(region ? { addressRegion: region } : {}),
    addressCountry: "TW",
  };
}

/** 場次地點是不是書店本身（後台填的是「華山小時光風土誌書店…」「小時光書店（華山…）」）。 */
export function isStoreLocation(location: string): boolean {
  return /小時光|Interval Books/i.test(location);
}

/**
 * 場次地點 → PostalAddress。
 *
 *   · 在書店辦：用 site_settings 的地址（streetAddress／addressLocality／addressRegion）。
 *   · 店外（例：台東池上）：只輸出文字裡**明寫**的縣市（addressRegion）＋ addressCountry。
 *     鄉鎮只有在「<縣市><鄉鎮區>」寫全的時候才輸出。
 *
 * 🔴 不編造郵遞區號、門牌、路名：資料庫沒有拆好的欄位就不輸出。
 */
export function postalAddressFor(location: string, store: StoreAddress | null): JsonLd {
  if (store && isStoreLocation(location)) return storePostalAddress(store);
  const region = regionOf(location);
  let locality: string | null = null;
  const aliases = TW_REGIONS.find(([name]) => name === region)?.[1] ?? [];
  for (const alias of aliases) {
    const base = alias.replace(/[市縣]$/, "");
    const m = new RegExp(`${base}[市縣]([\\u4e00-\\u9fff]{1,3}?[區鄉鎮市])`).exec(location);
    if (m) {
      locality = m[1];
      break;
    }
  }
  return {
    "@type": "PostalAddress",
    ...(locality ? { addressLocality: locality } : {}),
    ...(region ? { addressRegion: region } : {}),
    addressCountry: "TW",
  };
}

/**
 * 一個場次一個 Event。資料全部來自售票商品（products → event_sessions →
 * event_session_plans）：日期、地點、價格、名額。
 *
 *   - 多場次（2026-11 驗收 #1）：Google 的活動複合式搜尋結果**不讀 subEvent**，它的
 *     規範是「每一場各標一個 Event」。所以維持一場一個 Event，但 name 接上場次日期、
 *     `@id` 用 `<url>#session-<場次 id>` 區分，不再出現兩個同名同網址的 Event。
 *     單一場次的活動 name 不加日期（沒有要區分的對象），`@id` 一樣帶場次 id。
 *   - eventStatus：站上沒有「取消／延期」的狀態欄位，一律 EventScheduled——**活動結束
 *     之後也不改**（Google 規範：已結束的活動不更動 eventStatus）。
 *   - 已結束（input.ended）：每個 Offer 標 SoldOut。不用 Discontinued：Google 活動
 *     結構化資料的 offers.availability 只認 InStock／SoldOut／PreOrder，Discontinued
 *     不在清單裡，可能被當成無效值；SoldOut 的意思「這裡已經買不到」也正是現況。
 *   - eventAttendanceMode：站上沒有線上場次的欄位，所有活動都是實體（Offline）。
 *   - 地點：Place.name 是場次的 location 文字，address 是 PostalAddress（postalAddressFor）。
 */
export function eventLd(input: EventLdInput): JsonLd[] {
  const out: JsonLd[] = [];
  const availability = (ok: boolean) =>
    ok && !input.ended ? "https://schema.org/InStock" : "https://schema.org/SoldOut";
  const usable = input.sessions.filter((s) => toTaipeiIso(s.startsAt) && (s.location || "").trim());
  const many = usable.length > 1;
  for (const s of usable) {
    const start = toTaipeiIso(s.startsAt) as string;
    const where = s.location.trim();
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
    const dateLabel = many ? sessionDateLabel(s.startsAt, s.endsAt) : null;
    out.push({
      "@context": "https://schema.org",
      "@type": "Event",
      ...(s.id ? { "@id": `${input.url}#session-${s.id}` } : {}),
      name: dateLabel ? `${input.name}｜${dateLabel}` : input.name,
      description: input.description,
      url: input.url,
      ...(input.image ? { image: [absoluteUrl(input.image)] } : {}),
      startDate: start,
      ...(end ? { endDate: end } : {}),
      eventStatus: "https://schema.org/EventScheduled",
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location: {
        "@type": "Place",
        name: where,
        address: postalAddressFor(where, input.store ?? null),
      },
      organizer: {
        "@type": "Organization",
        "@id": ORG_ID,
        name: STORE_NAME,
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
      seller: { "@type": "Organization", "@id": ORG_ID, name: STORE_NAME },
    },
  };
}

// =============================================================================
// sitemap.xml
// =============================================================================

/**
 * sitemap 的一筆。path 是**不含語言前綴**的路徑；langs 是這一頁可以被收錄的語言
 * （i18n.ts 的 indexableLangs()），沒給 = 只有中文。
 */
export type SitemapEntry = { path: string; lastmod?: string | null; langs?: readonly Lang[] };

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
 * （例：/events/kungtung 同時是活動列與策旅卡片指著的頁面），可收錄的語言取交集。
 *
 * 多語（2026-11 /en /ja）：照 Google「在 sitemap 標示替代語言版本」的做法——**每一個語言版本
 * 各列一筆 <url>**，而且每一筆都用 `xhtml:link rel="alternate"` 列出全部語言版本（含自己）
 * 與 x-default。兩件事要一起做才算完整（Google 要求每個版本的 <url> 都列出全部替代版本），
 * 也讓 Search Console 的涵蓋範圍報表能逐一看到英日文網址。noindex 的語言版本不在 langs 裡，
 * 所以既不會有自己的 <url>，也不會出現在別人的 xhtml:link。
 */
export function sitemapXml(entries: SitemapEntry[]): string {
  const byPath = new Map<
    string,
    { path: string; query: string | undefined; lastmod: string | null; langs: Lang[] }
  >();
  for (const e of entries) {
    const [pathOnly, query] = e.path.split("?");
    const path = canonicalPathname(pathOnly);
    const key = query ? `${path}?${query}` : path;
    const lastmod = toLastmod(e.lastmod);
    const langs: Lang[] = SITE_LANGS.filter((l) => l === "zh" || (e.langs ?? []).includes(l));
    const prev = byPath.get(key);
    if (!prev) {
      byPath.set(key, { path, query, lastmod, langs });
      continue;
    }
    if (lastmod && (!prev.lastmod || lastmod > prev.lastmod)) prev.lastmod = lastmod;
    prev.langs = prev.langs.filter((l) => langs.includes(l));
  }
  const locOf = (path: string, query: string | undefined, lang: Lang) =>
    `${SITE_ORIGIN}${localizeHref(query ? `${path}?${query}` : path, lang)}`;
  const urls: string[] = [];
  for (const { path, query, lastmod, langs } of byPath.values()) {
    const alternates =
      langs.length > 1
        ? [
            ...langs.map(
              (l) =>
                `\n    <xhtml:link rel="alternate" hreflang="${HREFLANG_CODES[l]}" href="${xmlEscape(locOf(path, query, l))}"/>`,
            ),
            `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${xmlEscape(locOf(path, query, "zh"))}"/>`,
          ].join("")
        : "";
    for (const lang of langs) {
      urls.push(
        `  <url>\n    <loc>${xmlEscape(locOf(path, query, lang))}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}${alternates}\n  </url>`,
      );
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}
