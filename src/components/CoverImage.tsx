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
 * ⚠️ /shop 的商品卡（ProductsPanel）不用這個：商品照是實拍照片，裁切反而比較整齊。
 *    例外：首頁的 HomeProductShelf 用它——那一排多半是地方刊物，書封上有字，必須完整。
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
};

export function CoverImage({
  src,
  alt,
  className,
  imgClassName,
  loading,
  width,
  height,
}: CoverImageProps) {
  return (
    <div className={cn("relative overflow-hidden bg-muted", className)}>
      {/* 模糊底：純裝飾（alt=""、aria-hidden），只負責把 contain 留下的空白補滿。
          scale-110 是為了讓 blur 的邊緣羽化跑到框外，不會在框邊看到一圈淡色。 */}
      <img
        src={src}
        alt=""
        aria-hidden="true"
        loading={loading}
        className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl"
      />
      <img
        src={src}
        alt={alt}
        loading={loading}
        width={width}
        height={height}
        className={cn("relative h-full w-full object-contain", imgClassName)}
      />
    </div>
  );
}
