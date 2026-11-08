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
  /** 電影子頁的「影片簡介」，照業主提供的片單表（2026-11-09）。 */
  intro: readonly IntroBlock[];
  /** 這一場目前能不能報名（後台還沒有這一場的場次時為 false）。 */
  bookable: boolean;
};

/** 影片簡介的一段：lead 是醒目的引言，strong 是粗體副標，p 是內文，li 是條列。 */
export type IntroBlock = { kind: "lead" | "strong" | "p" | "li"; text: string };

const LIGHT_WALKER_INTRO: readonly IntroBlock[] = [
  { kind: "lead", text: "一場靈界和人間光行者們的互動救援行動" },
  { kind: "strong", text: "巴西靈性經典續作 · 探索轉世與守護的奧秘" },
  {
    kind: "p",
    text: "當乘願而來的靈魂在人間的慾望與迷霧中迷失，來自靈界聖城的「光使者團隊」悄然降臨。",
  },
  {
    kind: "p",
    text: "在不可侵犯的自由意志法則下，他們將如何喚醒迷失的人們去憶起和執行當初立下的藍圖誓約？！",
  },
];

export const FILMS: readonly Film[] = [
  {
    slug: "light-walker-1",
    n: 1,
    title: "光之行者",
    episode: "第一集",
    date: "2026/11/24（二）",
    blurb: "從一段旅程的起點出發，看見自己一路走來的光。",
    intro: LIGHT_WALKER_INTRO,
    bookable: true,
  },
  {
    slug: "light-walker-2",
    n: 2,
    title: "光之行者",
    episode: "第二集",
    date: "2026/12/1（二）",
    blurb: "延續第一集的足跡，聊聊那些讓我們繼續前行的力量。",
    intro: LIGHT_WALKER_INTRO,
    bookable: true,
  },
  {
    slug: "miracle-of-life",
    n: 3,
    title: "創造生命的奇蹟",
    episode: null,
    date: "2026/12/8（二）",
    blurb: "在日常裡練習覺察，重新感受生命本身的可能。",
    intro: [
      { kind: "lead", text: "被譽為重要性甚於\u201c祕密\u201d的心靈療癒片，" },
      {
        kind: "p",
        text: "由美國知名心靈導師路易絲．賀所攝製的紀錄影片；<我願意改變> 一句簡潔有力的話，一個人心中所思考的，往往決定他的悲歡人生，甚至身體上的病痛，也和人的心理模式息息相關。所以，只要願意對自己的心靈做工，一切的疾病及煩惱都會因此消滅。",
      },
    ],
    bookable: true,
  },
  {
    slug: "soulmate",
    n: 4,
    title: "靈魂伴侶",
    episode: null,
    date: "2026/12/15（二）",
    blurb: "談關係、談相遇，也談先成為自己的那份溫柔。",
    intro: [
      { kind: "li", text: "你/妳可曾遇見或渴望一位靈魂伴侶？天作之合？或曾遇見到許多靈魂伴侶？" },
      {
        kind: "li",
        text: "由五段情感伴侶的故事組成; 探討伴侶之間的尋覓.勇氣.緣分&珍惜等主題.故事精簡而溫馨",
      },
      { kind: "p", text: "你準備好迎接靈魂伴侶了嗎?!...歡迎跟我們來探討感情伴侶之間的話題..." },
    ],
    bookable: true,
  },
  {
    slug: "celestine-prophecy",
    n: 5,
    title: "聖境預言書",
    episode: null,
    date: "2026/12/22（二）",
    blurb: "1990 年代美國最暢銷的靈性小說搬上銀幕，跟著主角領受九個覺悟。",
    intro: [
      { kind: "lead", text: "*1990 年代美國最暢銷靈性小說搬上銀幕!!" },
      {
        kind: "p",
        text: "~如果你正閱讀這個訊息，表示你已經察覺到人類意識的轉變~意識在你心中已經發酵!",
      },
      { kind: "li", text: "人生的機緣巧合、節骨眼冒出的人，會出其不意地把我們推到一個重要方向" },
      { kind: "li", text: "隨著主角的冒險歷程，領受九個覺悟; 每個階段都蘊藏一個天機「覺悟」" },
    ],
    bookable: false,
  },
];

/** 第五場片名公布前的舊網址（/films/film-5），子頁會轉到新的網址。 */
export const RENAMED_FILM_SLUGS: Readonly<Record<string, string>> = {
  "film-5": "celestine-prophecy",
};

export function filmBySlug(slug: string): Film | null {
  return FILMS.find((f) => f.slug === slug) ?? null;
}

/** 子頁的網址（sitemap、中文限定清單用）。 */
export const FILM_PATHS: readonly string[] = FILMS.map((f) => `${EVENT_PATH}/films/${f.slug}`);

/** 原站 shadcn Button 的共用 class。 */
export const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";
export const BUTTON_CLAY = `${BUTTON_BASE} sd-btn-clay shadow tracking-widest`;
