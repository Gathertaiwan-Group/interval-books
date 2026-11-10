/**
 * /events「活動與策旅」合併頁上的策旅卡片（2026-11-10，原本在 /journeys）。
 *
 * 版面沿用 /journeys 的卡片（封面、天數／主題、標題、摘要、「前往策旅 →」），再補上首頁
 * 「近期活動與策旅」策旅卡已經有的日期區間、票價與名額小標 —— 合併之後訪客在同一頁比較
 * 活動與策旅，日期與價格是最先要看的兩件事。
 *
 * 有連結就整張卡可點（站內 /events/<slug> 同分頁、外部網站開新分頁，見 journeyLinkProps）；
 * 還沒設連結的策旅仍然看得到卡片，只是不可點 —— 不要讓它消失。
 */
import { CoverImage } from "@/components/CoverImage";
import { journeyKicker } from "@/lib/journey-events";
import { ListingBadge, ListingDate, ListingFooter } from "@/components/ListingBits";
import { useLocalizeHref, useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { CARD, CARD_HOVER, featureLayout } from "@/lib/feature-layout";
import type { ListingFacts } from "@/lib/home-listing";
import { imageFor } from "@/lib/images";
import { journeyLinkProps } from "@/lib/journey-link";
import { useSiteContent } from "@/lib/site-content";
import journeyImg from "@/assets/journey-mist.jpg";

export type JourneyCardData = {
  id: string;
  title: Localized;
  days: Localized;
  theme: Localized;
  summary: Localized;
  externalUrl: string;
};

export function JourneyCard({
  journey: j,
  linked,
  facts,
  layout,
  pastBadge,
  className = "",
}: {
  journey: JourneyCardData;
  /** 卡片指著的那場活動（日期、封面）。指不到 → null。 */
  linked: { date: string; imageKey: string | null } | null;
  facts: ListingFacts | undefined;
  layout: ReturnType<typeof featureLayout>;
  /** 已結束時印的小標文字；進行中為 null。 */
  pastBadge: string | null;
  /** 外層再加的 class（/events 手機橫滑列的寬度與 snap，見 src/lib/card-rail.ts）。 */
  className?: string;
}) {
  const t = useT();
  const localizeHref = useLocalizeHref();
  const { ui } = useSiteContent();
  const link = journeyLinkProps(j.externalUrl, localizeHref);
  const body = (
    <>
      {/* journeys 表沒有 image_key；封面用卡片指著的那場活動的 events.image_key，
          指不到或沒設圖才用固定意象圖。alt 用策旅名稱（2026-11 SEO 健檢 M6）。 */}
      <CoverImage
        src={imageFor(linked?.imageKey, journeyImg)}
        alt={t(j.title)}
        loading="lazy"
        className={`aspect-[4/3] ${layout.image}`}
        imgClassName="transition-transform duration-500 group-hover:scale-[1.03]"
      />
      <div className={`flex flex-1 flex-col p-6 ${layout.body}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="eyebrow text-sm tracking-widest">{journeyKicker(t(j.days), t(j.theme))}</p>
          {pastBadge ? (
            <span className="border border-border px-2 py-0.5 text-xs tracking-widest text-muted-foreground">
              {pastBadge}
            </span>
          ) : (
            <ListingBadge facts={facts} />
          )}
        </div>
        <h2 className={`display mt-3 text-2xl leading-snug whitespace-pre-line ${layout.title}`}>
          {t(j.title)}
        </h2>
        {linked?.date ? <ListingDate>{linked.date}</ListingDate> : null}
        <p className={`mt-4 text-sm leading-relaxed text-foreground/75 flex-1 ${layout.summary}`}>
          {t(j.summary)}
        </p>
        <ListingFooter
          facts={pastBadge ? undefined : facts}
          cta={link ? t(ui.buttons.toJourney) : null}
        />
      </div>
    </>
  );
  return link ? (
    <a
      {...link}
      className={`${CARD} ${layout.card} ${CARD_HOVER} ${className}`}
      data-testid="events-journey-card"
    >
      {body}
    </a>
  ) : (
    <article className={`${CARD} ${layout.card} ${className}`} data-testid="events-journey-card">
      {body}
    </article>
  );
}
