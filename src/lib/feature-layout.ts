/**
 * 前台卡片版面的共用規則——首頁、活動、策旅、消息、選物等列表都用這一套，各頁才不會各長一套。
 *
 * 卡片本身：CARD（外框）＋ CARD_HOVER（可點的卡片才加）。
 * 排列：featureLayout(筆數)
 *   0 筆 → 整區（含標題）不顯示，由呼叫端判斷
 *   1 筆 → 橫版：左圖右字、佔滿版面寬，文字垂直置中（手機一樣是上圖下字，窄螢幕並排擠不下）
 *   2 筆 → 兩欄卡片
 *   3 筆以上 → 三欄卡片
 * card／image／body／title／summary 是單筆時才加的 class，多筆時都是空字串。
 *
 * 🔴 不要再用 `grid gap-px bg-border` 那種 1px 細線磚牆：只有一筆時，容器的底色會露出一大塊灰色。
 */
export const CARD = "group flex flex-col border border-border bg-background/40 transition-colors";
export const CARD_HOVER = "hover:border-foreground/40";

export function featureLayout(count: number) {
  if (count === 1) {
    return {
      grid: "grid",
      card: "md:flex-row",
      image: "md:w-1/2 md:shrink-0",
      body: "md:justify-center md:px-12 md:py-10",
      title: "md:text-3xl",
      // 卡片版靠摘要 flex-1 把按鈕推到底；橫版要整段文字置中，所以拿掉
      summary: "md:flex-none",
    };
  }
  return {
    grid: count === 2 ? "grid gap-8 md:grid-cols-2" : "grid gap-8 md:grid-cols-2 lg:grid-cols-3",
    card: "",
    image: "",
    body: "",
    title: "",
    summary: "",
  };
}
