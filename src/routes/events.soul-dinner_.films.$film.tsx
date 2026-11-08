import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { fetchEventVisibility } from "@/lib/cms";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { fitDescription } from "@/lib/seo/core";
import { langFromMatches, pageHead, withLinks } from "@/lib/seo/head";
import { landingSubpageLd } from "@/lib/seo/pages";
import { imageFor } from "@/lib/images";
import { SoulFooter, SoulHeader } from "@/components/soul-dinner/Chrome";
import {
  BUTTON_CLAY,
  EVENT_PATH,
  EVENT_SLUG,
  filmBySlug,
  FONTS_HREF,
  HERO_KEY,
  HOSTS_LINE,
  SCHEDULE,
  type Film,
} from "@/components/soul-dinner/data";
import soulCss from "@/components/soul-dinner/soul-dinner.css?url";

/**
 * 《小時光｜靈魂飯桌》的電影子頁：/events/soul-dinner/films/<片>。內容照稿
 * （soul-movie.lovable.app/films/*），資料在 src/components/soul-dinner/data.ts。
 *
 * 稿上每一頁底下有「映後小客廳」（登入後留言的討論區）。業主決定站上不做留言區，
 * 這裡只保留電影資訊與「預約一張飯票」。
 */

/** 三語 meta 的共用部分（各片的標題在 head() 裡接上片名）。 */
const PAGE = {
  metaTitle: {
    zh: "小時光靈魂飯桌｜片單",
    en: "Interval Books Soul Dinner Table｜Programme",
    ja: "小時光 魂の食卓｜上映作品",
  },
  metaDescription: {
    zh: "週二 19:30–21:30，光中心周介偉老師與 Alice老師共同主講。簡單輕食晚餐・電影賞析・交流。",
    en: "Tuesdays 19:30–21:30, co-hosted by Chou Chieh-Wei of Light Center and Alice. A light dinner, a guided film discussion, and conversation.",
    ja: "火曜 19:30–21:30、光中心の周介偉先生と Alice 先生による共同進行。軽めの夕食・映画鑑賞と解説・語り合い。",
  },
};

function fullTitle(f: Film): string {
  return f.episode ? `${f.title}｜${f.episode}` : f.title;
}

type Localized = typeof PAGE.metaTitle;

/**
 * 各片的標題與描述：中文換成這一片的，英日文沿用 PAGE。第二個參數刻意傳 PAGE 的
 * 字面物件——check-meta.mjs 會順著呼叫的參數找到它、檢查三語是否齊全。
 */
function filmTitle(f: Film | null, base: Localized): Localized {
  if (!f) return base;
  const ordinal = ["", "第一場", "第二場", "第三場", "第四場", "第五場"][f.n] ?? `第 ${f.n} 場`;
  const titleZh = f.episode ? fullTitle(f) : `${f.title}｜${ordinal}`;
  return { ...base, zh: `${titleZh}｜小時光靈魂飯桌` };
}

function filmDescription(f: Film | null, base: Localized): Localized {
  if (!f) return base;
  return { ...base, zh: `${f.date}（暫訂）${SCHEDULE}。${f.blurb}` };
}

export const Route = createFileRoute("/events/soul-dinner_/films/$film")({
  // 子頁跟著那一場活動：活動不是「上架」就 404（讀取失敗照常渲染）；片名不在清單裡也 404。
  loader: async ({ params }) => {
    const film = filmBySlug(params.film);
    if (!film) throw notFound();
    const visibility = await fetchEventVisibility(EVENT_SLUG);
    if (!visibility.visible && !visibility.unavailable) throw notFound();
    return { film };
  },
  head: ({ matches, match, loaderData }) => {
    const film = loaderData?.film ?? null;
    return withLinks(
      pageHead(
        { matches, match },
        {
          translation: "zh-only",
          title: filmTitle(film, PAGE.metaTitle),
          description: fitDescription(filmDescription(film, PAGE.metaDescription)),
          image: imageFor(HERO_KEY, ""),
          type: "article",
          jsonLd: film
            ? landingSubpageLd(
                { name: "小時光｜靈魂飯桌", path: EVENT_PATH },
                { name: fullTitle(film), path: `${EVENT_PATH}/films/${film.slug}` },
                langFromMatches(matches),
              )
            : undefined,
        },
      ),
      [
        { rel: "stylesheet", href: FONTS_HREF },
        { rel: "stylesheet", href: soulCss },
      ],
    );
  },
  component: FilmPage,
});

function FilmPage() {
  const { film } = Route.useLoaderData();
  useDocumentMeta({
    title: filmTitle(film, PAGE.metaTitle),
    description: fitDescription(filmDescription(film, PAGE.metaDescription)),
    ogTitle: filmTitle(film, PAGE.metaTitle),
    ogDescription: fitDescription(filmDescription(film, PAGE.metaDescription)),
    // ⚠️ 一定要帶：沒給 ogImage 時 useDocumentMeta 會移除 head() 放好的 og:image。
    ogImage: imageFor(HERO_KEY, ""),
  });

  return (
    <div className="sd-root">
      <SoulHeader bookingClosed={false} />
      <main className="mx-auto max-w-3xl px-5 pt-10">
        <Link
          to={EVENT_PATH}
          hash="films"
          className="text-xs text-muted-foreground hover:text-primary"
        >
          ← 回到五場片單
        </Link>
        <p className="mt-6 text-xs tracking-[0.3em] text-clay">第 {film.n} 場</p>
        <h1 className="mt-2 text-3xl text-primary sm:text-4xl">
          {film.title}
          {film.episode ? <span className="text-clay">｜{film.episode}</span> : null}
        </h1>
        <dl className="paper-card mt-6 grid grid-cols-[5rem_1fr] gap-y-2 p-5 text-sm">
          <dt className="text-muted-foreground">日期</dt>
          <dd>
            {film.date}
            <span className="ml-2 text-xs text-clay">暫訂</span>
          </dd>
          <dt className="text-muted-foreground">時間</dt>
          <dd>{SCHEDULE}（晚餐時間與觀影流程待公布）</dd>
          <dt className="text-muted-foreground">地點</dt>
          <dd>待確認</dd>
          <dt className="text-muted-foreground">主講</dt>
          <dd>{HOSTS_LINE}</dd>
          <dt className="text-muted-foreground">內容</dt>
          <dd>簡單輕食晚餐・電影賞析・交流</dd>
        </dl>
        <p className="mt-6 leading-8">{film.blurb}</p>
        <div className="mt-6">
          {film.bookable ? (
            <Link
              to={EVENT_PATH}
              hash="reserve"
              className={`${BUTTON_CLAY} h-10 rounded-md px-8 text-sm`}
            >
              預約一張飯票
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">片名確認後開放報名。</p>
          )}
        </div>
      </main>
      <SoulFooter />
    </div>
  );
}
