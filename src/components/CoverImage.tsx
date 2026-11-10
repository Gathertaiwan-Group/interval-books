/**
 * 活動／策旅的封面圖：整張圖一定完整顯示，不裁切。
 *
 * 為什麼不用 object-cover：店長上傳的封面常常是「海報」——直式或正方形、上面有字。
 * object-cover 塞進 4:3 的框會把上下的標題字切掉，而且每個頁面的框比例不同，同一張
 * 海報在列表、首頁、活動頁被切成三種樣子。所以真正的圖一律 object-contain（完整顯示），
 * 框裡多出來的空白（直式海報的左右兩側）用同一張圖放大＋模糊當底色補滿，一般橫式照片
 * 幾乎看不出差別，海報也不會兩側露出一大塊灰。
 *
 * 外框比例（aspect-[4/3] 等）與寬度由呼叫端用 className 決定；imgClassName 給前景圖用
 * （例如卡片 hover 的 group-hover:scale-[1.03]）。
 *
 * /shop 的商品卡（ProductsPanel）與首頁的 HomeProductShelf 也用它：上架的幾乎都是地方
 *    刊物，書封上有字、比例不一（2026-11 起，原本 ProductsPanel 用 object-cover，手機 3:4
 *    框把橫式封面裁到只剩三成）。
 */
import type { ImgHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type CoverImageProps = {
  src: string;
  alt: string;
  className?: string;
  imgClassName?: string;
  loading?: ImgHTMLAttributes<HTMLImageElement>["loading"];
  width?: number;
  height?: number;
  /**
   * 首屏的那一張（例：/events 第一張卡片）：前景圖 eager＋fetchPriority="high"（React 19 會在
   * <head> 自動輸出 preload），模糊底同樣 eager＋high——兩層是同一個網址、同一次下載，模糊底不會
   * 晚於前景圖才畫出來，也不會讓那一次下載以低優先序開始。
   * 預設 false：其他頁、其他卡片行為完全不變（照 loading 參數，通常是 lazy）。
   * 一頁最多給一張，給多了等於沒有優先順序。
   */
  priority?: boolean;
};

export function CoverImage({
  src,
  alt,
  className,
  imgClassName,
  loading,
  width,
  height,
  priority = false,
}: CoverImageProps) {
  const load = priority ? "eager" : loading;
  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {/* 模糊底：純裝飾（alt=""、aria-hidden），只負責把 contain 留下的空白補滿。
          scale-110 是為了讓 blur 的邊緣羽化跑到框外，不會在框邊看到一圈淡色。 */}
      <img
        src={src}
        alt=""
        aria-hidden="true"
        loading={load}
        // 模糊底在 DOM 裡排在前面、而且比前景大（scale-110），瀏覽器先發現的、Lighthouse 判定為
        // LCP 的都是它。同一個網址只下載一次，所以兩層給一樣的優先序，不然那一次下載會以模糊底的
        // 低優先序開始（2026-11-10 量到：priority 只給前景時，請求仍是 Low）。
        fetchPriority={priority ? "high" : undefined}
        decoding="async"
        className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl"
      />
      <img
        src={src}
        alt={alt}
        loading={load}
        fetchPriority={priority ? "high" : undefined}
        width={width}
        height={height}
        className={cn("relative h-full w-full object-contain", imgClassName)}
      />
    </div>
  );
}
