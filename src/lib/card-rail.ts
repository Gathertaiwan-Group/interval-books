/**
 * 手機（< md）兩筆以上時，卡片排成可橫滑的一列：每張 82% 寬，露出下一張一截，scroll-snap。
 * 只加 max-md: 前綴的 class，md 以上完全交回 featureLayout（桌機不變）。一筆時不需要滑，照原本的直排。
 *
 * 與首頁「近期活動與策旅」（src/routes/index.tsx 的 railFor）同一組 class；/events 從
 * 2026-11-10 起也用（業主：「活動卡片用左右滑動」）。抽成獨立模組、零 runtime import，
 * scripts/events-merge-selftest.mjs 直接 import 驗證。
 */
export function cardRail(count: number): { track: string; item: string } {
  if (count < 2) return { track: "", item: "" };
  return {
    track:
      "max-md:-mx-6 max-md:flex max-md:snap-x max-md:snap-mandatory max-md:gap-4 max-md:overflow-x-auto max-md:scroll-px-6 max-md:px-6 max-md:pb-2 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden",
    item: "max-md:w-[82%] max-md:shrink-0 max-md:snap-start",
  };
}

/** 「共 N 則，左右滑動看更多 →」的文案（{n} = 這一列幾張）。 */
export const RAIL_HINT = {
  zh: "共 {n} 則，左右滑動看更多",
  en: "{n} in total — swipe for more",
  ja: "全{n}件・横にスワイプ",
};

/**
 * 手機「與桌機」都橫滑的一列（/partnership「我們做過的合作類型」，2026-11-11 業主：卡片加圖、
 * 改左右滑動）。與 cardRail() 不同：md 以上也不交回格線。
 *   手機 82% 寬（同 cardRail，露出下一張）／md 約 2.2 張（44%）／lg 約 2.7 張（36%）。
 * 手機 -mx-6 + px-6 讓列貼齊螢幕邊、第一張仍與標題對齊；md 以上 container-editorial 左右是
 * 3rem，所以改 -mx-12 + px-12。一張時不需要滑，回傳空字串，由呼叫端照一般版面排。
 * 提示與箭頭由 src/components/SwipeRail.tsx 依實際是否超出寬度決定要不要畫。
 */
export function swipeRail(count: number): { track: string; item: string } {
  if (count < 2) return { track: "", item: "" };
  return {
    track:
      "-mx-6 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-6 px-6 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:-mx-12 md:gap-6 md:scroll-px-12 md:px-12",
    item: "w-[82%] shrink-0 snap-start md:w-[44%] lg:w-[36%]",
  };
}

/** SwipeRail 的提示與箭頭文案。 */
export const SWIPE_HINT = {
  zh: "左右滑動看更多",
  en: "Swipe for more",
  ja: "横にスワイプして続きを見る",
};
export const SWIPE_PREV = { zh: "上一張", en: "Previous", ja: "前へ" };
export const SWIPE_NEXT = { zh: "下一張", en: "Next", ja: "次へ" };
