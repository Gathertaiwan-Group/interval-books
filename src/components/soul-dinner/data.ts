/**
 * 《小時光｜靈魂飯桌》著陸頁與五個電影子頁共用的內容。文字照業主的 Lovable 稿
 * （soul-movie.lovable.app）。報名資料（場次、名額、票價）不在這裡，走站上的商品
 * event-soul-dinner（見 src/routes/events.soul-dinner.tsx 檔頭）。
 */

export const EVENT_SLUG = "soul-dinner";
export const EVENT_PATH = "/events/soul-dinner";
export const BRAND = "小時光｜靈魂飯桌";
export const TAGLINE = "給靈魂一張飯票，也給相遇一個位置。";
export const SCHEDULE = "週二 19:30–21:30";
export const HOSTS_LINE = "光中心 周介偉老師、Alice老師";

/** 原站載入的字重（Noto Sans TC 400/500、Noto Serif TC 500/600）。 */
export const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500&family=Noto+Serif+TC:wght@500;600&display=swap";

/** 主視覺（水墨水彩的窗邊餐桌），也是活動封面與分享預覽圖。 */
export const HERO_KEY = "storage:3aa5220d-d501-4388-a377-4623814dde03.webp";

export type Film = {
  slug: string;
  n: number;
  title: string;
  /** 片名後面那一段（「｜第一集」），沒有就是 null。 */
  episode: string | null;
  date: string;
  blurb: string;
  /** 這一場目前能不能報名（第五場要等片名公布）。 */
  bookable: boolean;
};

export const FILMS: readonly Film[] = [
  {
    slug: "light-walker-1",
    n: 1,
    title: "光之行者",
    episode: "第一集",
    date: "2026/11/24（二）",
    blurb: "從一段旅程的起點出發，看見自己一路走來的光。",
    bookable: true,
  },
  {
    slug: "light-walker-2",
    n: 2,
    title: "光之行者",
    episode: "第二集",
    date: "2026/12/1（二）",
    blurb: "延續第一集的足跡，聊聊那些讓我們繼續前行的力量。",
    bookable: true,
  },
  {
    slug: "miracle-of-life",
    n: 3,
    title: "創造生命的奇蹟",
    episode: null,
    date: "2026/12/8（二）",
    blurb: "在日常裡練習覺察，重新感受生命本身的可能。",
    bookable: true,
  },
  {
    slug: "soulmate",
    n: 4,
    title: "靈魂伴侶",
    episode: null,
    date: "2026/12/15（二）",
    blurb: "談關係、談相遇，也談先成為自己的那份溫柔。",
    bookable: true,
  },
  {
    slug: "film-5",
    n: 5,
    title: "片名待公布",
    episode: null,
    date: "2026/12/22（二）",
    blurb: "最後一張飯桌，片單將於確認後公布。",
    bookable: false,
  },
];

export function filmBySlug(slug: string): Film | null {
  return FILMS.find((f) => f.slug === slug) ?? null;
}

/** 子頁的網址（sitemap、中文限定清單用）。 */
export const FILM_PATHS: readonly string[] = FILMS.map((f) => `${EVENT_PATH}/films/${f.slug}`);

/** 原站 shadcn Button 的共用 class。 */
export const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";
export const BUTTON_CLAY = `${BUTTON_BASE} sd-btn-clay shadow tracking-widest`;
