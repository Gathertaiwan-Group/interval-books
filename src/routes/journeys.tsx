import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchJourneys, fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import { CARD, CARD_HOVER, featureLayout } from "@/lib/feature-layout";
import { useSiteContent } from "@/lib/site-content";
import { imageFor } from "@/lib/images";
import { journeyLinkProps } from "@/lib/journey-link";
import journeyImg from "@/assets/journey-mist.jpg";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "策旅 Journeys｜小時光書店 Interval Books",
    en: "Journeys｜Interval Books",
    ja: "旅｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "由書與土地共同寫成的深度旅程。每一趟策旅皆有獨立網站，本頁為彙整導流。",
    en: "Slow journeys co-written by books and the land. Each trip has its own site; this page gathers the threads.",
    ja: "本と土地が共に綴る、深い旅。各旅には専用サイトがあります。このページはその目次です。",
  },
  eyebrowSuffix: { zh: "策旅", en: "策旅", ja: "策旅" },
  title: {
    zh: "讓土地，成為書的延伸",
    en: "Let the land be the book's extension",
    ja: "土地を、本の延長に",
  },
  intro: {
    zh: "每一趟策旅皆有獨立網站，本頁僅做彙整導流。請點選感興趣的旅程，前往該旅程的專屬頁面。",
    en: "Each journey has its own dedicated site. Choose one to read further.",
    ja: "各「旅」には専用サイトがあります。気になる旅へお進みください。",
  },
  coCreateEyebrow: { zh: "Co-create", en: "Co-create", ja: "Co-create" },
  collab: { zh: "策旅合作共創", en: "Journey co-creation", ja: "旅の共創" },
  collabBody: {
    zh: "若您是地方夥伴、職人、旅宿或品牌，歡迎與我們共創一段屬於風土的策旅。請以 Email 聯繫。",
    en: "If you're a local partner, maker, hotel, or brand, we'd love to co-create a journey rooted in place. Reach us by email.",
    ja: "地域のパートナー、作り手、宿、ブランドの方へ。風土に根ざした旅をともに育てましょう。メールでご連絡ください。",
  },
};

export const Route = createFileRoute("/journeys")({
  loader: async () => {
    const [page, journeys] = await Promise.all([fetchPage("journeys"), fetchJourneys()]);
    return { page, journeys };
  },
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:image", content: imageFor(loaderData?.page?.ogImageKey, journeyImg) },
      ],
    };
  },
  component: Journeys,
});

function Journeys() {
  const t = useT();
  const { page, journeys } = Route.useLoaderData();
  const p = pageText(page);
  const { ui, contactEmail } = useSiteContent();
  const layout = featureLayout(journeys.length);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
    ogImage: imageFor(page?.ogImageKey, journeyImg),
  });
  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Journeys", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <section className={`container-editorial pb-24 ${layout.grid}`}>
        {journeys.map((j) => {
          // 與首頁「精選策旅」同一種卡片：有連結就整張卡可點，還沒設連結的策旅
          // 仍然看得到卡片，只是不可點（不要讓它消失）。
          const link = journeyLinkProps(j.externalUrl);
          const body = (
            <>
              {/* 每一趟策旅都用同一張固定意象圖（journeys 表沒有 image_key），
                  它不是這趟旅程的照片，所以當裝飾圖（alt=""），標題就在卡片上。 */}
              <div className={`aspect-[4/3] overflow-hidden bg-muted ${layout.image}`}>
                <img
                  src={journeyImg}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                />
              </div>
              <div className={`flex flex-1 flex-col p-6 ${layout.body}`}>
                <p className="eyebrow text-sm tracking-widest">
                  {t(j.days)} ／ {t(j.theme)}
                </p>
                <h3
                  className={`display mt-3 text-2xl leading-snug whitespace-pre-line ${layout.title}`}
                >
                  {t(j.title)}
                </h3>
                <p
                  className={`mt-4 text-sm leading-relaxed text-foreground/75 flex-1 ${layout.summary}`}
                >
                  {t(j.summary)}
                </p>
                {link ? (
                  <span className="mt-6 inline-block self-start tracking-widest text-clay group-hover:underline text-base">
                    {t(ui.buttons.toJourney)} →
                  </span>
                ) : null}
              </div>
            </>
          );
          return link ? (
            <a key={j.id} {...link} className={`${CARD} ${layout.card} ${CARD_HOVER}`}>
              {body}
            </a>
          ) : (
            <article key={j.id} className={`${CARD} ${layout.card}`}>
              {body}
            </article>
          );
        })}
      </section>

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 grid md:grid-cols-2 gap-10">
          <div>
            <p className="eyebrow text-2xl">
              {t(p.block("coCreateEyebrow", PAGE.coCreateEyebrow))}
            </p>
            <h2 className="display mt-4 text-3xl md:text-4xl">
              {t(p.block("collab", PAGE.collab))}
            </h2>
          </div>
          <div>
            <p className="text-base leading-relaxed text-foreground/80">
              {t(p.block("collabBody", PAGE.collabBody))}
            </p>
            <a
              href={`mailto:${contactEmail}`}
              className="mt-6 inline-block border border-foreground px-6 py-3 tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors text-base"
            >
              {contactEmail}
            </a>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
