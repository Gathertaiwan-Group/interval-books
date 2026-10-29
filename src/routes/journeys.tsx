import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { CoverImage } from "@/components/CoverImage";
import { PastShelf } from "@/components/PastShelf";
import { linkedEventFor, splitJourneys } from "@/lib/past-shelf";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchJourneyEventDates, fetchJourneys, fetchPage, pageText, eyebrowOf } from "@/lib/cms";
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
  // 「過往策旅」卡片區（2026-10-28 店長：「策旅的部分也是」）。與 /events 的「過往活動」
  // 同一個元件（src/components/PastShelf.tsx）。策旅沒有「已結束」分頁，所以沒有「查看全部」。
  pastEyebrow: { zh: "PAST JOURNEYS", en: "PAST JOURNEYS", ja: "PAST JOURNEYS" },
  pastTitle: { zh: "過往策旅", en: "Past journeys", ja: "これまでの旅" },
  pastBadge: { zh: "已結束", en: "Ended", ja: "終了" },
  emptyOpen: {
    zh: "目前沒有開放報名的策旅。新的旅程公布前，歡迎先看看我們走過的地方。",
    en: "No journeys are open for registration right now. In the meantime, take a look at where we have been.",
    ja: "現在受付中の旅はありません。これまでの旅をご覧ください。",
  },
};

export const Route = createFileRoute("/journeys")({
  loader: async () => {
    const [page, journeys, journeyEvents] = await Promise.all([
      fetchPage("journeys"),
      fetchJourneys(),
      fetchJourneyEventDates(),
    ]);
    return { page, journeys, journeyEvents };
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
  const { page, journeys: allJourneys, journeyEvents } = Route.useLoaderData();
  const p = pageText(page);
  const { ui, contactEmail } = useSiteContent();
  // 「已結束」＝卡片指著的那場活動已結束（判準見 src/lib/past-shelf.ts）。上面的列表只放
  // 還沒結束的；結束的移到下面「過往策旅」。指不到活動的策旅一律留在上面。
  const { open: journeys, ended } = splitJourneys(allJourneys, journeyEvents);
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

      {journeys.length === 0 ? (
        <section className="container-editorial pb-24">
          <div className="border border-border p-8 md:p-10">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t(p.block("emptyOpen", PAGE.emptyOpen))}
            </p>
          </div>
        </section>
      ) : (
        <section className={`container-editorial pb-24 ${layout.grid}`}>
          {journeys.map((j) => {
            // 與首頁「精選策旅」同一種卡片：有連結就整張卡可點，還沒設連結的策旅
            // 仍然看得到卡片，只是不可點（不要讓它消失）。
            const link = journeyLinkProps(j.externalUrl);
            const body = (
              <>
                {/* journeys 表沒有 image_key；封面用卡片指著的那場活動的 events.image_key
                  （與首頁精選、下方過往策旅同一個來源），指不到或沒設圖才用固定意象圖。
                  標題就在卡片上，所以圖當裝飾（alt=""）。 */}
                <CoverImage
                  src={imageFor(linkedEventFor(j.externalUrl, journeyEvents)?.imageKey, journeyImg)}
                  alt=""
                  loading="lazy"
                  className={`aspect-[4/3] ${layout.image}`}
                  imgClassName="transition-transform duration-500 group-hover:scale-[1.03]"
                />
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
      )}

      <PastShelf
        testId="journeys-past-shelf"
        eyebrow={t(p.block("pastEyebrow", PAGE.pastEyebrow))}
        title={t(p.block("pastTitle", PAGE.pastTitle))}
        badge={t(p.block("pastBadge", PAGE.pastBadge))}
        items={ended.map(({ journey: j, event: e }) => {
          const link = journeyLinkProps(j.externalUrl);
          return {
            key: j.id,
            title: t(j.title),
            category: `${t(j.days)} ／ ${t(j.theme)}`,
            date: e.date,
            image: e.imageKey ? imageFor(e.imageKey, journeyImg) : journeyImg,
            link: link ? { kind: "href" as const, ...link } : null,
          };
        })}
      />

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
