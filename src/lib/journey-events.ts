/**
 * 哪些 events 列其實是「策旅」——它們不該出現在 /events 列表與首頁「精選活動」。
 *
 * ── 背景 ──────────────────────────────────────────────────────────────────
 * 一趟策旅在資料上是**兩列**：events 那一列負責內頁、報名與收錢（CLAUDE.md 最上面
 * 那條規則：報名一律走活動那一套），journeys 那一列只是 /journeys 上的一張卡片，
 * 用 journeys.external_url 連到那場活動。所以 events 表本身分不出「這是活動還是策旅」。
 * 2026-10-20 店長回報 /events 列出了「2026 台東池上秋收山海旅行」—— 就是這個原因。
 *
 * ── 判準：「有一張策旅卡片指著它」，不是分類 ────────────────────────────────
 *   1. journeys.external_url 是站內路徑 `/events/<slug>`（或本站完整網址）→ 那個 slug
 *      的活動就是策旅。正式庫現有的策旅、一頁新增（journey 模式、站內報名）都是這樣接的。
 *   2. 外部連結報名的策旅：一頁新增會把**同一個外部網址**同時寫進活動的 external_url
 *      與卡片的 external_url（見 buildQuickCreatePlan / buildJourneyCard），所以兩邊
 *      網址相同也算。
 *
 *   **不用分類判斷**：分類是後台人手選的（一頁新增的策旅模式也要求選一個分類），
 *   「策旅說明會」這個分類也可能真的是一場在店裡辦的說明會。用卡片連結判斷，
 *   後台把策旅卡片刪掉／改連結，那場活動就自然回到 /events —— 單一真相來源。
 *
 * ⚠️ 只看得到**已發布**的策旅卡片（journeys 的 RLS 只讓 anon 讀 is_published）。
 *    卡片下架、活動仍發布時，那場活動會回到 /events 列表 —— 這是刻意的：它此時
 *    不在 /journeys 上，從列表也拿掉的話就沒有任何入口了。
 *
 * /events/<slug> 詳情頁**不**經過這裡：策旅的報名與付款就在那一頁。
 */

const SITE_HOSTS = new Set(["intervalbooks.tw", "www.intervalbooks.tw"]);

/** `/events/<slug>`（或本站完整網址）→ slug；其他（外部網址、空字串、/events 本身）→ null。 */
export function eventSlugFromJourneyUrl(url: string | null | undefined): string | null {
  let path = (url ?? "").trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      if (!SITE_HOSTS.has(u.hostname.toLowerCase())) return null;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  path = path.split(/[?#]/)[0].replace(/\/+$/, "");
  if (!path.startsWith("/events/")) return null;
  const raw = path.slice("/events/".length);
  if (!raw || raw.includes("/")) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 比對外部網址用：去頭尾空白、去結尾斜線。空字串回 null（空對空不算相同）。 */
function normalizeExternal(url: string | null | undefined): string | null {
  const s = (url ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(s) ? s : null;
}

export type JourneyEventMatcher = (event: { slug: string; externalUrl?: string | null }) => boolean;

/** 由所有（已發布）策旅卡片的 external_url 建一個判斷函式。 */
export function journeyEventMatcher(journeyUrls: ReadonlyArray<string | null | undefined>) {
  const slugs = new Set<string>();
  const externals = new Set<string>();
  for (const url of journeyUrls) {
    const slug = eventSlugFromJourneyUrl(url);
    if (slug) slugs.add(slug);
    const ext = normalizeExternal(url);
    if (ext && !slug) externals.add(ext);
  }
  const matcher: JourneyEventMatcher = (event) => {
    if (slugs.has(event.slug)) return true;
    const ext = normalizeExternal(event.externalUrl);
    return ext !== null && externals.has(ext);
  };
  return matcher;
}

/** 把策旅那幾場從活動清單拿掉。順序不變。 */
export function excludeJourneyEvents<T extends { slug: string; externalUrl?: string | null }>(
  events: T[],
  journeyUrls: ReadonlyArray<string | null | undefined>,
): T[] {
  const isJourney = journeyEventMatcher(journeyUrls);
  return events.filter((e) => !isJourney(e));
}
