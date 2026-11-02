/**
 * /publications —— 地方刊物總覽（2026-11 SEO 健檢 M4）。
 *
 * 歷史：2026-09-02 導覽列從九格收成五格，這個網址改成 301 到 /shop?tab=publications。
 * 2026-11 起每一本刊物有自己的頁面（/publications/$slug），這裡回到真正的總覽頁：
 * 台灣／日本＋地區篩選，126 張卡片全部在 SSR 輸出，每一張都連到那一本自己的頁。
 *
 * ── 跟 /shop?tab=publications 的關係 ──────────────────────────────────────────
 * 那個分頁網址**保留、照常顯示同一份清單**，但 canonical 指向這裡、不進 sitemap；
 * /shop 的分頁列「地方刊物」那一格直接連到這裡。
 *
 * 🔴 刻意**不**把 /shop?tab=publications 301 到這裡：舊版這個網址是 301 → /shop?tab=publications，
 *    瀏覽器會把 301 存起來。曾經來過的訪客點 /publications 時，瀏覽器直接跳去
 *    /shop?tab=publications——那一頁如果再 301 回來，就是一個轉址迴圈（ERR_TOO_MANY_REDIRECTS）。
 *    用 canonical 收斂，兩條網址都一定到得了內容。
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { PublicationsPanel } from "@/components/shop/PublicationsPanel";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { eyebrowOf, fetchPages, pageText } from "@/lib/cms";
import { imageFor } from "@/lib/images";
import { fetchPublicationsForList } from "@/lib/publications";
import { fitDescription } from "@/lib/seo/core";
import { langFromMatches, pageHead } from "@/lib/seo/head";
import { pageRowTranslation } from "@/lib/seo/pages";
import { PUBLICATIONS_LABEL, publicationsIndexLd } from "@/lib/seo/publication";
import { unavailableHeaders } from "@/lib/seo/status";
import { fetchActiveProductsForList } from "@/lib/shop";
import exhibitionImg from "@/assets/exhibition-corner.jpg";

/** 後備文案 —— pages/'publications' 那一列讀不到時才用（後台改的是那一列）。 */
const PAGE = {
  metaTitle: {
    zh: "地方刊物 Local Publications｜小時光風土誌書店",
    en: "Local Publications｜Interval Books",
    ja: "地域の刊行物｜小時光 風土誌書店",
  },
  metaDescription: {
    zh: "一個地方，怎麼被自己的人寫下來：從基隆的漁村到日本的山間小鎮，台灣與日本的地方刊物依地區排在同一張桌上。每一本附上製作單位與集數，部分可線上購買，其餘歡迎到店翻閱。",
    en: "How a place is written by its own people: local publications from Keelung's fishing villages to Japan's mountain towns, by region. Some can be bought online.",
    ja: "土地が、そこに暮らす人の手で書き残される。基隆の漁村から日本の山あいの町まで、台湾と日本の地域誌を地域別に紹介。発行元と号数つきで、一部はオンラインでも購入できます。",
  },
  title: {
    zh: "一個地方，怎麼被自己的人寫下來",
    en: "How a place gets written down by its own people",
    ja: "その土地の人が、その土地を書く",
  },
  intro: {
    zh: "從基隆的漁村到日本的山間小鎮，地方刊物擺在同一張桌子上。它們大多不是為了賣而做的，是為了留下來。",
    en: "From a fishing village in Keelung to a mountain town in Japan, local publications share one table. Most were not made to be sold — they were made to remain.",
    ja: "基隆の漁村から日本の山あいの町まで、地域の刊行物がひとつの机に並びます。その多くは売るためではなく、遺すためにつくられました。",
  },
  eyebrowSuffix: { zh: "地方刊物", en: "Taiwan & Japan", ja: "地域の刊行物" },
  home: { zh: "首頁", en: "Home", ja: "ホーム" },
  breadcrumb: { zh: "麵包屑", en: "Breadcrumb", ja: "パンくずリスト" },
};

export const Route = createFileRoute("/publications/")({
  loader: async () => {
    // 與 /shop 的〈地方刊物〉分頁同一組讀取：卡片欄位（不含 intro）＋商品清單（價格與庫存）。
    const [pages, catalogue, publications] = await Promise.all([
      fetchPages(["publications"]),
      fetchActiveProductsForList(),
      fetchPublicationsForList(),
    ]);
    return { page: pages.publications ?? null, catalogue, publications };
  },
  head: ({ loaderData, matches, match }) => {
    const pub = pageText(loaderData?.page ?? null);
    return pageHead(
      { matches, match },
      {
        translation: pageRowTranslation(loaderData?.page ?? null),
        title: pub.metaTitle(PAGE.metaTitle),
        description: fitDescription(pub.metaDescription(PAGE.metaDescription)),
        image: imageFor(loaderData?.page?.ogImageKey, exhibitionImg),
        type: "website",
        jsonLd: publicationsIndexLd(langFromMatches(matches)),
      },
    );
  },
  // 清單讀不到 → 503（不是 200 的空頁，也不是 404）。
  headers: ({ loaderData }) => unavailableHeaders(Boolean(loaderData?.publications.unavailable)),
  component: PublicationsIndex,
});

function PublicationsIndex() {
  const t = useT();
  const { page, catalogue, publications } = Route.useLoaderData();
  const p = pageText(page);
  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: fitDescription(p.metaDescription(PAGE.metaDescription)),
    ogImage: imageFor(page?.ogImageKey, exhibitionImg),
  });

  return (
    <PageShell>
      <nav
        aria-label={t(PAGE.breadcrumb)}
        className="container-editorial pt-10 md:pt-12 text-xs tracking-widest text-muted-foreground"
      >
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <li>
            <Link to="/" className="hover-underline hover:text-foreground">
              {t(PAGE.home)}
            </Link>
          </li>
          <li aria-hidden="true">›</li>
          <li aria-current="page" className="text-foreground">
            {t(PUBLICATIONS_LABEL)}
          </li>
        </ol>
      </nav>
      <PageHeader
        eyebrow={eyebrowOf(page, "Local Publications", t(PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />
      <PublicationsPanel page={page} list={publications} catalogue={catalogue} showIntro={false} />
    </PageShell>
  );
}
