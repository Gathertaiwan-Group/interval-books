import { createFileRoute } from "@tanstack/react-router";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchCollaborations, fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import { CARD, featureLayout } from "@/lib/feature-layout";
import { useSiteContent } from "@/lib/site-content";

/** Fallback copy — used only when the Supabase read fails. */
const PAGE = {
  metaTitle: {
    zh: "策展與合作 Curation｜小時光書店 Interval Books",
    en: "Curation & Collaboration｜Interval Books",
    ja: "キュレーションと協働｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "療癒藝術節、空間策展、書店展售與品牌共創——以低調而精緻的方式，與夥伴共創。",
    en: "Healing arts festivals, spatial curation, in-store exhibitions, and quiet brand collaborations — co-created with care.",
    ja: "ヒーリング・アートフェス、空間キュレーション、店内展示、ブランド共創。静かで丁寧な協働を。",
  },
  eyebrowSuffix: { zh: "策展與合作", en: "策展與合作", ja: "策展與合作" },
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
  contact: {
    zh: "合作邀請請以 Email 聯繫，我們會親自回覆。",
    en: "For collaboration, please reach us by email — we'll reply personally.",
    ja: "ご相談はメールにて。一通ずつお返事いたします。",
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
    description: p.metaDescription(PAGE.metaDescription),
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
        <section className={`container-editorial pb-24 ${layout.grid}`}>
          {collaborations.map((c, i) => (
            <article key={c.id} className={`${CARD} ${layout.card}`}>
              <div className={`flex flex-1 flex-col p-6 ${layout.body}`}>
                <p className="text-[0.65rem] tracking-widest text-muted-foreground">
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
      )}

      <section className="container-editorial pb-32">
        <div className="border-t border-border pt-16 max-w-2xl">
          <p className="eyebrow text-2xl">{t(p.block("contactEyebrow", PAGE.contactEyebrow))}</p>
          <p className="mt-5 text-lg leading-relaxed text-foreground/80">
            {t(p.block("contact", PAGE.contact))}
          </p>
          <a
            href={`mailto:${contactEmail}`}
            className="mt-8 inline-block border border-foreground px-6 py-3 text-xs tracking-widest hover:bg-foreground hover:text-primary-foreground transition-colors"
          >
            {contactEmail}
          </a>
        </div>
      </section>
    </PageShell>
  );
}
