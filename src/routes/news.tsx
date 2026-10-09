import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { eyebrowOf, fetchNews, fetchPage, pageText } from "@/lib/cms";
import { CARD, featureLayout } from "@/lib/feature-layout";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "最新消息 News｜小時光書店 Interval Books",
    en: "News｜Interval Books",
    ja: "お知らせ｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "活動預告、營業調整與策旅消息。",
    en: "Event announcements, opening updates, and journey news.",
    ja: "イベント予告、営業のお知らせ、旅の最新情報。",
  },
  eyebrowSuffix: { zh: "最新消息", en: "最新消息", ja: "最新消息" },
  title: { zh: "最新消息", en: "Latest News", ja: "お知らせ" },
  intro: {
    zh: "簡短的小通知與更新——展覽、活動、營業時間變動。",
    en: "Short notes and updates — exhibitions, events, and hours.",
    ja: "短いお知らせ。展覧、イベント、営業時間など。",
  },
};

export const Route = createFileRoute("/news")({
  loader: async () => {
    const [page, news] = await Promise.all([fetchPage("news"), fetchNews()]);
    return { page, news };
  },
  head: ({ loaderData }) => {
    const p = pageText(loaderData?.page ?? null);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
      ],
    };
  },
  component: News,
});

function News() {
  const t = useT();
  const { page, news } = Route.useLoaderData();
  const p = pageText(page);
  const layout = featureLayout(news.length);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
  });

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "News", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <section className="container-editorial pb-32">
        <ul className={layout.grid}>
          {news.map((n) => (
            <li key={n.id} className={`${CARD} ${layout.card}`}>
              <div className={`flex flex-1 flex-col p-6 ${layout.body}`}>
                <p className="text-sm tracking-widest text-muted-foreground">{n.date}</p>
                <h3
                  className={`display mt-3 text-2xl leading-snug whitespace-pre-line ${layout.title}`}
                >
                  {t(n.title)}
                </h3>
                <p className="mt-4 text-sm leading-relaxed text-foreground/75 whitespace-pre-line">
                  {t(n.summary)}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {t(n.description)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </PageShell>
  );
}
