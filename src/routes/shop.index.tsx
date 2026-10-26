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
import { fetchPublicationsForList } from "@/lib/publications";
import { fetchActiveProductsForList } from "@/lib/shop";
import curatedImg from "@/assets/curated-objects.jpg";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "選物 Shop｜小時光書店 Interval Books",
    en: "Selection｜Interval Books",
    ja: "セレクト｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "書籍、選物、活動與策旅名額，都可以在這裡直接選購；地方刊物展與主理人的選品也在同一頁。",
    en: "Books, curated objects, event tickets and journey places — plus the local-publications show and the owner's curated window, all under one roof.",
    ja: "書籍、セレクト品、イベントや旅の参加枠に加え、地域の刊行物展と店主の選品も同じページに。",
  },
  eyebrowSuffix: { zh: "選物", en: "Selection", ja: "セレクト" },
  title: {
    zh: "把一段時光帶回家",
    en: "Take an interval home",
    ja: "ひとときを、持ち帰る",
  },
  intro: {
    zh: "書、器物、茶、活動與策旅名額。清單很短，因為每一件都得先通過我們自己的日常。",
    en: "Books, vessels, tea, events and journey places. The list is short because everything on it first had to survive our own daily use.",
    ja: "本、器、茶、イベントと旅の枠。並ぶ数は多くありません。まず私たち自身の日常を通ったものだけを置いているからです。",
  },
  tabProducts: { zh: "商品", en: "Shop", ja: "商品" },
  tabPublications: { zh: "地方刊物", en: "Local Publications", ja: "地域の刊行物" },
  tabCurated: { zh: "主理人的選品", en: "Curated", ja: "店主の選品" },
  tabsLabel: { zh: "選物分頁", en: "Selection sections", ja: "セレクトの分類" },
};

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
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    const ogImg = imageFor(loaderData?.page?.ogImageKey, curatedImg);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:image", content: ogImg },
        { name: "twitter:image", content: ogImg },
      ],
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

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
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
      />

      <nav
        className="container-editorial pb-12 flex flex-wrap gap-x-8 gap-y-3 border-b border-border/60 text-sm"
        data-testid="shop-tabs"
        aria-label={t(p.block("tabs.label", PAGE.tabsLabel))}
      >
        {tabs.map((tabItem) => (
          <Link
            key={tabItem.key}
            to="/shop"
            search={{ tab: tabItem.key }}
            data-testid={`shop-tab-${tabItem.key}`}
            aria-current={active === tabItem.key ? "page" : undefined}
            className={`-mb-px border-b-2 pb-3 transition-colors ${
              active === tabItem.key
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tabItem.label}
          </Link>
        ))}
      </nav>

      <div className="pt-12" data-testid={`shop-panel-${active}`}>
        {active === "publications" ? (
          <PublicationsPanel page={publicationsPage} list={publications} catalogue={catalogue} />
        ) : active === "curated" ? (
          <CuratedPanel page={curatedPage} curatedThemes={curatedThemes} catalogue={catalogue} />
        ) : (
          <ProductsPanel page={page} catalogue={catalogue} heroAlt={t(p.title(PAGE.title))} />
        )}
      </div>
    </PageShell>
  );
}
