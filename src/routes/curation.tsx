import { createFileRoute, Link } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fitDescription } from "@/lib/seo/core";
import { pageHead } from "@/lib/seo/head";
import { pageRowTranslation } from "@/lib/seo/pages";
import { fetchCollaborations, fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import { CARD, featureLayout } from "@/lib/feature-layout";
import { useSiteContent } from "@/lib/site-content";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "策展與合作 Curation｜小時光書店",
    en: "Curation & Collaboration｜Interval Books",
    ja: "キュレーションと協働｜小時光書店",
  },
  metaDescription: {
    zh: "策展不只是擺放，是讓人、物、空間彼此看見。我們為節慶設計療癒藝術節現場、為旅宿與咖啡館策劃選書選物、做書與茶器的主題展售，也替品牌設計閱讀活動與企業接待。合作歡迎來信。",
    en: "Curation with partners: healing arts festivals, book and object selections for hotels and cafés, tea-and-vessel showcases, and reading events for brands.",
    ja: "人と物と空間が互いに見えるように。ヒーリング・アートフェスの現場づくり、宿やカフェの選書・選品、本と茶器のテーマ展示、ブランドの読書イベントや接待を企画します。",
  },
  eyebrowSuffix: { zh: "策展與合作", en: "Curation", ja: "キュレーション" },
  /** 2026-11-10 文案健檢 C2：與 /partnership 同一組卡片（collaborations），區塊標題同一句。 */
  casesTitle: {
    zh: "我們做過的合作類型",
    en: "Kinds of collaboration we've done",
    ja: "これまでの協働のかたち",
  },
  title: {
    zh: "與夥伴，共構一段現場",
    en: "Co-creating a quiet stage",
    ja: "ともに、ひとつの現場を",
  },
  intro: {
    zh: "我們相信策展不只是擺放，而是讓人、物、空間，在一段時間裡彼此看見。",
    en: "Curation, to us, is not arrangement — it's letting people, objects, and space see one another for a while.",
    ja: "キュレーションとは並べることではなく、人と物と空間がしばらくのあいだ互いに見つめ合うこと。",
  },
  contactEyebrow: { zh: "Contact", en: "Contact", ja: "Contact" },
  /** 2026-10-26：合作洽詢改走 /partnership 的表單，Email 留作第二個選項。 */
  partnershipCta: {
    zh: "填寫異業合作表單",
    en: "Start a partnership inquiry",
    ja: "協働のご相談フォームへ",
  },
  contact: {
    zh: "填寫合作表單，或直接來信，我們會親自回覆。",
    en: "Fill in the partnership form or simply email us — we'll reply personally.",
    ja: "ご相談フォームから、またはメールで直接どうぞ。一通ずつお返事いたします。",
  },
};

/**
 * 零筆結果的文案。collaborations 是資料庫來的，可以是空的。
 *
 * 沒有這個守衛的話，下面的卡片格線一張卡都畫不出來，整段只剩一塊空白 ——
 * 看起來是壞掉，不是「還沒有合作案例」。
 */
const EMPTY = {
  zh: "目前還沒有公開的合作案例。歡迎來信聊聊你的想法。",
  en: "No collaborations are listed yet. We would love to hear what you have in mind.",
  ja: "公開中のコラボレーション事例はまだありません。お気軽にご相談ください。",
};

export const Route = createFileRoute("/curation")({
  loader: async () => {
    const [page, collaborations] = await Promise.all([
      fetchPage("curation"),
      fetchCollaborations(),
    ]);
    return { page, collaborations };
  },
  head: ({ loaderData, matches, match }) => {
    const p = pageText(loaderData?.page ?? null);
    return {
      ...pageHead(
        { matches, match },
        {
          translation: pageRowTranslation(loaderData?.page ?? null),
          title: p.metaTitle(PAGE.metaTitle),
          description: fitDescription(p.metaDescription(PAGE.metaDescription)),
          ogTitle: p.ogTitle(PAGE.title),
          type: "website",
        },
      ),
    };
  },
  component: Curation,
});

function Curation() {
  const t = useT();
  const { page, collaborations } = Route.useLoaderData();
  const p = pageText(page);
  const { contactEmail } = useSiteContent();
  const layout = featureLayout(collaborations.length);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: fitDescription(p.metaDescription(PAGE.metaDescription)),
    ogTitle: p.ogTitle(PAGE.title),
  });

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Curation", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      {collaborations.length === 0 ? (
        <section className="container-editorial pb-24">
          <p className="border border-border p-8 text-sm leading-relaxed text-muted-foreground md:p-10">
            {t(p.block("empty", EMPTY))}
          </p>
        </section>
      ) : (
        <>
          <div className="container-editorial pb-10">
            <h2 className="display text-3xl md:text-4xl" data-testid="curation-cases-title">
              {t(p.block("casesTitle", PAGE.casesTitle))}
            </h2>
          </div>
          <section className={`container-editorial pb-24 ${layout.grid}`}>
            {collaborations.map((c, i) => (
              <article key={c.id} className={`${CARD} ${layout.card}`}>
                <div className={`flex flex-1 flex-col p-6 ${layout.body}`}>
                  <p className="text-xs tracking-widest text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </p>
                  <h3 className={`display mt-3 text-2xl leading-snug ${layout.title}`}>
                    {t(c.title)}
                  </h3>
                  <p className="mt-4 text-sm leading-relaxed text-foreground/75">
                    {t(c.description)}
                  </p>
                </div>
              </article>
            ))}
          </section>
        </>
      )}

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 max-w-2xl">
          <p className="eyebrow text-2xl">{t(p.block("contactEyebrow", PAGE.contactEyebrow))}</p>
          <p className="mt-5 text-lg leading-relaxed text-foreground/80">
            {t(p.block("contact", PAGE.contact))}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              to="/partnership"
              className="inline-block border border-foreground bg-foreground px-6 py-3 text-sm tracking-widest text-primary-foreground hover:opacity-90 transition-opacity"
              data-testid="curation-partnership-cta"
            >
              {t(p.block("partnershipCta", PAGE.partnershipCta))}
            </Link>
            <a
              href={`mailto:${contactEmail}`}
              className="inline-block border border-foreground px-6 py-3 text-sm tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors"
            >
              {contactEmail}
            </a>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
