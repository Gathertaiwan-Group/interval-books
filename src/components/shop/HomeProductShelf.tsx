/**
 * 首頁「主理人的選品」那一排商品卡（2026-10 店主要求：把原本那張花瓶大圖換成
 * 直接可以買的商品）。選哪幾件不在這裡決定——見 src/lib/home-shelf.ts（先放後台選品
 * 連結的商品，不滿再用商品排序補）。
 *
 * 版型參考（2026-10 實測）：Aesop／Monocle 首頁商品列桌機一排 4 張、Kinfolk 3 張；
 * 手機上誠品線上、Aesop 都是橫向滑動的一排、露出下一張的一角提示「還有」。所以：
 *   - 桌機（md 以上）4 欄格狀，不做輪播——4 件一眼看完，不需要左右箭頭；
 *   - 手機一排橫向滑動＋scroll-snap，一張約佔 76% 寬（看得到 1.3 張），左右邊界
 *     跟著頁面的 gutter 對齊（-mx-6 px-6），滑到底不會貼邊；
 *   - 卡片：封面 3:4（地方刊物封面多為直式）、類別小標、書名兩行截斷、價格（有
 *     原價就劃線），底部一顆常駐的「加入購物車」——不做 hover 才出現，觸控裝置
 *     沒有 hover，而且鍵盤使用者要按得到。
 *
 * 🔴 封面一律用 CoverImage（完整顯示＋模糊底補邊），不用 object-cover：書封上有
 *    刊名與字，裁掉就看不出是哪一本。這是店主對全站封面的規則。
 *
 * 🔴 加入購物車只呼叫既有的 useCart().addItem(cartInputFor(product, 1))——跟
 *    /shop/$slug、地方刊物分頁同一行，數量上限、售完判斷都在 cartInputFor()/
 *    store 裡，這裡不另外算。只會傳書籍／選物進來（見 fetchHomeShelfProducts），
 *    所以不會出現「沒選場次就加進購物車」的活動。
 *
 * ⚠️ <ul> 上的 `relative` 不能拿掉：按鈕裡的 sr-only 書名是 position:absolute，沒有
 *    定位祖先時它的包含區塊在橫向捲動容器**外面**，不會被 overflow 裁掉——手機上整頁
 *    會被撐到 1020px 寬、出現橫向捲軸（2026-10 實測）。
 *
 * SSR：這個元件不讀購物車狀態（只寫），伺服器與用戶端第一次渲染輸出完全相同，
 * 不會有 hydration mismatch（#418）。
 */
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { CoverImage } from "@/components/CoverImage";
import { PRODUCT_TYPE_LABELS } from "@/components/shop/labels";
import { PriceTag } from "@/components/shop/ShopBits";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { cartInputFor, useCart } from "@/lib/cart";
import { CARD, CARD_HOVER } from "@/lib/feature-layout";
import { imageFor } from "@/lib/images";
import type { ShopProductCard } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";
import curatedImg from "@/assets/curated-objects.jpg";

const COPY = {
  addedToast: { zh: "已加入購物車", en: "Added to cart", ja: "カートに入れました" },
  cappedToast: {
    zh: "已達可購買數量上限",
    en: "That is all we have available",
    ja: "ご購入いただける上限に達しました",
  },
  soldOutToast: {
    zh: "這件商品目前售完",
    en: "This item is sold out",
    ja: "この商品は完売しています",
  },
  listLabel: { zh: "主理人的選品", en: "Curated picks", ja: "店主の選品" },
} satisfies Record<string, Localized>;

export function HomeProductShelf({ products }: { products: ShopProductCard[] }) {
  const t = useT();
  const { ui } = useSiteContent();
  const addItem = useCart((s) => s.addItem);

  const add = (product: ShopProductCard) => {
    const result = addItem(cartInputFor(product, 1));
    if (result === "added") toast.success(t(COPY.addedToast));
    else if (result === "capped") toast.warning(t(COPY.cappedToast));
    else toast.error(t(COPY.soldOutToast));
  };

  return (
    <ul
      aria-label={t(COPY.listLabel)}
      data-testid="home-product-shelf"
      className="relative -mx-6 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-6 px-6 pb-2 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-4 md:gap-6 md:overflow-visible md:px-0 md:pb-0 [&::-webkit-scrollbar]:hidden"
    >
      {products.map((product) => {
        const title = t(product.title);
        return (
          <li key={product.id} className="flex w-[76%] shrink-0 snap-start sm:w-[42%] md:w-auto">
            <article className={`${CARD} ${CARD_HOVER} w-full`}>
              <Link
                to="/shop/$slug"
                params={{ slug: product.slug }}
                className="flex flex-1 flex-col"
              >
                <CoverImage
                  src={imageFor(product.imageKey, curatedImg)}
                  alt={title}
                  loading="lazy"
                  className="aspect-[3/4]"
                  imgClassName="transition-transform duration-500 group-hover:scale-[1.03]"
                />
                <div className="flex flex-1 flex-col px-4 pt-4 md:px-5 md:pt-5">
                  <p className="eyebrow text-xs tracking-widest">
                    {t(PRODUCT_TYPE_LABELS[product.productType])}
                  </p>
                  <h3 className="mt-2 line-clamp-2 min-h-[2.75em] font-serif text-lg leading-snug group-hover:underline underline-offset-4">
                    {title}
                  </h3>
                  <PriceTag
                    className="mt-auto pt-3"
                    price={product.price}
                    compareAtPrice={product.compareAtPrice}
                  />
                </div>
              </Link>
              <div className="px-4 pb-4 pt-3 md:px-5 md:pb-5">
                <button
                  type="button"
                  onClick={() => add(product)}
                  className="w-full min-h-11 border border-foreground/70 px-3 py-2.5 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {t(ui.buttons.addToCart)}
                  <span className="sr-only">（{title}）</span>
                </button>
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
