/**
 * /partnership —— 異業合作（2026-10-26，業主：「新增一個異業合作頁面……要有表單讓大家
 * 填，填完之後會寄 email 給管理員們」）。
 *
 *   引言 → 空間 → 合作形式（6 張卡）→ 合作流程（4 步）→ 合作案例（取 3 則，連到
 *   /curation）→ 常見問題 → 表單
 *
 * ── 文案從哪裡來 ──────────────────────────────────────────────────────────
 * 與其他頁同一套：fetchPage("partnership") 讀 pages／page_blocks／page_list_items，
 * 每一段都有下面的內建文案當後備。⚠️ 正式庫目前**沒有** pages/'partnership' 這一列
 * （pages 的 insert 只開給 service_role，見 src/server/repos/pages.ts 檔頭），所以現在
 * 整頁都是內建文案；種一列 pages＋對應的 page_blocks／page_list_items 之後，後台
 * /admin/pages/partnership 就能改，前台不必改程式。block_key／list_key 就是下面
 * p.block()／p.rows() 用的那些字串。
 *
 * ── 表單 ─────────────────────────────────────────────────────────────────
 * 驗證規則前後台同一份（src/lib/partnership.ts），送出走 src/lib/partnership-fns.ts。
 * 不存資料庫：寄一封信給 site_settings.notify_emails，詳見 src/server/partnership.ts。
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PageShell, PageHeader } from "@/components/PageShell";
import { useLang } from "@/i18n/LanguageContext";
import type { Lang, Localized } from "@/i18n/types";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fetchCollaborations, fetchPage, pageText, eyebrowOf } from "@/lib/cms";
import type { PageListEntry } from "@/lib/cms";
import { CARD } from "@/lib/feature-layout";
import { imageFor } from "@/lib/images";
import { useSiteContent } from "@/lib/site-content";
import {
  EMPTY_PARTNERSHIP_FORM,
  LIMITS,
  PARTNERSHIP_BUDGETS,
  PARTNERSHIP_BUDGET_LABEL,
  PARTNERSHIP_TYPES,
  PARTNERSHIP_TYPE_LABEL,
  SUBMIT_ERROR_TEXT,
  fieldErrorText,
  partnershipSchema,
  type PartnershipFormInput,
  type PartnershipFormValues,
  type PartnershipSubmitError,
} from "@/lib/partnership";
import { getPartnershipFormToken, submitPartnershipForm } from "@/lib/partnership-fns";
import exhibitionImg from "@/assets/exhibition-corner.jpg";

/** Fallback copy — used when pages/'partnership' has no row (currently: always). */
const PAGE = {
  metaTitle: {
    zh: "異業合作 Partnership｜小時光書店 Interval Books",
    en: "Partnership｜Interval Books",
    ja: "協働・コラボレーションのご相談｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "小時光書店位於華山文創園區，歡迎品牌、企業、創作者與我們合作：活動、展覽、選物寄賣、品牌聯名、企業包場、講座與工作坊。填寫表單，我們會在 3 個工作天內回覆。",
    en: "Interval Books at Huashan welcomes brands, companies and creators: events, exhibitions, consignment, brand collaborations, private bookings, talks and workshops. Send us a note — we reply within 3 business days.",
    ja: "華山の小時光書店では、ブランド・企業・作り手との協働を歓迎しています。イベント、展示、委託販売、ブランドコラボ、貸切、講座・ワークショップ。フォームからご相談ください。3営業日以内にお返事します。",
  },
  eyebrowSuffix: { zh: "異業合作", en: "異業合作", ja: "異業合作" },
  title: {
    zh: "在華山，一起做點什麼",
    en: "Let's make something together, at Huashan",
    ja: "華山で、いっしょに何かを",
  },
  intro: {
    zh: "一間書店能承接的，比書更多。如果你有一個想法——一場活動、一檔展覽、一個聯名的念頭——歡迎來聊聊。",
    en: "A bookshop can hold more than books. If you have an idea — an event, an exhibition, a collaboration — we'd love to hear it.",
    ja: "本屋が受けとめられるのは、本だけではありません。イベント、展示、コラボレーション。思いついたことがあれば、ぜひお聞かせください。",
  },
  ctaForm: { zh: "填寫合作表單", en: "Fill in the form", ja: "フォームへ" },
  spaceTitle: {
    zh: "一個安靜，但能容納很多事的地方",
    en: "A quiet place with room for a lot",
    ja: "しずかで、たくさんを受けとめる場所",
  },
  spaceBody: {
    zh: "小時光位於華山文創園區的紅磚六合院。白天有自然光落在書架與長桌上，傍晚燈一亮，就是講座與讀書會的現場。我們做過療癒藝術節、地方刊物展、器物展售與品牌共創——空間不大，但每一次都用心安排動線、陳列與氛圍，讓來的人願意多停留一會兒。",
    en: "Interval Books sits in the Red Brick Courtyard of Huashan 1914 Creative Park. By day, natural light falls on the shelves and the long table; by evening, the lamps come on for talks and reading circles. We've hosted healing-arts festivals, local-publication fairs, craft exhibitions and brand co-creations — the space is small, but every arrangement is made with care, so people want to stay a little longer.",
    ja: "小時光は華山1914文化創意産業園区の紅煉瓦六合院にあります。昼は自然光が本棚と長机に落ち、夕方に灯りがともれば講座や読書会の場に。ヒーリング・アートフェス、地域刊行物展、器の展示販売、ブランド共創などを手がけてきました。広くはない空間ですが、動線や陳列、空気感を毎回丁寧に整えています。",
  },
  typesTitle: { zh: "合作形式", en: "Ways to work with us", ja: "協働のかたち" },
  stepsTitle: { zh: "合作流程", en: "How it works", ja: "進め方" },
  casesTitle: { zh: "合作案例", en: "Past collaborations", ja: "これまでの協働" },
  casesMore: { zh: "看更多合作案例", en: "See all collaborations", ja: "協働事例をもっと見る" },
  faqTitle: { zh: "常見問題", en: "FAQ", ja: "よくあるご質問" },
  formEyebrow: { zh: "Contact Form", en: "Contact Form", ja: "Contact Form" },
  formTitle: {
    zh: "告訴我們你的想法",
    en: "Tell us about your idea",
    ja: "アイデアをお聞かせください",
  },
  formIntro: {
    zh: "標示 * 的欄位為必填。送出後，我們會在 3 個工作天內以 Email 回覆。",
    en: "Fields marked * are required. We'll reply by email within 3 business days.",
    ja: "* は必須項目です。3営業日以内にメールでお返事します。",
  },
  successTitle: { zh: "已收到，謝謝你", en: "Thank you — we've received it", ja: "受け付けました" },
  successBody: {
    zh: "已收到，我們會在 3 個工作天內回覆。",
    en: "We've received your note and will reply within 3 business days.",
    ja: "受け付けました。3営業日以内にお返事いたします。",
  },
  successAgain: { zh: "再填一份", en: "Send another", ja: "もう一件送る" },
  emailFallback: {
    zh: "也可以直接來信：",
    en: "Or email us directly: ",
    ja: "メールでも承ります：",
  },
};

const CARD_TYPES = ["event", "exhibition", "consignment", "cobrand", "private", "talk"] as const;

const TYPE_NOTES: Record<(typeof CARD_TYPES)[number], Localized> = {
  event: {
    zh: "新書發表、市集、品牌活動、快閃——在書店裡辦一場有溫度的現場。",
    en: "Book launches, markets, brand events and pop-ups — a warm, small-scale stage.",
    ja: "新刊発表、マーケット、ブランドイベント、ポップアップ。ぬくもりのある小さな現場を。",
  },
  exhibition: {
    zh: "插畫、攝影、器物、地方刊物——在書架之間佈一檔小而完整的展。",
    en: "Illustration, photography, craft, local publications — a small, complete show among the shelves.",
    ja: "イラスト、写真、器、地域の刊行物。本棚のあいだに、小さくても完結した展示を。",
  },
  consignment: {
    zh: "與小時光氣質相合的書籍、器物與生活選品，歡迎提案上架。",
    en: "Books, objects and everyday goods that fit our sensibility — propose them for our shelves.",
    ja: "小時光の空気に合う本や器、暮らしの品。お取り扱いのご提案を歓迎します。",
  },
  cobrand: {
    zh: "聯名選書、限定商品、內容共創，用低調精緻的方式說品牌的故事。",
    en: "Co-curated reading lists, limited goods, joint content — telling a brand's story quietly and well.",
    ja: "選書コラボ、限定グッズ、コンテンツの共創。控えめで上質なかたちでブランドの物語を。",
  },
  private: {
    zh: "員工活動、客戶招待、小型聚會與拍攝，包下一段只屬於你們的時光。",
    en: "Team days, client hospitality, small gatherings and shoots — an interval that's yours alone.",
    ja: "社内イベント、顧客のおもてなし、小さな集まりや撮影。貸切で、あなたたちだけの時間を。",
  },
  talk: {
    zh: "作者對談、主題講座、手作與療癒工作坊，從 10 人到 40 人都能安排。",
    en: "Author talks, themed lectures, craft and wellbeing workshops — for 10 to 40 people.",
    ja: "著者トーク、テーマ講座、手仕事やヒーリングのワークショップ。10〜40名まで対応します。",
  },
};

const TYPES_FALLBACK: PageListEntry[] = CARD_TYPES.map((k) => ({
  label: PARTNERSHIP_TYPE_LABEL[k],
  note: TYPE_NOTES[k],
  imageKey: null,
}));

const STEPS_FALLBACK: PageListEntry[] = [
  {
    label: { zh: "填寫表單", en: "Send the form", ja: "フォーム送信" },
    note: {
      zh: "告訴我們你是誰、想做什麼、大約什麼時候。不用很完整，有個方向就好。",
      en: "Tell us who you are, what you have in mind and roughly when. A direction is enough.",
      ja: "どなたが、何を、いつ頃。方向性だけでも大丈夫です。",
    },
    imageKey: null,
  },
  {
    label: {
      zh: "3 個工作天內回覆",
      en: "Reply within 3 business days",
      ja: "3営業日以内にご返信",
    },
    note: {
      zh: "我們會親自讀過每一份表單，以 Email 回覆初步想法與可行的時段。",
      en: "We read every note ourselves and reply by email with first thoughts and possible dates.",
      ja: "一件ずつ拝読し、メールで所感と可能な日程をお返事します。",
    },
    imageKey: null,
  },
  {
    label: { zh: "洽談細節", en: "Talk it through", ja: "打ち合わせ" },
    note: {
      zh: "線上或來店聊聊，確認內容、場地安排、分工與費用。",
      en: "Online or at the shop — content, space, roles and costs.",
      ja: "オンラインまたはご来店で、内容・空間・役割分担・費用を確認します。",
    },
    imageKey: null,
  },
  {
    label: { zh: "執行", en: "Make it happen", ja: "実施" },
    note: {
      zh: "從佈置、宣傳到現場，一起把它好好完成。",
      en: "From setup and promotion to the day itself — we see it through together.",
      ja: "設営・告知から当日まで、いっしょに丁寧に形にします。",
    },
    imageKey: null,
  },
];

const FAQ_FALLBACK: PageListEntry[] = [
  {
    label: {
      zh: "場地可以容納多少人？",
      en: "How many people can the space hold?",
      ja: "何名まで利用できますか？",
    },
    note: {
      zh: "講座與工作坊約 10–40 人，依座位排法而定；展覽與選物會依作品尺寸規劃陳列區。",
      en: "Talks and workshops fit about 10–40 people depending on seating; exhibitions are planned around the size of the works.",
      ja: "講座・ワークショップは座席配置により約10〜40名。展示は作品サイズに合わせて区画を計画します。",
    },
    imageKey: null,
  },
  {
    label: {
      zh: "合作一定要付費嗎？",
      en: "Does every collaboration involve a fee?",
      ja: "協働には必ず費用がかかりますか？",
    },
    note: {
      zh: "不一定。場地租借、分潤、寄賣抽成或互惠合作都有可能，我們會依內容一起討論最合適的方式。",
      en: "Not necessarily. Venue hire, revenue share, consignment or a reciprocal arrangement are all possible — we'll find what fits.",
      ja: "必ずしもそうではありません。会場利用料、レベニューシェア、委託販売、相互協力など、内容に合わせてご相談します。",
    },
    imageKey: null,
  },
  {
    label: {
      zh: "需要多早提出？",
      en: "How far ahead should we get in touch?",
      ja: "どのくらい前に相談すればよいですか？",
    },
    note: {
      zh: "活動與講座建議至少 4–6 週前，展覽與品牌聯名建議 2–3 個月前，讓宣傳與佈置都有充裕時間。",
      en: "For events and talks, at least 4–6 weeks; for exhibitions and brand collaborations, 2–3 months, so there's time for promotion and setup.",
      ja: "イベント・講座は4〜6週間前、展示・ブランドコラボは2〜3か月前がおすすめです。",
    },
    imageKey: null,
  },
  {
    label: {
      zh: "送出表單之後多久會收到回覆？",
      en: "When will we hear back?",
      ja: "返信はいつ頃届きますか？",
    },
    note: {
      zh: "我們會在 3 個工作天內以 Email 回覆。若沒有收到，請檢查垃圾郵件匣，或直接來信詢問。",
      en: "Within 3 business days, by email. If nothing arrives, please check your spam folder or email us directly.",
      ja: "3営業日以内にメールでお返事します。届かない場合は迷惑メールフォルダをご確認いただくか、直接メールでご連絡ください。",
    },
    imageKey: null,
  },
];

/** 表單欄位標籤。 */
const LABEL: Record<string, Localized> = {
  type: { zh: "合作類型", en: "Type of collaboration", ja: "協働の種類" },
  typePlaceholder: { zh: "請選擇", en: "Please choose", ja: "選択してください" },
  company: { zh: "公司／品牌名稱", en: "Company / brand", ja: "会社名・ブランド名" },
  contactName: { zh: "聯絡人姓名", en: "Contact name", ja: "ご担当者名" },
  email: { zh: "Email", en: "Email", ja: "メールアドレス" },
  phone: { zh: "電話", en: "Phone", ja: "電話番号" },
  website: { zh: "官網／社群連結", en: "Website / social link", ja: "ウェブサイト・SNS" },
  timeframe: { zh: "預計時間", en: "Preferred timing", ja: "ご希望の時期" },
  timeframeHint: {
    zh: "例如：2027 年 3 月、週末午後",
    en: "e.g. March 2027, weekend afternoons",
    ja: "例：2027年3月、週末の午後",
  },
  budget: { zh: "預算範圍", en: "Budget range", ja: "ご予算" },
  budgetPlaceholder: { zh: "不填也可以", en: "Optional", ja: "任意" },
  message: { zh: "合作內容說明", en: "About your idea", ja: "ご相談内容" },
  messageHint: {
    zh: "想做什麼、對象是誰、規模大概多大、希望小時光扮演什麼角色……",
    en: "What you'd like to do, for whom, roughly how big, and what role you'd like us to play…",
    ja: "内容、対象、規模感、小時光に期待する役割など……",
  },
  optional: { zh: "選填", en: "optional", ja: "任意" },
  consentA: { zh: "我已閱讀並同意", en: "I have read and agree to the", ja: "" },
  consentLink: { zh: "隱私權政策", en: "privacy policy", ja: "プライバシーポリシー" },
  consentB: {
    zh: "，同意小時光書店使用以上資料與我聯繫合作事宜。",
    en: ", and agree that Interval Books may use these details to contact me about this inquiry.",
    ja: "に同意し、本件のご連絡に上記情報を利用することを承諾します。",
  },
  submit: { zh: "送出", en: "Send", ja: "送信する" },
  submitting: { zh: "送出中…", en: "Sending…", ja: "送信中…" },
  honeypot: {
    zh: "請勿填寫此欄",
    en: "Leave this field empty",
    ja: "この欄は空欄のままにしてください",
  },
  chars: { zh: "字", en: "chars", ja: "文字" },
};

export const Route = createFileRoute("/partnership")({
  loader: async () => {
    const [page, collaborations] = await Promise.all([
      fetchPage("partnership"),
      fetchCollaborations(),
    ]);
    return { page, collaborations };
  },
  head: ({ loaderData }) => {
    const page = loaderData?.page ?? null;
    const p = pageText(page);
    return {
      meta: [
        { title: p.metaTitle(PAGE.metaTitle).zh },
        { name: "description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:title", content: p.ogTitle(PAGE.title).zh },
        { property: "og:description", content: p.metaDescription(PAGE.metaDescription).zh },
        { property: "og:image", content: imageFor(page?.ogImageKey, exhibitionImg) },
      ],
    };
  },
  component: Partnership,
});

function Partnership() {
  const { lang, t } = useLang();
  const { page, collaborations } = Route.useLoaderData();
  const p = pageText(page);

  useDocumentMeta({
    title: p.metaTitle(PAGE.metaTitle),
    description: p.metaDescription(PAGE.metaDescription),
    ogTitle: p.ogTitle(PAGE.title),
    ogImage: imageFor(page?.ogImageKey, exhibitionImg),
  });

  const types = p.rows("types", TYPES_FALLBACK);
  const steps = p.rows("steps", STEPS_FALLBACK);
  const faq = p.rows("faq", FAQ_FALLBACK);
  const cases = collaborations.slice(0, 3);
  const blank: Localized = { zh: "", en: "", ja: "" };

  return (
    <PageShell>
      <PageHeader
        eyebrow={eyebrowOf(page, "Partnership", t(page?.eyebrowSuffix ?? PAGE.eyebrowSuffix))}
        title={t(p.title(PAGE.title))}
        intro={t(p.intro(PAGE.intro))}
      />

      <div className="container-editorial -mt-4 pb-16">
        <a
          href="#partnership-form"
          className="inline-block border border-foreground bg-foreground px-6 py-3 text-xs tracking-widest text-primary-foreground transition-opacity hover:opacity-90"
        >
          {t(p.block("ctaForm", PAGE.ctaForm))}
        </a>
      </div>

      {/* 1) 空間 */}
      <section
        className="container-editorial pb-24 grid items-center gap-12 md:grid-cols-2"
        data-testid="partnership-space"
      >
        <div className="aspect-[4/3] overflow-hidden bg-muted">
          <img
            src={exhibitionImg}
            alt={t(p.block("spaceTitle", PAGE.spaceTitle))}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        </div>
        <div>
          <h2 className="display text-3xl md:text-4xl leading-snug">
            {t(p.block("spaceTitle", PAGE.spaceTitle))}
          </h2>
          <p className="mt-6 text-base leading-loose text-foreground/80">
            {t(p.block("spaceBody", PAGE.spaceBody))}
          </p>
        </div>
      </section>

      {/* 2) 合作形式 */}
      <section className="container-editorial pb-24" data-testid="partnership-types">
        <h2 className="display border-t border-border pt-12 text-3xl md:text-4xl">
          {t(p.block("typesTitle", PAGE.typesTitle))}
        </h2>
        <div className="mt-12 grid gap-8 md:grid-cols-2 lg:grid-cols-3">
          {types.map((row, i) => (
            <article key={i} className={CARD}>
              <div className="flex flex-1 flex-col p-6">
                <p className="text-[0.65rem] tracking-widest text-muted-foreground">
                  {String(i + 1).padStart(2, "0")}
                </p>
                <h3 className="display mt-3 text-2xl leading-snug">{t(row.label)}</h3>
                <p className="mt-4 text-sm leading-relaxed text-foreground/75">
                  {t(row.note ?? blank)}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* 3) 合作流程 */}
      <section className="container-editorial pb-24" data-testid="partnership-steps">
        <h2 className="display border-t border-border pt-12 text-3xl md:text-4xl">
          {t(p.block("stepsTitle", PAGE.stepsTitle))}
        </h2>
        <ol className="mt-12 grid gap-10 md:grid-cols-2 lg:grid-cols-4">
          {steps.map((row, i) => (
            <li key={i}>
              <p className="font-serif text-4xl text-clay">{String(i + 1).padStart(2, "0")}</p>
              <div className="rule mt-4" />
              <h3 className="mt-5 font-serif text-xl">{t(row.label)}</h3>
              <p className="mt-3 text-sm leading-relaxed text-foreground/75">
                {t(row.note ?? blank)}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* 4) 合作案例（社會證明，完整清單在 /curation） */}
      {cases.length > 0 && (
        <section className="container-editorial pb-24" data-testid="partnership-cases">
          <div className="flex flex-col gap-4 border-t border-border pt-12 md:flex-row md:items-end md:justify-between">
            <h2 className="display text-3xl md:text-4xl">
              {t(p.block("casesTitle", PAGE.casesTitle))}
            </h2>
            <Link
              to="/curation"
              className="hover-underline self-start text-xs tracking-widest text-clay md:self-auto"
            >
              {t(p.block("casesMore", PAGE.casesMore))} →
            </Link>
          </div>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {cases.map((c) => (
              <article key={c.id} className={CARD}>
                <div className="flex flex-1 flex-col p-6">
                  <h3 className="display text-xl leading-snug">{t(c.title)}</h3>
                  <p className="mt-4 line-clamp-4 text-sm leading-relaxed text-foreground/75">
                    {t(c.description)}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* 5) 常見問題 */}
      <section className="container-editorial pb-24" data-testid="partnership-faq">
        <h2 className="display border-t border-border pt-12 text-3xl md:text-4xl">
          {t(p.block("faqTitle", PAGE.faqTitle))}
        </h2>
        <div className="mt-10 max-w-3xl divide-y divide-border border-y border-border">
          {faq.map((row, i) => (
            <details key={i} className="group py-5">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-6 font-serif text-lg">
                <span>{t(row.label)}</span>
                <span
                  className="mt-1 text-sm text-muted-foreground transition-transform group-open:rotate-45"
                  aria-hidden="true"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-foreground/75">
                {t(row.note ?? blank)}
              </p>
            </details>
          ))}
        </div>
      </section>

      {/* 6) 表單 */}
      <section
        id="partnership-form"
        className="container-editorial scroll-mt-24 pb-32"
        data-testid="partnership-form"
      >
        <div className="border border-border bg-[oklch(0.97_0.012_82)] p-6 md:p-12">
          <p className="eyebrow text-2xl">{t(p.block("formEyebrow", PAGE.formEyebrow))}</p>
          <h2 className="display mt-3 text-3xl md:text-4xl">
            {t(p.block("formTitle", PAGE.formTitle))}
          </h2>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {t(p.block("formIntro", PAGE.formIntro))}
          </p>
          <PartnershipForm lang={lang} copy={p} />
        </div>
      </section>
    </PageShell>
  );
}

const inputClass =
  "mt-2 block w-full border border-border bg-background px-3 py-2.5 text-base md:text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground aria-[invalid=true]:border-destructive";

function PartnershipForm({ lang, copy }: { lang: Lang; copy: ReturnType<typeof pageText> }) {
  const { contactEmail } = useSiteContent();
  const tx = (v: Localized) => v[lang] || v.zh;
  const [token, setToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [submitError, setSubmitError] = useState<PartnershipSubmitError | null>(null);
  const honeypotRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // 畫面出現時拿 token（發行時間由伺服器簽）。拿不到就讓送出時回 expired。
  useEffect(() => {
    let alive = true;
    getPartnershipFormToken()
      .then((r) => alive && setToken(r.token))
      .catch(() => alive && setToken(""));
    return () => {
      alive = false;
    };
  }, [sent]);

  const form = useForm<PartnershipFormInput, unknown, PartnershipFormValues>({
    resolver: zodResolver(partnershipSchema),
    defaultValues: EMPTY_PARTNERSHIP_FORM,
    mode: "onTouched",
  });
  const { register, handleSubmit, formState, watch, setError, reset } = form;
  const errors = formState.errors;
  const messageLength = Array.from(watch("message") ?? "").length;

  async function onSubmit(values: PartnershipFormValues) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await submitPartnershipForm({
        data: {
          form: values,
          token: token ?? "",
          honeypot: honeypotRef.current?.value ?? "",
          lang,
          pageUrl: typeof window === "undefined" ? "" : window.location.href.slice(0, 300),
        },
      });
      if (result.ok) {
        setSent(true);
        reset(EMPTY_PARTNERSHIP_FORM);
        return;
      }
      for (const f of result.fields ?? []) {
        setError(f as keyof PartnershipFormInput, { type: "server", message: "check" });
      }
      setSubmitError(result.error);
    } catch {
      setSubmitError("send_failed");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (submitError) errorRef.current?.focus();
  }, [submitError]);

  if (sent) {
    return (
      <div
        className="mt-10 border-t border-border pt-10"
        role="status"
        data-testid="partnership-success"
      >
        <h3 className="display text-2xl md:text-3xl">
          {tx(copy.block("successTitle", PAGE.successTitle))}
        </h3>
        <p className="mt-4 text-base leading-relaxed text-foreground/80">
          {tx(copy.block("successBody", PAGE.successBody))}
        </p>
        <button
          type="button"
          onClick={() => {
            setSent(false);
            setToken(null);
          }}
          className="mt-8 border border-foreground px-6 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
        >
          {tx(copy.block("successAgain", PAGE.successAgain))}
        </button>
      </div>
    );
  }

  const err = (name: keyof PartnershipFormInput) => {
    const code = errors[name]?.message;
    return code ? (
      <p id={`pf-${name}-error`} className="mt-1.5 text-xs text-destructive">
        {fieldErrorText(String(code), lang)}
      </p>
    ) : null;
  };
  const aria = (name: keyof PartnershipFormInput) => ({
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": errors[name] ? `pf-${name}-error` : undefined,
  });
  const req = (
    <span aria-hidden="true" className="text-clay">
      {" "}
      *
    </span>
  );
  const opt = <span className="ml-1 text-xs text-muted-foreground">（{tx(LABEL.optional)}）</span>;

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-10 grid gap-6 md:grid-cols-2">
      {/* 蜜罐：畫面外、不可聚焦、讀屏不唸。人類不會填。 */}
      <div
        aria-hidden="true"
        className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden"
      >
        <label>
          {tx(LABEL.honeypot)}
          <input
            ref={honeypotRef}
            type="text"
            name="fax_number"
            tabIndex={-1}
            autoComplete="off"
            defaultValue=""
          />
        </label>
      </div>

      <div className="md:col-span-2">
        <label htmlFor="pf-type" className="text-sm">
          {tx(LABEL.type)}
          {req}
        </label>
        <select
          id="pf-type"
          className={inputClass}
          {...register("type")}
          {...aria("type")}
          required
        >
          <option value="">{tx(LABEL.typePlaceholder)}</option>
          {PARTNERSHIP_TYPES.map((k) => (
            <option key={k} value={k}>
              {tx(PARTNERSHIP_TYPE_LABEL[k])}
            </option>
          ))}
        </select>
        {err("type")}
      </div>

      <div>
        <label htmlFor="pf-company" className="text-sm">
          {tx(LABEL.company)}
          {req}
        </label>
        <input
          id="pf-company"
          className={inputClass}
          maxLength={LIMITS.company}
          autoComplete="organization"
          {...register("company")}
          {...aria("company")}
          required
        />
        {err("company")}
      </div>

      <div>
        <label htmlFor="pf-contactName" className="text-sm">
          {tx(LABEL.contactName)}
          {req}
        </label>
        <input
          id="pf-contactName"
          className={inputClass}
          maxLength={LIMITS.name}
          autoComplete="name"
          {...register("contactName")}
          {...aria("contactName")}
          required
        />
        {err("contactName")}
      </div>

      <div>
        <label htmlFor="pf-email" className="text-sm">
          {tx(LABEL.email)}
          {req}
        </label>
        <input
          id="pf-email"
          type="email"
          inputMode="email"
          className={inputClass}
          maxLength={LIMITS.email}
          autoComplete="email"
          {...register("email")}
          {...aria("email")}
          required
        />
        {err("email")}
      </div>

      <div>
        <label htmlFor="pf-phone" className="text-sm">
          {tx(LABEL.phone)}
          {opt}
        </label>
        <input
          id="pf-phone"
          type="tel"
          inputMode="tel"
          className={inputClass}
          maxLength={LIMITS.phone}
          autoComplete="tel"
          {...register("phone")}
          {...aria("phone")}
        />
        {err("phone")}
      </div>

      <div className="md:col-span-2">
        <label htmlFor="pf-website" className="text-sm">
          {tx(LABEL.website)}
          {opt}
        </label>
        <input
          id="pf-website"
          type="url"
          inputMode="url"
          placeholder="https://"
          className={inputClass}
          maxLength={LIMITS.website}
          autoComplete="url"
          {...register("website")}
          {...aria("website")}
        />
        {err("website")}
      </div>

      <div>
        <label htmlFor="pf-timeframe" className="text-sm">
          {tx(LABEL.timeframe)}
          {opt}
        </label>
        <input
          id="pf-timeframe"
          placeholder={tx(LABEL.timeframeHint)}
          className={inputClass}
          maxLength={LIMITS.timeframe}
          {...register("timeframe")}
          {...aria("timeframe")}
        />
        {err("timeframe")}
      </div>

      <div>
        <label htmlFor="pf-budget" className="text-sm">
          {tx(LABEL.budget)}
          {opt}
        </label>
        <select id="pf-budget" className={inputClass} {...register("budget")} {...aria("budget")}>
          <option value="">{tx(LABEL.budgetPlaceholder)}</option>
          {PARTNERSHIP_BUDGETS.map((k) => (
            <option key={k} value={k}>
              {tx(PARTNERSHIP_BUDGET_LABEL[k])}
            </option>
          ))}
        </select>
        {err("budget")}
      </div>

      <div className="md:col-span-2">
        <label htmlFor="pf-message" className="text-sm">
          {tx(LABEL.message)}
          {req}
        </label>
        <textarea
          id="pf-message"
          rows={7}
          placeholder={tx(LABEL.messageHint)}
          className={`${inputClass} leading-relaxed`}
          maxLength={LIMITS.messageMax}
          {...register("message")}
          {...aria("message")}
          required
        />
        <div className="flex items-start justify-between gap-4">
          <div>{err("message")}</div>
          <p className="mt-1.5 shrink-0 text-xs text-muted-foreground" aria-live="polite">
            {messageLength} / {LIMITS.messageMax} {tx(LABEL.chars)}
          </p>
        </div>
      </div>

      <div className="md:col-span-2">
        <label className="flex items-start gap-3 text-sm leading-relaxed">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 accent-foreground"
            {...register("consent")}
            {...aria("consent")}
          />
          <span>
            {tx(LABEL.consentA)}
            {lang === "ja" ? "" : " "}
            <Link to="/privacy" target="_blank" className="underline underline-offset-4">
              {tx(LABEL.consentLink)}
            </Link>
            {tx(LABEL.consentB)}
            {req}
          </span>
        </label>
        {err("consent")}
      </div>

      <div className="md:col-span-2">
        {submitError && (
          <p
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="mb-5 border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {tx(SUBMIT_ERROR_TEXT[submitError])}
            {(submitError === "send_failed" || submitError === "rate_limited") && contactEmail && (
              <>
                {" "}
                {tx(PAGE.emailFallback)}
                <a href={`mailto:${contactEmail}`} className="underline underline-offset-4">
                  {contactEmail}
                </a>
              </>
            )}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || token === null}
          className="border border-foreground bg-foreground px-10 py-3.5 text-xs tracking-widest text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? tx(LABEL.submitting) : tx(LABEL.submit)}
        </button>
      </div>
    </form>
  );
}
