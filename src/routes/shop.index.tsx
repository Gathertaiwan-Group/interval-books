/**
 * /shop —— 「選物」
 *
 * 2026-09-02 起這一頁是三合一的入口：導覽列上的「選物」一格，底下三個分頁。
 *
 *   商品        20 件，**可以結帳**            src/components/shop/ProductsPanel.tsx
 *   地方刊物    126 本，其中極少數連得到商品    src/components/shop/PublicationsPanel.tsx
 *   主理人的選品 3 主題 × 18 件，連了商品的才買得到  src/components/shop/CuratedPanel.tsx
 *
 * ⚠️ 三者刻意不合併成一份清單。curated_items 大多只有 name/note（0041 起可連商品），publications 有 126 筆
 *    但對得上商品的是 0 筆 —— 把買不到的 144 項跟 20 件商品排進同一個格狀清單，客人
 *    會以為那些都是商品。分頁的意義就是讓「這個能買、那個不能」看得出來。
 *
 * 2026-11（SEO 健檢 M4）：地方刊物有了自己的總覽頁 /publications（每一本也有 /publications/$slug）。
 * 分頁列的「地方刊物」那一格直接連過去；舊網址 /shop?tab=publications 照常顯示同一份清單，
 * 但 canonical 指向 /publications、不進 sitemap。不做 301 的理由見 src/routes/publications.index.tsx
 * 檔頭（舊的 /publications → 這裡的 301 存在訪客瀏覽器裡，反向再轉會變成迴圈）。
 *
 * 分頁狀態放在 ?tab= 而不是純 useState，因為 /publications 與 /curated 這兩個舊網址
 * 要轉址進「對應的分頁」—— 沒有網址就沒有可轉的目標。順帶讓分頁可以被分享、上一頁
 * 也回得去。loader 沒有宣告 loaderDeps，所以換分頁不會重跑任何一次讀取。
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { CuratedPanel } from "@/components/shop/CuratedPanel";
import { ProductsPanel } from "@/components/shop/ProductsPanel";
import { PublicationsPanel } from "@/components/shop/PublicationsPanel";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { eyebrowOf, fetchCuratedThemes, fetchPages, pageText } from "@/lib/cms";
import { imageFor } from "@/lib/images";
import { fitDescription, shopTabOf, type ShopIndexableTab } from "@/lib/seo/core";
import { pageHead } from "@/lib/seo/head";
import { pageRowTranslation } from "@/lib/seo/pages";
import { fetchPublicationsForList } from "@/lib/publications";
import { fetchActiveProductsForList } from "@/lib/shop";
import curatedImg from "@/assets/curated-objects.jpg";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "選物 Shop｜小時光書店",
    en: "Selection｜Interval Books",
    ja: "セレクト｜小時光書店",
  },
  metaDescription: {
    zh: "線上帶走一本台灣地方刊物，或屏東潮州的冷壓麻油、花生醬等地方好物：每一件都標上價格與剩餘數量。更多刊物與主理人的選品，歡迎到華山的店裡翻閱。",
    en: "Take home a local publication from Taiwan, or local goods like cold-pressed sesame oil and peanut butter from Chaozhou, Pingtung — each with price and stock left. More in our Huashan shop.",
    ja: "台湾の地域の刊行物や、屏東・潮州の低温圧搾ごま油、ピーナッツバターなど土地の品をオンラインで。価格と残り数を表示しています。そのほかは華山の店頭でどうぞ。",
  },
  eyebrowSuffix: { zh: "選物", en: "Selection", ja: "セレクト" },
  title: {
    zh: "把一段時光帶回家",
    en: "Take an interval home",
    ja: "ひとときを、持ち帰る",
  },
  intro: {
    zh: "線上可以帶走的，有台灣各地的地方刊物與選書，也有我們挑選的地方好物，例如屏東潮州的冷壓麻油與花生醬。更多刊物與主理人的選品，歡迎到店翻閱。",
    en: "Online you can take home local publications and books from around Taiwan, along with local goods we've chosen — like cold-pressed sesame oil and peanut butter from Chaozhou, Pingtung. For more titles and the owner's picks, come and browse in the shop.",
    ja: "オンラインでは、台湾各地の地域の刊行物や選書のほか、私たちが選んだ土地の品もお求めいただけます。たとえば屏東・潮州の低温圧搾ごま油やピーナッツバター。そのほかの刊行物や店主の選品は、ぜひ店頭で手に取ってご覧ください。",
  },
  // 2026-11-11：這個分頁也有地方好物（goods），不再只叫「書刊」；分頁內用「全部／地方好物／書籍」篩選。
  tabProducts: { zh: "書刊與好物", en: "Books & goods", ja: "本と土地の品" },
  tabPublications: { zh: "地方刊物", en: "Local Publications", ja: "地域の刊行物" },
  tabCurated: { zh: "主理人的選品", en: "Curated", ja: "店主の選品" },
  tabsLabel: { zh: "選物分頁", en: "Selection sections", ja: "セレクトの分類" },
  /**
   * `?tab=publications`／`?tab=curated` 的 title 與描述（2026-11 SEO 健檢 H3）。
   * 兩個分頁是不同的內容（126 本地方刊物、主理人的主題櫥窗），所以各自是一個可收錄的頁面，
   * canonical 指向自己（見 src/lib/seo/core.ts 的 canonicalUrl()）。pages 表有對應的列時
   * （'publications'／'curated'）以後台的為準，這裡是退路。
   */
  publicationsMetaTitle: {
    zh: "地方刊物 Local Publications｜小時光書店",
    en: "Local Publications｜Interval Books",
    ja: "地域の刊行物｜小時光書店",
  },
  publicationsMetaDescription: {
    zh: "一個地方，怎麼被自己的人寫下來：從基隆的漁村到花蓮的溪流，台灣各地的地方刊物依地區排在同一張桌上。每一本附上製作單位與集數，部分可線上購買，其餘歡迎到店翻閱。",
    en: "How a place is written by its own people: local magazines from across Taiwan, from Keelung's fishing villages to Hualien's rivers. Some can be bought online.",
    ja: "土地が、そこに暮らす人の手で書き残される。基隆の漁村から花蓮の川まで、台湾各地の地域誌を地域別に紹介。発行元と号数つきで、一部はオンラインでも購入できます。",
  },
  curatedMetaTitle: {
    zh: "主理人的選品 Curated｜小時光書店",
    en: "The Owner's Curated Window｜Interval Books",
    ja: "店主の選品｜小時光書店",
  },
  curatedMetaDescription: {
    zh: "主理人從台灣各地帶回的器物、茶與風土小物，陸續整理中。歡迎到店看看或來信詢問。",
    en: "Vessels, tea and small things of place the owner has brought back from around Taiwan — still being sorted. Come by the shop or write to us.",
    ja: "店主が台湾各地から持ち帰った器や茶、土地の小さなもの。ただいま整理中です。店頭でご覧いただくか、メールでお問い合わせください。",
  },
};

/** 依目前分頁挑一個值（商品分頁＝/shop 本身）。 */
function byTab<T>(tab: ShopIndexableTab | null, products: T, publications: T, curated: T): T {
  return tab === "publications" ? publications : tab === "curated" ? curated : products;
}

export const SHOP_TABS = ["products", "publications", "curated"] as const;
export type ShopTab = (typeof SHOP_TABS)[number];

/**
 * `tab` 刻意是 optional：站內已經有五處 `<Link to="/shop">` 不帶 search（購物車、
 * 結帳完成、商品內頁的返回）。把它做成必填會讓那五處的型別直接壞掉，而它們想去的
 * 本來就是預設分頁。
 */
function parseTab(value: unknown): ShopTab | undefined {
  return SHOP_TABS.includes(value as ShopTab) ? (value as ShopTab) : undefined;
}

export const Route = createFileRoute("/shop/")({
  validateSearch: (search: Record<string, unknown>): { tab?: ShopTab } => {
    const tab = parseTab(search.tab);
    return tab ? { tab } : {};
  },
  loader: async () => {
    // 三個分頁的內容一次讀完。換分頁只是換 search param，不重跑 loader，
    // 所以這裡讀的東西不會在每次點擊時重來一遍。
    //
    // 2026-09 前台載入速度優化，這裡改了兩件事：
    //
    //   1. 頁面文案原本是三次 fetchPage() 各自打三個查詢（九次網路往返），改成
    //      一次 fetchPages()——三個查詢，各用 slug IN (shop, publications,
    //      curated) 一次問三頁。見 src/lib/cms.ts#fetchPages 檔頭，失敗語意
    //      （單一 slug 讀壞只影響那個 slug）與原本逐一呼叫 fetchPage() 一致。
    //
    //   2. 商品目錄原本讀兩次：fetchActiveProducts()（商品分頁的完整清單）之後
    //      再 fetchActiveProductsByIds()（地方刊物分頁核對可購買狀態）。但後者
    //      的 id 集合必然是前者的子集——兩邊都只挑 status='active'，後者只是多
    //      加一個 id IN (...)——所以那是同一份資料被查兩次、序列化兩次（含完整
    //      三語 description）。改成 fetchActiveProductsForList()：只查一次、不含
    //      description（列表頁沒有一處會印出它，見 ProductsPanel/
    //      PublicationsPanel），兩個分頁共用同一份 catalogue。見
    //      src/lib/shop.ts#fetchActiveProductsForList 檔頭，含實測的 SSR payload
    //      大小數字。
    //
    //   3. 刊物清單原本用 fetchPublications()，126 筆每筆都帶完整三語 intro——
    //      量到光是這一份就佔了頁面 ~330KB 裡的 ~227KB，而 intro 只有點開某一本
    //      的「刊物介紹」才會顯示，預設全部收合。改成 fetchPublicationsForList()
    //      （不含 intro/externalUrl），點開哪一本才現查那一本——見
    //      src/lib/publications.ts#fetchPublicationDetail 與
    //      src/components/shop/PublicationsPanel.tsx。
    const [pages, catalogue, publications, curatedThemes] = await Promise.all([
      fetchPages(["shop", "publications", "curated"]),
      fetchActiveProductsForList(),
      fetchPublicationsForList(),
      fetchCuratedThemes(),
    ]);
    return {
      page: pages.shop,
      publicationsPage: pages.publications,
      curatedPage: pages.curated,
      catalogue,
      publications,
      curatedThemes,
    };
  },
  head: ({ loaderData, matches, match }) => {
    const tab = shopTabOf(match.search);
    const p = pageText(loaderData?.page ?? null);
    const pub = pageText(loaderData?.publicationsPage ?? null);
    const cur = pageText(loaderData?.curatedPage ?? null);
    const ogImg = imageFor(loaderData?.page?.ogImageKey, curatedImg);
    return {
      ...pageHead(
        { matches, match },
        {
          translation: pageRowTranslation(
            tab === "publications"
              ? (loaderData?.publicationsPage ?? null)
              : tab === "curated"
                ? (loaderData?.curatedPage ?? null)
                : (loaderData?.page ?? null),
          ),
          title: byTab(
            tab,
            p.metaTitle(PAGE.metaTitle),
            pub.metaTitle(PAGE.publicationsMetaTitle),
            cur.metaTitle(PAGE.curatedMetaTitle),
          ),
          description: fitDescription(
            byTab(
              tab,
              p.metaDescription(PAGE.metaDescription),
              pub.metaDescription(PAGE.publicationsMetaDescription),
              cur.metaDescription(PAGE.curatedMetaDescription),
            ),
          ),
          image: ogImg,
          type: "website",
          // ?tab=publications 是舊網址：內容與 /publications 相同，canonical 收斂到那裡。
          canonicalPath: tab === "publications" ? "/publications" : undefined,
        },
      ),
    };
  },
  component: Shop,
});

function Shop() {
  const t = useT();
  const { page, publicationsPage, curatedPage, catalogue, publications, curatedThemes } =
    Route.useLoaderData();
  const { tab } = Route.useSearch();
  const active: ShopTab = tab ?? "products";
  const p = pageText(page);
  const heroSrc = imageFor(page?.ogImageKey, curatedImg);

  const seoTab = shopTabOf({ tab });
  const pubText = pageText(publicationsPage);
  const curText = pageText(curatedPage);
  useDocumentMeta({
    title: byTab(
      seoTab,
      p.metaTitle(PAGE.metaTitle),
      pubText.metaTitle(PAGE.publicationsMetaTitle),
      curText.metaTitle(PAGE.curatedMetaTitle),
    ),
    description: fitDescription(
      byTab(
        seoTab,
        p.metaDescription(PAGE.metaDescription),
        pubText.metaDescription(PAGE.publicationsMetaDescription),
        curText.metaDescription(PAGE.curatedMetaDescription),
      ),
    ),
    ogImage: heroSrc,
  });

  const tabs = [
    { key: "products" as const, label: t(p.block("tabs.products", PAGE.tabProducts)) },
    { key: "publications" as const, label: t(p.block("tabs.publications", PAGE.tabPublications)) },
    { key: "curated" as const, label: t(p.block("tabs.curated", PAGE.tabCurated)) },
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Shop", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
        compact
      />

      <nav
        className="container-editorial pb-4 md:pb-12 flex flex-wrap gap-x-8 gap-y-3 border-b border-border/60 text-sm"
        data-testid="shop-tabs"
        aria-label={t(p.block("tabs.label", PAGE.tabsLabel))}
      >
        {tabs.map((tabItem) => {
          const className = `-mb-px border-b-2 pt-3 pb-3 md:pt-0 transition-colors ${
            active === tabItem.key
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`;
          // 地方刊物：連到它自己的總覽頁（canonical），不是 ?tab=publications。
          return tabItem.key === "publications" ? (
            <Link
              key={tabItem.key}
              to="/publications"
              data-testid={`shop-tab-${tabItem.key}`}
              aria-current={active === tabItem.key ? "page" : undefined}
              className={className}
            >
              {tabItem.label}
            </Link>
          ) : (
            <Link
              key={tabItem.key}
              to="/shop"
              search={{ tab: tabItem.key }}
              data-testid={`shop-tab-${tabItem.key}`}
              aria-current={active === tabItem.key ? "page" : undefined}
              className={className}
            >
              {tabItem.label}
            </Link>
          );
        })}
      </nav>

      <div className="pt-6 md:pt-12" data-testid={`shop-panel-${active}`}>
        {active === "publications" ? (
          <PublicationsPanel page={publicationsPage} list={publications} catalogue={catalogue} />
        ) : active === "curated" ? (
          <CuratedPanel page={curatedPage} curatedThemes={curatedThemes} catalogue={catalogue} />
        ) : (
          <ProductsPanel
            page={page}
            catalogue={catalogue}
            publications={publications}
            curatedThemes={curatedThemes}
            heroAlt={t(p.title(PAGE.title))}
          />
        )}
      </div>
    </PageShell>
  );
}
