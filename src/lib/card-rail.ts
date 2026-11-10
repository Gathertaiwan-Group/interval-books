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
