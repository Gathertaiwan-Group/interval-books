/**
 * 「過往活動」（/events）與「過往策旅」（/journeys）共用的卡片區。
 *
 * 版型照首頁 HomeProductShelf：手機橫向滑（一張佔 76%，看得到下一張的邊 ≈ 1.3 張），
 * sm 起兩張半，md 起改格線（md 兩欄／lg 三欄／xl 四欄）。-mx-6 px-6 對齊
 * .container-editorial 在手機的 1.5rem 內距，滑動時卡片可以貼到螢幕邊；md 起內距變
 * 3rem 時格線已經不需要負邊距，所以 md:mx-0 md:px-0。
 *
 * 封面一律 CoverImage（整張圖完整顯示＋模糊底，不裁切），loading="lazy"。
 * 沒有封面圖就不放圖 —— 與 /events 列表同一條規則（見 EventEntry.imageKey）。
 *
 * 呼叫端負責：資料（已結束、排好序、限好筆數）、文案（p.block 讓後台可以改字）、
 * 以及零筆時不要畫這一區。
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CoverImage } from "@/components/CoverImage";
import { CARD, CARD_HOVER } from "@/lib/feature-layout";

export type PastShelfLink =
  | { kind: "event"; slug: string }
  | { kind: "href"; href: string; target?: "_blank"; rel?: "noreferrer" };

export type PastShelfItem = {
  key: string;
  title: string;
  /** 卡片 eyebrow（活動分類／策旅天數與主題）。 */
  category: string;
  /** 顯示用日期 —— 原樣印出（display_date 是自由文字），不做任何日期格式化。 */
  date: string;
  image: string | null;
  link: PastShelfLink | null;
};

type PastShelfProps = {
  eyebrow: string;
  title: string;
  badge: string;
  items: PastShelfItem[];
  /** 標題列右側的「查看全部 →」。沒有可去的地方就不傳。 */
  cta?: ReactNode;
  testId?: string;
};

export function PastShelf({ eyebrow, title, badge, items, cta, testId }: PastShelfProps) {
  if (items.length === 0) return null;
  return (
    <section className="container-editorial pb-24" data-testid={testId}>
      <div className="border-t border-border pt-16 flex flex-col gap-6 md:flex-row md:items-end md:justify-between md:gap-12">
        <div>
          <p className="eyebrow text-2xl">{eyebrow}</p>
          <h2 className="display mt-4 text-3xl md:text-4xl">{title}</h2>
        </div>
        {cta ? <div className="shrink-0 self-start md:self-end">{cta}</div> : null}
      </div>
      <ul className="relative mt-12 -mx-6 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-6 px-6 pb-2 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-2 md:gap-6 md:overflow-visible md:px-0 md:pb-0 lg:grid-cols-3 xl:grid-cols-4 [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <li key={item.key} className="flex w-[76%] shrink-0 snap-start sm:w-[42%] md:w-auto">
            <PastCard item={item} badge={badge} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PastCard({ item, badge }: { item: PastShelfItem; badge: string }) {
  const body = (
    <>
      {item.image ? (
        <CoverImage
          src={item.image}
          alt=""
          loading="lazy"
          className="aspect-[4/3]"
          imgClassName="transition-transform duration-500 group-hover:scale-[1.03]"
        />
      ) : null}
      <div className="flex flex-1 flex-col p-5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="eyebrow text-xs tracking-widest">{item.category}</p>
          <span className="border border-border px-2 py-0.5 text-[11px] tracking-widest text-muted-foreground">
            {badge}
          </span>
        </div>
        <h3 className="mt-3 line-clamp-2 min-h-[2.75em] font-serif text-lg leading-snug group-hover:underline underline-offset-4">
          {item.title}
        </h3>
        <p className="mt-auto pt-3 text-sm text-muted-foreground">{item.date}</p>
      </div>
    </>
  );
  const className = `${CARD} w-full`;
  const link = item.link;
  if (!link) return <article className={className}>{body}</article>;
  if (link.kind === "event") {
    return (
      <Link
        to="/events/$slug"
        params={{ slug: link.slug }}
        className={`${className} ${CARD_HOVER}`}
      >
        {body}
      </Link>
    );
  }
  return (
    <a
      href={link.href}
      target={link.target}
      rel={link.rel}
      className={`${className} ${CARD_HOVER}`}
    >
      {body}
    </a>
  );
}
