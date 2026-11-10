/**
 * /publications/$slug —— 一本地方刊物自己的頁面（2026-11 SEO 健檢 M4）。
 *
 * 封面、刊名、出版者、地區、期數、完整介紹全部在 SSR 輸出（loader 讀 publications 那一列）。
 * 有對應商品（publications.product_id → 上架中的商品）→「購買這本」連到 /shop/pub-*，
 * 顯示價格；沒有 → 「歡迎到店翻閱」＋地址、營業時間與來訪資訊連結。
 *
 * canonical 與重複內容：這一頁是刊物的**內容主頁**，自我 canonical；/shop/pub-* 的商品
 * 說明與這裡的介紹逐字相同，所以商品頁的 canonical 指向這裡（決策見 src/lib/seo/publication.ts）。
 *
 * 快取：/publications* 在 src/server/cache-policy.ts 的白名單裡（s-maxage=60、swr=600），
 * 200 才進 CDN；404／503 不快取。
 */
import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { PageShell } from "@/components/PageShell";
import { PriceTag, StockBadge } from "@/components/shop/ShopBits";
import { useT } from "@/i18n/LanguageContext";
import type { Lang, Localized } from "@/i18n/types";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { imageFor } from "@/lib/images";
import {
  fetchPublicationBySlug,
  fetchPublicationsForList,
  findPublicationSlugIgnoringCase,
  SHEET_LABELS,
  type PublicationEntry,
} from "@/lib/publications";
import type { JsonLd } from "@/lib/seo/core";
import { langFromMatches, pageHead } from "@/lib/seo/head";
import {
  PUBLICATIONS_LABEL,
  publicationDescription,
  publicationLd,
  publicationRegionLabel,
  publicationTitle,
  publicationTranslation,
  relatedPublications,
  type PublicationOffer,
} from "@/lib/seo/publication";
import { unavailableHeaders } from "@/lib/seo/status";
import { fetchActiveProductsByIds, isSoldOut } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import exhibitionImg from "@/assets/exhibition-corner.jpg";

/**
 * 頁面文字。刊物本身的刊名／出版者／介紹來自資料庫；metaTitle／metaDescription 只在
 * 讀取失敗的頁殼用（也給 scripts/check-meta.mjs 靜態檢查——每一項都要是三語字串常值）。
 */
const PAGE = {
  metaTitle: {
    zh: "地方刊物｜小時光書店",
    en: "Local Publications｜Interval Books",
    ja: "地域の刊行物｜小時光書店",
  },
  metaDescription: {
    zh: "小時光書店典藏的台灣各地地方刊物：一個地方怎麼被自己的人寫下來。部分可線上選購，其餘歡迎到店翻閱。",
    en: "Local magazines from across Taiwan kept at Interval Books — how a place gets written down by its own people. Some titles can be ordered online; the rest are in the store to read.",
    ja: "小時光書店が所蔵する台湾各地の地域誌。その土地の人がその土地を書いた記録です。一部はオンラインで購入でき、その他は店頭でご覧いただけます。",
  },
  home: { zh: "首頁", en: "Home", ja: "ホーム" },
  breadcrumb: { zh: "麵包屑", en: "Breadcrumb", ja: "パンくずリスト" },
  publisher: { zh: "出版／編輯", en: "Published by", ja: "発行・編集" },
  region: { zh: "關注地域", en: "Region", ja: "地域" },
  issues: { zh: "館藏期數", en: "Issues in store", ja: "所蔵号" },
  about: { zh: "刊物介紹", en: "About this publication", ja: "この刊行物について" },
  visitSite: { zh: "前往刊物網站", en: "Visit the publication's site", ja: "刊行物のサイトへ" },
  buy: { zh: "購買這本", en: "Buy this title", ja: "この刊行物を購入" },
  soldOut: { zh: "目前售完", en: "Sold out for now", ja: "現在売り切れ" },
  soldOutNote: {
    zh: "線上暫時售完，店內仍可翻閱。",
    en: "Sold out online for now — you can still read it in the store.",
    ja: "オンラインでは売り切れですが、店頭でご覧いただけます。",
  },
  inStore: {
    zh: "歡迎到店翻閱",
    en: "Come and read it in the store",
    ja: "店頭でご覧いただけます",
  },
  inStoreNote: {
    zh: "這一本典藏在店裡，沒有線上販售。歡迎來小時光坐下來慢慢翻。",
    en: "This title is kept in the store and is not sold online. Drop by, sit down and take your time with it.",
    ja: "この刊行物は店内で所蔵しており、オンライン販売はしていません。ぜひ店頭でゆっくりお読みください。",
  },
  visitInfo: { zh: "來訪資訊", en: "Visiting us", ja: "アクセス・営業時間" },
  related: {
    zh: "同地區的其他刊物",
    en: "More from the same region",
    ja: "同じ地域の刊行物",
  },
  allPublications: {
    zh: "所有地方刊物",
    en: "All local publications",
    ja: "地域の刊行物一覧",
  },
  unavailable: {
    zh: "刊物資料暫時無法載入，請稍後再試。",
    en: "This publication is temporarily unavailable. Please try again shortly.",
    ja: "刊行物の情報を読み込めませんでした。しばらくしてからお試しください。",
  },
};

/** 刊物頁要的商品資訊（不帶 description——那段與介紹逐字相同，不必再進 payload）。 */
type Offer = PublicationOffer & { compareAtPrice: number | null };

/** 「同地區的其他刊物」卡片要的欄位。 */
type RelatedCard = {
  slug: string;
  sheet: PublicationEntry["sheet"];
  title: Localized;
  region: string;
  coverImageKey: string | null;
};

type SeoBundle = {
  title: Localized;
  description: Localized;
  image: string | null;
  jsonLd: JsonLd[];
};

/** head() 與 useDocumentMeta() 共用同一份（SSR 與瀏覽器渲染後的 title 才會一致）。 */
function seoFor(pub: PublicationEntry | null, offer: Offer | null, lang: Lang): SeoBundle {
  if (!pub) {
    return { title: PAGE.metaTitle, description: PAGE.metaDescription, image: null, jsonLd: [] };
  }
  const image = pub.coverImageKey ? imageFor(pub.coverImageKey, "") || null : null;
  return {
    title: publicationTitle(pub),
    description: publicationDescription(pub),
    image,
    jsonLd: publicationLd({ entry: pub, lang, image, offer }),
  };
}

function metaOr(value: Localized | undefined, fallback: Localized): Localized {
  return value ?? fallback;
}

export const Route = createFileRoute("/publications/$slug")({
  loader: async ({ params }) => {
    const [{ publication, unavailable }, list] = await Promise.all([
      fetchPublicationBySlug(params.slug),
      fetchPublicationsForList(),
    ]);
    // 查無此刊物 → 404。讀取失敗不是 404（那會讓爬蟲以為頁面不見了）→ 503。
    if (!publication && !unavailable) {
      // /publications/TW-001 → 不分大小寫再找一次，找到就 301 到資料庫裡的寫法。
      const canonical = await findPublicationSlugIgnoringCase(params.slug);
      if (canonical) {
        throw redirect({ to: "/publications/$slug", params: { slug: canonical }, statusCode: 301 });
      }
      throw notFound();
    }

    let offer: Offer | null = null;
    if (publication?.productId) {
      // 商品讀失敗 → 這一頁照常顯示（只是沒有購買區），刊物不該因為電商掛掉而消失。
      const { products } = await fetchActiveProductsByIds([publication.productId]);
      const product = products[0];
      if (product && product.productType !== "event" && product.productType !== "journey") {
        offer = {
          slug: product.slug,
          price: product.price,
          compareAtPrice: product.compareAtPrice,
          inStock: !isSoldOut(product),
        };
      }
    }

    const related: RelatedCard[] = publication
      ? relatedPublications(list.publications, publication, 6).map((e) => ({
          slug: e.slug,
          sheet: e.sheet,
          title: e.title,
          region: e.region,
          coverImageKey: e.coverImageKey,
        }))
      : [];
    return { publication, unavailable, offer, related };
  },
  head: ({ loaderData, matches, match }) => {
    const pub = loaderData?.publication ?? null;
    const seo = seoFor(pub, loaderData?.offer ?? null, langFromMatches(matches));
    return pageHead(
      { matches, match },
      {
        translation: publicationTranslation(pub),
        title: seo.title,
        description: seo.description,
        image: seo.image ?? exhibitionImg,
        type: "book",
        jsonLd: seo.jsonLd,
      },
    );
  },
  headers: ({ loaderData }) =>
    unavailableHeaders(Boolean(loaderData?.unavailable && !loaderData?.publication)),
  component: PublicationPage,
});

function PublicationPage() {
  const t = useT();
  const { publication: pub, offer, related } = Route.useLoaderData();
  const { site } = useSiteContent();

  const seo = seoFor(pub, offer, "zh");
  useDocumentMeta({
    title: metaOr(seo.title, PAGE.metaTitle),
    description: metaOr(seo.description, PAGE.metaDescription),
    ogTitle: metaOr(seo.title, PAGE.metaTitle),
    ogImage: seo.image ?? exhibitionImg,
  });

  if (!pub) {
    return (
      <PageShell>
        <section className="container-editorial py-32">
          <p className="border border-border p-8 text-sm text-muted-foreground">
            {t(PAGE.unavailable)}
          </p>
          <BackLink label={t(PAGE.allPublications)} />
        </section>
      </PageShell>
    );
  }

  const regionLabel = publicationRegionLabel(pub);
  const country = t(SHEET_LABELS[pub.sheet]);
  const title = t(pub.title);

  return (
    <PageShell>
      <nav
        aria-label={t(PAGE.breadcrumb)}
        className="container-editorial pt-10 md:pt-12 text-xs tracking-widest text-muted-foreground"
        data-testid="publication-breadcrumb"
      >
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <li>
            <Link to="/" className="hover-underline hover:text-foreground">
              {t(PAGE.home)}
            </Link>
          </li>
          <li aria-hidden="true">›</li>
          <li>
            <Link to="/publications" className="hover-underline hover:text-foreground">
              {t(PUBLICATIONS_LABEL)}
            </Link>
          </li>
          <li aria-hidden="true">›</li>
          <li aria-current="page" className="text-foreground">
            {title}
          </li>
        </ol>
      </nav>

      <article data-testid="publication-detail" data-slug={pub.slug}>
        <section className="container-editorial grid gap-10 pt-10 pb-16 md:grid-cols-12 md:gap-16 md:pt-14 md:pb-24">
          <div className="md:col-span-5">
            <div className="aspect-[3/4] bg-oat/70 p-5 md:p-8 shadow-[0_18px_36px_-26px_oklch(0.245_0.018_60/0.6)]">
              <img
                src={imageFor(pub.coverImageKey, exhibitionImg)}
                alt={title}
                width={600}
                height={800}
                fetchPriority="high"
                decoding="async"
                className="h-full w-full object-contain"
              />
            </div>
          </div>

          <div className="flex flex-col md:col-span-7">
            <p className="kicker">
              {country}・{t(regionLabel)}
            </p>
            <h1 className="display mt-6 text-[2.5rem] leading-[1.15] md:text-6xl">{title}</h1>

            <dl className="mt-10 border-t border-border text-sm">
              <Row label={t(PAGE.publisher)}>{t(pub.publisher)}</Row>
              <Row label={t(PAGE.region)}>{pub.region || t(regionLabel)}</Row>
              {pub.issues ? <Row label={t(PAGE.issues)}>{pub.issues}</Row> : null}
            </dl>

            <div
              className="mt-10"
              data-testid={offer ? "publication-offer" : "publication-in-store"}
            >
              {offer ? (
                <>
                  <PriceTag price={offer.price} compareAtPrice={offer.compareAtPrice} size="lg" />
                  {offer.inStock ? (
                    <Link
                      to="/shop/$slug"
                      params={{ slug: offer.slug }}
                      className="btn-line mt-6"
                      data-testid="publication-buy"
                    >
                      {t(PAGE.buy)}
                      <span className="arrow" aria-hidden="true">
                        →
                      </span>
                    </Link>
                  ) : (
                    <div className="mt-5">
                      <StockBadge tone="alert">{t(PAGE.soldOut)}</StockBadge>
                      <p className="mt-3 text-sm text-muted-foreground">{t(PAGE.soldOutNote)}</p>
                      <Link
                        to="/shop/$slug"
                        params={{ slug: offer.slug }}
                        className="link-arrow mt-4"
                        data-testid="publication-buy"
                      >
                        {t(PAGE.buy)}
                        <span className="arrow" aria-hidden="true">
                          →
                        </span>
                      </Link>
                    </div>
                  )}
                </>
              ) : (
                <div className="border-l-2 border-clay/40 pl-5">
                  <p className="font-serif text-xl">{t(PAGE.inStore)}</p>
                  <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
                    {t(PAGE.inStoreNote)}
                  </p>
                  <p className="mt-4 text-sm leading-relaxed">
                    {t(site.address)}
                    <br />
                    <span className="text-muted-foreground">{t(site.hours)}</span>
                  </p>
                  <Link to="/about" className="link-arrow mt-4" data-testid="publication-visit">
                    {t(PAGE.visitInfo)}
                    <span className="arrow" aria-hidden="true">
                      →
                    </span>
                  </Link>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="container-editorial pb-20 md:pb-28">
          <div className="rule" />
          <div className="grid gap-8 pt-12 md:grid-cols-12 md:gap-16">
            <h2 className="kicker self-start md:col-span-4">{t(PAGE.about)}</h2>
            <div className="md:col-span-8 max-w-2xl">
              <p
                className="whitespace-pre-line text-base leading-[1.95] text-foreground/85"
                data-testid="publication-intro"
              >
                {t(pub.intro)}
              </p>
              {pub.externalUrl ? (
                <a
                  href={pub.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="link-arrow mt-8"
                >
                  {t(PAGE.visitSite)}
                  <span className="arrow" aria-hidden="true">
                    ↗
                  </span>
                </a>
              ) : null}
            </div>
          </div>
        </section>
      </article>

      {related.length > 0 ? (
        <section
          className="bg-oat/80 border-y border-border"
          aria-labelledby="publication-related"
          data-testid="publication-related"
        >
          <div className="container-editorial section-y">
            <h2 id="publication-related" className="display text-3xl md:text-4xl">
              {t(PAGE.related)}
            </h2>
            <ul className="mt-10 grid grid-cols-2 gap-x-5 gap-y-10 sm:grid-cols-3 lg:grid-cols-6">
              {related.map((r) => (
                <li key={r.slug}>
                  <Link
                    to="/publications/$slug"
                    params={{ slug: r.slug }}
                    className="group block"
                    data-testid="publication-related-link"
                  >
                    <div className="aspect-[3/4] overflow-hidden bg-background/70 p-3">
                      <img
                        src={imageFor(r.coverImageKey, exhibitionImg)}
                        alt={t(r.title)}
                        width={240}
                        height={320}
                        loading="lazy"
                        decoding="async"
                        className="img-zoom h-full w-full object-contain"
                      />
                    </div>
                    <p className="mt-3 text-sm leading-snug">{t(r.title)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{r.region}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <section className="container-editorial py-14">
        <BackLink label={t(PAGE.allPublications)} />
      </section>
    </PageShell>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-4 border-b border-border py-4 md:grid-cols-[9rem_1fr]">
      <dt className="text-xs tracking-widest text-muted-foreground pt-0.5">{label}</dt>
      <dd className="leading-relaxed">{children}</dd>
    </div>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      to="/publications"
      className="inline-flex items-center gap-2 text-xs tracking-widest text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {label}
    </Link>
  );
}
